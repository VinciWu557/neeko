/**
 * 持久化 KV 缓存的**通用实现**（与业务无关）。
 *
 * ## 为什么在 `shared/` 而不是某个 feature 里
 *
 * 这套能力最初写在 `features/editor/comment/translationCache.ts` 的 `PersistentCache` 里，
 * 但它四个独有能力 —— port IO、序列化+版本、显式 flush、损坏静默降级 —— **全是持久化后端的
 * 职责，与注释翻译无关**。留在 feature 里意味着第二个消费者（文档翻译）要重写一遍：
 * 脏标记、结构校验、LRU、降级策略，每一处都是容易写错的地方（降级写错会阻断主流程）。
 *
 * 所以按「能力归属」把它上移并**泛型化**：业务类型由消费者以 `T` 注入，
 * 结构校验由消费者以 `validate` 注入。本模块不认识任何业务概念。
 *
 * ## 与后端存储的关系（重要）
 *
 * 本模块只依赖 `PersistentCachePort`（读一个字符串 / 写一个字符串），**不关心**底层是
 * JSON 文件、SQLite、还是 localStorage。换后端 = 换一个 `Port` 实现，本模块零改动。
 *
 * ## 为什么不用 Map 的插入序做 LRU
 *
 * `Map` 保序是插入序，不是**访问**序。真正的 LRU 要在 `get` 时把键移到末尾 —— 但缓存条目
 * 自带 `at`（写入时间），按 `at` 排序既简单又不需要改 `get` 的语义。这里选「按写入时间
 * 淘汰」（更接近 TTL 语义），并在文档里写明，避免有人误以为这是 LRU。
 */

/** 缓存条目必须满足的最小形状（`at` 用于淘汰排序）。 */
export interface PersistentCacheEntry {
  /** 写入时间（epoch ms），淘汰排序用。 */
  at: number;
}

/**
 * 持久化后端端口 —— **按条目粒度**，不是整份文件。
 *
 * ## 为什么不是 `read()/write(整份字符串)`
 *
 * 首版接口是「读一个字符串 / 写一个字符串」，它把「序列化整份缓存」这件事焊进了调用方：
 * 每次 flush 都要 `JSON.stringify(全部条目)` 并整份重写。这对文件后端能忍，但换成
 * SQLite 就变成「全表 DELETE + 全表 INSERT」，写放大且丢弃了关系库的增量能力。
 *
 * 改成条目粒度后：
 * - 文件后端：内部自己维护 `Record<key,T>`，`putMany` 时合并再整份落盘（一行胶水）；
 * - SQLite 后端：`putMany` → 一条 `INSERT OR REPLACE` 事务，`list` → 按 namespace 查。
 *
 * 两者都不需要调用方知道对方的存在。
 */
export interface PersistentCachePort {
  /**
   * 读出该后端的全部条目（或该 namespace 的全部）。
   *
   * 返回 `{ version, entries }`；版本不符由调用方判定为 miss。
   * 后端**不解释** `value` 的业务含义。
   */
  load(): Promise<CacheSnapshot<unknown> | null>;
  /** 批量写入（增量语义：只覆盖给出的键，其余保持不变）。 */
  putMany(entries: ReadonlyArray<readonly [string, unknown]>): Promise<void>;
  /** 删除指定键（淘汰用）。 */
  deleteMany(keys: readonly string[]): Promise<void>;
}

/** 后端快照形状。 */
export interface CacheSnapshot<T> {
  /** 格式/业务版本（由写入方决定含义）。 */
  version: number;
  entries: Record<string, T>;
}

/** 构造参数。 */
export interface PersistentKeyValueStoreOptions<T extends PersistentCacheEntry> {
  /** 存储后端（条目粒度）。 */
  port: PersistentCachePort;
  /**
   * 版本。写入时随快照记录，读取时不符即视为 miss。
   *
   * 语义由消费者决定（如注释翻译用 `profileVersion`：改 prompt/校验规则就换版本，
   * 旧条目自然失效，不必删表）。
   */
  version: number;
  /** 条目数上限（超出按 `at` 淘汰最旧的）。 */
  maxEntries?: number;
  /** 把 unknown 收窄为 `T`；返回 null 表示该条不合法（丢弃该条，不整体失效）。 */
  validate: (raw: unknown) => T | null;
}

/** 默认上限：5000 条对翻译类缓存足够（约 1MB 量级）。 */
const DEFAULT_MAX_ENTRIES = 5000;

/**
 * 通用持久化 KV 缓存。
 *
 * **写时机**：`set` / `setMany` 只写内存并置脏，`flush` 才落盘。理由：批量场景（翻译按批走）
 * 逐次落盘会造成写放大并叠加持锁时间。
 *
 * **降级原则**：任何异常（读失败、JSON 坏、版本不符、`validate` 抛异常）都降级为空/丢弃该条，
 * **绝不抛给调用方** —— 缓存丢失只损失性能，阻断主流程损失信任。
 */
export class PersistentKeyValueStore<T extends PersistentCacheEntry> {
  private map: Map<string, T> | null = null;
  private dirty = false;
  /** Keys changed since the last flush (written or overwritten). */
  private pendingKeys = new Set<string>();
  /** 待删除的键（淘汰产生）。flush 时一并提交。 */
  private pendingDeletes: string[] = [];
  private readonly maxEntries: number;

  constructor(private readonly options: PersistentKeyValueStoreOptions<T>) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /**
   * 惰性载入。首次访问才读盘 —— 构造是同步的，读盘是异步的。
   *
   * 失败/损坏/版本不符 → 空表（不抛）。
   */
  private async load(): Promise<Map<string, T>> {
    if (this.map) return this.map;
    this.map = new Map();
    let parsed: unknown;
    // `try` 只包「读取 + 解析」—— 不能让单条 `validate` 的异常落到这里，
    // 否则一条坏数据的后果会从「丢该条」放大成「整份缓存作废」。
    try {
      const snapshot = await this.options.port.load();
      if (!snapshot) return this.map;
      parsed = snapshot;
    } catch {
      // 读失败 / JSON 坏 → 空表。缓存可重算，不能阻断主流程
      this.map = new Map();
      return this.map;
    }

    if (!this.isCacheFile(parsed)) return this.map;
    if (parsed.version !== this.options.version) return this.map;

    for (const [key, value] of Object.entries(parsed.entries)) {
      // 单条不合法只丢该条 —— 一条坏数据不该让整份缓存作废
      const valid = this.safeValidate(value);
      if (valid !== null) this.map.set(key, valid);
    }
    return this.map;
  }

  /**
   * 调用消费者的 `validate`，吞掉它抛出的异常。
   *
   * `validate` 是外部注入的，它抛异常不该炸掉整个缓存读取（这条最容易被漏 ——
   * 只测「返回 null」不测「抛异常」时，生产会把一次坏数据放大成「缓存整体不可用」）。
   */
  private safeValidate(raw: unknown): T | null {
    try {
      return this.options.validate(raw);
    } catch {
      return null;
    }
  }

  private isCacheFile(value: unknown): value is CacheSnapshot<unknown> {
    if (typeof value !== 'object' || value === null) return false;
    const shape = value as Partial<CacheSnapshot<unknown>>;
    return (
      typeof shape.version === 'number' &&
      typeof shape.entries === 'object' &&
      shape.entries !== null
    );
  }

  async get(key: string): Promise<T | null> {
    return (await this.load()).get(key) ?? null;
  }

  async set(key: string, value: T): Promise<void> {
    const map = await this.load();
    map.set(key, value);
    this.dirty = true;
    this.pendingKeys.add(key);
    this.evict(map);
  }

  async getMany(keys: readonly string[]): Promise<Map<string, T>> {
    const map = await this.load();
    const hits = new Map<string, T>();
    for (const key of keys) {
      const hit = map.get(key);
      if (hit) hits.set(key, hit);
    }
    return hits;
  }

  async setMany(entries: ReadonlyArray<readonly [string, T]>): Promise<void> {
    const map = await this.load();
    for (const [key, value] of entries) {
      map.set(key, value);
      this.pendingKeys.add(key);
    }
    this.dirty = true;
    this.evict(map);
    await this.flush();
  }

  /**
   * 显式落盘（作业结束时调用一次）。
   *
   * 失败只降级为「本次不持久化」，内存命中仍然生效 —— 不抛。
   */
  async flush(): Promise<void> {
    if (!this.dirty || !this.map) return;
    try {
      // 只提交自上次 flush 起**变更过**的键。整份重写会让 SQLite 后端每批都把
      // 全部已有条目重新 INSERT 一遍 —— 会话越久，单批写入量越大，正是
      // `PersistentCachePort` 从「整份字符串」改成「条目粒度」要避免的写放大。
      await this.options.port.putMany(this.pendingEntries());
      if (this.pendingDeletes.length > 0) {
        await this.options.port.deleteMany(this.pendingDeletes);
      }
      this.dirty = false;
      this.pendingKeys.clear();
      this.pendingDeletes = [];
    } catch {
      // 落盘失败只降级为「本次不持久化」——内存命中仍然生效。
      // `dirty` / `pendingKeys` 保留，下次 flush 重试（清了这批数据就永不落盘）。
    }
  }

  /** 自上次 flush 起变更过的条目（不是整张表）。 */
  private pendingEntries(): Array<readonly [string, unknown]> {
    if (!this.map) return [];
    const out: Array<readonly [string, unknown]> = [];
    for (const key of this.pendingKeys) {
      const value = this.map.get(key);
      // 键可能已被本轮淘汰掉 —— 它走了 pendingDeletes，不再是待写入项。
      if (value !== undefined) out.push([key, value]);
    }
    return out;
  }

  /** 按写入时间淘汰最旧条目。 */
  private evict(map: Map<string, T>): void {
    if (map.size <= this.maxEntries) return;
    const sorted = [...map.entries()].sort((a, b) => a[1].at - b[1].at);
    const excess = map.size - this.maxEntries;
    for (let i = 0; i < excess; i++) {
      const entry = sorted[i];
      if (entry) {
        map.delete(entry[0]);
        this.pendingDeletes.push(entry[0]);
      }
    }
  }
}
