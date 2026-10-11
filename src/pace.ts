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
 */

import { dateKey, startOfDay, type Zone } from './timefmt.ts'

const EVEN_PACE = 100 / 7
const DAY_MS = 24 * 60 * 60 * 1000

/** Weekly usage recorded at the start of a day. */
export type Snapshot = {
  date: string
  resetsAt: number
  usedAtStart: number
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
    v.usedAtStart <= 100
  )
}

/**
 * Works out today's budget from the weekly limit's use and reset time (epoch
 * seconds), or returns null once the reset has passed. `snap` is the saved
 * snapshot, if any.
 */
export function computeBudget(
  usedPct: number,
  resetsAt: number,
  nowMs: number,
  snap: Snapshot | null,
  zone: Zone,
): Budget | null {
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
  const current: Snapshot = stale ? { date, resetsAt, usedAtStart: usedPct } : snap

  const budget = (100 - current.usedAtStart) / daysLeft
  const spent = usedPct - current.usedAtStart
  const ratio = budget / EVEN_PACE
  return {
    resetsAt,
    budget,
    spent,
    pctLeft: budget > 0 ? (100 * (budget - spent)) / budget : 0,
    pctUsed: budget > 0 ? (100 * spent) / budget : 0,
    over: spent > budget,
    pace: ratio >= 1.25 ? 'up' : ratio <= 0.8 ? 'down' : 'even',
    snapshot: current,
    snapshotChanged: stale,
  }
}
