import { describe, expect, it } from 'vitest';

import { applySelection, filterBySubstring, findTrigger, triggerOf } from '../paletteTrigger';

describe('findTrigger', () => {
  it('should trigger slash at line start', () => {
    expect(findTrigger('/', 1)).toEqual({ kind: 'slash', index: 0, query: '' });
  });

  it('should trigger slash after whitespace', () => {
    expect(findTrigger('hi /', 4)).toEqual({ kind: 'slash', index: 3, query: '' });
  });

  it('should trigger mention at line start and accumulate the query', () => {
    expect(findTrigger('@src', 4)).toEqual({ kind: 'mention', index: 0, query: 'src' });
  });

  it('should trigger mention after whitespace', () => {
    expect(findTrigger('see @', 5)).toEqual({ kind: 'mention', index: 4, query: '' });
  });

  it('should not trigger for a slash inside a path suffix (src/foo/)', () => {
    // 变异验证：把判据改成「整段文本含 /」→ 本用例必须红
    expect(findTrigger('src/foo/', 8)).toBeNull();
  });

  it('should not trigger when the candidate is preceded by a word char (a/b)', () => {
    expect(findTrigger('a/b', 3)).toBeNull();
  });

  it('should skip an invalid slash and bind to the earlier valid trigger', () => {
    // `@src/fo`：路径段里的 `/` 不合法，继续向前扫到行首的 `@`
    expect(findTrigger('@src/fo', 7)).toEqual({ kind: 'mention', index: 0, query: 'src/fo' });
  });

  it('should stop at whitespace so the query never contains any', () => {
    expect(findTrigger('/tr ', 4)).toBeNull();
  });

  it('should trigger after a newline in multi-line input', () => {
    expect(findTrigger('line1\n/', 7)).toEqual({ kind: 'slash', index: 6, query: '' });
  });

  it('should return null for empty text or cursor at 0', () => {
    expect(findTrigger('', 0)).toBeNull();
    expect(findTrigger('/abc', 0)).toBeNull();
  });

  it('should clamp a cursor beyond the text length', () => {
    expect(findTrigger('/', 99)).toEqual({ kind: 'slash', index: 0, query: '' });
  });
});

describe('applySelection', () => {
  it('should replace only the trigger segment and keep the prefix', () => {
    // 变异验证：改成替换整段文本 → 本用例必须红（前缀被吞）
    expect(applySelection('hello /tr', 6, 9, '/trellis-continue ')).toEqual({
      text: 'hello /trellis-continue ',
      cursor: 24,
    });
  });

  it('should keep the suffix after the cursor', () => {
    expect(applySelection('a /tr b', 2, 5, '/cmd ')).toEqual({ text: 'a /cmd  b', cursor: 7 });
  });

  it('should place the cursor right after the replacement', () => {
    const applied = applySelection('@pa', 0, 3, '@src/shared/utils/fileRef.ts ');
    expect(applied.cursor).toBe(applied.text.length);
  });
});

describe('filterBySubstring', () => {
  const items = [
    { value: 'trellis-continue' },
    { value: 'trellis-start' },
    { value: 'vision-handoff' },
  ];

  it('should return the first N items for an empty query (bounded)', () => {
    // 变异验证：去掉 limit → 本用例必须红
    const many = Array.from({ length: 157 }, (_, i) => ({ value: `cmd-${i}` }));
    expect(filterBySubstring(many, '', (x) => x.value, 50)).toHaveLength(50);
  });

  it('should filter case-insensitively by substring', () => {
    expect(filterBySubstring(items, 'TRELLIS', (x) => x.value, 50)).toHaveLength(2);
    expect(filterBySubstring(items, 'hand', (x) => x.value, 50)).toEqual([
      { value: 'vision-handoff' },
    ]);
  });

  it('should apply the limit to matches, not the source', () => {
    expect(filterBySubstring(items, 'trellis', (x) => x.value, 1)).toHaveLength(1);
  });

  it('should return an empty list when nothing matches', () => {
    expect(filterBySubstring(items, 'zzz', (x) => x.value, 50)).toEqual([]);
  });
});

describe('triggerOf', () => {
  it('should map kinds to their trigger chars', () => {
    expect(triggerOf('slash')).toBe('/');
    expect(triggerOf('mention')).toBe('@');
  });
});
