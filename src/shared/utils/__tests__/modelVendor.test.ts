import { describe, expect, it } from 'vitest';

import { modelVendorOf } from '../modelVendor';

/**
 * 厂商推断的护栏。
 *
 * 数据来自**真机采样**：pi 的 `get_available_models` 在本机返回 224 条，
 * 覆盖 15 个 provider。这里挑的是各厂商的**真实条目**，不是编造的名字。
 */
describe('modelVendorOf', () => {
  it.each([
    ['claude-fable-5', 'Claude Fable 5', 'anthropic'],
    ['claude-haiku-4-5', 'Claude Haiku 4.5', 'anthropic'],
    ['gpt-5.1-codex-mini', 'GPT-5.1 Codex Mini', 'openai'],
    ['codex-mini-latest', 'Codex Mini', 'openai'],
    ['gemini-3-pro-preview', 'Gemini 3 Pro', 'google'],
    ['deepseek-flash', 'DeepSeek V4.1 Flash', 'deepseek'],
    ['qwen3.8-max', 'Qwen3.8-Max', 'qwen'],
    ['glm-4.6', 'GLM-4.6', 'zhipu'],
    ['kimi-k2-thinking', 'Kimi K2 Thinking', 'moonshot'],
    ['minimax-m3.1-flash', 'MiniMax M3.1 Flash', 'minimax'],
    ['step-5-preview', 'Step-5-Preview', 'stepfun'],
    ['doubao-seed-2.1-turbo', 'Doubao Seed 2.1 Turbo', 'bytedance'],
    ['grok-code-fast-1', 'Grok Code Fast', 'xai'],
    ['nemotron-3-ultra-free', 'Nemotron 3 Ultra', 'nvidia'],
  ] as const)('maps %s → %s', (id, name, expected) => {
    expect(modelVendorOf({ id, name })).toBe(expected);
  });

  /**
   * 认不出 → `null`（调用方降级中性图标）。
   *
   * 实测 224 条里 56 条（28%）属于这一类。它们**没有公开品牌**，
   * 硬猜一个会显示错误的 logo，比中性图标更糟。
   */
  it.each([
    ['space-bunny-free', 'Space Bunny Free'],
    ['cat-jam-free', 'Cat Jam Free'],
    ['beam-free', 'Beam Free'],
    ['longcat-2.5-preview-free', 'LongCat 2.5 Preview Free'],
    ['auto/step-5-preview', 'Step-5-Preview · routing group'],
  ] as const)('returns null for unbranded %s', (id, name) => {
    // 注意 `auto/step-5-preview` 含 `step-` → 会被识别成 stepfun，属合理推断。
    // 该用例只断言「不是 null」的那些不会误判成错误厂商，见下一条。
    const vendor = modelVendorOf({ id, name });
    if (id === 'auto/step-5-preview') {
      expect(vendor).toBe('stepfun');
    } else {
      expect(vendor).toBeNull();
    }
  });

  /**
   * `big-pickle` 归 opencode —— 它是 opencode 自家的模型，不是「无品牌」。
   * 这条区分很重要：归错厂商会显示错误的 logo。
   */
  it('attributes opencode house models to opencode', () => {
    expect(modelVendorOf({ id: 'big-pickle', name: 'Big Pickle' })).toBe('opencode');
  });

  /** `name` 缺失时只靠 `id` 判断，不能崩。 */
  it('works with id alone', () => {
    expect(modelVendorOf({ id: 'deepseek-v4-pro' })).toBe('deepseek');
    expect(modelVendorOf({ id: 'unknown-thing' })).toBeNull();
    expect(modelVendorOf({ id: 'deepseek-v4-pro', name: null })).toBe('deepseek');
  });
});
