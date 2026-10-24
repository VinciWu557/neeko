// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 输入框周边接线的静态护栏（三处，都是「看起来有、实际不通」的高危点）。
 *
 * # 1. 附件选择必须有渲染出口
 *
 * `Attach files` 按钮曾把文件树读进 `attachFiles` state 后就**什么都不渲染**，
 * 点完毫无反应；而整条附件链路（chips / 移除 / 随 prompt 发送）本来都在。
 * 单测全绿也抓不到 —— 它测的是「按钮存在」，不是「点了有结果」。
 *
 * # 2. 选中 agent 就要开会话
 *
 * 模型 / 推理档位 / 模式都只在会话的 `configOptions` 里。等发第一条消息才建
 * 会话会让这些选择器先缺席、发完消息再突然出现 —— 体验割裂。
 *
 * # 3. `agent_chat_open` 必须真的被调用
 *
 * 后端命令注册了却没人调，等于没写。
 */
const ROOT = resolve(__dirname, '../../..');
const VIEW = readFileSync(resolve(ROOT, 'agent-chat/components/AgentChatTabView.tsx'), 'utf8');
const HOOK = readFileSync(resolve(ROOT, 'agent-chat/hooks/useAgentChat.ts'), 'utf8');
const LIFECYCLE = readFileSync(
  resolve(ROOT, 'agent-chat/hooks/useAgentSessionLifecycle.ts'),
  'utf8',
);
const PICKER = readFileSync(resolve(ROOT, 'agent-chat/components/AttachFilePicker.tsx'), 'utf8');
/** 暂存事件的消费逻辑（`flushPendingEvents` 抽到了这里）。 */
const DRAIN = readFileSync(resolve(ROOT, 'agent-chat/hooks/usePendingEventDrain.ts'), 'utf8');
/** 会话能力快照（config + commands）的唯一消费点。 */
const CONFIG_HOOK = readFileSync(
  resolve(ROOT, 'agent-chat/hooks/useSessionConfigOptions.ts'),
  'utf8',
);
/** composer 弹层数据源装配（slash 门控 / @ 文件树）。 */
const SOURCES_HOOK = readFileSync(resolve(ROOT, 'agent-chat/hooks/useComposerSources.ts'), 'utf8');

describe('composer wiring', () => {
  it('should render the file picker, not just load the tree', () => {
    // state 有消费者
    expect(VIEW).toContain('<AttachFilePicker');
    expect(VIEW).toContain('attachPickerOpen &&');
    // 弹窗真的能选
    expect(PICKER).toContain('onPick(');
  });

  it('should forward the picked file into attachments', () => {
    expect(VIEW).toContain('addAttachment(file.path, file.name)');
    // 视图层的 `addAttachment` 必须接到附件状态上（实现细节不写死：
    // 附件已整组抽到 `useChatAttachments`，行为由它的直测覆盖）。
    expect(HOOK).toMatch(/\n\s+addAttachment: addFile,/);
    expect(HOOK).toContain('useChatAttachments(');
  });

  /**
   * **首次落定 agent 也要建会话**。
   *
   * tab 新建时 `agentId` 通常是空的，用户在 chat 里第一次选 agent 属于
   * 「首次落定」而不是「切换」。旧实现只处理切换（`prevKey !== ''`），
   * 于是这一次永远不建会话 —— 模型列表停留在我会话外那份（`--list-models`），
   * 档位与模式也不出现。这是真机反馈的直接成因。
   */
  it('should open a silent session when the agent first settles', () => {
    expect(LIFECYCLE).toContain("prevKey === '' && key !== ''");
    expect(LIFECYCLE).toContain('firstSettle');
  });

  it('should open a silent session when the agent changes', () => {
    // 实现在 lifecycle hook 里；useAgentChat 负责接线
    expect(LIFECYCLE).toContain('openAgentChat(');
    expect(LIFECYCLE).toContain('void openSilentSession()');
    expect(HOOK).toContain('useAgentSessionLifecycle(');
  });

  /** 静默会话不能打断用户 —— 失败只记日志，真正的错误留给发消息那一轮。 */
  it('should not surface silent-session failures to the user', () => {
    expect(LIFECYCLE).toMatch(/catch[\s\S]{0,200}silent session open failed/);
  });

  /**
   * **静默会话建好之后必须消化暂存事件**。
   *
   * `SessionStart`（带 `config_options` = 会话内模型列表 / 档位 / 模式）在
   * `await openAgentChat()` 返回**之前**就 emit 了。那时 `sessionIdRef` 还是空，
   * 事件被塞进 `pendingEventsRef`；赋值后不主动消费，它们会永远躺在那里 ——
   * 表现就是「选中 agent 后模型列表还是会话外那份（`--list-models`）」。
   */
  it('should drain buffered events after the silent session is opened', () => {
    expect(LIFECYCLE).toContain('flushPendingEvents?.(sid)');
    // 消费函数必须真的按 sid 过滤后应用，而不是丢弃
    expect(DRAIN).toMatch(/for \(const seqEv of buffered\) \{[\s\S]{0,80}?apply\(seqEv\)/);
  });

  /**
   * 发消息那条路径必须用**同一份**消费逻辑。
   *
   * 旧实现把「消费 pending」内联在 `handleSend` 里，静默会话另开一条路时
   * 忘了复制它 —— 两处漂移正是这次丢事件的成因。抽成 `flushPendingEvents`
   * 后两条路都调它。
   */
  it('should share one drain implementation between send and silent open', () => {
    // handleSend 里调用
    expect(HOOK).toContain('drainPending(sid)');
    // 消费实现只有一份
    const defs = DRAIN.match(/const drain = useCallback/g) ?? [];
    expect(defs.length).toBe(1);
    // 清空动作只允许出现在 drain 内部（一次），不允许再内联一份
    expect((DRAIN.match(/pendingRef\.current = \[\];/g) ?? []).length).toBe(1);
    expect(HOOK).not.toContain('pendingEventsRef');
  });

  /**
   * **会话生命周期与模型列表必须用「落定后」的 agent id，不是 `data.agentId`。**
   *
   * 新建 Chat tab 时 `data.agentId` 是 `undefined`。`useChatAgents` 会 fallback
   * 到列表首项（UI 显示正常），但若把原始的 `undefined` 传给这两个 hook：
   *
   * - `openSilentSession` 直接 return → **会话永不建立** →
   *   `SessionStart.config_options` 永不到达 → 模型列表一直空
   * - `useAgentModels(undefined)` 直接 return → 目录也不拉
   *
   * 表现就是「看不到任何模型」。2026-08-24 实测踩过。
   *
   * 变异验证：把 `agentId: settledAgentId` 改回 `agentId` → 本用例变红。
   */
  it('should pass the settled agent id to the session and model hooks', () => {
    expect(HOOK).toContain('const settled = selectedAgent.id');
    // 两个消费点都必须用落定值
    const sessionCall = HOOK.slice(HOOK.indexOf('useAgentSessionLifecycle({'));
    expect(sessionCall.slice(0, 200)).toContain('agentId: settled,');
    const modelCall = HOOK.slice(HOOK.indexOf('useModelSelection({'));
    expect(modelCall.slice(0, 200)).toContain('agentId: settled,');
  });

  /**
   * **`/` 补全入口必须由能力位门控（R2 修订版）。**
   *
   * 能力位链路：`SessionStart.capabilities.commands`（后端
   * `Capabilities::from_chat_capabilities` 投影，Rust 测试钉住）→
   * `useSessionConfigOptions` 落 state（能力快照唯一消费点）→
   * `useComposerSources` 只在位为 true 时挂 slash 源。
   *
   * 变异验证：后端投影漏掉 `commands` → Rust 侧
   * `from_chat_capabilities_projects_every_declared_field` 红（实际上直接
   * 编译失败 —— 投影点必须逐字段点名）；前端在 sources 装配处去掉门控 →
   * 本用例红（`/` 会对不支持传输的用户出现，然后查询报错 —— 正是修掉的
   * 「靠试查询判定能力」形态）。
   */
  it('should gate the slash source on the commands capability bit (AC1)', () => {
    // 能力快照唯一消费点：commands 缺省（旧后端）视为 false
    expect(CONFIG_HOOK).toMatch(/caps\?\.commands === true/);
    // useAgentChat 把整个 capabilities 交给它，不另开第二份状态
    expect(HOOK).toContain('applySessionStart(ev.capabilities,');
    expect(HOOK).not.toMatch(/capabilities\.commands/);
    // 视图层：能力位 true 才挂 slash 源；查询经 useAgentCommands（按 agentId 缓存）
    expect(VIEW).toContain('useComposerSources(');
    expect(SOURCES_HOOK).toMatch(/if \(commandsEnabled\) next\.unshift\(createCommandSource/);
    expect(SOURCES_HOOK).toContain('useAgentCommands(');
  });
});
