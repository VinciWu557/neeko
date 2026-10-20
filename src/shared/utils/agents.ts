import claudeCodeIcon from '../../assets/agents/claude-code.png';
import cliIcon from '../../assets/agents/cli.svg';
import codebuddyIcon from '../../assets/agents/codebuddy.svg';
import codexIcon from '../../assets/agents/codex.png';
import geminiIcon from '../../assets/agents/gemini.png';
import grokIcon from '../../assets/agents/grok.ico';
import ompIcon from '../../assets/agents/omp.svg';
import opencodeIcon from '../../assets/agents/opencode.png';
import piIcon from '../../assets/agents/pi.svg';
import qoderIcon from '../../assets/agents/qoder.svg';
import reasonixIcon from '../../assets/agents/reasonix.svg';

const AGENT_ICONS: Record<string, string> = {
  'claude-code.png': claudeCodeIcon,
  'opencode.png': opencodeIcon,
  'gemini.png': geminiIcon,
  'codex.png': codexIcon,
  'qoder.svg': qoderIcon,
  'codebuddy.svg': codebuddyIcon,
  'pi.svg': piIcon,
  'omp.svg': ompIcon,
  'reasonix.svg': reasonixIcon,
  'grok.ico': grokIcon,
  'cli.svg': cliIcon,
};

export const PRESET_AGENT_ICONS = Object.keys(AGENT_ICONS);

export const DEFAULT_AGENT_ICON = 'cli.svg';

/**
 * 翻译未指定 agent 时的兜底。
 *
 * 单点定义：此前 `useDocumentTranslation` 与注释翻译按钮各写一次字面量，
 * 加/改默认 agent 要改两处、漏一处不报错。
 */
export const DEFAULT_TRANSLATION_AGENT_ID = 'opencode';

/**
 * 「这个 agent 能不能承接 AI 翻译」的**唯一判据**。
 *
 * ## 第一性原理
 *
 * 翻译走 `AgentAdapter`（后端 `adapter_for` 按 `AgentConfig.chat` 分派），
 * 所以「能翻译」`⟺`「声明了 chat 能力」`∧`「未被用户停用」。
 * 任何一个消费方自己重写这条判断，都会得到**略有不同**的集合 —— 这不是假设：
 * 抽取前 5 处实现里，2 处带 `enabled`、3 处不带，UI 会把已停用的 agent 列进
 * 下拉，而运行时又被另一处判掉。
 *
 * ## 为什么参数是 `unknown` 形状而非 `AgentConfig`
 *
 * `shared/utils` 不得反向依赖 `features/`；`AgentConfig` 已在
 * `shared/types/agent`，可以直接用 —— 这里保留窄参数是为了让调用方
 * 传筛过的子集时不被迫补全字段。
 */
export interface TranslatableAgentShape {
  id: string;
  /** 非空即声明了 chat 能力（`ChatStart` 联合类型）。 */
  chat?: unknown;
  /** 缺省视为启用（历史配置没有这个字段）。 */
  enabled?: boolean;
}

export function isTranslatableAgent(agent: TranslatableAgentShape): boolean {
  return agent.enabled !== false && Boolean(agent.chat);
}

/**
 * 从 agent 列表里筛出可用于翻译的子集。
 *
 * 与 {@link isTranslatableAgent} 同源：筛选与判定不得是两套逻辑。
 */
export function translatableAgents<T extends TranslatableAgentShape>(agents: readonly T[]): T[] {
  return agents.filter(isTranslatableAgent);
}

/**
 * 把配置里的翻译 agent 解析成**一个现在真的可用**的 id。
 *
 * ## 为什么必须有这一步
 *
 * 配置是持久化的，agent 列表是会变的。三种陈旧形态都会让翻译在运行时失败：
 * - agent 被删除 → 后端 `NotFound: agent not found: {id}`
 * - agent 失去 `chat` 能力（改成 CLI-only / headless-only）→ 后端
 *   `Unsupported: has no CHAT capability`
 * - 配置里是历史遗留的 id
 *
 * 这些错误对用户是一句看不懂的英文，而且**发生在点翻译之后** —— 那时已经付出了等待。
 *
 * ## 判据归属
 *
 * 可用性判定**在本函数内部完成**（走 {@link isTranslatableAgent}），调用方只负责
 * 传原始 `agents`。早期版本让调用方先筛好再传，结果每个调用方都得自己判断
 * 「什么算可用」—— 设置页因此漂移出了第二套判据。
 *
 * ## 回落顺序
 *
 * 配置值（若仍可用）→ 第一个可用 agent → `DEFAULT_TRANSLATION_AGENT_ID`。
 *
 * 最后一步不检查可用性：那是「连一个可聊 agent 都没有」时的最后防线，
 * 让后端给出**明确的** Unsupported 错误，比前端编造一个 id 更容易排查。
 */
export function resolveTranslationAgentId(
  configured: string | undefined | null,
  agents: readonly TranslatableAgentShape[],
): string {
  const usable = translatableAgents(agents);

  if (configured && usable.some((agent) => agent.id === configured)) return configured;
  return usable[0]?.id ?? DEFAULT_TRANSLATION_AGENT_ID;
}

/**
 * 配置里的 agent 是否已不可用（被删 / 失去 chat 能力 / 被停用）。
 *
 * 设置页用它把陈旧的 `agentId` **显式呈现**出来 —— HTML `select` 遇到不在
 * options 里的 value 会回落显示第一项，于是「配置存着一个坏 id」在界面上
 * 表现得像「没设置」，用户既看不出问题、也改不动，而翻译时照旧用那个坏 id。
 *
 * 与 {@link resolveTranslationAgentId} 共用同一判据，不另写一套。
 */
export function isTranslationAgentStale(
  configured: string | undefined | null,
  agents: readonly TranslatableAgentShape[],
): configured is string {
  if (!configured) return false;
  return !translatableAgents(agents).some((agent) => agent.id === configured);
}

export function getAgentIconSrc(icon: string | null | undefined): string | null {
  if (!icon) return null;
  return AGENT_ICONS[icon] ?? null;
}
