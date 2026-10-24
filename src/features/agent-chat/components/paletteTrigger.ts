/**
 * Composer 补全弹层的纯函数层（触发判定 / 写回 / 过滤）。
 *
 * # 触发判据为什么是「向前扫描」而不是「只看前一个字符」
 *
 * 只看 `text[cursor - 1]` 会在用户继续输入时立刻失效（`/tr` 的光标前一个字符
 * 是 `r`），弹层闪现即关。向前扫描到最近的触发符（跳过路径段里的 `/`），并要求
 * 它位于行首或空白之后 —— `src/foo` 因此不触发（R3）。扫描在遇到空白时终止，
 * 所以过滤词本身永不包含空白：输入空格即等价于关闭弹层。
 *
 * 全部函数无 React / 无 IPC，可被密集单测（`__tests__/paletteTrigger.test.ts`）。
 */

export type PaletteKind = 'slash' | 'mention';

export interface TriggerMatch {
  kind: PaletteKind;
  /** 触发符在文本中的下标；写回时替换 `[index, cursor)` 段。 */
  index: number;
  /** 触发符之后、光标之前的过滤词（不含触发符本身，不含空白）。 */
  query: string;
}

export function triggerOf(kind: PaletteKind): '/' | '@' {
  return kind === 'slash' ? '/' : '@';
}

/**
 * 触发判据的**唯一**语法点：`text[i]` 是否为一个合法的触发符起点（行首或
 * 空白之后）。弹层触发（`findTrigger`）与高亮 token 扫描（`paletteHighlight
 * ::tokenizeHighlights`）都从它派生 —— 两套判据共用一处，漂移即编译不过
 * （design §10：禁止第二套正则）。
 */
export function triggerStartAt(text: string, i: number): PaletteKind | null {
  const ch = text[i];
  if (ch !== '/' && ch !== '@') return null;
  const prev = i > 0 ? text[i - 1] : '';
  if (i !== 0 && !/\s/.test(prev)) return null;
  return ch === '/' ? 'slash' : 'mention';
}

/**
 * 从光标向前找最近的合法触发符，找不到返回 null。
 *
 * 判据只取决于「光标之前的文本」——整段文本里是否出现过 `/`、`@` 与本判定无关。
 */
export function findTrigger(text: string, cursor: number): TriggerMatch | null {
  const pos = Math.min(cursor, text.length);
  if (pos <= 0) return null;
  for (let i = pos - 1; i >= 0; i--) {
    const ch = text[i];
    // 触发 token 不含空白：一路扫到空白还没命中触发符，就不是补全场景
    if (/\s/.test(ch)) return null;
    const kind = triggerStartAt(text, i);
    if (!kind) continue;
    return { kind, index: i, query: text.slice(i + 1, pos) };
  }
  return null;
}

/**
 * 用 `replacement` 替换 `[triggerIndex, cursor)` 段，光标落在插入文本之后。
 *
 * `replacement` 是**完整替换文本**（含触发符与尾随空格，如 `/name `）——触发符
 * 本身已在文本里、替换段从它开始，由调用方拼好整段传入。只动这一段，触发符
 * 之前的前缀与光标之后的后缀原样保留。
 */
export function applySelection(
  text: string,
  triggerIndex: number,
  cursor: number,
  replacement: string,
): { text: string; cursor: number } {
  return {
    text: text.slice(0, triggerIndex) + replacement + text.slice(cursor),
    cursor: triggerIndex + replacement.length,
  };
}

/**
 * 子串过滤（大小写不敏感）。
 *
 * 空 query 返回前 `limit` 条（有界，不倾倒全量 —— 命令列表实测 157 条）；
 * 非空 query 返回命中项的前 `limit` 条。
 */
export function filterBySubstring<T>(
  items: readonly T[],
  query: string,
  keyOf: (item: T) => string,
  limit: number,
): T[] {
  const q = query.trim().toLowerCase();
  const matched = q === '' ? items : items.filter((item) => keyOf(item).toLowerCase().includes(q));
  return matched.slice(0, limit);
}
