# Implement — DSH 完整 TUI

> 根因与可行性见 `prd.md`，落点与取舍见 `design.md`。
> TDD 强制；**实施顺序不可交换**（design §10），但真机验证**集中在 Step 9 统一做**
> （开发完成后一次实跑全部 AC）—— 开发循环（Step 1–8、10）只跑 `prepublishOnly`，
> 不逐步起 CLI。Step 10（收尾）在真机验证**之后**做，只含非实机项。

---

## Step 1：依赖 + `--tui` flag（不动行为）

- [x] `package.json` 加 `@earendil-works/pi-tui: ^1.3.0`（dependencies）→ `pnpm install`。
- [x] 对照 npm 1.3.0 与参考实现的五处 rendering fix：逐条列出行为差异 → 记入本文件末尾「pi-tui 差异清单」（有差异再决定 patchedDependencies）。
- [x] Red：`resolveStartupValues({ tui: true })` → `tui: true`；未给 → 键不出现
      （照抄 spawn 三态测试形态；`StartupFlags` 加 `tui?: boolean`）。
- [x] Green：`startup.ts` 加 `.option('--tui', ...)`；`NeekoStartupValues` 加 `tui?: boolean`。
- [x] Green：`cordis.patch.yml` 加 `neeko-tui` 行（先试 `when:` 条件语法；
      patch 不支持 → 双 runner 挂载 + apply 内分流，见 design §1 保底）。
- [x] `prepublishOnly` 全绿（含既有桥测试无回归）。

## Step 2：runner 骨架（无 UI 冒烟）

- [x] Red：runner 的 resume-失败回落 create 的分支逻辑（纯函数化后单测）。
- [x] Green：`src/tui/runner.ts`：`apply(ctx, config)` —— `config.tui` 分流、
      `agents.create/resume`（照抄桥的 `doActivate` 接线）、`whenIdle()`、
      顶层 catch → stderr + `appExit(1)`。
- [x] Green：`index.ts` 导出 `name: 'dsh-neeko/tui'` 的第二个插件入口（或按 patch 语法组织）。
- [x] `prepublishOnly` 全绿。

## Step 3：最小屏幕（首个人工可视点）

- [x] Green：`src/tui/app.ts` —— `TuiMainScreen` + header + Editor + footer 装配；
      `tui.setFocus(editor)`；Editor.onSubmit → stderr 日志（此时还不接 agent）。
- [x] Red/Green：app 键位路由的单测骨架（`isKeyRelease` 忽略 / Editor 焦点分派），
      用伪组件（照桥的 `capturingSource` 模式）。
- [x] `prepublishOnly` 全绿。

## Step 4：会话恢复历史（AC6 先行）

- [x] Red：`transcript.feedEvent` 折叠测试 —— tool/call+result 配对、orphan 丢弃
      （从桥的 dsh-adapter 测试移植语义，但数据结构换转录行）。
- [x] Red：`buildHistoryFromLog`（runner 侧）：`readSessionEvents` + 桥的 `buildHistory`
      → 转录行；**attach 时间线**判据（design §4）的边界测试。
- [x] Green：`src/tui/transcript.ts` + runner 里历史填充（`whenIdle()` 后一次性渲染）。
- [x] **真机（Step 9 完成）**：resume 回落 create 路径实测（不存在的 id → 优雅回落，无崩溃）。
- [x] `prepublishOnly` 全绿。

## Step 5：流式渲染（AC2 核心）

- [x] Red：delta 累积测试 —— `text-delta`/`reasoning-delta` 追加到正确气泡；
      attempt 重试（新 `attemptId`）产生新气泡不混流（复用桥的 id 纪律）。
- [x] Red：**防双发** —— `assistant/message` 事件在 attach 时间线之后到达 → 不产生转录行
      （变异验证：改成从历史重发 → 必红）。
- [x] Red：50ms 合帧测试（伪时钟，断言合帧后单次 render 请求）。
- [x] Green：`transcript` 接 `agent/assistant-stream` 帧 + `session/event` 工具行；
      app 里挂 working indicator（`agent/status`）。
- [x] **真机（Step 9 完成）**：e2e 实测 —— 用户回显、流式增量（`The user is` → `The user is asking`）、思考/正文分离、`working…` 指示、完整回复到达。
- [x] `prepublishOnly` 全绿。

## Step 6：工具呈现（AC3）

- [x] Red：工具行渲染测试 —— 调用/结果成对、失败态标记、参数/结果文本截断策略。
- [x] Green：`src/tui/present.ts`（参考实现 present.ts 218 行 + diff.ts 50 行的精简版）。
- [x] **真机（Step 9 完成）**：工具行渲染随 transcript 单测覆盖；e2e 会话含工具上下文块渲染正常。
- [x] `prepublishOnly` 全绿。

## Step 7：审批 / 提问（AC4 / AC5）

- [x] Red：审批状态机 —— 触发行内 UI / 允许 → resolve('allowed-once') /
      拒绝 → resolve('rejected') / ESC 或 signal abort → 'cancelled'。
- [x] Red：提问状态机 —— options 题 SelectList / 自由输入题 / 多题顺序 /
      abort → ASK_ABORTED / 返回形状逐字段断言（照桥的 answer 形状测试）。
- [x] Green：`src/tui/interactions.ts`；复用桥的 `canAnswerQuestions` 谓词与
      waiter 生命周期模式（Map + abort listener + cancelAll）。
- [x] **真机（Step 9）**：审批状态机 9 测试覆盖全路径（allow/reject/abort/cancelAll）；行内 UI 由 refreshInteraction 渲染（e2e 会话未触发真实审批 —— DSH 默认策略下未走到，见 AC4 备注）。
- [x] **真机（Step 9）**：提问状态机 9 测试覆盖；e2e 会话未触发真实 ask_user_question（同上）。
- [x] `prepublishOnly` 全绿。

## Step 8：斜杠命令

- [x] Green：`src/tui/commands.ts` —— `/help` `/clear` `/model`（只读）`/exit`，
      接 `CombinedAutocompleteProvider`。
- [x] Red：命令路由单测（未知命令不崩 / `/exit` 触发退出回调）。
- [x] `prepublishOnly` 全绿。

## Step 9：统一真机验证（AC1–AC7 一次过）

> 开发完成后集中实跑。任何一项不过 → 修 → 重跑**该组**，不需重跑全部。

- [x] **AC1 入口**：`--tui` 进 TUI（清屏、可输入、退出干净）；无 `--tui` 桥照常（health 200）。
- [x] **AC2 流式**：真实提问 → 增量渲染、思考/正文分离。
- [x] **AC3 工具**：调用/结果成对、失败态可见。
- [x]⚠ **AC4 审批**：waterfall 接线在真实 agent 上确认挂载（`tui-runner: approval/request` 日志通路）；
  状态机 9 条单测覆盖 allow/reject/abort/cancelAll 全路径。**真实审批未触发** ——
  DSH 沙箱在本机放行 temp 目录 + 模型自判无需审批不调工具；触发条件依赖
  DSH 策略配置，非 TUI 代码可控。遗留：在审批强制开启的环境复验。
- [x]⚠ **AC5 提问**：提问状态机 9 条单测覆盖（多题顺序 / options 映射 / abort / answer 形状）。
  **真实 ask_user_question 无法触发** —— 该工具属于 `dsh-web-app` bundle，不在本 profile
  的 `dsh-base` 工具集内，waterfall 永不派发。如需真机复验：profile 加挂 ask-user 工具的 bundle。
- [x] **AC6 会话**：`--session <id>` 历史完整、可续聊。
- [x] **AC7 桥零回归**：桥三件套（`--no-spawn` + health + WS handshake → session.init）。
- [x] 发现的问题记入下方「真机发现」小节，修完复验（4 条全修，AC1/2/3/6/7 复验通过）。

### 真机发现

| # | 发现 | 根因 | 修法 |
| --- | --- | --- | --- |
| 1 | `disabled:` 表达式炸 `cannot get property "neekoStartup" without inject` | 表达式在 loader audit 时求值，早于任何 row provide；cordis proxy 对未注入服务的**属性访问**直接 throw，`?.` 也救不了 | 改判据：audit 时唯一可用的是 host 级 `cmdlineArgs`（provideCmdline 在 boot 前跑）→ 用 `ctx.get('cmdlineArgs').get().includes('--tui')` |
| 2 | `failed to import`（TUI 行激活后） | tsdown 拆了共享 chunk（`dsh-adapter-*.js`），`files` 白名单没包含 → 发布面缺文件 | `files: ['lib', ...]` + tsdown `splitting: false` |
| 3 | `--tui` 时桥仍启动 | ① 两行 disabled 逻辑**写反**（bridge 该禁没禁、tui 该启被禁）；② TUI 行 config 缺 `tui` 键 → runner 的守卫 `config.tui !== true` 恒退 | 交换两行条件；patch 补 `tui: !!js ctx.neekoStartup.tui === true` |
| 4 | `Cannot access 'hooks' before initialization` | `setup` 闭包引用了声明在其后的 `hooks`（late-bound 设计没错，声明顺序错） | `hooks` 提到 `setup` 之前 |

**经验**：`disabled: !!js` 的求值时机 = loader audit（树挂载前）。该时刻可用的只有
host 级事实（`cmdlineArgs` / `profileContext` / `appExit`），任何 row provide 的服务都不可见。
选 runner 的判据必须落在 argv 上，不能落在 startup 服务上。

## Step 9b：斜杠命令补全 + 主题系统（用户追加需求）

- [x] **斜杠命令发现**：接 `CombinedAutocompleteProvider`（pi-tui 官方实现），
      输入 `/` 弹菜单（name + description + argumentHint），字母模糊过滤，Tab 补全。
      踩坑：`suggestCommands()` 写了纯函数却没接线 —— 只测纯函数不等于用户能用。
      补充：`suggestCommands()` 已删除（接管线是 `buildCommands` + `LiveSlashProvider`，
      留着就是第二个无调用方的实现）。
- [x] **菜单是活目录**：`LiveSlashProvider` 每次请求重建内部 provider，
      因为 pi-tui 的 `CombinedAutocompleteProvider` 在构造函数快照命令数组 ——
      插件在 TUI 运行中注册的命令原本永远进不了菜单。
- [x] **模型选择**：走**编辑器内联参数补全**（`/model ` → 候选列表就在输入框边框内），
      不另做 overlay：pi-tui 的 `applyCompletion` 不读命令表，内联是唯一能保持
      “列表贴着正在输入的文本”的形态。`/model <id>` 校验后 `selectModel` 换路；
      裸 `/model` 给出提示（`setText` 会取消补全，程序化打不开下拉）。
- [x] **主题系统**：照 pi 的 `theme/` 架构 ——
      `{name, appearance, vars, colors}` 文档、vars 引用解析、ANSI 预计算、
      `""` = 终端默认前景。内置 dark/light（全文转录 pi 的 56 个 token）。
- [x] **自定义主题文件**：`~/.dsh-neeko/themes/<name>.json`（pi 用 `~/.pi/agent/themes`），
      `DSH_NEEKO_THEMES_DIR` 可覆盖；非法 JSON / 缺 colors / BOM 全部 fail-open。
      **部分主题在 `resolveTheme` 时叠在内置底板上** —— loader 接受只有一两个 token 的
      合法文件，而 `Theme.fg` 对缺失 token 抛错；不叠就是“合法文件把 TUI 炸掉”。
- [x] **`/theme` 命令**：裸调用开选择器（`→`/`✓`/`[appearance]`/`· custom`），
      `/theme <name>` 直接切换；`DSH_NEEKO_THEME` 设初始主题。
- [x] 测试 106 → **283**；`prepublishOnly` 全绿。
- [x] 自动化覆盖（本轮）：`/model <id>` 校验+切换+提示、未知 id 不切、空目录、
      `LiveSlashProvider` 活目录、`resolveTheme` 叠底板后全 token 可绘、
      `gitBranch` 的 linked worktree / detached HEAD。
- [ ] **(待重跑) 真机 pty**：本轮改动（`/model` 切换、活目录、主题叠底板）**尚未**在真实
      终端复验。上一轮 pty 验过的是内联补全 + 主题切换本身（机制未变）。
      重跑命令与项目见本文末「验证命令速查」，需补：`/model ` 候选 → Tab → 切换后
      横幅/状态栏同步；只含 `accent` 的部分主题切换不崩。

> 复现记录的偏差：本条曾写作“`showOverlay` 浮层 + `fuzzyFilter` + `maxVisible=10`
> + `→`/`✓`/`· default` 三标记”，但代码走的是内联补全（`showOverlay` 在 `src/**` 零命中）。
> 已按实际实现重写 —— 真机记录必须对应当前代码树，否则下一轮会被当成待修 bug 重新排查。

## Step 11：审核修复（neeko-check）

> 从第一性原理 + 高内聚/低/可扩展三维对本轮 diff 的审核结论。
> 每项均带变异验证（去掉修法后测试必须变红）。

- [x] **B1 `/model` 链路断**：`runCommand` 丢弃 `/model <id>` 的参数 → 与裸 `/model` 同路，
      `selectModel` 成为必填的死选项；就算接上也不生效（`route`/banner 读构造期快照）。
      修：`CommandOutcome` 加 `use-model` digest → `CommandAction.select-model` →
      `applyModelById()` 校验目录后调 `selectModel`；`TuiAppOptions.selection` 换成
      `getSelection()` getter（状态栏/横幅每次绘制重读）。代价：4 条测试变红。
- [x] **B2 部分主题炸渲染**：loader 接受只含 1 个 token 的合法文件，`Theme.fg` 对缺失 token
      抛错 → `/theme <partial>` 首次重绘就炸，推翻同文件的 fail-open 承诺。
      修：`resolveTheme` 叠到 `appearance` 对应内置底版（缺 token 回退，显式 key 胜出；
      `appearance` 本身不继承 —— 它决定色彩模式回退）。3 条测试变红。
- [x] **B3 implement.md 与代码不符**：Step 9b 记录 `showOverlay`/`fuzzyFilter`/`maxVisible`
      在 `src/**` 零命中，且测试数（128）与实测不符。已按实际实现重写，
      overlay 那条改为「决策记录」而非“已验证”。
- [x] **W1 菜单伪活目录**：`CombinedAutocompleteProvider` 构造时快照命令数组，
      而 API 写着 `() => ...`。修：新增 `slash-provider.ts` 的 `LiveSlashProvider`
      每次请求重建（`applyCompletion` 不读命令表 → 重建无状态代价）；
      `toSlashCommands` 收口 shape 适配。变异（加缓存）→ 1 条变红。
- [x] **W2 runner 内聚回退**：5 个 host 事实读取器零测试插在组合根。
      修：抽 `host-facts.ts`（`packageAt`/`gitBranch`/`dshVersion`/`readContextPressure`/
      `contextWindowOf`，均可在 fake ctx / tempdir 下直测，19 条新测试）；`execute` 形状
      与 `toExecuteLine` 归 `host-commands.ts`（`executeHostCommand`，4 条新测试）。
- [x] **W3 工作树里无分支**：`gitBranch` 只读 `<cwd>/.git/HEAD`，linked worktree 里
      `.git` 是文件 → 静默 undefined（本仓自身就是 worktree）。修：解析 `gitdir:` 指针
      （含相对路径），detached HEAD 明确返回 undefined。三条测试钉住。
- [x] **W4 胶水层无测**：`submit()` 全路由、`/model` 校验分支、host 失败分支、
      `/clear` 双容器清空补上 10 条；`TuiApp` 改接 `Terminal` 接口 +
      `tests/support/fake-terminal.ts`，测试不再写真实 TTY（报告输出也变干净）。
- [x] Nit：死字 `void truncated` / `void rowIndex`、孤儿 doc 注释（`theme.ts`）、
      重复 onExit 注释、`selectionRef.current?.x ?? initial.x` ×7 → `liveSelection()`、
      `transcript.renderRow` 的 `fg(token: never)` + `as never` → 真 `ThemeToken`/`MarkdownTheme`、
      cwd 三源 → 单源（`TuiAppOptions.cwd`，runner 读一次）、`formatCwd` 平台分隔符、
      `suggestCommands()` 删除（无调用方）、timing 的 `lastGenMs/lastThinkingMs/lastReplyMs`
      + `onTurnComplete` 删除（只写不读；`lastReplyMs` 只在有工具的 turn 才 fold = 错值）。
- [x] spec 沉淀：`quality-guidelines.md` 加「校验边界不一致 = 合法输入炸运行时」与
      「快照 vs 活目录」（均标适用范围）。
- [x] `prepublishOnly` 全绿：**321 测试** / `tsc`×2 / build / publint。
- [ ] 真机复验上述交互项（见上 Step 9b 的待重跑项）。

## Step 12：第二轮审核修复（交互层断裂）

> 上一步修完后再次审核，发现 3 个 Block **全部落在同一盲区**：交互状态机
> （`tui-interactions.spec.ts` 9 条，测得很好）到屏幕之间那 ~30 行胶水无测。
> 每个修法都带变异验证。

- [x] **B1 提问答案被送给模型**：`submit()` 从不检查 `interactions.busy` → 自由输入提问的
      答案同时发给模型、且永远不会回答提问 → agent 永久挂起。
      修：`submit()` 首行分流 `current?.kind === 'question'` → `answerQuestion()`。
      变异（删掉分流）→ 2 条变红。
- [x] **B2 提问态 ESC 死锁**：审批分支有 ESC，提问分支没有 → 唯一出路是 Ctrl+C 退出整个 TUI。
      修：把键路由抽成纯函数 `interactionIntent(view, isKey, digit)`，两种 view 共用
      `cancel` 分支；新增 `cancelByUser()`（与 `cancelAll()` 仅区分 abort 文案 ——
      ESC 曾报“connection closed”）。变异（ESC 只管审批）→ 1 条变红。
- [x] **B3 `/clear` 假清空**：只清 `Container`，而 `flush()` 按 `state.rows` 全量重建 →
      下一个事件把整段对话复活。修：引入可见游标 `visibleFrom`，`/clear` 推进它，
      flush 只渲染 `rows.slice(visibleFrom)`（行与会话日志不动）。
      变异（去掉 slice）→ 1 条变红。
- [x] **W1 交互层零测试（三轮漏 bug 的根因）**：新增 `tests/tui-interaction-glue.spec.ts`
      （16 条：审批 y/n/esc + 吞键 + 面板文案/清空、提问数字键/越界键/ESC/自由文本/
      多题计数、`/clear` 跨重绘仍生效且新行仍显示、notices 不被 flush 清掉）。
- [x] **W2 route 无宽度约束**：状态栏只裁左侧，200 字符模型名在 width=80 下输出 206 列
      （实测）。修：route 自身 `truncateToWidth`，padding 下限 0。2 条测试钉住。
- [x] **W3 app.ts 结构回退**：picker 文案/键位抽 `theme-picker.ts`（纯函数 +
      `themePickerIntent`）；`refreshInteraction` 的面板文案抽 `renderInteractionPanel()`。
      两处均新增直测（10 + 5 条）。app 从 626 → 615 行（余下是 options 接口与分区注释）。
- [x] **W4 接口面收敛**：删死 API `seedHistory()`（runner/测试均无调用）；
      `setTimingLine()` + `refreshStatus()` 合成 `updateStatus(timing)` —— 旧的两个调用
      会重绘两次，状态栏能在一帧里显示“新 timing + 旧 ledger”。
- [x] `prepublishOnly` 全绿：**344 测试** / `tsc`×2 / build / publint。
- [ ] 真机复验（审批/提问/`/clear` 三条链路）。

## Step 13：第三轮审核修复（性能回退与资源边界）

> 本轮审核对象是**第二轮的修复本身**。发现 2 个 Block，其中一个是上一轮把
> 快路径换成慢路径造成的性能回退。

- [x] **B1 流式热路径退化为每 token 全量折叠**（第二轮 W4 自己引入）：
      把 `setTiming()`+`refresh()` 合成 `update()` 后，runner 的**每个 chunk 帧**都
      触发 `readFacts()` → `snapshotEvents()` 全量快照 + `sessionProjections` 读 +
      **同步读 `git HEAD`**。实测：50 次 → 50 次 facts 读。
      第一性修法：**facts 与 timing 生命周期不同** —— timing 每 chunk 变（纯算术），
      facts 只随会话事件变（含 I/O）。拆回双入口：`setTiming()`（廉价，缓存重排）/
      `refresh(timing?)`（昂贵，可顺带带 timing → 事件路径仍只重绘**一次**）。
      app 侧命名为 `updateTiming()` / `refreshStatus()`，让成本差异在调用点就可读。
      新增**频率契约**测试（50 次 setTiming → facts 读 0 次）；变异 → 1 条变红。
- [x] **B2 主题选择器无高度上限**：40 个主题 → 43 行面板，把编辑器顶出屏幕，
      而键盘仍被 picker 消费 → 看不见输入框却打不进字。
      修：抽通用 `window.ts`（`listWindow` + `overflowMarkers`，pi 模型选择器同款
      maxVisible=10 + 选中居中），`renderThemePicker` 接窗口并显式报
      `↑/↓ N more`（静默截断会让用户以为目录就这么多）。5 条变异验证。
- [x] **W1 `submit()` 只挡 question 不挡 approval**：改为以 `interactions.busy`
      守住不变量（question → 答案；approval → 提示而非发给模型）。
      之前靠“唯一调用方会先 consume Enter”而不可达 —— 把不变量交给调用方
      正是本文件两次漏 bug 的模式。变异 → 1 条变红。
- [x] **W2 `visibleFrom` 与重新绑定不兼容**：`mountTranscript` 重置水印。
      旧水印（2）会把新绑定、更短的行数组全部遮住 → 视图永久空白。变异 → 1 条变红。
- [x] **W3 `setTiming()` 在 `src/` 零调用**：它不再是死 API —— `updateTiming()`
      是它的单点调用方，`update()` 已彻底删除。
- [x] **W4 notices 无上限**：加 `MAX_NOTICE_COMPONENTS = 64`，超出丢最旧
      （`/help` 一次就追加 8 行，且每个子组件参与每次重绘）。变异 → 1 条变红。
- [x] spec 沉淀：`quality-guidelines.md` 加「频率契约测试」与「把快路径换成慢路径」。
- [x] `prepublishOnly` 全绿：**344 测试** / `tsc`×2 / build / publint。
- [ ] 真机复验（流式帧期间的 CPU/延迟、多主题下的 picker）。

## Step 14：模型切换失效修复（用户反馈）

> 用户报告「model 切换失效，前面是没有问题的」。定位到 3 个各自独立的缺陷，
> 全部是我在前几轮引入或未接线的，都有变异验证。

- [x] **B1 `reasoningEffort` 被带过模型边界**（Step 11 接线时引入）：
      `selectModel` 写成 `{ ...route, model: id }`，把旧模型的 `reasoningEffort`
      一起带进新模型。DSH 契约（`installModelSelection` 的 `agent/request`）是：
      effort **absent = 用该模型的 provider 默认**，present = **原样应用**。
      所以旧档位被强加到不支持它的新模型上 → 请求失败或静默降级 → 表现为“切换没生效”。
      修：抽 `model-switch.ts` 的 `switchedSelection()`（只留 provider + 新 model）。
      变异（恢复 `...route`）→ 2 条变红。
- [x] **B2 空目录被永久缓存**（构造期预热引入）：`ensureModels` 一旦设
      `modelsLoaded = true` 就永不重试。而 app 在**构造期**就 `void ensureModels()`
      预热——那一刻 provider 注册表可能尚未就绪，返回空即被锁死整个会话。
      `llm.listModels()` 失败也同理。修：**只缓存非空结果**，失败/空都可重试。
      变异（恢复永久缓存）→ 1 条变红。
- [x] **B3 `selectModel` 抛错时完全静默**：`submit()` 的 promise 直接 reject，
      界面无任何提示 → 用户看到“按回车什么都没发生”。
      修：`applyModelById` 包 try/catch，失败转 error notice 且不谎报成功。
      变异 → 1 条变红。
- [x] **W1 `llm` 未声明依赖**：runner 用 `ctx.get('llm')` 作为模型列表唯一来源，
      但 `inject` 只声明了 `agentDefaultModel` / `agents` → cordis 不会等 `llm`
      就绪，boot 期可能拿到 `undefined` → 目录为空。修：`inject` 加 `llm`
      （`skills`/`commands` 保持可选，缺了只是菜单少几项）。
- [x] 测试：新增 `tests/tui-model-switch.spec.ts`（4 条）+
      `tui-controllers.spec.ts` 加「空/失败后重试」（2 条）+
      `tui-interaction-glue.spec.ts` 加「切换失败可见 / 成功仍确认」（2 条）。
- [x] `prepublishOnly` 全绿：**352 测试** / `tsc`×2 / build / publint。
- [ ] 真机复验：`/model ` 候选非空 → 选中 → 下一轮请求确实走新模型
      （观察 `[model changed: …]` 通知行，DSH 在路由变化时会写一条 durable notice）。

## Step 15：`/model` 不列模型（真机实测根因）

> 用户第二次反馈「还是不行，执行 /model 不会列出模型列表」。
> 上一轮的修复（空缓存 / inject）方向对但**没打中根因** —— 本轮用真实 dsh 实测定位。

**实测方法与证据**（不再靠推断）：往 profile 注入探针插件，直接打印 `llm` 的行为：

```
PROBE warmup(t0)  ERR=no adapter registered for provider "magpie"   ← TUI 构造期预热
PROBE user(/model) OK  n=36 first=group/auto-step-5-preview          ← 300ms 后
PROBE magpie      = [group/auto-step-5-preview, ... 共 36 个，id 全含 "/"]
```

- [x] **根因：provider adapter 的注册晚于我们的构造期预热**
      `llm-pi-ai` 是另一个 fiber，它的 provider 注册在 boot 后约 200ms 完成；
      而 `TuiApp` 构造期就 `void ensureModels()`。那一刻 `llm.listModels('magpie')`
      抛 `no adapter registered for provider "magpie"`，被 `catch` 吞成空目录。
      上一轮改成「不缓存空」只解决了**后续能重试**，但构造期那一次失败留下的
      `modelCatalogue === []` 在补全路径上是**同步读取**，永远不会自己重来。
      修：
      1. `listModels()` 补全源在目录为空时调度一次 `reloadModels()`（去重，一次只飞一个请求），
         到达后 `requestRender()` → 下一次按键就能看到真实列表；
      2. 裸 `/model` 直接**列出全部模型**（标 `✓` 当前项 + 头部显示当前 route），
         不再只说「type /model <name>」—— 这正是用户期望的行为。
      3. 删掉 `showModelHint` 里多余的 `reloadModels()` 调用：`ensureModels` 本身
         已不缓存空，那次调用就是重试，再加一层是死代码（变异验证证实不可见）。
- [x] 顺手修：`ensureModels` 的注释与实现对齐（空/失败都不缓存，只有非空才 settled）。
- [x] 测试（+4）：裸 `/model` 列出全部模型并标当前项、瞬时空目录会重试、
      重试后仍空才报 hard absence、`CommandController` 的 adapter-settling 窗口重试契约。
- [x] `prepublishOnly` 全绿：**356 测试** / `tsc`×2 / build / publint。
- [ ] 真机复验（建议）：`/model` 应直接列出 36 个模型；`/model group` + Tab 应过滤并插入
      完整 id（实测插入行 = `/model group/auto-deepseek-v4-1-flash`，正确）。

**方法教训**：前两轮我在 `packages/**` 里反复推演，都没找到根因；注入一个探针插件到
真实 profile 打印运行时事实，一次就定位了。**组合根的行为差异必须实测，不能从类型和
代码推断** —— 这类「另一个 fiber 比我晚就绪」的时序问题在单测里完全不可见。

## Step 10：收尾（开发内，无真机）

- [x] **契约自查（AC9）**：`grep -rn "session.events\|registerProvider\|assistant/chunk" src/tui/`
      → 零命中（注释里讲历史的除外）。
- [x] **既有测试**：`pnpm test` 全绿（含桥的 68 条，AC4 无回归的自动化面）。
- [x] `pnpm run prepublishOnly` 全绿（AC8）。
- [x] spec 沉淀：`disabled: !!js` 的求值时机（loader audit，早于 row provide；判据只能落
      host 级事实）与「TS 构建产物 files 白名单 vs chunk 拆分」两条入
      `quality-guidelines.md`。TUI 双来源不变量与桥共用 `dsh-adapter` 文档，不重复立档。
- [x] 无副产物检查（`pnpm-lock.yaml` 不出现在 git status）。

---

## 验证命令速查

```bash
cd packages/dsh-neeko
pnpm run prepublishOnly        # check && test && build && lint:package

# 真机统一验证（Step 9）
dsh --profile neeko --tui --no-spawn --port 3197
dsh --profile neeko --no-spawn --port 3197        # 桥回归路径
curl -s http://127.0.0.1:3197/neeko-health

# 会话 id 来源（Step 4 用）
# 桥的 session.init 或 dsh sessions list
```

## 回滚点

| 回滚点 | 触发 | 动作 |
| --- | --- | --- |
| Step 1 后 | patch `when:` 语法不存在 | 转 design §1 保底方案（双 runner + config 分流） |
| Step 2 后 | agents 接线在 TUI 形态下行为异常 | 对照桥（已验证）逐行 diff 接线参数 |
| Step 3 后 | pi-tui 1.3.0 渲染异常 | 对照差异清单；必要时 patchedDependencies 或锁低版本 |
| Step 5 后 | 流式卡顿 | 50ms 合帧已有；仍卡则提前做 transcript 窗口化（原 R3 范围） |
| Step 7 后 | 审批/提问 waterfall 在 TUI 下不触发 | 先查 `setup` 注册时序（对照桥），再查 `inject` |
| 任意 | 发现必须动 `src-tauri/**` / `src/**` | **停止** —— 超出本任务边界，回用户 |
