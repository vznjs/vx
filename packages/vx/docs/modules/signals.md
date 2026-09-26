# `src/orchestrator/signals.ts` — a signal reaches every child

## Purpose

A SIGINT, SIGTERM or SIGHUP to the vx process mid-run forwards the
signal it received — SIGINT as SIGINT, SIGTERM as SIGTERM, SIGHUP as
SIGTERM — to every live child's process group and every ready
persistent task's,
waits the kill grace (`VX_KILL_GRACE_MS`, 2 s) for those GROUPS to go,
SIGKILLs every group with a member left, lets `run()` leave through its
own end-of-run path (which records no history for a stopped run), and exits 128 + signo
(130 / 143 / 129); a second signal SIGKILLs and exits at once.

The signal stops the run the way `RunOptions.signal` does (item 849):
`run()` holds one `AbortController`, which the embedder's signal and the
process handler both abort, so the scheduler dispatches nothing more and
the abort listener runs `terminateChildren`. `run()` awaits that teardown
before it leaves, then the handler waits for `done` (bounded by
`boundMs`: the grace, one telemetry flush and each plugin's teardown at
`VX_TEARDOWN_TIMEOUT_MS`, and 2 s of slack) and for stdout to drain, and
exits. Until item 849 the handler exited straight after the kill:
`process.exit` runs no `finally`, so a Ctrl-C skipped every sink's flush
and every plugin's teardown, which `plugin.md` promises at the end of
every run, and the summary raced the exit
(`tests/plugin-teardown.test.ts` › "SIGINT flushes the sinks and tears
the plugins down before vx exits 130").
The group, not the pid (`exec/kill-tree.ts`, item 236): a task is
spawned into its own session, so what it forked dies with it — and so
the terminal closing reaches vx alone, which is why SIGHUP is handled
like the other two. Without the forward, a programmatic signal
to the process alone — CI cancellation, `kill <pid>` — orphaned every
running child; terminal Ctrl-C only worked through the process group.
Without the escalation (2026-09-10) a child that trapped TERM outlived
the run. Split from `run.ts` on 2026-09-10 (pure motion).

The received signal, not SIGTERM for all (2026-09-24): a task runs in
its own session, so a terminal's Ctrl-C reaches vx alone, and vx sending
SIGTERM in its place skipped every cleanup bound to SIGINT only — Node's
`process.on('SIGINT')`, a shell's `trap … INT` (turborepo#444, #12652,
#13097 and nx#23585, each reproduced on vx). A task hears the Ctrl-C
once, from vx. A hang-up forwards SIGTERM, because to many servers
SIGHUP means "reload". One consequence is the terminal's own: a
non-interactive shell starts what it backgrounds (`server & wait`) with
SIGINT ignored, so on a Ctrl-C such a server waits out the grace and is
SIGKILLed, exactly as it would outlive a Ctrl-C in a plain terminal;
give it a SIGINT trap, or `exec` it. `forwardedSignal` is the rule, and
`RunOptions.signal` follows it through its abort reason: aborted with
the reason `'SIGINT'` (the watch loop's Ctrl-C) the children get
SIGINT; any other reason, SIGHUP's included, sends SIGTERM.

`terminateChildren` is that teardown on its own, minus the exit: the
process handler, `RunOptions.signal` (an embedder aborting a run — the
watch loop's Ctrl-C) and the foreground keep-alive all run it. It
re-reads the registries after the grace, so a child the still-live
scheduler spawned during it goes too. The wait is for each group
(`untilGroupsGone`), not its leader: a shell that died at once on the
signal ended the grace, and the server it had backgrounded was
SIGKILLed mid-cleanup (2026-09-24).

## Public surface

```ts
export const SIGNAL_SHUTDOWN_GRACE_MS = 2000
export type ForwardedSignal = 'SIGINT' | 'SIGTERM' // SIGHUP forwards as SIGTERM
export function forwardedSignal(received: unknown): ForwardedSignal // a SIGINT stays one; SIGTERM, SIGHUP, anything else → SIGTERM
export async function terminateChildren(
  live: () => Subprocess[],
  signal?: ForwardedSignal, // default SIGTERM
  graceMs?: number,
): Promise<void>
export function forwardSignals(args: {
  enabled: boolean // RunOptions.handleSignals
  log: Logger
  cache: { close(): void }
  liveChildren: ReadonlySet<Subprocess> // the runner's in-flight children
  persistentRegistry: ReadonlyMap<string, Subprocess>
  stop: (signal: StopSignal) => void // aborts run()'s own controller
  done: Promise<void> // settles once run() has left its finally
  boundMs: number // how long a signal waits for `done`
}): { remove(): void }
```

The two registries stay with `run()`, which hands them to the runner
around every spawn; this module only reads them when a signal lands.
`remove()` runs in `run()`'s finally so repeated runs in one process (a
test suite, an embedder) never stack listeners. An embedder that owns
the process's signals passes `handleSignals: false`.

## What it does NOT do

- Return: the process handler exits once `run()` has left (or its bound
  has passed). The end-of-run shutdown of dependency-only persistent
  children is `persistent.ts`, with the same grace.
- Run under a custom logger's control beyond `runEnd()`: the status
  region is cleared so a TTY is not left with a frozen frame.

## Tests

`tests/task-tree-kill.test.ts` (a timeout, SIGINT, SIGTERM and SIGHUP
each reap a task's backgrounded grandchild; each fails on a pid-only
kill; a grandchild's cleanup gets the grace after its shell exits, and
the wait ends when the group is gone; a SIGHUP gives the grandchild its
SIGTERM cleanup, the one thing that tells the handled hang-up from a vx
the hang-up killed, whose group guard SIGKILLs the task anyway);
`tests/signal-handling.test.ts` (SIGINT → 130 and SIGTERM → 143 with
the one-shot child and the ready persistent child dead; a child that
ignores TERM is SIGKILLed after the grace; a second signal skips the
grace; the in-process lifecycle: handlers removed after every run,
`handleSignals: false` installs none; a one-shot and a ready persistent
task each hear the signal as vx forwards it, a Ctrl-C as SIGINT; a
task is its own session leader); `tests/plugin-teardown.test.ts` (a
SIGINT flushes the sinks and tears the plugins down before the exit; a
second signal does not wait for a teardown that hangs); `tests/abort.test.ts`
(`RunOptions.signal`: the running child and its dependents `aborted`,
a stubborn child SIGKILLed, an already-aborted signal runs nothing);
`tests/keep-alive.test.ts` (one requested server exiting ends the
foreground session: the other is torn down, exit 1 on a crash, 0 on a
clean exit); `tests/cache-hygiene.test.ts` (an interrupted run
publishes nothing).

A sweep of this file (item 861, 19 mutants) found the group guard
(`kill-tree.md`) standing in for two of its guarantees: without the
SIGHUP handler, or without the second signal's SIGKILL, the guard's
kill at vx's exit took the tree down, and the rows saw a dead
grandchild either way. Each is held as a pair with the guard off, and
the SIGHUP handler alone by the cleanup row. Equivalent: the persistent
registry in the second signal's sweep (a ready server is in
`liveChildren` for its whole life) and `runEnd` before the stop (the
run's own end clears the region, and the handler waits for it). The
cache close on that exit survived too and is not proven equivalent: no
row observes it, and it stays as the one close a second signal gets.
