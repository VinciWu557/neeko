/**
 * scrollMemory — 逻辑视图 → 滚动位置的瞬态缓存（无 React、不持久化）
 *
 * 为什么需要它：
 * DOM 的 scrollTop 存在「元素实例」上，而面板/标签的**逻辑身份**比元素实例长寿。
 * 两种不等寿形态都会丢位置：
 *   ① 卸载重建：非活跃 tab / 关闭再打开的面板（元素被销毁）；
 *   ② display:none 保活：WKWebView 隐藏期间丢弃 scrollTop（Dock 面板互切即此因，
 *      本项目 VirtualList 已验证该引擎行为）。
 * 本模块把「位置」从元素实例搬到以逻辑身份为键的外部缓存，成为两者的共同载体。
 *
 * 为什么不放 zustand：
 * - scrollTop 高频写入，进 store 会触发订阅者 re-render；
 * - 纯 UI 瞬态，不写 localStorage / sessions.json（与 editorViewState 同一判断）。
 */

/** key 段分隔符：NUL 不可能出现在任何 id / 路径 / 事件名里，杜绝拼接歧义。 */
const SEG = '\u0000';

/** 上限保护：面板 × 工作区是长尾组合，超限按 LRU 淘汰，防常驻增长。 */
const MAX_ENTRIES = 300;

const cache = new Map<string, number>();

/**
 * 身份键的**唯一铸造点**：
 * - surface：稳定视图面（调用点模块级常量，如 'dock.projects'）
 * - owner  ：所属容器身份（workspace key / tab space key；全局面传 null）
 * - sub    ：视图内二级身份（tabId / navId / PR number / sessionId）
 *
 * 禁止调用侧自行拼接「等价」键 —— 同一视图的键只允许在此产生。
 */
export function buildScrollKey(
  surface: string,
  owner?: string | null,
  sub?: string | null,
): string {
  return `${surface}${SEG}${owner ?? ''}${SEG}${sub ?? ''}`;
}

export function readScrollMemory(key: string): number | undefined {
  return cache.get(key);
}

export function writeScrollMemory(key: string, top: number): void {
  // 健壮性：NaN/Infinity 会在 scrollTo({top}) 处触发 WebIDL TypeError，
  // 在入口拒收，而不是让消费点 try/catch。
  if (!Number.isFinite(top)) return;
  cache.delete(key); // 重插以刷新 LRU 序位
  cache.set(key, Math.max(0, top));
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

export function dropScrollMemory(key: string): void {
  cache.delete(key);
}

/**
 * 按 owner 段**精确匹配**删除（关项目 / 关工作区时调用）。
 * 逐段比对而非前缀匹配：防止 owner='a' 误删 owner='ab' 的快照。
 */
export function dropScrollMemoryForOwner(owner: string): void {
  for (const k of cache.keys()) {
    if (k.split(SEG)[1] === owner) cache.delete(k);
  }
}

/** 仅供测试使用 */
export function __resetScrollMemoryForTest(): void {
  cache.clear();
}
