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
`graph` → `key` → `fingerprint` → `schedule` → `admit` → `executor` /
`cache` → `telemetry`, with `setup` / `teardown` around the run, plus
`commands` (CLI verbs). Design: `docs/design/pipeline-2026-09.md`.

Decision drivers, in order: **performance, modularity, extensibility.**
Nothing distributed ships in this repo (no agents, cloud, dashboards); the
seams exist so someone can build those on top. `@vzn/vx-reapi` is the proof
the seams are wide enough. Pre-alpha, owner-delegated: you own it, ship it.

## Stack

Bun ≥ 1.4 only (`bun:sqlite`, `Bun.spawn`, `Bun.Glob`, `Bun.zstd*` are
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
                        `nx()` runs an Nx repo unchanged (2026-09-22: the resolved graph → tasks; executor
                        targets are `nx-exec` lines — `src/nx-exec.cjs`, a Node bin over Nx's public
                        `runExecutor`, design docs/design/nx-unchanged-2026-09.md),
                        `turboCache()` / `nxCache()` keep a Turbo (`/v8/artifacts`) or Nx (`/v1/cache`) remote
                        cache, and `bunx @vzn/vx-migrate` writes vx.config.ts from turbo.json or an Nx graph
                        (core keeps `vx init`). `src/turbo/`, `src/nx/`, `src/turbo-cache/`, `src/nx-cache/`
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
  docs build). Then push and confirm the real CI conclusion. The gate
  refuses a Bun below `engines.bun` first (`check.bun`, item 575): a
  verdict from 1.3.11 was the runtime's, not the diff's.
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
  sandbox's own tests (seatbelt cannot nest), the cross-project law
  (a project may read only its own directory), the disk-full suite
  (a sandboxed task sees a mount it did not make as read-only), the
  repo-wide laws that read other packages and `.github/`, and the
  liveness helper (the runtime's PID namespace hides a zombie). The
  shards exclude them in the dealer itself — `testFiles()` in
  `scripts/test-shard.ts` drops the name, so the shard command never
  sees the file; `test.bun.unsafe` runs them. It and
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
- A test that reads the constant it guards is a tautology, and a
  GENERATED table makes it a silent one. The cache-layer gate's
  fixture built its expected message by mapping over
  `CACHE_LAYER_METHODS`, so it agreed with any list; my replacement
  generated one row per member FROM the same constant and shrank with
  it — caught only because the differential run scored 44 pass and no
  failure (item 536). Generate from the SOURCE OF TRUTH instead (the
  `CacheLayer` interface, `config-schema.ts`'s own call sites in 533)
  and assert the constant against it in both directions, duplicates
  included. And remember `toThrow(string)` matches a SUBSTRING:
  `missing key(), key()` satisfies a probe for `missing key()`, so a
  message a row is pinning is compared with `toBe` (2026-09-21).
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
- The gate here runs LINUX ONLY; macOS is a CI job you cannot run. So a
  row that compares PATHS is a platform claim, and the platform that
  breaks it is the one you never see: macOS's `/var/folders` temp dir is
  a symlink to `/private/var`, so a fixture root from `mkdtemp` is
  NON-CANONICAL there and any code that realpaths one side of a
  comparison and not the other behaves differently (item 537's
  link-dedup control, green on both Linux jobs, red on darwin). Simulate
  the shape rather than guessing at it — a root reached through a
  symlink (`/tmp/link -> /tmp/real`) reproduces it on Linux in three
  lines — and give a path fixture a canonical root unless the
  non-canonical one IS the subject (2026-09-21).
- Format-check by directory scan (`cd packages/vx && bunx oxfmt --check .`,
  what CI runs), never by naming the file: `oxfmt --check <file>` passed a
  STATUS.md that the scan rejected (a code span wrapped across an indented
  line; proven both ways, 2026-09-10). And read the scan's exit or its
  `Format issues found` line, never its last line: the verdict prints
  BEFORE `Finished in …`, so `| tail -1` reads clean on a failure (the
  gate caught what that tail passed, 2026-09-15). And a chain that
  greps the verdict swallows the exit — piping the scan into a grep of
  its verdict line exits 0 either way, so `&& commit` went through on
  a failure twice in one day (2026-09-16). Capture the exit (`rc=$?`
  before the grep) and gate the chain on it.
- A numbered entry in STATUS's Next list goes at the END of the list:
  the formatter renumbers the list sequentially, so one inserted above
  its neighbours moved every number below it (three times by
  2026-09-16). Same for a code span: never let one wrap across an
  indented continuation line — the formatter un-indents the line and
  the list item breaks.
- Correct wrong entries in place; never write a plausible cause you have
  not proven.
- `pkill -f` / `pgrep -f` match the shell running them when the pattern
  appears in its own command line: the pkill killed its caller (exit 144) and a `while pgrep` wait never ended (three times, 2026-09-12).
  Match on a marker the target alone carries, or hold the child's pid.
- Bun drops what a pipe has not yet taken when `process.exit` follows a
  large stdout write (2 MiB written, 1.1 MiB read, 2026-09-15). `bin.ts`
  ends stdout and exits in its callback; a verb never calls
  `process.exit` itself, and a pin's reader starts late on purpose.
  And `bin.ts` alone listens for `error` on stdout and stderr: a reader
  that leaves (`| head -1`, EPIPE) is an `error` event, and an unheard
  one killed a green run with a stack and exit 1 (2026-09-16).
- A platform unit (bytes vs kilobytes, ms vs µs) is measured, never
  asserted: pin it by producing a known quantity and reading it back
  within a bounded factor. A pure-function test of the conversion only
  restates the assumption (Linux peak RSS ran 1024× too big under one,
  2026-09-12).
- `bun --bun` links `node` to itself under `/tmp/bun-node-<build>/`,
  mode 0700, owned by whoever ran it first; a second user gets no shim
  and no word of it, and `bun --bun astro build` ran the PATH's Node 20
  (2026-09-16). On a shared box remove that directory before a run as
  another user. A file-system refusal (`EACCES`, `ENOSPC`) reaching the
  user as an "internal error" or a stack is a defect: `isFsRefusal`.
- Two measured quantities that are equal by construction sit on jitter:
  a light child's `ru_maxrss` IS the parent's mark, and the kernel's RSS
  counters lag by pages, so an exact `>` between them flipped on one CI
  run in twelve (2026-09-16). Compare with a slack above any accounting
  jitter and below what the number decides (4 MiB against 64 MB steps),
  or measure a difference that exists.

- A manual `su probe -c 'bun test …'` needs `PATH=/opt/probe-bin:$PATH`
  or a sandboxed task that runs `bun` fails with "command not found"
  and the port-bridge tests go red for the invocation, not the code
  (the gate's step sets it; 2026-09-16, item 250).
- `Bun.Glob` does not expand a brace whose alternatives hold a slash:
  `{*,*/*}/package.json` matches nothing; two scans (2026-09-16).
- A dead `HTTPS_PROXY` does not stand in for "no network" — Bun's
  fetch reached the release regardless. Use `unshare -n` or
  `bwrap --unshare-net` (2026-09-16, item 247).
- The `VX_TIMING` accumulated span table sums WALL per call across
  concurrent workers: 2 ms per `save: pack` under four workers is
  overlap, not cost (an isolated one-file save is 0.82 ms). Measure a
  suspected per-call cost in isolation before chasing it (item 254).
- A `TMPDIR` under a workspace under the runner's temp directory puts
  the sandbox runtime's socket past `sun_path` on macOS (104 bytes):
  a temp-directory pin uses a short path directly under `os.tmpdir()`.
- An edit script that writes files before its last assertion leaves a
  half-done tree when that assertion fails, and a chain gated on the
  scan and the tests committed it (the STATUS trim, 2026-09-16). Gate
  the chain on the script's own exit; make every write idempotent.
- A list item inserted at the blank line after item N lands BEFORE
  any item that follows N, so a cut "from N to the next item" misses
  the one just written. Count what a cut holds before writing it out.
- A type-checker pointed at a directory that holds a symlinked
  `node_modules` walks it until the kernel kills it
  (`oxlint --type-check .`, 2026-09-16). Name the files.
- A probe's negative case is checked before its result is read: a
  flag set to "broken" still matched a `grep -q ok` ("broken" holds
  "ok"), and the cycle that was to fail passed (2026-09-16).
- The mutation-sweep method — worktree, pinned Bun, per-file summary,
  CAUGHT / SURVIVED / INCONCLUSIVE, and the twenty-six rules it taught
  (a crash, a skip, a non-compiling or no-op mutation is a silent
  pass; the file list is the fixture; type-check per mutation for a
  declaration-heavy file) — is `docs/design/mutation-sweeps-2026-09.md`.
  Read it before sweeping; nothing below repeats it.
- Two guards can mask each other: each alone survives and only the
  pair is held. When a guard survives, ask what ELSE would have to
  fail for the observable to change, and mutate that too (item 563).
- A negative `existsSync` proves nothing without the positive first,
  in the same row; and a control held by a coarse gate holds nothing
  about the fine ones — put each control PAST the coarse gate (564).
- When several oddities share a container, suspect the container:
  three "flappers", a 1-in-8 SIGILL and three inert tripwires were
  one fact, Bun 1.3.11 below `engines.bun` (566, 572). `bun --version`
  against the floor and CI's pin comes before any story about load;
  the gate refuses below it since item 575.
- `Bun.file(<dir>).exists()` is false. Stat when the question is "is
  there something here" (565 → 576; `tests/bun-file-exists-sites.test.ts`
  holds the file-path sites).
- The platform answer may already be in the file you are testing:
  grep the module for the symptom before writing a row that leans on
  an FS or syscall behaviour, and prefer the claim that holds
  everywhere (564).
- A new timing `mark('x')` is pinned in SOURCE order (prepare.ts, then
  run.ts, first occurrence) by `module-shape-drift.test.ts`, in
  `timing.md`'s mark list AND `benchmarks.md`'s sentence, and the list
  item must be a bare `` - `x` `` line — a note after the name hides
  it from the pin (item 601: `planRun` follows `run`, so `plan` sits
  after `close`).
- An `nx:run-commands` target runs from the WORKSPACE ROOT, and the
  mapper's `cd` preserves that: a probe that looks for the command's
  relative output under the package dir finds nothing (item 599).
- A bin a package.json declares must be 100755 in the INDEX, not only
  on disk (`git update-index --chmod=+x`); `tests/bins-executable.unsafe.test.ts`
  holds the law (item 604).
- A negative grep is a claim about every spelling: `retry` missed
  `retries`, and a documented upload retry that exists was struck
  from a guide as gone (item 304, corrected in 311). Before calling a
  behaviour absent, grep the word's forms and the constant's name.

## Live invariants (verify in source before quoting)

- `CACHE_VERSION` `vx-cache-v27`, core `SCHEMA_VERSION` `v27`,
  `TELEMETRY_SCHEMA_VERSION` 2. Bump `CACHE_VERSION` when stored bytes are
  wrong under an unchanged key or the container changes; a key-derivation
  fix whose old key was already wrong is self-healing and does not bump.
- Key derivation: xxh3 seed-chained parts, `\0` delimiters, git blob OIDs
  for tracked-clean files, pure-input transitive hashing, the project's
  `package.json` bytes and the workspace fingerprint. `exec.remote` is
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
first-party platform, dashboard, agents, cloud, or CI-provider features;
Turbo remote-cache wire in core; HTTP/3.

## Operating directive

You own this project. Each turn: pick the next valuable thing from
`packages/vx/docs/STATUS.md`, do it, gate, push, update STATUS in the same
commit, and
say what you are doing next. Never end with "what next?".
