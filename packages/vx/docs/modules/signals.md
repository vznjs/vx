# `src/orchestrator/signals.ts` — a signal reaches every child

## Purpose

A SIGINT, SIGTERM or SIGHUP to the vx process mid-run forwards SIGTERM
to every live child's process group and every ready persistent task's,
waits the kill grace (`VX_KILL_GRACE_MS`, 2 s) for them, SIGKILLs the
survivors' groups, closes the cache handle, and exits 128 + signo
(130 / 143 / 129); a second signal during the grace SIGKILLs at once.
The group, not the pid (`exec/kill-tree.ts`, item 236): a task is
spawned into its own session, so what it forked dies with it — and so
the terminal closing reaches vx alone, which is why SIGHUP is handled
like the other two. Without the forward, a programmatic signal
to the process alone — CI cancellation, `kill <pid>` — orphaned every
running child; terminal Ctrl-C only worked through the process group.
Without the escalation (2026-09-10) a child that trapped TERM outlived
the run. Split from `run.ts` on 2026-09-10 (pure motion).

`terminateChildren` is that teardown on its own, minus the exit: the
process handler, `RunOptions.signal` (an embedder aborting a run — the
watch loop's Ctrl-C) and the foreground keep-alive all run it. It
re-reads the registries after the grace, so a child the still-live
scheduler spawned during it goes too.

## Public surface

```ts
export const SIGNAL_SHUTDOWN_GRACE_MS = 2000
export async function terminateChildren(live: () => Subprocess[], graceMs?: number): Promise<void>
export function forwardSignals(args: {
  enabled: boolean // RunOptions.handleSignals
  log: Logger
  cache: { close(): void }
  liveChildren: ReadonlySet<Subprocess> // the runner's in-flight children
  persistentRegistry: ReadonlyMap<string, Subprocess>
}): { remove(): void }
```

The two registries stay with `run()`, which hands them to the runner
around every spawn; this module only reads them when a signal lands.
`remove()` runs in `run()`'s finally so repeated runs in one process (a
test suite, an embedder) never stack listeners. An embedder that owns
the process's signals passes `handleSignals: false`.

## What it does NOT do

- Return: the process handler exits once the children are gone. The
  end-of-run shutdown of dependency-only persistent children is
  `persistent.ts`, with the same grace.
- Run under a custom logger's control beyond `runEnd()`: the status
  region is cleared so a TTY is not left with a frozen frame.

## Tests

`tests/task-tree-kill.test.ts` (a timeout, SIGINT, SIGTERM and SIGHUP
each reap a task's backgrounded grandchild; each fails on a pid-only
kill); `tests/signal-handling.test.ts` (SIGINT → 130 and SIGTERM → 143 with
the one-shot child and the ready persistent child dead; a child that
ignores TERM is SIGKILLed after the grace; a second signal skips the
grace; the in-process lifecycle: handlers removed after every run,
`handleSignals: false` installs none); `tests/abort.test.ts`
(`RunOptions.signal`: the running child and its dependents `aborted`,
a stubborn child SIGKILLed, an already-aborted signal runs nothing);
`tests/keep-alive.test.ts` (one requested server exiting ends the
foreground session: the other is torn down, exit 1 on a crash, 0 on a
clean exit); `tests/cache-hygiene.test.ts` (an interrupted run
publishes nothing).
