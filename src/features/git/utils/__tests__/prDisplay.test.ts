// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { formatCreatedAt, getStateBadgeClass } from '../prDisplay';

describe('formatCreatedAt', () => {
  it('空值 → 空串', () => {
    expect(formatCreatedAt(undefined)).toBe('');
    expect(formatCreatedAt(null)).toBe('');
    expect(formatCreatedAt('')).toBe('');
  });

  it('合法 ISO 时间 → 本地化日期（含年份）', () => {
    const formatted = formatCreatedAt('2026-08-14T10:00:00');
    expect(formatted).toContain('2026');
  });

  it('非法时间串 → 原样返回（不伪造日期）', () => {
    expect(formatCreatedAt('not-a-date')).toBe('not-a-date');
  });
});

describe('getStateBadgeClass', () => {
  it('OPEN / CLOSED / MERGED 各自映射（大小写不敏感）', () => {
    expect(getStateBadgeClass('open')).toContain('accent-green');
    expect(getStateBadgeClass('CLOSED')).toContain('accent-red');
    // MERGED 用语义 token（--accent-brick，主题已定义）。
    // 2026-10-27 之前这里是硬编码 '#a371f7' —— 与主题无关，亮色主题下与界面不搭。
    expect(getStateBadgeClass('merged')).toContain('accent-brick');
  });

  it('状态徽标不得含硬编码 hex（主题逃逸回归）', () => {
    // 护栏 check_ui_style_tokens 拦的是「新增」，存量要靠这条用例钉住 ——
    // 否则「改回 hex」不会有任何测试变红。
    for (const state of ['open', 'closed', 'merged', 'draft']) {
      expect(getStateBadgeClass(state)).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    }
  });

  it('未知状态 → 中性底色', () => {
    expect(getStateBadgeClass('draft')).toBe('bg-bg-tertiary text-text-muted');
  });
});
