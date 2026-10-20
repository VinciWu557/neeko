/**
 * 翻译 agent 的可用性判据。
 *
 * 背景：配置持久化、agent 列表会变。三种陈旧形态都会让翻译在**运行时**失败 ——
 * agent 被删（`NotFound`）、失去 chat 能力（`Unsupported`）、被用户停用。
 * 这些错误对用户是一句看不懂的英文，而且发生在点了翻译之后。
 *
 * 判据此前有 5 处各自实现（2 处带 `enabled`、3 处不带），UI 与运行时因此会判出
 * 不同集合 —— 本文件锁的是「只有一套判据」。
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TRANSLATION_AGENT_ID,
  isTranslatableAgent,
  isTranslationAgentStale,
  resolveTranslationAgentId,
  translatableAgents,
} from '../agents';

const chat = { transport: 'sdk' };
const agents = [
  { id: 'claude-code', chat },
  { id: 'opencode', chat },
  { id: 'cli-only' }, // 无 chat → 不可翻译
  { id: 'disabled', chat, enabled: false }, // 被停用 → 不可翻译
];

describe('isTranslatableAgent', () => {
  it('should accept an enabled agent with chat capability', () => {
    expect(isTranslatableAgent({ id: 'a', chat })).toBe(true);
  });

  it('should reject an agent without chat capability', () => {
    expect(isTranslatableAgent({ id: 'a' })).toBe(false);
  });

  /** 停用的 agent 不得出现在翻译入口里 —— 判据必须与运行时一致。 */
  it('should reject a disabled agent even when it has chat capability', () => {
    expect(isTranslatableAgent({ id: 'a', chat, enabled: false })).toBe(false);
  });

  /** 历史配置没有 `enabled` 字段，缺省视为启用。 */
  it('should treat a missing enabled flag as enabled', () => {
    expect(isTranslatableAgent({ id: 'a', chat, enabled: undefined })).toBe(true);
  });
});

describe('translatableAgents', () => {
  it('should filter out agents that cannot translate', () => {
    expect(translatableAgents(agents).map((a) => a.id)).toEqual(['claude-code', 'opencode']);
  });
});

describe('resolveTranslationAgentId', () => {
  it('should keep the configured agent when it is still usable', () => {
    expect(resolveTranslationAgentId('opencode', agents)).toBe('opencode');
  });

  it('should fall back when the configured agent no longer exists', () => {
    expect(resolveTranslationAgentId('deleted-agent', agents)).toBe('claude-code');
  });

  /** 配置指向一个只剩 CLI 能力的 agent：回落，而不是下发一个必然 Unsupported 的 id。 */
  it('should fall back when the configured agent lost chat capability', () => {
    expect(resolveTranslationAgentId('cli-only', agents)).toBe('claude-code');
  });

  it('should fall back when the configured agent is disabled', () => {
    expect(resolveTranslationAgentId('disabled', agents)).toBe('claude-code');
  });

  it('should fall back when nothing is configured', () => {
    expect(resolveTranslationAgentId(undefined, agents)).toBe('claude-code');
    expect(resolveTranslationAgentId(null, agents)).toBe('claude-code');
    expect(resolveTranslationAgentId('', agents)).toBe('claude-code');
  });

  /**
   * 一个可用 agent 都没有时回落到常量，而不是编造。
   * 让后端给出明确的 Unsupported 错误，比前端猜一个 id 更容易排查。
   */
  it('should fall back to the documented default when nothing is available', () => {
    expect(resolveTranslationAgentId('whatever', [])).toBe(DEFAULT_TRANSLATION_AGENT_ID);
  });
});

describe('isTranslationAgentStale', () => {
  it('should report a deleted agent as stale', () => {
    expect(isTranslationAgentStale('deleted-agent', agents)).toBe(true);
  });

  /** 与 resolve 同源：只剩 CLI 能力的 agent 同样算陈旧。 */
  it('should report an agent without chat capability as stale', () => {
    expect(isTranslationAgentStale('cli-only', agents)).toBe(true);
  });

  it('should report a disabled agent as stale', () => {
    expect(isTranslationAgentStale('disabled', agents)).toBe(true);
  });

  it('should not report a usable agent as stale', () => {
    expect(isTranslationAgentStale('opencode', agents)).toBe(false);
  });

  it('should not report an unset value as stale', () => {
    expect(isTranslationAgentStale(undefined, agents)).toBe(false);
    expect(isTranslationAgentStale('', agents)).toBe(false);
  });
});
