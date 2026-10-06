# Workstream T — the Nx and Turbo asks (2026-10-03)

The owner's ask: build the top requests from Nx and Turbo issues that vx
lacked (research in the project thread, 2026-10-03).

- **T-1.** Cache scopes (owner: "trusted and untrusted cache… scoped per
  PR"; CREEP, CVE-2025-36852; Nx discussion #28332). `cacheScope` in
  `vx.workspace.ts`: `'trusted'` (default) reads and writes the task
  keys, `'read-only'` writes nothing (the CLI's default off CI, owner), any
  other name reads its own key, then the trusted one (owner: "nested
  lookup first from pr scope"; a batch probe that found only the trusted
  key skips the scope's GET), and writes its own only. `VX_CACHE_SCOPE` (owner: "allow to use env
  var") beats the workspace and `github()` (`ScopedRemote` in
  `layered-cache.ts`, a key `xxh3(scope, task key)` so every wire stores
  it unchanged). `github()` sets it from the ref on Actions: the default
  branch trusted, `pr-<n>`, `ref-<name>`, and an unknown default branch
  untrusted. The owner's caveat stands in security.md: a client-side
  convention, not a boundary; the server must scope writes by token.
  Rows: `cache-scope.test.ts` (core: scoped writes, own-scope reads,
  own-scope-first, one GET per hit, read-only, the CLI default) and vx-github's `cache-scope.test.ts`, each
  red without its half.
- **T-3.** (2026-10-03, owner ask: interactive tasks, Turbo #1235, Nx
  #8269). `exec.interactive: true`. When vx's stdin is a TTY
  (`RunOptions.tty`, set by the CLI) the task inherits vx's stdin,
  stdout and stderr, still in its own session; off one it runs as
  before. It runs alone (scheduler `exclusive`: dispatch stops until
  the running tasks drain). A persistent one holds the terminal from
  spawn to run end, so a run takes one and every other interactive
  task must be its dependency, refused before any task runs
  (`terminalHolders`). Placed on the local floor past every plugin.
  `cache`, `sandbox` and `persistent.readyWhen` beside it are
  refused. bwrap's `--new-session` does not break a terminal
  (probed), but the sandboxed spawn reads the task's stderr, and
  macOS cannot be probed here. The logger kills the status region at
  its start and frames it live. `turbo()` and the CLI migrator map
  Turbo's `interactive` to it, uncached. schema.md § `interactive`.
  - Rows: `interactive.test.ts` (refusals, placement, holders, the
    scheduler's drain, a run on and off a TTY) and
    `terminal.unsafe.test.ts` (a typed line reaches a one-shot and a
    server on a pty; undeclared reads EOF), `status-line.test.ts`.
    Mutants of each gate (start, hold, placement, stdio, request,
    holders, clash, logger, persistent stdio) each fail a row.
- **T-2.** (owner's ask, Nx #2675). Project `tags`: a
  vx.config's `tags` (non-empty strings; D-56 refused the key) select
  by `--filter tag:<pattern>`, every name operator included; Nx's
  `--projects tag:` aliases it. Read from the staged load, so a
  `project` plugin's tags count; loaded only when a `tag:` filter is
  present. In no cache key (only the task config is hashed). `vx show`
  and `vx mcp`'s `listTasks` list them; `nx()` and the Nx migrator
  carry each project's Nx `tags`. Rows: `project-tags.test.ts`,
  `filter.test.ts` › `tag:`, `nx.test.ts` › "an Nx project's tags".
- **T-4.** 2026-10-03 (owner ask) — `vx prune <project...> [--docker]` is back as a verb of `@vzn/vx-lockfile`'s four plugins, each lockfile pruned to what the subset installs (bun, pnpm, npm, yarn 1 frozen-installed offline in its tests; yarn 4 `--immutable` checked by hand). A verb's owner is now a package, so `bun()` + `pnpm()` share one `prune`. Not done: a `file:` dependency outside the copied projects is not copied.
- **T-5.** 2026-10-04 (owner: "if no tasks are connected then projects are not affected") — `--affected` selects tasks, not projects. A change seeds a cached task when a changed path is one of its declared inputs; every task of a project whose `package.json` or config changed, that holds a path no cached task declares, or that a claim, a base-manifest edge or a config import names; an uncached task when its project changed; never a group. A bare requested task runs when its `dependsOn` closure holds a seeded one; a named `pkg#task` always runs. The candidates stay `...[<base>]`'s, so the narrowing costs one graph build. Nx 23.3 (`NX_LEGACY_AFFECTED=false`) and Turbo (`affectedUsingTaskInputs`) ship the same behind flags; vx's differs from Nx's in walking plain `dependsOn` (Turbo's choice). A project whose config and plugins declare no `build` gets one: a group behind `^build` keyed on `**` (`computeGroupKey`), so a source-consumed package moves its dependants' keys and reaches them; a `^name` walk through a package with no loaded config reaches it the same way. Rows: `affected-dependents.test.ts` › "--affected follows task edges".
- **T-6.** 2026-10-04 (owner, migrating solidjs/solid with `pnpx @vzn/vx-migrate`) — vx-migrate is the one adoption command. A terminal is asked native (configs, the default) or keep (`turbo()` / `nx()` via `vx init`); `--native` / `--keep` answer it, no terminal is native. It installs `@vzn/vx` (and `@vzn/vx-migrate` for keep) with the repo's manager unless listed or installed (`--no-install`). A script-less package's `build` behind `^build` is no longer written as `true`: core's default build is that node. A generated config says "Review the TODO(vx-migrate) comments" only when it has one. Rows: `vx-migrate/tests/adopt.test.ts`.
- **T-7.** 2026-10-06 (owner: "I don't think we should touch inner commands") — vx-migrate no longer rewrites root `package.json` scripts; it writes vx files and installs vx, nothing else.
- **T-8.** 2026-10-06 (owner: solid ran under turbo, vx wanted a global npm) — every task gets `npm_execpath`, the workspace's manager binary (`packageManager`, else the lockfile; root `node_modules/.bin`, then `PATH`), unless `passThrough` or `define` gives it. npm-run-all calls it back instead of `npm`. Not keyed (a local path, like `PATH`). Rows: `env.test.ts` › `npm_execpath`.
- **T-9.** 2026-10-06 (owner: "install and migrate fully … use the plugins") — vx-migrate declares, without installing (they are built into the binary, #2778), the plugins a repo calls for, in one `@vzn/vx/plugins` import: the lockfile's factory, `scheduleHistoryPlugin()`, and `github()` beside `.github/workflows`. Native writes `vx.workspace.ts` when none exists (core's `applyMigration` takes a plan's own workspace file); keep extends the one `vx init` writes. The "Declare pnpm()" note now shows only beside an existing workspace file. Rows: `vx-migrate/tests/adopt.test.ts`.
- **T-10.** 2026-10-06 (owner) — written configs and workspace files carry no "Generated by" header and no explanatory comments; the preset keeps its section notes.
- **T-11.** 2026-10-06 (owner: "you should own it") — a `~/.vx` level of the user's own that is open to others is chmodded 0700 instead of refusing the shared store. Rows: `shared-store.test.ts`.
- **T-12.** 2026-10-06 (owner: "no more comments like this … you own the cache") — vx prints no cache upkeep: a schema reset, a format bump, a move to the shared store and a fallback from it are all silent (`noteSchemaReset` is gone). Rows: `schema-reset-notice.test.ts`, `shared-store.test.ts`, `cli-streams.test.ts`.
