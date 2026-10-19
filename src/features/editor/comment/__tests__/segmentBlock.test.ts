// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  DOC_SECTION_HEADER,
  EXAMPLE_LEAD,
  FENCE_MARK,
  looksLikeArgsField,
  looksLikeCode,
  looksLikeSentence,
} from '../commentHeuristics';
import type { LanguageFamily } from '../commentSyntax';
import { groupComments } from '../groupComments';
import { segmentBlock, type SegmentKind } from '../segmentBlock';

import { extractFromSource } from './commentTestParsers';

/**
 * AC4–AC9：块内分段 —— **本任务最核心的一层**（U2）。
 *
 * 用户决策：「注释中的代码不翻译，不管是死代码还是非死代码」。
 * 这意味着同一条注释内部若混排散文与代码，必须**分段**：代码段原样保留、散文段翻译。
 *
 * 误判方向（design.md D2）：`code` 判**宽** —— 宁可把散文误判成代码（用户看到原文，
 * 可手动处理），也不能把代码当散文翻坏（照抄即报错）。
 */
async function segmentsOf(family: LanguageFamily, source: string) {
  const units = await extractFromSource({ family, source });
  const groups = groupComments(units, { source, family });
  return groups.map((g) => segmentBlock(g));
}

async function kindsOf(family: LanguageFamily, source: string): Promise<SegmentKind[][]> {
  const segs = await segmentsOf(family, source);
  return segs.map((group) => group.segments.map((s) => s.kind));
}

describe('segmentBlock / AC5 混排：同一条注释内散文 + 代码', () => {
  it('should split a mixed comment into prose / code / prose', async () => {
    const source = [
      '// Replace the legacy call:',
      '//   const raw = await legacyFetch(segments);',
      '// with the single-turn path.',
      'const a = 1;',
    ].join('\n');

    const kinds = await kindsOf('ts', source);
    expect(kinds[0]).toEqual(['prose', 'code', 'prose']);
  });

  it('should keep the code line out of the translatable set', async () => {
    const source = '// Replace:\n//   const x = f(a);\n// with cache.\nconst a = 1;\n';
    const [group] = await segmentsOf('ts', source);
    const translatable = group.segments.filter((s) => s.translatable);

    expect(translatable.map((s) => s.text)).toEqual(['Replace:', 'with cache.']);
  });

  it('should detect several consecutive code lines as one code segment', async () => {
    const source = [
      '// Example:',
      '//   const a = f(x);',
      '//   if (a > 0) { return a; }',
      '// End.',
      'const z = 1;',
    ].join('\n');

    const kinds = await kindsOf('ts', source);
    // 两行连续代码应合并成一个 code 段（不是两个），否则重建时会被拆散
    expect(kinds[0]).toEqual(['prose', 'code', 'prose']);
  });
});

describe('segmentBlock / AC4 死代码整组不翻', () => {
  it('should mark a fully commented-out code block as a single code segment', async () => {
    const source = '// if (cache.has(addr)) { return cache.get(addr); }\nconst a = 1;\n';
    const kinds = await kindsOf('ts', source);
    expect(kinds[0]).toEqual(['code']);
  });

  it('should mark a multi-line commented-out block as code', async () => {
    const source = [
      '// for (const item of items) {',
      '//   process(item);',
      '// }',
      'const a = 1;',
    ].join('\n');
    const kinds = await kindsOf('ts', source);
    expect(kinds[0]).toEqual(['code']);
  });

  it('should not send any code segment to the model', async () => {
    const source = '// if (x) { return 1; }\nconst a = 1;\n';
    const [group] = await segmentsOf('ts', source);
    expect(group.segments.filter((s) => s.translatable)).toHaveLength(0);
  });
});

describe('segmentBlock / AC6 代码围栏整块不翻', () => {
  it('should treat a fenced block as one fence segment including delimiters', async () => {
    const source = ['// Usage:', '// ```ts', '// cache.set(k, v);', '// ```', 'const a = 1;'].join(
      '\n',
    );
    const [group] = await segmentsOf('ts', source);

    const kinds = group.segments.map((s) => s.kind);
    expect(kinds).toEqual(['prose', 'fence']);
    // fence 段必须包含 3 行（开标记 + 内容 + 闭标记）
    const fence = group.segments.find((s) => s.kind === 'fence');
    expect(fence?.lines).toHaveLength(3);
    expect(fence?.translatable).toBe(false);
  });

  it('should handle a fenced block with a language tag and blank lines inside', async () => {
    const source = [
      '// ```rust',
      '// let x = 1;',
      '//',
      '// let y = 2;',
      '// ```',
      'fn f() {}',
    ].join('\n');
    const [group] = await segmentsOf('rust', source);
    expect(group.segments.map((s) => s.kind)).toEqual(['fence']);
  });

  it('should resume prose after a closed fence', async () => {
    const source = [
      '// Before.',
      '// ```',
      '// code();',
      '// ```',
      '// After.',
      'const a = 1;',
    ].join('\n');
    const [group] = await segmentsOf('ts', source);
    expect(group.segments.map((s) => s.kind)).toEqual(['prose', 'fence', 'prose']);
  });

  it('should treat an unclosed fence as a fence to the end of the group', async () => {
    const source = ['// ```ts', '// const a = 1;', '// const b = 2;', 'const z = 1;'].join('\n');
    const [group] = await segmentsOf('ts', source);
    expect(group.segments.map((s) => s.kind)).toEqual(['fence']);
  });

  it('should accept tilde fences too', async () => {
    const source = ['// ~~~', '// code();', '// ~~~', 'const a = 1;'].join('\n');
    const [group] = await segmentsOf('ts', source);
    expect(group.segments.map((s) => s.kind)).toEqual(['fence']);
  });
});

describe('segmentBlock / AC7 Usage/Example 后的缩进示例块', () => {
  it('should mark an indented block after "Usage:" as code', async () => {
    const source = ['// Usage:', '//   translate(a, b);', '//   run();', 'const a = 1;'].join('\n');
    const [group] = await segmentsOf('ts', source);
    expect(group.segments.map((s) => s.kind)).toEqual(['prose', 'code']);
  });

  it('should mark an indented block after "Example:" as code', async () => {
    const source = ['// Example:', '//   foo(1);', 'const a = 1;'].join('\n');
    const [group] = await segmentsOf('ts', source);
    expect(group.segments.map((s) => s.kind)).toEqual(['prose', 'code']);
  });

  it('should mark an indented block after "e.g." as code', async () => {
    const source = ['// Call it like this, e.g.', '//   foo(1);', 'const a = 1;'].join('\n');
    const [group] = await segmentsOf('ts', source);
    expect(group.segments.map((s) => s.kind)).toEqual(['prose', 'code']);
  });

  it('should mark an indented block after a Chinese lead-in as code', async () => {
    const source = ['// 例如：', '//   foo(1);', 'const a = 1;'].join('\n');
    const [group] = await segmentsOf('ts', source);
    expect(group.segments.map((s) => s.kind)).toEqual(['prose', 'code']);
  });
});

describe('segmentBlock / 散文不得被误判成代码（防误杀）', () => {
  const proseCases = [
    '// the method returns the id',
    '// Note: use cache for speed.',
    '// This function is called once per frame.',
    '// Returns true when the value is positive.',
    '// If you need the raw value, see the accessor below.',
    '// It compares a and b, then picks the larger one.',
  ];

  for (const prose of proseCases) {
    it(`should keep as prose: ${prose.slice(3, 45)}`, async () => {
      const kinds = await kindsOf('ts', `${prose}\nconst a = 1;\n`);
      expect(kinds[0]).toEqual(['prose']);
    });
  }

  it('should not treat a sentence ending with a period as code', async () => {
    const kinds = await kindsOf('ts', '// Returns the cached value.\nconst a = 1;\n');
    expect(kinds[0]).toEqual(['prose']);
  });
});

describe('segmentBlock / AC3b tag 段（doc 标签与结构块）', () => {
  it('should mark @param / @returns lines as tag', async () => {
    const source = [
      '/**',
      ' * Translate a batch.',
      ' *',
      ' * @param segments the segments',
      ' * @returns the strings',
      ' */',
      'function f() {}',
    ].join('\n');

    const [group] = await segmentsOf('ts', source);
    const tags = group.segments.filter((s) => s.kind === 'tag');
    // 连续 tag 行合并成**一个**段（与 prose 合并规则一致），段内含 2 行
    expect(tags.length).toBe(1);
    expect(tags[0].lines).toHaveLength(2);
    expect(tags[0].text).toContain('@param segments');
    expect(tags[0].text).toContain('@returns the strings');
    // tag 段可翻译（标签名与名字由校验保护），但只翻说明部分
    expect(tags[0].translatable).toBe(true);
  });

  it('should mark python :param lines as tag', async () => {
    const source = 'def f(x):\n    """Doc.\n\n    :param x: the value\n    """\n    return x\n';
    const [group] = await segmentsOf('python', source);
    const tags = group.segments.filter((s) => s.kind === 'tag');
    expect(tags.length).toBeGreaterThanOrEqual(1);
    expect(tags[0].text).toContain(':param x:');
  });

  it('should mark an Args: section header as tag', async () => {
    const source =
      'def f(x):\n    """Doc.\n\n    Args:\n        x: the value\n    """\n    return x\n';
    const [group] = await segmentsOf('python', source);
    const kinds = group.segments.map((s) => s.kind);
    expect(kinds).toContain('tag');
  });

  it('should not send a field line with no description', async () => {
    // D9-Args：说明为空的字段行归 tag 但不送翻（无内容可翻，送了只会引入幻觉）
    const source = 'def f(x):\n    """Doc.\n\n    Args:\n        x:\n    """\n    return x\n';
    const [group] = await segmentsOf('python', source);
    const emptyField = group.segments.find((s) => s.kind === 'tag' && s.text.trim() === 'x:');
    if (emptyField) expect(emptyField.translatable).toBe(false);
  });
});

describe('segmentBlock / AC8 行内代码跨度不切段', () => {
  it('should keep a prose line containing an inline code span as one prose segment', async () => {
    // 跨度由校验规则保护（AC8），不在这里切段 —— 切段会把句子打散
    const source = '// See `cacheKey` for details.\nconst a = 1;\n';
    const [group] = await segmentsOf('ts', source);
    expect(group.segments.map((s) => s.kind)).toEqual(['prose']);
    expect(group.segments[0].text).toContain('`cacheKey`');
  });
});

describe('segmentBlock / blank 段参与重建', () => {
  it('should emit blank segments so paragraph breaks survive rebuild', async () => {
    const source = '/**\n * First.\n *\n * Second.\n */\nfunction f() {}\n';
    const [group] = await segmentsOf('ts', source);
    const kinds = group.segments.map((s) => s.kind);
    expect(kinds).toContain('blank');
    const blank = group.segments.find((s) => s.kind === 'blank');
    expect(blank?.translatable).toBe(false);
  });

  it('should not emit a blank segment for a completely empty comment', async () => {
    const [group] = await segmentsOf('ts', '//\nconst a = 1;\n');
    expect(group.segments).toHaveLength(0);
  });
});

describe('segmentBlock / 逐段携带重建信息', () => {
  it('should expose line range and original prefix for each segment', async () => {
    const source = '// one\n//   code();\n// three\nconst a = 1;\n';
    const [group] = await segmentsOf('ts', source);

    expect(group.segments.map((s) => s.startLine)).toEqual([1, 2, 3]);
    expect(group.segments.map((s) => s.endLine)).toEqual([1, 2, 3]);
    // 前缀用于重建（`//` + 一个空格）
    expect(group.segments[0].prefix).toBe('// ');
    // 代码段保留原始缩进（重建时原样回写）
    expect(group.segments[1].text).toBe('  code();');
  });

  it('should merge consecutive same-kind prose lines into one segment', async () => {
    const source = '// first line\n// second line\n// third line\nconst a = 1;\n';
    const [group] = await segmentsOf('ts', source);
    expect(group.segments).toHaveLength(1);
    expect(group.segments[0].lines).toHaveLength(3);
    expect(group.segments[0].text).toBe('first line\nsecond line\nthird line');
  });
});

describe('segmentBlock / 真实混排综合（原型同款）', () => {
  it('should produce the expected layout for the prototype comment', async () => {
    const source = [
      '// Replace the legacy call:',
      '//   const raw = await legacyFetch(segments);',
      '//   if (raw.error) { throw raw.error; }',
      '// with the single-turn path.',
      '//',
      '// Usage:',
      '// ```ts',
      '// const out = await translateBatch(segs, turn);',
      '// ```',
      'const a = 1;',
    ].join('\n');

    const [group] = await segmentsOf('ts', source);
    expect(group.segments.map((s) => s.kind)).toEqual([
      'prose',
      'code',
      'prose',
      'blank',
      'prose',
      'fence',
    ]);
    // 只有 prose 送翻，且 code/fence 的原文不出现在可翻译文本里
    const translatable = group.segments.filter((s) => s.translatable);
    expect(translatable.map((s) => s.kind)).toEqual(['prose', 'prose', 'prose']);
    const joined = translatable.map((s) => s.text).join('\n');
    expect(joined).not.toContain('legacyFetch');
    expect(joined).not.toContain('translateBatch');
  });
});

describe('segmentBlock / 代码判定边界（补分支覆盖）', () => {
  it('should treat JSX closing tags as code', async () => {
    const kinds = await kindsOf('ts', '// </div>\nconst a = 1;\n');
    expect(kinds[0]).toEqual(['code']);
  });

  it('should treat an assignment as code', async () => {
    const kinds = await kindsOf('ts', '// total = price * qty;\nconst a = 1;\n');
    expect(kinds[0]).toEqual(['code']);
  });

  it('should treat a bare function call as code', async () => {
    const kinds = await kindsOf('ts', '// render(node);\nconst a = 1;\n');
    expect(kinds[0]).toEqual(['code']);
  });

  it('should treat a line ending with a semicolon and parens as code', async () => {
    const kinds = await kindsOf('ts', '// log(x);\nconst a = 1;\n');
    expect(kinds[0]).toEqual(['code']);
  });

  it('should treat a Chinese prose line as prose', async () => {
    const kinds = await kindsOf('ts', '// 这里说明一下用途。\nconst a = 1;\n');
    expect(kinds[0]).toEqual(['prose']);
  });

  it('should treat a Chinese line containing code symbols as code', async () => {
    // 中文 + 代码符号 → 仍需判 code（混排里的代码部分）
    const kinds = await kindsOf('ts', '// 调用 foo(x); 即可\nconst a = 1;\n');
    expect(kinds[0]).toEqual(['code']);
  });

  it('should treat a multi-word sentence ending with a period as prose', async () => {
    const kinds = await kindsOf(
      'ts',
      '// this helper simply returns the cached value.\nconst a = 1;\n',
    );
    expect(kinds[0]).toEqual(['prose']);
  });

  it('should treat a lowercase multi-word line without symbols as prose', async () => {
    const kinds = await kindsOf('ts', '// returns the raw bytes when available\nconst a = 1;\n');
    expect(kinds[0]).toEqual(['prose']);
  });

  it('should treat a line starting with a brace as code', async () => {
    const kinds = await kindsOf('ts', '// { a: 1 }\nconst a = 1;\n');
    expect(kinds[0]).toEqual(['code']);
  });

  it('should treat an Args field without a colon as prose', async () => {
    const source =
      'def f(x):\n    """Doc.\n\n    Args:\n        x is the value\n    """\n    return x\n';
    const [group] = await segmentsOf('python', source);
    // 没有冒号 → 不是字段行，按普通行处理（prose）
    expect(group.segments.some((s) => s.kind === 'prose')).toBe(true);
  });
});

describe('segmentBlock / 判定函数边界（补分支覆盖）', () => {
  it('should treat a call statement with a trailing semicolon as code', async () => {
    const kinds = await kindsOf('ts', '// buildIndex(map);\nconst a = 1;\n');
    expect(kinds[0]).toEqual(['code']);
  });

  it('should treat a parenthesised call without trailing semicolon as prose when sentence-like', async () => {
    // `see the note (below)` 含括号但不是调用语句 → 不得判 code（防误杀）
    const kinds = await kindsOf('ts', '// see the note (below) for details.\nconst a = 1;\n');
    expect(kinds[0]).toEqual(['prose']);
  });

  it('should treat a prose line with an equals sign inside words as prose', async () => {
    const kinds = await kindsOf('ts', '// the value equals the default here.\nconst a = 1;\n');
    expect(kinds[0]).toEqual(['prose']);
  });

  it('should treat a four-word sentence ending with a comma as prose', async () => {
    const kinds = await kindsOf('ts', '// returns the cached value when possible,\nconst a = 1;\n');
    expect(kinds[0]).toEqual(['prose']);
  });

  it('should handle an Args field line that has a description', async () => {
    const source =
      'def f(x):\n    """Doc.\n\n    Args:\n        x: the value\n    """\n    return x\n';
    const [group] = await segmentsOf('python', source);
    const field = group.segments.find((s) => s.kind === 'tag' && s.text.includes('x:'));
    expect(field).toBeDefined();
    expect(field?.translatable).toBe(true);
  });

  it('should treat a line with only a colon as prose', async () => {
    const kinds = await kindsOf('ts', '// :\nconst a = 1;\n');
    expect(kinds[0]).toEqual(['prose']);
  });

  it('should merge multi-line prose and keep a single newline-joined text', async () => {
    const source = '// one\n// two\n// three\nconst a = 1;\n';
    const [group] = await segmentsOf('ts', source);
    expect(group.segments).toHaveLength(1);
    expect(group.segments[0].text.split('\n')).toHaveLength(3);
  });
});

describe('segmentBlock / 示例引导行的独立作用（AC7 补强）', () => {
  it('should treat an indented block after "Usage:" as code even when the lines do not look like code', async () => {
    // 关键判别用例：这两行**不**命中 looksLikeCode 的任何规则
    // （无代码起始词、无行尾分号、无赋值/调用形态），只能靠「示例引导行之后的缩进块」判 code。
    // 若去掉 afterExampleLead 机制，本用例会退化成 prose（M4 变异即由它抓住）。
    const source = [
      '// Usage:',
      '//   first value here',
      '//   second value here',
      'const a = 1;',
    ].join('\n');
    const [group] = await segmentsOf('ts', source);
    expect(group.segments.map((s) => s.kind)).toEqual(['prose', 'code']);
  });

  it('should treat an indented block after "Example:" the same way', async () => {
    const source = ['// Example:', '//   alpha beta gamma', 'const a = 1;'].join('\n');
    const [group] = await segmentsOf('ts', source);
    expect(group.segments.map((s) => s.kind)).toEqual(['prose', 'code']);
  });
});

describe('commentHeuristics / 拆分后的独立回归', () => {
  /**
   * 拆分（`segmentBlock.ts` → 状态机 + `commentHeuristics.ts` 启发式）是**纯搬迁**。
   * 这里锁住启发式本身的行为，让「改一条正则」可以单独回归，
   * 不必经整条「源码 → 组 → 段」链路。
   */
  it('should classify a prose sentence containing backticks as prose, not code', () => {
    // 误杀散文同样是坏结果（用户会看到一段没被翻译的说明文字）
    expect(looksLikeCode('See `cacheKey` for details.')).toBe(false);
    expect(looksLikeCode('The caller must pass a valid identifier.')).toBe(false);
  });

  it('should classify clear code signals as code', () => {
    expect(looksLikeCode('const raw = await legacyFetch(segments);')).toBe(true);
    expect(looksLikeCode('if (raw.error) {')).toBe(true);
    expect(looksLikeCode('调用 foo(x); 即可')).toBe(true);
  });

  it('should suppress the looksLikeSentence verdict for assignment statements', () => {
    // `total = price * qty;` 有 4 个词、小写开头 —— 若先走「像句子」判据就会漏判成 prose
    expect(looksLikeSentence('total = price * qty;')).toBe(false);
    expect(looksLikeSentence('Returns the total amount.')).toBe(true);
  });

  it('should require indentation for an Args field line', () => {
    // 裸的 `Replace:` / `Note: use cache` 是散文，不是结构块字段
    expect(looksLikeArgsField('  x: the value', 'x: the value')).toBe(true);
    expect(looksLikeArgsField('Replace:', 'Replace:')).toBe(false);
  });

  it('should expose the example-lead and fence markers the state machine consumes', () => {
    expect(EXAMPLE_LEAD.test('Usage:')).toBe(true);
    expect(EXAMPLE_LEAD.test('例如：')).toBe(true);
    expect(FENCE_MARK.test('```ts')).toBe(true);
    expect(DOC_SECTION_HEADER.test('Args:')).toBe(true);
  });
});
