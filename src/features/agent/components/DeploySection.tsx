import React from 'react';

import { cn } from '@/lib/utils';
import { Input } from '@/ui';

import type { FormState } from './agentFormState';

/**
 * Agent 表单的 Deploy 区块（skills / commands / MCP 模板 + skill path + 安装检测）。
 *
 * 抽成独立组件而不是内联在 `AgentForm` 里：后者受 `check_component_size` 的
 * ratchet 约束（只许缩小），而这段 UI 有独立的语义边界（部署产物落点 +
 * 安装检测），本就该自成一体。
 */
interface DeploySectionProps {
  t: FormState;
  set: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
}

const fieldGroup = 'flex flex-col gap-1.5';
const label = 'text-[0.72em] text-text-muted font-medium';

const DeploySection: React.FC<DeploySectionProps> = ({ t, set }) => {
  return (
    <div className="border border-border rounded-lg bg-bg-primary overflow-hidden">
      <div
        className={cn(
          'text-[0.75em] font-semibold text-text-secondary uppercase tracking-wider',
          'px-3 pt-2 pb-1.5 bg-bg-secondary/40',
        )}
      >
        Deploy
      </div>
      <div className="p-3 pt-2 flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-2">
          <div className={fieldGroup}>
            <label className={label} htmlFor="agent-form-deploy-skills">
              Skills Template (supports {'{{'}projectPath{'}}'})
            </label>
            <Input
              id="agent-form-deploy-skills"
              size="sm"
              value={t.deploySkills}
              onChange={(e) => set('deploySkills', e.target.value)}
            />
          </div>
          <div className={fieldGroup}>
            <label className={label} htmlFor="agent-form-deploy-commands">
              Commands Template (optional)
            </label>
            <Input
              id="agent-form-deploy-commands"
              size="sm"
              value={t.deployCommands}
              onChange={(e) => set('deployCommands', e.target.value)}
              placeholder="None (command deploy unsupported)"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className={fieldGroup}>
            <label className={label} htmlFor="agent-form-deploy-mcp">
              MCP Config Template (optional)
            </label>
            <Input
              id="agent-form-deploy-mcp"
              size="sm"
              value={t.deployMcp}
              onChange={(e) => set('deployMcp', e.target.value)}
              placeholder="None (MCP deploy unsupported)"
            />
          </div>
          <div className={fieldGroup}>
            <label className={label} htmlFor="agent-form-skill-path">
              Global Skill Path (optional override)
            </label>
            <Input
              id="agent-form-skill-path"
              size="sm"
              value={t.skillPath}
              onChange={(e) => set('skillPath', e.target.value)}
              placeholder="~/.my-agent/skills"
            />
          </div>
        </div>
        <div className={fieldGroup}>
          <label className={label} htmlFor="agent-form-detection">
            Install detection command (optional · considered installed if found in PATH)
          </label>
          <Input
            id="agent-form-detection"
            size="sm"
            value={t.detectionCmd}
            onChange={(e) => set('detectionCmd', e.target.value)}
            placeholder="myagent (empty = always considered installed)"
          />
        </div>
      </div>
    </div>
  );
};

export default React.memo(DeploySection);
