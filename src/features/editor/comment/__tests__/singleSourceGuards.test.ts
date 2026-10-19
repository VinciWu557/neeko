// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createLineLookup } from '@/features/runner';

/**
 * 复用护栏（R8.2 / R8.3）——**静态断言**，语义测试测不出来的那类回归。
 *
 * 背景：`comment/` 曾经同时存在 **3 份**行索引实现（`extractComments.createLineLookup`
 * 与 `runner/syntax/lezer.createLineLookup` 逐字节同构，`useCommentTranslation` 与
 * `classifyBlock` 又各写一份 `computeLineStarts`），`parseTranslationResponse` 也被
 * 逐字复制成 `parseTranslationArray`。
 *
 * 这类重复不会让任何用例变红 —— 副本与原件行为一致时测试全绿，只有**原件改了、
 * 副本没跟上**才出事，而那时早已没人记得有副本。所以只能用「禁止再写第二份」的
 * 源码断言把它钉住。
 */

const COMMENT_DIR = 'src/features/editor/comment';

/** `comment/` 下所有非测试的生产模块。 */
function productionModules(): Array<{ path: string; source: string }> {
  return readdirSync(COMMENT_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({
      path: `${COMMENT_DIR}/${name}`,
      source: readFileSync(`${COMMENT_DIR}/${name}`, 'utf8'),
    }));
}

describe('单一实现护栏 / 行索引（R8.3）', () => {
  it('should not define a second line-index builder anywhere in comment/', () => {
    // 判据是**函数定义**（`function xxx(`），不是「提到这个名字」：
    // 注释里说明来源是合法的。
    const offenders = productionModules()
      .filter(({ source }) =>
        /function\s+(computeLineStarts|createLineLookup|lineStartsOf)\s*\(/.test(source),
      )
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('should route extractComments through the runner facade', () => {
    const source = readFileSync(`${COMMENT_DIR}/extractComments.ts`, 'utf8');
    expect(source).toMatch(/import \{ createLineLookup \} from '@\/features\/runner';/);
  });

  it('should expose the single implementation through the runner facade', () => {
    // 门面必须导出它，否则 editor 只能深导 `runner/syntax/lezer`（被 ESLint 防火墙拦死），
    // 于是又会被迫抄第三份 —— 这正是当初重复的成因。
    expect(typeof createLineLookup).toBe('function');
    expect(createLineLookup('a\nb\nc')(2)).toBe(2);
  });
});

describe('单一实现护栏 / 译文解析（R8.2）', () => {
  it('should not hold a private copy of the JSON array parser', () => {
    const source = readFileSync(`${COMMENT_DIR}/translateSegments.ts`, 'utf8');
    // 副本的签名特征：直接调用 JSON.parse 自己实现解析
    expect(source).not.toMatch(/JSON\.parse\(/);
    expect(source).toMatch(/from '\.\.\/translation\/prompt'/);
  });
});

describe('单一实现护栏 / doc 判据来自数据表（R1.3）', () => {
  it('should not branch on the language family inside the classifier', () => {
    // R1.3：「新增语言 = 加一行数据表」。分类器里一旦出现 `family === 'go'`，
    // 新语言的 doc 语义就变成了改逻辑代码。纯行为断言抓不到这个（两种写法等价），
    // 所以只能查源。先剥离注释 —— 注释里引用这句反例是合法的。
    const code = readFileSync(`${COMMENT_DIR}/classifyBlock.ts`, 'utf8')
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
      })
      .join('\n');
    expect(code).not.toMatch(/\bfamily\s*===?\s*['"]/);
    expect(code).not.toMatch(/\bfamily\s*!==?\s*['"]/);
    // 正向：判据必须从数据表查
    expect(code).toMatch(/docRuleOf\(ctx\.family\)/);
  });
});

describe('单一实现护栏 / 测试设施不进生产模块', () => {
  it('should keep the dynamic parser loaders out of extractComments', () => {
    // 生产路径的树来自 `syntaxTree(state)`，从不从字符串现造树。
    // 7 个语言包的动态 import 若留在生产模块里，等于让零调用的测试设施常驻。
    const source = readFileSync(`${COMMENT_DIR}/extractComments.ts`, 'utf8');
    expect(source).not.toMatch(/PARSER_LOADERS/);
    expect(source).not.toMatch(/await import\('@codemirror\/lang-/);
    expect(source).not.toMatch(/export (async )?function extractFromSource/);
  });
});

describe('单一实现护栏 / 启发式与状态机分离', () => {
  it('should keep the line heuristics out of the segment state machine', () => {
    const segment = readFileSync(`${COMMENT_DIR}/segmentBlock.ts`, 'utf8');
    for (const name of [
      'looksLikeCode',
      'looksLikeSentence',
      'looksLikeDocTag',
      'looksLikeArgsField',
    ]) {
      expect(segment).not.toMatch(new RegExp(`function\\s+${name}\\s*\\(`));
    }
    // 状态机必然还要**调用**它们
    expect(segment).toMatch(/from '\.\/commentHeuristics'/);
    expect(segment).toMatch(/looksLikeCode\(/);
  });
});
