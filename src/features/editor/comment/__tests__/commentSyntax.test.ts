// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  commentNodeNames,
  detectFamily,
  docstringSpecOf,
  lineMarkersOf,
  syntaxFor,
  type LanguageFamily,
} from '../commentSyntax';

/**
 * AC1：七种语言的注释节点名必须按**真实语法树**命中。
 *
 * 这里刻意用真实 parser 解析 fixture 后断言节点名 —— 不用 `/comment/i` 模糊匹配。
 * 理由是实测定到的方言分裂：TS/Rust/Go/Java 是 `LineComment`/`BlockComment`，
 * Python/CSS 是 `Comment`，`legacy-modes`（StreamLanguage）是小写 `comment`。
 * 模糊匹配会让这三者「都通过」，AC1 随之失去判别力。
 */
interface FamilyFixture {
  family: LanguageFamily;
  /** 该 family 用来解析 fixture 的 parser 工厂（test-only：生产走 syntaxTree(state)）。 */
  parser: () => { parse(input: string): { topNode: TreeNode } };
  source: string;
  /** 期望命中的节点名（精确）。 */
  expected: string[];
}

interface TreeNode {
  type: { name: string };
  from: number;
  to: number;
  firstChild: TreeNode | null;
  nextSibling: TreeNode | null;
}

function collectCommentNodeNames(
  root: TreeNode,
  candidates: ReadonlySet<string>,
): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const stack: TreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as TreeNode;
    if (candidates.has(node.type.name)) {
      const list = found.get(node.type.name) ?? [];
      list.push(node.type.name);
      found.set(node.type.name, list);
    }
    const children: TreeNode[] = [];
    for (let c = node.firstChild; c; c = c.nextSibling) children.push(c);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return found;
}

async function buildFixtures(): Promise<FamilyFixture[]> {
  const { javascriptLanguage } = await import('@codemirror/lang-javascript');
  const { rustLanguage } = await import('@codemirror/lang-rust');
  const { goLanguage } = await import('@codemirror/lang-go');
  const { javaLanguage } = await import('@codemirror/lang-java');
  const { pythonLanguage } = await import('@codemirror/lang-python');
  const { cssLanguage } = await import('@codemirror/lang-css');
  const { StreamLanguage } = await import('@codemirror/language');
  const { yaml } = await import('@codemirror/legacy-modes/mode/yaml');

  return [
    {
      family: 'ts',
      parser: () => javascriptLanguage.parser,
      source: '// line\n/** doc */\nconst a = 1; /* block */\n',
      expected: ['LineComment', 'BlockComment'],
    },
    {
      family: 'rust',
      parser: () => rustLanguage.parser,
      source: '//! inner doc\n/// outer doc\nfn a() {} /* block */\n',
      expected: ['LineComment', 'BlockComment'],
    },
    {
      family: 'go',
      parser: () => goLanguage.parser,
      source: '// doc\npackage m\n\n/* block\ndoc */\nfunc A() {}\n',
      expected: ['LineComment', 'BlockComment'],
    },
    {
      family: 'java',
      parser: () => javaLanguage.parser,
      source: '/** javadoc */\nclass A { // line\n}\n',
      expected: ['BlockComment', 'LineComment'],
    },
    {
      family: 'python',
      parser: () => pythonLanguage.parser,
      source: '# line comment\ndef f():\n    pass\n',
      expected: ['Comment'],
    },
    {
      family: 'css',
      parser: () => cssLanguage.parser,
      source: '/* css comment */\na { color: red; }\n',
      expected: ['Comment'],
    },
    {
      family: 'stream',
      parser: () => StreamLanguage.define(yaml).parser,
      source: '# yaml comment\nkey: value\n',
      expected: ['comment'],
    },
  ];
}

describe('commentSyntax / AC1 节点名与真实语法树对齐', () => {
  it('should hit the exact legacy-expected node names for all seven families when parsed by the real parser', async () => {
    const fixtures = await buildFixtures();
    const failures: string[] = [];

    for (const fixture of fixtures) {
      const candidates = new Set(commentNodeNames(fixture.family));
      const tree = fixture.parser().parse(fixture.source);
      const found = collectCommentNodeNames(tree.topNode, candidates);

      for (const name of fixture.expected) {
        if (!found.has(name)) {
          failures.push(
            `${fixture.family}: expected node "${name}" but tree yielded ` +
              `[${[...found.keys()].join(', ') || '(none)'}]; ` +
              `candidates were [${[...candidates].join(', ')}]`,
          );
        }
      }

      // 反向：候选集合里的每个名字都必须能在真实树里出现，避免表里塞了错名字。
      for (const name of candidates) {
        if (!fixture.expected.includes(name)) {
          failures.push(
            `${fixture.family}: candidate "${name}" is in the data table but not in ` +
              `the fixture's expected list — either the table or the fixture drifted`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('should cover all seven families so a new language needs only one table row', async () => {
    const fixtures = await buildFixtures();
    expect(fixtures.map((f) => f.family).sort()).toEqual(
      ['css', 'go', 'java', 'python', 'rust', 'stream', 'ts'].sort(),
    );
  });
});

describe('commentSyntax / detectFamily', () => {
  it('should map file paths to families through the canonical language registry', () => {
    expect(detectFamily('a.ts')).toBe('ts');
    expect(detectFamily('a.tsx')).toBe('ts');
    expect(detectFamily('src/x/y.js')).toBe('ts');
    expect(detectFamily('a.rs')).toBe('rust');
    expect(detectFamily('a.go')).toBe('go');
    expect(detectFamily('a.java')).toBe('java');
    expect(detectFamily('a.py')).toBe('python');
    expect(detectFamily('a.css')).toBe('css');
    expect(detectFamily('a.scss')).toBe('css');
    expect(detectFamily('a.yaml')).toBe('stream');
    expect(detectFamily('a.yml')).toBe('stream');
    expect(detectFamily('a.sh')).toBe('stream');
    expect(detectFamily('a.bash')).toBe('stream');
  });

  it('should return unknown when the extension carries no comment syntax we support', () => {
    expect(detectFamily('a.md')).toBe('unknown');
    expect(detectFamily('a.json')).toBe('unknown');
    expect(detectFamily('README')).toBe('unknown');
    expect(detectFamily('a.unknownext')).toBe('unknown');
  });

  it('should not invent a second extension table when the registry already knows the path', () => {
    // 同一扩展名的两种写路径都必须经 languageForPath 归一（大小写 + 反斜杠）
    expect(detectFamily('C:\\repo\\A.TS')).toBe('ts');
    expect(detectFamily('src/A.Py')).toBe('python');
  });
});

describe('commentSyntax / commentNodeNames', () => {
  it('should return the python-only Comment node name', () => {
    expect(commentNodeNames('python')).toEqual(['Comment']);
  });

  it('should return the lowercase stream node name', () => {
    expect(commentNodeNames('stream')).toEqual(['comment']);
  });

  it('should return both line and block names for the lezer-based C-family', () => {
    for (const family of ['ts', 'rust', 'go', 'java'] as const) {
      expect(commentNodeNames(family)).toEqual(['LineComment', 'BlockComment']);
    }
  });

  it('should return an empty list for unknown so callers can treat it as unsupported', () => {
    expect(commentNodeNames('unknown')).toEqual([]);
  });
});

describe('commentSyntax / lineMarkersOf', () => {
  it('should list longest-first so /// wins over // when stripping', () => {
    const markers = lineMarkersOf('rust');
    expect(markers[0]).toBe('///');
    const innerIndex = markers.indexOf('//!');
    const plainIndex = markers.indexOf('//');
    expect(innerIndex).toBeGreaterThan(-1);
    expect(plainIndex).toBeGreaterThan(innerIndex);
  });

  it('should expose # for python and hash-comment legacy modes', () => {
    expect(lineMarkersOf('python')).toContain('#');
    expect(lineMarkersOf('stream')).toContain('#');
  });

  it('should expose css block markers and no line marker', () => {
    const syntax = syntaxFor('css');
    expect(syntax.lineMarkers).toEqual([]);
    expect(syntax.blockOpen).toBe('/*');
    expect(syntax.blockClose).toBe('*/');
  });
});

describe('commentSyntax / docstringSpecOf（U3 + D8 前置）', () => {
  it('should declare the python docstring path as ExpressionStatement > String', () => {
    const spec = docstringSpecOf('python');
    expect(spec).not.toBeNull();
    expect(spec?.wrapperNodeName).toBe('ExpressionStatement');
    expect(spec?.valueNodeName).toBe('String');
    expect(spec?.quotes).toEqual(['"""', "'''"]);
  });

  it('should return null for languages whose docs are comments rather than string literals', () => {
    for (const family of ['ts', 'rust', 'go', 'java', 'css', 'stream', 'unknown'] as const) {
      expect(docstringSpecOf(family)).toBeNull();
    }
  });
});
