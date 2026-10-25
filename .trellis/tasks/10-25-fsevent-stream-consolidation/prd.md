# fseventsd 资源占用治理：单流合并与排除集合按成本排序

## Goal

降低 Neeko 在 fseventsd 侧的结构性开销：把「每个 mounted workspace ≥ 2 条流」降到
「每个 workspace 1 条」，并让被截断的排除集合保留真正高成本的子树。

> **口径声明**：本任务**不以「降低 fseventsd CPU」为验收目标**。采样取证表明当前
> fseventsd 的 CPU 活跃栈与 Neeko 的流无因果关联（见「取证结论」）。本任务解决的是
> **结构性压力**（流数量、排除集合选择）。把不可归因的指标写成 Goal，会造出一个
> 永远无法真正验收的任务。

## 背景与取证结论

数据源：`sample fseventsd` 两次采样（pid 538，2026-10-23 与 2026-10-25，
`~/Downloads/“fseventsd”的取样*.txt`），形态完全一致。

| 观测 | 数据 | 含义 |
|---|---|---|
| 进程物理内存 | 9.2MB（峰值 16.6MB） | 无事件队列积压 |
| `__psynch_cvwait` 帧 | 65946 | 52 条线程全部空闲等待 |
| 唯一活跃线程 | `com.apple.fseventsd.mach_channel_queue`（serial） | 单线程在干活 |
| 活跃栈 | `_CFBundleCreateUniqueWithOptions` → `_CFBundleCreate` → `CFBundleGetInfoDictionary` → `_CFBundleCopyInfoDictionaryInDirectoryWithVersion` → `_CFIterateDirectory` → `readdir` → `__getdirentries64` | **目录遍历 + bundle 解析** |
| `FSEventStream*` 符号 | **0 次**（两次采样） | 活跃栈与 FSEvents 投递无关 |
| `client.63853.neeko_lib-f85ebe` | **8 条线程，全部停在 `__psynch_cvwait`（空闲）** | 8 条流来自同一测试进程 |

### 结论 1 — 前序分析的因果链不成立

前序 agent 断言「排除路径被截断 ⇒ fseventsd 枚举 35 万条目目录」。

截断是**真实代码事实**（`MAX_FSEVENT_EXCLUSIONS = 8`，`macos_fsevent.rs:265` warn、
`:276` `take(8)`），但它**不是这份采样的解释**：活跃栈上 `FSEventStream*` 符号为 0，
而是 CoreFoundation 的 bundle 目录扫描。`_CFBundleCopyInfoDictionaryInDirectoryWithVersion`
是 CFBundle 在目录中查找版本子目录（`Contents/`、`Versions/A/`）的标准路径，
由 fseventsd 的 mach 服务请求驱动，与 `FSEventStreamSetExclusionPaths` 无因果。

### 结论 2 — Neeko 的流是稳态占用，不是负载来源

8 条 `neeko_lib` 线程全部空闲。它们付的是 **footprint + 内核调度槽位**，
不是 CPU 时间。⇒ 降低流数量不会改善这份采样的 CPU 占用。

### 结论 3 — 但流数量结构确实是问题

| 来源 | 每 workspace 流数 | 代码位置 |
|---|---|---|
| 文件监听（主） | 1 | `manager/core.rs:387` `create_file_watcher` |
| git 元数据 | 1 | `git_meta/watcher.rs:78` `RecommendedWatcher::new` |

N 个 workspace ⇒ 2N 条流 ⇒ fseventsd 侧 2N 条 client 线程 + 2N 套 path-trie 缓存。

### 第一性原理：为何治「流」而非「排除路径」

```
fseventsd 总开销 ≈ Σ(每条流: 路径规范化 + 排除集合匹配 + 事件队列) + 全局日志写入
```

- 单流的排除集合大小 `k` 已被硬限在 8 ⇒ 继续优化「选哪 8 个」的收益上界是**常数级**；
- 流数量让固定成本**线性叠加**，且每条流在 fseventsd 侧有独立线程与 path-trie
  ⇒ 降流数量的收益是**结构级**（N → 1）。

## 实测验证（spike，macOS 27.0.1 / 26A434）

用独立 Swift 程序直接调 `FSEventStreamSetExclusionPaths`，结论如下。**这些数据取代了
此前所有基于文档推断的假设。**

### 验证 1：8 条上限是**真实硬约束**

| 传入排除路径数 | `SetExclusionPaths` 返回 |
|---|---|
| 1 / 7 / **8** | `true` |
| **9** / 16 / 32 / 64 / 128 / 256 / 512 | **`false`** |

Apple 头文件（`FSEvents.h:1421-1422`）原文一致：
> Sets directories to be filtered from the EventStream. **A maximum of 8 directories maybe specified.**

### 验证 2：超限时是**全失效**，不是"前 8 条生效"

传 12 条 → 返回 `false` → **一条都不生效**。
（Neeko 现有的 `take(8)` 恰好避开了这个陷阱。）

### 验证 3：排除对**目录**确实生效

单条目录排除后，该目录内所有写入（文件 + 子目录）**零事件投递**，受监听目录正常收事件。

⇒ **`FSEventsBackend.cc:107` 的 Parcel 注释「exclusion only apply to files, not directories」
在本机不成立**，很可能是它对「排除没生效」现象的误归因 —— 真实原因是它传了 >8 条导致整个调用失败。

### 验证 4：业界不做这个处理

| 项目 | 做法 | 后果 |
|---|---|---|
| VS Code | `excludes: ParsedPattern[]`（glob），全量传给 `@parcel/watcher` | 不处理 8 条 |
| Parcel | `mIgnorePaths` 无界，全塞进 `SetExclusionPaths`，**返回值被忽略** | >8 时内核排除**完全失效**，只剩 `Watcher::isIgnored` 软件过滤（`Watcher.cc:218`） |
| **Neeko（现状）** | `take(8)` + 检查返回值 + warn | **前 8 条真实生效** —— 优于两者 |

**结论：Neeko 现有的 `take(8)` 设计是正确的，不应照抄 VS Code/Parcel。**

## Requirements

### R1 — 排除集合按成本排序后再截断

`build_exclusion_paths`（`factory.rs:24`，**两个调用点**：`core.rs:373` 挂载期、
`maintenance.rs:96` 规则重载）是集合进入后端的必经归一入口，在其内部加**确定性**
成本排序，使条目量最大的子树优先进入前 8。

- 排序键：`(tier, depth, file_name)`，tier 0 = 已知高成本目录名
  （`target`/`node_modules`/`.next`/`dist`/`build`/`.venv`/`__pycache__`/`.gradle`/
  `Pods`/`DerivedData`），tier 1 = 其余。全部键实现 `Ord`，无 `read_dir` 序依赖。
- **不改变集合成员**，只改变「超过 8 个时保留哪 8 个」。
- 截断 warn 必须保留（可观测性不退化）。
- 该函数现有文档契约「去重 + 保序」**将被改写**为「去重 + 按成本降序」，
  并明确「不新增**忽略判定**语义」仍成立。

### R2 — 单 workspace 只开一条流（仅 macOS）

同一 workspace 的文件监听与 `git_meta` 监听合并为一条，使流数 2N → N。

技术基础（`design.md §2.1` 已核实）：macOS 后端是 `SubtreeExclusion`，
递归订阅整个 root；`manifest.rs:59-62` 跳过 `.git` 且**不放入 `ignored_roots`**
⇒ `.git` **不在** exclusion 列表 ⇒ `.git` 事件**已送达**主 watcher，只是在回调层
被 `is_hard_noise_path` 丢弃。合并 = 在丢弃前加一个分类分支，不需新增流或改注册。

- 合并**仅对 `can_exclude_subtrees()` 为真的后端**生效。Linux 是
  `SelectiveRegistration`，逐可见目录注册且 `.git` 不在 `visible_dirs`
  ⇒ 主 watcher 拿不到 `.git` 事件 ⇒ **Linux 必须保留独立流**。这是后端能力差异的
  必然结果，不是妥协。
- `classify_git_meta_event` 仍是唯一判定点，不得在主回调复制判定逻辑。
- 三条回调语义逐字保持：index/refs 只发 scheduler hint，head 才 `emit(GitChanged)`。
- 合并后 git 元数据路径仍必须被 hard-noise 丢弃（不得漏进前端事件）。
- 需独立回滚开关 `NEEKO_DISABLE_GIT_META_MERGE=1`（**不得**复用
  `NEEKO_DISABLE_FSEVENT_EXCLUSION`，两者语义不同）。

### R3 — 测试不得对仓库根注册监听

测试代码一律 `tempdir()` 隔离。已核实 `registration/tests.rs` 与
`git_meta/tests/watcher.rs` **均已隔离**（注入 mock `watch_fn`），
故采样中的 8 条流更可能来自 `cargo test` 并行跑多个真实 watcher。

处置改为**护栏化**（静态保证优于一次修复）：新增
`tools/guards/checks/check_watcher_test_isolation.py`，扫描 `#[cfg(test)]` 块与
`tests*.rs`，禁止 `env!("CARGO_MANIFEST_DIR")` / `current_dir()` / 硬编码仓库根
作为 `watch()` 参数。

### R4 — 可观测性

构造成功后打一条 `info!`：
`streams=1 exclusion_roots=<applied>/<requested> truncated=<bool> merged_git_meta=<bool>`。
挂载/重载各一条，非高频路径。使「流数、排除是否被截断」可被日志观测，
替代下次再靠 `sample` 反推。

### R5 — 截断必须处处可观测（修正：返回值检查已存在）

**实测更正**：`apply_exclusion_paths`（`macos_fsevent.rs:453-459`）**已经**检查
`SetExclusionPaths` 返回值并在失败时 warn。此前判断「返回值被忽略」是错的。

但存在一个**真实的不对称缺陷**：

| 路径 | 截断 warn | 代码位置 |
|---|---|---|
| `with_exclusions`（挂载期） | ✅ 有 | `macos_fsevent.rs:265-273` |
| `update_exclusions`（规则重载） | ❌ **无** | `macos_fsevent.rs:310-315` |

`update_exclusions` 只做 `take(8)`，静默丢弃超出部分。当用户编辑 `.gitignore` 使
`ignored_roots` 从 6 个增至 12 个时，新增的 6 个中只有 2 个可能进入排除集合，
**日志里没有任何痕迹** —— 这正是「以为在排除、其实没有」的盲区。

要求：`update_exclusions` 在截断时打与 `with_exclusions` 同款 warn（含 requested/applied 数）。

## Non-Goals

- 不改 `GitIgnoreFilter` 的忽略判定语义（忽略规则仍只有单一决策点）。
- 不改事件面契约（哪些事件投递到前端）。
- 不引入 fork/vendor 补丁。
- 不为「降低 CPU」而关闭物理排除（`NEEKO_DISABLE_FSEVENT_EXCLUSION` 仅作排查开关）。
- 不把 R2 扩展到 Linux（后端拿不到 `.git` 事件）。
- 不承担 fseventsd bundle 扫描的溯源（见移交项）。

## 移交项（不在本任务范围）

「fseventsd 的 `mach_channel_queue` 为何持续做 CFBundle 目录解析」需取证：

```bash
sudo fs_usage -w -f filesys fseventsd | grep -E "getdirentries|Info.plist|Contents"
log stream --predicate 'process == "fseventsd"' --info | head -200
```

若证明与 Neeko 无关（fseventsd 服务其他 client，如 Spotlight / Finder / Electron），
则需接受这是系统行为，本任务只管 Neeko 自身的结构性开销。

## Acceptance Criteria

- [ ] R1 成本排序：单测证明 `ignored_roots` 顺序被打乱（`target`/`node_modules`
      放末尾）时，排序后前 8 仍含二者。
- [ ] R1 确定性：同一输入集合两次排序结果逐位相同。
- [ ] R1 成员不变：排序前后集合成员一致。
- [ ] R1 判别性：`tier 0` 与 `tier 1` 混合时 tier 0 在前
      （**注**：既有测试 `build_exclusion_paths_dedupes_and_preserves_order`
      因两个输入都是 tier 0，排序未生效时也会 pass —— 不可作为判别依据）。
- [ ] R2 流合并：`cargo test` 断言同一 workspace 不再创建独立 `git_meta` 流；
      或等价的后端实例复用断言。
- [ ] R2 分类正确：`.git/objects/**` → `Nothing`、`.git/refs/heads/**` →
      `RefsChanged`、`.git/HEAD` → `HeadChanged`、`.git/index` → `IndexChanged`。
- [ ] R2 不漏事件：`.git` 路径命中分类后仍被 hard-noise 丢弃。
- [ ] R2 可回滚：`NEEKO_DISABLE_GIT_META_MERGE=1` 时仍建独立流。
- [ ] R3 护栏：`check_watcher_test_isolation` 接入 `pnpm lint` 并通过。
- [ ] R4 日志：挂载后可见 `streams= / exclusion_roots= / truncated=` 字段。
- [ ] **实测对比**：同一组 workspace 下，修复前后 `lsof -p <pid> | grep -c FSEvents`
      流数下降，且 `sample fseventsd` 中 `neeko_lib` client 线程数相应下降。
- [ ] `pnpm check` 全绿（含 Rust clippy 全目标）。

> 验收**不包含**「fseventsd CPU 占用下降」—— 取证已证明该 CPU 消耗与本任务的
> 改动目标无因果关系。把不可归因的指标写进验收，会制造一个永远无法真正通过的验收项。
