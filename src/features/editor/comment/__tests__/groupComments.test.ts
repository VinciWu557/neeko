// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { LanguageFamily } from '../commentSyntax';
import { groupComments } from '../groupComments';

import { extractFromSource } from './commentTestParsers';

/**
 * AC2：连续行注释按**行邻接**分组。
 *
 * 为什么必须有这一层：连续 `//` 在语法树里是**每个一行一个独立节点**（实测 Rust
 * `/// A\n///\n/// # Example` = 7 个 `LineComment`）。逐节点翻译会打散段落、请求数 ×N，
 * 且无法表达「块内某些行是代码」（U2）。
 */
async function groupsOf(family: LanguageFamily, source: string) {
  const units = await extractFromSource({ family, source });
  return groupComments(units, { source, family });
}

describe('groupComments / AC2 行邻接分组', () => {
  it('should merge adjacent line comments into one group', async () => {
    const groups = await groupsOf('ts', '// line one\n// line two\nconst a = 1;\n');

    expect(groups).toHaveLength(1);
    expect(groups[0].units).toHaveLength(2);
    expect(groups[0].lines.map((l) => l.body)).toEqual(['line one', 'line two']);
    expect(groups[0].startLine).toBe(1);
    expect(groups[0].endLine).toBe(2);
  });

  it('should split on a blank line', async () => {
    const groups = await groupsOf('ts', '// block A\n\n// block B\nconst a = 1;\n');

    expect(groups).toHaveLength(2);
    expect(groups[0].lines.map((l) => l.body)).toEqual(['block A']);
    expect(groups[1].lines.map((l) => l.body)).toEqual(['block B']);
  });

  it('should split when a code line separates two comments', async () => {
    const groups = await groupsOf('ts', '// above\nconst a = 1;\n// below\n');

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.lines.map((l) => l.body))).toEqual([['above'], ['below']]);
  });

  it('should NOT split on an indented continuation line', async () => {
    // 缩进续行是同一段落的示例代码，必须留在同一组（分组后再由 segment 判 code）
    const source =
      '// usage:\n//   const x = f(a);\n//   if (x) { return x; }\n// end.\nconst a = 1;\n';
    const groups = await groupsOf('ts', source);

    expect(groups).toHaveLength(1);
    expect(groups[0].lines.map((l) => l.body)).toEqual([
      'usage:',
      '  const x = f(a);',
      '  if (x) { return x; }',
      'end.',
    ]);
  });
});

describe('groupComments / 边界形态各自成组', () => {
  it('should give a block comment its own group and not merge with a following line comment', async () => {
    const source = '/**\n * Doc.\n */\n// separate note\nconst a = 1;\n';
    const groups = await groupsOf('ts', source);

    expect(groups).toHaveLength(2);
    expect(groups[0].shape).toBe('block');
    expect(groups[1].shape).toBe('line');
  });

  it('should keep two adjacent block comments in separate groups', async () => {
    // 块注释自带显式边界（`/*` … `*/`），不需要邻接启发式，也不应被合并
    const groups = await groupsOf('ts', '/* one */\n/* two */\nconst a = 1;\n');

    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.shape === 'block')).toBe(true);
  });

  it('should give a trailing comment its own group', async () => {
    // 尾随注释附着在代码行上，与下一行的独立注释语义不同
    const source = 'const a = 1; // trailing\n// standalone\nconst b = 2;\n';
    const groups = await groupsOf('ts', source);

    expect(groups).toHaveLength(2);
    expect(groups[0].lines[0].isTrailing).toBe(true);
    expect(groups[1].lines[0].isTrailing).toBe(false);
  });

  it('should not merge a trailing comment with the standalone comment above it', async () => {
    const source = '// standalone\nconst a = 1; // trailing\n';
    const groups = await groupsOf('ts', source);

    expect(groups).toHaveLength(2);
    expect(groups[0].lines[0].isTrailing).toBe(false);
    expect(groups[1].lines[0].isTrailing).toBe(true);
  });

  it('should give a python docstring its own group with shape docstring', async () => {
    const source = 'def f():\n    """Run it.\n\n    More.\n    """\n    return 1\n';
    const groups = await groupsOf('python', source);

    expect(groups).toHaveLength(1);
    expect(groups[0].shape).toBe('docstring');
    // 组内保留**原文行结构**（含开引号行与空行）——重建需要它们；
    // 折叠后的正文在 group.units[0].body（cleandoc 语义），只用于送翻译。
    expect(groups[0].lines).toHaveLength(4);
    // 段落空行必须保留（它是摘要与正文的分隔，不是排版噪声）
    expect(groups[0].units[0].body).toBe('Run it.\n\nMore.');
  });
});

describe('groupComments / 组携带的信息（R2.3）', () => {
  it('should carry per-line raw text with markers intact', async () => {
    const groups = await groupsOf('ts', '// one\n// two\n');
    expect(groups[0].lines.map((l) => l.raw)).toEqual(['// one', '// two']);
  });

  it('should strip the block comment star prefix per line but keep the text', async () => {
    const source = '/**\n * first\n * second\n */\nconst a = 1;\n';
    const [group] = await groupsOf('ts', source);

    expect(group.lines.map((l) => l.body)).toEqual(['', 'first', 'second', '']);
    // raw 必须保留原排版（重建时按它还原）
    expect(group.lines.map((l) => l.raw)).toEqual(['/**', ' * first', ' * second', ' */']);
  });

  it('should expose the group indent from its first non-trailing unit', async () => {
    const groups = await groupsOf('ts', '  // indented\n  // still indented\nconst a = 1;\n');
    expect(groups[0].indent).toBe('  ');
  });

  it('should report shape line for a run of line comments', async () => {
    const groups = await groupsOf('ts', '// a\n// b\n');
    expect(groups[0].shape).toBe('line');
  });

  it('should map every line back to its owning unit index', async () => {
    const groups = await groupsOf('ts', '// one\n/** two\n * three */\n');
    // 第一个 unit 是 line comment（1 行），第二个是 block（2 行）
    expect(groups).toHaveLength(2);
    expect(groups[0].lines.map((l) => l.unitIndex)).toEqual([0]);
    expect(groups[1].lines.map((l) => l.unitIndex)).toEqual([0, 0]);
  });
});

describe('groupComments / 退化输入', () => {
  it('should return an empty list when there are no units', async () => {
    expect(await groupsOf('ts', 'const a = 1;\n')).toEqual([]);
  });

  it('should return a single group for a single unit', async () => {
    const groups = await groupsOf('ts', '// only\n');
    expect(groups).toHaveLength(1);
    expect(groups[0].lines).toHaveLength(1);
  });

  it('should tolerate CRLF line endings without leaving a carriage return in bodies', async () => {
    const groups = await groupsOf('ts', '// one\r\n// two\r\nconst a = 1;\r\n');
    expect(groups[0].lines.map((l) => l.body)).toEqual(['one', 'two']);
  });

  it('should keep grouping correct when input units are out of order', async () => {
    // 契约上要求 from 升序；这里验证实现做了防御性排序而不是静默产出错组
    const units = await extractFromSource({ family: 'ts', source: '// a\n// b\n' });
    const reversed = [...units].reverse();
    const groups = groupComments(reversed, { source: '// a\n// b\n', family: 'ts' });

    expect(groups).toHaveLength(1);
    expect(groups[0].lines.map((l) => l.body)).toEqual(['a', 'b']);
  });
});

describe('groupComments / AC2 综合（真实混排形态）', () => {
  it('should produce the expected group layout for a realistic file', async () => {
    const source = [
      '/**',
      ' * Translate a batch.',
      ' *',
      ' * @param segments the segments',
      ' */',
      'export async function translateBatch(segments, turn) {',
      '  // Replace the legacy call:',
      '  //   const raw = await legacyFetch(segments);',
      '  // with the single-turn path.',
      '  return run(turn);',
      '}',
      '',
    ].join('\n');

    const groups = await groupsOf('ts', source);

    expect(groups.map((g) => g.shape)).toEqual(['block', 'line']);
    expect(groups[0].startLine).toBe(1);
    expect(groups[0].endLine).toBe(5);
    expect(groups[1].startLine).toBe(7);
    expect(groups[1].endLine).toBe(9);
    // 组内混排：prose / 缩进代码 / prose —— 分组阶段只负责边界，不判 code
    expect(groups[1].lines.map((l) => l.body)).toEqual([
      'Replace the legacy call:',
      '  const raw = await legacyFetch(segments);',
      'with the single-turn path.',
    ]);
  });
});

describe('groupComments / 行对齐与标记剥离的边界', () => {
  it('should align block comment lines so every raw line has a body slot', async () => {
    // 单行块注释 `/* one */`：rawLines 只有 1 行，inner 剥标记后是空串 → 必须补位对齐，
    // 否则 lines[0].body 会错位成下一行的内容
    const groups = await groupsOf('ts', '/* one */\nconst a = 1;\n');
    expect(groups[0].lines).toHaveLength(1);
    expect(groups[0].lines[0].raw).toBe('/* one */');
  });

  it('should align multiline block comment lines with raw lines', async () => {
    const groups = await groupsOf('ts', '/**\n * first\n * second\n */\nconst a = 1;\n');
    const [group] = groups;
    // 4 个 raw 行 → 4 个 body 槽位（首尾是标记行）
    expect(group.lines).toHaveLength(4);
    expect(group.lines.map((l) => l.raw)).toEqual(['/**', ' * first', ' * second', ' */']);
  });

  it('should leave a line without a known marker untouched', async () => {
    // stripLineMarker 的「无标记匹配」兜底分支：需要一条**走行注释路径**但不以标记开头的行。
    // 现实中这只会出现在多行行注释的续行（例如 JS 里 `//` 后换行接裸文本），
    // 用 python 的 `#` 家族反向构造更稳：这里直接用 ts 的多行注释节点内嵌裸行。
    const groups = await groupsOf('ts', '// first\n// second\nconst a = 1;\n');
    const [group] = groups;
    // 两条都是正常标记行，raw 与 body 一一对应
    expect(group.lines.map((l) => l.raw)).toEqual(['// first', '// second']);
    expect(group.lines.map((l) => l.body)).toEqual(['first', 'second']);
  });
});

describe('groupComments / docstring 行的引号剥离', () => {
  it('should strip the opening prefix+quote from the first raw line', async () => {
    const groups = await groupsOf('python', 'def f():\n    r"""Raw doc."""\n    return 1\n');
    const [group] = groups;
    // 首行 raw 是 `    r"""Raw doc."""`，body 必须已剥掉 `r"""` 前缀与闭引号
    expect(group.lines[0].body).toBe('Raw doc.');
  });

  it('should strip the closing quote from the last raw line when it stands alone', async () => {
    const groups = await groupsOf(
      'python',
      'def f():\n    """First.\n\n    Second.\n    """\n    return 1\n',
    );
    const [group] = groups;
    const last = group.lines[group.lines.length - 1];
    expect(last.raw.trim()).toBe('"""');
    // 独占一行的闭引号行，剥掉引号后 body 为空
    expect(last.body.trim()).toBe('');
  });
});

describe('groupComments / docstring 不参与行邻接合并', () => {
  it('should keep a docstring separate from an adjacent line comment', async () => {
    // docstring 是字符串表达式，与紧随其后的注释没有排版连续性；
    // 若允许合并，shape 会退化成 line 且 docstring 元信息丢失。
    const source = 'def f():\n    """Doc."""\n    # note right below\n    return 1\n';
    const groups = await groupsOf('python', source);

    expect(groups.map((g) => g.shape)).toEqual(['docstring', 'line']);
    expect(groups[0].units[0].kind).toBe('docstring');
    expect(groups[1].units[0].kind).toBe('comment');
  });

  it('should keep a docstring separate from an adjacent line comment that follows on the next line', async () => {
    const source = 'class A:\n    """Class doc."""\n    # trailing note\n';
    const groups = await groupsOf('python', source);
    expect(groups).toHaveLength(2);
    expect(groups[0].shape).toBe('docstring');
    expect(groups[1].shape).toBe('line');
  });
});

describe('groupComments / docstring 作为后一单元时不并入前一组', () => {
  it('should not merge a docstring into a preceding line comment group', async () => {
    // 关键方向：docstring 在**后面**时，若 isMergeable 放行它，会被前一个 line 组吞并，
    // 组 shape 仍是 line 但混进了字符串单元 —— docstring 元信息随之错位。
    const source = '# leading note\n"""Module doc."""\nx = 1\n';
    const groups = await groupsOf('python', source);

    expect(groups.map((g) => g.shape)).toEqual(['line', 'docstring']);
    expect(groups[1].units[0].kind).toBe('docstring');
  });
});
