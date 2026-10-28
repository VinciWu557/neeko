import * as React from 'react';

/**
 * git 状态行尾徽标（字母 + 状态色 chip）的**唯一渲染口径**。
 *
 * 消费方：文件树（`FileTreeRow`）、PR 变更树（`ChangeFileTree`）、
 * diff 文件头（`FileDiffSection`）。
 *
 * ## 为什么不直接包 `ui/Badge`
 *
 * `Badge` 是**通用 chip**：`text-xs` 固定字阶 + `border` + `px-2.5`。
 * git 状态徽标是**行装饰**，必须跟随「外观字号」设置（`--font-size`）缩放 ——
 * 否则用户调大字号后，行内文字变大而徽标不动（`FileTreeRow` 曾写死 `text-[10px]`，
 * 就是这个症状）。
 *
 * 两者的尺寸语义不同，套在一起必然有一方是错的。所以这里复用**领域口径**
 * （字母与色板来自 `gitFileDecoration` 的 `STATUS_PRESENTATION`），
 * 而不复用**视觉原语**（那是 `Badge` 的职责，通用组件的字阶不该为行装饰让步）。
 *
 * ## 尺寸写法
 *
 * `text-[calc(var(--font-size) - 3px)]` 是 `FileDiffSection` 早已在用的写法
 * （行文字的次级阶梯），此处收敛为唯一实现。不要改回 `text-[10px]` 字面量：
 * `styles/base/tailwind.css` 的字体阶梯注释明确禁止业务层写 `text-[Npx]`。
 */

/**
 * 徽标视觉基类（尺寸 / 形状 / 字重）。
 *
 * 导出供「不是徽标但需同样视觉密度」的极少数场景复用；新增消费方优先用组件本身。
 */
export const GIT_STATUS_BADGE_CLASS =
  'shrink-0 inline-flex items-center px-1.5 py-px rounded-full leading-none font-semibold text-[calc(var(--font-size)-3px)]';

export interface GitStatusBadgeProps {
  /**
   * 徽标字母。
   *
   * 类型是 `string` 而非 `BadgeLetter`：`FileDiffSection` 消费的是后端提交文件的
   * 原始 status 字母（可能超出树状态的封闭词表）。色板对未知字母已有回落
   * （`statusLetterToChipClass` → modified），所以这里不做类型收窄 ——
   * 收窄只会逼调用方伪造字母。
   */
  badge: string;
  /** 状态 chip 类（text + 半透明底）；缺省时只有字母无色底 */
  chip?: string;
  /** 悬停提示（如完整路径或状态说明）；缺省不设 */
  title?: string;
}

/**
 * git 状态徽标。
 *
 * `data-git-status` 是给测试与消费方的**稳定契约** —— 断言这个属性，
 * 而不是断言 `rounded-full` / `text-[10px]` 这类视觉 class
 * （那正是 `text-accent` 事故的同型错误：把样式细节当成语义标识）。
 */
export const GitStatusBadge = React.memo(function GitStatusBadge({
  badge,
  chip,
  title,
}: GitStatusBadgeProps) {
  return (
    <span
      className={chip ? `${GIT_STATUS_BADGE_CLASS} ${chip}` : GIT_STATUS_BADGE_CLASS}
      data-git-status={badge}
      {...(title !== undefined ? { title } : {})}
    >
      {badge}
    </span>
  );
});
