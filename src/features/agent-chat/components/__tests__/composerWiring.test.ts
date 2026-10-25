// @vitest-environment node
import { execFileSync } from 'node:child_process';
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
/** 富文本 composer（chip 入文 + 序列化 + 空态投影）。 */
const RICH_COMPOSER = readFileSync(
  resolve(ROOT, 'agent-chat/components/composer/RichComposer.tsx'),
  'utf8',
);
/** suggestion 接线（触发符 / 能力位门 / chip 插入）。 */
const SUGGESTION = readFileSync(
  resolve(ROOT, 'agent-chat/components/composer/suggestionWiring.ts'),
  'utf8',
);
/** 编辑器实例注册表（外部投递的落地点）。 */
const EDITOR_REGISTRY = readFileSync(
  resolve(ROOT, 'agent-chat/components/composer/editorRegistry.ts'),
  'utf8',
);
/** 投递注册表的 composer 侧消费者。 */
const INPUT_REGISTRATION = readFileSync(
  resolve(ROOT, 'agent-chat/hooks/useAgentInputRegistration.ts'),
  'utf8',
);

describe('composer wiring', () => {
  it('should render the file picker, not just load the tree', () => {
    // state 有消费者
    expect(VIEW).toContain('<AttachFilePicker');
    expect(VIEW).toContain('attachPickerOpen &&');
    // 弹窗真的能选
    expect(PICKER).toContain('onPick(');
  });

  /**
   * **文件只有一份表示：编辑器文档**（B 方案）。
   *
   * 旧实现把「附件按钮选的文件」与「@ 提及的文件」写进 `useChatAttachments`
   * 的第二份 state，而那份 state 与编辑器文档没有同步 —— 退格删掉 chip 后文件
   * 仍在，且照样随消息发出（「以为移除了、实际没有」）。
   *
   * 现在两个入口都汇合到编辑器（按钮 → `insertIntoComposer('@path')`），请求的
   * `files` 由文档投影产出（`docToRequestFiles`）。
   */
  it('should route the file picker through the editor, not a second attachment state', () => {
    // 按钮选文件 → 插入编辑器（与 @ 提及同一条路径）
    expect(VIEW).toContain('insertIntoComposer(tabKey, tabId, `@${file.path}`)');
    // 视图层不再持有文件附件状态
    expect(VIEW).not.toContain('addAttachment');
    expect(VIEW).not.toContain('fileCount');
    // 请求字段由文档投影产出，handleSend 收的是 composer 的提交物
    expect(HOOK).toContain('submission.files');
    expect(HOOK).not.toContain('toRequestFiles');
    expect(EDITOR_REGISTRY).toContain('export function insertIntoComposer');
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
    // 编辑器侧：无 slash 源时 `/` 不激活（连 items 都不问）
    expect(SUGGESTION).toContain('shouldShow: () => params.pickSource() !== null');
  });

  /**
   * **受控回环的单向闸门（design §4）。**
   *
   * `onUpdate` → `mergeTabData({ composerDoc })` 只出不进。一旦有人把
   * `setContent` 写进 update 处理器，每次按键都会「写 store → 回写编辑器 →
   * 再触发 update」—— 无限循环且输入卡顿。回环用例（setContent 调用次数 = 1）
   * 在 RichComposer.test 里钉行为，这里钉源码结构。
   */
  it('should never write back into the editor from the update handler', () => {
    // 精确取 handleUpdate 的函数体（不跨到相邻的「恢复草稿」effect —— 那里
    // 确实有 setContent，是设计允许的唯一一次恢复写入）。
    const start = RICH_COMPOSER.indexOf('const handleUpdate = () => {');
    expect(start).toBeGreaterThan(-1);
    const body = RICH_COMPOSER.slice(start, RICH_COMPOSER.indexOf('};', start) + 2);
    expect(body).toContain('composerDoc');
    expect(body).not.toContain('setContent');
  });

  /**
   * **外部投递必须落到编辑器实例，不能走 state。**
   *
   * 富文本 composer 是非受控的（草稿真相在 tab data），往输入框塞文本无法经
   * state 完成。旧实现在 handler 里 `setInput(...)` —— 换成编辑器后会静默无效
   * （state 变了但编辑器不动），而这正是本仓「函数存在但什么都不做」的经典形态。
   */
  it('should deliver external text through the editor registry', () => {
    expect(INPUT_REGISTRATION).toContain('insertIntoComposer(');
    expect(INPUT_REGISTRATION).not.toContain('setInput');
    expect(EDITOR_REGISTRY).toContain('export function registerComposerEditor');
    expect(RICH_COMPOSER).toContain('registerComposerEditor(tabKey, tabId, editor)');
  });

  /**
   * **退役的 textarea 架构不得回潮。**
   *
   * 镜像高亮层 / 文本触发判据 / 三处 WebKit IME 加固随 textarea 一起删除。
   * 它们若重新出现（例如有人为了「先修个 bug」把 textarea 路径加回来），
   * 就会与 suggestion 引擎构成两套触发判据 —— 行为必然漂移。
   */
  it('should keep the retired textarea/mirror architecture out of the tree', () => {
    // 剥注释后再断言（quality-guidelines §18b：模块文档里写「这些符号已删除」
    // 是正常的，命中的若是注释就不算回潮）。
    const sourceFiles = execFileSync('grep', ['-rl', 'agent-chat', resolve(ROOT, 'agent-chat')], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter((f) => f !== '' && (f.endsWith('.ts') || f.endsWith('.tsx')))
      .filter((f) => !f.includes('__tests__'));
    const retiredSymbols = [
      'ComposerMirror',
      'paletteHighlight',
      'tokenizeHighlights',
      'segmentHighlights',
      'findTrigger',
      'applySelection',
    ];
    /** 去掉块注释与行注释，只留可执行代码。 */
    const codeOnly = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const file of sourceFiles) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      for (const symbol of retiredSymbols) {
        // 断言值自带文件名与符号，失败信息不需要第二参（vitest/valid-expect）
        expect({ symbol, file, hit: code.includes(symbol) }).toEqual({
          symbol,
          file,
          hit: false,
        });
      }
    }
  });
});
