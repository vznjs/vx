# Turbo vs Nx vs vx — operation-by-operation breakdown

> **Status:** reference / context doc (2026-05). Captures what each
> runner does at each step of a `run` invocation. Updated when our
> implementation moves; the Turbo / Nx columns are pinned to source
> revisions called out per row.
>
> Sources verified in this session:
>
> - Turbo: `/tmp/turbo/crates/turborepo-*` (rev `71f8c90`)
> - Nx: `/tmp/nx/packages/nx/src/*` (rev `962f146`)
> - vx: this repo at `main`
>
> Daemon paths in Nx are excluded; we are explicitly daemonless.

## Quick-scan summary

| Phase               | Turbo                                            | Nx                                               | vx                                                |
| ------------------- | ------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------- |
| Cold-start cache    | Daemon-backed; cold path re-discovers workspace  | DB-cache + on-disk project-graph snapshot        | Cold every run — no persistent state              |
| Workspace discovery | `package.json` walk + lockfile parse             | Plugin pipeline                                  | `pnpm-workspace.yaml` / pkg.json                  |
| Task graph          | Topo build, Rust                                 | Topo build, TS + Rust hashing                    | TS, `buildTaskGraph`                              |
| Input enum          | `git ls-files` per package, dedupe across tasks  | Native Rust (hash_array, batched)                | One `git ls-files` at workspace root, partitioned |
| Input hashing       | xxh64 in Rust                                    | xxh3 in Rust (native)                            | xxh3 in Bun (xxHash3 via `Bun.hash`)              |
| Cache key           | xxh64 → 16 hex                                   | xxh3 native                                      | xxh3 → 16 hex (seed-chain folded)                 |
| Cache lookup        | SQLite + tar.zst on disk                         | SQLite (`DbCache.getBatch`) — one query          | SQLite + tar.zst — per-task                       |
| Restore (warm)      | Per-file skip via sibling `<hash>-manifest.json` | **Always extract** (no per-file skip)            | Skip via `output_files` SQLite + stat-check       |
| Restore (cold)      | Tar.zst stream extract, parallel writes          | Rust `copyFilesFromCache`                        | In-process tar parse + `Bun.write`                |
| Save                | tar.zst + sibling `<hash>-manifest.json`         | Rust `storeArtifactInCache`                      | tar.zst + SQLite output_files rows                |
| Log replay          | Buffer per task, emit on complete                | Buffer per task, emit on complete                | Same — `defaultLogger` per-task buffer            |
| Integrity (local)   | xxh64 of compressed bytes? No (verified absent)  | Machine-ID gate + checksum-less artifact restore | **None** — gap (see audit doc)                    |
| Integrity (remote)  | HMAC-SHA256 over `hash‖team‖bytes`, gated by env | No HMAC                                          | **None** — gap                                    |
| Signal handling     | Cancel token + SIGTERM via tokio                 | IPC signal forwarding to children                | Watch only; main `run()` lacks handlers           |
| FS robustness       | Retries unclear / inherits OS                    | `tryAndRetry()` exponential backoff              | No retries beyond SQLite `busy_timeout`           |

The rest of this doc is per-phase deep-dives. Cells call out **what
they do**, **where in source**, and **whether we should adopt**.

---

## 1. Initialization / cold start

| Step                | Turbo                                                            | Nx                                                                                                                            | vx                                                                                                 |
| ------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Process bootstrap   | Single Rust binary; ~30ms cold                                   | Node + napi-rs load; ~150ms cold                                                                                              | Bun `--smol` TS execute; ~80ms cold                                                                |
| Workspace root find | Walk up until lockfile + `package.json` (`turborepo-repository`) | Walk up to `nx.json` / workspace root (`workspace-root.ts`)                                                                   | `findWorkspaceRoot` in `src/workspace/workspace.ts` — pnpm-workspace.yaml OR pkg.json `workspaces` |
| Config load         | `turbo.json` parsed once, validated against schema               | `nx.json` + every project's `project.json` via plugin pipeline                                                                | `vx.workspace.{ts,mts,js,mjs}` + every project's `vx.config.*` (Bun.import each, parallel)         |
| Daemon attach       | Tries to attach to running daemon; falls back to cold            | Tries to attach; falls back to cold                                                                                           | N/A — no daemon                                                                                    |
| Project graph       | Rust struct, plugin-derived                                      | `ProjectGraph` cached as JSON snapshot on disk (`workspaceDataDirectory`) — invalidated by mtime checks on project.json files | `buildPackageGraph` from `pnpm-workspace.yaml` — no cross-run cache                                |

**Gap for vx:** no cross-run project-graph cache. Each cold start re-imports every `vx.config.ts`. PR #84's `hashCache` is within-run only. Adopting a Nx-style disk snapshot would save ~10-50ms × N projects on cold starts; needs mtime invalidation logic.

---

## 2. Input enumeration

| Step                         | Turbo                                                                                         | Nx                                                       | vx                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| File discovery (in git repo) | `git ls-tree -r -z HEAD` once at repo root, sorted, range-queried per package                 | Native Rust: full filesystem walk, ignoring `.gitignore` | `git ls-files --cached --others --exclude-standard -z` once at workspace root, partitioned by project prefix (PR #90) |
| File discovery (not git)     | `walkdir` + gitignore filter                                                                  | Same Rust walk                                           | `Bun.Glob` walker + `ignore` lib (fallback)                                                                           |
| Per-task glob match          | `wax` crate against the deduplicated file set                                                 | Native Rust matcher                                      | Per-task `Bun.Glob.match` against the per-project memoized file list                                                  |
| Dedup across tasks           | Yes — file-hash cache keyed by `(package, input_globs, default_flag)` (`turborepo-task-hash`) | Yes — `hashArray` cached natively                        | Yes — per-run `hashCache` (PR #84) + per-file `file_hashes` table                                                     |

**vx state:** good. Bulk git enumeration shipped in PR #90. Per-file mtime+size memo in SQLite (PR #87). Both match Turbo's architecture.

---

## 3. Input hashing

| Step                  | Turbo                                         | Nx                                    | vx                                                                                     |
| --------------------- | --------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------- |
| Per-file hash         | `xxh64`, sometimes batched via Rayon          | Native Rust xxh3 (`hashFile()`)       | `xxh3` (`Bun.hash.xxHash3`) with mtime+size fast path                                  |
| Stale-mtime fast path | git-blob OID when in-tree (no re-read needed) | Per-file mtime+size cache (in-daemon) | SQLite `file_hashes(path, mtime, size, content_hash)` row per file                     |
| Big-file streaming    | Yes (Rust streams)                            | Yes (native)                          | **No** — `Bun.file().bytes()` loads whole file. `Bun.hash.xxHash3` lacks streaming API |

**vx gap:** no streaming hash for large files. Today inputs are source files (≤1MB typical) so this doesn't bite. If users ever hash GB-scale assets, would need a different hasher (`Bun.CryptoHasher` streaming + tag with version bump).

---

## 4. Cache key derivation

| Field                   | Turbo                                                     | Nx                              | vx                                                                    |
| ----------------------- | --------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------- |
| Schema version sentinel | Yes (turbo version)                                       | Yes                             | `CACHE_VERSION = 'vx-cache-v15'`                                      |
| Task identity           | `package_name#task_name`                                  | `project:target`                | `project#task`                                                        |
| Workspace fingerprint   | Resolved lockfile + workspace defs                        | Hashed `package.json` + lock    | `computeWorkspaceFingerprint` hashes lockfile + `pnpm-workspace.yaml` |
| Project pkg.json        | Implicit dep via lockfile-derived dep graph               | Hashed per project              | `projectPackageJsonHash` (PR #42)                                     |
| Task config             | turbo.json subset for this task                           | resolved `project.json` target  | `hashTaskConfig` over resolved TaskConfig                             |
| Forwarded CLI args      | Yes                                                       | Yes (`task.overrides`)          | `forwardArgs`, scoped to requested tasks (PR #17)                     |
| Env capture             | `env` + `passThroughEnv` whitelists, `globalEnv` fallback | Per-task env via `inputs.env`   | `cache.inputs.env` list — values folded                               |
| Upstream task hashes    | Yes, filtered by `dependsOn`                              | Yes, filtered by `inputs.tasks` | `filterUpstreamHashes` with Turbo/Nx micro-syntax (PR #56)            |
| Input file hashes       | Sorted (path, hash) pairs                                 | Same                            | Same — sorted `inputFiles` + per-file content hashes                  |
| Final hash              | `xxh64` → 16 hex                                          | xxh3 (native)                   | `xxh3` seed-chain → 16 hex (PR #87)                                   |

**Field-level parity:** essentially identical. The fold ORDER and exact bytes differ (so keys aren't cross-runner compatible) but the SET of inputs is the same.

---

## 5. Cache lookup

| Step              | Turbo                                    | Nx                                                       | vx                                                                                     |
| ----------------- | ---------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Lookup mechanism  | SQLite + on-disk tar.zst named by hash   | `DbCache.getBatch(hashes)` — one SQL query for all tasks | Per-task `Cache.get(hash)` — SQL SELECT + tar I/O                                      |
| Batched?          | Per-run                                  | **Yes** — explicit batch API in Nx                       | `Cache.getMetaBatch(hashes)` exists (PR #92) but orchestrator still uses per-task path |
| Tar I/O on lookup | Yes — opens artifact for header read     | No — metadata-only from DB                               | Yes — `get()` decompresses for stdout/stderr                                           |
| Remote fallback   | Async, parallel with local read attempts | Parallel `Promise.all` over remote misses                | Sequential local→remote in `LayeredCache.get`                                          |

**vx gap:** `getMetaBatch` exists but isn't wired into the orchestrator's hot path. Doing so requires the upfront-hashing refactor that broke correctness when inputs include sibling outputs (see audit doc, item #3). The per-cache-hit `loadOutputFilesBatch([hash])` we shipped in PR #95 is the realistic compromise.

---

## 6. Cache restore (warm — outputs already match)

| Step                          | Turbo                                                                   | Nx                                 | vx                                                                          |
| ----------------------------- | ----------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------- |
| Detect "tree already current" | Per-file (size, mtime_nanos, mode) via sibling `<hash>-manifest.json`   | **No detection** — always extracts | Per-file (size, mode, mtime) check via `output_files` table + stat (PR #95) |
| Stray detection               | No (tar-extract overwrites)                                             | No                                 | Yes — set-equality check between `resolveOutputs` glob walk and DB rows     |
| Skip path cost                | Read+parse `<hash>-manifest.json` (small JSON, no decompress) + N stats | N/A                                | One SQL `SELECT … WHERE entry_hash IN (?)` + N stats + 1 glob walk          |
| Tar I/O on skip               | **Zero** (manifest is its own file, sibling to tar)                     | N/A                                | **Zero** (manifest in DB)                                                   |

**Turbo source** (corrected from initial first-pass agent report):
`crates/turborepo-cache/src/cache_archive/restore_manifest.rs` defines
`RestoreManifest` with a `HashMap<String, FileEntry>` of `(size,
mtime_nanos, mode, is_dir)`. Persisted at
`<cache_dir>/<hash>-manifest.json` via `write_atomic()` (line 161) and
loaded via `read()` (line 156). Sibling to `<hash>.tar.zst`, not inside
it.

**vx vs Turbo at this step:** essentially equivalent on the warm path —
both avoid tar I/O entirely, both stat per file. We use SQLite, Turbo
uses a per-hash JSON file. The benchmark from earlier in this session
(SQLite vs JSON-in-tar) doesn't apply to Turbo's actual approach; we
should re-bench against JSON-on-disk to know if there's a real
difference.

**vx vs Nx:** we're ahead — Nx has no per-file skip at all on the
restore path; every cache hit re-copies.

---

## 7. Cache restore (cold — files differ or missing)

| Step                 | Turbo                                             | Nx                                 | vx                                                           |
| -------------------- | ------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| Decompress           | Rust zstd stream, parallel via rayon              | Rust copy via `copyFilesFromCache` | `Bun.zstdDecompress` whole-archive (in-memory)               |
| Tar extract          | Rust `tar` crate streaming, writes via std::fs    | Native Rust                        | In-process JS parser + `Bun.write` Promise.all (PR #94)      |
| Path safety          | Lexically canonicalize each entry, reject escapes | Trusts native code                 | **No check** — `path.join(destDir, rel)` (audit doc item #2) |
| Mode preservation    | Yes                                               | Yes                                | Yes — chmod after write                                      |
| mtime preservation   | Yes (nanosecond)                                  | Yes                                | Yes (second precision via tar header)                        |
| stdout/stderr replay | Cached log files extracted alongside              | Stored as separate text files      | Bundled in tar.zst as `stdout`/`stderr` entries              |

**vx gap:** path-traversal check missing. Theoretical today (we control the tar contents) but defense-in-depth (audit doc item #2).

---

## 8. Task execution (cache miss)

| Step                       | Turbo                                                 | Nx                                                          | vx                                                                              |
| -------------------------- | ----------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Spawn                      | `std::process::Command`                               | `fork()` (Node IPC) or `spawn()` for shell tasks            | `Bun.spawn` with `stdout: 'pipe', stderr: 'pipe'`                               |
| PATH augmentation          | Workspace `.bin` + each project's `node_modules/.bin` | Same                                                        | Project's own `node_modules/.bin` prepended (PR #46)                            |
| stdout/stderr capture      | Streamed to buffer + cache file                       | Streamed to buffer + cache file                             | Streamed to logger buffer (per-task)                                            |
| Signal forwarding to child | Tokio cancellation token → SIGTERM                    | IPC signal forwarding (`forked-process-task-runner.ts:411`) | **Persistent tasks only** — one-shot children don't get SIGTERM on parent abort |
| Exit code propagation      | Yes, fail-fast option                                 | Yes, `--continue=<mode>`                                    | Yes — see `comparison.md` for `--continue` gap                                  |
| Resource accounting        | cpuTime, maxRSS via `wait4`                           | cpuTime via subprocess events                               | `Bun.spawn` + `resourceUsage()` — cpu_ms, peak_rss_bytes recorded (PR #20)      |

**vx gap:** SIGINT/SIGTERM handler in `run()` doesn't propagate to in-flight one-shot tasks (audit doc item #1).

---

## 9. Cache save

| Step                   | Turbo                                         | Nx                     | vx                                                                                                |
| ---------------------- | --------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------- |
| Output discovery       | Glob walk per task's declared outputs         | Glob walk via Rust     | `resolveOutputs(globs)` — Bun.Glob walker with project-boundary excludes                          |
| Stage to temp          | Yes (in-memory or temp dir depending on size) | Yes                    | `mkdtemp` then `Bun.write` each output                                                            |
| Tar build              | Rust `tar` crate streaming                    | Native Rust            | Subprocess `tar -cf - -C stage outputs stdout stderr` (could be Bun.Archive — benchmarked slower) |
| Compress               | zstd via Rust crate                           | zstd via Rust          | `Bun.zstdCompress` on the tar bytes                                                               |
| Atomic publish         | tmp + rename                                  | tmp + rename           | tmp `.tmp-<pid>-<ts>` + `rename` (PR #86)                                                         |
| Metadata write         | SQLite insert in same transaction             | SQLite insert via Rust | SQLite `entries` + `output_files` rows in one `db.transaction` (PR #95)                           |
| Remote upload          | Background, fire-and-forget                   | Background             | `LayeredCache.save` fires remote PUT async; errors logged not propagated (PR #13)                 |
| Sign artifact (remote) | HMAC-SHA256 over hash+team+bytes (env-gated)  | No                     | **None** (audit doc item #4)                                                                      |

**vx gap:** no HMAC on remote artifacts. Defer until shared-cache users appear.

---

## 10. Log replay (cache hit)

| Step                | Turbo                              | Nx                          | vx                                                                                        |
| ------------------- | ---------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------- | ----- | ---------------------------- | ----------------------------------------------------- |
| Capture during exec | Streamed, per-line buffered        | Streamed, per-line buffered | Streamed chunks appended to per-task buffer in `defaultLogger`                            |
| Replay on hit       | Whole-block write to terminal      | Whole-block write           | One `process.stdout.write` per task in `taskComplete()` (already optimal — same as Turbo) |
| Output mode flag    | `--output-logs=full                | errors-only                 | hash-only                                                                                 | none` | Similar via `--output-style` | **Missing** — `comparison.md` calls this out as a gap |
| Color preservation  | Yes — raw ANSI buffered + replayed | Yes (with TUI strip option) | Yes — colors via `colors.ts`, no strip                                                    |
| Per-task framing    | Block headers + indent             | Block headers + indent      | `formatTaskBlock` framed output                                                           |

**vx gap:** `--output-logs` flag missing — already in `comparison.md` backlog.

---

## 11. Watch mode (file change detected)

| Step                  | Turbo                        | Nx                              | vx                                                                                                        |
| --------------------- | ---------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| FS watch              | `notify` crate via daemon    | `chokidar` + native watcher     | `fs.watch(projectDir, { recursive: true })` per project + workspace root, debounced 150ms (PR `vx watch`) |
| Change classification | Full re-graph or incremental | Incremental task invalidation   | Re-runs the orchestrator from scratch on each batch                                                       |
| Affected-task subset  | Computed in daemon           | Computed via project graph diff | **No subset** — re-runs all requested tasks; relies on cache hits to skip unchanged                       |

**vx state:** simpler model (cache catches the no-op case). Adopting affected-task pruning would speed up "many tasks, one file changed" cases by skipping the cache-hit overhead entirely. Probably not worth the complexity.

---

## 12. Failure handling

| Step                    | Turbo                           | Nx                                     | vx                                                                             |
| ----------------------- | ------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------ |
| Dep of failed task      | Skipped (cascade)               | Configurable via `--continue` mode     | Skipped; siblings still run (PR #46 dropped fail-fast)                         |
| Sibling tasks           | Continue by default             | Continue or stop based on `--continue` | Always continue (no `--continue` flag)                                         |
| Failed task logs        | Replayed at end-of-run footer   | Replayed                               | Streamed live, NOT replayed at end (PR #46 dropped end-of-run replay)          |
| Stderr capture on throw | Yes                             | Yes                                    | Yes — scheduler catches throws, parks message on `TaskOutcome.stderr` (PR #17) |
| Persistent task cleanup | SIGTERM on rest-of-graph-finish | Same                                   | SIGTERM via `persistentRegistry` (PR persistent tasks)                         |
| Mid-run Ctrl+C          | Cancel token propagates         | IPC signal                             | **Children orphaned** (audit doc item #1)                                      |

**vx gap:** mid-run Ctrl+C handling (audit doc item #1).

---

## 13. SQLite usage

| Concern                   | Turbo                                        | Nx                                                      | vx                                                           |
| ------------------------- | -------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------ |
| Schema                    | Per-entry rows + run-history                 | `cache_entries` + run-history + flake tracking          | `entries` + `runs` + `file_hashes` + `output_files` (PR #95) |
| Concurrency               | WAL + busy_timeout via napi-rs               | Same                                                    | WAL + `busy_timeout = 5000` (PR #17)                         |
| Transient retry           | OS-level via Rust crate                      | `tryAndRetry()` exponential backoff (audit doc item #6) | **None** — single failure kills the run                      |
| Schema migration          | "Pre-alpha or stable" with proper migrations | Same                                                    | Pre-alpha — `DROP + CREATE` on `SCHEMA_VERSION` change       |
| `file_hashes` cache reuse | git-blob-OID-based when in git               | Daemon-resident memo                                    | Disk SQLite, survives across runs (PR #84)                   |

**vx gap:** no transient retry (audit doc item #6).

---

## 14. Integrity (already enumerated in audit doc)

| Mechanism                        | Turbo                    | Nx                                            | vx                               |
| -------------------------------- | ------------------------ | --------------------------------------------- | -------------------------------- |
| Local artifact corruption detect | No                       | No                                            | **No** (audit doc item #3)       |
| Remote artifact tamper detect    | HMAC-SHA256 env-gated    | No                                            | **No** (audit doc item #4)       |
| Path-traversal in tar extract    | Lexical canonicalization | Native trust                                  | **No check** (audit doc item #2) |
| Machine-ID gate (cross-machine)  | No                       | Yes (`machine_id` hash + env-gated rejection) | **No** (audit doc item #5)       |
| Symlink restore order            | Topological              | Native                                        | We don't restore symlinks        |

---

## What this table is for

- **Onboarding context** — a new contributor can see exactly where we mirror Turbo / Nx and where we deliberately differ.
- **Audit anchoring** — when claims like "we should do what Turbo does for X" come up, this table is the answer-of-record; if the claim doesn't match, we update the table OR the implementation.
- **Backlog grounding** — every "gap" cell here links to either `comparison.md` (feature gap) or `integrity-audit-2026-05.md` (correctness gap).

When `main` moves, the vx column moves with it. Turbo/Nx columns
are pinned to the source revisions noted at the top.
