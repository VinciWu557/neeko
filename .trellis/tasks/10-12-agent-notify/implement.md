# Implement — Agent 系统通知（应用级通知域 v3：双信号源）

> 前置：本文件是实施期执行计划。当前阶段（方案与原型）已完成，`task.py start` 前须过一遍
> `trellis-before-dev` 载入 backend/frontend spec。原型代码在 `prototype/`，迁移时 TDD 测试先行。
>
> 落点总览（design.md §2.1）：
> - 核心：`src-tauri/src/notification/{types,policy,center,dispatch,settings,mod}.rs`（业务无关）
> - agent 源 A：`src-tauri/src/agent/chat/notify.rs` + `commands.rs` 桥内 3 行
> - agent 源 B：`src-tauri/src/agent/hooks/{boot,targets,endpoint,server,attribution,notify,writers}.rs`
>   + `templates/`
> - 平台层：`src-tauri/src/platform/{system_notify,private_file}/`（macOS UN 后端 + 私有文件原子写）
> - 前端：`src/features/notification/` 域内扩展
>
> 分期（D10）：Phase A 先行独立可发布；Phase B 依赖 A 的核心域与设置页。**两期之间核心域零改动**
> （架构自证点，验收时核对 notification/ 目录在 Phase B 的 diff 应为空或仅注释）。

## Phase A —— 源 A：应用内会话管道

### Step A0 依赖与配置（三处同步，对照根 AGENTS.md「改构建或权限配置」playbook）

- [x] `src-tauri/Cargo.toml`：`tauri-plugin-notification = "2"`
- [x] `app/boot.rs`：`.plugin(tauri_plugin_notification::init())`
- [x] `tauri.conf.json` / `capabilities/default.json`：notification 权限最小集（禁止 allow-all）
- [x] `package.json`：`@tauri-apps/plugin-notification`
- [x] hello-world 通知三平台弹出验证（自动化部分：`pnpm tauri dev` 在 macOS 启动无 panic、
      命令注册编译通过；**OS 弹窗肉眼确认与 Win/Linux 实机属人工验收清单**，见文末）

### Step A1 应用级核心域（纯函数，TDD）

- [x] 新建 `notification/` 域骨架（mod.rs 极薄，红线 9），注册进 `AppStateWrapper`
- [x] 迁移 `prototype/policy.rs` → `types.rs` + `policy.rs`：**先迁 tests 确认 Red，再迁实现 Green**
      （AC9 100% 覆盖；含 AC10 钉子 `unknown_future_domain_flows_through_core`）
- [x] `center.rs`：门面（Mutex 锁内只跑纯函数，投递前释放锁，不跨 await 持锁）

### Step A2 agent 域接入（源 A）

- [x] 迁移 `prototype/signal.rs` → `agent/chat/notify.rs`（投影 + event_keys 常量 + 单测）
- [x] `spawn_session_pipeline` 桥挂旁路 3 行（投影 → observe → SessionDone 时 release_instance）
- [x] `FocusTracker` 挂 app 域既有 `on_window_event`
- [x] `instance_visible` 事实来源：复用 session_store / 前端既有上报，禁止新增轮询
- [x] AC1/2/3/4/6/7 集成验证（Mock adapter 验证 AC6）

### Step A3 设置域

- [x] `settings.rs`：挂既有 config.json（serde 命名对齐 config 域；Duration 用 u64 秒字段）
- [x] 薄命令 `notification_settings_get/set` → `neeko_invoke_handler!`（红线 6）
- [x] config 迁移兼容：旧配置无 notification 字段 → serde default

### Step A4 前端

- [x] 设置 UI：全局 + 类别开关 + `NOTIFIABLE_EVENTS` 数据行渲染事件级覆盖 + 测试通知按钮（R4.5）
- [x] `attachNotificationReflow` 接线 useAppShell；路由表复用既有会话切换 action
- [x] 前端事件清单与后端 `event_keys` 同步机制评估（红线 5 精神）
- [x] AC8 验证

### Step A5 三平台验收（R5）+ `pnpm check` 全绿

## Phase B —— 源 B：外部 Agent CLI hook（2026-10-12 实施完成）

### Step B0 选型与预研（完成）

- [x] HTTP 栈选型：std::net TcpListener 手写最小 HTTP（零新依赖，仅 ingress 127.0.0.1，内核/壳分离）
- [x] opencode 1.19.0 / pi 1.1.0 事件面实测（design §2.5 映射表已按实测修订——
      早期假设的 session.idle/permission.updated 不存在，实际为 session.status(idle)/permission.asked）
- [x] 多实例语义确认：endpoint 后启动覆盖 + 先启动实例 token 失配 403 静默（D11 天然降级）
- [ ] （遗留）Neeko 自有 PTY env 注入 `NEEKO_SESSION_ID`/`NEEKO_PROJECT_ID`：归属链第 1 级
      数据源就绪未接线，当前外部终端走 cwd 归因（功能完整，精度降级可接受）

### Step B1 ingest 后端（完成，TDD）

- [x] `agent/hooks/attribution.rs`：降级链三级纯函数 + 7 单测（tempdir 夹具，红线 13）
- [x] `agent/hooks/endpoint.rs`：0600 + 原子替换经 **新 platform 主题 `private_file`**
      （红线 10 三平台全套：unix rename / windows 先删后改名）；boot on_setup best-effort 挂接
- [x] `agent/hooks/server.rs`：`ingest()` 纯内核（token 403/白名单/大小上限/fail-open）+
      nonblocking accept 薄壳；envelope 字段白名单（serde 忽略未知字段）
- [x] 单测 12：坏 token 403、缺 token 403、畸形/超限/未知 source/空 id 全 204 fail-open、
      happy path sink；e2e：真机 curl 三向 204/403/204 + endpoint 文件 0600 实证
- [x] 语义归一设计：模板侧把 CLI 原生事件名翻译为共享 event_key，server 不认识 CLI 方言
      （新 CLI 接入 = `targets::HOOK_TARGETS` 加一行数据：模板 + 目录 + 文件名，
      路由白名单与安装/卸载/状态/收敛全部由该表派生，投影与设置页零改动）

### Step B2 writers 与上报模板（完成）

- [x] `writers.rs`：独立文件即插拔（`neeko-status.js`/`.ts`），归属标记
      `// @neeko-managed-hook v<ver>`，幂等（同内容不重写）+ 他人文件保护 + 状态三态；单测 6
- [x] 模板实装 `agent/hooks/templates/`（endpoint 重读 + mtime/ino 缓存 + 800ms fail-open +
      hints 回传 + 模板契约锚点自校验测试）；prototype 模板保留作设计对照
- [x] 薄命令 `agent_hooks_apply/agent_hooks_status`（命令在 agent 域——notification 域
      反向 import 被依赖方向护栏禁止）；设置页 `cliHooks` 开关默认关，串行链
      「先持久化意图 → 再安装/卸载 → 呈现逐 CLI 结果」；联动测试 1 例
- [ ] （遗留，见 B0）自有 PTY env 注入

### Step B3 验收（自动化部分完成；⚠ 标人工项）

- [x] AC12（单元面）：token 错/畸形/超限全 fail-open 204；模板侧全异常吞掉
- [x] AC6/AC10 架构自证：`notification/` 核心域在 Phase B 全部改动后 **diff 为零**
      （仅 FE 类型加了 cliHooks 数据字段），25/25 护栏含依赖方向钉子
- [x] 真机 curl 端到端：endpoint 0600 发布 → /hook/pi 合法上报 204 →
      无投递失败日志（系统横幅弹窗属人工目视项 ⚠）
- [ ] ⚠ AC11：真实 pi/opencode 终端会话完成/审批 → 通知弹出（需 CLI 登录态，用户环境）
- [ ] ⚠ AC13：会话存活期间重启 Neeko → 后续事件仍送达（endpoint 重读逻辑有单测，实机待验）
- [ ] ⚠ AC14：设置页开启 → 两文件真实落盘 → 关闭清理（writers 单测已过，实机待验；
      遵守客人义务：本环境未替用户安装，需用户在设置页显式开启）

### Step B4（次优先）WSL 可达性

- [ ] endpoint.env 增补 `NEEKO_AGENT_HOOK_HOST`（WSL 视角宿主地址）实测；
      不通则参照 orca guest relay 另立任务（E5 同路径覆盖 SSH）

## Step C 审核整改（第四轮 /neeko-check，2026-10-13）

> 增量审计覆盖前三轮未看的 `agent/hooks/*`、`platform/{system_notify,private_file}/*`、
> `dispatch` 平台回退与 `boot` 接线，产出 2 Block + 8 Warning，本轮全部整改：

- [x] **Block｜跨平台编译**：`system_notify/default.rs` 的 stub 是 `const fn` 却按值收 `String`
      → rustc `E0493`（析构不能在 const fn 求值）。本地 macOS 走 `macos.rs`，该文件根本不进
      编译单元，`pnpm check` 25/25 是假绿；CI ubuntu/windows 矩阵一编译即红。
      修法 = 门面签名改 `&str`（无析构 → `const fn` 合法，红线 10 的 stub 要求仍满足），
      `dispatch` 两处 `.clone()` 同时消失（Win/Linux 不再为空 stub 白克隆）。
- [x] **Block｜启动不变量**：ingest 启动 + 开机收敛原样内联在组合根 `on_setup`（含裸块内
      `use ...writers`），违反 `src-tauri/AGENTS.md`「每域一个 boot 入口」。新增
      `agent/hooks/boot.rs::boot(app, neeko_dir, want_cli_hooks)`，组合根降到一次调用，
      入参给到"具体事实"而非 `&AppStateWrapper`（对齐 `lsp::boot::attach` 既有写法）。
- [x] **红线 13**：`endpoint.rs` 测试的 `/tmp/x` 与 `writers.rs` 的 `/xdg-base-test` 改为
      `tempdir()` 派生；env 改写包进 `ScopedEnv`（Drop 还原，断言 panic 也不污染同进程）。
- [x] **DRY / 开闭**：`(source, 目录, 文件名, 模板)` 三处手抄 + `HOOK_TARGET_CLIS` 计数常量 +
      `server::KNOWN_SOURCES` 白名单 → 合并为 `targets::HOOK_TARGETS` 单表；writers 的
      install/status/uninstall 变成对表的遍历（`*_at` 显式收目录，可 tempdir 直测）；
      ingest 路由白名单由表派生。接第三个 CLI = 加一行数据。
- [x] **跨语言契约**：hook 回执从 `Vec<String>`（前端靠 `includes('failed')` 嗅英文散文）改为
      机器可读 `HookApplyOutcome{source,status,detail}`，前端按 `status` 分类；新增双端镜像测试
      （枚举 5 值 + 字段名）；模板锚点测试改为引用 `TOKEN_HEADER` / `ENV_KEY_*` 常量本身。
- [x] **资源底线**：ingest accept 循环每连接无条件 `thread::spawn` 且无上限 → 加
      `InflightGuard`（RAII，拒绝路径归还计数），上限 16；补单测证明不泄漏名额。
- [x] **护栏与文档一致**：`check_notification_core_direction` docstring 声称禁 `app/core/…`
      而元组里没有（`crate::app::` 静默漏检）→ docstring 改为「清单 = 元组本身」，元组补 `app`、
      删已不存在的 `skill`，selftest 补 `crate::app::` 违规 / `crate::app_state::` 允许两条边界。
- [x] **文档漂移**：`dispatch.rs` 头（"平台差异全部由插件处理"）、`notification/mod.rs`、
      `endpoint.rs` 指向不存在的 `IngestServer::start`、design.md「官方插件即平台层」判断行
      → 全部按 v3.2 实测结论改写；`head_complete` 去掉无用入参；opencode 模板 `sessionDirs`
      加 200 上限防常驻进程无界增长。
- [x] **开发态系统通知可用性（2026-10-13 实测补齐）**：`tauri dev` 跑裸 Mach-O → `UNUserNotificationCenter`
      直接 abort（`bundleProxyForCurrentProcess is nil`，exit 134），只能回退插件；而插件底座
      `NSUserNotificationCenter` 在 macOS 26+ 静默失效（调用成功、日志无错、横幅不出现）——
      开发态于是只剩应用内通知。修法：`src-tauri/.cargo/config.toml` 的 target runner 指向
      新增的 `scripts/macos-dev-bundle.sh`，把 `cargo run` 产物包成 adhoc 签名的
      `target/dev-bundle/NeekoDev.app` 再 exec（与生产同 identifier，继承已授予授权）。
      最小充分条件逐项实测：.app + `Info.plist`(CFBundleIdentifier) + `codesign` + `lsregister`，
      缺一即 `UNErrorDomain Code=1 not allowed`；脚本 fail-open（包装失败打 warn 并裸执行）。
      同时 `post()` 补 `add` 回调日志（失败不再静默）、`try_deliver` 的 unbundled warn 改为
      指名修法。证据：`NEEKO_DEV_BUNDLE_TRACE=1 pnpm tauri dev` → `[dev-bundle] exec …`；
      真实投递日志 `[notify] macOS: UN accepted neeko-<uuid>`（此前为 bare-binary 回退 warn）。
- [x] **前台横幅静默（2026-10-13 实测补齐，用户实测反证后定位）**：dev .app 修好后通知仍只有
      应用内提示。usernoted 日志显示通知被收下且「presented as banner」，但呈现选项是**空集**：
      13:32（前台，无 delegate）`as banner ([])` vs 11:43（后台，无 delegate）
      `as banner (["badge","sound","alert"])`。机制：`UNUserNotificationCenter` 未挂 delegate 时，
      **前台**应用的呈现选项退化为空集 —— 不报错、进通知中心、不弹横幅；Neeko 常驻前台故必中。
      修法：`platform/system_notify/macos.rs` 新增 `NotificationDelegate`（`define_class!`，
      `willPresentNotification` 返回 `[Banner, Sound, List]`），center 初始化时 `setDelegate`
      并由 thread_local 持强引用（delegate 是 weak 属性，不持有立刻释放）。
      对照实验（Swift 探针 + usernoted 日志）：无 delegate 前台 `([])` → 有 delegate 前台
      `(["sound","list","banner"])`；修复后真实链路（ingest → policy → UN，Neeko 在前台）
      同样得到 `(["sound","list","banner"])`。回归守卫：`macos.rs` tests 两条（掩码非空含
      Banner、委托实现选择器），断言的是「功能静默消失」这一无编译错误的故障形态。
- [ ] （登记未做）**D9「按归属项目尽力回流」未落地**（2026-10-13 审查发现）：
      `Attribution.project_id`（`agent/hooks/attribution.rs:38`）四个出口全部生产它，
      但全链路**零消费者** —— `server.rs::deliver_signal` 与 `hooks/notify.rs::project` 都只取
      `instance_id`/`group_label`；`types.rs::deep_link_for` 只拼 `{domain}/{instance_id}`
      （不带 project），前端 `reflow.ts` 路由表只有 `domain === 'agent'` 一行。
      而源 B 的 instance 恒为 `cli:{agent_session_id}`，`reflowAgentChatSession` 按
      `t.data.sessionId === sessionId` 查找**永不命中** → 无 UI 会话时既不聚焦项目也不报错。
      即：design D9 要兜的场景目前无人兜，字段是需求缺口的一半实现。
      落地方式（二选一，需跨栈同改）：① `deep_link_for` 带 `?project={id}`，前端路由表
      消费并在无会话时 `selectProject`；② 若决定不做，按 YAGNI 从 `Attribution` 删该字段
      （含 9 处测试断言）。**在落地前不要删除字段** —— 它是缺口的路标。
- [ ] （登记未做）macOS UN 后端点击 delegate（`userInfo.deepLink` 精确回流）—— 当前
      应用内列表兜底；`platform/notify_base` 更名 `uri_base`（与 system_notify 名字相邻易误读）。
- [ ] **已知限制（本轮新发现，未改语义）**：`version_current` 只比归属标记里的**应用版本**，
      不比模板正文。因此「同版本号内改模板」不会自动推到用户机器（本轮 `sessionDirs` 上限
      就属于这一类：要等版本位变化，或用户在设置页把开关关开一次）。若改成「与 `render()`
      全文比对」即可自愈，但那会覆盖用户对受管文件的手改 —— 模板头写的是「请勿原地编辑」，
      两种语义都说得通，留给下一次决策，勿顺手改。

## Phase C —— 通知显示会话主题（2026-10-13 规划，待实施）

> 需求与验收见 prd.md R7 / AC15-17；决策与契约见 design.md D12 / §4。
> 用户已确认两点：主题取**原生标题优先、回退首条用户消息**；载体 = **新增 subtitle 字段**
> （macOS 原生副标题，Win/Linux 降级拼 body 前缀）。

### Step C1 核心域：`subtitle` 契约（TDD）

- [ ] `notification/types.rs`：`NotificationSignal` 增 `topic: Option<String>`；`NotificationDraft` 增
      `subtitle: String`（空串 = 无副标题，序列化保持 snake_case，前端镜像同步）。
- [ ] `notification/policy.rs::compose_draft`：`subtitle = truncate_chars(topic.trim(), MAX_SUBTITLE_CHARS)`；
      空/全空白 → 空串（**不回退成 `[]` 占位**，R7.1 第 3 档）。
      新增 `pub const MAX_SUBTITLE_CHARS: usize = 60;`（与 title 80 / body 配置化 200 区分：
      副标题是单行展示位，超长在 macOS 上会截断且不显示省略号）。
- [ ] 单测：非空 topic 落 subtitle；`None` / `"   "` → 空串；超长 Unicode 安全截断（CJK/emoji）。
- [ ] 平台后端：`platform/system_notify/macos.rs` 的 `try_deliver` 增 `subtitle: &str` 参数 +
      `content.setSubtitle(&NSString::from_str(subtitle))`（**仅非空时调用** —— 空 subtitle 会让
      macOS 渲染出空的第二行）；`default.rs` stub 同步改签名（红线 10 门面完整性，`&str` 保持 `const fn`）。
- [ ] `notification/dispatch.rs`：调 `try_deliver(&app, &draft.title, &draft.subtitle, &draft.body)`；
      插件回退路径（Win/Linux）在 subtitle 非空时把 `body` 前置 `[{subtitle}] `（R7.3 降级）。

### Step C2 源 A：Neeko 自有会话主题

- [ ] `agent/chat/notify.rs`：`SessionNotifyContext` 增 `topic: Option<String>`；`source()` 不含它
      （主题属于**信号内容**不属于来源标识），由 `project()` 填入 `signal.topic`。
- [ ] `agent/chat/commands.rs::spawn_session_pipeline`：`topic: first_turn_prompt(req)` —— 构造时
      取 `req.prompt`；**续轮（`req.session_id` 命中既有会话）不覆盖**已有 topic（多轮时保留首轮
      主题；实现 = `SessionHandle` 或 `SessionNotifyContext` 里只写一次，具体落点在实施时定）。
- [ ] 单测：首轮 prompt → topic；续轮 → topic 保持首轮值；prompt 为空白 → `None`。

### Step C3 源 B：hook 上报携带原生标题

- [ ] `agent/hooks/notify.rs`：`HookEnvelope` 增 `#[serde(default)] title: Option<String>`（白名单，
      R6.3 不变）；`project()` 把 `envelope.title` 过滤空串后填入 `signal.topic`，并做**噪声过滤**
      （R7.2：形如 `New session - <ISO 时间戳>` 视为无标题 —— 判定函数放 agent 域，核心域零感知）。
- [ ] opencode 模板（`templates/neeko-opencode-status.js`）：监听 `session.updated`
      （`properties.info.title`，SDK 实测字段）→ 缓存 `sessionTitles`（与既有 `sessionDirs` 同
      `MAX_TRACKED_SESSIONS` 上限）；`turn_completed` / `approval_requested` 上报时带 `title`。
      注意 `session.created` 与 `session.updated` 都要记（新会话标题可能在 created 时即存在，
      AI 命名则在 updated 到达）。
- [ ] pi 模板（`templates/neeko-pi-status.ts`）：`title = ctx.sessionManager.getSessionName()`
      （实测：仅用户显式命名才有值）；无值 → 回退该会话**首条用户消息**（`getEntries()` 取首个
      `type === "message"` 且 `message.role === "user"` 的文本，截断后上报），两者都无 → `null`。
      解析失败一律吞掉（fail-open，R7.6）。
- [ ] 模板锚点测试：`writers.rs` 的模板契约测试补 `title` 字段名存在性断言（防单边改名）。

### Step C4 前端：in-app 列表同源展示

- [ ] `shared/types/notification.ts`：`NotificationDraft` 增 `subtitle: string`（镜像测试钉死）。
- [ ] `features/notification/hooks/useNotificationDelivered.ts`：把 `subtitle` 写入 store；
      `shared/store/notificationTypes.ts` 的 `Notification` 增可选 `subtitle`；列表/详情组件展示。

### Step C5 验证与推送到已装机器

- [ ] 自动化：`cargo test`（核心域 + 两个投影 + 模板锚点）、`pnpm test:fe`、`pnpm check` 全绿。
- [ ] 真机：`pnpm tauri dev` + 真实 pi / opencode 会话，`usernoted` 日志与肉眼各确认一次副标题。
- [ ] **模板推送（关键，勿漏）**：`version_token()` 是 `v{CARGO_PKG_VERSION}`，**同版本号内改模板
      不会自动重写**已装文件（见下方「已知限制」条目）。因此 C3 落地后必须：
      ① `src-tauri/Cargo.toml` 版本位 +1（会让所有 `neeko-status.*` 被判 `version_current=false`，
      `reconcile_action` 下次启动自动重装，**这是既有机制，无需新代码**）；
      或 ② 让用户在设置页把 CLI hooks 开关关开一次。
      **推荐 ①**：版本位变化是模板类的唯一可靠推送通道，且已有测试覆盖该路径。

## Phase E —— neeko-check 审查整改（2026-10-13）

> 用户要求按第一性原理 + 高内聚/低耦合/可扩展性做全面审查。四路并行审查（核心域 / hook 摄入 /
> 平台与组合根 / 前端）后逐条复核，Block 1 条 + Warning 6 条 + Nit 若干，本节记录整改结果。

### 已修（每条附验证）

- [x] **B1 同类事实两份定义（前端）**：`features/notification/notificationTypes.ts` 与
      `shared/store/notificationTypes.ts` 逐字重复 `Notification`/`NotificationStore`。
      实测危害**不对称**：消费侧有而 store 侧无 → `tsc exit=0`（静默漂移）；
      消费侧缺字段 → `TS2339`。已删 features 副本，三个组件改直导
      `@/shared/store/notificationTypes`（仓内 265 处同款先例）；留档说明写进存活文件的头注释。
      验证：`pnpm type-check` 干净 + `pnpm test:fe` 537 文件 / 4691 用例全绿。
- [x] **W1 护栏 `docs` 指针指向任务目录**（`.trellis/tasks/10-12-agent-notify/design.md`）：
      任务归档后 `registry.py` 指针校验抛 `RegistryError` → **25 条护栏集体 exit 2**。
      已实测复现（`mv` 走任务目录后 `pnpm guards list` 直接拒绝运行）。改指稳定文档
      `.trellis/spec/backend/quality-guidelines.md`。
- [x] **W2 护栏判据漏分组形态**：`use crate::{common::Bar, agent::Foo};` 不被
      `crate::(?:agent|…)` 命中，且 **rustfmt 保留 2+ 项分组**（实测，非理论缺口）。
      判据改为「`crate::` 起始 → 语句窗口（至 `;`）→ 窗口内业务模块作路径段」，覆盖
      分组单行/多行/空白变体；`USE_CRATE::{AppError, AppStateWrapper}` 等基础设施分组仍放行。
      新增 2 条 selftest（4 个绕过变体全拦 + 分组基础设施不误杀），共 8 条全绿。
- [x] **W3 `private_file` TOCTOU + 失败残留**：原实现 `fs::write`（默认 `0o666 & ~umask`）
      后 `set_permissions(0o600)`，窗口内同机可读 hook token；且写/改名失败时 tmp 残留明文。
      改为 `OpenOptions::mode(0o600)` 一次成型 + 失败路径 `remove_file(&tmp)`。
      新增 4 条单测（含**判别力自证**：先断言本机默认创建模式 ≠ 0600，否则用例失效）；
      实测确认默认 0o644 vs 修复后 0o600。
- [x] **W4 `Sound` 死声明**：授权与呈现掩码都声明 Sound，但 `post()` 无 `setSound`（全文件 0 处）
      —— 本项目调研纪要原文「macOS 未设 sound 即静音」。已 `setSound(defaultSound())` 落实声明，
      并补 2 条守卫（掩码含 Sound、内容对象确实带 sound）。**注意**：可听性无法机器取证
      （usernoted 不落 sound 名），只有「内容对象带 sound」这一编程面证据。
- [x] **W5 `notification/center.rs` 零测试**：补 3 条不依赖 Tauri 运行时的测试
      （`FocusTracker` 往返、`update_settings`→`settings_snapshot` 可见、快照隔离性）。
      `observe` 需真实 `AppHandle`，由 dispatch 单测 + 真机覆盖，未强行 mock。
- [x] **W6 `Attribution.project_id` 孤儿字段**：设计 D9「按归属项目尽力回流」未落地，
      字段是缺口的一半实现且**零消费者**（源 B 的 `cli:` instance 让现有路由永不命中）。
      决策：**登记而非删除**（删了等于抹掉需求路标），已在下方「遗留项」写明两条落地路径。
- [x] **N8 绕过 Scheme C 执行器契约**：`server.rs` 的 `tauri::async_runtime::spawn_blocking`
      改为注入 `Arc<AppRuntime>`（`boot` 签名 + 组合根传 `state.runtime`）；accept 循环内的
      `std::thread::spawn` 补命名（并发指南）+ 创建失败**不 panic 终结 accept 循环**。
      验证：真机 ingest 仍 204 → UN accepted（00:31:16 实测）。
- [x] **N：XDG 相对值未按规范忽略**：`XDG_CONFIG_HOME=.` 会被接受 → install 写 CWD 相对路径、
      status 在别处查找（「装了但报未安装」且随 CWD 漂移）。改判 `is_absolute()`，补 1 条测试。
- [x] **N：门面过宽**：`notification/mod.rs` re-export 11 个名字，**7 个全仓零外部消费者**。
      收敛为真实消费集（`NotificationCenter` + `NotificationClass`/`NotificationSignal`/`SourceRef`）。
- [x] **N：注释与实现不符三处**：`types.rs` 引用了不存在的 `settings.rs` 与业务域函数名
      `writers::install_all`（与「核心域零业务」自述相抵）；`targets.rs` 模板事件清单漏
      `session.updated`/`question.asked`；`private_file/default.rs` 的 Windows rename 依据错误
      （std 实为 `MOVEFILE_REPLACE_EXISTING`，真实约束是共享冲突）。
- [x] **N：测试复制产品文案**：`policy.rs` 直接断言 `"[opencode] 发生错误，请查看详情"` ——
      改为由 `NotificationClass::default_body()` 推导（改文案不再假红）。
- [x] **N：平台主题索引漏行**：`platform/mod.rs` 的索引表补 `system_notify` 行。

### 未修（明确不做，理由）

- `macos-dev-bundle.sh` / `.cargo/config.toml` 的 macOS 专属形态本身合规（红线 10 边界豁免 + 非
  目标平台不命中），无需改动。
- `dispatch.rs` 用 `tauri::async_runtime::spawn`（而非 `AppRuntime`）：与 `agent/chat/commands.rs`
  同形态，非本次审查新增；成因已在 N8 中一并说明，**保持既有惯例**避免半途改两套。

## Phase E2 —— 第二遍复核（2026-10-14，用户要求「再检查一遍」）

> 第二遍只查**我自己上一轮写的东西**与上一轮结论的可证伪性。结果：抓到 1 个真 bug
> （双重静默失败），并推翻上一轮 1 条错误结论。

- [x] **[真 bug，上一轮我引入] 源 A 的 question 回执路由是错的**
      （`adapter/serve.rs` Phase D 新增分支）。我写的
      `POST {base}/api/session/{sid}/question/{rid}/reply` 实测 **404 `QuestionNotFoundError`**
      —— 带不带 `directory` 都 404。正确公开面是
      `POST {base}/question/{requestID}/reply?directory=…` → `200 application/json` + `true`。
      二进制里 `url:"/api/session/{sessionID}/question/{requestID}/reply"` 那一族是**内部 SDK 面**，
      我照抄了它 —— 错在「看到路由表就当公开面」，未实测。
      **故障形态**：用户在 Agent Chat 内联面板回答提问 → 服务端查不到该 question →
      agent 永久挂起。
- [x] **[同一 bug 的第二层静默] `if let Err(e)` 抓不到任何失败**
      实测两条事实：① reqwest 默认对 4xx/5xx 返回 `Ok`，404 不产生 `Err`；
      ② serve 对**未匹配路由**回落 SPA `index.html`（**HTTP 200 + `text/html`**）。
      即路由写错时状态码 200、`Result` 是 Ok —— 零日志零报错。
      修法：抽 `post_serve()` 统一「状态码 + html_fallback」双判据，并把 approve / turn /
      input 三条既有回执一并改走它（原本同样只判 `Err`，属同一失效面）。
      实测对照（真挂起的 question）：错误路由 `404 json QuestionNotFoundError`；
      正确路由 `200 json true` 且 question 被消费、agent 拿到
      `User has answered your questions: "…"="src/main.ts"` 继续执行。
- [x] `directory` 是 question 回执的**必填** query 参数（缺失即 404），故 `run_request_loop`
      需要它；参数数撞 clippy `too_many_arguments`（8/7）→ 抽 `ServeScope { base_url, directory }`
      （二者本就是同一个「serve 路由作用域」概念，合成一个参数比拆两个更诚实）。
- [x] 新增 2 条单测钉死路由形状（`question_reply_url_uses_public_route_with_directory`、
      `question_reply_url_shape_guards`：禁 `/api/` 前缀、必带 `directory=`）。
      另实测确认既有 `/session/{sid}/permissions/{pid}` 路由**是好的**（`200 true` 且真消费），
      `/session/{id}/abort` 亦为真实路由 —— 只修我写错的那条，不动没坏的。

### 推翻上一轮的一条错误结论（自我纠错）

- 上一轮我声称：「顺带发现既有漂移：HEAD 上两份 `Notification` 都缺 `deepLink`，
  字段在 store 边界被静默丢弃，链接全程断链」。**该结论错误**。
  实证：`git cat-file -e HEAD:src/features/notification/hooks/useNotificationDelivered.ts`
  → 不存在（本分支新增）；`git grep -l deepLink HEAD -- src/` → 零命中。
  即 HEAD 上根本没有任何代码写 `deepLink`，谈不上「被丢弃」。
  **仍然成立的部分**：两份 `notificationTypes.ts` 在 HEAD 上逐字相同（`diff` 空），
  重复确实早于本分支（`cd1e7904` + `f9f30625` 各留一份）；漂移的**不对称危害**是实测的
  （消费侧有、store 侧无 → `tsc exit 0`）。合并动作有效，只是我给它编了一个不存在的事故。

### 本轮验证与未覆盖面

- `cargo test --lib` 1647 passed / `cargo clippy --all-targets -D warnings` 干净 / `cargo fmt` 干净。
- **未跑通的部分（诚实登记）**：路由正确性是用「按 `question_reply_url()` 的格式拼出同一
  URL、对真挂起的 question 打 curl」证明的（服务端确实消费并让 agent 续跑）；
  **没有**跑「真实 Neeko App → 内联面板 → `agent_input` → 该回执」的全链路。
  Rust 侧翻译与 URL 形状各有单测，但中间那根线（前端面板 → command → 请求循环）
  仍是单元级保证，未端到端验证。
- **过程事故登记**：本节初次写入时误把 markdown 插进 `adapter/serve.rs`（edit 头指错文件），
  造成 252 个编译错误；已 `CUT` 摘除并 `cargo check` 归零验证。教训：edit 的 `[path#tag]`
  头必须与目标文件一致，跨文件插入前先核对。

## Phase D —— 「等待用户行动」事件面补全（2026-10-13 实测修复）

> 用户报告：「agent 的权限提示不会弹出通知」。实测根因 = **hook 模板订阅的事件面不全**，
> 与投递链无关（投递链在 Phase A 已验证可用）。三处独立缺口：

- [x] **opencode `question.asked` 未订阅（主因）**。opencode 1.19 的「等待用户行动」是
      **两个独立事件族**：`permission.asked`（权限门，`per_` id）与 `question.asked`
      （ask 类工具阻塞，`que_` id）。模板只订阅了前者。
      证据：用户 2026-10-13 13:50Z 的 live 会话日志 `message=asking id=que_1358761cd001…`；
      二进制提取的事件表 `question.asked` / `question.replied` / `question.rejected`。
      修法：新增分支投影为同一 `approval_requested` 语义键（核心域零改动 —— 命名空间复用）。
      **不订阅 `question.rejected`**：那是「用户已关闭提问」的结果态（二进制文案
      "The user dismissed this question"），此时无人等待，订阅它 = 误报。
- [x] **pi `ui_prompt_start` 详情恒为 null**。载荷是 `{reason, kind, title?}`
      （`runner.js::withUIPrompt` 实证），模板却读 `event.text || event.message` —— 字段名
      按 orca 猜测而来，从来取不到值。修法：读 `title`，回落 `等待{kind}输入`。
- [x] **源 A（Neeko 自有会话 / `opencode serve`）同一个缺口**。`adapter/serve.rs::translate_event`
      只路由 `permission.asked`；实测 serve 会话里模型调 question 工具后 `/question` 挂起待答
      （`{"id":"que_…","questions":[{"header",…}]}` 挂起不消失），前端既无内联面板也无通知。
      修法：新增 `translate_question_asked` → `StreamEvent::UserInput`（**不是**
      `RequestApproval`：提问要的是答案文本，不是 allow/deny），提问 id 承载在 `turn_id`；
      `SessionRequest::Input` 按 `que_` 前缀分派到
      `POST /api/session/{sid}/question/{rid}/reply`（`{"answers":[[text]]}`），
      非 `que_` 前缀仍走原 `prompt_async`。三条单测覆盖（正常 / 回落链 / 缺 id 丢弃）。
- [x] 模板锚点测试补钉：opencode 的 `permission.asked` + `question.asked`
      两条订阅锚点、pi 的 `ui_prompt_start` + `event.title` + `event.kind`。
- [x] 推送：`Cargo.toml` 版本位 `1.0.7` → `1.0.8`（模板推送唯一可靠通道，同 Phase C 结论）。
      实测 `~/.config/opencode/plugins/neeko-status.js` 与 `~/.pi/agent/extensions/neeko-status.ts`
      首行均变为 `v1.0.8`。

**验证证据（真机，全部在本机复现）**：

- opencode 真跑 `external_directory` 权限请求（`opencode run` 读 `/etc/hosts`）→ 模板
  `post()` 带 `detail:"权限请求：external_directory"` → Neeko `UN accepted` → usernoted
  `Presenting … as banner`，三段齐全（**用已安装的 `v1.0.9` 文件复跑过一遍**）。
- `question.asked` 分支用真实 payload（从二进制提取 `{id,sessionID,questions,tool}`）喂进
  模板模块，落 `detail:"选择目标文件"`（questions[0].header 优先）。
- pi 分支同法验证：`title` → detail；仅 `kind` 时 → `等待select输入`；
  `kind:"confirm"` → `approval_requested`（审批语义），其余 kind → `input_requested`。
- 源 A：在真 `opencode serve` 上复现了 question 挂起（`/question` 返回 `que_…` 待答项），
  并确认回执路由是 `POST /api/session/{sid}/question/{rid}/reply`（`/session/...` 无 `/api`
  前缀回落 HTML —— 实测踩过）。
- 说明：`question.asked` 在 `opencode run`(headless) 下无法自然触发 —— 实测 build/plan
  两个 agent 都没有该工具（模型自述"我没有提问工具"）；它是**交互/TUI 侧**路径（用户 live
  会话即此路径命中），serve 侧则可由 API 触发。故该分支以「真实 payload 直测 + 真实 serve
  挂起复现」代替 `run` 端到端跑。

## Step 防腐（Phase B 后评估）

- [x] 护栏：`notification/` 核心域禁止 `use crate::{agent,git,terminal,...}`
      （`check_notification_core_direction` + selftest 已登记，含 `app` 组合根边界用例）
- [ ] 护栏：ingest server 禁止绑非 loopback 地址（grep 钉子）

## 回滚策略

每步独立可回滚；通知域是纯旁路（T2），Phase A 整体 revert 不影响业务主链路；
Phase B 额外回滚面 = writers 清理用户级 hook 文件（uninstall 命令即回滚工具）。

## 人工验收清单（Phase A 合入前执行）

自动化门禁已覆盖逻辑层（单测 1579+4675、护栏 24/24、macOS dev 启动无 panic）。
以下需要人眼/实机：

- [ ] macOS：设置 → Notifications → 「Send test notification」→ 系统横幅出现；
      首次点击触发授权弹窗流程
- [ ] macOS：真实 pi/opencode 会话触发审批/完成 → 窗口最小化时收到通知；点击通知应用回前台；
      in-app 通知列表条目点击 → 精确聚焦对应会话 tab
- [ ] Windows：Toast 弹出（打包与非打包 AUMID 行为）、点击回前台
- [ ] Linux：GNOME/KDE 各验一次通知弹出与回前台
- [ ] 失焦抑制：窗口聚焦且正看该会话时不弹系统通知（AC3）
