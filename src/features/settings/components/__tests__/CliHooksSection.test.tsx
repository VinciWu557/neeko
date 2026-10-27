/**
 * CliHooksSection 关键行为：数据驱动的逐 CLI 行、覆盖表写入 `agentHookSources`、
 * 生效集合计算、回执按 status 分类。api 门面与 config 命令整体 mock。
 *
 * 两个导出的**纯函数**（`readSourceOverrides` / `enabledSourcesFor`）在此直测 ——
 * 它们是「畸形容忍」与「空列表不得当空集」两条不变量的唯一实现点。
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/notification/api/notificationApi', () => ({
  applyCliHooks: vi.fn(),
  getCliHookStatus: vi.fn(),
}));

vi.mock('@/features/settings/api/settingsApi', () => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
}));

import { applyCliHooks, getCliHookStatus } from '@/features/notification/api/notificationApi';
import { loadConfig, saveConfig } from '@/features/settings/api/settingsApi';
import { useNotificationStore } from '@/shared/store/notificationStore';
import type { HookInstallStatus } from '@/shared/types/notification';

import CliHooksSection, {
  describeHookStatus,
  enabledSourcesFor,
  installableHookRows,
  readSourceOverrides,
} from '../CliHooksSection';

function latestNotification() {
  return useNotificationStore.getState().notifications[0];
}

const TWO_CLIS: HookInstallStatus[] = [
  {
    source: 'pi',
    path: '/x/neeko-status.ts',
    selfSupplied: false,
    installed: false,
    versionCurrent: false,
    trusted: null,
  },
  {
    source: 'claude',
    path: '/y/neeko-status.mjs',
    selfSupplied: false,
    installed: false,
    versionCurrent: false,
    trusted: null,
  },
];

function setup() {
  vi.mocked(applyCliHooks).mockResolvedValue([]);
  vi.mocked(getCliHookStatus).mockResolvedValue(TWO_CLIS);
  vi.mocked(loadConfig).mockResolvedValue({});
  vi.mocked(saveConfig).mockResolvedValue(undefined);
}

describe('CliHooksSection pure helpers', () => {
  /** 畸形容忍：非对象 / 值非布尔 → 只取可判定项。 */
  it('readSourceOverrides tolerates malformed values', () => {
    expect(readSourceOverrides({})).toEqual({});
    expect(readSourceOverrides({ agentHookSources: 'nope' })).toEqual({});
    expect(readSourceOverrides({ agentHookSources: [1, 2] })).toEqual({});
    expect(
      readSourceOverrides({
        agentHookSources: { claude: false, qoder: 'yes', pi: true },
      }),
    ).toEqual({ claude: false, pi: true });
  });

  /**
   * 生效集合：主开关关 → `null`（调用方语义为「不装」）；
   * **已知列表为空 → `null` 而非 `[]`** —— 空集会让 Rust 侧把已装 hook 全卸掉。
   */
  it('enabledSourcesFor falls back to null when the known list is empty', () => {
    expect(enabledSourcesFor(true, [], {})).toBeNull();
    expect(enabledSourcesFor(false, TWO_CLIS, {})).toBeNull();
    expect(enabledSourcesFor(true, TWO_CLIS, {})).toEqual(['pi', 'claude']);
    expect(enabledSourcesFor(true, TWO_CLIS, { claude: false })).toEqual(['pi']);
  });
});

describe('describeHookStatus', () => {
  /**
   * **「装了但不生效」必须说出来**（本项目反复出现的形态）：
   * Codex 对未信任的 hook 静默跳过，若只显示「已安装」，用户会以为审批通知已生效。
   */
  it('surfaces the needs-confirmation state when installed but untrusted', () => {
    expect(
      describeHookStatus({
        source: 'codex',
        path: '/home/u/.codex/hooks.json',
        installed: true,
        versionCurrent: true,
        trusted: false,
      }),
    ).toContain('needs confirmation');
  });

  it('shows the path when installed and trusted', () => {
    expect(
      describeHookStatus({
        source: 'codex',
        path: '/p',
        installed: true,
        versionCurrent: true,
        trusted: true,
      }),
    ).toBe('/p');
  });

  /** `trusted: null` = 该 CLI 无信任概念 → 不提示确认（避免误导）。 */
  it('does not mention confirmation when trust is not applicable', () => {
    expect(
      describeHookStatus({
        source: 'pi',
        path: '/p',
        installed: true,
        versionCurrent: true,
        trusted: null,
      }),
    ).toBe('/p');
  });

  it('reports not-installed and outdated states', () => {
    expect(
      describeHookStatus({
        source: 'pi',
        path: '/p',
        installed: false,
        versionCurrent: false,
        trusted: null,
      }),
    ).toBe('not installed');
    expect(
      describeHookStatus({
        source: 'pi',
        path: '/p',
        installed: true,
        versionCurrent: false,
        trusted: null,
      }),
    ).toBe('/p (outdated)');
  });
});

describe('CliHooksSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useNotificationStore.setState({ notifications: [], unreadCount: 0 });
    setup();
  });

  /** 逐 CLI 行**数据驱动**：行清单来自 agent_hooks_status，每行一个开关。 */
  it('renders one toggle per CLI from the backend fact table', async () => {
    render(<CliHooksSection master onMasterChange={vi.fn()} />);
    expect(await screen.findByRole('switch', { name: 'Install hook for pi' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Install hook for claude' })).toBeInTheDocument();
  });

  /** 主开关关时逐 CLI 行不渲染（避免误导：关着还显示可调）。 */
  it('hides per-CLI rows while the master switch is off', async () => {
    render(<CliHooksSection master={false} onMasterChange={vi.fn()} />);
    await waitFor(() =>
      expect(screen.queryByRole('switch', { name: 'Install hook for pi' })).not.toBeInTheDocument(),
    );
  });

  /** 逐 CLI 开关 → 写 `agentHookSources`，并把该 source 从生效集排除后重同步。 */
  it('persists the override and re-syncs without that CLI', async () => {
    render(<CliHooksSection master onMasterChange={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Install hook for claude' }));

    await waitFor(() => expect(saveConfig).toHaveBeenCalled());
    expect(vi.mocked(saveConfig).mock.calls.at(-1)?.[0]).toMatchObject({
      agentHookSources: { claude: false },
    });
    await waitFor(() => expect(vi.mocked(applyCliHooks).mock.calls.at(-1)).toEqual([true, ['pi']]));
  });

  /**
   * 主开关开启（syncToken 递增）→ 同步已知 CLI 集合。
   *
   * 先 `master` 渲染并等逐 CLI 行出现（状态加载完成）再递增 token ——
   * 否则 `hookStatus` 还是空，生效集会回退 `null`（那是正确的防御行为，见上一条用例）。
   */
  it('syncs all known CLIs when the master token advances', async () => {
    const { rerender } = render(<CliHooksSection master onMasterChange={vi.fn()} syncToken={0} />);
    // 等状态加载完成（行渲染出来）。
    await screen.findByRole('switch', { name: 'Install hook for pi' });

    rerender(<CliHooksSection master onMasterChange={vi.fn()} syncToken={1} />);
    await waitFor(() =>
      expect(vi.mocked(applyCliHooks).mock.calls.at(-1)).toEqual([true, ['pi', 'claude']]),
    );
  });

  /** 回执按机器可读 status 分类：failed → error，且只呈现失败项。 */
  it('surfaces only failed hook outcomes as errors', async () => {
    vi.mocked(applyCliHooks).mockResolvedValueOnce([
      { source: 'claude', status: 'failed', detail: 'settings.json has an unsupported structure' },
      { source: 'pi', status: 'applied', detail: '' },
    ]);
    const { rerender } = render(<CliHooksSection master onMasterChange={vi.fn()} syncToken={0} />);
    await screen.findByRole('switch', { name: 'Install hook for pi' });
    rerender(<CliHooksSection master onMasterChange={vi.fn()} syncToken={1} />);
    await waitFor(() =>
      expect(latestNotification()).toMatchObject({
        type: 'error',
        message: 'CLI hooks: claude: failed (settings.json has an unsupported structure)',
      }),
    );
  });

  /** skipped 是中性状态（他人条目保护等）→ info，不得弹错误。 */
  it('reports skipped hook outcomes as neutral info', async () => {
    vi.mocked(applyCliHooks).mockResolvedValueOnce([
      {
        source: 'pi',
        status: 'skipped',
        detail: 'neeko-status.ts exists and is not Neeko-managed',
      },
    ]);
    const { rerender } = render(<CliHooksSection master onMasterChange={vi.fn()} syncToken={0} />);
    await screen.findByRole('switch', { name: 'Install hook for pi' });
    rerender(<CliHooksSection master onMasterChange={vi.fn()} syncToken={1} />);
    await waitFor(() =>
      expect(latestNotification()).toMatchObject({
        type: 'info',
        message: 'CLI hooks: pi: skipped (neeko-status.ts exists and is not Neeko-managed)',
      }),
    );
  });

  /** 覆盖表写入失败 → 回读磁盘现值回滚本地态并提示。 */
  it('rolls back the override when saving fails', async () => {
    render(<CliHooksSection master onMasterChange={vi.fn()} />);
    const user = userEvent.setup();
    vi.mocked(saveConfig).mockRejectedValueOnce(new Error('disk'));
    vi.mocked(loadConfig).mockResolvedValueOnce({ agentHookSources: { claude: true } });

    const claudeToggle = await screen.findByRole('switch', { name: 'Install hook for claude' });
    await user.click(claudeToggle);

    await waitFor(() => expect(latestNotification()).toMatchObject({ type: 'error' }));
    // 回滚后该开关恢复为磁盘值（true ⇒ checked）。
    await waitFor(() => expect(claudeToggle).toHaveAttribute('data-state', 'checked'));
  });
});

/**
 * 自供源不得出现在设置页的开关列表里。
 *
 * 背景：`HOOK_TARGETS` 同时驱动「接收白名单」与「Neeko 能装哪些 CLI」。
 * DSH 只满足前者（上报由 `packages/dsh-neeko` 完成，Neeko 不该往用户 profile 写文件），
 * 后端因此把它报成 `path: ""`。若不过滤，用户会看到一行「dsh — not installed」
 * 加一个拨动后毫无效果的开关 —— 「看起来有、实际没有」。
 */
describe('installableHookRows', () => {
  const row = (source: string, path: string, selfSupplied = false): HookInstallStatus => ({
    source,
    path,
    selfSupplied,
    installed: false,
    versionCurrent: false,
    trusted: null,
  });

  it('drops self-supplied sources (empty path)', () => {
    const rows = [row('pi', '/x/neeko-status.ts'), row('dsh', '', true)];
    expect(installableHookRows(rows).map((r) => r.source)).toEqual(['pi']);
  });

  it('keeps every installable source in order', () => {
    const rows = [row('pi', '/a'), row('dsh', '', true), row('claude', '/b'), row('codex', '/c')];
    expect(installableHookRows(rows).map((r) => r.source)).toEqual(['pi', 'claude', 'codex']);
  });

  it('returns an empty list when every source is self-supplied', () => {
    expect(installableHookRows([row('dsh', '', true)])).toEqual([]);
  });

  it('does not drop a source merely because it is not installed', () => {
    // 「未安装」是运行时事实，仍要展示（用户可能要装它）。
    const rows = [row('pi', '/x/neeko-status.ts')];
    expect(installableHookRows(rows)).toHaveLength(1);
  });

  it('does not drop a source whose directory could not be resolved', () => {
    // 反证钉子：用 `path === ''` 作判据会把「本机没装这一行 CLI」误判成自供源
    // 而从列表里抹掉 —— 用户再也装不上它。
    const rows = [row('pi', '', false)];
    expect(installableHookRows(rows).map((r) => r.source)).toEqual(['pi']);
  });
});
