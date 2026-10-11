/**
 * Reads the progress file: a small JSON record of a long job's steps that the
 * line draws as a bar.
 *
 * The file lives in the repository's git directory, at
 * `paceline/progress-<session id>.json` for one Claude Code session's run, or
 * `paceline/progress.json` for a writer outside Claude Code. The format is the
 * one the Go paceline and paceline-mcp share. Everything in it is untrusted:
 * the reader caps its size and rejects anything malformed, and every string
 * is cleaned before it is drawn.
 */

export const MAX_FILE_BYTES = 32 * 1024
const MAX_STEPS = 50
const MAX_STAGES = 12
const MAX_LABEL_CHARS = 40
const MAX_WEIGHT = 1000
const MAX_SESSION_LEN = 64

const MINUTE = 60 * 1000
const PAUSED_AFTER = 60 * MINUTE
const QUIET_HIDDEN_FROM = 4 * 60 * MINUTE
const DONE_HIDDEN_FROM = 30 * MINUTE

// 0001-01-01T00:00:00Z, Go's zero time, which the format rejects as unset.
const ZERO_TIME_MS = -62135596800000

const PHASES = ['running', 'done', 'halted'] as const
const STATUSES = ['pending', 'active', 'done', 'skipped', 'blocked'] as const

export type Phase = (typeof PHASES)[number]
export type Status = (typeof STATUSES)[number]

export type Step = {
  id: string
  label: string
  status: Status
  /** Size relative to the other steps; 0 counts as 1. */
  weight: number
  stages: string[]
  stage: string
}

export type Run = {
  name: string
  phase: Phase
  label: string
  steps: Step[]
  updatedAtMs: number
}

/**
 * Accepts a Claude Code session id: letters, digits, and dashes, so it can
 * never name a path outside the progress directory.
 */
export function isValidSession(session: string): boolean {
  return session.length > 0 && session.length <= MAX_SESSION_LEN && /^[0-9A-Za-z-]+$/.test(session)
}

/** The progress file inside a git directory for a session, or the shared file. */
export function progressPath(gitDir: string, session: string): string {
  const name = isValidSession(session) ? `progress-${session}.json` : 'progress.json'
  return `${gitDir}/paceline/${name}`
}

// A JSON null decodes to the field's zero value, as it does for the Go reader.
function text(v: unknown): string | undefined {
  if (v === undefined || v === null) return ''
  return typeof v === 'string' ? v : undefined
}

function textOk(s: string, required: boolean): boolean {
  return !(required && s === '') && [...s].length <= MAX_LABEL_CHARS
}

// RFC 3339, as Go's time.Time decodes it.
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/

function parseStep(v: unknown): Step | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const id = text(o.id)
  const label = text(o.label)
  const status = text(o.status)
  const stage = text(o.stage)
  const weight = o.weight === undefined || o.weight === null ? 0 : o.weight
  const stagesRaw = o.stages === undefined || o.stages === null ? [] : o.stages
  if (id === undefined || label === undefined || status === undefined || stage === undefined) return null
  if (typeof weight !== 'number' || !Number.isFinite(weight)) return null
  if (!Array.isArray(stagesRaw)) return null
  const stages = stagesRaw.map(text)
  if (stages.some(s => s === undefined)) return null

  if (!textOk(id, true) || !textOk(label, false)) return null
  if (!(STATUSES as readonly string[]).includes(status)) return null
  if (weight < 0 || weight > MAX_WEIGHT) return null
  if (stages.length > MAX_STAGES || !stages.every(s => textOk(s as string, true))) return null
  if (stage !== '' && !stages.includes(stage)) return null
  return { id, label, status: status as Status, weight, stages: stages as string[], stage }
}

/**
 * Decodes and validates a progress file's text, or returns null when it is
 * oversized, not JSON, or breaks any rule of the format.
 */
export function parseRun(fileText: string): Run | null {
  if (new TextEncoder().encode(fileText).length > MAX_FILE_BYTES) return null
  let doc: unknown
  try {
    doc = JSON.parse(fileText)
  } catch {
    return null
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return null
  const o = doc as Record<string, unknown>
  if (o.version !== 1) return null
  const name = text(o.name)
  const phase = text(o.phase)
  const label = text(o.label)
  if (name === undefined || phase === undefined || label === undefined) return null
  if (!textOk(name, true) || !textOk(label, false)) return null
  if (!(PHASES as readonly string[]).includes(phase)) return null
  if (!Array.isArray(o.steps) || o.steps.length === 0 || o.steps.length > MAX_STEPS) return null
  if (typeof o.updatedAt !== 'string' || !RFC3339.test(o.updatedAt)) return null
  const updatedAtMs = Date.parse(o.updatedAt)
  if (!Number.isFinite(updatedAtMs) || updatedAtMs === ZERO_TIME_MS) return null

  const steps: Step[] = []
  const seen = new Set<string>()
  for (const raw of o.steps) {
    const step = parseStep(raw)
    if (step === null || seen.has(step.id)) return null
    seen.add(step.id)
    steps.push(step)
  }
  return { name, phase: phase as Phase, label, steps, updatedAtMs }
}

/**
 * Reports whether the run belongs on the line: a finished run shows for a
 * while, and any other run hides once it has gone quiet long enough that its
 * writer is gone.
 */
export function isVisible(r: Run, nowMs: number): boolean {
  const age = nowMs - r.updatedAtMs
  return r.phase === 'done' ? age <= DONE_HIDDEN_FROM : age <= QUIET_HIDDEN_FROM
}

/** Reports whether a running run has been quiet so long its writer likely stopped. */
export function isPaused(r: Run, nowMs: number): boolean {
  return r.phase === 'running' && nowMs - r.updatedAtMs > PAUSED_AFTER
}

/** Reports whether any step has a weight or stages, which makes `percent` more than a count. */
export function isPlanned(r: Run): boolean {
  return r.steps.some(s => s.weight > 0 || s.stages.length > 0)
}

/** The first active step's index, or -1. */
export function activeIndex(r: Run): number {
  return r.steps.findIndex(s => s.status === 'active')
}

/** How many steps are no longer pending or active. */
export function settledCount(r: Run): number {
  return r.steps.filter(s => s.status !== 'pending' && s.status !== 'active').length
}

/**
 * The weighted share of planned work finished, 0 to 100. Skipped and blocked
 * steps leave the total, since the run will not do them. An active step counts
 * the stages it has finished: a step in the third of four stages is half done.
 */
export function percent(r: Run): number {
  let total = 0
  let finished = 0
  for (const s of r.steps) {
    if (s.status === 'skipped' || s.status === 'blocked') continue
    const w = s.weight === 0 ? 1 : s.weight
    total += w
    if (s.status === 'done') finished += w
    if (s.status === 'active') {
      const i = s.stages.indexOf(s.stage)
      if (i > 0) finished += (w * i) / s.stages.length
    }
  }
  return total === 0 ? 100 : (100 * finished) / total
}
