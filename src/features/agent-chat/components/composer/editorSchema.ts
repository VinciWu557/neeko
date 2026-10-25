import type { Extensions, NodeViewRenderer } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Mention from '@tiptap/extension-mention';
import Paragraph from '@tiptap/extension-paragraph';
import Placeholder from '@tiptap/extension-placeholder';
import Text from '@tiptap/extension-text';
import { PluginKey } from '@tiptap/pm/state';
import type { SuggestionOptions } from '@tiptap/suggestion';

import type { ComposerDocJson, ComposerDocNode } from '@/shared/types/tab';

import { CHIP_SPECS, chipAttrOf, chipNodeToPromptText, chipSpecOfNode } from './chipSpec';
import type { ChipKind, ChipSpec } from './chipSpec';

/**
 * composer 的 schema 装配 + 序列化契约。
 *
 * # 分层（为什么本文件不 import React）
 *
 * 本模块是**纯 schema + 序列化**层：`docToPromptText` / `docToRequestFiles` 可以在
 * node 环境密集单测。chip 的 React node view 由装配点（`RichComposer`）经
 * `buildComposerExtensions({ nodeViews })` 注入 —— 把 React 拉进来会让「序列化
 * 契约」的测试被迫跑在 jsdom + lucide 图标生态里。
 *
 * # 表驱动（为什么本文件没有逐条 chip 定义）
 *
 * 节点名、属性、展示、序列化全部来自 `chipSpec.ts`。新增一种 chip 只需在
 * `CHIP_SPECS` 加一条 —— 本文件按表循环装配，不出现「命令 chip 一个块、
 * 文件 chip 一个块」的手写重复（那是收表之前 7 处硬编码的来源）。
 */

/**
 * 把一个 `ChipSpec` 变成 `Mention` 扩展实例。
 *
 * 所有 chip 都是 `Mention` 的 `.extend`：`deleteTriggerWithBackspace` 让退格整块
 * 删除 chip（含触发符），光标永不落在 chip 内部 —— 这是 chip 作为 inline atom
 * token 的前提。
 */
function chipExtensionOf(spec: ChipSpec) {
  return Mention.extend({
    name: spec.node,
    addAttributes() {
      const parent = this.parent?.() ?? {};
      // 属性定义也来自表：新增属性只改 chipSpec，不在这里逐条手写 parse/render。
      return {
        ...parent,
        ...Object.fromEntries(
          spec.attrs.map((attr) => {
            const htmlAttr = attr.htmlAttr ?? `data-chip-${attr.key}`;
            return [
              attr.key,
              {
                default: null,
                parseHTML: (element: HTMLElement) => element.getAttribute(htmlAttr),
                renderHTML: (attributes: Record<string, unknown>) => ({
                  [htmlAttr]: attributes[attr.key],
                }),
              },
            ];
          }),
        ),
      };
    },
    // 序列化文本从 chipSpec 派生（`renderText` 被 getText()/复制粘贴消费，
    // 形状必须与 `docToPromptText` 一致 —— 同一份实现，不写第二遍）。
    renderText: ({ node }) => chipNodeToPromptText({ type: spec.node, attrs: node.attrs }) ?? '',
    renderHTML: ({ node }) => {
      const htmlAttrs: Record<string, unknown> = {
        'data-type': spec.node,
        class: `composer-chip ${spec.className}`,
      };
      for (const attr of spec.attrs) {
        const value = chipAttrOf(node.attrs, attr.key);
        if (value !== null) htmlAttrs[attr.htmlAttr ?? `data-chip-${attr.key}`] = value;
      }
      return ['span', htmlAttrs, spec.displayText(node.attrs)];
    },
  });
}

/** 每种 chip 的扩展定义（模块级单例 —— 扩展身份稳定，编辑器不会无故重建）。 */
const CHIP_EXTENSIONS = new Map(CHIP_SPECS.map((spec) => [spec.kind, chipExtensionOf(spec)]));

/**
 * chip 的 node view 工厂（**渲染层**注入点）。
 *
 * 按 `kind` 索引而不是手写 `command` / `file` 两个字段：后者是第二份「种类 ↔
 * 渲染器」对应关系，新增 chip 时两处都要改，而类型检查不会提醒你。
 *
 * `Partial` 是**有意**的：schema 级单测可以只要 schema、不要 node view
 *（那样不必拉进 jsdom + lucide）。生产装配点传完整的 `CHIP_NODE_VIEWS`。
 */
export type ChipNodeViews = Partial<Record<ChipKind, () => NodeViewRenderer>>;

/** 独立使用（schema 级测试 / 无弹层场景）的兜底 suggestion：只定触发符与 key。 */
function fallbackSuggestionOf(spec: ChipSpec): Omit<SuggestionOptions, 'editor'> {
  return { char: spec.trigger, pluginKey: new PluginKey(`composer${spec.node}Suggestion`) };
}

export interface ComposerExtensionOptions {
  /** 每种 chip 的 suggestion 配置（缺省用兜底：触发符 + 独立 pluginKey）。 */
  suggestions?: Partial<Record<ChipKind, Omit<SuggestionOptions, 'editor'>>>;
  /** 每种 chip 的 React node view（由装配点注入，见模块文档的分层说明）。 */
  nodeViews?: ChipNodeViews;
}

/**
 * 装配 composer 的扩展集。
 *
 * schema 故意窄（prd Non-Goals）：只有段落 / 文本 / chip，不引入加粗、标题、
 * 代码块。schema 越窄，IME 组合期的解析面与序列化暴露面越小。
 * Tiptap 3 core 不再内建 Doc/Paragraph/Text，显式引入。
 */
export function buildComposerExtensions(options: ComposerExtensionOptions = {}): Extensions {
  const chips = CHIP_SPECS.map((spec) => {
    const base = CHIP_EXTENSIONS.get(spec.kind) ?? chipExtensionOf(spec);
    const nodeView = options.nodeViews?.[spec.kind];
    // node view 只能挂在节点定义上（`.configure` 覆盖不到 `addNodeView`），
    // 因此用 `.extend` 合进定义 —— schema 层仍不 import React。
    const withView = nodeView ? base.extend({ addNodeView: nodeView }) : base;
    return withView.configure({
      deleteTriggerWithBackspace: true,
      suggestion: options.suggestions?.[spec.kind] ?? fallbackSuggestionOf(spec),
    });
  });
  return [
    Document,
    Paragraph,
    Text,
    ...chips,
    Placeholder.configure({ placeholder: 'Type a message...' }),
  ];
}

/**
 * 文档 → prompt 纯文本（R2 序列化契约，golden 测试锁死）。
 *
 * - chip → `chipSpec.toPromptText`（`/name ` / `@path `，**尾随空格无条件保留**，
 *   与 `renderText` 同一实现；pi 展开依赖该形状，见 spec agent-chat-transports §9.4）
 * - 段落之间以 `\n` 连接；`hardBreak` 也是 `\n`
 * - 纯函数：输入是 `getJSON()` 形状，不依赖编辑器实例，可密集单测
 *
 * 不用 `getText()`：序列化形状必须与「附件是否已添加」解耦。
 */
export function docToPromptText(doc: ComposerDocJson | null | undefined): string {
  return (doc?.content ?? []).map((block) => nodeToText(block)).join('\n');
}

function nodeToText(node: ComposerDocNode): string {
  switch (node.type) {
    case 'text':
      return node.text ?? '';
    case 'hardBreak':
      return '\n';
    default: {
      // chip 节点：形状来自 chipSpec（新增 chip 不修改本函数 —— 开闭原则）。
      const chipText = chipNodeToPromptText(node);
      if (chipText !== null) return chipText;
      // 未知容器递归内容（对 schema 演进保持容忍）；未知叶子（无 content）忽略。
      return (node.content ?? []).map((child) => nodeToText(child)).join('');
    }
  }
}

/**
 * 文档 → 后端请求的 `files` 列表（**附件是文档的投影，不是独立 state**）。
 *
 * `@` 提及曾在编辑器里放一个 chip、同时在 `useChatAttachments` 里存一份附件。
 * 两份表示没有任何同步 —— 用户退格删掉 chip 后附件仍在，照样随消息发出去
 * （「以为移除了、实际没有」）。改成投影后，chip 在文档里存在 ⇔ 文件在请求里
 * 存在，结构上不可能分叉。
 *
 * 去重按**首次出现顺序**（同一路径重复提及只发一次）；空路径忽略。
 */
export function docToRequestFiles(doc: ComposerDocJson | null | undefined): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  const walk = (node: ComposerDocNode): void => {
    // 「哪种 chip 算文件」与「路径存在哪个属性」都来自 chipSpec —— 新增 chip
    // 不会被误判成文件，也不会因为属性名不同而取不到路径。
    const pathAttr = chipSpecOfNode(node.type)?.filePathAttr;
    if (pathAttr) {
      const path = chipAttrOf(node.attrs, pathAttr);
      if (path && !seen.has(path)) {
        seen.add(path);
        files.push(path);
      }
      return;
    }
    for (const child of node.content ?? []) walk(child);
  };
  for (const block of doc?.content ?? []) walk(block);
  return files;
}

/**
 * 旧纯文本草稿 → 文档 JSON（design §7 迁移：textarea 时代的 `input` 字符串恢复时
 * 不走 HTML 解析，按行拆成段落；单版本后随旧链路一起清理）。
 */
export function plainTextToDoc(text: string): ComposerDocJson {
  return {
    type: 'doc',
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : undefined,
    })),
  };
}
