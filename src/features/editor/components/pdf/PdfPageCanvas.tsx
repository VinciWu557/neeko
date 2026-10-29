import { useEffect, useRef, useState } from 'react';

import type { PdfDocument } from './usePdfDocument';

interface PdfPageCanvasProps {
  doc: PdfDocument;
  pageNumber: number;
  /** 目标渲染宽度（CSS px）；高度按页面自身宽高比推导。 */
  width: number;
}

/**
 * 单页 canvas 渲染。
 *
 * - 参数变化 / 卸载时**取消**在飞的渲染任务（`cancel()`）—— 连续滚动快速划过时
 *   不取消会让已离屏的页继续占 CPU 解码；
 * - `devicePixelRatio` 感知：否则高分屏上文字发虚；
 * - 页面底色由 canvas 自身填充为白（PDF 是「纸」，不随应用主题变化）。
 */
export function PdfPageCanvas({ doc, pageNumber, width }: PdfPageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let task: { cancel(): void } | null = null;

    doc
      .getPage(pageNumber)
      .then((pdfPage) => {
        if (cancelled) return;
        const base = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({ scale: width / base.width });
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;

        const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        ctx.scale(dpr, dpr);
        // 纸张底色：PDF 的内容流按白底绘制，透明底会透出应用主题色。
        ctx.save();
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, viewport.width, viewport.height);
        ctx.restore();

        const view = pdfPage.render({ canvasContext: ctx, viewport });
        task = view;
        return view.promise;
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // pdf.js 的 RenderingCancelledException 是正常取消，不是失败。
        if (e instanceof Error && e.name === 'RenderingCancelledException') return;
        setFailed(true);
      });

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber, width]);

  if (failed) {
    return (
      <div className="text-xs text-accent-red px-2 py-1">Page {pageNumber} failed to render</div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      className="shadow-md bg-bg-primary"
      data-page={pageNumber}
      data-testid="pdf-page-canvas"
    />
  );
}
