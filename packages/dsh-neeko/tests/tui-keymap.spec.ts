import { afterEach, describe, expect, it, vi } from 'vitest'
import { KeybindingsManager, TUI_KEYBINDINGS, getKeybindings, setKeybindings } from '@earendil-works/pi-tui'
import type { KeybindingsConfig } from '@earendil-works/pi-tui'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  APP_KEYBINDINGS,
  actionKeys,
  installKeymap,
  HOTKEY_GROUPS,
  actionScope,
  formatHotkeys,
  formatKeyText,
  defaultKeybindingsPath,
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
      'app.clipboard.pasteImage',
      'app.exit',
      'app.model.cycleBackward',
      'app.model.cycleForward',
      'app.model.select',
      'app.suspend',
      'app.thinking.cycle',
      'app.thinking.toggle',
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

  it('routes ctrl+c to `app.clear`, which clears before it exits', () => {
    // The binding did not change; what it *does* did (`exit-keys.ts`). One press
    // clears, two exit — so a single press must not call `onExit`.
    const { press, onExit } = boot()
    expect(press('\x03')).toEqual({ consume: true })
    expect(onExit).not.toHaveBeenCalled()
    press('\x03')
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
    // Rebound to `ctrl+q`, which now needs the same two presses as the default.
    expect(press('\x11')).toEqual({ consume: true })
    expect(onExit).not.toHaveBeenCalled()
    expect(press('\x11')).toEqual({ consume: true })
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('ignores a key release, so holding ctrl+c does not exit twice', () => {
    // Kitty protocol reports releases on the same channel; re-firing an action on
    // the release frame is a real bug (a held key exits repeatedly).
    const { press, onExit } = boot()
    press('\x03')
    // A CSI-u release encoding for ctrl+c must not count as the second press.
    press('\x1b[99;5:3u')
    expect(onExit).not.toHaveBeenCalled()
    press('\x03')
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

describe('TuiApp — a modal panel must not trap the user', () => {
  /**
   * A panel must not be able to hold the keyboard hostage.
   *
   * The mechanism changed with `ctrl+c`: the exit scope now **yields** to an open
   * panel (see `exit-keys.ts`), so `ctrl+c` no longer exits from inside one. The
   * guarantee it used to provide is kept by the panel itself — pi-tui's
   * `tui.select.cancel` defaults to `['escape', 'ctrl+c']`, so the key still gets
   * the user out, it just closes the picker instead of the program.
   *
   * That is the right ladder: the first press backs out one level, and a second
   * press (with no panel left) reaches the exit rule.
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

  it('closes the model panel on ctrl+c instead of quitting', async () => {
    const { app, press, onExit } = boot()
    await (app as unknown as { openModelPanel(): Promise<void> }).openModelPanel()
    const panelOf = (): unknown => (app as unknown as { modelPanel?: unknown }).modelPanel
    expect(panelOf()).toBeDefined()

    press('\x03')
    expect(panelOf()).toBeUndefined()
    expect(onExit).not.toHaveBeenCalled()
  })

  it('closes a theme picker on ctrl+c instead of quitting', async () => {
    const { app, press, onExit } = boot()
    const submit = (app as unknown as { submit(t: string): Promise<void> }).submit
    await submit.call(app, '/theme')
    press('\x03')
    expect(onExit).not.toHaveBeenCalled()
  })

  it('still quits once the panel is closed', async () => {
    // The escape hatch is deferred, not removed.
    const { app, press, onExit } = boot()
    await (app as unknown as { openModelPanel(): Promise<void> }).openModelPanel()
    press('\x03') // closes the panel
    press('\x03') // clear
    expect(onExit).not.toHaveBeenCalled()
    press('\x03') // second press inside the window → exit
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

describe('app-level keys that reach an existing capability', () => {
  /**
   * These are the `docs/keybindings.md` actions whose *effect* this build already
   * had and whose *key* it never bound. That is the cheapest kind of gap to close
   * and the most confusing to leave open: the feature works if you know the slash
   * command, and the key a pi user reaches for does nothing.
   */
  function boot(overrides: Record<string, unknown> = {}): {
    app: TuiApp
    press: (data: string) => unknown
  } {
    const app = new TuiApp({
      getSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/tmp/w',
      getSessionId: () => 's',
      onSubmit: () => {},
      onExit: () => {},
      version: '0',
      statusFacts: () => ({ cwd: '/tmp/w' }),
      modelPicker: async () => ({
        models: [
          { id: 'm1', name: 'M1', provider: 'p' },
          { id: 'm2', name: 'M2', provider: 'p' },
        ],
        current: 'm1',
      }),
      selectModel: () => {},
      terminal: new FakeTerminal(),
      ...overrides,
    })
    const route = (app as unknown as { handleInput(d: string): unknown }).handleInput
    return { app, press: (data) => route.call(app, data) }
  }

  it('ctrl+l opens the model selector', async () => {
    // pi's `app.model.select`. The panel exists and `/model` opens it; the key was
    // simply never bound, so a pi user's reflex did nothing.
    //
    // Awaited: opening reads the catalogue first, so the panel exists only after
    // that promise settles. Asserting synchronously would fail for the right
    // reason and the wrong one at the same time.
    const { app, press } = boot()
    expect(press('\x0c')).toEqual({ consume: true }) // ctrl+l
    await vi.waitFor(() => {
      expect((app as unknown as { modelPanel?: unknown }).modelPanel).toBeDefined()
    })
  })

  it('ctrl+v is bound to the clipboard action', () => {
    // The binding itself is all that can be checked without a real clipboard; the
    // three branches are the decision table in tui-clipboard.spec.ts.
    const { press } = boot()
    // Consumed even when the platform has no clipboard: the action reports that
    // rather than letting the control character reach the editor as a raw `\x16`.
    expect(press('\x16')).toEqual({ consume: true })
  })

  it('still consumes ctrl+l when the model list is empty', () => {
    // A panel over an empty catalogue is a no-op, but the key must still be
    // consumed — otherwise it leaks into the editor as a form feed.
    const { press } = boot({ modelPicker: async () => ({ models: [], current: '' }) })
    expect(press('\x0c')).toEqual({ consume: true })
  })
})

describe('ctrl+t repaints the transcript, not the chrome', () => {
  /**
   * `ctrl+t` changes fold state, which is read **while rows render** — so the whole
   * effect is a transcript repaint. The first version called `repaintChrome()`,
   * which re-paints the banner and the status bar and was probably incidental: the
   * transcript would only have updated because its own next flush happened to land.
   *
   * `toggleFold` (`ctrl+o`) already used `scheduleRender`, and two keys with the same
   * kind of effect drifting onto different repaint paths is exactly the class of
   * defect this round is fixing elsewhere.
   */
  it('toggles the fold state and reports it', () => {
    const app = new TuiApp({
      getSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/tmp/w',
      getSessionId: () => 's',
      onSubmit: () => {},
      onExit: () => {},
      version: '0',
      statusFacts: () => ({ cwd: '/tmp/w' }),
      modelPicker: async () => ({ models: [], current: '' }),
      selectModel: () => {},
      terminal: new FakeTerminal(),
    })
    const fold = (app as unknown as { fold: { thinkingVisible: boolean } }).fold
    expect(fold.thinkingVisible).toBe(false)
    const route = (app as unknown as { handleInput(d: string): unknown }).handleInput
    route.call(app, '\x14') // ctrl+t
    expect(fold.thinkingVisible).toBe(true)
  })
})

describe('platform keybindings match pi', () => {
  /**
   * pi binds two actions differently where the usual chord is unavailable:
   *
   * | action | Unix | Windows / WSL |
   * | --- | --- | --- |
   * | `app.model.cycleBackward` | `shift+ctrl+p` | `alt+p` |
   * | `app.clipboard.pasteImage` | `ctrl+v` | `alt+v` |
   *
   * `ctrl+shift+p` vs `shift+ctrl+p` is the same chord written the other way round
   * (the matcher folds modifier order), but the Windows split is real: `ctrl+v` is
   * the paste chord a Windows terminal may intercept, and `ctrl+p`/`ctrl+shift+p`
   * collide with line editing.
   *
   * pi decides this with `platform === 'win32' || (linux && WSL_DISTRO_NAME ||
   * WSL_INTEROP)`. Copied rather than invented, because a WSL terminal is a Linux
   * process with Windows' key conventions — the one case a plain `platform` check
   * gets wrong.
   */
  it('uses the Unix chords by default', () => {
    expect(actionKeys('app.model.cycleBackward', 'darwin', {})).toEqual(['shift+ctrl+p'])
    expect(actionKeys('app.clipboard.pasteImage', 'darwin', {})).toEqual(['ctrl+v'])
    expect(actionKeys('app.clipboard.pasteImage', 'linux', {})).toEqual(['ctrl+v'])
  })

  it('uses the Windows chords on win32', () => {
    expect(actionKeys('app.model.cycleBackward', 'win32', {})).toEqual(['alt+p'])
    expect(actionKeys('app.clipboard.pasteImage', 'win32', {})).toEqual(['alt+v'])
  })

  it('treats a WSL terminal as Windows', () => {
    // A Linux process, but the terminal is Windows': `ctrl+v` is intercepted there.
    expect(actionKeys('app.clipboard.pasteImage', 'linux', { WSL_DISTRO_NAME: 'Ubuntu' })).toEqual(['alt+v'])
    expect(actionKeys('app.model.cycleBackward', 'linux', { WSL_INTEROP: '/run/WSL/1' })).toEqual(['alt+p'])
  })

  it('leaves the platform-independent chords alone', () => {
    // Only two actions differ; everything else must not drift with the platform.
    for (const platform of ['darwin', 'win32', 'linux']) {
      expect(actionKeys('app.thinking.toggle', platform, {})).toEqual(['ctrl+t'])
      expect(actionKeys('app.thinking.cycle', platform, {})).toEqual(['shift+tab'])
      expect(actionKeys('app.model.select', platform, {})).toEqual(['ctrl+l'])
      expect(actionKeys('app.model.cycleForward', platform, {})).toEqual(['ctrl+p'])
    }
  })

  it('has no default for suspend on Windows', () => {
    // pi: "None on Windows" — there is no Unix job control to suspend into.
    expect(actionKeys('app.suspend', 'win32', {})).toEqual([])
    expect(actionKeys('app.suspend', 'darwin', {})).toEqual(['ctrl+z'])
  })
})

describe('installKeymap installs the platform chords', () => {
  /**
   * `actionKeys` being correct is not enough: `installKeymap` has to route the app's
   * defaults through it. Spreading the static `APP_KEYBINDINGS` table instead would
   * install `ctrl+v` on Windows too, and the tests for `actionKeys` would still pass.
   */
  it('installs alt+v as the paste chord on Windows', () => {
    const manager = installKeymap({}, 'win32', {})
    expect(manager.getKeys('app.clipboard.pasteImage' as never)).toEqual(['alt+v'])
    expect(manager.matches('\x16', 'app.clipboard.pasteImage' as never)).toBe(false)
  })

  it('installs ctrl+v as the paste chord elsewhere', () => {
    const manager = installKeymap({}, 'linux', {})
    expect(manager.getKeys('app.clipboard.pasteImage' as never)).toEqual(['ctrl+v'])
    expect(manager.matches('\x16', 'app.clipboard.pasteImage' as never)).toBe(true)
  })

  it('leaves suspend unbound on Windows', () => {
    const manager = installKeymap({}, 'win32', {})
    expect(manager.getKeys('app.suspend' as never)).toEqual([])
  })

  it('still lets a user override a platform default', () => {
    // The override is the point of having the registry at all; a platform default
    // must not be sticky.
    const manager = installKeymap({ 'app.clipboard.pasteImage': 'ctrl+y' }, 'win32', {})
    expect(manager.getKeys('app.clipboard.pasteImage' as never)).toEqual(['ctrl+y'])
  })
})

describe('an unbound action does not break routing', () => {
  /**
   * With no default keys, `actionScope` can never match `app.suspend`, so `ctrl+z`
   * falls through to the editor — which is what should happen on Windows, where the
   * key means undo in some terminals and nothing here. What must **not** happen is a
   * throw from an empty `defaultKeys` array.
   */
  it('routes ctrl+z to the editor when suspend has no keys', () => {
    const manager = installKeymap({}, 'win32', {})
    expect(manager.matches('\x1a', 'app.suspend' as never)).toBe(false)
    // The other suspend path — the handler is still callable, so the Windows refusal
    // message is reachable if a user binds the action themselves.
    expect(typeof manager.getDefinition('app.suspend' as never)).toBe('object')
  })
})
