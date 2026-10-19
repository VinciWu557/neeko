import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CommentDisplayMode } from '../../comment/commentTranslations';

/**
 * L1 预热开关（PRD R7：打开文件即翻译，**默认关**）。
 *
 * ## 为什么必须有这一条
 *
 * `commentAutoWarm` 在 `shared/types/settings.ts` 定义、在 `appConfigNormalize.ts` 归一化，
 * 但 2026-10-19 全仓 grep **零读取方** —— 开关建好了没通电，PRD R7 的 L1 实际不存在。
 * 这类「配置字段无人读」的缺口不产生任何编译/测试信号，只能靠「读了就生效」的用例锁住。
 *
 * ## 防重入是必需项，不是优化
 *
 * `start` 的身份随内部状态变化（`useCallback` 依赖 `state.running` / `state.mode`），
 * 所以 effect 会因为 `start` 变新而重跑。没有 ref guard 时，一次打开文件会反复发请求。
 * 用例为此让 mock 每次渲染都返回**新的** `start` 函数 —— 否则防重入逻辑测的是空转（假绿）。
 */

const startCalls: string[] = [];
/** 每次渲染递增 —— 让 mock 的 `start` 每次都是**新身份**。 */
let passCount = 0;

vi.mock('@/features/editor/hooks/useCommentTranslateActions', () => ({
  useCommentTranslateActions: () => {
    passCount += 1;
    // 每次渲染返回**新的**函数身份，模拟真实 hook 的 useCallback 依赖变化
    const callId = passCount;
    return {
      supported: true,
      state: {
        running: false,
        mode: 'below' as CommentDisplayMode,
        total: 0,
        done: 0,
        codeSegments: 0,
        skippedGroups: 0,
        failed: 0,
        cacheHits: 0,
      },
      start: () => {
        startCalls.push(`call-${callId}`);
        return Promise.resolve();
      },
      stop: () => {},
      retryFailed: () => {},
      setMode: () => {},
    };
  },
}));

/** `config.translation` 由用例逐次注入（`commentAutoWarm` 是唯一变量）。 */
let translationConfig: { commentAutoWarm?: boolean } | undefined;

vi.mock('@/shared/contexts/AppContext', () => ({
  useAppContext: () => ({ config: { translation: translationConfig } }),
}));

vi.mock('../CommentTranslationToolbar', () => ({
  default: () => <div data-testid="toolbar" />,
}));

const { default: CommentTranslationBar } = await import('../CommentTranslationBar');

const baseProps = {
  filePath: 'a.ts',
  projectId: 'p1' as never,
  editorViewRef: { current: null },
  content: '',
  canEdit: true,
};

describe('CommentTranslationBar / L1 预热开关', () => {
  it('should auto-start once when commentAutoWarm is true', () => {
    startCalls.length = 0;
    translationConfig = { commentAutoWarm: true };
    render(<CommentTranslationBar {...baseProps} />);
    expect(startCalls).toHaveLength(1);
  });

  it('should not auto-start when commentAutoWarm is absent (default off)', () => {
    startCalls.length = 0;
    translationConfig = undefined;
    render(<CommentTranslationBar {...baseProps} />);
    expect(startCalls).toHaveLength(0);
  });

  it('should not auto-start when commentAutoWarm is explicitly false', () => {
    startCalls.length = 0;
    translationConfig = { commentAutoWarm: false };
    render(<CommentTranslationBar {...baseProps} />);
    expect(startCalls).toHaveLength(0);
  });

  it('should not re-warm the same file across re-renders (ref guard)', () => {
    startCalls.length = 0;
    translationConfig = { commentAutoWarm: true };
    const { rerender } = render(<CommentTranslationBar {...baseProps} />);
    expect(startCalls).toHaveLength(1);

    // 每次 rerender 都会拿到新的 `start` 身份 → 没有 ref guard 时 effect 会重跑
    rerender(<CommentTranslationBar {...baseProps} />);
    rerender(<CommentTranslationBar {...baseProps} content="// edited" />);
    expect(startCalls).toHaveLength(1);
  });

  it('should warm again when the file changes (ref records the path, not a boolean)', () => {
    startCalls.length = 0;
    translationConfig = { commentAutoWarm: true };
    const { rerender } = render(<CommentTranslationBar {...baseProps} />);
    expect(startCalls).toHaveLength(1);

    rerender(<CommentTranslationBar {...baseProps} filePath="b.ts" />);
    expect(startCalls).toHaveLength(2);
  });
});
