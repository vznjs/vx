---
title: 'Dev servers as graph nodes: readiness instead of sleep'
date: 2026-09-10T23:36:00Z
authors:
  - vzn
tags:
  - dx
  - execution
excerpt: "The hard part of 'start the tests once the server is up' is knowing when it is up. vx watches a persistent task's output for a pattern, holds its dependents until the line appears, and tears the server down when the run ends."
---

Some tasks do not finish. A dev server, a watcher, a database for the
integration tests. Most runners either refuse to model them or model
them as "run this and never wait," which leaves the interesting problem
to a `sleep 5` in a shell script.

vx models them as **persistent** tasks and gives them the two things a
graph node needs: a notion of *ready*, and a guaranteed *end*.

```ts
dev: {
  exec: {
    command: 'vite',
    persistent: { readyWhen: 'Local:' },
    timeout: 30_000,
  },
},
e2e: {
  dependsOn: ['dev'],
  exec: { command: 'playwright test' },
},
```

## Ready is a line of output

`readyWhen` is a regex matched against the task's output. The moment a
line matches, the task is ready and its dependents are released; `e2e`
starts against a server that is actually listening. The match also sees
a trailing partial line, so a prompt with no newline (`Listening on
:3000`) works.

`exec.timeout` bounds the wait. If the pattern never appears, vx kills
the process and fails the task instead of hanging the run. A persistent
task with no `readyWhen` is ready on spawn, which is right for a daemon
nothing gates on.

No polling loop, no `wait-on` package, no guessed number of seconds.
The server tells you when it is up, and you wrote down what it says.

## The end is guaranteed

When the run finishes, every persistent task is sent `SIGTERM`, given a
grace period, then `SIGKILL`ed if it is still there. Nothing is left
listening on a port after `vx run e2e` returns, whether the tests
passed, failed, timed out or you pressed Ctrl-C. That last case is
[its own post](../ctrl-c/).

Readiness escalates the same way. A server that ignores the timeout's
`SIGTERM` gets `SIGKILL` after the grace, so a wedged process cannot
hold the run open.

## In the foreground

`vx run dev` with nothing depending on it is the other common case: you
want the server in your terminal and you want `vx` to stay attached.
When the requested tasks are persistent, vx stays in the foreground
until one of them exits, then reports which one and stops the rest:

```
vx: web#dev exited with code 1; stopping 2 other persistent task(s)
```

The exit code is the child's, so a crashed server is a non-zero `vx`.

## What it costs elsewhere

A persistent task is pinned to this machine, and so is everything that
depends on it: a remote worker cannot reach a port on your laptop, and
the placement stage knows that without being told. A persistent task
under a sandbox gets the same grants and walls as any other, but no
violation report, because the report reads the trace after the child
exits and a server exits only when the run tears it down.

Persistent tasks are not cached. They have no end state to store. Their
dependents can be; `e2e`'s key includes `dev`'s key, so a config change
to the server re-runs the tests.

The guide, with the readiness patterns for the common servers, is
[Dev & long-running tasks](../../guides/dev-tasks/).
