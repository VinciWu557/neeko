# Agent Chat composer 富文本 token 化

## Goal

把 Agent Chat 输入框从「textarea + 镜像高亮层」升级为 **contenteditable 富文本编辑器
（Tiptap 3.x / ProseMirror）**：slash 命令、@ 文件成为**一等 chip token**——带图标、
可退格整块删除、类型化配色（业界 Codex/Slack 同构，见用户提供的 Codex 桌面端截图）。
发送时序列化为 `/name @path` 纯文本，pi/ACP 协议语义不变。

## 背景（为什么是根本方案）

`10-21-mention-slash-palette` 落地了 textarea + 镜像高亮层。该架构有原理性上限：
**镜像渲染必须与透明文字逐像素对齐**，因此 chip 里不可能内嵌图标（宽度不等即错位），
只能是纯文字着色。用户明确要求走根本方案、停止修补。选型研究结论（一手证据见
`research/editor-selection.md`）：**Tiptap 3.x**——唯一 mention+suggestion 双内建的
候选、体积最小（core+react+mention ≈46KB gzip）、ProseMirror 的「DOM 变更解析回模型」
架构天然消化 IME 组合期问题（10-21 为此打过三层 WebKit 加固，本任务后整层删除）。

## Requirements

### R1 chip 是一等 inline token

- slash 命令 chip：图标（按 `source` 分类：prompt / skill / extension）+ 命令名 +
  类型化配色；退格/删除键**整块删除**，光标不落在 chip 内部
- @ 文件 chip：文件图标 + 文件名（sublabel 路径）+ 选中即进 attachments（复用
  `addAttachment`，红线 12 FileRef 链路不变）
- chip 不可编辑中间文字；两侧文字编辑行为正常

### R2 发送序列化契约

文档 → prompt 纯文本：命令 chip → `/name `，文件 chip → `@path `；序列化是**纯函数**
且有 golden 测试锁死（pi 展开依赖该形状，spec §9.4）。attachments 仍走既有链路
（文件的双重语义：文本提及 + 附件，与 10-21 AC5 一致）。

### R3 弹层补全交互保持 10-21 的水平

- `/` 与 `@` 触发、过滤、键盘导航（↑↓/Enter/Tab/Esc）、空态文案——复用
  `paletteSources` 数据源与 `ComposerPalette` 弹层 UI，触发/过滤机制换成 Tiptap
  Suggestion（内建异步 items + debounce + AbortController，正好接 Tauri IPC 查询）
- 能力位门控不变：`capabilities.commands` 为 false 不挂 slash 源、连查询都不发（R2 of 10-21）
- **静态护栏保留**：前端不得硬编码命令清单

### R4 受控往返：草稿按 tab 存/恢复

输入草稿持久化进 tab data（现状 textarea 走 `setInput` + store）。Tiptap 是非受控
编辑器，需要：mount 时 `setContent` 一次恢复；`onUpdate` → store；**死循环防护**
（store 回流不再 setContent，除非文档身份变化如切 tab）。⚠️ `editorStore.mergeTabData`
是穷举白名单（quality-guidelines §17）——新增字段必须同 diff 登记 + 真store 写入读回测试。

### R5 Enter 发送 / IME / 自动增高行为等价

- Enter 发送、Shift+Enter 换行（ProseMirror keymap）
- CJK IME：ProseMirror 原生组合处理，**10-21 的三层加固（text-fill-color / 组合期
  重同步 / 镜像 visibility）随镜像层一起删除**，不再需要
- 自动增高、placeholder、附件 chips 区不受影响

### R6 删除镜像架构

`ComposerMirror.tsx`、`paletteHighlight.ts`、`.composer-mirror/.composer-token*` CSS、
镜像相关测试在本任务内删除；`paletteTrigger.ts` 的 `findTrigger/applySelection` 随
触发机制移交 Tiptap Suggestion 后删除，`filterBySubstring` 等仍被复用的留下。

## Acceptance Criteria

- [ ] **AC1** 选中命令/文件后，输入框内是带图标的 chip（类型化配色）；退格整块删除
- [ ] **AC2** 发送序列化正确：chip 文档 → `/name ` + `@path ` 纯文本（golden 测试）；
      真机 pi 展开 `/命令` 通过
- [ ] **AC3** `/` 与 `@` 弹层补全行为与 10-21 等价（触发/过滤/键盘/空态/能力位门控）
- [ ] **AC4** 草稿切 tab 丢弃再切回仍在（真 store 写入读回测试）
- [ ] **AC5** Enter 发送 / Shift+Enter 换行 / 附件 chips 零回归
- [ ] **AC6** CJK IME 组合输入正常（真机：组合文本可见、上屏正确、方向键无乱码）
- [ ] **AC7** 镜像层代码全删（grep 零残留）；包体积增量记录在案
- [ ] **AC8** `check:quick` 全绿；ratchet（组件 <300 行）合规

## Non-Goals

- 子 agent 提及数据源（Codex 有，我们的数据源尚不存在；schema 预留扩展位即可）
- 命令参数补全（沿用 10-21 Non-Goals）
- 代码块/加粗等其他富文本能力——**只要 chip 与纯文本**，schema 越窄 IME 面越小
- WSL/SSH 场景专项测试（composer 与执行环境无关）

## 关键风险

| 风险 | 缓解 |
| --- | --- |
| WKWebView + Windows 的 CJK 组合期回归（删镜像层后需重验） | AC6 真机矩阵：macOS + Windows 各跑一遍组合输入/方向键/候选删除 |
| 受控回环死循环（onUpdate→store→setContent） | 单向闸门：只有「tab 身份变化」才 setContent，草稿回流不回写编辑器（R4） |
| `mergeTabData` 白名单漏登记（§17 事故同型） | 同 diff 真 store 测试锁死 |
| 序列化形状漂移导致 pi 不展开 | golden 测试 + 真机冒烟 |
| ProseMirror 与 CodeMirror 双编辑器栈并存 | 接受：职责不同（聊天输入 vs 代码编辑），体积 46KB 可承受 |

## 前置与关系

- **前置**：`10-21-mention-slash-palette` 完成真机复测并提交合入（本任务在其基础上
  替换 composer 编辑面，复用其 paletteSources/ComposerPalette/后端 `list_agent_commands`）
- 替换范围：`ChatComposer.tsx` 的 textarea + 10-21 阶段 6 的镜像层
