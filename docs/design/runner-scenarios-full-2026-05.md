# Turbo vs Nx vs vx — full scenario matrix + test-coverage gaps

> **Status:** reference doc (2026-05). Replaces / extends
> `runner-comparison-2026-05.md` with a complete per-scenario
> breakdown sourced from a deep-research session against both
> upstream codebases. Six parallel agents read every relevant file
> in both projects; this doc collapses the findings into one matrix.
>
> Sources verified in this session:
>
> - Turbo: `/tmp/turbo` (full clone, 61 crates, current main)
> - Nx: `/tmp/nx/packages/nx/src/` (current main)
> - vx: this repo at `main`
>
> Scope of the audit:
>
> - **Turbo subsystems covered:** `turborepo-cache` (all 11 files),
>   `turborepo-scm`, `turborepo-env`, `turborepo-repository`,
>   `turborepo-lockfiles`, `turborepo-paths`, `turborepo-task-hash`,
>   `turborepo-hash`, `turborepo-lib/src/run/`, `turborepo-engine`,
>   `turborepo-process`, `turborepo-task-executor`,
>   `turborepo-run-cache`, `turborepo-run-summary`,
>   `turborepo-task-id`.
> - **Nx subsystems covered:** `tasks-runner/*` (no-daemon paths),
>   `hasher/*`, `project-graph/*`, `config/*`, `utils/*`. Daemon
>   code (under `src/daemon/`) deliberately excluded.
>
> Scenarios where Turbo or Nx do something we don't are flagged
> **GAP**. Each GAP has a recommended action: ship test, ship
> implementation, or document-and-defer.

## Reading guide

Every scenario row has six cells:

| Phase | Scenario | Turbo | Nx | vx | Test coverage |

- **Turbo / Nx**: one-line "what they do" with a file:line citation
  to the upstream source. Empty = doesn't exist / not applicable.
- **vx**: what we do (with our file:line) or "—" if the scenario
  isn't relevant, or **GAP** if it's relevant and missing.
- **Test coverage**: ✅ = covered by an existing test (test file
  named), ⚠️ = partially covered / weak, ❌ = no test.

Citations are exact file:line ranges so you can `grep`-verify
without re-reading this doc.

---

## Phase 1 — Initialization

### 1.1 Workspace root detection

|       | What                                                                                                                | vx                                                                                                                                      | Test                             |
| ----- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Turbo | Walk up from CWD for `package.json` + lockfile (`turborepo-repository`)                                             | `findWorkspaceRoot()` in `src/workspace/workspace.ts:32-58` — looks for `pnpm-workspace.yaml` OR `package.json` with `workspaces` field | ✅ `workspace.test.ts` (6 tests) |
| Nx    | Walk up for `nx.json` OR `nx` binary OR `nx.bat`; `NX_WORKSPACE_ROOT_PATH` env override (`workspace-root.ts:14-40`) | No env override                                                                                                                         | ⚠️ env-override case untested    |

**GAP:** No env-override (e.g., `VX_WORKSPACE_ROOT`) — minor; defer until a user needs it.

### 1.2 Workspace config parsing

|       | What                                                                                      | vx                                              | Test                   |
| ----- | ----------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------- |
| Turbo | `turbo.json` parsed once, validated against schema                                        | `vx.workspace.{ts,mts,js,mjs}` via `Bun.import` | ✅ `workspace.test.ts` |
| Nx    | `nx.json` with `extends` chain merging (`nx-json.ts:921-944`) + fallback to "core preset" | No `extends` support                            | ❌ no `extends` test   |

**GAP:** `vx.workspace.ts` doesn't support `extends`. Low priority — only worth adding when configs grow.

### 1.3 Per-project config load

|       | What                                                                                                              | vx                                                                     | Test                                   |
| ----- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------- |
| Turbo | Per-package `turbo.json` parsed during `EngineBuilder::build()` — serial                                          | per-project `vx.config.*` via `Bun.import` in `Promise.all` (parallel) | ✅ `project-loader.test.ts` (19 tests) |
| Nx    | Plugin pipeline — `createNodes` per plugin, parallel via `Promise.all` (`project-configuration-utils.ts:146-193`) | Single-pipeline (no plugin model)                                      | ✅ basic coverage                      |

### 1.4 Project graph build (cross-run cache)

|       | What                                                                                                                                                                                                                                                                                                                                                                                                                                               | vx                                                      | Test |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---- |
| Turbo | Daemon caches in memory; cold rebuild on cold CLI start                                                                                                                                                                                                                                                                                                                                                                                            | Cold every run                                          | —    |
| Nx    | **Persists graph to disk** as 3 JSON files (`nx-deps-cache.ts:210-287`): project-graph, file-map, source-maps. Atomic temp+rename with retry-up-to-5. Invalidated via **7-point check** (`nx-deps-cache.ts:317-376`): version, nxVersion, project list, path mappings, plugin list+versions, plugin config, external node hash. `FileLock` mutex serializes concurrent writers. `writeCacheIfStale()` uses mtime tracking to skip redundant writes | **GAP** — re-import every `vx.config.ts` every cold run | ❌   |

**GAP:** No cross-run project-graph snapshot. Cost: 10-50ms × N projects per cold start. Real win for monorepos with many projects but defer until cold-start shows up as a complaint.

### 1.5 Signal handler installation

|       | What                                                                                                                                               | vx                                                                   | Test |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---- |
| Turbo | `Run::setup_process_manager_shutdown_handler()` (`run/mod.rs:852-889`) registers async listener at startup, returns before tasks dispatch          | `cli/watch.ts:204-208` has SIGINT/SIGTERM; main `run()` does **not** | ❌   |
| Nx    | `setupSignalHandlers()` at orchestrator init (`task-orchestrator.ts:1843-1883`) — debounced via `stopRequested` flag, forwards via IPC to children | **GAP** — `orchestrator.ts:run()` has no signal handler              | ❌   |

**GAP — high priority.** Audit doc item #1. Ctrl+C mid-run orphans children + skips `cache.close()`. Ship: handler + test that asserts orphan children are reaped + cache file isn't WAL-corrupted after SIGINT.

---

## Phase 2 — Input enumeration & hashing

### 2.1 File enumeration in a git repo

|       | What                                                                                                                                                                                                                                                                                                                                          | vx                                                                                                                                                                 | Test                                                                |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Turbo | One `git ls-tree -r -z HEAD` at repo root (`turborepo-scm/src/git.rs:282-322`), sorted output range-queried per-package via `partition_point` (`repo_index.rs:393-464`). Also races `git ls-files --others` against a parallel `walk_candidate_files` rayon walk for untracked files (`repo_index.rs:203-298`) — whichever returns first wins | Bulk `git ls-files --cached --others --exclude-standard -z` at workspace root, partitioned by project prefix (PR #90, `src/cache/inputs.ts:populateGitFilesCache`) | ✅ `inputs.test.ts` (32 tests, including git-path + populate-batch) |

### 2.2 File enumeration without git

|       | What                                   | vx               | Test                                 |
| ----- | -------------------------------------- | ---------------- | ------------------------------------ | --------------------------------- |
| Turbo | `walkdir` + `.gitignore` filter (Rust) | Native Rust walk | `Bun.Glob` walker + `ignore` library | ✅ `inputs.test.ts` fallback path |

### 2.3 Per-file content hash

|       | What                                                                                            | vx                                | Test                                                                                  |
| ----- | ----------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------- | ----------------------- |
| Turbo | xxh64 in Rust, batched via rayon. Reuses git-blob OID when entry is clean in index (no re-read) | Native Rust xxh3 via `hashFile()` | `Bun.hash.xxHash3` with `(path, mtime, size, content_hash)` SQLite fast-path (PR #87) | ✅ `cache-perf.test.ts` |

### 2.4 Racy-git detection

|       | What                                                                                                                                 | vx                           | Test                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --- |
| Turbo | Files whose mtime is `>=` index timestamp deferred to per-package hash (`repo_index.rs:129-131`) — avoids false-positive "unchanged" | Same pattern via `gix-index` | **GAP** — we trust mtime+size as fingerprint; theoretically vulnerable to "modified within the same second as the cached read" | ❌  |

**GAP — medium severity.** Concrete attack: edit file, save, run task within same second → we treat as unchanged, cache stale hash. Add test that does `writeFile + Bun.sleep(50) + writeFile (same size) + hashFile`, expect new content_hash. Document the precision tradeoff.

### 2.5 CRLF normalization

|       | What                                                                                                                                                | vx   | Test                                                                                                                          |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------- | --- |
| Turbo | `GitAttrs::load()` parses `.gitattributes`, applies CRLF filters before hashing (`turborepo-scm/src/crlf.rs`) — cross-platform deterministic hashes | Same | **GAP** — we hash raw bytes; same file checked out with `core.autocrlf=true` on Windows produces different hash than on Linux | ❌  |

**GAP — medium for cross-platform monorepos.** Defer for now (we ship Bun-only and Bun runs same on all platforms — but if a user shares cache across Windows/Linux dev boxes, they'll see misses).

### 2.6 Cache key derivation

|       | What                                                                                                     | vx                                           | Test                                              |
| ----- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------- | --------------------------------------------------- |
| Turbo | xxh64 over Cap'n Proto-serialized `TaskHashable` struct (`turborepo-hash`) — deterministic byte-for-byte | xxh3 native — deterministic via Rust's serde | xxh3 seed-chain (PR #87) — `cache.ts:Cache.key()` | ✅ `cache.test.ts` (42 tests, includes determinism) |

### 2.7 Cache-key invalidation triggers

The set of things that should bust the cache key. Verified our set against theirs:

| Trigger                                         | Turbo                                                                                | Nx                                                             | vx                                                                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Schema version (`CACHE_VERSION`)                | ✅                                                                                   | ✅                                                             | ✅                                                                                                                                                                           |
| Task id                                         | ✅                                                                                   | ✅                                                             | ✅                                                                                                                                                                           |
| Workspace fingerprint                           | lockfile + workspace defs                                                            | lockfile + nx.json + .gitignore + .nxignore                    | lockfile + pnpm-workspace.yaml (`fingerprint.ts`)                                                                                                                            |
| Project package.json                            | implicit via lockfile-derived dep graph                                              | hashed per project                                             | ✅ explicit (PR #42)                                                                                                                                                         |
| Task config                                     | turbo.json subset                                                                    | resolved `project.json` target                                 | `hashTaskConfig` over resolved `TaskConfig`                                                                                                                                  |
| Forwarded CLI args                              | ✅                                                                                   | `task.overrides`                                               | ✅ (PR #17, scoped to requested tasks)                                                                                                                                       |
| Env values                                      | `env` + `passThroughEnv` whitelists, `globalEnv` fallback                            | per-task env via `inputs.env`; `.env.{target}` loaded per task | ✅ `cache.inputs.env` list                                                                                                                                                   |
| Upstream hashes                                 | ✅ filtered by `dependsOn`                                                           | ✅ filtered by `inputs.tasks`                                  | ✅ `filterUpstreamHashes` (PR #56)                                                                                                                                           |
| Input file hashes                               | sorted (path, hash) pairs                                                            | same                                                           | ✅ same                                                                                                                                                                      |
| tsconfig contents                               | selective: removes `compilerOptions.paths` to avoid noise (`task_hasher.rs:460-511`) | same                                                           | **GAP** — we don't read tsconfig at all. Tasks that use ts-aliases don't get path-table hash                                                                                 | ❌  |
| `.gitignore` / `.nxignore`                      | folded into `WorkspaceFileSet`                                                       | folded by Nx                                                   | **GAP** — not folded                                                                                                                                                         | ❌  |
| `NX_CLOUD_ENCRYPTION_KEY` (Nx-specific)         | n/a                                                                                  | always folded                                                  | n/a                                                                                                                                                                          |
| External deps hash (lockfile lines per package) | precomputed parallel via rayon                                                       | per-project transitive deps hash                               | **GAP** — we only fold whole-lockfile fingerprint, not per-project transitive deps slice. Cache hits cascade more than they should when an unrelated package's version bumps | ⚠️  |

**Two GAPs worth a small change:**

1. **`.gitignore` content fold** — 1-line addition to `computeWorkspaceFingerprint`. Catches "user edited .gitignore so different files now match `**/*`".
2. **Per-project transitive-deps hash** — bigger change. Defer.

---

## Phase 3 — Cache lookup

### 3.1 Single-task lookup

|       | What                                                                                                                                                        | vx                                                                  | Test                                         |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------- |
| Turbo | `FSCache::fetch()` (`fs.rs:88`): check archive exists → if manifest exists, fast-path validates each file by `(size, mtime_nanos, mode)`; else full extract | `Cache.get(hash)` — SQL SELECT + tar decompress (for stdout/stderr) | ✅ `cache.test.ts`, `cache-baseline.test.ts` |
| Nx    | `DbCache.get(hash)` — SQL select then `copyFilesFromCache` (Rust). Includes machine-ID gate (see 3.4)                                                       | (same as Turbo column)                                              |                                              |

### 3.2 Batched lookup

|       | What                                                                                                                            | vx                                                                                 | Test             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------- |
| Turbo | None (per-task)                                                                                                                 | Per-task                                                                           | ✅               |
| Nx    | `DbCache.getBatch(hashes)` — one SQL with `IN (?)` + parallel terminal output reads via Rayon (`tasks-runner/cache.ts:141-197`) | `Cache.getMetaBatch(hashes)` (PR #92) — exists, used by future orchestrator wiring | ✅ baseline test |

### 3.3 Warm restore (tree already current)

|       | What                                                                                                                                                                                       | vx                                                                                                                                                                                                                 | Test                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| Turbo | Sibling `<hash>-manifest.json` (`restore_manifest.rs:156-172`); per-file `(size, mtime_nanos, mode)` check; `validate_all()` early-exits on first mismatch (`restore_manifest.rs:129-154`) | SQLite `output_files` table (PR #95) + `Cache.isOutputsCurrent()` parallel stat-check; orchestrator also does **set-equality check** between `resolveOutputs` glob + DB rows (catches strays, which Turbo doesn't) | ✅ `cache-baseline.test.ts` |
| Nx    | **No per-file skip** — always `copyFilesFromCache` even on warm hit                                                                                                                        |                                                                                                                                                                                                                    |                             |

### 3.4 Machine-ID gate

|       | What                                                                                                                                                                                                                                                                                                                                  | vx                                                             | Test |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---- |
| Turbo | None — same machine assumed                                                                                                                                                                                                                                                                                                           |                                                                |      |
| Nx    | `getCurrentMachineId()` per-OS shell command (`machine-id-cache.ts:88-100`): macOS `ioreg`, Windows registry, Linux `/var/lib/dbus/machine-id`, FreeBSD `kenv`. Hashed with SHA-256, cached in-process. On restore, compare to entry's stored `source` file; throw unless `NX_REJECT_UNKNOWN_LOCAL_CACHE != '0'` (`cache.ts:623-646`) | **GAP** — no protection against restoring Linux outputs on Mac | ❌   |

**GAP — audit doc item #5.** Defer until shared-cache scenarios surface, but the implementation pattern is fully documented.

### 3.5 Stale entries (DB without artifact / artifact without DB)

|       | What                                                                                                                                                                                                                            | vx                                                                                                                              | Test                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Turbo | `fs.rs:98-101` — archive missing → cache miss return. Manifest missing → full extract (`fs.rs:107-129`). `metadata.json` missing → default duration=0 (`fs.rs:192-195`). All sidecars cleaned by TTL eviction (`fs.rs:317-333`) | We check `Bun.file(tarPath).exists()` in `get()` (cache.ts:466); if missing we return null. Stale DB rows survive — no cleanup. | ✅ `cache.test.ts` has test "DB row exists but on-disk artifact was deleted" |
| Nx    | Same: archive missing → miss; entry without artifact → miss                                                                                                                                                                     |                                                                                                                                 |                                                                              |

---

## Phase 4 — Cache restore (cold path, real extract)

### 4.1 Tar decompress + extract

|       | What                                                                                                                                     | vx                                                                                                         | Test                                                        |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Turbo | zstd stream + tar streaming via Rust crates; rayon-parallel writes; type dispatch (`restore.rs:97-129`) for regular file / dir / symlink | `Bun.zstdDecompress` whole-archive into memory + in-process JS parser (`tar.ts`) + `Bun.write` Promise.all | ✅ `cache-perf.test.ts`, `tar` tested via cache integration |
| Nx    | Native Rust `copyFilesFromCache`                                                                                                         |                                                                                                            |                                                             |

### 4.2 Symlink restore + cycle detection + escape-prevention

|       | What                                                                                                                                                                                                                                                                      | vx     | Test                                                                                                                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Turbo | Topologically sorted via petgraph (`restore.rs:131-176`); `CycleDetected` error on cycle. Lexical target validation rejects Windows absolute paths, paths escaping anchor (`restore_symlink.rs:53-189`). On Windows tries both `symlink_to_file()` and `symlink_to_dir()` | Native | **GAP** — we don't restore symlinks at all. If a build produces a symlink in `dist/`, our tar packs it (subprocess tar) but our extract treats it as a regular file → wrong content / broken link | ❌  |

**GAP — low severity, but real correctness hole.** Tar entries with typeflag `2` (symlink) — we don't check for them in `parseTarHeaders`. Add test: save a project with a symlink output, restore, verify it's still a symlink.

### 4.3 Directory restore + safe mkdir

|       | What                                                                                                                                                                                                       | vx                                                                       | Test     |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------- |
| Turbo | `CachedDirTree::safe_mkdir_all()` walks path components, checks each segment for symlink (`restore_directory.rs:87-157`). Removes pre-existing symlinks before descending (`restore_directory.rs:119-130`) | `mkdir(parent, { recursive: true })` per file (no symlink-segment check) | ✅ basic |
| Nx    | Native                                                                                                                                                                                                     |                                                                          |          |

**GAP — low.** If a path component is a symlink, we follow it. Defense-in-depth check: reject extraction when any parent of the target is a symlink not in our own writes.

### 4.4 Path traversal prevention

|       | What                                                                                                                                               | vx           | Test                                                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------- | --- |
| Turbo | Via `AnchoredSystemPath` type discipline + `categorize()` in `turborepo-paths` — every path in the tar pipeline is type-tagged "inside the anchor" | Native trust | **GAP** — audit doc item #2. `tar.ts:174` does `path.join(destDir, rel)` without checking the result stays in destDir | ❌  |

**GAP — medium severity, ~5 LOC fix.** Already documented in `integrity-audit-2026-05.md` item #2. **Ship.**

### 4.5 Partial restore with manifest

|       | What                                                                                                                                                                                                                                                               | vx                                                                                                               | Test                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Turbo | Tar 3 files (A,B,C); A changed on disk → fast-path fails → slow-path extracts A only, B+C skipped via `restore_regular.rs:19-26`. New manifest merges old (B,C) + new (A) entries preserving insertion order (`restore.rs:106-118`, `restore_manifest.rs:143-154`) | **All-or-nothing.** Either every file matches (skip all) or none do (extract all). Per-file skip not implemented | ⚠️ would benefit from per-file granularity in mixed-state scenarios |
| Nx    | None                                                                                                                                                                                                                                                               |                                                                                                                  |                                                                     |

### 4.6 Content checksum verification

|       | What                                                                      | vx                               | Test                              |
| ----- | ------------------------------------------------------------------------- | -------------------------------- | --------------------------------- | --- |
| Turbo | None on local; HMAC-SHA256 on remote (`signature_authentication.rs:1-80`) | None on local; no HMAC on remote | **GAP** — audit doc items #3 + #4 | ❌  |

---

## Phase 5 — Task execution (cache miss)

### 5.1 Process spawn

|       | What                                                                                                                                                                                                                                                         | vx                                                                                                                  | Test                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Turbo | `ProcessManager::spawn()` (`turborepo-process/src/lib.rs:123-150`). PTY for terminal-attached, pipe otherwise. Registers `Child` in HashMap<TaskId, Vec<Child>> for signal forwarding. `ProcessManager::Drop` impl reaps any lingering children (safety net) | `Bun.spawn` with `stdout: 'pipe', stderr: 'pipe'`. Stored in `persistentRegistry` only for `persistent: true` tasks | ✅ `runner.test.ts`, `persistent.test.ts` |
| Nx    | `fork()` (Node IPC) or `spawn()` for shell tasks. Pseudo-TTY mode when TUI active. Process-group tracking via `runningTasks` Map                                                                                                                             |                                                                                                                     |                                           |

### 5.2 Process-group kill on shutdown

|       | What                                                                                                                                                                           | vx                                                                                                                                                  | Test |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Turbo | Tracks children per task; on shutdown signal sends SIGTERM to all, then SIGKILL after timeout. Job objects on Windows                                                          | **GAP** — only `persistent: true` tasks are tracked. Regular one-shot tasks: not in any kill registry. SIGINT → JS finally skipped → child orphaned | ❌   |
| Nx    | `killProcessTreeGraceful()` — SIGTERM whole tree, SIGKILL after grace (`task-orchestrator.ts:1809-1821`). Snapshots `runningContinuousTasks` before clearing map to avoid race |                                                                                                                                                     |      |

**GAP — audit doc item #1.** **Ship a registry for all in-flight `Bun.spawn` children + tree-kill on SIGINT.**

### 5.3 Signal forwarding

|       | What                                                                                        | vx                                                              | Test                  |
| ----- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------- | --- |
| Turbo | Async cancellation token + SIGTERM to child PIDs via tokio. Two-Ctrl+C escalates to SIGKILL | IPC signal forwarding (`forked-process-task-runner.ts:411-444`) | **GAP** — same as 5.2 | ❌  |
| Nx    | Same                                                                                        |                                                                 |                       |

### 5.4 PATH augmentation per task

|       | What                                                         | vx   | Test                                          |
| ----- | ------------------------------------------------------------ | ---- | --------------------------------------------- | ------------------- |
| Turbo | Workspace `.bin` + per-package `node_modules/.bin` prepended | Same | ✅ project's own `node_modules/.bin` (PR #46) | ✅ `runner.test.ts` |
| Nx    | Same                                                         |      |                                               |

### 5.5 Recursive turbo/nx detection

|       | What                                                                      | vx                                                                                                                                                                                  | Test                                                                                           |
| ----- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --- |
| Turbo | Pre-spawn check: regex match command for "turbo run", reject if root task | DB-backed `task_invocations` table with unique constraint; child registers `(pid, taskId)`; ancestor already-registered → throw with chain printed (`task-orchestrator.ts:432-459`) | **GAP** — we'd happily run `vx run foo` that invokes `vx run foo`. Probably rare but a footgun | ❌  |
| Nx    | (per Nx column)                                                           |                                                                                                                                                                                     |                                                                                                |

### 5.6 Resource accounting per task

|       | What                                                                                 | vx                        | Test                                                                                      |
| ----- | ------------------------------------------------------------------------------------ | ------------------------- | ----------------------------------------------------------------------------------------- | ------------------- |
| Turbo | OOM detection (`exit 137` on Unix, `0xC0000017` on Windows) → distinct error message | OOM handled via exit code | `Bun.spawn().resourceUsage()` records `cpu_ms`, `peak_rss_bytes` to `runs` table (PR #20) | ✅ `runner.test.ts` |
| Nx    | Process metrics via DB                                                               |                           |                                                                                           |

### 5.7 Failure cascade

|       | What                                                                                                                                             | vx                           | Test                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- | ----------------------------------------------------------------------------------- | --- |
| Turbo | `ContinueMode::{Never \| DependenciesSuccessful \| Always}` (3 modes); failure → walker cancel or subtree-skip (`engine/src/execute.rs:132-145`) | Three modes via `--continue` | **GAP** — we have one mode only (always continue siblings; cascade-skip dependents) | ⚠️  |
| Nx    | `--bail` flag; dependent skip cascades via `reverseTaskDeps` precomputed at init                                                                 |                              |                                                                                     |

**GAP — feature, not integrity. Already in `comparison.md` backlog as `--continue=<mode>`.**

### 5.8 Persistent tasks

|       | What                                                                                    | vx                                                                                                                                                                                                                           | Test                                                                                                                  |
| ----- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Turbo | Watch mode handles. Non-watch: persistent task without `dependsOn` is success-immediate | `runningContinuousTasks` Map; `SharedRunningTask` wrapper detects "task already running in another process" via DB and polls instead of spawning. `cleanUpUnneededContinuousTasks()` kills continuous tasks no longer needed | ✅ `exec.persistent` with `readyWhen` regex (PR persistent-tasks); SIGTERM all at end-of-run via `persistentRegistry` | ✅ `persistent.test.ts` (10 tests) |
| Nx    | (per Nx column)                                                                         |                                                                                                                                                                                                                              |                                                                                                                       |

### 5.9 OOM / exit-code 137 special handling

|       | What                                                            | vx                       | Test                                            |
| ----- | --------------------------------------------------------------- | ------------------------ | ----------------------------------------------- | --- |
| Turbo | Distinct error message: "Process killed by OOM (exit code 137)" | Exit code surfaced as-is | **GAP** — we surface "exit 137" without context | ❌  |
| Nx    | Same as Turbo                                                   |                          |                                                 |

**GAP — small UX win.** Add: when child exit code is 137 (Linux SIGKILL → typically OOM), print a hint.

---

## Phase 6 — Cache save

### 6.1 Output discovery

|       | What                             | vx                 | Test                                                                |
| ----- | -------------------------------- | ------------------ | ------------------------------------------------------------------- | ------------------- |
| Turbo | Glob walk per declared `outputs` | Glob walk via Rust | `resolveOutputs(globs)` — `Bun.Glob` with project-boundary excludes | ✅ `inputs.test.ts` |
| Nx    | Native `expandOutputs()` glob    |                    |                                                                     |

### 6.2 Stage + tar.zst build

|       | What                                                                                                                          | vx     | Test                                                                            |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------- | --- |
| Turbo | Stage to temp dir; tar via Rust `tar` crate streaming + zstd encoder (`cache_archive/create.rs:137-165`). 1MB buffered writer | Native | `mkdtemp` + `Bun.write` per output; subprocess `tar -cf -` + `Bun.zstdCompress` | ✅  |
| Nx    | Native                                                                                                                        |        |                                                                                 |

### 6.3 Atomic publish

|       | What                                                                                                                                                                                                | vx           | Test                                      |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------- | ---------------------------------------------------------- |
| Turbo | Per-PID temp file `.{hash}.{pid}.{counter}.tmp`; atomic `rename()` to final (`create.rs:23-31, 93-111`). Concurrent writers race; one wins. Eviction sweeps stale `.tmp` after 1h (`fs.rs:317-333`) | tmp + rename | ✅ `tmp-${pid}-${ts}` + `rename` (PR #86) | ⚠️ concurrent-write test exists for the DB but not for tar |
| Nx    | Same                                                                                                                                                                                                |              |                                           |

**GAP — minor.** Add test: spawn 3 concurrent `cache.save(sameHash, ...)` calls, assert exactly one tar.zst remains, no orphan `.tmp` files.

### 6.4 Metadata + manifest persistence

|       | What                                                                                                                         | vx                      | Test                                                                                                   |
| ----- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------ | --- |
| Turbo | 3 sidecars: `<hash>.tar.zst`, `<hash>-manifest.json`, `<hash>-meta.json` (`fs.rs:206-268`). Each written tmp + atomic rename | Single file `.db` + tar | Single SQLite `entries` row + `output_files` rows in **one transaction** alongside tar rename (PR #95) | ✅  |
| Nx    | Native                                                                                                                       |                         |                                                                                                        |

### 6.5 Eviction (TTL + LRU by size)

|       | What                                                                                                                                                                              | vx                                                                                              | Test                           |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------ |
| Turbo | Two-phase: (1) drop entries older than `max_age` (`fs.rs:291-412`); (2) if total still > `max_size`, sort by mtime, drop oldest until under cap. Removes all 3 sidecars per entry | `vx cache prune --older-than <duration>` and `--max-size <bytes>` — already implemented (PR #9) | ✅ `cli.test.ts` cache section |
| Nx    | DB-based, similar shape                                                                                                                                                           |                                                                                                 |                                |

### 6.6 Disk full / IO error mid-write

|       | What                                                                                                                                                                           | vx                                                                                                                                                    | Test |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Turbo | `Drop` handler removes temp file on err (`create.rs:52-61`). Archive not renamed → cache miss on next fetch. Metadata write failure silently ignored, defaults applied on read | `await` failures propagate; we don't have a `using` / Drop guard so a thrown error during tar build can leave the `.tmp-*` behind until next eviction | ⚠️   |
| Nx    | tryAndRetry wrapper (see 6.7)                                                                                                                                                  |                                                                                                                                                       |      |

**GAP — small.** Add a `finally` in `save()` that does `await rm(tmpPath, { force: true })` if rename hasn't happened. Reduces orphan-tmp accumulation under pathological FS conditions.

### 6.7 Retry on transient FS failures

|       | What                                                                                                                                                            | vx   | Test                        |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------- | --- |
| Turbo | None at cache layer                                                                                                                                             | None | **GAP** — audit doc item #6 | ❌  |
| Nx    | `tryAndRetry()` (`tasks-runner/cache.ts:660-682`) wraps every put / copyFilesFromCache call. Base 15ms, exponent 2–4 random jitter, 6 attempts max (~20s total) |      |                             |

**GAP — audit doc item #6, ship.** Single helper `withRetry()` in `src/util/retry.ts`, wrap `cache.save`'s file ops + `cache.get`'s tar read. Skip SQLite (has its own `busy_timeout`). Skip remote HTTP (has its own timeout semantics).

### 6.8 Concurrent writers to same hash

|       | What                                                                      | vx   | Test                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Turbo | Per-PID temp file; atomic rename race — one wins. Test at `fs.rs:543-610` | Same | ✅ tar atomic rename + SQLite `busy_timeout = 5000` (PR #17) for DB. Concurrent-tar test exists in `cache.test.ts` ("two concurrent writers do not crash with SQLITE_BUSY") | ✅  |
| Nx    | DB transaction handles concurrency                                        |      |                                                                                                                                                                             |

---

## Phase 7 — Remote cache (when enabled)

### 7.1 HTTP GET artifact

|       | What                                                                                                                                                                                                                                          | vx   | Test                                                                                   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Turbo | `HTTPCache::fetch()` (`http.rs:337-399`). Token refresh on 403. HMAC-SHA256 validation: extract `x-artifact-tag` header, validate against `HMAC-SHA256(key, hash ‖ team_id ‖ body)`. Rejects mismatch (`signature_authentication.rs:122-135`) | None | ✅ `RemoteCache.get(hash)` in `src/cache/remote-cache.ts` (PR #10). No HMAC validation | ✅ `remote-cache.test.ts` (10 tests) — but no HMAC test |
| Nx    | DB + nx-cloud client                                                                                                                                                                                                                          |      |                                                                                        |

### 7.2 HTTP PUT artifact

|       | What                                                                                                                                | vx                                            | Test     |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------- | --- |
| Turbo | `HTTPCache::put()` (`http.rs:178-248`). Computes HMAC, sends as `x-artifact-tag`. Chunked 256KB upload. Tracks via `UploadProgress` | `RemoteCache.put(hash, bytes, meta)` (PR #10) | ✅ basic | ✅  |
| Nx    | Same                                                                                                                                |                                               |          |

### 7.3 HMAC signature on remote artifacts

|       | What                                                                                                                             | vx                                                                                                  | Test |
| ----- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---- |
| Turbo | Env-gated: `TURBO_REMOTE_CACHE_SIGNATURE_KEY` ≥ 32 bytes. Signed metadata = `hash ‖ team_id`. Travels in `x-artifact-tag` header | **GAP** — audit doc item #4. No signing. Anyone with write access to remote bucket can poison cache | ❌   |
| Nx    | None                                                                                                                             |                                                                                                     |      |

### 7.4 Remote upload tracking

|       | What                                                                                                          | vx                                                              | Test                                          |
| ----- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------- |
| Turbo | `RunCache` tracks pending uploads; waits at end-of-run via `RunCache::shutdown_cache()` with progress spinner | Async fire-and-forget; remote PUT failure logged not propagated | ⚠️ uploads may not finish before process exit |
| Nx    | Fire-and-forget                                                                                               |                                                                 |                                               |

**GAP — small.** If user starts a build with remote cache and exits immediately, in-flight PUTs are abandoned. Track pending PUTs and await them in `cache.close()` with a timeout.

### 7.5 Provenance metadata (SCM SHA, dirty hash)

|       | What                                                                                                                                                                                                 | vx              | Test |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ---- |
| Turbo | Background-computed git HEAD SHA + dirty hash; sent as `x-artifact-sha` + `x-artifact-dirty-hash` headers. Stored in `<hash>-meta.json`. Used for debugging / staleness detection (`lib.rs:117-133`) | Nothing — defer | ❌   |
| Nx    | None                                                                                                                                                                                                 |                 |      |

**Defer.** Useful for `vx stats`-style introspection. Not a backlog priority.

---

## Phase 8 — Log replay & output handling

### 8.1 Streaming during exec

|       | What                                                                                                                     | vx                                                                                                             | Test                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Turbo | Per-task PTY → output writer; grouping layer manages prefix / interleaving. Real-time streaming when `streamOutput=true` | Per-task buffering via `defaultLogger`; whole-block write on `taskComplete()` (`orchestrator/logger.ts:53-67`) | ✅ `framed-output.test.ts` |
| Nx    | Same buffering + TUI capture                                                                                             |                                                                                                                |                            |

### 8.2 Replay on cache hit

|       | What                                                                 | vx                                                                                   | Test |
| ----- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---- |
| Turbo | Buffered log replayed via grouping layer based on `output-logs` mode | One `process.stdout.write` per task in `taskComplete()` (matches Turbo/Nx structure) | ✅   |
| Nx    | Same                                                                 |                                                                                      |      |

### 8.3 Output-mode flags

|       | What                                                                                                                                                                | vx                                | Test                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------- | --- |
| Turbo | `--output-logs={full,hash-only,new-only,errors-only,none}` (`turborepo-run-cache:136-150`). Per-task `outputLogs` in turbo.json merged with CLI override (CLI wins) | `--output-style {static,dynamic}` | **GAP** — already in `comparison.md` backlog | ❌  |
| Nx    | (per Nx column)                                                                                                                                                     |                                   |                                              |

### 8.4 CI log-grouping (GitHub Actions `::group::`)

|       | What                                                                                                                     | vx   | Test                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------ | ---- | ----------------------------------------------------- | --- |
| Turbo | When `is_github_actions`, grouping layer emits `::group::<task>` + `::endgroup::` markers and redirects stderr to stdout | None | **GAP** — free CI UX win (10-line addition to logger) | ❌  |
| Nx    | Has equivalent                                                                                                           |      |                                                       |

**Ship.** Detect `GITHUB_ACTIONS=true`, wrap each `formatTaskBlock` in `::group::name` / `::endgroup::`. Test: set env, assert markers in output.

### 8.5 Log timestamps

|       | What                                                       | vx   | Test |
| ----- | ---------------------------------------------------------- | ---- | ---- | --- |
| Turbo | `--log-timestamps` prefixes each line with wall-clock time | None | None | ❌  |
| Nx    | None                                                       |      |      |

Defer.

### 8.6 ANSI handling

|       | What                                                               | vx                                  | Test                                                                     |
| ----- | ------------------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------ | ----------------------------- |
| Turbo | Color forwarding controlled by `--color` flag; stripped if not TTY | `FORCE_COLOR` env injected per task | `colors.ts` honors `NO_COLOR` / `FORCE_COLOR` / TTY auto-detect (PR #46) | ✅ `colors.test.ts` (8 tests) |
| Nx    | Same; TUI strips ANSI for static output                            |                                     |                                                                          |

---

## Phase 9 — Watch mode

|       | What                                                           | vx                                                                                                                                                                                                                           | Test                                |
| ----- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Turbo | `notify` crate inside daemon; debounce + affected-task compute | `fs.watch(projectDir, {recursive: true})` per project + workspace root non-recursive. Debounced 150ms. Reentrancy guard for events during a cycle. SIGINT trap. Path filter ignores `node_modules/.git/.vx/*.tsbuildinfo/*~` | ✅ `cli.test.ts` includes watch e2e |
| Nx    | `chokidar` + project-graph aware; affected-task subset         |                                                                                                                                                                                                                              |                                     |

GAP: no affected-task subset (always re-runs all requested). Documented in `runner-comparison-2026-05.md`. Defer.

---

## Phase 10 — Cleanup & shutdown

### 10.1 Graceful shutdown

|       | What                                                                                                                                                                                      | vx                                                                                                                                                                                                     | Test                                                          |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | --- |
| Turbo | Two-phase: SIGTERM all → 3s grace → name slow tasks → second Ctrl+C escalates to SIGKILL. `RunCache::shutdown_cache()` flushes pending uploads concurrently with own 2s timeout + spinner | `cleanup()` performs DB removal of persistent tasks → snapshots `runningContinuousTasks` → SIGTERM tree → await all discrete-task exits → exit with signal code. Idempotent via `cleanupPromise` guard | **GAP** — no signal handler; finally blocks skipped on SIGINT | ❌  |
| Nx    | (per Nx column)                                                                                                                                                                           |                                                                                                                                                                                                        |                                                               |

### 10.2 ProcessManager Drop safety net

|       | What                                                                            | vx                                                      | Test |
| ----- | ------------------------------------------------------------------------------- | ------------------------------------------------------- | ---- | --- |
| Turbo | `ProcessManager::Drop` kills any lingering registered child as a final fallback | None — `Bun.spawn` children don't have a Drop guarantee | None | ❌  |
| Nx    | Same: exit handler reaps                                                        |                                                         |      |

### 10.3 Stop-requested debouncing

|       | What                                                         | vx                                                                                                       | Test    |
| ----- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------- | --- |
| Turbo | `select!` race; second signal during cleanup → force SIGKILL | `stopRequested` flag on `setupSignalHandlers` debounces — multiple Ctrl+C collapse into one cleanup pass | **GAP** | ❌  |
| Nx    | (per Nx column)                                              |                                                                                                          |         |

---

## Test coverage gap matrix

The 478 unique `it()` descriptions in our 29 test files were grepped against every scenario above. Below are the GAPs — scenarios we either ship or care about correctness-wise but **have no test for**.

### High priority (correctness — ship test)

| #   | Scenario                                                                                        | Suggested test                                                                       | File            |
| --- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------- |
| H1  | SIGINT mid-run reaps children + closes cache                                                    | `tests/orchestrator-signal.test.ts` (new)                                            | new             |
| H2  | Path-traversal entry in tar rejected                                                            | `tests/cache-baseline.test.ts` add `extractOutputs` test with `../escape` entry name | extend existing |
| H3  | Racy-git detection (same-second edit)                                                           | `tests/cache-perf.test.ts` add edit-within-second test                               | extend existing |
| H4  | tar contains symlink entry — handle or reject                                                   | `tests/cache-baseline.test.ts` add test                                              | extend existing |
| H5  | Concurrent `cache.save(sameHash)` from 3 processes — exactly one tar survives, no orphan `.tmp` | `tests/cache.test.ts` add multi-process test                                         | extend existing |
| H6  | OOM exit code 137 surfaced with hint                                                            | `tests/runner.test.ts` mock child exit 137                                           | extend existing |
| H7  | `.gitignore` content folded into workspace fingerprint                                          | `tests/orchestrator.test.ts` add change-gitignore-busts-cache test                   | extend existing |

### Medium priority (robustness — ship test + small impl)

| #   | Scenario                                              | Suggested action                                          |
| --- | ----------------------------------------------------- | --------------------------------------------------------- |
| M1  | Retry with exponential backoff on transient FS errors | Implement `withRetry()` helper + tests                    |
| M2  | Recursive `vx run vx run X` detection                 | Add invocation-loop check + test                          |
| M3  | Tar disk-full mid-write → tmp cleanup in `finally`    | Strengthen save() + add test that simulates write failure |
| M4  | Remote PUT pending-upload flush at `cache.close()`    | Track pending PUTs + await with timeout                   |
| M5  | HMAC validation on remote artifact (env-gated)        | Implement `VX_REMOTE_CACHE_SIGNATURE_KEY`                 |
| M6  | GitHub Actions log-grouping markers                   | Detect env + wrap blocks                                  |

### Low priority (feature parity — defer)

| Scenario                                                           | Why defer                                                                    |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Machine-ID gate                                                    | Only matters for shared `<cacheDir>` across machines                         |
| Per-project transitive-deps hash slice                             | Optimization; current whole-lockfile fingerprint is correct, just over-broad |
| `vx.workspace.ts` `extends` chain                                  | Feature; no user driving it                                                  |
| `extractOutputs` partial-restore (per-file extract on mixed-state) | Optimization on a path that's already manifest-skip-fast                     |
| Cross-run project-graph cache                                      | Cold-start optimization; defer until measured                                |
| `--continue=<mode>` flag                                           | Feature; in `comparison.md` already                                          |
| `--output-logs=<mode>` flag                                        | Feature; in `comparison.md` already                                          |
| Log timestamps                                                     | Feature                                                                      |
| Provenance metadata (git SHA in artifact)                          | No consumer                                                                  |
| Affected-task subset in watch                                      | Cache already handles the no-op case                                         |

---

## Recommended ship order (with test PRs)

1. **PR-S1: SIGINT handler + test (H1).** Pure correctness fix. ~30 LOC + 1 test file. References audit doc item #1.
2. **PR-S2: Path-traversal guard + test (H2).** ~5 LOC in `tar.ts` + 1 test. References audit doc item #2.
3. **PR-S3: GitHub Actions log-grouping + test (low-effort UX).** ~10 LOC in logger + 1 test.
4. **PR-S4: Symlink + racy-git tests (H3, H4).** Tests document current behavior; if we want to support symlinks, ship in same PR.
5. **PR-S5: Concurrent-save + OOM-hint + retry helper (H5, H6, M1).** Three small focused additions.
6. **PR-S6: Remote-PUT flush (M4).** Honest about the fact that we lose remote uploads on quick exit today.

Items M5+, M2 are deferred until a user driver appears.

---

## Cross-references

- `docs/design/integrity-audit-2026-05.md` — original 6-item integrity audit. Items #1–#6 in that doc map to gaps H1, H2, M5, audit-defer, audit-defer, M1 here.
- `docs/design/runner-comparison-2026-05.md` — first-pass operation comparison. This doc supersedes it (more thorough, more scenarios covered).
- `docs/comparison.md` — feature backlog vs Turbo/Nx (`--continue`, `--output-logs`, named inputs, etc).
- `CLAUDE.md` decision log — every PR-#-tagged claim in this doc traces to a decision entry there.

## How this doc gets maintained

When a PR ships that closes a gap, edit the corresponding row's `vx`
cell and `Test coverage` cell (✅/file). Don't delete the row —
keeping it lets the next audit verify the gap stayed closed. The
"Recommended ship order" section is the live worklist.

When Turbo / Nx ship a change to one of the cited file:line ranges,
update the citation. The agent prompts that produced this doc are
stored in the session transcript; re-run them against new revisions
to regenerate. Pin every claim to a source line you can `grep`.
