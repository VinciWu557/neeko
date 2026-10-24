import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import ContextWindowMeter, { formatWan } from '../ContextWindowMeter';
import type { ContextWindow } from '../messageModel';

/** 满额形态：进度条 + 百分比 + 命中率（数值对齐 pi `get_session_stats` 实测形状）。 */
const fullWin: ContextWindow = {
  used: 205_000,
  limit: 1_000_000,
  model: 'auto/dv4',
  cacheHitRate: 197_400 / (1234 + 197_400 + 1200),
};

function openPopover(win: ContextWindow) {
  render(<ContextWindowMeter contextWindow={win} />);
  fireEvent.click(screen.getByRole('button', { name: '查看上下文使用详情' }));
  return screen.getByRole('dialog', { name: '上下文容量详情' });
}

describe('formatWan', () => {
  it('formats sub-10000 values with thousands separators', () => {
    expect(formatWan(0)).toBe('0');
    expect(formatWan(1234)).toBe('1,234');
    expect(formatWan(9999)).toBe('9,999');
  });

  it('formats 万 values with one decimal', () => {
    expect(formatWan(10_000)).toBe('1万');
    expect(formatWan(205_000)).toBe('20.5万');
    // 整万去小数
    expect(formatWan(100_000)).toBe('10万');
    expect(formatWan(1_000_000)).toBe('100万');
  });
});

describe('ContextWindowMeter', () => {
  it('renders a ring-only button: svg present, no text label, numbers in the hover title', () => {
    render(<ContextWindowMeter contextWindow={fullWin} />);
    const btn = screen.getByRole('button', { name: '查看上下文使用详情' });
    // 环形按钮的 svg 无角色可查，尺寸/结构断言必须落到 DOM 查询
    // eslint-disable-next-line testing-library/no-node-access -- 结构断言（svg 查询）
    const svgs = btn.querySelectorAll('svg');
    expect(svgs).toHaveLength(1);
    // 与 composer 邻居图标（lucide size=16）对齐
    expect(svgs[0]).toHaveAttribute('width', '16');
    expect(svgs[0]).toHaveAttribute('height', '16');
    // 无文字标签：百分比/已用量不以文本渲染
    expect(screen.queryByText('20.5%')).not.toBeInTheDocument();
    expect(screen.queryByText('20.5万')).not.toBeInTheDocument();
    // 环色分级之外，数值信息走 hover title
    expect(screen.getByTitle('20.5% · 20.5万/100万 · auto/dv4')).toBeInTheDocument();
  });

  it('renders the popover with head, bar, and cache hit-rate', () => {
    const pop = openPopover(fullWin);
    // 头部：上下文容量 + 20.5万/100万（20.5%）
    expect(pop).toHaveTextContent('上下文容量');
    expect(screen.getByText('20.5万/100万（20.5%）')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.getByText('平均缓存命中率')).toBeInTheDocument();
    // 197400 / (1234+197400+1200) = 98.78% → 一位小数
    expect(screen.getByText('98.8%')).toBeInTheDocument();
    // 低用量档提示
    expect(screen.getByText('容量充足')).toBeInTheDocument();
  });

  it('warns near the limit with the existing three tiers', () => {
    openPopover({ ...fullWin, used: 950_000, limit: 1_000_000 });
    expect(screen.getByText('接近上限，建议开启新会话')).toBeInTheDocument();
  });

  it('warns at high usage with the yellow tier', () => {
    openPopover({ ...fullWin, used: 750_000, limit: 1_000_000 });
    expect(screen.getByText('用量偏高')).toBeInTheDocument();
  });

  it('hides the hit-rate row when cache counters are missing', () => {
    const noCache: ContextWindow = {
      used: fullWin.used,
      limit: fullWin.limit,
      model: fullWin.model,
    };
    openPopover(noCache);
    expect(screen.queryByText('平均缓存命中率')).not.toBeInTheDocument();
    // 进度条不受 cache 缺失影响
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('degrades gracefully without a limit: used only, no bar or percentage', () => {
    render(<ContextWindowMeter contextWindow={{ used: 205_000, limit: null, model: 'm' }} />);
    // 无 limit：按钮无文字，已用量与模型走 hover title（无百分比格式）
    expect(screen.getByTitle('已用 20.5万 · m')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '查看上下文使用详情' }));
    const pop = screen.getByRole('dialog', { name: '上下文容量详情' });
    expect(pop).toHaveTextContent('上下文容量');
    // 头部右侧只有已用量，没有 "/上限（%）"
    expect(screen.queryByText(/\/100万/)).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    // 无上限即无分级依据：提示行隐藏（不猜容量状态）
    expect(screen.queryByText('容量充足')).not.toBeInTheDocument();
  });
});
