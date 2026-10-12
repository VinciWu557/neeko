/**
 * diff 选区语义（唯一不变量：`hunk:line` key 的**造/解同源** ——
 * `selectionKeys` 定义 key 格式，`lastSelectedKeyOf` 按同一格式解析）。
 *
 * 消费者：`useDiffDragSelect`（造 key）、`DiffView`（合并）、`DiffTable` / `SplitDiffTable`
 * （末行派生 + `SelectionMode`）、`DiffContent` / `SingleDiffBody` / `CombinedDiffView`
 * 与 `ExpandedSectionRows`（仅类型）。模块自身不依赖任何其他 diff 模块。
 */

/** 自定义评审指令长度上限（SelectionActionBar / ReviewInstructionPopover 共用单一来源）。 */
export const REVIEW_INSTRUCTION_MAX = 2000;

export interface DiffPos {
  hunk: number;
  line: number;
}

export interface SelectionRange {
  start: DiffPos;
  end: DiffPos;
}

/** 将拖拽锚点/当前点规范化为线性顺序（hunk 升序，同 hunk 内 line 升序）。 */
export function computeSelectionRange(anchor: DiffPos, current: DiffPos): SelectionRange {
  const anchorAfter =
    anchor.hunk > current.hunk || (anchor.hunk === current.hunk && anchor.line > current.line);
  return anchorAfter ? { start: current, end: anchor } : { start: anchor, end: current };
}

/**
 * 生成区间 [start, end] 内所有行的选区 key（`hunk:line`）。
 * `hunkLineCounts` 提供各 hunk 的行数（跨 hunk 时中间 hunk 全选）。
 * combined 模式传 `prefix`（文件路径），key 形如 `path\0hunk:line`。
 */
export function selectionKeys(
  start: DiffPos,
  end: DiffPos,
  hunkLineCounts: number[],
  prefix?: string,
): Set<string> {
  const keys = new Set<string>();
  const p = prefix ? `${prefix}\0` : '';
  const add = (hunk: number, line: number) => keys.add(`${p}${hunk}:${line}`);

  if (start.hunk === end.hunk) {
    for (let line = start.line; line <= end.line; line++) add(start.hunk, line);
    return keys;
  }
  for (let line = start.line; line < (hunkLineCounts[start.hunk] ?? start.line + 1); line++) {
    add(start.hunk, line);
  }
  for (let hunk = start.hunk + 1; hunk < end.hunk; hunk++) {
    for (let line = 0; line < (hunkLineCounts[hunk] ?? 0); line++) add(hunk, line);
  }
  for (let line = 0; line <= end.line; line++) add(end.hunk, line);
  return keys;
}

export type SelectionMode = 'replace' | 'append';

/** 合并选区：replace=替换旧选区；append=追加到旧选区。不修改入参 Set。 */
export function mergeSelection(
  prev: Set<string>,
  keys: Set<string>,
  mode: SelectionMode,
): Set<string> {
  if (mode === 'replace') return new Set(keys);
  const next = new Set(prev);
  for (const key of keys) next.add(key);
  return next;
}

/** 计算选区中“最后一个选中行”的 key（`hunkIdx:lineIdx`），空选区返回 null。 */
export function lastSelectedKeyOf(selectedLines: ReadonlySet<string> | undefined): string | null {
  if (!selectedLines || selectedLines.size === 0) return null;
  let lastHunk = -1;
  let lastLine = -1;
  for (const key of selectedLines) {
    const [h, l] = key.split(':').map(Number);
    if (h > lastHunk || (h === lastHunk && l > lastLine)) {
      lastHunk = h;
      lastLine = l;
    }
  }
  return lastHunk >= 0 ? `${lastHunk}:${lastLine}` : null;
}
