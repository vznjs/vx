---
title: 'Why vx is fast: five decisions, not a trick'
date: 2026-09-10T23:58:00Z
authors:
  - vzn
tags:
  - performance
  - internals
excerpt: 'With nothing changed, vx adds 757 ms to a 9,603-task run, with no daemon. That number is five structural decisions, and each one is also a correctness win.'
---

With nothing changed, vx adds **757 ms** to a 9,603-task run. No daemon
keeps it warm.

| Time added over the ideal run, 1,601 projects, 9,603 tasks | vx      | Turborepo | Nx         | Vite Task |
| ---------------------------------------------------------- | ------- | --------- | ---------- | --------- |
| Nothing changed                                            | 757 ms  | 761 ms    | 22.63 s    | 12.26 s   |
| Nothing changed, outputs restored                          | 1.27 s  | 1.76 s    | 22.16 s    | 11.66 s   |
| Cold build                                                 | 6.13 s  | 8.87 s    | 3 min 20 s | 7.94 s    |
| Cold build: CPU the runner burns                           | 30.06 s | 1 min 8 s | 5 min 45 s | 23.91 s   |

Synthetic monorepo, 30 dependency levels; build 300 ms, test and
typecheck 150 ms, lint 75 ms, publish 30 ms. Run 2026-10-20 on linux
x64, 4 cores: vx at `a88652b0b`, Turborepo 2.11.9, Nx 23.3.0, Vite Task
(vite-plus) 1.3.0, each in its own native config. Real repos with uneven
task times will differ. Source: [Benchmarks](../../benchmarks/).

The time comes from five decisions.

## 1. The key is already in git's index

A cache key needs a hash of every input file. Git already has one: the
blob id of every tracked file. vx asks git instead of reading files.

```
git ls-files -s -v                           min 2.3 ms   (20 runs)
git status --porcelain -uall                 min 5.6 ms   (10 runs)
read + xxh3 every tracked file yourself      min 154.1 ms (10 runs)
```

This repo: 2,527 tracked files, 48 MB. Linux x64, 4 cores, warm page
cache, 2026-10-23.

Clean-tree key derivation costs zero source-file reads. Only dirty
files are hashed, and they get the same blob id git would
give them. So committing a file never changes its key.
[Your cache key is already in git's index](../keys-from-git/) has the
details.

## 2. Bitsets, not walks

The scheduler starts the task with the most work below it first
(`most-work`, the default). Counting that work with a depth-first walk
over sets took 8.5 s of a 10 s warm run on a 1,090-package, 100-level
graph. Packed bitsets with popcount do it in single-digit milliseconds.

Then each tick is cheap: ready tasks sit in a binary heap, and a task
that finishes only decrements its direct dependents' counters.
[Bitsets and the scheduler](../bitsets-and-the-scheduler/).

## 3. vx knows what a hit leaves on disk

Declared outputs are wiped before a task runs, and a hit leaves exactly
the cached files. So vx knows the tree after either one. When each file
on disk still matches what it recorded (size, mode, millisecond mtime,
inode and ctime), a hit is a few `stat` calls: no
copy, no decompress, no write.

## 4. A hit is a file copy

The local cache keeps each entry as plain files, unpacked once. A hit
hands them to the kernel (`copy_file_range`, or a clone on APFS, Btrfs
or XFS). The `tar.zst` exists only on the wire to a remote. Metadata and
the captured stdout live in the index (the stdout in a side table), so
a hit replays its log with a SQL read.

```
restore 1,000 entries of 96 KiB    from tar.zst 1.26 s   →   plain files 0.76 s   (min of 5)
```

[A cache hit is a file copy](../a-hit-is-a-file-copy/).

## 5. Nothing runs that is not needed

- A run evaluates no config. It reads `.vx/projects.lock.json`.
- No telemetry plugin means no event subscriber, no summary, no `git`
  spawn.
- A plugin that declines a task costs nothing.

## How each number is kept

Every change to the warm path ships with a number: two arms
interleaved, min of N, the "before" arm in its own git worktree, each
arm on its own pre-warmed copy. A change without a number is not done.
The full list, each with its invariant and source file:
[Optimizations](../../optimizations/).

More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
