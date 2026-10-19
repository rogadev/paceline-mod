import type { EngineInterface, Register } from 'claude-code'

import { bandTree, type BandElements } from '../src/band.ts'
import { defaultConfig, parseConfig } from '../src/config.ts'
import { isActivity, migrateActivity, recordActivity } from '../src/forecast.ts'
import { branchIn, findGitDir, type GitFs } from '../src/gitinfo.ts'
import {
  ACTIVITY_KEY,
  LEGACY_ACTIVITY_KEY,
  SNAPSHOT_KEY,
  chooseSnapshot,
  configDirFrom,
  debugReport,
  renderLive,
  toPayload,
} from '../src/live.ts'
import { MAX_FILE_BYTES, isValidSession, parseRun, progressPath, type Run } from '../src/progress.ts'
import type { LimitPick, Line } from '../src/render.ts'
import { dateKey } from '../src/timefmt.ts'

// How often the line refreshes with nothing else to prompt it: the duration
// ticks, and a progress file another process writes can change.
const REFRESH_MS = 15_000
const MAX_CONFIG_BYTES = 64 * 1024
const MAX_SNAPSHOT_BYTES = 4096
const DEBUG_TOOL = 'mcp__paceline__get_forecast_debug'
const DEBUG_COMMAND = 'paceline-debug'

// Module state starts over on a reload; the first refresh refills it.
let line: Line = []
let effort: string | undefined
let lastPick: LimitPick['show'] | undefined
let lastDebug: unknown
let running: Promise<void> | null = null
let again = false

// Every call on `$` stays in this file: the engine follows `$` only into
// functions declared here, never across an import.

/** Reads a small regular file's text, or null when it is missing, too big, or unreadable. */
async function readSmall($: EngineInterface, path: string, maxBytes: number): Promise<string | null> {
  try {
    const stat = await $.fs.stat(path)
    if (stat.kind !== 'file' || stat.size > maxBytes) return null
    return await $.fs.read(path)
  } catch {
    return null
  }
}

async function kindOf($: EngineInterface, path: string): Promise<'file' | 'dir' | 'other' | null> {
  try {
    return (await $.fs.stat(path)).kind
  } catch {
    return null
  }
}

async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

/** The repository's progress run for this session, or the shared run. */
async function loadProgress($: EngineInterface, gitDir: string, session: string): Promise<Run | null> {
  if (gitDir === '') return null
  for (const id of isValidSession(session) ? [session, ''] : ['']) {
    const text = await readSmall($, progressPath(gitDir, id), MAX_FILE_BYTES)
    const run = text === null ? null : parseRun(text)
    if (run) return run
  }
  return null
}

/** Asks the session for its figures and renders the line. */
async function liveLine($: EngineInterface): Promise<Line> {
  const [usage, modelId, cwd, root, sessionId, nowMs, settings] = await Promise.all([
    $.session.usage(),
    $.session.model(),
    $.session.cwd(),
    $.session.root(),
    $.session.id(),
    $.clock.now(),
    $.settings.read(),
  ])
  const dir = configDirFrom({
    claudeConfigDir: await $.env.get('CLAUDE_CONFIG_DIR'),
    userProfile: await $.env.get('USERPROFILE'),
    home: await $.env.get('HOME'),
  })
  const payload = toPayload({ usage, modelId, cwd, root, sessionId, nowMs, settings, effort })

  const fs: GitFs = { kind: path => kindOf($, path), read: path => readText($, path) }
  const [configText, goSnapshot, stored, storedActivity, legacyActivity, gitDir] = await Promise.all([
    readSmall($, `${dir}/paceline.json`, MAX_CONFIG_BYTES),
    readSmall($, `${dir}/paceline-day.json`, MAX_SNAPSHOT_BYTES),
    $.store.get(SNAPSHOT_KEY),
    $.store.get(ACTIVITY_KEY),
    $.store.get(LEGACY_ACTIVITY_KEY),
    findGitDir(fs, cwd),
  ])
  const [branch, run] = await Promise.all([branchIn(fs, gitDir), loadProgress($, gitDir, sessionId)])

  const config = configText === null ? defaultConfig() : parseConfig(configText)
  const snapshot = chooseSnapshot(goSnapshot, stored, dateKey(nowMs, 'local'), payload.rateLimits?.sevenDay)
  const recorded = recordActivity(
    isActivity(storedActivity) ? storedActivity : migrateActivity(legacyActivity),
    nowMs,
    'local',
    payload.rateLimits?.fiveHour,
    payload.rateLimits?.sevenDay,
  )
  if (recorded.changed) await $.store.set(ACTIVITY_KEY, recorded.activity)

  const state = {
    snapshot,
    branch,
    run,
    activity: recorded.activity,
    nowMs,
    previous: lastPick,
  }
  const result = renderLive(payload, config, state)
  lastDebug = debugReport({
    nowMs,
    payload,
    config,
    state,
    snapshotSource: snapshot === null ? 'none' : snapshot === stored ? 'store' : 'go-file',
    result,
  })
  lastPick = result.pick?.show
  if (result.save) await $.store.set(SNAPSHOT_KEY, result.save)
  return result.line
}

/**
 * Re-reads the session's figures and redraws the band. One refresh runs at a
 * time; a request that arrives during one runs once more after it, so the
 * line always ends on the latest figures.
 */
function refresh($: EngineInterface): Promise<void> {
  if (running) {
    again = true
    return running
  }
  running = refreshLoop($)
  return running
}

async function refreshLoop($: EngineInterface): Promise<void> {
  do {
    again = false
    try {
      line = await liveLine($)
      $.ui.invalidate('ui.render')
    } catch (err) {
      // Keep the last good line: a failed read must never blank it.
      $.ui.log(`paceline: refresh failed: ${String(err)}`, { to: 'debug' })
    }
  } while (again)
  running = null
}

function noteEffort(level: string | undefined): void {
  if (level) effort = level
}

// The classic and tool.call hooks below only watch, so each `.catch` lets the
// event go on if the hook fails: `next(e)` runs what is beneath it, or replays
// the result when the hook had already called `next`.
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await refresh($)
    $.clock.every(REFRESH_MS, () => refresh($))
    await $.tool.register({
      name: 'get_forecast_debug',
      description:
        "Returns, as JSON, every figure behind paceline's forecast and its 'out ~time' warning: the usage readings, the day snapshot, the stored activity history, the burn rates and where they came from, and each limit's projection. Call it when asked why the line shows what it shows. Read-only.",
    })
    await $.command.register({
      name: DEBUG_COMMAND,
      description: "Prints the figures behind paceline's forecast.",
    })
    return next(e)
  })

  // The debug tool and command answer from the latest refresh, redone first so
  // the figures are current.
  on('tool.call', { tool: DEBUG_TOOL }, async ($, e, next) => {
    await refresh($)
    return { result: JSON.stringify(lastDebug ?? { note: 'No reading yet.' }, null, 2) }
  })
  on('command.run', { command: DEBUG_COMMAND }, async ($, e, next) => {
    await refresh($)
    return { text: JSON.stringify(lastDebug ?? { note: 'No reading yet.' }, null, 2) }
  })

  // Usage moved: a turn ended, or a rate-limit window moved a whole point.
  on('session.measure', ($, e, next) => {
    void refresh($)
    return next(e)
  })

  // /clear, /resume, and /branch start the session's figures over.
  on('classic.SessionStart', ($, e, next) => {
    void refresh($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The mods API has no effort reading; these events carry the turn's.
  on('classic.PostToolUse', ($, e, next) => {
    noteEffort(e.effort?.level)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.Stop', ($, e, next) => {
    noteEffort(e.effort?.level)
    void refresh($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // An agent reported progress: redraw the bar now rather than on the timer.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (String(e.tool).startsWith('mcp__paceline__progress_')) void refresh($)
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || line.length === 0) return next(e)
    const el = $.ui.resolve(e) as unknown as BandElements
    const ours = bandTree(line, el, e.surface)
    // Keep whatever the mods after this one draw in the band, under the line.
    const theirs = await next(e)
    return el.Box({ flexDirection: 'column', children: [ours, theirs] })
  })
}
