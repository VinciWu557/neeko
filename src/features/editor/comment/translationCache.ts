/**
 * 译文缓存（端口 + 注入）—— **增量能力的唯一来源**。
 *
 * ## 为什么缓存键必须含 `profileVersion`
 *
 * 改 prompt 或加强校验规则后，旧条目若继续命中会**遮蔽**新规则：表现为「规则改了但线上
 * 行为没变」。这是最难定位的一类 bug（没有任何报错，只是新逻辑不生效）。
 * 因此 profile 版本是键的一部分，规则变更必须 +1 版本。
 *
 * ## 为什么碰撞是可用性问题而非正确性问题
 *
 * 地址是短哈希（32 位 × 2），理论上会碰撞。但缓存条目同时保存 `source` 原文，
 * 读取方**逐字节比对**：不一致就当作 miss。碰撞的代价是「少命中一次」，不是「拿到错译文」。
 *
 * ## 为什么存储是端口
 *
 * 引擎不该知道译文存在哪（内存 / 文件 / 远端）。测试注入内存实现，生产注入持久化实现，
 * 引擎代码零分支。这是「低耦合」在本模块的落点。
 *
 * ## 持久化实现不在这里
 *
 * 本模块曾自带一份 `PersistentCache`（整文件 JSON + 版本校验 + 脏标记 + 淘汰）。那是把它
 * **放错了层**：四个能力全是持久化后端的职责，与「注释翻译」无关，且绑死了 `CachedTranslation`
 * 类型 —— 第二个消费者（文档翻译）接手时必须重写一遍。现已上移到
 * `@/shared/cache/persistentKeyValueStore`（泛型 `PersistentKeyValueStore<T>`）。
 *
 * 本模块只保留**业务侧**的两件事：`CachedTranslation` 形状与 `cacheKey`（含 profileVersion）。
 */

/** 缓存条目。 */
export interface CachedTranslation {
  /** 原文（碰撞校验 + 可重建），逐字节比对。 */
  source: string;
  /** 译文。 */
  text: string;
  /** 写入时间（epoch ms），LRU 淘汰用。 */
  at: number;
}

/** 缓存端口。 */
export interface TranslationCache {
  get(key: string): Promise<CachedTranslation | null>;
  set(key: string, value: CachedTranslation): Promise<void>;
  /** 批量读；缺失的键不出现在返回 Map 中。 */
  getMany(keys: readonly string[]): Promise<Map<string, CachedTranslation>>;
  /** 批量写（实现可在此做一次落盘）。 */
  setMany(entries: ReadonlyArray<readonly [string, CachedTranslation]>): Promise<void>;
}

/**
 * 缓存键：`profileVersion | targetLanguage | address`。
 *
 * 三段用 `\u0000` 分隔而不是 `|`：语言标识里可能含 `|`（罕见但合法），
 * 用可见分隔符会让 `('a|b','c')` 与 `('a','b|c')` 撞键。
 */
export function cacheKey(profileVersion: string, targetLanguage: string, address: string): string {
  return `${profileVersion}\u0000${targetLanguage}\u0000${address}`;
}

/** 当前 prompt / 校验策略的版本。**改规则必须 +1**，否则旧缓存会遮蔽新规则。 */
export const COMMENT_TRANSLATION_PROFILE = 'comment-p1';

/** 进程内实现：既有会话用，也是测试默认桩。 */
export class MemoryCache implements TranslationCache {
  private readonly map = new Map<string, CachedTranslation>();

  constructor(private readonly maxEntries = 5000) {}

  async get(key: string): Promise<CachedTranslation | null> {
    return this.map.get(key) ?? null;
  }

  async set(key: string, value: CachedTranslation): Promise<void> {
    this.map.set(key, value);
    this.evict();
  }

  async getMany(keys: readonly string[]): Promise<Map<string, CachedTranslation>> {
    const hits = new Map<string, CachedTranslation>();
    for (const key of keys) {
      const hit = this.map.get(key);
      if (hit) hits.set(key, hit);
    }
    return hits;
  }

  async setMany(entries: ReadonlyArray<readonly [string, CachedTranslation]>): Promise<void> {
    for (const [key, value] of entries) this.map.set(key, value);
    this.evict();
  }

  /** 按写入时间淘汰最旧条目（Map 保序 + `at` 双保险：批量写入时 `at` 可能相同）。 */
  private evict(): void {
    if (this.map.size <= this.maxEntries) return;
    const sorted = [...this.map.entries()].sort((a, b) => a[1].at - b[1].at);
    const excess = this.map.size - this.maxEntries;
    for (let i = 0; i < excess; i++) {
      const entry = sorted[i];
      if (entry) this.map.delete(entry[0]);
    }
  }
}
