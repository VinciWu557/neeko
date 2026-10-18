import { describe, expect, it } from 'vitest'
import { runCommand, suggestCommands, TUI_COMMANDS } from '../src/tui/commands.ts'

describe('runCommand', () => {
  it('routes the four MVP commands', () => {
    const ctx = { provider: 'deepseek', model: 'v4' }
    expect(runCommand('/help', ctx).kind).toBe('message')
    expect(runCommand('/clear', ctx)).toEqual({ kind: 'clear' })
    expect(runCommand('/model', ctx)).toEqual({ kind: 'message', text: 'model: deepseek/v4' })
    expect(runCommand('/exit', ctx)).toEqual({ kind: 'exit' })
  })

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(runCommand('  /EXIT ', { provider: 'p', model: 'm' })).toEqual({ kind: 'exit' })
  })

  it('unknown commands answer with a hint instead of being sent as a prompt', () => {
    const outcome = runCommand('/frobnicate', { provider: 'p', model: 'm' })
    expect(outcome).toMatchObject({ kind: 'message' })
    if (outcome.kind === 'message') expect(outcome.text).toContain('/help')
  })

  it('non-slash lines are not commands', () => {
    expect(runCommand('plain text', { provider: 'p', model: 'm' })).toEqual({ kind: 'not-a-command' })
    expect(runCommand('', { provider: 'p', model: 'm' })).toEqual({ kind: 'not-a-command' })
  })
})

describe('suggestCommands', () => {
  it('offers nothing for a non-slash draft', () => {
    expect(suggestCommands('hello')).toEqual([])
  })

  it('filters by prefix and stays in display order', () => {
    const names = suggestCommands('/e').map((command) => command.name)
    expect(names).toEqual(['exit'])
    expect(suggestCommands('/').map((command) => command.name)).toEqual(TUI_COMMANDS.map((command) => command.name))
  })
})
