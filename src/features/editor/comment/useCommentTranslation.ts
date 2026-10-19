/**
 * 注释翻译控制器 —— 把纯函数层串成一条可用的流程。
 *
 * ```
 * 源码 + 语法树
 *   → extractComments      注释单元
 *   → groupComments        逻辑块
 *   → classifyBlock        组级门禁（shebang/directive/license/doc/prose）
 *   → segmentBlock         块内分段（prose/tag 送翻；code/fence/blank 原样）
 *   → translateSegments    去重 → 缓存 → 补漏 → 校验 → 重试
 *   → setCommentTranslations  推给 StateField
 * ```
 *
 * ## 为什么控制器不直接 import CodeMirror
 *
 * 它只产出 {@link CommentTranslationEntry}（位置 + 译文），由调用方 dispatch
 * `setCommentTranslations`。这样控制器在测试里可用普通对象驱动，不需要真实 `EditorView`。
 *
 * ## abort 语义
 *
 * 停止不回收已完成成果（沿用仓库共识）：已翻译的段保留，未处理的保持未译。
 *
 * ## 索引在这里建（性能）
 *
 * 行首表与声明节点索引都**只建一次**，然后经 `ctx` 传给每个组的分类与每段的定位。
 * 首版是在 `classifyBlock` 内部按组重建（扫全源 + 全树 DFS），实测 O(n²)：
 * 100 组 2.8ms → 400 组 22.1ms → 1600 组 215.6ms。
 *
 * ## entry 是**组级**的，不是段级（缺陷回归）
 *
 * 曾经按「一段一条 entry」产出，结果是注释里的代码行**凭空消失**：
 *
 * ```
 * // Replace the call:        entries = [ '替换调用：', '改为缓存。' ]
 * //   const x = f(a);         ← code 段没有 entry，渲染时整行不见
 * // with cache.
 * ```
 *
 * 根因：entry 的语义单位与渲染需要的单位不一致。渲染要的是**组**（组内译文段与 code
 * 原文行混排，逐行带原前缀 `// ` / ` * ` / docstring 引号与缩进）。所以 entries 必须
 * 按**组**聚合，经 {@link rebuildBlock} 重建出完整行再交付呈现层。
 */
import { createLineStarts } from '@/features/runner';

import { classifyBlock, createDeclIndex, type DeclIndex } from './classifyBlock';
import { commentAddress } from './commentAddress';
import { detectFamily, type LanguageFamily } from './commentSyntax';
import type { CommentDisplayMode, CommentTranslationEntry } from './commentTranslations';
import { extractComments, type TreeLike } from './extractComments';
import { groupComments, type CommentGroup } from './groupComments';
import { rebuildBlock, type RebuildInput } from './rebuildBlock';
import { segmentBlock, type Segment, type SegmentBlock } from './segmentBlock';
import { translateSegments, type TranslateTurn } from './translateSegments';
import type { TranslationCache } from './translationCache';

/** 跳过统计（进 UI，让用户看懂为什么某些注释没翻）。 */
export interface SkipSummary {
  /** 按组级类别统计（shebang / directive / license）。 */
  byKind: Record<string, number>;
  /** 代码段数（`code` + `fence`），它们永不送模型。 */
  codeSegments: number;
  /** 空段数。 */
  blankSegments: number;
}

/** 一次翻译作业的结果。 */
export interface CommentTranslationResult {
  entries: CommentTranslationEntry[];
  skipped: SkipSummary;
  /** 送翻译的段数。 */
  requestedSegments: number;
  /**
   * 拿到译文的段数（`requestedSegments` 的子集）。
   *
   * 与 `entries.length` 不是一回事：entries 是**组级**的（见文件顶部缺陷回归），
   * 工具条的「已译 N/M」需要段级计数，故单列。
   */
  translatedSegments: number;
  cacheHits: number;
  failedAddresses: string[];
  aborted: boolean;
}

/** 控制器选项。 */
export interface RunCommentTranslationOptions {
  filePath: string;
  source: string;
  /** 语法树（生产传 `syntaxTree(state)`；纯函数测试可传 `parser.parse()` 结果）。 */
  tree: TreeLike | null;
  targetLanguage: string;
  turn: TranslateTurn;
  cache: TranslationCache;
  signal?: { aborted: boolean };
  retryFailed?: boolean;
  /**
   * 只重算这些组（R6.6 单组重试）。标识是组的 **`startLine`（1-based）**。
   *
   * 为什么不用组下标：下标依赖「本次有哪些组被门禁跳过」。同一个源文件里门禁结果一变
   * （例如把 `// eslint-disable` 改成普通注释），下标就会指向**另一个组** —— 用户点了 A 组的
   * chip 却重试了 B 组，且全程无报错。也不是 `{from,to}` 偏移：偏移会随任何编辑平移，而
   * 重试的入口（chip 的 `data-` 属性）本就需要一个稳定、可读的标量。
   *
   * `startLine` 由语法树位置推导，同一份源码重新推导后落回同一组，且与 entry 的
   * `groupKey` 同源（`group.startLine`）—— chip 能直接把标识带到点击回调。
   */
  onlyGroups?: readonly number[];
  /**
   * 上一次的 entries（只在 `onlyGroups` 提供时生效）。
   *
   * 重试一部分组时，其余组的译文必须**原样保留**。这里必须显式传进来：
   * `setCommentTranslations` 是**整体替换**语义（见 `commentTranslations.ts` 的注释），
   * 控制器只能拿到「本次算出的组」，不合并就会把别的组的译文静默清空。
   */
  previousEntries?: readonly CommentTranslationEntry[];
  onProgress?: (progress: { total: number; done: number; failed: number; cached: number }) => void;
}

/** 一个待翻译段的完整上下文。 */
interface PendingSegment {
  address: string;
  text: string;
  forbiddenTexts: string[];
}

/** 一个可产出 entry 的组（段级结果回填到组级重建需要的信息）。 */
interface GroupPlan {
  group: CommentGroup;
  block: SegmentBlock;
  /** 可翻段 → 内容地址（`code`/`fence`/`blank` 不进请求，故不在表内）。 */
  addresses: Map<Segment, string>;
}

/** 计算若干行在文档中的范围（首行行首 → 末行行尾）。 */
function positionOfLines(
  startLine: number,
  endLine: number,
  lineStarts: readonly number[],
  source: string,
): { from: number; to: number } {
  const from = lineStarts[startLine - 1] ?? 0;
  const endLineStart = lineStarts[endLine - 1] ?? from;
  const tail = source.slice(endLineStart).split(/\r?\n/, 1)[0] ?? '';
  const to = endLineStart + tail.length;
  return { from, to: Math.max(to, from) };
}

/** 块注释重建时逐行补的前缀（` * `）—— 由 `rebuildBlock` 的契约固定。 */
const BLOCK_PREFIX = ' * ';

/**
 * 组的行前缀（重建时逐行补齐）。
 *
 * 契约（见 `rebuildBlock.ts`）：`prefix` 只含标记，缩进由 `indent` 单独表达。
 * 段上的 `prefix` 天然就是「标记」形态 —— 单元从标记处开始切（`unit.from` 在 `//`），
 * 行首缩进另行记在 `lineIndent`，所以两者不会叠加。
 *
 * 块注释统一用 ` * `：开闭标记由重建补出，原逐行前缀（`   * `）带缩进，直接用会双重缩进。
 */
function prefixOf(block: SegmentBlock): string {
  if (block.shape === 'block') return BLOCK_PREFIX;
  if (block.shape === 'docstring') return '';
  const first = block.segments.find(
    (segment) => segment.kind === 'prose' || segment.kind === 'tag',
  );
  return first?.prefix ?? '';
}

/**
 * 去掉块注释的开 / 闭标记段。
 *
 * 组把开标记行与闭标记行当作 `blank` 段收进来（它们是注释的一部分），而 `rebuildBlock`
 * 对 `shape === 'block'` **自己补出**开闭标记 —— 两者同时存在会重复输出标记行。
 */
function withoutBlockMarkers(block: SegmentBlock, group: CommentGroup): Segment[] {
  if (block.shape !== 'block') return block.segments;
  const { blockOpen, blockClose } = group.units[0];
  const segments = [...block.segments];
  const isMarker = (segment: Segment | undefined, marker: string | null): boolean =>
    segment !== undefined &&
    marker !== null &&
    segment.kind === 'blank' &&
    segment.lines.every((line) => line.trim() === marker);

  if (isMarker(segments[0], blockOpen)) segments.shift();
  if (isMarker(segments[segments.length - 1], blockClose)) segments.pop();
  return segments;
}

/** 组 + 段级译文 → 重建输入（缺译文的段 `text` 为空，重建时回退原文行）。 */
function rebuildInputOf(plan: GroupPlan, texts: ReadonlyMap<Segment, string>): RebuildInput {
  const { group, block } = plan;
  return {
    shape: block.shape,
    prefix: prefixOf(block),
    indent: group.indent,
    ...(block.shape === 'docstring' ? { docstring: group.units[0].docstring! } : {}),
    segments: withoutBlockMarkers(block, group).map((segment) => ({
      kind: segment.kind,
      lines: segment.lines,
      text: texts.get(segment) ?? '',
    })),
  };
}

/**
 * 合并「本次重算的组」与「既有 entries」（R6.6）。
 *
 * 规则：
 * - `onlyGroups` 未提供 → **原样返回本次结果**（整文件翻译是整体替换语义，
 *   已删除的注释组的旧译文必须随之消失，否则会残留幽灵译文）；
 * - 提供时 → 保留上一次里**本次没有重新产出**的 entry，再加上本次算出的 entry。
 *
 * 为什么「本次没有重新产出」而非「不在重试集合里」：重试可能因中止或异常而什么都没产出。
 * 那时把旧 entry 一并删掉会让 chip / 译文凭空消失 —— 重试本来是为了修好它，
 * 失败的重试不应该让界面比之前更差。所以只有「本次真的产出了同组新 entry」才替掉旧的。
 * 没有 `groupKey` 的旧 entry 一律保留（无法判定归属时宁可留着）。
 *
 * 按 `from` 升序是因为呈现层要求文档顺序，而两段来源的拼接天然不保序。
 */
export function mergeCommentEntries(
  previous: readonly CommentTranslationEntry[],
  current: readonly CommentTranslationEntry[],
  onlyGroups?: readonly number[],
): CommentTranslationEntry[] {
  if (onlyGroups === undefined) return [...current];
  const replaced = new Set(
    current.map((entry) => entry.groupKey).filter((key): key is number => key !== undefined),
  );
  const kept = previous.filter(
    (entry) => entry.groupKey === undefined || !replaced.has(entry.groupKey),
  );
  const merged = [...kept, ...current];
  merged.sort((a, b) => a.from - b.from || a.to - b.to);
  return merged;
}

/**
 * 跑一次注释翻译。
 *
 * 契约：**永远返回结果**（不抛穿）—— 单个组/段失败只影响它自己，
 * 其余照常翻译；失败原因进 `entries[].reason` 供 UI 显示。
 */
export async function runCommentTranslation(
  options: RunCommentTranslationOptions,
): Promise<CommentTranslationResult> {
  const {
    filePath,
    source,
    tree,
    targetLanguage,
    turn,
    cache,
    signal,
    retryFailed = true,
    onlyGroups,
    previousEntries,
    onProgress,
  } = options;

  const family: LanguageFamily = detectFamily(filePath);
  const skipped: SkipSummary = { byKind: {}, codeSegments: 0, blankSegments: 0 };

  const empty = (): CommentTranslationResult => ({
    entries: mergeCommentEntries(previousEntries ?? [], [], onlyGroups),
    skipped,
    requestedSegments: 0,
    translatedSegments: 0,
    cacheHits: 0,
    failedAddresses: [],
    aborted: false,
  });

  // 无法识别语言 → 不翻译（宁可没有按钮，也不给错按钮）
  if (family === 'unknown') return empty();

  // ── 1. 提取 → 分组 → 分类 → 分段 ──────────────────────────
  const units = extractComments({ family, tree, source });
  const groups = groupComments(units, { source, family });
  // 两份索引各建一次，组循环里共享（见文件顶部「索引在这里建」）。
  const lineStarts = createLineStarts(source);
  const declIndex: DeclIndex | null = createDeclIndex(tree);

  const pending: PendingSegment[] = [];
  const plans: GroupPlan[] = [];

  // 单组重试：只让目标组进入后续全部步骤（分类 / 分段 / 引擎 / entries）。
  // 在组循环入口收窄，而不是在四个下游各加一次判断 —— 后者漏写任何一处都表现为
  // 「别的组被重译」（只是变慢，无报错）或「被过滤的组又出现」（错误）。
  const scope = onlyGroups === undefined ? null : new Set(onlyGroups);

  for (const group of groups) {
    if (scope !== null && !scope.has(group.startLine)) continue;
    const verdict = classifyBlock(group, { source, family, tree, lineStarts, declIndex });

    // 组级门禁：整组跳过
    if (!verdict.translatable) {
      const key = verdict.kind;
      skipped.byKind[key] = (skipped.byKind[key] ?? 0) + 1;
      continue;
    }

    const block = segmentBlock(group);
    const forbiddenTexts = block.segments
      .filter((segment) => segment.kind === 'code' || segment.kind === 'fence')
      .map((segment) => segment.text);

    const plan: GroupPlan = { group, block, addresses: new Map() };

    for (const segment of block.segments) {
      if (segment.kind === 'code' || segment.kind === 'fence') {
        skipped.codeSegments++;
        continue;
      }
      if (segment.kind === 'blank') {
        skipped.blankSegments++;
        continue;
      }
      if (!segment.translatable) continue;

      const address = commentAddress(segment.text);
      plan.addresses.set(segment, address);
      pending.push({ address, text: segment.text, forbiddenTexts });
    }

    // 组内无任何可翻段（如整块都是代码示例）→ 无可重建内容，不产出 entry
    if (plan.addresses.size > 0) plans.push(plan);
  }

  if (pending.length === 0) return empty();
  // ── 2. 引擎：去重 → 缓存 → 补漏 → 校验 → 重试 ────────────────
  const engine = await translateSegments({
    segments: pending.map((item) => ({
      address: item.address,
      text: item.text,
      forbiddenTexts: item.forbiddenTexts,
    })),
    targetLanguage,
    turn,
    cache,
    signal,
    retryFailed,
    onProgress,
  });

  // ── 3. 段级结果 → 组级 entries（按文档顺序，包重建）────────
  //
  // entry 的语义是**组**：渲染层需要「组内译文段 + code 原文行」混排后的完整行
  // （逐行带 `// ` / ` * ` / docstring 引号与缩进）。段级 entry 会让 code 行凭空消失。
  const entries: CommentTranslationEntry[] = [];
  let translatedSegments = 0;

  for (const plan of plans) {
    const texts = new Map<Segment, string>();
    let reason: string | undefined;

    for (const [segment, address] of plan.addresses) {
      const text = engine.translations[address];
      if (text !== undefined) {
        texts.set(segment, text);
        translatedSegments++;
        continue;
      }
      // 组级 entry 只带**第一条**失败段的原因（多段失败时取文档顺序首个）
      if (reason === undefined) reason = engine.failureReasons[address];
    }

    // 组内一段都没翻成、也无失败原因（如被 abort 跳过）→ 不画
    if (texts.size === 0 && reason === undefined) continue;

    const lines = rebuildBlock(rebuildInputOf(plan, texts));
    const { from, to } = positionOfLines(
      plan.group.startLine,
      plan.group.endLine,
      lineStarts,
      source,
    );
    entries.push(
      reason
        ? { from, to, text: lines.join('\n'), reason, groupKey: plan.group.startLine }
        : { from, to, text: lines.join('\n'), groupKey: plan.group.startLine },
    );
  }
  entries.sort((a, b) => a.from - b.from);

  return {
    entries: mergeCommentEntries(previousEntries ?? [], entries, onlyGroups),
    skipped,
    requestedSegments: pending.length,
    translatedSegments,
    cacheHits: engine.cacheHits,
    failedAddresses: engine.failedAddresses,
    aborted: engine.aborted,
  };
}

/** 默认显示模式（U1 定案）。 */
export const DEFAULT_COMMENT_MODE: CommentDisplayMode = 'below';
