// @vitest-environment node
import { describe, it, expect } from 'vitest';

import { getAgentIconSrc } from '../../utils/agents';

describe('getAgentIconSrc', () => {
  it('null 输入返回 null', () => {
    expect(getAgentIconSrc(null)).toBeNull();
  });

  it('undefined 输入返回 null', () => {
    expect(getAgentIconSrc(undefined)).toBeNull();
  });

  it('空字符串返回 null', () => {
    expect(getAgentIconSrc('')).toBeNull();
  });

  it('未知图标返回 null', () => {
    expect(getAgentIconSrc('nonexistent-icon.svg')).toBeNull();
  });

  /**
   * 模型厂商图标也必须**真实接入**。
   *
   * `deepseek.svg` / `glm.svg` 曾经 staged 进仓库但零引用 —— Vite 只打包被
   * import 的资源，所以那两个文件既不进产物也不生效，`ModelBadge` 继续用
   * 语义兜底图标。这类「文件在、功能不在」只能靠断言 URL 非空来抓。
   *
   * 变异验证：从 `AGENT_ICONS` 删掉任一条 → 本用例变红（返回 null）。
   */
  it.each(['deepseek.svg', 'glm.svg'])(
    'should resolve the %s brand icon once it is wired in',
    (name) => {
      expect(getAgentIconSrc(name)).toBeTruthy();
    },
  );
});
