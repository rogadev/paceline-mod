/**
 * Builds paceline's line from a status payload.
 *
 * The line is a list of segments, each a list of colored spans, so the same
 * result can be drawn as elements in the band above the prompt (band.ts) or
 * as ANSI text (`toAnsi`), which the tests compare byte for byte with what
 * the Go paceline prints.
 */

import { headroomLevel, projectSlot, slotColor, type RGB } from './color.ts'
import type { Config } from './config.ts'
import { computeBudget, type Snapshot } from './pace.ts'
import type { Payload } from './payload.ts'
import {
  activeIndex,
  isPaused,
  isPlanned,
  isVisible,
  percent,
  settledCount,
  type Run,
  type Status,
} from './progress.ts'
import { clean } from './sanitize.ts'
import { clock, duration, type Zone } from './timefmt.ts'

const MIDDLE_DOT = '\u00b7'
const CELL_FULL = '\u25b0'
const CELL_EMPTY = '\u25b1'
const CHECK_MARK = '\u2713'
const ELLIPSIS = '\u2026'
// Keeps a long run from pushing the rest of the line off-screen.
const MAX_CELLS = 20

/** Windows Terminal's default red with 15% less chroma, easier on the eyes. */
export const MUTED_RED: RGB = [185, 47, 47]

/** How a span is colored. A named tone follows the terminal's own palette. */
export type Tone = 'plain' | 'cyan' | 'green' | 'yellow' | 'red' | 'dim' | RGB

export type Span = { text: string; tone: Tone }
export type Segment = Span[]
export type Line = Segment[]

/** Everything the renderer needs besides the payload. */
export type RenderContext = {
  nowMs: number
  zone: Zone
  config: Config
  readSnapshot?: () => Snapshot | null
  saveSnapshot?: (s: Snapshot) => void
  /** The git branch of the repository holding `dir`, or `''`. */
  branch?: (dir: string) => string
  /** The progress run of the repository holding `dir`, or null. */
  progress?: (dir: string) => Run | null
}

const span = (text: string, tone: Tone = 'plain'): Span => ({ text, tone })

/** Rounds halves up, as the Go paceline (and its JavaScript 1.0) does. */
export const round = (v: number) => Math.floor(v + 0.5)

// Go's \s is ASCII whitespace only; JavaScript's would also match Unicode spaces.
const MODEL_SUFFIX = /[\t\n\f\r ]*\(.*\)$/

/** The last path segment, for either separator style. */
function leaf(p: string): string {
  const s = p.replace(/[\\/]+$/, '').replaceAll('\\', '/')
  if (s === '') return '.'
  return s.slice(s.lastIndexOf('/') + 1)
}

function workDir(p: Payload): string {
  return p.workspace?.currentDir || p.cwd || ''
}

/** Returns the line for `p`. */
export function render(p: Payload, ctx: RenderContext): Line {
  const on = ctx.config.segments
  const th = ctx.config.thresholds
  const headroom = (left: number, text: string): Span =>
    span(text, headroomLevel(left, th.headroomGreen, th.headroomYellow))
  const label = (short: string, long: string) => (ctx.config.verbose ? long : short)
  const line: Line = []

  // Model, minus any "(1M context)"-style suffix.
  if (on.model && p.model) {
    const model = clean(p.model.displayName, 64).replace(MODEL_SUFFIX, '')
    if (model !== '') line.push([span(model, 'cyan')])
  }

  // Effort, only above the everyday levels.
  if (on.effort && p.effort) {
    const effort = clean(p.effort.level, 16)
    if (effort !== '' && !ctx.config.quietEfforts.includes(effort)) {
      line.push([span(effort + ' effort', 'dim')])
    }
  }

  if (on.fastMode && p.fastMode === true) line.push([span('fast mode', 'yellow')])

  // Folder, colored by project. The color comes from the project root, so a
  // subfolder keeps its project's color.
  if (on.project) {
    const segment = project(p, ctx)
    if (segment) line.push(segment)
  }

  // Usage limits: session, week, then today's share of the week. Each counts
  // up what's used from 0%, or down what's left from 100% when its
  // countDirection is "down". Color always follows what's left, so either way
  // the segment turns red near the limit.
  const usage = (usedPct: number, down: boolean) => {
    const used = round(usedPct)
    const left = Math.max(0, 100 - used)
    const shown = down
      ? `${left}%${label('', ' left')}`
      : `${Math.min(Math.max(used, 0), 100)}%${label('', ' used')}`
    return { left, shown }
  }
  const rl = p.rateLimits
  const fh = rl?.fiveHour
  if (on.session && fh?.usedPercentage !== undefined) {
    const { left, shown } = usage(fh.usedPercentage, ctx.config.countDown.session)
    const when =
      left < th.headroomGreen && fh.resetsAt !== undefined
        ? ` (resets ${clock(fh.resetsAt, ctx.nowMs, ctx.zone)})`
        : ''
    line.push([headroom(left, `${label('s', 'session')} ${shown}${when}`)])
  }
  const sd = rl?.sevenDay
  if (sd?.usedPercentage !== undefined) {
    if (on.week) {
      const { left, shown } = usage(sd.usedPercentage, ctx.config.countDown.week)
      line.push([headroom(left, `${label('w', 'week')} ${shown}`)])
    }
    if (on.today && sd.resetsAt !== undefined) {
      const segment = today(sd.usedPercentage, sd.resetsAt, ctx, headroom, label)
      if (segment) line.push(segment)
    }
  }

  // Context-window warning, silent while there is headroom.
  const ctxUsed = p.contextWindow?.usedPercentage
  if (on.context && ctxUsed !== undefined) {
    const used = round(ctxUsed)
    if (used >= th.contextCritical) line.push([span(`ctx ${used}%`, 'red')])
    else if (used >= th.contextWarn) line.push([span(`ctx ${used}%`, 'yellow')])
  }

  // Prompt-cache warning, only once the cache has gone cold.
  const pc = p.promptCache
  if (on.cache && pc?.expiresAt !== undefined && pc.expiresAt <= Math.floor(ctx.nowMs / 1000)) {
    const text =
      pc.recacheTokensIfCold !== undefined
        ? `cache cold: ${round(pc.recacheTokensIfCold / 1000)}k @ ~2x`
        : 'cache cold: ~2x'
    line.push([span(text, 'red')])
  }

  if (on.progress && ctx.progress) {
    const dir = workDir(p)
    if (dir !== '') {
      const run = ctx.progress(dir)
      const segment = run ? progressSegment(run, ctx.nowMs) : null
      if (segment) line.push(segment)
    }
  }

  // Duration always comes last, so it sits at the right edge.
  const ms = p.cost?.totalDurationMs
  if (on.duration && ms !== undefined && ms > 0) line.push([span(duration(ms), 'dim')])

  return line
}

function project(p: Payload, ctx: RenderContext): Segment | null {
  const dir = workDir(p)
  if (dir === '') return null
  const projectDir = p.workspace?.projectDir || dir
  const slot = projectSlot(leaf(projectDir), ctx.config.projectSlots)
  const segment: Segment = [span(clean(leaf(dir), 64), slotColor(slot))]
  if (ctx.config.segments.branch && ctx.branch) {
    const branch = clean(ctx.branch(dir), 40)
    if (branch !== '') segment.push(span(' '), span('(', 'dim'), span(branch), span(')', 'dim'))
  }
  return segment
}

// Today counts up what's used of its budget and keeps counting past 100%
// ("t 118% of 28%"), in red once over. Over shows at least 101%: a reading
// just past the budget rounds to 100%, which would contradict the red.
// Counting down shows what's left instead, and past the budget, how far over
// you are ("t over 18% of 28%"), since a countdown would go negative. The
// budget is dim: it is fixed for the day, so it is context, not a warning.
function today(
  usedPct: number,
  resetsAt: number,
  ctx: RenderContext,
  headroom: (left: number, text: string) => Span,
  label: (short: string, long: string) => string,
): Segment | null {
  const r = computeBudget(usedPct, resetsAt, ctx.nowMs, ctx.readSnapshot?.() ?? null, ctx.zone)
  if (r === null) return null
  if (r.snapshotChanged) ctx.saveSnapshot?.(r.snapshot)

  const budget = [span(' '), span(`of ${round(r.budget)}%${label('', ' budget')}`, 'dim')]
  const name = label('t', 'today')
  if (!ctx.config.countDown.today) {
    if (r.over) {
      return [span(`${name} ${Math.max(round(r.pctUsed), 101)}%${label('', ' used')}`, 'red'), ...budget]
    }
    return [headroom(round(r.pctLeft), `${name} ${round(r.pctUsed)}%${label('', ' used')}`), ...budget]
  }
  if (r.over) {
    return [span(`${name} over ${Math.max(round(r.pctUsed) - 100, 1)}%`, 'red'), ...budget]
  }
  const left = round(r.pctLeft)
  return [headroom(left, `${name} ${left}%${label('', ' left')}`), ...budget]
}

/**
 * Draws a run as "name cells status": one cell per step, colored by its
 * status, then the active step and how far the run has come.
 */
function progressSegment(r: Run, nowMs: number): Segment | null {
  if (!isVisible(r, nowMs)) return null
  const parts: Span[][] = [[span(clean(r.name, 16))], cells(r)]
  if (r.phase === 'halted') parts.push([span('halted', 'red')])
  else if (r.phase === 'done') parts.push([span(CHECK_MARK + ' done', 'green')])
  else {
    const status = [span(progressStatus(r))]
    if (isPaused(r, nowMs)) status.push(span(' (paused)', 'dim'))
    parts.push(status)
  }
  const kept = parts.filter(part => part.some(s => s.text !== ''))
  return kept.flatMap((part, i) => (i === 0 ? part : [span(' '), ...part]))
}

const CELL_TONE: Record<Status, Tone> = {
  done: 'green',
  active: 'cyan',
  skipped: 'dim',
  blocked: 'red',
  pending: 'dim',
}

// Up to MAX_CELLS cells. A longer run shows a window around the active (or
// first pending) step, with an ellipsis on each side that was cut.
function cells(r: Run): Span[] {
  const steps = r.steps
  let start = 0
  let end = steps.length
  if (steps.length > MAX_CELLS) {
    let focus = activeIndex(r)
    if (focus < 0) focus = steps.findIndex(s => s.status === 'pending')
    if (focus < 0) focus = steps.length - 1
    start = Math.min(Math.max(focus - Math.trunc(MAX_CELLS / 2), 0), steps.length - MAX_CELLS)
    end = start + MAX_CELLS
  }
  const out: Span[] = []
  if (start > 0) out.push(span(ELLIPSIS, 'dim'))
  // Neighbors with the same status share one span.
  for (let i = start; i < end; ) {
    let j = i + 1
    while (j < end && steps[j].status === steps[i].status) j++
    const glyph = steps[i].status === 'pending' ? CELL_EMPTY : CELL_FULL
    out.push(span(glyph.repeat(j - i), CELL_TONE[steps[i].status]))
    i = j
  }
  if (end < steps.length) out.push(span(ELLIPSIS, 'dim'))
  return out
}

// The writer's label, or the active step and its stage. A planned run adds
// its weighted percentage, which moves within a step; any other run counts
// settled steps instead, unless the writer set a label of its own.
function progressStatus(r: Run): string {
  let text = clean(r.label, 24)
  if (text === '') {
    const i = activeIndex(r)
    if (i >= 0) {
      const step = r.steps[i]
      text = (clean(step.label, 24) + ' ' + clean(step.stage, 16)).trim()
    }
  }
  // Never claim 100% while work remains.
  if (isPlanned(r)) text += ` ${Math.min(Math.trunc(percent(r)), 99)}%`
  else if (r.label === '') text += ` ${settledCount(r)}/${r.steps.length}`
  return text.trim()
}

const ANSI: Record<string, string> = { green: '32', yellow: '33', cyan: '36', dim: '2' }

function sgr(tone: Tone): string {
  if (tone === 'plain') return ''
  const rgb = tone === 'red' ? MUTED_RED : typeof tone === 'string' ? null : tone
  return rgb ? `38;2;${rgb[0]};${rgb[1]};${rgb[2]}` : ANSI[tone as string]
}

/**
 * The line as ANSI text, segments joined by a dim middle dot, exactly as the
 * Go paceline prints it. With `noColor`, the same text with no escapes.
 */
export function toAnsi(line: Line, noColor = false): string {
  const draw = (s: Span) => {
    const code = sgr(s.tone)
    return noColor || code === '' ? s.text : `\x1b[${code}m${s.text}\x1b[0m`
  }
  const separator = ' ' + draw(span(MIDDLE_DOT, 'dim')) + ' '
  return line.map(segment => segment.map(draw).join('')).join(separator)
}
