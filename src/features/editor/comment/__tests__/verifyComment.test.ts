// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { DEFAULT_COMMENT_RULES, verifyComment } from '../verifyComment';

/**
 * AC4 / AC5 / AC8 / AC9：注释译文的**后置条件校验**。
 *
 * 注释的失效模式与文档不同：不是「排版难看」，而是**破语义** ——
 * 占位符丢了程序会崩、doc 标签名被翻 IDE 跳转失效、代码被回吐会误导读者照抄。
 */
const verify = (source: string, translation: string, extra?: Parameters<typeof verifyComment>[0]) =>
  verifyComment({ source, translation, ...extra });

describe('verifyComment / AC4 占位符必须存活', () => {
  const cases: Array<[string, string, string]> = [
    ['format {0}', '格式化 0', '{0}'],
    ['format {name}', '格式化 name', '{name}'],
    ['see %s', '见 s', '%s'],
    ['count %d', '计数 d', '%d'],
    ['order %1$s', '顺序 1$s', '%1$s'],
    ['value ${x}', '值 x', '${x}'],
    ['tpl {{user}}', '模板 user', '{{user}}'],
  ];

  for (const [source, translation, token] of cases) {
    it(`should reject when ${token} is lost`, () => {
      const verdict = verify(source, translation);
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toContain('placeholder');
    });
  }

  it('should accept when all placeholders survive', () => {
    expect(verify('format {0} and %s', '格式化 {0} 与 %s').ok).toBe(true);
  });

  it('should accept when placeholders are reordered (order is not semantic)', () => {
    expect(verify('{0} then %s', '%s 然后 {0}').ok).toBe(true);
  });

  it('should reject when an extra placeholder is invented', () => {
    const verdict = verify('format {0}', '格式化 {0} 和 {1}');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('placeholder');
  });

  it('should report which placeholder was lost', () => {
    const verdict = verify('format {0} and {1}', '格式化 {0}');
    expect(verdict.reason).toContain('{1}');
  });
});

describe('verifyComment / AC5 doc 标签与名字必须存活', () => {
  it('should reject when the @param tag name is translated away', () => {
    const verdict = verify('@param sessionId the session', '@参数 sessionId 会话');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('@param');
  });

  it('should reject when the parameter name is translated', () => {
    const verdict = verify('@param sessionId the session', '@param 会话标识 会话');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('sessionId');
  });

  it('should accept when tag and name survive and only the description is translated', () => {
    expect(verify('@param sessionId the session', '@param sessionId 会话标识').ok).toBe(true);
  });

  it('should handle @returns and @throws', () => {
    expect(verify('@returns the id', '@returns 标识').ok).toBe(true);
    expect(verify('@returns the id', '@return 标识').ok).toBe(false);
    expect(verify('@throws Error when bad', '@throws Error 当出错时').ok).toBe(true);
  });

  it('should handle python style :param x:', () => {
    expect(verify(':param x: the value', ':param x: 值').ok).toBe(true);
    expect(verify(':param x: the value', ':param 值').ok).toBe(false);
  });

  it('should handle Args: field names', () => {
    const source = 'Args:\n    count: how many';
    expect(verify(source, 'Args:\n    count: 多少个').ok).toBe(true);
    expect(verify(source, 'Args:\n    数量: 多少个').ok).toBe(false);
  });
});

describe('verifyComment / AC8 行内代码跨度逐字保留', () => {
  it('should accept when code spans survive', () => {
    expect(verify('see `cacheKey` here', '见 `cacheKey`').ok).toBe(true);
  });

  it('should reject when a code span is translated', () => {
    const verdict = verify('see `cacheKey` here', '见 `缓存键`');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('code span');
  });

  it('should reject when a code span is dropped', () => {
    expect(verify('see `cacheKey` here', '见这里').ok).toBe(false);
  });

  it('should accept reordered code spans (multiset semantics)', () => {
    expect(verify('`a` and `b`', '`b` 和 `a`').ok).toBe(true);
  });
});

describe('verifyComment / URL 必须存活', () => {
  it('should accept when the URL survives', () => {
    expect(verify('see https://example.com/x for details', '见 https://example.com/x').ok).toBe(
      true,
    );
  });

  it('should reject when the URL is altered', () => {
    const verdict = verify('see https://example.com/x', '见 https://example.com/y');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('url');
  });
});

describe('verifyComment / AC9 禁止回吐代码', () => {
  it('should reject when the translation echoes a fence body', () => {
    const verdict = verify('Usage: run it', '用法：cache.set(k, v);', {
      forbiddenTexts: ['cache.set(k, v);'],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('code');
  });

  it('should reject when the translation echoes a code segment', () => {
    const verdict = verify('Replace the call:', '替换 调用：const raw = await legacyFetch(x);', {
      forbiddenTexts: ['const raw = await legacyFetch(x);'],
    });
    expect(verdict.ok).toBe(false);
  });

  it('should accept when no forbidden text appears', () => {
    expect(
      verify('Replace the call:', '替换旧调用。', { forbiddenTexts: ['legacyFetch(x)'] }).ok,
    ).toBe(true);
  });

  it('should ignore empty forbidden entries', () => {
    expect(verify('anything', '任何内容', { forbiddenTexts: ['', '   '] }).ok).toBe(true);
  });
});

describe('verifyComment / 通用规则', () => {
  it('should reject an empty translation', () => {
    expect(verify('some text', '').ok).toBe(false);
    expect(verify('some text', '   \n ').ok).toBe(false);
  });

  it('should reject a model refusal', () => {
    expect(verify('some text', 'Sorry, I cannot translate this.').ok).toBe(false);
    expect(verify('some text', '抱歉，无法翻译').ok).toBe(false);
  });

  it('should reject a suspiciously short translation of a long source', () => {
    const source = 'This is a fairly long comment explaining the whole flow in detail';
    expect(verify(source, '好').ok).toBe(false);
  });

  it('should not flag a short source as truncated', () => {
    expect(verify('ok', '好').ok).toBe(true);
  });

  it('should reject a translation that merely echoes the source', () => {
    const source = 'returns the cached value';
    const verdict = verify(source, source);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('unchanged');
  });

  it('should degrade to a failure (not throw) when a rule throws', () => {
    const verdict = verifyComment({
      source: 'x',
      translation: 'y',
      rules: [
        () => {
          throw new Error('boom');
        },
      ],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('boom');
  });

  it('should let a custom rule run (open/closed for AC17)', () => {
    const verdict = verifyComment({
      source: 'x',
      translation: 'y',
      rules: [() => ({ ok: false, reason: 'custom rejection' })],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('custom rejection');
  });

  it('should expose a default rule list that is non-empty and extensible', () => {
    expect(DEFAULT_COMMENT_RULES.length).toBeGreaterThan(3);
    expect(Array.isArray(DEFAULT_COMMENT_RULES)).toBe(true);
  });
});
