import React from 'react';

import { cn } from '@/lib/utils';

/**
 * CHAT 会话进程的启动配置：可执行文件覆盖 + 附加参数。
 *
 * # 为什么与 CLI 的 Command/Args 分开
 *
 * 同一个 agent 的 TUI 与 chat 常常不是同一个进程：
 *
 * | 场景 | 典型命令 | 典型参数 |
 * | --- | --- | --- |
 * | 终端 TUI | `pi` | `--approve` |
 * | Chat（自己的 rpc） | `pi` | `--provider foo` |
 * | Chat（ACP 包装） | `pi-acp` | `--verbose` |
 *
 * 共用一份配置会让上表第三行无法表达。所以 chat 有独立的可执行文件与参数，
 * 且**一旦覆盖可执行文件就不再继承 CLI 的 args** —— 那些参数描述的是另一个进程。
 *
 * 抽成独立组件而不是内联在 `AgentForm` 里：后者的体积受
 * `check_component_size` 的 ratchet 约束（只许缩小），而这段 UI 有独立的
 * 语义边界，本就该自成一体。
 */
interface ChatLaunchFieldsProps {
  /** 当前 CLI command，用作 placeholder 展示「不填就用它」。 */
  cliCommand: string;
  chatCommand: string;
  chatArgsText: string;
  onChatCommandChange: (value: string) => void;
  onChatArgsChange: (value: string) => void;
  fieldCls: string;
  labelCls: string;
  groupCls: string;
}

const ChatLaunchFields: React.FC<ChatLaunchFieldsProps> = ({
  cliCommand,
  chatCommand,
  chatArgsText,
  onChatCommandChange,
  onChatArgsChange,
  fieldCls,
  labelCls,
  groupCls,
}) => (
  <>
    <div className="grid grid-cols-2 gap-2">
      <label className={groupCls}>
        <span className={labelCls}>Chat Command (optional override)</span>
        <input
          type="text"
          value={chatCommand}
          onChange={(e) => onChatCommandChange(e.target.value)}
          placeholder={cliCommand.trim() || 'myagent'}
          className={cn(fieldCls, 'bg-bg-secondary font-mono')}
        />
      </label>
      <label className={groupCls}>
        <span className={labelCls}>Chat Args (space-separated)</span>
        <input
          type="text"
          value={chatArgsText}
          onChange={(e) => onChatArgsChange(e.target.value)}
          placeholder="--provider foo"
          className={cn(fieldCls, 'bg-bg-secondary font-mono')}
        />
      </label>
    </div>
    <div className="text-[0.7em] text-text-muted -mt-1">
      Chat Command overrides the executable for CHAT only; setting it stops the CLI Args above from
      being inherited (they belong to the TUI process).
    </div>
  </>
);

export default ChatLaunchFields;
