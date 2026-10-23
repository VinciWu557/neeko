import { Pencil } from 'lucide-react';
import React, { useState } from 'react';

import { AgentForm, CapabilityBadges } from '@/features/agent';
import { cn } from '@/lib/utils';
import { FolderIcon } from '@/shared/components/icons';
import type { AgentConfig } from '@/shared/types';
import { getAgentIconSrc } from '@/shared/utils/agents';
import { Input } from '@/ui';

interface BuiltInAgentsSectionProps {
  builtinAgents: AgentConfig[];
  skillPathEditingAgentId: string | null;
  skillPathInputValue: string;
  onSkillPathInputValueChange: (value: string) => void;
  /** 内置 agent 的有效配置（来自 `agentStore` 的后端快照）。 */
  getEffectiveAgent: (agent: AgentConfig) => AgentConfig;
  /** 保存内置覆盖（后端覆盖层 → 刷新 agentStore）。 */
  /** 保存内置 agent 覆盖（落盘 + 刷新缓存）。 */
  onSaveBuiltinAgent: (agent: AgentConfig) => Promise<void>;
  /** 重置内置覆盖（恢复出厂）。 */
  onResetBuiltinAgent: (agentId: string) => void;
  onSelectSkillPath: (agent: AgentConfig) => void;
  onStartEditSkillPath: (agentId: string, currentPath: string) => void;
  onSaveSkillPath: (agent: AgentConfig) => void;
  onCancelSkillPathEdit: () => void;
}

const BuiltInAgentsSection: React.FC<BuiltInAgentsSectionProps> = ({
  builtinAgents,
  skillPathEditingAgentId,
  skillPathInputValue,
  onSkillPathInputValueChange,
  getEffectiveAgent,
  onSaveBuiltinAgent,
  onResetBuiltinAgent,
  onSelectSkillPath,
  onStartEditSkillPath,
  onSaveSkillPath,
  onCancelSkillPathEdit,
}) => {
  /** 正在通过 AgentForm 编辑的内置 agent（null = 未在编辑）。 */
  const [editingBuiltin, setEditingBuiltin] = useState<AgentConfig | null>(null);

  // 「是否被覆盖」来自后端快照的 `is_overridden`（`AgentManager` 的覆盖表派生），
  // 前端不保管键集合。
  const isAgentOverridden = (agent: AgentConfig) => agent.is_overridden === true;

  // Reset 只需清后端的覆盖层 —— `resetAgent` 落盘后会刷新 agentStore，
  // 界面随之回到出厂值。前端不再维护副本，所以这里没有要同步的第二处。
  const handleReset = (agent: AgentConfig) => {
    onResetBuiltinAgent(agent.id);
  };

  return (
    <div className="flex flex-col items-start gap-3 py-3 border-b border-white/[0.04] [&:last-child]:border-b-0">
      <div className="flex-1 min-w-0">
        <div className="text-[0.86em] text-text-primary font-medium mb-0.75">Built-in Agents</div>
        <div className="text-[0.79em] text-text-muted leading-relaxed">
          Pre-configured AI agent CLIs. Edit saves an override; Reset restores the factory default.
        </div>
      </div>

      {editingBuiltin && (
        <div className="w-full border border-border rounded-lg bg-bg-primary overflow-hidden">
          <AgentForm
            initial={getEffectiveAgent(editingBuiltin)}
            onSaved={async (agent) => {
              await onSaveBuiltinAgent(agent);
              setEditingBuiltin(null);
            }}
            onCancel={() => setEditingBuiltin(null)}
          />
        </div>
      )}

      <div className="w-full border border-border rounded overflow-hidden bg-bg-primary">
        {builtinAgents.map((agent) => {
          const effectiveAgent = getEffectiveAgent(agent);
          const iconSrc = getAgentIconSrc(effectiveAgent.icon);
          const isOverridden = isAgentOverridden(agent);
          const skillPathValue = effectiveAgent.skill_path ?? '';
          const hasSkillPath = !!skillPathValue;

          return (
            <React.Fragment key={agent.id}>
              <div className="flex items-center gap-2.5 py-[7px] px-3 border-b border-white/[0.03] text-[0.86em]">
                {iconSrc ? (
                  <img
                    src={iconSrc}
                    className="text-[var(--font-size)] size-[18px] object-contain"
                    alt=""
                  />
                ) : (
                  <span className="text-[0.93em] size-[18px] text-center shrink-0 object-contain">
                    {''}
                  </span>
                )}

                <span className="text-text-primary font-medium min-w-[100px] shrink-0">
                  {effectiveAgent.name}
                </span>

                <span
                  className={cn(
                    'text-text-muted font-mono text-[0.82em] flex-1 min-w-[80px] overflow-hidden text-ellipsis whitespace-nowrap',
                    isOverridden && '!text-accent-blue',
                  )}
                  title="Edit via the pencil button"
                >
                  {effectiveAgent.command}
                </span>

                <CapabilityBadges agent={effectiveAgent} className="shrink-0" />

                <button
                  className="bg-none border-none text-text-muted cursor-pointer p-1 rounded shrink-0 transition-colors duration-150 hover:text-accent-blue hover:bg-bg-hover"
                  onClick={() => setEditingBuiltin(agent)}
                  title="Edit built-in agent"
                >
                  <Pencil size={13} />
                </button>

                {isOverridden && (
                  <button
                    className="bg-none border-none text-text-muted cursor-pointer text-[0.93em] py-0.5 px-1 rounded shrink-0 transition-colors duration-150 leading-none hover:text-accent-blue"
                    title="Reset to default"
                    onClick={() => handleReset(agent)}
                  >
                    &#x21BA;
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2.5 py-[5px] px-3 pb-2 border-b border-white/[0.03] text-[0.79em] [&:last-child]:border-b-0 bg-bg-secondary/30">
                <span className="w-[18px] shrink-0" />
                <span className="text-text-muted min-w-[100px] shrink-0">Skill Path:</span>
                <button
                  type="button"
                  className="bg-none border-none text-text-muted cursor-pointer p-1 rounded shrink-0 transition-colors duration-150 hover:text-accent-blue"
                  title="Select folder"
                  onClick={() => onSelectSkillPath(agent)}
                >
                  <FolderIcon size={14} />
                </button>

                {skillPathEditingAgentId === agent.id ? (
                  <Input
                    className="flex-1 min-w-0 py-0.5 px-1.5 text-[0.82em]"
                    value={skillPathInputValue}
                    spellCheck={false}
                    onChange={(e) => onSkillPathInputValueChange(e.target.value)}
                    onBlur={() => onSaveSkillPath(agent)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        onSaveSkillPath(agent);
                      }
                      if (e.key === 'Escape') {
                        onCancelSkillPathEdit();
                      }
                    }}
                  />
                ) : (
                  <span
                    role="button"
                    tabIndex={0}
                    className={cn(
                      'text-text-muted font-mono flex-1 overflow-hidden text-ellipsis whitespace-nowrap cursor-text rounded py-px px-1 hover:bg-bg-hover',
                      !hasSkillPath && 'italic',
                    )}
                    title="Click to edit"
                    onClick={() => onStartEditSkillPath(agent.id, skillPathValue || '')}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onStartEditSkillPath(agent.id, skillPathValue || '');
                      }
                    }}
                  >
                    {hasSkillPath ? skillPathValue : effectiveAgent.skill_path || 'Not set'}
                  </span>
                )}
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};

export default React.memo(BuiltInAgentsSection);
