# paceline (mod)

A Claude Code mod that paces your usage limits and shows, at a glance, where every session stands, in a line above the prompt.

```
Opus 5.5 · techcentral (dev) · s 16% · w 4% · t 54% of 28% · 16m
```

Every number is how much you've used, counting up from 0%, so higher always means closer to a limit: `s` is your five-hour session, `w` your week, and `t` today.

Your weekly limit resets on a fixed schedule, but Claude Code only tells you how much is left, not whether that's a lot or a little for the days remaining. paceline divides what's left by the days until the reset and gives you **today's budget**, then counts up how much of it you've used as you work. A light week gives you a big budget; a heavy one, a small budget.

This is the mod version of [paceline](https://github.com/rogadev/paceline), the Go status line. It draws the same line, from the same math, checked against the same test fixtures, but it installs as a plugin and draws in the band above the prompt instead of the status line.

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
| Model | `Opus 5.5` | The model. |
| Effort | `high effort` | Only when effort is above `low` or `medium`. |
| Fast mode | `fast mode` | Only while fast mode is on. |
| Project | `techcentral (dev)` | The folder, in a color unique to the project, and the git branch. |
| Session | `s 82% (resets 3:40pm)` | How much of the five-hour limit you've used. The reset time appears once less than 30% is left. Verbose: `session 82% used`. |
| Week | `w 4%` | How much of the weekly limit you've used. Verbose: `week 4% used`. |
| Today | `t 46% of 28%` | How much of today's budget you've used, then the budget: today's share of the weekly limit, fixed for the day. Past the budget it keeps counting, in red: `t 118% of 28%`. Verbose: `today 46% used of 28% budget`. |
| Context | `ctx 72%` | Only when the context window is 70% or more full. |
| Progress | `loop ▰▰▰▰▱ #44 3/5` | Only while an agent reports a long job's progress. See [Progress bar](#progress-bar). |
| Duration | `16m` | Session wall-clock time. Always last. |

**Today's budget** is the weekly percentage left at the start of the day, divided by the days from midnight to the reset. It stays fixed all day. Whatever you don't spend spreads over the remaining days. The color is your pace: green while you have room, yellow once you've used more than 70% of the budget, and red past 85%. On the final day before the reset, the budget is everything left in the week.

**Project colors** come from a hash of the project folder name, mapped to one of 12 evenly spaced hues in the OKLCH color space, so every color is equally bright. A project keeps its color everywhere, including its subfolders, and it's the same color the Go paceline gives it.

### How it differs from the Go status line

- **It draws above the prompt**, in the band mods share, not in the status line under it. A plugin can't set your status line, so the two can run side by side.
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
  "verbose": false
}
```

- `segments`: turn any segment off: `model`, `effort`, `fastMode`, `project`, `branch`, `session`, `week`, `today`, `context`, `cache`, `duration`, `progress`.
- `thresholds`: percentages where colors change from green to yellow to red, and where the context warning appears. `headroomGreen` and `headroomYellow` count what's left of a limit.
- `countDirection`: `"up"` or `"down"` for `session`, `week`, and `today`, each on its own. `"down"` counts what's left from 100%, and shows today past its budget as `t over 18%`.
- `quietEfforts`: effort levels that don't need a label.
- `projectSlots`: pin a project to a color slot from 0 to 11.
- `verbose`: spell out the labels (`session 16% used`) instead of one letter (`s 16%`).

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
- **Writes** one value, today's budget anchor, to its own plugin store.
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

`test/fixtures/` holds the Go paceline's `parity.json` and `progress.json` as TypeScript modules. The parity tests prove the mod renders exactly the bytes the Go paceline prints for every case. When the Go fixtures change, copy them again rather than editing the cases by hand.

## License

MIT
