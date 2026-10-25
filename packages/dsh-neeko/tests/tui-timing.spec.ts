import { describe, expect, it } from 'vitest'
import {
  activeMs, emptyTiming, formatDuration, onChunk, onGenerationEnd, onGenerationStart,
  onToolEnd, onToolStart, onUserMessage, spanMs, timingLine,
} from '../src/tui/timing.ts'

/**
 * Timing arithmetic, transcribed from `pi-timing`. The invariants that matter:
 *
 * - generation is measured start→end of an attempt, not of a turn;
 * - **parallel tools count once** (a wall-clock run, not a per-tool sum) —
 *   summing would inflate tool time by the parallelism factor;
 * - `active = Σgen + Σtool`, so idle gaps are excluded from `active` while
 *   still counting in `span`.
 */

describe('formatDuration', () => {
  it('keeps one decimal under ten seconds', () => {
    expect(formatDuration(1200)).toBe('1.2s')
    expect(formatDuration(9200)).toBe('9.2s')
  })

  it('rounds to whole seconds under a minute', () => {
    expect(formatDuration(12_000)).toBe('12s')
    expect(formatDuration(59_400)).toBe('59s')
  })

  it('switches to m/s and h/m', () => {
    expect(formatDuration(184_000)).toBe('3m04s')
    expect(formatDuration(3_720_000)).toBe('1h02m')
  })

  it('never prints negatives or NaN', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(-500)).toBe('0s')
    expect(formatDuration(Number.NaN)).toBe('0s')
  })
})

describe('generation timing', () => {
  it('measures an attempt start→end and ignores idle before it', () => {
    const s = emptyTiming()
    onUserMessage(s, 1_000)
    onGenerationStart(s, 1_500)
    onChunk(s, 1_600, 'text')
    onGenerationEnd(s, 4_500)
    expect(s.genMs).toBe(3_000)
  })

  it('re-anchors thinking at each attempt start (no carry-over)', () => {
    const s = emptyTiming()
    onGenerationStart(s, 1_000)
    onChunk(s, 1_800, 'reasoning')
    onGenerationEnd(s, 5_000)
    // A new attempt must not inherit the previous attempt's reasoning stamp,
    // or its `think≈` figure would be measured from the wrong origin.
    onGenerationStart(s, 9_000)
    expect(s.thinkingAt).toBeUndefined()
    expect(s.firstTextAt).toBeUndefined()
  })

  it('ignores chunks and ends arriving without a start', () => {
    const s = emptyTiming()
    onChunk(s, 100, 'text')
    onGenerationEnd(s, 200)
    expect(s.genMs).toBe(0)
    expect(s.genStart).toBeUndefined()
  })

  it('accumulates across attempts', () => {
    const s = emptyTiming()
    onGenerationStart(s, 0)
    onGenerationEnd(s, 1_000)
    onGenerationStart(s, 5_000)
    onGenerationEnd(s, 7_000)
    expect(s.genMs).toBe(3_000)
  })
})

describe('tool timing', () => {
  it('counts a contiguous run once (parallel tools share a wall clock)', () => {
    const s = emptyTiming()
    onUserMessage(s, 0)
    // Three tools overlap: 1000 → 3000 is one 2s run, not 3×2s.
    onToolStart(s, 1_000)
    onToolStart(s, 1_100)
    onToolStart(s, 1_200)
    onToolEnd(s, 2_900)
    onToolEnd(s, 2_950)
    onToolEnd(s, 3_000)
    expect(s.toolMs).toBe(2_000)
  })

  it('sums separate runs', () => {
    const s = emptyTiming()
    onToolStart(s, 0)
    onToolEnd(s, 1_000)
    onToolStart(s, 5_000)
    onToolEnd(s, 5_500)
    expect(s.toolMs).toBe(1_500)
  })

  it('does not close the run while another tool is still active', () => {
    const s = emptyTiming()
    onToolStart(s, 0)
    onToolStart(s, 500)
    onToolEnd(s, 1_000)
    expect(s.toolRunStart).toBe(0)
    expect(s.toolMs).toBe(0)
    onToolEnd(s, 2_000)
    expect(s.toolMs).toBe(2_000)
  })
})

describe('span vs active', () => {
  it('excludes idle gaps from active but not from span', () => {
    const s = emptyTiming()
    onUserMessage(s, 0)
    onGenerationStart(s, 1_000)
    onGenerationEnd(s, 3_000) // 2s gen
    // Long idle: user reads for 10s.
    onToolStart(s, 13_000)
    onToolEnd(s, 14_000) // 1s tool

    expect(activeMs(s, 14_000)).toBe(3_000) // 2s gen + 1s tool
    expect(spanMs(s, 14_000)).toBe(14_000)
  })

  it('includes in-flight generation and tool runs', () => {
    const s = emptyTiming()
    onUserMessage(s, 0)
    onGenerationStart(s, 1_000)
    onToolStart(s, 2_000)
    // At t=3000: gen has been running 2s (since 1000) and the tool run 1s
    // (since 2000) — both in flight, so both count.
    expect(activeMs(s, 3_000)).toBe(3_000)
  })

  it('reports zero span before any user message', () => {
    expect(spanMs(emptyTiming(), 5_000)).toBe(0)
    expect(activeMs(emptyTiming(), 5_000)).toBe(0)
  })
})

describe('timingLine', () => {
  it('is empty before the first turn', () => {
    expect(timingLine(emptyTiming(), 1_000)).toBe('')
  })

  it('shows span, active and turn count', () => {
    const s = emptyTiming()
    onUserMessage(s, 0)
    onGenerationStart(s, 1_000)
    onGenerationEnd(s, 4_000)
    expect(timingLine(s, 4_000)).toBe('⏱ 4.0s · active 3.0s · 1 turn')
  })

  it('pluralises turns', () => {
    const s = emptyTiming()
    onUserMessage(s, 0)
    onUserMessage(s, 1_000)
    expect(timingLine(s, 2_000)).toContain('2 turns')
  })

  it('appends the live sub-state while generating', () => {
    const s = emptyTiming()
    onUserMessage(s, 0)
    onGenerationStart(s, 1_000)
    onChunk(s, 1_400, 'reasoning')
    const line = timingLine(s, 2_000)
    expect(line).toContain('generating 1.0s')
    expect(line).toContain('think≈400ms'.replace('400ms', '0.4s'))
  })

  it('appends the tool-run timer while tools are active', () => {
    const s = emptyTiming()
    onUserMessage(s, 0)
    onToolStart(s, 1_000)
    expect(timingLine(s, 3_000)).toContain('tool running 2.0s')
  })

  it('can suppress live detail', () => {
    const s = emptyTiming()
    onUserMessage(s, 0)
    onGenerationStart(s, 1_000)
    expect(timingLine(s, 2_000, { live: false })).not.toContain('generating')
  })
})
