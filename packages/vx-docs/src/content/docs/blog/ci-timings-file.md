---
title: "Carry the scheduler's memory between CI runners"
date: 2026-10-09T18:00:00Z
authors:
  - vzn
tags:
  - performance
  - ci
excerpt: 'A fresh CI runner has no run history, so the history scheduler guessed. Now one JSON file carries the learned times from runner to runner.'
---

`@vzn/vx-schedule-history` starts the longest chain first, using task
times from past runs. A fresh CI runner has no past runs, so the first
run on every runner fell back to a guess.

## One file

```ts
// vx.workspace.ts
import { scheduleHistoryPlugin } from '@vzn/vx-schedule-history'

export default {
  plugins: [scheduleHistoryPlugin({ file: '.vx-timings.json' })],
}
```

vx reads the file before it orders the run and rewrites it after, with
each task's median time:

```json
{
  "version": 1,
  "tasks": {
    "app#build": 41200,
    "app#test": 18350,
    "docs#build": 29010
  }
}
```

Cache that one file in CI and the next runner starts with the times the
last one learned:

```yaml
- uses: actions/cache@v4
  with:
    path: .vx-timings.json
    key: vx-timings-${{ github.run_id }}
    restore-keys: vx-timings-
```

| Source of a task's time | Wins over |
| --- | --- |
| Runs on this machine | the file and `assume` |
| The file | `assume` |
| `assume` | nothing |

## What it saves

A graph where order matters: eight packages whose `build`, `check` and
`pack` chain unlocks more work (0.5 s each), and three slow `e2e` tasks
(10 s each) that nothing depends on. Every task runs; only the order
changes.

| Runner | Wall time (min of 3) |
| --- | --- |
| Cold, no file | 12.09 s |
| Cold, with the file | 10.68 s |
| Full local history | 10.64 s |

With no times, the slow tasks start last. The file starts them first,
cutting 12% off the wall time and matching a machine with its full
history. The lower bound here is 10.5 s.

Setup: linux x64, 4 cores, 4 workers, `sleep` tasks, vx 0.0.634. Run it
yourself with `bun packages/vx-bench/timings-file-bench.ts`.

When one task is the whole wall time, order cannot help. vx's own CI job
is like that: one 194 s test suite set its time with and without the
file (194.07 s and 194.60 s).

A run that executed nothing and restored only tasks the file already
times leaves the file alone, so an all-cached CI run pays no extra history
read. Runs that use no history plugin do no extra work.
