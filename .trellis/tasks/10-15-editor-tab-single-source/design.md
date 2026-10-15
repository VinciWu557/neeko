# Design — 编辑器 tab 状态单源化

> 任务：`.trellis/tasks/10-15-editor-tab-single-source`（PRD 见 `prd.md`）。
> 结论先行：**缺陷的根因是状态模型有两个真源，而不是某个动作忘了同步。**
> 因此修复形态只能是**删除第二份表示**；任何"补同步"（含已落地的 `projectActiveTab` 临时补丁）
> 都是把约定再加固一次，必然在下一次新增写点处失效。本设计给出一次到位的结构。

---

## 1. 第一性原理：什么必须被存储，什么必须被派生

一条状态该不该存储，判据只有一句：**它有没有超出其权威来源的信息量。**

```
tab 空间的三件事实，各自的权威来源：
  ① 有哪些 tab        → 只能由用户动作 / 恢复流程产生（不可派生）   ⇒ 必须存储
  ② tab 的顺序        → 用户拖拽产生；layout.tabIds 已是其记录        ⇒ 可派生（Tab.order 冗余）
  ③ 哪个 tab 在前台   → 用户点击产生；layout.groups[g].activeTabId 已是其记录 ⇒ 可派生（冗余）
```

②③ 的"产生事件"确实存在（拖拽 / 点击），但**产生之后就已被 layout 完整记录**：
`layout.tabIds` 是顺序，`layout.groups[activeGroupId].activeTabId` 是前台。
`Tab.order` 与 `ProjectTabs.activeTabId` 不携带任何 layout 之外的信息 ——
它们是**缓存**，而缓存与真源的一致性靠"每个写点各自记得刷新"来维持，即**约定**。

> **判据句**：一个字段若可由另一个字段计算得出，且没有独立生命周期，它就是缓存；
> 缓存必须由**唯一写点**刷新，或干脆不存。本仓此刻有 13 个写 tab 状态的 store 动作
> （`addTab` / `closeTab` / `activateTab` / `updateTab` / `renameTab` / `clearProjectTabs` /
> `splitRight` / `moveToRight` / `moveToLeft` / `unsplit` / `setActiveGroup` / `pinTab` /
> `unpinTab` / `unpinTabTo` / `reorderTab`）—— 让 15 个动作各自记得刷两个缓存字段，
> 这就是缺陷的**概率来源**，与具体哪个动作漏了无关。

### 1.1 为什么"多加一个同步 helper"不是根治（对已落地补丁的判定）

`projectActiveTab()` 只覆盖了 5 个动作，实测 `pinTab`/`unpinTab` 仍漏（见 `prd.md` 背景）。
更本质的：它没有改变"字段存在"这一事实，所以
- 新动作作者仍需知道"要调它"（知识在注释里，不在类型里）；
- 它的缺席不会导致任何编译错误。

**根治的判据 = 错误不可表示**：删除字段后，`existing.activeTabId = ...` 这类语句**编译不过**。
这是本设计选择"删字段"而非"加 helper"的唯一理由。

---

## 2. 目标状态模型

### 2.1 结构（改后）

```ts
// 真源：每个 tab 空间一份布局，顺序 + 前台 + pinned 全在这里
editorLayout: Record<tabKey, EditorSplitLayout>
  EditorSplitLayout = {
    isSplit: boolean; ratio: number;
    activeGroupId: 'left' | 'right';
    groups: { left: EditorGroupState; right: EditorGroupState };  // { tabIds, activeTabId }
    pinnedTabIds: string[]; pinnedActiveTabId: string | null; pinnedPanelRatio: number;
  }

// 容器：只是 Tab 的注册表（id → Tab 查询），不再有 activeTabId
tabs: Record<tabKey, ProjectTabs>
  ProjectTabs = { tabs: Tab[] }          // ← 删除 activeTabId

// Tab：删除 order（顺序属 layout）
Tab = { id; scope; title; data }         // ← 删除 order
```

### 2.2 派生点（唯一实现，全部为纯函数）

放 `src/shared/store/editorTabSelectors.ts`（新文件，store 同级）。三个函数构成
"tab 空间视图"的唯一读取面：

```ts
/** 顺序：left.tabIds → right.tabIds → pinnedTabIds（视觉顺序即仲裁顺序）。 */
export function selectOrderedTabIds(state, tabKey: string): string[];

/** 顺序投影成 Tab（跳过已失效 id，与今日 heal 语义一致）。 */
export function selectOrderedTabs(state, tabKey: string): Tab[];

/** 前台 tab：pinned 面板激活优先？否 —— 见 §2.3；这里只给「编辑器组」的前台。 */
export function selectActiveTabId(state, tabKey: string): string | null;
```

`selectActiveTabId` 定义：
```
layout = state.editorLayout[tabKey]
若 layout 存在 → layout.groups[layout.activeGroupId].activeTabId
若 layout 缺失（见 §2.4 不变量）→ null
```

保留既有命令式薄封装 `activeTabIdOf(tabKey)`（内部改为调 selector），
使 4 处命令式调用点（`useWorkspaceState` 等）签名不变、语义变为派生。

### 2.3 pinned 与"前台"的关系（必须保持今日行为）

今日语义（实测）：
- `activateTab(pinnedTab)` 只置 `pinnedActiveTabId`，**不改** `activeGroupId` 与组激活位；
- `closeTab(pinnedTab)` 直接 return（pinned 不可关）；
- Cmd+W 读 `tabs[key].activeTabId`，即**组**前台 —— 从不命中 pinned。

⇒ 结论：`selectActiveTabId` **只反映编辑器组**，pinned 激活态（`pinnedActiveTabId`）保持独立读点。
这是有意保留的正交性（pinned 是"钉住的参照面板"，不是"当前工作 tab"），不是遗漏。

### 2.4 不变量 I1（派生安全的前提）

> **有 tab 的空间必有 layout；且 `left.tabIds ∪ right.tabIds ∪ pinnedTabIds` 恰好枚举该空间的 tab。**

实测支撑（`prd.md` R4.1）：tab 不持久化（session 不存 tabs），`tabs: {` 字面量除 store 内零命中，
即 `addTab` / `clearProjectTabs` 是仅有的两个入口。故 I1 由构造满足。

**当前 `useEditorGroupLayout` 里的兜底分支**（`if (rawLayout) ... else createDefaultEditorLayout()`）
在 I1 成立后成为**死代码**。本任务：保留（防御性，成本≈0），但在注释里写明它是 I1 的断言面；
**不**把 I1 写成运行期 throw（红线不新增，且缺 layout 时渲染空比抛异常更安全）。

> 设计取舍：不从 `tabs[key]` + `Tab.order` 重建 layout（那会把缓存当真源用）。
> 缺 layout = 前台 `null`（优雅降级），因为 I1 保证这在生产中不可达。

### 2.5 顶层 `state.activeTabId` 的删除

它是第三份表示，且**粒度错位**：语义是"当前视图空间的激活 tab"，却被当作
"某 tabKey 空间内的激活 tab"使用（10-13 design §1.3 已判死该形态）。
删除后：

| 消费者 | 今日 | 改后 |
| --- | --- | --- |
| `restoreActiveTabId(tabKey)` ×4 调用 | 切项目/单元时重写顶层值 | **函数与调用一并删除**（顶层值不存在 → "恢复"这个动作不存在） |
| `useTabManagement`（`state.activeTabId`） | 读顶层 | `selectActiveTabId(getState(), tabKey)`（它已有 tabKey） |
| `useKeyboardShortcuts` closeTab 分支 | 读顶层 ref | 同上传入派生值（它已能派生当前 tabKey） |
| `buildAppShellValues` / `EditorContextValue.activeTabId` | 顶层透传 | 改由 `usePaneTabs` 的组级值（**已存在**，`EditorGroupPane` 里本就用它），全局 context 该字段移除 |

---

## 3. 迁移策略（分批，每批可独立验证）

> 顺序不可乱：**先立派生点，再改读点，最后删字段**。倒过来会有一段"读点找不到真源"的中间态。

### 批 1 · 建派生点 + Red 用例（零行为变更）
- 新增 `editorTabSelectors.ts`（三个纯函数 + 单测）。
- 新增回归用例（PRD AC1-AC4）：**先红** —— 此时 `selectActiveTabId` 尚未接线，
  断言"分屏后前台落对 pane"在旧读点上失败。Red 证据记入 `implement.md`。

### 批 2 · 改读点（行为对齐到派生）
- `terminalRouting.sessionTabSpace` → 用 `selectOrderedTabs` + `selectActiveTabId`
  （**这就是 AC1/AC4 变绿的批**）。
- `closeActiveTabCommand` / `navigationHistoryStore` / `useFileView` / `useFileViewTabOps` /
  `useLocateFileInTree` / `DebugRunButton` / `tabCycleStore` / `shortcutTabCommands` /
  `useEditorGroupLayout` → 改走 selector。
- 批末：全部现有测试仍绿（此时字段还在，读点已一致）。

### 批 3 · 删字段（构造性收口）
- `ProjectTabs.activeTabId` / `Tab.order` / `EditorStoreState.activeTabId` 删除。
- store 内所有写入点随之消失；`activateTab` 只写 layout；
  `addTab` 落组时不再写第二份；`closeTab` 的"下一个激活"已由 layout 分支计算（保留）。
- 删 `projectActiveTab` 补丁 + `restoreActiveTabId`。
- 构造点（~15 处 `order: ...`）删除；`addTab` 的 `targetGroup` 语义不变（落组已由 layout 表达）。

### 批 4 · 护栏与文档
- `check_terminal_foreground_arbitration`：A1 的 owner 命中形态改变
  （`terminalRouting` 里那一次 `a.order - b.order` 消失 → 台账 `counts` 需同步；
  sort 迁到 `editorTabSelectors` → 台账 owner 改指新文件，或新增一条登记）。
  **这是必须做的，否则护栏因"登记失效 / owner 漂移"直接红。**
- 新增一条 A5 判据（可选，见 §5）：`ProjectTabs.activeTabId` / `Tab.order` 不得回潮。
- 文档三处同步：`docs/domain-model.md`、`.trellis/spec/frontend/state-management.md`
  （该文件有 tab 身份/激活态的大段契约）、`.trellis/spec/frontend/interaction-patterns.md`
  （拖拽章节的"投影"段改写为"字段已删除，前台 = 布局派生"）。

---

## 4. 契约与验证

### 4.1 单测（TDD，先红）
- `editorTabSelectors.test.ts`：顺序（left→right→pinned，跳过失效 id）、前台（分组内 / 换组 /
  layout 缺失 → null）、**pinned 不影响组前台**。
- `editorStore.test.ts`：AC1/AC2/AC3 三条（分屏 / 换 pane / pin-unpin 后前台正确）；
  AC4（`reorderTab` 后 `selectOrderedTabIds` 反映新顺序）。
- 删除用例：原 `ProjectTabs.activeTabId` 相关断言改为断言 layout 或 selector
  （**不得删测试来换绿** —— 逐条替换为等价断言）。

### 4.2 真实验证（实现后）
- AC1/AC2/AC3：`pnpm tauri dev` 真机拖拽 + Cmd+W（人工项，记入 implement.md）。
- AC4：单测足够（顺序纯函数）。
- AC5：`grep` 四符号零命中（写进 implement.md 的验证命令）。
- AC6/AC7/AC8：`pnpm check` 全绿 + 文档一致。

## 5. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 删字段遗漏读点 → 运行期 `undefined` | TS 类型删除后编译期即暴露（`Property 'activeTabId' does not exist`）；批 2 先改完全部读点再批 3 删字段 |
| `order` 语义变更（创建序 → 视觉序）影响仲裁落点 | 有意变更，PRD R3.3 记录；AC4 显式覆盖；`foregroundTerminalTab` 的 `isFallback` 语义不变 |
| 护栏 A1 台账 owner 漂移致 CI 红 | 批 4 显式纳入；owner 改指 `editorTabSelectors.ts`（sort 的新家） |
| 测试里大量造 `order:` / `activeTabId:` 夹具 | 夹具删除后测试意图不变（断言 layout）；逐个替换，不跳过 |
| 顶层 activeTabId 删除影响 4 处"切换时恢复" | 该动作随字段消失而失去意义；逐处确认后删除（`useProjectSelection` / `useWorktreeActions` / `useLocalProjects` / `useCrossTypeSelection`） |
| pinned 语义被误改 | §2.3 明确保留正交；单测钉住"pinned 不影响组前台" |

## 6. 回滚

纯结构改造，无 wire / 持久化变更（tab 不落盘）。回滚 = revert 该任务提交；
无数据迁移、无兼容期。
