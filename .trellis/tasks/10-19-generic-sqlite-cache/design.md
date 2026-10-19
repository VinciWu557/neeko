# 设计：通用本地缓存（SQLite KV + 连接池 + 迁移链归一）

> 需求见 [`prd.md`](prd.md)。本文只谈**怎么落**与**为什么这样落**，不复述需求。

## 0. 一句话形态

```
                  boot 期一次
                       │
        ┌──────────────┴──────────────┐
        │   common/db::open_pool()    │   ← 唯一池、唯一迁移链
        │   Arc<DbPool> + user_version│
        └──────────────┬──────────────┘
                       │  inject
        ┌──────────────┴──────────────┐
        │                             │
  LibraryStore                  CacheStore
  (library 域的表)               (cache_entries)
        │                             │
   skills/prompts/…              任何域的 KV（value 不透明）
                                       │
                              Tauri 命令（薄）
                                       │
                              shared/cache/（前端通用层）
                                       │
                        ┌──────────────┴──────────────┐
                   注释翻译                      文档翻译（二期）
```

**核心不变式**：`common/db` 不认识任何业务；`library` 与 `cache` 互不依赖，只共享池。

---

## 1. 迁移链归一（方案 B）

### 1.0 现状：项目里已有**两个**独立 SQLite 库（实测）

这条不是背景装饰，它决定了「通用基础设施」是真实需求而非过度设计：

| 库 | 文件 | 迁移 | 连接管理 |
| --- | --- | --- | --- |
| library | `~/.neeko/neeko.db` | `library/migrations.rs`，`user_version` v0→v12 | `Mutex<Connection>` |
| agent 会话 | `~/.neeko/agent_sessions.db` | `agent/chat/session_store.rs` 的**私有** `run_migrations` | `Mutex<Connection>` |

两者都经 `common::db::open` / `open_in_memory` 打开（这层已是共享的），但**迁移链与连接管理
各写一套**。本任务只归一 `neeko.db` 那条链（13 步、459 行、有版本链）；
`agent_sessions.db` 的私有迁移**不在本期范围**，但它证明了「通用层缺位」是重复，不是理论。

→ 后续若要把 `agent_sessions.db` 也纳入，`common/db` 已提供池与迁移入口，只需再加一个
`open_pool` 调用点，不需要第三套基础设施。

### 1.1 为什么必须搬，而不是「在 library 里加一张表」

`user_version` 是 SQLite 的**单值 pragma**，一个库只有一个版本号。若把 `cache_entries` 的建表
塞进 `library/migrations.rs` 的 v13 步，会产生两个后果：

1. **表归属错乱**：`cache_entries` 与 skills/MCP 毫无语义关系，却由 library 域负责演进。
2. **依赖方向错**：cache 域若要自己迁移，就得依赖 library 域 —— 与「通用」目标直接冲突。

方案 B 把**版本链**与**SQL 归属**解耦：

- 版本链（`LATEST_VERSION` + 循环 + 事务 + 超前拒绝）→ `common/db/migrations.rs`，唯一一份；
- 每一步的 SQL → 各自域的文件，`common/db` 只按版本号分派。

### 1.2 目标文件布局

```
src-tauri/src/common/db/
  mod.rs            ← pub use open / open_in_memory / open_pool / 迁移入口
  pool.rs           ← DbPool 类型 + open_pool() + PRAGMA 设置
  migrations.rs     ← LATEST_VERSION + run_migrations() 分派器

src-tauri/src/library/migrations.rs
  ← 只保留 step(conn, from_version) 分派到 12 个既有函数（函数体一字不改）

src-tauri/src/common/cache/
  mod.rs            ← pub use
  migrations.rs     ← v12_to_v13（建 cache_entries）
  store.rs          ← CacheStore（get_many / put_many / evict / clear）
  commands.rs       ← #[tauri::command] 薄命令
```

### 1.3 分派器（关键代码形态）

```rust
// common/db/migrations.rs
pub const LATEST_VERSION: u32 = 13;

pub fn run_migrations(conn: &mut Connection) -> Result<()> {
    let current: u32 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if current > LATEST_VERSION { bail!("…newer than supported…"); }
    if current == LATEST_VERSION { return Ok(()); }

    for version in current..LATEST_VERSION {
        let tx = conn.transaction()?;          // 每步一个事务（保持现有语义）
        migrate_step(&tx, version)?;
        tx.pragma_update(None, "user_version", version + 1)?;
        tx.commit()?;
    }
    Ok(())
}

fn migrate_step(conn: &Connection, from: u32) -> Result<()> {
    if from <= 11 { crate::library::migrations::step(conn, from) }
    else if from == 12 { crate::common::cache::migrations::v12_to_v13(conn) }
    else { bail!("unknown migration version: {from}") }
}
```

**与现状的两处差异（必须显式承认）**：

1. `run_migrations` 的签名从 `&Connection` 改为 `&mut Connection` —— `conn.transaction()` 需要
   `&mut`。现有实现用 `execute_batch("BEGIN EXCLUSIVE")` 绕开了这一点，但那等于手写事务管理，
   错误分支要自己 ROLLBACK。改用 `Transaction` 后 drop 自动回滚，代码更少也更强。
   **改动面（已实测）**：生产 2 处（`LibraryStore::open` / `open_in_memory`）
   + 测试 3 处（`library/migrations.rs` 的 `run_migrations(&conn)` 用例）。
   注意 `agent/chat/session_store.rs` 有自己的同名私有 `run_migrations`，**与本链无关**，不要动错。
2. 现有实现用 `BEGIN EXCLUSIVE`，新版用 `BEGIN IMMEDIATE`（`Transaction` 默认）或
   `transaction_with_behavior(TransactionBehavior::Exclusive)`。**保留 EXCLUSIVE**：
   它阻止其他**写者**在迁移期间插入（WAL 下读者不阻塞 —— 读到的是迁移前的快照，
   不会看到半迁移状态，所以「不让读者读」既非必需也做不到，见 §1.3.1）。

### 1.3.1 WAL 下 EXCLUSIVE 的真实作用域（实测）

写了「EXCLUSIVE 阻止其他连接读」的测试，跑出来是**绿**，探针实测确认这是 SQLite 行为而
非测试写错：

| journal_mode | EXCLUSIVE 持有期间，另一连接 `SELECT` |
| --- | --- |
| WAL | **成功**（`Ok(0)`）—— 读者拿迁移前快照 |
| DELETE | 失败（`DatabaseBusy`，database is locked） |

`neeko.db` 用的是 WAL（`common/db::open` 显式设置），所以：

- **EXCLUSIVE 的价值在写侧**：阻止其他写者在迁移中途插入 DDL/DML，避免两个写者交错。
- **读者不受影响，也不需要受影响**：WAL 的读者看到 begin 时刻的一致快照，不会观察半迁移
  schema。想「让读者也等」既做不到，也无必要。
- **因此不写「读者必须被拒」的测试** —— 那是错的判据，只会绿得毫无意义。真正该钳住的是
  **每步原子性**（失败不推进 `user_version`、不留半张表），见 `atomicity_tests`。

### 1.4 现有 12 步不重写

`library/migrations.rs` 的 459 行整体保留，只把 `LATEST_VERSION` 与 `run_migrations` 移走，
留下 `step(conn, from)`。函数体一个字不改 —— 迁移 SQL 是最不该顺手重构的东西。

---

## 2. 连接池

### 2.1 为什么 `r2d2_sqlite@0.25`

已在 PRD「实测事实」表记录：各版本对 rusqlite 硬绑定，0.25 才匹配现有的 `rusqlite 0.32`。
`cargo add` 默认装 0.35（要求 `^0.40`）会冲突。

**`r2d2` 必须单独声明为直接依赖**（已实测）：只写 `r2d2_sqlite` 会报
`cannot find module or crate r2d2` —— Rust 2018+ 不允许使用未在 `Cargo.toml` 声明的 crate，
哪怕是别人的传递依赖。所以两行都要加：

```toml
r2d2 = "0.8"
r2d2_sqlite = "0.25"
```

已用最小探针实测编译通过（`with_init` / `Pool::builder().max_size()` /
`transaction_with_behavior(Exclusive)` 三个 API 形态均正确）。

### 2.2 为什么池真的解决问题（而不是心理安慰）

`Mutex<Connection>` 的问题不是「锁开销」，是**语义串行**：

| 操作 | Mutex 单连接 | 池 + WAL |
| --- | --- | --- |
| 两个读并发 | 排队 | 并行（WAL 读者不互斥） |
| 读遇到写 | 阻塞到写完成 | 读快照，不阻塞 |
| 两个写并发 | 排队 | **仍排队**（SQLite 单写者） |

第三行是关键：**池不能加速写**。它只让读不被写挡住。对当前场景（翻译批次结束时写一次、
平时读多）这个收益是实的；如果将来变成写密集，池帮不上忙，那时该考虑的是批量合并而非加池。

### 2.3 池配置

```rust
pub type DbPool = Pool<SqliteConnectionManager>;

pub fn open_pool(db_path: &Path, max_size: u32) -> Result<DbPool> {
    let manager = SqliteConnectionManager::file(db_path)
        .with_init(|c| {
            // busy_timeout 必须在**每个**新连接上设（PRAGMA 是连接级的）
            c.execute_batch(
                "PRAGMA journal_mode=WAL;\
                 PRAGMA busy_timeout=5000;\
                 PRAGMA foreign_keys=ON;",
            )
        });
    Ok(Pool::builder().max_size(max_size).build(manager)?)
}
```

**`with_init` 而非只在建池时设一次**：`busy_timeout` / `foreign_keys` 都是连接级 pragma，
池会新建连接，漏设会让新连接失去超时与约束。这是最容易踩的坑。
`journal_mode=WAL` 是库级（持久化在文件头），重复设无害。

### 2.4 内存库（AC6）

`SqliteConnectionManager::memory()` 每次新建连接 = 一个新库 → 池化后数据不共享。
解法：内存库固定 `max_size(1)`，并在测试里接受「单连接」语义（AC6）。

若某测试需要多连接的内存库，用 `SqliteConnectionManager::file("file:memdb1?mode=memory&cache=shared")`
—— 但**只在确有需要时**，不要默认用共享缓存 URI（它会跨测试串数据）。

### 2.5 77 处替换

形态零变体（已验证），sed 可机械替换：

```rust
// before（5 行，77 处）
let conn = self
    .conn
    .lock()
    .map_err(|e| anyhow::anyhow!("Lock poisoned: {e}"))?;

// after（1 行）
let conn = self.pool.get()?;
```

`r2d2::Error` → `anyhow::Result` 有现成 `From`（`r2d2::Error: std::error::Error`），
`?` 直接可用。

**但事务方法要单独处理**：涉及 `conn.transaction()` 的方法需要 `let mut conn = ...`。
现有 0 处，但新增的 cache 侧会用到。

---

## 3. CacheStore（后端）

### 3.1 表结构

PRD R3.1 已给。补两点设计理由：

- **`WITHOUT ROWID`**：主键就是查询路径（`namespace + key`），省一层隐式 rowid 索引。
  插入性能略低但读写路径更短，对「读多写少」的缓存是正收益。
- **`idx_cache_entries_lru(namespace, at)`**：`evict` 与 LRU 淘汰都按此索引，否则退化成全表扫。

### 3.2 事务形态（AC8/AC9）

```rust
pub fn put_many(&self, namespace: &str, entries: &[(String, String)], version: i64) -> Result<()> {
    let mut conn = self.pool.get()?;
    let tx = conn.transaction()?;                    // BEGIN
    {
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO cache_entries(namespace,key,value,version,at)
             VALUES (?1,?2,?3,?4,?5)",
        )?;
        let now = now_ms();
        for (key, value) in entries {
            stmt.execute(params![namespace, key, value, version, now])?;
        }
    }                                                // stmt 必须在 commit 前释放
    tx.commit()?;                                    // COMMIT
    Ok(())
}
```

**两个易错点**：
1. `stmt` 必须在大括号内 drop，否则 `tx.commit()` 报 `stmt is borrowed`。
2. 中途 `?` 提前返回 → `tx` drop → 自动 ROLLBACK → 整批零写入（AC8 正是测这个）。

### 3.3 `now_ms()`

`at` 用 `SystemTime::now().duration_since(UNIX_EPOCH)`。**注入时钟便于测试**：
`put_many_at(…, at)` 内部方法 + 公开的 `put_many` 调它 —— 否则 evict 的边界用例要靠 sleep，不稳定。

### 3.4 命令层（红线 6 / 红线 3）

```rust
#[tauri::command]
pub async fn cache_put_many(
    state: State<'_, AppStateWrapper>,
    namespace: String,
    entries: Vec<(String, String)>,
    version: i64,
) -> Result<(), AppError> {
    validate_namespace(&namespace)?;                       // 参数校验
    let store = Arc::clone(&state.cache_store);
    run_blocking_result(move || store.put_many(&namespace, &entries, version)).await
}
```

`validate_namespace`：只允许 `[a-z0-9._-]`，长度 ≤ 64。**理由**：namespace 会成为 SQL 参数
（不拼串，注入安全），但限制字符集能防「同一个域被两个写法分裂」（`Comment` vs `comment`）。

批次大小上限：`entries.len() <= 5000`，超了报错。红线 4 的 2MB 边界在此拦截。

---

## 4. 前端通用层（**已落地，本节改为「剩余工作」**）

> **2026-10-19 状态变更**：这一层已在 `code-comment-translation` 的审查修复中提前完成。
> 触发点是第一性分析：`comment/translationCache.ts` 里那份 `PersistentCache` 的四个能力
> （port IO / 序列化+版本 / 显式 flush / 损坏降级）**全属持久化后端职责**，与注释翻译无关，
> 且绑死了 `CachedTranslation` 类型。留在 feature 里意味着第二个消费者要重写一遍，
> 而降级策略写错会阻断主流程 —— 那是本仓库最贵的一类重写。
>
> 实际形态：`src/shared/cache/persistentKeyValueStore.ts`，
> `PersistentKeyValueStore<T extends PersistentCacheEntry>`，16 条测试。

### 4.1 已落地的契约（不要重写）

```ts
export interface PersistentCacheEntry { at: number }

export interface CacheSnapshot<T> { version: number; entries: Record<string, T> }

export interface PersistentCachePort {
  load(): Promise<CacheSnapshot<unknown> | null>;
  putMany(entries: ReadonlyArray<readonly [string, unknown]>): Promise<void>;
  deleteMany(keys: readonly string[]): Promise<void>;
}

export interface PersistentKeyValueStoreOptions<T extends PersistentCacheEntry> {
  port: PersistentCachePort;
  version: number;
  maxEntries?: number;
  validate: (raw: unknown) => T | null;
}
```

**Port 是条目粒度，不是整份字符串** —— 这是落地过程中改掉的原设计。初版
`read()/write(整份字符串)` 把「序列化整份缓存」焊进了调用方：文件后端能忍，但 SQLite
会退化成「全表 DELETE + 全表 INSERT」，写放大且丢掉增量能力。改条目粒度后两种后端各自
自然表达（文件后端内部合并后整份落盘，SQLite 走 `INSERT OR REPLACE` 事务）。

### 4.2 本任务剩余工作：文件 Port 与 SQLite Port

```
src/shared/cache/
  persistentKeyValueStore.ts     ✅ 已存在（通用逻辑）
  ports/filePort.ts              ← 本任务：单文件 JSON（替换旧 PersistentCache 的用法）
  ports/sqlitePort.ts            ← 本任务：调 Tauri 命令
  api/cacheApi.ts                ← 本任务：invoke 封装（红线：invoke 只在这里）
```

两个 Port 都只是**薄适配**，几十行：

- `filePort`：`load` 读整文件解析；`putMany` 合并进内存 Record 后整份写回。
  （若将来不需要文件后端，可只做 SQLite。）
- `sqlitePort`：`load` → `cache_get_many(namespace, [])`；`putMany` → `cache_put_many`；
  `deleteMany` → 后端 `cache_evict` 或专用删除命令。

**namespace 归 Port 管，不归通用层管**。通用层刻意不知道 namespace（它只是一个 KV store）；
`sqlitePort` 构造时接收 namespace，转发时带上。这样通用层保持零业务、零分区概念。

### 4.3 为什么不给通用层加 namespace

考虑过把 `namespace` 加进 `PersistentKeyValueStoreOptions`，但那是把存储后端的**分区概念**
泄漏进缓存逻辑层：文件后端根本不需要它（一个文件就是一个 namespace），加上它会让文件后端
多一个「必须与非空值」的约束。正确位置是 Port 构造参数。

## 5. 风险与已知取舍

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| `run_migrations` 签名改 `&mut` | 生产 2 处 + 测试 3 处 | 已实测清点（§1.3）；注意别误改 `agent/chat/session_store.rs` 的同名私有函数 |
| 迁移事务行为从 `EXCLUSIVE` 变默认 `IMMEDIATE` | 启动期别的连接可能读到半迁移状态 | 显式 `transaction_with_behavior(Exclusive)`，并有 AC3 升级测试 |
| 内存库池化语义（§2.4） | 现有内存库测试可能串数据/丢数据 | 固定 `max_size(1)`；跑全量 `cargo test` 验证 |
| 77 处机械替换出错 | 运行时 panic / 编译错 | 编译器兜底（`Mutex` 字段删除后所有残留立即编译失败） |
| `busy_timeout` 漏设在新连接上 | 写冲突直接 `SQLITE_BUSY` | 放在 `with_init` 里（§2.3），并有 AC7 |
| 老库升级失败 | 用户 library 数据不可用 | AC3 用真实 v12 库做逐行比对 |

### 5.1 为什么删掉 `Mutex` 字段是最安全的做法

不保留「兼容路径」。`conn: Mutex<Connection>` 一经删除，所有仍用 `self.conn` 的地方
**编译期全部报错** —— 这比人工数 77 处可靠。这也是 R2.3 要求「一次性完整替换」的技术理由。

---

## 6. 验证策略

### 6.1 Rust 侧

| AC | 手段 |
| --- | --- |
| AC3 升级 | `tempdir()` 建库 → 跑到 v12 → 写几条 library 数据 → 再跑新链 → 断言 v13 + 数据逐行相等 |
| AC7 并发 | 真实文件库 + 两线程：线程 A 开写事务并 sleep，线程 B 读 → 断言 B 先完成或不报 BUSY |
| AC8 原子性 | 批量里混入一个会违反约束的条目（如超长 key 触发约束），断言整批零写入 |
| AC9 一次事务 | 断言 `total_changes()` 与条目数一致，且通过 `trace`/计数确认只 BEGIN 一次 |

### 6.2 前端侧

| AC | 手段 |
| --- | --- |
| AC12 脏标记 | 假 port（`CachePort` 接口注入）计数 `write` 调用次数 |
| AC13/14 降级 | 假 port 返回坏 JSON / `validate` 抛异常 / 返回 null |
| AC15 LRU | 注入可控时钟，超 maxEntries 后断言最旧被淘汰 |
| AC16 跨进程 | 两个 store 实例共享同一个假 port，第二个实例读第一个写的 |

### 6.3 每条都要变异验证

PRD AC19 已定。具体到本任务的三条关键变异：

1. `put_many` 去掉事务（逐条 execute 后各自提交）→ AC8 必须红
2. `with_init` 里删掉 `busy_timeout` → AC7 必须红（或退化为报 BUSY）
3. `flush` 改成 `set` 里立即写 → AC12 必须红

---

## 7. 实施顺序（为什么这样排）

```
0. 前端通用层            ✅ 已完成（PersistentKeyValueStore + 16 条测试）
      ↓
1. common/db 拆包（pool.rs + migrations.rs）
      ↓ 编译必须绿（此时 LibraryStore 还没改，用旧 conn 构造池适配）
2. 迁移链归一（12 步搬家 + 分派器 + AC3 升级测试）
      ↓ 这一步完成即有独立价值，可单独提交
3. LibraryStore 换池（77 处 + 删 Mutex 字段）
      ↓ 编译器保证无遗漏
4. cache 表 + CacheStore + 命令（AC8/9/10/11）
      ↓
5. sqlitePort（把通用层接到后端命令，AC12-15 已绿，只剩 Port）
      ↓
6. 注释翻译接线（AC16/17）
      ↓
7. 全量 pnpm check + cargo clippy --all-targets
```

**阶段 0 已提前完成**，原因见 §4 开头。它让阶段 5 从「写一整套前端缓存」缩成
「写一个几十行的 Port 适配器」——这正是把能力放对层的收益。

**第 2 步与第 3 步分开提交**：两者都能通过编译，但失败面完全不同（一个是 SQL 语义，
一个是类型替换）。分开后若升级出问题，能确定不是池化引入的。

---

## 8. 明确不做

- 不做文档翻译接入（二期，见 PRD R5.3）
- 不做跨设备的缓存同步
- 不做缓存命中率统计（先把可用性做对）
- 不改 `rusqlite` 版本（0.32 → 0.40 会牵动所有 `params!` 与 `bundled`）
- 不把 `cache_entries` 放进 `library` 的迁移文件
- **不重写前端通用层**（`PersistentKeyValueStore` 已完成，只补 Port）
- 不把 `namespace` 加进通用层（那是后端分区概念，归 Port 构造参数）
