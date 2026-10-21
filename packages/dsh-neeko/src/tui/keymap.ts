/**
 * The key layer: named actions, a priority stack, and nothing else.
 *
 * ## Why this module exists
 *
 * `TuiApp.handleInput` used to be a cascade of `matchesKey(data, 'ctrl+x')`
 * calls with an early `return` per modal surface. That shape cost three things,
 * all of them real:
 *
 * 1. **Not rebindable.** pi-tui ships `KeybindingsManager` and 47 `tui.*`
 *    actions; this app used zero of them, so a user's `keybindings.json` was
 *    silently ignored — the file loaded, the keys did nothing.
 * 2. **Not discoverable.** There was nowhere to ask "what is bound right now",
 *    so `/hotkeys` could not exist and the README table drifted from the code.
 * 3. **Not composable.** "The panel must see keys first" was encoded as *call
 *    order inside one function*, which means adding a surface meant editing the
 *    cascade — the same "closed set" problem the entry types had.
 *
 * The replacement is two lists and one loop: an action table (what exists) and a
 * {@linkcode KeyScope} stack (who sees it first). That is the whole mechanism.
 *
 * ## Why the key ids are pi's
 *
 * `app.clear`, `app.exit` and `app.tools.expand` are spelled exactly as in pi's
 * `docs/keybindings.md`. The id is the stable contract a user writes in
 * `keybindings.json`, so a file written for pi keeps working here. The
 * corollary, enforced by a test: **only actions this app routes are declared.**
 * Advertising `app.model.select` without a handler would make `/hotkeys` lie.
 *
 * @module dsh-neeko/tui/keymap
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  Key,
  KeybindingsManager,
  TUI_KEYBINDINGS,
  getKeybindings,
  setKeybindings,
} from '@earendil-works/pi-tui'
import type { KeyId, KeybindingDefinition, Keybindings, KeybindingsConfig } from '@earendil-works/pi-tui'

/**
 * The actions this build routes.
 *
 * A closed union on purpose: `actionScope` takes a partial record of it, so a
 * typo in an action name is a compile error rather than a silently dead key.
 *
 * Absent on purpose (pi has them, this build does not route them yet):
 * `app.model.select`, `app.model.cycleForward`, `app.model.cycleBackward`,
 * `app.thinking.cycle`, `app.thinking.toggle`, `app.interrupt`, `app.suspend`,
 * `app.editor.external`, `app.message.followUp`, `app.message.dequeue`,
 * `app.clipboard.pasteImage`. They arrive with the surfaces that consume them,
 * so `/hotkeys` never lists a key that does nothing.
 */
export type Action =
  | 'app.clear'
  | 'app.exit'
  | 'app.tools.expand'

/**
 * Teach pi-tui's registry about this app's action ids.
 *
 * `Keybindings` is the key set pi-tui type-checks against, and its own docs say
 * downstream packages extend it exactly this way ("Downstream packages can add
 * keybindings via declaration merging"). Without this, every `matches('app.clear')`
 * needs a cast — and a cast is what lets a typo through.
 */
declare module '@earendil-works/pi-tui' {
  interface Keybindings {
    'app.clear': true
    'app.exit': true
    'app.tools.expand': true
  }
}

/**
 * App-level bindings, on top of pi-tui's own `tui.*` set.
 *
 * The values are `KeyId`s — a literal union — so a typo such as `'ctrl+O'` is a
 * type error instead of a key that never fires.
 */
export const APP_KEYBINDINGS: Readonly<
  Record<Action, { readonly defaultKeys: KeyId | readonly KeyId[]; readonly description: string }>
> = {
  'app.clear': {
    defaultKeys: 'ctrl+c',
    description: 'Quit the terminal UI',
  },
  'app.exit': {
    defaultKeys: 'ctrl+d',
    description: 'Quit the terminal UI (same as ctrl+c)',
  },
  'app.tools.expand': {
    defaultKeys: 'ctrl+o',
    description: 'Collapse or expand tool output and thinking',
  },
}

/**
 * Install the merged key set, replacing pi-tui's global registry.
 *
 * The registry is **shared**, not app-private: `Editor` looks up `tui.editor.*`
 * in the same manager the app looks up `app.*` in (both call `getKeybindings()`
 * on every keystroke, not once at construction). So the merged definition map
 * must contain pi's actions too — installing only the app's would silently break
 * every editor key.
 *
 * Must run before any component reads the registry. `Editor` and `TuiAltScreen`
 * both consult it per keystroke, so a late install would leave them on defaults
 * while the app thought it was configured.
 *
 * **This is where an override becomes a binding, so it is also where overrides
 * are validated** (see {@linkcode normaliseKeyId}). An override *replaces* the
 * default rather than adding to it, so one typo (`'ctr+q'`) would otherwise leave
 * the action with no working key at all: the default is gone and the typo can
 * never match. Measured on this build — `app.clear` bound to `'ctr+q'` made both
 * `ctrl+c` and `ctrl+q` dead, i.e. the exit key silently disappeared.
 *
 * @param overrides - per-action key overrides (a parsed `keybindings.json`).
 *   An empty array disables the action, which is pi's own convention.
 * @returns the manager now installed globally.
 */
export function installKeymap(overrides: KeybindingsConfig = {}): KeybindingsManager {
  // `KeybindingDefinitions` is `Record<string, KeybindingDefinition>`, so the
  // merge is a plain spread: pi's 47 actions plus the app's own. `APP_KEYBINDINGS`
  // declares `defaultKeys` as `readonly KeyId[]` in places, which the definition
  // type accepts.
  const definitions: Record<string, KeybindingDefinition> = {
    ...TUI_KEYBINDINGS,
    ...(APP_KEYBINDINGS as unknown as Record<string, KeybindingDefinition>),
  }
  // Overrides go in through the manager rather than by mutating the definitions:
  // `[]` has to keep meaning "disabled", and that is the manager's job.
  const manager = new KeybindingsManager(definitions, sanitiseOverrides(overrides))
  setKeybindings(manager)
  return manager
}

/** The modifier names `matchesKey` parses, longest-first is irrelevant (no prefix). */
const MODIFIER_NAMES: readonly string[] = ['ctrl', 'shift', 'alt', 'super']

/**
 * Every base key `matchesKey` can match, lower-cased.
 *
 * Taken from pi-tui's own `Key` table rather than re-listed: a hand-written copy
 * would fall behind when pi adds a key, and the failure mode is exactly the one
 * this module prevents (a valid key rejected as if it were a typo).
 */
const BASE_KEYS: ReadonlySet<string> = new Set(
  // `Key` also carries helpers (`Key.ctrl('c')`), so only its string members are
  // key names; the table is `as const`, hence the cast rather than a predicate.
  (Object.values(Key) as readonly unknown[])
    .filter((key): key is string => typeof key === 'string')
    .map((key) => key.toLowerCase()),
)

/**
 * Narrow one configured key id to something the matcher can actually fire on.
 *
 * Mirrors `matchesKey`'s own grammar (`parseKeyId` plus its `switch`): optional
 * modifiers in any order, each at most once, then one base key. Case is folded
 * because `matchesKey` lower-cases before comparing — `Ctrl+O` is a working
 * binding and must not be dropped as a typo.
 *
 * Rejecting these is the point: `matchesKey` answers `false` for an id it cannot
 * parse, and a binding that can never match is worse than no binding at all.
 *
 * @param value - one key id from a user's file, or from `TuiAppOptions`.
 * @returns the lower-cased id, or `undefined` when it can never match.
 */
export function normaliseKeyId(value: string): KeyId | undefined {
  const key = value.trim().toLowerCase()
  let rest = key
  const seen = new Set<string>()
  for (;;) {
    const modifier = MODIFIER_NAMES.find((name) => rest.startsWith(`${name}+`))
    if (modifier === undefined) break
    // `ctrl+ctrl+q` parses to `null` in `parseKeyId`, so it matches nothing.
    if (seen.has(modifier)) return undefined
    seen.add(modifier)
    rest = rest.slice(modifier.length + 1)
  }
  if (rest === '') return undefined
  // The bare `+` key: pi's schema allows it and `parseKeyId` special-cases it.
  if (rest === '+') return key as KeyId
  if (rest.includes('+')) return undefined
  // Letters and digits are the only single characters a bare `case` accepts;
  // every other single character is a symbol key from `Key`. The id is returned
  // whole (modifiers included) — only its *validity* was just established.
  const single = rest.length === 1
  if (single) return /[a-z0-9]/u.test(rest) || BASE_KEYS.has(rest) ? (key as KeyId) : undefined
  return BASE_KEYS.has(rest) ? (key as KeyId) : undefined
}

/**
 * Drop keys that can never fire, and whole actions left with none.
 *
 * A whole-action fallback ("bind nothing" → the default survives) keeps the user
 * out of a trap: someone who typo'd their rebind still has a working exit key.
 * An **empty** array is preserved untouched — that is pi's spelling for "disable
 * this action", a deliberate statement rather than a mistake, and the one case
 * where having no key is the intent.
 *
 * @param overrides - overrides from any source (the file, or app options).
 * @returns the overrides the manager can honour.
 */
function sanitiseOverrides(overrides: KeybindingsConfig): KeybindingsConfig {
  const accepted: KeybindingsConfig = {}
  for (const [action, value] of Object.entries(overrides)) {
    if (value === undefined) continue
    const keys = typeof value === 'string' ? [value] : value
    if (keys.length === 0) {
      accepted[action] = []
      continue
    }
    const valid = keys
      .map((key) => normaliseKeyId(key))
      .filter((key): key is KeyId => key !== undefined)
    if (valid.length === 0) continue
    accepted[action] = valid
  }
  return accepted
}

/** One surface's claim on the keyboard, in priority order. */
export interface KeyScope {
  /** Short name for debugging and for `/hotkeys` when a scope is inspected. */
  readonly name: string
  /**
   * Handle one input chunk.
   *
   * @returns `true` when this scope consumed it; the walk stops.
   */
  handle(data: string): boolean
}

/**
 * Route input through the scope stack, first consumer wins.
 *
 * Stopping at the first `true` is what makes priority explicit and testable: a
 * modal panel is simply the top of the stack, so "must see keys first" is a
 * property of list order instead of an `if` at the top of a cascade.
 *
 * @param scopes - highest priority first.
 * @param data - the raw input chunk from the terminal.
 * @returns whether anything consumed it. `false` means "let the focused
 *   component have it", which is how the editor receives typing.
 */
export function routeKey(scopes: readonly KeyScope[], data: string): boolean {
  for (const scope of scopes) {
    if (scope.handle(data)) return true
  }
  return false
}

/**
 * Build a scope from an action table.
 *
 * The common case by far: a caller supplies `action → handler` and gets a scope
 * that matches through the **installed** manager. Matching through the manager
 * rather than comparing literals is what makes a rebind reach the scope — a
 * literal comparison would pass a naive test and still ignore
 * `keybindings.json`.
 *
 * An action with no handler declines instead of consuming: an unhandled action
 * must stay available to whoever does handle it.
 *
 * @param name - scope name, for debugging.
 * @param handlers - partial action table.
 * @param keybindings - the manager to match against; defaults to the global one.
 * @returns a scope that consumes only the actions it has handlers for.
 */
export function actionScope(
  name: string,
  handlers: Partial<Readonly<Record<Action, () => void>>>,
  keybindings: KeybindingsManager = getKeybindings(),
): KeyScope {
  return {
    name,
    handle(data: string): boolean {
      for (const [action, handler] of Object.entries(handlers)) {
        if (handler === undefined) continue
        if (!keybindings.matches(data, action as keyof Keybindings)) continue
        handler()
        return true
      }
      return false
    },
  }
}

/**
 * How pi renders one key id for display.
 *
 * pi's `formatKeyText`: capitalise the first letter of **every** part (`Ctrl+Shift+P`,
 * `Option+Enter`), join alternatives with `/`, and say `option` instead of `alt` on
 * macOS (that is what the key is labelled on an Apple keyboard). Mirrored rather
 * than reinvented, so a key reads the same here as in pi's own `/hotkeys` table —
 * verified against pi's `formatKeyText`/`formatKeyPart` pair, which upper-cases
 * every part, not just the first.
 *
 * @param keys - one key id, or several alternatives.
 * @param options - `capitalize` renders `Ctrl+O` instead of `ctrl+o`.
 * @returns the display form.
 */
export function formatKeyText(
  keys: KeyId | readonly KeyId[],
  options: { readonly capitalize?: boolean } = {},
): string {
  const list = typeof keys === 'string' ? [keys] : keys
  return list.map((key) => formatOneKey(key, options)).join('/')
}

/**
 * Format one key id.
 *
 * @param key - the key id, e.g. `alt+enter`.
 * @param options - capitalisation.
 * @returns the display form.
 */
function formatOneKey(key: KeyId, options: { readonly capitalize?: boolean }): string {
  return key
    .split('+')
    // pi's `formatKeyPart`, applied per part exactly as pi does: first character
    // upper-cased, the rest untouched (`Ctrl+Shift+P`, `Option+Enter`).
    // Capitalising only the leading part produced `Ctrl+Shift+p` — the same key
    // spelled two ways in two tables.
    .map((part) => {
      const normalised = process.platform === 'darwin' && part.toLowerCase() === 'alt' ? 'option' : part
      if (options.capitalize !== true) return normalised
      return `${normalised.charAt(0).toUpperCase()}${normalised.slice(1)}`
    })
    .join('+')
}

/** One row of the binding table: keys on the left, what they do on the right. */
export interface HotkeyEntry {
  /** Action ids resolved live, so the row survives a rebind. */
  readonly actions: readonly string[]
  readonly description: string
}

/** One titled block of {@linkcode HotkeyEntry} rows. */
export interface HotkeyGroup {
  readonly title: string
  readonly entries: readonly HotkeyEntry[]
}

/**
 * The binding table `/hotkeys` prints.
 *
 * pi's shape, not an action dump: three hand-grouped blocks whose rows name action
 * ids that are resolved against the **live** registry. Two reasons for the hand
 * grouping — 47 `tui.*` actions are mostly muscle memory and would scroll the
 * conversation away; and a dump cannot say "ctrl+o expands tool output", only
 * "app.tools.expand: ctrl+o".
 *
 * Exit keys come first: a user reaching for this list is usually trying to leave.
 */
export const HOTKEY_GROUPS: readonly HotkeyGroup[] = [
  {
    title: 'Other',
    entries: [
      { actions: ['app.clear'], description: 'Quit the terminal UI' },
      // Not pi's wording: pi's `app.exit` fires only on an empty editor, while
      // this app exits unconditionally. A `/hotkeys` table must describe this
      // build, so pi's "(when editor empty)" parenthetical is deliberately absent.
      { actions: ['app.exit'], description: 'Quit the terminal UI (same as ctrl+c)' },
      { actions: ['app.tools.expand'], description: 'Collapse or expand tool output' },
      { actions: ['tui.input.submit'], description: 'Send the message' },
      { actions: ['tui.input.newLine'], description: 'Insert a new line' },
      { actions: ['tui.input.tab'], description: 'Path completion / accept autocomplete' },
      // A literal, not an action: `/` is a prefix the editor watches for, with no
      // binding to resolve. It must be the only entry here — listing an empty
      // string alongside it joined into `//`.
      { actions: ['/'], description: 'Slash commands' },
    ],
  },
  {
    title: 'Navigation',
    entries: [
      { actions: ['tui.editor.cursorUp', 'tui.editor.cursorDown'], description: 'Move cursor / browse history' },
      { actions: ['tui.editor.cursorLeft', 'tui.editor.cursorRight'], description: 'Move cursor by character' },
      { actions: ['tui.editor.cursorWordLeft', 'tui.editor.cursorWordRight'], description: 'Move by word' },
      { actions: ['tui.editor.cursorLineStart'], description: 'Start of line' },
      { actions: ['tui.editor.cursorLineEnd'], description: 'End of line' },
      { actions: ['tui.altScreen.pageUp', 'tui.altScreen.pageDown'], description: 'Scroll the transcript by page' },
    ],
  },
  {
    title: 'Editing',
    entries: [
      { actions: ['tui.editor.deleteCharBackward'], description: 'Delete character backwards' },
      { actions: ['tui.editor.deleteWordBackward'], description: 'Delete word backwards' },
      { actions: ['tui.editor.deleteToLineStart'], description: 'Delete to start of line' },
      { actions: ['tui.editor.deleteToLineEnd'], description: 'Delete to end of line' },
      { actions: ['tui.editor.yank'], description: 'Paste the most recently deleted text' },
      { actions: ['tui.editor.undo'], description: 'Undo' },
    ],
  },
]

/**
 * Render the binding table as text rows, for `/hotkeys`.
 *
 * Every key is resolved through the live manager, so an override shows as it is
 * and a disabled action drops out. An entry whose keys are *all* disabled is
 * omitted rather than printed with an empty key column, which reads as a broken
 * table.
 *
 * @param keybindings - the manager to read; defaults to the global one.
 * @returns lines ready to join; the caller decides where to write them.
 */
export function formatHotkeys(keybindings: KeybindingsManager = getKeybindings()): string[] {
  const lines: string[] = []
  for (const group of HOTKEY_GROUPS) {
    const rows: string[] = []
    for (const entry of group.entries) {
      // A literal key (`/`) is printed as-is; an action id is resolved live.
      const keys: string[] = []
      for (const action of entry.actions) {
        if (!action.includes('.')) keys.push(action)
        else keys.push(...keybindings.getKeys(action as keyof Keybindings))
      }
      if (keys.length === 0) continue
      rows.push(`  ${formatKeyText(keys as KeyId[], { capitalize: true }).padEnd(20)} ${entry.description}`)
    }
    // A group whose every row was disabled is dropped, header included.
    if (rows.length === 0) continue
    lines.push(group.title)
    lines.push(...rows)
  }
  return lines
}

/**
 * Read a user's key overrides from `keybindings.json`.
 *
 * pi's own file: `<agent-dir>/keybindings.json`, where the agent dir is
 * `$PI_AGENT_DIR` or `~/.pi/agent`. Sharing the file (rather than inventing a
 * dsh-specific one) is the point: a user who already rebound `app.tools.expand`
 * for pi gets that binding here on first run.
 *
 * Fails open to `{}` — a malformed or unreadable file must not stop the TUI from
 * starting, because the worst case of ignoring it is "the default keys", while
 * the worst case of throwing is "the app will not launch".
 *
 * Only string values and arrays of strings are accepted: a number or an object
 * in the file is a mistake, and dropping that one entry is better than dropping
 * the whole file. Whether a *key id* can actually fire is decided once, at the
 * install boundary ({@linkcode installKeymap}), so every source of overrides —
 * this file, or a caller's options — goes through the same validity rule.
 *
 * A UTF-8 BOM is stripped first. `JSON.parse` rejects it, so without this a file
 * saved by a Windows editor is ignored **in full** — silently, and next to a
 * theme loader that has stripped it all along.
 *
 * @param path - the file to read; defaults to pi's location.
 * @returns the overrides, or `{}` when there is nothing usable.
 */
export function loadKeybindingOverrides(path: string = defaultKeybindingsPath()): KeybindingsConfig {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    // Absent is the common case: most users never write this file.
    return {}
  }
  let parsed: unknown
  try {
    // Same rule as the theme loader's `stripBom`: one package, one answer to
    // "is a BOM part of the document".
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}

  const overrides: KeybindingsConfig = {}
  for (const [action, value] of Object.entries(parsed as Record<string, unknown>)) {
    // `$schema` and comments-as-keys are not bindings.
    if (action.startsWith('$')) continue
    if (typeof value === 'string') {
      overrides[action] = value as KeyId
      continue
    }
    if (Array.isArray(value)) {
      // An empty array is meaningful — it disables the action (pi's convention),
      // so it must survive this filter.
      const keys = value.filter((entry): entry is string => typeof entry === 'string')
      if (keys.length === value.length) overrides[action] = keys as KeyId[]
    }
  }
  return overrides
}

/**
 * Where pi keeps `keybindings.json`.
 *
 * Same resolution as {@linkcode loadKeybindingOverrides}'s default and as the
 * theme loader's `piThemesDir`: one agent directory, shared by both.
 *
 * @param env - environment to read.
 * @returns the absolute path.
 */
export function defaultKeybindingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env['PI_AGENT_DIR']?.trim()
  if (agentDir !== undefined && agentDir !== '') return join(agentDir, 'keybindings.json')
  return join(homedir(), '.pi', 'agent', 'keybindings.json')
}
