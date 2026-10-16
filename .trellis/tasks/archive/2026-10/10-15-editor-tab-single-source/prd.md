# 编辑器 tab 状态单源化（删除 activeTabId / order 双表示）

> 来源：2026-10-15 用户实测缺陷「拖动文件复制路径时只会放到第一个 tab 的输入框，而不是当前激活的 tab」。
> 定位结论：这**不是一个 bug，是一类状态模型缺陷**——同一事实有两份表示，靠"每个写点记得同步"维持。
> 本任务是该类缺陷的**根治**（结构性消除），不是补同步。

## 背景：一个已存在的临时补丁

为让用户当场可用，已在 `editorStore.ts` 加入 `projectActiveTab()`：在 `splitRight` / `moveToRight` /
`moveToLeft` / `unsplit` / `setActiveGroup` 五个动作里把"前台 pane 的激活 tab"回写到
`tabs[key].activeTabId`。**这是补丁**：它把漏掉的同步点补上，但没有消除"第二份表示"本身——
下一次新增任何影响前台的 store 动作（`pinTab` / `unpinTab` 实测已漏）还会忘。
按用户决策：**补丁保留至本任务落地，落地时由本任务删除**（它写入的字段将不复存在，故必须删除）。

## 缺陷的第一性原理

`editorStore` 用两个数据结构描述同一个"tab 空间"：

```ts
interface ProjectTabs { tabs: Tab[]; activeTabId: string | null }   // 平铺表示
interface Tab { id; scope; title; order; data }                     // 含 order
editorLayout: Record<tabKey, EditorSplitLayout>                     // 分屏权威表示
// EditorSplitLayout 内：groups[g].tabIds（顺序）+ groups[g].activeTabId（激活）+ activeGroupId
```

于是**两个事实各有两个表示**：

| 事实 | 表示 A | 表示 B | A 的消费者 | B 的消费者 |
| --- | --- | --- | --- | --- |
| 哪个 tab 在前台 | `tabs[key].activeTabId` | `layout.groups[activeGroupId].activeTabId` | 拖拽/插入仲裁、Cmd+W、locate、quick-open、navigation history | 渲染（高亮 / 内容区 / `usePaneTabs`） |
| tab 顺序 | `Tab.order` | `layout.groups[*].tabIds` | 插入仲裁（`sort by order`） | 渲染顺序 |

**分屏之前两者恰好重合（只有一个组、没有拖拽重排），所以冗余无害。**
2026-05-13 引入分屏（commit `d03bcbcd`）后二者分离，冗余立刻变成缺陷：
- 该 commit 里 `activateTab` 同步了两处，`setActiveGroup` 只改布局 —— 即从出生起就是**约定**而非**构造**；
- 此后 `splitRight` / `moveToRight` / `moveToLeft` / `unsplit` / `pinTab` / `unpinTab` 全部只改布局。

### 已实测的两个独立实例（不是单点）

```bash
# ① activeTabId 分叉：split + moveToRight(B) 后
#   tabs[key].activeTabId = c1（仲裁/ Cmd+W 读）  vs  layout.right.activeTabId = c2（UI 读）
#   → 拖文件落到 c1 的输入框（用户报告的缺陷）；Cmd+W 关掉 c1 而非 c2
# ② Tab.order 分叉：reorderTab(C→A 前) 后
#   Tab.order = [A:0, B:1, C:2]（仲裁读）  vs  layout.left.tabIds = [C, A, B]（UI 读）
#   → 仲裁按拖拽前的旧顺序取"首个终端"
```

### 为什么"逐点补同步"不是根治

补丁实测仍漏 `pinTab`/`unpinTab`（pin 一个 tab 再 unpin 后，空间级投影停在 A，布局已切到 B）。
漏的原因与具体动作无关：**只要存在第二份表示，新写点就会漏**。根治 = 让第二份表示**不存在**。

## Requirements

### R1 · 前台 tab 单源（`editorLayout` 为唯一权威）

- R1.1 删除 `ProjectTabs.activeTabId` 字段。前台 tab = `layout.groups[layout.activeGroupId].activeTabId`。
- R1.2 新增**唯一派生点** `selectActiveTabId(state, tabKey)`（纯函数）；命令式 `activeTabIdOf(tabKey)`
  与所有 React 读点都必须经它派生，禁止任何地方再出现"第二份激活位"。
- R1.3 pinned 面板的激活态（`pinnedActiveTabId`）与组激活态是**正交**概念，保留在 layout 内
  （pinned tab 不可关闭、Cmd+W 不应命中它 —— 与今日行为一致）。
- R1.4 `EditorContextValue.activeTabId`（pane 局部值）已是布局派生（`usePaneTabs`），不变。

### R2 · 删除跨空间的全局 `state.activeTabId`

- R2.1 删除 `EditorStoreState.activeTabId`（顶层）。它是**第三份**前台表示，且粒度错位：
  "当前视图空间"的激活位被用在"某个 tabKey 空间"的语义里（10-13 design §1.3 已判死此形态）。
- R2.2 删除 `restoreActiveTabId(tabKey)` 及其 4 处调用（`useProjectSelection` / `useWorktreeActions` /
  `useLocalProjects` / `useCrossTypeSelection`）——顶层值消失后，"切换项目/单元时恢复"这个动作本身不存在了。
- R2.3 需要"当前空间的激活 tab"的全局消费者（`useTabManagement`、`useKeyboardShortcuts` 的
  closeTab 分支）改为**先派生当前 tabKey、再 `selectActiveTabId`**。

### R3 · tab 顺序单源

- R3.1 删除 `Tab.order` 字段（构造点 ~15 处）。
- R3.2 顺序 = `layout` 的 `tabIds`（左组 → 右组 → pinned）。新增唯一派生点
  `selectOrderedTabIds(state, tabKey)`；`terminalRouting.sessionTabSpace` 的排序改为消费它，
  不再自带 `sort((a,b) => a.order - b.order)`。
- R3.3 语义对齐（有意变更）：仲裁将按**视觉顺序**取首个，而非创建顺序 —— 拖拽重排后插入落点随之改变。

### R4 · 结构性保证（让缺陷不可再表示）

- R4.1 **不变量 I1**：有 tab 的空间必有 layout，且 layout 的 `tabIds` + `pinnedTabIds` 恰好枚举该空间的 tab。
  `addTab` 是唯一的 tab 创建入口（实测：`grep "tabs: {" src` 除 store 外零命中，
  tab 不持久化、无 session-restore 写入路径）→ 该不变量由 `addTab`/`clearProjectTabs` 构造性满足。
- R4.2 删除因 R1 而失效的补丁 `projectActiveTab`（连同其调用点）。
- R4.3 不引入运行期守卫（红线不新增）；正确性由**类型系统**承担 —— 字段删除后，
  "忘记同步第二份表示"在编译期即不可能。

### R5 · 回归与验收基线

- R5.1 TDD：先写"分屏/换 pane/pin 后前台正确"的失败测试（Red），再删字段实现（Green）。
- R5.2 `pnpm check` 全绿；现有 4830 前端用例不回归。
- R5.3 文档：`docs/domain-model.md` 与 `.trellis/spec/frontend/state-management.md` 的
  "单一表示/派生点"契约按本任务修订（补丁段落改写为"字段已删除"）。

## Non-Goals

- **不合并** `tabs` 与 `editorLayout` 两个顶层 map 为一个 `spaces` 记录（更强的结构统一，但改动面
  约 120 处且非本缺陷类所必需 —— YAGNI；若未来再次出现二者失配证据，另立任务）。
- 不改分屏 p2+ 的 pane 级精度（10-13 Q6 非目标，仍然有效）。
- 不改 pinned 的交互语义（只改其状态的存放位置）。
- 不动 `Tab` 的其他字段（`scope` / `title` / `data`）。
- 不新增红线。

## Acceptance Criteria

- [x] AC1：分屏后（`splitRight` / `moveToRight`）拖文件到输入框 → 落到**当前激活 pane** 的 tab
      （`moveToRight(B)` 后落 B）；`setActiveGroup` 切回左 pane 后落 A。
- [x] AC2：分屏后 `pinTab` → `unpinTab` → 前台仍正确（补丁漏掉的那条路径，本任务必须覆盖）。
- [x] AC3：分屏后 Cmd+W 关闭的是**当前激活 pane** 的 tab。
- [x] AC4：`reorderTab` 把某 tab 拖到最前后，插入仲裁按**新顺序**取首个（旧实现按 `Tab.order` 取旧顺序）。
- [x] AC5：`ProjectTabs.activeTabId`、`Tab.order`、`EditorStoreState.activeTabId`、`restoreActiveTabId`
      四个符号在全仓**零命中**（类型 + 生产 + 测试的字段声明/写入/读取；注释中解释成因不计）。
      审查发现并已修复：`PaneContent.tsx` 有一处漏删的 `order: 0`（推断成裸对象绕过了 tsc 的
      excess-property 检查——已补 `: Tab` 标注）；测试夹具里约 40 处死写入已清扫。
- [x] AC6：现有测试全绿（`pnpm test:fe`），无用例因字段删除被跳过或弱化。
- [x] AC7：新增回归用例在删除实现前**先红**（Red 已验证，随 implement.md 记录）。
- [x] AC8：`docs/domain-model.md` / `state-management.md` / `interaction-patterns.md` 三处文档与实现一致。
