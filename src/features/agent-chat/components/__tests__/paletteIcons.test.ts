import { describe, expect, it } from 'vitest';

import { iconOfGroup, iconOfSource, PALETTE_GROUP_ICONS } from '../paletteIcons';

/**
 * 弹层分组图标与 chip 来源图标**必须来自同一张表**。
 *
 * 收表前它们是两张独立映射且键不同（`PaletteGroup` vs 原始 `source`）：
 * 弹层写 `command → StickyNote`、chip 写 `prompt → StickyNote`。新增来源时
 * 只改一处，弹层与 chip 的图标就不一致，且类型检查不会提醒（键类型不同）。
 *
 * 变异验证：让 `iconOfSource` 绕过 `groupOfSource` 直接查自己的表 → 本用例红。
 */
describe('paletteIcons — 单一事实源', () => {
  it('maps every known source to the same icon as its group', () => {
    // pi 的三种来源（`AgentCommandEntry.source` 的已知取值）
    expect(iconOfSource('prompt')).toBe(PALETTE_GROUP_ICONS.command);
    expect(iconOfSource('skill')).toBe(PALETTE_GROUP_ICONS.skill);
    expect(iconOfSource('extension')).toBe(PALETTE_GROUP_ICONS.extension);
  });

  it('falls back to the "other" icon for unknown or missing sources', () => {
    // 未知来源归 other —— 与 `groupOfSource` 的归一策略一致，不白屏
    expect(iconOfSource('brand-new-source')).toBe(PALETTE_GROUP_ICONS.other);
    expect(iconOfSource(null)).toBe(PALETTE_GROUP_ICONS.other);
    expect(iconOfSource(undefined)).toBe(PALETTE_GROUP_ICONS.other);
  });

  it('exposes an icon for every palette group', () => {
    // 新增 PaletteGroup 时若忘记补图标，这里立刻红（Record 类型也会报，
    // 但本用例覆盖「运行时拿到 undefined」的路径）
    for (const group of ['skill', 'command', 'extension', 'file', 'other'] as const) {
      expect(iconOfGroup(group)).toBeTruthy();
    }
  });
});
