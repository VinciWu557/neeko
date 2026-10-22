import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { SequencedEvent } from '@/shared/types/agentChat';

vi.mock('../../api/agentChatApi', () => ({
  approveAgentCall: vi.fn().mockResolvedValue(undefined),
}));

import type { ChatMessage } from '../../components/messageModel';
import { useTurnStream } from '../useTurnStream';

function setup() {
  const setMessages = vi.fn();
  const setStreaming = vi.fn();
  const flushDeltas = vi.fn();
  const pushDelta = vi.fn();
  const setPendingApproval = vi.fn();
  const sessionIdRef = { current: 'sid' as string | undefined };

  const hook = renderHook(() =>
    useTurnStream({
      setMessages,
      setStreaming,
      flushDeltas,
      pushDelta,
      setPendingApproval,
      sessionIdRef,
    }),
  );
  return {
    ...hook,
    spies: { setMessages, setStreaming, flushDeltas, pushDelta, setPendingApproval },
    sessionIdRef,
  };
}

const turnStart: SequencedEvent = {
  type: 'turn_start',
  session_id: 's',
  turn_id: 't',
  seq: 1,
} as SequencedEvent;

describe('useTurnStream — 已处理判定', () => {
  /**
   * `handle` 返回 `true` 表示「本 hook 已处理」，调用方据此跳过自己的 switch。
   *
   * 变异验证：把 `turn_start` 分支的 `return true` 改成 `return false`
   * → 本用例变红（`useAgentChat` 会重复处理）。
   */
  it('should claim the turn events it handles', () => {
    const { result } = setup();
    expect(result.current.handle(turnStart)).toBe(true);
  });

  /**
   * 不属于话轮流的事件必须交回调用方（`user_input` / `meta` / 上下文等留在
   * `useAgentChat`）。
   *
   * **这是拆分的正确性前提**：若本 hook 对未识别事件也返回 `true`，
   * 调用方那句 `if (turnStream.handle(ev)) return;` 会把这些事件整个吞掉 ——
   * 表现是「计划卡片不出现、用量表不更新」，且没有任何报错。
   *
   * 变异验证：把 `default` 改成 `return true` → 4 条用例同时变红
   * （所有非话轮事件都被吞）。
   */
  it.each([
    ['user_input', { turn_id: 't', prompt: 'p', options: [] }],
    ['meta', { model: 'm' }],
    ['session_start', { agent: 'a', capabilities: {} }],
    ['config_option_update', { config_options: [] }],
    ['context_init', { project_id: 'p' }],
  ])('should decline %s so the caller keeps handling it', (type, payload) => {
    const { result } = setup();
    const ev = { type, seq: 1, session_id: 's', ...payload } as unknown as SequencedEvent;
    expect(result.current.handle(ev)).toBe(false);
  });
});

describe('useTurnStream — 话轮账本', () => {
  /** `reset()` 清零三个账本（`handleSend` 每轮开始时调用）。 */
  it('should clear the turn books on reset', () => {
    const { result } = setup();
    act(() => {
      result.current.reset();
    });
    expect(result.current.refs.turnStart.current).not.toBeNull();
    expect(result.current.refs.turnCounts.current).toEqual({ ran: 0, edited: 0, searched: 0 });
    expect(result.current.refs.turnTools.current).toEqual([]);
  });

  /**
   * `turn_end` 把 running 的工具标记为 done 并追加 worked 摘要。
   *
   * 这是「话轮结束后卡片还在转圈」的直接成因，变异验证：删掉 setMessages
   * 的 map → 本用例变红。
   */
  it('should close running tools and append a worked summary on turn_end', () => {
    let messages: ChatMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        blocks: [
          {
            kind: 'tool',
            id: 'b1',
            tool: { callId: 'c1', name: 'read_file', title: 'r', status: 'running' },
          },
        ],
      },
    ];
    const setMessages = vi.fn((updater: unknown) => {
      messages =
        typeof updater === 'function'
          ? (updater as (p: ChatMessage[]) => ChatMessage[])(messages)
          : (updater as ChatMessage[]);
    });
    const { result } = renderHook(() =>
      useTurnStream({
        setMessages: setMessages as never,
        setStreaming: vi.fn(),
        flushDeltas: vi.fn(),
        pushDelta: vi.fn(),
        setPendingApproval: vi.fn(),
        sessionIdRef: { current: 'sid' },
      }),
    );

    act(() => {
      result.current.reset();
      result.current.handle(turnStart);
      result.current.handle({
        type: 'tool_start',
        session_id: 's',
        call_id: 'c1',
        name: 'read_file',
        title: 'r',
        seq: 2,
      } as SequencedEvent);
      result.current.handle({
        type: 'turn_end',
        session_id: 's',
        turn_id: 't',
        reason: 'completed',
        seq: 3,
      } as SequencedEvent);
    });

    const blocks = messages.flatMap((m) => m.blocks);
    const tool = blocks.find((b) => b.kind === 'tool');
    expect(tool && tool.kind === 'tool' ? tool.tool.status : null).toBe('done');
  });
});

describe('useTurnStream — 审批', () => {
  /** 不在 auto-approve 集合里 → 弹窗，序号递增。 */
  it('should raise a pending approval and bump the sequence', () => {
    const { result, spies } = setup();
    act(() => {
      result.current.handle({
        type: 'request_approval',
        session_id: 's',
        call_id: 'c1',
        tool: 'bash',
        title: 'run',
        prompt: 'go?',
        seq: 1,
      } as SequencedEvent);
    });
    expect(spies.setPendingApproval).toHaveBeenCalled();
    expect(result.current.approvalSeq.current).toBe(1);
  });

  /**
   * 「本会话内总是允许」→ 直接回写后端，**不弹窗**。
   *
   * 变异验证：去掉 `autoApproveTools.has` 分支 → 本用例变红。
   */
  it('should auto-approve without raising a panel when the tool is whitelisted', () => {
    const { result, spies } = setup();
    act(() => {
      result.current.autoApproveTools.current.add('bash');
      result.current.handle({
        type: 'request_approval',
        session_id: 's',
        call_id: 'c1',
        tool: 'bash',
        title: 'run',
        prompt: 'go?',
        seq: 1,
      } as SequencedEvent);
    });
    expect(spies.setPendingApproval).not.toHaveBeenCalled();
  });
});
