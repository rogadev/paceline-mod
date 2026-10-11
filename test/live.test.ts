import type { SessionUsage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { bandTree, type BandElements } from '../src/band.ts'
import { defaultConfig, parseConfig } from '../src/config.ts'
import { branchIn, findGitDir, type GitFs } from '../src/gitinfo.ts'
import { chooseSnapshot, configDirFrom, renderLive, toLimit, toPayload } from '../src/live.ts'
import { modelName } from '../src/model.ts'
import { render, toAnsi } from '../src/render.ts'
import { clock, dateKey, duration } from '../src/timefmt.ts'

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

function fakeFs(files: Record<string, string>, dirs: string[]): GitFs {
  return {
    kind: async path => (path in files ? 'file' : dirs.includes(path) ? 'dir' : null),
    read: async path => files[path] ?? null,
  }
}

describe('git branch', () => {
  test('walks up to the repository and reads the branch', async () => {
    const fs = fakeFs({ 'C:/r/app/.git/HEAD': 'ref: refs/heads/dev\n' }, ['C:/r/app/.git'])
    const gitDir = await findGitDir(fs, 'C:\\r\\app\\src\\deep')
    expect(gitDir).toBe('C:/r/app/.git')
    expect(await branchIn(fs, gitDir)).toBe('dev')
  })

  test('follows a worktree .git file', async () => {
    const fs = fakeFs(
      { '/w/tree/.git': 'gitdir: /r/app/.git/worktrees/tree\n', '/r/app/.git/worktrees/tree/HEAD': 'ref: refs/heads/feat/x' },
      [],
    )
    const gitDir = await findGitDir(fs, '/w/tree')
    expect(gitDir).toBe('/r/app/.git/worktrees/tree')
    expect(await branchIn(fs, gitDir)).toBe('feat/x')
  })

  test('shows a detached head and caps a long branch', async () => {
    const sha = 'a'.repeat(40)
    expect(await branchIn(fakeFs({ '/g/HEAD': sha }, []), '/g')).toBe('detached aaaaaaa')
    const long = await branchIn(fakeFs({ '/g/HEAD': 'ref: refs/heads/' + 'b'.repeat(40) }, []), '/g')
    expect(long).toBe('b'.repeat(31) + '\u2026')
  })

  test('outside a repository there is no branch', async () => {
    const fs = fakeFs({}, [])
    expect(await findGitDir(fs, 'C:/nowhere/at/all')).toBe('')
    expect(await findGitDir(fs, '/nowhere')).toBe('')
    expect(await branchIn(fs, '')).toBe('')
  })
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

  test('renders the whole line and anchors today', () => {
    const p = toPayload(figures)
    const { line, save } = renderLive(p, defaultConfig(), null, 'dev', null, nowMs)
    expect(save?.usedAtStart).toBe(4)
    const text = toAnsi(line, true)
    expect(text.startsWith('Opus 5.5 \u00b7 high effort \u00b7 techcentral (dev) \u00b7 s 16% \u00b7 w 4% \u00b7 t 0% of ')).toBe(true)
    expect(text.endsWith(' \u00b7 ctx 72% \u00b7 16m')).toBe(true)
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
    expect(secondKids[0].props).toEqual({ dimColor: true, children: [' \u00b7 '] })
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
})
