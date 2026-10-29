import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectStore } from '@/shared/store/projectStore';
import type { ProjectEnvironment } from '@/shared/types';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';

import { useAssetUrl } from '../useAssetUrl';

const readFileBytesAll = vi.fn();

vi.mock('@/shared/api/fileBytes', () => ({
  readFileBytesAll: (...args: unknown[]) => readFileBytesAll(...args),
}));

function projectId() {
  return WorkspaceSession.of('p1', null).projectId;
}

function seedProject(environment: ProjectEnvironment) {
  useProjectStore.setState({
    projects: [{ id: 'p1', environment }] as never,
    activeProjectId: 'p1',
  } as never);
}

const objectUrls: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  objectUrls.length = 0;
  // jsdom 未实现 createObjectURL；用可断言的替身记录生命周期。
  let seq = 0;
  globalThis.URL.createObjectURL = vi.fn(() => {
    const url = `blob:mock/${++seq}`;
    objectUrls.push(url);
    return url;
  });
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useAssetUrl', () => {
  it('http(s) / data: 外链直通，不触碰字节通道', () => {
    seedProject({ type: 'Remote', host: 'h', port: 22, username: 'u', auth: { Password: 'x' } });
    const { result } = renderHook(() => useAssetUrl('https://a.com/x.png', undefined));
    expect(result.current.url).toBe('https://a.com/x.png');
    expect(readFileBytesAll).not.toHaveBeenCalled();
  });

  it('本地项目走 asset 协议，不发 IPC', () => {
    seedProject({ type: 'Local' });
    const { result } = renderHook(() => useAssetUrl('/repo/img/a.png', '/repo/docs'));
    expect(result.current.url).toBe('asset://localhost//repo/img/a.png');
    expect(readFileBytesAll).not.toHaveBeenCalled();
  });

  it('本地项目相对路径按 basePath 解析', () => {
    seedProject({ type: 'Local' });
    const { result } = renderHook(() => useAssetUrl('img/a.png', '/repo/docs'));
    expect(result.current.url).toBe('asset://localhost//repo/docs/img/a.png');
  });

  it('远程项目经 read_file_bytes 取字节并生成 blob URL', async () => {
    seedProject({ type: 'Wsl', distro: 'Ubuntu' });
    readFileBytesAll.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);

    const { result } = renderHook(() => useAssetUrl('img/a.webp', '/repo/docs'));
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.url).toBe('blob:mock/1'));
    expect(result.current.loading).toBe(false);
    // 相对路径 + 基准目录一起传给后端通道（不在前端拍平成绝对路径）
    expect(readFileBytesAll).toHaveBeenCalledWith(expect.anything(), 'img/a.webp', {
      base: '/repo/docs',
    });
  });

  it('反斜杠路径在跨 IPC 前归一为 `/`（与 URL 派生共用同一套归一）', async () => {
    seedProject({ type: 'Wsl', distro: 'Ubuntu' });
    readFileBytesAll.mockResolvedValue(new Uint8Array([1]).buffer);

    const { result } = renderHook(() => useAssetUrl('img\\a.webp', '/repo/docs'));
    await waitFor(() => expect(result.current.url).toBe('blob:mock/1'));

    expect(readFileBytesAll).toHaveBeenCalledWith(expect.anything(), 'img/a.webp', {
      base: '/repo/docs',
    });
  });

  it('卸载时 revoke 掉 blob URL（否则字节泄漏在 webview 里）', async () => {
    seedProject({ type: 'Remote', host: 'h', port: 22, username: 'u', auth: { Password: 'x' } });
    readFileBytesAll.mockResolvedValue(new Uint8Array([1]).buffer);

    const { result, unmount } = renderHook(() => useAssetUrl('/repo/a.png', '/repo'));
    await waitFor(() => expect(result.current.url).toBe('blob:mock/1'));

    unmount();
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock/1');
  });

  it('读取失败时给出错误而不抛到渲染层', async () => {
    seedProject({ type: 'Wsl', distro: 'Ubuntu' });
    readFileBytesAll.mockRejectedValue(new Error('Path is outside root directory'));

    const { result } = renderHook(() => useAssetUrl('/etc/passwd', '/repo'));
    await waitFor(() => expect(result.current.error).toContain('outside root'));
    expect(result.current.url).toBeNull();
  });

  it('空 src 不触发任何通道', () => {
    seedProject({ type: 'Wsl', distro: 'Ubuntu' });
    const { result } = renderHook(() => useAssetUrl(undefined, '/repo'));
    expect(result.current).toEqual({ url: null, loading: false, error: null });
    expect(readFileBytesAll).not.toHaveBeenCalled();
  });

  it('项目未选中时按本地处理（asset 协议不需要额外信息）', () => {
    useProjectStore.setState({ projects: [] as never, activeProjectId: null } as never);
    const { result } = renderHook(() => useAssetUrl('/repo/a.png'));
    expect(result.current.url).toBe('asset://localhost//repo/a.png');
  });

  it('projectId 显式传入时以它为准（编辑器 tab 不依赖激活项目）', () => {
    seedProject({ type: 'Local' });
    const { result } = renderHook(() => useAssetUrl('/repo/a.png', undefined, projectId()));
    expect(result.current.url).toBe('asset://localhost//repo/a.png');
  });
});
