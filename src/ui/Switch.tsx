import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * 轨道（`SwitchPrimitive.Root`）的颜色契约。
 *
 * 导出是为了让单测能直接断言 —— 轨道颜色是**跨主题对比度**问题，
 * 用 DOM 查询断言 class 会触发 `testing-library/no-container` 等规则，
 * 而这条契约本来就不依赖渲染结果。
 */
const SWITCH_TRACK_CLASS = [
  // 未勾选轨道用 --switch-track（控件专属），**不是** bg-tertiary。
  // bg-tertiary 是表面层级色，与海面对比只有 1.08（light）/ 1.11（claude）——
  // 轨道几乎不可见，视觉上只剩一颗深色圆球漂在背景上（用户 2026-10-27 反馈
  // 「特别在 claude、light 主题下面特别明显的不协调」就是这个）。
  //
  // 控件的对比需求与表面层级不同：要成形（≥1.5）但不抢眼（≤2.0）。
  //
  // 基础类 + 未勾选态各写一次：Radix 在首帧可能还没有 data-state，
  // 只有变体类的话会闪一下透明底。
  'bg-switch-track',
  'data-[state=unchecked]:bg-switch-track data-[state=unchecked]:border-border',
  // 勾选态：accent 实底自己就是轮廓，去掉描边
  'data-[state=checked]:bg-accent-blue data-[state=checked]:border-transparent',
  'focus-visible:ring-2 focus-visible:ring-accent-blue focus-visible:ring-offset-1',
  'disabled:cursor-not-allowed disabled:opacity-50',
].join(' ');

/**
 * 滑块（`SwitchPrimitive.Thumb`）的颜色契约。
 *
 * 滑块在两种底色上各需一个前景色：
 *   勾选态   底 = accent-blue  → `text-on-accent`（accent 底上的前景色）
 *   未勾选态 底 = switch-track → `text-primary`（页面文字色）
 *
 * 2026-10-27 返工：原实现是 `bg-white`，只在暗色主题成立；
 * 首版改成 `bg-text-primary`（页面文字色）也不对 —— Claude 主题下 accent 是
 * 赭红 #c96442，text-primary 是深棕 #2d1e14，深棕滑块在赭红轨道上糊成一团。
 *
 * 实测（新轨道色下）：text-primary 在 5 个主题的对比是 4.67 ~ 11.58，
 * 而白色滑块在亮色主题只有 1.84 / 1.62 —— 所以亮底必须用深色滑块，
 * 「统一用白色」是行不通的。
 */
const SWITCH_THUMB_CLASS = [
  'pointer-events-none block size-4 rounded-full bg-text-primary shadow-sm ring-0 transition-transform duration-200',
  'data-[state=checked]:bg-text-on-accent',
  'data-[state=checked]:translate-x-4',
  'data-[state=unchecked]:translate-x-0',
].join(' ');

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200',
        SWITCH_TRACK_CLASS,
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb data-slot="switch-thumb" className={SWITCH_THUMB_CLASS} />
    </SwitchPrimitive.Root>
  );
}

export { SWITCH_THUMB_CLASS, SWITCH_TRACK_CLASS, Switch };
