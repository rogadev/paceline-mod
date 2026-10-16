/**
 * Today's share of the weekly limit.
 *
 * The budget is anchored at the first reading of each local day (a snapshot)
 * so it stays fixed while you work instead of drifting with every refresh:
 *
 *     budget = weekly % left at day start / days from local midnight to reset
 *
 * Unspent budget rolls over by spreading across the remaining days, since the
 * next day's budget divides whatever the week still has.
 *
 * It also reports the days left until the reset, tomorrow's budget if nothing
 * more is spent today, and, on the last day, when the week runs out at
 * today's pace.
 */

import { dateKey, startOfDay, startOfNextDay, type Zone } from './timefmt.ts'

/**
 * An even share of the week: 100% / 7, the base daily budget that carryover
 * raises and earlier overspending lowers.
 */
export const EVEN_PACE = 100 / 7
const DAY_MS = 24 * 60 * 60 * 1000
/**
 * How long a day must have run before `runsOutAt` projects from its pace, as
 * in the Go paceline: in the first minutes a single burst of work swings the
 * projection by hours.
 */
const MIN_PACE_WINDOW_MS = 30 * 60 * 1000

/** Weekly usage recorded at the start of a day. */
export type Snapshot = {
  date: string
  resetsAt: number
  usedAtStart: number
  /**
   * When the snapshot was taken, in epoch seconds. Snapshots saved before it
   * was recorded have none, and the day starts at local midnight instead.
   */
  startedAt?: number
}

/** Compares today's budget to an even pace of 100% / 7 per day. */
export type Direction = 'even' | 'up' | 'down'

/** Today's budget and how much of it is spent. */
export type Budget = {
  resetsAt: number
  /** Weekly percentage points available today. */
  budget: number
  /** Weekly percentage points spent today. */
  spent: number
  /** Percentage of today's budget left. */
  pctLeft: number
  /** Percentage of today's budget used; may exceed 100. */
  pctUsed: number
  over: boolean
  /** Days from local midnight to the reset, at least 1. */
  daysLeft: number
  /** The reset falls on or before the next local midnight. */
  lastDay: boolean
  /** Tomorrow's budget if nothing more is spent today; 0 on the last day. */
  tomorrow: number
  /**
   * Epoch seconds when the week reaches 100% at today's pace, or 0. Set on
   * the last day only; see `computeBudget`.
   */
  runsOutAt: number
  pace: Direction
  snapshot: Snapshot
  /** True when the caller should save `snapshot`. */
  snapshotChanged: boolean
}

/**
 * Reports whether `s` is a well-formed snapshot, so a corrupt or hand-edited
 * value is never trusted.
 */
export function isValidSnapshot(s: unknown): s is Snapshot {
  if (typeof s !== 'object' || s === null) return false
  const v = s as Record<string, unknown>
  return (
    typeof v.date === 'string' &&
    /^\d{8}$/.test(v.date) &&
    typeof v.resetsAt === 'number' &&
    Number.isFinite(v.resetsAt) &&
    typeof v.usedAtStart === 'number' &&
    v.usedAtStart >= 0 &&
    v.usedAtStart <= 100 &&
    (v.startedAt === undefined || (typeof v.startedAt === 'number' && Number.isFinite(v.startedAt)))
  )
}

/**
 * Works out today's budget from the weekly limit's use and reset time (epoch
 * seconds), or returns null once the reset has passed. `snap` is the saved
 * snapshot, if any.
 *
 * `runsOutAt` is 0 before the last day, with nothing spent, under 30 minutes
 * after the day started, with the week already used up, or when the
 * projection falls at or after the reset.
 */
export function computeBudget(
  usedPct: number,
  resetsAt: number,
  nowMs: number,
  snap: Snapshot | null,
  zone: Zone,
): Budget | null {
  // A reading past 100% (or below 0) would anchor an invalid snapshot that is
  // rewritten on every refresh, and turn a used-up week into an overspent day.
  usedPct = Math.min(Math.max(usedPct, 0), 100)
  const midnight = startOfDay(nowMs, zone)
  let daysLeft = (Math.trunc(resetsAt) * 1000 - midnight) / DAY_MS
  if (daysLeft <= 0) return null
  // On the final partial day, everything left in the week is today's.
  daysLeft = Math.max(daysLeft, 1)

  const date = dateKey(nowMs, zone)
  const stale =
    !isValidSnapshot(snap) ||
    snap.date !== date ||
    snap.resetsAt !== resetsAt ||
    usedPct < snap.usedAtStart // the window reset under us
  const current: Snapshot = stale
    ? { date, resetsAt, usedAtStart: usedPct, startedAt: Math.floor(nowMs / 1000) }
    : snap

  const budget = (100 - current.usedAtStart) / daysLeft
  const spent = usedPct - current.usedAtStart
  const ratio = budget / EVEN_PACE
  // On the last day the reset brings a fresh week, so tomorrow's budget is
  // moot; what's worth knowing is when the week runs out before the reset.
  const lastDay = Math.trunc(resetsAt) * 1000 <= startOfNextDay(nowMs, zone)
  return {
    resetsAt,
    budget,
    spent,
    pctLeft: budget > 0 ? (100 * (budget - spent)) / budget : 0,
    pctUsed: budget > 0 ? (100 * spent) / budget : 0,
    over: spent > budget,
    daysLeft,
    lastDay,
    tomorrow: lastDay ? 0 : Math.max(0, 100 - usedPct) / Math.max(daysLeft - 1, 1),
    runsOutAt: lastDay ? runsOutAt(usedPct, spent, resetsAt, dayStart(current, midnight, nowMs), nowMs) : 0,
    pace: ratio >= 1.25 ? 'up' : ratio <= 0.8 ? 'down' : 'even',
    snapshot: current,
    snapshotChanged: stale,
  }
}

// When today's snapshot was taken, or local midnight for a snapshot without a
// start or with one outside today so far, such as a hand-edited file.
function dayStart(s: Snapshot, midnight: number, nowMs: number): number {
  if (s.startedAt === undefined) return midnight
  const started = Math.trunc(s.startedAt) * 1000
  return started < midnight || started > nowMs ? midnight : started
}

// Projects when weekly usage reaches 100% if it keeps rising at the rate it
// has since `startMs`, in whole epoch seconds, or 0 when there is nothing to
// project.
function runsOutAt(usedPct: number, spent: number, resetsAt: number, startMs: number, nowMs: number): number {
  const elapsedMs = nowMs - startMs
  if (spent <= 0 || usedPct >= 100 || elapsedMs < MIN_PACE_WINDOW_MS) return 0
  const perSecond = spent / (elapsedMs / 1000)
  const at = Math.round(Math.floor(nowMs / 1000) + (100 - usedPct) / perSecond)
  return at >= resetsAt ? 0 : at
}
