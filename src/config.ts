/**
 * Reads paceline.json, the same file the Go paceline reads, and merges it
 * onto the defaults. Only known keys with the right type and range are taken,
 * so a malformed file degrades to the defaults instead of breaking the line.
 */

/** The segments that can be turned off. */
export type Segments = {
  model: boolean
  effort: boolean
  fastMode: boolean
  project: boolean
  branch: boolean
  session: boolean
  week: boolean
  today: boolean
  context: boolean
  cache: boolean
  duration: boolean
  progress: boolean
  /** The `/orc-loop` bar. Only the mod draws it; the Go paceline ignores the key. */
  loop: boolean
  /** The dev -> main review batch. Only the mod draws it; the Go paceline ignores the key. */
  batch: boolean
}

/** Per usage segment, whether it counts down what's left instead of up. */
export type CountDown = { session: boolean; week: boolean; today: boolean }

/** The percentages where colors and warnings change. */
export type Thresholds = {
  headroomGreen: number
  headroomYellow: number
  contextWarn: number
  contextCritical: number
}

/** paceline's merged configuration. */
export type Config = {
  segments: Segments
  thresholds: Thresholds
  countDown: CountDown
  /** Effort levels considered everyday; any other level gets a label. */
  quietEfforts: string[]
  /** Pins project folder names to color slots 0-11. */
  projectSlots: Record<string, number>
  /** Spells out the usage labels (`session 82% used`) instead of `s 82%`. */
  verbose: boolean
  /**
   * `auto` shows only the usage limit forecast to run out first; `both`
   * shows the session and the week, as the Go paceline does. The Go paceline
   * ignores this key.
   */
  limits: 'auto' | 'both'
}

/** Returns the built-in configuration. */
export function defaultConfig(): Config {
  return {
    segments: {
      model: true,
      effort: true,
      fastMode: true,
      project: true,
      branch: true,
      session: false,
      week: true,
      today: true,
      context: true,
      cache: true,
      duration: true,
      progress: true,
      loop: true,
      batch: true,
    },
    thresholds: { headroomGreen: 30, headroomYellow: 15, contextWarn: 70, contextCritical: 85 },
    countDown: { session: false, week: false, today: false },
    quietEfforts: ['low', 'medium'],
    projectSlots: {},
    verbose: false,
    limits: 'auto',
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// A JSON null reads as the zero value, the way the Go loader decodes it, so
// both versions agree on the same file.
const asBool = (v: unknown) => (typeof v === 'boolean' ? v : v === null ? false : undefined)
const asNumber = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? v : v === null ? 0 : undefined

/** Merges a parsed paceline.json document onto the defaults. */
export function mergeConfig(doc: unknown): Config {
  const c = defaultConfig()
  if (!isObject(doc)) return c
  // A section of the wrong type makes the Go loader fall back to the defaults
  // for the whole file; match it.
  const sections = ['segments', 'thresholds', 'countDirection', 'projectSlots'] as const
  if (sections.some(k => doc[k] !== undefined && doc[k] !== null && !isObject(doc[k]))) return c

  for (const [key, raw] of Object.entries((doc.segments as Record<string, unknown>) ?? {})) {
    const v = asBool(raw)
    if (key in c.segments && v !== undefined) c.segments[key as keyof Segments] = v
  }

  for (const [key, raw] of Object.entries((doc.thresholds as Record<string, unknown>) ?? {})) {
    const v = asNumber(raw)
    if (key in c.thresholds && v !== undefined && v >= 0 && v <= 100) {
      c.thresholds[key as keyof Thresholds] = v
    }
  }

  for (const [key, raw] of Object.entries((doc.countDirection as Record<string, unknown>) ?? {})) {
    if (key in c.countDown && (raw === 'up' || raw === 'down')) {
      c.countDown[key as keyof CountDown] = raw === 'down'
    }
  }

  const efforts = doc.quietEfforts
  if (Array.isArray(efforts) && efforts.every(e => typeof e === 'string' || e === null)) {
    c.quietEfforts = efforts.map(e => e ?? '')
  }

  for (const [name, raw] of Object.entries((doc.projectSlots as Record<string, unknown>) ?? {})) {
    const v = asNumber(raw)
    if (v !== undefined && Number.isInteger(v) && v >= 0 && v < 12) c.projectSlots[name] = v
  }

  const verbose = asBool(doc.verbose)
  if (verbose !== undefined) c.verbose = verbose

  if (doc.limits === 'auto' || doc.limits === 'both') c.limits = doc.limits
  return c
}

/** Parses and merges paceline.json text; text that is not JSON gives the defaults. */
export function parseConfig(text: string): Config {
  try {
    return mergeConfig(JSON.parse(text))
  } catch {
    return defaultConfig()
  }
}
