/**
 * Turns what a session reports through the mods API into the line.
 *
 * The Go paceline reads the status JSON Claude Code pipes to it; a mod asks
 * the session instead. These functions turn those answers into the same
 * payload shape, so render.ts runs unchanged against the parity fixtures and
 * live. The calls on `$` themselves live in hooks/register.ts, because the
 * engine only follows `$` within the hooks module.
 */

import type { SessionRateLimit, SessionUsage } from 'claude-code'

import type { Config } from './config.ts'
import { forecastLimits, type Activity } from './forecast.ts'
import { modelName } from './model.ts'
import { isValidSnapshot, type Snapshot } from './pace.ts'
import type { Limit, Payload } from './payload.ts'
import type { Run } from './progress.ts'
import { render, type Line, type LimitPick } from './render.ts'

/** Where this mod keeps today's budget snapshot in its `$.store`. */
export const SNAPSHOT_KEY = 'day'
/** Where this mod keeps its record of active hours, for the forecast. */
export const ACTIVITY_KEY = 'activity'

/** What the session reported for one refresh. */
export type Figures = {
  usage: SessionUsage
  modelId: string
  cwd: string
  root: string
  sessionId: string
  nowMs: number
  settings: Readonly<Record<string, unknown>>
  /** The effort level of the latest turn, from a classic hook event. */
  effort?: string
}

/** Claude Code's config directory, honoring CLAUDE_CONFIG_DIR. */
export function configDirFrom(env: {
  claudeConfigDir?: string
  userProfile?: string
  home?: string
}): string {
  const slash = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '')
  if (env.claudeConfigDir) return slash(env.claudeConfigDir)
  // USERPROFILE first: on Windows, HOME can hold a Git Bash path like /c/Users/me.
  const home = env.userProfile || env.home
  return home ? `${slash(home)}/.claude` : '.claude'
}

/** One rate-limit window in the payload's shape: epoch seconds for the reset. */
export function toLimit(r: SessionRateLimit | undefined): Limit | undefined {
  if (!r) return undefined
  const resetsMs = r.resetsAt === undefined ? NaN : Date.parse(r.resetsAt)
  return {
    usedPercentage: r.percentUsed,
    resetsAt: Number.isFinite(resetsMs) ? Math.floor(resetsMs / 1000) : undefined,
  }
}

/** Builds the status payload from a session's figures. */
export function toPayload(f: Figures): Payload {
  const configured = f.settings.effortLevel
  const effort = f.effort ?? (typeof configured === 'string' ? configured : '')
  return {
    model: { displayName: modelName(f.modelId) },
    effort: effort ? { level: effort } : undefined,
    fastMode: f.settings.fastMode === true,
    cwd: f.cwd,
    sessionId: f.sessionId,
    workspace: { currentDir: f.cwd, projectDir: f.root },
    rateLimits: {
      fiveHour: toLimit(f.usage.rateLimits.find(r => r.kind === 'five_hour')),
      sevenDay: toLimit(f.usage.rateLimits.find(r => r.kind === 'seven_day')),
    },
    contextWindow: { usedPercentage: f.usage.context.percent },
    cost: { totalDurationMs: f.nowMs - f.usage.startedAt },
  }
}

function parseSnapshot(text: string | null): Snapshot | null {
  if (text === null) return null
  try {
    const value: unknown = JSON.parse(text)
    return isValidSnapshot(value) ? value : null
  } catch {
    return null
  }
}

/**
 * Picks today's snapshot. When the Go paceline has already anchored this same
 * day and week in paceline-day.json (`goText`), its anchor wins, so both lines
 * show the same budget. Otherwise the mod's own snapshot from `$.store`
 * (`stored`). The mod never writes the Go file.
 */
export function chooseSnapshot(
  goText: string | null,
  stored: unknown,
  today: string,
  week: Limit | undefined,
): Snapshot | null {
  const fromGo = parseSnapshot(goText)
  if (
    fromGo !== null &&
    fromGo.date === today &&
    fromGo.resetsAt === week?.resetsAt &&
    (week.usedPercentage ?? -1) >= fromGo.usedAtStart
  ) {
    return fromGo
  }
  return isValidSnapshot(stored) ? stored : null
}

/** Everything a live render reads besides the payload and config. */
export type LiveState = {
  snapshot: Snapshot | null
  branch: string
  run: Run | null
  activity: Activity | null
  nowMs: number
  /** The limit the line showed last time, so a near tie doesn't flip it. */
  previous?: LimitPick['show']
}

/**
 * The line, the limit it shows, and the snapshot to save when today's anchor
 * changed. The mod leads with the project and, unless the config asks for
 * both limits, shows only the one forecast to run out first.
 */
export function renderLive(
  payload: Payload,
  config: Config,
  state: LiveState,
): { line: Line; pick: LimitPick | null; save?: Snapshot } {
  const pick =
    config.limits === 'auto'
      ? forecastLimits({
          nowMs: state.nowMs,
          zone: 'local',
          session: payload.rateLimits?.fiveHour,
          week: payload.rateLimits?.sevenDay,
          activity: state.activity,
          weekAtDayStart: state.snapshot?.usedAtStart,
          previous: state.previous,
        })
      : null
  const changed: { save?: Snapshot } = {}
  const line = render(payload, {
    nowMs: state.nowMs,
    zone: 'local',
    config,
    readSnapshot: () => state.snapshot,
    saveSnapshot: s => {
      changed.save = s
    },
    branch: () => state.branch,
    progress: () => state.run,
    leadWithProject: true,
    limits: pick ?? undefined,
  })
  return { line, pick, ...changed }
}
