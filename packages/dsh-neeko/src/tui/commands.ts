/**
 * Slash commands available inside the TUI editor (`/` prefix).
 *
 * MVP set (design §6): help, clear, model, exit. These live inside the TUI
 * only — they do NOT register into DSH's host-level `CommandRuntime`
 * (R3.1: that surface is for cross-surface host commands, not per-surface UI).
 *
 * `/model <id>` selects for the *next* step: this module only classifies the
 * line (`use-model`), the app validates it against the live catalogue and calls
 * `selectModel`, and the runner mutates the agent-scoped `ModelSelectionRef`.
 * DSH's `installModelSelection` takes a mutable ref precisely for this
 * (`current` is read at step entry, `assembled` records what the running step
 * already used).
 *
 * @module dsh-neeko/tui/commands
 */

/** One row offered for a command's argument (pi's `AutocompleteItem` shape). */
export interface ArgumentItem {
  /** Text inserted when chosen. */
  readonly value: string
  readonly label: string
  readonly description?: string
}

/** One runnable TUI command, shaped for pi-tui's slash autocomplete. */
export interface TuiCommand {
  readonly name: string
  readonly description: string
  /** Placeholder shown after the command name in the completion menu. */
  readonly argumentHint?: string
  /**
   * Argument completions for `/<name> <prefix>`.
   *
   * Returning items makes pi-tui render them **inside the editor's own frame**
   * (below the input, within its borders) — which is how pi shows the model
   * picker. Returning `null`/`[]` means "no completions here".
   */
  readonly getArgumentCompletions?: (prefix: string) => readonly ArgumentItem[] | null
}

/**
 * The fixed MVP command set, in display order.
 *
 * These feed the editor's `/` menu (`buildCommands` → `LiveSlashProvider`), so
 * typing `/` opens a menu with every command and its description — pi's
 * behaviour. Keep `description` short: it renders inline next to the name.
 */
export const TUI_COMMANDS: readonly TuiCommand[] = [
  { name: 'help', description: 'Show commands and key hints' },
  { name: 'clear', description: 'Clear the transcript view' },
  { name: 'model', description: 'Choose the model for the next step', argumentHint: '<name>' },
  { name: 'theme', description: 'Switch the color theme', argumentHint: '[dark|light]' },
  { name: 'exit', description: 'Quit the terminal UI' },
]

/** What running a command tells the app to do. */
export type CommandOutcome =
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'clear' }
  | { readonly kind: 'exit' }
  | /** Open the model picker (the app fetches the list and renders it). */
    { readonly kind: 'pick-model' }
  | /** Switch to a named model (`/model <id>`, usually via tab completion). */
    { readonly kind: 'use-model'; readonly id: string }
  | /** Open the theme picker. */
    { readonly kind: 'pick-theme' }
  | /** Switch straight to a named theme (`/theme light`). */
    { readonly kind: 'use-theme'; readonly name: string }
  | /**
   * A slash line this module does not own.
   *
   * Deliberately a **variant, not a message with a magic prefix**: the app must
   * route it to the host command registry, and routing on `text.startsWith(...)`
   * would break silently the moment the wording changes. `line` is the raw
   * submission so the dispatcher does not have to re-derive it.
   */
    { readonly kind: 'unknown-command'; readonly name: string; readonly line: string }
  | /** Not a slash line at all — send it to the model. */ { readonly kind: 'not-a-command' }

/**
 * The free-text argument after a command name (`/theme  ocean ` → `ocean`).
 *
 * One home for the parse so `/model` and `/theme` cannot drift into reading
 * their arguments differently.
 *
 * @param trimmedLine - the trimmed submission (leading `/` included).
 * @param name - the lower-cased command name that was matched.
 * @returns the argument, or `''` when the command was called bare.
 */
function argumentOf(trimmedLine: string, name: string): string {
  return trimmedLine.slice(1 + name.length).trim()
}

/**
 * Run one slash line. Pure: the app translates outcomes into actions.
 * @param line - the submitted editor text.
 * @returns the outcome for the app.
 */
export function runCommand(line: string): CommandOutcome {
  const trimmed = line.trim()
  if (!trimmed.startsWith('/')) return { kind: 'not-a-command' }
  const name = trimmed.slice(1).trim().split(/\s+/u)[0]?.toLowerCase() ?? ''
  switch (name) {
    case 'help':
      return {
        kind: 'message',
        text: ['Commands:', ...TUI_COMMANDS.map((command) => `  /${command.name} — ${command.description}`), '', 'Keys: enter send · / commands · tab or ↑/↓ + enter to complete · ctrl+c exit'].join('\n'),
      }
    case 'clear':
      return { kind: 'clear' }
    case 'model': {
      // `/model <id>` applies directly; a bare `/model` opens the picker.
      const argument = argumentOf(trimmed, name)
      return argument === '' ? { kind: 'pick-model' } : { kind: 'use-model', id: argument }
    }
    case 'theme': {
      // `/theme <name>` applies directly; a bare `/theme` opens the picker.
      const argument = argumentOf(trimmed, name)
      return argument === '' ? { kind: 'pick-theme' } : { kind: 'use-theme', name: argument }
    }
    case 'exit':
      return { kind: 'exit' }
    default:
      return { kind: 'unknown-command', name, line: trimmed }
  }
}

/** One command discovered from the host (DSH's `commands` service). */
export interface HostCommand {
  readonly name: string
  readonly description: string
  /** Free-form argument hint advertised by the handler. */
  readonly inputHint?: string
}

/** One skill discovered from the host (DSH's `skills` service). */
export interface HostSkill {
  readonly name: string
  readonly description: string
}

/** Builds the slash-command table, with argument completions from the app. */
export interface CommandSources {
  /**
   * Commands registered by DSH plugins (skills-as-commands, `/compact`, …).
   *
   * They are rendered in the same `/` menu as this TUI's own commands, and are
   * dispatched through `ctx.commands.execute`, so the menu is the single place
   * a user discovers everything they can type.
   */
  listHostCommands?: () => readonly HostCommand[]
  /** Skills the host exposes; shown under `/skill:` entries. */
  listSkills?: () => readonly HostSkill[]
  /** Every selectable model, as `provider/id` values with display labels. */
  listModels: () => readonly (ArgumentItem & { readonly provider: string; readonly id: string })[]
  /** Selectable theme names. */
  listThemes: () => readonly string[]
}

/**
 * Build the command table with argument completions wired in.
 *
 * Argument completions are what make the picker appear **inside the editor's
 * frame** — pi-tui renders them under the input row, inside its borders, which
 * is pi's behaviour. An overlay would float over the transcript instead and
 * detach the list from the text being typed.
 *
 * @param sources - live data for the commands that complete arguments.
 * @returns the command table.
 */
export function buildCommands(sources: CommandSources): readonly TuiCommand[] {
  const hostCommands: TuiCommand[] = (sources.listHostCommands?.() ?? [])
    // A host command must not shadow a built-in: the built-in has local
    // behaviour (kept in this module) that the host cannot reproduce.
    .filter((command) => !TUI_COMMANDS.some((builtin) => builtin.name === command.name))
    .map((command) => ({
      name: command.name,
      description: command.description,
      ...(command.inputHint === undefined ? {} : { argumentHint: command.inputHint }),
    }))

  // Skills are surfaced as `/skill:<name>` so they read as a distinct family
  // and never collide with a plain command name.
  const skillCommands: TuiCommand[] = (sources.listSkills?.() ?? []).map((skill) => ({
    name: `skill:${skill.name}`,
    description: skill.description,
  }))

  return [...TUI_COMMANDS, ...hostCommands, ...skillCommands].map((command) => {
    if (command.name === 'model') {
      return {
        ...command,
        getArgumentCompletions: (prefix: string) => {
          const all = sources.listModels()
          if (all.length === 0) return null
          const normalised = prefix.trim().toLowerCase()
          if (normalised === '') return all
          const matches = all.filter((item) =>
            `${item.value} ${item.label} ${item.description ?? ''}`.toLowerCase().includes(normalised))
          return matches.length === 0 ? null : matches
        },
      }
    }
    if (command.name === 'theme') {
      return {
        ...command,
        getArgumentCompletions: (prefix: string) => {
          const names = sources.listThemes()
          if (names.length === 0) return null
          const normalised = prefix.trim().toLowerCase()
          const matches = normalised === ''
            ? names
            : names.filter((name) => name.toLowerCase().includes(normalised))
          return matches.length === 0
            ? null
            : matches.map((name) => ({ value: name, label: name }))
        },
      }
    }
    return command
  })
}
