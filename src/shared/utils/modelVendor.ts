/**
 * 从模型条目的 `id` / `name` 推断**厂商**，供模型列表显示厂商图标。
 *
 * # 为什么只能靠前缀猜
 *
 * 协议里没有图标信息。实测 Pi 的 `get_available_models` 每条只有
 * `{id, name, provider, api, baseUrl, contextWindow, maxTokens, cost, …}`
 * —— **没有任何 icon / logo / image 字段**。所以厂商只能从命名推断。
 *
 * # 识别率与降级
 *
 * 本机 224 条样本里 72% 能识别出厂商，其余 28% 是 `big-pickle`、
 * `space-bunny`、`nemotron`、`xingchen` 这类无公开品牌的模型 —— 它们**降级**
 * 到中性图标，而不是硬套一个错误的品牌。
 *
 * # 顺序有意义
 *
 * `gpt` 必须排在 `o1` / `o3` 之前？不需要 —— 但 `claude` 与 `gpt` 都要排在
 * 短词之前：`glm` 只 3 个字符，若先匹配会让 `glm-4` 系列之外的词误命中
 *（例如某个名字里含 "glm" 的长词）。当前表按「越长越具体」排列。
 */

/** 识别出的厂商标识（与 `modelVendorIcon` 的键一一对应）。 */
export type ModelVendor =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'deepseek'
  | 'qwen'
  | 'zhipu'
  | 'moonshot'
  | 'minimax'
  | 'stepfun'
  | 'bytedance'
  | 'xai'
  | 'meta'
  | 'mistral'
  | 'nvidia'
  | 'xiaomi'
  | 'opencode';

/**
 * 厂商识别规则：`[厂商, 关键字...]`。
 *
 * 关键字的匹配对象是 **`id` + `name` 的小写拼接**，所以 `DeepSeek V4 Pro` 与
 * `deepseek-v4-pro` 都能命中。
 *
 * 顺序：把**更容易误伤的长词放前面**（`claude` 之于 `cl`、`deepseek` 之于 `deep`）。
 */
const VENDOR_KEYWORDS: ReadonlyArray<readonly [ModelVendor, readonly string[]]> = [
  ['anthropic', ['claude', 'anthropic', 'sonnet', 'opus', 'haiku']],
  ['openai', ['gpt', 'openai', 'davinci', 'o1-', 'o3-', 'o4-', 'codex']],
  ['google', ['gemini', 'gemma', 'google']],
  ['deepseek', ['deepseek', 'deep-seek']],
  ['qwen', ['qwen', 'qwq', 'tongyi']],
  ['zhipu', ['glm', 'zhipu', 'chatglm']],
  ['moonshot', ['kimi', 'moonshot']],
  ['minimax', ['minimax', 'abab']],
  ['stepfun', ['step-', 'stepfun', 'step1', 'step2', 'step3']],
  ['bytedance', ['doubao', 'seed-', 'skylark']],
  ['xai', ['grok', 'xai']],
  ['meta', ['llama', 'meta-']],
  ['mistral', ['mistral', 'mixtral', 'codestral']],
  ['nvidia', ['nemotron', 'nvidia']],
  // 小米 MiMo —— 仓里已有 `mimo.png`（agent 图标），可直接复用
  ['xiaomi', ['mimo-', 'mimo v', 'xiaomi']],
  ['opencode', ['opencode', 'big-pickle', 'grok-code']],
];

/**
 * 推断厂商。识别不出返回 `null` —— 调用方据此降级到中性图标。
 *
 * 返回 `null` 是**正常结果**（28% 的模型如此），不是错误。
 */
export function modelVendorOf(model: { id: string; name?: string | null }): ModelVendor | null {
  const haystack = `${model.id} ${model.name ?? ''}`.toLowerCase();
  for (const [vendor, keys] of VENDOR_KEYWORDS) {
    for (const key of keys) {
      if (haystack.includes(key)) return vendor;
    }
  }
  return null;
}
