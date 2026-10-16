import { Check, Copy } from 'lucide-react';
import React, { useState, useEffect, useRef } from 'react';

import { CloseIcon } from '@/shared/components/icons';
import { useTransientFlag } from '@/shared/hooks/useTransientFlag';
import type { EditorAction } from '@/shared/utils/agentPrompt';

/**
 * ✓ 反馈持续时长（ms）。
 *
 * 抽成导出常量而非本地字面量：该时长同时约束着实现与测试断言 —— 散成字面量时
 * 改时长必然漏改一处，而漏改不会被任何测试抓到（这正是仓库
 * `component-guidelines.md`「阈值导出为模块级常量，测试按常量断言」要求的形态）。
 */
export const COPIED_FEEDBACK_MS = 1500;

interface SelectionToolbarProps {
  visible: boolean;
  top: number;
  left: number;
  onAction: (action: EditorAction, question?: string) => void;
  /** 复制选中文本（剪贴板写入由宿主注入，组件零业务逻辑）。 */
  onCopySelection: () => void;
  onClose: () => void;
  needsAgentTab: boolean;
  agentName?: string;
  onCreateTab: () => void;
}

const SelectionToolbar: React.FC<SelectionToolbarProps> = ({
  visible,
  top,
  left,
  onAction,
  onCopySelection,
  onClose,
  needsAgentTab,
  agentName,
  onCreateTab,
}) => {
  const [showAskInput, setShowAskInput] = useState(false);
  const [askText, setAskText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Ask 输入态绑定「一次可见周期」：`visible` 翻 false 时组件只 return null（并未卸载），
  // state 原样保留 —— 不在这里复位，重新选中就会直接看到上一轮的 Ask 输入框
  // （违背「重新选中 = 回到动作按钮行」的操作习惯）。
  // 用 render 期重置（React 官方 "adjusting state when props change"）：同一渲染帧内同步
  // 清空并立刻用新 state 重渲染，不产生中间闪烁帧；故此处不写 effect ——
  // `react-hooks/set-state-in-effect` 是 error 级红线。
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    setShowAskInput(false);
    setAskText('');
  }

  useEffect(() => {
    if (showAskInput && inputRef.current) {
      inputRef.current.focus();
    }
  }, [showAskInput]);

  if (!visible) return null;

  const handleAskSend = () => {
    if (askText.trim()) {
      onAction('ask', askText.trim());
      setAskText('');
      setShowAskInput(false);
    }
  };

  return (
    <div className="fixed z-[9999]" style={{ top, left }}>
      {needsAgentTab ? (
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-bg-tertiary border border-border shadow-lg text-sm whitespace-nowrap">
          <span className="text-text-muted">No agent terminal open</span>
          <button
            className="px-2 py-0.5 rounded bg-accent-blue text-white text-xs font-medium hover:opacity-90 transition"
            onClick={onCreateTab}
          >
            Open {agentName || 'Agent'} Terminal
          </button>
          <CloseButton onClick={onClose} />
        </div>
      ) : showAskInput ? (
        <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-bg-tertiary border border-border shadow-lg">
          <input
            ref={inputRef}
            className="w-56 px-2 py-1 rounded bg-bg-secondary text-text-primary text-xs outline-none border border-border"
            placeholder="Ask about the selected code..."
            value={askText}
            onChange={(e) => setAskText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAskSend();
              if (e.key === 'Escape') setShowAskInput(false);
            }}
          />
          <button
            className="px-2 py-1 rounded bg-accent-blue text-white text-xs font-medium hover:opacity-90 transition"
            onClick={handleAskSend}
          >
            Send
          </button>
          <CloseButton onClick={onClose} />
        </div>
      ) : (
        <div className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-bg-tertiary border border-border shadow-lg">
          <ToolbarButton onClick={() => setShowAskInput(true)}>Ask</ToolbarButton>
          <ToolbarButton onClick={() => onAction('explain')}>Explain</ToolbarButton>
          <ToolbarButton onClick={() => onAction('review')}>Review</ToolbarButton>
          <ToolbarButton onClick={() => onAction('fix')}>Fix</ToolbarButton>
          <span className="w-px h-4 bg-border mx-1" />
          <CopyActionButton onCopySelection={onCopySelection} />
          <span className="w-px h-4 bg-border mx-1" />
          <CloseButton onClick={onClose} />
        </div>
      )}
    </div>
  );
};

const ToolbarButton: React.FC<{ onClick: () => void; children: React.ReactNode }> = ({
  onClick,
  children,
}) => (
  <button
    className="px-2 py-1 rounded text-xs text-text-primary hover:bg-bg-hover font-medium transition whitespace-nowrap"
    onClick={onClick}
  >
    {children}
  </button>
);

/**
 * 复制动作按钮 —— 与 AI 派发按钮同组但语义不同（剪贴板 vs terminal），故用分隔线分组。
 * ✓ 反馈是组件本地瞬时态，成败判定权在宿主的复制入口（失败走 toast）。
 *
 * 计时器与自动回落复用 `useTransientFlag`（复制 ✓ 反馈的唯一实现，同时被
 * agent-chat / conversation / notification 三域的复制按钮共用）—— 不在本地重写
 * state+setTimeout：那正是过去 4 份实现里 3 份漏掉卸载清理的成因。
 */
const CopyActionButton: React.FC<{ onCopySelection: () => void }> = ({ onCopySelection }) => {
  const { flag: copied, flash } = useTransientFlag(COPIED_FEEDBACK_MS);

  const handleClick = () => {
    onCopySelection();
    flash();
  };

  return (
    <button
      className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition"
      onClick={handleClick}
      title={copied ? 'Copied' : 'Copy selection'}
      aria-label={copied ? 'Copied' : 'Copy'}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
};

const CloseButton: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <button
    className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition"
    onClick={onClick}
    title="Close"
  >
    <CloseIcon size={14} />
  </button>
);

export default React.memo(SelectionToolbar);
