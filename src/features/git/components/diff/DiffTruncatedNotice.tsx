import React from 'react';

interface DiffTruncatedNoticeProps {
  /** 后端 `DiffResult.truncated`；`false` / `undefined` 时不渲染。 */
  truncated?: boolean;
}

/**
 * 红线 4 封顶的用户可见面：`truncated = true` 时 diff 内容被按 IPC 预算截断，必须显式告知，
 * 禁止静默展示不完整结果 —— **包括「截断到 0 行」的极端情形**（单行内容即超预算）。
 *
 * 单一实现，`SingleDiffBody`（单文件）与 `FileDiffSection`（多文件）共用；显隐只由
 * `truncated` 决定，与 hunk 数正交，调用方**无条件**放置即可，避免「只在有 hunk 时才提示」的遗漏。
 */
const DiffTruncatedNotice: React.FC<DiffTruncatedNoticeProps> = ({ truncated }) =>
  truncated ? (
    <div
      role="status"
      className="border-b border-border/35 bg-bg-secondary px-3 py-1.5 text-[calc(var(--font-size)-2px)] text-accent-yellow"
    >
      Diff truncated: result exceeds the size limit.
    </div>
  ) : null;

export default React.memo(DiffTruncatedNotice);
