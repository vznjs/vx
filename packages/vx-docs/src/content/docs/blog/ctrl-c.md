---
title: 'Ctrl-C leaves nothing running'
date: 2026-09-10T23:35:00Z
authors:
  - vzn
tags:
  - execution
  - correctness
excerpt: "A task runner spawns processes, and the one thing every process spawner owes you is that they die when it does. Here is the teardown vx runs on a signal, an abort, a timeout or a crashed sibling, and the tests that pin it."
---

Ask around about any monorepo tool and you will hear the same story: a
`vite` still holding port 5173 after the run was cancelled, a `tsc -w`
from last Tuesday, a CI job whose cancellation left a database container
running until the runner was reclaimed. A task runner spawns processes.
The least it owes you is that they die when it does.

vx has one teardown, and every way a run can end goes through it.

## The teardown

1. Every live child receives `SIGTERM`.
2. vx waits a grace period, two seconds by default,
   `VX_KILL_GRACE_MS` to change it.
3. It re-reads its registries, because a child may have spawned during
   the grace, and sends `SIGKILL` to anything still alive.
4. It reaps, so nothing is left as a zombie, and only then does the
   process exit.

The exit code says what happened: 130 after `SIGINT`, 143 after
`SIGTERM`, the child's own code when a foreground persistent task ended
the run. A second Ctrl-C during the grace skips the rest of it and
escalates immediately, for the case where you already know the child
will not listen.

## Every way a run ends

The teardown is not a signal handler bolted to the side. It is the
same function called from every exit path:

- **A signal.** `SIGINT` and `SIGTERM` to the `vx` process, including a
  CI cancellation.
- **An abort.** `run()` is also a library call, and it takes an
  `AbortSignal`. Abort it and the same teardown runs; tasks that never
  started are reported as `aborted`, not `skipped`, so a summary can
  tell the two apart.
- **A readiness timeout.** A persistent task whose `readyWhen` never
  matched is `SIGTERM`ed, then `SIGKILL`ed after the grace if it
  ignores that.
- **A foreground persistent task exiting.** `vx run dev` with three
  servers up: when one exits, the other two are torn down and its exit
  code is yours.
- **The normal end of a run.** Persistent tasks that gated other work
  are torn down when the graph completes.
- **`vx watch`.** A Ctrl-C mid-cycle tears the cycle's children down
  first and returns only once they are gone, so a cancelled watch never
  orphans a task.

## The tests are the claim

Every one of those paths has a test that spawns a real child, records
its pid to a marker file, ends the run the way that path ends it, and
asserts the child is dead within the window, with a zombie counting as
alive. The window is the shortest one that still fails without the fix,
because a timed wait in a test is a claim about time and a generous
window would hide a regression that merely got slower. "The task has
started" is a marker file, never a `sleep`.

That is also why the grace is a constant with a name rather than a
literal: `SIGNAL_SHUTDOWN_GRACE_MS` is what the tests override, and a
change to it is a visible diff.

## One more refusal

A task can run `vx` itself. If it runs `vx` against the *same*
workspace, the inner run would build the same graph, claim the same
cache, and, on Ctrl-C, race the outer teardown for the same children.
vx exports the workspace it is running into the task's environment and
refuses a nested run on it with a clear error, instead of letting the
recursion look like it worked.
