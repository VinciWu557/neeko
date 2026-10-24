import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { saveAgent } from '@/features/agent/api/agentApi';
import type { AgentConfig, AppConfig } from '@/shared/types';
import { createAgent } from '@/testing/factories';

import { useSettingsPanelState } from '../useSettingsPanelState';

vi.mock('@/features/agent/api/agentApi', () => ({
  saveAgent: vi.fn().mockResolvedValue(undefined),
  resetAgent: vi.fn().mockResolvedValue(undefined),
}));

/**
 * 行内启停开关的**策略收口**测试：写路径分派（内置 → 覆盖层 / 自定义 → 直存）
 * 与错误策略（失败 catch + console.error，不上抛）都住在 hook 里 ——
 * section 只报告意图，不持策略。
 */

function setup() {
  return renderHook(() =>
    useSettingsPanelState({
      config: {} as AppConfig,
      activeNav: 'agents',
      builtinAgents: [],
      onConfigChange: vi.fn(),
      onClose: vi.fn(),
    }),
  );
}

describe('useSettingsPanelState.setAgentEnabled', () => {
  beforeEach(() => {
    vi.mocked(saveAgent).mockClear();
    vi.mocked(saveAgent).mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('routes a builtin toggle through the override save path', async () => {
    const { result } = setup();
    const agent = createAgent({ id: 'claude-code', is_builtin: true });

    await act(() => result.current.setAgentEnabled(agent, false));

    expect(saveAgent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'claude-code', enabled: false, is_builtin: true }),
    );
  });

  it('routes a custom toggle through the plain save path', async () => {
    const { result } = setup();
    const agent = createAgent({ id: 'custom:oc', is_builtin: false });

    await act(() => result.current.setAgentEnabled(agent, true));

    const saved = vi.mocked(saveAgent).mock.calls[0]?.[0] as AgentConfig;
    expect(saved.enabled).toBe(true);
    // 内置身份不得被开关翻转伪造。
    expect(saved.is_builtin).toBe(false);
  });

  it('swallows save failures with a console record instead of rejecting', async () => {
    vi.mocked(saveAgent).mockRejectedValueOnce(new Error('boom'));
    const { result } = setup();
    const agent = createAgent({ id: 'custom:oc', is_builtin: false });

    // 不上抛 —— 行开关处 void 消费是安全的（策略在 hook 收口）。
    await act(() => result.current.setAgentEnabled(agent, false));

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to toggle agent'),
      expect.any(Error),
    );
  });
});
