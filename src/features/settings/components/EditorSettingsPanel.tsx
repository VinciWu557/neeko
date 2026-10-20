/**
 * Editor 设置页的组装：把 `AppConfig` 的编辑器相关字段接到 `EditorPanel` 的 props。
 *
 * `SettingsPanel`（弹窗）与 `SettingsView`（设置页）此前各自复制了整段 `<EditorPanel .../>`
 * 的 props 绑定；编辑器新增一项配置就要在两处同步改，必然漂移。此处收敛为单点，
 * 两个容器只负责提供 `config` / `onConfigChange` / `agents`。
 */
import React from 'react';

import type { AgentConfig, AppConfig } from '@/shared/types';

import EditorPanel from './EditorPanel';

interface EditorSettingsPanelProps {
  config: AppConfig;
  onConfigChange: (next: AppConfig) => void | Promise<void>;
  agents: AgentConfig[];
  onEditorFontSizeChange: (size: number) => void;
}

const EditorSettingsPanel: React.FC<EditorSettingsPanelProps> = ({
  config,
  onConfigChange,
  agents,
  onEditorFontSizeChange,
}) => (
  <EditorPanel
    editorFontSize={config.editorFontSize}
    onEditorFontSizeChange={onEditorFontSizeChange}
    autoLocateFileOnTabSwitch={config.autoLocateFileOnTabSwitch}
    onAutoLocateFileOnTabSwitchChange={(enabled) =>
      onConfigChange({ ...config, autoLocateFileOnTabSwitch: enabled })
    }
    editorGitChangeHighlight={config.editorGitChangeHighlight}
    onEditorGitChangeHighlightChange={(enabled) =>
      onConfigChange({ ...config, editorGitChangeHighlight: enabled })
    }
    watcherExclude={config.watcherExclude ?? []}
    onWatcherExcludeChange={(patterns) => onConfigChange({ ...config, watcherExclude: patterns })}
    translationAgentId={config.translation?.agentId}
    translationModelId={config.translation?.modelId}
    translationTargetLanguage={config.translation?.targetLanguage}
    commentTranslationMode={config.translation?.commentMode}
    commentTranslationAutoWarm={config.translation?.commentAutoWarm}
    agents={agents}
    onTranslationAgentChange={(agentId) =>
      // 换 agent 必须同时清掉 modelId：模型是 agent 的子集，旧 agent 的模型 id
      // 对新 agent 无效。留着它会让翻译请求带上一个不存在的模型，
      // 表现为「翻译一直失败但看不出原因」。
      onConfigChange({
        ...config,
        translation: { ...config.translation, agentId, modelId: undefined },
      })
    }
    onTranslationModelChange={(modelId) =>
      onConfigChange({
        ...config,
        translation: { ...config.translation, modelId: modelId ?? undefined },
      })
    }
    onTranslationTargetLanguageChange={(targetLanguage) =>
      onConfigChange({ ...config, translation: { ...config.translation, targetLanguage } })
    }
    onCommentTranslationModeChange={(commentMode) =>
      onConfigChange({ ...config, translation: { ...config.translation, commentMode } })
    }
    onCommentTranslationAutoWarmChange={(commentAutoWarm) =>
      onConfigChange({ ...config, translation: { ...config.translation, commentAutoWarm } })
    }
  />
);

export default React.memo(EditorSettingsPanel);
