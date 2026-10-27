# Step 0 Spike 报告（P1–P6 实测）

> 实测时间 2026-10-27。环境：macOS / dsh `0.2.1-rc.2` / Node `v24.17.0`。
> 方法：**隔离 `DSH_HOME`** 在仓库内一次性目录跑（536KB，已删除），
> **用户真实 profile 全程未被写入**（实测后核对：`~/.dsh/profiles/neeko/cordis.patch.yml`
> 仍 457 行 / 14905 字节 / 0 个受管块）。
>
> 沙箱对 `~/.dsh` 的写操作被拒 —— 这反而成了一道安全网，逼出了隔离方案，也顺带证实
> 安装腿会遇到的第一个真实约束（见 §7）。

## 结论速览

| 项 | 结论 |
| --- | --- |
| P1 profile 范围 | 有 **3 个** profile 解析位置（profile 自身 / 扁平回退 / home 级 patch），见 §1 |
| P2 包落位 | 软链到 `profiles/<name>/node_modules/` 可用；`dsh plugin add` 依赖 pnpm store，**不可靠** |
| P3 patch 追加 | ⚠️ **`[]` 结尾时纯追加会 YAML 解析失败**，必须替换该行；非空数组时纯追加合法 |
| P4 历史重放 | ✅ **不重放**。resume 时 `session/event` 从 `seq=20` 起，不是 0 |
| P5 模板语言 | ✅ **`.ts` 可直接加载**（Node 24 原生 strip-types，实测插件真跑起来） |
| P6 全链路 | ✅ DSH 插件 → POST → 服务端 204；⚠️ 但 Neeko 侧 **`dsh` 被白名单静默丢弃** |

**三个必须改设计的新事实**（原 design 未覆盖）：

1. **P3 的 `[]` 边界**：`cordis.patch.yml` 为空数组时，纯追加 = 解析失败。
2. **P2 的 `dsh plugin add` 不可用**：它跑 pnpm，会因 store 路径冲突失败
   （`ERR_PNPM_UNEXPECTED_STORE`）。且它会**重建 `node_modules` 为真实目录**，抹掉软链。
3. **P6b 的静默丢弃**：`/hook/dsh` 返回 204 但事件被丢 —— 这是 `hook_source()` 白名单的
   fail-open 行为。**必须先加 `HOOK_TARGETS` 行，否则整条链路静默失效**。

---

## P1 profile 范围与解析位置

`dsh --profile <name>` 的实际解析面（读 `dsh-app-boot` + 实测）：

| # | 位置 | 说明 |
| --- | --- | --- |
| 1 | `$DSH_HOME/profiles/<name>/` | profile 自身（`package.json` + `cordis.patch.yml` + `node_modules`） |
| 2 | `$DSH_HOME/profiles/node_modules/` | **扁平回退目录**（本机 252 个包），profile 找不到时回落 |
| 3 | `$DSH_HOME/cordis.patch.yml` | **home 级用户层**，优先级**高于** profile 层，作用于所有 profile |

**`$DSH_HOME` 默认 `~/.dsh`，实测可覆写**（隔离 spike 就是靠它）。

本机 profile：`neeko` / `neeko-acp` / `web` / `tui` / `cc-tui` / `pi-tui`（6 个）。

**设计影响**：

- 必须支持 `DSH_HOME` 覆写（与 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 同款，且**要求绝对路径**，
  相对值忽略 —— 与 `dirs.rs` 现有三条 env 解析的既有约定一致）。
- 「装哪个 profile」不能靠猜。倾向：**只装当前 `DSH_PROFILE`**（env 里就有，
  实测 `DSH_PROFILE=neeko`），其余由用户在设置页显式选择。

## P2 包落位与可卸载性

### 实测矩阵

| 方式 | 可加载 | 可卸载 | 备注 |
| --- | --- | --- | --- |
| 软链 → `profiles/<name>/node_modules/<pkg>` | ✅ | ✅ 删软链 | **推荐** |
| 软链 → `profiles/node_modules/<pkg>`（扁平回退） | ✅ | ✅ | 会污染所有 profile |
| `dsh plugin --profile <p> add <path>` | ⚠️ | ⚠️ | **跑 pnpm，见下** |

### `dsh plugin add` 实测失败

```
[ERR_PNPM_UNEXPECTED_STORE] Unexpected store location
  dependencies at .../profiles/t1/node_modules are linked from /Users/tomgs/Library/pnpm/store/v11
  pnpm now wants to use .../neeko/.pnpm-store/v11
dsh: plugin command failed; diagnostics: .../.plugin-manager/logs/operation-*/pnpm.log
```

根因：`dsh plugin` 委托 pnpm，pnpm 的 store 位置由 **cwd 的 pnpm 配置**决定 ——
在 Neeko 仓库目录下跑就会命中 Neeko 自己的 `.pnpm-store`。

**更严重的发现**：`dsh plugin` 会把 `profiles/<name>/node_modules` **重建为真实目录**，
抹掉我们放的软链（实测中就把准备就绪的软链变成了一份拷贝）。

**设计影响**：

- **不要用 `dsh plugin add`** 代装（它引入 pnpm store 依赖 + 会改写 `node_modules` 形态）。
- 安装腿自己写软链（`std::fs::symlink`，Windows 用 junction/dir symlink，落 `platform/`）。
- 卸载 = 删软链 + 删受管块。**不跑包管理器** → 零网络、零 store 依赖、可完全离线。
- 这也让红线 1（统一命令执行接口）在安装腿上**不触发** —— 因为根本不跑子进程。

## P3 patch 追加合法性（**原设计有误**）

### 实测结果

| `cordis.patch.yml` 内容 | 操作 | 结果 |
| --- | --- | --- |
| `[]`（空数组） | 尾部追加 `- insert:` | ❌ `YAMLException: end of the stream or a document separator is expected` |
| 非空条目 | 尾部追加 `- insert:` | ✅ 正常吸收 |
| `[]` | **把 `[]` 行替换为块** | ✅ 正常吸收 |

根因：`[]` 是**一个完整的流式文档**。在它后面再写 `- item` 等于第二个 document，
而解析器没有 `---` 分隔符 → 报错。

### 设计影响（**必须改 R3**）

安装腿必须是**两分支**，不能只有「追加」：

```
读文件 → 找现有受管块？
  ├─ 有 → 替换块内容（幂等）
  └─ 无 → 文件是否只有 `[]`（及其注释/空白）？
        ├─ 是 → **替换该行**为受管块
        └─ 否 → 尾部追加受管块
```

**判据**：「有效内容只有 `[]`」= 去掉注释行与空行后只剩 `[]`。
这个判定是纯函数，可 100% 单测。

### 层归属验证

`--dump-config` 会打印每层的来源注释，实测受管块被正确归到
`# == <profile>/cordis.patch.yml` —— 说明「追加在文件尾部」不会改变层语义。

## P4 历史事件重放（**好消息**）

实测：新建会话跑一轮 → 记下 `seq` → `--session-id` resume → 观察事件序号。

```
新建会话: session/event type=turn/end seq=18
resume:   session/event type=agent/inbox/spliced seq=20   ← 不是 0
          session/event type=turn/start seq=21
          ...
```

**结论**：`session/event` 实时通道**只发新事件，不重放历史**。

**设计影响**：

- **不需要**为「重启后补发历史通知」做去重。（原 R6 风险表里的这条可以降级。）
- 但注意：**历史重建**是另一条路径（`Session.snapshotEvents()`，`dsh-messager` 用它取标题）。
  我们的模板用**实时事件缓存标题**即可，不读历史 → 天然无重放问题。
- 边界：若 Neeko 在会话**进行中**启动，会漏掉启动前的事件。这与所有其他 CLI 的行为一致
  （hook 只在事件发生时触发），**不是缺陷**。

## P5 模板语言（`.ts` 可直接用）

实测链路：

1. `node --input-type=module -e "import('./index.ts')"` → ✅ 成功
   （`process.features.typescript === 'strip'`，Node 24 原生）
2. 插件 `package.json` 的 `main: "index.ts"` → cordis loader 真加载：
   ```
   [probe] plugin loaded
   ```

**结论**：`.ts` 直接可用，**无需预构建、无需 tsdown**。

**但**：这是 **Node 24+ 的能力**。`dsh-neeko` 走 `tsdown` 预构建是因为它要同时供
浏览器半侧用，且可能兼容旧 Node。我们的模板没有这两项约束，故直接用 `.ts`。

**风险**：DSH 若降到 Node 22（无 strip-types）会失效。
→ 决定：**模板写 `.ts`，但内容限制在「类型注解可被 strip」的语法子集**（不用 enum /
namespace / 参数属性），这样 Node 22 + `--experimental-strip-types` 也能跑。
回归测试断言方式见 AC4。

## P6 全链路

### P6a DSH 侧 → mock Neeko（✅ 通）

隔离环境起 mock Neeko（`node:http`，校验 token / content-type / 必需字段），
真实 DSH headless 会话跑一轮：

```
[probe] plugin loaded
[probe] post() event=turn_completed coords=1 sid=session-a589af0a-f682-...
[probe] post() -> 204

[MOCK] path=/hook/dsh | method=POST | token=OK | ct=application/json |
       json=OK | missing=none | event=turn_completed |
       sid=session-a589af0a-f68 | cwd=/Users/.../.tmp-dsh-spike
```

**`missing=none`** 是关键 —— 载荷字段与 `HookEvent` 契约完全对齐
（`agent_session_id` / `event` / `cwd` / `detail` / `title` / `hints` 六个全在）。

坐标发现也验证了：扫 `endpoints/*.env` → 解析 port/token → 命中 1 个坐标。

### P6b Neeko 侧接收（⚠️ **发现阻塞项**）

用仓库**真实的** server 引擎 + 鉴权门 + validation（只替换 sink）发同形载荷：

```
[SPIKE] POST /hook/dsh -> 204
[SPIKE] POST /hook/pi  -> 204
[SPIKE] delivered 1 event(s)
[SPIKE]   source=pi event=turn_completed sid=session-a589af0a title=Some("spike title")
[SPIKE] dsh accepted: false        ← 关键
```

**两条都是 204，但只投递了 1 条。** `dsh` 被 `hook_source()` 白名单**静默丢弃**。

这正是 `validation.rs` 注释里记录过的可观测性缺口（2026-10-16 事故）：未知 source 与
畸形载荷共用同一个 fail-open 出口 → **HTTP 状态无法区分**。它现在又咬了一次。

**设计影响**：

- `HOOK_TARGETS` 加 `dsh` 行是**硬前置**，不能「先跑通再说」。
- 验收必须断言「**投递了**」而不只是「返回 204」—— 否则会得到假的绿灯。
  这条要写进 AC4（见下）。
- 顺带：`hook_source()` 的 warn 日志是唯一线索，实测时应 grep 它。

---

## 对 prd / design 的修订清单

| 位置 | 原内容 | 改为 |
| --- | --- | --- |
| R3（design） | 「文件尾部追加受管块」 | **两分支**：空数组替换行 / 非空追加（§P3） |
| R3（design） | — | 新增判据「有效内容只有 `[]`」为纯函数 + 单测 |
| R2.2（prd） | 「包落位方式待定」 | **自己写软链**，不用 `dsh plugin add`（§P2） |
| R2.2（prd） | — | 卸载不跑包管理器 → 红线 1 在安装腿**不触发** |
| R4.4（prd） | 子代理过滤 | 保持（`origin` 判别已由 `dsh-messager` 实证） |
| 风险表（design） | 「历史重放需去重」 | **降级**：实测不重放（§P4） |
| 风险表（design） | — | 新增：Node < 24 时 `.ts` 失效 → 模板限定可 strip 子集 |
| AC4（prd） | 「模板可投递」 | 必须断言**真的投递**，不能只看 204（§P6b） |
| P1 新增 | — | `DSH_HOME` 必须支持覆写（绝对路径，相对值忽略） |
| P1 新增 | — | 只装当前 `DSH_PROFILE`，其余由用户显式选 |

## 仍未验证（不在本次 spike 范围）

| 项 | 为什么没验 | 何时验 |
| --- | --- | --- |
| `approval/asked` 在真实审批场景下触发 | headless 跑的是 `reply OK`，**没触发审批** | Step 3 后用 Web/TUI profile 触发一次真实审批 |
| `ask_user_question` 工具调用 | 同上，未调工具 | 同上 |
| `agent/error` 触发 | 未构造失败场景 | 同上（或注入一个必失败的工具调用） |
| Windows 软链/junction | 当前是 macOS | Windows CI |
| 多实例多坐标 fan-out | 只放了 1 个坐标文件 | Step 3 单测覆盖 |

> 这五项都不影响**架构定案**，只影响 Step 3 的测试用例设计。
