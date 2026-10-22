import { ArrowUp, Paperclip, Square, X } from 'lucide-react';
import type { ChangeEvent, KeyboardEvent } from 'react';

import type { ModelConfigOption, ModelInfo } from '@/features/agent/api/agentApi';
import type { AgentConfig } from '@/shared/types/agent';
import type { SessionConfigOption } from '@/shared/types/agentChat';
import { showsModelPicker, writabilityOf } from '@/shared/utils/modelTarget';
import type { ModelAvailability } from '@/shared/utils/modelTarget';
import { noAutocorrectProps } from '@/ui/inputDefaults';

import ContextWindowMeter from './ContextWindowMeter';
import type { Attachment } from './messageModel';
import { ModelPicker } from './ModelPicker';
import { ModelSelector } from './ModelSelector';
import { AgentModeSelector, ThinkingLevelSelector } from './ParamSelectors';

interface ChatComposerProps {
  input: string;
  attachments: Attachment[];
  streaming: boolean;
  chatAgents: AgentConfig[];
  models: ModelInfo[];
  /** ACP 会话配置项（模型列表 + model_config 控件的来源）。 */
  sessionConfigOptions?: SessionConfigOption[];
  /**
   * 模型/配置项的**可用状态**（`ModelAvailability` 四态 union）。
   *
   * 不能只凭 `sessionConfigOptions` 是否为空推断 —— 那个二态把「传输不支持」
   * 与「会话还没建立」压成同一个结果，后者应显示加载态而非隐藏控件。
   *
   * 也不能拆成两个字段（`capability` + `phase`）：那是 9 种组合的自由空间，
   * 只 4 种可达，每个消费点都要自己 switch 两个维度 —— 四份判据必然漂移。
   */
  sessionConfigView?: ModelAvailability;
  selectedModel: ModelInfo | null;
  selectedAgent: { id: string; name: string; icon?: string | null };
  contextWindow: { used: number; total: number; model: string } | null;
  tabKey: string;
  tabId: string;
  onInputChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  onStop: () => void;
  onRemoveAttachment: (id: string) => void;
  onOpenAttachDrop: () => void;
  onModelChange: (model: ModelInfo) => void;
  /** `model_config` / `thought_level` 变更（下发 session/set_config_option）。 */
  onConfigChange?: (configId: string, value: string | boolean) => void;
}

/**
 * 从 `configOptions` 里挑出**模型 popover 内**要渲染的配置项。
 *
 * 判定靠 `category`，**不靠 `id`** —— 规范明说 category 是 UX 提示但 id 没有
 * 命名约束（实测 Codex 用 `reasoning_effort`、OpenCode 用 `effort`）。
 *
 * **只收 `model_config`，不收 `thought_level`**：推理档位在输入框的工具条上有
 * 自己的选择器（`ThinkingLevelSelector`），那才是用户改它的地方。两处都渲染会
 * 出现两个控件指向同一个 `configId` —— 改一处另一处不跟着动，看起来像"没生效"。
 */
export function modelConfigOptionsOf(
  options: SessionConfigOption[] | undefined,
): ModelConfigOption[] {
  if (!options) return [];
  return options
    .filter((o) => o.category === 'model_config')
    .map((o) => ({
      id: o.id,
      name: o.name,
      description: o.description,
      type: o.type ?? 'select',
      currentValue: o.currentValue,
      options: o.options ?? [],
    }));
}

/**
 * 取会话的真实推理档位（`category: "thought_level"`），供输入框工具条的选择器使用。
 *
 * 返回 `null` 表示该 agent 没有档位概念 —— 调用方应**隐藏**选择器，而不是
 * 显示一组写死的选项后再被后端拒绝。
 *
 * 档位是**动态**的：可选值随当前模型变化（Pi 实测 `low/high/max`，别的模型
 * 可能是 `minimal/medium`），所以每次 `config_option_update` 都要重新读。
 */
export function thoughtLevelOptionOf(
  options: SessionConfigOption[] | undefined,
): ModelConfigOption | null {
  const found = options?.find((o) => o.category === 'thought_level');
  if (!found) return null;
  return {
    id: found.id,
    name: found.name,
    description: found.description,
    type: found.type ?? 'select',
    currentValue: found.currentValue,
    options: found.options ?? [],
  };
}

/**
 * 取会话的真实**模式**（`category: "mode"`，如 plan / build），供输入框工具条使用。
 *
 * 返回 `null` 表示该 agent 没有模式概念 —— 调用方应**隐藏**选择器。
 *
 * # 为什么不能沿用硬编码的 `AGENT_MODES`
 *
 * 旧实现把 `build/plan` 写死在前端，`onChange` 只改 React state、从不发给后端。
 * 那不只是「没用」——它让用户以为自己在 plan 模式下操作，而 agent 侧完全没变。
 *
 * # 当前没有任何内置 agent 下发它
 *
 * Pi 的 rpc 没有这个概念（`get_state` 只有 `followUpMode` / `steeringMode`，
 * 那是队列语义不是 plan/build）；opencode serve 也不发。所以这条链今天
 * **不会显示**任何东西 —— 这是正确行为：不支持的 agent 不该出现一个点不动的控件。
 * 传输侧一旦下发，UI 自动出现，无需改这里。
 */
export function modeOptionOf(options: SessionConfigOption[] | undefined): ModelConfigOption | null {
  const found = options?.find((o) => o.category === 'mode');
  if (!found) return null;
  return {
    id: found.id,
    name: found.name,
    description: found.description,
    type: found.type ?? 'select',
    currentValue: found.currentValue,
    options: found.options ?? [],
  };
}

/** 底部输入区：附件 chips + textarea + 工具栏（模型/参数选择器/发送）。 */
export default function ChatComposer({
  input,
  attachments,
  streaming,
  chatAgents,
  models,
  sessionConfigOptions,
  selectedModel,
  selectedAgent,
  contextWindow,
  tabKey,
  tabId,
  onInputChange,
  onKeyDown,
  onSend,
  onStop,
  onRemoveAttachment,
  onOpenAttachDrop,
  onModelChange,
  onConfigChange,
  sessionConfigView,
}: ChatComposerProps) {
  // 三个判据全部从**同一个 union** 派生（`shared/utils/modelTarget.ts`）。
  // 早期它们各自 switch `{phase, capability}` 两个维度 —— 四份实现必然漂移，
  // 曾出现「渲染说能点、写入拿不到目标」的矛盾。
  // 配置类控件（模式/档位/model_config）只能走 `set_config_option`。
  const configWritable = sessionConfigView === 'ready';
  // 模型列表：`no-config` 隐藏，其余显示（不可写时禁用并给出原因）。
  const showModelPicker = showsModelPicker(sessionConfigView ?? 'no-config');
  const mode = configWritable ? modeOptionOf(sessionConfigOptions) : null;
  const thoughtLevel = configWritable ? thoughtLevelOptionOf(sessionConfigOptions) : null;
  return (
    <div className="wa-composer">
      <div className="wa-box">
        {attachments.length > 0 && (
          <div className="wa-at">
            {attachments.map((a) => (
              <span key={a.id} className="attach-chip">
                <span className="at-type">{a.type}</span>
                {a.name}
                <span
                  className="at-close"
                  role="button"
                  tabIndex={0}
                  aria-label={`移除 ${a.name}`}
                  onClick={() => onRemoveAttachment(a.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onRemoveAttachment(a.id);
                    }
                  }}
                >
                  <X size={12} />
                </span>
              </span>
            ))}
          </div>
        )}

        <textarea
          className="composer-textarea"
          rows={1}
          placeholder="Type a message..."
          value={input}
          onChange={onInputChange}
          onKeyDown={onKeyDown}
          {...noAutocorrectProps}
        />

        <div className="composer-footer">
          <div className="composer-left">
            <ModelSelector
              chatAgents={chatAgents}
              selectedAgent={selectedAgent}
              tabKey={tabKey}
              tabId={tabId}
            />
            {/* 模型选择器：`session_config` 与 `per_turn` 都显示 ——
                前者走 set_config_option，后者随每轮请求下发。只有 `none` 隐藏。 */}
            {showModelPicker && (
              <ModelPicker
                models={models}
                selected={selectedModel}
                onChange={onModelChange}
                agent={selectedAgent}
                configOptions={configWritable ? modelConfigOptionsOf(sessionConfigOptions) : []}
                onConfigChange={onConfigChange}
                writability={writabilityOf(sessionConfigView ?? 'no-config')}
                disabled={streaming}
              />
            )}
            <div className="composer-divider" />
            {mode && (
              <AgentModeSelector
                option={mode}
                disabled={streaming}
                onSelect={(configId, value) => onConfigChange?.(configId, value)}
              />
            )}
            {thoughtLevel && (
              <ThinkingLevelSelector
                option={thoughtLevel}
                disabled={streaming}
                onSelect={(configId, value) => onConfigChange?.(configId, value)}
              />
            )}
            {contextWindow && (
              <ContextWindowMeter
                used={contextWindow.used}
                total={contextWindow.total}
                model={contextWindow.model}
              />
            )}
            <div className="composer-divider" />
            <button className="composer-btn" title="Attach files" onClick={onOpenAttachDrop}>
              <Paperclip size={16} />
            </button>
          </div>
          <div className="composer-right">
            {streaming ? (
              <button className="send-btn stop" onClick={onStop} title="Stop">
                <Square size={14} />
              </button>
            ) : (
              <button
                className="send-btn"
                disabled={input.trim().length === 0}
                onClick={onSend}
                title="Send"
              >
                <ArrowUp size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
