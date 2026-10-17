import { useState, useEffect, useCallback, useRef } from 'react';

import { setLspImportStrategy } from '@/features/lsp/api/lspImportStrategy';
import { applyCustomCssVars, clearCustomCssVars } from '@/features/settings/customThemeVars';
import type { AppConfig, ThemeListItem, CustomThemeData } from '@/features/settings/types';
import { updateAllTerminalThemes } from '@/features/terminal';
import { useConnectionStore } from '@/shared/store/connectionStore';
import { useProjectStore } from '@/shared/store/projectStore';
import { syncTypographyTokens } from '@/shared/utils/typography';

import {
  saveConfig as saveConfigApi,
  loadConfig as loadConfigApi,
  syncAgentTheme,
  listCustomThemes,
  getCustomTheme,
} from '../api/settingsApi';

import { DEFAULT_CONFIG, isBuiltinTheme, normalizeLoadedConfig } from './appConfigNormalize';
import { applyConfigSave, type ConfigSaveInput, persistConfigSave } from './appConfigSave';

export function useAppConfig() {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [customThemes, setCustomThemes] = useState<ThemeListItem[]>([]);
  const themeDataCache = useRef<Map<string, CustomThemeData>>(new Map());

  useEffect(() => {
    syncTypographyTokens({
      monoFamily: config.monoFontFamily ?? config.fontFamily ?? '',
      uiFontSize: config.appearanceFontSize,
      monoFontSize: config.terminalFontSize,
    });
  }, [
    config.appearanceFontSize,
    config.terminalFontSize,
    config.fontFamily,
    config.monoFontFamily,
  ]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', config.theme);

    if (isBuiltinTheme(config.theme)) {
      clearCustomCssVars();
    } else {
      const cached = themeDataCache.current.get(config.theme);
      if (cached) {
        applyCustomCssVars(cached.variables);
      }
    }

    requestAnimationFrame(() => {
      updateAllTerminalThemes();
    });

    const { projects } = useProjectStore.getState();
    const { wslEntries } = useConnectionStore.getState();
    const localPaths = projects.map((p) => p.path);
    const wsl = wslEntries.flatMap((e) =>
      e.projects.map((p) => ({ distro: e.distro, path: p.path })),
    );
    if (localPaths.length > 0 || wsl.length > 0) {
      syncAgentTheme(config.theme, { local_paths: localPaths, wsl }).catch((e) => {
        console.error('[App] Failed to sync agent theme:', e);
      });
    }
  }, [config.theme]);

  const loadCustomThemeVars = useCallback(
    async (themeName: string) => {
      if (themeDataCache.current.has(themeName)) return;
      try {
        const data = await getCustomTheme(themeName);
        if (data) {
          themeDataCache.current.set(themeName, data);
          if (config.theme === themeName) {
            applyCustomCssVars(data.variables);
          }
        }
      } catch (e) {
        console.error(`[App] Failed to load custom theme "${themeName}":`, e);
      }
    },
    [config.theme],
  );

  /**
   * `config.json` 的**唯一写点**：串行化 + 临界区内读盘合并。
   *
   * 契约全文见 `appConfigNormalize.applyConfigSave`。
   * **调用方不得再包 `runConfigWrite`**（队列内二次入队 = 自我等待死锁）。
   */
  const saveConfig = useCallback(
    async (next: ConfigSaveInput) => {
      // 乐观 UI：先用「增量 + 当前内存值」更新（合并规则是纯函数，见 `applyConfigSave`）。
      // 落盘时会在临界区内用**磁盘现值**重算一次，那才是权威结果。
      const normalized = applyConfigSave(config, next);
      // M4 单写点：补全源跑在 CM6 回调里，只能同步读模块缓存 —— 写入方唯一在此
      //（保存时同步；启动加载见下方 load effect）。
      setLspImportStrategy(normalized.lsp.importStrategy);
      setConfig(normalized);
      if (!isBuiltinTheme(normalized.theme)) {
        await loadCustomThemeVars(normalized.theme);
      }
      try {
        // 读盘 → 合并 → 落盘 整体不可交叠（实现在 `persistConfigSave`，可直测）。
        await persistConfigSave(next, loadConfigApi, saveConfigApi);
      } catch (e) {
        console.error('[App] Failed to save config:', e);
        throw e;
      }
    },
    [config, loadCustomThemeVars],
  );

  useEffect(() => {
    (async () => {
      try {
        const loaded = await listCustomThemes();
        setCustomThemes(loaded);
      } catch (e) {
        console.error('[App] Failed to load custom themes:', e);
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const loaded = await loadConfigApi();
        if (loaded && typeof loaded === 'object') {
          // 纯解析（含「未建模键原样带过」契约）抽在 `appConfigNormalize`：
          // 那部分是零副作用的纯函数，可直测；本 hook 只负责副作用编排。
          const { config: next, theme, needsCustomThemeVars } = normalizeLoadedConfig(loaded);
          if (needsCustomThemeVars) {
            await loadCustomThemeVars(theme);
          }
          // M4：启动加载同步补全策略缓存（`normalizeLoadedConfig` 已回落 auto）。
          setLspImportStrategy(next.lsp.importStrategy);
          setConfig(next);
        }
      } catch (e) {
        console.error('[App] Failed to load config:', e);
      }
    })();
  }, [loadCustomThemeVars]);

  return { config, saveConfig, customThemes };
}
