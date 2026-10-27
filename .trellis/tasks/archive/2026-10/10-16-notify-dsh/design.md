# Design — DSH 通知接入（源 B 上报源）

> 子任务设计。跨子任务契约见父任务 `design.md`（T6–T10）。
> **✅ 2026-10-27 定案（U7）：源 B 上报，与 opencode/pi/claude/codex 同族。**
> 原「源 A 桥投影 / 写 adapter」方案**作废**（理由见 `research/dsh-consumption-decision.md` §1）。

## 1. 为什么 DSH 是源 B 而不是源 A

### 1.1 原判断错在哪

```
原推理：DSH 无 out-of-process hook 面（cordis 进程内）→ 不能上报 → 只能走源 A
         ↑ 第一步就错了
```

cordis 插件是**任意 Node 代码**。证据：`packages/dsh-neeko` 自己就在
`createServer()`（`ws-server.ts`）、`spawn()`（`index.ts:537`）、`ctx.on()`。
它当然也能 `fetch()` 往外 POST。

**「DSH 没有 hook 面」= 「DSH 没有 `settings.json` 里的 hook 配置段」**，
不是「DSH 不能上报」。

### 1.2 源 B 的真实契约

```
CLI 扩展点 → shim → POST 127.0.0.1:{随机}/hook/{source} (带 token)
          → AuthGate → validation → HookEvent → notification 投影
```

DSH 满足全部前提：

| 前提 | DSH |
| --- | --- |
| 可编程扩展点 | ✅ cordis 插件 |
| 能跑任意 Node 代码 | ✅ 实证（`dsh-neeko`） |
| 有会话 id / cwd / 标题 | ✅ `session.id` / `session.header.cwd` / `session/title` |
| 有通知相关事件 | ✅ `approval/asked` / `ask_user_question` / `agent/status` / `agent/error` |

**而且比现有任一 source 都干净**：无信任门（vs Codex）、无 JSON 结构合并（vs Claude 三源）。

## 2. 落点地图（**2026-10-27 实现后修正**）

> 原方案新增 `InstallShape::PluginPackage`（包软链 + `cordis.patch.yml` 行级受管块）。
> **未实现**：Step 0 实测显示那条路要碰用户主配置（14905 字节、含大量注释）与
> pnpm store（`ERR_PNPM_UNEXPECTED_STORE`，还会抹掉软链），而收益为零 ——
> 上报代码本来就在 `packages/dsh-neeko`，用户 profile 里已经装好它了。
>
> 落点因此改为**自供源**：`HOOK_TARGETS` 加一行空 `shapes`，上报端在 `packages/dsh-neeko`。

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `src-tauri/src/agent/hooks/targets/data.rs` | **改** | `HookTarget { source: "dsh", shapes: &[], dir: \|\| None }`（自供源） |
| `src-tauri/src/agent/hooks/install/outcome.rs` | **改** | `HookInstallStatus::self_supplied` |
| `src-tauri/src/agent/hooks/install/status.rs` | **改** | `self_supplied: target.shapes.is_empty()` |
| `src-tauri/src/agent/hooks/install/selection.rs` | **改** | 收敛跳过自供源（否则误报 `Failed`） |
| `src-tauri/src/agent/hooks/targets/tests.rs` | **改** | 自供源三条护栏 + `shapes[0]` 遍历改成全遍历 |
| `src-tauri/src/agent/hooks/templates/tests.rs` | **改** | 跳过空 `shapes`（自供源没有 Neeko 模板） |
| `src-tauri/tests/unit/http_gateway_test.rs` | **改** | `/hook/dsh` **投递**断言（不是只看 204） |
| `src/features/settings/components/CliHooksSection.tsx` | **改** | 按 `selfSupplied` 过滤开关行 |
| `src/shared/types/notification.ts` | **改** | 镜像 `selfSupplied` |
| `packages/dsh-neeko/src/notify-reporter.ts` | **新增** | 纯函数：事件 → 语义键 + 请求体 |
| `packages/dsh-neeko/src/notify-transport.ts` | **新增** | 坐标发现 + fan-out + 失败清单 |
| `packages/dsh-neeko/src/notify-wiring.ts` | **新增** | cordis 订阅 + 跨事件状态 |
| `packages/dsh-neeko/src/index.ts` · `src/tui/runner.ts` | **改** | **两条腿各自**挂载（`--tui` 时 bridge 行是 disabled） |
| `agent/chat/**` · `common/agent/**` | **零改动** | AC7 |
| `notification/**` · `server/**` | **零改动** | AC8 |

**原方案作废的连带效果**：`InstallShape` 仍是 3 个变体，`dispatch.rs` / `status.rs` /
`shape.rs` / `dirs.rs` / `templates.rs` 均**无需**改动。

## 3. 上报实现契约（`packages/dsh-neeko/src/notify-*.ts`）

### 3.1 投递（复用既有模式，逐字对齐 `neeko-pi-status.ts`）

端点覆盖有两个 env，**都必须支持**：`NEEKO_AGENT_HOOK_ENDPOINT`（单文件）与
`NEEKO_AGENT_HOOK_ENDPOINTS_DIR`（目录）。只实现前者会让「把坐标根整体搬走」的
环境里 DSH 恒零请求，而其余 7 个源正常工作。

```ts
// 坐标发现：扫 ~/.neeko/agent-hooks/endpoints/*.env（v5 多实例）
// 每次上报前重扫（目录 mtime 缓存）；800ms 超时；逐个 POST；逐个 fail-open
POST http://127.0.0.1:{port}/hook/dsh
headers: { content-type: application/json, x-neeko-agent-hook-token: <token> }
```

**硬约束**：任何异常吞掉、永不阻塞 DSH 会话（DSH 会 await 监听器）。

### 3.2 事件映射

| DSH 事件 | event_key | 关键说明 |
| --- | --- | --- |
| `session/event` → `approval/asked` | `approval_requested` | **必须用审计事件，不能用 `approval/request`** |
| `session/event` → `tool/call` 且 `name === 'ask_user_question'` | `input_requested` | |
| `agent/status` 的 `running → idle`，**且**该轮 `turn/end.reason.kind === 'completed'` | `turn_completed` | 需自记上一状态**与该轮原因**（见 §3.5） |
| `agent/error` | `session_failed` | |
| `session/event` → `session/title` | （缓存为 `title`） | 不直接上报 |

### 3.3 为什么 `approval/asked` 而不是 `approval/request`

`approval/request` 是 cordis **waterfall**（`cordis/lib/index.js:317`）：**第一个不调
`next()` 的监听器终结整条链**。`dsh-neeko` 已注册为 answerer 并 `await` Neeko 回复 ——
再加一个监听器会**抢走或破坏内置审批面板**。

`approval/asked` 是 `session.append()` 的落库审计事件
（`dsh-user-approval/lib/index.js:132`），**旁路可听、无副作用**。
这是 `dsh-messager`（`src/signals.ts`）的选择，已被社区验证。

**推论**：通知插件与 `dsh-neeko` 桥**可以共存**（前者旁听审计，后者管 answerer）。

### 3.4b `agent/*` 的载荷是 `Agent`，不是 `Session`（2026-10-27 实测缺陷）

`agent/status` / `agent/error` 给的是 `Agent`：它只有 `id`（`dsh-agent/lib/types/types.d.ts`），
`header` 在 `agent.session` 上（`dsh-session`）。

把 `Agent` 当 `Session` 读**类型上完全合法**（上报用的 `ObservedSession` 字段全 optional），
运行时才暴露两件事：`isSubagentSession` 恒 false（子代理通知泄漏）、`cwd` 恒 `null`
（Rust 归属链掉到最弱兜底）。归一集中在 `notify-wiring.ts::observedOf`。

护栏测试必须用**真实的 `Agent` 形状**（`{ id, session: { header } }`）—— 用 `{ id, header }`
会让缺陷在类型与单测上双双合法，这正是它第一次没被抓住的原因。

### 3.5 「结束」≠「完成」：原因来自 `turn/end`，时机来自 `agent/status`

只取定机会把**失败轮**与**用户中止轮**一律报成 `turn_completed`，于是
`session_failed` 与 `turn_completed` 两条互斥文案同时到达（Neeko 侧的节流主键含
`event_key`，Completed 的合并窗口不会吞掉上一条 Failed）。

这与 `.trellis/spec/backend/agent-chat-transports.md` §4.6b 记录的 pi 缺陷同型
（「失败不可被追认为完成」）。修法同样落在**会话层**：

- `session/event` 的 `turn/end` → 记 `reason.kind`（纯记录，不上报）；
- `agent/status` 的 `running → idle` → 消费并清零；只有 `completed`（或缺失，兼容旧宿主）
  才报 `turn_completed`。

不得把原因塞进纯函数 `notifyEventOf`：它只处理单条 `session/event`，看不见
`agent/status`，塞进去会把它变成有状态的翻译器。

### 3.4 子代理过滤

```ts
if (session.header.origin === 'subagent') return  // 不通知
```

**不能用 `parentSession`**：分叉会话（`sessions.fork`）的 header 也带 `parentSession`，
但 `origin` 为空，仍是顶层会话 —— 用错字段会让分叉会话**永远不通知**。
（`dsh-messager/src/index.ts:284` 的实测教训）

## 4. YAML 受管块（R3 的落地形态）

### 4.1 为什么不能解析再序列化

`cordis.patch.yml` 是用户主配置（本机 14905 字节，含 `llm-pi-ai` 等大量配置 +
注释）。`serde_yaml` 读写会**丢注释、改格式、重排键** → 对用户是数据破坏。

### 4.2 受管块形态

`cordis.patch.yml` 顶层是**数组**，追加元素合法：

```yaml
# …（用户原有全部内容，逐字节不动）…

# >>> neeko-managed:dsh-normalize <<<
- insert:
    - id: neeko-status
      name: 'neeko-dsh-status'
# <<< neeko-managed:dsh-normalize <<<
```

- 安装 = **两分支**（P3 实测：`[]` 结尾时纯追加会解析失败）
  | 文件状态 | 动作 |
  | --- | --- |
  | 已有受管块 | 替换块内容（幂等） |
  | 有效内容只有 `[]` | **替换 `[]` 行** |
  | 有其他条目 | 尾部追加 |
- 卸载 = 按标记整块删除
- 就绪 = 标记块存在 **且** 包目录在位

**判据实现**：`is_empty_flow_array(content)` —— 去注释行、空行后是否只剩 `[]`。
纯函数，零 IO，100% 单测。

### 4.3 必须的测试

- **`[]` 结尾** → 安装 → 卸载 → 原文逐字节等于初始内容（这是 P3 踩到的分支）
- **非空数组** → 安装 → 卸载 → 原文逐字节等于初始内容
- 追加 → 卸载 → 原文**逐字节**等于初始内容
- 幂等：连装两次，文件内容不变
- 用户文件中间已有同名标记时 fail-safe 跳过（不误删）
- 文件不存在 / 不可读时的 fail-safe 分支

## 5. 红线合规

| 红线 | 落点 |
| --- | --- |
| 1 统一命令执行接口 | **不触发**：P2 定案后安装腿不跑子进程（软链 + 字符串改写） |
| 3 阻塞 IO | **不触发**：无安装腿。上报端是 Node 侧旁路（fire-and-forget） |
| 9 `mod.rs` 极薄 | 新文件都是同级实现文件，不新增 `mod.rs` 业务 |
| 15 差异落数据 | DSH 差异 = `HookTarget` 一行 + `InstallShape` 字段值；通用层零 `dsh` 分支 |
| 8 路径安全 | **不触发**：Neeko 不读也不写 `~/.dsh`（自供源不落文件） |

**依赖**：**零新增依赖。**

- Rust 侧零依赖变更（不写 YAML、不跑子进程）。
- `packages/dsh-neeko` 侧零依赖变更（`node:fs` / `node:os` / `node:path` + 全局 `fetch`）。

## 6. 风险

| 风险 | 对策 |
| --- | --- |
| **YAML 破坏用户配置**（最高风险） | R3：行级追加 + 整块移除；AC3 要求「逐字节不变」测试 |
| profile 多实例（本机 6 个） | P1 定范围；倾向只装用户显式选择的 profile |
| ~~包落位不可卸载~~ | ✅ **P2 定案**：自己写软链，卸载删软链。**不用 `dsh plugin add`**（它跑 pnpm，`ERR_PNPM_UNEXPECTED_STORE`，且会把 `node_modules` 重建为真实目录抹掉软链） |
| ~~历史事件重放导致补发通知~~ | ✅ **P4 实测不重放**（resume 从 `seq=20` 起）。模板用实时事件缓存标题，不读历史 → 天然无此问题 |
| DSH 版本漂移（`0.2.0-rc.2`） | 事件名可能变；模板需 fail-open（未知事件静默忽略） |
| 模板语言（TS vs MJS） | P5 实测；`dsh-neeko` 是构建产物，可能需预构建 |
| 与 `dsh-neeko` 抢审批 | 已避开：用 `approval/asked` 而非 `approval/request`（§3.3） |
| **`[]` 结尾时追加破坏 YAML** | P3 实测已踩到 → 两分支 + 逐字节回归测试（§4.2） |
| **`/hook/dsh` 返回 204 但事件被静默丢弃** | P6b 实测踩到：`hook_source()` 白名单 fail-open。**必须先加 `HOOK_TARGETS` 行**；验收断言 sink 真收到，不看 204 |
| **Node < 24 时 `.ts` 失效** | P5 实测 Node 24 原生 strip-types 可用。模板限定「可 strip」语法子集（不用 enum / namespace / 参数属性），保 Node 22 兼容 |

## 7. 与父任务其他子任务的关系

| 子任务 | 关系 |
| --- | --- |
| `10-16-notify-claude-compat` | **同族**（`Structured` shape 的三个源）。可复用其 YAML 无关部分 |
| `10-16-notify-codex` | 同族（`NotifyArgv`）。本任务是第 4 种 shape，两者不冲突 |
| `10-16-notify-review-remediation` | 本任务新增 shape 后需同步其审查清单 |

**本任务是父任务里唯一引入新 `InstallShape` 的子任务** —— 这是它比「加一行数据」重的部分。
