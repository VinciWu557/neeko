import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useEditorContext } from '@/shared/contexts';
import { resolveTranslationAgentId, translatableAgents } from '@/shared/utils/agents';
import { isMarkdownFile } from '@/shared/utils/codemirror';
import { isHtmlFile, isTxtFile } from '@/shared/utils/fileTree';
import type { ProjectId } from '@/shared/utils/workspaceRef';

import { splitHtmlBlocks, splitMarkdownBlocks, splitTextBlocks } from './blocks';
import {
  ensureTranslationTabCleanupRegistered,
  registerAbortController,
  translationKeyFor,
  unregisterAbortController,
} from './cleanup';
import { planBatchesAndTranslate } from './pipeline';
import { useTranslationStore } from './store';
import { createTauriTurn } from './tauriTurn';

/** 批次 token 预算（约一次请求 3-5 个中等段落） */
const TOKEN_BUDGET = 2000;

export const DEFAULT_TARGET_LANGUAGE = '简体中文';

/** 按文件类型切分文档块（md AST / HTML DOM / txt 空行） */
export function splitDocumentBlocks(filePath: string, content: string) {
  if (isMarkdownFile(filePath)) return splitMarkdownBlocks(content);
  if (isHtmlFile(filePath)) return splitHtmlBlocks(content);
  if (isTxtFile(filePath)) return splitTextBlocks(content);
  return [];
}

export function isTranslatableFile(filePath: string): boolean {
  return isMarkdownFile(filePath) || isHtmlFile(filePath) || isTxtFile(filePath);
}

export interface UseDocumentTranslationParams {
  filePath: string;
  content: string;
  projectId: ProjectId;
  /** 设置中的默认项（AppConfig.translation） */
  defaultAgentId?: string;
  defaultModelId?: string;
  defaultTargetLanguage?: string;
  /** 仅在「Translate」视图激活时驱动 */
  enabled: boolean;
}

/**
 * 译文视图控制器。
 *
 * 交互契约：进入视图只初始化选择器（不翻译），用户确认语言 / Agent / 模型后
 * 点击「Translate」才发起；选择器状态持久于 store，视图切换往返不丢。
 * 翻译状态按文件（projectId + filePath）键控——不同文件互不串扰；
 * 关闭文件 tab 时由 tab cleanup 回收状态并中止进行中的翻译。
 */
export function useDocumentTranslation({
  filePath,
  content,
  projectId,
  defaultAgentId,
  defaultModelId,
  defaultTargetLanguage,
  enabled,
}: UseDocumentTranslationParams) {
  const { agents } = useEditorContext();
  // 按文件键控（项目 tabKey 是项目级的，跨文件共享会导致内容串扰）
  const tabKey = useMemo(() => translationKeyFor(projectId, filePath), [projectId, filePath]);
  ensureTranslationTabCleanupRegistered();
  const snapshot = useTranslationStore((s) => s.byTab[tabKey]);
  const initSelectors = useTranslationStore((s) => s.initSelectors);
  const setSelectors = useTranslationStore((s) => s.setSelectors);
  const selectAgent = useTranslationStore((s) => s.selectAgent);
  const startInStore = useTranslationStore((s) => s.start);
  const setTranslations = useTranslationStore((s) => s.setTranslations);
  const setFailed = useTranslationStore((s) => s.setFailed);
  const setPhase = useTranslationStore((s) => s.setPhase);
  const markStale = useTranslationStore((s) => s.markStale);

  // 翻译走 AgentAdapter 抽象（adapter_for），仅 CHAT 能力的 agent 可选。
  // 判据归 `translatableAgents` 所有 —— 本文件此前有 3 处各写一遍。
  const chatAgents = useMemo(() => translatableAgents(agents), [agents]);

  const [bilingual, setBilingual] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  // 进入视图：初始化选择器（已有条目则原样保留，不覆盖用户选择）
  useEffect(() => {
    if (!enabled) return;
    initSelectors(tabKey, {
      targetLanguage: defaultTargetLanguage || DEFAULT_TARGET_LANGUAGE,
      agentId: resolveTranslationAgentId(defaultAgentId, agents),
      modelId: defaultModelId || null,
    });
    // defaults 与 chatAgents 变化不覆盖已初始化的选择器，故不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, tabKey]);

  // 底层文件内容变更 → 已有译文标记过期（不自动重译，共识 Q9）
  useEffect(() => {
    if (!enabled || !snapshot?.source) return;
    if (snapshot.source !== content && snapshot.phase !== 'stale') {
      markStale(tabKey);
    }
  }, [content, enabled, snapshot, tabKey, markStale]);

  const start = useCallback(() => {
    const current = useTranslationStore.getState().byTab[tabKey];
    if (!current) return;
    const blocks = splitDocumentBlocks(filePath, content);
    if (blocks.length === 0) return;

    // 存储的选择器可能因 agent 能力变化而失效 → 发起前再解析一次。
    // 与初始化用同一个函数：两处判据若各写一遍，漂移时不会报错。
    const agentId = resolveTranslationAgentId(current.agentId, agents);

    startInStore(tabKey, { source: content, blocks });
    const controller = new AbortController();
    abortRef.current = controller;
    registerAbortController(tabKey, controller);
    const turn = createTauriTurn({
      agentId,
      projectId,
      modelId: current.modelId,
      onError: (message) => console.error('[translation]', message),
    });
    planBatchesAndTranslate(blocks, {
      targetLanguage: current.targetLanguage,
      tokenBudget: TOKEN_BUDGET,
      turn,
      signal: controller.signal,
      onBlockDone: (map) => setTranslations(tabKey, map),
      onBlockFail: (ids) => setFailed(tabKey, ids),
    })
      .finally(() => unregisterAbortController(tabKey, controller))
      .then((result) => setPhase(tabKey, result.aborted ? 'aborted' : 'done'))
      .catch(() => setPhase(tabKey, 'aborted'));
  }, [
    chatAgents,
    content,
    filePath,
    projectId,
    setFailed,
    setPhase,
    setTranslations,
    startInStore,
    tabKey,
  ]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const retranslate = useCallback(() => {
    stop();
    start();
  }, [start, stop]);

  /** 失败段单段重试（只重跑失败块，成功译文保留） */
  const retryFailed = useCallback(() => {
    if (!snapshot) return;
    const failedBlocks = snapshot.blocks.filter((b) => snapshot.failedIds.includes(b.id));
    if (failedBlocks.length === 0) return;
    setPhase(tabKey, 'running');
    const controller = new AbortController();
    abortRef.current = controller;
    registerAbortController(tabKey, controller);
    const turn = createTauriTurn({
      agentId: snapshot.agentId,
      projectId,
      modelId: snapshot.modelId,
      onError: (message) => console.error('[translation]', message),
    });
    planBatchesAndTranslate(failedBlocks, {
      targetLanguage: snapshot.targetLanguage,
      tokenBudget: TOKEN_BUDGET,
      turn,
      signal: controller.signal,
      onBlockDone: (map) => setTranslations(tabKey, map),
      onBlockFail: (ids) => setFailed(tabKey, ids),
    })
      .finally(() => unregisterAbortController(tabKey, controller))
      .then(() => {
        const failed = useTranslationStore.getState().byTab[tabKey]?.failedIds ?? [];
        setPhase(tabKey, failed.length > 0 ? 'aborted' : 'done');
      })
      .catch(() => setPhase(tabKey, 'aborted'));
  }, [projectId, setFailed, setPhase, setTranslations, snapshot, tabKey]);

  /** 非可翻译文件不驱动任何逻辑 */
  if (!isTranslatableFile(filePath)) {
    return null;
  }

  return {
    snapshot,
    chatAgents,
    targetLanguage: snapshot?.targetLanguage ?? DEFAULT_TARGET_LANGUAGE,
    // 与注释翻译走同一个解析器：snapshot 里存的是历史选择，agent 可能已被删除、
    // 失去 chat 能力或被停用。直接下发会让翻译在运行时失败，而本地就能判定。
    // 传原始 `agents`（不传已筛的 `chatAgents`）：判据在解析器内部，调用方不预筛 ——
    // 预筛会让「双重过滤幂等」成为隐含要求，而下一步的改动很容易破坏它。
    agentId: resolveTranslationAgentId(snapshot?.agentId, agents),
    modelId: snapshot?.modelId ?? null,
    bilingual,
    setTargetLanguage: (v: string) => setSelectors(tabKey, { targetLanguage: v }),
    // 走 `selectAgent`（而非 `setSelectors`）：换 agent 必须连带清掉 modelId ——
    // 模型属于 agent，旧 id 对新 agent 无意义，下发会得到一个不存在的模型。
    setAgentId: (v: string) => selectAgent(tabKey, v),
    setModelId: (v: string | null) => setSelectors(tabKey, { modelId: v }),
    setBilingual,
    start,
    stop,
    retranslate,
    retryFailed,
  };
}
