import React from 'react';

interface WorktreeRenameInputProps {
  /** 输入框 ref（由 `useWorktreeRowState` 持有，进入编辑态即聚焦全选）。 */
  inputRef: React.RefObject<HTMLInputElement>;
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

/**
 * worktree 行的**行内重命名输入框** —— 本地侧栏与 WSL/SSH 侧栏共用。
 *
 * 与共享的 `DeleteConfirmDialog` 同理：这段 JSX（含 Enter/Escape/blur 三个键路与
 * 「点击不要冒泡成选中行」）曾在两个列表各写一份。行为细节多、易漂移 —— 例如漏掉
 * `stopPropagation` 会让点输入框触发该行「打开终端」，而两份里只改一处时另一域照旧。
 */
const WorktreeRenameInput: React.FC<WorktreeRenameInputProps> = ({
  inputRef,
  value,
  onChange,
  onCommit,
  onCancel,
}) => (
  <input
    ref={inputRef}
    className="w-full bg-bg-tertiary border border-accent-blue rounded text-text-primary text-[var(--font-size)] font-semibold px-1 py-0.5 outline-none box-border"
    value={value}
    onChange={(e) => onChange(e.target.value)}
    onBlur={onCommit}
    onKeyDown={(e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onCommit();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    }}
    onClick={(e) => e.stopPropagation()}
  />
);

export default React.memo(WorktreeRenameInput);
