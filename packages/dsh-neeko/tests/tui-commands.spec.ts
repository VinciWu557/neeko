import { describe, expect, it } from 'vitest'
import { buildCommands, runCommand, TUI_COMMANDS } from '../src/tui/commands.ts'

describe('runCommand', () => {
  it('routes every MVP command', () => {
    expect(runCommand('/help').kind).toBe('message')
    expect(runCommand('/clear')).toEqual({ kind: 'clear' })
    // `/model` opens a picker — it is not a read-only echo.
    expect(runCommand('/model')).toEqual({ kind: 'pick-model' })
    // …and `/model <id>` is a SWITCH, not a re-hint: the app validates the id
    // against the catalogue and applies it through `selectModel`.
    expect(runCommand('/model deepseek')).toEqual({ kind: 'use-model', id: 'deepseek' })
    expect(runCommand('/model  auto-step ')).toEqual({ kind: 'use-model', id: 'auto-step' })
    expect(runCommand('/theme')).toEqual({ kind: 'pick-theme' })
    // `/theme <name>` applies directly instead of opening the picker.
    expect(runCommand('/theme light')).toEqual({ kind: 'use-theme', name: 'light' })
    expect(runCommand('/theme  ocean ')).toEqual({ kind: 'use-theme', name: 'ocean' })
    expect(runCommand('/exit')).toEqual({ kind: 'exit' })
  })

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(runCommand('  /EXIT ')).toEqual({ kind: 'exit' })
  })

  it('unknown commands become an `unknown-command` variant, not a message', () => {
    // Regression: routing used to key off `text.startsWith('unknown command:')`,
    // so rewording the message silently stopped host commands from running.
    expect(runCommand('/frobnicate')).toEqual({
      kind: 'unknown-command',
      name: 'frobnicate',
      line: '/frobnicate',
    })
  })

  it('carries the raw line so the host dispatcher need not re-derive it', () => {
    const outcome = runCommand('  /goal edit x  ')
    expect(outcome).toMatchObject({ kind: 'unknown-command', line: '/goal edit x' })
  })

  it('non-slash lines are not commands', () => {
    expect(runCommand('plain text')).toEqual({ kind: 'not-a-command' })
    expect(runCommand('')).toEqual({ kind: 'not-a-command' })
  })

  it('/help lists every command with its description', () => {
    const outcome = runCommand('/help')
    expect(outcome.kind).toBe('message')
    if (outcome.kind === 'message') {
      for (const command of TUI_COMMANDS) {
        expect(outcome.text).toContain(`/${command.name} — ${command.description}`)
      }
    }
  })
})

describe('buildCommands — in-frame argument completions', () => {
  const sources = {
    listModels: () => [
      { value: 'auto-step', label: 'auto-step', description: 'magpie', provider: 'magpie', id: 'auto-step' },
      { value: 'deepseek', label: 'deepseek', description: 'opencode', provider: 'opencode', id: 'deepseek' },
    ],
    listThemes: () => ['dark', 'light'],
  }

  it('completes every model for a bare prefix', () => {
    const model = buildCommands(sources).find((command) => command.name === 'model')
    expect(model?.getArgumentCompletions?.('')).toHaveLength(2)
  })

  it('filters models by id, provider or label', () => {
    const model = buildCommands(sources).find((command) => command.name === 'model')
    expect(model?.getArgumentCompletions?.('auto')?.map((item) => item.value)).toEqual(['auto-step'])
    expect(model?.getArgumentCompletions?.('opencode')?.map((item) => item.value)).toEqual(['deepseek'])
  })

  it('returns null when nothing matches (menu closes instead of showing stale rows)', () => {
    const model = buildCommands(sources).find((command) => command.name === 'model')
    expect(model?.getArgumentCompletions?.('zzz')).toBeNull()
  })

  it('returns null when the source list is empty', () => {
    const model = buildCommands({ listModels: () => [], listThemes: () => [] })
      .find((command) => command.name === 'model')
    expect(model?.getArgumentCompletions?.('')).toBeNull()
  })

  it('completes theme names', () => {
    const theme = buildCommands(sources).find((command) => command.name === 'theme')
    expect(theme?.getArgumentCompletions?.('')?.map((item) => item.value)).toEqual(['dark', 'light'])
    expect(theme?.getArgumentCompletions?.('li')?.map((item) => item.value)).toEqual(['light'])
  })

  it('leaves commands without arguments uncompleted', () => {
    for (const name of ['help', 'clear', 'exit']) {
      const command = buildCommands(sources).find((candidate) => candidate.name === name)
      expect(command?.getArgumentCompletions).toBeUndefined()
    }
  })
})
