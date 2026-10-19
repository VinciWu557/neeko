/**
 * 注释翻译的编辑器动作层（方案 A：编辑器内入口）。
 *
 * ## 为什么是 hook 而不是组件内逻辑
 *
 * `FileEditor` 只负责组装；翻译的状态机（运行/停止/重试/模式）与副作用归本 hook。
 * 这样 `FileEditor` 零膨胀，且 hook 可独立测试（`renderHook`）。
 *
 * ## 数据流
 *
 * ```
 * 用户点「翻译注释」
 *   → 从 editorView 取 syntaxTree(state)（复用增量树，不重解析）
 *   → runCommentTranslation（提取→分组→分段→分类→引擎）
 *   → dispatch setCommentTranslations（推送进 StateField）
 *   → commentView 的 ViewPlugin 重算 decoration → 译文出现在编辑器里
 * ```
 *
 * ## 不写盘（R3.1 / AC15）
 *
 * 全程只 dispatch decoration，**不触碰文档**。所以「翻译注释」不会让 tab 变脏。
 */
import { syntaxTree } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createTauriTurn } from '@/features/editor/translation/tauriTurn';
import type { ProjectId } from '@/shared/utils/workspaceRef';

import type { CommentDisplayMode, CommentTranslationEntry } from '../comment/commentTranslations';
import { commentTranslationField, setCommentTranslations } from '../comment/commentTranslations';
import { isTranslatableCommentFile } from '../comment/isTranslatableCommentFile';
import { DEFAULT_COMMENT_MODE, runCommentTranslation } from '../comment/useCommentTranslation';

import { getSharedCommentCache } from './commentTranslationCacheSingleton';
import { useCommentRetryChipBridge } from './useCommentRetryChipBridge';

/** 共享缓存的注入点在 `commentTranslationCacheSingleton.ts`（模块级单例，跨 tab 复用）。 */
export { __setSharedCommentCacheForTests } from './commentTranslationCacheSingleton';

export interface UseCommentTranslateActionsParams {
  filePath: string;
  projectId: ProjectId;
  editorViewRef: React.MutableRefObject<EditorView | null>;
  /** 默认 agent（来自 AppConfig.translation.agentId）。 */
  agentId: string;
  /** 默认模型（可为空 → agent 默认）。 */
  modelId?: string | null;
  targetLanguage?: string;
  /** 默认显示模式（AppConfig.translation.commentMode，缺省 `below`）。 */
  defaultMode?: CommentDisplayMode;
  /** 当前文档内容（用于判断是否需要重新翻译）。 */
  content: string;
}

export interface CommentTranslateState {
  running: boolean;
  mode: CommentDisplayMode;
  total: number;
  done: number;
  codeSegments: number;
  skippedGroups: number;
  failed: number;
  cacheHits: number;
}

/**
 * 注释翻译动作。
 *
 * 返回的动作全部经 `useCallback` 包裹（`hook-guidelines.md` 常见错误 4）。
 */
export function useCommentTranslateActions(params: UseCommentTranslateActionsParams) {
  const {
    filePath,
    projectId,
    editorViewRef,
    agentId,
    modelId,
    targetLanguage = '简体中文',
    defaultMode = DEFAULT_COMMENT_MODE,
    content,
  } = params;

  const [state, setState] = useState<CommentTranslateState>({
    running: false,
    mode: defaultMode,
    total: 0,
    done: 0,
    codeSegments: 0,
    skippedGroups: 0,
    failed: 0,
    cacheHits: 0,
  });

  const abortRef = useRef<{ aborted: boolean } | null>(null);
  /** 上次翻译时的文档内容（用于判断「已有译文是否过期」）。 */
  const lastSourceRef = useRef<string | null>(null);

  // 默认模式来自配置；配置变化时同步（但不覆盖用户本次会话的选择）
  const initialModeRef = useRef<CommentDisplayMode>(defaultMode);
  useEffect(() => {
    if (initialModeRef.current === defaultMode) return;
    initialModeRef.current = defaultMode;
    setState((prev) => (prev.running ? prev : { ...prev, mode: defaultMode }));
  }, [defaultMode]);

  const translatable = useMemo(() => isTranslatableCommentFile(filePath), [filePath]);

  /** 推送译文到编辑器（唯一写入口）。 */
  const push = useCallback(
    (mode: CommentDisplayMode, entries: readonly CommentTranslationEntry[]) => {
      const view = editorViewRef.current;
      if (!view) return;
      view.dispatch({ effects: setCommentTranslations.of({ mode, entries }) });
    },
    [editorViewRef],
  );

  /** 设置显示模式（立即重绘已有译文）。 */
  const setMode = useCallback(
    (mode: CommentDisplayMode) => {
      setState((prev) => ({ ...prev, mode }));
      const view = editorViewRef.current;
      if (!view) return;
      // 直接读 StateField 现有条目，只改 mode
      void import('../comment/commentTranslations').then(({ commentTranslationField }) => {
        const current = view.state.field(commentTranslationField, false);
        view.dispatch({
          effects: setCommentTranslations.of({
            mode,
            entries: current ? [...current.entries] : [],
          }),
        });
      });
    },
    [editorViewRef],
  );

  /**
   * 跑一次翻译。
   *
   * `onlyGroups` 提供时只重算这些组（R6.6 单组重试），并把**现有 entries**一并交给控制器
   * 合并 —— `setCommentTranslations` 是整体替换语义，不合并就会把其余组的译文清空。
   */
  const run = useCallback(
    async (onlyGroups?: readonly number[]) => {
      if (!translatable || state.running) return;
      const view = editorViewRef.current;
      if (!view) return;

      const source = view.state.doc.toString();
      const tree = syntaxTree(view.state);
      const cache = await getSharedCommentCache();
      const abort = { aborted: false };
      abortRef.current = abort;

      // 重试单组时把现有译文带进控制器：合并职责放在纯函数层（`mergeCommentEntries`），
      // 便于直接断言「其它组的译文仍在」，不必启动 React。
      const previousEntries = view.state.field(commentTranslationField, false)?.entries ?? [];

      setState((prev) => ({ ...prev, running: true, failed: 0 }));
      lastSourceRef.current = source;

      try {
        const result = await runCommentTranslation({
          filePath,
          source,
          tree: tree as never,
          targetLanguage,
          turn: createTauriTurn({ agentId, projectId, modelId }),
          cache,
          signal: abort,
          ...(onlyGroups === undefined ? {} : { onlyGroups, previousEntries }),
          onProgress: (progress) => {
            setState((prev) => ({
              ...prev,
              total: progress.total,
              done: progress.done,
              failed: progress.failed,
              cacheHits: progress.cached,
            }));
          },
        });

        push(state.mode, result.entries);
        setState((prev) => ({
          ...prev,
          running: false,
          // 单组重试只覆盖被重试组的计数，整组统计值保持上一次作业的口径就不对了；
          // 失败数直接从**合并后**的 entries 数出来，重试成功后数字才会真的减少。
          failed: result.entries.filter((entry) => entry.reason !== undefined).length,
          ...(onlyGroups === undefined
            ? {
                total: result.requestedSegments,
                // 工具条的「已译 N/M」是**段级**计数；`entries` 是组级的（一组可能含多段），
                // 用 entry 条数会让分母对不上分子（实测 8 段 3 组显示成 3/8）。
                done: result.translatedSegments,
                codeSegments: result.skipped.codeSegments,
                skippedGroups: Object.values(result.skipped.byKind).reduce((sum, n) => sum + n, 0),
                cacheHits: result.cacheHits,
              }
            : {}),
        }));
      } catch (error) {
        console.error('[CommentTranslation] failed:', error);
        setState((prev) => ({ ...prev, running: false }));
      } finally {
        abortRef.current = null;
      }
    },
    [
      translatable,
      state.running,
      state.mode,
      editorViewRef,
      filePath,
      targetLanguage,
      agentId,
      projectId,
      modelId,
      push,
    ],
  );

  /** 整文件（或全部失败组）翻译。 */
  const start = useCallback(async () => {
    await run();
  }, [run]);

  /**
   * 单组重试（R6.6）：只重算该组，其余组译文原样保留。
   *
   * `groupKey` 是组的 `startLine`（见 `RunCommentTranslationOptions.onlyGroups` 的取舍）。
   */
  const retryGroup = useCallback(
    async (groupKey: number) => {
      await run([groupKey]);
    },
    [run],
  );

  /**
   * 把失败 chip 的点击接到 `retryGroup`（R6.6）。
   *
   * 走模块级注册表而不是把回调塞进 `extensions`：后者会让扩展身份随渲染抖动 →
   * `reconfigure` → 丢 lint 扩展（AC16 / 禁止模式 10）。重注册时机见桥接层注释。
   */
  useCommentRetryChipBridge(editorViewRef, (groupKey) => {
    void retryGroup(groupKey);
  });

  /** 停止（不回收已完成成果）。 */
  const stop = useCallback(() => {
    const abort = abortRef.current;
    if (abort) abort.aborted = true;
  }, []);

  /** 重试失败段（等同于再跑一次；缓存命中的段不会重复请求）。 */
  const retryFailed = useCallback(() => {
    void start();
  }, [start]);

  /**
   * 文档变化 → 已有译文标记过期。
   *
   * 不自动清空（用户可能只是滚动/切 tab 回来），只在内容真的变化时清 ——
   * 位置已由 `StateField` 的 `mapPos` 映射，但内容语义变了，旧译文不再可信。
   */
  useEffect(() => {
    if (lastSourceRef.current === null) return;
    if (lastSourceRef.current === content) return;
    // 内容变了 → 清空译文（避免位置漂移后显示错位译文）
    push(state.mode, []);
    lastSourceRef.current = null;
    setState((prev) => ({ ...prev, total: 0, done: 0, failed: 0, cacheHits: 0 }));
  }, [content, push, state.mode]);

  /** 卸载 / 切文件 → 中止在跑的作业。 */
  useEffect(
    () => () => {
      const abort = abortRef.current;
      if (abort) abort.aborted = true;
    },
    [],
  );

  return {
    /** 该文件是否支持注释翻译（不支持时入口不显示）。 */
    supported: translatable,
    state,
    start,
    stop,
    retryFailed,
    retryGroup,
    setMode,
  };
}
