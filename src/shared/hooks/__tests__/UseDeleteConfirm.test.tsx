import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import DeleteConfirmDialog from '@/shared/components/DeleteConfirmDialog';

import { useDeleteConfirm } from '../useDeleteConfirm';

interface Item {
  id: string;
  name: string;
  count?: number;
}

interface HarnessProps {
  items: Item[];
  remove?: (id: string) => Promise<void>;
  notify?: (message: string, type?: 'info' | 'error') => void;
  needsConfirm?: (item: Item) => boolean;
}

/** 用真实 useDeleteConfirm 贯通渲染共享弹框 —— 同时钉住 hook 与弹框的契约。 */
function Harness({
  items,
  remove = async () => {},
  notify = () => {},
  needsConfirm,
}: HarnessProps) {
  const del = useDeleteConfirm({ items, remove, notify, entityLabel: 'widget', needsConfirm });
  return (
    <>
      {items.map((item) => (
        <button key={item.id} type="button" onClick={() => del.request(item.id)}>
          Delete {item.name}
        </button>
      ))}
      <DeleteConfirmDialog
        pending={del.pending}
        onCancel={del.cancel}
        onConfirm={del.confirm}
        title="Delete widget?"
        describe={(item) => <p>{item.name} will be removed</p>}
      />
    </>
  );
}

describe('useDeleteConfirm（含 DeleteConfirmDialog）', () => {
  const ITEMS: Item[] = [{ id: 'a', name: 'Alpha' }];

  it('总是确认：请求弹框 → 取消不删；再次请求并确认 → 调用 remove', async () => {
    const remove = vi.fn(async () => {});
    render(<Harness items={ITEMS} remove={remove} />);

    fireEvent.click(screen.getByText('Delete Alpha'));
    expect(screen.getByText('Delete widget?')).toBeInTheDocument();
    expect(screen.getByText('Alpha will be removed')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(remove).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText('Delete widget?')).not.toBeInTheDocument());

    fireEvent.click(screen.getByText('Delete Alpha'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('a'));
  });

  it('确认门槛：needsConfirm 返回 false 的条目直接删除，不弹框', async () => {
    const remove = vi.fn(async () => {});
    render(
      <Harness
        items={[{ id: 'a', name: 'Alpha', count: 0 }]}
        remove={remove}
        needsConfirm={(item) => (item.count ?? 0) > 0}
      />,
    );

    fireEvent.click(screen.getByText('Delete Alpha'));

    await waitFor(() => expect(remove).toHaveBeenCalledWith('a'));
    expect(screen.queryByText('Delete widget?')).not.toBeInTheDocument();
  });

  it('删除失败 → 带前缀的错误通知（entityLabel 注入）', async () => {
    const remove = vi.fn(async () => {
      throw new Error('boom');
    });
    const notify = vi.fn();
    render(<Harness items={ITEMS} remove={remove} notify={notify} />);

    fireEvent.click(screen.getByText('Delete Alpha'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith('Failed to delete widget: Error: boom', 'error'),
    );
  });
});
