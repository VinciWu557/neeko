/**
 * CapabilityBadges — Agent 能力徽标（CLI / CHAT / Headless）。
 *
 * CLI/CHAT/Headless 是三个正交能力（不是并列形态）：
 * - CLI：`command` 非空（终端 Tab + PTY 跑 agent 自带 TUI）；
 * - CHAT：`chat: Some(_)`（Agent Chat Tab + adapter 驱动）；
 * - Headless：`prompt_args`（程序化单轮，如 AI commit）。
 *
 * 配色沿用 Catppuccin Mocha 语义色：CLI=blue、CHAT=green、Headless=yellow。
 */

import React from 'react';

import { cn } from '@/lib/utils';
import { agentCapabilities, type AgentConfig } from '@/shared/types/agent';

export type CapabilityKind = 'cli' | 'chat' | 'headless';

export const CAPABILITY_META: Record<CapabilityKind, { label: string; cls: string; dot: string }> =
  {
    cli: {
      label: 'CLI',
      cls: 'text-accent-blue border-accent-blue/25 bg-accent-blue/10',
      dot: 'bg-accent-blue',
    },
    chat: {
      label: 'CHAT',
      cls: 'text-accent-green border-accent-green/25 bg-accent-green/10',
      dot: 'bg-accent-green',
    },
    headless: {
      label: 'Headless',
      cls: 'text-accent-yellow border-accent-yellow/25 bg-accent-yellow/10',
      dot: 'bg-accent-yellow',
    },
  };

/** 单枚能力徽标。 */
function CapChip({
  kind,
  className,
  title,
}: {
  kind: CapabilityKind;
  className?: string;
  title?: string;
}) {
  const meta = CAPABILITY_META[kind];
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-px text-[0.68em] font-medium leading-[1.5]',
        meta.cls,
        className,
      )}
    >
      <span className={cn('size-[5px] rounded-full', meta.dot)} />
      {meta.label}
    </span>
  );
}

interface CapabilityBadgesProps {
  // `chat_enabled` 必须在这个 `Pick` 里：漏了 `isChatEnabled` 读不到它，
  // 被用户关掉的 CHAT 会继续显示成可用（而不是灰态）。
  agent: Pick<AgentConfig, 'command' | 'chat' | 'chat_enabled' | 'prompt_args'>;
  className?: string;
}

/**
 * 一组能力徽标（有哪个能力显示哪个）。
 *
 * CHAT 徽标在「有出厂 chat 但用户关掉」时显示为**灰态**而不是消失 ——
 * 用户要能区分「这个 agent 本来就不能聊」与「我把它关了、去哪里打开」。
 */
const CapabilityBadges: React.FC<CapabilityBadgesProps> = ({ agent, className }) => {
  const caps = agentCapabilities(agent as AgentConfig);
  const chatDeclared = Boolean(agent.chat);
  const chatOff = chatDeclared && !caps.chat;
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {caps.cli && <CapChip kind="cli" />}
      {caps.chat && <CapChip kind="chat" />}
      {chatOff && (
        <CapChip kind="chat" className="opacity-40" title="CHAT is disabled for this agent" />
      )}
      {caps.headless && <CapChip kind="headless" />}
    </span>
  );
};

export default React.memo(CapabilityBadges);
