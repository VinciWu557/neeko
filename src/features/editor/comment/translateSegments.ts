/**
 * 注释译文引擎（编排层）—— 去重 → 查缓存 → 补漏 → 校验 → 回写 → 进度。
 *
 * ## 为什么引擎不直接调 `invoke`
 *
 * 传输由注入的 {@link TranslateTurn} 承担。好处有三：
 * 1. 引擎层零 IPC 依赖（符合前端导入防火墙）；
 * 2. 测试注入脚本桩，不发网络、不启子进程，跑得快且确定；
 * 3. 换传输（本地小模型 / 批量 API）只换实现，引擎零改动。
 *
 * ## 流程为什么是这个顺序
 *
 * | 步骤 | 为什么必须在这一步 |
 * | --- | --- |
 * | 去重 | 在**查缓存之前**：同文段只需查一次缓存，且跨文件去重能省 20-40% 请求 |
 * | 查缓存 | 在**凑批之前**：命中越多，批数越少 |
 * | 校验 | 在**回写缓存之前**：坏译文绝不能进缓存（否则永久污染） |
 * | 回写 | 在**校验之后**：只有通过校验的才值得存 |
 *
 * ## abort 语义
 *
 * 批间检测中止；**已完成成果保留**（延续「停止不清成果」共识），未处理的段保持未译。
 *
 * ## `onlyAddresses`：作用域而不是重试策略
 *
 * 单组重试（PRD R6.6）需要「只处理这一组的段」。这里用**入口处收窄作用域**实现，
 * 而不是在去重 / 缓存 / 凑批 / 校验四处各加一次判断 —— 后者任何一处漏写都表现为
 * 「别的组也被重译」（静默，只是变慢）或「被过滤的段又出现在结果里」（错误）。
 */
import { planTranslationBatches } from '../translation/batches';
import { parseTranslationResponse } from '../translation/prompt';

import { cacheKey, COMMENT_TRANSLATION_PROFILE, type TranslationCache } from './translationCache';
import { verifyComment, type VerifyRule } from './verifyComment';

/** 与 `AbortSignal` 兼容的最小接口（便于测试注入普通对象）。 */
export interface AbortSignalLike {
  aborted: boolean;
}

/** 一次模型往返（生产实现包 agent 会话 + 事件流）。 */
export interface TranslateTurn {
  run(prompt: string, signal?: AbortSignalLike): Promise<string>;
}

/** 待翻译的段（引擎视角）。 */
export interface EngineSegment {
  /** 内容地址（`commentAddress` 产出）。 */
  address: string;
  /** 送翻译的文本。 */
  text: string;
  /**
   * 禁止出现在译文里的文本（同组内 code / fence 段的原文）。
   *
   * 这些内容根本没进请求，出现即模型幻觉复述（AC9）。
   */
  forbiddenTexts?: readonly string[];
}

/** 进度快照。 */
export interface Progress {
  total: number;
  done: number;
  failed: number;
  /** 缓存命中数 —— 用来证明「增量真的生效」。 */
  cached: number;
}

/** 引擎结果。 */
export interface TranslateSegmentsResult {
  /** address → 译文（跨文件共享，渲染层按各自段取用）。 */
  translations: Record<string, string>;
  /** 未通过的 address。 */
  failedAddresses: string[];
  /** address → 失败原因（进 UI）。 */
  failureReasons: Record<string, string>;
  /** 缓存命中数。 */
  cacheHits: number;
  aborted: boolean;
}

/** 引擎选项。 */
export interface TranslateSegmentsOptions {
  segments: readonly EngineSegment[];
  targetLanguage: string;
  turn: TranslateTurn;
  cache: TranslationCache;
  /** prompt / 校验策略版本（进缓存键）。默认 {@link COMMENT_TRANSLATION_PROFILE}。 */
  profileVersion?: string;
  /** 单批 token 预算。 */
  tokenBudget?: number;
  /** 有界并发批数（每批 = 一次 agent 子进程）。 */
  concurrency?: number;
  signal?: AbortSignalLike;
  /**
   * 校验失败后是否用 strict prompt 重试一次。
   *
   * **与 {@link onlyAddresses} 是两个独立概念**：本选项回答「失败后要不要再试一轮」，
   * `onlyAddresses` 回答「这一轮处理哪些段」。单组重试会同时用到两者（只处理该组的段，
   * 且该组内失败仍走 strict 重试）。
   */
  retryFailed?: boolean;
  /**
   * 只处理这些 address 的段（R6.6 单组重试的引擎入口）。
   *
   * 提供时，**其余段完全不进入本函数**：不进 prompt、不出现在 `translations`、
   * 不计入 `failedAddresses` 与 `total`。与「去重」无冲突：去重只在这批命中段内进行。
   */
  onlyAddresses?: readonly string[];
  /** 自定义规则集（默认 `DEFAULT_COMMENT_RULES`）。 */
  rules?: readonly VerifyRule[];
  onProgress?: (progress: Progress) => void;
}

/**
 * 去重用的归一化口径。
 *
 * 与 `commentAddress.normalizeSegmentText` **同口径**（折叠空白），但刻意独立实现：
 * 引擎不 import 纯函数层之外的模块，且去重是「同文」判定、地址是「身份」判定 ——
 * 两者未来可能分叉（例如去重要求忽略大小写以合并 `Note:` / `note:`）。
 * 若分叉，只需改这一处。
 */
function normalizeForDedup(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const DEFAULT_TOKEN_BUDGET = 3000;
const DEFAULT_CONCURRENCY = 2;

/**
 * 组装 prompt。
 *
 * 输出契约：**JSON 字符串数组**，第 i 项对应第 i 段 —— 与 `parseTranslationResponse`
 * 的期望一致（索引对齐是唯一低成本的保序通道）。解析直接复用后者，不写副本。
 */
function buildPrompt(
  batch: readonly EngineSegment[],
  targetLanguage: string,
  strict: boolean,
): string {
  const segments = batch.map((segment, index) => `[${index}] ${segment.text}`).join('\n\n');
  const rules = [
    `You are translating source-code comments into ${targetLanguage}.`,
    '',
    'Rules:',
    '- Preserve inline markdown/code spans (e.g. `code`) exactly as-is.',
    '- Preserve placeholders such as {0}, {name}, %s, %d, ${x} exactly as-is.',
    '- Preserve doc tags and their names (@param name, :param name:) — translate only the description.',
    '- Preserve URLs exactly as-is.',
    '- Do not translate identifiers, file paths or error messages.',
    '- Return ONLY a JSON array of strings: item i is the translation of segment [i].',
    '- No commentary, no code fences.',
  ];
  if (strict) {
    rules.push(
      '- IMPORTANT: a previous attempt failed validation. Keep every placeholder, doc tag name and code span verbatim.',
    );
  }
  return [...rules, '', 'Segments:', '', segments].join('\n');
}

/**
 * 解析模型输出为按序译文数组。
 *
 * **直接复用文档翻译的 `parseTranslationResponse`，不写第二份**（R8.2）。
 * 两边的输出契约完全相同：「JSON 字符串数组，第 i 项对应第 i 段」，容错口径（剥围栏、
 * 取首个 `[` 到末个 `]`、非字符串/空串 → `null`）也必须相同 —— 一旦分家，同一模型输出
 * 会在两处得到不同结果，而这种漂移**无任何报错**。
 *
 * 唯一差异在**解析外的后续处理**（引擎把 `null` 当失败、走重试），不在本函数里。
 */
export const parseTranslationArray = parseTranslationResponse;

/** 有界并发执行器（顺序保持，单个失败不影响其它）。 */
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * 主流程。
 *
 * 契约：**永远返回结果**（除编程错误外不抛穿）—— 单批失败只标记该批，
 * 其余批继续；调用方拿到的是「尽可能多」的译文 + 明确的失败清单。
 */
export async function translateSegments(
  options: TranslateSegmentsOptions,
): Promise<TranslateSegmentsResult> {
  const {
    segments,
    targetLanguage,
    turn,
    cache,
    profileVersion = COMMENT_TRANSLATION_PROFILE,
    tokenBudget = DEFAULT_TOKEN_BUDGET,
    concurrency = DEFAULT_CONCURRENCY,
    signal = { aborted: false },
    retryFailed = true,
    onlyAddresses,
    rules,
    onProgress,
  } = options;

  // 作用域收窄放在**最前面**：后续去重 / 缓存 / 凑批 / 校验全部只看这批段，
  // 于是「未命中的段」天然不进 prompt、不进结果，也不需要任何分支再判断一次。
  const scope = onlyAddresses === undefined ? null : new Set(onlyAddresses);
  const scopedSegments =
    scope === null ? segments : segments.filter((segment) => scope.has(segment.address));

  const translations: Record<string, string> = {};
  const failureReasons: Record<string, string> = {};
  const failedSet = new Set<string>();

  // ── 1. 去重 ──────────────────────────────────────────
  //
  // **按归一化文本去重，而不是按 address**：`commentAddress` 是内容哈希，理论上同文必同
  // address；但不同文件里同一句话可能只差空白（归一化后相同、address 相同）或调用方传入
  // 自造 address。按文本去重能兜住这两种情况，也让「跨文件同文只送一次」（AC13）与
  // address 的产出方式解耦 —— 去重是引擎的职责，不该依赖调用方算对地址。
  //
  // 代表段选「首次出现」那条：它的 `forbiddenTexts` 用于校验，同文本的禁用集合一致。
  const uniqueByText = new Map<string, EngineSegment>();
  for (const segment of scopedSegments) {
    if (!segment.text.trim()) continue;
    const key = normalizeForDedup(segment.text);
    if (!uniqueByText.has(key)) uniqueByText.set(key, segment);
  }
  const pending0 = [...uniqueByText.values()];
  const total = pending0.length;

  // 结果按 **address** 展开：同文本的多条 address 都要拿到译文
  const aliases = new Map<string, string[]>();
  for (const segment of scopedSegments) {
    if (!segment.text.trim()) continue;
    const canonical = normalizeForDedup(segment.text);
    const list = aliases.get(canonical) ?? [];
    if (!list.includes(segment.address)) list.push(segment.address);
    aliases.set(canonical, list);
  }

  const keys = new Map<string, string>();
  for (const segment of pending0) {
    keys.set(segment.address, cacheKey(profileVersion, targetLanguage, segment.address));
  }

  // ── 2. 查缓存 ──────────────────────────────────────────
  const hits = await cache.getMany([...keys.values()]);
  const pending: EngineSegment[] = [];
  for (const segment of pending0) {
    const key = keys.get(segment.address);
    const hit = key ? hits.get(key) : undefined;
    // 碰撞 / 过期兜底：source 必须逐字节一致
    if (hit && hit.source === segment.text) {
      const canonical = normalizeForDedup(segment.text);
      for (const address of aliases.get(canonical) ?? [segment.address]) {
        translations[address] = hit.text;
      }
    } else {
      pending.push(segment);
    }
  }
  const cacheHits = Object.keys(translations).length;
  let done = cacheHits;

  onProgress?.({ total, done, failed: 0, cached: cacheHits });

  const emitProgress = () => {
    onProgress?.({ total, done, failed: failedSet.size, cached: cacheHits });
  };

  /** 校验 + 回填 + 回写缓存。返回该批未通过的段（供重试）。 */
  const acceptBatch = async (
    batch: readonly EngineSegment[],
    parsed: ReadonlyArray<string | null>,
  ): Promise<EngineSegment[]> => {
    const accepted: Array<readonly [string, { source: string; text: string; at: number }]> = [];
    const rejected: EngineSegment[] = [];

    batch.forEach((segment, index) => {
      const candidate = parsed[index];
      if (candidate === null || candidate === undefined) {
        rejected.push(segment);
        failureReasons[segment.address] = 'missing segment in response';
        return;
      }
      const verdict = verifyComment({
        source: segment.text,
        translation: candidate,
        forbiddenTexts: segment.forbiddenTexts,
        rules,
      });
      if (!verdict.ok) {
        rejected.push(segment);
        failureReasons[segment.address] = verdict.reason ?? 'validation failed';
        return;
      }
      // 展开到所有同文 address（跨文件同文都要拿到译文）
      const canonical = normalizeForDedup(segment.text);
      for (const address of aliases.get(canonical) ?? [segment.address]) {
        translations[address] = candidate;
      }
      const key = keys.get(segment.address);
      if (key) accepted.push([key, { source: segment.text, text: candidate, at: Date.now() }]);
      delete failureReasons[segment.address];
      failedSet.delete(segment.address);
      done++;
    });

    if (accepted.length > 0) await cache.setMany(accepted);
    for (const segment of rejected) failedSet.add(segment.address);
    return rejected;
  };

  /** 跑一批：组装 prompt → turn → 解析 → 校验回填。 */
  const runBatch = async (
    batch: readonly EngineSegment[],
    strict: boolean,
  ): Promise<EngineSegment[]> => {
    const raw = await turn.run(buildPrompt(batch, targetLanguage, strict), signal);
    const parsed = parseTranslationArray(raw, batch.length);
    return acceptBatch(batch, parsed);
  };

  // ── 3. 补漏（凑批 + 有界并发）────────────────────────────
  let aborted = signal.aborted;
  const batches = planTranslationBatches(
    pending.map((segment) => ({
      id: segment.address,
      kind: 'paragraph' as const,
      text: segment.text,
    })),
    tokenBudget,
  );

  const byAddress = new Map(pending.map((segment) => [segment.address, segment]));

  await runWithConcurrency(batches, concurrency, async (batch) => {
    if (signal.aborted) {
      aborted = true;
      return;
    }
    const engineBatch = batch
      .map((item) => byAddress.get(item.id))
      .filter((segment): segment is EngineSegment => segment !== undefined);
    if (engineBatch.length === 0) return;

    let rejected: EngineSegment[];
    try {
      rejected = await runBatch(engineBatch, false);
    } catch (error) {
      // 单批失败隔离：不牵连其它批，也不抛出（引擎永远返回结果）
      const reason = error instanceof Error ? error.message : String(error);
      for (const segment of engineBatch) {
        failureReasons[segment.address] = reason;
        failedSet.add(segment.address);
      }
      emitProgress();
      return;
    }
    emitProgress();

    // ── 4. 失败重试一次（strict prompt，带原因提示提高收敛率）──
    if (retryFailed && rejected.length > 0 && !signal.aborted) {
      try {
        await runBatch(rejected, true);
      } catch {
        // 重试仍失败 → 保持 failed，交由 UI 单段重试
      }
      emitProgress();
    }
  });

  return {
    translations,
    failedAddresses: [...failedSet],
    failureReasons,
    cacheHits,
    aborted: aborted || signal.aborted,
  };
}
