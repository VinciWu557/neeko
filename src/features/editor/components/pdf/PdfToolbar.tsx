import { useState } from 'react';

import { cn } from '@/lib/utils';

export type PdfViewMode = 'continuous' | 'single';

interface PdfToolbarProps {
  page: number;
  numPages: number;
  scale: number;
  mode: PdfViewMode;
  onGotoPage: (page: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitWidth: () => void;
  onModeChange: (mode: PdfViewMode) => void;
}

const BUTTON =
  'px-2 py-0.5 rounded hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-accent-blue';

/** PDF 工具栏：页码导航 + 缩放 + 浏览模式切换（纯展示，状态由 `PdfFileView` 持有）。 */
export function PdfToolbar({
  page,
  numPages,
  scale,
  mode,
  onGotoPage,
  onZoomIn,
  onZoomOut,
  onFitWidth,
  onModeChange,
}: PdfToolbarProps) {
  // 页码输入用本地草稿态：直接受控于 `page` 会让输入框无法清空（'' → NaN 被忽略，
  // `value` 立刻回填旧值，用户删不掉那一位数字）。blur / Enter 时交回受控显示。
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/50 text-xs text-text-secondary">
      <button
        type="button"
        className={BUTTON}
        onClick={() => onGotoPage(page - 1)}
        aria-label="Previous page"
      >
        ‹
      </button>
      <span className="tabular-nums">
        <input
          aria-label="Page number"
          className="w-10 bg-transparent text-center border border-border/50 rounded"
          value={draft ?? String(page)}
          onChange={(e) => {
            const raw = e.target.value;
            setDraft(raw);
            const next = Number.parseInt(raw, 10);
            if (Number.isFinite(next)) onGotoPage(next);
          }}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setDraft(null);
              e.currentTarget.blur();
            }
          }}
        />
        {' / '}
        {numPages}
      </span>
      <button
        type="button"
        className={BUTTON}
        onClick={() => onGotoPage(page + 1)}
        aria-label="Next page"
      >
        ›
      </button>

      <span className="mx-1 w-px h-3.5 bg-border/60" />

      <button type="button" className={BUTTON} onClick={onZoomOut} aria-label="Zoom out">
        −
      </button>
      <span className="tabular-nums w-10 text-center">{Math.round(scale * 100)}%</span>
      <button type="button" className={BUTTON} onClick={onZoomIn} aria-label="Zoom in">
        +
      </button>
      <button type="button" className={BUTTON} onClick={onFitWidth} aria-label="Fit width">
        Fit
      </button>

      <span className="mx-1 w-px h-3.5 bg-border/60" />

      <button
        type="button"
        className={cn(BUTTON, mode === 'continuous' && 'bg-bg-hover')}
        aria-pressed={mode === 'continuous'}
        onClick={() => onModeChange('continuous')}
      >
        Scroll
      </button>
      <button
        type="button"
        className={cn(BUTTON, mode === 'single' && 'bg-bg-hover')}
        aria-pressed={mode === 'single'}
        onClick={() => onModeChange('single')}
      >
        Single
      </button>
    </div>
  );
}
