import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUILTIN_THEMES, THEME_TOKENS, THEMES_DIR_ENV, Theme, findBuiltin, listThemes,
  loadUserThemes, markdownThemeOf, piThemesDir, resolveTheme, resolveThemeByName,
  themeSearchPaths, themesDir,
} from '../src/tui/theme.ts'
import type { ThemeDocument } from '../src/tui/theme.ts'

/**
 * The theme system mirrors pi's: a theme is `{ vars, colors }` where `colors`
 * maps semantic tokens to either a var name or a literal color. These cases pin
 * the resolution rules and the fact that a bad color degrades instead of
 * throwing at render time.
 */

const doc: ThemeDocument = {
  name: 'test',
  appearance: 'dark',
  vars: { primary: 'okhsl(295 50% 67%)' },
  colors: { accent: 'primary', text: 'primary', muted: '#808080' },
}

describe('Theme resolution', () => {
  it('resolves a var reference to its literal color', () => {
    const theme = resolveTheme(doc)
    // Same var, same escape sequence.
    expect(theme.ansiOf('accent')).toBe(theme.ansiOf('text'))
    expect(theme.ansiOf('accent')).not.toBe('')
  })

  it('accepts a literal color without a var', () => {
    const theme = resolveTheme(doc)
    expect(theme.ansiOf('muted')).not.toBe('')
  })

  it('emits the default-foreground reset for an empty color', () => {
    // pi treats "" as "terminal default" rather than "no styling".
    const theme = resolveTheme({ name: 'reset', colors: { text: '' } })
    expect(theme.ansiOf('text')).toBe('\x1b[39m')
  })

  it('does not throw on an unparsable color (degrades to default)', () => {
    const theme = resolveTheme({ name: 'broken', colors: { accent: 'not-a-color' } })
    expect(() => theme.fg('accent', 'x')).not.toThrow()
  })

  it('throws a named error for a token a hand-built theme does not define', () => {
    // The programming-error contract lives at the `Theme` boundary: sparse
    // *documents* are normalised by `resolveTheme` (overlay, next cases), so
    // only direct construction can produce a Theme with holes.
    const theme = new Theme('sparse', { name: 'sparse', colors: { accent: 'okhsl(0 0% 50%)' } })
    expect(() => theme.fg('error', 'x')).toThrow(/no color for "error"/)
  })

  it('overlays a partial document on the dark base (every token resolves)', () => {
    // A partial file is VALID input for the loader; painting it must not throw
    // mid-repaint — missing rows fall back to the base palette.
    const theme = resolveTheme({ name: 'sparse', colors: { accent: '#123456' } })
    for (const token of THEME_TOKENS) {
      expect(() => theme.fg(token, 'x'), token).not.toThrow()
    }
    const dark = resolveTheme(findBuiltin('dark')!)
    expect(theme.ansiOf('error')).toBe(dark.ansiOf('error')) // inherited
    expect(theme.ansiOf('accent')).not.toBe(dark.ansiOf('accent')) // explicit wins
  })

  it('overlays an appearance-light document on the light base', () => {
    const theme = resolveTheme({ name: 'sparse', appearance: 'light', colors: { accent: '#123456' } })
    const light = resolveTheme(findBuiltin('light')!)
    expect(theme.ansiOf('error')).toBe(light.ansiOf('error'))
    expect(theme.ansiOf('accent')).not.toBe(light.ansiOf('accent'))
  })

  it('does not inherit the base appearance (an undeclared one stays undeclared)', () => {
    // Appearance decides the terminal color-mode fallback; leaking the base's
    // `dark` would silently force truecolor on a theme that never asked.
    const theme = resolveTheme({ name: 'plain', colors: { accent: '#123456' } })
    expect(theme.spec.appearance).toBeUndefined()
  })

  it('wraps text in the token escape and resets afterwards', () => {
    const theme = resolveTheme(doc)
    const painted = theme.fg('accent', 'hello')
    expect(painted.startsWith(theme.ansiOf('accent'))).toBe(true)
    expect(painted.endsWith('\x1b[39m')).toBe(true)
    expect(painted).toContain('hello')
  })
})

describe('built-in themes', () => {
  it('ships dark and light, both with a declared appearance', () => {
    expect(BUILTIN_THEMES.map((theme) => theme.name)).toEqual(['dark', 'light'])
    expect(findBuiltin('dark')?.appearance).toBe('dark')
    expect(findBuiltin('light')?.appearance).toBe('light')
  })

  it('defines every token the TUI paints', () => {
    // Keep this list in sync with what app.ts/transcript.ts actually call.
    const painted = ['accent', 'border', 'success', 'error', 'warning', 'muted', 'dim', 'text', 'thinkingText', 'userMessageText']
    for (const theme of BUILTIN_THEMES) {
      for (const token of painted) {
        expect(theme.colors, `${theme.name} is missing ${token}`).toHaveProperty(token)
      }
    }
  })

  it('returns undefined for an unknown name', () => {
    expect(findBuiltin('nope')).toBeUndefined()
  })
})

describe('listThemes', () => {
  it('works with no user themes', () => {
    expect(listThemes([]).map((choice) => choice.name)).toEqual(['dark', 'light'])
  })

  it('defaults an undeclared appearance to dark', () => {
    const user = [{ document: { name: 'bare', colors: { accent: '#fff' } }, sourcePath: '/x/bare.json' }]
    expect(listThemes(user).find((choice) => choice.name === 'bare')?.appearance).toBe('dark')
  })
})

describe('Theme instance', () => {
  it('exposes its document for previews', () => {
    const theme = new Theme('x', doc)
    expect(theme.spec.name).toBe('test')
    expect(theme.name).toBe('x')
  })
})

describe('user theme files', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-neeko-themes-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const write = (name: string, body: unknown): void => {
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body))
  }

  it('loads a valid theme file', () => {
    write('ocean.json', {
      name: 'ocean',
      appearance: 'dark',
      vars: { blue: 'okhsl(220 60% 60%)' },
      colors: { accent: 'blue', text: 'blue' },
    })
    const themes = loadUserThemes(dir)
    expect(themes.map((theme) => theme.document.name)).toEqual(['ocean'])
    expect(themes[0]?.document.vars?.blue).toBe('okhsl(220 60% 60%)')
    expect(resolveTheme(themes[0]!.document).ansiOf('accent')).not.toBe('')
  })

  it('falls back to the file stem when the document has no name', () => {
    write('nameless.json', { colors: { accent: 'okhsl(0 50% 50%)' } })
    expect(loadUserThemes(dir)[0]?.document.name).toBe('nameless')
  })

  it('keeps only known tokens and ignores unknown ones', () => {
    write('partial.json', { colors: { accent: 'okhsl(0 50% 50%)', notAToken: '#fff' } })
    const document = loadUserThemes(dir)[0]!.document
    expect(document.colors).toHaveProperty('accent')
    expect(document.colors).not.toHaveProperty('notAToken')
  })

  it('skips invalid JSON instead of failing the whole scan', () => {
    write('broken.json', '{ not json')
    write('good.json', { colors: { accent: 'okhsl(0 50% 50%)' } })
    expect(loadUserThemes(dir).map((theme) => theme.document.name)).toEqual(['good'])
  })

  it('skips a file with no colors map', () => {
    write('empty.json', { name: 'empty' })
    expect(loadUserThemes(dir)).toEqual([])
  })

  it('strips a UTF-8 BOM', () => {
    write('bom.json', `\uFEFF${JSON.stringify({ colors: { accent: 'okhsl(0 50% 50%)' } })}`)
    expect(loadUserThemes(dir)).toHaveLength(1)
  })

  it('ignores non-json files and a missing directory', () => {
    write('readme.md', '# hi')
    expect(loadUserThemes(dir)).toEqual([])
    expect(loadUserThemes(join(dir, 'nope'))).toEqual([])
  })

  it('lists built-ins first, then user themes, skipping name collisions', () => {
    const user = [{ document: { name: 'dark', colors: { accent: '#fff' } }, sourcePath: '/x/dark.json' },
                  { document: { name: 'ocean', colors: { accent: '#00f' } }, sourcePath: '/x/ocean.json' }]
    expect(listThemes(user).map((choice) => choice.name)).toEqual(['dark', 'light', 'ocean'])
    expect(listThemes(user).find((choice) => choice.name === 'ocean')?.sourcePath).toBe('/x/ocean.json')
  })

  it('resolves a user theme by name and reports unknown names', () => {
    const user = [{ document: { name: 'ocean', colors: { accent: '#00f' } }, sourcePath: '/x/ocean.json' }]
    expect(resolveThemeByName('ocean', user)?.name).toBe('ocean')
    expect(resolveThemeByName('nope', user)).toBeUndefined()
  })

  it('honours the themes-dir env override', () => {
    expect(themesDir({ [THEMES_DIR_ENV]: '/custom/themes' } as NodeJS.ProcessEnv)).toBe('/custom/themes')
    expect(themesDir({} as NodeJS.ProcessEnv).endsWith(join('.dsh-neeko', 'themes'))).toBe(true)
  })
})

describe('pi theme compatibility', () => {
  it('defines every token pi defines', () => {
    // The parser must accept a full pi theme; a short token list would reject
    // valid files. 56 is pi's own count.
    expect(THEME_TOKENS).toHaveLength(56)
    expect(THEME_TOKENS).toContain('thinkingOff')
    expect(THEME_TOKENS).toContain('bashMode')
    expect(THEME_TOKENS).toContain('mdHeading')
  })

  it('ships built-ins carrying all of pi\'s tokens', () => {
    for (const theme of BUILTIN_THEMES) {
      expect(Object.keys(theme.colors)).toHaveLength(56)
    }
  })

  it('keeps pi token names that this TUI does not paint yet', () => {
    // Dropping them would make a pi theme silently lose those colors.
    const dark = findBuiltin('dark')!
    expect(dark.colors.syntaxKeyword).toBeDefined()
    expect(dark.colors.toolDiffAdded).toBeDefined()
  })

  it('scans pi\'s theme directory too, local first', () => {
    const paths = themeSearchPaths({} as NodeJS.ProcessEnv)
    expect(paths).toHaveLength(2)
    expect(paths[0]?.endsWith(join('.dsh-neeko', 'themes'))).toBe(true)
    expect(paths[1]?.endsWith(join('.pi', 'agent', 'themes'))).toBe(true)
  })

  it('honours PI_AGENT_DIR for pi\'s directory', () => {
    expect(piThemesDir({ PI_AGENT_DIR: '/custom/agent' } as NodeJS.ProcessEnv))
      .toBe(join('/custom/agent', 'themes'))
  })

  it('lets a local theme shadow a pi theme of the same name', () => {
    const local = { document: { name: 'shared', colors: { accent: '#111' } }, sourcePath: '/local/shared.json' }
    const fromPi = { document: { name: 'shared', colors: { accent: '#222' } }, sourcePath: '/pi/shared.json' }
    // loadUserThemes dedupes across dirs; simulate by calling listThemes with both.
    expect(listThemes([local, fromPi]).filter((choice) => choice.name === 'shared')).toHaveLength(1)
    expect(listThemes([local, fromPi]).find((choice) => choice.name === 'shared')?.sourcePath).toBe('/local/shared.json')
  })

  it('builds a Markdown theme from md* tokens', () => {
    const theme = resolveTheme({
      name: 'md',
      colors: { mdHeading: 'okhsl(83 88% 67%)', mdCode: 'okhsl(295 50% 67%)' },
    })
    const md = markdownThemeOf(theme)
    expect(md.heading?.('x')).toContain(theme.ansiOf('mdHeading'))
    expect(md.code?.('y')).toContain(theme.ansiOf('mdCode'))
    // An omitted md token inherits the base palette (overlay), not bare text.
    const dark = resolveTheme(findBuiltin('dark')!)
    expect(md.quote?.('z')).toContain(dark.ansiOf('mdQuote'))
  })

  it('leaves md tokens unstyled only for a hand-built sparse theme', () => {
    // `resolveTheme` always overlays, so this shape exists only via `new Theme`
    // — the guard keeps Markdown rendering safe there too.
    const theme = new Theme('raw', { name: 'raw', colors: { mdHeading: 'okhsl(83 88% 67%)' } })
    const md = markdownThemeOf(theme)
    expect(md.quote?.('z')).toBe('z')
  })
})
