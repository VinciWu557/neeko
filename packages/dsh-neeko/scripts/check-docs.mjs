#!/usr/bin/env node
/**
 * Fail when a JSDoc block describes something other than the code under it.
 *
 * ## Why this is a script and not a habit
 *
 * Two defects kept recurring while porting pi's components:
 *
 * 1. **Orphaned blocks.** Inserting a new function above an existing one, with a
 *    text replace anchored at the old comment, leaves the old `/** … *\/` with
 *    nothing to describe — and silently gives the *new* function the old one's
 *    documentation. It happened twice in one round (`thinking.ts`,
 *    `command-controller.ts`) and again three-at-once in `app.ts`.
 * 2. **`@param` drift.** A renamed parameter (`digits` → `digit`) leaves the
 *    document pointing at an argument that no longer exists. A reader following
 *    the doc names their variable wrong.
 *
 * Both are mechanical, so a script catches them better than review does. The
 * block-orphan check is exact; the `@param` check is deliberately conservative
 * (it only reports names that cannot be found in the signature at all) so it does
 * not fire on destructured or defaulted parameters.
 *
 * @module dsh-neeko/scripts/check-docs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const SOURCE_DIRS = ['src']

/** Every `.ts` file under the given directories. @param dir - a directory. @returns paths. */
function* walk(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* walk(path)
    else if (entry.endsWith('.ts')) yield path
  }
}

/**
 * The parameter names a signature declares.
 *
 * Splits on commas at nesting depth 0 so a default value containing a comma does
 * not split one parameter into two, then takes the leading identifier of each
 * segment. `rpcId = randomRpcId()` has no type annotation at all, which a
 * pattern keyed on `:` / `?` alone silently dropped.
 *
 * @param text - the full source.
 * @param openParen - index of the `(` that starts the parameter list.
 * @returns the declared names; empty when the list cannot be parsed.
 */
function parameterNames(text, openParen) {
  let parenDepth = 0
  let close = openParen
  for (; close < text.length; close += 1) {
    if (text[close] === '(') parenDepth += 1
    else if (text[close] === ')') {
      parenDepth -= 1
      if (parenDepth === 0) break
    }
  }
  const list = text.slice(openParen + 1, close)
  const names = new Set()
  let nesting = 0
  let segment = ''
  for (const char of `${list},`) {
    if (char === '(' || char === '[' || char === '{') nesting += 1
    if (char === ')' || char === ']' || char === '}') nesting -= 1
    if (char === ',' && nesting === 0) {
      // A destructured parameter (`{ a, b }`) yields no leading identifier and is
      // simply not compared.
      const name = /^\s*\.{0,3}\s*([A-Za-z_$][\w$]*)/u.exec(segment)
      if (name !== null) names.add(name[1])
      segment = ''
      continue
    }
    segment += char
  }
  return names
}

const problems = []
for (const dir of SOURCE_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const text = readFileSync(file, 'utf8')
    const shown = relative(ROOT, file)
    const lines = text.split('\n')

    for (let i = 0; i < lines.length - 1; i += 1) {
      if (lines[i].trim() === '*/' && lines[i + 1].trim().startsWith('/**')) {
        problems.push(`${shown}:${i + 1}  orphaned JSDoc (another /** follows immediately)`)
      }
    }

    const pattern = /\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/gu
    for (const match of text.matchAll(pattern)) {
      const documented = new Set([...match[1].matchAll(/@param\s+([A-Za-z_$][\w$]*)/gu)].map((m) => m[1]))
      if (documented.size === 0) continue
      const declared = parameterNames(text, match.index + match[0].length - 1)
      if (declared.size === 0) continue
      const missing = [...documented].filter((name) => !declared.has(name))
      if (missing.length > 0) {
        const line = text.slice(0, match.index).split('\n').length
        problems.push(`${shown}:${line}  ${match[2]}() documents ${missing.join(', ')} — not in the signature`)
      }
    }
  }
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`)
  process.exit(1)
}
process.stdout.write('check-docs: ok\n')
