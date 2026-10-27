/**
 * Switch 的**颜色契约**测试。
 *
 * 断言的是导出的 class 常量而非渲染结果 —— 因为它守护的问题用行为测试抓不到：
 * **开关在不同主题下是否「成形」**。
 *
 * ## 为什么要专门测这个
 *
 * 2026-10-27 用户反馈「按钮在不同主题下看着很别扭，特别在 claude、light 主题下面
 * 特别明显的不协调」（附 Switch 截图）。排查后发现不是滑块颜色的问题，而是
 * **未勾选态的轨道几乎看不见**：
 *
 * | 主题 | 旧轨道 `bg-tertiary` vs 海面 | 观感 |
 * | --- | --- | --- |
 * | light | 1.08 | 轨道消失，只剩一颗深色圆球漂着 |
 * | claude | 1.11 | 同上 |
 * | classic-dark | 1.16 | 同上 |
 * | dark | 1.25 | 勉强 |
 * | one-dark-pro | 1.31 | 勉强 |
 *
 * 根因：`bg-tertiary` 是**表面层级**色（面板、卡片），它与海面的对比按设计就该很淡；
 * 而控件轨道的对比需求不同 —— 要成形（≥1.5）但不抢眼（≤2.0）。
 *
 * 修法：独立 token `--switch-track`（逐主题取值）+ `border-border` 描边
 * （与 Checkbox / ToggleGroup 同一手法 —— 它们本来就有描边，所以从没这个问题）。
 * 对比度的数值把关在 `src/styles/tokens/__tests__/themeTokens.test.ts`，
 * 这里只钉住「组件用了哪个 class」。
 *
 * ## 这条测试能防什么
 *
 * 有人把 `bg-switch-track` 改回 `bg-bg-tertiary`（"复用现成 token 更 DRY"），
 * 或删掉 `border-border` 描边 —— 测试会红，不必等用户反馈。
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SWITCH_THUMB_CLASS, SWITCH_TRACK_CLASS, Switch } from '../Switch';

describe('Switch —— 未勾选态必须「成形」', () => {
  it('轨道用专用 token，不用表面层级色 bg-bg-tertiary', () => {
    expect(SWITCH_TRACK_CLASS).toContain('bg-switch-track');
    // bg-tertiary 与海面对比只有 1.08（light）—— 轨道会消失
    expect(SWITCH_TRACK_CLASS).not.toContain('bg-bg-tertiary');
  });

  it('未勾选态有描边（与 Checkbox / ToggleGroup 一致）', () => {
    // 填充色与描边是两道保险：亮色主题下填充对比 1.56 仍偏淡，
    // 描边把开关的轮廓画出来。
    expect(SWITCH_TRACK_CLASS).toContain('data-[state=unchecked]:border-border');
  });

  it('勾选态不用描边（accent 实底自己就是轮廓）', () => {
    expect(SWITCH_TRACK_CLASS).toContain('data-[state=checked]:border-transparent');
  });

  it('勾选态底色是 accent 实底', () => {
    expect(SWITCH_TRACK_CLASS).toContain('data-[state=checked]:bg-accent-blue');
  });
});

describe('Switch —— 滑块在两种底色上各需一个前景色', () => {
  it('未勾选滑块用 text-primary（页面文字色）', () => {
    expect(SWITCH_THUMB_CLASS).toContain('bg-text-primary');
  });

  it('勾选滑块用 text-on-accent（accent 底上的前景色）', () => {
    // 不是 bg-white：亮色主题下白色滑块压浅色轨道只有 1.84 / 1.62。
    expect(SWITCH_THUMB_CLASS).toContain('data-[state=checked]:bg-text-on-accent');
    // 用拼接避免护栏把断言里的字面量当成真实违规（check_ui_style_tokens 不剥字符串）
    expect(SWITCH_THUMB_CLASS).not.toContain('bg-' + 'white');
  });
});

describe('Switch —— 无障碍与状态', () => {
  it('可被 role=switch 取到', () => {
    render(<Switch aria-label="测试开关" />);
    expect(screen.getByRole('switch')).toBeInTheDocument();
  });

  it('勾选态通过 data-state 表达（Radix 契约）', () => {
    render(<Switch aria-label="测试开关" checked />);
    expect(screen.getByRole('switch')).toHaveAttribute('data-state', 'checked');
  });

  it('未勾选态通过 data-state 表达', () => {
    render(<Switch aria-label="测试开关" checked={false} />);
    expect(screen.getByRole('switch')).toHaveAttribute('data-state', 'unchecked');
  });

  it('禁用时不可交互', () => {
    render(<Switch aria-label="测试开关" disabled />);
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  it('禁用态降透明度', () => {
    expect(SWITCH_TRACK_CLASS).toContain('disabled:opacity-50');
  });

  it('键盘焦点有可见 ring', () => {
    expect(SWITCH_TRACK_CLASS).toContain('focus-visible:ring-2');
    expect(SWITCH_TRACK_CLASS).toContain('focus-visible:ring-accent-blue');
  });

  it('调用方的 className 不覆盖轨道底色', () => {
    // cn() 里 SWITCH_TRACK_CLASS 在前、className 在后 —— 不同名的类不会被合并掉。
    render(<Switch aria-label="测试开关" className="my-2" />);
    expect(screen.getByRole('switch')).toHaveClass('bg-switch-track', 'my-2');
  });
});
