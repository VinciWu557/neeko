// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 「模型 → 思考等级」联动的静态护栏。
 *
 * # 两个方向都不能错
 *
 * | 动作 | 正确后果 | 旧实现的错误后果 |
 * | --- | --- | --- |
 * | 选模型 | 下发 `set_config_option` → 后端重拉档位 | 只改本地 state，档位停在旧模型那一组 |
 * | 选档位 | **只改档位** | 一次无关刷新把用户刚选的模型打回会话当前值 |
 *
 * 后者见 `useSelectedModelSync.test.ts` 的
 * `should not override the user selection when an unrelated refresh repeats the current value`。
 */
const HOOK = readFileSync(resolve(__dirname, '../../hooks/useAgentChat.ts'), 'utf8');
const SYNC = readFileSync(resolve(__dirname, '../../hooks/useSelectedModelSync.ts'), 'utf8');
const VIEW = readFileSync(resolve(__dirname, '../AgentChatTabView.tsx'), 'utf8');
const SELECTION = readFileSync(resolve(__dirname, '../../hooks/useModelSelection.ts'), 'utf8');

/** 剥掉注释 —— 否则历史注释里提到的已删符号会让断言假绿。 */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

describe('model ↔ thinking level wiring', () => {
  /** 选模型必须下发，否则 pi 不知道换了模型，档位不会刷新。 */
  /**
   * 写回方式由**列表来源**决定，不是靠「恰好有没有 configId」。
   *
   * 旧实现是 `const configId = ...; if (configId) setConfigOption(configId, model.id)`：
   * 对 serve（`configOptions` 恒空）静默跳过 —— UI 看起来能用，实际是空值巧合。
   * 一旦残留选项让 `configId` 有值，`provider/model` 复合串就会被喂进
   * `set_config_option`（实测 `Model not found: provider/provider/model`）。
   *
   * 现在三个来源各自显式分支（`ModelTarget`），行为由
   * `useModelSelection.test.ts` 的 5 条用例覆盖（含变异验证）。
   *
   * 注：断言一律对 **`codeOnly` 之后的源码**做 —— `useModelSelection.ts` 的
   * 历史注释提到过 `modelSourceOf`，对原文匹配会「去掉实现也恒绿」（假绿）。
   */
  it('should route the write through the model source, not a config-id guess', () => {
    const selection = codeOnly(SELECTION);
    expect(HOOK).toContain('useModelSelection(');
    expect(selection).toContain('modelWriteOf');
    // 旧兜底必须消失：`if (configId) setConfigOption(...)` 是静默跳过的来源。
    expect(selection).not.toMatch(/if \(configId\) setConfigOption\(configId, model\.id\)/);
  });

  /** 视图层必须用这个 handler，而不是裸 setSelectedModel。 */
  it('should wire the composer to the pushing handler', () => {
    expect(VIEW).toContain('onModelChange={selectModel}');
    expect(VIEW).not.toContain('onModelChange={setSelectedModel}');
  });

  /**
   * 切档位引起的刷新（`current_value` 原样重报）不得覆盖用户选择 ——
   * 这是「选完模型再选思考等级，模型自己变了」的直接成因。
   */
  it('should ignore a refresh that repeats the same session model', () => {
    expect(SYNC).toContain('sameAsBefore');
    expect(SYNC).toMatch(/previous !== null && authoritative === previous/);
  });
});
