# 实施计划：通用本地缓存

> 需求 [`prd.md`](prd.md) · 设计 [`design.md`](design.md)。本文是**可执行清单**：
> 顺序、每步的验证命令、回滚点、以及「什么算这一步做完了」。

## 0. 前置检查（开工前跑一次，确认基线绿）

```bash
cd /Users/tomgs/RustroverProjects/neeko
pnpm check                    # 31 条护栏 + 两套测试，必须全绿再动手
cd src-tauri && cargo test    # Rust 基线（记录 duration，用于对比）
```

**基线不绿就停** —— 否则无法区分「我引入的」与「本来就坏的」。

---

## 阶段 1：`common/db` 拆包（不改行为）

### 1.1 建目录与文件

```
src-tauri/src/common/db.rs  →  src-tauri/src/common/db/mod.rs
                                src-tauri/src/common/db/pool.rs
                                src-tauri/src/common/db/migrations.rs
```

- `mod.rs`：`pub use` 现有 `open` / `open_in_memory`，新增 `pub mod pool; pub mod migrations;`
  `pub use pool::{DbPool, open_pool};` `pub use migrations::run_migrations;`
- `pool.rs`：`DbPool` 类型别名 + `open_pool(path, max_size)`
- `migrations.rs`：**此时只放一个转发**（`pub use crate::library::migrations::*`），
  真正的搬家在阶段 2

### 1.2 加依赖

```bash
cd src-tauri
cargo add r2d2@0.8 r2d2_sqlite@0.25
```

**必须两个都加**（`r2d2` 不能靠传递依赖，已实测报 `cannot find module r2d2`）。

### 1.3 验证

```bash
cd src-tauri && cargo check && cargo test --quiet
```

- [ ] 编译绿，现有测试全绿（**行为零变化**）
- [ ] `git diff` 只含「新增文件 + mod 声明 + Cargo.toml 两行」

**回滚点 A**：`git checkout -- src-tauri/Cargo.toml src-tauri/Cargo.lock` +
删 `common/db/` 目录，恢复单文件 `common/db.rs`。

---

## 阶段 2：迁移链归一

> 这一步有独立价值（可以单独提交）。完成后 `neeko.db` 的版本链只剩一份。

### 2.1 搬家

1. `library/migrations.rs` → `common/db/migrations.rs`：搬 `LATEST_VERSION`、
   `run_migrations`、`migrate_step`，以及 **12 个 `migrate_vN_to_vM` 函数体**（459 行，一字不改）
2. `library/migrations.rs` 只留：

   ```rust
   pub fn step(conn: &Connection, from_version: u32) -> Result<()> {
       match from_version {
           0 => migrate_v0_to_v1(conn),
           // …11 => migrate_v11_to_v12(conn)
           _ => bail!("unknown migration version: {from_version}"),
       }
   }
   ```

   私有函数也留在 `library/migrations.rs`（SQL 归属 library 域）。

### 2.2 分派器

`common/db/migrations.rs`：

```rust
pub const LATEST_VERSION: u32 = 13;

fn migrate_step(conn: &Connection, from: u32) -> Result<()> {
    if from <= 11 { crate::library::migrations::step(conn, from) }
    else if from == 12 { crate::common::cache::migrations::v12_to_v13(conn) }
    else { bail!("unknown migration version: {from}") }
}
```

**注意**：这一步 `cache::migrations::v12_to_v13` 还不存在。两种做法二选一：
- (a) 先建 `common/cache/migrations.rs` 的空壳（只建表，`CacheStore` 留到阶段 4）
- (b) 本阶段 `LATEST_VERSION` 保持 12，阶段 4 再升到 13

**选 (b)** —— 每阶段只改一件事，`LATEST_VERSION` 的变化与建表 SQL 在同一次提交里。

### 2.3 签名改 `&mut`

`run_migrations(conn: &mut Connection)` + `transaction_with_behavior(Exclusive)`
（**必须 EXCLUSIVE**，与现状 `BEGIN EXCLUSIVE` 等价，design §1.3）。

改动点（已实测清点）：
- 生产 2 处：`library/store.rs:29`、`library/store.rs:38`
- 测试 3 处：`library/migrations.rs` 内 `run_migrations(&conn)` 的 3 个用例
- **不要动** `agent/chat/session_store.rs` 的同名私有 `run_migrations`（另一个库）

### 2.4 验证（AC1 / AC2 / AC3）

```bash
cd src-tauri && cargo test migrations --quiet
cargo test --quiet                    # library 全量不回归
```

**AC3 升级测试**（新增，放 `common/db/migrations.rs` 的 `#[cfg(test)]`）：

```rust
#[test]
fn upgrades_v12_database_to_latest_preserving_library_data() {
    let dir = tempfile::tempdir().unwrap();          // 红线 13：路径由 tempdir 推导
    let path = dir.path().join("neeko.db");
    // 1) 手工跑到 v12（只跑 library 的 12 步）
    // 2) 插 1 skill + 1 prompt + 1 mcp_server
    // 3) 跑新的 run_migrations
    // 4) 断言 user_version == 13 且三张表数据逐字段相等
}
```

- [ ] `LATEST_VERSION` / `run_migrations` 只在 `common/db/migrations.rs`（`grep -rn "LATEST_VERSION" src/` 应只命中一处定义）
- [ ] `library/migrations.rs` 只剩 `step` + 12 个私有函数
- [ ] AC3 用例红→绿（先写测试确认红，再实现）
- [ ] 现有 `library` 全部测试绿

**回滚点 B**：本阶段是纯搬家 —— revert 该提交即回到阶段 1 结束状态，无数据风险
（没有升 `LATEST_VERSION`）。

---

## 阶段 3：`LibraryStore` 换池

> **风险最高的一步**（77 处机械替换）。靠编译器兜底，不靠人工数。

### 3.1 换字段

```rust
pub struct LibraryStore { pool: DbPool }        // 删掉 conn: Mutex<Connection>
```

构造器：
- `open(path)` → 建池 → 跑迁移 → `Self { pool }`
- `open_in_memory()` → **`max_size(1)`** 的内存池（design §2.4）
- 新增 `with_pool(pool: DbPool)`（供 `AppStateWrapper` 注入共享池）

### 3.2 77 处替换（sed）

```bash
cd src-tauri
# 先备份并预览
perl -0pi -e 's/let conn = self\s*\n\s*\.conn\s*\n\s*\.lock\(\)\s*\n\s*\.map_err\(\|e\| anyhow::anyhow!\("Lock poisoned: \{e\}"\)\)\?;/let conn = self.pool.get()?;/g' src/library/store.rs
grep -c "Lock poisoned" src/library/store.rs    # 应为 0
grep -c "self.pool.get()" src/library/store.rs  # 应为 77
```

**删 `Mutex` 字段后编译器会指认所有残留** —— 这就是「一次性完整替换」的技术保障
（design §5.1）。若 sed 漏了，编译立即红。

### 3.3 接线

- `app_state.rs`：`AppStateWrapper` 增加 `cache_store: Arc<CacheStore>`（阶段 4 用），
  池在 boot 期建一次
- `boot.rs:64-83` `init_prerequisites` → 返回 `(Arc<DbPool>, Arc<LibraryStore>)`
- `app_state.rs:423` 的 `new()` 同步调整
- `common/testing.rs:23` 的测试夹具同步

### 3.4 验证（AC4 / AC5 / AC6 / AC7）

```bash
cd src-tauri
cargo check 2>&1 | grep -c "^error"        # 0
grep -c "Lock poisoned" src/library/store.rs  # 0
cargo test --quiet                          # 全绿（内存库测试是关键）
```

**AC7 并发用例**（`common/db/pool.rs` 的 `#[cfg(test)]`，用 `tempdir()` 真实文件库）：

```rust
#[test]
fn read_does_not_block_on_in_flight_write() {
    // 线程 A：开写事务、写一条、sleep 100ms、commit
    // 线程 B：A 的事务开出后立即读
    // 断言 B 在 A commit 前返回，且不报 SQLITE_BUSY
}
```

- [ ] 编译绿、`Lock poisoned` 在 `store.rs` 零出现
- [ ] 内存库测试全绿（AC6）
- [ ] AC7 用例通过（红→绿验证：删 `busy_timeout` 应红或退化为报 BUSY）
- [ ] `cargo clippy --all-targets` 零 warning

**回滚点 C**：revert 该提交回到阶段 2（迁移链已归一，库仍用 Mutex）。

---

## 阶段 4：cache 表 + `CacheStore` + 命令

### 4.1 建 cache 域

```
src-tauri/src/common/cache/
  mod.rs          pub use store::CacheStore; pub mod migrations; mod commands;
  migrations.rs   v12_to_v13
  store.rs        get_many / put_many / evict / clear
  commands.rs     #[tauri::command] × 4
```

### 4.2 建表 + 升版本

```rust
// cache/migrations.rs
pub fn v12_to_v13(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS cache_entries (
           namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
           version INTEGER NOT NULL, at INTEGER NOT NULL,
           PRIMARY KEY (namespace, key)
         ) WITHOUT ROWID;
         CREATE INDEX IF NOT EXISTS idx_cache_entries_lru ON cache_entries(namespace, at);",
    )?;
    Ok(())
}
```

同时把 `common/db/migrations.rs` 的 `LATEST_VERSION` 改为 13，分派器加 `12 => cache::…`。

### 4.3 `CacheStore`

按 design §3.2 的事务形态。要点：
- `stmt` 必须在 `tx.commit()` 前 drop（大括号作用域）
- `put_many_at(…, at)` 内部方法 + `put_many` 调它（注入时钟便于 evict 测试）
- `evict(namespace, keep)` 用 `DELETE … WHERE key NOT IN (SELECT key … ORDER BY at DESC LIMIT ?)`

### 4.4 命令（薄，红线 6）

```
cache_get_many(namespace, keys) -> Vec<(String, String)>
cache_put_many(namespace, entries, version)
cache_evict(namespace, keep)
cache_clear(namespace)
```

- `validate_namespace`：`[a-z0-9._-]`，长度 ≤ 64
- `entries.len() <= 5000`（红线 4 的 2MB 边界在此拦）
- 全部经 `run_blocking_result`（红线 3）
- 注册进 `lib.rs` 的命令宏

### 4.5 验证（AC8 / AC9 / AC10 / AC11）

```bash
cd src-tauri && cargo test cache --quiet
```

| AC | 用例 |
| --- | --- |
| AC8 | 批量里混一条非法值（key 超长 / 违反约束）→ 断言整批零写入 |
| AC9 | 断言 `total_changes() == entries.len()` 且只 BEGIN 一次 |
| AC10 | 写 5 条、`evict(ns, 2)` → 剩最新 2 条；另一 namespace 不受影响 |
| AC11 | `clear(ns)` 只清该域 |

- [ ] 4 条 AC 全绿，每条**先红后绿**
- [ ] 变异验证：`put_many` 改逐条提交 → AC8 红

**回滚点 D**：`LATEST_VERSION` 回 12 + 删 `common/cache/`（库文件里 `cache_entries` 表可留，
不影响旧代码 —— 它只是多一张没人用的表）。

---

## 阶段 5：SQLite Port 适配（通用层已完成）

> **2026-10-19 变更**：阶段 5 原本是「写一整套前端缓存层」，已在
> `code-comment-translation` 的审查修复中提前完成 —— `PersistentKeyValueStore<T>`
> 落在 `src/shared/cache/`，16 条测试，四条变异验证均红。
>
> 现在只剩**把通用层接到后端命令**，这是几十行的薄适配。

### 5.0 已存在（不要重写）

```
src/shared/cache/
  persistentKeyValueStore.ts        ✅ 通用逻辑（脏标记 / 版本 / 淘汰 / 降级）
  __tests__/persistentKeyValueStore.test.ts   ✅ 16 条
```

契约见 `design.md` §4.1。关键：**Port 是条目粒度**
（`load` / `putMany` / `deleteMany`），不是整份字符串。

### 5.1 新增文件

```
src/shared/cache/
  ports/sqlitePort.ts     ← 调 Tauri 命令（namespace 由构造参数注入）
  api/cacheApi.ts         ← invoke 封装（红线：invoke 只在这里）
  index.ts                ← barrel
```

`sqlitePort` 形态：

```ts
export function createSqliteCachePort(namespace: string): PersistentCachePort {
  return {
    load: () => cacheLoad({ namespace }),
    putMany: (entries) => cachePutMany({ namespace, entries }),
    deleteMany: (keys) => cacheEvictKeys({ namespace, keys }),
  };
}
```

**namespace 归 Port，不归通用层**（design §4.3）：文件后端不需要它，加进通用层会让
「一个文件就是一个 namespace」的后端多一条无谓约束。

### 5.2 验证（AC12–AC15 已绿，这里只验 Port）

```bash
npx vitest run src/shared/cache
```

新增用例（Port 层）：
- [ ] `sqlitePort` 把 `namespace` 正确透传给每条命令
- [ ] `load` 返回 null 时 `get` 为 null（后端无数据不炸）
- [ ] `invoke` 拒绝（后端报错）时 `flush` 不抛、`dirty` 保留
- [ ] `invoke` 只出现在 `api/cacheApi.ts`（静态断言，红线）

### 5.3 变异验证

- [ ] `sqlitePort` 漏传 namespace → 用例红
- [ ] `api/cacheApi.ts` 之外出现 `invoke` → 静态断言红

---

## 阶段 6：注释翻译接线

### 6.1 改动（前两项已完成）

- ✅ `comment/translationCache.ts`：`PersistentCache` / `CacheFilePort` **已删除**
  （215 → 102 行），只留 `CachedTranslation` 与 `cacheKey`
- ⬜ `hooks/commentTranslationCacheSingleton.ts`：当前 `new MemoryCache()`，
  改为构造 `PersistentKeyValueStore<CachedTranslation>({ port: createSqliteCachePort('comment-i18n'), ... })`

### 6.2 验证（AC16 / AC17）

```bash
npx vitest run src/features/editor/comment src/features/editor/hooks
```

- [ ] AC16：两个 store 实例共享同一假 port，第二个实例读第一个写的 → `cacheHits > 0` 且 `turn` 零调用
- [ ] AC17：`MemoryCache` 注入路径仍可用（现有测试不改即绿）
- [ ] 变异：把接线改回 `new MemoryCache()` → AC16 红

---

## 阶段 7：收尾

```bash
cd /Users/tomgs/RustroverProjects/neeko
cd src-tauri && cargo clippy --all-targets -- -D warnings && cd ..
pnpm check                       # 31 条护栏 + 全量测试
```

- [ ] `pnpm check` 全绿（AC18）
- [ ] `cargo clippy --all-targets` 零 warning
- [ ] 同步 `.trellis/spec/backend/` 的 DB / 迁移相关文档（若有落点）
- [ ] `add_session.py` 记录

---

## 提交切分（每个 commit 必须能独立通过门禁）

| # | 内容 | 可回滚性 |
| --- | --- | --- |
| 1 | `common/db` 拆包 + 加依赖 | 行为零变化 |
| 2 | 迁移链归一（含 AC3 升级测试） | 纯搬家，无数据风险 |
| 3 | `LibraryStore` 换池（77 处） | 类型替换，编译器兜底 |
| 4 | `cache_entries` + `CacheStore` + 命令 | 新增表，旧代码无感 |
| 5 | `shared/cache` Port 适配（通用层已落地） | 纯新增 |
| 6 | 注释翻译接线 + 删旧 `PersistentCache` | 消费者切换 |

**不要把 2+3 合成一个 commit**：失败面完全不同（SQL 语义 vs 类型替换），
分开才能在出问题时定位（design §7）。

---

## 全程禁做

- 不改 `rusqlite` 版本（0.32 → 0.40 牵动所有 `params!` 与 `bundled`）
- 不动 `agent/chat/session_store.rs`（另一个库，本期不归一）
- 不在 `library/migrations.rs` 里建 `cache_entries`
- 不让 `common/cache` 依赖 `library`
- 不在事务里做 IPC / 网络 / LLM 调用
- 不为覆盖率指标改写生产结构
