/**
 * `model_config` / `thought_level` 控件的渲染契约（AC9）。
 *
 * 这些选项**不是模型条目的属性**：它们可以在不换模型时单独调整，可选值还会随模型
 * 变化。旧实现把 `200k ctx · free` 拼在模型名后面，用户改不了。规范要求把它们渲染
 * 在模型选择器附近（同一 popover），并且按 `type` 分别渲染成下拉 / 开关。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { modeOptionOf, modelConfigOptionsOf, thoughtLevelOptionOf } from '../composerConfigOptions';
import { ModelConfigSection } from '../ModelConfigSection';

const selectOption = (id: string, name: string, current: string) => ({
  id,
  name,
  type: 'select',
  currentValue: current,
  options: [
    { value: 'a', name: 'Option A' },
    { value: 'b', name: 'Option B' },
  ],
});

describe('ModelConfigSection', () => {
  it('should render one control per option', () => {
    render(
      <ModelConfigSection
        options={[selectOption('context', 'Context', 'a'), selectOption('speed', 'Speed', 'b')]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Context')).toBeInTheDocument();
    expect(screen.getByLabelText('Speed')).toBeInTheDocument();
  });

  it('should emit the selected value for a select option', () => {
    const onChange = vi.fn();
    render(
      <ModelConfigSection
        options={[selectOption('context', 'Context', 'a')]}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('Context'), { target: { value: 'b' } });
    expect(onChange).toHaveBeenCalledWith('context', 'b');
  });

  /** boolean 形态必须渲染成开关 —— 协议用 `type` 判别，不能靠猜。 */
  it('should render a checkbox for a boolean option', () => {
    render(
      <ModelConfigSection
        options={[
          { id: 'fast', name: 'Fast mode', type: 'boolean', currentValue: true, options: [] },
        ]}
        onChange={vi.fn()}
      />,
    );

    const checkbox = screen.getByLabelText('Fast mode') as HTMLInputElement;
    expect(checkbox.type).toBe('checkbox');
    expect(checkbox).toBeChecked();
  });

  it('should emit a boolean value for a boolean option', () => {
    const onChange = vi.fn();
    render(
      <ModelConfigSection
        options={[
          { id: 'fast', name: 'Fast mode', type: 'boolean', currentValue: false, options: [] },
        ]}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByLabelText('Fast mode'));
    expect(onChange).toHaveBeenCalledWith('fast', true);
  });

  /** 无配置项时整块不渲染 —— 空区域会让用户以为「这里本该有东西但坏了」。 */
  it('should render nothing when there are no options', () => {
    const { container } = render(<ModelConfigSection options={[]} onChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('modelConfigOptionsOf', () => {
  /**
   * 判定靠 `category`，不靠 `id`：规范明说 category 是 UX 提示，没有 id 命名约束
   * （实测 Codex 用 `reasoning_effort`、OpenCode 用 `effort`）。
   */
  /**
   * 只收 `model_config`。`thought_level` 归输入框的选择器 ——
   * 两处都渲染会出现两个控件指向同一个 `configId`，改一处另一处不动。
   */
  it('should pick only model_config by category', () => {
    const picked = modelConfigOptionsOf([
      { id: 'model', name: 'Model', category: 'model', options: [] },
      { id: 'context', name: 'Context', category: 'model_config', options: [] },
      { id: 'reasoning_effort', name: 'Effort', category: 'thought_level', options: [] },
      { id: 'mode', name: 'Mode', category: 'mode', options: [] },
    ]);

    expect(picked.map((o) => o.id)).toEqual(['context']);
  });

  /// `thought_level` 由专用入口取出，供输入框工具条使用。
  it('should expose the thought_level option separately', () => {
    const option = thoughtLevelOptionOf([
      { id: 'model', name: 'Model', category: 'model', options: [] },
      {
        id: 'thinking_level',
        name: 'Thinking level',
        category: 'thought_level',
        currentValue: 'high',
        options: [
          { value: 'low', name: 'low' },
          { value: 'high', name: 'high' },
        ],
      },
    ]);
    expect(option?.id).toBe('thinking_level');
    expect(option?.currentValue).toBe('high');
    expect(option?.options.map((o) => o.value)).toEqual(['low', 'high']);
  });

  /// 没有该项时返回 null —— 调用方据此隐藏选择器。
  it('should return null when thought_level is absent', () => {
    expect(thoughtLevelOptionOf([{ id: 'model', name: 'M', category: 'model' }])).toBeNull();
    expect(thoughtLevelOptionOf(undefined)).toBeNull();
  });

  /**
   * 模式（plan / build）同样只认会话下发的 `category: "mode"`。
   *
   * **当前没有任何内置 agent 下发它**（Pi 的 rpc 没有这个概念，opencode serve
   * 也不发），所以线上表现是选择器一直不出现 —— 这是正确行为。这组断言守的是
   * 「一旦某个 agent 下发，UI 自动接上；一旦撤回，UI 自动消失」。
   */
  it('should expose the mode option when the session provides one', () => {
    const option = modeOptionOf([
      { id: 'model', name: 'Model', category: 'model', options: [] },
      {
        id: 'session_mode',
        name: 'Mode',
        category: 'mode',
        currentValue: 'plan',
        options: [
          { value: 'build', name: 'Build' },
          { value: 'plan', name: 'Plan' },
        ],
      },
    ]);
    expect(option?.id).toBe('session_mode');
    expect(option?.currentValue).toBe('plan');
    expect(option?.options.map((o) => o.value)).toEqual(['build', 'plan']);
  });

  /// agent 不支持模式 → null → 选择器不渲染。
  it('should return null when the session has no mode option', () => {
    expect(modeOptionOf([{ id: 'model', name: 'M', category: 'model' }])).toBeNull();
    expect(modeOptionOf(undefined)).toBeNull();
  });

  /** 没有 options 时返回空数组，而不是抛错。 */
  it('should return an empty list when config options are absent', () => {
    expect(modelConfigOptionsOf(undefined)).toEqual([]);
  });

  /** `type` 缺省视为 select（协议规定）。 */
  it('should default the type to select', () => {
    const [option] = modelConfigOptionsOf([
      { id: 'context', name: 'Context', category: 'model_config', options: [] },
    ]);
    expect(option.type).toBe('select');
  });
});
