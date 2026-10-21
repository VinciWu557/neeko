# 执行计划：slash 与 @ 补全

> 设计依据：`design.md`。需求与 AC：`prd.md`。
> 原则：每阶段独立可编译、可测试、可回滚。

## 阶段 0：前置检查

- [ ] 读 `src/AGENTS.md`（前端红线）与 `src-tauri/AGENTS.md`（后端红线）
- [ ] 基线：`pnpm check:quick` 全绿
- [ ] 确认 `get_commands` 在本机往返一次拿到 157 条（已有取证）

## 阶段 1：纯函数层（零 UI、零后端）

先写这一层，因为后面所有交互都建立在它的正确性上。

- [ ] `paletteTrigger.ts`：
  - `findTrigger(text, cursor) → { kind, index, query } | null`
    —— 只看光标**前一个字符**是否行首/空白后的 `/` 或 `@`
  - `applySelection(text, triggerIndex, cursor, value) → { text, cursor }`
    —— 只替换 `[triggerIndex, cursor)` 段
  - `filterBySubstring(items, query, keyOf, limit)`
- [ ] 测试（纯函数，重点覆盖）：
  - `src/foo.ts` 里的 `/` **不**触发
  - 行首 `/`、空格后 `/` **触发**
  - 过滤空 query 返回前 N 条（N 有界，不返回 157 条全量）
  - 写回保留触发符之前的前缀

**变异验证**：触发判据改成「整段文本含 `/`」→ `src/foo` 用例必须红。

**回滚点 1**：纯新增文件，零风险。

## 阶段 2：弹层骨架 `ComposerPalette.tsx`

数据无关的 UI 骨架。

- [ ] props：`items` / `highlight` / `onPick` / `onClose` / `anchor`
- [ ] 键盘契约：`handleKeyDown(e) → boolean`（**返回是否已消费**）
- [ ] 渲染：列表项显示 `label` + `sublabel`（命令看 description，文件看 path）
- [ ] 测试：↑↓ 移动高亮、Enter/Tab 选中、Esc 关闭
- [ ] `handleKeyDown` 在弹层关闭时返回 `false`（不干扰现有 Enter 发送）

**变异验证**：`handleKeyDown` 改成无条件 `return false` → 选中用例必须红。

## 阶段 3：接入 ChatComposer

- [ ] `ChatComposer` 的 `onKeyDown` 先给弹层：
      `if (palette.handleKeyDown(e)) { e.preventDefault(); return; }`
- [ ] `compositionstart/end` 门控（中文输入法）
- [ ] 弹层贴输入框上沿渲染
- [ ] **保持 `ChatComposer.tsx` < 300 行**（ratchet）：逻辑尽量落在
      `paletteTrigger.ts` 与 `ComposerPalette.tsx`

### 测试（这一阶段是重点）

- [ ] 输入 `/` 出现列表（mock 数据源）
- [ ] **弹层打开时 Enter 不触发 `onSend`**（AC7 核心用例）
- [ ] Esc 关闭后 Enter 恢复正常发送
- [ ] 中文组合期输入 `/` 不弹层

**变异验证**：去掉 `if (palette.handleKeyDown(e))` 的短路 → AC7 用例必须红。

**回滚点 3**：此时 `/` 与 `@` 都能用假数据跑通，但还没有真实数据源。

## 阶段 4：两个真实数据源

### 4a 命令（后端增量）

- [ ] `AgentAdapter::list_commands(&self, config)` 默认 `Err(Unsupported)`
- [ ] `PiRpcAdapter` 覆写：短暂 spawn → `get_commands` → 关闭
- [ ] Tauri 命令 `list_agent_commands(agent_id)`（红线 6：只调度）
- [ ] 注册到 `neeko_invoke_handler!`
- [ ] 测试：不支持传输返回 `Unsupported`；Pi 返回非空且含 `name`/`source`

### 4b 文件

- [ ] 复用 `readDirTree` + `flattenFiles`（从 `AttachFilePicker` 抽到共用处）
- [ ] 选中文件 → `addAttachment(path, name)` + 写入 `@path `

### 4c 前端接线

- [ ] 按 `agentId` 缓存命令列表（会话期内不变）
- [ ] `Err(Unsupported)` → 不渲染 `/` 入口（R2）
- [ ] 真机：`/trellis-start` 选中后发送，确认 pi 展开该命令

## 阶段 5：收尾

- [ ] `pnpm check:quick`
- [ ] 变异验证（见下）
- [ ] 更新 `.trellis/spec/frontend/` 记录弹层的键盘契约

## 变异验证清单

| 变异 | 期望变红的用例 |
| --- | --- |
| 触发判据改成「整段含触发符」 | `src/foo.ts` 不触发用例 |
| `handleKeyDown` 无条件返回 false | 弹层内 Enter 选中用例 |
| 去掉 onKeyDown 里的弹层短路 | AC7 双触发用例 |
| `applySelection` 替换整段 | 前缀保留用例 |
| 过滤不做 limit | 空 query 返回条数有界用例 |

## 依赖关系

```
阶段 1（纯函数）──> 阶段 2（骨架）──> 阶段 3（接入）──> 阶段 4（真实数据）
                                        ↓
                              阶段 3 末用假数据即可验证全部交互
```

阶段 1-3 完全不依赖后端；阶段 4 才需要 `list_agent_commands`。

## 不做的事

- 命令参数补全
- 目录级 `@`
- 光标级锚点跟随（先贴上沿，见 `design.md` §7）
- `library/prompt` 域接入
