/**
 * Host surface adapters: read DSH's command registry (list + execute) and
 * skill catalogue.
 *
 * These were inline in `runner.ts` until three bugs proved they need tests:
 *
 * 1. `skills.list()` **must receive `cwd`** — without it DSH reads only the
 *    global layer, so a repo's `.dsh/skills` and `.agents/skills` are invisible
 *    (observed as `skills=0` in a repo that has 21).
 * 2. The catalogue has to be read **before** `TuiApp` is constructed, because
 *    the `/` autocomplete provider snapshots it in the constructor.
 * 3. `commands.execute()` takes the **complete slash line** (leading slash
 *    included) — it parses it itself. Stripping the slash makes every host
 *    command "not resolve".
 *
 * All three are decisions this module now owns, so they can be asserted
 * against a fake context instead of a live agent.
 *
 * @module dsh-neeko/tui/host-commands
 */

/** One command discovered from the host registry. */
export interface HostCommandInfo {
  readonly name: string
  readonly description: string
  /** Free-form argument hint advertised by the handler. */
  readonly inputHint?: string
}

/** One skill discovered from the host catalogue. */
export interface SkillInfo {
  readonly name: string
  readonly description: string
}

/** The slice of DSH's `commands` service this module needs. */
export interface CommandRegistryLike {
  list(agent: unknown): readonly {
    name: string
    description: string
    input?: { hint?: string }
  }[]
}

/** The slice of DSH's `skills` service this module needs. */
export interface SkillRegistryLike {
  list(options?: { cwd?: string }): Promise<readonly { name: string; description: string }[]>
}

/** What `commands.execute()` reports for one line. */
export interface HostExecutionResult {
  readonly kind: 'success' | 'error'
  readonly text?: string
}

/** The slice of DSH's `commands` service needed to *run* a line. */
export interface CommandExecuteRegistryLike {
  /**
   * Run a complete slash line. The registry parses the line itself and maps
   * errors into `result.kind` — it returns `undefined` when nothing resolved.
   */
  execute(
    agent: unknown,
    line: string,
    attachments: readonly unknown[],
    signal: AbortSignal,
  ): Promise<{ readonly result: HostExecutionResult } | undefined>
}

/**
 * Map `commands.list()` descriptors to the completion catalogue.
 *
 * @param registry - the host command registry, or `undefined` when unmounted.
 * @param agent - the live agent the registry is scoped to.
 * @returns the descriptors, or `[]`.
 */
export function collectHostCommands(
  registry: CommandRegistryLike | undefined,
  agent: unknown,
): readonly HostCommandInfo[] {
  if (registry === undefined) return []
  return registry.list(agent).map((command) => ({
    name: command.name,
    description: command.description,
    ...(command.input?.hint === undefined ? {} : { inputHint: command.input.hint }),
  }))
}

/**
 * Read the skill catalogue for one workspace.
 *
 * **`cwd` is mandatory in practice**: omitting it makes DSH read the global
 * layer only, which is why a project's skills silently disappear.
 *
 * @param registry - the host skill registry, or `undefined` when unmounted.
 * @param cwd - workspace root used for project-layer discovery.
 * @returns the skill summaries, or `[]` on absence/failure.
 */
export async function collectSkills(
  registry: SkillRegistryLike | undefined,
  cwd: string,
): Promise<readonly SkillInfo[]> {
  if (registry === undefined) return []
  try {
    const summaries = await registry.list({ cwd })
    return summaries.map((skill) => ({ name: skill.name, description: skill.description }))
  } catch {
    // Discovery is provider-backed (filesystem, remote); a broken provider must
    // not take the TUI down — the menu simply omits skills.
    return []
  }
}

/**
 * Normalise a submitted slash line for `commands.execute()`.
 *
 * The registry parses the line itself and requires the leading slash. This is a
 * named function so the "don't strip the slash" rule has one home.
 *
 * @param line - the raw editor submission.
 * @returns the line to hand to the registry.
 */
export function toExecuteLine(line: string): string {
  const trimmed = line.trim()
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

/**
 * Run one slash line against the host registry.
 *
 * Lives beside {@linkcode toExecuteLine} so the two halves of the contract —
 * "normalise the line" and "the registry parses it, keep the slash" — are owned
 * by one module, together with the registry shape.
 *
 * @param registry - the host command registry, or `undefined` when unmounted.
 * @param agent - the live agent the registry is scoped to.
 * @param line - the raw editor submission.
 * @returns the settled result, or `undefined` when nothing matched.
 */
export async function executeHostCommand(
  registry: CommandExecuteRegistryLike | undefined,
  agent: unknown,
  line: string,
): Promise<HostExecutionResult | undefined> {
  if (registry === undefined) return undefined
  // The signal exists because the registry requires one; there is no
  // cancellation surface for a TUI command yet, so it lives for this call.
  const signal = new AbortController().signal
  const execution = await registry.execute(agent, toExecuteLine(line), [], signal)
  if (execution === undefined) return undefined
  const { kind, text } = execution.result
  return { kind, ...(text === undefined ? {} : { text }) }
}
