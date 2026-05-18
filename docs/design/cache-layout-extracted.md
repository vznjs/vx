# Cache layout: extracted-on-disk + tar-at-wire

## Status

Proposal. Demoed via `/tmp/cache-layout-bench.ts` against Bun 1.3.11 on
linux-x64. Disk: tmpfs (results would be similar on SSD; slower on
rotating disk where `extracted` would lose more on `restore` due to
seek pattern, but no vx target users are on rotating disks).

## Motivation

Current layout (v17) stores each cache entry as `<hash>.tar.zst` —
a zstd-compressed tar containing `stdout` + `outputs/<rel>`. Reasoning
at the time (commit `ec7cf61`): match Turbo's wire format, one
sequential disk read on restore, one tar-extract subprocess instead
of N JS writes.

In retrospect the optimization was aimed at the wrong hot path. Our
actual common case is **cache hit + tree already current** — and on
that path we read stdout for replay (forcing a decompress) and then
stat-and-skip the restore. We pay the zstd cost for every cache hit
even when we don't need any output bytes.

Turbo solves this with a separate `<hash>-manifest.json` sidecar that
their fast-path validator reads instead of opening the tar. We have
the same machinery (the `output_files` SQLite table) but it's
upstaged by the unconditional decompress in `Cache.get`.

## Proposal

Drop tar.zst as the **local** storage format. Keep tar.zst as the
**wire format** for remote cache PUT/GET.

```
<cacheDir>/
  cache.db                    — entries + output_files + runs (unchanged)
  <hash>/
    stdout.log                — captured stdout (always present, may be empty)
    outputs/<rel>             — extracted output files (only when task produced any)
```

- `Cache.save`: write into `<hash>.partial/` (cp -rp from the project
  dir for outputs, write stdout.log directly), atomic `mv` to
  `<hash>/`. Insert SQL row + output_files manifest in one transaction.
- `Cache.get`: SQL row + `Bun.file('<hash>/stdout.log').text()`. **Zero
  compression I/O.**
- `Cache.isOutputsCurrent`: SQL manifest + N stats (unchanged).
- `Cache.restoreOutputs`: `cp -rp <hash>/outputs/. <projectDir>/`.
  One subprocess, no decompress. Uses CoW (`clonefile()` on APFS,
  `--reflink=auto` on Linux btrfs/XFS) automatically; falls back to
  plain copy on ext4.
- `LayeredCache.save`: `tar -cf - -C <cacheDir>/<hash> . | zstd` → POST.
- `LayeredCache.get` (remote hit): receive tar.zst, decompress + extract
  into `<hash>.partial/`, atomic rename. Walk extracted dir to populate
  SQL output_files; entries row from caller ctx + x-artifact-duration
  header.

## Bench

Methodology: each scenario builds a project dir, then measures save +
get + restore for both layouts. Median of 5 runs after warmup. `du -sb`
for sizes. All on the same tmpfs path to factor out FS variance.

| scenario | project size | save tar | save ext | size tar | size ext | get tar | get ext | restore tar | restore ext |
|---|---|---|---|---|---|---|---|---|---|
| lint (0 outputs, 5KB stdout) | 0B | 3.75ms | 3.68ms | 165B | 5.0KB | 100µs | 61µs | 2.35ms | 1.79ms |
| build (50 outputs ~40KB, 200B stdout) | 1.51MB | 21.59ms | 16.39ms | 66.9KB | 1.51MB | 7.87ms | **79µs** | 25.00ms | 7.10ms |
| test (0 outputs, 500KB stdout) | 0B | 5.53ms | 4.08ms | 199B | 500.0KB | 369µs | 305µs | 4.31ms | 1.82ms |
| bigbuild (200 outputs ~20KB, 1KB stdout) | 3.01MB | 32.21ms | 21.22ms | 171.2KB | 3.01MB | 3.57ms | **128µs** | 41.19ms | 17.32ms |

### Read-back (`Cache.get`)

This is the hot path on every cache hit, including the
manifest-validates-skip-restore warm case:

- **lint**: 100µs → 61µs (~1.6× faster)
- **build**: 7.87ms → 79µs (**~100× faster**)
- **test**: 369µs → 305µs (~1.2× faster, dominated by stdout size)
- **bigbuild**: 3.57ms → 128µs (**~28× faster**)

For tasks with non-trivial output (build/bigbuild), the savings are
substantial. For a `vx run ci` with 200 cached tasks of mixed sizes,
expect 1-3 seconds of `cache.get` overhead reclaimed.

### Restore

- **lint**: 2.35ms → 1.79ms (~1.3× faster)
- **build**: 25.00ms → 7.10ms (~3.5× faster)
- **test**: 4.31ms → 1.82ms (~2.4× faster)
- **bigbuild**: 41.19ms → 17.32ms (~2.4× faster)

`cp -rp` beats `decompress + tar -xf` because the kernel batches the
copies and there's no compression CPU. On filesystems with reflink
support (APFS / btrfs / XFS) it would be near-instant via CoW.

### Save

Modest wins across the board (5-30% faster). `cp` avoids zstd compress.

### Disk usage — the real cost

| scenario | tar.zst | extracted | ratio |
|---|---|---|---|
| lint | 165B | 5.0KB | 31× |
| build | 66.9KB | 1.51MB | 23× |
| test | 199B | 500.0KB | 2500× |
| bigbuild | 171.2KB | 3.01MB | 18× |

Note these are synthetic numbers — the test fixtures use heavily
repetitive content that compresses unusually well (zstd ratios of 20-
2500×). **Real project source / build outputs typically compress 3-5×.**

So for a realistic cache with 200 entries averaging 50MB of build
output each:

- Today (compressed): ~2GB cache directory
- Proposed (extracted): ~10GB cache directory

Mitigation: `vx cache prune --max-size 5G` already handles bounded
growth via LRU. Users who care can set a tight cap; users on big
machines won't notice.

## Wire format unchanged

`LayeredCache` still ships `tar.zst` over the existing remote cache
HTTP wire. The Turbo `/v8/artifacts/<hash>` PUT/GET semantics, the
`x-artifact-duration` header — all unchanged. Servers don't need to
care that vx's local storage is now extracted.

On `LayeredCache.save` we pack on the fly: `tar -cf - -C <hash> . |
zstd`. Cost is amortized into the async fire-and-forget upload that
already exists today.

## What this enables / deletes

- Delete `src/cache/tar.ts` (~294 LOC): in-process tar reader, PAX
  header handling, AppleDouble filtering, Windows-path rejection,
  longname extension, typeflag security checks. Local extraction no
  longer parses tar; remote extraction uses `Bun.spawn(['tar', '-xf'])`
  on bytes we just fetched from our own protocol — same trust level as
  any other network response.
- Delete `Cache.packArtifact` and the `mkdtemp` staging dance.
- Delete the `decompressedTar` single-slot stash and the `get →
  restoreOutputs` coupling that depends on it.
- Drop `COPYFILE_DISABLE` env workaround.
- `isOutputsCurrent` becomes the *actual* fast-path validator it was
  designed to be — never decompresses.

Add:
- ~10 LOC atomic-dir-rename pattern (`<hash>.partial.<pid>` → `<hash>`,
  via `mv` subprocess or `fs.rename`).
- ~15 LOC `cp -rp` save (per output file or as one cp call).
- ~10 LOC `cp -rp` restore.
- ~30 LOC tar pack/unpack at LayeredCache boundary (Bun.spawn).

Net: **~-250 LOC**, simpler hot path, kernel-handled bytes-moving.

## Cache version

`CACHE_VERSION` bumps to v18 (cache key derivation unchanged — same
xxh3 chain). `SCHEMA_VERSION` stays at v17 (table shapes unchanged;
`output_files` is now the primary manifest store as designed).

Old v17 entries (`<hash>.tar.zst` files) are orphaned on first run
and reaped by `vx cache prune`.

## Security

Local cache trust is unchanged — same model as today (same user wrote
it, fingerprints in `output_files` catch FS-level corruption via
`isOutputsCurrent`).

Remote signing (HMAC, `x-artifact-tag`) lives at the LayeredCache
boundary on the tar bytes — orthogonal to local storage choice. When
we add it (separate PR), the existing extracted-local design accepts
it as a verify-before-extract step. No conflict.
