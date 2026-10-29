import { useEffect, useState } from 'react';

import { readFileRange, readFileSize } from '@/shared/api/fileBytes';
import { activeWorkspaceSession } from '@/shared/store/workspaceStore';
import type { ProjectId } from '@/shared/utils/workspaceRef';

import { bindRangeTransport, normalizeRange } from './pdfRangeTransport';

/**
 * pdf.js 单次 range 请求的**粒度偏好**（不是正确性参数）。
 *
 * 块读不满由 `readFileRange` 续读补齐，因此这里与后端 `DEFAULT_MAX_CHUNK` 不一样也不影响
 * 正确性 —— 两端不再是「抄同一个数字」的隐式契约。
 */
export const RANGE_CHUNK_SIZE = 1024 * 1024;

/**
 * pdf.js 运行时资源（CMap / 标准字体 / wasm）的挂载点。
 *
 * 缺了它们：中文等 CJK 字体未嵌入的 PDF 会缺字（`cMapUrl`）、用标准 14 字体的 PDF 报
 * `standardFontDataUrl` 取不到、含 JPEG2000 图像的 PDF 无法解码（`wasmUrl`）。
 * 资源由 `vite.config.ts` 的 `pdfjsAssets()` 从 node_modules 直出（不复制进仓库），
 * **两处路径必须一致**。
 */
const PDFJS_ASSET_BASE = '/pdfjs';

/** pdf.js 里本 hook 实际用到的成员（结构性类型：测试可注入替身，不拉真 pdf.js）。 */
export interface PdfModule {
  getDocument: (src: unknown) => { promise: Promise<PdfDocument> };
  PDFDataRangeTransport: new (length: number, initialData: Uint8Array | null) => PdfRangeTransport;
  GlobalWorkerOptions: { workerSrc: string };
}

export interface PdfRangeTransport {
  requestDataRange(begin: number, end: number): void;
  onDataRange(begin: number, chunk: Uint8Array | null): void;
}

export interface PdfPageViewport {
  width: number;
  height: number;
}

export interface PdfPage {
  getViewport(params: { scale: number }): PdfPageViewport;
  render(params: { canvasContext: CanvasRenderingContext2D; viewport: PdfPageViewport }): {
    promise: Promise<void>;
    cancel(): void;
  };
}

export interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}

export interface PdfLoadResult {
  doc: PdfDocument | null;
  numPages: number;
  /** 首屏页的宽高比（连续滚动用来估算占位高度；只在加载后回填一次）。 */
  pageAspect: number;
  loading: boolean;
  error: string | null;
}

interface LoadState {
  key: string | null;
  doc: PdfDocument | null;
  numPages: number;
  aspect: number;
  error: string | null;
}

const FALLBACK_ASPECT = 792 / 612;

/**
 * 打开 PDF：**range 通道**按需取字节，不整读文件。
 *
 * 为什么必须 range：PDF 的交叉引用表在文件尾部，打开文件本质上是随机访问。
 * pdf.js 的 `PDFDataRangeTransport` 只向宿主索取 xref 与可见页所需的对象块
 * （配合 `disableAutoFetch`），因此 500MB 的 PDF 也能浏览，而单次 IPC 载荷
 * 始终有界（红线 4 的「载荷有界」= 单次载荷有上界，不是文件总量上限）。
 *
 * 用 **legacy 构建**：现代构建不带 polyfill，会直接调用 `Map.prototype.getOrInsertComputed`
 * 这类很新的内建方法；WKWebView / WebKitGTK 跟系统走，版本不到位就是运行期
 * `TypeError`（打开任何 PDF 都报“getOrInsertComputed is not a function”）。
 * legacy 内部带 core-js 实现，代价只是包大一点。
 */
export function usePdfDocument(pid: ProjectId | null | undefined, filePath: string): PdfLoadResult {
  // key 与当前 (project, filePath) 对齐：不一致即「过期结果」，不展示。
  // loading / error 都由它**派生**，不在 effect 里同步 setState（那会级联渲染）。
  const loadKey = `${pid ?? ''}\u0000${filePath}`;
  const [loaded, setLoaded] = useState<LoadState>({
    key: null,
    doc: null,
    numPages: 0,
    aspect: FALLBACK_ASPECT,
    error: null,
  });

  useEffect(() => {
    if (!pid) return;
    const workspace = activeWorkspaceSession(pid);
    let disposed = false;
    let abortTransport: (() => void) | null = null;
    let openedDoc: PdfDocument | null = null;

    const load = async () => {
      const [pdfjs, worker] = await Promise.all([
        import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<PdfModule>,
        import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url') as unknown as Promise<{
          default: string;
        }>,
      ]);
      if (disposed) return;
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

      const size = await readFileSize(workspace, filePath);
      if (disposed) return;
      if (size <= 0) throw new Error('Empty PDF file');

      const transport = new pdfjs.PDFDataRangeTransport(size, null);
      abortTransport = bindRangeTransport(transport, async (begin, end) => {
        const range = normalizeRange(begin, end, size);
        if (!range) throw new Error(`Invalid PDF range: ${begin}-${end}`);
        // 必须把请求区间读满：短一截会让 pdf.js 把这段判成未满足而永久等待
        // （既不再请求也不报错）—— 由通道内部的续读循环保证。
        return readFileRange(workspace, filePath, {
          begin: range.begin,
          end: range.begin + range.length,
        });
      });

      const task = pdfjs.getDocument({
        range: transport,
        rangeChunkSize: RANGE_CHUNK_SIZE,
        // 不预取整个文件 —— 大文件必须只拉可见页所需块。
        disableAutoFetch: true,
        disableStream: true,
        // 字体 / 字符集 / 图像解码所需的运行时资源（CJK 文本、未嵌入字体、JPX 图像）
        cMapUrl: `${PDFJS_ASSET_BASE}/cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${PDFJS_ASSET_BASE}/standard_fonts/`,
        wasmUrl: `${PDFJS_ASSET_BASE}/wasm/`,
      });
      openedDoc = await task.promise;
      if (disposed) {
        void openedDoc.destroy();
        return;
      }

      // 用首页真实宽高比修正占位高度（只取 1 页，不遍历整本）。
      const first = await openedDoc.getPage(1);
      const viewport = first.getViewport({ scale: 1 });
      const aspect = viewport.width > 0 ? viewport.height / viewport.width : FALLBACK_ASPECT;
      if (disposed) return;

      setLoaded({
        key: loadKey,
        doc: openedDoc,
        numPages: openedDoc.numPages,
        aspect,
        error: null,
      });
    };

    load().catch((e: unknown) => {
      if (disposed) return;
      setLoaded({
        key: loadKey,
        doc: null,
        numPages: 0,
        aspect: FALLBACK_ASPECT,
        error: e instanceof Error ? e.message : String(e),
      });
    });

    return () => {
      disposed = true;
      abortTransport?.();
      if (openedDoc) void openedDoc.destroy();
    };
  }, [pid, filePath, loadKey]);

  const isCurrent = loaded.key === loadKey;
  const doc = isCurrent ? loaded.doc : null;
  const error = isCurrent ? loaded.error : null;
  return {
    doc,
    numPages: isCurrent ? loaded.numPages : 0,
    pageAspect: isCurrent ? loaded.aspect : FALLBACK_ASPECT,
    loading: !error && !doc,
    error,
  };
}
