import { open } from '@tauri-apps/plugin-dialog';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAgentStore } from '@/shared/store/agentStore';
import type { AgentConfig, AppConfig, DiffMode } from '@/shared/types';
import { IDE_PRESETS, getIdeCommand } from '@/shared/utils/idePresets';
import type { IdePreset } from '@/shared/utils/idePresets';

import { resetAgent, saveAgent } from '../../agent/api/agentApi';
import { getSystemFonts, resetSystemFonts } from '../api/settingsApi';

import { BUILTIN_FONTS, PRESET_SHELLS, type SettingsNavId } from './constants';

interface UseSettingsPanelStateParams {
  config: AppConfig;
  activeNav: SettingsNavId;
  builtinAgents: AgentConfig[];
  onConfigChange: (next: AppConfig) => void;
  onClose: () => void;
}

export function useSettingsPanelState({
  config,
  activeNav,
  onConfigChange,
  onClose,
}: UseSettingsPanelStateParams) {
  const [shellInput, setShellInput] = useState(config.shell);

  // Sync shell input when config changes
  useEffect(() => {
    // Defer to avoid sync setState in effect
    Promise.resolve().then(() => setShellInput(config.shell));
  }, [config.shell]);

  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [fontSearch, setFontSearch] = useState('');
  const [fontsLoading, setFontsLoading] = useState(false);
  const [fontListOpen, setFontListOpen] = useState(false);
  const fontDropdownRef = useRef<HTMLDivElement>(null);

  const [newIdeName, setNewIdeName] = useState('');
  const [newIdeCommand, setNewIdeCommand] = useState('');

  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [skillPathEditingAgentId, setSkillPathEditingAgentId] = useState<string | null>(null);
  const [skillPathInputValue, setSkillPathInputValue] = useState('');

  const loadFonts = useCallback(async () => {
    if (systemFonts.length > 0) {
      return;
    }
    setFontsLoading(true);
    try {
      const fonts = await getSystemFonts();
      setSystemFonts(fonts);
    } catch (e) {
      console.error('Failed to load system fonts:', e);
    } finally {
      setFontsLoading(false);
    }
  }, [systemFonts.length]);

  /** 安装新字体后强制刷新：先失效后端进程缓存，再绕过本地短路重新拉取。 */
  const refreshFonts = useCallback(async () => {
    setFontsLoading(true);
    try {
      await resetSystemFonts();
      const fonts = await getSystemFonts();
      setSystemFonts(fonts);
    } catch (e) {
      console.error('Failed to refresh system fonts:', e);
    } finally {
      setFontsLoading(false);
    }
  }, []);

  // Load fonts — use Promise.resolve().then to avoid sync setState in effect
  useEffect(() => {
    if (activeNav === 'terminal' && systemFonts.length === 0) {
      Promise.resolve().then(() => loadFonts());
    }
  }, [activeNav, loadFonts, systemFonts.length]);

  useEffect(() => {
    if (!fontListOpen) {
      return;
    }
    const handler = (e: MouseEvent) => {
      if (fontDropdownRef.current && !fontDropdownRef.current.contains(e.target as Node)) {
        setFontListOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [fontListOpen]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const setAppearanceFontSize = (size: number) =>
    onConfigChange({
      ...config,
      appearanceFontSize: Math.min(24, Math.max(10, size)),
    });

  const setEditorFontSize = (size: number) =>
    onConfigChange({
      ...config,
      editorFontSize: Math.min(24, Math.max(10, size)),
    });

  const setTerminalFontSize = (size: number) =>
    onConfigChange({
      ...config,
      terminalFontSize: Math.min(24, Math.max(10, size)),
    });

  const setGpuAcceleration = (enabled: boolean) =>
    onConfigChange({ ...config, terminalGpuAcceleration: enabled });

  const setDiffMode = (diffMode: DiffMode) =>
    onConfigChange({
      ...config,
      diffMode,
    });

  const applyShell = (value: string) => {
    setShellInput(value);
    onConfigChange({ ...config, shell: value });
  };

  const applyFont = (font: string) => {
    onConfigChange({ ...config, fontFamily: font, monoFontFamily: font });
    setFontListOpen(false);
    setFontSearch('');
  };

  const addCustomIde = () => {
    const name = newIdeName.trim();
    const command = newIdeCommand.trim();
    if (!name || !command) {
      return;
    }
    const exists = (config.customIdes || []).some(
      (ide) => ide.name.toLowerCase() === name.toLowerCase() || ide.command === command,
    );
    if (exists) {
      return;
    }
    onConfigChange({
      ...config,
      customIdes: [...(config.customIdes || []), { name, command }],
    });
    setNewIdeName('');
    setNewIdeCommand('');
  };

  const removeCustomIde = (idx: number) => {
    const next = [...(config.customIdes || [])];
    next.splice(idx, 1);
    onConfigChange({ ...config, customIdes: next });
  };

  /** Upsert an agent into the customAgents array by matching ID. */
  function upsertCustomAgent(agents: AgentConfig[], updated: AgentConfig): AgentConfig[] {
    const idx = agents.findIndex((a) => a.id === updated.id);
    if (idx >= 0) {
      const next = [...agents];
      next[idx] = updated;
      return next;
    }
    return [...agents, updated];
  }

  /**
   * 新建/编辑自定义 Agent（AgentForm 提交）。
   *
   * `saveAgent` 内部落盘并刷新 `agentStore` —— 界面因此拿到的是后端生效值，
   * 不再需要在前端另存一份。
   */
  const saveCustomAgent = useCallback(async (agent: AgentConfig) => {
    await saveAgent(agent);
  }, []);

  /** 删除自定义 Agent（按 id）：更新 customAgents + 持久化 remove_agent。 */
  const removeCustomAgentById = useCallback(async (agentId: string) => {
    await resetAgent(agentId);
  }, []);

  /**
   * 保存内置 Agent 覆盖（AgentForm 提交）。
   *
   * 数据只写后端：`saveAgent` → `add_agent` 覆盖层 → 刷新 `agentStore`。
   * 「是否被覆盖」由后端 `AgentManager` 的覆盖表回答（`is_overridden`），
   * 前端不再保管键集合 —— 那曾是需要与后端同步的第二份真相。
   */
  const saveBuiltinOverride = useCallback(async (agent: AgentConfig) => {
    await saveAgent({ ...agent, is_builtin: true });
  }, []);

  /** 重置内置 Agent 覆盖（恢复出厂）。同样只走后端。 */
  const resetBuiltinOverride = useCallback(async (agentId: string) => {
    await resetAgent(agentId);
  }, []);

  /**
   * 内置 agent 的有效配置 —— 来自 `agentStore` 的后端快照。
   *
   * 后端 `AgentManager` 启动时已把内置覆盖层合并进内存定义，所以
   * store 里的就是**生效值**。这里不再读前端那份覆盖 map 的内容
   * （那份副本是「设置页改了终端不生效」的根源之一）。
   */
  const getEffectiveAgent = (agent: AgentConfig): AgentConfig =>
    useAgentStore.getState().byId(agent.id) ?? agent;

  const updateAgentSkillPath = async (agent: AgentConfig, newPath: string) => {
    const trimmed = newPath.trim();
    const updated: AgentConfig = {
      ...getEffectiveAgent(agent),
      skill_path: trimmed || undefined,
    };
    if (agent.is_builtin) {
      // 内置：走覆盖层（不污染 customAgents）。
      await saveBuiltinOverride(updated);
      return;
    }
    onConfigChange({
      ...config,
      customAgents: upsertCustomAgent(config.customAgents, updated),
    });
    try {
      await saveAgent(updated);
    } catch (e) {
      console.error('[Settings] Failed to update agent:', e);
    }
  };

  const selectSkillPath = async (agent: AgentConfig) => {
    try {
      const selected = await open({ multiple: false, directory: true });
      if (selected && typeof selected === 'string') {
        await updateAgentSkillPath(agent, selected);
      }
    } catch (e) {
      console.error('[Settings] Failed to select skill path:', e);
    }
  };

  /**
   * 行内启停开关：列表行直接翻转 `enabled`，不经编辑表单。
   *
   * 保存与错误策略都在这里收口（section 只报告意图，不持策略）：
   * - 内置走覆盖层、自定义直存 —— 与表单保存同一写路径，无第二份真相；
   * - 失败 catch + console.error（与 updateAgentSkillPath 同策略），
   *   返回的 Promise **永不 reject**，调用方的 `void` 消费是安全的。
   *   `saveCustomAgent` 保持裸 Promise —— AgentForm 需要它做内联报错。
   */
  const setAgentEnabled = async (agent: AgentConfig, enabled: boolean) => {
    const updated = { ...getEffectiveAgent(agent), enabled };
    try {
      if (agent.is_builtin) {
        // 内置：走覆盖层（不污染 customAgents），与 updateAgentSkillPath 同判据。
        await saveBuiltinOverride(updated);
      } else {
        await saveAgent(updated);
      }
    } catch (e) {
      console.error('[Settings] Failed to toggle agent:', e);
    }
  };

  const startEditSkillPath = (agentId: string, currentPath: string) => {
    setSkillPathEditingAgentId(agentId);
    setSkillPathInputValue(currentPath);
  };

  const saveSkillPath = async (agent: AgentConfig) => {
    const trimmed = skillPathInputValue.trim();
    if (trimmed !== (agent.skill_path ?? '')) {
      await updateAgentSkillPath(agent, trimmed);
    }
    setSkillPathEditingAgentId(null);
  };

  const cancelSkillPathEdit = () => {
    setSkillPathEditingAgentId(null);
  };

  const startEditPreset = (ide: IdePreset) => {
    const current = config.ideCommandOverrides?.[ide.id] ?? getIdeCommand(ide);
    setEditingPresetId(ide.id);
    setEditingValue(current);
  };

  const savePresetOverride = (ideId: string) => {
    const trimmed = editingValue.trim();
    const preset = IDE_PRESETS.find((item) => item.id === ideId);
    if (!preset) {
      setEditingPresetId(null);
      return;
    }
    const defaultCmd = getIdeCommand(preset);
    const overrides = { ...(config.ideCommandOverrides || {}) };
    if (trimmed && trimmed !== defaultCmd) {
      overrides[ideId] = trimmed;
    } else {
      delete overrides[ideId];
    }
    onConfigChange({ ...config, ideCommandOverrides: overrides });
    setEditingPresetId(null);
  };

  const cancelPresetEdit = () => {
    setEditingPresetId(null);
    setEditingValue('');
  };

  const getEffectiveCommand = (ide: IdePreset) =>
    config.ideCommandOverrides?.[ide.id] ?? getIdeCommand(ide);

  const isCustomShell =
    shellInput !== '' && !PRESET_SHELLS.some((item) => item.value === shellInput);

  const allFonts = useMemo(
    () =>
      Array.from(new Set([...BUILTIN_FONTS, ...systemFonts])).sort((a, b) =>
        a.toLowerCase().localeCompare(b.toLowerCase()),
      ),
    [systemFonts],
  );

  const filteredFonts = useMemo(() => {
    const search = fontSearch.trim().toLowerCase();
    return search ? allFonts.filter((font) => font.toLowerCase().includes(search)) : allFonts;
  }, [allFonts, fontSearch]);

  return {
    shellInput,
    setShellInput,
    fontSearch,
    setFontSearch,
    fontsLoading,
    fontListOpen,
    setFontListOpen,
    fontDropdownRef,
    editingPresetId,
    editingValue,
    setEditingValue,
    skillPathEditingAgentId,
    skillPathInputValue,
    setSkillPathInputValue,
    newIdeName,
    setNewIdeName,
    newIdeCommand,
    setNewIdeCommand,
    isCustomShell,
    filteredFonts,
    refreshFonts,

    setAppearanceFontSize,
    setEditorFontSize,
    setTerminalFontSize,
    setDiffMode,
    applyShell,
    applyFont,
    setGpuAcceleration,

    addCustomIde,
    removeCustomIde,
    saveCustomAgent,
    setAgentEnabled,
    removeCustomAgentById,
    saveBuiltinOverride,
    resetBuiltinOverride,

    getEffectiveAgent,

    selectSkillPath,
    startEditSkillPath,
    saveSkillPath,
    cancelSkillPathEdit,

    startEditPreset,
    savePresetOverride,
    cancelPresetEdit,
    getEffectiveCommand,
  };
}
