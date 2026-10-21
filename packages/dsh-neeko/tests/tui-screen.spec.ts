import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Container, Text } from '@earendil-works/pi-tui'
import { DEFAULT_SCREEN, mountScreen, resolveScreen } from '../src/tui/screen.ts'
import { FakeTerminal } from './support/fake-terminal.ts'

/**
 * Which screen the TUI mounts, and what the default is.
 *
 * This decides **who owns scrolling**, and it decides **what the first frame
 * looks like**:
 *
 * - `main` — the terminal owns the scrollback. `TuiMainScreen` appends to the
 *   terminal and never clears it ("First render - just output everything without
 *   clearing", `tui-main-screen.js`), so the command that launched the TUI stays
 *   on screen above the UI.
 * - `fullscreen` — the alt screen owns the viewport. It enters with
 *   `?1049h` + `2J` + `H`, so the first frame is a clean screen.
 *
 * ## Why the default is `fullscreen`
 *
 * **pi's own default is `fullscreen`** (`settings-defaults.js` → `tuiMode`, and
 * `settings-manager` only falls back to the main screen when the value is
 * literally `'regular'`). The alignment rule for this project is "follow pi",
 * not "pick whichever screen is technically more conservative" — the earlier
 * choice of `main` as the default produced a first frame that visible differs
 * from pi's, which is exactly the defect this pins.
 *
 * ## Why this is a three-state value and not a boolean
 *
 * The domain has three cases — "asked for main", "asked for fullscreen", "said
 * nothing" — and the third is the one carrying the default. Encoding it as
 * `mainScreen?: boolean` worked only as long as every layer agreed that
 * `undefined` means one screen; the moment one layer read `undefined` as
 * `fullscreen` (`TuiApp` did) the default became unreachable and the flag/env
 * precedence silently inverted.
 */

const ENV_KEYS = ['DSH_NEEKO_SCREEN', 'DSH_NEEKO_MAIN_SCREEN', 'DSH_NEEKO_FULLSCREEN'] as const

/** Run `body` against an explicit environment object (never the real process env). */
function withEnv(vars: Partial<Record<(typeof ENV_KEYS)[number], string>>, body: () => void): void {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(vars)) process.env[key] = value
  try {
    body()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
})

describe('resolveScreen — the default', () => {
  it('is the terminal-owned main screen, which is what pi actually runs', () => {
    // The terminal owns the scrollback, so its own scrollbar appears, `PageUp` and
    // the wheel behave as they do in every other CLI, and history survives.
    //
    // pi's *source* suggests otherwise — `settings-defaults.js` ships
    // `tuiMode: "fullscreen"` — but `getTuiMode()` returns `"regular"` unless the
    // stored value is literally `"fullscreen"`, and a real profile pins
    // `"tuiMode": "regular"`. Measured on a pty: `pi` starts with no `?1049h`.
    withEnv({}, () => {
      expect(resolveScreen({})).toBe('main')
    })
  })

  it('is exported as one named constant, so no layer has to restate it', () => {
    // The defect this pins: the default used to be written twice — `screenModeOf()`
    // returned `'main'` and `TuiApp.start()` wrote `?? 'main'` again. Two copies
    // of a default cannot disagree *silently*, but they do disagree the moment
    // one is edited.
    expect(DEFAULT_SCREEN).toBe('main')
  })
})

describe('resolveScreen — the configuration wins', () => {
  it('honours an explicit main request', () => {
    withEnv({}, () => {
      expect(resolveScreen({ screen: 'main' })).toBe('main')
    })
  })

  it('honours an explicit fullscreen request', () => {
    withEnv({}, () => {
      expect(resolveScreen({ screen: 'fullscreen' })).toBe('fullscreen')
    })
  })

  it('does not let the environment override an explicit request', () => {
    // The flag is the more specific statement: a script that passes
    // `--main-screen` means it, whatever the shell was set up for.
    withEnv({ DSH_NEEKO_SCREEN: 'fullscreen' }, () => {
      expect(resolveScreen({ screen: 'main' })).toBe('main')
    })
  })
})

describe('resolveScreen — the environment', () => {
  it('opts out to the main screen', () => {
    withEnv({ DSH_NEEKO_SCREEN: 'main' }, () => {
      expect(resolveScreen({})).toBe('main')
    })
  })

  it('ignores an unrecognised value instead of guessing', () => {
    // `yes` is not a screen name. Falling back to the default is the only answer
    // that cannot surprise: it is the same screen a user gets with no
    // configuration at all.
    withEnv({ DSH_NEEKO_SCREEN: 'yes' }, () => {
      expect(resolveScreen({})).toBe('main')
    })
  })

  it('still honours the two legacy variables', () => {
    // `DSH_NEEKO_FULLSCREEN=1` shipped with the previous default, and
    // `DSH_NEEKO_MAIN_SCREEN=1` predates even that. Both keep meaning what they
    // meant, which is also what `DSH_NEEKO_SCREEN` now says in one variable.
    withEnv({ DSH_NEEKO_FULLSCREEN: '1' }, () => {
      expect(resolveScreen({})).toBe('fullscreen')
    })
    withEnv({ DSH_NEEKO_MAIN_SCREEN: '1' }, () => {
      expect(resolveScreen({})).toBe('main')
    })
  })

  it('prefers the conservative screen when both legacy variables are set', () => {
    // Both are `=1` spellings of the same variable's job, so a conflict is a
    // mistake in someone's shell profile. Resolve it the way the flags resolve
    // theirs: the quieter screen wins.
    withEnv({ DSH_NEEKO_MAIN_SCREEN: '1', DSH_NEEKO_FULLSCREEN: '1' }, () => {
      expect(resolveScreen({})).toBe('main')
    })
  })

  it('lets DSH_NEEKO_SCREEN settle a conflicting pair', () => {
    // Both legacy variables set is ambiguous; the consolidated one is the answer.
    withEnv({ DSH_NEEKO_MAIN_SCREEN: '1', DSH_NEEKO_FULLSCREEN: '1', DSH_NEEKO_SCREEN: 'fullscreen' }, () => {
      expect(resolveScreen({})).toBe('fullscreen')
    })
  })
})

describe('the default lives in exactly one place', () => {
  /**
   * A structural check, because the behavioural one cannot see it.
   *
   * `resolveScreen({})` and `TuiApp.start()` can agree on `fullscreen` while the
   * app *still* carries a second literal — and then the next person edits one of
   * them. Grepping the app for a self-supplied screen default is the only way to
   * keep the invariant from drifting back.
   */
  const SRC = join(import.meta.dirname, '..', 'src', 'tui')

  it('app.ts supplies no screen default of its own', () => {
    const source = readFileSync(join(SRC, 'app.ts'), 'utf8')
    // The shapes the bug took: `?? 'main'`, `?? 'fullscreen'`, `|| 'main'`.
    expect(source).not.toMatch(/screenMode\s*\?\?\s*['"]/)
    expect(source).not.toMatch(/screenMode\s*\|\|\s*['"]/)
  })

  it('screen.ts holds the only definition of the default', () => {
    const source = readFileSync(join(SRC, 'screen.ts'), 'utf8')
    // One declaration, and `resolveScreen` is the only reader of it.
    expect(source.match(/export const DEFAULT_SCREEN/gmu)).toHaveLength(1)
    expect(source).toContain('return DEFAULT_SCREEN')
  })
})

describe('mountScreen — mounting does not touch the terminal', () => {
  /**
   * Mounting is composition; starting is raw mode plus the screen's entry
   * sequence. Keeping them apart is what lets `TuiApp` paint the banner before
   * any byte reaches the terminal, and it is why these two live in one place:
   * the earlier split had the alt screen started inside `mountFullscreen()` while
   * the main screen was started by `TuiApp`, so the two screens had different
   * lifecycle contracts and only one of them could be exercised without a TTY.
   */
  function parts(): {
    document: Container
    aboveInput: Container
    input: Text
    footer: Text
    onInput: (data: string) => undefined
  } {
    return {
      document: new Container(),
      aboveInput: new Container(),
      input: new Text('INPUT'),
      footer: new Text('FOOTER'),
      onInput: () => undefined,
    }
  }

  it('writes nothing when a screen is only mounted', () => {
    const terminal = new FakeTerminal()
    const alt = mountScreen(terminal, 'fullscreen', parts())
    expect(terminal.output).not.toContain('\x1b[?1049h')
    alt.start()
    // Only `start()` enters the alt screen.
    expect(terminal.output).toContain('\x1b[?1049h')
  })

  it('enters nothing on the main screen, before or after start', () => {
    // The main screen appends to the terminal it inherits; there is no entry
    // sequence, which is exactly why its first frame keeps the shell command.
    const terminal = new FakeTerminal()
    const main = mountScreen(terminal, 'main', parts())
    main.start()
    expect(terminal.output).not.toContain('\x1b[?1049h')
    expect(terminal.stopped).toBe(false)
  })

  it('gives only the alt screen a scroll region', () => {
    // This single field is the answer to "who owns scrolling". The main screen
    // must not have one: the terminal owns that scrollback, and a second scroll
    // model would disagree with the first.
    const terminal = new FakeTerminal()
    expect(mountScreen(terminal, 'fullscreen', parts()).scroll).toBeDefined()
    expect(mountScreen(terminal, 'main', parts()).scroll).toBeUndefined()
  })

  it('stops the screen without printing a second copy of the document', () => {
    // `preserveScreen` on both screens: `TuiApp.stop()` writes the final document
    // itself, so a renderer that also printed one would double it.
    const terminal = new FakeTerminal()
    const main = mountScreen(terminal, 'main', parts())
    const before = terminal.output.length
    main.dispose()
    expect(terminal.stopped).toBe(true)
    expect(terminal.output.length).toBe(before)
  })
})

describe('main screen — pi\'s regular mode, entry for entry', () => {
  /**
   * No window, no clearing. Both were tried here and both were withdrawn, because
   * pi's `regular` mode does neither (measured on a pty: zero `2J`, zero `3J` on
   * startup) and each made the screen worse in a different way:
   *
   * - A **tail window** (`rows - dock`) bounded the transcript to a viewport, so
   *   rows past the window were never rendered and scrolling up showed nothing
   *   that had been trimmed — "messages cannot be scrolled back to".
   * - **Clearing the viewport on entry** hid the launching command, but it also
   *   interacts with the renderer's own full-redraw path, and pi does not do it.
   *
   * What is left is the plain shape: the whole document, then the dock. The price
   * is that the renderer diffs more lines per frame — pi's price too, and the
   * unavoidable one when the terminal owns the scrollback.
   */
  function mounted(lines: number): { rendered: string[]; output: () => string } {
    const document = new Container()
    for (let index = 0; index < lines; index += 1) document.addChild(new Text(`line ${index}`, 0, 0))
    const terminal = new FakeTerminal({ columns: 40, rows: 10 })
    const screen = mountScreen(terminal, 'main', {
      document,
      aboveInput: new Container(),
      input: new Text('INPUT'),
      footer: new Text('FOOTER'),
      onInput: () => undefined,
    })
    screen.start()
    return { rendered: screen.screen.render(40), output: () => terminal.output }
  }

  it('renders the whole document, not just its tail', () => {
    // A bounded window would drop `line 0`, and the user could never scroll back
    // to it — the terminal has it only if it was written.
    const { rendered } = mounted(200)
    const documentLines = rendered.filter((line) => line.includes('line '))
    expect(documentLines.length).toBe(200)
    expect(rendered.join('\n')).toContain('line 0')
    expect(rendered.join('\n')).toContain('line 199')
  })

  it('does not clear on start, exactly as pi does', () => {
    // `TuiMainScreen` appends to whatever is on screen. Clearing would be a local
    // improvement over pi, and this build matches pi rather than improving on it.
    const { output } = mounted(3)
    expect(output()).not.toContain('\x1b[2J')
    expect(output()).not.toContain('\x1b[3J')
  })

  it('keeps the dock after the document', () => {
    const { rendered } = mounted(2)
    const text = rendered.join('\n')
    expect(text.indexOf('line 1')).toBeLessThan(text.indexOf('INPUT'))
    expect(text.indexOf('INPUT')).toBeLessThan(text.indexOf('FOOTER'))
  })
})

describe('fullscreen — pi\'s createChatViewport, entry for entry', () => {
  /**
   * The composer is a **fixed dock**, not part of the scroll content.
   *
   * An earlier round moved it into the scroll view so it would follow the
   * conversation on scroll-up. That is a different product decision, and it had a
   * concrete cost: after scrolling up, the input line was off screen with nothing
   * to type into. pi keeps the dock fixed for that reason, and this build matches.
   */
  function built(): {
    screen: ReturnType<typeof mountScreen>
    editorRow: () => number
    firstRow: () => string
    scrollBy: (lines: number) => void
  } {
    const document = new Container()
    for (let index = 0; index < 100; index += 1) document.addChild(new Text(`L${index}`, 0, 0))
    const terminal = new FakeTerminal({ columns: 40, rows: 20 })
    const screen = mountScreen(terminal, 'fullscreen', {
      document,
      aboveInput: new Container(),
      input: new Text('THE-EDITOR'),
      footer: new Text('THE-FOOTER'),
      onInput: () => undefined,
    })
    screen.start()
    screen.screen.renderNow(true)
    const frame = (): string[] => (screen.screen as unknown as { getScreenLines(): string[] })
      .getScreenLines()
      .map((line) => line.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\]8;;[^\x07]*\x07/gu, '').trim())
    return {
      screen,
      editorRow: () => frame().findIndex((line) => line.includes('THE-EDITOR')),
      firstRow: () => (frame()[0] ?? '').trimStart().slice(0, 8).trimEnd(),
      scrollBy: (count) => {
        screen.scroll?.scrollBy(count)
        screen.screen.renderNow(true)
      },
    }
  }

  it('shows the conversation end with the composer docked below it', () => {
    const view = built()
    expect(view.firstRow()).toBe('L86')
    expect(view.editorRow()).toBeGreaterThan(0)
  })

  it('keeps the composer on screen while the conversation scrolls', () => {
    // The reason the dock is fixed: after a scroll-up there must still be an input
    // line to type into.
    const view = built()
    const before = view.editorRow()
    view.scrollBy(-16)
    expect(view.editorRow()).toBe(before)
    expect(view.firstRow()).toBe('L70')
  })
})
