---
title: 'The tree is exactly the snapshot'
date: 2026-09-10T23:53:00Z
authors:
  - vzn
tags:
  - caching
  - correctness
excerpt: 'Turborepo and Nx restore outputs on top of whatever is already there. vx wipes the declared outputs first, on a miss and on a hit, so the tree after either is the cached snapshot and nothing else. Stale files cannot survive.'
---

Ask a monorepo tool what `dist/` contains after a cache hit and the
honest answer from most of them is "the cached files, plus whatever was
already there." That "plus" is the source of an entire genre of bugs:
the deleted module that keeps being served, the renamed asset with two
copies, the test fixture from a branch you checked out last week.

vx's answer is shorter. The declared outputs are **exactly** the cached
snapshot.

## The rule

Every task with a `cache` block declares `outputs.files`. vx treats
those globs as territory the task owns:

- **Before a miss executes**, the current matches are removed. A
  leftover `dist/old.js` from a previous build cannot be picked up by
  the new build's globs and cached as if it were produced now.
- **Before a hit restores**, the current matches are removed. The
  post-restore tree is the snapshot, not the snapshot merged with the
  present.

Outputs are a task's territory in the other direction too: two tasks
whose output declarations provably overlap (equal literals, or a
literal that another task's glob matches) are refused when the graph
is built, because a restore of one would delete the other's work. Two
globs that only *might* overlap are let through, and there the last
restore wins.

## Why it is also the fast path

Owning the outputs is what makes the warm-on-warm case cheap. Because
vx knows the tree after any hit is the snapshot, it records a
fingerprint per output file `(size, mode, mtime-ms)` alongside the
entry. On the next hit it checks two things:

1. **The set.** The files under the output globs must be exactly the
   recorded set, no more, no fewer.
2. **The files.** Every recorded fingerprint must match the file on
   disk.

If both hold, the restore is N stats and zero writes, zero
decompression. That is the "current tree" short-circuit, and it is why
the restore row and the no-op row in the
[benchmarks](../../benchmarks/) are within a few milliseconds of each
other. A tool that merges cannot do this; it does not know what "current"
means for a directory it only ever adds to.

## What the wipe never touches

- Files outside the declared globs. A task that writes somewhere it did
  not declare is a bug the [sandbox](../the-sandbox/) can catch, but
  the wipe itself is bounded by the declaration.
- Another project's directory. Boundaries are hard.
- The `.vx` cache directory and `.git`.

A task with no `cache` block declares no outputs and owns nothing. It
runs every time and vx does not touch its tree.

## The consequences you feel

The one you notice first: `git status` after a hit is clean in the way
you expect, because the restore did not leave a merged pile behind. The
one you notice never: the build that would have shipped a deleted file.
Cache correctness is the worst failure class this tool can have, a
stale hit replays wrong bytes under a green check, and strict ownership
is the cheapest rule that removes one whole species of it.
