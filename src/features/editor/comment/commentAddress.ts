/**
 * 注释单元的**内容地址**（唯一构造点）—— 归一化文本 → 稳定短哈希。
 *
 * ## 为什么身份是内容哈希而不是行号
 *
 * 行号身份在文档编辑后会整体平移：在注释块中间插一行 → 后面所有单元的「身份」都变了
 * → 缓存条目错位 → 全量重译，「增量」永远无法成立。内容哈希则天然免疫位置变化。
 *
 * ## 为什么身份落在 segment 而非 group
 *
 * 组边界会随相邻行变化而改变（插入一行可能重新分组）。若按组算地址，一个无关行的加入
 * 会让整组失效。按 segment 算，只有真正变化的文本才失效（AC12）。
 *
 * ## 归一化口径（只折叠空白）
 *
 * | 保留 | 理由 |
 * | --- | --- |
 * | 大小写 | `Session` 与 `session` 是不同术语 |
 * | 行内 markdown 标记 | `` `x` `` 与 `x` 语义不同（前者是代码跨度） |
 * | 占位符 | `{0}` 与 `{1}` 是不同参数 |
 *
 * 只折叠空白，是因为换行/缩进属于**排版**而非语义：同一句话重排后应命中同一缓存。
 *
 * ## 碰撞策略
 *
 * 双种子 FNV-1a 拼成短串，碰撞概率极低；且缓存层读取时会逐字节比对原文
 * （`CachedTranslation.source`），碰撞退化为 miss 而非错译 —— 可用性问题，不是正确性问题。
 */

/**
 * 归一化：折叠所有连续空白为单个空格并去首尾。
 *
 * **只做这一件事** —— 任何额外的「清洗」（小写化、去标点、去标记）都会让语义不同的
 * 文本共用一条译文。
 */
export function normalizeSegmentText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
/** 第二种子（黄金比例常数），让两个 32 位哈希独立。 */
const FNV_SEED_B = 0x9e3779b9;

/** 单次 FNV-1a 32 位。 */
function fnv1a(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 内容地址：`c` + 长度(36 进制) + 双种子哈希(36 进制)。
 *
 * 前缀 `c` 让日志/UI 里一眼能认出「这是注释单元地址」（与文档翻译的 `s` 前缀区分）。
 * 长度参与编码：同一哈希下不同长度的文本几乎不可能碰撞，且长度信息对排查有用。
 */
export function commentAddress(text: string): string {
  const normalized = normalizeSegmentText(text);
  const a = fnv1a(normalized, FNV_OFFSET);
  const b = fnv1a(normalized, FNV_OFFSET ^ FNV_SEED_B);
  return `c${normalized.length.toString(36)}${a.toString(36)}${b.toString(36)}`;
}
