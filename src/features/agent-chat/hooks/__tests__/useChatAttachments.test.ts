/**
 * 附件状态的关键行为（`renderHook` 直测）。
 *
 * 两个真缺陷的钉子：
 * 1. **去重身份必须是路径**：`a/types.ts` 与 `b/types.ts` 是两个不同的文件，
 *    按 `name` 去重会让第二个被静默吞掉。
 * 2. **发给后端必须是路径**：`ContextManifest.files` 的契约是「file paths」，
 *    传 `name` 后端无法定位（同名不同目录时更糟 —— 会解析到错误的那一个）。
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useChatAttachments } from '../useChatAttachments';

describe('useChatAttachments', () => {
  it('adds a file keyed by its path', () => {
    const { result } = renderHook(() => useChatAttachments());

    act(() => {
      result.current.addFile('src/a.ts', 'a.ts');
    });

    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0]).toMatchObject({
      id: 'src/a.ts',
      name: 'a.ts',
      type: 'FILE',
    });
  });

  /**
   * **同名不同目录必须都能挂上**。
   *
   * 按 `name` 去重会把第二个静默吞掉 —— 用户以为加了两个文件，实际只有一个。
   */
  it('keeps same-named files from different directories', () => {
    const { result } = renderHook(() => useChatAttachments());

    act(() => {
      result.current.addFile('src/a/types.ts', 'types.ts');
      result.current.addFile('src/b/types.ts', 'types.ts');
    });

    expect(result.current.attachments).toHaveLength(2);
    expect(result.current.fileCount).toBe(2);
  });

  /** 同一路径重复添加是幂等的（用户手滑点两次不该产生两条）。 */
  it('is idempotent for the same path', () => {
    const { result } = renderHook(() => useChatAttachments());

    act(() => {
      result.current.addFile('src/a.ts', 'a.ts');
      result.current.addFile('src/a.ts', 'a.ts');
    });

    expect(result.current.attachments).toHaveLength(1);
  });

  it('removes by id', () => {
    const { result } = renderHook(() => useChatAttachments());

    act(() => {
      result.current.addFile('src/a.ts', 'a.ts');
      result.current.addFile('src/b.ts', 'b.ts');
    });
    act(() => {
      result.current.remove('src/a.ts');
    });

    expect(result.current.attachments.map((a) => a.id)).toEqual(['src/b.ts']);
  });

  /**
   * **请求字段的映射**：文件取路径，skill 取 name。
   *
   * 这一条是「传 name 而非 path」缺陷的回归钉子 —— 后端 `files` 契约是路径。
   */
  it('maps files to paths and skills to names', () => {
    const { result } = renderHook(() => useChatAttachments());

    act(() => {
      result.current.addFile('src/a/types.ts', 'types.ts');
      result.current.addFile('src/b/types.ts', 'types.ts');
    });

    const { files, skills } = result.current.toRequestFiles();
    expect(files).toEqual(['src/a/types.ts', 'src/b/types.ts']);
    expect(skills).toEqual([]);
  });

  it('starts empty', () => {
    const { result } = renderHook(() => useChatAttachments());
    expect(result.current.attachments).toEqual([]);
    expect(result.current.fileCount).toBe(0);
    expect(result.current.skillCount).toBe(0);
  });
});
