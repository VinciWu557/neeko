import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ComposerPalette from '../ComposerPalette';
import type { PaletteItem } from '../paletteSources';

/**
 * 弹层骨架（纯展示：分组渲染 + 点击选中 + 高亮行滚入可视区）。
 *
 * 键盘导航（↑↓ / Enter / Tab / Esc）与触发判定**不在这里测** —— 它们由
 * suggestion 引擎接管，对应行为在 `composer/__tests__/RichComposerSuggestions.test.tsx`
 * 里以真实按键路径覆盖。
 */

const ITEMS: PaletteItem[] = [
  {
    value: 'trellis-continue',
    label: 'trellis-continue',
    sublabel: 'Resume work',
    group: 'command',
  },
  { value: 'skill:walkthrough', label: 'skill:walkthrough', sublabel: 'Walk code', group: 'skill' },
  { value: 'src/app/App.tsx', label: 'App.tsx', sublabel: 'src/app/App.tsx', group: 'file' },
];

function renderPalette(overrides: Partial<Parameters<typeof ComposerPalette>[0]> = {}) {
  const props = {
    kind: 'slash' as const,
    items: ITEMS,
    highlight: 0,
    emptyText: 'No commands available',
    onHighlight: vi.fn(),
    onPick: vi.fn(),
    ...overrides,
  };
  const view = render(<ComposerPalette {...props} />);
  return { ...props, view };
}

describe('ComposerPalette', () => {
  it('should render the candidates with their labels and sublabels', () => {
    renderPalette();
    expect(screen.getAllByRole('option')).toHaveLength(3);
    // 渲染顺序 = 分组顺序（Skills 先于 Commands），不是 items 的到达顺序
    const commands = screen.getByRole('group', { name: 'Commands' });
    const cmd = within(commands).getByRole('option');
    expect(within(cmd).getByText('trellis-continue')).toBeInTheDocument();
    expect(within(cmd).getByText('Resume work')).toBeInTheDocument();
  });

  /**
   * 分组渲染：每组一个标题（Skills / Commands / Files），组顺序由
   * `PALETTE_GROUP_ORDER` 决定，**不是** items 的到达顺序 —— 否则同一份数据
   * 换个来源顺序就换一种排法。
   */
  it('should group candidates by kind with section titles in a stable order', () => {
    renderPalette();
    const groups = screen.getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([
      'Skills',
      'Commands',
      'Files',
    ]);
    // 每组只装自己的项
    expect(within(groups[0]).getAllByRole('option')).toHaveLength(1);
    expect(within(groups[1]).getAllByRole('option')).toHaveLength(1);
  });

  it('should mark the highlighted row as selected', () => {
    renderPalette({ highlight: 1 });
    const options = screen.getAllByRole('option');
    // 扁平下标 1 = Skills 组里的那一项（分组只改结构，不改下标语义）
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('should report a click with the flat picked index', () => {
    const utils = renderPalette();
    fireEvent.click(screen.getAllByRole('option')[2]);
    // 扁平下标：Commands(1) + Skills(1) 之后才是 Files 的第一项 → index 2
    expect(utils.onPick).toHaveBeenCalledWith(2);
  });

  it('should report hover so the engine can move the highlight', () => {
    const utils = renderPalette();
    fireEvent.mouseEnter(screen.getAllByRole('option')[2]);
    expect(utils.onHighlight).toHaveBeenCalledWith(2);
  });

  it('should show the empty state instead of an empty box', () => {
    renderPalette({ items: [], emptyText: 'No matching commands' });
    expect(screen.getByText('No matching commands')).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.queryAllByRole('group')).toHaveLength(0);
  });

  it('should label the listbox by the palette kind', () => {
    renderPalette({ kind: 'mention' });
    expect(screen.getByRole('listbox', { name: '文件补全' })).toBeInTheDocument();
  });

  it('should not steal focus from the editor on mousedown', () => {
    renderPalette();
    const option = screen.getAllByRole('option')[0];
    // preventDefault 的默认行为被阻止 → dispatchEvent 返回 false
    expect(fireEvent.mouseDown(option)).toBe(false);
  });

  /**
   * 高亮行必须滚进可视区（jsdom 无布局，只需证明**调用了** scrollIntoView ——
   * 否则方向键在长列表里「看不见自己在哪」）。
   */
  it('should scroll the highlighted row into view', () => {
    const scrollIntoView = vi.fn();
    // jsdom 未实现 scrollIntoView，且 Element.prototype 上的赋值是静默失败的
    // ——必须用 defineProperty 注入（直接 `proto.scrollIntoView = fn` 不生效）。
    // 全局 setup 已在 HTMLElement.prototype 注入 vi.fn 垫片 —— 换掉它来观察调用。
    const proto = HTMLElement.prototype as HTMLElement & { scrollIntoView?: () => void };
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'scrollIntoView');
    Object.defineProperty(proto, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
      writable: true,
    });
    try {
      renderPalette({ highlight: 1 });
      expect(scrollIntoView).toHaveBeenCalled();
    } finally {
      if (descriptor) Object.defineProperty(proto, 'scrollIntoView', descriptor);
      else delete proto.scrollIntoView;
    }
  });
});
