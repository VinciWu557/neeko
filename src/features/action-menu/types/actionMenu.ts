import type { LucideIcon } from 'lucide-react';

import type { ProjectId } from '@/shared/utils/workspaceRef';

export type ActionId =
  | 'new-terminal'
  | 'new-browser'
  | 'new-agent-chat'
  | 'new-file'
  | 'open-file'
  | 'recent-files'
  | 'open-side-terminal'
  | 'open-in-ide'
  | 'open-resource-library'
  | 'new-prompt'
  | 'insert-prompt'
  | string;

export type ActionGroup = 'terminal' | 'agent' | 'browser' | 'file' | 'quick' | 'library';

export interface ActionContext {
  projectId: ProjectId | null;
  tabKey: string;
  /** Agent 列表（command 非空 = 支持 CLI，可开终端 Tab）。 */
  agents: { id: string; name: string; icon?: string | null; enabled: boolean; command?: string }[];
  recentFiles: string[];
  closeMenu: () => void;
  /**
   * 插入到 agent 输入（composer 优先 → 降级 Agent CLI 终端）。
   * @returns true = 真的落地；false = 没有可用目标 —— **调用方必须按「没落地」处理**，
   * 不得忽略返回值（忽略 = 重演「函数存在但静默 no-op」这条本任务修掉的 defect）。
   */
  insertToAgentInput?: (text: string) => boolean;
  /** 可见反馈（AppContext 的 showToast；palette 路径没有 clipboard 降级链，故由 ctx 提供）。 */
  showToast?: (message: string, type?: 'info' | 'error') => void;
  /** Open the Resource Library panel at a specific kind. */
  openLibrary?: (opts?: { kind?: 'skill' | 'prompt' | 'action' }) => void;
}

export interface ActionRegistryItem {
  id: ActionId;
  group: ActionGroup;
  label: string;
  description?: string;
  icon: LucideIcon;
  shortcut?: string;
  keywords: string[];
  disabled?: boolean;
  visible?: (ctx: ActionContext) => boolean;
  execute: (ctx: ActionContext) => void | Promise<void>;
}
