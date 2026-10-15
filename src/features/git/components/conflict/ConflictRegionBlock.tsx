import React from 'react';

import type { MergeRegion } from '@/shared/types';

interface ConflictRegionBlockProps {
  region: MergeRegion;
  /** 是否展示 base 候选（both_added 无共同祖先时不展示）。 */
  showBase: boolean;
}

function Lines({ lines }: { lines: string[] }) {
  if (lines.length === 0) {
    return <span className="italic text-text-muted">（无内容）</span>;
  }
  return <pre className="whitespace-pre-wrap break-words font-mono">{lines.join('\n')}</pre>;
}

/**
 * 单个冲突区域：三侧候选行（只读）。
 *
 * **不扫描任何 marker 文本** —— 候选行直接来自后端结构化 `MergeRegion`（护栏 A4 要求
 * 前端只渲染结构化区块，不解析工作区字节）。
 */
const ConflictRegionBlock: React.FC<ConflictRegionBlockProps> = ({ region, showBase }) => (
  <div className="rounded border border-border/50">
    <div className="border-b border-border/40 bg-bg-tertiary/40 px-2 py-1 text-[calc(var(--font-size)-2px)] font-semibold text-accent-yellow">
      Region {region.id + 1}
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
