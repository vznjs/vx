# `cache.ts` — content-addressed task cache

## Purpose

Compute cache keys, store cache entries, retrieve them, and restore
output files on hit. The on-disk format and key derivation logic live
here.

## Public surface

```ts
export class Cache {
  constructor(cacheDir: string)

  async key(input: CacheKeyInput): Promise<string>
  async get(hash: string): Promise<CacheEntry | null>
  async restoreOutputs(hash: string, projectDir: string): Promise<void>
  async save(args: {
    hash: string
    entry: Omit<CacheEntry, 'hash' | 'storedAt' | 'outputFiles'>
    projectDir: string
    outputFiles: string[]                  // absolute paths
  }): Promise<void>
}

export interface CacheKeyInput {
  taskId: string
  taskConfigHash: string
  envValues: Array<[name: string, value: string]>
  inputFiles: string[]
  workspaceRoot: string
  upstreamHashes: string[]
  workspaceFingerprint: string
}

export interface CacheEntry {
  hash: string
  taskId: string
  command: string                          // joined with ' && ' for multi-step
  exitCode: number
  durationMs: number
  outputFiles: string[]                    // project-relative POSIX paths
  stdout: string
  stderr: string
  storedAt: string                         // ISO timestamp
}
```

## Key derivation (`Cache.key`)

The key is a sha256 hex digest, computed by feeding values to the hash
in this exact order:

```
<CACHE_VERSION>\n
task:<taskId>\n
workspace:<workspaceFingerprint>\n
config:<taskConfigHash>\n
env-values:<n>\n
  <name>=<value>\n (n times, in supplied order — caller pre-sorts)
upstream:<n>\n
  <hash>\n (n times, after we sort)
inputs:<n>\n
  <relPath>\0<fileHash>\n (n times, after we sort inputFiles)
```

`<fileHash>` is sha256 of the file contents. `<relPath>` is the POSIX-
relative path from `workspaceRoot` (so cache keys are stable across
platforms).

Determinism notes:
- The caller is responsible for canonicalizing `envValues` and
  `inputFiles` ordering (`inputs.ts` sorts both).
- `upstreamHashes` is sorted inside `key()` so caller order doesn't
  matter.
- `taskConfigHash` is the caller's responsibility (computed by
  `orchestrator.hashTaskConfig`).

## Storage layout

```
<cacheDir>/
└── <hash>/
    ├── meta.json
    └── outputs/
        └── <project-relative paths>...
```

`meta.json` matches the `CacheEntry` interface above.

## Atomic writes

`save()` writes to a temp directory `<cacheDir>/<hash>.tmp-<pid>-<ms>`
first, then atomically renames it to `<cacheDir>/<hash>`. Means a
reader checking for the entry either sees nothing or sees a complete
entry — no half-written `meta.json` without its outputs.

If the target already exists (e.g., another process raced us), we
remove it first then rename, which is **not race-safe across multiple
writers**. In practice `vzn` invocations are sequential per-machine;
multi-machine cache sharing would need a different backend.

## Restore semantics

`restoreOutputs(hash, projectDir)`:
- If `<cacheDir>/<hash>/outputs/` doesn't exist, no-op.
- Otherwise recursively copies into `projectDir`, creating parent
  directories as needed.
- Pre-existing local files at output paths are **overwritten**.
- Stored output paths are project-relative; layout is mirrored.

`get(hash)`:
- Reads `meta.json`. Returns parsed `CacheEntry` or `null` (if file
  missing or JSON corrupt).
- Doesn't restore files — the caller (orchestrator) decides when to
  call `restoreOutputs`.

## `hashFiles` helper

```ts
export async function hashFiles(baseDir: string, files: readonly string[]): Promise<string>
```

Standalone function that hashes a set of files relative to a base
directory. Folds in a CACHE_VERSION marker plus a count, then per-file
`<relPath>\0<sha256>\n`. **Currently unused** but kept for future
output-content-based propagation if we revisit that strategy.

## What this does NOT do

- Doesn't compress entries. `dist/` of typical projects is ~1–10MB
  per entry; uncompressed is fine for local cache. Remote cache should
  add tar+zstd at the wire.
- Doesn't garbage-collect old entries. `.vzn/cache/` grows unboundedly.
  Cleanup is currently manual (`rm -rf .vzn/cache`).
- Doesn't verify entries are intact on read (no checksums beyond the
  filename). A corrupt `meta.json` gets treated as a miss.

## `CACHE_VERSION`

Currently `'vzn-cache-v7'`. Bump when:
- A new field is added to `CacheKeyInput`.
- The order or framing of existing key fields changes.
- The `meta.json` schema changes.

Bumping invalidates every previously-stored entry. Pre-alpha tolerates
this freely; post-1.0 we'd want a migration story.

## Tests

`cache.test.ts` covers `Cache.key` exhaustively:
- Determinism across repeated calls.
- Changes in task id, config hash, env values, input file content,
  workspace fingerprint, upstream hashes all change the key.
- Ordering independence for input files and upstream hashes.
- Empty value vs unset env distinguishable.
- mtime change with same content does NOT bust.
- Project identity in key (two tasks with same files but different
  taskId → different keys).

End-to-end cache write/read/restore is covered by
`orchestrator.test.ts` e2e suite.

## Replacing this module

Most likely replacement: **remote cache**.

The contract is small: `key()` is pure given inputs; `get()`, `save()`,
`restoreOutputs()` are the three I/O methods. A remote implementation
would:

- Keep `key()` identical (cache keys must match across machines).
- Replace `get()` with an HTTP/S3 fetch + local materialization.
- Replace `save()` with a local write + async upload.
- Optionally layer local-then-remote in a wrapping `Cache`.

CACHE_VERSION versioning becomes the migration story across deployed
clients.
