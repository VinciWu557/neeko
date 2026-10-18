import { create } from 'zustand';

import type { DirLoadState, DirTreeResult, FileNode } from '@/shared/types';

/** 目录缓存 key：项目内相对路径，'' 表示项目根目录 */
type DirPath = string;
/** 文件树数据归属：由 [`fileTreeOwner`] 唯一铸造，用于切换项目/root 时丢弃过期响应 */
type FileTreeOwner = string;

/**
 * 文件树数据归属的**唯一铸造点**。
 *
 * 展开态、目录缓存、加载状态机、在途序号全部存在这个坐标系下 —— 因此它必须
 * 只有一个派生点。历史上本函数体的等价拼接在 5 处（useFileTreeSync ×3、
 * useFileView ×2）各自手写，任何一处改分隔符或加分量，就会让「同一棵树的展开态」
 * 出现两种 key，表现为切项目/切 worktree 后展开态与缓存错位（「展开但空白」）。
 *
 * `rootPath` 为工作树根（worktree）或项目根；不作归一（归一属路径身份，红线 12）。
 */
export function fileTreeOwner(projectId: string, rootPath: string): FileTreeOwner {
  return `${projectId}:${rootPath}`;
}

interface LoadDirOptions {
  /** 强制重新加载：跳过「已 loaded 幂等跳过」；用于初始加载与手动/后台刷新 */
  force?: boolean;
  /** 后台静默加载：已有内容时不切换 loading 态（避免刷新闪烁），失败保留旧内容并标记 error */
  silent?: boolean;
}

interface FileStoreState {
  /** 当前数据归属；与传入 owner 不一致时，旧缓存与在途响应一律作废 */
  owner: FileTreeOwner | null;
  /** 各目录内容缓存：dirPath → 该目录一级条目（children 一律清空，见 stripChildren） */
  dirs: Record<DirPath, FileNode[]>;
  /** 各目录加载状态机：idle | loading | loaded | error */
  loadStates: Record<DirPath, DirLoadState>;
  /**
   * 各目录读取是否因单层条目上限被截断（R7 / 红线 4）：dirPath → truncated。
   * 后端 `read_dir_tree` 的顶层截断标记逐目录记录；`reset` 随归属一起清空。
   */
  truncatedDirs: Record<DirPath, boolean>;
  /** 各目录请求序号：响应回来时序号不匹配即过期，丢弃防乱序覆盖 */
  requests: Record<DirPath, number>;
  /**
   * 已展开目录集合。
   *
   * **与 `dirs` / `loadStates` 同槽、同 owner 生命周期** —— 这是本 store 的关键不变量：
   * 展开态与目录内容必须共享坐标系（`(owner, dirPath)`）与生命周期。
   *
   * 历史教训：展开态曾是面板组件 `useState`（仅 `dirPath` 坐标），而目录缓存按
   * `owner` 隔离。两套坐标系在切换项目 / worktree 时不同步 —— 缓存被惰性清空、
   * 展开态跨项目存活，于是新项目里该路径「chevron 已展开、子项一片空白、无 spinner
   * 无红灯」，用户必须再点一次（先收起再展开）才读到内容。
   *
   * 折叠**不丢缓存**（再展开零请求）；`collapseAll` 同理。展开态只在 owner 跳变、
   * 显式 `reset()` 时随缓存一起作废。
   */
  expandedDirs: Set<DirPath>;
  /**
   * 加载（或重载）某个目录的内容。目录数据独立缓存、独立生命周期：
   * - 加载成功写入 dirs[dirPath]，标记 loaded
   * - 失败保留旧内容并标记 error（供 UI 重试），绝不置空
   * - owner / 请求序号任一不匹配即丢弃响应
   * - loading 中重复调用：token 递增，最后一次为准
   */
  loadDir: (
    owner: FileTreeOwner,
    dirPath: DirPath,
    loader: () => Promise<DirTreeResult>,
    opts?: LoadDirOptions,
  ) => Promise<void>;
  /**
   * 全树/定向刷新：重载根目录与已加载目录，逐个替换缓存。
   * 解决「移动/删除文件后展开目录缓存不更新」——显式刷新已加载目录缓存。
   * - opts.dirs 提供时为**定向刷新**（S2-2）：只重载命中该目录集合的缓存桶，
   *   其余已加载目录保持不动 —— 刷新成本 O(变更) 而非 O(已展开树)；
   *   dirs 空数组 / undefined = 变更范围未知（watcher overflow 兜底），执行全量
   * - 跳过正在 loading 的目录（让在途请求自己收尾，避免 token 竞争）
   * - 未加载（折叠未展开）的子目录下次展开仍懒加载新数据，无需处理
   * - silent：后台刷新，新数据到达前保留旧内容、不切换 loading 态
   */
  refreshTree: (
    owner: FileTreeOwner,
    loaderFor: (dirPath: DirPath) => () => Promise<DirTreeResult>,
    opts?: { silent?: boolean; dirs?: string[] },
  ) => Promise<void>;
  /** 切换项目/root 时清空全部缓存与归属 */
  reset: () => void;
  /**
   * **确保展开**（幂等）：已展开则只保证内容就绪，已展开且已加载则完全无操作。
   * 不翻转展开态 —— 这是「定位 / 联动 / 新建」等**声明式**场景的唯一正确语义。
   *
   * 展开：先把路径写入 `expandedDirs`，再 `await loadDir` —— 两步同一次调用，
   * 中间不存在「展开但无数据」窗口。加载失败**不上抛**（store 已置 error，行尾
   * 红灯可重试），目录保持展开，由用户决定重试还是折叠。
   */
  expandDir: (
    owner: FileTreeOwner,
    dirPath: DirPath,
    loader: () => Promise<DirTreeResult>,
  ) => Promise<void>;
  /**
   * 点击目录行：**翻转**展开态（已展开 → 收起且不动缓存；未展开 → 走 `expandDir`）。
   * 仅用于用户点击/快捷键等**命令式**翻转场景。
   */
  toggleDir: (
    owner: FileTreeOwner,
    dirPath: DirPath,
    loader: () => Promise<DirTreeResult>,
  ) => Promise<void>;
  /** 折叠全部：清空展开态但保留缓存（不牺牲再展开的零请求） */
  collapseAll: () => void;
}

/** 目录缓存只存一级条目：清空 children，避免「嵌套树」与「扁平缓存」两套语义并存 */
function stripChildren(nodes: FileNode[]): FileNode[] {
  return nodes.map((n) => (n.is_dir ? { ...n, children: [] } : n));
}

/** 受控并发执行（S2-3）：并发上限固定为 4，防止事件风暴期的无界扇出 */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    // 领号取任务：号超出范围即本 runner 退出（无常量条件，lint 友好）
    let index = next++;
    while (index < items.length) {
      await worker(items[index] as T);
      index = next++;
    }
  });
  await Promise.all(runners);
}

/**
 * 把嵌套树中所有「带 children 的目录」摊平进扁平缓存（每级只存一级条目）。
 * 展开这些目录时可直接命中缓存，无需再发起请求；空 children 的目录（真空目录、
 * 被忽略剪枝、达到 max_depth 截断）不 seed —— 展开时仍按需请求，保留穿透语义。
 */
function flattenNestedDirs(nodes: FileNode[]): Record<string, FileNode[]> {
  const out: Record<string, FileNode[]> = {};
  const walk = (list: FileNode[]) => {
    for (const n of list) {
      if (n.is_dir && n.children.length > 0) {
        out[n.path] = stripChildren(n.children);
        walk(n.children);
      }
    }
  };
  walk(nodes);
  return out;
}

/**
 * owner 跳变时的清空补丁（缓存 + 展开态 + 在途序号一起作废）。
 *
 * **共用**于 `loadDir` 与 `expandDir`（`toggleDir` 的展开分支也走 `expandDir`）：
 * 展开态与目录缓存必须同槽丢弃，否则两个入口各写一份就必然漂移
 * （这正是旧实现「切项目后展开态残留」的产地）。
 */
function ownerSwitchPatch() {
  return {
    dirs: {} as Record<DirPath, FileNode[]>,
    loadStates: {} as Record<DirPath, DirLoadState>,
    truncatedDirs: {} as Record<DirPath, boolean>,
    requests: {} as Record<DirPath, number>,
    expandedDirs: new Set<DirPath>(),
  };
}

export const useFileStore = create<FileStoreState>((set, get) => ({
  owner: null,
  dirs: {},
  loadStates: {},
  truncatedDirs: {},
  requests: {},
  expandedDirs: new Set<DirPath>(),

  async loadDir(owner, dirPath, loader, opts) {
    const state = get();
    const ownerChanged = state.owner !== owner;
    const { force = false, silent = false } = opts ?? {};
    // 幂等：已加载且非「刷新类」调用（force/silent）→ 跳过（展开已加载目录不重复请求）
    // 加载中重复调用不跳过：token 递增，最后一次为准（防乱序见 requests 校验）
    const current = state.loadStates[dirPath];
    if (!ownerChanged && !force && !silent && current === 'loaded') return;
    // 切换 owner：丢弃全部旧缓存、在途请求与展开态（旧响应会因 owner/token 校验被忽略）。
    // 展开态必须在同一补丁里作废 —— 否则新项目里旧路径「已展开但无缓存」。
    const switchPatch = ownerChanged ? ownerSwitchPatch() : null;
    const prevDirs = switchPatch?.dirs ?? state.dirs;
    const prevLoadStates = switchPatch?.loadStates ?? state.loadStates;
    const prevTruncatedDirs = switchPatch?.truncatedDirs ?? state.truncatedDirs;
    const prevRequests = switchPatch?.requests ?? state.requests;
    const prevExpandedDirs = switchPatch?.expandedDirs ?? state.expandedDirs;
    const token = (prevRequests[dirPath] ?? 0) + 1;
    // silent 且已有内容：后台更新，不切换 loading 态；否则进入 loading（含首次）
    const keepSilent = silent && !ownerChanged && prevLoadStates[dirPath] !== undefined;

    set({
      owner,
      dirs: prevDirs,
      loadStates: keepSilent ? prevLoadStates : { ...prevLoadStates, [dirPath]: 'loading' },
      truncatedDirs: prevTruncatedDirs,
      requests: { ...prevRequests, [dirPath]: token },
      expandedDirs: prevExpandedDirs,
    });

    try {
      const result = await loader();
      const tree = result.nodes;
      const latest = get();
      if (latest.owner !== owner || latest.requests[dirPath] !== token) return;
      // 请求目录写入一级缓存；嵌套树中的子目录 seed 进缓存（仅填补空缺，
      // 不覆盖已加载的子目录 —— 根刷新不触碰已展开目录缓存的语义保持一致）。
      const nested = flattenNestedDirs(tree);
      const dirs: Record<string, FileNode[]> = {
        ...latest.dirs,
        [dirPath]: stripChildren(tree),
      };
      const loadStates: Record<string, DirLoadState> = {
        ...latest.loadStates,
        [dirPath]: 'loaded',
      };
      for (const [p, entries] of Object.entries(nested)) {
        // 仅填补「从未加载且不在途」的目录：已加载目录保留（p in dirs），
        // 正在请求的目录不打断（loading 由该请求自己收尾）——根刷新不得干扰展开中的目录。
        if (!(p in latest.dirs) && latest.loadStates[p] !== 'loading') {
          dirs[p] = entries;
          loadStates[p] = 'loaded';
        }
      }
      set({
        dirs,
        loadStates,
        truncatedDirs: { ...latest.truncatedDirs, [dirPath]: result.truncated },
      });
    } catch {
      const latest = get();
      if (latest.owner !== owner || latest.requests[dirPath] !== token) return;
      // 失败保留旧内容，标记 error 供 UI 重试
      set({ loadStates: { ...latest.loadStates, [dirPath]: 'error' } });
    }
  },

  async refreshTree(owner, loaderFor, opts) {
    const { silent = false, dirs } = opts ?? {};
    // 快照当前已加载目录（dirs 的 key），避免刷新过程中新增目录影响遍历
    const loadedPaths = Object.keys(get().dirs);
    let target: string[];
    if (dirs && dirs.length > 0) {
      // 定向刷新（S2-2）：只重载事件命中目录集合的缓存桶，成本 O(变更)
      const hits = new Set(dirs);
      target = loadedPaths.filter((p) => hits.has(p) && get().loadStates[p] !== 'loading');
    } else {
      // 全量兜底：变更范围未知（watcher overflow / 手动刷新）
      // 跳过正在 loading 的目录：让在途请求自己收尾，避免 token 竞争覆盖最新响应
      target = loadedPaths.filter((p) => get().loadStates[p] !== 'loading');
    }
    // 受控并发重载；loadDir 内部 owner/token 校验会丢弃过期写入
    await mapWithConcurrency(target, 4, (dirPath) =>
      get().loadDir(owner, dirPath, loaderFor(dirPath), { force: true, silent }),
    );
  },

  reset: () =>
    set({
      owner: null,
      dirs: {},
      loadStates: {},
      truncatedDirs: {},
      requests: {},
      expandedDirs: new Set<DirPath>(),
    }),

  async expandDir(owner, dirPath, loader) {
    const state = get();
    // owner 跳变：先按切换清空（展开态与缓存同槽作废），再在空基底上展开。
    // 不先做这一步的话，下方 loadDir 会检测到 ownerChanged 再把刚设的展开态冲掉。
    const base = state.owner === owner ? state : null;
    if (!base) set({ owner, ...ownerSwitchPatch() });

    const currentExpanded = base ? base.expandedDirs : new Set<DirPath>();
    // 幂等：已展开 → 只补内容就绪（loadDir 自身对 loaded/loading 跳过）
    if (!currentExpanded.has(dirPath)) {
      set({ expandedDirs: new Set(currentExpanded).add(dirPath) });
    }
    await get().loadDir(owner, dirPath, loader);
  },

  async toggleDir(owner, dirPath, loader) {
    const state = get();
    // 收起：只移除展开态，缓存保留（再展开命中缓存，零请求）
    if (state.owner === owner && state.expandedDirs.has(dirPath)) {
      const next = new Set(state.expandedDirs);
      next.delete(dirPath);
      set({ expandedDirs: next });
      return;
    }
    // 展开：与 expandDir 完全同一语义（单一实现，不另写一份）
    await get().expandDir(owner, dirPath, loader);
  },

  collapseAll: () => set({ expandedDirs: new Set<DirPath>() }),
}));
