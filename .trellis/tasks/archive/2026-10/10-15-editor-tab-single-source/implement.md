# Implement — 编辑器 tab 状态单源化

> 前置：`prd.md`（需求/验收）+ `design.md`（结构/取舍）。按 TDD：每批先 Red 再 Green。
> 批量顺序不可乱：**建派生点 → 改读点 → 删字段 → 护栏/文档**。

## 批 1 · 派生点 + Red 用例

- [ ] 新建 `src/shared/store/editorTabSelectors.ts`：
      `selectOrderedTabIds` / `selectOrderedTabs` / `selectActiveTabId`（纯函数，签名见 design §2.2）
- [ ] `editorTabSelectors.test.ts`：顺序（left→right→pinned、跳过失效 id）、
      前台（组内 / 换组 / layout 缺失 → null）、**pinned 不影响组前台**（design §2.3）
- [ ] `editorStore.test.ts` 增 AC1/AC2/AC3/AC4 回归用例，**先确认 Red**
      （AC1/AC2/AC3 在批 2 前应红；记 Red 输出到本文件下方「Red 证据」）
- [ ] 跑 `npx vitest run src/shared/store`，记录 Red 证据

## 批 2 · 改读点（行为对齐派生）

- [ ] `features/terminal/components/terminalRouting.ts`：
      `sessionTabSpace` 的 `sort((a,b)=>a.order-b.order)` → `selectOrderedTabs`；
      `projectTabs.activeTabId` → `selectActiveTabId`（**AC1/AC4 在此批变绿**）
- [ ] `app/hooks/closeActiveTabCommand.ts`：`tabs[tabKey]?.activeTabId` → `activeTabIdOf(tabKey)`
      （**AC3 在此批变绿**）
- [ ] 命令式读点：`shared/store/navigationHistoryStore.ts`、`features/editor/hooks/useFileView.ts`、
      `useFileViewTabOps.ts`、`features/file/hooks/useLocateFileInTree.ts`、
      `features/runner/components/DebugRunButton.tsx`、`features/quick-open/store/tabCycleStore.ts`、
      `shared/hooks/shortcutTabCommands.ts`、`features/editor/hooks/useEditorGroupLayout.ts`
- [ ] 批末：`npx vitest run src` 全绿（字段仍在，读点已一致）

## 批 3 · 删字段（构造性收口）

- [ ] `shared/types/tab.ts`：`ProjectTabs` 删 `activeTabId`；`Tab` 删 `order`
- [ ] `editorStore.ts`：
      - 删 `projectActiveTab`（补丁）+ 其 5 处调用
      - `activateTab` 只写 layout（组激活 / pinnedActiveTabId 两分支不变）
      - `addTab` 不再写 `activeTabId` / 不再读 `tab.order`
      - `closeTab` 的"下一个激活"计算改用 layout（保留既有相邻 tab 语义）
      - 删 `EditorStoreState.activeTabId` 顶层字段与所有读写
      - 删 `restoreActiveTabId`；`activeTabIdOf` 改调 `selectActiveTabId`
- [ ] 删 4 处 `restoreActiveTabId` 调用：
      `useProjectSelection.ts` / `useWorktreeActions.ts` / `useLocalProjects.ts` /
      `useCrossTypeSelection.ts`
- [ ] 顶层 activeTabId 的其他消费点：`useTabManagement.ts`（改 `selectActiveTabId(tabKey)`）、
      `shared/hooks/useKeyboardShortcuts.ts` closeTab 分支（改派生）、
      `app/hooks/buildAppShellValues.ts` + `shared/contexts/EditorContext.tsx`（移除全局字段，
      pane 局部值由 `usePaneTabs` 提供 —— 已存在）
- [ ] 删 ~15 处 `order:` 构造点（见 `prd.md` 背景清单）；`FileViewer.tabToFileTab` 的
      `order: tab.order` 同步删（`FileTab.order` 无消费者，一并删）
- [ ] 批末：`pnpm type-check` 必须干净（字段删除后 TS 会列出所有漏改点 —— 这是本批的清单来源）

## 批 4 · 护栏与文档

- [ ] `tools/guards/ledger/terminal_foreground_arbitration.json`：owner 由
      `terminalRouting.ts` 改指 `editorTabSelectors.ts`（唯一 sort 的新家），更新 `counts` / `note`
- [ ] `tools/guards/checks/check_terminal_foreground_arbitration.py`：`OWNER` 常量同步；
      跑 `pnpm guards run --only check_terminal_foreground_arbitration` 确认绿
- [ ] （可选，推荐）新增 A5：`ProjectTabs.activeTabId` / `\.order\b`（tab 语境）回潮判据
- [ ] 文档同步：
      - `docs/domain-model.md`（前台仲裁段 → 布局为唯一权威，补丁段改写）
      - `.trellis/spec/frontend/state-management.md`（tab 激活态/身份契约）
      - `.trellis/spec/frontend/interaction-patterns.md`（拖拽章节 §3 的"投影"段改写）

## 批 5 · 验证

- [ ] `pnpm check`（30 护栏 + lint_fe + lint_rust_all_targets + 三套测试）
- [ ] AC5 grep 四符号零命中（命令见下）
- [ ] 真机（人工项）：`pnpm tauri dev` → 分屏拖文件落对 pane；Cmd+W 关对 tab；pin/unpin 后仍正确
- [ ] 记 Red 证据 + 验收结果到本文件

## 验证命令

```bash
# AC5：四个符号零命中
grep -rn "restoreActiveTabId" src --include=*.ts --include=*.tsx
grep -rn "\.activeTabId" src/shared/types/tab.ts src/shared/store/editorStore.ts
grep -rn "order" src/shared/types/tab.ts
# 应有命中的只剩：layout 的 activeTabId（groups[].activeTabId / pinnedActiveTabId）

# 回归 + 门禁
npx vitest run src/shared/store src/features/editor src/features/terminal
pnpm check
```

## Red 证据

批 1 的 AC 用例先在**旧读点形状**上验证必红（这才是「先红」的定义 —— 不是先写后红，而是
证明用例能抓住旧形态）。手法：临时把派生点改回旧读法，跑用例，确认变红；恢复即绿。

```bash
# AC1/AC2（前台错位）：把 selectActiveTabId 改回「空间级投影」旧读法（忽略 activeGroupId）
#   AC1：moveToRight 后前台 = 被迁移 tab；setActiveGroup 切回左 pane 后前台 = 左 pane 激活 tab  → ×
#   AC2：分屏后 pinTab → unpinTab，前台仍等于布局激活 pane 的 tab（补丁漏掉的路径）        → ×
#   Tests  2 failed | 1 passed | 42 skipped (45)   → 恢复后 Tests 3 passed

# AC4（顺序陈旧）：把 selectOrderedTabIds 改回「按创建序排序」（旧 Tab.order 口径）
#   AC4：reorderTab 后顺序派生点反映新视觉顺序（不再读创建序）                            → ×
#   Tests  1 failed | 44 passed (45)              → 恢复后 Tests 45 passed
```

AC3（Cmd+W 关当前 pane）：`closeActiveTabCommand.test.ts` 的「AC3：分屏后关闭的是**当前激活
pane** 的 tab（旧读点读废弃投影 → 关错）」在批 2 前同样红（旧读点读 `tabs[tabKey].activeTabId`，
分屏后停在 A 而布局在 B）。

## 验收结果

- **AC1-AC4**：`editorStore.test.ts`（AC1/AC2/AC4）+ `closeActiveTabCommand.test.ts`（AC3）全绿；
  Red 已在上节验证。
- **AC5（四符号零命中）**：
  ```bash
  grep -rn "restoreActiveTabId" src --include=*.ts --include=*.tsx            # 0
  grep -rn "state\.activeTabId\|getState()\.activeTabId\|s\.activeTabId" src   # 0
  grep -rn "order:" src/shared/types/tab.ts                                   # 0
  grep -rn "activeTabId" src/shared/types/tab.ts   # 仅注释（解释成因）
  ```
- **AC6**：`pnpm test:fe` → **552 files / 4840 tests passed**（较 4830 基线 +10：新增
  `editorTabSelectors.test.ts` 9 条 + AC 用例；无用例被跳过或弱化）。
- **AC7**：Red 证据见上。
- **AC8**：`docs/domain-model.md` / `.trellis/spec/frontend/state-management.md` /
  `.trellis/spec/frontend/interaction-patterns.md` 三处已同步为「布局唯一权威 + 字段已删除」。
- **门禁**：`pnpm guards run --stage local` → **30/30 通过**（含 A5 新判据「字段回潮 0」）；
  `pnpm type-check` 干净；`pnpm lint:fe` 仅 4 条既有 warning。

### 实现期偏差（与 design 的差异，及原因）

1. **A1 的 `owner` 概念退役**（design §4 只写了「owner 改指新文件」）。实际：删掉 `Tab.order`
   后**那处 sort 彻底消失**（顺序直接来自布局 `tabIds`，无需排序），故 `editorTabSelectors`
   不构成 A1 射程内的「order_sort 命中」，owner 名下无命中。台账删掉 `owner` 条目与 kind，
   护栏改为「本域内不得再有第二套顺序/取首」（不再要求某文件是 owner）。这是对 design 的诚实修正。
2. **新增 A5 判据**（design §4 列为「可选」）：钉住 `ProjectTabs.activeTabId` / `Tab.order` /
   `TerminalTab.order` 不得在类型定义里回潮。
3. **`EditorContextValue.activeTabId` 改为可选**：全局 context 不再提供它（pane 局部值由
   `usePaneTabs` 经 `usePaneEditorContext` 注入 —— design §2.5 的预期形态）。
4. **`closeTab` 防御分支**（无 layout 路径）用 `remaining` 推导前台（旧字段删除后原逻辑依赖的
   `existing.activeTabId` 不存在）。I1 保证该分支生产中不可达。

### 审查（trellis-check）发现并修复

独立验证发现了两个真实缺陷，均已修复：

1. **漏删的生产构造点**：`src/features/editor/components/PaneContent.tsx` 的 `handleOpenDiff`
   构建 `Tab` 字面量时仍写 `order: 0`。它被赋给一个推断类型的 `const tab`，**绕过了 tsc 的
   excess-property 检查**（因此 `pnpm type-check` 干净却漏掉了它）。修复：删 `order: 0`，
   并把 `const tab` 显式标注为 `const tab: Tab` —— 让 tsc 对字面量做 excess-property 检查，
   同类漏删今后在编译期即暴露。
2. **AC5 过度声称**：原验收写「四符号全仓零命中」，但实测测试夹具里仍有约 40 处对已删字段的
   死写入（`Tab.order` / `ProjectTabs.activeTabId` / 顶层 `activeTabId: null`），因
   `tsconfig` 排除 `__tests__` 且推断对象不做 excess-property 检查而不可见。已全量清扫；
   AC5 现**字面成立**（仅注释中解释成因的引用保留）。

附带修正：A5 判据的 regex 放宽到覆盖 `activeTabId?:` / `readonly order?:` 变体（原仅匹配
`activeTabId: string | null` 与 `order: number;`）；`terminalRouting.ts` 的两处陈旧 docstring
（「那一次 sort」/「按 order」）随字段删除而改写。

**非本任务问题**：`pnpm check` 首跑时 `test_rust` 偶发一次失败（本任务零 Rust 改动，
单独跑 `pnpm test:rust` 三次全绿；复审子代理也独立复现并确认为既有 flake）；重跑 `pnpm check` 30/30 绿。
