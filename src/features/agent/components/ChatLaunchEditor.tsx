import React from 'react';

import { TRANSPORT_LABELS, type ChatTransport, type WireFormat } from '@/shared/types/agent';
import { Textarea } from '@/ui';

import ArgListEditor from './ArgListEditor';

/**
 * 自定义 agent 的 CHAT 编辑器：argv（数组，不做有损投影）+ in-process + env
 * + ACP 帧格式。
 *
 * 与 `BuiltinChatSection` 的分工是**判据**而不是样式：内置 agent 的协议是出厂
 * 事实（只读），自定义 agent 的全部启动信息由用户提供（可编辑）。
 *
 * # Wire Format 为什么只对 ACP 传输出现
 *
 * 帧格式（`Content-Length` vs NDJSON）是**配置项**，不是推断结果 —— 旧版按
 * 可执行文件名猜，用户把二进制改名或包一层 wrapper 就静默换错协议（握手永远
 * 无响应、无报错）。它是 `ChatLaunch.wire_format`，只有 ACP 消费，所以选择器
 * 只在识别为 ACP 时出现；进程内实现没有帧，同样隐藏。
 *
 * 显式选择 `'content-length'` 也会落盘：后端装载期迁移对 opencode 命名的旧
 * 配置推断 NDJSON，显式值（含 ContentLength）短路推断 —— 这是 opencode 命名
 * 的二进制说 ContentLength 协议时唯一的表达方式。
 */
interface ChatLaunchEditorProps {
  /** argv 数组；首项是 program。空 = 无 CHAT 能力。 */
  argv: string[];
  onArgvChange: (next: string[]) => void;
  envText: string;
  onEnvTextChange: (next: string) => void;
  inprocess: boolean;
  onInprocessChange: (next: boolean) => void;
  /** ACP 帧格式选择（仅 `transport === 'acp'` 时渲染）。 */
  wireFormat: WireFormat;
  onWireFormatChange: (next: WireFormat) => void;
  /** argv 识别出的传输；`null` = 无 CHAT 能力。 */
  transport: ChatTransport | null;
  /** 提交值是否构成一个 chat（决定 env 输入框显隐）。 */
  hasChat: boolean;
  placeholders: readonly string[];
  groupCls: string;
  labelCls: string;
}

const ChatLaunchEditor: React.FC<ChatLaunchEditorProps> = ({
  argv,
  onArgvChange,
  envText,
  onEnvTextChange,
  inprocess,
  onInprocessChange,
  wireFormat,
  onWireFormatChange,
  transport,
  hasChat,
  placeholders,
  groupCls,
  labelCls,
}) => (
  <>
    <div className={groupCls} role="group" aria-label="CHAT Launch">
      <span className={labelCls}>CHAT Launch (first = program · empty = no CHAT)</span>
      <ArgListEditor
        value={argv}
        onChange={onArgvChange}
        placeholders={placeholders}
        disabled={inprocess}
        inputClassName="bg-bg-secondary"
      />
    </div>
    {/* 进程内实现没有 argv 可填，但**确有** CHAT 能力 —— 两者必须显式区分。 */}
    <label className="flex items-center gap-1.5 text-[0.72em] text-text-muted">
      <input
        type="checkbox"
        checked={inprocess}
        onChange={(e) => onInprocessChange(e.target.checked)}
      />
      In-process (no subprocess · e.g. mockAgent)
    </label>
    {/* 进程内实现没有 argv 可识别 —— 但它确有 CHAT 能力，标签要如实说出来
        （mockAgent 走 ACP 帧，`transportOf` 对空 argv 的默认值恰好是 acp）。 */}
    {transport && (
      <div className="text-[0.7em] text-text-muted -mt-1">
        Detected: {TRANSPORT_LABELS[transport]}
      </div>
    )}
    {transport === 'acp' && !inprocess && (
      <div className={groupCls}>
        <label className={labelCls} htmlFor="agent-form-chat-wire-format">
          Wire Format
        </label>
        <select
          id="agent-form-chat-wire-format"
          value={wireFormat}
          onChange={(e) => onWireFormatChange(e.target.value as WireFormat)}
          className="h-7 w-40 shrink-0 rounded border border-border bg-bg-secondary px-2 text-[0.82em] text-text-primary outline-none focus:border-accent-blue"
        >
          <option value="content-length">Content-Length (default)</option>
          <option value="ndjson">NDJSON</option>
        </select>
      </div>
    )}
    {hasChat && (
      <div className={groupCls}>
        <label className={labelCls} htmlFor="agent-form-chat-env">
          CHAT Env (one KEY=value per line)
        </label>
        <Textarea
          id="agent-form-chat-env"
          value={envText}
          onChange={(e) => onEnvTextChange(e.target.value)}
          rows={2}
          placeholder={'ANTHROPIC_API_KEY=!ANTHROPIC_API_KEY'}
          className="bg-bg-secondary text-[0.82em] min-h-0 py-1"
        />
      </div>
    )}
  </>
);

export default React.memo(ChatLaunchEditor);
