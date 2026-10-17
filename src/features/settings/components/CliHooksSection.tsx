/**
 * 外部 Agent CLI hooks 分区（从 `NotificationSettingsSection` 抽出，见组件规模红线 ≤300 行）。
 *
 * 职责边界：本组件只拥有「CLI hook 的开关面与状态呈现」——
 * - 主开关（`NotificationSettings.cliHooks`，通知核心域的**意图**字段）的持久化由父组件承担
 *   （它持有设置串行链），本组件通过 `onMasterChange` 回调请求变更；
 * - 逐 CLI 覆盖（`config.json` 的 `agentHookSources`）与文件面同步（`agent_hooks_apply`）
 *   是 agent 域的知识，**完整收在本组件内**（父组件不该知道这些细节）。
 *
 * 为什么逐 CLI 行是数据驱动的：行清单来自 `agent_hooks_status`（后端事实表 `HOOK_TARGETS`），
 * 新增一个受管 CLI 无需改本文件 —— 与 `NOTIFIABLE_EVENTS` 同一哲学。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

import { applyCliHooks, getCliHookStatus } from '@/features/notification/api/notificationApi';
import { loadConfig, saveConfig } from '@/features/settings/api/settingsApi';
import { useNotify } from '@/shared/hooks/useNotify';
import type { HookApplyOutcome, HookInstallStatus } from '@/shared/types/notification';
import { Switch } from '@/ui';

/** `config.json` 中承载逐 CLI hook 开关的键（镜像 `agent/hooks/settings.rs`）。 */
const AGENT_HOOK_SOURCES_KEY = 'agentHookSources';

/** 回执呈现文案：`pi: skipped (…)` —— status 是判定源，detail 只做补充。 */
function describeOutcome(outcome: HookApplyOutcome): string {
  return outcome.detail
    ? `${outcome.source}: ${outcome.status} (${outcome.detail})`
    : `${outcome.source}: ${outcome.status}`;
}

/**
 * 读逐 CLI 覆盖表（畸形容忍：非对象 / 值非布尔 → 忽略）。
 * 键缺失 ⇒ 该 CLI 跟随主开关（默认启用）—— 与 Rust `hook_enabled_for` 同语义。
 */
export function readSourceOverrides(config: Record<string, unknown>): Record<string, boolean> {
  const raw = config[AGENT_HOOK_SOURCES_KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/**
 * 状态行文案：**把「装了但不生效」说出来**。
 *
 * 为什么单独一个函数：`trusted === false` 是本项目反复出现的「装了但没通知」形态的
 * 显式编码 —— Codex 对未信任的 `hooks.json` hook **静默跳过且不报错**，若 UI 只显示
 * 「已安装」，用户会以为审批通知已生效。此处必须如实提示需要用户去 CLI 里确认一次。
 */
export function describeHookStatus(hook: HookInstallStatus): string {
  if (hook.installed && hook.trusted === false) {
    return `${hook.path} — needs confirmation in the CLI`;
  }
  if (!hook.installed) return 'not installed';
  return hook.versionCurrent ? hook.path : `${hook.path} (outdated)`;
}

/**
 * 按主开关 + 覆盖表算出「应处于安装态」的 CLI 集合（`null` = 全部启用）。
 *
 * `known` 为空 = 状态查询失败（api 门面失败回空列表）→ 回退 `null` 而非空集 ——
 * 空集会让 Rust 侧把已装 hook 全卸掉。
 */
export function enabledSourcesFor(
  master: boolean,
  known: HookInstallStatus[],
  overrides: Record<string, boolean>,
): string[] | null {
  if (!master || known.length === 0) return null;
  return known.map((h) => h.source).filter((s) => overrides[s] !== false);
}

interface CliHooksSectionProps {
  /** 主开关当前值（来自父组件的设置快照）。 */
  master: boolean;
  /** 请求父组件变更主开关（走它的串行保存链）。 */
  onMasterChange: (checked: boolean) => void;
  /** 主开关写入完成后由父组件调用，用于触发文件面同步。 */
  syncToken?: number;
}

const CliHooksSection: React.FC<CliHooksSectionProps> = ({
  master,
  onMasterChange,
  syncToken = 0,
}) => {
  const [hookStatus, setHookStatus] = useState<HookInstallStatus[]>([]);
  const [sourceOverrides, setSourceOverrides] = useState<Record<string, boolean>>({});
  /** 逐 CLI 变更的串行链（与父组件的设置链相互独立：写的是不同 config 键）。 */
  const chain = useRef<Promise<void>>(Promise.resolve());
  const { notify } = useNotify();

  useEffect(() => {
    let alive = true;
    void getCliHookStatus().then((s) => {
      if (alive) setHookStatus(s);
    });
    void loadConfig()
      .then((cfg) => {
        if (alive) setSourceOverrides(readSourceOverrides(cfg));
      })
      .catch(() => {
        /* 读盘失败 ⇒ 全部跟随主开关（默认启用），不阻断设置页渲染 */
      });
    return () => {
      alive = false;
    };
  }, []);

  /** 同步文件面：把生效集合交给 agent 域命令，并按机器可读 status 分类提示。 */
  const syncHooks = useCallback(
    async (nextMaster: boolean, overrides: Record<string, boolean>) => {
      const results = await applyCliHooks(
        nextMaster,
        enabledSourcesFor(nextMaster, hookStatus, overrides),
      );
      setHookStatus(await getCliHookStatus());
      const failed = results.filter((r) => r.status === 'failed');
      const skipped = results.filter((r) => r.status === 'skipped');
      if (failed.length) {
        notify(`CLI hooks: ${failed.map(describeOutcome).join('; ')}`, 'error');
      } else if (skipped.length) {
        // 中性状态（同名他人文件保护 / 用户配置不可处理等）：如实呈现，不弹错误。
        notify(`CLI hooks: ${skipped.map(describeOutcome).join('; ')}`, 'info');
      } else {
        notify('CLI hooks updated', 'info');
      }
    },
    [hookStatus, notify],
  );

  /**
   * 主开关变更后由父组件驱动同步（`syncToken` 每次递增）。
   *
   * 用 token 而非把 `syncHooks` 上抛：父组件只该知道「我改了意图」，不该知道
   * 「还要调 agent 域命令」——后者是本分区的内部知识。
   */
  const lastToken = useRef(syncToken);
  useEffect(() => {
    if (syncToken === lastToken.current) return;
    lastToken.current = syncToken;
    chain.current = chain.current.then(() => syncHooks(master, sourceOverrides)).catch(() => {});
  }, [syncToken, master, sourceOverrides, syncHooks]);

  /** 逐 CLI 开关：写 `agentHookSources` + 立即重同步文件面。 */
  const toggleSource = useCallback(
    (source: string, checked: boolean) => {
      const nextOverrides = { ...sourceOverrides, [source]: checked };
      setSourceOverrides(nextOverrides);
      chain.current = chain.current
        .then(async () => {
          // 串行化与读盘合并由写点（`useAppConfig.saveConfig`）负责 ——
          // 此处再包 `runConfigWrite` 会在队列内二次入队，自我等待成死锁。
          await saveConfig({ [AGENT_HOOK_SOURCES_KEY]: nextOverrides });
          if (master) await syncHooks(master, nextOverrides);
        })
        .catch(async () => {
          const cfg = await loadConfig().catch(() => ({}));
          setSourceOverrides(readSourceOverrides(cfg));
          notify('Failed to save CLI hook selection', 'error');
        });
    },
    [sourceOverrides, master, notify, syncHooks],
  );

  return (
    <>
      <div className="text-[0.86em] text-text-primary font-medium mt-3 mb-1">
        External agent CLI hooks
      </div>
      <div className="flex items-start justify-between gap-4 py-2 border-b border-white/[0.04]">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-[0.86em] text-text-primary">
            Notify agents launched in my terminal
          </span>
          <span className="text-[0.72em] text-text-muted">
            Installs a status reporter into each CLI&apos;s own config dir (never overwrites other
            tools&apos; entries)
          </span>
        </div>
        <div className="shrink-0 pt-0.5">
          <Switch
            aria-label="Notify agents launched in my terminal"
            checked={master}
            onCheckedChange={onMasterChange}
          />
        </div>
      </div>
      {master &&
        hookStatus.map((hook) => (
          <div
            key={hook.source}
            className="flex items-start justify-between gap-4 py-2 border-b border-white/[0.04]"
          >
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-[0.86em] text-text-primary">{hook.source}</span>
              <span className="text-[0.72em] text-text-muted truncate">
                {describeHookStatus(hook)}
              </span>
            </div>
            <div className="shrink-0 pt-0.5">
              <Switch
                aria-label={`Install hook for ${hook.source}`}
                checked={sourceOverrides[hook.source] !== false}
                onCheckedChange={(checked) => void toggleSource(hook.source, checked)}
              />
            </div>
          </div>
        ))}
    </>
  );
};

export default React.memo(CliHooksSection);
