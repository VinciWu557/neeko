import { render as renderRTL, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FilesPanel from '@/features/file/components/FilesPanel';
import { useFileStore } from '@/features/file/store';
import type { DirTreeResult } from '@/shared/types';
import { createAppProviderWrapper } from '@/testing/AppProviderTestUtils';

/**
 * 同一目标不得被展开两次。
 *
 * 生产接线中 `activeFilePath` 与 `locateTargetPath` 是**同一个值**（都来自
 * `useLocateFileInTree`）。若两者各自触发「展开祖先 + 加载」，同一级目录会被
 * 请求两遍：一次走 `useDirExpansion` 的激活文件联动，一次走 `locateFile`。
 * `store.loadDir` 的幂等只能挡住「已 loaded」，挡不住两次并发（loading 中不跳过、
 * token 递增）—— 表现为重复 IPC，大仓库下翻倍。
 *
 * 语义分工应是：
 * · `locateTargetPath` = 完整定位（选中 + 展开 + 滚动信号）
 * · `activeFilePath`  = 仅高亮盖章 + 头部展示（不得触发展开）
 */

const render = (ui: Parameters<typeof renderRTL>[0]) =>
  renderRTL(ui, { wrapper: createAppProviderWrapper() });

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const OWNER = 'p1:/demo';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(1200);
  useFileStore.getState().reset();
  useFileStore.setState({ owner: OWNER, dirs: { '': [] }, loadStates: { '': 'loaded' } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('FilesPanel — 展开目标只走一条链路（不重复 IPC）', () => {
  it('activeFilePath 与 locateTargetPath 同值时，每级目录只请求一次', async () => {
    const requested: string[] = [];
    const makeDirLoader = (dirPath: string) => {
      requested.push(dirPath);
      return () => Promise.resolve<DirTreeResult>({ nodes: [], truncated: false });
    };

    render(
      <FilesPanel
        projectName="demo"
        projectPath="/demo"
        projectId={'p1' as never}
        owner={OWNER}
        makeDirLoader={makeDirLoader}
        activeFilePath="src/deep/a.ts"
        locateTargetPath="src/deep/a.ts"
        canLocateFile
        autoLocateFileOnTabSwitch
        onSelectFile={vi.fn()}
        onRefresh={vi.fn()}
        onExpandDir={vi.fn()}
      />,
    );

    await waitFor(() => expect(requested).toContain('src/deep'));
    // 给第二条链路留出触发窗口（effect 是异步的）
    await new Promise((r) => setTimeout(r, 200));

    const counts = requested.reduce<Record<string, number>>((acc, dir) => {
      acc[dir] = (acc[dir] ?? 0) + 1;
      return acc;
    }, {});
    // 每级恰好一次（重复 = 两条链路都在展开同一目标）
    expect(counts).toEqual({ src: 1, 'src/deep': 1 });
  });
});
