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

A digest, newest last; the commits carry the detail. Numbers are the
1000-project bench (`bench/run.ts`, warm, whole process, best of 5)
unless a shape is named; "interleaved A/B" means arms alternated against
an immutable `git worktree` of the previous commit.

**Scope reset (2026-09-02).** Compact `CLAUDE.md`; removed
`@vzn/vx-agents`, predictive scheduling, the mcp-only queries, the
decision-log archive, `docs/progress/` and the removed products' design
docs. `bench/` fixed for the `packages/vx` layout.

**Perf waves, warm run 400 → ~172 ms at 1000 projects** (100 projects
105 → 74–79 ms):
- W1: unscoped runs start git before configs load; config-eval cache
  for provably-pure configs (`config_evals`). 400 → 270 ms.
- W2: `VX_TIMING=1` stage table; one worktree walk (`ls-files -s -v` +
  `status --porcelain -uall`, 4 spawns not 5); `.git/HEAD` read directly
  (−10 ms); discovery via readdir not glob (25 → 2 ms); code-unit sort
  (−28 ms ICU). 270 → 242 ms. REFUTED: sync fs on the hit path (40 ms
  slower under concurrency); one `bun build --target=bun` bundle (start
  25 → 36 ms).
- W3: `CacheLayer.getMany?` + `CacheEntry.outputRows`; memoised globs.
  2000-task `run test --all` 328 → 311 ms.
- W4: `vx info` reports git's fsmonitor/untracked-cache; the eval key
  folds `VERSION` (a stored evaluation must not outlive its validator).
- W5: the classify pass runs for flat graphs too (one batched `getMany`).
  100 tasks 84 → 78 ms, 1000 → 249 → 237. REFUTED: fsmonitor at 100
  projects; lazy-loading modules (`--version` is 13 ms of module load).
- W6: `output_dirs` — the output glob walk left the warm hit (0.36 ms/hit,
  365 ms CPU); directory mtimes prove the set. 224 → 204 ms, run graph
  98 → 18 ms. Racy-clean rule `OUTPUT_DIRS_RACY_MS` = 50 (Linux coarse
  timestamps; a racy snapshot is dropped whole).
- W7: git starts right after `findWorkspaceRoot`: 195 → 172 ms (−12%).
- Unread `runs_hash` index dropped: 1000 inserts 11.5 → 3.9 ms. Eval
  lookups one `IN` query per round (3.6 → 0.7 ms). Discovery stats the
  config names (9.6 → 6.3 ms). Warm config load keys from stat
  identities via ordered closures (`config_closures`,
  `CONFIG_EVAL_VERSION` 2): load configs 27 → 20 ms in-process.
- REFUTED as leads: fsmonitor (57.6 vs 59.1 ms), git's untracked cache,
  `status -unormal` (a clean matrix reads equal; the 18.8 ms was a
  probe's residue in the index — clear it with
  `update-index --no-untracked-cache`), the `getMany` artifact stats
  (2.7 ms), lookahead scheduling. The git walk is git's fixed cost.
- Floors and the stage table live under Next § 5.

**Pipeline v2.** Stages `config` / `project` / `graph` (in-place edits,
re-validated, zero cost undeclared); `commands` (plugin verbs, core
wins, `vx help` lists them; a verb resolving a non-integer fails
naming the plugin); `key` (material folded as `plugin` components, no
`CACHE_VERSION` bump) and `schedule` (weights over the baseline); the
predictive mode returned as `@vzn/vx/plugins/schedule-history`. The
`eventSink` seam is gone. `@vzn/vx-mcp` is back as a plugin on
`commands` (no SDK; a streaming decoder per session after a split-`é`
bug). README, site intro and the extensibility guide reframed on the
stage table.

**Distribution and the binary.** Bun 1.4.0 compiled binaries are
SIGKILLed on this macOS until `codesign -s - --force` (release and CI
re-sign). The binary resolves packages by directory convention only, so
root shims `packages/*/index.ts` + `plugins/<name>/index.ts` exist and
are pinned. The npm manifest exported only `"."` and the darwin platform
binaries were unsigned — both fixed in `npm.yml`; the version stamp
targeted the wrong manifest (every release would have said `0.0.0`) —
all stamp steps hit `packages/vx/package.json` and assert `--version`.
The npm launcher is pinned through `node`. `isUserError` classifies by
name across the binary's second copy of core (the copy itself, ~12 ms,
stays parked — see Next § 3, incl. the refuted resolve-hook route).

**Cache container, streamed (waves 9–10, 2026-09-03).** vx's own
streaming tar reader and writer (`src/cache/tar-stream.ts`) replaced
`Bun.Archive` on every side. Restore: one staging extractor (write
beside the target, rename after the WHOLE archive is read and the
index's outputs are present; abort unlinks temps and prunes only empty
directories). 150 MiB incompressible artifact, fresh process: restore
peak +644 → +49–60 MiB (same wall); save +705 → +241–269 MiB (160 →
~200 ms, the streamed compressor is ~2.4× per byte); ingest +448 → +318
MiB with the compressed bytes live. Artifacts ≤ 4 MiB compressed pack
and decode in one call (stream setup ~35 µs each; tiny-artifact A/B
inside noise). A sizeless zstd frame is decoded under the running 2 GiB
count instead of refused; the `trusted` flag went. Reader pins: pax
`path`/`size`, GNU `L`, base-256 sizes, checksums, truncation, strict
octal, ustar split at its exact limits (against libarchive and the
system `tar`), a poisoned trailing entry writing nothing, a concurrent
writer's file surviving abort, a cut compressed stream refused with no
temp. No `CACHE_VERSION` bump: same layout, readable either way.
Measurement traps recorded: a Blob source is not bounded; a one-process
memory probe with a large buffer live reads GC pacing (+315 vs +30 MiB
in a fresh process); piped oxlint prints one line per finding.

**Headline benchmark and site.** The landing page is the 1,090-package /
3,270-task shape again, with cold, warm, restore and CPU rows: vx 3m 46s
/ 510 ms / 777 ms / 34.6 s; Turbo 2.10.12 5m 13s / 760 ms / 1.17 s /
73 s; Nx 23.2.0 34m 44s / 3.59 s / 4.15 s / 114 min. Baseline is the
theoretical best case (cold = critical-path-first list schedule of the
exact DAG on 10 workers, 3m 38s, `bench/ideal.ts` with pins; the other
rows 0); bars are proportional with an outlier clipped past 10×.
`bench/update-site.ts` generates rows, tiles, note and
`benchmarks.md` from `results.json`; `site-check` gates drift.
`RUNNERS=vx` re-measures one runner in ~6 min; `BASELINE_ONLY=1` the
floors. Re-measured after waves 6–7, 9 and 10: no regression.

**`vx init` and first-run DX.** `migrate-scripts` maps `package.json`
scripts to tasks (pre/post hooks folded in npm order, `<pm> run x`
becomes a group, `build` gets a cache block with empty outputs under a
TODO). `init` on a workspace with no scripts writes the workspace file
and prints an example config and the next command; generated configs
carry `import type { ProjectConfig }` + `satisfies` (erased at runtime);
an unresolved config import is a `UserError` naming the file and, for
`@vzn/vx`, the install command; a typo says `Did you mean build?`.
`vx watch` ignores a task's own declared outputs (one cycle per edit)
and proves each watcher delivers before saying "watching"
(`.vx-watch-probe`, re-written on a backoff; the e2e flake is NOT
proven closed — see Next § 4). The cache dir writes its own
`.gitignore`. Replayed and found working as documented: every verb,
the policy flags, a failing task, a persistent task, `--affected`, the
plugin author's first plugin from the guide (which gained § Testing
your plugin), and the same first run through the compiled binary.

**Audits with pins (each mutation fails exactly its pin).** Config-eval
purity gate closed against `\u0070rocess`, `global`/`self` aliases and
`Temporal` (`configEvalKey` refuses backslashes in code); `getMany`
parity with `get` (read gate, deleted artifact, LRU touch); the shard
dealer and an empty shard refused; sixteen dead `export`s and ten
test-only barrel names removed; comparison.md re-verified against Turbo
2.10.12 / Nx 23.2.0; two orphan site pages found and the sidebar
coverage pinned; generated site pages self-describe. The core suite
runs as four shards (`tests/helpers/shard.ts`; a file importing
thousands of modules is `@vx-shard-isolate`d because `bun test` pins
~2 descriptors per import — tripwire test kept for the day Bun fixes
it).

**Red mains, each explained and pinned:** an ms-mtime precondition
sampled the clock (stamped now); a 400-round guard past the 5 s
timeout under four shards (30 s + cost hint); Linux racy-clean (the
50 ms window); a darwin-only timing assumption in an e2e pin; a version
assertion written against `cd` (both jobs name the manifest from
`$GITHUB_WORKSPACE`). The macOS sandbox reporting-loss residual (~2%
under load) gates its reporting pins on `VX_REQUIRE_SANDBOX`. And one
gate that failed on every shard was the BOX (load 70–97, `diagnosticd`
pegged): HEAD failed identically; CI was the arbiter and the full gate
passed once the load fell.

## In flight

- Nothing.

## Next (ordered)

1. **A live REAPI run of the whole graph.** `vx run ci --all` against a
   NativeLink worker has not run since the barrel narrowing and the
   by-name error classification (both 2026-09-03); the plugin's unit
   half is green, the live files skip without an endpoint, and docker
   was down on this machine that day. `tests/helpers/nativelink.md` has
   the dev config. Expect nothing to change; prove it.
2. **The remote seam still moves whole artifacts.** With save, ingest
   and restore bounded, `RemoteCacheLayer` is the last place a large
   artifact sits in memory: `put(hash, body: ArrayBuffer | Uint8Array)`
   gets the on-disk artifact via `Bun.file().bytes()`, and `get` returns
   an `ArrayBuffer` that ingest writes to its temp. Widening both to a
   `Blob` (a `BunFile` is one; bytes wrap in one) would let uploads
   stream from disk and downloads land in the temp directly — but
   `@vzn/vx-reapi` must digest the whole body before it can upload, so
   the plugin side needs a streaming digest and a chunked `writeBlob`
   first. A breaking seam change for plugin authors; do it with the
   plugins guide, the stub layers in the tests and `vx-reapi` in one
   commit, and measure a 150 MiB round trip through the stub before
   and after. Not started.
3. **The shipped binary's second core.** A compiled `vx` loading a
   `vx.workspace.ts` that imports `@vzn/vx` pulls a second copy of core
   from `node_modules` (~12 ms) on every run — and makes a binary user
   install the package at all. REFUTED 2026-09-03 as a runtime fix: a
   `Bun.plugin` `onResolve` hook registered by the binary never fires
   for a bare specifier imported by a dynamically imported user file
   (Bun 1.4.0, probed in plain `bun` with a `.ts` and a `.mjs` user
   file), so the binary cannot serve its bundled core to the workspace
   file that way. The user-visible half is
   closed (`isUserError` classifies by name across copies); what remains
   is the cost and the duplicate module state — and the cost is NOT
   measurable as an A/B from a workspace file (2026-09-03): a workspace
   importing plugins by absolute source path also loads source, since the
   binary cannot expose its bundled core to a workspace import, so both
   arms read equal (77 vs 74–81 ms at 100 projects). REFUTED as a
   runtime-plugin fix (Bun 1.4.0's `Bun.plugin` hooks never fire for
   bare specifiers or `.ts`); options left are rewriting the config
   source before import or a Bun fix. Parked.
4. **The watch e2e flake** — if `re-runs the task after a file change,
then exits on SIGINT` times out again, keep that run's stdout: the
   presence of `re-running...` separates a lost event from a slow
   re-run (see the 2026-09-03 watch entry).
5. **Re-measure the warm run after each day's work** — the hot path is
   the product. `bun bench/run.ts 100 5` and `1000 5`; an interleaved
   A/B against an immutable worktree settles any gap. Closing figures
   for 2026-09-03, after wave 6 and the discovery change, best of 5:
   1000 projects 193 ms (table says 204, measured before discovery
   changed), 100 projects 81 ms, on a box that had run the gate all day.
   Floors on the 1000-project bench (in-process, 2026-09-03): discover
   20 ms, load configs 21–23, git enumeration 21–47 exposed (the walk's
   own noise), classify + probe 23, run graph 19–21, record history
   11; total 151–184. What is left is the git walk (~60 ms, exposed by
   whatever it fails to overlap), 1,000 task hashes (11 ms), 1,000 file
   and directory stats (18 ms), 1,000 manifest reads (10 ms) and the
   batched inserts (4 ms after `runs_hash` went). The next real win is
   structural (not needing a walk), not another stage shave; fsmonitor,
   untracked cache and `-unormal` are refuted (see Shipped).

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
