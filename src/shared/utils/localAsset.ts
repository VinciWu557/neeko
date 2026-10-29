// eslint-disable-next-line no-restricted-imports -- convertFileSrc 是本地路径转可渲染 URL 的唯一转换点，收敛在本模块
import { convertFileSrc } from '@tauri-apps/api/core';

/**
 * 「资产 src → 可渲染 URL / IPC 相对路径」的**唯一解析入口**。
 *
 * markdown 图片、图片文件预览、PDF 预览等所有渲染点都必须经本模块，禁止各自手写
 * 路径归一 —— 历史缺陷正是各渲染点各写一份正则导致的：
 *
 * - 旧实现 `/^(https?:|data:|blob:|asset:)/?\//i` 对 `data:image/png;base64,…` 不匹配
 *   （`data:` 后没有斜杠），在传入 basePath 的渲染点被误拼进 `convertFileSrc`；
 * - 各渲染点「传不传 basePath」靠自觉，三个渲染点漏传 ⇒ 相对路径全部 404。
 *
 * **本模块只做「src 是什么」的判定与 URL 派生，不负责把相对路径拼成绝对路径交给 IPC**：
 * 后端 `read_file_bytes(base, path)` 按目标环境语义拼接（Local 宿主语义 / WSL·SSH POSIX
 * 语义）。前端拍平成绝对路径会让远端寻址在 Windows 宿主上失效（`/home/u/x` 在 Windows
 * 上不是 absolute，`base` 不会被替换），属同一事实的第二表示。
 *
 * 判定顺序（顺序本身是契约，改动前先看本文件测试）：
 * 1. 空 src → 空串（调用方渲染 alt 兜底）；
 * 2. Windows 盘符路径（`C:/…`）→ 本地绝对路径。**必须先于协议判定** —— `C:` 形似 scheme；
 * 3. 协议相对 URL（`//cdn/…`）→ 原样返回（与 `<a>` 侧同一规则）；
 * 4. 通用 scheme（`/^[a-z][a-z0-9+.-]*:/`）→ 原样返回（http/https/data/blob/asset/…）；
 * 5. POSIX 绝对路径（`/…`）→ 本地绝对路径；
 * 6. 相对路径 + basePath → 拼 basePath 后转 asset URL；
 * 7. 相对路径无 basePath → 原样返回（无从解析，交给调用方兜底）。
 */
export function resolveAssetUrl(src: string, basePath?: string): string {
  const normalized = normalizeAssetPath(src);
  if (!normalized) return '';

  if (DRIVE_PATH_RE.test(normalized)) {
    return convertFileSrc(normalized);
  }
  if (PROTOCOL_RELATIVE_RE.test(normalized) || SCHEME_RE.test(normalized)) {
    return src.trim();
  }
  if (normalized.startsWith('/')) {
    return convertFileSrc(normalized);
  }
  if (!basePath) {
    return src.trim();
  }
  return convertFileSrc(joinAbsolute(normalizeAssetPath(basePath), normalized));
}

/**
 * 资产路径归一：反斜杠 → `/`，去掉前导 `./`。**URL 派生与 IPC 传参共用这一套归一**
 * （否则「能显示的路径」与「能读到的路径」会各自漂移）。
 */
export function normalizeAssetPath(src: string): string {
  const trimmed = src.trim().replace(/\\/g, '/');
  return trimmed.startsWith('./') ? trimmed.slice(2) : trimmed;
}

/** 相对路径拼到基准目录（**仅用于 URL 派生**，不用于 IPC 寻址）。 */
function joinAbsolute(base: string, rel: string): string {
  if (!base) return rel;
  if (rel.startsWith('/') || DRIVE_PATH_RE.test(rel)) return rel;
  return `${base.replace(/\/+$/, '')}/${rel}`;
}

/**
 * 该 src 是否需要「字节通道」才能显示（即本地文件、而非已有 URL）。
 *
 * 渲染点用它决定走 asset 协议直连还是经 IPC 取字节：`true` 时调用方改用
 * `readFileBytesAll` 之类的字节通道，而不是把 src 当 URL 用。
 */
export function isRemoteAssetSrc(src: string): boolean {
  const normalized = normalizeAssetPath(src);
  if (!normalized) return false;
  if (DRIVE_PATH_RE.test(normalized)) return true;
  if (PROTOCOL_RELATIVE_RE.test(normalized) || SCHEME_RE.test(normalized)) return false;
  return true;
}

/** `C:/…` 形态（只在反斜杠归一后使用）。刻意先于 scheme 判定，见上方契约。 */
const DRIVE_PATH_RE = /^[a-zA-Z]:\//;

/** 协议相对 URL（`//host/x.png`）：浏览器按当前协议解析，不是本地路径。 */
const PROTOCOL_RELATIVE_RE = /^\/\//;

/** 通用 URL scheme；要求 scheme 名至少 2 字符，避免与单字母盘符 `C:` 混淆。 */
const SCHEME_RE = /^[a-z][a-z0-9+.-]+:/i;

/**
 * markdown 渲染的 `basePath` 选择规则：显式传入（md 文件所在目录 / skill 目录）优先，
 * 否则回落项目根（chat 消息、PR 描述这类没有 md 文件语境的内容）。
 *
 * 抽成纯函数是为了让「谁优先」可单测 —— 历史缺陷之一就是各渲染点
 * 「传不传 basePath」靠自觉。hook 形态见 `shared/hooks/useAssetBasePath.ts`。
 */
export function resolveMarkdownBasePath(
  explicit: string | undefined,
  projectRoot: string | null | undefined,
): string | undefined {
  return explicit || projectRoot || undefined;
}
