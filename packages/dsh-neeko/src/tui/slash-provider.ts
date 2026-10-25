/**
 * The editor's autocomplete provider, with a **live slash-command catalogue**.
 *
 * ## Why a wrapper instead of passing `CombinedAutocompleteProvider` directly
 *
 * pi-tui's `CombinedAutocompleteProvider` snapshots the command array handed to
 * its constructor. That is wrong for this menu: host commands are registered by
 * DSH plugins while the TUI is already running, so a construction-time array
 * silently freezes the catalogue — the API looked live (`listHostCommands: () => …`)
 * but wasn't.
 *
 * Rebuilding the inner provider per request is the cheap correct fix:
 * - the constructor only stores three fields (all the work is in `getSuggestions`);
 * - `applyCompletion` / `shouldTriggerFileCompletion` read nothing from `commands`,
 *   so there is no state that must survive across keystrokes.
 *
 * This module owns both that decision **and** the `TuiCommand → SlashCommand`
 * shape adaptation, so `commands.ts` stays a pure, pi-tui-free table builder and
 * `TuiApp` only says *where* the catalogue comes from.
 *
 * @module dsh-neeko/tui/slash-provider
 */

import { CombinedAutocompleteProvider } from '@earendil-works/pi-tui'
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
  SlashCommand,
} from '@earendil-works/pi-tui'
import type { TuiCommand } from './commands.ts'

/**
 * Adapt this package's command table to pi-tui's `SlashCommand` shape.
 *
 * The only real difference is array mutability: pi types `getArgumentCompletions`
 * as `AutocompleteItem[] | null`, ours returns `readonly ArgumentItem[] | null`,
 * so the rows are copied into a fresh array at call time.
 *
 * @param commands - the pure command table (from `buildCommands`).
 * @returns pi-tui-ready commands.
 */
export function toSlashCommands(commands: readonly TuiCommand[]): SlashCommand[] {
  return commands.map((command) => ({
    name: command.name,
    description: command.description,
    ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
    ...(command.getArgumentCompletions === undefined
      ? {}
      : {
          getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
            const items = command.getArgumentCompletions?.(prefix)
            return items === undefined || items === null ? null : [...items]
          },
        }),
  }))
}

/**
 * A `CombinedAutocompleteProvider` rebuilt from the live catalogue per request.
 *
 * @param basePath - directory file/path completions resolve against.
 * @param commands - produces the current command table; called on every
 *   suggestion/apply request, so host-registered commands appear as soon as
 *   they exist.
 */
export class LiveSlashProvider implements AutocompleteProvider {
  constructor(
    private readonly basePath: string,
    private readonly commands: () => readonly TuiCommand[],
  ) {}

  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    return this.provider().getSuggestions(lines, cursorLine, cursorCol, options)
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    // Stateless with respect to `commands`, so a fresh inner provider is fine.
    return this.provider().applyCompletion(lines, cursorLine, cursorCol, item, prefix)
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.provider().shouldTriggerFileCompletion(lines, cursorLine, cursorCol)
  }

  private provider(): CombinedAutocompleteProvider {
    return new CombinedAutocompleteProvider(toSlashCommands(this.commands()), this.basePath)
  }
}
