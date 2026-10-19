/**
 * 译文在编辑器中的**数据层**（`StateField` + `StateEffect`）。
 *
 * ## 为什么不把译文放进 `extensions` 依赖（AC16）
 *
 * `@uiw/react-codemirror` 在 `extensions` **prop 身份**变化时 dispatch
 * `StateEffect.reconfigure`，而 reconfigure 会**整体替换 base 配置** ——
 * 把 lint 等经 `appendConfig` 惰性安装的扩展一并丢弃（`quality-guidelines.md` 禁止模式 10）。
 *
 * 译文是**高频变化的活数据**（每批翻译到达都会变）。若接进 `extensions` 依赖，
 * 每次译文更新都重建整个扩展世界 → 波浪线等静默消失，且无任何报错。
 *
 * 正确形态：模块级 `StateField`（值跨 reconfigure 保留）+ `StateEffect` 推送（唯一写入口）。
 * 与 `lspDiagnosticsProjection.ts` 同构，这是仓库已验证的模式。
 *
 * ## 为什么 field 必须模块级定义
 *
 * `StateField.define` 每次调用分配**新 id**。`slot.reconfigure` 只在「旧配置里存在
 * 同 id 字段」时保留值 —— 写成函数内定义会让 reconfigure 后的值静默归零。
 */
import { StateEffect, StateField } from '@codemirror/state';

/** 译文显示模式（U1 定案：默认 `below`）。 */
export type CommentDisplayMode = 'below' | 'inline' | 'hover' | 'off';

/** 一条译文（位置 + 文本）。 */
export interface CommentTranslationEntry {
  /** 组在文档中的起始位置。 */
  from: number;
  /** 组在文档中的结束位置。 */
  to: number;
  /** 译文（多行以 `\n` 连接）。 */
  text: string;
  /** 失败原因（有值表示这条没翻成功，呈现层画 reason chip）。 */
  reason?: string;
  /**
   * 失败类型：决定 chip 的措辞与「重试」是否可用。
   *
   * `transport`（断网 / Agent 崩溃 / 超时）不是这一条注释的问题，重试单组通常也没用 ——
   * 这类故障由通知中心统一上报，chip 只说明发生了什么。`validation`（译文没过校验）
   * 才是单组重试真正能救的场景。
   */
  failureKind?: 'validation' | 'transport';
  /**
   * 所属组的标识（`CommentGroup.startLine`，1-based）—— 单组重试（R6.6）的定位依据。
   *
   * 为什么带在这条数据上而不是另建一张表：chip 是**纯 DOM** 产物（`WidgetType.toDOM`），
   * 它只知道自己渲染的这条 entry 与文档位置；「点的是哪个组」必须能从 DOM 直接读到，
   * 否则就得在渲染层再建一份「位置 → 组」的映射（第二份事实源，必然漂移）。
   */
  groupKey?: number;
}

/** 一次推送的完整载荷（**整体替换**语义，不是增量合并）。 */
export interface CommentTranslationPayload {
  mode: CommentDisplayMode;
  entries: readonly CommentTranslationEntry[];
}

/** 空载荷（初始值 / 清空）。 */
const EMPTY: CommentTranslationPayload = { mode: 'off', entries: [] };

/**
 * 推送译文的**唯一写入口**。
 *
 * 整体替换而非增量合并：译文集合由引擎一次算完，增量合并会引入「旧条目残留」类问题。
 */
export const setCommentTranslations = StateEffect.define<CommentTranslationPayload>();

/**
 * 译文镜像（模块级单例）。
 *
 * 文档变化时用 `mapPos` 映射位置：
 * - `from` 用 `assoc: 1`（插入点之前的文本属于新内容，位置往后靠）
 * - `to` 用 `assoc: -1`（删除点之后的文本仍属于原区间，位置往前靠）
 *
 * 区间被删空（`from >= to`）的条目丢弃 —— 那些组的注释已经不存在了。
 */
export const commentTranslationField = StateField.define<CommentTranslationPayload>({
  create: () => EMPTY,
  update(value, tr) {
    let next = value;

    // 1. 文档变化 → 映射位置
    if (tr.docChanged && next.entries.length > 0) {
      const mapped: CommentTranslationEntry[] = [];
      for (const entry of next.entries) {
        const from = tr.changes.mapPos(entry.from, 1);
        const to = tr.changes.mapPos(entry.to, -1);
        // 区间塌缩 → 该注释已被删除/替换，丢弃
        if (from < to) mapped.push({ ...entry, from, to });
      }
      next = { ...next, entries: mapped };
    }

    // 2. 推送 → 整体替换
    for (const effect of tr.effects) {
      if (effect.is(setCommentTranslations)) next = effect.value;
    }

    return next;
  },
});
