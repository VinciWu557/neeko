/**
 * argv 列表的纯操作（表单态直接持有 `string[]`，不做有损投影）。
 *
 * # 为什么不再用「一行文本」
 *
 * 旧实现把 `string[]` 投影成空格分隔的一行（`splitArgs` / `join(' ')`）。
 * 该投影**不幂等**，因此每次「打开设置页 → 保存」都会静默改写用户配置：
 *
 * | argv | 投影成文本 | 再解析回来 |
 * | --- | --- | --- |
 * | `['--sys', 'hello world']` | `"--sys hello world"` | `['--sys','hello','world']` |
 * | `['a', '', 'b']` | `"a  b"` | `['a','b']` |
 *
 * 换一个更聪明的分词器只能把损失减小，不能消除 —— 因为「文本」这个载体本身
 * 不承载参数边界。让表单态**直接就是数组**，投影就不存在了，这类缺陷从根上消失。
 *
 * # 为什么不引第三方库
 *
 * `shell-quote` 会做 shell 展开（`$HOME/x` → `/x`、`&&` → 运算符节点），而我们的
 * argv 是直传进程的（WSL/SSH 路径由 `join_quoted_command` 用单引号转义），语义不对；
 * `string-argv` 语义正确但没有 formatter，且引号内不反转义 —— 同时含两种引号的值
 * 无法表达。两者都只是「损失更小的投影」，不解决问题。
 */

/**
 * 替换指定位置的参数值。
 *
 * 空串是**合法值**（`git commit -m ""`），不在这里归一成「未填」—— 那是
 * [`trimArgList`] 在提交边界上的职责。
 */
export function setArgAt(args: readonly string[], index: number, value: string): string[] {
  if (index < 0 || index >= args.length) return [...args];
  const next = [...args];
  next[index] = value;
  return next;
}

/** 追加一个空槽位（用户点「+ Add」）。 */
export function appendArg(args: readonly string[]): string[] {
  return [...args, ''];
}

/** 移除指定位置的参数。 */
export function removeArgAt(args: readonly string[], index: number): string[] {
  if (index < 0 || index >= args.length) return [...args];
  return args.filter((_, i) => i !== index);
}

/**
 * 裁掉**尾部**未填的槽位（提交边界用）。
 *
 * 只裁尾部：中间的 `''` 是用户明确要的空参数，必须保留。空白串与空串同义
 * —— 都表示「这一行没填」。
 */
export function trimArgList(args: readonly string[]): string[] {
  const isBlank = (s: string): boolean => s.trim() === '';
  let end = args.length;
  while (end > 0 && isBlank(args[end - 1] ?? '')) end -= 1;
  return args.slice(0, end);
}
