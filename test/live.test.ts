import type { SessionUsage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { bandTree, type BandElements } from '../src/band.ts'
import { defaultConfig, parseConfig } from '../src/config.ts'
import { chooseSnapshot, configDirFrom, renderLive, toLimit, toPayload, turnEffort } from '../src/live.ts'
import { decodeLoopState } from '../src/loop.ts'
import { modelName } from '../src/model.ts'
import { render, toAnsi } from '../src/render.ts'
import type { Activity } from '../src/forecast.ts'
import { clock, dateKey, duration, floorInDay } from '../src/timefmt.ts'

describe('modelName', () => {
  const cases: [string, string][] = [
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-sonnet-5-5[1m]', 'Sonnet 5.5'],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
    ['claude-3-5-haiku-20241022', 'Haiku 3.5'],
    ['claude-fable-5-1', 'Fable 5.1'],
    ['claude-opus-4', 'Opus 4'],
    ['gpt-oss', 'gpt-oss'],
    ['claude-unknown-1', 'claude-unknown-1'],
  ]
  for (const [id, want] of cases) test(id, () => expect(modelName(id)).toBe(want))
})

describe('config', () => {
  test('takes valid keys and ignores the rest', () => {
    const c = parseConfig(
      JSON.stringify({
        segments: { duration: false, nope: false },
        thresholds: { contextWarn: 60, headroomGreen: 400 },
        countDirection: { week: 'down', today: 'sideways' },
        projectSlots: { site: 4, bad: 13, frac: 1.5 },
        verbose: true,
      }),
    )
    expect(c.segments.duration).toBe(false)
    expect(c.thresholds.contextWarn).toBe(60)
    expect(c.thresholds.headroomGreen).toBe(30)
    expect(c.countDown).toEqual({ session: false, week: true, today: false })
    expect(c.projectSlots).toEqual({ site: 4 })
    expect(c.verbose).toBe(true)
    expect(c.limits).toBe('auto')
    expect(parseConfig('{"limits": "both"}').limits).toBe('both')
    expect(parseConfig('{"limits": "sideways"}').limits).toBe('auto')
  })

  test('turns the loop and batch segments on by default, each with its own key', () => {
    expect(defaultConfig().segments.loop).toBe(true)
    expect(defaultConfig().segments.batch).toBe(true)
    const c = parseConfig('{"segments": {"batch": false}}')
    expect(c.segments.batch).toBe(false)
    expect(c.segments.loop).toBe(true)
  })

  test('a broken file or a section of the wrong type gives the defaults', () => {
    expect(parseConfig('{not json')).toEqual(defaultConfig())
    expect(parseConfig('{"segments": 5, "verbose": true}')).toEqual(defaultConfig())
  })
})

describe('time formatting', () => {
  const now = Date.parse('2026-09-24T10:00:00Z')
  test('clock', () => {
    expect(clock(Date.parse('2026-09-24T21:00:00Z') / 1000, now, 'utc')).toBe('9pm')
    expect(clock(Date.parse('2026-09-24T15:40:00Z') / 1000, now, 'utc')).toBe('3:40pm')
    expect(clock(Date.parse('2026-09-24T00:05:00Z') / 1000, now, 'utc')).toBe('12:05am')
    expect(clock(Date.parse('2026-09-25T21:00:00Z') / 1000, now, 'utc')).toBe('Fri 9pm')
  })
  test('duration rounds down, as the Go paceline does', () => {
    expect(duration(40_999)).toBe('40s')
    expect(duration(15 * 60_000 + 59_000)).toBe('15m')
    expect(duration(65 * 60_000)).toBe('1h5m')
  })
  test('rounds within a half-hour-offset day', () => {
    // Midnight in India (UTC+5:30). Stepping from the epoch would give 08:00Z.
    const dayStart = Date.parse('2026-10-06T18:30:00Z')
    expect(floorInDay(Date.parse('2026-10-07T08:10:00Z'), 60 * 60_000, dayStart)).toBe(
      Date.parse('2026-10-07T07:30:00Z'),
    )
  })
  test('dateKey reads the local day', () => {
    const local = new Date(2026, 0, 2, 23, 30).getTime()
    expect(dateKey(local, 'local')).toBe('20260102')
  })
})

const usage = (over: Partial<SessionUsage> = {}): SessionUsage =>
  ({
    startedAt: Date.parse('2026-09-24T09:44:00Z'),
    context: { window: 200_000, percent: 72 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 16, resetsAt: '2026-09-24T12:20:00Z' },
      { kind: 'seven_day', percentUsed: 4, resetsAt: '2026-09-27T07:00:00Z' },
    ],
    ...over,
  }) as SessionUsage

describe('live adapter', () => {
  const nowMs = Date.parse('2026-09-24T10:00:00Z')
  const figures = {
    usage: usage(),
    modelId: 'claude-opus-5-5',
    cwd: 'C:/r/techcentral',
    root: 'C:/r/techcentral',
    sessionId: 'abc',
    nowMs,
    settings: { effortLevel: 'high' },
  }

  test('builds the payload the renderer reads', () => {
    const p = toPayload(figures)
    expect(p.model).toEqual({ displayName: 'Opus 5.5' })
    expect(p.effort).toEqual({ level: 'high' })
    expect(p.fastMode).toBe(false)
    expect(p.rateLimits?.fiveHour).toEqual({ usedPercentage: 16, resetsAt: Date.parse('2026-09-24T12:20:00Z') / 1000 })
    expect(p.contextWindow).toEqual({ usedPercentage: 72 })
    expect(p.cost).toEqual({ totalDurationMs: 16 * 60_000 })
  })

  test('the latest turn effort wins over the setting', () => {
    expect(toPayload({ ...figures, effort: 'max' }).effort).toEqual({ level: 'max' })
  })

  test('a window with no reset time keeps its usage', () => {
    expect(toLimit({ kind: 'five_hour', percentUsed: 30 })).toEqual({ usedPercentage: 30, resetsAt: undefined })
    expect(toLimit(undefined)).toBe(undefined)
  })

  const state = { snapshot: null, branch: 'dev', run: null, activity: null, nowMs, batch: null, loop: null }

  describe('effort from a hook event', () => {
    test("a tool event's effort level is recorded", () => {
      expect(turnEffort('high', { effort: { level: 'max' } })).toBe('max')
      expect(turnEffort(undefined, { effort: { level: 'low' } })).toBe('low')
    })

    test('an event with no effort keeps the cached level', () => {
      expect(turnEffort('high', {})).toBe('high')
      expect(turnEffort('high', { effort: {} })).toBe('high')
      expect(turnEffort(undefined, {})).toBe(undefined)
    })

    test('an empty level keeps the cached level', () => {
      expect(turnEffort('high', { effort: { level: '' } })).toBe('high')
    })

    test("a subagent's effort is ignored", () => {
      expect(turnEffort('high', { effort: { level: 'low' }, agent_id: 'agent-7' })).toBe('high')
      expect(turnEffort(undefined, { effort: { level: 'low' }, agent_id: 'agent-7' })).toBe(undefined)
    })

    test('a quiet level recorded over high draws no effort label', () => {
      const drawn = (cached: string | undefined) =>
        toAnsi(renderLive(toPayload({ ...figures, effort: cached }), defaultConfig(), state).line, true)
      expect(drawn('high').includes('high')).toBe(true)
      const after = drawn(turnEffort('high', { effort: { level: 'medium' } }))
      expect(after.includes('high')).toBe(false)
      expect(after.includes('medium')).toBe(false)
    })
  })

  test('draws the loop and batch before the duration, and drops each when toggled off', () => {
    const loop = decodeLoopState(
      JSON.stringify({ phase: 'build', inFlight: 44, issues: [{ n: 43, status: 'done' }, { n: 44, status: 'pending' }] }),
    )
    const withBoth = {
      ...state,
      loop: loop && { state: loop, mtimeMs: nowMs - 60_000 },
      batch: { commits: 3, issues: 7, reviews: [], sinceLastReview: 0 as const },
    }
    const tail = ' \u00b7 loop \u25b0\u25b0 #44 1/2 \u00b7 7 issues \u00b7 no review yet \u00b7 16m'
    expect(toAnsi(renderLive(toPayload(figures), defaultConfig(), withBoth).line, true).endsWith(tail)).toBe(true)

    const off = defaultConfig()
    off.segments.loop = false
    off.segments.batch = false
    const plain = toAnsi(renderLive(toPayload(figures), off, withBoth).line, true)
    expect(plain.endsWith(' \u00b7 ctx 72% \u00b7 16m')).toBe(true)
    expect(plain.includes('loop')).toBe(false)
    expect(plain.includes('issues')).toBe(false)
  })

  test('renders the whole line, compact, and anchors today', () => {
    const p = toPayload(figures)
    const { line, save, pick } = renderLive(p, defaultConfig(), state)
    expect(save?.usedAtStart).toBe(4)
    // Neither limit runs out, so neither warns; the session ends its window
    // closer to 100%.
    expect(pick).toEqual({ show: 'session' })
    // The budget is longer than the bar's 28 cells, so the bar scales down,
    // marker included. Where the marker falls, and the budget and savings
    // figures, depend on the local time of day, which follows the time zone
    // the test runs in. So check the bar's shape and the rest of the line.
    const text = toAnsi(line, true)
    const bar = /\u2595(\u2588*)\u2502(\u2588*)\u258f/.exec(text)
    expect(bar).not.toBe(null)
    expect(bar![1].length + bar![2].length).toBe(28)
    expect(text.replace(bar![0], 'BAR').replace(/ 0\/\d+ \+\d+ saved/, ' BUDGET')).toBe(
      'techcentral (dev) \u00b7 Opus 5.5 \u00b7 high \u00b7 Today: BAR BUDGET \u00b7 w 4/100 \u00b7 3d left \u00b7 ctx 72% \u00b7 16m',
    )
  })

  test('limits "both" shows a session turned on before today', () => {
    const config = defaultConfig()
    config.limits = 'both'
    config.segments.session = true
    const { line, pick } = renderLive(toPayload(figures), config, state)
    expect(pick).toBe(null)
    expect(toAnsi(line, true).startsWith('techcentral (dev) \u00b7 Opus 5.5 \u00b7 high \u00b7 s 16% \u00b7 Today: ')).toBe(true)
  })

  test('a week forecast to run out says when, after the week figure', () => {
    // Agents running around the clock: every hour active for a week, 14.4
    // points spent today, 40 points left, and two days to the reset.
    const now = Date.parse('2026-10-07T12:00:00Z')
    const activity: Activity = { days: {}, last: { session: 20, week: 60, changedAtMs: now - 60_000 } }
    for (let i = 1; i <= 7; i++) {
      activity.days[dateKey(now - i * 24 * 3600_000, 'local')] = { seen: 0xffffff, active: 0xffffff }
    }
    // Today so far: twelve active hours, counted in the zone the line renders in.
    const localHour = new Date(now).getHours()
    activity.days[dateKey(now, 'local')] = { seen: 0xffffff, active: (1 << localHour) - 1 }
    const weekReset = '2026-10-09T12:00:00Z'
    const p = toPayload({
      ...figures,
      nowMs: now,
      usage: usage({
        startedAt: now - 60 * 60_000,
        rateLimits: [
          { kind: 'five_hour', percentUsed: 20, resetsAt: '2026-10-07T15:00:00Z' },
          { kind: 'seven_day', percentUsed: 60, resetsAt: weekReset },
        ],
      }),
    })
    const snapshot = { date: dateKey(now, 'local'), resetsAt: Date.parse(weekReset) / 1000, usedAtStart: 45.6 }
    const { line, pick } = renderLive(p, defaultConfig(), { ...state, nowMs: now, snapshot, activity })
    expect(pick?.show).toBe('week')
    expect(pick?.outAt).toBeDefined()
    const figure = line.findIndex(segment => segment[0].text === 'w 60/100')
    expect(line[figure + 1].length).toBe(1)
    expect(line[figure + 1][0].text.startsWith('out ~')).toBe(true)
  })

  test("the Go paceline's anchor wins only for the same day and week", () => {
    const week = { usedPercentage: 10, resetsAt: 1790499600 }
    const go = JSON.stringify({ date: '20260924', resetsAt: 1790499600, usedAtStart: 4 })
    const stored = { date: '20260924', resetsAt: 1790499600, usedAtStart: 6 }
    expect(chooseSnapshot(go, stored, '20260924', week)?.usedAtStart).toBe(4)
    expect(chooseSnapshot(go, stored, '20260925', week)?.usedAtStart).toBe(6)
    expect(chooseSnapshot(go, stored, '20260924', { ...week, resetsAt: 1 })?.usedAtStart).toBe(6)
    expect(chooseSnapshot(go, stored, '20260924', { ...week, usedPercentage: 2 })?.usedAtStart).toBe(6)
    expect(chooseSnapshot('{oops', 'nope', '20260924', week)).toBe(null)
  })

  test('config dir', () => {
    expect(configDirFrom({ claudeConfigDir: 'D:\\cfg\\' })).toBe('D:/cfg')
    expect(configDirFrom({ userProfile: 'C:\\Users\\me', home: '/c/Users/me' })).toBe('C:/Users/me/.claude')
    expect(configDirFrom({ home: '/home/me' })).toBe('/home/me/.claude')
    expect(configDirFrom({})).toBe('.claude')
  })
})

describe('band', () => {
  type Node = { type: string; props: Record<string, unknown> }
  const el: BandElements = {
    Box: props => ({ type: 'Box', props }) as never,
    Text: props => ({ type: 'Text', props }) as never,
  }
  const p = toPayload({
    usage: usage(),
    modelId: 'claude-opus-5-5',
    cwd: '/r/site',
    root: '/r/site',
    sessionId: 'abc',
    nowMs: Date.parse('2026-09-24T10:00:00Z'),
    settings: {},
  })
  const line = render(p, { nowMs: Date.parse('2026-09-24T10:00:00Z'), zone: 'utc', config: defaultConfig() })

  test('one wrapping row, a box per segment, dots between', () => {
    const tree = bandTree(line, el, 'terminal') as unknown as Node
    expect(tree.props.flexWrap).toBe('wrap')
    const segments = tree.props.children as Node[]
    expect(segments.length).toBe(line.length)
    const firstKids = segments[0].props.children as Node[]
    const secondKids = segments[1].props.children as Node[]
    expect(firstKids[0].props).toEqual({ color: 'cyan', children: ['Opus 5.5'] })
    expect(secondKids[0].props).toEqual({ color: '#767676', children: [' \u00b7 '] })
  })

  test('the terminal keeps its own palette; other surfaces get fixed colors', () => {
    const color = (surface: 'terminal' | 'desktop') => {
      const tree = bandTree(line, el, surface) as unknown as Node
      const kids = (tree.props.children as Node[])[0].props.children as Node[]
      return kids[0].props.color
    }
    expect(color('terminal')).toBe('cyan')
    expect(color('desktop')).toBe('#2f9fbf')
  })

  test('the terminal indents the band to line up with the rows under the prompt', () => {
    const pad = (surface: 'terminal' | 'desktop') =>
      (bandTree(line, el, surface) as unknown as Node).props.paddingLeft
    expect(pad('terminal')).toBe(2)
    expect(pad('desktop')).toBeUndefined()
  })
})
