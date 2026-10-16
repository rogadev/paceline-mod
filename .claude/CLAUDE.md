# paceline-mod

paceline as a Claude Code mod: a TypeScript plugin that draws paceline's usage line in the band above the prompt. It is a port of the Go status line in [rogadev/paceline](https://github.com/rogadev/paceline) (local checkout: `~/Documents/GitHub/paceline`), which stays the classic `statusLine` version. paceline-tray is retired and kept only for posterity.

Read `docs/notes.md` before changing how the mod talks to Claude Code: it holds what the mods platform can and can't do, the drawing test's results, and the API facts this design rests on.

## Layout

```
.claude-plugin/plugin.json       manifest; the plugin's name is `paceline`
.claude-plugin/marketplace.json  makes this repo a marketplace (`/plugin install paceline --marketplace rogadev/paceline-mod`)
hooks/hooks.json                 names the hooks module
hooks/register.ts                the hooks module: events, refresh loop, and EVERY call on `$`
src/                             pure logic, no `$`: pace, render, color, md5, config, payload, progress, gitinfo, sanitize, timefmt, model, live, band
test/                            *.test.ts, run by `claude plugin test`
test/fixtures/                   the Go repo's parity.json and progress.json, copied as TypeScript
.claude-plugin/types/            written by the engine when it loads the mod; gitignored
.claude/CLAUDE.md                this file (a CLAUDE.md at the plugin root draws a validate warning)
docs/notes.md                    platform research and design notes
```

## Commands

```sh
claude plugin validate .   # what the module hooks and calls; anything the engine would refuse. Must pass with no warnings.
claude plugin test .       # every *.test.ts
tsc -p .                   # type check; needs .claude-plugin/types (see below)
```

`.claude-plugin/types/` appears once an interactive session loads the mod from a folder it watches: `claude --plugin-dir .`, or a link to this repo in the session's dev-mods folder (see Live testing). Without it, type-check with a scratch tsconfig whose `files` names the `claude-code.d.ts` the `plugin-authoring` skill writes, keeping `allowImportingTsExtensions` and the rest of this repo's options.

Run all three before every commit.

## Rules that are easy to break

- **Every call on `$` lives in `hooks/register.ts`, inside a function declared at the top level of that file.** `claude plugin validate` follows `$` only into functions declared in the hooks module itself. Passing `$` to an imported function, or to a function that isn't declared at top level, fails validation. `src/` takes plain data and returns plain data; `register.ts` does the reads and passes results in. Keep it that way so `src/` stays testable without an engine.
- **Observer hooks on gating events get `.catch(($, e, next) => next(e))`.** `tool.call` and the `classic.*` hooks here only watch. The catch lets the event go on if the hook throws, and replays `next` if the hook had already called it.
- **Never write `~/.claude/paceline-day.json`.** That's the Go paceline's day anchor. The mod reads it (and prefers it when it matches the same day and week) but keeps its own anchor in `$.store` under the key `day`. A bad write there once reset the user's budget for the day.
- **The forecast's history lives in `$.store` under `activity`**: per local day, 24-bit masks of the hours seen and the hours usage rose, 14 days kept, plus the last readings. Write it only when `recordActivity` says it changed; every session on the machine refreshes every 15 seconds.
- **Segments must match the Go paceline byte for byte.** `test/parity.test.ts` renders every case in the Go fixtures through `toAnsi` with the Go layout: no `compact` and no `limits` pick, with the session segment forced on as the Go parity test does. The mod diverges on purpose through the `compact` option on `RenderContext`, switched on in `renderLive` and nowhere else: the project ahead of the model, effort as the bare level, the session hidden while the forecast runs, and a warning after the week when `src/forecast.ts` says a limit runs out before it resets. Today and the week stay the Go segments in both layouts. Without `compact`, `render` must keep printing the Go line. If you change what a segment shows, change it in the Go repo too, or decide on purpose that the two diverge and say so in the README.
- **Don't edit the fixtures by hand.** Copy them again from `internal/render/testdata/` in the Go repo when they change, and update the commit hash in each file's header.
- **Source files are ASCII.** Write non-ASCII characters as `\uXXXX` escapes in `.ts` files (the line's glyphs, the middle dot, ellipses). The file tools have turned escapes into raw characters before, so scan with Python after writing anything with escapes. Markdown is exempt.
- **Imports name the `.ts` extension** (`'./render.ts'`). The engine loads `.ts` directly; `tsconfig.json` sets `allowImportingTsExtensions`.
- **Tests can't read files.** `claude plugin test` runs in an environment with no fs, network, or process, and the engine loads only code files, so fixtures are `.ts` modules that export data.
- **Calendar math takes a `Zone`.** Live code passes `'local'`; tests pass `'utc'`, because the fixtures were recorded in UTC.
- **Module variables reset on every hot reload.** The first refresh refills `line`. Anything that must survive a reload belongs in `$.state` (resets on `/clear`) or `$.store` (persists, shared by every session on the machine, and a get-then-set isn't atomic).

## Live testing

The user judges changes by seeing them, so try every change live before committing:

1. Load the repo in a session, either with `claude --plugin-dir ~/Documents/GitHub/paceline-mod`, or by linking the repo into the current session's mods folder (Windows: `New-Item -ItemType Junction -Path <dev-mods>/<session>/paceline -Target <repo>`). The `plugin-authoring` skill names that folder.
2. With hot reloading on, the mod reloads when a turn that edited it ends. A failed hook or a refused tree shows as a dim line in the transcript naming `paceline`.
3. Show the user, and commit only after they approve.

## Git and release

- Work on `dev`. `main` and `dev` both start at the first commit. Push to `dev`, then stop: don't watch CI or open a PR unless asked.
- Conventional commit subjects (`feat:`, `fix:`, `docs:`, `test:`) that name the change, not the process. No attribution lines.
- The version is in `.claude-plugin/plugin.json`. A user on a marketplace install gets a new version only when it changes, so bump it with every release.
- No CI yet. Adding it means installing Claude Code in GitHub Actions to run `claude plugin validate` and `claude plugin test`.
