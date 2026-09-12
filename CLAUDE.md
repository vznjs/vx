# `@vzn/vx` — project memory for Claude

**Start every session by reading `packages/vx/docs/STATUS.md`.** It is the living
handoff: direction, what shipped, what is in flight, what is next. Update
it in the same commit as the work. This file holds only what does not
change week to week.

## What vx is

The Vite of task orchestration: a Bun-native task runner and
content-addressed cache for JS monorepos, built as a **pipeline with
seams**. Core discovers projects, evaluates `vx.config.ts` files, builds a
task graph, derives cache keys, and schedules. Plugins decide where a task
runs (`executor`), where artifacts live (`cache`), who observes
(`telemetry`), and — as the seams widen — how the graph is shaped and which
CLI verbs exist. Core applies NO plugin by default. Running here and
caching here are core's FLOOR, not plugins: the local executor and the
local cache sit at the tail of every executor list and cache chain, so a
workspace with no `vx.workspace.ts` runs and caches, and a plugin that
declines a task hands it back to this machine.

Pipeline stages a plugin can fill, in order: `config` → `project` →
`graph` → `key` → `schedule` → `executor` / `cache` → `telemetry` /
`setup`, plus `commands` (CLI verbs). Design: `docs/design/pipeline-2026-09.md`.

Decision drivers, in order: **performance, modularity, extensibility.**
Nothing distributed ships in this repo (no agents, cloud, dashboards); the
seams exist so someone can build those on top. `@vzn/vx-reapi` is the proof
the seams are wide enough. Pre-alpha, owner-delegated: you own it, ship it.

## Stack

Bun ≥ 1.4 only (`Bun.Archive`, `bun:sqlite`, `Bun.spawn`, `Bun.Glob` are
hard dependencies). `bun test`. `oxlint --type-aware --type-check` +
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
                        stages + seams, events, logger, doctor.ts (the facts `vx info` and
                        `vx mcp`'s getWorkspaceInfo both report)
  src/workspace/        discovery, config eval (+ config-cache.ts), config-schema.ts (what a config
                        may say), package graph, --filter/--affected, lockfile, migration.ts (the
                        plan → files seam `vx init` and @vzn/vx-migrate share)
  src/graph/            task graph + two-tier scheduler
  src/cache/            local SQLite+archive cache, layered/chained remote seam, inputs (glob
                        resolution, boundaries) + git-inputs (the git enumeration it trusts)
  src/exec/             runner (Bun.spawn), env isolation, sandbox, local-executor (the floor)
  src/util/             incl. timing.ts (`VX_TIMING=1` stage table)
  index.ts              root shim (Bun's compiled binary ignores the exports map)
packages/vx-reapi       Bazel REAPI plugin: remote cache + remote execution
packages/vx-otel        OpenTelemetry telemetry plugin (no SDK dep)
packages/vx-github      GitHub Actions job summary + Checks API plugin
packages/vx-mcp         `vx mcp` — MCP server for AI agents (commands seam, no SDK)
packages/vx-migrate     adoption, one package (2026-09-11): `turbo()` runs a Turbo repo unchanged (turbo.json +
                        scripts → tasks via the `project` stage; owns the mapper the CLI renders from),
                        `turboCache()` / `nxCache()` keep a Turbo (`/v8/artifacts`) or Nx (`/v1/cache`) remote
                        cache, and `bunx @vzn/vx-migrate` writes vx.config.ts from turbo.json or an Nx graph
                        (core keeps `vx init`). `src/turbo/`, `src/turbo-cache/`, `src/nx-cache/`
packages/vx-schedule-history  `schedule` plugin: order by the critical path learned from run history
packages/vx-lockfile    pnpm() bun() npm() yarn(): each claims its lockfile (`fingerprint` seam) and keys each
                        task on its project's own dependency closure; --affected follows. Parsers over core's
                        `lockfileClaim` (orchestrator/lockfile-claim.ts: memo, per-run gate, --affected diff).
                        This repo declares bun()
packages/vx-docs        Astro Starlight site; packages/vx/docs is imported by scripts/import-docs.ts
packages/vx-bench       synthetic workspace generator + runners (vx / turbo / nx)
packages/vx/docs        source of truth: STATUS.md, architecture, caching, cli, schema, modules/, design/;
                        history/ holds the shipped record STATUS moved out (read it only when an item's why matters)
```

Module boundaries: each `src/<module>/index.ts` is the contract; cross-module
imports go through it only (`tests/module-boundaries.test.ts`). Plugin
packages import core only via `@vzn/vx` (`tests/package-boundaries.unsafe.test.ts`).

## Workflow

- **Gate, push, open the PR, merge it yourself once CI is green** (owner,
  2026-09-10: "merge whenever you own the project"). Gate first, from the repo root:
  `bun packages/vx/src/bin.ts run ci --all` (lint → oxlint + oxfmt, test,
  docs build). Then push and confirm the real CI conclusion.
- `bun test` alone is NOT the gate: it is transpile-only and cannot see a
  type error. Never pipe a gate through `tail`/`grep` — it masks the exit.
- The core suite runs as `SHARD_COUNT` (12, `vx.config.ts`) parallel
  shard tasks, generated from one template; `scripts/test-shard.ts <i>
<n>` deals the files by recorded weight (`tests/shard-weights.json`,
  refreshed with `--weigh <junit-dir>`), so the wall time is the
  average shard, not the alphabet's heaviest. Many processes is not
  only speed: `bun test` pins ~2 descriptors per imported module and
  macOS caps a process at 10 240, so the whole suite in one process
  does not clear the cap.
- `tests/*.unsafe.test.ts` is the suite a sandbox cannot host — the
  sandbox's own tests (seatbelt cannot nest) and the cross-project law
  (a project may read only its own directory). The shards exclude them
  with `--path-ignore-patterns`; `test.bun.unsafe` runs them. It and
  `@vzn/vx-reapi#test` (which dials service containers on the host's
  loopback, unreachable from a Linux sandbox's network namespace) are
  the ONLY two tasks in the whole repo with no `exec.sandbox`.
- Every package's suite is its `test` task, so `vx run ci --all` gates
  them all; CI runs nothing but vx tasks (a workspace step is a design
  smell — declare the cross-project read on the task instead). The one
  suite that needs live services, `@vzn/vx-reapi#test`, runs skip-mode
  in the gate and live in CI's service job with `VX_REAPI_TEST_ENDPOINT`
  / `VX_REAPI_EXEC_ENDPOINT` set (the values are key inputs).
- Sandbox tests skip without `bwrap`/`socat`/`strace`; `VX_REQUIRE_SANDBOX=1`
  (CI) makes an unavailable sandbox a failure.
- Format: `bun packages/vx/src/bin.ts run lint.oxfmt.fix`.
- Commits: imperative present, first line < 72 chars, body says why. One
  coherent change per commit. Commit early; assume interruption.
- A feature is not done until its docs land in the same commit.

## Conventions

- No comments restating code; only "why" comments for non-obvious decisions.
- A plugin is `definePlugin(import.meta, hooks)` and its name is its
  package name — never a field, never overridden (owner, 2026-09-10).
- No half-finished implementations behind flags. Ship it or don't write it.
- Trust internal code; validate only at boundaries (user input, FS, network).
- Test fixtures use heredoc strings for `vx.config.mjs`.
- A probe that confirms a thesis becomes a test, not a note.

## Architecture principles

1. **Perf first.** Measure before and after; interleave A/B arms, min-of-N,
   "before" arm from an immutable `git worktree`, one workspace copy per
   arm pre-warmed by that arm (arms on different `SCHEMA_VERSION`s reset
   a shared copy, and the rep after a reset proves hits by the walk —
   min-of-N picks that rep). A change to the warm path without a number
   is not done.
2. **Explicit over magical.** Caching is opt-in; `cache.inputs.files` is
   required; no inferred inputs (the sandbox, `exec.sandbox`, is how a
   task proves what it touches; `--verify` was removed 2026-09-04).
3. **One command per task; shell is the API.** A plugin changes WHERE a
   command runs, never what it is.
4. **Resolved-config hashing.** The key sees the evaluated config object.
5. **Cascade through deps** by folding upstream INPUT keys, never outputs.
6. **Project boundaries are hard.** Globs never cross into another project.
7. **No defaults.** Core names no plugin; only the local floor is
   implicit. A capability a plugin must supply (a remote, a wire) is
   declared in `vx.workspace.ts` or it does not exist.
8. **Seam over special case.** When core grows a branch for one consumer,
   the seam is too narrow.

## Rules learned the hard way

- Repro before fix; record what a probe refutes too.
- Every fix must fail without itself (differential). Keep controls that
  pass both ways. A surviving mutation means the test is wrong at least as
  often as the claim — and suspect a second copy of the rule first.
- A skip is a silent pass. Gate on an env var CI sets.
- Assert the exact expected set, not the absence of one string.
- A comment claiming a guarantee the code lacks is a defect: de-claim or
  implement.
- When a fix covers a class, grep the class in the same commit.
- A red main is not always your diff: read the failing test name and the
  actual error. `git checkout <file>` never undoes a mutation — use the
  reverse edit.
- A timed wait in a test is a claim about time: prove it with the
  shortest window that still fails without the fix. A kill grace is
  `VX_KILL_GRACE_MS`; "the child is dead" is `tests/helpers/alive.ts`
  (a zombie counts); "the task has started" is a marker file, never a
  sleep.
- Use the session scratchpad, never bare `/tmp`.
- Format-check by directory scan (`cd packages/vx && bunx oxfmt --check .`,
  what CI runs), never by naming the file: `oxfmt --check <file>` passed a
  STATUS.md that the scan rejected (a code span wrapped across an indented
  line; proven both ways, 2026-09-10).
- Correct wrong entries in place; never write a plausible cause you have
  not proven.
- `pkill -f` / `pgrep -f` match the shell running them when the pattern
  appears in its own command line: the pkill killed its caller (exit
  144) and a `while pgrep` wait never ended (three times, 2026-09-12).
  Match on a marker the target alone carries, or hold the child's pid.
- A platform unit (bytes vs kilobytes, ms vs µs) is measured, never
  asserted: pin it by producing a known quantity and reading it back
  within a bounded factor. A pure-function test of the conversion only
  restates the assumption (Linux peak RSS ran 1024× too big under one,
  2026-09-12).

## Live invariants (verify in source before quoting)

- `CACHE_VERSION` `vx-cache-v27`, core `SCHEMA_VERSION` `v26`,
  `TELEMETRY_SCHEMA_VERSION` 2. Bump `CACHE_VERSION` when stored bytes are
  wrong under an unchanged key or the container changes; a key-derivation
  fix whose old key was already wrong is self-healing and does not bump.
- Key derivation: xxh3 seed-chained parts, `\0` delimiters, git blob OIDs
  for tracked-clean files, pure-input transitive hashing, the project's
  `package.json` bytes and the workspace fingerprint. `exec.resources` and
  `exec.remote` are stripped (placement only); `timeout`/`retries` and
  `description` are folded.
- Cache correctness is the worst failure class: a stale hit replays wrong
  bytes under a green run. Treat `execute-task.ts` changes as stale-hit-critical.
- Observability never breaks a run: sinks are crash-isolated and
  deadline-bounded; a remote cache error degrades to a miss; a never-fail
  plugin still warns.
- Zero-cost gates: no telemetry plugin ⇒ no bus subscriber, no summary, no
  git spawn. A declined plugin costs nothing.

## Rejected — do not re-propose

Named inputs / `globalInputs` / `globalEnv` (TS configs compose); auto-input
inference via tracing; folding `NODE_OPTIONS` into the key; lookahead /
idle-insertion scheduling (measured: `remCP` already ties or wins); a
first-party platform, dashboard, agents, cloud, or CI-provider features;
Turbo remote-cache wire in core; HTTP/3.

## Operating directive

You own this project. Each turn: pick the next valuable thing from
`packages/vx/docs/STATUS.md`, do it, gate, push, update STATUS in the same
commit, and
say what you are doing next. Never end with "what next?".
