/**
 * 模型下拉在非 `available` 状态下的措辞（AC4 / AC7）。
 *
 * 四种处境对用户是四种不同的事实，压成空数组就只能显示同一个 "No models"：
 * - `session-scoped`：协议限制（ACP 没有独立的列模型方法），不是故障 → 说明原因
 * - `unsupported`：这个 agent 就是没有模型选择 → 说明原因
 * - `error`：拉取失败 → 唯一「可以再试」的一种
 * - `loading`：等就有
 *
 * 控件本身**始终存在**（用户明确要求不分传输协议隐藏），只是文案随能力变化。
 */
import { describe, expect, it } from 'vitest';

import { modelPlaceholder } from '../EditorPanel';

describe('modelPlaceholder', () => {
  it('should explain the protocol limit for session-scoped agents', () => {
    expect(modelPlaceholder('session-scoped')).toBe('Available inside a session');
  });

  it('should state that the agent has no model selection', () => {
    expect(modelPlaceholder('unsupported')).toBe('This agent has no model selection');
  });

  it('should report a load failure distinctly', () => {
    expect(modelPlaceholder('error')).toBe('Could not load models');
  });

  it('should show a loading hint', () => {
    expect(modelPlaceholder('loading')).toBe('Loading models…');
  });

  it('should invite the user to pick an agent first', () => {
    expect(modelPlaceholder('idle')).toBe('Select an agent first');
  });

  /** 四种非 available 状态的文案必须互不相同 —— 相同就等于没有分流。 */
  it('should give every state a distinct message', () => {
    const kinds = ['session-scoped', 'unsupported', 'error', 'loading', 'idle'];
    const messages = kinds.map(modelPlaceholder);
    expect(new Set(messages).size).toBe(kinds.length);
  });
});
