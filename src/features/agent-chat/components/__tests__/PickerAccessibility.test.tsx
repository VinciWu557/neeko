import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ModelInfo, ModelConfigOption } from '@/features/agent/api/agentApi';

import { ModelPicker } from '../ModelPicker';
import { AgentModeSelector } from '../ParamSelectors';

/**
 * 下拉列表的**可访问性语义**。
 *
 * # 为什么选中态不能只靠 class
 *
 * `.param-option.selected` 只是一层视觉提示。屏幕阅读器读不到它 —— 用户听到的
 * 是一串「按钮」，无法知道当前在跑哪个模型。而「我现在用的是哪个」正是这个控件
 * 唯一的语义。
 *
 * # 为什么按项目既有范式
 *
 * 仓库里已有三处正确实现（`ActionPalette` 的 `role="listbox"` + `role="option"` +
 * `aria-selected`、`OpenIdeButton`、`ShortcutPanel`）。agent-chat 的下拉是**局部
 * 缺失**而非全局约定，所以对齐既有范式而不是另立一套。
 */

function makeModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return { id: 'm', name: 'Model', supported_reasoning_efforts: [], is_free: false, ...overrides };
}

const AGENT = { id: 'pi', name: 'Pi', icon: null };

describe('ModelList 的可访问性语义', () => {
  /** 列表容器必须是 listbox —— 否则 `option` 无处归属。 */
  it('should expose the model list as a listbox', () => {
    const models = [makeModel({ id: 'a', name: 'Alpha' }), makeModel({ id: 'b', name: 'Beta' })];
    render(<ModelPicker models={models} selected={models[0]} onChange={() => {}} agent={AGENT} />);
    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }));

    const listbox = screen.getByRole('listbox');
    expect(listbox).toBeInTheDocument();
    // 列表项都归属于这个 listbox
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  /**
   * 选中项必须带 `aria-selected="true"` —— 这是**屏幕阅读器唯一**能读到的选中态。
   *
   * 变异验证：去掉 `aria-selected` → 本用例红。
   */
  it('should mark the selected model with aria-selected', () => {
    const models = [makeModel({ id: 'a', name: 'Alpha' }), makeModel({ id: 'b', name: 'Beta' })];
    render(<ModelPicker models={models} selected={models[1]} onChange={() => {}} agent={AGENT} />);
    fireEvent.click(screen.getByRole('button', { name: /Beta/ }));

    const options = screen.getAllByRole('option');
    const beta = options.find((o) => o.textContent?.includes('Beta'));
    const alpha = options.find((o) => o.textContent?.includes('Alpha'));
    expect(beta).toHaveAttribute('aria-selected', 'true');
    expect(alpha).toHaveAttribute('aria-selected', 'false');
  });

  /**
   * **同名模型靠 group 区分**时，`aria-selected` 必须只落在真正选中那一行。
   *
   * Pi 的 224 条模型只有 194 个唯一 id。若 a11y 判据用裸 id 而非 `modelKeyOf`，
   * 两行会同时报 `aria-selected="true"` —— 屏幕阅读器会念出两个「已选中」。
   *
   * 变异验证：把 `aria-selected` 的判据从 `selectedKey === modelKeyOf(m)` 改成
   * `selectedKey === m.id` → 本用例红。
   */
  it('should not mark duplicate ids as selected in two rows', () => {
    const models = [
      makeModel({ id: 'deepseek-v4-pro', name: 'Deepseek V4 Pro', group: 'magpie' }),
      makeModel({ id: 'deepseek-v4-pro', name: 'Deepseek V4 Pro', group: 'opencode' }),
    ];
    // 选中的是 opencode 那一条
    render(<ModelPicker models={models} selected={models[1]} onChange={() => {}} agent={AGENT} />);
    fireEvent.click(screen.getAllByRole('button', { name: /Deepseek V4 Pro/ })[0]);

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    const selectedRows = options.filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(selectedRows).toHaveLength(1);
    // 且必须是 opencode 那一条（副标题可区分）
    expect(selectedRows[0]).toHaveTextContent('opencode');
  });
});

describe('ParamSelectors 的可访问性语义', () => {
  const option: ModelConfigOption = {
    id: 'thought_level',
    name: 'Thinking level',
    currentValue: 'high',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' },
    ],
  };

  /** 档位列表同样要暴露 listbox / option / aria-selected。 */
  it('should expose the level list as a listbox with aria-selected', () => {
    render(<AgentModeSelector option={option} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByRole('listbox')).toBeInTheDocument();
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    const high = options.find((o) => o.textContent?.includes('High'));
    const low = options.find((o) => o.textContent?.includes('Low'));
    expect(high).toHaveAttribute('aria-selected', 'true');
    expect(low).toHaveAttribute('aria-selected', 'false');
  });
});

/**
 * `role="listbox"` 的**子元素只能是 option / group**。
 *
 * # 为什么这条值得单独一条用例
 *
 * 禁用提示（`disabledHint`）是一个普通文本 `div`。它很容易被放进 listbox
 * 内部 —— 看起来完全正常（视觉上就在列表上方），但屏幕阅读器会整段忽略它。
 * 那恰好抵消了这条提示存在的理由：用户听到一串「灰的、不可用」选项，却听不到
 * 「为什么不可用」。
 *
 * 变异验证：把 `disabledHint` 那个 div 移进 `role="listbox"` 内部 → 本用例红。
 */
describe('ModelList 的 listbox 结构约束', () => {
  const MODELS: ModelInfo[] = [
    { id: 'deepseek/deepseek-flash', name: 'deepseek-flash', group: 'deepseek' },
  ];

  it('should keep the disabled hint outside the listbox', () => {
    render(
      <ModelPicker
        models={MODELS}
        selected={null}
        onChange={vi.fn()}
        agent={{ id: 'pi', name: 'Pi', icon: null }}
        writability="read-only"
      />,
    );
    fireEvent.click(screen.getByTitle('Select model'));

    const listbox = screen.getByRole('listbox');
    const hint = screen.getByText('Read-only list for this agent');
    expect(listbox).not.toContainElement(hint);
  });

  /** 列表项必须全部在 listbox 内部 —— 否则「归属于一个 listbox」就不成立。 */
  it('should keep every option inside the listbox', () => {
    render(
      <ModelPicker
        models={MODELS}
        selected={null}
        onChange={vi.fn()}
        agent={{ id: 'pi', name: 'Pi', icon: null }}
      />,
    );
    fireEvent.click(screen.getByTitle('Select model'));

    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThan(0);
    for (const o of options) {
      expect(listbox).toContainElement(o);
    }
  });
});
