import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';

import ComposerPalette, { useComposerPalette } from '../ComposerPalette';
import type { ComposerPaletteSource, PaletteItem } from '../paletteSources';

const ITEMS: PaletteItem[] = [
  { value: 'trellis-continue', label: 'trellis-continue', sublabel: 'Resume the current task' },
  { value: 'trellis-start', label: 'trellis-start' },
];

const SOURCE: ComposerPaletteSource = {
  kind: 'slash',
  emptyText: 'No matching commands',
  getItems: (query) => ITEMS.filter((i) => i.value.includes(query)),
};

/** 最小键盘事件桩：hook 只读 `key`，调用方只调 `preventDefault`。 */
function keyEvent(key: string): KeyboardEvent<HTMLTextAreaElement> {
  return { key, preventDefault: () => undefined } as unknown as KeyboardEvent<HTMLTextAreaElement>;
}

/** 最小 change 事件桩：hook 只读 `value` 与 `selectionStart`。 */
function changeEvent(value: string): ChangeEvent<HTMLTextAreaElement> {
  return {
    target: { value, selectionStart: value.length },
  } as unknown as ChangeEvent<HTMLTextAreaElement>;
}

describe('useComposerPalette', () => {
  it('should open the palette when the change event carries a trigger', () => {
    const { result } = renderHook(() =>
      useComposerPalette({ input: '/tr', sources: [SOURCE], onReplaceText: vi.fn() }),
    );
    act(() => result.current.handleChange(changeEvent('/tr')));
    expect(result.current.view).not.toBeNull();
    expect(result.current.view?.kind).toBe('slash');
    expect(result.current.view?.items).toHaveLength(2);
    expect(result.current.view?.highlight).toBe(0);
  });

  it('should close when the trigger is invalidated (whitespace / no trigger)', () => {
    const { result } = renderHook(() =>
      useComposerPalette({ input: '/tr ', sources: [SOURCE], onReplaceText: vi.fn() }),
    );
    act(() => result.current.handleChange(changeEvent('/tr')));
    act(() => result.current.handleChange(changeEvent('/tr ')));
    expect(result.current.view).toBeNull();
  });

  it('should move the highlight with arrows and clamp at both ends', () => {
    const { result } = renderHook(() =>
      useComposerPalette({ input: '/tr', sources: [SOURCE], onReplaceText: vi.fn() }),
    );
    act(() => result.current.handleChange(changeEvent('/tr')));

    act(() => {
      expect(result.current.handleKeyDown(keyEvent('ArrowDown'))).toBe(true);
    });
    expect(result.current.view?.highlight).toBe(1);
    // 到底后不再前进
    act(() => {
      expect(result.current.handleKeyDown(keyEvent('ArrowDown'))).toBe(true);
    });
    expect(result.current.view?.highlight).toBe(1);
    act(() => {
      expect(result.current.handleKeyDown(keyEvent('ArrowUp'))).toBe(true);
    });
    expect(result.current.view?.highlight).toBe(0);
    // 到顶后不再后退
    act(() => {
      expect(result.current.handleKeyDown(keyEvent('ArrowUp'))).toBe(true);
    });
    expect(result.current.view?.highlight).toBe(0);
  });

  it('should replace the trigger segment on Enter and report the event as consumed', () => {
    const onReplaceText = vi.fn();
    const { result } = renderHook(() =>
      useComposerPalette({ input: 'hello /tr', sources: [SOURCE], onReplaceText }),
    );
    act(() => result.current.handleChange(changeEvent('hello /tr')));

    let consumed = false;
    act(() => {
      consumed = result.current.handleKeyDown(keyEvent('Enter'));
    });
    expect(consumed).toBe(true);
    // 变异验证：handleKeyDown 无条件 return false → 本用例红（onReplaceText 不被调用）
    expect(onReplaceText).toHaveBeenCalledWith('hello /trellis-continue ', 24);
    expect(result.current.view).toBeNull();
  });

  it('should also pick on Tab', () => {
    const onReplaceText = vi.fn();
    const { result } = renderHook(() =>
      useComposerPalette({ input: '/tr', sources: [SOURCE], onReplaceText }),
    );
    act(() => result.current.handleChange(changeEvent('/tr')));
    let consumedByTab = false;
    act(() => {
      consumedByTab = result.current.handleKeyDown(keyEvent('Tab'));
    });
    expect(consumedByTab).toBe(true);
    expect(onReplaceText).toHaveBeenCalledWith('/trellis-continue ', 18);
  });

  it('should close on Escape while keeping the typed text to the caller', () => {
    const onReplaceText = vi.fn();
    const { result } = renderHook(() =>
      useComposerPalette({ input: '/tr', sources: [SOURCE], onReplaceText }),
    );
    act(() => result.current.handleChange(changeEvent('/tr')));
    let consumedByEsc = false;
    act(() => {
      consumedByEsc = result.current.handleKeyDown(keyEvent('Escape'));
    });
    expect(consumedByEsc).toBe(true);
    expect(result.current.view).toBeNull();
    expect(onReplaceText).not.toHaveBeenCalled();
  });

  it('should consume nothing while the palette is closed', () => {
    const onReplaceText = vi.fn();
    const { result } = renderHook(() =>
      useComposerPalette({ input: '/tr', sources: [SOURCE], onReplaceText }),
    );
    for (const key of ['Enter', 'Tab', 'ArrowDown', 'ArrowUp', 'Escape']) {
      expect(result.current.handleKeyDown(keyEvent(key))).toBe(false);
    }
    expect(onReplaceText).not.toHaveBeenCalled();
  });

  it('should let Enter fall through when the filtered list is empty', () => {
    const onReplaceText = vi.fn();
    const { result } = renderHook(() =>
      useComposerPalette({ input: '/zzz', sources: [SOURCE], onReplaceText }),
    );
    act(() => result.current.handleChange(changeEvent('/zzz')));
    expect(result.current.view?.items).toHaveLength(0);
    // 空态下 Enter 不被弹层吞掉 —— 交给调用方的发送路径
    expect(result.current.handleKeyDown(keyEvent('Enter'))).toBe(false);
    let consumedByEsc = false;
    act(() => {
      consumedByEsc = result.current.handleKeyDown(keyEvent('Escape'));
    });
    expect(consumedByEsc).toBe(true);
  });

  it('should not trigger or pick while an IME composition is in progress (AC8)', () => {
    const onReplaceText = vi.fn();
    const { result } = renderHook(() =>
      useComposerPalette({ input: '/', sources: [SOURCE], onReplaceText }),
    );
    act(() => result.current.compositionProps.onCompositionStart());
    act(() => result.current.handleChange(changeEvent('/中文')));
    expect(result.current.view).toBeNull();
    // 组合期 Enter 是拼音上屏，弹层不得吞掉
    expect(result.current.handleKeyDown(keyEvent('Enter'))).toBe(false);

    act(() => result.current.compositionProps.onCompositionEnd());
    act(() => result.current.handleChange(changeEvent('/trellis')));
    expect(result.current.view).not.toBeNull();
  });

  /**
   * WebKit 愈合点（真机冒烟缺陷）：compositionend 与末次 input 事件的顺序在
   * WebKit 上可能颠倒 —— 受控值丢了组合末尾的 change，与 DOM 值分叉。组合结束
   * 后以 DOM 值为准经 onReplaceText 写回，并保留 WebKit 留下的光标位。
   * 变异验证：去掉 onCompositionEnd 的重同步 → 本用例红。
   */
  it('should resync the controlled value from the DOM when composition end reveals drift', () => {
    const onReplaceText = vi.fn();
    const { result } = renderHook(() =>
      useComposerPalette({ input: '/zhong', sources: [SOURCE], onReplaceText }),
    );
    act(() => result.current.compositionProps.onCompositionStart());
    // 模拟丢 change：DOM 值比受控值多出组合末尾字符
    const el = Object.assign(document.createElement('textarea'), {
      value: '/zhong文',
      selectionStart: '/zhong文'.length,
    });
    act(() => {
      result.current.textareaRef.current = el;
    });
    act(() => result.current.compositionProps.onCompositionEnd());
    expect(onReplaceText).toHaveBeenCalledWith('/zhong文', '/zhong文'.length);
    expect(result.current.composing).toBe(false);
  });

  it('should not write back on composition end when the DOM value matches the controlled input', () => {
    const onReplaceText = vi.fn();
    const { result } = renderHook(() =>
      useComposerPalette({ input: '/zhong文', sources: [SOURCE], onReplaceText }),
    );
    const el = Object.assign(document.createElement('textarea'), {
      value: '/zhong文',
      selectionStart: '/zhong文'.length,
    });
    act(() => {
      result.current.textareaRef.current = el;
    });
    act(() => result.current.compositionProps.onCompositionEnd());
    expect(onReplaceText).not.toHaveBeenCalled();
  });

  /**
   * keydown 消费前以真实光标重新校验：textarea 的选区移动不触发 onChange，
   * 挂载后的光标可能与 `active` 脱节 —— 失效即关闭并放行本次按键。
   * 变异验证：去掉 handleKeyDown 里的重新校验 → 本用例红（返回 true，
   * onReplaceText 被调）。
   */
  it('should re-validate against the real caret and fall through when it left the token', () => {
    const onReplaceText = vi.fn();
    const { result } = renderHook(() =>
      useComposerPalette({ input: '/tr', sources: [SOURCE], onReplaceText }),
    );
    act(() => result.current.handleChange(changeEvent('/tr')));
    expect(result.current.view).not.toBeNull();

    // 挂一个光标已离开触发段的 textarea（点击别处后的真实形态）
    const el = Object.assign(document.createElement('textarea'), {
      value: '/tr',
      selectionStart: 0,
    });
    act(() => {
      result.current.textareaRef.current = el;
    });

    let consumed = false;
    act(() => {
      consumed = result.current.handleKeyDown(keyEvent('Enter'));
    });
    expect(consumed).toBe(false);
    expect(result.current.view).toBeNull();
    expect(onReplaceText).not.toHaveBeenCalled();
  });
});

describe('ComposerPalette', () => {
  const baseProps = {
    kind: 'slash' as const,
    items: ITEMS,
    highlight: 1,
    emptyText: 'No matching commands',
    onHighlight: vi.fn(),
    onPick: vi.fn(),
  };

  it('should render label and sublabel with the highlight marked', () => {
    render(<ComposerPalette {...baseProps} />);
    expect(screen.getByRole('option', { name: /trellis-continue/ })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(screen.getByRole('option', { name: /trellis-start/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByText('Resume the current task')).toBeInTheDocument();
  });

  it('should pick the clicked item', async () => {
    const onPick = vi.fn();
    render(<ComposerPalette {...baseProps} onPick={onPick} />);
    await userEvent.click(screen.getByRole('option', { name: /trellis-start/ }));
    expect(onPick).toHaveBeenCalledWith(1);
  });

  it('should show the empty text when no item matches (R2)', () => {
    render(<ComposerPalette {...baseProps} items={[]} highlight={0} />);
    expect(screen.getByText('No matching commands')).toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });
});
