/**
 * Tool-call presentation: name → variant → header, emoji and result body.
 *
 * ## Why a variant table instead of per-tool components
 *
 * pi's TUI classifies a tool into one of seven **row variants** (`read`,
 * `search`, `bash`, `write`, `edit`, `code`, `others`) and renders every tool of
 * a class the same way. The alternative — a component per tool name — needs a
 * change to the UI every time a plugin registers a tool, which is exactly the
 * open/closed boundary this module sits on. New tools therefore need **no code
 * change**: an unknown name falls into `others` and still renders correctly.
 *
 * The tables mirror `@xmoon76/dsh-pi-tui`'s `present.ts` so a tool reads the same
 * in both TUIs.
 *
 * @module dsh-neeko/tui/tool-present
 */

/** The seven presentation classes a tool can fall into. */
export type ToolVariant = 'read' | 'search' | 'bash' | 'write' | 'edit' | 'code' | 'others'

/** Row title per variant (design literals, not translatable copy). */
export const VARIANT_TITLES: Readonly<Record<ToolVariant, string>> = {
  search: 'Search',
  read: 'Read',
  bash: 'Bash',
  write: 'Write',
  edit: 'Edit',
  code: 'Code',
  others: 'Tool call',
}

/** Leading glyph per variant. */
const VARIANT_EMOJIS: Readonly<Record<ToolVariant, string>> = {
  read: '📖',
  search: '🔍',
  bash: '🖥️',
  write: '📝',
  edit: '✏️',
  code: '⚙️',
  others: '🛠️',
}

/**
 * Tool name → variant.
 *
 * A name absent from this table is `others` — deliberately, so a newly
 * registered tool renders without touching this file.
 */
export const TOOL_VARIANTS: Readonly<Record<string, ToolVariant>> = {
  bash: 'bash',
  pwsh: 'bash',
  read: 'read',
  web_fetch: 'read',
  web_search: 'search',
  grep: 'search',
  glob: 'search',
  write: 'write',
  edit: 'edit',
  run_code: 'code',
  cordis_package_inspect: 'read',
  cordis_runtime_inspect: 'read',
  cordis_run: 'others',
  cordis_stop: 'others',
  cordis_undefine: 'others',
}

/** Tool-owned titles that refine a generic variant without replacing it. */
const TOOL_TITLES: Readonly<Record<string, string>> = {
  cordis_package_inspect: 'Inspect',
  cordis_runtime_inspect: 'Inspect',
  cordis_run: 'Run Cordis Plugin',
  cordis_stop: 'Stop Cordis Plugin',
  cordis_undefine: 'Remove Cordis Plugin',
  pwsh: 'Pwsh',
}

/**
 * Synthetic cards the session log produces without a registry definition
 * (local `!` shell runs, workflow bookkeeping). Same refinement mechanism as
 * {@linkcode TOOL_TITLES}; without them these cards fall into the generic row.
 */
const SYNTHETIC_TITLES: Readonly<Record<string, string>> = {
  shell: 'Shell',
  subagent: 'Subagent',
  workflow: 'Workflow',
  'workflow-member': 'Workflow Agent',
  error: 'Error',
  interrupted: 'Interrupted',
}

/** Emoji per exact tool name, for cards without a registry entry. */
const SYNTHETIC_EMOJIS: Readonly<Record<string, string>> = {
  shell: '🖥️',
  subagent: '🤖',
  workflow: '🧵',
  'workflow-member': '🤖',
  error: '❌',
  interrupted: '⏹️',
}

/**
 * Which argument key names the row's subject, in preference order.
 *
 * A tool row is useful only if it says *what it acted on*; `{"path":"a.ts"}` must
 * read as `Read a.ts`, not as raw JSON.
 */
const SUMMARY_KEYS: Readonly<Record<ToolVariant, readonly string[]>> = {
  bash: ['description', 'command'],
  read: ['path', 'file_path', 'url'],
  search: ['query', 'pattern', 'url'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  code: ['description'],
  others: [],
}

/** Classify a tool name into its variant; unknown names are `others`. */
export function classifyTool(name: string): ToolVariant {
  return TOOL_VARIANTS[name] ?? 'others'
}

/** The leading glyph for one tool name. */
export function toolEmoji(name: string): string {
  const exact = SYNTHETIC_EMOJIS[name]
  if (exact !== undefined) return exact
  if (name.startsWith('/')) return '🎛️'
  return VARIANT_EMOJIS[classifyTool(name)]
}

/** The first line of a text. */
export function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

/** The last non-empty line of a text. */
export function latestLine(text: string): string {
  const visible = text.trimEnd()
  const newline = visible.lastIndexOf('\n')
  return newline === -1 ? visible : visible.slice(newline + 1)
}

/**
 * Strip the workspace root from a workspace-rooted path (display only).
 *
 * Absolute paths crowd the row and bury the part that distinguishes two files.
 * Only the root prefix is peeled — a path outside the workspace is unchanged, so
 * nothing becomes ambiguous.
 *
 * @param text - the path (or any text carrying one).
 * @param cwd - session workspace root; absent leaves the text unchanged.
 * @returns the text with the root prefix removed.
 */
export function relativizeToCwd(text: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return text
  const root = cwd.replace(/[/\\]+$/u, '')
  if (text.startsWith(`${root}/`) || text.startsWith(`${root}\\`)) return text.slice(root.length + 1)
  return text
}

/** Parse a tool call's raw argument JSON; absent on malformed input. */
function parseArgs(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'string') {
    return typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : undefined
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** The first string value among `keys`, in preference order. */
function pickString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/**
 * Derive the row's subject from its arguments.
 *
 * Preference: the variant's own key, then any string argument, then the raw text
 * — so an unfamiliar tool's row still names something the user recognises.
 *
 * @param variant - the tool's variant.
 * @param args - parsed arguments, or the raw value when parsing failed.
 * @returns one line of subject text.
 */
export function deriveSummary(variant: ToolVariant, args: unknown): string {
  const parsed = parseArgs(args)
  if (parsed === undefined) return firstLine(typeof args === 'string' ? args : '')
  const picked = pickString(parsed, SUMMARY_KEYS[variant])
  if (picked !== undefined) return firstLine(picked)
  for (const value of Object.values(parsed)) {
    if (typeof value === 'string' && value !== '') return firstLine(value)
  }
  return firstLine(typeof args === 'string' ? args : '')
}

/** A tool row's header: what to call it and what it acted on. */
export interface ToolHeader {
  readonly title: string
  readonly summary: string
  readonly emoji: string
}

/**
 * Build the header for one tool call.
 *
 * Unknown variants carry the tool name alongside the summary, so a tool this
 * table has never seen is still identifiable instead of reading as a bare
 * `Tool call`.
 *
 * @param name - the tool name.
 * @param args - parsed arguments, or the raw argument value.
 * @param cwd - workspace root for relativization.
 * @returns title, summary and leading glyph.
 */
export function toolHeader(name: string, args: unknown, cwd?: string): ToolHeader {
  const variant = classifyTool(name)
  const owned = TOOL_TITLES[name] ?? SYNTHETIC_TITLES[name]
  const base = relativizeToCwd(deriveSummary(variant, args), cwd)
  const summary = variant === 'others' && owned === undefined && base !== ''
    ? `${name} · ${base}`
    : base
  // A slash command is a control action, not a tool: show it without the slash.
  const title = owned ?? (name.startsWith('/') ? name.slice(1) : VARIANT_TITLES[variant])
  return { title, summary, emoji: toolEmoji(name) }
}

/**
 * How many characters a folded row shows before truncating.
 *
 * Deliberately short: a folded transcript is meant to be *scanned*, and 20
 * characters is enough to tell two messages apart. Anything longer and the fold
 * no longer buys the vertical space that made it worth doing.
 */
export const FOLDED_CHARS = 20

/**
 * Collapse text to one bounded line, marking truncation.
 *
 * Newlines collapse to spaces: a folded row must occupy exactly one line, or the
 * fold stops saving the screen space it exists to save.
 *
 * @param text - the full text.
 * @param limit - maximum characters; defaults to {@linkcode FOLDED_CHARS}.
 * @returns one line, ending in `…` when it was cut.
 */
export function foldText(text: string, limit = FOLDED_CHARS): string {
  const oneLine = text.replace(/\s+/gu, ' ').trim()
  if (oneLine.length <= limit) return oneLine
  return `${oneLine.slice(0, limit)}…`
}

/**
 * Whether a tool result is just a document, whose path is all a folded row needs.
 *
 * Reading a file produces pages of content; showing a slice of it tells the user
 * less than the filename does, because the *what* is more useful than the *some*.
 *
 * @param name - the tool name.
 * @returns true for file-oriented readers.
 */
export function isFileRead(name: string): boolean {
  return classifyTool(name) === 'read'
}

