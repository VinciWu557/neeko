// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { rebuildBlock, type RebuildInput } from '../rebuildBlock';

/**
 * 重建：译文段 + 原标记 → 可渲染文本。
 *
 * 重建必须**逐行按原前缀补齐**，否则：
 * - 行注释多行译文会丢掉 `//`，渲染时变成裸文本
 * - 块注释多行译文会丢掉 ` * `，破坏 JSDoc 结构
 * - docstring 多行译文缩进错乱，读者无法分辨哪些是正文
 */

const input = (overrides: Partial<RebuildInput>): RebuildInput => ({
  shape: 'line',
  prefix: '// ',
  indent: '',
  lines: [],
  ...overrides,
});

describe('rebuildBlock / 行注释', () => {
  it('should prefix every translated line', () => {
    const out = rebuildBlock(
      input({
        shape: 'line',
        prefix: '// ',
        segments: [{ kind: 'prose', lines: ['one', 'two'], text: '第一行\n第二行' }],
      }),
    );
    expect(out).toEqual(['// 第一行', '// 第二行']);
  });

  it('should keep code lines verbatim with their original prefix', () => {
    const out = rebuildBlock(
      input({
        shape: 'line',
        prefix: '// ',
        segments: [
          { kind: 'prose', lines: ['Replace:'], text: '替换：' },
          { kind: 'code', lines: ['//   const x = f(a);'], text: '  const x = f(a);' },
        ],
      }),
    );
    expect(out).toEqual(['// 替换：', '//   const x = f(a);']);
  });

  it('should emit a bare marker for blank segments', () => {
    const out = rebuildBlock(
      input({
        shape: 'line',
        prefix: '// ',
        segments: [
          { kind: 'prose', lines: ['a'], text: '甲' },
          { kind: 'blank', lines: ['//'], text: '' },
          { kind: 'prose', lines: ['b'], text: '乙' },
        ],
      }),
    );
    expect(out).toEqual(['// 甲', '//', '// 乙']);
  });

  it('should handle rust /// prefix', () => {
    const out = rebuildBlock(
      input({
        shape: 'line',
        prefix: '/// ',
        segments: [{ kind: 'prose', lines: ['Doc.'], text: '文档。' }],
      }),
    );
    expect(out).toEqual(['/// 文档。']);
  });

  it('should preserve the group indent for indented line comments', () => {
    // 契约：`prefix` 只含标记（`// `），缩进由 `indent` 单独表达。
    // 若把缩进写进 prefix 会与 indent 重复叠加（实测：'  // ' + '  ' → '    // '）。
    const out = rebuildBlock(
      input({
        shape: 'line',
        prefix: '// ',
        indent: '  ',
        segments: [{ kind: 'prose', lines: ['note'], text: '备注' }],
      }),
    );
    expect(out).toEqual(['  // 备注']);
  });
});

describe('rebuildBlock / 块注释', () => {
  it('should re-emit the block markers and star prefixes', () => {
    const out = rebuildBlock(
      input({
        shape: 'block',
        prefix: ' * ',
        segments: [{ kind: 'prose', lines: [' * Translate.'], text: '翻译。' }],
      }),
    );
    expect(out[0]).toBe('/**');
    expect(out).toContain(' * 翻译。');
    expect(out[out.length - 1]).toBe(' */');
  });

  it('should split a multi-line translation into multiple star lines', () => {
    const out = rebuildBlock(
      input({
        shape: 'block',
        prefix: ' * ',
        segments: [{ kind: 'prose', lines: [' * one'], text: '第一行\n第二行' }],
      }),
    );
    expect(out).toContain(' * 第一行');
    expect(out).toContain(' * 第二行');
  });

  it('should keep tag segments as star lines with their tag intact', () => {
    const out = rebuildBlock(
      input({
        shape: 'block',
        prefix: ' * ',
        segments: [{ kind: 'tag', lines: [' * @param x the value'], text: '@param x 值' }],
      }),
    );
    expect(out).toContain(' * @param x 值');
  });

  it('should emit a bare star line for blank segments', () => {
    const out = rebuildBlock(
      input({
        shape: 'block',
        prefix: ' * ',
        segments: [
          { kind: 'prose', lines: [' * a'], text: '甲' },
          { kind: 'blank', lines: [' *'], text: '' },
        ],
      }),
    );
    expect(out).toContain(' *');
  });
});

describe('rebuildBlock / docstring 缩进（AC3c / D8）', () => {
  const docstring = (translation: string, overrides: Partial<RebuildInput> = {}) =>
    rebuildBlock(
      input({
        shape: 'docstring',
        prefix: '',
        indent: '    ',
        docstring: {
          quote: '"""',
          prefix: '',
          indentWidth: 4,
          contentColumn: 7,
          closingOnOwnLine: true,
        },
        segments: [{ kind: 'prose', lines: ['    """Doc."""'], text: translation }],
        ...overrides,
      }),
    );

  it('should anchor the first line to the original indent and keep the quote', () => {
    // 单行译文 → 保持单行形态（`"""text"""`），这是 D8 的一部分：
    // 原文单行时译文不该被强行拉成多行。
    const out = docstring('文档。');
    expect(out).toEqual(['    """文档。"""']);
  });

  it('should align continuation lines to the same content column', () => {
    const out = docstring('第一行\n第二行');
    // 内容列 = 4(缩进) + 3(引号) = 7
    expect(out[1]).toBe('       第二行');
  });

  it('should close on its own line when the original did', () => {
    const out = docstring('第一行\n第二行');
    expect(out[out.length - 1]).toBe('    """');
  });

  it('should keep the docstring on one line when the translation is one line', () => {
    const out = docstring('单行。');
    expect(out).toEqual(['    """单行。"""']);
  });

  it('should re-emit the raw prefix', () => {
    const out = rebuildBlock(
      input({
        shape: 'docstring',
        prefix: '',
        indent: '    ',
        docstring: {
          quote: '"""',
          prefix: 'r',
          indentWidth: 4,
          contentColumn: 8,
          closingOnOwnLine: false,
        },
        segments: [{ kind: 'prose', lines: ['    r"""Raw."""'], text: '原始。' }],
      }),
    );
    expect(out[0]).toBe('    r"""原始。"""');
  });

  it('should keep single-quote style', () => {
    const out = rebuildBlock(
      input({
        shape: 'docstring',
        prefix: '',
        indent: '    ',
        docstring: {
          quote: "'''",
          prefix: '',
          indentWidth: 4,
          contentColumn: 7,
          closingOnOwnLine: false,
        },
        segments: [{ kind: 'prose', lines: ["    '''x'''"], text: '内容' }],
      }),
    );
    expect(out[0]).toBe("    '''内容'''");
  });
});

describe('rebuildBlock / 混合段与降级', () => {
  it('should keep fence lines exactly as they were', () => {
    const out = rebuildBlock(
      input({
        shape: 'line',
        prefix: '// ',
        segments: [
          { kind: 'prose', lines: ['Usage:'], text: '用法：' },
          {
            kind: 'fence',
            lines: ['// ```ts', '// code();', '// ```'],
            text: '```ts\ncode();\n```',
          },
        ],
      }),
    );
    expect(out).toEqual(['// 用法：', '// ```ts', '// code();', '// ```']);
  });

  it('should fall back to the original lines when a segment has no translation', () => {
    const out = rebuildBlock(
      input({
        shape: 'line',
        prefix: '// ',
        segments: [{ kind: 'prose', lines: ['// original text'], text: '' }],
      }),
    );
    expect(out).toEqual(['// original text']);
  });

  it('should return an empty list for an empty segment list', () => {
    expect(rebuildBlock(input({ segments: [] }))).toEqual([]);
  });
});

describe('rebuildBlock / docstring 无译文回退', () => {
  it('should fall back to the original docstring lines when no translation exists', () => {
    const out = rebuildBlock({
      shape: 'docstring',
      prefix: '',
      indent: '    ',
      docstring: {
        quote: '"""',
        prefix: '',
        indentWidth: 4,
        contentColumn: 7,
        closingOnOwnLine: true,
      },
      segments: [{ kind: 'prose', lines: ['    """Original."""'], text: '' }],
    });
    expect(out).toEqual(['    """Original."""']);
  });
});
