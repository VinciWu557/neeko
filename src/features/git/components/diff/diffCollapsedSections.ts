import type { DiffHunk, DiffLine } from './types';

/**
 * 折叠段展开：唯一不变量是 **`Collapsed` 占位文本 ↔ 隐藏的 old/new 行号区间** 的映射链
 * （`parseCollapsedCount` 解析行数 → `collapsedSectionRanges` 沿 hunk 递增推算区间 →
 * `spliceFullHunkSection` 从全量 hunk 按区间取回 context 行；`findFullHunkForOldLine`
 * 负责在（单段展开拿到的）全量 hunks 中定位所属 hunk）。
 *
 * 消费者：仅 `ExpandedSectionRows`。
 */

export interface CollapsedSectionRange {
  /** 折叠 diff 中 Collapsed 占位行在该 hunk.lines 内的索引。 */
  index: number;
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

/** 解析 `N unmodified lines` 折叠占位文本中的行数。 */
export function parseCollapsedCount(text: string): number {
  const m = text.match(/^(\d+)\s+unmodified lines?$/);
  return m ? Number(m[1]) : 0;
}

/** 遍历 hunk，计算每个 Collapsed 占位行隐藏的 old/new 行号区间。 */
export function collapsedSectionRanges(hunk: DiffHunk): CollapsedSectionRange[] {
  const ranges: CollapsedSectionRange[] = [];
  let oldNum = hunk.old_start;
  let newNum = hunk.new_start;
  hunk.lines.forEach((line, index) => {
    if (line.Collapsed !== undefined) {
      const count = parseCollapsedCount(line.Collapsed);
      ranges.push({
        index,
        oldStart: oldNum,
        oldEnd: oldNum + count - 1,
        newStart: newNum,
        newEnd: newNum + count - 1,
      });
      oldNum += count;
      newNum += count;
    } else if (line.Removed !== undefined) {
      oldNum += 1;
    } else if (line.Added !== undefined) {
      newNum += 1;
    } else {
      oldNum += 1;
      newNum += 1;
    }
  });
  return ranges;
}

/** 从全量 hunk 中抽取指定行号区间的 context 行（单段展开的数据来源）。 */
export function spliceFullHunkSection(
  fullHunk: DiffHunk,
  range: CollapsedSectionRange,
): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNum = fullHunk.old_start;
  for (const line of fullHunk.lines) {
    if (line.Context !== undefined) {
      if (oldNum >= range.oldStart && oldNum <= range.oldEnd) {
        out.push({ Context: line.Context });
      }
      oldNum += 1;
    } else if (line.Removed !== undefined) {
      oldNum += 1;
    }
  }
  return out;
}

/** 在（全量）hunks 中查找包含指定旧行号的 hunk。 */
export function findFullHunkForOldLine(hunks: DiffHunk[], oldLine: number): DiffHunk | null {
  for (const hunk of hunks) {
    if (oldLine >= hunk.old_start && oldLine < hunk.old_start + hunk.old_lines) {
      return hunk;
    }
  }
  return null;
}
