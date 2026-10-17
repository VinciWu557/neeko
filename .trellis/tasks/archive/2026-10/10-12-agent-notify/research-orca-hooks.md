# Research — orca 项目通知机制调研纪要（2026-10-12）

> 来源：`/Users/tomgs/workspaces/ts_space/orca`（Electron，stablyai "Next-gen IDE for parallel
> agentic development"）。本纪要是 design.md v3（源 B / D7-D11）的证据底稿，实施 Phase B 前重读。

## 1. 系统通知投递

- Electron 原生 `Notification` API（无第三方 notifier）：`src/main/ipc/native-notification-delivery.ts:34`。
- darwin 必须显式 `sound:'default'`（macOS 未设 sound 即静音）。
- 同 `notificationId` 的旧通知先 close 实现替换；持有引用防 GC；监听 `failed` 事件。
- macOS 先查系统授权（denied/not-determined → renderer 回退应用内横幅）；窗口不可见时点亮 tray。
- 投递决策集中：`src/main/notifications/notification-delivery-service.ts`；IPC 通道 `notifications:dispatch`。

## 2. 外部 Agent CLI 感知（源 B 的参考实现）

**模式 = 用户级 hook 配置（23 个 agent 各一个 hook-service）+ 本机 loopback HTTP 回调：**

- 注册表：`src/main/agent-hooks/managed-agent-hook-registry.ts:47-71`。
- Claude 系 → `~/.claude/settings.json` hooks 表（结构化合并，**orca 的最痛点**；事件清单按 CLI
  版本裁剪，`claude-managed-hook-events.ts:9-81`）。
- opencode → `<configDir>/plugins/orca-opencode-status.js`（独立文件即插拔）。
- pi → 无 settings hook 面，生成 TS 扩展写 `~/.pi/agent/extensions/orca-agent-status.ts`
  （`titlebar-extension-service.ts:145-162`）。
- jcode → `~/.jcode/config.toml [hooks]`，注释明言 "sessions launched outside Orca still report"。

**回调 server**：`http.createServer` 监听 `127.0.0.1` 随机端口（`server-lifecycle.ts:198`
`listen(0,'127.0.0.1')`）；token = 每次启动 `randomUUID()`；路由 `POST /hook/<source>`；
header `x-orca-agent-hook-token` 不符 → 403（`server-lifecycle.ts:57`）；slowloris 超时保护；
**fail-open**：畸形请求一律 204，绝不阻塞 agent。

**坐标发现（跨重启存活）**：端口/token 写 `~/.orca/agent-hooks/endpoint.env`（Windows
`endpoint.cmd`，`set KEY=VALUE`；0600、原子 rename；`endpoint-publication.ts:31-90`）。
hook 脚本**每次回调前重新 source/解析**该文件（`claude/hook-script.ts:84-88`；opencode 版带
mtime+ino 缓存）→ 应用重启换端口后存活 agent 进程仍能送达。

**hook 脚本防御性包装**（`runtime-home-hook-command.ts:31`）：先检查脚本存在/可读/可执行，
否则 `cat >/dev/null` 排空 stdin；curl `--connect-timeout 0.5 --max-time 1.5 --noproxy 127.0.0.1`；
失败 spool 落盘、启动时重放（Neeko MVP 不做 spool，登记 E6）。

**pi 上报 body 样例**（`agent-status-extension-source.ts:246-257`）：

```json
{ "paneKey": "...", "launchToken": "...", "tabId": "...", "worktreeId": "...", "env": "...",
  "payload": { "hook_event_name": "agent_start|agent_end|tool_call|...", "session_id": "...", "session_file": "..." } }
```

事件→状态映射：`src/shared/agent-hook-listener/providers/pi-family-events.ts:84-93`
（lifecycle → working/done；ask 类工具 → blocked/waiting；状态机
`AGENT_STATUS_STATES = ['working','blocked','waiting','done']`）。

**orca 的归属缺口（Neeko D8 的反面教材）**：归属依赖 `ORCA_PANE_KEY` env，只注入 orca 自 spawn
的 PTY；纯外部终端（无 env）的事件 → telemetry `agent_hook_unattributed` 后**丢弃**
（`server-ingest-terminal.ts:28-31`）。兜底腿：PTY 标题/进程探测、transcript 轮询
（`transcript-poll-policy.ts`，同样只针对自有会话）。

## 3. 通知决策（与 Neeko 核心域 policy 对照）

- 节流：`shared/notification-burst-cooldown.ts` —— 同 dedupeKey **5 秒冷却**，Map 上限 50 key；
  key = `attentionKey ?? worktreeId ?? worktreeLabel ?? 'global'`（agent-finish 与 terminal-bell
  常同时触发，故按 worktree 去重）。→ Neeko 对应：(domain, instance, event_key) 节流 + Completed 合并窗口。
- 焦点抑制：`suppressWhenFocused && isActiveWorktree && window.isFocused()` → suppressed-focus
  （`notification-delivery-service.ts:141-149`）；tray attention 在所有 gate 之前点亮。
  → Neeko 对应 R2.1（聚焦且可见才抑制）。
- 设置：`shared/notification-settings-defaults.ts`（enabled / agentTaskComplete / terminalBell 默认关 /
  suppressWhenFocused / customSoundId / mutedNotificationSourceIds）。
- 欠账补偿：`shared/claude-owed-task-notifications.ts`（错过的 Stop 事件补发）→ Neeko E6。
- 移动端 fan-out 仅当桌面 away（idle/locked ≥180s）→ Neeko E8 参考。

## 4. 对 Neeko 的采纳/调整结论（已落 design.md v3）

| orca 做法 | Neeko 采纳 | 调整原因 |
| --- | --- | --- |
| endpoint.env 坐标发现 + 回调前重读 | ✅ 原样采纳（R6.1） | 跨重启存活是物理必需（T5） |
| 随机端口 + 每次启动随机 token + 403 | ✅ 采纳（R6.3） | 成本低收益高 |
| fail-open 204 / 短超时 / 不阻塞 agent | ✅ 采纳且更强（一切异常 204/静默） | T5 硬约束 |
| 独立文件 hook（opencode plugin / pi extension） | ✅ 采纳（R6.5） | 避开 claude settings.json 式结构化合并难题 |
| 改用户 settings.json（claude 式） | ❌ 不采纳 | 合并/清理/冲突成本高；Pi/Opencode 都有独立文件面 |
| 无归属事件丢弃 | ❌ 反向决策：basename 兜底仍通知（D8） | Neeko 产品语义是「多项目管理器」，外部会话也有归属价值 |
| spool 落盘补发 + transcript 轮询兜底 | ⏸ 登记 E6 不实施 | MVP 收敛 |
| WSL guest relay / 移动端推送 | ⏸ B4 实测 host 地址先行；relay/E8 登记 | 分期 |
