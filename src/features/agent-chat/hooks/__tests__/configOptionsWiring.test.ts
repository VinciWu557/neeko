// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * `useSessionConfigOptions` 的三处接线**静态护栏**。
 *
 * # 为什么需要静态断言
 *
 * hook 自身的单测全绿也无法证明它真的被接上：`reset()` 存在、行为正确，但如果
 * `useAgentChat` 从不调用它，切 agent 后上一个 ACP 会话的 `model_config` 控件照样
 * 残留 —— 变异实测确认了这一点（删掉 `resetConfigOptions()` 调用，5 条 hook 测试
 * 全绿）。这类「实现正确但没接线」的缺陷只能从源码结构上判。
 *
 * 三处接线各有独立后果：
 *
 * | 接线 | 缺失后果 |
 * | --- | --- |
 * | `session_start` → `replace` | 首次会话拿不到模型列表 |
 * | `config_option_update` → `replace` | agent 中途换模型后 UI 与真实状态脱节 |
 * | agent/model 变化 → `reset` | 上个会话的配置控件残留，改它们朝不存在的 configId 发请求 |
 */
const HOOK = 'src/features/agent-chat/hooks/useAgentChat.ts';

function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

describe('configOptions wiring', () => {
  it('should populate options from the session_start event', () => {
    const source = codeOnly(readFileSync(HOOK, 'utf8'));
    expect(source).toMatch(/case 'session_start':[\s\S]{0,400}?replaceConfigOptions\(/);
  });

  /** 协议规定 agent 可主动变更（rate limit fallback），不订阅就与真实状态脱节。 */
  it('should replace options on config_option_update', () => {
    const source = codeOnly(readFileSync(HOOK, 'utf8'));
    expect(source).toMatch(/case 'config_option_update':[\s\S]{0,400}?replaceConfigOptions\(/);
  });

  /**
   * 切 agent / 换模型会话即失效，配置项必须一并清空。
   * 变异实测：删掉这一行，hook 的全部单测仍然全绿。
   */
  it('should reset options when the session context is invalidated', () => {
    const source = codeOnly(readFileSync(HOOK, 'utf8'));
    // 会话失效发生在 prevAgentModelRef 的 effect 里（sessionId 置空处）
    const effectStart = source.indexOf('prevAgentModelRef');
    expect(effectStart).toBeGreaterThan(-1);
    const effectBody = source.slice(effectStart, effectStart + 1400);
    expect(effectBody).toContain('resetConfigOptions()');
  });
});
