import type { Dispatch, SetStateAction } from 'react';
import { useEffect } from 'react';

import type { WorkspaceSession } from '@/shared/utils/workspaceRef';

import { registerAgentInput, unregisterAgentInput } from '../api/agentInputRegistry';

/**
 * 把本 agent-chat composer 登记为 agent 投递的**接收端**（决议 Q1=(a) · Q5=A 身份注册表）。
 *
 * 存在的理由：`INSERT_TO_AGENT_INPUT_EVENT` 有三个派发点、**全历史零个监听者**
 * （`git log --all -S"addEventListener(INSERT_TO_AGENT_INPUT_EVENT"` → 0 条）——
 * prompts 面板按 Enter（默认 target='agent'）因此是静默 no-op，而且因为「函数恒存在」，
 * 连 `useInsertPromptToWorkspace` 的 clipboard 兜底都进不去。本 hook 就是那条链路
 * **首次出现的消费端**。
 *
 * 身份：`session` 由调用方（`PaneContent`）把它**已经持有的** `activeTab.scope.session`
 * 本体下传（`requireTabWorkspaceSession`）。本 hook **不**反解 `tabKey`、也**不**读
 * `activeWorkspaceSession`：前者是「已持分量处逆向重建身份」（`workspaceRef.ts` 明令禁止，
 * 红线 12），后者会把「当前视图」的单元当成「本 tab」的单元，worktree 下必然错位。
 *
 * 写入路径：`setInput` 函数式更新（受控 textarea 的正解）。**不写 `el.value`** ——
 * `useImeSpaceGuard` 那套 `value=` + `InputEvent` 是给非受控/原生场景的，这里有 setter 可用。
 * 因为走函数式更新，handler 只依赖 `setInput`（useState setter，引用永久稳定）——
 * 不会每次按键重登记。
 *
 * 单独成文件的原因：`AgentChatTabView.tsx` 的单一职责是「渲染 agent chat 页面」，
 * 「向投递注册表报到」是另一类职责；留在组件里会把文件推过 300 行红线
 * （护栏 `check_component_size` 是 ratchet：新债不登记，只能抽）。
 */
export function useAgentInputRegistration(params: {
  session: WorkspaceSession;
  tabId: string;
  setInput: Dispatch<SetStateAction<string>>;
}): void {
  const { session, tabId, setInput } = params;

  useEffect(() => {
    const handler = (text: string) => {
      setInput((prev) => (prev ? `${prev} ${text}` : text));
      return true;
    };
    registerAgentInput(session, tabId, handler);
    return () => {
      unregisterAgentInput(session, tabId);
    };
  }, [session, tabId, setInput]);
}
