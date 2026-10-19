import { describe, expect, test } from 'claude-code/testing'

import {
  batchSegment,
  countIssueRefs,
  MAX_LEDGER_BYTES,
  parseLedger,
  refSha,
  splitCommitMessages,
  type BatchState,
  type LedgerEntry,
} from '../src/batch.ts'
import type { Segment } from '../src/render.ts'

const BASE = '6e333d93fd9ea3c0fe09a8edc0c4ced7748071cf'
const OTHER_BASE = '0d3e4b7674b73144d0803536551c83221612359a'
const HEAD_A = '941a425efb86dc5cc3a59082283721566108dbc8'
const HEAD_B = 'c69f8f68635e733b01b54cc7316e3248465374f3'
const SEP = ' \u00b7 '

const text = (seg: Segment | null) => (seg ? seg.map(s => s.text).join('') : null)

// A ledger line as deep-review writes it, with `fields` laid over the defaults.
function line(fields: Record<string, unknown>): string {
  return JSON.stringify({
    at: '2026-10-06T20:10:38.275Z',
    base: BASE,
    head: HEAD_A,
    branch: 'dev',
    dirty: false,
    verdict: 'ready',
    blockers: 0,
    warnings: 0,
    nits: 3,
    report: 'tmp/reviews/2026-10-06-dev.md',
    ...fields,
  })
}

function review(fields: Partial<LedgerEntry> = {}): LedgerEntry {
  return { head: HEAD_A, verdict: 'ready', blockers: 0, warnings: 0, ...fields }
}

function batch(fields: Partial<BatchState> = {}): BatchState {
  return { commits: 4, issues: 7, reviews: [review()], sinceLastReview: 0, ...fields }
}

describe('parseLedger', () => {
  test('parses the ledger into entries in file order', () => {
    const ledger = [line({ head: HEAD_A, verdict: 'fixes', warnings: 5 }), line({ head: HEAD_B })].join('\n') + '\n'
    expect(parseLedger(ledger, BASE)).toEqual([
      { head: HEAD_A, verdict: 'other', blockers: 0, warnings: 5 },
      { head: HEAD_B, verdict: 'ready', blockers: 0, warnings: 0 },
    ])
  })

  test('parses the ledger keeping only entries whose base matches', () => {
    const ledger = [line({ base: OTHER_BASE }), line({ head: HEAD_B }), line({ base: undefined })].join('\n')
    expect(parseLedger(ledger, BASE)?.map(e => e.head)).toEqual([HEAD_B])
  })

  test('parses the ledger keeping only entries whose head is a string', () => {
    const ledger = [line({ head: 7 }), line({ head: null }), line({ head: undefined }), line({ head: HEAD_B })].join(
      '\n',
    )
    expect(parseLedger(ledger, BASE)?.map(e => e.head)).toEqual([HEAD_B])
  })

  test('parses the ledger skipping torn and malformed lines without throwing', () => {
    const torn = line({ head: HEAD_B }).slice(0, 40)
    const ledger = [line({}), torn, 'not json', '[1, 2]', 'null', '"text"', '', '   ', line({ head: HEAD_B })].join('\n')
    expect(parseLedger(ledger, BASE)?.map(e => e.head)).toEqual([HEAD_A, HEAD_B])
  })

  test('parses the ledger with CRLF line endings', () => {
    expect(parseLedger(line({}) + '\r\n' + line({ head: HEAD_B }) + '\r\n', BASE)?.length).toBe(2)
  })

  test('parses the ledger of an empty file as no entries', () => {
    expect(parseLedger('', BASE)).toEqual([])
  })

  test('parses the ledger as null when it is over the size cap', () => {
    const big = line({}) + '\n' + 'x'.repeat(MAX_LEDGER_BYTES)
    expect(parseLedger(big, BASE)).toBe(null)
  })

  test('parses the ledger at exactly the size cap', () => {
    const first = line({}) + '\n'
    const atCap = first + 'x'.repeat(MAX_LEDGER_BYTES - first.length)
    expect(new TextEncoder().encode(atCap).length).toBe(MAX_LEDGER_BYTES)
    expect(parseLedger(atCap, BASE)?.length).toBe(1)
  })

  test('parses the ledger reducing the verdict to ready, incomplete, or other', () => {
    const verdicts = ['ready', 'incomplete', 'not-ready', 'fixes', 'READY', '', 3, null, undefined]
    const ledger = verdicts.map(verdict => line({ verdict })).join('\n')
    expect(parseLedger(ledger, BASE)?.map(e => e.verdict)).toEqual([
      'ready',
      'incomplete',
      'other',
      'other',
      'other',
      'other',
      'other',
      'other',
      'other',
    ])
  })

  test('parses the ledger treating a count that is not a whole number as 0', () => {
    for (const bad of [-1, 1.5, '3', null, undefined, true, Number.MAX_VALUE]) {
      const [entry] = parseLedger(line({ blockers: bad, warnings: bad }), BASE) ?? []
      expect([entry.blockers, entry.warnings]).toEqual([0, 0])
    }
  })

  test('parses the ledger capping a large count', () => {
    const [entry] = parseLedger(line({ blockers: 123456, warnings: 1000 }), BASE) ?? []
    expect([entry.blockers, entry.warnings]).toEqual([999, 999])
  })

  test('parses the ledger keeping a head that is not a commit id as null', () => {
    const heads = ['--output=/tmp/x', 'HEAD~1', '', 'main', HEAD_A.slice(0, 7), HEAD_A.toUpperCase()]
    const ledger = heads.map(head => line({ head })).join('\n')
    expect(parseLedger(ledger, BASE)?.map(e => e.head)).toEqual([
      null,
      null,
      null,
      null,
      HEAD_A.slice(0, 7),
      HEAD_A.toUpperCase(),
    ])
  })
})

describe('splitCommitMessages', () => {
  test('splits git log output on the NUL before each message', () => {
    const log = '\0feat: one\n\nRefs #4\n\n\0fix: two\n\n\0docs: three\n'
    expect(splitCommitMessages(log)).toEqual(['feat: one\n\nRefs #4\n\n', 'fix: two\n\n', 'docs: three\n'])
  })

  test('returns no messages for empty output', () => {
    expect(splitCommitMessages('')).toEqual([])
    expect(splitCommitMessages('\n')).toEqual([])
  })
})

describe('countIssueRefs', () => {
  test('counts distinct issues referenced with refs, closes, fixes, or resolves', () => {
    const messages = [
      'feat: add the batch segment\n\nRefs #2',
      'fix: wrap the band\n\nCloses #4, fixes #5',
      'test: cover the loop\n\nresolves #2\nREFS #6',
    ]
    expect(countIssueRefs(messages)).toBe(4)
  })

  test('ignores a bare issue number and other verbs', () => {
    expect(countIssueRefs(['fix: #3 follow-up', 'see #4', 'prefixes #5', 'refs#6'])).toBe(0)
  })

  test('counts the same issue written with leading zeros once', () => {
    expect(countIssueRefs(['refs #7', 'fixes #007'])).toBe(1)
  })

  test('counts no issues in no messages', () => {
    expect(countIssueRefs([])).toBe(0)
  })
})

describe('refSha', () => {
  const PACKED = [
    '# pack-refs with: peeled fully-peeled sorted ',
    `${HEAD_A} refs/remotes/origin/dev`,
    `${HEAD_B} refs/remotes/origin/main`,
    `^${BASE}`,
    '',
  ].join('\n')

  test('reads the sha from a loose ref file', () => {
    expect(refSha(HEAD_A + '\n', PACKED, 'refs/remotes/origin/main')).toBe(HEAD_A)
  })

  test('falls back to packed-refs when there is no loose file', () => {
    expect(refSha(null, PACKED, 'refs/remotes/origin/main')).toBe(HEAD_B)
    expect(refSha(null, PACKED.replaceAll('\n', '\r\n'), 'refs/remotes/origin/main')).toBe(HEAD_B)
  })

  test('returns null when neither names the ref', () => {
    expect(refSha(null, PACKED, 'refs/remotes/origin/feature')).toBe(null)
    expect(refSha(null, null, 'refs/remotes/origin/main')).toBe(null)
  })

  test('ignores a loose file that does not hold a sha', () => {
    expect(refSha('ref: refs/remotes/origin/dev\n', PACKED, 'refs/remotes/origin/main')).toBe(HEAD_B)
    expect(refSha('garbage', null, 'refs/remotes/origin/main')).toBe(null)
  })

  test('does not match a ref whose name only starts with the one asked for', () => {
    expect(refSha(null, `${HEAD_A} refs/remotes/origin/main-old\n`, 'refs/remotes/origin/main')).toBe(null)
  })
})

describe('batchSegment', () => {
  test('formats nothing when the batch has no commits', () => {
    expect(batchSegment(batch({ commits: 0, issues: 0 }))).toBe(null)
  })

  test('formats the lead as issues when any are referenced', () => {
    expect(text(batchSegment(batch({ issues: 7 })))?.startsWith('7 issues' + SEP)).toBe(true)
    expect(text(batchSegment(batch({ issues: 1 })))?.startsWith('1 issue' + SEP)).toBe(true)
  })

  test('formats the lead as commits when no issue is referenced', () => {
    expect(text(batchSegment(batch({ issues: 0, commits: 3 })))?.startsWith('3 commits' + SEP)).toBe(true)
    expect(text(batchSegment(batch({ issues: 0, commits: 1 })))?.startsWith('1 commit' + SEP)).toBe(true)
  })

  test('formats a batch with no reviews as no review yet, in yellow', () => {
    const seg = batchSegment(batch({ reviews: [] }))
    expect(text(seg)).toBe('7 issues' + SEP + 'no review yet')
    expect(seg?.at(-1)).toEqual({ text: 'no review yet', tone: 'yellow' })
  })

  test('formats the separator as a dim middle dot', () => {
    const seg = batchSegment(batch({ reviews: [] }))
    expect(seg?.[1]).toEqual({ text: SEP, tone: 'dim' })
  })

  test('formats commits since the last review as stale, with the count', () => {
    const seg = batchSegment(batch({ sinceLastReview: 2 }))
    expect(text(seg)).toBe('7 issues' + SEP + 'review stale (+2 commits)')
    expect(seg?.at(-1)).toEqual({ text: 'review stale (+2 commits)', tone: 'yellow' })
    expect(text(batchSegment(batch({ sinceLastReview: 1 })))).toBe('7 issues' + SEP + 'review stale (+1 commit)')
  })

  test('formats a review whose commit is gone as stale, without a count', () => {
    const seg = batchSegment(batch({ sinceLastReview: 'gone' }))
    expect(text(seg)).toBe('7 issues' + SEP + 'review stale')
    expect(seg?.at(-1)).toEqual({ text: 'review stale', tone: 'yellow' })
  })

  test('formats a stale review ahead of its verdict', () => {
    const reviews = [review({ verdict: 'incomplete', blockers: 2 })]
    expect(text(batchSegment(batch({ reviews, sinceLastReview: 3 })))).toBe(
      '7 issues' + SEP + 'review stale (+3 commits)',
    )
  })

  test('formats an incomplete last review with the review count, in yellow', () => {
    const reviews = [review(), review({ verdict: 'incomplete', blockers: 1, warnings: 2 })]
    const seg = batchSegment(batch({ reviews }))
    expect(text(seg)).toBe('7 issues' + SEP + '2 reviews' + SEP + 'review incomplete')
    expect(seg?.at(-1)).toEqual({ text: 'review incomplete', tone: 'yellow' })
  })

  test('formats blockers in red, ahead of warnings', () => {
    const seg = batchSegment(batch({ reviews: [review({ verdict: 'other', blockers: 1, warnings: 3 })] }))
    expect(text(seg)).toBe('7 issues' + SEP + '1 review' + SEP + '1 blocker')
    expect(seg?.at(-1)).toEqual({ text: '1 blocker', tone: 'red' })
    expect(text(batchSegment(batch({ reviews: [review({ blockers: 2 })] })))?.endsWith('2 blockers')).toBe(true)
  })

  test('formats warnings in yellow, ahead of the verdict', () => {
    const seg = batchSegment(batch({ reviews: [review({ verdict: 'ready', warnings: 3 })] }))
    expect(text(seg)).toBe('7 issues' + SEP + '1 review' + SEP + '3 warnings')
    expect(seg?.at(-1)).toEqual({ text: '3 warnings', tone: 'yellow' })
    expect(text(batchSegment(batch({ reviews: [review({ warnings: 1 })] })))?.endsWith('1 warning')).toBe(true)
  })

  test('formats a ready verdict with a green check', () => {
    const seg = batchSegment(batch({ reviews: [review({ verdict: 'other' }), review()] }))
    expect(text(seg)).toBe('7 issues' + SEP + '2 reviews' + SEP + '\u2713 ready')
    expect(seg?.at(-1)).toEqual({ text: '\u2713 ready', tone: 'green' })
  })

  test('formats any other verdict as not ready, in yellow', () => {
    const seg = batchSegment(batch({ issues: 0, commits: 1, reviews: [review({ verdict: 'other' })] }))
    expect(text(seg)).toBe('1 commit' + SEP + '1 review' + SEP + 'not ready')
    expect(seg?.at(-1)).toEqual({ text: 'not ready', tone: 'yellow' })
  })

  test('formats the verdict from the last review only', () => {
    const reviews = [review({ blockers: 4 }), review({ verdict: 'ready' })]
    expect(text(batchSegment(batch({ reviews })))?.endsWith('\u2713 ready')).toBe(true)
  })
})
