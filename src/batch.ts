/**
 * Reads where the current dev -> main batch stands in code review and draws it
 * as the batch segment: the batch's size, then the review's state.
 *
 * The batch is every commit between `git merge-base origin/main HEAD` and
 * HEAD, and its reviews are the lines of deep-review's
 * `tmp/reviews/ledger.jsonl` recorded against that merge base. Everything from
 * the ledger is untrusted: the parser caps its size, keeps a review's head only
 * when it is a commit id, reduces the verdict to the values the segment tells
 * apart, and clamps the counts, so no string from the file reaches the line.
 */

import type { Segment, Span, Tone } from './render.ts'

/** The largest ledger the parser accepts, in bytes. */
export const MAX_LEDGER_BYTES = 1024 * 1024
const MAX_COUNT = 999

// The same glyphs as src/render.ts, copied rather than imported so that
// render.ts can import this module without the two loading each other.
// Importing only types from render.ts adds no such cycle.
const CHECK_MARK = '\u2713'
const SEPARATOR = ' \u00b7 '

const VERDICTS = ['ready', 'incomplete'] as const

// Hex only, so a head can never be read by git as an option or a revision
// expression when it is passed to `git rev-list`.
const COMMIT_ID = /^[0-9a-f]{4,64}$/i
const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const ISSUE_REF = /\b(?:refs|closes|fixes|resolves)\s+#(\d+)/gi

/** A review's verdict, or `other` for any the segment does not draw on its own. */
export type Verdict = (typeof VERDICTS)[number] | 'other'

/** One review from the ledger, as the segment draws it. */
export type LedgerEntry = {
  /** The commit the review saw, or null when the ledger's value is not a commit id. */
  head: string | null
  verdict: Verdict
  /** The review's blocker count, from 0 to 999. */
  blockers: number
  /** The review's warning count, from 0 to 999. */
  warnings: number
}

/** What the batch segment draws. */
export type BatchState = {
  /** The commits in the batch. */
  commits: number
  /** The distinct issues the batch's commit messages reference. */
  issues: number
  /** The reviews of this batch, oldest first. */
  reviews: readonly LedgerEntry[]
  /**
   * The commits made since the last review's head: 0 when the last review saw
   * HEAD or there are no reviews, and `gone` when its head is null or git could
   * not count from it because the commit was rebased away.
   */
  sinceLastReview: number | 'gone'
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? Math.min(v, MAX_COUNT) : 0
}

function parseEntry(lineText: string, base: string): LedgerEntry | null {
  let doc: unknown
  try {
    doc = JSON.parse(lineText)
  } catch {
    // A torn or hand-edited line costs one review, not the whole segment.
    return null
  }
  if (!isRecord(doc) || doc.base !== base || typeof doc.head !== 'string') return null
  return {
    head: COMMIT_ID.test(doc.head) ? doc.head : null,
    verdict: VERDICTS.find(known => known === doc.verdict) ?? 'other',
    blockers: count(doc.blockers),
    warnings: count(doc.warnings),
  }
}

/**
 * Parses a ledger's text into the reviews of one batch, in file order.
 *
 * A line counts when it is a JSON object whose `base` equals `base` and whose
 * `head` is a string. Blank, torn, and unparsable lines are skipped.
 *
 * @param ledgerText - The text of `tmp/reviews/ledger.jsonl`.
 * @param base - The batch's merge base, as a full sha.
 * @returns The batch's reviews, or null when the text is over {@link MAX_LEDGER_BYTES}.
 */
export function parseLedger(ledgerText: string, base: string): LedgerEntry[] | null {
  if (new TextEncoder().encode(ledgerText).length > MAX_LEDGER_BYTES) return null
  const entries: LedgerEntry[] = []
  for (const lineText of ledgerText.split('\n')) {
    if (lineText.trim() === '') continue
    const entry = parseEntry(lineText, base)
    if (entry !== null) entries.push(entry)
  }
  return entries
}

/**
 * Splits the output of `git log --format=%x00%B` into one message per commit.
 * Each message starts after a NUL; blank pieces are dropped.
 */
export function splitCommitMessages(logText: string): string[] {
  return logText.split('\0').filter(message => message.trim() !== '')
}

/**
 * Counts the distinct issue numbers that commit messages reference with
 * `refs`, `closes`, `fixes`, or `resolves` followed by `#<number>`, in any case.
 */
export function countIssueRefs(messages: readonly string[]): number {
  const issues = new Set<number>()
  for (const message of messages) {
    for (const [, n] of message.matchAll(ISSUE_REF)) issues.add(Number(n))
  }
  return issues.size
}

/**
 * Resolves a ref to its sha from the ref's loose file, falling back to the
 * repository's `packed-refs` file, as git does.
 *
 * @param looseText - The text of the ref's own file under the git directory, or null when it is missing.
 * @param packedText - The text of `packed-refs`, or null when it is missing.
 * @param refName - The full ref name, for example `refs/remotes/origin/main`.
 * @returns The sha, or null when neither file names the ref.
 */
export function refSha(looseText: string | null, packedText: string | null, refName: string): string | null {
  const loose = looseText?.trim() ?? ''
  if (FULL_SHA.test(loose)) return loose
  if (packedText === null) return null
  for (const lineText of packedText.split('\n')) {
    const [sha, name] = lineText.trim().split(' ')
    if (name === refName && FULL_SHA.test(sha)) return sha
  }
  return null
}

// The same helper as in src/render.ts, copied for the reason given above CHECK_MARK.
const span = (text: string, tone: Tone = 'plain'): Span => ({ text, tone })

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function joinParts(parts: Span[]): Segment {
  const out: Segment = []
  for (const part of parts) {
    if (out.length > 0) out.push(span(SEPARATOR, 'dim'))
    out.push(part)
  }
  return out
}

function staleText(sinceLastReview: number | 'gone'): string {
  if (sinceLastReview === 'gone') return 'review stale'
  return `review stale (+${plural(sinceLastReview, 'commit')})`
}

// Only the first of these that applies shows, so blockers hide warnings.
function verdictPart(last: LedgerEntry): Span {
  if (last.verdict === 'incomplete') return span('review incomplete', 'yellow')
  if (last.blockers > 0) return span(plural(last.blockers, 'blocker'), 'red')
  if (last.warnings > 0) return span(plural(last.warnings, 'warning'), 'yellow')
  if (last.verdict === 'ready') return span(CHECK_MARK + ' ready', 'green')
  return span('not ready', 'yellow')
}

/**
 * Draws the batch as its size and its review state, joined by a dim middle
 * dot, or returns null when the batch has no commits.
 *
 * The size reads `N issues` when the commits reference any issue, otherwise
 * `N commits`. Then, in order of precedence:
 *
 * - no reviews: `no review yet`
 * - commits since the last review: `review stale (+N commits)`, or `review stale` when its commit is gone
 * - otherwise the review count, then the first that applies to the last review: `review incomplete`,
 *   its blockers, its warnings, a check mark and `ready`, or `not ready`
 */
export function batchSegment(state: BatchState): Segment | null {
  if (state.commits === 0) return null
  const lead = span(state.issues > 0 ? plural(state.issues, 'issue') : plural(state.commits, 'commit'))
  const last = state.reviews.at(-1)
  if (last === undefined) return joinParts([lead, span('no review yet', 'yellow')])
  if (state.sinceLastReview !== 0) return joinParts([lead, span(staleText(state.sinceLastReview), 'yellow')])
  return joinParts([lead, span(plural(state.reviews.length, 'review')), verdictPart(last)])
}
