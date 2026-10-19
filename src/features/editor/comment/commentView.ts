/**
 * 译文在编辑器中的**渲染层**（CodeMirror `Decoration` + `WidgetType`）。
 *
 * ## 分层
 *
 * ```
 * commentTranslations.ts   数据（StateField + StateEffect）
 * commentDecorations.ts    规格（纯函数：哪些条目、画在哪、画成什么）
 * commentView.ts           ← 本文件：规格 → 真实 Decoration/Widget + reconciler
 * ```
 *
 * 这样「裁剪与模式逻辑」在 node 环境可测，「DOM 生成」只在真实编辑器里跑。
 *
 * ## 为什么不写盘（R3.1）
 *
 * `Decoration` 只影响**渲染**，文档字节零改动（AC15）。这是本任务的核心约束：
 * 译文永远不进文件，出口是「复制到剪贴板」。
 *
 * ## 装饰的来源必须按种类分开（这是本文件最容易踩错的地方）
 *
 * | 装饰种类 | 提供者 | 为什么 |
 * | --- | --- | --- |
 * | `block-widget`（`below`） | **`StateField`** + `EditorView.decorations.from` | CM 硬性禁止插件提供 block 装饰 |
 * | `inline-widget` / `hover-anchor` | `ViewPlugin` | 需要 `visibleRanges` 裁剪，而 StateField 拿不到 view |
 *
 * 详见 {@link blockDecorationsField} 的错误实证与 {@link commentDecorationsPlugin} 的边界说明。
 */
import { StateField, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';

import { buildCommentDecorations, type CommentDecoration } from './commentDecorations';
import { markChipRetryable, retryGroupKeyOf, retryHandlerFor } from './commentRetryBridge';
import {
  commentTranslationField,
  setCommentTranslations,
  type CommentDisplayMode,
  type CommentTranslationEntry,
  type CommentTranslationPayload,
} from './commentTranslations';
export { RETRY_GROUP_ATTRIBUTE, registerCommentRetryHandler } from './commentRetryBridge';
export type { RetryTargetRef } from './commentRetryBridge';

/** 译文块 widget（`below` 模式）。 */
class BelowWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly reason: string | undefined,
    private readonly groupKey: number | undefined,
  ) {
    super();
  }

  eq(other: BelowWidget): boolean {
    return (
      other.text === this.text && other.reason === this.reason && other.groupKey === this.groupKey
    );
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'cm-comment-translation cm-comment-translation--below';

    if (this.reason) {
      const chip = document.createElement('span');
      chip.className = 'cm-comment-translation__reason';
      chip.textContent = `⚠ ${this.reason}`;
      markChipRetryable(chip, this.groupKey);
      wrapper.appendChild(chip);
      return wrapper;
    }

    // 多行译文逐行成块（保留行结构，读者能对上原文）
    for (const line of this.text.split('\n')) {
      const row = document.createElement('div');
      row.className = 'cm-comment-translation__line';
      row.textContent = line;
      wrapper.appendChild(row);
    }
    return wrapper;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/** 行内译文 widget（`inline` 模式）。 */
class InlineWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly reason: string | undefined,
    private readonly groupKey: number | undefined,
  ) {
    super();
  }

  eq(other: InlineWidget): boolean {
    return (
      other.text === this.text && other.reason === this.reason && other.groupKey === this.groupKey
    );
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-comment-translation cm-comment-translation--inline';
    if (this.reason) {
      span.textContent = `⚠ ${this.reason}`;
      // 行内模式下整个 widget 就是 chip：标记直接落在 span 上（没有独立 chip 元素）
      markChipRetryable(span, this.groupKey);
    } else {
      span.textContent = `→ ${this.text}`;
    }
    return span;
  }

  ignoreEvent(): boolean {
    // 译文不参与选中/复制（R6.5）：让事件穿透到编辑器
    //
    // `false` 是**必需**的：CM 的 `eventBelongsToEditor` 在 widget 的 `ignoreEvent` 返回
    // true 时直接丢弃事件，`domEventHandlers` 永远收不到 —— 也就是说这里返回 true 会让
    // 失败 chip 的点击重试静默失效（编译、类型、渲染全绿）。
    return false;
  }
}

/** 悬停锚点（`hover` 模式）：零宽 widget，承载 `title`。 */
class HoverAnchorWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly reason: string | undefined,
  ) {
    super();
  }

  eq(other: HoverAnchorWidget): boolean {
    return other.text === this.text && other.reason === this.reason;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-comment-translation__hover-anchor';
    span.title = this.reason ? `⚠ ${this.reason}` : this.text;
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** 规格 → 真实 Decoration。 */
function toDecoration(spec: CommentDecoration): Decoration {
  switch (spec.kind) {
    case 'block-widget':
      // block widget **不能带 side**：它独占行，side 是行内 widget 的概念。
      // 带 side 会让 CM 静默不渲染（实测：below 模式的 widget 完全不出现在 DOM 里，
      // 而 inline / hover 正常 —— 差别只在这个选项）。
      //
      // 另一条硬约束与本选项无关：block 装饰**不能来自 ViewPlugin**，只能来自
      // StateField（见 {@link blockDecorationsField}）。
      return Decoration.widget({
        widget: new BelowWidget(spec.text, spec.reason, spec.groupKey),
        block: true,
      });
    case 'inline-widget':
      return Decoration.widget({
        widget: new InlineWidget(spec.text, spec.reason, spec.groupKey),
        side: 1,
      });
    case 'hover-anchor':
      return Decoration.widget({
        widget: new HoverAnchorWidget(spec.text, spec.reason),
        side: 1,
      });
  }
}

/**
 * 排序要求：`RangeSetBuilder` 要求按位置升序添加 —— `buildCommentDecorations` 已排序，
 * 但同一位置可能有多条（不同组的结束位置相接），故用 `Decoration.set(ranges, true)` 的排序模式。
 */
function rangesOf(specs: readonly CommentDecoration[]): DecorationSet {
  if (specs.length === 0) return Decoration.none;
  return Decoration.set(
    specs.map((spec) => toDecoration(spec).range(spec.at)),
    true,
  );
}

/**
 * 「全量区间」替身：StateField 里拿不到 `view.visibleRanges`，故不裁剪。
 *
 * 代价可忽略 —— block 装饰进 `DecorationSet` 的只是**规格**，真正的 DOM 由 CM
 * 按视口惰性创建（`BlockWidgets` 只实测可见行）。裁剪在这里省不到任何时间。
 */
const FULL_RANGE = { from: 0, to: Number.MAX_SAFE_INTEGER } as const;

/** 只保留块级装饰（`below` 模式的译文块）。 */
function buildBlockDecorationSet(payload: CommentTranslationPayload): DecorationSet {
  if (payload.mode !== 'below' || payload.entries.length === 0) return Decoration.none;
  const specs = buildCommentDecorations({
    entries: payload.entries,
    visibleRanges: [FULL_RANGE],
    mode: payload.mode,
  });
  return rangesOf(specs.filter((spec) => spec.kind === 'block-widget'));
}

/**
 * 译文块（`below`）的**块级装饰字段**。
 *
 * ## 为什么必须是 StateField（实证，不是风格选择）
 *
 * CodeMirror 6 **硬性禁止**插件提供 block 装饰。实测 @codemirror/view 6.43.11：
 * 只要 `Decoration.widget({ block: true })` 来自 `ViewPlugin.decorations`，
 * 渲染路径 `emit()` 的 `disallowBlockEffectsFor` 分支立即抛
 *
 * ```
 * RangeError: Block decorations may not be specified via plugins
 * ```
 *
 * 该异常发生在 dispatch 期间，会被控制器的 `try/catch` 吞成一条 console.error，
 * 用户侧表现是「点了翻译，界面毫无变化」。`below` 是 U1 定案的默认模式，
 * 也就是说这个异常会让功能整体不可用。修法只有一条：
 * 由 `StateField` 持有 + `EditorView.decorations.from(field)` 提供。
 *
 * ## 为什么 update 里不读 `tr.state`
 *
 * 字段求值期间读 `tr.state.field(...)` 会重入 `applyTransaction`（字段值尚未算完），
 * 因此这里直接检查 `tr.effects` —— 载荷的唯一写入口就是 `setCommentTranslations`。
 */
export const blockDecorationsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setCommentTranslations)) return buildBlockDecorationSet(effect.value);
    }
    // 文档变化：位置映射即可。条目本身的映射在 `commentTranslationField`（同一事务内对齐）。
    if (tr.docChanged) return deco.map(tr.changes);
    return deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * 按当前 state 与可视区构建**插件侧**（`inline-widget` / `hover-anchor`）的 `DecorationSet`。
 */
function buildPluginDecorationSet(view: EditorView): DecorationSet {
  const payload = view.state.field(commentTranslationField, false);
  if (!payload || payload.entries.length === 0 || payload.mode === 'off') {
    return Decoration.none;
  }

  const specs = buildCommentDecorations({
    entries: payload.entries,
    visibleRanges: view.visibleRanges,
    mode: payload.mode,
  });
  // block 装饰**不得**出现在这里（会抛 RangeError），由 `blockDecorationsField` 负责。
  return rangesOf(specs.filter((spec) => spec.kind !== 'block-widget'));
}

/**
 * 重算触发器（**只负责行内 / 悬停两类**）。
 *
 * 为什么还留着 ViewPlugin —— 这是**唯一**的允许理由：
 * `buildCommentDecorations` 需要 `view.visibleRanges` 做裁剪（AC14：5000 行文件里 400 条注释，
 * 全量建 DOM widget 会卡），而 `StateField` 的 update 里**拿不到 view**。
 * inline / hover 的 widget DOM 随视口真实创建，裁剪才有收益；block 装饰反过来（只有规格）。
 *
 * 触发条件（任一）：视口变化 / 译文载荷变化 / 文档变化。
 * 载荷变化用「field 值引用变化」判定：`commentTranslationField` 只在推送或映射时产出新引用，
 * 比逐一比对 effect 种类更可靠（effect 种类会随演进增加）。
 */
const commentDecorationsPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildPluginDecorationSet(view);
    }

    update(update: ViewUpdate): void {
      const before = update.startState.field(commentTranslationField, false);
      const after = update.state.field(commentTranslationField, false);
      const payloadChanged = before !== after;

      if (update.viewportChanged || update.docChanged || payloadChanged) {
        this.decorations = buildPluginDecorationSet(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    /**
     * 失败 chip 的点击 → 单组重试（R6.6）。
     *
     * ## 为什么用插件 `eventHandlers` 而不是 `EditorView.domEventHandlers({ click })` 包一层
     *
     * 两者在 CM 里落到**同一个**处理器表（`ViewPlugin.define` 的 `eventHandlers` 就是给
     * `computeHandlers` 的插件槽）。选插件槽的好处：它跟着 `commentDecorationsPlugin` 的
     * 生命周期存在，不会因为漏挂另一个扩展而静默失效 —— 本文件已经因为「扩展只挂一半」
     * 踩过一次（见 `commentTranslationView` 的注释）。
     *
     * ## 必须返回 `true`
     *
     * 返回 `true` 会让 CM `preventDefault()` 并停止后续处理器，于是点击 chip 不会把光标移到
     * 译文边缘（那是没意义的交互）。返回 `false` 时事件继续走默认路径，会在译文块上放光标。
     */
    eventHandlers: {
      click(event, view) {
        const groupKey = retryGroupKeyOf(event);
        if (groupKey === null) return false;
        const handler = retryHandlerFor(view);
        // 未注册回调（如脱离 React 控制器的纯渲染测试）→ 不拦截事件
        if (!handler) return false;
        handler(groupKey);
        return true;
      },
    },
  },
);

/** 模块级单例（身份稳定，可直接放进 `extensions` 而不引入配置抖动）。 */
const COMMENT_TRANSLATION_VIEW: Extension = [blockDecorationsField, commentDecorationsPlugin];

/**
 * 译文渲染扩展（模块级单例，**自包含 field**）。
 *
 * 为什么返回三个扩展而不是只返回 plugin：渲染依赖两个模块级 field
 * （`commentTranslationField` 数据 + `blockDecorationsField` 块装饰）。若让调用方自己记得挂，
 * 漏掉一处就表现为**widget 静默不渲染**或**block 装饰直接抛 RangeError** —— 实测踩过：
 * 测试只挂了 plugin，`state.field(field, false)` 返回 `undefined`，装饰永远是空的。
 *
 * 自包含后「装了视图就等于装了数据层 + 块装饰」，单一入口不可能漏。
 *
 * 装配点：`useEditorExtensions` 的**稳定段** —— 与字体/语言扩展同列，
 * 不随译文数据变化（否则触发 reconfigure，见 AC16）。
 */
export function commentTranslationView(): Extension {
  return [commentTranslationField, COMMENT_TRANSLATION_VIEW];
}

/**
 * @internal 测试钩子：直接构造 below widget 以断言 `toDOM()` 产物。
 *
 * 它测的是 **widget 产物**（文本逐行成块、失败 chip），与「block 装饰能否挂到编辑器上」
 * 是两件事 —— 后者由 `commentView.test.ts` 里带真实 `EditorView` 的用例锁住
 * （`createBelowWidgetForTest` 绕开了装饰装配，测不到那条 RangeError）。
 */
export function createBelowWidgetForTest(
  text: string,
  reason?: string,
  groupKey?: number,
): WidgetType {
  return new BelowWidget(text, reason, groupKey);
}

/** 供控制器构造条目（避免上层重复处理 reason 的可选性）。 */
export function toEntry(
  from: number,
  to: number,
  text: string,
  reason?: string,
  groupKey?: number,
): CommentTranslationEntry {
  return {
    from,
    to,
    text,
    ...(reason === undefined ? {} : { reason }),
    ...(groupKey === undefined ? {} : { groupKey }),
  };
}

/** 导出模式联合，供控制器与 UI 复用（单一类型源）。 */
export type { CommentDisplayMode };
