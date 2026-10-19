import React from 'react';

import { cn } from '@/lib/utils';
import { Square } from '@/shared/components/icons';

import type { CommentDisplayMode } from '../comment/commentTranslations';

/**
 * 注释翻译工具条 —— **形态与文档翻译的 `TranslationToolbar` 保持一致**：
 * 一排扁平控件（配置选择器 + 分段模式 + 右侧主按钮），不堆统计徽章。
 *
 * ## 为什么去掉统计徽章
 *
 * 此前版本把「已译 0/1」「代码不翻 68」「跳过 2」「失败 274」各做成一个圆角 pill
 * 排在右侧。问题不是不好看，而是**信息层级错乱**：四个同等视觉权重的数字里，
 * 用户唯一需要立刻知道的是「这次有没有成功」，其余都是诊断信息。274 这个数字
 * 尤其糟 —— 它把「一批本来就不该翻的段」渲染成了警报。
 *
 * 现在：进度归主按钮（`已译 N/M` 直接进文案），诊断信息进 `title`（hover 可见）。
 *
 * ## 失败不在这里显示
 *
 * 失败按原因分两类处置（见 `TranslateSegmentsResult.failureKinds`）：
 * - **传输层**（断网 / Agent 崩溃 / 超时）→ 右下角通知中心（全局故障，一条告警）
 * - **校验**（译文没过闸）→ 编辑器里失败位置的 chip，点击只重试该组
 *
 * 工具条只保留一个「失败 N · 重试全部」的快捷入口 —— 与文档翻译的「重新翻译」同形，
 * 不做成第四个统计 pill。
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
  /** 缓存命中数。 */
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

/**
 * 工具条。`React.memo`：父级每次渲染都传新回调时会重渲，但 props 引用稳定时收益明显
 * （`quality-guidelines.md` 必需模式 2）。
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
}) => {
  const hasResult = total > 0 && done > 0;
  // 诊断信息收进 title：需要的人 hover 就能看到，不需要的人不必先读懂它。
  const diagnostics = [
    `可翻译 ${total} 段，已译 ${done} 段`,
    `代码不翻 ${codeSegments} 段（注释里的代码一律不翻译，含死代码与示例）`,
    `跳过 ${skippedGroups} 组（工具链指令 / 许可证 / shebang）`,
    ...(cacheHits > 0 ? [`缓存命中 ${cacheHits} 段`] : []),
    ...(failed > 0 ? [`失败 ${failed} 组`] : []),
  ].join('\n');

  return (
    <>
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border/20 bg-bg-secondary/50 flex-wrap">
        <div
          className="flex border border-border rounded-md overflow-hidden"
          role="group"
          aria-label="译文显示模式"
        >
          {MODES.map((item, index) => (
            <button
              key={item.value}
              type="button"
              className={cn(
                'px-2 py-1 text-xs',
                index > 0 ? 'border-l border-border' : '',
                mode === item.value
                  ? 'bg-bg-selected text-text-primary'
                  : 'text-text-muted hover:text-text-primary',
              )}
              aria-pressed={mode === item.value}
              title={item.title}
              onClick={() => onModeChange(item.value)}
              disabled={running}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2" title={diagnostics}>
          {running ? (
            <>
              <span className="text-xs text-text-muted font-mono">
                已译 {done} / {total}
              </span>
              <button
                className="tb-icon-btn w-6 h-6 rounded-md flex items-center justify-center text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                onClick={onStop}
                title="停止"
                aria-label="停止翻译"
                type="button"
              >
                <Square size={12} />
              </button>
            </>
          ) : (
            <>
              {failed > 0 ? (
                <button
                  className="px-2 py-1 text-xs rounded-md text-accent-red hover:bg-[rgba(var(--accent-red-rgb),0.1)] transition-colors"
                  onClick={onRetryFailed}
                  title={`重试全部失败组（共 ${failed} 组）；单组重试请点编辑器里的失败位置`}
                  type="button"
                >
                  失败 {failed} · 重试全部
                </button>
              ) : null}
              <button
                className="px-3 py-1 text-xs rounded-md bg-accent-blue/15 text-accent-blue hover:bg-accent-blue/25 transition-colors"
                onClick={onStart}
                title={hasResult ? '使用当前设置重新翻译' : '开始翻译'}
                type="button"
              >
                {hasResult ? '重新翻译' : '翻译注释'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* 进度条 —— 与文档翻译同形 */}
      {running && (
        <div className="shrink-0 h-0.5 bg-bg-tertiary">
          <div
            className="h-full bg-accent-blue transition-all duration-300"
            style={{ width: `${total === 0 ? 0 : Math.round((done / total) * 100)}%` }}
          />
        </div>
      )}
    </>
  );
};

export default React.memo(CommentTranslationToolbar);
