# `src/util/procfs.ts` — is `/proc` this process's view

## Purpose

Two readers look other processes up by pid in `/proc`: the group
liveness check (`exec/kill-tree.ts`, which skips a zombie) and the run
lock's holder start time (`orchestrator/run-lock.ts`, which tells a
recycled pid apart). Both assumed the procfs they read numbers
processes the way `process.pid` and `Bun.spawn` do. Under vx's own
sandbox it does not: the task runs in a nested pid namespace where it
is pid 2 while `/proc/self` names 7, and `/proc/<child pid>` is some
other process or none (measured 2026-09-24). The liveness check then
found no member in any group, so a server that ignored the SIGTERM was
never SIGKILLed and the run hung on its pipe.

## Public surface

```ts
export function procfsIsOwn(): boolean
```

- True when `readlink('/proc/self')` is this process's pid: the mount
  belongs to this pid namespace. False off Linux, and when the link
  cannot be read.
- Asked once per process; the mount does not change under a run.
- A caller that gets false answers the way it does off Linux: the
  liveness check trusts `kill(-pgid, 0)`, the run lock trusts the pid.

## Tests

The differential is the sandboxed shards: with the check reverted,
`tests/task-tree-kill.test.ts`, `tests/runner.test.ts` and
`tests/persistent.test.ts` (a SIGTERM-ignoring group outlives the
grace), and `tests/run-lock.test.ts` (a live holder read as another
process), fail under the gate's sandbox. `tests/run-lock-recycled.unsafe.test.ts`
holds that an unsandboxed Linux process reads its own procfs, and the
recycled-pid row that needs one.
