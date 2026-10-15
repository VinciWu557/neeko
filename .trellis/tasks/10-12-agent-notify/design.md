# Design — Agent 系统通知（Pi/Opencode 先行）

> 状态：**Phase A（源 A）+ Phase B（源 B：CLI hook）+ Phase C（会话主题）+ Phase F
> （多实例坐标共存）+ Phase G（hook 标记键内容寻址）均已实施**（notification 核心域 +
> agent 桥挂接 + 设置 + 前端；agent/hooks 域：事实表 + endpoint + 归属 + 投影 + loopback
> ingest + writers + 域启动入口；macOS 系统通知走 `platform/system_notify`）。
> `pnpm check` 30 护栏全绿；/neeko-check 四轮审核整改完成：capabilities 收紧、依赖方向护栏
> `check_notification_core_direction` 落地、`NotificationSettings::normalized()` 边界归一双入口、
> 双端常量镜像测试（事件名/deepLink/event_keys/hook 回执枚举）、设置保存串行链、测试投递下沉
> dispatch、hook 目标事实表化、启动逻辑回归域内 `boot`。
> 原型 `prototype/` 保留为设计载体与落点对照表（§4）。
>
> 修订记录：
> - v2 —— 通知域从 `agent/notify/` 上移为应用级域（评审：通知是应用级能力，agent 只是第一个来源）。
> - v3 —— 容纳**外部 Agent CLI 通知**（第二信号源）：参考 orca 项目
>   （`/Users/tomgs/workspaces/ts_space/orca`，Electron 版同类竞品）已验证的
>   「用户级 hook 配置 + loopback HTTP 回调 + endpoint 文件」模式，结合 Neeko 的
>   Tauri/Rust 栈与 Local/WSL/SSH 项目形态调整。
> - v3.1（实施期实测修订）—— `tauri-plugin-notification` 2.4.0 桌面端 `show()` 仅透传
>   title/body/icon/sound，**无自定义元数据、无点击回调**（`request_permission` /
>   `permission_state` 桌面侧恒返回 Granted，属桩实现）。R3.2「点击回流」据此定稿：
>   原生通知点击由系统把应用带到前台（尽力回流），**精确回流**经 in-app 通知列表条目
>   点击执行（`neeko://{domain}/{instance_id}` → 前端路由表复用 selectProject + activateTab）。
>   Rust 投递同时 emit `notification-delivered` 事件（双端常量 + 镜像测试，红线 5 合规）。
> - v3.2（macOS 实测纠错）—— 用户机（macOS 27）实证：装了插件却**只有应用内通知、系统横幅不出现**。
>   根因 = 插件 macOS 底座是 notify-rust 的 `NSUserNotificationCenter` 路径，该 API 已被 Apple
>   废弃并在 macOS 26+ 静默失效（`show()` 不报错）。因此「官方插件即平台层」这条判断**只对
>   Windows / Linux 成立**；macOS 必须自建 `platform/system_notify/`（`UNUserNotificationCenter`，
>   主线程 + bundle 守卫），其余平台由同签名 stub 返回 `None` 回退插件 —— 门面契约：
>   `Some(())` = 已被平台后端消费，`None` = 调用方走插件。点击回流（userInfo.deepLink）
>   在 UN 后端上尚未接 delegate，登记为遗留项（应用内列表仍可精确回流）。
> - v4（Phase C）—— 通知显示会话主题：`NotificationDraft` 增 `subtitle`（macOS 原生第二行；
>   Win/Linux 降级为 body 前缀），主题取原生标题优先、回退首条用户消息（D12）。
> - v5（Phase F，2026-10-15 实测修订）—— 多实例坐标共存：单文件 `endpoint.env` 被「打包版
>   + dev 同开」覆写后留下死坐标（通知全断）证伪单实例假设；改为 `endpoints/<instance-id>.env`
>   每实例一文件 + 上报端 fan-out 全部坐标（D11 / R6.8 / AC18）。

## 1. 第一性原理拆解

### 1.1 业务本质

> **「某个业务状态机的迁移边发生时，用户不在现场 —— 把这条边投影到用户的感知通道上。」**

五个底层真相：

**T1：通知不是新状态，而是既有状态机迁移边的投影。**
通知系统不感知 agent、不解析输出、不维护业务状态 —— 只是事件流的**旁路消费者**。
任何把通知做成「新状态源」的设计都是伪需求。

**T2：数据流向是单向漏斗，且必须旁路。**
物理约束：**旁路不得反压主链路**。通知失败只能静默降级，绝不能让背压或 panic 传导回
业务管道（→ R3.3）。对 hook 回调源，这条约束更强：**绝不能阻塞用户终端里的 agent CLI**
（fail-open，见 T5）。

**T3：核心裁决是一个无状态纯函数 + 极小的节流记忆。**
`evaluate(signal, env, settings, last_fired) -> Option<Draft>`，平台/插件/runtime 全隔离在外圈
→ 100% 可单测。

**T4：通知的「语义类别」是闭集，「业务来源」是开集。**
- 语义只有三种：**需要行动 / 完成 / 失败**（`NotificationClass` enum，编译期穷尽）。
- 来源无法预知 → **必须是数据**（`SourceRef.domain` + `event_key`），核心域对来源零分支。
- 依赖方向倒置：核心域不 import 任何业务域；业务域单向依赖核心域门面（如 logger 之于调用方）。

**T5（v3 新增）：信号源有二相性 —— 进程内事件流与进程外主动上报。**
「需要注意」的事实产生位置有两种物理形态：

| | 源 A：应用内会话管道 | 源 B：外部 Agent CLI |
| --- | --- | --- |
| 事实产生地 | Neeko 进程内（adapter 归一的 `StreamEvent`） | 用户终端里的 agent 进程（Neeko 不在场） |
| 感知方式 | 进程内旁路消费（零 IPC） | **agent CLI 主动上报**：hook/plugin 回调本机 loopback HTTP |
| 上下文完整度 | 完整（session/project/agent 全知） | 残缺（可能只有 cwd + agent 侧 session id） |
| 可靠性义务 | 不反压主链路 | **fail-open**：回调失败/超时绝不能阻塞或拖慢用户的 agent |

源 B 的三个硬约束（从 orca 实践反推，全部有物理依据）：
1. **坐标发现必须跨重启存活** —— Neeko 重启后端口漂移，但用户终端里还活着的 agent 进程
   无法被告知新坐标 → 回调前必须能重新发现坐标（endpoint 文件，每次回调前重读）。
2. **归属必须容忍残缺** —— 外部终端没有 Neeko 注入的上下文，归属信息是一个降级链
   （env 注入 → cwd 反查 → basename 兜底），而不是全有或全无（orca 直接丢弃无 pane 归属
   的事件，这是它未解决的缺口，Neeko 必须自己设计，见 D8）。
3. **hook 是装进用户全局配置的客人** —— `~/.config/opencode/plugins/`、`~/.pi/agent/extensions/`
   是用户级共享空间，可能有其他工具的 hook 并存。写入必须幂等、可清理、不覆盖他人
   （生命周期治理，见 D7 与 §7 风险）。

### 1.2 被剥离的伪需求

| 表面需求 | 为什么是伪需求 |
| --- | --- |
| 「通知是 agent 的子功能，放 `agent/notify/`」 | 通知是应用级横切能力。v2 已上移。 |
| 「给 Pi 写通知、给 Opencode 写通知」 | adapter/hook 事件归一后按 agent 写 = 重复实现 + 违反开闭。agent 名只是 `origin_label` 数据。 |
| 「监听 agent 输出来判断任务完成」 | 结构化事件（StreamEvent / hook payload）已存在，无需文本嗅探。 |
| 「前端 listen 事件后调系统通知」 | webview 挂起边界不可靠；节流/合并难做纯函数测试。 |
| 「自建 platform/notification/ **三平台**适配」 | 插件在 Windows（toast）/ Linux（zbus）就是活的平台层，重写等于白做。例外只有 macOS：其底座 `NSUserNotificationCenter` 已被移除（v3.2），故 `platform/system_notify/` 只交 macOS 一条腿 + 其余平台 `const fn` stub 回退插件。 |
| 「轮询 agent 状态文件/transcript 感知外部 CLI」 | hook 回调更实时、更准确、零轮询开销；transcript 轮询只是 orca 的兜底腿，Neeko MVP 不做（登记 E6）。 |
| 「为源 B 单独做一套通知决策」 | 源 B 只是**第二个投影入口**，节流/合并/焦点抑制/设置全部复用核心域 —— 这正是 T4 开集架构的验证点。 |
| 「为核心预留 Box<dyn NotificationSource> 插件框架」 | YAGNI：接入形态已固定为「投影 + 调门面」，enum+数据覆盖全部扩展维度。 |

## 2. 架构与复用设计

### 2.1 模块划分（高内聚）

**应用级通知域 `src-tauri/src/notification/`**（核心，业务无关，v2 定型不变）：

| 模块 | 单一职责 | 改变理由（唯一） |
| --- | --- | --- |
| `types.rs` | `NotificationClass` / `SourceRef` / `Signal` / `Draft` / `DecisionEnv` / `Settings` | 通知数据契约变化 |
| `policy.rs` | 纯函数裁决：节流 / 完成合并 / 截断 / 焦点抑制 / 三层开关 | 裁决规则变化 |
| `center.rs` | `NotificationCenter` 门面：observe / release_instance，业务域唯一入口 | 门面接口变化 |
| `dispatch.rs` | Draft → 系统通知投递 + 权限流 + 失败降级 | 投递通道/插件 API 变化 |
| `settings.rs` | 设置读写与默认值（挂既有 config 域）+ 两个薄命令 | 设置项增减 |
| `mod.rs` | 仅 `mod` + `pub use`（红线 9） | — |

**agent 业务域**（第一个接入方，两个信号源的知识都留在自己家里）：

| 落点 | 职责 | 源 |
| --- | --- | --- |
| `agent/chat/notify.rs` | `StreamEvent` → `NotificationSignal` 投影 + `event_keys` 常量 | A |
| `agent/chat/commands.rs` | `spawn_session_pipeline` 桥内 3 行旁路 | A |
| `agent/hooks/boot.rs` | 本域唯一启动入口：发布 ingest 坐标 + 开机收敛意图→文件（与四域 boot 对称） | B |
| `agent/hooks/targets.rs` | **受管 CLI 事实表**：source / 扩展目录 / 文件名 / 模板的唯一来源（接新 CLI = 加一行数据） | B |
| `agent/hooks/server.rs` | loopback HTTP ingest：`POST /hook/{source}` + token 鉴权 + fail-open（白名单由事实表派生） | B |
| `agent/hooks/endpoint.rs` | 多实例坐标发布（`~/.neeko/agent-hooks/endpoints/<instance>.env`，目录 0700 / 文件 0600、原子替换） | B |
| `agent/hooks/attribution.rs` | 归属纯函数：env 提示 / cwd 反查项目 / basename 兜底（D8） | B |
| `agent/hooks/writers.rs` | hook 文件写入器（差异落数据 = `targets` 表；独立文件即插拔；回执为机器可读 `HookApplyOutcome`） | B |
| `agent/hooks/templates/` | opencode plugin / pi extension 模板（`include_str!` 嵌入，锚点由测试引用常量钉住） | B |
| `agent/hooks/notify.rs` | hook payload → `NotificationSignal` 投影（第二投影入口） | B |

**前端**（既有 `features/notification/` 域内扩展）：设置 UI（数据驱动行清单）、deep link
回流路由表、授权引导、**hook 源启用开关与安装状态展示**（Phase B）。

### 2.2 接口隔离（低耦合）

- **依赖方向单一**：`notification/` 核心域不 import 任何业务域——已由护栏
  `tools/guards/checks/check_notification_core_direction.py` 机器钉死（不变量台账
  `notification-core-business-agnostic`，业务 crate 引用出现即 CI 违规）。业务域 →
  `NotificationCenter` 门面，唯一耦合点。**源 B 不触碰核心域任何代码** —— hook 事件经
  `agent/hooks/notify.rs` 投影成同一个 `NotificationSignal` 后进同一门面。
- **hooks 子系统内部**：`server.rs` 只做传输与鉴权（HTTP 细节），解析后的 payload 交给
  `attribution.rs`（纯函数）与 `notify.rs`（投影）—— 传输/归属/投影三层各自单测。
- **writers 之间零共享状态**：每个 CLI 一个独立 writer 文件（opencode 与 pi 的配置面差异
  极大：JS plugin vs TS extension），公共的只有 endpoint 坐标注入约定。新 CLI = 新 writer 文件
  （开闭），不改既有 writer。
- **policy/dispatch/焦点态/回流**：与 v2 相同（纯函数、值类型、AtomicBool、插件回调，
  零新增自定义 Tauri 事件名，红线 5）。

### 2.3 可扩展性（只加代码/配置，不改核心）

| 未来变化 | 扩展方式 | 核心域改动 |
| --- | --- | --- |
| **新业务域**（git / 终端长任务 / 导入…） | 该域内写投影 + 门面挂 3 行 + 前端路由/清单各一行数据 | **否** |
| 新 agent（应用内，如 Codex） | 什么都不做 —— adapter 归一后自动生效（AC6） | 否 |
| **新 agent CLI hook 源**（如 Claude Code、jcode） | `writers/` 加一个 writer 文件 + `notify.rs` 投影加一个 source 分支（payload 格式知识） | 否 |
| agent 域新触发事件 | 投影加 match arm + 前端事件清单加一行数据 | 否 |
| 新语义类别（极小概率） | `NotificationClass` 加 variant，enum 强制全量更新 | 是（受控加法） |
| 新投递通道（声音 / Webhook） | `dispatch.rs` 加通道函数 | 否 |
| WSL / SSH 远端 agent 的 hook 回调 | ingest server 不变；解决的是**网络可达性**（WSL：host 地址发现；SSH：反向隧道，登记 E5 不实施） | 否 |

### 2.4 复用清单（最大化复用）

1. **`StreamEvent` 协议** + **`spawn_session_pipeline` 桥** —— 源 A 触发点零新增解析。
2. **`tauri-plugin-notification`** —— 三平台投递 + 权限 + 点击回调。
3. **`config.json` 既有配置域** —— 设置持久化。
4. **前端 `notificationStore` + toast** —— in-app 轻提示既有链路。
5. **既有用户级配置写入先例** —— `theme/opencode.rs` 已在写 `~/.config/opencode/themes`、
   pi skills 已部署到 `~/.pi/skills`：writers 沿用同形态的「用户级配置客人」模式与清理义务。
6. **项目清单（ProjectStore）** —— cwd 反查归属直接消费既有项目 root 数据，不新建索引。
7. **orca 已验证的协议要素**（借鉴而非引码）：endpoint 坐标文件 `KEY=value` 格式、`x-*-agent-hook-token` 头、
   fail-open 204、回调前重读坐标、hook command 的防御性包装（文件存在性检查 + 排空 stdin）。

## 2.5 源 B 详解：Agent CLI hook 回调（v3 新增）

### 数据流

```
用户终端里的 agent CLI (pi / opencode，任意终端启动，含 Neeko 自有 PTY)
   → 用户级 hook 配置触发的上报代码（writers 安装的 plugin/extension）
      → 读 ~/.neeko/agent-hooks/endpoints/*.env（每次回调前重读；v5 多实例：全部坐标逐个 POST，
         死坐标连接失败静默跳过，跨 Neeko 重启存活）
      → POST http://127.0.0.1:{port}/hook/{pi|opencode}   [header: token]（逐坐标）
         （短超时 + 全错误吞掉 = fail-open，绝不阻塞 agent）
   → agent/hooks/server.rs（鉴权 → 204 fail-open 兜底）
      → attribution.rs 归属（env 提示 → cwd 反查 → basename 兜底，纯函数）
      → notify.rs 投影为 NotificationSignal（event_key 与源 A 同命名空间）
      → NotificationCenter.observe()  ← 与源 A 汇合，之后完全同一条管线
```

### 坐标发现与鉴权（endpoint 文件契约；**v5 多实例修订 2026-10-15**）

坐标目录 `~/.neeko/agent-hooks/endpoints/`（POSIX 0700，仅属主可列）下**每实例一个文件**：
`endpoints/<instance-id>.env`（POSIX 0600；Windows 同内容）。文件格式不变：

```sh
NEEKO_AGENT_HOOK_PORT=53124        # 每次启动随机（bind :0）
NEEKO_AGENT_HOOK_TOKEN=<uuid-v4>   # 每次启动随机，内存持有，不落 config
```

写入 = 临时文件 + 原子 rename（防 hook 读到半截文件），`instance-id` = 进程启动时生成的
随机 uuid（仅本进程内存持有，用作文件名）。上报端（pi/opencode 模板）读**目录下全部
`*.env`**，逐个 POST；单个坐标连接失败/超时/被拒一律静默跳过，不影响其余坐标与 CLI 本身
（fail-open 语义不变，R6.2）。

**为什么不是单文件（R6.8 / Phase F）**：单文件是「全局唯一会合点」，在结构上无法同时
表示 N 个活实例。实测事故（2026-10-15）：打包版 + `pnpm tauri dev` 同时运行，dev 实例
启动时覆写 `endpoint.env` 指向自己的随机端口，36 秒后 dev 退出、坐标留在死端口（`lsof` 无监听、
`curl` 连接被拒）；pi 每次上报前重读该文件 → 全部打到死端口 → 被 catch 吞掉 →
「刚启动能通知、运行着就不通知」。代码无 single-instance 约束，而用户工作流**必须**同时开
两者，故单实例假设（原 D11）被证伪，改为多实例共存。

**退役单文件**：启动时若存在旧的 `agent-hooks/endpoint.env` 一律删除（一次清理，避免
上报端同时读到新旧两种形态；上报端只需支持目录形态）。**进程退出不删除自己的坐标文件**
（下一次同 id 启动会覆盖，id 随机故基本不复用）—— 删除反而制造「重启窗口期回调失败」，
且死坐标已被上报端的 fail-open 覆盖，不再是故障源。token 校验失败 → 403 + warn 日志
（可能是旧实例残留，不升级为错误）。

### hook 事件映射（Phase B MVP 集合；**B0 实测修订 2026-10-12**）

| CLI | hook 面 | 实测事件 → 映射（Neeko 模板内归一为语义 event_key） |
| --- | --- | --- |
| opencode **1.19.0** | `<configDir>/plugins/neeko-status.js`（`export default async () => ({ event })`） | `session.status` 且 `properties.status.type==='idle'` → `turn_completed`/Completed；`permission.asked` → `approval_requested`/ActionRequired；`session.created` 记录 sessionID→directory（归属 cwd 源） |
| pi **1.1.0** | `~/.pi/agent/extensions/neeko-status.ts`（`export default function (pi)` + `pi.on`） | `agent_end` → `turn_completed`；`tool_call`（toolName 归一 ∈ {askuserquestion, requestuserinput}，判定对齐 orca 实测）→ `approval_requested`；`ui_prompt_start` → `input_requested` |

早期方案假设的 `session.idle` / `permission.updated` 事件名**不存在**于本机实测版本——
B0 spike 的价值即在此；模板与 `targets::HOOK_TARGETS` 事实表以本表为准（ingest 的路由白名单
由该表派生，不再维护第二份 source 清单）。

event_key **与源 A 同命名空间**（"approval_requested" 等）：同一节流/合并/设置键自动生效，
用户在设置页看到的仍是同一份事件清单。区分源只在 `SourceRef.instance_id`（源 B =
`cli:{agent_session_id 或 cwd hash}`）与 origin_label 文案（如 "opencode (CLI)"）。
hook 面与事件名随 CLI 版本漂移快，**实施期以官方文档实测为准**（writers 内注释登记版本）。

### 归属策略（D8，补 orca 未解缺口）

`attribution.rs` 纯函数，降级链：

1. **env 注入命中**：Neeko 自有 PTY / 自有 agent 会话启动时注入 `NEEKO_SESSION_ID`（+项目 id），
   hook 上报携带 → 精确归属到既有会话实例（源 A/B 同一 instance，天然去重）。
2. **cwd 反查**：payload 的 cwd 对 ProjectStore 项目 root 做前缀匹配（含 worktree 单元）→
   归属到项目（group_label = 项目名；instance_id = `cli:{agent_session_id}`）。
3. **basename 兜底**：无匹配项目 → group_label = cwd basename，仍然通知（宁多归属不丢事件 ——
   与 orca「无 paneKey 即丢弃」相反，这是 Neeko 的显式产品决策）。

回流（D9）：源 B 的 deep link 仍是 `neeko://agent/{instance_id}`；前端路由发现无对应 UI 会话时
**尽力回流** = 按归属项目打开/聚焦项目视图（路由表带 project_id 查询参数），不报错。

### 生命周期治理（hook 是用户全局配置里的客人）

- **用户同意**：hook 安装默认关闭，设置页显式开启后写入（尊重用户全局配置的所有权）。
- **幂等 + 可清理**：writer 写入带标记（文件名 `neeko-*` 独立文件，绝不改用户既有配置文件
  内容 —— opencode plugin / pi extension 都是**独立文件即插拔**形态，天然避免 orca 在
  claude settings.json 里遇到的结构化合并难题）；关闭开关/应用卸载时删除自己的文件。
- **版本升级**：writer 文件头注释携带 Neeko 版本号，启动时内容 hash 不一致 → 重写。

## 3. 关键设计决策记录（ADR 摘要）

- **D1 决策在后端而非前端**（同 v2）。
- **D2 节流记忆放后端内存**，不持久化（同 v2）。
- **D3 完成合并方向**：TurnEnd/SessionDone（源 A）与 session.idle/agent_end（源 B）都投影到
  `turn_completed` 键，Completed 类走合并窗口 —— **跨源同样生效**（同一 instance 时）。
- **D4 点击回流不新增自定义 Tauri 事件**（v3.1 定稿）：插件 `onAction` 直接携带
  `extra.deepLink`（`dispatch.rs` 写入，键名双端同步）回传点击，聚焦走前端路由表。
  `notification-delivered` 是**投递记录通道**（写 in-app 列表）而非回流通道；常量集中在
  `notification/dispatch.rs` + 前端 `events.ts` 双端镜像测试钉死（红线 5）。hook ingest
  本身是 HTTP，不涉 Tauri 事件。
- **D5 通知载荷上限**：正文 200 字符 Unicode 安全截断（同 v2）。
- **D6 核心域业务无关，语义闭集 enum + 来源开集数据**（同 v2）。
- **D7（v3）hook 摄入模式 = 用户级独立文件配置 + loopback HTTP + endpoint 文件 + 每次启动
  随机 token + fail-open**。参考 orca 已验证做法；只取「独立文件即插拔」形态（plugin/extension），
  不取「改用户 settings.json」形态（合并/清理成本高）。HTTP 栈实施期选型：优先复用 Cargo 既有
  依赖（若无现成 server 依赖，选最小footprint 方案，绑 127.0.0.1 仅 ingress 本地）。
- **D8（v3）归属降级链**：env 注入 → cwd 反查项目 → basename 兜底；宁多归属不丢事件。
- **D9（v3）源 B 回流尽力而为**：无对应 UI 会话时按归属项目聚焦，不报错。
- **D10（v3）分期**：Phase A = 源 A（应用内管道）全链路；Phase B = 源 B（CLI hook，local
  先行，WSL 次之）；设计一次到位，实施分期验收。**核心域两期之间零改动**（架构自证）。
- **D11（v3→v5）多实例坐标共存**：原假设「endpoint 文件全局唯一 + 单实例」被实测证伪
  （打包版 + dev 必须同开，dev 覆写后退出留下死坐标 → 通知全断）。改为 `endpoints/` 目录
  每实例一文件 + 上报端 fan-out 全部活坐标（R6.8 / AC18）。死坐标由上报端 fail-open 跳过。
  若未来引入 single-instance 约束，目录形态仍然正确（只是目录里通常只有一个文件）。

- **D12（v4）主题取原生标题优先、回退首条用户消息**（2026-10-13 用户决策）。理由：原生标题
  语义最准（用户/AI 都精炼过），但两条链路都**可能没有**——pi 仅在用户显式命名时有
  `getSessionName()`，opencode 有 1/3 会话是 `New session - <时间戳>` 占位（实测 206/621）。
  故必须有回退腿；回退成本不对称：源 A 的 `req.prompt` 现成（零采集），源 B 需模板侧读会话
  条目（pi 的 `getEntries()` 全量拷贝，只取一次并缓存）。
  **展示载体选 subtitle 而非拼 title/body**：title 有 80 字符上限，拼进去会挤掉事件名（「任务完成」
  这类承载「要不要现在看」的决策信息）；body 与 detail 混排、长正文截断时副标题先被吃掉。macOS
  原生第二行是无损选项；Win/Linux 无 subtitle 概念时降级为 body 前缀（可接受的信息损失，
  且不引入第三套拼接逻辑）。

- **D13（v6）hook 标记键改为内容寻址（2026-10-15 用户决策）**：`version_token()` 原为
  `v{CARGO_PKG_VERSION}`（**发布版本**），但它的职责其实是「已装 hook 文件是否过期」的比较键。
  用发布版本当内容缓存键是把两个生命周期不同的东西绑在一起：只改模板必须手碰发布版本 →
  三处版本漂移；忘了碰 → 已装机器**静默不更新**（原「已知限制」）。改为
  `v{CARGO_PKG_VERSION}+{template_hash}`（hash 从**已渲染全文**派生，FNV-1a 等跨版本稳定算法，
  不用 `DefaultHasher`）：模板字节一变就 hash 变 → `version_current=false` → 自动重装，
  **不再需要碰发布版本**；人眼仍可读到应用版本。代价：会覆盖用户对受管文件的手改 —— 但这些
  文件首行本就写「请勿原地编辑」，语义上更正确。旧标记（`v1.0.9`）与新标记不匹配 →
  首启自动重装一次（方向安全）。

## 4. 数据契约（原型即文档，详见 prototype/）

```rust
// 核心域（v2 定型，v3 零改动，v4 = Phase C 增 subtitle）
NotificationClass  { ActionRequired, Completed, Failed }          // 闭集 enum
SourceRef          { domain: &'static str, instance_id, origin_label, group_label }  // 开集数据
NotificationSignal { source, class, event_key, event_label, detail, topic: Option<String> }
DecisionEnv        { app_focused, instance_visible, now }
NotificationSettings { enabled, 类别开关×3, event_overrides: Map, suppress_when_focused,
                       throttle_secs, merge_window_secs, body_max_chars }
NotificationDraft  { title, subtitle, body, class, deep_link }    // v4 增 subtitle（Phase C）
                                                                  // neeko://{domain}/{instance_id}

// agent/hooks（v3 新增，v4 增 title）
HookEnvelope  { agent_session_id, event, cwd: Option, detail: Option,
                title: Option<String>,                            // v4：上报侧原生会话标题
                hints: EnvHints }
EnvHints      { neeko_session_id: Option<String>, project_id: Option<String> }     // env 注入回传
Attribution   { instance_id, group_label, project_id: Option }                     // 归属产物（纯函数输出）

// agent/chat 源 A 投影上下文（v4 增 topic）
SessionNotifyContext { session_id, agent_id, project_name, topic: Option<String> }
```

**v4（Phase C）主题语义**：`topic` 是**业务数据**（核心域零分支，R2.5 不变）——核心域只负责
非空校验 + 截断 + 落到草稿；「原生标题 vs 首条消息」的优先级判定全部在业务域（源 A 取
`req.prompt`；源 B 由模板侧判定后上报，服务端只做噪声过滤 R7.2）。subtitle 的**展示形态**
由平台后端决定（macOS 原生第二行；Win/Linux 拼进 body 前缀）——平台差异落
`platform/system_notify` 与 `notification/dispatch`，核心域不感知。

原型文件 ↔ 实施落点：

| 原型 | 落点 |
| --- | --- |
| `prototype/policy.rs` | `notification/types.rs` + `notification/policy.rs` |
| `prototype/signal.rs` | `agent/chat/notify.rs`（源 A 投影） |
| `prototype/dispatch.rs` | `notification/center.rs` + `notification/dispatch.rs` + 桥接示意 |
| `prototype/frontend-bridge.ts` | `features/notification/`（设置 / 回流路由 / 授权引导） |
| `prototype/hook_ingest.rs` | `agent/hooks/{server,endpoint,attribution,notify}.rs`（源 B 后端） |
| `prototype/hooks/opencode-status-plugin.js` | writers 生成的 opencode plugin 模板 |
| `prototype/hooks/pi-status-extension.ts` | writers 生成的 pi extension 模板 |

## 5. 实施顺序（TDD，详见 implement.md）

- **Phase A**（源 A 全链路）：插件引入 → 核心域（types+policy+center，Red→Green）→
  agent/chat 投影与桥挂接 → settings/前端 → 三平台验收。
- **Phase B**（源 B）：endpoint 发布 + ingest server（attribution 纯函数先行 TDD）→
  opencode/pi writers + 上报模板 → hook 投影接入门面 → 设置页 hook 开关与安装状态 →
  local 验收 → WSL 可达性验证。

## 6. 红线合规对照

| 红线 | 合规方式 |
| --- | --- |
| 4 IPC 大文本 | 正文 200 字符截断；hook payload 只取标量字段，diff/原文不进通知 |
| 5 Event 名常量化 | 不新增自定义 Tauri 事件；回流走插件回调；`event_keys` 常量单一源 |
| 6 薄命令层 | 设置两薄命令 + Phase B 的 `agent_hooks_install/uninstall/status` 薄命令，逻辑在域内 |
| 8 路径安全 / allowlist | ingest 仅绑 127.0.0.1 + 每次启动随机 token；endpoint 文件 0600；hook payload 的 cwd 仅用于 ProjectStore 前缀匹配，不做文件访问；capabilities 不加 allow-all |
| 9 mod.rs 极薄 | `notification/mod.rs`、`agent/hooks/mod.rs` 只有 mod + pub use |
| 10 平台集中化 | 系统通知用官方插件；endpoint 文件的 Windows 差异（`endpoint.cmd`）落 writers/endpoint 的平台分支或 platform 层，实施期按红线 10 落位 |
| 15 差异落数据 | domain/event_key/origin_label 全数据；CLI 差异 = writers/ 独立文件，通用模块零 CLI 分支 |
| 红线 1/2/3（后端） | ingest server 是独立 tokio 任务不经命令执行接口（基础设施豁免需文件内注释说明，对照 quality-guidelines 边界清单）；hook 上报脚本内的 curl/fetch 属 agent CLI 侧资产，不受 Neeko 执行接口约束 |

## 7. 风险与对策

| 风险 | 对策 |
| --- | --- |
| Windows 非打包 Toast（AUMID） | Phase A Step 0 hello-world 先行验证 |
| Linux 无通知守护 | dispatch 静默降级 + warn |
| macOS 授权时机 | 设置页「测试通知」按钮 |
| 事件风暴 | 节流 + AC4；hook 源同样经核心节流（同 event_key 命名空间的额外收益） |
| hook 面随 CLI 版本漂移（opencode/pi 事件名变更） | writers 文件头登记验证版本；ingest 对未知事件 fail-open 204 不报错；实施期实测钉住 |
| 用户全局配置污染 / 与其他工具冲突 | 只用独立文件形态（neeko-* 前缀），不改用户既有配置文件；开关默认关；可一键清理 |
| Neeko 多实例（打包版 + dev 同开） | v5 已转正为 Phase F：`endpoints/` 目录每实例一文件 + 上报端 fan-out（R6.8 / AC18）；死坐标 fail-open 跳过 |
| **多实例坐标文件无界累积**（未解决） | 坐标文件**退出不删**（避免重启窗口期失败），而 instance-id 每次随机不复用 ⇒ `endpoints/` 随每次启动单调增长；上报端 `coords()` 无上限地 `readdirSync` + `Promise.allSettled`，每次事件对**全部历史坐标**各发一次 fetch。短期内（每次启动约 60B 文件、死坐标 ECONNREFUSED 即时失败）无感，但长期（月/年计）会让每次上报的并发 fetch 数无界增长，极端下触发 agent CLI 侧 EMFILE —— 与「绝不阻塞 CLI」（T5/R6.2）相抵。**推荐修法**：坐标文件增写 `NEEKO_AGENT_HOOK_PID` + host，启动时按「同 host 且 pid 已死」剪除（pid 存活判定只会误留死文件、不会误删活实例，方向安全）；另可选上报端 fan-out 上限兜底。属本轮范围外，登记为后续项。 |
| WSL2 内 agent 访问 Windows host loopback | WSL→Windows 方向 localhost 转发不保证：endpoint 坐标文件增补 host 地址行（如 `NEEKO_AGENT_HOOK_HOST`，取自 WSL 视角的宿主 IP），Phase B2 实测；不通则参照 orca 的 guest relay 再立项 |
| SSH 远端 agent | 需反向隧道，登记 E5 不实施 |
| hook 上报泄漏隐私（cwd/prompt 片段） | 只走 loopback；payload 字段白名单（server 端丢弃未知字段）；正文截断 |

## 8. 未来扩展点（登记不实施）

- **E1** 新业务域接入模板：投影文件 + 门面挂 3 行 + 前端路由/清单各一行（§2.3）。
- **E2** 通知通道扩展：声音 / Webhook（dispatch 内加法）。
- **E3** 按项目免打扰 / 专注时段（Settings 数据扩展）。
- **E4** ~~外部终端 agent 通知~~ → **v3 已转正为 Phase B（源 B）**。
- **E5** SSH 远端 agent 的 hook 回调（反向隧道 / guest relay）。
- **E6** transcript/状态文件轮询兜底腿（orca 的第三腿；hook 丢失事件时的补偿，含
  「欠账通知」语义 —— orca 的 owed-task-notifications 模式）。
- **E7** 更多 CLI hook 源（Claude Code / jcode / Codex…）：writers/ 加文件即可（§2.3）。
- **E8** 移动端/远程推送（orca cloud fan-out 模式），依赖账号体系，远期。

## 9. Phase C（会话主题）风险与对策

| 风险 | 对策 |
| --- | --- |
| 模板改了但已装机器不更新（`version_token` = 应用版本） | **v6 已收口（D13）**：标记键改内容寻址（`v{app}+{template_hash}`），改模板即自动推送，无需碰发布版本 |
| opencode `New session - <时间戳>` 占位标题（实测 206/621） | R7.2 噪声过滤 → 视为无标题走回退，不把时间戳当"主题"展示 |
| pi 首条用户消息读取开销（`getEntries()` 全量拷贝） | 每会话只取一次并缓存（与 `sessionDirs` 同生命周期/上限）；失败即 `null` |
| 多轮会话主题漂移（每轮 `req.prompt` 不同） | 只取**首轮** prompt（续轮不覆盖）；pi/opencode 侧原生标题本身稳定 |
| subtitle 在 Win/Linux 无对应概念 | 降级为 body 前缀 `[主题] `（复用既有 `[origin_label]` 前缀口径，不新增第三套拼接） |
| 空 subtitle 在 macOS 渲染空行 | 仅非空时调用 `setSubtitle` |
