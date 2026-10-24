import { ArrowUp, Paperclip, Square, X } from 'lucide-react';
import { useCallback } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';

import type { ModelInfo } from '@/features/agent/api/agentApi';
import type { AgentConfig } from '@/shared/types/agent';
import type { SessionConfigOption } from '@/shared/types/agentChat';
import { showsConfigControls, showsModelPicker, writabilityOf } from '@/shared/utils/modelTarget';
import type { ModelAvailability } from '@/shared/utils/modelTarget';
import { noAutocorrectProps } from '@/ui/inputDefaults';

import { modeOptionOf, modelConfigOptionsOf, thoughtLevelOptionOf } from './composerConfigOptions';
import ComposerMirror from './ComposerMirror';
import ComposerPalette, { useComposerPalette } from './ComposerPalette';
import ContextWindowMeter from './ContextWindowMeter';
import type { Attachment, ContextWindow } from './messageModel';
import { ModelPicker } from './ModelPicker';
import { ModelSelector } from './ModelSelector';
import type { ComposerPaletteSource } from './paletteSources';
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
  contextWindow: ContextWindow | null;
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
  /**
   * 补全弹层选中候选后的写回入口（替换 `[triggerIndex, cursor)` 段，含触发符与
   * 尾随空格）。`cursor` 是插入后的光标位置，由 ChatComposer 负责恢复。
   */
  onReplaceInput?: (text: string, cursor: number) => void;
  /**
   * 弹层的数据源（slash / mention）。由父级按能力位装配：`capabilities.commands`
   * 为 false 的传输不挂 slash 源，`/` 就完全不触发（R2 —— 能力位 false 时
   * 连查询都不发，不是弹了再报错）。
   */
  sources: readonly ComposerPaletteSource[];
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
  onReplaceInput,
  sources,
}: ChatComposerProps) {
  // 两个判据都从**同一个 union** 派生（`shared/utils/modelTarget.ts`），但问的是
  // 两件不同的事：
  //
  // - 模型选择器：`no-config` 才隐藏（模型随每轮下发也能选）
  // - 配置控件：**有配置项且会话就绪**才渲染，与模型怎么传无关
  //
  // 2026-10-23 修正：这里曾用 `sessionConfigView === 'ready'` 同时门控两者。
  // serve 的模型是 `per-turn`（永远不等于 `'ready'`）但它**产出** configOptions，
  // 于是模式/思考等级永不渲染 —— 用户看到「opencode 支持 plan/build，界面上却没有」。
  const availability = sessionConfigView ?? 'no-config';
  const showModelPicker = showsModelPicker(availability);
  const configOptions = sessionConfigOptions ?? [];
  const showConfigControls = showsConfigControls(availability, configOptions.length);
  const mode = showConfigControls ? modeOptionOf(configOptions) : null;
  const thoughtLevel = showConfigControls ? thoughtLevelOptionOf(configOptions) : null;

  // 补全弹层（/ 命令 · @ 文件提及）：状态机与键盘契约在 useComposerPalette，
  // 数据源由父级按能力位装配（见 sources prop 的文档）。
  const {
    textareaRef,
    view: paletteView,
    handleChange: handlePaletteChange,
    handleKeyDown: handlePaletteKeyDown,
    handlePick,
    handleHighlight,
    compositionProps,
    composing,
  } = useComposerPalette({ input, sources, onReplaceText: onReplaceInput });

  // 镜像高亮层（AC11，design §10）：token 判据与弹层触发同源（paletteHighlight），
  // 只随 text 重算；IME 组合期暂停渲染、恢复 textarea 原生渲染（ComposerMirror）。

  const handleComposerChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      onInputChange(e);
      handlePaletteChange(e);
    },
    [onInputChange, handlePaletteChange],
  );

  // 弹层优先：打开时 Enter/Tab 只选中候选，不得同时触发发送（AC7 双触发缺陷）。
  const handleComposerKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (handlePaletteKeyDown(e)) {
        e.preventDefault();
        return;
      }
      // IME 组合期的 Enter 属于输入法（确认候选上屏），不得进入发送路径 ——
      // 弹层在组合期返回 false 放行后，若不在此拦截，拼音上屏的 Enter 会直接
      // 发送消息。`composing` 由显式 composition 事件维护；`nativeEvent.isComposing`
      // 兼作个别平台事件时序差异的兑底。
      if (composing || e.nativeEvent.isComposing) return;
      onKeyDown(e);
    },
    [onKeyDown, handlePaletteKeyDown, composing],
  );

  return (
    <div className="wa-composer">
      <div className="wa-box">
        {paletteView && (
          <ComposerPalette
            kind={paletteView.kind}
            items={paletteView.items}
            highlight={paletteView.highlight}
            emptyText={paletteView.emptyText}
            onHighlight={handleHighlight}
            onPick={handlePick}
          />
        )}
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

        <div className="composer-input">
          <ComposerMirror text={input} suspended={composing} textareaRef={textareaRef} />
          <textarea
            ref={textareaRef}
            className={`composer-textarea${composing ? ' composing' : ''}`}
            rows={1}
            placeholder="Type a message..."
            value={input}
            onChange={handleComposerChange}
            onKeyDown={handleComposerKeyDown}
            {...compositionProps}
            {...noAutocorrectProps}
          />
        </div>

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
                configOptions={showConfigControls ? modelConfigOptionsOf(configOptions) : []}
                onConfigChange={onConfigChange}
                writability={writabilityOf(sessionConfigView ?? 'no-config')}
                disabled={streaming}
              />
            )}
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
            {contextWindow && <ContextWindowMeter contextWindow={contextWindow} />}
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
