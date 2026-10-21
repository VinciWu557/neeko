import type { ChatStart } from '@/shared/types/agent';

/**
 * Agent 表单里 CHAT 传输相关的定义与形态转换。
 *
 * # 为什么表单态不用 `ChatStart`
 *
 * `ChatStart` 现在是联合类型：裸字符串（旧格式）或 `{ transport: 'acp', args }`
 * （ACP 需要附加子命令）。若表单态直接用它，`<select>` 的 value 就得在两种形态间
 * 来回转换，每次 onChange 都要先判形态 —— 而 `<select>` 只接受字符串。
 *
 * 拆成「传输名 + args 文本」后，形态转换只发生在两个边界：
 * 读（`toTransport` / `toAcpArgsText`）与写（`buildChatStart`）。
 */

/** 表单内部只处理传输标识字符串。 */
export type ChatTransport = 'acp' | 'serve' | 'jsonl' | 'mock' | 'pi-rpc';

/** 传输下拉的选项。 */
export const CHAT_OPTIONS: { value: ChatTransport; label: string; hint: string }[] = [
  { value: 'acp', label: 'ACP', hint: 'JSON-RPC stdio subprocess' },
  { value: 'serve', label: 'Serve', hint: 'opencode serve · HTTP+SSE' },
  { value: 'jsonl', label: 'JSON-Lines', hint: 'Custom stdio protocol' },
  { value: 'mock', label: 'Mock', hint: 'In-process mock (no subprocess)' },
  { value: 'pi-rpc', label: 'Pi RPC', hint: 'pi --mode rpc · private NDJSON' },
];

/** 选中传输后的说明文案。 */
export const CHAT_HINTS: Record<ChatTransport, string> = {
  acp: 'Agent Client Protocol over JSON-RPC stdio (subprocess)',
  serve: 'opencode serve HTTP + SSE transport',
  jsonl: 'Custom JSON-Lines stdio protocol',
  mock: 'In-process ACP mock, no command required',
  'pi-rpc': 'Pi private rpc protocol (`pi --mode rpc`) — single process, no ACP',
};

/** 表单态 → 持久化形态。
 *
 * ACP 有参数时写对象形态（`{transport, args}`），否则写裸字符串 —— 与后端
 * `Serialize` 的取舍一致（无参数不制造 diff），也让旧配置继续可读。
 */
export function buildChatStart(
  transport: ChatTransport | '',
  acpArgsText: string,
  splitArgs: (text: string) => string[],
): ChatStart | null {
  if (!transport) return null;
  if (transport !== 'acp') return transport;
  const args = splitArgs(acpArgsText);
  return args.length > 0 ? { transport: 'acp', args } : 'acp';
}
