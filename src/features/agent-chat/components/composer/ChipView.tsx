import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { File as FileIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import React from 'react';

import { iconOfSource } from '../paletteIcons';

import { CHIP_SPECS, chipAttrOf, chipLabelOf, chipTooltipOf } from './chipSpec';
import type { ChipKind, ChipSpec } from './chipSpec';

/**
 * chip 的 React node view —— **按 `chipSpec` 表驱动**。
 *
 * # 为什么不是两个手写组件
 *
 * 收表前这里是 `CommandChipView` / `FileChipView` 两个函数 + 两个工厂，
 * 各自硬编码「取哪个属性当标签」「用哪个图标」。新增一种 chip 就要再写一组，
 * 且和 `chipSpec` 里的同类定义分家 —— chipSpec 声称的「加一条表项即可」
 * 在本文件失效。
 *
 * 收表后：标签来自 `spec.chipLabel`，图标来自 `spec.kind`（`slash` 按来源细分，
 * `mention` 恒为文件图标）。新增 chip 只需在 `CHIP_SPECS` 加一条。
 */

/**
 * chip 图标：`slash` 按来源细分（skill 星 / 命令便签 / 扩展拼图），其余为文件图标。
 *
 * 这里保留 `slash` 分支是**数据驱动的例外**：命令的来源是多值的
 *（`prompt` / `skill` / `extension`），文件只有一种，所以「按来源细分」这件事
 * 对二者不是同一运算。若将来出现第三种 chip 也需要来源细分，把这条规则移进
 * `ChipSpec`（例如一个可选的 `iconOf` 字段）才是对的方向 —— 现在只有两个种类，
 * 抽出来是过度设计（YAGNI）。
 */
function chipIconOf(spec: ChipSpec, attrs: Record<string, unknown>): LucideIcon {
  return spec.kind === 'slash' ? iconOfSource(chipAttrOf(attrs, 'source')) : FileIcon;
}

/**
 * 图标渲染点。
 *
 * **不写 `const Icon = …; <Icon />`**：React Compiler 无法证明该引用来自模块级
 * 常量表，会把「render 期得到的组件引用」判定为「render 期创建组件」并报错。
 * 这里直接把已解析的图标渲染成元素 —— 引用来源对编译器完全透明。
 */
function chipIconElement(spec: ChipSpec, attrs: Record<string, unknown>) {
  const Icon = chipIconOf(spec, attrs);
  return <Icon size={12} aria-hidden />;
}

/** 通用 chip 视图：外观差异全部来自 `ChipSpec`（类名、标签、图标、配色钩子）。 */
function ChipView({ node, spec }: NodeViewProps & { spec: ChipSpec }) {
  const attrs = node.attrs as Record<string, unknown>;
  const label = chipLabelOf(spec, attrs);
  // 配色钩子：`slash` 按来源着色（`data-chip-source`），其余按类名着色。
  const source = spec.kind === 'slash' ? chipAttrOf(attrs, 'source') : null;
  return (
    <NodeViewWrapper as="span" className="composer-chip-node">
      <span
        className={`composer-chip ${spec.className}`}
        data-chip-source={source ?? undefined}
        title={chipTooltipOf(spec, attrs) || undefined}
      >
        {chipIconElement(spec, attrs)}
        <span className="composer-chip-label">{label}</span>
      </span>
    </NodeViewWrapper>
  );
}

/**
 * 按 `kind` 造 node view 工厂（交给 `buildComposerExtensions`）。
 *
 * `spec` 经闭包捕获而不是作为 node view props 传入：`addNodeView` 只给
 * `NodeViewProps`，而我们要的那条规格在装配时已知。
 */
function makeNodeView(spec: ChipSpec) {
  const Bound = (props: NodeViewProps) => <ChipView {...props} spec={spec} />;
  Bound.displayName = `ChipView(${spec.kind})`;
  return () => ReactNodeViewRenderer(React.memo(Bound));
}

/**
 * 每种 chip 的 node view 工厂（模块级单例 —— 扩展身份稳定，编辑器不无故重建）。
 *
 * 类型是 `Record<ChipKind, …>`（**不是** `Partial`）：新增 `ChipKind` 时
 * 这里少一条会被类型检查抓住，而不是运行时才发现某种 chip 没有 node view
 *（那会退化成 Tiptap 默认渲染，chip 样式全丢）。装配点整体传入本表，
 * 不再手写 `{ slash: …, mention: … }`。
 */
export const CHIP_NODE_VIEWS: Record<ChipKind, () => ReturnType<typeof ReactNodeViewRenderer>> =
  Object.fromEntries(CHIP_SPECS.map((spec) => [spec.kind, makeNodeView(spec)])) as Record<
    ChipKind,
    () => ReturnType<typeof ReactNodeViewRenderer>
  >;
