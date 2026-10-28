import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { GitStatusBadge } from '../GitStatusBadge';

/**
 * git 状态徽标的**渲染契约**。
 *
 * ## 为什么需要这个组件（本测试守的是什么）
 *
 * 同一个语义元素（git 状态字母）曾有 **三套 DOM、三种长相**：
 *
 * | 位置 | 实际样式 |
 * | --- | --- |
 * | `ChangeFileTree` | `<Badge>` → `rounded-full border px-2.5 text-xs` |
 * | `FileTreeRow` | 手写 span → `rounded px-1 text-[10px]` |
 * | `FileDiffSection` | 手写 span → `rounded-full px-1.5 text-[calc(var(--font-size)-3px)]` |
 *
 * 色板早已单一来源（`gitFileDecoration` 的 `STATUS_PRESENTATION`），
 * **形状没有**。测试守住的是「只有一个渲染口径」这件事本身：
 * 字母、色板、尺寸、稳定属性。
 */
describe('GitStatusBadge —— 单一渲染口径', () => {
  const CHIP = 'text-git-status-modified bg-git-status-modified/15';

  it('渲染徽标字母作为文本内容', () => {
    render(<GitStatusBadge badge="M" chip={CHIP} />);
    expect(screen.getByText('M')).toBeInTheDocument();
  });

  it('套用状态色板 class（唯一来源 = gitFileDecoration）', () => {
    render(<GitStatusBadge badge="A" chip="text-git-status-added bg-git-status-added/15" />);
    const el = screen.getByText('A');
    expect(el).toHaveClass('text-git-status-added', 'bg-git-status-added/15');
  });

  it('暴露 data-git-status 作为稳定契约（测试/消费方不该断言 class 字符串）', () => {
    render(<GitStatusBadge badge="D" chip={CHIP} />);
    expect(screen.getByText('D')).toHaveAttribute('data-git-status', 'D');
  });

  it('尺寸跟随 --font-size，而不是写死像素', () => {
    // 行装饰必须跟随「外观字号」设置联动：写死 text-[10px] 时用户调字号徽标不动，
    // 与行内其它文字脱节。这是 FileDiffSection 早就在用的写法，此处收敛为唯一实现。
    render(<GitStatusBadge badge="R" chip={CHIP} />);
    const el = screen.getByText('R');
    expect(el).toHaveClass('text-[calc(var(--font-size)-3px)]');
    // 反向：不得回退到写死像素（styles/base/tailwind.css 明令业务层禁止 text-[Npx]）
    expect(el).not.toHaveClass('text-[10px]');
  });

  it('允许缺省 chip（调用方只有字母时仍能渲染）', () => {
    render(<GitStatusBadge badge="U" />);
    expect(screen.getByText('U')).toBeInTheDocument();
  });
});
