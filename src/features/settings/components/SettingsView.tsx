import React, { useState, useMemo, useCallback, useEffect } from 'react';

import { useAppContext } from '@/shared/contexts';
import { useScrollMemory } from '@/shared/hooks/useScrollMemory';
import { useAppViewStore } from '@/shared/store/appViewStore';
import { useProjectStore } from '@/shared/store/projectStore';
import type { AgentConfig, AppConfig } from '@/shared/types';
import { buildScrollKey } from '@/shared/utils/scrollMemory';
import type { ProjectId } from '@/shared/utils/workspaceRef';
import { Island } from '@/ui/Island';

import { listAgents } from '../../agent/api/agentApi';

import AboutPanel from './AboutPanel';
import AgentsPanel from './AgentsPanel';
import AppearancePanel from './AppearancePanel';
import { NAV_ITEMS, type SettingsNavId } from './constants';
import DebugPanel from './DebugPanel';
import EditorSettingsPanel from './EditorSettingsPanel';
import GitPanel from './GitPanel';
import IdePanel from './IdePanel';
import LspPanel from './LspPanel';
import NotificationSettingsSection from './NotificationSettingsSection';
import ProjectPanel from './ProjectPanel';
import SettingsSidebar from './SettingsSidebar';
import ShortcutPanel from './ShortcutPanel';
import TerminalPanel from './TerminalPanel';
import { useSettingsPanelState } from './useSettingsPanelState';

/** 滚动视图身份：全局唯一 surface 常量（sub 段按导航项隔离）。 */
const SCROLL_SURFACE = 'settings.content';

function SettingsView() {
  const setAppView = useAppViewStore((s) => s.setAppView);
  const { config, customThemes, saveConfig } = useAppContext();
  const projects = useProjectStore((s) => s.projects);
  const [activeNav, setActiveNav] = useState<SettingsNavId>('appearance');
  const [searchQuery, setSearchQuery] = useState('');
  const [builtinAgents, setBuiltinAgents] = useState<AgentConfig[]>([]);
  const [allAgents, setAllAgents] = useState<AgentConfig[]>([]);

  // 滚动记忆：按导航项各自记忆；离开设置（卸载）后返回也恢复上次位置。
  const scrollRef = useScrollMemory<HTMLDivElement>(
    buildScrollKey(SCROLL_SURFACE, null, activeNav),
  );
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const all = await listAgents();
        if (alive) {
          setBuiltinAgents(all.filter((a) => a.is_builtin === true));
          setAllAgents(all);
        }
      } catch (e) {
        console.error('[SettingsView] Failed to list agents:', e);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const handleBack = useCallback(() => {
    setAppView('normal');
  }, [setAppView]);

  const onConfigChange = useCallback((next: AppConfig) => saveConfig(next), [saveConfig]);

  const state = useSettingsPanelState({
    config,
    activeNav,
    builtinAgents,
    onConfigChange,
    onClose: handleBack,
  });

  const filteredNavItems = useMemo(() => {
    if (!searchQuery.trim()) return NAV_ITEMS;
    const query = searchQuery.toLowerCase().trim();
    return NAV_ITEMS.filter((item) => item.label.toLowerCase().includes(query));
  }, [searchQuery]);

  const handleProjectRemoved = useCallback(() => {
    setActiveNav('appearance');
  }, []);

  const renderPanel = () => {
    if (activeNav.startsWith('project:')) {
      const projectId = activeNav.slice(8);
      return (
        <ProjectPanel
          projectId={projectId as ProjectId}
          customIdes={config.customIdes}
          onProjectRemoved={handleProjectRemoved}
        />
      );
    }

    switch (activeNav) {
      case 'appearance':
        return (
          <AppearancePanel
            appearanceFontSize={config.appearanceFontSize}
            theme={config.theme}
            enablePiThemeSync={config.enablePiThemeSync}
            enableOpenCodeThemeSync={config.enableOpenCodeThemeSync}
            enableDevTools={config.enableDevTools}
            customThemes={customThemes}
            onAppearanceFontSizeChange={state.setAppearanceFontSize}
            onThemeChange={(theme) => onConfigChange({ ...config, theme })}
            onPiThemeSyncChange={(enabled) =>
              onConfigChange({ ...config, enablePiThemeSync: enabled })
            }
            onOpenCodeThemeSyncChange={(enabled) =>
              onConfigChange({ ...config, enableOpenCodeThemeSync: enabled })
            }
            onDevToolsChange={(enabled) => onConfigChange({ ...config, enableDevTools: enabled })}
          />
        );

      case 'editor':
        return (
          <EditorSettingsPanel
            config={config}
            onConfigChange={onConfigChange}
            agents={allAgents}
            onEditorFontSizeChange={state.setEditorFontSize}
          />
        );

      case 'lsp':
        return <LspPanel config={config} onConfigChange={onConfigChange} />;

      case 'terminal':
        return (
          <TerminalPanel
            terminalFontSize={config.terminalFontSize}
            fontFamily={config.monoFontFamily ?? config.fontFamily ?? ''}
            shellInput={state.shellInput}
            fontSearch={state.fontSearch}
            fontsLoading={state.fontsLoading}
            fontListOpen={state.fontListOpen}
            isCustomShell={state.isCustomShell}
            filteredFonts={state.filteredFonts}
            fontDropdownRef={state.fontDropdownRef}
            onTerminalFontSizeChange={state.setTerminalFontSize}
            onToggleFontList={() => state.setFontListOpen((value) => !value)}
            onFontSearchChange={state.setFontSearch}
            onApplyFont={state.applyFont}
            onRefreshFonts={state.refreshFonts}
            onShellInputChange={state.setShellInput}
            onApplyShell={state.applyShell}
            gpuAcceleration={config.terminalGpuAcceleration}
            onGpuAccelerationChange={state.setGpuAcceleration}
          />
        );

      case 'agents':
        return (
          <AgentsPanel
            config={config}
            builtinAgents={builtinAgents}
            editingPresetId={state.editingPresetId}
            editingValue={state.editingValue}
            skillPathEditingAgentId={state.skillPathEditingAgentId}
            skillPathInputValue={state.skillPathInputValue}
            onConfigChange={onConfigChange}
            onEditingValueChange={state.setEditingValue}
            onSkillPathInputValueChange={state.setSkillPathInputValue}
            onSaveAgent={(agent) => {
              void state.saveCustomAgent(agent);
            }}
            onRemoveAgent={(agentId) => {
              void state.removeCustomAgentById(agentId);
            }}
            onSaveBuiltinAgent={(agent) => {
              void state.saveBuiltinOverride(agent);
            }}
            onResetBuiltinAgent={(agentId) => {
              void state.resetBuiltinOverride(agentId);
            }}
            getEffectiveAgent={state.getEffectiveAgent}
            onStartEditAgent={state.startEditAgent}
            onSaveAgentOverride={state.saveAgentOverride}
            onCancelPresetEdit={state.cancelPresetEdit}
            getEffectiveAgentCommand={state.getEffectiveAgentCommand}
            onSelectSkillPath={(agent) => {
              void state.selectSkillPath(agent);
            }}
            onStartEditSkillPath={state.startEditSkillPath}
            onSaveSkillPath={state.saveSkillPath}
            onCancelSkillPathEdit={state.cancelSkillPathEdit}
          />
        );

      case 'ide':
        return (
          <IdePanel
            config={config}
            editingPresetId={state.editingPresetId}
            editingValue={state.editingValue}
            newIdeName={state.newIdeName}
            newIdeCommand={state.newIdeCommand}
            onConfigChange={onConfigChange}
            onEditingValueChange={state.setEditingValue}
            onNewIdeNameChange={state.setNewIdeName}
            onNewIdeCommandChange={state.setNewIdeCommand}
            onAddCustomIde={state.addCustomIde}
            onRemoveCustomIde={state.removeCustomIde}
            onStartEditPreset={state.startEditPreset}
            onSavePresetOverride={state.savePresetOverride}
            onCancelPresetEdit={state.cancelPresetEdit}
            getEffectiveCommand={state.getEffectiveCommand}
          />
        );

      case 'git':
        return <GitPanel diffMode={config.diffMode} onDiffModeChange={state.setDiffMode} />;

      case 'debug':
        return (
          <DebugPanel
            javaBackend={config.dap?.javaBackend ?? 'auto'}
            onJavaBackendChange={(javaBackend) =>
              onConfigChange({ ...config, dap: { ...config.dap, javaBackend } })
            }
          />
        );

      case 'shortcuts':
        return <ShortcutPanel config={config} onConfigChange={onConfigChange} />;

      case 'notifications':
        return <NotificationSettingsSection />;

      case 'about':
        return <AboutPanel />;

      default:
        return null;
    }
  };

  return (
    <Island className="flex-1" data-settings-view>
      <div className="flex flex-1 overflow-hidden">
        <SettingsSidebar
          onBack={handleBack}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          navItems={filteredNavItems}
          activeNav={activeNav}
          onSelectNav={setActiveNav}
          projects={projects}
        />

        {/* Right content area */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-8 px-10">
          <div className="max-w-[640px]">{renderPanel()}</div>
        </div>
      </div>
    </Island>
  );
}

export default React.memo(SettingsView);
