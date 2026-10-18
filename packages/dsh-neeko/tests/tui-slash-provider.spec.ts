import { describe, expect, it } from 'vitest'
import { LiveSlashProvider, toSlashCommands } from '../src/tui/slash-provider.ts'
import type { TuiCommand } from '../src/tui/commands.ts'

/**
 * The liveness contract: pi-tui's provider snapshots the array it is given,
 * which silently freezes host-registered commands. The wrapper's whole job is
 * that a later catalogue change is visible on the next keystroke — pinned here
 * so nobody "optimises" it back into a constructor snapshot.
 */

const cmd = (name: string): TuiCommand => ({ name, description: `${name} command` })

async function menu(provider: LiveSlashProvider, line = '/'): Promise<string[]> {
  const suggestions = await provider.getSuggestions([line], 0, line.length, {
    signal: new AbortController().signal,
  })
  return (suggestions?.items ?? []).map((item) => item.value)
}

describe('LiveSlashProvider', () => {
  it('reads the catalogue on every request (late host commands appear)', async () => {
    let hostCommands: TuiCommand[] = [cmd('early')]
    const provider = new LiveSlashProvider('/base', () => [cmd('help'), ...hostCommands])

    expect(await menu(provider)).toEqual(['help', 'early'])
    // A plugin registered `late` after the provider was constructed…
    hostCommands = [cmd('late')]
    // …and the very next menu open shows it.
    expect(await menu(provider)).toEqual(['help', 'late'])
  })

  it('applies a completion against a freshly built provider (no stale state)', () => {
    const provider = new LiveSlashProvider('/base', () => [cmd('help')])
    const result = provider.applyCompletion(['/'], 0, 1, { value: 'help', label: 'help' }, '/')
    expect(result.lines[0]).toBe('/help ')
    expect(result.cursorCol).toBe('/help '.length)
  })

  it('forwards file-completion triggering to the inner provider', () => {
    const provider = new LiveSlashProvider('/base', () => [cmd('help')])
    // A slash line is a command, not a path — the inner decision must pass through.
    expect(provider.shouldTriggerFileCompletion(['/help'], 0, 6)).toBe(false)
  })

  it('passes argument completions through, keeping null as null', async () => {
    const withArgs: TuiCommand = {
      name: 'model',
      description: 'Choose',
      getArgumentCompletions: (prefix) => (prefix === '' ? [{ value: 'm1', label: 'm1' }] : null),
    }
    const provider = new LiveSlashProvider('/base', () => [withArgs])
    const hit = await provider.getSuggestions(['/model '], 0, 7, { signal: new AbortController().signal })
    expect(hit?.items.map((item) => item.value)).toEqual(['m1'])
    const miss = await provider.getSuggestions(['/model zzz'], 0, 10, { signal: new AbortController().signal })
    expect(miss).toBeNull()
  })
})

describe('toSlashCommands', () => {
  it('carries name, description and argument hint into pi-tui shape', () => {
    const [slash] = toSlashCommands([{ name: 'model', description: 'Choose', argumentHint: '<name>' }])
    expect(slash).toMatchObject({ name: 'model', description: 'Choose', argumentHint: '<name>' })
  })

  it('copies argument rows into a mutable array pi-tui accepts', () => {
    const rows = [{ value: 'm1', label: 'm1' }] as const // readonly, as TuiCommand declares
    const slash = toSlashCommands([{
      name: 'model',
      description: 'd',
      getArgumentCompletions: (prefix: string) => (prefix === '' ? rows : null),
    }])[0]!
    expect(slash.getArgumentCompletions?.('')).toEqual([{ value: 'm1', label: 'm1' }])
    expect(Array.isArray(slash.getArgumentCompletions?.(''))).toBe(true)
    expect(slash.getArgumentCompletions?.('zz')).toBeNull()
  })

  it('omits getArgumentCompletions entirely when the command has none', () => {
    const slash = toSlashCommands([cmd('help')])[0]!
    expect(slash).not.toHaveProperty('getArgumentCompletions')
  })
})
