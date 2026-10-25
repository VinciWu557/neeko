/**
 * The "how do I get back in" line printed when the TUI exits.
 *
 * pi ends `shutdown()` with `To resume this session: pi --session <uuid>`
 * (`interactive-mode.js`). The shape is worth copying — one line, one pasteable
 * command — but the command is ours, and dsh reaches this TUI **only** through
 * the profile: bare `dsh --session <id>` boots the default profile and never
 * loads the `neeko-tui` row, so a hint written that way would be a command that
 * does not resume anything.
 *
 * @module dsh-neeko/tui/resume-hint
 */

/** The profile this runner is mounted by. */
const PROFILE = 'neeko'

/**
 * Quote a value only when a shell would split it.
 *
 * Same rule pi uses (`quoteIfNeeded`): leave plain ids alone — a uuid has no
 * metacharacters, and quoting it makes the hint look more alarming than it is.
 *
 * @param value - the raw argument.
 * @returns the value, single-quoted when it contains anything shell-significant.
 */
function quoteIfNeeded(value: string): string {
  return value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value)
    ? value
    : `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * Build the resume hint, or `undefined` when there is nothing to resume.
 *
 * @param options.sessionId - the live session's id.
 * @returns the line to print, or `undefined` when the id is missing/blank.
 */
export function resumeHint(options: { readonly sessionId: string }): string | undefined {
  const id = options.sessionId.trim()
  if (id === '') return undefined
  return `To resume this session: dsh --profile ${PROFILE} --tui --session ${quoteIfNeeded(id)}`
}
