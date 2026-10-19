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
    cost: { total_duration_ms: 16 * 60_000 },
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

// An agent job on its third of five equal steps.
const RUN: Run = {
  name: 'orc',
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

const STATES: { title: string; note: string; line: Line }[] = [
  {
    title: 'Fresh day',
    note: 'The day starts with its budget, 14 points of the week; none of it is spent.',
    line: draw({ week: 58, start: 58 }),
  },
  {
    title: 'Working through the day',
    note: 'Spent points drain the bar; green while there is room.',
    line: draw({ week: 63, start: 58 }),
  },
  {
    title: 'Most of the budget used',
    note: 'Yellow past 70% of the budget, red past 85%.',
    line: draw({ week: 69, start: 58 }),
  },
  {
    title: 'Over budget',
    note: "The overage turns red, and tomorrow's budget shrinks to match.",
    line: draw({ week: 75, start: 58 }),
  },
  {
    title: 'Week forecast to run out',
    note: 'At the current pace the week ends before it resets.',
    line: draw({ week: 67, start: 58 }, undefined, { limits: { show: 'week', outAt: sec('2026-10-09T15:00:00Z') } }),
  },
  {
    title: 'Session running low',
    note: 'With the session segment on, its reset time becomes out ~10:15am, in red.',
    line: draw(
      { week: 63, start: 58, session: 72 },
      c => {
        c.segments.session = true
      },
      { limits: { show: 'session', outAt: sec('2026-10-07T10:15:00Z') } },
    ),
  },
  {
    title: 'The last day',
    note: 'The whole week left is the budget.',
    line: draw({ week: 87, start: 86, reset: LAST_DAY_RESET }),
  },
  {
    title: 'Agent job in progress',
    note: 'A planned run shows weighted progress, and the context warning appears at 70%.',
    line: draw({ week: 63, start: 58, context: 74 }, undefined, { progress: () => RUN }),
  },
  {
    title: 'Verbose, counting down, fast mode',
    note: 'verbose and countDirection in paceline.json; fast mode from settings.',
    line: draw({ week: 64, start: 58, effort: 'max', fast: true }, c => {
      c.verbose = true
      c.countDown.today = true
      c.countDown.week = true
    }),
  },
  {
    title: 'Both limits, as the Go line',
    note: '"limits": "both" skips the forecast and shows the session too.',
    line: draw(
      { week: 63, start: 58 },
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
const CELL_WIDTH = 8.4
const ROW_HEIGHT = 78

const fill = (tone: Tone) =>
  typeof tone === 'string' ? PALETTE[tone] : '#' + tone.map(v => v.toString(16).padStart(2, '0')).join('')
const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

function lineRow(line: Line, y: number): string[] {
  const out: string[] = []
  let x = 24
  const put = (text: string, tone: Tone, bold = false) => {
    const width = CELL_WIDTH * [...text].length
    out.push(
      `<text x="${x.toFixed(1)}" y="${y}" textLength="${width.toFixed(1)}" lengthAdjust="spacing" ` +
        `fill="${fill(tone)}"${bold ? ' class="b"' : ''} xml:space="preserve">${escape(text)}</text>`,
    )
    x += width
  }
  line.forEach((segment, i) => {
    if (i > 0) put(DOT, 'dim')
    for (const s of segment) put(s.text, s.tone, s.bold)
  })
  return out
}

const svg = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="800" viewBox="0 0 1240 800" role="img" aria-labelledby="t d">',
  '<title id="t">paceline in its different states</title>',
  `<desc id="d">${escape(STATES.map(s => s.title).join(', '))}.</desc>`,
  '<style>text{font-family:"Cascadia Mono",Consolas,"DejaVu Sans Mono",monospace;font-size:14px;white-space:pre}' +
    '.t{fill:#f2f2f2;font-weight:bold;font-size:13px}.n{fill:#767676;font-size:12px}.b{font-weight:bold}</style>',
  '<rect width="1240" height="800" rx="8" fill="#0c0c0c"/>',
  ...STATES.flatMap((s, i) => {
    const top = 34 + ROW_HEIGHT * i
    return [
      `<text x="24" y="${top}" class="t">${escape(s.title)}</text>`,
      ...lineRow(s.line, top + 26),
      `<text x="24" y="${top + 46}" class="n">${escape(s.note)}</text>`,
    ]
  }),
  '</svg>',
]

writeFileSync(OUT, svg.join('\n') + '\n')
console.log(`wrote ${OUT.pathname}`)
