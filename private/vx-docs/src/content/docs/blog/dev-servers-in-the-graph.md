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

A dev server never finishes, so "start the tests once it's up" usually
ends up as a `sleep 5`. vx waits for the line the server prints instead.

```ts
dev: {
  exec: {
    command: 'bun server.ts', // sleeps 800 ms, then listens on :3999
    persistent: { readyWhen: 'Listening on' },
    timeout: '30s',
  },
},
e2e: {
  dependsOn: ['dev'],
  exec: { command: 'curl -sf localhost:3999' },
},
```

```sh frame="terminal"
$ vx run packages/c#e2e
┌─ packages/c#e2e > $ curl -sf localhost:3999
ok
└─ packages/c#e2e ── (9ms) success
            2 success · 2 total
  time      841ms · max 808ms · avg 409ms · min 9ms

$ curl localhost:3999
curl: (7) Failed to connect to localhost port 3999 after 0 ms: Couldn't connect to server
```

The server was ready at 808 ms, the test started right then, and the
whole run took 841 ms. After it, nothing listens on the port. (vx at
`0be0367`, 2026-10-23.)

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

No polling loop, no `wait-on` package, no guessed seconds.

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
vx: web#dev exited with code 1; stopping 2 other persistent tasks
```

A crashed server makes `vx` exit 1.

## What it costs elsewhere

A persistent task is pinned to this machine, and so is everything that
depends on it: a remote worker cannot reach a port on your laptop, and
the placement stage knows that without being told. A persistent task
under a sandbox gets the same grants and walls as any other, but no
violation report, because the report reads the trace after the child
exits and a server exits only when the run tears it down.

Persistent tasks are not cached. They have no end state to store. Their
dependents can be; `e2e`'s key includes `dev`'s key, so a config change
to the server re-runs the tests. And a server only its cache hits need is
never started: when every dependant is a confirmed hit, the run does not
boot it.

Guide: [Configure › Dev tasks](../../guides/configure/#dev-tasks). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
