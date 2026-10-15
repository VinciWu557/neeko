import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import DeleteConfirmDialog from '@/shared/components/DeleteConfirmDialog';

/** 无 `id` 的条目（worktree 行的形态）—— 验证泛化后不再要求 `{ id }`。 */
interface RowTarget {
  path: string;
  branch: string;
  isDirty: boolean;
}

const CLEAN: RowTarget = { path: '/repo/.worktrees/dev', branch: 'dev', isDirty: false };
const DIRTY: RowTarget = { ...CLEAN, isDirty: true };

function renderDialog(
  target: RowTarget | null,
  confirmLabel?: string | ((t: RowTarget) => string),
  title: string | ((t: RowTarget) => string) = 'Remove Worktree',
) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(
    <DeleteConfirmDialog
      pending={target}
      onCancel={onCancel}
      onConfirm={onConfirm}
      title={title}
      confirmLabel={confirmLabel}
      describe={(t) => <p>{t.path}</p>}
    />,
  );
  return { onCancel, onConfirm };
}

/**
 * `DeleteConfirmDialog` 是**全仓唯一的删除确认记账层**（prompts / MCP / tag groups /
 * worktree 行 四类消费）。本文件直测它的可配置面 —— 这些是「不新增专用组件」的前提。
 */
describe('DeleteConfirmDialog（通用删除确认记账层）', () => {
  it('pending 为 null 不渲染任何内容', () => {
    const { container } = render(
      <DeleteConfirmDialog
        pending={null}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        title="X"
        describe={() => null}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('条目**不要求有 id**（泛化放宽后的契约，worktree 行为 { path, branch, isDirty }）', () => {
    render(
      <DeleteConfirmDialog
        pending={CLEAN}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        title="Remove Worktree"
        describe={(t) => <p>{t.path}</p>}
      />,
    );
    expect(screen.getByText('Remove Worktree')).toBeInTheDocument();
    expect(screen.getByText(CLEAN.path)).toBeInTheDocument();
  });

  it('confirmLabel 省略时默认 "Delete"', () => {
    renderDialog(CLEAN);
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('confirmLabel 传字符串时原样使用', () => {
    renderDialog(CLEAN, 'Remove');
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('confirmLabel 传函数时按**当前条目**求值（worktree 的 Force Remove / Remove）', () => {
    renderDialog(DIRTY, (t) => (t.isDirty ? 'Force Remove' : 'Remove'));
    expect(screen.getByRole('button', { name: 'Force Remove' })).toBeInTheDocument();
  });

  it('title 传函数时按**当前条目**求值（file 域的 Delete File / Delete Folder）', () => {
    renderDialog(CLEAN, undefined, (t) => (t.isDirty ? 'Delete Folder' : 'Delete File'));
    expect(screen.getByText('Delete File')).toBeInTheDocument();
  });

  it('onConfirm **收到当前条目**（调用方无需再从自己的闭包重取 + 判空）', () => {
    const { onConfirm } = renderDialog(CLEAN);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledWith(CLEAN);
  });

  it('`pending` 可为**集合**（skill 批量移除：T = 条目数组）', () => {
    const skills = [CLEAN, DIRTY];
    const onConfirm = vi.fn();
    render(
      <DeleteConfirmDialog
        pending={skills}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
        title={(s) => `Remove ${s.length} skills?`}
        confirmLabel={(s) => `Remove ${s.length}`}
        describe={(s) => <p>{s.map((x) => x.branch).join(',')}</p>}
      />,
    );
    expect(screen.getByText('Remove 2 skills?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove 2' }));
    expect(onConfirm).toHaveBeenCalledWith(skills);
  });

  it('确认触发 onConfirm；取消（遮罩/Esc 路径）触发 onCancel 而不触发 onConfirm', () => {
    const { onConfirm, onCancel } = renderDialog(CLEAN);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    // ConfirmDialog 的取消按钮 → onOpenChange(false) → onCancel
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
