---
title: 'Guard rails that tell you the fix'
date: 2026-10-09T11:00:00Z
authors:
  - vzn
tags:
  - correctness
  - config
excerpt: 'A sandbox refusal names the path and the grant to add. Two tasks writing the same folder are stopped before they delete each other. And a config that hangs times out with its name.'
---

A refusal is only useful if it says what to do next. Each guard in this
post stops something real, and each one ends with the fix.

```mermaid
flowchart LR
  T[a task or a config] --> G{guard}
  G -->|write outside its grants| S[names the path and the grant]
  G -->|two tasks, one output| O[names both and the fix]
  G -->|config hangs| C[names the config]
  style S stroke:#c6f84e,stroke-width:2px
```

## The sandbox names what to grant

A sandboxed task that writes outside its grants fails, and vx says
where it tried to write and which grant would allow it:

```sh frame="terminal"
$ vx run @demo/api#gen
┌─ @demo/api#gen > $ mkdir -p dist && echo ok > dist/out.js && echo x > ../shared.txt
/usr/bin/sh: 1: cannot create ../shared.txt: Read-only file system
vx: the sandbox refused writes outside the project, which are not reported as violations: …/demo/packages/shared.txt. If the task needs one, grant its directory, e.g. `allow: { write: ['../'] }`.
└─ @demo/api#gen ── (52ms) failed (exit 2)
```

The tool's own error says "read-only file system". vx says which file,
and the line to add to `exec.sandbox`.

## Two tasks, one output folder

vx cleans a task's outputs before it runs and before a cache restore. Two
tasks that declare the same output would delete each other's work, so
`vx lock` refuses the graph and writes no lock. A run never checks the
rules: it runs what the lock froze.

```sh frame="terminal"
$ vx lock
✗ vx lock  lock not written

  @demo/api#bundle and @demo/api#build both write dist/**
  vx clears a task's outputs before it runs, so one deletes the other's

  fix  give each task its own output path, or set run.rules.exclusiveOutputs: false in .vx/workspace.ts
```

This is a workspace rule. Rules are checks that keep vx fast and
correct, on by default. Turning one off allows a shape vx still runs
correctly, only slower, and never changes a cache key:

```ts
// .vx/workspace.ts
import { defineWorkspace } from '@vzn/vx/config'

export default defineWorkspace({
  run: { rules: { exclusiveOutputs: false, upfrontKeys: true } },
})
```

`upfrontKeys` refuses a task whose inputs match another task's outputs
in the same run, because its key cannot be known before that task
finishes. The message names the glob to exclude.

## A config that hangs

A `vx.config.ts` is code, and code can hang: an `await` on a server that
is down, or a loop. Each config gets 30 seconds, and then the load fails
and names the config. A real evaluation takes about 10 ms.
`VX_CONFIG_WORKER_TIMEOUT` changes the limit.

The [schema](../../schema/) lists every rule and sandbox grant.
