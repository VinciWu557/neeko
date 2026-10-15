import React from 'react';

import type { MergeRegion, RegionTake } from '@/shared/types';

interface ConflictRegionBlockProps {
  region: MergeRegion;
  /** 是否展示 base 候选（both_added 无共同祖先时不展示）。 */
  showBase: boolean;
  /** 当前草稿选择（null = 未决议）。 */
  selected?: RegionTake | null;
  /** 区域决议回调（点击 Accept Ours/Theirs/Both）。 */
  onTake?: (take: RegionTake) => void;
}

function Lines({ lines }: { lines: string[] }) {
  if (lines.length === 0) {
    return <span className="italic text-text-muted">（无内容）</span>;
  }
  return <pre className="whitespace-pre-wrap break-words font-mono">{lines.join('\n')}</pre>;
}

/**
 * 单个冲突区域：三侧候选行 + 区域决议按钮（Ours / Theirs / Both）。
 *
 * **不扫描任何 marker 文本** —— 候选行直接来自后端结构化 `MergeRegion`（护栏 A4 要求
 * 前端只渲染结构化区块，不解析工作区字节）。
 */
const ConflictRegionBlock: React.FC<ConflictRegionBlockProps> = ({
  region,
  showBase,
  selected = null,
  onTake,
}) => (
  <div className="rounded border border-border/50">
    <div className="flex items-center gap-2 border-b border-border/40 bg-bg-tertiary/40 px-2 py-1 text-[calc(var(--font-size)-2px)] font-semibold text-accent-yellow">
      <span>Region {region.id + 1}</span>
      {onTake ? (
        <span className="ml-auto flex items-center gap-1">
          {(['ours', 'theirs', 'both'] as const).map((take) => (
            <button
              key={take}
              type="button"
              aria-pressed={selected === take}
              className={`rounded border px-1.5 py-0.5 text-[calc(var(--font-size)-3px)] ${
                selected === take
                  ? 'border-accent-yellow bg-accent-yellow/15 text-accent-yellow'
                  : 'border-border/50 text-text-muted hover:bg-bg-hover hover:text-text-primary'
              }`}
              onClick={() => onTake(take)}
            >
              {take === 'ours'
                ? 'Accept Ours'
                : take === 'theirs'
                  ? 'Accept Theirs'
                  : 'Accept Both'}
            </button>
          ))}
        </span>
      ) : null}
    </div>
    <div className="flex flex-col gap-1 p-1.5">
      <div className="min-w-0">
        <span className="text-[calc(var(--font-size)-2px)] font-semibold text-text-muted">
          Ours
        </span>
        <Lines lines={region.our_lines} />
      </div>
      {showBase ? (
        <div className="min-w-0">
          <span className="text-[calc(var(--font-size)-2px)] font-semibold text-text-muted">
            Base
          </span>
          <Lines lines={region.base_lines} />
        </div>
      ) : null}
      <div className="min-w-0">
        <span className="text-[calc(var(--font-size)-2px)] font-semibold text-text-muted">
          Theirs
        </span>
        <Lines lines={region.their_lines} />
      </div>
    </div>
  </div>
);

export default React.memo(ConflictRegionBlock);
