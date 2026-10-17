# Agent 系统通知（Pi/Opencode 先行）

## Goal

当用户没有盯着 Neeko 窗口时（最小化 / 失焦 / 切到其他应用），Agent 会话到达「需要用户注意」的
状态迁移点时，通过 **操作系统级通知**（macOS / Windows / Linux）触达用户，并可一键回流到对应会话。

信号源两类（design.md T5，实施分期 D10）：

- **源 A（Phase A）**：Neeko 应用内会话管道事件（`StreamEvent`，不区分 adapter）。
- **源 B（Phase B）**：**外部 Agent CLI**（用户在任意终端直接跑 pi/opencode，不经 Neeko 管道），
  经用户级 hook 配置 + 本机 loopback HTTP 回调接入（参考 orca 项目已验证模式）。

首期覆盖 Agent：**Pi、Opencode**（两源同一策略/投递管线）。
首期覆盖平台：**macOS、Windows、Linux**（复用 `tauri-plugin-notification` 官方跨平台抽象）。

## 背景与现状（2026-10-12 调研）

- 后端事件协议已完备：`src-tauri/src/agent/chat/events.rs` 的 `StreamEvent`
  （`TurnEnd` / `SessionDone` / `RequestApproval` / `UserInput` / `Error`）与
  `session_store.rs` 的 `SessionStatus::{Ready, Running, AwaitingApproval, Closed}`。
- 前端仅有 in-app 通知（`src/shared/store/notificationStore.ts` + toast 组件），**无系统级通知**。
- `Cargo.toml` 中的 `notify` crate 是文件 watcher，与通知无关；无 `tauri-plugin-notification`。
- Pi / Opencode 均无外部 hook/plugin 集成（`agent/plugin.rs` 注释确认旧 hooks 字段已移除）。
- **orca 项目调研**（`/Users/tomgs/workspaces/ts_space/orca`，Electron 同类竞品）：外部 Agent CLI
  感知 = 用户级 hook 配置（opencode plugin / pi extension 独立文件）+ `127.0.0.1` 随机端口
  HTTP 回调 + endpoint 文件坐标发现（跨应用重启存活）+ 每次启动随机 token + fail-open；
  通知决策有 5s burst 冷却、焦点抑制、设置开关。其「无 pane 归属事件直接丢弃」是未解缺口，
  Neeko 以归属降级链补齐（design.md D8）。

## Requirements

### R1 触发事件（MVP 范围）

| 触发源（StreamEvent） | 通知语义 | 默认级别 |
| --- | --- | --- |
| `RequestApproval` | Agent 等待审批 | 高（需立即响应） |
| `UserInput` | Agent 等待用户输入 | 高 |
| `TurnEnd{completed}` | 本轮任务完成 | 中 |
| `SessionDone{error}` / `Error` | 会话异常终止 | 高 |
| `SessionDone{completed}` | 会话结束（与 TurnEnd 合并去重） | 中 |
| `SessionDone{cancelled}` / `TurnEnd{stopped}` | 用户主动取消 | **不通知**（用户自己知道） |

### R2 通知决策（Policy）

- R2.1 应用窗口聚焦 **且** 该会话当前可见时，不发系统通知（避免打扰；in-app toast 由前端既有链路负责）。
- R2.2 同会话同类型通知节流：最小间隔可配（默认 2s），防止事件风暴刷屏。
- R2.3 完成合并：`SessionDone{completed}` 若紧随同会话 `TurnEnd{completed}`（默认 3s 窗口内），
  只发一条「完成」通知。
- R2.4 通知正文截断（默认 200 字符）：prompt/diff 等不定长字段禁止整段进通知（对齐红线 4 的
  「不定长载荷不进小通道」精神）。
- R2.5 决策核心**业务无关**：通知核心域（应用级 `notification/`）禁止出现任何业务分支
  （`domain == "agent"`、`agent == "pi"` 等）；业务身份与事件标识只作为数据
  （`SourceRef.domain` / `event_key` / `origin_label`）进入核心域（对齐红线 15「差异落数据」哲学）。
- R2.6 依赖方向倒置：核心域不 import 任何业务域；agent 是第一个接入方，投影逻辑
  （`StreamEvent` → 通知信号）留在 agent 域自己家里。新业务域接入 = 自己域内写投影 +
  调核心门面，核心零改动。

### R3 投递与回流

- R3.1 系统通知经 `tauri-plugin-notification` 投递，三平台免手写 `#[cfg]`（对齐红线 10：官方插件
  即平台适配层，不自造 `platform/notification/`）。
- R3.2 通知携带回流标识（session_id / project_id）；点击通知 → 唤起窗口 → 前端聚焦对应会话。
- R3.3 通知发送失败（系统权限被拒等）静默降级：记 warn 日志，绝不影响会话管道主流程。

### R4 用户设置

- R4.1 全局开关；R4.2 三层开关：全局 → 语义类别（需要行动/完成/失败）→ 事件级覆盖
  （`"{domain}.{event_key}"` 数据键，新业务接入设置 = 前端事件清单加一行数据）；
  R4.3 「仅在窗口失焦时通知」开关（默认开）；
  R4.4 设置持久化到 `~/.neeko/config.json`（复用既有配置域，不新增存储文件）。
- R4.5 系统通知权限未授予时，前端设置页给出引导（各平台授权入口不同，由插件 API 探测）。

### R5 平台差异验收

- macOS：通知中心可见、点击唤起；未授权时 `is_permission_granted`/`request_permission` 流程可用。
- Windows：Toast 弹出（AppUserModelID 正确，打包/非打包模式均验证）；点击唤起。
- Linux：libnotify 通道弹出（GNOME/KDE 至少各一）；无通知守护进程时静默降级不 panic。

### R6 外部 Agent CLI hook 接入（源 B，Phase B）

- R6.1 **坐标发现跨重启存活**：hook 上报代码每次回调前重扫 `~/.neeko/agent-hooks/endpoints/*.env`
  （每实例一文件，0600、原子替换；v5 多实例，见 R6.8）；Neeko 重启换端口后，终端里仍存活的
  agent 进程可继续上报（AC13）。
- R6.2 **fail-open**：上报全链路（endpoint 缺失/网络失败/超时 800ms/鉴权拒绝/畸形载荷/未知事件）
  任何异常都不报错、不重试风暴、不阻塞用户终端里的 agent CLI（AC12）；ingest 对畸形请求一律 204。
- R6.3 **鉴权与安全**：ingest 仅绑 `127.0.0.1` 随机端口；每次启动随机 token（仅内存 +
  0600 endpoint 文件）；载荷字段白名单，未知字段丢弃。
- R6.4 **归属降级链**（D8）：Neeko 注入 env（`NEEKO_SESSION_ID`/`NEEKO_PROJECT_ID`）精确归属 →
  cwd 反查项目（最长前缀，含 worktree 单元）→ cwd basename 兜底；**不丢事件**。
- R6.5 **用户级配置客人义务**：hook 安装默认关闭，设置页显式开启；只写独立文件
  （`neeko-status.*`，绝不修改用户既有配置文件内容）；幂等、版本升级自动重写、开关关闭/卸载时清理。
- R6.6 **统一管线**：hook 事件投影到与源 A 相同的 `event_key` 命名空间，节流/合并/三层开关/
  投递/回流全部复用核心域，核心域零改动（AC11 + AC10 同源验证）。
- R6.7 环境分期：Local 先行；WSL（宿主地址可达性）Phase B2 实测；SSH 远端登记不实施（E5）。
- R6.8 **多实例坐标共存（Phase F，2026-10-15 用户实测提出）**：单一 `endpoint.env` 在
  「打包版 + `pnpm tauri dev` 同时运行」时被后启动实例覆写，且先退出实例留下**死坐标**
  （端口无监听）—— pi 每次上报前重读该文件，读到死坐标即 `fetch` 被拒并被 fail-open 吞掉，
  表现为「刚启动能通知、运行着就不通知」直到 Neeko 重启。要求：多个活实例的坐标**共存**，
  上报端向**全部活实例**投递；任一实例启停不影响其余实例的通知（用户决策：dev 与打包版**都弹**）。
  坐标文件缺失/无监听一律按 fail-open 静默跳过，**不重试风暴、不阻塞 CLI**（R6.2 不变）。

### R7 通知显示会话主题（Phase C，2026-10-13 用户实测提出）

现象：通知只有「项目名 · 事件名」（如 `neeko · 任务完成`），无法判断是哪个会话 —— 多会话
并行时通知不可操作（点开还要找）。要求：通知内容必须携带**当前会话主题**。

- R7.1 **主题取值优先级**（用户决策：原生标题优先，回退首条用户消息）：
  1. agent 原生标题 —— opencode `Session.title`（`session.updated` 事件，AI 自动命名或用户命名）；
     pi `ctx.sessionManager.getSessionName()`（用户显式命名才有值）；
  2. 回退：该会话**首条用户消息**截断；
  3. 都无 → 不显示主题（保持现状 `项目 · 事件`，不回退成空串占位）。
- R7.2 **噪声过滤**：`New session - <ISO 时间戳>` 一类占位标题不算主题（实测 opencode 621 条会话中
  206 条为该形态）→ 视为「无原生标题」，走 R7.1 回退。
- R7.3 **展示载体 = subtitle**（用户决策）：`NotificationDraft` 新增 `subtitle` 字段；
  macOS 走 `UNMutableNotificationContent.setSubtitle`（原生第二行）；Windows/Linux 插件无 subtitle
  概念 → 降级为 `body` 前缀 `[主题] `（与既有 detail 前缀口径一致）。
- R7.4 **源 A（Neeko 自有会话）主题**：`SessionNotifyContext` 增 `topic`，值 = 该会话首条用户
  prompt（现成 `StreamRequest.prompt`，多轮时只在首轮取；续轮不覆盖）。
- R7.5 **源 B 主题载体**：`HookEnvelope` 增可选 `title` 字段（白名单内，R6.3 不变）；
  两个上报模板补齐上报（opencode 监听 `session.updated`；pi 取 `getSessionName()` 回退首条用户消息）。
- R7.6 **降级链不阻塞**：主题缺失/获取失败绝不影响投递（R6.2 fail-open 同口径）；
  pi 侧读会话条目失败 → 上报 `title: null`。
- R7.7 **应用内列表同源**：in-app 通知列表展示同一 `subtitle`（单一事实源，不各拼一套）。

## Non-Goals（本期不做）

- SSH 远端终端里的 agent hook 回调（需反向隧道 / guest relay，登记 design.md E5）。
- hook 上报失败的落盘补发（spool）与 transcript/状态文件轮询兜底腿（登记 E6）。
- 除 Pi / Opencode 外的其他 CLI hook 源（Claude Code / jcode 等，writers 加文件即可，登记 E7）。
  **2026-10-16：已转入 `10-16-agent-notify-more-clis` 实施**（OMP + Claude/CodeBuddy/Qoder
  先行；Codex / DSH 独立子任务）—— 见该任务 design.md 的 T6 拓扑三分类。
- 自定义通知声音、通知分组堆叠策略、免打扰时段、移动端/远程推送（E2/E3/E8）。
- 通知历史中心（复用既有 `notificationStore` 即可，不新建域）。

## Acceptance Criteria

- [ ] AC1：Opencode serve 会话触发 `RequestApproval`，窗口最小化时三平台均收到系统通知，点击回流到该会话。
- [ ] AC2：Pi headless 会话 `TurnEnd{completed}` → 收到完成通知；紧随的 `SessionDone{completed}` 不再重复通知（R2.3）。
- [ ] AC3：窗口聚焦且会话可见时触发同类事件 → 不发系统通知（R2.1），in-app toast 行为不回退。
- [ ] AC4：2 秒内同会话连发 10 个 `RequestApproval` → 系统通知 ≤ 1 条（R2.2）。
- [ ] AC5：`UserInput.prompt` 为 10KB 长文本 → 通知正文 ≤ 200 字符 + 省略号（R2.4）。
- [ ] AC6：新增一个 mock agent adapter → 通知链路零改动即生效（R2.5，用 `ChatStart::Mock` 验证）。
- [ ] AC7：通知插件投递失败（模拟权限拒绝）→ 会话流不中断，仅日志告警（R3.3）。
- [ ] AC8：设置页可开关全局/分类型通知，重启后生效（R4.4）。
- [ ] AC9：决策核心纯函数单测覆盖率 100%（TDD：先测后码）。
- [ ] AC10：核心域可扩展性钉子 —— 一个非 agent 业务域（如模拟 "git"）的信号走同一裁决管线
  得到正确草稿（R2.5/R2.6，单测 `unknown_future_domain_flows_through_core`）。
- [ ] AC11（Phase B）：在**外部终端**（非 Neeko 启动）跑 opencode/pi 会话，任务完成/等待审批时
  Neeko 发出系统通知，group_label 为归属项目名或 cwd basename（R6.4/R6.6）。
- [ ] AC12（Phase B）：Neeko 未运行 / token 不符 / 上报超时时，外部 agent CLI 会话行为与延迟
  无任何可观测变化（R6.2 fail-open）。
- [ ] AC13（Phase B）：外部 agent 会话存活期间重启 Neeko（端口漂移），下一条 hook 事件仍送达（R6.1）。
- [ ] AC14（Phase B）：设置页关闭 hook 开关 → `neeko-status.*` 文件被清理，外部 CLI 恢复无上报；
  重复开启幂等（R6.5）。
- [ ] AC15（Phase C）：opencode 会话（有 AI 命名 title，如 `neeko-probe`）任务完成 → 通知显示该 title
  为副标题（macOS 第二行），非 `New session - …` 占位（R7.1/R7.2）。
- [ ] AC16（Phase C）：pi 会话（未显式命名）→ 通知副标题为该会话首条用户消息截断；两条会话并行时
  通知可区分（R7.1 回退）。
- [ ] AC17（Phase C）：`title` 获取失败/缺失 → 通知仍正常投递（无副标题），会话流零影响（R7.6）。
- [ ] AC18（Phase F）：打包版与 `pnpm tauri dev` **同时运行**时，两个实例都能收到同一条 pi
  上报（R6.8）；关闭/重启任一实例后，另一实例的通知不受影响；退出实例留下的坐标不再让上报
  打到死端口（AC13 的单实例版语义推广到多实例）。
- [ ] AC19（Phase H）：macOS 上**同一 bundleIdentifier 的多个构建形态**（打包版 / dev bundle /
  本地 build）必须共享同一份系统通知授权 —— 由稳定自签名证书保证身份恒定
  （`NEEKO_CODESIGN_IDENTITY` + `scripts/macos-sign.sh`）；身份缺失或漂移时**不得静默**降级
  （dev bundle 走 adhoc 必须 warn，签名脚本未设身份必须 fail 而非静默跳过）。
- [ ] AC20（Phase H，**已验收 2026-10-16 15:21**）：`~/.neeko/neeko.log` 出现 `UN accepted`
  而非 `not granted`。实测 15:21 起 **4/4 accepted 且跨两次重启仍有效**；
  **不依赖** `sudo tccutil reset Notifications com.neeko.desktop`（该命令实测 exit 70，且非必要）——
  恢复动作是「稳定签名 + 重启进程」。收敛判据：重装 app 后必须重签
  （`NEEKO_CODESIGN_IDENTITY="Neeko Development" scripts/macos-sign.sh <app>`），否则复发。

## Constraints

- 本阶段（当前任务）**只产出方案与原型**（`design.md` + `prototype/`），不修改 `src/`、`src-tauri/`。
- 实施落点：通知核心 = 应用级域 `src-tauri/src/notification/`（业务无关）；agent 投影 =
  `src-tauri/src/agent/chat/notify.rs`；前端 = 既有 `features/notification/` 域内扩展。
- 实施阶段必须遵守仓库红线：4（IPC 载荷）、5（事件名常量）、6（薄命令层）、10（平台代码集中化）。
- 遵循 TDD：决策层纯函数先写测试（AC9）。
