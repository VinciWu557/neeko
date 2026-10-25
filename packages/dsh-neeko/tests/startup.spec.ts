import { describe, expect, it } from 'vitest'
import { resolveStartupValues } from '../src/startup.ts'

/**
 * `--spawn <cmd>` and `--no-spawn` are the SAME commander key (`spawn`), whose
 * value is a string, `false`, or absent. These cases pin all three states.
 *
 * Regression origin: the first implementation read `options.spawnEnabled`,
 * which commander never produces, and wrote `options.spawn` straight into
 * `spawnCommand`. `--no-spawn` therefore produced `spawnCommand: false`, which
 * the Config schema rejects — the whole profile row failed to activate.
 */
describe('resolveStartupValues — spawn flag three states', () => {
  it('omits both keys when neither flag is given', () => {
    const values = resolveStartupValues({})
    expect(values).not.toHaveProperty('autoSpawn')
    expect(values).not.toHaveProperty('spawnCommand')
  })

  it('sets autoSpawn=false and omits spawnCommand for --no-spawn', () => {
    const values = resolveStartupValues({ spawn: false })
    expect(values.autoSpawn).toBe(false)
    expect(values).not.toHaveProperty('spawnCommand')
  })

  it('sets only spawnCommand for --spawn <cmd>', () => {
    const values = resolveStartupValues({ spawn: '/bin/true' })
    expect(values.spawnCommand).toBe('/bin/true')
    expect(values).not.toHaveProperty('autoSpawn')
  })

  it('never lets a boolean reach spawnCommand', () => {
    for (const spawn of [false] as const) {
      const values = resolveStartupValues({ spawn })
      expect(typeof values.spawnCommand).not.toBe('boolean')
    }
  })
})

describe('resolveStartupValues — other flags', () => {
  it('treats the daemon positional as daemon mode', () => {
    expect(resolveStartupValues({}, 'daemon').daemon).toBe(true)
    expect(resolveStartupValues({ daemon: true }).daemon).toBe(true)
    expect(resolveStartupValues({})).not.toHaveProperty('daemon')
  })

  it('carries host, port and session when supplied', () => {
    const values = resolveStartupValues({ host: '0.0.0.0', port: '3082', session: 's1' })
    expect(values.host).toBe('0.0.0.0')
    expect(values.port).toBe(3082)
    expect(values.sessionId).toBe('s1')
  })
})

/**
 * The schema↔startup join. `resolveStartupValues` is the primary guard, but the
 * ① regression was ultimately "the value the CLI produces is rejected by the
 * Config schema". Pin that join directly so a future schema tightening (or a
 * patch expression change) fails here instead of at profile load.
 */
describe('startup values satisfy the Config schema', () => {
  it('accepts the values produced for every flag combination', async () => {
    const { Config } = await import('../src/index.ts')
    // Every flag that can emit a Config key is covered, `session` included: a
    // key missing from this loop is a key whose type can drift undetected.
    for (const flags of [
      {},
      { spawn: false as const },
      { spawn: '/bin/true' },
      { session: 's1' },
      { daemon: true },
      { host: '0.0.0.0', port: '3082' },
    ]) {
      const values = resolveStartupValues(flags)
      // Patch defaults mirror cordis.patch.yml; the schema must accept the merge.
      // `exactOptionalPropertyTypes` is on: absent keys must stay absent, which
      // mirrors how cordis.patch.yml emits `undefined` for unset flags.
      const merged = {
        daemon: values.daemon ?? false,
        host: values.host ?? '127.0.0.1',
        port: values.port ?? 3081,
        autoSpawn: values.autoSpawn ?? true,
        ...(values.sessionId === undefined ? {} : { sessionId: values.sessionId }),
        ...(values.spawnCommand === undefined ? {} : { spawnCommand: values.spawnCommand }),
      }
      expect(() => Config(merged)).not.toThrow()
    }
  })

  it('would notice a Config key whose type drifted', async () => {
    // Guards the loop above: if `sessionId` ever became non-string, the merged
    // object must be rejected rather than silently accepted.
    const { Config } = await import('../src/index.ts')
    const values = resolveStartupValues({ session: 's1' })
    expect(typeof values.sessionId).toBe('string')
    expect(() => Config({ sessionId: 42 } as unknown as Parameters<typeof Config>[0])).toThrow()
  })

  it('rejects a boolean spawnCommand, proving the schema is what caught bug ①', async () => {
    const { Config } = await import('../src/index.ts')
    // Cast past the type system on purpose: the runtime must still reject it,
    // because the patch evaluates `!!js` expressions that TypeScript never sees.
    expect(() => Config({ spawnCommand: false } as unknown as Parameters<typeof Config>[0])).toThrow()
  })
})

describe('resolveStartupValues — tui flag', () => {
  it('propagates --tui into the values', () => {
    const values = resolveStartupValues({ tui: true })
    expect(values.tui).toBe(true)
  })

  it('omits the tui key when the flag is absent (bridge mode unchanged)', () => {
    // The bridge path must be byte-identical to before: no tui key at all,
    // so cordis.patch.yml's `?? false` default and the bridge row are untouched.
    const values = resolveStartupValues({})
    expect(values).not.toHaveProperty('tui')
  })

  it('coexists with daemon and spawn flags', () => {
    const values = resolveStartupValues({ tui: true, daemon: true, spawn: false })
    expect(values.tui).toBe(true)
    expect(values.daemon).toBe(true)
    expect(values.autoSpawn).toBe(false)
  })
})

describe('resolveStartupValues — main screen is the default', () => {
  /**
   * The terminal owns its scrollback on the main screen: no `ScrollView`, no
   * `follow: 'end'`, no scroll position for the app to maintain. That is the
   * behaviour a terminal user expects from PageUp/PageDown and the wheel, and it
   * is what pi's `regular` mode does.
   *
   * Fullscreen is the opt-in: it buys click-to-expand and an application-owned
   * viewport, at the cost of the terminal's own scrollback.
   */
  it('says nothing when no flag is given, so the default applies', () => {
    // Absent, not `main`: this layer reports the request and the TUI owns the
    // default. Writing `screen: 'main'` here would be a second place that decides.
    expect(resolveStartupValues({})).not.toHaveProperty('screen')
  })

  it('reports --fullscreen', () => {
    expect(resolveStartupValues({ fullscreen: true }).screen).toBe('fullscreen')
  })

  it('reports --main-screen', () => {
    // Kept so an alias or a script that already passes it keeps working.
    expect(resolveStartupValues({ mainScreen: true }).screen).toBe('main')
  })

  it('prefers the conservative screen when both flags are given', () => {
    // `--main-screen` means no alt screen and no mouse reporting; when the two
    // contradict each other, the quieter one is the safer read.
    expect(resolveStartupValues({ mainScreen: true, fullscreen: true }).screen).toBe('main')
  })

  it('is independent of --tui', () => {
    expect(resolveStartupValues({ tui: true, fullscreen: true }))
      .toMatchObject({ tui: true, screen: 'fullscreen' })
  })
})
