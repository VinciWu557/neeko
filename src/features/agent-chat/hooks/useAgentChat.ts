import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';

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
  nextBlockId,
  nextMsgId,
  type ChatMessage,
  type CtxInfo,
} from '../components/messageModel';
import type { PendingApproval } from '../types';
import { formatChatTime } from '../utils/chatFormat';

import { useAgentSessionLifecycle } from './useAgentSessionLifecycle';
import { useChatAgents } from './useChatAgents';
import { useChatAttachments } from './useChatAttachments';
import { useChatRestore } from './useChatRestore';
import { useDeltaBatcher, type PendingDelta } from './useDeltaBatcher';
import { useMessagesCacheSync } from './useMessagesCacheSync';
import { useMockEventSchedule } from './useMockEventSchedule';
import { useModelSelection } from './useModelSelection';
import { usePendingEventDrain } from './usePendingEventDrain';
import { useSelectedModel } from './useSelectedModel';
import { useSessionConfigOptions } from './useSessionConfigOptions';
import { useSessionLevelEvents } from './useSessionLevelEvents';
import { useTurnStream } from './useTurnStream';
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
  const { agentId, sessionId: initialSessionId, modelId: initialModelId } = data;
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
  const [streaming, setStreaming] = useState(false);
  // 可对话 agent 列表 + 选中项派生（只读，与消息流无关）。
  const { chatAgents, selectedAgent } = useChatAgents(agentId);
  // 选中模型的状态 + 跨 tab 切换持久化 + 切 agent 时的清理（见该 hook 文档）。
  const {
    selectedModel,
    setSelectedModel,
    clear: clearSelectedModel,
  } = useSelectedModel(tabKey, tabId, initialModelId);
  const {
    options: sessionConfigOptions,
    availability,
    commandsEnabled,
    replace: replaceConfigOptions,
    applySessionStart,
    setOption: setConfigOption,
    reset: resetConfigOptions,
  } = useSessionConfigOptions(() => sessionIdRef.current);
  /** 工作目录：后端 `AgentContext.project_id` 即项目绝对路径（cwd）。 */
  const [ctxInfo, setCtxInfo] = useState<CtxInfo | null>(null);

  // 系统消息追加内聚在 useSessionLevelEvents（唯一消费者）；这里传 state setter。
  const {
    handle: sessionLevelHandle,
    state: { pendingUserInput, setPendingUserInput, proposedPlan, contextWindow },
  } = useSessionLevelEvents({
    onContextInit: setCtxInfo,
    flushDeltas,
    setStreaming,
    setMessages,
  });

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
  // 消息缓存同步 / 通知可见性事实源上报（两个单职责小 hook，见各自文件头）。
  useMessagesCacheSync(tabId, messages);
  useVisibleChatSession(data.sessionId);

  // 暂存/消费「会话 id 赋值之前到达」的事件（见该 hook 文档）。
  const { buffer: bufferPending, drain: drainPending, setApplier } = usePendingEventDrain();

  // 会话生命周期（agent 变了就换会话 + 预开静默会话）抽成子 hook：
  // 本文件贴着 ratchet 线，且那段逻辑与消息流无耦合。落定后的 agent id 必须
  // 给生命周期与模型列表（`data.agentId` 新建 tab 时为空）。
  const settled = selectedAgent.id;
  // `useCallback` 必需：lifecycle 的切换 effect 把 `onAgentChanged` 排除在依赖外
  //（「由调用方保证稳定」）。内联箭头会让那条 effect 每渲染都跑一遍。
  const handleAgentChanged = useCallback(() => {
    resetConfigOptions();
    // 旧 agent 的模型 id 对新 agent 可能不存在，且会被当成 `modelId` 传给
    // `agent_chat_open`（ACP 在 create() 里预切）—— 必须一并丢掉。
    clearSelectedModel();
  }, [resetConfigOptions, clearSelectedModel]);
  const { sessionIdRef, primeAgentBaseline } = useAgentSessionLifecycle({
    agentId: settled,
    projectId,
    tabKey,
    tabId,
    initialSessionId,
    modelId: selectedModel?.id,
    onAgentChanged: handleAgentChanged,
    flushPendingEvents: drainPending,
  });

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const { models, selectModel } = useModelSelection({
    agentId: settled,
    sessionConfigOptions,
    availability,
    selectedModel,
    setSelectedModel,
    setConfigOption,
  });

  const turnStream = useTurnStream({
    setMessages,
    setStreaming,
    flushDeltas,
    pushDelta,
    setPendingApproval,
    sessionIdRef,
  });

  const applyEvent = useCallback(
    (seqEv: SequencedEvent) => {
      const ev = seqEv;
      // 话轮流（turn_* / tool_* / command_run / session_done）先处理。
      if (turnStream.handle(ev)) return;
      // 会话级状态（跨话轮存活）：上下文 / 用户输入 / 计划 / 用量 / 错误。
      if (sessionLevelHandle(ev)) return;
      switch (ev.type) {
        case 'session_start':
          // 整个能力快照（config + commands）的唯一消费点在 useSessionConfigOptions。
          applySessionStart(ev.capabilities, ev.config_options);
          break;
        case 'config_option_update':
          // agent 主动变更（如 rate limit fallback 换模型）。协议要求视为**全量**：
          // 整体替换，不做局部 patch —— 换模型可能连带改变 thought_level 的可选项。
          replaceConfigOptions(ev.config_options);
          break;
        default:
          break;
      }
    },
    // **依赖只允许稳定引用**（§15）：把 `sessionLevel` 整个容器放进来会让
    // `meta` 事件（每个话轮都发）触发 listen 重注册 —— 那正是「模型列表永久
    // 停在 loading」的成因。
    [replaceConfigOptions, applySessionStart, turnStream, sessionLevelHandle],
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
    turnStartRef: turnStream.refs.turnStart,
    turnCountsRef: turnStream.refs.turnCounts,
    turnToolsRef: turnStream.refs.turnTools,
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
    turnStream.reset();
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
    turnStream.autoApproveTools.current.add(pending.tool);
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
    /** 话轮账本 refs —— `useWorkingStatus`（回合指示器）读已进行时长与活动工具。 */
    turnStartRef: turnStream.refs.turnStart,
    turnToolsRef: turnStream.refs.turnTools,
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
    modelAvailability: availability,
    handleSetConfigOption: setConfigOption,
    commandsEnabled,
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
