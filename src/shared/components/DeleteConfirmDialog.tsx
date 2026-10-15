import React from 'react';

import ConfirmDialog from './ConfirmDialog';

interface DeleteConfirmDialogProps<T> {
  /** 待确认条目（null = 不渲染）。 */
  pending: T | null;
  onCancel: () => void;
  /**
   * 确认删除。**收到当前条目** —— 组件已持有 `pending`，再让调用方从自己的渲染闭包
   * 重取一次并做 null 守卫，就是同一事实的第二份读取（会逐处重复 `if (s) …`）。
   */
  onConfirm: (item: T) => void;
  /** 标题。随条目形态变化时传函数（如 `Delete Folder` / `Delete File`）。 */
  title: string | ((item: T) => string);
  /** 正文（拿到条目，可含名称等；条目已解析，无需再做 find/兜底）。 */
  describe: (item: T) => React.ReactNode;
  /**
   * 确认按钮文案。默认 `Delete`。
   * - 随**条目**变化 → `(item) => string`（worktree 的 `Force Remove` / `Remove`）
   * - 随**外部进行态**变化 → 无参闭包（skill 的 `removing ? 'Removing…' : 'Remove'`）
   */
  confirmLabel?: string | ((item: T) => string);
}

/**
 * 通用「对**待定条目**做破坏性操作」的确认弹框 —— **全仓唯一的该族记账层**。
 *
 * 把 `ConfirmDialog` 的 `open` / `onOpenChange`→cancel / `danger` 记账固定下来，消费方
 * 只注入文案与动作。当前消费面：
 *
 * - 删除类：file 树、tag group、prompt / MCP server（配 [`useDeleteConfirm`] 状态机）
 * - 移除类：project（local + connection 两处，曾逐字重复 20 行）、worktree 行、
 *   skill（project / agent 两侧的单条 + 批量）
 *
 * **为什么不新增专用组件**：本组件诞生前，同形代码至少有四份 —— 本泛型版、
 * `ConfirmRemoveWorktreeDialog`、`features/file/components/DeleteConfirmDialog`（直接用
 * `@/ui/Dialog` 原语 + 手写按钮），以及 project / skill 域里**手写**的 `ConfirmDialog`
 * 记账（`open` / `onOpenChange` / `danger` 三行套话逐处重复）。结构逐字相同，差异只在
 * `title` / `confirmLabel` / 正文。「差异是数据」的场合就不该长出第二个组件：把差异做成
 * prop，消费方各自注入即可。**新增确认场景 = 传 props，不是新建 `XxxConfirmDialog`。**
 *
 * **不属于本族（保留各自实现）**：确认对象不是「某个条目」而是 UI 状态或未来动作的场合 ——
 * `AppModals` 的 Exit Neeko、`BulkCloseConfirmDialog`（丢弃未保存变更）、以及
 * `ConfirmHost` 的命令式 store 驱动通道（`await confirmAction()`，供非 React 模块使用）。
 * 它们的 `pending` 不是条目，硬套会把「条目」这一契约稀释成 `unknown`。
 *
 * `T` **无结构约束**（此处从不读条目的字段，只把它交给 `describe` / `title` /
 * `confirmLabel`，并在确认时回传）—— 曾要求 `T extends { id: string }`，但 worktree 的
 * 条目是 `{ path, branch, isDirty }` 无 `id`，那个约束纯属多余且会逼出第二个组件。
 */
function DeleteConfirmDialog<T>({
  pending,
  onCancel,
  onConfirm,
  title,
  describe,
  confirmLabel = 'Delete',
}: DeleteConfirmDialogProps<T>) {
  if (!pending) return null;
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={typeof title === 'function' ? title(pending) : title}
      description={describe(pending)}
      confirmLabel={typeof confirmLabel === 'function' ? confirmLabel(pending) : confirmLabel}
      danger
      // ConfirmDialog 的 onConfirm 是无参回调，条目由本组件的 `pending` 闭包注入
      onConfirm={() => onConfirm(pending)}
    />
  );
}

export default DeleteConfirmDialog;
