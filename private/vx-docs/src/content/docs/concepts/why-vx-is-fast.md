---
title: Why vx is fast
description: The engineering behind vx's speed and its correctness guarantees — git-OID hashing, bitset scheduling, strict output ownership, and a daemonless design — with measured numbers.
---

vx is fast because of a few design choices, listed here. Every choice
with its source is in [Optimizations](../../optimizations/), and the raw
numbers are in [Benchmarks](../../benchmarks/).

## The numbers

Each number below comes from a command you can run yourself.

- **Runner overhead** is the time a runner adds on top of the ideal run.
  It is the number to read first.

  On the synthetic %bench.tasks%-task workspace, with nothing changed: vx
  adds %bench.vx.warm%, Turborepo %bench.turbo.warm%, Vite Task
  %bench.vt.warm% and Nx %bench.nx.warm%.

  On a cold build over its %bench.ideal.cold% ideal schedule: vx adds
  %bench.vx.cold%, Turborepo %bench.turbo.cold%, Nx %bench.nx.cold% and
  Vite Task %bench.vt.cold%.

  The workload: %bench.projects% projects in %bench.levels% dependency
  levels.

  Build %bench.task.build%, test and typecheck %bench.task.test%, lint
  %bench.task.lint%, publish %bench.task.publish%. %bench.provenance%

- **vx alone.** With nothing changed, the whole vx process on that
  %bench.projects%-project workspace takes %bench.vx.warm%. With every
  output deleted first, it restores them all in %bench.vx.restore%.

- **Head to head.** One generated workspace (%bench.projects% projects,
  %bench.tasks% tasks) runs under each tool: cold, with nothing changed,
  and with outputs restored. The latest run is on
  [Benchmarks](../../benchmarks/).

## What others don't have

Each of these makes the cache both safer and faster.

1. **Sparse `^task` bridging.** `^build` walks through packages that
   don't declare `build` to the nearest one that does. You write no
   filler tasks, and the graph holds no placeholder nodes.
2. **Resolved-config hashing.** The key sees the evaluated
   `vx.config.ts` object. Imports, presets and computed values all count.
3. **Strict output ownership.** vx wipes declared outputs before a task
   runs. A restore removes files the entry does not hold, so no stale
   file survives.

   Overlapping outputs are refused (`rules.exclusiveOutputs`). Turborepo
   and Nx restore on top of what is there.
4. **No daemon.** No background process, no stale state, no socket to
   break. The head-to-head shows what that costs on a cached run.

## The mechanics under the hood

- **Hashes come from git's index.** One `git ls-files -s` lists the
  tracked files and every clean file's blob ID. A `git status` beside it
  finds edited and untracked files.

  Clean-tree key derivation costs zero source-file reads, stats or
  database lookups. An edited file gets the same blob ID, computed in
  process, so a commit never changes a key.
- **Bitset graph algorithms.** Scheduler priority uses packed bitsets
  instead of set unions. On a 3,270-task graph, 8.5 s became a few
  milliseconds.
- **A scheduler that never re-scans.** Ready tasks come off a heap,
  most-blocked first. A finished task updates only its direct dependents.
- **Restores that check first.** A restore over outputs already in place
  is one stat per file: no writes, no decompression.
- **One artifact format.** The local and remote caches move the same
  `tar.zst` bytes, so nothing is repacked between them.
- **Small things add up:** in-process tar, atomic writes, one SQL
  transaction per save, hardened xxh3 keys.

## What vx leaves out on purpose

- **No daemon.** The cold numbers show it isn't needed.
- **No config evaluation in a run.** A run reads the resolved configs from
  `.vx/projects.lock`. Only `vx lock` evaluates them.
- **No traced inputs.** A trace shows what a task read once, on one
  machine, and only after it ran. The key is needed before.

  You declare inputs instead. A task with `exec.sandbox` reads only what
  `allow.read` grants inside the workspace, so the sandbox checks your
  list ([Sandboxing](../../docs/sandboxing/)).

## See where the time goes

`VX_DEBUG_TIMING=1` prints each stage of a run on stderr. A cached
one-task run on a 4-core Linux container:

```ansi
$ VX_DEBUG_TIMING=1 vx run app#build
[1m[38;2;6;182;212m[vx timing][0m[2m  stage                    own   cumulative[0m
[2m             startup                 48.7ms      48.7ms[0m
[2m             workspace config         5.5ms      54.2ms[0m
[2m             discover projects        2.7ms      57.0ms[0m
[2m             open cache               5.6ms      62.8ms[0m
[2m             load configs             1.1ms      63.8ms[0m
[2m             build graph              3.4ms      67.2ms[0m
[2m             git enumeration         10.1ms      77.3ms[0m
[2m             classify + probe         8.6ms      86.5ms[0m
[2m             run graph                4.8ms      91.5ms[0m
[2m             record history           2.7ms      94.2ms[0m
[2m             close                    3.9ms      98.5ms[0m
```

Rows under 1 ms are cut. The full table is on
[Timing](../../modules/util/#srcutiltimingts--vx_debug_timing-stage-table).

## Go deeper

- **[Optimizations](../../optimizations/)**: every choice, with its source.
- **[Benchmarks](../../benchmarks/)**: method and full results.
- **[vx vs Turborepo vs Nx](../../comparison/)**: feature by feature.
