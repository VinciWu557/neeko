# 实施计划 — Agent Chat 上下文窗口用量显示（首期）

前置：动手前必读 `src-tauri/AGENTS.md`（Rust 侧红线）与 `src/AGENTS.md`（前端红线）。
相关 spec：`.trellis/spec/backend/agent-chat-transports.md`（传输协议）、
`.trellis/spec/frontend/component-guidelines.md`。

## Step 1 — 协议扩展（Rust，Red→Green）

- [x] `src-tauri/src/agent/chat/events.rs`：`Usage` 增
      `context_tokens / context_limit / cache_read_tokens / cache_write_tokens`
      （全 `#[serde(default)]`，doc comment 说明数据源语义）
- [x] 测试：新字段 roundtrip；旧 JSON 反序列化四个新字段为 `None`
- [x] 验证：`cargo test -p neeko agent::chat::events`（或对应过滤）

## Step 2 — PiRpc 采集（Rust，Red→Green）

- [x] `translate.rs`：`Translation` 增 `settled: bool`；`agent_settled` 置 true
      （测试：该事件标记 true，其余 false）
- [x] `session.rs`：新增纯函数 `meta_from_stats(session_id, model, &Value) -> Option<StreamEvent>`
      （字段映射见 design §3；`contextUsage` 缺失仍产出；`tokens` 缺失返回 None）
- [x] `session.rs`：`next()` 的 `settled` 分支拉取 `get_session_stats` 并入队 Meta；
      失败 `log::debug!` 跳过（不发 Error）
- [x] 测试：`meta_from_stats` 三分支；`next()` 在 agent_settled 后产出 Meta
      （用 `PiRpcProcess::from_split` 喂伪响应，参照既有 tests 模式）
- [x] 验证：`cargo test pi_rpc`

## Step 3 — 前端类型与派生（Red→Green）

- [x] `src/shared/types/agentChat.ts`：`Usage` 镜像四字段
- [x] `messageModel.ts`：`ContextWindow` 改 `{ used, limit: number | null, model, cache? }`；
      `contextWindowOf` 按新语义实现（design §4.1）
- [x] 测试：`contextWindowOf` 五分支（design §6 表）
- [x] 验证：`pnpm test:fe -- messageModel`（或 vitest 过滤）

## Step 4 — 弹层 UI（Red→Green）

- [x] `ContextWindowMeter.tsx`：弹层重写（头部/进度条/命中率行/提示行，
      降级分支 design §5）；`formatWan` 工具函数（导出以便测试）
- [x] `src/styles/components/agent-chat.css`：`ctx-pop-*` 重写
- [x] 更新 `ContextWindowMeter.test.tsx`（旧断言按新 UI 调整 + 新分支用例）
- [x] 验证：`pnpm test:fe -- ContextWindowMeter`

## Step 5 — mock 与收口

- [x] `useMockEventSchedule.ts` meta 事件补新字段（design §4.4 数值）
- [x] `pnpm check:quick` 全绿
- [ ] 手动：pi 会话跑一轮，弹层显示进度条 + 命中率（截图记录到任务 notes）——待用户真机验证

## Step 6 — Acp 采集（Red→Green，2026-10-24 修订新增）

- [x] `acp.rs`：`translate_notification` 增 `current_model: Option<&str>` 参数，
      新增 `"usage_update"` 分支（映射与容错见 design §3b；check 阶段补 snapshot 按变体名窥探，防 delta 高频深克隆）
- [x] 测试：全量映射 / size 缺失忽略 / float 容忍 / model 注入 / used 缺失忽略 / 负数拒绝（6 用例）
- [x] 验证：`cargo test acp` 52 passed

## Step 7 — 按钮纯图标化（2026-10-24 用户反馈）

- [x] 删除按钮内百分比文字标签（环色分级传达状态，数值走 hover title）
- [x] SVG 22×22 → 16×16（对齐 composer 的 lucide `size={16}` 基准），strokeWidth 3→4
- [x] CSS 删除 `.ctx-meter-label`；测试改写（ring-only 断言 + title 断言），8/8 + check:quick 19/19

## Step 8 — 入口位置调整（2026-10-24 用户反馈）

- [x] 计量器从附件按钮左侧移到**右侧**（composer-left 内 JSX 块移至 Paperclip 之后；用户先说左、随后更正为右，以最终指令为准）
- [x] 单块 JSX 移动，无测试锁定顺序，check:quick 19/19

## Step 9 — 悬停提示去英文（2026-10-24 用户反馈）

- [x] 降级分支 title `20.5万 tokens · m` → `已用 20.5万 · m`（组件内最后一处英文文案；
      弹层/aria 全中文，模型名为专有名词保留）
- [x] 测试断言同步，check:quick 19/19

## Step 10 — Agent Chat Tab 图标品牌化（2026-10-24 用户指令）

- [x] TabItemLeading 的 agent-chat 前导图标从通用 Bot 换为 `src/assets/agents/agent-chat.svg`
      （12×12 img 分支，与 favicon/agent 图标同链；getTabIcon 的 Bot 留作类型完整性与兜底）
- [x] 该 svg 此前是零引用孤儿文件（trellis-check 曾标记），本次接入即归位
- [x] ~~动作菜单保留通用 Bot~~（Step 11 推翻：用户要求菜单入口也换 svg）
- [x] check:quick 19/19

## Step 11 — 动作菜单入口同款品牌化（2026-10-24 用户指令，推翻 Step 10 的保留决定）

- [x] `ActionRegistryItem` 增可选 `iconSrc`（图片 URL 优先于 Lucide `icon` 渲染，
      参照 Tab 图标 / AgentIcon 的 img 模式；避免改 LucideIcon 类型的大手术）
- [x] `ActionMenuItem` / `ActionPalette` 两渲染点加 img 三元分支（16×16 shrink-0）
- [x] 注册表 `new-agent-chat` 项接 `agent-chat.svg`
- [x] check:quick 19/19

## Step 12 — 引导页两处漏网图标补齐（2026-10-24 用户截图反馈）

- [x] ProjectGuidePage 的 agent-chat 步骤（单一数据源，同时供给 OnboardingSteps
      推荐卡片与 QuickActionBar 快速操作）从 Bot 换为 agent-chat.svg（18×18 对齐兄弟图标）
- [x] 全仓 Bot 残留核查：WelcomeScreen（Multi-Agent 通用概念）与 AgentSkillContent
      （技能空态）与 Agent Chat 无关，保留
- [x] check:quick 19/19

## Step 13 — 图标封装为 AgentChat 组件（2026-10-24 用户指令）

- [x] 新建 `src/shared/components/AgentChat.tsx`：Lucide 组件形态（size/className/
      aria-hidden，memo 包装），svg 导入收敛到组件内单点
- [x] 三处消费点换组件用法：TabItemLeading（12）、ProjectGuidePage（18）、
      actionRegistry（icon: AgentChat）
- [x] 撤销 Step 11 的 `iconSrc` 特例：`ActionRegistryItem.icon` 改联合类型
      `LucideIcon | ComponentType<ActionIconProps>`，两渲染点回归统一 `<Icon/>`
      （aria-hidden 契约取 HTML 属性取值 `boolean | 'true' | 'false'`，JSX 字符串写法需要）
- [x] check:quick 19/19

## 回滚点

每步独立可回滚（协议字段向后兼容，UI 组件独立）。整体回滚 = revert 涉及文件，
无数据迁移、无存储格式变更。

## 审查门

- 红线自查：#5（无新事件名）/ #6（未动 Command 层）/ #15（无 language_id 分支）
- 语义自查：`total` 旧误用已移除；前端不再显示 `input+output` 当上限
