# `@vzn/vx` — project memory for Claude

A monorepo task runner for pnpm workspaces. Bun-only (≥ 1.3). Pre-alpha.
**You are the project owner.** Maintain it, push it forward, ship.

## Project identity in one paragraph

`@vzn/vx` is a content-addressed cache + task scheduler for pnpm
workspaces. Authors write per-package `vx.config.ts` files; the CLI
discovers projects, builds a task graph from declared `dependsOn`,
hashes inputs deterministically, and executes tasks in topological
order with parallelism. Cache hits replay stored outputs. Pre-alpha.

## Stack

| Concern         | Tool                                                                       |
| --------------- | -------------------------------------------------------------------------- |
| Runtime         | Bun ≥ 1.3 (no Node fallback)                                               |
| Package manager | Bun (`bun install`, `bun.lock`)                                            |
| Test runner     | `bun test` (tests import `describe`, `it`, `expect`, `vi` from `bun:test`) |
| Linter          | `oxlint --type-aware --type-check` (real TS diagnostics via `tsgolint`)    |
| Formatter       | `oxfmt` (configured via `.oxfmtrc.json`, migrated from prettier)           |
| Build           | None. TS source ships as the entry; `bin: src/bin.ts` runs via shebang.    |

Configs:

- `tsconfig.json` — for editor LSP + tsgolint type info. Not invoked by scripts.
- `.oxlintrc.json` — disables `unicorn/no-useless-spread` (we use spread for deliberate snapshots), `typescript/unbound-method` (test code patterns), and `typescript/await-thenable` (bun:test's `expect(...).rejects.toThrow()` is awaitable at runtime but typed as `void`).
- `.oxfmtrc.json` — prettier-equivalent style (no semi, single quotes, trailing all, 100-col).

## Repository layout

Bun workspaces monorepo: the root `"."` member is core `@vzn/vx`
(load-bearing — without it the root vx.config.ts stops being a
project); `packages/*` are the integration packages; `apps/docs` is
the docs site; `packages/cloud/ui` is a nested member (explicit root
`workspaces` entry). Core `src/` is eight modules — each directory's
`index.ts` is its contract; cross-module imports go through it only
(enforced by `tests/module-boundaries.test.ts`) — plus four root
files. Core never imports a sibling `@vzn/vx-*`; packages import core
only via the bare `@vzn/vx` specifier (`tests/package-boundaries.test.ts`,
symlinked by `scripts/link-self.ts` postinstall). Full dependency
matrix in `docs/architecture.md`.

```
src/
  bin.ts                # shebang; wires process.argv -> cli run
  index.ts              # public package façade (~80 exports, snapshot-pinned)
  version.ts            # VERSION constant (cycle-free leaf)
  config.ts             # public schema (ProjectConfig, TaskConfig, WorkspaceConfig, Plugin)
  cli/                  # subcommand parsers + presentation
    index.ts            # contract: dispatcher + test-facing re-exports
    run.ts              # `vx run` parser, scope resolver, picker
    watch.ts            # `vx watch` re-run loop
    cache.ts            # `vx cache prune` + duration/size parsers
    lock.ts             # `vx lock` / `--check` (freeze + audit vx-lock.json)
    migrate.ts          # `vx migrate` — detection, TS emission, overwrite guard
    migrate-turbo.ts    # turbo.json → vx.config.ts mapping (+ vx-preset.ts globals)
    migrate-nx.ts       # nx project-graph.json → vx.config.ts mapping
    show.ts             # `vx show` — live resolved-config introspection
    info.ts             # `vx info` doctor printout (`vx stats` = alias)
    upgrade.ts          # `vx upgrade` — binary self-update (bunfs detection)
    mcp.ts              # `vx mcp` — MCP server for AI agents (stdio)
    mcp-rpc.ts          # internal JSON-RPC methods behind the MCP tools
    backend.ts          # RunBackend resolution (core = localBackend only)
    help.ts             # help text
    format.ts           # shared formatters (formatBytes, …)
    plan-format.ts      # --dry / --graph plan → text / JSON / DOT
  orchestrator/         # run composition
    index.ts            # contract: run, planRun, options/plan types, Logger
    run.ts              # run() + planRun(): discover → load → graph → schedule
    options.ts          # RunOptions / RunSummary declarations
    prepare.ts          # shared run/planRun setup (+ scoped config loading)
    plan.ts             # --dry / --graph prediction (existence probe, no exec)
    execute-task.ts     # per-task execution (probe/preProbed → spawn → save)
    task-hash.ts        # cache-key derivation (computeTaskHash & co.)
    upstream.ts         # filter upstream hashes for cache key
    resources.ts        # exec.resources → absolute per-task admission costs
    stable-keys.ts      # shared stable-key derivation (prefetch + shortcircuit)
    local-shortcircuit.ts # restore-ahead classify (two-tier scheduler feed)
    remote-prefetch.ts  # background remote GETs (LayeredCache runs only)
    events.ts           # run event bus + serializable WireEvent contract
    plugin.ts           # VxPlugin interface + installPlugins
    plugin-host.ts      # eventSink wiring + end-of-run teardown/flush
    telemetry.ts        # canonical telemetry contract (SCHEMA_VERSION, records)
    telemetry-host.ts   # sink consultation (zero sinks = zero cost)
    protocol.ts / wire.ts # delegation wire contract + JSON-RPC envelope
    wire-render.ts      # WireEvent → Logger (delegated-run rendering)
    worker-exec.ts      # agent-side execution primitive
    metrics.ts          # analytics SQL layer (/v1/* + vx mcp read through it)
    history.ts / predict.ts # opt-in predictive scheduling (experimental)
    run-context.ts      # git/CI/host capture (≤1 spawn per run)
    run-state.ts        # reduced run aggregate for live surfaces
    run-report.ts       # --report=markdown table
    run-artifacts.ts    # --summarize JSON + --profile trace writers
    devframe-surface.ts # devframe channel/state definition (type-only dep)
    logger.ts           # default logger + framed-output/colors/summary/tally
    status-line.ts / framed-output.ts / summary.ts / tally.ts / colors.ts
  workspace/            # discovery + selection
    index.ts workspace.ts project-loader.ts package-graph.ts
    filter.ts affected.ts nested-dirs.ts fingerprint.ts
    lockfile.ts         # vx-lock.json freeze/trust/audit
  graph/                # task graph + scheduling
    index.ts task-graph.ts dependency-spec.ts
    scheduler.ts        # two-tier parallel topo executor (exec + restore queues,
                        # 2-D resource admission over exec.resources)
  cache/                # local cache + the RemoteCacheLayer seam
    index.ts cache.ts layered-cache.ts inputs.ts tar.ts
    cas-backend.ts / digest.ts # pluggable CAS seam (internal, artifact-store roadmap)
  exec/                 # per-task execution primitives
    index.ts runner.ts env.ts sandbox-runtime.ts
  util/                 # tiny shared helpers
    index.ts paths.ts hash.ts ulid.ts errors.ts
packages/
  cloud/                # @vzn/vx-cloud — the client/server service (self-contained)
    src/
      plugin.ts         # cloud() plugin: telemetry/backend/cache capabilities
      environments.ts   # per-user environments.json (connect targets)
      serve-info.ts     # per-user local serve advertisement
      ingest-store.ts   # server-side run history (pushed summaries)
      protocol-dist.ts  # worker:*/coord:* distribution messages
      coordinator-prepare.ts
      cli/              # vx-cloud dispatcher: serve, connect/env/disconnect,
                        # coordinator, worker, dev, backend, ui-asset/server
    ui/                 # the dashboard SPA (Solid + UnoCSS + json-render views)
    deploy/             # Dockerfile context + Helm chart skeleton
  vx-otel/              # @vzn/vx-otel — otel() telemetry plugin (OTLP JSON, no SDK)
apps/docs/              # Astro Starlight docs site (imports docs/)
bench/                  # synthetic-workspace generator + benchmark runner
docs/                   # source of truth: architecture, caching, cli, execution,
                        # schema, flows, optimizations, comparison, modules/<name>.md,
                        # design/ (proposals + the 2026-07 consulting review)
.claude/agents/         # subagent definitions
vx.workspace.ts         # declares otel() + cloud() plugins (both decline unconfigured)
tsconfig.json / package.json / bun.lock / .oxlintrc.json / .oxfmtrc.json
```

## Workflow

- **Push directly to `main`.** Owner instruction (2026-06-10): no PRs.
  Branch protection is off. Run the full local gate first
  (`bun src/bin.ts run ci`), then push. Keep commits as small and
  focused as the PRs used to be — one coherent change per commit.
- **Commit messages:** imperative present; first line < 72 chars; body
  explains _why_. No co-author lines.
- **Tests must pass.** 250+ tests today. Use `bun test` locally, or
  `bun src/bin.ts run test` to drive it through vx itself.
- **Format must be clean.** Rewrite via vx: `bun src/bin.ts run
lint.oxfmt.fix`; the check-only gate is `lint.oxfmt` (part of `lint`).
- **Lint+typecheck must be clean.** Run via vx: `bun src/bin.ts run lint`
  — a group fanning out to `lint.oxlint` (oxlint + tsgolint) and
  `lint.oxfmt` (oxfmt --check). No `package.json` scripts — dogfooded
  through vx's own task graph.
- **CI gate:** `bun src/bin.ts run ci` — a group fanning out to `lint`
  (→ `lint.oxlint` + `lint.oxfmt`) and `test`. The four `build.bun.*`
  cross-compiled binaries are built only in `release.yml` (`vx run
build`), not in the CI gate. CI workflow is `.github/workflows/ci.yml`.

## Conventions

- **No comments restating the code.** Only "why" comments for
  non-obvious decisions, hidden invariants, workarounds for specific
  bugs. Remove a comment if removing it wouldn't confuse a future
  reader.
- **No half-finished implementations** behind feature flags. Either
  ship it or don't write it.
- **Trust internal code.** Validate only at system boundaries (user
  input, external APIs, FS). No defensive error handling for
  impossible cases.
- **Test fixtures use heredoc strings** for `vx.config.mjs`. The
  indentation inside the heredoc matters for readability but doesn't
  affect parsing.

## Architecture principles

1. **Explicit over magical.** Caching is opt-in. `cache.inputs.files`
   is required when caching is enabled. No hidden globs.
2. **One command per task.** `exec: ExecConfig` is a single command;
   chain in shell (`&&`) or split into tasks via `dependsOn.self`.
3. **Shell is the API.** Commands are strings. No JS-function tasks,
   no executor plugin protocol.
4. **Resolved-config hashing.** The cache key sees the post-evaluation
   config object, so imports and computed values participate.
5. **Cascade through deps.** Upstream cache changes invalidate
   dependents via folded-in upstream hashes.
6. **Project boundaries are hard.** A project's globs never reach into
   another project's dir.

## Dashboard product lens (owner directive, 2026-07-10)

**The UI is built from a SINGLE DEV's perspective** — not an
org/manager analytics console. Every surface answers one of the dev's
own questions, in their flow order:

1. **See it run** — spawn/watch live runs (the Runs landing).
2. **Dig into the projects they own** — project drill-ins with their
   tasks and history.
3. **Task analysis: did MY performance improve or decrease?** — per
   task/project over-time trend, not just workspace-wide aggregates.
4. **Identify flaky tests** — confirmed/inferred flakiness with the
   concrete fix.
5. **Easy debug access** — from any failure, ONE click to the run's
   logs and the task's artifacts.

When adding a dashboard feature, ask "which of these five does it
serve, and how many clicks from the dev's entry point?" — a feature
serving none of them is probably org-analytics scope creep.

## Decision log

- **2026-07-27**: **A skipped or persistent task is now RECORDED — and the real
  work was stopping those rows from corrupting every rate and mean.** Closing
  the residual the telemetry wave deferred: `toRecord` skipped `if (!o.hash)`,
  which selects exactly `{skipped, persistent}`, so the `invocations` header and
  the `runs` rows under-reported. Reproduced through the real CLI: a persistent
  task that never becomes ready printed `1 failed · 1 total` and exit 1 while
  recording `taskCount: 0, failedCount: 0, exitOk: false` and **0 runs rows**;
  a failed task with a skipped dependent recorded 1 of 2. **A third case the
  brief missed:** a persistent task that SUCCEEDS (`vx run dev` — the common
  use) also recorded `taskCount: 0`. **I briefed the wrong fix and the developer
  refused it, correctly.** I argued `runs.hash TEXT NOT NULL` was itself the
  defect (a skipped task has no key, so the column asserted something untrue)
  and that pre-alpha makes a SCHEMA bump cheap. Three findings killed that:
  (a) NULL and `''` are behaviourally INDISTINGUISHABLE here — no query does
  `WHERE runs.hash = ?`, there is no `COUNT(hash)`, and the one `GROUP BY hash`
  (`mixedOutcomeKeyCount`) already guarded `IS NOT NULL AND != ''`, so the NULL
  analogue I asked them to add was already present; (b) `''` is ALREADY the
  convention for this exact concept — cloud's `task_runs.hash` is `NOT NULL`
  written as `t.hash ?? ''` with `hash <> ''` guards, and since #192 widened
  telemetry cloud is already receiving these rows that way, so NULL in core
  would give one concept two sentinels across two copies of `whyDidThisRerun` /
  `cacheKeyDiff` — the drift class `failure-mode.ts` exists to kill; (c) NULL
  makes the TS types LIE (`RunSummaryRow.hash` is `string` behind an `as` cast,
  so tsgolint cannot catch it) — the class that already shipped the `shorthash`
  cell rendering `null…`. So: column unchanged, `''` sentinel, `RunRecord.hash`
  optional with `bindRun` normalising in ONE place. **NO SCHEMA bump** (no DDL,
  no column, no index changed; existing rows stay valid) and **NO CACHE_VERSION
  bump** (`Cache.key()` never reads the `runs` table; `history.ts` feeds
  scheduling PRIORITY, which is in no key). Also: `docs/caching.md` already
  documented `task_count` as "non-group, non-aborted tasks recorded" and
  `RunRecord.status` always included `'skipped'` — **the code was the outlier,
  not the doc.** **THE ACTUAL WORK — writing the rows would have silently
  corrupted every aggregate.** Measured on 2×100 ms successes + 3 skips:
  `getHistory` 5 runs / successRate **0.4** (truth 2 / 1.0), `listProjects`
  avgMs **40** (truth 100), `getCacheStats` runs24h **5** (truth 2), and worst
  the predictive window reporting successRate **0** for a task that has NEVER
  failed — skips are the NEWEST rows, so they evict real history from the
  window. Rule adopted, and it was already encoded in `getRegressions`' own
  latest-state CTE rather than invented: **a skip is a task of the run but not
  an execution.** Guarded: getHistory, listProjects, getCacheStatsSql,
  getHitRateSplit, getRunTrends, getRunHeatmap, getFlakiestTasks, getRegressions'
  window, periodStats, getParallelismHistory, LocalHistoryProvider. Deliberately
  NOT guarded: `listRuns`/`getRun`/`compareRuns` (the completeness surfaces —
  the whole point) and `getRecentFailures` (a failed persistent task surfacing
  there IS the win). Net effect on existing data: byte-identical, since these
  rows did not exist before. **Two duplicates found while checking, both
  deduped:** `Cache.stats()` is a SECOND implementation of the 24h run count +
  hit rate — what `vx info` and `vx mcp` read, while the dashboard reads
  `getCacheStatsSql` — so one was guarded and the other was not; both predicates
  now live beside the schema (`EXECUTED_RUNS_SQL`, `KEYED_RUNS_SQL`) with a test
  pinning the two copies EQUAL. And `mcp-rpc.ts` carried a hand-rolled duplicate
  of `whyDidThisRerun`, now delegating to the canonical query. Both got the
  no-key guard plus "pick the previous KEYED run" — otherwise a task whose
  previous run was skipped is told "cache key unchanged", a claim about inputs
  made from two rows that never had a key. Differential, and the third row is
  the sharp one: src at HEAD **0 pass / 14 fail**; fixed **14/0**; cache+run
  fixed but **metrics/history at HEAD 4 pass / 10 fail** — proving the aggregate
  guards are independently load-bearing, not incidental to writing the rows (I
  re-ran that third case myself). Gates: fmt/lint 0, core **1506/0** (21 skip =
  sandbox). **Process note worth keeping:** a full-suite run flagged
  `scale-graph`'s perf guard at **27.1 s against a 6000 ms bound**, twice at
  near-identical durations, and it was NOT written off — splitting it showed
  fixed-src-without-the-new-file passed 2/2, with-the-file failed 2/3, and
  RENAMING the file to sort after `scale-graph` passed 2/2. `ps` gave the
  mechanism: the new persistent fixtures used `sh -c 'echo … && sleep 30'`, a
  compound command, so SIGTERM kills the shell and ORPHANS the sleeper (the
  documented grandchild limit) — three 30-second processes plus a zombie
  outliving the test and stealing CPU from the next suite. Cut to `sleep 2`;
  3/3 green. A test fixture that orphans a grandchild is a cross-suite perf
  hazard, not just its own problem. **Recorded, not fixed:** a skipped row has
  no wallclock offset so it draws as a zero-width mark at the run's right edge
  in the flamegraph (honest — a skip has no span — but odd; giving skips a real
  timestamp needs the scheduler to stamp them); and cloud's `whyRunReran`
  prev-run LATERAL has no status filter, so it can pair against a `hash=''` row
  — it degrades correctly via its `noKey` guard but does not skip past to the
  previous keyed run the way core now does.

- **2026-07-27**: **A hung telemetry `flush()` no longer turns a RED run GREEN —
  and a failing run stops ingesting as `0 tasks, 0 failures`** (a repro-mandated
  hostile audit of the telemetry / plugin-host / wire surface, the last major
  core seam never adversarially reviewed; its cardinal rule is "observability
  must never break a run", so every finding is that rule being broken by the
  subsystem that states it). **HIGH: `TelemetrySource.flush` had NO deadline**
  and `run.ts` awaits it before `closeCache()`, before `teardownPlugins`, and
  before `return` — and `bin.ts` is `process.exit(await run(...))`, so a
  never-returning `run()` lets Bun drain an empty event loop and **exit 0**.
  Reproduced through the real CLI: the run printed `failed (exit 3)` and
  `1 failed · 1 total`, then exited **0**; control exited 1. CI calls that build
  green. Collateral, all measured: `Cache.close()` never runs, so
  `flushAccessed()` is skipped and the run's `accessed_at` bumps are LOST
  (differential: `…706360` unchanged across the hung run, `…709165` on the
  control) — after which `vx cache prune --max-size` can evict entries the run
  just hit; retention prune skipped, SQLite handle leaked, every other plugin's
  flush/teardown skipped, and `--report=markdown` emitted **0** rows instead of 3. **The sharp part: the DEPRECATED `eventSink` path was already bounded**
  (`settleWithin`, 3 s) while the CANONICAL path was not — so the fix moved
  `settleWithin` into `src/util/settle.ts` and made `plugin-host.ts` import it,
  so the divergence that caused this cannot reappear. The bound sits in
  `createTelemetrySource.flush()` (contract level, so embedders inherit it),
  sinks race concurrently so each keeps the full budget, and it WARNS rather
  than dropping silently; `VX_TEARDOWN_TIMEOUT_MS` drives it per call — the
  `VX_CONFIG_WORKER_TIMEOUT_MS` precedent, without which the pin would wait out
  3 s and the no-deadline case would hang to its guard. **MED-HIGH: a failing
  run could ingest as ZERO tasks.** `assembleRunSummary` is documented as the
  single source shared by the local and dist paths, but its callers filtered
  differently — local added `!o.hash`, which selects exactly `{skipped,
persistent}` (the scheduler finishes a skip with no hash; `executePersistentTask`
  returns none on either branch). A persistent task that fails to become ready
  printed `1 failed · 1 total` while telemetry reported `taskCount: 0,
failedCount: 0, exitOk: false` — a red run invisible to the dashboard and to
  every cloud failure/regression surface; a failed task with a skipped dependent
  reported 1 of 2. `run-state.ts` DOES count skipped, which is what proves the
  hash filter an outlier rather than a convention. **The developer refined my
  brief here and was right:** I said "make both callers agree"; it did NOT widen
  the shared loop, because `runs.hash` is `TEXT NOT NULL` and the `runs_hash`
  index + `entry_inputs` key-diff join through it — so hash-less outcomes have no
  row by construction. It split the filters instead (telemetry widens to
  group/aborted-only, matching what the dist controller already emits;
  `toRecord` keeps `!o.hash`). **NO TELEMETRY_SCHEMA_VERSION bump:** no field
  changed shape, the records were INCOMPLETE, and all three downstream consumers
  were checked to handle the wider set (cloud ingest already writes
  `t.hash ?? ''`; `github-summary` has an explicit `skipped` case;
  `taskStatusCode` maps skipped to `STATUS_UNSET`). **The rest:** `telemetry()`
  returning `null` — the natural way to express "decline" — aborted the WHOLE RUN
  with a raw TypeError before any task ran, because `createTelemetrySource` sat
  OUTSIDE the try whose docstring promises a throwing plugin is logged and
  skipped (also `[null]`, `[undefined]`, `wants: 5`, a throwing `wants` getter);
  `createWireRenderer` silently DROPPED skipped tasks (the scheduler finishes a
  skip without `onStart`, so `task:complete` arrives with no `task:start` and the
  `if (node)` guard swallowed it) while still forwarding a footer claiming the
  higher total — the two functions are public and documented as inverses; the
  zero-cost gate keyed on `hasPlugins` rather than "contributes telemetry", so a
  backend-only plugin paid 2 git spawns and a `.vx/workspace-id` WRITE;
  `--summarize` was internally inconsistent (`tasks.length` 3 vs
  `summary.total` 2); and `captureDefaultBranch` HUNG on a character-device
  `GITHUB_EVENT_PATH` (`/dev/zero`) — so hard that the synchronous `readFileSync`
  wedged the whole `bun test` process past 2 minutes, uninterruptible by the
  per-test timeout. **Two more places the developer corrected me:** the dist
  controller's synthesized `task:start` is NOT a workaround for the wire defect
  (dist builds `WireEvent`s directly rather than through `wireForwarder`, so it
  solves the same requirement in the other producer) — left in place; and fix #5
  does NOT reduce THIS repo's own cost, because `otel()` and `cloud()` both
  HAVE the telemetry capability — it fixes backend/cache-only plugins. On #8 it
  argued against BOTH loosening and bumping: loosening `defaultBranch`/
  `startedAt` pushes `undefined` onto live readers under
  `exactOptionalPropertyTypes` for zero runtime gain, and a v3 bump would
  invalidate v2 readers that already handle both correctly — core always emits
  them, so _required in v2_ is accurate and the misleading half was the prose.
  **A pre-existing test ENCODED defect #6** (asserting `tasks[]` holds a group
  while `summary.total` excludes it, with a comment rationalizing it) — same
  class as the memo test that asserted a stale digest; it now asserts
  `tasks.length === summary.total`. Differentials: new lifecycle suite **13 fail
  / 5 pass → 18 / 0** (the 5 constant passes are deliberate controls), events +
  run-artifacts **3 fail → 0**, and the `/dev/zero` pin went from wedging the
  runner to passing in 3 ms. Gates: fmt/lint 0, core **1492/0** (21 skip =
  sandbox), cloud contract suites (dist-scheduler / dist-ingest / plugin /
  wire-dist) 50/0. **Named residual:** `invocations.taskCount` still
  under-reports the same way telemetry did, because the header row is built from
  `toRecord` which correctly keeps `!o.hash` — so a failed persistent run still
  records `taskCount: 0` locally for `vx info` / `vx mcp` / `metrics.ts`. Fixing
  it needs a nullable `runs.hash` (SCHEMA bump + one cold rebuild) or decoupled
  header counters that would stop matching `COUNT(*) FROM runs` — its own
  decision, deliberately not made in a no-bump wave. **Container note:** the full
  cloud suite is not a usable signal here — the browser suites fail
  non-deterministically under load (9 fails at HEAD, then 2, then 10 with the
  same fixes); the decisive check is isolated, where `visual.test.ts` gives an
  identical 9 pass / 1 fail (`task-detail`) both at HEAD and with the fixes,
  i.e. the documented pre-existing baseline drift.

- **2026-07-27**: **The upload queue stops holding every pending artifact's bytes
  in RAM — plus the remote-cache audit's three LOW residuals closed.** `save()`
  eagerly read the whole artifact and pushed a closure CAPTURING those bytes into
  an uncapped queue, so `UPLOAD_CONCURRENCY` bounded sockets and nothing bounded
  memory. The decisive measurement is the SCALING, not one pair — with 4 uploads
  stalled and 16.78 MB artifacts: 8 saves 313.7→195.9 MB, 16 saves 474.8→182.7,
  32 saves 725.9→181.9. Pre-fix slope **17.2 MB per additional save** — exactly
  one artifact — so peak scaled with a run's TOTAL miss artifact bytes; post-fix
  flat, gap unbounded. End-to-end through `run()` (24 × 16 MB, stalled remote):
  peak RSS ~700-728 MB → ~465-510 MB. **Deferred the read rather than
  backpressuring `save()`**: backpressure would stall a task's completion on
  upload bandwidth, i.e. change run wall-clock, which this codebase does not do
  silently. The deferral is **ASYMMETRIC and that is the load-bearing part** —
  when `localWrite` is off (`--cache=local:,remote:rw`) there is no on-disk
  artifact to read later, so those bytes are still packed eagerly while the
  task's outputs are still on disk; deferring THAT read would pack whatever the
  tree happens to hold when the job runs. That path keeps the old memory profile
  by necessity (stated in the comment, and a residual). On the dominant path the
  artifact is content-addressed and immutable, so a deferred read sees identical
  bytes, and a concurrent `vx cache prune` makes it throw → skipped upload under
  the existing never-fail contract. Bonus: the closure no longer captures `args`,
  so the queue also stops retaining each task's stdout. **Hot path measured
  interleaved AND order-balanced, and the first attempt was a false negative
  worth remembering:** it showed "11% slower" purely because the fixed variant
  always ran first against a colder freshly-created workspace — an ORDERING
  BIAS, not a signal. Order-alternating min-of-5: time inside `save()` 846→777 ms
  (−8.2% min, −3.6% median), total-with-drain 888→806 ms, `drainUploads` tail
  ~1 ms both ways. **The three LOWs:** `planRun` read the UNCLAMPED policy, so
  `--dry --cache=local:,remote:rw` with no remote printed `cache miss — would
exec` for a run that recorded `cache_policy = ""` and stored nothing — the
  real fix was structural, hoisting the clamp into a shared
  `effectiveCachePolicy(requested, hasRemoteLayer)` that `run()` and `planRun()`
  both derive from, so they cannot drift again (the call site was only the
  symptom). A purely-local hit could be stamped `source: 'remote'` with
  **0 remote GETs issued** — `doPullFromRemote`'s local-first skip returns true
  without setting `remoteSourced` while `get()` stamped remote on anything the
  pull returned true for (analytics only: inflates `hitRemoteCount` and the
  "did the remote save me work?" signal). And `cache.close()` sat on the normal
  path only, so a throwing `recordRunBundle` leaked the SQLite handle and skipped
  `flushAccessed()` — losing the run's `accessed_at` bumps, after which LRU prune
  can evict hot entries; moved into a `finally`, which let the two ad-hoc
  pre-throw `close()` calls be deleted rather than double-closing. NO
  CACHE_VERSION bump: no key changes, no artifact bytes change, and nothing
  already cached becomes wrong or unreadable — only WHEN a byte read happens,
  what a `--dry` line is labelled, what a hit's provenance says, and that a
  handle is closed. NO existing assertion repinned. Differential 41 pass / 4 fail
  → 45 / 0; gates fmt/lint 0, core **1469/0** (21 skip = sandbox). **Residuals,
  named:** the in-memory-pack path above; `drainUploads()` still has no timeout
  and is deliberately NOT added to the `finally` (uploads hold no DB state, and
  awaiting a wedged remote would turn a failing run into a HANGING one), so a
  throw path still drops queued uploads — best-effort for a run that already
  failed; `cacheClosed` is set before `close()` so a throwing close does not get
  retried and mask the real error.

- **2026-07-26**: **`--verify` no longer wipes a successful build's outputs when
  the ONLY write axis is remote — and `hasRemoteLayer` now actually asks whether
  there is a remote** (a repro-mandated hostile audit of remote-cache
  composition, pointed DELIBERATELY at the code the previous wave had just
  landed; both HIGH findings attach to it, which is the argument for auditing
  new code rather than settled code). **HIGH-1, and the previous wave made it
  worse:** that wave fixed only the NO-remote half of the `--verify` output-tree
  wipe. With a REAL remote and `--cache=local:,remote:rw`, `Cache.save` returns
  early (`if (!this.write) return`), `LayeredCache.save` packs in memory and
  PUTs, so the artifact lands remotely and ONLY remotely — then the verify block
  `cleanOutputs()`es and calls `restoreOutputs`, which delegates
  UNCONDITIONALLY to `local`. `CorruptArtifactError` AFTER the tree is emptied.
  Confirmed through the real CLI: task built `dist/app.js`, reported
  `failed exit=1`, `dist/` EMPTY, artifact sitting in the remote store. Fires for
  `local:,remote:rw`, `local:,remote:w`, `local:r,remote:rw`; not for
  `local:w,remote:rw`. **And the error message the previous wave added actively
  sent users into it** — "configure a remote cache (the remote axes do nothing
  without one)" was, verbatim, instructions to reproduce the wipe. **The fix is
  the GATE, not a remote fallback in `restoreOutputs`, and the reasoning is the
  durable part:** the property `--verify` exists to preserve is "disk ends
  byte-identical to the cached artifact REGARDLESS of verdict"; a remote
  fallback does not restore that, it downgrades it to "whenever the remote is
  reachable in the window after `cleanOutputs()` already emptied the tree" —
  the same data loss, narrower, and now nondeterministic. `restoreOutputs` being
  a local extraction is the design, not an oversight to route around. Nothing
  that worked is lost: `local:w,remote:rw` verified before and still does; only
  the three tree-wiping forms are refused, before any task runs. **HIGH-2 — I
  approved a design that was wrong.** I took `hasRemoteLayer = cache !==
localCache` over `instanceof LayeredCache` because it "stays right for a
  third-party plugin layer". It is not a test for "has a remote", it is a test
  for "the plugin returned a different handle" — an ordinary pass-through
  decorator with NO remote unclamps the policy and reproduces the exact bug the
  wave fixed (differentially confirmed: pass-through → `hasRemoteLayer=true` and
  a stray file in the output dir DELETED; fixed → `false`, stray survives).
  Replaced with an explicit optional `CacheLayer.hasRemote` the layer answers
  truthfully (+ optional `remoteHasMany`/`markRemoteAbsent`/`drainUploads`),
  absent reading as "no remote" — the safe answer. **MED-5, closed by the same
  marker:** `shouldShortCircuit`, the prefetch gate and `drainUploads` all still
  keyed on `instanceof LayeredCache`, so a third-party layer took the up-front
  local classify whose `cache.get` is a full remote read-through AWAITED BEFORE
  ANY TASK IS SCHEDULED — exactly what run.ts's own perf-firewall comment
  forbids. Measured at 41 tasks / concurrency 8 / 50 ms: `layered` 169 ms to
  first task, `thirdparty` **475 ms** (≈ ceil(N/conc)×latency, so ~3 s at 1000
  tasks / 16 workers); after, a layer declaring `hasRemote` is 171 ms and its
  uploads are drained. **MED-4, solved coherently with HIGH-1 because it is the
  same policy string:** `LayeredCache.get` ingested the remote artifact
  (correctly ungated) and then RE-READ it through `local.get`, which IS
  read-gated — so with `localRead=false` every hit was thrown away: three
  consecutive runs each did 4 GETs, 4 PUTs and executed everything. Now the
  just-ingested entry is read through a new `Cache.getIngested`, so the gate
  keeps its real meaning ("don't serve hits from the PRE-EXISTING local cache")
  and `local:,remote:rw` becomes a genuinely useful remote-only cache. **NO
  CACHE_VERSION bump, argued:** key derivation is untouched (no component added,
  removed, reordered or re-namespaced) and artifact bytes are untouched — the
  v25/v26 condition is "stored bytes wrong under an unchanged key", and neither
  is wrong here; MED-4 returns an entry for an ALREADY-CORRECT key that the old
  code discarded, through the same row + artifact-exists checks. **A finding I
  briefed that the developer REFUTED, correctly:** I asked for
  `packages/cloud/src/dist/submit.ts`'s `instanceof` to switch to `hasRemote`.
  That would BROADEN the set of layers substituted for the agent remote, and a
  third-party remote does not hold the serve's artifact store — turning a silent
  bypass into a silent wrong-store read. Discarding a third-party layer there is
  correct. **Recorded, not fixed:** that same site DOES take a workspace-declared
  `LayeredCache` pointed at a different remote (the comment claiming prepareRun
  composed no remote layer is true only for the injection path) — the honest fix
  is to always build the agent layer or thread the agent remote into
  `prepareRun`, a dist-flow change; `local:` still re-consults the remote every
  run (deliberate — it is the literal semantics, and it stops a suspect local
  artifact being served); the write-through upload queue holds every pending
  artifact's FULL BYTES in RAM (measured 320 MB pinned behind 4 sockets;
  `UPLOAD_CONCURRENCY` bounds sockets, not memory) — bound the queue or defer the
  byte read into the job; `planRun` still reads the UNCLAMPED policy so `--dry`
  can label a run `miss` when caching is entirely off; and a purely-local hit can
  be stamped `source: 'remote'` when local gains the artifact mid-`get`
  (analytics only). Gates: fmt/lint 0, core **1464/0** (21 skip = sandbox).
  **Clean negative worth keeping:** the policy clamp CANNOT create a stale hit —
  exhaustive consumer map plus a codegen→consumer fixture driven through all
  three composition modes (plain local, injected LayeredCache, third-party
  layer), all three `run1 v1 / run2 v2`, no stale hit.

- **2026-07-26**: **A dev server's output after it signals ready reaches the
  terminal again, and stops being retained forever** (from a repro-mandated
  hostile audit of the exec primitives + env isolation). Three contracts that
  are individually right compose into a leak: `runPersistent` deliberately keeps
  invoking `onStdout` for the child's whole lifetime, `execute-task` returns the
  outcome at READY, and the logger's `taskComplete` does `takeChunks()` — which
  DELETES the buffer. Every later chunk hit `pushChunk`, which RE-CREATED the
  entry, and nothing ever drained it again (`runEnd` flushed only
  `deferredFailures`). So a `readyWhen` server's post-ready output was invisible
  in every view but a live-streaming focused one — **1 of 20 lines in `full`,
  the CI default; 0 of 20 with the server pulled in as a DEPENDENCY**, which is
  exactly the shape where you need it (an `e2e` task failing against the server
  it depends on). And the bytes were retained for the rest of the run: measured
  **93 MiB retained from 122 MiB pushed** pre-fix, **0.00 post-fix**. Post-ready
  chunks now route into a per-stream bounded tail (64 KiB, whole-chunk head
  eviction, a `dropped` counter so a capped tail can never read as complete) and
  flush at `runEnd` as one trailing block ABOVE the failures they explain.
  **Registration is unconditional, only the FLUSH is view-gated** — `none` and
  `errors-only` state their contracts absolutely, but the bound is a memory
  invariant, not a display choice, so gating capture would have kept the leak.
  Guarded like `flushedFailures` because `run()` calls `runEnd` TWICE on the
  success path and a kept-alive child keeps writing between the two. Views that
  change: `full`, `broad`, and focused-as-a-dependency, and only when a
  persistent task became ready AND wrote afterwards; `errors-only`, `none`, a
  live-streaming persistent task, a silent server, and every run with no
  persistent task are byte-identical (verified by diffing all four views of a
  non-persistent run). **Bundled: `forwardArgs` on the ready-on-spawn persistent
  path were quoted with `JSON.stringify`**, and double quotes do not stop `sh`
  expanding — confirmed end-to-end through the suite's `got.txt` handshake with
  a one-shot control alongside: `one-shot (shellQuote) ARG=[$(id -u)]` vs
  `persistent (JSON.stringify) ARG=[0]`, the uid. `shellQuote` is what the
  one-shot path already used; it is now exported from the exec contract. Pins
  are PURELY ADDITIVE (`git diff --numstat` on tests is `129/0` and `23/0` — no
  existing assertion repinned), differential **67 pass / 6 fail → 73 / 0**,
  which I re-ran myself after the merge moved HEAD. Gates: fmt/lint 0, core
  **1457/0** (21 skip = sandbox). **Recorded, NOT fixed:** `consumeChunks` trims
  `fragment` only at `lastIndexOf('\n')`, so `\r`-only progress-bar output never
  trims — **288,910 chars in 2.5 s** with a never-matching `readyWhen`; bounded
  in practice by `exec.timeout` (the documented readiness bound), unbounded only
  when a never-matching `readyWhen` has no timeout, and note `runPersistent`'s
  own docstring claims the buffers exist so a server "must not accrete its whole
  log history" — true post-ready, false pre-ready. Also recorded: at concurrency
  ≥10 the status region is 23 lines (26 with 3 persistent pins) while
  `eraseSeq()` emits a fixed cursor-up with NO terminal-height check anywhere in
  the writer or logger; the arithmetic is confirmed but the consequence is NOT —
  it needs a real TTY of controlled height, which this container has none of, so
  it is not claimed as observed. **Process hazard worth keeping:** the agent
  doing this work ran `git stash push -- src/` differentials WHILE I was
  committing and resetting the branch underneath it. They came back symmetric
  each time and its tree was verified intact, but a stash-based differential is
  not safe against a concurrently-moving HEAD — serialize them, or use
  `git checkout HEAD~1 -- <files>` against a committed change.

- **2026-07-26**: **Two more reference tables pinned to the code they describe,
  and both were wrong** (#187, #188 — extending the schema-table guard). (1)
  **`docs/cli.md`'s Flags table** is what a user scans to learn what `vx run`
  accepts, and nothing tied it to the parser. The guard reads the accepted flags
  out of `parseRunArgs` (reliable because every flag is matched as a string
  literal — if that ever becomes a computed lookup the assertion fails loudly,
  which is the intended outcome and is said at the site) and compares both
  directions in ONE assertion that names which one drifted. It found
  `--continue`: parsed, with its own Failure-propagation section, but NO row in
  the table. (2) **`docs/schema.md`'s other two tables**, which the first guard
  had explicitly scoped out — closing that gap found both wrong. Workspace
  discovery documented `packages must be an array of globs` and `workspaces must
  be an array of globs`; **neither string exists anywhere in `src/`** (the real
  text is `must be an array of glob strings`), so a user grepping the doc for
  the error they just saw found nothing — the exact failure the guard exists to
  prevent. It also omitted the yarn-legacy `workspaces.packages` form, a third
  distinct message. Workspace config omitted two errors the loader really raises
  (`plugins[<i>] must be an object`, `plugins[<i>].<capability> must be a
function`) and its `plugins[i]` rows were unmatchable as printed, since the
  real message carries an index — they now use the `<i>` placeholder the segment
  matcher already understood. The row scan is anchored PER TABLE rather than run
  to EOF, so a row cannot be counted against the wrong surface. **Process note:
  my first differential for the source-reword direction was VACUOUS** — the
  `sed` missed the backticks the source puts around identifiers, so it changed
  nothing and "passed". Same class as the stash-that-stashed-nothing mistake
  from the artifact wave: a differential is only as good as its failure side,
  so always confirm the FAILURE actually fires before trusting the pass.

- **2026-07-26**: **A signal-killed task no longer poisons the cache for its
  dependents — CACHE_VERSION v25 → v26** (from a repro-mandated hostile audit of
  the scheduler + task execution lifecycle). **The stale hit:** `willSkip`
  propagated `failed` and `skipped` but NOT `aborted`, so when a child died to
  SIGTERM/SIGINT its dependents RAN ANYWAY against partial outputs, succeeded,
  and cached what they built. A dependent's key folds the upstream's INPUT key,
  which a signal does not change — so the poisoned entry sits under EXACTLY the
  key a healthy run derives. Reproduced end-to-end through the real CLI: run 1
  killed mid-write leaves `PARTIAL`, run 2 is FULLY HEALTHY (`a` completes,
  writes `COMPLETE`) and vx still serves `b` from cache — `⇢ 16ms success local`,
  **exit 0**, green summary, `PARTIAL` on disk; `b` was even restore-tiered
  AHEAD of `a`. This is the DEFAULT `deps-ok` mode, no flag; reachable from any
  non-vx-handler signal (external `kill`, supervisor, `docker stop`, a
  self-terminating script) and widened by every `handleSignals: false` embedder
  — `vx watch` and the distributed agent loop. **CACHE_VERSION BUMPED, and I
  overrode the implementer's argument to skip it:** it reasoned narrow-window +
  "one machine's local cache". The window is narrow, but a `LayeredCache`
  UPLOADS that entry, so the reach is a whole team's shared cache — and this is
  precisely the documented bump condition (stored bytes wrong under an unchanged
  key, NOT the self-healing class: the fix stops new poison but cannot reach
  what is already written). Pre-alpha, so one cold rebuild is the cheap side.
  **Two more from the same audit.** (2) An aborted task was invisible in the
  tally, logger, report and `recordRun`, yet `ok` requires success/hit — so a
  run exited **1 with a fully green summary naming nothing**, undiagnosable in
  CI. The "not counted, not shown" rule is sound ONLY on the Ctrl-C path, where
  the handler `process.exit`s before any summary; every other path prints and
  says nothing. New `formatAbortedSection` names them after the summary
  (matching `formatVerifySection`'s existing `✗ <id> — <reason>` shape — I
  checked that against the circles-only glyph note before flagging it, and the
  note governs task ROWS, not these sections). A pre-existing test ENCODED the
  defect (`expect(md).not.toContain('web#dev')`) and now pins the corrected
  contract. (3) `--verify` with `--cache=local:,remote:rw` and NO remote
  configured DELETED the output tree and reported a successful task `failed`:
  `willWrite` read the remote axis as on, so the verifier cleaned outputs and
  restored an artifact `cache.save` had skipped. Fixed by normalising the policy
  ONCE in `run.ts` off a new `PreparedRun.hasRemoteLayer` — `cache !==
localCache`, since `resolveCache`'s fallback IS `localCache`, which beats
  `instanceof LayeredCache` for a third-party plugin layer. **`--continue=always`
  is unchanged and still behaves as documented** (`willSkip` returns false for
  `always` before the dep scan), pinned as a control. Differentials: scheduler
  reverted 2 fail/39 pass, summary trio 1 fail/2 pass, prepare+run 2 fail/29
  pass. Gates: fmt/lint 0, core **1432/0** (21 skip = sandbox, `bwrap`
  unavailable). **Process note worth keeping:** the implementer's own `perl`
  insertion missed a `PreparedRun` return site, leaving `hasRemoteLayer`
  undefined there — correct for every repro and pin it wrote, while SILENTLY
  disabling remote read+write for real remote layers. `tests/orchestrator-remote.
test.ts` caught it 2/11. That suite is load-bearing for anything touching cache
  composition.

- **2026-07-26**: **Two tests that misdiagnosed themselves, and a docs table that
  could lie** (#185; the second and third were each found by the previous
  commit's CI red). (1) **`docs/schema.md`'s validation-error table is now
  pinned to the loader** — it publishes the exact symptom a user sees, and
  nothing checked the loader still emits those strings. The guard is driven BY
  the table: it parses the Symptom column out of the markdown and asserts in ONE
  comparison that the documented set equals the pinned set, so a new row cannot
  land unpinned and a removed row fails until its case goes too. Writing it found
  two disagreements — the table drops the backticks the real messages put around
  identifiers (so its strings were not greppable as printed; normalised on both
  sides, since the wording is what drifts), and `did not export a default object`
  comes from the LOADER not the validator, so it is provoked through the real
  `loadProjectConfig`. Differential both ways: reword the doc row → 1 fail;
  reword the loader message → 1 fail. (2) **The `vx watch` e2e flake is FIXED at
  its root, and it was never a timing flake** — the decision log called it one
  three times and twice raised the timeout, which could never work. `runWatchLoop`
  installs its `fs.watch` handles only AFTER the initial run's output is flushed,
  and the test waited for that OUTPUT (`v0`) before writing — so a write landing
  in the gap is dropped by the OS and no re-run EVER fires. The event is LOST,
  not late. Diagnosed by capturing the run's own output at the moment of failure:
  `watching 1 project(s)` present, `re-running...` absent. All five sibling watch
  tests already waited on that readiness line; this one was the lone deviation.
  Measured interleaved: 4/5 fail before (at the pre-config-worker commit, so NOT
  a #184 regression — checked), 5/5 pass after, 3/3 under four-way CPU
  contention. **The same ordering is a real product gap, deliberately NOT fixed:**
  an edit made during `vx watch`'s initial run is silently dropped, and the
  obvious fix (watchers first) forces `anyTaskUsesWorkspaceFiles` ahead of the
  run to choose which watchers to install — which marks every config loaded and
  turns the initial run's OWN loads into worker round-trips. Reason recorded at
  the site; closing it properly needs the `workspaceWide` decision made without
  loading configs. (3) **`affected`'s 50-commit test now states its own
  precondition** — it has failed in CI twice pointing AWAY from the cause (once
  `HEAD~50 did not resolve`, once a bare ENOENT on the fixture write), never
  reproduces on a clean tree (0/30), and I checked the disk-pressure theory
  rather than assuming it: one full suite run leaks **16K across 2 dirs**, so the
  9.2 GB of `/tmp/vx-*` seen locally is the residue of dozens of runs, not
  something one CI run does to itself. It now reports `MISSING — root holds
[packages, .git]` instead of a raw syscall error. **Environment note:** a
  loaded box makes both classes bite — if a suite starts failing strangely,
  check `ls -d /tmp/vx-* | wc -l` before suspecting the diff.

- **2026-07-26**: **`vx watch` stopped running a STALE config forever — and the
  fix I briefed would not have worked** (from a repro-mandated hostile audit of
  config loading, validation, and the lockfile — the layer that decides what vx
  actually runs). **HIGH: the module cache-bust key hashes only the config
  file's OWN bytes, so its IMPORT CLOSURE is invisible.** In any long-lived
  process the loader replays an already-evaluated module: during a `vx watch`
  session, editing a shared preset silently has no effect for the life of the
  process — the watcher fires, vx re-runs, and executes the OLD command. With
  caching on it is worse, because the key derives from the stale resolved
  config, so vx reports a green `1 up-to-date` for a task whose command on disk
  CHANGED. A stale hit reached through the config loader. It bites precisely
  because presets-via-import are THE documented composition mechanism here —
  CLAUDE.md rejects a `globalInputs` schema field on exactly that basis, and
  `vx migrate` GENERATES a root `vx-preset.ts` for it. **I briefed the wrong
  fix and the developer probed before following it:** threading the existing
  `fresh: true` (a unique bust on the ENTRY) does NOT re-evaluate the closure,
  because Bun keys a cached module on the RESOLVED SPECIFIER and
  `import './preset.js'` resolves identically no matter what query the entry
  carries — measured: unique-bust load still returned `VERSION-1`. **`fresh` is
  therefore weaker than its docstring claims** — it re-evaluates the ENTRY
  only, enough for `vx lock`'s env-drift purpose in a fresh process, not for a
  closure. **The mechanism took TWO attempts, and the first one is the lesson.**
  Attempt 1 evicted the closure from `globalThis.Loader.registry` and was green
  here — but that is an UNDOCUMENTED Bun internal, and CI installs
  `bun-version: latest`. Probed on both binaries: `Loader` is a Map on **1.3.11**
  and **GONE on 1.3.14** (`$Loader`/`__bun_loader`/`ModuleLoader` all undefined
  too), so on the version users actually run the loader took its
  degrade-to-today's-behaviour path and the fix was a **SILENT NO-OP** — and its
  own two pins failed on CI while passing locally. The graceful degradation is
  exactly what made it fail quietly instead of loudly: **a mechanism that works
  on one runtime version and no-ops on another is worse than one that always
  works**, so the registry path was DELETED outright rather than kept as a fast
  path. Attempt 2 evaluates a repeat load in a **Worker built from an inline
  `data:` URL** — the only public API that re-evaluates a whole closure. I
  briefed a subprocess; the developer measured (**~8-15 ms vs ~30-50 ms**) and,
  decisively, proved the shape is forced by the shipped artifact: **`bun build
--compile` does NOT embed a Worker entry file** (a sibling `worker.ts` binary
  dies `ModuleNotFound` once the source moves away) and a compiled binary
  **cannot spawn `bun`** — so an inline data URL is the one form that survives
  compilation, and my subprocess design would have broken the release binary.
  Two properties make it safe: the config crosses as JSON, which is ALREADY the
  config contract (`hashTaskConfig` stringifies it, `vx lock` stores the same
  round-trip), so a worker-read config derives the SAME key — hence no
  CACHE_VERSION bump; and concurrent loads share ONE Worker retired when the
  last settles, since `prepareRun` uses `Promise.all` (unshared cost was
  measured at **2775 ms for N=200**). Validation stays in the PARENT
  deliberately, running on whichever object the two paths produced, so a
  malformed config yields an IDENTICAL `UserError` with no error-text
  marshalling; only evaluation failures cross the boundary, and
  name/message/first-stack-line were compared across both paths. A first load
  keeps the in-process path, so `vx run` gains nothing. Pins pass under BOTH
  binaries (1.3.14 was 1 pass / 2 fail before, 3/0 after), and a REAL `vx watch`
  session editing only the preset produced **0** occurrences of the new command
  before and **110** after — **110 again from a `--compile --minify --bytecode`
  binary**. I verified the pins under both binaries myself. **A hang vector the
  Worker introduced, found by refusing to accept the CI red as "just the known
  watch flake":** the Worker had NO deadline and NO `messageerror` handler, so a
  worker thread the OS KILLS (memory pressure on a loaded runner) fires no
  `error` event and its caller awaits FOREVER — in `vx watch` a permanent hang
  on a cycle that normally takes milliseconds, with nothing else bounding it
  since there is no run-level timeout. That is the same class as the 2026-07-19
  runner hang, reintroduced through a new path. Fixed with a 30 s deadline that
  rejects, terminates the worker and lets the next round start clean, plus a
  `messageerror` handler for the other silent path. **The first pin for it was
  BAD and was thrown away** — it grepped the source for `WORKER_TIMEOUT_MS`,
  which asserts a constant exists, not that anything works; the deadline is now
  read per call from `VX_CONFIG_WORKER_TIMEOUT_MS` so the pin drives it to
  250 ms and asserts the REAL rejection (without the deadline that pin hangs to
  its 5 s guard). Whether this WAS the watch flake is not claimed — it is a
  genuine hang vector either way, and raising the test's 45 s budget would have
  papered over a HANG (a healthy run of that test takes ~2.3 s, so it fails by
  hanging, not by running long). **Named residual:**
  `loadWorkspaceConfig` gets no Worker path — `vx.workspace.ts` declares
  `plugins`, which hold FUNCTIONS and cannot cross the boundary; nothing there
  feeds a cache key so it cannot cause a stale hit, but a `vx.workspace.ts`
  closure still goes stale in a long-lived process. **MED-HIGH: a typo'd cache-key
  field was silently ignored, producing a stale hit.** Unknown keys were
  allowlisted ONLY inside `sandbox` and `exec.resources` (whose own comment
  says "future axes must be added deliberately"); every other level — task,
  `exec`, `cache`, `cache.inputs`, `cache.outputs` — silently accepted and
  discarded them. So `cache.inputs.workspaceFile` (singular) meant the user
  believed a root file was a tracked input and got a green cache hit replaying
  stale outputs, with ZERO warning. Also silently accepted: `exec.timeoutMs`,
  `exec.persistant`, `task.caches`, `task.dependOn`, `cache.inputs.task`, and
  `tasks: [{…}]` (an array reinterpreted as a task literally named `"0"`). The
  asymmetry was accidental; the allowlist now covers every level, walked
  interface by interface from `src/config.ts` with a control asserting every
  DECLARED field still loads. **The rest:** `vx migrate` wrote configs that do
  not load while reporting `1 task migrated clean, 0 TODOs` — a package.json
  script was admitted on `!== undefined`, so `42`/`{}`/`true`/`""` became
  `exec.command` verbatim and `null` crashed the emitter mid-migration; an
  EMPTY script string is entirely legitimate, so this needed no malformed
  input. Such a task is now excluded from the emitted set, so a `dependsOn`
  edge onto it is dropped rather than left pointing at a task that was never
  written. `cache.inputs.tasks` was the one `CacheInputs` field with no
  validation (a non-`string[]` reached `filterUpstreamHashes` and crashed with
  a raw TypeError naming nothing). A malformed member `package.json` in a
  1000-package monorepo produced exactly `vx: Failed to parse JSON` — no
  filename — and a scalar `packages:` in `pnpm-workspace.yaml` gave
  `TypeError: workspace.packageGlobs.map is not a function`. **One finding I
  OVERRODE:** the audit flagged `description` being folded into the cache key
  as contradicting `src/config.ts`'s "Pure metadata — no effect on caching".
  `docs/caching.md` documents that fold as DELIBERATE with the reasoning
  written out ("a description change isn't a correctness change but the cost of
  a re-run is low"), so the COMMENT is the wrong side — stripping it would have
  meant a CACHE_VERSION bump for zero correctness gain and reversed a
  considered decision. Comment corrected in `config.ts` AND `docs/schema.md`,
  which carried the same wrong claim. **REFUTED with a concrete reason:** I
  inferred the cloud standing-agent path (`dist/submit.ts` → `prepareRun` in a
  long-lived loop) shared the staleness; it does share the loader but cannot go
  stale, because `vx-cloud agent` pins `checkoutRoot` + `commitSha` at startup
  and REFUSES a dirty tree, so the config bytes and the closure are constant
  across assignments. **NO CACHE_VERSION bump:** nothing changes key derivation
  for an already-correct config — the rejections turn a silently-wrong key into
  a loud error, and the closure fix makes a repeat load observe the same inputs
  a fresh process always did. Gates: fmt/lint 0, core **1396/0** (+28; 21 skip
  = sandbox, `bwrap` unavailable), ui 91/0; this repo's own 5 configs,
  `vx lock --check`, `vx show` and `vx run --dry --all` all still pass.
  **Recorded SOUND by the same audit, so nobody re-audits:** the migrate TS
  emitter under hostile `turbo.json` (unicode / reserved-word / leading-digit /
  spaced task names, embedded quotes + backslashes + newlines in globs and env
  names, `$TURBO_ROOT$` prefixes, negated outputs — every generated file loads
  AND validates, and the generated `vx-preset.ts` preserves values
  byte-for-byte); lockfile drift in all four scenarios (project renamed or
  added → `--frozen` errors naming the project and path; `--check` reports both
  plus the deleted-config case; a scoped `--frozen` run correctly ignores an
  unlocked out-of-scope project; a hand-tampered lock IS executed by
  `--frozen`, which is the documented deliberate trust model that `--check`
  catches); the `..`/absolute glob guards including the harmless `!!../x`
  double-negation (one `!` is stripped and the remainder used as an EXCLUDE
  glob, so nothing is ever resolved or deleted); array-vs-object container
  rejections; `hashableConfig` key-order stability (`{...cfg, exec: execRest}`
  preserves original key positions, so the documented byte-identity claim
  holds); task names containing `#` (both parsers split on the FIRST `#`); and
  that `vx lock --check` DOES observe import-closure drift because it runs in a
  fresh process — which is exactly why the watch defect was confined to
  long-lived ones. **Known-open, recorded not fixed:** `fresh`'s docstring
  overstates what it achieves; `vx lock --check` re-evaluates the ENTRY against
  current env while a shared preset's env reads come from whenever that preset
  first evaluated. In a fresh CLI process those are the same instant, so it is
  not a live bug — it would become one if `vx lock` were ever hosted in a
  long-lived process.

- **2026-07-26**: **CACHE_VERSION → v25 — TWO silent-data-loss defects on the
  ORDINARY cache-hit path, no attacker involved** (from a repro-mandated
  hostile audit of artifact pack/extract/restore — what the cache HANDS BACK,
  a surface never previously reviewed). **(a) The EXECUTABLE BIT was stripped
  from every cached output.** `packArtifact` staged each file with
  `Bun.write`, which does not carry the source mode, so tar recorded 0644 and
  the extractor faithfully restored 0644 (the extractor was always correct —
  the loss was entirely at pack time). Any build producing an executable — a
  CLI shim, a compiled binary, a generated script, any `chmod +x` — worked on
  the cold run and was BROKEN by the cache hit: the worst failure profile,
  passing locally on first build and failing on every warm/CI run. **This repo
  shipped the bug against itself** — `build.bun.*` declares mode-755 binaries
  as outputs, so a cache hit on the release path produced NON-EXECUTABLE
  releases. **(b) Any output whose archive entry name exceeded 100 bytes was
  DROPPED on every restore.** `parseTarHeaders` read only the ustar `name`
  field and never `prefix`, while `packArtifact` ran `tar --format=ustar`,
  which splits long paths across both — so the parser saw a bare basename that
  does not start with `outputs/` and the file was neither indexed nor
  restored. **NOT self-healing:** with no `output_files` row, the set-match and
  `isOutputsCurrent` guards both compare a TRUNCATED expectation against a
  TRUNCATED tree, agree, and report `up-to-date` forever; `--force` repairs the
  tree and the next hit destroys it again. Threshold ≥93-char project-relative
  path (≥83 under `workspace-outputs/`) — ordinary for any modern bundler. The
  header comment asserted the OPPOSITE ("Names > 100 chars still work via
  ustar's prefix+name") and is corrected. **The bump is REQUIRED and is the
  opposite of the recent no-bump waves**, which is the distinction worth
  keeping: there the changed KEY was wrong before, so the corrected key was a
  NEW key that missed once and self-healed; here the **stored BYTES are wrong
  while the key addressing them is UNCHANGED**, so without a new namespace the
  fixed code replays them forever and the fix never reaches existing entries.
  NO SCHEMA bump. **Packing switched to `--format=gnu`**, which also fixes a
  WORKING build being reported FAILED (ustar exits 2 on a single path
  component >100 bytes — "cannot be split; not dumped" — _after_ the task
  succeeded, so `vx run` exited 1 on a build that completed fine). I verified
  before delegating that GNU round-trips a 108-char path through vx's EXISTING
  parser: the reader already handles the GNU `L` longname record and
  `tests/tar-security.test.ts` already covers it. **A subtlety the developer
  caught that I had not anticipated:** GNU headers carry `ustar␣␣\0` at byte
  257 and REUSE bytes 345+ for atime/ctime, so an ungated `prefix` read would
  fabricate a garbage parent directory for every GNU entry — the read is gated
  on the POSIX magic, with the gate itself pinned. **Three defence-in-depth
  fixes rode along:** `restoreOutputs` now THROWS instead of returning quietly
  when the artifact vanished (the caller has already run `cleanOutputs`, so a
  silent return is a green hit over an EMPTIED tree — reachable via a
  concurrent `vx cache prune`, a documented normal operation); throwing rather
  than degrading to a miss because restore-tier tasks run BEFORE their deps
  finish under the two-tier scheduler, so falling through to execution would
  run a task against unbuilt inputs — silently wrong beats loudly failed. The
  reader rejects a declared `size` that overruns the archive (`subarray`
  clamps, so a lying header installed silently truncated NUL-padded content as
  a cache HIT rather than degrading to a miss); **checksum verification was
  deliberately NOT added** — an attacker who can supply artifact bytes can
  compute a valid checksum, so it adds zero security value while zstd's frame
  checksum already covers accidental corruption. And directory entries got the
  containment checks file entries already had, resolving the DEEPEST EXISTING
  ancestor rather than the immediate parent (checking only the parent passes
  for `dist/a/b` when `dist` is the symlink and `dist/a` does not exist yet),
  refusing before any `mkdir` so nothing is created outside at all.
  **Verified by me end-to-end, differentially, on my own fixture** — a deep
  100+ byte output path plus a 755 CLI, built, wiped, restored from a real
  cache hit (`1 local`): pre-fix the deep file is GONE and the CLI is 644 and
  will not execute; post-fix both survive and it runs. **Process note:** my
  first differential was VACUOUS — I `git stash`ed after cherry-picking, so
  there was nothing in the working tree to stash and I tested the fixed code
  twice; the giveaway was a "pre-fix" run showing no defect. Use
  `git checkout HEAD~1 -- <files>` to differential against a COMMITTED change.
  **The audit's own meta-note is the lasting lesson:** nothing in the suite
  round-tripped a real archive of a realistic output tree asserting the
  restored tree is byte- AND mode-identical to what the task produced — ONE
  such test would have caught BOTH HIGH defects, and `tests/artifact-roundtrip.
test.ts` is now it. Differentially proven 10 fail / 51 pass → 61 pass / 0
  fail. Gates: fmt/lint 0, core **1368/0** (+12; 21 skip = sandbox, `bwrap`
  unavailable here). **Recorded SOUND by the same audit, so nobody
  re-audits:** path traversal / zip-slip for FILE entries (`..`, absolute,
  `//`, backslash, drive-letter, NUL-truncation, symlinked parent — all
  refused); `isOutputsCurrent` divergences beyond the known same-ms residual
  (file replaced by a directory, size, mode — all correctly false);
  extra/missing files on disk forcing a full clean+restore via `setsMatch` in
  both directions; `isOutputsCurrent(expected=[])` unreachable from
  `restoreHit` (the skip block is guarded by `expected.length > 0`); zero-byte
  outputs round-tripping (correct 512-byte block advance); 8 concurrent
  same-hash `save()`s and 6 concurrent `restoreOutputs` into one tree staying
  byte-intact (the pid+hrtime+random tmp name plus atomic rename holds); every
  zstd-bomb defence; typeflag rejections (hardlink/symlink/chardev/blockdev/
  fifo/contiguous); PAX and AppleDouble skipping; and `markRemoteAbsent` /
  `inflight` dedup / `drainUploads`. **Untested, stated honestly:** restore
  over a read-only existing output — the probe ran as uid 0, where mode bits
  do not block writes, so its result is meaningless.

- **2026-07-26**: **The LAST stale-hit from the input audit closed — a trusted
  index OID is no longer treated as the worktree bytes when a clean filter can
  rewrite them.** Under `text`/`eol`/`ident` (or `core.autocrlf`), git stores
  the LF-normalized blob while the task reads the CRLF worktree file, and
  `git status` compares AFTER filtering — so such a file reports CLEAN and
  keeps its OID. The CRLF and LF states then fold the **SAME** key: reproduced
  end-to-end with `wc -c` reporting 10 bytes, the worktree rewritten to the
  8-byte LF form, and vx answering `up-to-date` with the stale 10. The
  collision is subtle and worth recording: the CLEAN-state key is a lie about
  disk (it describes the index blob), and the later DIRTY-state key — where the
  OID is correctly dropped and `hashFile` hashes the now-LF worktree — computes
  the very same digest, because the index blob WAS the LF form. Fixing only the
  dirty side would have changed nothing. **Gated in three steps so the common
  case pays NOTHING**, because the precise probe is unaffordable: `git ls-files
--eol` (compare `i/` to `w/`) is the exact answer but was MEASURED at
  **240 ms on a 15k-file tree** — 13x the entire enumeration — since it must
  READ every worktree file, and on stock Linux it would find nothing. So:
  (1) `core.autocrlf` true/input ⇒ conversion applies to every auto-detected
  text file with no attribute needed ⇒ trust nothing; (2) else if NO attributes
  source exists anywhere (no in-tree `.gitattributes`, no
  `$GIT_DIR/info/attributes`, no `core.attributesFile`) ⇒ return untouched,
  zero extra work — the default `git init` repo; (3) else ask `git check-attr`
  (**21 ms**, resolves attributes from the index WITHOUT reading content) and
  drop only the paths actually carrying `text`/`eol`/`ident`. `unset` (`-text`)
  and `unspecified` KEEP their OIDs — both leave the blob byte-identical to the
  worktree file. **Dropping an OID is not over-invalidation**: it routes that
  path to `hashFile`, which hashes the worktree bytes — the source that was
  correct all along — so the only cost is the read, which is exactly what the
  gate exists to avoid paying needlessly. The gate itself is FREE: the config
  read rides the existing concurrent `Promise.all` (5 ms against the
  enumeration's 19 ms), `--git-dir` was folded into the `rev-parse` spawn
  already there (a linked worktree's `.git` is a FILE, so `.git/info/` cannot
  be assumed), and nothing is materialized before the gate decides — an
  interleaved min-of-5 A/B over three trials showed baseline 163/172/178 ms vs
  176/178/175 ms, inside the run's own 15 ms spread. NO CACHE_VERSION bump: the
  keys that change were WRONG before (self-healing — miss once, re-run,
  re-cache), and a repo with no filters is byte-identical. Pinned by two REAL-CLI
  e2e cases (the `.gitattributes` form and the `core.autocrlf` form with no
  attributes file at all — an attributes-only gate would miss the second
  entirely) plus a **zero-cost guard** asserting `check-attr` never spawns in a
  plain repo, plus unit matrices for both parsers. Differentially proven by
  disabling ONLY the call: 10 pass / 2 fail → 12 pass / 0 fail. The spawn-count
  guard went 4→5 with `check-attr` explicitly named as NOT among them. Gates:
  fmt/lint 0, core **1356/0** (21 skip = sandbox, `bwrap` unavailable here).
  **With this the input-resolution audit is fully closed** — all four confirmed
  stale-hit defects fixed.

- **2026-07-26**: **THREE stale-cache-hit defects fixed — vx was replaying
  artifacts built from inputs that had since changed** (from a repro-mandated
  hostile audit of cache input resolution + hashing, the surface that decides
  what a cache key is made of; every finding was reproduced end-to-end, with vx
  printing `1 up-to-date` while the OLD content sat on disk). **(1) HIGH — the
  file-hash memo keyed on `(mtime, size)` served a STALE digest.** The
  `file_hashes` row persists across runs, so ANY producer that preserves mtime
  defeated it — `tar -x`, `unzip`, `cp -p`, `rsync --times`, every
  `SOURCE_DATE_EPOCH` generator. The method's own doc comment claimed the memo
  was "byte-for-byte identical to what a fresh content-hash would produce —
  pure optimization, no cache-key change"; that was FALSE, and the comment is
  corrected. Fixed by adding `ctime_ms` + `ino` to the memo key — verified
  empirically first: `utimes` cannot suppress ctime unprivileged, and an atomic
  write-then-rename changes the inode, so the two together close it (git's own
  index keys on ctime+ino+dev for exactly this reason). Both come FREE from the
  stat already taken. **A pre-existing test ENCODED this defect** — it asserted
  the stale digest and called it "the documented fast-path tradeoff"; it now
  asserts the correct digest, plus a rename variant, plus a genuine
  memo-hit case so the optimization is still pinned. **(2) MEDIUM-HIGH — the
  cache-MISS path discarded `cleanOutputs`'s return**, the only one of FOUR
  sibling call sites that did (the workspace twin two lines below marks, as do
  the verify and restore paths). So the wiped paths were never marked, the git
  snapshot kept listing them, and — the load-bearing half — `recordChanged`
  never deleted their OIDs, so `resolveFiles` SKIPPED its existence probe for
  them and folded a file that was GONE FROM DISK into the key. Reachable when a
  consumer decouples via `cache.inputs.tasks` (a first-class documented
  pattern) and the vanished output is tracked+clean at run start — i.e.
  committed generated code (protobuf/GraphQL/OpenAPI clients). Marking at the
  clean site also fixes the broader variant the audit found, where a producer
  emitting ZERO files skipped invalidation entirely. **(3) MEDIUM — a file
  ABSENT from disk counted as an input.** `skip-worktree` / `assume-unchanged`
  entries sit at stage 0 and `git status` reports nothing for them, so they
  kept a trusted OID and short-circuited the existence probe whose whole
  purpose is dropping entries whose worktree file is gone — so materializing a
  sparse-checkout path changed NO key and the old artifact was replayed. Fixed
  with a fourth CONCURRENT `git ls-files -v -z`; **measured before adding it**
  (the rule for this hot path): on a 15k-file tree the existing enumeration is
  ~19 ms and `-v` adds ~5 ms because it is index-only, and an A/B of real warm
  runs on this repo showed no wall-clock change (130 ms vs a 139 ms baseline,
  inside the noise). The `-v` marker set is `S` (skip-worktree, UPPERCASE) plus
  ANY lowercase letter (assume-unchanged) — the first cut checked only
  lowercase and its pin stayed red, which is what a discriminating pin is for.
  **NO CACHE_VERSION bump, argued not assumed:** in all three cases the key
  that changes was WRONG before, so the corrected key is a NEW key that misses
  once and re-caches — self-healing, never a wrong hit — and every already-
  correct invocation is byte-identical. **SCHEMA_VERSION v23 → v24** for the
  two new `file_hashes` columns; the gate drops and recreates every table, so
  this costs one cold rebuild, stated plainly rather than hidden. Pinned by a
  new `tests/stale-hit.test.ts` that drives the REAL CLI end-to-end (build a
  fixture, change an input, run again, assert the OLD artifact was not served)
  — differentially proven 0 pass / 3 fail before the fixes, 3 pass / 0 fail
  after. Two spawn-count guards updated 3→4 and 1→2 / 3→4 (the invariant is
  CONCURRENCY and O(1)-not-O(N), never the literal count). Gates: fmt/lint 0,
  core **1350/0** (21 skip = the sandbox suite, `bwrap` unavailable in this
  container), cloud 599/0, ui 91/0.
  **STILL OPEN, deliberately sequenced — the audit's fourth defect:** trusted
  index OIDs describe the FILTERED blob, not the worktree bytes a task reads,
  so under an active `text`/`eol`/`ident` filter the CRLF and LF forms of a
  file fold the SAME key and a real content change is invisible (reproduced
  with a stock `.gitattributes`, and separately with plain `core.autocrlf=true`
  and no `.gitattributes` at all). The precise fix — `git ls-files --eol`,
  dropping the OID where `i/` ≠ `w/` — was MEASURED at **240 ms on a 15k-file
  tree**, 13× the entire current enumeration, because `--eol` must READ every
  worktree file; that is too much to pay unconditionally on a ~130 ms warm run,
  and in the common Linux case it would find nothing. The cheaper design, for
  its own wave: gate on whether a filter can apply at all (no attributes file
  and `core.autocrlf` off ⇒ zero cost, the common case), then use
  `git check-attr` (measured **21 ms**, resolves attributes WITHOUT reading
  content) to drop the OID for any path with `text`/`eol`/`ident` set. Dropping
  an OID is not over-invalidation — it just routes that path to `hashFile`,
  which hashes the worktree bytes, i.e. the correct source. **Recorded SOUND by
  the same audit, so nobody re-audits them:** `ALWAYS_IGNORE` (all five
  patterns match nested forms); `cleanOutputs` symlink-boundary escape
  (`Bun.Glob.scan` does NOT follow symlinked directories — a `dist ->
../victim` symlink resolved to `[]` and deleted nothing, which with the
  loader's `..`-segment rejection means project outputs cannot cross a
  boundary); merge-conflict duplicate stage entries (all 3 survive into the
  input list, so the fold's count changes on conflict/resolution —
  over-invalidation, the safe direction); `parseStatusOutput` rename framing
  (both sides added to the dirty set regardless of git's `-z` field order);
  `markOutputsChanged` → workspace-partition forwarding and
  `markWorkspaceOutputsChanged` (correct once invoked — defect 2 above was the
  missing CALL, not the bookkeeping); `snapshotFor` glob symmetry (reuse is
  tested with the same positive globs `resolveFiles` filters with; ignoring
  exclude globs is the conservative direction); and the `key()` fold structure
  (seed-chained `xxh3(part, prevDigest)`, not concatenation, so cross-section
  ambiguity would need a genuine hash collision). **One suspected-but-
  UNREACHABLE item, recorded so it is not re-found:** the runtime-value fold's
  `${c}\0${o}` join DOES collide at the `Cache.key` level
  (`[['x','a\0b']]` and `[['x\0a','b']]` fold identical bytes — the same class
  as the fixed `=`→`\0` env bug), but it cannot be reached from a real config
  because `Bun.spawn` refuses a NUL in argv, so such a command can never run.

- **2026-07-26**: **Arg parsing stopped REINTERPRETING what the user typed** —
  the CLI audit's remaining EIGHT defects fixed, one REFUTED, each pinned
  (completing the wave the six silent-wrong-behaviour fixes opened). **The two
  that could bite hardest:** `--cache=` with an empty spec was a silent no-op
  that left caching **FULLY ON** — so `--cache="$POLICY"` with an unset var did
  the OPPOSITE of the intent, and it's the one value flag where "do less" is the
  obvious reading; now a UserError naming the valid forms AND pointing at
  `--no-cache`. And **`--max-size 0` / `--older-than 0d` pruned the ENTIRE
  cache** — a scripting bug (`--max-size "$LIMIT"` unset) wipes everything, and
  the developer CHECKED before assuming rather than reasoning from the
  `--memory 0` precedent: bare `vx cache prune` is an ERROR, so no flag
  combination expresses "wipe the cache" and refusing `0` removes no capability;
  both now refuse, naming `rm -rf` the cache dir as the deliberate alternative.
  **The rest:** `--profile=` (empty) resolved to the cwd DIRECTORY and died
  `EISDIR` _after doing all the work_, while sibling `--summarize=` degraded
  gracefully — unified on the graceful reading, because these are
  OPTIONAL-value flags whose bare form has a documented default, unlike the
  required-value flags (`--retry=`, `--timeout=`, `--cache-dir=`) the sibling
  wave rejects; rejecting would have broken a working `--summarize=` for no
  gain. Numeric flags took anything `Number()` accepts — `--concurrency 0x10`
  ran **16** workers, `2.7` ran **2**, `--timeout 9007199254740993` silently
  became …992 — now a strict decimal-integer parse (`parseDecimalInt` in the
  `util` leaf; `--memory` was ALREADY strict via `parseSize`'s regex, so only
  concurrency/timeout/retry/verbosity needed it, and its digits-past-2^53 guard
  was the only gap). `vx watch` silently accepted `--report`/`--verbosity` it
  cannot honor, an inconsistency in an established pattern (it already rejects
  `--dry`/`--graph`/`--summarize`/`--profile`). Prune's duration/size units were
  case-SENSITIVE and had no `=` form. `--filter`/`--concurrency`/
  `--output-logs`/`--verbosity` were space-only while **`docs/cli.md` already
  PROMISED both forms** — a doc/behaviour disagreement resolved in the docs'
  favour. **The `=`-only flags stay `=`-only, guarded by a test:** `--verify`,
  `--cache`, `--continue`, `--affected`, `--summarize`, `--profile`, `--report`
  are all valid BARE, so a space form would swallow the next positional and
  silently retarget an invocation that works today (the sibling wave's
  reasoning, now pinned so nobody "fixes" the asymmetry). **REFUTED, and the
  developer was right to refuse it:** I asked for the typo'd-task diagnostic to
  be stderr on every path, believing the sibling wave had already done it —
  it hadn't (real run → stdout, `--dry` → stderr), but the message rides
  `log.status`, and `defaultLogger` routes ALL status output through the one
  stdout writer that serializes the live region. Forcing stderr means either
  breaking the Logger abstraction (an embedder's custom logger loses the
  message) or widening a public contract — both bigger than the cosmetic gain,
  and the load-bearing part (exit 1) holds either way. My attribution was also
  wrong: defect 6 of the six was `--verify-allow <csv>`, not the stream.
  **Docs swept:** `cli.md` still listed `--continue=<mode>` and `--cache-dir` as
  roadmap gaps though both shipped, plus a THIRD dead bullet the brief didn't
  name — `--remote-cache-timeout`/`--token`/`--team` "(env vars work)", when
  `VX_REMOTE_CACHE_*` hasn't existed in core since the Turbo wire was deleted.
  NO CACHE_VERSION bump (nothing touches key derivation — only which inputs are
  ACCEPTED and what a flag resolves to). Differentially proven: with `src/`
  stashed the new suite is **17 fail / 6 pass**, with the fixes **23 pass / 0
  fail**, the 6 constant passes being deliberate controls (`--cache=local:`
  still valid, `--summarize=` unchanged, `--memory` size forms, `=`-only stays
  `=`-only). Re-verified through the real CLI in the main tree. Gates: fmt/lint
  0, core **1342/0**, cloud 599/0, ui 91/0.

- **2026-07-26**: **A git failure during `--affected` no longer blames your
  branch name** — plus the test-side hardening that found it. `git rev-parse
--verify --quiet <ref>` exits **1** for "no such ref" but **128** for "git
  cannot operate here at all" (not a repository, corrupt objects, no
  permission); `verifyRef` treated every non-zero exit as `ref "<x>" did not
  resolve`, so `vx run --affected=main` outside a git repo sent you hunting for
  a branch that was never the problem. Only exit 1 keeps the ref message now.
  **Found by diagnosing a CI red, and the diagnosis is the lesson:** the
  `affected` suite failed with `git ref "HEAD~50" did not resolve` from a
  fixture that provably makes 51 commits — the error pointed AWAY from whatever
  actually went wrong, and cost ~20 minutes. Two test-side changes so the next
  occurrence names itself: the suite's git helper now drains **stdout** as well
  as stderr (git writes its most useful failure text to stdout — `git commit`
  with nothing staged exits 1 saying "nothing to commit" on stdout and writes
  NOTHING to stderr, so the helper's error read as a blank `exited 1: `), and
  the 50-commit test asserts its own fixture (51 commits) BEFORE invoking the
  code under test, so a commit that silently fails to land is reported as a
  fixture problem rather than as a ref problem. **The red itself did not
  reproduce** — 15 local attempts, twelve of them under 8-way CPU contention,
  plus three exact mirrors of the fixture in Bun; `affected.ts` was untouched by
  the branch and the suite runs 5th, before any test the branch adds; the next
  CI run was green. Recorded as an environment flake, but the mechanism that
  WOULD produce it is now pinned in the probe record: a same-size content change
  whose mtime matches the index entry exactly makes `git add` stage nothing and
  `git commit` exit 1 — which the old helper reported as a blank error.
  **Process note:** my own verification probe piped the CLI through `tail` and
  read `$?` — which is _tail's_ exit code, the exact mistake this file warns
  about; caught it and re-ran without the pipe. Never read an exit code through
  a pipe.
  of the CLI surface (15 confirmed; the other nine are polish, queued).
  **(1) HIGH, and a live CI footgun:** every non-flag arg becomes a requested
  task, but the "No projects declare task(s)" guard fired ONLY when the ENTIRE
  set resolved to zero. So a typo BESIDE a good task vanished silently —
  `vx run build totallybogus` exited 0 having run 2 tasks, never mentioning
  the typo, and even an ANCHORED `a#totallybogus` was swallowed. `docs/cli.md`
  actively promotes multi-task runs, so a CI job running `vx run lint test
typecheck` goes green the day someone renames `typecheck`. This is EXACTLY
  the class the project already fixed for the single-task case; the multi-task
  path was left behind. Now `unresolvedRequests()` diffs requested NAMES
  against what resolved, sharing ONE `declaresTask()` predicate with
  `expandRequested` so they cannot drift; `run()` refuses, and the
  `--dry`/`--graph` path errors BEFORE writing any DOT/JSON. **Verified not to
  over-fire** (the risk I flagged): a name declared by only SOME projects under
  `--all` stays green, and an EMPTY candidate scope is never reported — that's
  "nothing selected", not a typo, which is what makes (3) possible.
  **(2) MED — every `=`-only flag given the SPACE form silently did something
  else**, exit 0: `--affected origin/main` audited the DEFAULT base (a
  correctness lie), `--graph out.dot` wrote no file, `--excludeDependencies a,b`
  excluded ALL deps. Fixed BY (1). **I suggested also accepting the space form;
  the developer refused and was right:** those flags are all valid BARE, so
  `vx run --affected build` already means "run build, affected scope" — a space
  value is indistinguishable from a task name, and accepting it would silently
  retarget the git base on an invocation that works TODAY. Strictly worse than
  the loud error. **Honest residual, documented:** `--affected <base>` only
  goes loud when something IS affected; with nothing changed, selection
  short-circuits to exit 0 before names are validated (the message does name
  the base actually used). **(3) MED — an explicitly anchored `pkg#task` was
  silently skipped** when a co-requested BARE task's filter selected nothing:
  `vx run a#build build --affected=HEAD` ran nothing, exit 0, contradicting the
  code's own comment that anchored entries resolve regardless. **(4) MED —
  `--cache-dir` was the ONLY value-taking flag accepting a flag-shaped value**
  (9 others were probed and reject one): `--cache-dir $EMPTY --force` created a
  real `./--force` DIRECTORY and dropped the flag. **(5) MED —
  `--excludeDependencies=` meant the OPPOSITE of the bare flag** (empty split →
  no exclusion), so `--excludeDependencies="$SKIP"` with an empty var ran the
  whole closure. REJECTED rather than reinterpreted: both readings are
  defensible, so either silent choice does the opposite of what half the
  callers mean, and every sibling already errors on an empty `=`. **(6) MED —
  `--verify-allow <csv>` was DOCUMENTED but rejected**; the only test covered
  the `=` form, which is why nothing caught it. NO CACHE_VERSION bump —
  nothing touches key derivation or forwardArgs parsing, only which tasks are
  SELECTED and whether an invocation errors. Pins differentially proven
  (4 fail / 4 pass and 3 fail / 3 pass with `src/` stashed, the passes being
  controls that must behave identically). Gates: fmt/lint 0, core **1339/0**
  (+10), cloud 599/0, ui 91/0. **The audit's REFUTED list is on record and
  should not be re-examined:** cache-policy precedence matches `docs/cli.md`
  exactly; `--dry` never executes; `--verify` + a no-write policy is rejected
  loudly; the `--` forwardArgs split is sound (bare `--` does NOT change the
  key; forwardArgs scope to requested tasks only); `vx lock --check`, the
  picker, and the show/info/dispatcher error paths all hold.

- **2026-07-26**: **The other NINE selection/graph defects fixed — the audit's
  tail, each differentially pinned** (completing the wave the two stale-hit
  fixes opened). **(A) MED-HIGH — `pkg#task` was unusable in every scoped
  run.** Scoped config loading computed `needed = seeds ∪ transitiveDeps(seeds)`
  and its comment justified that with "frontier `^task` expansion never escapes
  the closure" — true for `^task`, FALSE for `pkg#task`, which by design ignores
  the package graph. The target's config was never loaded, so the user got
  "no such project or task is declared" about a project that plainly exists;
  ONLY `--all` worked. Now loading runs in fixpoint ROUNDS, scanning each
  round's configs for `cross` specs and queueing those projects plus their own
  closures (a cross target may itself declare `^task`). No cross deps anywhere
  ⇒ one round, byte-identical. **(B) MED — the `^task` frontier wrapped back to
  the DECLARING project on a package cycle** (`directDeps` includes devDeps, so
  the ubiquitous "a deps b, b devDeps a for tests" shape triggers it): the exact
  form threw `Cycle detected: a#build -> a#build` — a lie, there is no
  task-graph cycle — and the pattern form silently added a bogus
  `a#build.inner -> a#build` edge that reached the CACHE KEY. A 3892-graph fuzz
  found 90 self-loop failures. Fixed by seeding `visited` with `projectName`,
  mirroring the self-pattern rule. **CACHE_VERSION: no bump, and the developer
  proved it empirically rather than arguing it** — measured on a real
  workspace: buggy+cycle `f9f235d7…`, buggy+acyclic `654fdcda…`, FIXED
  `654fdcda…` either way. The fix CONVERGES on the key a correct layout already
  derives, so the wrong entry is orphaned, never hit; an acyclic graph is
  byte-identical. A bump would invalidate every correct workspace to clean up
  after a shape that couldn't run. **(C) MED — a package cycle poisoned the
  closure memo**: `legacyTransitive` returned `[]` on the back-edge but CACHED
  that truncated result, so `--filter` answers depended on QUERY ORDER — 1796
  of 25752 mixed-filter cases wrong in BOTH directions (work silently skipped,
  and an explicitly-EXCLUDED package still selected and run). Replaced with an
  iterative `reachableFrom` memoized only on the complete result. **(D+G) MED —
  `--affected` was blind to any changed file with a non-ASCII / `"` / `\` name**
  (no `-z`, so git C-quotes and the literal quoted string matches no project
  dir) **and to untracked files** — while the cache-key enumeration uses `-z`
  AND `--others`, so the two surfaces disagreed about what changed. The
  documented CI recipe silently skipped a genuinely-changed package. Now `-z` +
  a concurrent `git ls-files --others`. **(E) MED — `--filter '*'` matched only
  UNSCOPED packages** (`Bun.Glob` treats `/` as a path separator), so
  `docs/cli.md`'s own recipe under-selected and `'*core*'` couldn't match
  `@acme/core`; replaced with a name-glob compiler, path forms untouched.
  **(F) LOW-MED — `--affected` with an empty change set exited 1**, so a
  docs-only commit redded CI on the flagship guide recipe (Turbo and Nx exit 0);
  now `nothing affected since <ref>` + exit 0, while an empty NAME/PATH pattern
  still fails loud. **(H)** a non-matching filter beside a matching one warns
  per filter instead of silently under-selecting. **(I)** a member whose
  `package.json` has no `name` now warns — but ONLY when the dir has a
  `vx.config.*` (the "meant to run, vanished" case); warning on the rest would
  be noise. **(J)** `-F` never existed (the parser rejects it, as it does `-r`
  and `-v`) — source comments corrected and the 2026-05 entry annotated rather
  than rewritten, since it is an accurate historical record of intent. Gates:
  fmt/lint 0, core **1329/0** (+18), cloud 599/0, ui 91/0. **Environment note:**
  the cloud suite first failed with `No space left on device` — 79 leaked
  ephemeral-Postgres clusters (~820 MB each, 29 GB) from test runs killed
  mid-flight today. Not a code defect; but if `bun test` ever fails with
  PostgresError 53100, check `/tmp/vx-test-pg-*` before suspecting the diff.

- **2026-07-26**: **TWO STALE-HIT BUGS FIXED — running from inside a package
  silently made that package the whole workspace; and a glob in the PROJECT
  half of `cache.inputs.tasks` selected nothing** (a repro-mandated hostile
  audit of selection + graph construction — the surface deciding WHICH
  projects and tasks run, never previously attacked; it confirmed 11 defects,
  these two being the stale-hit pair, which is this project's worst failure
  class). **(1) `findWorkspaceRoot` (`workspace/workspace.ts:52`) returned the
  first ancestor containing ANY `package.json` — and every workspace member has
  one.** So from `packages/a`, the workspace WAS `packages/a`: `^task` edges
  vanished, the key lost its upstream fold, and (the second half nobody had
  spotted) `Cache.key` folds workspace-ROOT-relative rels, so a different root
  also meant a different key namespace. Verified by hand end-to-end: from the
  root `a#build`=668c9500 with `b#build` scheduled; from `packages/a`
  `a#build`=d9f13268 with `b` absent — then build, change `b`'s source,
  re-plan from `packages/a` → **`cache hit (local)`. Stale.** This is the
  DOCUMENTED default scope (`docs/cli.md`: "the project that contains cwd";
  `cli/run.ts` tells you to "run from within a project directory"), and
  `tests/workspace.test.ts` missed it because every case walked up from dirs
  containing NO `package.json`. **Fixed by MEMBERSHIP, not declaration** (the
  developer's call over my suggestion, and the better one): a candidate wins
  only when its package globs CLAIM cwd, read through a shared
  `readPackageGlobs` that `loadWorkspace` also uses — so "the root that claims
  me" and "the root that lists me" cannot diverge. Declaration alone would
  hijack an `examples/demo` package that no glob matches. Nothing claiming cwd
  ⇒ nearest candidate still wins, so standalone/single-project layouts are
  untouched. **On THIS repo:** `packages/cloud` resolved to itself (1 project,
  0 tasks) and now resolves to the repo root (5 projects, 26 tasks) — verified
  before and after. **(2) `upstream.ts` globbed only the TASK half**; the
  project half was `===`, so `'@acme/*#build'` matched NOTHING, the filter came
  back empty, and the task folded ZERO upstream hashes — the documented
  decoupling vector, e2e-confirmed as a stale hit. Same trap the 2026-07-10
  wildcard wave closed for the task half. **I leaned toward REJECTING the form
  (matching `dependsOn`); the developer argued for globbing it and was right:**
  `tests/upstream.test.ts:102` already pins `'other#codegen.*'` working here
  WHILE `dependsOn` rejects it, so "no patterns in cross forms" was never the
  rule — this surface is deliberately the permissive superset. A filter only
  SELECTS from upstreams that already exist, so over-matching over-invalidates
  (safe direction) and package names cannot contain `*`, so nothing previously
  selected becomes unselected. `taskMatcher`+`matches` collapsed into one
  `specMatcher` so the halves can't drift again. **NO CACHE_VERSION bump for
  either**, argued not assumed: both classes of key were WRONG before, so the
  corrected key is a new key that misses once and re-caches — self-healing,
  never a wrong hit; every already-correct invocation is byte-identical. Pins:
  11 unit cases + 2 real-CLI e2e, differentially proven (7 fail / 7 pass and
  4 fail / 17 pass with the fixes reverted, the passes being deliberate
  controls that must behave identically both ways). Docs corrected on both
  (`modules/workspace.md` + `execution.md` said "first match wins";
  `schema.md` said patterns work "in every form's task half"). Gates: fmt/lint
  0, core **1311/0** (+14), cloud 599/0, ui 91/0. **Nine more confirmed
  defects from the same audit are queued** — a `pkg#task` dep failing in every
  scoped run, the `^task` frontier wrapping back to its own project on a
  package cycle, `--affected` blind to non-ASCII filenames, `--filter '*'`
  matching only unscoped packages, and a cycle-poisoned closure memo making
  filter results order-dependent.

- **2026-07-26**: **MEASURED NEGATIVE RESULT — the flagged N+1 queries are fine,
  and the two genuinely quadratic ones have no caller. No rewrite.** A hostile
  audit flagged core `metrics.ts` `getFlakiestTasks` / `getRegressions` as
  per-candidate N+1. Measured before touching them (this repo reverted an
  "obvious" optimisation that regressed warm runs 57%), on synthetic cache.dbs
  from 1k to 1M rows across 50 / 500 / 5,000 distinct pairs. **Query count is
  not what costs time here:** at a fixed 100k rows, going 50→5,000 pairs takes
  the query count 101→7,603 while wall-clock goes 487→196 ms — **75× more
  queries runs 2.5× FASTER**, because each of the N queries scans `rows/N` and
  collectively they touch exactly what one GROUP BY would. `getFlakiestTasks`
  is linear in ROWS and invariant to query count (10.3× for 10× rows);
  `getRegressions` under an adversarial 60%-regressed set took 26× the queries
  for 1.5× the time. Measured per-statement overhead is 3.3-4.1 µs against
  3,099-31,302 µs of real work — **0.01-0.1%**. So the ceiling of a PERFECT
  set-based rewrite is 0.1% at 100k×50, 0.01% at 1M×50, and 16% only at
  100k×5,000, a shape that already runs in ~200 ms. **The audit flagged the
  wrong functions:** the real per-ROW N+1 is `getCacheSavings` and metrics'
  `listProjects` — a correlated scalar subquery per cache-hit row, O(rows²/
  pairs), measured 10.5 SECONDS at 100k×500 and killed at >200 s in other
  shapes, i.e. 39-56× slower than the flagged pair on identical data with the
  FEWEST queries. **But nothing is worth fixing, because NONE of the four has a
  production caller in core** — they are façade re-exports pinned by the
  boundary snapshot, plus tests; every shipping flakiness/regression surface
  goes through `packages/cloud/src/db/analytics.ts`, whose Postgres copy
  ALREADY carries the set-based rewrite (#79) with a byte-identity differential
  test. The rewrite exists where the scale justifies it. (NB the `listProjects`
  with live callers is `workspace/workspace.ts:115` — filesystem discovery, a
  different function that merely shares the name.) **Bounded by design anyway:**
  `Cache.close()` unconditionally prunes `runs` older than 30d on EVERY run, so
  a huge monorepo tops out ~1.5M rows — and big workspaces have MANY pairs,
  which is the ~200 ms shape. **Two things worth remembering:** a covering
  index `runs(project, task, started_at DESC, status, cache_hit, duration_ms)`
  removes a `USE TEMP B-TREE FOR ORDER BY` and measured 1.3-1.5× on flakiest
  and 2.6-3.2× on getHistory — a bigger lever than any rewrite, but it costs
  write amplification on every insert and a SCHEMA_VERSION bump, so it waits
  for an actual complaint; and `getFlakiestTasks(db, limit)` does NOT bound its
  work (the `.slice(limit)` runs after the fan-out) — the argument is
  presentation-only. NO code change.

- **2026-07-26**: **A deleted workspace's artifacts are REAPED — and the guard
  that stops the reaper eating the org's shared cache is the whole feature**
  (closing the leak the delete wave had to admit to in its own confirm dialog:
  `BlobBackend` had no `delete`, so a deleted workspace's bytes rested in
  object storage forever under a scope prefix nothing could ever address
  again). `delete(key)` on both backends — `LocalDirBackend` unlinks the key
  **plus its `.duration`/`.digest` sidecars** (`list` only ever reports
  `.tar.zst`, so a sidecar left behind is a permanent invisible leak), `S3`
  is a SigV4 `DELETE` through the existing hand-rolled signer (204 and 404
  both mean gone). **THE HAZARD, which is why this needed care at all:** an
  ORG-WIDE token writes under a shared `_org` segment that EVERY workspace in
  the org reads, so a reaper that swept `org/<orgId>/ws` instead of
  `org/<orgId>/ws/<workspaceId>` would destroy the entire org's cache on any
  single workspace delete. `reapableSegment` refuses `_org`, `.`, `..` and any
  non-segment; the pin is DISCRIMINATING — broadening the prefix makes it
  delete 4 objects instead of 2 and fail. **Best-effort by construction, and
  the TYPE enforces it:** `AuthRoutesContext.reapArtifacts` returns `void`, so
  the route CANNOT await it — it fires post-commit, because the rows are the
  system of record, a workspace can hold tens of thousands of objects, and a
  failed reap leaves exactly the state that existed before this feature. Also
  made `LocalDirBackend.list` recursive so a prefix listing is depth-blind like
  S3's — verified safe for the read path because every scope a principal lists
  is a LEAF (`trusted` is flat; an untrusted principal lists only its own
  `untrusted/<sub>`), so recursion cannot widen enumeration; the reaper needs
  it because `ws/<id>` is the one non-leaf prefix in the layout. Docs synced,
  including an `api.md` row that still claimed artifacts are NOT removed.
  **Not done, deliberately:** no retry/queue for a failed reap (a durable
  orphaned-prefix sweep needs somewhere to record the intent — its own wave);
  empty dirs remain on the test-only local backend. Gates: fmt/lint 0, cloud
  **599/0**, core 1297/0, ui 91/0, visual 10/10 byte-stable. NO
  migration/schema/wire/CACHE bump. **Process note:** this agent symlinked
  `packages/cloud/ui/node_modules` AND built `ui/dist` so the browser suites
  actually RAN rather than skipping — the first agent today whose reported
  gates were trustworthy on their own. The rule stands regardless: cherry-pick
  into the main tree and re-run.

- **2026-07-26**: **Workspaces can be RENAMED and DELETED — and the delete had
  to reach past the cascade, which does not go where the schema suggests**
  (closing the lifecycle gap the context work exposed: the admin surface was
  create+list only, everything else 404'd, so an auto-provisioned workspace —
  most of them, named from the pushing client — could be born with a wrong name
  and never fixed, and one made by mistake never removed). `PATCH` (rename,
  admin, `SLUG_RE` + 409 on the unique violation) and `DELETE` (admin,
  `{confirm}` echoing the slug) on
  `/v1/admin/orgs/:orgId/workspaces/:id`, both `org_id`-clamped so a cross-org
  id 404s rather than acting. **THE LOAD-BEARING CORRECTION, and it inverted my
  brief:** `invocations` / `task_runs` / `task_logs` / `output_fingerprints`
  carry `workspace_id` with **NO foreign key** — they are RANGE-partitioned, and
  an FK from them would have to be validated across every partition of a
  50-100M-row table. So the cascade reaches only `repos`, `projects` →
  `project_tasks` and `api_tokens`; the delete route removes the four analytics
  tables EXPLICITLY, in one transaction, or the history would be orphaned under
  a dead workspace id rather than gone (invisible, still consuming storage,
  forever). Verified: disabling those four DELETEs makes the cascade pin fail
  on `invocations`. No migration — adding the FKs would be the expensive,
  wrong fix. **A second thing the schema didn't tell you:** a workspace-scoped
  `api_token` DOES cascade away with the row, but the 5s auth memo would keep
  its bearer authenticating — so the route calls `resetTokenCache()`. UI: per-row
  Rename/Delete in Admin → Workspaces, the confirm naming every category of
  loss and arming only on an exact slug match, `refreshWorkspaces(true)` after
  so the sidebar picker updates. **Deleting the workspace you are VIEWING** drops
  you onto a surviving one — and the URL-mirror banner learned not to accuse you
  of following a link "you can't see" when the stale id is one you just deleted
  (`wasWorkspaceRemovedHere`); removing that guard makes the browser pin fail
  with the nonsense text rendered, so it is load-bearing, not decoration.
  **Stated, not hidden:** cached artifacts in object storage are NOT deleted —
  the `BlobBackend` seam has no `delete` — so they become unreachable under a
  dead scope prefix; said plainly in both the UI confirm and the docs, and a
  reaper is its own wave. Gates: fmt/lint 0, cloud **590/0**, core 1297/0, ui
  91/0, visual 10/10 (the `admin` shot is unchanged because `/#/admin` with no
  `?section=` renders Members — checked the capture rather than assuming).
  NO migration / schema / wire / CACHE bump.

- **2026-07-26**: **Nine analytics/MCP defects fixed — the read surfaces answer
  HONESTLY instead of plausibly** (a repro-mandated hostile audit of the core
  MCP + metrics + report surfaces, the last core code never adversarially
  reviewed; every finding below was confirmed by an EXECUTED repro before any
  fix, and every fix carries a pin proven to FAIL without it). **The two that
  mattered:** (1) `vx mcp` cache-stats ADVERTISED a `scope: {project}` and
  ignored it — then echoed it back in the response, so an AI agent could not
  tell it was unhonored (`{"scope":{"project":"DOES-NOT-EXIST"}}` returned the
  full-workspace numbers labelled as that project). Now HONORED — `Cache.stats`
  filters both the entries aggregate and the runs 24h aggregate — and an
  unhonorable scope is a `UserError` at the boundary, never a silent lie.
  (2) **`LocalHistoryProvider` and `metrics.getHistory` reached OPPOSITE
  verdicts on identical rows.** metrics implements the project's rule
  (flakiness needs a NONDETERMINISM signal — a within-run retry, or one cache
  key that both failed AND succeeded); history.ts still used the pre-rule
  `failures < total/5` heuristic and had no retry signal at all, so five
  failures on five DISTINCT keys read `stable` on one surface and `flaky-fatal`
  on the other — and history.ts is what `vx mcp` hands an AI agent, which is
  precisely how an agent gets told to bolt `exec.retries` onto a deterministic
  break. Fixed STRUCTURALLY: new `orchestrator/failure-mode.ts` owns the rule
  and both call it, so they cannot fork again. **A pre-existing test ENCODED
  the defect** (asserting `flaky-recoverable` on 6 distinct keys) and now
  asserts `stable` — the honest verdict. **The rest:** `getRunTrends` /
  `getStorageGrowth` densify loops were unclamped (`{from:0,to:1e15}` → 45s
  timeout, an earlier probe OOM-killed) — the cloud's 2026-07-14
  `MAX_TREND_BUCKETS` fix, never backported to core even though both are
  public façade exports embedders build on; `getRunHeatmap(days)` clamped in
  the same pass (flagged, not in the original eight); `getCacheSavings.
hitsLast24h` counted only hits with a local baseline, so it disagreed with
  BOTH sibling counters (7/7/**3**) — exactly the fresh-CI-runner shape where
  savings matter most — now counts all hits with the priceable subset exposed
  separately; `getHistory`'s `SELECT DISTINCT` + JS `.slice(limit)` returned
  the ALPHABETICAL prefix and dropped the most-recently-run task (fixed in
  core AND the identical cloud copy, whose comment claimed the order was
  deliberate); markdown report cells were unescaped so a task name containing
  `|` or a newline broke the GHA step-summary table; a non-integer MCP `limit`
  threw an opaque `-32603 datatype mismatch` (missing the `Math.floor` its
  sibling `clampInt` has — `clampInt` moved to the `util` leaf rather than
  exported from metrics, which would have weakened the metrics drift guard's
  "every export executes against a fresh cache.db" contract). Gates: fmt/lint
  0, core **1297/0** (+11), cloud 581/0, ui 91/0. NO CACHE_VERSION/SCHEMA bump
  (key derivation + artifact bytes untouched; `CacheStats` and `CacheLayer.
stats` gained additive fields only). **Process note:** the agent's own gate
  run showed cloud/ui red — its WORKTREE has no `packages/cloud/ui/
node_modules`, so `solid-js` was unresolvable there. Re-run in the main tree,
  both are green. A gate result is only as good as the tree it ran in.

- **2026-07-26**: **The workspace context rides the URL — a shared link carries
  its scope** (closing the caveat the sidebar-context wave named). Stored only
  in localStorage, `/runs/:id` opened against the RECIPIENT's workspace and
  silently showed them different data than the link meant. **Design — the URL
  is a MIRROR plus an INBOUND override, NOT a threaded param:** the signal
  stays the source of truth for fetching (`scopedPathFor` already appends
  `?ws=`, `getConnectionKey` already includes it), and ONE effect in the Shell
  adopts `?ws=` on load and replace-navigates to re-add it after any navigation
  that dropped it. Threading the param through every `<A href>`, `navigate()`
  and `_href` data string would have touched a dozen sites and GUARANTEED a
  missed one; this way no link site knows the workspace exists. `replace`
  throughout, so the mirror adds no history entry and Back still works, and
  every other param survives (`?window=`, `?task=`, the Runs facets — losing
  those while fixing a different deep link would be a regression, not a
  tradeoff; pinned). **The honest failure state is the point:** a link naming a
  workspace the account cannot see falls back AND says so in a banner, because
  falling back silently shows data the link did not mean — the exact bug the
  mechanism exists to prevent — just relocated. **A self-pin the first cut
  introduced and the tests caught:** the mirror wrote the default into the URL,
  the adopt branch then read it back and PERSISTED it, so merely visiting
  turned "let the server pick" into a choice the user never made; the adopt
  branch now compares against the EFFECTIVE scope, not the stored one, so only
  a genuine inbound override pins. Pinned by 5 browser cases (mirror, link
  beats local pref, scope survives an internal link that knows nothing about
  it, existing params preserved, denied workspace falls back + warns).
  **Test-infra, two real fixes:** (1) the browser suites now close their own
  CONTEXT in teardown — with a shared browser, an open page keeps an SSE
  connection alive and `server.stop()` waits on it; (2) `bootPlatform.stop()`
  bounds the wait, because `server.stop()` force-closes the listener then
  awaits `db.close()`, which waits on the BACKGROUND `ensureIndexes` (CREATE
  INDEX CONCURRENTLY per partition) — slow enough on the shared cluster by the
  late suites to blow the hook timeout, strand the shared browser and fail
  every browser suite after it. A test needn't wait for an index it never
  queries. Cloud suite **580/0 in 100s**. Also: the suite's own `freshLoad`
  raced the mirror (a hash-only `goto` doesn't reload, so the app rewrote the
  address before `reload()` read it) — it now stamps the exact target with
  `history.replaceState` first. NO schema/wire/CACHE bump (UI + test infra).

- **2026-07-26**: **The table filter boxes search the WHOLE workspace, not the
  fetched page** (the last open piece of the 1000-project / 10k-task scale
  directive; the Projects table's "showing N of M" Callout was the honest
  placeholder this replaces). Every list read answers a PAGE, so a box that
  filters the fetched rows can never reach a tail project or task — only the
  server can. New shared `searchFilter(sql, term, 'project' | 'pair')` emits a
  parameterized `ILIKE %term%` (or nothing), threaded through `getHistory`'s
  three scans + `mixedOutcomeKeyCounts` and reused by `listProjects` (whose
  hand-rolled clause it replaces, so the two can't drift). `pair` matches
  `project || '#' || task`, so ONE box serves "orders", "build" and
  "orders#build" alike. **Client:** `DataTable` gains an opt-in `searchParam` —
  the box debounces 250ms into a URL param (`replace`, so typing never buries
  the previous page in history), seeds itself FROM the URL (a shared or
  reloaded link restores the search and the box agrees with the rows the server
  narrowed), and adopts an externally-changed param (back/forward) — but never
  while a keystroke is still owed to the URL, or typing fights itself. **Local
  filtering deliberately stays layered on top**: these tables join CATALOG rows
  (never-run projects/tasks) the server never saw, so dropping it would leave
  those unfilterable. Tables without `searchParam` are untouched. Projects
  dropped `dir` from `filterFrom` so local and server narrow on the same field.
  Gates: fmt/lint 0, cloud 575/0, core 1286/0, ui 91/0, visual 10/10 (no pixel
  change). NO schema/wire/CACHE bump (read-side + an additive query param).

- **2026-07-26**: **The WORKSPACE is the context, so it lives where context
  lives — sidebar top, always stated** (owner: "Vx cloud should support
  multiple workspaces. Now it shows just one. I should be able select context
  as workspace"). **Measured first, and the mechanism was already sound:** a
  probe booting the real platform and ingesting under TWO client workspace ids
  proved `/v1/workspaces` lists both, `resolveReadWorkspace` validates `?ws=`
  against the org, and a scoped read returns exactly that workspace's rows —
  the schema (`workspaces` UNIQUE(org_id, slug)), the routes, and the `?ws=`
  clamp all supported multi-workspace from the platform pivot. **The failure
  was entirely presentation, and it was severe:** the switcher was
  `<Show when={list().length > 1}>` — the FOURTH of five near-identical grey
  chips in the top-right corner, next to the org chip and the server badge —
  so at one workspace it did not exist at all (no name, no hint that a second
  repo would ever add one), and at two it read as decoration rather than as
  the scope of every row on screen. **Fixed by promoting it to what it is:** a
  `ContextPicker` block at the TOP OF THE SIDEBAR stacking organization over
  workspace (the Vercel/Linear/GitHub shape), both corner chips removed. It
  renders at 0 workspaces ("No workspace yet" + a dropdown explaining that one
  is provisioned on the first CI push — the server clamps a workspace-less org
  to the nil uuid, so every page is empty BY CONSTRUCTION and only this row can
  say why), at 1 (named plainly — the scope is never implicit), and at N (name
  - "N workspaces"). **A second, real bug the probe exposed:**
    `refreshWorkspaces` latched `workspacesKey` BEFORE its `authState !== 'authed'`
    bail and before the fetch resolved, and the key is
    `origin|org|userId` — which never changes after sign-in. So one unauthed or
    failed attempt memoized an empty list for the LIFE OF THE TAB: a workspace
    created after you opened the dashboard could never appear. Now the key is set
    only on a resolved list (a sequence counter keeps concurrent requests from
    clobbering each other), and the picker forces a refresh when OPENED — opening
    it is precisely the intent to know what exists, which beats polling. Pinned by
    a new `tests/workspace-context.test.ts` driving the real dashboard in real
    Chromium across 0 → 1 → 2 workspaces and a switch that must rescope the DATA,
    not just the label; **differentially verified — 4 of its 5 cases fail on the
    pre-change build**. Every other suite seeds ONE workspaceId, which is exactly
    why this went unnoticed. **Test-infra fix bundled** (the new suite made a
    latent flake reproducible): the visual suite navigated between shots with
    `page.goto` to URLs differing only in the HASH — a same-document navigation,
    so the `load` event it waits for never fires again; in isolation it resolved,
    under a loaded full-suite run it hung until the test timed out AND stranded
    the browser for the next suite. It now drives `location.hash` directly, and
    all three browser suites got explicit boot/teardown hook timeouts (a hook
    that times out is what leaks the Chromium). Baselines refreshed (= the docs
    screenshots). NO schema/wire/CACHE bump (UI + a client-side memo fix).
    **Known gap, named not fixed:** the selection lives in localStorage only, so
    a shared `/runs/:id` link opens against the RECIPIENT's workspace — making
    the context URL-addressable means threading it through every internal link,
    a wave of its own. **Test-infra win bundled:** the three browser suites now
    share ONE process-wide Chromium (`helpers/playwright.ts sharedBrowser`) —
    `bun test` runs the package in a single process, so a browser per suite meant
    three live Chromiums plus three platforms on a small box and the third launch
    reliably killed one of the others ("Target page, context or browser has been
    closed" in a suite that passes alone). Isolation lives at the CONTEXT level,
    which is all these suites need. The cloud suite went 424s/9-fail → **84s/
    566-pass**.

- **2026-07-26**: **"Got slower" is KEY-AWARE — a same-key slowdown is
  environment, never changed work** (the inconsistency the least-stable card
  exposed on its first render: `orders#build` read **±58.8% margin AND "3.0×
  slower" at the same time**, both computed across the SAME cache key — so
  the card blamed the code for a number the card beside it called noise).
  `detectSlowdowns` now consumes each run's `hash` and classifies the slow
  run three ways: **same inputs** (its key was already seen among the task's
  earlier executions ⇒ identical inputs ⇒ the extra time is the machine,
  contention or the task's own variance), **inputs changed** (a new key AND
  ≥1 earlier keyed execution to compare against — the only state that earns
  the danger dot), and **no earlier run** (no keyed prior execution in the
  window ⇒ NO evidence either way ⇒ the row must not claim the inputs
  changed; the honest third state the first cut lacked, which would have
  labeled a lone execution "inputs changed" on zero evidence). **The
  sharper half is a suppression:** a same-key run whose duration was
  ALREADY OBSERVED for those exact inputs (`durationMs <= priorWorst`) is
  dropped entirely — that is the task's known spread, and reporting it as
  "got slower" is reporting noise as news. Verified in the visual guard on
  a seeded platform: `orders#build` DISAPPEARS from Got slower (its 1500ms
  had happened before on the same key) and now appears only where it
  belongs — top of Least stable tasks at ±58.8% — while `checkout#build`
  (2.6×) and `payments#build` (2.0×) stay listed with a new **Cause**
  column reading "same inputs — environment" and a faint dot instead of
  danger red. Pinned by 6 unit cases (new key attributes to changed work,
  same key blames environment + reports `priorWorst`, already-seen duration
  is suppressed, hash-less rows degrade to the old behavior with cause
  "no earlier run", a lone executed run claims nothing). Gates: fmt/lint 0,
  cloud 561/0, core 1286/0, ui 87/0; the insights baseline (= the docs
  screenshot) refreshed and re-verified byte-stable. NO schema/wire/CACHE
  bump (client-side derivation over `hash`, which `/v1/runs` already
  returned).

- **2026-07-26**: **Deltas are judged against MEASURED noise, not a guessed
  threshold** (the follow-on the stability metric existed to enable). The
  `deltaBar` flat band was `max(5ms, 0.5% of the A-side)` — a number picked by
  hand. Now each row carries the task's own measured same-key spread: new
  batched `getStabilityFloors(ws, {sinceDays})` (ONE grouped query — a per-row
  lookup would be an N+1 across a 500-row diff) returns `median(stddev/mean)`
  per `(project, task)` over keys that ran ≥2 times; `compareRuns` threads it
  onto each row as `noiseCv`, the client converts to `_noiseMs` against the
  A-side duration, and the cell's `noiseKey` prefers it over the heuristic —
  falling back ONLY when nothing repeated often enough to measure, rather than
  inventing a floor. So "is this delta real?" is answered by that task's own
  variance. **Also shipped:** `getLeastStableTasks` + `/v1/stability/least`
  and an Insights **"Least stable tasks"** card (runs · typical · ±margin ·
  a ±1σ meter), because an unstable task makes every comparison involving it
  unreliable and that should be discoverable, not per-task spelunking.
  **An inconsistency the new card immediately exposed (recorded, not yet
  fixed):** on the seeded fixture `orders#build` reads ±58.8% margin AND
  appears in "Got slower" at 3.0× — both measured across the SAME cache key.
  By the owner's own principle that makes the "slowdown" unattributable to any
  input change: `detectSlowdowns` compares latest-vs-p50 with no key awareness,
  so it cannot distinguish "the work changed" from "this task is just noisy".
  The honest fix is to make that detector key-aware (or to state the margin
  beside its ratio) — queued. Pinned: a compare row across DIFFERENT keys
  carries a measured `noiseCv` > 5% and a 40ms delta that is provably inside
  it; the ranking puts a jittery task (200/1400/300/1200 on one key) above a
  steady one (500/505/495/500) and EXCLUDES a task that never repeated a key.
  Gates: fmt/lint 0 (from the ROOT — running oxlint inside packages/cloud
  reports phantom errors because the ignore patterns are root-relative), cloud
  556/0, core 1286/0; insights baseline refreshed. NO schema/CACHE bump.

- **2026-07-26**: **Task stability — the same-key margin of error, and why it
  is NOT a regression** (owner: "if the same task with the same key has been
  executed multiple times I want to know what's the computation range… This is
  different from regression as regression should be based on different keys.
  Same keys it's just a margin of error"). The insight vx is uniquely able to
  act on: it knows the CACHE KEY, so it can partition duration measurements by
  inputs. Same key ⇒ identical inputs ⇒ every millisecond of spread is
  environmental noise (machine, contention, I/O, wall-clock), never a
  performance change. New `Analytics.getTaskStability(ws, project, task,
{sinceDays, limit})` — one grouped query over EXECUTED successes only (a
  cache hit measures a restore, a failure measures when it gave up), grouped by
  hash with `HAVING count(*) >= 2`: per key `min/max/p50/mean/stddev_samp` and
  `cv = stddev/mean`; per task the MEDIAN and WORST cv plus the median relative
  `(max-min)/p50`. A key that ran ONCE is excluded rather than reported as
  perfectly stable — that would be a lie by omission. Route `GET
/v1/stability?project=&task=&sinceDays=` (both required → 400, allowlisted).
  **UI:** a "Stability (same cache key)" card on task detail — typical/widest
  ±1σ, the min→max range, "N executions of K identical input sets", and a
  per-key table (runs, typical, min–max, std dev, a ±1σ meter). **And the
  connection the owner drew explicitly:** the Compare view's `deltaBar` gained
  `neutralKey`, so a row whose cache key is UNCHANGED renders its magnitude in
  neutral ink and passes NO verdict — identical inputs cannot regress, so
  coloring that delta red was the tool asserting something it cannot know.
  **A labeling error the browser review caught:** the first cut printed
  `cv/2` as "±8.4%" while the same card's table showed 17% — one standard
  deviation IS ±cv, so halving understated the real margin of error; fixed and
  the column relabeled ±1σ. Pinned: a tight key (100/104/108) vs a volatile one
  (100 vs 900 on identical inputs) rank correctly by cv, a single-execution key
  is excluded, and a cache hit + a failure on a measured key are excluded from
  `samples`; plus a nothing-measurable task and the route's 400. Gates:
  fmt/lint 0, cloud 554/0, core 1286/0; baseline refreshed (docs screenshot
  now shows the card). NO schema/CACHE bump (read-side + additive route).
  **Follow-on worth building:** feed the deltaBar's flat band from the task's
  MEASURED stability instead of the fixed `max(5ms, 0.5%)` heuristic, and rank
  least-stable tasks on Insights.

- **2026-07-26**: **Scale wave 2 — the remaining fetch-a-page-then-find sources
  become point lookups** (finishing the owner's 1000-project / 10k-task
  directive; wave 1 fixed the blank project page + the lying rank). Three
  sources still degraded silently at scale, each now server-side: (1)
  **`getFlakiestTasks(ws, {project, task})`** — the task-detail flaky badge AND
  the Recommendations card both did `getFlakiest(100).find(...)`, so a
  genuinely flaky task ranked below the top 100 lost its badge and its
  `exec.retries` suggestion on a 10k-task workspace; the pair clamp threads
  through all three scans in the method (candidates, the windowed durations,
  and `mixedOutcomeKeyCounts`) so the point lookup is one narrow query, not a
  filtered full scan. Route: `/v1/flakiness?project=&task=`. (2)
  **`listRuns({hash})`** — the cache-entry provenance page pulled 1000 runs and
  matched the hash in the client, missing every older run past that page;
  filtered in SQL now (`/v1/runs?hash=`). (3) The recommendations aggregator
  drops its top-100 dependency with it. Pinned: a flaky task buried behind 40
  noisier pairs resolves by point lookup (and a foreign pair returns empty, so
  the clamp is a clamp); the wanted cache-entry run is seeded as the OLDEST of
  31 so a page-then-filter implementation provably misses it. Visual guard
  10/10 (no surface changed). Gates: fmt/lint 0, cloud 552/0, core 1286/0. NO
  schema/CACHE bump (read-side + additive query params). **Still open:** the
  table filter boxes remain client-side over the fetched page — the Projects
  table now states "showing N of M" so the truncation is honest, but wiring
  the box to the server's ILIKE search (debounced, through the loader params
  the way `?window` already flows) is the last presentation piece.

- **2026-07-26**: **Scale correctness — a 1000-project workspace no longer
  renders empty pages or lies about rank** (owner: "you need to design for
  workspaces with 1000 projects and 10k tasks. The ui should handle that and
  be presented in useful way"). **Measured first**: a probe seeding 1000
  projects × 10 tasks (100k task_runs) through the real ingest wire proved the
  failure is CORRECTNESS, not latency — `/v1/projects?limit=500` returns a
  PAGE, and three dashboard sources did `fetch a page → .find()` in it, so
  (a) **every project past the page rendered a blank detail page**
  (`projectSummary` found nothing), (b) the ranking card claimed **"vs 500
  projects"** when there were 1000 and ranked within the page, and (c) the
  Projects table's filter box could never reach a tail project (it filters
  the fetched rows). Payloads were fine (103 KB / 143 ms for 500 projects) —
  the data was simply wrong. **Fixed server-side, which is the only place it
  can be right:** `listProjects(ws, {limit, search, projects})` gains
  server-side ILIKE search + exact-name fetch (the point lookup);
  `countProjects` is the true denominator; new `rankProject(ws, project)`
  computes per-axis ranks with WINDOW FUNCTIONS over EVERY project in one
  query and returns top-N per axis PLUS the named project with its true rank,
  so both the rank and the total are correct at any size. `/v1/projects` now
  answers `{projects, total}`; new `/v1/projects/rank` (allowlisted). The
  client's `rankProjects` helper — which did the in-page ranking — is
  replaced by a thin shaper. The Projects table states
  "showing N of M projects" when truncated instead of implying the page is
  the workspace. **The guard caught a bug in the fix itself**: `= ANY($1)`
  binds a JS array as a malformed array literal on this driver (`IN
${sql(array)}` is the form — the `provenanceForHashes` precedent), which
  would have 500'd the point-lookup route in production. Pinned by a scale
  test seeding 620 projects (past the page): the tail project resolves by
  exact fetch AND by search, ranks #1 by avg exec with `total === 620`, and a
  mid-pack project reports a true rank > 8. Wire pinned in server e2e.
  Visual guard 10/10 — the ranking card renders identically off the new
  source, a free functional-equivalence check. Gates: fmt/lint 0, cloud
  550/0, core 1286/0. NO schema/CACHE bump (read-side + additive route).
  **Still open for the presentation half:** server-side search wired into the
  Projects/Tasks table filter boxes (today the box filters the fetched page
  and the notice tells the truth about it), and a tasks-list point lookup for
  the flaky badge (`getFlakiest(100).find()` degrades for a task outside the
  top 100 — degraded, not broken).

- **2026-07-26**: **Design-port wave 2 — Callout, honest delta bars, the
  ranking card's missing axis, status-as-badge** (continuing the astryx
  directives on the shipping UI; the FIRST wave shipped under the new visual
  guard, which reported exactly the three touched pages and left the other six
  pixel-identical — the pipeline paying for itself on its first real use).
  (1) **`Callout`** — one banner primitive (warn/info/muted + icon) replacing
  five hand-rolled class strings across overview/projects/taskDetail/cache;
  drift is now impossible. (2) **`deltaBar` column kind** — a signed delta
  reads as a DIVERGING bar around a shared zero (faster grows left green,
  slower right red) with a **flat band** (`max(5ms, 0.5% of the A-side)`), so
  trivial noise renders neutral instead of the full danger red the old
  dot+text gave every non-zero delta; the diverging scale is shared across
  rows so +2s and −2s read equal. **A defect the browser review caught before
  landing:** the first cut mapped a task present in only ONE run to
  `deltaMs: 0`, so "new" read as "no change" — now NaN + a `labelKey`
  fallback preserves new/only-in-prev. New `signedDuration` format hint.
  (3) **Ranking card** — `rankProjects` had computed `byHitRate` since
  2026-07-15 with NO view rendering it (the decision log claimed three axes
  shipped; two did). Third axis added, and all three RankLists gained
  `barFrom` meters — rates ride a 0..1 track so a 3% failure rate renders as
  3%, never a full bar. (4) **`status` FactField kind** → the shared
  StatusBadge, so run-detail's selected-task facts stop rendering an outcome
  as bare text. Gates: fmt/lint 0, cloud 549/0, core 1286/0; baselines
  refreshed (which refreshed the docs screenshots). **Wave 3 (queued):**
  PageHeader unification, Card-language unify on the Runs strips, Metric
  delta chips, Flamegraph label ident hues, deltaBar on movers + the project
  Δavg column. NO schema/wire/CACHE bump (UI only).

- **2026-07-26**: **Visual-regression snapshots ARE the docs screenshots — one
  pipeline, two jobs** (owner: "Make sure our playwright tests also do
  snapshots for visual regressions and we use those for docs automatically").
  New `packages/cloud/tests/visual.test.ts` drives the REAL dashboard (built
  SPA + real platform on ephemeral Postgres + fake S3, seeded through the real
  `/v1/ingest` wire) in a REAL Chromium across the 9 documented surfaces, and
  compares each capture against the committed baseline — where the baseline IS
  the image the docs site embeds (`apps/docs/src/assets/screenshots/<name>.png`,
  the exact 9 files the cloud docs already reference). So a UI change either
  fails as a visual regression or is accepted with `VX_UPDATE_SNAPSHOTS=1`,
  which rewrites the baselines and therefore the docs screenshots IN THE SAME
  COMMIT — docs screenshots can no longer silently rot behind the product.
  **Determinism is the whole design**: the seed is anchored to a FIXED epoch
  (18 days of history + 5 same-day runs + a featured run with staggered
  per-task wallclock so the flamegraph shows real parallelism), the browser
  clock is FROZEN to that instant via `addInitScript` (so "2h ago" renders
  identically forever), animations/transitions are disabled before the
  shutter, and the shutter itself fires only when two consecutive captures are
  byte-identical (`stableShot` — a measurement, not a magic timeout; 3
  consecutive full-suite runs 549/0 after adopting it). Comparison is
  **dependency-free**: `tests/helpers/png.ts` hand-rolls the PNG reader
  (IHDR/IDAT + node:zlib inflate + the 5 unfilters incl. Paeth, expanded to
  RGBA) and a per-channel-tolerance differ — the `tar.ts`/`sigv4.ts` precedent;
  ~100ms per 3200x2000 image. **Differentially verified**: padding
  `p-6`→`p-10` on the shell reds 5 shots at 8-11% of pixels with the capture
  parked in tmp for eyeballing; reverted → green. **Two real defects found by
  building it.** (1) **`box-sizing` was never reset** — the UnoCSS preflight
  lacked the universal border-box rule, so every padded full-width element
  overflowed by exactly its padding: `scrollWidth` 1648 vs `clientWidth` 1600
  on EVERY dashboard page (a permanent horizontal scrollbar, and the reason
  the old screenshots clipped their right-hand column). Fixed in the preflight;
  measured 1600/1600 after. (2) **The committed perf guard was silently
  SKIPPING** — `bun test` doesn't consult NODE_PATH and this container's
  playwright is a global install, so `ui-perf.test.ts` had been resolving
  nothing and skipping for its whole life. New shared
  `tests/helpers/playwright.ts` (env override → NODE_PATH → conventional
  global prefixes, importing the package DIRECTORY so node resolution is
  bypassed entirely) now serves both suites; the perf guard runs here for the
  first time (5 pass). Skips remain honest: no browser or no built SPA → skip,
  never fail (CI has neither, so it skips there exactly like the perf guard).
  Baselines are environment-pinned (a different font set renders different
  text pixels) — documented in the suite header and in a new
  `apps/docs/src/assets/screenshots/README.md` placed where someone would try
  to hand-replace an image. **Gotcha recurrence:** the box-sizing fix's first
  comment contained backticks INSIDE the uno preflight template literal and
  broke the build — the same class as the 2026-07-17 SQL-comment backtick
  note. Never put a backtick in a comment that lives inside a template
  literal. Gates: fmt/lint 0, cloud 549/0 (3x), core 1286/0, docs site builds
  clean on the regenerated images. NO schema/wire/CACHE bump (test infra + one
  CSS reset rule).

- **2026-07-25**: **Design-port wave 1 — identity colors, honest dots, chart
  legends, rate meters** (executing the standing astryx design directives on
  the SHIPPING Solid UI; driven by a 12-item ranked design-consistency audit
  vs the parked `ui-astryx` reference). (1) **Identity colors exist now**:
  `--ident-0..5` (the astryx cool violet→teal set) + `--ident-task` (fixed
  pink) in uno.config.ts — deliberately OUTSIDE the status palette so an id
  can never read as an outcome (the audit found the old `paletteFor` chart
  hues COLLIDE with warn/success — an identity dot could render in exactly
  the warn yellow). `identFor`/`identTextClass`/`IDENT_TASK_TEXT` in
  format.ts (literal class maps + safelist — format.ts is not
  UnoCSS-scanned); applied to the `projtask` cell, the `dots` cell's
  `project#task` values, RunGraph card labels, and the pinned-projects
  strip (dot + hued name); tasks.json's identity dot repointed
  `palette`→`ident`. (2) **Status colors are ONLY for status**: new `ci` +
  `heat` DotMaps — a LOCAL run's CI dot was rendered through the
  `failureMode` map as DANGER RED (browser-confirmed pre-fix), now
  info/faint; cache heat cold=faint (a fact, not a failure), stale=warn.
  (3) **Persistent legends** on multi-series LineCharts (component-level,
  swatch+name; the color-key `actionText` stand-ins removed). (4) **Rate
  cells are meters**: Success/Hit% columns switched to the bar kind with a
  new `col.max` pin (rates pin 1 — auto-max would render a 40% best row as
  a full track). Safelist swept: dead text-chart-_/border-chart-_/
  fill-chart-N-10 dropped, ident classes added. Browser-verified 6/6 on a
  seeded platform (no danger dot on a local run, hued project + pink task,
  9 bar tracks, legend visible; zero console errors); identFor pinned
  (stable, ≥4-way spread). **Wave 2 (queued, from the audit):** PageHeader
  unification, Callout component, Card-language unify on Runs, status-badge
  Facts kind, ranking-card hit-rate axis + bars, deltaBar kind, Metric
  delta chips, Flamegraph label hues + Treemap/colorFrom ident repoint. NO
  schema/wire/CACHE bump (UI + theme only).

- **2026-07-25**: **Adversarial review of the six scenario waves (#156-#162) —
  five confirmed defects fixed, everything else REFUTED by executed repro**
  (the house-standard repro-mandated hostile reviewer over triageRun,
  fetchTriage/triageMarker, predictPlan, getFlakeTrend, failingProjects +
  mine-first, flamegraph-layout/detectSlowdowns/foldFlakeTrend). **Fixed (one
  commit, each with a discriminating pin):** (1) **MED — `triageRun` was not
  re-push-safe**: a re-pushed summary duplicates the task_runs ROWS too (the
  idempotency key shifts with startedAt), so one failed task returned TWO
  TriageRows and the prev-run LATERAL picked the run's OWN earlier copy —
  `previousRunId` = the run itself with a wrong `keyChanged: false` (the GHA
  marker then flip-flopped nondeterministically on the unordered tie). Fix:
  `DISTINCT ON (project, task) … ORDER BY … started_at ASC` (earliest-copy
  convention) + `run_id <>` in the prev LATERAL; the misleading "EXISTS makes
  re-push harmless" comment corrected (it protected only the trunk signal).
  (2) **MED — empty-hash false flaky**: `insertTaskRun` stores `hash ?? ''`
  and the same_key subquery had no `hash <> ''` guard (unlike its two
  siblings), so a hashless success + hashless failure fabricated
  `verdict: 'flaky'` — which, having precedence, could also mask a genuine
  pre-existing verdict. Fix: the SQL guard + `keyChanged: null` when either
  side's hash is '' (no key evidence). (3) **LOW — literal `undefined` in the
  job summary**: `fetchTriage` casts the body unvalidated and `triageMarker`'s
  switch had no default, so an unknown future verdict string rendered
  `❌ failed (exit 1)undefined`; default → ''. (4) **LOW — `getFlakeTrend`
  re-push double-count**: all four bucket counts became
  `COUNT(DISTINCT run_id) FILTER` (one run = one data point; a cross-day
  re-push still splits buckets — accepted, documented in the query). (5)
  **LOW, pre-existing — a re-pushed broken run appeared TWICE in the
  notification bell**: `getNotifications` now wraps in `DISTINCT ON (run_id)`
  earliest-header. **Refuted by executed repro (held):** fetchTriage timer
  hygiene (process exits 65ms after flush; the clearable-timer rule holds on
  success/non-200/throw) + malformed-body degradation + green-run-zero-GETs;
  triageRun tenant clamp / precedence / own-run exclusion / null
  default_branch; predictPlan diamond wall-vs-work + 60k-deep chain (no
  recursion) + throwing-history fail-open; getFlakeTrend failed-retries
  exclusion, hit-as-pass, cross-day pairing, bucket boundaries, tenant clamp;
  notifications json_agg(DISTINCT) dedupe + Shell mine-first reactivity;
  flamegraph durations-mode detection edges (n=1, all-zero, parallel stays
  timeline); detectSlowdowns exact-2.0×/+100ms boundaries + recovered-task
  unflag; foldFlakeTrend clock-skew safety. **Follow-up sweep (landed same
  day):** `whyRunReran`/`whyDidThisRerun`/`cacheKeyDiff` — the pre-wave
  same-class trio — now share the earliest-copy-anchor + `run_id <>`
  convention (a re-pushed run's "previous" could be its own duplicate copy,
  rendering "ran without a cache hit" where the truth was "inputs changed");
  one differential-verified pin covers all three. Gates: fmt/lint 0, cloud 539/0 (+5 pins),
  core 1286/0. NO schema/wire/CACHE bump (query-shape only).

- **2026-07-25**: **Scenario-driven wave 6 — the Flakiness-trend card closes
  the dev-scenarios ranked list 7-for-7** (S4's minor gap: "is the flake
  getting better or worse, when did it first appear?"). New
  `Analytics.getFlakeTrend(ws, project, task, {sinceDays})` — ONE query: a
  window CTE over the task's rows + a per-hash `BOOL_OR(pass)` CTE, bucketed
  per day, counting `retried` (successes with `attempts > 1` — a FAILED run's
  retries never count: a deterministic failure retried N times is not flake
  evidence) and `mixedFailures` (failures whose key ALSO passed in the
  window — a hit counts as a pass, the `mixedOutcomeKeys` rule; a
  unique-key failure is a break and never counts), plus per-bucket
  MIN/MAX episode timestamps so `firstSeenAt`/`lastSeenAt` are exact ms.
  Both sides of the pairing are window-scoped (partition-pruned; "first
  seen" honestly means within-window). Route `GET
/v1/flake-trend?project=&task=&sinceDays=` (both required → 400,
  `MAX_WINDOW_DAYS` clamp) + the `isAnalyticsSurface` allowlist (the
  fall-through-to-SPA class, pinned in server e2e). **UI:** task detail
  gains a "Flakiness trend" card under the flaky badge — Facts (first
  seen, last episode, episodes, worsening/improving/steady) + a per-day
  LineChart; `foldFlakeTrend` (jr/functions.ts, unit-pinned 4 ways) fills
  gap days with 0 (a sparse series would lie about quiet stretches) and
  derives direction from window halves; the source resolves null on a
  healthy task / older serve / fetch error so the card hides. Pinned:
  analytics matrix (bucket counts incl. hit-as-pass + failed-retries-not-
  retried + pure-break exclusion, exact first/last ms, hostile-window
  clamp, foreign-ws + same-ws-different-task decoys with the +1ms
  idempotency-index offset), healthy-task nulls, server allowlist + 400.
  Browser-verified on a seeded platform: flaky task renders card + chart +
  "worsening" while the healthy control shows no card; zero console
  errors. Docs: cloud/api.md route row + dashboard.md task-detail bullet;
  the scenarios doc marks #4-#6 shipped. NO schema/wire/CACHE bump
  (read-side only). The dev-scenarios ranked list is now fully shipped.

- **2026-07-24**: **Scenario-driven wave 5 — triage verdicts on the GHA
  check/job summary** (dev-scenarios S3 follow-up, ranked #5: the PR page
  answers "is this failure mine?" without opening the dashboard). At flush,
  a CONNECTED red run GETs `/v1/triage/:runId` (AFTER the summary ingest so
  the rows exist server-side; bearer; 5s CLEARABLE timer — never
  AbortSignal.timeout, the house rule) and threads the verdict map through
  `GithubSummaryOptions.triage` into BOTH GitHub surfaces (the job summary
  and the Checks-API check share `formatGithubSummary`): failed rows gain
  `🎲 flaky — not this change (same key passed N×)` / `📌 already broken on
the default branch` / `🆕 new failure[ — this run changed its inputs]`.
  Only failed rows consult the map (a nonsensical verdict for a green task
  never renders — pinned). NEVER-FAIL + additive: no connection, non-200,
  malformed, timeout, or a green run → byte-identical output to before
  (pinned by the no-map case + a 500-triage plugin e2e); the fetch fires
  only when `failedCount > 0` AND a GitHub surface is active. Tests: 3
  formatter cases + 2 plugin e2e over fake servers (verdict lands in the
  written GHA summary with the bearer on the triage GET; a triage 500
  leaves plain rows). Docs: guides/ci.md PR-checks section + cloud/api.md
  route row name the consumer. NO schema/wire/CACHE bump. The dev-scenarios
  ranked list is now 5-for-6 shipped; remaining: flake trend (ranked low).

- **2026-07-24**: **Scenario-driven wave 4 — plan-time duration prediction on
  `vx run --dry`** (dev-scenarios S2, ranked #4: "what will this change cost
  CI?"). The plan predicted WHAT runs but never HOW LONG. Now `PlannedTask`
  gains `p50Ms` (the task's typical executed duration — the SAME
  `LocalHistoryProvider` p50 the opt-in predictive scheduler reads) and
  `RunPlan.predicted = { wallMs, workMs, unknownCount }`: `wallMs` is the
  longest dependency chain of would-run cost via one pass over a Kahn topo
  order (NO recursion — a deep chain must not overflow; the CORE-1 lesson),
  `workMs` the sum; hits + groups cost 0 (a restore is near-instant next to
  execution), a would-run task with no history costs 0 and is COUNTED
  (`unknownCount`) so the totals are honest lower bounds. `planRun` injects
  the provider (`prepared.localCache.dbHandle()`); `plan()` takes it as an
  optional `history` arg and FAILS OPEN (a history error yields a plan
  without prediction — `--dry` never breaks). The 2026-07-14 lookahead
  verdict ("don't put the ~280ms loadFor on the DEFAULT run path") is
  respected: the read rides ONLY the explicit `--dry` inspection command.
  Text output: `~p50` per would-run line + a `predicted: ~Xs wall · ~Ys
total execution [· N tasks without history (+?)]` footer, OMITTED when
  nothing would run or every would-run task is unknown (an all-noise
  prediction says nothing). JSON: additive `p50Ms` + `predicted`. Contract
  widening: `PlanPrediction` + `formatDuration` exported from
  orchestrator/index.ts (p50s come from SUCCESS runs only, so a
  failed-attempt history predicts nothing — observed live: the first
  recorded run failed and the plan stayed honest). Pinned: 4 formatter
  cases (eta on would-run only, footer, unknown note, both omissions) + a
  JSON fields case + a planRun e2e with RELATIONAL assertions only (wallMs
  = chain sum, workMs = total sum over the plan's own p50s — recorded
  durations vary with load, so absolute pins would flake). Docs: cli.md
  planning-mode section. NO CACHE/SCHEMA/wire bump (read-side presentation
  of existing history). Remaining from the ranked list: triage verdicts on
  the GHA check; flake trend.

- **2026-07-24**: **Scenario-driven wave 3 — the "Got slower" detector on
  Insights** (dev-scenarios S5, ranked #3). The shape-over-time surfaces were
  all passive (trends/movers/sparklines you must go read); this is the active
  nudge: a task whose LATEST executed run is ≥2× its OWN p50 (≥100ms absolute
  floor so millisecond noise never flags; cache hits + failures excluded on
  both sides — real work vs real work) surfaces on Insights beside movers,
  each row `typical → latest · N.N× slower · when`, linking to task detail.
  Pure client-side compose (`detectSlowdowns` in jr/functions.ts — ported
  from the parked astryx Attention page — over the getHistory p50s + the
  latest 300 run rows; no server change), unit-pinned 6 ways (ratio bar,
  absolute floor, hit/failure exclusion, newest-executed-wins so a RECOVERED
  task unflags, ratio-desc cap 8, no-p50 skip). Browser-verified on a seeded
  platform: a 3.1× spike renders with typical/latest durations while the
  healthy control task stays absent; zero console errors. Docs: dashboard.md
  Insights bullet; the scenarios doc's ranked list marks #2 and #3 shipped.
  Remaining from the list: `--dry` duration prediction; triage verdicts on
  the GHA check; flake trend.

- **2026-07-24**: **Scenario-driven wave 2 — pinned "my projects", the
  personal lens** (dev-scenarios S1, ranked #2; owner arc: "as a developer…
  owning some of the projects… what information do you need"). A dev owning 2
  of 1,800 projects can now STAR them: `ui/src/pins.ts` (module-scope signal
  over api.ts persistence, `vx-ui:pins:<origin>|<workspace>` — the
  notification-watermark pattern, this browser only). Affordances:
  `PinStarButton` (ui.tsx) beside the project-detail title (Page gains a
  `pinProject` prop), a `pin` DataTable column kind leading the Projects
  table, and in each strip chip. **The Runs landing gains a "My projects"
  strip**: one `/v1/branch-failures` probe per pin (bounded by pin count, 30s
  visibility-aware) → red "N failing · M branches" or green, each chip
  linking to the drill-in; zero pins renders a one-line hint at the star.
  **The bell floats runs that broke YOUR projects first**:
  `getNotifications` now returns `failingProjects` per run (a LATERAL
  json_agg over the run's failed task_runs — JSON, not a pg array, so the
  driver hands back string[]; workspace-clamped, decoy-pinned in
  analytics-read), and the client orders mine-first with a star mark
  (additive field — older serve → no reordering). **UnoCSS gotcha logged:**
  presetIcons rules set width/height but NO display, so an icon span outside
  a flex container collapses to 0×0 (every prior icon sat in a flex parent by
  luck) — PinStarButton is `inline-flex` with a comment saying why. Verified
  in a REAL browser end-to-end (star from table → drill-in star → strip
  failing state → bell mine-first with an OLDER pinned-project run floating
  above a newer foreign one → unpin returns the hint; zero console errors).
  NO schema/wire/CACHE bump (read-side additive). Remaining from the doc's
  ranked list: "got slower" on Insights, `--dry` duration prediction, triage
  verdicts on the GHA check.

- **2026-07-24**: **Flamegraph redesign — fitted, honest, readable** (owner:
  "The flame graphs are very unreadable and ugly"). Three root causes fixed in
  the shipping run-detail flame: (1) **the empty canvas** — RunViz wrapped both
  views in a fixed `h-[460px]` box, so a 3-lane run painted ~370px of dead
  surface; the flame now sizes to its lane count (`maxHeight` prop, scrolls
  past 460px; the graph view keeps its fixed canvas). (2) **the fabricated
  timeline** — an ingested run with no per-task wallclock anchors every task on
  the RUN's span, so the timeline drew N identical full-width bars (a lie).
  `layout()` now detects it (every span ≥97% of the window while the longest
  RECORDED duration is well short of it — a genuinely-parallel run keeps the
  timeline) and switches to `mode: 'durations'`: one lane per task, bars
  proportional to recorded duration, longest first, with a sticky "no per-task
  timeline recorded" note; dependency edges (meaningless off a timeline) are
  skipped. `LayoutInput` gains `durationMs` (the truth), `LayoutBar.durationMs`
  feeds labels. (3) **unreadable bars** — labels now carry `id · duration`,
  render INSIDE wide bars and OUTSIDE narrow ones (normal ink), with a greedy
  per-lane collision plan so a burst of instant cache hits shows one clean
  label instead of stacked soup (suppressed bars keep tooltips); recessive
  gridlines at the ticks; richer native tooltip (status + duration); axis 0
  reads `0` not `<1ms`. Verified in a REAL browser both ways (staggered
  wallclock run → timeline with critical-path ring; untimed run → ranked
  duration bars + note; zero console errors); layout pinned by 3 new unit
  tests (degenerate→durations with proportional widths, real-parallel stays
  timeline, staggered stays timeline). UI-only, no schema/wire change.

- **2026-07-24**: **Scenario-driven wave 1 — the dev-scenarios catalog + FAILURE
  TRIAGE on run detail ("is this failure mine?")** (owner: "create development
  scenarios… assess your or its effect, debug failures flakiness… then look for
  ideas and solutions and implement"). `docs/design/dev-scenarios-2026-07.md`
  walks eight real-life monorepo moments (morning triage, pre-flight cost, red
  PR, flake war, shape-over-time, rank-among-peers, cache hygiene, team lens),
  maps each to the data needed vs the shipping surfaces, and ranks the gaps.
  **#1 SHIPPED — batched failure triage:** `GET /v1/triage/:runId` classifies
  every FAILED task of a run in ONE query (`Analytics.triageRun`): `flaky`
  (the SAME cache key succeeded in other runs — nondeterminism, not this
  change), `pre-existing` (the default branch's LATEST run of the task is also
  failing — inherited; trunk-ness via an EXISTS against `invocations.branch =
default_branch`, never a row-multiplying join, so re-pushed duplicate headers
  can't skew it), or `new-failure` (first failure of this key; `keyChanged`
  from the why-panel's prev-run LATERAL says whether this run altered the
  inputs). Precedence: flaky beats pre-existing (nondeterminism evidence beats
  the inherited-break explanation — pinned). Run detail gains a "Failed-task
  triage" card (dots map `triage`: new-failure red / flaky amber / pre-existing
  accent; evidence sentence + a `see run` link to the trunk/previous run; the
  `runTriage` source resolves null on a no-failure run so the card hides).
  Allowlisted in `isAnalyticsSurface` (the fall-through-to-SPA class, pinned in
  server e2e). Verified: analytics-read triage matrix (5 verdicts incl. the
  precedence + a foreign-ws decoy at +1ms — the `(started_at, run_id, project,
task)` idempotency index is table-wide, a byte-identical decoy collides),
  server e2e 32 pass, REAL-browser check (platform + built SPA + Chromium via
  the ingest wire: all three verdicts + evidence render, zero console errors).
  Docs: cloud/api.md route row + dashboard.md run-detail card. NO
  schema/wire/CACHE bump (read-side only). **Ranked next (from the doc):**
  pinned "my projects" personal scope; the "got slower" detector on Insights;
  `--dry` duration prediction; triage verdicts on the GHA check.

- **2026-07-24**: **Two diverged arcs reconciled — the platform arc WINS the
  tree; the astryx dashboard rewrite is PARKED as the design-port target**
  (owner: "Fix it all", landing PR #155). A PR-branch session (fenced to
  `claude/bold-cannon-hmsma2` by its harness, unlike the usual push-to-main
  flow) spent July 20-24 rewriting the dashboard as a React 19 +
  `@astryxdesign/core` app (design library `page/viz/ident.tsx` + `brand.css`
  identity hues mirroring the CLI; UX per `docs/design/dashboard-ux-2026-07.md`)
  — while main pivoted vx-cloud into the self-hosted PLATFORM (Postgres,
  account-session auth + CSRF, org/workspace tenancy, no loopback exemption,
  `serve` verb removed) and evolved the Solid UI in parallel (41 commits:
  session auth shell, admin area, task logs, analytics, virtualization). The
  branch's serve-era work was superseded wholesale: its dist/\* multi-run
  scheduler had already landed on main (DIST_PROTOCOL v2 + distributed-review
  hardening), and its astryx SPA has NO login surface — it cannot authenticate
  against the platform server at all. Resolution: merge main with main winning
  every conflict; `packages/cloud/ui` (Solid) stays the shipping dashboard;
  the complete astryx app is parked at **`packages/cloud/ui-astryx/`** (NOT a
  workspace member, not built, oxlint/oxfmt-ignored, README states exactly
  what reactivation requires: auth shell, endpoint re-map to platform routes,
  admin/settings/task-log surfaces). Kept from the branch: the UX design doc,
  and the key-scoped flakiness signal (same cache key both failed AND
  succeeded = the definitional flake) re-applied onto main's `metrics.ts`
  beside its `within_run_retries` confirmed-flaky signal. **Standing intent:**
  the owner's design directives from the astryx arc (one design library, no
  per-page drift; identity colors — projects hued, tasks pink; visualize
  don't display) now apply TO the shipping platform UI as the ongoing port.

- **2026-07-19**: **The recurring ~40%-of-runs cloud-CI flake ROOT-FIXED — an
  advisory-lock KEY COLLISION deadlocked the first `/v1/auth/register` against
  the boot-time index build** (the "disjoint agents-e2e/server flake" documented
  three times this week as varying victims — `agents-e2e reassign`, then
  `tenant-isolation + CSWSH + placement` — always in the real-server e2e class).
  NOT a timing flake: pulling the actual CI job log showed all victims fail
  IDENTICALLY at ~1.1-1.3s with `PostgresError: deadlock detected` →
  `TypeError: null is not an object (evaluating .exec(set-cookie))` — every
  `bootPlatform` fetches `/v1/auth/register`, which 500'd (no `Set-Cookie`), so
  the cookie regex threw and the whole test failed. **Reproduced locally** (pg
  installed) by looping empty-db `startServer` + immediate register under 8 CPU
  hogs → deadlock within 25 iters, with the decisive `detail`: `Process A waits
for ExclusiveLock on advisory lock [_,_,1987601154,1]; blocked by B. Process B
waits for ShareLock on virtual transaction <A's xact>; blocked by A.` —
  `1987601154 = 0x76786302`. **The bug:** `INDEX_LOCK_KEY` (added in the
  2026-07-16 CONCURRENTLY-index pass) was `0x76786302`, IDENTICAL to auth's
  `BOOTSTRAP_LOCK_KEY = 0x76786302` (the migration key is `…01`). So the
  register xact holds its `pg_advisory_xact_lock(0x76786302)` while
  `ensureIndexes` (fired `void` right after boot) holds the same key via
  `pg_try_advisory_lock` and its `CREATE INDEX CONCURRENTLY` phase-2 waits on
  register's open xact → a true cycle Postgres breaks by killing register. Two
  SILENT bugs rode the same collision: a concurrent register made `ensureIndexes`
  falsely log "another replica holds the lock — skipped" (it was the LOCAL
  register), and the two unrelated subsystems were needlessly mutually excluded.
  **The fix (one char):** `INDEX_LOCK_KEY = 0x76786303`, distinct from both
  siblings. Verified: 40/40 registers succeed under the same 8-hog stress that
  deadlocked before (differential: revert → deadlock at iter 20); the 3
  previously-failing e2e (server tenant-isolation + CSWSH + agents-e2e placement)
  pass together; db-indexes 10 pass. **Pinned deterministically** (not the flaky
  e2e): a new `advisory-lock key namespace` unit test asserts all three keys
  (`MIGRATION`/`BOOTSTRAP`/`INDEX`) are pairwise distinct, and the pre-existing
  `INDEX_LOCK_KEY` pin — which only checked distinctness from MIGRATION, the gap
  that let `…02` through — now checks BOTH siblings; `BOOTSTRAP_LOCK_KEY`
  exported solely for the pin. NO CACHE/SCHEMA/wire/migration bump (an advisory
  key is runtime-only, never persisted). **Process lessons:** (1) a red main is
  not always a "flake" — pull the failing job's ACTUAL error before filing it as
  known-flaky; three prior entries mislabeled a real deadlock as a
  contention/pg-slot flake because I only read the summary line, not the stack.
  (2) The just-pushed `ce937b3`'s core CI will red on lint.oxfmt: I ran the green
  gate BEFORE adding its CLAUDE.md entry, and dir-mode `oxfmt --check .` scans
  CLAUDE.md (a wrapped inline-code span needed de-indenting) — this commit
  repairs it. ALWAYS re-run the full gate AFTER the last edit, including
  CLAUDE.md.

- **2026-07-19**: **Two timeout-path defects fixed — a HIGH silently-green
  cache-corruption + a MEDIUM hang, both from a graceful/ignoring SIGTERM
  handler** (a repro-mandated hostile review of the exec/runner + execute-task
  timeout path — the one weak spot; everything else on the path REFUTED). The
  timeout mechanism SIGTERMs a child once (`armTimeout`) and awaits
  `proc.exited`, then execute-task classifies the outcome by the child's exit
  code. TWO real failures when the child intercepts SIGTERM: **(1) HIGH —
  silently-green cache corruption.** A task using the common graceful-shutdown
  pattern `trap 'exit 0' TERM` exits **0** when the timeout SIGTERM fires — so
  the timed-out task was classified `success`, its PARTIAL outputs were CACHED,
  and every later run replayed the partial artifact as a green `cache-hit`
  FOREVER (the run even reported green). Reproduced deterministically:
  `trap 'exit 0' TERM; echo PARTIAL > out.txt; sleep 30 & wait; echo COMPLETE`
  with `timeout: 300` → `out.txt` = "PARTIAL" cached, COMPLETE never written,
  next same-input run cache-hits the partial. **The load-bearing detail** — the
  child must interrupt cleanly: `sleep 30 & wait` (dash interrupts `wait` on a
  trapped signal → exits 0 promptly), whereas foreground `sleep 30` DEFERS the
  trap during the sleep so the child rides the SIGKILL escalation to 137 (which
  masks the classification bug — the first repro cut was non-discriminating for
  exactly this reason; verified the fixed test FAILS `Expected false, Received
true` without fix #1). Fix (`execute-task.ts runAttempt`): a fired timeout
  forces a non-zero classification — `if (res.timedOut && code === 0) code =
signalExitCode('SIGTERM')` (143). A genuinely-killed child already reports
  143, so this only rewrites the trap-exit-0 case; it matches the
  `--verify && !result.timedOut` guard (a timeout is a real, retryable failure,
  never a determinism verdict) and the existing "timed out ⇒ not cached" gate
  now actually bites. **(2) MEDIUM — non-binding timeout / hang.** A task using
  `trap '' TERM` (ignore SIGTERM) swallowed the one-shot timeout SIGTERM, so
  `await proc.exited` waited out the child's natural exit (`sleep 10`, or
  FOREVER for a truly-wedged child) — there is no run-level timeout, so a
  wedged child hangs the whole run. Fix (`runner.ts armTimeout`): escalate to
  SIGKILL after a `TIMEOUT_SIGKILL_GRACE_MS = 2000` grace (mirrors the
  end-of-run persistent-shutdown escalation), the kill timer unref'd + cleared
  in `clear()` so it never delays CLI exit. Pinned: a `trap '' TERM; sleep 10`
  task with `timeout: 250` now completes `failed` in < 6s (bounded by
  timeout + grace), not ~10s. Both fixes compose (fix #2 guarantees the child
  dies; fix #1 handles the trap-exit-0 exit code). NO CACHE_VERSION/SCHEMA/wire
  bump — key derivation + artifact bytes untouched; only the classification of
  an already-timed-out task and the kill escalation changed (a buggy config that
  cached a partial artifact self-heals: the corrupt entry's key is unchanged but
  the task now fails instead of hitting → re-run → never a wrong hit). Verified:
  task-timeout 17 pass (both new pins differential-confirmed), core 1278 pass,
  lint (oxlint+tsgolint) + oxfmt 0. **Process note (the oxfmt-per-file trap):**
  `oxfmt --check <explicit-file>` does NOT apply the repo `.oxfmtrc` the way the
  CI command `oxfmt --check .` (dir mode) does, so per-file checks give FALSE
  passes — a prior fix (`3b5a623`) redded core CI on exactly this. ALWAYS run
  the real gate `bun src/bin.ts run lint --force` (dir-mode oxfmt) before push,
  never a per-file oxfmt.

- **2026-07-19**: **Remote prefetch skips the GET when local already has the
  artifact — a MEDIUM redundant-download + racy provenance-mislabel fixed** (the
  one CONFIRMED defect from a repro-mandated hostile review of the REMOTE cache
  path — LayeredCache + remote-prefetch + native-cache client; complementing the
  same-day LOCAL-path review, everything else REFUTED). **The bug
  (`layered-cache.ts`):** `get()` and `has()` both check LOCAL first, but
  `prefetch()` → `pullFromRemote` → `doPullFromRemote` called `remote.get()`
  UNCONDITIONALLY. So on a warm-LOCAL run against a configured remote, every
  stable+remote-present task RE-DOWNLOADED its full artifact (a 1000-task warm
  monorepo = 1000 redundant downloads, defeating the local cache the download
  exists to avoid) AND `remoteSourced.add` flipped its provenance — a RACY
  mislabel (whether the prefetch's ingest beats the task's own local `get`) that
  reports a purely-local hit as `cache-hit-remote`, inflating `hitRemoteCount` +
  the "did the remote cache save me work?" dashboard signal so identical warm
  runs report different local/remote splits. Not wrong BYTES (content-addressed →
  identical), hence MEDIUM. **The fix:** a local-first skip in `doPullFromRemote`
  (the shared choke point) — `if (await local.has(hash) === 'local') return true`
  BEFORE the remote GET, mirroring `get()`/`has()`; returns `true` ("the artifact
  is in local") WITHOUT marking `remoteSourced`, so a warm-local prefetch fires
  no GET and keeps provenance local, and a get() read-through that finds local
  already present (a concurrent-ingest race) still returns the hit correctly.
  **Placement matters:** the first cut put the check in `prefetch()` itself, but
  the added `await local.has` before `pullFromRemote` delayed the SYNCHRONOUS
  `inflight` registration and reopened the `markRemoteAbsent`-clobbers-a-pending-
  pull race (a pinned invariant) — moving it into `doPullFromRemote` (reached via
  `pullFromRemote`, which registers `inflight` synchronously) keeps the invariant
  intact. NO CACHE_VERSION/wire bump (only WHEN a remote GET fires; keys +
  artifacts untouched). **Refuted by the reviewer (executed repros):** the remote
  path is STRUCTURALLY immune to the stale-hit class the same-day local fix
  addressed (under a LayeredCache `shouldShortCircuit` is false → no preProbed →
  execute-task always recomputes the key with the full upstream; the transitive
  stable-keys change only trims which tasks prefetch) — re-verified with the exact
  buggy shape on the remote path (no stale hit); every remote error degrades to a
  miss (never fails a run); at-most-once GET (inflight dedup); no
  ingest-into-closing-DB; NativeCacheClient drops bearer+scope on a cross-origin
  redirect (protocol-relative + `file://` probed), digest-verifies, bounds
  downloads. Pinned by a warm-local prefetch test in `tests/layered-cache.test.ts`
  (buggy: 1 redundant GET + source=remote; fixed: 0 GET + source=local) with the
  markRemoteAbsent-no-clobber invariant still green. Verified: layered-cache 24
  pass, core 1276 pass, lint (oxlint+tsgolint) + oxfmt 0.

- **2026-07-19**: **Stale LOCAL cache-hit fixed — a `workspaceFiles` consumer
  reaching into a dependency's project output was misclassified "stable" and
  restore-tiered ahead of its regenerating upstream** (the one CONFIRMED defect
  from a repro-mandated hostile review of the core execution path — scheduler +
  execute-task + task-hash + cache + local-shortcircuit; everything else
  REFUTED). **The bug (`stable-keys.ts dependsOnSiblingOutputs`):** it marked a
  task's key preliminary only for (a) a same-project dep declaring
  `outputs.files`, or (b) a `workspaceFiles`-reading task whose dep declared
  `outputs.workspaceFiles` — it NEVER considered a dep's `outputs.files`. But
  `inputs.workspaceFiles` globs ignore project boundaries and reach into ANY
  project's dir, so a consumer reading `packages/pkg-a/gen/**` reads pkg-a's
  PROJECT output (`outputs.files: ['gen/**']`). That dependency was invisible to
  the check → the consumer classified STABLE → its key derived up-front (before
  the upstream ran) → restore-tier eligible, restoring stale bytes keyed off the
  upstream's not-yet-regenerated output. Reproduced deterministically: pkg-b
  reading pkg-a's gen via a ws-glob + decoupling the upstream hash fold
  (`cache.inputs.tasks: []`, a documented content-invalidation pattern) →
  `cache-hit/v1` after pkg-a's source changed to v2. **The load-bearing detail:**
  execute-task reuses a `preProbed` hash WITHOUT recomputing (the up-front key is
  authoritative for a restore-tier task whose live upstream is incomplete), so a
  preliminary key in `preProbed` is itself a stale-hit vector — the ONLY correct
  fix is to mark the task UNSTABLE (excluded from `preProbed` → lazy recompute in
  execute), NOT merely exclude it from the restore tier (the graph-wide
  `anyWorkspaceOutputs` gate only touches the restore tier, leaving preProbed
  reuse exposed). **The fix:** `deriveStableKeys` now accumulates, per node in
  topo order, the TRANSITIVE-upstream output producers — `outputProjects`
  (projects declaring `outputs.files` upstream) plus a `wsOutputUpstream` boolean
  (`outputs.workspaceFiles` upstream) — and `dependsOnSiblingOutputs` consumes
  them: unstable if a same-project producer is upstream (project-relative reach)
  OR the task reads `workspaceFiles` and ANY output producer is upstream
  (boundary-free reach). Transitive, so a producer reached through a no-output
  intermediate is caught too — closing the direct case AND both transitive holes
  (ws-reads-files, same-project-through-another-project) the earlier
  direct-dep-only check missed. **Scope:** LOCAL-cache only (gated on
  `shouldShortCircuit`, false under a LayeredCache — remote runs never form the
  restore tier); the common-case optimization is preserved (a cross-project
  `outputs.files` producer whose outputs a project-relative reader can't reach
  stays STABLE — pinned by the existing restore-tier control). **NO
  CACHE_VERSION bump:** the fix changes only the CLASSIFICATION (which tasks are
  restore-tier eligible), never key derivation or artifact bytes; the affected
  buggy configs change keys only for themselves and are self-healing (new key →
  miss → re-run → re-cache, never a wrong hit). **Refuted by executed repros
  (held):** output-cleaning `..` data loss (loader rejects `..` segments),
  scheduler admission hang / skip-while-exiting-0 / reservation leak
  (integer-holder-count solo-clamp, snap-to-exact-0, park/repush FIFO, willSkip
  short-circuit), dangling-dep hang, retry-caches-wrong-attempt, timeout-vs-SIGINT
  classification, in-flight dedup, restore-tier skip-restore integrity,
  same-project direct codegen. Pinned by a deterministic classification test in
  `tests/local-shortcircuit.test.ts` (buggy: the consumer is preProbed; fixed:
  unstable, with a stable control sibling). Verified: local-shortcircuit 9 pass,
  core 1269 pass, lint (oxlint+tsgolint) + oxfmt 0. **Process note:** the fix
  commit's CI redded on a DISJOINT flake — the core `lint · format · test` job
  PASSED; only `vx-cloud tests` failed, on `agents-e2e` "killing an agent
  mid-task reassigns" (a real-subprocess/WS/pg timing e2e) failing FAST (1148ms,
  not the 120s timeout — a setup/resource hiccup, the documented pg-slot flake
  class, not a reassignment regression). `packages/cloud` is byte-identical to
  the prior green commit `53c3a5c`, so the same cloud code passed there and
  flaked here — proving the red is not this core-only diff. Follow-up commit adds
  a direct classification-matrix unit suite (`tests/stable-keys.test.ts`) pinning
  `dependsOnSiblingOutputs` across the transitive + no-over-mark cases the e2e
  doesn't reach, and re-triggers CI.

- **2026-07-19**: **Harness-level guard closes the cross-file `process.chdir`
  cwd-leak flake class — a `--preload` global cwd-restore afterEach** (follow-up
  to the 2026-07-18 watch-flake root-fix; empirically resolves that entry's open
  question about cross-file cwd sharing). Confirmed in an isolated scratchpad
  (a shared append-only file log to capture REAL execution order, since Bun's
  console output is reordered per test): **Bun runs every test file SEQUENTIALLY
  in ONE process and does NOT restore `process.cwd()` at the file boundary** — a
  file that `process.chdir`s into a temp dir and doesn't restore leaks that cwd
  into the NEXT file (file 2 read `sub1`, stable over 3 runs). Two corrections to
  the prior note: (a) the "concurrently-run" wording was imprecise — it's
  sequential-shared-process, not concurrent; (b) the ACTUAL watch flake was the
  ORPHANED LOOP running `git ls-files` against its deleted explicit-cwd
  workspaceRoot (fixed 2026-07-18), NOT a cwd-leak across files — the leak class
  is a SEPARATE, latent concern. Every chdir'ing suite (2 describes in
  `cli.test.ts`, cache-prune, `output-flow.test.ts`) already restores `origCwd`
  BEFORE its `rm` in a throw-safe afterEach, so the suite was already
  induction-safe per file. This adds one harness-level layer so the class is
  STRUCTURALLY impossible for future test authors: new `tests/setup.ts` registers
  a global `afterEach` that restores cwd to the root, and the `test` task command
  gains `--preload ./tests/setup.ts` (scoped to the vx-driven path CI runs — NO
  bunfig, avoiding the documented `[test] timeout` caution and any cloud-package
  coupling). The restore is a no-op on the normal path (cwd already at root), so
  it costs nothing when suites behave; it only bites a suite that forgets to
  restore. Verified: the preload flips the scratchpad leak to no-leak, core suite
  1270 pass through the preloaded command, lint + oxfmt clean, lock regenerated
  (only the test command + its configHash changed). `grep` confirms only
  `cli.test.ts` + `output-flow.test.ts` chdir; `packages/**/tests` never do.
  Test-infra only, no product change, no CACHE/SCHEMA/wire bump.

- **2026-07-18**: **The recurring `vx watch` e2e flake ROOT-FIXED — a slow re-run
  under load no longer orphans the loop into a deleted cwd** (the documented
  "cwd race" that has redded CI intermittently; it redded `de7bad2` even though
  that commit was cloud-only — the core `test` task's watch e2e in
  `tests/cli.test.ts` timed out, the `vx-cloud tests` job passed, proving the
  failure was disjoint from the diff). **Root cause traced:** under heavy
  full-suite load the watch cycle (spawn plus git enumeration plus the 150 ms
  debounce) is slow, so `waitFor('v1')` hit its 25 s default and THREW before
  the test reached its own `process.emit('SIGINT')` — leaving the watch loop
  RUNNING. `afterEach` then `rm`'d the workspace, and the orphaned loop's next
  `git ls-files` (given the now-deleted dir as cwd) failed with `fatal: Unable
to read current working directory`, which cascaded into the next test. **Fix
  (test-infra only, `tests/cli.test.ts`):** (1) a `startWatch()` helper tracks
  the running loop with a `settled` flag, and `afterEach` SIGINTs plus awaits it
  (8 s cap) BEFORE `rm` when a test threw mid-body — so an orphaned loop is
  always torn down before its cwd vanishes; the `settled` guard prevents a
  double SIGINT after a clean exit (which would hit Node's default handler and
  kill the runner). (2) `waitFor`/`writeFor` defaults 25 s→45 s and the six
  watch tests' per-test timeout 30 s→90 s, so a slow-but-coming re-run has
  headroom to appear and each test reaches its own clean teardown. Verified: the
  full core suite 1268 pass under load (the exact contention that flaked CI);
  cli.test.ts 107 pass in isolation with no double-SIGINT. Not a product change
  — the git spawns already pass an explicit `cwd`; this is purely test lifecycle
  robustness. (The deeper cross-file `process.chdir` sharing across
  concurrently-run test files remains a latent contributor, noted for a future
  dedicated pass; this fix removes the dominant same-file orphan path.)
  **Process note:** confirm the failing TEST NAME plus the disjoint-job signal
  before assuming a red is your diff — here a cloud-only change's red was a
  pre-existing core flake.

- **2026-07-18**: **Adversarial review of the three distributed waves (per-task
  logs, run-policy propagation, reconnect) — two LOW/LOW-MEDIUM defects fixed,
  the rest REFUTED by executed repro** (a repro-mandated hostile reviewer over
  `dist/agent-loop.ts` + `dist/scheduler.ts` + `protocol-dist.ts` +
  `task-log-capture.ts`, the repo's standard discipline after touching the
  load-bearing agent-loop). **Fixed (each with a new pinning test):** (1)
  **LOW-MEDIUM — flapping-serve infinite reconnect HANG.** `runAgentLoop`'s
  `onopen` reset `reconnectAttempts = 0` unconditionally, so a serve that
  ACCEPTS the WS upgrade then immediately drops (a crash-loop / flap) refreshed
  the budget every cycle and reconnected FOREVER, never settling `done` — so
  `await loop.done` in the `vx-cloud agent` verb hangs indefinitely instead of
  giving up after the budget. Fix: a stability DWELL (`RECONNECT_STABLE_MS=10s`,
  test-overridable) — the budget refreshes only after a connection STAYS open
  past the dwell; a flap clears the dwell timer in `onclose` before it fires, so
  the budget is never refreshed and the flap exhausts it. Pinned by a
  flap-gives-up test (mirrors the reviewer's repro) and a stable-connection-
  refreshes-budget test. (2) **LOW — stale-stream log garble.** `TaskLogBuffer`
  keys in-flight accumulation by `taskId` only, so a reconnect/reassignment
  double-exec (a dropped agent's still-running detached `run()` streaming on its
  RECONNECTED socket while the reassigned agent also streams) interleaved two
  machines' output into one `task_logs` row (outcome always correct — first
  `agent:done` wins). Fix: the controller's `agent:stdout`/`agent:stderr`
  handler now gates append AND relay on the SENDING agent currently holding the
  task (`agent.inFlight.get(submissionId).has(taskId)`) — the assign adds the
  task to the holder's inFlight before it can stream, so a legit chunk always
  passes and only a stale sibling's chunks drop. Pinned by a two-agent
  holder-gate test. **Refuted by executed repro (held):** reconnect
  double-`agent:done` (deduped by `outcomes.has`, first-done-wins); cache-hit
  replayed stdout NOT stored twice (`finish` drops non-miss); per-assignment
  policy applied correctly and ONLY per-assignment (a shared agent serving two
  submissions gets each one's own; `retries:0`/`frozen:false` honored via
  `!== undefined`); cache never propagated; the fresh-agentId-per-reconnect is
  load-bearing (reusing the id would orphan the old socket's tasks via `drop`'s
  id-mismatch no-op); settle/stop races (idempotent `settle`, terminal reasons
  never reconnect, `stop()` mid-backoff resolves); `task_logs` idempotency plus
  the no-recorder path writes nothing. Verified: cloud 499 pass (+3), lint
  (oxlint+tsgolint) + oxfmt 0. NO schema/wire/CACHE/DIST_PROTOCOL bump
  (agent-side lifecycle + a controller-side stale-chunk guard).

- **2026-07-18**: **A distributed agent RECONNECTS through a transient WS drop —
  the last distributed-CI resilience gap closed** (owner: "We should have no
  limitations"; closes the "an agent that loses its WS exits — it does not
  reconnect" known-limit). Before, `runAgentLoop`'s `ws.onclose` resolved
  `{ok:false, reason:'closed'}` on ANY unexpected close and the `vx-cloud agent`
  verb exited — so a network / serve blip killed a standing helper agent even
  though the serve reassigns its tasks in ≤30 s (heartbeat/reap). The AGENT side
  never came back. Now a standalone agent reconnects with bounded exponential
  backoff (`DEFAULT_MAX_RECONNECTS=5`, 500 ms→8 s cap) on an UNEXPECTED close;
  terminal closes (refused / stopped / idle-timeout / drain) never reconnect —
  they are the agent's intended end. **The load-bearing correctness detail — a
  FRESH agentId per reconnect:** the serve reassigns the old socket's in-flight
  tasks when its close fires (`drop`→`onAgentLeave`), and `drop` no-ops on an id
  mismatch — so reusing the id could let the fresh hello overwrite the still-
  pending old entry and ORPHAN its tasks; a new id keeps the two registrations
  independent (the old one's drop reassigns cleanly, the new one resumes taking
  work). Only the very first connection may use a caller-pinned `opts.agentId`.
  **The submitter's self-agent does NOT reconnect** (`ownerSubmissionId` set →
  `reconnect` defaults off): its lifecycle is bound to the submission, which the
  submitter ends via `stop()`. **Refactor:** the socket lifecycle moved into a
  `connect()` the onclose can re-invoke; a `settle()` guard resolves `done` once
  (so a `stop()` mid-backoff — no live socket to fire onclose — still resolves);
  a new `wsFactory` seam (default `new WebSocket`) lets a unit test drive
  open/drop with a fake socket, no live serve. **Bonus:** every reconnect timer
  is unref'd + cleared by `stop()`, so a pending retry never delays process exit.
  Verified: cloud 496 pass (+5 — reconnect-with-fresh-id + no-reconnect-on-refused
  - gives-up-after-budget + self-agent-never-reconnects + stop-mid-backoff-still-
    resolves; agents-e2e green on the rewritten loop with real agent subprocesses),
    lint (oxlint+tsgolint) + oxfmt 0, docs build clean. NO
    schema/wire/CACHE/DIST_PROTOCOL bump (agent-side lifecycle only).

- **2026-07-18**: **Remote agents now honor the submitter's `--frozen` /
  `--timeout` / `--retry` — per-assignment run policy on `task:assign`** (owner:
  "We should have no limitations"; closes the distributed-CI "Known limits"
  bullet + roadmap #6). Before, a standalone `vx-cloud agent` ran every
  assignment with LIVE config eval and NO run-level defaults — the submitter's
  `--frozen` (the CI reproducibility gate), `--timeout`, and `--retry` applied
  only to its own in-process self-agent work, silently ignored on remote
  agents. **The insight (the policy is already on the controller):** the whole
  `RunRequest` rides `DistSubmitMessage.request`, so the server-side
  `DistScheduler` already holds `frozen`/`timeout`/`retries`. The gap was purely
  that `task:assign` was a bare `{taskId, submissionId}` — a standalone agent
  multiplexes several submissions and can't infer each one's policy. **The
  build:** `task:assign` gains an optional `policy?: AssignPolicy`
  (`{frozen?, timeout?, retries?}`); the controller computes it ONCE from the
  submitted request (`deriveAssignPolicy`) and includes it on every assignment;
  the agent applies it per-assignment in its scoped `run()` (`frozen` falls back
  to the loop's own `opts.frozen` for an older serve; `retries`/`timeout` come
  purely per-assignment). **Cache is deliberately NOT propagated:** a distributed
  run always has the remote axes (the §5.3 refusal gate), an agent running the
  FULL cache policy IS the artifact transport (§6.3), and each agent keeps its
  own local cache on so warm restores work across its assignments — propagating
  a restrictive `--cache=remote:` would defeat that. **No `DIST_PROTOCOL` bump:**
  the field is additive-optional with clean degradation both directions (an old
  agent ignores it → live-eval = today's behavior; a new agent against an old
  serve receives none → its own defaults), the branch/defaultBranch/context
  precedent. **Bonus fix:** the submitter's OWN self-agent now applies
  `--timeout`/`--retry` too (previously only `--frozen`/`--cache` reached it — a
  latent faithfulness gap on the submitting machine itself). Verified: cloud
  491 pass (+2 — wire round-trip of a policy-carrying assign; the controller
  fills the policy from the request + a policy-less submission stays a BARE
  assign; agents-e2e green), lint (oxlint+tsgolint) + oxfmt 0, docs build clean.
  NO schema/CACHE/DIST_PROTOCOL bump.

- **2026-07-18**: **Distributed per-task LOGS captured — the controller tees the
  agent stream it already relays into the SHARED TaskLogBuffer, so a distributed
  run's logs read back exactly like a local run's** (owner: "Let's do that" — the
  one documented non-goal from the run-history increment below). **The insight
  (no wire change needed):** each agent ALREADY tees its scoped run's task stream
  to the controller as `agent:stdout`/`agent:stderr` — it subscribes to the
  run's event bus, which carries EVERY chunk regardless of display mode (the
  `outputLogs`/flow gating lives only in the terminal renderer, never on the
  bus), filters to the assigned task id, and forwards — and the controller
  relays those to the submitter as `task:stdout`/`task:stderr`. So the tail is
  already ON the controller for free; no agent change, no `DIST_PROTOCOL` bump.
  **The build:** `DistScheduler` now `append`s those relayed chunks into the
  SAME `TaskLogBuffer` the local sink uses (128 KiB/task · 4 MiB/run · failed
  tails never evicted by successes), and in `recordTaskDone` — the single
  per-task choke point — `finish()`es + `takeEntry()`s the tail and attaches it
  to the `TaskIngestRecord.log` the recorder already ships to
  `Analytics.ingestTask`, which writes `task_logs` idempotently
  `(workspace, run, task)`. So distributed logs read back through the SAME
  `GET /v1/runs/:id/logs/:taskId` local runs use — click a failed distributed
  task, read its output. **Retention = the buffer's rule, so distributed
  MATCHES local exactly:** an executed miss (success/failed) retains its tail; a
  cache hit / STORE prune hit / skip / group `finish`es to nothing (a hit
  resolves by hash to the executed run that stored the bytes — pinned: a prune
  hit stores NO log). **No-recorder byte-identity kept:** `append` is gated on
  `recorder !== undefined`, so a recorder-less scheduler (unit tests) holds an
  empty buffer. **Logs land purely on the live `taskDone` path** — the
  end-of-run `runFinished` backstop carries no logs (the `RunSummaryRecord` has
  none), so it's one existence-gated write per executed task. **Non-goal
  (narrowed):** mid-task streaming of the STORED tail — the tail drains once at
  completion (the local path's phasing too); the chunks already stream LIVE to
  the submitter's terminal, only the dashboard-stored tail waits for the task to
  finish. Verified: cloud 489 pass (+1 — a real DistScheduler + Analytics on
  ephemeral pg injects an executed task's stdout, asserts the tail reads back
  via `logFor` with correct content/charsFull/truncatedHead + a prune hit stores
  none), lint (oxlint+tsgolint) + oxfmt 0, docs build clean (163 pages). NO
  schema/wire/CACHE/DIST_PROTOCOL bump (`task_logs` write reuses the existing
  incremental path; the agent stream was already relayed). Design:
  `docs/design/dist-run-history-2026-07.md` (§Per-task logs).

- **2026-07-18**: **Distributed runs now appear in Runs — the controller
  records them, UNIFIED with the local path through ONE summary builder**
  (owner: "distributed run still needs a controller" → "all agents report
  to controller which handles the flow; controller works exactly like a
  local run" → "make it unified"). Closed the last known-limit: a
  `VX_CLOUD_DISTRIBUTE` run ingested no summary and never showed under
  Runs, because run history is a byproduct of a single-process `run()`'s
  telemetry, and a distributed run has none. **The insight (owner's):** it
  DOES have a controller — the server-side `DistScheduler` — which already
  collects every task's `OutcomeView` (it must, to know when the
  submission finishes) and holds the full submit context. So the
  controller records the run into Postgres analytics as it goes: a
  `task_runs` row per `complete()` (live fill-in) + the `invocations`
  header at `checkFinish()`, through the SAME `Analytics.ingestTask`/
  `ingest` a local `POST /v1/ingest` uses, scoped to the submitter's
  org/workspace. **Unified, not parallel (the "make it unified"
  directive):** the `RunSummaryRecord` was built INLINE in `run.ts`;
  extracted into ONE canonical `assembleRunSummary(run, tasks, timing)` in
  core `telemetry.ts` (façade-exported), now the SOLE place the run
  tallies are computed — called by both `run.ts` (local) AND the dist
  controller. `deriveCacheSource(status)` is the single status→source
  mapping both use. So a distributed run and a local run produce
  byte-identical summaries and land in the identical ingest; the ONLY
  distributed-specific code is the irreducible bits — projecting the wire
  `OutcomeView` back to `TaskTelemetry`, the controller-clock timeline,
  and the submitter run-context. **Two distributed-shape decisions:**
  (1) run-context (os/arch/host/ci/vxVersion/dirty/workspaceName) comes
  from the SUBMITTER (the invoking CI runner, like a local run's header)
  — captured via core's `captureHostContext`/`detectCi`/`captureGitContext`
  and sent additively on `DistSubmitMessage.context?` (NO
  DIST_PROTOCOL_VERSION bump — the branch/defaultBranch precedent);
  (2) each agent's wallclock-ns is relative to its OWN scoped run, not a
  shared clock, so the controller stamps each task's start/end with its
  own clock (`agent:start`/`agent:done`), encoded run-relative so
  `insertTaskRun`'s existing derivation yields a coherent shared
  epoch-ms timeline (flamegraph works, zero analytics change).
  **Idempotency:** run_id = submissionId; both the live `taskDone` and the
  end-of-run `runFinished` anchor `started_at` on the same `startedAtMs`
  via the same `taskTelemetryFor`, so the header backstop's `ON CONFLICT
DO NOTHING` dedups the live rows (test proves exactly 2 rows, never 4;
  re-ingest adds nothing). Recording is fire-and-forget + swallow-and-warn
  — a recording error can NEVER touch scheduling; a scheduler with no
  recorder is byte-identical to before. **Core façade widened
  (export-only):** `assembleRunSummary`, `detectCi`, `captureHostContext`
  (+ `CiContext`/`HostContext`). **NO bumps** anywhere (CACHE_VERSION /
  core SCHEMA / TELEMETRY_SCHEMA_VERSION / DIST_PROTOCOL_VERSION) — the
  controller only WRITES existing columns; the wire field is
  additive-optional. **Non-goals (documented):** per-task LOG capture on
  the distributed path (agents don't stream their tails to the controller
  yet — the run + task rows land; logs are a later increment, the same
  phasing the local path used) + a pre-start "running" row. Verified
  independently: lint 0, core 1713 pass, cloud 488 pass (incl. a real
  `dist-ingest` e2e — real `DistScheduler` + real `Analytics` on ephemeral
  pg, driven across a fake agent + a store-prune hit, read back through
  the dashboard's own `listInvocations`/`listRuns`), docs build clean +
  0 broken links. Design: `docs/design/dist-run-history-2026-07.md`.

- **2026-07-17**: **Visual-first docs — corrected to MECHANISM DIAGRAMS +
  real screenshots; NO terminal/UI emulation** (owner arc: "add
  screenshots / cool graphics visualizing things — docs should be
  engaging" → "explain visually/interactively before the how-to" →
  "Remove changes from website. Screenshots in DOCS. Every feature
  visualized or interactive demo" → **"Do not emulate terminal! Remove
  all demos showing off terminal… explain feature not by how they LOOK
  but how they WORK. Interactive workflows, graphs, screenshots — educate
  why this is awesome"**). **First cut (reverted): fabricated UI.** I'd
  built three Astro components — `Terminal.astro` (a faithful `vx`-output
  renderer w/ an interactive cold→warm toggle), `GithubSummary.astro` (a
  GitHub job-summary card), `SideBySide.astro` (before/after code panels)
  — captured from a real temp `@acme/*` CLI run. The owner rejected the
  approach: docs should teach HOW a feature works, not show a pretty
  emulation of its output. **All three components DELETED**; every guide
  reverted from `.mdx` back to `.md`. **The kept + corrected program:**
  each feature's "See it" now leads with a **Mermaid flowchart of the
  MECHANISM** (educational — what actually happens), plus the **real
  dashboard screenshots** (those stay — they're genuine captures, not
  emulations), plus standard markdown/code. **Mechanism diagrams shipped:**
  caching (inputs → hash → key → hit-restore / miss-run-save); running-
  tasks (`--affected`: git diff → changed files → owners → +dependents →
  scoped set, rest never scheduled; `--verify`: run → re-run → compare →
  proven/nondeterministic-fails); sandboxing (declared inputs = allow-list
  → undeclared read denied → fail); dev-tasks (spawn → readyWhen match →
  dependents start → teardown); remote-caching (need → local? → remote? →
  download+hydrate / run+upload); task-dependencies (the `^build` DAG) +
  distributed-ci (agent fan-out) — both already graphs. The GitHub job
  summary is now a plain **markdown table** (what GitHub actually renders),
  not a styled card. **Dashboard screenshots (kept, real):** Runs,
  flamegraph, Insights, project, Task detail, Compare, Command palette,
  Cache, Admin — embedded across `dashboard.md`, `overview.md`,
  `remote-caching` (cloud), `self-hosting`. **STANDING DIRECTIVE:** explain
  features by **how they WORK** — reach for a Mermaid graph of the
  mechanism or a real screenshot; do NOT emulate terminal output or
  fabricate UI chrome. Every wave: astro build clean + zero-broken-links
  crawl + browser-verified the diagrams render (no syntax bombs). Docs
  only; no core change.

- **2026-07-17**: **Analytics correctness sweep (cycle 11) — a
  re-pushed-run 500 in `compareRuns` fixed + two unclamped-window scans
  clamped; the NULL-aggregate and tenant-clamp classes swept CLEAN**. A
  read-only audit traced every read query in `analytics.ts` against the
  four documented bug classes. **Finding 1 (MEDIUM, correctness/
  availability) — `compareRuns` raised a hard 500 on a re-pushed run:**
  its prev-run lookup used a BARE scalar subquery `started_at < (SELECT
started_at FROM invocations WHERE run_id = $)` — but invocations'
  uniqueness is `(started_at, run_id)`, so a re-push (changed startedAt,
  passes the `ON CONFLICT (started_at, run_id)` guard) yields TWO headers
  and the subquery matches >1 row → `PostgresError: more than one row
returned by a subquery used as an expression` (repro'd: the exact
  error), surfaced as 500 on both `/v1/compare/:runId` AND MCP
  `compare_runs`. This was the LAST missed instance of the duplicate-
  header class (getRegressions/getProjectBranchFailures/taskDurationHints
  already fixed); collapsed with `MIN(started_at)` (earliest-header
  convention). Pinned by a discriminating repro (throws on the old
  scalar subquery; returns `previousRunId:'old'` on the fix). **Findings
  2-3 (LOW/LOW-MED, perf/DoS) — unclamped windows:** `getRegressions.
sinceDays` and `getBottlenecks.lookbackDays` had no `MAX_WINDOW_DAYS`
  clamp, so a hostile `1e15` drove a full scan of every `task_runs`
  partition (the 2026-07-14 degenerate-scan class that already protects
  getRunHeatmap/getPeriodComparison/getRunTrends); both now `clampInt(…,
1, MAX_WINDOW_DAYS)`. No discriminating unit test (on any seeded set a
  hostile window returns the same rows — only timing differs, which is
  flaky; a non-discriminating pin violates the assert-the-signature rule)
  — defensive clamps in a proven, already-tested class; the existing
  getRegressions/getBottlenecks correctness + scale guards confirm the
  legit path is unbroken (scale 12/0). **Classes swept CLEAN (documented
  negative result):** NULL-aggregate-into-non-null-number (every
  single-row SUM/AVG/MAX/percentile is COALESCE'd or `?? 0`-mapped, every
  ratio div-guarded) and missing-workspace_id tenant clamp (every read's
  every joined table + CTE + LATERAL side individually verified clamped —
  NO cross-tenant leak). jsonb double-encoding also re-verified clean
  (all four `::jsonb` writes pass objects; the `@>` filter passes an
  object literal). NO schema/wire/CACHE bump (output-preserving). Gate:
  oxlint + oxfmt 0; analytics-read 46 + analytics-scale 12 pass.
  **Process note:** the fix comment first shipped a JS parse error — a
  SQL `-- ... `backtick-quoted` ...` comment INSIDE a Bun.sql template
  literal closes the string; caught by the local run before commit (never
  put backticks in a tagged-template SQL comment).

- **2026-07-17**: **`taskDurationHints` de-duplicated — the same
  re-pushed-invocation bug class the getRegressions/getProjectBranch-
  Failures LATERAL fixes closed, found in the LPT dispatch hint (cycle 10)**. A targeted bug hunt grounded in this codebase's known failure
  mode (`invocations` uniqueness is `(started_at, run_id)`, so a
  re-pushed summary with a changed `started_at` yields TWO headers for
  one run) swept every `invocations` join in `analytics.ts`. All the
  analytics-read paths already had the LATERAL pick-one fix EXCEPT
  `taskDurationHints` — the trunk-scoped LPT duration hint — which
  predated that awareness (it shipped in the 2026-07-14 trust-scope wave,
  before the cycle-7 getRegressions fix taught the pattern). Its plain
  `LEFT JOIN invocations ON run_id` DUPLICATED each task_run of a
  re-pushed run, skewing `avg(duration_ms)` toward it (pinned: two build
  runs 100 + a re-pushed 200 gave 166.67, not the true 150), and — the
  sharper leak — a re-push that changed branch could feed the SAME run
  into both the trunk baseline AND a branch scope, defeating the very
  trust isolation that wave built. Fixed with the established LATERAL
  pick-one (earliest header per run_id), byte-identical on well-formed
  single-header data. Advisory-only impact (dispatch ORDERING, never
  outcomes/keys), so low severity — but a real aggregate-correctness bug
  closed for consistency. Pinned by a DISCRIMINATING regression (fails
  `150 vs 166.67` on the old join; the branch-leak half uses a genuine
  feature run so `feature app#ship` = 1000 not the leaked 700). Gate:
  oxlint + oxfmt 0; analytics-read + analytics-scale (incl. the hint
  perf guard) + dist-registry 79 pass. NO schema/wire/CACHE bump
  (output-preserving query rewrite).

- **2026-07-17**: **CI too-many-clients flake killed structurally —
  ephemeral-pg `max_connections` 100→400 (`d51dafd`)**. The session-memo
  push (`95f17ef`) went RED on the cloud job — but NOT on its content:
  the core job passed, `auth.test.ts` passed, and the sole failure was
  `db-indexes.test.ts`'s replica-race try-lock test (cycle 7's
  CONCURRENTLY pass), which passes 9/9 isolated. The CI log's
  discriminator: `PostgresError: sorry, too many clients already` printed
  immediately before the failure. Root cause: the full 37-file cloud
  suite shares ONE ephemeral cluster and pooled connections peak faster
  than they close; on Postgres's default `max_connections=100` the peak
  tips over — the recurring "connection-slot flake" the log noted at
  2026-07-13/14/16 as "isolated-passing." This test hit the ceiling first
  because it uniquely holds an extra reserved `held` connection while
  `ensureIndexes` reserves its own, so the failed reserve returned
  `skipped:false` where the test asserts `skipped:true`. Fixed at the
  ROOT for the whole class: `-c max_connections=400` on the cluster start
  (fsync=off → headroom is ~free). Verified: three consecutive full-suite
  runs 483 pass / 0 fail. Test-infra only, no product change; the
  local-ci skill's known-flake note updated. **Lesson reinforced:** a red
  main is not necessarily YOUR change — read the failing TEST NAME + the
  pg error before assuming a regression; here the failing suite was
  disjoint from the pushed diff.

- **2026-07-17**: **Session-principal auth memo SHIPPED — the last named
  residual of the 2026-07-12 perf audit (F1's deferred half)** (cycle 9).
  Every session-authenticated request (the dashboard polls several `/v1`
  reads per open tab) resolved the principal from Postgres — HMAC-verify
  the cookie, SELECT the session row, renew, load user + memberships.
  Now memoized in `auth/rbac.ts`, byte-for-byte the token-memo pattern:
  5s TTL, 10k bound with clear-on-overflow, keyed by the sha256 id-hash
  hex of the HMAC-VERIFIED session id (never the raw cookie; a tampered
  cookie fails the constant-time HMAC gate before any memo or DB touch
  and is never cached). Unknown/expired ids null-cache for the TTL (a
  256-bit server-minted id can never become valid — the session analog
  of secrets-can't-re-mint). **The invalidation surface that originally
  deferred this is closed in-process:** logout → per-entry forget (the
  memo lives in rbac.ts because sessions.ts is a leaf — `destroySession`'s
  doc requires callers to forget, and its only caller does); member role
  PATCH / member DELETE / invite accept / org create / profile RENAME
  (displayName is on the principal) → whole-memo clear (rare admin
  actions — obviously-correct beats per-user tracking); password change
  deliberately does NOT clear (rewrites only `password_hash`, not on the
  principal, no session rotation in the current code). Sliding renewal
  fires only on a memo miss (verified: the UPDATE lives inside
  `resolveSession`, which the hit path never reaches) — ≤5s skew against
  a 30-day window, pinned. Per-entry validity caps at
  `min(TTL, session.expiresAt)` mirroring the token memo — with a
  stated-honestly wrinkle: the cap CANNOT bind today (any session within
  15d of expiry is renewed to 30d during the very resolution that
  memoizes it), kept as cheap insurance for a future renewal-policy
  change. Pinned by 6 controlled-clock tests incl. the sharp ones:
  logout's next request 401s (revocation beats TTL), a role demotion is
  visible on the demoted user's NEXT request (no stale-escalation
  window), invite-accept's own request memoizes the PRE-accept principal
  so the accept-side clear is load-bearing (test fails without it), a
  31-day-untouched session 401s, renewal bumps `expires_at` exactly.
  **Accepted residuals:** cross-replica staleness ≤5s for every session
  mutation (the token memo's accepted property); out-of-band DBA edits
  (manual `disabled_at`, row deletes — no route performs these) visible
  after ≤5s. Gates: oxlint (differential-verified with a planted TS2322
  probe) + oxfmt exit 0; auth 32 + server 32 pass on real pg. NO
  schema/wire/CACHE bump. Task #79 (the 2026-07-12 perf follow-ups) is
  now fully CLOSED.

- **2026-07-17**: **The trusted-GET S3 HEAD-skip SHIPPED — the deferred
  backlog item (b), completed from the stashed WIP + adversarially
  verified sound (zero defects)** (cycle 8). On a presigning (S3)
  backend, `GET /v1/cache/:hash` by a principal whose read-scope set has
  exactly ONE scope (trusted tokens) now skips the per-scope existence
  HEAD and answers 307 to the presigned URL for that sole scope directly
  — the HEAD decided nothing (the presigned key is server-derived either
  way), and it was a wasted S3 round-trip per GET on the hottest surface.
  **Wire change, stated honestly:** a single-scope GET of an ABSENT hash
  is now 307 (bucket 404s → the client degrades to a miss — pinned as a
  dedicated native-cache test, which did NOT previously exist) instead of
  a serve-side 404; the end-to-end outcome is identical, the round-trip
  moves off the serve. Multi-scope (untrusted: own sub-scope ∪ trusted)
  GETs keep HEAD-per-scope resolution + the serve-side 404;
  `HEAD`/`hasMany`/`list` are untouched (planRun predictions + the batch
  prefetch stay accurate); `LocalDirBackend` (no 307 path) is
  byte-identical via the `localPathFor` gate. Down bucket: single-scope
  GET = 307 whose client follow fails → quiet degrade-to-miss (presign is
  offline SigV4 — the serve can't observe the outage); HEAD/PUT/
  multi-scope keep the loud 502; the boot-time S3 probe still fails loud.
  **Adversarial review (repro-mandated, 15 executed attacks): SOUND.**
  Refuted: scope forgery (13 hostile `x-vx-cache-scope` values + hostile
  hashes → the Location is ALWAYS the caller's own scope key; `HASH_RE`
  400s before any presign), untrusted-reaches-fast-path (readScopeSpecs
  is unconditionally 2 entries for untrusted — repro'd 2 HEADs under 5
  hostile/missing subs), existence oracle (the 307-for-both shape leaks
  STRICTLY LESS than the old present/absent split), client degradation
  (404-follow → null; strict-ACL 403-follow → throw → LayeredCache miss
  with a REAL run() still succeeding; one-hop; bearer + scope header
  dropped cross-origin; tampered body → digest mismatch → miss), PUT
  immutability (409 + HEAD-before-body intact), and the zero-HEAD spy
  pin's discriminating power (the same spy records 2 heads on the
  untrusted path). **Accepted residuals:** a persistently mis-ACL'd
  bucket (403 on absent keys) turns trusted cold misses into QUIET misses
  (never-fail posture; HEAD/PUT/multi-scope still 502 loud — noted in the
  fast-path comment); a cold trusted GET relocates the absent-probe
  round-trip to client→bucket (the batch probe still prunes absent hashes
  server-side for the prefetch flow). Docs shipped in the same wave
  (wire-protocol.md single-scope-307 contract; the native-cache-wire
  design doc's `GET → 404 miss` row gained a dated as-shipped deviation
  note — the 2026-07-08 doc-correction precedent). Suites: the four
  touched cloud suites 101 pass / 0 fail (+ the reviewer's 15-repro suite
  green, then deleted); lint + fmt clean. NO CACHE_VERSION/schema/
  DIST_PROTOCOL bump (server-side redirect shape only; `cacheWire` stays
  2 — the client needed no change, its one-hop follow + 404-as-miss
  predate this).

- **2026-07-17**: **The document-every-cloud-feature directive EXECUTED —
  a full audit→write→verify docs program over the 8 cloud pages + a new
  HTTP API reference (`a4a5051`, `50dbe57`)** (owner: "document each and
  Avery single one feature of vx cloud in docs"). A read-only audit agent
  built the complete feature inventory from the decision log + every code
  surface and graded all 8 `apps/docs/src/content/docs/cloud/` pages
  (DOCUMENTED / THIN / MISSING with a ranked gap list); the writes were
  then done INLINE in the main loop after the session limit killed all 9
  writer agents at launch (resets 13:10 UTC — the "never stop" answer was
  to do the work directly, not idle 4.5h). **Shipped:** (1) NEW
  `cloud/api.md` — the whole `/v1` surface as a reference (auth classes
  incl. the `x-vx-csrf` session-mutation header, tenancy resolution
  `?ws=`/`?org=`, ~35 read routes with params/defaults/clamps verified
  against `analytics-routes.ts`, the 4 ingest writes with body caps +
  wire-version 400s + idempotency, cache-wire/streams/MCP pointers, error
  conventions) + sidebar registration. (2) **Three accuracy fixes** —
  distributed-ci.md + cli.md claimed a commit-SHA mismatch REFUSES an
  agent (stale since the multi-run scheduler: commit is a
  dispatch-ELIGIBILITY filter, only a DIST_PROTOCOL mismatch refuses —
  `registry.ts` header is the proof); overview.md claimed "teams" (a
  schema-only table, no shipped surface); `VX_CLOUD_DATA_DIR` reworded
  vestigial. mcp.md's tool table had DRIFTED from `cli/mcp.ts`
  (`run_trends` is workspace-wide bucketed activity, NOT per-project;
  `compare_runs` diffs vs the PREVIOUS invocation, not two arbitrary
  runs) — rewritten with real args/defaults + the workspace-resolution
  ladder + batch/notification-202 semantics. (3) **New coverage**:
  distributed-ci.md gains LPT duration-aware dispatch + trust-scoped
  hints, heartbeat/liveness (10s/30s), the `/v1/agents` capacity probe +
  `ready` autoscaling signal, and the GHA job-summary/check-run section
  (with the honest distributed-run-no-summary caveat);
  remote-caching.md gains per-PR sub-scope isolation (`VX_CACHE_SCOPE`,
  `x-vx-cache-scope`, server sanitization, own-then-trusted reads) + the
  batch probe; self-hosting.md gains a roles table derived from the
  actual route guards, token `kind`/`expiresAt`/instant-revoke,
  partition/retention mechanics, the background CONCURRENTLY index pass,
  and a security-model section; dashboard.md now lists every shipped
  card (full Insights + Cache sets, the cache-entry provenance page, the
  Cmd/Ctrl-K palette, the run-detail graph/flame toggle + platform
  fallback, both invite accept paths). **Verified:** every claim checked
  against source before writing (each stale-doc fix cites its proof
  line); astro build exit 0; a dist-wide crawler found ZERO broken
  internal links. **Standard going forward:** a cloud feature is not
  done until its docs land in the same wave. **Session note:** the
  parallel trusted-GET HEAD-skip developer was killed mid-work by the
  same session limit; its partial diff is preserved in `git stash`
  ("WIP: trusted-GET HEAD-skip") for resume-or-relaunch.

- **2026-07-16**: **Cycle 7 — the CONCURRENTLY index path SHIPPED
  (`081efde` design, `420d02b` build); getRegressions got the LATERAL dedupe
  (`9e71e44`); a CI incident diagnosed from run TIMING; and the bunfig
  timeout fix CORRECTED (`d4bfa0e`)**. **(1) Concurrent indexes**
  (docs/design/concurrent-index-migrations-2026-07.md): `runMigrations` stays
  byte-untouched (its one-transaction guarantee is the foundation);
  `db/indexes.ts` adds a declarative `ensureIndexes()` convergence pass — the
  `maintainPartitions` sibling — because outside a transaction "DDL happened ⇔
  ledger row exists" is unclosable, so the pg CATALOG is the ledger. Per
  entry: `CREATE INDEX IF NOT EXISTS … ON ONLY` parent shell (instant,
  INVALID) → per-partition `CREATE INDEX CONCURRENTLY` → `ATTACH PARTITION`
  (attachment-probed, NOT name-probed — partitions created later by
  `ensurePartitions` inherit AUTO-NAMED children) → parent flips valid on the
  last attach. Recovery state machine (INVALID leftover → drop + rebuild;
  valid-unattached → attach; attached → skip) means a crash mid-build never
  wedges boot; replicas serialize on a session-level `pg_try_advisory_lock`
  (key `0x76786302`) held on ONE `sql.reserve()` connection (a pool has no
  same-connection guarantee); never-throws with per-entry/per-partition
  isolation; `RETIRED_INDEXES` handles renames. Runs in the BACKGROUND after
  bind + on the daily tick — a multi-minute build never blocks serving
  (queries just keep their plan). First consumers:
  `task_runs_failed_ws_started` + `invocations_failed_ws_started`
  (`(workspace_id, started_at DESC) WHERE failed`) — the partial indexes
  getNotifications/getRecentFailures/getRegressions/getProjectBranchFailures
  wanted (task #79/#95 closed for (a)). Pinned on real pg: fresh convergence,
  idempotent re-pass, new-partition inheritance, a REAL failed-CONCURRENTLY
  injection (unique-over-duplicates → genuine `indisvalid=false` → next pass
  recovers), try-lock skip, retirement, never-throws isolation, + a server
  e2e (background pass builds both after a real boot). Verified empirically
  before build: single-statement `sql.unsafe` CIC rides NO implicit
  transaction on Bun.sql; the auto-named-children fact is why name-probing
  would be wrong. **(2) getRegressions LATERAL dedupe (`9e71e44`)** — same
  duplicate-run_id class as the branch-failures fix; a re-pushed summary can
  no longer fake a ≥2-branch regression (pinned; cte-diff differential
  byte-identical on well-formed data). **(3) CI incident forensics:** three
  consecutive main reds (`9e71e44`, `081efde` docs-only, `b6648d4`
  workflow-only) landed EXACTLY in a ~1h window where GitHub's jobs API 503'd
  for every run. The discriminator when job logs are unreachable: RUN TIMING
  from the runs-list payload — `9e71e44`'s run "failed" in 11 SECONDS (cannot
  have executed a 70s suite → jobs never started → infra, proven). All
  suites green locally on identical code throughout. `b6648d4` added
  `workflow_dispatch` to ci.yml — the manual re-run button every flake triage
  this week wanted. **(4) A false fix corrected honestly (`d4bfa0e`):**
  `a213a4b`'s bunfig `[test] timeout` is NOT honored for hooks on Bun 1.3.11
  (direct experiment: a 7s beforeAll still dies at 5s with the bunfig
  in-tree) — and its "differential verification" was bogus (the grep counted
  the `0 fail` summary line as a match). `bun test --timeout 30000`
  verifiably works (same 7s hook survives) → the flag now rides the CI cloud
  step + the local-ci skill; bunfig deleted. Caught by the implementation
  agent's independent in-tree experiment — the lesson: a differential is only
  as good as its failure-side assertion (assert the FAILURE SIGNATURE, never
  a substring a passing run also prints). **Also pinned for posterity:**
  Bun.sql's lazy SQLQuery passed to `expect(...).rejects.toThrow()` never
  executes AND wedges the test process — await/`.then` the query and assert
  the captured error instead (comment in db-indexes.test.ts).

- **2026-07-16**: **The three ratio perf guards de-flaked — min-of-3
  interleaved (`c0a4d0c`)**; found by doing what the corrected rule demands
  (confirming the REAL CI conclusion after pushing). `518d051` and `8fbe0b5`
  were RED on main — NOT on their content: both failed ONLY
  `cache baseline: Cache.key scales near-linearly (1000/100 ≤ 30×)`
  (1267/1268 pass) — a 50% false-red rate over four runs, which makes the CI
  signal worthless. **Root cause (structural, not a bad bound):** a ratio of
  two SINGLE-WINDOW medians multiplies both windows' noise — a lucky-fast
  denominator inflates the ratio exactly like an unlucky-slow numerator — and
  `VX_PERF_SCALE` (the CI 3× budget multiplier) can't absorb it because a
  ratio is scale-free by design, so the noise headroom every absolute-budget
  guard gets never applied to the ratio guards. All three ratio guards
  (`scales near-linearly ≤30×`, `fast-path ≥5× vs cold`,
  `batched recordRuns ≥3×` — the last also flaked locally under load) now run
  through `benchRatioSides`: min-of-3 INTERLEAVED trials per side (noise only
  ever ADDS time → the min median is the robust per-side estimate;
  interleaving cancels drift — the repo's documented anti-flake method,
  applied to the ratio guards that predated it). Bounds unchanged (they guard
  algorithmic shape: linear ≈10× vs quadratic ≈100×). **Verified beyond a
  green run:** 3× green isolated, core 1268/0, and 3× green at CI scale
  (`CI=true` → 3× budgets) under FOUR busy-loop CPU hogs — heavier contention
  than a shared runner (the same stress at dev-scale 1× correctly fails the
  absolute budgets — that's the scale knob working, not a flake).
  **Confirming `c0a4d0c`'s CI then exposed a SECOND, independent infra flake
  (`a213a4b`):** its core job PASSED (the hardened ratio guards held on a
  real runner) but the CLOUD job false-redded — 41 pg-backed tests failing
  instantly in 9.5s. Root cause from the run log: the FIRST pg suite's
  `beforeAll` (ephemeral-pg boot: initdb + pg_ctl + template migration)
  exceeded bun's DEFAULT 5s hook timeout on the contended runner; the timeout
  enforcement killed initdb mid-run ("caught signal") and every pg suite in
  the process cascaded (the same signature had hit a loaded local run). The
  boot isn't fixably slower — initdb already runs `--no-sync`, the server
  `fsync=off` — the CEILING was too low: new `packages/cloud/bunfig.toml`
  `[test] timeout = 30000` (headroom, not a wait; picked up by CI's
  `cd packages/cloud && bun test` and the local-ci path). Verified
  DIFFERENTIALLY that the knob governs hooks: `timeout = 1` → the boot hook
  times out; `30000` → 54/54 green. Together these two commits close the
  three distinct false-red sources observed this week (ratio-guard noise,
  the stale-lint-cache push, the pg-boot hook timeout); CI conclusions for
  `a213a4b`+log confirmed green after push.

- **2026-07-16**: **Adversarial review of the project-analytics wave — five
  verified defects fixed, the rest of the surface REFUTED (`00868d3`); + docs
  currency (`8fbe0b5`) and the local-ci skill corrected** (cycle 6 of "Never
  stop. Follow cycles."). A repro-mandated hostile reviewer (real ephemeral pg
  - real `startServer` + the real UI helpers) swept `5fb1ffa`+`83f09c0`.
    **Fixed (each repro'd before the fix):** (1) **MED** — `getProjectTaskTrends`'
    `top` CTE ranked tasks by `SUM(duration_ms)` over ALL rows while the series
    displays only executed successes, so a cache-hit-dominated task (60 hits ×
    50ms beat 2 executions × 1000ms) crowded a genuinely slow executed task out
    of the top-N and rendered an all-zero sparkline in its place → rank by the
    DISPLAYED population (`SUM(...) FILTER (non-hit success) DESC NULLS LAST`).
    (2) **LOW-MED** — `invocations` uniqueness is `(started_at, run_id)`, so a
    re-pushed summary with a changed `startedAt` yields TWO headers for one run;
    `getProjectBranchFailures`' plain join then attributed ONE failure to
    multiple branches and could flip `firstBranch` to the re-push → LATERAL
    pick-one (earliest header per run_id, indexed). NOTE: `getRegressions`
    shared the join shape (pre-existing, same corruption class under a re-push)
    — fixed in the follow-up with the same LATERAL + a duplicate-header pin (a
    faked two-branch regression from one re-pushed run → not surfaced); the
    well-formed path is byte-identical (the cte-diff differential stays green).
    (3) **LOW** — the
    `shorthash` DataTable cell rendered a NULL as the literal `null…`
    (branch-failures `firstCommit` is the first nullable shorthash binding) →
    guard null/''. (4) **LOW** — `getPeriodComparison`'s limit clamp (≤100)
    silently zeroed the project view's Δavg column past the top-100 movers in a
    large project (the table holds 500) → clamp raised to 500 (movers aggregate
    in SQL; the clamp only bounds the sorted slice). (5) **LOW** — the server's
    `avg=0` sentinel (an all-hit/all-failed bucket) plotted as a to-zero dip
    that read "got fast" and reported a 0ms `_latest` → the sparkline now draws
    the EXECUTED-duration series only (`foldTaskTrendPoints`, exported + unit-
    pinned; an all-sentinel task honestly shows an empty series). **REFUTED by
    executed repro (held):** workspace clamps incl. a same-run_id decoy in a
    foreign ws; BRANCH_CAP keeps rank-1 under 15-branch + 20-way-tie storms; tie
    determinism (`branch ASC`); hostile `from=0&to=1e15&limit=1e9` clamps;
    SQL-injection/unicode project names; both new routes' 401/allowlist/400
    gates; `_taskRef` link encoding; `rankProjects` identity/tie/absent-project
    edges; `mergeMoverDelta` null paths; Spark viewBox NaN paths. **Accepted
    residual (measured):** `/v1/trends/tasks` bounds at tasks×buckets (~72k
    rows/462ms worst-case at 50 hourly tasks over 60d) — inside the established
    bounded-array bar; a total-row cap is a noted tightening. **Also:** the
    dashboard guide now documents the project drill-in's five cards + the
    timeframe selector (`8fbe0b5`), and `.claude/skills/local-ci` was rewritten —
    it referenced package.json scripts deleted long ago; it now runs the RAW
    gate commands (cache-proof, the phase-1 stale-lint-cache lesson), covers
    BOTH CI jobs, lists the known load-flakes, and ends with "confirm the real
    CI conclusion after pushing". Full gate green: fmt clean (417 files), oxlint
    clean, core 1268/0, cloud 462 pass (the 2 full-suite fails = the documented
    db-migrate connection-slot flake, 11/11 isolated), docs build 2/2, browser
    re-verify PASS (sparklines correctly drop to the executed-only series). NO
    CACHE/schema/wire bump.

- **2026-07-15**: **Project analytics phase 2 — per-task duration sparklines
  (`83f09c0`); + fixed a phase-1 CI-red** (the literal "see all tasks and their
  history over time, spot outliers/spikes/trends" ask). Phase 1 gave a
  project-LEVEL trend + a lifetime table; phase 2 gives each task its OWN
  time-series. **Server:** `getProjectTaskTrends(ws, project, {bucket, from, to,
limit})` — ONE query, flat long-format (task, bucket) rows; a `top` CTE bounds
  the task set to the ≤50 heaviest by total duration (so a many-task project
  can't fan out unbounded), avg + p95 aggregate IN SQL over the non-hit
  executed-success subset (no raw-row stream), span clamped to
  `MAX_TREND_BUCKETS`. Route `GET /v1/trends/tasks?project=&bucket=&from=&to=&
limit=` (project → 400), added to the `isAnalyticsSurface` allowlist (pinned by
  a server e2e — a two-segment `/v1/trends/*` path still needs the allowlist or
  it falls through to the SPA). **UI:** a new `SparkList` catalog component — a
  row per task: label · inline-SVG sparkline of the task's avg-duration series
  (deterministic viewBox, no layout on poll) · latest value · a trend dot. Trend
  color comes from a LITERAL `SPARK_STROKE` map (up=slower=danger /
  down=faster=success) — never a dynamically-built `stroke-${x}` (UnoCSS's static
  extractor can't see those; the recurring dynamic-class trap). `data.ts`
  `projectTaskTrendItems` groups the long rows into per-task
  `{series, _latest, _failures, _trend, _dir}`, windowed off `?window`; a "Task
  duration trends" card on `projectDetail.json` binds it (pure JSON). Verified
  end-to-end in a real browser (seeded multi-day durations): the card renders 2
  task sparklines, `/v1/trends/tasks` fires + rescopes with the window chips,
  ZERO console errors. Analytics-read 41 + server 32, UI 64 pass; NO CACHE/
  schema/wire bump. **LESSON (a real miss): phase-1 (`5fb1ffa`/`79e48b8`) went
  out RED on main.** Its branch-failures test had `branch: undefined` (illegal
  under `exactOptionalPropertyTypes` → oxlint TS2345), but the LOCAL
  `bun src/bin.ts run ci` gate passed lint — a stale `lint.oxlint` cache hit
  masked it — and I pushed without confirming the REAL CI run (the exact
  2026-07-10 rule I'd already written down). A fresh CI runner has no lint cache,
  ran `oxlint`, and failed the `vx run ci` step (the cloud-tests job passed).
  Phase-2 fixes the TS2345 + swept an oxfmt drift in the design doc/decision-log
  entry, and I CONFIRMED `83f09c04` = CI success before moving on. Reinforced:
  after every push, verify the actual CI conclusion — "the local gate passed" is
  not "CI is green," especially for lint (its cache can hit stale). **DEFERRED
  (phase 3):** regressed-vs-always-broken flag on the branch-failures card; a
  branch facet on recent executions.

- **2026-07-15**: **Project analytics view — tasks over time, branch-first-
  failure, cross-project rank (`5fb1ffa`)** (owner: "project view where I can see
  all tasks and their history over time; spot outliers/spikes/trends; debug
  logs+artifacts per execution; compare my project against others (failures vs
  success); compare against branches so I know where the issue was first
  noticed"). Design `docs/design/project-analytics-2026-07.md` — the project
  detail page was aggregate-only; this turns it into a single-dev drill-in
  answering all five asks. **Heavy reuse + ONE net-new query** (the design's
  chosen option C): four of five asks land by reusing `listRuns`/`listProjects`/
  `getRunTrends`/`getPeriodComparison`/`getHistory` with a filter or a client
  rank; only #5 (where-first-noticed) had no existing shape. **Server:**
  `getProjectBranchFailures(ws, project, {sinceDays, limit})` — ONE set-based
  CTE computing the earliest failing run per `(task, branch)`
  (`MIN(started_at)` + `(ARRAY_AGG(commit_sha ORDER BY started_at))[1]` for the
  first commit), then `ROW_NUMBER() OVER (PARTITION BY task ORDER BY
first_failed_at ASC, branch ASC)` so `branch_rank = 1` is the branch that
  failed FIRST; JS folds per task (firstBranch/firstCommit from rank 1,
  branchesFailing = true count, `branches[]` capped at `BRANCH_CAP`=12, sorted
  most-recent-first, limit clamp ≤200). Workspace-clamped, project-scoped,
  `started_at`-partition-pruned, reads only `status='failed'` rows, `inv` join on
  the indexed `run_id` — **no N+1, no unbounded raw-row fetch** (wants the
  deferred `status='failed'` partial index at extreme scale; project+window bound
  it meanwhile — task #79/#95). `getRunTrends` gains an optional `project` filter
  (one `AND project = $` clause) for a project-scoped failures/runs/hits series,
  **byte-identical when absent**. Routes: `GET /v1/branch-failures?project=&
sinceDays=&limit=` (project required → 400) + `project` passthrough on
  `/v1/trends/runs`; the client `getHistory` now threads `project`/`task` (the
  route already supported them). **Load-bearing gate fix:** `/v1/branch-failures`
  is a single-segment route, so it had to be added to the `isAnalyticsSurface`
  allowlist in `server.ts` — otherwise a session request FALLS THROUGH to the SPA
  catch-all (returns the `vx-cloud` string, not JSON), the exact class as the
  earlier `/v1/notifications`/`/v1/why` fixes; caught by the browser verify
  (branch card empty), pinned by a server e2e (session reaches analytics → JSON
  with firstBranch, not the SPA). **UI (pure-JSON view + data helpers, one
  reusable component prop — zero core change):** `projectDetail.json` gains a
  `TimeframeSelect` header, a failures-&-runs `LineChart` (`projectFailureTrend`),
  a "how this project ranks" card (three axes — failure rate / avg exec / hit
  rate — each a `RankList` with the current project highlighted), a "where
  failures were first noticed across branches" `DataTable`, a **Δavg column** on
  the task-history table (each task's period-over-period avg delta as a red/green
  dot), and a **recent-executions** table (row → the run with this task
  pre-selected so logs open, hash → the cache entry — the one-click debug ask).
  `data.ts` helpers: `rankProjects` (client-side over the one `listProjects`
  GROUP BY — top-8 per axis + always the current project with its true rank,
  `_rankLabel`/`_me`), `mergeMoverDelta` (lifetime `getHistory` ⨝ analysis
  `movers` for the Δavg column), `branchFailureRows`; every project source
  windows off `?window` via `windowDaysOf`/`trendArgsOf` (lifetime table stays
  all-time on purpose — the "over time" story is the trend cards). `scopedTrend`
  gained a `windowDays` param (default 7 → pages without the selector
  byte-identical); `RankList` gained a `highlightKey` prop (ring the row when
  `item[key]` is truthy). **Windowing rides the proven params-refetch path** (the
  json-render loader keys sources on decoded params+`?window`, so a chip re-fetches
  every project source in place). **Verified END-TO-END in a real browser**
  (real platform + fake S3 + Chromium, seeded via the ingest wire across two
  projects and multiple branches): every card renders, `app#e2e` attributes to
  `feat` as the first-noticed branch, the three-axis ranking + Δavg column + recent
  executions all render, the window chips rescope every project-scoped `/v1/*`
  request (branch-failures `sinceDays` + trends `project=` over the exact span),
  ZERO console errors. NO CACHE/schema/wire bump (read-side only). Cloud
  analytics-read 39 (+2: branch-first-failure ordering + ignores-success/null-
  branch) + server 31 (+1: allowlist-reaches-analytics) pass, UI 64 pass, lint+
  fmt clean, `dist/` unchanged (gitignored build artifact). **DEFERRED (phase 2/
  3):** true per-task per-bucket sparklines (`getProjectTaskTrends` + a `SparkList`
  component); regressed-vs-always-broken flag on #5; a branch facet on recent
  executions.

- **2026-07-14**: **Insights timeframe selector — 24h/7d/30d/90d, URL-persisted
  (`ba3e7b9`)** (owner: "I should be able to select a timeframe for stats").
  A preset chip row on the Insights analytics hub rescopes every windowed
  source: the run/hit-rate tiles, the trend chart (24h → hourly buckets over
  the last day; longer → daily over the span), heatmap, storage growth, the
  period-over-period movers, cross-branch regressions, bottlenecks. **Mechanism
  = the already-proven params-refetch path:** the json-render loader
  (`jsonPage`) keys its resources on the decoded query params, so a new
  `?window` re-fetches every source in place — identical to the Runs facets.
  New `TimeframeSelect` catalog component reads/writes `?window` (normalizes an
  absent value to the 30d default on mount, so the page is consistently
  windowed + shareable); `data.ts` `windowDaysOf`/`trendArgsOf` translate the
  token to each source's args, **defaulting to that source's OWN window when
  absent** so pages without the selector (Cache, Overview, deep-links) stay
  byte-identical. Only server change: `getCacheStatsSql` gains an optional
  `windowDays` (default 1 = 24h), clamped to `MAX_WINDOW_DAYS`. Selector-
  controlled tiles drop their hardcoded `(24h)`/`(this 7d)` labels — the
  selector states the window once (the Grafana/Datadog pattern). **Scope
  decision:** Insights-only + presets (the AskUserQuestion permission stream
  closed, so I took the highest-value default; the mechanism is reusable for a
  Cache/global extension). Pinned by a `windowDaysOf`/`trendArgsOf` unit suite +
  a `getCacheStatsSql` window test, and **browser-verified end-to-end** (real
  platform + Chromium: chips rescope the `/v1/*` requests — `windowDays` 1/30/90
  - `bucket` hour↔day over the exact span, URL persists, ZERO console errors).
    NO CACHE/schema/wire bump. Cloud analytics-read 37 pass, UI 64 pass, lint+fmt
    clean; `dist/` unchanged (gitignored build artifact).

- **2026-07-14**: **Improvement cycle 5 — periodStats percentiles into SQL + two
  fresh-audit fixes (invocations retention, RunsView cross-tenant stale display)
  (`adda10e`, `9899d1e`)** (owner: "Never stop. Follow cycles." + "Why do you
  stop"). **(1) periodStats p50/p95 in SQL (`adda10e`):** it fetched EVERY
  executed-success duration in the window into JS (no LIMIT) to compute
  avg/p50/p95 — the last raw-row-fetch scale hazard (tens of millions of rows at
  target scale). Folded into the aggregate via
  `percentile_cont(…) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE non-hit
AND success)` over the same subset the old `durs` query used, so durations
  never leave Postgres. **No cross-surface inconsistency introduced:**
  getHistory/getFlakiest/getTaskDetail percentiles already run over a DIFFERENT
  population (the last-50, `rn<=50`) than periodStats' full-window set — never
  comparable raw values — so the JS floor-index (`pickPercentile`) stays at those
  bounded sites and only the unbounded one moved to SQL. New test pins avg 300 /
  p50 300 / p95 480 over a 100..500 spread (a cache-hit + a failed row correctly
  excluded) + the empty-window→undefined case; the getPeriodComparison scale
  bench stays green. **(2) Fresh core-cache + UI-tsx audit → two fixes
  (`9899d1e`):** **LOW** — `Cache.close()` pruned `runs` at 30d but never the
  sibling `invocations` header table, so on a long-lived checkout it grew
  unbounded AND the header outlived its `runs` rows (`vx info`/`vx mcp` would
  list an invocation whose task detail was gone); now pruned on the same window.
  **MED** — `RunsView` held `lastGoodInvocations` outside the resource (to
  survive a transient failed poll) but never reset it on a connection change, so
  switching to org B whose first `/v1/invocations` fetch fails rendered org A's
  run history + CI-health + facets under org B until a successful B fetch — a
  stale cross-tenant DISPLAY (server scopes correctly; the client fell back to
  the prior tenant's cached rows); reset on a `getConnectionKey` change
  (deferred). **The audit CONFIRMED SOUND:** the cache key derivation, the
  trust-OID/dirty-prune + tar-traversal defenses, `markRemoteAbsent`/`inflight`
  dedup, the in-flight GET dedup's URL keying (includes `?org=&ws=` — no
  wrong-scope coalesce), the Flamegraph input-order safety, and every other
  timer/WS/rAF teardown + auth/scope reconciliation. **DEFERRED — a partial-index
  migration is NOT a clean drop-in:** `getNotifications` (`WHERE failed_count>0`)
  and `getRecentFailures` (`task_runs WHERE status='failed'`) walk past the
  majority-passing rows and would benefit from partial indexes, BUT the migration
  framework applies all migrations in ONE transaction under an advisory lock, so
  a plain `CREATE INDEX` on the 50-100M-row `task_runs` would hold a multi-minute
  lock on every deploy — it needs `CREATE INDEX CONCURRENTLY` (non-transactional),
  which the framework can't express; wants a CONCURRENTLY-capable migration path
  first. NO CACHE_VERSION/schema/wire bump. Core 87 cache tests + 60 UI pass,
  cloud analytics-read 36 pass, lint+fmt clean.

- **2026-07-14**: **Improvement cycle 3-4 — heatmap SQL-bucketing + two
  end-of-run hang fixes, from a fresh core-exec/cloud-server audit (`0e5ec76`,
  `dad5d58`, `99adf96`)** (owner: "Never stop. Follow cycles."). **(cycle 3,
  `0e5ec76`)** `getRunHeatmap` streamed every task_run in the window into JS to
  bucket a 7×24 grid — at the platform's 50-100M-rows/day target that's tens of
  millions of rows over the wire per request. Moved into a `GROUP BY` returning
  ≤168 rows, byte-identical: Postgres `EXTRACT(DOW)` is Sun=0..Sat=6 (== JS
  `getUTCDay`) and integer `started_at / 1000` drops the sub-second remainder,
  which can never cross an hour boundary. Pinned by a UTC-cell test (incl. the
  HH:59:59.999 truncation edge — the former total-only assertion never covered
  the mapping) + a scale guard (`dad5d58`). The `periodStats` p50/p95 has the
  same streaming shape but wants a COORDINATED percentile-strategy change across
  ALL the p50/p95 sites (getHistory/getFlakiest use a JS floor-index) rather than
  a piecemeal SQL percentile that would diverge cross-surface — deferred.
  **(cycle 4, `99adf96`, a repro-mandated core-exec + cloud-server audit) — two
  end-of-run HANG paths, both when the direct child exits but a descendant
  lingers:** (1) **MED** `runCommand`/`runSandboxed` gate on `proc.exited` then
  `await streams`, but only abort the readers on the TIMEOUT path — a task that
  backgrounds a process inheriting fd 1/2 (`server & echo up`; a compound
  command stays `sh -c`, so `sh` exits while the grandchild holds the pipe)
  never EOFs, so on a NORMAL exit `await streams` blocks FOREVER (no default
  timeout) and the scheduler slot never frees → `vx run` hangs. New shared
  `drainOrAbort` lets a clean exit EOF at once (normal tasks pay nothing;
  residual is bounded by the pipe buffer since streamToString drains during the
  run) and aborts a stuck reader after a 250ms grace, returning what it
  captured. (2) **LOW-MED** the end-of-run shutdown of dependency-only
  persistent tasks awaited their exit after SIGTERM with no timeout/SIGKILL
  escalation — a persistent dep that traps/ignores SIGTERM hung a normal
  completion; now bounded (2s grace → SIGKILL the stragglers). Both timers are
  cleared + unref'd so a fast shutdown never delays CLI exit. Regressions pin
  both (`sleep 10 & echo up` returns <3s not ~10s; a SIGTERM-trapping persistent
  dep completes <8s not ~30s). **The cloud server surface (auth gate,
  machine-token/session split, CSWSH/Origin, org-scoped broadcast, SigV4,
  artifact-store immutability/caps/scopes, CSRF) was audited and verified FULLY
  SOUND — zero reachable defects.** The scheduler's 2-D resource admission
  (float-residue/holder-count solo-clamp, park/repush FIFO) + the execute-task
  retry/verify-restore were also confirmed sound. NO CACHE_VERSION/schema/wire
  bump. Core gate green (1267 pass, 0 fail), cloud analytics-read 35 pass, lint+
  fmt clean.

- **2026-07-14**: **Improvement cycle 2 — turbo-preset escaping + a cloud
  cross-tenant DoS + UI fetch-dedup/dead-code, from two fresh parallel audits
  (`d7c6269`, `23f35a2`, `eed4b5a`)** (owner: "Never stop. Follow cycles.
  Improve all aspects on vx an vx cloud"). Ran a fresh repro-mandated cloud
  audit + a UI audit; acted on the verified findings. **(1) migrate-turbo preset
  escaping (`d7c6269`):** `renderPreset` emitted each global array entry as a
  naive `'${x}'`, bypassing the config emitter's escaping `quote()` — a
  `globalDependencies` glob with a `'`/`\`/newline (legal on Linux, verbatim in
  turbo.json = a system boundary) produced a malformed, unloadable
  `vx-preset.ts`. `quote()` moved to a leaf `migrate-emit.ts` so both the
  emitter and the preset renderer import it as a VALUE without closing a runtime
  cycle (migrate.ts already imports the turbo mapper — a value back-import
  tripped `import(no-cycle)`); test imports the generated preset through Bun's
  TS loader. **(2) HIGH cloud cross-tenant DoS (`23f35a2`):** `getRunTrends` /
  `getStorageGrowth` fill their output arrays with a SYNCHRONOUS
  `for (t = start; t <= end; t += bucketMs)` loop bounded only by unclamped
  client params — `GET /v1/trends/runs?from=0&to=1e15` drives ~2.7e8 iterations
  (and `?days=1e9` the storage loop), allocating hundreds of millions of points
  → freeze/OOM of the SINGLE-THREADED, MULTI-TENANT server for EVERY tenant,
  triggerable by any authenticated viewer/ci token in one request. Fixed:
  clamp the derived span to `MAX_TREND_BUCKETS` (10k, keeping the most-recent
  buckets; `to` capped at now). The same unbounded span made `getRunHeatmap` /
  `getPeriodComparison`'s raw-row fetches degenerate to full partition scans via
  a huge negative `since`/`from` — clamped their day/window to `MAX_WINDOW_DAYS`
  (~1yr). Legit dashboard ranges (24h/30d/7d) are far under the caps → results
  unchanged; regression test asserts a hostile span returns a bounded array in
  <1s. (The SQL-side percentile/bucket rewrite for the raw fetches at
  50-100M-row scale is the deeper follow-up.) **(3) UI dedup + dead-code
  (`eed4b5a`):** in-flight GET coalescing at the `getJson` choke point — a
  view's sources fetch concurrently, so run-detail's `run` + `runSelectedTask`
  both GET the largest `/v1/runs/:id` (doubled every 5s poll on the common
  `?task=` deep-link) and task-detail's detail/flaky/config overlap the
  recommendations aggregator; sharing one promise per URL (cleared on settle —
  coalescing, not a cache) removes the duplicates with no view restructuring.
  Dead-code: the Cache view fetched `prunable` (a Postgres scan) every 30s poll
  but only Insights renders it (dropped); the `projects`/`invocations` sources +
  the `LiveActivity` SSE component had zero references (deleted); `hitSplitRows`
  returns `[]` on zero hits so the table shows its honest empty state. **The
  cloud audit CONFIRMED SOUND:** the branch→trunk duration-hint leak invariant
  (validates cycle-1's trust-scope work), the CTE rewrites, artifact-store trust
  scopes, migrations/partitions, the read-side tenant clamp, and ingest
  idempotency. NO CACHE_VERSION bump (cloud + UI + a migrate-emit refactor).
  Core 1654 pass (full-suite 19 "fails" were the documented pg-slot + perf-guard
  flakes under concurrent load — metrics/migrate/run-context all green in
  isolation), cloud analytics-read 34 pass, UI 60 pass, lint+fmt clean.
  **DEFERRED (next cycles):** the MED SQL-side percentile/bucket rewrite
  (periodStats/heatmap at scale); the trusted-GET S3 HEAD-skip (still wants an
  adversarial pass); `Stack` (a trivial unused layout primitive — kept as a
  reusable JSON-view building block, unlike the heavy dead `LiveActivity`).

- **2026-07-14**: **Improvement cycle 1 — two parallel read-only audits (core +
  UI) drove five verified fixes across correctness/perf (`5a35824`, `aa6a56f`,
  `9b16390`, `d7fa982`, + normalizeRemoteUrl)** (owner: "Never stop. Follow
  cycles. Improve all aspects on vx an vx cloud"). Ran a core-audit agent + a
  UI-audit agent (read-only, ranked findings), then fixed the top verified ones,
  each repro'd before the fix. **CORE (all confirmed by executed repro):** (1)
  **HIGH — `computeNestedProjectDirs` interloper bug** (`nested-dirs.ts`): the
  contiguous-run scan `break`s on the first non-descendant, but a sibling whose
  name extends the parent by a char sorting BELOW `/` (`-`/`.`/`+`/space) lands
  between `foo` and `foo/` — so `foo`,`foo-utils`,`foo/nested` returned an EMPTY
  nested set for `foo`, silently breaking the hard project-boundary invariant
  (foo's globs then fold foo/nested's files into its key; a broad `outputs.files`
  could clean/capture another project's files). Fixed to skip interlopers and
  stop only past the parent's string-prefix block. (2) **HIGH (subdir layout) —
  stale cache hits + `--affected` under-selection when the workspace root is a
  git SUBDIR** (`inputs.ts`, `affected.ts`): `git ls-files` prints
  cwd(workspace)-relative paths but `git status`/`diff` print repo-root-relative
  ones, so the dirty set never matched the trusted-OID map → a modified tracked
  file kept its committed OID → STALE HIT (old outputs), and `git diff`'s
  `code/pkg/x` resolved to `<root>/code/pkg/x` → project not flagged affected.
  Fixed: normalize `status` by the `--show-prefix` (a trivial concurrent 3rd
  git spawn, no tree scan — wall-clock unaffected) + `git diff --relative`.
  No-op when workspace==git root (common case byte-identical). (3) **LOW-MED —
  `normalizeRemoteUrl` leaked an explicit port** into the workspace id
  (`:2222/` → `/2222/`), so a ported SSH URL and the HTTPS URL of the SAME repo
  derived different ids; now stripped (protocol-form only, so a numeric scp path
  segment isn't mistaken for a port). **UI (from the dashboard audit):** (4)
  throttled the four analytics views (insights/cache/artifacts/overview) from a
  5s to 30s auto-refresh — they show 7-30d aggregates (getCacheSavings ~430ms,
  …) that barely move, so 5s was ~6-12× the necessary Postgres/network load per
  open tab (runDetail stays 5s for live fill-in); (5) semantic hit-split bar
  colors (a `colorKey` literal-token column option → cache-local/cache-remote,
  vs the arbitrary hashed hues) + fixed the taskDetail CPU% column keying a
  nonexistent `_cpuPct` (→ `cpuMs`). Also a small perf touch: `LocalHistoryProvider`
  filters on `(project,task)` tuples so the `runs(project,task)` index SEARCHes
  instead of full-SCANs (the concatenated-expression it used defeated the index;
  ~5-11%, opt-in predictive path). NO CACHE_VERSION bump — the two key-affecting
  fixes (nested-dirs, subdir stale-hit) only change keys for the specific buggy
  layouts and are self-healing (new key → miss → re-run → re-cache, never a wrong
  hit); every other layout is byte-identical. Pinned by new suites
  (`nested-dirs.test.ts` interloper matrix, `git-subdir-workspace.test.ts` both
  subdir fixes on a real repo, normalizeRemoteUrl ports) + the spawn-count guard
  updated 2→3 (concurrency is the invariant, not the literal count). Core 1264
  pass, lint+fmt clean. **DEFERRED (verified, next cycles):** the trusted-GET S3
  HEAD-skip (real hot-path win but changes a security-boundary test's shape —
  wants an adversarial pass; reverted this cycle); core double-hash-on-miss
  (#4, perf); restore-hit dead exitCode branch (#6); migrate-turbo preset
  escaping (#8); UI restore-"see it run"-on-platform (#1, a feature) + dedup
  task-detail fetches (#3) + delete dead LiveActivity (#4).

- **2026-07-14**: **Lookahead scheduler — architect-designed, measured, NOT
  built; the scheduler-policy benchmark IS the deliverable (`bench/schedule-
policy.ts`)** (owner: "Critical path should always be prioritized but we
  should also be smart and predict… to not schedule a task that would block
  critical. But also not wait for critical and do nothing"). Design
  `docs/design/lookahead-scheduler-2026-07.md`. **Verdict: don't build
  reservation/lookahead admission.** The owner's three constraints are
  self-resolving — (1) "prioritize critical path" is ALREADY the opt-in
  time-based `remCP` priority (`computePredictedPriorities`, near-optimal LPT-
  on-a-DAG); (3) "never idle" is ALREADY a hard invariant of the
  work-conserving `tick()`; and (3) forecloses idle-insertion, the ONLY
  lookahead with theoretical teeth — leaving only work-conserving REORDER,
  which `remCP` already does. Worse, the naive "prefer a shorter ready task to
  free a worker for critical" is an SPT bias, and a clean Graham anomaly
  (design Example D) shows it REGRESSES makespan (30→32) — it optimizes
  critical-task START LATENCY at the cost of makespan, a real and often-losing
  trade. It'd also break the tested determinism invariant (schedule order is a
  pure function of priorities+graph+completion order; wall-clock lookahead
  makes it unpinnable). Full mechanism specified (Phase 3, opt-in
  `lookahead: true`, logical-clock not wall-clock, no-op-without-data) so it's
  a build-or-not decision if a latency need ever surfaces — prior: skip.
  **Phase 1 SHIPPED — the benchmark**, the instrument that turns every future
  scheduling claim into a number. `bench/schedule-policy.ts` (no `src/`
  change; exported `mergePriorities` from scheduler.ts so the bench uses the
  REAL merge, no drift) replays 9 graph shapes through a deterministic
  discrete-event sim of `runGraph`'s greedy exec-tier list policy
  (self-validated against 3 hand-computed makespans incl. Example D = 30;
  logical durations, no wall-clock, so it's flake-free and a 2000-node graph
  measures in ms). Compares `count` (duration-blind default) vs `remCP` (warm
  predictive) vs `remCP-cold` (empty-history predictive = the cold-cache case).
  **Measured finding (`bench/schedule-policy.md`):** structured shapes (chain/
  fan/diamond/anomaly/work-bound/cp-bound) tie EXACTLY (0.0%); warm predictive
  wins **−2.0% mean makespan + latency** on realistic mixed-duration DAGs;
  **BUT cold predictive can REGRESS +0.1..+0.9%** (uniform-duration fallback
  is a worse heuristic than reverse-dep-count on some shapes). **So the
  benchmark CORRECTED the naive Phase-2 plan:** don't flip `predictive`
  unconditionally default-on — the win-only form is DEFAULT-ON ONLY WHEN
  HISTORY IS PRESENT (warm), keeping count on a cold cache (ties exactly).
  Phase-2 cost MEASURED (the decisive number): `LocalHistoryProvider.loadFor`
  = ~280 ms on a synthetic 2000-task / 60k-run warm cache.db (1.6 ms on this
  repo's 10-task DB) — added to the DEFAULT path it would MORE THAN TRIPLE the
  ~120 ms warm `vx run` on a large monorepo, on EVERY run including all-cache-
  hit warm runs where the -2% ordering win doesn't even exist. FINAL
  CONCLUSION: do NOT make `predictive` the default — keep it OPT-IN (the
  current design is correct); the whole scheduling thread resolves to "don't
  build lookahead, don't flip the default." The -2% win only lands on
  execution-heavy mixed-duration runs, exactly what a user opts into with
  `predictive: true`. (Root cause of the 280 ms: the query filters on
  `(project||'#'||task) IN (…)`, a concatenated expression the
  `runs(project,task)` index can't serve → full scan; rewriting to a
  tuple-filter is a noted low-priority future optimization, not urgent.) NO
  CACHE/SCHEMA/wire change (bench-only + one added export). Core ci green.

- **2026-07-14**: **Duration hints are TRUST-SCOPED like the cache — timing
  from main is accessible on a branch, but nothing from a branch leaks to main
  (`873be25` capture + `<this>` scoping)** (owner: "I can be experimenting on a
  branch increasing task time for all later on as avg will increase… take into
  account PRs, don't count their times into main" → "It should work like with
  cache. Timing from main should be accessible in branch but nothing from branch
  leaks to main. It is untrusted"). The SHARED cloud LPT hint `taskDurationHints`
  averaged `duration_ms GROUP BY project#task` over ALL of a workspace's
  `task_runs`, so ONE dev's slow branch experiment permanently skewed the average
  EVERY distributed run used to order dispatch. (The local predictive p50 reads
  the single-user local `runs` table — no branch column, transient — left as-is;
  the SHARED cross-dev vector is the one that mattered.) **Signal:** capture the
  repo's DEFAULT branch — `captureDefaultBranch` in `run-context.ts` (GitLab
  `CI_DEFAULT_BRANCH` → GitHub event-payload `repository.default_branch` →
  `git symbolic-ref --short refs/remotes/origin/HEAD` stripped → null; never
  throws, one best-effort read/spawn, paid only when telemetry is active),
  threaded ADDITIVELY through `RunContextRecord.defaultBranch` (telemetry v2
  unchanged — the `attempts`/`verify`/`outputFp` precedent). A run is TRUNK iff
  `branch === defaultBranch` (both non-null) — subsumes BOTH PRs (head ≠ default)
  AND feature-branch pushes with one field, no isPr boolean. **Storage:**
  migration `0008` adds nullable `invocations.default_branch` (ADD COLUMN on the
  partitioned parent cascades); ingest writes it. **The model = the artifact
  store's `readScopeSpecs`** (owner's "work like with cache"): a TRUNK submission
  reads ONLY the trunk baseline — a branch experiment's slow timings can NEVER
  reach it, and a task with no trunk timing simply has no hint (→ FIFO), NEVER a
  branch value (this REPLACES the first cut's `COALESCE(trunk, all)` fallback,
  which was itself the leak — it served branch timings to main when a task had no
  trunk data). A BRANCH submission reads its OWN branch's timings FIRST, falling
  through to trunk for tasks it hasn't run on its branch, and NEVER another
  branch's (`COALESCE(avg FILTER (branch=own), avg FILTER (trunk))` — the
  own-sub-scope-then-trusted order of readScopeSpecs; one PR can't see another's,
  exactly like the per-PR untrusted sub-scope). So a dev on a branch benefits
  from their own accumulated (changed) durations layered over main, with zero
  leakage up or sideways. **Scope on the wire:** `branch`/`defaultBranch` are
  additive-optional on `DistSubmitMessage` (advisory, absence→trunk, NO
  DIST_PROTOCOL bump — the telemetry-additive precedent); `dispatch.ts` passes
  `{branch, defaultBranch}` from the submit into `taskDurationHints(ws, scope)`;
  the memo is keyed per (workspace, scope). LEFT JOIN → a task_run with no
  invocation header is un-attributable to any branch and feeds NO scope (only
  provably-scoped runs move a baseline). Advisory + memoized-30s, so the added
  per-row invocation lookup (existing `getRegressions` join; `invocations_run_id`
  index) is off the outcome path. **Analytics dashboard avgs left as-is on
  purpose** — those surfaces WANT per-branch data (regressions already split by
  branch; "did MY PR make this slower" needs to see the PR run); only the shared
  SCHEDULING hint is scoped. NO CACHE/core-SCHEMA/telemetry-wire bump (telemetry
  field additive; local `runs` untouched). Tests: core `captureDefaultBranch`
  env/git matrix + façade snapshot; cloud a trunk submission excludes a 10×
  branch experiment (150 not 2000) + a task only on `exp2` is invisible to trunk,
  a branch submission sees its own `exp` timing (2000) over trunk + falls through
  to trunk for un-run tasks + never sees `exp2`, a null-default scope reads trunk,
  - a `dist:submit` branch/defaultBranch wire round-trip. Core 1257 pass, cloud
    analytics/dist/wire green (full-suite fail is the pg `too many clients`
    connection-slot flake, schema-smoke suite, passes isolated), lint+fmt clean.
    **Follow-on (deferred):** local predictive p50 stays branch-agnostic (would
    need a branch column on the local `runs` table — a core SCHEMA bump — for a
    single-user cache whose experiments skew only that dev's next local run; not
    worth it vs the shared vector). Filtering the analytics-baseline avgs
    (listProjects/getHistory/trends) to trunk is a separate, deliberately-unmade
    choice (per-branch surfaces by design).

- **2026-07-13**: **Core-audit completion — four defects in the previously-
  unreviewed watch/migrate/lockfile/loader modules fixed (`780eac1`)** (cycle-4;
  a repro-mandated hostile reviewer). **HIGH (data loss):** output/workspace
  globs accepted `..` path segments, and `cleanOutputs` rm()s resolved output
  paths before EVERY run while `Bun.Glob.scan` follows `..` out of cwd — so
  `cache.outputs.files: ['../victim/**']` (or `outputs.workspaceFiles:
['../above.txt']`) deleted files OUTSIDE the project / above the repo root, a
  direct violation of the hard project-boundary invariant (real-CLI repro
  deleted a committed sibling file). The loader now rejects a `..` path SEGMENT
  in outputs.files / inputs.files / workspaceFiles (`foo..bar` filenames still
  fine). **MED:** `vx migrate --from nx` clobbered an existing root
  `vx.config.ts` without `--force` — the SYNTHESIZED workspace-root project has
  no discovered meta, so the meta-only conflict check missed it; the check now
  also stats every actual write target. **MED:** migrate emitted unterminated
  string literals for commands with embedded newlines (`"echo a\necho b"`) →
  the generated config failed to load; `quote()` now escapes `\n`/`\r`.
  **LOW-MED:** `exec.env` was never validated, so a malformed `passThrough`
  reached `buildIsolatedEnv`'s `for..of` (a number threw mid-run, a string
  silently char-iterated) — the loader now validates `exec.env`. NO
  CACHE_VERSION bump (valid configs byte-identical; the `..` rejection only
  errors on configs that were already a data-loss vector). **REFUTED by the
  reviewer (sound):** the watch reentrancy guard (no event loss / no overlap),
  lockfile `--check` + run-side freeze, scoped broken-out-of-scope config.
  Pinned by regressions in project-loader.test.ts + migrate.test.ts; core ci
  exit 0.

- **2026-07-13**: **#79 — the N+1 analytics savings/regression queries rewritten
  as set-based CTEs (`3ad06c8`)** (cycle-4). `listProjects` ran a correlated
  cache-savings subquery PER project (the worst N+1), `getCacheSavings` ran a
  per-hit-row subquery twice, and `getRegressions` ran two per-candidate queries
  (1+2K). Each is now ONE set-based query, output-identical: an `uncached` CTE
  (avg uncached-success duration per project#task) that cache-hit rows join to
  — the inner join IS the old `WHERE avg_dur IS NOT NULL`, and
  `SUM(hit_count × avg)` equals the old per-row sum; getCacheSavings folds the
  24h + all-time figures into one scan via `FILTER`; getRegressions' per-
  candidate window-stats become one GROUP BY and ever-passed one DISTINCT set,
  read from in-memory maps in the loop. Pinned by a differential test
  (`analytics-cte-diff`) that re-runs the OLD per-item SQL as a reference over a
  seeded dataset and asserts the new methods deep-equal it, plus hand-computed
  values; the scale-guard bounds still hold. Cloud 436 pass. (Remaining #79
  items — partition lookback bounds, the trusted-GET HEAD skip, the session
  auth memo — are separate, still open.)

- **2026-07-13**: **Pointer-move cost cut on the charts + flamegraph (P6/P8,
  `69eb856`)** (cycle-4). Both hover handlers forced a `getBoundingClientRect`
  (a sync layout) on EVERY mousemove. **P8 (live — insights/cache/task-detail
  LineCharts):** the tooltip was an IIFE that read the hovered index and
  returned a fresh `<foreignObject>`+`<For>` subtree, so moving between points
  tore down + rebuilt the whole tooltip DOM per index — now a stable structure
  with reactive position/text bindings; the rect is cached on pointer-enter (the
  chart doesn't scroll) and index updates coalesce to one per animation frame.
  **P6 (Flamegraph — used by the run cockpit):** the O(N) min/max time window
  recomputed ~6×/render per cursor move → memoized; the rect cached on enter +
  rAF-throttled. Both cancel any pending frame on unmount (`onCleanup`). A new
  MEASURED guard sweeps the pointer across an insights LineChart and asserts
  ≥40fps + zero long tasks (ui-perf now 5/5 in a real browser). P7 (the
  `RunSession` O(N²) `find`) was NOT actioned — it's the dead spawn cockpit
  (unreachable per the cycle-3 discovery); no live view instantiates the
  Flamegraph either, so P6 is a component hardening, not a live-path fix. Cloud
  435 pass, core ci exit 0.

- **2026-07-13**: **Batched `/v1/why/:runId` — the run-detail "why did this
  re-run" panel is one request + polls live + actually renders on the platform
  (`d34d7e1`)** (cycle-4 C4). The panel fired one `/v1/diff/:runId/:taskId` per
  executed task (bounded 8-concurrent) — a 500-task run = 500 requests — which
  is exactly why the run-detail live-fill work had to pin `runWhy` as a
  fetch-once `staticSources` source. Replaced the fan-out with a single
  `GET /v1/why/:runId`: ONE `LATERAL` query finds each executed task's
  most-recent prior run and compares cache keys, returning the verdict (first
  run / inputs changed / ran without a cache hit) for the whole run. With the
  fan-out gone, `runWhy` joins the live 5s poll and the **`staticSources`
  loader capability was removed entirely** (it had no other consumer — the
  reason I added it in `6a79514` is now moot). **Two latent bugs fixed along
  the way:** (1) the why TABLE was gated `visible: capsCacheMissing not-true`,
  so since the platform pivot (no local cache.db) it showed ONLY a "run vx why
  locally" hint and NEVER the verdict — the table now always renders the
  per-task verdict (derived purely from Postgres `task_runs` hashes), with the
  per-file/env/dep detail noted as local-only; (2) the old client logic
  labelled a hash-change as "not cacheable / forced" because it only checked
  for fingerprint `entries` (never present on the platform) — the batched
  server compares hashes directly, so a real key change reads "inputs changed".
  The single-segment route needed adding to `isAnalyticsSurface` (the same
  allowlist-or-fall-through-to-SPA class as the `/v1/notifications` fix), pinned
  by a server e2e. Dead code swept: `whyRows`/`changeToken`/`diffText` +
  the fingerprint-detail columns + the `WhyRow` fan-out shape. Verified in a
  REAL browser: the panel renders "inputs changed" with exactly ONE `/v1/why`
  request and ZERO `/v1/diff`. Cloud 435 pass, core ci exit 0.

- **2026-07-13**: **Adversarial review of the incremental-ingest wave — VERDICT
  SOUND, zero production-reachable defects; two consistency follow-ups shipped
  (`1e7f206`)**. A repro-mandated hostile reviewer (real ephemeral pg + the real
  wire) swept all seven defect classes; every one REFUTED by an executed repro:
  (1) dedup-key alignment — both paths route through the SAME `insertTaskRun`
  and derive `(started_at, run_id, project, task)` from the same
  `endedAtMsAtStart` + the same `outcome.wallclockStartNs.toString()`
  (byte-identical); (2) partition + `ON CONFLICT` — the unique index propagates
  to parent + `task_runs_default` + every weekly partition, and dedup holds on
  the DEFAULT and real partitions; (3) aborted/cache-hit consistency — both
  paths skip aborted, cache-hits go batch-only (the sink's `miss` guard), and
  every retained log tail is `takeEntry`'d so the batch drain never
  double-ships; (4) log double-ship — unreachable in the single-client flow
  (takeEntry before drain, no client retry); (5) auth/tenant — session→403,
  no-auth→401, ci→200, `org_id` always token-derived, body `workspaceId` routed
  WITHIN the org; (6) body validation — 8 malformed bodies→400, over-cap→413,
  malformed-ns→200-with-null (`intNsOrNull`); (7) run.start coupling —
  `TELEMETRY_SCHEMA_VERSION` stays 2, additive, otel ignores it, plain runs
  byte-unaffected. Plus a NEW surface: concurrent first-pushes of a new
  workspace (N tasks finishing at once) converge to ONE workspace via
  `routeWorkspace`'s unique-violation retry. **The one test "fail" (DEFECT-2)
  was a TEST ARTIFACT** — it did a raw `CREATE TABLE … PARTITION OF` that
  bypasses the production `maintainPartitions → createPartitionMovingDefault`
  recovery; I pinned the real path with a regression test (a DEFAULT-resident
  incremental row + `maintainPartitions` creating its covering partition →
  the row moves out of DEFAULT with zero warnings and dedups to one row).
  **Two follow-ups shipped:** `/v1/ingest/task` now gates on the wire version
  (400 on skew, parity with `/v1/ingest/logs` + `/v1/catalog`); the recovery
  regression test committed. Accepted residuals (informational, no action): a
  dropped incremental POST loses that task's LOG tail (the row is still
  recovered by the batch backstop — the documented best-effort-logs tradeoff);
  the log insert's SELECT-then-INSERT has no unique guard (a partitioned unique
  index can't dedup it — `created_at` differs per path — but the normal flow
  never double-delivers); 400 bodies echo internal exception text (consistent
  with the route, ci-token-only). Cloud 434 pass, core ci exit 0.

- **2026-07-13**: **Run detail fills in LIVE + a vacuous perf-guard fixed
  (`6a79514`, `3fc3843`)** — completing the incremental-ingest payoff. The
  `runDetail.json` view had NO refresh interval, so a page opened during a run
  stayed frozen at load-time state; per-task rows landed in Postgres but an
  open dashboard never showed them without a manual reload. Added
  `refresh: 5000` (the same visibility-aware tick the overview/cache/insights
  views use; the equality gate reuses byte-identical values → a finished run
  polls with ZERO DOM churn). The expensive `runWhy` source (a per-task
  `/v1/why` fan-out) must NOT repeat every tick, so the loader gained a
  per-source refresh control: a new `staticSources` list on a JSON view names
  sources that fetch ONCE (params/connection changes still re-fetch) — `runWhy`
  is static; `run`/`invocation`/`artifacts`/`selectedTask` poll live. **Verified
  in a REAL browser** (ephemeral pg + fake S3 + the built SPA): two
  incrementally-ingested tasks render, then a third seeded mid-view appears
  after one 5s poll WITHOUT a reload. **Discovery (`3fc3843`):** the committed
  `ui-perf` guard was VACUOUS — `bootPlatform` never passed `uiHtmlPath`, so the
  server returned the API-only `'vx-cloud'` fallback at `/` and the guard
  navigated to a BLANK page; its ≥40fps + zero-long-task assertions passed
  without ever rendering the dashboard. `bootPlatform` gained an optional
  `uiHtmlPath` (off by default so API-surface suites don't touch the dist) and
  the guard now serves the built dist — it renders the real 400-task run detail
  - 120-run list and STILL measures ≥40fps / 0 long tasks (4/4 green). Cloud
    433 pass, ui-perf 4/4 (now real), core ci exit 0.

- **2026-07-13**: **Per-task incremental ingest — each EXECUTED task reports
  its result + logs as it finishes, not batched at run end (`9a29a51`)**
  (owner: "We should report each task same as we report result — logs should
  go together or even be streamed as they go"). Before, the `cloud()` plugin
  shipped a run's task rows + logs in ONE bundle at run end (`POST /v1/ingest`
  after the summary), so a long run's dashboard stayed EMPTY until the final
  task completed — you couldn't watch a run fill in, and the per-task logs a
  dev wants mid-run were unavailable until every task finished. Now the sink
  fires `POST /v1/ingest/task` on each `task.end` (result + retained log tail),
  so the run-detail page fills in live and each task's logs are queryable the
  moment it completes. **Executed-tasks-only** (`cacheSource === 'miss'` +
  status success/failed): cache hits complete in BURSTS carrying no captured
  output, so they're left to the end-of-run batch — the incremental burst
  tracks wall-clock WORK, not a fan-out of instant restores (bounds the push
  rate). **Unified by a task_runs idempotency key** (migration 0007:
  `UNIQUE(started_at, run_id, project, task)`): the end-of-run batch re-inserts
  every task with `ON CONFLICT DO NOTHING`, so incremental is a pure LATENCY
  win, the batch stays the completeness BACKSTOP, and a dropped incremental
  POST is recovered by the batch. **The load-bearing coupling:** both paths
  must derive the dedup `started_at` from the SAME canonical run start or the
  key splits into duplicate rows — threaded through a new ADDITIVE `run.start`
  telemetry field (`startedAt`, = the run's `endedAtMsAtStart`), so the keys
  match byte-for-byte with **no TELEMETRY_SCHEMA_VERSION bump** (stays 2).
  **Logs best-effort:** `TaskLogBuffer.takeEntry(taskId)` removes a task's tail
  once sent, so the end-of-run drain never double-ships it; the `task_runs` row
  is the guaranteed record. **Server:** `Analytics.ingestTask` (routes ws →
  inserts one task_run via the shared `insertTaskRun` + provisions project/task
  - inserts the log tail idempotently; aborted tasks store nothing);
    `POST /v1/ingest/task` (ci-token-only, 2 MiB body cap) added to
    `isAnalyticsSurface` (a SESSION 403s — pinned). **Sink** (`plugin.ts`):
    `incremental = connection !== undefined`; `wants` = `['run.start','task.end']`
    when connected (+`'task.log'` when logs enabled — the chunk path stays free,
    result reporting is separate). Verified: server e2e (session→403, token→200,
    run detail + logs render BEFORE any summary), plugin unit ("reports each
    executed task incrementally"), the batch-dedup differential (incremental +
    batch of the same run → one row per task). Cloud 433 pass, core ci exit 0.
    **Deferred:** a live "running" header row in the runs LIST (Phase 2 — wants a
    schema for in-flight state) and mid-task CHUNK streaming (Phase 3 — stream
    `task.log` chunks as they arrive, not just the retained tail at task end).

- **2026-07-13**: **Dashboard is a real SaaS app — self-service profile,
  change-password, a notification bell, and a Settings hub (`81ac87e`…,
  `581fa07`)** (owner: "Redesign ui to be real sass with profiles switching
  orgs workspaces notifications etc settings"). Org + workspace switchers
  already existed (P4); this added the identity/notification/settings
  surfaces. **Server (wave 1, no schema bump):** `/v1/auth/me` now carries
  `email` + `displayName` — the session principal only loaded
  `instance_admin`, so the account menu literally could not show who was
  signed in; `sessionPrincipalFor` selects them. New `PATCH /v1/auth/me`
  (rename — the one self-service field; email is the immutable login
  identity), `POST /v1/auth/password` (verify current via argon2 → ≥8-char
  new → re-hash; session + CSRF only, a bearer 403s), and
  `GET /v1/notifications` (the bell feed: recent invocations that broke
  `failed_count > 0`, newest-first, ONE indexed scan over the invocations
  header — cheap to poll; the client derives unread from a last-seen
  watermark). **UI (waves 2-3):** account menu = avatar(initials) + name +
  email + admin badge + links to Settings/Admin + sign out; a notification
  bell (visibility-aware 30s poll, unread badge vs a per-origin+ws
  localStorage watermark, each item deep-links `/runs/:id`, honest "all
  green" empty state); `/settings` = a personal hub with Profile (rename,
  shell name updates live) + Security (change password, confirm + inline
  banners) tabs + an Organization link out to `/admin`. **Verification fix:**
  `/v1/notifications` fell through to the SPA because the server's
  `isAnalyticsSurface` allowlist omitted it — added, pinned by a server e2e
  (session reads the feed; green → empty, broken run → surfaced). Verified
  end-to-end in a REAL browser (platform + Chromium, seeded via the ingest
  wire): 9/9 flows (bell badge + panel, account-menu email, /settings rename
  reflected in the shell, password change round-trips server-side), ZERO
  console errors; the measured ui-perf guard stays green (4/4) with the
  bell's poll. NOTE: `dist/` is a gitignored build artifact — never
  committed. Cloud 429 pass, lint+fmt clean. Deferred (documented,
  unbuilt): richer notification kinds (regressions/flaky as timestamped
  events would want a schema), per-user notification prefs, avatar upload,
  email change (needs a verify flow).

- **2026-07-13**: **Audit loop cycle 3 — 60fps bar met everywhere +
  virtualization, DX-1..5 shipped, CORE-1 fixed, the perf guard COMMITTED, and
  a dead-code discovery that MOOTS four findings (`f33d1a0`..`2ea9f08`)**.
  Wave 1 (`f33d1a0`): DataTable VIRTUALIZATION (windows rows above 120,
  overscan 12, spacer rows preserving scroll geometry, row height calibrated
  from the first rendered row) + C5's type-aware sort comparator — measured
  after: every §1 scenario ≥55fps with ZERO >34ms frames and ZERO long tasks
  (run-detail(700) 24fps/652ms-spike → 60fps/0). Wave 2 (`81ac87e`,
  `0e7cb09`): DX-1 — `vx-cloud connect` REFUSES a tokenless connect to an
  `auth: account` platform naming the Admin → Tokens fixit (`--anonymous`
  opts in with a loud warning); the silent-401 trap where "connected" showed
  an empty dashboard forever is closed at the front door. DX-5b stale-doc
  sweep (npm replaces every curl-installer/VX_VERSION mention; from-turborepo
  drops the dead "same remote-cache wire" claim, maps `turbo run build` →
  `vx run build --all` with a default-scope bullet, un-claims Bun-required;
  vx-distributed-ci's VX_CLOUD_TOKEN is now `required: true` — the platform's
  machine surfaces are token-only; upgrade.ts strings stop naming the deleted
  install.sh). **CORE-1 FIXED**: `computePredictedPriorities`' traversal never
  actually pushed (all nodes pre-seeded its stack → `stack.includes` always
  true), so it folded reverse-insertion order — and the graph Map inserts
  DEPENDENTS FIRST (pre-order), so every upstream's priority collapsed to its
  own duration on real graphs (the old tests passed topo-ordered nodes,
  masking it). Now an explicit Kahn pass over the dependents relation
  (order-independent, O(N+E)); regression tests pin real pre-order insertion
  - a diamond whose long branch hangs off a short head, both red on the old
    code. DX-2: GHA job summary + check run carry a dashboard DEEP LINK
    (`/#/runs/<runId>`; `details_url` on the check) when a connection resolved.
    DX-5a: the UI vite dev server PROXIES `/v1|/health|/mcp|/events|/stream` to
    the platform (`VX_CLOUD_DEV_PROXY` override) so UI dev is same-origin and
    the session cookie works; ui/README rewritten to the compose recipe. Wave 3
    (`7edfaeb`, `b0e117e`, `2ea9f08`): **`vx why`** (DX-3) — the entry_inputs
    component-level cache-key diff reaches the terminal (latest-vs-previous or
    `--run`, bare-name resolution, `--format json`, honest "fingerprints
    unavailable" degradation; 7 e2e over a real changed-input fixture);
    **`vx-cloud status`** (DX-4) — the connection doctor naming ALL THREE
    silent modes (tokenless-on-account, `VX_CLOUD_DISTRIBUTE` in a workspace
    that never declares cloud() → flagged IGNORED, unreachable/rejected token;
    7 e2e, one per mode); **the perf guard is a committed suite**
    (`packages/cloud/tests/ui-perf.test.ts`: real platform + real Chromium +
    rAF/longtask sampling seeded via the real ingest wire; asserts ≥40fps idle
  - scroll on /runs and a 400-task run detail, 0 >200ms long tasks, 0 console
    errors; SKIPS without playwright/the built dist — playwright is
    deliberately NOT a dependency, resolved via NODE_PATH at runtime and typed
    STRUCTURALLY since a file-level DOM lib reference collides with Bun's fetch
    typings program-wide). **DISCOVERY — P4/P5/P7/C3 are MOOT**: the queue
    protocol has ZERO server-side implementation left (the P4-server fold
    deleted it; `/v1/meta` never advertises `queue`, `/version` 404s), so the
    spawn bar, `queueRun`, `RunSession` and the foreign-jobs poll are
    unreachable dead code — optimizing them would tune code that cannot
    execute. Decision for the owner (audit doc §1 cycle-3): repurpose the live
    surface onto the platform's org-scoped `/stream` (restores dashboard lens
    #1 "see it run" — RECOMMENDED) vs delete the machinery. REMAINING (cycle
    4, task #84): that decision, C4 (fetch cancellation + a batched
    `/v1/why/:runId`), P6/P8 (run-detail pointer-move costs), core-audit
    completion (watch/migrate/lockfile/loader), #79 cloud CTE rewrites.

- **2026-07-12**: **Audit loop cycles 1-2 — measured 60fps dashboard
  (owner: "full audit, document granularly so opus can pickup… real UI
  perf, tested and MEASURED, no stuttering always 60fps… repeat cycles
  until I stop")**. Cycle 1 (`b533a5e`): `docs/design/audit-cycle-2026-07.md`
  — a REAL-browser perf harness (seeded platform: 300 runs × 40 tasks + a
  700-task run; Playwright + rAF frame sampling + MutationObserver)
  measured the 60fps bar FAILED everywhere (Runs scroll 20fps, IDLE 30fps,
  14 console 404s/session); UI mechanism findings P1-P8/C1-C6 verified
  against the @json-render dist (arrays are reference-compared flatten
  leaves → every poll rebuilt every table's DOM); 7 DX/UX flows walked
  with ranked improvements (the `env.ts:156` silent tokenless-connect
  trap; the UI contributor flow broken by wildcard-CORS-vs-credentials);
  5 architecture changes + a strict execution plan. Cycle 2 wave 1
  (`9ae5074`): identity-stable polling (jsonPage equality gate tagging
  each value with its entity + `identityStable()` for RunsView) → **0 DOM
  mutations across 12s of idle polling**; stale cross-entity guard (C1);
  `/v1/runs/queue`+`/version` polling capability-gated (meta `queue`
  flag) → console errors 14→0; value-stable resource sources (C2 —
  planRun no longer refired per click); and the A/B-attributed killer:
  **`backdrop-filter` blur on every Card + sticky chrome WAS the entire
  scroll stutter** (16fps baseline → 60fps with only blur off; a static
  300-row control table scrolls 60fps in the same harness) — blur removed
  from all scroll-path chrome, kept on static overlays. Measured after:
  Runs scroll 20→60fps (0 frames >17ms), idle 30→60fps, Insights 24→57,
  Tasks 38→60. REMAINING (cycle 3+): P3 virtualization (700-row
  initial-render spike + route-mount long tasks), P4-P8, C3-C5, DX-1..5
  (connect trap first), committed perf guard, core-audit completion
  (CORE-1: predictive priorities collapse to own-duration — agent
  confirmed pre-cutoff), #79 cloud queries. Perf-harness scripts:
  scratchpad `perf/{seed-serve.ts,measure.mjs,attrib.mjs,control.mjs}`
  (method documented in the audit doc §1).

- **2026-07-12**: **OWNER DIRECTIVE — HTTP/3 REMOVED wholesale ("use http2 as 3
  is experimental" + "remove all mention on http3, http2 is supported through
  node" citing `import { createSecureServer } from 'node:http2'`).** REVERSES
  the two native-HTTP/3 entries below: the `Bun.serve({ http3 })` opt-in,
  `VX_CLOUD_HTTP3`, the `/v1/meta` `h3` flag, the Alt-Svc tests, every h3/QUIC
  doc mention, and the Caddy edge's `h3` protocol + UDP 443 publish are all
  GONE (decision-log + frozen design docs stay as history). In-process TLS
  (`VX_CLOUD_TLS_CERT`/`_KEY`) survives as stable HTTPS/1.1; the Bun floor
  reverted to ≥ 1.3 (1.3.14 was h3-motivated only). **The owner's node:http2
  line was empirically probed before deciding** (real 1.3.14 + 1.3.11 binaries,
  loopback): `node:http2.createSecureServer` DOES work under Bun — a real h2
  round-trip serves 200 (`httpVersion=2.0`) — **but it is h2-ONLY:
  `allowHTTP1: true` is unimplemented** (an ALPN `http/1.1` client's bytes are
  blackholed; a no-ALPN client gets a bogus `HTTP/1.0 403 Forbidden`), and
  **`server.emit('connection', socket)` injection into node:http/http2 servers
  is also unimplemented** (hangs; verified NOT a sandbox artifact — the same
  raw clients round-trip fine against `Bun.serve({tls})` and `node:https`,
  and `node:tls.createServer` ALPN works). So the ALPN-demux single-port
  design (tls front routing h2→http2 server / h1→http server) is impossible
  under Bun today, and an h2-ONLY listener is useless for vx's own machine
  wire: **Bun's `fetch` is an HTTP/1.1 client** (it cannot connect to an
  h2-only server — pinned empirically), and the WS agent channels need the
  h1.1 Upgrade. Conclusion shipped in docs: **HTTP/2 multiplexing = the edge
  proxy** (Caddy `edge` profile, now `protocols h1 h2`); in-process TLS =
  HTTPS/1.1 with keep-alive reuse; the CLI's real round-trip win is the batch
  probe + keep-alive either way. **Revisit in-process h2 (small change: swap
  `Bun.serve` for `createSecureServer` behind the same `tls` option) when Bun
  implements `allowHTTP1`.** Tests: TLS e2e reworked to pin HTTPS/1.1 + NO
  Alt-Svc + NO `h3` meta key; the http3 config tests deleted; the version gate
  deleted (all TLS tests run on any Bun ≥ 1.3). Docker HEALTHCHECK stays
  scheme-aware (that fix is TLS-motivated, not h3). NO CACHE/SCHEMA/wire
  change (`h3` was advisory and unconsumed by any client).

- **2026-07-12**: **Strict review of the day's transport + cloud-perf commits —
  two shipped defects fixed, docs synced to the shipped behavior (owner:
  "Review work of opus. Be very strict" + "make sure all docs are updated")**.
  Hostile pass over `e4d7385`/`9ea4622` (native h3 + the h2-first refinement)
  and re-verification of `d5a7978`..`94efe4b`/`47e1d84`. **Fixed:** (1)
  MEDIUM-HIGH — the Docker `HEALTHCHECK` probed `http://127.0.0.1:<port>/health`
  unconditionally, but with in-process TLS that port serves HTTPS ONLY, so
  enabling `VX_CLOUD_TLS_CERT` in a container marked a healthy platform
  unhealthy forever (orchestrators kill/restart on that signal); the probe now
  follows the TLS env (`https` + `rejectUnauthorized:false` — liveness, not
  trust). (2) MEDIUM — `VX_CLOUD_HTTP3=1` on Bun < 1.3.14 silently no-opped
  (`Bun.serve` ignores the option) while `/v1/meta` advertised `h3: true` and
  the boot log claimed QUIC — an explicit opt-in the runtime can't honor now
  REFUSES BOOT naming the running version (the platform-honesty rule: never
  advertise a capability that doesn't exist). (3) LOW — the whole h3 test
  describe was version-gated, but only the Alt-Svc opt-in test needs 1.3.14;
  the TLS-alone-HTTPS + unreadable-cert tests now run on any Bun (32 pass/1
  skip on 1.3.11, 33/0 on 1.3.14, verified under both binaries). **Docs
  synced:** self-hosting env table gained `VX_CLOUD_TLS_CERT/_KEY`,
  `VX_CLOUD_HTTP3`, `VX_CLOUD_ALLOW_ORIGIN` rows; the production bullet no
  longer claims TLS⇒HTTP/3 (pre-refinement leftover); wire-protocol's
  `/v1/meta` example gained the `h3` flag; the Caddyfile's "Bun has no native
  H2/H3" comment corrected to "no HTTP/2 server; h3 is an experimental
  opt-in"; deploy README now states plainly that the compose file does NOT
  wire in-process TLS (env not passed, no cert volume, no UDP publish — the
  edge profile is the compose path; in-process TLS fits bare metal /
  `docker run` with a PEM volume + UDP port); every "ignored on older Bun"
  claim replaced by the boot-refusal fact; the Bun floor bumped to 1.3.14 in
  docs/README, docs/cli, quickstart, introduction, migrate/from-turborepo.
  **Verified sound (no action):** token memo (bounded 10k + clear, negative
  caching safe since secrets can't re-mint, revoke clears in-process),
  `compareRuns` (`prevStartedAt` correctly from the PREVIOUS run's getRun),
  both set-based rewrites carry the `workspace_id` tenant clamp +
  differential pins, `readTextBounded` streaming cap, dist `validateGraph`
  wired in `start()`, SSE `cancel()` cleanup. **Accepted residuals
  (informational):** random-bearer spam thrashes the token memo via `clear()`
  (bounded memory, extra Postgres reads only); `getFlakiestTasks`' windowed
  durations query scans all pairs, not just candidates (bounded by the scale
  guard); the committed 100-year test TLS key (deliberate, test-only,
  self-signed); the local dev env runs Bun 1.3.11 — BELOW the new engines
  floor — so the h3 e2e only exercises via the fetched 1.3.14 binary + CI.

- **2026-07-12**: **HTTP/2 (stable, at the edge) is the recommended multiplexing
  path; native HTTP/3 DECOUPLED from TLS behind an explicit `VX_CLOUD_HTTP3`
  opt-in (owner: "use http2 as 3 is experimental")**. Refines the native-HTTP/3
  entry just below: that shipped `http3: true` AUTO-ENABLED whenever in-process
  TLS was set. Since Bun's HTTP/3 is experimental and the owner wants stable
  HTTP/2, I re-verified the transport facts against the real 1.3.14 binary:
  **`Bun.serve` has NO HTTP/2 server** — its 1.3.14 type defs expose only
  `http1?` + `http3?` (no `http2`), and `http2: true` is silently ignored like a
  garbage key (only `http3: true` produced the `Alt-Svc` header). So native
  in-process h2 is impossible; **stable HTTP/2 comes from an edge proxy** (the
  already-shipped Caddy `edge` profile, where h2 is production-stable), and a
  `node:http2.createSecureServer` rewrite of the whole WS/SSE/SPA host is a
  massive, unjustified risk. **Changes:** (1) in-process TLS
  (`VX_CLOUD_TLS_CERT`+`_KEY`) now serves **stable HTTPS/1.1** and adds NO
  multiplexing on its own — a single-container-with-TLS convenience, not a
  transport upgrade; (2) native h3 is a SEPARATE explicit opt-in
  `VX_CLOUD_HTTP3=1` (requires TLS, else a boot error; requires Bun ≥ 1.3.14),
  clearly labeled experimental; `/v1/meta` `h3` reflects the actual opt-in state
  (false for TLS-only). (3) Docs (self-hosting/cli/deploy) now LEAD with "HTTP/2
  at an edge proxy (recommended, stable)" and demote native h3 to an
  experimental opt-in, stating the `Bun.serve`-has-no-h2 fact plainly. Pinned:
  `resolveServerConfig` (TLS → h3 off by default; `VX_CLOUD_HTTP3` without TLS →
  boot error) + the version-gated e2e (TLS-alone → NO Alt-Svc + `h3:false`;
  `VX_CLOUD_HTTP3=1` → `Alt-Svc: h3=` + `h3:true`), both verified under the real
  1.3.14 binary + ephemeral pg + fake S3. NO CACHE/SCHEMA/wire change; TLS-less
  boot byte-identical to before.

- **2026-07-12**: **Native HTTP/3 in the vx-cloud server — `Bun.serve({ http3:
true })`, CORRECTING the earlier "Bun has no h3" conclusion (owner:
  "https://bun.com/blog/bun-v1.3.14 Supports http3 !!!" + "or use http 2")**.
  My prior two entries (the edge-proxy build + the "re-verified empirically"
  note below) concluded Bun had NO native HTTP/3 — that was probed against Bun
  **1.3.11**, which predates the feature. **Bun 1.3.14 added
  `Bun.serve({ http3: true })`** (experimental, lsquic + uWebSockets). I fetched
  the real 1.3.14 linux-x64 binary from npm (`@oven/bun-linux-x64@1.3.14`; bun.com
  is egress-blocked) and **empirically confirmed** the exact API: `http3: true`
  is the option (NOT the `h3` in an early X post — `h3`/`http2` are silently
  ignored like a garbage key); it **requires `tls`** (throws `HTTP/3 requires
  'tls' to be set` otherwise); it sets `Alt-Svc: h3=":port"; ma=86400` on the
  HTTP/1.1 responses so clients auto-upgrade to QUIC on the SAME port; and
  **WebSocket + SSE + the h1.1 fetch all coexist** with h3 enabled (verified a
  WS echo + Alt-Svc together). So the whole platform architecture (single
  `Bun.serve` hosting the cache wire + WS agent/dist channels + SSE/NDJSON
  streams + MCP + SPA) stays UNCHANGED — h3 is purely additive. **Shipped
  (in-process TLS path, opt-in):** `VX_CLOUD_TLS_CERT` + `VX_CLOUD_TLS_KEY` (PEM
  paths, both-or-neither → a partial config is a boot error; unreadable at boot
  → fail loud, never a silent no-TLS start) resolve a `ServerConfig.tls`;
  `startServer` reads the PEM bytes and passes `tls` to `startPlatformHttp`,
  which adds `{ tls, http3: true }` to the `Bun.serve` call and flips the origin
  to `https://`; `/v1/meta` advertises `h3: <bool>`. With no TLS env the server
  is byte-identical to before (plain h1.1, TLS at an edge proxy). **The Caddy
  `edge` profile STAYS** as the alternative (h2 for older clients, a CDN, or
  keeping certs out of the app) — docs now present BOTH (native vs edge; don't
  run both TLS terminators). **Bun floor bumped ≥ 1.3.14** (`package.json`
  engines + stack table; the option is silently ignored on older Bun, so it
  degrades to HTTPS-without-H3 — the Alt-Svc integration test is
  `Bun.semver`-gated on ≥1.3.14). **Verified end-to-end** by running the h3
  test suite under the REAL 1.3.14 binary + ephemeral Postgres + fake S3: the
  actual `server.ts` boot terminates TLS, serves `/v1/meta` over HTTPS with
  `Alt-Svc: h3=` + `h3: true`, and an unreadable cert fails boot loud; the full
  cloud suite (411 pass) stays green under 1.3.14. Tests: `resolveServerConfig`
  TLS resolution (both → tls, partial → error) + the version-gated H3 e2e
  (Alt-Svc + meta + unreadable-cert boot failure), embedding a 100-year
  self-signed localhost cert so the fixture never expires. NO CACHE/SCHEMA/wire
  change. **Lesson:** empirically probing a feature is only as good as the
  version you probe — the earlier "Bun has NO QUIC/HTTP-3 server" was true for
  1.3.11 and wrong for 1.3.14; pin the version claim to the version tested.

- **2026-07-12**: **Cloud debug + performance pass — two parallel hostile
  audits (bugs + perf) drove five correctness fixes and five hot-path
  round-trip eliminations (owner: "Also debug for issues and bugs. Make sure
  performance of cloud is top notch")**. Two read-only reviewers swept
  `packages/cloud/src/**`. **Bug fixes (`d5a7978`):** (1) MEDIUM-HIGH — the
  ingest/logs/catalog/MCP body readers checked size only AFTER `req.text()`, so
  a chunked (no-content-length) body bypassed the pre-check and buffered up to
  the 513 MiB server-wide `maxRequestBodySize` — the SAME class as the batch
  endpoint's already-fixed streaming cap; extracted that cap to
  `src/http-body.ts` (`readTextBounded`) and applied it to every one of those
  paths + the artifact store. (2) MEDIUM — an empty / cyclic / dangling-dep
  `dist:submit` graph hung `DistScheduler` forever (`checkFinish` only fires
  from `complete()`), leaking the session + the submitter socket; validate the
  submitted graph is a well-formed DAG up front (empty → clean finish via a
  terminal `checkFinish`; cycle/unknown-dep → `abort`). (3) MEDIUM — SSE/NDJSON
  subscribers were removed only via `req.signal` abort; added a
  `ReadableStream.cancel()` fallback so dropped `/stream`/`/events` connections
  can't accumulate in the broadcast set. (4) LOW-MED — analytics read routes
  500'd on a malformed percent-encoding (`decodeURIComponent`→URIError); wrapped
  them to answer 400, and folded `getRun`'s `Math.min(...tasks)` spread (up to
  100k args) to a reduce. (5) doc — corrected `createPartitionMovingDefault`'s
  docstring. The bug agent confirmed the timers, spool lifecycle, registry/
  scheduler races, migrations, and auth handling are otherwise sound. **Perf
  (`1329b57`, `7201c34`, `94efe4b`):** the audit's highest-value, provably-safe
  wins. (F1) **Auth token lookups memoized** (5s TTL keyed by token-hash) — the
  cache wire is the highest-QPS surface and did one Postgres round-trip per
  request before any S3 work; a distributed build issues thousands. Token
  principals are immutable except revoke → cleared in-process on `revokeToken`
  (a revoked bearer stops authenticating at once), bounded by TTL across
  replicas, and each entry's expiry is capped at the token's OWN `expires_at`
  so a token expiring within the window is never served stale (the two auth
  traps — revoke-kills-bearer + expiry-within-TTL — are pinned by existing +
  new tests). Session principals are NOT memoized (their invalidation surface —
  role/membership/disable — is deferred; the token surface is the QPS
  dominator). (F7) **taskDurationHints memoized** per workspace (30s) — a
  full-history GROUP BY that ran synchronously on EVERY `dist:submit` (the
  latency-critical submit path); the hints are advisory (LPT ordering), so TTL
  staleness never affects a run. (F6) **compareRuns** finds the previous run via
  a single-row index seek on the `invocations` header table instead of a
  `GROUP BY run_id` over all prior task_runs, comparing in one time frame. (F2)
  **getHistory** 1+2N per-pair fan-out (up to 101 sequential round-trips for a
  50-task page) → TWO set-based queries (one GROUP BY + one ROW_NUMBER-windowed
  durations), the pair set/order + per-row math preserved exactly (shared
  `historyRowFrom`), **pinned by a differential test asserting the batched
  all-pairs result deep-equals the per-pair filtered result**. (F4)
  **getFlakiestTasks** 1+N per-candidate `successDurations` → one windowed
  durations query (shared `durationsByPair`/`pairKey` helpers), byte-identical.
  No CACHE/SCHEMA/wire change; every query rewrite is output-preserving. Core CI
  - cloud (403 pass) green throughout. **DEFERRED (documented, tracked
    follow-up — need the correlated-subquery→CTE rewrite the audit specified +
    differential tests, or are lower-frequency):** F3 `listProjects` (the worst
    unlisted N+1 — loops `getCacheSavings`'s correlated subquery per project → the
    `avg_dur` CTE join) + the `getCacheSavings`/`getRegressions` CTE rewrites;
    Finding 5 (lookback bounds + a `status='failed'` partial index so dashboard
    aggregates prune partitions); Finding 8 (skip the confirming S3 HEAD before a
    TRUSTED cache GET's 307 — single-scope, the client already treats a post-307
    404 as a miss); the SESSION auth memo.

- **2026-07-12**: **Every audited cloud bug confirmed with a test; the two LOW
  residuals FIXED (`47e1d84`) (owner: "All bugs should be confirmed with tests
  and fixed")**. Residual fixes: (a) `getRunHeatmap` bucketed by the server's
  LOCAL tz (`getDay`/`getHours`) while the platform is UTC/epoch-ms →
  `getUTCDay`/`getUTCHours`, pinned by a test under `TZ=America/New_York` (a
  03:00-UTC run lands in the UTC cell, not the 22:00 local one — discriminating
  because Bun honors a runtime `TZ` change); (b) a malformed wallclock-ns string
  (`"1.5"`) made `BigInt()` throw out of the ingest transaction and discard the
  ENTIRE run — now parsed integer-string-only (`intNsOrNull`), so one bad field
  is dropped, not the run (pinned: a good+malformed run stores both, bad field
  NULL). Confirming tests added for the earlier fixes: the chunked-body cap (a

  > 4 MiB MCP body → 413, streaming before parse, + the `readTextBounded` unit
  > suite), and the SSE subscriber cleanup (a new `subscriberCount()` hook — also
  > useful for ops — proves a disconnected `/stream` client leaves the broadcast
  > set); the read-route 400 + dist-scheduler DAG guards already had tests. Cloud
  > 407 pass, core lint clean. **Bun HTTP/3 — re-verified empirically (owner: "Bun
  > support http3")**: Bun 1.3.11 has NO native HTTP/3/QUIC server — probed the
  > binary (no `http3`/`quic` symbols; the `alt-svc` strings are `node:http2`'s
  > HTTP/2 support) and the API surface (`Bun.quic` undefined,
  > `globalThis.WebTransport` undefined, `node:quic` not a built-in, `Bun.serve`
  > exposes no h3/protocols option). So the edge-proxy H3 (Caddy `edge` profile)
  > stands; native h3 in `Bun.serve` stays blocked until Bun ships a QUIC server.
  > \*\*[SUPERSEDED 2026-07-12: this was Bun 1.3.11; Bun 1.3.14 SHIPPED
  >
  > > `Bun.serve({ http3: true })` — see the native-HTTP/3 entry at the top.]\*\*

- **2026-07-12**: **HTTP/3 + connection multiplexing via an edge proxy — a
  ready Caddy `edge` compose profile terminating h1/h2/h3 (owner: "Support H3
  as well. So you can use one connection with multiple requests")**. Verified
  the transport facts empirically before building: **`Bun.serve` is HTTP/1.1
  only** (no h2 option on the server object), **Bun has NO QUIC/HTTP-3 server**
  (`globalThis.WebTransport` undefined, no QUIC API — only a `Bun.udpSocket`
  primitive) **[SUPERSEDED: true on Bun 1.3.11 only — Bun 1.3.14 SHIPPED native
  `Bun.serve({ http3: true })`; the edge profile below stays as the h2/CDN
  alternative, see the native-HTTP/3 entry at the top]**, and `node:http2`
  compat exists but rewiring the single
  `Bun.serve` (which hosts the cache wire + WS agent/dist channels + SSE/NDJSON
  streams + MCP + the SPA catch-all, all on Bun's WebSocket-upgrade API) onto
  `node:http2.createSecureServer` would be a massive, risky rewrite for a
  self-hosted platform that belongs behind a proxy anyway. **So H2/H3 are
  terminated at the EDGE** — the universal production pattern (TLS already
  lives there): the proxy speaks h1/h2/h3 to clients and plain HTTP/1.1 to the
  app over the internal network. The payoff the owner asked for — one
  connection multiplexing many concurrent requests, no per-request TCP+TLS
  handshake — is delivered by h2/h3 at the edge, and **compounds with the
  batch cache-existence probe shipped the same day** (N per-hash HEADs → 1
  request): fewer requests, and the remaining concurrent GETs share one
  connection. **Deliverable (deploy + docs only, ZERO app-code change —
  correct by construction since the app never changes transport):**
  `packages/cloud/deploy/Caddyfile` (global `servers { protocols h1 h2 h3 }` +
  a `reverse_proxy app:4321`; `tls internal` for the localhost demo, drop it +
  set `VX_CLOUD_DOMAIN` for real-domain ACME auto-HTTPS) + a `caddy` service
  behind a docker-compose **`edge` PROFILE** (opt-in: `docker compose --profile
edge up`, publishing `443:443` + `443:443/udp` for QUIC + `80:80`;
  `caddydata`/`caddyconfig` volumes) so the plain `docker compose up` →
  `localhost:4321` experience stays untouched. WebSocket + SSE bridge
  transparently through Caddy (`flush_interval -1`). Docs: `deploy/README.md`
  "HTTP/3 & connection multiplexing" + a new `cloud/self-hosting.md`
  "Transports: HTTP/3 & multiplexing" section (Caddy one-directive example,
  nginx/Cloudflare noted as equivalents, the app-is-H1-to-the-proxy invariant
  stated), and the `/v1/cache/batch` row added to the HTTP-surface table.
  **Client note (documented conservatively):** the vx CLI's requests to an
  h2/h3 proxy use whatever protocol its fetch stack negotiates (H2 when
  available, else keep-alive connection reuse) — I could NOT empirically
  confirm Bun's fetch H2-client negotiation here (the sandbox blocks loopback
  TLS: a `node:http2` secure server + Bun-fetch/curl `--http2` probe both
  failed to connect, an env limitation not a Bun signal), so the docs don't
  hinge on it; browser dashboard clients get full H3 regardless, and the batch
  endpoint carries the CLI round-trip win. Verified: docker-compose.yml parses
  (5 services incl. `caddy`/edge-profile, 4 volumes), astro build clean (157
  pages, the transports + `#cache-wire` cross-links resolve, only the 7
  pre-existing frozen-doc/module-stub broken links, zero new). `deploy/**` +
  `apps/docs/**` are oxfmt/lint-ignored, so no core-gate impact. **NOT built
  (deliberate, named):** native h2/h3 in Bun.serve (would need the whole host
  rewritten onto node:http2 — deferred until Bun ships an h2/h3 server option);
  an in-app QUIC listener (Bun has no QUIC server).

- **2026-07-12**: **Batch cache existence probe — `POST /v1/cache/batch`
  collapses N per-hash HEADs into ONE round-trip (owner ask: "shouldn't cache
  have an endpoint to check many at the same time? To speed up?")**. The
  vx-native cache wire was strictly per-hash (`GET`/`HEAD`/`PUT /v1/cache/:hash`),
  so a fresh CI runner priming a 1000s-task graph probed the remote once per
  task; the prefetch pass fired GETs concurrently (bounded pool) but on a
  high-latency link that's still N/pool round-trip WAVES, and every cold-cache
  miss cost a GET. **Server (`packages/cloud`):** `ArtifactStore.hasMany` +
  `handleBatch` (the HTTP wrapper) — body `{ hashes: string[] }` (≤1024, else 400) → `{ present: string[] }`, resolved through the EXACT same
  `findReadKey`/`readScopes(principal, sub)` path a GET uses, so a batch probe
  is trust-scoped IDENTICALLY (trusted never sees untrusted, cross-org/cross-ws
  never leak) and can't reveal existence wider than a fetch could reach.
  Machine-token-only (`isMachineTokenOnly` + `isAnalyticsSurface` both updated
  → a session cookie 403s, routes to dispatch not Postgres); bounded server
  fan-out (`HASMANY_CONCURRENCY = 32`); body read with a STREAMING cap
  (`readTextBounded`, 256 KiB) so a chunked no-content-length body can't buffer
  past the cap into the 512 MiB artifact-PUT `maxRequestBodySize` (the P4-server
  chunked-bypass class). `/v1/meta` now advertises `cacheWire: 2`. **Client
  (`packages/cloud`):** `NativeCacheClient.hasMany` POSTs the batch (chunked at
  1024), returns the present set — or `null` on 404/405 (an older `cacheWire: 1`
  serve), memoized per client so a legacy serve costs at most one probe, then
  falls back to per-hash. **Core (`src/`):** OPTIONAL `RemoteCacheLayer.hasMany?`
  (a remote that can't batch omits it); `LayeredCache.remoteHasMany` (never-fail
  → `null` on error/unsupported/reads-off) + `markRemoteAbsent` (pre-populates
  the `inflight` map with resolved-`false` for batch-absent hashes, WITHOUT
  clobbering an in-flight pull — byte-equivalent to a background prefetch-404
  caching false, same at-most-once + staleness semantics). `startRemotePrefetch`
  batch-probes all stable hashes ONCE, GETs only the hits, and marks the misses
  absent so their lazy `get` short-circuits with ZERO network — collapsing N
  probe waves into 1 + skipping every GET that would 404. Falls back to
  prefetching every stable key when `remoteHasMany` returns null. **Honest
  tradeoff (why OPTIONAL + fall-back, not mandatory):** for a warm all-hit run
  on a FAST link the batch adds one serialization point (all GETs wait for the
  one batch response) — so it's a clear win for many-task / high-latency /
  cold-ish caches and neutral-to-marginal elsewhere; degrades gracefully
  everywhere. NO CACHE_VERSION/SCHEMA/wire-BREAKING change — `cacheWire` is
  additive (a `1` client/serve interoperates via the per-hash fallback). Tests:
  core +7 (LayeredCache remoteHasMany null/error/reads-off + markRemoteAbsent
  no-GET + no-clobber-in-flight; orchestrator-remote e2e: batch probed ONCE,
  only hits fetched, miss never double-fetched — the deterministic 0-GET-on-
  absent skip is unit-pinned since the e2e batch/execute race is timing-
  dependent), cloud +10 (artifact-store trust-scope matrix incl. cross-org
  clamp + malformed/over-cap 400s + streaming-cap 413 + best-effort-broken-
  backend; native-cache round-trip/chunking/404-memoize-fallback/malformed;
  server e2e: machine-token gated (session→403), trust-scoped, round-trips
  through the REAL server on ephemeral pg + fake S3). Core CI green, cloud
  392 pass, lint+fmt clean.

- **2026-07-12**: **Docs + website reorg — core is provider-neutral (zero
  `vx-cloud` references), all vx-cloud content consolidated into a dedicated
  "vx Cloud" section (`d959c20`, `8961335`, `2e0149f`, `0dcadc8`)** (owner:
  "Update all docs and website. Do not refer to vx cloud in docs. Move all vs
  cloud to own section" + "Update readme as well"). After the platform pivot
  the vx-cloud material was scattered across the core reference pages + core
  guides, blurring the "core is only a task runner, the platform is an
  optional plugin you connect to" boundary. Split cleanly: **(1) New "vx Cloud"
  sidebar group** — 8 hand-authored pages under
  `apps/docs/src/content/docs/cloud/` (overview, self-hosting, dashboard,
  distributed-ci, remote-caching, mcp, cli, wire-protocol); the four platform
  guides that used to live under `guides/` (self-hosting, dashboard,
  distributed-ci, wire-protocol) MOVED here, and the vx-cloud CLI reference
  (270 lines) was EXTRACTED out of `docs/cli.md` into `cloud/cli.md`. The
  "Platform & extensions" group was renamed **"Extending vx"** and is now
  core-only (extensibility / plugins / mcp / otel / predictive). **(2) Core
  pages scrubbed provider-neutral** — every `docs/*.md` reference SOURCE
  (cli, architecture, caching, comparison, differentiators, execution, flows,
  schema, patterns, modules/\*) + the core guides (ci, extensibility, mcp,
  plugins, remote-caching) + `introduction.md` + `migrate/from-turborepo.md`
  - the landing (`index.astro`) now carry ZERO `vx-cloud`/`VX_CLOUD_`/
    `@vzn/vx-cloud` documentation. Core describes only its SEAMS (the
    `RemoteCacheLayer` seam + `LayeredCache` behavior, the `cache`/`backend`/
    `telemetry` plugin capabilities, the vx-native `/v1/cache` wire as core's
    own concept) and points at the Cloud section for the first-party
    implementation. **Deliberate residual cross-references (kept, agent
    judgment):** a page may NAME "vx Cloud" as the answer to "where do I get a
    shared cache / dashboard / distributed execution" and link into the section
    (`guides/remote-caching.md` description + body; `comparison.md` /
    `differentiators.md` "the first-party cloud plugin ships X, see the Cloud
    section"; the landing's single "Cloud, self-hosted" callout) — that's the
    necessary bridge, the same way Turbo/Nx docs cross-reference their own
    cloud products; removing it would make the comparison table and "how do I
    share a cache" unanswerable in core. `Nx Cloud` mentions are a competitor,
    untouched. **(3) README** rewritten the same way (`1871940`): core sections
    provider-neutral, ONE "## vx Cloud" section (Postgres+S3, docker-compose,
    `vx-cloud connect`), de-staled (`vx-cloud serve --ui` / `/v8` / Turbo-wire
    remote cache / HMAC all removed). **CI-content judgment:** the GHA
    job-summary + PR-checks material stayed in the core CI guide, reframed as
    a first-party CI TELEMETRY plugin (works standalone with only `GITHUB_TOKEN`
    — no serve), which is accurate; `docs/design/**` + `docs/progress/**` left
    frozen (a pre-existing broken source-path link in a frozen design doc, and
    the pre-existing `cli-*.md` module-reference stubs, are NOT reorg
    regressions). **Verified:** independent `astro build` clean (157 pages), a
    custom broken-link crawler over `dist/` found 7 broken links, ALL
    pre-existing (byte-identical source at origin/main — the frozen design doc
  - non-generated module stubs), ZERO introduced by the reorg; core-docs grep
    for `vx-cloud|VX_CLOUD_|@vzn/vx-cloud` clean (only the deliberate
    section-bridge "vx Cloud" cross-refs remain, all linking into
    `/cloud/...`); oxfmt clean on the 8 edited reference `.md` pages + README +
    this file. No core/runtime change — docs + site only.

- **2026-07-12**: **Post-pivot future-proofing review — one dead-code removal +
  stale-comment fixes; the pivot code is otherwise clean (`af…` follow-up)**.
  A pass over the P1→P5 code for SIMPLE, durability wins (not a re-audit — the
  tenant boundary was already adversarially reviewed). Found + fixed: (1)
  `ArtifactStore.migrateLegacyFlatStore` was DEAD — a boot-time migration of the
  pre-platform local flat store, but the platform is S3-only and never calls it
  (LocalDirBackend is test-only); its "runs once on boot" comment actively
  misled. Removed the method + its test + the now-unused `readdir`/`rename`
  imports. (2) Comments in `artifact-store.ts` + `dist/registry.ts` still
  described the DELETED "transitional single-tenant serve" — reworded: the
  `bucket` override is a test-only flat-layout seam, `DEFAULT_ORG` is the
  no-org fallback for the registry unit tests, and the platform gate always
  builds a token-derived tenant-partitioned principal. (3) Dropped an unused
  `orgId` in `analytics-write.test.ts` so a real future lint warning isn't lost
  in noise. **Considered but SKIPPED as not-simple:** making the registry
  `orgId` param required (churns ~20 test call sites; all 3 prod callers already
  pass it); removing the vestigial `ServerConfig.dataDir` (a valuable "zero SQLite
  at rest" e2e uses it as its watched dir); rewriting the N+1 `getCacheSavings`/
  `getRegressions` queries (correctness-risky set-based rewrite, only matters at
  extreme scale — deferred, bounded). Behavior unchanged; cloud 381 pass,
  lint/fmt/core-ci clean.

- **2026-07-12**: **Platform Phase 5 SHIPPED — docker-compose stack, `server`
  image, docs rewrite, cloud CI job — the platform pivot (P1→P5) is COMPLETE
  (`af6f451`, `68991eb`, `183900d`..`31d95a2`)**. The independent self-hosted
  CI platform the owner directed ("fully independent SaaS… accounts, roles,
  orgs, teams… deployed as docker compose… not possible to call vx-cloud
  serve") is done end-to-end. **(1) Deploy infra (`af6f451`):** the Dockerfile
  `CMD` invoked the DELETED `serve` verb (it would crash on boot) → `CMD
["server"]`, STATELESS (no volume — Postgres + S3 hold all state,
  horizontally scalable), full required-env doc. New `docker-compose.yml` is
  the real stack — app + postgres:16 + minio + a one-shot `mc mb` bucket-init —
  the "`VX_CLOUD_SECRET=$(openssl rand -hex 32) docker compose up` → open the
  URL → register the first admin" experience; production swaps minio for
  managed R2/S3 (partial S3 config is a boot error) behind a TLS proxy (https
  `VX_CLOUD_BASE_URL` → Secure cookies). **(2) Cloud CI job (`68991eb`):**
  `.github/workflows/ci.yml` gains a `cloud` job beside the unchanged core `ci`
  — `apt-get install postgresql` (the ephemeral-pg helper boots its own
  unix-socket cluster via initdb, non-root direct path on runners; S3 faked
  in-process) → `cd packages/cloud && bun test`. Closes the standing gap where
  the platform's 382 tests never ran in CI. **(3) Docs rewrite
  (`183900d`..`006cbb7` + `31d95a2`):** the user-facing guides
  (self-hosting/dashboard/distributed-ci/mcp/extensibility/plugins/ci/
  wire-protocol/introduction/remote-caching) + reference pages (cli.md,
  architecture.md, comparison.md, modules/mcp.md) + `deploy/README.md` rewritten
  to the platform model (compose deploy, required env, register→Admin→mint
  `vxc_` tokens, trust scopes, `VX_CLOUD_URL`+`VX_CLOUD_TOKEN` client connect,
  `VX_CLOUD_DISTRIBUTE`) — every stale `vx-cloud serve` / `--ingest-dir` /
  `VX_CLOUD_HOST`-token / SQLite-ingest / `environments.json`-auto-detect /
  delegation reference scrubbed from the user-facing guides (remaining
  `/v8/...` hits are the deliberate Turbo-wire third-party recipe; `docs/design/**`
  - `docs/progress/**` left frozen). The biggest correction: `cli.md`'s dead
    "transitional serve-era" HTTP block → the current platform surface. **Agent
    judgment calls kept:** `environment-variables.md` left as-is (it's about
    child-process env isolation, a different accurate topic — the server env
    lives in self-hosting.md, the client env in remote-caching/distributed-ci);
    `caching.md`/`patterns.md`/`differentiators.md` untouched (their `cache.db`
    mentions are the legit LOCAL core cache). Verified: `astro build` clean (153
    pages, no broken links), `ci.yml` valid YAML (both jobs), oxfmt clean (the
    reference `.md` pages ARE oxfmt-scanned — fixed the table re-alignment, the
    same CLAUDE.md class), docs stale-term grep clean. **DEFERRED (post-pivot,
    not a phase):** multi-app-node HA (sticky agent routing / pg-backed
    dispatch), team-scoped permissions (teams are metadata in v1), SSO/OIDC, an
    audit log, per-request cache policy to remote agents (a DIST_PROTOCOL bump) —
    all named in `cloud-platform-2026-07.md` §12/§13. **First real CI run of the
    `cloud` job is the last thing to confirm green** (the runner env isn't fully
    reproducible locally, but the 382 tests pass locally and the ephemeral-pg
    helper is CI-path-aware).

- **2026-07-12**: **Hostile review of platform Phase 4 (server half) — the
  fold + MCP VERDICT SOUND; two live-stream findings fixed (`6c7a25c`)**
  (repro-mandated reviewer over `d39d98a`..`e885a53`; real two-org
  `startServer` + a real `vx-cloud agent` subprocess driving a real dist
  build). **Fixed:** **(1) HIGH — cross-tenant leak on the live SSE/NDJSON
  broadcast.** `/events` / `/v1/events` / `/stream` fanned every concurrent
  dist run's events to a SINGLE GLOBAL subscriber set with NO org scoping — so
  any authenticated principal (any org's ci token OR session) that opened
  `/stream` received EVERY tenant's run stdout/stderr + the exact command
  lines. Reproduced end-to-end: org B subscribed with its OWN token and
  received org A's `SECRET-BUILD-OUTPUT` + `echo … && sleep 2 …` (2342 bytes of
  another tenant's run). INHERITED from the deleted serve.ts (byte-identical
  global `broadcast`), but the fold put it on the platform's SOLE multi-tenant
  host — it directly contradicts the P3 tenant-isolation verdict for this
  surface, and needs no CSRF/CORS (a scripted `curl /stream?token=<own>`
  passively harvests all tenants' live runs). Fix (`dispatch.ts`): each
  subscriber carries its server-derived `orgId`; `broadcast(msg, orgId)`
  delivers ONLY to same-org subscribers; the emitting run's org
  (`ws.data.principal.orgId`, set at upgrade) scopes its `send`. **(2) MEDIUM —
  the CSWSH Origin gate the fold DROPPED** (a genuine regression — the deleted
  serve.ts refused cross-origin WS/SSE handshakes via `originAllowed` +
  `VX_CLOUD_ALLOW_ORIGIN`; the folded gate had no Origin check). Not
  independently exploitable (the WS channels are machine-token-only — a session
  cookie is 403'd — and cross-origin credentialed SSE is blocked by
  `Allow-Origin: *` without `Allow-Credentials`), but it's a defense-in-depth
  control the 2026-07-03 security wave explicitly added, silently removed.
  Restored in `server.ts` (no-Origin CLI + same-origin pass; other cross-origin
  browser handshakes → 403; `VX_CLOUD_ALLOW_ORIGIN` allowlists a hosted
  dashboard). Pinned by two regression tests (`server.test.ts`, real two-org
  server: org B's `/stream` sees nothing of org A's run; cross-origin SSE across
  all three stream paths → 403). **Refuted by executed repro (sound):** the MCP
  tenant clamp (org B / a ws-scoped token / an explicitly-named foreign
  workspace all get isError-or-empty, never org A's data — MCP reuses
  `resolveReadWorkspace` faithfully, every tool `WHERE workspace_id=<resolved>`);
  the gate bypass (unauth cache PUT/GET/artifacts/agents/SSE → 401; session on
  the machine-token-only surfaces → 403; no handler runs without a resolved
  principal); every cache-wire contract (307 presign, 409 immutability, 400
  zstd-magic, untrusted→404-from-trusted, `org/<id>/ws/…` prefix, cross-org
  GET→404); NO SQLite at rest (0 `.db` files after ingest+logs+dist+mcp; the 4
  stores gone; `/v1/graph` falls through not 500); dist agent org-keying. Cloud
  380→382 (+2 regression), lint/fmt clean, core untouched.

- **2026-07-12**: **Scale/perf e2e guards for 1000s-task workspaces —
  "graph, lags" (owner ask) — SHIPPED (`02eff47`, `04344b5`, `614b528`)**,
  plus a real deep-graph stack-overflow FIX the guard surfaced. Three
  surfaces, anti-flake by the repo's proven method (min-of-3, bounds ~10-30×
  measured healthy so they guard ALGORITHMIC complexity, not machine speed):
  **(1) Core pipeline** — a REAL git-backed 2000-project / 6000-task
  workspace; `planRun` (the `--dry` path: hashes every task + probes cache,
  no exec) runs ~510 ms (bound 6000 ms), with functional pins on node count /
  task kinds / edges. **(2) Dashboard run-graph** — `contractGroups`+
  `layoutLevels` on a 3000-node/~12k-edge DAG ~11 ms (bound 500 ms, validated
  vs an independent longest-depth oracle), `criticalPath` ~2 ms, `parallelism`
  sweep (5000 intervals) ~2 ms, and a DEEP-CHAIN (8000) stack-safety pin.
  **(3) Postgres analytics** — ~480 invocations → ~12k `task_runs` (+ a decoy
  org) seeded via the real `Analytics.ingest`; every hot dashboard query
  bounded (listRuns ~9 ms, getHistory ~29 ms, getRun(700-task) ~2 ms,
  getFlakiestTasks ~46 ms, getRegressions ~150 ms, getPeriodComparison ~18 ms,
  taskDurationHints ~9 ms, getCacheSavings ~430 ms), workspace-CLAMP verified
  (the decoy org's rows never appear; foreign run-id → null). **REAL FIX
  (`04344b5`):** the deep-chain pin caught `contractGroups.resolve()`
  stack-OVERFLOWING at ~8000 depth (its `deps.flatMap(resolve)` recursion) —
  a browser hard-crash on a pathologically deep dependency chain. Converted to
  an explicit post-order stack, **byte-identical to the recursion**
  (differential-verified over 8000 random DAGs + cyclic graphs), now safe past
  500k. `layoutLevels`/`criticalPath` were KEPT recursive (they survive ~50k
  depth in V8 — beyond any realistic task-graph depth; the guard test pins
  them; converting them is a deferred nicety, not a bug). **Accepted residuals
  (informational):** `getCacheSavings` (~430 ms, a correlated subquery per
  cache-hit row) and `getRegressions` (~150 ms, an N+1 per-failing-task
  subquery) are architecturally N+1 — bounded higher, NOT regressions; a
  single set-based rewrite is the lever only if dashboard latency ever matters
  at extreme scale. Core 1223, cloud 380 (+19 analytics-scale), UI 52
  (+run-graph-scale) — all green together on the merged tree; the perf work
  merged cleanly (disjoint files) on top of P4-server.

- **2026-07-12**: **Platform Phase 4 (server half) SHIPPED — `serve.ts`
  absorbed into the platform, all four residual SQLite stores DELETED
  (`d39d98a`, `e885a53`)**, completing P4 (§12). The transitional companion
  machinery is GONE; the platform is Postgres + S3 with ZERO bytes at rest on
  the controller. **(1) The fold (`d39d98a`, additive):** new
  `packages/cloud/src/cli/dispatch.ts` (`startPlatformHttp`) owns the single
  `Bun.serve` for every machine surface the auth/admin/analytics `gate` does
  NOT resolve to a Postgres Response — the vx-native cache wire
  (`/v1/cache/:hash`), `/v1/artifacts`, `/mcp`, the agent/dist WS channels,
  SSE/NDJSON streams, the SPA catch-all — and `server.ts` calls it instead of
  `startServe`. `/mcp` re-backed by Postgres (`cli/mcp.ts`, the 7 tools over
  `Analytics`, org/workspace-CLAMPED exactly like the analytics gate:
  `list_workspaces`→`workspacesForOrg`, `list_runs`→`listInvocations`,
  `get_run`→`getInvocation`+`getRun`, `run_trends`→`getRunTrends`,
  `cache_stats`→`getCacheStatsSql`+`getHitRateSplit`,
  `why_did_rerun`→`whyDidThisRerun`+`cacheKeyDiff`, `compare_runs`→
  `compareRuns`). Dist LPT duration hints now come from `task_runs`
  (`Analytics.resolveClientWorkspace`; FIFO when un-ingested). NO SQLite in the
  platform path. **(2) The demolition (`e885a53`):** DELETED `cli/serve.ts`,
  `cli/mcp-serve.ts`, `ingest-store.ts`, `log-store.ts`, `fp-store.ts`,
  `workspace-catalog.ts`; the façade dropped `IngestStore`/`WorkspaceCatalog`/
  `startServe`/`parseServeArgs`/`resolveS3Config`/`resolveServePort`/
  `defaultServeSocketPath`/`DEFAULT_SERVE_PORT`/`handleMcpHttp` and added
  `startServer`/`resolveServerConfig`/`PlatformServer`/`ServerConfig`; the
  colocated cockpit (`/v1/graph` + `/v1/workspace/*` + `WorkspaceCatalog`) is
  gone (an unknown path falls through to the SPA — the UI already treats them
  as honest-disabled). **Unix-socket listener DELETED** (`serve --socket` was
  a companion-only local transport; the platform binds `0.0.0.0` behind the
  account/token gate, so a 0600-socket-as-auth has no role). `ServerConfig.
dataDir` is now VESTIGIAL — kept + defaulted so an existing
  `VX_CLOUD_DATA_DIR` doesn't error, but the server writes nothing to it.
  **Cloud tests 479→361:** 11 companion suites deleted (serve, serve-socket,
  serve-transports, ingest, fp-store, log-store, workspace-catalog, {analysis,
  regressions,task-logs,mcp}-serve) with their still-valid HTTP route-wiring
  assertions (MCP-over-PG, /v1/analysis, /v1/regressions, /v1/hermeticity,
  task-log ingest+read, /v1/cache/stats no-shadow) MOVED onto `server.test.ts`
  and the query-level coverage already in `analytics-read.test.ts`;
  `agents-e2e` + `blob-store-s3` retargeted onto the platform via a new
  `tests/helpers/platform.ts` (ephemeral pg + fake S3 + admin session + ci/
  untrusted tokens). **Accepted coverage trims:** the LocalDirBackend GET-
  streams-bytes path (dead in prod — the platform is S3-only) and the
  `/v1/artifacts` orphan-hash "no task field" case. **Verified INDEPENDENTLY
  with the real CLI** (`bun cli/bin.ts server` on ephemeral pg + fake S3): 11/11
  — `/v1/meta` auth=account + cacheWire, register→instance admin, mint ci token,
  cache PUT→200 / GET→307 presigned, `/mcp tools/list`→7 tools OVER POSTGRES, a
  SESSION on the cache wire→403 (machine-token gate intact), removed `/v1/graph`
  falls through (200 SPA, not 500), and the data dir holds ZERO `.db`/`.sqlite`
  files. Core ci exit 0 (ZERO core `src/` change), cloud lint/fmt clean, cloud
  361 pass, real-server e2e in `server.test.ts` green. **REMAINING: P5**
  (docker-compose + image + self-hosting/dashboard/distributed-ci docs rewrite
  for the platform + a cloud CI job — the 464→380 cloud tests still don't run in
  CI, though Postgres IS available there).

- **2026-07-12**: **Platform Phase 4 (dashboard UI half) SHIPPED — the
  dashboard is now a session/account client + a full Admin area (`656d386`,
  `575ca88`)**, executing the UI portion of P4 (§12). The SPA converted from
  the retired companion Bearer-token model to the platform's account/session
  model, ALL in `packages/cloud/ui/**` (ZERO `packages/cloud/src/**` change).
  **Auth foundation (`656d386`):** `api.ts` dropped the bearer token entirely
  (no more `vx-ui:token`) — every request rides `credentials: 'include'` so the
  browser returns the HttpOnly session cookie, and every mutation carries
  `x-vx-csrf: 1` (the SPA custom-header CSRF gate); added auth state
  (`loading|anon|authed`) + current principal, the `?org=` clamp (persisted
  `vx-ui:org`), session lifecycle (`bootstrapAuth`/`login`/`register`/`logout`/
  `acceptInvite`), the full `/v1/admin/*` client, and pure helpers
  `scopedPathFor`/`nextOrgSelection` (`getConnectionKey` now keys on
  `origin|user|org|workspace`; `ServerMeta.auth` accepts `'account'`). A
  full-screen `LoginGate` (sign-in / create-account, invite-aware) gates the
  router in `main.tsx`; `Shell` swapped the token editor for an org switcher +
  account menu + sign-out + conditional Admin nav. **Admin area (`575ca88`):**
  a new `/admin` route (interactive Solid, not json views) — Members · Invites ·
  Tokens · Workspaces · Settings, wired to `/v1/admin/*` with create/list/
  revoke/role-change, RBAC-reflected (the server is the enforcer). Minted CI
  tokens surface the plaintext `vxc_` secret ONCE with a copy affordance +
  won't-show-again warning. **Verified in a REAL browser** (Playwright/Chromium
  against a real `startServer` on ephemeral pg + fake S3 serving the built
  `ui/dist`): login gate → register first user → dashboard + Admin → analytics
  render → mint CI token (plaintext shown once) → create workspace → create
  invite (`vxi_`) → create a second org → switch orgs (Settings re-seeds to the
  new org) → logout → login gate → log back in — ALL steps, ZERO real console
  errors. Accepted degradations (filtered): 404s to `/v1/graph`, `/version`,
  `/v1/runs/queue` (removed on the platform) correctly leave the Runs spawn bar
  honest-disabled. UI 32→52 tests (+20 pinning the org/ws clamp +
  org-selection reconciliation); `bun run build` (vite+tsc) clean; core ci
  green. **Corrections the agent made against the real server (kept):** (1)
  invite onboarding — a NEW invited user registers via
  `POST /v1/auth/register {…, invite}` (the LoginGate register form), while
  `POST /v1/auth/invites/accept` adds a membership to an EXISTING session (an
  in-app "Join with an invite" action) — the shipped server, not the design's
  sketch. (2) Found + fixed a real bug: switching orgs while on the Settings
  tab left the rename form seeded with the PREVIOUS org (a Save would have
  renamed the wrong org) — fixed with a reactive `createEffect(on(...))`
  re-seed, pinned by an e2e assertion. (3) No
  `GET /v1/admin/orgs/:id/invites` on the server, so the Invites section only
  creates (surfaces the token/URL) — no list. `dist` stays a gitignored build
  artifact (not committed). **REMAINING P4 (server half, next):** absorb the
  transitional `startServe` (serve.ts) into server.ts, repoint `/mcp` + dist
  duration hints to the existing Postgres `Analytics`, DELETE the colocated
  `/v1/graph`+`/v1/workspace/*` cockpit + the four residual SQLite stores
  (ingest/log/fp/workspace-catalog) + serve.ts, retarget the companion suites.
  Then P5 (compose/image/docs).

- **2026-07-12**: **Hostile tenant-boundary review of platform Phase 3 —
  VERDICT AIRTIGHT, zero confirmed defects** (repro-mandated adversarial
  reviewer over `51facf1`..`df44193`; real two-org `startServer` on ephemeral
  pg + fake S3). **59 attack assertions across all 7 invariants; 58 rejected
  exactly, the 1 non-pass was the reviewer's own wrong expectation** (`/v1/graph`
  returns 200 SPA-catchall, NOT a JSON 404 — the colocated `planRun` route is
  genuinely DEAD post-`df44193`, so a GET falls through to the static SPA like
  any unknown path; that CONFIRMS delegation removal rather than refuting it).
  **Refuted by executed repro (the boundary holds):** cross-org cache read
  (orgB GET of orgA's key → 404, incl. 10 hostile `x-vx-cache-scope` values —
  `..`/`../..`/encoded slashes/orgA's UUID/`_org`/`trusted`/absolute — all 404;
  trusted tier ignores the header, `subScopeOf` collapses `.`/`..`/non-matching
  to `shared`, `validScope` re-checks every segment); cross-workspace within an
  org (bidirectional `_org`↔ws segment isolation, all 404); scope injection
  (every one of 7 S3 keys matched `^org/<uuid>/ws/(_org|<uuid>)/(trusted|
untrusted/<seg>)/<hash>.tar.zst$` — none escaped to `..`/bucket-root/
  `etc/passwd`; untrusted `scope=trusted` nested harmlessly at
  `…/untrusted/trusted/…` and a trusted GET of it → 404 = poison isolation;
  per-PR `pr-42` write / `pr-99` read → 404); dist pool cross-org (two orgs'
  agents with IDENTICAL ws+session+commit over the real `/v1/agents` WS —
  neither saw the other, `remoteAgents=1` each; `orgId` reaching `hello`/
  `availableCapacity` is `data.principal.orgId`, never on the wire); provenance
  leak (orgB PUT of the same hash → own copy with `task: undefined`, no orgA
  `secretproj` provenance; `?ws=<orgA ws>` clamped to the token's own org);
  delegation dead (`{t:'run'}` → rejection error, `/v1/runs/queue` → 404, no
  handler/import survives); token forgery/privilege (session on `/v1/cache/:hash`
  → 403 machine-token-only; ci minting an admin token → 403; spoofed `x-vx-org`
  header ignored — org is DB-derived from the token hash; `?org=`/`?ws=` foreign
  → scoped-to-own-org / 404). S3 `violations` stayed empty (no credentialed /
  scope header leaked onto a presigned path). **Accepted by-design
  (informational):** an instance-admin session reads any org (operator
  superuser, not a customer boundary); an org-wide token lists the shared `_org`
  scope while binding provenance to a `?ws=`-chosen workspace WITHIN its own org
  (intra-org, no cross-tenant exposure). Root cause of the isolation: ONE
  chokepoint `basePrefix(p) = p.bucket ?? org/${orgId}/ws/${workspaceId ?? _org}`
  fed only by a server-built `Principal` (the `api_tokens` row keyed by
  `sha256(token)`) + the registry `sessionKey(orgId, ws, session)` + analytics'
  `WHERE workspace_id/org_id` clamps — no reachable path threads a wire value
  into any of them. No code change (clean verdict).

- **2026-07-12**: **Platform Phase 3 SHIPPED — cache + dist re-keyed to the
  org/workspace tenancy prefix; run delegation DELETED (`51facf1`,
  `e690a82`, `df44193`)**, executing P3 of
  `docs/design/cloud-platform-2026-07.md`. **(1) Cache scope is now
  tenant-partitioned (§8.1).** The artifact-store scope grew from
  `<bucket>/<tier>` to `org/<orgId>/ws/<workspaceId>/<tier>[/<sub>]`, ALL
  server-derived from the token — `Principal` became
  `{ orgId, workspaceId?, tier, bucket? }`, `basePrefix(p)` =
  `p.bucket ?? org/${orgId}/ws/${workspaceId ?? _org}`. The org is the top
  tenant boundary (one org's token can NEVER read another's key); the
  workspace is the token's bound workspace, or a reserved shared `_org`
  segment for an org-wide token (its cache is shared across the org's
  workspaces — `_org` isn't a valid UUID so it can't collide). The tier
  boundary (fork-PR CVE fix) survives unchanged: untrusted writes only
  `untrusted/<sub>`, reads `untrusted ∪ trusted`; trusted never reads
  untrusted; per-PR sub-scopes; immutability 409; byte cap; zstd-magic
  gate. The server gate derives the workspace from the token (ws-scoped →
  its ws; org-wide → `_org`); a session gets an org-wide trusted principal.
  The transitional single-tenant serve + the store-policy unit tests set an
  explicit `bucket` override, which IS the scope base (`default/trusted`),
  byte-identical to the pre-platform layout (legacy flat store still
  migrates there). **(2) Dist sessions re-keyed by org (§8.2).** The agent
  registry key grew `{workspaceId, session}` → `{orgId, workspaceId,
session}`; `orgId` is a trailing `'default'`-defaulted param on
  hello/beginSubmission/availableCapacity, SERVER-derived from the agent's/
  submitter's token (never on the wire — NO DIST_PROTOCOL bump). Two
  tenants' pools can never collide or pair; `dist:submit` runs under its ci
  token's org. `/v1/artifacts` producing-task provenance moved off the
  residual SQLite store onto Postgres `task_runs` (workspace-clamped via
  Analytics `provenanceForHashes`), scoped by the principal's cache prefix
  so provenance never crosses the tenant boundary. **(3) Run delegation
  DELETED.** The platform has no checkout to execute against, so the
  server-side `RunQueue` (`run-queue.ts`, `protocol-queue.ts`), the
  `{t:'run'}` WS handler (now a clear rejection error), `cli/backend.ts`,
  and `connect --delegate` (rejected at the environments-file boundary with
  a migration hint to `--distribute`) are GONE. Distribution
  (`VX_CLOUD_DISTRIBUTE` → agent pool, or local) is the ONLY remote
  execution. −1308 lines net in df44193 (run-queue + serve delegation +
  plugin backend rung + their suites). **Verified END-TO-END with the real
  server** (ephemeral pg + fake S3 + live `vx-cloud server`): register
  instance admin → create orgB → mint org-wide + ws-scoped trusted tokens →
  PUT cache artifacts → the S3 bucket keys carry the full
  `org/<orgA>/ws/{_org|<wsId>}/trusted/<hash>.tar.zst` tenant prefix; orgA
  GETs its own key (307), orgB GET of orgA's key → 404 (cross-org), a
  ws-scoped token can't read the `_org` key and the org-wide token can't
  read the ws key (both 404, ws-segment isolation), orgB (wrote nothing)
  has ZERO keys. Cloud 473→464 (−9: delegation suites deleted; +store
  tenancy matrix, +dist org-key pins, +server principal-derivation);
  core 1221 untouched (ZERO src/ change), core ci + cloud lint/fmt clean.
  **DEVIATIONS (phase-honest, all P4-scoped, accepted):** the residual
  `startServe` (serve.ts) keeps its colocated `/v1/graph` live-cockpit +
  SQLite-backed dist duration hints (FIFO fallback when absent) + the
  WorkspaceCatalog/MCP/IngestStore machinery — P4 absorbs serve.ts into
  server.ts and deletes the SQLite stores; the registry orgId param is
  trailing-optional (`'default'`) for that transitional path. **Deferred:**
  P4 (dashboard login/admin UI + serve.ts absorption + SQLite-store
  deletion + companion-suite retarget), P5 (compose/image/docs).

- **2026-07-11**: **Tenant-boundary + query review of platform Phase 2 —
  crown jewel VERDICT AIRTIGHT; three non-tenant defects fixed
  (`1aaa694`)** (repro-mandated hostile reviewer over `304ac5c`..
  `7df5232`; real two-tenant driven server). **Refuted by executed
  repro (the tenant boundary holds):** every one of the 27 reads is
  structurally clamped `WHERE workspace_id = <server-uuid>`; two orgs
  pushing the SAME client workspace string get DISTINCT server
  workspaces (isolated by `repos UNIQUE(org_id, client_workspace_id)`);
  org B with `?ws=<A's ws>` → 404, `?org=<A>` token ignores it, session
  → 404; fetching A's run/invocation/why/diff/compare/logs by id as B →
  404/found:false (the secret never appears); SQL injection inert
  (values stored verbatim as data); idempotent re-ingest; bounded
  500-task run; retention-drop boundary correct; and a SQLite-vs-Postgres
  DIFFERENTIAL of getFlakiestTasks/getHistory/listRuns (incl. the
  wallclock-ns string shape)/getRunTrends/getPeriodComparison (empty
  window → COALESCE 0)/getRegressions/getCacheSavings deep-equal. **Fixed
  (all NON-tenant):** **(1) HIGH — partition maintenance was BOOT-FATAL.**
  Postgres refuses to create a range partition when DEFAULT already holds
  an in-range row (a backfill, a future-dated push past the ahead buffer,
  a lagging tick — ingest never range-validates `started_at`), and that
  throw aborted the whole tick (invocations first → cascades to
  task_runs/task_logs) while boot AWAITED it uncaught — so a poisoned DB
  made the server UNBOOTABLE platform-wide, triggerable by the
  lowest-privilege writer. Now each table/partition failure is isolated
  (logged, skipped), `maintainPartitions` NEVER throws, boot never dies
  on it, and a DEFAULT collision is RECOVERED (detach DEFAULT → create
  partition → move the in-range rows in → reattach) so the row lands in
  its own partition instead of wedging maintenance forever. **(2) MEDIUM
  — concurrent first-push data loss.** The `workspaces` INSERT wasn't
  conflict-guarded, so N parallel first-pushes of a new workspace raced
  on `UNIQUE(org_id, slug)` and N-1 aborted with the raw Postgres error
  (400, history dropped) before the repo-claim recovery. `routeWorkspace`
  now retries from the fast-path read on a unique violation — the same
  client id converges to the winner's workspace, a slug-colliding
  different client picks the next free slug. **(3) MEDIUM — the tag
  filter never matched.** jsonb columns were `JSON.stringify(obj)::jsonb`
  which Bun.sql DOUBLE-encodes into a jsonb STRING scalar, so
  `tags @> …` degenerated to equality (never matched a multi-tag run);
  reads were accidentally masked by a JSON.parse. Now tags/requestedTasks/
  fingerprint-files/config are written as OBJECTS (proper jsonb, verified
  `jsonb_typeof=object`), the `@>` filter passes an object, and the read
  layer accepts the object form (still parsing a legacy string
  defensively). Pinned by 5 regression tests. **Accepted residuals
  (informational):** past-dated rows in DEFAULT are never pruned by
  retention (minor accumulation); the double-encoding was systemic but
  only the tag filter observably broke. Cloud 469→473 (+4), core ci +
  lint clean. **Verdict: tenant isolation + the SQLite→Postgres port are
  solid to build Phase 3 on.**

- **2026-07-11**: **Platform Phase 2 SHIPPED — the analytics storage
  swap onto Postgres (`304ac5c`, `22b6125`, `de22e97`, `7df5232`)**,
  executing P2 of `docs/design/cloud-platform-2026-07.md`. The
  `vx-cloud server` analytics path is now FULLY on Postgres end-to-end.
  **Schema (migrations 0004-0006):** `invocations` (monthly RANGE
  partitions), `task_runs` (weekly — the 50-100M-rows/day table),
  `task_logs` (monthly), each with a DEFAULT catch-all partition so
  ingest never drops a row; `output_fingerprints` plain; every hot
  index leads with `workspace_id` (the tenant axis). `db/partitions.ts`
  creates current+N-ahead partitions idempotently + drops past
  `VX_CLOUD_RETENTION_DAYS` (default 180); a boot + daily maintenance
  tick runs it. **`db/analytics.ts`:** the write half (`ingest`/
  `ingestLogs`/`ingestCatalog` in one idempotent
  `ON CONFLICT (started_at, run_id) DO NOTHING` transaction — race-free,
  unlike core's SELECT-then-insert gate) + `routeWorkspace` (§5.5: the
  org token's org → resolve-or-create the `workspaces` row by the
  client's 16-hex `workspaceId` on first push; auto-provision projects/
  tasks; a workspace-scoped token is refused a foreign ws), and the
  full port of core's 27 read queries, org/workspace-CLAMPED. Core
  `metrics.ts` is UNTOUCHED (it serves the LOCAL cache.db for `vx mcp`/
  `vx info`); the Postgres port is a deliberate dialect fork.
  `db/analytics-routes.ts` is the request router the server gate calls.
  **Dialect decisions:** Bun.sql returns bigint/count/sum/numeric as
  STRINGS (aggregates cast `::int`/`::float8`; bigint cols `Number()`'d;
  wallclock ns kept as its wire string); jsonb reads back as TEXT
  (`JSON.parse` the tag/config/files columns — core's TEXT-column
  pattern); Postgres HAVING can't ref output aliases (repeat the
  aggregate); `trunc(avg())::int` for SQLite toward-zero parity; the
  invocation tag filter uses jsonb `@>` containment (the correct form
  of core's `LIKE` hack). Drift-trap pins carried over (periodStats
  COALESCE, getRegressions `run_id DESC` tiebreaker, half-open
  `[from,to)` windows). Cache-ENTRY inventory queries return shaped
  empties — the analytics schema holds run/task history only; cache
  inventory IS the S3 artifact list (§5.1). **Verified END-TO-END with
  the real server** (ephemeral pg + fake S3): register → mint ci token
  → ingest into TWO workspaces (both auto-provisioned) → read back
  per-workspace (ws A shows only its runs) → projects auto-provisioned
  → a second org's token reads empty, a foreign `?ws=` is 404, a
  cross-org session `?ws=&org=` is 404 (tenant clamp holds on the real
  wire). Cloud 423→469 (+46: schema/partition, write/routing,
  read-query pins with a decoy-workspace clamp proof, e2e); core 1221
  untouched (ZERO src/ change). **DEVIATION (phase-honest, named):**
  the SQLite stores (`ingest-store`/`log-store`/`fp-store`/
  `workspace-catalog`/`workspaces.json`) + serve.ts's colocated
  `/v1/graph`/`/v1/workspace/*` are NOT deleted — the design's §12 puts
  serve.ts's absorption into server.ts + the ~15 companion-suite
  retarget in P4, and those stores still back `startServe`
  (transitional until P4). The P1 per-org SQLite `storeFor` IS removed;
  serve.ts keeps ONE shared store only for residual machine surfaces
  (dist duration-hints, `/v1/artifacts` provenance, `/mcp`, delegated
  self-ingest — all P3/P4). Two smaller residuals: Postgres-served
  `/v1/runs/:id/logs` drops the `artifactHash` link (P3 re-adds via
  artifact-store access), `/mcp` still reads the empty shared store
  (MCP-on-Postgres is a follow-up). Response types are mirrored in
  `analytics.ts` (not on the façade; the no-core-change constraint) and
  pinned by the seeded tests. **Deferred:** P3 (cache wire + dist under
  org tokens + `org/<id>/ws/<id>` scope prefixes + delegation death),
  P4 (dashboard auth/admin UI + serve.ts absorption + SQLite-store
  deletion + companion-suite retarget), P5 (compose/image/docs).

- **2026-07-11**: **Security review of platform Phase 1 — auth
  foundation VERDICT SOUND; three availability/enumeration defects fixed
  (`13d8be5`)** (repro-mandated hostile reviewer over the auth layer;
  real ephemeral pg + driven server). **Every authorization invariant
  held under executed repro (refuted as attacks):** session forge/tamper
  (HMAC timingSafeEqual before any DB read; id sha256-at-rest), expiry +
  sliding renewal, fixation (login rotates id), logout (server-side row
  DELETE), token immutability (no route mutates trust_tier; admin tokens
  force-trusted) + revocation, the full RBAC/cross-org matrix (member/
  viewer can't mint/change-role/self-promote; cross-org is 404 no-leak;
  admin TOKEN can't manage owners), the last-owner guard (applies to
  instance admins too), the bootstrap-admin race (8 concurrent first-
  registers → exactly 1 admin via the xact advisory lock), SQL injection
  (all values are Bun.sql tagged-template params; no user value in
  `sql.unsafe`), password handling (argon2id, no manual compare), the
  config-refusal boot, and the `eeffcb5` env-shield. **Fixed (all
  availability/enumeration, NOT authorization):** **(1) MEDIUM invite-
  accept TOCTOU** — the accept path read `used_by IS NULL` then updated
  in separate statements, so N concurrent accepts of ONE invite all
  onboarded (an owner-role invite → N owners). Now an atomic conditional
  `UPDATE … RETURNING` inside a transaction claims it (a second accept
  row-locks, finds it used, RETURNING empty → 403); not-an-org / already-
  member throw to roll the claim back so a legit retry isn't burned. The
  register path was already safe (serialized on the bootstrap lock).
  **(2) MEDIUM throttle bypass + unbounded map** — keyed only on the
  client-supplied leftmost XFF (IP rotation defeated it) with no eviction
  (a pre-auth memory-exhaustion vector). Now ALSO keys per-email (the
  attacker can't avoid the victim's address, so rotation doesn't help a
  targeted attack) + self-evicts expired entries + caps at 50k keys.
  **(3) LOW-MED login timing oracle** — argon2 was skipped for an unknown
  email (~300× faster = a clean enumeration oracle, and its stated
  compensating throttle was itself bypassable). Every login now runs one
  argon2 verify (a memoized dummy hash for unknown emails). Pinned by 4
  regression tests. **Accepted residuals (informational):** login/
  register aren't CSRF-gated (the JSON+no-CORS requirement blocks the
  form attack; impact is only login-CSRF, low for a same-origin SPA); the
  register email-exists 409 is reachable only with a valid invite; the
  IP-axis throttle still needs a trusted proxy to be meaningful (the
  email axis is the real defense). Cloud 419→423 (+4), lint clean.

- **2026-07-11**: **Platform Phase 1 SHIPPED — identity/auth/RBAC on
  Postgres, config-required `vx-cloud server`, the `serve` verb REMOVED
  (`f1b0b46`, `2970fff`, `36e8257`, `eeffcb5`)**, executing P1 of
  `docs/design/cloud-platform-2026-07.md`. **DB layer:** `db/client.ts`
  (a thin `Bun.sql` seam — zero deps), `db/migrate.ts` (numbered
  embedded-TS migrations applied in ONE transaction under
  `pg_advisory_xact_lock`, so concurrent compose boots serialize —
  finally kills the schema-gate-wipes-history landmine), migrations
  0001-0003 (identity/tenancy/credentials). **Auth:** argon2id
  (`Bun.password`); opaque 256-bit sessions sha256-at-rest with
  `<id>.<hmac(secret)>` HttpOnly cookies + 30-day sliding renewal;
  `vxc_` API tokens sha256-at-rest with an IMMUTABLE trust tier (the
  fork-PR cache invariant becomes a token property); `/v1/auth/*` (first
  registration becomes the instance admin, then signup CLOSES —
  invite-only; per-IP+email login backoff; CSRF header on session
  mutations) + `/v1/admin/*` (orgs/members/invites/tokens/workspaces;
  cross-org reads 404; last-owner guard); one `resolvePrincipal`
  middleware over the §6.5 surface→principal map. **`vx-cloud server`:**
  `resolveServerConfig` refuses to boot listing EVERY missing var
  (DATABASE_URL, VX_CLOUD_SECRET ≥32, VX_CLOUD_BASE_URL, the four S3
  vars) — no tokenless mode, no loopback exemption; boot = reach
  Postgres → migrate → S3 list-probe (fail loud) → bind `0.0.0.0`. The
  `serve` verb prints a redirect to `server`. **Transitional (named,
  §12 P1):** analytics still ride the SQLite `IngestStore`, now
  per-org under `<dataDir>/orgs/<orgId>`, and the token's org id is the
  artifact-store bucket — so cache scopes are org-partitioned from P1
  (verified: an untrusted token's PUT lands under `<orgId>/untrusted/`,
  a trusted GET never reads it). **Tests: real ephemeral Postgres, no
  mocks** — `tests/helpers/ephemeral-pg.ts` boots ONE cluster/process
  (initdb + unix-socket, runs as the `postgres` user since this env is
  uid 0; CI runners take the direct path), migrates a `template_vx`
  once, per-suite `CREATE DATABASE … TEMPLATE` clones. Cloud 379→419
  (+10 db, +17 auth, +12 server, +1 the boot-bug regression); core 1221
  untouched (zero `src/` change). **Verified END-TO-END with the real
  CLI** (ephemeral pg + fake S3): boot migrates an empty DB, register →
  instance admin + owner org, second register 403, mint CI token,
  ingest 403-as-session/200-as-token, runs read back under the session,
  untrusted PUT stored org-scoped + trusted GET 404, controller holds 0
  artifact bytes. **Bug the e2e caught + fixed (`eeffcb5`):** `Bun.sql`
  consults `process.env.DATABASE_URL`/`POSTGRES_URL` even when handed a
  socket options object, so a libpq unix-socket URL in the env (which
  `server` sets) threw `<redacted> cannot be parsed as a URL` at boot —
  invisible to the test suite, which never put the socket URL in the
  env. `openDb` now shields the sync socket construction from those two
  vars; production compose (TCP URL) never hit it. **Deviations
  (named):** WS-side surfaces (delegated-run self-ingest, dist hints)
  still use the shared store (proper routing needs P2 repos + P3
  re-keying); `VX_CLOUD_DATA_DIR` added for the transitional volume
  (dies with P2); `/v1/artifacts` is session-readable (dev read
  surface). **Deferred:** P2 (Postgres analytics tables + the ~40-query
  metrics port + IngestStore deletion), P3 (org/ws scope prefixes,
  registry re-key, delegation death), P4 (dashboard login/admin UI +
  `startServe` deletion), P5 (compose/Dockerfile/guides). `startServe`
  survives as an internal transitional export until P4 so the 34
  pre-existing serve suites keep passing.

- **2026-07-11**: **OWNER DIRECTIVE — vx-cloud is a fully INDEPENDENT
  self-hosted CI PLATFORM, not a companion** ("It should be a fully
  completely independent SaaS app! with full account creation,
  permission roles users, multi workspaces, repos, projects, teams,
  everything. It should be deployed as docker compose. It should be
  not possible to call vx-cloud serve. It is not companion. it
  requires setup of s3 db etc… it is not run next to vx thing. its a
  self hosted cloud solution that cover orgs of 100000 of devs and
  with millions of projects. Work on it no questions asked").
  REVERSES: the companion/zero-config-local-serve model (the 2026-06-28
  "vx-cloud serve --ui next to the workspace" story, the colocated-
  workspace catalog premise, SQLite-per-workspace ingest as THE store),
  and the single-token auth model. Target: accounts (email+password,
  sessions for the UI, hashed API tokens for CI/agents), RBAC
  (org → teams → members with roles; workspaces/projects/repos scoped
  to orgs), Postgres as the system of record (Bun.sql — built-in, zero
  deps; Postgres 16 available in this env AND CI for real hermetic
  tests via ephemeral initdb + unix socket), S3 REQUIRED (the
  2026-07-11 blob backend becomes mandatory), docker-compose deployment
  (app + postgres + minio-or-external-S3), boot REFUSES without full
  config (DATABASE_URL + S3 + secret), and the casual `serve` verb
  DIES. The `cloud()` plugin/connect client story survives — a
  workspace CONNECTS to a deployed platform (URL + token); nothing
  auto-starts next to vx. Architecture + phasing:
  `docs/design/cloud-platform-2026-07.md`.

- **2026-07-11**: **Adversarial review of the S3 blob-backend wave —
  VERDICT SOUND, zero defects; two accepted residuals noted** (repro-
  mandated hostile reviewer over `be446b7`+`a13de4a`). **Refuted by
  executed repro:** SigV4 byte-stability (wire == canonical through
  `new URL().toString()`, four AWS-docs KATs), trust scopes through the
  REAL serve+bucket flow (traversal `x-vx-cache-scope` values all
  collapse to `shared/untrusted`, a trusted GET never presigns an
  untrusted key, presigned URLs carry neither bearer nor scope),
  dead-bucket safety (a real run stays ok=true on both PUT and GET
  paths; wire = loud 502, internal probes degrade; garbage XML → `[]`),
  spool lifecycle (unlinked on success/throw/disconnect/over-cap; a
  half-upload never immutability-locks the key), digest-fallback
  precedence (first-wins — a wrong `x-vx-digest` is never rescued by
  the meta fallback), `resolveS3Config` (empty env = unset; partial
  config prevents BOOT, never a silent local fallback), zero core
  changes, cloud 379 green. **Accepted residuals (noted in the design
  doc):** a GET response carrying NEITHER digest header is unverified
  (the native wire's pre-existing advisory-digest property — both
  stores always attach one in practice); exotic operator env values
  (lone-surrogate prefix → loud 502 at request time, >7-day presign
  TTL) are unvalidated — neither reachable from the untrusted wire.
  **Same day: `install.sh` and the one-time npm seeding script were
  REMOVED (owner: "no scripts are allowed in repo" — one-time only).**
  npm is THE install path (`npm install -g @vzn/vx`); every doc install
  block + CI recipe swapped. Context: the curl installer's missing
  PATH persistence caused a "command not found" report (fixed, then
  removed with the installer); the four `@vzn/vx-cloud-<target>` names
  were successfully seeded on the registry by the owner (the publish
  404 was missing npm auth), unblocking Trusted Publisher config + the
  npm workflow re-run that completes the `@vzn/vx-cloud` publish.

- **2026-07-11**: **The S3 blob backend SHIPPED — the serve stores zero
  artifact bytes at rest when a bucket is configured (`be446b7`,
  `a13de4a`)**, executing the same-day directive below, zero deviations
  from the design. **The seam:** raw storage moved behind `BlobBackend`
  (`packages/cloud/src/blob/{backend,local,s3}.ts`) — `ArtifactStore`
  keeps ALL policy (trust scopes, immutability-409 via `backend.head`
  BEFORE the body, streaming spool + mid-stream byte cap + zstd-magic
  gate, metadata validation); `LocalDirBackend` is today's flat dir
  byte-identical (the zero-config default); `S3Backend` = path-style
  signed HEAD/PUT/ListObjectsV2 (hand-parsed XML, bounded continuation)
  - SigV4 query-presigned GET. **Wire:** GET on S3 answers **307** to a
    presigned URL (TTL 300 s default) — the controller never proxies a
    download; the client (already shipped) follows one hop dropping
    bearer + scope; metadata rides `x-amz-meta-vx-digest`/`-duration-ms`
    and `NativeCacheClient` reads those as fallbacks (same DIGEST_RE), so
    digest verification survives offload. PUT keeps proxying (spool →
    S3 PUT with UNSIGNED-PAYLOAD → unlink in `finally`) so every
    server-enforced gate survives — transit, not storage. A throwing
    bucket is a LOUD **502** on the wire (never 404-as-miss); the
    internal `has`/`storedDurationMs`/`list` probes degrade best-effort
    so a down bucket can't crash a dist submission. **SigV4 hand-rolled**
    (`blob/sigv4.ts`, node:crypto only, NO AWS SDK): per-segment AWS URI
    re-canonicalization, header-signed + query-signed forms; pinned by
    FOUR AWS-docs vectors (docs.aws.amazon.com is proxy-denied here —
    vectors from memory, all four reproduced exactly on first run) + two
    self-KATs + encoding edges. **Config:** `resolveS3Config` —
    `VX_CLOUD_S3_ENDPOINT` enables; missing BUCKET/KEY/SECRET = boot-time
    hard error naming the vars (never a silent local fallback);
    credential-free boot line names the mode. **Verified independently
    with the real CLI** (real serve in S3 env + standalone fake S3): cold
    run → artifact lands in the bucket under `default/trusted/` while the
    controller artifact dir holds **0 files** (the directive, asserted),
    direct GET → 307 with a well-formed presigned URL, local wipe →
    `restored-remote` through the offload with the fallback digest, and
    the bucket recorded ZERO credentialed presigned requests (the
    cross-origin drop through a real flow). Tests: cloud 379 pass (+27:
    SigV4 KATs, S3-mode store suite incl. trust-scope matrix +
    junk-PUT + chunked-cap + bucket-down-502 + list pagination, the
    controller-byte-free e2e with tampered-bucket degradation,
    client-fallback pins); core ci green; fake-S3 helper records
    credentialed-presign violations as a standing assertion. Docs: cli.md
    env table + 307 semantics, self-hosting S3 section (R2/MinIO
    examples), deploy compose/README, the native-wire design's offload
    flipped to shipped. Deferred consciously: PUT offload (client→bucket
    presigned upload — would hand immutability/caps/junk-gate to the
    client), bucket migration tooling, spool-gone tmpdir assertion
    (covered by the controller-byte-free e2e + shared finally).

- **2026-07-11**: **OWNER DIRECTIVE — the serve must NOT store artifact
  bytes; connect to an S3-compatible bucket** ("we cannot store cache on
  controller need to connect with s3 compat bucket"). Un-parks the
  designed-not-built blob backend from `native-cache-wire-2026-07.md`
  §offload. Design: `docs/design/s3-blob-backend-2026-07.md` —
  `BlobBackend` seam inside ArtifactStore (policy — scopes/immutability/
  caps/zstd-magic — stays in the store; raw storage goes behind the
  seam), GET answers 307 to a SigV4 query-presigned bucket URL (the
  client already follows one auth-dropping hop), PUT keeps proxying
  through the serve (temp spool → S3 PUT → unlink; transit, not
  storage) so every server-enforced gate survives, metadata rides
  `x-amz-meta-vx-*` with client fallback reads, hand-rolled SigV4
  (NO AWS SDK, KAT-pinned), env-driven config with partial-config a
  boot error. Local-dir backend stays the zero-config default. The
  analytics/log/fp DBs stay on the controller — they are state, not
  cache.

- **2026-07-10**: **Adversarial review of the native-cache wave — one
  confirmed store-hygiene defect + two minors fixed; every
  security-critical invariant verified sound by executed repro**
  (repro-mandated hostile reviewer over `ca85901`..`5cdbe24`; the
  session's standard). **Fixed:** **(1) LOW-MEDIUM — junk-PUT permanent
  key lock.** The store accepted ANY authenticated PUT body (empty,
  HTML error page) and immutability then 409'd the legitimate artifact
  forever — a per-key cache-defeat DoS (executed: empty PUT → 200 →
  0-byte artifact → real PUT → 409; consumer side stayed SAFE — the
  junk GET degrades to a miss via the client digest/zstd checks, never
  a wrong hit; blast radius tier-bounded). Fix: PUT gates on the zstd
  frame magic (4 bytes, captured mid-stream — NOT content validation,
  which stays client-side) → 400, nothing stored, key stays writable;
  pinned by empty-body/junk-body/key-not-locked tests, and every store
  test body became a real zstd frame (`zbody` helper). **(2) LOW —
  `x-vx-cache-scope` leaked to a cross-origin redirect target** (only
  the bearer was dropped). The scope header is serve-facing identity;
  now gated on the same-origin flag exactly like the bearer, pinned by
  the extended cross-origin test. **(3) LOW — `docs/differentiators.md`
  still advertised the DELETED Turbo-HMAC signing** as a live
  differentiator; rewritten to the always-on `x-vx-digest` structural
  integrity story. The design doc's wire table synced to as-shipped
  (PUT 400 row; the no-server-side-422 deviation noted inline — the
  2026-07-08 doc-correction precedent). **Verified sound (executed
  repros, NOT actioned):** trust scopes under hostile
  `x-vx-cache-scope` values (`..`, `../trusted`, encoded slashes — all
  collapse to `shared`, none escape), per-PR isolation + trusted-never-
  reads-untrusted through a REAL serve with real trusted/PR tokens,
  streaming-PUT cap (chunked over-cap → 413, no temp/torn file;
  disconnect mid-stream → temp unlinked), concurrent same-hash PUT
  race is torn-free, route regex shadows nothing, digest mismatch
  degrades a REAL run to re-execution, redirect loop stops at one hop,
  HEAD/PUT never follow redirects, dead-serve run stays ok=true,
  injection-wins precedence, `--cache=remote:`/`--no-cache` issue zero
  remote calls, planRun is HEAD-only (1 HEAD, 0 GET), agents always
  construct the remote layer (§6 output transport preserved), zero
  dead-surface references in live code. **Accepted (informational):**
  `/v1/cache/<non-hex>` falls through to the SPA like any unknown path
  (public HTML, still token-gated as `/v1/*`); an untrusted sub-scope
  literally named `trusted` nests harmlessly UNDER `untrusted/`. Cloud
  352 pass (+2), core 1221, lint clean. **Process lesson (the fix
  commit `d608f3a` itself went out RED):** the `zbody` helper's
  `Uint8Array` annotation broke tsgolint (TS2769 — `toEqual` pins the
  expected type to the actual's `Uint8Array<ArrayBuffer>`), and the
  local gate DID catch it — but the lint run was piped through
  `| tail`, which masked the non-zero exit code, so the `&&` chain
  committed and pushed anyway. Fixed in `9c6f260`. Rule: never pipe a
  gate command's output through anything; check its exit code
  explicitly (`cmd > file 2>&1; echo $?`), and confirm the REAL CI run
  green after pushing — "the summary printed" is not "the gate
  passed".

- **2026-07-10**: **The plugin-driven remote cache SHIPPED — all three
  phases of `docs/design/native-cache-wire-2026-07.md` (`ca85901`,
  `a50a93e`, `aa1797f`, `5cdbe24`)**, executing the same-day owner
  directive below. **Phase A (core seam):** exported `RemoteCacheLayer`
  interface (`has`/`get`/`put`; implementations THROW, `LayeredCache`
  degrades every throw to a miss) + `RunOptions.remoteCache` embedder
  injection that WINS over the plugin `cache` capability (the
  telemetrySinks pattern). **Phase B (the vx-native wire):** the serve's
  ArtifactStore handles `/v1/cache/:hash` (GET/HEAD/PUT) — headers
  `x-vx-duration-ms` (the `.duration` sidecar's wire form) and
  `x-vx-digest` (`xxh3:<hex>` over the artifact bytes, stored as a
  `.digest` sidecar, echoed on GET); PUT STREAMS to the temp file with
  the 512 MiB cap enforced on ACTUAL cumulative bytes mid-stream (a
  chunked/lying body can neither buffer RAM nor spoof the cap);
  immutability 409 checked before the body; trust scopes byte-identical.
  New `packages/cloud/src/native-cache.ts` `NativeCacheClient`: bounded
  downloads (content-length REQUIRED + capped + mid-stream cap), digest
  verification (mismatch throws → miss), ONE-hop 307/302 follow DROPPING
  the bearer cross-origin (the blob-offload seam, client-ready before any
  server implements it), clearable timeouts, 409-as-success on PUT.
  `cloud()` builds it when the connected serve advertises `cacheWire: 1`
  on `/v1/meta`; distributed agents/submitter switched from env wiring to
  explicit `RunOptions.remoteCache` injection (both execute in-process
  scoped `run()`s — no subprocess channel exists; `markAgentProcess`
  keeps the telemetry sentinel). `/v8/artifacts` is DELETED. **Phase C
  (core scrub):** `src/cache/remote-cache.ts` (Turbo client + HMAC +
  preflight) and `orchestrator/remote-cache-setup.ts` (`VX_REMOTE_CACHE_*`
  env hatch) deleted — core carries ZERO HTTP cache code; the façade
  drops `RemoteCache` (boundary snapshot updated); `vx info` drops its
  env-derived remote-cache row; `resolveCacheScope` survives untouched
  (reads `VX_CACHE_SCOPE` + CI PR context — the per-PR partition concept
  is part of the native wire). Turbo interop = the ~20-line third-party
  recipe in the extensibility guide. **Named deviations (deliberate):**
  no server-side digest verify (no 422 — the CLIENT verifies on GET,
  which covers the corruption directions that matter; the server skips a
  hash pass per upload); the serve route is hex-only `[0-9a-f]{16,64}`
  so it can never shadow the named `/v1/cache/*` analytics endpoints
  (pinned by a no-shadowing test); ArtifactStore's byte cap is
  constructor-injectable so the mid-stream 413 is testable without a
  512 MiB body. **Verified end-to-end** (real serve + the real `cloud()`
  env ladder): cold miss → upload (`.tar.zst` + `.duration` + `.digest`
  land in `default/trusted/`), local wipe → `restored-remote` with output
  - stdout replay, GET carries both native headers, tampered artifact →
    digest mismatch → degrades to a MISS and re-executes (never restores
    corrupt bytes), `/v1/meta` advertises `cacheWire: 1`, `/v8` no longer
    routes. Tests: core 1221 pass (orchestrator-remote re-targeted through
    injected stub layers — coverage preserved incl. never-fail-on-500,
    at-most-once GET, planRun HEAD prediction, `local:,remote:rw` in-memory
    pack), cloud 350 pass (+16-test native-client suite incl. raw-TCP
    sizeless refusal + cross-origin auth-drop), lint clean. Docs: cli.md /
    comparison.md / caching / architecture / extensibility (the Turbo
    recipe) / remote-caching guide all speak the native wire; the two dead
    module pages deleted. Remaining designed-not-built: the serve-side blob
    backend (S3/R2) behind the 307 the client already follows.

- **2026-07-10**: **OWNER DIRECTIVE — the remote cache is PLUGIN-DRIVEN;
  Turbo wire compatibility is DROPPED from core** ("I think the remote
  cache should be driven by a plugin. We should drop turbo compatibility,
  and use what make sense for vx cloud. Other could create turbo cache
  plugin"). REVERSES: the 2026-05 "remote cache wire = Turbo
  `/v8/artifacts/` spec verbatim" decision, the 2026-06 Turbo-compatible
  HMAC rationale, and the same-day preflight client (`8fbd2c5`) whose
  premise was Turbo interop. Target state: core keeps ONLY the seams —
  local `Cache`, `LayeredCache` composition, the `CacheLayer` interface,
  and the `cache` plugin capability; the Turbo-wire `RemoteCache` client
  - the `VX_REMOTE_CACHE_*` env wiring LEAVE core. vx-cloud speaks its
    OWN artifact wire designed for vx's needs (trust scopes, integrity,
    streaming — not constrained by Turbo's shape); Turbo interop is a
    THIRD-PARTY plugin story (we document the seam; we don't ship the
    plugin). The presigned-artifacts design's "Turbo verbatim" premise is
    superseded — offload gets designed into the vx-native wire instead.
    Implementation phased behind an architect design
    (`docs/design/native-cache-wire-2026-07.md`).

- **2026-07-10**: \*\*The dashboard's product lens is THE SINGLE DEV
  (standing owner directive — see "Dashboard product lens" section above)
  - the first lens-driven wave SHIPPED (`df76cef`, `e969b92`)**. Owner:
    "the ui should be from single dev perspective. He wants to see it run,
    dig into projects he own, tasks analysis, see if his or improved or
    decreased performance, identify flaky tests give him easy access to
    debug like artifacts of run etc". Audit against the five questions:
    see-it-run ✓ (live Runs), flaky ✓ (badges + Recommendations), but
    "did MY task/project improve or decrease?" existed only
    workspace-wide, and debug evidence took multiple hops. Closed: **(1)**
    `getPeriodComparison` gains `project`/`task` scoping (one shared WHERE
    fragment; `/v1/analysis?project=&task=`), and BOTH entity detail pages
    render a scoped trend tile row (avg exec / failure rate / runs / hit
    rate, this 7d vs prior 7d, signed deltas tinted by direction) — the
    derivation shared with the Insights card via `trendFields()` in
    `ui/jr/data.ts`. **(2)** Task detail gains a **Debug card\*\*: last
    FAILED run deep-linked with `?task=` (captured logs open immediately),
    latest run (deduped when it IS the failed one), latest artifact's
    `/cache/:hash` page (facts + download) — RankList rows are BUTTONS with
    programmatic navigation, so link assertions must click, not query
    `<a>`. Browser-verified (task made 5× slower → `500ms`/`+400ms` amber
    tiles on both pages; the failed-run row lands on
    `/runs/<id>?task=app%23build`; zero page errors). Core 1251, cloud
    331, UI 40, lint clean. When adding dashboard features, check the lens
    section: a feature serving none of the five dev questions is
    org-analytics scope creep.

- **2026-07-10**: **Pre-signed artifact URLs: design + the client half
  SHIPPED (`5ecbc42`, `8fbd2c5`) — and the patterns feature's adversarial
  review closed a repro-confirmed stale-hit trap (`3e2a984`)**. **(1)
  Design** (`docs/design/presigned-artifacts-2026-07.md`, architect):
  adopt Turbo's `--preflight` mechanism VERBATIM (verified against
  `turborepo-api-client/src/lib.rs`: `OPTIONS` + Access-Control-Request-_
  → `Location` + `Access-Control-Allow-Headers` gates whether the bearer
  rides) — the HMAC interop rationale again; a vx-native wire was
  rejected. Phasing: (P1) core client preflight; (P2) cloud-only
  `BlobBackend` (S3/R2, hand-rolled SigV4, NO AWS SDK) with GET offload
  only — PUT keeps proxying so 409-immutability/caps/tag-sidecar stay
  server-enforced; (P3, on-demand only) PUT offload with its
  weakened-immutability residual stated honestly. Trust scopes survive by
  construction (the pre-signed URL binds ONE server-derived scope key).
  **(2) P1 shipped:** `RemoteCacheConfig.preflight` /
  `VX_REMOTE_CACHE_PREFLIGHT` — OPTIONS precedes each GET/PUT/HEAD with
  the intended method + header NAMES; `Location` (absolute or relative)
  becomes the target; bearer kept iff Allow-Headers is `_`or names`authorization`(a query-signed URL rejects a request that ALSO carries
Authorization). Off by default; every existing defense (bounded
download, content-length refusal, zstd checks, HMAC tag verification)
applies unchanged to the redirected body — pinned by a two-origin test
suite (9 tests, incl. unsigned-blob refusal). vx now works against any
Turbo server that offloads to object storage; the comparison gap is
client-closed. **(3) Self-review of the day's two features**
(repro-mandated, same standard as the Opus waves). CONFIRMED + fixed:
**(a) MEDIUM-HIGH — the patterns stale-hit trap.**`cache.inputs.tasks`matched`'build._'`LITERALLY while dependsOn expanded it → the filter
selected ZERO upstream hashes → the dependent DECOUPLED and cache-hit
stale bytes after its upstream changed (executed e2e: served v1 after
v1→v2). Shipping dependsOn patterns COMPLETED the trap (the pairing
used to hard-error). Fix: the task half of every filter form (incl.`pkg#`and negation, unlike dependsOn) shares the`_`-glob matcher;
pinned by 4 units + a real-CLI e2e that fails stale without the fix. NO
CACHE_VERSION bump — a config using a pattern here before was in the
silently-decoupled state; its key changing to fold the matched
upstreams IS the fix. **(b) LOW — duplicate edges** from mixed
exact+pattern (or literal duplicates, pre-existing): scheduling counts
balance (executed), but the upstream hash double-folded on the default
path and DOT printed the edge twice; `node.deps`deduped before the
sort. **(c)** empty`VX_GITHUB_CHECK_NAME`falls through instead of
naming a check`''`(a 422). **Refuted by execution:** edge-order
determinism (sort covers all pattern paths; warm re-run all-hits;`--frozen`green), regex escaping (17 adversarial names) + no-ReDoS,`^pattern` scoped-loading symmetry (prepare loads the full dep closure;
  both forms degrade identically), group surfacing, checks double-post
  (uploaded flag), agent sentinel (a distributed run posts zero checks —
  the documented distributed-ingest gap, not a dupe), endedAt epoch-ms,
  timer cleanup (blackhole API → exactly 5s, then exit). Core 1250 pass
  (+15), cloud 331, lint clean; real CI green on every push.

- **2026-07-10**: **`dependsOn` task-name patterns SHIPPED — `'build.*'` /
  `'^build.*'` (`660d299`)**, closing the last dependsOn gap vs Nx (19.5's
  `build-*`) and pairing with the dotted-namespace convention (`lint:
{ dependsOn: ['lint.*'] }` replaces hand-listing members). Semantics:
  a same-project pattern expands to every OTHER matching task (the
  declaring task never matches itself — instant self-cycle otherwise);
  ZERO matches is legal (a preset-spread pattern needn't match in every
  project — deliberate contrast with the exact-name hard error);
  `'^pattern'` walks the SAME nearest-holder frontier as `'^name'`, where
  a holder = a dep declaring ≥1 matching task and receives edges to ALL
  its matches (holder-ness is about declaration, so a holder stops the
  walk even when every match is `--excludeDependencies`'d; the flag
  filters expanded matches by concrete name). `*` is the sole
  metacharacter (regex-escape everything else — pinned by a test where an
  unescaped `.` would widen the match). Bare `'*'`/`'^*'`/negation stay
  filter-only rejections (message now says "bare wildcards");
  `'pkg#pattern'` rejected with a clear error. `defineProject`'s
  compile-time key check admits `*`-containing strings (they expand at
  graph build, so they can't be key-checked; a bare `'*'` thus
  type-checks but fails loud at runtime, accepted). Helpers
  `isTaskPattern`/`compileTaskPattern` live in `graph/dependency-spec.ts`
  (the parser itself unchanged — a pattern parses as a normal self/deps
  spec whose task happens to contain `*`). NO CACHE_VERSION bump (the
  pattern string rides resolved-config hashing; expansion changes the
  upstream fold only for new-by-definition configs). Tests: 8 graph units
  (expansion, self-exclusion, zero-match, holder-stop + multi-edge,
  sparse bridge, exclude-filter, pkg#pattern reject, dot-escape pin) + 3
  real-CLI e2e (`tests/wildcard-depends.test.ts`). Docs: schema.md
  dependsOn forms + semantics, comparison.md matrix + gap #3 closed. Core
  1235 pass (+11), lint clean. Deliberately NOT dogfooded in the repo's
  own `lint` group — `lint.*` would also match `lint.oxfmt.fix` (the
  rewriting task); the convention needs a non-matching name or an
  exclusion story first.

- **2026-07-10**: **Road-to-best-CI #2 COMPLETED — a real GitHub check run
  on the commit (`2ecfce4`) + the live-refresh wave hardened against failed
  polls (`37bdfbb`)**. **(1) PR checks:** when a `vx run` inside GitHub
  Actions is handed `GITHUB_TOKEN` (the hand-off IS the opt-in — Actions
  never exposes the token to a step by itself; `checks: write` required),
  `CloudIngestSink.flush` now also creates ONE completed check run on the
  commit via the Checks API: conclusion from `exitOk`, the failures-first
  job-summary markdown as the check output (`packages/cloud/src/
github-check.ts`, pure glue over `formatGithubSummary`). For
  `pull_request` events it attaches to the PR's HEAD sha read from
  `GITHUB_EVENT_PATH` — GITHUB_SHA is the synthetic merge commit there and
  a check on it never surfaces on the PR (the dorny/test-reporter
  convention). Knobs: `VX_GITHUB_CHECK=0` disables, `VX_GITHUB_CHECK_NAME`
  names (default: the run's command). Never-fail; a 403 names the missing
  permission. No serve needed — works standalone like the job summary.
  Docs: guides/ci.md "PR checks" section. 11 unit tests + 2 plugin
  activation pins (the decline test now also deletes GITHUB_TOKEN so the
  suite is hermetic inside Actions itself). **(2) Adversarial review of the
  live-refresh/CI-health wave (`a4b3f08`/`dae2f98`)** — the one shipped
  wave that had no hostile pass; three CONFIRMED defects fixed, all hot
  since the 5s tick landed: **(a) CRITICAL wedge** — the Runs `invocations`
  resource was the only UNCAUGHT fetch in the view; one failed poll (serve
  restart, laptop wake) threw an uncaught rejection out of the downstream
  memos and PERMANENTLY froze the history table + CI-health ticks while
  caught siblings kept animating (a frozen view masquerading as live;
  executed repro against solid-js). Fix: catch to null + hold last-good
  rows outside the resource — an outage neither wedges nor blanks.
  **(b)** jsonPage dropped a populated section's data for a tick on a
  transient refetch error (`res.latest` is UNREADABLE while errored — Solid
  re-throws); a per-source last-good map keeps data, only a first-load
  failure shows 'error'. **(c)** the project facet filtered with a stale or
  absent runId set while its resource resolved (unfiltered rows under an
  active chip on deep-link; project A's set applied while switching to B —
  Solid serves the previous value during a source-change refetch); the
  resource value now carries WHICH project it belongs to and the table
  reads as loading until it matches. Plus: a failed `/v1/flakiness` probe
  renders '—', never a confident green "0 flaky". **Verified through a real
  outage/recovery cycle** (Playwright: serve killed mid-poll, restarted on
  the same port): rows kept during the outage, count updates after
  recovery, zero uncaught errors — pre-fix the view froze forever.
  **Refuted by the review (sound):** live.ts timer lifecycle (no leak/
  double-arm/burst; refcounted visibilitychange), Shell LiveIndicator, the
  2s queue poll teardown, runTicks newest-LAST ordering, every tone
  threshold, invocationPassed consistency (core maps exitOk via Boolean).
  **Accepted residuals:** pass-rate "24h" computes over the most recent 200
  invocations (truncated on >200-run days); post-dispose setQueueJobs is a
  harmless signal write. Cloud 330 pass (+12), UI 40 pass, core 1224, lint
  clean.

- **2026-07-10**: **Adversarial review of the analytics wave — two
  repro-confirmed defects fixed, the rest verified sound** (two parallel
  hostile reviewers, repro-mandated, over the day's `getRegressions`/
  `getPeriodComparison` + serve routes + UI derivations; the 2026-07-07/09
  pattern). Both findings CONFIRMED by an executed reproduction. **(1)
  `periodStats` empty-window `null` (`3cbc2e5`):** the aggregate bare-`SUM()`d
  `failures`/`cacheHits`/`executed` but only `COALESCE`d `totalDurationMs` —
  SQLite `SUM()` over ZERO rows returns NULL, and the PREVIOUS window is empty
  for any workspace younger than the window (fresh serve, quiet prior week),
  so `/v1/analysis` shipped `previous.stats.failures = null` where
  `PeriodStats` declares `number` (contract break + a client `.toFixed()`
  throw). Fix: COALESCE all four; pinned by a current-only-window metrics
  test. **(2) Dead regression status dot (`3cbc2e5`):** the "Started failing
  across branches" card's `dots` column bound `_dirReg`, a field
  `regressionRows()` never produced (I described the derivation in-plan but
  omitted it from the Edit), so the dot was permanently faint grey — the
  red-regressed / amber-always-broken urgency cue was lost while the row's
  TEXT still read fine (why the first render-check missed it: it asserted text
  - zero errors, not the dot's COLOR). Fix: emit `_dirReg` (`'slower'`→red /
    `'gone'`→amber via the delta DotMap); browser-verified the two dot colors
    card-scoped. **Bundled:** the regressions latest-per-branch CTE gained a
    `run_id DESC` tiebreaker (a time-ordered UUIDv7) so equal-`started_at` ties
    are deterministic. **Refuted by repro (NOT actioned):** period-window
    overlap/gap/off-by-one (half-open `[from,to)` is clean), the ROW_NUMBER
    latest-per-branch dedup + since-recovered-branch + cache-hit-as-pass, every
    NULL-vs-non-null claim in `getRegressions` (`win.runs` is COUNT, the rest
    `?? 0`-guarded), mover `<minRuns` leakage + `deltaPct` div-by-zero +
    percentile index, and every UI tone/sign/pp derivation (failure-up→bad,
    hit-drop→warn, avg-slower→warn all correct) + `$state` binding + the commit
    facet's prefix match. **Accepted residual:** malformed numeric query params
    (`Number('abc')`→NaN) degrade to an empty response — a codebase-wide
    convention across every metrics route, harmless, unreachable from the
    dashboard. Core 1224 pass (+1), cloud 318 pass, UI 40 pass, lint clean.

- **2026-07-10**: **vx-cloud analytics wave — live dashboard, run filters +
  CI-health, cross-branch regression detection, and period-over-period
  analysis** (owner, four requests across the day: "Improve ui. More
  features" → "detect tasks that started failing across branches … see runs
  per commit branch or all" → "We need advanced analysis and over time
  comparisons"). A coherent analytics thread, all in `@vzn/vx-cloud`; core
  gained only two read-side metrics queries (no schema/CACHE/TELEMETRY bump —
  pure SQL over the existing `runs`/`invocations` tables). **(1) Live +
  filters + CI-health** (UI-only, `a4b3f08`/`dae2f98`/`0f76e18`): every view
  opts into a visibility-aware auto-refresh tick (`ui/src/live.ts`
  `useVisibilityRefresh`, paused while the tab is hidden — re-fetches sources
  on the SAME machinery as a connection switch, `res.latest` kept so a
  refetch never flashes the loading skeleton); the Runs view gained
  URL-persisted result/branch/project facets (`#/runs?result=failed&…`,
  shareable + restore-on-load, clearable chips) and a CI-health strip (last
  ~24 runs as status ticks + pass-rate/flaky/hit-rate/non-hermetic tiles).
  **(2) Cross-branch regressions** (`1329b63` core + this wave's UI):
  `getRegressions` (a task now failing on ≥ `minBranches` distinct branches
  that has a prior success — the "what just broke everywhere?" signal,
  distinct from flaky/nondeterministic; a `ROW_NUMBER() OVER (PARTITION BY
project,task,branch ORDER BY started_at DESC)` CTE takes the latest run per
  branch, so a since-recovered branch is not counted failing; a cache-hit
  counts as a current pass). `GET /v1/regressions?sinceDays=&minBranches=&limit=`;
  an Insights "Started failing across branches" card (red/amber
  regressed-vs-always-broken dot). **(3) Period-over-period analysis**
  (`42c5d8b` core + `94895bc` UI): `getPeriodComparison` splits runs into two
  adjacent equal-length windows (default 7d: this week vs last), aggregates
  each into `PeriodStats` (runs/failures/hits, avg/p50/p95 exec duration,
  failure + hit rates), and ranks `movers` — tasks whose avg executed
  duration shifted most, requiring ≥ `minRuns` (default 3) executions in BOTH
  windows so a mover is a trend not noise. `GET /v1/analysis?window=&minRuns=&limit=`;
  an Insights tile row ("this 7d vs prior 7d" with signed deltas tinted by
  direction) + a "Biggest movers" table (red/green delta dots). **(4) Runs
  per commit** (`95bd5f3`): a commit facet joins the Runs URL-persisted set
  (`#/runs?commit=…`, prefix match so a short SHA selects) — with the branch
  facet + "all", this covers "runs per commit/branch/all". **Derivation
  pattern:** the analytics data sources (`ui/jr/data.ts` `analysisData`/
  `regressionRows`) compute all display fields (signed deltas, per-tile
  tones, mover direction, branch lists) so the pure-JSON views bind plain
  state paths — conditions/formatters can't compute a signed tone. Every new
  metrics query is pinned by a `tests/metrics.test.ts` block AND the
  drift-guard `calls` map + the façade boundary snapshot; the UI filter/
  regression/period derivations are unit-pinned in `functions.test.ts`; the
  serve routes have standalone endpoint tests (`{analysis,regressions}-serve.test.ts`).
  **Browser-verified** (Playwright/chromium against a seeded serve): the
  Insights trending tiles + movers + "Started failing" cards render with
  correct deltas/regressions and ZERO real console errors; the Runs commit
  facet narrows the count and restores from the URL. Core 1223 pass (+9),
  cloud 316 pass (+2), UI 40 pass (+3), lint clean. Dist is a build artifact
  (gitignored, not committed — the 2026-07-05 decision). **UI gotcha logged:**
  `document.body.innerText` reflects CSS `text-transform: uppercase`, so a
  card-title assertion must be case-insensitive (the metric/card labels are
  uppercased in CSS).

- **2026-07-09**: **vx-cloud made ACTIONABLE — every surfaced problem now
  carries its concrete fix** (owner: "Work on better vx cloud"; the
  clearest expression of the standing "one-stop CI shop, butter, compete
  with GHA/Jenkins/Nx Cloud" vision — a CI PRODUCT tells you how to fix a
  problem, not just that it exists). Extends the pattern the hermeticity
  card already established (a rendered remediation hint) to flaky tasks +
  a per-task Recommendations card. **PURE UI** (`packages/cloud/ui`) — ZERO
  core (`src/`) and ZERO serve (`packages/cloud/src/`) change; every
  suggestion derives from data the dashboard already fetches
  (`/v1/flakiness`, `/v1/hermeticity`, the workspace catalog). **(A)
  Insights flaky card** gains a "Suggested fix" column: a CONFIRMED-flaky
  row shows `exec.retries: N` (`N = max(maxAttempts ?? 2, 2)`), inferred-
  only rows blank. **(B) Task-detail Recommendations card** aggregates
  every applicable fix for that task, each a rationale + copy-able snippet:
  flaky→`exec: { retries: N }` (catalog-aware REFINEMENT: if the resolved
  config already declares `retries >= N`, flip to "still flaky — the
  failure is nondeterministic, not transient; investigate / `vx run
--verify`", no snippet); non-hermetic (task in the divergent list)→names
  the platforms + rels and offers `cache.inputs.runtime: ['uname -sm']` or
  fix-the-bug; slow+uncached (catalog-gated: no `cache` block declared +
  p50 > ~1s)→"add a `cache` block so re-runs restore"; a positive "Looks
  healthy ✓" zero-state when none apply. A small declarative `RecList`
  catalog component renders each (icon + title + rationale + snippet).
  Snippets are schema-accurate. Derivations (`suggestedRetriesFor`,
  `withFlakyFix`, `computeRecommendations`) live in `jr/functions.ts`,
  pinned by 16 new unit assertions (retries math, already-declares
  refinement, per-signal + stacked + healthy). Browser-verified 6/6
  against a seeded fixture (flaky→retries snippet, already-retries
  refinement, non-hermetic split-key, slow-uncached add-caching, healthy
  zero-state, Insights column) with ZERO console errors. UI 25 pass, cloud
  299, core 1214, lint clean; dist rebuilt (not committed). Docs: dashboard
  guide synced. Commits `f903f8f`..`de04d1c`. **Not built (owner decision,
  unchanged):** run TRIGGERS (scheduled / on-push / webhook) — the
  cloud-data-model Phase 4, which reverses a standing non-goal; do not
  build unprompted.

- **2026-07-09**: **npm release pipeline hardened — the `sigstore`
  publish crash fixed + the 10-package publish made idempotent** (owner
  pasted a live release failure: `Cannot find module 'sigstore'` from
  `libnpmpublish/lib/provenance.js`). **Root cause (non-obvious):** the
  publish logic was fine — `npm install -g npm@latest` self-upgrading IN
  PLACE from node 22's OLD bundled npm 10.x leaves npm's own dependency
  tree incomplete, so when `libnpmpublish` auto-generates provenance
  (npm does this automatically in an OIDC trusted-publishing CI context,
  token OR OIDC), it can't `require('sigstore')` and dies on the first
  package. **Fix:** `node-version: 22 → 24` — Node 24's BUNDLED npm is
  already ≥ 11.5.1 (trusted-publishing capable), so no fragile in-place
  self-upgrade is needed; the upgrade step is now GUARDED (a `node -e`
  semver check) and self-upgrades ONLY on the unexpected chance the
  bundled npm is < 11.5.1 — avoiding the exact in-place upgrade that
  corrupted sigstore. **Made bulletproof (not just "should work"):** a HARD
  `require.resolve('sigstore', { paths: [<npm root>/npm] })` verify runs
  BEFORE the publish loop — if it can't load, a forced clean reinstall
  repairs it, and if it STILL can't, the job fails fast with a clear
  `::error::` instead of the cryptic mid-publish MODULE_NOT_FOUND. So the
  release either has a working provenance chain or stops loud + early,
  never crashes on package 1. **Bundled hardening:** the publish loop is now
  IDEMPOTENT — a 10-package sequential publish can fail partway (transient
  registry error, or the sigstore abort), and npm 403s on republishing an
  existing version, so a re-run used to abort on the first already-
  published package; each package is now skipped when `npm view
<name>@<version>` shows it already on the registry (name read from each
  dir's package.json — `dirFor` maps `@vzn/vx`→`vx`, `@vzn/vx-cloud`→
  `vx-cloud`, platform pkgs keep their full name), so a re-run COMPLETES
  the set. The platform-first ordering + idempotency compose (a skipped
  `@vzn/vx` still satisfies `@vzn/vx-cloud`'s same-version dep). release.yml
  was already sound (version stamp present, `dist/vx-*` catches both binary
  families). Verified: YAML valid across all four workflows, the semver
  guard correct at every boundary (11.5.0 upgrades, 11.5.1 uses-as-is,
  pre-release suffix handled), the idempotent loop simulated against a fake
  dist tree (already-published skipped, rest publish). **Needs a real CI
  re-run to confirm end-to-end** (the Actions runner env isn't reproducible
  locally); fallback if sigstore somehow persists on Node 24 is
  `--provenance=false` with the NPM_TOKEN path (loses the attestation).
  **Standing owner TODO unchanged:** a Trusted Publisher must be configured
  on npmjs.com for each of the TEN names, OR an `NPM_TOKEN` scope secret set
  (either auth path now works past the sigstore crash).

- **2026-07-09**: **Adversarial review of the day's three shipped features —
  two shipping-blocker bugs + a detection gap fixed, the rest verified sound**
  (three parallel repro-mandated hostile reviewers over the scheduler
  admission `aabb0f3`, the serve surfaces `7d23eca`+`e224ccb`, and the
  fingerprint core `fedfef0`; the 2026-07-07 pattern). Every finding
  CONFIRMED by an executed reproduction or downgraded. **Fixed (one commit):**
  (1) **CRITICAL — scheduler float-residue hang.** Reservation counters are
  FLOAT sums (fractional `cpus`, and percent-of-budget resolves to
  non-representable values — `resolveCpu('10%',3)===0.30000000000000004`), so
  add/release cycles leave ~2.8e-17 residue instead of exact 0. The
  solo-clamp gate was the knife-edge `reserved === 0`, so an over-budget task
  parked FOREVER (active→0, no future tick) — the run HANGS, or worse, exits 0
  silently WITHOUT running a requested task and prints no summary (CI reads
  green). A legal config triggers it; reproduced 3/3. Fix: integer HOLDER
  COUNTS per axis drive the solo-clamp ("axis idle" = `holders === 0`, exact),
  `reserved` SNAPS to exact 0 when an axis's holders hit 0 (kills cross-busy-
  period accumulation), and the within-budget compare gained a relative
  epsilon against exact-fill mis-rounding. (2) **CRITICAL — serve O(N²) DoS
  via `/v1/hermeticity`.** `FpStore.divergence()` nested a row-pair loop over
  ALL reports for a divergent hash (no early exit, no per-hash cap),
  synchronously — freezing the single-threaded serve (32.9s at 40k rows,
  clean quadratic), weaponizable from the LOWEST-privilege principal (an
  untrusted PR token POSTing attacker-chosen hash+trees; the Insights card
  auto-loads the route so other users trip it). Fix: bound the per-hash load
  (`FP_MAX_ROWS_PER_HASH = 64`, most-recent-first — totals stay exact via a
  separate COUNT) + `crossPlatform` early-exit. (3) **Serve ingest body-cap
  spoof.** `/v1/ingest`+`/v1/ingest/logs` capped on `content-length` ONLY, so
  a chunked body (no length) read 0 and bypassed the 32/16 MiB cap into a
  ~513 MiB buffer. Fix: re-check ACTUAL `Buffer.byteLength` after reading
  (mirrors the artifact PUT). (4) **MEDIUM — fingerprint zero-output blind
  spot.** A task that DECLARES outputs but produces zero files shipped NO
  fingerprint (gate keyed on resolved count) — exactly the platform-
  conditional-glob divergence Phase 4 exists to catch (platform A emits N,
  platform B's glob matches nothing → one report, no divergence row). Fix:
  gate the fp on the DECLARATION and ship the empty-tree sentinel; the
  determinism `no-outputs` verdict stays keyed on the resolved count
  (`verifyFp1.size === 0`) so `--verify` behavior is byte-identical. Bundled:
  crash-isolate the scheduler's `onStart`/`onFinish` observer hooks (a
  throwing logger must not wedge scheduling — the double-release path A#3 +
  the "observability never breaks a run" rule), the `--verify=fingerprint`
  status line names the cause on a 0-count (all-hit) run, artifact
  `subScopeOf` rejects `.`/`..`, and the fp-store prune's per-row byte
  accounting corrected (`+64`→`+256`, was undercounting the string columns
  and widening the ceiling). **Refuted by repro (NOT actioned):** the legacy
  scheduler path is byte-identical (300-trial/4015-assertion randomized
  differential vs `aabb0f3^`), park/repush FIFO + solo-clamp semantics +
  key-strip + frozen-lock validation all hold; the artifact trust-scope
  list⊆GET invariant holds across 29 principal/sub-scope combos incl.
  traversal, the provenance join is doubly-safe (parameterized + HASH_RE),
  no cross-workspace capability, zstd-magic can't be confused, server-side
  re-truncation defeats a hostile 10k-entry array, the sink budget doesn't
  mutate the shared summary; and the fingerprint core is sound on every
  Phase-1/2-class surface (raw-bytes truthfulness incl. the persistent
  cross-run memo trap, dir-order/unicode machine-independence, truncation
  honesty at entry #501, execute-once, attempt-1 attribution, strace-level
  zero-cost). **A#2 doc correction:** the design + this log claimed persistent
  reservations are "held for the task's lifetime" — the code releases them at
  READY (the SAFER behavior; lifetime-holding would deadlock a persistent-
  100% + downstream-100% graph). Corrected below + in the design doc. Tests:
  core 1198→1214 (+16), cloud 285→288 (+3); regressions pin the FP hang, the
  throwing-observer non-wedge, the DoS bound, the chunked-bypass 413, the
  zero-output empty-tree, and the `.`/`..` subscope. No bumps anywhere.

- **2026-07-08**: **Resource-aware scheduling: persistent reservations are
  released at READY, not held for the task's lifetime** (correction to the
  2026-07-08 entry below, surfaced by the 2026-07-09 adversarial review). The
  original entry + `docs/design/resource-scheduling-2026-07.md` claimed
  `persistent` + reservation is "HONORED for the task's whole lifetime." The
  implementation cannot: `executePersistentTask` resolves its outcome at
  READY, and the scheduler releases the reservation when that promise settles.
  This is the SAFER behavior — lifetime-holding would deadlock a persistent
  `cpus:'100%'` + a downstream `cpus:'100%'` forever (a permanently-held axis
  never goes idle for the solo-clamp). So a persistent task's reservation
  coordinates admission only UNTIL it signals ready; after that a heavy
  downstream task can co-schedule with the still-running server (advisory, not
  enforcement — consistent with the whole feature). No code change; the docs
  were wrong.

- **2026-07-09**: **`--verify` Phase 4 SHIPPED — cross-machine output-
  fingerprint diff + the cheap `--verify=fingerprint` mode** (the
  flagship's last open phase; design
  `docs/design/verify-cross-machine-2026-07.md`, architect-reviewed, four
  commits `fedfef0`..`58cc5ca`). Two machines reporting DIFFERENT output
  trees for the SAME cache key = a machine-dependent shared remote cache
  (first-writer-wins poisoning of the other platform) — the one failure
  class a single-machine re-run structurally cannot observe; a connected
  serve now names the exact task, key, platforms, and diverging rels.
  **Core:** `OutputFingerprint { tree, fileCount, files≤500, truncated }`
  declared structurally in `graph/scheduler.ts` (the VerifyVerdict
  pattern) on `TaskOutcome.outputFp` + additive-optional on
  `TaskTelemetry` (schema STAYS 2 — the attempts precedent); pure
  `foldFingerprint` in verify.ts (tree digest folds `key\0hash\n` over
  ALL sorted entries — \0 boundaries, the v18 lesson; per-file map is
  DETERMINISTIC truncation, sorted-first-500, so two machines' truncated
  maps stay comparable and detection NEVER depends on the map — the tree
  digest always ships). NEW `--verify=fingerprint`: fp computed in the
  save block at ~1× exec, NO 2× re-run — the mode that makes a
  per-platform per-merge matrix affordable (the architect's key insight:
  with a shared remote cache the second platform HITS — the poisoning
  scenario itself — so useful pairs require `--force` runs, which 2×
  determinism priced out). `--verify`/`=all` attach fp for FREE (fp1
  already exists there); `=inputs` stays fp-free; fingerprint-only hits
  get NO verdict; the no-write-policy guard + the distribution refusal
  both inherit. Wire: additive `fingerprint` on `RunRequest.verify`, no
  bump. The fp primitive is the BUG-1 raw-bytes xxh3 — which incidentally
  made it machine-independent (the memoized OID path would have been
  memo-poisonable AND platform-dependent). **Serve:** sidecar
  `fingerprints.db` per workspace (`fp-store.ts`, own `FP_SCHEMA_VERSION
1` gate — the LogStore pattern; a core-schema table would wipe every
  user's cache.db for a cloud-only feature). **PK `(hash, os, arch,
tree)`**: INSERT OR IGNORE = idempotent re-delivery, one row/platform
  forever for deterministic tasks, and same-platform two-tree rows
  accumulate — surfacing run-to-run nondeterminism WITHOUT the 2× re-run
  as a bonus signal. Platform identity = os+arch (the axis a shared cache
  spans); host is a debugging column, never identity. Extraction inside
  `IngestStore.ingest` after the idempotency gate; caps at every layer
  (500 files/task core, 4 MiB/run in `CloudIngestSink` — cloud-side so
  core stays stateless, serve re-truncation + 32 MiB ingest 413);
  90d/128 MiB pruning. `GET /v1/hermeticity?ws=` computes divergence at
  READ time (`HAVING COUNT(DISTINCT tree) > 1`), names rels via core's
  `diffOutputTrees` (façade export-only widening), flags `crossPlatform`
  vs same-platform + `changedComplete` honesty. **UI:** Insights
  Hermeticity card (zero-state, platform pair, rels in danger tone, task/
  run drill-downs, remediation hint). **Advisory by design** — the serve
  observes completed runs; no run-failing path, telemetry stays
  observe-only; remediation = fix the hermeticity bug OR legitimately
  split the key per platform via `cache.inputs.runtime: ['uname -sm']`.
  NO bumps anywhere: CACHE_VERSION, core SCHEMA, TELEMETRY_SCHEMA_VERSION
  (2), run wire, DIST_PROTOCOL all unchanged; plain-run byte-identity +
  key-stability pinned by tests. Tests: core 1198→1209, cloud 268→285;
  browser-verified 12/12 (crafted linux-x64 vs darwin-arm64 divergence
  renders `dist/app.js` with links; fp-free serve renders the green
  zero-state); real-CLI verified (`--force --verify=fingerprint` exit 0 +
  the fingerprinted-N-trees status line; plain run unchanged). Docs:
  cli.md flag + section with the CI matrix recipe, guides/ci.md,
  dashboard guide. **Bundled dogfooding fix:** `lint.oxlint`/`lint.oxfmt`
  cache inputs stopped at the project boundary while the commands scan
  the whole tree — a cloud-only change rode a stale lint hit; both tasks
  now declare `workspaceFiles: ['packages/*/src/**', 'packages/*/tests/**',
'scripts/**']` (the documented escape hatch; keys change → fresh gate
  run verified green, lock regenerated). With this, all four phases of
  provable cache correctness are shipped; the verify thread is CLOSED
  (remaining nice-to-haves live in the design docs' open questions:
  per-task `cache.verify` opt-out, an MCP hermeticity tool, retention
  tuning).

- **2026-07-08**: **Cloud data-model Phase 2 SHIPPED — entity-page IA +
  `/v1/artifacts` + Artifacts UI + Insights + `/cache/:hash` + `?task=`
  deep links** (completes `docs/design/cloud-data-model-2026-07.md` §4.2 +
  §8-10; six commits `7d23eca`..`db8ed10`). **Server half:**
  `GET /v1/artifacts?limit=` — the `/v8` store made visible.
  `ArtifactStore.list()` walks EXACTLY `readScopes()` (the same scope set
  `has()`/GET resolve against), so the list can never leak wider than a
  fetch could reach: trusted never lists untrusted, an untrusted principal
  lists its own per-PR sub-scope ∪ trusted, and a hash present in both
  scopes lists ONCE with GET-resolution priority (first-scope-wins dedupe).
  Rows carry size/mtime/tier + the `.duration` sidecar; provenance
  (`task: {project, task, runId}`) is a best-effort batched join
  (900-chunked IN-lists, `ORDER BY started_at DESC` + first-wins = most
  recent producer) against the workspace-resolved ingest db — absent for
  workspaces this serve never ingested. NOT workspace-gated (artifacts
  exist on remote serves; sits above the unknown-`?ws=` guard). **UI half
  (all in `packages/cloud/ui`, zero core change):** nav is the
  entity-ordered seven — **Runs · Workspace · Projects · Tasks · Cache ·
  Artifacts · Insights**; `/trends` + `/bottlenecks` DIE as routes
  (redirect to the NEW `/insights`, their views deleted and absorbed:
  trends charts, heatmap, flaky-with-Retried, hit-split, savings,
  time-burners, recent failures — every row links INTO its entity, failures
  deep-link `/runs/:id?task=…`; the prunable-entries table moved here
  rather than being orphaned); `/overview` became the **Workspace** page
  (catalog summary card with `lock`/`live` source badge + stale count,
  identity; analytics moved to Insights; the agent-pool card deliberately
  SKIPPED — §12 open question, needs a sessions-list registry read);
  Projects/Tasks are **catalog∪rollup joined** (never-run projects/tasks
  navigable; no catalog → rollups pass through by reference — the
  capabilities pattern); project detail gains resolved per-task config
  blocks, task detail gains the Config card (the `vx show` payload), a
  flaky badge ("CONFIRMED by within-run retries"), and `/cache/:hash` +
  run deep links; NEW `/artifacts` (hash/size/age/duration/tier/provenance
  links/download) + `/cache/:hash` entity page (producing/restoring runs +
  artifact download; entry FACTS honestly absent on ingest-only serves —
  the standing never-reads-cache.db decision); run detail gains project
  links, a selected-task artifact download, and `?task=` seeding
  (`jr/page.tsx` exposes decoded query params; the card already binds
  `/selectedTask`). ONE shared bearer-fetched `downloadArtifact()` helper
  serves TaskLogs + both new download sites; `fetchArtifacts()` treats an
  older serve's 404 as `null` → honest empty state. **Bonus fix:**
  `taskDetail.json` had always declared a `cacheKey` source that never
  existed in `SOURCES` (the "Cache key" card could never render) — wired to
  the existing `/v1/explain/:taskId`. Tests: +8 server (trust-scoped list
  matrix, dedupe, provenance join present/absent, bearer gate) + 9 join
  units + serve suites; cloud 268 pass, core 1198 pass, lint clean.
  **Browser-verified 47/47** (Playwright against a real 3-project fixture
  with a retry-confirmed flaky task + a `/v8`-stored artifact): nav, all
  three redirects, never-run catalog entries navigable, the flaky
  drill-down, `?task=` pre-opening with the failed log tail, artifact
  downloads from BOTH sites with bytes asserted, palette "Trends" landing
  on `/insights`, zero real console errors. Known accepted noise: 404
  probes for never-run tasks / silent-task logs (API design; SPA renders
  the empty states). Docs: dashboard guide nav synced; `GET /v1/artifacts`
  added to cli.md (it had shipped undocumented). **Phase 3 (optional,
  unbuilt):** disjoint-node-set concurrent runs; **Phase 4 = OWNER
  DECISION** (triggers/webhooks — reverses a standing non-goal; do not
  build unprompted).

- **2026-07-08**: **Resource-aware scheduling SHIPPED — `exec.resources:
{ cpus, memory }` 2-D admission on the two-tier scheduler** (owner: "tasks
  could reserve how many cpu units… Maybe in exec?" → "CPUs should be number
  or percentage same with memory" → "This should work as reserved. If 0 means
  run. By default" → "Resources object is good"; spec
  `docs/design/resource-scheduling-2026-07.md`, all three phases in one
  commit). A task declares CPU units (fractional, or `"<n>%"` of the CPU
  budget = the run's `concurrency`) and/or memory (bytes, `"512MB"`/`"2GB"`
  size strings, or `"<n>%"` of the memory budget = `os.totalmem()` unless
  `--memory <size>` overrides — the documented container caveat: cgroup
  limits don't show in totalmem()); the scheduler packs ready tasks so
  concurrent reservations never exceed either budget, layered ON the count
  limit. **Admission, not enforcement** — nothing is cgrouped/niced/killed.
  **Encoded rules:** zero-never-blocks (0/omitted = exempt from that axis —
  every current config schedules byte-identically, gated on ONE check: an
  empty cost map omits the scheduler fields entirely); backfill via
  park-within-tick (within one synchronous tick `reserved` only increases, so
  a non-fitting head parks for the tick's remainder and repushes with its
  ORIGINAL heap seq — FIFO-among-equals survives exactly, O(R log R));
  solo-clamp (an over-budget reservation admits alone when its axis is idle —
  no deadlock, an idle pool always admits); skip-safety (ONE shared `willSkip`
  predicate in both the parker and the dispatch loop — a doomed task skips
  free, never parks; the spec's named hang risk); restore-tier tasks cost
  ZERO by construction (a restore is a tar extract, and it must never park —
  no parkedRestore list exists). **Key strip:** the whole `resources` object
  is dropped from `hashTaskConfig` before stringify (`hashableConfig`, the
  grouped object makes it a one-key drop) — tuning a reservation NEVER busts
  a cache; a no-declaration config takes the fast path and stringifies
  byte-identically, so **no CACHE_VERSION bump** (a declaring config is by
  definition new). `timeout`/`retries` stay folded (distinct-by-design;
  retro-stripping = CACHE_VERSION bump, deliberately out of scope).
  **Boundary move:** `parseSize` relocated `cli/cache.ts` → `util/size.ts`
  (orchestrator can't import cli; cache.ts re-exports so callers unchanged).
  `ResourceCost`/`ZERO_COST` declared structurally in `graph/scheduler.ts`
  (graph can't import orchestrator — the VerifyVerdict pattern); the pure
  resolver (`orchestrator/resources.ts`: resolveCpu/resolveMem/
  resolveResourceCosts, empty-map-when-nothing-declares) runs ONCE in run.ts
  so the scheduler's inner loop is a plain Map.get. Loader validates form
  (unknown-key reject like sandbox; `"1.5GB"` rejected — parseSize is
  integer-only; percent regex; `persistent`+reservation allowed and honored
  for the task's lifetime). **Display (Phase 2):** `cpu budget N · mem budget
  X GB` on the footer `info` row, ONLY when a task opted in (RunContext
  gains optional cpuBudget/memBudget; Infinity mem = axis off = not shown).
  **Wire (Phase 3):** `RunRequest.memory` + both mappers — per-task
  reservations need no wire field (a delegated run re-resolves configs
  server-side, on the correct machine's RAM; explicit `--memory` wins
  end-to-end). ReadyHeap gained `push(id, seq?)` + `peekSeq()` (repush keeps
  the original seq). Tests +41 (core 1162→1198 + 5 in-suite): scheduler
  admission suite (concurrent-within-budget, serialize-over-budget, memory
  axis, combined-axes, backfill-around-parked-head, solo-clamp,
  zero-runs-beside-clamped-giant, skip-safety-while-budget-held,
  restore-reserves-0, FIFO-after-repush, empty-map-legacy-pin), resolver
  units, loader accept/reject matrix, --memory parse + wire round-trip,
  footer budget-line pins, e2e key-stability (add→tune→still cache-hit) +
  e2e serialization through a real run. Verified with the real CLI: two
  `cpus:'100%'` 300ms tasks ran serialized (617ms total) with the budget
  line rendered; the repo's own runs (nothing declared) show no budget text.
  Turbo/Nx have nothing comparable (flat count concurrency); Bazel local
  resources is the precedent. Docs: schema.md `resources` section, cli.md
  `--memory` row, help text. Core 1198 pass, cloud 250 pass, lint clean.

- **2026-07-08**: **`vx-cloud connect` is the ONLY client↔serve wiring — the
  local-serve auto-detect machinery DELETED** (owner-approved). REVERSES two
  2026-06-28 decisions: "cloud() auto-detects a local vx-cloud serve" and
  "per-user serve advertisement at `$XDG_RUNTIME_DIR/vx-cloud/serve.json`".
  `packages/cloud/src/serve-info.ts` (write/read + `pidAlive`) is GONE and so
  is every consumer path: serve.ts no longer writes/cleans serve.json; the
  `cloud()` connection ladder is now exactly **explicit URL/token (opts + env
  aliases) → active `vx-cloud connect` environment → decline** (the local
  rung, its self-pid guard, and the sink's advertised-socket dial all deleted
  — environments carry no socket, so the ingest POST is TCP-only; the `serve
--socket` LISTENER itself stays, `defaultServeSocketPath` moved into
  cli/serve.ts); `resolveBackend` dropped serve.json delegation discovery
  (and its now-unused `cwd` param — delegation = `connect --delegate` env or
  `VX_SERVICE_URL`); `env ls` lost the synthetic `(local)` row; `vx-cloud
agent`'s URL fallback swapped the advertisement for the connected
  environment (whose token rides only when the environment supplied the
  URL). WHY: one wiring story (local = `vx-cloud serve --ui` then ONE-TIME
  `vx-cloud connect http://localhost:4321` — the deterministic port is what
  makes that stable), and it kills three whole complexity classes:
  advertisement staleness (pid-guard/`pidAlive`/logout-cleared runtime dirs),
  the POST-to-self deadlock guard, and the `VX_CLOUD_SERVE_INFO` pinning
  ceremony EVERY serve-spawning test suite carried (13 files) so test serves
  wouldn't clobber the real per-user file. A serve merely RUNNING can no
  longer capture runs by existence — connecting is consent. Tests: −4
  advertisement pins (plugin auto-detect/stale, socket-dial push, dist
  stale-ad), +1 negative pin (a RUNNING unconnected local serve → telemetry
  AND backend decline); resolveBackend suite rewritten to explicit-URL
  delegation + fail-safe unreachable→local. `vx dev` untouched (its
  per-workspace hub socket is not the serve advertisement). Docs: dashboard
  guide quick start is the two-liner + connect; cli.md serve section swaps
  "Advertisement" for "Connecting" + the 3-rung ladder; distributed-ci drops
  the advertised-serve fallbacks. Design docs stay frozen historical records.
  Cloud 250 pass, core suite + lint green. No CACHE_VERSION/SCHEMA/wire bump
  — client-side wiring only.

- **2026-07-08**: **Cloud data-model Phase 1 — workspace catalog + serve-side
  run queue + ONE unified Runs view** (owner: "Redesign vx cloud around
  workspaces, projects, tasks, runs, cache but from DATA perspective… In runs
  I can navigate dig connect, even when I schedule from UI. And I want to
  trigger MULTIPLE. We should have ONE view for runs. Where I can spawn
  more."; design `docs/design/cloud-data-model-2026-07.md` §6-7, §11).
  **Server half:** core façade widened EXPORT-ONLY (`readLockfile` /
  `LOCKFILE_NAME` / `loadWorkspace` / `loadProjectConfig` /
  `listProjectMetas` — metrics' `listProjects` keeps the bare name — +
  types; boundary snapshot updated; zero behavior, zero hot-path cost).
  `packages/cloud/src/workspace-catalog.ts`: the "access the LOCK" ladder —
  lock-first (zero eval, the frozen configs a `--frozen` run sees) → live
  loader-chain fallback → 404; per-(mtime,size) memo so warm requests are
  stat-only; lock-staleness via the same xxh3 configHash `vx lock` wrote
  (`staleProjects`, never a silent lock/live mix). Three
  `GET /v1/workspace/{projects,projects/:name,tasks}` routes (bearer-gated,
  single-workspace by nature — `?ws=` ignored; derived `group`/`cacheable`/
  `persistent` computed serve-side) + `catalog: true` advertised on
  `/v1/meta`. `run-queue.ts` `RunQueue`: in-memory FIFO, ONE run executing
  at a time — "trigger MULTIPLE" = queue multiple; the solo submit starts
  synchronously (byte-equivalent to the old immediate path). Cloud-owned
  `queue:*` wire (`protocol-queue.ts`, `QUEUE_PROTOCOL_VERSION 1`, the
  `dist:*` precedent — core `protocol.ts` untouched) on the existing run WS:
  submit/cancel in, accepted/update/start/done/refused out; the submitting
  socket IS the stream, so the standard event/result wire follows per
  socket. `GET /v1/runs/queue` for the live section. **BEHAVIOR CHANGE,
  named:** plain `{t:'run'}` CLI delegation rides the SAME queue — two
  concurrent delegations used to execute CONCURRENTLY (racing on output
  cleaning, the pre-existing exposure the 2026-06-27 cockpit forbid never
  closed); they now serialize, and a non-immediate start streams one
  `run:status` "queued behind N run(s)" line the wire renderer already
  prints. Closing a QUEUED job's socket cancels it; a RUNNING job completes
  server-side (stop-watching semantics). `dist:submit` does NOT ride the
  queue (agents execute in their own checkouts — no serve-local output tree
  to race on). Killing a RUNNING run from the UI stays out (core has no
  abort handle). **UI half:** the `/run` cockpit DIES as a route (redirects
  to `/runs`; Home lands on `/runs` unconditionally; old bookmarks keep
  working). `RunConsole.tsx` deleted — its machinery extracted into
  `RunSession.tsx`: `createRunSession(tasks)` is the per-run state factory
  (statuses/timing/logs stores + the WireEvent reducer + the 250ms ticker)
  living OUTSIDE the component tree so events keep landing while a row is
  collapsed, and the `RunSession` component is the live layout (progress,
  graph/flame toggle, critical path + parallelism, per-task facts + logs)
  consuming RunGraph/Flamegraph strictly via existing props (both files
  untouched — they were being modified in parallel). `RunsView.tsx` is THE
  one Runs surface: spawn bar (datalist from `/v1/workspace/tasks` via the
  new `Capabilities.catalog` probe, history-derived fallback; disabled with
  an honest hint when the serve has no colocated workspace — history still
  renders), queued/live section (one WS per submitted job via api.ts
  `queueRun`; live positions, cancel-queued, the running job auto-expands
  inline into its RunSession; FOREIGN jobs — CLI delegations — polled from
  `/v1/runs/queue` at 2s as state-only `cli` rows), history table below
  (the jr `DataTable` consumed DIRECTLY in JSX through a tiny `jrCtx` props
  wrapper — the two-way-catalog path working as designed; the old separate
  "Compare to previous" table merged into a per-row `⇄ compare` link).
  Active jobs + sessions live at MODULE scope so route changes don't drop
  sockets (closing a queued job's socket cancels it server-side).
  `views/runs.json` deleted (+ its now-dead `invocationRows` helper and
  `invocationsAll` source); nav is Runs-first with the Run entry gone.
  api.ts: `fetchCatalogProjects`/`fetchCatalogProject`/`fetchCatalogTasks`,
  `Capabilities.catalog` (probed from `/v1/meta`), `fetchQueue` + `queueRun`.
  **Verified in a real browser** (Playwright/chromium against
  `vx-cloud serve --ui` on a temp fixture): spawn from the UI, a second
  submit holds at `queued · position 1` behind the running job, the running
  job expands inline (DAG + critical path), both complete and flow into the
  refetched history with compare links, `/` + `/run` redirect, a raw
  CLI-delegated WS run renders as a state-only `cli` row, the queue drains,
  ZERO console errors. Cloud 253 pass (queue unit + serve e2e + catalog
  suites landed with the server half), core 1162 pass, lint clean; dist
  rebuilt (build artifact, not committed). **Phase 2 SHIPPED same day** —
  see the entity-model entry above.

- **2026-07-07**: **Adversarial review of the session's nine commits — three
  `--verify` soundness holes fixed, Phase-2→Phase-3 consumer gap closed, debt
  swept** (owner: "review last opus commits make sure we are on track no tech
  debt"). A hostile-review agent verified every finding by repro; the perf work
  was CONFIRMED SOUND (ReadyHeap pinned byte-identical to the old sorted array
  by a 2000-trial randomized differential; topoOrder/affected/db.query
  equivalences checked). **The bugs (all verify-family edges, `a51a3c5`):**
  (1) FALSE `proven-deterministic` at equal size+mtime — `hashOutputTree` used
  `Cache.hashFile`, whose mtime+size memo returned attempt 1's digest for a
  re-run output with equal size/mtime (exactly what mtime-normalizing
  reproducible builds produce); fp1 primed the memo, fp2 read it back. Fix:
  fingerprint raw BYTES via plain xxh3 (fp1/fp2 only compare to each other —
  a proof must not trust a cache). (2) Verify re-run STRAYS survived — the
  post-verify restore never cleaned the declared globs, so a diverging output
  FILENAME left both attempts' files on disk (breaking "disk == cached artifact
  regardless of verdict") and unmarked in the gitFilesCache; now mirrors the
  restoreHit clean→restore→mark sequence exactly. (3) `--verify` + a no-write
  policy (`--no-cache`) silently verified NOTHING and exited green; run() now
  rejects the combination loudly (platform-honesty rule; `--force --verify`
  stays the re-verify-warm recipe). **Consumer gap (`6a942a6`):** Phase 3
  shipped before Phase 2, so `undeclared-inputs`/`proven-complete` never
  reached the consumers — an undeclared-inputs task that REDS the run exported
  an UNSET OTel span and a "✅ success" GHA row with NO Hermeticity line. Both
  consumers now handle them (span ERROR + `vx.task.verify.undeclared` paths
  attr; GHA inline flag + counted "unsafe"). Also: `--verify` now REFUSES
  distribution (falls back local — agents don't run the verify machinery),
  npm.yml header corrected (TEN trusted publishers, vx-cloud no longer
  described as Bun-source), both release workflows get `--concurrency 2` (8
  compiles OOM a 7 GB runner) + release timeout 25 min, the dead gitignored
  `ui/dist` input glob dropped from `build.cloud.*` (the UI cascade rides the
  `build.ui` dependsOn fold — input globs resolve against the GIT file set, so
  a gitignored path is always a dead glob), and the npm launcher's signal exit
  actually implements the 128+signo its comment promised. **NIT accepted, not
  actioned:** `.bun-build` in ALWAYS_IGNORE (04f9abc) took no CACHE_VERSION
  bump despite the v24 precedent — deliberate: the temp files are transient
  (never rest on disk), so no real key changes; worst case is an orphaned
  entry, not a wrong hit. Core 1162 pass, cloud 237 pass, otel 25 pass, lint
  clean.

- **2026-07-07**: **`@vzn/vx-cloud` publishes as a no-Bun standalone binary,
  like `@vzn/vx`** (owner: "Cloud should be published compiled like vx"). REVERSES
  the 2026-07-04 "vx-cloud is a Bun-source package requiring Bun" decision — the
  documented "NEXT high-value" item. The `vx-cloud` CLI now cross-compiles to one
  standalone binary per target (`bun build --compile packages/cloud/src/cli/bin.ts`)
  with **core (`@vzn/vx`) AND the dashboard embedded** (`with { type: 'file' }` +
  the bare `@vzn/vx` import bundles core via the link-self symlink) — verified: the
  compiled binary boots `serve --ui` and serves the SPA (`GET / → 200`) with no Bun.
  Same dual-purpose model as vx: the CLI is a Node **launcher** execing the
  matching `@vzn/vx-cloud-<target>` platform binary (optionalDeps, os/cpu-gated),
  while the **`cloud()` plugin stays importable source** (`@vzn/vx-cloud/plugin`,
  evaluated inside the vx runtime — the package still ships `src` + `ui/dist` +
  keeps `@vzn/vx` as a dep for the plugin path + the Bun source fallback). **ONE
  generalized launcher** (`scripts/npm-launcher.mjs`) now serves BOTH packages —
  it derives the platform-package prefix + binary name from its own `pkg.name`
  (`@vzn/vx` → `vx`, `@vzn/vx-cloud` → `vx-cloud`) and the source-fallback entry
  from a `vxSourceEntry` package.json field (`src/bin.ts` vs `src/cli/bin.ts`).
  `build-npm.ts`: extracted `emitPlatformPackages()` shared by both families;
  `buildCloudPackage` now emits the 4 `@vzn/vx-cloud-<target>` binary packages +
  the launcher-based main package (dropped `engines.bun`, added the launcher +
  optionalDeps + vxSourceEntry). `vx.config.ts`: added a `build.cloud` group + 4
  `build.cloud.<target>` cross-compiles (inputs = root `**/*` for core src PLUS
  `workspaceFiles: [packages/cloud/src/**, packages/cloud/ui/dist/index.html]`
  since the cloud package is a separate project outside the root boundary); `build`
  now fans out to BOTH `build.bun` + `build.cloud` (8 binaries/release). `npm.yml`:
  publishes the 4 new cloud platform packages before `@vzn/vx-cloud` (10 packages
  total). **Verified end-to-end** (linux-x64): built both binaries via the new
  config, assembled the tree, simulated the installed node_modules, ran
  `node launcher.mjs serve --ui` → execs the binary → serves the dashboard, no
  Bun. Docs: self-hosting.md + distributed-ci.md drop the "requires Bun" caveat
  (both CLIs are no-Bun binaries now). **Owner TODO:** trusted publishing now
  covers TEN names (was six) — the 4 `@vzn/vx-cloud-<target>` platform packages
  need seeding + trusted-publisher config too. **CI note:** 8 concurrent
  `--compile --minify --bytecode` may pressure a 7 GB runner; drop to
  `vx run build --concurrency 2` if it OOMs. No core/cloud src change — packaging
  - build config only.

- **2026-07-05**: **Quality sweep — perf O(n)→O(log n), +45 tests, doc-accuracy
  fixes** (owner: "identify places where we miss tests… ensure all cases 100%.
  Identify performance improvements, all O(n)… see if we can do O(1). Review
  docs… no limitations, no todo, all done"). Drove three parallel read-only
  audit agents (perf hot-paths, test-coverage gaps, doc staleness), then acted
  on the ranked findings in three focused commits. **(1) Perf** (`68f9bc6`, no
  behavior change, pinned by existing tests): scheduler ready-queue was two
  sorted arrays (binary-search `splice` insert + `shift` take, both O(R)) →
  O(R²) on a wide ready frontier (the 1000-pkg startup enqueue / a fan-out
  completion); replaced with a **binary max-heap** keyed by (priority DESC,
  enqueue-seq ASC) preserving the EXACT highest-first + FIFO-among-equals
  contract, O(log R) push/pop. `stable-keys.ts topoOrder` used `queue.shift()`
  (O(N²)) → head-pointer walk (O(N+E)), the last shift-based topo in core.
  `cache.ts loadOutputFilesBatch` (≤3×/warm-hit) re-compiled its SQL each call
  via `db.prepare` → `db.query` (caches by SQL text). `affected.ts
projectsContaining` scanned all projects per changed file (O(F·P)) → dir→name
  Map + bottom-up ancestor walk (deepest wins, same semantics, O(F·depth),
  independent of project count). Deliberately SKIPPED the task-hash
  workspaceFiles map-merge (#3) — cache-key-adjacent, memo staleness risk not
  worth a conditional path — and the cold cloud-dist/metrics/predict/filter
  items. **(2) Tests** (`7163db3`, +45, 1113→1158; tests-only + 2 pure helpers
  exported): closed 16 audited gaps in correctness/security-critical code that
  had NO direct test — `filterUpstreamHashes` (new upstream.test.ts: negation/
  ordering/dedup), `parseDependencySpec` throw branches, `computeGroupHash`,
  scheduler `priorities` override, `formatVerifySection` + the `rerun-failed`
  verdict, the remote-cache download-cap defenses (content-length + mid-stream
  `readBodyBounded` abort), `RemoteCache.has()` 503, `zstdContentSize` every
  FCS layout (the bomb oracle), `parseCachePolicy` empty-seg, `isOutputsCurrent`
  mode-mismatch, `parseRunArgs --retry/--timeout` errors + planning mutual-
  exclusion, `defaultAffectedBase` success branch, `transitiveDependents`
  cycle, persistent `forwardArgs`. Exported `readBodyBounded` + `zstdContentSize`
  (pure, security-critical parsers) so a unit test pins them with a tiny cap /
  crafted frames instead of a 512 MiB body — the only src change. **(3) Docs**
  (`ea7619f`): 7 stale "unimplemented/deferred" claims corrected to match
  shipped code — `vx stats` (ships as `vx info` alias), MCP-on-serve (`POST
/mcp` ships), watch config-reload ("(Future)" → shipped), HMAC signing (was
  listed open — shipped), and `globalInputs` reframed in 4 places from
  "deferred/stub" to the owner-REJECTED non-goal it is (TS presets +
  `cache.inputs.workspaceFiles` are the mechanism). The doc audit CONFIRMED the
  CAS-not-rewired + predictive-experimental + vx-cloud-not-on-npm notes are
  accurate (kept). Core 1158 pass, cloud 235 pass, lint clean.

- **2026-07-05**: **Provable cache correctness Phase 2 — `--verify=inputs` /
  `=all` (input-completeness via the sandbox)** (the flagship's second proof;
  the OS sandbox — bwrap+strace — is installed in CI and now this env, so it's
  e2e-verifiable). Determinism (Phase 1) proves outputs are reproducible; this
  proves the OTHER half of cache safety: the declared `cache.inputs` are the
  WHOLE workspace read set. `--verify=inputs` forces every executed cacheable
  task through vx's existing declared-input baseline sandbox (`baseAllowRead` =
  resolved inputs, `baseDenyRead = [workspaceRoot]`) regardless of whether the
  task declared `sandbox: {}`; a read of any undeclared WORKSPACE file is flagged
  `undeclared-inputs` (naming the path, workspace-relative, via the existing
  strace `openat` oracle) and the run FAILS. `--verify=all` runs both proofs,
  input-completeness FIRST (short-circuits the determinism re-run when inputs
  are already wrong). Reads OUTSIDE the workspace (CA certs, `~/.config`) aren't
  flagged — only undeclared reads inside it (the ones that can change a cached
  output). **Key mechanism decision** (`execute-task.ts`): a sandbox forced on
  ONLY by `--verify=inputs` surfaces its violations as the VERDICT (reds the run
  via the `ok` clause, like `nondeterministic`) — it does NOT flip the task's
  own exit code the way a USER-declared `sandbox: {}` violation does
  (`if (userSandbox && violations.length > 0 && code === 0) code = 1`), so the
  task isn't mislabeled failed and the retry loop doesn't pointlessly re-run.
  New verdicts on `VerifyVerdict`: `proven-complete` (inputs OK on an
  inputs-only run), `undeclared-inputs{paths}`. `run.ts` forces sandbox init
  when `verify.inputs` and errors CLEARLY when the sandbox is unavailable (never
  silently "passes" — the design's platform-honesty rule). Pure side-channel —
  NO cache-key/SCHEMA/CACHE_VERSION change (verify is `RunOptions` only). CLI:
  `--verify=inputs`/`=all` (previously rejected as "Phase 2"). **Tests:** parser
  coverage for ALL FOUR `--verify` forms + `--verify-allow` (a gap even for
  Phase 1 — there was zero parser test); pure `undeclaredInputPaths` unit tests
  (bracket extraction, dedup/sort, raw-line fallback); 4 sandbox-gated e2e
  (`describe.skipIf(!probeSandbox().available)` — proven-complete, undeclared-
  inputs names the path + fails run, hit→not-verified, `=all` short-circuit).
  Core 1113 pass, cloud 235 pass, lint clean. Verified with the real CLI
  (clean→proven-complete exit 0; leaky→undeclared-inputs names
  `packages/leaky/secret.txt` exit 1). Docs: cli.md (`--verify=inputs` section +
  flag row), CI guide, comparison.md (both proofs). **STILL-OPEN (Phase 4):**
  cross-machine fingerprint diff (ship Phase-1 `fp1` over telemetry, serve diffs
  by cache key across arches). Deferred Phase-2 extras: per-task `cache.verify?:
boolean` opt-out (+ hash-stripping) and `cache.verify.ignore` globs — the
  run-level `--verify-allow` covers the escape-hatch need today.

- **2026-07-05**: **Provable cache correctness Phase 3 (observability half) —
  the `--verify` verdict rides telemetry, OTel spans, + the GHA job summary**
  (continuing the flagship; the terminal-only verdict now reaches every
  observability surface). Three additive slices, NO schema/CACHE_VERSION bump.
  **(1) Core telemetry contract:** `TaskTelemetry` gains an additive-optional
  `verify?: VerifyVerdict`, projected from the outcome in BOTH the streaming
  `task.end` record (`telemetry.ts`) and the per-run summary's `tasks[]`
  (`run.ts`) — modeled EXACTLY on the `attempts` flaky field: absent for a
  non-verify run, so a v2 consumer is byte-unaffected and
  `TELEMETRY_SCHEMA_VERSION` stays 2. `VerifyVerdict` re-exported from the
  façade (`src/index.ts`) since it's now part of the public `RunSummaryRecord`
  shape. **(2) `@vzn/vx-otel` (first consumer):** a `vx.task.verify` span
  attribute carries the verdict kind; a `nondeterministic`/`allowed` verdict
  lists the diverging paths in `vx.task.verify.changed`; a
  `nondeterministic`/`rerun-failed` verdict maps the span to status ERROR
  (`taskStatusCode` now takes the whole `TaskTelemetry`, not just status) — so
  a task that exited 0 but poisons the cache surfaces as a FAILED span in
  Grafana/Honeycomb/Datadog. Bundled the pre-existing gap: `vx.task.attempts`
  (the retry count never reached the exporter). **(3) GitHub Actions job
  summary** (`packages/cloud/src/github-summary.ts`, pure glue over the
  RunSummaryRecord — no persistence, no serve needed, mirrors the flaky
  treatment): the head gains a `🔒 Hermeticity: N proven · M non-deterministic`
  line (⚠️ icon when M>0), and each non-hermetic task is flagged inline in its
  status cell with the diverging outputs (truncated `+N more`). Silent for
  hits / no-outputs / non-verify runs. **Tests:** telemetry projection pin
  (verify on task.end, absent without --verify), vx-otel (verdict attrs +
  changed + span-ERROR + attempts, +2), github-summary (hermeticity line +
  inline marker + truncation + no-verify-no-line, +3). Core 1088 pass, otel
  24 pass, cloud 235 pass, lint clean. Docs: cli.md anchor referenced from a
  new guides/ci.md "Proving cache correctness" section (the `--force --verify`
  nightly/merge-queue recipe). **STILL-OPEN (design Phase 2 + 4):** input-
  completeness via the sandbox (`--verify=inputs`/`=all`) — blocked from e2e
  here (bwrap/socat not installed in this env); cross-machine fingerprint
  diff. Persisting the verdict in the cloud runs table for a historical
  dashboard "Hermeticity" card is a deferred SCHEMA-bump follow-up (the
  streaming surfaces above cover the actionable CI/observability paths today).

- **2026-07-05**: **Provable cache correctness — `vx run --verify`
  (Phase 1: determinism)** (owner: "I don't wanna copy competitors… what's
  missing but is unlocked by vx architecture? build things on top add even
  more to be ahead"). The flagship differentiator: vx is the only runner
  that PROVES a cache entry safe instead of hoping. Design in
  `docs/design/cache-correctness-2026-07.md` (two proofs: determinism +
  input-completeness — the principled, EXPLICIT inverse of the
  owner-rejected auto-input inference; vx never guesses inputs, it proves
  the declared ones are complete/reproducible and fails loud with the exact
  paths). **Phase 1 shipped:** after an executed cacheable task saves
  attempt 1, `--verify` re-runs it and content-compares outputs (git-blob
  OID per file via the existing `Cache.hashFile` — mtime-independent; NOT
  the artifact bytes, which embed tar mtimes, and NOT `output_files` rows,
  which store only size+mode+mtime). Same bytes ⇒ `proven-deterministic`;
  divergent ⇒ `nondeterministic` naming the changed rels + the run FAILS.
  **Verdicts** (`VerifyVerdict` union, structurally on `TaskOutcome.verify`
  in `graph/scheduler.ts` since graph can't import orchestrator):
  proven-deterministic / nondeterministic(changed) /
  allowed-nondeterministic(changed) / rerun-failed(exitCode) / no-outputs /
  not-verified (cache hit). **Zero-cost & key-stable:** a pure `RunOptions`
  side-channel, NEVER folded into a cache key — a `--verify` run cache-HITS
  a plain run's entry (pinned), so no CACHE_VERSION/SCHEMA bump; a plain run
  attaches no verdict (byte-identical hot path). Only executed + cacheable +
  output-declaring tasks verify (`no-outputs` when none declared, hit ⇒
  `not-verified`). Pair with `--force` to re-execute + verify a warm graph.
  **Mechanism** (`orchestrator/execute-task.ts`): extracted `runAttempt()`
  (function decl) shared by the retry loop AND the verify re-run so they
  can't drift; snapshot `violations` into `finalViolations` BEFORE the
  re-run clobbers it; after the compare, `cache.restoreOutputs` puts attempt
  1's saved bytes back so the on-disk tree ends bit-identical to the cached
  artifact. New `orchestrator/verify.ts` (pure: `outputRefs` keys project
  outputs by rel-to-projectDir + ws outputs by `workspace-outputs/<rel>`;
  `hashOutputTree`; `diffOutputTrees`; `classifyDeterminism`;
  `formatVerifySection`). CLI: `--verify` / `--verify=determinism`
  (`inputs`/`all` rejected as "not available yet — Phase 2"), `--verify-allow
=<pkg#task,…>` (exempts known-nondeterministic → `allowed-nondeterministic`,
  stays green). Wire: `RunRequest.verify` (Set↔array in both mappers). `run.ts`:
  extends the `ok` predicate (nondeterministic/rerun-failed ⇒ not ok), prints
  the Verify summary section via `log.status`. Cost ≈ 2× exec for verified
  tasks — a CI/pre-merge gate, not an every-run default. 7 tests in
  `tests/verify.test.ts` (proven, nondeterministic-names-path-fails-run,
  no-outputs, --verify-allow greens, hit→not-verified + key-stability pin,
  --force verifies warm, plain-run→undefined). Core 1087 pass, cloud 232
  pass, lint clean. Docs: cli.md (`--verify` flag rows + § "Provable cache
  correctness"), comparison.md (LEADS "Where vx is ahead"). **NEXT
  (design Phases 2-4):** input-completeness via the sandbox
  (`--verify=inputs`/`=all` — the `runSandboxed` allowRead=declared-inputs +
  strace/violation-store undeclared-read oracle already exists), a
  dashboard "Hermeticity" card + telemetry field, cross-machine fingerprint
  diff.

- **2026-07-05**: **`--cache-dir <path>` CLI flag + `--continue` doc
  correction** (backlog closeout from `docs/comparison.md`). Two small
  comparison.md gaps closed. **(1) `--cache-dir`:** the workspace
  `defineWorkspace({ cacheDir })` field already redirected the cache; added
  the matching per-run CLI flag. `RunOptions.cacheDir` → `prepare.ts`
  resolves it (`path.resolve(cwd, cacheDir)`) OVER `resolveCacheDir`, so it
  beats the workspace field + the `.vx/cache` default. Per-run knob, NEVER
  folded into a cache key (like `--timeout`/`--retry`); `RunRequest.cacheDir`
  on both wire mappers; parser guards no `--cache=<spec>` collision (char 7
  differs). Tests: parser (space/= forms, no collision, missing-value) + e2e
  (cache lands in the override dir not `.vx/cache`, hits from there, a
  no-override run misses). **(2) `--continue=<mode>` was mislisted as an open
  gap** — it's been fully wired for a while (CLI parse → scheduler
  never/deps-ok/always enforcement → wire → tests → cli.md). Marked shipped
  in comparison.md (gaps list + the CLI-flag-map row now spells the three
  modes) and dropped from the CLAUDE.md backlog. Core 1097 pass, cloud 232
  pass, lint clean.

- **2026-07-05**: **Docs Mermaid diagrams fixed — three independent root
  causes** (owner: "Diagrams in docs are broken"). Every diagram page
  rendered Mermaid's "Syntax error" bomb. Diagnosed by driving the built site
  in a headless browser (Chromium at `/opt/pw-browsers`, playwright at
  `/opt/node22/...`) + parsing each source with Mermaid's own UMD build to get
  the exact grammar error. **(1) `Head.astro` re-render corruption:**
  `renderMermaid` reset each block with `el.innerHTML = source`, which
  re-parsed a `<br/>` in a label into a real `<br>` DOM element — mangling the
  definition Mermaid reads. Switched to `el.textContent = source` so `<br/>`
  stays literal (Mermaid renders it as a line break). This alone fixed the
  flowcharts + state diagrams. **(2) reserved-word node id:**
  `architecture.md` used `graph` as a flowchart NODE ID (`index --> graph`) —
  `graph` is a reserved keyword, Mermaid 11 errors "got 'GRAPH'". Renamed to
  `graphmod["graph"]` (safe id, same label). **(3) semicolon in sequence
  text:** `flows.md` sequence diagrams put `;` in `Note`/message text —
  Mermaid treats `;` as a STATEMENT SEPARATOR, so the note split and the
  parser errored at the next token. Isolated by a parametric parse (`;` fails;
  `<br/>`, `,`, messages all fine). Replaced the three `;` with an em dash /
  removed it. **Gotchas for future diagrams:** never use `graph`/`end`/
  `subgraph`/`class`/`state` as a flowchart node id; never put `;` in
  sequenceDiagram note/message text; `<br/>` in labels is fine as long as the
  render path feeds Mermaid textContent, not innerHTML. Browser-verified: all
  4 diagram pages render 15/15 diagrams, 0 errors. Source-only fix
  (`apps/docs/src/components/Head.astro`, `docs/{architecture,flows}.md`); the
  Pages deploy rebuilds (dist + generated content are gitignored).

- **2026-07-05**: **Dashboard SPA dist is a BUILD ARTIFACT, not committed;
  no doc asks an external user to clone the internal repo** (owner: "make the
  spa not committable … dist should be built during vx cloud build and
  bundled into its package/bin not committed to repo. … do not ask user to
  clone the repo in the docs. Repo is internal"). REVERSES the 2026-06-28
  "commit `packages/cloud/ui/dist/index.html`" decision (which existed so a
  fresh checkout could compile the binary without a SPA build). **(1) dist
  un-committed**: gitignored plus `git rm --cached`; every consumer now builds
  it first — the npm package (`build-npm.ts buildCloudPackage` runs the vite
  build before copying `ui/dist`), the Docker image (a vite-build step before
  the `bun build --compile` that embeds it), and locally `vx run build.ui` (the
  `build.bun.*` tasks already depend on it). The runtime already degraded
  gracefully: `loadUiHtmlPath` try/catches the dynamic `ui-asset` import and
  returns null (API-only serve) when the dist is absent, so from-source dev is
  unaffected. NO runtime UI build anywhere — the serve `GET /` test verifies
  the SPA-routing contract against a tiny fixture HTML (not the real dist), so
  it stays hermetic without building. **Verified end-to-end**: fresh tree (no
  dist) then build SPA then
  `bun build --compile` of the cloud bin then the compiled binary serves the
  embedded dashboard plus `/health`. Cloud 232 pass, lint clean.
  `.dockerignore` no longer whitelists `ui/dist` (built in-image, not copied
  from context). **(2) no clone in docs**: both CLIs publish to npm now, so the
  distributed-CI recipes and the `vx-agent` composite action install via
  `npm i -g @vzn/vx` and `npm i -g @vzn/vx-cloud` (Bun-source, needs setup-bun)
  instead of cloning the repo at a pinned ref plus a bun PATH shim; the
  action's `ref` input (git ref) became `version` (npm dist-tag). The README
  `## Development` clone stays (a contributor path for people with repo access,
  not a user install step).

- **2026-07-05**: **Task timeout defaults — per-task > env > workspace
  precedence** (owner: "per task timeout and workspace timeout and global
  timeout … Per task always precedence then env var then workspace var").
  `exec.timeout` already bounded a single task; added the two run-level
  FALLBACKS for tasks that declare none. Resolution, highest first:
  per-task `exec.timeout` → `--timeout <ms>` / `RunOptions.timeout` →
  `VX_TASK_TIMEOUT` env → workspace `timeout` (`defineWorkspace`). Modeled
  EXACTLY on the `--retry`/`RunOptions.retries` run-level-default precedent:
  `execute-task` resolves `step.timeout ?? args.timeout`; `run.ts` collapses
  env+workspace+option into the single run-level default it threads
  (`taskTimeoutDefault = options.timeout ?? readTaskTimeoutEnv() ??
  workspaceConfig?.timeout`); a malformed `VX_TASK_TIMEOUT` is IGNORED
  (parsed to undefined) so a typo never silently disables a task's own
  limit. **Threaded as an option only — NEVER folded into a cache key** (a
  timed-out task fails and is never cached), so a `--timeout` run cache-hits
  a plain run's entry (pinned by a key-stability test, same as `--retry`).
  Wire: `RunRequest.timeout` in both protocol mappers, so a delegated run
  carries the default (the serve re-resolves its own env+workspace).
  `--timeout` works for `vx watch` too via the shared resolver (a runaway
  task in a watch loop should be bounded). Loader validates `WorkspaceConfig.
timeout` (positive integer ms, mirrors `concurrency`). NO CACHE_VERSION/
  SCHEMA bump. Files: `config.ts` (WorkspaceConfig.timeout), `project-loader.ts`
  (validation), `orchestrator/{options,execute-task,run,protocol}.ts`,
  `cli/{run,help}.ts`. 15 tests in `tests/task-timeout.test.ts` (precedence
  across all four levels, per-task-always-wins BOTH directions, malformed-env
  fallthrough, key stability, `--timeout` parsing + validation, wire
  round-trip, loader validation). Core 1078 pass, cloud 232 pass, lint clean.
  Docs: schema.md (exec.timeout precedence note + WorkspaceConfig.timeout +
  error row), cli.md (`--timeout` flag row).

- **2026-07-05**: **Flaky detection CONFIRMED from within-run retries, not
  just cross-run inference** (road-to-best-CI #5; continuing the retries →
  flaky thread). `getFlakiestTasks` inferred flakiness from cross-run failure
  VARIANCE — it couldn't tell a nondeterministic task from one a later real
  fix greened. A task that FAILED then PASSED within a SINGLE run (identical
  inputs, same commit) is nondeterministic BY DEFINITION — the gold-standard
  signal, and vx gets it FREE from the retry it already ran (Nx Cloud needs
  paid re-runs to observe it). Persisted `attempts` into the `runs` table
  (**SCHEMA v23**, nullable, analytics-only — the cache KEY is unchanged, NO
  CACHE_VERSION bump; threaded through `RunRecord`/`bindRun`/the insert + the
  cloud IngestStore's RunRecord mapping from the pushed summary). `getFlakiest
Tasks` now CONFIRMS directly: a within-run retry surfaces the task even with
  fewer than 3 runs and OUTRANKS every merely-inferred one (`flakyConfirmed`
  / `withinRunRetries` / `maxAttempts` on `FlakyTask`; the rank score puts a
  confirmed flake above any inferred one, then breaks ties by failure rate
  then duration tail). Dashboard: a 'Retried' column (danger tone on a
  non-zero count) on the Flaky tasks card, rebuilt dist. Prereq shipped same
  day: the `attempts` telemetry field (below). Core 190 pass, cloud 232 pass.

- **2026-07-05**: **Retried-then-passed tasks flagged flaky in the GHA job
  summary + the day's red lint gate greened** (road-to-best-CI #4/#5
  completion; continuing the non-stop loop). **(1) `attempts` telemetry
  field.** A task that only goes green after a retry is flaky BY
  DEFINITION, and `TaskOutcome.attempts` already carried the count (set
  only when >1, from the 2026-07-04 retries work) but it dead-ended at the
  outcome — never reached telemetry. Added `attempts?: number` to the
  `TaskTelemetry` contract (`src/orchestrator/telemetry.ts`) and projected
  it from the outcome in BOTH the streaming `task.end` record and the
  per-run `RunSummaryRecord.tasks[]` (`run.ts` summary construction).
  **ADDITIVE — no `TELEMETRY_SCHEMA_VERSION` bump** (stays 2): the field is
  absent for a once-run task, so a v2 consumer that ignores it is
  byte-unaffected (the same additive-optional rule the retries work used
  for `ExecConfig.retries`). Small, justified deviation from the
  zero-core-change streak — pure observe-only telemetry data, no scheduling/
  cache path touched; pinned by a core test driving a real retried run
  through a `telemetrySinks` hook and asserting `attempts: 2` lands in the
  summary. **(2) GHA flaky flag.** `packages/cloud/src/github-summary.ts`
  `statusCell` now renders a retried-then-succeeded task as `✅ success ⚠️
  flaky (N attempts)` — the most actionable place, right on the failed
  build's job page. A single-attempt success is never flagged. **(3) Greened
  the lint gate** — the day's github-summary + task-logs commits had left
  tsgolint (real type checking) RED with 10 errors that `bun test` (transpile-
  only, no checking) never surfaced: `CloudIngestSink`'s options assigned
  `string | undefined` into `exactOptionalPropertyTypes` exact-optional
  fields (build the optional props via conditional spread + guard the
  constructor assignments), and two serve/summary test fixtures carried an
  invalid `RunContextRecord` (`flow: 'full'` isn't a flow; `os`/`arch` are
  non-null `string`) plus an `unknown`-typed `res.json()` access. **Lesson
  logged:** `bun test` passing is NOT the gate — `bun src/bin.ts run
lint.oxlint` (oxlint + tsgolint) type-checks `packages/cloud` too and MUST
  be run before push; the earlier commits skipped it. Core 1061 pass, cloud
  232 pass, lint+oxfmt clean. NEXT on the road-to-best-CI: flaky
  detection → auto-retry SUGGESTIONS surfaced in the dashboard (the
  `getFlakiest`/`failureMode` surface + this new `attempts` signal are both
  live now), then per-request cache policy to remote agents (§13 known-open).

- **2026-07-04**: **Duration-aware dispatch — start the longest task first
  (LPT)** (road-to-best-CI #5). The `DistScheduler` ready queue was FIFO; now
  `nextReady()` returns the historically LONGEST ready task (longest-
  processing-time makespan heuristic, the same Nx Agents uses) so a long pole
  starts as early as possible. **Hint source = THIS serve's ingest history**
  (mean executed-run ms per `project#task`, one grouped `AVG(duration_ms)` scan
  in `taskDurationHints`), NOT the submitter — correct for CI, where the
  submitter is an ephemeral empty runner with no local history.
  `DistSchedulerArgs` gains an optional `durationHints: ReadonlyMap<string,
number>`; serve.ts builds it at `dist:submit`. **No wire change**
  (serve-computed), no core change, no protocol bump. **Byte-identical
  fallback:** no hints (fresh workspace) or all-equal → `nextReady` returns the
  queue head exactly as before (strict `>` keeps queue order on ties); the
  existing single-submission dispatch tests stay green unchanged. Pinned by two
  new tests (LPT reorders longest-first; an empty map stays FIFO). Cloud suite
  231 pass. NEXT: flaky detection surface + optional auto-retry; the
  PR-check-via-API half of #3.

- **2026-07-04**: **GitHub Actions job summary — a per-task result table on the
  job page** (road-to-best-CI #3, first half). A `vx run` inside GitHub Actions
  appends a markdown result table (failures first, with exit codes; cache
  provenance; verdict + stats line) to `$GITHUB_STEP_SUMMARY`, so a red build
  says WHICH task failed on the job page — no log spelunking. **Pure cloud
  glue, zero core change:** `github-summary.ts` `formatGithubSummary(summary)`
  is a self-contained formatter over the `RunSummaryRecord` the telemetry sink
  already holds (NOT core's `formatRunReportMarkdown`, which takes a different
  `RunResult` shape and isn't on the façade — a small cloud-side formatter is
  cleaner than converting). **Works with no serve connected:** the `cloud()`
  telemetry capability now activates when EITHER a connection resolves OR
  `GITHUB_STEP_SUMMARY` is set; the `CloudIngestSink` took an
  options-object constructor with an OPTIONAL `connection` (undefined →
  GHA-summary-only, skips the POSTs; log capture stays off without a serve to
  ship to). A plain local run with neither still declines (zero-cost contract
  held, pinned). Never-fail (write error swallowed + warned), bounded (table
  caps 100 rows + a truncation note). 10 new tests; cloud suite 229 pass.
  Docs: guides/ci.md "GitHub Actions job summary". **Second half still open:**
  a real PR _check_ via the GitHub Checks API (needs a token + checks:write —
  genuine service territory, deferred). NEXT: flaky detection→auto-retry (wire
  `getFlakiestTasks` + the shipped `TaskOutcome.attempts`), duration-aware
  dispatch ordering.

- **2026-07-04**: **Per-task logs + artifacts in the dashboard — road-to-best-CI
  #2 (Nx-Cloud parity: click a failed task, read its output)**. Design in
  `docs/design/task-logs-2026-07.md`; shipped in three committable slices, ALL
  in `@vzn/vx-cloud` — ZERO core change (the boundary check: `git status src/`
  stayed empty across all three). The 2026-06 opt-in `task.log` telemetry
  surface (built, never consumed until now) got its first consumer, so no
  TELEMETRY_SCHEMA/CACHE_VERSION bump. **(1/3) foundation:**
  `task-log-capture.ts` `TaskLogBuffer` (the shared bounded-tail primitive:
  per-task 128 KiB whole-chunk head eviction with no concatenation until drain,
  per-run 4 MiB budget where failed tails are NEVER evicted by successes,
  cache-hit/skipped/aborted dropped, drain orders failures first) +
  `log-store.ts` `LogStore` (a per-workspace `logs.db` sidecar with its OWN v1
  gate — never core's Cache schema; idempotent INSERT-OR-IGNORE, server-side
  re-truncation since the wire is never trusted for caps, zstd over 4 KiB, hash
  resolution for hits, age + byte-ceiling prune throttled 5 min). **(2/3)
  capture + API:** `CloudIngestSink` gains `wants ['task.log','task.end']` ONLY
  when logs enabled (`cloud({ logs })` / `VX_CLOUD_LOGS`; default on when
  connected) — off → `wants` stays `[]` so the source never projects
  task:stdout (the plain-run zero-projection guarantee, pinned); flush ships one
  `POST /v1/ingest/logs` after the summary (empty on an all-hit run). Serve:
  `POST /v1/ingest/logs` (bearer, 16 MiB cap → 413, wire-version gate → 400) +
  `GET /v1/runs/:id/logs/:taskId` (direct row → else cache-hit-by-hash with
  `source:'cache'`+`refRunId` → else 404; `artifactHash` advertised only when
  the requester's principal can fetch it from /v8). Delegated runs captured
  server-side by a per-run sink (no client push, swept after 15 min if a run
  crashes before its summary). **(3/3) UI:** a self-contained `TaskLogs`
  json-render component (own createResource keyed on runId+task, ANSI-stripped
  scrollback, truncation banner, cache-provenance link, bearer-fetched artifact
  download) in the run-detail selected-task card; rebuilt dist. Browser-verified
  end-to-end (SPA reaches the new endpoint 200, workspace-scoped, failed task's
  content present, no console errors beyond the pre-existing `/v1/graph`
  degradation). 36 new tests; cloud suite 221 pass. **Verified GAP surfaced &
  documented:** a distributed (`VX_CLOUD_DISTRIBUTE`) run ingests NO run summary
  anywhere today, so it's absent from run history entirely — that's the
  documented Phase-2 prerequisite for distributed-run log capture (the relay
  point already sees every chunk). Docs: dashboard.md (panel + bounded-storage/
  privacy section + the distributed limit), cli.md serve knobs. NEXT on the
  road-to-best-CI: PR/commit summary + checks (cloud glue over run-report.ts),
  then flaky detection → auto-retry (wire `getFlakiestTasks` + the new
  `TaskOutcome.attempts` onto the retries primitive), then duration-aware
  dispatch ordering.

- **2026-07-04**: **Task-level retries — `exec.retries` + `--retry <n>`**
  (road-to-best-CI #4; the primitive flaky-detection→auto-retry will ride).
  `ExecConfig.retries?: number` = max ADDITIONAL attempts after a failed
  attempt; follows the `exec.timeout` precedent exactly (config-declared →
  participates in resolved-config hashing naturally, distinct key by design;
  absent → byte-identical keys; NO CACHE_VERSION bump, no special hashing
  code). Loader rejects negative/non-integer and `retries`+`persistent`.
  **Semantics** (`execute-task.ts`, the miss path is now a retry loop):
  cleanOutputs re-runs before EVERY attempt (a failed attempt's partial
  outputs can't leak into the next); sandbox violations reset + re-fold per
  attempt; a TIMEOUT kill is a retryable failure but an ABORT
  (SIGINT/SIGTERM teardown, `!timedOut`) returns immediately — a tearing-down
  run never retries; between attempts one
  `vx: retrying <id> (attempt k/n) after exit <code>` line streams via
  taskStderr; the final outcome is the last attempt's, and `cache.save`
  captures the WINNING attempt's stdout + inputComponents only (pinned: a
  post-retry cache hit replays only the winning stdout).
  `TaskOutcome.attempts` set only when >1 (not persisted, not on the wire —
  telemetry-side flaky detection is the future consumer). **Run-level
  default:** `RunOptions.retries` + `--retry <n>` (also `vx watch` via the
  shared resolver); explicit config wins INCLUDING `retries: 0`; threaded as
  an option only, never folded into any hash — pinned by a key-stability test
  (a `--retry` run cache-hits a plain run's entry). Wire: `RunRequest.retries`
  in both protocol mappers. 12 new tests in `tests/retries.test.ts`; core
  1060 pass. Bundled cleanup: the long-dead `effectiveStderr` accumulation in
  execute-task (stderr hasn't been cached since v17) deleted. Docs: schema.md
  `retries` section, cli.md `--retry`. NEXT on this thread: wire
  `getFlakiestTasks` + `attempts` into flaky detection → auto-retry
  suggestions (dashboard), then duration-aware dispatch.

- **2026-07-04**: **Adversarial re-review of the day's shipped waves — the
  turnkey CI recipe's ambient-mode race fixed (+2 smaller fixes)** (owner:
  "review past commits… treat as hostile"). Full-pass review of every commit
  shipped earlier today. **(1) REAL BUG — `vx-distributed-ci.yml` used ambient
  distribution in a fan-out CI:** the run job did `vx-cloud connect
--distribute` + `vx run`, but ambient mode falls back to a SILENT LOCAL run
  when zero remote agents are registered at the instant of submit — and the
  agent matrix starts in PARALLEL with the run job, so whenever the submitter
  wins the setup race the "distributed" run executes locally while N paid
  agent jobs idle to their 15-min timeout. Fixed to EXPLICIT
  `VX_CLOUD_DISTRIBUTE=<agents>` (submits regardless; agents join mid-run;
  unreachable serve = hard error; no-agents = loud warning), which also
  DELETED the run job's entire vx-cloud source-install + connect dance —
  `VX_CLOUD_URL`/`TOKEN` env drive `resolveConnection` directly, so only agent
  jobs need the vx-cloud binary. Guide recipes (GitHub + GitLab) synced, with
  the ambient-vs-explicit rule documented: ambient = a developer's machine
  (never blocks solo), explicit = CI (the workflow provisioned the agents).
  Also corrected the recipe's "vx IS on npm" comment (first publish still
  pending the owner's trusted-publisher setup). **(2)** `dist/submit.ts`'s
  reachability + ambient-capacity probes used `AbortSignal.timeout` — the
  exact not-unref'd-timer pattern the repo banned (plugin.ts documents why);
  a warm ambient no-helpers run would hang up to ~1s at exit. Switched to the
  clearable-timer pattern. **(3)** `environments.json` accepted ANY number for
  `distribute` — a hand-edited `0`/`-1`/`NaN` passed validation and then
  ENABLED ambient (the rung checks `!== undefined && !== false`, not
  truthiness). Tightened to boolean | positive integer at the file boundary,
  pinned by test. **Reviewed and confirmed SOUND:** heartbeat/sweep lifecycle
  (armed on open, cleared on close/stop; serve timers unref'd + cleared on
  stop), the composite action (explicit shells, GITHUB_PATH semantics,
  `--idle-timeout 0` = never), npm.yml (publish order platform→vx→vx-cloud,
  stamp-before-build, dry-run guard on both triggers, paths match build-npm's
  `dirFor`), release.yml tag handling, and the trust scopes (tier is
  server-derived from the token; the client-supplied PR sub-scope only
  partitions WITHIN untrusted — a scope-claiming PR can touch same-tier peers
  only, never trusted; documented residual). Cloud suite 197 pass.

- **2026-07-04**: **Standing shared-pool multi-run scheduler — a session
  multiplexes CONCURRENT submissions across shared agents (DIST_PROTOCOL v1→v2)**
  (owner: "Make vx the best CI env ever that can run both locally and remote.
  Compete with GitHub Actions and Nx Cloud"). Architect design in
  `docs/design/ci-platform-2026-07.md` — two deliverables: **(1) competitive
  positioning** (the wedge = "vx is the portable execution+cache+pool LAYER you
  run _inside_ any CI provider, byte-identically on your laptop — NOT a CI
  platform"; vx should be invoked BY GHA/GitLab, never replace their
  triggers/hosted-runners/secrets/marketplace/DSL — permanent non-goals; a
  ranked road-to-best-CI table with the multi-run scheduler as #1 ship-now, then
  per-task logs, PR checks, retries, flaky→retry, duration-aware dispatch) and
  **(2) the #7 multi-run scheduler design**. **Shipped Phase 1, all in
  `@vzn/vx-cloud` (zero core change, correctness law §6.3 untouched, trust scopes
  untouched, no CACHE_VERSION/SCHEMA bump).** Removes the last §D#7 fence: the
  registry allowed ONE active submission per `{workspaceId, session}`
  (`SessionState.active: ActiveSubmission | null`, a concurrent second submit
  errored); now `active: Map<submissionId, ActiveSubmission>` + a `rotation`
  cursor. **Commit-routing model:** commit is a dispatch-ELIGIBILITY filter,
  never a refusal — the `hello()` commit-mismatch refusal + the `beginSubmission`
  mismatched-agent drop are GONE; a mismatched agent stays registered and simply
  ineligible (a submission whose commit no remote agent holds runs on its own
  self-agent = submitter-local, degrading toward local execution, never a wrong
  hit). **Self-agent ownership:** a `SUBMITTER_LABEL` self-agent is eligible only
  for the submission that owns it (new optional `AgentHello.ownerSubmissionId`),
  so a same-commit peer can't conscript your laptop. **Data model:**
  `RegisteredAgent.inFlight: Set<taskId>` → `Map<submissionId, Set<taskId>>`
  (capacity = `inFlightTotal < capacity`, so one agent holds slots for several
  submissions and death hands each submission back ONLY its own tasks);
  `ActiveSubmission` gains `submissionId`/`nextReady()`/`affinityAgents()`/
  `assign()`. **Fair dispatcher** `dispatchSession(state)`: hand each active
  submission at most one assignment per pass, rotate the start, loop until no
  progress = max-min fair share (a small run is never starved by a huge
  concurrent one; work-conserving). Dispatch is triggered by the scheduler's
  bookkeeping callbacks calling `binding.requestDispatch()` (`= dispatchSession`)
  — the registry no longer dispatches inline. **Drain safety (adversarial
  re-review fix):** `binding.drainIfLast()` drains ONLY this submission's
  ELIGIBLE agents and ONLY when it is the last active submission — one run's
  abort/orphan never kills another's shared agents, AND a self-agent-only run
  (a commit no helper holds) never drains a different-commit standing pool.
  The first cut drained ALL session agents, which would have let one stray
  orphaned feature-branch run kill a main-pinned standing pool; pinned by a
  drainIfLast unit test. The same re-review gated `hello()`'s onAgentJoin on
  the shared `eligible()` predicate (a self-agent join no longer notifies
  non-owner submissions) and replaced the agents-e2e blind 800ms
  hello-settling sleep with a deterministic poll of `/v1/agents` until the
  expected remote agents have registered.
  **DIST_PROTOCOL_VERSION 1→2** (`submissionId` added to `task:assign` +
  `agent:start/stdout/stderr/done` + `dist:submit`; optional `ownerSubmissionId`
  on `agent:hello`; envelope adapters + agent-loop threading updated); an old
  agent hitting a new serve is a clean `agent:refused` naming both versions.
  **`/v1/agents?commit=<sha>`** commit-scopes the ambient remote-capacity probe
  so a feature-branch dev against a `main`-pinned pool reads 0 helpers and stays
  a fast local run. **Single-submission stays byte-identical** — the fair loop
  degenerates to the old greedy dispatch (the one behavior change is
  intentional: a commit-mismatched agent is now ineligible rather than
  refused-and-dropped at pairing). **Files:** `protocol-dist.ts`,
  `dist/{registry,scheduler,submit,agent-loop}.ts`, `cli/serve.ts`. **Tests:**
  `dist-registry.test.ts` (eligibility-not-refusal, concurrent submissions,
  duplicate-submissionId guard, per-submission reassignment, commit-filtered
  capacity), `dist-scheduler.test.ts` (single-submission dispatch/prune/reassign
  kept byte-for-byte via a stub binding whose `requestDispatch` runs the exported
  `dispatchGreedy`), `wire-dist.test.ts` (v2 + `submissionId`/`ownerSubmissionId`
  round-trips), new `dist-multirun.test.ts` (3 adversarial cases through the REAL
  registry + REAL scheduler: same-commit fair sharing, no-remote-eligible → self-
  agent only + warning, shared-agent death re-queues only its owner-submission's
  tasks), `agents-e2e.test.ts` (a real serve + 2 agents + two concurrent
  submitter clones on one session both succeed, no "already active" error). Cloud
  suite 194 pass (+9), core 1048 pass, lint+oxfmt clean. **NEXT (road to
  best-CI):** per-task logs/artifacts in the dashboard (Nx-Cloud parity), PR
  summary + checks (cloud-side glue over `run-report.ts`), task-level retries,
  flaky detection→auto-retry.

- **2026-07-04**: **`@vzn/vx-cloud` publishes to npm — the turnkey CI recipe's
  source-clone collapses to `npm i -g @vzn/vx-cloud`** (continuing the non-stop
  loop; the follow-up #6 surfaced). Unlike `@vzn/vx` (a no-Bun standalone binary
  via per-platform optionalDeps), `@vzn/vx-cloud` publishes as a **Bun-source
  package**: its bin is the Bun-shebang `src/cli/bin.ts`, and `ui-asset.ts`
  embeds the dashboard via a relative `../../ui/dist/index.html` import, so `src`
  - `ui/dist` ship together. It **requires Bun** on the host (CI already provides
    it via setup-bun; the no-Bun serve path stays the ghcr Docker image) and
    depends on `@vzn/vx` at the SAME version so the plugin + CLI's bare `import
'@vzn/vx'` resolves without the dev workspace symlink. Its only external src
    import is `devframe`, which is **type-only** (erased) → no runtime dep beyond
    core. `scripts/build-npm.ts` gained `buildCloudPackage()` (copies src +
    ui/dist + LICENSE + a generated README, writes the package.json with
    `exports {., ./plugin}`, `bin`, `engines.bun`, `dependencies {@vzn/vx}`);
    `npm.yml` publishes it LAST (after `@vzn/vx`, which it depends on).
    **Verified locally:** generated the tree, simulated the installed
    node_modules, ran `bun …/vx-cloud/src/cli/bin.ts --help` (resolves `@vzn/vx`,
    prints help) and `import { cloud } from '@vzn/vx-cloud/plugin'` → `cloud()`
    returns the `vzn/cloud` plugin. **Owner TODO:** the trusted-publisher /
    scope-token now covers SIX names (`@vzn/vx` + 4 platform + `@vzn/vx-cloud`).
    The turnkey recipes keep the source-clone as the pre-first-publish default;
    once a release publishes `@vzn/vx-cloud`, the recipe step becomes
    `npm i -g @vzn/vx-cloud`. No core/cloud runtime change — packaging only.

- **2026-07-04**: **Universal agents Phase 2 — heartbeat liveness, ready-queue
  autoscaling signal, turnkey CI recipes, + a dedup simplification** (owner:
  "Work on all. Non stop. … review code and docs find simplification
  improvements and execute. Then repeat"). Four increments from
  `universal-agents-2026-07.md` §D, all in `@vzn/vx-cloud` (no core change):
  **(#4 heartbeat/liveness)** the registry detected agent death only on WS
  `close`, so a half-open TCP socket (crashed box / partition) stalled its
  in-flight tasks until the OS keep-alive timeout. Now each agent sends
  `agent:heartbeat` every 10s (`AGENT_HEARTBEAT_MS`); the registry tracks
  per-agent `lastSeenAt` (ANY message = liveness, so a busy-but-quiet agent is
  never reaped) and a 15s serve sweep reaps agents silent past 30s
  (`AGENT_STALE_MS`) via the existing idempotent `drop()` → `onAgentLeave`
  reassignment. `agent:heartbeat` is additive (no DIST_PROTOCOL_VERSION bump).
  **Version-skew:** RESOLVED same-day — the sweep only reaps agents with
  `sawHeartbeat === true`, so an OLD agent (predating heartbeats) is never
  falsely reaped for being idle; it's still cleaned up on WS close. A
  partitioned NEW agent heartbeated before it vanished, so it IS reaped. **(#5 ready-queue depth)** the scheduler already tracks a
  ready-but-unassigned queue; exposed `readyDepth()` through `ActiveSubmission`
  so `availableCapacity`/`GET /v1/agents` now report `ready` (non-zero only when
  agent capacity is saturated) — the signal an autoscaler scales UP on.
  **(simplification)** the identical cache-env wiring copy-pasted in
  `cli/agent.ts` + `dist/submit.ts` → one shared `wireAgentCacheEnv` in
  `dist/session.ts` (the design's §C.3 dedup made literal). **(#6 turnkey CI
  recipes)** a `.github/actions/vx-agent` composite action + a
  `vx-distributed-ci.yml` reusable workflow (`uses: vznjs/vx/.github/workflows/
vx-distributed-ci.yml@main`, inputs task/agents/capacity, secrets
  VX_CLOUD_URL/\_TOKEN; a plan→agents-matrix→run fan-out) + a "Turnkey setup"
  section in `guides/distributed-ci.md` (GitHub + GitLab). **Honest gap surfaced:
  `@vzn/vx-cloud` is NOT on npm** (npm.yml ships only `@vzn/vx` + its 4 platform
  binaries; the ghcr image is the SERVE only, no git, can't run an agent), so
  the recipes install the `vx-cloud` CLI from source (git clone at a pinned ref
  - bun + a PATH shim) and note it collapses to `npm i -g @vzn/vx-cloud` once
    published. **NEXT (high-value):** publish `@vzn/vx-cloud` to npm — extend
    build-npm.ts/npm.yml to cross-compile + ship `vx-cloud` standalone binaries
    the same optionalDeps way `vx` uses — which makes the turnkey recipe a genuine
    one-liner. **STILL-OPEN big item:** #7 standing shared-pool multi-run fair
    scheduler (the one-active-submission-per-session Tier-3 ceiling). Cloud suite
    184 pass (+3); docs build 145 pages, 0 broken links.

- **2026-07-04**: **Universal agents/pools — Phase 1: ambient distribution
  makes a connected pool a one-time `connect --distribute`, fails SAFE to
  local** (owner: "Make sure arch is flexible. Devs could spin up agents on
  live environments, and use them for local maybe? … flexible universal
  scalable. Easy to start for small and scale for big. Complete CI solution to
  monorepo"). Architect design in `docs/design/universal-agents-2026-07.md`
  (the universal pool model — serve/agent/submitter roles collapsing by scale;
  the easy-start→scale ladder Tier 0 solo → Tier 4 cloud burst; the streamlining
  - complete-CI gap analysis). **Key finding:** the universal primitive already
    exists — `runAgentLoop` is one loop hosted by both the `agent` verb and the
    submitter's self-registration; local/CI/cloud agents are the SAME binary,
    differing only in where they run + who owns lifecycle. What was missing:
    ambient enablement + fail-safe + a capacity gate. **Phase 1 (shipped, all in
    `@vzn/vx-cloud`, zero core change, no CACHE_VERSION/SCHEMA bump, correctness
    law untouched):** (1) `EnvironmentEntry.distribute?: number | boolean` mirrors
    `delegate` (additive-optional → no ENVIRONMENTS_VERSION bump); `--distribute` /
    `--distribute=<n>` on `vx-cloud connect`, shown in `env ls`. (2)
    `AgentRegistry.availableCapacity(ws, session)` counts total vs REMOTE (non-
    `SUBMITTER_LABEL`) agents/capacity; `SUBMITTER_LABEL` moved to registry.ts
    (re-exported from scheduler.ts) to avoid a cycle. (3) serve `GET /v1/agents?
ws=&session=` returns those counts (behind the bearer; the WS-upgrade path is
    unchanged) — the ambient capacity gate + a future autoscaler read the same
    data. (4) `distributedBackend` gains `mode: 'explicit' | 'ambient'`: explicit
    (`VX_CLOUD_DISTRIBUTE`, unchanged) hard-errors on an unreachable serve;
    ambient probes capacity BEFORE the graph prepare and degrades to a normal
    LOCAL run when the pool is unreachable (warns) OR has zero remote helpers
    (SILENT — the fast solo case). (5) `cloud().backend()` ambient rung: an
    environment connected with `distribute` returns the ambient backend; the env
    read is the SAME `activeEnvironment()` the delegate rung already does (and
    only when `cloud()` is declared), so **no environment connected → decline →
    core's `localBackend`, byte-identical fast path**. Net UX: `vx-cloud connect
<url> --distribute` ONCE, then `vx run` fans out across helper agents when
    present and stays a fast local run when not — `VX_CLOUD_DISTRIBUTE` demoted
    from required-per-run to an explicit escape hatch. **KNOWN-OPEN (design §D,
    NEXT):** agent heartbeat/liveness (half-open TCP agents stall until the OS
    timeout), the standing shared-pool multi-run fair scheduler (the
    one-active-submission-per-session rule is the Tier-3 ceiling; two different
    devs ambient-distributing the same repo share `{repoId, local}` and interfere
    — harmless to correctness), ready-queue-depth for autoscaling, turnkey CI
    composite action. **NON-GOALS:** intra-task sharding (task is the unit),
    mDNS discovery, managed fleet controller, input-shipping a dirty tree. Cloud
    suite 181 pass (+11), core gate green, lint+oxfmt clean.

- **2026-07-04**: **npm distribution — `@vzn/vx` publishes the standalone
  binary via per-platform optionalDependencies (esbuild model)** (owner:
  "prepare publishing of vx binaries through npm wrapper using some 3rd party
  tools for that maybe" → chose **`@vzn/vx` dual-purpose** over a separate
  `@vzn/vx-cli`; `vx` unscoped is TAKEN on npm). Rather than a 3rd-party
  postinstall downloader (`go-npm`/`binary-install` — network-at-install,
  breaks `--ignore-scripts`), used the optionalDependencies pattern
  esbuild/turborepo/biome ship: `@vzn/vx` carries the library source
  (`exports: ./src/index.ts`) PLUS a Node launcher (`bin: launcher.mjs`) that
  execs a prebuilt standalone binary shipped as a per-platform
  optionalDependency (`@vzn/vx-{linux,darwin}-{x64,arm64}`). npm installs only
  the matching-os/cpu package; the launcher `require.resolve`s its binary and
  execs it — so `npm i -g @vzn/vx` gives the `vx` command with **no Bun and no
  install-time download**. Launcher fallback: no platform binary + Bun present
  → `bun src/bin.ts` (source checkout, or an unsupported platform with Bun).
  **Files:** `scripts/npm-launcher.mjs` (published-layout launcher template),
  `scripts/build-npm.ts` (`bun scripts/build-npm.ts <version> [--only=<t>]` →
  assembles `dist/npm/{@vzn/vx-<t>,vx}`; reads sandbox-runtime dep + description
  from root package.json so versions never drift), `.github/workflows/npm.yml`
  (release `published` + `workflow_dispatch`; **stamps the version into
  package.json BEFORE `vx run build`** because `src/version.ts` reads
  `../package.json` which `bun build --compile` inlines — else the binary
  reports 0.0.0; publishes platform pkgs first then main). **Auth = npm
  Trusted Publishing (OIDC), token-less** (owner: "I have npm connected to
  gh"): job has `id-token: write`, upgrades to npm ≥ 11.5.1 (node 22 ships
  10.x), and `npm publish` exchanges the OIDC token for a short-lived
  package-scoped credential + auto-provenance — NO `NPM_TOKEN` secret. **Owner
  must configure a Trusted Publisher on npmjs.com for ALL FIVE package names**
  (`@vzn/vx` + the 4 `@vzn/vx-<target>`), each pointing at this repo +
  `.github/workflows/npm.yml`, else the un-configured ones 403.
  **Verified end-to-end locally** (linux-x64): built
  the binary, generated the tree, simulated the installed node_modules layout,
  ran `node launcher.mjs --version` → execs the binary (`vx 0.0.0`); removed the
  platform pkg → launcher fell back to `bun src/bin.ts` (`vx 0.0.0-test`).
  `dist/` is gitignored (108MB binary + tree never committed). Docs:
  README + docs quickstart lead the install with `npm install -D @vzn/vx`
  (binary, no Bun) beside the curl script. **Owner TODO before first publish:**
  add the `NPM_TOKEN` repo secret (npm automation token with publish rights to
  the `@vzn` scope). The GH-release binaries in `release.yml` have the SAME
  latent version-stamp gap (they'd embed 0.0.0 unless root package.json is
  bumped) — left as a follow-up; npm.yml handles it for the npm path.

- **2026-07-04**: **CI publishes the `vx-cloud` Docker image to GHCR** (owner:
  "Build docker image into GitHub registry on ci"). New
  `.github/workflows/docker.yml` builds `packages/cloud/Dockerfile` (build
  context = repo root) and pushes to `ghcr.io/<owner>/vx-cloud` via
  `docker/build-push-action` + `metadata-action`. Triggers: push to `main`
  (paths-filtered to `src/**`/`packages/cloud/**`/`scripts/**`/manifests) →
  `latest` + `main` + `sha-<short>`; `release: published` → `X.Y.Z` + `X.Y`;
  `pull_request` → BUILD-ONLY (validates the Dockerfile, no push — a fork lacks
  `packages: write` anyway, and the login/push steps are gated on
  `event_name != 'pull_request'`); `workflow_dispatch`. `permissions:
{contents: read, packages: write}`; login uses the built-in `GITHUB_TOKEN`.
  `linux/amd64` single-arch (fast + reliable; the `bun build --compile` step
  is native-arch — multi-arch would need QEMU/OOM risk); GHA layer cache
  (`type=gha,mode=max`); `concurrency` cancels superseded same-ref runs.
  **Deploy docs updated to lead with the pull**: `self-hosting.md`,
  `deploy/README.md`, and `deploy/docker-compose.yml` now reference
  `ghcr.io/vznjs/vx-cloud:latest` (build-from-source kept as the secondary
  option), matching the owner's "devs won't clone — give them a command to
  run" directive. Also dropped a stale "+ Helm topologies" mention (Helm was
  removed for docker-compose earlier). Docker build NOT exercised here (no
  daemon in this env); the first CI run validates the image end-to-end.

- **2026-07-04**: **Core is provider-neutral — every vx-cloud NAME scrubbed
  from core `src/`; docs get a "Core is provider-neutral" section** (owner:
  "Vx cloud should not be bound in anyway to vx… vx core should not have any vs
  cloud refs. Or needs. It should work fully through a plugin and anyone could
  create a new. Make it also as another section in docs"). Core already had NO
  functional vx-cloud dependency (it never imports `@vzn/vx-cloud`, never reads
  a `VX_CLOUD_*` var — only the provider-neutral Turbo-wire `VX_REMOTE_CACHE_*`
  escape hatch; pinned by `tests/package-boundaries.test.ts`). What remained
  was NAMING. Removed it wholesale: **(1) functional CLI** — the `vx serve`/`dev`
  redirect no longer names `@vzn/vx-cloud` or lists the RETIRED
  `coordinator`/`worker` verbs; it prints a neutral "these come from a PLUGIN,
  not core" hint pointing at the plugin guide (core names NO specific package).
  `help.ts`'s "Execution service + dashboard" section became "Extensions
  (plugins)". `tests/cli.test.ts` inverted: asserts the hint mentions "plugin"
  and does NOT contain "vx-cloud". **(2) comments** — a 13-file comment-only
  scrub neutralized every `@vzn/vx-cloud`/`vx-cloud`/`vx Cloud`/"cloud's X"
  mention in `src/` prose (→ "a plugin", "an out-of-process service", "a
  third-party sink", "a distribution plugin"), keeping generic concept words
  (serve/coordinator/agent/dashboard/remote cache) and the design-doc filename
  citations. Zero code/logic/signature changes; oxfmt clean. **(3) gate fix**
  found along the way — `packages/cloud/src/plugin.ts` had a DEAD `cacheUrlOf`
  referencing the removed `opts.cacheUrl` (leftover from the one-connection
  collapse), a type error keeping `lint`/`ci` RED; deleted (no callers).
  **(4) docs** — new hand-authored `apps/docs/src/content/docs/guides/
extensibility.md` ("Core is provider-neutral") LEADS the "Platform &
  extensions" sidebar section: core is only a task runner (offline, no
  service), the three plugin seams (backend/cache/telemetry) with a mermaid
  diagram, `@vzn/vx-cloud` framed as "just a plugin" + a runnable `acmeCache()`
  bring-your-own example, and "the boundary is enforced" (core depends on
  nobody; the arrow only points plugin→core). Full gate green (core 1048
  pass, cloud 170 pass, lint+oxfmt clean); docs site builds 144 pages, 0
  broken links. No CACHE_VERSION/SCHEMA/behavior change — naming + docs only.

- **2026-07-04**: **Cloud simplified to ONE connection; trust follows the
  token** (owner: "Distributed ci setup and work is too complex. Hosting cloud
  should not be required. And if so it should be easier. We have too many env
  vars. Cache should be internal to cloud. Trusted untrusted should be managed
  by which token we use."). Collapsed the three overlapping connection concepts
  (ingest / remote-cache / service — ~15 client env vars) into a single
  `resolveConnection()` in `packages/cloud/src/plugin.ts`: **`VX_CLOUD_URL` +
  `VX_CLOUD_TOKEN` (+ `VX_CLOUD_PR_TOKEN`)** drives ALL THREE rungs (analytics
  ingest, the remote cache `/v8/artifacts`, distributed execution). **Cache is
  internal to the connection** — connect a cloud and the remote cache is
  automatic; `VX_REMOTE_CACHE_*` survives only as the third-party
  (Turbo-server) escape hatch. The pre-consolidation vars (`VX_SERVICE_URL`,
  `VX_REMOTE_CACHE_URL/TOKEN`, `VX_CLOUD_INGEST_*`, `VX_CLOUD_INSIGHTS_*`) stay
  as resolution ALIASES so nothing breaks, but the documented model is one URL
  - one token. **Trust = which token you present**: the server derives the tier
    from the bearer, so the client just carries whichever token it has. REMOVED
    the client-side `VX_CACHE_TRUST` override, the fork-PR autodetect
    (`detectForkPr`), and `resolveCacheTrust` + the `remoteWrite=false` floor — a
    fork PR simply holds only the PR token (repo secrets aren't exposed to
    forks), so "which token" IS the tier, no flag. Dropped `detectForkPr` /
    `resolveCacheTrust` / `CacheTrust` from the core façade (boundary snapshot
    updated). A plain `VX_CLOUD_URL` connection NEVER moves execution: ambient
    delegation stays opt-in via `vx-cloud connect --delegate`, distribution via
    `VX_CLOUD_DISTRIBUTE`. `cloud()` options collapsed to `url`/`token`/`prToken`
    (+ the Turbo tenancy/signing knobs); `serviceUrl`/`cacheUrl`/`cacheToken`/
    `cachePrToken`/`ingestUrl`/`ingestToken` removed as options (env aliases
    remain). Core `wrapWithRemoteCache` simplified the same way
    (`token = VX_REMOTE_CACHE_TOKEN ?? VX_REMOTE_CACHE_PR_TOKEN`). Full gate
    green: core 1047 pass, cloud 169 pass, lint clean.

- **2026-07-04**: **Docs + website refresh for adopters; deploy simplified to
  docker-compose (Helm removed)** (owner: "Update docs and refresh website...
  Devs should not care about building spa... They won't clone the project.
  Command to run and everything. Also many things are not in docs like agents"
  - "Do we need helm? Why not just docker compose?"). The website's platform
    guides had drifted to a RETIRED architecture. Fixed:
    **(1) Deploy simplification.** Removed the entire stale Helm chart
    (`packages/cloud/deploy/helm/` — its coordinator/worker/HPA templates
    invoked verbs RETIRED by distributed-execution-2026-07; the real server is
    ONE `vx-cloud serve` process and agents are per-CI-job, not pods). Replaced
    with `packages/cloud/deploy/docker-compose.yml` + a rewritten
    `deploy/README.md` (docker run / compose, "same image as a one-container
    Deployment" k8s note, no chart). Dockerfile: dropped the coordinator
    `EXPOSE 5180` + retired-role comments; documented the load-bearing Docker
    interaction — a container must bind `0.0.0.0` to be reachable, which (per the
    security wave) REQUIRES a token, so a real deploy sets BOTH `VX_CLOUD_HOST=0.0.0.0`
    and `VX_CLOUD_TOKEN`.
    **(2) Adopter guides rewritten** (3 parallel developer agents, verified
    against source, disjoint files): `guides/distributed-ci.md` (was
    `vx coordinator`/`vx run --worker`/"v22 hash" — now `vx-cloud agent` DTE:
    session-keyed `{workspaceId, session, commitSha}`, `VX_CLOUD_DISTRIBUTE`,
    same-checkout scoped-`run()` law, outputs via the serve's `/v8` store,
    submitter self-registers, fork-PR `--pr-token` variant); `guides/self-hosting.md`
    (was `vx serve` reading `cache.db` + "no auth" + "build the SPA" — now
    `vx-cloud serve` ingest-store-only + token/loopback/Origin auth + embedded
    dashboard + trust scopes + the Docker host+token requirement);
    `guides/dashboard.md` (embedded in the `vx-cloud` binary, fed by the plugin
    push not `cache.db`, real auth + multi-workspace, corrected diagram).
    **(3) Missing/stale coverage.** `guides/mcp.md` gained the serve `POST /mcp`
    HTTP path (dependency-free, behind the bearer) alongside the core `vx mcp`
    stdio; `introduction.md` de-staled (agents = `vx-cloud agent`, serve =
    `vx-cloud serve`, dashboard "nothing to build"); the sidebar labels + the
    source-of-truth `docs/cli.md` serve section got the new `--host` /
    `--pr-token` / `--allow-origin` flags + the loopback/Origin/trust-scope
    semantics. The core quickstart was already install-and-run (untouched). The
    frozen `docs/design/*-2026-06.md` notes are historical records — left as-is.
    Astro site builds clean (143 pages, 0 broken links). No core/runtime change.

- **2026-07-03**: **Security hardening wave + known-limitations resolved**
  (owner: "Do a full security audit... implement all no questions asked. Make
  sure our cache is segregated to avoid CVE pollutions" + "resolve all known
  limitations"). A 15-agent adversarial audit across five surfaces with an
  independent refute pass drove `docs/design/security-review-2026-07.md`
  (durable record: verified findings, refuted findings, accepted residuals).
  Four gate-green commits, all shipped:
  **(1) Known-limitations** (`aacf6c3`): grandchild orphaning — `execWrap()`
  in `exec/runner.ts` exec-prefixes a single external command so `sh -c` is
  REPLACED by the program (a teardown SIGTERM hits the program, not an
  intermediate shell whose death orphaned its child; also makes resourceUsage
  measure the program). Guards: shell control chars, builtins, and `FOO=bar`
  env-assignment forms keep the shell (compound grandchildren still orphan on
  a hard kill — the residual every non-cgroup runner shares). Frozen TTY
  region — `run.ts` `onSignal` calls `log.runEnd?.()` before killing children.
  **(2) Core security** (`431cf89`): (a) `entry_inputs` stored raw secret env
  values / runtime output / argv in its `hash` column (plaintext secrets at
  rest in cache.db) → capture `xxh3hex(v)` digests instead; the diff only
  needs change-detection, cache KEY folds plaintext separately, NO
  CACHE_VERSION bump. (b) zstd-bomb OOM DoS on a remote hit → cap the
  compressed download (bounded streaming read, aborts past 512 MB in
  `remote-cache.ts`) + the decompressed output (parse the zstd frame's
  declared content size, refuse a bomb before allocating; refuse a sizeless
  frame over the untrusted ingest boundary; 2 GiB ceiling in `cache.ts`;
  degrades to a miss). (c) `extractOutputs` followed a symlinked PARENT dir
  (lexical containment) → realpath the parent, require it inside the realpath'd
  base (`tar.ts`).
  **(3) Serve auth** (`5a30d15`): the two CRITICALS. Serve bound 0.0.0.0 with
  no token by default → unauthenticated LAN RCE via the `run` WS. Bind
  127.0.0.1 by default (`--host`/`VX_CLOUD_HOST`); refuse a non-loopback bind
  without a token. Cross-origin WS handshakes weren't Origin-checked → drive-by
  CSWSH→RCE from any page the dev visits. Gate the run/agent WS upgrades + SSE
  streams on the Origin (no-Origin CLI + same-origin pass; other cross-origin
  browser handshakes 403; `--allow-origin`/`VX_CLOUD_ALLOW_ORIGIN` allow-lists
  a hosted dashboard).
  **(4) Cache trust scopes + immutability** (`24af48f`; design
  `cache-trust-scopes-2026-07.md` Phase 1 — the owner's "segregate the cache"
  ask): the artifact store is partitioned by `<bucket>/<tier>`, both
  SERVER-DERIVED from the token (never a client claim). A trusted token
  reads/writes only `trusted/`; an untrusted (`--pr-token`/VX_CLOUD_PR_TOKEN)
  token reads `untrusted ∪ trusted` but writes only `untrusted/` — so a fork-PR
  poison NEVER feeds a trusted build and untrusted can NEVER write trusted,
  regardless of the key it computes (the GitHub-Actions/Nx/Turbo model,
  server-enforced). `authorized()` returns the `Principal`; the run/agent WS,
  `/v8` handler, and dist-prune all route by it. Artifacts are IMMUTABLE (re-PUT
  of an existing hash → 409). Legacy flat store migrates to `default/trusted/`
  on boot. Client `detectForkPr` (GitHub/GitLab, never throws) +
  `resolveCacheTrust` (`VX_CACHE_TRUST` override → fork detect → trusted) pick
  the token + a `remoteWrite=false` floor for a fork PR without a PR token
  (Nx/Turbo "PR is read-only" default). Mirrored in `cloud()`'s cache rung
  (`cachePrToken`, optional `prToken` per environment). **NO CACHE_VERSION
  bump** — the key never changes, solo-dev local cache byte-identical, only the
  server path + which token writes where moves. Core façade +`detectForkPr`/+`resolveCacheTrust`. **Refuted** (not actioned, refute pass
  found the framing wrong): "content-addressed store never verifies content"
  (hash is a cache key, not a content digest); "self-asserted commitSha"
  (accepted Nx-Agents same-checkout model — per-agent creds tracked as future
  multi-tenant hardening). Full core suite green (bar the known-flaky watch
  e2e — cwd race, passes in isolation), cloud 168 pass / 0 fail.

- **2026-07-03**: **vx agents SHIPPED — session-keyed distributed task
  execution (Nx-DTE equivalent) on the connected serve** (`743aa47`;
  design `docs/design/distributed-execution-2026-07.md`, the review Phase
  4-5 was fenced behind; owner: "continue"). **The correctness law
  (§6):** an agent executes each assignment as a scoped core `run()` of
  the exact task WITH its dep closure — deps restore as warm
  `cache-hit-remote` from the serve's artifact store, so the agent's
  saved key equals the full-run key BY INDUCTION. The
  `excludeDependencies:'all'` alternative is provably wrong (dropping
  dep edges empties the upstream-hash fold → artifacts upload under keys
  no full run derives) — pinned by the §6.3 guard test in BOTH
  directions. **Shape:** serve hosts an in-memory session registry
  (`/v1/agents` WS behind the bearer; sessions keyed
  {workspaceId, session}; commitSha enforced at pairing — mismatches
  refused naming both SHAs; 15-min GC); scheduler store-PRUNES stable
  hashes already in the serve's own artifact store (one local stat —
  warm tasks execute NOWHERE) and reassigns on agent death;
  `vx-cloud agent --url <serve>` = same-checkout contract (dirty tree
  refused; session from VX_AGENT_SESSION > CI env > 'local');
  submission = VX_CLOUD_DISTRIBUTE via the cloud() backend rung, and
  the submitter SELF-REGISTERS as a session agent so zero remote agents
  degrades to a loud local run, never a deadlock; hard gates
  (forwardArgs, dirty tree, non-remote cache policy, persistent) fall
  back local with a reason; outputs materialize on the submitter via
  targeted get+cleanOutputs+restoreOutputs. The ephemeral
  `vx-cloud coordinator`/`worker` verbs + core `workerExecute` are
  RETIRED; protocol-dist v1 (assignment = bare taskId, outcomes =
  OutcomeView). Core façade +deriveStableKeys/+captureGitContext/
  +captureWorkspaceIdentity/+cleanOutputs. **Gotcha for the record:**
  the repo's bare `dist` gitignore/lint-ignore silently swallowed the
  new `packages/cloud/src/dist/` module — `!packages/cloud/src/dist`
  negations added to .gitignore/.oxfmtrc/.oxlintrc. Verified by two
  REAL e2e (serve + two agent subprocesses on same-commit clones:
  placement across both, streamed logs, warm re-submission assigns
  nothing, kill-mid-task reassigns). Repo suite 1206 pass / 0 fail. No
  CACHE_VERSION/SCHEMA bump. KNOWN-OPEN (§13): remote agents run
  live-eval + full cache policy (per-request policy = small protocol
  addition); Helm chart still names the retired verbs; cross-run
  queueing/fairness + autoscaling remain non-goals.

- **2026-07-03**: **The connected-server phases shipped — telemetry v2
  workspace identity, multi-workspace serve, delegation self-ingest, MCP
  endpoint, unix socket, artifact store** (owner: "continue until whole my
  vision is finished"; executes dev-flows-ci-agents-2026-07.md §3 + §10 and
  cloud-client-server Phase 2-3). **(1) Telemetry v2** (`9529c78`):
  `TELEMETRY_SCHEMA_VERSION` 1→2; `RunContextRecord` gains
  `workspaceId`/`workspaceName` — id = xxh3 of the NORMALIZED git remote
  from `git config --get remote.origin.url` (NOT `remote get-url`, which
  applies insteadOf rewrites and would split mirrored checkouts; ssh/https
  forms of one repo converge); no remote → salt persisted at
  `.vx/workspace-id`. Captured only when a telemetry consumer exists.
  New `RunOptions.telemetrySinks` (additive observe-only embedder seam;
  undefined = zero cost). **(2) Multi-workspace serve** (`60a501a`):
  IngestStore = one core Cache per workspace at `<dir>/<workspaceId>/` +
  versioned workspaces.json manifest (path-token-validated ids; legacy
  single-store dir migrated on boot WITH the WAL/SHM sidecars — they're
  load-bearing); `?ws=` on every /v1 analytics route (unknown → 404),
  token-gated `/v1/workspaces`, `/v1/meta` count-only field; un-scoped
  default = sole workspace, else genuine 'default', else most-recently-seen
  (a fresh dashboard never opens onto an empty synthetic store). Delegated
  runs SELF-INGEST via an option sink — the audit's "dashboard misses the
  runs the server executed" gap closed. UI workspace switcher (hidden at
  ≤1 workspaces); page loader keyed on origin|token|workspace fixed the
  latent no-refetch-on-origin-switch bug. Cloud tests pin
  VX*CLOUD_SERVE_INFO (test serves no longer clobber the real
  advertisement). **(3) Serve platform** (`bf0a5cc`): `POST /mcp` —
  dependency-free MCP (JSON-RPC 2.0, protocol 2025-03-26) behind the
  bearer, 7 tools as thin adapters over the existing metrics queries (AI
  agents connect to any serve, local or remote); `serve --socket` /
  VX_CLOUD_SOCKET — second unix-socket listener (0600 = the auth; socket
  requests bypass the token; plugin push prefers the advertised socket,
  TCP fallback); `/v8/artifacts/:hash` — the Turbo wire RemoteCache
  already speaks, flat-dir atomic storage + x-artifact-tag sidecar
  (signing verifies end-to-end client-side; serve never holds the key),
  `/v1/meta` advertises `artifacts:true`, and cloud()'s cache capability
  gains the environment rung (lazy one-shot /v1/meta probe, memoized;
  explicit VX_REMOTE_CACHE*\* always wins) — **`vx-cloud connect` is now
  one-URL analytics + remote cache**, the Tier-B CI story. All verified
  live (MCP handshake/tools/401, socket-vs-TCP auth split, artifact
  round-trip, real run e2e miss→upload→wipe→remote-restore). Repo suite
  1192 pass / 0 fail. Zero core changes beyond (1); no
  CACHE_VERSION/SCHEMA bump. KNOWN-OPEN → roadmap: serviceBackend still
  dials TCP only (socket rung for delegation is a natural next
  increment); artifact GETs carry no x-artifact-duration (a .duration
  sidecar is a cheap follow-up); persistent coordinator + vx agents
  (Phase 4-5) remain fenced behind their own design reviews.

- **2026-07-02**: **Full consulting engagement — audit, docs unification,
  client/server architecture, core fixes, UI stabilization** (owner: "review
  all the code from 1st June. Unify whole documentation, document issues,
  arch drifts, propose better changes… vx cloud needs to work like Arcane
  (docker): a client that connects to a server, local or deployed…
  flexible remote and local… redo UI… performance is still the king…
  extensible with plugins like vite", then "many workspaces… CI like nx
  agents… figure out whole dev flows", then "projects run tasks or
  schedule tasks… vx-cloud agent registers with workspace and context id…
  like DTE in NX… Unix socket like docker… AI agents should easily
  connect"). A 7-area parallel audit (git history, top-level docs, module
  docs, core arch, cloud arch, UI/UX, tests; ~100 file:line-evidenced
  findings) drove five shipped waves + three design docs:
  **(1) Consulting report** `docs/design/consulting-review-2026-07.md` —
  issues register (~45 items, ~half fixed in-engagement), drift log, flow
  maps, process findings (the #1 cost driver is same-day build-then-delete
  churn: vx-http 54min, Cytoscape 2h, CF stack 6h, dashboard rewritten 4×
  in one day; `predictive` shipped silently), P0-P3 roadmap.
  **(2) Client/server design** `cloud-client-server-2026-07.md` +
  **environments layer SHIPPED**: docker-context-style per-user
  `environments.json` (NOT Arcane's server-side agent registry — vx's data
  flow is client-push), `vx-cloud connect <url>` / `env ls|use|rm` /
  `disconnect`, resolution ladders (opts > env vars > active environment >
  local serve-info > decline; backend delegates only with explicit
  `delegate: true`), serve `--token` auth (SHA-256 + timingSafeEqual,
  `?token=` for EventSource/WS, `/version` moved behind the token),
  pre-auth `GET /v1/meta` identity, WS bearer, UI token + server badge.
  Zero core changes; zero-overhead decline pinned by tests.
  **(3) Core fixes** (all audit-driven): inflight-join no longer reuses a
  stale preProbed miss (joiner now cache-hits the sibling's artifact);
  plugin `teardown()` + `EventSink.flush()` actually invoked at end-of-run
  (crash-isolated, 3s-bounded) — they were documented API core never
  called; LayeredCache remote PUTs made genuinely fire-and-forget
  (bounded background set + `drainUploads()` before close — save() no
  longer holds a worker slot for the upload RTT); `--dry`/`--graph` on a
  remote cache uses a new `CacheLayer.has` existence probe (local SQL +
  remote HEAD) instead of downloading+ingesting every artifact; prune
  IN-lists chunked at 900; stats counts remote hits; persistent-child
  output buffering stops at ready (heap leak); mcp reports real VERSION;
  `telemetry` added to config's structural Plugin type; false cache.ts
  comments deleted; dead surfaces removed (PreparedRun.history,
  RunOptions.report, CAS exports off the façade — modules stay as the
  artifact-store seam); metrics drift-guard test (every query runs against
  a fresh schema in the gate); IngestStore warns loudly on schema-gate
  history wipe (was silent data loss). Also `shouldShortCircuit` now
  gates off LayeredCache (the documented rule the code missed — the
  awaited classify would put N remote GETs on the critical path). Warm
  perf at parity (paired A/B vs pre-wave baseline: median delta +4ms,
  4/4 split). No CACHE_VERSION/SCHEMA bump anywhere.
  **(4) Docs unified**: every top-level doc reconciled against code
  (caching.md had the wrong hash algo + version; comparison/schema
  advertised owner-REJECTED features; architecture.md predated the
  monorepo split), 20 new `docs/modules/` pages (telemetry, plugin,
  events, stable-keys, local-shortcircuit, metrics, lockfile, mcp, …),
  module index regenerated, this file's repo layout rewritten (was
  missing ~25 shipped files).
  **(5) UI stabilized, NOT rewritten** (5th-rewrite temptation explicitly
  rejected): capabilities signal gates hosted-mode surfaces behind honest
  hints (was fake "no data"); run detail gained the INVOCATION header
  (branch/commit/dirty/CI/tags/policy/workers/command); error+loading
  states everywhere; compare renders negative deltas; cockpit shows
  predicted hit/miss chips on queued cards + solid-store log accumulation
  (no per-chunk record clone); IA: cockpit is home with a colocated
  workspace, hosted lands on Runs, nav Run-first; ~200 LOC dead code
  removed. Verified over Playwright: every route + live run + ingested
  run detail/compare, 0 console errors.
  **(6) Dev-flows + CI design** `dev-flows-ci-agents-2026-07.md`:
  workspace identity as TELEMETRY_SCHEMA_VERSION 2 (stable id from git
  remote; server stores + UI switcher keyed by it — the "many workspaces
  on one serve" keystone), CI tiers (A: env-var ingest works TODAY; B:
  one-URL connect after the serve-hosted artifact store; C: **vx agents**
  = Nx-DTE-style session-keyed distribution on the existing
  coordinator/worker skeleton — same-checkout contract like real Nx
  Agents, NO input shipping, outputs propagate between agents via the
  shared cache, registration keyed {workspaceId, session, commitSha},
  the submitting runner self-registers as an agent so local+remote mix),
  full dev-flow catalog, unified phasing. Addendum (owner refinement):
  run-vs-schedule lands on the existing RunBackend seam (no per-task
  `schedule:` field); unix-socket transport as the hardened local option
  (browser UI keeps TCP); **MCP on the serve** as the AI-agent control
  plane (thin adapter over /v1, Phase 2, independent). KNOWN-OPEN handed
  to the roadmap: workspace identity (next increment), delegation
  self-ingest (needs the one core `RunOptions.telemetrySinks` decision),
  serve-hosted artifact store (Phase 3 — the highest-value remote piece),
  isOutputsCurrent content hash, output-test repin churn, test
  serve-advertisement clobbering (unpinned VX_CLOUD_SERVE_INFO).

- **2026-06-28**: **Stable local cache hits restore AHEAD of their deps —
  two-tier scheduler** (owner saw `@vzn/vx-docs#build` waiting on
  `@vzn/vx-docs#import` though build was a warm hit: "it should know right
  away if it can be used from cache or not… restoration should always run
  first no matter of order. we know right away what can be restored, they
  should not fall into topology" + "prioritize running cache misses though,
  only if required or free workers add cache restores" + "this should be
  actual faster not slower"). `dependsOn` is an ordering gate, so a
  dependent couldn't restore until its upstream finished RUNNING — but a
  STABLE-key task's key is provably independent of any upstream's OUTPUTS,
  so its cache hit is knowable up front and its restore needs none of the
  deps' output. New up-front CLASSIFY (`src/orchestrator/
local-shortcircuit.ts`): derive every stable-key, cacheable, local-read
  task's key (reusing the run's `hashCache` memo) and probe `cache.get`
  ONCE → a `preProbed` map (hits AND stable misses) + a `restoreTier` set
  (confirmed hits). **Two-tier scheduler** (`graph/scheduler.ts`): two
  ready queues — restore-tier tasks are ready IMMEDIATELY (bypass the
  dep-gate, bypass the failed-dep→skip check — their key is dep-success-
  independent) at LOW priority (`restoreReady`); everything else is
  exec-tier, dep-gated, NORMAL priority (`execReady`). `takeReady` drains
  execReady FIRST, so cache MISSES own the worker pool and restores only
  backfill idle capacity — exactly the owner's "misses first, restores
  backfill" rule. **Probe reuse:** `execute-task.ts` consumes `preProbed`
  (extracted `restoreHit`), so the up-front probes ARE the probes execute()
  would have done, hoisted — no double work (the double-probe is what
  tanked the reverted `classify.ts`, +57%). Every task still flows through
  execute() so logger output is unchanged. **Safety:** only stable-key
  tasks classified (`stable-keys.ts` `dependsOnSiblingOutputs` — a same-
  project upstream with declared `outputs.files`, or a `workspaceFiles`
  overlap, makes the key preliminary → unstable → stays lazy/dep-gated); a
  graph declaring `outputs.workspaceFiles` (boundary-ignoring) disables the
  restore tier graph-wide (probe reuse still applies); gated on
  `localRead` + ≥1 dep edge; NOT for LayeredCache runs (remote-prefetch
  owns those); never throws (degrades to the normal schedule). `deriveStableKeys`
  factored out of `remote-prefetch.ts` so the two callers can't drift on
  the stability gate. **No CACHE_VERSION/SCHEMA bump** — key derivation +
  artifact bytes untouched; only WHEN a restore fires changed. **Measured
  (A/B on vs off, git-stash toggle):** mixed workload (a slow uncacheable
  upstream feeding many stable cached downstream tasks — the docs case)
  488ms → 456ms (**−6.6%**); warm all-hit at **parity** (paired/
  interleaved bench cancels VM drift: median delta within noise, 6 reps
  faster / 6 slower — there are no misses to overlap, so parity is the
  ceiling and the hoisted classify costs nothing net). The naive all-ON-
  then-all-OFF bench had shown a phantom +2.9% that was pure machine drift.
  Files: `src/orchestrator/{stable-keys,local-shortcircuit,run,execute-task,
remote-prefetch}.ts`, `src/graph/scheduler.ts`, `src/cache/index.ts`
  (export `CacheEntry`); tests `tests/local-shortcircuit.test.ts` (7 e2e:
  cross-project restore-tier correctness, codegen-consumer stays exec-tier,
  workspace-outputs disables tier, --no-cache no-probe, no-double-probe =
  exactly 2 `Cache.get` for 2 warm tasks, restore-tier hit stable even when
  a dep FAILS, flat graph), `tests/scheduler.test.ts` (+4 two-tier). Design
  `docs/design/local-cache-shortcircuit-2026-06.md`.

- **2026-06-28**: **Run graph redesigned as a staged, Linear-style flow —
  REVERSES the Cytoscape adoption** (owner: "graphs are super ugly, there were
  so nice Linear style now they are shit. they need to simulate stages of runs
  with marked bottlenecks times etc ram cpu"; chose "Staged DAG (columns)" via
  AskUserQuestion). The canvas-rendered Cytoscape graph looked generic and
  off-theme (canvas can't pick up the dashboard's gradients/typography) and
  showed no metrics. Replaced with a CUSTOM DOM + SVG **staged DAG**
  (`components/RunGraph.tsx` rewritten; `cytoscape`/`cytoscape-dagre`/
  `@types/cytoscape` removed — embedded SPA 780 KB → 313 KB / 237 → 85 KB
  gzip). Tasks lay out in left-to-right STAGES (topological waves via
  `run-graph-layout.ts` `layoutStages` — longest-path depth); each stage column
  has a header with its parallel wall-time. The BOTTLENECK (critical path)
  glows amber — cards get a ring + a flame marker, edges thicken. Every card
  shows duration + CPU% + peak RAM (from recorded rows on run-detail; from live
  `task:complete` cpuMs/peakRssBytes in the cockpit — `RunConsole` now captures
  both). Linear polish: gradient cards, status rail, hover lift, mono type;
  scroll-to-pan + a zoom control (no drag — positions are meaningful in a
  staged layout). Groups stay dashed folders (the groups-as-pending fix holds).
  Deterministic fixed-grid layout → edges drawn from computed coords, no DOM
  measurement; status is plain reactive props so live ticks repaint in place.
  **UnoCSS gotcha (again):** status classes are LITERAL strings in a state→class
  map (+ safelisted) so the static extractor emits them — never `border-${x}`.
  Verified e2e over CDP (temp workspace, diamond + two groups): stages, the
  bottleneck glow, CPU/RAM chips, the cache-hit blue overlay on run-detail; 0
  console errors (screenshots confirmed). Core untouched; cloud-dashboard only.

- **2026-06-28**: **Advertise the serve at a per-user (machine-level) path so
  it's found from ANY workspace** (owner: "no serve.json, nothing guarantees vx
  cloud will run from any workspace"). The serve advertisement lived at
  `<workspaceRoot>/.vx/serve.json`, so a `vx run` only discovered the local
  serve when it shared that exact root — no guarantee from another workspace.
  New light `packages/cloud/src/serve-info.ts` (`serveInfoPath` /
  `readServeInfo` / `pidAlive`) puts ONE per-user advertisement at
  `$XDG_RUNTIME_DIR/vx-cloud/serve.json` (else a per-uid temp dir;
  `VX_CLOUD_SERVE_INFO` pins an exact path / used by tests). A `vx run` in any
  workspace now finds it, and the deterministic serve port means there's only
  ever one local serve. Shared by `serve.ts` (writes it), `backend.ts`
  (delegation discovery — was `serveInfoPath(findWorkspaceRoot(cwd))`) and the
  `cloud()` plugin (telemetry push), keeping the lean `@vzn/vx-cloud/plugin`
  import free of the service layer. The plugin push also now ignores a STALE
  advertisement (`pidAlive` false) so a serve that died without cleanup doesn't
  cost every run a swallowed POST. A remote/Docker serve isn't advertised here —
  that uses explicit `VX_CLOUD_INGEST_URL` / `VX_SERVICE_URL`, which always
  wins. Also fixed all 8 oxlint `no-unused-vars` warnings repo-wide (zero
  warnings now).

- **2026-06-28**: **Local serve port is now DETERMINISTIC — same URL across
  restarts, override via `VX_CLOUD_PORT`** (owner: "locally we should use same
  port unless env var specified"). REVERSES the earlier "fall back to an
  ephemeral port when 4321 is taken" rule — that silent fallback was exactly
  what made the dashboard URL move between restarts. Port resolution is now
  `--port` > `VX_CLOUD_PORT` > `DEFAULT_SERVE_PORT` (4321), bound exactly; a
  busy port surfaces a clean error ("free it, or pick another with --port /
  VX_CLOUD_PORT") instead of moving on its own. The stable-default POLICY moved
  to the CLI (`resolveServePort` in `serveCmd`); `startServe` is now
  mechanism-only — it binds exactly the port passed, or an ephemeral one when
  none is (tests / embedders), so test serves never contend for 4321 (no test
  asserted the default was 4321; they read the chosen `server.port`). New
  `VX_CLOUD_PORT` env + help text + `resolveServePort` unit tests
  (default / flag-wins / env-override / empty-env / malformed). The api.ts SPA
  default origin (`http://localhost:4321`) and the deterministic default now
  agree again. Verified: A on default → 4321; a 2nd default serve → clean bind
  error (no move); kill + restart → 4321 again; `VX_CLOUD_PORT=4399` → 4399;
  malformed env → invalid error. Files: `packages/cloud/src/cli/serve.ts`,
  `packages/cloud/src/cli/bin.ts`, `packages/cloud/tests/serve.test.ts`.

- **2026-06-28**: **Run DAG rendered with Cytoscape (interactive) + added to
  run-detail; groups no longer render as "pending"** (owner: "we should have
  run graphs like in run section. the graph is wrong, shows groups as pending.
  use some good library for flows visualization where I can click on items see
  details move around etc"). Replaced the hand-rolled SVG/Sugiyama layout
  (`run-graph-layout.ts`, deleted) with **Cytoscape.js + cytoscape-dagre** —
  a framework-agnostic flow lib (mounts into a div, so it works under Solid)
  with pan/zoom/drag/click built in. ONE reusable `components/RunGraph.tsx`
  primitive drives both surfaces. **Reactivity model that matters:** the
  STRUCTURE (node set + edges) is rebuilt + re-laid-out ONLY when it changes
  (a structure-signature guard short-circuits before `cy.elements().remove()`),
  so live status ticks update per-node color/duration in place via `cy.batch`
  WITHOUT disturbing the user's pan/zoom/drag; selection + critical-path
  classes update in place too. Theme colors are read from the CSS `--token`
  RGB-channel vars at mount (Cytoscape paints to canvas, so it needs real
  rgba(), not UnoCSS classes). **Groups-as-pending fix:** umbrella tasks
  (`isGroup`, no exec) are forced to a `group` display state — a dashed folder
  with no status color — instead of inheriting the `queued`/pending look they
  could never leave (groups emit no task events). **Run-detail graph** (new
  `RunGraph` json-render catalog component + a Graph card in `runDetail.json`):
  rebuilds the DAG from the workspace via the existing `/v1/graph` (a colocated
  `planRun`) using the recorded task ids, then overlays each task's recorded
  status/duration (a cache-hit task renders blue, etc.); clicking a node writes
  `/selectedTask` (same binding the Flamegraph + Facts panel use). Degrades to
  a clear "start vx-cloud serve in the project" hint when served with no
  colocated workspace. **Deliberately NO core change:** edges are reconstructed
  from `/v1/graph` (an already-sanctioned colocated live feature), so no
  telemetry-contract field, no schema bump, and ZERO run hot-path cost — the
  perf rule holds. Cloud-dashboard only; the core `vx` binary is untouched. The
  embedded SPA grows to ~780 KB / 237 KB gzip (the Cytoscape runtime — the cost
  of a real flow library), rebuilt into the committed `packages/cloud/ui/dist`.
  Deps added to `packages/cloud/ui` ONLY (`cytoscape`, `cytoscape-dagre`,
  `@types/cytoscape`); frozen install re-resolves clean. Verified e2e over the
  Chrome DevTools Protocol in a temp workspace with a real diamond + two group
  tasks: cockpit ran `ci` (4/4 passed) with `check`/`ci` drawn as dashed
  folders (not pending) and the critical path lit; run-detail rendered the
  reconstructed graph with the cache-hit task overlaid blue; 0 console errors.
  (Screenshots confirmed visually.)

- **2026-06-28**: **`cloud()` auto-detects a local `vx-cloud serve` for the
  telemetry push** (owner: "we should auto detect vx cloud running locally").
  The `cloud()` plugin's telemetry capability now, with no explicit ingest
  config, reads the `.vx/serve.json` a `vx-cloud serve` advertises (origin +
  pid) and pushes the `RunSummaryRecord` to `<origin>/v1/ingest` — so a local
  dashboard is zero-config: start the serve, and every `vx run` in the
  workspace shows up. Explicit config (`ingestUrl` / `VX_CLOUD_INGEST_URL`)
  still WINS, so a remote/Docker cloud takes precedence over local auto-detect;
  no serve + no env → decline, so a plain run is unaffected (perf rule holds —
  the detect is one fs read inside the telemetry-sink construction, which only
  happens when a telemetry plugin exists). **Pid-guard:** never push to a serve
  running in THIS process (serve.json records the serve's own pid) — that is
  the serve executing a delegated run, and POSTing to itself mid-request would
  deadlock. Also hardened both telemetry flush paths (cloud ingest + otel
  export) to a clearable `AbortController`+`setTimeout` instead of
  `AbortSignal.timeout`, whose internal timer is not unref'd and would keep the
  CLI alive for the full timeout after the POST already resolved (a phantom
  end-of-run hang). The backend-routing e2e removes the in-process serve's
  serve.json before its `spawnSync` (which blocks the test event loop, so the
  in-process serve can't answer an auto-detected POST back to it — a test-only
  artifact); the push path is covered by a dedicated test with a separate,
  responsive server. Files: `packages/cloud/src/plugin.ts`,
  `packages/vx-otel/src/sink.ts`, `packages/cloud/tests/plugin.test.ts`.

- **2026-06-28**: **Dashboard moved INTO the cloud package — `apps/ui` →
  `packages/cloud/ui`, so `@vzn/vx-cloud` is self-contained** (owner: "why do
  we need apps/ui? cloud should be self contained"). The dashboard SPA was a
  separate top-level app (`@vzn/vx-ui` in `apps/ui`) that cloud declared as a
  `workspace:*` dep and embedded — so cloud reached OUTSIDE its directory for
  its own UI. Now the SPA lives at `packages/cloud/ui` (git-moved), and:
  `ui-asset.ts` embeds it via a RELATIVE `import '../../ui/dist/index.html'
with { type: 'file' }` (no `@vzn/vx-ui` resolution); cloud's package.json
  DROPS the `@vzn/vx-ui` dependency and adds `ui/dist` to `files` (the
  published package carries the dashboard). `packages/cloud/ui` is registered
  as a nested workspace member (explicit entry in the root `workspaces`
  array — Bun's `packages/*` glob doesn't match one level deeper) so its Vite/
  Solid build deps install; its `vx.config.ts` import switched from the
  now-wrong `../../src/index.ts` to the bare `@vzn/vx`. The SPA's Solid JSX is
  kept OUT of the core gate exactly as `apps` was — added `packages/cloud/ui`
  to `.oxlintrc.json` + `.oxfmtrc.json` `ignorePatterns` (the
  `package-boundaries` guard's `*/src` glob doesn't reach `cloud/ui/src`, so
  no false violations). Rewired the build pointer (`vx.config.ts` `build.ui`:
  `cd packages/cloud/ui && bun run build` + workspaceFiles inputs), the dist
  whitelist (`.gitignore` + cloud `.dockerignore`: `apps/ui/dist` →
  `packages/cloud/ui/dist`), the Dockerfile/deploy/README/serve comments, and
  the self-hosting/dashboard guides. `@vzn/vx-ui` keeps its name (so
  `bun run --filter @vzn/vx-ui build` still works); only its LOCATION changed.
  `apps/` now holds only the docs site. Verified end-to-end: the SPA rebuilds
  at the new path (vite, 140 modules → single-file dist), `bun build --compile`
  embeds it (187 modules → standalone binary) and the COMPILED binary serves
  the dashboard at `/` + SQLite `/v1/*` from a bare non-workspace dir; frozen
  install (`--frozen-lockfile`) re-links cleanly; full root suite 1088 pass /
  0 fail; dogfood `vx run ci` exit 0. The committed dist is byte-unchanged
  (restored after the build-verify) so this commit is a pure move + rewire.

- **2026-06-28**: **vx-cloud is a STANDALONE, independent service — fed only
  by the plugin push, never reads vx's cache.db; vx-http dropped; plugins
  declared in `vx.workspace.ts`** (owner: "remove vx-http for now, just cloud
  and otel. cloud should be self contained. add them to vx workspace as
  plugins. vx cloud should never use local vx db — vx is independent, vx cloud
  can be deployed elsewhere with no access to it; it should use a plugin to
  intercept things from vx"). REVERSES the L2 decision from the entry below
  (local serve reading `cache.db`). **(1) `@vzn/vx-http` deleted** — only
  `@vzn/vx-otel` + `@vzn/vx-cloud` remain. The canonical
  `TelemetryRecord`/`RunSummaryRecord` contract (Unit A) is unchanged; cloud
  speaks it directly (self-contained, no vx-http dep). **(2) vx-cloud never
  opens a workspace `cache.db`.** `serve` reads `/v1/*` ONLY from its own
  SQLite `IngestStore`, populated by the `cloud()` plugin's push to
  `POST /v1/ingest`. Removed the `source` switch / `--source` flag /
  `new Cache` / `loadWorkspaceConfig` from `startServe`; it is ingest-only and
  needs no workspace, so vx-cloud runs anywhere (a remote box with no access
  to the machine that produced the runs). The live-cockpit `/v1/graph` (a
  colocated `planRun`) degrades to a clean error with no workspace; the WS
  run-delegation is unchanged (executes on the client's cwd). **(3) `otel()` +
  `cloud()` declared in a new root `vx.workspace.ts`** —
  `defineWorkspace({ plugins: [otel(), cloud()] })`. Both DECLINE with no
  config (otel without `OTEL_EXPORTER_OTLP_ENDPOINT`; cloud's telemetry
  without `VX_CLOUD_INGEST_URL`, backend without `VX_SERVICE_URL`, cache
  without `VX_REMOTE_CACHE_URL`), so declaring them is **zero-overhead by
  default** — measured `vx run` startup unchanged (~116ms with vs without).
  Two moves keep it free: `cloud()`'s `backend` DECLINES when no service is
  configured (no serve-discovery probe), and the heavy service machinery
  (backend → serve/dev) loads LAZILY (dynamic `import('./cli/backend.js')`
  inside `backend()`), so the plugin module is light; `vx.workspace.ts`
  imports `cloud` from a new `@vzn/vx-cloud/plugin` subpath (NOT the `.`
  index, which re-exports the whole service layer). **(4)
  `scripts/link-self.ts`** now also symlinks every `packages/*` member into
  `node_modules/@vzn/<name>` (Bun only auto-links members some package.json
  depends on; these integration packages are depended on by nobody), so the
  bare `@vzn/vx-otel` / `@vzn/vx-cloud/plugin` imports resolve under a frozen
  install. **(5) Docker** default CMD is now `serve --ingest-dir /data` (a
  `/data` VOLUME) — the image is one Bun + SQLite-ingest + UI process fed by
  pushes. Accepted consequence (= design's option c): cache-ENTRY inventory +
  the full input-fingerprint diff are NOT in vx-cloud (they live in the local
  `cache.db`'s `entries`/`entry_inputs`, which cloud never reads);
  `/v1/explain` + `/v1/diff` return graceful empties. Tests: serve metrics
  suite reworked from "delegate a run to populate cache.db" to "POST a
  RunSummaryRecord to /v1/ingest"; ingest standalone-no-workspace test; cloud
  backend-declines-without-config test. Full root suite 1088 pass / 0 fail;
  dogfood `vx run ci` green with the plugins active.

- **2026-06-28**: **Observability + integration architecture — telemetry
  capability + canonical export contract; OTel/HTTP/cloud as plugins**
  (owner: "design some better architecture, extensible and isolated. vx is
  core, exposes API to integrate with but not behavior change. all data
  sent by OTEL or manual API through plugins. vx cloud integrates through a
  plugin"). Design doc `docs/design/observability-architecture-2026-06.md`;
  implemented in four units, all on `main`, full root suite 1100 pass / 0
  fail, dogfood `vx run ci` green. **Unit A (core):** a new observe-only
  `telemetry` capability on `VxPlugin`, cleanly separated from the behavior
  capabilities (`backend`/`cache`). Neutral BY CONSTRUCTION — a
  `TelemetrySink` receives only immutable records and a `TelemetryContext`
  with read-only metadata (no bus, no Cache, no request), so there is no
  API path back into scheduling/caching/exec. New `src/orchestrator/
telemetry.ts` is THE canonical, versioned export contract
  (`TELEMETRY_SCHEMA_VERSION = 1`): `TelemetryRecord` (per-event:
  run.start/task.start/task.log/task.end/run.end) + `RunSummaryRecord`
  (per-run), with `cacheSource` derived ONCE (`deriveCacheSource`) and
  git/CI/host `RunContextRecord` pre-folded — ending the per-exporter
  re-derivation from the rendering-oriented `WireEvent` stream.
  `createTelemetrySource` projects the bus once + fans to sinks under crash
  isolation (a throwing sink is disabled for the run, never propagates);
  `task.log` is OPT-IN via `TelemetrySink.wants` (default excludes it).
  `telemetry-host.ts` consults the capability and — **the perf invariant** —
  returns `undefined` when no sink is contributed, so a run with no
  telemetry plugin (or one whose plugins all decline) adds NO bus
  subscriber AND builds no summary: the hot path is byte-identical
  (`runContextRecord`/`summaryTasks` are allocated only when plugins
  exist). Wired into `run.ts` (consult after the git/CI/host capture,
  before `run:start`; emit the summary + flush at run:end; dispose in
  finally). `eventSink` stays as a back-compat capability. Exports added to
  `src/index.ts` (boundary snapshot +`TELEMETRY_SCHEMA_VERSION`/
  `deriveCacheSource`); `project-loader.ts` plugin validation accepts
  `telemetry`. **Unit B (`@vzn/vx-otel`):** moves OTel OUT of core — deleted
  `src/orchestrator/otel-emit.ts` + its unconditional `attachOtelEmit(bus)`
  in `run.ts`. The new package's `otel()` telemetry plugin maps a run to
  OTLP traces (a `vx.run` root span + `vx.task` children, CI/CD + VCS
  semconv) + metrics, speaking OTLP/HTTP **JSON directly — NO OpenTelemetry
  SDK dependency** (zero-dep, testable here, no SDK-version drift; the
  design's preferred lighter option since the SDK isn't installable in this
  env). **Behavior change (intended de-hardcoding):** `OTEL_EXPORTER_OTLP_
ENDPOINT` alone no longer auto-exports — declare `otel()` in
  `vx.workspace.ts`. The repo sets no endpoint, so its own runs are
  unaffected; no `vx.workspace.ts` was added to the repo (a pointless
  always-declining plugin). **Unit C (`@vzn/vx-http`):** `httpTelemetry({
url })` — the generalized manual-API exporter, POSTs the canonical
  contract; `summary` mode (one `RunSummaryRecord`/run, default) or `stream`
  mode (batched NDJSON/JSON, opt-in `task.log`); Bearer, time-bounded,
  never-fail, idempotent. **Unit D (`@vzn/vx-cloud`):** the cloud plugin's
  `eventSink` (raw WireEvents) becomes a `telemetry` sink POSTing the
  `RunSummaryRecord` to the cloud's `POST /v1/ingest` (options renamed
  `insightsUrl/Token`→`ingestUrl/Token`, env back-compat kept). New
  `IngestStore` = a core `Cache` at a cloud-owned path, so core's runs +
  invocations schema + `recordRunBundle` persist the pushed summary and
  EVERY `metrics.ts` query reads it unchanged (idempotent on runId).
  `serve.ts` gained `POST /v1/ingest` + a `source` switch (`cache` default
  | `ingest`) + `--source` flag: **local serve keeps reading `cache.db`
  directly (zero-config L2, unchanged); hosted serve reads the push-fed
  ingest store**, so core's `cache.db` becomes private to a hosted
  deployment. `InvocationRecord` now public from `@vzn/vx`. Owner decisions
  taken (per the design's recommendations): L2 local-cache.db reader,
  hosted = run/task analytics only (cache inventory stays local), and accept
  the OTel de-hardcoding. The package-boundaries guard generalized to every
  `packages/*/src` (bare `@vzn/vx` only; core imports no sibling
  `@vzn/vx-*`). No CACHE_VERSION/SCHEMA bump — telemetry is a pure
  side-channel of events already emitted. Tests: `tests/telemetry.test.ts`
  - per-package suites (vx-otel 22, vx-http 19, cloud ingest/plugin).

- **2026-06-28**: **Dashboard Tier 3 — Phase B: the input-fingerprint
  diff, invocation context, tags/report, hit split** (read-side over the
  Phase-A schema; parallel agents on disjoint files). Queries
  (`metrics.ts`): `cacheKeyDiff(runId, taskId)` — the Develocity moat,
  resolving a run to its entry hash and anti-joining `entry_inputs`
  against the previous run's to name the exact added/removed/changed
  components (file OID / env / runtime / upstream / package / config /
  forward) with before→after; `getInvocation`; `listInvocations`
  reworked to read the `invocations` header table with branch/ci/tag
  filters (back-compat number arg kept); `getHitRateSplit` + local/
  remote series on stats + trends. CLI: `--tag k=v` (persisted on the
  invocation row) and `--report[=markdown]` (a moon-style per-task table
  to stdout, zero cost when absent). Endpoints (`serve.ts`): a diff
  route, an invocation-detail route, filtered invocations, and a
  cache hit-split route. UI: run-detail "Why did this re-run?" upgraded
  from "hash changed" to the real per-component diff table; Runs page
  gained branch/commit/CI/tags columns; cache + overview show the
  local-vs-remote split. Two integration fixes I made: threaded `tags`/
  `command` through `RunRequest` + the two protocol mappers (so `--tag`
  actually reaches the invocation row — it was being dropped), and fixed
  a PRE-EXISTING `getRun` truncation (it capped at the 500-row
  `listRuns` ceiling, dropping tasks on runs over 500 — so run-detail
  and the diff panel were incomplete on real monorepos; now returns the
  full run, with a 700-task regression test). Verified e2e over the
  Chrome DevTools Protocol against an 800-package workspace with a
  deliberately changed input: the why-card renders the changed file with
  before/after OIDs, the Runs page shows branch/commit/ci/tags, cache
  shows 799 local / 0 remote. No CACHE_VERSION/SCHEMA change beyond
  Phase A. Full suite 1000 core / 1055 root, 0 fail; lint+oxfmt clean;
  dist rebuilt. (The `vx watch` e2e flakes only under heavy machine load
  from leftover test serves and pass clean in isolation on every tree;
  pre-existing, unrelated.) That completes Tier 3.

- **2026-06-28**: **Dashboard Tier 3 — Phase A: schema + recording
  foundation (SCHEMA v22, NO `CACHE_VERSION` bump).** Implements the
  Phase-A slice of `docs/design/dashboard-tier3-2026-06.md` — the durable
  schema everything else reads. Two new SQLite tables. `invocations` is
  one header row per `vx run` (command, requested tasks, compact cache
  policy, concurrency, flow, started/ended, total duration, task/failed/
  hit counts split local-vs-remote, exit_ok, git commit/branch/dirty, ci
  - provider, host/os/arch, vx version, tags JSON). `run_task_inputs` is
    the input-fingerprint moat — one row per cache-key component per task
    per run (kind file/env/runtime/ws-runtime/upstream/package/config/
    forward/workspace, name, hash), captured for hits AND misses so the
    next run can diff against it. Both added to the schema DROP-gate;
    `SCHEMA_VERSION` rolled v21 to v22 (gate drops + recreates, pre-alpha
    no migration). The CACHE KEY is provably unchanged so `CACHE_VERSION`
    stays v24 — capture is a pure side-channel inside `Cache.key()`. New
    `CacheKeyInput.captureInto` is an optional sink that `key()` pushes
    each folded component into at the same fold sites (file rows reuse the
    already-awaited per-file OID — zero extra hash/stat/IO); a guard test
    proves a task's digest is byte-identical with and without
    `captureInto`. New `CacheKeyInput.upstreamIds` (hash to task id) is
    capture-naming only, never folded. The upstream-id seam:
    `filterUpstreamHashes` now returns `Array<[upstreamTaskId, hash]>`
    (dedup still by hash, the key fold still sorts by hash so derivation is
    identical); its lone caller is `task-hash.ts`, which splits the pairs
    back into `upstreamHashes` + an `upstreamIds` map. `TaskInputComponent`
    type lives in `task-hash.ts`, threaded through `computeTaskHash` via
    `captureInto`. `execute-task.ts` allocates the component array, passes
    it to the hash, and attaches it to the hit + miss outcomes (skipped on
    group/persistent/aborted). `TaskOutcome.inputComponents` is declared
    structurally inline in `scheduler.ts` (graph cannot import
    orchestrator). Recording: `Cache.recordRunBundle({runs, invocation,
inputs})` writes runs + the invocation row + all input rows in ONE
    transaction (one fsync); `InvocationRecord`/`TaskInputRow` types
    exported from cache. `run.ts` captures run context once
    (`run-context.ts`: `captureGitContext` = one git spawn per run behind
    try/catch with each field null-on-fail, `detectCi` over a CI env
    matrix, host/os/arch helpers), builds the invocation + input rows from
    the recorded list, and replaces the bare `recordRuns` call with
    `recordRunBundle`. New `RunOptions.tags`/`.command`/`.report` fields
    (CLI parsing is Phase B3; run.ts reads tags/command into the invocation
    row, defaulting command to `process.argv.slice(1).join(' ')`). Trust
    boundary called out in docs: `run_task_inputs` stores env/runtime
    values verbatim, consistent with cache.db already being a local
    gitignored single-user file; redaction is out of scope. Files: core
    `src/cache/{cache,layered-cache,index}.ts`,
    `src/orchestrator/{task-hash,upstream,execute-task,run,options,
run-context}.ts`, `src/graph/scheduler.ts`; docs `caching.md`,
    `modules/cache.md`; tests `cache.test.ts` (schema-gate recreates both
    tables, key-unchanged guard, captureInto completeness per the fold
    map, recordRunBundle round-trip with a cache-hit task getting input
    rows), `run-context.test.ts` (temp git repo sha/branch/dirty, CI
    matrix, non-git all-null no-throw), `orchestrator.test.ts` (e2e
    invocation row + per-task input rows over a real cache.db, hit
    included). Phase B (queries/endpoints/CLI tags+report/UI) is owned by
    other agents and never touches these files.

- **2026-06-28**: **Tier 3 Phase A — warm-path redesign (`run_task_inputs`
  → `entry_inputs`; capture is miss-only; ≤1 git spawn).** The first
  Phase-A cut above regressed WARM `vx run` ~21% (457ms baseline → 560ms
  on an 800-pkg/1600-task workspace) — it persisted per-task input rows
  keyed by `(run_id, task_id)` on EVERY run (incl. all-cache-hit warm
  runs, ~8000 INSERTs/run via `recordRunBundle`) and allocated +
  populated the `captureInto` component array on the HIT path too. Owner
  hard rule: **Tier 3 must not impact run performance.** Redesign,
  measured back to parity (warm median ~465-485ms vs an on-this-machine
  baseline of ~451-464ms — within noise; the regressed cut was 560ms).
  (1) **`run_task_inputs` → `entry_inputs`**, keyed by the cache-ENTRY
  hash (PK `(entry_hash,kind,name)`, FK→entries ON DELETE CASCADE), not
  a run. Written INSIDE the entry-save transaction
  (`writeArtifactAndIndex`) via `INSERT OR IGNORE` — so it persists ONLY
  on a cache miss/save; a HIT never saves, writes nothing; identical
  inputs (same hash) never re-write. DROP-gate drops both legacy
  `run_task_inputs` AND `entry_inputs`. `SCHEMA_VERSION` stays v22
  (uncommitted/unreleased; the bench clears the cache so a fresh gate
  recreates). (2) **Capture is miss-only.** `execute-task.ts` computes
  the PROBE hash with NO `captureInto` (warm path allocates nothing); on
  a miss, a second `computeTaskHash` with `captureInto` runs right before
  `cache.save` — the HashCache memos + gitFilesCache OID map make it a
  fold + array pushes (no re-stat/re-hash I/O), and it runs only where
  the task is about to spawn a subprocess anyway. The components pass to
  `cache.save({ inputComponents })` as `{entryHash,kind,name,hash}` rows.
  (3) **`recordRunBundle({runs,invocation})`** no longer takes/writes
  `inputs` — per-run recording is runs + the invocation header only.
  `run.ts` drops the per-task component loop. (4) **`TaskOutcome.
inputComponents` DROPPED** (the save reads components directly; no
  outcome plumbing). (5) **Git context cheapened**: `captureGitContext`
  is ONE spawn (`git rev-parse HEAD --abbrev-ref HEAD` → commit+branch);
  `dirty` is no longer probed there — it reuses the `git status
--porcelain` the `GitFilesCache` populate ALREADY runs for input
  enumeration, surfaced via new `GitFilesCache.worktreeDirty` and passed
  into `captureGitContext(root, dirty)`. Net ≤1 extra git spawn/run,
  still behind try/catch. The cache KEY is still byte-identical
  (`captureInto` remains a pure side-channel of `key()`; the
  key-unchanged guard test passes) — no `CACHE_VERSION` bump. Tests
  updated: `cache.test.ts` (entry_inputs populated on save, a
  warm-run-writes-nothing assertion, idempotent re-save adds nothing,
  schema-gate recreates `entry_inputs`), `orchestrator.test.ts` (miss
  writes entry_inputs reachable via `runs.hash`; warm hit adds zero
  rows but still records its invocation header), `run-context.test.ts`
  (one-spawn commit+branch, dirty passes straight through). Docs
  (`dashboard-tier3-2026-06.md` persistence + query sections,
  `caching.md`, `modules/cache.md`) updated to `entry_inputs` +
  `runs.hash → entry_inputs[entry_hash]` diff. Phase B's future
  `cacheKeyDiff` reads `entry_inputs` by the two runs' task hashes (not
  built). Files: `src/cache/{cache,inputs,layered-cache}.ts`,
  `src/orchestrator/{execute-task,run,run-context,task-hash,upstream}.ts`,
  `src/graph/scheduler.ts`. Full root `bun test` 1009 pass/0 fail; CI
  gate green.

- **2026-06-28**: **Dashboard competitive upgrade — Wave 2: run
  comparison + cache-entry inventory** (continues the competitive-
  research arc; see `docs/design/dashboard-competitive-2026-06.md`). Two
  parallel developer agents, disjoint file ownership. (C) **Run
  comparison** — the Develocity/BuildBuddy "diff two runs" marquee, MVP
  = a run vs its immediately-previous invocation: new core query
  `compareRuns(db, runId)` in `metrics.ts` (resolves the prior
  invocation by `started_at` like `whyDidThisRerun`, emits per-task diff
  rows `{a, b, hashChanged, durationDeltaMs, statusChanged}` + a
  summary), exported through `orchestrator/index.ts` + `src/index.ts`
  (boundary-test snapshot updated); a `GET /v1/compare/:runId` endpoint
  (cloud `serve.ts`, mirrors `/v1/runs/:id`); a `/#/compare/:id` view
  with header delta cards (this vs previous total, tone via `gt`) + a
  task diff `DataTable`; a "Compare to previous" entry card on the Runs
  page. (D) **Cache-entry inventory** — the Blacksmith "is my key
  actually hitting?" idea: the Cache page entries table gained a Heat
  column (cold = written but never re-hit since creation, i.e.
  `accessedAt − createdAt ≤ 2s`; stale = not hit in 14d), "Cold entries"
  - "Reclaimable bytes" headline metrics, Age/Last-hit columns, and a
    `vx cache prune` footnote — all via `functions.ts` `$computed` helpers
    reusing the existing `cacheEntries` source + `DataTable` dots (no
    api.ts/data.ts change). Read-only throughout: no CACHE_VERSION/SCHEMA
    bump. Verified e2e over the Chrome DevTools Protocol against the real
    cache.db — both `/#/compare/:id` (real prev-run diff, −179ms delta)
    and the enhanced `/#/cache` render console-clean. Full suite 990 pass/
    0 fail (1007 across 71 files, incl. new metrics + serve compare
    tests); lint+oxfmt clean; dist rebuilt once (298 KB / 82 KB gzip).
    Tier 3 (git/commit context, persisted per-run input fingerprints for
    a full input-file diff, invocation header table + tags, local-vs-
    remote hit-rate split) remains a deferred schema-bump follow-up.

- **2026-06-28**: **Dashboard competitive upgrade — Wave 1: cache-miss
  explainability + critical-path cockpit** (owner: "deep research on nx
  cloud nx and turbo repo and others… what features they have in
  dashboard what they miss how could we make them better and implement.
  Spawn agents parallel"). A six-agent parallel research sweep (Nx
  Cloud, Turborepo/Vercel, Gradle Develocity, BuildBuddy/Bazel, a
  second-tier roundup, plus an inventory of our own UI/serve/metrics/
  cache.db) produced `docs/design/dashboard-competitive-2026-06.md` — a
  ranked Tier 1-3 gap analysis. Key finding: the field's #1 feature
  (cache-miss "why") was already ~80% built in our backend
  (`whyDidThisRerun` + `/v1/why/:runId/:taskId`, and `explainCacheKey` +
  `/v1/explain/:taskId`) with ZERO UI. Wave 1 (two parallel
  developer agents, disjoint file ownership): (A) surfaced both — a
  "Why did this re-run?" card on run-detail (per-task hash-changed +
  reason, prev→current key, via a `runWhy` source that fetches the run
  then fans out `/v1/why` per task) and a "Cache key" card on
  task-detail (the existing `explainCacheKey` wrapper); honest framing,
  no false input-file-diff claim (the full per-file diff needs persisted
  fingerprints, deferred Tier 3). (B) added a `critical-path.ts` util
  (longest-duration dependency chain, O(N+E), cycle-guarded) + a live
  Critical-path panel in the run cockpit: ordered clickable chain with
  the wall-time floor, DAG/flamegraph highlight of the chain, and a
  parallelism callout (observed peak concurrent vs the worker count from
  `run:start.info.concurrency`). Frontend-only; the two endpoints +
  queries already existed, so no `src/`/`packages/` change, no
  CACHE_VERSION bump. Verified e2e over the Chrome DevTools Protocol
  against the real cache.db: both cards render (console clean) and a
  driven live `lint` run computes + renders "These N tasks are your X
  floor" with the parallelism callout. Embedded SPA dist rebuilt once at
  integration (293 KB / 81 KB gzip). Core gate green (952 tests, 0
  fail). NEXT (Wave 2): run comparison (diff two runs), a filterable
  cache-entry inventory with a cold/never-rehit flag, and a local-vs-
  remote hit-rate split. Tier 3 (git/commit context, persisted input
  fingerprints for the full Develocity-grade diff, invocation header
  table + tags) is a deferred schema-bump follow-up.

- **2026-06-27**: **Split fallout fix — `vx serve` launch path restored
  (owner: "it is all not working. seams like you have shitt tests").**
  The core/cloud split removed serve/dev/coordinator/worker from core
  (the owner's explicit "no cli in core"), but left no bridge: typing
  `vx serve --ui` hit a bare `vx: unknown command: serve` and the
  replacement `vx-cloud` was not runnable in-repo (not on PATH, not in
  `node_modules/.bin`). Diagnosis (drove the real app over the Chrome
  DevTools Protocol + a live WS run, not just unit tests): the dashboard,
  `/v1/*` API, `/v1/graph`, and the live cockpit at `/#/run` all WORK via
  `vx-cloud serve` — the break was purely the CLI launch path, and the
  tests missed it because they exercise serve via `startServe`/the bin
  file, never the command a user types nor whether `/` actually serves
  the SPA. Fixes, all additive: (1) core's dispatcher now answers
  serve/dev/coordinator/worker with a clear redirect (run `vx-cloud
<cmd>`, install `@vzn/vx-cloud`, or `bun packages/cloud/src/cli/bin.ts
<cmd>` in-repo) instead of a dead-end; (2) `scripts/link-self.ts`
  postinstall now also symlinks `node_modules/.bin/vx-cloud` → the cloud
  bin and chmods it `0755`, so `bunx vx-cloud serve --ui` works in-repo
  and survives a frozen install; (3) two regression tests that would
  have caught it — core CLI asserts each moved command redirects to
  `@vzn/vx-cloud` (not "unknown command"), and the serve suite asserts
  `GET /` serves the embedded dashboard HTML and a deep app route falls
  through to the SPA while `/health` stays JSON. Verified e2e: launched
  via `bunx vx-cloud serve --ui`, all routes render real data with a
  clean console; root `bun test` 984 pass/0 fail. No core behavior or
  CACHE_VERSION change. Owner's workflow is `vx-cloud serve --ui` now
  (one word longer than before); if that friction isn't wanted, pulling
  serve back into core is the open alternative.

- **2026-06-27**: **Core/cloud split — Phase 4: Docker image + Helm
  chart skeleton for `@vzn/vx-cloud`** (completes the "do all t final
  state" arc; Phases 5–7 stay deferred as future designs per
  `docs/design/core-cloud-split-2026-06.md` §11). Implements §8 ("local
  or hosted — same artifact, roles collapse locally, scale out
  hosted"). New `packages/cloud/Dockerfile` (multi-stage, ROOT build
  context `docker build -f packages/cloud/Dockerfile -t vx-cloud .`):
  build stage `oven/bun:1.3` → `COPY . .` → `bun install
--frozen-lockfile` (runs the `scripts/link-self.ts` postinstall that
  re-creates `node_modules/@vzn/vx → root`) → `bun build --compile
packages/cloud/src/cli/bin.ts` to one standalone binary; runtime stage
  `oven/bun:1.3-slim`, non-root `bun` user, `EXPOSE 4321 5180`,
  `HEALTHCHECK` on `/health`, `ENTRYPOINT ["vx-cloud"]` + `CMD
["serve"]` (role chosen by CMD: serve = collapsed-local, coordinator,
  worker). The SPA is NOT rebuilt — the committed `apps/ui/dist/
index.html` is authoritative (embedded by `ui-asset.ts` at compile
  time), keeping the image lean + the build read-only w.r.t. the repo
  (the `vite build` alternative is documented in a Dockerfile comment).
  `packages/cloud/.dockerignore` keeps the context lean. New Helm chart
  `packages/cloud/deploy/helm/vx-cloud/` (Chart.yaml v2 / values.yaml /
  values-local.yaml + 12 templates): coordinator Deployment+Service
  (+Ingress gated `ingress.enabled`, TLS/wss; readiness `/health`,
  startup `/version`), worker Deployment (`--coordinator <svc-dns>`,
  `terminationGracePeriodSeconds: 120` for the `coord:drain`→`worker:bye`
  graceful drain), worker HPA (CPU target + an optional `queue_depth`
  custom metric, DISABLED by default with a metrics-adapter note), cache
  PVC (gated `cache.backend == fs`; `s3`/`r2` are values knobs riding
  the `CASBackend` interface), insights PVC (gated `sqlite`), secrets,
  serviceaccount, NOTES. A `mode: hosted|local` toggle makes §8.1's
  collapsed-local single `serve` pod a first-class installable mode
  (`serve-deployment.yaml`), not just a documented `docker run`.
  `deploy/README.md` documents both topologies, the exact build/install
  commands, the values knobs, and — honestly — that this is a SKELETON:
  the coordinator is still ephemeral-per-run and the
  `s3`/`r2`/`postgres` and `VX_CLOUD_*` env knobs are forward-looking
  wiring for Phases 5/6 (persistent coordinator, blob-CAS input
  shipping) that the binary does not yet read; defaults
  (`coordinator.replicas: 1`, `cache.backend: fs`) reflect today's
  reality. One tracked-file edit: `.oxfmtrc.json` added
  `packages/cloud/deploy` to `ignorePatterns` (same precedent as the
  `apps` exclusion) so `oxfmt --check .` doesn't try to format the Helm
  template YAML (which contains braces) and fail the gate. No core
  `src/` changes, no tests, no CACHE_VERSION bump — pure additive infra.
  Docker build NOT exercised end-to-end (no daemon/socket in this env —
  verified the Dockerfile by review and the load-bearing `bun build
  --compile` step independently: 183 modules to a runnable binary);
  Chart/values parse as YAML, all 12 templates have balanced braces and
  blocks, worker-deployment renders to valid k8s with defaults. CI gate
  green. Recommend a one-off `docker build` on a host with a running
  daemon before relying on the image.

- **2026-06-27**: **Core/cloud split — Phase 3: the first-party
  `cloud()` plugin** (owner: "cloud should be integrated through a
  plugin… anyone could choose to do differently" → "do all t final
  state"). Implements Phase 3 of
  `docs/design/core-cloud-split-2026-06.md`. New
  `packages/cloud/src/plugin.ts` exports `cloud(opts?:
CloudPluginOptions): VxPlugin` (name `'vzn/cloud'`), declared via
  `defineWorkspace({ plugins: [cloud()] })`, contributing all three
  run-level capabilities against core's shipped `VxPlugin` interface —
  each independent and zero-config via env-var fallbacks: **(backend)**
  returns the cloud `resolveBackend(cwd, undefined, serviceUrl)` —
  delegate to a reachable `vx-cloud serve` (the serve-info discovery
  that LEFT core in Phase 2), else local-dev mirror; always returns a
  backend, so with the plugin present runs behave like pre-split core,
  without it core uses plain `localBackend()`. **(cache)** when
  `cacheUrl`+`cacheToken` (or `VX_REMOTE_CACHE_*`) are set, builds `new
LayeredCache(localCache, new RemoteCache({…}), { policy, onRemoteError
})` faithfully mirroring core's `remote-cache-setup.ts`
  (teamId/slug/signatureKey/timeoutMs honored); declines (`undefined`)
  when unconfigured → core's env fallback still applies. **(eventSink)**
  when `insightsUrl` (or `VX_CLOUD_INSIGHTS_URL`) is set, an
  `InsightsSink` buffers WireEvents and POSTs them as one NDJSON body
  with a Bearer token; declines when unconfigured. **(setup)** validates
  the three URLs are well-formed (boundary check → `UserError`).
  **Lifecycle finding (load-bearing):** core never invokes
  `plugin.teardown()` nor `EventSink.flush()` — `run.ts`'s finally only
  disposes bus subscriptions (`plugin-host.ts`'s `subscribeEventSinks`
  disposer just unsubscribes). So `InsightsSink` self-flushes on the
  terminal `run:end` WireEvent inside `onEvent` (idempotent via an
  `uploaded` guard); `flush()` is kept as a best-effort fallback for a
  future host that does await it. `onEvent` never throws (fetch errors
  swallowed, 5s timeout) — observability can't break a run. **One
  minimal core-of-cloud change:** `packages/cloud/src/cli/backend.ts`'s
  `resolveBackend` gained an optional third `serviceUrl?` param
  (preferred over `VX_SERVICE_URL`/serve-info when set); the existing
  env→serve-info→local fail-safe chain is unchanged. **No core `src/`
  changes, no CACHE_VERSION/SCHEMA bump** — additive in `packages/cloud`
  only (4 files: new `plugin.ts` + `tests/plugin.test.ts`, modified
  `index.ts` exports + `backend.ts` param). Verified: core gate green,
  root `bun test` 979 pass/0 fail (996 across 71 files), cloud
  standalone 48 pass/0 fail (11 new plugin tests), boundary guard
  intact. NEXT: Phase 4 — Docker + Helm skeleton (multi-role vx-cloud
  image; coordinator Service, worker Deployment + HPA, shared CAS).

- **2026-06-27**: **Core/cloud split — Phase 2: `@vzn/vx-cloud`
  extracted to `packages/cloud`** (owner: "I would want a total split.
  2 packages. Vx that is core and vx cloud that is a hosted service
  that orchestrates… cloud should be integrated through a plugin… No
  cli. Vx cloud can have its own cli. Vx is limited… Do it nicely the
  best you can keep separation and plugin flexibility" → "do all t
  final state"). Implements Phase 2 of
  `docs/design/core-cloud-split-2026-06.md` (Phase 1 = plugin
  extension points, `495ac66`). The service layer LEFT core: `cli/
{serve,coordinator,worker,dev,dev-client,ui-asset,ui-server}.ts` +
  `orchestrator/coordinator-prepare.ts` moved to `packages/cloud/src/`,
  rewired to import core via the bare `@vzn/vx` specifier; new
  cloud-only `protocol-dist.ts` (the `WireTaskNode`/`WireOutcome` +
  `worker:*`/`coord:*` JSON-RPC families), `cli/backend.ts`
  (`serviceBackend`/`resolveBackend`/`localDevBackend`), `cli/bin.ts`
  (the `vx-cloud` dispatcher), `index.ts`. **`worker-exec.ts` and
  `metrics.ts` STAYED in core** (exported publicly — they're execution/
  query primitives, not service plumbing). Core `cli/run.ts`'s backend
  fallback is now `() => Promise.resolve(localBackend())` — pure core
  no longer auto-delegates to a running serve (cloud owns delegation in
  Phase 3 via its plugin). Core `vx --help` drops serve/dev/worker/
  coordinator and points at the `vx-cloud` binary; `vx-cloud --help`
  dispatches them. `protocol.ts`/`wire.ts` narrowed to the base
  envelope + event/result/error/run messages; `src/index.ts` expanded
  to the ~80-symbol public API the cloud package consumes (pinned by
  the boundary test). **Load-bearing infra:** Bun can't resolve a
  member's `"@vzn/vx": "workspace:*"` against the root `"."` member, so
  `packages/cloud` does NOT declare `@vzn/vx` as a dep — a root
  `postinstall` (`scripts/link-self.ts`) symlinks `node_modules/@vzn/vx
→ <root>` and cloud imports the bare `'@vzn/vx'` through the root's
  `exports` map; survives `bun install --frozen-lockfile` (CI's
  command, verified). `packages` removed from oxlint/oxfmt
  `ignorePatterns` (cloud is linted/formatted like core; `apps` stays
  ignored for solid-js JSX); `scripts/**` added to tsconfig include.
  Dogfood `test` task switched `bun test tests/` → `bun test ./tests/`
  so the bare substring no longer pulls `packages/cloud/tests/` into
  the core gate (cloud tests run via the package's own `bun test`; a
  clean root `bun test` still runs everything). Tests relocated to
  `packages/cloud/tests/` (serve/distributed/ui-server/dev-hub/wire-
  dist); `tests/package-boundaries.test.ts` added (core never imports
  `@vzn/vx-cloud`; cloud imports core only via the bare specifier). No
  CACHE_VERSION/SCHEMA bump (key derivation + artifact bytes
  untouched). Verified: core gate green, root `bun test` 968 pass/0
  fail (985 across 70 files), core-only 931 pass, cloud standalone 37
  pass, boundaries 3 pass, frozen install re-links + cloud resolves 81
  core exports. **Known follow-up:** the broader `docs/` (architecture/
  cli refs still calling `vx serve` a core command) are stale — a doc
  pass is pending. NEXT: Phase 3 — the first-party `cloud()` plugin
  (`packages/cloud/src/plugin.ts`) contributing backend (submit to
  coordinator + serve-info discovery, moved out of core) / cache /
  eventSink.

- **2026-06-27**: **Dashboard restyle + run-centric cockpit with a live
  task graph** (owner: "make the ui prettier… make it modern" → "focus the
  ui on flows of actual development… from working with nx locally" → "runs
  should be visualized with a graph, each node with status + a progress
  bar… display logs for a task… rerun while in progress" → "let's forbid
  running while in progress for now"). Two strands, owner-picked via
  AskUserQuestion (refined custom theme over DaisyUI — DaisyUI's current
  major is Tailwind-4-first and doesn't plug into our UnoCSS; run-centric
  focus over analytics). **(1) Restyle** (`bfe…`/`73252c0`): modern dark
  look — violet/cyan aurora bg, rounded-xl cards + shadows, pill badges,
  gradient-tinted metric cards, glassy chrome, **detached floating
  sidebar**. Fixed a SYSTEMIC bug found along the way: color tokens were
  hex `var()`s, so UnoCSS silently DROPPED every `/N` alpha
  (`.bg-accent/10 → background:var(--accent)` full-strength) — that's why
  the analytics cards rendered loud/unreadable and the active nav was a
  solid block. Tokens are now RGB CHANNELS exposed via `rgb(var(--x) /
<alpha-value>)`, so opacity modifiers work everywhere (one raw usage,
  StatusDot, wrapped in `rgb()`). **(2) Run cockpit** (`/run`, new
  `RunConsole.tsx`, dedicated interactive route — NOT pure-JSON, since a
  live WS-driven console can't be expressed as data): enter a task → it
  fetches the DAG and opens a WS to vx serve; streamed `task:start/stdout/
stderr/complete` events drive each node's live status, an overall
  progress bar, and per-task log capture (ANSI-stripped). The graph is a
  real DAG — new server endpoint `GET /v1/graph?tasks=…` runs a no-exec
  `planRun` and returns nodes + dependency edges + predicted cache status
  (`src/cli/serve.ts`); the client lays it out layered (longest-path
  layering, `run-graph-layout.ts`) with SVG edges, clickable nodes →
  log panel. A **Graph/Flame toggle** switches the SAME live run between
  the DAG and a flamegraph timeline (reusing the run-detail
  `FlamegraphPrimitive`, fed by client-recorded task start/end timings;
  in-progress bars grow via a 250ms tick; clicking a bar selects the task
  and shows its logs too). **Rerun is FORBIDDEN while a run is in progress** (Run button
  disabled until it finishes) — one run at a time sidesteps the
  output-cleaning race between overlapping different-hash runs (the
  in-flight hash-dedup already makes same-input reruns safe; true
  concurrent safety needs the global scheduler / output RW-locks in
  docs/design/execution-service-2026-06.md — deferred). Nav now leads with
  Run. Verified e2e: triggered a real `lint` run, watched 3 nodes + 2
  edges go success/failed live, progress 2/2, logs streamed on click, 0
  console errors. New `/v1/graph` server test. apps + serve only; core
  cache/exec untouched, no CACHE_VERSION impact.

- **2026-06-27**: **`vx serve` defaults to a STABLE port** (owner: "when
  I stop the server and rerun I get a new port even if old is unused
  why"). Root cause: `startServe` bound `port: opts.port ?? 0`, and port
  0 makes the kernel hand out a fresh ephemeral port every run — it never
  tried a stable default, so the old port being free was irrelevant. Now
  the default is `DEFAULT_SERVE_PORT = 4321` (matching the dashboard SPA's
  own default origin in `apps/ui/src/api.ts`), so the URL is the same
  across restarts. If 4321 is already taken, `startServe` falls back to an
  ephemeral port instead of crashing — UNLESS the user pinned `--port`,
  in which case a busy port surfaces the bind error (explicit intent is
  honored). The big `Bun.serve({...})` literal was factored into a
  `listen(port)` arrow so it can be retried on a second port. `.vx/
serve.json` still advertises the chosen origin for `vx run` delegation.
  Files: `src/cli/serve.ts` (constant + try/fallback), `src/cli/help.ts`,
  `docs/cli.md`. Verified: restart reuses :4321; a second concurrent
  instance falls back to an ephemeral port.

- **2026-06-27**: **Dashboard `jr` folder made idiomatic + interactive
  flamegraph + Runs tab** (owner: "simplify jr code folder... all by the
  book. study each page of docs from gh" → then "flame graph need to be
  more interactive with a timeline and a point of time. i should be able
  to click on tasks to see details in some panel... start end and
  duration. Add Runs tab. cache tab still shows nothing"). Studied the
  json-render docs + Solid example in the `vercel-labs/json-render` repo
  (the site 403s automation; the repo source is authoritative). Key
  finding from the compiled `@json-render/solid`: `defineRegistry` ALREADY
  wraps each component with a reactive `get props()` returning
  `element.props` live AND wraps every element in its own `ErrorBoundary`
  — so the prior `adapt()` + `px` Proxy bridge in `jr/renderer.tsx` was
  redundant double-wrapping. **Refactor (#14):** every catalog component
  is now a native json-render component taking `BaseComponentProps<P>`,
  reading `c.props.X` / `c.children` / `c.emit` live; they register
  DIRECTLY (no adapter). Deleted dead `jr/spec.ts` (nothing imported it;
  the loader uses `nestedToFlat`). Hardened `jr/page.tsx`: it reads
  `res.error` BEFORE the resource value (an errored resource accessor
  re-throws, which blanked the whole page) and wraps render in an
  `ErrorBoundary` — a single failing data source now degrades to a
  per-section empty state. This is the real fix for the **"cache tab shows
  nothing"** class (could not reproduce against the committed dist — 77
  entries + all metrics render — so on the owner's machine it is a stale
  COMPILED binary, which embeds the SPA at `bun build --compile` time;
  rebuild the binary or run from source). Zero behavior change, verified
  e2e across all routes. **Runs tab (#12):** new top-level nav entry +
  `views/runs.json` (summary metrics + sortable/filterable table of all
  invocations, rows link to run detail) + `invocationsAll` source.
  **Interactive flamegraph (#13):** `components/Flamegraph.tsx` gained a
  duration time axis, a point-of-time hover cursor (vertical line + time
  readout), and clickable bars. Clicking writes the task to
  `/selectedTask` via json-render's `useStateBinding` (the idiomatic
  hook-driven path for a self-contained widget); a `visible`-gated detail
  panel in `runDetail.json` binds to it and shows status / started / ended
  / duration / CPU / peak RSS / exit / hash; the selected bar is outlined.
  apps-only; core `vx` untouched, no CACHE_VERSION impact. Commits
  `bfe8142` (refactor + loader) and `547a2cb` (Runs + flamegraph).

- **2026-06-27**: **Granular cache read/write control — 4-axis
  `CachePolicy` replaces the single `noCache` boolean; `--force` is no
  longer an alias of `--no-cache`.** The cache now has four independent
  axes — `localRead` / `localWrite` / `remoteRead` / `remoteWrite` —
  defined in `cache/cache.ts` (`CachePolicy`, `FULL_CACHE_POLICY`,
  `parseCachePolicy`) and re-exported from `cache/index.ts`. Enforcement
  lives INSIDE the cache layers at construction: `new Cache(dir, {read,
write})` gates ONLY the task-artifact `get`/`save` (returns null when
  `!read`, skips the artifact + index row when `!write`) — `recordRun` /
  `stats` / `prune` / `ingest` / hashing are untouched; `LayeredCache`
  takes the full policy and gates its own remote read-through (`get`),
  upload (`save`), and `prefetch` (no-op when `!remoteRead`).
  **Subtle-correctness fix:** when `localWrite` off but `remoteWrite` on
  (`--cache=local:,remote:rw`), there's no on-disk artifact to upload, so
  `LayeredCache.save` packs the tar.zst bytes in memory via the new
  `Cache.packArtifactBytes` (gated on `Cache.localWritesEnabled`) — pinned
  by a new e2e test. `LayeredCache`'s `local` param tightened `CacheLayer`
  → `Cache` (always was). CLI (`cli/run.ts`): three flags resolve a policy
  in precedence order — start all-on → apply each `--cache=<spec>` /
  `--cache <spec>` (comma list of `<layer>:<flags>`, layer∈{local,remote},
  flags⊆{r,w}; a named layer set EXACTLY, unnamed kept) → `--no-cache`
  forces all four false → `--force` forces both reads false (writes kept).
  So **`--no-cache` beats `--force`**, and `--force` now means
  "re-execute everything but still refresh the cache" (writes on → outputs
  ARE cleaned before exec). `RunArgs.noCache` → `RunArgs.cache:
CachePolicy`; `RunOptions.noCache` → `RunOptions.cache?: CachePolicy`
  (default FULL). Threaded end-to-end, REPLACING `noCache`:
  `orchestrator/{options,run,execute-task,plan,remote-prefetch,protocol,
prepare,remote-cache-setup}.ts` + `cli/run.ts`. `execute-task`'s
  `cacheEnabled` became `willRead = cfgCacheable && (localRead ||
remoteRead)` / `willWrite = cfgCacheable && (localWrite || remoteWrite)`;
  the pre-exec output wipe (`cleanOutputs`) now gates on `willWrite` (so
  `--no-cache` still leaves the tree alone, `--force` cleans). `plan.ts`
  predicts misses for a no-read policy (correct — those tasks WOULD
  re-execute). `remote-prefetch` short-circuits on `!remoteRead`. Wire
  `RunRequest.noCache` → `cache?: CachePolicy` (both mappers). **No
  CACHE_VERSION / SCHEMA bump** — key derivation and artifact bytes are
  untouched; only WHEN reads/writes fire changed. Tests: `parseCachePolicy`
  unit suite (cache.test.ts), CLI parser suite for all three flags +
  precedence + invalid specs (cli.test.ts), e2e for `--force`
  (re-execute + refresh → next run hits), `local:r` (hit restores, miss
  doesn't write), `local:,remote:rw` (uploads without a local artifact),
  plus the existing `--no-cache` e2e updated to the renamed field. Docs:
  `docs/cli.md` § Cache control, `docs/caching.md` § Cache policy. 956
  tests pass, lint+format clean.

- **2026-06-27**: **Dashboard UI (`apps/ui`) rewritten on json-render**
  (owner: "completely redo whole ui using https://json-render.dev/" —
  chosen with the tradeoffs made explicit). The entire page layer now
  renders through json-render (`@json-render/solid` + `@json-render/core`)
  instead of hand-written Solid pages — used the intended way: a component
  **catalog** + per-page **data specs** the `Renderer` instantiates. New
  `apps/ui/src/jr/`: `catalog.ts` (`defineCatalog` — the component
  vocabulary), `components.tsx` (the Solid impls behind each name: layout
  `Page`/`Stack`/`Grid`/`Card`, content `Metric`/`Text`/`Facts`/`Empty`,
  chart wrappers `LineChart`/`Treemap`/`Heatmap`/`Flamegraph`, and the rich
  self-contained widgets `DataTable` (client sort/filter + clickable rows),
  `RankList`, `LiveActivity` SSE ticker), `renderer.tsx`
  (`createRenderer(catalog, components)` → `<DashRenderer>` — a
  self-contained renderer; it wires the State/Action/Functions providers
  internally), `spec.ts` (`el()`/`toSpec()` — author a nested tree, flatten
  to the json-render `Spec` via the library's own `nestedToFlat`),
  `hints.ts` (declarative format/tone hints so specs stay **pure JSON** — no
  formatter functions on the wire; charts take `xFormat`/`yFormat` hint
  strings, table cells carry a `kind` + tone token). Every page (Overview,
  Tasks, TaskDetail, Projects, ProjectDetail, Cache, Trends, RunDetail,
  Bottlenecks) renders the same `/v1/*` resources through `Dash`. **`api.ts`,
  `format.ts`,
  `charts.tsx`, `ui.tsx` and the router are UNCHANGED** — the proven
  chart/UI code is reused as json-render's component library (the right way
  to adopt it). Carried-over fixes preserved: CPU utilization % (avg/max
  card + per-run column, green >100%), correct cross-platform peak RSS,
  full-size ResizeObserver-measured charts. UnoCSS `safelist` extended for
  the semantic dot/bar tones the catalog references by token (chart-1..8
  already listed; added `bg-/text-` for success/warn/danger/accent/
  cache-local/info). Deps added to `apps/ui` ONLY (`@json-render/core`,
  `@json-render/solid`, `zod` — 4 packages); **core `vx` untouched** (still
  19 deps). Embedded single-file SPA grew ~131 KB → 242 KB raw / 71 KB gzip
  (the interpreter) — acceptable for the embed. **Caveat to remember:**
  UnoCSS's static extractor parses `text-[${expr}]` arbitrary-value
  template literals and emits invalid CSS — never interpolate into bracket
  utilities in a scanned file; pass arbitrary classes through a `class`
  prop literal in page source instead. Verified e2e with Playwright against
  the real workspace `cache.db` (259 runs, 70 entries) across all 9 routes:
  0 console errors, real data, correct nav, charts filling cards. No
  CACHE_VERSION/core-test impact (UI-only; `apps` is excluded from
  oxlint/oxfmt and not covered by `bun test`, so validated at build +
  runtime). PRs #149 (RSS/CPU%/chart fixes) + #150 (initial rewrite) +
  #151 (idiomatic refactor). NB: json-render did not itself fix any
  data/chart complaint (those were backend/component issues fixed in #149)
  — its value is that the dashboard is now spec-driven, so a view could
  later be AI-generated against the same catalog.

  **Idiomatic refactor (owner: "why is it so complex? json-render should
  have easier ways?").** #150's pages built specs imperatively
  (`build(data) → Spec`) and tables carried a per-cell display-object DSL —
  real custom syntax. Reworked to json-render's intended data-binding model
  (owner picked it over trimming or reverting, tradeoffs explicit): each
  page is now a **static, data-independent `Spec`** (module constant) whose
  props bind to the page's **raw `state`** via `$state` / `$computed`
  (formatters live in `jr/functions.ts`, keyed by name) / `$template` /
  `$cond`, with sections gated by element-level `visible` conditions.
  `DataTable`/`RankList` take **raw rows + declarative columns** (`kind` +
  optional `baseTone`/`tone` rule + `*Key` field refs); the component
  formats internally via `format.ts` — **the per-cell DSL is gone**, pages
  just shape `state` (raw API rows + a few derived `_frac`/`_color`/`_href`
  fields). `spec.ts` gained `el(type,props,children,opts)` (opts carries
  `visible`/`repeat`, both preserved by `nestedToFlat`) + `S`/`C`/`T`
  directive shorthands; `renderer.tsx` exposes `Dash` (injects the
  `functions` map). **Hard-won reactivity bug:** json-render passes the
  resolved `element` to components as a REACTIVE getter (it tracks the
  resolved-props memo), so a component must read `rp.element.props` LIVE —
  snapshotting `const p = rp.element.props` once at setup freezes the
  loading-state props and the view never updates when async resources
  resolve. Ungated tables stayed empty while `visible`-gated detail pages
  (which remount after load) worked, which is what surfaced it. Fix:
  `px(rp)` returns a Proxy that forwards every access to the current
  resolved props, so reading `p.x` inside JSX/memos stays reactive.
  `StateProvider` reactivity confirmed from source — it diffs
  `props.initialState` by reference and `store.update`s changed JSON
  pointers, so passing a fresh `state()` object each tick re-renders;
  `flattenToPointers` treats arrays as leaf values so `{$state:'/rows'}`
  yields the whole array. Re-verified e2e across all 9 routes (0 errors,
  full fidelity — sortable headers, dots, tone bars, CPU%/RSS).

  **Two-way catalog (owner: "make it 2-way — either raw JSON or JSX with
  components, one catalog to build UI" + "why not use defineRegistry +
  Renderer?").** The catalog is now ONE set of **plain Solid components**
  (`jr/components.tsx`: `Page`/`Grid`/`Card`/`Metric`/`Text`/`Facts`/`Empty`/
  `LineChart`/`Treemap`/`Heatmap`/`Flamegraph`/`DataTable`/`RankList`/
  `LiveActivity` — each takes ordinary props + `children`), usable two ways:
  (1) **directly in JSX** — the 9 pages are now plain Solid
  (`<Card noPad><DataTable rows={rows()} columns={COLS} /></Card>`), no
  specs/`$state`/`toSpec`; (2) **via raw-JSON specs** through json-render —
  `jr/renderer.tsx` exposes the SAME components to json-render via the
  documented `defineRegistry` + `<Renderer>` API (switched off
  `createRenderer`, which was just sugar over providers), wrapped in
  `JSONUIProvider` for `$state`/`$computed` binding and rendered by `Dash`.
  Glue is one `adapt(Comp)` that forwards json-render's reactive
  `ctx.props`/`ctx.children` to a plain component via a live proxy (same
  reactivity reason as before). `pages/SpecDemo.tsx` (route `/spec`, not in
  nav) renders a literal flat `Spec` bound to live `state` — proof + living
  reference for the JSON path. **Net: the dashboard is back to plain Solid**
  (pages dropped all spec machinery), and **json-render is now OPTIONAL** —
  with no routed page using `Dash` the whole interpreter tree-shakes out
  (bundle 246 KB → 119 KB / 35 KB gzip); the `/spec` demo is what pulls it
  back in (245 KB). So: simple hand-authored pages by default, json-render
  available the moment a JSON/AI-generated view is wanted, both off one
  catalog. `spec.ts` (`el`/`toSpec`/`S`/`C`/`T`) kept as the ergonomic
  JSON-spec authoring helper. Verified e2e: all 9 JSX routes + `/spec`
  (raw JSON, `$computed`/`$state`-bound metrics + DataTable) render against
  the real cache.db, 0 errors. PR #152.

  **Fully pure-JSON pages (owner: "make only components, define registry,
  all pages/views pure json — no generation, new syntax" + "we should have
  a folder called views with all json files").** The JSX pages are GONE;
  every view is now a pure JSON file in `apps/ui/src/views/*.json`
  (`{ data, spec }` — `data` maps a state key to a named source, `spec` is a
  nested json-render tree). The ONLY code is: the catalog components
  (`jr/components.tsx`, now fully data-driven — they absorb ALL derivation
  so the JSON stays raw: `rowHref`/`rowTaskRef` link templates, `colorFrom`
  palette, auto bar-max + fraction, `dots:[{field,map}]`, `cpuPct`/`bar`/
  `shorthash` column kinds, charts take `rows`+field keys, `Facts` takes
  `entry`+field list), the registry (`defineRegistry`), a generic loader
  (`jr/page.tsx` `jsonPage(view)` — fetches each declared source into
  `state`, exposes decoded route `params` + a `<key>Status`
  loading/missing/ok flag for `visible` gating, flattens nested→flat via
  `nestedToFlat`, renders through `Dash`), named data sources
  (`jr/data.ts`), and `$computed` helpers (`jr/functions.ts`: formatters +
  `agg`/`aggFmt`/`ratioFmt`/`aggTone` array aggregations + `text` templating
  - `gt`/`lt`/`palette`/`countWhere`/`span`/`cpuStat`). Metric values/subs
    are `$computed` over raw `$state` arrays (e.g. total runs =
    `aggFmt(sum projects.runs)`; run wall time = `span(tasks)`; CPU% =
    `cpuStat(recent)`); tones via `$computed`/`$cond`; section gating via
    element `visible` on `<key>Status`. **UnoCSS gotcha:** UnoCSS only scans
    code files, so chart `stroke-`/`fill-` tokens that now live ONLY in the
    JSON were dropped until `uno.config.ts` got `content.filesystem:
['src/views/**/*.json']`. Net: the dashboard is spec-driven end to end —
    a view is data, hand-authored OR machine-generated, against one catalog;
    json-render is the engine (always bundled now, ~248 KB / 72 KB gzip).
    Verified e2e against the real cache.db, all 9 routes, 0 console errors,
    full fidelity (CPU%/RSS, `span`/`countWhere` run metrics, tones, palette
    dots, bars, charts/treemap/heatmap/flamegraph). `spec.ts`'s `el/toSpec`
    helpers are now unused (the loader uses `nestedToFlat` directly) but kept.

- **2026-06-27**: **Pure-JSON dashboard follow-up fixes** (owner: "tons of
  ts errors. Not working cache tab, no runs, not working flame graph. no
  cpu % on tasks in runs"). The `views/*.json` conversion shipped with a
  stale `dist` and three real regressions, all fixed. (1) **~21 TS errors**
  — `getHistory` takes `{ limit }` not a number (`jr/data.ts`,
  `CommandPalette.tsx`); optional route params need a `?? ''` fallback
  (`getTaskDetail`/`getRun`); json-render's ctx props are typed `unknown`
  not `Record` (`renderer.tsx` `JrCtx`); the catalog was missing the
  required `actions: {}` (`catalog.ts`). tsc now clean. (2) **Flamegraph
  dropped every cache-hit task** — it keyed off `wallclockStartNs`/`EndNs`,
  which are null for restored tasks, so a 3-task run drew 1 bar. Switched
  the time base to `startedAt`/`endedAt` (epoch ms, present on every row)
  and replaced project-lanes with greedy time-packing in
  `flamegraph-layout.ts` (each task takes the first lane whose previous bar
  finished), so lanes now reveal parallelism and cache hits render as thin
  marks. (3) **Run-detail tasks table had CPU time but no utilization %** —
  added a `cpuPct` column (dashed for cache hits, green > 100%), matching
  the task-detail page. The "cache tab not working / no runs" report did
  NOT reproduce in a fresh build (all metrics + 76 entries + 12 invocations
  render) — it was the stale committed `dist`; rebuilt + recommitted.
  Re-verified e2e across all 9 routes: 0 console errors, flamegraph draws
  all tasks, run detail shows 369% CPU for the one executed task. apps-only
  change; core `vx` untouched, no CACHE_VERSION impact.

- **2026-06-17**: **Execution as a pluggable backend + `vx serve` (owner
  ask: "one process doing all the work; runs inform it what to run and
  subscribe; treat vx as a service with clients; later a hosted service").**
  `vx run` no longer always executes in-process: it resolves a
  `RunBackend` and submits a `RunRequest`, agnostic to where work happens —
  the cache's local/remote split applied to EXECUTION. Files (each
  isolated/swappable): `orchestrator/protocol.ts` (wire contract:
  `RunRequest`/`RunResult`/`Server|ClientMessage` + `RunOptions⇄RunRequest`
  mappers, transport-agnostic), `orchestrator/wire-render.ts` (inverse of
  `wireForwarder` — rebuild node-shaped objects from `WireEvent`s and drive
  a normal `Logger`, so a DELEGATED run renders identically with the
  terminal renderer UNTOUCHED), `cli/serve.ts` (`vx serve`: Bun.serve + ws,
  dep-free, hosted-ready; runs the same `run()` with a silent logger +
  `handleSignals:false`, streams events, returns a result; advertises
  `.vx/serve.json` + `/health`), `cli/backend.ts` (`RunBackend` +
  `localBackend` (byte-identical in-process, mirrors to a `vx dev` hub) +
  `serviceBackend(origin, sink?)` (ws client; render sink INJECTABLE —
  hardcoding `defaultLogger` caused a cross-test hang via its status-region
  ticker) + `resolveBackend` (`VX_SERVICE_URL` → local service → in-process;
  FAIL-SAFE: any doubt → local, a service never blocks/breaks a run, 300ms
  health timeout)). **WireEvent reshaped**: `task:start` carries the full
  `TaskView` (consumer rebuilds incrementally, no upfront table);
  `wireForwarder` now EMITS `WireEvent`s (callers frame them: NDJSON for the
  dev socket, enveloped JSON for serve) and dedupes the double `run:end`
  while STILL forwarding the post-run:end summary footer (`run:status`
  lines) — else delegated runs lost their footer. Verified e2e: `vx serve`
  up, a separate `vx run` delegates, task runs server-side, full framed
  output + footer stream back and render identically, service logs
  activity, info file cleaned up on exit. 834 tests pass (all via local
  fallback) + new `wire-render`/`serve` suites. No CACHE_VERSION impact.
  Design + the deferred roadmap (in-flight dedup via
  `Map<taskHash,Promise>`, one global scheduler, watch+supersede staleness,
  serve/dev convergence, hosted execution):
  `docs/design/execution-service-2026-06.md`.

- **2026-06-17**: **Run event stream + devframe surface (Phase 1, owner
  ask: "use devframe for internals logging; drive our terminal output
  through it; build live CLI/web devtools").** Foundational refactor:
  `run()` no longer calls a `Logger` directly. New
  `src/orchestrator/events.ts` — an in-process `RunEvent` bus
  (`createEventBus`, synchronous order-preserving fan-out), a
  `Logger`-shaped `busLogger` facade, and `terminalSubscriber(sink)` that
  drives the concrete renderer. `run.ts` threads `busLogger` as `log`, so
  every existing `log.X(...)` call emits a `RunEvent` → bus →
  terminalSubscriber → the **untouched** `defaultLogger`. **Output
  byte-identical** (all output suites green, nothing repinned). The same
  file ships the serializable wire contract (`TaskView` / `OutcomeView` /
  `projectNode` / `projectOutcome` / `WireEvent` / `toWireEvent`) the
  off-thread boundary needs — raw `TaskOutcome`s carry bigint wallclock ns
  (`JSON.stringify` throws) + a back-ref to the whole `TaskNode` graph, so
  crossing a worker/RPC requires ids + decimal-string ns. Phase 1b:
  `src/orchestrator/run-state.ts` (`RunState` + pure `reduce` mirroring the
  logger's inline counters) and `src/orchestrator/devframe-surface.ts`
  (`createVxSurface(bus)` → a `DevframeDefinition` forwarding bus events
  onto a `vx:events` streaming channel + a `vx:run` reduced shared state).
  **devframe is a `devDependency`, touched only via type-only imports** in
  devframe-surface.ts + dynamic import at the host — core `vx run` stays at
  19 deps; surface tests use a mock ctx so they never ride devframe's
  runtime. **devframe@0.5.4 due-diligence:** ~33-package closure (native
  oxc-parser + h3-rc HTTP stack); three rough edges worked around
  (`defineDevframe` mis-exported → author the object directly;
  `createSharedState({enablePatches})` throws on uninitialized Immer;
  MCP adapter needs `@modelcontextprotocol/sdk` peer). No CACHE_VERSION
  impact (pure orchestration/output plumbing). **`vx run --ui` shipped
  same day**: `src/cli/ui-server.ts` `startUiServer(port?)` dynamically
  imports `devframe/adapters/dev`, boots `createDevServer` over the vx
  surface, returns the bus; new `RunOptions.bus` lets `runCmd` inject it
  so the surface subscribes before the run emits, then the CLI keeps
  serving until Ctrl-C. `--ui` / `--ui-port` flags; devframe stays
  optional (dynamic import + UserError install hint). Verified e2e (real
  server boots, forwards events, serves `__connection.json`) — the host
  initializes Immer patches so the standalone shared-state bug doesn't
  bite. Bridge mode (no bundled SPA yet; clients connect over WS). NEXT:
  `vx mcp` (createMcpServer, stdio) over the same definition + a real SPA.
  Design + phasing: `docs/design/event-stream-2026-06.md`.

- **2026-06-16**: **`vx-lock.json` globally excluded from cache inputs
  and `--affected`** (owner: "vx lock should be globally excluded from
  affected and cache, like gitignored"). The lockfile is committed, so
  git enumeration includes it, but it's vx's own frozen-config metadata
  — never a task input. (1) **Cache**: added `**/vx-lock.json` to
  `ALWAYS_IGNORE` in `cache/inputs.ts` (covers both project `files` and
  `workspaceFiles` resolution — both fold ALWAYS_IGNORE into their
  exclude globs). Hardcoded literal, NOT the workspace `LOCKFILE_NAME`
  constant: cache is a leaf module and must not import from workspace.
  **CACHE_VERSION → v24** (no SCHEMA bump): a task whose globs matched
  the root lockfile (broad `**/*` on the root `.` project) drops it
  from the hashed set, so those keys change; tasks that never matched
  it stay byte-identical. (2) **Affected**: `affected.ts` filters the
  exact root-relative `LOCKFILE_NAME` out of the `git diff --name-only`
  changed set before mapping to projects (uses the constant — same
  module), so a `vx lock` re-write can't mark every project affected.
  Files: `cache/cache.ts` (version + comment), `cache/inputs.ts`,
  `workspace/affected.ts`, `docs/caching.md` history.

- **2026-06-16**: **Requested persistent task keeps the run in the
  foreground** (owner bug: `vx run @vzn/vx-docs#dev` "is not
  persisting"). A persistent task that is the terminal/edge node (the
  user requested it, nothing downstream depends on it) was SIGTERMed
  the instant it became ready — the dev server died in milliseconds.
  Now `run()` distinguishes persistent tasks that exist only to support
  now-finished work (SIGTERMed at end-of-graph, as before) from
  persistent tasks the user REQUESTED (`node.requested || surfaced`):
  the latter are left running and the run blocks on their `exited` at
  the very END (after the summary prints + history is recorded), so
  Ctrl-C (process-group, plus the existing SIGINT handler → exit 130)
  reaps them and a crash resolves the wait. **Footer/UI unchanged** —
  the owner's first concern was an earlier attempt that called
  `runEnd` early + printed a custom hint + skipped `formatRunSummary`;
  reverted. The summary prints at its normal spot; the block is silent
  and purely defers process exit. **Display (owner-specified, kept
  simple, no region overhaul):** (1) the focused live frame for a lone
  persistent task is MARKED persistent — `formatFrameOpen`/`Close` add a
  cyan `▸` after `┌─`/`└─` when `exec.persistent` is set, and the close
  reads `running` (accent), not `success`, since the child is still
  alive; (2) between the frame and the `─ vx` footer, `run()` emits
  `formatPersistentList(keepAliveNodes)` — one `▸ <id> running` row per
  kept-alive task, so it's clear which are persistent and how many. New
  export `formatPersistentList` in `framed-output.ts`. **Scoped to the real CLI foreground**
  via `options.log === undefined && (handleSignals ?? true)`: a custom
  logger (tests/embedders) or `handleSignals: false` (watch) keeps the
  old return-after-teardown contract, so the persistent-task test
  suites (which request persistent tasks and assert run() returns) stay
  green — gating on `handleSignals` alone hung them. Known limit
  (pre-existing, unchanged): `sh -c '<server>'` grandchildren orphan on
  a lone `kill <pid>` (no process groups); real-terminal Ctrl-C reaps
  via the tty foreground group. File: `orchestrator/run.ts`.

- **2026-06-16**: **Unified `exec.timeout` — one knob, two meanings**
  (owner-driven). One `exec.timeout` (ms) field replaces the old
  `persistent.readyTimeoutMs`. Single mental model: "how long before vx
  SIGTERMs the child." For a NORMAL task it bounds total run time — an
  overrun is SIGTERMed and reported `failed` (timed out), never cached.
  For a PERSISTENT task it bounds the READINESS wait (exactly what
  `readyTimeoutMs` did: SIGTERM + reject `ready` when `readyWhen` never
  matches); a ready-on-spawn persistent task resolves before the timer
  can fire, so it's a harmless no-op (no loader error — a general field
  shouldn't carry a context-specific rejection). Key subtlety: a
  timeout SIGTERMs, but the existing Ctrl-C teardown classifier already
  reverts ANY SIGTERM/SIGINT to `aborted` — so the runner flags
  `RunResult.timedOut` when ITS OWN timer fired, and `execute-task`
  guards the abort check with `!result.timedOut` (timeout → real
  `failed`, exit 143, not cached; streams a `timed out after Nms` line
  into the framed block). Second subtlety: SIGTERMing `sh` doesn't close
  the stdout pipe if an orphaned grandchild (`sleep 30`) still holds the
  write end, so `streamToString` would never see EOF and the run hung —
  `runCommand`/`runSandboxed` now gate on `proc.exited` (not stream
  EOF) and abort the readers via an `AbortSignal` once the child dies on
  timeout, returning captured-so-far output. New shared
  `armTimeout(proc, ms)` helper in `runner.ts` (exported; used by both
  `runCommand` and `runSandboxed`); `streamToString` gained an optional
  `signal` param. Grandchild orphaning is the documented known-limit
  (no process groups) — the killed `sh` pid dies, the orphaned `sleep`
  lingers; matches the existing SIGINT/SIGTERM-reaping caveat. NO
  CACHE_VERSION bump — `hashTaskConfig` JSON-stringifies the whole
  config, so a task declaring `timeout` gets a distinct key while tasks
  without it stay byte-identical (same pattern as `persistent` /
  `readyTimeoutMs`, neither bumped). Files: `config.ts` (ExecConfig
  `timeout`; PersistentConfig `readyTimeoutMs` removed), `exec/runner.ts`
  (`armTimeout`, `RunResult.timedOut`, `RunOptions.timeoutMs`,
  cancellable `streamToString`, persistent `readyTimeoutMs`→`timeoutMs`),
  `exec/sandbox-runtime.ts` (`timeoutMs` + abort), `orchestrator/
execute-task.ts` (thread `step.timeout`; abort-check guard; timeout
  stderr line), `workspace/project-loader.ts` (validate `exec.timeout`;
  drop readyTimeoutMs validation), `cli/show.ts`, `cli/migrate-turbo.ts`
  (comment). Tests: `tests/persistent-ready-timeout.test.ts` rewritten
  (normal-task overrun-kills-fast-not-cached + within-budget, persistent
  readiness bound preserved, loader validation). Docs: `schema.md`
  (`timeout` section), `README.md`, `modules/runner.md`.

- **2026-06-15**: **Output redesign follow-ups + `aborted` status**
  (owner-driven). (1) **Worker rows have no glyph** — the live elapsed
  time leads (`     568ms running  <id>`); the glyph column is blank
  (persistent dev-server rows keep `▸`). (2) **Live region separated
  from the list** — a leading blank line tops the status region so the
  in-flight rows sit apart from the completed-task scrollback. (3)
  **Footer is identical live and final** — the live region now receives
  the run `RunContext` via `runStart` and renders the SAME
  `formatSummarySection` (version + `projects` bar + meters + `info` +
  `time`); previously the live footer was a bare `vx`. (4) **`aborted`
  status** — a child killed by a SHUTDOWN signal (SIGINT/SIGTERM, i.e.
  Ctrl-C teardown) is classified `aborted`, NOT `failed`: not cached,
  not counted (excluded from `tallyOutcomes` + `recordRun`), not shown
  (logger `taskComplete` frees the slot and returns). SIGKILL/OOM stays
  a real failure. Fixes the owner bug where Ctrl-C left in-flight tasks
  reported as `failed` (the TTY signal kills the children, whose
  143/130 exits were recorded before `process.exit`). New `TaskStatus`
  member `'aborted'`; `RunResult.signal` carries `proc.signalCode`;
  classification in `execute-task.ts`. Files: `graph/scheduler.ts`,
  `exec/runner.ts`, `orchestrator/{execute-task,logger,tally,run,
status-line}.ts`. Tests repinned (region row offsets for the leading
  blank; aborted-is-silent pin). NB: on a TTY the frozen region isn't
  yet erased on exit (cosmetic; non-TTY prints nothing).

- **2026-06-15**: **Per-task output redesign — two-axis glyph grid**
  (owner-driven, many iterations). Reported task lines and live worker
  rows are now ONE column grid: ` <glyph> <time> <status> <cache>
<name>` (leading space; single-space separators; time right-aligned
  in a 7-cell column; status 7-wide, cache 6-wide; name LAST so nothing
  shifts with id length — layout shift was the bug). **Two orthogonal
  axes** (owner reframed the old fused vocabulary `restored-local /
up-to-date / success` as task×cache): the GLYPH shape encodes the
  CACHE axis — `⏺` miss (ran) · `►` fresh (up-to-date) · `⇢` local ·
  `⇣` remote · `◼` failed · `⊘` skipped · `⦿` running (worker) · `▸`
  persistent — and the glyph COLOR encodes the TASK axis (green success
  / red failed / yellow skipped / cyan running). The `status` word
  (success/failed/skipped/running, task-colored) and the `cache` word
  (miss dim / fresh green / local sky / remote blue) spell both axes
  out. NO exit code on the line — all detail (exit N, stdout/stderr)
  lives in the framed block that already replays. `⏺` and `◼` carry a
  U+FE0E text-presentation selector so terminals render them narrow
  (Bun.stringWidth sees them as width-1; without VS15 many terminals
  emoji-widen them and the time column jitters). **Footer is identical
  live and final**: the live status region now receives the run
  `RunContext` via `runStart` and renders the SAME
  `formatSummarySection` (version on the wordmark rule + `projects`
  bar + meters + `info` row + `time`) — previously the live footer was
  a bare `vx` with no context (owner: "footer always the same"). Worker
  region: no spinner (the ticking elapsed time IS the motion), ids
  never truncated. Files: `orchestrator/framed-output.ts` (`taskGlyph`
  / `glyphShape` / `statusOf` / `cacheOf` / `formatTaskRow` grid),
  `status-line.ts` (`formatFailureLine` + region rows on the grid),
  `logger.ts` (thread `RunContext` into the live region; spinner
  removed), `summary.ts` (`RunContext`), `run.ts` (pass context to
  `runStart`). No CACHE_VERSION/behavior impact — pure presentation.
  Tests repinned across `output-flow`/`status-line`/`framed-output`/
  `cli`. KNOWN-OPEN (owner asks, not yet done): on SIGINT/SIGTERM the
  live region is left frozen on a TTY (non-TTY prints nothing — already
  correct); killed in-flight tasks already get NO outcome (process.exit
  is immediate, before any taskComplete) so they're never counted
  failed/skipped — but the frozen TTY region should be cleared on exit.

- **2026-06-15**: **`vx upgrade` fixed for curl-installed binaries —
  detection keyed off `Bun.main`, not `import.meta.path`.** Owner report:
  curl-installed `vx` couldn't self-upgrade and "vx points to bun".
  Root cause: `isCompiledBinary()` checked `import.meta.path.startsWith
  ('/$bunfs')`, but vx's release binaries are built `--minify
--bytecode`, and under those flags Bun reports `import.meta.path` as
  the ORIGINAL SOURCE path (e.g. `/private/tmp/bin.ts`), NOT the bunfs
  path — so EVERY installed binary misread as "running from source" and
  `vx upgrade` refused with the git-pull message. `Bun.main` and
  `process.argv[1]` stay the bunfs path (`/$bunfs/root/…`) under every
  compile-flag combo, so detection now keys off those (import.meta.path
  kept as a third fallback). `dest = process.execPath` was always
  correct (it resolves to the real standalone binary, not bun — the
  "points to bun" was the refusal + `process.argv[0]` literally being
  the string `"bun"` in standalone binaries). Verified end-to-end:
  compiled a `--minify --bytecode` binary, `vx upgrade` now downloads
  `latest`, atomically replaces itself, and the new binary runs.
  Extracted pure `isBunfsPath(p)` (exported) for the markers; files:
  `src/cli/upgrade.ts`, `tests/upgrade.test.ts` (marker unit tests +
  the kept source-mode refusal e2e).

- **2026-06-15**: **Task hierarchy — dotted-namespace group composition.**
  The repo's own `vx.config.ts` tasks were restructured so groups
  compose by dotted name: `lint` → `lint.oxlint` + `lint.oxfmt` (+
  `lint.oxfmt.fix` to rewrite); `build` → `build.bun` →
  `build.bun.{linux-x64,linux-arm64,darwin-x64,darwin-arm64}` (one real
  cross-compile task per platform); `ci` → `lint` + `test`. Dotted
  names are a pure convention (no schema feature) — they read as a
  folder tree and pair with the transparent-folder focused output (see
  the entry below; `vx run lint` surfaces `lint.oxlint`/`lint.oxfmt`).
  `vx-lock.json` regenerated, CI/release workflow comments + the
  Workflow/CI sections of this file updated to the new names. NB: `ci`
  initially also chained `build` but that was dropped same day
  (`build.bun.*` OOM-killed on the CI runner) — the four binaries build
  only in `release.yml` via `vx run build`. No CACHE_VERSION impact
  (resolved-config hashing keys each task independently of its name).

- **2026-06-15**: **`dependsOn` bare entries type-checked against task
  keys.** `defineProject` now constrains each task's `dependsOn` so a
  BARE entry (`'build'`) must be one of that config's own task keys — a
  typo (`'biuld'`) is a compile error with a "did you mean" hint. The
  `'^name'` (workspace-dep, incl. `'^all'`) and `'pkg#name'`
  (cross-project) forms reference OTHER projects' tasks and stay free
  strings (this config can't see their keys). Compile-time only:
  `defineProject` stays an identity function at runtime, and
  `TaskConfig.dependsOn` keeps its loose `readonly string[]` for the
  loader/graph (which validate dynamically). Files: `src/config.ts`,
  `tests/config.test.ts`.

- **2026-06-13/14**: **Docs-site adopter overhaul + animated landing
  benchmark.** A large body of `apps/docs` (Astro Starlight) work,
  shipped via web-session PRs per that harness's directive (NOT the
  push-to-main rule): (a) the guide/reference content was overhauled
  for ADOPTERS — every config prop covered, new sandboxing +
  workspace-config guides, install instructions corrected (`bun add` +
  `curl` both shown, `defineProject` kept), `vx lock` / `--frozen` in
  CI documented, several verified inaccuracies corrected; (b) the docs
  LEAD with real large-monorepo benchmark numbers (deep-graph shape,
  Turbo caching fixed in the harness, a `vx (frozen)` variant + frozen
  warm numbers added); (c) the LANDING page was redesigned
  (speed-forward, mobile-responsive, gradient-bordered cards) with an
  animated **benchmark race** — `BenchBar.astro` / `BenchChart.astro`
  render each runner's bar as a relative-length, real-time progress
  fill (cold starts at vx's finish line and watches Turbo/Nx grind on;
  bars share one timescale; a sheen sweeps only still-running bars).
  `docs/**` stays the source of truth for the reference pages; landing
  - benchmark visuals are hand-authored components. No core/runtime
    change — `docs/` + `apps/docs/` only.

- **2026-06**: **Groups are transparent folders in focused output**
  (owner: "treat groups as transparent folders — running them should
  show real tasks"; `vx run build` where `build` is a group printed
  nothing but the footer). In FOCUSED flow a requested GROUP now
  surfaces the real tasks it stands for and displays them like
  requested tasks. New `markSurfacedDeps(nodes)` in
  `graph/task-graph.ts` walks `dependsOn` from each requested group,
  DESCENDING THROUGH nested same-project groups (`build` → `build.bun`
  → `build.bun.*`) and marking the first non-group task on each path
  `node.surfaced = true`. Two hard limits: never leave the requested
  project (`^`/cross-project deps are neither surfaced nor traversed —
  owner: "only if those deps are in this project eg no ^"), and never
  descend past a real task into its own deps (that's its implementation
  detail). `surfaced` is **display-only** — deliberately NOT
  `requested`, because `requested` also scopes `--` `forwardArgs`
  (`execute-task.ts`); flipping it would leak trailing args into the
  surfaced tasks. `run.ts` calls `markSurfacedDeps` after graph build
  and counts surfaced nodes toward `requestedCount` (so one surfaced
  task streams live, several buffer into atomic blocks — the existing
  multi-requested path). The logger gained an `isPrimary(node) =
requested || surfaced` predicate driving `streamsLive` and the
  focused branch; everything else (broad/full/CI/none/errors-only)
  ignores `surfaced`. No CACHE_VERSION/behavior impact — purely which
  tasks the focused logger shows. Tests: `markSurfacedDeps` unit suite
  in `tests/task-graph.test.ts` (descend-through-nested-groups,
  same-project-only, stop-at-real-task, non-group-requested→0) +
  focused surfaced-streams-live / non-surfaced-dep-silent pins in
  `tests/output-flow.test.ts`. Docs: `docs/cli.md` focused-flow
  "transparent folders" note.

- **2026-06**: **Header folded into the footer; top-of-run banner
  removed** (owner: "logs header should [be] in footer. we don't need
  the header" → then a hand-drawn target layout). `formatHeader` +
  `HeaderInput` deleted from `framed-output.ts` (and `SCOPE_BAR_WIDTH`,
  its lone consumer; `unanchored` in `run.ts` too); the run prints
  nothing before task output. The run banner now rides the **footer**
  via a new optional `RunContext` param on `formatRunSummary` /
  `formatSummarySection` (`summary.ts`). Owner-chosen layout (matched
  to a pasted mockup): a `projects` affected-vs-workspace bar **leads**
  the meter stack (`N affected · N total`), then `tasks` (legend gains
  a dim `N total`) and `cache` meters, a blank line, then an `info` row
  (`N workers · <cache mode>`) and the `time` row. Labels pad to **8**
  (was 6), bars/legends shift to column **12** (was 10), and the
  wordmark rule widened to 62 cols (`RULE_DASHES` 55→57) to stay flush.
  Requested task names + the old `run`/`scope` rows were **dropped**
  from the design — the footer is meters-first, names live in the
  stream. Cache mode lives on the `info` row, not a colliding `cache`
  label. **Live region unchanged in spirit**: the status region calls
  `formatSummarySection` with NO context, so the rule stays a bare `vx`
  and `projects`/`info` are skipped — it renders the meters alone
  (label width + tasks `N total` now apply there too, harmless/
  consistent). Custom loggers (tests) previously got header lines via
  `log.status`; they now get the same data in the footer. No
  CACHE_VERSION/behavior impact — pure output formatting. Tests:
  `formatHeader` block removed from `framed-output.test.ts`; all
  `summary.test.ts` geometry pins updated (57-dash rule, 12-indent
  legends, `N total`) + projects-bar/info-row/no-context-parity pins;
  the group-totals e2e in `orchestrator.test.ts` switched its legend
  scan to the 12-indent column. Docs: `docs/modules/summary.md`
  (RunContext + new format), `framed-output.md` (header section
  deleted), `status-line.md` worker-pool note.

- **2026-06**: **Runtime inputs — `cache.inputs.runtime` /
  `cache.inputs.workspaceRuntime`.** The single canonical mechanism for
  folding a shell command's OUTPUT into a task's cache key (tool/runtime
  versions, OS info, project-local probes). Modeled exactly on
  `inputs.env`: the command STRINGS live in the resolved config (frozen
  into `vx-lock.json`), the OUTPUT is resolved live at hash time inside
  `resolveInputs` on EVERY run — so it stays correct under `--frozen`,
  precisely where the TS escape hatch (`define: { X: execSync(...) }`)
  goes stale (its value was baked into the config object at lock time).
  `runtime` commands run in the PROJECT dir, deduped per
  `(projectDir, command)`; `workspaceRuntime` commands run at the
  WORKSPACE ROOT, deduped GLOBALLY per command (a `node -v` in 500
  projects spawns once). Both run via `sh -c` ("shell is the API" —
  pipelines/redirects work). Output = combined trimmed stdout+stderr,
  folded into `Cache.key` as TWO namespaced sections
  (`runtime-values:` / `ws-runtime-values:`) right after env-values, so
  an identical `(command, output)` never aliases between the two
  scopes. A non-zero exit is a hard `UserError` naming the command +
  exit code (fail-loud, like a missing git binary). Dedup uses
  run-scoped `Promise` memos on `HashCache` (`runtime` /
  `workspaceRuntime` maps) shared by the hash path AND the sandbox-
  baseline `resolveInputs` — the first task to need a command fires the
  spawn, the rest await the same promise; each task awaits only its OWN
  commands (no upfront global pass). **CACHE_VERSION → v23, no SCHEMA
  bump** — only `Cache.key` derivation gained two sections; tasks
  declaring neither field fold a `:0` count for both and derive
  byte-identical keys to before. **Nx parity** (Nx has a `runtime`
  input; Turbo lacks this — vercel/turborepo#4124). Files: `config.ts`
  (two `CacheInputs` fields), `workspace/project-loader.ts`
  (validation: non-empty string arrays), `cache/inputs.ts`
  (`runRuntimeCommand` + `resolveRuntimeValues` + `ResolvedInputs` /
  `ResolveInputsArgs` extensions), `cache/cache.ts` (`CacheKeyInput`
  fields + `key()` fold + version bump), `orchestrator/task-hash.ts`
  (`HashCache` memos + threading), `orchestrator/execute-task.ts`
  (sandbox-baseline memo passthrough). Tests: `tests/inputs.test.ts`
  (resolver: cwd split, dedup-runs-once, stdout+stderr, sort, non-zero
  fail), `tests/cache.test.ts` (key folding + namespacing + absent ==
  empty), `tests/project-loader.test.ts` (validation), and
  `tests/runtime-inputs.test.ts` (real-CLI e2e: output drift → miss,
  live under `--frozen`, global dedup one-spawn, non-zero fails the
  run). Reference `docs/design/runtime-inputs-2026-06.md`.

- **2026-06**: **Cold-run optimization — no per-project git re-spawn on
  cache-miss save** + a real vs-Turbo-vs-Nx benchmark. Owner: "we should
  be faster on cold … use bun --profile to find exactly what's causing
  it and optimize." `bun --cpu-prof --cpu-prof-md` on a cold run showed
  `spawnSync` at **22% of CPU**: `execute-task.ts` called
  `gitFilesCache.delete(projectDir)` after every cache-MISS save with
  outputs, so the same-project downstream task (e.g. `test` after
  `build`) re-spawned `git ls-files` SYNCHRONOUSLY — one blocking spawn
  per project. Fix: replace the `delete` with `markOutputsChanged(<rel
output paths>)` — the SAME mechanism the cache-HIT restore path already
  uses — so `snapshotFor` skips the re-spawn when a downstream task's
  input globs can't match the (declared) output paths. Cold A/B (200-pkg
  synthetic, compiled binary): **1534 ms → 1109 ms (-28%)**, spawnSync
  gone from the profile; head-to-head (`bench/compare.ts`, 300-pkg): vx
  cold now **ties Turbo** (was losing at 0.7×), wins both warm states,
  and is **3.9-6.3× faster than Nx** everywhere. **No CACHE_VERSION
  bump** — key derivation and artifact bytes are untouched; only WHEN
  the in-run git snapshot is invalidated changed. Tradeoff (identical to
  what the restore path already accepts, now extended to save): a task
  that writes files OUTSIDE its `cache.outputs.files` which a same-
  project downstream task reads is undeclared behavior and won't trigger
  a re-enumeration — declare your outputs. All 753 tests pass
  (restore-git-spawns.test.ts unaffected). New `bench/compare.ts`:
  scaffolds ONE shared repo (default 1000 pkgs × 10 layers, build+test,
  identical shell commands across runners), runs vx (compiled binary,
  the real artifact) / Turbo / Nx across fresh / warm-no-restore /
  warm-restore, writes committed `bench/RESULTS.md` + `bench/results.json`.
  Fairness fixes baked in: generated workspace gitignores
  node_modules/.vx/.turbo/.nx (else vx's git enumeration walks
  node_modules, a handicap the JSON-config runners dodge), clean commit
  before measuring (vx's zero-read clean-tree OID path).

- **2026-06**: **Docs site (`apps/docs`) + GitHub Pages.** Owner ask:
  "a website with docs guide refs architecture and everything like
  Turborepo or NX … add a new pnpm workspace with a project like this
  and deploy it to GitHub Pages." Built on **Astro Starlight**; the
  repo root became a **Bun workspace** (`workspaces: [".", "apps/*"]`)
  rather than introducing pnpm (owner picked Bun-isolated-app-dir over
  literal pnpm). **The `"."` member is load-bearing**: vx's own
  discovery (`loadWorkspace`) switches from single-project mode to
  glob mode the moment `workspaces` is set, so without `"."` the root
  vx.config.ts (lint/test/ci/build tasks) stops being a project and
  `vx run ci` / `release.yml` break. Bun tolerates `"."` as a member.
  **`docs/` stays the single source of truth** — `apps/docs/scripts/
import-docs.ts` copies `docs/**/*.md` into the Starlight content
  collection, adding frontmatter (first H1 → title) and rewriting
  internal `.md` links to depth-relative clean URLs (base-safe; no
  hardcoded `/vx`). The transform is code-span/fence-aware and escapes
  bare `<placeholder>` tokens in prose so Markdown doesn't eat them as
  HTML. Generated content is git-ignored and regenerated on every
  dev/build; only `index.mdx` (splash landing) + `getting-started.md`
  are hand-authored. Mermaid (architecture.md, flows.md) renders
  client-side: a remark plugin emits `<pre class="mermaid">`,
  `Head.astro` lazy-imports mermaid only on diagram pages and
  re-renders on theme toggle. **oxc guard**: `apps` added to
  `.oxlintrc.json` + `.oxfmtrc.json` `ignorePatterns` so the root
  `oxfmt --check .` / `oxlint` (which scan cwd) don't choke on the
  app. Deploy: `.github/workflows/docs.yml` (Pages, path-filtered on
  `docs/**` + `apps/docs/**`); base `/vx` for the project-site URL,
  `BASE_PATH`/`SITE_URL` overridable for a custom domain. Pages must
  be enabled once (Settings → Pages → Source: GitHub Actions). No vx
  CACHE_VERSION/test impact; the full `vx run ci` gate stays green.
  NOTE: this work shipped via a feature branch + PR per the web
  session's harness directive, NOT the usual push-to-main rule.

- **2026-06**: **Async remote-cache prefetch (remote-only).** Owner
  ask, quoted: "do the remote cache async calls. when exec task probes
  for it it should just get the resolved or pending promise." For runs
  backed by a `LayeredCache`, `run()` now derives every cacheable
  task's pure-input key UP FRONT in topo order (reusing the run's
  `hashCache` memo — execute-task's later `computeTaskHash` hits the
  memo, no double hashing; derivation touches NO cache layer, keys
  only) and fires the remote GETs concurrently in the background under
  a bounded pool (the run's concurrency) BEFORE scheduling, so network
  latency overlaps execution. `LayeredCache.prefetch(hash, ctx)`
  ingests a hit into LOCAL; an `inflight: Map<hash, Promise<boolean>>`
  shared by `prefetch` AND `get` guarantees **at most ONE remote GET
  per key** (a settled-`false` miss blocks a second lazy probe). When
  execute-task calls `cache.get`, `LayeredCache.get` awaits any
  in-flight prefetch for that key before deciding — so it
  "transparently gets the resolved-or-pending promise" with no
  execute-task change beyond what already existed. Provenance: a
  remote-sourced hash reports `source: 'remote'` even when a later
  `get` finds it locally (a `remoteSourced` set), so the outcome stays
  `cache-hit-remote`. The local `Cache` gets a no-op `prefetch`
  returning `false` (CacheLayer contract). This is the
  remote-prefetch follow-up the reverted upfront-classification entry
  said was abandoned — REVIVED on a sound footing: it does NOT depend
  on upfront LOCAL classification (the thing that double-probed and
  regressed warm runs +57%). The hard scoping is what makes it safe —
  gated ENTIRELY on `cache instanceof LayeredCache`; a local-only run
  derives no upfront keys, prefetches nothing, adds NO upfront local
  `get`/`isOutputsCurrent`/stat pass, and is byte-identical (behavior
  - perf) to before. **Stable-key gate** (slim, boolean-only revival
    of the rejected computeRecomputeFlags idea — no statuses, no
    probes): a task whose `cache.inputs.files` could match an upstream's
    declared output has a PRELIMINARY key until that upstream runs, so
    it's skipped from prefetch (lazy read-through stays correct);
    conservatively a task is unstable if a same-project upstream
    declares `outputs.files`, or it reads `inputs.workspaceFiles` and an
    upstream declares `outputs.workspaceFiles`, or it folds an unstable
    upstream — when unsure, unstable. `--no-cache` fires no prefetch.
    Lifecycle: `startRemotePrefetch` returns a handle `run()` awaits
    before `cache.close()` (a still-in-flight prefetch ingesting into a
    closed SQLite DB would throw) but does NOT await before scheduling
    (that's the overlap). No CACHE_VERSION bump — key derivation and
    artifact bytes are untouched; this only changes WHEN the remote GET
    fires. Files: `src/orchestrator/remote-prefetch.ts` (new),
    `src/orchestrator/run.ts` (wire + drain), `src/cache/cache.ts`
    (`CacheLayer.prefetch` + Cache no-op), `src/cache/layered-cache.ts`
    (`prefetch` + `inflight`/`remoteSourced` + shared `pullFromRemote`).
    Tests: 5 LayeredCache unit tests (prefetch pull+provenance, miss,
    at-most-once with injected latency — guard FAILS at 2 if de-dup
    removed, prefetch-miss-no-second-GET, concurrent-prefetch idempotent)
  - 4 orchestrator e2e (at-most-once + overlap on a real CLI run,
    codegen→consumer stable-key correctness, --no-cache no GET,
    local-only-never-prefetch via a `LayeredCache.prototype.prefetch`
    spy). Docs: docs/caching.md § Remote prefetch, docs/optimizations.md
    row 17b.

- **2026-06**: Async remote-cache prefetch (REMOTE-ONLY) + never-fail
  hardening. Owner asks: (1) "do the remote cache async calls — when
  exec task probes it should just get the resolved or pending
  promise"; (2) "remote cache should never fail anything — 500 or any
  error → fall back to cache miss, continue; it's fully optional".
  Design: when a run is backed by a LayeredCache, `startRemotePrefetch`
  (src/orchestrator/remote-prefetch.ts) derives every STABLE cacheable
  task's pure-input key upfront (reusing the run hashCache memo — no
  double hashing; skips inputs-glob-includes-upstream-output tasks
  whose key is preliminary) and fires `LayeredCache.prefetch(key)`
  under a bounded pool, NOT awaited before scheduling (overlap) but
  awaited before cache.close (no ingest-into-closed-DB). LayeredCache
  gained an `inflight` map + shared `pullFromRemote`: prefetch and the
  lazy get() read-through share ONE in-flight promise per hash → AT
  MOST ONE remote GET per key; execute-task's `cache.get` transparently
  awaits any in-flight prefetch (no execute-task change). Provenance
  stays `cache-hit-remote` via a `remoteSourced` set. GATED ENTIRELY on
  a remote layer — local-only runs derive nothing, prefetch nothing,
  add NO upfront local probe/stat (this is what makes it safe vs the
  reverted local classification that regressed warm runs +57%). Never-
  fail: every remote path (get/put/ingest/prefetch/key-derivation/pool)
  catches ALL errors and degrades to miss; reportRemoteError now also
  guards a throwing onRemoteError callback. Pinned by a test where the
  remote 500s on EVERY request and both cold+warm runs still succeed.
  No CACHE_VERSION bump (only WHEN the remote GET fires changed).

- **2026-06**: **Upfront cache classification — built then REVERTED.**
  An upfront pass (`classify.ts`) computed every task's key + probed
  the cache before execution so the live cache meter (miss /
  up-to-date / local) filled before any work. Pure-input keys (v22)
  made it possible. But it REGRESSED warm runs ~57% (127 ms → 200 ms
  on the 1090-pkg repo, measured A/B): `execute-task` still re-probed
  - re-stat'd every task, so the cache.get + loadOutputFilesBatch +
    isOutputsCurrent ran TWICE per task. The owner caught it ("this
    should do less work not more"). Reverted — the warm bar fills
    imperceptibly fast anyway (~120 ms), the regression hit EVERY run,
    and making it net-free would require reusing the probe result
    through the delicate restore path (entry threading + identical
    skip-restore determination shared between classify and execute) —
    real critical-path risk for an essentially-cosmetic warm-run win.
    Lazy per-task resolution restored (back to ~120 ms). If the upfront
    breakdown is ever wanted for LONG miss runs specifically, `vx run
--dry` already previews it; revisit only with a do-less design that
    has execute reuse the classification probe (no second pass). The
    remote-prefetch follow-up (built on a branch) is also abandoned —
    it depended on this.

- **2026-06**: CACHE_VERSION → v22 + SCHEMA v21: **reverted v21
  early cutoff → pure-input transitive hashing** (owner: "simplify,
  rely only on task input hashes, no output hashes"). Downstream keys
  fold the upstream's INPUT key (its own task hash) again, not its
  output content — a pure function of the filesystem, like Turbo/Nx.
  `upstream.ts` folds `u.hash` (was `u.outputsHash ?? u.hash`); the
  aggregate `outputsHash` machinery is gone (computation in
  writeArtifactAndIndex, `CacheEntry.outputsHash`,
  `TaskOutcome.outputsHash`, `entries.outputs_hash` column,
  `CacheLayer.save` return value, plan threading, group rollup → all
  removed). **Early cutoff dropped**: an upstream that re-runs but
  emits byte-identical output now still re-runs dependents — rare in
  practice, and folding output into keys was what blocked any
  upfront/batched cache probe. **Multi-state preserved**: branch
  ping-pong A→B→A still re-hits, because the upstream's input differs
  per state and folds transitively into every dependent key (pinned
  by a new orchestrator e2e). Two v21 cutoff tests inverted to the
  no-cutoff contract; the `outputsHash`-namespace test removed. This
  followed a deep multi-agent review that found the elaborate v22
  "validity-filter" branch (separate input_key + stored `expects`
  columns) correct but PERF-NEUTRAL as built (it kept the cascade and
  left `probeByInputKeys` unwired) — shelved as
  docs/design/cache-validity-2026-06.md; pure-input is the simpler win
  that actually enables future upfront batching. KNOWN-OPEN: the
  skip-restore "tree already current" check (`isOutputsCurrent`) still
  compares size+mode+second-mtime and can leave stale bytes on a hit
  for same-size/same-second/different-content outputs — pre-existing,
  to be fixed separately with a per-output content hash.

- **2026-06**: Focused-flow live framing gated on a single requested
  task (owner bug report: two concurrent requested tasks interleaved
  `┌─`/`└─` frames into garbage). Live open-at-taskStart /
  close-at-taskComplete only works when ONE task owns the terminal
  between its brackets. Fix: `run()` counts requested non-group nodes
  and threads `requestedCount` into `log.runStart`; the focused logger
  streams live only when `requestedCount <= 1` (0/undefined/1 are the
  live path — default-safe, single-target experience byte-identical).
  With >1 requested task, requested nodes buffer like deps and emit
  ONE atomic block at completion (full frame for success / failure /
  hit-with-replay, one-liner for up-to-date / skipped; failures still
  defer to runEnd). Files: `orchestrator/{logger,run}.ts`; tests in
  `tests/output-flow.test.ts`; `docs/cli.md` focused-flow note.

- **2026-06**: Frame sections + pinned zones + force-floor (owner
  feedback: "hard to see what is a command what is STDOUT. maybe all
  STDOUT and COMMAND should have a group like we have ERROR and
  rename ERROR to STDERR? and no left border | so text wont overlap,
  and easier to copy? also frame need new line at the end to not
  colide with others. Are we able to kind of pin errors always to
  the end? like right after workers? on top of them? Same for
  continuous task always pinned until exit"). Three changes:
  (1) FRAME REDESIGN — blocks are now `┌─ id > <outcome header>`,
  dim section headers `├─ command` (executed tasks only — success +
  failed; the command moved OUT of the failed header, which now
  carries `failed (exit N)` like every other status), `├─ stdout` /
  `├─ stderr` (renamed from Error; only when non-empty after trim),
  `├─ sandbox violations (N)`, then the unchanged footer. Content
  lines are RAW — no `│` border, no indent — because the border
  collided with terminal wrapping and polluted copy/paste. Every
  block AND focused frame-close gets a blank line after (logger
  bookkeeping — emitBlock/emitFrameClose; formatter stays pure), no
  doubles between adjacent blocks. Live frame-open keeps its `$ cmd`
  (the command shares the open line there).
  (2) PINNED ZONES in the status region, top to bottom: failures
  `✗ id ── failed (exit N)` (cap 5 + dim `… +K more failed`,
  accumulate until runEnd — owner picked ON TOP of the workers),
  ready persistent tasks `▸ id ── running` (outcome lands at ready
  while the child runs; SIGTERM at graph end makes runEnd the honest
  end), then worker rows + stats. Pins keep identity-colored ids
  (ids never read as outcomes). Region height now varies; the
  writer's erase-old-height/draw-new-height math handles it (pinned
  by a grow/shrink test).
  (3) FORCE-FLOOR COALESCING — 6,540 forced redraws ≈ 6.7 MB ANSI
  (~5.3µs + ~1KB each) on a 3,270-task warm run. Forced sets within
  30 ms of the last draw mark dirty + schedule ONE trailing draw at
  floor expiry (unref'd; canceled by any draw / clearStatus); final
  state always lands; first draw after idle immediate. 6.7 MB →
  ~20 KB. `OutputWriterOptions.forceFloorMs` (default 30, 0
  disables) + defaultLogger 4th-arg pass-through for tests that
  assert region bytes synchronously. Files: orchestrator/
  {framed-output,logger,status-line}.ts; repinned framed-output/
  output-flow/status-line suites.

- **2026-06**: Header v2 + glyph unification (owner). The run header
  now speaks the summary's language: dim-label rows (`run` = task
  names · N projects · N tasks · N workers; `cache` = local only /
  local + remote), gradient wordmark rule WITH the version at the
  BOTTOM of the header (owner) — the run's output lives between the
  header rule and the summary rule. "packages" → "projects" in user
  copy (owner). Margin (blank line) above. Glyphs unified on
  circles: ● success (green) / failed (red) / skipped (yellow),
  ◌ hits, ▸ persistent, ▶ stats, ▰ meter, braille spinner — the ✗
  and ⊘ glyphs are gone from output (comments may still reference
  the old ✗ contract). Skipped one-liner: `● id ── skipped •
upstream failed`; requested-task skip stays logged in focused
  (the asked-for task's fate must be reported — owner agreed).

- **2026-06**: Failure rendering, final contract (owner-picked
  option B after rejecting both the inline frame and the runEnd ✗
  recap): when a task fails in broad / errors-only / focused-dep
  modes, the stream gets ONE permanent `✗ id ── failed (exit N)`
  line and the run continues; ALL full failure frames replay
  together at runEnd, right above the summary — failures read last,
  uncapped ("at the end logs all full frames of failures"). The
  region's pinned-✗ zone was REMOVED (✗ lines live in scrollback
  now; the stats line keeps the red count); the ▸ persistent zone
  stays. full/CI modes keep frames inline (chronological logs +
  GHA annotations). formatFailurePins → formatFailureLine.
  Frame sections also finalized this round: UPPERCASE bold
  state-colored labels with dim trailing rules to 60 cols (STDOUT
  green / STDERR red / SANDBOX VIOLATIONS yellow), vertical margins
  around content, COMMAND label cut — a dim `$ cmd` line under the
  header carries it.

- **2026-06**: Summary v3 — stacked state meters (owner-driven
  iteration over five revisions in one session; picked from a
  15-design visualization file at /tmp/vx-summary-designs.txt). The
  summary is now: gradient wordmark rule (identity violet→pink
  lerped across the dashes, plain when colors off); a 50-cell
  TASKS meter (failed/success/skipped segments, largest-remainder
  cell allocation, non-zero buckets guaranteed ≥1 cell) with its
  color-coded legend on the line BELOW the bar; failed-id index
  capped at 5 + dim '… +N more' (owner: "there can be hundreds");
  a 50-cell CACHE meter (miss/up-to-date/local/remote) + legend;
  blank line; time row = total + dim 'max · avg · min' per-task
  spread (skipped excluded so min stays honest). The ⚡ instant
  stamp was added (owner-picked over '>>> FULL CACHE' Turbo clone)
  then REMOVED same session (owner: full meter bar carries the
  message). Bars always sum to width; NO_COLOR renders plain ▰ runs
  with the legends carrying the data. Files: orchestrator/summary.ts
  (segmentBar, gradientRule); pins in tests/summary.test.ts +
  output-flow/orchestrator e2e.

- **2026-06**: Focused frames + summary v2 (owner-driven, same
  session). FOCUSED requested tasks now get a LIVE FRAME for every
  outcome — `┌─ id > $ cmd` at taskStart, raw stream between (exec or
  hit replay), `└─ id ── (dur) <word>` at completion — "always full
  frame for a single task even if cached or up to date"; silent
  commands no longer vanish. Skipped requested tasks keep the
  buffered block (they never start, so no open fires). Quiet-hit
  one-liners are gone from focused. formatFrameOpen/Close exported
  from framed-output. END SUMMARY rewritten in the live-line
  language: ` Tasks:    0 failed · 23 success · 0 skipped · 23 total`
  / ` Cache:    23 miss · 0 up-to-date · 0 local · 0 remote` — Tasks
  partitions by how things ended (success includes hits), Cache by
  where results came from (miss+up-to-date+local+remote = total -
  skipped); ZERO-valued buckets render dim, non-zero in live-line
  colors; Failed: listing + >>> FULL CACHE kept. Region stats elapsed
  switched to mm:ss (owner). Files: orchestrator/{logger,
  framed-output,summary,status-line}.ts.

- **2026-06**: Status display v2 — worker region (owner-driven
  iteration, same day). The single status line "jumped too much" on
  broad runs (running count 1→10, names churning), so it became a
  FIXED-HEIGHT WORKER REGION on every interactive view: one row per
  worker slot, sized min(concurrency, 10) — the display derives from
  the stable worker set, not the churning task set. A task takes the
  lowest free row and STAYS there for its whole life; idle rows hold
  their place dimmed; overflow queues for a freed row and shows as
  `+k more`. No worker indexes (owner cut them) — instead the run
  header states the pool: `(N tasks, C workers)`; runStart hook
  carries `concurrency`. Stats line iterated through three owner
  designs (worded buckets → colored bare fractions → REJECTED as
  unreadable in the wild) and landed on labeled colored pairs in two
  groups, every bucket always present in fixed order, miss first in
  the cache group: `▶ 1 failed · 78 success · 759 left · 1090 total
│ 79 miss · 252 up-to-date · 0 local · 0 remote │ 16s` (local =
  yellow, remote = cyan — owner-set). Vocabulary change: `executed`
  → `success` ("executed wording is ambiguous"). Identity coloring
  shipped with it: project half of every id gets a STABLE hue hashed
  from the project name (6-hue cool palette), task half fixed pink,
  separator dim — both deliberately outside the status palette so an
  id can never read as an outcome; applied in frames, one-liners,
  and region rows (region pads by visible length, hue hashes from
  the full name so it survives truncation). formatStatusLine deleted
  (no consumer). Writer gained setRegion: single line keeps legacy
  ESC[2K\r bytes; taller regions erase via `\r ESC[nA ESC[J`.
  Focused replay pin added: requested cache hits stream stored
  stdout raw for EVERY hit kind, up-to-date included (execute-task
  replay is unconditional — owner requirement). Files:
  orchestrator/{status-line,logger,framed-output,run}.ts; tests in
  status-line.test.ts (region mechanics, slot stability, overflow,
  buckets) + repinned framed-output/output-flow/cli suites.

- **2026-06**: Output redesign — flow-aware views + status line.
  OWNER RULES, do not re-litigate: flow is decided by SELECTION FLAGS
  ONLY — BROAD iff `--all` / `--filter` / `--affected` was passed,
  otherwise FOCUSED ("when just run no --all etc then single. cwd
  does not matter" — cwd and task count are irrelevant); broad mode
  keeps one `executed` one-liner per executed task (the news
  principle: executed work IS news, cache hits aren't — hits are
  per-task silent, replay dropped, counts live in the summary).
  Truthy `CI` env (not '0'/'false') → today's full grouped output;
  explicit `--output-logs` ALWAYS overrides. FOCUSED streams
  requested nodes raw + live (hit replay included — `vx run test`
  feels like running the command, just faster; quiet hits keep the
  one-liner, skips frame), deps silent-on-success / framed-on-fail.
  Programmatic run() without `flow` keeps 'full'. One outcome
  vocabulary everywhere: executed / restored-local / restored-remote
  / up-to-date / failed / skipped (TaskStatus enum + --summarize JSON
  keep raw enum values; bucket partition semantics unchanged). GHA:
  in full mode with GITHUB_ACTIONS truthy, blocks wrap in
  `::group::<id> (<word> <dur>)`/`::endgroup::`; FAILED tasks stay
  ungrouped + `::error title=<id>::failed (exit N)`; quiet-hit
  one-liners ungrouped. Status line (TTY && !CI only): single
  `▶ n running · d/t · ids · es [· f failed]` line, ESC[2K+\r rewrite
  (NOT a TUI), 100ms throttle + forced on task events; ALL
  default-logger stdout serializes through one writer
  (orchestrator/status-line.ts) — clear → content → redraw, redraw
  held while focused streaming sits mid-line; cleared permanently at
  runEnd and on first requested-task start in focused. Logger gained
  OPTIONAL runStart/taskStart/runEnd hooks (custom loggers
  unaffected). Test consequence: e2e suites that assert on default-
  logger output must pin env (delete CI/GITHUB_ACTIONS) or pass
  `--output-logs full` — otherwise they behave differently locally
  vs in Actions. Files: cli/run.ts (detectFlow),
  orchestrator/{logger,status-line,framed-output,run,options}.ts;
  tests/{output-flow,status-line}.test.ts.

- **2026-06**: `workspaceFiles` (owner-named) — workspace-root-anchored
  `cache.inputs.workspaceFiles` + `cache.outputs.workspaceFiles`, the
  Turbo `$TURBO_ROOT$` / Nx `{workspaceRoot}` equivalent. OWNER CALL,
  do not re-litigate: **no boundary rule** — these globs resolve from
  the workspace root and may match/capture files inside other
  projects' dirs ("they don't care about boundaries. it is bad
  practice but is there"); the hard nested-dir boundary keeps applying
  to project-relative `files`/`outputs` only, and the docs frame
  workspaceFiles as the documented escape hatch. **No CACHE_VERSION
  bump**, twice over: (a) inputs — resolved workspaceFiles (absolute
  paths) are appended to the same `inputFiles` list; rels are already
  workspaceRoot-relative in `Cache.key`, so they share the namespace
  naturally and a task without the field derives byte-identical keys
  (`workspaceFiles: []` vs absent pinned equal at the resolution+key
  level; the taskConfigHash still differs for the literal `[]` — by
  design, resolved-config hashing); (b) outputs — additive second
  artifact namespace `workspace-outputs/<rel-to-root>` beside
  `outputs/<rel>`; non-users produce byte-identical artifacts.
  outputsHash folds tar names, so the namespace prefix participates
  (`outputs/x` ≠ `workspace-outputs/x`). `output_files` rows: project
  rows stay bare rels; workspace rows store the full
  `workspace-outputs/<rel>` name as discriminator (no SCHEMA bump;
  `workspace-outputs/` is a reserved name for project output rels).
  Input resolution is git-aware via a workspace-wide GitFilesCache
  partition keyed by workspaceRoot: when any loaded config declares
  inputs.workspaceFiles, `populateGitFilesCache(..., workspaceWide)`
  drops pathspec scoping (enumerate '.') and stores files+OIDs for the
  root; unused → enumeration/spawns byte-identical (restore-git-spawns
  - git-oid suites unchanged). Staleness: `markOutputsChanged`
    forwards root-relative paths to the ws partition;
    `markWorkspaceOutputsChanged` fans root-anchored changed paths to
    every partition containing them; cache-miss saves with outputs also
    `invalidateWorkspacePartition()` (undeclared writes are only visible
    to git). `restoreOutputs`/`save` grew optional workspaceRoot /
    workspaceOutputFiles params. Overlapping workspace outputs between
    tasks = user responsibility (documented, not policed). Sandbox
    baseline allowWrite gains root-anchored static prefixes. Migrate:
    `$TURBO_ROOT$/x` + `{workspaceRoot}/x` map to the new fields
    (negation preserved); turbo `globalDependencies` preset spread
    re-pointed into inputs.workspaceFiles — the old files-list mapping
    was wrong (they're root-relative by definition). Watch gap closed
    in a follow-up: when any config declares inputs.workspaceFiles,
    `vx watch` swaps its per-project watchers for ONE recursive root
    watcher (boundaries are off, so any workspace file can be an
    input; the ignore filter still drops node_modules/.git/.vx churn;
    gate checks ALL projects' configs, broken ones skipped per
    scoped-run semantics). Files: config.ts, project-loader,
    cache/{inputs,cache,tar,layered-cache}, orchestrator/{task-hash,
    execute-task,prepare}, cli/migrate-{turbo,nx}; 23 tests in
    tests/workspace-files.test.ts + repinned migrate tests.

- **2026-06**: `vx migrate [--dry] [--force]` — onboarding generator
  from Turbo/Nx. Auto-detects: turbo.json → Turbo path (root
  tasks/pipeline + per-pkg `extends` per-key merge + scripts inlined
  as exec.command; task emitted only where the script exists);
  `.nx/workspace-data/project-graph.json` → Nx path (resolved
  snapshot ONLY — "plugin-inferred targets are frozen as static
  config" in the report header; nx.json-but-no-graph errors with the
  `nx graph --file=…` fixit; both sources → delete-one error).
  Deliberate calls: (a) TODOs are ALWAYS comments, never values —
  every generated config round-trips through loadProjectConfig in
  tests; human-input tasks get the valid placeholder
  `echo 'TODO(vx-migrate): fill in' && exit 1`; (b) turbo `env` maps
  to cache.inputs.env AND exec.env.passThrough (isolated-child-env
  rule), passThroughEnv to passThrough only; (c) turbo globals
  (globalEnv/globalPassThroughEnv/globalDependencies) become exported
  arrays in a generated root `vx-preset.ts` that configs import +
  spread — TS composition replaces turbo's global fields (consistent
  with the rejected named-inputs schema machinery); (d) generated
  configs are plain `export default { … }` with no `@vzn/vx` import —
  loadable in workspaces that haven't installed vx yet; a header
  comment points at defineProject(); (e) nx graph dependency edges
  are ignored (vx derives edges from manifests) except one report
  line counting edges with no manifest dep; (f) never overwrites
  vx.config.\* / vx-preset.ts without --force, and conflicts abort
  before ANY write. Files: `src/cli/migrate{,-turbo,-nx}.ts`; 23
  tests in tests/migrate.test.ts; docs/cli.md `## vx migrate`.

- **2026-06**: Introspection subcommands. `vx show [target]
[--format pretty|json]` prints LIVE resolved configs (same loader as
  the run path, scoped to the named project; deliberately NOT the
  lock — vx-lock.json is already the frozen JSON) — no target lists
  projects with task counts, `<project>` prints per-task blocks,
  `<pkg>#<task>` narrows to one; unknown targets are UserErrors with
  includes-match suggestions. `vx info` is the doctor printout
  (vx/bun/git versions, project + task counts, cache dir/entries/
  size/24h runs via Cache.stats, lock + remote-cache presence) and
  ABSORBED `vx stats`: `stats` stays as a deprecated alias of `info`
  (byte-identical output, help says so). Broken pieces degrade
  per-line (`git: (not found)`, broken config = 0 tasks), never fail
  the printout. Files: `src/cli/{show,info}.ts`; e2e + parser tests
  in `tests/show-info.test.ts`.

- **2026-06**: CLI pass. `--output-logs full|errors-only|none`
  shipped (logger-level gate; summary always prints). The `--cache`
  no-op flag REMOVED (a silently-accepted flag that does nothing is
  a footgun; vite-task parity not worth it). Interactive picker got
  injectable IO + its first tests. Named inputs and target defaults
  (old roadmap #1) REJECTED by owner: TypeScript configs compose —
  shared presets via import ARE our named inputs/defaults; schema
  machinery would duplicate the language. Don't re-propose.

- **2026-06**: Lock consumption moved behind `--frozen` (owner
  decision after a correct soundness rebuttal): byte-hashing a
  config can't see its IMPORT CLOSURE (shared presets), so default
  lock consumption gave false confidence locally. `vx run` = always
  live eval; `vx run --frozen` = configs from vx-lock.json (CI),
  hash tripwire + hard error when lockless; `vx lock`/`--check`
  unchanged as the only full-graph operations. pnpm-style
  auto-relock rejected: scoped runs evaluate only a dep closure and
  can't rewrite a whole-workspace lock. Lockfile renamed
  vx-lock.json (editor JSON recognition, package-lock precedent).

- **2026-06**: `vx lock` / `vx-lock.json` — frozen resolved-config
  lockfile. `vx lock` freshly evaluates every project config in the
  current env (per-invocation module-cache bust; the content-hash
  bust would replay a stale-env evaluation in-process) and writes
  `{ configPath, configHash (xxh3 of file bytes), config (resolved,
JSON-normalized) }` per project to `vx-lock.json`. Deliberate
  ASYMMETRY: **runs trust the lock** — when it exists, `prepareRun`
  loads configs from it after a hash-only file check, zero eval,
  frozen-env semantics (env reads keep lock-time values); stale
  file / missing entry is a hard UserError, never a silent fallback
  to evaluation. **`vx lock --check` audits it** — hash checks PLUS
  full re-eval + strict `Bun.deepEquals` against the stored object,
  catching eval-time env drift hashes can't see; mismatches exit 1
  naming each project ("lock differs from fresh evaluation in this
  environment (<project>) — env-dependent config? …"). This is the
  sound-dependency-story answer to the REJECTED transparent eval
  cache: explicit user action instead of purity heuristics. Only
  project configs are locked (not vx.workspace.\*). No CACHE_VERSION
  bump — keys still hash the resolved config object; the lock just
  pins it. Files: `src/workspace/lockfile.ts`, `src/cli/lock.ts`,
  one hook in `prepare.ts`; e2e in `tests/lock.test.ts`; design in
  `docs/design/config-lock-2026-06.md`.

- **2026-06**: Scoped config loading. prepare evaluated every
  project's vx.config.\* regardless of scope — 1090 imports (~200 ms
  - syscall churn) to run one task. Now only in-scope projects and
    their transitive dep closure load (frontier '^task' expansion
    never escapes the closure); anchored-only invocations scope to
    their anchors. Single-task wall on the 1090-package repo:
    0.32 s → ~0.19 s (turbo: 0.27 s). Deliberate Turbo-like semantic
    change: a BROKEN config in an out-of-scope package no longer
    fails a scoped run — it surfaces when that package enters scope
    (pinned in tests/scoped-config-loading.test.ts). Boundary
    geometry still considers every config-bearing project, loaded or
    not. Also: cache.get() became pure SQL (stdout in entries row,
    SCHEMA v20) — hit cost no longer scales with artifact size
    (118 ms → 5 ms for four ~70 MB binaries); and accessed_at bumps
    batch at flush (247 → ~190 ms on the stress repo, before the
    config-scoping win landed on top).

- **2026-06**: CACHE_VERSION → v21 + SCHEMA v19: **early cutoff**
  (vite-task-inspired, adapted to pre-execution keys). Downstream
  keys fold upstream `outputsHash` — content identity of the
  artifact's `outputs/<rel>` entries (path+bytes, sorted, mtimes
  excluded; computed in `writeArtifactAndIndex` for save AND ingest)
  — instead of the upstream task hash. Identical rebuilt outputs no
  longer cascade misses through the graph. Fallback to task hash
  when no outputs are declared (side-effect safety); groups roll up
  members' cutoff identities so cutoff propagates through umbrella
  tasks; plan path threads entry outputsHash so --dry predictions
  match runs. Two cascade tests re-pinned to the new contract
  (identical-output → dependent hits; output-change → re-runs).

- **2026-06**: CACHE_VERSION → v20 + SCHEMA_VERSION → v18. Input-file
  hashing switched from xxh3-of-content to **git blob OIDs** (Turbo's
  technique): the bulk enumeration spawn became `git ls-files -s
--others --exclude-standard -z` — `-s` lines carry `<mode> <oid>
<stage>\t<path>`, so ONE spawn yields the file lists AND every
  tracked file's index OID; one `git status --porcelain -z` spawn
  prunes paths whose worktree diverges (renames drop both sides,
  stage>0 and symlinks/gitlinks never get one — symlink index OIDs
  hash the target STRING, not content). Clean-tree key derivation
  now costs zero reads / zero per-file stats / zero SQLite (the
  resolveFiles exists-probe is also skipped for OID-trusted paths).
  Everything else falls back to `Cache.hashFile`, which computes the
  byte-identical blob OID in-process (`HASH("blob <len>\0"+bytes)`,
  object format lazily detected via `git rev-parse
--show-object-format`, sha1 default outside repos) behind the
  existing mtime+size memo — so a file's key contribution NEVER
  flips across dirty↔clean transitions (pinned by test: dirty-but-
  identical content == clean key; committing an untracked file
  doesn't change the key). Seam: `CacheKeyInput.fileHashes?:
ReadonlyMap<abs, oid>`; carrier: `GitFilesCache.setOids/oidsFor`
  per projectDir, populated by `populateGitFilesCache` (signature
  now takes GitFilesCache), dropped wholesale on `set`/`delete`
  (mid-run re-enumeration can't re-trust index OIDs without a fresh
  status — fallback is identical-value, so purely a perf
  concession) and per-path on `markOutputsChanged`. File-set
  visibility byte-identical to the old `--cached --others` (verified
  empirically incl. staged-but-deleted, conflict stage-duplicates,
  tab-containing filenames; `-z` disables quotePath so the
  fixed-form `^[0-7]{6} [0-9a-f]{40,64} [0-3]\t` prefix is the
  disambiguator). SCHEMA bump because pre-v20 `file_hashes.
content_hash` rows hold xxh3 digests that must not leak into the
  OID domain via the memo. package.json hashing rides the same map.
  Tests: tests/git-oid.test.ts (18: hash-object KATs incl. sha256
  repos, harvest/trust rules, GitFilesCache bookkeeping, fileHashes
  seam, dirty↔clean key-stability guardrails, zero-read clean-tree
  pin). The two git spawns run CONCURRENTLY
  (`populateGitFilesCache` is now async; the bulk path uses
  Bun.spawn, the per-project fallback stays spawnSync) — serial
  spawning measurably regressed few-files-per-project fixtures,
  since `git status` alone costs ~74 ms on a 1000-project tree.
  Measured: at 1-3 files/project the change is noise (the degenerate
  case); at a realistic 30 files/project (500 projects, 15k files)
  warm run-phase drops 245 ms → 76 ms — 3.2× — and the win scales
  with file count (per-file stat+SELECT replaced by git's C-speed
  scan). Cold first runs also win: committed file contents are never
  read by vx at all.

- **2026-06**: CACHE_VERSION → v19. `'^task'` dependsOn expansion
  switched from transitive-deps to **nearest-holder frontier**: walk
  the package dep graph from the project's DIRECT deps; each path
  stops at the first package declaring the task (edge added there);
  packages without the task are passed through (sparse bridging —
  vx extension over Turbo); nothing past a holder is walked — the
  holder's own dependsOn owns deeper ordering. Turbo and Nx are both
  direct-deps-only; vx's transitive reach existed solely to bridge
  sparse deps, and on dense graphs it exploded edge count (~10x more
  edges than needed on the 1090-package/100-layer report repo),
  driving computeGroupHash sorting (103 ms), addNode dep-sorts
  (66 ms), scheduler closure size, and upstream-hash folding.
  Reachability/ordering closure is identical whenever holders chain
  `'^task'` themselves (the universal pattern); a holder that
  doesn't is now a documented stopping point (Turbo parity). Bumped
  because filtered-upstream-hash sets shrink → same inputs derive
  different keys. Implementation: `PackageGraph.directDeps(name)`
  accessor reintroduced (reads the eager adjacency; bitset closure
  code untouched); frontier walk in `task-graph.ts` replaces the
  `transitiveDeps` loop. `'^*'` in cache.inputs.tasks is a FILTER
  over graph edges (upstream.ts) — untouched; `filter.ts` /
  `affected.ts` transitive traversals are non-expansion consumers —
  untouched. Tests: 4 new frontier pins in tests/task-graph.test.ts
  (nearest-holder chain, sparse bridge, stop-at-holder, shared-
  subtree dedup) + directDeps accessor test.

- **2026-06**: Scheduler priority closure switched to bitsets. User
  report: 10 s FULL-CACHE run on a 1090-package, 100-layer dense
  repo. CPU profile: 8.5 s in `reachOf` — the transitive-reverse-dep
  priority computed via memoized DFS over `Set<string>`s, O(N²)
  entries on dense layered graphs. Replaced with an exact bitset
  closure swept in reverse-topo order (own Kahn pass — correctness
  must not hinge on Map insertion order being topo): O(E·N/32),
  ~1.3 MB at 3270 tasks. Same priority contract, byte-identical
  scheduling. Result: 10.2 s → 1.27 s wall on the report repo.
  Perf guard in tests/scheduler.test.ts (dense 100×30 graph with
  5-layer-deep edges; old code 7.2 s, bound 1.5 s, new code ~50 ms).

- **2026-06**: `persistent.readyTimeoutMs` shipped. A persistent task
  whose `readyWhen` never matches while the child keeps running hung
  the run forever. The timer SIGTERMs the child and rejects ready
  with a timeout message; cleared the moment ready fires. Requires
  `readyWhen` (loader-enforced); deliberately no default. Also
  2026-06: a resolved-config eval cache (cache pure-literal configs
  on content hash to cut the 199 ms config-eval cost at 1000
  projects) was designed and REJECTED by the owner — the static
  purity gate is correctness-critical heuristic machinery for a
  modest win. Rationale + numbers in docs/benchmarks.md headroom;
  don't re-propose without a sound dependency story.

- **2026-06**: Module-isolation series complete (steps 1-7 of
  `docs/design/module-isolation-2026-06.md`). `src/` is now eight
  contract modules (`util`, `config`, `workspace`, `graph`, `cache`,
  `exec`, `orchestrator`, `cli`) plus three root files (`bin.ts`,
  `index.ts`, `version.ts`). Each directory module's `index.ts` is
  its contract; cross-module imports of internals fail
  `tests/module-boundaries.test.ts`, which also pins the allowed
  dependency matrix (composition only at orchestrator + cli;
  `cli → exec` deliberately absent). What landed across the series:
  cycle breaks via `version.ts` + `orchestrator/options.ts` (step 1);
  `ProjectEntry`/`nested-dirs`/`fingerprint` → workspace and
  `plan-format` → cli relocations (step 2); hashing surface split out
  of `execute-task.ts` into `orchestrator/task-hash.ts` — kept in
  orchestrator, NOT cache, because key-part selection composes graph
  types (step 3); leaf contracts cache/exec/util (step 4), then
  workspace/graph (step 5); finally `orchestrator.ts` →
  `orchestrator/{index,run}.ts` and `cli.ts` → `cli/index.ts`, with
  CONTRACTED covering every directory module (step 6) and the docs
  refresh (step 7). Zero behavior change throughout; public API of
  `src/index.ts` byte-identical; no CACHE_VERSION bump (key
  derivation untouched). Convention going forward: new cross-module
  surface is exported from the owning module's `index.ts`, and any
  new top-level file/dir forces an explicit matrix decision in the
  boundary test.

- **2026-06**: HMAC artifact signing for the remote cache, gated by
  `VX_REMOTE_CACHE_SIGNATURE_KEY` (roadmap item #2's signing half;
  pre-signed URLs still open). Byte-compatible with Turbo's
  `signature_authentication.rs` scheme so vx interops with signing
  servers/clients: `tag = base64(HMAC-SHA256(key, utf8(hash) ||
utf8(teamId ?? '') || artifactBytes))`, carried in `x-artifact-tag`.
  Implementation lives entirely in `RemoteCache`
  (`RemoteCacheConfig.signatureKey?: string`; env parsed in
  `remote-cache-setup.ts`): PUT signs the outgoing bytes, GET verifies
  the response tag against the received body via
  `crypto.timingSafeEqual`. Two deliberate calls: (a) missing tag on
  GET is a hard `RemoteCacheError` when the key is set — a signing
  deployment must not silently accept unsigned artifacts (Turbo
  verifies too; the hard-fail-on-missing is stricter); (b) we kept
  Turbo's `teamId` in the construction, NOT the `taskId` variant the
  integrity-audit sketch proposed — interop wins. No key → behavior
  byte-identical to before (no header, no verification). LayeredCache
  needed zero changes: the verification error rides the existing
  RemoteCacheError → `onRemoteError` + cache-miss degradation, so a
  tampered artifact re-executes the task. Tests: signing block in
  `tests/remote-cache.test.ts` (tag KAT computed in-test with
  node:crypto, missing-tag, tamper, no-key passthrough, empty-teamId
  folding), tamper-degrades-to-miss e2e in
  `tests/layered-cache.test.ts`, env→wire round-trip + tamper-recovery
  e2e in `tests/orchestrator-remote.test.ts`. No CACHE_VERSION bump —
  the artifact bytes and key derivation are untouched.

- **2026-06**: Warm-restore git re-spawn fix. User report: restoring
  100 tiny outputs took 920 ms vs 113 ms intact (8x). Evidence: a git
  PATH-shim showed 81 per-project `git ls-files` re-spawns — the
  post-restore `gitFilesCache.delete` from the v14-era staleness rule.
  Fix: `GitFilesCache` class (extends Map; same bulk-populate API). On
  restore we know the exact changed paths (cleaned declared outputs +
  artifact outputFiles) — `markOutputsChanged` records them and
  `snapshotFor(globs)` reuses the snapshot when a downstream task's
  input globs can't match any changed path (provably identical to a
  re-spawn; glob matching ignores gitignore status when paths don't
  match). Overlapping globs still re-spawn → gitignore semantics
  byte-identical. Save path keeps the unconditional drop (undeclared
  writes are only visible to git). `cleanOutputs` now returns the
  deleted rel paths. Result on the report repo: 920 ms → 136 ms, git
  spawns 81 → 1. Tests: tests/restore-git-spawns.test.ts pins both
  spawn counts AND the fallback's cache-hit stability via a CLI
  subprocess + PATH shim (in-process PATH mutation doesn't affect
  Bun.spawn executable resolution). Also: bench/ folded into
  tsconfig + lint inputs (its absence rode a stale lint cache-hit).

- **2026-06**: SIGINT/SIGTERM handling in `run()`. Closes the
  runner-comparison gap "children orphaned on mid-run signal": a
  programmatic signal to the vx process alone (CI cancellation,
  `kill <pid>`) previously left one-shot AND persistent children
  running. Design: a run-scoped `liveChildren: Set<Subprocess>` —
  `runCommand` / `runPersistent` / `runSandboxed` add each child on
  spawn and remove it on exit (new optional `liveChildren` field on
  their options). `run()` installs SIGINT/SIGTERM handlers after the
  cache opens and removes them in a `finally`, so repeated runs in
  test suites never stack listeners. On signal: SIGTERM everything in
  `liveChildren` + `persistentRegistry`, close the cache handle, then
  `process.exit(signalExitCode(signal))` — 130/143 per the POSIX
  128+signo convention (`signalExitCode` is a new export in
  `src/exec/runner.ts`). v1 deliberately does NOT cancel scheduling
  or plumb AbortController through executeTask — the process exits
  immediately after forwarding SIGTERM. Known limit: only direct
  children are signalled (no process groups), so a double-forking
  task can still orphan grandchildren. Watch mode opts out via the
  new `RunOptions.handleSignals: false` — the loop owns signal
  disposition for its whole lifetime (its `process.once` handlers
  close watchers and resolve 0); a cycle's run() exiting the process
  would kill the loop (and, in tests, the bun test process — the
  watch e2e suite simulates Ctrl-C with `process.emit('SIGINT')`,
  which is delivered to every listener in-process). New
  `tests/signal-handling.test.ts`:
  3 e2e tests spawn the real CLI and assert exit code + child death
  via pidfile + `kill(pid, 0)`, 1 in-process test pins listener
  counts across repeated runs.

- **2026-06**: CACHE_VERSION → v18. Env-value folding in `Cache.key()`
  switched its name/value delimiter from `=` to `\0` — `("A", "B=C")`
  and `("A=B", "C")` folded identical bytes. Unreachable from a real
  POSIX environ (names can't contain `=`), bumped anyway: the key
  derivation's invariant is unambiguous part boundaries, and file
  inputs already used `\0`. Found by the June 2026 six-reviewer bug
  sweep, which also produced: run() counting remote hits as failures
  (PR #109 — the `ok` predicate omitted `cache-hit-remote`; first e2e
  remote-layer test added), absolute-path validation gap in
  `cache.inputs.files` (PR #110), macOS sandbox `allowWrite: ['/tmp']`
  never matching because SRT keeps the literal path when bare-`/tmp`
  symlink resolution trips its boundary guard — vx now realpaths user
  sandbox paths itself (PR #111), and corrupt remote artifacts going
  live before validation + crashing the run instead of degrading to a
  miss (PR #113, typed `CorruptArtifactError`, validate-before-rename).

- **2026-05**: Dead-code cleanup pass — drop the TUI-era observer
  subsystem and other no-consumer surfaces. -1305 LOC across 28 files,
  no behaviour change.

  Removed:
  - **Observer subsystem** (`src/orchestrator/observer.ts` deleted):
    `Observer`, `ObserverEvent`, `HistoryTable`, `TaskHistory`,
    `makeSafeObserver`, and the `RunOptions.observer` field. The TUI
    consumed this; the TUI was deleted weeks ago. Six tests removed
    (the dedicated observer.test.ts plus the three orchestrator-level
    observer e2e tests). Scheduler's `slot` parameter on
    `execute`/`onStart` was part of this surface — dropped along with
    the `Uint8Array` slot allocator (the no-consumer-side benefit was
    "stable per-slot timelines for TUI panels" which no longer have
    a renderer).
  - **`Cache.getTaskHistory` + `TaskHistoryRow`/`TaskHistoryMap`**:
    designed to feed TUI ETA + Bottlenecks panels. No production
    caller. ~110 LOC including the per-pair CTE query.
  - **`Cache.getMetaBatch` + `CacheEntryMeta`**: batch metadata probe
    for a leaf-task upfront-batch optimization that never wired into
    `execute-task.ts`. ~50 LOC + 90 LOC of perf tests.
  - **`LayeredCacheOptions.onRemoteRequest`/`onRemoteHit`**: drove the
    TUI's remote-cache panel. Telemetry survived only as the
    `onRemoteError` hook the CLI uses to log warnings.
  - **`RemoteCache.has` + `batchExistence` + `RemoteBatchInfo`**:
    speculative API surface, no caller. Same for `tag`/`ci`/
    `interactive` metadata on `RemotePutMetadata` and `tag` on
    `RemoteGetResult`.
  - **`PreparedRun.projects`/`packageGraph`**: returned but never read
    by `run()` or `planRun()`. Tests asserting on them rewritten to
    assert on `nodes`.
  - **`PackageGraph.byName`/`directDeps`**: on the interface but no
    consumer reads them outside the constructor. Kept as locals
    inside `buildPackageGraph`.
  - **`TaskOutcome.stdout`/`stderr`**: populated by `execute-task.ts`
    but no production reader (live stream goes through
    `taskStdout`/`taskStderr` logger callbacks). The two
    orchestrator tests that asserted on `o.stderr`/`o.stdout` now
    assert on the live `fixture.err`/`fixture.log` arrays instead.
  - **`RunRecord.bytesUploaded`/`bytesDownloaded`** + the matching
    SQL columns: never populated by production. Schema row narrowed.
  - **`noopLogger()`**: zero callers, comment referenced the deleted
    TUI.
  - **`WatchLoopArgs.cacheDir`**: passed through then explicitly
    `void`-discarded; ~5 LOC + one less file read at startup.

  Refactors:
  - **`formatTaskBlock(body: TaskBlockBody | string)`** narrowed to
    `body: TaskBlockBody`. The string-body back-compat existed for
    "older tests + embedders" — pre-alpha, no embedders, tests
    rewritten to wrap in `{ stdout: '...' }`.
  - **`listGitTrackedFiles`** (3-line wrapper around `runGitLsFiles`)
    inlined. Caller now calls `runGitLsFiles` directly.
  - **`xxh3hexOf`** (3-line wrapper) deleted; two callers inline
    `.toString(16).padStart(16, '0')`.

  Bug fix bundled in:
  - **`vx cache prune` honors `defineWorkspace({ cacheDir: ... })`**.
    Previously hardcoded `path.join(root, '.vx', 'cache')`, so a
    user-relocated cache dir was silently pruned against the wrong
    path. Now uses `resolveCacheDir(root, workspaceConfig)`.

  Verified: 499 tests pass, `oxlint` + `oxfmt` clean. Cache key
  derivation unchanged; the SQL schema dropped only NULL-only
  columns. Existing `<hash>.tar.zst` artifacts still load (the v17
  format from the previous pass is unchanged).

- **2026-05**: Drop the `ignore` npm dep — vx now hard-requires git.
  `src/cache/inputs.ts` no longer parses `.gitignore` via the `ignore`
  library; it defers entirely to `git ls-files --cached --others
--exclude-standard` for the input file set. When git is absent or
  the workspace isn't a git work tree, `resolveFiles` (and
  `populateGitFilesCache`) throw a `UserError` with a clear "vx
  requires git: run `git init`…" message instead of silently
  degrading. Net: -1 npm dep, -~30 LOC (`loadGitignore` gone), tests'
  `makeWorkspace()` helpers gained a 3-line `git init` block.

  Also fixed: a latent staleness bug in the bulk `gitFilesCache`
  snapshot. The snapshot is taken at the top of a run; if an
  upstream task in project P writes outputs, a downstream
  same-project task that resolves inputs after it would otherwise
  miss those files. `execute-task.ts` now drops the project's cache
  entry after cache.save (cache miss) or cache.restoreOutputs
  (cache hit) when the task has declared outputs — the next
  resolveFiles call re-spawns git for that dir. Pre-existing bug;
  the previous non-git fallback masked it by walking the live FS.

- **2026-05**: Cache v17 — artifact carries only logs + outputs;
  unified local/remote format; stderr no longer cached.

  The cache artifact (`<cacheDir>/<hash>.tar.zst`) is now exactly:

  ```
  stdout            (always present; may be empty)
  outputs/<rel>     (declared output files, when any)
  ```

  No more `meta.json`, no more stderr entry. The artifact carries only
  replayable bytes; entry metadata (taskId, command, durationMs,
  storedAt) lives in the SQLite `entries` row — the queryable index.

  Local and remote layers transport the **same** tar.zst bytes
  end-to-end. `cache-archive.ts` (the parallel tar.gz format with
  meta.json) is gone, along with `LayeredCache.stageAndPack` /
  `unpackArchive` / the stage-dir dance. `LayeredCache.save` reads
  the just-written local artifact off disk and uploads it verbatim;
  on remote-hit, the body is written straight to `<hash>.tar.zst`
  and ingested via `Cache.ingest(hash, bytes, meta)`.

  Metadata routing: `CacheLayer.get(hash, ctx?)` accepts an optional
  `{ taskId, command }` context. The local Cache ignores it (entries
  row has everything); the LayeredCache forwards it to `ingest()` on
  remote-hit alongside `durationMs` pulled from the remote response's
  `x-artifact-duration` header. Orchestrator + plan call sites have
  `node` in scope, so passing ctx is essentially free.

  Why drop stderr? We only cache successful runs (the `effectiveExitCode
=== 0 && cacheEnabled` gate in `execute-task.ts`). Successful runs
  rarely write meaningful stderr; storing it cost artifact bytes for
  near-zero value. Live runs still stream stderr through the logger,
  failed-task stderr still surfaces on the outcome and via the framed
  block — only the cache-hit replay path changes (stdout only).

  Why always store stdout? Predictability: the archive layout is now
  exactly "one `stdout` entry + zero-or-more `outputs/<rel>` entries".
  No conditional branches at extract time, no "is this entry missing
  because the original stdout was empty, or because the artifact is
  corrupt?" ambiguity.

  `CACHE_VERSION` + `SCHEMA_VERSION` bumped to v17. Old entries are
  dropped on first run (schema gate); old artifacts become orphans
  and reap on `vx cache prune`. Pre-alpha, no migration cost.

  Net: −1 module (`cache-archive.ts`), −1 test file
  (`cache-archive.test.ts`), 506 tests pass, `oxlint` + `oxfmt` clean.
  `Cache.save` internally split into `packArtifact` + private
  `writeArtifactAndIndex`; the latter is the shared path both `save`
  and `ingest` write through, so the SQL-row insertion logic lives in
  exactly one place.

- **2026-05**: Refactor pass — perf + simplification, no behavior change.
  Thirteen focused tweaks across the hot paths, all preserving public
  API and cache key derivation:
  1. **Scheduler tick is now O(N + E)** instead of O(N²). Old loop
     walked `scheduleOrder` (every node) on every completion. New
     design: `pending[id]` dep-counters + a `ready[]` priority queue
     pushed-to on `pending → 0`. Slot allocator switched from a
     sorted free-list (`unshift + sort` per release) to a
     `Uint8Array` busy bitmap with a linear scan over `[0,
concurrency)`. Same priority contract: higher transitive-reverse-
     dep count first, ties break in graph-insertion order via a
     binary-search-insert that respects existing equals.
  2. **`detectCycle` is iterative** with a numeric-indexed
     `Uint8Array` color array instead of recursion + `Map<string,
number>`. Removes V8 stack-frame ceiling risk on deep `dependsOn`
     chains and skips the per-node Map lookup cost.
  3. **`nested-dirs.ts` is O(P log P)** instead of O(P²). Sort projects
     by `dir`; each project's nested set is the contiguous prefix-
     matched suffix immediately after it. Same output, no behaviour
     change.
  4. **Logger buffers chunks as `string[]` then joins on flush** —
     replaces `Map<string, string>` accumulation via `+=`, which was
     O(N²) over total bytes for chatty long-running tasks (each `+=`
     allocates a fresh string of full accumulated length).
  5. **Dead tar manifest API removed** from `src/cache/tar.ts`:
     `Manifest`, `ManifestEntry`, `buildManifest`, the optional
     `manifest?` arg to `extractOutputs`, and the skip-if-matches
     branch + `ExtractResult` return. v16 dropped the manifest.json
     entry from the artifact already (file fingerprints live in the
     `output_files` SQL table); the API surface lingered with no
     callers. ~70 LOC down.
  6. **`prune` deletes in a single transaction + parallel rm** instead
     of N round-trips + serialized unlinks. ON DELETE CASCADE handles
     `output_files`. Hashes are bound with placeholder IN-list (≤ N
     stay well under SQLite's 999 limit in practice).
  7. **`workspace.listProjects`** runs the package globs concurrently
     via `Promise.all` (was serialized). Same dedup pass after.
  8. **`Bun.color` results memoized** in `src/orchestrator/colors.ts`.
     Pure function called thousands of times per run with one of four
     hex strings — the new `ansiCache` Map turns those into hits.
  9. **`Bun.Glob`** replaces hand-rolled `globToRegex` in
     `src/workspace/filter.ts:matchProjects`, and replaces the
     readdir + recurse + dynamic-import in
     `src/cache/layered-cache.ts:listFilesRecursive`.
  10. **`AbortSignal.timeout`** replaces the manual
      `AbortController + setTimeout + clearTimeout` ceremony in
      `RemoteCache.fetch`. Also catches `TimeoutError` in addition
      to `AbortError` for the timeout path.
  11. **`toPosix` Linux fast-path** — returns `p` unchanged when
      `path.sep === '/'`, skipping `split + join` on the dominant dev
      platform.
  12. **Hoisted dynamic import** out of `prepareOutputsForBind` (was
      `await import('node:fs/promises')` per sandboxed task) and out
      of `listFilesRecursive` (was per-call).
  13. **Cleanups**: `void id` dead loop var in the persistent-task
      shutdown loop (Bun's `Subprocess.kill` is idempotent on exited
      children), redundant `tasks.length === 1` ternary in
      `formatHeader`, `.map(String)` defensive coercion on an already-
      typed `readonly string[]` in `cli/run.ts:parseRunArgs`, and a
      `filter().map()` two-allocation idiom in `upstream.ts` →
      single-pass `for-of` push.

  Verified: 518 tests pass (no test changes); `oxlint --type-aware
--type-check` clean; `oxfmt --check` clean. Cache schema/format and
  cache key derivation unchanged — no `CACHE_VERSION` bump needed.

- **2026-05**: Sandbox refactored to per-task config + fail-on-violation.
  Drops the `--sandbox` CLI flag and `RunOptions.sandbox` entirely;
  activation is declarative via `sandbox: {}` (or `sandbox: { ... }`)
  in each task's config. No workspace inheritance, no built-in escapes
  for `node_modules` / `/tmp` — users declare everything explicitly so
  a single `vx.config.ts` describes the full task permission surface.
  `SandboxConfig` in `src/config.ts` mirrors SRT's full user-facing
  schema (filesystem allow/deny, network as `boolean | NetworkConfig`,
  `allowGitConfig`, `allowPty`, `enableWeakerNestedSandbox`,
  `enableWeakerNetworkIsolation`, `ignoreViolations`) with strict
  loader validation (allowlist of known fields, type checks, no globs
  in path lists). Policy switched from "detect-and-skip-cache" to
  **fail-on-violation**: on macOS, a non-empty `SandboxViolationStore`
  after exec forces exit code 1 + appends violation lines to stderr;
  on Linux, bwrap's structural deny means the child sees `ENOENT` and
  typically fails naturally. Lazy SRT init — `probeSandbox` +
  `initSandbox` only fire when at least one node in the graph has
  `node.config.sandbox`. Baseline `allowRead` = resolved
  `cache.inputs.files`; baseline `allowWrite` = static prefix of every
  `cache.outputs.files` glob; baseline `denyRead` = workspace root.
  Linux silent-swallow case (tools that catch `ENOENT` and continue)
  is acknowledged — strace-based per-process detection coming in a
  follow-up commit on the same branch.

- **2026-05**: Sandbox revived as opt-in layer via
  `@anthropic-ai/sandbox-runtime` (SRT). New module
  `src/exec/sandbox-runtime.ts` is a thin wrapper around SRT's
  `SandboxManager` + `SandboxViolationStore`. Initially shipped with
  a `--sandbox` CLI flag + "detect-and-skip-cache" policy; refactored
  the same day (see entry above) after user feedback to per-task
  config + fail-on-violation.

- **2026-05**: Bun-builtins audit. Replaced the hand-rolled 50-LOC
  Crockford-base32 ULID generator (`src/util/ulid.ts`) with a thin
  wrapper over `Bun.randomUUIDv7()`. UUIDv7 is RFC 9562's timestamp-
  prefixed UUID — 48-bit ms-epoch + 74 bits of randomness, lex-
  sortable, standard format. `run_id` strings change from 26-char
  Crockford (`01JABC…`) to 36-char hex (`019e3255-9a99-7000-…`); pre-
  alpha so no migration burden. Wider audit findings recorded for
  posterity: `Bun.Archive` benchmarked **15-400× slower** than our
  `extractOutputs` for typical cache artifacts (KB-MB range, flat
  trees) — fixed JS-bridge overhead dominates Bun.Archive for small
  archives. Kept our hand-rolled `parseTarHeaders` + `extractOutputs`
  in `src/cache/tar.ts`. APIs we already use: `Bun.YAML`,
  `Bun.Glob`, `bun:sqlite`, `Bun.hash.xxHash3`,
  `Bun.zstdCompress/Decompress`, `Bun.spawn`, `Bun.color`,
  `Bun.file`, `Bun.write`, `Bun.nanoseconds`, `Bun.sleep`. APIs with
  no consumer in our code: `Bun.semver`, `Bun.deepEquals`,
  `Bun.stripANSI`, `Bun.stringWidth`, `Bun.which`, `Bun.JSONC`,
  `Bun.TOML`, `Bun.password`, `Bun.markdown`, `Bun.serve`. `Bun.env`
  is an alias for `process.env`; pure cosmetic swap not worth the
  churn. `fs.watch` in `src/cli/watch.ts` has no Bun equivalent.
- **2026-05**: CACHE_VERSION → v15. Hash algorithm swapped from
  SHA-256 (`Bun.CryptoHasher`) to xxHash3 (`Bun.hash.xxHash3`) at
  every cache-key derivation site: `Cache.key()`,
  `hashFileFromDisk()`, `hashTaskConfig()`, `computeGroupHash()`,
  `computeWorkspaceFingerprint()`, and the config-load module
  cache-busting in `project-loader.ts`. Cache keys shrink 64 hex →
  16 hex (matches Turbo's xxh64 width), derivation is ~5× faster on
  the cache-warm path. xxHash3 has no streaming Hasher API in Bun,
  so `Cache.key()` chains updates via the seed parameter
  (`xxh3(part, prevDigest)`); `hashFileFromDisk` reads the whole
  file before hashing — fine for source files. New shared helper
  `src/util/hash.ts` exporting `xxh3`, `xxh3hex`, `xxh3hexOf`.
  SCHEMA_VERSION bumps to v15 in the same change (PR #86's tar.zst
  work already took v14): `file_hashes.sha256` column →
  `content_hash`, and the migration path now `DROP`s stale tables
  before `CREATE TABLE IF NOT EXISTS` runs so column renames take
  effect on existing DBs. PR #87.
- **2026-05**: TUI dropped entirely. After six PRs (#73, #74, #75,
  #76, #77, #79, #80, #81) trying React, then Solid, then patching
  the painter, the user's verdict was "still freezing, no screens
  for tasks without logs, very bad — drop it for now." The right
  call. `src/tui/` deleted, `@opentui/*` / `solid-js` /
  `xterm-headless` / `@types/babel__core` removed, `bunfig.toml`
  removed, `tsconfig`'s `jsx` / `jsxImportSource` reverted, the
  `--tui` / `--no-tui` CLI flags removed.

  What survived from the TUI work:
  - `src/orchestrator/observer.ts` — the tagged-union `Observer`
    contract + `makeSafeObserver` wrapper. Useful for embedders,
    future dashboards, structured-event consumers.
  - `RunOptions.observer?: Observer` wiring + emit sites in the
    orchestrator (`runStart`, `taskStart`, `taskStdout/Stderr`,
    `cacheProbe`, `taskComplete`, `runEnd`, `remoteCache`). No
    runtime cost unless a consumer subscribes.
  - Scheduler worker-slot allocation (`runGraph` allocates lowest-
    free-index slots, passes `slot: number` to `execute()` /
    `onStart()`). Stable allocation across runs.
  - `Cache.getTaskHistory(taskIds)` — batched SQL CTE returning a
    `TaskHistoryMap`. Used by `prepareRun` so any future consumer
    has per-task aggregates cheap.
  - `LayeredCacheOptions.onRemoteRequest` — remote-cache request
    callback. Currently no consumer; useful when telemetry lands.
  - `noopLogger()` in `src/orchestrator/logger.ts` — minimal
    Logger that drops every call. Already used by embedders.
  - Design docs `docs/design/tui.md`, `docs/design/tui-design.md`,
    `docs/design/tui-rebuild.md`, `docs/design/tui-claude-code.md` —
    kept as a record of what was explored and why it didn't ship.

  Tests: 506 → 434 (deleted all TUI-specific tests + the `--tui`
  parser test). The remaining 434 cover orchestrator, scheduler,
  cache, CLI, watch, persistent tasks, observer, etc.

  Lessons logged in `docs/design/tui-claude-code.md`: production-
  grade terminal UIs (Claude Code, lazygit, fzf, btop) all
  hand-roll the cell-buffer + ANSI emitter. They use
  `react-reconciler` for the component API but write the painter
  themselves. The existing React/Solid-on-OpenTUI stack has too
  many leaky abstractions for our use case.

- **2026-05**: TUI rebuild — wholesale rewrite on `@opentui/solid`
  - `@opentui/keymap` + `xterm-headless`, scrapping the React-based
    Phase 1-3B implementation. Three drivers (see
    `docs/design/tui-rebuild.md`):
  1. **opencode uses Solid not React.** The OpenTUI maintainers'
     own TUI runs on `@opentui/solid`; the React reconciler caused
     the ghosting / overlay-bleed problems we kept fighting. Solid's
     fine-grained reactivity has no VDOM diff to race the OpenTUI
     painter.
  2. **`xterm-headless` for per-task log panes.** Mirrors Turbo's
     `vt100` parser: each task's stdout/stderr feeds an
     `xterm-headless` Terminal; the pane reads `buffer.active.getLine`
     rows. Build-tool output (`\r` overwrites, ANSI cursor escapes,
     progress bars) now renders correctly. xterm-headless 5.x still
     references browser `window`/`self` globals in its bundle — we
     shim them to `globalThis` before importing.
  3. **Scope cut to match Turbo.** One screen: TaskList (left,
     sorted Turbo-style — running first w/ spinner, planned, then
     finished by failure→success→cache) + LogPane (right, reads the
     selected task's pty buffer) + StatusBar + Help dialog. No 5
     view-tabs, no sparklines, no critical-path widget, no auto-exit
     countdown. q / Ctrl-C exits.

  Architecture mirrors opencode's TUI:
  - `src/tui/context/helper.tsx` — `createSimpleContext` factory.
  - `src/tui/context/{theme,run-state,pty-store}.tsx` — Solid
    contexts (no single reducer; each subsystem owns its state).
  - `src/tui/ui/dialog.tsx` — modal Dialog using
    `position="absolute"` full-viewport with `zIndex={3000}` +
    translucent `RGBA.fromInts(0,0,0,150)` backdrop, popup centered
    inside via `alignItems="center" + paddingTop`. Opencode's exact
    pattern.
  - `src/tui/component/{task-list,log-pane,status-bar,pty-output}` —
    components + the xterm-headless wrapper.
  - `src/tui/overlay/help-dialog.tsx` — Help bound to `m`
    (Turbo convention).
  - `src/tui/tui.tsx` — entry: `createCliRenderer` + `render(<App />)`
    inside `ThemeProvider > RunStateProvider > PtyStoreProvider >
DialogProvider`.

  Tsconfig: `jsx: preserve`, `jsxImportSource: @opentui/solid`.
  `bunfig.toml` adds `preload = ["@opentui/solid/preload"]` for
  `bun run` / `bun test`; the CLI also does
  `await import('@opentui/solid/preload')` before lazy-loading the
  TUI so installed-binary users (different cwd) also get the
  babel-preset-solid plugin registered.

  Deps: removed `@opentui/react`, `react`, `@types/react`. Added
  `@opentui/solid`, `@opentui/keymap`, `solid-js`, `xterm-headless`,
  `@types/babel__core` (for tsc strictness against the OpenTUI
  preload script).

  Tests: 506 → 436 (deleted the React-binding-specific tests; kept
  the orchestrator-side Observer + scheduler tests). One Solid smoke
  test verifies the new TUI mounts under OpenTUI's `testing: true`
  mode.

- **2026-05**: TUI Phase 3B — polish PR. Three additions on top of
  Phase 3 (497 → 506 tests):
  1. Filter input (`/`). State gains `filterEditing: boolean`; the
     reducer adds `startFilterEdit` / `endFilterEdit` key actions.
     The App's keyboard handler routes printable keys + Backspace +
     Enter/Esc to filter editing when active. `selectFilteredTasks`
     is a substring (case-insensitive) match on `${project}#${task}`
     keyed by `state.filters[activeView]` (per-view, not global).
     The TaskList title shows the active filter.
  2. **Post-run auto-exit** (3s, cancelable). On `runEnd`, the
     reducer sets `state.autoExitAt = Date.now() + 3000`. A new
     `AutoExit` overlay shows a 1Hz countdown over the final frame.
     Any key dispatch clears `autoExitAt` (the user is engaged; the
     TUI stays open until they press q). The sampler tick flips
     `autoExitTriggered` when the deadline passes; `startTui` exposes
     `waitForExit()` that resolves on q / Ctrl-C OR autoExitTriggered.
     `cli/run.ts` awaits it between `runEnd` and `dispose()`.
  3. Context-sensitive `StatusBar` — keymap hints change by
     `activeView` (Overview vs Graph vs Workers vs Bottlenecks vs
     Queue) and by mode (filter-editing vs help-open vs default).
     Shows the view name + number on the left.

- **2026-05**: TUI Phase 3 — multi-view + overlays + stats panel.
  Adds the four follow-on views (Graph, Workers, Bottlenecks, Queue)
  and two overlays (Help, Task Detail) on top of Phase 2B's
  Overview layout. Keyboard: `1`-`5` selects view; `?` toggles
  Help; Enter opens Task Detail; Esc closes overlays. The reducer
  gained two per-tick counters (`completedSinceTick`,
  `remoteOpsSinceTick`) so the 1 Hz sampler now drives real
  throughput + remote-ops sparklines (Phase 2A's stubbed `0`s are
  gone). New `StatsPanel` shows the three sparklines stacked under
  the task list on Overview. `Bottlenecks` runs the topo-DP
  critical-path live and ranks top blockers / slow-vs-history /
  cache-miss impact via the Phase 2A selectors. Tests: 497 → 499
  (added reducer key/overlay tests). All Phase 1-2 surfaces
  unchanged.

- **2026-05**: TUI Phase 2B — OpenTUI renderer shipped behind `--tui`
  (explicit only; auto-promote is Phase 3). Single-screen layout:
  Header (run id, status counts, parallel %), TaskList (left), LogPane
  (right, follows selection), ProgressBar (filled-bar + N/M + %),
  StatusBar (keymap hint). Components live in `src/tui/components/`;
  `src/tui/App.tsx` switches view by `state.activeView` (only view 1
  for Phase 2B). `src/tui/tui.ts` is the single import site for
  `@opentui/react` — wraps `createCliRenderer` + `createRoot`, builds
  a `Observer` that dispatches into the Phase 2A reducer, runs a
  paint-debounced render loop (33ms) and a 1 Hz sparkline sampler.
  Renderer-swappable: only `src/tui/tui-shim.ts` imports OpenTUI.
  Renderer falls back silently to framed-block when stdout/stdin
  isn't a TTY, NO_COLOR is set, CI=1, or term < 80×20; explicit
  `--tui` surfaces a `vx: TUI unavailable (<reason>)` line. Tests:
  495 → 497 (added a smoke test + CLI flag parser tests). Manual
  e2e verified `--tui` disqualifier path; live TTY render path is
  exercised by `startTui({ testing: true })` (OpenTUI's headless
  mode).

- **2026-05**: TUI Phase 2A — renderer-agnostic foundation. Pure-
  function modules under `src/tui/`: `should-use-tui.ts`,
  `primitives/{sparkline,timeline-layout}.ts`,
  `state/{store,selectors,critical-path}.ts`. All TDD-driven, no
  JSX, no renderer dependency. Tests: 434 → 495.

- **2026-05**: TUI Phase 1 foundation — orchestrator-side scaffolding,
  no renderer yet. Five focused additions (no behaviour change for
  non-TUI runs, 414 → 434 tests):
  1. New `src/orchestrator/observer.ts` exporting a tagged-union
     `ObserverEvent` (`runStart` | `taskStart` | `taskStdout` |
     `taskStderr` | `cacheProbe` | `taskComplete` | `remoteCache` |
     `runEnd`), an `Observer` interface, and `makeSafeObserver(inner)`
     that swallows throws from `inner.emit` so a buggy TUI never
     crashes the run. Logger stays parallel — it owns terminal
     framed-block output; Observer is the structural sink.
  2. `RunOptions.observer?: Observer` wired through `orchestrator.run()`.
     Emit sites: `runStart` after header writes; `taskStart` from the
     scheduler's `onStart` (now `(node, slot)`); `cacheProbe` from
     `execute-task.ts` after `cache.get(hash)`; `taskComplete` from
     scheduler's `onFinish`; `runEnd` after `formatRunSummary`.
  3. `runGraph` now allocates lowest-free-index worker slots and
     passes `slot: number` to `execute()` + `onStart()`. Stable
     allocation across runs so a future TUI Workers view renders
     `[1]` always-busy / `[N]` idle-gap visibly.
  4. New `Cache.getTaskHistory(taskIds)` — one SQL CTE with
     `ROW_NUMBER() OVER (PARTITION BY project, task)` capped at 50
     rows per pair, returns a `TaskHistoryMap` of runs / avg / p50 /
     p99 / successRate / hitRate / recent[10]. Threaded through
     `prepareRun` so the `runStart` event carries `historyTable`
     populated for every node in the graph (cheap; one batched read).
  5. `LayeredCacheOptions.onRemoteRequest` callback fires for every
     remote GET/PUT with `{ op, hash, bytes?, latencyMs, ok }`. The
     orchestrator wires it to `observer.emit({ kind: 'remoteCache',
... })` in `wrapWithRemoteCache(local, log, observer)`.

  No renderer in this PR — Phase 1's UI components land in the
  follow-up PR. The orchestrator side is renderer-agnostic by design:
  the same Observer feeds future `vx ui` historical browser and
  embedder use cases.

- **2026-05**: Architecture refactor. Three focused changes (no
  behaviour change, all 414 tests still pass):
  1. Extracted `orchestrator/prepare.ts:prepareRun(options, log) ->
PreparedRun`. `run()` and `planRun()` no longer duplicate
     ~50 lines of workspace-discovery → config-load → graph-build →
     cache-open. `PreparedRun.empty` is a small discriminated union
     so the two callers handle empty cases in their own way (run
     logs + returns NOT-ok; planRun returns `{ tasks: [] }`).
  2. Split `executeTask` into three named functions —
     `executeGroupTask`, `executePersistentTask`, `executeCachedTask`
     — behind a tiny dispatcher. Hoisted `buildIsolatedEnv` to a
     private `taskEnv(node, step)` helper since the persistent and
     cached paths constructed it identically.
  3. Shared `tallyOutcomes` between `summary.ts` and
     `run-artifacts.ts` via a new `orchestrator/tally.ts`. Both
     surfaces (terminal summary + `--summarize` JSON) now compute
     the same numbers from one place; group-task exclusion is baked
     into the helper.

  Small follow-ons in the same PR: `isGroupTask(node)` predicate
  added to `graph/task-graph.ts` and applied at six call sites that
  previously inlined `node.config.exec === undefined`;
  `expandRequested` moved from `orchestrator.ts` to
  `graph/task-graph.ts` next to `buildTaskGraph` (they're paired);
  dead `taskId` re-export from `orchestrator.ts` removed;
  `formatBriefDuration` (framed-output.ts) replaced with the
  byte-identical `formatDuration` from `summary.ts`; the `OnDiskMeta`
  shape in `layered-cache.ts` is now `Omit<CacheEntry, 'hash' |
'outputFiles' | 'source'>` so it stays in sync with the cache
  contract automatically; `SaveArgs` marked `@internal`.

- **2026-05**: CACHE_VERSION → v14. File enumeration switched from
  `Bun.Glob` + `ignore`-library filter to `git ls-files --cached
  --others --exclude-standard` (Turbo / Nx parity — both defer to
  git at the bottom of their hash pipelines). User-visible effects:
  (a) nested `.gitignore` patterns are anchored to the gitignore's
  own directory (fixes the v13 footgun where `pkg/.gitignore:
src/skip.ts` was misinterpreted as `<workspaceRoot>/src/skip.ts`);
  (b) `.git/info/exclude` and global excludes participate; (c)
  untracked-but-not-ignored files enter inputs immediately (no
  `git add` required). When git isn't available, we fall back to
  the pre-v14 walker. New: `listGitTrackedFiles(projectDir)` helper
  in `cache/inputs.ts`. 9 new git-path tests in `tests/inputs.test.ts`
  (init a real git repo in the fixture); all 23 pre-existing
  `inputs.test.ts` tests still pass via the fallback path.
- **2026-05**: `vx watch <task>` shipped. New subcommand:
  initial run uses the same orchestrator path as `vx run`; afterwards
  a debounced (150 ms) `fs.watch(projectDir, { recursive: true })`
  per project + non-recursive watch of the workspace root re-invokes
  the orchestrator on changes. Path filter ignores `node_modules` /
  `.git` / `.vx` / `*.tsbuildinfo` / `*~` (editor swap files).
  Reentrancy guard: events while a cycle runs set `pending = true`;
  the loop drains after the current cycle so two events collapse
  into one re-run. Rejected at parse time: `--dry`, `--graph`,
  `--summarize`, `--profile` (don't make sense for a loop). Extracted
  `resolveRunOptions(parsed, cwd, tasks)` from `cli/run.ts` so both
  subcommands share scope resolution. 7 new CLI tests including an
  end-to-end re-run-on-change against a real fixture workspace +
  clean SIGINT exit. Docs: new module page `cli-watch.md`,
  `comparison.md` flipped from gap to shipped, `cli.md` new
  `## vx watch` section.
- **2026-05**: CACHE_VERSION → v13. Unified per-entry on-disk layout:
  outputs moved from `<cacheDir>/<hash>/<rel>` to
  `<cacheDir>/<hash>/outputs/<rel>`; stdout/stderr moved from the
  sibling `<cacheDir>/logs/<hash>.{stdout,stderr}` into
  `<cacheDir>/<hash>/stdout` and `<cacheDir>/<hash>/stderr`. Eviction
  collapses to a single `rm -rf <hash>/`. Also dropped the run-time
  `logs/<run_id>/<project>__<task>.{stdout,stderr}` dump from the
  orchestrator (the `persistTaskLogs` helper + module). Rationale: the
  cache only writes on success and already captures stdout/stderr per
  hash; failures are streamed live and surfaced on the outcome object;
  CI captures the parent stdout natively; structured per-task metadata
  lives in the `runs` table. The duplicate sibling dump was pure
  redundancy. PR pending.
- **2026-05**: Persistent / long-running tasks shipped via
  `exec.persistent.readyWhen`. Schema-extending: `ExecConfig` gains an
  optional `PersistentConfig`. Runner has a new `runPersistent` that
  spawns + watches stdout/stderr for a regex match (line-by-line),
  resolving a `ready` promise on first match or immediately when no
  regex given. The orchestrator owns the subprocess registry and
  SIGTERMs every persistent child once the rest of the graph
  finishes. `cache + persistent` is a config error (no exit, nothing
  to cache). Project-loader rejects malformed `persistent` shapes
  (non-object, non-string `readyWhen`). 8 new e2e tests cover:
  immediate-ready, regex-ready, fail-before-ready, downstream
  blocking, multi-package concurrent persistent, SIGTERM-on-sibling-
  failure, output streaming pre-ready, schema validation. PR pending.
- **2026-05**: Multi-task positional invocation. `vx run build lint
test` runs all three with a shared graph (Turbo parity). Anchored
  positionals (`vx run pkg#deploy lint`) resolve directly; bare
  positionals fan out across the resolved project scope. New
  `expandRequested(tasks, candidates, projects)` helper in
  `src/orchestrator.ts` dedupes `{project, task}` pairs across mixed
  inputs. `RunOptions.task: string` → `RunOptions.tasks: string[]`;
  parser's single-positional rule replaced with array accumulation.
  Header `Running ...` line comma-lists the unique task names. PR
  pending.
- **2026-05**: dependsOn + cache.inputs.tasks switched to Turbo/Nx
  micro-syntax — a flat `string[]` instead of
  `{ self: [...], dependencies: [...] }`. Entries:
  `'name'` (same-project), `'^name'` (workspace deps), `'pkg#name'`
  (cross-project edge). For `cache.inputs.tasks`, two extras for
  filtering: `'*'`/`'^*'` for "every same-project/dep upstream",
  `'!<form>'` for exclusion. Last-write-wins ordering. New
  `src/graph/dependency-spec.ts` is the shared parser. dependsOn
  validation rejects wildcards/negation (they're filter-only). PR #56.
- **2026-05**: Declared output paths are wiped before every cache-hit
  restore AND every cache-miss exec, so the project's output dir ends
  the run bit-identical to the cached snapshot (no stragglers from a
  prior build / hand-edits / removed files survive). New
  `cleanOutputs` helper in `src/cache/inputs.ts` reuses `resolveOutputs`'
  glob-and-boundary logic; `execute-task.ts` calls it in both spots
  when `cache.outputs.files` is non-empty AND caching is enabled
  (`--no-cache` leaves the tree alone — user is debugging and managing
  files themselves). Three new e2e tests pin the behavior; one
  existing test that relied on a stale output surviving across runs
  (`non-zero exit code is NOT cached`) was rewritten to track
  re-execution via a non-output file. PR #50.
- **2026-05**: PATH-prepend each project's `node_modules/.bin` per
  task (vite-task-style). `buildIsolatedEnv` gained an optional
  `binPaths` arg; `executeTask` passes
  `[<projectDir>/node_modules/.bin]`. Only the _project's own_ bin —
  not the workspace root's — so sibling-project bins stay invisible
  per the project-isolation rule. Side effects: deleted
  `tryDelegateToLocal` / `findProjectDeclaringVx` from `bin.ts` (no
  longer needed — PATH is set up by us, not by a PM wrapper),
  dropped `[<agent>]` PM tag from the run banner, removed
  `src/workspace/package-manager.ts`, and dropped the
  `package-manager-detector` dep. Also dropped the orchestrator's
  end-of-run failure replay (stderr is already streamed live;
  reprinting just duplicates noise) — logs are still persisted to
  `<cacheDir>/logs/<run_id>/`. Also dropped all `package.json`
  scripts; CI invokes `bun src/bin.ts run ci` directly. PR #46.
- **2026-05**: CACHE_VERSION → v12. Folded project's `package.json`
  bytes into every task's cache key (Turbo/Nx-style "implicit
  dependencies"). Closes the gap where a narrow `cache.inputs.files`
  like `['src/**']` missed package.json and dep changes went stale.
  One-line addition in `cache.ts:key()` + a `hashProjectPackageJson`
  helper in `orchestrator/execute-task.ts`. New CacheKeyInput field
  `projectPackageJsonHash`. PR #42.
- **2026-05**: **Removed the entire sandbox subsystem.** `src/sandbox.ts`,
  `tests/sandbox.test.ts`, `docs/design/sandbox.md`, `docs/modules/sandbox.md`,
  the `--sandbox` CLI flag, and the bwrap installation step from CI all
  gone. Reasons: Ubuntu 24's default AppArmor profile blocks unprivileged
  user namespaces, breaking bwrap on the most common CI target; the
  sandbox contract requires the user to declare every input file exactly
  right or builds break confusingly; and Turborepo / Nx ship without
  sandboxing and that's fine — under-declared inputs producing stale
  hits is the accepted task-runner tradeoff. RunOptions.sandbox dropped;
  the `executeTask` body simplifies to a single `runCommand` call.
- **2026-05**: **Removed the entire dashboard subsystem.** Server
  (`src/dashboard.ts`), UI app (`apps/dashboard/`), `vx dashboard`
  subcommand, design doc, and module doc all deleted. Project
  flattened back to a single-package layout (no more `packages/run/`
  or `apps/`). What stays: `runs` table + ULID + hrtime spans +
  cpu_ms / peak_rss / wallclock columns in cache.db, populated on
  every `vx run`. CI consumes them either via `vx stats` or by
  reading `cache.db` directly with `sqlite3`. Net: −9 of 10
  dashboard PRs' worth of code; dep tree down from 304 packages to 19. Original framing of "dashboard as a window onto the cache"
  was real scope creep — the cache file IS the API.
- **2026-05**: Dashboard PR 10/10 — Run detail page + flamegraph.
  `/runs/:id` hits the existing `/api/runs/:id` endpoint and renders
  per-task spans against the wallclock timeline. Flamegraph is a
  pure CSS/absolute-position layout (no canvas, no SVG library):
  one lane per project, bars positioned by `wallclockStartNs` (ns
  precision when available, ms fallback for legacy rows), colored
  by `status`/`cacheHit`. Layout math lives in a pure
  `src/flamegraph.ts` with unit tests; rendering in
  `components/Flamegraph.tsx`. Summary cards, a task table with
  CPU/peak-RSS columns, and a status-badge component round out the
  page. Last dashboard PR. Bundle: 53 KB raw / 18 KB gzipped JS,
  7 KB CSS. PR #29.
- **2026-05**: Dashboard PR 9/10 — `vx dashboard` now serves
  `apps/dashboard/dist/` (the built Solid bundle from PR #27)
  instead of the inlined `packages/run/src/dashboard-ui/` static
  files. Legacy `dashboard-ui/` deleted. `DashboardServerOptions`
  gained a required `uiDir` field; the CLI computes it from
  `$VZN_DASHBOARD_DIST` (override) or the repo-relative
  `apps/dashboard/dist/` path, surfacing a `DashboardUiMissingError`
  with a `bun --cwd apps/dashboard run build` fixit if the bundle
  isn't there yet. CI gained a "Build dashboard UI" step before
  tests; tests' `beforeAll` builds lazily so local cold runs still
  work. Static-serving tests rewritten around the Vite layout
  (`index.html` + `assets/<hashed>.{js,css}`) plus a path-traversal
  guard test. Run-detail + flamegraph is the last dashboard PR (#29).
  PR #28.
- **2026-05**: Wired `defineWorkspace({...})` loading. Was a dead
  export — schema docs even flagged it as deferred. Now
  `vx.workspace.{ts,mts,js,mjs}` at the workspace root is jiti-loaded
  by both `vx run` and `vx dashboard`. `concurrency` provides the
  default when `-c` isn't passed; `cacheDir` (relative to workspace
  root) lets users park `.vx/cache` somewhere else (e.g.
  `build/.vx-cache` to keep all derived files in one tree).
  `resolveCacheDir(root, config)` is the single source of truth so
  the runner and the dashboard never disagree on which DB to open.
- **2026-05**: Dashboard PR 8/10 — ported the four legacy pages
  (Overview, Cache, Tasks, Runs) to Solid components inside
  `apps/dashboard/`. Routing via `@solidjs/router`'s `<HashRouter>`
  so URLs stay shaped like the legacy app (`#/overview`, `#/runs`,
  `#/runs/:id`) and so the bundle works as a flat static asset
  without needing SPA-fallback config on whatever serves it. Each
  page does `createResource(() => fetchJson<T>(url))` and wraps the
  output in a small `<AsyncView>` for loading/error/data states.
  Shared chrome (header + nav + footer) lives in a `Shell` root
  component; pages render into it via the router's outlet
  (`props.children`). UnoCSS classes lean on the semantic color
  tokens from PR #26 (`bg-bg-elevated`, `text-fg-muted`,
  `border-border-muted`, …). Added `src/api.ts` (response types +
  `fetchJson<T>`) and extended `src/format.ts` with `formatAge`,
  `formatPercent`, `shortHash`, `shortRunId`. Run-detail page +
  flamegraph land in PR #29; legacy `dashboard-ui/` removal +
  server-side static-serving rewrite is PR #28. Production bundle:
  ~46 KB raw / 16 KB gzipped JS, 5 KB CSS. PR #27.
- **2026-05**: Dashboard PR 7/10 — `apps/dashboard/` scaffold. Vite 6 +
  vite-plugin-solid + UnoCSS (presetUno + presetIcons +
  transformerVariantGroup) with a dark-by-default theme and
  system-font stack (presetWebFonts deliberately omitted — would fetch
  from fonts.bunny.net at build time, breaking hermetic CI). Vite dev
  server runs on port 5280 and proxies `/api/*` to `127.0.0.1:4280`
  (the legacy `vx dashboard` server) so the Solid app can develop
  against real data. `src/main.tsx` mounts a placeholder `<App />`;
  pages port in PR #27. Brought along `src/format.ts` (bytes,
  duration, relative-time formatters) + tests so the `apps/*/src/` CI
  glob has something to assert on. PR #26.
- **2026-05**: Re-monorepo'd the project. Root `package.json` is a
  Bun-workspaces manifest (`"workspaces": ["packages/*", "apps/*"]`);
  current `src/` moved into `packages/run/src/`. Set up to host
  `apps/dashboard/` (Vite + Solid + UnoCSS) alongside `packages/run/`
  per user direction — the dashboard server + UI is being pulled
  out of `@vzn/vx` so it can be a proper component-based app with
  a build step. Convention: `packages/*` is published libs,
  `apps/*` is end-user applications. PR #25.
- **2026-05**: Dashboard PR 6/10 — Tasks + Runs UI pages. Tasks
  ranks `(project, task)` pairs by average wall-clock duration
  (cache-hits excluded so the ranking reflects work actually
  done). Runs is a reverse-chronological list of `vx run`
  invocations grouped by `run_id`; rows link to `#/runs/:id`
  which lands in PR #25. Added parametrized static-serving test
  asserting each page module exports the expected `render*`
  function. PR #24.
- **2026-05**: Dashboard PR 5/10 — static UI bundle. `src/dashboard-ui/`
  ships vanilla HTML + ESM + a tiny hash router with no build step.
  `dashboard.ts` now serves non-`/api/*` paths from disk with a
  no-store cache policy; unknown non-asset paths fall through to
  `index.html` so the SPA's `#/overview`, `#/cache`, … hash routes
  resolve correctly. Two pages this PR: Overview (cards + recent
  runs) + Cache (entries table). PR #24 adds Tasks + Runs; PR #25
  adds Run detail + flamegraph. 7 new static-serving tests. Default
  port also accepts `0` for kernel-assigned. PR #23.
- **2026-05**: Dashboard PR 4/10 — `vx dashboard` subcommand +
  `src/dashboard.ts` HTTP server. Bun.serve()-based, opens
  `cache.db` read-only, exposes `/api/health`, `/api/overview`,
  `/api/runs`, `/api/runs/:id`, `/api/tasks/slowest`,
  `/api/cache/entries`. JSON wire shape designed so PR #26's
  Cloudflare Worker can be a drop-in replacement. bigints
  (wallclock ns) serialized as strings. Default bind
  `127.0.0.1:4280`; `--host 0.0.0.0` opts into LAN exposure.
  14 dashboard tests + full module docs. PR #22.
- **2026-05**: Test harness migrated from `from 'vitest'` to `from
'bun:test'`. vitest was a stale pnpm symlink locally — never in
  `bun.lock` — so CI's `bun install --frozen-lockfile` couldn't
  resolve it for tsgolint. `bun:test` re-exports `vi` as a compat
  alias so the `vi.spyOn(...)` patterns in `cli.test.ts` keep
  working. Also disabled `typescript/await-thenable` in oxlint
  (`bun:test`'s `.rejects.toThrow()` is awaitable at runtime but
  typed as `void`). PR #21.
- **2026-05**: `isSandboxSupported()` now functionally probes
  bwrap (one-time, memoized): Ubuntu 24.04+ (the new GitHub
  Actions ubuntu-latest baseline) restricts unprivileged user
  namespaces via AppArmor by default, so the binary is installed
  but namespace-creating invocations exit non-zero. Sandbox tests
  `describe.skipIf` cleanly when the kernel blocks. PR #21.
- **2026-05**: Dashboard PR 3/10 — orchestrator generates a ULID
  `runId` at the top of `run()` shared by every task in the
  invocation, plus an `hrtime.bigint()` anchor for per-task spans.
  `TaskOutcome` carries `wallclockStartNs` / `wallclockEndNs` (ns
  relative to run t=0). `recordRun()` now writes `run_id` + spans
  into the v11 columns. Hand-rolled `src/ulid.ts` (Crockford
  base32, 48-bit ms + 80-bit random) — no new dep. PR #21.
- **2026-05**: Dashboard PR 2/10 — `runner.ts` and `sandbox.ts`
  switched to `Bun.spawn` so we get `resourceUsage()` (cpuTime,
  maxRSS) per child. `RunResult` gains optional `cpuMs` +
  `peakRssBytes`. `TaskOutcome` propagates them. Orchestrator passes
  them through to `cache.recordRun()` plus `cacheHit` (derived from
  status). The v11 columns from PR #19 are now populated for every
  task. PR #20.
- **2026-05**: Cache schema v11 — analytics columns added to the
  `runs` table (`run_id` ULID, `cpu_ms`, `peak_rss_bytes`,
  `wallclock_start/end_ns` hrtime spans, `cache_hit`,
  `bytes_uploaded/downloaded`). All nullable; producer PRs populate
  them later. `CACHE_VERSION` → `vx-cache-v11`. First PR of the
  dashboard 10-PR sequence (`docs/design/dashboard.md`). PR #19.
- **2026-05**: `CacheLayer` interface extracted in `src/cache.ts`. Both
  `Cache` and `LayeredCache` `implements CacheLayer`. Orchestrator's
  `cache` field types as `CacheLayer` (was the brittle `Cache |
LayeredCache` union). `SaveArgs` exported as `Parameters<CacheLayer['save']>[0]`
  so callers don't redeclare the shape. PR #18.
- **2026-05**: P1 bug bundle from Agent A's real-world test. Adds
  `PRAGMA busy_timeout = 5000` (concurrent `vx run` no longer crashes
  with SQLITE_BUSY), scopes `forwardArgs` to user-requested task nodes
  (no longer leaks into `dependsOn`-pulled deps; no longer pollutes
  their cache keys), returns `ok: false` when no project declares the
  requested task (CI scripts surface typos), adds runtime validation
  of `TaskConfig` shape in `project-loader.ts`, introduces a
  `UserError` class so user-input failures print a clean message
  instead of a full stack. Also renames the stale `nxt:` log prefix
  to `vx:`. PR #17.
- **2026-05**: Sandbox shipped (v1). `src/sandbox.ts` with bwrap on
  Linux + sandbox-exec on macOS. `vx run --sandbox` opts in. Declared
  `cache.inputs.files` are bind-mounted read-only; project dir is
  read-write; everything else is invisible (ENOENT). Fail-loud when
  the helper binary is missing — silent fall-through would defeat the
  contract. Windows is unsupported. Design at
  `docs/design/sandbox.md`. PR #15.
- **2026-05**: Remote cache shipped. `RemoteCache` HTTP client (PR #10)
  speaks the Turbo `/v8/artifacts/` wire verbatim. `cache-archive`
  (PR #12) handles tar.gz pack/unpack via system `tar`. `LayeredCache`
  (PR #13) composes local + remote: read-through (local → remote →
  hydrate local), write-through (local sync, remote fire-and-forget).
  Wired into orchestrator via env vars: `VX_REMOTE_CACHE_URL` +
  `VX_REMOTE_CACHE_TOKEN` (plus optional `_TEAM_ID`, `_SLUG`,
  `_TIMEOUT_MS`). Compatible with `ducktors/turborepo-remote-cache`,
  `Fox32/openturbo-remote-cache`, Vercel hosted cache.
- **2026-05**: `vx cache prune` CLI command. Supports `--older-than
<duration>` (TTL eviction) and `--max-size <bytes>` (LRU eviction
  until under cap). Both can combine. Uses `entries.accessed_at` and
  `entries.size_bytes` from the v10 schema. PR #9.
- **2026-05**: `vx stats` CLI command — surfaces v10 cache stats
  (entry count, total size, runs/hits last 24h). PR #8.
- **2026-05**: Local cache v10 — SQLite metadata index (`cache.db`),
  on-disk outputs at `<hash>/`, separate `logs/<hash>.{stdout,stderr}`
  log files. Adds `runs` table for run history (drives future `vx stats`).
  CACHE_VERSION → `vx-cache-v10`. Per-entry `meta.json` is gone. PR #7.
- **2026-05**: Project memory + agents — `CLAUDE.md` + architect /
  developer subagents under `.claude/agents/`. PR #6.
- **2026-05**: Bun runtime + oxc toolchain (oxlint + oxfmt + tsgolint).
  Dropped Node, pnpm, tsc, prettier, vitest. PR #5.
- **2026-05**: Remote cache wire = Turbo `/v8/artifacts/` spec verbatim,
  but tar interior is ours (`meta.json` + `outputs/`, no Turbo log-file
  mimicry). Design at `docs/design/remote-cache.md`. **Not yet implemented.**
- **2026-05**: Schema reshape — `defineProject({ tasks: {...} } })`.
  `exec` is a single ExecConfig, not an array. CACHE_VERSION → `v9`.
  PR #3.
- **2026-05**: CLI aligned with vite-task — default scope is cwd
  project, `-r` for all, `-F` for filter DSL, `--` separator, `pkg#task`
  addressing, `--no-cache` (was `--force`), `-v` for verbose. PR #2.
  (Both short aliases were later dropped: the parser rejects `-F` and
  `-r`; `--filter` / `--all` are the shipped flags.)

## Active workstreams (prioritized)

**OWNER DIRECTIVE 2026-07-16 — document EVERY vx Cloud feature:
EXECUTED 2026-07-17** (`a4a5051` + `50dbe57`; see the decision-log
entry). The audit→write→verify program ran to completion: full feature
inventory, all 8 cloud pages audited, a new `cloud/api.md` HTTP API
reference, every identified gap filled, astro build clean + a
zero-broken-links crawl over `dist/`. Keep the standard alive: a new
cloud feature is not DONE until its docs land in the same wave.

The trusted-GET S3 HEAD-skip (backlog (b)) SHIPPED same day —
completed from the stashed WIP, adversarially verified sound (see the
decision-log entry).

Near-term roadmap = the "road to best-CI" ranked table in
`docs/design/ci-platform-2026-07.md` (owner: "Make vx the best CI env
ever… compete with GitHub Actions and Nx Cloud"; the wedge is the
portable execution+cache+pool LAYER inside any CI provider — triggers/
hosted-runners/secrets/DSL/marketplace are permanent non-goals). The
longer-horizon core gaps stay sourced from `docs/comparison.md`.

1. ~~Per-task logs + artifacts in the dashboard~~ — **SHIPPED**
   2026-07-04 (task-logs-2026-07; the dashboard TaskLogs panel).
2. ~~PR/commit summary + checks~~ — **SHIPPED** (the GHA
   `$GITHUB_STEP_SUMMARY` table 2026-07-04; the real check run via the
   Checks API 2026-07-10 — client-side glue, no serve needed: pass
   `GITHUB_TOKEN` to the step + `checks: write`).
3. ~~Task-level retries~~ — **SHIPPED** 2026-07-04 (`exec.retries` +
   `--retry`; `TaskOutcome.attempts` is the flaky-detection feed).
4. ~~Flaky detection → surface + suggestions~~ — **SHIPPED** across
   2026-07-05..25: the Insights flaky card (retry-confirmed ranked above
   inferred, Retried column), the task-detail flaky badge + the
   Recommendations `exec.retries` snippet, key-scoped `mixedOutcomeKeys`,
   and the Flakiness-trend card (first-seen/direction). "Auto-APPLY"
   deliberately stayed a copy-pasteable suggestion — vx never edits a
   user's config.
5. ~~Duration-aware dispatch ordering~~ — **SHIPPED** 2026-07-04
   (LPT; serve-computed `durationHints` from ingest history).
6. ~~Run-level policy to REMOTE agents~~ — **SHIPPED** 2026-07-18. The
   submitter's `--frozen`/`--timeout`/`--retry` now ride every `task:assign`
   as an optional `policy` sub-object (filled by the controller from the
   submission's `RunRequest`, applied per-assignment by the agent), so a
   standalone agent honors THIS run's flags instead of live-evaluating with
   no defaults. Cache stays full-by-design (the artifact transport; each
   agent's own local cache stays on). Additive-optional → clean degradation
   both directions (old agent ignores it = today's live-eval; new agent +
   old serve = its own defaults), so NO DIST_PROTOCOL bump (the
   branch/defaultBranch/context precedent).
7. Core backlog (from `docs/comparison.md`): CLEARED. Blob offload
   (pre-signed URLs): the CLIENT half ships in the native wire —
   `NativeCacheClient` follows one auth-dropping 307/302 on GET; the
   serve-side blob backend (S3/R2) behind that redirect is designed
   (`docs/design/native-cache-wire-2026-07.md` §offload) — build when a
   deployment actually needs it. (The Turbo `--preflight` client from
   `presigned-artifacts-2026-07.md` was deleted with the Turbo wire.)
   (`--continue=<mode>`, `--cache-dir`, and `dependsOn` wildcards are
   SHIPPED.)

**Owner-REJECTED non-goals (do NOT re-propose):**

- **Workspace-level `globalInputs` / `globalEnv` / `globalPassThrough`**
  (owner 2026-07-05: "no global"). TS configs compose — a shared preset
  imported + spread into each config IS the global-inputs mechanism (same
  rationale as the earlier-rejected named-inputs machinery); a schema
  field would duplicate the language. The Turbo-migrate path already emits
  a generated `vx-preset.ts` for this.
- **Auto-input inference (fspy/strace filesystem tracing)** (owner
  2026-07-05: "no auto input"). vx's explicit-inputs contract is a
  correctness principle (Architecture principle #1: "Explicit over
  magical"), not a gap; traced inputs aren't derivable before execution
  (why vite-task has no remote cache). Declared `cache.inputs.files` +
  `runtime`/`workspaceFiles` stay the only input surface.

## Recently shipped

- **2026-05**: `vx watch <task>` subcommand. Initial run via the
  shared orchestrator path, then debounced (150 ms) recursive
  `fs.watch` per project + non-recursive root watch for lockfile
  edits. Path filter ignores `node_modules` / `.git` / `.vx` /
  `*.tsbuildinfo` / `*~`. Reentrancy guard collapses bursty events
  into a single re-run. Rejects `--dry` / `--graph` / `--summarize`
  / `--profile` (no sense for a loop). 7 new tests including
  end-to-end re-run on FS change + clean SIGINT.

- **2026-05**: `--dry-run` (`--dry`) and `--graph` for `vx run`. Both
  short-circuit execution: build the graph, compute every task's
  cache key, probe the cache, emit a human/JSON/DOT view of the
  predicted plan. `computeTaskHash` extracted from `executeTask` for
  reuse. New `orchestrator/plan.ts` + `orchestrator/plan-format.ts`.
  12 new tests; 303 total passing.

## Operating directive (to you, Claude)

You own this project. The user has delegated full maintenance. Each
turn:

1. Identify the next valuable thing.
2. Do it (branch → push → PR → merge).
3. Update this doc when decisions are made.
4. Never end a turn with "what next?" — instead, state what you're
   doing next.

When uncertain about a non-trivial architectural call, use the
**architect** subagent (`.claude/agents/architect.md`). When you have
a design and need to implement, use the **developer** subagent
(`.claude/agents/developer.md`). Both should read this CLAUDE.md
first.
