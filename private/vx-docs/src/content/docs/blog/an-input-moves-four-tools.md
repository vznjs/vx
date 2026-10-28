---
title: 'An input changes mid-run: what four task tools do'
date: 2026-10-13T20:30:00Z
authors:
  - vzn
tags:
  - caching
  - correctness
  - comparison
excerpt: 'A file changes while a task runs. Does the cache save the output anyway? We read the source of vx, Turborepo, Nx and Vite Task.'
---

You save a file while a build runs. The output may come from bytes the
cache key does not name. Here is what each tool does after the command
exits, read from its source.

| After the command exits      | Turborepo 2.11.7 | Nx 23.3.0         | Vite Task 1.1.0           | vx                         |
| ---------------------------- | ---------------- | ----------------- | ------------------------- | -------------------------- |
| Inputs looked at again       | no               | no (batch: rehash) | files the task opened     | every declared input       |
| Writes it notices            | none             | none              | the task's own            | any process's              |
| What it does on a change     | saves            | saves             | skips the save            | skips the save, names file |
| Can be relaxed per task      | n/a              | n/a               | n/a                       | `inputStability`           |

## Turborepo 2.11.7

It takes the hash before the run and saves the outputs under it.

Inputs are not checked again
([`save_outputs`](https://github.com/vercel/turborepo/blob/v2.11.7/crates/turborepo-run-cache/src/lib.rs)).

## Nx 23.3.0

It hashes in `processTask` and saves with `cache.put(task.hash, …)`.

In batch mode, a task that reads its dependencies' outputs is hashed
again ([`task-orchestrator.js`][nx-orchestrator], [`cache.js`][nx-cache]).

[nx-orchestrator]: https://unpkg.com/nx@23.3.0/dist/src/tasks-runner/task-orchestrator.js
[nx-cache]: https://unpkg.com/nx@23.3.0/dist/src/tasks-runner/cache.js

## Vite Task (vite-plus 1.1.0)

It traces the files a task opens. If the task wrote a file it also read,
it skips the save (`InputModified`).

Writes by other processes are not traced
([`cache_update.rs`](https://github.com/voidzero-dev/vite-task/blob/7d69d6577ecf6bd83deee32186de59918a712873/crates/vt/src/session/execute/cache_update.rs)).

## vx

```sh frame="terminal"
$ vx run packages/api#build
┌─ packages/api#build > $ echo "export const r = $RANDOM" > src/routes.gen.ts && mkdir -p out && cp src/index.ts out/
[vx] packages/api#build: `packages/api/src/routes.gen.ts` changed after its key was taken — the result stands, but is not saved under a key that no longer describes it; if the task writes it, declare it in cache.outputs
└─ packages/api#build ── (6ms) success
  cache     1 not saved
```

<small>One-project workspace · vx `c1ad075` · 2026-10-23</small>

vx checks every declared input after the run, whoever wrote it. A
changed input keeps the result and saves nothing, and tasks downstream
skip their save too.

`cache.inputStability` relaxes it per task
([how](../inputs-that-move/)).

## Each one is a trade

vx pays one `lstat` per input on a run that saves. Turborepo and Nx skip
that work. Vite Task checks what its tracer already saw. Which fits
depends on how often your inputs move during a run.

More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
