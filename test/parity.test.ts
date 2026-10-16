import { describe, expect, test } from 'claude-code/testing'

import { mergeConfig } from '../src/config.ts'
import type { Snapshot } from '../src/pace.ts'
import { decodePayload } from '../src/payload.ts'
import { parseRun } from '../src/progress.ts'
import { render, toAnsi } from '../src/render.ts'
import { PARITY_CASES } from './fixtures/parity.ts'
import { PROGRESS_CASES } from './fixtures/progress.ts'

// The branches the Go fixtures stand in for each folder's .git/HEAD.
const BRANCHES: Record<string, string> = {
  '/r/techcentral': 'dev',
  '/r/techcentral/src': 'dev',
  '/r/evil': 'main\x1b]0;pwned\x07\x1b[2J\u202e\u200b\r\n\u009b',
  '/r/long': 'x'.repeat(40),
}

// The fixtures record the countdown display, so every usage segment counts
// down here, as it does in the Go parity test. The fixtures also predate the
// session segment being off by default, and none of their configs set it, so
// it stays on to keep the session format pinned.
describe('parity with the Go paceline', () => {
  for (const c of PARITY_CASES) {
    test(c.name, () => {
      const config = mergeConfig(c.config)
      config.segments.session = true
      config.countDown = { session: true, week: true, today: true }
      let snap: Snapshot | null = null
      c.steps.forEach((step, i) => {
        const payload = decodePayload(step.payload)
        expect(payload).not.toBeNull()
        const got = toAnsi(
          render(payload!, {
            nowMs: Date.parse(step.now),
            zone: 'utc',
            config,
            readSnapshot: () => snap,
            saveSnapshot: s => {
              snap = s
            },
            branch: dir => BRANCHES[dir] ?? '',
          }),
        )
        expect(`step ${i}: ${JSON.stringify(got)}`).toBe(`step ${i}: ${JSON.stringify(step.want)}`)
      })
    })
  }
})

// Each case renders one progress file with every other segment off.
describe('progress bar parity with the Go paceline', () => {
  for (const c of PROGRESS_CASES) {
    test(c.name, () => {
      const config = mergeConfig(c.config)
      const progressOn = config.segments.progress
      for (const key of Object.keys(config.segments) as (keyof typeof config.segments)[]) {
        config.segments[key] = false
      }
      config.segments.progress = progressOn
      const got = toAnsi(
        render(decodePayload({ cwd: '/r/repo' })!, {
          nowMs: Date.parse(c.now),
          zone: 'utc',
          config,
          progress: dir => {
            expect(dir).toBe('/r/repo')
            return c.file === null ? null : parseRun(JSON.stringify(c.file))
          },
        }),
        c.noColor === true,
      )
      expect(JSON.stringify(got)).toBe(JSON.stringify(c.want))
    })
  }
})
