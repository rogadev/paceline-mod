import { describe, expect, test } from 'claude-code/testing'

import {
  acceptResult,
  batchAllowed,
  batchKey,
  batchSegment,
  computeBatch,
  countIssueRefs,
  GIT_ENV,
  GIT_RETRY_MS,
  isFresh,
  ledgerPath,
  ledgerScriptPath,
  logArgv,
  MAX_BATCH_COMMITS,
  MAX_LEDGER_BYTES,
  mergeBaseArgv,
  parseLedger,
  planBatch,
  settleBatch,
  sinceArgv,
  sinceLastReview,
  splitCommitMessages,
  staleReviewHead,
  type BatchCache,
  type BatchFlow,
  type BatchRefs,
  type BatchState,
  type GitOutput,
  type GitRun,
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
    for (const bad of [-1, 1.5, '3', null, undefined, true, Number.NaN, Number.POSITIVE_INFINITY]) {
      const [entry] = parseLedger(line({ blockers: bad, warnings: bad }), BASE) ?? []
      expect([entry.blockers, entry.warnings]).toEqual([0, 0])
    }
  })

  test('parses the ledger capping a large count', () => {
    const [entry] = parseLedger(line({ blockers: 123456, warnings: 1000 }), BASE) ?? []
    expect([entry.blockers, entry.warnings]).toEqual([999, 999])
  })

  test('parses the ledger capping a count above the safe integer range', () => {
    const [entry] = parseLedger(line({ blockers: Number.MAX_VALUE, warnings: 2 ** 60 }), BASE) ?? []
    expect([entry.blockers, entry.warnings]).toEqual([999, 999])
  })

  test('parses the ledger as null when multi-byte text is over the size cap in bytes', () => {
    // Each check mark is three bytes in UTF-8, so the text is under the cap in
    // characters and over it in bytes.
    const wide = line({}) + '\n' + '\u2713'.repeat(Math.ceil(MAX_LEDGER_BYTES / 3))
    expect(wide.length < MAX_LEDGER_BYTES).toBe(true)
    expect(parseLedger(wide, BASE)).toBe(null)
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

describe('sinceLastReview', () => {
  test('counts nothing when there is no review', () => {
    expect(sinceLastReview(undefined, HEAD_A, null)).toBe(0)
  })

  test('counts nothing when the last review saw HEAD', () => {
    expect(sinceLastReview(review({ head: HEAD_A }), HEAD_A, null)).toBe(0)
  })

  test('maps a review head that is not a commit id to gone', () => {
    expect(sinceLastReview(review({ head: null }), HEAD_A, '0\n')).toBe('gone')
  })

  test('maps a failed or unreadable count to gone', () => {
    expect(sinceLastReview(review({ head: HEAD_B }), HEAD_A, null)).toBe('gone')
    expect(sinceLastReview(review({ head: HEAD_B }), HEAD_A, 'fatal: bad revision\n')).toBe('gone')
    expect(sinceLastReview(review({ head: HEAD_B }), HEAD_A, '')).toBe('gone')
  })

  test('reads the count git printed, capped at 999', () => {
    expect(sinceLastReview(review({ head: HEAD_B }), HEAD_A, '3\n')).toBe(3)
    expect(sinceLastReview(review({ head: HEAD_B }), HEAD_A, '123456\n')).toBe(999)
  })
})

describe('staleReviewHead', () => {
  test('names the reviewed commit when it is not HEAD', () => {
    expect(staleReviewHead(review({ head: HEAD_B }), HEAD_A)).toBe(HEAD_B)
  })

  test('names nothing when there is no review, no head, or the review saw HEAD', () => {
    expect(staleReviewHead(undefined, HEAD_A)).toBe(null)
    expect(staleReviewHead(review({ head: null }), HEAD_A)).toBe(null)
    expect(staleReviewHead(review({ head: HEAD_A }), HEAD_A)).toBe(null)
  })
})

describe('ledger paths', () => {
  test('name the deep-review script and the ledger in the work tree', () => {
    expect(ledgerScriptPath('/w/tree')).toBe('/w/tree/.claude/skills/deep-review/scripts/ledger.mjs')
    expect(ledgerPath('/w/tree')).toBe('/w/tree/tmp/reviews/ledger.jsonl')
  })
})

describe('batchKey', () => {
  function refs(fields: Partial<BatchRefs> = {}): BatchRefs {
    return {
      workTree: '/r/app',
      head: { kind: 'branch', ref: 'refs/heads/dev', sha: HEAD_A },
      mainSha: BASE,
      ledger: { mtimeMs: 1000, size: 200 },
      ...fields,
    }
  }

  test('keys a batch on a branch other than main, with both shas', () => {
    const found = batchKey(refs())
    expect(found?.headSha).toBe(HEAD_A)
    expect(found?.mainSha).toBe(BASE)
    expect(typeof found?.key).toBe('string')
  })

  test('applies only off main, on a born branch, with origin/main', () => {
    expect(batchKey(refs({ head: { kind: 'branch', ref: 'refs/heads/main', sha: HEAD_A } }))).toBe(null)
    expect(batchKey(refs({ head: { kind: 'branch', ref: 'refs/heads/dev', sha: null } }))).toBe(null)
    expect(batchKey(refs({ head: { kind: 'detached', sha: HEAD_A } }))).toBe(null)
    expect(batchKey(refs({ head: null }))).toBe(null)
    expect(batchKey(refs({ mainSha: null }))).toBe(null)
  })

  test('keys a batch with no ledger yet', () => {
    expect(batchKey(refs({ ledger: null }))).not.toBe(null)
  })

  test('changes the key when HEAD, origin/main, the ledger, or the work tree moves', () => {
    const key = batchKey(refs())?.key
    expect(batchKey(refs())?.key).toBe(key)
    const moved = [
      refs({ head: { kind: 'branch', ref: 'refs/heads/dev', sha: HEAD_B } }),
      refs({ mainSha: OTHER_BASE }),
      refs({ ledger: { mtimeMs: 1001, size: 200 } }),
      refs({ ledger: { mtimeMs: 1000, size: 201 } }),
      refs({ ledger: null }),
      refs({ workTree: '/r/other' }),
    ]
    for (const r of moved) {
      const found = batchKey(r)
      expect(found).not.toBe(null)
      expect(found?.key === key).toBe(false)
    }
  })
})

describe('batchAllowed', () => {
  const WINDOWS = { userProfile: 'C:\\Users\\me' }

  test('allows the batch with the toggle on, no host git variables, and an absolute config dir', () => {
    expect(batchAllowed(true, WINDOWS, 'C:/Users/me/.claude')).toBe(true)
    expect(batchAllowed(true, {}, '/home/me/.claude')).toBe(true)
  })

  test('skips the batch when its toggle is off', () => {
    expect(batchAllowed(false, WINDOWS, 'C:/Users/me/.claude')).toBe(false)
  })

  test('skips the batch when the host sets GIT_DIR or GIT_WORK_TREE, even to nothing', () => {
    expect(batchAllowed(true, { ...WINDOWS, gitDir: 'D:/elsewhere/.git' }, 'C:/x')).toBe(false)
    expect(batchAllowed(true, { ...WINDOWS, workTree: 'D:/elsewhere' }, 'C:/x')).toBe(false)
    expect(batchAllowed(true, { gitDir: '' }, '/x')).toBe(false)
  })

  test('skips the batch when the config dir is relative', () => {
    expect(batchAllowed(true, WINDOWS, '.claude')).toBe(false)
    expect(batchAllowed(true, {}, '.claude')).toBe(false)
    expect(batchAllowed(true, WINDOWS, 'C:.claude')).toBe(false)
  })

  test('takes a drive-letter or UNC path on any host, with either slash', () => {
    for (const host of [WINDOWS, {}]) {
      expect(batchAllowed(true, host, 'C:/x')).toBe(true)
      expect(batchAllowed(true, host, 'C:\\x')).toBe(true)
      expect(batchAllowed(true, host, '//server/share/x')).toBe(true)
      expect(batchAllowed(true, host, '\\\\server\\share\\x')).toBe(true)
    }
  })

  test('takes a path rooted at / only on a host that is not Windows', () => {
    expect(batchAllowed(true, {}, '/x')).toBe(true)
    // On Windows, "/x" is relative to the current drive.
    expect(batchAllowed(true, WINDOWS, '/x')).toBe(false)
    expect(batchAllowed(true, {}, '//server')).toBe(false)
  })
})

describe('planBatch and acceptResult', () => {
  const EMPTY: BatchFlow = { cache: null, pending: null, wanted: null }
  const STATE: BatchState = { commits: 1, issues: 0, reviews: [], sinceLastReview: 0 }
  const settled = (key: string, batch: BatchState | null = STATE): BatchCache => ({ key, batch, retryAtMs: Infinity })

  test('starts one update for a key the cache does not answer, and draws nothing yet', () => {
    const plan = planBatch(EMPTY, 'a', 0)
    expect(plan).toEqual({ next: { cache: null, pending: 'a', wanted: 'a' }, draw: null, start: true })
  })

  test('starts no second update while the key is pending', () => {
    const first = planBatch(EMPTY, 'a', 0)
    const second = planBatch(first.next, 'a', 15_000)
    expect(second.start).toBe(false)
    expect(second.next).toEqual(first.next)
  })

  test('draws the cache only for its own key', () => {
    const held: BatchFlow = { cache: settled('a'), pending: null, wanted: 'a' }
    expect(planBatch(held, 'a', 0)).toEqual({ next: held, draw: STATE, start: false })
    const moved = planBatch(held, 'b', 0)
    expect(moved.draw).toBe(null)
    expect(moved.start).toBe(true)
    expect(moved.next.wanted).toBe('b')
  })

  test('restarts a failed entry once its retry time has passed', () => {
    const failed: BatchFlow = { cache: { key: 'a', batch: null, retryAtMs: 60_000 }, pending: null, wanted: 'a' }
    expect(planBatch(failed, 'a', 59_999).start).toBe(false)
    const retry = planBatch(failed, 'a', 60_000)
    expect(retry.start).toBe(true)
    expect(retry.draw).toBe(null)
  })

  test('forgets the wanted key when the batch path is skipped', () => {
    const held: BatchFlow = { cache: settled('a'), pending: 'b', wanted: 'b' }
    expect(planBatch(held, null, 0)).toEqual({ next: { ...held, wanted: null }, draw: null, start: false })
  })

  test('keeps a result for the wanted key, clears its pending mark, and redraws', () => {
    const waiting: BatchFlow = { cache: null, pending: 'a', wanted: 'a' }
    expect(acceptResult(waiting, settled('a'))).toEqual({
      next: { cache: settled('a'), pending: null, wanted: 'a' },
      redraw: true,
    })
  })

  test('drops a result for an older key without redrawing', () => {
    const moved: BatchFlow = { cache: settled('b'), pending: 'a', wanted: 'b' }
    expect(acceptResult(moved, settled('a', null))).toEqual({
      next: { cache: settled('b'), pending: null, wanted: 'b' },
      redraw: false,
    })
  })

  test('keeps another key pending when an older result arrives', () => {
    const moved: BatchFlow = { cache: null, pending: 'b', wanted: 'b' }
    expect(acceptResult(moved, settled('a')).next.pending).toBe('b')
  })
})

describe('isFresh', () => {
  const settled: BatchCache = { key: 'k', batch: null, retryAtMs: Infinity }

  test('has nothing to answer with when there is no cache', () => {
    expect(isFresh(null, 'k', 0)).toBe(false)
  })

  test('answers only the key it was computed for', () => {
    expect(isFresh(settled, 'k', 0)).toBe(true)
    expect(isFresh(settled, 'other', 0)).toBe(false)
  })

  test('keeps a settled result for any time', () => {
    expect(isFresh(settled, 'k', Number.MAX_SAFE_INTEGER)).toBe(true)
  })

  test('keeps a failed run only until its retry time', () => {
    const failed: BatchCache = { key: 'k', batch: null, retryAtMs: 60_000 }
    expect(isFresh(failed, 'k', 59_999)).toBe(true)
    expect(isFresh(failed, 'k', 60_000)).toBe(false)
  })
})

describe('git arguments', () => {
  const PIN = ['-C', '/w/tree', '--no-lazy-fetch', '-c', 'core.fsmonitor=false']

  test('finds the merge base of origin/main and HEAD by sha', () => {
    expect(mergeBaseArgv('/w/tree', BASE, HEAD_A)).toEqual([...PIN, 'merge-base', BASE, HEAD_A])
  })

  test('logs the batch messages, bounded and without signatures', () => {
    expect(logArgv('/w/tree', BASE, HEAD_A)).toEqual([
      ...PIN,
      'log',
      '--no-show-signature',
      `--max-count=${MAX_BATCH_COMMITS}`,
      '--format=%x00%B',
      `${BASE}..${HEAD_A}`,
    ])
  })

  test('counts from the reviewed commit, peeled to a commit', () => {
    expect(sinceArgv('/w/tree', HEAD_B, HEAD_A)).toEqual([
      ...PIN,
      'rev-list',
      '--count',
      `${HEAD_B}^{commit}..${HEAD_A}`,
    ])
  })

  test('turns off lazy fetches in the environment too, and sets nothing else', () => {
    expect(GIT_ENV).toEqual({ GIT_NO_LAZY_FETCH: '1' })
  })
})

describe('computeBatch', () => {
  const SHAS = { headSha: HEAD_A, mainSha: OTHER_BASE }
  const ok = (stdout: string, isStdoutTruncated = false): GitOutput => ({ stdout, isStdoutTruncated })
  const LOG = '\0feat: one\n\nFixes #12\n\0fix: two\n\nrefs #12, closes #14\n\0docs: three\n'

  // A git that answers each subcommand from `answers`, recording every call.
  function git(answers: { mergeBase?: GitOutput | null; log?: GitOutput | null; revList?: GitOutput | null }) {
    const calls: string[] = []
    const run: GitRun = async argv => {
      const command = argv[PIN_LENGTH]
      calls.push(command)
      if (command === 'merge-base') return answers.mergeBase === undefined ? ok(BASE + '\n') : answers.mergeBase
      if (command === 'log') return answers.log === undefined ? ok(LOG) : answers.log
      return answers.revList === undefined ? ok('2\n') : answers.revList
    }
    return { run, calls }
  }
  const PIN_LENGTH = mergeBaseArgv('/w', BASE, HEAD_A).indexOf('merge-base')
  const ledger = (...entries: Record<string, unknown>[]) => async () => entries.map(line).join('\n')

  test('counts the commits and the distinct issues they reference', async () => {
    const { run } = git({})
    expect(await computeBatch(run, null, '/w', SHAS)).toEqual({
      commits: 3,
      issues: 2,
      reviews: [],
      sinceLastReview: 0,
    })
  })

  test('draws nothing when there is no merge base', async () => {
    const { run, calls } = git({ mergeBase: null })
    expect(await computeBatch(run, null, '/w', SHAS)).toBe(null)
    expect(calls).toEqual(['merge-base'])
  })

  test('draws nothing when the merge base is not a full sha', async () => {
    const { run } = git({ mergeBase: ok('warning: something\n') })
    expect(await computeBatch(run, null, '/w', SHAS)).toBe(null)
  })

  test('draws nothing when the log fails or was cut short', async () => {
    expect(await computeBatch(git({ log: null }).run, null, '/w', SHAS)).toBe(null)
    expect(await computeBatch(git({ log: ok(LOG, true) }).run, null, '/w', SHAS)).toBe(null)
  })

  test('draws nothing for an empty batch, without counting from a review', async () => {
    const { run, calls } = git({ log: ok('') })
    expect(await computeBatch(run, ledger({ head: HEAD_B }), '/w', SHAS)).toBe(null)
    expect(calls).toEqual(['merge-base', 'log'])
  })

  test('draws nothing when the ledger exists but cannot be read', async () => {
    expect(await computeBatch(git({}).run, async () => null, '/w', SHAS)).toBe(null)
  })

  test('takes the reviews recorded against this merge base', async () => {
    const read = ledger({ head: HEAD_A }, { base: OTHER_BASE, head: HEAD_B })
    const batch = await computeBatch(git({}).run, read, '/w', SHAS)
    expect(batch?.reviews.length).toBe(1)
  })

  test('runs no count when the last review saw HEAD', async () => {
    const { run, calls } = git({})
    const batch = await computeBatch(run, ledger({ head: HEAD_A }), '/w', SHAS)
    expect(batch?.sinceLastReview).toBe(0)
    expect(calls).toEqual(['merge-base', 'log'])
  })

  test('counts the commits since a stale review from its head', async () => {
    const seen: (readonly string[])[] = []
    const { run } = git({})
    const recording: GitRun = argv => {
      seen.push(argv)
      return run(argv)
    }
    const batch = await computeBatch(recording, ledger({ head: HEAD_B }), '/w', SHAS)
    expect(batch?.sinceLastReview).toBe(2)
    expect(seen.at(-1)).toEqual(sinceArgv('/w', HEAD_B, HEAD_A))
  })

  test('reads a failed count as the reviewed commit gone', async () => {
    const batch = await computeBatch(git({ revList: null }).run, ledger({ head: HEAD_B }), '/w', SHAS)
    expect(batch?.sinceLastReview).toBe('gone')
  })

  test('rejects when a git call times out', async () => {
    const run: GitRun = async () => {
      throw new Error('timed out')
    }
    let error: unknown = null
    await computeBatch(run, null, '/w', SHAS).catch(e => {
      error = e
    })
    expect(String(error)).toBe('Error: timed out')
  })
})

describe('settleBatch', () => {
  test('keeps a result, even no batch, until the key changes', async () => {
    const settled = await settleBatch('k', 1000, async () => null)
    expect(settled).toEqual({ cache: { key: 'k', batch: null, retryAtMs: Infinity } })
  })

  test('retries a run that timed out or could not start after a minute', async () => {
    const failure = new Error('timed out')
    const settled = await settleBatch('k', 1000, async () => {
      throw failure
    })
    expect(settled.cache).toEqual({ key: 'k', batch: null, retryAtMs: 1000 + GIT_RETRY_MS })
    expect(settled.error).toBe(failure)
    expect(GIT_RETRY_MS).toBe(60_000)
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

  test('formats no reviews as no review yet, even with a stale count', () => {
    expect(text(batchSegment(batch({ reviews: [], sinceLastReview: 3 })))).toBe('7 issues' + SEP + 'no review yet')
    expect(text(batchSegment(batch({ reviews: [], sinceLastReview: 'gone' })))).toBe('7 issues' + SEP + 'no review yet')
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
