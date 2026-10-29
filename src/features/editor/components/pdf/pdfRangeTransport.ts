/**
 * pdf.js `PDFDataRangeTransport` 的**通道适配层**。
 *
 * 第一性约束：PDF 的交叉引用表（xref）在文件尾部，打开文件本质上是随机访问。
 * pdf.js 为此提供 `PDFDataRangeTransport`：宿主实现 `requestDataRange(begin, end)`，
 * pdf.js 只拉 xref 与可见页所需的对象块（配合 `disableAutoFetch`）。
 *
 * 本模块把「pdf.js 要一段字节」翻译成 `read_file_bytes(offset, length)`，
 * 并把结果按**请求自身的** `begin` 回填 —— 不按到达顺序配对：pdf.js 会并发
 * 发多个 range 请求，响应可能乱序返回，用「先进先出」配对必然串数据。
 */

/** 一次 range 请求的取字节函数（`[begin, end)` 半开区间）。 */
export type RangeFetcher = (begin: number, end: number) => Promise<Uint8Array>;

/** 结构化的 `PDFDataRangeTransport` 形状（只为可测性，避免测试依赖 pdf.js 实例）。 */
export interface DataRangeTransportLike {
  requestDataRange(begin: number, end: number): void;
  onDataRange(begin: number, chunk: Uint8Array | null): void;
}

export interface BindOptions {
  /** 单个 response 的回填回调（pdf.js 侧是 `onDataRange`）。 */
  onError?: (error: unknown, begin: number) => void;
}

/**
 * 把 `fetchRange` 绑到 transport 的 `requestDataRange` 上。
 *
 * 返回 `abort()`：调用后所有在飞的响应都被丢弃，不再回填 —— 组件卸载 / 换文件时
 * 必须调用，否则晚到的字节会写进已经销毁的文档。
 */
export function bindRangeTransport(
  transport: DataRangeTransportLike,
  fetchRange: RangeFetcher,
  options: BindOptions = {},
): () => void {
  let aborted = false;

  transport.requestDataRange = (begin: number, end: number) => {
    if (aborted) return;
    fetchRange(begin, end)
      .then((chunk) => {
        if (aborted) return;
        transport.onDataRange(begin, chunk);
      })
      .catch((error: unknown) => {
        if (aborted) return;
        // 通知 pdf.js「这段没拿到」：回填 null 会让它按需要重试/报错，而不是永久挂起。
        transport.onDataRange(begin, null);
        options.onError?.(error, begin);
      });
  };

  return () => {
    aborted = true;
  };
}

/**
 * range 请求的规范化：夹取到 `[0, size]`。
 *
 * pdf.js 可能请求超出文件尾的范围（最后一次探测）；越界请求必须报错而不是
 * 静默裁短 —— 裁短会让 pdf.js 把损坏文件当成截断文件，错误信息更难懂。
 */
export function normalizeRange(
  begin: number,
  end: number,
  size: number,
): { begin: number; length: number } | null {
  if (!Number.isFinite(begin) || !Number.isFinite(end)) return null;
  const start = Math.max(0, Math.floor(begin));
  const stop = Math.min(size, Math.floor(end));
  if (start >= size) return null;
  if (stop <= start) return null;
  return { begin: start, length: stop - start };
}
