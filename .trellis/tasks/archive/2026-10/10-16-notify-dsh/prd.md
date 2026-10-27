# DSH 通知接入（源 B 上报源，非 adapter）

> 子任务，父任务 `10-16-agent-notify-more-clis`（P4）。
> 跨子任务契约见父任务 `design.md`（T6–T10）。**与 hook 线同族，不并行于 hook 线。**
>
> **目标**：让 Neeko 支持 DSH 的通知能力 —— **DSH 把相关事件推送到 Neeko，和其他 agent 一样**。

## 修订史

| 日期 | 变更 |
| --- | --- |
| 2026-10-16 | 创建。假设「DSH 不是 hook 问题，走源 A 桥投影」 |
| 2026-10-27 | U7 调研（三个社区插件 + `dsh-neeko` + Neeko hook 线源码） |
| **2026-10-27** | **方向修正**：原假设错误。DSH 走**源 B 上报**，与 opencode/pi/claude/codex 同族。详见 `research/dsh-consumption-decision.md` |
| **2026-10-27（实现后）** | **落点修正**：`InstallShape::PluginPackage` 未实现，改为**自供源**（`shapes: &[]`）——上报代码活在 `packages/dsh-neeko`，Neeko 不往用户 profile 写任何文件。R2/R3/AC3/AC4 已按实际形态重写；R5.2 的「不改 `packages/dsh-neeko`」被推翻（改动即本任务的交付物之一） |

> ⚠️ **原「源 A 桥投影」判断为什么错**
>
> 原推理：「DSH 无 out-of-process hook 面（cordis 进程内插件）→ 不能上报 → 只能走源 A」。
> **第一步就错了**：cordis 插件是任意 Node 代码，`dsh-neeko` 自己就在 `createServer()` /
> `spawn()`，**它当然能 `fetch()` 往外 POST**。
>
> 「DSH 没有 hook 面」的准确含义是「DSH 没有 `settings.json` 里的 hook 配置段」，
> 不是「DSH 不能上报」。对源 B 而言 cordis 插件恰恰是**最干净**的形态
> （无信任门、无 JSON 结构合并）—— 比 Codex 的信任门简单得多。

## Goal

DSH（DeepSeek Harness）的「需要注意」事件能触达系统通知，**与其他 7 个 agent 走同一条通道**：

```
DSH cordis 插件（Neeko 安装）
   → POST http://127.0.0.1:{随机端口}/hook/dsh
   → Neeko server / AuthGate / validation
   → HookEvent
   → 既有 notification 投影（与源 A 同一 event_key 命名空间）
   → 系统通知
```

## Requirements

### R1 拓扑归属：源 B（定案）

- R1.1 DSH 作为**第 8 个上报源**接入，source 名 `dsh`。
- R1.2 接入形态 = `HOOK_TARGETS` 新增一行 + 一份上报模板 + 一个新 `InstallShape`。
- R1.3 **不写 adapter、不新增 `ChatTransport`、不改 `agent/chat/**`**。
      DSH 的**对话**能力不在本任务范围（那是另一个任务，且当前不需要）。
- R1.4 证据：`research/dsh-consumption-decision.md` §2。

### R2 接入形态：**自供源**（`shapes: &[]`，不是新 `InstallShape`）

> 原方案（新增 `InstallShape::PluginPackage`：包落位 + `cordis.patch.yml` 受管块）
> **已作废**。实现改为「Neeko 只收上报，不装任何东西」，理由见 §R2.0。

#### R2.0 为什么不是新 shape

上报代码的载体是 `packages/dsh-neeko` —— **本仓自己的 cordis 插件**，用户 profile 里
已经装好了它（`link:` 或 npm）。它与 Neeko 的关系是「同一仓库的两个产物」，
不是「Neeko 往第三方 CLI 的配置面里塞文件」。

| 原方案要做的事 | 代价（Step 0 实测） |
| --- | --- |
| 往 `profiles/<p>/**` 写文件 | 那个目录归 `dsh plugin` 管，pnpm store 冲突（`ERR_PNPM_UNEXPECTED_STORE`），且会把 `node_modules` 重建为真实目录、抹掉软链 |
| 行级改写 `cordis.patch.yml` | 用户主配置（本机 14905 字节、含大量注释），任何写坏都是数据破坏 |
| 新增 shape + 三条腿 | 新变体 + `dispatch.rs`/`status.rs` 分支 + `dirs.rs` + 模板文件 + 一整套 YAML 单测 |

而**这些能力本任务一条都不需要**：插件已经能拿到全部 host 事件。

#### R2.1 形态

`HOOK_TARGETS` 新增一行，`shapes: &[]` + `dir: || None`：

- `/hook/dsh` 因此进入接收白名单（**必须**：否则 204 但事件被静默丢弃，Step 0 P6b 实测）；
- `apply_selection` **不参与**它（没有安装腿）；
- 设置页的开关列表**不显示**它（见 R2.3）。

判据由 `targets/tests.rs::self_supplied_sources_are_not_installable` 钉住（自供源清单的
唯一登记处）+ `install/selection.rs::self_supplied_targets_produce_no_outcome`（收敛回执里
不得出现它，尤其不得是 `Failed`）。

#### R2.2 `self_supplied` 是显式字段，不是 `path.is_empty()`

`HookInstallStatus` 新增 `self_supplied: bool`。前端判据必须是它：

| 情况 | `path` | `self_supplied` | 展示开关 |
| --- | --- | --- | --- |
| 自供源（dsh） | `""` | `true` | **否** |
| 正常 CLI，目录定位不到（本机没装 pi） | `""` | `false` | **是**（用户可能要装它） |

压进一个字段 = 「未初始化的 pi」从列表里消失，用户再也装不上。

#### R2.3 DSH 之所以必须在这张表里

`HOOK_TARGETS` 同时驱动两件事：①`/hook/{source}` 的**接收白名单**；②设置页的
「Neeko 能装哪些 CLI」。DSH 只满足前者 —— 空 `shapes` 就是这两个语义的分离标记。

### R3 YAML 处理：**不写**（原「行级插入」方案随 R2 作废）

Neeko 不再触碰 `cordis.patch.yml`，因此原先那套「受管块增删 + 逐字节不变」的
测试与实现全部不需要。用户 profile 的写入面在本任务中为**零**。

### R4 上报实现（`packages/dsh-neeko/src/notify-*.ts`）

> 原方案是 `src-tauri/src/agent/hooks/templates/neeko-dsh-status.ts`（一个 Neeko 嵌入的
> 模板）。实现改为 `packages/dsh-neeko` 里的三个模块 —— 上报端不在 Tauri 侧，
> 它是 DSH 进程内的插件代码。

- R4.0 三个模块的分工（不得互相越界）：
  | 文件 | 职责 |
  | --- | --- |
  | `notify-reporter.ts` | **纯函数**：事件 → 语义键；`HookEvent` 请求体渲染 |
  | `notify-transport.ts` | **传输**：坐标发现 + fan-out + 失败清单 |
  | `notify-wiring.ts` | **挂载**：cordis 订阅 → 调上面两层的粘合，持有跨事件状态 |
- R4.0b **两条运行腿都必须装**（真机事故）：`cordis.patch.yml` 里 bridge 那一行在
  `--tui` 时是 `disabled` 的，故 `index.ts::start()` 与 `tui/runner.ts` **各自**调用
  `installNotifyReporter`。护栏断言的是**调用点**（正则），不是「文件里出现过这个名字」。
- R4.1 复用源 B 的既有投递契约（与 `neeko-pi-status.ts` 同形）：
  - 坐标发现：扫 `~/.neeko/agent-hooks/endpoints/*.env`（v5 多实例），逐个 POST，逐个 fail-open
  - 两个 env 覆盖**都要支持**：`NEEKO_AGENT_HOOK_ENDPOINT`（单文件）与
    `NEEKO_AGENT_HOOK_ENDPOINTS_DIR`（目录）—— 与既有 shim 模板同契约
  - 800ms 超时、任何异常吞掉、**永不阻塞 DSH 会话**
  - header `x-neeko-agent-hook-token`，路径 `/hook/dsh`
- R4.2 事件映射（**全部旁路可听，无副作用**）：

  | DSH 事件 | event_key | 依据 |
  | --- | --- | --- |
  | `approval/asked`（session 审计事件） | `approval_requested` | `approval/request` 是 waterfall，注册会**抢走内置审批面板** → 必须用审计事件 |
  | `tool/call` 且 `name === 'ask_user_question'` | `input_requested` | `dsh-messager/src/signals.ts` 实证 |
  | `agent/status` 的 `running → idle` **且**该轮 `turn/end.reason.kind === 'completed'` | `turn_completed` | `dsh-messager/src/index.ts:282`；原因门是本次新增（见 R4.2b） |
  | `agent/error` | `session_failed` | `dsh-messager/src/index.ts:293` |
  | `session/title` | `title` 字段 | 原生标题，无需降级链 |

- R4.3 载荷字段（`HookEvent` 契约，与既有模板一致）：

  | 字段 | 来源 |
  | --- | --- |
  | `agent_session_id` | `session.id` |
  | `event` | R4.2 映射 |
  | `cwd` | `session.header.cwd`（已核实 `types.d.ts:69`） |
  | `detail` | 审批工具名 / 错误信息（截断 500） |
  | `title` | 最近一次 `session/title` 事件（缓存） |
  | `hints` | `NEEKO_SESSION_ID` / `NEEKO_PROJECT_ID`（若 DSH 进程继承了它们） |

- R4.2b **「结束」≠「完成」**：`agent/status` 只给时机，`turn/end.reason` 给原因。
  只取定机会让失败轮先发 `session_failed`、紧接着再发 `turn_completed`
  （与 `.trellis/spec/backend/agent-chat-transports.md` §4.6b 记的 pi 缺陷同型）。
  实现：`notify-wiring.ts` 在 `session/event` 的 `turn/end` 上记原因，
  `agent/status` 落到 idle 时消费并清零（失败不得污染下一轮）。
- R4.2c **`agent/*` 的载荷是 `Agent`，不是 `Session`**：`Agent` 只有 `id`，
  `header` 在 `agent.session` 上。把 `Agent` 当 `Session` 读在类型上完全合法
  （`ObservedSession` 字段全 optional），运行时才暴露 —— 子代理过滤失效 + `cwd` 恒 null。
  归一函数 `notify-wiring.ts::observedOf`。
- R4.4 **子代理过滤**：`session.header.origin === 'subagent'` 的会话不通知
  （`dsh-messager/src/index.ts:284` 的教训：**必须用 `origin`，不能用 `parentSession`**
  —— 分叉会话 header 也带 `parentSession`，但 `origin` 为空，仍是顶层会话）。

### R5 与 `dsh-neeko` 桥的关系：**互相独立，可共存**

- R5.1 桥管**对话**（answerer 角色），通知插件管**知会**（旁听审计事件）。
  两者听的是不同事件（`approval/request` vs `approval/asked`），不冲突。
- R5.2 **本任务改 `packages/dsh-neeko`**（原「须另立任务」的判断随 R2 作废）：
  上报端就是该包内的三个新模块 + 两条腿各一处挂载。它不纳入根门禁，
  门禁是包自带的 `prepublishOnly`（`check` / `test` / `lint:package`）。
- R5.3 桥现有的三处缺口（`turn/end` / `agent/error` / `session/title` 未转发给 Neeko 的
  **chat** 面）**不影响本任务** —— 通知插件直接听 host 事件，不经过桥。
  该缺口登记在 `research/dsh-notify-prior-art.md` §5，属桥自己的技术债。

### R6 与 hook 线零耦合（保红线）

- R6.1 不改 `agent/hooks/ingest/**`（路由 `/hook/{source}` 已通用）。
- R6.2 不改 `notification/**`（AC4）。
- R6.3 不改 `server/**`（`/hook/{source}` 已存在，无需新路由）。

## Acceptance Criteria

- [x] **AC1 消费侧定案**：`research/dsh-consumption-decision.md` 记录源 B 定案与证据。
      ✅ 文档已完成（2026-10-27）。
- [x] **AC2 `HOOK_TARGETS` 含 `dsh` 行**：`builtin_configs` 无关，此处指
      `targets::HOOK_TARGETS` 新增一行，`source: "dsh"`，
      且 `hook_targets_are_unique` 全绿。
- [x] **AC3（改写）自供源语义可用**：
      - `self_supplied_sources_are_not_installable`（自供源清单唯一登记处）
      - `self_supplied_sources_are_still_accepted_by_ingest`（仍在接收白名单）
      - `self_supplied_sources_have_no_directory`（`dir` 恒 `None`）
      - `install/selection.rs::self_supplied_targets_produce_no_outcome`
        （收敛回执里不出现、**尤其不是 `Failed`**；变异验证过）
      - `CliHooksSection.test.tsx::installableHookRows`（含反证：
        `path === ''` 的正常 CLI 不得被过滤）
- [x] **AC4（改写）上报可投递**：`packages/dsh-neeko` 的单测断言
      - 四个 event_key 映射正确（`approval/asked` / `ask_user_question` /
        `running→idle` / `agent/error`）
      - 子代理会话被过滤（`header.origin`，不是 `parentSession`）
      - **失败轮与中止轮不得被追认为完成**（`turn/end.reason` 门）
      - `Agent` → `Session` 归一（`cwd` 来自 `agent.session.header`）
      - 坐标缺失时静默（fail-open），且**失败可报告**（`DeliveryFailure[]`，
        非「永不 reject 就什么都不说」）
      - 载荷六个字段齐全（`agent_session_id` / `event` / `cwd` / `detail` / `title` / `hints`）
- [x] **AC3b 投递断言不能用 204 代替**（Step 0 P6b 教训）：`/hook/dsh` 在 `HOOK_TARGETS`
      缺行时返回 **204 但事件被静默丢弃**。验收必须断言「sink 真的收到」，
      否则会得到假绿灯。
      ✅ `tests/unit/http_gateway_test.rs::dsh_source_is_accepted_by_ingest` 断言
      `delivered.len() == 1` 且载荷逐字段相等（反证：删 `dsh` 行必红）。
- [x] **AC5 实测**：DSH 会话触发审批/提问 → Neeko 失焦 → 收到系统通知。
      ✅ **真机验证正常（2026-10-27，用户确认）** —— 两条运行腿都覆盖到
      （`--tui` 与 headless 各自挂载，见 `notify-wiring.ts` 模块头）。
- [x] **AC6 既有行为不变**：`pnpm check` 全绿。
      ✅ 本地跑的是 `check:quick`（19/19 护栏 + eslint/tsc/fmt/clippy + 改动文件单测）；
      全量 `pnpm check` 按仓库分工留给 pre-push hook 与 CI。
- [x] **AC7 零 chat 层改动**：`git diff` 中 `src-tauri/src/agent/chat/**` 与
      `src-tauri/src/common/agent/**` 为空。✅ 实测为空。
- [x] **AC8 零核心域改动**：`notification/**` 无 diff；`server/**` 无 diff。
      ✅ 实测为空。附带确认 `agent/hooks/install/shape/` + `targets/shape.rs` +
      `targets/dirs.rs` + `templates.rs` 也为空（无新 `InstallShape` 变体）。

## Step 0 Spike（阻塞，必须先做）

> **✅ 已完成（2026-10-27）** —— 完整报告见 `research/step0-spike-report.md`。
> 隔离 `DSH_HOME` 实测，用户真实 profile 全程未被写入。

- [x] **P1 profile 范围**：只装默认 profile？还是扫 `~/.dsh/profiles/*`？
      本机有 `neeko` / `neeko-acp` / `web` / `tui` / `cc-tui` / `pi-tui` 六个。
- [x] **P2 包落位方式**：`link:`（本机现状）/ npm 包名 / 直接写 `node_modules`？
      三者的**可卸载性**不同，决定 R2.2 的字段设计。
- [x] **P3 patch 行插入位置**：文件末尾追加（R3.2 倾向）是否对所有 DSH 版本都合法？
      实测：追加后 `dsh --profile neeko` 能否正常启动。
- [x] **P4 历史重放**：`session/event` 在**恢复的旧会话**上是否重放？
      会 → 重启后可能补发一批历史通知，需去重。`dsh-messager` 的
      `sessionTitleOf` 注释暗示日志含重放历史。
- [x] **P5 模板语言**：DSH loader 接受 `.ts` 直接加载，还是必须 `.mjs` 预构建？
      （`dsh-neeko` 是 TS + `tsdown` 产物）
- [x] **P6 真实连接**：起 `dsh --profile neeko`，确认插件行被加载（查 stderr / 日志），
      并 POST 一条测试事件到 Neeko 验证全链路。

## 验收结果（2026-10-27）

| 项 | 结果 |
| --- | --- |
| Rust `cargo test --lib agent::hooks` | 163 passed |
| Rust `--test unit http_gateway` | 7 passed（含 `dsh_source_is_accepted_by_ingest`） |
| `packages/dsh-neeko` `pnpm test` | 1067 passed / 61 files |
| `packages/dsh-neeko` `tsc` ×2 + `check-docs` + `publint` | 全绿 |
| 根 `pnpm check:quick` | 19/19 护栏，全绿 |
| 前端 `CliHooksSection.test.tsx` | 18 passed |
| **真机（AC5）** | **正常** |

**六个变异验证**（任一退化必红）：`observedOf` 归一 / `turn/end.reason` 门 /
两条腿的挂载点 ×2 / `selection.rs` 的空 shapes 过滤 / 三个 wire 契约字面量。

## 明确不在本任务范围

- DSH 的**对话**接入（`ChatTransport` / adapter / chat 会话）—— 当前不需要。
- OMP / Claude / CodeBuddy / Qoder（`10-16-notify-claude-compat`）。
- Codex（`10-16-notify-codex`）。
- DSH 的 Web UI / ACP 形态（`~/.dsh/profiles/` 下还有 `web` / `cc-tui` / `pi-tui` 等 profile）。
