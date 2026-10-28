import * as React from 'react';

import { cn } from '@/lib/utils';

interface RadioProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** 单选按钮右侧的标签文字 */
  children?: React.ReactNode;
  className?: string;
}

/**
 * 单选按钮（原生 input + Tailwind 表达视觉，无 CSS 文件依赖）。
 *
 * ## 为什么不用 Radix
 *
 * 仓库未安装 `@radix-ui/react-radio-group`，而这里只需要「一个带视觉圆点的
 * radio 标签」——用原生 `input` + `peer` 变体即可，无需引入新依赖（YAGNI）。
 * 需要成组键盘导航（方向键切换）时再引入 Radix。
 *
 * ## 为什么从 CSS 迁到 Tailwind
 *
 * 原实现是 `src/styles/components/form.css` 的 14 行 CSS（`.custom-radio`），
 * 只服务这一个控件、只有一个顶层类 —— 不构成一个「组件域」，却占了
 * `components/` 里的一个文件位。改为组件内 Tailwind 后：
 *
 * - 少一个 CSS 文件（`components/` 的准入判据见 `src/styles/README.md`）
 * - 三处调用（`RemoteDialog` ×2、`RemoteAuthDialog` ×1）不再各自复制 class 串
 * - 视觉与状态逻辑收敛到唯一来源
 *
 * ## 与旧 CSS 的行为等价
 *
 * | 旧 CSS | 现 Tailwind |
 * | --- | --- |
 * | `position:absolute; opacity:0; w/h:0` | `sr-only`（标准可访问隐藏，仍可聚焦） |
 * | `border: 1.5px solid var(--border-color)` | `border-[1.5px] border-border` |
 * | `background: var(--bg-tertiary)` | `bg-bg-tertiary` |
 * | `.radio-mark::after` + `input:checked ~` | `after:*` + `peer-checked:after:*` |
 * | `.custom-radio:hover .radio-mark` | `group-hover:` |
 *
 * 额外补了 `peer-focus-visible:ring-2`：原实现键盘聚焦时**没有任何视觉反馈**
 * （input 被 `opacity:0` 隐藏），属可访问性缺陷。与本任务的 focus-visible
 * 修复口径一致。
 *
 * ## 已知边界：claude 主题的圆点对比度 2.95
 *
 * 实测「视觉圆点 `--accent-blue` vs 轨道 `--bg-tertiary`」的 5 主题对比度：
 *
 * | 主题 | 对比 |
 * | --- | --- |
 * | classic-dark | 4.17 |
 * | dark | 5.69 |
 * | light | 3.89 |
 * | one-dark-pro | 4.98 |
 * | **claude** | **2.95** ← 略低于 WCAG 非文本对比度 3.0 |
 *
 * 这是**从原 CSS 继承的既有状态**（原 `.custom-radio .radio-mark::after`
 * 用的也是 `var(--accent-blue)`），不是迁移引入的。本轮迁移的原则是「行为零漂移」，
 * 故不改值 —— 改它需要调 claude 主题的 `--accent-blue` 或 `--bg-tertiary`，
 * 会影响整个主题而不是这一个控件。
 *
 * 风险可控的依据：与 Switch（曾单靠填充色表达选中态、对比 1.08 几乎不可见不同）
 * 不同，radio 的选中态有**两道**指示 —— accent 边框 + 实心圆点。
 * 若后续要做对比度专项审计，这是清单上的一项。
 *
 * ## 成组（键盘方向键切换）需要调用方传 `name`
 *
 * props 会透传给原生 `<input>`，所以同一个 `name` 的两个 `<Radio>` 天然是
 * 一个原生 radio group，方向键可切换。**当前三个调用点都没传 `name`**
 * （`RemoteDialog` ×2、`RemoteAuthDialog` ×1）—— 这与迁移前的 CSS 版行为一致，
 * 属既存状态，不是本组件的能力缺失。
 *
 * 新增用法请传 `name`：
 *
 * ```tsx
 * <Radio name="auth" checked={t === 'password'} onChange={...}>Password</Radio>
 * <Radio name="auth" checked={t === 'key'} onChange={...}>Key File</Radio>
 * ```
 */
/**
 * 视觉圆点的 class 契约。
 *
 * 导出是为了让单测直接断言 —— 圆点是 `aria-hidden` 的纯装饰元素，
 * 用 DOM 查询取它会触发 `testing-library/no-node-access`，
 * 而这条契约本来就不依赖渲染结果（与 `ui/Switch.tsx` 同一手法）。
 */
const RADIO_MARK_CLASS = [
  'size-[15px] shrink-0 rounded-full border-[1.5px] border-border bg-bg-tertiary',
  'flex items-center justify-center transition-colors',
  // 视觉圆点：7px 实心，未选中 scale-0，选中 scale-100
  'after:size-[7px] after:rounded-full after:bg-accent-blue after:scale-0',
  "after:transition-transform after:content-['']",
  'peer-checked:border-accent-blue peer-checked:after:scale-100',
  'group-hover:border-accent-blue',
  'peer-focus-visible:ring-2 peer-focus-visible:ring-accent-blue peer-focus-visible:ring-offset-1',
].join(' ');

function Radio({ children, className, ...props }: RadioProps) {
  return (
    <label
      className={cn(
        'group inline-flex items-center gap-1.5 cursor-pointer text-text-secondary',
        className,
      )}
    >
      <input type="radio" className="peer sr-only" {...props} />
      <span aria-hidden="true" className={RADIO_MARK_CLASS} />
      {children}
    </label>
  );
}

export { RADIO_MARK_CLASS, Radio };
