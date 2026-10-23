import React from 'react';

import type { AgentConfig, AppConfig } from '@/shared/types';
import { Switch } from '@/ui';

import BuiltInAgentsSection from './BuiltInAgentsSection';
import CustomAgentsSection from './CustomAgentsSection';

interface AgentsPanelProps {
  config: AppConfig;
  builtinAgents: AgentConfig[];
  skillPathEditingAgentId: string | null;
  skillPathInputValue: string;
  onConfigChange: (next: AppConfig) => void;
  onSkillPathInputValueChange: (value: string) => void;
  onSaveAgent: (agent: AgentConfig) => Promise<void>;
  onRemoveAgent: (agentId: string) => void;
  onSaveBuiltinAgent: (agent: AgentConfig) => Promise<void>;
  onResetBuiltinAgent: (agentId: string) => void;
  getEffectiveAgent: (agent: AgentConfig) => AgentConfig;
  onSelectSkillPath: (agent: AgentConfig) => void;
  onStartEditSkillPath: (agentId: string, currentPath: string) => void;
  onSaveSkillPath: (agent: AgentConfig) => void;
  onCancelSkillPathEdit: () => void;
}

const AgentsPanel: React.FC<AgentsPanelProps> = ({
  config,
  builtinAgents,
  skillPathEditingAgentId,
  skillPathInputValue,
  onConfigChange,
  onSkillPathInputValueChange,
  onSaveAgent,
  onRemoveAgent,
  onSaveBuiltinAgent,
  onResetBuiltinAgent,
  getEffectiveAgent,
  onSelectSkillPath,
  onStartEditSkillPath,
  onSaveSkillPath,
  onCancelSkillPathEdit,
}) => {
  return (
    <>
      <h3 className="text-base font-semibold text-text-primary mb-4">Agents</h3>

      <div className="flex flex-col items-start gap-3 py-3 border-b border-white/[0.04]">
        <div className="flex-1 min-w-0">
          <div className="text-[0.86em] text-text-primary font-medium mb-0.75">Show Agent Bar</div>
          <div className="text-[0.79em] text-text-muted leading-relaxed">
            Display agent buttons in the title bar for quick selection.
          </div>
        </div>
        <Switch
          checked={config.agentSelectorShowPresetBar !== false}
          onCheckedChange={(checked) =>
            onConfigChange({
              ...config,
              agentSelectorShowPresetBar: checked,
            })
          }
        />
      </div>

      <div className="flex flex-col items-start gap-3 py-3 border-b border-white/[0.04]">
        <div className="flex-1 min-w-0">
          <div className="text-[0.86em] text-text-primary font-medium mb-0.75">Compact Mode</div>
          <div className="text-[0.79em] text-text-muted leading-relaxed">
            Show only icons in the agent bar.
          </div>
        </div>
        <Switch
          checked={config.agentSelectorCompactMode}
          onCheckedChange={(checked) =>
            onConfigChange({
              ...config,
              agentSelectorCompactMode: checked,
            })
          }
        />
      </div>

      {/* ── Built-in Agents ───────────────────────────────────────────── */}
      <BuiltInAgentsSection
        builtinAgents={builtinAgents}
        skillPathEditingAgentId={skillPathEditingAgentId}
        skillPathInputValue={skillPathInputValue}
        onSkillPathInputValueChange={onSkillPathInputValueChange}
        getEffectiveAgent={getEffectiveAgent}
        onSaveBuiltinAgent={onSaveBuiltinAgent}
        onResetBuiltinAgent={onResetBuiltinAgent}
        onSelectSkillPath={onSelectSkillPath}
        onStartEditSkillPath={onStartEditSkillPath}
        onSaveSkillPath={onSaveSkillPath}
        onCancelSkillPathEdit={onCancelSkillPathEdit}
      />

      <CustomAgentsSection
        skillPathEditingAgentId={skillPathEditingAgentId}
        skillPathInputValue={skillPathInputValue}
        onSkillPathInputValueChange={onSkillPathInputValueChange}
        onSaveAgent={onSaveAgent}
        onRemoveAgent={onRemoveAgent}
        onSelectSkillPath={onSelectSkillPath}
        onStartEditSkillPath={onStartEditSkillPath}
        onSaveSkillPath={onSaveSkillPath}
        onCancelSkillPathEdit={onCancelSkillPathEdit}
      />
    </>
  );
};

export default React.memo(AgentsPanel);
