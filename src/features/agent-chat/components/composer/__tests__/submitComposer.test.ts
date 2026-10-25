// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { ComposerDocJson } from '@/shared/types/tab';

import { docToPromptText } from '../editorSchema';
import { isComposerEmpty } from '../submitComposer';

/**
 * 「内容是否为空」的**唯一判据**（`isComposerEmpty`）。
 *
 * # 为什么必须单独直测
 *
 * 它同时被两处消费：发送前校验（`submitComposer`）与发送按钮禁用
 * （`RichComposer` 的 `onEmptyChange` 投影）。两者曾经用不同判据 ——
 * 按钮用 `editor.isEmpty`（ProseMirror 语义：有文本节点就非空），发送用
 * `trim` 判空 —— 于是**只输入空格时按钮可点，点了什么都不发生**。
 *
 * 分层现实：ChatComposer 层只拿到 `onEmptyChange` 给的布尔，无法区分判据实现
 * （把实现换回 `editor.isEmpty` 那边的用例仍然绿）。所以判据的**语义**必须在
 * 这里直测 —— 这是唯一有判别力的位置。
 */

const para = (text: string): ComposerDocJson => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : undefined }],
});

const chip = (type: string, attrs: Record<string, unknown>): ComposerDocJson => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type, attrs }] }],
});

describe('isComposerEmpty', () => {
  it('should treat an empty document as empty', () => {
    expect(isComposerEmpty({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe(true);
  });

  it('should treat text as non-empty', () => {
    expect(isComposerEmpty(para('hi'))).toBe(false);
  });

  /**
   * **核心用例**：空格 / 换行 / 制表符都不算内容。
   *
   * 变异验证：把 `isComposerEmpty` 换成「文档有内容节点即非空」
   * （即 `editor.isEmpty` 的语义）→ 本用例红。
   */
  it('should treat whitespace-only text as empty', () => {
    expect(isComposerEmpty(para('   '))).toBe(true);
    expect(isComposerEmpty(para('\n\t '))).toBe(true);
  });

  /** chip 是内容：单个命令 chip（序列化为 `/name `）不能算空。 */
  it('should treat a chip as content', () => {
    expect(isComposerEmpty(chip('commandChip', { name: 'tr' }))).toBe(false);
    expect(isComposerEmpty(chip('fileChip', { path: 'a.ts', name: 'a.ts' }))).toBe(false);
  });

  /** 判据建立在序列化之上 —— 两者必须同步（同一份 `docToPromptText`）。 */
  it('should agree with the serialized prompt text', () => {
    for (const doc of [
      { type: 'doc', content: [{ type: 'paragraph' }] } as ComposerDocJson,
      para('   '),
      para('hi'),
      chip('commandChip', { name: 'tr' }),
    ]) {
      expect(isComposerEmpty(doc)).toBe(docToPromptText(doc).trim().length === 0);
    }
  });
});
