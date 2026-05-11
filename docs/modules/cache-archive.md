# `cache-archive.ts` — tar.gz pack/unpack for remote-cache artifacts

## Purpose

Bridges the local v10 cache layout and the remote-cache wire body.
Pure helpers that pack a stage directory into a `tar.gz` `Uint8Array`
and unpack one back into a destination directory.

Used by `LayeredCache` to:

- **Pack** an artifact for `RemoteCache.put()`: stage `meta.json` +
  `outputs/`, tar+gzip the stage, send the bytes.
- **Unpack** an artifact from `RemoteCache.get()`: write bytes to a
  stage dir, then materialize into the local cache.

## Public surface

```ts
packArchive(stageDir: string): Promise<Uint8Array>
unpackArchive(buf: Uint8Array | ArrayBuffer, destDir: string): Promise<void>
packAndDiscard(stageDir: string): Promise<Uint8Array>

tarPath(...segments: string[]): string       // POSIX-safe path join
uniqueStageDir(parent: string, prefix: string): string // pid+timestamp
```

## Implementation

Shells out to system `tar` via `Bun.spawn` with stdin/stdout streaming:

- **Pack**: `tar -cz -C <stageDir> .` to stdout pipe → returned as bytes.
- **Unpack**: `tar -xz -C <destDir>` reading from stdin pipe.

No JS tar implementation, no native dependency. `tar` ships on every
platform we care about (GNU on Linux, BSD on macOS, MS-bundled on
Windows 10+).

## Stage-dir layout convention

Callers stage this shape inside `stageDir` before packing:

```
stageDir/
├── meta.json           # CacheEntry shape (taskId, command, exitCode, ...)
└── outputs/
    └── <project-relative paths>
```

The same layout reappears in `destDir` after unpacking.

## Error handling

- `packArchive` rejects (with `Error: tar exited <code>`) when the
  source dir doesn't exist or tar fails.
- `unpackArchive` rejects on a corrupt input. `destDir` is created
  with `mkdir -p` semantics before tar runs.

## What this does NOT do

- No compression-level tuning. `-z` defaults are fine; cache transfer
  is network-bound.
- No content-addressing or checksums. The caller chose to use this
  archive for hash `X`; we don't verify.
- No symlink-handling tweaks beyond tar's defaults.

## Tests

`src/cache-archive.test.ts` covers:

- Round-trip with `meta.json` + `outputs/` survives identically.
- Binary content preserved byte-for-byte (256-byte all-values blob).
- Empty stage dir packs and unpacks cleanly.
- Deep tree (6 levels) survives.
- `unpackArchive` creates `destDir` if missing.
- `packArchive` rejects on missing source.
- `unpackArchive` rejects corrupt tarballs.
- Both `ArrayBuffer` and `Uint8Array` inputs accepted.
- `tarPath` POSIX-safe joining (backslashes, double slashes).

## Replacing this module

To swap to zstd (faster compression than gzip), change `tar -cz` to
`tar --zstd -c` and update test fixtures. To replace tar entirely
(e.g., a JS implementation, or zip instead), keep the three public
function signatures the same and `LayeredCache` doesn't change.
