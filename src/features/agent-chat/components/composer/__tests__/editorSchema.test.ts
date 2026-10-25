// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { ComposerDocJson } from '@/shared/types/tab';

import { docToPromptText, docToRequestFiles, plainTextToDoc } from '../editorSchema';

const text = (t: string) => ({ type: 'text', text: t });
const command = (name: string) => ({
  type: 'commandChip',
  attrs: { name, source: 'prompt' },
});
const file = (path: string, name = path) => ({
  type: 'fileChip',
  attrs: { path, name },
});
const para = (...content: unknown[]): ComposerDocJson => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: content as ComposerDocJson['content'] }],
});

describe('docToPromptText — 序列化契约（R2 golden）', () => {
  it('纯文本透传', () => {
    expect(docToPromptText(para(text('hello world')))).toBe('hello world');
  });

  it('chip 与文本混排：chip 序列化自带尾随空格，与相邻文本自然分隔', () => {
    expect(docToPromptText(para(text('run '), command('tr'), text('now')))).toBe('run /tr now');
  });

  it('chip 后紧跟文本（无空格）：尾随空格补上分隔', () => {
    expect(docToPromptText(para(command('tr'), text('now')))).toBe('/tr now');
  });

  it('chip 相邻：各贡献一段 `/name `', () => {
    expect(docToPromptText(para(command('a'), command('b')))).toBe('/a /b ');
  });

  it('chip 在文档末尾仍保留尾随空格（pi 展开依赖该形状）', () => {
    expect(docToPromptText(para(text('run '), command('tr')))).toBe('run /tr ');
    expect(docToPromptText(para(file('src/foo.ts')))).toBe('@src/foo.ts ');
  });

  it('文件 chip 输出 `@path `（path 为准，name 不参与序列化）', () => {
    expect(docToPromptText(para(file('src/工具.ts', '工具.ts')))).toBe('@src/工具.ts ');
  });

  it('CJK 文本与含路径分隔符的文件 chip', () => {
    expect(docToPromptText(para(text('查看 '), file('src/features/agent-chat/index.ts')))).toBe(
      '查看 @src/features/agent-chat/index.ts ',
    );
  });

  it('多段落以换行连接；hardBreak 也是换行', () => {
    const doc: ComposerDocJson = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [text('第一行')] },
        { type: 'paragraph', content: [text('第'), { type: 'hardBreak' }, text('二行')] },
      ],
    };
    expect(docToPromptText(doc)).toBe('第一行\n第\n二行');
  });

  it('空文档 / 缺 content / null 都序列化为空串', () => {
    expect(docToPromptText({ type: 'doc' })).toBe('');
    expect(docToPromptText({ type: 'doc', content: [] })).toBe('');
    expect(docToPromptText(null)).toBe('');
    expect(docToPromptText(undefined)).toBe('');
  });

  it('attrs 缺失的 chip 不产出悬空的触发符', () => {
    const doc: ComposerDocJson = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'commandChip', attrs: {} }] }],
    };
    expect(docToPromptText(doc)).toBe('');
  });
});

describe('plainTextToDoc — 旧纯文本草稿迁移', () => {
  it('单行文本恢复为单段落', () => {
    expect(docToPromptText(plainTextToDoc('hello'))).toBe('hello');
  });

  it('多行文本按换行拆成段落，往返等价', () => {
    expect(docToPromptText(plainTextToDoc('a\nb\nc'))).toBe('a\nb\nc');
  });

  it('空串恢复为空文档（不发 HTML 解析，文本中的 <b> 不当标签）', () => {
    const doc = plainTextToDoc('<b>not html</b>');
    expect(docToPromptText(doc)).toBe('<b>not html</b>');
  });
});

/**
 * `files` 请求字段的契约（B 方案）：它是**文档的投影**，不是另存的附件列表。
 *
 * 这一组替换了旧 `useChatAttachments` 里的「文件按路径去重 / 传给后端的是路径」
 * 两条钉子 —— 文件不再有独立 state，那两条不变量现在只在这里成立。
 */
describe('docToRequestFiles — files 是文档的投影', () => {
  const chip = (path: string) => ({ type: 'fileChip' as const, attrs: { path, name: path } });
  const doc = (...nodes: unknown[]) => ({ type: 'doc', content: nodes }) as never;

  it('should collect file chip paths in document order', () => {
    expect(
      docToRequestFiles(doc({ type: 'paragraph', content: [chip('src/a.ts'), chip('src/b.ts')] })),
    ).toEqual(['src/a.ts', 'src/b.ts']);
  });

  /** 同名不同目录是两个文件（路径才是身份）。 */
  it('should treat same-named files in different directories as distinct', () => {
    expect(
      docToRequestFiles(
        doc({ type: 'paragraph', content: [chip('src/a/types.ts'), chip('src/b/types.ts')] }),
      ),
    ).toEqual(['src/a/types.ts', 'src/b/types.ts']);
  });

  /** 同一路径重复提及只发一次（首现顺序），而不是产生重复项。 */
  it('should de-duplicate repeated mentions preserving first occurrence', () => {
    expect(
      docToRequestFiles(
        doc({ type: 'paragraph', content: [chip('b.ts'), chip('a.ts'), chip('b.ts')] }),
      ),
    ).toEqual(['b.ts', 'a.ts']);
  });

  /**
   * **删掉 chip 就不再发送该文件** —— B 方案要消灭的那个缺陷
   * （旧实现里附件存活在另一份 state，退格删 chip 后仍会发出）。
   */
  it('should drop a file once its chip is gone from the document', () => {
    const withTwo = docToRequestFiles(
      doc({ type: 'paragraph', content: [chip('a.ts'), chip('b.ts')] }),
    );
    const withOne = docToRequestFiles(doc({ type: 'paragraph', content: [chip('a.ts')] }));
    expect(withTwo).toEqual(['a.ts', 'b.ts']);
    expect(withOne).toEqual(['a.ts']);
  });

  it('should return an empty list for plain text and empty documents', () => {
    expect(
      docToRequestFiles(doc({ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] })),
    ).toEqual([]);
    expect(docToRequestFiles(doc())).toEqual([]);
    expect(docToRequestFiles(null)).toEqual([]);
  });
});
