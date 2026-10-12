import React from 'react';

import ConfirmDialog from './ConfirmDialog';

interface DeleteConfirmDialogProps<T extends { id: string }> {
  /** 待确认条目（null = 不渲染）。 */
  pending: T | null;
  onCancel: () => void;
  onConfirm: () => void;
  title: string;
  /** 正文（拿到条目，可含名称等；条目已解析，无需再做 find/兜底）。 */
  describe: (item: T) => React.ReactNode;
}

/**
 * 删除确认弹框（prompts / MCP servers / tag groups 三处删除流共用）：
 * 把 `ConfirmDialog` 的 open / onOpenChange / confirmLabel / danger 记账固定下来，
 * 消费方只注入文案。配合 `useDeleteConfirm` 使用。
 */
function DeleteConfirmDialog<T extends { id: string }>({
  pending,
  onCancel,
  onConfirm,
  title,
  describe,
}: DeleteConfirmDialogProps<T>) {
  if (!pending) return null;
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={title}
      description={describe(pending)}
      confirmLabel="Delete"
      danger
      onConfirm={onConfirm}
    />
  );
}

export default DeleteConfirmDialog;
