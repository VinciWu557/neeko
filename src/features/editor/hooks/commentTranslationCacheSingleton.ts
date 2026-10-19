/**
 * 注释翻译的**模块级共享缓存**（跨文件 / 跨 tab / 跨进程运行复用）。
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
 *
 * ## 为什么生产实现是持久化而非进程内
 *
 * 翻译一次要花钱。进程内缓存让「重启应用」等于「重新付费翻译一遍」，
 * 而用户对同一批文件的阅读是跨会话的。持久化后同一文件第二次打开
 * （含重启后）直接命中，`turn` 零调用。
 *
 * 降级策略由 `PersistentKeyValueStore` 提供：读失败 / 数据损坏 / 版本不符
 * 一律降级为空缓存，**不阻断翻译主流程**。
 */
import { createSqliteCachePort, PersistentKeyValueStore } from '@/shared/cache';

import type { CachedTranslation, TranslationCache } from '../comment/translationCache';
import { COMMENT_TRANSLATION_PROFILE } from '../comment/translationCache';

/** 缓存域的 namespace。与 Rust 侧 `validate_namespace` 的字符集一致。 */
const NAMESPACE = 'comment-i18n';

/** 条目上限。与 `PersistentKeyValueStore` 的默认值一致，显式写出以便两端同源。 */
const MAX_ENTRIES = 5000;

/**
 * 把通用 KV 存储收窄成注释翻译的缓存接口。
 *
 * 两个形状几乎同构，差异只有两点：
 * - 通用层多了 `flush`（显式落盘），这里在 `set`/`setMany` 后立即 flush ——
 *   翻译是按批走的，批次结束就是落盘时机，没有更晚的「安全点」。
 * - 通用层不认识 `CachedTranslation`，由 `validate` 收窄并丢弃不合格条目。
 */
function toTranslationCache(store: PersistentKeyValueStore<CachedTranslation>): TranslationCache {
  return {
    get: (key) => store.get(key),
    set: async (key, value) => {
      // 必须 await：`set` 内部先 `await this.load()` 再置脏，不等待就会出现
      // 「flush 先跑、set 后置脏」——该批数据既不落盘也不会再被 flush（dirty
      // 是在 flush 之后才置上的，下一次 flush 已经早了）。实测：不 await 时
      // putMany 调用次数为 0。
      await store.set(key, value);
      await store.flush();
    },
    getMany: (keys) => store.getMany(keys),
    setMany: async (entries) => {
      // `setMany` 内部已在末尾 `await this.flush()`，这里不再重复 flush
      // （重复调用是空转，但更重要的是别让「两次 flush」掩盖掉内部那次）。
      await store.setMany(entries);
    },
  };
}

function createPersistentCache(): TranslationCache {
  // 版本号只算一次：两处（Port 与 store）必须逐字相同，否则写入的版本与
  // 读取校验的版本会漂移，表现为「写完立刻读不到」。
  const version = profileVersionNumber();
  const store = new PersistentKeyValueStore<CachedTranslation>({
    port: createSqliteCachePort({ namespace: NAMESPACE, version, maxEntries: MAX_ENTRIES }),
    version,
    maxEntries: MAX_ENTRIES,
    validate: validateCachedTranslation,
  });
  return toTranslationCache(store);
}

/**
 * 把字符串 profile 标识折叠成数字版本。
 *
 * 后端 `version` 是 INTEGER，而 profile 是 `comment-p1` 这样的字符串。
 * 取末尾的数字：`comment-p1` → 1。改规则时 profile 必须 +1，版本号随之变化。
 *
 * **格式是契约**：profile 必须以十进制数字结尾。取不到数字时 `DEFAULT_VERSION`
 * 会让所有版本退化到同一个值 —— 那等于「改规则后旧缓存继续命中」，是最难定位的
 * 一类 bug。所以测试直接断言**当前真实的 profile** 能被解析（
 * `commentTranslationCacheSingleton.test.ts` 的 profile 契约用例），而不是在这里
 * 静默兜底：兜底会让格式错误变成无声的。
 */
export function profileVersionNumber(): number {
  const match = /(\d+)$/.exec(COMMENT_TRANSLATION_PROFILE);
  if (!match?.[1]) {
    // 走到这里说明 `COMMENT_TRANSLATION_PROFILE` 违反了自己的格式契约。
    // 记一条 error 让问题可见，但仍返回一个稳定值——缓存失效不该炸掉翻译。
    console.error(
      `[commentTranslationCache] profile "${COMMENT_TRANSLATION_PROFILE}" does not end with a number; ` +
        'cache version falls back to 1 and old entries may be served under the new rules',
    );
    return 1;
  }
  return Number.parseInt(match[1], 10);
}

/** 结构校验：形状不对就丢弃该条（不是整份失效）。 */
function validateCachedTranslation(raw: unknown): CachedTranslation | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.source !== 'string') return null;
  if (typeof entry.text !== 'string') return null;
  if (typeof entry.at !== 'number' || !Number.isFinite(entry.at)) return null;
  return { source: entry.source, text: entry.text, at: entry.at };
}

let sharedCache: TranslationCache | null = null;

/**
 * 惰性创建共享缓存。
 *
 * 惰性而非模块顶层 `new`：持久化实现会经 `@tauri-apps/api/core` 触达 IPC，
 * 顶层实例化会把 IPC 与缓存模块拉进首屏 chunk（编辑器启动路径上不需要它们）。
 */
export async function getSharedCommentCache(): Promise<TranslationCache> {
  if (!sharedCache) {
    if (isTauriRuntime()) {
      sharedCache = createPersistentCache();
    } else {
      // Outside Tauri (unit tests, plain browser) the commands do not exist;
      // fall back to the in-memory implementation rather than failing every
      // translation.
      const { MemoryCache } = await import('../comment/translationCache');
      sharedCache = new MemoryCache();
    }
  }
  return sharedCache;
}

/**
 * 是否运行在 Tauri webview 里。
 *
 * 检测 `__TAURI_INTERNALS__` 而不是 `isTauri`：`@tauri-apps/api` 的 `isTauri()`
 * 读的是 `globalThis.isTauri`，它由 `withGlobalTauri` 注入的 IIFE bundle 建立；
 * 本仓虽开了 `withGlobalTauri`，但只依赖 `@tauri-apps/api` 的 ESM 入口时两者并不
 * 必然同时存在。`__TAURI_INTERNALS__` 是 `invoke` 本身依赖的对象
 * （`core.js` 的 `invoke` 直接读 `window.__TAURI_INTERNALS__.invoke`），
 * 所以它存在 ⟺ IPC 可用，这正是本函数要回答的问题。
 *
 * 测试环境里 `src/testing/setup.ts` mock 的是 `@tauri-apps/api/core` 模块本身，
 * 不会伪造这个全局对象，因此单测走 MemoryCache 分支 —— 正是期望行为。
 */
function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** **测试专用**：注入缓存实现（生产代码不得调用）。 */
export function __setSharedCommentCacheForTests(cache: TranslationCache | null): void {
  sharedCache = cache;
}
