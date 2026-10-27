import React from 'react';

interface AheadChipProps {
  ahead: number;
}

const AheadChip: React.FC<AheadChipProps> = ({ ahead }) => {
  if (ahead <= 0) return null;
  return (
    <span
      className="text-[0.92em] font-mono font-semibold text-diff-added-text"
      title={`${ahead} commit(s) ahead of upstream`}
    >
      ↑{ahead}
    </span>
  );
};

interface KbdChipProps {
  children: React.ReactNode;
}

const KbdChip: React.FC<KbdChipProps> = ({ children }) => (
  <span className="text-[0.85em] font-mono text-text-muted px-1 py-0.5 tracking-tight">
    {children}
  </span>
);

// 曾经还有一个 `Changes`（+A / -D 行级统计）chip。它在 G4 把 numstat 移出 status 热路径后
// 恒不渲染：`FileChange.additions/deletions` 由 `parsers/status.rs` 硬编码为 0，全仓无写入点，
// 而 chip 的门是 `add <= 0 && del <= 0 → null`。行级统计的正确出口是按需的
// `getChangedFilesDiffStats`（Git 面板内使用），不进侧栏快照。

export const SessionChips = {
  Ahead: React.memo(AheadChip),
  Kbd: React.memo(KbdChip),
};

export default SessionChips;
