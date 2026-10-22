// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * `useSessionConfigOptions` 的三处接线**静态护栏**。
 *
 * # 为什么需要静态断言
 *
 * hook 自身的单测全绿也无法证明它真的被接上：`reset()` 存在、行为正确，但如果
 * `useAgentChat` 从不调用它，切 agent 后上一个 ACP 会话的 `model_config` 控件照样
 * 残留 —— 变异实测确认了这一点（删掉 `resetConfigOptions()` 调用，5 条 hook 测试
 * 全绿）。这类「实现正确但没接线」的缺陷只能从源码结构上判。
 *
 * 三处接线各有独立后果：
 *
 * | 接线 | 缺失后果 |
 * | --- | --- |
 * | `session_start` → `replace` | 首次会话拿不到模型列表 |
 * | `config_option_update` → `replace` | agent 中途换模型后 UI 与真实状态脱节 |
 * | agent 变化 → `reset` | 上个会话的配置控件残留，改它们朝不存在的 configId 发请求 |
 */
const HOOK = 'src/features/agent-chat/hooks/useAgentChat.ts';
/** 会话失效 effect 已抽到独立 hook（本文件的三处断言需要同时看两个文件）。 */
const LIFECYCLE = 'src/features/agent-chat/hooks/useAgentSessionLifecycle.ts';

function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

describe('configOptions wiring', () => {
  it('should populate options from the session_start event', () => {
    const source = codeOnly(readFileSync(HOOK, 'utf8'));
    expect(source).toMatch(/case 'session_start':[\s\S]{0,400}?replaceConfigOptions\(/);
  });

  /** 协议规定 agent 可主动变更（rate limit fallback），不订阅就与真实状态脱节。 */
  it('should replace options on config_option_update', () => {
    const source = codeOnly(readFileSync(HOOK, 'utf8'));
    expect(source).toMatch(/case 'config_option_update':[\s\S]{0,400}?replaceConfigOptions\(/);
  });

  /**
   * 切 agent 会话即失效，配置项必须一并清空。
   * 变异实测：删掉这一行，hook 的全部单测仍然全绿。
   */
  it('should reset options when the session context is invalidated', () => {
    const source = codeOnly(readFileSync(HOOK, 'utf8'));
    // effect 在 lifecycle hook 里，通过 onAgentChanged 回调把清理动作接进去。
    // 这里只断言**接线存在**；「切 agent 真的清空了配置项与模型」由行为测试
    // `useAgentSessionLifecycle.test.ts` 与 `useSelectedModel.test.ts` 覆盖 ——
    // 早先这条断言写死 `onAgentChanged: resetConfigOptions` 字符串，一旦清理
    // 动作变成多个（还要清模型）就误报，属 §10.6 那类「静态护栏只能防整段删除」。
    expect(source).toMatch(/onAgentChanged:\s*handleAgentChanged/);
    const lifecycle = codeOnly(readFileSync(LIFECYCLE, 'utf8'));
    expect(lifecycle).toContain('onAgentChanged?.()');
  });
});

/**
 * 会话失效判据只看 **agent**，不看模型。
 *
 * # 为什么这是一条必须钉死的护栏
 *
 * 把模型纳入判据会与「自动落位」形成死锁：`SessionStart` 带 `config_options`
 * （模型列表）→ `useSelectedModelSync` 把它填成首个模型 → `selectedModel` 变化
 * → 判据命中 → `sessionIdRef.current = undefined` → 之后每个 `text_delta` 都因
 * `seqEv.session_id !== sid` 被丢弃，界面永远停在 thinking。
 *
 * 这个组合**只在新会话的第一个事件就带模型列表时**触发。ACP 侥幸没踩到（它的
 * `SessionStart` 早于 sid 赋值到达），Pi 踩到了 —— 换传输就复现，属典型时序缺陷。
 *
 * 切模型有独立通道：`modelId` 随 `Turn` 传给后端，在**同一会话内**切换，不需要
 * 新会话。
 */
describe('session invalidation key', () => {
  /** 取出该 effect 的本体（从 `useEffect(` 到它的依赖数组收尾）。 */
  function invalidationEffect(): string {
    const source = codeOnly(readFileSync(LIFECYCLE, 'utf8'));
    const anchor = source.indexOf('prevAgentRef');
    expect(anchor).toBeGreaterThan(-1);
    const bodyStart = source.indexOf('useEffect(', anchor);
    expect(bodyStart).toBeGreaterThan(-1);
    const depsEnd = source.indexOf(');', source.indexOf('}, [', bodyStart));
    expect(depsEnd).toBeGreaterThan(-1);
    return source.slice(bodyStart, depsEnd + 2);
  }

  it('must not include the selected model', () => {
    const effect = invalidationEffect();
    // 判据本体与依赖数组都只允许 agent
    expect(effect).not.toContain('selectedModel');
    expect(effect).toContain('agentId');
  });

  /**
   * 切 agent 会话即失效。
   *
   * 断言的是**语义**（失效时必须走同一个入口），不写具体语句 —— 早先这条
   * 断言 `sessionIdRef.current = undefined`，于是把「清 id」重构进
   * `discardSession()`（同时补上了漏掉的后端 cancel）时误报。
   *
   * 真正要钉住的两件事：
   * 1. 切换 effect 会调用失效入口；
   * 2. 失效入口里既清本地身份，**也**通知后端收掉会话（否则泄漏子进程）。
   */
  it('still invalidates the session when the agent changes', () => {
    const effect = invalidationEffect();
    expect(effect).toContain('discardSession()');

    const lifecycle = codeOnly(readFileSync(LIFECYCLE, 'utf8'));
    const start = lifecycle.indexOf('const discardSession = useCallback(');
    expect(start).toBeGreaterThan(-1);
    const body = lifecycle.slice(start, lifecycle.indexOf('}, [', start));
    // 本地身份必须清（否则事件继续匹配旧会话）
    expect(body).toContain('sessionIdRef.current = undefined');
    // 后端必须被告知（否则每切一次泄漏一个 agent 子进程）
    expect(body).toContain('cancelAgentStream(');
  });

  /**
   * **`useTurnStream` 的返回值必须是稳定引用** —— 否则事件监听器每次渲染都重建。
   *
   * 事故链（2026-08-24 实测）：
   *
   * ```
   * useTurnStream 返回对象字面量（每次渲染新建）
   *   → useAgentChat 的 applyEvent 依赖它 → useCallback 身份每渲染变
   *   → listen 的 useEffect 依赖 applyEvent → 每次渲染 unlisten + listen
   *   → session_start（最早到达的事件）落进这个窗口 → 永远收不到握手
   *   → handshaken 恒 false → 模型列表永久停在 "Models appear once the session is ready"
   * ```
   *
   * 症状是「Pi 和 opencode 都看不到模型列表」—— 通用链路断裂，不是某个 adapter 的事。
   *
   * 变异验证：把 `useMemo` 去掉、直接返回对象字面量 → 本用例变红。
   */
  it('should return a stable container from useTurnStream', () => {
    const source = codeOnly(readFileSync('src/features/agent-chat/hooks/useTurnStream.ts', 'utf8'));
    // 返回语句必须被 `useMemo` 包住，不能是裸对象字面量
    expect(source).toMatch(/return\s+useMemo\(/);
    // 且不得存在「return { ... }」形态（那正是回归的样子）
    expect(source).not.toMatch(/return\s*\{\s*\n\s*handle,/);
  });
});
