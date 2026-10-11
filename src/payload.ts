/**
 * The status the line is drawn from, in the shape of Claude Code's status
 * line JSON, so the renderer can be checked against the same fixtures as the
 * Go paceline. A session fills it from the mods API (see live.ts).
 *
 * Every leaf is checked for its JSON type: a value of the wrong type is left
 * unset, never coerced, and a nested object of the wrong type is skipped, so a
 * surprise in one field never blanks the whole line.
 */

export type Limit = { usedPercentage?: number; resetsAt?: number }

export type Payload = {
  model?: { displayName: string }
  effort?: { level: string }
  fastMode?: boolean
  cwd?: string
  sessionId?: string
  workspace?: { currentDir: string; projectDir: string }
  rateLimits?: { fiveHour?: Limit; sevenDay?: Limit }
  contextWindow?: { usedPercentage?: number }
  promptCache?: { expiresAt?: number; recacheTokensIfCold?: number }
  cost?: { totalDurationMs?: number }
}

type Obj = Record<string, unknown>

const obj = (v: unknown): Obj | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : undefined
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined)

function limit(v: unknown): Limit | undefined {
  const o = obj(v)
  return o && { usedPercentage: num(o.used_percentage), resetsAt: num(o.resets_at) }
}

/**
 * Decodes a parsed status line JSON object. Returns null when the top level
 * is not an object.
 */
export function decodePayload(v: unknown): Payload | null {
  const o = obj(v)
  if (!o) return null
  const p: Payload = {}
  const model = obj(o.model)
  if (model) p.model = { displayName: str(model.display_name) ?? '' }
  const effort = obj(o.effort)
  if (effort) p.effort = { level: str(effort.level) ?? '' }
  p.fastMode = bool(o.fast_mode)
  p.cwd = str(o.cwd)
  p.sessionId = str(o.session_id)
  const ws = obj(o.workspace)
  if (ws) p.workspace = { currentDir: str(ws.current_dir) ?? '', projectDir: str(ws.project_dir) ?? '' }
  const rl = obj(o.rate_limits)
  if (rl) p.rateLimits = { fiveHour: limit(rl.five_hour), sevenDay: limit(rl.seven_day) }
  const cw = obj(o.context_window)
  if (cw) p.contextWindow = { usedPercentage: num(cw.used_percentage) }
  const pc = obj(o.prompt_cache)
  if (pc) {
    p.promptCache = { expiresAt: num(pc.expires_at), recacheTokensIfCold: num(pc.recache_tokens_if_cold) }
  }
  const cost = obj(o.cost)
  if (cost) p.cost = { totalDurationMs: num(cost.total_duration_ms) }
  return p
}
