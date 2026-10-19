// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { TranslateTurn } from '../translateSegments';
import { MemoryCache } from '../translationCache';
import { runCommentTranslation } from '../useCommentTranslation';

/**
 * 控制器端到端：源码 → 提取 → 分组 → 分类 → 分段 → 引擎 → entries。
 *
 * 最关键的一条断言（U2 铁律）：**code / fence 段的原文绝不出现在 prompt 里**。
 * 这条不靠"看起来对"，靠捕获每次 turn 的 prompt 文本逐一检查。
 */

/**
 * 取 parser（控制器契约要求调用方传语法树，故测试直接给树）。
 *
 * 生产路径传 （复用增量树）；这里用  得到等价结构。
 */
async function ensureParsers() {
  const { javascriptLanguage } = await import('@codemirror/lang-javascript');
  const { pythonLanguage } = await import('@codemirror/lang-python');
  return { javascriptLanguage, pythonLanguage };
}

/** 捕获 prompt 的脚本化 turn。 */
function capturingTurn(script: Record<string, string> = {}): TranslateTurn & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async run(prompt: string) {
      prompts.push(prompt);
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

/**
 * 多行段感知的脚本化 turn。
 *
 * `capturingTurn` 只按单行匹配 —— 多行段（块注释 / docstring）在 prompt 里是一条占多行的
 * `[0] ...` 块，逐行切会把它拆成多条，译文条数与请求条数就对不上了。
 */
function segmentedTurn(script: Record<string, string> = {}): TranslateTurn {
  return {
    async run(prompt: string) {
      const body = prompt.slice(prompt.indexOf('Segments:') + 'Segments:'.length);
      const segments = body
        .split(/\n\n(?=\[\d+\] )/)
        .filter((chunk) => /^\s*\[\d+\] /.test(chunk))
        .map((chunk) => chunk.replace(/^\s*\[\d+\] /, ''));
      return JSON.stringify(segments.map((text) => script[text] ?? `译:${text}`));
    },
  };
}

const base = {
  targetLanguage: 'zh-CN',
  cache: new MemoryCache(),
};

describe('useCommentTranslation / U2 铁律：代码不进 prompt', () => {
  it('should never put code segments into the prompt', async () => {
    const { javascriptLanguage } = await ensureParsers();
    const source = [
      '// Replace the legacy call:',
      '//   const raw = await legacyFetch(segments);',
      '//   if (raw.error) { throw raw.error; }',
      '// with the single-turn path.',
      'const a = 1;',
    ].join('\n');

    const turn = capturingTurn();
    await runCommentTranslation({
      ...base,
      filePath: 'a.ts',
      source,
      tree: javascriptLanguage.parser.parse(source) as never,
      turn,
      cache: new MemoryCache(),
    });

    const allPrompts = turn.prompts.join('\n');
    // 代码原文绝不出现在任何 prompt 里
    expect(allPrompts).not.toContain('legacyFetch');
    expect(allPrompts).not.toContain('throw raw.error');
    // 散文必须在 prompt 里
    expect(allPrompts).toContain('Replace the legacy call:');
    expect(allPrompts).toContain('with the single-turn path.');
  });

  it('should never put fence content into the prompt', async () => {
    const { javascriptLanguage } = await ensureParsers();
    const source = [
      '// Usage:',
      '// ```ts',
      '// cache.set(key, value);',
      '// ```',
      'const a = 1;',
    ].join('\n');

    const turn = capturingTurn();
    await runCommentTranslation({
      ...base,
      filePath: 'a.ts',
      source,
      tree: javascriptLanguage.parser.parse(source) as never,
      turn,
      cache: new MemoryCache(),
    });

    expect(turn.prompts.join('\n')).not.toContain('cache.set');
  });

  it('should count code segments in the skip summary', async () => {
    const { javascriptLanguage } = await ensureParsers();
    const source = '// prose line\n//   code();\nconst a = 1;\n';
    const result = await runCommentTranslation({
      ...base,
      filePath: 'a.ts',
      source,
      tree: javascriptLanguage.parser.parse(source) as never,
      turn: capturingTurn(),
      cache: new MemoryCache(),
    });
    expect(result.skipped.codeSegments).toBeGreaterThanOrEqual(1);
  });
});

describe('useCommentTranslation / 门禁跳过统计', () => {
  it('should skip a directive group and report it', async () => {
    const { javascriptLanguage } = await ensureParsers();
    const source = '// eslint-disable-next-line no-console\nconst a = 1;\n';
    const turn = capturingTurn();
    const result = await runCommentTranslation({
      ...base,
      filePath: 'a.ts',
      source,
      tree: javascriptLanguage.parser.parse(source) as never,
      turn,
      cache: new MemoryCache(),
    });

    expect(turn.prompts).toHaveLength(0);
    expect(result.skipped.byKind.directive).toBe(1);
    expect(result.requestedSegments).toBe(0);
  });

  it('should skip a license header and report it', async () => {
    const { javascriptLanguage } = await ensureParsers();
    const source = '// Copyright 2026 Neeko\nconst a = 1;\n';
    const turn = capturingTurn();
    const result = await runCommentTranslation({
      ...base,
      filePath: 'a.ts',
      source,
      tree: javascriptLanguage.parser.parse(source) as never,
      turn,
      cache: new MemoryCache(),
    });
    expect(result.skipped.byKind.license).toBe(1);
    expect(turn.prompts).toHaveLength(0);
  });

  it('should skip a shebang and report it', async () => {
    // 实测：shebang 的节点形态随家族不同 ——
    // - Python：`#!` 是 `Comment` 节点 → 必须靠 `isShebang` 门禁跳过
    // - Shell（StreamLanguage）：`#!` 是 `meta` 节点，**不是注释** → 天然不进候选集
    // - TS：`#!` 走错误恢复，也不产生 Comment 节点
    // 所以本用例用 Python 才能测到门禁本身（用 shell 测的是「无注释」）。
    const { pythonLanguage } = await ensureParsers();
    const source = '#!/usr/bin/env python\nx = 1\n';

    const turn = capturingTurn();
    const result = await runCommentTranslation({
      ...base,
      filePath: 'a.py',
      source,
      tree: pythonLanguage.parser.parse(source) as never,
      turn,
      cache: new MemoryCache(),
    });
    expect(result.skipped.byKind.shebang).toBe(1);
    expect(turn.prompts).toHaveLength(0);
  });
});

describe('useCommentTranslation / entries 产出', () => {
  it('should produce entries in document order', async () => {
    const { javascriptLanguage } = await ensureParsers();
    const source = '// first\nconst a = 1;\n// second\nconst b = 2;\n';
    const result = await runCommentTranslation({
      ...base,
      filePath: 'a.ts',
      source,
      tree: javascriptLanguage.parser.parse(source) as never,
      turn: capturingTurn(),
      cache: new MemoryCache(),
    });

    // 两条独立组 → 两条组级 entry（与旧语义的条数一致，但 text 现在是**重建后的行**）
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]?.from).toBeLessThan(result.entries[1]?.from ?? 0);
  });

  it('should produce an entry with a reason for a failed segment', async () => {
    const { javascriptLanguage } = await ensureParsers();
    const source = '// format {0} value\nconst a = 1;\n';
    const turn: TranslateTurn = {
      async run() {
        return JSON.stringify(['丢了占位符']);
      },
    };
    const result = await runCommentTranslation({
      ...base,
      filePath: 'a.ts',
      source,
      tree: javascriptLanguage.parser.parse(source) as never,
      turn,
      cache: new MemoryCache(),
      retryFailed: false,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.reason).toContain('placeholder');
    expect(result.failedAddresses.length).toBeGreaterThan(0);
  });

  it('should return nothing for an unknown language instead of guessing', async () => {
    const turn = capturingTurn();
    const result = await runCommentTranslation({
      ...base,
      filePath: 'a.unknownext',
      source: '// whatever\n',
      tree: null,
      turn,
      cache: new MemoryCache(),
    });
    expect(result.entries).toEqual([]);
    expect(turn.prompts).toHaveLength(0);
  });

  it('should return nothing when the file has no comments', async () => {
    const { javascriptLanguage } = await ensureParsers();
    const source = 'const a = 1;\n';
    const turn = capturingTurn();
    const result = await runCommentTranslation({
      ...base,
      filePath: 'a.ts',
      source,
      tree: javascriptLanguage.parser.parse(source) as never,
      turn,
      cache: new MemoryCache(),
    });
    expect(result.entries).toEqual([]);
    expect(turn.prompts).toHaveLength(0);
  });

  it('should handle a null tree without throwing', async () => {
    const turn = capturingTurn();
    const result = await runCommentTranslation({
      ...base,
      filePath: 'a.ts',
      source: '// text\n',
      tree: null,
      turn,
      cache: new MemoryCache(),
    });
    expect(result.entries).toEqual([]);
  });
});

describe('useCommentTranslation / 增量（AC12）', () => {
  it('should hit the cache on the second run for the same file', async () => {
    const { javascriptLanguage } = await ensureParsers();
    const source = '// stable comment text\nconst a = 1;\n';
    const cache = new MemoryCache();

    await runCommentTranslation({
      ...base,
      filePath: 'a.ts',
      source,
      tree: javascriptLanguage.parser.parse(source) as never,
      turn: capturingTurn(),
      cache,
    });

    const turn2 = capturingTurn();
    const second = await runCommentTranslation({
      ...base,
      filePath: 'a.ts',
      source,
      tree: javascriptLanguage.parser.parse(source) as never,
      turn: turn2,
      cache,
    });

    expect(second.cacheHits).toBeGreaterThan(0);
    expect(turn2.prompts).toHaveLength(0);
    expect(second.entries).toHaveLength(1);
  });

  it('should only translate the changed comment on edit', async () => {
    const { javascriptLanguage } = await ensureParsers();
    const cache = new MemoryCache();
    const before = '// first comment\nconst a = 1;\n// second comment\nconst b = 2;\n';
    await runCommentTranslation({
      ...base,
      filePath: 'a.ts',
      source: before,
      tree: javascriptLanguage.parser.parse(before) as never,
      turn: capturingTurn(),
      cache,
    });

    const after = '// first comment\nconst a = 1;\n// second comment CHANGED\nconst b = 2;\n';
    const turn2 = capturingTurn();
    await runCommentTranslation({
      ...base,
      filePath: 'a.ts',
      source: after,
      tree: javascriptLanguage.parser.parse(after) as never,
      turn: turn2,
      cache,
    });

    const prompts = turn2.prompts.join('\n');
    expect(prompts).toContain('second comment CHANGED');
    expect(prompts).not.toContain('first comment');
  });
});

describe('useCommentTranslation / abort', () => {
  it('should keep completed work when aborted between batches', async () => {
    const { javascriptLanguage } = await ensureParsers();
    const source = '// one two three\nconst a = 1;\n// four five six\nconst b = 2;\n';
    const signal = { aborted: false };
    const turn: TranslateTurn = {
      async run(prompt: string) {
        const lines = prompt.split('\n').filter((line) => /^\[\d+\] /.test(line));
        signal.aborted = true;
        return JSON.stringify(lines.map((line) => `译:${line.replace(/^\[\d+\] /, '')}`));
      },
    };

    const result = await runCommentTranslation({
      ...base,
      filePath: 'a.ts',
      source,
      tree: javascriptLanguage.parser.parse(source) as never,
      turn,
      cache: new MemoryCache(),
      signal,
    });

    expect(result.aborted).toBe(true);
    // 已完成成果保留
    expect(result.entries.length).toBeGreaterThanOrEqual(1);
  });
});

describe('useCommentTranslation / python docstring（U3）', () => {
  it('should translate a docstring and produce an entry', async () => {
    const { pythonLanguage } = await ensureParsers();
    const source = 'def f():\n    """Run the thing."""\n    return 1\n';
    const turn = capturingTurn();
    const result = await runCommentTranslation({
      ...base,
      filePath: 'a.py',
      source,
      tree: pythonLanguage.parser.parse(source) as never,
      turn,
      cache: new MemoryCache(),
    });

    expect(result.entries).toHaveLength(1);
    expect(turn.prompts.join('\n')).toContain('Run the thing.');
  });
});

describe('useCommentTranslation / 索引只建一次（O(n²) 回归护栏）', () => {
  /**
   * 缺陷回顾：`classifyBlock` 曾在**每组**的分类里 `computeLineStarts(source)` 全量扫源，
   * 并对全树 DFS 找「下一兄弟声明」，二者都落在组循环里 → 实测 O(n²)：
   * 100 组 2.8ms → 400 组 22.1ms → 1600 组 215.6ms。
   *
   * 判据不看墙钟（会抖），而是**数索引构造次数**：一次翻译作业里，行索引与声明索引
   * 各只允许建 1 次 —— 与组数、段数无关。
   */
  it('should build the line index and the decl index exactly once for a many-group file', async () => {
    const { javascriptLanguage } = await ensureParsers();
    const runner = await import('@/features/runner');

    const groups = 60;
    const source =
      Array.from({ length: groups }, (_, i) => `// note number ${i}\nconst v${i} = ${i};`).join(
        '\n',
      ) + '\n';

    const lineSpy = vi.spyOn(runner, 'createLineStarts');
    const turn = capturingTurn();
    try {
      const result = await runCommentTranslation({
        ...base,
        filePath: 'a.ts',
        source,
        tree: javascriptLanguage.parser.parse(source) as never,
        turn,
        cache: new MemoryCache(),
      });

      // 前置断言：真的有多组被处理，否则「只建一次」是空转（假绿）
      expect(result.requestedSegments).toBe(groups);
      expect(lineSpy.mock.calls.length).toBe(1);
    } finally {
      lineSpy.mockRestore();
    }
  });

  it('should not re-scan the source per group when classifying many go groups', async () => {
    const { goLanguage } = await import('@codemirror/lang-go');
    const runner = await import('@/features/runner');

    const groups = 40;
    const source = Array.from(
      { length: groups },
      (_, i) => `// Doc for f${i}.\nfunc f${i}() {}`,
    ).join('\n');

    const lineSpy = vi.spyOn(runner, 'createLineStarts');
    try {
      await runCommentTranslation({
        ...base,
        filePath: 'a.go',
        source,
        tree: goLanguage.parser.parse(source) as never,
        turn: capturingTurn(),
        cache: new MemoryCache(),
      });
      expect(lineSpy.mock.calls.length).toBe(1);
    } finally {
      lineSpy.mockRestore();
    }
  });
});

describe('useCommentTranslation / entries 是组级（rebuildBlock 接线）', () => {
  /**
   * 缺陷回顾（用户可见）：entries 曾是**段级**的，于是下面这个夹具只产出两条 prose：
   *
   * ```
   * entries = [ '替换调用：', '改为缓存。' ]
   * ```
   *
   * 第 2 行 `const x = f(a);` 是 `code` 段（不进请求、也没有 entry），渲染时**凭空消失**，
   * 还丢了 `//` 前缀与原缩进 —— 同时违反 U2「代码原样保留」与 R6.4「code/fence 原样显示」。
   *
   * 根因：entry 的语义单位与渲染需要的单位不一致。渲染要的是**组**（组内译文段与 code
   * 原文行按原前缀混排）。所以 entries 必须按组聚合，经 `rebuildBlock` 重建完整行。
   */
  it('should rebuild a mixed group so code lines survive with their prefix', async () => {
    const { javascriptLanguage } = await ensureParsers();
    const source = [
      '// Replace the call:',
      '//   const x = f(a);',
      '// with cache.',
      'const y = 1;',
    ].join('\n');

    const result = await runCommentTranslation({
      ...base,
      filePath: 'a.ts',
      source,
      tree: javascriptLanguage.parser.parse(source) as never,
      turn: capturingTurn({ 'Replace the call:': '替换调用：', 'with cache.': '改为缓存。' }),
      cache: new MemoryCache(),
    });

    // 一个组 → 一条 entry（不是两条 prose 段）
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.text).toBe('// 替换调用：\n//   const x = f(a);\n// 改为缓存。');
    // 段级计数与组级条目数不是一回事（工具条的 N/M 用前者）
    expect(result.requestedSegments).toBe(2);
    expect(result.translatedSegments).toBe(2);
  });

  it('should re-emit ` * ` prefixes for a block comment group', async () => {
    const { javascriptLanguage } = await ensureParsers();
    const source = '/**\n * Translate this.\n * More text.\n */\nconst y = 1;\n';

    const result = await runCommentTranslation({
      ...base,
      filePath: 'a.ts',
      source,
      tree: javascriptLanguage.parser.parse(source) as never,
      turn: segmentedTurn({ 'Translate this.\nMore text.': '翻译这段。\n更多文本。' }),
      cache: new MemoryCache(),
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.text).toBe('/**\n * 翻译这段。\n * 更多文本。\n */');
  });

  it('should anchor docstring lines to the original indent and keep the quotes (D8)', async () => {
    const { pythonLanguage } = await ensureParsers();
    const source = 'def f():\n    """Run the thing.\n    Keep going.\n    """\n    return 1\n';

    const result = await runCommentTranslation({
      ...base,
      filePath: 'a.py',
      source,
      tree: pythonLanguage.parser.parse(source) as never,
      turn: segmentedTurn({ 'Run the thing.\n    Keep going.': '运行它。\n继续说明。' }),
      cache: new MemoryCache(),
    });

    expect(result.entries).toHaveLength(1);
    // 首行 = 原缩进 + 引号；续行对齐内容列（4 + 3 = 7）；闭引号独占一行同缩进
    expect(result.entries[0]?.text).toBe('    """运行它。\n       继续说明。\n    """');
  });

  it('should keep the original line and attach the reason to the group entry when a segment fails', async () => {
    const { javascriptLanguage } = await ensureParsers();
    const source = [
      '// Replace the call:',
      '//   const x = f(a);',
      '// with {0} cache.',
      'const y = 1;',
    ].join('\n');

    const turn: TranslateTurn = {
      async run(prompt: string) {
        // 第一段正常译，第二段丢占位符（校验必失败）
        void prompt;
        return JSON.stringify(['替换调用：', '改为缓存。']);
      },
    };

    const result = await runCommentTranslation({
      ...base,
      filePath: 'a.ts',
      source,
      tree: javascriptLanguage.parser.parse(source) as never,
      turn,
      cache: new MemoryCache(),
      retryFailed: false,
    });

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    // 失败段不影响其他段：成功段有译文，失败段回退**原文行**（含 `//` 前缀）
    expect(entry?.text).toBe('// 替换调用：\n//   const x = f(a);\n// with {0} cache.');
    // reason 挂在组级 entry 上（取组内第一条失败段的原因）
    expect(entry?.reason).toContain('placeholder');
  });
});

describe('useCommentTranslation / 单组重试（R6.6）', () => {
  /**
   * 夹具：两组独立注释，第一组能翻成功、第二组校验失败（`{0}` 被丢）。
   *
   * 组标识 = `CommentGroup.startLine`。这里第一组在 1 行、第二组在 3 行，所以
   * `onlyGroups: [3]` 表示「只重试第二组」。
   */
  const SOURCE =
    '// first prose here\nconst a = 1;\n// the {0} placeholder must survive\nconst b = 2;\n';

  /** 第一轮：第二段丢占位符 → 第二组带 reason。 */
  const failingTurn: TranslateTurn = {
    async run(prompt: string) {
      const texts = prompt
        .split('\n')
        .filter((line) => /^\[\d+\] /.test(line))
        .map((line) => line.replace(/^\[\d+\] /, ''));
      return JSON.stringify(
        texts.map((text) => (text.includes('{0}') ? '丢了占位符' : `译:${text}`)),
      );
    },
  };

  it('should only produce the entry of the retried group (onlyGroups scope)', async () => {
    const { javascriptLanguage } = await ensureParsers();
    const tree = javascriptLanguage.parser.parse(SOURCE) as never;

    const first = await runCommentTranslation({
      ...base,
      filePath: 'a.ts',
      source: SOURCE,
      tree,
      turn: failingTurn,
      cache: new MemoryCache(),
      retryFailed: false,
    });
    // 前置断言：第一轮确实产出了两条（一组成功、一组失败），否则下面的断言是空转
    expect(first.entries).toHaveLength(2);
    expect(first.entries[1]?.reason).toBeTruthy();

    const turn = capturingTurn();
    const retried = await runCommentTranslation({
      ...base,
      filePath: 'a.ts',
      source: SOURCE,
      tree,
      turn,
      cache: new MemoryCache(),
      retryFailed: false,
      onlyGroups: [3],
    });

    // 只处理被重试的组：prompt 里没有第一组的文本
    expect(turn.prompts.join('\n')).not.toContain('first prose here');
    expect(turn.prompts.join('\n')).toContain('the {0} placeholder must survive');
    // 本次产出只有被重试组那一条
    expect(retried.entries).toHaveLength(1);
    expect(retried.entries[0]?.groupKey).toBe(3);
  });

  it('should keep the other groups translations when previousEntries is passed', async () => {
    const { javascriptLanguage } = await ensureParsers();
    const tree = javascriptLanguage.parser.parse(SOURCE) as never;

    const first = await runCommentTranslation({
      ...base,
      filePath: 'a.ts',
      source: SOURCE,
      tree,
      turn: failingTurn,
      cache: new MemoryCache(),
      retryFailed: false,
    });
    const firstGroupEntry = first.entries.find((entry) => entry.groupKey === 1);
    // 前置断言：第一组是**成功的译文**（不是 reason 条目），否则「保留」测的是失败 chip
    expect(firstGroupEntry?.reason).toBeUndefined();
    expect(firstGroupEntry?.text).toContain('译:first prose here');

    const retried = await runCommentTranslation({
      ...base,
      filePath: 'a.ts',
      source: SOURCE,
      tree,
      turn: capturingTurn(),
      cache: new MemoryCache(),
      retryFailed: false,
      onlyGroups: [3],
      previousEntries: first.entries,
    });

    // 关键断言：重试一组之后，另一组的译文**仍在**
    expect(retried.entries).toHaveLength(2);
    const kept = retried.entries.find((entry) => entry.groupKey === 1);
    expect(kept?.text).toBe(firstGroupEntry?.text);
    expect(kept?.reason).toBeUndefined();

    // 被重试的组已修好：新译文、无 reason
    const fixed = retried.entries.find((entry) => entry.groupKey === 3);
    expect(fixed?.reason).toBeUndefined();
    expect(fixed?.text).toContain('译:the {0} placeholder must survive');

    // 文档顺序（合并后的两段来源要重排，否则呈现层顺序会错）
    expect(retried.entries[0]?.from).toBeLessThan(retried.entries[1]?.from ?? 0);
  });

  it('should replace (not duplicate) the retried group entry', async () => {
    const { javascriptLanguage } = await ensureParsers();
    const tree = javascriptLanguage.parser.parse(SOURCE) as never;

    const first = await runCommentTranslation({
      ...base,
      filePath: 'a.ts',
      source: SOURCE,
      tree,
      turn: failingTurn,
      cache: new MemoryCache(),
      retryFailed: false,
    });

    const retried = await runCommentTranslation({
      ...base,
      filePath: 'a.ts',
      source: SOURCE,
      tree,
      turn: capturingTurn(),
      cache: new MemoryCache(),
      retryFailed: false,
      onlyGroups: [3],
      previousEntries: first.entries,
    });

    // 同一组只能有一条（旧失败 chip 必须被新译文替掉，不能两条并存）
    expect(retried.entries.filter((entry) => entry.groupKey === 3)).toHaveLength(1);
  });

  it('should keep previous entries of a group whose retry produced nothing', async () => {
    const { javascriptLanguage } = await ensureParsers();
    const tree = javascriptLanguage.parser.parse(SOURCE) as never;

    const first = await runCommentTranslation({
      ...base,
      filePath: 'a.ts',
      source: SOURCE,
      tree,
      turn: failingTurn,
      cache: new MemoryCache(),
      retryFailed: false,
    });

    const retried = await runCommentTranslation({
      ...base,
      filePath: 'a.ts',
      source: SOURCE,
      tree,
      // 本轮什么都没产出（模型回空）→ 旧条目应保留，重试不应让界面变差
      turn: {
        async run() {
          return '';
        },
      },
      cache: new MemoryCache(),
      retryFailed: false,
      onlyGroups: [3],
      previousEntries: first.entries,
    });

    expect(retried.entries).toHaveLength(2);
    expect(retried.entries.filter((entry) => entry.groupKey === 3)).toHaveLength(1);
  });

  it('should not carry previous entries over on a whole-file run (replacement semantics)', async () => {
    const { javascriptLanguage } = await ensureParsers();
    const source = '// only prose\nconst a = 1;\n';
    const stale = [
      { from: 0, to: 13, text: '// 陈旧译文', groupKey: 1 },
      { from: 20, to: 30, text: '// 幽灵译文', groupKey: 99 },
    ];

    const result = await runCommentTranslation({
      ...base,
      filePath: 'a.ts',
      source,
      tree: javascriptLanguage.parser.parse(source) as never,
      turn: capturingTurn(),
      cache: new MemoryCache(),
      previousEntries: stale,
    });

    // 没有 onlyGroups → 整体替换：已不存在的组的旧译文必须消失
    expect(result.entries).toHaveLength(1);
    expect(result.entries.some((entry) => entry.groupKey === 99)).toBe(false);
  });
});
