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

describe('thinking folds independently of tool output', () => {
  /**
   * pi binds these to two different keys and two different actions:
   *
   * | key | action | governs |
   * | --- | --- | --- |
   * | `ctrl+o` | `app.tools.expand` | tool output |
   * | `ctrl+t` | `app.thinking.toggle` | thinking blocks |
   *
   * They were one switch here, which forced a choice that has no good answer: make
   * `ctrl+o` also collapse reasoning and a user loses the answer along with the
   * logs, or leave it alone and `ctrl+t` does nothing. Two switches is the only
   * shape where both keys mean what their names say.
   *
   * The rows that *contain* thinking are the assistant ones — `thinking` is a field
   * on that row, not a row of its own — so the thinking switch must be consulted
   * per row kind, not applied as a second global broadcast.
   */
  const assistant = (thinking: string): TranscriptRow => ({
    kind: 'assistant', turn: 1, step: 1, attemptId: 'a', text: 'answer', thinking, done: true,
  })
  const tool: TranscriptRow = {
    kind: 'tool', taskId: 'c', name: 'bash', status: 'success', args: {}, result: 'out', turn: 1,
  }

  it('shows reasoning on the first toggle, without expanding tool output', () => {
    // Reasoning starts folded like everything else, so `ctrl+t` opens it. The
    // direction that matters: a user who wants to read the reasoning should not get
    // every tool result dumped into the transcript as a side effect.
    const fold = new TranscriptFold()
    const reasoning = assistant('why')
    expect(fold.isExpanded(reasoning)).toBe(false)
    fold.toggleThinking()
    expect(fold.isExpanded(reasoning)).toBe(true)
    expect(fold.isExpanded(tool)).toBe(false)
  })

  it('hides reasoning again on the second toggle', () => {
    const fold = new TranscriptFold()
    fold.toggleThinking()
    fold.toggleThinking()
    expect(fold.isExpanded(assistant('why'))).toBe(false)
    expect(fold.thinkingVisible).toBe(false)
  })

  it('neither key can undo the other', () => {
    // Orthogonal, exactly as pi keeps them: `ctrl+o` walks the expandable children
    // and an assistant message is not one of them, so it cannot open reasoning; and
    // `ctrl+t` only touches reasoning, so it cannot close tools.
    const fold = new TranscriptFold()
    fold.toggleAll() // ctrl+o → tools open
    expect(fold.isExpanded(tool)).toBe(true)
    expect(fold.isExpanded(assistant('why'))).toBe(false) // reasoning untouched
    fold.toggleThinking() // ctrl+t → reasoning open, tools still open
    expect(fold.isExpanded(assistant('why'))).toBe(true)
    expect(fold.isExpanded(tool)).toBe(true)
  })

  it('still folds an assistant row with no reasoning via ctrl+o', () => {
    // No thinking to show means the tools switch governs, or the message body would
    // be permanently folded with no key able to open it.
    const fold = new TranscriptFold()
    const plain = assistant('')
    expect(fold.isExpanded(plain)).toBe(false)
    fold.toggleAll()
    expect(fold.isExpanded(plain)).toBe(true)
  })

  it('still lets a click flip one row against both switches', () => {
    // Overrides are per row and invert whatever the global state says; two
    // switches must not break that.
    const fold = new TranscriptFold()
    fold.toggleThinking() // thinking now shown
    const row = assistant('why')
    expect(fold.isExpanded(row)).toBe(true)
    fold.toggle(row)
    expect(fold.isExpanded(row)).toBe(false)
  })
})
