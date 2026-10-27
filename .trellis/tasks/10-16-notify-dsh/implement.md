# Implement — DSH 通知接入（源 B 上报源）

> 子任务执行计划。**与 hook 线同族，属 P4。**
> **✅ 2026-10-27 定案：源 B 上报**（原「源 A adapter」方案作废）。
> TDD 强制：Red → Green → Refactor。

---

## Step 0：Spike（✅ 2026-10-27 已完成）

> 完整报告：`research/step0-spike-report.md`。隔离 `DSH_HOME` 实测，
> **用户真实 profile 全程未被写入**（事后核对：457 行 / 14905 字节 / 0 受管块）。

- [x] **P1 profile 范围**：`~/.dsh/profiles/*` 六个（`neeko` / `neeko-acp` / `web` /
      `tui` / `cc-tui` / `pi-tui`）。只装默认？还是让用户在设置页选？
- [x] **P2 包落位**：本机 `neeko` profile 用 `"dsh-neeko": "link:/path"`。
      我们的模板包怎么进去？三种可卸载性不同：
      - `link:` 本地路径（改 `package.json` + `pnpm install`）
      - npm 包名（需先发布）
      - 直接写 `node_modules`（最脆）
- [x] **P3 patch 追加合法性**：在 `cordis.patch.yml` 末尾追加一段后，
      `dsh --profile neeko` 能否正常启动（`cordis.patch.yml` 顶层是数组）
- [x] **P4 历史重放**：恢复的旧会话上 `session/event` 是否重放？
      （`dsh-messager` 的 `sessionTitleOf` 注释暗示日志含重放历史）
- [x] **P5 模板语言**：DSH loader 直接吃 `.ts`，还是要 `.mjs` 预构建？
- [x] **P6 全链路**：起 dsh → 确认插件行加载 → 手动 POST 一条事件 → Neeko 收到通知

**Gate 已过**。三条定案改变了 Step 1 的形状：

1. **P3**：安装必须**两分支**（`[]` 结尾替换该行 / 非空追加）—— 原计划的「尾部追加」单分支会崩。
2. **P2**：包落位 = **自己写软链**，不用 `dsh plugin add`（pnpm store 冲突 + 抹掉软链）。
   → 安装腿**不跑子进程**，红线 1 不触发。
3. **P6b**：`/hook/dsh` 在 `HOOK_TARGETS` 缺行时**返回 204 但静默丢弃** ——
   所以 Step 2（加数据行）必须在 Step 4 实测之前完成，且验收断言「真的投递」。

---

## Step 1–3（**已按实际形态重写**：自供源 + `packages/dsh-neeko`）

> 原计划的 Step 1（`InstallShape::PluginPackage`）、Step 2（`dsh_profiles_dir`）、
> Step 3（`neeko-dsh-status.ts` 模板）**全部作废** —— 理由见 `design.md` §2 与
> `prd.md` R2。下面是要做的实际工作。

### Step 1：Rust 侧「自供源」

- [x] `targets/data.rs`：`HookTarget { source: "dsh", shapes: &[], dir: || None }`
- [x] `install/outcome.rs`：`HookInstallStatus::self_supplied`
- [x] `install/status.rs`：`self_supplied: target.shapes.is_empty()`
- [x] `install/selection.rs`：收敛**跳过**自供源
      （否则 `dir()` 恒 `None` → 每次开机记 `dsh:Failed`）
- [x] `targets/tests.rs`：三条自供源护栏；`shapes[0]` → 全遍历（否则空数组 panic）
- [x] `templates/tests.rs`：跳过空 `shapes`
- [x] `tests/unit/http_gateway_test.rs`：`dsh_source_is_accepted_by_ingest`
      —— 断言**投递**，不是 204

### Step 2：前端过滤

- [x] `shared/types/notification.ts`：镜像 `selfSupplied`
- [x] `CliHooksSection.tsx`：`installableHookRows()` 过滤；**判据是字段不是 `path === ''`**
- [x] `CliHooksSection.test.tsx`：含反证钉子「`path === ''` 的正常 CLI 不得被过滤」

### Step 3：上报端（`packages/dsh-neeko`）

- [x] `notify-reporter.ts`（纯函数）：事件 → 语义键；`HookEvent` 请求体渲染 + 截断
- [x] `notify-transport.ts`（传输）：两个 env 覆盖 + 目录扫描 + fan-out + `DeliveryFailure[]`
- [x] `notify-wiring.ts`（挂载）：三个订阅面 + `ReporterState`（`titles` / `running` / `lastTurn`）
- [x] `index.ts::start()` 与 `tui/runner.ts` **各自**挂载（`--tui` 时 bridge 行是 disabled）
- [x] `tests/notify-*.spec.ts` 四个文件（59 用例，零真 IO、零真网络）

**实现中修掉的三个缺陷**（都是「看起来实现了、实际没接上」）：

| # | 缺陷 | 护栏 |
| --- | --- | --- |
| 1 | `agent/*` 的 `Agent` 被当 `Session` 读 → 子代理泄漏 + `cwd` 恒 null | 用真实 `Agent` 形状的用例 + `observedOf` 单测 |
| 2 | `running → idle` 无条件报完成 → 失败/中止被追认 | `turn/end.reason` 门（3 条用例，变异验证） |
| 3 | 「两条腿都装了」的静态断言命中的是 import 行 | 改成正则匹配**调用点**（两条腿各做变异验证） |

## Step 4：实测与收尾

- [x] P6 全链路实测（AC5）：DSH 会话触发审批 → Neeko 失焦 → 系统通知
      —— **真机验证正常（2026-10-27）**
- [x] `pnpm check:quick` **收尾一次**
- [x] 确认 `agent/chat/**` + `common/agent/**` 无 diff（AC7）
- [x] 确认 `notification/**` + `server/**` 无 diff（AC8）
- [x] 确认 `install/shape/**` + `targets/shape.rs` + `targets/dirs.rs` + `templates.rs` 无 diff
      （自供源方案不新增 `InstallShape` 变体）
- [x] 确认 `packages/dsh-neeko/**` **有** diff（上报端就在那里，见 Step 3）
- [x] 同步 spec（`agent-hooks-domain.md` 新增「自供源」场景）
- [ ] 归档子任务

---

## 验证命令速查

```bash
# 收尾检查（整个任务一次）
pnpm check:quick

# 定点：TDD 红绿（观察，不是验证）
cargo test --manifest-path src-tauri/Cargo.toml agent::hooks::install
cargo test --manifest-path src-tauri/Cargo.toml agent::hooks::targets
cargo test --manifest-path src-tauri/Cargo.toml agent::hooks::templates

# 零改动自证
git diff <base>..HEAD -- src-tauri/src/agent/chat/        # 应为空（AC7）
git diff <base>..HEAD -- src-tauri/src/common/agent/      # 应为空（AC7）
git diff <base>..HEAD -- src-tauri/src/notification/      # 应为空（AC8）
git diff <base>..HEAD -- src-tauri/src/server/            # 应为空（AC8）
git diff <base>..HEAD -- src-tauri/src/agent/hooks/install/shape/  # 应为空（无新 shape）

# 包侧门禁（dsh-neeko 不在根门禁内）
cd packages/dsh-neeko && pnpm run check && pnpm test && pnpm run lint:package

# P6 全链路
dsh --profile neeko                                      # 观察插件行是否加载
curl -s http://127.0.0.1:$(ls ~/.neeko/agent-hooks/endpoints/*.env | head -1 | xargs grep NEEKO_AGENT_HOOK_PORT | cut -d= -f2)/…  # 手动探活
```

---

## 回滚点

| 回滚点 | 触发 | 动作 |
| --- | --- | --- |
| Step 0 P2 | 包落位方式都无法安全卸载 | 重新评估：是否改为「用户手动 `dsh plugin add`」+ Neeko 只做状态探测（不代装） |
| ~~Step 1 中~~ | ~~YAML 逐字节不变无法保证~~ | **已触发**（2026-10-27）→ 改为自供源：Neeko 不写入任何用户配置 |
| ~~Step 3 中~~ | ~~必须改 `packages/dsh-neeko`~~ | **已触发** → 该包即上报端，改动纳入本任务（门禁走它自带的 `prepublishOnly`） |
| 任意 | 发现必须改 `agent/chat/**` | **停止** —— 偏离目标（通知 ≠ 对话接入） |
| 任意 | 发现必须改 `notification/**` 或 `server/**` | **停止** —— 说明复用了错误的层 |
