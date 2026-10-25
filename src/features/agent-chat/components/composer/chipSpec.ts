import type { PaletteItem } from '../paletteSources';

/**
 * chip 种类的**单一事实源**：触发符 · 节点名 · 属性 · 序列化 · 展示。
 *
 * # 为什么要有这张表
 *
 * 加一种 chip（例如子 agent 用 `#`）在收表之前要改 7 处，且散在三个文件：
 * `editorSchema` 的节点定义（属性 schema + renderHTML）与扩展数组、
 * `suggestionWiring` 的两处 `char:` / `insertChip` 三元 / `createPaletteRender`
 * 的 kind 反推、以及 `'/' | '@'` 的字面量联合。每处都靠人记得，漏一处就是
 * 「弹层能触发但插错节点」这类**静默**缺陷。
 *
 * 收表后新增一种 chip = 在 `CHIP_SPECS` 加一条，`editorSchema` 按表循环装配、
 * `suggestionWiring` 按表取触发符与插入逻辑。判据（开闭原则）：**新增 chip 不应
 * 修改本模块之外的任何 switch / 三元 / 手写扩展条目**。
 *
 * # 分层
 *
 * 本模块不 import React / Tiptap **运行时**（只 import `PaletteItem` 这个类型）。
 * `editorSchema` 与 `suggestionWiring` 都依赖它，它不能反向依赖它们。
 */

/** chip 的语义种类 —— `PaletteKind` 就是它（同一条轴，不另立概念）。 */
export type ChipKind = 'slash' | 'mention';

/** chip 节点名（ProseMirror doc 里的 `node.type`）。 */
export type ChipNodeName = 'commandChip' | 'fileChip';

/** 一个 chip 属性的定义：HTML 往返 + 编辑器侧默认值。 */
export interface ChipAttrSpec {
  /** 属性名（也是 `data-chip-<name>` 的数据源）。 */
  key: string;
  /**
   * 自定义 HTML 属性名；`null` = 用 `data-chip-<key>` 约定。
   * （`fileChip` 的 `name` 与命令 chip 同名，但语义是「文件名」，仍需独立键。）
   */
  htmlAttr?: string;
}

/** 一种 chip 的完整描述。 */
export interface ChipSpec {
  /** 触发符（suggestion 的 `char`）。 */
  trigger: string;
  /** ProseMirror 节点名。 */
  node: ChipNodeName;
  /** 弹层与数据源使用的种类键。 */
  kind: ChipKind;
  /** 需要持久化的属性（顺序即 `addAttributes` 的产出顺序，不影响语义但便于阅读）。 */
  attrs: readonly ChipAttrSpec[];
  /** 渲染 HTML 时挂在 `span` 上的类名（CSS 配色钩子）。 */
  className: string;
  /**
   * 节点在纯文本里的展示形式（`renderHTML` 的文本内容，即复制粘贴得到的文本）。
   *
   * **这是唯一必填的展示函数**，另外两个（`tooltip` / `chipLabel`）缺省时从它
   * 派生 —— 命令 chip 三种形状本来就完全相同（都是 `/name`），写三遍是纯粹的
   * 重复。只有文件 chip 需要区分：看着 `foo.ts`、复制 `@src/foo.ts`。
   */
  displayText: (attrs: Record<string, unknown>) => string;
  /**
   * chip 的 **tooltip**（`title` 属性）：hover 时显示的完整信息。
   *
   * 缺省 = `displayText`。文件 chip 覆盖为**裸路径** —— 带 `@` 前缀会让人
   * 以为路径里有 `@`。
   */
  tooltip?: (attrs: Record<string, unknown>) => string;
  /**
   * chip 在编辑器里的**可见标签**（React node view 渲染的那段文字）。
   *
   * 缺省 = `displayText`。文件 chip 覆盖为文件名（全路径占宽太狠）。
   * 这两者不同是设计（summary「序列化 ≠ 显示」），但**用哪个属性当标签**这个
   * 决定只应写一次 —— 否则 node view 会自己再判一遍 `name ?? path`，
   * 漏改就显示空标签。
   */
  chipLabel?: (attrs: Record<string, unknown>) => string;
  /** 候选 → chip 节点属性（插入编辑器时用）。 */
  attrsOf: (item: PaletteItem) => Record<string, unknown>;
  /** 节点属性 → prompt 文本（序列化契约，golden 锁死）。 */
  toPromptText: (attrs: Record<string, unknown> | undefined) => string;
  /**
   * 该 chip 是否贡献后端的 `files` 字段；给了就取这个属性作为文件路径。
   *
   * 放在表里而不是在 `docToRequestFiles` 里写 `node.type === 'fileChip'` ——
   * 那会把「哪种 chip 算文件」和「文件路径存在哪个属性」再散两处，新增 chip
   * 时若被误判成文件，会静默地把 chip 内容当路径发给后端。
   */
  filePathAttr?: string;
}

/** chip 的可见标签（缺省从 `displayText` 派生 —— 见 `ChipSpec.chipLabel`）。 */
export function chipLabelOf(spec: ChipSpec, attrs: Record<string, unknown> | undefined): string {
  return spec.chipLabel ? spec.chipLabel(attrs ?? {}) : spec.displayText(attrs ?? {});
}

/** chip 的 tooltip（缺省从 `displayText` 派生 —— 见 `ChipSpec.tooltip`）。 */
export function chipTooltipOf(spec: ChipSpec, attrs: Record<string, unknown> | undefined): string {
  return spec.tooltip ? spec.tooltip(attrs ?? {}) : spec.displayText(attrs ?? {});
}

/** 读属性里的非空字符串（`null` / 空串 / 非字符串统一当缺失）。 */
export function chipAttrOf(attrs: Record<string, unknown> | undefined, key: string): string | null {
  const value = attrs?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 命令 chip：`/name`，序列化为 `/name `。 */
const SLASH_CHIP: ChipSpec = {
  trigger: '/',
  node: 'commandChip',
  kind: 'slash',
  attrs: [{ key: 'name' }, { key: 'source' }],
  className: 'command-chip',
  // 命令 chip 的**展示即序列化**：复制出去是 `/name`，看着也是 `/name`，
  // 故只写这一条，tooltip / chipLabel 由缺省派生。
  displayText: (attrs) => `/${chipAttrOf(attrs, 'name') ?? ''}`,
  // **只产出 `attrs` 里声明过的键**：未声明的属性会被 ProseMirror 丢弃，
  // 让 `attrsOf` 与 `attrs` 分家（曾有幽灵 `label`，导致所有 `?? label` 兜底
  // 永不可达）。契约测试 `chipSpec.test.ts` 钉住这一点。
  attrsOf: (item) => ({ name: item.value, source: item.source ?? null }),
  toPromptText: (attrs) => {
    const name = chipAttrOf(attrs, 'name');
    return name ? `/${name} ` : '';
  },
};

/** 文件 chip：`@path`，序列化为 `@path `。 */
const MENTION_CHIP: ChipSpec = {
  trigger: '@',
  node: 'fileChip',
  kind: 'mention',
  attrs: [{ key: 'path' }, { key: 'name' }],
  className: 'file-chip',
  displayText: (attrs) => `@${chipAttrOf(attrs, 'name') ?? chipAttrOf(attrs, 'path') ?? ''}`,
  // 裸路径：tooltip 是给人定位用的，带 `@` 前缀会让人以为路径里有 `@`
  tooltip: (attrs) => chipAttrOf(attrs, 'path') ?? '',
  // 文件名优先，退回落全路径（`name` 缺失时至少还能看见是哪个文件）
  chipLabel: (attrs) => chipAttrOf(attrs, 'name') ?? chipAttrOf(attrs, 'path') ?? '',
  attrsOf: (item) => ({ path: item.value, name: item.label }),
  filePathAttr: 'path',
  toPromptText: (attrs) => {
    const path = chipAttrOf(attrs, 'path');
    return path ? `@${path} ` : '';
  },
};

/** 全部 chip 种类。**顺序无业务含义**——消费方按 `kind` / `node` 查，不按下标取。 */
export const CHIP_SPECS: readonly ChipSpec[] = [SLASH_CHIP, MENTION_CHIP];

/** 按 `kind` 取规格（数据源 → chip）。 */
export function chipSpecOfKind(kind: ChipKind): ChipSpec {
  const spec = CHIP_SPECS.find((s) => s.kind === kind);
  if (!spec) throw new Error(`unknown chip kind: ${kind}`);
  return spec;
}

/** 按节点名取规格（文档 JSON → 序列化）。 */
export function chipSpecOfNode(node: string): ChipSpec | null {
  return CHIP_SPECS.find((s) => s.node === node) ?? null;
}

/**
 * 文档节点 → prompt 文本片段（未知节点返回 `null`，交给调用方处理）。
 *
 * 放在本文件而不是 `editorSchema`，是因为它只依赖表；`editorSchema` 反过来用它，
 * 这样「序列化形状」与「chip 注册」不会分叉成两份。
 */
export function chipNodeToPromptText(node: {
  type: string;
  attrs?: Record<string, unknown>;
}): string | null {
  const spec = chipSpecOfNode(node.type);
  return spec ? spec.toPromptText(node.attrs) : null;
}
