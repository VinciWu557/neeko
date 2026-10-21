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

describe('model ↔ thinking level wiring', () => {
  /** 选模型必须下发，否则 pi 不知道换了模型，档位不会刷新。 */
  it('should push set_config_option when the user picks a model', () => {
    expect(HOOK).toContain('useModelSelection(');
    expect(SELECTION).toMatch(/modelConfigIdFrom\(sessionConfigOptions\)/);
    expect(SELECTION).toMatch(/setConfigOption\(configId, model\.id\)/);
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
