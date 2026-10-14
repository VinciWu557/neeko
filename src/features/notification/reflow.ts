/**
 * 通知回流路由 —— deep link（`neeko://{domain}/{instance_id}`）→ 聚焦动作。
 *
 * 桌面端原生通知点击没有 payload 回调通道（tauri-plugin-notification 2.4.0 实现事实，
 * design D9 修订）：点击原生通知由系统把应用带到前台（尽力回流），精确聚焦经由
 * in-app 通知列表条目点击完成 —— 本模块是两种入口共用的路由表。
 *
 * 复用既有路径铁律：聚焦 = `selectProject` + `activateTab`（同一事实唯一产出点，
 * 禁止新造第二套「打开会话」逻辑）。未知 domain → 返回 false，调用方静默降级。
 */

import { useEditorStore } from '@/shared/store/editorStore';
import { useProjectStore } from '@/shared/store/projectStore';
import { tabProjectId } from '@/shared/utils/tabIdentity';

const DEEP_LINK_RE = /^neeko:\/\/([a-z-]+)\/(.+)$/;

/** 按 session id 找到对应 agent-chat tab：切换所属项目并激活（找到返回 true）。 */
export function reflowAgentChatSession(sessionId: string): boolean {
  const { tabs, activateTab } = useEditorStore.getState();
  for (const [spaceKey, projectTabs] of Object.entries(tabs)) {
    const target = projectTabs.tabs.find(
      (t) => t.data.kind === 'agent-chat' && t.data.sessionId === sessionId,
    );
    if (!target) continue;
    const projectId = tabProjectId(target);
    if (projectId) useProjectStore.getState().selectProject(projectId);
    activateTab(spaceKey, target.id);
    return true;
  }
  return false;
}

/** deep link 回流入口。新业务域接入 = 路由表加一行（开闭原则，§2.3）。 */
export function reflowFromDeepLink(deepLink: string): boolean {
  const match = DEEP_LINK_RE.exec(deepLink);
  if (!match) return false;
  const [, domain, instanceId] = match;
  if (domain === 'agent') return reflowAgentChatSession(instanceId);
  return false;
}
