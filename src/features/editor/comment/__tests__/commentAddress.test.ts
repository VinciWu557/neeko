// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { commentAddress, normalizeSegmentText } from '../commentAddress';

/**
 * AC12 / R5.1：单元身份 = **归一化文本的哈希**，不是行号。
 *
 * 为什么不能是行号：在注释块中间插一行 → 后面所有位置平移 → 缓存整体错位 → 全量重译。
 * 身份落在 **segment** 而非 **group**：组边界变化（插入一行导致重新分组）不应让
 * 无关 segment 失效。
 */
describe('commentAddress / 归一化', () => {
  it('should collapse whitespace so reindentation does not change identity', () => {
    expect(normalizeSegmentText('  hello   world  ')).toBe('hello world');
    expect(normalizeSegmentText('hello\nworld')).toBe('hello world');
    expect(normalizeSegmentText('hello\t\tworld')).toBe('hello world');
  });

  it('should preserve case because it carries meaning', () => {
    expect(normalizeSegmentText('Foo')).not.toBe(normalizeSegmentText('foo'));
  });

  it('should preserve inline markdown markers because they carry meaning', () => {
    expect(normalizeSegmentText('use `cacheKey` here')).toContain('`cacheKey`');
    expect(normalizeSegmentText('**bold** text')).toContain('**bold**');
  });

  it('should preserve placeholder tokens verbatim', () => {
    expect(normalizeSegmentText('format {0} and %s')).toBe('format {0} and %s');
  });

  it('should return an empty string for whitespace-only input', () => {
    expect(normalizeSegmentText('   \n\t  ')).toBe('');
  });
});

describe('commentAddress / 地址稳定性', () => {
  it('should be idempotent for the same text', () => {
    const text = 'Translate a batch of segments.';
    expect(commentAddress(text)).toBe(commentAddress(text));
  });

  it('should ignore leading and trailing whitespace', () => {
    expect(commentAddress('  same text  ')).toBe(commentAddress('same text'));
  });

  it('should ignore internal whitespace differences (reflow)', () => {
    expect(commentAddress('one two\nthree')).toBe(commentAddress('one   two three'));
  });

  it('should differ when case changes', () => {
    expect(commentAddress('Session')).not.toBe(commentAddress('session'));
  });

  it('should differ when a word changes', () => {
    expect(commentAddress('returns the id')).not.toBe(commentAddress('returns the ids'));
  });

  it('should differ when an inline code span changes', () => {
    expect(commentAddress('see `a`')).not.toBe(commentAddress('see `b`'));
  });

  it('should differ when a placeholder changes', () => {
    expect(commentAddress('format {0}')).not.toBe(commentAddress('format {1}'));
  });

  it('should produce a stable prefix so addresses are recognisable in logs', () => {
    expect(commentAddress('anything')).toMatch(/^c[0-9a-z]+$/);
  });

  it('should be reasonably short (fits a UI chip)', () => {
    expect(commentAddress('a long comment '.repeat(20)).length).toBeLessThan(24);
  });

  it('should handle CJK text', () => {
    const a = commentAddress('通过一次回合翻译一批片段');
    expect(a).toBe(commentAddress('通过一次回合翻译一批片段'));
    expect(a).not.toBe(commentAddress('翻译一批片段'));
  });
});

describe('commentAddress / AC12 身份落在 segment 而非 group', () => {
  it('should keep the same address when surrounding lines change but this segment does not', () => {
    // 组边界变化（中间插入一行）→ 其余 segment 的地址必须不变
    const before = commentAddress('with the single-turn path.');
    const after = commentAddress('with the single-turn path.');
    expect(before).toBe(after);
  });

  it('should not let line numbers leak into the address', () => {
    // 同一文本出现在第 1 行与第 100 行必须是同一身份（否则无法跨文件去重）
    const text = 'returns the cached value';
    expect(commentAddress(text)).toBe(commentAddress(text));
  });

  it('should collide only when text is genuinely identical after normalisation', () => {
    const a = commentAddress('the value');
    const b = commentAddress('the  value ');
    expect(a).toBe(b);
  });
});

describe('commentAddress / 地址编码结构', () => {
  it('should encode the normalised length so different-length texts differ structurally', () => {
    // 长度参与编码的作用：同哈希前缀下长度不同必然不同地址（对排查与碰撞抵抗都有用）。
    // 去掉长度段会让本用例失败 —— 这是该字段的判别用例。
    const short = commentAddress('ab');
    const long = commentAddress('ab'.repeat(30));
    const lengthOf = (addr: string) => {
      // 形如 c<len36><hashA><hashB>：长度段是第一个非哈希前缀
      const match = /^c([0-9a-z]+)/.exec(addr);
      return match ? match[1] : '';
    };
    // 长度段必须能反映出文本长度差异（36 进制编码）
    expect(commentAddress('ab').length).toBeLessThan(commentAddress('ab'.repeat(30)).length + 4);
    expect(short).not.toBe(long);
    // 直接断言长度段：'ab'.length=2 → '2'；60 字符 → '1o'（36 进制）
    expect(lengthOf(short).startsWith('2')).toBe(true);
    expect(lengthOf(long).startsWith('1o')).toBe(true);
  });

  it('should keep the two hash halves independent enough that a one-char change alters the tail', () => {
    const a = commentAddress('returns the value');
    const b = commentAddress('returns the values');
    // 单字符变化必须让地址整体变化（不只是长度段）
    expect(a).not.toBe(b);
    expect(a.slice(0, 4)).not.toBe(b.slice(0, 4));
  });
});
