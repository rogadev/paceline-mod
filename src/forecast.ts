/**
 * Forecasts which usage limit runs out first, the five-hour session or the
 * week, so the line can show just that one.
 *
 * The model:
 *
 * - Activity: each refresh marks the local hour of the day in which usage
 *   went up. Over the recorded days that gives, per hour of the day, the
 *   chance the user is working then: a 9-to-5 user is near 1 during work
 *   hours and near 0 at night, an agent running around the clock is near 1
 *   everywhere. With no history yet, every hour is an even chance.
 * - Burn rate: percentage points per active hour. The week uses today's
 *   average (points spent today over today's active hours), falling back to
 *   the week's average early in the day. The session uses its own window.
 * - Projection: walk forward from now to the limit's reset, adding the burn
 *   rate times the chance of working in each stretch, and note when the
 *   limit would reach 100%.
 *
 * Every function here is pure: the activity record lives in the mod's store,
 * and hooks/register.ts reads and writes it.
 */

import { dateKey, startOfDay, type Zone } from './timefmt.ts'
import type { Limit } from './payload.ts'
import type { LimitPick } from './render.ts'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const SESSION_MS = 5 * HOUR
const WEEK_MS = 7 * 24 * HOUR
const STEP_MS = 15 * MINUTE
/** How many recorded days the activity profile keeps. */
const KEEP_DAYS = 14
/** Usage that rose this recently means the user is working now. */
const ACTIVE_NOW_MS = 20 * MINUTE
/** A rate needs at least this many active hours behind it to be trusted. */
const MIN_RATE_HOURS = 2
/** Neither limit runs out: switch only when the other one leads by this many points. */
const SWITCH_MARGIN = 5
/** Pseudo-days of evidence each way for every hour, before any history. */
const PRIOR = 0.25
/** With no history, a week's use is spread over at least this many hours. */
const MIN_FALLBACK_HOURS = 3

/** Which hours of a day had readings, and which saw usage go up, as 24-bit masks. */
export type DayActivity = { seen: number; active: number }

/** What the mod remembers between refreshes, in its store. */
export type Activity = {
  /** Keyed by `yyyymmdd` in local time. */
  days: Record<string, DayActivity>
  /** The latest readings, to tell when usage went up. */
  last?: { session?: number; week?: number; changedAtMs?: number }
}

const bit = (hour: number) => 1 << hour

function hourOf(ms: number, zone: Zone): number {
  const d = new Date(ms)
  return zone === 'utc' ? d.getUTCHours() : d.getHours()
}

/** Reports whether `a` is a well-formed activity record from the store. */
export function isActivity(a: unknown): a is Activity {
  if (typeof a !== 'object' || a === null) return false
  const days = (a as Activity).days
  if (typeof days !== 'object' || days === null) return false
  return Object.values(days).every(
    d => typeof d === 'object' && d !== null && Number.isInteger(d.seen) && Number.isInteger(d.active),
  )
}

/**
 * Records one reading: marks this hour as seen, and as active when either
 * limit's usage went up since the last reading. Returns the new record, and
 * whether it changed, so the store is written only when it must be.
 */
export function recordActivity(
  prev: Activity | null,
  nowMs: number,
  zone: Zone,
  session: number | undefined,
  week: number | undefined,
): { activity: Activity; changed: boolean } {
  const days: Record<string, DayActivity> = { ...(prev?.days ?? {}) }
  const key = dateKey(nowMs, zone)
  const h = bit(hourOf(nowMs, zone))
  const last = prev?.last
  // A drop is a window resetting, not use.
  const rose =
    (session !== undefined && last?.session !== undefined && session > last.session) ||
    (week !== undefined && last?.week !== undefined && week > last.week)

  const day = days[key] ?? { seen: 0, active: 0 }
  const next: DayActivity = { seen: day.seen | h, active: rose ? day.active | h : day.active }
  days[key] = next

  // Keep only the newest days.
  const keys = Object.keys(days).sort()
  for (const old of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete days[old]

  const changedAtMs = rose ? nowMs : last?.changedAtMs
  const activity: Activity = { days, last: { session, week, changedAtMs } }
  const changed =
    !prev ||
    next.seen !== day.seen ||
    next.active !== day.active ||
    session !== last?.session ||
    week !== last?.week ||
    keys.length > KEEP_DAYS
  return { activity, changed }
}

/**
 * The chance of working in each hour of the day, from the completed days on
 * record (today is still in progress). A light prior (a quarter of a day each
 * way) keeps a new install at an even chance and never rules an hour out,
 * while a week of steady use moves an hour close to 0 or 1.
 */
export function hourProfile(a: Activity | null, nowMs: number, zone: Zone): number[] {
  const today = dateKey(nowMs, zone)
  const past = Object.entries(a?.days ?? {}).filter(([key]) => key < today)
  return Array.from({ length: 24 }, (_, hour) => {
    const active = past.filter(([, d]) => (d.active & bit(hour)) !== 0).length
    return (active + PRIOR) / (past.length + 2 * PRIOR)
  })
}

/** Active hours on record between two times, counting whole hours that saw usage rise. */
function activeHoursBetween(a: Activity | null, fromMs: number, toMs: number, zone: Zone): number {
  let hours = 0
  // Step hour by hour from the hour that holds fromMs.
  for (let t = fromMs - (fromMs % HOUR); t < toMs; t += HOUR) {
    const day = a?.days[dateKey(t, zone)]
    if (day && (day.active & bit(hourOf(t, zone))) !== 0) hours++
  }
  return hours
}

type Projection = {
  /** Epoch seconds when the limit reaches 100%, or undefined if not before its reset. */
  outAt?: number
  /** The usage forecast at the reset, uncapped. */
  atReset: number
}

/**
 * Walks from now to the reset in short steps, burning `rate` points per hour
 * in proportion to the chance of working in each step.
 */
function project(
  used: number,
  rate: number,
  nowMs: number,
  resetMs: number,
  chance: (ms: number) => number,
): Projection {
  let total = used
  let outAt: number | undefined
  for (let t = nowMs; t < resetMs; t += STEP_MS) {
    const stepHours = Math.min(STEP_MS, resetMs - t) / HOUR
    const burn = rate * chance(t) * stepHours
    if (outAt === undefined && total < 100 && total + burn >= 100) {
      const fraction = burn > 0 ? (100 - total) / burn : 0
      outAt = Math.floor((t + fraction * stepHours * HOUR) / 1000)
    }
    total += burn
  }
  if (used >= 100) outAt = Math.floor(nowMs / 1000)
  return { outAt, atReset: total }
}

/** What `forecastLimits` needs. */
export type ForecastInput = {
  nowMs: number
  zone: Zone
  session?: Limit
  week?: Limit
  activity: Activity | null
  /** Weekly usage at the start of today, from the day snapshot, if known. */
  weekAtDayStart?: number
  /** The previous pick, so a near tie doesn't flip the line back and forth. */
  previous?: LimitPick['show']
}

/**
 * Picks the limit worth showing: the one forecast to run out first; if
 * neither runs out before it resets, the one forecast to end its window
 * closer to 100%. Returns null when there is nothing to choose between.
 */
export function forecastLimits(input: ForecastInput): LimitPick | null {
  const { nowMs, zone, activity } = input
  const s = input.session
  const w = input.week
  const hasS = s?.usedPercentage !== undefined && s.resetsAt !== undefined
  const hasW = w?.usedPercentage !== undefined && w.resetsAt !== undefined
  if (!hasS || !hasW) return null

  const profile = hourProfile(activity, nowMs, zone)
  const workingNow =
    activity?.last?.changedAtMs !== undefined && nowMs - activity.last.changedAtMs <= ACTIVE_NOW_MS
  // Right now, recent use says more than the profile does.
  const chance = (ms: number) => (workingNow && ms - nowMs < HOUR ? 1 : profile[hourOf(ms, zone)])

  // The session: points per active hour since its window opened.
  const sessionReset = s.resetsAt! * 1000
  const sessionStart = sessionReset - SESSION_MS
  const sessionUsed = s.usedPercentage!
  const sessionActive = activeHoursBetween(activity, sessionStart, nowMs, zone)
  const sessionElapsed = Math.max((nowMs - sessionStart) / HOUR, 0.25)
  const sessionRate = sessionUsed / Math.max(sessionActive || sessionElapsed, 0.5)

  // The week: today's average when today has enough behind it, else the week's.
  const weekReset = w.resetsAt! * 1000
  const weekStart = weekReset - WEEK_MS
  const weekUsed = w.usedPercentage!
  const todayStart = startOfDay(nowMs, zone)
  const todayActive = activeHoursBetween(activity, todayStart, nowMs, zone)
  const spentToday = input.weekAtDayStart === undefined ? undefined : weekUsed - input.weekAtDayStart
  const weekActive = activeHoursBetween(activity, Math.max(weekStart, nowMs - WEEK_MS), nowMs, zone)
  let weekRate: number
  if (spentToday !== undefined && spentToday > 0 && todayActive >= MIN_RATE_HOURS) {
    weekRate = spentToday / todayActive
  } else if (weekActive >= MIN_RATE_HOURS) {
    weekRate = weekUsed / weekActive
  } else {
    // No usable history: spread the week's use over its elapsed hours at an even chance.
    weekRate = weekUsed / Math.max(((nowMs - weekStart) / HOUR) * 0.5, MIN_FALLBACK_HOURS)
  }

  const sp = project(sessionUsed, sessionRate, nowMs, sessionReset, chance)
  const wp = project(weekUsed, weekRate, nowMs, weekReset, chance)

  if (sp.outAt !== undefined || wp.outAt !== undefined) {
    const sessionFirst = wp.outAt === undefined || (sp.outAt !== undefined && sp.outAt <= wp.outAt)
    return sessionFirst ? { show: 'session', outAt: sp.outAt } : { show: 'week', outAt: wp.outAt }
  }
  const lead: LimitPick['show'] = sp.atReset >= wp.atReset ? 'session' : 'week'
  if (input.previous && input.previous !== lead && Math.abs(sp.atReset - wp.atReset) < SWITCH_MARGIN) {
    return { show: input.previous }
  }
  return { show: lead }
}
