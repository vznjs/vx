---
title: 'When a task misbehaves'
date: 2026-10-09T08:20:00Z
authors:
  - vzn
tags:
  - dx
  - execution
excerpt: 'A task hangs, gets killed, prompts for input, or calls vx run on itself. vx tells you what happened in one line.'
---

A task hangs, gets killed, or prompts for input. vx tells you what
happened in one line.

```sh frame="terminal"
$ vx run packages/b#hang                 # exec: { command: 'sleep 30', timeout: '1s' }
┌─ packages/b#hang > $ sleep 30
[vx] timed out after 1000ms — killed (SIGTERM)
└─ packages/b#hang ── (1.01s) failed (timed out, exit 143)

$ vx run packages/b#killed               # exec: { command: 'kill -9 $$' }
┌─ packages/b#killed > $ kill -9 $$
[vx] exit 137 is how the shell reports a death by SIGKILL (9): nothing catches it — on Linux the kernel's OOM killer (dmesg, or the memory limit of the container's cgroup) or an explicit kill; vx's own timeout reports itself as a timeout
└─ packages/b#killed ── (5ms) failed (exit 137, 128 + SIGKILL)
```

A hang becomes a named timeout. Exit 137 gets its signal and the usual
causes.

<small>Demo workspace · vx 69617eb · 2026-10-23</small>

`exec.timeout` takes a duration (`'1s'`, `'5m'`). `--timeout` sets one
for the whole run.

## No vx run inside a task

A task that calls `vx run` on its own workspace hides work from the
graph and the cache key, and a loop back to itself never ends. vx
refuses it:

```sh frame="terminal"
$ vx run packages/b#nested
┌─ packages/b#nested > $ vx run packages/b#echo
✗ vx run  task packages/b#nested runs `vx run` inside its own workspace: a nested run is invisible to the outer graph (its tasks escape the schedule, the concurrency budget and the cache key) and a loop back to this task forks without bound

  Declare what it needs with dependsOn instead
└─ packages/b#nested ── (112ms) failed (exit 1)
```

Running a different workspace from a task is fine.

## A config typo names the line

```sh frame="terminal"
$ vx lock
✗ vx lock  lock not written

  packages/b/vx.config.ts:9:42
  tasks.hang.exec.timeout takes a duration with its unit, like '1000ms' or '1s' (got 1000)

    7 |     },
    8 |     ...lib({ entry: 'src/index.ts' }),
  > 9 |     hang: { exec: { command: 'sleep 30', timeout: 1000 } },
      |                                          ^
```

File, line and column. No stack trace.

## Arguments after --

Everything after `--` goes to the command and into the cache key, so
different flags never reuse the wrong result:

```sh frame="terminal"
$ vx run packages/b#echo -- --watch=false
┌─ packages/b#echo > $ echo args: --watch=false
args: --watch=false
```

## Prompts get the terminal

A task with `exec.interactive: true`, like a migration that asks before
it applies, gets your terminal. It runs alone and is never cached. In
CI or a pipe its input is empty, so a prompt can't hang.

## Two runs take turns

A second `vx run` in the same workspace waits for the first. After a
second it tells you:
`[vx] waiting for another vx run (pid N) on this workspace to finish…`.

Every option is in the [schema](../../schema/) and the
[CLI reference](../../cli/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
