/**
 * 应用级通知域的前端类型镜像。
 *
 * 与 `src-tauri/src/notification/types.rs` 手动同步（项目约定，无代码生成）：
 * - `NotificationDraft`（IPC emit 载荷）serde 为 snake_case；
 * - `NotificationSettings`（config.json 持久化 + IPC）serde 为 camelCase。
 * 改动 Rust 侧必须同步本文件并跑 `pnpm type-check`。
 */

/** 通知语义类别 —— 闭集（与后端 `NotificationClass` 的 snake_case 序列化一致）。 */
export type NotificationClass = 'action_required' | 'completed' | 'failed';

/** 通知投递事件载荷（`NOTIFICATION_DELIVERED_EVENT`，镜像后端 `NotificationDraft`）。 */
export interface NotificationDraft {
  title: string;
  /** 会话主题（R7）：macOS 原生副标题 / Win-Linux 已拼进 `body` 前缀；空串 = 无主题。 */
  subtitle: string;
  body: string;
  class: NotificationClass;
  /** 通用回流地址 `neeko://{domain}/{instance_id}`。 */
  deep_link: string;
}

/** 用户通知设置（三层开关：全局 → 类别 → 事件覆盖；镜像后端 camelCase）。 */
export interface NotificationSettings {
  enabled: boolean;
  actionRequired: boolean;
  completed: boolean;
  failed: boolean;
  /** 事件级覆盖，键 = `{domain}.{event_key}`（后端 agent 投影 `event_keys` 一一对应）。 */
  eventOverrides: Record<string, boolean>;
  /** 仅在窗口失焦时通知（默认 true）。 */
  suppressWhenFocused: boolean;
  /** 外部 Agent CLI hook 主开关（R6.5，默认关 —— 用户全局配置是客人的家，须显式同意）。
   *
   * 本域只持有该**主开关意图**：文件的安装/卸载由 agent 域承担（`agent_hooks_apply` 命令 →
   * `agent/hooks/install/`），前端在保存设置后串行触发。核心域不 import 业务域，
   * 故此处刻意不写具体落点函数名 —— 联动契约见
   * `.trellis/spec/backend/agent-hooks-domain.md`「两个开关的分工」。
   *
   * **逐 CLI 例外不在这里**：`{"claude": false}` 这类业务身份属于 agent 域，
   * 落在 config.json 的 `agentHookSources` 键（见 `agent/hooks/install/config/settings.rs`
   * 的分工说明）—— 写进本类型会让核心域出现 CLI 名字（父任务 design T4 禁止的形态）。 */
  cliHooks: boolean;
  /** 节流与合并窗口（秒）——UI 高级项。 */
  throttleSecs: number;
  mergeWindowSecs: number;
  /** 通知正文最大字符数。 */
  bodyMaxChars: number;
}

/** 设置页的事件行清单（数据驱动：新业务/新事件 = 加一行数据，组件逻辑零改动）。
 * 事件键与 `src-tauri/src/agent/chat/notify.rs::event_keys` 常量一一对应。 */
export const NOTIFIABLE_EVENTS = [
  { key: 'agent.approval_requested', label: 'Agent 等待审批' },
  { key: 'agent.input_requested', label: 'Agent 等待输入' },
  { key: 'agent.turn_completed', label: 'Agent 任务完成' },
  { key: 'agent.session_failed', label: 'Agent 会话异常' },
] as const;

/** 单个 CLI 的 hook 安装状态（镜像 Rust `agent::hooks::writers::HookInstallStatus`，camelCase）。 */
export interface HookInstallStatus {
  /** CLI 标识 —— 与后端 `targets::HookTarget.source` 同源（路由段与展示名同一个事实）。 */
  source: string;
  path: string;
  installed: boolean;
  versionCurrent: boolean;
  /**
   * CLI 侧信任态（镜像 Rust `HookInstallStatus::trusted`）：
   * - `null` = 该 CLI 无信任概念（无需展示）；
   * - `true` = 需要且已确认；
   * - `false` = **已安装但用户还没在 CLI 里确认** → 该面功能不生效。
   *
   * 目前只有 Codex 的 `hooks.json` 面（审批通知）需要：Codex 会对未信任的 hook
   * 静默跳过且不报错，必须在 UI 上如实提示，否则又是「装了但没通知」。
   */
  trusted: boolean | null;
}

/**
 * hook 应用结果状态（镜像 Rust `HookApplyStatus`，snake_case 序列化）。
 *
 * 机器可读枚举是双端唯一判据 —— 前端禁止再按英文散文子串分类（后端改个词就会静默错分类）。
 */
export type HookApplyStatus = 'applied' | 'unchanged' | 'removed' | 'skipped' | 'failed';

/** 单个 CLI 的 hook 应用回执（镜像 Rust `HookApplyOutcome`，camelCase）。 */
export interface HookApplyOutcome {
  source: string;
  status: HookApplyStatus;
  /** 人类可读补充（失败/跳过缘由；正常时为空串）。 */
  detail: string;
}

/** 默认设置（与后端 `NotificationSettings::default()` 同步）。 */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  actionRequired: true,
  completed: true,
  failed: true,
  eventOverrides: {},
  suppressWhenFocused: true,
  cliHooks: false,
  throttleSecs: 2,
  mergeWindowSecs: 3,
  bodyMaxChars: 200,
};
