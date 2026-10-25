/**
 * Strip terminal protocol from captured output.
 *
 * ## Why this is shared
 *
 * Seven test files each grew their own version, and the rules drifted:
 *
 * | file | pattern |
 * | --- | --- |
 * | `tui-render-row` | `[0-9;]*m` |
 * | `tui-status-bar` | `[a-z0-9;]*m` |
 * | `tui-banner` | `[0-9;?]*[a-zA-Z]` |
 * | `tui-interaction-glue` | `[0-9;]*m` + `_pi:` |
 *
 * A test could therefore assert on text that a sibling would have removed, and
 * a rule added to one copy silently did not apply to the rest. The three `strip()`
 * copies inside `tui-fullscreen.spec.ts` had already drifted this way.
 *
 * ## What it removes
 *
 * - **SGR** — `\x1b[…m`, including the compound `38;2;r;g;b` form a theme emits.
 * - **Cursor / screen control** — `\x1b[…H`, `[J`, `[K` and private modes
 *   `\x1b[?…h/l`; pi-tui uses these for every repaint.
 * - **OSC** — `\x1b]…\x07` or `\x1b]…\x1b\\`, which is how hyperlinks and the
 *   clipboard travel.
 * - **pi-tui fake-cursor markers** — `\x1b_pi:…\`, render-time protocol that is
 *   never visible text.
 *
 * @param text - raw bytes as they were written to the terminal.
 * @returns only the characters a user would see.
 */
export function stripAnsi(text: string): string {
  return text
    // CSI: everything from ESC [ to a final byte, which covers SGR (`m`) as well
    // as the cursor (`H`, `J`, `K`) and private-mode (`?25l`) sequences.
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/gu, '')
    // pi-tui's fake cursor: `ESC _ pi:… ESC \`.
    .replace(/\x1b_pi:[^\\]*\\/gu, '')
    // OSC: terminated by BEL or ST.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, '')
}
