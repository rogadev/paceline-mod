# paceline (mod)

A Claude Code mod that paces your usage limits and shows, at a glance, where every session stands, in a line above the prompt.

```
t ▰▰▱▱▱ · w→Tue 10pm · paceline (dev) · Opus 5.5 · high · 59m
```

`t` is today's budget as a bar that fills as you use it, so a fuller bar always means you're closer to the end of the day's share. `w→Tue 10pm` is a warning: at your current pace, your weekly limit is forecast to run out Tuesday at 10pm, before it resets. A warning shows only when a limit is on track to run out, and `s→` does the same for your five-hour session; on a normal day, neither shows. See [Which limit shows](#which-limit-shows).

Your weekly limit resets on a fixed schedule, but Claude Code only tells you how much is left, not whether that's a lot or a little for the days remaining. paceline divides what's left by the days until the reset and gives you **today's budget**, then counts up how much of it you've used as you work. A light week gives you a big budget; a heavy one, a small budget.

This is the mod version of [paceline](https://github.com/rogadev/paceline), the Go status line. Its segments come from the same math, checked against the same test fixtures, but it installs as a plugin, draws in the band above the prompt, leads with today's budget as a bar, and shows a usage limit only when it's about to run out.

## Install

In a Claude Code session in your terminal, run:

```
/plugin install paceline --marketplace rogadev/paceline-mod
```

Answer `y` to add the marketplace, then pick a scope (user scope puts it in every session). The line appears above the prompt right away.

Requirements:

- Claude Code v2.1.287 or later. Run `claude --version` to check.
- The line draws in the terminal and in the Code tab of the Claude Desktop app. The VS Code extension's chat panel and `claude -p` don't draw mods.

To hide the line for a while, click the `[-]` at the right end of the band, or press Ctrl+X then Ctrl+A. To remove it, uninstall the plugin from the **Installed** tab in `/plugin`.

## What each segment means

| Segment | Example | Shows |
|---|---|---|
| Today | `t ▰▰▱▱▱` | How much of today's budget you've used, as five cells, each a fifth of the budget, filled to the nearest fifth. Past the budget, a full red bar and how far over: `t ▰▰▰▰▰+40%`. Always first. Verbose: `today ▰▰▱▱▱`. |
| Week warning | `w→Tue 10pm` | Only when the weekly limit is forecast to run out before it resets, and when, to the hour. Yellow while that's more than a day away, red within a day. Verbose: `week→Tue 10pm`. |
| Session warning | `s→3:45pm` | Only when the five-hour session is forecast to run out before it resets, and when, to the quarter hour. Always red. Verbose: `session→3:45pm`. |
| Project | `paceline (dev)` | The folder, in a color unique to the project, and the git branch. |
| Model | `Opus 5.5` | The model. |
| Effort | `high` | The effort level, only when it's above `low` or `medium`. Verbose: `high effort`. |
| Fast mode | `fast mode` | Only while fast mode is on. |
| Context | `ctx 72%` | Only when the context window is 70% or more full. |
| Progress | `loop ▰▰▰▰▱ #44 3/5` | Only while an agent reports a long job's progress. See [Progress bar](#progress-bar). |
| Duration | `16m` | Session wall-clock time. Always last. |

**Today's budget** is the weekly percentage left at the start of the day, divided by the days from midnight to the reset. It stays fixed all day. Whatever you don't spend spreads over the remaining days. The bar shows how much of the budget you've used, not the budget's size, so a full bar means the same thing in a light week and a heavy one. The color is your pace: green while you have room, yellow once you've used more than 70% of the budget, and red past 85%. On the final day before the reset, the budget is everything left in the week.

**Project colors** come from a hash of the project folder name, mapped to one of 12 evenly spaced hues in the OKLCH color space, so every color is equally bright. A project keeps its color everywhere, including its subfolders, and it's the same color the Go paceline gives it.

### Which limit shows

Your session and weekly limits are separate, and usually neither is close to stopping you. paceline forecasts both and warns you only when one is on track to run out:

- **A limit that runs out before it resets shows as a warning.** The arrow means "forecast to run out at": `w→Tue 10pm` says your week runs out Tuesday at 10pm, and `s→3:45pm` says your session runs out at 3:45pm. It's not the reset time. If both are forecast to run out, the sooner one shows.
- **The time rounds down**, to the hour for the week and to the quarter hour for the session, so the warning never promises more time than the forecast gives. If rounding down would give a time that's already past, the exact minute shows instead.
- **Otherwise, nothing shows.** A limit that lasts until it resets needs no space on the line.

The forecast learns when you work. Each refresh notes which hours of the day your usage goes up, over the last 14 days, so a 9-to-5 user's nights count for little and an agent running around the clock counts every hour. The weekly burn rate is today's average per hour of work, falling back to the week's average early in the day; the session uses its own five-hour window. Until a few days are recorded, every hour counts as an even chance of working.

If you use an API key instead of a subscription, Claude Code reports no rate limits, so neither the bar nor a warning shows. To see both limits all the time, set `"limits": "both"` in [`paceline.json`](#configuration): the line shows `s 4% · w 59%` after the bar, as the Go line does, with the session's reset time once less than 30% of it is left.

### How it differs from the Go status line

- **It draws above the prompt**, in the band mods share, not in the status line under it. A plugin can't set your status line, so the two can run side by side.
- **A compact layout.** It leads with today's budget as a bar instead of `t 46% of 28%`, shows a usage limit only as a warning when it's forecast to run out, and puts the project ahead of the model. Effort is the bare level, `high`, instead of `high effort`. With `"limits": "both"`, the session and week show as percentages, as in the Go line, but the order and the bar stay compact.
- **No prompt-cache warning yet.** The mods API doesn't report when the prompt cache expires, so the `cache cold` segment never shows.
- **Effort** comes from the latest turn. Until the first tool call or reply in a session, it falls back to the `effortLevel` in your settings.
- **Fast mode** is read from the `fastMode` key in your settings, which may not match every way fast mode can be turned on.

## Configuration

paceline reads the same `~/.claude/paceline.json` (or `$CLAUDE_CONFIG_DIR/paceline.json`) as the Go paceline, so one file configures both. Every key is optional.

```json
{
  "segments": { "duration": false },
  "thresholds": { "headroomGreen": 30, "headroomYellow": 15, "contextWarn": 70, "contextCritical": 85 },
  "countDirection": { "session": "up", "week": "up", "today": "up" },
  "quietEfforts": ["low", "medium"],
  "projectSlots": { "website": 4 },
  "verbose": false,
  "limits": "auto"
}
```

- `segments`: turn any segment off: `model`, `effort`, `fastMode`, `project`, `branch`, `session`, `week`, `today`, `context`, `cache`, `duration`, `progress`.
- `thresholds`: percentages where colors change from green to yellow to red, and where the context warning appears. `headroomGreen` and `headroomYellow` count what's left of a limit.
- `countDirection`: `"up"` or `"down"` for `session`, `week`, and `today`, each on its own. `"down"` counts what's left from 100%: today's bar fills with what's left of the budget, and past the budget it's empty, followed by how far over in red (`t ▱▱▱▱▱+18%`).
- `quietEfforts`: effort levels that don't need a label.
- `projectSlots`: pin a project to a color slot from 0 to 11.
- `verbose`: spell out the labels (`today`, `week→`, `high effort`) instead of one letter or a bare level (`t`, `w→`, `high`).
- `limits`: `"auto"`, the default, shows a warning only for a limit forecast to run out before it resets; `"both"` shows the session and week percentages all the time. The Go paceline ignores this key.

The mod reads the file on every refresh, so a change shows within 15 seconds. A key with the wrong type or range is ignored, and a file that isn't valid JSON gives the defaults.

### Today's budget across sessions and tools

The budget is anchored at the first reading of each day. The mod keeps that anchor in its own plugin store, which every session on your machine shares. If the Go paceline has already anchored the same day and week in `paceline-day.json`, the mod uses that anchor instead, so both lines show the same budget. The mod never writes `paceline-day.json`.

## Progress bar

When an agent works through a long job on its own, paceline shows how far along it is:

```
loop ▰▰▰▰▱ #44 3/5          one cell per step: done, active, skipped, blocked, pending
orc ▰▰▱▱ #42 review 55%     a planned run: weighted percentage, moving within a step
loop ▰▰▰ ✓ done             finished; hidden 30 minutes later
```

The mod reads the same progress files as the Go paceline: `.git/paceline/progress-<session id>.json` for this session's run, or `.git/paceline/progress.json` for a writer outside Claude Code. Agents write them through `paceline-mcp`, the MCP server that ships with [paceline](https://github.com/rogadev/paceline#let-agents-report-progress). The file format is documented there.

## What the mod can reach

A mod runs inside Claude Code with your permissions, so here is everything this one does. `claude plugin validate` on this folder lists the same calls.

- **Reads** your session's usage figures, model, working folder, and settings through the mods API.
- **Reads** `paceline.json` and `paceline-day.json` in your Claude config folder, and `.git/HEAD` and `.git/paceline/progress*.json` in the repository you're working in.
- **Reads** the environment variables `CLAUDE_CONFIG_DIR`, `USERPROFILE`, and `HOME`, only to find your Claude config folder.
- **Writes** two values to its own plugin store: today's budget anchor, and which hours of the last 14 days your usage went up in, for the forecast.
- **Watches** tool calls and turns only to notice progress updates and the effort level. It never changes, blocks, or approves anything.
- It starts no processes, makes no network requests, and calls no model.

Text from outside paceline (folder names, branch names, model names, and progress labels) is stripped of control characters, zero-width characters, and bidi overrides before it's drawn.

## Development

The mod is TypeScript that Claude Code loads directly, with no build step.

```
hooks/register.ts   the hooks module: events, and every call on the mods API
src/                the line itself: pace math, rendering, config, git, progress
test/               tests, and the Go paceline's fixtures copied as TypeScript
```

Run a session with your working copy loaded:

```sh
claude --plugin-dir ./paceline-mod
```

Check it:

```sh
claude plugin validate .   # what the module hooks and calls, and anything the engine would refuse
claude plugin test .       # every *.test.ts file
tsc -p .                   # type check, once a session has loaded the mod and laid its types
```

[`docs/notes.md`](docs/notes.md) records what the mods platform can and can't do, where each figure comes from, and ideas not built yet. `.claude/CLAUDE.md` holds the working rules for agents.

`test/fixtures/` holds the Go paceline's `parity.json` and `progress.json` as TypeScript modules. The parity tests prove the mod renders exactly the bytes the Go paceline prints for every case. When the Go fixtures change, copy them again rather than editing the cases by hand.

## License

MIT
