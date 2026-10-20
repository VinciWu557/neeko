import type { EditorView } from '@codemirror/view';
import React, { useEffect, useMemo, useRef } from 'react';

import { Languages, Loader2 } from '@/shared/components/icons';
import { useAppContext } from '@/shared/contexts/AppContext';
import { resolveTranslationAgentId } from '@/shared/utils/agents';
import { sameIdentity } from '@/shared/utils/fileRef';
import type { ProjectId } from '@/shared/utils/workspaceRef';

import { useCommentTranslateActions } from '../hooks/useCommentTranslateActions';

/**
 * 注释翻译的**编辑器头部入口**（搜索按钮旁的一个图标按钮）。
 *
 * ## 为什么是图标按钮而不是工具条
 *
 * 工具条常驻会吃掉一行垂直空间 —— 而这一行在 90% 的时间里只是显示四个统计数字，
 * 用户一个都不需要读。真正需要随时可用的动作只有一个：翻译 / 停止。
 *
 * 可配置项（显示模式、默认 Agent、默认语言、打开即翻译）全部挪到
 * Settings › Editor：那是「设置一次」的东西，不该占一个常驻行。
 *
 * ## 自包含
 *
 * 组件自己读 `AppConfig.translation`、自己持有翻译状态机、自己解析可用的 agent。
 * 调用方（`EditorHeader`）只传「翻译哪个文件」所需的最小上下文：文件路径、项目、
 * view 引用、当前内容。这样 `FileEditor` 与 `EditorHeader` 都不必为翻译新增超过
 * 一行的代码 —— 两者都贴着 `check_component_size` 的 300 行 ratchet 红线。
 *
 * ## 三种外观（点击行为固定为「翻译 / 重新翻译」）
 *
 * | 状态 | 外观 | 点击 |
 * | --- | --- | --- |
 * | 空闲、无结果 | `Languages` 图标 | 开始翻译 |
 * | 空闲、已有结果 | 图标高亮（`aria-pressed`） | 重新翻译 |
 * | 运行中 | `Loader2` 旋转 | 停止 |
 */
export interface CommentTranslationButtonProps {
  filePath: string;
  projectId: ProjectId;
  editorViewRef: React.MutableRefObject<EditorView | null>;
  /** 当前文档内容（用于判断已有译文是否过期）。 */
  content: string;
}

const ICON_BTN =
  'tb-icon-btn w-6 h-6 rounded-md flex items-center justify-center transition-colors';

const CommentTranslationButton: React.FC<CommentTranslationButtonProps> = ({
  filePath,
  projectId,
  editorViewRef,
  content,
}) => {
  const { config, agents } = useAppContext();
  const defaults = config.translation;

  // 配置里的 agentId 可能已经陈旧（agent 被删 / 失去 chat 能力 / 被停用）。
  // 可用性判定归 `resolveTranslationAgentId` 所有 —— 调用方只传原始列表，
  // 不自己过滤（否则「什么算可用」会随调用方漂移，实测已漂移过一次）。
  const agentId = useMemo(
    () => resolveTranslationAgentId(defaults?.agentId, agents),
    [defaults?.agentId, agents],
  );
  const actions = useCommentTranslateActions({
    filePath,
    projectId,
    editorViewRef,
    agentId,
    modelId: defaults?.modelId ?? null,
    targetLanguage: defaults?.targetLanguage,
    defaultMode: defaults?.commentMode,
    content,
  });

  /**
   * L1 预热（PRD R7：打开文件即翻译，**默认关**，配置在 Settings › Editor）。
   *
   * 防重入记录的是**文件路径**而不是布尔值：`actions.start` 的身份随内部状态变化，
   * effect 会因此重跑；若不用 ref 记住「本文件已预热过」，每次重渲都会再发一次请求。
   * 切文件（`filePath` 变）自然重置。
   */
  const autoWarm = defaults?.commentAutoWarm === true;
  const lastWarmedFileRef = useRef<string | null>(null);
  const start = actions.start;
  const supported = actions.supported;
  useEffect(() => {
    if (!autoWarm || !supported) return;
    // 红线 12：同文件判定走 `FileRef`，不自行做字符串等值（两种路径表示会让判据分叉）。
    if (lastWarmedFileRef.current !== null && sameIdentity(lastWarmedFileRef.current, filePath)) {
      return;
    }
    lastWarmedFileRef.current = filePath;
    void start();
  }, [autoWarm, supported, start, filePath]);

  const { running, total, done, failed } = actions.state;
  const hasResult = total > 0 && done > 0;

  // 入口显示判据分两处，各有明确归属：
  // - **可编辑性**（只读 / 二进制 / 超大文件）由 `FileEditorView` 判 —— 那是编辑器能力问题，
  //   与翻译无关；不经此组件，避免把它变成「编辑器能力聚合器」。
  // - **语言是否可翻译**由这里判 —— `extractComments` 对 unknown 家族静默返回空，
  //   不判就会出现「点了按钮什么都不发生」，比不显示按钮更糟。
  if (!actions.supported) return null;

  const label = running
    ? `停止翻译（已译 ${done} / ${total}）`
    : hasResult
      ? '重新翻译注释（已有译文）'
      : '翻译注释';

  return (
    <button
      type="button"
      className={
        running
          ? `${ICON_BTN} text-accent-blue`
          : hasResult
            ? `${ICON_BTN} bg-bg-selected text-text-primary`
            : `${ICON_BTN} text-text-secondary hover:bg-bg-hover hover:text-text-primary`
      }
      onClick={() => {
        if (running) {
          actions.stop();
        } else {
          void actions.start();
        }
      }}
      title={failed > 0 && !running ? `${label}（上次有 ${failed} 组失败）` : label}
      aria-label={label}
      aria-pressed={running || hasResult}
    >
      {running ? <Loader2 size={14} className="animate-spin" /> : <Languages size={14} />}
    </button>
  );
};

export default React.memo(CommentTranslationButton);
