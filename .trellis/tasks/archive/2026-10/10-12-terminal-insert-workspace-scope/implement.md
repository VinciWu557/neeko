# 执行计划：终端寻址 env-blind 迁移

> 任务：`.trellis/tasks/10-12-terminal-insert-workspace-scope`
> 顺序原则：**先立新、再切写、后切读与 ③ 面、最后清账**（键空间切换原子性，见 design §5）。
> 每批独立可回滚；改动默认停在未提交状态（是否提交由开发者决定）。

---

## 批 0 · 任务卫生（先做，否则后续批次不可派发）

1. **修任务指针**：`python3 ./.trellis/scripts/task.py current` 当前返回
   `.trellis/tasks/10-12-10-12-terminal-insert-workspace-scope`（双前缀），实际目录为
   `10-12-terminal-insert-workspace-scope` —— 该路径不存在。子代理派发协议要求 prompt 首行
   `Active task: <task.py current 输出>`，必须先让指针与目录一致（`task.py set`/`start` 重设）。
2. 复述 PRD 定稿：Q1–Q8 全部已决（Q6/Q7/Q8 为本次审查补），无开放项。
3. `.trellis/tasks/.DS_Store` 噪声（可选清理）。

**验证**：`task.py current` 输出的目录存在且 `task.json` 与目录名一致。

---

## 批 1 · 寻址 API + 单测（立新，旧不动）

**动作**（`terminalCache.ts` 内加，不碰既有导出）：

1. `TERMINAL_KEY_SEP = '\u0001'`；`terminalAddress(session, tabId, paneId='p1')`；
   `terminalAddressPrefix(session)`；`terminalAddressPrefixOfTab(session, tabId)`。
2. `decodeTerminalKey(key)`（唯一 codec）与 `terminalKeyLabel(key)`（日志/提示）。
3. `terminalEnvOf(session)`（模块私有，projectStore 查表；env 缺失 → null，fail-closed）。
4. `resolveTerminalEntry(session, tabId?, paneId?)` → `{ entry, via } | null`（**tabId 必填才精确**，
   缺省走 session 前缀枚举首个，跨 session 不可表达）。
5. `destroyTerminalsForSession(session)` / `destroyTerminalsForTab(session, tabId)` /
   `refreshTerminalForSession(session, tabId?)`（③ 面 API，先只加）。
6. `terminalRouting.ts`（新文件）：`foregroundTerminalTab(session)` +
   `insertToSessionTerminal(session, text)`（唯一编排；低层 resolve 不带隐式 fallback）。
7. 伴随单测（Red 先行，`src/features/terminal/components/__tests__/terminalAddress.test.ts` +
   `terminalRouting.test.ts`）：
   - mint：主仓 / worktree 两态键不同且稳定；同输入同输出；golden 钉住形态（SEP 段界）；
   - **codec**：`decodeTerminalKey(terminalAddress(...))` 往返；**`WorkspaceSession.fromKey` 不可复用**（负例）；
   - **前缀精确性**：嵌套 worktree（`/wt/a` vs `/wt/a-b`）前缀不互串；tab 前缀与含 `:` 的 tabId 不歧义；
   - resolve：精确命中 / miss→null / 缺省 tabId→同 session 首个 + `via:'fallback'` / 跨 session 不串；
     env 缺失→null；
   - routing：前台 terminal / 前台非终端→fallback 同 session 首个 + `isFallback` / 无终端→null / 多 session 隔离。
8. **§3 不变量实测（design 风险 R6）**：打开 worktree 终端 → 切回主仓 → 检查两键各自存活、
   无覆盖。不成立则**报停**并回写 design §3（改 tabSpaceKey 线程化）。

**验证**：新单测全绿；`pnpm lint` 全绿（只加不改，既有行为零影响）；确认 terminalCache 无持久化键
（session restore 不含终端缓存——若含，报停并回写 design）。

---

## 批 2 · 写侧切新键（strategies 全家）

1. 清点 `wsl.ts` / `remote.ts` 全部键构造点（含 worktree 变体），连同 `index.ts` 改调
   `terminalAddress(activeWorkspaceSession(projectId), activeTabId ?? <既有缺省>, paneId)`：
   - **Q8**：session 来源改 `activeWorkspaceSession(projectId)`（`workspaceStore.ts:158`），
     不再走 `activeProject.id` + `activeCheckoutPath` 两步旁路；
   - 删 `wsl:` / `remote:` / `entryId` / `distro` / `btoa(path)` / `cacheKeySuffix` 段（Q6）；
   - **删除 `strategies/local.ts`**（`useLocalTerminalStrategy` 零调用方，R5）与
     `TerminalView.worktreePathOverride` 死管道（`PaneContent.tsx:115-121` 从不传 `worktreePath`）。
2. `TerminalViewBase` / `terminalFactory` 不动（消费 `strategy.cacheKey`，形态对其透明）——
   若发现除 strategy 外的直写点，一并收敛并记录。

**验证**：`pnpm lint`；terminal 相关前端单测；真机开主仓+worktree 终端各一（新键双活）；
旧读侧此刻起对 worktree 已可命中（精确键一致）——症状应已部分消失（记录为证据）。

---

## 批 3 · 读侧 + ③ 部分寻址（症状消除批）

### 3a 插入路径（R1/R2）

1. `pasteToTerminal(session, text, tabId?)` / `sendToTerminal(session, …)` / `launchAgentInTerminal(session, …)`
   / `switchAgentInTerminal(session, …)` 改首参；内部走 `resolveTerminalEntry`；
   **删除 `${projectId}:` 全局 prefix 扫描**。
2. `ProjectView.insertToTerminal`（`:191-222`）改写为 `insertToSessionTerminal`：
   `activeWorkspaceSession(activeProject.id)` → 精确 tabId；fallback 时 toast 落点；null → false。
   同时删除 wsl/remote 的 `findSessionIdForProject` 分支（`scopePrefix` 由 resolve 内部 env 选 Map 承接）。
3. 其余调用方改首参（编译器给清单）：`useFileDrop.ts:63`、`useBrowserTab.ts:183`、
   `useEditorAgentActions.ts:39`、`useBrowserPanelEvents.ts:163,167`（并入 routing helper，
   不再用全局 `editorState.activeTabId`）。

### 3b ③ 部分寻址（**本次审查新增，漏做即静默 PTY 泄漏**）

4. `useLocalProjects.ts:178` → `destroyTerminalsForSession`（session 由 projectId 构造）。
5. `useConnectionProjects.ts:144,147,169,172,209,219` → 逐点改 session 版销毁
   （entry 的每个 project 各自构造 session；不再用 `wslCacheKey/remoteCacheKey` 作前缀）。
6. `useProjectActions.ts:253,268,273,279` → `switchAgentInWsl/RemoteTerminal(session, …)`；
   remote 的 entryId 反查（`remoteEntries.find(host)`）删除，由 `terminalEnvOf` 承接（Q6）。
7. `useAgentActions.ts:90` → `refreshTerminalForSession(activeWorkspaceSession(projectId))`。
8. `useKeyboardShortcuts.ts:158-159` → `terminalAddress` + `refreshTerminalForSession`。
9. `terminalTabCleanup.ts` → 用 `destroyTerminalsForTab` / `destroyTerminalsForSession` 重写；
   删 `terminalSpacePrefix` / `keyHasTabSegment` / `destroyCachesByPrefix` 调用
   （`terminalSpacePrefix` 存在的唯一理由是"两命名空间换算"，新键下不再有两个命名空间）。
10. `TerminalViewBase.tsx:350-352` → 键串 `startsWith('wsl:'/`'remote:'`)` 分派改为
    按 strategy 已知 backend 分派（策略已携带 `kind`/`cache`，不靠 key 猜）。

**验证**：验收三项真机演示（主仓多终端切换跟随 / worktree 落点正确 / 无终端 toast）；
**③ 面逐点真机核验无 PTY 泄漏**（关项目、关 entry、删 worktree、清 tab 空间）；
`sendToTerminal(projectId` / `pasteToTerminal(activeProjectId` 全仓 grep 清零；相关单测全绿。

---

## 批 4 · 清账：删 obsolete + 死代码 + 护栏

1. 确认零引用后删除：
   - 键构造：`terminalCacheKey` / `wslCacheKey` / `remoteCacheKey` / `parseProjectIdFromWslKey`；
   - 寻址/扫描：`findSessionIdForProject` / `hasCacheKeySegment` / `resolveCacheKey` /
     `resolveBackendForKey` / `destroyCachesByPrefix`（backend 冒号前缀版）及其三个公开包装
     `destroyTerminalCachesByPrefix` / `destroyWslCachesByPrefix` / `destroyRemoteCachesByPrefix`；
   - **零消费者导出（R5）**：`launchAgentInAnyTerminal` / `switchAgentInAnyTerminal` /
     `getWslOpenProjectIds` / `getAllWslOpenProjectIds`；
   - 同步清两个桶文件 re-export：`src/features/terminal/components/index.ts`、
     `src/features/terminal/index.ts`（`terminalCacheKey` / `findSessionIdForProject` /
     `wslCacheKey` / `remoteCacheKey` / 上述死导出 / `launchAgentInAnyTerminal` 等条目）。
   - `grep` 清零为据（含测试夹具；`findSessionIdForProject.test.ts` 随函数删除）。
2. 新护栏 `tools/guards/checks/check_terminal_key_mint.py`（判据见 design 附录 G1/G2）+
   `tools/guards/tests/test_check_terminal_key_mint.py`（**框架强制同名测试**，`checks/` 目录自动注册）；
   跑 `pnpm lint` 确认 local stage 拦截生效（用一条故意手搓做 Red 验证后删除）。
3. spec 沉淀：寻址纪律落 `docs/domain-model.md`（WorkspaceSession 小节：terminal 地址派生示例 +
   地址/物理键分层）**或** `quality-guidelines.md`（判据简单则只加 checklist 一条——批内定，不两处复述）。

**验证**：`pnpm lint` 全绿；`pnpm guards list` 含新护栏；退役符号 grep 归零。

---

## 批 5 · 全量验证 + 收尾

- `pnpm check` 全绿；`pnpm test:rust` 全绿（键迁移不碰后端，回归性跑）；
- 逐条勾 PRD Acceptance Criteria（含 ③ 面无泄漏、写侧同源 grep、退役符号零残留三条新增项）；
- Trellis 会话记录（`add_session.py`）；`task.json` 状态更新；归档（另起 commit）。

---

## 命令速查

```bash
# 批 1 单测
pnpm test:fe -- src/features/terminal/components/__tests__/terminalAddress.test.ts \
               src/features/terminal/components/__tests__/terminalRouting.test.ts
# 批 3 旧 API 清零
grep -rn "sendToTerminal(projectId\|pasteToTerminal(activeProjectId\|launchAgentInTerminal(projectId" \
  src --include="*.ts" --include="*.tsx" | grep -v __tests__
# 批 3 ③ 面清零（前缀/裸 id 寻址）
grep -rn "destroyTerminalCachesByPrefix\|destroyWslCachesByPrefix\|destroyRemoteCachesByPrefix\|refreshTerminal(currentActiveProject.id\|findSessionIdForProject\|terminalSpacePrefix" \
  src --include="*.ts" --include="*.tsx" | grep -v __tests__
# 批 3 写侧同源
grep -rn "activeCheckoutPath" src/features/terminal
# 批 4 退役符号清零（含桶文件）
grep -rn "terminalCacheKey\|wslCacheKey\|remoteCacheKey\|parseProjectIdFromWslKey\|resolveCacheKey\|resolveBackendForKey\|destroyCachesByPrefix\|destroyTerminalCachesByPrefix\|destroyWslCachesByPrefix\|destroyRemoteCachesByPrefix\|launchAgentInAnyTerminal\|switchAgentInAnyTerminal\|getWslOpenProjectIds\|getAllWslOpenProjectIds" \
  src --include="*.ts" --include="*.tsx"
# 护栏单测
python3 -m unittest discover -s tools/guards/tests -t tools -p "test_check_terminal_key_mint.py"
# 全量门禁（批末）
pnpm check
```

## 边界复述

- agent 事件链路不动（另起任务）；传输层（create/resize/close/filter）逐字节不动；
- 物理 Map 三分保留，但键内不再含 env 段（Q6）；段分隔符统一 SEP（Q7）；
- 不新增红线（映射红线 10 + 12）；改动停在未提交状态；
- 写侧 `tabSpaceKey` 线程化不在本批（design §3 边界声明 + 批 1 不变量实测）。
