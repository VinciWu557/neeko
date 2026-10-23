import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AgentConfig } from '@/shared/types';

import AgentForm from '../AgentForm';

/**
 * `List Models Args` 与**会话内模型能力**互斥。
 *
 * # 为什么这是 bug 而不是风格问题
 *
 * spec `agent-chat-transports.md` §10.5b 记录过实测事故：声明了
 * `ConfigCapability::SessionConfig` 的传输（ACP / PiRpc）若同时填了
 * `model_list_args`，CLI 目录给出的是 `provider/model` 复合串，而写回
 * `set_config_option` 要裸名 —— 点选后报
 * `Model not found: provider/provider/model`。
 *
 * 表单原本把两个字段并排摆着，用户完全可能都填。这里断言**不渲染**。
 */

vi.mock('@/features/agent/api/agentApi', () => ({
  addAgent: vi.fn(),
  saveAgent: vi.fn(),
  resolveAgentIconSrc: () => null,
}));

function agent(patch: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'x',
    name: 'X',
    command: 'x',
    args: [],
    env: {},
    enabled: true,
    ...patch,
  } as AgentConfig;
}

function renderForm(patch: Partial<AgentConfig> = {}) {
  return render(<AgentForm initial={agent(patch)} onSaved={vi.fn()} onCancel={vi.fn()} />);
}

describe('List Models Args visibility', () => {
  /** ACP 是 `SessionConfig` —— 模型列表来自协议，CLI 旁路必须关闭。 */
  it('is hidden for an ACP chat launch', () => {
    renderForm({ chat: { args: ['acp'] } });

    // 标题仍显示（说明为什么没有输入框），但**输入控件**不渲染。
    expect(screen.queryByRole('group', { name: 'List Models Args' })).not.toBeInTheDocument();
    expect(screen.getByText(/from the agent protocol/i)).toBeInTheDocument();
  });

  it('is hidden for a pi rpc chat launch', () => {
    renderForm({ chat: { args: ['--mode', 'rpc'] } });

    expect(screen.queryByRole('group', { name: 'List Models Args' })).not.toBeInTheDocument();
  });

  /**
   * `serve`（opencode）是 `PerTurn`，不是 `SessionConfig` —— 它的 CLI 目录
   * （`models --verbose`）是**有效**的快速路径，输入框必须保留。
   *
   * 这条是「判据选错」的反例护栏：若门控误用 `shows_controls()`（`PerTurn`
   * 也为真），serve 的 CLI 旁路会被一并封掉，模型列表恒空。
   */
  it('is shown for a serve chat launch', () => {
    renderForm({ chat: { program: 'opencode', args: ['serve'] } });

    expect(screen.getByRole('group', { name: 'List Models Args' })).toBeInTheDocument();
  });

  it('is shown when there is no chat capability at all', () => {
    renderForm({ chat: null });

    expect(screen.getByRole('group', { name: 'List Models Args' })).toBeInTheDocument();
  });
});
