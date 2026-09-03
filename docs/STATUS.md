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
temp. No `CACHE_VERSION` bump: same layout, readable either way. One
defect found by the audit rotation the same evening: a name over 100
bytes made of multibyte characters (a 141-byte Japanese path is
enough) threw "name too long for ustar" instead of writing its pax
record, because the header name under pax was sliced by characters;
it is the first 100 bytes now, pinned against vx and libarchive, and
the pin fails without the fix. Memory claim measured to its edge: vx
holds one chunk (a single 400 MiB entry restores at +30 MiB, the same
as 150 MiB), while 200 × 2 MiB entries read +90–180 MiB of per-entry
garbage the collector paces — identical configurations differed by
90 MiB run to run, so no code change is justified; the docs now say
"holds one chunk", not "bounded by a chunk". The in-flight write bound
and the buffering threshold were both varied and changed nothing. The
darwin CI job's compiled-binary step now declares an output, deletes
it and asserts the cached run restores it, so the container is
exercised through the binary on every push, not only locally.
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
`@vzn/vx`, the install command; a typo says `Did you mean build?`,
and a qualified one is hinted as a runnable spec on either half
(`ap#build`, `app#buidl` → `app#build`).
`vx watch` ignores a task's own declared outputs (one cycle per edit)
and proves each watcher delivers before saying "watching"
(`.vx-watch-probe`, re-written on a backoff; the e2e flake is NOT
proven closed — see Next § 4). The cache dir writes its own
`.gitignore`. Replayed and found working as documented: every verb,
the policy flags, a failing task, a persistent task, `--affected`, the
plugin author's first plugin from the guide (which gained § Testing
your plugin), the same first run through the compiled binary, and
`vx migrate` on a scratch Turborepo (negated outputs and the
persistent task get exact TODOs, `env` passes through, global inputs
become `vx-preset.ts`) and on a scratch Nx graph (named inputs expand,
`{workspaceRoot}` outputs map, chained commands join) — where the
common executors (`@nx/vite:*`, `@nx/vitest:test`, `@nx/jest:jest`,
`@nx/eslint:lint`, `@nx/js:tsc`) now become their CLI under a TODO
naming the executor instead of an exit-1 placeholder; pinned with the
unknown-executor control, fails without the table. A mistyped flag
names the documented one within two edits (`--concurency` → `did you
mean --concurrency?`), the candidates read from the help text's
sections marked for the verb so no second list drifts and no other
verb's flag is ever suggested (`--older-tha` under `run` gets no hint;
found by probing); `editDistance` lives in `util/`. And the plugins
guide's promise that its code is real is pinned:
`tests/docs-snippets.test.ts` type-checks every block against the
façade (13 of 14; the contract sketch is skipped by rule). The other
six guides' `ts` blocks are prose excerpts by design — object
fragments without a wrapper — and stay unchecked.

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

**Stale-claim sweep (2026-09-03, evening).** Six live docs described
a removed seam or a rejected approach as current: the fork map and the
execute-task and inputs module docs offered auto-input inference (a
rejected approach) as a plan; prepare.md offered `globalInputs` /
`globalEnv` and a telemetry handle; the module index, plugin.md,
plugin-host.md, orchestrator.md and the architecture walkthrough still
described the `eventSink` seam removed in pipeline v2. All corrected
to what exists; the grep for the class (`EventSink`, `inference`,
`globalInputs`, `predictive`, `dashboard`) is clean outside history.
The same evening: the dispatcher module doc was rebuilt from the verb
switch (it listed `mcp` as core, kept a service-package redirect row,
omitted `init`/`why`/`last`/`prune`, linked four module docs that do
not exist); four docs still named the removed service package's
coordinator (façade list, module index, scheduler, dispatcher); the
why-vx-is-fast page said vx has no config-eval cache and quoted June
numbers; the key-derivation list and the caching guide gained the
`key` stage's plugin material; the pipeline design doc's `commands`
shape was wrong; and three "upstream hash" phrasings now say input
key, never outputs.

**Red mains, each explained and pinned:** RED MAIN 638281d (2026-09-03,
mine): a pin's import never landed and the gate failed lint and a
shard, but the commit was chained after a gate piped through `grep`,
whose exit status is grep's — the rule CLAUDE.md states; fixed in the
next commit with the gate's own exit tested, and the memory carries it. an ms-mtime precondition
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

- **Release v0.0.17 (owner, 2026-09-03 21:19Z) is half-published — two
  owner actions needed.** The release targeted `main` at 638281d, my
  red commit of that minute (a test file's missing import; the binaries
  are built from the same `src/` as the fix 6a59b46 and passed the
  version assertion, so the attached assets are fine). `Release assets`
  succeeded. `npm publish` published `@vzn/vx-darwin-x64@0.0.17` and
  then failed on `@vzn/vx-darwin-arm64` with `E401 … token is invalid`
  while npm tried to open a web-auth flow — the log's own notice: "npm
  tokens that bypass 2FA are being restricted for … direct publishing".
  The classic `NPM_TOKEN` no longer publishes reliably. Core and the
  other three platform packages stay at 0.0.16, so installs are
  unaffected (no core version references 0.0.17). Both publish steps
  in `npm.yml` (the darwin job and the linux + core `publish` job) set
  `NODE_AUTH_TOKEN: secrets.NPM_TOKEN` and both grant `id-token:
  write`; the step comment says the token is used when the secret
  exists and npm falls back to OIDC trusted publishing only when it is
  empty. So every package was on the classic token, and the core job
  would have hit the same E401 had it run. (1) Either configure
  trusted publishing on npmjs.com for all five packages (workflow
  `npm.yml`, environment none) and delete the `NPM_TOKEN` secret so
  both jobs fall back to OIDC, or replace it with a granular access
  token with publish rights and 2FA bypass; then (2) dispatch the
  `npm publish` workflow with version `0.0.17` — both publish loops
  skip a package already on the registry, so the run resumes at
  darwin-arm64 and finishes with core. Not done here: a credential and
  an outward publish are the owner's.

## Next (ordered)

1. **A live REAPI run of the whole graph.** `vx run ci --all` against a
   NativeLink worker has not run since the barrel narrowing and the
   by-name error classification (both 2026-09-03); the plugin's unit
   half is green, the live files skip without an endpoint, and docker
   was down on this machine all day. Without docker, `brew install
   bazel-remote` (bottled, 2.6.2) gives the remote-CACHE half a server
   in one step (`bazel-remote --dir <tmp> --grpc_address :9092`, then
   `VX_REAPI_TEST_ENDPOINT=grpc://localhost:9092`); execution still
   needs NativeLink. Left for the owner: it is a download. `tests/helpers/nativelink.md` has
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
3. **Zero-migration adoption as a plugin (candidate, owner's call).**
   The Vite-shaped ecosystem lever: `plugins: [turbo()]` in a Turbo
   repo (or `nx()`) and `vx run build --all` works against `turbo.json`
   + `package.json` scripts with no generated files — a trial that
   commits nothing. The `project` stage is the right seam, and the
   mapping already exists in `migrate-turbo.ts` / `migrate-nx.ts`, but
   ONE seam gap blocks it: `prepareRun` loads only packages that have a
   config file (`prepare.ts`, the `configPath` filter), so the stage
   never visits a config-less package. Widening: when any plugin
   declares `project`, a package without a config is loaded as
   `{ tasks: {} }` for the stage to fill (zero cost otherwise — the
   filter stays when no plugin declares it). Then a `@vzn/vx-turbo`
   package reusing the mapper's IR without the preset splices, ~150
   lines, with the migrate suite's fixtures as its tests. Not built:
   `vx migrate` is one command and a second source of task truth is a
   maintenance surface; decide with the owner.
4. **The shipped binary's second core.** A compiled `vx` loading a
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
5. **The watch e2e flake** — if `re-runs the task after a file change,
then exits on SIGINT` times out again, keep that run's stdout: the
   presence of `re-running...` separates a lost event from a slow
   re-run (see the 2026-09-03 watch entry).
6. **Re-measure the warm run after each day's work** — the hot path is
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
   COLD floors (same bench, cache wiped, `VX_TIMING=1` — the miss path
   carries spans since 2026-09-03): 2.06 s wall for 1,000 `echo` tasks at
   concurrency 10, i.e. ~20 ms per task-slot: execute 13.8 ms, save 3.6,
   resolve outputs 1.4, clean 0.6, task hash 0.01; cold config load 340
   ms (1,000 evaluations, no eval cache yet). Of the 13.8, the shell IS
   the floor on macOS: bare `sh -c 'echo built'` costs 9.2 ms per slot
   at 10 concurrent against 2.5 for `/bin/echo` spawned directly
   (stable over three rounds; `runCommand` adds 0.2 over the bare
   spawn). LEAD, not taken: spawning a shell-free command (`tsc -b`,
   `vitest run`) directly would save ~7 ms per task-slot on macOS and
   ~0 on Linux (dash starts in ~1 ms), against the principle that the
   shell is the API — PATH order, builtins, `command not found` → 127,
   scripts without a shebang all have to read identically. The headline
   shape's tasks use `&&`, so its rows would not move. Decide with the
   owner. The save's 3.8 ms splits (spans `save: *`): pack 1.25, write
   temp 0.63, rename 0.55, scan 0.46, index tx 0.17. Two trims measured
   as not worth their code (< 1 ms per task together, ~0.15% of the
   cold row): a synchronous compress for tiny buffers, and indexing a
   locally built artifact from its plan instead of re-scanning it.
   `vx watch` start on the same bench: the initial run plus a sweep of
   all 1,000 configs (repeat loads through the worker) — the sweep is
   35 ms, no visible pause.

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
