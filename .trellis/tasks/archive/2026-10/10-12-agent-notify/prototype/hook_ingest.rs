//! 原型 —— 源 B：外部 Agent CLI hook 摄入
//! （实施落点：`src-tauri/src/agent/hooks/{endpoint,server,attribution,notify}.rs`）。
//!
//! 设计依据：design.md §2.5（数据流/坐标发现/归属策略 D8）、§3（D7/D11）。
//! 参考 orca 已验证模式：endpoint 文件跨重启坐标发现、随机 token、fail-open 204、回调前重读。
//!
//! ⚠️ server/endpoint 部分是集成形态示意（HTTP 栈实施期选型，见 D7）；
//! attribution 与投影是**纯函数 + 完整单测**，实施时按 TDD 先迁 tests。

use std::path::{Path, PathBuf};
use std::time::Instant;

// ════════════════════════════════════════════════════════════════════════════
// 1. endpoint 文件发布（target: agent/hooks/endpoint.rs）
// ════════════════════════════════════════════════════════════════════════════

/// `~/.neeko/agent-hooks/endpoint.env`（POSIX 0600；Windows 同内容 `endpoint.cmd`，
/// `set KEY=VALUE` 行格式 —— 平台差异按红线 10 落 platform 层或本文件平台分支）。
///
/// 契约：
/// - 每次 Neeko 启动重写（随机端口 bind :0 + 随机 token uuid-v4）；
/// - 临时文件 + 原子 rename，防 hook 读到半截文件；
/// - 退出时**不删除**（下次启动覆盖；删除会制造重启窗口期回调失败）。
pub struct EndpointPublication {
    pub port: u16,
    pub token: String,
    pub path: PathBuf,
}

impl EndpointPublication {
    /// 内容即契约（hook 模板逐行解析，见 prototype/hooks/*.js|ts）：
    /// WSL 场景增补 HOST 行（design.md §7 WSL 风险），local 场景 hook 直接用 127.0.0.1。
    pub fn render(&self) -> String {
        format!(
            "NEEKO_AGENT_HOOK_PORT={}\nNEEKO_AGENT_HOOK_TOKEN={}\n",
            self.port, self.token
        )
    }

    pub fn publish(&self) -> std::io::Result<()> {
        // 示意：tempfile 同目录 → write 0600 → rename 原子替换。
        // 实施期用既有文件设施；本函数是启动序列（agent::boot）的一步，失败只 warn 不阻断启动。
        unimplemented!("prototype sketch")
    }
}

// ════════════════════════════════════════════════════════════════════════════
// 2. 归属（target: agent/hooks/attribution.rs）—— 纯函数，D8 降级链
// ════════════════════════════════════════════════════════════════════════════

/// hook 上报携带的环境提示（Neeko 自有 PTY/会话启动时注入的 env，被 hook 原样回传）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EnvHints {
    /// `NEEKO_SESSION_ID`：命中即精确归属到既有会话实例（源 A/B 同 instance，天然去重）。
    pub neeko_session_id: Option<String>,
    /// `NEEKO_PROJECT_ID`：辅助提示。
    pub project_id: Option<String>,
}

/// 归属决策所需的项目视图（从既有 ProjectStore 取的只读快照 —— 复用，不新建索引）。
#[derive(Clone, Debug)]
pub struct ProjectRef {
    pub project_id: String,
    pub project_name: String,
    /// 项目根（含 worktree 单元根，匹配时逐一试）。
    pub roots: Vec<PathBuf>,
}

/// 归属产物：核心域 SourceRef 所需的实例与分组身份 + 回流辅助。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attribution {
    /// 源 B 实例 id：精确归属时 = neeko session id；否则 `cli:{agent_session_id}`。
    pub instance_id: String,
    pub group_label: String,
    /// 归属到的项目（basename 兜底时为 None）→ 前端尽力回流用（D9）。
    pub project_id: Option<String>,
}

/// 归属降级链（D8）：env 注入 → cwd 反查项目（最长前缀胜出）→ cwd basename 兜底。
/// 宁多归属不丢事件（与 orca「无 paneKey 即丢弃」相反的显式产品决策）。
pub fn attribute(
    agent_session_id: &str,
    cwd: Option<&str>,
    hints: &EnvHints,
    projects: &[ProjectRef],
) -> Attribution {
    // 1) env 注入命中：精确归属（源 A 同一 instance_id → 跨源节流/去重自动生效）
    if let (Some(sid), Some(pid)) = (&hints.neeko_session_id, &hints.project_id) {
        let name = projects
            .iter()
            .find(|p| &p.project_id == pid)
            .map(|p| p.project_name.clone())
            .unwrap_or_else(|| "Neeko".to_string());
        return Attribution { instance_id: sid.clone(), group_label: name, project_id: Some(pid.clone()) };
    }

    // 2) cwd 反查：对每个项目 root 做路径前缀匹配，取最长命中（worktree 嵌套时更精确）
    if let Some(cwd) = cwd {
        let cwd_path = Path::new(cwd);
        let best = projects.iter().filter_map(|p| {
            p.roots
                .iter()
                .filter(|root| cwd_path.starts_with(root))
                .map(|root| (root.components().count(), p))
                .max_by_key(|(depth, _)| *depth)
        }).max_by_key(|(depth, _)| *depth);
        if let Some((_, project)) = best {
            return Attribution {
                instance_id: format!("cli:{agent_session_id}"),
                group_label: project.project_name.clone(),
                project_id: Some(project.project_id.clone()),
            };
        }
        // 3) basename 兜底（仍通知，group 用目录名）
        let base = cwd_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| cwd.to_string());
        return Attribution { instance_id: format!("cli:{agent_session_id}"), group_label: base, project_id: None };
    }

    // 无 cwd 无 hints：最弱兜底，仍不丢事件
    Attribution { instance_id: format!("cli:{agent_session_id}"), group_label: "终端会话".into(), project_id: None }
}

// ════════════════════════════════════════════════════════════════════════════
// 3. hook payload → NotificationSignal 投影（target: agent/hooks/notify.rs）
// ════════════════════════════════════════════════════════════════════════════
//
// event_key 与源 A 同命名空间（复用 agent/chat/notify.rs 的 event_keys 常量）：
// 同一节流/合并/设置键自动生效 —— 这是 T4 开集架构的直接收益。
// 未知事件 → None（fail-open，hook 面版本漂移不产生错误噪音）。

use crate::agent::chat::notify::event_keys; // 单一常量源（红线 5 精神）
use crate::notification::{NotificationClass, NotificationSignal, SourceRef};

/// ingest server 解析鉴权后的规范化上报（字段白名单，未知字段在 server 层已丢弃）。
#[derive(Clone, Debug)]
pub struct HookEnvelope {
    /// hook 路由段：`/hook/{source}`，白名单 "pi" | "opencode"。
    pub source: String,
    /// agent 侧会话 id（payload 内），归属 instance 的原料。
    pub agent_session_id: String,
    /// CLI 事件名（opencode: session.idle / permission.updated / session.error；
    /// pi: agent_end / ask / error —— 实施期以官方文档实测为准，writers 内登记版本）。
    pub event: String,
    pub cwd: Option<String>,
    pub hints: EnvHints,
    /// 人类可读细节（如 permission 的标题），可缺省；截断交给核心域。
    pub detail: Option<String>,
}

pub fn project(envelope: &HookEnvelope, attribution: &Attribution) -> Option<NotificationSignal> {
    // CLI 事件名 → (class, event_key, label)。按 source 分支是 payload 格式知识，
    // 合法地留在 agent 域的 hooks 投影里（核心域依然零分支）。
    let (class, key, label) = match (envelope.source.as_str(), envelope.event.as_str()) {
        ("opencode", "session.idle") => (NotificationClass::Completed, event_keys::TURN_COMPLETED, "任务完成"),
        ("opencode", "permission.updated") => (NotificationClass::ActionRequired, event_keys::APPROVAL_REQUESTED, "Agent 等待审批"),
        ("opencode", "session.error") => (NotificationClass::Failed, event_keys::SESSION_FAILED, "会话异常终止"),
        ("pi", "agent_end") => (NotificationClass::Completed, event_keys::TURN_COMPLETED, "任务完成"),
        ("pi", "ask") => (NotificationClass::ActionRequired, event_keys::APPROVAL_REQUESTED, "Agent 等待审批"),
        ("pi", "error") => (NotificationClass::Failed, event_keys::SESSION_FAILED, "会话异常终止"),
        _ => return None, // 未知事件 fail-open：不通知、不报错
    };

    Some(NotificationSignal {
        source: SourceRef {
            domain: "agent",
            instance_id: attribution.instance_id.clone(),
            // 文案区分来源形态，仍是纯数据
            origin_label: format!("{} (CLI)", envelope.source),
            group_label: attribution.group_label.clone(),
        },
        class,
        event_key: key.to_string(),
        event_label: label.to_string(),
        detail: envelope.detail.clone().filter(|d| !d.trim().is_empty()),
    })
}

// ════════════════════════════════════════════════════════════════════════════
// 4. ingest server（target: agent/hooks/server.rs）—— 集成形态示意
// ════════════════════════════════════════════════════════════════════════════
//
// 硬约束（T5/D7）：
// - 只绑 `127.0.0.1`，端口随机（bind :0），实际端口写 endpoint 文件；
// - 每请求校验 `x-neeko-agent-hook-token`（每次启动随机 uuid，仅内存）：不符 → 403 + warn；
// - **一切异常路径都 fail-open**：畸形 body / 未知 source / 未知事件 → 204，绝不 5xx
//   （5xx 会让 hook 脚本重试或报错，违背「不阻塞用户 agent」）；
// - 请求体大小上限（如 64KB）+ 读写超时（slowloris 防护，orca 同款）；
// - 载荷字段白名单反序列化，未知字段丢弃（隐私面收敛，§7）；
// - 处理成功 → attribution（纯函数）→ project（纯函数）→ NotificationCenter.observe()
//   （instance_visible：源 B 无对应 UI 会话时恒 false —— 外部终端本来就不在 Neeko 里可见；
//     精确归属命中自有会话时，复用源 A 的可见性判定）；
// - server 生命周期挂 agent::boot / app close 协议（独立 tokio 任务，不经命令执行接口 ——
//   基础设施豁免，文件内注释说明，红线 1 边界清单登记）。
//
// ```rust
// async fn handle_hook(
//     state: Arc<IngestState>,          // token + center + projects 快照 provider
//     source: String,                    // 路由段
//     headers: HeaderMap,
//     body: Bytes,
// ) -> StatusCode {
//     if headers.get(TOKEN_HEADER).and_then(|v| v.to_str().ok()) != Some(&state.token) {
//         log::warn!("[agent-hooks] bad token from {source}");
//         return StatusCode::FORBIDDEN;
//     }
//     // 白名单反序列化失败 → 204（fail-open）
//     let Ok(envelope) = parse_envelope(&source, &body) else { return StatusCode::NO_CONTENT };
//     let projects = state.projects_snapshot();
//     let attribution = attribute(&envelope.agent_session_id, envelope.cwd.as_deref(), &envelope.hints, &projects);
//     if let Some(signal) = project(&envelope, &attribution) {
//         let settings = state.settings();
//         state.center.observe(&state.app, signal, /* instance_visible */ false, &settings);
//     }
//     StatusCode::NO_CONTENT
// }
// ```

// ════════════════════════════════════════════════════════════════════════════
// TDD：归属与投影单测（实施时先行迁移，Red → Green）
// ════════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    fn projects() -> Vec<ProjectRef> {
        vec![
            ProjectRef {
                project_id: "p1".into(),
                project_name: "neeko".into(),
                roots: vec![PathBuf::from("/Users/tomgs/workspaces/neeko")],
            },
            ProjectRef {
                project_id: "p2".into(),
                project_name: "orca-study".into(),
                roots: vec![
                    PathBuf::from("/Users/tomgs/workspaces/orca"),
                    PathBuf::from("/Users/tomgs/workspaces/orca-wt/feature-x"), // worktree 单元
                ],
            },
        ]
    }

    /// 降级链第 1 级：env 注入命中 → 精确归属（instance = neeko session，与源 A 同键去重）。
    #[test]
    fn env_hint_wins_over_cwd() {
        let hints = EnvHints { neeko_session_id: Some("s42".into()), project_id: Some("p1".into()) };
        let a = attribute("agent-xyz", Some("/tmp/whatever"), &hints, &projects());
        assert_eq!(a.instance_id, "s42");
        assert_eq!(a.group_label, "neeko");
        assert_eq!(a.project_id.as_deref(), Some("p1"));
    }

    /// env 提示了未知 project_id → 不 panic，group 落通用名。
    #[test]
    fn env_hint_with_unknown_project_degrades_gracefully() {
        let hints = EnvHints { neeko_session_id: Some("s42".into()), project_id: Some("ghost".into()) };
        let a = attribute("agent-xyz", None, &hints, &projects());
        assert_eq!(a.group_label, "Neeko");
    }

    /// 降级链第 2 级：cwd 前缀反查项目。
    #[test]
    fn cwd_maps_to_project() {
        let a = attribute("agent-1", Some("/Users/tomgs/workspaces/neeko/src-tauri"), &EnvHints::default(), &projects());
        assert_eq!(a.instance_id, "cli:agent-1");
        assert_eq!(a.group_label, "neeko");
        assert_eq!(a.project_id.as_deref(), Some("p1"));
    }

    /// worktree 单元 root 命中优先于更短前缀（最长匹配胜出）。
    #[test]
    fn longest_prefix_wins_for_worktrees() {
        let ps = projects();
        let a = attribute("agent-2", Some("/Users/tomgs/workspaces/orca-wt/feature-x/src"), &EnvHints::default(), &ps);
        assert_eq!(a.group_label, "orca-study");
        assert_eq!(a.project_id.as_deref(), Some("p2"));
    }

    /// 降级链第 3 级：无匹配项目 → basename 兜底，**仍产生归属**（宁多归属不丢事件，D8）。
    #[test]
    fn unknown_cwd_falls_back_to_basename() {
        let a = attribute("agent-3", Some("/home/user/scratch-project"), &EnvHints::default(), &projects());
        assert_eq!(a.group_label, "scratch-project");
        assert_eq!(a.project_id, None);
        assert_eq!(a.instance_id, "cli:agent-3");
    }

    /// 无 cwd 无 hints：最弱兜底，不 panic、不丢事件。
    #[test]
    fn missing_everything_still_attributes() {
        let a = attribute("agent-4", None, &EnvHints::default(), &projects());
        assert_eq!(a.instance_id, "cli:agent-4");
        assert!(!a.group_label.is_empty());
    }

    fn envelope(source: &str, event: &str) -> HookEnvelope {
        HookEnvelope {
            source: source.into(),
            agent_session_id: "agent-1".into(),
            event: event.into(),
            cwd: Some("/Users/tomgs/workspaces/neeko".into()),
            hints: EnvHints::default(),
            detail: None,
        }
    }

    fn attribution() -> Attribution {
        Attribution { instance_id: "cli:agent-1".into(), group_label: "neeko".into(), project_id: Some("p1".into()) }
    }

    /// opencode/pi 的完成与审批事件投影到与源 A 相同的 event_key（跨源节流/设置键统一）。
    #[test]
    fn hook_events_share_event_key_namespace_with_pipeline_source() {
        let oc = project(&envelope("opencode", "session.idle"), &attribution()).unwrap();
        assert_eq!(oc.class, NotificationClass::Completed);
        assert_eq!(oc.event_key, event_keys::TURN_COMPLETED);
        assert_eq!(oc.source.domain, "agent");
        assert_eq!(oc.source.origin_label, "opencode (CLI)");
        assert_eq!(oc.source.group_label, "neeko");

        let pi = project(&envelope("pi", "ask"), &attribution()).unwrap();
        assert_eq!(pi.class, NotificationClass::ActionRequired);
        assert_eq!(pi.event_key, event_keys::APPROVAL_REQUESTED);
        assert_eq!(pi.source.origin_label, "pi (CLI)");
    }

    /// 未知事件 / 未知 source → None（fail-open：hook 面版本漂移不产生噪音）。
    #[test]
    fn unknown_events_are_ignored() {
        assert!(project(&envelope("opencode", "message.part.updated"), &attribution()).is_none());
        assert!(project(&envelope("claude", "Stop"), &attribution()).is_none()); // 未接入的 CLI
    }

    /// detail 空白归一为 None（核心域落类别兜底文案）。
    #[test]
    fn blank_detail_normalized() {
        let mut e = envelope("pi", "error");
        e.detail = Some("   ".into());
        assert_eq!(project(&e, &attribution()).unwrap().detail, None);
    }
}
