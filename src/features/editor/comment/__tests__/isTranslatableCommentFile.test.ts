// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { isTranslatableCommentFile } from '../isTranslatableCommentFile';

/**
 * 入口显示判据。
 *
 * 为什么必须判：`extractComments` 对 unknown 家族**静默返回空**。若入口不判，
 * 用户点了「翻译注释」什么都不会发生 —— 静默失败比不显示按钮更糟。
 */
describe('isTranslatableCommentFile', () => {
  it('should accept languages whose family has comment node names', () => {
    const accepted = ['a.ts', 'a.tsx', 'a.js', 'a.rs', 'a.go', 'a.java', 'a.py', 'a.css'].filter(
      (path) => !isTranslatableCommentFile(path),
    );
    // 列出**未通过**的路径（比逐个断言更易诊断）
    expect(accepted).toEqual([]);
  });

  it('should accept legacy-modes languages (yaml / shell)', () => {
    expect(isTranslatableCommentFile('a.yaml')).toBe(true);
    expect(isTranslatableCommentFile('a.sh')).toBe(true);
  });

  it('should reject markdown / json / unknown extensions', () => {
    // markdown 与 json 没有「注释」概念（那是文档翻译的领域）
    const wronglyAccepted = ['a.md', 'a.json', 'a.txt', 'README', 'a.unknownext'].filter((path) =>
      isTranslatableCommentFile(path),
    );
    expect(wronglyAccepted).toEqual([]);
  });

  it('should agree with detectFamily (single source, no second extension table)', () => {
    expect(isTranslatableCommentFile('a.ts')).toBe(true);
    expect(isTranslatableCommentFile('a.weird')).toBe(false);
  });
});
