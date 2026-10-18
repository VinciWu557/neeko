/**
 * Slash commands available inside the TUI editor (`/` prefix).
 *
 * MVP set (design §6): help, clear, model (read-only), exit. These live inside
 * the TUI only — they do NOT register into DSH's host-level `CommandRuntime`
 * (R3.1: that surface is for cross-surface host commands, not per-surface UI).
 *
 * @module dsh-neeko/tui/commands
 */

/** One runnable TUI command. */
export interface TuiCommand {
  readonly name: string
  readonly description: string
}

/** The fixed MVP command set, in display order. */
export const TUI_COMMANDS: readonly TuiCommand[] = [
  { name: 'help', description: 'Show available commands and key hints' },
  { name: 'clear', description: 'Clear the transcript view (session log untouched)' },
  { name: 'model', description: 'Show the current model selection' },
  { name: 'exit', description: 'Quit the terminal UI' },
]

/** What running a command tells the app to do. */
export type CommandOutcome =
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'clear' }
  | { readonly kind: 'exit' }
  | /** Not a known command — treat the line as a normal prompt. */ { readonly kind: 'not-a-command' }

/**
 * Run one slash line. Pure: the app translates outcomes into actions.
 *
 * @param line - the submitted editor text.
 * @param context - read-only facts the messages may reference.
 * @returns the outcome for the app.
 */
export function runCommand(line: string, context: { readonly provider: string; readonly model: string }): CommandOutcome {
  const trimmed = line.trim()
  if (!trimmed.startsWith('/')) return { kind: 'not-a-command' }
  const name = trimmed.slice(1).trim().split(/\s+/u)[0]?.toLowerCase() ?? ''
  switch (name) {
    case 'help':
      return {
        kind: 'message',
        text: ['Commands:', ...TUI_COMMANDS.map((command) => `  /${command.name} — ${command.description}`), '', 'Keys: enter send · ctrl+c exit'].join('\n'),
      }
    case 'clear':
      return { kind: 'clear' }
    case 'model':
      return { kind: 'message', text: `model: ${context.provider}/${context.model}` }
    case 'exit':
      return { kind: 'exit' }
    default:
      return { kind: 'message', text: `unknown command: /${name} (try /help)` }
  }
}

/**
 * Whether the editor should offer these as autocomplete suggestions for the
 * current draft.
 * @param draft - the current editor text.
 * @returns the matching commands, in display order.
 */
export function suggestCommands(draft: string): readonly TuiCommand[] {
  if (!draft.startsWith('/')) return []
  const prefix = draft.slice(1).toLowerCase()
  return TUI_COMMANDS.filter((command) => command.name.startsWith(prefix))
}
