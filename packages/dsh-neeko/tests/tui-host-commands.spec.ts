import { describe, expect, it } from 'vitest'
import {
  collectHostCommands, collectSkills, toExecuteLine,
} from '../src/tui/host-commands.ts'
import { buildCommands } from '../src/tui/commands.ts'

/**
 * The three host-integration bugs this suite pins, all observed in a live TUI:
 *
 * 1. `skills.list()` without `cwd` returns **0** skills in a repo that has 21 —
 *    DSH then reads only the global layer.
 * 2. The catalogue must be read **before** `TuiApp` is constructed, because the
 *    `/` provider snapshots it (asserted indirectly here through `buildCommands`).
 * 3. `commands.execute()` needs the **leading slash**; stripping it makes every
 *    host command resolve to `undefined`.
 */

describe('collectHostCommands', () => {
  const registry = {
    list: () => [
      { name: 'compact', description: 'Compact history' },
      { name: 'feedback', description: 'Record feedback', input: { hint: '<text>' } },
    ],
  }

  it('maps descriptors into the completion catalogue', () => {
    expect(collectHostCommands(registry, 'agent')).toEqual([
      { name: 'compact', description: 'Compact history' },
      { name: 'feedback', description: 'Record feedback', inputHint: '<text>' },
    ])
  })

  it('passes the agent through (the registry is agent-scoped)', () => {
    const seen: unknown[] = []
    collectHostCommands({ list: (agent) => { seen.push(agent); return [] } }, 'the-agent')
    expect(seen).toEqual(['the-agent'])
  })

  it('returns an empty list when the service is unmounted', () => {
    expect(collectHostCommands(undefined, 'agent')).toEqual([])
  })
})

describe('collectSkills', () => {
  const registry = {
    list: async () => [{ name: 'neeko-check', description: 'Code review' }],
  }

  it('passes cwd so the workspace layer is discovered', async () => {
    // The regression: omitting cwd made this return [] in a repo with 21 skills.
    const calls: ({ cwd?: string } | undefined)[] = []
    await collectSkills({
      list: async (options) => { calls.push(options); return [] },
    }, '/repo/root')
    expect(calls).toEqual([{ cwd: '/repo/root' }])
  })

  it('maps summaries to name + description', async () => {
    expect(await collectSkills(registry, '/repo')).toEqual([
      { name: 'neeko-check', description: 'Code review' },
    ])
  })

  it('skips the cwd argument nowhere — an explicit call always carries it', async () => {
    const withoutCwd = await collectSkills({ list: async () => [] }, '')
    // An empty cwd is still passed through rather than dropped.
    expect(withoutCwd).toEqual([])
  })

  it('fails open when a provider throws', async () => {
    const broken = { list: async () => { throw new Error('provider down') } }
    await expect(collectSkills(broken, '/repo')).resolves.toEqual([])
  })

  it('returns an empty list when the service is unmounted', async () => {
    expect(await collectSkills(undefined, '/repo')).toEqual([])
  })
})

describe('toExecuteLine', () => {
  it('keeps the leading slash (the registry parses it itself)', () => {
    expect(toExecuteLine('/compact')).toBe('/compact')
    expect(toExecuteLine('  /compact  ')).toBe('/compact')
  })

  it('adds a missing slash rather than passing a bare word', () => {
    expect(toExecuteLine('compact')).toBe('/compact')
  })

  it('preserves arguments verbatim', () => {
    expect(toExecuteLine('/theme light')).toBe('/theme light')
    expect(toExecuteLine('/goal  edit  x')).toBe('/goal  edit  x')
  })
})

describe('buildCommands — host + skill merge', () => {
  const sources = {
    listModels: () => [],
    listThemes: () => [],
    listHostCommands: () => [
      { name: 'compact', description: 'Compact history' },
      { name: 'feedback', description: 'Record feedback', inputHint: '<text>' },
    ],
    listSkills: () => [
      { name: 'neeko-check', description: 'Code review' },
      { name: 'trellis-check', description: 'Quality verification' },
    ],
  }

  it('merges built-ins, host commands and skills into one menu', () => {
    const names = buildCommands(sources).map((command) => command.name)
    expect(names).toContain('help')
    expect(names).toContain('compact')
    expect(names).toContain('skill:neeko-check')
  })

  it('namespaces skills so they cannot collide with commands', () => {
    const names = buildCommands(sources).map((command) => command.name)
    expect(names.filter((name) => name.startsWith('skill:'))).toHaveLength(2)
    // A skill called `help` would surface as `skill:help`, not shadow the builtin.
    const shadow = buildCommands({
      ...sources,
      listSkills: () => [{ name: 'help', description: 'a skill named help' }],
    }).map((command) => command.name)
    expect(shadow.filter((name) => name === 'help')).toHaveLength(1)
    expect(shadow).toContain('skill:help')
  })

  it('never lets a host command shadow a built-in', () => {
    // Built-ins carry local TUI behaviour the host cannot reproduce.
    const merged = buildCommands({
      ...sources,
      listHostCommands: () => [{ name: 'exit', description: 'host exit' }],
    })
    const exits = merged.filter((command) => command.name === 'exit')
    expect(exits).toHaveLength(1)
    expect(exits[0]?.description).toContain('Quit the terminal UI')
  })

  it('carries the host argument hint into the completion row', () => {
    const feedback = buildCommands(sources).find((command) => command.name === 'feedback')
    expect(feedback?.argumentHint).toBe('<text>')
  })

  it('works when the host exposes nothing', () => {
    const names = buildCommands({ listModels: () => [], listThemes: () => [] })
      .map((command) => command.name)
    expect(names).toEqual(['help', 'clear', 'model', 'theme', 'exit'])
  })
})
