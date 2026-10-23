---
title: 'Guard rails that tell you the fix'
date: 2026-10-09T11:00:00Z
authors:
  - vzn
tags:
  - correctness
  - config
excerpt: 'A sandbox refusal names the path and the grant to add. Two tasks writing the same folder are stopped before they delete each other. A config that hangs times out with its name. And a run never evaluates a config at all.'
---

A sandboxed task writes one file outside its grant:

```sh frame="terminal"
$ vx run packages/d#gen
┌─ packages/d#gen > $ mkdir -p dist && echo ok > dist/out.js && echo x > ../shared.txt
/usr/bin/sh: 1: cannot create ../shared.txt: Read-only file system
├─ SANDBOX ─────────────────────────────────────────────────

vx: the sandbox refused writes outside the project, which are not reported as violations: …/demo/packages/shared.txt. If the task needs one, grant its directory, e.g. `allow: { write: ['../'] }`.
└─ packages/d#gen ── (44ms) failed (exit 2)
```

Demo workspace, Linux x64, vx at `69617eb`, 2026-10-23 (path
shortened). Each guard here stops something real and ends with the fix.

The tool's own error says "read-only file system". vx says which file,
and the line to add to `exec.sandbox`.

## Two tasks, one output folder

vx cleans a task's outputs before it runs and before a cache restore. Two
tasks that declare the same output would delete each other's work, so
`vx lock` refuses the graph and writes no lock:

```sh frame="terminal"
$ vx lock
✗ vx lock  lock not written

  packages/a#notes and packages/a#slow both write out/** / out/copy.ts
  vx clears a task's outputs before it runs, so one deletes the other's

  fix  give each task its own output path
```

A run never checks the rules again: it runs what the lock froze.

This is a workspace rule. Rules are checks that keep vx fast and
correct, on by default. Turning one off allows a shape vx still runs
correctly, only slower, and never changes a cache key:

```ts
// .vx/workspace.ts
import { defineWorkspace } from '@vzn/vx/config'

export default defineWorkspace({
  run: { rules: { exclusiveOutputs: false } },
})
```

One check has no switch: `vx lock` refuses a task whose inputs match
another task's outputs, because its key cannot be known before that task
finishes. The message names the glob to exclude, or the dependency to
leave out of `inputs.tasks` so the key hashes its bytes.

## A config that hangs

A `vx.config.ts` is code, and code can hang: an `await` on a server that
is down, or a loop. Each config gets 30 seconds, then `vx lock` fails
and names the config. `VX_CONFIG_WORKER_TIMEOUT` changes the limit.

## A run never evaluates a config

`vx lock` evaluates every config and writes the resolved objects to
`.vx/projects.lock.json`. Every run reads them back as data instead of
running a file. A config that reads the environment or calls
`Math.random` is read once, at lock time, and `vx lock --check` reports
when evaluating it again would give a different answer.

The [schema](../../schema/) lists every rule and sandbox grant. More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
