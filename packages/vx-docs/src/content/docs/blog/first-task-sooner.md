---
title: 'The first task starts sooner on a cold run'
date: 2026-10-09T17:30:00Z
authors:
  - vzn
tags:
  - performance
  - caching
excerpt: 'On a cold run every cache lookup misses, so vx no longer asks. The first task of a 1,090-package build now starts in about 230 ms, down from about 380 ms earlier the same day.'
---

The time before the first task starts is the part of a run you wait
through with nothing happening. On a fresh checkout with an empty
cache, vx used to spend part of it on work that could not pay off.

## Asking a cache that holds nothing

Before a run starts, vx works out every task's cache key and looks each
one up, so it knows up front which tasks will be restored and which will
run. On a warm cache that is what makes a fully cached run fast.

On an empty cache, every one of those lookups misses. Now vx checks
first whether the local cache holds anything at all. If it holds
nothing, it skips the up-front pass, and each task works out its own
key as it starts, the same way a run against a remote cache already
does. The keys are the same either way, so nothing about what is cached
or restored changes.

## The numbers

Time from `vx run` to the first task starting, cold, with `--frozen`,
on the synthetic 1,090-package benchmark:

- Earlier the same day: about 380 ms.
- After a lock that `vx lock` wrote stopped being re-checked on every
  cold run (#3378): about 330 ms.
- After skipping the lookups on an empty cache (#3382): 225 to 232 ms.

Turborepo 2.11 takes 276 ms on the same graph, so vx now starts its
first task about 20% sooner. The whole cold build takes as long as
before: the saving is at the start, where you notice it, not a faster
build overall.

Benchmark workload: a synthetic monorepo of 1,090 packages and 3,270
tasks with equal task durations and deep dependency chains, best of
several runs. Run 2026-10-09 on linux x64, 4 cores: vx from source at
`main` (63e6e0f), Turborepo 2.11.7. Real repos will differ; see
[vx on real repos](https://vznjs.github.io/vx/compare/real-repos/).

## Nothing to turn on

This is how every cold run works from vx 0.0.634. Try it in your repo:

```sh
npm install -D @vzn/vx
npx vx init
npx vx run build --all
```

More on vx at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
