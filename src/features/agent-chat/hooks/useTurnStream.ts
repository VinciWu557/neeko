import { useCallback, useMemo, useRef } from 'react';

import type { SequencedEvent } from '@/shared/types/agentChat';

import { approveAgentCall } from '../api/agentChatApi';
import {
  clipToolOutput,
  nextBlockId,
  nextMsgId,
  type ChatMessage,
} from '../components/messageModel';
import type { PendingApproval, ToolCard, WorkedSummary } from '../types';
import { recordToolStart, type TurnCounts } from '../utils/toolTurnOps';

import {
  appendBlock,
  appendCommandBlock,
  attachFileDiff,
  closeRunningTools,
  updateToolBlock,
} from './streamReducers';

/**
 * 话轮流：`turn_start` → 工具三件套 → `turn_end` / `session_done` 的归约。
 *
 * 只关心「当前这一轮跑了什么」（计时、工具计数、worked 摘要），与会话配置项、
 * 上下文 manifest 正交。`turnStart`/`turnCounts`/`turnTools` 是内部账本；
 * `autoApproveTools` 例外 —— `handleAllowSession` 要往里写，由调用方持有。
 */
export interface TurnStream {
  /** 归约一条话轮事件。返回 `true` 表示本 hook 已处理。 */
  handle: (ev: SequencedEvent) => boolean;
  /** 开始新一轮：计时归零、计数清零、工具清空。 */
  reset: () => void;
  /** 「本会话内总是允许」的集合（`handleAllowSession` 写入）。 */
  autoApproveTools: React.MutableRefObject<Set<string>>;
  /** 审批序号（`request_approval` 递增）。 */
  approvalSeq: React.MutableRefObject<number>;
  /** 话轮内部账本，仅供 Mock 事件调度复用（它与真实流共用一个 reducer）。 */
  refs: {
    turnStart: React.MutableRefObject<number | null>;
    turnCounts: React.MutableRefObject<TurnCounts>;
    turnTools: React.MutableRefObject<ToolCard[]>;
  };
}

/** 归零的话轮计数。**每次新建对象** —— `turnCountsRef` 的值会被就地 `+=`。 */
function zeroCounts(): TurnCounts {
  return { ran: 0, edited: 0, searched: 0 };
}

export function useTurnStream(params: {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setStreaming: (value: boolean) => void;
  flushDeltas: () => void;
  pushDelta: (kind: 'text' | 'reasoning', delta: string) => void;
  setPendingApproval: (value: PendingApproval | null) => void;
  /** 当前会话 id（自动审批要直接回写后端，绕过 UI）。 */
  sessionIdRef: React.MutableRefObject<string | undefined>;
}): TurnStream {
  const { setMessages, setStreaming, flushDeltas, pushDelta, setPendingApproval, sessionIdRef } =
    params;

  const turnStartRef = useRef<number | null>(null);
  const turnCountsRef = useRef<TurnCounts>(zeroCounts());
  const turnToolsRef = useRef<ToolCard[]>([]);
  const approvalSeqRef = useRef(0);
  const autoApproveToolsRef = useRef<Set<string>>(new Set());

  /**
   * 开始新一轮：计时起算、计数归零、工具清空。
   *
   * 两个调用点都会发生：`handleSend`（本地乐观）+ `turn_start` 事件（后端确认）。
   * 双重重置是原实现的行为，保留它 —— 后端可能在 `handleSend` 之外开启话轮
   *（队列续跑、自动重试），那时只有事件路径会重置。代价是 `durationMs` 从
   * 事件起算而非点发送那一刻，差额为一次 IPC 往返。
   */
  const reset = useCallback(() => {
    turnStartRef.current = Date.now();
    turnCountsRef.current = zeroCounts();
    turnToolsRef.current = [];
  }, []);

  const handle = useCallback(
    (ev: SequencedEvent): boolean => {
      switch (ev.type) {
        case 'turn_start':
          flushDeltas();
          reset();
          return true;
        case 'text_delta':
          // 累积到 rAF 批处理 buffer，动画帧内一次性 flush
          pushDelta('text', ev.delta);
          return true;
        case 'reasoning_delta':
          pushDelta('reasoning', ev.delta);
          return true;
        case 'tool_start': {
          // 先冲刷滞留在 rAF 批处理 buffer 中的文本增量，再追加工具块：
          // 保持「先输出意图 → 再执行工具」的流式时序（后端一次 burst 连发时，
          // 文本 delta 尚未到动画帧 flush，若不冲刷会出现「工具在前、文本在后」）。
          flushDeltas();
          // 去重 + 计数归类是纯判定，收在 `toolTurnOps` 里（可穷举测试）。
          const tool = recordToolStart(
            ev.name,
            ev.call_id,
            ev.title,
            turnToolsRef.current,
            turnCountsRef.current,
          );
          if (!tool) return true;
          turnToolsRef.current.push(tool);
          // 按时序追加 tool block：末尾消息是 assistant 则追加，否则新建消息
          setMessages((prev) =>
            appendBlock(prev, {
              kind: 'tool',
              id: nextBlockId(),
              tool,
            }),
          );
          return true;
        }
        case 'tool_output':
          // 累积输出（跨消息定位由 `updateToolBlock` 负责，找不到原样返回）。
          setMessages((prev) =>
            updateToolBlock(prev, ev.call_id, (t) => ({
              ...t,
              output: clipToolOutput(t.output, ev.output),
            })),
          );
          return true;
        case 'tool_end':
          setMessages((prev) =>
            updateToolBlock(prev, ev.call_id, (t) => ({
              ...t,
              status: ev.status === 'failed' ? 'failed' : 'done',
            })),
          );
          return true;
        case 'command_run':
          // 同 tool_start：先冲刷文本增量，保证命令前的说明文本渲染在其卡片之前。
          flushDeltas();
          turnCountsRef.current.ran += 1;
          turnToolsRef.current.push({
            callId: ev.call_id,
            name: 'run_command',
            title: ev.cmd,
            status: 'running',
          });
          // 按时序追加 command tool block
          setMessages((prev) =>
            appendCommandBlock(prev, {
              kind: 'tool',
              id: nextBlockId(),
              tool: {
                callId: ev.call_id,
                name: 'run_command',
                title: ev.cmd,
                status: 'running',
              },
            }),
          );
          return true;
        case 'todo_updated':
          // 保持时序：追加非文本块前先冲刷文本增量。
          flushDeltas();
          // 按时序追加 todos block
          setMessages((prev) =>
            appendBlock(prev, {
              kind: 'todos',
              id: nextBlockId(),
              todos: ev.todos,
            }),
          );
          return true;
        case 'file_diff':
          // 保持时序：追加 diff 块前先冲刷文本增量。
          flushDeltas();
          setMessages((prev) => attachFileDiff(prev, ev.path, ev.diff));
          return true;
        case 'request_approval':
          approvalSeqRef.current += 1;
          if (autoApproveToolsRef.current.has(ev.tool)) {
            // 「本会话内总是允许」：直接回写后端，不弹窗。
            void (async () => {
              const sid = sessionIdRef.current;
              if (!sid) return;
              try {
                await approveAgentCall(sid, ev.call_id, true);
              } catch {
                /* auto-approve 失败不打断用户：这一轮会停在未审批状态，可手动重试 */
              }
            })();
            return true;
          }
          setPendingApproval({
            callId: ev.call_id,
            tool: ev.tool,
            title: ev.title,
            prompt: ev.prompt,
            diff: ev.diff,
            cmd: ev.cmd,
            index: approvalSeqRef.current,
            total: approvalSeqRef.current,
          });
          return true;
        case 'turn_end':
          flushDeltas();
          setStreaming(false);
          // 收尾 running 工具（纯 reducer，见 `closeRunningTools`）。
          setMessages(closeRunningTools);
          if (turnStartRef.current != null) {
            const durationMs = Date.now() - turnStartRef.current;
            const summary: WorkedSummary = {
              durationMs,
              ran: turnCountsRef.current.ran,
              edited: turnCountsRef.current.edited,
              searched: turnCountsRef.current.searched,
              tools: turnToolsRef.current.map((t) => ({
                ...t,
                status: t.status === 'failed' ? 'failed' : 'done',
              })),
            };
            turnStartRef.current = null;
            if (summary.tools.length > 0) {
              // 按时序追加 worked block
              setMessages((prev) =>
                appendBlock(prev, {
                  kind: 'worked',
                  id: nextBlockId(),
                  worked: summary,
                }),
              );
            }
          }
          return true;
        case 'session_done':
          flushDeltas();
          setStreaming(false);
          setMessages((prev) => [
            ...prev,
            {
              id: nextMsgId(),
              role: 'system',
              blocks: [{ kind: 'text', id: nextBlockId(), text: `会话已结束（${ev.reason}）` }],
            },
          ]);
          return true;
        default:
          return false;
      }
    },
    [setMessages, setStreaming, flushDeltas, pushDelta, setPendingApproval, sessionIdRef, reset],
  );

  // **必须是稳定引用**。曾直接返回对象字面量（注释说「memo 掉会掩盖 ref 才是
  // 稳定值这层事实」）—— 那个理由只对 `refs` 成立，对整个返回值是错的：
  //
  //   useTurnStream 返回新对象 → useAgentChat 的 applyEvent 依赖它（useCallback
  //   身份每渲染变）→ listen 的 useEffect 依赖 applyEvent → **每次渲染都
  //   unlisten + listen** → 最早到达的 `session_start` 落进这个窗口 → 前端永远
  //   收不到握手 → `handshaken` 恒 false → 模型列表永久停在
  //   "Models appear once the session is ready"（Pi 与 opencode 同时中招）。
  //
  // 依赖全是稳定值（useCallback / useRef），所以 memo 只会算一次。
  return useMemo(
    () => ({
      handle,
      reset,
      autoApproveTools: autoApproveToolsRef,
      approvalSeq: approvalSeqRef,
      refs: {
        turnStart: turnStartRef,
        turnCounts: turnCountsRef,
        turnTools: turnToolsRef,
      },
    }),
    [handle, reset],
  );
}
