---
title: 'Where a task run spends its time'
date: 2026-10-14T01:30:00Z
authors:
  - vzn
tags:
  - performance
  - correctness
  - comparison
excerpt: 'We traced one workspace through vx, Turborepo 2.11.8 and Nx 23.3.0, step by step, cold and warm. Most of a run is the tasks themselves. The rest is a list of choices, and some of vx''s extra work is there on purpose.'
---

A task tool does the same few things on every run: find the projects,
build a graph, hash inputs, decide hit or miss, run or restore, record
what happened. We traced each step in vx, Turborepo and Nx on one
workspace to see where the time goes, and where vx does work the others
skip.

## Setup

The synthetic bench workspace: 1,601 projects, 8,002 tasks to run
(9,603 graph nodes), 4 cores, concurrency 10, `CI=1`, local cache only,
Linux container. Turborepo 2.11.8 with `--profile` traces; vx built from
`9388bad8f` with `VX_DEBUG_TIMING=1`; Nx 23.3.0 with `nx:run-commands`
targets, daemon off as CI runs it, `.env` loading off. Measured
2026-10-13 and 2026-10-14. These are raw figures from one machine;
the method and the scripts are on [Benchmarks](../../benchmarks/).

| Run                          | vx                 | Turborepo 2.11.8 |
| ---------------------------- | ------------------ | ---------------- |
| Cold                         | 120.2 s            | 127.3 s          |
| Warm                         | 892 ms             | 2,496 ms first, 909 ms second |
| One source file changed      | 100.1 s (6,607 run) | 105.8 s (6,607 run) |
| That edit reverted           | 3.6 s (1,321 tasks restored, the rest left in place) | 5.2 s (all 8,002 replayed) |

## A cold run is the tasks

On a cold run both tools spend about 97% of the wall time waiting on
the commands they started. What the tool adds per task is small. We
timed the bare commands in a shell (build 312 ms, lint 78 ms) and the
same commands under vx: 314 ms and 78.4 ms. Spawn, environment and
output capture come to about 0.4 ms a task. Turborepo's trace shows
about the same for its spawn.

Before the first task starts, vx spends about 640 ms finding projects,
building the graph and listing files from git; Turborepo's precompute
is about 0.7 s.

## Where vx does extra work

Some of vx's per-task cost is checks the others do not make:

- **Graph rules**: two tasks writing one output, or a task reading
  another's output without an edge, are refused. `vx lock` checks them
  once, so a run reads the lock and pays nothing for them.
- **Input recheck**, 0.2 ms per miss: after a task exits, vx checks
  that its inputs did not move while it ran, and skips the save if one
  did ([what four tools do](../an-input-moves-four-tools/)).
- **Output clean**, 0.15 ms per miss: declared outputs are cleared
  before a task runs, so a stale file cannot ride along into the cache.
- **Save before dependents**, about 4.3 ms per build task: the save
  already runs off the task's slot, in a save lane, but the task's
  dependents wait for it to land, so they cannot rewrite the outputs
  while they are archived. On this graph that wait costs at most about
  0.14 s of a 120 s run.
- **Remote upload at the end**: uploads to a remote cache run in the
  background, a bounded number at once. Neither the task nor its
  dependents wait for one; the end of the run does, so every upload
  finishes before vx exits.
- **Blob-size check** on a cold cache: once per git index, vx confirms
  that the blob IDs it reads from git match the files on disk, about
  330 ms. After that it is remembered.

Each of these is a correctness guard. We measured them and kept them.

## A warm run is deciding not to work

When every task hits, the commands never run and the tool's own steps
are the whole run.

| Step                   | vx                                          | Turborepo 2.11.8                         |
| ---------------------- | ------------------------------------------- | ---------------------------------------- |
| Projects and graph     | discover, then graph with rules             | precompute                               |
| File hashes            | git's own index (63 ms)                     | git index, then per-package file hashes  |
| Keys                   | one per task                                | one per task                             |
| On a hit               | checks each task's outputs on disk; restores a task's outputs only if one differs | restores every output and log |

The last row is the difference. Turborepo restores outputs on every hit
unless an output watcher, which runs in its daemon, reports them
unchanged; with no daemon, every hit rewrites its outputs.
Source:
[`crates/turborepo-run-cache/src/lib.rs`](https://github.com/vercel/turborepo/blob/v2.11.8/crates/turborepo-run-cache/src/lib.rs),
`restore_outputs`. In vx, if every output of a task still matches what
vx saved (size, mode, modification time, and the inode and change time
it recorded), the task's outputs are left alone; otherwise that task's
outputs are restored.

## Nx 23.3.0, warm

Nx's warm run on the same workspace took 21 to 24 s, all 9,603 tasks
hit. A CPU profile of the main process shows where:

| Self time | Where                                                                  |
| --------- | ---------------------------------------------------------------------- |
| 6.10 s    | `hashTasksUpfront`: hands each task's environment to the native hasher |
| 5.55 s    | garbage collection                                                     |
| 3.03 s    | `getTaskSpecificEnv`: copies `process.env` for each task               |
| 2.89 s    | `copyFilesFromCache`: writes every cached output back                  |
| 1.56 s    | `plan`, the native planner                                             |

`getTaskSpecificEnv` starts with `{ ...process.env }` for every task,
whether or not `.env` loading is on, so the cost grows with the size of
the environment; this runner had 173 variables. Source: `nx@23.3.0`,
`dist/src/tasks-runner/task-env.js` (`getTaskSpecificEnv`) and
`dist/src/tasks-runner/cache.js` (`copyFilesFromCache`). We gave Nx the
settings that helped it: `run-commands` targets (no process fork per
task), daemon off (on was slower here), `.env` loading off.

## What a change invalidates

Speed on a hit matters less than hitting when you should.

| Change                         | vx         | Turborepo 2.11.8 |
| ------------------------------ | ---------- | ---------------- |
| Unrelated env var set          | all hit    | all hit          |
| Root `package.json` edited     | all hit    | all 8,002 miss   |
| One project's `package.json`   | 6,607 miss | 6,607 miss       |
| `bun.lock` added               | all miss   | all miss         |

In our run, an edit to the root `package.json` changed every Turborepo
task's hash; vx sees root dependencies through the lockfile. A lockfile plugin such as
`bun()` narrows the last row to the projects whose dependencies moved.

## What we checked and dropped

The trace also pointed at vx. We checked three candidates before
calling anything waste. The output check on hits looked like 655 ms;
measured alone it is 10.8 ms over 1,600 hits, and the larger figure was
ten overlapping workers summed. When something outside vx rewrites a task's
outputs with identical bytes, vx restores that task's outputs anyway,
because the recorded times no longer match. That is real, but fixing it means a content
hash on every save, which costs more than it saves. The wait for the
save before dependents start is the 0.14 s above. None became a patch.

Run it yourself: the bench and its scripts are in the repository, and
vx is at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
