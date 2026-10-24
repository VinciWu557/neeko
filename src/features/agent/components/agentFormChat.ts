import type { ChatLaunch, WireFormat } from '@/shared/types/agent';
import { transportOf } from '@/shared/types/agent';

/**
 * Agent 表单里 CHAT 启动配置的读写。
 *
 * # 为什么表单态是 argv 数组
 *
 * `ChatLaunch` 是 `{program, args, env}`，而 UI 需要可编辑的形态。这里**不做**
 * 「数组 → 一行文本」的投影：那条投影不幂等（`['--sys','hello world']` 会变成
 * `['--sys','hello','world']`），会让「打开设置页 → 保存」静默改写用户配置。
 *
 * 因此 argv 以数组形态贯穿表单、传输识别与提交 —— 形态转换只剩两件事：
 * 数组首项 ↔ `program`，其余 ↔ `args`。
 *
 * 这里**没有传输选项列表** —— 传输是从 argv 识别出来的（`transportOf`），
 * 不是用户可声明的。历史上那个下拉（acp/serve/jsonl/mock/pi-rpc）让用户去
 * 声明一个他无法改变的事实，选错只会得到跑不起来的配置。
 *
 * 传输的**展示文案**唯一来源是 `shared/types/agent.ts` 的 `TRANSPORT_LABELS`
 * （从 `TRANSPORTS` 表派生）—— 本文件曾有一份手写副本，与共享表漂移不会报错，
 * 已删除（re-export 保持既有 import 路径可用）。
 */
export { TRANSPORT_LABELS } from '@/shared/types/agent';

/**
 * 表单态（argv，首项是程序名）→ `ChatLaunch`；空 → `null`（无 CHAT 能力）。
 *
 * `wireFormat` 是 ACP 帧格式的**用户选择**（`'content-length'` 也算显式选择 ——
 * 显式值落盘后，后端装载期迁移就不会对 opencode 命名的配置重新推断出 NDJSON）。
 * 只有识别为 ACP 的启动命令才携带它：`wire_format` 只有 ACP 消费，
 * 其它传输带这个字段纯属配置噪音。
 */
export function buildChatLaunch(
  argv: readonly string[],
  envText: string,
  inprocess = false,
  wireFormat?: WireFormat,
): ChatLaunch | null {
  const env = parseEnvText(envText);
  const withEnv = Object.keys(env).length > 0 ? { env } : {};

  // 进程内实现：没有 argv，但有 CHAT 能力 —— 与「空命令 = 无能力」必须区分。
  if (inprocess) return { inprocess: true, ...withEnv };

  const [program, ...args] = argv;
  if (program === undefined) return null; // 无 argv → 无 CHAT 能力，env 一并丢弃

  const launch: ChatLaunch = { program, args, ...withEnv };
  if (wireFormat && transportOf(launch) === 'acp') {
    launch.wire_format = wireFormat;
  }
  return launch;
}

/**
 * `ChatLaunch` → 表单态 argv（`program` + `args`）。
 *
 * `program` 缺省时回落到 `command`：两者同一个二进制是最常见的情形，把回落
 * 结果**显示出来**让用户看得见自己要跑什么，而不是留一行空白。
 */
export function formatChatLaunch(
  launch: ChatLaunch | null | undefined,
  fallbackCommand: string,
): string[] {
  if (!launch) return [];
  // 进程内实现没有 argv；`inprocess` 由独立复选框承载。
  if (launch.inprocess) return [];
  const program = (launch.program ?? '').trim() || fallbackCommand;
  return program ? [program, ...(launch.args ?? [])] : [...(launch.args ?? [])];
}

/**
 * 多行 `KEY=value` → 对象。
 *
 * 规则（每条都有测试）：
 * - 忽略空行与 `#` 开头的**整行**注释（`KEY=#v` 的值就是 `#v`）；
 * - **只按第一个 `=` 切分** —— `URL=http://x?a=b` 的值必须保留；
 * - key / value 去两边空白；key 为空则整行忽略；
 * - 重复 key 后者胜（与 shell 一致）。
 */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue; // 没有 `=` 或 key 为空

    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!key) continue;
    out[key] = value;
  }
  return out;
}

/** 对象 → 多行文本（键序稳定，便于往返测试与 diff）。 */
export function formatEnvText(env: Record<string, string> | null | undefined): string {
  if (!env) return '';
  return Object.keys(env)
    .sort()
    .map((k) => `${k}=${env[k]}`)
    .join('\n');
}
