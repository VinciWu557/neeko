# Implement — Agent 系统通知扩展（父任务：分期地图与集成评审）

> 父任务**不实施代码**。本文件是**跨子任务的分期地图 + 集成评审清单**，
> 不重复子任务的执行步骤（那些在各子任务的 `implement.md`）。
>
> 状态图例：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 完成 · `[-]` 登记不实施

---

## 0. 前置事实（已核实，实施前不需要再查）

- [x] `10-12-agent-notify` 已实施并合入 main：`src-tauri/src/notification/**`（6 文件，
  ~1385 行）+ `src-tauri/src/agent/hooks/**`（9 文件 + 3 模板，~2000 行）。
- [x] `packages/dsh-neeko` 在 Neeko 内**零引用**（全仓 grep 无命中，除其自身目录）。
- [x] `ChatStart::Jsonl` 无任何 `AgentConfig` 使用（仅 `deepseek.rs` 实现存在）。
- [x] `NEEKO_SESSION_ID` / `NEEKO_PROJECT_ID` 目前**只有读取端**（`attribution.rs` +
  pi 模板），无注入端 —— 归属链第 1 级实际未激活。
- [x] 既有 `writers.rs::hook_targets_are_unique` 断言 file_name 全局唯一（T10 过度约束）。
- [x] 既有 `agent/hooks/notify.rs::classify` 只有 3 个 arm（`turn_completed` /
  `approval_requested` / `input_requested`），**无 `session_failed`**（R4.4）。

---

## 1. 分期与子任务

| 期 | 子任务 | 交付物 | 顺序 |
| --- | --- | --- | --- |
| **P1** | `10-16-notify-claude-compat` | OMP 一行数据接入 | 1st |
| **P2** | `10-16-notify-claude-compat` | 共享 stdin shim + JSON 结构化合并器 + 逐 CLI opt-in | 1st（与 P1 同任务） |
| **P3** | `10-16-notify-codex` | Codex hook 接入（TOML + 信任门） | 2nd（复用 P2 骨架） |
| **P4** | `10-16-notify-dsh` | DSH 事件消费与投影（源 A 同族） | 与 P1–P3 **正交**，可并行 |

**为什么 P1/P2 同子任务**：共享同一份 shim 与同一张 `HookEntry` 表；
拆开会产生一次性的重复工作（先写 shim 再改 shim），且 OMP 与 Claude 兼容面无耦合，
可在一个子任务内独立验收。

**为什么 P3 独立**：TOML 合并 + 信任哈希是正交机制（`toml_merger.rs`），
且 `U5`（信任哈希输入格式）是**可能导致降级为 UX 引导**的未知项 ——
把它绑进 P2 会让 P2 的验收被一个不确定项拖住。

**为什么 P4 独立且可并行**：DSH 走源 A 桥投影，与源 B hook 线**零共享代码**；
`U7`（消费侧归属）也是独立未知项。

---

## 2. 实施顺序（父任务视角）

```
1. [ ] 子任务 10-16-notify-claude-compat
       ├─ Step 0: 3 个 spike（U1 OMP 事件面 / U2 node 前提 / U3 Qoder 配置面 / U4 Notification matcher）
       ├─ Step 1: InstallShape + HookEntry 数据表扩展（含 hook_targets_are_unique 修正）
       ├─ Step 2: merger.rs 纯函数 TDD（4 条不变量 Red → Green）
       ├─ Step 3: writers 按 shape 分派（含权限继承）
       ├─ Step 4: neeko-report.mjs shim + platform/hook_command.rs
       ├─ Step 5: OMP 接入（复用 pi 模板）
       ├─ Step 6: notify.rs 补 SESSION_FAILED arm
       ├─ Step 7: 前端逐 CLI opt-in 开关
       └─ Step 8: 三平台实测（macOS 必须；Win/Linux 按 `10-12` 既有覆盖）
2. [ ] 子任务 10-16-notify-codex（复用 Step 2/3/4 的骨架）
       ├─ Step 0: U5/U6 spike（信任哈希格式 / Interrupt 语义）
       ├─ Step 1: toml_merger.rs 纯函数 TDD
       ├─ Step 2: 信任状态写入或 UX 引导（取决于 U5）
       └─ Step 3: Codex 实测
3. [ ] 子任务 10-16-notify-dsh（正交，可与上面并行）
       ├─ Step 0: U7 定案（消费侧归属）
       ├─ Step 1: DSH 事件 → NotificationSignal 投影
       └─ Step 2: 实测
4. [ ] 父任务最终集成评审（见 §4）
```

**关键路径**：`claude-compat` → `codex`（codex 复用骨架）。
`dsh` 不在关键路径上。

---

## 3. 验证命令（每个子任务收尾时跑）

| 目的 | 命令 |
| --- | --- |
| 开发循环（每轮） | `pnpm check:quick` |
| 收尾全量（每个子任务**一次**） | `pnpm check` |
| 只看本域 | `cargo test --manifest-path src-tauri/Cargo.toml agent::hooks` |
| 通知核心域 | `cargo test --manifest-path src-tauri/Cargo.toml notification` |
| 依赖方向护栏 | `pnpm guards list` → 找 `check_notification_core_direction` |
| 双端类型镜像 | `pnpm type-check`（`notification.ts` 与 Rust 手动同步） |

---

## 4. 父任务最终集成评审清单

三个子任务归档后逐项确认（对应 AC1–AC5）：

- [ ] **AC1 核心域零改动自证**
  `git diff <base>..HEAD -- src-tauri/src/notification/` 输出为空；
  `check_notification_core_direction` 全绿。
- [ ] **AC2 拓扑分类正确性**
  三个子任务各自在 `research/` 或 `implement.md` 里给出拓扑判断的证据
  （claude-compat = 独立 shim + 结构化合并；codex = TOML + 信任门；dsh = 源 A 投影）。
- [ ] **AC3 无重复实现**
  测试钉死：Claude / CodeBuddy / Qoder 三源共享**同一份** shim 模板
  （`include_str!` 同一常量）与**同一张** `HookEntry` 表
  （`CLAUDE_COMPAT_ENTRIES` 被三个 `HookTarget` 引用，不是三份副本）。
- [ ] **AC4 跨子任务回归**
  Pi / Opencode（既有）通知行为不变：`pnpm test:rust` 中 agent-hooks 与 notification
  全部测试通过；`pnpm check` 全绿。
- [ ] **AC5 最终集成评审**
  - [ ] 用户配置面在开关**开**状态下：他人条目（orca / clawd / superset）逐字保留
  - [ ] 用户配置面在开关**关**状态下：自家条目移除，他人条目原样（语义回到开启前）
  - [ ] 设置页正确呈现每个 CLI 的安装状态与版本新鲜度（`version_current`）
  - [ ] 交付物清单与 `design.md` §2.2 落点表一致（无未登记文件）
  - [ ] `10-12-agent-notify` 的既有验收未被破坏（三平台系统通知仍工作）

---

## 5. 回滚点

| 回滚点 | 触发条件 | 动作 |
| --- | --- | --- |
| 单个 CLI 接入失败 | 该 CLI 实测不触发通知且无法在范围内修复 | 该 `HookTarget` 行改为不安装（或 `shape` 标记不可用），其余 CLI 不受影响 |
| 结构化合并损坏用户配置 | AC5 检查发现他人条目丢失 | 立即 `uninstall`（只删自家条目）+ 从备份恢复；`merger` 的 fail-safe 判据需补测试 |
| 核心域被迫改动 | 任何子任务发现必须改 `notification/**` | **停止** —— 说明 T4/T6 的拓扑判断有误，回到父任务 `design.md` 重新拆解（AC1 是硬约束） |
| Codex 信任门不可自动化 | U5 结论为「必须人工确认」 | P3 降级为设置页 UX 引导 + 文档，不算失败（R5.3） |
| DSH 无可用消费点 | U7 结论为「无」 | P4 登记不实施，父任务范围缩减（R5.3） |

---

## 6. 收尾（父任务）

- [ ] 三个子任务全部归档（`task.py archive`）
- [ ] 跑一次全量 `pnpm check`
- [ ] 同步 spec：`.trellis/spec/backend/` 中与 hook 接入 / 通知域相关的文档
      （新增 `InstallShape` 契约与客人义务升级必须入 spec —— 这是本任务最有复用价值的产出）
- [ ] 更新 `10-12-agent-notify/design.md` 的 E7（「除 Pi/Opencode 外的其他 CLI hook 源」）
      指向本任务，避免两处登记漂移
- [ ] `add_session.py` 记录会话
- [ ] **不主动提交代码**（等用户指示）
