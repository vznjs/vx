---
title: 'An input changes mid-run: what four task tools do'
date: 2026-10-13T20:30:00Z
authors:
  - vzn
tags:
  - caching
  - correctness
  - comparison
excerpt: 'A task reads src/a.ts, and while it runs, something writes src/a.ts. Which cache entry gets saved? We read the source of vx, Turborepo, Nx and Vite Task to find out. Each made a different trade.'
---

A cache key describes a task's inputs at one moment. If an input changes
while the command runs, the output may have been built from bytes the key
does not describe. Save it under that key and a later hit restores an
output that matches neither version of the file.

It happens more than it sounds: you save a file while a build runs, a
code generator in another task rewrites a shared file, or a tool rewrites
its own config. We read each tool's source, at the version named, to see
what it does after the command exits.

## Turborepo 2.11.7

Turborepo computes the task hash before the task runs. After a
successful run, `save_outputs` globs the declared outputs and stores them
under that same hash. It does not look at the inputs again.
Source: [`crates/turborepo-run-cache/src/lib.rs`](https://github.com/vercel/turborepo/blob/v2.11.7/crates/turborepo-run-cache/src/lib.rs),
`save_outputs`.

## Nx 23.3.0

Nx hashes a task in `processTask` before it is scheduled, and after the
run `postRunSteps` calls `cache.put(task.hash, …)` with that hash. It
does not compare inputs before and after. In batch mode, a task whose
inputs include its dependencies' outputs is hashed again after it runs,
against the files as they are then.
Source: `nx@23.3.0`,
[`dist/src/tasks-runner/task-orchestrator.js`](https://unpkg.com/nx@23.3.0/dist/src/tasks-runner/task-orchestrator.js)
(`processTask`, `postRunSteps`) and
[`cache.js`](https://unpkg.com/nx@23.3.0/dist/src/tasks-runner/cache.js) (`put`).

## Vite Task (vite-plus 1.1.0)

Vite Task traces the files a task opens (its `fspy` tracer) and checks
them after the run. If the task wrote a file it also read, the entry is
not saved and the reason is `InputModified`. The check covers reads the
tracer saw from the task's own processes, not the globbed inputs; its
comment notes that a task writing a globbed file it never read gets
repeated misses rather than a wrong entry.
Source: vite-plus 1.1.0 pins vite-task at
[`7d69d65`](https://github.com/voidzero-dev/vite-task/blob/7d69d6577ecf6bd83deee32186de59918a712873/crates/vt/src/session/execute/cache_update.rs),
`crates/vt/src/session/execute/cache_update.rs`.

## vx

vx takes the key just before the command and, after it exits, checks
every declared input once, whoever wrote it: the task, your editor, or
another task. Any file written after its digest was learned counts as
moved, even if its bytes are back to the original, because an edit
that was undone mid-run cannot be told apart from no edit at all. A
moved input keeps the run's result, saves no entry, and names the file;
every task downstream skips its save too.

A task that rewrites a file it also reads:

```sh frame="terminal"
$ vx run packages/api#build
┌─ packages/api#build > $ echo "export const r = $RANDOM" > src/routes.gen.ts && mkdir -p out && cp src/index.ts out/
[vx] packages/api#build: `packages/api/src/routes.gen.ts` changed after its key was taken — the result stands, but is not saved under a key that no longer describes it; if the task writes it, declare it in cache.outputs
└─ packages/api#build ── (6ms) success
  cache     1 not saved
```

One-project workspace, vx at `c1ad075`, 2026-10-23.

How strict this is, is yours to choose with `cache.inputStability`:
`'mutable'` saves when the bytes end identical (for a tool that rewrites
its own `package.json`), `'unchecked'` turns the check off, and
`severity: 'error'` fails the task instead of warning.
Source: `packages/vx/src/orchestrator/execute-task.ts`; the full story is
in [When an input moves mid-run](../inputs-that-move/).

## Side by side

| After the command exits      | Turborepo 2.11.7 | Nx 23.3.0         | Vite Task 1.1.0           | vx                         |
| ---------------------------- | ---------------- | ----------------- | ------------------------- | -------------------------- |
| Inputs looked at again       | no               | no (batch: rehash) | files the task opened     | every declared input       |
| Writes it notices            | none             | none              | the task's own            | any process's              |
| What it does on a change     | saves            | saves             | skips the save            | skips the save, names file |
| Can be relaxed per task      | n/a              | n/a               | n/a                       | `inputStability`           |

## The trade

Checking costs something. vx pays one `lstat` per input after a run that
saves, and a task that touches its own inputs rebuilds next time unless
you tell vx how to judge it. Turborepo and Nx skip that work. Vite Task
checks what its tracer already recorded. None of these is free, and
which trade fits depends on how often your inputs move under a running
task.

We chose to make a cache entry mean exactly what its declared inputs say,
and to make the strictness a setting. vx is at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
