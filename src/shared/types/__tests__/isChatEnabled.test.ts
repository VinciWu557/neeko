import { describe, expect, it } from 'vitest';

import { agentCapabilities, isChatEnabled, type AgentConfig } from '@/shared/types/agent';

/**
 * `isChatEnabled` 是「这个 agent 现在能不能聊」的**唯一**判据。
 *
 * 与后端 `AgentConfig::is_chat_agent()` 逐字对齐：
 * `chat.is_some() && chat_enabled != Some(false)`。
 */

function agent(patch: Partial<AgentConfig>): AgentConfig {
  return {
    id: 'x',
    name: 'X',
    command: 'x',
    args: [],
    env: {},
    enabled: true,
    ...patch,
  };
}

const CHAT = { args: ['acp'] };

describe('isChatEnabled', () => {
  it('follows the factory default when chat_enabled is absent', () => {
    expect(isChatEnabled(agent({ chat: CHAT }))).toBe(true);
  });

  it('treats chat_enabled: null as "follow the factory default"', () => {
    expect(isChatEnabled(agent({ chat: CHAT, chat_enabled: null }))).toBe(true);
  });

  it('honours an explicit opt-out', () => {
    expect(isChatEnabled(agent({ chat: CHAT, chat_enabled: false }))).toBe(false);
  });

  it('cannot manufacture a capability out of a preference', () => {
    // 没有 chat 就是没有 —— `chat_enabled: true` 不能凭空造出能力。
    expect(isChatEnabled(agent({ chat: null, chat_enabled: true }))).toBe(false);
  });

  it('is what agentCapabilities reports for chat', () => {
    // 徽标与列表必须同源；`Boolean(agent.chat)` 会让关掉的 chat 仍显示为可用。
    expect(agentCapabilities(agent({ chat: CHAT, chat_enabled: false })).chat).toBe(false);
    expect(agentCapabilities(agent({ chat: CHAT })).chat).toBe(true);
  });
});
