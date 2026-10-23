/**
 * AgentForm — 自定义 Agent 的编辑表单（数据对象 = AgentConfig）。
 *
 * 分组布局：身份 / CLI 执行 / 能力（CHAT + Headless）/ 部署。
 * 保存由**调用方**执行（经 `saveAgent` 统一落盘 + 刷新缓存）。
 */

import { open } from '@tauri-apps/plugin-dialog';
import React, { useCallback, useMemo, useState } from 'react';

import { cn } from '@/lib/utils';
import type { AgentConfig } from '@/shared/types/agent';
import { transportOf } from '@/shared/types/agent';
import { PRESET_AGENT_ICONS } from '@/shared/utils/agents';
import { Button, Input, Textarea } from '@/ui';

import { importAgentIcon, resolveAgentIconSrc } from '../api/agentApi';

import { buildChatLaunch, chatTransportLabel } from './agentFormChat';
import { emptyFormState, toFormState, toNullableArgs, type FormState } from './agentFormState';
import { trimArgList } from './argList';
import ArgListEditor from './ArgListEditor';
import CapabilityBadges from './CapabilityBadges';
import DeploySection from './DeploySection';

interface AgentFormProps {
  /** 编辑已有 Agent（缺省 = 新建）。 */
  initial?: AgentConfig | null;
  /** 提交回调 —— **负责落盘**（调用方统一走 `saveAgent`）。 */
  onSaved?: (agent: AgentConfig) => void | Promise<void>;
  onCancel?: () => void;
}

/**
 * argv 编辑器的占位符。
 *
 * **必须是模块常量**：`ArgListEditor` 包了 `React.memo`，而 memo 做的是逐 prop
 * 浅比较 —— 内联数组字面量每次渲染都是新引用，会让 memo 全程失效。把这几个
 * 字面量提到模块作用域，props 身份才稳定。
 */
const ARGS_PLACEHOLDERS = ['--flag', 'value'] as const;
const PROMPT_PLACEHOLDERS = ['-p', '--bare'] as const;
const POST_PROMPT_PLACEHOLDERS = ['--dangerously-skip-permissions'] as const;
const MODEL_LIST_PLACEHOLDERS = ['--list-models'] as const;
const CHAT_ARG_PLACEHOLDERS = ['acp'] as const;

const AgentForm: React.FC<AgentFormProps> = ({ initial, onSaved, onCancel }) => {
  const [t, setT] = useState<FormState>(() => (initial ? toFormState(initial) : emptyFormState()));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setT((prev) => ({ ...prev, [key]: value }));
  }, []);

  /** chat 首行占位符取决于 `command` —— 派生而非内联，否则 memo 再次失效。 */
  const chatPlaceholders = useMemo<readonly string[]>(
    () => (t.command ? [t.command] : CHAT_ARG_PLACEHOLDERS),
    [t.command],
  );

  /**
   * 每个 argv 字段的稳定 setter。
   *
   * `React.memo(ArgListEditor)` 只有在 `onChange` 身份稳定时才省下重渲染 ——
   * 内联箭头每次渲染都是新函数，memo 会全程失效。这些 setter 依赖恒定的 `set`，
   * 因此身份也是恒定的。
   */
  const argSetters = useMemo(
    () => ({
      args: (next: string[]) => set('args', next),
      chatArgv: (next: string[]) => set('chatArgv', next),
      promptArgs: (next: string[]) => set('promptArgs', next),
      postPromptArgs: (next: string[]) => set('postPromptArgs', next),
      modelListArgs: (next: string[]) => set('modelListArgs', next),
    }),
    [set],
  );

  /** 提交用的 chat（`null` = 无 CHAT 能力）。预览、校验、env 显隐都复用它，
   *  避免「判据说有能力、落库却是 null」的两套语义。 */
  const builtChat = useMemo(
    () => buildChatLaunch(trimArgList(t.chatArgv), t.chatEnvText, t.chatInprocess),
    [t.chatArgv, t.chatEnvText, t.chatInprocess],
  );

  /** 能力预览 —— `chat` 直接取提交值的真值，不存在第二套判据。 */
  const preview = useMemo(
    () => ({
      cli: t.command.trim().length > 0,
      chat: builtChat !== null,
      headless: trimArgList(t.promptArgs).length > 0,
    }),
    [t.command, t.promptArgs, builtChat],
  );

  /**
   * 该 agent 的 chat 传输是否**自带会话内模型目录**（`SessionConfig`）。
   *
   * ACP 与 PiRpc 都属此类：模型列表由协议在会话握手时下发，id 是裸名。
   * 此时 CLI 旁路（`model_list_args`）必须关闭 —— 它给的是 `provider/model`
   * 复合串，写回 `set_config_option` 会被拒（spec §10.5b 实测事故）。
   *
   * 注意判据**不是**「能否选模型」：`serve`（`PerTurn`）也能选模型，但它的
   * CLI 目录形状恰好与写回通道一致，必须保留（spec §10.5c）。
   */
  const chatIsSessionScoped = useMemo(() => {
    const transport = builtChat ? transportOf(builtChat) : null;
    return transport === 'acp' || transport === 'pi-rpc';
  }, [builtChat]);

  /** 识别结果只算一次（两次调用会在同一帧重复解析同一份 argv）。 */
  const transportLabel = useMemo(
    () => chatTransportLabel(trimArgList(t.chatArgv), t.chatInprocess),
    [t.chatArgv, t.chatInprocess],
  );

  /** 组装提交用的 AgentConfig。尾部未填的冗余空行在提交边界裁掉。 */
  const buildConfig = useCallback((): AgentConfig => {
    return {
      id: t.id.trim(),
      name: t.name.trim(),
      icon: t.icon || 'cli.svg',
      enabled: t.enabled,
      command: t.command.trim(),
      args: trimArgList(t.args),
      env: initial?.env ?? {},
      chat: builtChat,
      prompt_args: toNullableArgs(trimArgList(t.promptArgs)),
      post_prompt_args: toNullableArgs(trimArgList(t.postPromptArgs)),
      model_list_args: toNullableArgs(trimArgList(t.modelListArgs)),
      skill_path: t.skillPath.trim() || null,
      detection: t.detectionTarget.trim()
        ? { type: t.detectionType, target: t.detectionTarget.trim() }
        : null,
      deploy: {
        skills: t.deploySkills.trim() || '{{projectPath}}/.agent/skills',
        commands: t.deployCommands.trim() || null,
        mcp_config: t.deployMcp.trim() || null,
      },
    };
  }, [t, initial, builtChat]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (!t.id.trim()) {
        setError('Agent ID is required (lowercase letters, numbers, hyphens)');
        return;
      }
      if (!t.name.trim()) {
        setError('Agent name is required');
        return;
      }
      if (!t.command.trim() && builtChat === null) {
        setError('Requires at least one of Command (CLI) or CHAT capability');
        return;
      }
      setSaving(true);
      try {
        // 写路径归调用方（它才知道内置/自定义，也只有它能统一走 `saveAgent`）。
        // 表单自己调 `addAgent` 会造成一次保存两次 `add_agent`。
        await onSaved?.(buildConfig());
      } catch (err) {
        setError(String(err));
      } finally {
        setSaving(false);
      }
    },
    [t, buildConfig, onSaved, builtChat],
  );

  const handleUploadIcon = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: 'Images',
            extensions: ['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp', 'ico', 'bmp'],
          },
        ],
      });
      if (!selected) return;
      const iconPath = await importAgentIcon(selected);
      set('icon', iconPath);
    } catch (err) {
      console.error('[AgentForm] Failed to upload icon:', err);
    }
  }, [set]);

  const labelCls = 'text-[0.72em] text-text-muted font-medium';
  const groupCls = 'flex flex-col gap-1.5';
  const sectionTitle = 'text-[0.75em] font-semibold text-text-secondary uppercase tracking-wider';

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      {/* ── Header: title + capability preview ─────────────────────────── */}
      <div className="flex items-center justify-between gap-2">
        <div className="text-[0.86em] font-semibold text-text-primary">
          {initial
            ? initial.is_builtin
              ? `Edit Built-in Agent · ${initial.id}`
              : `Edit Agent · ${initial.id}`
            : 'Create Custom Agent'}
        </div>
        <CapabilityBadges
          agent={{
            command: preview.cli ? t.command : '',
            chat: builtChat,
            prompt_args: preview.headless ? [] : null,
          }}
        />
      </div>

      {initial?.is_builtin && (
        <div className="text-[0.72em] text-text-muted bg-bg-secondary/50 border border-border/60 rounded px-2 py-1">
          Edits are saved as an override. Use Reset in the settings list to restore the factory
          default.
        </div>
      )}

      {error && (
        <div className="text-[0.78em] text-accent-red bg-accent-red/10 border border-accent-red/20 px-2 py-1 rounded">
          {error}
        </div>
      )}

      {/* ── Identity ──────────────────────────────────────────────────── */}
      <div className="border border-border rounded-lg bg-bg-primary overflow-hidden">
        <div className={cn(sectionTitle, 'px-3 pt-2 pb-1.5 bg-bg-secondary/40')}>Identity</div>
        <div className="p-3 pt-2 grid grid-cols-2 gap-2">
          <div className={groupCls}>
            <label className={labelCls} htmlFor="agent-form-id">
              ID *
            </label>
            <Input
              id="agent-form-id"
              size="sm"
              value={t.id}
              disabled={Boolean(initial)}
              onChange={(e) => set('id', e.target.value.trim())}
              placeholder="my-agent"
            />
          </div>
          <div className={groupCls}>
            <label className={labelCls} htmlFor="agent-form-name">
              Name *
            </label>
            <Input
              id="agent-form-name"
              size="sm"
              value={t.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="My Agent"
            />
          </div>
        </div>
        <div className="px-3 pb-3 -mt-1 flex items-center gap-2">
          <span className={labelCls}>Icon:</span>
          <div className="flex items-center gap-1 flex-wrap">
            {PRESET_AGENT_ICONS.map((iconName) => (
              <button
                key={iconName}
                type="button"
                className={cn(
                  'size-6 rounded flex items-center justify-center border transition-colors',
                  t.icon === iconName
                    ? 'border-accent-blue bg-accent-blue/10'
                    : 'border-transparent hover:bg-bg-hover',
                )}
                onClick={() => set('icon', iconName)}
                title={iconName}
              >
                <img
                  src={resolveAgentIconSrc(iconName) ?? undefined}
                  className="size-3.5 object-contain"
                  alt=""
                />
              </button>
            ))}
            <span className="text-text-muted mx-0.5 select-none">|</span>
            <button
              type="button"
              className="text-[0.75em] text-accent-blue hover:underline px-1 py-0.5"
              onClick={handleUploadIcon}
              title="Upload custom icon"
            >
              Upload
            </button>
          </div>
        </div>
      </div>

      {/* ── CLI Execution ────────────────────────────────────────────── */}
      <div className="border border-border rounded-lg bg-bg-primary overflow-hidden">
        <div className={cn(sectionTitle, 'px-3 pt-2 pb-1.5 bg-bg-secondary/40')}>CLI Execution</div>
        <div className="p-3 pt-2 grid grid-cols-2 gap-2">
          <div className={groupCls}>
            <label className={labelCls} htmlFor="agent-form-command">
              Command * (terminal TUI launch)
            </label>
            <Input
              id="agent-form-command"
              size="sm"
              value={t.command}
              onChange={(e) => set('command', e.target.value)}
              placeholder="myagent"
            />
          </div>
          <div className={groupCls}>
            <span className={labelCls}>Args (one per line)</span>
            <ArgListEditor
              value={t.args}
              onChange={argSetters.args}
              placeholders={ARGS_PLACEHOLDERS}
            />
          </div>
        </div>
        <div className="px-3 pb-3 -mt-0.5">
          <span className="text-[0.7em] text-text-muted">
            Leave Command empty for no CLI capability (e.g. in-process CHAT-only agents).
          </span>
        </div>
      </div>

      {/* ── Capabilities: CHAT + Headless ────────────────────────────── */}
      <div className="border border-border rounded-lg bg-bg-primary overflow-hidden">
        <div className={cn(sectionTitle, 'px-3 pt-2 pb-1.5 bg-bg-secondary/40')}>Capabilities</div>
        <div className="p-3 pt-2 flex flex-col gap-2">
          {/* CHAT 启动配置：argv（程序名 + 参数各一行）+ 环境变量。
              没有传输下拉 —— 传输由 argv 识别（`chatTransportLabel`）。 */}
          <div className={groupCls}>
            <span className={labelCls}>CHAT Launch (first = program · empty = no CHAT)</span>
            <ArgListEditor
              value={t.chatArgv}
              onChange={argSetters.chatArgv}
              placeholders={chatPlaceholders}
              disabled={t.chatInprocess}
              inputClassName="bg-bg-secondary"
            />
          </div>
          {/* 进程内实现没有 argv 可填，但**确有** CHAT 能力 —— 两者必须显式区分。 */}
          <label className="flex items-center gap-1.5 text-[0.72em] text-text-muted">
            <input
              type="checkbox"
              checked={t.chatInprocess}
              onChange={(e) => set('chatInprocess', e.target.checked)}
            />
            In-process (no subprocess · e.g. mockAgent)
          </label>
          {transportLabel && (
            <div className="text-[0.7em] text-text-muted -mt-1">Detected: {transportLabel}</div>
          )}
          {builtChat !== null && (
            <div className={groupCls}>
              <label className={labelCls} htmlFor="agent-form-chat-env">
                CHAT Env (one KEY=value per line)
              </label>
              <Textarea
                id="agent-form-chat-env"
                value={t.chatEnvText}
                onChange={(e) => set('chatEnvText', e.target.value)}
                rows={2}
                placeholder={'ANTHROPIC_API_KEY=sk-…'}
                className="bg-bg-secondary text-[0.82em] min-h-0 py-1"
              />
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <div className={groupCls}>
              <span className={labelCls}>Prompt Args (Headless · one per line)</span>
              <ArgListEditor
                value={t.promptArgs}
                onChange={argSetters.promptArgs}
                placeholders={PROMPT_PLACEHOLDERS}
              />
            </div>
            <div className={groupCls}>
              <span className={labelCls}>Post Prompt Args (one per line)</span>
              <ArgListEditor
                value={t.postPromptArgs}
                onChange={argSetters.postPromptArgs}
                placeholders={POST_PROMPT_PLACEHOLDERS}
              />
            </div>
            <div className={groupCls}>
              {chatIsSessionScoped ? (
                <>
                  <span className={labelCls}>List Models Args</span>
                  <p className="text-[0.7em] text-text-muted leading-relaxed">
                    The model list comes from the agent protocol. A CLI list would return
                    <code className="mx-1 font-mono">provider/model</code>
                    ids that cannot be written back, so this field is disabled here.
                  </p>
                </>
              ) : (
                <>
                  <span className={labelCls}>List Models Args (one per line)</span>
                  {/* 空列表时编辑器不渲染输入框（只有「+ Add」），所以用容器
                      上的 `aria-label` 作为「该字段存在」的可定位判据。 */}
                  <div role="group" aria-label="List Models Args">
                    <ArgListEditor
                      value={t.modelListArgs}
                      onChange={argSetters.modelListArgs}
                      placeholders={MODEL_LIST_PLACEHOLDERS}
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <DeploySection t={t} set={set} />

      {/* ── Footer: enabled + actions ────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-[0.82em] text-text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={t.enabled}
            onChange={(e) => set('enabled', e.target.checked)}
            className="accent-accent-blue size-3.5"
          />
          Enabled
        </label>
        <div className="flex gap-2">
          {onCancel && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCancel}
              className="text-[0.82em]"
            >
              Cancel
            </Button>
          )}
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={saving}
            className="text-[0.82em]"
          >
            {saving ? 'Saving…' : initial ? 'Save Agent' : 'Create Agent'}
          </Button>
        </div>
      </div>
    </form>
  );
};

export default React.memo(AgentForm);
