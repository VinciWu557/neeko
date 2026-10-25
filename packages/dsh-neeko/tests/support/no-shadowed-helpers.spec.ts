import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A test file must not redefine a helper it already has at module scope.
 *
 * The same one-bit mistake has now shipped three times in
 * `tui-fullscreen.spec.ts`: a `describe` block declared its own `function mount()`
 * (or `function strip()`), shadowing the module-level one. Nothing fails — the
 * block simply stops exercising the fixture the rest of the file uses, and the
 * tests inside it quietly measure a different thing.
 *
 * TypeScript cannot catch it (`noUnusedLocals` sees a used binding, and the two
 * functions are independent), so the check lives here.
 *
 * This is deliberately a text scan rather than a real linter: adding eslint to a
 * package that ships no lint dependencies is a bigger commitment than this rule is
 * worth, and the rule only has to hold for test files.
 */

const TESTS_DIR = join(import.meta.dirname, '..')

/** Module-scope function names declared in one file. */
function moduleScopeFunctions(source: string): Set<string> {
  const names = new Set<string>()
  for (const match of source.matchAll(/^function\s+([A-Za-z0-9_]+)\s*[(<]/gmu)) {
    names.add(match[1] as string)
  }
  return names
}

/** Function names declared *inside* a block, i.e. indented. */
function nestedFunctions(source: string): string[] {
  return [...source.matchAll(/^ {2,}function\s+([A-Za-z0-9_]+)\s*[(<]/gmu)]
    .map((match) => match[1] as string)
}

describe('test helpers are not shadowed', () => {
  const files = readdirSync(TESTS_DIR)
    .filter((name) => name.endsWith('.spec.ts'))

  it.each(files)('%s declares no nested function that shadows a module-level one', (name) => {
    const source = readFileSync(join(TESTS_DIR, name), 'utf8')
    const outer = moduleScopeFunctions(source)
    const shadowed = nestedFunctions(source).filter((nested) => outer.has(nested))
    expect(shadowed).toEqual([])
  })
})
