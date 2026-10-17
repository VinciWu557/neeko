import { invoke } from '@tauri-apps/api/core';

import { runConfigWrite } from '@/shared/utils/configWriteGate';

export interface ProjectOnboardingState {
  version: number;
  completedSteps: string[];
  dismissed: boolean;
  updatedAt: number;
}

export interface OnboardingConfig {
  projectOnboarding: Record<string, ProjectOnboardingState>;
}

const ONBOARDING_VERSION = 1;

export async function loadOnboardingState(key: string): Promise<ProjectOnboardingState | null> {
  try {
    const config = await invoke<Record<string, unknown>>('load_config');
    const onboarding = (config as unknown as OnboardingConfig).projectOnboarding;
    if (!onboarding) return null;
    return onboarding[key] ?? null;
  } catch {
    return null;
  }
}

export async function saveOnboardingState(
  key: string,
  state: Partial<ProjectOnboardingState>,
): Promise<void> {
  // 进**全局** config 队列，而不是本模块私有的 `saveChain`（2026-10-16 审查）：
  // `config.json` 的写入者横跨多个域（设置页 / CLI hook / 后端 RMW …），
  // 私有链只在本模块内排序，与其它写入者之间没有任何顺序 ⇒ 仍会互删对方的键。
  await runConfigWrite(async () => {
    const config = await invoke<Record<string, unknown>>('load_config');
    const raw = (config as unknown as OnboardingConfig).projectOnboarding ?? {};
    const existing = raw[key] ?? {
      version: ONBOARDING_VERSION,
      completedSteps: [],
      dismissed: false,
      updatedAt: 0,
    };
    raw[key] = {
      ...existing,
      ...state,
      version: ONBOARDING_VERSION,
      updatedAt: Date.now(),
    };
    await invoke<void>('save_config', {
      config: {
        ...config,
        projectOnboarding: raw,
      },
    });
  });
}
