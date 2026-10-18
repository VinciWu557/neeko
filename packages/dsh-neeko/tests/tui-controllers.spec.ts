import { describe, expect, it, vi } from 'vitest'
import { ThemeController } from '../src/tui/theme-controller.ts'
import { StatusController } from '../src/tui/status-controller.ts'
import { CommandController } from '../src/tui/command-controller.ts'
import { resolveTheme } from '../src/tui/theme.ts'
import type { UserTheme } from '../src/tui/theme.ts'

/**
 * The three controllers extracted out of `TuiApp`.
 *
 * Each one is asserted on its **own** terms — state transitions and policy — so
 * the app class is left owning only screen geometry and key arbitration. These
 * suites also encode the invariants that motivated the split: a controller must
 * be constructible without a terminal, a pi-tui widget, or a live agent.
 */

const userTheme = (name: string): UserTheme => ({
  document: { name, appearance: 'dark', colors: { accent: 'okhsl(200 60% 60%)' } },
  sourcePath: `/themes/${name}.json`,
})

describe('ThemeController', () => {
  it('falls back to built-in dark for an unknown initial name', () => {
    const themes = new ThemeController({ initialTheme: 'nope', userThemes: [] })
    expect(themes.current.name).toBe('dark')
  })

  it('honours a known initial name', () => {
    expect(new ThemeController({ initialTheme: 'light', userThemes: [] }).current.name).toBe('light')
  })

  it('exposes built-ins plus user themes in the catalogue', () => {
    const themes = new ThemeController({ userThemes: [userTheme('ocean')] })
    expect(themes.catalogue.map((choice) => choice.name)).toEqual(['dark', 'light', 'ocean'])
  })

  it('reports built-in vs custom', () => {
    const themes = new ThemeController({ userThemes: [userTheme('ocean')] })
    expect(themes.isCustom('ocean')).toBe(true)
    expect(themes.isCustom('dark')).toBe(false)
  })

  it('opens the picker positioned on the active theme', () => {
    const themes = new ThemeController({ initialTheme: 'light', userThemes: [] })
    const view = themes.openPicker()
    expect(view?.index).toBe(1) // dark, light
    expect(themes.isPickerOpen).toBe(true)
  })

  it('wraps the cursor at both ends', () => {
    const themes = new ThemeController({ userThemes: [] })
    themes.openPicker()
    expect(themes.movePicker(-1)?.index).toBe(1) // wrapped past dark
    expect(themes.movePicker(1)?.index).toBe(0)
  })

  it('applies the picker selection and closes', () => {
    const themes = new ThemeController({ userThemes: [] })
    themes.openPicker()
    themes.movePicker(1)
    const applied = themes.confirmPicker()
    expect(applied?.name).toBe('light')
    expect(themes.isPickerOpen).toBe(false)
    expect(themes.current.name).toBe('light')
  })

  it('notifies on change and stays silent for an unknown name', () => {
    const onChange = vi.fn()
    const themes = new ThemeController({ userThemes: [] })
    themes.onChange = onChange
    expect(themes.apply('nope')).toBeUndefined()
    expect(onChange).not.toHaveBeenCalled()
    themes.apply('light')
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('does not open an empty picker', () => {
    // A controller with no catalogue (nothing built-in) must not show a menu.
    const themes = new ThemeController({ userThemes: [] })
    expect(themes.catalogue.length).toBeGreaterThan(0) // built-ins always exist
    expect(themes.openPicker()).not.toBeUndefined()
  })
})

describe('StatusController', () => {
  const theme = resolveTheme({ name: 't', colors: { muted: 'okhsl(0 0% 50%)', dim: 'okhsl(0 0% 40%)' } })
  const make = (overrides: Partial<ConstructorParameters<typeof StatusController>[0]> = {}) =>
    new StatusController({
      readFacts: () => ({ cwd: '/repo', ledger: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } }),
      route: () => ({ provider: 'p', model: 'm' }),
      theme: () => theme,
      width: () => 80,
      ...overrides,
    })

  it('renders nothing before the first refresh and fills on refresh', () => {
    const status = make()
    expect(status.currentLines).toEqual([])
    status.refresh()
    expect(status.currentLines.length).toBe(2)
  })

  it('pulls facts on refresh, not on every render', () => {
    // The invariant that motivated the split: `render()` is a layout pass.
    const readFacts = vi.fn(() => ({ cwd: '/repo' }))
    const status = make({ readFacts })
    status.refresh()
    const afterFirst = readFacts.mock.calls.length
    status.component.render(80)
    status.component.render(80)
    expect(readFacts.mock.calls.length).toBe(afterFirst)
  })

  it('re-lays-out on a different width without re-reading facts', () => {
    const readFacts = vi.fn(() => ({ cwd: '/repo' }))
    const status = make({ readFacts })
    status.refresh()
    const calls = readFacts.mock.calls.length
    const wide = status.component.render(120)
    const narrow = status.component.render(60)
    expect(readFacts.mock.calls.length).toBe(calls)
    expect(wide.join('').length).toBeGreaterThan(narrow.join('').length)
  })

  it('ignores a repeated timing segment', () => {
    const status = make()
    status.refresh()
    const seen: number[] = []
    status.onChange = () => seen.push(1)
    status.setTiming('⏱ 1s')
    status.setTiming('⏱ 1s')
    expect(seen).toHaveLength(1)
  })

  it('shows the timing segment ahead of the ledger', () => {
    const status = make()
    status.refresh()
    status.setTiming('⏱ 9s')
    expect(status.currentLines[1]).toContain('⏱ 9s')
    expect(status.currentLines[1]).toContain('↑100')
  })
})

describe('CommandController', () => {
  const make = (runHostCommand?: (line: string) => Promise<{ kind: 'success' | 'error'; text?: string } | undefined>) =>
    new CommandController({
      loadModels: async () => [{ id: 'm1', name: 'Model 1', provider: 'p' }],
      ...(runHostCommand === undefined ? {} : { runHostCommand }),
    })

  it('routes a plain line to the model', () => {
    expect(make().classify('hello')).toEqual({ kind: 'prompt', text: 'hello' })
  })

  it('routes built-ins to their actions', () => {
    const c = make()
    expect(c.classify('/clear')).toEqual({ kind: 'clear' })
    expect(c.classify('/exit')).toEqual({ kind: 'exit' })
    expect(c.classify('/model')).toEqual({ kind: 'model-picker' })
    expect(c.classify('/theme')).toEqual({ kind: 'theme-picker' })
    expect(c.classify('/theme light')).toEqual({ kind: 'apply-theme', name: 'light' })
  })

  it('renders /help as a notice, not a host dispatch', () => {
    const action = make().classify('/help')
    expect(action.kind).toBe('notice')
  })

  it('routes an unknown command to the host with its raw line', () => {
    // The whole point of the variant: no text sniffing, no re-derivation.
    expect(make().classify('/compact')).toEqual({ kind: 'host', line: '/compact', name: 'compact' })
    expect(make().classify('/skill:neeko-check')).toEqual({
      kind: 'host',
      line: '/skill:neeko-check',
      name: 'skill:neeko-check',
    })
  })

  it('loads the model catalogue once', async () => {
    const loadModels = vi.fn(async () => [{ id: 'm1', name: 'M', provider: 'p' }])
    const c = new CommandController({ loadModels })
    await c.ensureModels()
    await c.ensureModels()
    expect(loadModels).toHaveBeenCalledTimes(1)
    expect(c.modelCatalogue).toHaveLength(1)
  })

  it('fails open when the catalogue cannot load', async () => {
    const c = new CommandController({ loadModels: async () => { throw new Error('down') } })
    await expect(c.ensureModels()).resolves.toEqual([])
    expect(c.modelCatalogue).toEqual([])
  })

  it('reports host success text', async () => {
    const c = make(async () => ({ kind: 'success', text: 'Compacted.' }))
    expect(await c.runOnHost('/compact')).toEqual({ ok: true, text: 'Compacted.' })
  })

  it('substitutes a placeholder when the host returns no text', async () => {
    const c = make(async () => ({ kind: 'success' }))
    expect(await c.runOnHost('/x')).toEqual({ ok: true, text: 'done' })
  })

  it('reports undefined when no host command matched', async () => {
    expect(await make(async () => undefined).runOnHost('/nope')).toBeUndefined()
    expect(await make().runOnHost('/nope')).toBeUndefined() // no dispatcher at all
  })

  it('turns a thrown host error into an error result (never escapes)', async () => {
    const c = make(async () => { throw new Error('boom') })
    expect(await c.runOnHost('/x')).toEqual({ ok: false, text: 'command failed: boom' })
  })
})
