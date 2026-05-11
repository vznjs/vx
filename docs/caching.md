# Caching

## Why caching is opt-in

`@vzn/run` deliberately requires you to provide a `cache` block (with
both `inputs.files` and `outputs.files`) to enable caching. The reason:
defaulting caching ON with implicit "all files / no outputs" leads to
silently stale builds when users forget to revisit the configuration.
Forcing declaration makes "what does this task depend on, and what
does it produce?" a conscious answer.

Omit the `cache` field → the task always runs, no cache reads or
writes. Provide it → caching is active.

## Cache key derivation

The cache key for one task is a SHA-256 digest of:

1. **A schema version sentinel** (`CACHE_VERSION` in `src/cache.ts`).
   Bumped only when the key derivation format changes.
2. **`taskId`** — `${projectName}#${taskName}`. Two tasks with
   identical everything else still produce different keys.
3. **Workspace fingerprint** — a hash of `pnpm-lock.yaml` plus
   `pnpm-workspace.yaml`. A `pnpm update` (lockfile change) or a
   workspace-shape change invalidates every cache entry.
4. **Task config hash** — `sha256(JSON.stringify(node.config))` of the
   _evaluated_ task config. Captures:
   - `exec` block (command, env declarations).
   - `dependsOn` and `cache.inputs.tasks` declarations.
   - `cache.outputs.files`, `cache.inputs.files`, `cache.inputs.env`
     declarations (the strings themselves; their _resolved values_
     contribute separately).
   - **Imported / computed values** — anything a preset or `process.env`
     read at config-load time injected, since jiti has already baked it
     into the object.
5. **`cache.inputs.env` resolved values** — `[name, value]` pairs read
   from host `process.env` at hash time. Listed names get their current
   values. Unset names contribute the empty string (and that's
   distinguishable from a name that was never listed).
6. **Input files' content hashes** — `cache.inputs.files` resolved to
   a concrete list of paths, then each file's content hashed. The
   result is folded in `(relPath, sha256)` per file, sorted by
   relative path for stability across machines.
7. **Filtered upstream task cache hashes** — every task this one
   depends on (per `dependsOn`) contributes its own cache key, filtered
   by `cache.inputs.tasks` (default: all of them). Sorted before
   hashing so ordering doesn't change the result.

## Cache restore

On hit:

1. Output files are copied from `.vzn/cache/<hash>/outputs/` into the
   project directory. Pre-existing local files at those paths are
   overwritten.
2. Captured stdout / stderr are replayed to the live terminal via the
   logger (preserves what a fresh run would have shown).
3. The task is marked `cache-hit` with `durationMs: 0` and the
   command is _not_ re-executed.

Restored files include parent directories that didn't exist; cache
write uses `mkdir -p` semantics on restore.

## Cache write

On miss → task runs to completion. If the final exit code is `0`:

1. `cache.outputs.files` is resolved against the project directory.
2. Matching files are copied into a _temporary_ directory next to the
   target cache slot.
3. A `meta.json` containing taskId, command, exit code, duration,
   captured stdout/stderr, and stored output paths is written.
4. The whole temp directory is atomically renamed to its final hash
   slot. This makes concurrent writers see either no entry or a
   complete entry — never a partial one.

If the task exits non-zero, **nothing is cached**. The next run will
re-execute. This is intentional: cached failures would prevent retry
flows.

## Invalidation paths

A task's cache becomes invalid when any of these change:

| Trigger                                                        | Mechanism                                                                     |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Edit a file in the task's `inputs.files` set                   | step 6 of key derivation                                                      |
| `pnpm install` updates `pnpm-lock.yaml`                        | step 3 (workspace fingerprint)                                                |
| Edit `pnpm-workspace.yaml`                                     | step 3                                                                        |
| Edit the task's `vzn.config.ts`                                | step 4 (config hash)                                                          |
| Edit a config file that the task config imports                | step 4 (configHash sees the resolved object after jiti evaluates the imports) |
| Change `inputs.env` host values                                | step 5                                                                        |
| Upstream task's cache key changes (because its inputs changed) | step 7                                                                        |
| Change CLI `forwardArgs` (after `--`)                          | folded into the key — different args produce a different entry                |
| Change `exec.env.passThrough` _values_ alone                   | NOT a trigger by design — passThrough values are host-specific                |

The cascade in row 7 is what makes monorepo caching work: edit `lib/`,
and every package that depends on `lib`'s `build` task is invalidated
automatically.

## Cross-project boundaries

A project's `inputs.files` globs never reach into another project's
directory, even if a `**/*` pattern would otherwise match. The
orchestrator computes the set of _nested project directories_ (other
projects whose dir is under this one) and adds them to the ignore
list passed to every glob.

The only way for project A to depend on project B's state is
`dependsOn` + the upstream-hash propagation (step 7). This is a hard
guarantee — there's no file-glob escape hatch.

## Storage layout

```
<workspaceRoot>/.vzn/cache/
├── cache.db                # SQLite metadata index + run history
├── cache.db-wal            # write-ahead log
├── cache.db-shm            # shared memory
├── <hash>/                 # output files at project-relative paths
│   └── dist/
│       └── ... (files mirroring the project-relative output paths)
└── logs/
    ├── <hash>.stdout       # captured stdout for that task
    └── <hash>.stderr       # captured stderr
```

`<hash>` is the full sha256 hex string. No subdirectory bucketing yet
— fine for thousands of entries; would want sharding past that.

SQLite holds the cache index in two tables (`entries` for the
per-hash record, `runs` for run history powering `stats()`). Output
files stay as files on disk because cache-hit restore copies them
back into the project — BLOBs in SQLite would just be a detour. See
`docs/design/local-cache-v10.md` for the design rationale.

## Performance characteristics

- **Hashing cost** scales linearly with total input file bytes per
  task. For large repos with `files: ['**/*']` this can dominate. To
  trim: declare narrow `inputs.files`.
- **Cache read** is one indexed SELECT + an `existsSync` of the
  on-disk artifact + file copies. SQLite's WAL keeps reads
  non-blocking even during concurrent writes.
- **Cache write** is one INSERT-or-UPDATE + atomic dir rename + two
  log file writes. Hashing dominates the run; the storage itself is
  cheap.
- **Workspace fingerprint** is computed once per `vzn run` invocation
  and reused for every task in that run.

## What's NOT in the key (and why)

- `exec.env.passThrough` _values_ — would force cache misses across
  machines with different CI flags or regions. Names are in the
  config hash (step 4) so adding/removing a passthrough still bumps
  the key.
- Files outside the project directory not listed in `inputs.files`.
  Workspace-root configs (`tsconfig.base.json`, etc.) are intentionally
  not auto-included — see the deferred `WorkspaceConfig.globalInputs`.
- Node version, OS, build tool versions. If you need these, set them
  via `define` (TypeScript-side `execSync('node --version')` →
  configHash captures it).

## Bumping `CACHE_VERSION`

Required when:

- A new field is added to the cache key derivation.
- The order or framing of existing key fields changes.
- The on-disk layout changes (file placement, log path conventions).
- The SQLite schema changes in a way that affects existing rows.

Not required when:

- Behavioural changes that adjust _which_ values flow into existing
  key components (those changes naturally produce different keys for
  affected tasks).

### History

- **v7 → v8** (PR #2): folded `forwardArgs` into the key for CLI
  argument forwarding alignment.
- **v8 → v9** (PR #3): `TaskConfig` shape changed — `exec` collapsed
  from an array to a single command, `tasks` nested under `run`.
- **v9 → v10** (this PR): on-disk layout switched from per-entry
  `meta.json` + `outputs/` directory to a workspace-wide
  `cache.db` (SQLite) plus output files directly at `<hash>/` and
  log files at `logs/<hash>.{stdout,stderr}`. Adds run history for
  stats. Removes the `meta.json` per-entry manifest.
