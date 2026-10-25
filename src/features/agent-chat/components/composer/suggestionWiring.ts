import type { Editor, Range } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import type { SuggestionOptions, SuggestionProps } from '@tiptap/suggestion';

import type { ComposerPaletteSource, PaletteItem } from '../paletteSources';

import type { ChipKind } from './chipSpec';
import { chipSpecOfKind } from './chipSpec';
import PalettePopup from './PalettePopup';
import type { PalettePopupHandle, PalettePopupProps } from './PalettePopup';

/**
 * chip 弹层的 suggestion 配置（design §3）：触发/过滤/异步/键盘导航全部交给
 * Tiptap Suggestion 引擎，数据源与弹层 UI 原样复用 10-21 的
 * `paletteSources` / `ComposerPalette`。数据源的异步问题（命令查询 + agentId
 * 缓存、文件树预取）已由 `useComposerSources` 在上游解决，这里的 `items` 是对
 * 内存列表的同步过滤（`paletteSources::searchPaletteItems`，按空格分词 + 上限
 * 50），不需要引擎的 debounce / AbortController。
 */

/**
 * 每种 chip 独立 PluginKey（两个 `Mention` 实例共用默认 key 会冲突）。
 *
 * 按 `kind` 索引而不是手写 `COMMAND_…` / `FILE_…` 两个常量：后者是第二套
 * 「种类 ↔ 名字」映射，新增 chip 时两处都要改且类型检查不会提醒。
 */
const SUGGESTION_KEYS: Record<ChipKind, PluginKey> = {
  slash: new PluginKey('composerSlashSuggestion'),
  mention: new PluginKey('composerMentionSuggestion'),
};

/** 传给 suggestion 的数据源视图（由 RichComposer 的 sourcesRef 实时求值）。 */
export type ComposerSuggestionSources = Record<ChipKind, ComposerPaletteSource | null>;

const EMPTY_MENTION_SOURCE: ComposerPaletteSource = {
  kind: 'mention',
  emptyText: 'No files loaded yet',
  getItems: () => [],
};

export function toSuggestionSources(
  sources: readonly ComposerPaletteSource[] | undefined,
): ComposerSuggestionSources {
  return {
    // null = slash 能力位关闭：`/` 完全不激活（R2 —— 连 items 都不问）。
    slash: sources?.find((s) => s.kind === 'slash') ?? null,
    mention: sources?.find((s) => s.kind === 'mention') ?? EMPTY_MENTION_SOURCE,
  };
}

/**
 * 编辑器层的弹层状态查询（供 RichComposer 的 Enter 发送分支让路用）。
 *
 * PM 的 `someProp` 先跑 editorProps 再跑插件 —— 发送分支必须**主动**判断
 * 「弹层是否在消费 Enter」，否则弹层打开时 Enter 会先触发发送（AC7 缺陷形态）。
 */
export interface ComposerSuggestionController {
  isPopupOpen(): boolean;
  /** 弹层打开且候选非空 —— 此时的 Enter 语义是「选中候选」。 */
  isPopupConsumingEnter(): boolean;
}

interface SuggestionRuntimeState {
  open: boolean;
  itemCount: number;
}

export function createComposerSuggestions(getSources: () => ComposerSuggestionSources): {
  /** 按 `kind` 索引的 suggestion 配置（直接交给 `buildComposerExtensions`）。 */
  suggestions: Record<ChipKind, Omit<SuggestionOptions<PaletteItem>, 'editor'>>;
  controller: ComposerSuggestionController;
} {
  const states: Record<ChipKind, SuggestionRuntimeState> = {
    slash: { open: false, itemCount: 0 },
    mention: { open: false, itemCount: 0 },
  };
  const suggestions = Object.fromEntries(
    (Object.keys(SUGGESTION_KEYS) as ChipKind[]).map((kind) => [
      kind,
      createChipSuggestion({
        kind,
        pluginKey: SUGGESTION_KEYS[kind],
        pickSource: () => getSources()[kind],
        state: states[kind],
      }),
    ]),
  ) as Record<ChipKind, Omit<SuggestionOptions<PaletteItem>, 'editor'>>;

  const all = Object.values(states);
  return {
    suggestions,
    controller: {
      isPopupOpen: () => all.some((s) => s.open),
      isPopupConsumingEnter: () => all.some((s) => s.open && s.itemCount > 0),
    },
  };
}

function createChipSuggestion(params: {
  kind: ChipKind;
  pluginKey: PluginKey;
  pickSource: () => ComposerPaletteSource | null;
  state: SuggestionRuntimeState;
}): Omit<SuggestionOptions<PaletteItem>, 'editor'> {
  const spec = chipSpecOfKind(params.kind);
  return {
    // 触发符来自 chipSpec —— 本模块不硬编码 `'/'` / `'@'`
    char: spec.trigger,
    pluginKey: params.pluginKey,
    // 能力位门控单点：无数据源时匹配到了也不激活 —— 不问 items、不渲染弹层。
    // （IPC 查询侧的门在 useAgentCommands：enabled=false 连查询都不发。）
    shouldShow: () => params.pickSource() !== null,
    items: ({ query }) => params.pickSource()?.getItems(query) ?? [],
    command: ({ editor, range, props: item }) => {
      insertChip(editor, range, params.kind, item);
      // 选中副作用走数据源自带的 onPick（@ 文件 → addAttachment，红线 12 链路不变）。
      params.pickSource()?.onPick?.(item);
    },
    render: createPaletteRender(params),
  };
}

/**
 * chip 插入：替换 `[range]`（触发符 + query）为 chip 节点。**不插尾随空格** ——
 * 序列化契约里 chip 自带尾随空格（`/name `），再插文本空格会产出双空格，
 * 破坏 golden 形状（design §2）。
 */
function insertChip(editor: Editor, range: Range, kind: ChipKind, item: PaletteItem): void {
  const spec = chipSpecOfKind(kind);
  const chip = { type: spec.node, attrs: spec.attrsOf(item) };
  editor.chain().focus().insertContentAt(range, chip).run();
}

/**
 * 弹层渲染器：经 ReactRenderer 挂现有 `ComposerPalette`（骨架 + 数据源都复用），
 * 元素追加到 `.rich-composer-root`（贴编辑器上沿，与 10-21 的
 * `.composer-palette` 定位决策一致 —— 不做光标级跟随，不用引擎的 floating 定位）。
 */
function createPaletteRender(params: {
  kind: ChipKind;
  pickSource: () => ComposerPaletteSource | null;
  state: SuggestionRuntimeState;
}): NonNullable<Omit<SuggestionOptions<PaletteItem>, 'editor'>['render']> {
  return () => {
    let renderer: ReactRenderer<PalettePopupHandle, PalettePopupProps> | null = null;
    const popupProps = (props: SuggestionProps<PaletteItem>) => ({
      kind: params.kind,
      items: props.items,
      emptyText: params.pickSource()?.emptyText ?? '',
      command: props.command,
    });
    return {
      onStart: (props) => {
        params.state.open = true;
        params.state.itemCount = props.items.length;
        renderer = new ReactRenderer<PalettePopupHandle, PalettePopupProps>(PalettePopup, {
          props: popupProps(props),
          editor: props.editor,
        });
        const container = props.editor.view.dom.closest('.rich-composer-root');
        (container ?? document.body).appendChild(renderer.element);
      },
      onUpdate: (props) => {
        params.state.itemCount = props.items.length;
        renderer?.updateProps(popupProps(props));
      },
      onExit: () => {
        params.state.open = false;
        params.state.itemCount = 0;
        renderer?.element.remove();
        renderer?.destroy();
        renderer = null;
      },
      onKeyDown: ({ event, view }) => renderer?.ref?.onKeyDown(event, view) ?? false,
    };
  };
}
