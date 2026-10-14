import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PromptResource } from '@/shared/types/library';

import { useInsertPromptToWorkspace } from '../useInsertPromptToWorkspace';

const hoisted = vi.hoisted(() => ({
  toast: vi.fn(),
  clipboard: vi.fn(async (): Promise<boolean> => true),
  api: {
    current: {} as {
      insertToTerminal?: (t: string) => boolean;
      insertToAgentInput?: (t: string) => boolean;
    },
  },
}));

vi.mock('@/shared/contexts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/contexts')>();
  return {
    ...actual,
    useTerminalInsert: () => ({ api: hoisted.api.current, register: vi.fn(() => () => {}) }),
    useAppContext: () => ({ showToast: hoisted.toast }),
  };
});

vi.mock('@/shared/hooks/useCopyToClipboard', () => ({
  useCopyToClipboard: () => hoisted.clipboard,
}));

const prompt: PromptResource = {
  id: 'p1',
  name: 'Review',
  content: 'review this diff',
  description: null,
  tags: [],
  scope: 'global',
  favorite: false,
  usageCount: 0,
  createdAt: 0,
  updatedAt: 0,
};

/**
 * 投递语义（terminal → agent → clipboard）的唯一实现点：状态栏、Library 面板、
 * 全局宿主三条入口共用，故每个降级分支都必须有断言 —— 分支走错 = 用户看到的行为不同。
 */
describe('useInsertPromptToWorkspace', () => {
  beforeEach(() => {
    hoisted.api.current = {};
    hoisted.toast.mockClear();
    hoisted.clipboard.mockClear();
  });

  it('terminal 目标且终端可用：写终端 + 成功 toast，不碰 agent / clipboard', async () => {
    const insertToTerminal = vi.fn(() => true);
    const insertToAgentInput = vi.fn();
    hoisted.api.current = { insertToTerminal, insertToAgentInput };
    const { result } = renderHook(() => useInsertPromptToWorkspace());

    result.current(prompt, 'terminal');
    await vi.waitFor(() => expect(hoisted.toast).toHaveBeenCalledTimes(1));

    expect(insertToTerminal).toHaveBeenCalledWith('review this diff');
    expect(insertToAgentInput).not.toHaveBeenCalled();
    expect(hoisted.clipboard).not.toHaveBeenCalled();
    expect(hoisted.toast).toHaveBeenCalledWith('Inserted "Review" to terminal', 'info');
  });

  it('terminal 目标但无活动终端：提示降级并转投 agent 输入', () => {
    const insertToTerminal = vi.fn(() => false);
    // 返回 true = agent 真的接住了（旧用例写 `vi.fn()` 默认返回 undefined，
    // 在新语义下等价于「没落地」，会落进 clipboard 分支）。
    const insertToAgentInput = vi.fn(() => true);
    hoisted.api.current = { insertToTerminal, insertToAgentInput };
    const { result } = renderHook(() => useInsertPromptToWorkspace());

    result.current(prompt, 'terminal');

    expect(hoisted.toast).toHaveBeenCalledWith(
      'No active terminal — inserting to agent input',
      'info',
    );
    expect(insertToAgentInput).toHaveBeenCalledWith('review this diff');
    expect(hoisted.clipboard).not.toHaveBeenCalled();
  });

  it('agent 目标且 composer 接住：直接写 agent 输入，零 toast', () => {
    const insertToAgentInput = vi.fn(() => true);
    hoisted.api.current = { insertToAgentInput };
    const { result } = renderHook(() => useInsertPromptToWorkspace());

    result.current(prompt, 'agent');

    expect(insertToAgentInput).toHaveBeenCalledWith('review this diff');
    expect(hoisted.toast).not.toHaveBeenCalled();
  });

  /**
   * **本任务 defect 的显式反证**（PRD R6 / design §5.1）：`insertToAgentInput` 恒存在
   * （ProjectView 恒注册），但「无 agent-chat composer 且无 Agent CLI tab」时它返回 false。
   *
   * 旧实现判的是「函数存在吗」（恒真）而非「落地了吗」，于是连 clipboard 兜底都进不去、
   * 也不弹 toast —— 用户按 Enter 什么也没发生。本用例在修复前**必须先红**。
   */
  it('agent 函数存在但返回 false（无接收端）→ clipboard 兜底重新可达 + 提示', async () => {
    const insertToAgentInput = vi.fn(() => false);
    hoisted.api.current = { insertToAgentInput };
    const { result } = renderHook(() => useInsertPromptToWorkspace());

    result.current(prompt, 'agent');

    expect(insertToAgentInput).toHaveBeenCalledWith('review this diff');
    await vi.waitFor(() =>
      expect(hoisted.toast).toHaveBeenCalledWith('Prompt copied to clipboard', 'info'),
    );
    expect(hoisted.clipboard).toHaveBeenCalledWith('review this diff', 'prompt');
  });

  /** terminal 目标降级到 agent 后，agent 也没接住 → 仍必须落到 clipboard（不双重静默）。 */
  it('terminal 不可用 → agent 也不可用 → clipboard 兜底', async () => {
    hoisted.api.current = {
      insertToTerminal: vi.fn(() => false),
      insertToAgentInput: vi.fn(() => false),
    };
    const { result } = renderHook(() => useInsertPromptToWorkspace());

    result.current(prompt, 'terminal');

    await vi.waitFor(() =>
      expect(hoisted.clipboard).toHaveBeenCalledWith('review this diff', 'prompt'),
    );
  });

  /** agent 命中时不得再走 clipboard（双写 = 用户看到两份）。 */
  it('agent 返回 true → 不碰 clipboard', () => {
    hoisted.api.current = { insertToAgentInput: vi.fn(() => true) };
    const { result } = renderHook(() => useInsertPromptToWorkspace());

    result.current(prompt, 'agent');

    expect(hoisted.clipboard).not.toHaveBeenCalled();
  });

  it('既无终端也无 agent 输入：clipboard 兜底并提示', async () => {
    const { result } = renderHook(() => useInsertPromptToWorkspace());

    result.current(prompt, 'terminal');

    await vi.waitFor(() =>
      expect(hoisted.toast).toHaveBeenCalledWith('Prompt copied to clipboard', 'info'),
    );
    expect(hoisted.clipboard).toHaveBeenCalledWith('review this diff', 'prompt');
  });

  it('clipboard 也失败：不再补「已复制」提示（不误报成功）', async () => {
    hoisted.clipboard.mockImplementationOnce(async () => false);
    const { result } = renderHook(() => useInsertPromptToWorkspace());

    result.current(prompt);
    await new Promise((r) => setTimeout(r, 0));

    expect(hoisted.toast).not.toHaveBeenCalledWith('Prompt copied to clipboard', 'info');
  });

  it('默认目标是 agent（调用方省略 target 时不静默走终端）', () => {
    const insertToTerminal = vi.fn(() => true);
    const insertToAgentInput = vi.fn(() => true);
    hoisted.api.current = { insertToTerminal, insertToAgentInput };
    const { result } = renderHook(() => useInsertPromptToWorkspace());

    result.current(prompt);

    expect(insertToTerminal).not.toHaveBeenCalled();
    expect(insertToAgentInput).toHaveBeenCalledWith('review this diff');
  });
});
