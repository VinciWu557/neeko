import { describe, expect, it } from 'vitest'
import { TranscriptFold } from '../src/tui/fold.ts'
import type { TranscriptRow } from '../src/tui/transcript.ts'

/**
 * The transcript fold state.
 *
 * `ctrl+o` is a *global* switch in pi (`app.tools.expand` → `setToolsExpanded`
 * broadcasts to every expandable child), while a click flips one row. Both live
 * in one object so the two mechanisms cannot disagree about what is expanded.
 */

const row = (id: string): TranscriptRow => ({
  kind: 'tool', taskId: id, name: 'read', args: {}, status: 'success', result: 'x', turn: 1,
})

describe('TranscriptFold', () => {
  it('starts fully folded', () => {
    // Folded is the default: a transcript expanded by default is unreadable the
    // moment a tool returns a file.
    expect(new TranscriptFold().allExpanded).toBe(false)
    expect(new TranscriptFold().isExpanded(row('a'))).toBe(false)
  })

  it('expands every row on the first toggleAll', () => {
    const fold = new TranscriptFold()
    expect(fold.toggleAll()).toBe(true)
    expect(fold.isExpanded(row('a'))).toBe(true)
    expect(fold.isExpanded(row('b'))).toBe(true)
  })

  it('flips one row without touching the others', () => {
    const fold = new TranscriptFold()
    const target = row('a')
    fold.toggle(target)
    expect(fold.isExpanded(target)).toBe(true)
    expect(fold.isExpanded(row('b'))).toBe(false)
  })

  it('lets a click fold one row while everything is expanded', () => {
    const fold = new TranscriptFold()
    fold.toggleAll()
    const target = row('a')
    fold.toggle(target)
    expect(fold.isExpanded(target)).toBe(false)
    expect(fold.isExpanded(row('b'))).toBe(true)
  })

  it('drops per-row exceptions when toggleAll runs', () => {
    // pi broadcasts `setExpanded` to every child, so a click's override does not
    // survive the next `ctrl+o`. Keeping it would make the key unable to restore
    // a uniform state — and would silently keep rows open after "collapse all".
    const fold = new TranscriptFold()
    const clicked = row('a')
    fold.toggle(clicked)
    expect(fold.isExpanded(clicked)).toBe(true)

    fold.toggleAll()
    expect(fold.isExpanded(clicked)).toBe(true)
    fold.toggleAll()
    expect(fold.isExpanded(clicked)).toBe(false)
  })

  it('reports the state it just switched to', () => {
    const fold = new TranscriptFold()
    expect(fold.toggleAll()).toBe(true)
    expect(fold.toggleAll()).toBe(false)
  })
})
