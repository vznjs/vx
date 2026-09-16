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
export function killTree(child: Child, signal: 'SIGTERM' | 'SIGKILL'): void
```

## Invariants

- A child with no pid (a spawn that failed) is left alone: `kill(-0)`
  would name vx's own group.
- `ESRCH` means the group is gone — nothing to do. Any other refusal
  falls back to the pid alone, as before.
- Callers: the runner's timeout and readiness deadline, the signal
  teardown (`orchestrator/signals.ts`), the end-of-run persistent
  shutdown (`orchestrator/persistent.ts`). The sandboxed spawn is
  detached too; bwrap's pid namespace would reap on its own, and one
  rule for every spawn is simpler than two.
- A task runs in its own session, so the terminal closing no longer
  reaches it: vx handles SIGHUP beside SIGINT and SIGTERM (129).

## What it does NOT do

- Reach a daemon that called `setsid` itself — the residual every
  non-cgroup runner shares; a sandbox's pid namespace takes even that.
- Reap: the caller awaits `exited` as before.

## Tests

`tests/task-tree-kill.test.ts`: a timeout, SIGINT, SIGTERM and SIGHUP
each reap a task's backgrounded grandchild (its pid from the inner
shell's own `$$`); every case fails on a pid-only kill.
