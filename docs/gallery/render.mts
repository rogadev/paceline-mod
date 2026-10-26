/**
 * Draws docs/paceline-states.svg, the README's gallery of the line's states,
 * through the mod's own renderer in the compact layout, so the image shows
 * exactly what the code draws.
 *
 * Run from anywhere with Node 23.6 or later, which runs TypeScript directly:
 *
 *   node docs/gallery/render.mts
 *
 * The figures are fixed: Wednesday 09:00 UTC, the week resetting three days
 * from midnight, and 58% of the week used when the day began, which leaves
 * 42 points over 3 days, the typical 14 a day (100 / 7). The colors are
 * Windows Terminal's default Campbell palette, as the terminal draws the
 * line's named tones. This script is a docs tool; the mod never loads it.
 */

import { writeFileSync } from 'node:fs'

import { defaultConfig, type Config } from '../../src/config.ts'
import { decodePayload } from '../../src/payload.ts'
import type { BatchState } from '../../src/batch.ts'
import type { LoopFile } from '../../src/loop.ts'
import type { Run } from '../../src/progress.ts'
import { render, type Line, type RenderContext, type Tone } from '../../src/render.ts'

const OUT = new URL('../paceline-states.svg', import.meta.url)
const DOT = ' \u00b7 '

const sec = (iso: string) => Date.parse(iso) / 1000
const NOW = Date.parse('2026-10-07T09:00:00Z')
const RESET = sec('2026-10-10T00:00:00Z')
const LAST_DAY_RESET = sec('2026-10-08T00:00:00Z')

type Figures = {
  /** The week's used percentage now. */
  week: number
  /** The week's used percentage when the day began. */
  start: number
  reset?: number
  session?: number
  effort?: string
  fast?: boolean
  context?: number
  /** How long the session has run, in minutes. */
  minutes?: number
}

function draw(f: Figures, setup: (c: Config) => void = () => {}, more: Partial<RenderContext> = {}): Line {
  const config = defaultConfig()
  setup(config)
  const payload = decodePayload({
    model: { display_name: 'Opus 5.5' },
    effort: { level: f.effort ?? 'high' },
    fast_mode: f.fast ?? false,
    workspace: { current_dir: '/r/paceline', project_dir: '/r/paceline' },
    rate_limits: {
      five_hour: { used_percentage: f.session ?? 22, resets_at: sec('2026-10-07T11:30:00Z') },
      seven_day: { used_percentage: f.week, resets_at: f.reset ?? RESET },
    },
    context_window: { used_percentage: f.context ?? 30 },
    cost: { total_duration_ms: (f.minutes ?? 16) * 60_000 },
  })!
  const snapshot = { date: '20261007', resetsAt: f.reset ?? RESET, usedAtStart: f.start }
  return render(payload, {
    nowMs: NOW,
    zone: 'utc',
    config,
    readSnapshot: () => snapshot,
    saveSnapshot: () => {},
    branch: () => 'dev',
    compact: true,
    limits: { show: 'week' },
    ...more,
  })
}

// A regular agent loop on its third of five equal steps.
const RUN: Run = {
  name: 'loop',
  phase: 'running',
  label: '',
  updatedAtMs: NOW,
  steps: ['#41', '#42', '#43', '#44', '#45'].map((label, i) => ({
    id: String(i),
    label,
    status: i < 2 ? 'done' : i === 2 ? 'active' : 'pending',
    weight: 1,
    stages: [],
    stage: '',
  })),
}

/**
 * One row of the gallery. `bar` draws an arrow under today's bar: `drain`
 * points left, the way spending empties the full cells, and `fill` points
 * right, the way an overage fills the red cells. `focus` underlines what the
 * row is about: each entry is the start of a segment's text, or failing that,
 * of one span's text.
 */
type State = { title: string; note: string; line: Line; bar?: 'drain' | 'fill'; focus?: string[] }

// An /orc-loop run building issue 44, two of five issues settled.
const LOOP: LoopFile = {
  mtimeMs: NOW - 5 * 60_000,
  state: {
    phase: 'build',
    inFlight: 44,
    reviewRound: 0,
    progressOn: false,
    issues: [
      { n: 41, status: 'done' },
      { n: 42, status: 'done' },
      { n: 44, status: 'pending' },
      { n: 45, status: 'pending' },
      { n: 46, status: 'pending' },
    ],
  },
}

// A dev -> main batch of nine commits for seven issues, reviewed twice, the
// last review ready and current.
const BATCH: BatchState = {
  commits: 9,
  issues: 7,
  sinceLastReview: 0,
  reviews: [
    { head: 'a1b2c3d', verdict: 'other', blockers: 1, warnings: 2 },
    { head: 'e4f5a6b', verdict: 'ready', blockers: 0, warnings: 0 },
  ],
}

const STATES: State[] = [
  {
    title: 'Fresh day',
    focus: ['0/14'],
    note: 'The day starts with its budget, 14 points of the week; none of it is spent.',
    line: draw({ week: 58, start: 58, minutes: 2 }),
  },
  {
    title: 'Working through the day',
    bar: 'drain',
    note: 'Spent points drain the bar; green while there is room.',
    line: draw({ week: 63, start: 58, minutes: 47 }),
  },
  {
    title: 'Session time',
    focus: ['2h12m'],
    note: 'How long this session has been running; it counts up as you work.',
    line: draw({ week: 64, start: 58, minutes: 132 }),
  },
  {
    title: 'Most of the budget used',
    bar: 'drain', focus: ['11/14'],
    note: 'Yellow past 70% of the budget, red past 85%.',
    line: draw({ week: 69, start: 58, minutes: 112 }),
  },
  {
    title: 'Over budget',
    bar: 'fill', focus: ['\u2192'],
    note: "The overage turns red, and tomorrow's budget shrinks to match.",
    line: draw({ week: 75, start: 58, minutes: 160 }),
  },
  {
    title: 'Over budget by a whole day',
    bar: 'fill', focus: ['\u2192'],
    note: 'Twice the budget fills the bar with red, and tomorrow gets half a day.',
    line: draw({ week: 86, start: 58, minutes: 255 }),
  },
  {
    title: 'Week forecast to run out',
    focus: ['out ~'],
    note: 'At the current pace the week ends before it resets.',
    line: draw({ week: 67, start: 58, minutes: 38 }, undefined, { limits: { show: 'week', outAt: sec('2026-10-09T15:00:00Z') } }),
  },
  {
    title: 'Session running low',
    focus: ['s 72%', 'out ~'],
    note: 'With the session segment on, its reset time becomes out ~10:15am, in red.',
    line: draw(
      { week: 63, start: 58, session: 72, minutes: 185 },
      c => {
        c.segments.session = true
      },
      { limits: { show: 'session', outAt: sec('2026-10-07T10:15:00Z') } },
    ),
  },
  {
    title: 'The last day',
    focus: ['+', 'last day'],
    note: "Whatever the week has left is today's budget; with plenty left, go hard if you need to.",
    line: draw({ week: 66, start: 60, reset: LAST_DAY_RESET, minutes: 70 }),
  },
  {
    title: 'Agent job in progress',
    focus: ['ctx', 'loop'],
    note: 'A long agent job, such as a loop, shows its progress; the context warning appears at 70%.',
    line: draw({ week: 63, start: 58, context: 74, minutes: 322 }, undefined, { progress: () => RUN }),
  },
  {
    title: 'An /orc-loop run and its review batch',
    focus: ['loop', '7 issues'],
    note: "orc-pack's /orc-loop: one cell per issue, and where the dev -> main batch stands in review.",
    line: draw({ week: 63, start: 58, minutes: 214 }, undefined, { loop: () => LOOP, batch: () => BATCH }),
  },
  {
    title: 'Verbose, counting down, fast mode',
    focus: ['max effort', 'fast mode', '8/14 left', 'week'],
    note: 'verbose and countDirection in paceline.json; fast mode from settings.',
    line: draw({ week: 64, start: 58, effort: 'max', fast: true, minutes: 9 }, c => {
      c.verbose = true
      c.countDown.today = true
      c.countDown.week = true
    }),
  },
  {
    title: 'Both limits, as the Go line',
    focus: ['s 22%'],
    note: '"limits": "both" skips the forecast and shows the session too.',
    line: draw(
      { week: 63, start: 58, minutes: 25 },
      c => {
        c.limits = 'both'
        c.segments.session = true
      },
      { limits: undefined },
    ),
  },
]

// Windows Terminal's Campbell palette for the named tones; red is the line's
// own muted red, which the renderer passes as a named tone.
const PALETTE: Record<string, string> = {
  plain: '#cccccc',
  dim: '#767676',
  cyan: '#3a96dd',
  green: '#13a10e',
  yellow: '#c19c00',
  red: '#b92f2f',
}
const MARK = '#e8c468'
const CELL_WIDTH = 8.4
const ROW_HEIGHT = 86
// Below the line's baseline: the markers, then the note.
const MARK_GAP = 9
const NOTE_GAP = 30

const BAR_CELL = /^[\u2588\u2591\u2592]+$/

const fill = (tone: Tone) =>
  typeof tone === 'string' ? PALETTE[tone] : '#' + tone.map(v => v.toString(16).padStart(2, '0')).join('')
const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

type Placed = { text: string; x0: number; x1: number }

// Lays the line out in cells and returns its text nodes, with where each
// segment and span landed.
function lineRow(line: Line, y: number) {
  const nodes: string[] = []
  const segments: Placed[] = []
  const spans: Placed[] = []
  let x = 24
  const put = (text: string, tone: Tone, bold = false) => {
    const width = CELL_WIDTH * [...text].length
    nodes.push(
      `<text x="${x.toFixed(1)}" y="${y}" textLength="${width.toFixed(1)}" lengthAdjust="spacing" ` +
        `fill="${fill(tone)}"${bold ? ' class="b"' : ''} xml:space="preserve">${escape(text)}</text>`,
    )
    const placed = { text, x0: x, x1: x + width }
    x += width
    return placed
  }
  line.forEach((segment, i) => {
    if (i > 0) put(DOT, 'dim')
    const x0 = x
    for (const s of segment) spans.push(put(s.text, s.tone, s.bold))
    segments.push({ text: segment.map(s => s.text).join(''), x0, x1: x })
  })
  return { nodes, segments, spans }
}

const arrow = (from: number, to: number, y: number) =>
  `<line x1="${from.toFixed(1)}" y1="${y}" x2="${to.toFixed(1)}" y2="${y}" stroke="${MARK}" stroke-width="1.5" marker-end="url(#head)"/>`

// An underline with short ends turned up toward the text it marks.
const bracket = (x0: number, x1: number, y: number) =>
  `<path d="M${(x0 + 1).toFixed(1)} ${y - 4}V${y}H${(x1 - 1).toFixed(1)}V${y - 4}" fill="none" stroke="${MARK}" stroke-width="1.5"/>`

function marks(s: State, row: ReturnType<typeof lineRow>, y: number): string[] {
  const out: string[] = []
  if (s.bar) {
    const cells = row.spans.filter(p => BAR_CELL.test(p.text))
    const x0 = cells[0].x0 + 2
    const x1 = cells.at(-1)!.x1 - 2
    out.push(s.bar === 'drain' ? arrow(x1, x0 + 6, y) : arrow(x0, x1 - 6, y))
  }
  for (const f of s.focus ?? []) {
    const hit = row.segments.find(p => p.text.startsWith(f)) ?? row.spans.find(p => p.text.startsWith(f))
    if (!hit) throw new Error(`${s.title}: nothing starts with ${JSON.stringify(f)}`)
    out.push(bracket(hit.x0, hit.x1, y))
  }
  return out
}

// The last row's note sits below its title; 18 more closes the frame.
const HEIGHT = 34 + ROW_HEIGHT * (STATES.length - 1) + 26 + NOTE_GAP + 18

const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="${HEIGHT}" viewBox="0 0 1240 ${HEIGHT}" role="img" aria-labelledby="t d">`,
  '<title id="t">paceline in its different states</title>',
  `<desc id="d">${escape(STATES.map(s => s.title).join(', '))}.</desc>`,
  '<style>text{font-family:"Cascadia Mono",Consolas,"DejaVu Sans Mono",monospace;font-size:14px;white-space:pre}' +
    '.t{fill:#f2f2f2;font-weight:bold;font-size:13px}.n{fill:#767676;font-size:12px}.b{font-weight:bold}</style>',
  `<defs><marker id="head" viewBox="0 0 8 8" refX="1" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" fill="${MARK}"/></marker></defs>`,
  `<rect width="1240" height="${HEIGHT}" rx="8" fill="#0c0c0c"/>`,
  ...STATES.flatMap((s, i) => {
    const top = 34 + ROW_HEIGHT * i
    const y = top + 26
    const row = lineRow(s.line, y)
    return [
      `<text x="24" y="${top}" class="t">${escape(s.title)}</text>`,
      ...row.nodes,
      ...marks(s, row, y + MARK_GAP),
      `<text x="24" y="${y + NOTE_GAP}" class="n">${escape(s.note)}</text>`,
    ]
  }),
  '</svg>',
]

writeFileSync(OUT, svg.join('\n') + '\n')
console.log(`wrote ${OUT.pathname}`)
