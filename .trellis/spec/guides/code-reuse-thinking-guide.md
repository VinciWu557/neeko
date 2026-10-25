# 代码复用思维指南

> **目的**：在写新代码之前先停下来想想——是否已经有现成的实现？

---

## 问题描述

**重复代码是不一致性 bug 的头号来源。**

当你复制粘贴或重写现有逻辑时：
- Bug 修复无法自动传播
- 行为随时间逐渐分化
- 代码库变得更难理解

---

## 编写新代码之前

### 第一步：先搜索

```bash
# 搜索相似的函数名
grep -r "functionName" .

# 搜索相似的逻辑
grep -r "keyword" .
```

### 第二步：问自己这些问题

| 问题 | 如果答案是"是"... |
|------|-----------------|
| 是否存在类似的函数？ | 使用或扩展它 |
| 这个模式是否在其他地方用过？ | 遵循现有模式 |
| 这段逻辑能否作为共享工具？ | 在正确的位置创建它 |
| 我是否在从其他文件复制代码？ | **停下来** —— 提取为共享模块 |

---

## 常见的重复模式

### 模式 1：复制粘贴函数

**错误做法**：将验证函数复制到另一个文件

**正确做法**：提取到共享工具模块，在需要的地方导入

### 模式 2：相似的组件

**错误做法**：创建一个与现有组件 80% 相似的新组件

**正确做法**：通过 props/variants 扩展现有组件

### 模式 3：重复的常量

**错误做法**：在多个文件中定义相同的常量

**正确做法**：单一数据源，到处导入

### 模式 4：跨域几乎相同的实现并行

**症状**：两个文件 90%+ 重复，差异仅在调用的 IPC 命令名称或回调名。

**实例**：`WorktreeList`（local，`src/features/project/components/WorktreeList.tsx`）与 `ConnectionWorktreeList`（wsl/ssh，`src/features/connection/components/ConnectionWorktreeList.tsx`）—— 同款视觉与交互，但**接口形态已经分叉**：local 版收 `projectId` 自己在内部取数据，connection 版收一整组回调（`onGetWorktreeChangedFiles` / `onIsWorktreeDirty` / `onOpenWorktreeTerminal` …）由父级注入。这正是模式 4 想避免的：两端各长一套数据获取约定，新增字段要改两遍（参见 `component-guidelines.md` 的「展示组件 + 数据 adapter 跨域复用模式」）。

**为什么发生**：
- 早期只有 local 路径，加 wsl/ssh 时直接 fork 一份"复用不动"
- IPC 命令名不同就当成天然分支
- 没有 callback 接口先行抽象

**正确做法**：用 callback 接口注入 IPC，让 local 与 connection 都走同一组件：

```tsx
// Bad —— 两份并行实现，数据获取约定各长一套
function WorktreeList({ projectId }) {
  // local 版：组件内部自己按 projectId 取
  const snapshot = await getWorkspaceStatus(projectId, worktreePath);
}
function ConnectionWorktreeList({ projectId, ... }) {
  // connection 版：同一份数据改由父级回调注入，接口与 local 版对不上
  const entries = await onGetWorktreeChangedFiles(worktreePath);
}
```

```tsx
// Good —— callback 接口 + 数据获取注入（真实形态见 ConnectionProjectCard.tsx）
interface WorktreeListProps {
  worktrees: Worktree[];
  onGetWorktreeChangedFiles(path: string): Promise<FileChange[]>;
  onIsWorktreeDirty(path: string): Promise<boolean>;
  onRemoveWorktree(path: string, branch: string): void;
}

// adapter（connection）：把按单元的状态读取包成回调
const handleGetWorktreeChangedFiles = useCallback(
  (worktreePath: string) =>
    getWorkspaceStatus(project.id, worktreePath)
      .then((snapshot) => snapshot.entries)
      .catch(() => [] as FileChange[]), // 失败 = 未知，不当作「无变更」
  [project.id],
);

<WorktreeList
  worktrees={worktrees}
  onGetWorktreeChangedFiles={handleGetWorktreeChangedFiles}
  onIsWorktreeDirty={handleIsWorktreeDirty}
  onRemoveWorktree={/* … */}
/>;
```

**触发清单**：
- [ ] 两个文件的 import 列表只差 1~2 行（IPC 命令）？
- [ ] 两份的 JSX 结构几乎完全一致？
- [ ] 改一边的视觉/交互时容易忘了改另一边？

→ 提取 callback 接口、合并实现。详见 [组件指南 - 展示组件 + 数据 adapter 跨域复用模式](../frontend/component-guidelines.md#展示组件--数据-adapter-跨域复用模式)。

### 模式 5：同一「派生规则 / 谓词」抄成多份副本

**症状**：同一条判定或推导规则——行首正则、`startsWith` 谓词、「文件是否属于某语言」、命令过滤模式——在 2 处以上各写一遍。副本初期等价；之后某处被单独修改（补一个关键字、加一个扩展名、换一种引用方式）→ **其余分支静默失效**，且通常不报任何错。

**为什么比「重复常量」更危险**：常量抄错会立刻崩或明显不符；谓词与正则抄错只是**少匹配**——按钮不出现、用例跑漏、清理漏一项，功能"看起来正常"，只有用户能发现。它也比[模式 4](#模式-4跨域几乎相同的实现并行) 隐蔽：模式 4 是整文件级重复（肉眼可见），本模式是**几行规则级**重复（review 时极易划过去）。

**本项目真实实例（2026-09-11，编辑器内联跑测）**：

| 漂移的两份 | 后果 | 收敛为 |
|---|---|---|
| `RUST_FN_LINE`（含 `async`）与 `RUST_MAIN_LINE`（要求裸 `fn`） | `#[tokio::main] async fn main` 解析不到 → **线上 bug：gutter 不出现 Run/Debug 按钮** | `features/editor/utils/languageSyntax.ts` |
| 「文件是否属于本语言」散落 4 处（`runContribution.when`、`testStatusContribution.when`、gutter 进列门控、main 后缀判断） | 其中一处漏 `.go` → 该语言测试状态图标不显示 | `utils/runLanguages.ts` 注册表（各贡献只查表） |
| Go `-run` 与 delve `-test.run` 各自拼锚定模式 | 极易只改一处（例如只给 `-run` 加 `\Q…\E` 引用） | `goTestRunPattern()` 共用 |

**触发清单**：
- [ ] 同一段正则 / 谓词 / 过滤模式，`grep` 到 ≥2 处？
- [ ] 「新增一门语言 / 一个新关键字 / 一种新 flag」需要改几处？**> 1 即信号**
- [ ] 两份副本的差异是**刻意的**还是**漏改的**？刻意的差异必须显式声明为参数，不能靠"我记得这里有不同"

**预防**：
- 收敛为单一事实源（纯函数模块 / 注册表），调用点只做查询；新增维度 = **加表项**，不改任何 `if` 分支（开闭原则）
- 两条链路天然耦合时（Run 与 Debug 用同一模式）**共用同一个构造器**，即使当前输出逐字节相同——省下的不是代码行数，是未来只改一处的那次
- 护栏测试断言「两处输出一致」，更好的形态是断言**唯一来源**（如注册表护栏：某插件必须声明某能力）

---

## 何时进行抽象

**应该抽象的情况**：
- 相同代码出现 3 次以上
- 逻辑复杂到足以产生 bug
- 多人可能需要使用

**不应该抽象的情况**：
- 只使用一次
- 简单的一行代码
- 抽象本身比重复更复杂

---

## 批量修改之后

当你对多个文件做了类似的修改后：

1. **回顾**：是否覆盖了所有实例？
2. **搜索**：运行 grep 检查是否有遗漏
3. **思考**：是否应该进行抽象？

---

## 陷阱：产生相同输出的非对称机制

**问题**：当两种不同的机制需要产生相同的文件集时（例如：初始化用递归目录复制 vs. 更新用手动 `files.set()`），结构性变更（重命名、移动、添加子目录）只会通过自动机制传播。手动机制会悄悄偏离。

**症状**：初始化完美运行，但更新在错误路径创建文件或完全遗漏文件。

**预防清单**：
- [ ] 迁移目录结构时，搜索所有引用旧结构的代码路径
- [ ] 如果一条路径是自动推导的（glob/copy），另一条是手动列举的，手动列举的需要更新
- [ ] 添加回归测试，比较两种机制的输出

---

## 陷阱：同一策略复制 N 份，靠各自的私有状态维持

**问题**：一段「挂载 → 卸载 → 转发按键」的策略被复制进 N 个调用点，每个调用点**各自持有一份私有状态**（一个 `Xxx | undefined` 字段、一个 `isOpen` 布尔）。单看每份都正确；合起来它们可以互相矛盾。

**真实案例**（`packages/dsh-neeko`，三个选择器各持一份）：

```ts
private thinkingSelector: ThinkingSelector | undefined
private themeSelector:    ThemeSelector    | undefined
private resumeSelector:   ResumeSelector   | undefined
```

「有没有面板打开」有**三个答案**，而按键转发读的是其中一个。第二个面板打开后，第一个字段仍是 `undefined !== ...` 的真值，按键可能转到已被替换的面板。同一时期还有第二处后果：`dock.clear()` 之后的 `restore()` 只写在构造函数里，任何提前关闭的路径都把固定行留空。

**判据**：问「这几份的状态能否同时为真/矛盾」。**能，就是同一策略的复制，必须合成一份。** 这与「重复几次」无关——两次也能矛盾。

**修法**：把策略提成一个持有**单一可空槽位**的模块，让「是否有面板」和「是哪个面板」变成同一个问题：

```ts
class PanelHost {
  private open: KeyedComponent | undefined   // 一个槽位，不可能矛盾
  show(panel) { this.open = panel; dock.clear(); dock.addChild(panel) }
  hide()      { this.open = undefined; dock.clear(); restore() }
  handleKey(d) { if (!this.open) return false; this.open.handleInput(d); return true }
}
```

**注意最后一行**：没有面板时返回 `false` 而不是「假装消费了」。一个关闭的 host 若报 consumed，输入框会变成死的——「声明自己处理了」必须等于「真的处理了」。

---

## 陷阱：缓存返回同一个数组实例，而你在原地改它

**问题**：给组件加装饰（前缀标记、高亮、行号）时，顺手改 `render()` 返回的数组。若该组件缓存了自己的输出，返回的是**同一个数组实例**，于是装饰每帧叠加一次。

**真实案例**：`zoneMarked()` 给首行加 OSC 133 标记：

```ts
const lines = original(width)      // Text 返回 cachedLines —— 同一个实例
lines[0] = MARKER + lines[0]       // 每帧再加一个
```

实测 500 帧后首行 **100 → 8116 字节**（每帧 +16），流式会话 20fps 一分钟涨约 19KB 并最终折行。而当时的注释还写着「render builds fresh strings every call」——**注释里的假设没有对照过实现**。

**判据**：装饰别人的输出前，先确认它是否缓存。`pi-tui` 里 `Text` / `Markdown` / `Box` 会缓存数组，`Container` / `Spacer` 不会 —— 所以「同一棵树里有的缓存有的不缓存」，不能按直觉推。

**修法**：`const marked = [...lines]` 后再改。代价只是数组身份，而**没有任何东西依赖它**（当时的注释声称有，实际 `row-cache.ts` 用的是 `WeakMap` 上的**组件**身份）。

**这类 bug 的测试**：断言「相同输入渲染 N 次，输出字节相同」。1 次和 500 次比较即可，不需要知道内部实现：

```ts
const first = component.render(60).map((l) => l.length)
for (let i = 0; i < 500; i += 1) component.render(60)
expect(component.render(60).map((l) => l.length)).toEqual(first)
```

> **别用 `toEqual(first)` 直接比两个数组**：缓存实现返回的是同一个对象，`toEqual` 会拿一个对象和它自己比较，无论如何都通过。必须投影成值（`.map(l => l.length)` 或 `.join()`）。

---

## 陷阱：热路径上的「装饰性状态」混进缓存键

**问题**：把动画帧、时间戳、鼠标位置这类**只影响装饰**的值放进渲染缓存的签名，缓存就永远不命中。

**真实案例**：`rowSignature()` 包含 `spinnerFrame`，于是每 80ms 动画跳一帧，正在流式的那一行签名就变，整行重建（新的 `Markdown`、重新解析、新组件树），一秒钟五次，直到回答结束。

**判据**：问「这个值变化时，**内容**变了吗，还是只有装饰变了」。内容没变就不该进签名。

**更进一步的问题**：这个装饰是**必要的**吗？当时的 `🐳` 思考标记是本仓自造的——对照参考实现，那里是纯文字 `Thinking...`，根本不需要动画。删掉装饰后，定时器、签名输入、常量整条链一起消失，比「合并两个时钟」更彻底。

**顺序**：先问「要不要这个装饰」，再问「怎么让它不污染缓存」。反过来做，会把一个本不该存在的功能优化得很精致。

---

## 提交前检查清单

- [ ] 已搜索现有的相似代码
- [ ] 没有应该共享的复制粘贴逻辑
- [ ] 常量只在一个地方定义
- [ ] **判定规则（正则 / 谓词 / 过滤模式）只有一处定义，调用点只查询**（见[模式 5](#模式-5同一条派生规则--谓词抄成多份副本)）
- [ ] 相似的模式遵循相同的结构
- [ ] **复制来的策略没有各自持私有状态**（能互相矛盾 = 必须合成一份）
- [ ] **装饰别人的 `render()` 输出时先确认它是否缓存**，用副本而非原地改
- [ ] **缓存签名里没有只影响装饰的值**（动画帧 / 时间戳 / 鼠标位置）
