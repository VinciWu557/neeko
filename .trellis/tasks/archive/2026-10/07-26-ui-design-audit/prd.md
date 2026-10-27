# UI 设计审计与优化方案

## 目标

对 Neeko（统一管理多 AI CLI Agent 的专业 IDE 工具）做整体 UI 设计审计，输出问题清单与分阶段优化方案。  
**本任务只产出规划文档，不直接改代码。**

## 产品定位（约束）

- 产品定位：跨平台桌面 **专业 IDE 工具**，统一管理多 AI CLI Agent（本地 / WSL / SSH）
- 参考体验：Cursor / VS Code / Zed / JetBrains 的密度、层级、键盘优先、chrome 克制
- 技术现状：React 18 + Tailwind v4 + shadcn/ui + Islands Dock 布局 + 多主题 CSS 变量
- 约束：不破坏现有 dock / terminal / editor 工作流；优化需可分阶段落地

## 需求

1. 完成信息架构（IA）与布局地图梳理
2. 完成设计系统盘点：主题 token、spacing/radius、组件原语、使用一致性
3. 输出按 P0/P1/P2 分级的 UI/UX 问题清单（附文件证据）
4. 输出面向专业 IDE 的现代化优化方案（原则 + token + 组件规范 + 分阶段落地）
5. 明确应保留的优势，避免推倒重来
6. 沉淀 `design.md` 与 `implement.md`，供后续实现任务拆分

## 不在范围内

- 直接修改业务代码 / 样式实现
- 后端协议、Agent 运行时逻辑
- 全新视觉品牌重设计（logo / 营销站）

## 验收标准

- [x] 产出当前 UI 布局与 IA 地图
- [x] 产出设计系统一致性问题（含量化证据，含复测命令 design §8.1）
- [x] 产出 P0/P1/P2 问题清单（含路径证据）
- [x] 产出分阶段优化方案与验收标准（A–F ↔ 子任务映射 design §10.2）
- [x] 明确后续可拆分的实现子任务建议（8 个子任务 + 依赖图 + v1 cut，design §10）
- [x] 开放决策给默认推荐（Decision Log D1–D5，design §11）
- [x] 原型资产化索引（design §12，5 份任务内原型）
- [x] 跨任务边界声明（vs unified-task-hub，design §13）
- [x] 用户确认方案优先级与 Decision Log 后，再拆实现任务并 `task.py start`
      —— **本任务为 planning-only**（prd 开头：「本任务只产出规划文档，不直接改代码」）。
      该条是**规划阶段到实施阶段的交接动作**，交接物 = design.md §10.1 的 8 个子任务清单。
      2026-10-27 归档核验：产物侧**全部交付**（design 26.1K / implement 7.1K /
      5 份原型 / Decision Log D1–D5 / §10.1 子任务清单 / §10.3 依赖图 / §10.4 v1 cut）。
      实施侧状态见下方「归档结论」。

## 归档结论（2026-10-27）

**本任务已交付其全部承诺（规划产物），随本任务归档。**
但需明确区分两件事 —— 归档的是**规划**，不是**实施**：

| 侧 | 状态 |
| --- | --- |
| 规划产物 | ✅ 全部交付（design / implement / 5 份原型 / Decision Log / 子任务清单） |
| 实施（8 个子任务） | ❌ **一个都没建**（`ui-tokens-density` 等 8 个名字全仓零引用） |

**下一步（不在本任务范围）**：按 design.md §10.1 拆 8 个实现子任务并 `task.py start`。
子任务清单在 `design.md` §10.1（ID / 范围 / 依赖 / v1 标记），依赖图 §10.3，v1 边界 §10.4。

**一处已发生的实施**：`implement.md` 头部「✅ 已实施：CSS 架构优化（2026-08-07）」——
`src/styles/` 分层重构（`tokens/` → `base/base.css` → `components/` 9 文件）+
token 修复（`--accent-orange` / `--font-mono` / `--accent-foreground`）+ 硬编码消除。
这一段是本任务唯一落地到代码的部分，**不是** §10.1 八个子任务中的任何一个。

**`subtasks` 字段清理**：原 `subtasks` 数组里 8 个名字是**未创建**的计划名。
`subtasks` 是 `children` 的旧拼写，语义是「真实存在的子任务引用」——
留着会造成和上一轮 `10-16-notify-review-remediation` 一样的悬空引用
（`task.py` 会反复解析不存在的目录）。归档时已清空，计划清单改由
`design.md` §10.1 承载（那里本来就是它的正确位置）。

**`children` 保留**：`08-02-mcp-marketplace` 已于 2026-08 单独归档并完成，
按 `task.py` 的既定语义（缺失的子任务视为已完成）保留链接，不破坏进度计数。

## 备注

- 本任务为 **complex planning**：需要 `prd.md` + `design.md` + `implement.md`
- 实现阶段按 design.md §10.1 拆子任务（tokens / primitives+chrome / theme-escape / empty-loading / settings-ia / skills-ia / nav-cleanup / quality-gate）
- 决策待确认项：D1 Skills IA（推荐 master-detail）、D2 Settings 形态、D3 DockZoneTabs、D4 Apple tokens、D5 语义色双写
