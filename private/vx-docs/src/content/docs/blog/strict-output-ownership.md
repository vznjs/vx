---
title: 'The tree is exactly the snapshot'
date: 2026-09-10T23:53:00Z
authors:
  - vzn
tags:
  - caching
  - correctness
excerpt: 'Turborepo and Nx restore outputs on top of whatever is already there. vx wipes the declared outputs before a miss and removes from a hit what its entry does not hold, so the tree after either is the cached snapshot and nothing else. Stale files cannot survive.'
---

A stray file in `dist/`, then a cache hit:

```sh frame="terminal"
$ echo "stale" > packages/a/dist/old.js
$ ls packages/a/dist
index.js  old.js

$ vx run packages/a#build
└─ packages/a#build ── (20ms) restored-local

$ ls packages/a/dist
index.js
```

After a hit, the declared outputs are **exactly** the cached snapshot.
No deleted module that keeps being served, no renamed asset with two
copies. Demo workspace, vx at `69617eb`, 2026-10-23.

## The rule

Every task with a `cache` block declares `outputs.files`. Those globs
are territory the task owns:

- **Before a miss executes**, the current matches are removed. A
  leftover `dist/old.js` can't be picked up by the new build's globs
  and cached as if it were produced now.
- **When a hit restores**, each cached file is renamed over the one it
  replaces, a file that already holds the cached bytes is left alone,
  a missing folder (a cleaned `dist/`) is moved in whole, and then
  every match the entry does not hold is removed. A reader never finds
  a file missing while it lands. The restore writes only what the
  globs declare: an entry holding anything else is dropped and the
  task runs.

## Two owners, refused

```sh frame="terminal"
$ vx lock
✗ vx lock  lock not written

  packages/a#notes and packages/a#slow both write out/** / out/copy.ts
  vx clears a task's outputs before it runs, so one deletes the other's

  fix  give each task its own output path
```

Two tasks whose output declarations provably overlap (equal literals,
or a literal another task's glob matches) are refused. Two globs that
only *might* overlap are let through, and the last restore wins. By default the refusal holds even when one task depends
on the other (`rules.exclusiveOutputs` in `.vx/workspace.ts`). Set it to
`false` and vx accepts the ordered overlap: the second task runs after
the first and adds to the tree (twenty's `build:individual` writing
`dist/individual` into `build`'s `dist`), and vx caches exactly what it
added, never the files it found there. It is correct, only slower, so
the better fix is giving each task its own output path.

## Why it is also the fast path

Owning the outputs is what makes the warm-on-warm case cheap. Because
vx knows the tree after any hit is the snapshot, it records a
fingerprint per output file `(size, mode, mtime-ms, inode, ctime)` alongside the
entry. On the next hit it checks two things:

1. **The set.** The files under the output globs must be exactly the
   recorded set, no more, no fewer.
2. **The files.** Every recorded fingerprint must match the file on
   disk.

If both hold, the restore is N stats and zero writes, zero
decompression. That is the "current tree" short-circuit, and it is the
no-op row in the [benchmarks](../../benchmarks/): every task a hit over
an intact tree. Their restore row deletes the outputs first, so every
artifact is extracted, and it costs more. A tool that merges cannot
skip that work when nothing is gone; it does not know what "current"
means for a directory it only ever adds to.

## What the wipe never touches

- Files outside the declared globs. A task that writes somewhere it did
  not declare is a bug the [sandbox](../the-sandbox/) can catch, but
  the wipe itself is bounded by the declaration.
- Another project's directory. Boundaries are hard.
- The project root's `.git`, `.vx` and `vx.lock.json`, whatever the
  glob says. Only there: a build's own `dist/.git` is its output.
- A file git tracks. A committed file under an
  output glob is still saved and restored, but the wipe never deletes it.
- `node_modules`, unless a glob names it. `**/*.js` leaves installed
  files alone; `node_modules/**` is a legitimate output of an install
  task.

A task with no `cache` block declares no outputs and owns nothing. It
runs every time and vx does not touch its tree.

## What you feel

`git status` after a hit is clean the way you expect. And the build
that would have shipped a deleted file never happens. A stale hit is
the worst failure a cache can have; strict ownership is the cheapest
rule that removes one whole species of it.

More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
