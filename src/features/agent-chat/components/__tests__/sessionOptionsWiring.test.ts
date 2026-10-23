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

/** 剥掉注释 —— 否则历史注释里提到的已删判据会让「不得复活」断言假红/假绿。 */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

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

  /**
   * 控件可见性必须由**唯一判据**门控，且该判据不能只看「模型怎么传」。
   *
   * # 2026-10-23 修正
   *
   * 原实现用 `sessionConfigView === 'ready'`。serve 的模型是 `per-turn`
   * （永远不等于 `'ready'`）但它**产出** configOptions（模式 / 思考等级），
   * 于是两个控件永不渲染 —— 真实故障。
   *
   * 现在的判据是 `showsConfigControls(availability, options.length)`：
   * 问「有没有配置项可写」，与「模型是 per-turn 还是 session_config」解耦。
   *
   * 变异验证：改回 `sessionConfigView === 'ready'` → 本用例红。
   */
  it('should gate config controls on option presence, not on the model transport', () => {
    expect(CHAT).toContain('showsConfigControls');
    expect(CHAT).toContain('sessionConfigView');
    // 两个取值的调用点必须先看 showConfigControls
    expect(CHAT).toMatch(/const mode = showConfigControls \? modeOptionOf\(/);
    expect(CHAT).toMatch(/const thoughtLevel = showConfigControls \? thoughtLevelOptionOf\(/);
    // 旧的单一 'ready' 判据**不得**复活（对剥注释后的代码断言 —— 注释里解释
    // 历史原因时会提到它，那不是违规）
    expect(codeOnly(CHAT)).not.toContain("sessionConfigView === 'ready'");
  });

  /**
   * `per_turn` 与 `none` 都不是 `supported`，但**前者仍需模型选择器**
   *（serve 走每轮请求参数）。所以模型选择器看 `capability !== 'none'`，
   * 配置类控件才看 `supported`。
   */
  it('should keep the model picker for per_turn transports and still show config controls', () => {
    // 模型列表：`no-config` 才隐藏（per-turn 也能选模型）。
    // 配置控件：看 options 存在性 —— 所以 per-turn 传输**也能**有模式/档位。
    expect(CHAT).toContain('showsModelPicker(');
    expect(CHAT).toContain('showsConfigControls(');
  });

  /**
   * 可用状态是**一个 union**，不是 `{phase, capability}` 两个字段的笛卡尔积。
   *
   * 后者是 9 种组合的自由空间（只 4 种可达），每个消费点都要自己 switch
   * 两个维度 —— 四份判据必然漂移，曾出现「渲染说能点、写入拿不到目标」。
   *
   * 变异验证：把 hook 改回暴露 `{phase, capability}` → 本用例变红。
   */
  it('should expose one availability union, not two orthogonal fields', () => {
    const HOOK = readFileSync(resolve(ROOT, 'agent-chat/hooks/useSessionConfigOptions.ts'), 'utf8');
    expect(HOOK).toContain('modelAvailabilityOf(');
    expect(HOOK).toContain('availability: ModelAvailability');
    // 不得再各自暴露两个维度让消费方自己组合
    expect(HOOK).not.toContain('view: { phase, capability }');
  });

  /** 每个判据都必须是 union 上的**全函数**（switch 穷举、无 default 兜底）。 */
  it('should derive every judgement from the same union exhaustively', () => {
    const UTIL = readFileSync(resolve(ROOT, '../shared/utils/modelTarget.ts'), 'utf8');
    for (const fn of ['writabilityOf', 'modelWriteOf']) {
      expect(UTIL).toContain(`export function ${fn}(`);
    }
    // 不可写不是某个变体，而是「拿不到写回目标」
    expect(UTIL).not.toContain("'read_only'");
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
