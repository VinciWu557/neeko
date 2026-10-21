// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 「会话配置项驱动 UI」的静态护栏。
 *
 * # 为什么需要它
 *
 * 模式（plan/build）与推理档位（low/medium/high/max）曾经是**前端硬编码常量**，
 * `onChange` 只改 React state、从不发给后端。用户以为切换了，agent 侧毫无变化 ——
 * 而所有组件测试都绿（它们断言的正是那些常量渲染出来的文案）。
 *
 * 这类缺陷的特征是「界面看起来完全正常」，只有对照「选项是否来自会话」才能发现。
 *
 * # 契约
 *
 * 1. 两个选择器的选项**只能**来自 `configOptions`（`category: "mode"` /
 *    `"thought_level"`），不得在前端重新定义一份。
 * 2. agent 不提供该项时选择器**不渲染**（调用方用 `modeOptionOf` /
 *    `thoughtLevelOptionOf` 的 `null` 做条件）。
 * 3. 选择必须走 `onConfigChange`（→ `set_config_option`），不能只改本地 state。
 */
const ROOT = resolve(__dirname, '../../..');
const CHAT = readFileSync(resolve(ROOT, 'agent-chat/components/ChatComposer.tsx'), 'utf8');
const SELECTORS = readFileSync(resolve(ROOT, 'agent-chat/components/ParamSelectors.tsx'), 'utf8');
const CONSTANTS = readFileSync(resolve(ROOT, 'agent-chat/components/constants.ts'), 'utf8');

describe('session option driven selectors', () => {
  it('must not hardcode mode or thinking-level options anywhere', () => {
    // 旧实现的形状：一个带 `id`/`desc`/`icon` 的常量数组
    for (const [name, src] of [
      ['constants.ts', CONSTANTS],
      ['ChatComposer.tsx', CHAT],
      ['ParamSelectors.tsx', SELECTORS],
    ] as const) {
      if (src.includes('AGENT_MODES =')) {
        throw new Error(`${name} must not define AGENT_MODES`);
      }
      if (src.includes('THINKING_LEVELS =')) {
        throw new Error(`${name} must not define THINKING_LEVELS`);
      }
    }
    // 至少扫到一处，避免上面循环空转
    expect(CONSTANTS.length).toBeGreaterThan(0);
  });

  it('should read both options from the session config', () => {
    expect(CHAT).toContain("o.category === 'mode'");
    expect(CHAT).toContain("o.category === 'thought_level'");
  });

  /** 不支持时不渲染 —— 显示一个点不动的控件比不显示更糟。 */
  it('should render each selector only when the session provides it', () => {
    expect(CHAT).toMatch(/\{mode && \(\s*<AgentModeSelector/);
    expect(CHAT).toMatch(/\{thoughtLevel && \(\s*<ThinkingLevelSelector/);
  });

  /** 选择必须下发到后端，否则又回到「只改本地 state」。 */
  it('should forward selections through onConfigChange', () => {
    expect(SELECTORS).toContain('onSelect(option.id, o.value)');
    expect(CHAT).toMatch(
      /onSelect=\{\(configId, value\) => onConfigChange\?\.\(configId, value\)\}/,
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 能力位（08-24-agent-config-unify AC3/AC5）
  //
  // 上面两条护栏只保证「选项来自会话」。但**能不能下发**是另一个问题：
  // serve 的 configOptions 恒空，旧实现靠它为空**碰巧**不渲染 —— 一旦某
  // adapter 返回空数组而非缺失，判据退化；且「不支持」与「会话未建立」被压成
  // 同一个结果。
  //
  // 现在判据是 `SessionStart.capabilities.config`，由后端
  // `AgentAdapter::chat_capabilities()` 派生（design.md P1）。
  // ─────────────────────────────────────────────────────────────────────────

  /** 控件可见性必须由能力位门控，不能只靠 `mode`/`thoughtLevel` 是否为 null。 */
  it('should gate config controls on the capability bit, not on data presence', () => {
    expect(CHAT).toContain('configWritable');
    expect(CHAT).toContain('sessionConfigView');
    // 两个取值的调用点必须先看 configWritable
    expect(CHAT).toMatch(
      /const mode = configWritable \? modeOptionOf\(sessionConfigOptions\) : null/,
    );
    expect(CHAT).toMatch(
      /const thoughtLevel = configWritable \? thoughtLevelOptionOf\(sessionConfigOptions\) : null/,
    );
  });

  /**
   * `per_turn` 与 `none` 都不是 `supported`，但**前者仍需模型选择器**
   *（serve 走每轮请求参数）。所以模型选择器看 `capability !== 'none'`，
   * 配置类控件才看 `supported`。
   */
  it('should keep the model picker for per_turn transports but hide config controls', () => {
    expect(CHAT).toContain('showModelPicker');
    expect(CHAT).toContain("sessionConfigView?.capability !== 'none'");
  });

  /** 三态必须真的被区分：`loading` 不能与 `unsupported` 同路。 */
  it('should treat loading and unsupported as different states', () => {
    const HOOK = readFileSync(resolve(ROOT, 'agent-chat/hooks/useSessionConfigOptions.ts'), 'utf8');
    expect(HOOK).toContain("'unsupported'");
    expect(HOOK).toContain("'loading'");
    expect(HOOK).toContain("'ready'");
    // 能力位是唯一判据：`!supported` 直接短路成 unsupported
    expect(HOOK).toMatch(/const supported = capability === 'session_config'/);
  });

  /**
   * 能力位来自 `SessionStart.capabilities.config`，不是从前端猜。
   * 删掉这一行就等于回到「凭数据非空推断」。
   */
  it('should read the capability bit from session_start', () => {
    const AGENT_CHAT = readFileSync(resolve(ROOT, 'agent-chat/hooks/useAgentChat.ts'), 'utf8');
    expect(AGENT_CHAT).toContain('applySessionStart(ev.capabilities.config');
  });
});
