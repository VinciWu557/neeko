# dsh-neeko — Package Guidelines

> `packages/dsh-neeko` 的落地文件。上位约束见仓库根 `AGENTS.md`（红线索引 + 架构基本原则 +
> 门禁拓扑）；本文只写**这个包特有**、且改代码前必须知道的东西。
>
> **硬指令**：改 `src/**` 或 `tests/**` 前读本文。根 `AGENTS.md` 只给索引，
> 它的摘要列够你识别违规，判据与理由是本文。

## 这是什么

DSH ↔ Neeko 的**双向协议桥**，两个互斥的运行时表面：

- **WebSocket 面** (`ws-server.ts`) —— 装在 `127.0.0.1:3081`（非 3080，冲突时 `+1..+9` 动态回退），
  Neeko 桌面端连这里。
- **TUI 面** (`--tui`) —— 把同一个 agent 渲染到本地终端（`src/tui/**`）。

两侧共享 `dsh-adapter.ts`（事件 → 协议）与 `protocol.ts`（类型单一源）。

**红线适用范围**：本包是 Node 库，不是 Tauri 后端 —— 根 `AGENTS.md` 的 15 条红线**全部 N/A**。
仍须遵守架构基本原则、TDD，以及本文下面的包内规则。

## 门禁：`prepublishOnly` 是唯一入口

```bash
pnpm run prepublishOnly    # check(tsc×2) → test(vitest) → build(tsdown) → lint:package(publint)
```

**本包不纳入根 `pnpm check` / `lint` / CI 矩阵**（根 `AGENTS.md` 的「门禁豁免」）。
所以：

- 改完必须自己跑 `prepublishOnly`；根门禁绿**不代表**这个包绿。
- 开发循环里用 `pnpm test`（单跑 vitest，秒级）或 `pnpm run check`（仅类型）；收尾跑一次全量。
- `test` 与 `check` 是分开的脚本，`prepublishOnly` 才把两者串起来。

## 铁律一：`build` 之后必须 `sync-profiles`

```bash
pnpm run build && node scripts/sync-profiles.mjs
```

profile 把本包装成 **`file:` 依赖**，pnpm 链接的是**包目录**，而入口读 `lib/` —— 一个构建产物。
所以 `build` 完不同步，profile 会继续跑**旧 bundle**，且**没有任何警告**：TUI 的行为看起来
完全没变化，读起来就是「我改的东西没生效」。

这个坑在本仓库造成过至少四轮误判（`/thinking` 不出现、全屏面板不可见、`/resume` 无标题、
面板挂错屏）。**两步是一步**，不要再分开记。

## 铁律二：渲染层的「屏幕归属」

pi-tui 有**两种屏幕**，同时只有一个活着：

- `TuiMainScreen` —— 终端 owns scrollback，不报鼠标点击。**这是默认**（`ScreenMode = 'main'`）。
- `TuiAltScreen` —— owns viewport / 选中 / 复制 / 应用内滚动 / 命中测试。由 `--fullscreen` 选择。

组件必须挂在**当前活着的那个**下面。主屏 `stop()` 之后，往它的树上 `addChild` 是**静默无效**：

- 不报错
- 不显示
- 组件自己还在等按键 → 表现为「界面没了，应用卡死」

**同类事故已发生三次**，全部同一个根因：假设组件直接挂在 `tui` 上。

| 事故 | 症状 |
| --- | --- |
| `/thinking`、`/theme` 面板 | 全屏下不显示，键还能用 |
| `/model` 面板 | 全屏下列表消失 + 应用卡死 |
| `printFinalDocument()` 打印 `editor` | 面板开着退出时，最终文档缺面板 |

**正确形态**：面板不直接挂 `tui`，而是挂进一个**由 app 拥有、由当前屏幕挂载**的稳定容器，
只换容器的 `child`：

```ts
// 对
this.inputSlot.clear()
this.inputSlot.addChild(component)

// 错 —— 猜父节点，必然在主屏/全屏之一上猜错
this.tui.removeChild(this.editor)
this.tui.addChild(component)
```

现有三个这样的槽位：`document`（banner + messages + notices，整屏滚动）、`aboveInput`（dock
里的瞬态面板 + 活动行）、`inputSlot`（editor 或顶替它的面板）。

**新增面板时**：不要新增槽位，挂进 `aboveInput`；若它要顶替输入框，用 `inputSlot`。

**dock 必须是布局树里的单个条目**：`VStack([scroll(grow:1), dock(basis:'auto')])`。
把 dock 的各项摊平进根 stack 会让每个 `minSize` 与滚动区竞争 —— 短终端下滚动区只剩一行
（实测 10 行屏幕：摊平 → 1 行，单条目 → 6 行）。

## 铁律三：滚动区只放「属于对话」的东西

布局对齐 pi 的 `createChatViewport`：

```
document      ← ScrollView(follow: 'end')，整屏滚动
 ├─ banner
 ├─ messages   (transcript，mountTranscript 每次 flush 重建)
 └─ notices    (斜杠命令回复，scrolls with the conversation)
aboveInput    ← dock，不滚动：活动行 + 各选择器面板
inputSlot     ← editor 或顶替它的面板
status        ← 状态栏
```

**dock 只放「滚动时仍需可见」的瞬态内容。** 命令回复属于对话，不是 UI 提示 ——
把它放 dock 就是让 `/compact` 的回复钉在输入框上方、永不随对话滚动（真实报障）。

pi 自己的 `/compact` 也不往固定区写文本：它调 `session.compact()`，结果作为 chat entry 回来。

**`notices` 必须是独立容器**，不能并进 `messages`：`mountTranscript` 每次 flush 用自己的
容器重建，写进去的东西下一次 repaint 就没了。

## 铁律四：不要按工具名分支

pi 的工具渲染**没有任何 per-tool 样式**。`formatToolCallWithArgs` 对所有工具一视同仁：

- 折叠：`bold(name)` + `key=value` 对，裁到 `COLLAPSED_ARGS_CHARS = 100`
- 展开：每个参数一行 `key: value`，续行缩进
- 结果：折叠预览 10 行（`FOLDED_PREVIEW_LINES`，对应 pi 的 `FALLBACK_PREVIEW_LINES`）
  + `... (N more lines, ctrl+o to expand)`
- 卡片 `Box(1, 1, bg)`（上下各留一行）

状态用**背景色**表达（`toolPendingBg` / `toolSuccessBg` / `toolErrorBg`），不用文字标签。

**禁止**重新引入按工具分类的表（曾经的 `TOOL_VARIANTS` / `classifyTool` / `VARIANT_EMOJIS` /
`deriveSummary` / status pill 全部来自 `@xmoon76/dsh-pi-tui` 适配层，**不是** pi 的）。
那套东西让一行同时带四个标签描述同一个调用：

```
🖥️ Bash Print TOOLCHECK [ok] — TOOLCHECK (+2 lines, ctrl+o)     ← 删掉
 bash command="echo TOOLCHECK" description="Print TOOLCHECK"      ← 保留
```

删掉分类表**本身就是开闭原则的收益**：新工具零改动即可正确渲染，因为没有地方需要注册。

## 铁律五：主题能力只有一个入口

`fg` / `bg` 是颜色，`bold` 是**终端属性**（不是颜色 token）。两者都是「主题提供的能力」，
所以走**同一个** `ThemeCapabilities` 参数，不要各开一条通道：

```ts
// 对
renderRow(row, { fg, bold }, md, options)

// 错 —— 四层穿透一个函数
renderRow(row, { fg }, md, { ...options, bold })
```

`Theme.bold()` 是唯一实现，`markdownThemeOf()` 复用它。

## 铁律六：`NoticeLog` 的两条不变量

`src/tui/notice-log.ts` 守的是**同一条契约的两头**：

1. **上限** —— `/help` 一次八行，不限量则内存与每帧成本一起涨（`DEFAULT_MAX`）
2. **寿命** —— 状态行必须**复用**（否则每次 `ctrl+o` 都留一行在提示符上方）**且过期**
   （否则复用的槽位变成历史）

**状态行被上限挤掉后要重新挂载** —— 这是最容易漏的一条：更新一个已卸载的组件是
`setText()` 给没人看的地方。

## 铁律七：repaint 走 `requestRender`，不走 `scheduleRender`

`mountTranscript` 的 flush 末尾必须调 `activeTui.requestRender()`。
调 `requestRender()`（自己的）会**重新武装** `scheduleRender` → flush 每 50 ms 排自己一次，
即使什么都没变。这就是「界面发钝」的原因。

签名缓存（`row-cache.ts` 的 `rowSignature`）是给 flush 用的**廉价指纹**：

- 太粗 → 流式回复冻住（漏了 `text.length`）
- 太细 → 缓存永不命中（每 tick 全量重建）

## 铁律八：异步答案会晚于问题

`/resume` 的标题读取、host 的会话列表都是**晚到**的。面板在数据到齐之前就可用，所以：

- 每一代 open/close 都递增 `generation`
- **过期代的答案必须丢弃**，不能应用 —— 否则会重绘用户正在读的面板，或复活用户已关掉的面板
- 分页跟着**光标窗口**走，不跟语料总量：真实 424 会话的 profile 上，全量读取 40 秒都没完成

## 铁律九：屏幕模式只有一个决策点

三态：显式 `main` / 显式 `fullscreen` / **未表态**。第三态携带默认值，所以它必须有一个名字，
不能写成 `boolean | undefined` —— 本项目正是因此翻车：`startup` 把 `undefined` 读成「未表态」，
`TuiApp.startOnMainScreen` 读成「fullscreen」（`!== true`），两种极性并存 → 默认值不可达、
flag 与 env 优先级反转。

```
startup          --main-screen / --fullscreen → screen（无 flag 就不写这个键）
cordis.patch.yml 原样透传，禁止 `=== true`（那会把「未表态」和 false 压成同值）
runner            screenModeOf()：唯一决策点（config > DSH_NEEKO_SCREEN > 旧变量 > 默认）
TuiApp           执行决策，不自带默认
```

**新增同类开关时**：沿用这个形状。缺省值只在一个地方定义，其余各层只负责传递和表达。

## 测试层规则

**统一用 `tests/support/ansi.ts` 的 `stripAnsi()`**，不要自己写剥离正则。
曾经七个测试文件各写一份，规则漂移（`[0-9;]*m` / `[a-z0-9;]*m` / `[0-9;?]*[a-zA-Z]`，
`_pi:` 规则只有部分有），导致同一条断言在 A 文件能过、B 文件会失败。

**夹具不要造假 ANSI。** `tui-status-bar.spec.ts` 的 paint 桩曾把 **token 名**塞进 SGR 参数位
（`\x1b[route-magpie-autom`）—— SGR 参数只能是数字、`;`、`?`，那不是任何终端认识的序列，
宽度断言因此建立在假数据上。标签要走 **OSC**（`\x1b]8;;token\x07`）：真序列、真零宽、真被
`visibleWidth` 忽略，且测试仍能读到 token。

**时效性断言不要用固定 `sleep`。** 用轮询等目标条件，命中即返回（现成实现：
`tests/tui-resume-glue.spec.ts` 的 `settle(predicate, limit)`）。固定 sleep 在空闲机上够、在负载下不够 ——
表现为「看起来无关」的 flake。

**测试私有字段要诚实**：通过 `app.noticeLog.container` 这类访问器读，而不是断言「曾经叫
`notices` 的字段还在」。重构改了所有权，测试跟着改，才说明它测的是行为。

## 布局

```
src/
  index.ts            入口
  protocol.ts         协议类型单一源（双端共享）
  dsh-adapter.ts      DSH 事件 → 协议
  neeko-adapter.ts    协议 → DSH API
  agent-handlers.ts   agent 侧 handler
  ws-server.ts        WebSocket + health
  startup.ts          CLI / 守护进程 / TUI 模式
  tui/
    runner.ts         会话生命周期，拥有 transcript 状态
    app.ts            组合根（布局、键仲裁、生命周期）
    *-controller.ts   有独立状态的子系统（theme / status / command / resume）
    notice-log.ts     提示区 + 自清除状态行
    row-cache.ts      渲染管线的纯函数（签名 + 协调）
    transcript*.ts    行模型与行渲染
    picker.ts         所有选择器的共享骨架
    fullscreen.ts     alt screen 挂载
tests/
  support/            共享夹具（ansi / fake-terminal）
  *-glue.spec.ts      经 TuiApp 的端到端行为
  *.spec.ts           模块单测
```

`app.ts` 仍是最大文件（~1500 行）。剩余的大块（flush 管线、键分派、`/thinking` 编排）
**刻意没抽**：它们要 6+ 个协作者，抽出去内聚反而降低。**不要为了行数搬家**。

## 常用命令

```bash
pnpm test                              # vitest 单跑（秒级，开发循环用这个）
pnpm run check                         # 仅类型：tsc --noEmit + tsc -p tsconfig.test.json
pnpm run build                         # tsdown
pnpm run lint:package                  # publint --strict
pnpm run prepublishOnly                # 全量门禁（收尾跑一次）
pnpm run build && node scripts/sync-profiles.mjs   # 改完必须两步一起
```

## 变更检查清单

- [ ] `pnpm run prepublishOnly` 全绿（**不是**根 `pnpm check`）
- [ ] 改了渲染 → `build` + `sync-profiles`，真机 pty 看一眼
- [ ] 新增面板 → 挂进现有槽位（`aboveInput` / `inputSlot`），**没有**新增裸 `addChild(tui)`
- [ ] 新增/改动纯逻辑 → 有直接断言；改行为 → 先红后绿
- [ ] 变异验证：变异后 `grep` 确认**真的改到了代码**再相信红/绿计数
      （本项目两次「0 红」都是变异没匹配上）
- [ ] 测试里的 ANSI 剥离走 `stripAnsi()`
- [ ] **不主动 `git commit`** —— 由用户决定何时提交

## 已知陷阱

- `file:` 依赖 + `lib/` 产物 → 不 `sync-profiles` 就是在跑旧代码（见铁律一）
- 屏幕模式是**三态**（`'main' | 'fullscreen' | 未表态`），默认是 main —— 不要让某层自己定义缺省值（见铁律九）
- Vite 预打包缓存与本包无关，但改了 `patches/*.patch` 后根仓库需要 `rm -rf node_modules/.vite`
  （见 `.trellis/spec/frontend/quality-guidelines.md`）
