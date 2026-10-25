import { ArrowUp, Paperclip, Square } from 'lucide-react';
import { useCallback, useState } from 'react';

import type { ModelInfo } from '@/features/agent/api/agentApi';
import type { AgentConfig } from '@/shared/types/agent';
import type { SessionConfigOption } from '@/shared/types/agentChat';
import { showsConfigControls, showsModelPicker, writabilityOf } from '@/shared/utils/modelTarget';
import type { ModelAvailability } from '@/shared/utils/modelTarget';

import { getComposerEditor } from './composer/editorRegistry';
import RichComposer from './composer/RichComposer';
import { submitComposer } from './composer/submitComposer';
import type { ComposerSubmission } from './composer/submitComposer';
import { modeOptionOf, modelConfigOptionsOf, thoughtLevelOptionOf } from './composerConfigOptions';
import ContextWindowMeter from './ContextWindowMeter';
import type { ContextWindow } from './messageModel';
import { ModelPicker } from './ModelPicker';
import { ModelSelector } from './ModelSelector';
import type { ComposerPaletteSource } from './paletteSources';
import { AgentModeSelector, ThinkingLevelSelector } from './ParamSelectors';

interface ChatComposerProps {
  /**
   * 兼容旧纯文本草稿（tab data 暂无 `composerDoc` 时恢复一次，design §7）。
   * 新草稿一律走 `composerDoc`（RichComposer 内部持久化）。
   */
  legacyInput?: string;
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
  /**
   * 发送：prompt 文本 + **由文档投影出的 files 列表**（`ComposerSubmission`）。
   * 附件不是独立 state —— 文件 chip 在文档里存在 ⇔ 该文件随消息发送。
   */
  onSend: (submission: ComposerSubmission) => void;
  onStop: () => void;
  onOpenAttachDrop: () => void;
  onModelChange: (model: ModelInfo) => void;
  /** `model_config` / `thought_level` 变更（下发 session/set_config_option）。 */
  onConfigChange?: (configId: string, value: string | boolean) => void;
  /**
   * 弹层的数据源（slash / mention）。由父级按能力位装配：`capabilities.commands`
   * 为 false 的传输不挂 slash 源，`/` 就完全不触发（R2 —— 能力位 false 时
   * 连查询都不发，不是弹了再报错）。
   */
  sources: readonly ComposerPaletteSource[];
}

/** 底部输入区：富文本 composer + 工具栏（模型/参数选择器/发送）。 */
export default function ChatComposer({
  legacyInput,
  streaming,
  chatAgents,
  models,
  sessionConfigOptions,
  selectedModel,
  selectedAgent,
  contextWindow,
  tabKey,
  tabId,
  onSend,
  onStop,
  onOpenAttachDrop,
  onModelChange,
  onConfigChange,
  sessionConfigView,
  sources,
}: ChatComposerProps) {
  // 发送按钮的可用性由编辑器派生（空内容禁发）—— 只读投影，不回写编辑器。
  const [composerEmpty, setComposerEmpty] = useState(true);
  const handleEmptyChange = useCallback((isEmpty: boolean) => setComposerEmpty(isEmpty), []);
  // 发送按钮与 Enter 共用同一实现（`submitComposer`）。编辑器实例取自
  // `editorRegistry`（外部投递的同一个登记表）—— 不再由本组件另存一份 ref，
  // 否则「谁持有编辑器」这件事有两个答案。
  const handleSendClick = useCallback(() => {
    const editor = getComposerEditor(tabKey, tabId);
    if (editor) submitComposer(editor, onSend);
  }, [tabKey, tabId, onSend]);
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

  return (
    <div className="wa-composer">
      <div className="wa-box">
        <div className="composer-input">
          <RichComposer
            tabKey={tabKey}
            tabId={tabId}
            legacyInput={legacyInput}
            sources={sources}
            onSend={onSend}
            onEmptyChange={handleEmptyChange}
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
                disabled={composerEmpty}
                onClick={handleSendClick}
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
