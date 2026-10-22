/** 下拉列表显示名修正：deepseek-harness → deepseek。 */
export function displayName(name: string): string {
  return name === 'deepseek-harness' ? 'deepseek' : name;
}

/**
 * 收起态按钮上要显示的 **provider** —— 只在它是额外信息时返回。
 *
 * # 为什么不能直接渲染 `group`
 *
 * 各 agent 把 provider 放在两个不同的地方，直接渲染会重复：
 *
 * | 来源 | `name` | `group` | 该显示什么 |
 * | --- | --- | --- | --- |
 * | Pi `get_available_models`（rpc，活路径） | `Deepseek-V4.1-Flash` | `magpie` | `magpie` |
 * | opencode `models --verbose` | `opencode/big-pickle` | 无 | 无（已在 name 里） |
 * | 旧版 Pi CLI 表格（已删除） | `magpie/deepseek-v4.1-flash` | `magpie` | 无（已在 name 里） |
 *
 * 后两行若照抄 `group`，用户会看到 `magpie/` 出现两次 —— 信息量为零的噪音。
 * 第三行虽然是已删路径，但用户机器上可能有旧版持久化数据，判据必须仍然成立。
 *
 * # 为什么用 `startsWith('provider/')` 而不是 `includes`
 *
 * `includes` 会把「provider `deepseek` + 名字 `DeepSeek V4 Pro`」判成重复 ——
 * 而那正是**最需要**显示 provider 的一类（同名模型在多个 provider 下）。
 * 复合串的形状是确定的：provider 在前、紧跟一个 `/`。
 */
export function providerLabelOf(model: { name: string; group?: string }): string | undefined {
  const provider = model.group?.trim();
  if (!provider) return undefined;
  const name = model.name.toLowerCase();
  if (name.startsWith(`${provider.toLowerCase()}/`)) return undefined;
  return provider;
}
