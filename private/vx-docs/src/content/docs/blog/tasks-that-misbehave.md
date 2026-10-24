---
title: 'When a task misbehaves'
date: 2026-10-09T08:20:00Z
authors:
  - vzn
tags:
  - dx
  - execution
excerpt: 'A task hangs, gets killed, prompts for input, or calls vx run on itself. Each one gets a clear line from vx instead of a mystery. Plus timeouts, forwarded arguments, and two runs that politely take turns.'
---

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

A hang becomes a named timeout. Exit 137 gets its signal and its usual
suspects. Demo workspace, vx at `69617eb`, 2026-10-23.

`exec.timeout` takes a duration (`'1s'`, `'5m'`); `--timeout` sets one
for the run.

## No vx run inside a task

A task that runs `vx run` on its own workspace hides its work from the
graph, the scheduler and the cache key, and a loop back to itself would
fork forever. vx sets `VX_RUN_WORKSPACE` and `VX_RUN_TASK` on every task
and refuses:

```sh frame="terminal"
$ vx run packages/b#nested
┌─ packages/b#nested > $ vx run packages/b#echo
✗ vx run  task packages/b#nested runs `vx run` inside its own workspace: a nested run is invisible to the outer graph (its tasks escape the schedule, the concurrency budget and the cache key) and a loop back to this task forks without bound

  Declare what it needs with dependsOn instead
└─ packages/b#nested ── (112ms) failed (exit 1)
```

Driving a different workspace from a task is fine.

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

The key, the file, the column, and no stack trace.

## Arguments after --

Everything after `--` reaches the task's command and joins its cache
key, so a run with different flags never reuses the wrong result:

```sh frame="terminal"
$ vx run packages/b#echo -- --watch=false
┌─ packages/b#echo > $ echo args: --watch=false
args: --watch=false
```

## Prompts get the terminal

A task with `exec.interactive: true`, such as a database migration that
asks before it applies, gets vx's own terminal. It runs alone, its output
is passed straight through, and it is never cached. Off a terminal, on CI
or in a pipe, its input is empty, so a prompt reads end of input and
never hangs.

## Two runs take turns

Start a second `vx run` in the same workspace and it waits for the first.
After a second it says who it is waiting for:
`[vx] waiting for another vx run (pid N) on this workspace to finish…`.

Every option is in the [schema](../../schema/) and the
[CLI reference](../../cli/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
