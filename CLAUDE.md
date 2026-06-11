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

Single-package project. Flat src/ at root.

```
src/
  bin.ts                # shebang; wires process.argv -> cli.run
  cli.ts                # argv parser, dispatcher, interactive picker
  orchestrator.ts       # run() entry: discover → load → graph → schedule
  config.ts             # public schema (ProjectConfig, TaskConfig, …)
  index.ts              # public re-exports
  orchestrator/         # orchestrator helpers
    execute-task.ts     # per-task execution (cache lookup → spawn → save)
    upstream.ts         # filter upstream hashes for cache key
    task-logs.ts        # persist stdout/stderr to <cacheDir>/logs/<run_id>/
    remote-cache-setup.ts # VX_REMOTE_CACHE_* env → LayeredCache
    logger.ts           # default logger + formatOutcome + prefix
  cli/                  # subcommand parsers + presentation
    plan-format.ts      # --dry / --graph plan → text / JSON / DOT
  workspace/            # discovery + selection
    workspace.ts        # discovery: pnpm-workspace.yaml / pkg.json workspaces / bare pkg.json (+ ProjectEntry)
    project-loader.ts   # Bun-native vx.config.* loader (content-hash bust)
    package-graph.ts    # workspace dep graph
    filter.ts           # pnpm-style filter DSL (-F)
    nested-dirs.ts      # project-boundary computation
    fingerprint.ts      # workspace lockfile / yaml hash
  graph/                # task graph + scheduling
    task-graph.ts       # builds TaskNode DAG from declared dependsOn
    scheduler.ts        # parallel topo executor
  cache/                # local + remote cache cluster
    cache.ts            # content-addressed cache (key + save/restore/ingest)
    layered-cache.ts    # local + remote composition (byte-passthrough)
    remote-cache.ts     # HTTP client (Turbo wire-compatible PUT/GET)
    inputs.ts           # glob resolution + project-boundary enforcement
  exec/                 # per-task execution primitives
    runner.ts           # Bun.spawn wrapper + shellQuote
    env.ts              # env composition
  util/                 # tiny shared helpers
    paths.ts            # tiny POSIX-path helper
    ulid.ts             # tiny ULID generator (run-id stamping; no deps)
    errors.ts           # UserError class — clean error output without a stack
docs/
  README.md         # index
  architecture.md   # module map, data flow, design principles
  schema.md         # every config field
  caching.md        # cache key derivation, invalidation table
  execution.md      # what happens during a `vx run`
  cli.md            # CLI reference (flags, filter DSL, forwarding)
  modules/<name>.md # per-module reference
  design/           # forward-looking proposals
.claude/agents/     # subagent definitions
tsconfig.json
package.json
bun.lock
.oxlintrc.json      # lint config
.oxfmtrc.json       # format config
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
- **Format must be clean.** Run via vx: `bun src/bin.ts run format`.
- **Lint+typecheck must be clean.** Run via vx: `bun src/bin.ts run lint`.
  No `package.json` scripts — dogfooded through vx's own task graph.
- **CI gates:** install → format:check → lint → test, all under Bun.
  CI workflow is `.github/workflows/ci.yml`.

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

## Decision log

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

## Active workstreams (prioritized)

Roadmap is derived from [`docs/comparison.md`](docs/comparison.md) —
the gap analysis against Turbo / Nx / vite-task with sourced cites.

1. **Named inputs + target defaults.** Workspace-level reusable input
   sets + per-task inheritance. Reduces glob duplication across tasks.
   See Nx `namedInputs` / `targetDefaults`.
2. **Pre-signed URL auth + HMAC signing** (`x-artifact-tag`) for the
   remote cache. v2 per `docs/design/remote-cache.md`.
3. **Output log modes** (`--output-logs=full|errors-only|hash-only|none`).
4. **`--continue=<mode>`.** Today vx aborts a failed task's
   transitive dependents but continues independent siblings — Turbo's
   middle setting. Add the explicit flag plus a `--continue=always`
   for more lenient runs.
5. **Wildcards in `dependsOn`** (`build-*`, `^build-*` — Nx 19.5+).
6. **Workspace-level `globalInputs` / `globalEnv` / `globalPassThrough`.**
7. **Auto-input inference** (vite-task's `{auto:true}` via filesystem
   tracing). Biggest UX win, biggest engineering lift; needs an
   `fspy`-equivalent per OS.

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
