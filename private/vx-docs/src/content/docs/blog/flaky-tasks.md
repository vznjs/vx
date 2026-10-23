---
title: 'Flaky is a claim only declared inputs can back'
date: 2026-09-10T23:33:00Z
authors:
  - vzn
tags:
  - dx
  - caching
excerpt: "vx names a task flaky only when its exact cache key failed after it had passed, or it needed a retry this run. A failure on inputs that never passed is a break, not a flake. No service, no upload: the local run history is enough."
---

This task fails, then passes, then fails, on the same inputs:

```ts
flip: {
  exec: { command: 'bun flip.ts' },   // fails when a marker is absent, passes and removes it when present
  inputs: { files: ['flip.ts'] },
  cache: { outputs: { files: [] } },
}
```

```sh frame="terminal"
$ vx run packages/a#flip
└─ packages/a#flip ── (10ms) failed (exit 1)
$ vx run packages/a#flip
└─ packages/a#flip ── (11ms) success
$ vx run packages/a#flip --force
└─ packages/a#flip ── (12ms) failed (exit 1) flaky - passed 1× before
$ vx run packages/a#flip --force
└─ packages/a#flip ── (11ms) success flaky - failed 2× before
```

The first failure is not flaky: that key had never passed. The second
failure is, because the same key passed before it. Linux x64, vx at
`69617eb`, 2026-10-23, local run history only.

## The definition

A task is **flaky** when one of two things is on record:

- its exact cache key **failed after it had passed**, this run
  included (a key's first cache hit counts as a pass; later hits replay
  it), or
- it needed a **retry** this run (`exec.retries` or `--retries`) and then
  passed.

| Record                              | Verdict          |
| ----------------------------------- | ---------------- |
| key failed, never passed            | a break          |
| key passed after only failures      | a recovery       |
| key failed after it passed          | flaky            |
| passed on a retry                   | flaky            |
| task has no `cache` block           | not judged       |

Without declared inputs, two runs are not the same inputs, so the claim
can't be made.

A retry shows the same way:

```sh frame="terminal"
$ vx run packages/a#e2e          # exec.retries: 1
timeout talking to db
vx: retrying packages/a#e2e (attempt 2/2) after exit 1
pass
└─ packages/a#e2e ── (17ms) success flaky - 2 attempts
```

## What you see

In the run's task list the note rides the task's row:

```
 ◼︎   4.21s failed  miss     app#test flaky - passed 3× before
 ⏺︎  12.84s success miss     api#e2e flaky - failed 1× before · 2 attempts
```

`vx info` keeps the standing list. `vx last --stats --format json`
gives each task a `failureMode`:

```json
{"taskId":"packages/a#flip","runs":4,"successRate":0.5,"failureMode":"flaky-fatal"}
{"taskId":"packages/a#e2e","runs":1,"successRate":1,"failureMode":"flaky-recoverable"}
```

## Why it is free

Every cache entry already records its key, outcome and run. "Has this
key had the other outcome?" is one index probe on a green miss, and
nothing on a run that executed nothing. No upload: the history is the
local `cache.db` that `vx why` and `vx last` read.

It works on the second run of a key on your machine, not after a fleet
of runs. The record lives under `~/.vx`, so every worktree of the repo
reads what the others saw.

## What it is not

- **Not a retry policy.** `exec.retries` is separate and explicit. A
  pass on retry is *reported*, not quietly made green.
- **Not a quarantine.** Nothing is skipped: a skip is a silent pass.

It is a label on a fact. What to do about it is yours. More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
