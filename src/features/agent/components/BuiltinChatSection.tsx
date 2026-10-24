import React from 'react';

import { cn } from '@/lib/utils';
import { TRANSPORT_LABELS, type ChatTransport } from '@/shared/types/agent';
import { ToggleGroup, ToggleGroupItem } from '@/ui';

import type { ChatEnabledChoice } from './agentFormState';

/**
 * 内置 agent 的 CHAT 区：**只读出厂协议 + 一个开关**。
 *
 * # 为什么出厂协议不可编辑
 *
 * `chat` 是出厂事实（协议 + 参数）。用户换协议的诉求走「新建自定义 agent」——
 * 那本来就是他真正在做的事。让内置定义可改会让出厂修正永远追不上旧快照
 *（spec §10.5d 事故形态）。
 *
 * # 为什么这不是一个受控组件
 *
 * 它只负责渲染：`chatEnabled` 与 `onChange` 由 `AgentForm` 持有（稳定回调）。
 * 表单态的单一所有者必须是 `AgentForm` —— 否则「提交时用哪份值」会有两份真相。
 */
interface BuiltinChatSectionProps {
  /** 出厂定义的传输（`TRANSPORTS` 表的识别结果）。`null` = 出厂没有 chat。 */
  transport: ChatTransport | null;
  /** 三态选择器：default（跟随出厂）/ on / off。 */
  value: ChatEnabledChoice;
  onChange: (next: ChatEnabledChoice) => void;
  groupCls: string;
  labelCls: string;
}

const BuiltinChatSection: React.FC<BuiltinChatSectionProps> = ({
  transport,
  value,
  onChange,
  groupCls,
  labelCls,
}) => {
  if (transport === null) {
    return (
      <div className={groupCls} role="group" aria-label="CHAT">
        <span className={labelCls}>CHAT</span>
        <p className="text-[0.72em] text-text-muted leading-relaxed">
          This agent has no built-in chat protocol. To talk to it over ACP, create a custom agent
          with the ACP command instead.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className={groupCls} role="group" aria-label="CHAT Protocol">
        <span className={labelCls}>CHAT Protocol</span>
        <p className="text-[0.78em] text-text-primary">{TRANSPORT_LABELS[transport]}</p>
        <p className="text-[0.7em] text-text-muted leading-relaxed">
          Defined by this built-in agent and kept up to date by the app. To use a different
          protocol, create a custom agent instead.
        </p>
      </div>
      {/* 三态直接可见：Default = 跟随出厂（chat_enabled: null）。之前是
          「两态 checkbox + 事后出现的 Reset 按钮」，第三态对用户隐形 ——
          现在选中态本身就把「跟随出厂 / 显式开 / 显式关」说清楚。 */}
      <div className={groupCls} role="group" aria-label="Enable chat">
        <span className={labelCls}>Enable chat</span>
        <ToggleGroup
          type="single"
          value={value}
          onValueChange={(v) => {
            if (v) onChange(v as ChatEnabledChoice);
          }}
          className="w-fit"
        >
          <ToggleGroupItem value="default" className="px-2.5 py-0.5 text-[0.72em]">
            Default
          </ToggleGroupItem>
          <ToggleGroupItem value="on" className="px-2.5 py-0.5 text-[0.72em]">
            On
          </ToggleGroupItem>
          <ToggleGroupItem value="off" className="px-2.5 py-0.5 text-[0.72em]">
            Off
          </ToggleGroupItem>
        </ToggleGroup>
        <p
          className={cn(
            'text-[0.7em] text-text-muted leading-relaxed',
            value !== 'default' && 'italic',
          )}
        >
          {value === 'default'
            ? 'Follows the factory definition and stays in sync with app updates.'
            : 'Overridden — pick Default to follow the factory definition again.'}
        </p>
      </div>
    </>
  );
};

export default React.memo(BuiltinChatSection);
