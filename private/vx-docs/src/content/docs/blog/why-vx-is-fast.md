---
title: 'Why vx is fast: five decisions, not a trick'
date: 2026-09-10T23:58:00Z
authors:
  - vzn
tags:
  - performance
  - internals
excerpt: 'What vx adds to a run with nothing changed, with no daemon, and the five design choices behind that number.'
---

With nothing changed, vx adds **%bench.vx.warm%** to a %bench.tasks%-task run. No daemon
keeps it warm.

| Time added over the ideal run, %bench.projects% projects, %bench.tasks% tasks | vx | Turborepo | Nx | Vite Task |
| --- | --- | --- | --- | --- |
| Nothing changed | %bench.vx.warm% | %bench.turbo.warm% | %bench.nx.warm% | %bench.vt.warm% |
| Nothing changed, outputs restored | %bench.vx.restore% | %bench.turbo.restore% | %bench.nx.restore% | %bench.vt.restore% |
| Cold build | %bench.vx.cold% | %bench.turbo.cold% | %bench.nx.cold% | %bench.vt.cold% |
| Cold build: CPU the runner burns | %bench.vx.cpu% | %bench.turbo.cpu% | %bench.nx.cpu% | %bench.vt.cpu% |

<small>Synthetic monorepo, %bench.projects% projects, %bench.levels% levels · concurrency %bench.concurrency%, native configs · [benchmarks](../../benchmarks/)</small>

<small>%bench.provenance%</small>

Five design choices make that number. Each one also makes the cache
harder to get wrong.

## 1. Git already hashed your files

```mermaid
xychart-beta horizontal
  title "Hash 2,527 tracked files (ms, min of runs)"
  x-axis ["git ls-files", "git status", "read + hash every file"]
  y-axis "ms" 0 --> 160
  bar [2.3, 5.6, 154.1]
```

<small>This repo, 48 MB · linux x64, 4 cores, warm page cache · 2026-10-23</small>

Git keeps a hash of every tracked file. vx asks git instead of reading
them. Clean-tree key derivation costs zero source-file reads.

A dirty file gets the same hash git would give it, so a commit never
changes a key ([how](../keys-from-git/)).

## 2. The scheduler counts with bitsets

vx starts the task with the most work below it first. Counting that with
a graph walk took 8.5 s of a 10 s run on a 1,090-package graph.

Bitsets do it in milliseconds ([how](../bitsets-and-the-scheduler/)).

## 3. A hit on an up-to-date tree is a few stat calls

```mermaid
flowchart LR
  H[cache hit] --> S{files on disk match the record?}
  S -->|yes| D[done: no copy, no write]
  S -->|no| C[copy the cached files]
```

vx wipes outputs before a task runs, so it knows what a hit leaves on
disk. If each file still matches (size, mode, millisecond mtime, inode
and ctime), there is nothing to restore.

## 4. A hit is a file copy

```mermaid
xychart-beta horizontal
  title "Restore 1,000 entries of 96 KiB (s, min of 5)"
  x-axis ["from tar.zst", "plain files"]
  y-axis "s" 0 --> 1.4
  bar [1.26, 0.76]
```

The local cache stores plain files and the kernel copies them.

Metadata and the captured stdout live in the index (the stdout in a side
table), so the log comes back with one SQL read
([how](../a-hit-is-a-file-copy/)).

## 5. Nothing runs that is not needed

A run reads `.vx/projects.lock.json` and evaluates no config. No
telemetry plugin means no listener and no `git` spawn. A plugin that
skips a task costs nothing.

Every change to this path ships with a measured before and after
([Optimizations](../../optimizations/)). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
