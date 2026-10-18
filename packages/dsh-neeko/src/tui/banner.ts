/**
 * Startup banner — the greeting drawn once when the TUI opens.
 *
 * Modeled on pi's header (`interactive-mode.js` `withLogo` + `pi-logo.js`):
 *
 * - **A half-block pixel logo, two lines tall.** pi draws its mark from `▀`/`█`
 *   with `foreground`/`background` pairs; the same technique is used here so the
 *   banner has identity without ASCII-art bloat.
 * - **Brand colors stay fixed across themes.** pi keeps its coral/blue/yellow
 *   even when the theme swaps, because the logo is the product mark, not UI
 *   chrome. Everything around it is themed.
 * - **Apple Terminal gets a text wordmark.** Its renderer leaves gaps between
 *   rows and misaligns half blocks (pi's own `supportsPiLogo()` guards this), so
 *   the fallback is a plain `neeko` wordmark.
 * - **Compact hints, one line.** pi prints a compressed keybinding line and
 *   points at the expander; a full cheat sheet would dominate the first screen.
 *
 * @module dsh-neeko/tui/banner
 */

import { isAppleTerminalSession, foregroundAnsi, rgbColor } from '@earendil-works/pi-tui'
import type { TerminalColorMode } from '@earendil-works/pi-tui'
import type { Theme } from './theme.ts'

/** Brand mark colors — deliberately theme-independent (pi does the same). */
const NEEKO_TEAL = rgbColor(86, 182, 194)
const NEEKO_BLUE = rgbColor(97, 175, 239)
const NEEKO_AMBER = rgbColor(229, 192, 123)
const RESET = '\x1b[0m'

/**
 * `DSH-NEEKO` in a 5-row pixel font (53 columns).
 *
 * Height/width were both driven by legibility:
 * - 2-row lowercase `dsh-neeko`: `e`/`o`/`s` share a silhouette at that height.
 * - 3-row uppercase: readable, but the `DSH-` half read as decoration.
 * - 4-column glyphs (44 cols): `D` and `O` both collapse into a box.
 * - **5 rows × 5 columns, 1-column gutter (53 cols)** — letters stay distinct
 *   and the full name fits an 80-column terminal with room for the version.
 *
 * The whole name is pixel-rendered: printing `dsh-` as plain text made the
 * product read as "NEEKO" with a stray prefix rather than "DSH-NEEKO".
 */
const WORDMARK = [
  '████   ████ █   █       █   █ █████ █████ █   █  ███',
  '█   █ █     █   █       ██  █ █     █     █  █  █   █',
  '█   █  ███  █████ ████  █ █ █ ████  ████  ███   █   █',
  '█   █     █ █   █       █  ██ █     █     █  █  █   █',
  '████  ████  █   █       █   █ █████ █████ █   █  ███',
] as const

/** Lines of the welcome banner, ready to print. */
export interface Banner {
  readonly lines: readonly string[]
}

/**
 * The pixel wordmark, colored with the brand ramp.
 *
 * Each row walks teal → blue → amber so the mark reads as one object rather
 * than three colored words; the product mark's colors stay fixed across themes
 * (pi does the same with its logo).
 *
 * @param mode - terminal color mode.
 * @returns one string per row.
 */
export function logoLines(mode: TerminalColorMode): readonly string[] {
  const fg = (color: ReturnType<typeof rgbColor>): string => foregroundAnsi(color, mode)
  const width = WORDMARK[0].length
  return WORDMARK.map((row, rowIndex) => {
    let out = ''
    let current: string | undefined
    for (let col = 0; col < row.length; col += 1) {
      const ch = row[col] ?? ' '
      // Horizontal thirds: teal | blue | amber.
      const color = col < width / 3 ? NEEKO_TEAL : col < (width * 2) / 3 ? NEEKO_BLUE : NEEKO_AMBER
      const ansi = fg(color)
      if (ch === ' ') {
        if (current !== undefined) { out += RESET; current = undefined }
        out += ' '
        continue
      }
      if (ansi !== current) { out += ansi; current = ansi }
      out += ch
    }
    if (current !== undefined) out += RESET
    void rowIndex
    return out
  })
}

/** Text fallback for terminals that mis-render half blocks. */
export function wordmark(mode: TerminalColorMode): string {
  return `${foregroundAnsi(NEEKO_TEAL, mode)}neeko${RESET}${foregroundAnsi(NEEKO_AMBER, mode)}·${RESET}${
    foregroundAnsi(NEEKO_BLUE, mode)}tui${RESET}`
}

/** Whether this terminal renders the half-block mark correctly. */
export function supportsLogo(): boolean {
  return !isAppleTerminalSession()
}

/** Facts the banner prints. */
export interface BannerFacts {
  /** Harness version string, without a leading `v`. */
  readonly version: string
  /** Active model, `provider/model`. */
  readonly model: string
  /** Working directory the session runs in. */
  readonly cwd: string
  /** Session id (shown truncated — it is not meant to be retyped). */
  readonly sessionId: string
}

/**
 * Shorten a session id for the banner.
 *
 * DSH ids look like `session-a5d9820c-e5c2-4da9-…`; a naive prefix slice prints
 * the literal `session-` and nothing identifying. Drop that prefix, then keep
 * the first uuid segment.
 *
 * @param id - the full session id.
 * @returns the identifying short form.
 */
export function shortenSessionId(id: string): string {
  const body = id.startsWith('session-') ? id.slice('session-'.length) : id
  // First dash-delimited segment is the uuid's leading group (8 hex chars).
  const first = body.split('-')[0] ?? body
  return first === '' ? id : first
}

/**
 * Render the startup banner.
 *
 * @param theme - active theme (colors everything except the mark).
 * @param facts - version / model / cwd / session.
 * @param options - force the text fallback (tests) and the color mode.
 * @returns the lines to print.
 */
export function renderBanner(
  theme: Theme,
  facts: BannerFacts,
  options: { readonly forceWordmark?: boolean; readonly mode?: TerminalColorMode } = {},
): Banner {
  const mode = options.mode ?? 'truecolor'
  const useLogo = options.forceWordmark === true ? false : supportsLogo()
  const version = theme.fg('dim', `v${facts.version}`)

  // Two lines: the mark (or wordmark) carries the version on its first line,
  // then a themed subtitle line, then the compressed key hints (pi's shape).
  const head = useLogo
    ? (() => {
        const rows = [...logoLines(mode)]
        const last = rows.pop() ?? ''
        return [...rows, `${last}  ${version}`]
      })()
    : [`${wordmark(mode)} ${version}`]

  const shortSession = shortenSessionId(facts.sessionId)
  const details = [
    theme.fg('muted', facts.model),
    theme.fg('dim', facts.cwd),
    theme.fg('dim', `session ${shortSession}`),
  ].join(theme.fg('dim', ' · '))

  const hints = [
    theme.fg('dim', '/'),
    theme.fg('muted', 'commands'),
    theme.fg('dim', '·'),
    theme.fg('dim', 'tab'),
    theme.fg('muted', 'complete'),
    theme.fg('dim', '·'),
    theme.fg('dim', 'ctrl+c'),
    theme.fg('muted', 'exit'),
  ].join(' ')

  return { lines: [...head, '', details, hints, ''] }
}
