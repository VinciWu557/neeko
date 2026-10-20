import type { ModelConfigOption } from '@/features/agent/api/agentApi';

/**
 * 模型 popover 里的**配置项**区域（ACP `model_config` / `thought_level`）。
 *
 * # 为什么这些不属于模型条目
 *
 * 「上下文大小」「推理档位」看着像模型的属性，但 ACP 把它们表达为独立的会话配置项
 * （`category: "model_config"` / `"thought_level"`），因为它们**可以在不换模型时
 * 单独调整**，而且可选值会随模型变化。把它们塞进 `ModelInfo` 会丢掉这个自由度 ——
 * 旧实现正是把 `200k ctx · free` 拼在模型名后面，用户改不了。
 *
 * # 规范要求的位置
 *
 * `docs/protocol/v1/session-config-options.mdx`：
 *
 * > Clients **SHOULD** render `model_config` options near the `model` selector,
 * > such as in the same popover or panel.
 *
 * 所以它渲染在模型列表**下方**，同一个 popover 内。
 *
 * # 无配置项时不渲染
 *
 * agent 不提供任何 `model_config` 时返回 `null`，而不是显示一个空区域 ——
 * 空控件会让用户以为「这里本该有东西，但坏了」。
 */
interface ModelConfigSectionProps {
  options: ModelConfigOption[];
  onChange: (configId: string, value: string | boolean) => void;
  /** 运行中禁用编辑（避免与进行中的回合竞争会话状态）。 */
  disabled?: boolean;
}

export function ModelConfigSection({ options, onChange, disabled }: ModelConfigSectionProps) {
  if (options.length === 0) return null;

  return (
    <div className="model-config-section">
      {options.map((option) => (
        <label key={option.id} className="model-config-row">
          <span className="model-config-label" title={option.description ?? undefined}>
            {option.name}
          </span>
          {option.type === 'boolean' ? (
            <input
              type="checkbox"
              className="model-config-checkbox"
              checked={option.currentValue === true}
              disabled={disabled}
              onChange={(e) => onChange(option.id, e.target.checked)}
              aria-label={option.name}
            />
          ) : (
            <select
              className="model-config-select"
              value={typeof option.currentValue === 'string' ? option.currentValue : ''}
              disabled={disabled}
              onChange={(e) => onChange(option.id, e.target.value)}
              aria-label={option.name}
            >
              {option.options.map((item: { value: string; name: string }) => (
                <option key={item.value} value={item.value}>
                  {item.name}
                </option>
              ))}
            </select>
          )}
        </label>
      ))}
    </div>
  );
}

export default ModelConfigSection;
