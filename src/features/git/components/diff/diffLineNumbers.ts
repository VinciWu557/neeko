import type { DiffHunk } from './types';

/**
 * 行号列几何：唯一不变量是 **渲染行号的最大位数决定列宽**。
 *
 * ⚠️ 跨模块约束：`maxLineNumDigits` 的行号递增规则必须与 `DiffTable` / `SplitDiffTable`
 * 的渲染一致（折叠占位行不递增、不参与；行号取递增前的值）—— 改这里必须同步校对两张表。
 *
 * 消费者：`DiffTable`、`SplitDiffTable`（宽度公式单一来源）。
 */

/**
 * 计算 hunks 中渲染行号的最大位数（行号列宽度自适应）。
 * 递增逻辑与 DiffTable / SplitDiffTable 渲染一致：折叠占位行不递增、不参与；
 * 行号取递增前的值，与渲染显示一致。空 hunks 返回 0。
 */
export function maxLineNumDigits(hunks: DiffHunk[]): number {
  let maxNum = 0;
  for (const hunk of hunks) {
    let oldNum = hunk.old_start;
    let newNum = hunk.new_start;
    for (const line of hunk.lines) {
      if (line.Collapsed !== undefined) continue;
      const curOld = oldNum;
      const curNew = newNum;
      if (line.Added === undefined) oldNum++;
      if (line.Removed === undefined) newNum++;
      maxNum = Math.max(maxNum, curOld, curNew);
    }
  }
  return maxNum > 0 ? maxNum.toString().length : 0;
}

/**
 * 行号列宽度：随最大行号位数自适应（ch = 等宽字符宽，+6px 容纳选中指示条/呼吸）。
 * DiffTable 与 SplitDiffTable 共用同一宽度公式（单一来源）。
 * 数字与代码之间的间隙由代码列左侧 padding 提供，行号列本身不增宽。
 */
export function lineNumColumnWidth(hunks: DiffHunk[]): string {
  return `calc(${Math.max(maxLineNumDigits(hunks), 1)}ch + 6px)`;
}
