import { describe, expect, test } from 'claude-code/testing'

import { defaultConfig } from '../src/config.ts'
import { forecastLimits, hourProfile, recordActivity, type Activity } from '../src/forecast.ts'
import { decodePayload } from '../src/payload.ts'
import { render, toAnsi } from '../src/render.ts'
import { dateKey } from '../src/timefmt.ts'

const HOUR = 60 * 60 * 1000
const at = (iso: string) => Date.parse(iso)
const sec = (iso: string) => Date.parse(iso) / 1000

/** Hours 9 through 16 marked active on each of `days` days before `nowMs`. */
function nineToFive(nowMs: number, days: number): Activity {
  const record: Activity = { days: {} }
  let mask = 0
  for (let h = 9; h <= 16; h++) mask |= 1 << h
  for (let i = 1; i <= days; i++) {
    record.days[dateKey(nowMs - i * 24 * HOUR, 'utc')] = { seen: 0xffffff, active: mask }
  }
  return record
}

/** Every hour active on each of `days` days before `nowMs`, and today so far. */
function aroundTheClock(nowMs: number, days: number): Activity {
  const record: Activity = { days: {} }
  for (let i = 0; i <= days; i++) {
    record.days[dateKey(nowMs - i * 24 * HOUR, 'utc')] = { seen: 0xffffff, active: 0xffffff }
  }
  return record
}

describe('recordActivity', () => {
  const t = at('2026-10-07T14:20:00Z')

  test('marks the hour active only when usage went up', () => {
    const first = recordActivity(null, t, 'utc', 10, 50)
    expect(first.changed).toBe(true)
    expect(first.activity.days['20261007']).toEqual({ seen: 1 << 14, active: 0 })

    const same = recordActivity(first.activity, t + 60_000, 'utc', 10, 50)
    expect(same.changed).toBe(false)

    const rose = recordActivity(first.activity, t + 120_000, 'utc', 12, 50)
    expect(rose.changed).toBe(true)
    expect(rose.activity.days['20261007'].active).toBe(1 << 14)
    expect(rose.activity.last?.changedAtMs).toBe(t + 120_000)
  })

  test('a window resetting is not use', () => {
    const before = recordActivity(null, t, 'utc', 95, 50).activity
    const reset = recordActivity(before, t + 60_000, 'utc', 0, 50)
    expect(reset.activity.days['20261007'].active).toBe(0)
  })

  test('keeps only the newest 14 days', () => {
    let a: Activity = { days: {} }
    for (let i = 20; i >= 1; i--) a.days[dateKey(t - i * 24 * HOUR, 'utc')] = { seen: 1, active: 1 }
    a = recordActivity(a, t, 'utc', 1, 1).activity
    const keys = Object.keys(a.days).sort()
    expect(keys.length).toBe(14)
    expect(keys[keys.length - 1]).toBe('20261007')
  })
})

describe('hourProfile', () => {
  test('a new install gives every hour an even chance', () => {
    expect(hourProfile(null, at('2026-10-07T12:00:00Z'), 'utc').every(p => p === 0.5)).toBe(true)
  })

  test('a week of 9-to-5 makes work hours likely and nights unlikely', () => {
    const now = at('2026-10-07T12:00:00Z')
    const p = hourProfile(nineToFive(now, 7), now, 'utc')
    expect(p[10]).toBe(7.25 / 7.5)
    expect(p[3]).toBe(0.25 / 7.5)
  })
})

describe('forecastLimits', () => {
  test('a 9-to-5 user late in the workday: the week matters more than a quiet session', () => {
    const now = at('2026-10-07T16:30:00Z')
    const activity = nineToFive(now, 7)
    activity.days['20261007'] = { seen: 0xffffff, active: 0b1_1111_1111 << 8 }
    activity.last = { session: 30, week: 60, changedAtMs: now - 5 * 60_000 }
    const pick = forecastLimits({
      nowMs: now,
      zone: 'utc',
      session: { usedPercentage: 30, resetsAt: sec('2026-10-07T18:00:00Z') },
      week: { usedPercentage: 60, resetsAt: sec('2026-10-10T07:00:00Z') },
      activity,
      weekAtDayStart: 50,
    })
    expect(pick).toEqual({ show: 'week' })
  })

  test('agents running around the clock run the week out before it resets', () => {
    const now = at('2026-10-07T12:00:00Z')
    const activity = aroundTheClock(now, 7)
    activity.last = { session: 20, week: 60, changedAtMs: now - 60_000 }
    const pick = forecastLimits({
      nowMs: now,
      zone: 'utc',
      session: { usedPercentage: 20, resetsAt: sec('2026-10-07T15:00:00Z') },
      week: { usedPercentage: 60, resetsAt: sec('2026-10-09T12:00:00Z') },
      activity,
      // 12 active hours today spent 14.4 points: 1.2 points an hour, so the
      // 40 points left last about 34 hours at a 97% chance of working, well
      // before the reset in 48.
      weekAtDayStart: 45.6,
    })
    expect(pick?.show).toBe('week')
    expect(pick?.outAt).toBeGreaterThan(sec('2026-10-08T21:00:00Z'))
    expect(pick?.outAt).toBeLessThan(sec('2026-10-08T23:00:00Z'))
  })

  test('a heavy session runs out within the hour and wins', () => {
    const now = at('2026-10-07T13:00:00Z')
    const activity = aroundTheClock(now, 3)
    activity.last = { session: 80, week: 30, changedAtMs: now - 60_000 }
    const pick = forecastLimits({
      nowMs: now,
      zone: 'utc',
      session: { usedPercentage: 80, resetsAt: sec('2026-10-07T15:00:00Z') },
      week: { usedPercentage: 30, resetsAt: sec('2026-10-12T07:00:00Z') },
      activity,
      weekAtDayStart: 25,
    })
    expect(pick?.show).toBe('session')
    expect(pick?.outAt).toBeLessThan(sec('2026-10-07T14:00:00Z'))
  })

  test('no history yet still picks one', () => {
    const now = at('2026-10-07T12:00:00Z')
    const pick = forecastLimits({
      nowMs: now,
      zone: 'utc',
      session: { usedPercentage: 4, resetsAt: sec('2026-10-07T16:00:00Z') },
      week: { usedPercentage: 58, resetsAt: sec('2026-10-09T07:00:00Z') },
      activity: null,
    })
    expect(pick?.show).toBe('week')
  })

  test('a near tie keeps the previous pick', () => {
    const now = at('2026-10-07T12:00:00Z')
    const input = {
      nowMs: now,
      zone: 'utc' as const,
      // Both end near 50%: the session about 51 at its reset in 10 minutes,
      // the week about 49 at its reset in 30.
      session: { usedPercentage: 50, resetsAt: sec('2026-10-07T12:10:00Z') },
      week: { usedPercentage: 49, resetsAt: sec('2026-10-07T12:30:00Z') },
      activity: null,
    }
    expect(forecastLimits(input)?.show).toBe('session')
    expect(forecastLimits({ ...input, previous: 'week' })?.show).toBe('week')
  })

  test('with only one limit reported there is nothing to choose', () => {
    expect(
      forecastLimits({
        nowMs: at('2026-10-07T12:00:00Z'),
        zone: 'utc',
        week: { usedPercentage: 10, resetsAt: sec('2026-10-09T07:00:00Z') },
        activity: null,
      }),
    ).toBe(null)
  })
})

describe('the line with a forecast', () => {
  const now = at('2026-10-07T12:00:00Z')
  const payload = decodePayload({
    model: { display_name: 'Opus 5.5' },
    workspace: { current_dir: '/r/site', project_dir: '/r/site' },
    rate_limits: {
      five_hour: { used_percentage: 20, resets_at: sec('2026-10-07T15:00:00Z') },
      seven_day: { used_percentage: 60, resets_at: sec('2026-10-09T12:00:00Z') },
    },
  })!
  const config = defaultConfig()
  config.segments.today = false
  config.segments.session = true
  const base = { nowMs: now, zone: 'utc' as const, config, compact: true }
  const week = 'w 60/100 \u00b7 3d left'

  test('the compact layout says when the picked limit runs out, in place of the days left', () => {
    const line = toAnsi(render(payload, { ...base, limits: { show: 'week', outAt: sec('2026-10-08T21:00:00Z') } }), true)
    expect(line).toBe('site \u00b7 Opus 5.5 \u00b7 s 20% \u00b7 w 60/100 \u00b7 out ~Thu')
  })

  test('a pick that does not run out changes nothing', () => {
    const line = toAnsi(render(payload, { ...base, limits: { show: 'session' } }), true)
    expect(line).toBe(`site \u00b7 Opus 5.5 \u00b7 s 20% \u00b7 ${week}`)
  })

  test('without a pick the session shows, in the Go order', () => {
    const line = toAnsi(render(payload, { nowMs: now, zone: 'utc', config }), true)
    expect(line).toBe(`Opus 5.5 \u00b7 site \u00b7 s 20% \u00b7 ${week}`)
  })
})
