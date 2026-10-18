import { describe, expect, it } from 'vitest'
import { failResume, planSession } from '../src/tui/session-plan.ts'

describe('planSession', () => {
  it('creates when no session was requested', () => {
    expect(planSession(undefined)).toEqual({ kind: 'create' })
  })

  it('creates when the requested id is blank', () => {
    for (const blank of ['', '   ']) {
      expect(planSession(blank)).toEqual({ kind: 'create' })
    }
  })

  it('resumes a non-empty id', () => {
    expect(planSession('session-abc')).toEqual({ kind: 'resume', sessionId: 'session-abc' })
  })

  it('trims surrounding whitespace from the id', () => {
    expect(planSession('  session-abc  ')).toEqual({ kind: 'resume', sessionId: 'session-abc' })
  })
})

describe('failResume', () => {
  it('downgrades to a fresh create carrying the requested id and reason', () => {
    const plan = failResume({ kind: 'resume', sessionId: 'session-abc' }, 'not found')
    expect(plan).toEqual({
      kind: 'create-after-failed-resume',
      requestedId: 'session-abc',
      reason: 'not found',
    })
  })
})
