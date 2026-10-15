---
title: 'One name per setting'
date: 2026-10-14T04:30:00Z
authors:
  - vzn
tags:
  - config
  - dx
excerpt: 'Every vx setting has one path in .vx/workspace.ts, and its environment variable and flag are spelled from it. run.retries is VX_RUN_RETRIES and --retries. Learn one name and you know all three. A duration carries its unit, and vx info says where each value came from.'
---

A tool with forty knobs usually has three names for each one: a config
key, an environment variable that grew a `_MS` suffix, and a flag someone
shortened. vx gives every setting one path, and spells the other two
from it.

| Setting          | Variable             | Flag            |
| ---------------- | -------------------- | --------------- |
| `run.retries`    | `VX_RUN_RETRIES`     | `--retries`     |
| `run.concurrency` | `VX_RUN_CONCURRENCY` | `--concurrency` |
| `cache.dir`      | `VX_CACHE_DIR`       | `--cache-dir`   |
| `cache.scope`    | `VX_CACHE_SCOPE`     | `--cache-scope` |

The settings live in three groups in `.vx/workspace.ts`: `run`, `cache`
and `watch`.

```ts
// .vx/workspace.ts
import { defineWorkspace } from '@vzn/vx/config'

export default defineWorkspace({
  run: { concurrency: 4, retries: 2 },
  cache: { retention: { olderThan: '30d', maxSize: '10GB' } },
})
```

## Which value wins

A flag beats its variable, which beats the file, which beats the
built-in default. A task's own field beats all four: `exec.retries` on
a task is that task's count, whatever `--retries` says. `vx info` lists
every setting that is not at its default and where its value came from:

```sh frame="terminal"
$ VX_RUN_CONCURRENCY=2 vx info
…
  settings          run.concurrency 2 (VX_RUN_CONCURRENCY), run.retries 2 (.vx/workspace)
```

## Units are part of the value

A duration says its unit (`'500ms'`, `'30s'`, `'10m'`, `'2h'`, `'30d'`),
and a size says its own (`'10GB'`). A bare number is refused, because
nobody can tell whether `2000` means milliseconds or seconds:

```sh frame="terminal"
$ VX_CACHE_RETENTION_OLDER_THAN=2000 vx run build
✗ vx run  VX_CACHE_RETENTION_OLDER_THAN takes a duration with its unit, like '2000ms' or '2s' (got 2000)
```

(Since vx 0.0.639, the examples use other settings: the kill grace and
the teardown bound are no longer settings, fixed at 2 s and 3 s.)

## Old names stop working

The names from before vx 0.0.637 are gone, with no alias. An old key in
`.vx/workspace.ts` is an unknown field, and an old flag an unknown flag:

```sh frame="terminal"
$ vx run build
✗ vx run  config refused

  .vx/workspace.ts:4:3
  unknown field "concurrency"
  allowed: cache, lock, plugins, run, watch

    2 |
    3 | export default defineWorkspace({
  > 4 |   concurrency: 4,
      |   ^
```

An old variable such as `VX_TIMING` is no longer read; set
`VX_DEBUG_TIMING` instead.

A few settings are read before the workspace file loads, such as
`run.outputLogs` and `debug.timing`. Those are set only by a variable
or a flag, never in the file. Every setting, with its variable, flag, values and default, is in
the [settings table](../../schema/#settings).
