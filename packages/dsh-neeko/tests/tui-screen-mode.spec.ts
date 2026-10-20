import { afterEach, describe, expect, it } from 'vitest'
import { screenModeOf } from '../src/tui/runner.ts'

/**
 * Which screen the TUI mounts, and what the default is.
 *
 * This decides **who owns scrolling**:
 *
 * - `main` — the terminal does. Its scrollback, its PageUp/PageDown, its wheel.
 *   The app keeps no scroll position, so nothing can fall out of step.
 * - `fullscreen` — the app does, through a `ScrollView` with `follow: 'end'`.
 *   That buys click-to-expand at the cost of the terminal's own scrollback.
 *
 * The default is `main`.
 *
 * ## Why this is a three-state value and not a boolean
 *
 * The domain has three cases — "asked for main", "asked for fullscreen", "said
 * nothing" — and the third is the one that carries the default. Encoding it as
 * `mainScreen?: boolean` worked only as long as every layer agreed that
 * `undefined` means `main`; the moment one layer read `undefined` as
 * `fullscreen` (which `TuiApp` did), the default became unreachable and the
 * flag/env precedence silently inverted.
 */

const ENV_KEYS = ['DSH_NEEKO_SCREEN', 'DSH_NEEKO_MAIN_SCREEN', 'DSH_NEEKO_FULLSCREEN'] as const

/** Run `body` with a clean TUI-related environment. */
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

describe('screenModeOf — the default', () => {
  it('is the terminal-owned main screen', () => {
    withEnv({}, () => {
      expect(screenModeOf({})).toBe('main')
    })
  })
})

describe('screenModeOf — the configuration wins', () => {
  it('honours an explicit fullscreen request', () => {
    withEnv({}, () => {
      expect(screenModeOf({ screen: 'fullscreen' })).toBe('fullscreen')
    })
  })

  it('honours an explicit main request', () => {
    withEnv({}, () => {
      expect(screenModeOf({ screen: 'main' })).toBe('main')
    })
  })

  it('does not let the environment override an explicit request', () => {
    // The flag is the more specific statement: a script that passes `--main-screen`
    // means it, whatever the shell was set up for.
    withEnv({ DSH_NEEKO_SCREEN: 'fullscreen' }, () => {
      expect(screenModeOf({ screen: 'main' })).toBe('main')
    })
  })
})

describe('screenModeOf — the environment', () => {
  it('opts into the alt screen', () => {
    withEnv({ DSH_NEEKO_SCREEN: 'fullscreen' }, () => {
      expect(screenModeOf({})).toBe('fullscreen')
    })
  })

  it('ignores an unrecognised value instead of guessing', () => {
    withEnv({ DSH_NEEKO_SCREEN: 'yes' }, () => {
      expect(screenModeOf({})).toBe('main')
    })
  })

  it('still honours the two legacy variables', () => {
    // `DSH_NEEKO_FULLSCREEN=1` shipped with the previous default; and
    // `DSH_NEEKO_MAIN_SCREEN=1` predates even that. Both keep meaning what they
    // meant, which is also what `DSH_NEEKO_SCREEN` now says in one variable.
    withEnv({ DSH_NEEKO_FULLSCREEN: '1' }, () => {
      expect(screenModeOf({})).toBe('fullscreen')
    })
    withEnv({ DSH_NEEKO_MAIN_SCREEN: '1' }, () => {
      expect(screenModeOf({})).toBe('main')
    })
  })

  it('prefers the conservative screen when both legacy variables are set', () => {
    // Both are `=1` spellings of the same variable's job, so a conflict is a
    // mistake in someone's shell profile. Resolve it the way the flags resolve
    // theirs: the quieter screen wins.
    withEnv({ DSH_NEEKO_MAIN_SCREEN: '1', DSH_NEEKO_FULLSCREEN: '1' }, () => {
      expect(screenModeOf({})).toBe('main')
    })
  })

  it('lets DSH_NEEKO_SCREEN settle a conflicting pair', () => {
    // Both legacy variables set is ambiguous; the consolidated one is the answer.
    withEnv({ DSH_NEEKO_MAIN_SCREEN: '1', DSH_NEEKO_FULLSCREEN: '1', DSH_NEEKO_SCREEN: 'fullscreen' }, () => {
      expect(screenModeOf({})).toBe('fullscreen')
    })
  })
})
