import { describe, expect, it } from 'vitest'
import { resumeHint } from '../src/tui/resume-hint.ts'

/**
 * The "how do I get back in" line printed on quit.
 *
 * pi prints `To resume this session: pi --session <uuid>` at the end of
 * `shutdown()`. Ours has to name **dsh**, and name the whole invocation a user
 * can actually paste — dsh's TUI is reachable only through the profile, so
 * `dsh --session <id>` alone would boot the default profile and not our runner.
 */
const ID = '01a15350-e56a-77a9-8dfd-411652d4c087'

describe('resumeHint', () => {
  it('names the dsh invocation that actually reaches this TUI', () => {
    expect(resumeHint({ sessionId: ID })).toBe(
      `To resume this session: dsh --profile neeko --tui --session ${ID}`,
    )
  })

  it('returns nothing without a session id', () => {
    // Nothing to resume means nothing useful to print.
    expect(resumeHint({ sessionId: '' })).toBeUndefined()
    expect(resumeHint({ sessionId: '   ' })).toBeUndefined()
  })

  it('quotes an id that the shell would otherwise split', () => {
    expect(resumeHint({ sessionId: 'has space' })).toContain("'has space'")
  })

  it('keeps a plain uuid unquoted', () => {
    // A uuid is shell-safe; quoting it would make the hint harder to read for no
    // reason.
    expect(resumeHint({ sessionId: ID })).toContain(`--session ${ID}`)
  })
})
