import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ModelInfo } from '@/features/agent/api/agentApi';

import { ModelPicker } from '../ModelPicker';

/**
 * provider 必须真的出现在**界面上**，而不只是 `providerLabelOf` 返回了值。
 *
 * # 为什么这条必须单独存在
 *
 * `providerLabelOf` 有 6 条纯函数单测，全部通过 —— 但把
 * `{providerLabel ? <span className="param-provider">…</span> : null}` 整行删掉后，
 * 那 6 条**依然全绿**（变异实测）。纯函数正确 ≠ 它被接到渲染上，与「`selected`
 * class 算出来了但样式表没有规则」是同一类漏法：两侧各自正确，中间没有一条用例
 * 盯着「它们连上了」。
 *
 * 这里钉三件事：
 * 1. provider 徽标出现在**收起态按钮**上（用户不开下拉就能看到）；
 * 2. `name` 已含 provider 时**不重复渲染**（否则 `magpie/magpie/…` 噪音）；
 * 3. 列表项的副标题走同一判据（`ModelList` 也有独立的消费点）。
 */

function makeModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return { id: 'm', name: 'Model', supported_reasoning_efforts: [], is_free: false, ...overrides };
}

const AGENT = { id: 'pi', name: 'Pi', icon: null };

/** 展开下拉（主按钮的可访问名是当前模型名）。 */
function openDropdown(label: RegExp) {
  fireEvent.click(screen.getByRole('button', { name: label }));
}

describe('ModelPicker 在按钮上显示 provider', () => {
  /** Pi 的 rpc 列表：`name` 不含 provider，必须单独补一个徽标。 */
  it('should render the provider badge when the name does not carry it', () => {
    const model = makeModel({
      id: 'auto/deepseek-v4.1-flash',
      name: 'Deepseek-V4.1-Flash',
      group: 'magpie',
    });
    render(<ModelPicker models={[model]} selected={model} onChange={() => {}} agent={AGENT} />);

    // 主按钮 = 唯一含模型名的按钮（下拉未展开时）
    const btn = screen.getByRole('button', { name: /Deepseek-V4.1-Flash/ });
    // 模型名必须原样保留（不被 provider 挤掉、不被截断）
    expect(btn).toHaveTextContent('Deepseek-V4.1-Flash');
    // provider 徽标与模型名在同一个按钮内
    expect(within(btn).getByText('magpie')).toHaveClass('param-provider');
  });

  /**
   * `name` 已经是 `provider/model` 复合串（opencode、旧版 Pi 表格）→ 不重复。
   *
   * 变异验证：把渲染判据从 `providerLabelOf(current)` 换成 `current.group` → 本用例红。
   */
  it('should not repeat the provider when the name already starts with it', () => {
    const model = makeModel({ id: 'opencode/big-pickle', name: 'opencode/big-pickle' });
    render(<ModelPicker models={[model]} selected={model} onChange={() => {}} agent={AGENT} />);

    const btn = screen.getByRole('button', { name: /big-pickle/ });
    expect(within(btn).queryByText('opencode')).not.toBeInTheDocument();
  });

  /** 未选模型时不渲染任何 provider 徽标（此时按钮回落 agent 图标，没有模型可言）。 */
  it('should render no provider badge before a model is selected', () => {
    render(
      <ModelPicker models={[makeModel()]} selected={null} onChange={() => {}} agent={AGENT} />,
    );
    expect(screen.queryByText('magpie')).not.toBeInTheDocument();
  });

  /**
   * 列表项的副标题同样走 `providerLabelOf` —— 这是**第二个**消费点。
   *
   * 变异验证：把 `ModelList` 里的 `providerLabelOf(m) ?? m.description` 换成
   * `m.description` → 本用例红（副标题消失）。
   */
  it('should use the same provider judgement for the list item subtitle', () => {
    const model = makeModel({ id: 'auto/x', name: 'Deepseek-V4.1-Flash', group: 'magpie' });
    render(<ModelPicker models={[model]} selected={model} onChange={() => {}} agent={AGENT} />);
    openDropdown(/Deepseek-V4.1-Flash/);

    // 列表项是 `role="option"`（主按钮仍是 button）
    const item = screen.getByRole('option', { name: /Deepseek-V4.1-Flash/ });
    expect(within(item).getByText('magpie')).toHaveClass('param-opt-desc');
  });

  /** `name` 已含 provider 时，列表项也不重复 —— 与按钮同一判据，不能一处有一处无。 */
  it('should not repeat the provider in the list item subtitle', () => {
    const model = makeModel({ id: 'opencode/big-pickle', name: 'opencode/big-pickle' });
    render(<ModelPicker models={[model]} selected={model} onChange={() => {}} agent={AGENT} />);
    openDropdown(/big-pickle/);

    const item = screen.getByRole('option', { name: /big-pickle/ });
    // eslint-disable-next-line testing-library/no-node-access -- 断言「副标题不存在」，testing-library 没有对应查询（queryBy 需要文本，而这里恰恰不知道会是什么文本）
    expect(item.querySelector('.param-opt-desc')).toBeNull();
  });
});
