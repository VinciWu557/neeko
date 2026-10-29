import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useProjectStore } from '@/shared/store/projectStore';
import type { FileTab, ProjectEnvironment } from '@/shared/types';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';

import { useBinaryImagePreview } from '../useBinaryImagePreview';

function fileTab(filePath: string, isBinary: boolean): FileTab {
  return {
    id: 't1',
    workspace: WorkspaceSession.of('p1', null),
    filePath,
    fileName: filePath.split('/').pop() ?? filePath,
    content: { path: filePath, content: '', size: 10, is_binary: isBinary },
    isDirty: false,
  };
}

function seedEnvironment(environment: ProjectEnvironment) {
  useProjectStore.setState({ projects: [{ id: 'p1', environment }] as never });
}

describe('useBinaryImagePreview — 图片预览可用性', () => {
  beforeEach(() => {
    seedEnvironment({ type: 'Local' });
  });

  it('should_preview_binary_image_on_local_project', () => {
    const { result } = renderHook(() => useBinaryImagePreview(fileTab('/repo/a.png', true)));
    expect(result.current).toBe(true);
  });

  it('should_preview_on_wsl_and_remote（远程走 IPC 字节通道，不再排除）', () => {
    // 通道选择收在 useAssetUrl：Local 用 asset 协议，WSL/SSH 用 read_file_bytes → blob。
    // 历史上这里按 Local 排除远程，代价是远程图片只能看「Binary file」兜底 —— 已废弃。
    seedEnvironment({ type: 'Wsl', distro: 'Ubuntu' });
    expect(
      renderHook(() => useBinaryImagePreview(fileTab('/repo/a.png', true))).result.current,
    ).toBe(true);
    seedEnvironment({
      type: 'Remote',
      host: 'h',
      port: 22,
      username: 'u',
      auth: { Password: 'x' },
    });
    expect(
      renderHook(() => useBinaryImagePreview(fileTab('/repo/a.png', true))).result.current,
    ).toBe(true);
  });

  it('should_preview_every_binary_image_extension', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'ico']) {
      expect(
        renderHook(() => useBinaryImagePreview(fileTab(`/repo/a.${ext}`, true))).result.current,
      ).toBe(true);
    }
  });

  it('should_not_preview_when_not_binary_or_not_image', () => {
    // 文本内容 → 走常规编辑器
    expect(
      renderHook(() => useBinaryImagePreview(fileTab('/repo/a.png', false))).result.current,
    ).toBe(false);
    // 二进制但非图片 → 走二进制兜底视图
    expect(
      renderHook(() => useBinaryImagePreview(fileTab('/repo/a.bin', true))).result.current,
    ).toBe(false);
  });

  it('should_preview_when_project_unknown（判定只看内容与扩展名）', () => {
    useProjectStore.setState({ projects: [] as never });
    expect(
      renderHook(() => useBinaryImagePreview(fileTab('/repo/a.png', true))).result.current,
    ).toBe(true);
  });
});
