---
title: 'No daemon, on purpose'
date: 2026-09-10
authors:
  - vzn
tags:
  - design
  - performance
excerpt: "A daemon answers 'what changed' quickly by keeping a second copy of the truth. vx keeps no copy. Every run pays its own discovery and still wins the warm benchmarks, because the discovery was made cheap instead of being hidden."
---

Nx runs a daemon by default. Turborepo shipped one and, as of 2.10, is
deprecating it. Both exist for the same reason: a warm run needs to
know what changed since the last one, and walking the filesystem to
find out is slow. So a background process watches the tree and keeps
the answer ready.

vx has no daemon and will not grow one. Here is the reasoning, and
what replaced it.

## What a daemon costs

A daemon is a second copy of the truth. It holds a model of the tree
that is correct exactly as long as every change went through a
filesystem event it received and processed. The failure modes are
familiar to anyone who has typed `nx reset`: a socket left behind by a
crashed process, a stale graph after a branch switch, an event dropped
on a busy machine, a watcher that started after the edit. Each one
turns a fast answer into a wrong one, and "wrong" for a build cache
means a stale hit under a green check.

It also costs the thing it is meant to save. A daemon must be started,
must warm up, must be restarted after an upgrade, and holds memory for
the whole session. The first run of the day pays a cold start either
way.

## What replaced it

The question a daemon answers is "which files' hashes do I need to
recompute?" vx made the recomputation cheap enough that the question
stopped mattering:

- **The hashes are in git's index.** One `git ls-files -s` returns the
  file list and every clean file's blob id. A concurrent `git status`
  names the dirty ones. A clean tree of thousands of files is keyed with
  no file reads at all ([the details](../keys-from-git/)).
- **Config evaluation is cached where it is provably safe**, keyed by
  the git blob ids of the import closure, and evaluated live where it
  is not.
- **The graph algorithms are bitsets**, so building priorities over
  3,270 tasks is tens of milliseconds, not seconds.
- **A warm hit on a current tree is N stats and zero writes**, because
  [strict output ownership](../strict-output-ownership/) means vx knows
  what the tree should contain.

The result is a fully cached run of 3,270 tasks in about 510 ms with
no process left behind, against Turborepo's 760 ms and Nx's 3.59 s.
On solidjs/solid, Turbo measured with
`--no-daemon` so both tools pay discovery, vx's no-op run is 51 ms to
Turbo's 95. Turbo's daemon would close part of that gap. vx has nothing
to turn on.

## The invariant, stated plainly

There is exactly one source of truth for what a task depends on: the
working tree as git sees it, read fresh on every run. There is no
staleness window because there is no second copy that could be stale.
`vx run` in a terminal, in CI, in a container, on a machine whose
watcher limits are exhausted, all take the same path and give the same
answer.

That is worth more than a daemon's best case, and it costs less than a
daemon's average case.
