// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  parseTranslationArray,
  translateSegments,
  type EngineSegment,
  type TranslateTurn,
} from '../translateSegments';
import { MemoryCache, cacheKey, COMMENT_TRANSLATION_PROFILE } from '../translationCache';

/**
 * AC12 / AC13 + R4：引擎编排。
 *
 * 流程固定：**去重 → 查缓存 → 补漏 → 校验 → 回写缓存 → 进度**。
 * 全部依赖注入（turn / cache / rules），因此测试不发网络、不启子进程。
 */

const KEY = (address: string) => cacheKey(COMMENT_TRANSLATION_PROFILE, 'zh-CN', address);

function seg(address: string, text: string, extra: Partial<EngineSegment> = {}): EngineSegment {
  return { address, text, forbiddenTexts: [], ...extra };
}

/** 脚本化 turn：按 prompt 里出现的 segment 文本返回预设译文。 */
function scriptedTurn(script: Record<string, string>): TranslateTurn & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async run(prompt: string) {
      calls.push(prompt);
      // 从 prompt 中解析 `[n] text` 形式的分段并逐个返回
      const lines = prompt.split('\n').filter((line) => /^\[\d+\] /.test(line));
      return JSON.stringify(
        lines.map((line) => {
          const text = line.replace(/^\[\d+\] /, '');
          return script[text] ?? `译:${text}`;
        }),
      );
    },
  };
}

describe('translateSegments / AC13 去重与缓存', () => {
  it('should call the turn once for duplicate segment texts', async () => {
    const cache = new MemoryCache();
    const turn = scriptedTurn({ 'returns the id': '返回标识' });

    const result = await translateSegments({
      segments: [seg('a1', 'returns the id'), seg('a2', 'returns the id')],
      targetLanguage: 'zh-CN',
      turn,
      cache,
    });

    // 同文只送一次模型
    expect(turn.calls).toHaveLength(1);
    // 两个地址都拿到译文（回填按 address 展开）
    expect(result.translations['a1']).toBe('返回标识');
    expect(result.translations['a2']).toBe('返回标识');
  });

  it('should hit the cache on the second run (AC12 增量)', async () => {
    const cache = new MemoryCache();
    const first = await translateSegments({
      segments: [seg('a1', 'returns the id')],
      targetLanguage: 'zh-CN',
      turn: scriptedTurn({ 'returns the id': '返回标识' }),
      cache,
    });
    expect(first.cacheHits).toBe(0);

    const turn2 = scriptedTurn({});
    const second = await translateSegments({
      segments: [seg('a1', 'returns the id')],
      targetLanguage: 'zh-CN',
      turn: turn2,
      cache,
    });
    expect(second.cacheHits).toBe(1);
    expect(turn2.calls).toHaveLength(0);
    expect(second.translations['a1']).toBe('返回标识');
  });

  it('should treat a changed segment as a miss and keep the others cached', async () => {
    const cache = new MemoryCache();
    await translateSegments({
      segments: [seg('a1', 'first line'), seg('a2', 'second line')],
      targetLanguage: 'zh-CN',
      turn: scriptedTurn({}),
      cache,
    });

    const turn = scriptedTurn({});
    const result = await translateSegments({
      // a2 的文本变了 → 只有它 miss
      segments: [seg('a1', 'first line'), seg('a2', 'second line CHANGED')],
      targetLanguage: 'zh-CN',
      turn,
      cache,
    });

    expect(result.cacheHits).toBe(1);
    expect(turn.calls).toHaveLength(1);
    expect(turn.calls[0]).toContain('second line CHANGED');
    expect(turn.calls[0]).not.toContain('first line');
  });

  it('should miss when the profile version changes (AC6)', async () => {
    const cache = new MemoryCache();
    await translateSegments({
      segments: [seg('a1', 'text')],
      targetLanguage: 'zh-CN',
      turn: scriptedTurn({}),
      cache,
    });

    const turn = scriptedTurn({});
    const result = await translateSegments({
      segments: [seg('a1', 'text')],
      targetLanguage: 'zh-CN',
      profileVersion: 'comment-p2',
      turn,
      cache,
    });
    expect(result.cacheHits).toBe(0);
    expect(turn.calls).toHaveLength(1);
  });

  it('should miss when the target language changes', async () => {
    const cache = new MemoryCache();
    await translateSegments({
      segments: [seg('a1', 'text')],
      targetLanguage: 'zh-CN',
      turn: scriptedTurn({}),
      cache,
    });
    const turn = scriptedTurn({});
    await translateSegments({
      segments: [seg('a1', 'text')],
      targetLanguage: 'ja-JP',
      turn,
      cache,
    });
    expect(turn.calls).toHaveLength(1);
  });
});

describe('translateSegments / 校验与失败', () => {
  it('should mark a segment failed when validation rejects it', async () => {
    const cache = new MemoryCache();
    const turn = scriptedTurn({ 'format {0}': '格式化（丢了占位符）' });
    const result = await translateSegments({
      segments: [seg('a1', 'format {0}')],
      targetLanguage: 'zh-CN',
      turn,
      cache,
      retryFailed: false,
    });

    expect(result.translations['a1']).toBeUndefined();
    expect(result.failedAddresses).toContain('a1');
    expect(result.failureReasons['a1']).toContain('placeholder');
  });

  it('should not cache a rejected translation', async () => {
    const cache = new MemoryCache();
    await translateSegments({
      segments: [seg('a1', 'format {0}')],
      targetLanguage: 'zh-CN',
      turn: scriptedTurn({ 'format {0}': '丢了占位符' }),
      cache,
      retryFailed: false,
    });
    expect(await cache.get(KEY('a1'))).toBeNull();
  });

  it('should retry a failed batch once and accept the retry when valid', async () => {
    const cache = new MemoryCache();
    let attempt = 0;
    const turn: TranslateTurn = {
      async run(prompt: string) {
        attempt++;
        const lines = prompt.split('\n').filter((line) => /^\[\d+\] /.test(line));
        // 第一次故意丢占位符，第二次正确
        return JSON.stringify(
          lines.map((line) => {
            const text = line.replace(/^\[\d+\] /, '');
            if (attempt === 1) return '丢了占位符';
            return `译:${text}`;
          }),
        );
      },
    };

    const result = await translateSegments({
      segments: [seg('a1', 'format {0}')],
      targetLanguage: 'zh-CN',
      turn,
      cache,
      retryFailed: true,
    });

    expect(attempt).toBe(2);
    expect(result.translations['a1']).toBe('译:format {0}');
    expect(result.failedAddresses).toEqual([]);
  });

  it('should keep a segment failed when the retry also fails', async () => {
    const cache = new MemoryCache();
    const turn: TranslateTurn = {
      async run(prompt: string) {
        const lines = prompt.split('\n').filter((line) => /^\[\d+\] /.test(line));
        return JSON.stringify(lines.map(() => '丢了占位符'));
      },
    };
    const result = await translateSegments({
      segments: [seg('a1', 'format {0}')],
      targetLanguage: 'zh-CN',
      turn,
      cache,
      retryFailed: true,
    });
    expect(result.failedAddresses).toContain('a1');
  });

  it('should isolate a throwing batch so other batches still complete (AC9)', async () => {
    const cache = new MemoryCache();
    let call = 0;
    const turn: TranslateTurn = {
      async run(prompt: string) {
        call++;
        if (call === 1) throw new Error('agent crashed');
        const lines = prompt.split('\n').filter((line) => /^\[\d+\] /.test(line));
        return JSON.stringify(lines.map((line) => `译:${line.replace(/^\[\d+\] /, '')}`));
      },
    };

    const result = await translateSegments({
      segments: [seg('a1', 'first'), seg('a2', 'second')],
      targetLanguage: 'zh-CN',
      turn,
      cache,
      tokenBudget: 1, // 逼成两批
      retryFailed: false,
    });

    expect(result.failedAddresses.length).toBeGreaterThan(0);
    expect(Object.keys(result.translations).length).toBeGreaterThan(0);
  });

  it('should reject a translation that echoes a forbidden code text (AC9)', async () => {
    const cache = new MemoryCache();
    const turn = scriptedTurn({ 'Replace the call:': '替换：const raw = await legacyFetch(x);' });
    const result = await translateSegments({
      segments: [
        seg('a1', 'Replace the call:', { forbiddenTexts: ['const raw = await legacyFetch(x);'] }),
      ],
      targetLanguage: 'zh-CN',
      turn,
      cache,
      retryFailed: false,
    });
    expect(result.failedAddresses).toContain('a1');
  });
});

describe('translateSegments / abort 语义', () => {
  it('should keep completed work and stop before the next batch', async () => {
    const cache = new MemoryCache();
    const signal = { aborted: false };
    let call = 0;
    const turn: TranslateTurn = {
      async run(prompt: string) {
        call++;
        const lines = prompt.split('\n').filter((line) => /^\[\d+\] /.test(line));
        // 第一批完成后立刻中止
        signal.aborted = true;
        return JSON.stringify(lines.map((line) => `译:${line.replace(/^\[\d+\] /, '')}`));
      },
    };

    const result = await translateSegments({
      segments: [seg('a1', 'first'), seg('a2', 'second')],
      targetLanguage: 'zh-CN',
      turn,
      cache,
      signal,
      tokenBudget: 1,
    });

    expect(result.aborted).toBe(true);
    expect(call).toBe(1);
    // 已完成成果保留（停止不清成果）
    expect(Object.keys(result.translations)).toHaveLength(1);
  });

  it('should not start any batch when already aborted', async () => {
    const turn = scriptedTurn({});
    const result = await translateSegments({
      segments: [seg('a1', 'x')],
      targetLanguage: 'zh-CN',
      turn,
      cache: new MemoryCache(),
      signal: { aborted: true },
    });
    expect(turn.calls).toHaveLength(0);
    expect(result.aborted).toBe(true);
  });
});

describe('translateSegments / 进度', () => {
  it('should report cached count on first and second run (AC12)', async () => {
    const cache = new MemoryCache();
    const seen: number[] = [];
    await translateSegments({
      segments: [seg('a1', 'x'), seg('a2', 'y')],
      targetLanguage: 'zh-CN',
      turn: scriptedTurn({}),
      cache,
      onProgress: (p) => seen.push(p.cached),
    });
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(0);

    const seen2: number[] = [];
    await translateSegments({
      segments: [seg('a1', 'x'), seg('a2', 'y')],
      targetLanguage: 'zh-CN',
      turn: scriptedTurn({}),
      cache,
      onProgress: (p) => seen2.push(p.cached),
    });
    expect(seen2[0]).toBe(2);
  });

  it('should report monotonic done counts', async () => {
    const cache = new MemoryCache();
    const dones: number[] = [];
    await translateSegments({
      segments: [seg('a1', 'x'), seg('a2', 'y'), seg('a3', 'z')],
      targetLanguage: 'zh-CN',
      turn: scriptedTurn({}),
      cache,
      tokenBudget: 1,
      onProgress: (p) => dones.push(p.done),
    });
    for (let i = 1; i < dones.length; i++) {
      expect(dones[i]).toBeGreaterThanOrEqual(dones[i - 1]);
    }
  });
});

describe('translateSegments / 边界', () => {
  it('should return an empty result for no segments', async () => {
    const turn = scriptedTurn({});
    const result = await translateSegments({
      segments: [],
      targetLanguage: 'zh-CN',
      turn,
      cache: new MemoryCache(),
    });
    expect(turn.calls).toHaveLength(0);
    expect(result.translations).toEqual({});
    expect(result.failedAddresses).toEqual([]);
  });

  it('should skip segments whose text is blank', async () => {
    const turn = scriptedTurn({});
    const result = await translateSegments({
      segments: [seg('a1', '   ')],
      targetLanguage: 'zh-CN',
      turn,
      cache: new MemoryCache(),
    });
    expect(turn.calls).toHaveLength(0);
    expect(result.translations).toEqual({});
  });

  it('should call onProgress at least once even when everything is cached', async () => {
    const cache = new MemoryCache();
    await translateSegments({
      segments: [seg('a1', 'x')],
      targetLanguage: 'zh-CN',
      turn: scriptedTurn({}),
      cache,
    });
    const onProgress = vi.fn();
    await translateSegments({
      segments: [seg('a1', 'x')],
      targetLanguage: 'zh-CN',
      turn: scriptedTurn({}),
      cache,
      onProgress,
    });
    expect(onProgress).toHaveBeenCalled();
  });
});

describe('translateSegments / 去重的真实语义（不同 address 同文本）', () => {
  it('should send only ONE segment even when two different addresses carry the same text', async () => {
    // 关键判别用例：AC13 的去重价值在「跨文件同文」。
    //
    // **必须用 tokenBudget=1 逼成逐段成批**：默认预算下两段会被合并进同一批，
    // 于是「1 次请求」既可能来自去重、也可能来自凑批 —— 断言就失去判别力
    // （实测：按 address 去重、完全不看文本时该用例仍然通过 = 假绿）。
    const cache = new MemoryCache();
    const turn = scriptedTurn({ 'returns the id': '返回标识' });

    const result = await translateSegments({
      segments: [
        seg('addr-from-file-A', 'returns the id'),
        seg('addr-from-file-B', 'returns the id'),
      ],
      targetLanguage: 'zh-CN',
      turn,
      cache,
      tokenBudget: 1,
    });

    // 逐段成批时，去重若失效会变成 2 次请求
    expect(turn.calls).toHaveLength(1);
    expect(result.translations['addr-from-file-A']).toBe('返回标识');
    expect(result.translations['addr-from-file-B']).toBe('返回标识');
  });
});

describe('translateSegments / 解析与漏段', () => {
  it('should treat an unparsable response as a failed batch', async () => {
    const cache = new MemoryCache();
    const turn: TranslateTurn = {
      async run() {
        return 'not json at all';
      },
    };
    const result = await translateSegments({
      segments: [seg('a1', 'some text here')],
      targetLanguage: 'zh-CN',
      turn,
      cache,
      retryFailed: false,
    });
    expect(result.failedAddresses).toContain('a1');
    expect(result.failureReasons['a1']).toContain('missing segment');
  });

  it('should mark a segment failed when the model returns fewer items', async () => {
    const cache = new MemoryCache();
    const turn: TranslateTurn = {
      async run() {
        // 只返回 1 项，但请求了 2 段
        return JSON.stringify(['只有一段译文']);
      },
    };
    const result = await translateSegments({
      segments: [seg('a1', 'first text'), seg('a2', 'second text')],
      targetLanguage: 'zh-CN',
      turn,
      cache,
      retryFailed: false,
    });
    expect(result.failedAddresses.length).toBeGreaterThan(0);
  });

  it('should parse a response wrapped in prose noise', async () => {
    const cache = new MemoryCache();
    const turn: TranslateTurn = {
      async run() {
        return 'Here you go:\n["译好的文本"]\nHope this helps!';
      },
    };
    const result = await translateSegments({
      segments: [seg('a1', 'some text')],
      targetLanguage: 'zh-CN',
      turn,
      cache,
      retryFailed: false,
    });
    expect(result.translations['a1']).toBe('译好的文本');
  });

  it('should parse a response wrapped in a code fence', async () => {
    const cache = new MemoryCache();
    const turn: TranslateTurn = {
      async run() {
        return '```json\n["译文内容"]\n```';
      },
    };
    const result = await translateSegments({
      segments: [seg('a1', 'some text')],
      targetLanguage: 'zh-CN',
      turn,
      cache,
      retryFailed: false,
    });
    expect(result.translations['a1']).toBe('译文内容');
  });

  it('should treat a non-array JSON response as a failed batch', async () => {
    const cache = new MemoryCache();
    const turn: TranslateTurn = {
      async run() {
        return '{"a": 1}';
      },
    };
    const result = await translateSegments({
      segments: [seg('a1', 'some text')],
      targetLanguage: 'zh-CN',
      turn,
      cache,
      retryFailed: false,
    });
    expect(result.failedAddresses).toContain('a1');
  });

  it('should treat an empty response as a failed batch', async () => {
    const cache = new MemoryCache();
    const turn: TranslateTurn = {
      async run() {
        return '';
      },
    };
    const result = await translateSegments({
      segments: [seg('a1', 'some text')],
      targetLanguage: 'zh-CN',
      turn,
      cache,
      retryFailed: false,
    });
    expect(result.failedAddresses).toContain('a1');
  });

  it('should ignore non-string items in the array', async () => {
    const cache = new MemoryCache();
    const turn: TranslateTurn = {
      async run() {
        return '[null, 42, "有效译文"]';
      },
    };
    const result = await translateSegments({
      segments: [seg('a1', 'some text')],
      targetLanguage: 'zh-CN',
      turn,
      cache,
      retryFailed: false,
    });
    // 第一项是 null → 失败
    expect(result.failedAddresses).toContain('a1');
  });
});

describe('translateSegments / 括号存在但 JSON 非法', () => {
  it('should fail the batch when brackets exist but the JSON is malformed', async () => {
    // 与「完全不是 JSON」不同：这里有 `[` `]`，会进入 JSON.parse 并抛错（catch 分支）
    const cache = new MemoryCache();
    // 有开闭括号，但内部不是合法 JSON → 进入 JSON.parse 的 catch 分支
    const turn: TranslateTurn = {
      async run() {
        return '[unquoted, broken]';
      },
    };
    const result = await translateSegments({
      segments: [seg('a1', 'some text here')],
      targetLanguage: 'zh-CN',
      turn,
      cache,
      retryFailed: false,
    });
    expect(result.failedAddresses).toContain('a1');
  });
});

describe('parseTranslationArray / 与文档翻译共用同一实现（R8.2）', () => {
  /**
   * 这份解析器曾是 `translation/prompt.ts` 的逐字副本。副本与原件行为一致时，
   * 任何行为断言都不会红 —— 只有原件改了副本没跟上才出事（而那时早已忘了有副本）。
   * 所以判据是**身份**：导出的必须就是那一个函数。
   */
  it('should be the very same function object as parseTranslationResponse', async () => {
    const { parseTranslationArray } = await import('../translateSegments');
    const { parseTranslationResponse } = await import('../../translation/prompt');
    expect(parseTranslationArray).toBe(parseTranslationResponse);
  });

  it('should keep the tolerant parsing contract (fences, noise, non-strings)', () => {
    expect(parseTranslationArray('```json\n["你好"]\n```', 1)).toEqual(['你好']);
    expect(parseTranslationArray('noise ["a", 42, null] tail', 3)).toEqual(['a', null, null]);
    expect(parseTranslationArray('not json', 2)).toEqual([null, null]);
  });
});

describe('translateSegments / onlyAddresses（R6.6 单组重试的作用域）', () => {
  /**
   * 单组重试要「只处理这一组的段」。判据不能只看 `translations` 的键数 ——
   * 那样「未命中的段也被请求但译文没被采纳」也会绿。必须看 **prompt 里出现了什么**。
   *
   * 夹具用 `tokenBudget: 1` 逼成逐段成批：默认预算下三段会被凑成一批，
   * 「只请求命中段」与「凑批」两种原因都能解释 `turns` 计数，用例失去判别力
   * （`frontend-testing.md` §11 的假绿陷阱）。
   */
  it('should only request the segments whose address is in scope', async () => {
    const turn = scriptedTurn({});
    await translateSegments({
      segments: [seg('a1', 'first prose'), seg('a2', 'second prose'), seg('a3', 'third prose')],
      targetLanguage: 'zh-CN',
      turn,
      cache: new MemoryCache(),
      tokenBudget: 1,
      retryFailed: false,
      onlyAddresses: ['a2'],
    });

    // 只发一次请求（其余两段根本不进规格）
    expect(turn.calls).toHaveLength(1);
    const prompt = turn.calls.join('\n');
    expect(prompt).toContain('second prose');
    expect(prompt).not.toContain('first prose');
    expect(prompt).not.toContain('third prose');
  });

  it('should not surface out-of-scope segments in translations or failures', async () => {
    const turn: TranslateTurn = {
      async run() {
        return JSON.stringify(['丢了占位符']);
      },
    };
    const result = await translateSegments({
      segments: [seg('a1', 'format {0}'), seg('a2', 'untouched prose')],
      targetLanguage: 'zh-CN',
      turn,
      cache: new MemoryCache(),
      retryFailed: false,
      onlyAddresses: ['a1'],
    });

    // 命中段失败 → 有 reason
    expect(result.failedAddresses).toEqual(['a1']);
    // 未命中段完全不出现在结果里（连「未译」都不算）
    expect(result.translations['a2']).toBeUndefined();
    expect(result.failedAddresses).not.toContain('a2');
    expect(Object.keys(result.failureReasons)).toEqual(['a1']);
  });

  it('should report progress totals scoped to the requested addresses', async () => {
    const seen: Array<{ total: number }> = [];
    await translateSegments({
      segments: [seg('a1', 'first prose'), seg('a2', 'second prose')],
      targetLanguage: 'zh-CN',
      turn: scriptedTurn({}),
      cache: new MemoryCache(),
      retryFailed: false,
      onlyAddresses: ['a2'],
      onProgress: (progress) => seen.push({ total: progress.total }),
    });

    // 分母是「本次作用域内的段数」，不是整文件的段数 ——
    // 否则单组重试会把工具条进度显示成 1/2。
    expect(seen.every((item) => item.total === 1)).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('should keep the plain "process everything" behaviour when the option is absent', async () => {
    const turn = scriptedTurn({});
    await translateSegments({
      segments: [seg('a1', 'first prose'), seg('a2', 'second prose')],
      targetLanguage: 'zh-CN',
      turn,
      cache: new MemoryCache(),
      retryFailed: false,
    });
    const prompt = turn.calls.join('\n');
    expect(prompt).toContain('first prose');
    expect(prompt).toContain('second prose');
  });
});
