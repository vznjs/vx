# `src/exec/kill-tree.ts` — a task dies with everything it forked

## Purpose

`killTree(child, signal)` signals a task child's whole process group.
Every task child is spawned `detached` — its own session and process
group — so the group IS the task's tree: the shell, what it backgrounded
(`server &`), a test runner's workers. Signalling the child alone left
all of that alive: a timed-out `sh -c "x & y"` killed the shell and
orphaned `x`, and a Ctrl-C did the same for every compound command
(item 236, 2026-09-16). A group signal reaches a member whose parent
already died — the group outlives its leader — so the order of death
does not matter.

## Public surface

```ts
export type Child = ReturnType<typeof Bun.spawn>
export function killTree(child: Child, signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): void
export async function untilGroupsGone(children: readonly Child[], graceMs: number): Promise<Child[]>
```

`untilGroupsGone` is the wait between the polite signal and SIGKILL: it
resolves when every child's GROUP is gone, or at the grace with the
children whose group still has a member — the ones to SIGKILL. The
leader's exit is not the end of the tree: `server & wait` dies on the
SIGTERM while a server that ignores it keeps the group and the task's
pipe alive, and the end-of-run shutdown that waited for the shell alone
never SIGKILLed the server — vx printed its summary and never exited
(nx#8286 reproduced on vx, 2026-09-24). After the leaders exit the
groups are polled every 20 ms, and only while one is left.

## Invariants

- A child with no pid (a spawn that failed) is left alone: `kill(-0)`
  would name vx's own group.
- `ESRCH` means the group is gone — nothing to do. Any other refusal
  falls back to the pid alone, as before.
- A zombie is not a member. `kill(-pgid, 0)` counts one, and an
  orphaned member that died on the SIGTERM stays a zombie until init
  reaps it — 1 to 2 s under this container's init — so on Linux a group
  the kernel still knows is read from `/proc/*/stat` (state and pgrp).
  Counting the zombie made a clean teardown wait 1.5–2 s instead of
  0.32 s. Elsewhere `kill(-pgid, 0)` is the answer.
- Callers: the runner's timeout and readiness deadline, the signal
  teardown (`orchestrator/signals.ts`), the end-of-run persistent
  shutdown (`orchestrator/persistent.ts`). The sandboxed spawn is
  detached too; bwrap's pid namespace would reap on its own, and one
  rule for every spawn is simpler than two.
- A task runs in its own session, so the terminal closing no longer
  reaches it: vx handles SIGHUP beside SIGINT and SIGTERM (129). The
  same session is why a terminal's Ctrl-C reaches vx alone, and vx
  forwards it as SIGINT (`signals.md`), so a task hears it once.

## What it does NOT do

- Reach a daemon that called `setsid` itself — the residual every
  non-cgroup runner shares; a sandbox's pid namespace takes even that.
- Outlive a `kill -9` of vx: nothing in vx runs to signal the groups,
  so a persistent task survives under init (turborepo#9666 reproduced
  on vx, 2026-09-24). A persistent task's stdin is a pipe vx holds, so
  a server that exits on stdin EOF (esbuild `--watch`) goes with vx
  (`tests/keep-alive.test.ts`). `prctl(PR_SET_PDEATHSIG)` is not the
  fix, measured 2026-09-24: `Bun.spawn` has no pre-exec hook, a
  `bun:ffi` wrapper that calls prctl and then execve costs a Bun start
  per spawn (9.8 ms against 1.0 ms for a bare `sh`, min of 10), it is
  Linux and glibc only, and the death signal reaches the group leader
  alone — `sh -c 'server & wait'` lost the shell and kept the server.
- Reap: the caller awaits `exited` as before.

## Tests

`tests/task-tree-kill.test.ts`: a timeout, SIGINT, SIGTERM and SIGHUP
each reap a task's backgrounded grandchild (its pid from the inner
shell's own `$$`); every case fails on a pid-only kill. A timeout
reaps a grandchild that ignores SIGTERM after its shell has died. A persistent
dependency whose server ignores SIGTERM behind `& wait` does not hang
vx's exit; a grandchild's SIGTERM cleanup gets the grace after its shell
exits, and the teardown ends when the group is gone (under 1.2 s; the
zombie-counting read took 1.5 s).
