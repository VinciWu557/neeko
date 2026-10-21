import { ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { readDirTree } from '@/features/file/api/fileApi';
import { useProjectStore } from '@/shared/store/projectStore';
import { activeWorkspaceSession } from '@/shared/store/workspaceStore';
import type { FileNode } from '@/shared/types';
import type { AgentChatTabData } from '@/shared/types/tab';
import { ProjectId, WorkspaceSession } from '@/shared/utils/workspaceRef';

import { useAgentChat } from '../hooks/useAgentChat';
import { useAgentInputRegistration } from '../hooks/useAgentInputRegistration';
import { useOpenAgentFile } from '../hooks/useOpenAgentFile';

import ApprovalPanel from './ApprovalPanel';
import AttachFilePicker from './AttachFilePicker';
import ChatComposer from './ChatComposer';
import MessageList from './MessageList';
import ProposedPlanCard from './ProposedPlanCard';
import ResumeList from './ResumeList';
import UserInputPanel from './UserInputPanel';

export { clearMessageCache } from './messageCache';

interface AgentChatTabViewProps {
  tabKey: string;
  /** 本 tab 的 Workspace 地址本体（登记投递接收端用；不得从 tabKey 反解，红线 12）。 */
  session: WorkspaceSession;
  tabId: string;
  projectId: ProjectId;
  data: AgentChatTabData;
  /** 是否启用 mock 模式（开发/演示用）。 */
  mockMode?: boolean;
}

export default function AgentChatTabView({
  tabKey,
  session,
  tabId,
  projectId,
  data,
  mockMode = false,
}: AgentChatTabViewProps) {
  const {
    messages,
    streaming,
    pendingApproval,
    pendingUserInput,
    proposedPlan,
    contextWindow,
    ctxInfo,
    input,
    setInput,
    attachments,
    removeAttachment,
    addAttachment,
    fileCount,
    skillCount,
    chatAgents,
    models,
    selectedModel,
    selectModel,
    sessionConfigOptions,
    sessionConfigView,
    handleSetConfigOption,
    selectedAgent,
    handleSend,
    handleApproval,
    handleAllowSession,
    handleCancelTurn,
    handleUserInput,
    handleStop,
    resumableList,
    resumableLoading,
    loadResumableList,
    restoreConversation,
  } = useAgentChat({ tabKey, tabId, projectId, data, mockMode });

  // agent 消息里的文件路径拼根基准（相对路径拼**当前视图单元的工作树根**——见 openAgentFile）
  const projectPath = useProjectStore(
    (s) => s.projects.find((p) => p.id === projectId)?.path ?? '',
  );
  const [attachFiles, setAttachFiles] = useState<FileNode[]>([]);
  const [attachFilesLoading, setAttachFilesLoading] = useState(false);
  const [attachPickerOpen, setAttachPickerOpen] = useState(false);

  const chatEndRef = useRef<HTMLDivElement>(null);
  /// 滚动容器（.wa-chat）—— MessageList 虚拟器据此计算可见窗口
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  /// 程序化滚动保护 — 防止用户手动滚动时被自动跟随打断
  const programmaticScrollUntilRef = useRef(0);
  /// 上一条消息数量 — 仅真实消息变化时触发自动跟随
  const messageCountRef = useRef(0);

  const scrollToBottom = useCallback(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    // 自动跟随信号 — 仅基于真实消息变化（对齐 Synara §14.11）
    const currentCount = messages.length;
    const shouldFollow = currentCount > messageCountRef.current;
    messageCountRef.current = currentCount;

    if (shouldFollow) {
      // 程序化滚动保护窗口
      programmaticScrollUntilRef.current = Date.now() + 100;
      scrollToBottom();
    }
  }, [messages, scrollToBottom]);

  // 空会话态拉取可恢复列表（仅 opencode 类支持接续的 agent 有意义，失败静默）
  const emptyChat = messages.length === 0 && !streaming && !pendingApproval && !pendingUserInput;
  useEffect(() => {
    if (emptyChat) void loadResumableList();
  }, [emptyChat, loadResumableList]);

  /// 「恢复上次对话」列表展开状态 —— 开关并入 wa-sys 状态栏行（右侧按钮）。
  /// 默认折叠：新建 agent chat / 重新进入空会话态时保持收起。
  /// 用 render 期状态调整（React 官方模式）替代 effect，避免 setState-in-effect
  /// 级联渲染：仅在 emptyChat 由 false → true 时重置收起。
  const [resumeOpen, setResumeOpen] = useState(false);
  const [prevEmptyChat, setPrevEmptyChat] = useState(emptyChat);
  if (prevEmptyChat !== emptyChat) {
    setPrevEmptyChat(emptyChat);
    if (emptyChat) setResumeOpen(false);
  }

  // 登记本 composer 为 agent 投递的接收端（Q1=(a) · Q5=A，详见该 hook 的 docstring）。
  useAgentInputRegistration({ session, tabId, setInput });

  const openAgentFile = useOpenAgentFile({ projectId, projectPath });

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInput(e.target.value);
      const ta = e.target;
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    },
    [setInput],
  );

  /**
   * 「Attach files」按钮：读项目文件树并**打开选择弹窗**。
   *
   * 旧实现只把树读进 state、从不渲染，于是按钮点完毫无反应 —— 整条附件链路
   *（chips / 移除 / 随 prompt 发送）都在，唯独缺「选哪个文件」这一步。
   */
  const openAttachDrop = useCallback(() => {
    setAttachPickerOpen(true);
    if (attachFiles.length === 0 && !attachFilesLoading) {
      setAttachFilesLoading(true);
      void readDirTree(activeWorkspaceSession(projectId), null, 3)
        .then((result) => setAttachFiles(result.nodes))
        .catch(() => setAttachFiles([]))
        .finally(() => setAttachFilesLoading(false));
    }
  }, [projectId, attachFiles.length, attachFilesLoading]);

  const handlePickFile = useCallback(
    (file: FileNode) => {
      addAttachment(file.path, file.name);
      setAttachPickerOpen(false);
    },
    [addAttachment],
  );

  return (
    <div className="wa-root" data-testid="agent-chat-tab">
      <div className="wa-chat scrollbar" ref={chatScrollRef}>
        <div className="wa-inner">
          <div className="wa-sys" title={ctxInfo?.projectPath ?? ''}>
            <span className="sys-dot" />
            <span className="wa-sys-text">
              会话已开始 · 已注入上下文：{ctxInfo?.projectName ?? projectId}（
              {ctxInfo?.env ?? '本地'}）
              {ctxInfo?.projectPath ? (
                <>
                  {' · '}
                  <span className="wa-sys-cwd">{ctxInfo.projectPath}</span>
                </>
              ) : null}
              {attachments.length > 0 ? ` + ${skillCount} skills + ${fileCount} 文件附件` : ''}
            </span>
            {emptyChat && (
              <button
                type="button"
                className="resume-toggle"
                onClick={() => setResumeOpen((v) => !v)}
                aria-expanded={resumeOpen}
                aria-controls="resume-list"
                title={resumeOpen ? '收起最近会话' : '展开最近会话'}
              >
                <ChevronRight
                  size={12}
                  className={`resume-toggle-chevron${resumeOpen ? ' open' : ''}`}
                />
                <span>恢复上次对话</span>
              </button>
            )}
          </div>

          <MessageList messages={messages} onOpenFile={openAgentFile} scrollRef={chatScrollRef} />

          {emptyChat && resumeOpen && (
            <ResumeList
              items={resumableList}
              loading={resumableLoading}
              onRestore={(meta) => void restoreConversation(meta)}
            />
          )}

          {streaming && (
            <div className="working-indicator">
              <div className="working-dot" />
              <span>Thinking...</span>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>
      </div>

      {/* 审批 / 澄清 / 计划面板固定在滚动区外、composer 上方：
          长会话时不随消息流滚走，始终可见可决策 */}
      {pendingApproval && (
        <ApprovalPanel
          pending={pendingApproval}
          onApprove={(allow) => void handleApproval(allow)}
          onAllowSession={handleAllowSession}
          onCancelTurn={handleCancelTurn}
        />
      )}

      {pendingUserInput && (
        <UserInputPanel
          prompt={pendingUserInput.prompt}
          options={pendingUserInput.options ?? []}
          onSubmit={(selected) => void handleUserInput(selected[0] ?? '')}
        />
      )}

      {proposedPlan && <ProposedPlanCard plan={proposedPlan} />}

      <ChatComposer
        input={input}
        attachments={attachments}
        streaming={streaming}
        chatAgents={chatAgents}
        models={models}
        sessionConfigOptions={sessionConfigOptions}
        sessionConfigView={sessionConfigView}
        selectedModel={selectedModel}
        selectedAgent={selectedAgent}
        contextWindow={contextWindow}
        tabKey={tabKey}
        tabId={tabId}
        onInputChange={handleInputChange}
        onKeyDown={handleKeyDown}
        onSend={() => void handleSend()}
        onStop={handleStop}
        onRemoveAttachment={removeAttachment}
        onOpenAttachDrop={openAttachDrop}
        onModelChange={selectModel}
        onConfigChange={handleSetConfigOption}
      />
      {attachPickerOpen && (
        <AttachFilePicker
          files={attachFiles}
          loading={attachFilesLoading}
          attached={attachments.filter((a) => a.type === 'FILE').map((a) => a.id)}
          onPick={handlePickFile}
          onClose={() => setAttachPickerOpen(false)}
        />
      )}
    </div>
  );
}
