//! 接入**形态**的契约类型：`InstallShape` + `TrustSpec` + `HookEntry`。
//!
//! # 为什么单独一个文件
//!
//! 这三个类型是「CLI 专属事实如何变成数据」的**全部词汇表**：
//! 数据表（`data.rs`）用它们描述每个 CLI，`writers/` 的每条腿按它们分派。
//! 它们此前与目录解析函数、事实表数据混在一个 757 行的文件里 —— 改一个类型要
//! 越过 300 行数据表才能看到影响面。
//!
//! # 红线 15 的落点
//!
//! 本文件不出现任何 CLI 名：CLI 差异一律体现为**字段值**（`settings_file` /
//! `root_key` / `entries` / `trust` / `config_file` / `key` / `event_key`）。

/// 「CLI 侧信任门」的探测规格。
///
/// 有的 CLI（Codex）要求**每条 hook 先被用户确认**才执行，未确认的条目被**静默跳过**
/// （实测见 `.trellis/spec/backend/agent-hooks-domain.md`「为什么不能代写信任哈希」）。确认记录由该 CLI
/// 写在自己的状态文件里 —— 这是**该 CLI 的私有契约**（键格式是未公开的内部序列化），
/// 故连同状态文件名一起作为**数据**携带：通用 `writers` / `trust` 只按规格执行，
/// 不知道任何 CLI 名，也不知道键长什么样。
///
/// 与 `data::HookTarget::dir` 同构：都是「把 CLI 专属事实做成数据/函数指针，通用层只消费」。
pub struct TrustSpec {
    /// 信任状态所在文件名（相对该 CLI 配置根；由数据表声明）。
    pub state_file: &'static str,
    /// 渲染某条 hook 的信任键。
    ///
    /// 入参：hooks 文件绝对路径、事件 snake_case 名、分组下标、组内 hook 下标。
    pub key: fn(shim: &str, event_snake: &str, group_idx: usize, hook_idx: usize) -> String,
    /// 把**键**渲染成状态文件里的**记录文本**（供「记录是否存在」的子串判定）。
    ///
    /// 为什么这也必须是数据：`[hooks.state."<key>"]` 只是 Codex 的私有形态
    /// （TOML 表头）。若把它写在通用探针里，加一个「信任记录是 JSON 键 / 裸行」的 CLI
    /// 就必须改 `trust.rs` —— 那正是「通用模块携带单个 CLI 身份」的反面教材。
    pub record: fn(key: &str) -> String,
}

/// 接入形态 —— 决定 writers 走哪条腿。策略集已知且固定 → `enum + match`（编译期穷尽），
/// 不用 `Box<dyn Trait>`（AGENTS.md 开闭原则）。
pub enum InstallShape {
    /// 独立文件即插拔：只写一个受管文件，绝不碰用户既有配置（opencode / pi / omp）。
    Standalone,
    /// 独立 shim 文件 + 结构化插入点：shim 仍是独立文件，
    /// 但需把 hook 条目插入用户既有的 `settings_file`（claude / codebuddy / qoder）。
    Structured {
        /// 用户配置文件名（claude/codebuddy/qoder = `settings.json`）。
        /// 是数据而非通用模块的 CLI 分支 —— 不同 CLI 的配置文件名不同这一事实只在这里声明。
        settings_file: &'static str,
        /// 配置里承载事件的**根键**（Claude 兼容面 = `hooks`）。
        ///
        /// 与 `settings_file` 同一取向：`merger` / `status` / `trust` 三处都需要知道
        /// 「事件挂在哪个根键下」，把它写死意味着一个「根键叫别的名字」的 CLI 必须改
        /// 三个通用模块。作为字段后，它随数据行走（红线 15 精神）。
        ///
        /// 注意与**条目内**的分组键 `hooks`（`{matcher?, hooks:[…]}` 的数组）区分：
        /// 那是 Claude 规范的条目 schema，不是本字段。
        root_key: &'static str,
        /// 要插入的条目（CLI 原生事件名 → 语义 event_key）。
        entries: &'static [HookEntry],
        /// 该面是否需要「CLI 侧信任确认」；`None` = 无需信任（claude/codebuddy/qoder）。
        ///
        /// 做成字段而非在 `writers` 里按文件名判断：**「哪个 CLI 的 hook 要过信任门」
        /// 是 CLI 事实，不是通用逻辑**。加一个新的受信任 CLI 只需在此声明规格，
        /// 通用模块零改动（开闭原则）。
        trust: Option<TrustSpec>,
    },
    /// **TOML 数组键**形态：把 shim 的 argv 写进 `config_file` 的 `key` 数组（Codex 的 `notify`）。
    ///
    /// 与 `Structured` 的差异是**语义**而非仅格式：
    /// - `Structured` 是「按事件名分组的嵌套对象，每个事件一条 matcher 组」—— 一个配置可携带多条；
    /// - 本形态是「**一条 argv**」（`[exe, arg1, ...]`，CLI 自行决定何时调用它）——
    ///   一个配置只能有一条，故不能向用户已有的值追加（见 `install::config::toml` 模块头）。
    ///
    /// 两者的合并算法与 fail-safe 判据都不同，故不能共用一个变体。
    /// 载荷投递也不同：`Structured` 的 CLI 把 JSON 给 stdin，Codex 把它追加为**最后一个 argv**。
    NotifyArgv {
        /// 用户配置文件名（Codex = `config.toml`）。
        config_file: &'static str,
        /// 承载 argv 的 TOML 键（Codex = `notify`）。
        key: &'static str,
        /// 该面承载的**唯一**语义 event_key。
        ///
        /// 为什么是数据而非在 `writers` 里按 `source` 分支：本形态的语义是「一条 argv，
        /// CLI 自行决定何时调用」—— 事件不由配置声明（Codex 只在 turn 完成时调它），
        /// 故一个面天然只对应一个语义键。把它作为字段携带，`writers` 就无需知道
        /// 「哪个 CLI 对应哪个事件」；加一行即接入，通用层零改动。
        event_key: &'static str,
    },
}

/// 一条结构化插入点：CLI 原生事件名 → 语义 event_key 的**纯数据映射**。
///
/// shim 通过 argv 收到 `event_key`，故 shim 不认识 `PermissionRequest` 这类原生名 ——
/// 翻译成本全部收敛在这张数据表里（父任务 design T9）。
pub struct HookEntry {
    /// CLI 原生事件名（该 CLI 配置 schema 的键，如 `"PermissionRequest"`）。
    pub native_event: &'static str,
    /// matcher 值；`None` = **不写该字段**（不是写空串 —— 见下方 U4 说明）。
    pub matcher: Option<&'static str>,
    /// 归一后的语义 event_key（与源 A 同命名空间，三层开关/节流自动生效）。
    pub event_key: &'static str,
}
