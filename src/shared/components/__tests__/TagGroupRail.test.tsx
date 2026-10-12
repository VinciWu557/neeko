import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { TagGroupCrudItem } from '@/shared/hooks/useTagGroupCrud';
import { useTagGroupCrud } from '@/shared/hooks/useTagGroupCrud';

import TagGroupRail from '../nav/TagGroupRail';

interface HarnessProps {
  groups: TagGroupCrudItem[];
  create?: (name: string) => Promise<void>;
  rename?: (id: string, name: string) => Promise<void>;
  remove?: (id: string) => Promise<void>;
  notify?: (message: string, type?: 'info' | 'error') => void;
  onSelect?: (id: string) => void;
  onSync?: (id: string, name: string) => void;
  activeIds?: readonly string[];
}

/** 用真实 useTagGroupCrud 贯通渲染 TagGroupRail —— 同时钉住 hook 与组件的契约。 */
function Harness({
  groups,
  create = async () => {},
  rename = async () => {},
  remove = async () => {},
  notify = () => {},
  onSelect = () => {},
  onSync,
  activeIds = [],
}: HarnessProps) {
  const crud = useTagGroupCrud({ items: groups, create, rename, remove, notify });
  return (
    <TagGroupRail
      crud={crud}
      groups={groups}
      activeIds={activeIds}
      onSelect={onSelect}
      emptyText="Group things by role"
      confirmTitle="Delete tag group?"
      describeDelete={(g) => <p>{g.count} members bound</p>}
      onSync={onSync}
    />
  );
}

const FRONTEND: TagGroupCrudItem = { id: 'a', name: 'Frontend', count: 3 };

describe('TagGroupRail', () => {
  it('渲染分组/计数/New Tag 入口；行点击回调 onSelect；activeIds 命中进入选中态', () => {
    const onSelect = vi.fn();
    render(<Harness groups={[FRONTEND]} onSelect={onSelect} activeIds={['a']} />);

    expect(screen.getByText('Frontend')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('New Tag')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Frontend/ })).toHaveClass('bg-bg-selected');

    fireEvent.click(screen.getByText('Frontend'));
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('无分组且未创建 → 显示注入的空态文案', () => {
    render(<Harness groups={[]} />);
    expect(screen.getByText('Group things by role')).toBeInTheDocument();
  });

  it('创建：＋ → 输入 → Enter → create(trimmed) + 成功通知 + 输入收起', async () => {
    const create = vi.fn(async () => {});
    const notify = vi.fn();
    render(<Harness groups={[]} create={create} notify={notify} />);

    fireEvent.click(screen.getByTitle('New tag group'));
    const input = screen.getByPlaceholderText(/Backend/i);
    fireEvent.change(input, { target: { value: '  Backend  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(create).toHaveBeenCalledWith('Backend'));
    expect(notify).toHaveBeenCalledWith('Created tag group "Backend"');
    await waitFor(() => expect(screen.queryByPlaceholderText(/Backend/i)).not.toBeInTheDocument());
  });

  it('创建失败 → 带前缀的错误通知，输入保留可重试', async () => {
    const create = vi.fn(async () => {
      throw new Error('boom');
    });
    const notify = vi.fn();
    render(<Harness groups={[]} create={create} notify={notify} />);

    fireEvent.click(screen.getByTitle('New tag group'));
    const input = screen.getByPlaceholderText(/Backend/i);
    fireEvent.change(input, { target: { value: 'Backend' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith('Failed to create tag group: Error: boom', 'error'),
    );
    expect(screen.getByPlaceholderText(/Backend/i)).toBeInTheDocument();
  });

  it('智能确认：有成员 → 弹框（注入标题 + 正文）；确认后调用 remove', async () => {
    const remove = vi.fn(async () => {});
    render(<Harness groups={[FRONTEND]} remove={remove} />);

    fireEvent.click(screen.getByTitle('Delete tag'));
    expect(screen.getByText('Delete tag group?')).toBeInTheDocument();
    expect(screen.getByText('3 members bound')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('a'));
  });

  it('智能确认：空分组直接删除，不弹框', async () => {
    const remove = vi.fn(async () => {});
    render(<Harness groups={[{ id: 'a', name: 'Frontend', count: 0 }]} remove={remove} />);

    fireEvent.click(screen.getByTitle('Delete tag'));

    await waitFor(() => expect(remove).toHaveBeenCalledWith('a'));
    expect(screen.queryByText('Delete tag group?')).not.toBeInTheDocument();
  });

  it('重命名：改值提交 → rename + 成功通知', async () => {
    const rename = vi.fn(async () => {});
    const notify = vi.fn();
    render(
      <Harness
        groups={[{ id: 'a', name: 'Frontend', count: 0 }]}
        rename={rename}
        notify={notify}
      />,
    );

    fireEvent.click(screen.getByTitle('Rename tag'));
    fireEvent.change(screen.getByDisplayValue('Frontend'), { target: { value: 'Platform' } });
    fireEvent.keyDown(screen.getByDisplayValue('Platform'), { key: 'Enter' });

    await waitFor(() => expect(rename).toHaveBeenCalledWith('a', 'Platform'));
    expect(notify).toHaveBeenCalledWith('Renamed to "Platform"');
  });

  it('重命名未变化 → 短路：不调 rename，输入收起', async () => {
    const rename = vi.fn(async () => {});
    render(<Harness groups={[{ id: 'a', name: 'Frontend', count: 0 }]} rename={rename} />);

    fireEvent.click(screen.getByTitle('Rename tag'));
    fireEvent.keyDown(screen.getByDisplayValue('Frontend'), { key: 'Enter' });

    await waitFor(() => expect(screen.queryByDisplayValue('Frontend')).not.toBeInTheDocument());
    expect(rename).not.toHaveBeenCalled();
  });

  it('同步按钮是可选能力：未提供 onSync 不渲染；提供则回调 (id, name)', () => {
    const { unmount } = render(<Harness groups={[{ id: 'a', name: 'Frontend', count: 0 }]} />);
    expect(screen.queryByTitle('Sync to agents')).not.toBeInTheDocument();
    unmount();

    const onSync = vi.fn();
    render(<Harness groups={[{ id: 'a', name: 'Frontend', count: 0 }]} onSync={onSync} />);
    fireEvent.click(screen.getByTitle('Sync to agents'));
    expect(onSync).toHaveBeenCalledWith('a', 'Frontend');
  });
});
