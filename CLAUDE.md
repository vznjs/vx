# `@vzn/vx` — project memory for Claude

**Start every session by reading `packages/vx/docs/STATUS.md`.** It holds
direction and what is next. Edit it only when direction or the Next list
changes, never per PR (2026-10-12: per-PR STATUS and history
entries made every open PR conflict). A merged change is recorded in its
PR and its change file, not in a repo log. This file holds only what does
not change week to week.

## What vx is

The Vite of task orchestration: a Bun-native task runner and
content-addressed cache for JS monorepos, built as a **pipeline with
seams**. Core discovers projects, evaluates `vx.config.ts` files, builds a
task graph, derives cache keys, and schedules. Plugins decide where a task
runs (`executor`), where artifacts live (`cache`), who observes
(`telemetry`), and — as the seams widen — how the graph is shaped and which
CLI verbs exist. Core applies NO plugin by default. Running here and
caching here are core's FLOOR, not plugins: the local executor sits at
the tail of every executor list and the local cache heads every cache
chain (asked first, then each remote in declared order), so a
`.vx/workspace.ts` declaring no plugin runs and caches, and a plugin that
declines a task hands it back to this machine. That file is required:
the nearest one up from the cwd, never above the git top-level, marks
the workspace root (2026-10-13).

Pipeline stages a plugin can fill, in order: `config` → `discover` → `project` →
`graph` → `key` → `fingerprint` → `schedule` → `admit` → `executor` /
`cache` → `telemetry` / `output`, with `setup` / `teardown` around the run, plus
`commands` (CLI verbs). Design: `docs/design/pipeline-2026-09.md`.

Decision drivers, in order: **performance, modularity, extensibility.**
No cloud or dashboard ships in this repo; the seams exist so someone can
build those on top. The one exception is `@vzn/vx-dte` (2026-10-21):
one run spread over workers the user's own CI spawns, through a relay
(`@vzn/vx-dte-server`) anyone can host. `@vzn/vx-reapi` is the proof
the seams are wide enough. Pre-alpha, owner-delegated: you own it, ship it.

## Stack

Bun ≥ 1.4.4 only (`bun:sqlite`, `Bun.spawn`, `Bun.Glob`, `Bun.zstd*` are
hard dependencies; the artifact's tar is vx's own streaming code, and
`Bun.Archive` is a TEST oracle only). `bun test`. `oxlint --type-aware --type-check` +
`oxfmt`. No build step: `src/bin.ts` runs via shebang; release binaries via
`bun build --compile`. Dependencies need a written reason next to them.

## Layout

```
packages/vx/            @vzn/vx core (src/ + tests/ + docs/); paths below relative to it
  src/bin.ts            shebang → cli
  src/index.ts          public façade (snapshot-pinned by tests/package-boundaries.unsafe.test.ts)
  src/config.ts         user schema: defineProject / defineWorkspace
  src/cli/              verbs: run watch cache lock init show info why last upgrade;
                        plugin-commands.ts resolves plugin verbs (`commands` seam);
                        workspace-config.ts is the workspace as every verb sees it (config
                        stage applied, cache dir, staged projects); select.ts is what a run
                        is asked to run (filters, --affected owners, cwd project, picker)
  src/orchestrator/     run() pipeline, placement (where a task runs), signals, admission (dedup +
                        continue-taint), execute-task (+ miss-save,
                        sandbox-request), task-hash,
                        projects.ts (the staged config load every reader shares), plugin
                        stages + seams, doctor.ts (the facts `vx info` reports)
  src/report/           the run event stream + terminal output: logger, frames, status line, summary,
                        forecast, plain output (renders outcomes; never runs or reads the cache)
  src/history/          what runs leave behind, read back (read-only SQL): the duration table, flakiness,
                        the `vx last` / `vx why` queries, a miss's key diff
  src/workspace/        discovery, config eval, config-schema.ts (what a config
                        may say), package graph, --filter/--affected, lockfile, migration.ts (the
                        plan → files seam @vzn/vx-migrate writes through)
  src/graph/            task graph + two-tier scheduler
  src/cache/            local SQLite+archive cache, layered/chained remote seam, inputs (glob
                        resolution, boundaries) + git-inputs (the git enumeration it trusts)
  src/exec/             runner (Bun.spawn), env isolation, sandbox, local-executor (the floor)
  src/util/             incl. timing.ts (`VX_DEBUG_TIMING=1` stage table)
  index.ts              root shim (Bun's compiled binary ignores the exports map)
packages/vx-reapi       Bazel REAPI plugin: remote cache + remote execution
packages/vx-otel        OpenTelemetry telemetry plugin (no SDK dep)
packages/vx-ci      GitHub Actions job summary plugin
packages/vx-migrate     adoption, one package (2026-09-11): `turbo()` runs a Turbo repo unchanged (turbo.json +
                        scripts → tasks via the `project` stage; owns the mapper the CLI renders from),
                        `nx()` runs an Nx repo unchanged (2026-09-22: the resolved graph → tasks; executor
                        targets are `nx-exec` lines — `src/nx-exec.cjs`, a Node bin over Nx's public
                        `runExecutor`, design docs/design/nx-unchanged-2026-09.md),
                        `turboCache()` / `nxCache()` keep a Turbo (`/v8/artifacts`) or Nx (`/v1/cache`) remote
                        cache, and `bunx @vzn/vx-migrate` writes vx.config.ts from turbo.json, an Nx graph or
                        package.json scripts (core `vx init` hands a Turbo or Nx repo to it, 2026-10-20). `src/turbo/`, `src/nx/`, `src/turbo-cache/`, `src/nx-cache/`
packages/vx-history  `schedule` plugin: order by the critical path learned from run history
packages/vx-lockfile    pnpm() bun() npm() yarn(): each claims its lockfile (`fingerprint` seam) and keys each
                        task on its project's own dependency closure; --affected follows. Parsers over core's
                        `lockfileClaim` (orchestrator/lockfile-claim.ts: memo, per-run gate, --affected diff).
                        This repo declares bun()
packages/vx-cache-server  a cache server anyone hosts (PROTOCOL.md, /v1): one bucket, no database; Bun or Docker + S3,
                        or Workers + R2, one handler, one conformance suite
packages/vx-devtools    code vx's servers and plugins share, never core (2026-10-25: core has nothing to do with
                        OIDC): first the CI OIDC token check (ALLOW, oidcAuth), only jose
packages/vx-history-server  the task timings vx-history reads, one folded row per task (PROTOCOL.md, /v1): Bun +
                        SQLite, Workers + D1, or Docker
packages/vx-cache       vxCache(): the remote cache, CI jobs only, over vx-cache-server's /v1 wire
private/vx-docs         Astro Starlight site; packages/vx/docs is imported by scripts/import-docs.ts
packages/vx-dte         distributed task execution: `dte()` executor + `vx dte worker` over the relay, `local()` adapter
                        (workers in git worktrees). Private until npm has it
packages/vx-dte-server  the reference relay of `@vzn/vx-dte` (PROTOCOL.md): passes a run's messages, storing none, behind CI
                        OIDC tokens; imports only jose, not even core. Private until npm has it
private/vx-bench        synthetic workspace generator + runners (vx / turbo / nx)
private/vx-servers      compose.yaml: the dte, cache and history servers' images in one file
skills/vx/SKILL.md      the agent skill, where `npx skills add vznjs/vx` finds it (.claude/skills are
                        `metadata.internal`, so that command offers nothing else; tests/skills-install.unsafe.test.ts)
packages/vx/docs        source of truth: STATUS.md, architecture, caching, cli, schema, modules/, design/;
                        history/ holds the shipped record STATUS moved out (read it only when an item's why matters)
```

`packages/` holds what ships to npm (vx-dte and its relay too, private
only until npm has them); `private/` holds what never ships (the site,
the bench, the plugin examples, deploy configs) (2026-10-23).

Module boundaries: each `src/<module>/index.ts` is the contract; cross-module
imports go through it only (`tests/module-boundaries.test.ts`). Plugin
packages import core only via `@vzn/vx` (`tests/package-boundaries.unsafe.test.ts`).

## Workflow

- **Push, open the PR, let CI judge, merge it yourself once CI is green**
  (2026-09-10: "merge whenever you own the project"). No full gate
  locally before a push (2026-10-12: gating twice wastes the
  time CI already spends); run only the fast checks for what you touched
  (that test file, oxlint on those files, `oxfmt --check`). Start the next
  unrelated work while CI runs; never wait idle on it. The full gate,
  `bun packages/vx/src/bin.ts run ci --all`, is for diagnosing a red CI.
  It refuses a Bun below `engines.bun` first (`check.bun`, item 575).
- `bun test` alone cannot see a type error: it is transpile-only. Never
  pipe a check through `tail`/`grep` — it masks the exit.
- The core suite runs as `SHARD_COUNT` (46, `vx.config.ts`) parallel
  shard tasks, generated from one template; `scripts/test-shard.ts <i>
<n>` deals the files by recorded weight (`tests/shard-weights.json`,
  refreshed with `--weigh <junit-dir>`), so the wall time is the
  average shard, not the alphabet's heaviest. Many processes is not
  only speed: `bun test` pins ~2 descriptors per imported module and
  macOS caps a process at 10 240, so the whole suite in one process
  does not clear the cap.
- `tests/*.unsafe.test.ts` is the suite a sandbox cannot host — the
  sandbox's own tests (seatbelt cannot nest), the cross-project law
  (a project may read only its own directory), the disk-full suite
  (a sandboxed task sees a mount it did not make as read-only), the
  repo-wide laws that read other packages and `.github/`, the
  liveness helper (the runtime's PID namespace hides a zombie), and
  the output-memory floods (strace's own `PTRACE_LISTEN` error ended
  the shard around them three times on CI, item 925). The
  shards exclude them in the dealer itself — `testFiles()` in
  `scripts/test-shard.ts` drops the name, so the shard command never
  sees the file; `test.bun.unsafe`'s `UNSAFE_SHARD_COUNT` (10) shards
  run them, dealt by `--unsafe` from `tests/unsafe-shard-weights.json`.
  Mac workers take only the platform's files (`test.platform`, dealt
  by `--platform`). The unsafe shards of both, `@vzn/vx-reapi#test` and
  `@vzn/vx-reapi#test.live` (which dial service containers on the host's
  loopback, unreachable from a Linux sandbox's network namespace), its
  `services.cache` / `services.exec` (Docker), `@vzn/vx-dte-server#test.live`
  (builds and runs the relay's image), `@vzn/vx-cache-server#test.live` and
  `@vzn/vx-history-server#test.live` (each builds and runs its image),
  `@vzn/vx-servers#test.live` (brings up the compose file of all three), `@vzn/vx-migrate#nx.install`
  (the npm registry), `check.sandbox-canary` and
  `check.build-cold` (each drives the sandbox itself, on a Mac worker) are
  the ONLY tasks in the whole repo with no `exec.sandbox`.
- Every package's suite is its `test` task, so `vx run ci --all` gates
  them all; CI runs nothing but vx tasks (a workspace step is a design
  smell — declare the cross-project read on the task instead). The one
  suite that needs live services, `@vzn/vx-reapi#test`, runs skip-mode
  in the gate; the live files run as `@vzn/vx-reapi#test.live` and
  `@vzn/vx-migrate#test.live` in the same Linux run, each bringing its
  services as foreground persistent tasks (uncached: the services and
  `nx@22` are unpinned).
- Sandbox tests skip without `bwrap`/`socat`/`strace`; `VX_REQUIRE_SANDBOX=1`
  (CI) makes an unavailable sandbox a failure.
- Format: `bun packages/vx/src/bin.ts run lint.oxfmt.fix`.
- Commits and PR titles: Conventional Commits (2026-09-27),
  `type(scope): imperative summary`, first line < 72 chars, body says
  why. Types: feat fix perf refactor test docs ci build chore revert; scope is
  the module or package (`cache`, `cli`, `vx-reapi`). CI holds a PR's title and
  commits to it (`tests/conventional-commits.unsafe.test.ts`); a `!` title
  needs exactly one breaking commit, as main's squash has. One coherent
  change per commit. Commit early; assume interruption.
- A feature is not done until its docs land in the same commit.
- A user-facing feature (verb, flag, config key, env var, plugin) also
  updates `packages/vx/docs/features.md` (`tests/features-inventory.unsafe.test.ts`
  holds it to the CLI and config contracts). Any behaviour change or
  addition also updates every text it makes stale (docs, blog, site) in
  the same PR, and Marketing signs that text off (2026-10-12).

## Conventions

- Always optimize for token usage (2026-09-27): replies,
  commits, PR titles and bodies, docs and logs use plain words, only
  what is needed, fewest words.
- No comments restating code; only "why" comments for non-obvious decisions.
- A plugin is `definePlugin(import.meta, hooks)` and its name is its
  package name — never a field, never overridden (2026-09-10).
- No half-finished implementations behind flags. Ship it or don't write it.
- Until 1.0 a breaking change ships with no alias, rename notice or
  migration shim (2026-10-14): old names simply stop working.
  Release notes, blog posts and change files may name the rename.
- Trust internal code; validate only at boundaries (user input, FS, network).
- Test fixtures use heredoc strings for `vx.config.mjs`.
- A probe that confirms a thesis becomes a test, not a note.
- A value `export` only its own file uses is not one; one nothing uses is
  dead. `tests/exports-referenced.unsafe.test.ts` holds the law (item 613);
  a type in an exported signature is the module page's surface, not the law's.

## Architecture principles

1. **Perf first.** Measure before and after; interleave A/B arms, min-of-N,
   "before" arm from an immutable `git worktree`, one workspace copy per
   arm pre-warmed by that arm (arms on different `SCHEMA_VERSION`s reset
   a shared copy, and the rep after a reset proves hits by the walk —
   min-of-N picks that rep). A change to the warm path without a number
   is not done.
2. **Explicit over magical.** Caching is opt-in; `inputs.files` is
   required; no inferred inputs (the sandbox, `exec.sandbox`, is how a
   task proves what it touches; `--verify` was removed 2026-09-04).
3. **One command per task; shell is the API.** A plugin changes WHERE a
   command runs, never what it is. Nothing boots between the scheduler
   and the shell: Nx's Node fork per task is ~270 ms of CPU (item 735).
4. **Resolved-config hashing.** The key sees the evaluated config object.
5. **Cascade through deps** by folding upstream INPUT keys, never outputs.
6. **Project boundaries are hard.** Globs never cross into another project.
7. **No defaults.** Core names no plugin; only the local floor is
   implicit. A capability a plugin must supply (a remote, a wire) is
   declared in `.vx/workspace.ts` or it does not exist.
8. **Seam over special case.** When core grows a branch for one consumer,
   the seam is too narrow.
9. **Once per run.** A run treats the files it reads as fixed except
   where vx or its own tasks write; each fact (a read, a stat, a PATH
   lookup, a spawn's answer) is learned once and reused. A repeat needs a
   measured reason, pinned by `tests/syscall-repeats.unsafe.test.ts` /
   `read-once.unsafe.test.ts`. The limit: an unsandboxed task may write
   anywhere, so a fact about a file a task could write is not reused
   across task runs, and a refusal is never decided from a memo (item 738).

## Rules learned the hard way

`packages/vx/docs/history/lessons.md` holds them (repro before fix, every
fix fails without itself, skips are silent passes, platform and timing
traps, sweep method). Read it before a probe, a sweep, a perf A/B, a
platform claim or a timed test, and add new lessons there.

## Live invariants (verify in source before quoting)

- `CACHE_VERSION` `vx-cache-v49`, core `SCHEMA_VERSION` `v49`,
  `TELEMETRY_SCHEMA_VERSION` 4. Bump `CACHE_VERSION` when stored bytes are
  wrong under an unchanged key or the container changes; a key-derivation
  fix whose old key was already wrong is self-healing and does not bump.
- Key derivation: xxh3 seed-chained parts (seed fed forward: Bun reads 32
  bits of a seed, item 682), `\0` delimiters, git blob OIDs
  for tracked-clean files, pure-input transitive hashing, and the
  `fingerprint` plugin's digest (a lockfile plugin's dependency closure);
  core folds no `package.json` or lockfile itself (#3562). `exec.remote` is
  stripped (placement only; `exec.resources` went with the reservations
  on 2026-09-12 and a config cannot declare it); `timeout`/`retries` and
  `description` are folded. Proven by `tests/task-hash-derive.test.ts`.
- Cache correctness is the worst failure class: a stale hit replays wrong
  bytes under a green run. Treat `execute-task.ts` changes as stale-hit-critical.
- Observability never breaks a run: sinks are crash-isolated and
  deadline-bounded; a remote cache error degrades to a miss; a never-fail
  plugin still warns. Proven by `tests/telemetry-lifecycle.test.ts`
  ("telemetry flush is time-bounded", "a malformed telemetry() return is
  rejected at the boundary") and `tests/layered-cache.test.ts`.
- Zero-cost gates: no telemetry plugin ⇒ no bus subscriber, no summary, no
  git spawn. A declined plugin costs nothing. Proven by
  `tests/telemetry-lifecycle.test.ts` ("the zero-cost gate keys on the
  telemetry capability").

## Rejected — do not re-propose

Named inputs / `globalInputs` / `globalEnv` (TS configs compose); auto-input
inference via tracing; folding `NODE_OPTIONS` into the key; lookahead /
idle-insertion scheduling (measured: `remCP` already ties or wins); a
first-party platform, dashboard, cloud, or CI-provider features (workers
only as `@vzn/vx-dte`);
Turbo remote-cache wire in core; HTTP/3.

## Operating directive

You own this project. Each turn: pick the next valuable thing from
`packages/vx/docs/STATUS.md`, do it, push, let CI judge, merge on green,
and say what you are doing next. Never end with "what next?".
