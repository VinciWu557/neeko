import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  contextWindowOf, dshVersion, gitBranch, packageAt, readContextPressure,
} from '../src/tui/host-facts.ts'
import type { HostContext } from '../src/tui/host-facts.ts'

/**
 * These readers are the silent-failure class: a wrong branch or `unknown`
 * version shows no error anywhere, so each is pinned against temp dirs and
 * fake contexts instead of a live `dsh` process.
 */

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'neeko-host-facts-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('gitBranch', () => {
  it('reads the branch of an ordinary repo', () => {
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    expect(gitBranch(dir)).toBe('main')
  })

  it('reads the branch of a LINKED WORKTREE (.git is a file, not a directory)', () => {
    // Regression: Neeko itself develops inside linked worktrees, and the old
    // `<cwd>/.git/HEAD` read silently found nothing there.
    const worktree = join(dir, 'wt')
    const admin = join(dir, 'admin', 'worktrees', 'wt')
    mkdirSync(worktree)
    mkdirSync(admin, { recursive: true })
    writeFileSync(join(worktree, '.git'), `gitdir: ${admin}\n`)
    writeFileSync(join(admin, 'HEAD'), 'ref: refs/heads/feature\n')
    expect(gitBranch(worktree)).toBe('feature')
  })

  it('resolves a relative gitdir pointer against the working directory', () => {
    const worktree = join(dir, 'wt')
    const admin = join(dir, 'admin')
    mkdirSync(worktree)
    mkdirSync(admin, { recursive: true })
    writeFileSync(join(worktree, '.git'), 'gitdir: ../admin\n')
    writeFileSync(join(admin, 'HEAD'), 'ref: refs/heads/relative\n')
    expect(gitBranch(worktree)).toBe('relative')
  })

  it('returns undefined on a detached HEAD (raw sha, no ref)', () => {
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, '.git', 'HEAD'), 'e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4\n')
    expect(gitBranch(dir)).toBeUndefined()
  })

  it('returns undefined outside a repository', () => {
    expect(gitBranch(dir)).toBeUndefined()
  })
})

describe('packageAt', () => {
  it('walks up to the package that owns the path', () => {
    mkdirSync(join(dir, 'a', 'b'), { recursive: true })
    writeFileSync(join(dir, 'a', 'b', 'file.ts'), '') // walks start from real paths
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root-pkg', version: '1.2.3' }))
    expect(packageAt(join(dir, 'a', 'b', 'file.ts'))).toEqual({ name: 'root-pkg', version: '1.2.3' })
  })

  it('returns undefined when no package.json owns the path', () => {
    mkdirSync(join(dir, 'nowhere'), { recursive: true })
    expect(packageAt(join(dir, 'nowhere', 'file.ts'))).toBeUndefined()
  })
})

describe('dshVersion', () => {
  it('prefers an explicit @deepseek-ai/dsh package along the candidates', () => {
    const dshDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'dist')
    mkdirSync(dshDir, { recursive: true })
    writeFileSync(join(dshDir, 'cli.js'), '') // packageAt walks from real paths
    writeFileSync(
      join(dshDir, '..', 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9' }),
    )
    expect(dshVersion([join(dshDir, 'cli.js')])).toBe('9.9.9')
  })

  it('falls back to this package\'s own version when no candidate matches', () => {
    const own = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(dshVersion([])).toBe(own.version)
  })

  it('ignores unrelated packages instead of reporting their version', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'not-dsh', version: '0.0.1' }))
    writeFileSync(join(dir, 'index.js'), '')
    expect(dshVersion([join(dir, 'index.js')])).not.toBe('0.0.1')
  })
})

describe('readContextPressure', () => {
  it('reads the projection DSH already computes', () => {
    const ctx: HostContext = {
      get: (key) => key === 'sessionProjections'
        ? { snapshot: () => ({ values: { contextPressure: { projectedTokens: 1234, contextWindow: 100_000 } } }) }
        : undefined,
    }
    expect(readContextPressure(ctx, {})).toEqual({ projectedTokens: 1234, contextWindow: 100_000 })
  })

  it('drops non-finite numbers instead of printing NaN', () => {
    const ctx: HostContext = {
      get: () => ({ snapshot: () => ({ values: { contextPressure: { projectedTokens: Number.NaN, pressureTokens: 42 } } }) }),
    }
    expect(readContextPressure(ctx, {})).toEqual({ pressureTokens: 42 })
  })

  it('returns undefined when the service is unmounted', () => {
    expect(readContextPressure({ get: () => undefined }, {})).toBeUndefined()
  })

  it('returns undefined when the cordis proxy throws (uninjected service)', () => {
    // The exact failure mode documented in quality-guidelines: `ctx.get` on an
    // un-provided service throws; `?.` would not have saved us.
    const ctx: HostContext = { get: () => { throw new Error('without inject') } }
    expect(readContextPressure(ctx, {})).toBeUndefined()
  })
})

describe('contextWindowOf', () => {
  const llm: HostContext = {
    get: () => ({ models: [{ provider: 'p', id: 'm', contextWindow: 200_000 }] }),
  }

  it('finds the window of the routed model', () => {
    expect(contextWindowOf(llm, 'p', 'm')).toBe(200_000)
  })

  it('returns undefined for an unrouted pair or a throwing service', () => {
    expect(contextWindowOf(llm, 'p', 'other')).toBeUndefined()
    expect(contextWindowOf({ get: () => { throw new Error('no llm') } }, 'p', 'm')).toBeUndefined()
  })
})
