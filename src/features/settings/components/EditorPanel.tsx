import React, { useMemo } from 'react';

import { useAgentModels } from '@/features/agent';
import type { AgentConfig, CommentDisplayMode } from '@/shared/types';
import { isTranslationAgentStale, translatableAgents } from '@/shared/utils/agents';
import { Separator, Switch } from '@/ui';

import SettingRow from './SettingRow';
import WatcherExcludeSection from './WatcherExcludeSection';

interface EditorPanelProps {
  editorFontSize: number;
  onEditorFontSizeChange: (size: number) => void;
  /** Recommended editor size: follows terminal, for the reset button */
  /** 切换 file tab 时自动在文件树中定位该文件 */
  autoLocateFileOnTabSwitch: boolean;
  onAutoLocateFileOnTabSwitchChange: (enabled: boolean) => void;
  /** 编辑器左侧 Git 行级变更高亮开关 */
  editorGitChangeHighlight: boolean;
  onEditorGitChangeHighlightChange: (enabled: boolean) => void;
  /** 用户级文件监听排除（D2）；空数组 = 只遵循 .gitignore */
  watcherExclude: string[];
  onWatcherExcludeChange: (patterns: string[]) => void;
  /** AI 翻译默认项 */
  translationAgentId?: string;
  /** 翻译模型（空 = 使用 agent 默认模型）。 */
  translationModelId?: string;
  translationTargetLanguage?: string;
  /** 注释译文的显示形态（对照 / 行内 / 悬停 / 关闭）。 */
  commentTranslationMode?: CommentDisplayMode;
  /** 打开文件即翻译注释（默认关）。 */
  commentTranslationAutoWarm?: boolean;
  agents: AgentConfig[];
  onTranslationAgentChange: (agentId: string) => void;
  onTranslationModelChange: (modelId: string | null) => void;
  onTranslationTargetLanguageChange: (language: string) => void;
  onCommentTranslationModeChange: (mode: CommentDisplayMode) => void;
  onCommentTranslationAutoWarmChange: (enabled: boolean) => void;
}

/** 目标语言选项：value 为翻译 prompt 使用的语言名，label 为设置页英文展示 */
const TRANSLATION_LANGUAGES: Array<{ value: string; label: string }> = [
  { value: '简体中文', label: 'Simplified Chinese' },
  { value: '繁體中文', label: 'Traditional Chinese' },
  { value: 'English', label: 'English' },
  { value: '日本語', label: 'Japanese' },
  { value: '한국어', label: 'Korean' },
];

/**
 * 模型下拉在非 available 状态下的占位文案。
 *
 * 四种处境对用户是四种不同的事实，措辞必须分开：
 * - `session-scoped`：协议限制（ACP 没有独立的列模型方法），不是故障；
 * - `unsupported`：这个 agent 就是没有模型选择；
 * - `error`：拉取失败 —— 唯一「可以再试一次」的一种；
 * - `loading` / `idle`：等就有。
 */
export function modelPlaceholder(kind: string): string {
  switch (kind) {
    case 'session-scoped':
      return 'Available inside a session';
    case 'unsupported':
      return 'This agent has no model selection';
    case 'error':
      return 'Could not load models';
    case 'loading':
      return 'Loading models…';
    default:
      return 'Select an agent first';
  }
}

const selectClass =
  'bg-bg-tertiary border border-border rounded text-[0.86em] text-text-primary px-2 py-1 outline-none focus:border-accent-blue';

const EditorPanel: React.FC<EditorPanelProps> = ({
  editorFontSize,
  onEditorFontSizeChange,
  autoLocateFileOnTabSwitch,
  onAutoLocateFileOnTabSwitchChange,
  editorGitChangeHighlight,
  onEditorGitChangeHighlightChange,
  watcherExclude,
  onWatcherExcludeChange,
  translationAgentId,
  translationModelId,
  translationTargetLanguage,
  commentTranslationMode,
  commentTranslationAutoWarm,
  agents,
  onTranslationAgentChange,
  onTranslationModelChange,
  onTranslationTargetLanguageChange,
  onCommentTranslationModeChange,
  onCommentTranslationAutoWarmChange,
}) => {
  // 翻译走 AgentAdapter 抽象（adapter_for），默认 Agent 也仅 CHAT 能力可选。
  // 判据归 `translatableAgents` 所有 —— 与运行时解析、陈旧检测同源。
  const chatAgents = useMemo(() => translatableAgents(agents), [agents]);

  // 模型列表跟随所选 agent。空 agent（= Agent default）时没有模型可选 ——
  // 具体用哪个模型由 agent 自己决定，这里不该替它选。
  const { state: modelsState, models } = useAgentModels(translationAgentId || null);

  /**
   * 配置里的 agent 已不可用（被删 / 失去 chat 能力 / 被停用）。
   *
   * 非 `null` 时下拉里会多出一个标注 `unavailable` 的选项 —— 否则 HTML select
   * 会把它回落显示成第一项，用户看不出配置里存着一个坏 id。
   */
  const staleAgentId = isTranslationAgentStale(translationAgentId, agents)
    ? translationAgentId
    : null;

  /**
   * 模型下拉的归属标签：让「模型属于哪个 agent」在界面上可见。
   *
   * 联动如果只体现在「换 agent 会清空模型」，用户看到的是一次莫名其妙的丢失；
   * 写明归属后，同一次操作读起来是「换主人 → 模型跟着换」。
   */
  const selectedAgentName = chatAgents.find((agent) => agent.id === translationAgentId)?.name;
  const modelOwnerLabel = staleAgentId
    ? 'Unavailable agent'
    : (selectedAgentName ?? 'Agent default');

  return (
    <>
      <h3 className="text-base font-semibold text-text-primary mb-4">Editor</h3>
      <Separator className="mb-5" />
      <SettingRow title="Font Size" description="Font size for the file editor.">
        <div className="flex items-center gap-2 shrink-0">
          <button
            className="size-7 bg-bg-tertiary border border-border rounded text-text-primary text-[1.07em] cursor-pointer flex items-center justify-center transition-colors duration-150 hover:bg-bg-hover disabled:opacity-35 disabled:cursor-not-allowed"
            onClick={() => onEditorFontSizeChange(editorFontSize - 1)}
            disabled={editorFontSize <= 10}
          >
            &minus;
          </button>
          <span className="min-w-[44px] text-center text-[0.86em] text-text-primary tabular-nums">
            {editorFontSize}px
          </span>
          <button
            className="size-7 bg-bg-tertiary border border-border rounded text-text-primary text-[1.07em] cursor-pointer flex items-center justify-center transition-colors duration-150 hover:bg-bg-hover disabled:opacity-35 disabled:cursor-not-allowed"
            onClick={() => onEditorFontSizeChange(editorFontSize + 1)}
            disabled={editorFontSize >= 24}
          >
            +
          </button>
        </div>
      </SettingRow>
      <SettingRow
        title="Auto-locate file on tab switch"
        description="When switching file tabs, automatically reveal the file in the file tree."
      >
        <Switch
          checked={autoLocateFileOnTabSwitch}
          onCheckedChange={onAutoLocateFileOnTabSwitchChange}
        />
      </SettingRow>
      <SettingRow
        title="Git Change Highlight"
        description="Show git change gutter marks and line highlights in the editor."
      >
        <Switch
          checked={editorGitChangeHighlight}
          onCheckedChange={onEditorGitChangeHighlightChange}
        />
      </SettingRow>
      <SettingRow
        title="Comment Translation Display"
        description="How translated comments appear in the editor. Inline and hover keep the file compact; the button in the editor header starts and stops translation."
      >
        <select
          className={selectClass}
          value={commentTranslationMode ?? 'below'}
          onChange={(e) => onCommentTranslationModeChange(e.target.value as CommentDisplayMode)}
          aria-label="Comment translation display mode"
        >
          <option value="below">Below comment</option>
          <option value="inline">Inline</option>
          <option value="hover">On hover</option>
          <option value="off">Off</option>
        </select>
      </SettingRow>
      <SettingRow
        title="Translate Comments on Open"
        description="Start translating a file's comments as soon as it opens. Off by default: the first run on a file costs a model call."
      >
        <Switch
          checked={commentTranslationAutoWarm === true}
          onCheckedChange={onCommentTranslationAutoWarmChange}
        />
      </SettingRow>
      <WatcherExcludeSection excludes={watcherExclude} onExcludesChange={onWatcherExcludeChange} />
      {/*
        Agent 与模型是**一个选择**，不是一个设置里的两个独立项：模型属于 agent，
        换 agent 后旧模型 id 无意义。所以它们同处一行、上下排列，模型控件的标签
        直接写明所属 agent（"Model for Claude Code"），联动关系在界面上可见，
        而不是靠用户知道「换 agent 会清空模型」。

        陈旧 agentId 必须**显式可见**：HTML select 遇到不在 options 里的 value 会
        回落显示第一项，于是「配置里存着一个已删除的 agent」在界面上表现为「没设置」
        —— 用户改不动、也看不出问题，而翻译时照旧用那个坏 id。
      */}
      <SettingRow
        title="Default Translation Agent"
        description="Agent and model used by the AI Translate view. The model list follows the chosen agent; switching agents resets the model."
      >
        <div className="flex flex-col gap-2 min-w-[180px]">
          <select
            className={selectClass}
            value={translationAgentId ?? ''}
            onChange={(e) => onTranslationAgentChange(e.target.value)}
            aria-label="Default translation agent"
          >
            <option value="">Agent default</option>
            {staleAgentId !== null && (
              <option value={staleAgentId}>{staleAgentId} (unavailable — pick another)</option>
            )}
            {chatAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
          {/*
            禁用判据是「有没有可用列表」，不是「数组空不空」。
            旧写法 `models.length === 0` 把「还在加载」也一起禁用了，而且无法区分
            下面前四种处境 —— 于是三种完全不同的情况呈现成同一个 "No models"。
          */}
          <select
            className={selectClass}
            value={translationModelId ?? ''}
            onChange={(e) => onTranslationModelChange(e.target.value || null)}
            aria-label="Default translation model"
            disabled={modelsState.kind !== 'available'}
          >
            <option value="">
              {modelsState.kind === 'available'
                ? `${modelOwnerLabel} — default`
                : modelPlaceholder(modelsState.kind)}
            </option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name || model.id}
              </option>
            ))}
          </select>
        </div>
      </SettingRow>
      <SettingRow
        title="Default Target Language"
        description="Default target language used by the AI Translate view."
      >
        <select
          className={selectClass}
          value={translationTargetLanguage ?? ''}
          onChange={(e) => onTranslationTargetLanguageChange(e.target.value)}
          aria-label="Default translation target language"
        >
          <option value="">Simplified Chinese (default)</option>
          {TRANSLATION_LANGUAGES.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.label}
            </option>
          ))}
        </select>
      </SettingRow>
    </>
  );
};

export default React.memo(EditorPanel);
