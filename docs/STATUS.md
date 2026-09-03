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
  - one `output_files` query per 900 hashes, artifact stats in flight
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
- 2026-09-03 — **the npm distribution was broken twice over.** (1) The
  published `@vzn/vx` manifest (assembled by `scripts/build-npm.ts`)
  exported only `"."`, so the `@vzn/vx/plugins/local-executor` import in
  every quickstart workspace file could not resolve for an npm user; it
  now ships the workspace package's exports map plus the root shims.
  (2) The darwin binaries in the platform packages were cross-compiled
  on ubuntu and never signed — SIGKILL on launch for every macOS npm
  user. `npm.yml` now builds, ad-hoc signs and publishes the darwin
  platform packages from a macOS job, and the ubuntu job publishes the
  linux ones and `@vzn/vx` after it. Neither path has a test that can
  run in CI short of a publish; the tree assembly is checked by hand
  (`bun scripts/build-npm.ts <v> --only=<target> --out=<dir>`).
- 2026-09-03 — the cache directory now writes a `*` `.gitignore` into
  itself when created (Cargo / Nx convention; a user's own file wins).
  Two consequences, one of them a latent correctness hazard: a cache
  nobody ignored got committed by `git add -A`, and — for a workspace
  whose ROOT is a project with `**/*` inputs — the artifacts were
  enumerated as inputs, so every save moved the next key. It also keeps
  vx's own `status -uall` walk out of the artifact directory. Pinned in
  `tests/cache-gitignore.test.ts` with a stray-file control.
- 2026-09-03 — two claims turned into pins: "key material is named in
  `vx why`" (probed first: `changed plugin org/tool/node-major`, then
  pinned through the real verb) and the schedule-history plugin end to
  end (run 1 records durations, run 2 starts the historically slow
  chain first against insertion order). The docs front door's numbers
  are this month's.
- 2026-09-03 — audit rotation on the newest code. REFUTED: `getMany`
  under a layered/chained cache — neither wrapper exposes it, and the
  short-circuit already declines any layer with a remote, so a batched
  local probe can never skip a remote read. CONFIRMED and fixed: an
  unknown verb in a workspace whose `vx.workspace.*` fails to load
  printed the loader's stack instead of "unknown command" — a typo read
  as a broken workspace. Now both facts are stated (unknown verb, plus
  why plugin verbs could not be looked up). CONFIRMED and fixed:
  `migrate-scripts` enumerated a non-object `scripts` field's indices as
  script names. Both pinned.
- 2026-09-03 — **the core suite runs as four shards** (`test.0`–`test.3`,
  `tests/helpers/shard.ts run 4 <i>`), longest-first by a
  `// @vx-shard-cost <s>` hint or file size: the gate's test stage went
  from ~145 s in one process to ~50 s wall. Shard 2 failed
  deterministically at first with `EBADF … posix_spawn git` from the
  fourth file on, and the cause is the RUNNER, not vx: under `bun test`
  every dynamically imported module pins ~2 descriptors (plus 2–3 per
  directory) for the life of the process, released by nothing, while the
  same code under plain `bun` pins none (measured 50 imports: 115 vs 0).
  `scale-graph` imports 2 000 configs, parks the process at the
  10 240-descriptor macOS cap, and the next spawn anywhere dies. The
  single-process suite survives only because that file sorts late. Now a
  file marked `// @vx-shard-isolate` gets its own process, and
  `tests/bun-test-import-descriptors.test.ts` pins the leak (darwin) so
  the hint can go when Bun fixes it — a Bun issue worth filing. Method
  note that cost an hour: zsh does not word-split an unquoted `$VAR`, so
  a file list in a variable reached `bun test` as ONE argument matching
  nothing, and every "passing" bisection arm had run zero tests. Assert
  the count of tests run, not just the count of failures.
- 2026-09-03 — **`vx init` audit: hooks and delegation.** Probed the
  scripts mapper with odd shapes. REFUTED: colon names (`test:unit`,
  `build:watch`) emit quoted, load and run. CONFIRMED: `prebuild` /
  `postbuild` became standalone tasks, so `vx run build` ran `tsc` alone
  where `npm run build` had run `rimraf dist && tsc && …` — the hook is
  usually the clean step. Now `pre<x>`/`post<x>` fold into `x`'s command
  in npm order (lifecycle hooks like `prepack` never do; a `pre<x>` with
  no `x` stays a task). And a script that is nothing but
  `<pm> run <other>` becomes a group over `<other>` (no exec), so the
  graph sees the dependency instead of a package-manager subprocess it
  cannot cache; arguments, flags or a chain keep it verbatim.
  `delegatedScript` is table-pinned; both rules have differentials
  (each mutation fails exactly its pin). `docs/cli.md` § `vx init`.
- 2026-09-03 — **`vx watch` proves each watcher delivers before saying
  "watching".** The watch e2e (`re-runs the task after a file change,
then exits on SIGINT`) timed out at 45 s in one sharded gate run, its
  third recorded timeout (two on darwin CI). MEASURED a real race: on
  macOS a recursive `fs.watch` returns before its FSEvents stream is
  live, and a write made immediately after it is lost 5/30 under CPU
  load (0/30 idle, 0/30 after a 50 ms pause). `armWatcher` now writes a
  `.vx-watch-probe` under every watcher and resolves ready when that
  probe's event arrives (intercepted before the ignore filter, removed
  at once); a silent watcher gets 2 s and a warning. The probe is
  RE-WRITTEN on a backoff until seen, because it is subject to the race
  it detects: under the full gate's load an immediate write was lost
  outright 1 in 20 (never arrived in 30 s) while every delivered event
  took under 60 ms — loss, not latency — and a single-shot probe
  reported two real watchers silent in one gate run. Pinned with a fake
  `fs.watch`: silent ⇒ `ready === false`, which a helper that skipped the
  wait cannot pass. HONEST SCOPE: the e2e flake is NOT proven closed —
  under a 10-busy-loop harness the e2e block passed 4/4 with the probe
  AND 4/4 with it disabled, so that load shape does not reproduce the
  gate's timeout (the gate adds four compiles, astro and three other
  shards — I/O, not CPU). Next time it fires, the failing run's stdout
  is the evidence to keep: whether `re-running...` ever printed
  separates a lost event from a slow re-run.
- 2026-09-03 — **`getMany` audited: REFUTED as a stale-hit source, parity
  pinned.** The batched probe behind the short-circuit classify mirrors
  `get` on the three answers that are not rows: the local read gate
  (`--force` classifies nothing as a hit), an artifact deleted under its
  index row (absent, as `get` returns null), and the deferred
  `accessed_at` touch LRU pruning reads. None was pinned;
  `tests/cache-get-many.test.ts` now holds all three with a control, and
  each of three mutations (gate ignored, existence skipped, touch
  dropped) fails exactly its pin. `LayeredCache`/`ChainedCache` declare
  no `getMany`, so a remote-backed run takes the per-hash pool — by
  design (`hasRemote` skips the up-front classify anyway).
- 2026-09-03 — **`docs/comparison.md` re-verified** against
  `turbo@2.10.12`, `nx@23.2.0` and vite-task `main` (now Vite+'s
  `vp run` engine), reading the upstream reference pages rather than
  memory. Corrected: Turbo 2.10 deprecates its daemon, `--parallel`,
  `--no-cache` and `--remote-only` (the flag map said otherwise); Nx's
  skip-deps flag is `--excludeTaskDependencies`; Turbo `--continue`
  values; both tools' output-mode vocabularies. Removed the
  "transparent config-eval caching — rejected" entry (shipped
  2026-09-02 as a purity GATE, which is why the earlier rejection no
  longer applies), marked pre/post lifecycle shipped via `vx init`,
  added the pipeline, `vx why`, the eval cache, the new plugins and the
  npm distribution to "shipped" and "ahead", and rewrote the
  remote-cache and executor divergences for a core that ships seams,
  not wires. New flag-map rows: retries/timeouts, `--verify`,
  placement/`--download`, run reports.
- 2026-09-03 — **the config-eval purity gate had three false SAFEs,
  proven at the gate and closed.** Probed `configEvalKey` (not just the
  lexer) with evasive spellings: `\u0070rocess.env.HOME` (an identifier
  escape the word list cannot see — it evaluated to a home path that
  would then be served forever), `global['proc' + 'ess']` and
  `self[…]` (Bun exposes both as live `globalThis` aliases), and
  `Temporal.Now` (a second clock). All four were CACHED AS PURE. Now:
  `global`, `self`, `Temporal` are denied, and any backslash left in
  code position refuses the config. REFUTED while there: nested
  template literals inside `${}`, brace-bearing objects inside `${}`,
  and strings containing `}` inside `${}` are all lexed correctly. Four
  table pins; two mutations fail exactly their rows. No
  `CONFIG_EVAL_VERSION` bump: a refused config never consults the
  table, so a stale entry stored under the old rule is unreachable.
  ALSO, caught by this wave's gate: the descriptor tripwire from the
  sharding wave read 20 imports as +12 in a shared shard process — its
  own `Bun.gc` ran finalizers that closed descriptors earlier files had
  leaked. It now collects before the baseline too and pins a quarter of
  the measured floor over 40 imports.
- 2026-09-03 — **the shard dealer is pinned.** The runner's dealing was
  its only untested new code: `tests/helpers/shard-deal.ts` now holds
  `describeTestFile` / `dealShards` / `shardGroups`, `shard.ts` is the
  CLI over them, and `tests/shard-deal.test.ts` pins over a synthetic
  directory that a cost hint beats size, `@vx-shard-isolate` is read
  from the head, LPT deals the heaviest file alone when it outweighs the
  rest, every test file lands in exactly one shard (helpers and `.md`
  never), and an isolated file gets its own process. Two mutations fail
  exactly their pins. OBSERVED in this wave's first gate run and
  recorded rather than retried silently: `--verify=all reports
undeclared-inputs … for a leaky task` returned `ok: true` once — the
  documented macOS reporting-loss residual (denial enforced, unified-log
  record dropped under load, ~2% on loaded runs). The sharded gate loads
  this machine the way CI loads a runner, so the residual that darwin CI
  class-gates can now show up locally; it passes alone and is not this
  wave's. If it recurs in the local gate, gate the reporting assertions
  on load rather than raising timeouts — the record is dropped, not late.
- 2026-09-03 — **a plugin verb that resolved nothing read as SUCCESS.**
  Probed the `commands` seam through the real CLI: a `UserError` prints
  cleanly (exit 1), a plain `Error` prints its stack (exit 1), but a
  verb resolving `undefined` — a JS-authored plugin that forgets its
  return on a failure branch — reached `process.exit(undefined)`, which
  is exit 0. The dispatcher now fails a non-integer result as a
  `UserError` naming the plugin and verb; pinned with a control
  (an integer still passes through); the mutation fails exactly the
  pin. The plugins guide says so at the `return 0` line.
- 2026-09-03 — **the npm distribution path run end to end locally, and
  it found the version stamp missing its target.** Assembled the
  darwin-arm64 tree with `scripts/build-npm.ts`, packed both packages,
  `npm install`ed the tarballs into a temp project, and drove `vx
--version`, `vx init` and a cached `vx run` through the Node launcher:
  all work. But the launcher reported `vx 0.0.0` for a `0.0.0-e2e`
  package, and the cause is in both workflows: they stamp the ROOT
  `package.json` while `src/version.ts` inlines `packages/vx/package.json`
  — a pre-move assumption, so since 2026-08-26 every release binary
  would have said `vx 0.0.0`. PROVEN by reproduction (root stamp →
  `0.0.0`; core stamp → `9.9.9`). No release has shipped since the move,
  so no user saw it. All three stamp steps (release assets, the npm
  darwin job, the npm linux job) now stamp the core manifest AND each
  job asserts a built binary's `--version` equals the stamped version, so
  a future move fails the release instead of shipping a mislabelled
  binary — and both CI jobs (ubuntu and darwin) now assert the same
  equality against the unstamped manifest on EVERY push, so the
  inlining contract is exercised outside releases too. Also trimmed the launcher's `@vzn/vx-cloud` framing (removed
  product).
- 2026-09-03 — **`@vzn/vx-mcp` mangled a character split across stdin
  chunks.** Audit of the newest plugin's least-exercised edge, PROVEN
  with a driver that wrote a request in two chunks cut between the two
  bytes of `é` (precondition asserted: the first chunk ends in `0xC3`):
  the per-chunk `TextDecoder` produced `p��#build`, and the tool
  answered for a task that does not exist. One streaming decoder per
  session now; the framing loop is `serve(input, write, ctx)` so a test
  can feed it chunks, pinned for the split and for several messages in
  one chunk plus a trailing message without a newline. The mutation
  (per-chunk decoder) fails exactly the split pin. First probe was
  vacuous — the cut landed AFTER the character — caught only because the
  rerun asserted the lead byte; assert the precondition, not just the
  outcome.
- 2026-09-03 — **RED MAIN, mine, for one run:** the darwin CI job failed
  on the version assertion added an hour earlier — that step `cd`s into
  `packages/vx` before compiling, so the assertion's relative
  `packages/vx/package.json` did not exist there (`ENOENT`). The ubuntu
  copy passed because it runs from the root. An assertion written
  against path assumptions, broken by a path assumption. Both copies now
  name the manifest from `$GITHUB_WORKSPACE`. Also swept the split-chunk
  decode class from the vx-mcp fix across every package: every other
  `TextDecoder().decode` runs on a complete buffer (spawn outputs,
  protobuf slices) and `runner.ts` already streams — REFUTED elsewhere.
- 2026-09-03 — **the npm launcher pinned; its fallback arms REFUTED as
  defects.** Probed with only the `@vzn/vx` tarball installed (no
  platform package): with Bun on PATH the launcher runs the shipped
  source and reports the stamped version; with Bun hidden it prints the
  actionable message and exits 1. The one drift was its hint saying
  `Bun (>=1.3)` against an engines floor of 1.4. `tests/npm-launcher.test.ts`
  now drives the real launcher through `node` against a fake install
  tree: platform binary exec with argv and exit-code mirroring, the
  no-binary-no-bun message, and the bun source fallback. First probe of
  the no-bun arm was a harness error (a symlinked `npx` resolves its CLI
  through the symlink's real dir) — invoke the launcher through `node`
  directly.
- 2026-09-03 — **two docs pages were on the site but in no sidebar.**
  Diffed the import script's globs against the hand-listed sidebar:
  `overview` (the deep-reference entry, `docs/README.md`, rewritten
  2026-08-26 around the five problems) and `differentiators` were
  imported and unreachable. The overview now heads the Internals group.
  `differentiators.md` was a second pitch carrying June numbers
  (144 vs 279 ms) that `benchmarks.md` and `comparison.md` § Where vx is
  ahead supersede — deleted, both inbound links repointed, and a
  "decision log lives in CLAUDE.md" phrase corrected while there.
  `tests/docs-sidebar-coverage.test.ts` pins both directions (every
  imported top-level doc is named; every sidebar link has a source);
  removing the new entry fails the orphan pin.
- 2026-09-03 — **two follow-ups from the same gate run.** (1) The
  macOS reporting-loss residual hit the local sharded gate a SECOND
  time (`--verify=all … leaky task` → `ok: true`), so the remedy named
  the first time is applied: on darwin the REPORTING assertions run only
  under `VX_REQUIRE_SANDBOX` (opt-in), not only on darwin CI — the
  sharded gate is the load that drops the records, and no timeout can
  recover a record that never arrived. Enforcement stays asserted
  everywhere; linux CI runs the reporting pins under bubblewrap. (2) The
  docs import cleared only three generated entries, so the deleted
  `differentiators.md` outlived its source as a live page for one build.
  A name manifest cannot fix this (my first attempt used the site's
  `.gitignore`, and removing the dead entry BEFORE the import meant the
  stale page was never named again) — so generated pages are now
  self-describing: the import writes a YAML comment marker into every
  frontmatter and clears any top-level page carrying it. Probed: a
  planted marked page is removed, an unmarked authored one survives. The
  coverage test still pins that the ignore list equals the imported set,
  so a generated page cannot be committed by accident.
- 2026-09-03 — **an empty shard passed silently.** `shard.ts run 200 199`
  exited 0 having spawned nothing, so a `test.N` task with more shards
  than files would read as green. The runner now refuses an empty shard
  (exit 2, naming the fix); pinned by spawning the real CLI, with a
  control that a populated shard still lists its file.
- 2026-09-03 — **warm run re-measured after the day's work: no
  regression.** `bench/run.ts`, best of 5: 1000 projects 224 ms (recorded
  237); 100 projects 84 ms against a recorded 78 — an 8% gap, so it was
  settled the way the rules say rather than argued: an interleaved A/B
  against an immutable `git worktree` at a4c8acc (the morning's last
  commit), three rounds of three reps each. Baseline min 85 ms, main
  min 83 ms — flat. The 78 was a cooler box; today's box had run the
  gate twenty-odd times. Nothing today touched the run hot path
  (`vx watch`, `vx init`, the eval-cache deny-list, the shard runner,
  docs), and the measurement agrees.
- 2026-09-03 — **sixteen internal seams narrowed.** The dead-export
  sweep (corrected rules: a barrel is a file with no function bodies;
  comments and tests are not consumers) found 61 core exports with no
  real consumer; 45 are test-facing seams the suite reads, which this
  repo accepts on purpose, and 16 were referenced by nothing at all —
  yet every one is used inside its own file, so only the `export`
  keyword was dead. Dropped it on all sixteen (`ZERO_COST` also left the
  graph barrel). No behaviour change; the type-aware lint is the proof
  nothing imported them.
- 2026-09-03 — **ten test-only names left the module barrels, two of
  them the public façade.** Of the 45 test-facing exports, 16 rode on a
  barrel or the façade. The docs decided each: the event-bus trio
  (`toWireEvent`, `wireForwarder`, `projectNode`), `EmptyHistoryProvider`,
  `listRuns` and `LOG_WIRE_VERSION` are described as seams or invariants
  and stay; the two log sizing constants and eight barrel-only helpers
  (`stripLiterals`, `CONFIG_EVAL_VERSION`, `MemoryCASBackend`,
  `makeDigest`, `populateGitFilesCache`, `ESSENTIAL_ENV`, `deniedCalls`,
  `PERSISTENT_TAIL_CHARS`) were contract noise only tests read. Tests
  now import them from the defining files (allowed for tests by the
  boundary rule); the façade snapshot lost two entries. The barrels are
  the cross-module contract, and a contract should name only what
  crosses. One pin pushed back: `util-tail.test.ts` asserted the cap
  constant is re-exported by the util barrel "because dropping any of
  these breaks the sole production holder" — true of the four
  FUNCTIONS `logger.ts` imports, false of the constant, which nothing in
  `src` reads through the barrel. The pin now says so and covers the
  functions only.
- 2026-09-03 — **the parked "second core" item, half-closed at the seam
  that matters.** Reproduced through the REAL compiled binary: a plugin
  verb throwing `UserError` printed `vx: UserError: bad flag --x` plus a
  stack, because the plugin's class comes from the node_modules copy of
  core and `instanceof` is false across copies. The scheduler had the
  same check, so a REAPI refusal from the shipped binary would have
  read as an "internal error" — the 2026-08-25 classification fix,
  silently undone in the binary. `isUserError` (by name as well as by
  class) is now what `bin.ts`, the scheduler and `@vzn/vx-mcp` consult,
  and it is on the façade so a plugin can classify the same way. The
  second copy itself (~12 ms per run) stays parked; the name is the
  contract that survives the copy boundary. Pinned: the helper with a
  foreign-class control, and a scheduler run whose executor throws a
  foreign-copy user error reports plainly. Swept the class: the other
  `instanceof` sites (`CorruptArtifactError`, `DependencySpecError`) throw
  and catch inside the same copy — REFUTED. Docs: `modules/util-errors.md`,
  the plugins guide (throw your own class named `UserError` if you like).
  `bin.ts` itself, the one consumer no in-process test reaches, is now
  driven as a subprocess: a plugin class merely NAMED `UserError` prints
  one line, a plain `Error` prints its stack; the mutation back to
  `instanceof` fails exactly the foreign-copy pin.
- 2026-09-03 — **perf wave 6: the output walk is gone from the warm
  hit.** `isOutputsCurrent` stats the recorded files; the glob existed to
  prove the output SET — no strays, nothing missing — and cost 0.36 ms
  per hit (365 ms CPU on a warm 1000-project run, the largest
  accumulated cost in the stage table). For `<dir>/**` globs the cache
  now records every directory under `<dir>` with its mtime after each
  save and restore (`output_dirs`, machine-local like the file rows; no
  `CACHE_VERSION` bump — nothing stored under a key changed, and absent
  rows mean the walk); on a hit, unchanged mtimes on all of them prove
  the set unchanged (a file added or removed anywhere the glob could see
  bumps a recorded directory). Any other glob shape, a remote ingest, a
  moved directory or > 256 directories keeps the walk. The per-file
  fingerprint check is untouched. MEASURED, interleaved A/B against a
  worktree at the previous commit: 1000 projects 224 → 204 ms (−9%);
  100 projects 77 ms best of 5. Pinned both ways in
  `tests/output-dirs.test.ts` (eligibility table, every set change,
  symlink not descended, cap, the forged-mtime trade, a stray still
  wiped on the next hit through `run()`, a root-anchored control); two
  mutations — skip without checking, record nothing — fail exactly
  their pins. Docs: `caching.md` § A current tree, `benchmarks.md`
  Wave 6, `modules/cache.md` (its stale `v25` corrected to `v27`).
  Stage table after the wave (warm 1000, in-process): run graph 98 →
  27 ms, total 203 → 176 ms, no `output glob` line at all; the new
  `output dirs` span read 0.12 ms per hit — one SQL round trip each — so
  the entry now carries the directory rows like the file rows (`getMany`
  batches them, the lazy `get` attaches them, parity pinned) and the hit
  path reads them without a query: run graph 18 ms, the span 0.07 ms per
  hit and all of it stats.
- 2026-09-03 — **discovery stats the config names instead of listing
  each project directory.** Micro-measured on the 1000-project bench,
  min of 5: a readdir per project 9.6 ms, stats in `CONFIG_FILENAMES`
  order 6.3 ms — with the bench's `.mjs` at the LAST name (four stats);
  a `.ts` config pays one. Bench-level the difference sits inside the
  noise floor, so the micro-measurement is the record. Precedence is
  unchanged (first name in the list wins, as `find` did).
- 2026-09-03 — **RED MAIN for one run (1ad0859), not the diff:** the
  ubuntu job's `archive restore — concurrent restores … two parallel
extracts` guard ran 400 rounds past the 5 s default timeout under the
  gate's four parallel shards on a small runner. Its own comment calls
  it a weak guard whose bound is the rounds; it now carries a 30 s
  timeout and a shard-cost hint. Discovery (the commit's diff) was
  green on both jobs' other files.
- 2026-09-03 — **RED MAIN (73a8021) — mine, wave 6, Linux only:** the
  ubuntu e2e `cache-hit restore removes stale files` wrote its stray right
  after a run, and Linux file timestamps are coarse (a kernel tick, up
  to 10 ms), so a directory modified in the same tick as the one that
  set its recorded mtime keeps that mtime and the stray was invisible —
  the racy-clean problem git's index solves by distrusting stats newer
  than the snapshot. Same rule now: a directory whose mtime lies within
  50 ms of the snapshot is racy and the WHOLE snapshot is dropped (a racy
  child dropped alone would leave its parent trusted); the next hit
  walks, and once the tree is older than the window it is recorded for
  good. Cost: one extra walk per entry after a save or restore; the
  steady state is unchanged. Pinned (`OUTPUT_DIRS_RACY_MS`), and the e2e
  pin now shows the miss recording nothing and the first aged hit
  recording. macOS had passed every time — APFS timestamps are fine
  enough that the same-tick case never showed.
- 2026-09-03 — **the site's benchmark is the 3,270-task shape again,
  re-run today with CPU.** The owner read the landing page as "vx got
  much slower, especially cold, and CPU is missing". What had happened:
  the 2026-09-02 rewrite swapped the page's benchmark from the
  1,090-package / 3,270-task stress shape (`bench/compare.ts` defaults)
  to a 476-package run with a narrower margin, and dropped the cold and
  CPU rows because the reproducible runner did not measure CPU. vx did
  NOT get slower: re-run on the old shape today, vx is cold 3m 46s
  (the page had said 3m 48s), warm 559 ms (0.55 s), restore 830 ms
  (0.89 s). `compare.ts` now reports CPU (user + system of the
  invocation and the children it waited for — a daemon that outlives it
  is not counted, so Turbo's and Nx's are floors). Today, same machine
  (10 cores), Turbo 2.10.12: cold 5m 13s (1.4×), warm 760 ms (1.4×),
  restore 1.17 s (1.4×), CPU 73 s vs vx's 34 s (2.1×). Nx 23.2.0
  collapsed on this shape: cold 34m 44s (9.2×), warm 3.59 s (6.4×),
  CPU 114 minutes (199×). The June figures (Turbo 8m 18s cold, 1,250 s
  CPU) came from a 4-core Linux box, where the runners' overhead
  competes with the tasks for cores — noted in `benchmarks.md`; the CPU
  row is the number that travels between machines. Landing page rows,
  tiles and note, `benchmarks.md` § A real monorepo, and the committed
  `bench/RESULTS.md` / `results.json` are this run.
- 2026-09-03 — **baseline bars on the site: the theoretical best case,
  so every bar shows its overhead** (owner's ask). Definition, all
  measured or computed by `bench/compare.ts` and committed in
  `bench/results.json` (`baseline`): cold = the 3,270 tasks' own
  durations list-scheduled critical-path-first on 10 workers along the
  exact dependency graph (3m 38s — the work bound, 2,180 task-seconds ÷
  10; the critical path is 100 s); warm = one `git status -uall` walk,
  the floor of asking what changed (71 ms); restore = that walk plus a
  raw copy of every output file (299 ms); CPU = the exact commands under
  the thinnest runner, `xargs -P 10 sh -c`, best of two readings
  (34.05 s; single readings of the same shells varied 33.5–34.9 s). Two
  wrong turns recorded: a FIFO list schedule read 4m 58s, ABOVE vx's
  measured cold run, because it starts a layer's tests before its builds
  and starves the next layer — an ideal scheduler is critical-path-first;
  and sampling one shell at a time over-counted process creation (38.6 s
  of "floor" against vx's 34.3 s whole run). Read against the floor: vx's
  overhead is 8 s cold (3.7%), 488 ms warm, 531 ms restore, and 0.3 s of
  CPU — inside the floor's noise; Turbo's 95 s cold and 39 s of CPU;
  Nx's 31 minutes and 114 minutes. `BASELINE_ONLY=1` recomputes the
  floors against the committed rows in ~9 minutes. Dashed grey bar on
  the landing chart, a legend sentence in the note, rows in
  `bench/RESULTS.md` and `benchmarks.md` § A real monorepo.
- 2026-09-03 — **perf wave 7: git starts the moment the root is known.**
  The git enumeration split (spawn-wait 68–70 ms for the four concurrent
  spawns, JS apply 4 ms) said the wait is the walk, and the early start
  for unscoped runs sat AFTER the workspace config, discovery and the
  cache open although it needs only the root and the task specs. Moved
  to right after `findWorkspaceRoot` (the unscoped rule recomputed from
  the specs there; the later `hasBare` loop still seeds the scope). Stage
  table: git enumeration own 41–55 → 25–30 ms, in-process warm 1000
  projects 170 → 154 ms. Interleaved A/B, three rounds of three, whole
  process: 195 → 172 ms (−12%); 100 projects 74 ms best of 5. Seven
  suites that could pin spawn order pass unchanged.
- 2026-09-03 — **an unread index cost every warm run 7 ms.** Splitting
  `record history` (11 ms on the 1000-project bench) found `runs` carrying
  five indexes and `runs_hash` serving no query: both readers of
  `runs.hash` (`vx why`, the input diff) look the row up by run id or
  project+task and then read the column. Measured on a copy of the bench
  database: 1,000 inserts 11.5 → 3.9 ms without it. The schema now
  `DROP INDEX IF EXISTS` it so existing databases shed it on open; no
  schema-version bump (an index is not a stored shape). The cache, why,
  metrics, history and run-record suites pass unchanged.
- 2026-09-03 — **the site's vx rows re-measured after waves 6 and 7**
  (`RUNNERS="vx,vx (frozen)"`, a new `compare.ts` filter that re-runs a
  subset and keeps the committed rows of the rest — ~10 minutes instead
  of 50): cold 3m 46s, warm 549 ms, restore 844 ms, CPU 30.8 s; frozen
  476 ms / 743 ms. At 3,270 `sleep 1` tasks the ~40 ms the two waves took
  off a 1000-project warm run sits inside this shape's run-to-run noise,
  which is the honest reading. The CPU floor re-measured at 33.9 s —
  above vx's 30.8 — because both vary by ±2 s at this size; the legend
  and the doc say so rather than let a dashed bar longer than vx's pass
  unexplained. Turbo and Nx rows are the morning's measurement.
- 2026-09-03 — **the baseline's ideal scheduler is a pure module with
  pins.** `bench/ideal.ts` (`listSchedule(nodes, workers)`) is what
  `compare.ts` now calls; `tests/bench-ideal.test.ts` pins it over graphs
  with hand-computable optima — a diamond bound by its critical path, a
  graph where FIFO needs 4 s and critical-path-first 3 s, a zero-cost
  ordering node with a work-bound fan-out, the empty graph, a cycle
  refused. The FIFO mutation fails exactly the gating pin. The function
  asserts its own bounds (never below max(critical path, work ÷
  workers), never above the work bound plus the critical path plus one
  task), so a wrong floor cannot reach the website silently again.
- 2026-09-03 — **the config-eval lookups are one query per round.**
  `loadProjectConfigs(paths, opts)` reads every config's bytes and key in
  parallel, asks the store once (`ConfigEvalStore.getConfigEvals`,
  optional — a store without it is asked per key; `Cache` answers with
  one `IN` query per 900 keys), then evaluates only the misses in the
  order given so a failure still names the first broken file.
  `loadProjectConfig` is the one-element case; `prepareRun`'s round loop
  calls the batch. Measured earlier: 1,000 point lookups 3.6 ms, one
  `IN` query 0.7. Pinned: a mixed round serves the hit from ONE lookup
  without evaluating and evaluates the miss; forcing the batch empty
  fails exactly that pin. The lead's ceiling was ~3 ms and the stage
  table agrees.
- 2026-09-03 — **two small pins and the closing measurement.** The
  batched loader's claim that a round with two broken configs names the
  FIRST in the given order is now a pin (both orders). `bench/generate.ts`
  refuses a numeric first argument: its count is the second, and a
  `1000/` directory had appeared in the repo root that way. Closing warm
  run, best of 5: 1000 projects 177 ms (recorded 172, two outliers from a
  box running CI polls), 100 projects 79 ms.
- 2026-09-03 — **perf wave 8: a warm config load keys itself from stat
  identities.** Reading and scanning 1,000 configs to key them cost
  15 ms (bytes 9.3, gate + key 6.1); stat-hashing them with `hashFile`'s
  mtime/size/ctime/inode memo costs 5.2. The store now keeps each
  config's ORDERED closure (`config_closures`: the config first, then
  every relative import in discovery order), written whenever the slow
  path keys a config whose relative imports all carry an explicit
  extension; on the next load `loadProjectConfigs` keys such a config
  with `configEvalKeyFromClosure` — per-file identities only, no read,
  no scan — and a fast key that misses takes the slow path for that one
  config, which re-indexes it. `CONFIG_EVAL_VERSION` → 2: the key now
  folds each closure file's git blob id instead of its bytes (old
  entries unreachable, self-healing on the first miss). SOUND because
  membership can only change by editing a listed file, which changes
  its identity and so the key; the one exception — an extensionless
  relative import a new file could re-resolve — is never indexed.
  Resolved imports are real-pathed in the slow path: `Bun.resolveSync`
  answered with the symlinked spelling on one call and the real one on
  another, a spurious miss and a duplicated memo row. MEASURED:
  in-process `load configs` 27 → 20 ms on the 1000-project bench (three
  runs each); the whole-process interleaved A/B was INSIDE this box's
  noise (mins 184 vs 178 with a 623 ms outlier — CI polls and a long
  day), so the stage table is the record and the A/B is not claimed.
  Pinned: closure order and indexability, a warm load served from the
  index with nothing evaluated, a preset edit that misses and
  re-evaluates through the fast key, an extensionless import never
  indexed; the fold-only-the-config and drop-the-extension-rule
  mutations each fail exactly their pins. Docs: `modules/config-cache.md`
  § The warm fast path, `caching.md`. Two edges pinned afterwards: a
  DELETED closure file cannot be served from the index (the fast key
  cannot be built and the live load fails on the import, never the
  stale value), and the closure index honours the local read/write
  axes like the evaluations do.
- 2026-09-03 — **the site is generated from the runner's results.**
  `bench/update-site.ts` rewrites the landing page's rows, tiles and
  note and `benchmarks.md` § A real monorepo from `bench/results.json`;
  `--check` exits 1 when the site drifts from the results. Its first run
  found the drift my session-local scripts had left: the tiles and the
  note still said 559 ms and 34 s after the vx rows were refreshed to
  549 ms and 31 s, and the doc heading carried a raw timestamp. The
  scratchpad scripts are gone; the generator is the only path, and the
  docs project's `ci` group now depends on a `site-check` task that runs
  `--check` with the results file, the generator, the landing page and
  the doc as inputs — a hand-edited tile turns it red (verified), and a
  missing formatter makes the check THROW rather than pass vacuously
  (probed: the spawn itself fails, so the fallback branch is unreachable
  for an absent binary).
- 2026-09-03 — **RED darwin on 5f17041 (a STATUS-only commit): a timing
  assumption in the wave-6 e2e pin.** It asserted the MISS records no
  directories because the tree is younger than the 50 ms racy window;
  on the slower macOS runner the build and save took longer than the
  window, so the miss recorded and the pin failed. The racy rule is
  pinned deterministically at the Cache level; the e2e now asserts only
  that the aged hit records and that a stray still forces the restore.
- 2026-09-03 — **baseline corrected to the owner's definition; bars
  proportional.** The owner's screenshot: only the cold row has a
  theoretical nonzero baseline; a cached run, a restore and the CPU a
  runner burns are 0 in theory, so the site's baseline for those rows is
  0 and everything drawn is the runner (the measured floors — one git
  walk, walk + raw copy, the task shells under xargs — stay in
  `bench/RESULTS.md` and the doc as context, not as the baseline). And
  the bars were not proportional: a 3% minimum width put vx (30.8 s),
  Turbo (73 s) and the baseline at the same floor while Nx's 114
  minutes set the scale. The chart now draws true proportions with no
  minimum; a row's scale is its largest non-outlier value, and a bar
  more than 10× the next runner's is drawn clipped with a break, its
  number exact. `bench/update-site.ts` regenerates all of it, and
  `tests/bench-site.test.ts` pins the two rules in the core suite (the
  cold row's baseline equals the results' ideal, the other three are 0;
  the chart has no minimum width and clips an outlier).
- 2026-09-03 — **`status -unormal` REFUTED as a lead — and a measurement
  trap recorded.** A split of the 59 ms status walk read `-uall` 58.6 ms
  against `-unormal` 18.8, so a two-spawn design (stop at untracked
  directories, list their files with one scoped `ls-files -o` only when
  any exist) was built and pinned. Measured beside the other three
  enumeration spawns it was SLOWER (76–86 ms), and a clean matrix —
  untracked cache off/on × `-uall`/`-unormal` × alone/beside — read
  `-unormal` at 60 ms alone and 64–78 beside, `-uall` 59.6 and 78: no
  difference, and git's untracked cache changes nothing. The 18.8 was
  an artifact: the fsmonitor probe run just before had left git's
  untracked-cache extension in the bench index, which git keeps using
  after the config is unset. Reverted to `-uall`; the new pin (files
  inside a brand-new untracked directory enumerate, an ignored one does
  not) stays as a tripwire. Lesson for the memory: a git-side number
  measured after another git probe is suspect until the index
  extensions are cleared (`update-index --no-untracked-cache`,
  `fsmonitor--daemon stop`). fsmonitor itself: 57.6 vs 59.1 ms, no gain
  on this tree. The walk is git's fixed cost at this size.

- 2026-09-03 — **perf wave 9: streaming restore.** `restoreOutputs`
  no longer holds the artifact: `src/cache/tar-stream.ts` reads the tar
  as it streams out of `DecompressionStream('zstd')` (ustar name/prefix,
  pax `path`/`size`, GNU `L`, checksums, truncation → `TarFormatError`),
  and `archive.ts` gained one staging extractor both readers share —
  write beside the target as `.vx-tmp-*`, rename only after the WHOLE
  archive ended cleanly and the index's recorded outputs are present;
  on any failure unlink the temps and prune the empty directories the
  extraction created. Measured in a fresh process, 150 MiB
  incompressible artifact: peak RSS +644 MiB → +49–60 MiB, wall
  112–121 → 103–115 ms. Tiny artifacts: the stream setup costs ~35 µs
  each (390 vs 355 ms per 1 000, 4% of the headline restore row), so
  artifacts ≤ 4 MiB compressed decode in one call and feed the SAME
  reader and extractor. The 2 GiB ceiling is a running count on the
  stream. `tests/archive-security.test.ts` now runs every restore case
  against both readers (`describe.each`); `tests/tar-stream.test.ts`
  pins the dialect (Bun.Archive round trip across chunk sizes 1…1 MiB,
  pax and GNU long names, corrupt checksum, truncation);
  `tests/artifact-roundtrip.test.ts` pins the >4 MiB path through the
  real cache incl. a poisoned trailing entry leaving an empty project
  dir. Then (same day) ingest moved onto the same reader
  (`scanArtifact` lists entries and stdout without materialising) and
  `readArtifact` / `extractOutputs` / `readEntryText` were deleted:
  `Bun.Archive` now only WRITES artifacts; the security suite is back
  to one `restore` helper (there is one reader to drift). Refuted on
  the way: `Bun.Archive` does not auto-detect zstd and `.files()`
  copies every entry (+131 MiB on 150 MiB), so it cannot be the
  streaming reader. `Bun.Archive.extract` was not measured — its
  materialisation of links is the class the extractor exists to refuse.
  Headline shape re-measured for vx alone afterwards (`RUNNERS=vx`,
  box idle): cold 3m 46s → 3m 46s, warm 549 → 516 ms, restore 844 →
  799 ms, CPU warm 2.00 → 1.35 s — no regression from the new reader
  on 1 090 one-file artifacts; the site regenerated from the new rows.
  Two more pins from the audit: a pax `path` record that renames a
  benign header to a traversal is refused with nothing written, and a
  compressed stream cut mid-archive above the threshold surfaces as
  `CorruptArtifactError` through the real cache with the staged temp
  gone. Docs: `docs/caching.md` § container, `docs/modules/cache.md`.
- 2026-09-03 — **ingest scans from the temp file.** A remote artifact
  was decoded whole into memory to be indexed; now the compressed bytes
  are written to the temp first (node's `writeFile` — `Bun.write` copies
  the buffer, +151 MiB and 33 ms on 150 MiB against +0 and 21) and an
  artifact above 4 MiB is scanned from that file as it decodes, with
  the declared-size check on its first 32 bytes; the temp is unlinked
  on any refusal and the final path is untouched until the archive has
  passed. Measured with the compressed 150 MiB live (it always is on
  this path): peak +448 → +318 MiB, wall 68 → 77 ms (the read-back).
  Two measurement traps recorded: a Blob source is NOT bounded (it
  copies its bytes and hands the decoder everything at once, +519 MiB);
  and a single-process memory probe with a large buffer alive reads the
  collector's pacing, not retention — the same scan is +30 MiB RSS in a
  fresh process and +315 with 150 MiB of ballast live. Pinned: a large
  ingest cut mid-stream refuses with no temp left (this would have
  caught a missing `unlink` import the lint filter hid), and a large
  intact ingest indexes and restores.

## In flight

- Nothing.

## Next (ordered)

1. **A live REAPI run of the whole graph.** `vx run ci --all` against a
   NativeLink worker has not run since the barrel narrowing and the
   by-name error classification (both 2026-09-03); the plugin's unit
   half is green, the live files skip without an endpoint, and docker
   was down on this machine that day. `tests/helpers/nativelink.md` has
   the dev config. Expect nothing to change; prove it.
2. **The shipped binary's second core.** A compiled `vx` loading a
   `vx.workspace.ts` that imports `@vzn/vx` pulls a second copy of core
   from `node_modules` (~12 ms) on every run. The user-visible half is
   closed (`isUserError` classifies by name across copies); what remains
   is the cost and the duplicate module state — and the cost is NOT
   measurable as an A/B from a workspace file (2026-09-03): a workspace
   importing plugins by absolute source path also loads source, since the
   binary cannot expose its bundled core to a workspace import, so both
   arms read equal (77 vs 74–81 ms at 100 projects). REFUTED as a
   runtime-plugin fix (Bun 1.4.0's `Bun.plugin` hooks never fire for
   bare specifiers or `.ts`); options left are rewriting the config
   source before import or a Bun fix. Parked.
3. **The watch e2e flake** — if `re-runs the task after a file change,
then exits on SIGINT` times out again, keep that run's stdout: the
   presence of `re-running...` separates a lost event from a slow
   re-run (see the 2026-09-03 watch entry).
4. **Re-measure the warm run after each day's work** — the hot path is
   the product. `bun bench/run.ts 100 5` and `1000 5`; an interleaved
   A/B against an immutable worktree settles any gap. Closing figures
   for 2026-09-03, after wave 6 and the discovery change, best of 5:
   1000 projects 193 ms (table says 204, measured before discovery
   changed), 100 projects 81 ms, on a box that had run the gate all day.
5. **DONE 2026-09-03 as wave 6 (224 → 204 ms).** The lead, kept for the
   method: measured (`VX_TIMING=1`, warm 1000
   projects, 203 ms in-process):\*\* git enumeration 51 ms (overlapped with
   33 ms of config loads), discover 22, classify+probe 22, run graph 46,
   history 8. Inside run graph the accumulated cost is the OUTPUT
   CURRENCY check: 365 ms CPU of `output glob` over 1000 warm hits
   (0.36 ms each) plus 49 ms of stats, against 11 ms for every task
   hash. The glob exists so a hit is "current" only when the output
   tree equals the entry's set exactly (strict ownership). The obvious
   design is a directory-mtime short-circuit — record each output
   directory's mtime at save/restore, skip the glob while it matches —
   but `isOutputsCurrent` is stale-hit-critical: design it with the
   accepted `touch -r` trade in view, pin both directions, and MEASURE
   before claiming the ~15% it suggests.

6. **After waves 7 and 8, closing 2026-09-03:** in-process stage table
   on the 1000-project bench — discover 20 ms, load configs 23, git
   enumeration 21, classify + probe 23, run graph 21, record history 11,
   total ~151 ms — and whole-process best of 5: 1000 projects 186 ms,
   100 projects 77 ms. What is left is the
   floors: the git walk (~28 ms exposed), 1,000 task hashes (11 ms),
   1,000 file and directory stats (18 ms), 1,000 manifest reads in
   discovery (10 ms) and the batched inserts (9 ms). The next real win
   is structural (fsmonitor-backed git status, or not needing a walk at
   all), not another stage shave. **Wave 7 (git first, 195 → 172 ms).**
   Reading the table
   after it: `open cache` (12.5 ms) and `discover` (21 ms) read high
   while git runs because the spawns' pipe callbacks land in whichever
   stage is current — the parts themselves measure 1.2 ms (SQLite open),
   0.1 (fingerprint), 1.4 (package graph), 17 (discovery alone). Not
   leads. `record history` was 11 ms of 1,000 inserts × five `runs`
   indexes — one of which, `runs_hash`, had no reader (every consumer of
   `runs.hash` looks the row up by run id or project+task first);
   dropping it measured 11.5 → 3.9 ms for the inserts. Two small leads
   left, each measured: the 1,000 `config_evals` point lookups (DONE —
   `loadProjectConfigs`, one query per round); and `getMany`'s 1,000
   artifact-existence stats inside `classify + probe` — MEASURED 2.7 ms
   of `getMany`'s 5.8 ms on the bench (2026-09-03), and moving them to
   restore time needs a re-execute fallback for a hit whose artifact is
   gone, which the hit path lacks. CLOSED: a new failure path for 2.7 ms
   is the wrong trade. `classify + probe` (23 ms) now has spans:
   `stable keys` 12 ms — of which the 1,000 task hashes are 10–11, so
   the classification itself is ~1.5 — and `probe` 8.3 ms (`getMany`
   5.8 plus the restore-tier bookkeeping). The hashing is the floor of
   key derivation; nothing here is a lead. **The stage table
   after wave 6** (warm 1000 projects, in-process
   ~176 ms; the bench's whole-process number is 204 ms): git enumeration
   54 ms wall (overlapped with the 36 ms of cached config loads, so ~20 ms
   exposed), discover projects 22–44 ms (a readdir + a manifest read +
   JSON.parse per project), classify + probe 26 ms, run graph 18 ms
   (all of it file and directory stats), history 8 ms. The next real
   lead is git. SPLIT (2026-09-03, in-process timer, 7 runs, min):
   `ls-files -s -v` 11 ms, `status --porcelain -z -uall` 59 ms,
   `rev-parse` 9 ms, `config` ~9 ms — the last two are the spawn floor
   itself. The four run concurrently, so wall = the status walk;
   `core.untrackedCache` did NOT help on this filesystem (58.6 ms with
   it). `rev-parse --show-prefix --git-dir` is derivable from the `.git`
   resolution `readHeadDirect` already does (a CPU saving, ~9 ms, wall
   gain a few ms on a loaded box — the helper would have to move out of
   `orchestrator` for `cache` to reach it); `config` is NOT safely
   derivable (global/system config decide CRLF classification, which is
   key-affecting). Caching the status result would need a proof it is
   still valid, and the index mtime is not one — an untracked file is
   invisible to the index. Discovery's readdir is DONE (stats, above).

The audit rotation continues by the standing rule: newest code first,
probes become tests, refutations recorded in the shipped entry that
closes them.

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
