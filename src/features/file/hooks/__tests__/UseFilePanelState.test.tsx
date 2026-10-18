import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFileStore } from '@/features/file/store';
import type { DirTreeResult } from '@/shared/types';
import { createAppProviderWrapper } from '@/testing/AppProviderTestUtils';

import { useFilePanelState } from '../useFilePanelState';
import type { UseFilePanelStateParams } from '../useFilePanelState';

/**
 * 「展开」是**单一入口**：任何把路径写进展开态的动作都必须同时保证该目录内容就绪。
 *
 * 违反时的症状：目录 chevron 显示已展开、子项一片空白、无 spinner、无红灯 ——
 * 用户必须再点一次（走「收起」再「展开」）才把内容读出来。历史上有 3 个写入点，
 * 其中 startCreating 只改展开态、完全不发请求。
 *
 * 展开态现由 `useFileStore` 持有（按 owner 分槽，与目录缓存同生命周期），
 * 本 hook 只做命令编排 —— 测试因此同时断言「store 里展开态」与「loader 被请求」。
 */

const OWNER = 'p1:/demo';

function emptyResult(): DirTreeResult {
  return { nodes: [], truncated: false };
}

function makeParams(overrides: Partial<UseFilePanelStateParams> = {}): UseFilePanelStateParams {
  return {
    projectPath: '/demo',
    owner: OWNER,
    activeFilePath: null,
    onSelectFile: vi.fn(),
    onRefresh: vi.fn(),
    makeDirLoader: () => () => Promise.resolve(emptyResult()),
    ...overrides,
  };
}

function renderPanel(params: UseFilePanelStateParams) {
  // rerender 需能换 params：hook 回调必须读入参，不能闭包捕获初始值。
  return renderHook((p: UseFilePanelStateParams) => useFilePanelState(p), {
    wrapper: createAppProviderWrapper(),
    initialProps: params,
  });
}

/** 记录被请求的目录，并返回一级条目让行组装出来 */
function makeRecorder() {
  const requested: string[] = [];
  const makeDirLoader = (dirPath: string) => {
    requested.push(dirPath);
    return () =>
      Promise.resolve<DirTreeResult>({
        nodes: [{ name: 'leaf.ts', path: `${dirPath}/leaf.ts`, is_dir: false, children: [] }],
        truncated: false,
      });
  };
  return { requested, makeDirLoader };
}

const expanded = () => [...useFileStore.getState().expandedDirs];

// 展开态现在存活在 store（模块级单例）→ 用例间必须显式复位，
// 否则前一用例的展开路径会让本用例的「展开」变成「收起」。
beforeEach(() => {
  useFileStore.getState().reset();
});

describe('useFilePanelState — 展开即加载（不变量）', () => {
  it('startCreating：在未展开目录内新建时加载该目录内容', async () => {
    const { requested, makeDirLoader } = makeRecorder();
    const { result } = renderPanel(makeParams({ makeDirLoader }));

    act(() => {
      result.current.startCreating('packages/dsh-neeko', 'file');
    });

    await waitFor(() => {
      expect(requested).toContain('packages/dsh-neeko');
    });
    expect(expanded()).toContain('packages/dsh-neeko');
  });

  it('locateFile：逐级展开祖先且每级只请求一次', async () => {
    const { requested, makeDirLoader } = makeRecorder();
    const { result } = renderPanel(makeParams({ makeDirLoader }));

    await act(async () => {
      await result.current.locateFile('packages/dsh-neeko/README.md');
    });

    expect(requested).toEqual(['packages', 'packages/dsh-neeko']);
  });

  it('已展开目录重复定位：不收起祖先（确保展开 ≠ 翻转）', async () => {
    const { makeDirLoader } = makeRecorder();
    const { result } = renderPanel(makeParams({ makeDirLoader }));

    await act(async () => {
      await result.current.locateFile('packages/dsh-neeko/README.md');
    });
    expect(expanded()).toEqual(['packages', 'packages/dsh-neeko']);

    // 再次定位同一文件：祖先必须仍是展开态（旧实现走 toggle 会把它收起）
    await act(async () => {
      await result.current.locateFile('packages/dsh-neeko/README.md');
    });
    expect(expanded()).toEqual(['packages', 'packages/dsh-neeko']);
  });

  it('handleToggleDir 展开：加载该目录（点击一次即可见内容）', async () => {
    const { requested, makeDirLoader } = makeRecorder();
    const { result } = renderPanel(makeParams({ makeDirLoader }));

    await act(async () => {
      await result.current.handleToggleDir('packages/dsh-neeko');
    });

    expect(requested).toContain('packages/dsh-neeko');
    expect(expanded()).toContain('packages/dsh-neeko');
  });

  it('handleToggleDir 收起：再次点击移除展开态（翻转语义归点击独占）', async () => {
    const { makeDirLoader } = makeRecorder();
    const { result } = renderPanel(makeParams({ makeDirLoader }));

    await act(async () => {
      await result.current.handleToggleDir('packages/dsh-neeko');
    });
    await act(async () => {
      await result.current.handleToggleDir('packages/dsh-neeko');
    });

    expect(expanded()).not.toContain('packages/dsh-neeko');
  });

  it('切换项目（owner 变）：展开态作废，不残留上一项目的展开路径', async () => {
    const { makeDirLoader } = makeRecorder();
    const { result, rerender } = renderPanel(makeParams({ makeDirLoader }));

    await act(async () => {
      await result.current.handleToggleDir('packages/dsh-neeko');
    });
    expect(expanded()).toContain('packages/dsh-neeko');

    // 切到另一项目：owner 跳变后首次展开触发 store 的 owner 切换清空
    await act(async () => {
      await useFileStore.getState().loadDir('p2:/other', '', () => Promise.resolve(emptyResult()));
    });
    rerender(makeParams({ makeDirLoader, owner: 'p2:/other' }));

    expect(expanded()).toEqual([]);
  });

  it('单级加载失败不上抛：目录保持展开，失败交由 store error 态（红灯重试）', async () => {
    const makeDirLoader = () => () => Promise.reject(new Error('disk busy'));
    const { result } = renderPanel(makeParams({ makeDirLoader }));

    await act(async () => {
      await result.current.locateFile('packages/dsh-neeko/README.md');
    });

    // 单级失败不中断整链：目录仍在展开态，store 标 error
    expect(expanded()).toContain('packages');
    expect(useFileStore.getState().loadStates['packages']).toBe('error');
  });
});

describe('useFilePanelState — 祖先展开的包链策略一致（同一语义单一实现）', () => {
  /**
   * Java 源根下的单子目录链：src/main/java → com → tomgs。
   * **目标文件必须落在链中间**（`.../com/App.java`）—— 若落在链末端，
   * 父链恰好覆盖包链，两条路径结果相同，测不出分歧（我第一版用例就踩了这个坑）。
   */
  const javaTree: Record<string, string[]> = {
    'src/main/java': ['com'],
    'src/main/java/com': ['tomgs', 'App.java'],
    'src/main/java/com/tomgs': ['Deep.java'],
  };

  function makeJavaRecorder() {
    const requested: string[] = [];
    const makeDirLoader = (dirPath: string) => {
      requested.push(dirPath);
      const entries = javaTree[dirPath] ?? [];
      return () =>
        Promise.resolve<DirTreeResult>({
          nodes: entries.map((name) => ({
            name,
            path: `${dirPath}/${name}`,
            is_dir: !name.includes('.'),
            children: [],
          })),
          truncated: false,
        });
    };
    return { requested, makeDirLoader };
  }

  /** readDir 探针读 store 缓存（与 FilesPanel 的真实注入一致） */
  const storeReadDir = (dirPath: string) => useFileStore.getState().dirs[dirPath] ?? [];

  it('定位到包链中间的文件：包链末端仍被展开（不能只展开父链）', async () => {
    const { makeDirLoader } = makeJavaRecorder();
    const { result } = renderPanel(makeParams({ makeDirLoader, readDir: storeReadDir }));

    await act(async () => {
      await result.current.locateFile('src/main/java/com/App.java');
    });

    // App.java 的父链止于 src/main/java/com；包链末端 com/tomgs 不在父链内，
    // 只有走 expandDir（带包链）才会被展开。
    expect(expanded()).toContain('src/main/java/com/tomgs');
  });

  it('重复定位已展开祖先：不收起（确保展开 ≠ 翻转）', async () => {
    const { makeDirLoader } = makeJavaRecorder();
    const { result } = renderPanel(makeParams({ makeDirLoader, readDir: storeReadDir }));

    await act(async () => {
      await result.current.locateFile('src/main/java/com/App.java');
    });
    const first = expanded();

    await act(async () => {
      await result.current.locateFile('src/main/java/com/App.java');
    });

    for (const dir of first) {
      expect(expanded()).toContain(dir);
    }
  });
});
