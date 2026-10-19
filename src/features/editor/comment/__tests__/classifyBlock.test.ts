// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createLineStarts } from '@/features/runner';

import { classifyBlock, createDeclIndex, type BlockKind } from '../classifyBlock';
import { docRuleOf, type LanguageFamily } from '../commentSyntax';
import { groupComments, type CommentGroup } from '../groupComments';

import { extractFromSource } from './commentTestParsers';

/**
 * AC10 / AC11：组级分类是**翻译前的硬门禁**。
 *
 * 不对称原则（design.md D2）：
 * - `shebang` / `directive` / `license` 判**宽**（宁可多跳过）—— 翻了会静默破坏工具链/法律文本
 * - 判不出就落 `prose`（仍会翻译）
 */
async function groupsOf(family: LanguageFamily, source: string): Promise<CommentGroup[]> {
  const units = await extractFromSource({ family, source });
  return groupComments(units, { source, family });
}

async function kindsOf(family: LanguageFamily, source: string): Promise<BlockKind[]> {
  const groups = await groupsOf(family, source);
  // Go 的 doc 判定需要语法树（D7-Go：结构 + 行距双条件），其余家族不需要。
  const tree = family === 'go' ? await parseTree('go', source) : null;
  return groups.map((g) => classifyBlock(g, { source, family, tree }).kind);
}

/** 取语法树（Go doc 判定用）。与生产同源：经 `@codemirror/lang-*` 取 parser。 */
async function parseTree(family: 'go', source: string) {
  const { goLanguage } = await import('@codemirror/lang-go');
  void family;
  return goLanguage.parser.parse(source) as unknown as {
    topNode: import('../extractComments').TreeNode;
  };
}

describe('classifyBlock / shebang', () => {
  it('should classify a leading #! line as shebang', async () => {
    expect(await kindsOf('stream', '#!/usr/bin/env bash\necho hi\n')).toEqual(['shebang']);
  });

  it('should not classify a python comment as shebang just because it starts with #', async () => {
    expect(await kindsOf('python', '# a normal comment\nx = 1\n')).toEqual(['prose']);
  });

  it('should classify shebang only when it is the first line of the file', async () => {
    // 文件中部出现 `#!` 不是解释器指令（可能是注释里的示例）
    expect(await kindsOf('stream', 'key: value\n#!/bin/sh\n')).toEqual(['prose']);
  });
});

describe('classifyBlock / directive（AC11 工具链指令零改写）', () => {
  const directives = [
    '// eslint-disable-next-line no-restricted-imports',
    '// eslint-disable',
    '// prettier-ignore',
    '// @ts-ignore',
    '// @ts-expect-error',
    '// @ts-nocheck',
    '// biome-ignore lint/suspicious/noExplicitAny: reason',
    '// oxlint-disable-next-line',
  ];

  for (const directive of directives) {
    it(`should classify as directive: ${directive.slice(0, 40)}`, async () => {
      expect(await kindsOf('ts', `${directive}\nconst a = 1;\n`)).toEqual(['directive']);
    });
  }

  it('should classify python type-ignore and noqa as directive', async () => {
    expect(await kindsOf('python', '# type: ignore\nx = 1\n')).toEqual(['directive']);
    expect(await kindsOf('python', '# noqa: E501\nx = 1\n')).toEqual(['directive']);
    expect(await kindsOf('python', '# noqa\nx = 1\n')).toEqual(['directive']);
    expect(await kindsOf('python', '# pylint: disable=unused-argument\nx = 1\n')).toEqual([
      'directive',
    ]);
  });

  it('should classify go build constraints as directive', async () => {
    expect(await kindsOf('go', '//go:build linux\npackage m\n')).toEqual(['directive']);
    expect(await kindsOf('go', '// +build linux\npackage m\n')).toEqual(['directive']);
    expect(await kindsOf('go', '//nolint:errcheck\npackage m\n')).toEqual(['directive']);
  });

  it('should classify java/c pragma and suppressions as directive', async () => {
    expect(await kindsOf('java', '//noinspection unchecked\nclass A {}\n')).toEqual(['directive']);
    expect(await kindsOf('ts', '//#region setup\nconst a = 1;\n')).toEqual(['directive']);
  });

  it('should classify a directive appearing on ANY line of the group as directive', async () => {
    // 判宽：组内任一行命中指令即整组跳过（翻译一半指令没有意义）
    const source = '// Setup the client.\n// eslint-disable-next-line\nconst a = 1;\n';
    expect(await kindsOf('ts', source)).toEqual(['directive']);
  });

  it('should not classify ordinary prose that merely mentions eslint', async () => {
    // 反向护栏：避免「提到 lint 就跳过」把正常文档吞掉
    expect(await kindsOf('ts', '// This file is checked by eslint in CI.\nconst a = 1;\n')).toEqual(
      ['prose'],
    );
  });
});

describe('classifyBlock / license', () => {
  it('should classify a copyright header at the top of the file as license', async () => {
    expect(await kindsOf('ts', '// Copyright 2026 Neeko\nconst a = 1;\n')).toEqual(['license']);
  });

  it('should classify SPDX identifiers as license', async () => {
    expect(await kindsOf('ts', '// SPDX-License-Identifier: Apache-2.0\nconst a = 1;\n')).toEqual([
      'license',
    ]);
  });

  it('should classify "Licensed under" and "All rights reserved" as license', async () => {
    expect(await kindsOf('ts', '// Licensed under the Apache License, Version 2.0\n')).toEqual([
      'license',
    ]);
    expect(await kindsOf('ts', '// All rights reserved.\n')).toEqual(['license']);
  });

  it('should NOT classify the same text as license when it appears deep in the file', async () => {
    // 位置语义：license 只在文件头窗口判。深处出现同样文本是引用/说明，应翻译。
    const filler = Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`).join('\n');
    const source = `${filler}\n// Copyright 2026 Neeko\n`;
    expect(await kindsOf('ts', source)).toEqual(['prose']);
  });

  it('should classify a multi-line license block as license', async () => {
    const source =
      '/**\n * Copyright 2026 Neeko\n * SPDX-License-Identifier: Apache-2.0\n */\nconst a = 1;\n';
    expect(await kindsOf('ts', source)).toEqual(['license']);
  });
});

describe('classifyBlock / doc（AC3）', () => {
  it('should classify a JSDoc block as doc', async () => {
    expect(await kindsOf('ts', '/**\n * Translate.\n */\nfunction f() {}\n')).toEqual(['doc']);
  });

  it('should classify rust /// and //! as doc', async () => {
    expect(await kindsOf('rust', '/// Doc line\nfn f() {}\n')).toEqual(['doc']);
    expect(await kindsOf('rust', '//! Inner doc\nfn f() {}\n')).toEqual(['doc']);
  });

  it('should classify javadoc as doc', async () => {
    expect(await kindsOf('java', '/**\n * Javadoc.\n */\nclass A {}\n')).toEqual(['doc']);
  });

  it('should classify a python docstring group as doc', async () => {
    expect(await kindsOf('python', 'def f():\n    """Doc."""\n    return 1\n')).toEqual(['doc']);
  });

  it('should classify a plain rust // comment as prose, not doc', async () => {
    expect(await kindsOf('rust', '// plain note\nfn f() {}\n')).toEqual(['prose']);
  });
});

describe('classifyBlock / Go doc 双条件（AC3a / D7-Go）', () => {
  it('should classify as doc when the comment is immediately above a declaration', async () => {
    expect(await kindsOf('go', '// Doc for A.\nfunc A() {}\n')).toEqual(['doc']);
  });

  it('should still classify as doc when exactly ONE blank line separates them', async () => {
    expect(await kindsOf('go', '// Doc for A.\n\nfunc A() {}\n')).toEqual(['doc']);
  });

  it('should classify as prose when TWO OR MORE blank lines separate them', async () => {
    // 实测：结构上 nextSibling 仍连着声明，所以只靠结构判定会误判 —— 必须叠加行距
    expect(await kindsOf('go', '// Floating note.\n\n\nfunc A() {}\n')).toEqual(['prose']);
  });

  it('should classify as prose when no declaration follows', async () => {
    expect(await kindsOf('go', '// Just a note at end of file\n')).toEqual(['prose']);
  });

  it('should classify as doc for var/const/type declarations too', async () => {
    expect(await kindsOf('go', '// Doc for X.\nvar X = 1\n')).toEqual(['doc']);
    expect(await kindsOf('go', '// Doc for C.\nconst C = 1\n')).toEqual(['doc']);
    expect(await kindsOf('go', '// Doc for T.\ntype T struct{}\n')).toEqual(['doc']);
  });

  it('should classify as doc for a package clause', async () => {
    expect(await kindsOf('go', '// Package m does things.\npackage m\n')).toEqual(['doc']);
  });
});

describe('classifyBlock / 优先级与交互', () => {
  it('should prefer directive over doc when both signals are present', async () => {
    // 指令是硬门禁，优先级最高（翻译指令 = 静默破坏工具链）。
    // 用 `/** */`（真 doc 标记）内嵌指令，才能同时触发 doc 与 directive 两个信号 ——
    // 用 `///` 构造不成立：TS 的 `///` 不是 doc 标记，`isDocByMarkup` 不会为真，
    // 该用例就测不到优先级（假绿）。
    const source = '/**\n * @ts-expect-error because reasons\n */\nconst a = 1;\n';
    expect(await kindsOf('ts', source)).toEqual(['directive']);
  });

  it('should prefer shebang over everything', async () => {
    expect(await kindsOf('stream', '#!/bin/sh\n')).toEqual(['shebang']);
  });

  it('should classify a block with no text (empty comment) as prose and mark it skippable', async () => {
    const groups = await groupsOf('ts', '//\nconst a = 1;\n');
    const verdict = classifyBlock(groups[0], { source: '//\nconst a = 1;\n', family: 'ts' });
    expect(verdict.kind).toBe('prose');
    // 空注释没有可翻译内容 → 不送模型
    expect(verdict.translatable).toBe(false);
  });

  it('should mark skipped kinds as not translatable and expose a readable reason', async () => {
    const source = '// eslint-disable-next-line\nconst a = 1;\n';
    const [group] = await groupsOf('ts', source);
    const verdict = classifyBlock(group, { source, family: 'ts' });

    expect(verdict.kind).toBe('directive');
    expect(verdict.translatable).toBe(false);
    expect(verdict.reason).toBeTruthy();
    expect(verdict.reason).not.toMatch(/undefined/);
  });

  it('should expose a reason for every non-translatable kind', async () => {
    const cases: Array<[LanguageFamily, string, BlockKind]> = [
      ['stream', '#!/bin/sh\n', 'shebang'],
      ['ts', '// eslint-disable\nconst a = 1;\n', 'directive'],
      ['ts', '// Copyright 2026 X\nconst a = 1;\n', 'license'],
    ];
    for (const [family, source, expected] of cases) {
      const [group] = await groupsOf(family, source);
      const verdict = classifyBlock(group, { source, family });
      expect(verdict.kind).toBe(expected);
      expect(verdict.translatable).toBe(false);
      expect(typeof verdict.reason).toBe('string');
      expect((verdict.reason ?? '').length).toBeGreaterThan(0);
    }
  });

  it('should mark doc and prose as translatable', async () => {
    for (const [family, source] of [
      ['ts', '/**\n * Doc.\n */\nfunction f() {}\n'],
      ['ts', '// plain\nconst a = 1;\n'],
    ] as Array<[LanguageFamily, string]>) {
      const [group] = await groupsOf(family, source);
      const verdict = classifyBlock(group, { source, family });
      expect(verdict.translatable).toBe(true);
    }
  });
});

describe('classifyBlock / 预建索引（ctx）的语义等价', () => {
  /**
   * `classifyBlock` 支持两条路径：调用方传预建索引（生产路径，性能）或让它现建
   * （纯函数测试的便捷路径）。两条路径**必须同结论** —— 否则生产的快路径会静默改变行为。
   */
  it('should reach the same verdict with and without prebuilt indexes (go doc)', async () => {
    const cases = [
      '// Doc for A.\nfunc A() {}\n',
      '// Doc for A.\n\nfunc A() {}\n',
      '// Floating note.\n\n\nfunc A() {}\n',
      '// Package m does things.\npackage m\n',
      '// Just a note at end of file\n',
    ];
    for (const source of cases) {
      const tree = await parseTree('go', source);
      const groups = await groupsOf('go', source);
      const prebuilt = {
        source,
        family: 'go' as const,
        tree,
        lineStarts: createLineStarts(source),
        declIndex: createDeclIndex(tree),
      };
      expect(groups.map((g) => classifyBlock(g, prebuilt).kind)).toEqual(
        groups.map((g) => classifyBlock(g, { source, family: 'go', tree }).kind),
      );
    }
  });

  it('should use only the FIRST named node after the group as the candidate declaration', async () => {
    // `package m`：`PackageClause(26,35)` 与其关键字子节点 `package(26,33)` 同起点。
    // 索引排序必须是 (from 升序, to 降序) —— 让外层节点排在前，否则二分命中关键字、
    // doc 判定全面失效（这是首版用 to 升序的真实回归）。
    const source = '// Package m does things.\npackage m\n';
    const tree = await parseTree('go', source);
    const index = createDeclIndex(tree);
    expect(index).not.toBeNull();
    const first = index!.nodes.find((node) => node.from >= 25);
    expect(first?.type.name).toBe('PackageClause');
  });
});

describe('classifyBlock / docRule 是数据表（R1.3）', () => {
  it('should declare the doc rule per family in the syntax table, not in the classifier', () => {
    // 分类器里禁止出现 `family === 'go'`：判据必须能通过数据表查出来。
    expect(docRuleOf('go')).toBe('structural');
    for (const family of ['ts', 'rust', 'java', 'python', 'css', 'stream'] as const) {
      expect(docRuleOf(family)).toBe('markup');
    }
    expect(docRuleOf('unknown')).toBeNull();
  });

  it('should classify a structural-doc family without the group carrying any doc marker', async () => {
    // 反向护栏：Go 的 `//` 不是 doc 标记，`isDocByMarkup` 为 false —— 全靠 docRule='structural'。
    const source = '// Doc for A.\nfunc A() {}\n';
    const [group] = await groupsOf('go', source);
    expect(group.units.some((unit) => unit.isDoc)).toBe(false);
    expect(classifyBlock(group, { source, family: 'go', tree: null }).kind).toBe('prose');
  });

  it('should not apply the structural rule to markup families even with a tree', async () => {
    // 同样的「注释紧邻声明」在 TS 里不构成 doc（TS 的 doc 只认 `/** */`）
    const source = '// plain note\nfunction f() {}\n';
    const groups = await groupsOf('ts', source);
    expect(groups.map((g) => classifyBlock(g, { source, family: 'ts' }).kind)).toEqual(['prose']);
  });
});

describe('classifyBlock / 预建声明索引必须被复用（O(n²) 回归护栏）', () => {
  it('should never touch the tree when a prebuilt decl index is supplied', async () => {
    // 缺陷：首版每组都对全树 DFS 找「下一兄弟声明」→ 实测 400 组 22.1ms、1600 组 215.6ms。
    // 判据不看墙钟：给一个「一旦被访问就抛」的树 —— 只要分类器忽略了 ctx.declIndex
    // 而去重建索引，它就必然访问 `tree.topNode` 并当场暴露。
    const source = '// Doc for A.\nfunc A() {}\n';
    const group: CommentGroup = {
      shape: 'line',
      startLine: 1,
      endLine: 1,
      indent: '',
      lines: [{ body: 'Doc for A.', raw: '// Doc for A.', unitIndex: 0, isTrailing: false }],
      units: [],
    };
    const poisonTree = {
      get topNode(): never {
        throw new Error('decl index was rebuilt: the prebuilt index was ignored');
      },
    } as unknown as never;
    const declIndex = createDeclIndex(await parseTree('go', source));
    const lineStarts = createLineStarts(source);

    const verdict = classifyBlock(group, {
      source,
      family: 'go',
      tree: poisonTree,
      lineStarts,
      declIndex,
    });
    expect(verdict.kind).toBe('doc');
  });
});
