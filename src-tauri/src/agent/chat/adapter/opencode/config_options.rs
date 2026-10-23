//! serve 的 `configOptions` 投影 —— 把两版的 agent / 思考等级来源收敛成
//! 前端已经在消费的 `SessionConfigOption` 形状。
//!
//! # 为什么需要这一层
//!
//! serve 的这两项能力**不是**会话配置项（协议里没有 `configOptions` 这个概念）：
//!
//! | 能力 | 1.19 | 2.0 |
//! | --- | --- | --- |
//! | plan / build | `prompt_async` 的 `agent` 字段 | `POST /api/session/{id}/agent` |
//! | 思考等级 | per-prompt `variant`（随 Turn 下发） | `Model.Ref.variant`（随切模型下发） |
//!
//! 但前端工具条只认 `SessionConfigOption`（`category: "mode"` / `"thought_level"`），
//! 且这套形状已被 ACP 与 Pi 用熟。所以这里做**投影**：读侧把能力说成配置项，
//! 写侧由 `request.rs` 翻译回各协议的真实通道。
//!
//! # 两条不变式
//!
//! 1. **列出即能写**：`options` 里的每个 value 都必须有对应的写通道。列出来却
//!    写不进去 = 「显示了但点了没反应」，比不显示更糟。
//! 2. **当前值必须真实**：`currentValue` 来自会话状态（`get_state` 的 agent /
//!    已选模型的 variant），不是本地猜的。

use crate::agent::chat::adapter::session_config::{
    SessionConfigOption, SessionConfigSelectOption, SessionConfigSelectOptions, SessionConfigValue,
    CATEGORY_MODE, CATEGORY_THOUGHT_LEVEL,
};

/// 思考等级配置项的 `id`（也是 `set_config_option` 的 `configId`）。
pub(super) const THOUGHT_LEVEL_ID: &str = "thought_level";
/// 模式配置项的 `id`。
pub(super) const MODE_ID: &str = "mode";

/// opencode 的 primary agent → 用户可见的模式。
///
/// # 为什么是静态表而不是从 `/api/agent` 读
///
/// - **2.0 的 `/api/agent` 返回空数组**（实测：内置 agent 不再经此端点暴露），
///   所以 V2 根本读不到；
/// - 1.19 的 `/agent` 有 10 个，其中 `compaction` / `summary` / `title` 是内部用途，
///   列给用户只会让人误选。
///
/// 所以「用户可见的模式」就是 build / plan 两个 —— 这是 opencode 的**产品语义**，
/// 不是版本差异。两版共用同一张表。
///
/// 实测两版都接受这两个名字：2.0 的 `POST /api/session/{id}/agent` 返回 204 且
/// 随后 `session.step.started.data.agent == "plan"`；1.19 的 prompt 带
/// `agent: "plan"` 同样生效。
const VISIBLE_MODES: &[(&str, &str)] = &[("build", "Build"), ("plan", "Plan")];

/// 构造模式配置项。
///
/// `current` 来自会话状态（`get_state` 的 agent 字段），取不到时用 `build`
/// —— 那是 opencode 的默认 agent（1.19 的 `/agent` 里 `build` 的 description
/// 就写着「The default agent」）。
pub(super) fn mode_option(current: Option<&str>) -> SessionConfigOption {
    let current = current.unwrap_or("build");
    // 未知 agent 名（用户自定义的 primary agent）也列进去，否则会被静默重置成 build。
    let mut items: Vec<SessionConfigSelectOption> = VISIBLE_MODES
        .iter()
        .map(|(value, name)| SessionConfigSelectOption {
            value: (*value).to_string(),
            name: (*name).to_string(),
            description: None,
            group: None,
        })
        .collect();
    if !items.iter().any(|i| i.value == current) {
        items.push(SessionConfigSelectOption {
            value: current.to_string(),
            name: current.to_string(),
            description: None,
            group: None,
        });
    }

    SessionConfigOption {
        id: MODE_ID.into(),
        name: "Mode".into(),
        description: None,
        category: Some(CATEGORY_MODE.into()),
        kind: Some("select".into()),
        current_value: Some(SessionConfigValue::Text(current.to_string())),
        options: Some(SessionConfigSelectOptions::Ungrouped(items)),
        _meta: None,
    }
}

/// 构造思考等级配置项，**选项来自当前模型**。
///
/// # 为什么必须按模型取
///
/// 实测 2.0：133 个模型里 **114 个**有 `variants`，且取值集合不同
/// （多数是 `low/medium/high/xhigh/max`，部分只有 `off`，部分没有）。
/// 用一份固定清单会让「这个模型不支持 high」变成运行期静默失败。
///
/// 返回 `None` 表示该模型没有档位 —— 调用方据此**不渲染**控件
/// （显示一个点不动的下拉比不显示更糟）。
pub(super) fn thought_level_option(
    variants: &[String],
    current: Option<&str>,
) -> Option<SessionConfigOption> {
    if variants.is_empty() {
        return None;
    }
    let options: Vec<SessionConfigSelectOption> = variants
        .iter()
        .map(|v| SessionConfigSelectOption {
            value: v.clone(),
            name: display_level(v),
            description: None,
            group: None,
        })
        .collect();
    // 当前值优先用会话回报的 variant；缺省用第一个（2.0 的 variants[0] 通常是最低档）。
    let current = current
        .filter(|c| variants.iter().any(|v| v == c))
        .unwrap_or(&variants[0]);
    Some(SessionConfigOption {
        id: THOUGHT_LEVEL_ID.into(),
        name: "Thinking level".into(),
        description: None,
        category: Some(CATEGORY_THOUGHT_LEVEL.into()),
        kind: Some("select".into()),
        current_value: Some(SessionConfigValue::Text(current.to_string())),
        options: Some(SessionConfigSelectOptions::Ungrouped(options)),
        _meta: None,
    })
}

/// 档位 id → 展示名。未知值原样返回（新增档位名只是少个好看的名字，不是错误）。
fn display_level(value: &str) -> String {
    match value {
        "off" => "Off".to_string(),
        "low" => "Low".to_string(),
        "medium" => "Medium".to_string(),
        "high" => "High".to_string(),
        "xhigh" => "Extra high".to_string(),
        "max" => "Max".to_string(),
        other => other.to_string(),
    }
}

/// 从 `GET /api/model` 的响应里取某个模型的 `variants[].id`。
///
/// 匹配用 `(providerID, modelID|id)` 二元组 —— 同一模型会出现在多个 provider 下
/// （实测 133 条里有重复的 `modelID`），只按 modelID 匹配会取错 provider 的档位。
pub(super) fn variants_of_model(
    json: &serde_json::Value,
    provider_id: &str,
    model_id: &str,
) -> Vec<String> {
    json.get("data")
        .and_then(|v| v.as_array())
        .and_then(|items| {
            items.iter().find(|item| {
                let p = item.get("providerID").and_then(|v| v.as_str());
                let m = item
                    .get("modelID")
                    .and_then(|v| v.as_str())
                    .or_else(|| item.get("id").and_then(|v| v.as_str()));
                p == Some(provider_id) && m == Some(model_id)
            })
        })
        .and_then(|item| item.get("variants"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.get("id").and_then(|i| i.as_str()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

// ── 配置项状态：唯一真相 ───────────────────────────────────────────────────

/// serve 会话的配置项状态。
///
/// # 为什么需要一个状态类型（而不是每次重算）
///
/// 配置项 = **可选项集合** × **当前值**，两部分的**变化时机不同**：
///
/// | 部分 | 何时变 | 来源 |
/// | --- | --- | --- |
/// | 思考等级的候选值 | 换模型时 | `GET /api/model` 的 `variants[]` |
/// | 当前 agent | 用户点选 / agent 自述 | `session.step.started.data.agent` |
/// | 当前 variant | 用户点选 / agent 自述 | `session.step.started.data.model.variant` |
///
/// 原实现在 `create` / `resume` 时算一次就再也不更新，于是：
/// - `resume` 一个曾切到 plan 的会话 → UI 显示 build（当前值靠猜）；
/// - 切到档位更少的模型 → 下拉仍列旧档位，选了静默失败（**违反「列出即能写」**）。
///
/// 收成一个类型后，「当前值从哪来」只有一处答案，两个消费点（构造 / 回推）
/// 共用同一份状态。
/// serve 认识的配置项种类。**写通道与状态更新共用这个枚举**。
///
/// 它是 `configId` 的类型化表示：新增一项必须在这里加 variant，
/// 于是编译器会强制回答「它怎么改状态」与「它怎么写到 serve」。
///
/// # 为什么需要它（而不是两处 `match &str`）
///
/// 上一版 `apply(config_id: &str) -> bool` 与写通道的
/// `match config_id { MODE_ID => …, THOUGHT_LEVEL_ID => …, _ => unreachable!() }`
/// 靠**约定**保持一致。新增配置项时只要漏改一处，`unreachable!` 就会在生产
/// 环境 panic（前端发来一个「`apply` 认了但写通道不认」的 id）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ConfigKind {
    /// plan / build（2.0 有即时端点，1.x 随 prompt）
    Mode,
    /// 思考等级（V2 = `Model.Ref.variant`；V1 随 prompt）
    ThoughtLevel,
}

#[derive(Debug, Clone)]
pub(super) struct ConfigState {
    /// 当前 agent（build / plan / 自定义）。
    pub(super) agent: String,
    /// 当前思考等级（`None` = 未知或该模型无档位）。
    pub(super) variant: Option<String>,
    /// 当前模型的档位候选（来自 `/api/model`）。
    pub(super) variants: Vec<String>,
    /// 当前模型（`provider/model` 复合串）。
    ///
    /// # 两个用途，都是必需的
    ///
    /// 1. **避免热路径重拉**：`Turn` 每轮都带 `model_id`，但绝大多数轮次模型
    ///    没变。记下来后模型没变 → 零 HTTP（`/api/model` 实测 133 条、数十 KB）。
    /// 2. **让档位可以立即生效**：2.0 的档位是 `Model.Ref.variant`，改档位必须
    ///    连模型一起 `POST .../model`。不知道当前模型就没法立即写 ——
    ///    只能记下来等下一轮，而用户会看到「点了没反应」。
    ///
    /// 实测（2.0.32）：同模型只改 variant 的 `POST .../model` 返回 204，
    /// 且下一轮 `step.started.model.variant` 立即是新值。
    pub(super) model: Option<String>,
}

impl Default for ConfigState {
    fn default() -> Self {
        Self {
            // opencode 的默认 agent（1.19 的 `/agent` 里 build 的 description
            // 就写着「The default agent」）。
            agent: "build".to_string(),
            variant: None,
            variants: Vec::new(),
            model: None,
        }
    }
}

impl ConfigState {
    /// 按当前状态构造完整配置项列表。
    ///
    /// **这是唯一的构造入口** —— 初建、切模型后刷新、写回后回推，都走它。
    /// 多处构造必然漂移（`currentValue` 与 `options` 来自不同快照是这类 bug 的典型）。
    pub(super) fn to_options(&self) -> Vec<SessionConfigOption> {
        let mut out = vec![mode_option(Some(&self.agent))];
        if let Some(opt) = thought_level_option(&self.variants, self.variant.as_deref()) {
            out.push(opt);
        }
        out
    }

    /// 解析一个 `configId` 为本模块认识的配置项。
    ///
    /// # 为什么返回枚举而不是 `apply` 直接改状态
    ///
    /// 上一版 `apply(config_id, value) -> bool` 与写通道的
    /// `match config_id { MODE_ID => …, THOUGHT_LEVEL_ID => …, _ => unreachable!() }`
    /// 靠**约定**保持一致：两处都拿 `&str` 比常量。新增一个配置项时，只要忘记
    /// 同步其中一处，`unreachable!` 就会在**生产环境 panic**（前端发来一个
    /// 后端「认识常量但不认识值」的 id）。
    ///
    /// 返回 `ConfigKind` 后，写通道 `match` 的是枚举 —— 新增 variant 会让编译器
    /// 指出所有未处理的分支。这才是「协议差异只有一个来源」在类型层的落点。
    pub(super) fn kind_of(config_id: &str) -> Option<ConfigKind> {
        match config_id {
            MODE_ID => Some(ConfigKind::Mode),
            THOUGHT_LEVEL_ID => Some(ConfigKind::ThoughtLevel),
            _ => None,
        }
    }

    /// 用户点了某一项 → 更新状态。
    ///
    /// 只改状态，不做 IO —— 写通道由 `request.rs` 负责。这样「状态怎么变」
    /// 与「怎么发请求」解耦，两条路径（用户点选 / agent 自述）复用同一个更新点。
    pub(super) fn apply(&mut self, kind: ConfigKind, value: &str) {
        match kind {
            ConfigKind::Mode => self.agent = value.to_string(),
            ConfigKind::ThoughtLevel => self.variant = Some(value.to_string()),
        }
    }

    /// 按**新模型**刷新档位候选，并修正当前值。
    ///
    /// # 为什么必须重拉（`列出即能写` 的落点）
    ///
    /// `variants` 是**模型属性**：实测 133 个模型里 114 个有 variants，且集合不同
    /// （多数 `low/medium/high/xhigh/max`，部分只有 `off`，部分没有）。
    ///
    /// 切模型后不重拉会有两个后果，都违反不变式：
    /// - 下拉仍列旧档位 → 用户选了一个新模型不支持的档位，**写了但静默失效**；
    /// - 新模型支持的档位不出现 → 功能缺失。
    ///
    /// 返回 `true` 表示候选值或当前值有变化（调用方据此决定是否回推）。
    pub(super) fn refresh_variants(&mut self, variants: Vec<String>, model_id: &str) -> bool {
        self.model = Some(model_id.to_string());
        if self.variants == variants {
            return false;
        }
        self.variants = variants;
        // 当前档位若不在新候选里，回落到第一个 —— 留一个非法值会让
        // `thought_level_option` 的 `current` 与 `options` 不一致。
        if let Some(current) = self.variant.as_deref() {
            if !self.variants.iter().any(|v| v == current) {
                self.variant = self.variants.first().cloned();
            }
        } else {
            self.variant = self.variants.first().cloned();
        }
        true
    }

    /// 这个模型是否需要重拉档位候选（即与已缓存的不同）。
    ///
    /// 热路径上的短路：模型没变就不发 HTTP。
    pub(super) fn needs_variants_for(&self, model_id: &str) -> bool {
        self.model.as_deref() != Some(model_id)
    }

    /// 从 `session.step.started` 学**真实**的 agent / variant。
    ///
    /// # 为什么必须从事件学而不是查会话
    ///
    /// 实测 2.0 的 `GET /api/session/{id}` **不含** agent / model 字段
    /// （只有 `cost / id / location / projectID / subpath / time / title / tokens`）。
    /// 而 `session.step.started` 的 `data` 里有：
    ///
    /// ```jsonc
    /// {"agent":"plan","model":{"id":"…","providerID":"opencode","variant":"high"}}
    /// ```
    ///
    /// 这是**唯一**能拿到「这一轮实际在用什么」的通道，也是用户切档位后
    /// 验证生效的判据。没有它，`resume` 只能猜 `build`。
    ///
    /// 返回 `true` 表示状态有变化（调用方据此决定是否回推）。
    pub(super) fn learn_from_step(&mut self, data: &serde_json::Value) -> bool {
        let mut changed = false;
        if let Some(agent) = data.get("agent").and_then(|v| v.as_str()) {
            if !agent.is_empty() && self.agent != agent {
                self.agent = agent.to_string();
                changed = true;
            }
        }
        if let Some(model) = data.get("model") {
            if let Some(variant) = model.get("variant").and_then(|v| v.as_str()) {
                if self.variant.as_deref() != Some(variant) {
                    self.variant = Some(variant.to_string());
                    changed = true;
                }
            }
        }
        changed
    }
}

/// 按模型拉取档位候选值。**唯一的实现点**。
///
/// # 为什么放在这里而不是 adapter
///
/// 两处需要它：`create`/`resume` 的初值探测，以及切模型后的刷新。
/// 分两份实现会让「匹配规则」（`(providerID, modelID)` 二元组）出现两遍 ——
/// 那是同一个 bug 的两个潜在入口。
///
/// 返回 `None` 表示拉取失败（调用方保留旧候选值，不阻断主流程）。
pub(super) async fn fetch_variants(
    client: &reqwest::Client,
    models_path: &str,
    base_url: &str,
    model_id: &str,
) -> Option<Vec<String>> {
    let (provider, bare) = super::protocol::model_slug_split(model_id);
    if provider.is_empty() {
        return None;
    }
    let url = format!("{base_url}{models_path}");
    let json = super::connection::fetch_json(client, &url).await?;
    let variants = variants_of_model(&json, &provider, &bare);

    // 「模型确实没档位」与「匹配不到这个模型」都会得到空数组，但后果不同：
    // 前者是正常的（不渲染控件），后者是**契约漂移**（模型在列表里却匹配不上，
    // 说明两处的 id 取值规则不一致 —— `models_from_api_response` 与
    // `variants_of_model` 必须用同一套规则）。
    //
    // 无法从返回值区分时，用「模型总数 > 0 但匹配为空」作为告警判据：
    // 那几乎只可能是规则漂移，而不是所有模型都没档位。
    if variants.is_empty() {
        let total = json
            .get("data")
            .and_then(|v| v.as_array())
            .map_or(0, Vec::len);
        if total > 0 {
            log::debug!(
                "[ServeAdapter] no variants for {provider}/{bare} among {total} models; \
                 the id rules of models_from_api_response and variants_of_model may have drifted"
            );
        }
    }
    Some(variants)
}
