---
title: 'A run you can read'
date: 2026-10-09T00:50:00Z
authors:
  - vzn
tags:
  - dx
excerpt: 'One line per task while it runs, the full log only for what failed, and one summary block at the end. Nothing prints below it.'
---

Eight tasks in four projects, in parallel, one test failing:

```sh frame="terminal"
$ vx run build test --filter packages/a --filter packages/b --filter packages/c --filter packages/d --force
 ⏺︎    13ms success miss     packages/d#build
 ⏺︎    15ms success miss     packages/a#test
 ⏺︎    18ms success miss     packages/a#build
 ⏺︎    19ms success miss     packages/b#build
 ⏺︎    13ms success miss     packages/c#test
 ⏺︎    12ms success miss     packages/d#test
 ◼︎    10ms failed  miss     packages/b#test
 ⏺︎     7ms success miss     packages/c#build

┌─ packages/b#test > failed (exit 1)

$ bun test

├─ OUTPUT ──────────────────────────────────────────────────

src/sum.test.ts:
2 | test('adds', () => { expect(2 + 2).toBe(5) })
                                       ^
error: expect(received).toBe(expected)

Expected: 5
Received: 4
…
└─ packages/b#test ── (10ms) failed (exit 1)

─ vx 0.0.0 ───────────────────────────────────────────────────
  projects  ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱
            4 affected · 6 total
  tasks     ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
            1 failed · 7 success · 8 total
  cache     ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
            local 7↑ · 1 miss

  info      4 workers · local cache · run 01a16aea-85b2-75d4-bb1c-d5c8ae6dd898
  time      59ms · max 19ms · avg 13ms · min 7ms
```

Demo workspace, vx at `69617eb`, 2026-10-23. Three parts, each with one
job:

| Part              | Job                                                        |
| ----------------- | ---------------------------------------------------------- |
| a line per task   | glyph, time, outcome, whether the cache had it             |
| a frame per failure | the whole log and the command, no other task's output in it |
| one summary, last | the answer to "did it pass?", where your eyes land          |

`--output-logs full` gives every task its own frame, in the order tasks
finish. On CI the frames fold into log groups, and `vx last` replays
the summary later.

Fix the test and run again: four hits, four restores, 30 ms.

More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
