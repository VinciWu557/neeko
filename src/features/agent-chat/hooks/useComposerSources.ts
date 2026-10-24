import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { readDirTree } from '@/features/file/api/fileApi';
import { activeWorkspaceSession } from '@/shared/store/workspaceStore';
import type { AgentCommandEntry } from '@/shared/types/agentChat';
import type { FileNode } from '@/shared/types/file';
import type { ProjectId } from '@/shared/utils/workspaceRef';

import { createCommandSource, createMentionSource } from '../components/paletteSources';
import type { ComposerPaletteSource } from '../components/paletteSources';

import { useAgentCommands } from './useAgentCommands';

/**
 * composer 补全弹层的**数据源装配**（slash 命令 / @ 文件提及），从
 * `AgentChatTabView` 抽出 —— 视图组件只消费 `sources`，不关心两份数据
 * 怎么来、怎么缓存、怎么与能力位联动。
 *
 * # 能力位门控（R2）
 *
 * `commandsEnabled` 来自 `SessionStart.capabilities.commands`：false 时
 * slash 源**不挂载**（`/` 完全不触发），且 `useAgentCommands` 连查询都不发
 * —— 入口显隐是能力位的职责，查询本身不承担能力判定。
 *
 * # 文件树加载（@ 提及与附件选择共用）
 *
 * `readDirTree(workspace, null, 3)` 只拉一次（含失败，`requestedRef` 挡住
 * 重试风暴），挂载即后台预取 —— `@` 提及可能早于「打开附件弹窗」发生，
 * 而弹层的 `getItems` 是同步接口，文件必须在内存里。后端有缓存，一次 IPC。
 * 附件弹窗（`AttachFilePicker`）通过返回的 `attachFiles` 复用同一份树。
 */
export function useComposerSources(params: {
  projectId: ProjectId;
  /** 附件链路的唯一写路径（`useChatAttachments.addFile`，去重在写路径内完成）。 */
  addAttachment: (path: string, name: string) => void;
  /** slash 能力位（`SessionStart.capabilities.commands`）。 */
  commandsEnabled: boolean;
  /** 落定 agent id（`selectedAgent.id`；空串 = 还没落定，不发查询）。 */
  agentId: string;
}): {
  sources: ComposerPaletteSource[];
  attachFiles: FileNode[];
  attachFilesLoading: boolean;
  loadAttachFiles: () => void;
} {
  const { projectId, addAttachment, commandsEnabled, agentId } = params;
  const [attachFiles, setAttachFiles] = useState<FileNode[]>([]);
  const [attachFilesLoading, setAttachFilesLoading] = useState(false);
  const requestedRef = useRef(false);

  const agentCommands: AgentCommandEntry[] = useAgentCommands(
    agentId === '' ? null : agentId,
    commandsEnabled,
  );

  const loadAttachFiles = useCallback(() => {
    if (requestedRef.current) return;
    requestedRef.current = true;
    setAttachFilesLoading(true);
    void readDirTree(activeWorkspaceSession(projectId), null, 3)
      .then((result) => setAttachFiles(result.nodes))
      .catch(() => setAttachFiles([]))
      .finally(() => setAttachFilesLoading(false));
  }, [projectId]);

  useEffect(() => {
    loadAttachFiles();
  }, [loadAttachFiles]);

  const sources = useMemo<ComposerPaletteSource[]>(() => {
    const next: ComposerPaletteSource[] = [createMentionSource(attachFiles, addAttachment)];
    if (commandsEnabled) next.unshift(createCommandSource(agentCommands));
    return next;
  }, [agentCommands, attachFiles, addAttachment, commandsEnabled]);

  return { sources, attachFiles, attachFilesLoading, loadAttachFiles };
}
