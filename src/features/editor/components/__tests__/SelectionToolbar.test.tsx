import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SelectionToolbar, { COPIED_FEEDBACK_MS } from '../SelectionToolbar';

const baseProps = {
  visible: true,
  top: 0,
  left: 0,
  onAction: vi.fn(),
  onClose: vi.fn(),
  needsAgentTab: false,
  onCreateTab: vi.fn(),
  onCopySelection: vi.fn(),
};

type Props = typeof baseProps;

/**
 * 打开 Ask 输入态并写入草稿 —— 全部用例共用的起点。
 * rerender 始终作用于同一实例：真实路径是 FileEditorView 重渲染时 visible
 * true → false → true，组件并未卸载（只是 return null）。
 */
function openAsk() {
  const utils = render(<SelectionToolbar {...baseProps} />);
  const rerender = (props: Partial<Props> = {}) =>
    utils.rerender(<SelectionToolbar {...baseProps} {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
  fireEvent.change(screen.getByPlaceholderText(/Ask about the selected code/), {
    target: { value: 'draft' },
  });
  return { rerender };
}

/**
 * 进入 Ask 输入态 —— Copy 用例共用的起点（Copy 按钮与 Ask 行互斥，需先退出）。
 * 直接点 Ask 即可，无需写草稿。
 */
function openAskEmpty() {
  const utils = render(<SelectionToolbar {...baseProps} />);
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
  return { utils };
}

/** 一次「取消 → 重新选中」周期：visible 翻 false 再翻回 true。 */
function hideThenShowAgain(rerender: (props?: Partial<Props>) => void) {
  rerender({ visible: false });
  rerender({ visible: true });
}

describe('SelectionToolbar — Ask 输入态的生命周期', () => {
  it('关闭工具栏再重新选中 → 回到动作按钮行（不残留 Ask 输入框）', () => {
    const { rerender } = openAsk();
    expect(screen.getByPlaceholderText(/Ask about the selected code/)).toBeInTheDocument();

    hideThenShowAgain(rerender);

    expect(screen.queryByPlaceholderText(/Ask about the selected code/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask' })).toBeInTheDocument();
  });

  it('关闭工具栏再重新选中 → 清掉未发送的草稿', () => {
    const { rerender } = openAsk();

    hideThenShowAgain(rerender);
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));

    const input = screen.getByPlaceholderText(/Ask about the selected code/) as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('工具栏保持可见时输入态不被打断（连续输入 / 选区位置变化）', () => {
    const { rerender } = openAsk();

    // 同一可见周期内只有位置变化（false 从未出现）→ 草稿必须保留
    rerender({ top: 10, left: 20 });
    rerender({ top: 30, left: 40 });

    const input = screen.getByPlaceholderText(/Ask about the selected code/) as HTMLInputElement;
    expect(input.value).toBe('draft');
  });

  it('发送后自身回到动作按钮行（输入态不跨动作存活）', () => {
    const onAction = vi.fn();
    const utils = render(<SelectionToolbar {...baseProps} onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    fireEvent.change(screen.getByPlaceholderText(/Ask about the selected code/), {
      target: { value: 'why?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onAction).toHaveBeenCalledWith('ask', 'why?');
    expect(screen.queryByPlaceholderText(/Ask about the selected code/)).not.toBeInTheDocument();
    utils.unmount();
  });
});

describe('SelectionToolbar — Copy 按钮', () => {
  it('渲染 Copy 按钮（与 AI 动作同一行）', () => {
    render(<SelectionToolbar {...baseProps} />);

    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('点击 Copy → 回调 onCopySelection（不触发 AI 派发）', () => {
    const onCopySelection = vi.fn();
    const onAction = vi.fn();
    render(
      <SelectionToolbar {...baseProps} onCopySelection={onCopySelection} onAction={onAction} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(onCopySelection).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();
  });

  it(`复制成功后按钮显示 ✓ 反馈（${COPIED_FEEDBACK_MS}ms 后还原）`, async () => {
    render(<SelectionToolbar {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();

    expect(
      await screen.findByRole(
        'button',
        { name: 'Copy' },
        {
          timeout: COPIED_FEEDBACK_MS * 2,
        },
      ),
    ).toBeInTheDocument();
  });

  it('没有 agent 终端（needsAgentTab）时不渲染操作行 → 无 Copy 按钮', () => {
    render(<SelectionToolbar {...baseProps} needsAgentTab />);

    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
  });

  it('Ask 输入态不渲染 Copy 按钮（输入行与 AI 动作行互斥）', () => {
    openAskEmpty();

    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
  });
});
