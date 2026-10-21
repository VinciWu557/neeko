import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ModelInfo } from '@/features/agent/api/agentApi';
import { AGENT_CHAT_EVENT } from '@/shared/events';
import { useEditorStore } from '@/shared/store/editorStore';
import type { SequencedEvent } from '@/shared/types/agentChat';
import type { AgentChatTabData } from '@/shared/types/tab';
import { safeUnlisten } from '@/shared/utils/safeUnlisten';
import type { ProjectId } from '@/shared/utils/workspaceRef';

import {
  approveAgentCall,
  cancelAgentStream,
  sendAgentInput,
  startAgentChat,
} from '../api/agentChatApi';
import { loadCachedMessages } from '../components/messageCache';
import {
  appendDelta,
  clipToolOutput,
  nextBlockId,
  nextMsgId,
  type ChatMessage,
  type ContextWindow,
  type CtxInfo,
  type PendingUserInput,
} from '../components/messageModel';
import type { PendingApproval, ToolCard, WorkedSummary } from '../types';
import { formatChatTime } from '../utils/chatFormat';
import { normalizeToolName } from '../utils/toolNames';

import { appendBlock, appendCommandBlock, attachFileDiff, findToolBlock } from './streamReducers';
import { useAgentSessionLifecycle } from './useAgentSessionLifecycle';
import { useChatAgents } from './useChatAgents';
import { useChatAttachments } from './useChatAttachments';
import { useChatRestore } from './useChatRestore';
import { useDeltaBatcher, type PendingDelta } from './useDeltaBatcher';
import { useMessagesCacheSync } from './useMessagesCacheSync';
import { useMockEventSchedule } from './useMockEventSchedule';
import { useModelSelection } from './useModelSelection';
import { usePendingEventDrain } from './usePendingEventDrain';
import { useSessionConfigOptions } from './useSessionConfigOptions';
import { useVisibleChatSession } from './useVisibleChatSession';

export interface UseAgentChatParams {
  tabKey: string;
  tabId: string;
  projectId: ProjectId;
  data: AgentChatTabData;
  /** 是否启用 mock 模式（开发/演示用）。 */
  mockMode: boolean;
}

/**
 * Agent Chat 数据流域 hook —— 会话状态、事件流处理与后端交互的唯一入口。
 * 组件层（AgentChatTabView）只保留 DOM refs、滚动跟随与 JSX 布局。
 */
export function useAgentChat({ tabKey, tabId, projectId, data, mockMode }: UseAgentChatParams) {
  const { agentId, sessionId: initialSessionId } = data;
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadCachedMessages(tabId) ?? []);

  // 流式增量 rAF 批处理：text/reasoning delta 合并为一个动画帧 flush，避免逐 token 全量 setState
  const { push: pushDelta, flush: flushDeltas } = useDeltaBatcher(
    useCallback((deltas: PendingDelta[]) => {
      setMessages((prev) => {
        let next = prev;
        for (const d of deltas) {
          next = appendDelta(next, d.kind, d.delta);
        }
        return next;
      });
    }, []),
  );
  const [input, setInput] = useState('');
  const {
    attachments,
    fileCount,
    skillCount,
    addFile,
    remove: removeAttachment,
    toRequestFiles,
  } = useChatAttachments();
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [pendingUserInput, setPendingUserInput] = useState<PendingUserInput | null>(null);
  const [streaming, setStreaming] = useState(false);
  // 可对话 agent 列表 + 选中项派生（只读，与消息流无关）。
  const { chatAgents, selectedAgent } = useChatAgents(agentId);
  const [selectedModel, setSelectedModel] = useState<ModelInfo | null>(null);
  const {
    options: sessionConfigOptions,
    view: sessionConfigView,
    replace: replaceConfigOptions,
    applySessionStart,
    setOption: setConfigOption,
    reset: resetConfigOptions,
  } = useSessionConfigOptions(() => sessionIdRef.current);
  /** 工作目录：后端 `AgentContext.project_id` 即项目绝对路径（cwd）。 */
  const [ctxInfo, setCtxInfo] = useState<CtxInfo | null>(null);
  const [proposedPlan, setProposedPlan] = useState<string | null>(null);
  const [contextWindow, setContextWindow] = useState<ContextWindow | null>(null);

  // 切换 **agent** 时清空 sessionId：复用旧会话会把新 agent 的请求路由过去
  // ——日志实证：agent 切到 opencode 后 agent_stream 仍继续了 mockAgent 的旧会话。
  //
  // **模型变化不清空**，两个理由：
  //
  // 1. 切模型有自己的通道：`modelId` 随 `Turn` 传给后端（`agent_stream` 的
  //    `req.model_id`），后端走 `SetConfigOption` 在同一会话内切换。换会话
  //    既非必要，也会丢掉已经积累的上下文。
  // 2. 清空会被「自动落位」误触发：`SessionStart` 带 `config_options`（模型列表），
  //    首次到达时 `useSelectedModelSync` 会把它填成首个模型 —— 若把模型纳入
  //    清空判据，这第一次自动选中就会把刚拿到的 `sessionId` 清掉，于是后续
  //    所有 `text_delta` 都因 sid 不匹配被丢弃，界面停在 thinking。
  //    （ACP 侥幸没踩到：它的 `SessionStart` 早于 sid 赋值到达。）
  // 消息缓存同步 / 通知可见性事实源上报（两个单职责小 hook，见各自文件头）。
  useMessagesCacheSync(tabId, messages);
  useVisibleChatSession(data.sessionId);

  // 暂存/消费「会话 id 赋值之前到达」的事件（见该 hook 文档）。
  const { buffer: bufferPending, drain: drainPending, setApplier } = usePendingEventDrain();

  // 会话生命周期（agent 变了就换会话 + 预开静默会话）抽成子 hook：
  // 本文件贴着组件规模 ratchet 线，且那段逻辑与消息流无耦合。
  const { sessionIdRef, primeAgentBaseline } = useAgentSessionLifecycle({
    agentId,
    projectId,
    tabKey,
    tabId,
    initialSessionId,
    modelId: selectedModel?.id,
    onAgentChanged: resetConfigOptions,
    flushPendingEvents: drainPending,
  });

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const turnStartRef = useRef<number | null>(null);
  const turnCountsRef = useRef({ ran: 0, edited: 0, searched: 0 });
  const turnToolsRef = useRef<ToolCard[]>([]);
  const approvalSeqRef = useRef(0);
  const autoApproveToolsRef = useRef<Set<string>>(new Set());

  // 模型列表 + 双向同步（UI→会话 下发 / 会话→UI 跟随）整体收在一个 hook 里。
  const { models, selectModel } = useModelSelection({
    agentId,
    sessionConfigOptions,
    selectedModel,
    setSelectedModel,
    setConfigOption,
  });

  const applyEvent = useCallback(
    (seqEv: SequencedEvent) => {
      const ev = seqEv;
      switch (ev.type) {
        case 'session_start':
          applySessionStart(ev.capabilities.config, ev.config_options);
          break;
        case 'config_option_update':
          // agent 主动变更（如 rate limit fallback 换模型）。协议要求视为**全量**：
          // 整体替换，不做局部 patch —— 换模型可能连带改变 thought_level 的可选项，
          // 局部更新会留下陈旧选项。
          replaceConfigOptions(ev.config_options);
          break;
        case 'context_init':
          setCtxInfo({
            projectName: ev.project_name,
            env: ev.env,
            projectPath: ev.project_id,
          });
          break;
        case 'turn_start':
          flushDeltas();
          turnStartRef.current = Date.now();
          turnCountsRef.current = { ran: 0, edited: 0, searched: 0 };
          turnToolsRef.current = [];
          break;
        case 'text_delta':
          // 累积到 rAF 批处理 buffer，动画帧内一次性 flush
          pushDelta('text', ev.delta);
          break;
        case 'reasoning_delta':
          pushDelta('reasoning', ev.delta);
          break;
        case 'tool_start': {
          // 先冲刷滞留在 rAF 批处理 buffer 中的文本增量，再追加工具块：
          // 保持「先输出意图 → 再执行工具」的流式时序（后端一次 burst 连发时，
          // 文本 delta 尚未到动画帧 flush，若不冲刷会出现「工具在前、文本在后」）。
          flushDeltas();
          // 去重：同一 callId 可能因后端重复 ToolStart（如 opencode serve 的
          // pending + running）而到达两次。话轮内已记工具（turnToolsRef）已含该
          // callId 即视为重复，忽略本次，避免同一任务渲染成两行。
          const alreadySeen = turnToolsRef.current.some((t) => t.callId === ev.call_id);
          if (alreadySeen) {
            break;
          }
          // 工具名归一化：opencode 等框架的原始名（edit/read/exec_command…）
          // 对齐标准名，保证 WorkRows 卡片分派与话轮计数在 live 流和历史
          // 恢复（historyConvert）两条链路行为一致。
          const normName = normalizeToolName(ev.name);
          const tool: ToolCard = {
            callId: ev.call_id,
            name: normName,
            title: ev.title,
            status: 'running',
          };
          if (normName === 'read_file' || normName === 'search' || normName === 'grep') {
            turnCountsRef.current.searched += 1;
          } else if (normName === 'edit_file' || normName === 'write_file') {
            turnCountsRef.current.edited += 1;
          } else {
            turnCountsRef.current.ran += 1;
          }
          turnToolsRef.current.push(tool);
          // 按时序追加 tool block：末尾消息是 assistant 则追加，否则新建消息
          setMessages((prev) =>
            appendBlock(prev, {
              kind: 'tool',
              id: nextBlockId(),
              tool,
            }),
          );
          break;
        }
        case 'tool_output':
          // 跨消息查找对应 tool block 并累积 output
          setMessages((prev) => {
            const found = findToolBlock(prev, ev.call_id);
            if (!found) return prev;
            return prev.map((m, i) =>
              i === found.msgIndex
                ? {
                    ...m,
                    blocks: m.blocks.map((b, j) =>
                      j === found.blockIndex && b.kind === 'tool'
                        ? {
                            ...b,
                            tool: { ...b.tool, output: clipToolOutput(b.tool.output, ev.output) },
                          }
                        : b,
                    ),
                  }
                : m,
            );
          });
          break;
        case 'tool_end':
          // 跨消息查找对应 tool block 并更新 status
          setMessages((prev) => {
            const found = findToolBlock(prev, ev.call_id);
            if (!found) return prev;
            return prev.map((m, i) =>
              i === found.msgIndex
                ? {
                    ...m,
                    blocks: m.blocks.map((b, j) =>
                      j === found.blockIndex && b.kind === 'tool'
                        ? {
                            ...b,
                            tool: {
                              ...b.tool,
                              status: ev.status === 'failed' ? 'failed' : 'done',
                            },
                          }
                        : b,
                    ),
                  }
                : m,
            );
          });
          break;
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
          break;
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
          break;
        case 'file_diff':
          // 保持时序：追加 diff 块前先冲刷文本增量。
          flushDeltas();
          setMessages((prev) => attachFileDiff(prev, ev.path, ev.diff));
          break;
        case 'request_approval':
          approvalSeqRef.current += 1;
          if (autoApproveToolsRef.current.has(ev.tool)) {
            void (async () => {
              const sid = sessionIdRef.current;
              if (!sid) return;
              try {
                await approveAgentCall(sid, ev.call_id, true);
              } catch {
                /* auto-approve failed; ignore */
              }
            })();
            break;
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
          break;
        case 'user_input':
          setPendingUserInput({ turnId: ev.turn_id, prompt: ev.prompt, options: ev.options });
          break;
        case 'proposed_plan':
          setProposedPlan(ev.plan);
          break;
        case 'meta':
          if (ev.usage) {
            setContextWindow({
              used: ev.usage.input_tokens ?? 0,
              total: (ev.usage.input_tokens ?? 0) + (ev.usage.output_tokens ?? 0),
              model: ev.model ?? 'unknown',
            });
          }
          break;
        case 'turn_end':
          flushDeltas();
          setStreaming(false);
          // 把所有 running 状态的 tool block 标记为 done
          setMessages((prev) =>
            prev.map((m) => ({
              ...m,
              blocks: m.blocks.map((b) =>
                b.kind === 'tool' && b.tool.status === 'running'
                  ? { ...b, tool: { ...b.tool, status: 'done' } }
                  : b,
              ),
            })),
          );
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
          break;
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
          break;
        case 'error':
          flushDeltas();
          setStreaming(false);
          setMessages((prev) => [
            ...prev,
            {
              id: nextMsgId(),
              role: 'system',
              blocks: [{ kind: 'text', id: nextBlockId(), text: `⚠ ${ev.message} (${ev.code})` }],
            },
          ]);
          break;
        default:
          break;
      }
    },
    [flushDeltas, pushDelta, replaceConfigOptions, applySessionStart],
  );

  // 让 `flushPendingEvents`（定义在前）总能拿到最新的 applyEvent。
  // 必须放 effect 里：渲染期调用副作用在 StrictMode 下会执行两次，且将来
  // 若 `setApplier` 内部加了 setState，就变成实质的渲染期写状态。
  useEffect(() => {
    setApplier(applyEvent);
  }, [applyEvent, setApplier]);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      // 方案 B1（合帧）：Rust 侧 bridge 按 16ms 窗口聚合 emit 数组（一次事件
      // = 一次 evaluateJavaScript，macOS 上 Tauri 事件送达即 eval），payload
      // 可能为 SequencedEvent[]（合帧）或单条 SequencedEvent（错误/边界），
      // 这里统一归一为数组顺序应用（reducer 按 seq 幂等，顺序即正确时序）。
      const unlisten = await listen<SequencedEvent[] | SequencedEvent>(
        AGENT_CHAT_EVENT,
        (event) => {
          const evs = Array.isArray(event.payload) ? event.payload : [event.payload];
          for (const seqEv of evs) {
            const sid = sessionIdRef.current;
            if (sid) {
              if (seqEv.session_id === sid) applyEvent(seqEv);
            } else {
              bufferPending(seqEv);
            }
          }
        },
      );
      if (disposed) {
        safeUnlisten(unlisten)();
      } else {
        unlistenRef.current = safeUnlisten(unlisten);
      }
    })();
    return () => {
      disposed = true;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, [applyEvent]);

  // Mock 模式：模拟 agent loop 的事件序列（开发/演示用）
  // 真实 agent 中文本和工具调用是穿插进行的：
  //   思考 → 输出文本 → 调用工具A → 处理结果 → 继续输出 → 调用工具B → ...
  // Mock 模式启动时标记 streaming
  useEffect(() => {
    if (mockMode) setStreaming(true);
  }, [mockMode]);

  // Mock 模式：开发/演示用事件序列（与真实流共用 applyEvent reducer）
  useMockEventSchedule({
    mockMode,
    sessionId: data.sessionId,
    projectId,
    applyEvent,
    sessionIdRef,
    turnStartRef,
    turnCountsRef,
    turnToolsRef,
  });

  useEffect(() => {
    return () => {
      const sid = sessionIdRef.current;
      if (sid) {
        void cancelAgentStream(sid).catch(() => undefined);
      }
    };
  }, []);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setMessages((prev) => [
      ...prev,
      {
        id: nextMsgId(),
        role: 'user',
        blocks: [{ kind: 'text' as const, id: nextBlockId(), text }],
        ts: formatChatTime(new Date()),
      },
    ]);
    setInput('');
    setStreaming(true);
    turnStartRef.current = Date.now();
    turnCountsRef.current = { ran: 0, edited: 0, searched: 0 };
    turnToolsRef.current = [];
    try {
      // 附件 → 请求字段的映射只有一处（`useChatAttachments.toRequestFiles`）：
      // 文件取 `id`（路径），skill 取 `name`。消费侧不要再自己拼。
      const { files, skills } = toRequestFiles();
      const sid = await startAgentChat({
        agentId: selectedAgent.id,
        projectId,
        prompt: text,
        files,
        skills,
        mode: 'auto',
        sessionId: sessionIdRef.current,
        modelId: selectedModel?.id,
      });
      sessionIdRef.current = sid;
      useEditorStore.getState().updateTab(tabKey, tabId, { sessionId: sid });
      drainPending(sid);
    } catch (err) {
      setStreaming(false);
      setMessages((prev) => [
        ...prev,
        {
          id: nextMsgId(),
          role: 'system',
          blocks: [
            {
              kind: 'text' as const,
              id: nextBlockId(),
              text: `⚠ 启动会话失败: ${String(err)}`,
            },
          ],
        },
      ]);
    }
  }, [
    input,
    streaming,
    selectedAgent.id,
    projectId,
    // 附件不再直接作为依赖：请求字段由 `toRequestFiles` 产出，它是唯一读点。
    toRequestFiles,
    tabKey,
    tabId,
    applyEvent,
    selectedModel,
  ]);

  const handleApproval = useCallback(
    async (allow: boolean) => {
      const pending = pendingApproval;
      if (!pending) return;
      setPendingApproval(null);
      const sid = sessionIdRef.current;
      if (!sid) return;
      try {
        await approveAgentCall(sid, pending.callId, allow);
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            id: nextMsgId(),
            role: 'system',
            blocks: [
              {
                kind: 'text' as const,
                id: nextBlockId(),
                text: `⚠ 审批失败: ${String(err)}`,
              },
            ],
          },
        ]);
      }
    },
    [pendingApproval],
  );

  const handleAllowSession = useCallback(() => {
    const pending = pendingApproval;
    if (!pending) return;
    autoApproveToolsRef.current.add(pending.tool);
    setPendingApproval(null);
    void handleApproval(true);
  }, [pendingApproval, handleApproval]);

  const handleCancelTurn = useCallback(() => {
    setPendingApproval(null);
    setPendingUserInput(null);
    setStreaming(false);
    const sid = sessionIdRef.current;
    if (sid) {
      void cancelAgentStream(sid).catch(() => undefined);
    }
  }, []);

  const handleUserInput = useCallback(
    async (text: string) => {
      const pending = pendingUserInput;
      if (!pending) return;
      setPendingUserInput(null);
      const sid = sessionIdRef.current;
      if (!sid) return;
      try {
        await sendAgentInput(sid, pending.turnId, text);
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            id: nextMsgId(),
            role: 'system',
            blocks: [
              {
                kind: 'text' as const,
                id: nextBlockId(),
                text: `⚠ 发送澄清失败: ${String(err)}`,
              },
            ],
          },
        ]);
      }
    },
    [pendingUserInput],
  );

  const handleStop = useCallback(() => {
    const sid = sessionIdRef.current;
    if (sid) {
      void cancelAgentStream(sid).catch(() => undefined);
      setStreaming(false);
    }
  }, []);

  // ── 会话恢复（历史列表 + 恢复执行 + Histor 入口一次性恢复）─────────────
  // 整组抽成子 hook：它与消息流只有「写 messages / 设 sessionId」两个接触点。
  const { resumableList, resumableLoading, loadResumableList, restoreConversation } =
    useChatRestore({
      projectId,
      tabKey,
      tabId,
      fallbackAgentId: selectedAgent.id,
      resumeConversationId: data.resumeConversationId,
      resumeNativeSessionId: data.resumeNativeSessionId,
      messageCount: messages.length,
      setMessages,
      setSelectedModel,
      sessionIdRef,
      primeAgentBaseline,
    });

  return {
    // 会话状态
    messages,
    streaming,
    pendingApproval,
    pendingUserInput,
    proposedPlan,
    contextWindow,
    ctxInfo,
    // composer 态
    input,
    setInput,
    attachments,
    removeAttachment,
    addAttachment: addFile,
    fileCount,
    skillCount,
    // agent/model 选择态
    chatAgents,
    models,
    selectedModel,
    setSelectedModel,
    selectModel,
    sessionConfigOptions,
    sessionConfigView,
    handleSetConfigOption: setConfigOption,
    selectedAgent,
    // actions
    handleSend,
    handleApproval,
    handleAllowSession,
    handleCancelTurn,
    handleUserInput,
    handleStop,
    // 会话恢复（方案 C+）
    resumableList,
    resumableLoading,
    loadResumableList,
    restoreConversation,
  };
}
