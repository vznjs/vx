---
title: 'A cache hit is a file copy'
date: 2026-10-20T18:00:00Z
authors:
  - vzn
tags:
  - caching
  - performance
excerpt: 'The local cache keeps each entry as plain files, unpacked once, so a hit is a copy the kernel does. 1,000 hits of 96 KiB restore in 411 ms. Why the archive stays only on the wire, why a hit checks nothing, and why vx never hard-links.'
---

1,000 tasks, each with a 96 KiB output, `dist` deleted, then one run:

```sh frame="terminal"
$ rm -rf packages/*/dist && time vx run build --all
  cache     local 1000↓
  time      214ms
real    0m0.411s

$ rm -rf packages/*/dist && time VX_CACHE_STORE_DECOMPRESS=false vx run build --all
  cache     local 1000↓
  time      618ms
real    0m0.686s
```

Same entries, two ways to keep them on disk:

| Store (`cache.store.decompress`) | Restore all 1,000 | Store on disk |
| -------------------------------- | ----------------- | ------------- |
| plain files (`true`, default)    | 411 ms            | 111 MB        |
| one `tar.zst` each (`false`)     | 686 ms            | 99 MB         |

Min of 5 restores per arm, 3 interleaved arms each, a fresh store per
arm. `private/vx-bench/generate.ts` with 1,000 projects, each build
writing 96 KiB of random bytes. Linux x64, 4 cores, vx at `a1786b3`,
2026-10-23.

## The kernel does the copy

The archive exists only on the wire. The local cache keeps each entry
as its plain files, unpacked once when it is saved or downloaded, and
a hit copies them out.

A hit hands each file to the kernel: `copy_file_range` on Linux, or a
clone where the filesystem supports one (APFS on macOS, Btrfs or XFS on
Linux). A clone shares the file's blocks until one side writes, so a
large output can restore without copying its bytes.

vx never hard-links an output to the store. A hard link would be faster
still, but the restored file and the cached one would be the same inode.
A build that later edits `dist/index.js` in place would then edit the
cache, and the next hit would replay the edit. A copy or a clone keeps
the cache's version as it was.

## Small entries stay in the index

A thousand tiny outputs as a thousand directories is more file system
work than the bytes are worth. So an entry of up to 32 KiB stays inside
the cache index (SQLite) as one compressed row. The bound is a setting:

```ts
// .vx/workspace.ts
import { defineWorkspace } from '@vzn/vx/config'

export default defineWorkspace({
  cache: { store: { embeddings: '64KiB' } }, // false keeps every entry as files
})
```

If disk matters more than speed, `decompress: false` keeps each larger
entry as one `tar.zst`, as in the table: smaller on disk for output that
compresses, and every restore decompresses it.

## A local hit checks nothing

The local store is vx's own directory: nothing else writes there. A
check of each file's size or bytes before a hit would guard against
nothing, and every save would have to read its outputs back to record
what the check compares. A local hit copies the stored files as they
are.

Anything that crosses a network is checked. A remote entry is a
`tar.zst` that ends with a CRC-32 over everything before it, checked
before the entry is used. A wrong sum is a miss, and the task runs.

## A download is decompressed once

A download of up to 4 MiB is fetched whole, decompressed once and
written straight into the store, where it is checked before anything
points at it. A larger one goes through a temp file, still decompressed
once.

Storage layout and settings: [Caching](../../caching/) and the
[schema](../../schema/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
