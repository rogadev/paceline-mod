/**
 * Builds paceline's line from a status payload.
 *
 * The line is a list of segments, each a list of colored spans, so the same
 * result can be drawn as elements in the band above the prompt (band.ts) or
 * as ANSI text (`toAnsi`). In the Go layout, the tests compare that text byte
 * for byte with what the Go paceline prints; the compact layout is the mod's
 * own.
 */

import { headroomLevel, projectSlot, slotColor, type RGB } from './color.ts'
import type { Config } from './config.ts'
import { computeBudget, type Budget, type Snapshot } from './pace.ts'
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
import { clock, duration, floorInDay, startOfDay, type Zone } from './timefmt.ts'

const MIDDLE_DOT = '\u00b7'
const CELL_FULL = '\u25b0'
const CELL_EMPTY = '\u25b1'
const CHECK_MARK = '\u2713'
const ELLIPSIS = '\u2026'
const RIGHT_ARROW = '\u2192'
// Keeps a long run from pushing the rest of the line off-screen.
const MAX_CELLS = 20
/** Cells in the compact layout's today bar; each is a fifth of the budget. */
const BAR_CELLS = 5
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/**
 * A session's out time is shown to the quarter hour: a session always runs
 * out within five hours of now, so a finer time is worth showing.
 */
const SESSION_OUT_STEP_MS = 15 * MINUTE_MS
/** A week's out time is shown to the hour. */
const WEEK_OUT_STEP_MS = HOUR_MS

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
  /**
   * Draws the mod's compact layout: today as a bar, first, then a limit only
   * when it is forecast to run out, then the project ahead of the model.
   * Absent, the line is the Go paceline's, byte for byte.
   */
  compact?: boolean
  /**
   * Which usage limit the forecast picked. Only the compact layout reads it:
   * it warns when the pick runs out before it resets. Absent, the compact
   * layout shows both limits' percentages, as the Go layout does.
   */
  limits?: LimitPick
}

/** The usage limit the forecast picked, and when it is forecast to run out, if before it resets. */
export type LimitPick = {
  show: 'session' | 'week'
  /** Epoch seconds when the picked limit is forecast to run out. Absent when it lasts until it resets. */
  outAt?: number
}

/** The pieces of the line. Each layout draws them in its own order. */
type Part =
  | 'project'
  | 'model'
  | 'effort'
  | 'fastMode'
  | 'limits'
  | 'today'
  | 'context'
  | 'cache'
  | 'progress'
  | 'duration'

const GO_ORDER: readonly Part[] = [
  'model',
  'effort',
  'fastMode',
  'project',
  'limits',
  'today',
  'context',
  'cache',
  'progress',
  'duration',
]

const COMPACT_ORDER: readonly Part[] = [
  'today',
  'limits',
  'project',
  'model',
  'effort',
  'fastMode',
  'context',
  'cache',
  'progress',
  'duration',
]

const span = (text: string, tone: Tone = 'plain'): Span => ({ text, tone })
const present = (segment: Segment | null): Segment[] => (segment ? [segment] : [])

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

/** The short label, or the long one when the config is verbose. */
function label(ctx: RenderContext, short: string, long: string): string {
  return ctx.config.verbose ? long : short
}

/** `text` in the headroom tone for `left` percent left. */
function headroom(ctx: RenderContext, left: number, text: string): Span {
  const th = ctx.config.thresholds
  return span(text, headroomLevel(left, th.headroomGreen, th.headroomYellow))
}

/** Returns the line for `p`, in the Go layout unless `ctx.compact` is set. */
export function render(p: Payload, ctx: RenderContext): Line {
  const on = ctx.config.segments
  const parts: Record<Part, Segment[]> = {
    project: on.project ? present(project(p, ctx)) : [],
    model: on.model ? present(model(p)) : [],
    effort: on.effort ? present(effort(p, ctx)) : [],
    fastMode: on.fastMode && p.fastMode === true ? [[span('fast mode', 'yellow')]] : [],
    limits: ctx.compact && ctx.limits ? limitWarning(ctx.limits, ctx) : usageLimits(p, ctx),
    today: on.today ? present(today(p, ctx)) : [],
    context: on.context ? present(contextWarning(p, ctx)) : [],
    cache: on.cache ? present(cacheWarning(p, ctx)) : [],
    progress: on.progress ? present(progress(p, ctx)) : [],
    duration: on.duration ? present(elapsed(p)) : [],
  }
  return (ctx.compact ? COMPACT_ORDER : GO_ORDER).flatMap(part => parts[part])
}

// Folder, colored by project. The color comes from the project root, so a
// subfolder keeps its project's color.
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

// The model, minus any "(1M context)"-style suffix.
function model(p: Payload): Segment | null {
  if (!p.model) return null
  const name = clean(p.model.displayName, 64).replace(MODEL_SUFFIX, '')
  return name === '' ? null : [span(name, 'cyan')]
}

// Effort, only above the everyday levels. The compact layout shows the level
// alone ("high") unless the config is verbose.
function effort(p: Payload, ctx: RenderContext): Segment | null {
  if (!p.effort) return null
  const level = clean(p.effort.level, 16)
  if (level === '' || ctx.config.quietEfforts.includes(level)) return null
  const text = ctx.compact ? label(ctx, level, level + ' effort') : level + ' effort'
  return [span(text, 'dim')]
}

// Usage limits: session, then week. Each counts up what's used from 0%, or
// down what's left from 100% when its countDirection is "down". Color always
// follows what's left, so either way the segment turns red near the limit.
function usageLimits(p: Payload, ctx: RenderContext): Segment[] {
  const on = ctx.config.segments
  const usage = (usedPct: number, down: boolean) => {
    const used = round(usedPct)
    const left = Math.max(0, 100 - used)
    const shown = down
      ? `${left}%${label(ctx, '', ' left')}`
      : `${Math.min(Math.max(used, 0), 100)}%${label(ctx, '', ' used')}`
    return { left, shown }
  }
  const segments: Segment[] = []
  const fh = p.rateLimits?.fiveHour
  if (on.session && fh?.usedPercentage !== undefined) {
    const { left, shown } = usage(fh.usedPercentage, ctx.config.countDown.session)
    const when =
      left < ctx.config.thresholds.headroomGreen && fh.resetsAt !== undefined
        ? ` (resets ${clock(fh.resetsAt, ctx.nowMs, ctx.zone)})`
        : ''
    segments.push([headroom(ctx, left, `${label(ctx, 's', 'session')} ${shown}${when}`)])
  }
  const sd = p.rateLimits?.sevenDay
  if (on.week && sd?.usedPercentage !== undefined) {
    const { left, shown } = usage(sd.usedPercentage, ctx.config.countDown.week)
    segments.push([headroom(ctx, left, `${label(ctx, 'w', 'week')} ${shown}`)])
  }
  return segments
}

// The compact layout's limit: nothing until the forecast says the picked limit
// runs out before it resets, then the label, an arrow, and when ("Tue 10pm").
// The time rounds down, so the warning never promises more time than the
// forecast gives, unless rounding would land before now: then it shows the
// exact minute instead of a time already passed. A week turns from yellow to
// red within a day of running out; a session is always within five hours, so
// always red.
function limitWarning(pick: LimitPick, ctx: RenderContext): Segment[] {
  if (pick.outAt === undefined || !ctx.config.segments[pick.show]) return []
  const outMs = pick.outAt * 1000
  const isSession = pick.show === 'session'
  const name = isSession ? label(ctx, 's', 'session') : label(ctx, 'w', 'week')
  const step = isSession ? SESSION_OUT_STEP_MS : WEEK_OUT_STEP_MS
  const rounded = floorInDay(outMs, step, startOfDay(outMs, ctx.zone))
  const at = rounded < ctx.nowMs ? outMs : rounded
  const tone: Tone = isSession || outMs - ctx.nowMs <= DAY_MS ? 'red' : 'yellow'
  return [[span(`${name}${RIGHT_ARROW}${clock(at / 1000, ctx.nowMs, ctx.zone)}`, tone)]]
}

// Today's share of the week, from the weekly limit. Reading it may re-anchor
// the day, so the snapshot is saved here.
function today(p: Payload, ctx: RenderContext): Segment | null {
  const sd = p.rateLimits?.sevenDay
  if (sd?.usedPercentage === undefined || sd.resetsAt === undefined) return null
  const r = computeBudget(sd.usedPercentage, sd.resetsAt, ctx.nowMs, ctx.readSnapshot?.() ?? null, ctx.zone)
  if (r === null) return null
  if (r.snapshotChanged) ctx.saveSnapshot?.(r.snapshot)
  return ctx.compact ? todayBar(r, ctx) : todayText(r, ctx)
}

// How far past the budget, at least 1%: a reading just past it rounds to
// 100%, which would contradict the red.
const overBy = (r: Budget) => Math.max(round(r.pctUsed) - 100, 1)

// Today counts up what's used of its budget and keeps counting past 100%
// ("t 118% of 28%"), in red once over. Counting down shows what's left
// instead, and past the budget, how far over you are ("t over 18% of 28%"),
// since a countdown would go negative. The budget is dim: it is fixed for the
// day, so it is context, not a warning.
function todayText(r: Budget, ctx: RenderContext): Segment {
  const budget = [span(' '), span(`of ${round(r.budget)}%${label(ctx, '', ' budget')}`, 'dim')]
  const name = label(ctx, 't', 'today')
  if (!ctx.config.countDown.today) {
    if (r.over) {
      return [span(`${name} ${100 + overBy(r)}%${label(ctx, '', ' used')}`, 'red'), ...budget]
    }
    return [headroom(ctx, round(r.pctLeft), `${name} ${round(r.pctUsed)}%${label(ctx, '', ' used')}`), ...budget]
  }
  if (r.over) return [span(`${name} over ${overBy(r)}%`, 'red'), ...budget]
  const left = round(r.pctLeft)
  return [headroom(ctx, left, `${name} ${left}%${label(ctx, '', ' left')}`), ...budget]
}

// Today as a bar of five cells after the label, each a fifth of the budget,
// rounded to the nearest cell: filled with what's used, or what's left when
// counting down.
// The label and filled cells take the headroom tone; empty cells are dim.
// Over budget, the bar is full (or empty, counting down) and red, followed by
// how far over, with no space ("+18%").
function todayBar(r: Budget, ctx: RenderContext): Segment {
  const name = label(ctx, 't', 'today') + ' '
  const down = ctx.config.countDown.today
  if (r.over) {
    const over = span(`+${overBy(r)}%`, 'red')
    return down
      ? [span(name, 'red'), span(CELL_EMPTY.repeat(BAR_CELLS), 'dim'), over]
      : [span(name + CELL_FULL.repeat(BAR_CELLS), 'red'), over]
  }
  const shown = down ? r.pctLeft : r.pctUsed
  const filled = Math.min(Math.max(round(shown / (100 / BAR_CELLS)), 0), BAR_CELLS)
  const bar = [headroom(ctx, round(r.pctLeft), name + CELL_FULL.repeat(filled))]
  if (filled < BAR_CELLS) bar.push(span(CELL_EMPTY.repeat(BAR_CELLS - filled), 'dim'))
  return bar
}

// Context-window warning, silent while there is headroom.
function contextWarning(p: Payload, ctx: RenderContext): Segment | null {
  const ctxUsed = p.contextWindow?.usedPercentage
  if (ctxUsed === undefined) return null
  const th = ctx.config.thresholds
  const used = round(ctxUsed)
  if (used >= th.contextCritical) return [span(`ctx ${used}%`, 'red')]
  if (used >= th.contextWarn) return [span(`ctx ${used}%`, 'yellow')]
  return null
}

// Prompt-cache warning, only once the cache has gone cold.
function cacheWarning(p: Payload, ctx: RenderContext): Segment | null {
  const pc = p.promptCache
  if (pc?.expiresAt === undefined || pc.expiresAt > Math.floor(ctx.nowMs / 1000)) return null
  const text =
    pc.recacheTokensIfCold !== undefined
      ? `cache cold: ${round(pc.recacheTokensIfCold / 1000)}k @ ~2x`
      : 'cache cold: ~2x'
  return [span(text, 'red')]
}

function progress(p: Payload, ctx: RenderContext): Segment | null {
  const dir = workDir(p)
  if (dir === '' || !ctx.progress) return null
  const run = ctx.progress(dir)
  return run ? progressSegment(run, ctx.nowMs) : null
}

// Duration comes last in both layouts, so it sits at the right edge.
function elapsed(p: Payload): Segment | null {
  const ms = p.cost?.totalDurationMs
  return ms !== undefined && ms > 0 ? [span(duration(ms), 'dim')] : null
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
