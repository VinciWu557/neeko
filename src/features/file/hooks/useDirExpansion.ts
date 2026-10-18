import { useCallback, useEffect, useRef } from 'react';

import type { DirTreeResult, FileNode } from '@/shared/types';

import { useFileStore } from '../store';
import { getParentPath, getParentPaths } from '../utils/fileTreeUtils';
import { isJavaSourceRoot, isUnderJavaSourceRoot } from '../utils/javaPackageTree';

/** 包视图链自动展开的级数上限（防病态深链） */
const MAX_PACKAGE_CHAIN_HOPS = 64;

interface UseDirExpansionParams {
  /**
   * 数据归属 `${projectId}:${rootPath}`。展开态存在 store 且**按 owner 分槽**，
   * 与目录缓存同一生命周期 —— 切项目 / 切 worktree 时一起作废，
   * 「展开但无数据」在结构上不可能出现。
   */
  owner: string | null;
  /** 目录加载器（store.loadDir 的 loader 入参；深度等读取语义由调用方决定） */
  makeLoader: (dirPath: string) => () => Promise<DirTreeResult>;
  /** 目录缓存读取探针：包视图链（Java 单子目录链）判定用；缺省返回空（walk 为 no-op） */
  readDir?: (dirPath: string) => FileNode[];
}

/**
 * 目录展开的**命令层**（状态所有权在 `useFileStore`）。
 *
 * 职责边界（这是本模块存在的理由，不是顺手加的一层）：
 * - **展开态与目录内容同槽**：两者都是 `(owner, dirPath)` 坐标下的数据，归 store 管；
 *   放组件态会让两套坐标系在切项目 / 切 worktree 时不同步（历史缺陷）。
 * - **本 hook 只编排**：把「Java 包视图链自动展开」这条**视图策略**（属 UI 关注点，
 *   不该下沉进 store）与 store 的原子动作组合。
 *
 * 展开的唯一入口是 `store.expandDir`（确保展开，幂等）：展开态与加载在同一次调用内
 * 建立，中间不存在「chevron 已展开、子项空白」窗口 —— 那正是用户需要「再点一下」的根因。
 * 只有用户点击（`handleToggleDir`）才用 `store.toggleDir` 做**翻转**。
 *
 * **本 hook 不监听激活文件**。「展开到某个文件」的编排归 `locateFile` 独占
 * （`useFilePanelState`）：它已同时做「选中 + 展开祖先 + 滚动信号」。历史上本 hook
 * 另有一条 `activeFilePath` 联动 effect，而生产接线把同一个值同时喂给
 * `activeFilePath` 与 `locateTargetPath` —— 两级 Effect 各自展开同一目标，每级目录
 * 被请求两次（`loadDir` 的幂等只能挡「已 loaded」，挡不住两次并发）。职责单一化后
 * 该重复在结构上不再可能。
 */
export function useDirExpansion({ owner, makeLoader, readDir = () => [] }: UseDirExpansionParams) {
  // 展开态直接取自 store（无本地副本 → 不存在两份状态漂移）
  const expandedDirs = useFileStore((s) => s.expandedDirs);

  // makeLoader / readDir 走 ref：让回调身份稳定（S4 memo 比较器按回调身份比较，
  // toggle 抖动会使整树重渲染），同时不丢失最新实现。
  const makeLoaderRef = useRef(makeLoader);
  const readDirRef = useRef(readDir);
  useEffect(() => {
    makeLoaderRef.current = makeLoader;
    readDirRef.current = readDir;
  }, [makeLoader, readDir]);

  /**
   * 展开单个目录（含 Java 包视图链的逐级自动展开）。
   *
   * 这是「展开」在 UI 层的**唯一实现**：包视图链是视图策略（Java 单子目录链压行），
   * 与目录数据/展开态无关，所以不能下沉到 store；但所有调用方必须走这里 ——
   * 否则「包链展开」会变成某些入口的专属行为（历史缺陷：定位与 tab 联动
   * 两条路径一个走包链、一个不走，同一操作在两种入口下得到不同的视图）。
   */
  const expandDir = useCallback(
    async (dirPath: string) => {
      if (!owner) return;
      await useFileStore.getState().expandDir(owner, dirPath, makeLoaderRef.current(dirPath));

      // 包视图链：源根或其下目录只含一个子目录时自动逐级展开到底
      //（视觉压行 + 数据就绪两条腿；上限防病态深链）。
      let cur = dirPath;
      let hops = 0;
      while (
        hops++ < MAX_PACKAGE_CHAIN_HOPS &&
        (isUnderJavaSourceRoot(cur) || isJavaSourceRoot(cur))
      ) {
        const dirsOnly = readDirRef.current(cur).filter((n) => n.is_dir);
        if (dirsOnly.length !== 1) break;
        const next = dirsOnly[0].path;
        await useFileStore.getState().expandDir(owner, next, makeLoaderRef.current(next));
        cur = next;
      }
    },
    [owner],
  );

  /**
   * 展开目标文件的全部祖先目录（定位 / 打开文件 / 联动激活 tab 共用）。
   * 逐级串行（浅 → 深）且每级走 `expandDir` —— 包链策略与单目录展开自动一致。
   */
  const expandPathParents = useCallback(
    async (filePath: string) => {
      if (!owner) return;
      for (const parent of getParentPaths(filePath)) {
        await expandDir(parent);
      }
    },
    [owner, expandDir],
  );

  /** 点击目录行：收起（含包链）/ 展开（含包链） */
  const handleToggleDir = useCallback(
    async (path: string) => {
      if (!owner) return;
      const store = useFileStore.getState();

      if (store.expandedDirs.has(path)) {
        // 收起：移除本级；再沿包链向上把「单子目录链」的祖先一并收起
        //（用户点一下折叠整个包视图）。纯展开态操作，不触数据。
        store.toggleDir(owner, path, makeLoaderRef.current(path));
        let cur = path;
        let hops = 0;
        while (hops++ < MAX_PACKAGE_CHAIN_HOPS) {
          const parent = getParentPath(cur);
          if (!parent || parent === cur) break;
          if (!(isUnderJavaSourceRoot(parent) || isJavaSourceRoot(parent))) break;
          const dirsOnly = readDirRef.current(parent).filter((n) => n.is_dir);
          if (dirsOnly.length !== 1 || dirsOnly[0].path !== cur) break;
          if (!useFileStore.getState().expandedDirs.has(parent)) break;
          useFileStore.getState().toggleDir(owner, parent, makeLoaderRef.current(parent));
          cur = parent;
        }
        return;
      }
      await expandDir(path);
    },
    [owner, expandDir],
  );

  /** 折叠全部：清空展开态但保留缓存（再展开零请求） */
  const collapseAll = useCallback(() => {
    useFileStore.getState().collapseAll();
  }, []);

  return {
    expandedDirs,
    expandDir,
    expandPathParents,
    handleToggleDir,
    collapseAll,
    canCollapse: expandedDirs.size > 0,
  };
}
