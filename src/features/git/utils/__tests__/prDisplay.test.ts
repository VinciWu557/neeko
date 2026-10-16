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
    expect(getStateBadgeClass('merged')).toContain('a371f7');
  });

  it('未知状态 → 中性底色', () => {
    expect(getStateBadgeClass('draft')).toBe('bg-bg-tertiary text-text-muted');
  });
});
