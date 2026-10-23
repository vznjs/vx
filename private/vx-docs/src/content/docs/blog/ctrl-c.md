---
title: 'Ctrl-C leaves nothing running'
date: 2026-09-10T23:35:00Z
authors:
  - vzn
tags:
  - execution
  - correctness
excerpt: "A task runner spawns processes, and it owes you one thing: they die when it does. The teardown vx runs on a signal, an abort, a timeout or a crashed sibling, and the tests that pin it."
---

A `vite` still holding port 5173. A `tsc -w` from last Tuesday. A task
runner spawns processes, and the least it owes you is that they die
when it does.

Here a task starts two background `sleep`s. Shells ignore `SIGINT` in
background jobs, so these two won't stop on Ctrl-C:

```ts
serve: { exec: { command: 'sleep 301 & sleep 302 & wait' } }
```

```
before Ctrl-C   sh -c … ; sleep 301 ; sleep 302      3 processes
after  Ctrl-C   vx exits 130 after 2,008 ms           0 processes
```

Linux x64, vx at `0be0367`, 2026-10-23; 5 runs, 2,008 to 2,011 ms. The
two seconds are the grace period. Then vx sends `SIGKILL`.

## The teardown

1. Every live child's process group gets the signal vx got. `SIGINT`
   stays `SIGINT`, so a Ctrl-C cleanup runs. `SIGTERM` and `SIGHUP`
   arrive as `SIGTERM`.
2. vx waits two seconds.
3. It looks again, since a child may have spawned during the wait, and
   sends `SIGKILL` to anything still alive.
4. It reaps, so nothing is left as a zombie. The summary prints, every
   telemetry sink flushes and every plugin tears down, each within its
   bound. Then vx exits.

A second Ctrl-C skips the wait. A remote cache download in flight is
dropped, not waited on.

| How the run ended                     | Exit code |
| ------------------------------------- | --------- |
| `SIGINT` (Ctrl-C)                     | 130       |
| `SIGHUP` (the terminal closed)        | 129       |
| `SIGTERM` (a CI cancel)               | 143       |
| a foreground persistent task failed   | 1         |

## Every way a run ends goes through it

- **A signal.** `SIGINT`, `SIGTERM` or `SIGHUP`. A task runs in its own
  session, so a closing terminal reaches only `vx`. Unless `vx` passes
  the hang-up on, the tree outlives the window.
- **An abort.** `run()` is also a library call that takes an
  `AbortSignal`. Tasks that never started report `not run`, not
  `skipped`.
- **A readiness timeout.** A persistent task whose `readyWhen` never
  matched gets `SIGTERM`, then `SIGKILL` after the grace.
- **A foreground persistent task exits.** With three dev servers up,
  one exiting tears down the other two.
- **The normal end.** Persistent tasks that gated other work stop when
  the graph completes.
- **`vx watch`.** Ctrl-C mid-cycle tears the cycle's children down
  before it returns.

## The tests are the claim

Each path has a test that spawns a real child, writes its pid to a
marker file, ends the run that way, and asserts the child is dead in
time, counting a zombie as alive. "Started" is a marker file, never a
`sleep`. The tests set `VX_TEST_KILL_GRACE` to 200 ms so they prove the
escalation without waiting two seconds each; the default is
`SIGNAL_SHUTDOWN_GRACE_MS`.

## A nested run is refused

A task can run `vx`. Against the *same* workspace, the inner run would
claim the same cache and race the outer teardown for the same children
on Ctrl-C. vx puts the workspace it runs into the task's environment and
refuses a nested run on it with a clear error.

More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
