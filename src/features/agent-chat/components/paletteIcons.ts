import { File as FileIcon, Puzzle, Slash, Sparkles, StickyNote } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { groupOfSource } from './paletteSources';
import type { PaletteGroup } from './paletteSources';

/**
 * 「语义分组 → 图标」的**单一事实源**。
 *
 * # 为什么抽出来
 *
 * 同一条语义曾经有两个派生点，且**键不同**：
 *
 * | 位置 | 键 | 映射 |
 * | --- | --- | --- |
 * | `ComposerPalette`（弹层） | `PaletteGroup` | `command → StickyNote` |
 * | `composer/ChipView`（chip） | 原始 `source` | `prompt → StickyNote` |
 *
 * `prompt` 与 `command` 是同一个东西（`groupOfSource` 就是干这个归一的），
 * 但两处各自维护一张表 —— 新增来源时只改一处，弹层与 chip 的图标就会不一致，
 * 而且类型检查不会提醒（两张表的键类型不同）。
 *
 * 收表后：`ChipView` 先把 `source` 经 `groupOfSource` 归一，再查同一张表。
 *
 * # 未知分组回落 `Slash`
 *
 * 数据源演进出新分组时 UI 仍可辨认，不白屏（与 `PALETTE_GROUP_LABELS` 的
 * 「未知来源归 other」同一策略：宁可显示得含糊，也不消失）。
 */
export const PALETTE_GROUP_ICONS: Record<PaletteGroup, LucideIcon> = {
  skill: Sparkles,
  command: StickyNote,
  extension: Puzzle,
  file: FileIcon,
  other: Slash,
};

/** 按分组取图标（未知分组已在 `groupOfSource` 归一为 `other`，无需二次兜底）。 */
export function iconOfGroup(group: PaletteGroup): LucideIcon {
  return PALETTE_GROUP_ICONS[group] ?? PALETTE_GROUP_ICONS.other;
}

/**
 * 按**原始 source** 取图标（chip 侧入口）。
 *
 * chip 的 attrs 存的是 agent 给的原始来源（`prompt` / `skill` / `extension`），
 * 不是归一后的分组。经 `groupOfSource` 归一后查同一张表 —— 不另立第二张映射。
 */
export function iconOfSource(source: string | null | undefined): LucideIcon {
  return iconOfGroup(groupOfSource(source));
}
