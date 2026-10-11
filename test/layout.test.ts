import { describe, expect, test } from 'claude-code/testing'

import { defaultConfig, type Config } from '../src/config.ts'
import type { Snapshot } from '../src/pace.ts'
import { decodePayload } from '../src/payload.ts'
import type { Run } from '../src/progress.ts'
import { render, toAnsi, type LimitPick, type RenderContext, type Segment, type Tone } from '../src/render.ts'

const DOT = ' \u00b7 '
const FULL = '\u25b0'
const EMPTY = '\u25b1'
const sec = (iso: string) => Date.parse(iso) / 1000

// Wednesday noon. The week resets two days from midnight and stood at 40%
// when the day began, so today's budget is 30 points of the week: each point
// spent is 3.33% of the budget.
const NOW = Date.parse('2026-10-07T12:00:00Z')
const WEEK_RESET = sec('2026-10-09T00:00:00Z')
const SNAPSHOT: Snapshot = { date: '20261007', resetsAt: WEEK_RESET, usedAtStart: 40 }

type Figures = {
  week?: number
  session?: number
  effort?: string
  fast?: boolean
  context?: number
  cacheCold?: boolean
}

function payload(f: Figures = {}) {
  return decodePayload({
    model: { display_name: 'Opus 5.5' },
    effort: { level: f.effort ?? 'high' },
    fast_mode: f.fast ?? false,
    workspace: { current_dir: '/r/paceline', project_dir: '/r/paceline' },
    rate_limits: {
      five_hour: { used_percentage: f.session ?? 4, resets_at: sec('2026-10-07T14:30:00Z') },
      seven_day: { used_percentage: f.week ?? 46, resets_at: WEEK_RESET },
    },
    context_window: { used_percentage: f.context ?? 30 },
    prompt_cache: f.cacheCold ? { expires_at: sec('2026-10-07T11:00:00Z') } : undefined,
    cost: { total_duration_ms: 59 * 60_000 },
  })!
}

function compact(
  f: Figures,
  config: Config = defaultConfig(),
  limits?: LimitPick,
  more: Partial<RenderContext> = {},
) {
  return render(payload(f), {
    nowMs: NOW,
    zone: 'utc',
    config,
    readSnapshot: () => SNAPSHOT,
    branch: () => 'dev',
    compact: true,
    limits,
    ...more,
  })
}

/** A config with only today's segment on, so the line is just the bar. */
function todayOnly(change: (c: Config) => void = () => {}): Config {
  const c = defaultConfig()
  for (const key of Object.keys(c.segments) as (keyof Config['segments'])[]) c.segments[key] = false
  c.segments.today = true
  change(c)
  return c
}

/** Today's bar for `week` percent of the week used. */
const bar = (week: number, config = todayOnly()): Segment => compact({ week }, config)[0]

describe('compact layout', () => {
  test('today bar fill and colors', () => {
    // Points spent today, and the bar they draw: cells round to the nearest
    // fifth of the budget, in the headroom tone of what's left.
    const cases: [number, number, Tone][] = [
      [0, 0, 'green'], //     0% used
      [2.7, 0, 'green'], //   9% used
      [3, 1, 'green'], //    10% used, a half cell rounds up
      [5.7, 1, 'green'], //  19% used
      [6, 1, 'green'], //    20% used
      [15, 3, 'green'], //   50% used
      [22.5, 4, 'yellow'], // 75% used, 25% left
      [27, 5, 'red'], //     90% used, 10% left
      [30, 5, 'red'], //    100% used, not over
    ]
    for (const [spent, filled, tone] of cases) {
      const want: Segment = [{ text: 't ' + FULL.repeat(filled), tone }]
      if (filled < 5) want.push({ text: EMPTY.repeat(5 - filled), tone: 'dim' })
      expect(`${spent}: ${JSON.stringify(bar(40 + spent))}`).toBe(`${spent}: ${JSON.stringify(want)}`)
    }
  })

  test('counting down fills what is left', () => {
    const down = todayOnly(c => {
      c.countDown.today = true
    })
    expect(bar(46, down)).toEqual([
      { text: 't ' + FULL.repeat(4), tone: 'green' },
      { text: EMPTY, tone: 'dim' },
    ])
    expect(bar(64, down)).toEqual([
      { text: 't ' + FULL, tone: 'yellow' },
      { text: EMPTY.repeat(4), tone: 'dim' },
    ])
  })

  test('verbose labels the bar today', () => {
    const verbose = todayOnly(c => {
      c.verbose = true
    })
    expect(toAnsi([bar(46, verbose)], true)).toBe('today ' + FULL + EMPTY.repeat(4))
  })

  test('over budget shows a full red bar and how far over', () => {
    expect(bar(76)).toEqual([
      { text: 't ' + FULL.repeat(5), tone: 'red' },
      { text: '+20%', tone: 'red' },
    ])
    // Just past the budget rounds to 100%; it still reads as over.
    expect(toAnsi([bar(70.1)], true)).toBe('t ' + FULL.repeat(5) + '+1%')
    const down = todayOnly(c => {
      c.countDown.today = true
    })
    expect(bar(76, down)).toEqual([
      { text: 't ', tone: 'red' },
      { text: EMPTY.repeat(5), tone: 'dim' },
      { text: '+20%', tone: 'red' },
    ])
  })

  test('counting down at exactly the budget is an empty red bar, not over', () => {
    const down = todayOnly(c => {
      c.countDown.today = true
    })
    expect(bar(70, down)).toEqual([
      { text: 't ', tone: 'red' },
      { text: EMPTY.repeat(5), tone: 'dim' },
    ])
  })

  test('compact order with no warning', () => {
    const quiet: LimitPick = { show: 'week' }
    expect(toAnsi(compact({}, defaultConfig(), quiet), true)).toBe(
      ['t ' + FULL + EMPTY.repeat(4), 'paceline (dev)', 'Opus 5.5', 'high', '59m'].join(DOT),
    )
    expect(toAnsi(compact({ fast: true, context: 80, cacheCold: true }, defaultConfig(), quiet), true)).toBe(
      [
        't ' + FULL + EMPTY.repeat(4),
        'paceline (dev)',
        'Opus 5.5',
        'high',
        'fast mode',
        'ctx 80%',
        'cache cold: ~2x',
        '59m',
      ].join(DOT),
    )
  })

  test('effort is the bare level, dim, and verbose spells it out', () => {
    const line = compact({}, defaultConfig(), { show: 'week' })
    expect(line[3]).toEqual([{ text: 'high', tone: 'dim' }])
    const verbose = defaultConfig()
    verbose.verbose = true
    expect(compact({}, verbose, { show: 'week' })[3]).toEqual([{ text: 'high effort', tone: 'dim' }])
    // An everyday level stays quiet, as in the Go layout.
    expect(toAnsi(compact({ effort: 'medium' }, defaultConfig(), { show: 'week' }), true)).toBe(
      ['t ' + FULL + EMPTY.repeat(4), 'paceline (dev)', 'Opus 5.5', '59m'].join(DOT),
    )
  })

  test('week warning', () => {
    const warning = (outAt: string, config = defaultConfig()) =>
      compact({}, config, { show: 'week', outAt: sec(outAt) })[1]
    // More than a day away: yellow, rounded down to the hour.
    expect(warning('2026-10-08T21:40:00Z')).toEqual([{ text: 'w\u2192Thu 9pm', tone: 'yellow' }])
    expect(warning('2026-10-08T12:30:00Z')).toEqual([{ text: 'w\u2192Thu 12pm', tone: 'yellow' }])
    // Exactly a day away is within a day.
    expect(warning('2026-10-08T12:00:00Z')).toEqual([{ text: 'w\u2192Thu 12pm', tone: 'red' }])
    expect(warning('2026-10-08T09:59:00Z')).toEqual([{ text: 'w\u2192Thu 9am', tone: 'red' }])
    expect(warning('2026-10-07T18:20:00Z')).toEqual([{ text: 'w\u21926pm', tone: 'red' }])
    const verbose = defaultConfig()
    verbose.verbose = true
    expect(warning('2026-10-08T21:40:00Z', verbose)).toEqual([{ text: 'week\u2192Thu 9pm', tone: 'yellow' }])
    expect(toAnsi(compact({}, defaultConfig(), { show: 'week', outAt: sec('2026-10-08T21:40:00Z') }), true)).toBe(
      ['t ' + FULL + EMPTY.repeat(4), 'w\u2192Thu 9pm', 'paceline (dev)', 'Opus 5.5', 'high', '59m'].join(DOT),
    )
  })

  test('session warning', () => {
    const warning = (outAt: string, config = defaultConfig()) =>
      compact({ session: 80 }, config, { show: 'session', outAt: sec(outAt) })[1]
    expect(warning('2026-10-07T13:59:00Z')).toEqual([{ text: 's\u21921:45pm', tone: 'red' }])
    expect(warning('2026-10-07T13:00:00Z')).toEqual([{ text: 's\u21921pm', tone: 'red' }])
    expect(warning('2026-10-07T12:14:59Z')).toEqual([{ text: 's\u219212pm', tone: 'red' }])
    const verbose = defaultConfig()
    verbose.verbose = true
    expect(warning('2026-10-07T13:59:00Z', verbose)).toEqual([{ text: 'session\u21921:45pm', tone: 'red' }])
  })

  test('an out time inside the current step shows the exact minute, not a time already passed', () => {
    const warningAt = (now: string, pick: LimitPick) =>
      compact({ session: 80 }, defaultConfig(), pick, { nowMs: Date.parse(now) })[1]
    expect(warningAt('2026-10-07T13:52:00Z', { show: 'session', outAt: sec('2026-10-07T13:58:00Z') })).toEqual([
      { text: 's\u21921:58pm', tone: 'red' },
    ])
    expect(warningAt('2026-10-07T12:20:00Z', { show: 'week', outAt: sec('2026-10-07T12:50:00Z') })).toEqual([
      { text: 'w\u219212:50pm', tone: 'red' },
    ])
    // Rounding down to exactly now is not in the past.
    expect(warningAt('2026-10-07T13:45:00Z', { show: 'session', outAt: sec('2026-10-07T13:58:00Z') })).toEqual([
      { text: 's\u21921:45pm', tone: 'red' },
    ])
  })

  test('progress sits between cache and duration', () => {
    const step = (id: string, status: 'done' | 'active' | 'pending') => ({
      id,
      label: '#' + id,
      status,
      weight: 0,
      stages: [],
      stage: '',
    })
    const run: Run = {
      name: 'loop',
      phase: 'running',
      label: '',
      steps: [step('1', 'done'), step('2', 'active'), step('3', 'pending')],
      updatedAtMs: NOW,
    }
    const line = compact({ context: 80, cacheCold: true }, defaultConfig(), { show: 'week' }, { progress: () => run })
    expect(toAnsi(line, true)).toBe(
      [
        't ' + FULL + EMPTY.repeat(4),
        'paceline (dev)',
        'Opus 5.5',
        'high',
        'ctx 80%',
        'cache cold: ~2x',
        'loop ' + FULL + FULL + EMPTY + ' #2 1/3',
        '59m',
      ].join(DOT),
    )
  })

  test('the Go layout ignores a pick', () => {
    const ctx = { nowMs: NOW, zone: 'utc' as const, config: defaultConfig(), readSnapshot: () => SNAPSHOT }
    const pick: LimitPick = { show: 'week', outAt: sec('2026-10-08T21:40:00Z') }
    expect(toAnsi(render(payload(), { ...ctx, limits: pick }))).toBe(toAnsi(render(payload(), ctx)))
  })

  test('no warning without an out time', () => {
    const want = ['t ' + FULL + EMPTY.repeat(4), 'paceline (dev)', 'Opus 5.5', 'high', '59m'].join(DOT)
    expect(toAnsi(compact({ session: 80 }, defaultConfig(), { show: 'session' }), true)).toBe(want)
    expect(toAnsi(compact({}, defaultConfig(), { show: 'week' }), true)).toBe(want)
  })

  test('a limit turned off in the config never warns', () => {
    const config = defaultConfig()
    config.segments.week = false
    const line = compact({}, config, { show: 'week', outAt: sec('2026-10-08T21:40:00Z') })
    expect(toAnsi(line, true)).toBe(
      ['t ' + FULL + EMPTY.repeat(4), 'paceline (dev)', 'Opus 5.5', 'high', '59m'].join(DOT),
    )
  })

  test('limits both shows both percentages', () => {
    expect(toAnsi(compact({}), true)).toBe(
      ['t ' + FULL + EMPTY.repeat(4), 's 4%', 'w 46%', 'paceline (dev)', 'Opus 5.5', 'high', '59m'].join(DOT),
    )
    // The session's reset time shows once its headroom runs low, as in the Go layout.
    const line = compact({ session: 80 })
    expect(line[1]).toEqual([{ text: 's 80% (resets 2:30pm)', tone: 'yellow' }])
  })

  test('with no rate limits there is no bar and no warning', () => {
    const p = payload()
    p.rateLimits = undefined
    const line = render(p, { nowMs: NOW, zone: 'utc', config: defaultConfig(), branch: () => 'dev', compact: true })
    expect(toAnsi(line, true)).toBe(['paceline (dev)', 'Opus 5.5', 'high', '59m'].join(DOT))
  })
})
