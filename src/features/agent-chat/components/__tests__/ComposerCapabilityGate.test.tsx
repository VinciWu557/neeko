import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { SessionConfigOption } from '@/shared/types/agentChat';
import type { ModelAvailability } from '@/shared/utils/modelTarget';

import ChatComposer from '../ChatComposer';

/**
 * 能力位门控的**运行时**护栏（AC3/AC5）。
 *
 * # 为什么不能只做静态字符串断言
 *
 * 第一版把「`configWritable` 出现在源码里」当判据 —— 变异验证时把它的定义
 * 改成 `const configWritable = true`，8 条静态断言**全绿**：名字还在，
 * 门控已经没了。字符串匹配只能防「整段删除」，防不住「条件被短路」。
 *
 * 所以这里直接渲染组件、断言 DOM。
 */

const MODE_OPTION: SessionConfigOption = {
  id: 'session-mode',
  name: 'Mode',
  category: 'mode',
  type: 'select',
  currentValue: 'build',
  options: [
    { value: 'build', name: 'Build' },
    { value: 'plan', name: 'Plan' },
  ],
};

function renderComposer(view: ModelAvailability, options: SessionConfigOption[]) {
  return render(
    <ChatComposer
      input=""
      attachments={[]}
      streaming={false}
      chatAgents={[{ id: 'a', name: 'Agent', icon: null }]}
      models={[]}
      sessionConfigOptions={options}
      sessionConfigView={view}
      selectedModel={null}
      selectedAgent={{ id: 'a', name: 'Agent', icon: null }}
      contextWindow={null}
      tabKey="k"
      tabId="t"
      onInputChange={() => undefined}
      onKeyDown={() => undefined}
      onSend={() => undefined}
      onStop={() => undefined}
      onRemoveAttachment={() => undefined}
      onOpenAttachDrop={() => undefined}
      onModelChange={() => undefined}
      onConfigChange={() => undefined}
    />,
  );
}

/** 模式选择器的可辨识标志是它渲染出的当前档位文案。 */
function hasModeSelector(): boolean {
  return screen.queryByText('Build') !== null;
}

/**
 * 模型选择器的可辨识标志是它按钮上的 `title`（`Select model` / 当前模型 id）。
 *
 * **不能用 agent 名做判据** —— 旁边的 `ModelSelector`（agent 切换）也渲染
 * 同一个名字，于是「ModelPicker 消失了」的变异抓不到（第一版就是这么漏的）。
 */
function hasModelPicker(): boolean {
  return screen.queryByTitle('Select model') !== null;
}

describe('ChatComposer 能力位门控', () => {
  /**
   * `supported && ready` 才渲染配置类控件。
   *
   * 变异验证：把 `configWritable` 短路成 `true` → 本用例变红。
   */
  it('should render the mode selector only when the session config is writable', () => {
    const { unmount } = renderComposer('ready', [MODE_OPTION]);
    expect(hasModeSelector()).toBe(true);
    unmount();

    // 能力位说不可写：即便**选项还在**（残留），也不能渲染 ——
    // 那就是「显示了控件、点选静默无操作」（R3 禁止的组合）。
    renderComposer('no-config', [MODE_OPTION]);
    expect(hasModeSelector()).toBe(false);
  });

  /**
   * `per_turn`（serve）：配置类控件隐藏（它没有 set_config_option），
   * 但**模型选择器仍在**（走每轮请求参数）。
   */
  it('should hide config controls but keep the model picker for per_turn', () => {
    renderComposer('per-turn', [MODE_OPTION]);
    expect(hasModeSelector()).toBe(false);
    // 模型选择器**仍在**：per_turn 走每轮请求参数。
    expect(hasModelPicker()).toBe(true);
  });

  /**
   * `loading` 与 `unsupported` 必须**同路但不混淆**：此时都隐藏控件。
   *
   * 真正的区分点是「将来会不会出现」—— `loading` 会在 `session_start` 后
   * 变 `ready`，`unsupported` 永远不会。这条只钉住「不闪出不存在的控件」。
   */
  it('should not render config controls while loading', () => {
    renderComposer('pending', [MODE_OPTION]);
    expect(hasModeSelector()).toBe(false);
  });
});
