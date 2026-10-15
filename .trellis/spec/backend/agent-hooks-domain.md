# Agent Hooks 域（外部 Agent CLI 状态上报）

> `src-tauri/src/agent/hooks/` 与嵌入模板（`templates/neeko-pi-status.ts` /
> `templates/neeko-opencode-status-v2.js`）、`platform/private_file/` 的坐标发布契约。
> 任务源：`10-12-agent-notify`（Phase B 建立，Phase F 多实例修订）。
>
> 与[质量指南](./quality-guidelines.md)的红线互补：本文件只记录本域**特有**的跨层契约
> （Rust 写坐标 ↔ TS 模板读坐标 ↔ 用户终端里的 CLI 进程），通用规则不在此重复。

---

## 场景：多实例坐标共存（endpoint 目录 + 上报端 fan-out）

### 1. Scope / Trigger

- **Trigger**：用户**必须**同时运行打包版 Neeko 与 `pnpm tauri dev`（调试需要）。旧的全局单文件
  坐标 `~/.neeko/agent-hooks/endpoint.env` 在结构上无法同时表示 N 个活实例：后启动者覆写它，
  先退出者留下**死坐标**（端口无监听）；CLI 侧上报前重读该文件 → 全部打到死端口 → fail-open
  静默吞掉 → 症状「刚启动能通知、运行着就不通知」。代码无 single-instance 约束，而工作流要求
  多开 ⇒ 单实例假设被证伪。
- **Scope**：`agent/hooks/endpoint.rs`（发布）、`agent/hooks/server.rs`（spawn + 迁移）、
  `agent/hooks/templates/*`（读取 + fan-out）、`platform/private_file/{unix,default}.rs`（私有目录/文件）、
  `agent/hooks/writers.rs`（模板锚点测试）。

### 2. Signatures

```rust
// endpoint.rs —— 每实例一个坐标文件
pub const ENV_KEY_PORT: &str = "NEEKO_AGENT_HOOK_PORT";
pub const ENV_KEY_TOKEN: &str = "NEEKO_AGENT_HOOK_TOKEN";
pub const ENV_KEY_OVERRIDE: &str = "NEEKO_AGENT_HOOK_ENDPOINT"; // 单文件覆盖（调试/夹具）
pub const ENDPOINTS_DIR_NAME: &str = "endpoints";

pub struct EndpointPublication { pub instance_id: String, pub path: PathBuf, pub port: u16, pub token: String }
impl EndpointPublication {
    pub fn endpoints_dir(neeko_dir: &Path) -> PathBuf;      // {neeko_dir}/agent-hooks/endpoints
    pub fn legacy_endpoint_file(neeko_dir: &Path) -> PathBuf; // 旧单文件路径（仅用于清理）
    pub fn new(neeko_dir: &Path, instance_id: String, port: u16, token: String) -> Self;
    pub fn render(&self) -> String;
    pub fn publish(&self) -> std::io::Result<()>;           // 目录 0700 + 文件 0600 原子写
}
pub fn remove_legacy_endpoint(neeko_dir: &Path) -> std::io::Result<()>; // 幂等一次性迁移

// platform/private_file
pub fn create_private_dir(path: &Path) -> std::io::Result<()>; // unix 0700 / windows no-op
pub fn write_private_atomic(path: &Path, content: &str) -> std::io::Result<()>; // unix 0600 原子替换
```

模板侧（TS/JS，双端同契约）：

```ts
const ENDPOINTS_DIR = process.env.NEEKO_AGENT_HOOK_ENDPOINTS_DIR
  || join(homedir(), ".neeko", "agent-hooks", "endpoints");
// coords() → 扫 endpoints/*.env，返回坐标数组（目录 mtime 缓存；单文件覆盖走 f: 前缀键）
// post()   → Promise.allSettled 对每个坐标各 POST 一次，逐个 fail-open（800ms 超时）
```

### 3. Contracts

- **坐标根目录** `~/.neeko/agent-hooks/endpoints/`（POSIX **0700**），每实例一个文件
  `endpoints/<instance_id>.env`（POSIX **0600**，原子替换）。`instance_id` = 进程启动随机 uuid，
  仅内存持有、仅作文件名。
- **文件格式不变**（`KEY=value` 行 + 尾换行）：
  ```
  NEEKO_AGENT_HOOK_PORT=53124
  NEEKO_AGENT_HOOK_TOKEN=<uuid-v4>
  ```
- **旧单文件 `agent-hooks/endpoint.env` 在启动时删除一次**（`remove_legacy_endpoint`，幂等）——
  避免上报端同时读到新旧两种形态。上报端**只**支持目录形态。
- **退出不删除本实例坐标文件**：删除会制造「重启窗口期回调失败」；死坐标由上报端 fail-open 跳过。
- **上报端 fan-out**：读全部 `*.env` → 逐坐标 POST；单坐标失败（连接拒绝/超时/403）不影响其余
  坐标，也不影响 CLI（`Promise.allSettled` + 每项 `try/catch`）。缓存键 = **目录 mtime**
  （增删/替换文件都会改目录 mtime），不是单文件 inode。
- **单文件覆盖保留**：`NEEKO_AGENT_HOOK_ENDPOINT` 指向单个文件时只读它、不扫目录（调试/测试夹具）。
- **目录权限是威胁模型的一半**：文件 0600 只挡内容；目录若可列（0755），攻击者可枚举实例文件名。
  故目录 0700，经 `platform::private_file` 统一落位（业务码零 `#[cfg]`，红线 10）。

### 4. Validation & Error Matrix

| 场景 | 预期 |
|------|------|
| 两实例先后 publish | 各自 `endpoints/<id>.env` 并存，互不覆写（R6.8 核心不变量） |
| 同实例重复 publish | 覆盖自身文件，无 `.tmp-` 残留 |
| 旧单文件存在 | 启动删除；不存在也成功（幂等）；不触碰 `endpoints/` 新坐标 |
| 坐标目录不存在 | 上报端 `coords()` 返回空数组，零 fetch、不抛错（Neeko 未运行） |
| 某坐标端口已死 | 该坐标 `fetch` 失败被吞掉，其余坐标照常投递 |
| 目录 mtime 未变（内容被替换） | 走 `write_private_atomic` 的 rename → 目录 mtime 变化 → 缓存失效 |

### 5. Good/Base/Bad Cases

- **Good**：打包版 + dev 同开 → pi 触发一次完成/审批 → **两个实例都收到通知**（AC18）；
  关闭 dev 后，打包版继续收到（dev 的死坐标被跳过）。
- **Base**：只开一个实例 → 目录里一个坐标文件，行为与旧单文件等价。
- **Bad**：重新引入全局单文件坐标（`endpoint.env` 作会合点）；上报端只读一个文件；
  目录用默认权限创建（0755）；退出时删除自己的坐标文件。

### 6. Tests Required

- `endpoint.rs`（tempdir 夹具，红线 13）：
  - `two_publications_coexist_without_overwrite`：两实例文件并存、内容互不覆盖（承重用例）。
  - `publish_overwrites_own_file_atomically`：同实例幂等、无 tmp 残留。
  - `remove_legacy_endpoint_is_idempotent_and_keeps_new_coords`：旧文件删、新坐标留、二次调用成功。
  - `publish_sets_owner_only_permissions_on_unix` / `endpoints_dir_is_owner_only_on_unix`：0600 / 0700。
- `writers.rs::embedded_templates_keep_contract_anchors`：模板必须含坐标目录扫描锚点
  （`endpoint::ENDPOINTS_DIR_NAME` + `readdirSync` + `Promise.allSettled`）与单文件覆盖的
  **读取形态**（`"NEEKO_AGENT_HOOK_ENDPOINT ||"`）。**锚点必须承重** —— 裸键名是 plural 目录键
  （`NEEKO_AGENT_HOOK_ENDPOINTS_DIR`）的子串，会被替身通过。
- 真实模板 Node harness（人工/脚本）：两坐标文件 → 两个 POST（死坐标 ECONNREFUSED 静默）；
  目录缺失 → 零 fetch 不抛错；单文件覆盖 → 恰好一个 POST。

### 7. Wrong vs Correct

#### Wrong

```rust
// 全局唯一会合点：多实例互相覆写，退出留死坐标
let path = neeko_dir.join("agent-hooks").join("endpoint.env");
write_private_atomic(&path, &render)?;   // 后启动者覆盖先启动者
```

```ts
// 上报端只读一个文件：读到死坐标 → 全部丢失
const text = readFileSync(ENDPOINT_FILE, "utf8");
await fetch(`http://127.0.0.1:${port}/hook/pi`, { ... });
```

#### Correct

```rust
// 每实例一个文件，退出不删；旧单文件启动时清理一次
let publication = EndpointPublication::new(&neeko_dir, uuid::Uuid::new_v4().to_string(), port, token);
publication.publish()?;                   // {neeko_dir}/agent-hooks/endpoints/<id>.env
```

```ts
// 扫全部坐标，逐个 fail-open
await Promise.allSettled(coords().map(async (c) => {
  try { await fetch(`http://127.0.0.1:${c.port}/hook/pi`, { signal: AbortSignal.timeout(800), ... }); }
  catch { /* fail-open */ }
}));
```

---

## 场景：受管 hook 文件的标记键必须内容寻址（D13）

### 1. Scope / Trigger

- **Trigger**：受管 hook 文件（`~/.pi/agent/extensions/neeko-status.ts` 等）首行带归属标记
  `// @neeko-managed-hook v{...}`；启动收敛 `reconcile_action` 只比这个标记判「是否过期」。
  早期标记键 = `v{CARGO_PKG_VERSION}`（**发布版本**）—— 把「发布版本」与「已装文件是否过期」
  两个生命周期不同的东西绑在一起：只改模板必须手碰发布版本（→ 三处版本漂移），忘了碰
  则已装机器**静默不更新**。
- **Scope**：`agent/hooks/writers.rs`（`content_token` / `render` / `ownership_of`）。

### 2. Signatures

```rust
fn content_token(template: &str) -> String; // "v{应用版本}+{fnv1a_u64:016x}"
fn fnv1a(bytes: &[u8]) -> u64;              // 跨 Rust 版本稳定的内容哈希
fn ownership_of(path: &Path, expected_token: &str) -> Ownership; // 三条路径同口径
```

### 3. Contracts

- 标记键**从被缓存的内容本身派生**（内容寻址）：`v{CARGO_PKG_VERSION}+{hash(模板正文)}`。
  hash 算法必须**跨 Rust 版本/平台稳定**——**禁用 `std::hash::DefaultHasher`**（输出不稳定，
  会让同一模板在不同构建下算出不同键，每次升级误判过期）；用自实现 FNV-1a（无新依赖）。
- 应用版本仍保留在标记里，供人眼辨识；机器比较的是整串。
- 旧标记（无 `+hash`，如 `v1.0.9`）与当前期望键不匹配 → 首启自动重装一次（迁移方向安全）。
- 代价与取舍：内容寻址会覆盖用户对受管文件的手改 —— 但受管文件首行本就写「请勿原地编辑」，
  语义上更正确。

### 4. Validation & Error Matrix

| 场景 | 预期 |
|------|------|
| 同一模板两次 `render()` | 标记键恒等（无随机/时间成分） |
| 模板改一个字节（版本号不变） | 键变 → `version_current=false` → `reconcile_action(want=true)` = `Install` |
| 已装旧纯版本标记（`v1.0.9`） | 不匹配 → 自动重装（迁移） |
| 内容与期望完全一致 | `install_at` = `Unchanged`（幂等，无 mtime 抖动） |
| 无归属标记 / 非 UTF-8 | `Foreign` —— 绝不覆盖 |
| 模板改动（含版本不变） | **不再需要**改 `Cargo.toml` 版本；三处版本保持同步 |

### 5. Good/Base/Bad Cases

- **Good**：改模板正文 → 下次 Neeko 启动自动重装，`Cargo.toml` 不动。
- **Base**：模板未变 → 键一致 → `Unchanged`，不重写。
- **Bad**：标记键用发布版本（漏碰版本 = 静默不更新）；用 `DefaultHasher`（跨版本不稳定）；
  `ownership_of` 不带 `expected_token`（无法算出内容键，退回比版本）。

### 6. Tests Required

- `writers.rs`：`content_token_is_stable_and_content_addressed`（同内容稳定 / 内容变则变 /
  带版本前缀）、`template_body_change_marks_install_stale_without_version_bump`（**反证钉子**：
  把 `content_token` 退回 `v{CARGO_PKG_VERSION}` 本用例必红）、`legacy_version_marker_triggers_reinstall`
  （旧纯版本标记判过期）、`fnv1a(b"") == 0xcbf2_9ce4_8422_2325`（钉死算法向量）、
  `install_is_idempotent` / `foreign_file_is_never_touched`（既有不变量不回归）。

### 7. Wrong vs Correct

#### Wrong

```rust
// 发布版本当内容缓存键：改模板必须手碰版本，否则静默不更新
fn version_token() -> String { format!("v{}", env!("CARGO_PKG_VERSION")) }
```

#### Correct

```rust
// 内容寻址：模板字节变 → 键变 → 自动重装；版本号不动
fn content_token(template: &str) -> String {
    format!("v{}+{:016x}", env!("CARGO_PKG_VERSION"), fnv1a(template.as_bytes()))
}
```

---

## 已知遗留（登记未实施）

- **坐标文件无界累积**：文件退出不删、`instance_id` 每次随机 ⇒ `endpoints/` 随每次启动单调增长，
  上报端 fan-out 数无上限。短期无感（每文件约 60B、死坐标即时失败），长期会让每次上报并发
  fetch 数无界增长，极端触发 CLI 侧 EMFILE（与「绝不阻塞 CLI」相抵）。
  **推荐修法**：坐标文件增写 `NEEKO_AGENT_HOOK_PID` + host，启动时按「同 host 且 pid 已死」剪除
  （pid 存活判定只会误留死文件、不会误删活实例，方向安全）；可选 fan-out 上限兜底。
