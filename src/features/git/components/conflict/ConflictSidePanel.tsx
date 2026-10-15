import React from 'react';

import type { ConflictSide } from '@/shared/types';

interface ConflictSidePanelProps {
  /** 侧标题（Base / Ours / Theirs）。 */
  label: string;
  /** 缺失该 stage 时的说明文案（「我方已删除」等）——**绝不渲染成空文件**。 */
  missingHint: string;
  side: ConflictSide | null;
}

/**
 * 冲突单侧只读面板。缺失 stage（`side === null`）渲染语义说明，而非空文件
 * （R3：`content: null` 是「该 stage 不存在」，与 `content: ''`（确实是空文件）不同）。
 */
const ConflictSidePanel: React.FC<ConflictSidePanelProps> = ({ label, missingHint, side }) => {
  let body: React.ReactNode;
  if (side === null) {
    body = <span className="italic text-text-muted">{missingHint}</span>;
  } else if (side.is_binary) {
    body = <span className="italic text-text-muted">（二进制内容，不展示）</span>;
  } else if (side.content === null) {
    body = <span className="italic text-text-muted">（内容不可用）</span>;
  } else {
    body = <pre className="whitespace-pre-wrap break-words font-mono">{side.content}</pre>;
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-border/50">
      <div className="shrink-0 border-b border-border/40 bg-bg-tertiary/40 px-2 py-1 text-[calc(var(--font-size)-2px)] font-semibold text-text-muted">
        {label}
        {side?.path !== undefined && side.path !== null ? (
          <span className="ml-2 font-normal opacity-70">{side.path}</span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 py-1 text-[calc(var(--font-size)-1px)] text-text-primary">
        {body}
      </div>
    </div>
  );
};

export default React.memo(ConflictSidePanel);
