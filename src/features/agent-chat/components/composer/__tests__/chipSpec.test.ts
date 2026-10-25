// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { PaletteItem } from '../../paletteSources';
import {
  CHIP_SPECS,
  chipLabelOf,
  chipNodeToPromptText,
  chipSpecOfKind,
  chipSpecOfNode,
  chipTooltipOf,
} from '../chipSpec';

/**
 * chip 种类表的**结构契约**。
 *
 * 表驱动的前提是表本身自洽：`editorSchema` 按 `attrs` 声明属性 schema（未声明的
 * 属性会被 ProseMirror 丢弃），而 `attrsOf` 负责在插入时产出属性值。两者一旦
 * 分家，坏法非常隐蔽 —— 曾经 `attrsOf` 多产出一个未声明的 `label`，于是所有
 * `?? attrs.label` 的兜底路径**永不可达**（读起来像有兜底，实际是死代码）。
 */

const ITEM: PaletteItem = { value: 'v', label: 'Label', sublabel: 'sub', group: 'command' };

describe('CHIP_SPECS — 表自洽性', () => {
  it('should have unique triggers, node names and kinds', () => {
    const triggers = CHIP_SPECS.map((s) => s.trigger);
    const nodes = CHIP_SPECS.map((s) => s.node);
    const kinds = CHIP_SPECS.map((s) => s.kind);
    expect(new Set(triggers).size).toBe(triggers.length);
    expect(new Set(nodes).size).toBe(nodes.length);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  /**
   * **核心契约**：`attrsOf` 只能产出 `attrs` 声明过的键。
   *
   * 变异验证：给任一 `attrsOf` 加一个表里没有的键 → 本用例红。
   */
  it('should never emit an attribute that is not declared in attrs', () => {
    for (const spec of CHIP_SPECS) {
      const declared = spec.attrs.map((a) => a.key);
      const emitted = Object.keys(spec.attrsOf(ITEM));
      expect({ node: spec.node, undeclared: emitted.filter((k) => !declared.includes(k)) }).toEqual(
        {
          node: spec.node,
          undeclared: [],
        },
      );
    }
  });

  /** 反向：每个声明的属性都必须真的被写出来（否则 schema 里是个恒 null 的死属性）。 */
  it('should declare every attribute that attrsOf writes', () => {
    for (const spec of CHIP_SPECS) {
      const declared = spec.attrs.map((a) => a.key);
      const emitted = Object.keys(spec.attrsOf(ITEM));
      expect({ node: spec.node, missing: declared.filter((k) => !emitted.includes(k)) }).toEqual({
        node: spec.node,
        missing: [],
      });
    }
  });

  it('should expose a consistent file projection only where filePathAttr is set', () => {
    for (const spec of CHIP_SPECS) {
      if (!spec.filePathAttr) continue;
      // 声明了 filePathAttr 就必须真的声明这个属性，否则永远取不到路径
      expect(spec.attrs.map((a) => a.key)).toContain(spec.filePathAttr);
    }
  });

  it('should look chips up by kind and by node name', () => {
    for (const spec of CHIP_SPECS) {
      expect(chipSpecOfKind(spec.kind)).toBe(spec);
      expect(chipSpecOfNode(spec.node)).toBe(spec);
    }
    expect(chipSpecOfNode('not-a-chip')).toBeNull();
  });

  /**
   * 序列化**不必**等于展示 —— 两者是不同出口：
   * - `displayText` 给人看（文件 chip 显示文件名，不是路径）
   * - `toPromptText` 给 agent 看（必须是完整 `@path`，pi 才能定位文件）
   *
   * 所以这里钉的是「各有其正确形状」，不是「两者相同」。
   */
  it('should serialize chips in the agent-facing shape, independent of display text', () => {
    const slash = chipSpecOfKind('slash');
    const slashAttrs = slash.attrsOf(ITEM);
    expect(slash.toPromptText(slashAttrs)).toBe('/v ');
    expect(slash.displayText(slashAttrs)).toBe('/v');

    const mention = chipSpecOfKind('mention');
    const mentionAttrs = mention.attrsOf(ITEM);
    // 序列化走**路径**（agent 要靠它定位文件），展示走**文件名**
    expect(mention.toPromptText(mentionAttrs)).toBe('@v ');
    expect(mention.displayText(mentionAttrs)).toBe('@Label');
  });

  /** 缺主属性时不得产出悬空的触发符（`/` 或 `@` 单独出现会污染 prompt）。 */
  it('should render nothing when the identifying attribute is missing', () => {
    for (const spec of CHIP_SPECS) {
      expect(spec.toPromptText({})).toBe('');
      expect(spec.displayText({})).toBe(spec.trigger);
    }
  });

  it('should route unknown node types to null instead of guessing', () => {
    expect(chipNodeToPromptText({ type: 'paragraph' })).toBeNull();
    expect(chipNodeToPromptText({ type: 'commandChip', attrs: { name: 'tr' } })).toBe('/tr ');
  });
});

/**
 * **展示函数的分层**：`displayText` 必填，`tooltip` / `chipLabel` 缺省时从它派生。
 *
 * 这条钉的是「加一种 chip 只写一条表项」这个开闭原则承诺：命令 chip 三种形状
 * 完全相同，写三遍是纯重复；文件 chip 才需要区分。
 *
 * 变异验证：删掉派生逻辑（让 `chipLabelOf` 直接读 `spec.chipLabel?.() ?? ''`）
 * → 命令 chip 的标签变空串，本用例红。
 */
describe('CHIP_SPECS — 展示函数的缺省派生', () => {
  it('should derive label and tooltip from displayText when not overridden', () => {
    const slash = chipSpecOfKind('slash');
    const attrs = slash.attrsOf(ITEM);
    // 命令 chip 不覆盖这两个 —— 三者同形（`/v`）
    expect(slash.chipLabel).toBeUndefined();
    expect(slash.tooltip).toBeUndefined();
    expect(chipLabelOf(slash, attrs)).toBe('/v');
    expect(chipTooltipOf(slash, attrs)).toBe('/v');
  });

  it('should let a chip override label and tooltip independently of displayText', () => {
    const mention = chipSpecOfKind('mention');
    const attrs = mention.attrsOf(ITEM);
    // 文件 chip 三者刻意不同：看着 `Label`、hover `v`（裸路径）、复制 `@v`
    expect(chipLabelOf(mention, attrs)).toBe('Label');
    expect(chipTooltipOf(mention, attrs)).toBe('v');
    expect(mention.displayText(attrs)).toBe('@Label');
  });

  it('should not crash on missing attrs', () => {
    for (const spec of CHIP_SPECS) {
      expect(() => chipLabelOf(spec, undefined)).not.toThrow();
      expect(() => chipTooltipOf(spec, undefined)).not.toThrow();
    }
  });
});
