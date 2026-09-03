# `@vzn/vx` — project memory for Claude

**Start every session by reading `docs/STATUS.md`.** It is the living
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
CLI verbs exist. Core applies NO plugin by default; even the local executor
and cache are declared in `vx.workspace.ts`.

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
packages/vx/            @vzn/vx core (src/ + tests/); paths below relative to it
  src/bin.ts            shebang → cli
  src/index.ts          public façade (snapshot-pinned by tests/package-boundaries.test.ts)
  src/config.ts         user schema: defineProject / defineWorkspace
  src/cli/              verbs: run watch cache lock init migrate show info why last prune upgrade;
                        plugin-commands.ts resolves plugin verbs (`commands` seam)
  src/orchestrator/     run() pipeline, execute-task, task-hash, plugin stages + seams, events, logger
  src/workspace/        discovery, config eval (+ config-cache.ts), package graph, --filter/--affected, lockfile
  src/graph/            task graph + two-tier scheduler
  src/cache/            local SQLite+archive cache, layered/chained remote seam, inputs (git enumeration)
  src/exec/             runner (Bun.spawn), env isolation, sandbox
  src/plugins/          core's own plugins: local-executor, local-cache, schedule-history
  src/util/             incl. timing.ts (`VX_TIMING=1` stage table)
  index.ts, plugins/*/index.ts  root shims (Bun's compiled binary ignores the exports map)
packages/vx-reapi       Bazel REAPI plugin: remote cache + remote execution
packages/vx-otel        OpenTelemetry telemetry plugin (no SDK dep)
packages/vx-github      GitHub Actions job summary + Checks API plugin
packages/vx-mcp         `vx mcp` — MCP server for AI agents (commands seam, no SDK)
apps/docs               Astro Starlight site; docs/ is imported by scripts/import-docs.ts
bench/                  synthetic workspace generator + runners (vx / turbo / nx)
docs/                   source of truth: STATUS.md, architecture, caching, cli, schema, modules/, design/
```

Module boundaries: each `src/<module>/index.ts` is the contract; cross-module
imports go through it only (`tests/module-boundaries.test.ts`). Plugin
packages import core only via `@vzn/vx` (`tests/package-boundaries.test.ts`).

## Workflow

- **Push directly to `main`. No PRs.** Gate first, from the repo root:
  `bun packages/vx/src/bin.ts run ci --all` (lint → oxlint + oxfmt, test,
  docs build). Then push and confirm the real CI conclusion.
- `bun test` alone is NOT the gate: it is transpile-only and cannot see a
  type error. Never pipe a gate through `tail`/`grep` — it masks the exit.
- The core suite runs as four parallel shard tasks (`test.0`–`test.3`,
  dealt longest-first by `tests/helpers/shard.ts run 4 <i>`; a file that
  costs far more than its size says carries a `// @vx-shard-cost <s>`
  hint, and one that imports thousands of modules carries
  `// @vx-shard-isolate` for a process of its own — `bun test` pins
  descriptors per import, see the helper's header). A plain
  `cd packages/vx && bun test --preload ./tests/setup.ts ./tests/` still
  runs everything in one process, which is what the darwin CI job does.
- `packages/*` suites are gated by CI's separate job; after touching a
  plugin package run its suite yourself (`vx-reapi` one process per file
  with `VX_REAPI_TEST_ENDPOINT` / `VX_REAPI_EXEC_ENDPOINT` set, or it
  proves nothing).
- Sandbox tests skip without `bwrap`/`socat`/`strace`; `VX_REQUIRE_SANDBOX=1`
  (CI) makes an unavailable sandbox a failure.
- Format: `bun packages/vx/src/bin.ts run lint.oxfmt.fix`.
- Commits: imperative present, first line < 72 chars, body says why. One
  coherent change per commit. Commit early; assume interruption.
- A feature is not done until its docs land in the same commit.

## Conventions

- No comments restating code; only "why" comments for non-obvious decisions.
- No half-finished implementations behind flags. Ship it or don't write it.
- Trust internal code; validate only at boundaries (user input, FS, network).
- Test fixtures use heredoc strings for `vx.config.mjs`.
- A probe that confirms a thesis becomes a test, not a note.

## Architecture principles

1. **Perf first.** Measure before and after; interleave A/B arms, min-of-N,
   "before" arm from an immutable `git worktree`. A change to the warm path
   without a number is not done.
2. **Explicit over magical.** Caching is opt-in; `cache.inputs.files` is
   required; no inferred inputs (`--verify=inputs` proves the declared set).
3. **One command per task; shell is the API.** A plugin changes WHERE a
   command runs, never what it is.
4. **Resolved-config hashing.** The key sees the evaluated config object.
5. **Cascade through deps** by folding upstream INPUT keys, never outputs.
6. **Project boundaries are hard.** Globs never cross into another project.
7. **No defaults.** Core names no plugin. A workspace with no executor or
   cache fails before any task runs, naming the fix.
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
- Use the session scratchpad, never bare `/tmp`.
- Correct wrong entries in place; never write a plausible cause you have
  not proven.

## Live invariants (verify in source before quoting)

- `CACHE_VERSION` `vx-cache-v27`, core `SCHEMA_VERSION` `v24`,
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
`docs/STATUS.md`, do it, gate, push, update STATUS in the same commit, and
say what you are doing next. Never end with "what next?".
