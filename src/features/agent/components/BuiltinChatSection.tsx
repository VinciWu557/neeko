import React from 'react';

import { TRANSPORT_LABELS, type ChatTransport } from '@/shared/types/agent';

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
  /** 三态开关值。 */
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
      {/* 开关与 Reset 是**兄弟**而不是 label 包 button：HTML 的 label 内容模型
          不允许 labelable 后代再嵌 labelable 元素，且嵌套会把 "Reset to default"
          混进 checkbox 的可访问名。 */}
      <div className="flex items-center gap-1.5">
        <label className="flex items-center gap-1.5 text-[0.78em] text-text-secondary">
          <input
            type="checkbox"
            checked={value !== 'off'}
            onChange={(e) => onChange(e.target.checked ? 'on' : 'off')}
          />
          Enable chat
        </label>
        {/* 三态要能被用户改回「跟随出厂」—— 否则一次切换就永久覆盖了默认值。 */}
        {value !== 'default' && (
          <button
            type="button"
            className="text-[0.9em] text-accent-blue hover:underline"
            onClick={() => onChange('default')}
          >
            Reset to default
          </button>
        )}
      </div>
    </>
  );
};

export default React.memo(BuiltinChatSection);
