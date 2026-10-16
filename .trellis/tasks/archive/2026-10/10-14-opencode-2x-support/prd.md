# PRD：opencode 2.x 插件与通知兼容

## 背景

本地已升级 opencode v2.0.28（无 1.x）。现有 5 个插件全部被 V2 loader 拒载
（`Plugin must export a default definition with an id and an effect or setup function`）：

- 项目级 `.opencode/plugins/`：`inject-subagent-context.js`、`inject-workflow-state.js`、`session-start.js`
- 全局 `~/.config/opencode/plugins/neeko-status.js`（Neeko 通知上报，由 Rust 模板生成）

实测确认（2026-10-14）：V2 事件包络为 `{type, data}`（非 V1 的 `{type, properties}`）；
生命周期为 `session.execution.started/succeeded/failed/interrupted`（无 `session.status/idle`，
无 `session.updated`，无 `question.*`）；`permission.asked/replied` 仍存在；
`session_v2/session_message` 与旧 `session/message/part` 双写（会话恢复适配器不受影响）。

## 目标

1. 3 个项目插件以 V2 Promise 形态（`{id, setup}` 裸对象，零外部依赖）重写并自动加载成功。
2. 通知上报模板以 V2 形态重写并投递成功（`turn_completed` / `approval_requested` 语义不变）。
3. 1.x 现状冻结：V1 文件原样移入 `.opencode/plugins-v1/`；Rust 内 V1 模板文件保留不动。

## 非目标

- Effect API；V1 新功能；`open-island.js`（用户个人插件，不动，故障另行告知）。
- 会话恢复适配器改动（双写验证通过，无需改）。
- `question.asked` 在 V2 无对应事件，ask 阻塞以上报 `permission.asked` 为准（若 V2 经权限族统一，自动覆盖；否则记 follow-up 手工验证）。

## 方案要点

- 物理区分：`.opencode/plugins/` 放 V2，`.opencode/plugins-v1/` 冻 V1；`lib/` 共享不变（版本无关）。
- V2 映射：`tool.execute.before`→`ctx.tool.hook`（改 `event.input`，兼容 command/cmd、subagent_type/agent 别名）；
  `chat.message`→`ctx.session.hook("prompt")`（改 `event.prompt.text`，`metadata` 打标去重）；
  `event(session.compacted)`→`ctx.event.subscribe` + cleanup abort；Bash `TRELLIS_CONTEXT_ID` 改走 tool hook。
- 通知模板：`templates/neeko-opencode-status-v2.js`，`export default {id:"neeko-status", setup}`，
  `ctx.event.subscribe` 循环；`data ?? properties` 双包络读取；`session.execution.succeeded`→`turn_completed`
 （failed/interrupted 不报，对齐 V1“用户主动停不通知”语义）；`permission.asked`→`approval_requested`；
  endpoint 重读/mtime+ino 缓存/800ms 超时/全吞异常/`title:` 上报/200 会话上限保持不变。
- 安装面：`targets.rs` opencode 项切 V2 模板（安装路径 `neeko-status.js` 不变，版本号变化触发重装）。

## 验收

1. `node --check` + 形状断言（default 含 `id` + `setup` 函数）全过。
2. `cargo test agent::hooks` 全过（含新增 V2 锚点测试）。
3. 重启 opencode，`opencode.log` 无 `failed to load plugin`（我方 4 个文件），`/tmp/trellis-plugin-debug.log` 见加载记录。
4. 通知链路：stub server  harness 回放 `session.execution.succeeded` + `permission.asked`，收到正确 POST；
   真机 opencode 触发一次 idle/permission（手工）。
