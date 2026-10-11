# Notes: the mods platform and how paceline uses it

What we learned while building v0.1.0 on Claude Code 2.1.296 (2026-10-11). The mods API is early access and changes between releases: when something here disagrees with the types the engine writes to `.claude-plugin/types/claude-code/index.d.ts`, the types win. Update this file when you find out.

## Why a mod, and why TypeScript

- A mod is a plugin whose `hooks/hooks.json` names a hooks module that exports `register(on)`. Claude Code runs it in its own process, in an environment with **no Node and no DOM**: only JavaScript or TypeScript, and everything outside the module goes through `$`. Go can't run inside a mod. The only way to reuse the Go binary would be to start it with `$.process.run` on every refresh, which would mean two installs and a process per redraw, so the logic was ported instead.
- Mods need Claude Code v2.1.287 or later. They draw in the terminal and in the Desktop app's Code tab. Hooks also run, without drawing, in the VS Code chat panel, `claude -p`, and the Agent SDK.
- A mod runs with the user's permissions and isn't sandboxed. That's unrelated to bypass-permissions mode: paceline needs no permission mode at all.

## Where paceline can draw

- **A plugin can't set the status line.** The manifest's `settings` key accepts only `agent` and `subagentStatusLine`, and the status line isn't a render site. The Go paceline keeps that slot, and the two can run side by side.
- **`$.ui.status(text)` doesn't work for the line.** Tested: it draws a plain-text notice under the prompt, shows ANSI escapes as garbage (`�[32m`), and the engine puts a warning glyph and the plugin's name in front. It's meant for short notices.
- **The `AbovePrompt` band works.** Tested: `Text` takes `color` as a hex string (`'#c792ea'`) or a theme key (`'warning'`, `'error'`). **`dimColor: true` and the `inactive` theme key both draw as plain text there**, far brighter than the Go line's ANSI dim, so `src/band.ts` draws dim parts in a fixed gray (`#767676`). It comes out slightly lighter than the Go line's dim; a darker gray is a one-line change. The terminal draws named colors (`'green'`, `'cyan'`, `'yellow'`) in its own palette, the same as the Go line's ANSI codes. The band shows a `[-]` collapse mark at its right edge (Ctrl+X Ctrl+A also collapses it), and other mods can draw there too. `src/band.ts` keeps what later mods draw by putting `await next(e)` under the line.
- A `Box` with `flexWrap: 'wrap'` around one `flexShrink: 0` Box per segment wraps whole segments onto the next row in a narrow window.
- Other places a mod can draw: a pane (`$.ui.open`, docked beside the transcript in a wide fullscreen terminal; a pane opened unasked waits for 144 columns), toasts (`$.ui.toast`), and restyling Claude Code's own sites (`Spinner`, `PromptHint`, messages, tool rows).

## Where each figure comes from

The Go paceline reads the status line JSON on stdin. The mod rebuilds the same payload shape from the API (`src/live.ts`), so `src/render.ts` runs unchanged:

| Payload field | Mod source | Notes |
|---|---|---|
| `model.display_name` | `$.session.model()` | Returns the raw ID (`claude-opus-5-5`), not the display name. `src/model.ts` maps it. |
| `effort.level` | `e.effort.level` on `classic.PostToolUse` and `classic.Stop` | No API reading. Falls back to `effortLevel` from `$.settings.read()` until the first turn. |
| `fast_mode` | `$.settings.read().fastMode` | Unverified: no API exposes fast mode, and this key may not be where Claude Code keeps it. |
| `workspace.current_dir`, `project_dir` | `$.session.cwd()`, `$.session.root()` | |
| `rate_limits` | `$.session.usage().rateLimits` | `{ kind: 'five_hour' | 'seven_day', percentUsed, resetsAt }`, with `resetsAt` as an ISO string. Empty off a subscription. The test showed these match the Go line exactly. |
| `context_window.used_percentage` | `$.session.usage().context.percent` | |
| `cost.total_duration_ms` | `$.clock.now() - usage.startedAt` | `startedAt` is the first launch for a resumed session. |
| `prompt_cache` | not available | No `cache cold` segment yet. The `model.switch` event carries `cache_ttl` (`'5m'` or `'1h'`) and `prompt_cache_warm`, and `classic.SessionStart` on resume carries `prompt_cache_likely_expired`, so an estimate (last response time plus TTL) may be possible. |
| git branch | `.git/HEAD` read with `$.fs` | `$.session.repo()` has no branch field. |

`session.measure` fires after each main-thread turn and whenever a rate-limit window moves a whole point. That plus a 15-second timer drives refreshes.

## Validator and runtime rules

- `claude plugin validate` follows `$` only into functions declared at the top level of the hooks module: never across an import, and never into an arbitrary closure. This is why every `$` call is in `hooks/register.ts`.
- A hook on an event that can refuse something (`tool.call`, `classic.*`, and others) is listed as a gating hook. Watch-only hooks there get `.catch(($, e, next) => next(e))`.
- `$.fs.read` rejects files over 4 MiB. Stat first and cap smaller files yourself.
- `$.store` is one JSON file per plugin under `~/.claude/plugins/store/`, shared by every session on the machine; a get then set isn't atomic. `$.state` holds values for the session, survives hot reloads, redraws its readers when written, and resets on `/clear`, `/resume`, and `/branch`.
- Test environment: `claude plugin test` runs `*.test.ts` files with `test`, `expect`, and `describe` from `claude-code/testing`. Local time and `Intl` work there; fs, network, and processes don't.

## Ideas not built yet

- **Toast when today's budget runs out**, from `session.measure`. Only a mod can do this.
- **`/paceline` command** to change the style, segments, or count direction without editing `paceline.json`. Register it in `session.start` with `$.command.register`.
- **A history pane**: day-by-day usage kept in `$.store`, drawn with `Raster` for a sparkline in the terminal.
- **Built-in budget and progress tools** with `$.tool.register`, replacing `paceline-mcp`. A plugin named `paceline` gets tool names `mcp__paceline__<name>`, the same as the MCP server's today, so agents and orc-pack keep working. Users must not run both at once.
- **The prompt-cache warning**, from the events above.
- **CI** that installs Claude Code and runs `validate` and `test`.

## Sources

- [Mods overview](https://code.claude.com/docs/en/plugins/mods/overview)
- [Create a mod](https://code.claude.com/docs/en/plugins/mods/create)
- [Draw in the interface](https://code.claude.com/docs/en/plugins/mods/interface)
- [Plugin manifest reference](https://code.claude.com/docs/en/plugins-reference)
- [Built-in mod source](https://github.com/anthropics/claude-code/tree/main/mods) and [sample mods](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods); `token-weather` draws in the same band
- The `plugin-authoring` skill bundled with Claude Code: its `reference.md`, examples, and `types/claude-code.d.ts`
