/**
 * `model_config` / `thought_level` 控件的渲染契约（AC9）。
 *
 * 这些选项**不是模型条目的属性**：它们可以在不换模型时单独调整，可选值还会随模型
 * 变化。旧实现把 `200k ctx · free` 拼在模型名后面，用户改不了。规范要求把它们渲染
 * 在模型选择器附近（同一 popover），并且按 `type` 分别渲染成下拉 / 开关。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { modelConfigOptionsOf } from '../ChatComposer';
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
  it('should pick model_config and thought_level by category', () => {
    const picked = modelConfigOptionsOf([
      { id: 'model', name: 'Model', category: 'model', options: [] },
      { id: 'context', name: 'Context', category: 'model_config', options: [] },
      { id: 'reasoning_effort', name: 'Effort', category: 'thought_level', options: [] },
      { id: 'mode', name: 'Mode', category: 'mode', options: [] },
    ]);

    expect(picked.map((o) => o.id)).toEqual(['context', 'reasoning_effort']);
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
