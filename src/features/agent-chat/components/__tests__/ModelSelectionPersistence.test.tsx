import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 切换 tab 再回来，模型选择必须**还是用户上次选的那个**。
 *
 * # 事故场景
 *
 * `PaneContent` 只渲染 `activeTab` —— 切走就卸载 `AgentChatTabView`，
 * `useAgentChat` 的 `selectedModel`（组件局部 state）随之丢失。切回来重新挂载
 * 时它是 `null`，`useSelectedModelSync` 落到 `models[0]`（agent 首选），
 * 用户看到「切个 tab 我的模型自己变了」。
 *
 * # 为什么不能只靠会话的 `configOptions.current_value`
 *
 * 它只在 `availability === 'ready'` 时可信。静默会话重建期间（切 agent、
 * 会话失效）拿不到，而且它描述的是「会话正在用哪个」—— 用户选了但还没发消息
 * 时两者本就该不同。
 *
 * 所以必须持久化到 tab data。
 */

/** 状态与持久化已抽到独立 hook（`useAgentChat` 贴着 ratchet 线）。 */
const SELECTED = resolve(__dirname, '../../hooks/useSelectedModel.ts');
const HOOK = resolve(__dirname, '../../hooks/useAgentChat.ts');
const TAB_TYPES = resolve(__dirname, '../../../../shared/types/tab.ts');

function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

describe('模型选择跨 tab 切换保持', () => {
  it('should declare modelId on the agent-chat tab data', () => {
    expect(codeOnly(readFileSync(TAB_TYPES, 'utf8'))).toMatch(/modelId\?: string/);
  });

  it('should seed the selected model from the tab data', () => {
    const source = codeOnly(readFileSync(SELECTED, 'utf8'));
    // 初值必须来自 tab data，不能是恒 null
    expect(source).not.toMatch(/useState<ModelInfo \| null>\(null\)/);
    expect(source).toMatch(/initialModelId/);
  });

  it('should persist the selection back to the tab data', () => {
    const source = codeOnly(readFileSync(SELECTED, 'utf8'));
    expect(source).toMatch(/updateTab\([^)]*\{[^}]*modelId/);
  });

  /**
   * **切换 agent 时必须清掉旧 agent 的模型选择。**
   *
   * `useSelectedModel.clear()` 自身的行为有单测，但「有没有被接上」测不到 ——
   * 删掉 `useAgentChat` 里的 `clearSelectedModel()` 调用，全部 hook 测试仍全绿
   * （变异实测 372 条通过）。这类「实现正确但没接线」只能从源码结构上判。
   *
   * 后果：旧 agent 的模型 id 会被当成 `modelId` 传给 `agent_chat_open`，
   * ACP 在 `create()` 里预切一个**新 agent 不认识**的模型。
   */
  it('should clear the model when the agent changes', () => {
    const source = codeOnly(readFileSync(HOOK, 'utf8'));
    // `onAgentChanged` 的清理动作里必须包含清模型
    const changed = source.slice(source.indexOf('const handleAgentChanged'));
    expect(changed.slice(0, 600)).toContain('clearSelectedModel()');
  });
});
