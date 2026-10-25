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
