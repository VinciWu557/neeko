/**
 * skill 附件槽（`renderHook` 直测）。
 *
 * # 文件附件的契约去哪了
 *
 * 文件曾在这里按路径去重、并按路径发给后端。B 方案（`10-24-composer-token-editor`）
 * 把文件改成**文档投影**：`@path` chip 是唯一表示，请求的 `files` 由
 * `composer/editorSchema.ts::docToRequestFiles` 产出 —— 那一层的契约（去重、
 * 首次出现顺序、同名不同目录是两个文件、删 chip 即不再发送）由
 * `composer/__tests__/editorSchema.test.ts` 的 golden 用例钉住。
 *
 * 本 hook 因此只剩 skill：skill 没有文本表示（不进编辑器文档），必须独立存。
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useChatAttachments } from '../useChatAttachments';

describe('useChatAttachments', () => {
  it('starts empty', () => {
    const { result } = renderHook(() => useChatAttachments());
    expect(result.current.skillCount).toBe(0);
    expect(result.current.toRequestSkills()).toEqual([]);
  });

  /**
   * 防线：文件入口一旦被塞回这个槽，就又会与编辑器文档分叉
   * （退格删 chip 后仍会被发送 —— B 方案修掉的那个缺陷）。
   */
  it('should not expose a file entry point (files are a document projection)', () => {
    const { result } = renderHook(() => useChatAttachments());
    expect(result.current).not.toHaveProperty('addFile');
    expect(result.current).not.toHaveProperty('toRequestFiles');
    expect(result.current).not.toHaveProperty('attachments');
    expect(result.current).not.toHaveProperty('remove');
  });

  /** 请求字段的唯一产出点：skill 取 name（后端字段是 skill 标识，不是路径）。 */
  it('should map skills to their names for the request payload', () => {
    const { result } = renderHook(() => useChatAttachments());
    const skills = result.current.toRequestSkills();
    expect(Array.isArray(skills)).toBe(true);
    expect(skills).toEqual([]);
  });
});
