---
title: 'No daemon, on purpose'
date: 2026-09-10T23:51:00Z
authors:
  - vzn
tags:
  - design
  - performance
excerpt: "A daemon answers 'what changed' quickly by keeping a second copy of the truth. vx keeps no copy. Every run pays its own discovery and still wins the warm benchmarks, because the discovery was made cheap instead of being hidden."
---

With nothing changed, on 9,603 tasks:

| Runner    | Time added | Daemon                     |
| --------- | ---------- | -------------------------- |
| vx        | 720 ms     | none                       |
| Turborepo | 1.05 s     | not for `turbo run`        |
| Nx        | 26.21 s    | off, as in CI              |

Benchmark workload: a synthetic monorepo of 1,601 projects and 9,603 tasks in 30 dependency levels, five core libraries a quarter of the projects use; build 300 ms, test and typecheck 150 ms, lint 75 ms, publish 30 ms; real repos with uneven task times will differ.
Run 2026-10-23 on linux x64, 4 cores, concurrency 10: vx at commit 0be036747, Turborepo 2.11.10, Nx 24.0.1, Vite Task (vite-plus) 1.4.0.

Nx runs a daemon by default. Turborepo shipped one and, since 2.8.11,
no longer uses it for `turbo run`. A daemon watches the tree so a warm
run knows what changed without walking it. vx has none and won't grow
one.

## What a daemon costs

A daemon is a second copy of the truth. Its model of the tree is right
only while every change arrived as a filesystem event it processed. A
socket left by a crashed process, a branch switch, an event dropped on
a busy machine, a watcher that started after the edit: each turns a
fast answer into a wrong one. For a build cache, wrong means a stale
hit under a green check.

It also has to start, warm up, restart after an upgrade and hold memory
all session. The first run of the day pays a cold start either way.

## What replaced it

The question a daemon answers is "which files' hashes do I need to
recompute?" vx made the recomputation cheap enough that the question
stopped mattering:

- **The hashes are in git's index.** One `git ls-files -s` returns the
  file list and every clean file's blob id. A concurrent `git status`
  names the dirty ones. A clean tree of thousands of files is keyed with
  no read of a source file ([the details](../keys-from-git/)).
- **A run evaluates no config.** It reads the resolved objects from
  `.vx/projects.lock.json`, which `vx lock` writes.
- **The graph algorithms are bitsets**, so building priorities over
  3,270 tasks is milliseconds, not seconds.
- **A warm hit on a current tree is N stats and zero writes**, because
  [strict output ownership](../strict-output-ownership/) means vx knows
  what the tree should contain.

That is the 720 ms in the table, with no process left behind.

## The invariant, stated plainly

There is exactly one source of truth for what a task depends on: the
working tree as git sees it, read fresh on every run. There is no
staleness window because there is no second copy that could be stale.
`vx run` in a terminal, in CI, in a container, on a machine whose
watcher limits are exhausted, all take the same path and give the same
answer.

More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
