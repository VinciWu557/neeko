import { invoke } from '@tauri-apps/api/core';

import type { WorkspaceSession } from '@/shared/utils/workspaceRef';

/**
 * 文件字节通道的**唯一前端入口**（`read_file_bytes` / `read_file_size`）。
 *
 * 为什么单独成模块而不是挂在 `features/file/api`：字节通道是跨域的基础能力
 * （markdown 图片、图片预览、PDF 预览都用它），`shared/` 消费它不该反向依赖
 * `features/file` —— 依赖方向只能 features → shared。
 *
 * # 短读是契约，不是错误
 *
 * 后端单次 IPC 载荷有界（红线 4），表达方式是「**至多返回**这么多字节」：请求一整段
 * 大区间会拿到一个较短的块。因此：
 * - 需要完整区间时用 [`readFileRange`] / [`readFileBytesAll`]（它们按返回长度推进 offset）；
 * - 不要在调用侧复制后端的上界常量做「够不够/要不要报错」判断 —— 那会让两端的常量
 *   变成隐式契约：抄大了 pdf.js 拿不到完整块而永久挂起，抄小了直接误报失败。
 */

/** 地址解析选项：`base` 是 `filePath` 的相对基准目录（缺省 = Workspace 根）。 */
export interface FileAddressOptions {
  base?: string | null;
}

/** 单个区间的读取选项。 */
export interface ReadBytesOptions extends FileAddressOptions {
  /** 起始偏移（字节）；缺省从文件头。 */
  offset?: number | null;
  /** 期望长度；缺省读到文件尾。实际可能更短（单次载荷上界）。 */
  length?: number | null;
}

/** 整读的大小上限：超过这个量的「一次性资产」不是预览该干的事（也避免把 webview 打爆）。 */
export const MAX_ASSET_BYTES = 64 * 1024 * 1024;

function addressArgs(filePath: string, base?: string | null) {
  return { filePath, base: base ?? null };
}

/**
 * 读取一段字节（**单次**调用，返回值可能短于请求）。
 *
 * 绝大多数消费点应该用 [`readFileRange`] / [`readFileBytesAll`]；只有「明确知道
 * 自己只要一块」的调用（例如探测头部）才直接用本函数。
 */
export async function readFileBytes(
  workspace: WorkspaceSession,
  filePath: string,
  options: ReadBytesOptions = {},
): Promise<ArrayBuffer> {
  // invoke<ArrayBuffer>：Tauri 对 `Response::new(Vec<u8>)` 返回原始字节，零 JSON 序列化
  return invoke<ArrayBuffer>('read_file_bytes', {
    workspace,
    ...addressArgs(filePath, options.base),
    offset: options.offset ?? null,
    length: options.length ?? null,
  });
}

/** 文件字节数（仅 stat，不读内容）。 */
export function readFileSize(
  workspace: WorkspaceSession,
  filePath: string,
  options: FileAddressOptions = {},
): Promise<number> {
  return invoke<number>('read_file_size', {
    workspace,
    ...addressArgs(filePath, options.base),
  });
}

/** 按返回长度推进 offset，把 `[begin, end)` 读满。 */
async function fillRange(
  workspace: WorkspaceSession,
  filePath: string,
  base: string | null | undefined,
  begin: number,
  end: number,
): Promise<Uint8Array> {
  if (!(end > begin)) return new Uint8Array(0);

  const out = new Uint8Array(end - begin);
  let cursor = begin;
  while (cursor < end) {
    const chunk = new Uint8Array(
      await readFileBytes(workspace, filePath, { base, offset: cursor, length: end - cursor }),
    );
    if (chunk.byteLength === 0) {
      // 文件在读取过程中被截断（并发编辑）：给出明确错误，而不是静默返回半截数据
      throw new Error(`Unexpected end of file at byte ${cursor}`);
    }
    out.set(chunk, cursor - begin);
    cursor += chunk.byteLength;
  }
  return out;
}

/**
 * 读取精确区间 `[begin, end)`，自动跨分片续读。
 *
 * pdf.js 的 `PDFDataRangeTransport` 要求「给的就正好是要的那段」：短一截会让它把这
 * 一段判成未满足而永久等待（既不会重试也不会报错）。因此补齐循环放在通道里，
 * 而不是散在每个消费点。
 */
export function readFileRange(
  workspace: WorkspaceSession,
  filePath: string,
  range: FileAddressOptions & { begin: number; end: number },
): Promise<Uint8Array> {
  return fillRange(workspace, filePath, range.base, range.begin, range.end);
}

/**
 * 整读一个文件（图片等小资产）：先探大小做上界防护，再分片拉满。
 *
 * 不复用 `read_file_content`：那条通道会把二进制判成 NUL 并返回空串，且文本上限与
 * 「多少个字节」是两件事。
 */
export async function readFileBytesAll(
  workspace: WorkspaceSession,
  filePath: string,
  options: FileAddressOptions & { maxBytes?: number } = {},
): Promise<ArrayBuffer> {
  const maxBytes = options.maxBytes ?? MAX_ASSET_BYTES;
  const size = await readFileSize(workspace, filePath, { base: options.base });
  if (size > maxBytes) {
    throw new Error(`File is ${size} bytes, above the ${maxBytes} byte preview limit`);
  }
  const bytes = await fillRange(workspace, filePath, options.base, 0, size);
  // Uint8Array 的 buffer 可能是共享大缓冲区（切片）—— 这里恒为独立分配，语义安全。
  return bytes.buffer as ArrayBuffer;
}
