# STATUS — the living handoff

**Read this first.** It is the one file a fresh session needs to pick the
project up: the direction, what shipped, what is in flight, what is next.
Update it in the SAME commit as the work it describes. Newest state wins;
delete stale lines rather than appending corrections.

## Direction (owner, 2026-09-02)

> "VX should be the Vite of task orchestration. Perf first, then
> modularity. Slim core; add features with plugins or replace
> functionality. Remove DTE / VX Cloud / agents — vx ships none of it, but
> gives people a way to implement it on top. Consider everything before
> this date legacy."

Concretely:

1. **Performance is the first decision driver.** Every change to the run
   path is measured (`bench/`), and a slower core is a regression even if
   it is prettier. Targets: the fastest warm no-op run and the lowest
   scheduler/hash overhead of any JS-monorepo task runner.
2. **Core is a pipeline with seams, not a product.** Core owns:
   discovery, config evaluation, the task graph, cache keys, scheduling,
   and the seams. Plugins own: WHERE a task runs (`executor`), WHERE
   artifacts live (`cache`), WHO observes (`telemetry`/reporters), and —
   as the seams widen — how the graph is shaped and prioritised and which
   CLI verbs exist.
3. **No distribution in the repo.** No agents, synchronizers, controllers,
   cloud, dashboards. The executor seam is the extension point for all of
   it; `@vzn/vx-reapi` (Bazel Remote Execution API) stays as the proof
   that the seam is wide enough.
4. **Native first.** Bun APIs over dependencies. A dependency needs a
   reason written down next to it.
5. **Adoption ready.** Docs, site, and design describe the product that
   exists — verified against the code, not remembered.

Process: push directly to `main`, no PRs. Gate before every push:
`bun packages/vx/src/bin.ts run ci --all`. Small, focused commits.

## Shipped in this arc

- 2026-09-02 — this handoff; compact `CLAUDE.md` (the 13k-line decision
  log left the project memory; history stays in git).
- 2026-09-02 — removed `@vzn/vx-agents`, predictive scheduling
  (`predict.ts`, `predictive:` workspace flag), `vx mcp` + `mcp-rpc.ts`,
  and the mcp-only run-history queries (`getHistory`, `listProjects`,
  `getCacheStatsSql`). `metrics.ts` stays as the `vx why` / `vx last`
  query home. Deleted the decision-log archive, `docs/design/archive/`,
  `docs/progress/`, and the design docs of removed products (dashboard,
  TUI, cloud execution service, trust scopes, lookahead/predictive
  scheduling). `bench/` paths fixed for the `packages/vx` layout.
- 2026-09-02 — **perf wave 1.** Baseline measured (`docs/benchmarks.md`
  § Warm-run overhead): 100 projects 105 ms, 1000 projects ~400 ms warm.
  Profiled with `bun --cpu-prof` + the new `bench/profile-summary.ts`.
  Two changes: (1) an UNSCOPED run starts the git enumeration before the
  configs load, overlapping ~55 ms of git with config evaluation
  (`startGitEnumeration` / `applyGitEnumeration`); (2) a config
  evaluation cache for provably-pure configs
  (`src/workspace/config-cache.ts`, `config_evals` table). Result:
  92 ms / 270 ms. The bench generator now gitignores `dist` and `.vx`
  like a real repo (the untracked walk was 2× inflated).
- 2026-09-02 — **perf wave 2** (79 ms / 242 ms). `VX_TIMING=1` stage
  table + accumulated spans (`src/util/timing.ts`). One worktree walk:
  `ls-files -s -v` (index only, OIDs + skip-worktree flags in one spawn)
  and `status --porcelain -uall` (dirty + untracked) replace
  `ls-files --others` + `status` + `ls-files -v` — 4 spawns, not 5.
  `.git/HEAD` is read directly for the run's commit/branch (spawn kept
  as fallback): −10 ms on every run. Discovery reads `<dir>/*` members
  via readdir, not `Bun.Glob` (25 → 2 ms), manifest + listing in flight
  together (68 → 22 ms at 1000). `localeCompare` sort → code-unit sort
  (28 ms of ICU). REFUTED and reverted: sync `stat`/glob/`readFileSync`
  on the warm-hit path — faster in isolation, 40 ms slower under the
  scheduler's concurrency (documented in `docs/benchmarks.md`).
  FOUND: Bun 1.4.0 `--compile` binaries are SIGKILLed on this macOS
  (invalid ad-hoc signature, every flavour); `codesign -s - --force`
  repairs it — release.yml re-signs the darwin binaries on a macOS runner
  and the darwin CI job pins that a re-signed build launches.
  REFUTED: shipping the CLI as one `bun build --target=bun` bundle —
  `--version` 25 → 36 ms and the warm run 79 → 98 ms; Bun loads the
  169-module source tree faster than it parses a 1.2 MB file.
- 2026-09-02 — **perf wave 3.** `CacheLayer.getMany?` (one `entries`
  + one `output_files` query per 900 hashes, artifact stats in flight
  together); the local short-circuit probes through it when the layer
  offers it. `CacheEntry.outputRows` carries the rows so `restoreHit`
  stops re-querying. Compiled `Bun.Glob`s memoised per pattern. A/B on
  `run test --all` (2000 tasks with deps): 328 → 311 ms.
- 2026-09-03 — **pipeline v2, phase 1.** The deprecated `eventSink` seam
  is gone (`setup(ctx)` on the bus and `telemetry` are the two observe
  paths). Three pipeline stages on `VxPlugin`: `config(ws, ctx)`,
  `project(config, ctx)`, `graph(nodes, ctx)` — in-place edits in
  declaration order, re-validated by core (`validateProjectConfig`,
  dangling-dep + cycle check), zero cost when no plugin declares them
  (`hasHook`). Pinned in `tests/plugin-pipeline.test.ts`: an injected
  task keys byte-for-byte like a hand-written one, a plugin-added edge
  orders the run, invalid/dangling/cyclic edits are refused naming the
  plugin and stage, and a stage-less workspace validates each config
  exactly once.
- 2026-09-03 — **pipeline v2, phase 2: `commands`.** A plugin declares
  `commands: { verb: { description, run(argv, ctx) } }`; the dispatcher
  consults plugins only for a word core does not know, loading the
  workspace config from the cwd (`src/cli/plugin-commands.ts`); `vx help`
  lists them. Pinned: argv + context + exit code, core verbs win, unknown
  stays unknown (in and out of a workspace), malformed entries refused
  by the loader.
- 2026-09-03 — **pipeline v2, phase 3: `key` + `schedule`.** `key(task,
  ctx)` returns `{ name: value }` material stored on the node
  (`TaskNode.keyParts`, sorted `plugin/name` pairs) and folded by
  `Cache.key` as `plugin` components — only when non-empty, so every
  existing key is unchanged (no `CACHE_VERSION` bump). `schedule(nodes,
  ctx)` returns task → weight, merged over the scheduler's baseline
  (later plugin wins per task); `ctx.localCache` gives a policy the run
  history. The removed predictive mode is back as the reference plugin
  `@vzn/vx/plugins/schedule-history` (its priority function and tests
  recovered from history), which put `LocalHistoryProvider` on the
  façade. Pinned: material moves/keeps the key deterministically, a
  non-string value is refused, weights decide order with an
  insertion-order control, override semantics, non-finite refused.
- 2026-09-03 — README, the site introduction and the extensibility
  guide reframed around the pipeline stage table; the CLI imports every
  verb but `run` lazily (hygiene — `--version` measured unchanged at
  25 ms).
- 2026-09-03 — **perf wave 4 (small).** `vx info` reports whether git's
  `core.fsmonitor` / `core.untrackedCache` are on, with the remedy —
  the one `git status` walk per run is the warm run's critical path at
  1000 projects and git's own caches make it near-free. The
  config-evaluation key now folds vx's VERSION: a stored evaluation is
  served without re-validation, so it must not outlive the validator
  that accepted it (audit finding on the wave-1 code). `bench/compare.ts`
  re-signs the compiled binary on darwin before measuring (it was
  silently measuring nothing — "vx skipped: vx failed").
- 2026-09-03 — **FOUND: the standalone binary could not load any
  workspace config.** Bun 1.4.0's compiled binaries resolve an on-disk
  package by directory convention only — `<pkg>/index.ts`,
  `<pkg>/<subpath>/index.ts` — and ignore package.json `exports` /
  `main` (probed: an entry of `./src/index.ts` resolved to the root
  `index.ts` regardless; a package with no root file was "not found").
  `@vzn/vx`'s entry is `src/index.ts`, so every `import … from '@vzn/vx'`
  under the binary failed — the bench's "vx skipped" was this, not the
  signature. FIX: root shims `packages/*/index.ts` and
  `packages/vx/plugins/<name>/index.ts` re-exporting the real entries,
  shipped in `files`, pinned identical by
  `tests/package-entry-shims.test.ts`; the darwin CI job now runs the
  re-signed binary against a bare-specifier workspace end to end.
- 2026-09-03 — **perf wave 5.** The local short-circuit's classify pass
  now runs for flat (dep-free) graphs too: it never bypasses an order
  there, but its one batched `getMany` replaces a `cache.get` per task
  inside the run. A/B against an immutable worktree, interleaved:
  100 dep-free tasks 84–86 → 78–79 ms, 1000 → 249 → 237 ms. Measured
  and refuted on the way: git `core.fsmonitor` + `untrackedCache` make
  no difference at 100 projects (the tree is too small for the walk to
  matter); the compiled binary starts in 16 ms vs 25 ms from source and
  runs the 100-project warm run in 72 ms vs 78.
- 2026-09-03 — **`@vzn/vx-mcp` shipped.** The MCP server is back as a
  plugin on the `commands` seam: `mcp()` adds `vx mcp`, a native stdio
  JSON-RPC server (no SDK — the reference one pulls in an HTTP stack the
  transport never uses) exposing the four read-only tools over
  `cache.db` through the public façade. The removed core tests were
  recovered and ported (tools), plus protocol and real-stdio tests; the
  repo dogfoods `mcp()`; CI runs the package suite; the guide and
  sidebar entry are back.
- 2026-09-03 — **`vx init`.** A workspace from nowhere had no scaffold:
  `vx migrate` only knew Turbo and Nx. `migrate-scripts.ts` maps
  `package.json` scripts to tasks (command verbatim; `build` gets
  `^build` and a cache block with EMPTY outputs under a TODO — a guessed
  `dist/**` would restore the wrong tree; `test`/`lint`/`typecheck`
  wait for `build`; dev-server shapes become persistent). `vx init` is
  `vx migrate --from scripts`, and the scripts path is `vx migrate`'s
  fallback when neither Turbo nor Nx is present. Quickstart and README
  point at it.
- 2026-09-03 — darwin CI red on the `vx init` commit, NOT the diff: the
  ms-mtime ingest test sampled the clock for its "sub-second stamp"
  precondition and the runner's write landed on an exact second (1 in
  1000 by construction). The precondition is now stamped with `utimes`,
  so it is made true rather than hoped for. Also: `packages/vx` had no
  README although `files` shipped one; the README status table named
  surfaces that no longer exist.
- 2026-09-03 — measured, not worth doing: lazy-loading modules off the
  `vx run` path. The whole module graph loads in ~13 ms of the 25 ms
  `--version` (Bun's own start is the rest); the largest module,
  `exec/sandbox-runtime.ts` at 7 ms, is mostly the cache graph it shares
  with everything else. No single module is worth a dynamic import; the
  compiled binary's bytecode already takes start-up to 16 ms.
- 2026-09-03 — the docs site's LANDING PAGE (`apps/docs/src/pages/index.astro`)
  still sold the removed platform: "trust-scoped, HMAC-signed cache",
  `predictive: true`, a dead link to the predictive guide, July's
  3,270-task numbers against older Turbo/Nx. Rewritten to what ships —
  the pipeline hooks, `vx why`/`--verify`, REAPI cache + execution,
  `@vzn/vx-mcp`, the schedule-history plugin — and to the 2026-09
  476-package measurement, including that Turbo 2.10 ties vx at 46
  packages. A landing page is the one doc a stale claim hurts most.

## In flight

- Nothing.

## Next (ordered)

1. **The shipped binary's second core.** A compiled `vx` loading a
   `vx.workspace.ts` that imports `@vzn/vx` pulls a SECOND copy of core
   from `node_modules` (source, ~12 ms) on every run, and cross-copy
   `instanceof` does not hold (a plugin's `UserError` prints with a
   stack). REFUTED 2026-09-03 as a runtime-plugin fix: Bun 1.4.0's
   `Bun.plugin` `onResolve` never fires for bare package specifiers and
   `onLoad` never fires for `.js`/`.ts` files (probed, both). Options
   left: rewrite the config source before import (breaks relative
   imports unless written beside the file) or a Bun fix. Parked.
2. **Docs + site pass** — the remaining pages that still say "three
   seams" (`docs/README.md`, `docs/architecture.md` prose,
   `concepts/how-vx-works.md`), and a fresh Turbo/Nx comparison table.

DECIDED 2026-09-03: `migrate`, `prune` and `upgrade` STAY in core. They
are the first things a Turbo/Nx user and a Docker user run, and
`upgrade` must live in the binary it upgrades; asking for a second
install before the first `vx migrate` is an adoption cost with no
runtime benefit — the verbs are imported only when invoked, so a
`vx run` never loads them. The `commands` seam is for verbs core has no
business shipping.

## Decisions (this arc)

- **Agents removed.** `@vzn/vx-agents` (synchronizer + persistent
  workers, Nomad/K8s backends) was an in-repo distributed-execution
  product. It used only public core APIs (`run`, `createEventBus`, the
  executor seam), which is the proof the seam suffices — so it lives
  outside this repo, if anywhere.
- **Predictive scheduling removed.** Opt-in, measured at ~280 ms of
  history loading on a large cache (more than a warm run), and a
  scheduler-priority policy is exactly what a plugin hook should decide.
  The scheduler keeps its `priorities` input; a `schedule` seam will feed
  it.
- **`vx mcp` removed; `metrics.ts` trimmed.** The MCP server read the
  dashboard-era analytics queries and predictive history. An MCP server
  is a good plugin (`commands` seam), not core. The queries `vx why` /
  `vx last` need stay in `metrics.ts`; the rest went.
- **`vx why` / `vx last` stay.** Cache-miss explainability is a core
  promise; both read the local run history core already writes.

## Legacy map (what the old memory called things)

- `docs/design/decision-log-archive.md` held the full 2026-05→08 log; it
  is deleted from the tree (git history: `git log -- docs/design/decision-log-archive.md`).
- "waves" = the old audit cycles. Their standing rules survive in
  `CLAUDE.md` § Rules.
