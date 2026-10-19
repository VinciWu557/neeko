# Step 16 — `ctrl+o` 全局展开 / 折叠（对齐 pi 实现）

> 归属：`10-18-dsh-tui` 的追加轮次（不另建子任务目录）。
> 落点：`packages/dsh-neeko/src/tui/**`。门禁豁免不变（`prepublishOnly`）。

## 需求（用户原话）

> 支持 ctrl + o 展开折叠输出，参考 pi-tui 的实现

## 现状（改动前，实测）

| 位置 | 行为 |
| --- | --- |
| `app.ts:950` | `ctrl+o` → `toggleFold()` → 只切**最新一行** |
| `app.ts:247` | `expandedRows: WeakSet<TranscriptRow>` 存「用户展开过的行」 |
| `transcript-view.ts:102` | `isExpanded()` 有两个开关：`expanded`（逐行例外）+ `boundary`（按 turn 窗口） |
| 折叠态提示 | 助手思考行写死 `(ctrl+o to expand)`，但按键只开一行 —— 文案与行为不符 |
| 生产调用方 | `boundary` **零调用**（只有测试在用），`expanded` 是唯一实际机制 |

## pi 的参考实现（`pi-coding-agent`）

- 键位表 `app.tools.expand` = `ctrl+o`（`docs/keybindings.md:164`）。
- 动作是 `toggleToolOutputExpansion()` → `setToolsExpanded(!toolOutputExpanded)`：
  **一个全局布尔**，然后遍历 `chatContainer.children`，对每个 `isExpandable(child)`
  调 `child.setExpanded(expanded)` —— 广播式全展开 / 全折叠。
- 单行点击仍走组件自己的 `setExpanded(!this.expanded)`；**下一次全局切换会覆盖它**
  （广播就是覆盖），所以「逐行例外」的生命周期止于下一次 `ctrl+o`。
- 折叠态会报告还有多少行：`... (N more lines, ctrl+o to expand)`
  （`FALLBACK_PREVIEW_LINES = 10`）。
- 切换后给一条状态提示：`Tool output: expanded / collapsed`。

## 设计

### 单一机制：`TranscriptFold`（`src/tui/fold.ts`）

```ts
export interface FoldView {
  readonly allExpanded: boolean
  isFlipped(row: TranscriptRow): boolean
}
// 展开 = allExpanded XOR isFlipped(row)
export class TranscriptFold implements FoldView {
  toggleAll(): boolean   // 翻转全局，并清空逐行例外（= pi 的广播覆盖）
  toggle(row): void      // 翻转单行（点击）
}
```

- 例外集用 `WeakSet<TranscriptRow>`：行对象由 `transcript.ts` 持有，视图不延长其寿命。
- **`toggleAll()` 清空例外**是刻意的：不清的话「全折叠」会留下用户点开过的行，
  与 pi 的广播语义不一致，也让这个键不能当「复位」用。
- `boundary` **删除**。它在生产零调用，且与 `fold` 表达同一件事（要不要展开），
  留着就是第二个可静默失效的开关 —— spec 里「`boundary: 0` 才是全展开」那条随之改写。

### 组件缓存必须跟着折叠态失效

`app.ts:rowSignature()` 现在把 `expandedRows.has(row)` 编进签名。折叠态改成
全局布尔后，签名必须读 `fold.isExpanded(row)` —— 否则按 `ctrl+o` 后签名不变，
`rowComponents` 命中旧组件，**屏幕没有任何变化**（按了没反应）。
这是本轮最容易漏、也最难靠肉眼发现的一条，单列一条变异测试。

### 折叠态文案

折叠行报告被藏起来的量，与 pi 同构（都保持单行，不破坏折叠的省空间前提）：

| 行类型 | 折叠态 |
| --- | --- |
| 工具结果 | `📖 Read src/a.ts [ok] — line one… (+12 lines, ctrl+o)` |
| 助手思考 | `🐳 first thought… (ctrl+o to expand)`（已有，保持） |

`+N lines` 只在 `N > 0` 时出现；文件读取（`isFileRead`）仍只显示路径 ——
引一段文件内容比文件名信息更少，加行数只会更吵。

### 键位与提示同步

- `ctrl+o` 的优先级保持在模态面（model panel / theme picker / interaction）**之后**：
  打开的浮层先拥有键盘。
- 切换后追加一条 notice（`transcript: expanded` / `transcript: collapsed`）。
- `banner.ts` 的按键提示行、`commands.ts` 的 `/help` Keys 行各加 `ctrl+o expand`。

## TDD 步骤

1. **Red** `tests/tui-fold.spec.ts`：`TranscriptFold` 真值表
   （默认全折叠 / `toggleAll` 全展开 / 单行 `toggle` 翻转 / `toggleAll` 清空例外）。
2. **Red** `tests/tui-render-row.spec.ts`：`isExpanded` 迁到 `fold`；
   新增「`allExpanded` 展开全部」「例外行在全展开下折叠」「折叠工具行报告剩余行数」。
3. **Red** `tests/tui-interaction-glue.spec.ts`：按 `\x0f` 后整段转录展开
   （断言渲染文本出现结果正文）、再按一次折叠、notice 出现。
   **变异**：`rowSignature` 不读 fold → 必红。
4. **Green** 实现 `fold.ts`、改 `transcript-view.ts`、改 `app.ts`。
5. 删 `RenderOptions.boundary` / `RenderOptions.expanded`，测试全量迁移。
6. `prepublishOnly` 全绿；spec（`backend/quality-guidelines.md`）折叠条目改写。

## 验收

- [ ] `ctrl+o` 一次展开**全部**折叠行，再一次全部折叠（不是只动最新一行）。
- [ ] 展开后点击单行可单独折叠；下一次 `ctrl+o` 回到统一状态。
- [ ] 折叠工具行显示 `(+N lines, ctrl+o)`，且仍是一行。
- [ ] `/help` 与 banner 的按键行提到 `ctrl+o`。
- [ ] `packages/dsh-neeko`：`pnpm run prepublishOnly` 全绿。
- [ ] 真机（pty）复验：`ctrl+o` 往返、fullscreen 模式下同样生效。

## 不在本轮范围

- `ctrl+t`（pi 的独立 thinking 折叠键）：本轮只有一个折叠维度，不引入第二个键。
- 按 turn 窗口化的默认折叠（原 `boundary` 想做的事）：生产从未启用，不复活。
