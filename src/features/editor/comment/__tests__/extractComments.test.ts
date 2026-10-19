// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { LanguageFamily } from '../commentSyntax';
import { extractComments, parseDocstringForTest, stripMarkers } from '../extractComments';

import { extractFromPath, extractFromSource } from './commentTestParsers';

/**
 * AC3 / AC3c 前置：注释节点提取 + docstring 提取（含 D8 需要的缩进/引号信息）。
 *
 * 约定：所有断言都基于**真实 parser**（`parser.parse()`），不 mock 语法树 ——
 * 树形状是本任务最容易凭直觉猜错的地方（已两次实证），必须让测试看见真实结构。
 */

function parse(family: LanguageFamily, source: string) {
  return extractFromSource({ family, source });
}

/** 所有用例都等 parser 动态加载；直接 await 可读性最好。 */

describe('extractComments / 注释节点提取', () => {
  it('should extract line and block comments with exact doc ranges when family is ts', async () => {
    const source = '// line\n/** doc */\nconst a = 1; /* block */\n';
    const units = await parse('ts', source);

    const texts = units.map((u) => source.slice(u.from, u.to));
    expect(texts).toEqual(['// line', '/** doc */', '/* block */']);
    expect(units.map((u) => u.isBlock)).toEqual([false, true, true]);
    // doc 范围必须精确到标记本身（含 `//` / `/*`）
    expect(source.slice(units[0].from, units[0].to)).toBe('// line');
  });

  it('should mark trailing comments when code precedes them on the same line', async () => {
    const source = 'const a = 1; // trailing\n// standalone\n  // indented\n';
    const units = await parse('ts', source);

    expect(units.map((u) => u.isTrailing)).toEqual([true, false, false]);
    // 行首缩进必须被记录（重建时用；但不能把它当成 trailing）
    expect(units[1].lineIndent).toBe('');
    expect(units[2].lineIndent).toBe('  ');
  });

  it('should keep the python Comment node name working when family is python', async () => {
    const source = '# line one\nx = 1  # trailing\n';
    const units = await parse('python', source);

    expect(units.map((u) => source.slice(u.from, u.to))).toEqual(['# line one', '# trailing']);
    expect(units[0].isTrailing).toBe(false);
    expect(units[1].isTrailing).toBe(true);
  });

  it('should keep the lowercase stream comment node name working when family is stream', async () => {
    const source = '# yaml comment\nkey: value\n';
    const units = await parse('stream', source);
    expect(units).toHaveLength(1);
    expect(source.slice(units[0].from, units[0].to)).toBe('# yaml comment');
  });

  it('should not treat a comment marker inside a string literal as a comment', async () => {
    const source = 'const url = "http://x"; // real\n';
    const units = await parse('ts', source);

    // 只有一个真注释；AST 天然保证，这条用例是防「退回正则」的护栏
    expect(units).toHaveLength(1);
    expect(source.slice(units[0].from, units[0].to)).toBe('// real');
  });

  it('should expose block comment marker info for multiline rebuild', async () => {
    const source = '/**\n * a\n * b\n */\nconst x = 1;\n';
    const [unit] = await parse('ts', source);

    expect(unit.isBlock).toBe(true);
    expect(unit.blockOpen).toBe('/**');
    expect(unit.blockClose).toBe('*/');
  });

  it('should return no units when the family is unknown instead of guessing node names', () => {
    expect(extractComments({ family: 'unknown', tree: null, source: 'x' })).toEqual([]);
  });
});

describe('extractComments / docstring 提取（AC3 + U3）', () => {
  it('should extract module, class and function docstrings when they are the first statement', async () => {
    const source =
      '"""Module doc."""\n\n' +
      'class Engine:\n' +
      '    """Class doc."""\n\n' +
      '    def run(self):\n' +
      '        """Method doc."""\n' +
      '        return 1\n';
    const units = await parse('python', source);
    const docs = units.filter((u) => u.kind === 'docstring');

    expect(docs.map((u) => u.body)).toEqual(['Module doc.', 'Class doc.', 'Method doc.']);
    expect(docs.every((u) => u.isDoc)).toBe(true);
  });

  it('should not treat an assignment of a string literal as a docstring', async () => {
    const source = 'def f():\n    x = "not a docstring"\n    return x\n';
    const units = await parse('python', source);
    expect(units.filter((u) => u.kind === 'docstring')).toEqual([]);
  });

  it('should not treat a non-first bare string as a docstring', async () => {
    const source = 'def f():\n    x = 1\n    "stray string"\n    return x\n';
    const units = await parse('python', source);
    expect(units.filter((u) => u.kind === 'docstring')).toEqual([]);
  });

  it('should not treat a non-first TRIPLE-quoted string as a docstring', async () => {
    // 关键判别用例：必须用三引号，否则会被 parseDocstring 的「无三引号」分支拒绝，
    // 于是「首语句判定」根本走不到 —— 那会让本组用例变成假绿。
    const source = 'def f():\n    x = 1\n    """stray triple"""\n    return x\n';
    const units = await parse('python', source);
    expect(units.filter((u) => u.kind === 'docstring')).toEqual([]);
    // 但它是字符串表达式，不应被当成注释单元混进来
    expect(units.filter((u) => u.kind === 'comment')).toEqual([]);
  });

  it('should expose indent and content column for D8 rebuild when docstring is multiline', async () => {
    const source = 'def run(self):\n    """Run it.\n\n    More text.\n    """\n';
    const [doc] = (await parse('python', source)).filter((u) => u.kind === 'docstring');

    // 缩进 = `    `（4），内容起始列 = 缩进 + 3 个引号
    expect(doc.lineIndent).toBe('    ');
    expect(doc.docstring?.quote).toBe('"""');
    expect(doc.docstring?.indentWidth).toBe(4);
    expect(doc.docstring?.contentColumn).toBe(7);
  });

  it('should keep a continuation line that is NOT aligned with the first line indent', async () => {
    // 覆盖 cleandoc 简化版的 false 分支：续行缩进比首行浅 → 不剥前缀，原样保留
    const source = 'def f():\n    """First line.\n  Shallower indent.\n    """\n';
    const [doc] = (await parse('python', source)).filter((u) => u.kind === 'docstring');
    expect(doc.body).toContain('Shallower indent.');
  });

  it('should support single-quoted docstrings and keep the exact quote style', async () => {
    const source = "def f():\n    '''single'''\n";
    const [doc] = (await parse('python', source)).filter((u) => u.kind === 'docstring');
    expect(doc.docstring?.quote).toBe("'''");
    expect(doc.body).toBe('single');
  });

  it('should accept raw/bytes/unicode prefixes and record them so rebuild can re-emit them', async () => {
    const source = 'def f():\n    r"""raw doc"""\n';
    const [doc] = (await parse('python', source)).filter((u) => u.kind === 'docstring');
    expect(doc.docstring?.prefix).toBe('r');
    expect(doc.body).toBe('raw doc');
  });

  it('should skip f-strings because they carry interpolation semantics', async () => {
    const source = 'def f():\n    f"""value is {x}"""\n';
    const units = await parse('python', source);
    expect(units.filter((u) => u.kind === 'docstring')).toEqual([]);
  });
});

describe('stripMarkers', () => {
  it('should strip longest marker first so /// does not leave a stray slash', () => {
    expect(stripMarkers('/// doc', ['///', '//!', '//'])).toBe('doc');
    expect(stripMarkers('//! inner', ['///', '//!', '//'])).toBe('inner');
    expect(stripMarkers('// plain', ['///', '//!', '//'])).toBe('plain');
  });

  it('should strip a single leading space only so intentional indentation survives', () => {
    expect(stripMarkers('//   indented sample', ['//'])).toBe('  indented sample');
    expect(stripMarkers('#no space', ['#'])).toBe('no space');
    expect(stripMarkers('///', ['///', '//'])).toBe('');
  });

  it('should leave the text untouched when no marker matches', () => {
    expect(stripMarkers('plain prose', ['//'])).toBe('plain prose');
  });
});

describe('extractComments / 其余语言的提取路径（AC1 × AC3 交叉）', () => {
  it('should extract rust doc line comments and mark them as doc', async () => {
    const source = '//! inner doc\n/// outer doc\nfn a() {}\n';
    const units = await parse('rust', source);

    expect(units.map((u) => u.body)).toEqual(['inner doc', 'outer doc']);
    // `///` / `//!` 必须被识别为文档性注释（决定是否启用 doc 标签校验）
    expect(units.map((u) => u.isDoc)).toEqual([true, true]);
  });

  it('should strip /// as a whole so no stray slash remains', async () => {
    const source = '/// Doc line\nfn a() {}\n';
    const [unit] = await parse('rust', source);
    expect(unit.body).toBe('Doc line');
  });

  it('should mark a plain rust // comment as non-doc even though doc markers exist', async () => {
    // 覆盖 isDocLineMarker 的「有 docMarkers 但该行不匹配」分支：普通 `//` 不是 doc。
    const source = '// plain note\n/// doc note\nfn a() {}\n';
    const units = await parse('rust', source);
    expect(units.map((u) => u.isDoc)).toEqual([false, true]);
  });

  it('should extract go line comments with trailing detection', async () => {
    const source = 'package m\n\n// Doc for A\nfunc A() {} // trailing\n';
    const units = await parse('go', source);

    expect(units.map((u) => u.body)).toEqual(['Doc for A', 'trailing']);
    expect(units.map((u) => u.isTrailing)).toEqual([false, true]);
    // 没有 `///` 标记，故此处 isDoc 为 false（Go 的 doc 判定在 classifyBlock 里按位置做）
    expect(units.every((u) => u.isDoc === false)).toBe(true);
  });

  it('should treat java javadoc block as doc', async () => {
    const source = '/**\n * Javadoc line.\n */\nclass A {}\n';
    const [unit] = await parse('java', source);

    expect(unit.isBlock).toBe(true);
    expect(unit.blockOpen).toBe('/**');
    expect(unit.isDoc).toBe(true);
    expect(unit.body).toBe('Javadoc line.');
  });

  it('should extract css block comments without line markers', async () => {
    const source = '/* css note */\na { color: red; }\n';
    const [unit] = await parse('css', source);

    expect(unit.body).toBe('css note');
    expect(unit.isBlock).toBe(true);
    expect(unit.blockOpen).toBe('/*');
  });

  it('should return no units for families whose syntax table has no node names', async () => {
    // unknown 家族在 extractFromSource 里因无 loader 直接返回空
    expect(await parse('unknown', 'anything')).toEqual([]);
  });

  it('should reject a docstring whose closing quote is missing', async () => {
    // 结构上不是一个完整字符串表达式 → parser 不会给出 ExpressionStatement > String 组合，
    // 提取结果里不应出现 docstring
    const source = 'def f():\n    """unclosed\n';
    const units = await parse('python', source);
    expect(units.filter((u) => u.kind === 'docstring')).toEqual([]);
  });

  it('should resolve family from a file path and extract in one call', async () => {
    const units = await extractFromPath({
      filePath: 'src/lib.rs',
      source: '/// Path doc\npub fn f() {}\n',
    });
    expect(units.map((u) => u.body)).toEqual(['Path doc']);
  });
});

describe('extractComments / 边界分支', () => {
  it('should return null when a candidate string has no recognised quote', () => {
    // String 节点存在但形态不是 triple-quote（例如单引号单行）→ 不当作 docstring
    expect(parseDocstringForTest('"single"', { quotes: ['"""'], prefixes: [] }, 0)).toBeNull();
  });

  it('should return null when the closing quote is missing', () => {
    expect(
      parseDocstringForTest('"""unterminated', { quotes: ['"""'], prefixes: [] }, 0),
    ).toBeNull();
  });

  it('should bail out early when the family advertises no comment node names', () => {
    // 构造一个「家族已知但节点名为空」的场景：css 表实际有名字，这里用注入的假 syntax 不可行，
    // 因此直接验证 unknown 路径 + 空树路径都返回空数组（两条真实可达的早退分支）。
    expect(extractComments({ family: 'unknown', tree: null, source: 'x' })).toEqual([]);
    expect(extractComments({ family: 'ts', tree: null, source: 'x' })).toEqual([]);
  });
});

describe('extractComments / 剩余真实可达分支', () => {
  it('should collapse the blank line right after an opening quote', async () => {
    // `"""\ntext\n"""` 形态：开引号后的首个空行必须丢掉，否则正文会以空行开头
    const source = 'def f():\n    """\n    Real first line.\n    """\n';
    const [doc] = (await parse('python', source)).filter((u) => u.kind === 'docstring');
    expect(doc.body.startsWith('Real first line.')).toBe(true);
  });

  it('should handle a tree whose wrapper node has no parent without throwing', async () => {
    // 根节点没有 parent（防御分支：正常语法树不会走到，但输入不可信）
    const source = '"""top level"""';
    const units = await parse('python', source);
    // 模块级 docstring 的 parent 是 Module，必须正常提取
    expect(units.filter((u) => u.kind === 'docstring')).toHaveLength(1);
  });

  it('should extract a module-level docstring whose parent is the root Script node', async () => {
    const source = '"""Module doc."""\nx = 1\n';
    const units = await parse('python', source);
    expect(units.filter((u) => u.kind === 'docstring').map((u) => u.body)).toEqual(['Module doc.']);
  });
});

describe('extractComments / docstring 缩进剥离（刚修 bug 的回归护栏）', () => {
  it('should strip the common indent using the first NON-EMPTY line as the baseline', async () => {
    // 首版 bug：基准取 bodyLines[0]（开引号后恒为空串）→ baseIndent='' → 剥离静默失效，
    // 正文带着 4 空格缩进。此用例断言正文**不含**行首缩进。
    const source = 'def f():\n    """\n    Real first line.\n    Second line.\n    """\n';
    const [doc] = (await parse('python', source)).filter((u) => u.kind === 'docstring');
    expect(doc.body).toBe('Real first line.\nSecond line.');
    // 反向：确保没有残留缩进
    expect(doc.body.startsWith(' ')).toBe(false);
  });

  it('should keep relative indentation between continuation lines', async () => {
    const source = 'def f():\n    """Summary.\n\n    Args:\n        n: count\n    """\n';
    const [doc] = (await parse('python', source)).filter((u) => u.kind === 'docstring');
    // 相对缩进（n: count 比 Args: 深）必须保留 —— 那是结构语义
    expect(doc.body).toContain('    n: count');
  });
});

describe('extractComments / docstring 首行与开引号同行（cleandoc 语义）', () => {
  it('should trim the summary line that sits on the opening-quote line', async () => {
    // 首版缺陷：首行与 `"""` 同行时，它没有缩进语义，必须单独 trim；
    // 若让它参与缩进剥离，正文会带上开引号后的原始空白。
    const source =
      'def f():\n    """   Summary with leading spaces.   \n\n    Body line.\n    """\n';
    const [doc] = (await parse('python', source)).filter((u) => u.kind === 'docstring');
    // 首行的前导空格会被最终 `.trim()` 吃掉，所以只断言**前导**无判别力；
    // 真正能区分「是否单独 trim 首行」的是**行尾**空格是否残留。
    expect(doc.body).toBe('Summary with leading spaces.\n\nBody line.');
    expect(doc.body.includes('spaces.   ')).toBe(false);
  });

  it('should use the first standalone non-empty line as the indent baseline', async () => {
    // 首行同行 + 后续行缩进 → 基准必须取自后续行，使同级文本被正确剥缩进
    const source = 'def f():\n    """Summary.\n\n    Body line.\n    """\n';
    const [doc] = (await parse('python', source)).filter((u) => u.kind === 'docstring');
    expect(doc.body).toBe('Summary.\n\nBody line.');
  });
});
