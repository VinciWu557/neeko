/** 下拉列表显示名修正：deepseek-harness → deepseek。 */
export function displayName(name: string): string {
  return name === 'deepseek-harness' ? 'deepseek' : name;
}
