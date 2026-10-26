# 执行计划：composer 富文本 token 化

> 设计依据：`design.md`。需求与 AC：`prd.md`。选型证据：`research/editor-selection.md`。
> 原则：每阶段独立可编译、可测试、可回滚。

## 阶段 0：前置

- [x] `10-21-mention-slash-palette` 已提交（feat/mention-slash-palette）；本任务从该分支
      开 `feat/composer-token-editor`（真机复测两项随之关闭：见下方「真机待验」）
- [x] 读 `src/AGENTS.md` 与 `src-tauri/AGENTS.md`；基线 `pnpm check:quick` 全绿
- [x] 依赖落地：`@tiptap/core @tiptap/react @tiptap/extension-mention @tiptap/suggestion`
      （版本 3.x，记录确切版本号与 `pnpm add` 后 lockfile diff 大小）
- [x] `npx vite optimize --force` 后确认无预打包异常（参考 quality-guidelines 依赖补丁节）

## 阶段 1：schema 与序列化（零 UI）

- [x] `composer/editorSchema.ts`：CommandChip / FileChip 双 Mention 实例配置
      （`deleteTriggerWithBackspace: true`，`renderText` 出 `/name ` 与 `@path `）
- [x] `docToPromptText(doc)` 纯函数 + golden 测试：chip/文本混排、chip 相邻、
      chip 后无空格补空格、空文档、纯文本透传
- [x] `mergeTabData` 登记 `composerDoc` 字段（**同 diff** 给 `editorStore.test.ts`
      加真 store 写入读回用例，§17 判据）

**回滚点 1**：纯新增，不动现有组件。

## 阶段 2：RichComposer 最小可用（纯文本等价，尚无 chip 弹层）

- [x] `composer/RichComposer.tsx`：EditorProvider + 窄 schema；Enter 发送 /
      Shift+Enter 换行（`handleKeyDown`）；`isComposing` 守卫；空内容判定
      （`editor.isEmpty`）；自动增高（max-height 200px 同现状）；placeholder
- [x] 受控往返：mount `setContent` 恢复 tab 草稿一次；`onUpdate` → mergeTabData；
      **回环测试**：断言 setContent 全程调用次数 = 1
- [x] 旧 `input: string` 草稿兼容读取（§7 迁移）
- [x] 组件测试：输入文本、Enter 发送（mock onSend）、Shift+Enter 不发送、
      草稿恢复

**回滚点 2**：此阶段尚未接线到 ChatComposer，旧路径完好。

## 阶段 3：chip 渲染与弹层接线

- [x] `composer/ChipView.tsx`：ReactNodeViewRenderer——图标 + 标签 + 类型化配色 pill；
      退格整块删验证
- [x] Suggestion × 2（`/` 与 `@`）：`items` 接 `paletteSources` 工厂（命令源走
      `useAgentCommands` 异步查询 + agentId 缓存；能力位 false 不注册 `/` suggestion）；
      弹层经 suggestion `render()` 挂现有 `ComposerPalette`（props 微调，键盘导航交
      suggestion 引擎）
- [x] 集成测试：`/` 触发→弹层→Enter→CommandChip 入文且序列化含 `/name `；
      `@` → FileChip 入文 **且** `onPickFile(path, name)`（附件链路不变）；
      **弹层打开 Enter 不发送**（AC7 等价）；能力位 false 无弹层
- [x] 变异验证：序列化丢空格 → golden 红；去掉能力位门控 → 门控用例红

**回滚点 3**：`RichComposer` 完整功能就绪，但仍未替换旧 textarea 路径。

## 阶段 4：切换与清理

- [x] `ChatComposer.tsx`：textarea + 镜像层 → `<RichComposer>`（props 契约不变，
      `onInputChange/onReplaceInput` 的调用方按新契约调整，`AgentChatTabView` 同步）
- [x] **删除**：`ComposerMirror.tsx`、`paletteHighlight.ts`(+test)、`paletteTrigger.ts`
      中 `findTrigger/applySelection/triggerStartAt`(+test)、`.composer-mirror /
      .composer-token*` CSS、10-21 的三层 IME 加固（text-fill-color / 组合期重同步 /
      visibility 门控）；保留 `filterBySubstring` 等仍被引用的符号
- [x] 反向护栏：grep 断言镜像层符号零残留（同 `RETIRED_FRONTEND` 思路）
- [x] ratchet：`RichComposer.tsx` / `ChatComposer.tsx` < 300 行；逻辑外移
      schema/suggestion 配置

## 阶段 5：收尾

- [x] `pnpm check:quick` 全绿；`pnpm test:fe` 全量（composer 是高频触点）
- [x] 包体积记录：build 产物 diff（gzip 增量写入 design §8 或 implement 附录）
- [x] spec 更新（`trellis-update-spec`）：interaction-patterns 补「chip 编辑器的键盘
      契约」与「受控回环单向闸门」；agent-chat-transports 若有序列化契约措辞同步
- [x] 真机清单（AC2/AC6）：macOS + Windows 各跑——CJK 组合输入、方向键、候选删除、
      `/命令` 发送后 pi 展开、草稿切 tab 恢复。
      **2026-10-26 由用户手工验证通过**（详见下方「真机待验」）。

## 变异验证清单

| 变异 | 期望变红的用例 |
| --- | --- |
| `docToPromptText` 丢 chip 后空格 | golden 序列化用例 |
| `onUpdate` 依赖里出现 `setContent` 回流 | 回环用例（setContent 次数 >1） |
| `mergeTabData` 漏登记 `composerDoc` | 真 store 写入读回用例 |
| suggestion 去掉 `deleteTriggerWithBackspace` | chip 整块删用例 |
| 能力位门控短路移除 | slash 源不挂载用例 |

## 依赖关系

```
阶段 0（前置/依赖）──> 1（schema/序列化）──> 2（纯文本等价）──> 3（chip+弹层）──> 4（切换清理）──> 5（收尾）
```

阶段 1-3 旧路径完好随时可弃；阶段 4 是切换点（单 commit，回滚 = revert 该 commit）。

## 不做的事

- 运行时双轨开关
- 子 agent 数据源
- 富文本格式能力
- 旧 `input` 字段双向同步

## 附录：包体积（2026-10-24 实测）

- 依赖：9 个 `@tiptap/*` 包，全部 3.32.0（单一实例，无 nested 副本；prosemirror 系每包一个版本，未加 overrides）
- lockfile：+328 / -2 行
- `pnpm vite build`：主 chunk `index-*.js` 3389.26 kB / **gzip 1033.61 kB**（Tiptap 约 +46 kB gzip，与选型研究的预估一致）

## 真机验证（2026-10-26 用户手工确认通过）

> 自动化门禁（`vitest run` 647 文件 / 6014 用例、`check:quick`）覆盖的是**代码路径**；
> 下面四项覆盖的是**真实渲染与真实后端行为**，本环境无法自动化（Windows 那半尤其）。
> 用户在真机上逐项验证并确认通过，故本任务据此收口。

- [x] **AC2**：选中 `/trellis-start` chip 后发送，pi 真的展开该命令（序列化形状 `/name `）
- [x] **AC6**：CJK IME 矩阵 —— macOS 与 Windows 各跑：组合输入可见、上屏正确、
      组合期方向键无乱码、退格删 chip 不残留触发符
- [x] chip 视觉：图标 + 类型化配色在深浅两套主题下的对比度；长路径 chip 的省略号截断
- [x] 附件链路：`@` 选中文件后 chip 出现、发送后清空
