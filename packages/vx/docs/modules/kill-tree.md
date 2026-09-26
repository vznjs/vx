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
export function signalThrough(child: Child, fd: number): void
export function closeSignalChannel(child: Child): void
export function spawnGuarded(spawn: () => Child): Child
export function releaseGroup(child: Child): void
export function holdGroups(children: readonly Child[]): () => void
```

`signalThrough` routes a child's SIGINT and SIGTERM down `fd`, a pipe vx
owns, instead of to its group: a Linux sandboxed task (item 752). Its
group is bwrap's, whose monitor died of the SIGTERM and took the
namespace down with SIGKILL (`--die-with-parent`), so a sandboxed
command's trap never ran; a watcher inside reads the signal's name and
signals the command's group (`sandbox-runtime.md`). SIGKILL still goes to
the group, and a write the reader is gone for (EPIPE) falls back to it.
`closeSignalChannel` runs once the child has exited, and drops the entry
before it closes the descriptor, so a later kill never writes to a
number the process has since reused.

`untilGroupsGone` is the wait between the polite signal and SIGKILL: it
resolves when every child's GROUP is gone, or at the grace with the
children whose group still has a member — the ones to SIGKILL. The
leader's exit is not the end of the tree: `server & wait` dies on the
SIGTERM while a server that ignores it keeps the group and the task's
pipe alive, and the end-of-run shutdown that waited for the shell alone
never SIGKILLed the server — vx printed its summary and never exited
(nx#8286 reproduced on vx, 2026-09-24). After the leaders exit the
groups are polled every 20 ms, and only while one is left.

## The group guard: a `kill -9` of vx

A `kill -9` of vx, or the OOM killer, runs nothing in vx, so the kill
has to live outside it. `spawnGuarded` wraps each task spawn and lists
its group with the guard: one `sh` per vx process (argv0 `vx-group-guard`), its own group,
reading a pipe on its fd 3 whose write end only vx holds. vx writes
`+<pgid>` at a spawn and `-<pgid>` (`releaseGroup`) once it is done with
the task, beside the `liveChildren` entry. When vx dies the kernel
closes the write end, the guard's read ends, and it SIGKILLs every group
still listed: the unsandboxed and the macOS sandboxed spawns get what
bwrap's `--die-with-parent` gives a Linux sandboxed task (item 860,
turborepo#9666). A group kill reaches what the task forked, so a
`dev` script's runner and its server go together.

- Started just before the first spawn: a run that spawns nothing, a
  warm run, never starts it (`keep-alive.test.ts` › "a run that spawns
  no task starts no guard", which also pins the order). Before, not
  after: started after the first spawn, the guard's own spawn was a
  window in which the task ran unlisted, and under the gate's traced
  sandbox a third of the `kill -9` rows landed in it. What is left is
  the step from a spawn's return to one pipe write. A 300-project `test --all --no-cache` run
  (600 tasks) took 4,462 ms against 4,473 before it (min of 9,
  interleaved, one workspace copy per arm; medians 4,575 and 4,543): a
  tie. The cost is the one `sh` and two pipe writes per spawn.
- A teardown holds its groups (`holdGroups`) until its SIGKILL sweep
  has settled: the signal stop (`terminateChildren`), the end-of-run
  persistent shutdown, and a readiness timeout, which holds until its
  SIGKILL. That SIGKILL waits on an unref'd timer, so a vx that exits
  inside the grace leaves the held group to the guard. The runner lets a group go when its LEADER
  exits, and a shell that died on the signal while its child ran out
  the grace let the group go mid-grace; a `kill -9` of vx there left
  the child under init (item 865, both reproduced). A release that
  comes while a group is held is written when the hold ends; holds
  count, so two teardowns over one group let it go once both are done.
- A clean exit closes the pipe too, with the list empty, so the guard
  kills nothing. A released group is left as before: a one-shot task's
  `server &` outlives vx's clean exit, and a pid the kernel reuses is
  never killed on an old task's account.
- The guard is detached, so a terminal's Ctrl-C does not reach it; that
  path is vx's own teardown (`signals.md`).
- Best-effort: a guard that cannot start, or a write it is gone for,
  stops the guarding for the process and never fails a task.
- The pipe is not inherited: Bun opens it close-on-exec, and a task's
  `/proc/self/fd` holds 0, 1 and 2 only (probed 2026-09-26).
- A per-spawn watcher in the task's own shell was the first sketch and
  is wrong: it is a job of that shell, so a task's bare `wait` waited on
  it until vx wrote.

`PR_SET_PDEATHSIG` was the other way, and was measured twice and
refused:

- 2026-09-24, a `bun:ffi` wrapper that calls prctl and then execve
  (`Bun.spawn` has no pre-exec hook): a Bun start per spawn, 9.8 ms
  against 1.0 ms for a bare `sh` (min of 10), Linux and glibc only.
- 2026-09-25 (item 801), util-linux `setpriv --pdeathsig KILL --` in
  front of the shell: 3.6 ms against 2.4 ms per spawn (min of 400,
  interleaved), and the same 600-task run at 3,865 ms against 3,631
  (+6.4%, min of 9, interleaved, one workspace copy per arm).

Either way the death signal reaches the one process it was set on, and
it does not survive a fork: `sh -c 'server & wait'` lost the shell and
kept the server, and a plain command vx execs (`exec sleep`) died while
whatever it forked lived on.

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
  0.32 s. Elsewhere `kill(-pgid, 0)` is the answer — and on Linux too
  when procfs is another pid namespace's (`util/procfs.ts`): there the
  table held no member, a group that ignored the SIGTERM was never
  SIGKILLed, and a run under vx's own sandbox hung on a persistent
  dependency's server.
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
- Outlive a `kill -9` of vx in a process that left the task's group:
  a `setsid` daemon, as above. The guard itself can be killed too (a
  `pkill` of its name); then a `kill -9` of vx leaves the groups under
  init, as before item 860.
- Reap: the caller awaits `exited` as before.

## Tests

`tests/keep-alive.test.ts`, "a SIGKILLed vx takes the groups it holds
with it": a persistent and a one-shot task's backgrounded grandchild die
with a `kill -9` of vx, and both fail without the guard. The control, a
one-shot task's leftover that outlives vx's clean exit, fails without the
release, and "a run that spawns no task starts no guard" fails on a guard
started at load, after the spawn, or once per spawn. A terminal's Ctrl-C
(SIGINT to vx's group) leaves the guard alive for a `kill -9` in the
teardown grace, and the one-shot row's child ignores SIGTERM, so a
guard that sent it fails. In `sandbox-runtime.unsafe.test.ts`, "a traced
sandboxed one-shot task’s children die with vx" (strace outlived vx
before the guard), and the unsandboxed control has the backgrounded
child die and the `setsid` one live. In `keep-alive.test.ts`, "a kill -9 in
a Ctrl-C’s grace…" and "a kill -9 in the persistent shutdown’s grace…"
and "a never-ready server a dead shell left goes with a vx that exits
inside the grace" each fail without the hold. `tests/kill-tree-hold.test.ts` drives the hold
itself in a child that SIGKILLs itself: a deferred release is written when
the hold ends, and a group two teardowns hold stays listed until both let go.

`tests/task-tree-kill.test.ts`: a timeout, SIGINT, SIGTERM and SIGHUP
each reap a task's backgrounded grandchild (its pid from the inner
shell's own `$$`); every case fails on a pid-only kill. A timeout
reaps a grandchild that ignores SIGTERM after its shell has died. A persistent
dependency whose server ignores SIGTERM behind `& wait` does not hang
vx's exit; a grandchild's SIGTERM cleanup gets the grace after its shell
exits, and the teardown ends when the group is gone (under 1.2 s; the
zombie-counting read took 1.5 s).
