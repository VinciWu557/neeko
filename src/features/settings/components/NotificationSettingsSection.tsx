/**
 * 通知设置分区（prd R4）。
 *
 * 三层开关的 UI 映射（全局 → 语义类别 → 事件覆盖）：
 * - 类别开关写 `settings.actionRequired/completed/failed`；
 * - 事件行为数据驱动（`NOTIFIABLE_EVENTS` 清单，新业务加一行数据即可，本组件零改动）；
 *   勾选状态 = `eventOverrides[key] ?? 类别开关`（显式覆盖优先，与 Rust `event_enabled` 同语义）；
 *   未显式覆盖的事件在勾选变更时写入显式布尔值。
 * 持久化走既有 config.json 域薄命令；保存失败回滚本地态并提示。
 */

import { BellOff, Check } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import {
  applyCliHooks,
  getCliHookStatus,
  getNotificationSettings,
  saveNotificationSettings,
  sendTestNotification,
} from '@/features/notification/api/notificationApi';
import { useNotify } from '@/shared/hooks/useNotify';
import {
  NOTIFIABLE_EVENTS,
  type HookApplyOutcome,
  type HookInstallStatus,
  type NotificationClass,
  type NotificationSettings,
} from '@/shared/types/notification';
import { Button, Switch } from '@/ui';

/** 类别开关字段与展示名（与后端三层开关第二层一一对应）。 */
const CLASS_ROWS: Array<{ field: 'actionRequired' | 'completed' | 'failed'; label: string }> = [
  { field: 'actionRequired', label: 'Action required (approval / input)' },
  { field: 'completed', label: 'Task completed' },
  { field: 'failed', label: 'Session failed' },
];

/** 事件行对应的语义类别开关字段（继承默认值的判定源）。 */
const EVENT_CLASS: Record<(typeof NOTIFIABLE_EVENTS)[number]['key'], NotificationClass> = {
  'agent.approval_requested': 'action_required',
  'agent.input_requested': 'action_required',
  'agent.turn_completed': 'completed',
  'agent.session_failed': 'failed',
};

function classFieldForClass(c: NotificationClass): 'actionRequired' | 'completed' | 'failed' {
  if (c === 'action_required') return 'actionRequired';
  if (c === 'completed') return 'completed';
  return 'failed';
}

/** 回执呈现文案：`pi: skipped (…)` —— status 是判定源，detail 只做补充。 */
function describeOutcome(outcome: HookApplyOutcome): string {
  return outcome.detail
    ? `${outcome.source}: ${outcome.status} (${outcome.detail})`
    : `${outcome.source}: ${outcome.status}`;
}

const NotificationSettingsSection: React.FC = () => {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [hookStatus, setHookStatus] = useState<HookInstallStatus[]>([]);
  /**
   * 变更即保存，但保存**串行**（saveChain）：后端 `save` 是 config.json 的
   * load-modify-save RMW，并发交叠会让后完成的旧值覆盖新值（丢更新）。
   * 基线取 ref（渲染期闭包在快速连点下是旧值），失败回读磁盘现值 —— 单一事实源在磁盘。
   */
  const settingsRef = useRef<NotificationSettings | null>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const { notify } = useNotify();

  const publish = useCallback((next: NotificationSettings) => {
    settingsRef.current = next;
    setSettings(next);
  }, []);

  useEffect(() => {
    let alive = true;
    void getNotificationSettings().then((s) => {
      if (alive) publish(s);
    });
    void getCliHookStatus().then((s) => {
      if (alive) setHookStatus(s);
    });
    return () => {
      alive = false;
    };
  }, [publish]);

  const update = useCallback(
    (patch: Partial<NotificationSettings>) => {
      const base = settingsRef.current;
      if (!base) return;
      const next = { ...base, ...patch };
      publish(next);
      const hooksToggled = patch.cliHooks !== undefined && patch.cliHooks !== base.cliHooks;
      saveChain.current = saveChain.current
        .then(async () => {
          await saveNotificationSettings(next);
          // 开关变更后联动文件面（agent 域命令）：先持久化意图，再安装/卸载 —— 顺序即
          // 「设置是意图、文件是事实」的收敛方向；失败时把意图回滚为磁盘前值并提示。
          if (hooksToggled) {
            const results = await applyCliHooks(next.cliHooks);
            setHookStatus(await getCliHookStatus());
            const failed = results.filter((r) => r.status === 'failed');
            const skipped = results.filter((r) => r.status === 'skipped');
            if (failed.length) {
              notify(`CLI hooks: ${failed.map(describeOutcome).join('; ')}`, 'error');
            } else if (skipped.length) {
              // 中性状态（同名他人文件保护等）：如实呈现，不弹错误。
              notify(`CLI hooks: ${skipped.map(describeOutcome).join('; ')}`, 'info');
            } else {
              notify('CLI hooks updated', 'info');
            }
          }
        })
        .catch(async () => {
          const current = await getNotificationSettings();
          publish(current);
          notify('Failed to save notification settings', 'error');
        });
    },
    [publish, notify],
  );

  const toggleEvent = useCallback(
    (key: string, checked: boolean) => {
      const base = settingsRef.current;
      if (!base) return;
      if (base.eventOverrides[key] === checked) return;
      // 显式打开可越过类别关（与 Rust event_enabled 同语义），显式关闭同理。
      const overrides = { ...base.eventOverrides, [key]: checked };
      update({ eventOverrides: overrides });
    },
    [update],
  );

  if (!settings) {
    return (
      <div className="flex items-center gap-2 py-3 text-[0.82em] text-text-muted">
        <BellOff size={14} />
        <span>Loading notification settings…</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col py-1">
      <div className="text-[1.05em] font-semibold text-text-primary mb-1">Notifications</div>
      <div className="text-[0.79em] text-text-muted leading-relaxed mb-2">
        System notifications when a background task needs your attention. While the window is
        focused and the session is visible, notifications are suppressed — the in-app list covers
        those cases.
      </div>

      <SettingRow label="Enable notifications" hint="Master switch for all system notifications">
        <Switch
          aria-label="Enable notifications"
          checked={settings.enabled}
          onCheckedChange={(checked) => void update({ enabled: checked })}
        />
      </SettingRow>

      <SettingRow
        label="Only when window is unfocused"
        hint="Skip notifications while you are watching Neeko"
      >
        <Switch
          aria-label="Only when window is unfocused"
          checked={settings.suppressWhenFocused}
          onCheckedChange={(checked) => void update({ suppressWhenFocused: checked })}
        />
      </SettingRow>

      <div className="text-[0.86em] text-text-primary font-medium mt-3 mb-1">By category</div>
      {CLASS_ROWS.map((row) => (
        <SettingRow key={row.field} label={row.label}>
          <Switch
            aria-label={row.label}
            checked={settings[row.field]}
            onCheckedChange={(checked) => void update({ [row.field]: checked })}
          />
        </SettingRow>
      ))}

      <div className="text-[0.86em] text-text-primary font-medium mt-3 mb-1">By event</div>
      {NOTIFIABLE_EVENTS.map((event) => {
        const classOn = settings[classFieldForClass(EVENT_CLASS[event.key])];
        const checked = settings.eventOverrides[event.key] ?? classOn;
        return (
          <SettingRow key={event.key} label={event.label} hint={event.key}>
            <input
              type="checkbox"
              aria-label={event.label}
              className="size-4 accent-[var(--accent-blue,#4a9eff)]"
              checked={checked}
              onChange={(e) => toggleEvent(event.key, e.target.checked)}
            />
          </SettingRow>
        );
      })}

      <div className="text-[0.86em] text-text-primary font-medium mt-3 mb-1">
        External agent CLI hooks
      </div>
      <SettingRow
        label="Notify agents launched in my terminal"
        hint="Installs status reporter files into pi / OpenCode config dirs (never edits your own files)"
      >
        <Switch
          aria-label="Notify agents launched in my terminal"
          checked={settings.cliHooks}
          onCheckedChange={(checked) => void update({ cliHooks: checked })}
        />
      </SettingRow>
      {settings.cliHooks &&
        hookStatus.map((hook) => (
          <div
            key={hook.source}
            className="flex justify-between py-1 text-[0.72em] text-text-muted"
          >
            <span className="capitalize">{hook.source}</span>
            <span>
              {hook.installed
                ? hook.versionCurrent
                  ? 'installed'
                  : 'needs update'
                : 'not installed'}
            </span>
          </div>
        ))}

      <div className="flex items-center gap-3 mt-4">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void sendTestNotification().then((ok) => {
              if (!ok)
                notify('Test notification failed — check system notification permission', 'error');
              else notify('Test notification sent', 'info');
            });
          }}
        >
          <Check size={14} className="mr-1" />
          Send test notification
        </Button>
      </div>
    </div>
  );
};

interface SettingRowProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
}

const SettingRow: React.FC<SettingRowProps> = ({ label, hint, children }) => (
  <div className="flex items-start justify-between gap-4 py-2 border-b border-white/[0.04]">
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[0.86em] text-text-primary">{label}</span>
      {hint && <span className="text-[0.72em] text-text-muted truncate">{hint}</span>}
    </div>
    <div className="shrink-0 pt-0.5">{children}</div>
  </div>
);

export default React.memo(NotificationSettingsSection);
