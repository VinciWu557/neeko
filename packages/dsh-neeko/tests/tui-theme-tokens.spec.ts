import { describe, expect, it } from 'vitest'
import { THEME_TOKEN_SPECS, THEME_TOKENS } from '../src/tui/theme-tokens.ts'
import { resolveTheme, Theme } from '../src/tui/theme.ts'
import type { ThemeDocument } from '../src/tui/theme-data.ts'

/**
 * Token fallback: why a stock pi theme must load unchanged.
 *
 * pi's own `dark.json` and `light.json` omit four tokens — `scrollbarTrack`,
 * `scrollbarThumb`, `searchMatchBg`, `searchMatchText` — and pi's loader fills
 * them from a fallback chain. A loader without that chain rejects **every stock pi
 * theme** with:
 *
 *     Theme token scrollbarTrack has unresolved fallback muted
 *
 * That was this build's behaviour, and it is why a pi theme could not be dropped
 * in. The metadata below is transcribed from pi's `theme-tokens.js`; these tests
 * pin the chain rather than its transcription, so a wrong fallback fails here
 * instead of on a user's terminal.
 */

/** A minimal theme document: only the tokens a test cares about. */
function doc(colors: Record<string, string>): ThemeDocument {
  return { name: 'probe', appearance: 'dark', colors } as ThemeDocument
}

describe('THEME_TOKEN_SPECS — the declared vocabulary matches the token list', () => {
  it('describes every token in THEME_TOKENS', () => {
    // A token added to the word list without a spec would paint with no slot and
    // no fallback: the loader would silently treat it as a foreground colour.
    for (const token of THEME_TOKENS) {
      expect(THEME_TOKEN_SPECS[token], token).toBeDefined()
    }
  })

  it('declares no token that is not in the word list', () => {
    expect(Object.keys(THEME_TOKEN_SPECS).sort()).toEqual([...THEME_TOKENS].sort())
  })

  it('keeps every fallback inside one colour slot', () => {
    // pi throws at module load for a cross-slot fallback (`Theme token X has
    // fallback Y in a different color slot`). Catching it here means the error
    // names the token pair instead of only the first one it hits.
    for (const [token, spec] of Object.entries(THEME_TOKEN_SPECS)) {
      if (spec.fallback === undefined) continue
      const target = THEME_TOKEN_SPECS[spec.fallback]
      expect(target, `${token} -> ${spec.fallback}`).toBeDefined()
      expect(target.slot, `${token} -> ${spec.fallback}`).toBe(spec.slot)
    }
  })

  it('declares exactly pi\'s four fallbacks', () => {
    const withFallback = Object.entries(THEME_TOKEN_SPECS)
      .filter(([, spec]) => spec.fallback !== undefined)
      .map(([token, spec]) => `${token}->${spec.fallback}`)
      .sort()
    expect(withFallback).toEqual([
      'scrollbarThumb->text',
      'scrollbarTrack->muted',
      'searchMatchBg->selectedBg',
      'searchMatchText->text',
    ])
  })

  it('splits exactly seven tokens into the background slot', () => {
    // Background tokens are the ones `Box(1, 1, bg)` fills. A wrong slot makes
    // `bg()` emit a foreground escape, which renders as invisible text.
    const backgrounds = Object.entries(THEME_TOKEN_SPECS)
      .filter(([, spec]) => spec.slot === 'background')
      .map(([token]) => token)
      .sort()
    expect(backgrounds).toEqual([
      'customMessageBg',
      'searchMatchBg',
      'selectedBg',
      'toolErrorBg',
      'toolPendingBg',
      'toolSuccessBg',
      'userMessageBg',
    ])
  })
})

describe('resolveTheme — fills omitted tokens from the fallback chain', () => {
  it('loads a theme that omits the four fallback tokens', () => {
    // The exact shape pi ships: `scrollbarTrack` and friends are absent.
    //
    // The assertion is *equality with the fallback target*, not a specific colour,
    // because `resolveTheme` overlays the built-in palette first — so `muted`
    // resolves to the built-in's value, and the chain must carry that same value
    // into `scrollbarTrack`.
    const theme = resolveTheme(doc({}))
    expect(() => theme.fg('scrollbarTrack', 'x')).not.toThrow()
    expect(theme.fg('scrollbarTrack', 'x')).toBe(theme.fg('muted', 'x'))
    expect(theme.fg('scrollbarThumb', 'x')).toBe(theme.fg('text', 'x'))
    expect(theme.bg('searchMatchBg', 'x')).toBe(theme.bg('selectedBg', 'x'))
    expect(theme.fg('searchMatchText', 'x')).toBe(theme.fg('text', 'x'))
  })

  it('reads the fallback from the theme own value, not only the built-in', () => {
    // A user theme that sets `muted` must see its own colour flow into
    // `scrollbarTrack`; inheriting the built-in's would make the scrollbar the
    // one element that ignores the user's palette.
    const theme = resolveTheme(doc({ muted: '#111111' }))
    expect(theme.fg('scrollbarTrack', 'x')).toBe(theme.fg('muted', 'x'))
  })

  it('prefers an explicitly set token over its fallback', () => {
    const theme = resolveTheme(doc({ scrollbarTrack: '#ff0000' }))
    expect(theme.fg('scrollbarTrack', 'x')).not.toBe(theme.fg('muted', 'x'))
  })

  it('reports a fallback-filled token as present', () => {
    // `has()` answers "can this be painted", and a fallback-filled token can be.
    // Asking `document.colors` instead would report the scrollbar as absent on
    // every stock pi theme.
    expect(resolveTheme(doc({})).has('scrollbarTrack')).toBe(true)
  })

  it('leaves an undefined, fallback-less token unpaintable', () => {
    // The chain must not turn "not themed" into "themed with garbage". A raw
    // `Theme` (no overlay) over an empty document is the clean way to see that.
    const theme = new Theme('probe', doc({}))
    expect(theme.has('accent')).toBe(false)
  })
})

describe('Theme — a pi theme file own shape', () => {
  it('resolves a var reference before reading the colour', () => {
    // pi theme files are full of `accent: "violet"` + `vars: { violet: "#..." }`.
    const theme = resolveTheme({
      name: 'probe',
      appearance: 'dark',
      vars: { violet: '#aaaaaa' },
      colors: { accent: 'violet' },
    } as ThemeDocument)
    expect(theme.fg('accent', 'x')).toContain('170;170;170')
  })

  it('treats an empty string as the terminal default, not a parse failure', () => {
    // `text: ""` is pi's spelling of "whatever the terminal uses"; it must emit a
    // reset rather than throw.
    const theme = resolveTheme(doc({ text: '' }))
    expect(() => theme.fg('text', 'x')).not.toThrow()
  })

  it('survives a malformed colour by leaving that token unpainted', () => {
    // A user theme with one typo should not blank the whole palette — and should
    // not throw on startup either. Asserted on a raw `Theme`, because the overlay
    // would fill `accent` from the built-in and hide the behaviour.
    const theme = new Theme('probe', doc({ accent: 'not-a-colour', text: '#fff' }))
    expect(theme.has('accent')).toBe(false)
    expect(theme.has('text')).toBe(true)
  })
})

describe('Theme — background tokens paint backgrounds', () => {
  it('emits a background escape for a background token', () => {
    const theme = resolveTheme(doc({ toolPendingBg: '#262626' }))
    const painted = theme.bg('toolPendingBg', 'x')
    // `48;` is SGR background; `38;` would be foreground (invisible as a band).
    expect(painted).toContain('\x1b[48;')
  })

  it('emits a foreground escape for a foreground token', () => {
    const theme = resolveTheme(doc({ accent: '#7828c8' }))
    expect(theme.fg('accent', 'x')).toContain('\x1b[38;')
  })

  it('throws when asked for a background it does not have', () => {
    // A programming error, not user input: the caller asked for a band and there
    // is no colour to fill it with, which would silently render as no card.
    const theme = new Theme('probe', doc({}))
    expect(() => theme.bg('toolPendingBg', 'x')).toThrow()
  })
})
