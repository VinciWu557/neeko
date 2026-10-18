# pi-tui fork vs npm 1.3.0 差异清单（Step 1 记录）

| fork 特有 | npm 1.3.0 状态 | 影响 / 决策 |
| --- | --- | --- |
| `SelectList.setItems(items)`（picker 打开时刷新列表，保持选中行） | **无** setItems（只有 setFilter/setSelectedIndex） | MVP 不用 sessions picker → 不需要。后续做 /sessions 时：用重建组件替代，或届时提 patch |
| LaTeX markdown extensions（`LATEX_MARKDOWN_EXTENSIONS` + marked 插件） | 有独立 `latex.js`（renderLatex 导出）但 Markdown 组件不含 LaTeX 扩展 | MVP 不渲染 LaTeX 公式 → 接受。后续需要时挂 marked 扩展 |
| CJK 断行（cjkBreakRegex + get-east-asian-width） | **已有**（utils.js:45，且更完整：cjkPunctuationRegex） | 已合并 upstream，无需处理 |
| Apple Terminal shift+enter 补丁（normalizeNativeShiftEnterInput） | 在 terminal.js（isAppleTerminalSession 存在） | 已合并 upstream |
| kitty protocol 协商 | 已有（terminal.js / keys.js） | 已合并 upstream |
