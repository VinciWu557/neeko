/**
 * 注释翻译的**模块级共享缓存**（跨文件 / 跨 tab 复用）。
 *
 * ## 为什么单独成文件
 *
 * 缓存实例必须是**模块级单例**：内容地址天然跨文件安全（地址 = 归一化文本哈希），
 * 同一句话在不同文件里只该请求一次模型。若跟着 hook 实例走，切 tab 就丢缓存，
 * 「增量」在用户眼里就等于不存在。
 *
 * 抽成独立模块还有两个副作用，都是想要的：
 * - 测试可整体替换实现（`__setSharedCommentCacheForTests`），不必碰 hook 内部；
 * - `useCommentTranslateActions` 少约 20 行 —— 它贴着 `check_component_size` 的
 *   300 行 ratchet 红线，缓存生命周期与本文件的状态机没有耦合。
 */
import type { TranslationCache } from '../comment/translationCache';

let sharedCache: TranslationCache | null = null;

/**
 * 惰性创建共享缓存。
 *
 * 惰性而非模块顶层 `new`：`MemoryCache` 来自动态导入的模块，顶层实例化会把
 * 缓存模块拉进首屏 chunk（编辑器启动路径上不需要它）。
 */
export async function getSharedCommentCache(): Promise<TranslationCache> {
  if (!sharedCache) {
    const { MemoryCache } = await import('../comment/translationCache');
    sharedCache = new MemoryCache();
  }
  return sharedCache;
}

/** **测试专用**：注入缓存实现（生产代码不得调用）。 */
export function __setSharedCommentCacheForTests(cache: TranslationCache | null): void {
  sharedCache = cache;
}
