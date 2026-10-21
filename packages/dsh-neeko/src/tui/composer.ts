/**
 * The editor, with the working indicator embedded in its top border.
 *
 * ## What this adds over a plain `Editor`
 *
 * pi's `CustomEditor` (`custom-editor.js`) overrides `renderTopBorder` so the
 * activity line rides *inside* the frame:
 *
 * ```
 * ── ⠋ Working ────────────────────────────── ↑ 3 more ──
 * > type your message here
 * ────────────────────────────────────────────────────────
 * ```
 *
 * instead of taking a row of its own above the input. On a short terminal that
 * row is the difference between seeing what you are typing and not, and it is why
 * pi's composer looks like a box rather than a rule above a rule.
 *
 * ## What is not ported
 *
 * - **`app.*` key routing inside the editor.** pi's subclass intercepts actions
 *   in `handleInput` because `Editor` owns the keyboard. Here the app routes keys
 *   through its own `KeyScope` stack (`keymap.ts`) *before* anything reaches the
 *   editor, so a second interception layer inside the editor would mean two
 *   places deciding what a key does. The border is the whole port.
 * - **Extension shortcuts.** No extension system.
 *
 * @module dsh-neeko/tui/composer
 */

import { Editor } from '@earendil-works/pi-tui'
import type { EditorOptions, EditorTheme, TUI } from '@earendil-works/pi-tui'
import type { Theme } from './theme.ts'
import { StatusIndicator, borderWithStatus } from './status-indicator.ts'

/**
 * An `Editor` whose top border carries the activity indicator.
 *
 * Delegates everything to `Editor` except the top border, so editing, wrapping,
 * history, autocomplete and the cursor marker all behave exactly as pi-tui
 * implements them.
 */
export class Composer extends Editor {
  private indicator: StatusIndicator | undefined

  constructor(
    ui: TUI,
    theme: EditorTheme,
    private readonly palette: Theme,
    options: EditorOptions = {},
  ) {
    super(ui, theme, options)
  }

  /**
   * Attach or detach the indicator.
   *
   * Attached only while work is in flight: a `Loader` runs a timer, and one that
   * outlives the work repaints a settled screen forever (the exact defect the
   * app's own spinner had).
   *
   * @param indicator - the indicator to show, or `undefined` to draw a plain rule.
   */
  setIndicator(indicator: StatusIndicator | undefined): void {
    if (this.indicator === indicator) return
    this.indicator?.dispose()
    this.indicator = indicator
  }

  /** The indicator currently attached, if any. */
  get attachedIndicator(): StatusIndicator | undefined {
    return this.indicator
  }

  /**
   * The top border: a rule with the status embedded.
   *
   * @param width - the editor's width in columns.
   * @param hiddenLineCount - rows of input scrolled out above, for the `↑ N` marker.
   * @returns exactly `width` columns.
   */
  protected renderTopBorder(width: number, hiddenLineCount: number): string {
    return borderWithStatus({
      width,
      indicator: this.indicator,
      hiddenAbove: hiddenLineCount,
      theme: this.palette,
    })
  }
}

/**
 * The editor theme, painted from the active palette.
 *
 * pi's `getEditorTheme()` (`theme.js`): the border is `borderMuted` — a *subtle*
 * rule. The previous theme returned the text unchanged, so the frame had no colour
 * of its own and read as part of the transcript above it.
 *
 * `selectList` comes from pi's `getSelectListTheme()` shape: the selected row's
 * prefix and text in `accent`, descriptions and the no-match line in `muted`.
 * Colouring those is what makes the autocomplete menu legible as a menu.
 *
 * @param theme - the palette.
 * @returns the editor theme.
 */
export function composerTheme(theme: Theme): EditorTheme {
  const paint = (token: 'borderMuted' | 'accent' | 'muted', text: string): string =>
    theme.has(token) ? theme.fg(token, text) : text
  return {
    borderColor: (text: string) => paint('borderMuted', text),
    selectList: {
      selectedPrefix: (text: string) => paint('accent', text),
      selectedText: (text: string) => paint('accent', text),
      description: (text: string) => paint('muted', text),
      scrollInfo: (text: string) => paint('muted', text),
      noMatch: (text: string) => paint('muted', text),
    },
  }
}
