import { describe, expect, test } from 'claude-code/testing'

import { decodeLoopState, loopSegment, loopStatePath, MAX_STATE_BYTES, type LoopState } from '../src/loop.ts'
import type { Segment, Tone } from '../src/render.ts'

const FULL = '\u25b0'
const EMPTY = '\u25b1'
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const NOW = Date.parse('2026-10-19T12:00:00Z')

const text = (seg: Segment | null) => (seg ? seg.map(s => s.text).join('') : null)

// The spans drawn as cells, as [glyphs, tone] pairs.
function cells(seg: Segment | null): [string, Tone][] {
  if (!seg) return []
  return seg.filter(s => /^[\u25b0\u25b1]+$/.test(s.text)).map(s => [s.text, s.tone])
}

// Decodes a state file built from `fields`, failing the test if it is rejected.
function state(fields: Record<string, unknown>): LoopState {
  const decoded = decodeLoopState(JSON.stringify(fields))
  if (decoded === null) throw new Error('state was rejected: ' + JSON.stringify(fields))
  return decoded
}

const FIVE = [
  { n: 41, status: 'done' },
  { n: 42, status: 'blocked' },
  { n: 43, status: 'skipped' },
  { n: 44, status: 'pending' },
  { n: 45, status: 'pending' },
]

describe('loopStatePath', () => {
  test('names state.json in the orc-loop folder', () => {
    expect(loopStatePath('/repo/.git')).toBe('/repo/.git/orc-loop/state.json')
  })
})

describe('decodeLoopState', () => {
  test('rejects text that is not JSON', () => {
    expect(decodeLoopState('{"phase": "build"')).toBe(null)
  })

  test('rejects a document that is not an object', () => {
    expect(decodeLoopState('[]')).toBe(null)
    expect(decodeLoopState('null')).toBe(null)
  })

  test('rejects a file over the size cap', () => {
    const big = JSON.stringify({ phase: 'build', pad: 'x'.repeat(MAX_STATE_BYTES) })
    expect(decodeLoopState(big)).toBe(null)
  })

  test('accepts a file exactly at the size cap', () => {
    const pad = 'x'.repeat(MAX_STATE_BYTES - JSON.stringify({ phase: 'build', pad: '' }).length)
    const atCap = JSON.stringify({ phase: 'build', pad })
    expect(new TextEncoder().encode(atCap).length).toBe(MAX_STATE_BYTES)
    expect(decodeLoopState(atCap)).not.toBe(null)
  })

  test('rejects a missing or non-string phase', () => {
    expect(decodeLoopState('{"issues": []}')).toBe(null)
    expect(decodeLoopState('{"phase": 3}')).toBe(null)
  })

  test('rejects issues that are not an array of objects', () => {
    expect(decodeLoopState('{"phase": "build", "issues": {}}')).toBe(null)
    expect(decodeLoopState('{"phase": "build", "issues": [7]}')).toBe(null)
    expect(decodeLoopState('{"phase": "build", "issues": [null]}')).toBe(null)
  })

  test('rejects more issues than the line can draw', () => {
    const issues = Array.from({ length: 51 }, (_, i) => ({ n: i + 1, status: 'pending' }))
    expect(decodeLoopState(JSON.stringify({ phase: 'build', issues }))).toBe(null)
  })

  test('accepts as many issues as the line can draw', () => {
    const issues = Array.from({ length: 50 }, (_, i) => ({ n: i + 1, status: 'pending' }))
    expect(state({ phase: 'build', issues }).issues.length).toBe(50)
  })

  test('tolerates missing optional fields', () => {
    expect(state({ phase: 'build' })).toEqual({
      phase: 'build',
      issues: [],
      inFlight: null,
      reviewRound: 0,
      progressOn: false,
    })
  })

  test('reads the fields orc-loop writes and ignores the rest', () => {
    const decoded = state({
      batchId: '2026-10-06T10-15',
      phase: 'review',
      issues: [{ n: 41, title: 'a title', status: 'done', commits: [] }],
      inFlight: 'review-2',
      reviewRound: 2,
      progress: { on: true },
    })
    expect(decoded).toEqual({
      phase: 'review',
      issues: [{ n: 41, status: 'done' }],
      inFlight: null,
      reviewRound: 2,
      progressOn: true,
    })
  })

  test('reads a numeric or "#44" inFlight as the issue number', () => {
    expect(state({ phase: 'build', inFlight: 44 }).inFlight).toBe(44)
    expect(state({ phase: 'build', inFlight: '#44' }).inFlight).toBe(44)
    expect(state({ phase: 'build', inFlight: '44' }).inFlight).toBe(44)
  })

  test('drops an inFlight that is not an issue number', () => {
    for (const inFlight of ['triage', '#4\u202e4', '#', 0, -3, 4.5, 1e300, true]) {
      expect(state({ phase: 'build', inFlight }).inFlight).toBe(null)
    }
  })

  test('drops a string inFlight longer than nine digits', () => {
    expect(state({ phase: 'build', inFlight: '1234567890' }).inFlight).toBe(null)
    expect(state({ phase: 'build', inFlight: '#1234567890' }).inFlight).toBe(null)
  })

  test('maps an unknown phase or status to other', () => {
    const decoded = state({ phase: 'launch', issues: [{ n: 1, status: 'weird' }, { n: 2 }] })
    expect(decoded.phase).toBe('other')
    expect(decoded.issues.map(i => i.status)).toEqual(['other', 'other'])
  })

  test('treats a review round that is not a small whole number as none', () => {
    for (const reviewRound of [-1, 1.5, 1e300, '2', null]) {
      expect(state({ phase: 'review', reviewRound }).reviewRound).toBe(0)
    }
  })
})

describe('loopSegment', () => {
  const fresh = NOW - MINUTE

  test('hides when the state is missing or unreadable', () => {
    expect(loopSegment(null, fresh, NOW)).toBe(null)
  })

  test('hides when orc-loop draws its own bar through paceline', () => {
    expect(loopSegment(state({ phase: 'build', issues: FIVE, progress: { on: true } }), fresh, NOW)).toBe(null)
    expect(text(loopSegment(state({ phase: 'build', issues: FIVE, progress: { on: false } }), fresh, NOW))).toBe(
      'loop ' + FULL.repeat(3) + EMPTY.repeat(2) + ' 3/5',
    )
  })

  test('hides when progress.on is any truthy value', () => {
    expect(loopSegment(state({ phase: 'build', issues: FIVE, progress: { on: 1 } }), fresh, NOW)).toBe(null)
  })

  test('draws neighboring cells of the same tone as one span', () => {
    const issues = [
      { n: 1, status: 'done' },
      { n: 2, status: 'done' },
      { n: 3, status: 'pending' },
    ]
    expect(cells(loopSegment(state({ phase: 'build', issues }), fresh, NOW))).toEqual([
      [FULL + FULL, 'green'],
      [EMPTY, 'dim'],
    ])
  })

  test('gives an unknown phase the default label', () => {
    const seg = loopSegment(state({ phase: 'launch', issues: FIVE, inFlight: 44 }), fresh, NOW)
    expect(text(seg)).toBe('loop ' + FULL.repeat(4) + EMPTY + ' #44 3/5')
  })

  test('draws one cell per issue, colored by status, with the in-flight issue in cyan', () => {
    const seg = loopSegment(state({ phase: 'build', issues: FIVE, inFlight: 44 }), fresh, NOW)
    expect(cells(seg)).toEqual([
      [FULL, 'green'],
      [FULL, 'red'],
      [FULL, 'dim'],
      [FULL, 'cyan'],
      [EMPTY, 'dim'],
    ])
  })

  test('labels a build with the in-flight issue and the settled count', () => {
    const want = 'loop ' + FULL.repeat(4) + EMPTY + ' #44 3/5'
    expect(text(loopSegment(state({ phase: 'build', issues: FIVE, inFlight: 44 }), fresh, NOW))).toBe(want)
    expect(text(loopSegment(state({ phase: 'build', issues: FIVE, inFlight: '#44' }), fresh, NOW))).toBe(want)
  })

  test('leaves out the issue number when nothing is in flight', () => {
    const seg = loopSegment(state({ phase: 'triage', issues: FIVE, inFlight: 'triage' }), fresh, NOW)
    expect(text(seg)).toBe('loop ' + FULL.repeat(3) + EMPTY.repeat(2) + ' 3/5')
  })

  test('counts every status but pending as settled', () => {
    const issues = [
      { n: 1, status: 'done' },
      { n: 2, status: 'other-status' },
      { n: 3, status: 'pending' },
    ]
    expect(text(loopSegment(state({ phase: 'build', issues }), fresh, NOW))).toBe(
      'loop ' + FULL + EMPTY.repeat(2) + ' 2/3',
    )
  })

  test('labels a halted run in red', () => {
    const seg = loopSegment(state({ phase: 'halted', issues: FIVE }), fresh, NOW)
    expect(text(seg)).toBe('loop ' + FULL.repeat(3) + EMPTY.repeat(2) + ' halted')
    expect(seg?.at(-1)).toEqual({ text: 'halted', tone: 'red' })
  })

  test('labels a finished run with a green check', () => {
    const seg = loopSegment(state({ phase: 'done', issues: FIVE }), fresh, NOW)
    expect(text(seg)).toBe('loop ' + FULL.repeat(3) + EMPTY.repeat(2) + ' \u2713 done')
    expect(seg?.at(-1)).toEqual({ text: '\u2713 done', tone: 'green' })
  })

  test('labels the plan phase as planning', () => {
    expect(text(loopSegment(state({ phase: 'plan', issues: FIVE }), fresh, NOW))).toBe(
      'loop ' + FULL.repeat(3) + EMPTY.repeat(2) + ' planning',
    )
  })

  test('labels the review phase with its round, starting at 1', () => {
    const done = FIVE.map(i => ({ ...i, status: 'done' }))
    expect(text(loopSegment(state({ phase: 'review', issues: done, reviewRound: 0 }), fresh, NOW))).toBe(
      'loop ' + FULL.repeat(5) + ' review 1/3',
    )
    expect(text(loopSegment(state({ phase: 'review', issues: done, reviewRound: 2 }), fresh, NOW))).toBe(
      'loop ' + FULL.repeat(5) + ' review 2/3',
    )
  })

  test('leaves out the cells when there are no issues', () => {
    expect(text(loopSegment(state({ phase: 'plan' }), fresh, NOW))).toBe('loop planning')
  })

  test('shows a finished run for 30 minutes, then hides it', () => {
    const done = state({ phase: 'done', issues: FIVE })
    expect(loopSegment(done, NOW - 30 * MINUTE, NOW)).not.toBe(null)
    expect(loopSegment(done, NOW - 30 * MINUTE - 1, NOW)).toBe(null)
  })

  test('marks build, review, and plan as paused after 6 hours without a write', () => {
    for (const phase of ['build', 'review', 'plan']) {
      const st = state({ phase, issues: FIVE, inFlight: 44 })
      expect(text(loopSegment(st, NOW - 6 * HOUR, NOW))?.endsWith(' (paused)')).toBe(false)
      const seg = loopSegment(st, NOW - 6 * HOUR - 1, NOW)
      expect(seg?.at(-1)).toEqual({ text: ' (paused)', tone: 'dim' })
    }
  })

  test('never marks other phases as paused', () => {
    for (const phase of ['halted', 'triage', 'fallow', 'comments']) {
      const seg = loopSegment(state({ phase, issues: FIVE }), NOW - 24 * HOUR, NOW)
      expect(text(seg)?.endsWith(' (paused)')).toBe(false)
    }
  })
})
