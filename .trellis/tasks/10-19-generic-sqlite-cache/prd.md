# 通用本地缓存（SQLite KV + 连接池 + 迁移链归一）

> 承接 `10-19-code-comment-translation` 的遗留决策：该任务的 `PersistentCache` 已实现但未接线，
> 原因是它需要一个**通用**的本地持久化后端，而不是为翻译功能单独造一套。
> 用户 2026-10-19 定案：「既然需要缓存，就设计为一个通用的本地文件缓存，而不应该仅仅只为一个功能设计一个」。

## Goal

把 `~/.neeko/neeko.db` 从「library 域独占」提升为**全应用共享的持久化基础设施**，并在其上提供一层
与业务无关的 KV 缓存能力，供所有「内容寻址 + 产出昂贵 + 可重算」的场景复用。

具体三件事：

1. **迁移链归一**（方案 B 根治）：`user_version` 是单值，物理上无法分域管理，因此把
   12 个迁移函数从 `library/migrations.rs` 搬到 `common/db/migrations.rs`，改成分派器：
   **版本链唯一，每一步的 SQL 归各自域所有**。
2. **连接池**：消除 `Mutex<Connection>` 的全局串行，让读不再被写阻塞（WAL 下读者不互斥）。
3. **通用缓存表 + 前端通用层**：`cache_entries(namespace, key, value, version, at)` +
   `PersistentKeyValueStore<T>`（消费者注入 `validate`）。

## 非目标

| 不做 | 理由 |
| --- | --- |
| 让缓存域依赖 `library` 域 | 那违背「通用」目标；正确形态是两者都依赖 `common/db` 基础设施 |
| 后端理解缓存内容 | `value` 对后端**不透明**（TEXT，前端自己序列化/校验）。后端不做业务判断 |
| 为写入做并发优化 | SQLite 单写者模型，多写串行是特性不是缺陷 |
| 迁移链按域拆成多个版本号 | `user_version` 是单值，物理不可能；只在**注册**层面分域 |
| 把译文写回源文件 | 延续上一任务的红线（红线 11） |

## Requirements

### R1 迁移链归一（方案 B）

- R1.1 新建 `src-tauri/src/common/db/migrations.rs`，持有 **`neeko.db` 的**唯一 `LATEST_VERSION` 与
  `run_migrations(conn)`。
  （实测：项目里还有第二个库 `~/.neeko/agent_sessions.db`，它自带私有 `run_migrations`，
  **不在本期范围** —— 但它是「通用层缺位导致重复」的实证，详见 `design.md` §1.0。）
- R1.2 原 `library/migrations.rs` 的 12 个迁移函数（`migrate_v0_to_v1` … `migrate_v11_to_v12`，
  共 459 行）**移到** `common/db/migrations.rs`，不得停留在 `library` 域。
- R1.3 `run_migrations` 改为分派器，每个版本区间委派给所属域：
  ```rust
  match from_version {
      0..=11 => library::migrations::step(conn, from_version),  // 既有 12 步
      12     => cache::migrations::v12_to_v13(conn),             // 通用缓存表
      _ => bail!("unknown migration version: {from_version}"),
  }
  ```
  即：**版本链线性唯一，SQL 归属分域**。`library` 与 `cache` 各导出自己的 `step`，
  由 `common/db` 按版本号分派。
- R1.4 `user_version` 超前（> `LATEST_VERSION`）时仍按现有行为 `bail!`（拒绝降级运行）。
- R1.5 **老库可升级**：现存 v12 的 `neeko.db` 必须能原地升到 v13，且 library 全部功能不回归。
  这条必须有真实迁移测试（见 AC3）。

### R2 连接池

- R2.1 引入 `r2d2_sqlite@0.25`（同步池，DB 调用统一在 `run_blocking` 里跑）。
  **版本是硬约束，不是随便挑的**（已实测）：项目 `rusqlite = 0.32`，而 `r2d2_sqlite` 的各版本
  对 rusqlite 的要求是硬绑定 —— 0.25→^0.32、0.26→^0.33、0.27→^0.34、0.30→^0.36、0.35→^0.40。
  `cargo add r2d2_sqlite` 默认装 0.35 会与现有 rusqlite 冲突。**必须写 `@0.25`**。
  已实测 `cargo check` 通过（连带拉入 r2d2 0.8.10 / scheduled-thread-pool 0.2.7 / chacha20 等 7 个包）。
  另一个选择是同时升 rusqlite 到 0.40，但那会牵动 `bundled` 与所有 `rusqlite::params!` 调用点，
  与「消除锁」这个目标无关，不在本期范围。
- R2.2 `common/db::open_pool(db_path)` 创建池，并设置：
  - `PRAGMA journal_mode=WAL`（写一次即可，池化后不必每连接设）
  - **`PRAGMA busy_timeout`**（必有：写冲突时排队而非直接报 `SQLITE_BUSY`）
  - `PRAGMA foreign_keys=ON`
- R2.3 `LibraryStore` 从 `conn: Mutex<Connection>` 改为 `pool: Pool<SqliteConnectionManager>`。
  **替换是完整的一次性替换，不留两套连接**（两套连接对同一文件容易出「谁负责关」的问题）。
- R2.4 现有 **77 处**同一 5 行样板（`.conn.lock().map_err(|e| anyhow!("Lock poisoned: {e}"))?`）
  全部改为 `self.pool.get()?`（池取连接失败同样转 `AppError`）。
- R2.5 `AppStateWrapper.library_store` 继续持有 `Arc<LibraryStore>`；新增的 cache 门面同样从
  **同一个池**取连接，不新开第二个池。
  实现形态建议：`common/db` 暴露 `DbPool = Pool<SqliteConnectionManager>`，boot 期建一次，
  作为 `Arc<DbPool>` 注入两个门面的构造函数（`LibraryStore::with_pool(pool)` /
  `CacheStore::with_pool(pool)`）—— 与现有 `AppStateWrapper::new_with_library_store` 的
  可注入测试形态一致。
- R2.6 `open_in_memory()`（测试用）必须继续可用 —— 池化后单连接内存库的语义要保住
  （必要时用 `max_size(1)` 或共享 cache）。

### R3 通用缓存表

- R3.1 `cache_entries` 表（`cache/migrations.rs` 的 v12→v13）：
  ```sql
  CREATE TABLE IF NOT EXISTS cache_entries (
    namespace TEXT NOT NULL,
    key       TEXT NOT NULL,
    value     TEXT NOT NULL,   -- 对后端不透明；前端自行序列化（当前为 JSON）
    version   INTEGER NOT NULL,
    at        INTEGER NOT NULL,
    PRIMARY KEY (namespace, key)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_cache_entries_lru ON cache_entries(namespace, at);
  ```
- R3.2 `cache` 域（`src-tauri/src/common/cache/`，不进 `library`）提供：
  - `get_many(namespace, keys) -> Vec<(key, value)>`
  - `put_many(namespace, entries, version)` —— **单事务批量 `INSERT OR REPLACE`**
  - `evict(namespace, keep_newest_n)` —— 按 `at` 保留最新 N 条
  - `clear(namespace)` —— 整域失效（profileVersion 变更时用）
- R3.3 **原子性**：`put_many` 必须包 `BEGIN … COMMIT`（用 `rusqlite::Transaction`，
  drop 时自动 ROLLBACK，中途 `?` 提前返回天然安全）。**禁止逐条提交**（每条一次 fsync）。
- R3.4 **不在事务内做网络/LLM 调用**（持锁时间长会阻塞其他写）。事务只包 DB 语句。
- R3.5 命令层保持极薄（红线 6）：`#[tauri::command]` 只做参数校验 + 调度，逻辑落 `cache` 域。
- R3.6 阻塞 IO 隔离（红线 3）：DB 调用经 `common::runtime::run_blocking` / `run_blocking_result`
  （参照 `library/mcp/commands.rs` 的既有用法）。

### R4 前端通用层（**已完成，见状态说明**）

> **状态更新 2026-10-19**：本层在 `code-comment-translation` 的审查修复中**已提前落地**。
> 原 `comment/translationCache.ts` 自带一份 `PersistentCache`，经第一性分析发现它四个能力
> （port IO / 序列化+版本 / 显式 flush / 损坏降级）全属持久化后端职责，与注释翻译无关，
> 且绑死了 `CachedTranslation` 类型。已上移并泛型化为 `PersistentKeyValueStore<T>`。
>
> **本任务只需补齐后端的 SQLite Port 实现，不需重写通用层。**
> R4.1–R4.5 保留作为已实现契约的描述。

- R4.1 `src/shared/cache/persistentKeyValueStore.ts`（**已存在**）：
  ```ts
  export interface PersistentKeyValueStoreOptions<T extends PersistentCacheEntry> {
    port: PersistentCachePort;      // 条目粒度端口（见 R4.6）
    version: number;                // 语义由消费者定（如 profileVersion）
    maxEntries?: number;
    validate: (raw: unknown) => T | null;
  }
  ```
  方法：`get / getMany / set / setMany / flush`。
- R4.6 **Port 是条目粒度，不是整份字符串**（已定案，与初版不同）：
  ```ts
  export interface PersistentCachePort {
    load(): Promise<CacheSnapshot<unknown> | null>;
    putMany(entries: ReadonlyArray<readonly [string, unknown]>): Promise<void>;
    deleteMany(keys: readonly string[]): Promise<void>;
  }
  ```
  **理由**：初版是 `read()/write(整份字符串)`，把「序列化整份缓存」焊进了调用方 ——
  换成 SQLite 后每次 flush 会退化成全表 DELETE + 全表 INSERT，写放大且丢掉增量能力。
  条目粒度下：文件后端内部合并后整份落盘（一行胶水），SQLite 后端直接 `INSERT OR REPLACE` 事务。
- R4.2 **脏标记 + 显式 flush**：`set` 只置脏，批次结束调 `flush` 一次性落盘
  （沿用现有 `PersistentCache` 已验证的设计，避免写放大）。
- R4.3 **损坏/版本不符 → 静默降级为空**（缓存丢失只损失金钱，阻断主流程损失信任）。
  单条 `validate` 失败则丢弃该条，不整体失效。
- R4.4 LRU 淘汰：`flush` 时若超 `maxEntries`，调后端 `evict`。
- R4.5 `invoke` 只出现在 `shared/cache/api/`（红线：API wrapper 外的 invoke 被 ESLint 拦）。

### R5 消费者接入

- R5.1 **注释翻译**：`comment/translationCache.ts` 只保留 `CachedTranslation` 形状与 `cacheKey`
  （**已完成**，215 → 102 行）；持久化实现已上移，`MemoryCache` 保留作测试桩。
- R5.2 接线点：`hooks/commentTranslationCacheSingleton.ts` 当前 `new MemoryCache()`；
  本任务改为注入 **SQLite Port 实现**的 `PersistentKeyValueStore`。
- R5.3 **文档翻译**（`features/editor/translation/`）当前**完全没有缓存层**，每次重翻。
  本期**只保留接口对接位**，实际接入见非目标说明 —— 它是另一个域的新能力，
  与基础设施改动混在一起会让验证面失控。

### R6 边界与红线

- R6.1 相对上一任务的 PRD R8.5「Rust 0 改动」：本任务**显式放宽**为
  「Rust 只新增通用缓存能力（`common/db` + `common/cache`），**不含任何翻译业务逻辑**」。
  翻译语义（profileVersion、段/组、校验规则）一律留在前端。
- R6.2 库表不得出现翻译域概念（无 `segment`/`profile`/`translation` 列名或表名）。
- R6.3 单次 Command 返回 ≤ 2MB（红线 4）：`get_many` 需分页或限制批大小。

## 实测事实（写 PRD 时已验证，不要重复试错）

| 事实 | 证据 |
| --- | --- |
| `r2d2_sqlite` 必须用 `0.25` | 各版本 rusqlite 绑定已逐个查证；`cargo add r2d2_sqlite@0.25` + `cargo check` 已实测通过（退出码 0） |
| `LibraryStore` 的锁样板是 **77 处**（不是 81 个方法），且**零变体** | `grep -c "Lock poisoned"` = 77；`let mut conn = self` 命中 0；无 `.as_ref()` 变体 → 可机械替换 |
| 迁移链是 **459 行 / 12 个函数**，不是小文件 | `wc -l library/migrations.rs` = 459；`grep -c "^fn migrate_v"` = 12 |
| `AppStateWrapper` 已持有唯一 `Arc<LibraryStore>`，boot 期打开一次 | `app_state.rs:50`、`boot.rs:64-83`；迁移链现状在 `library/migrations.rs`（`LATEST_VERSION = 12`） |
| 项目已有 `common/db.rs` 统一打开点（WAL + foreign_keys） | 只需扩展，不需新建打开逻辑 |
| `run_blocking` / `run_blocking_result` 已存在 | `common/runtime.rs:94/108`，`library/mcp/commands.rs` 是现成用法参照 |

## Acceptance Criteria

### 迁移链归一

- [ ] AC1 `LATEST_VERSION` 与 `run_migrations` 只存在于 `common/db/migrations.rs`；
      `library/migrations.rs` 不再持有版本链，只导出 `step(conn, from)`。
- [ ] AC2 分派器覆盖 `0..=11 → library`、`12 → cache`；未知版本 `bail!`；超前版本拒绝降级。
- [ ] AC3 **真实升级测试**：构造一个 v12 的库（跑完 12 步），再跑新 `run_migrations`，
      断言升到 v13、`cache_entries` 存在、且 library 的 `skills`/`prompts`/`mcp_servers`
      等表数据**逐行不变**。
      → 现成的测试入口：`LibraryStore::open_in_memory()` 已会跑完整迁移链，可直接复用为夹具。

### 连接池

- [ ] AC4 `LibraryStore` 与 cache 门面共用**同一个池**（同一 `Pool` 实例，不是两个）。
- [ ] AC5 77 处样板全部替换，仓库内 `Lock poisoned` 在 `library/store.rs` 中**零出现**。
- [ ] AC6 `open_in_memory()` 仍可用（内存库测试全绿）。
- [ ] AC7 并发读不被写阻塞：一条用例在写事务进行中发起读，断言读在写提交前完成
      （WAL + 池的直接验证；若时序不可靠则退化为「读不报 `SQLITE_BUSY`」的断言）。
      **注意**：内存库（`open_in_memory`）下池化语义与文件库不同（每次 `Connection::open_in_memory()`
      是新库），AC6 与 AC7 可能冲突 —— 若冲突，AC7 改用临时目录的真实文件库
      （`tempdir()`，红线 13：夹具路径必须由 `tempdir()` 推导）。

### 原子性与批量

- [ ] AC8 `put_many` 单事务：中途失败（注入非法值）→ 断言**整批零写入**（不是部分写入）。
- [ ] AC9 `put_many` 不为每条提交：用 `Connection::total_changes` 或语句计数断言只有一次事务
      （禁止逐条 fsync）。
- [ ] AC10 `evict(namespace, n)` 按 `at` 保留最新 n 条，其他 namespace 不受影响。
- [ ] AC11 `clear(namespace)` 只清该域。

### 前端通用层

- [x] AC12 脏标记语义：连续 `set` 不触发写；`flush` 才落盘（**已完成**，假 port 计数断言）。
- [x] AC13 损坏/版本不符 → 空缓存且不抛（`validate` 抛异常也不得冒泡）—— **已完成**。
- [x] AC14 单条 `validate` 失败只丢该条，其余保留 —— **已完成**（夹具必须含好条与坏条共存，
      否则「丢该条」与「整份作废」结果相同，用例无判别力 —— 首版正是如此，被变异验证抓到）。
- [x] AC15 LRU：超 `maxEntries` 后最旧条目被淘汰 —— **已完成**。
- [x] AC15b 写失败后 `dirty` 保留，下次 flush 重试 —— **已完成**（变异验证抓到的缺口：
      写失败后若清 dirty，该批数据永不落盘，且表面无任何错误）。
- [x] AC15c 前端通用层共 **16 条测试**（`src/shared/cache/__tests__/persistentKeyValueStore.test.ts`），
      四条变异验证均红。

### 消费者

- [ ] AC16 注释翻译生产路径走持久化实现；同一文件第二次翻译 `cacheHits > 0` 且 `turn` 零调用
      （跨「进程重启」语义：新建 store 实例后仍命中）。
- [ ] AC17 `MemoryCache` 仍可注入（测试桩不受影响）。

### 质量

- [ ] AC18 `pnpm check` 全绿（31 条护栏）；`cargo clippy --all-targets` 零 warning。
- [ ] AC19 每条护栏用例做**变异验证**：回退修复后必须变红（绿色不构成证据）。
- [ ] AC20 `cargo test` 覆盖：迁移升级、池共享、事务原子性、evict 边界。
