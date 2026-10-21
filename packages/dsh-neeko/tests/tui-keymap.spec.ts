import { afterEach, describe, expect, it, vi } from 'vitest'
import { KeybindingsManager, TUI_KEYBINDINGS, getKeybindings, setKeybindings } from '@earendil-works/pi-tui'
import type { KeybindingsConfig } from '@earendil-works/pi-tui'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  APP_KEYBINDINGS,
  HOTKEY_GROUPS,
  actionScope,
  formatHotkeys,
  formatKeyText,
  defaultKeybindingsPath,
  installKeymap,
  loadKeybindingOverrides,
  normaliseKeyId,
  routeKey,
} from '../src/tui/keymap.ts'
import type { KeyScope } from '../src/tui/keymap.ts'
import { TuiApp } from '../src/tui/app.ts'
import { FakeTerminal } from './support/fake-terminal.ts'
import { stripAnsi } from './support/ansi.ts'

/**
 * The key layer: named actions, a priority stack, and one binding table.
 *
 * ## The defect this replaces
 *
 * `TuiApp.handleInput` was a cascade of `matchesKey(data, 'ctrl+x')` calls with an
 * early `return` per modal surface. Three consequences, all real:
 *
 * 1. **Not rebindable.** pi-tui ships `KeybindingsManager` and 47 `tui.*`
 *    actions; this app used zero of them, so a user's `keybindings.json` was
 *    silently ignored — the file loaded, the keys did nothing.
 * 2. **Not discoverable.** There was nowhere to ask "what is bound right now",
 *    so `/hotkeys` could not exist and the README table drifted from the code.
 * 3. **Not composable.** "The panel must see keys first" was encoded as *call
 *    order inside one function*, so adding a surface meant editing the cascade —
 *    the same closed-set problem the transcript entry types had.
 *
 * ## Why the key ids are pi's
 *
 * `app.clear`, `app.exit` and `app.tools.expand` are spelled exactly as in pi's
 * `docs/keybindings.md`. The id is the stable contract a user writes in
 * `keybindings.json`, so a file written for pi keeps working here. The corollary,
 * enforced below: **only actions this build routes are declared.** Advertising
 * `app.model.select` without a handler makes `/hotkeys` lie.
 */

/** Every test installs its own manager, so global state never leaks between them. */
function manager(overrides: Parameters<typeof installKeymap>[0] = {}): KeybindingsManager {
  return installKeymap(overrides)
}

afterEach(() => {
  // Restore pi-tui's own registry: `Editor` and the alt screen resolve bindings
  // through the global, so a later file must not inherit this file's overrides.
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS))
})

describe('APP_KEYBINDINGS — the actions this build routes', () => {
  it('uses pi\'s key ids verbatim', () => {
    // The value is a `KeyId` (a literal union), so a typo like `'ctrl+O'` is a
    // type error rather than a key that never fires.
    expect(APP_KEYBINDINGS['app.clear'].defaultKeys).toEqual('ctrl+c')
    expect(APP_KEYBINDINGS['app.exit'].defaultKeys).toEqual('ctrl+d')
    expect(APP_KEYBINDINGS['app.tools.expand'].defaultKeys).toEqual('ctrl+o')
  })

  it('declares no action without a handler', () => {
    // `app.model.select` (ctrl+l), `app.thinking.cycle` (shift+tab) and the rest
    // arrive with the surfaces that consume them. Listing a key that does nothing
    // is worse than not listing it.
    expect(Object.keys(APP_KEYBINDINGS).sort()).toEqual([
      'app.clear',
      'app.exit',
      'app.tools.expand',
    ])
  })

  it('gives every action a description, because /hotkeys prints it', () => {
    for (const [action, definition] of Object.entries(APP_KEYBINDINGS)) {
      expect(definition.description, action).not.toBe('')
    }
  })
})

describe('installKeymap', () => {
  it('installs a manager that also answers pi-tui\'s own actions', () => {
    // The registry is shared: `Editor` looks up `tui.editor.*` in the same manager
    // the app looks up `app.*` in. Installing only the app's set would silently
    // break every editor key.
    const kb = manager()
    expect(getKeybindings()).toBe(kb)
    expect(kb.matches('\x1b[A', 'tui.editor.cursorUp')).toBe(true)
    expect(kb.matches('\x03', 'app.clear')).toBe(true)
  })

  it('applies a user override to an app action', () => {
    const kb = manager({ 'app.tools.expand': 'ctrl+e' })
    expect(kb.getKeys('app.tools.expand')).toEqual(['ctrl+e'])
    expect(kb.matches('\x05', 'app.tools.expand')).toBe(true)
    expect(kb.matches('\x0f', 'app.tools.expand')).toBe(false)
  })

  it('applies a user override to a pi-tui action too', () => {
    // A `keybindings.json` written for pi binds `tui.*` ids; those must reach the
    // editor through the same manager.
    const kb = manager({ 'tui.editor.cursorUp': 'ctrl+p' })
    expect(kb.getKeys('tui.editor.cursorUp')).toEqual(['ctrl+p'])
    expect(kb.matches('\x10', 'tui.editor.cursorUp')).toBe(true)
    expect(kb.matches('\x1b[A', 'tui.editor.cursorUp')).toBe(false)
  })

  it('treats an empty list as "disabled", which is pi\'s convention', () => {
    const kb = manager({ 'app.clear': [] })
    expect(kb.getKeys('app.clear')).toEqual([])
    expect(kb.matches('\x03', 'app.clear')).toBe(false)
  })

  it('ignores an override naming an action nobody declared', () => {
    // A stale `keybindings.json` must not throw on startup: a user who upgraded
    // past a renamed action should keep their other bindings, not get a crash.
    const kb = manager({ 'app.renamed.lastYear': 'ctrl+y' } as KeybindingsConfig)
    expect(kb.matches('\x03', 'app.clear')).toBe(true)
  })

  it('rejects a key id that can never match, keeping the default', () => {
    // An override *replaces* the default, so a typo used to leave the action with
    // no working key at all — measured: `app.clear: 'ctr+q'` made both ctrl+c and
    // ctrl+q dead, i.e. the exit key silently disappeared.
    //
    // Parsed from JSON on purpose: `keybindings.json` is untyped, so the literal
    // union that protects code does not protect a user's file. This is the real
    // entry shape, not a cast standing in for one.
    const kb = manager(JSON.parse('{"app.clear":"ctr+q"}') as KeybindingsConfig)
    expect(kb.getKeys('app.clear')).toEqual(['ctrl+c'])
    expect(kb.matches('\x03', 'app.clear')).toBe(true)
  })

  it('drops only the unusable key from a mixed list', () => {
    const kb = manager(JSON.parse('{"app.tools.expand":["ctrl+e","nonsense","ctrl+ctrl+t"]}') as KeybindingsConfig)
    expect(kb.getKeys('app.tools.expand')).toEqual(['ctrl+e'])
  })

  it('accepts an upper-case key id, which matchesKey folds anyway', () => {
    // `Ctrl+O` is a working binding; rejecting it as a typo would be a bug.
    const kb = manager(JSON.parse('{"app.tools.expand":"Ctrl+O"}') as KeybindingsConfig)
    expect(kb.getKeys('app.tools.expand')).toEqual(['ctrl+o'])
    expect(kb.matches('\x0f', 'app.tools.expand')).toBe(true)
  })

  it('still lets an empty list disable an action', () => {
    // The one case where "no key" is the intent, and it must survive validation.
    const kb = manager({ 'app.tools.expand': [] })
    expect(kb.getKeys('app.tools.expand')).toEqual([])
    expect(kb.matches('\x0f', 'app.tools.expand')).toBe(false)
  })
})

describe('normaliseKeyId — matchesKey\'s grammar', () => {
  it('accepts every shape the matcher understands', () => {
    for (const key of ['ctrl+c', 'ctrl+shift+p', 'shift+ctrl+p', 'alt+enter', 'super+k', 'escape', 'f12', 'pageUp', '/', '+', 'a', '7']) {
      expect(normaliseKeyId(key), key).toBe(key.toLowerCase())
    }
  })

  it('rejects what the matcher would silently never fire on', () => {
    for (const key of ['', ' ', 'ctr+q', 'ctrl+', 'nonsense', 'ctrl+ctrl+q', 'ctrl+ab']) {
      expect(normaliseKeyId(key), key).toBeUndefined()
    }
  })

  it('folds case, because matchesKey does', () => {
    expect(normaliseKeyId('Ctrl+Shift+P')).toBe('ctrl+shift+p')
  })
})

describe('routeKey — first consumer wins', () => {
  /** A scope that records being consulted and consumes one fixed key. */
  function scope(name: string, key: string, calls: string[]): KeyScope {
    return {
      name,
      handle(data: string): boolean {
        calls.push(name)
        return data === key
      },
    }
  }

  it('stops at the first scope that consumes', () => {
    const calls: string[] = []
    expect(routeKey([scope('a', 'x', calls), scope('b', 'x', calls)], 'x')).toBe(true)
    // `b` is never consulted: priority is list order, and the walk stops.
    expect(calls).toEqual(['a'])
  })

  it('walks past a scope that declines', () => {
    const calls: string[] = []
    expect(routeKey([scope('a', 'x', calls), scope('b', 'y', calls)], 'y')).toBe(true)
    expect(calls).toEqual(['a', 'b'])
  })

  it('reports nothing consumed when every scope declines', () => {
    // This is what lets the key reach the focused component (the editor).
    expect(routeKey([scope('a', 'x', [])], 'q')).toBe(false)
  })

  it('handles an empty stack', () => {
    expect(routeKey([], 'q')).toBe(false)
  })
})

describe('actionScope', () => {
  it('consumes only the actions it has handlers for', () => {
    const expand = vi.fn()
    const scope = actionScope('app', { 'app.tools.expand': expand }, manager())

    expect(scope.handle('\x0f')).toBe(true) // ctrl+o
    expect(expand).toHaveBeenCalledTimes(1)

    // `app.clear` has no handler here, so the key falls through rather than being
    // swallowed: an unhandled action must stay available to whoever handles it.
    expect(scope.handle('\x03')).toBe(false)
  })

  it('matches through the manager, not a hard-coded key', () => {
    // The rebind has to reach the scope. A scope comparing literals would pass
    // the test above and still ignore `keybindings.json`.
    const kb = manager({ 'app.tools.expand': 'ctrl+e' })
    const expand = vi.fn()
    const scope = actionScope('app', { 'app.tools.expand': expand }, kb)

    expect(scope.handle('\x05')).toBe(true) // ctrl+e, the override
    expect(scope.handle('\x0f')).toBe(false) // ctrl+o is no longer bound
  })

  it('declines a disabled action instead of hanging on to the key', () => {
    const kb = manager({ 'app.tools.expand': [] })
    const expand = vi.fn()
    const scope = actionScope('app', { 'app.tools.expand': expand }, kb)
    expect(scope.handle('\x0f')).toBe(false)
    expect(expand).not.toHaveBeenCalled()
  })
})

describe('formatKeyText — pi\'s spelling', () => {
  // pi's `formatKeyPart` upper-cases the first character of **every** part and
  // leaves the rest alone, so `ctrl+shift+p` renders `Ctrl+Shift+P`. Verified
  // against pi's own implementation rather than assumed: capitalising only the
  // leading part (`Ctrl+Shift+p`) is a second spelling of the same key, and this
  // table is meant to read like pi's.
  it('capitalises every part, as pi renders it', () => {
    expect(formatKeyText('ctrl+o', { capitalize: true })).toBe('Ctrl+O')
    expect(formatKeyText('ctrl+shift+p', { capitalize: true })).toBe('Ctrl+Shift+P')
  })

  it('renders alternatives with a slash', () => {
    // pi joins a multi-binding action with `/`; a comma would read as a sequence.
    expect(formatKeyText(['escape', 'ctrl+c'], { capitalize: true })).toBe('Escape/Ctrl+C')
  })

  it('says "option" for alt on macOS, which is what the key is called there', () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      expect(formatKeyText('alt+enter', { capitalize: true })).toBe('Option+Enter')
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  })

  it('leaves the key id alone without capitalize', () => {
    // The plain form is what `rawKeyHint` uses; upper-casing there would make a
    // hint look like a different key from the one in this table.
    expect(formatKeyText('ctrl+o')).toBe('ctrl+o')
  })
})

describe('HOTKEY_GROUPS — pi\'s presentation, not an action dump', () => {
  /**
   * pi's `/hotkeys` is a **hand-grouped table** (Navigation / Editing / Other),
   * each row naming an action id that is resolved live. It is deliberately not a
   * dump of all 47 `tui.*` actions: most are muscle memory, and printing them
   * scrolls the conversation away for no information gain.
   *
   * The same shape here, with the groups this build actually has.
   */
  it('names only actions that exist', () => {
    for (const group of HOTKEY_GROUPS) {
      for (const entry of group.entries) {
        for (const action of entry.actions) {
          // A dotted id must resolve; anything else is a literal key (`/`) and is
          // printed verbatim.
          if (!action.includes('.')) continue
          expect(
            Object.hasOwn(APP_KEYBINDINGS, action) || Object.hasOwn(TUI_KEYBINDINGS, action),
            `${group.title}: ${action}`,
          ).toBe(true)
        }
      }
    }
  })

  it('covers every app action, so nothing is silently undiscoverable', () => {
    const listed = new Set(HOTKEY_GROUPS.flatMap((group) => group.entries.flatMap((entry) => entry.actions)))
    for (const action of Object.keys(APP_KEYBINDINGS)) {
      expect(listed, action).toContain(action)
    }
  })

  it('puts the exit keys in the first group, where a stuck user looks', () => {
    expect(HOTKEY_GROUPS[0]?.entries.some((entry) => entry.actions.includes('app.clear'))).toBe(true)
  })
})

describe('formatHotkeys', () => {
  it('resolves each row through the live registry', () => {
    const text = formatHotkeys(manager()).join('\n')
    expect(text).toContain('Ctrl+O')
    expect(text).toContain('Collapse or expand tool output')
    // Exit keys resolve too — they are actions, not literals.
    expect(text).toContain('Ctrl+C')
  })

  it('reflects an override, so /hotkeys cannot advertise a dead key', () => {
    const text = formatHotkeys(manager({ 'app.tools.expand': 'ctrl+e' })).join('\n')
    expect(text).toContain('Ctrl+E')
    expect(text).not.toContain('Ctrl+O')
  })

  it('drops a row whose bindings were all disabled', () => {
    // Rather than printing an empty key column, which reads as a broken table.
    const text = formatHotkeys(manager({ 'app.tools.expand': [] })).join('\n')
    expect(text).not.toContain('Collapse or expand tool output')
  })

  it('prints every group title', () => {
    const text = formatHotkeys(manager()).join('\n')
    for (const group of HOTKEY_GROUPS) expect(text).toContain(group.title)
  })
})

describe('TuiApp routes through the stack (glue)', () => {
  /**
   * The unit tests above prove the mechanism; these prove the wiring.
   *
   * Without them the app could keep its old `matchesKey` cascade and every test
   * above would still pass — the seahorse case that made this round necessary.
   */
  function boot(overrides: Record<string, unknown> = {}): {
    app: TuiApp
    press: (data: string) => { consume?: boolean } | undefined
    onExit: ReturnType<typeof vi.fn>
  } {
    const onExit = vi.fn()
    const app = new TuiApp({
      getSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/tmp/w',
      getSessionId: () => 's',
      onSubmit: () => {},
      onExit,
      version: '0',
      statusFacts: () => ({ cwd: '/tmp/w' }),
      modelPicker: async () => ({ models: [], current: '' }),
      selectModel: () => {},
      terminal: new FakeTerminal(),
      ...overrides,
    })
    const route = (app as unknown as { handleInput(d: string): { consume?: boolean } | undefined }).handleInput
    return { app, press: (data) => route.call(app, data), onExit }
  }

  it('quits on ctrl+c, which is `app.clear`', () => {
    const { press, onExit } = boot()
    expect(press('\x03')).toEqual({ consume: true })
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('quits on ctrl+d, which is `app.exit`', () => {
    const { press, onExit } = boot()
    expect(press('\x04')).toEqual({ consume: true })
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('honours a rebound exit key and ignores the default', () => {
    // The whole point of a registry: the key comes from the binding, not from a
    // literal in `handleInput`.
    const { press, onExit } = boot({ keybindingOverrides: { 'app.clear': 'ctrl+q' } })
    expect(press('\x03')).toBeUndefined()
    expect(onExit).not.toHaveBeenCalled()
    expect(press('\x11')).toEqual({ consume: true })
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('ignores a key release, so holding ctrl+c does not exit twice', () => {
    // Kitty protocol reports releases on the same channel; re-firing an action on
    // the release frame is a real bug (a held key exits repeatedly).
    const { press, onExit } = boot()
    press('\x03')
    expect(onExit).toHaveBeenCalledTimes(1)
    // A CSI-u release encoding for ctrl+c.
    press('\x1b[99;5:3u')
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('lets ordinary typing through to the editor', () => {
    // `undefined` is how pi-tui is told to forward the key; returning
    // `{ consume: true }` here would swallow every character the user types.
    const { press } = boot()
    expect(press('a')).toBeUndefined()
    expect(press('\x1b[A')).toBeUndefined()
  })

  it('does not expand the transcript while an approval is pending', async () => {
    // Priority, end to end: the interaction scope sits above the app actions, so
    // `ctrl+o` is not the app's to take while the user is looking at a prompt.
    const { app, press } = boot()
    const seam = app as unknown as { fold: { allExpanded: boolean } }

    // Baseline: idle, so the key reaches `app.tools.expand` and flips the fold.
    expect(seam.fold.allExpanded).toBe(false)
    press('\x0f')
    expect(seam.fold.allExpanded).toBe(true)
    press('\x0f')
    expect(seam.fold.allExpanded).toBe(false)

    // Now raise a real approval (not a forged flag: `busy` derives from it).
    const pending = app.interactions.approve({ toolName: 'bash' } as never)
    expect(app.interactions.busy).toBe(true)

    press('\x0f')
    // Unchanged: the key was declined, not forwarded to `app.tools.expand`.
    expect(seam.fold.allExpanded).toBe(false)

    // Settle it so the promise does not outlive the test.
    app.interactions.cancelByUser()
    await pending
  })

  it('/hotkeys prints the live table', async () => {
    const { app } = boot()
    const submit = (app as unknown as { submit(t: string): Promise<void> }).submit
    await submit.call(app, '/hotkeys')
    const notices = (app as unknown as {
      noticeLog: { container: { children: { render(w: number): string[] }[] } }
    }).noticeLog.container.children.map((child) => child.render(200).join('\n')).join('\n')
    expect(stripAnsi(notices)).toContain('Collapse or expand tool output')
    expect(stripAnsi(notices)).toContain('Quit the terminal UI')
  })
})

describe('TuiApp — exit stays reachable from every surface', () => {
  /**
   * A modal panel must not be able to trap the user.
   *
   * The old cascade checked the exit keys **before** the model panel, so `ctrl+c`
   * worked from anywhere. A naive scope stack that puts the modal first reverses
   * that: the panel consumes every key, and the one action a stuck user reaches
   * for stops working. These pin the escape hatch.
   */
  function boot(): {
    app: TuiApp
    press: (data: string) => { consume?: boolean } | undefined
    onExit: ReturnType<typeof vi.fn>
  } {
    const onExit = vi.fn()
    const app = new TuiApp({
      getSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/tmp/w',
      getSessionId: () => 's',
      onSubmit: () => {},
      onExit,
      version: '0',
      statusFacts: () => ({ cwd: '/tmp/w' }),
      modelPicker: async () => ({ models: [{ id: 'm1', name: 'M1', provider: 'p' }], current: 'm1' }),
      selectModel: () => {},
      terminal: new FakeTerminal(),
    })
    const route = (app as unknown as { handleInput(d: string): { consume?: boolean } | undefined }).handleInput
    return { app, press: (data) => route.call(app, data), onExit }
  }

  it('quits even with the model panel open', async () => {
    const { app, press, onExit } = boot()
    await (app as unknown as { openModelPanel(): Promise<void> }).openModelPanel()
    expect((app as unknown as { modelPanel?: unknown }).modelPanel).toBeDefined()

    press('\x03')
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('quits even with a theme picker open', async () => {
    const { app, press, onExit } = boot()
    const submit = (app as unknown as { submit(t: string): Promise<void> }).submit
    await submit.call(app, '/theme')

    press('\x03')
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('lets a picker keep the keys it owns', async () => {
    // The complement: `ctrl+c` is an escape hatch, not a general override —
    // ordinary keys still belong to the open panel.
    const { app, press, onExit } = boot()
    const submit = (app as unknown as { submit(t: string): Promise<void> }).submit
    await submit.call(app, '/theme')
    press('\x1b')
    expect(onExit).not.toHaveBeenCalled()
  })
})

describe('loadKeybindingOverrides — pi\'s file, read defensively', () => {
  /**
   * Sharing pi's `keybindings.json` is the point of the whole rebind path: a user
   * who already rebound `app.tools.expand` for pi should get that binding here on
   * first run, without a second config format to learn.
   *
   * Failing open is not politeness — a TUI that refuses to start because a config
   * file has a stray comma is worse than one that ignores it.
   */
  function withFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-keymap-'))
    const path = join(dir, 'keybindings.json')
    writeFileSync(path, content)
    return path
  }

  it('reads a string binding', () => {
    const path = withFile(JSON.stringify({ 'app.tools.expand': 'ctrl+e' }))
    expect(loadKeybindingOverrides(path)).toEqual({ 'app.tools.expand': 'ctrl+e' })
  })

  it('reads a list binding, including the empty list that disables', () => {
    const path = withFile(JSON.stringify({
      'app.tools.expand': ['ctrl+e', 'ctrl+t'],
      'app.clear': [],
    }))
    expect(loadKeybindingOverrides(path)).toEqual({
      'app.tools.expand': ['ctrl+e', 'ctrl+t'],
      'app.clear': [],
    })
  })

  it('skips `$schema`, which is not a binding', () => {
    const path = withFile(JSON.stringify({
      $schema: 'https://pi.dev/schemas/keybindings.schema.json',
      'app.tools.expand': 'ctrl+e',
    }))
    expect(loadKeybindingOverrides(path)).toEqual({ 'app.tools.expand': 'ctrl+e' })
  })

  it('drops one malformed entry instead of the whole file', () => {
    // A number where a key belongs is a mistake in one line; losing every other
    // binding over it would be a worse outcome.
    const path = withFile(JSON.stringify({ 'app.tools.expand': 42, 'app.clear': 'ctrl+q' }))
    expect(loadKeybindingOverrides(path)).toEqual({ 'app.clear': 'ctrl+q' })
  })

  it('drops a partly-non-string list', () => {
    const path = withFile(JSON.stringify({ 'app.tools.expand': ['ctrl+e', 7] }))
    expect(loadKeybindingOverrides(path)).toEqual({})
  })

  it('returns {} for an absent file, which is the common case', () => {
    expect(loadKeybindingOverrides(join(tmpdir(), 'definitely-not-here', 'keybindings.json'))).toEqual({})
  })

  it('returns {} for invalid JSON rather than throwing', () => {
    expect(loadKeybindingOverrides(withFile('{ not json'))).toEqual({})
  })

  it('strips a UTF-8 BOM, which JSON.parse rejects', () => {
    // A file saved by a Windows editor would otherwise be ignored IN FULL, with
    // no diagnostic — while the theme loader has stripped the BOM all along.
    const path = withFile('\ufeff' + JSON.stringify({ 'app.tools.expand': 'ctrl+e' }))
    expect(loadKeybindingOverrides(path)).toEqual({ 'app.tools.expand': 'ctrl+e' })
  })

  it('returns {} when the file is not an object', () => {
    expect(loadKeybindingOverrides(withFile('[]'))).toEqual({})
  })

  it('resolves the default path under the pi agent directory', () => {
    // Same rule as the theme loader: `$PI_AGENT_DIR` when set, `~/.pi/agent`
    // otherwise. One agent directory, two config files.
    expect(defaultKeybindingsPath({ PI_AGENT_DIR: '/custom/dir' })).toBe('/custom/dir/keybindings.json')
    expect(defaultKeybindingsPath({})).toBe(join(homedir(), '.pi', 'agent', 'keybindings.json'))
  })

  it('ignores an empty PI_AGENT_DIR', () => {
    expect(defaultKeybindingsPath({ PI_AGENT_DIR: '  ' })).toBe(join(homedir(), '.pi', 'agent', 'keybindings.json'))
  })
})

describe('formatHotkeys — literal keys', () => {
  it('prints a literal key once, not twice', () => {
    // The `/` row is a literal prefix with no action to resolve. An empty string
    // beside it joined into `//` on a real terminal.
    const text = formatHotkeys(manager()).join('\n')
    expect(text).toContain('Slash commands')
    expect(text).not.toContain('//  ')
  })
})
