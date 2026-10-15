//! Git 冲突三态的数据模型（纯数据，无 I/O）。
//!
//! 真值来源是 index 的 unmerged stages（1/2/3），字段语义见 `design.md` §2.1：
//! `content == None` 表示**该 stage 不存在**（不是空文件），缺失 stage 绝不被归一为空串。

use serde::{Deserialize, Serialize};

/// 冲突类型：由 stage 存在性 + 路径分歧 + binary 显式分类（不是布尔）。
///
/// **不含 `BothDeleted`**：双方都删（DD）不产生 unmerged 条目（实测，`design.md` §0），
/// 因此永远不会进入本读路径；给它一个 variant 就是造一个不可达状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictKind {
    /// UU：双方改同文件（stage 1+2+3）。
    BothModified,
    /// AA：双方各自新增同名（stage 2+3，无 base）。
    BothAdded,
    /// DU / UD：一方删除，整文件二选一（删除不是内容）。
    ModifyDelete,
    /// rename/rename：三侧路径各不相同，行区间无意义。
    RenameRename,
    /// 任一侧含 NUL，不可文本合并。
    Binary,
}

impl ConflictKind {
    /// 是否可做区域级合并。
    ///
    /// **由决议语义决定**（`design.md` §0.1），不是实现能力限制：仅「双方都有实体内容」的
    /// `BothModified` / `BothAdded` 成立。把 `ModifyDelete` 算进来会让「选我方删除」写出
    /// 一个空文件（用户意图是删除）—— 即 T9。
    #[must_use]
    pub const fn is_region_mergeable(self) -> bool {
        matches!(self, Self::BothModified | Self::BothAdded)
    }
}

/// 冲突的一个阶段侧。
///
/// `content == None` = **该 stage 不存在**（合法状态，非错误）：DU 的 ours、UD 的 theirs、
/// AA 的 base、binary 的任意侧。缺失 stage **绝不允许**用默认值归一为空串。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConflictSide {
    /// 该侧路径（rename/rename 下三侧可不同）。
    pub path: Option<String>,
    /// 该侧内容；`None` = stage 缺失或 binary 不解码。
    pub content: Option<String>,
    /// 该侧内容的原始字节数（即使内容被载荷预算截断，仍报截断前大小）。
    pub size: u64,
    /// 是否二进制（前 8KB 含 `0x00`）。
    pub is_binary: bool,
    /// 内容是否因载荷预算被截断。
    pub truncated: bool,
}

/// 合并输出中的单个冲突区域（行区间 + 三侧候选）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MergeRegion {
    /// 区域 id（自 0 递增，决议时用于定位）。
    pub id: u32,
    /// 合并输出中的起始行（0-based）。
    pub merged_start: u32,
    /// 合并输出中的结束行（0-based 半开）。
    pub merged_end: u32,
    /// base 侧候选行。
    pub base_lines: Vec<String>,
    /// ours 侧候选行。
    pub our_lines: Vec<String>,
    /// theirs 侧候选行。
    pub their_lines: Vec<String>,
    /// base 侧原文起始行号（三栏对齐用）。
    pub base_start: u32,
    /// ours 侧原文起始行号（三栏对齐用）。
    pub our_start: u32,
    /// theirs 侧原文起始行号（三栏对齐用）。
    pub their_start: u32,
}

/// 一个冲突文件的完整三态视图（`get_conflict_stages` 的返回值）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConflictStages {
    /// 冲突文件路径（仓库相对）。
    pub path: String,
    /// 冲突类型。
    pub kind: ConflictKind,
    /// base 侧（stage 1）；缺失时为 `None`。
    pub ancestor: Option<ConflictSide>,
    /// ours 侧（stage 2）；缺失时为 `None`。
    pub ours: Option<ConflictSide>,
    /// theirs 侧（stage 3）；缺失时为 `None`。
    pub theirs: Option<ConflictSide>,
    /// 合并文本（仅 `is_region_mergeable` 且非 binary 时存在）。
    pub merged: Option<String>,
    /// 冲突区域列表（可区域合并时非空）。
    pub regions: Vec<MergeRegion>,
    /// 任一侧 / merged / regions 是否被载荷预算截断。
    pub truncated: bool,
    /// 是否可做区域级合并（= [`ConflictKind::is_region_mergeable`]）。
    ///
    /// **由后端在唯一构造点派生一次**（`probe::assemble_stages`），显式上 wire ——
    /// 前端不得按 `kind` 重算（那是同一条领域判据的第二份实现，改一处必漏另一处）。
    ///
    /// 也不能用「`merged` 是否为 `None`」反推：`merged` 是**派生展示数据**，它的存在与否由
    /// 载荷预算（`cap.rs`）支配而不是由语义支配。今日两者恰好同进退（cap 截断后总回填
    /// `Some(capped)`），但那是**巧合而非契约** —— 把语义判据搭在一个随时可能为了省预算
    /// 而改成「直接丢弃」的字段上，就是把正确性交给别人的优化决定。
    pub region_mergeable: bool,
}
