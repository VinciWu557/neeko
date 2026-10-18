/**
 * Theme system for the TUI, modeled on pi's
 * (`pi-coding-agent/dist/modes/interactive/theme/`).
 *
 * pi's design, reduced to this TUI's needs:
 *
 * - A theme is `{ name, appearance, vars, colors }`. `vars` are named colors;
 *   `colors` maps **semantic tokens** (`accent`, `border`, `error`, …) to either
 *   a var reference or a literal color string. Var refs let one palette value
 *   drive several tokens.
 * - Every token resolves to a precomputed ANSI escape at construction, so the
 *   render hot path is a map lookup + concat (never a color parse per frame).
 * - `appearance` (`dark`/`light`) decides the terminal color mode fallback.
 *
 * Only the tokens this TUI actually paints are modeled; pi's full set includes
 * message/tool/scrollback surfaces that have no counterpart here yet.
 *
 * @module dsh-neeko/tui/theme
 */

import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { foregroundAnsi } from '@earendil-works/pi-tui'
import { parseColor } from '@earendil-works/pi-tui'
import type { Color, MarkdownTheme, TerminalColorMode } from '@earendil-works/pi-tui'
import { BUILTIN_THEMES } from './theme-data.ts'
import type { ThemeDocument } from './theme-data.ts'

export { BUILTIN_THEMES }
export type { ThemeDocument }

/**
 * Every theme token pi defines (56), in pi's own order.
 *
 * Transcribed from `pi-coding-agent`'s `theme-tokens.js` so that a **pi theme
 * file works unchanged**: locking the parser to the dozen tokens this TUI
 * paints today would reject valid pi themes outright, and would silently drop
 * their Markdown / syntax colors. Rendering still only reads what it uses.
 */
export const THEME_TOKENS = [
  'accent', 'border', 'borderAccent', 'borderMuted', 'success', 'error',
  'warning', 'muted', 'dim', 'text', 'thinkingText', 'scrollbarTrack',
  'scrollbarThumb', 'selectedBg', 'searchMatchBg', 'searchMatchText', 'userMessageBg', 'userMessageText',
  'customMessageBg', 'customMessageText', 'customMessageLabel', 'toolPendingBg', 'toolSuccessBg', 'toolErrorBg',
  'toolTitle', 'toolOutput', 'mdHeading', 'mdLink', 'mdLinkUrl', 'mdCode',
  'mdCodeBlock', 'mdCodeBlockBorder', 'mdQuote', 'mdQuoteBorder', 'mdHr', 'mdListBullet',
  'toolDiffAdded', 'toolDiffRemoved', 'toolDiffContext', 'syntaxComment', 'syntaxKeyword', 'syntaxFunction',
  'syntaxVariable', 'syntaxString', 'syntaxNumber', 'syntaxType', 'syntaxOperator', 'syntaxPunctuation',
  'thinkingOff', 'thinkingMinimal', 'thinkingLow', 'thinkingMedium', 'thinkingHigh', 'thinkingXhigh',
  'thinkingMax', 'bashMode',
] as const

/** A theme token name. */
export type ThemeToken = (typeof THEME_TOKENS)[number]

/** A resolved theme: token → ANSI escape, plus styling helpers. */
export class Theme {
  private readonly fgAnsi = new Map<string, string>()
  private readonly mode: TerminalColorMode

  constructor(
    readonly name: string,
    private readonly document: ThemeDocument,
    mode?: TerminalColorMode,
  ) {
    this.mode = mode ?? terminalColorMode(document.appearance)
    const vars = document.vars ?? {}
    for (const [token, value] of Object.entries(document.colors)) {
      if (value === undefined) continue
      // Var reference first (pi's semantics), then a literal color string.
      const literal = vars[value] ?? value
      const color: Color | undefined = literal === '' ? undefined : safeParse(literal)
      // `""` means "terminal default foreground": emit the reset sequence so the
      // token still produces well-formed output.
      this.fgAnsi.set(token, color === undefined ? '\x1b[39m' : foregroundAnsi(color, this.mode))
    }
  }

  /** Wrap text in a token's color; unknown tokens are a programming error. */
  fg(token: ThemeToken, text: string): string {
    const ansi = this.fgAnsi.get(token)
    if (ansi === undefined) throw new Error(`theme "${this.name}" has no color for "${token}"`)
    return `${ansi}${text}\x1b[39m`
  }

  /**
   * The {@linkcode ThemeToken} for a hex/okhsl swatch, for previews.
   * @param token - the token to read.
   * @returns the resolved escape sequence, or `''` for terminal-default tokens.
   */
  ansiOf(token: ThemeToken): string {
    return this.fgAnsi.get(token) ?? ''
  }

  /** The raw document, for the theme picker's preview. */
  get spec(): ThemeDocument {
    return this.document
  }
}

/** The terminal color mode implied by a theme's appearance. */
function terminalColorMode(appearance: 'dark' | 'light' | undefined): TerminalColorMode {
  if (appearance !== undefined) return 'truecolor'
  // Without a declared appearance, honour COLORTERM like the rest of the stack.
  return /^(truecolor|24bit)$/i.test(process.env['COLORTERM'] ?? '') ? 'truecolor' : '256color'
}

/** Parse a color, tolerating bad values in user-supplied theme files. */
function safeParse(value: string): Color | undefined {
  try {
    return parseColor(value)
  } catch {
    return undefined
  }
}

/**
 * Look up a built-in theme by name.
 * @param name - `dark` or `light`.
 * @returns the document, or `undefined` when unknown.
 */
export function findBuiltin(name: string): ThemeDocument | undefined {
  return BUILTIN_THEMES.find((theme) => theme.name === name)
}

/**
 * Resolve a theme document into a usable {@linkcode Theme}.
 *
 * ## Why this overlays a built-in
 *
 * Two contracts meet at this boundary:
 * - the **loader** fails open and accepts a partial palette (a user file may
 *   carry a single color — see `coerceThemeDocument`);
 * - {@linkcode Theme.fg} treats a missing token as a programming error and throws.
 *
 * Left alone, a *valid* partial file would throw on the first repaint of any
 * token it omits — a broken theme would break the TUI, which is exactly what
 * the loader's fail-open exists to prevent. So the document is overlaid on the
 * built-in of its appearance (`dark` when undeclared): every token resolves,
 * missing rows fall back to the base palette, explicit rows win per key.
 * Built-ins overlay onto themselves, making this a no-op for them.
 *
 * `appearance` is kept exactly as declared — it decides the terminal
 * color-mode fallback, and inheriting the base's would silently switch an
 * appearance-less theme to truecolor.
 *
 * @param document - the theme to resolve.
 * @returns the resolved theme.
 */
export function resolveTheme(document: ThemeDocument): Theme {
  return new Theme(document.name, overlayOn(document.appearance ?? 'dark', document))
}

/**
 * Merge `top` over the named built-in (`top` wins per key).
 * @param base - built-in theme name used as the fallback palette.
 * @param top - the document whose explicit rows survive.
 * @returns the merged document.
 */
function overlayOn(base: string, top: ThemeDocument): ThemeDocument {
  const baseDoc = findBuiltin(base) ?? findBuiltin('dark')
  if (baseDoc === undefined) return top
  const merged: ThemeDocument = {
    name: top.name,
    vars: { ...baseDoc.vars, ...top.vars },
    colors: { ...baseDoc.colors, ...top.colors },
  }
  return top.appearance === undefined ? merged : { ...merged, appearance: top.appearance }
}


// ── custom theme files ──────────────────────────────────────────────────────
// Same convention as pi: one JSON file per theme under
// `~/.dsh-neeko/themes/<name>.json` (pi uses `~/.pi/agent/themes`). The file
// name is the fallback theme name; unknown/invalid files are skipped rather
// than aborting startup — a broken user theme must not break the TUI.

/** Env override for our own theme directory (tests, alternate profiles). */
export const THEMES_DIR_ENV = 'DSH_NEEKO_THEMES_DIR'

/**
 * The directory scanned for this TUI's own theme files.
 * @param env - environment to read (tests inject their own).
 * @returns the absolute themes directory.
 */
export function themesDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[THEMES_DIR_ENV]?.trim()
  if (override !== undefined && override !== '') return override
  return join(homedir(), '.dsh-neeko', 'themes')
}

/**
 * pi's own custom-theme directory.
 *
 * pi's theme documents are plain JSON with the same shape this module parses
 * (`{ name?, appearance?, vars?, colors }`), so a theme authored for pi is
 * usable here **as-is** — that is the whole point of sharing the format. pi
 * keeps user themes under `$PI_AGENT_DIR/themes` (default `~/.pi/agent/themes`).
 *
 * @param env - environment to read.
 * @returns the absolute path.
 */
export function piThemesDir(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env['PI_AGENT_DIR']?.trim()
  if (agentDir !== undefined && agentDir !== '') return join(agentDir, 'themes')
  return join(homedir(), '.pi', 'agent', 'themes')
}

/**
 * Every directory scanned for user themes, most specific first.
 *
 * Later directories do not override earlier ones by name (the picker keeps the
 * first match), so a same-named local theme shadows a pi theme — local wins.
 *
 * @param env - environment to read.
 * @returns the directories to scan.
 */
export function themeSearchPaths(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const own = themesDir(env)
  const pi = piThemesDir(env)
  return own === pi ? [own] : [own, pi]
}

/** A loaded user theme plus where it came from (for the picker and /export). */
export interface UserTheme {
  readonly document: ThemeDocument
  readonly sourcePath: string
}

/**
 * Read every `*.json` theme in one directory.
 *
 * Fails open: an unreadable directory yields `[]`, and a bad file is skipped.
 * `name` falls back to the file stem when the document omits one.
 *
 * @param dir - directory to scan.
 * @returns the parsed themes, unsorted.
 */
function readThemeDir(dir: string): UserTheme[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return [] // no directory is the normal case, not an error
  }
  const themes: UserTheme[] = []
  for (const file of entries) {
    if (!file.endsWith('.json')) continue
    const sourcePath = join(dir, file)
    const stem = file.slice(0, -'.json'.length)
    try {
      const parsed: unknown = JSON.parse(stripBom(readFileSync(sourcePath, 'utf8')))
      const document = coerceThemeDocument(parsed, stem)
      if (document === undefined) continue
      themes.push({ document, sourcePath })
    } catch {
      // Invalid JSON or an unreadable file: skip, keep the rest usable.
    }
  }
  return themes
}

/**
 * Read user themes from every search path.
 *
 * pi-authored themes are picked up unchanged — the format is shared. When two
 * directories define the same theme name the **first** path wins, so a local
 * `~/.dsh-neeko/themes/neeko-dark.json` shadows pi's copy of the same name.
 *
 * @param dirs - directories to scan (defaults to {@linkcode themeSearchPaths}).
 * @returns the parsed themes, sorted by name.
 */
export function loadUserThemes(dirs: string | readonly string[] = themeSearchPaths()): readonly UserTheme[] {
  const paths = typeof dirs === 'string' ? [dirs] : dirs
  const seen = new Set<string>()
  const themes: UserTheme[] = []
  for (const dir of paths) {
    for (const theme of readThemeDir(dir)) {
      if (seen.has(theme.document.name)) continue
      seen.add(theme.document.name)
      themes.push(theme)
    }
  }
  return themes.sort((a, b) => a.document.name.localeCompare(b.document.name))
}

/** Strip a UTF-8 BOM, which some editors add and `JSON.parse` rejects. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Validate and narrow a parsed theme file.
 *
 * Only `colors` is required (same minimum pi enforces before its optional
 * typebox schema): an object mapping token names to color strings or var refs.
 *
 * @param value - parsed JSON.
 * @param fallbackName - the file stem.
 * @returns the document, or `undefined` when the shape is unusable.
 */
function coerceThemeDocument(value: unknown, fallbackName: string): ThemeDocument | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const colors = record['colors']
  if (typeof colors !== 'object' || colors === null) return undefined
  const normalizedColors: Partial<Record<ThemeToken, string>> = {}
  for (const token of THEME_TOKENS) {
    const raw = (colors as Record<string, unknown>)[token]
    if (typeof raw === 'string') normalizedColors[token] = raw
  }
  if (Object.keys(normalizedColors).length === 0) return undefined
  const rawVars = record['vars']
  const vars: Record<string, string> = {}
  if (typeof rawVars === 'object' && rawVars !== null) {
    for (const [key, raw] of Object.entries(rawVars as Record<string, unknown>)) {
      if (typeof raw === 'string') vars[key] = raw
    }
  }
  const appearance = record['appearance'] === 'light' || record['appearance'] === 'dark'
    ? record['appearance']
    : undefined
  const name = typeof record['name'] === 'string' && record['name'].trim() !== ''
    ? record['name'].trim()
    : fallbackName
  return { name, ...(appearance === undefined ? {} : { appearance }), ...(Object.keys(vars).length === 0 ? {} : { vars }), colors: normalizedColors }
}

/** One theme choice for the picker. */
export interface ThemeChoice {
  readonly name: string
  readonly appearance: 'dark' | 'light'
  /** Absolute path for user themes; absent for built-ins. */
  readonly sourcePath?: string
}

/**
 * Every selectable theme: built-ins first, then user files sorted by name.
 *
 * A user theme whose name collides with a built-in is skipped — the built-in
 * wins, so a stray file can never shadow `dark`/`light`.
 *
 * @param userThemes - loaded user themes (injected so the picker stays testable).
 * @returns the choices in display order.
 */
export function listThemes(userThemes: readonly UserTheme[] = loadUserThemes()): readonly ThemeChoice[] {
  const choices: ThemeChoice[] = BUILTIN_THEMES.map((theme) => ({
    name: theme.name,
    appearance: theme.appearance ?? 'dark',
  }))
  for (const theme of userThemes) {
    if (choices.some((choice) => choice.name === theme.document.name)) continue
    choices.push({
      name: theme.document.name,
      appearance: theme.document.appearance ?? 'dark',
      sourcePath: theme.sourcePath,
    })
  }
  return choices
}

/**
 * Resolve a theme by name across built-ins and user files.
 * @param name - the theme name.
 * @param userThemes - loaded user themes.
 * @returns the resolved theme, or `undefined` when the name is unknown.
 */
export function resolveThemeByName(name: string, userThemes: readonly UserTheme[] = loadUserThemes()): Theme | undefined {
  const builtin = findBuiltin(name)
  if (builtin !== undefined) return resolveTheme(builtin)
  const user = userThemes.find((theme) => theme.document.name === name)
  return user === undefined ? undefined : resolveTheme(user.document)
}

/**
 * Build pi-tui's `MarkdownTheme` from this theme's `md*` tokens.
 *
 * pi exposes the same mapping, which is why its Markdown blocks look identical
 * across surfaces: `mdHeading` → heading, `mdCode` → inline code, and so on.
 * Tokens the active theme does not define fall back to unstyled text.
 *
 * @param theme - the active theme.
 * @returns a Markdown theme for `Markdown` components.
 */
export function markdownThemeOf(theme: Theme): MarkdownTheme {
  const paint = (token: ThemeToken, text: string): string =>
    theme.spec.colors[token] === undefined ? text : theme.fg(token, text)
  return {
    heading: (text) => paint('mdHeading', text),
    link: (text) => paint('mdLink', text),
    linkUrl: (text) => paint('mdLinkUrl', text),
    code: (text) => paint('mdCode', text),
    codeBlock: (text) => paint('mdCodeBlock', text),
    codeBlockBorder: (text) => paint('mdCodeBlockBorder', text),
    quote: (text) => paint('mdQuote', text),
    quoteBorder: (text) => paint('mdQuoteBorder', text),
    hr: (text) => paint('mdHr', text),
    listBullet: (text) => paint('mdListBullet', text),
    // pi derives emphasis from the text token rather than a dedicated one.
    bold: (text) => text,
    italic: (text) => text,
    strikethrough: (text) => text,
    underline: (text) => text,
  }
}
