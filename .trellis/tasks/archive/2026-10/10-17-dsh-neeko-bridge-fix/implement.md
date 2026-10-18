# Implement — dsh-neeko 桥修复

> 有序 checklist。根因见 `prd.md`，修法与取舍见 `design.md`。
> TDD 强制：Red → Green → Refactor。
> **顺序不可交换**：① 不修则桥起不来，② 无法真机验证；③ 最后做，因为它会改类型面。

---

## Step 0：基线固化（先记录，后动手）

- [x] 记录当前真实崩溃点，作为「修好了」的对照基线：
      ```bash
      dsh --profile neeko --no-spawn --port 3197   # 期望：ValidationError spawnCommand
      lsof -nP -iTCP:3197 -sTCP:LISTEN             # 期望：空（未监听）
      ```
- [x] 记录既有测试基线：`pnpm test` → **35 passed**（回归判据）。
- [x] 记录 peer 门禁现状：撤销本机豁免后应能复现「incompatible with dsh 0.2.0-rc.2」。
      ```bash
      dsh plugin --profile neeko list   # 观察 incompatibility 警告
      ```
      > 注：本机已用 `allow-version` 授予豁免（环境状态，非仓库改动）。
      > 若要复现门禁，需先移除豁免；Step 3 收尾时再正式撤销一次做终验。

**Gate**：三条基线都有记录才能进 Step 1（否则「修好了」没有对照）。

---

## Step 1：修 ① — `--no-spawn` 解析（**落点已纠正**）

> 初版误以为要改 `cordis.patch.yml` + `Config`。实测推翻：schema 对缺键宽容，
> 只有 `false` 才炸。**不要动 YAML / schema**，改 `startup.ts`。

- [x] Red：`no_spawn_sets_autospawn_false_and_omits_spawn_command`
      —— `options.spawn === false` 时：`autoSpawn: false` 且 **`spawnCommand` 不存在**。
      当前必红（现在会写进 `false`）。
- [x] Red：`spawn_command_string_sets_only_spawn_command`
      —— `--spawn /bin/true` 时：`spawnCommand` 为该串，`autoSpawn` **不出现**
      （交给 patch 兜底 `?? true`）。
- [x] Red：`neither_flag_sets_neither_key`
      —— 两者都未给 → 两个键都不出现。
- [x] Green：`startup.ts` 改为读 `options.spawn` 三态
      （`false` / `string` / `undefined`），删掉对 `spawnEnabled` 的引用。
- [x] Green：`opts<>` 的类型把 `spawn?: string` 改为 `spawn?: string | false`
      —— 让「可能是 false」在类型层可见（原声明是 bug 能写下的直接原因）。
- [x] 真机验证：`dsh --profile neeko --no-spawn --port 3197`
      → **不再报 ValidationError**（应露出 ② 的错误，这是预期）。
- [x] 真机验证：`dsh --profile neeko --spawn /bin/true --port 3196`
      → 同样过校验。

---

## Step 2：修 ② — question 侧改用 Agent 作用域 waterfall

### 2a. 先补反证测试（Red）

- [x] Red：`registers_a_waterfall_listener_for_user_questions`
      —— 断言 `setupAgent` 注册了 `'user-questions/request'` 监听器。
      反证力：改回 `registerProvider` 后，在**同代 dev 依赖**下编译即失败。
- [x] Red：`declines_when_inactive_and_calls_next`
      —— 未激活会话时收到请求 → 必须调用 `next()`，不得自己接管。
- [x] Red：`aborts_pending_question_on_signal`
      —— `request.signal` abort → 以 `ASK_ABORTED` reject。
- [x] Red：`returns_answer_shape_matching_dsh_contract`
      —— 断言返回 `{ answers: [{ id, selected[], custom? }] }`，与 0.2.0-rc.2 类型逐字段一致。

### 2b. 实现（Green）

- [x] 删除 `src/index.ts:157` 的 `this.ctx.get('userQuestions')?.registerProvider(...)` 及其 disposer 逻辑。
- [x] `setupAgent` 增加 `agentCtx.on('user-questions/request', ...)`，与 approval 分支并列，
      并在返回的 dispose 闭包里一并回收。
- [x] 新增 `answerQuestions(request, next)`：复用既有 `askQuestion()`（它产出的形状已正确），
      只把入口从 provider 换成 waterfall 监听器。
- [x] `next()` 让位逻辑：未激活 / 无连接 / 用户未打开 → 调 `next()`。
- [x] `request.signal` 中止语义与既有 `askOneQuestion` 对齐。
- [x] `inject` **保留** `userQuestions`，并加注释说明理由变了
      （从「调它的方法」→「消费它派发的事件」），防后人当冗余删掉。
- [x] 清理死代码：`questionProvider()` 若不再被引用则删除；
      `UserQuestionProvider` 的 import 随之移除（0.2.0-rc.2 已无此类型）。

### 2c. 真机验证（AC1 / AC2）

- [x] `dsh --profile neeko --no-spawn --port 3197` → **端口进入 LISTEN**（第一个真信号）。
- [x] `curl http://127.0.0.1:3197/neeko-health` → **200**。
- [x] 连 `/ws` 完成 handshake → 收到 `session.init`。
- [x] `pnpm test` → 既有 35 条 + 新增 4 条全绿。

---

## Step 3：修 ③ — peer / dev 依赖同代

- [x] Red：在**同代** dev 依赖下跑 `tsc --noEmit`，确认现有代码若仍引用
      `registerProvider` / `UserQuestionProvider` 会编译失败（验证「假绿」确实被消除）。
- [x] Green：`peerDependencies` 范围上修到 `^0.2.0-rc.2`。
- [x] Green：`devDependencies` 提到 `^0.2.0-rc.2`（与 peer 同代）。
- [x] Green：补 `@deepseek-ai/dsh-attachment: 0.2.0-rc.2`（**精确版本**）——
      `dsh-llm` 的 `.d.ts` 直接 import 它，而它只是 dsh-llm 的 devDep。
      用 npm `latest`（`^0.0.1-rc.1`）会报 `has no exported member 'FileAttachmentRef'`。
- [x] README 注明支持的 dsh 代际（R3.3）—— 已加「Supported DSH generation: 0.2.x only」+ 新事件映射表。
- [x] **撤销本机 `allow-version` 豁免**验证：干净重装 profile 后无 incompatibility 警告
      （已在 `/tmp` 的 profile 副本上验证：`dsh plugin install` 无任何 exemption 提示）。
- [x] `pnpm run prepublishOnly`（`check && test && build && lint:package`）全绿（AC5）。

---

## Step 3.5：修 ④ — 翻译层迁移到 0.2.x 事件模型

> 上修 peer 后暴露：`assistant/chunk` 在 0.2.0-rc.2 **不存在**。
> 权威契约：`dsh-session/lib/types/types.d.ts` 的 `SessionEventMap`。

### 3.5a 先定权威事实（不猜）

- [x] 读 `SessionEventMap`：确认事件集（`turn/*` `step/*` `*​/message` `assistant/*` `tool/*` `request/*`）。
- [x] 找到实时流通道：**`agent/assistant-stream`**（`dsh-agent` 的 `runtime-types.d.ts`），
      帧型 `start` / `chunk` / `end`；`start` 带 `turn`/`step`。
- [x] 读 `AssistantStreamFrame` / `StreamChunk` / `AssistantMessage` / `ToolResultMessage`
      / `ContentBlockMap` 的字段。

### 3.5b Red → Green

- [x] Red：`tests/dsh-adapter.spec.ts` 重写为 0.2.x 契约（20 条），
      包含两条关键反证：
      - `does not emit deltas for a settled assistant message`（防双发）
      - `ignores the removed assistant/chunk event without throwing`（防回退）
- [x] Green：`translateEvent` 只留 `tool/call` / `tool/result`；`assistant/message` 返回空。
- [x] Green：新增 `translateStreamFrame(start, frame)`。
- [x] Green：`buildHistory` 改为 settled 消息折叠（无 chunk 累积）。
- [x] Green：`tool/result` 的 id 改取 `message.toolCallId`。
- [x] Green：桥订阅 `agent/assistant-stream`，用 `streamStart` 记住当前 attempt。
- [x] 保留原有覆盖：fs diff 提取、dangling tool call 丢弃、orphan result 跳过。

---

## Step 4：收尾

- [x] 确认 `packages/dsh-neeko` 之外**零改动**（AC7）：
      ```bash
      git status --short   # 只应有 packages/dsh-neeko/** 与 .trellis/tasks/10-17-*/
      ```
- [x] 确认无副产物：`git status` 中不得出现未跟踪的 `pnpm-lock.yaml`
      （根 `.gitignore` 只忽略 `*.lock`，`pnpm-lock.yaml` 不匹配 —— 跑 pnpm 会产生它）。
- [x] 复跑 Step 0 的三条基线，确认全部翻转（ValidationError → listening；端口 → LISTEN；health → 200）。
- [x] 把「类型检查跑在旧契约上 → 假绿」这条教训写进 spec
      （`.trellis/spec/backend/quality-guidelines.md`「依赖契约与实际运行时同代（类型假绿）」）。
      （这是本任务最有复用价值的产出；`packages/` 虽门禁豁免，但教训对根仓同样成立）。
- [x] 回填 `10-16-notify-dsh` 的 U7 前置事实（只改 design.md 风险行 + 加一节回填，不动其规划）。

---

## 验证命令速查

```bash
cd packages/dsh-neeko

# 本包门禁（根门禁不覆盖 packages/）
pnpm run prepublishOnly      # check && test && build && lint:package

pnpm test                    # 基线 35 条
pnpm check                   # tsc --noEmit && tsc -p tsconfig.test.json

# 真机启动（Step 1/2/3 各跑一次）
dsh --profile neeko --no-spawn --port 3197
lsof -nP -iTCP:3197 -sTCP:LISTEN
curl -s http://127.0.0.1:3197/neeko-health

# 撤销豁免做终验
dsh plugin --profile neeko list
```

---

## 回滚点

| 回滚点 | 触发 | 动作 |
| --- | --- | --- |
| Step 1 后 | 改了 YAML/schema 而非 startup.ts | 回滚那些改动 —— 它们是正确文件；只改 `startup.ts` |
| Step 2a 后 | 反证测试在旧实现下也绿 | 说明测试没打在 waterfall 注册上 —— 重写，别迁就 |
| Step 2b 后 | 真机仍崩在别处 | 记录新阻断点到本文件，评估是否扩大范围（先问用户） |
| Step 3 后 | 上修导致大量既有测试红 | 逐条判断：暴露了别的旧契约依赖就是本任务的账；不是则暂缓上修、先修 ①② |
| 任意 | 发现必须改 Neeko 侧（`src-tauri/**`） | **停止** —— 那属 `10-16-notify-dsh`，本任务范围外 |
