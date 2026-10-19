import type { EditorView } from '@codemirror/view';
import React, { useEffect, useRef } from 'react';

import { useAppContext } from '@/shared/contexts/AppContext';
import type { ProjectId } from '@/shared/utils/workspaceRef';

import { useCommentTranslateActions } from '../hooks/useCommentTranslateActions';

import CommentTranslationToolbar from './CommentTranslationToolbar';

/**
 * 注释翻译入口（方案 A：编辑器内浮动工具条）。
 *
 * ## 为什么单独成组件而不是塞进 FileEditor
 *
 * `FileEditor` 已贴着 300 行红线（`check_component_size` ratchet 门禁）。
 * 把「装配 hook + 渲染工具条」收在这里后，`FileEditor` 只多两行（一个条件渲染），
 * 不欠新债。
 *
 * ## 职责边界
 *
 * - 本组件：把 props 转成 hook 参数、决定是否显示（`canEdit` + 语言可翻译）、L1 预热
 * - `useCommentTranslateActions`：状态机与副作用
 * - `CommentTranslationToolbar`：纯展示
 */
export interface CommentTranslationBarProps {
  /** 文件路径（语言家族判定 + 传给引擎）。 */
  filePath: string;
  /** 所属项目（agent 会话绑定）。 */
  projectId: ProjectId;
  editorViewRef: React.MutableRefObject<EditorView | null>;
  /** 当前文档内容（用于检测过期译文）。 */
  content: string;
  /** 不可编辑的文件不显示入口。 */
  canEdit: boolean;
}

const CommentTranslationBar: React.FC<CommentTranslationBarProps> = ({
  filePath,
  projectId,
  editorViewRef,
  content,
  canEdit,
}) => {
  // 默认项直接读全局配置（AppConfig.translation）—— 少一层 props 透传，
  // 也让调用方（FileEditor）不必为此增加行数（它贴着 300 行红线）。
  const { config } = useAppContext();
  const defaults = config.translation;
  const actions = useCommentTranslateActions({
    filePath,
    projectId,
    editorViewRef,
    agentId: defaults?.agentId ?? 'opencode',
    modelId: defaults?.modelId ?? null,
    targetLanguage: defaults?.targetLanguage,
    defaultMode: defaults?.commentMode,
    content,
  });

  /**
   * L1 预热（PRD R7：打开文件即翻译，**默认关**）。
   *
   * `commentAutoWarm` 曾在 `settings.ts` 与 `appConfigNormalize.ts` 里定义、归一化，
   * 但全仓无读取方 —— 开关建好却没通电。这里补上唯一读取点。
   *
   * **必须防重入**：`actions.start` 的身份随内部状态变化，effect 会因此重跑；
   * 若不用 ref 记录「本文件已预热过」，每次重渲都会再发一次请求。
   * 记录的是 **文件路径** 而不是布尔值 —— 切文件（`filePath` 变）自然重置。
   */
  const autoWarm = defaults?.commentAutoWarm === true;
  const lastWarmedFileRef = useRef<string | null>(null);
  const start = actions.start;
  const supported = actions.supported;
  useEffect(() => {
    if (!autoWarm || !supported) return;
    if (lastWarmedFileRef.current === filePath) return;
    lastWarmedFileRef.current = filePath;
    void start();
  }, [autoWarm, supported, start, filePath]);

  // 不可编辑 / 语言无注释语义 → 不显示（宁可没有按钮，也不给错按钮）
  if (!canEdit || !actions.supported) return null;

  return (
    <CommentTranslationToolbar
      running={actions.state.running}
      mode={actions.state.mode}
      total={actions.state.total}
      done={actions.state.done}
      codeSegments={actions.state.codeSegments}
      skippedGroups={actions.state.skippedGroups}
      failed={actions.state.failed}
      cacheHits={actions.state.cacheHits}
      onModeChange={actions.setMode}
      onStart={actions.start}
      onStop={actions.stop}
      onRetryFailed={actions.retryFailed}
    />
  );
};

export default React.memo(CommentTranslationBar);
