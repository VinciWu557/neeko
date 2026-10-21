import type { AgentConfig } from '@/shared/types/agent';

/**
 * Agent 表单里「命令参数」三件套的读写。
 *
 * # 为什么单独一个文件
 *
 * `AgentForm` 已贴着组件规模 ratchet 线（300 行是硬上限，它靠基线豁免才在 500+）。
 * 这三个字段的读写各占 2 处（读初始值、组装 payload），且规则一致：
 * **空格/逗号分隔字符串 ↔ `string[] | null`，空串归一为 `null`**。
 * 收在一处后，表单只管取值与回填。
 */

/** 空格分隔字符串 ↔ 参数数组。 */
export function splitArgs(text: string): string[] {
  return text.trim() ? text.trim().split(/\s+/) : [];
}

/** 逗号分隔字符串 ↔ 参数数组（prompt args 的历史格式）。 */
export function splitCsv(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 从配置读出三件套的表单文本（空数组 → 空串）。 */
export function argsTextOf(config: AgentConfig | null | undefined): {
  promptArgsText: string;
  postPromptArgsText: string;
  modelListArgsText: string;
} {
  return {
    promptArgsText: config?.prompt_args?.join(', ') ?? '',
    postPromptArgsText: config?.post_prompt_args?.join(', ') ?? '',
    modelListArgsText: config?.model_list_args?.join(' ') ?? '',
  };
}

/** 从表单文本组装三件套（空串 → `null`，后端契约）。 */
export function argsFromText(text: {
  promptArgsText: string;
  postPromptArgsText: string;
  modelListArgsText: string;
}): Pick<AgentConfig, 'prompt_args' | 'post_prompt_args' | 'model_list_args'> {
  return {
    prompt_args: text.promptArgsText.trim() ? splitCsv(text.promptArgsText) : null,
    post_prompt_args: text.postPromptArgsText.trim() ? splitCsv(text.postPromptArgsText) : null,
    model_list_args: text.modelListArgsText.trim() ? splitArgs(text.modelListArgsText) : null,
  };
}
