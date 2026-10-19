import React from 'react';

import { cn } from '@/lib/utils';
import { Square } from '@/shared/components/icons';

import type { CommentDisplayMode } from '../comment/commentTranslations';

/**
 * 注释翻译工具条（按原型 `prototypes/comment-translation.html`）。
 *
 * 组合层：只负责渲染与回调，状态与逻辑在 `useCommentTranslation` / 调用方 hook 里。
 *
 * 设计要点（来自原型与用户决策）：
 * - 「翻译注释」是显式动作（L0），不自动跑
 * - 四种显示模式可切（U1 定案默认 `below`）
 * - **跳过统计可见**：用户能看懂为什么某些注释没翻（代码段 / 指令 / 许可证）
 * - 失败数可见并可重试
 * - **两种重试粒度**：本工具条的按钮重试「全部失败组」；「只重试这一组」由编辑器里的
 *   失败 chip 承担（chip 是 widget 的 DOM，按钮是 React 节点，两者到达控制器的路径不同）
 */
export interface CommentTranslationToolbarProps {
  running: boolean;
  mode: CommentDisplayMode;
  /** 可翻译段数（送模型的）。 */
  total: number;
  /** 已完成段数。 */
  done: number;
  /** 代码段数（永不送模型 —— U2）。 */
  codeSegments: number;
  /** 门禁跳过的组数（指令 / 许可证 / shebang）。 */
  skippedGroups: number;
  /** 失败段数。 */
  failed: number;
  /** 缓存命中数（证明增量真的生效）。 */
  cacheHits: number;
  onModeChange: (mode: CommentDisplayMode) => void;
  onStart: () => void;
  onStop: () => void;
  onRetryFailed: () => void;
}

const MODES: Array<{ value: CommentDisplayMode; label: string; title: string }> = [
  { value: 'below', label: '对照', title: '注释下方追加译文块（默认，适合通读）' },
  { value: 'inline', label: '行内', title: '注释行尾追加译文（适合短注释）' },
  { value: 'hover', label: '悬停', title: '译文在浮层里，零视觉噪声' },
  { value: 'off', label: '关闭', title: '只显示原文（写代码时用）' },
];

const STAT_PILL =
  'inline-flex items-center gap-1 rounded-full border border-border bg-bg-secondary px-2 py-[2px] font-mono text-[10px] text-text-muted';

/**
 * 工具条。`React.memo`：父级每次渲染都传新回调时会重渲，但 props 引用稳定时收益明显
 * （`quality-guidelines.md` 必需模式 2；此处 props 含数字与稳定回调，比较有效）。
 */
const CommentTranslationToolbar: React.FC<CommentTranslationToolbarProps> = ({
  running,
  mode,
  total,
  done,
  codeSegments,
  skippedGroups,
  failed,
  cacheHits,
  onModeChange,
  onStart,
  onStop,
  onRetryFailed,
}) => (
  <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/20 px-3 py-1.5">
    <button
      type="button"
      className={cn(
        'rounded-md border px-2 py-1 text-xs',
        running
          ? 'cursor-not-allowed border-border bg-bg-secondary text-text-muted'
          : 'border-accent-blue bg-accent-blue font-medium text-white hover:brightness-110',
      )}
      onClick={onStart}
      disabled={running}
    >
      {total > 0 && done > 0 ? '重新翻译' : '翻译注释'}
    </button>

    {running ? (
      <button
        type="button"
        className="rounded-md border border-[rgba(var(--accent-red-rgb),0.4)] px-2 py-1 text-xs text-accent-red"
        onClick={onStop}
        aria-label="停止翻译"
      >
        <Square className="mr-1 inline h-2.5 w-2.5" />
        停止
      </button>
    ) : null}

    <span className="h-4 w-px bg-border" aria-hidden="true" />

    <span className="text-[11px] text-text-muted">显示</span>
    <div
      className="inline-flex overflow-hidden rounded-md border border-border"
      role="group"
      aria-label="译文显示模式"
    >
      {MODES.map((item, index) => (
        <button
          key={item.value}
          type="button"
          className={cn(
            'px-2 py-1 text-[11px]',
            index > 0 ? 'border-l border-border' : '',
            mode === item.value
              ? 'bg-[rgba(var(--accent-blue-rgb),0.18)] font-semibold text-accent-blue'
              : 'bg-bg-secondary text-text-muted hover:bg-bg-tertiary',
          )}
          aria-pressed={mode === item.value}
          title={item.title}
          onClick={() => onModeChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>

    <span className="flex-1" />

    <span className={STAT_PILL}>
      已译 <b className="text-accent-green">{done}</b>/{total}
    </span>
    <span className={STAT_PILL} title="注释中的代码一律不翻译（含死代码与示例）">
      代码不翻 <b className="text-accent-purple">{codeSegments}</b>
    </span>
    <span className={STAT_PILL} title="工具链指令 / 许可证 / shebang 整组跳过">
      跳过 <b className="text-accent-yellow">{skippedGroups}</b>
    </span>
    {cacheHits > 0 ? (
      <span className={STAT_PILL} title="命中缓存的段数（增量生效的证明）">
        缓存 <b className="text-accent-blue">{cacheHits}</b>
      </span>
    ) : null}
    {failed > 0 ? (
      <button
        type="button"
        className="rounded-full border border-[rgba(var(--accent-red-rgb),0.3)] bg-[rgba(var(--accent-red-rgb),0.1)] px-2 py-[2px] font-mono text-[10px] text-accent-red"
        onClick={onRetryFailed}
        disabled={running}
        title="重试全部校验失败的组（单组重试请点编辑器里的失败 chip）"
      >
        失败 {failed} · 重试全部
      </button>
    ) : null}
  </div>
);

export default React.memo(CommentTranslationToolbar);
