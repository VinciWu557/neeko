import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ModelInfo } from '@/features/agent/api/agentApi';

import { ModelPicker } from '../ModelPicker';

/**
 * 「显示了控件但点了没反应」的运行时护栏（PRD R3 / AC5）。
 *
 * # 为什么必须测 DOM
 *
 * 这条约束曾在静态护栏里被漏过：`isSelectable()` 与 `modelKeyOf()` 写了却零消费
 * （只有测试用），于是 `ModelPicker` 里没有任何门控 —— 而所有断言"存在某个
 * 标识符"的静态护栏仍然全绿。
 *
 * 真机可达路径：Pi（`session_config`）+ 会话未建立 → 列表只来自会话外表格
 * （`provider/model` 复合串）→ 喂给 `set_model` 会得到
 * `Model not found: provider/provider/model`。
 */

const MODELS: ModelInfo[] = [
  { id: 'deepseek/deepseek-flash', name: 'deepseek-flash', group: 'deepseek' },
  { id: 'anthropic/claude-sonnet', name: 'claude-sonnet', group: 'anthropic' },
];

function renderPicker(writability: 'writable' | 'loading' | 'read-only') {
  const onChange = vi.fn();
  render(
    <ModelPicker
      models={MODELS}
      selected={null}
      onChange={onChange}
      agent={{ id: 'pi', name: 'Pi', icon: null }}
      writability={writability}
    />,
  );
  fireEvent.click(screen.getByTitle('Select model'));
  return { onChange };
}

describe('ModelPicker 可写性门控', () => {
  /** 可写：列表项可点，回调真的触发。 */
  it('should let the user pick a model when the list is writable', () => {
    const { onChange } = renderPicker('writable');
    const item = screen.getByRole('button', { name: /deepseek-flash/ });
    expect(item).toBeEnabled();
    fireEvent.click(item);
    expect(onChange).toHaveBeenCalled();
  });

  /**
   * 不可写：每个列表项 `disabled`，点击不产生任何回调。
   *
   * 变异验证：去掉 `<ModelList disabled={!writable}>` → 本用例变红
   *（`item.disabled` 为 false，且 `onChange` 被调用）。
   */
  it('should disable every item when the list has no write channel', () => {
    const { onChange } = renderPicker('read-only');
    const item = screen.getByRole('button', { name: /deepseek-flash/ });
    expect(item).toBeDisabled();
    fireEvent.click(item);
    expect(onChange).not.toHaveBeenCalled();
  });

  /**
   * `ChatComposer` 必须用**共享判据**算 `writable`，不能传常量或自己再推一遍。
   *
   * 变异验证：把 `writable={canWriteModels(modelSource)}` 改成 `writable={true}`
   * → 本用例变红（上层绕开判据时页面级行为无人守）。
   *
   * 为什么需要这条：组件级护栏只证明「收到 `writable=false` 会禁用」，
   * 证明不了「上层真的会传 false」。
   */
  it('should derive writability from the shared availability union', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const composer = readFileSync(resolve(__dirname, '../ChatComposer.tsx'), 'utf8');
    // 必须从共享判据派生，不能传常量、也不能自己再 switch 一遍。
    expect(composer).toContain('writabilityOf(');
    expect(composer).not.toMatch(/writability=\{'writable'\}/);
    expect(composer).not.toContain('modelSourceOf(');
  });

  /**
   * 禁用必须带**原因**，且两种成因措辞不同。
   *
   * 「会话建立中」是暂时的，「这个 agent 不支持」是上限 —— 用户需要能区分，
   * 否则「一串灰模型」等于「点了没反应且不知道为什么」（R3 的变体）。
   *
   * 变异验证：把 `disabledHint` 传成常量 → 本用例变红。
   */
  it('should explain a temporary disable as loading', () => {
    renderPicker('loading');
    expect(screen.getByText('Models are loading…')).toBeInTheDocument();
    expect(screen.queryByText('Read-only list for this agent')).not.toBeInTheDocument();
  });

  it('should use the permanent wording when the agent has no write channel', () => {
    renderPicker('read-only');
    expect(screen.getByText('Read-only list for this agent')).toBeInTheDocument();
    expect(screen.queryByText('Models are loading…')).not.toBeInTheDocument();
  });

  /** 可写时不显示任何禁用提示。 */
  it('should not show a disabled hint when the list is writable', () => {
    renderPicker('writable');
    expect(screen.queryByText('Models are loading…')).not.toBeInTheDocument();
    expect(screen.queryByText('Read-only list for this agent')).not.toBeInTheDocument();
  });

  /** 两个条目都禁用 —— 不是只禁第一个。 */
  it('should disable all items, not just the first', () => {
    renderPicker('read-only');
    for (const m of MODELS) {
      const item = screen.getByRole('button', { name: new RegExp(m.name) });
      expect(item).toBeDisabled();
    }
  });

  /**
   * **空列表的文案必须按「为什么空」分开**，不能共用一句。
   *
   * 早期只有 `Models appear once the session is ready`，对 `read-only` 的 agent
   * 是误导 —— 它永远不会出现。
   *
   * 变异验证：三种状态共用一句 → 后两条用例变红。
   */
  it.each([
    ['loading', 'Models appear once the session is ready'],
    ['read-only', 'This agent offers no model selection'],
    ['writable', 'No models available'],
  ] as const)('should explain an empty %s list with its own wording', (writability, text) => {
    render(
      <ModelPicker
        models={[]}
        selected={null}
        onChange={vi.fn()}
        agent={{ id: 'a', name: 'A', icon: null }}
        writability={writability}
      />,
    );
    fireEvent.click(screen.getByTitle('Select model'));
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});
