---
title: 'A sandboxed task reads what it depends on, and nothing beside it'
date: 2026-11-07T22:20:00Z
authors:
  - vzn
tags:
  - sandbox
  - correctness
excerpt: "A sandboxed task can read the outputs of the tasks it depends on, in any project, and never their sources. With hermetic: true it reads nothing of the machine you did not name."
---

One project builds a tool, every other project runs it, and each stays
in its sandbox. The tool's sources stay hidden.

```mermaid
flowchart LR
  S[tools/src] -->|tools#build| O[tools/out]
  O -->|readable| A[app#build, sandboxed]
  S -.->|hidden| A
```

## Depend on a task, read its outputs

```ts
build: {
  dependsOn: ['packages/tools#build'],
  exec: {
    command: 'cat ../tools/out/bin/greet ../tools/src/greet.sh > greeting.txt',
    sandbox: { allow: { read: ['.'], write: ['greeting.txt'] } },
  },
  inputs: { files: ['src/**'] },
  outputs: { files: ['greeting.txt'] },
  cache: true,
}
```

The output reads fine. The source does not exist for this task:

```ansi
[2m┌─[0m [1m[38;2;147;197;253mpackages/app[0m[2m#[0m[1m[38;2;244;114;182mbuild[0m [2m>[0m [1m[38;2;239;68;68mfailed (exit 1)[0m

[2m$ cat ../tools/out/bin/greet ../tools/src/greet.sh > greeting.txt[0m

[2m├─[0m [1mOUTPUT[0m [2m────────────────────────────────────────────────────[0m

[38;2;239;68;68mcat: ../tools/src/greet.sh: No such file or directory[0m

[2m├─[0m [1m[38;2;239;68;68mSANDBOX[0m [2m───────────────────────────────────────────────────[0m

vx: the sandbox hid paths outside the project that exist on this machine, which are not reported as violations: /work/demo/packages/tools/src/greet.sh. If the task reads one, grant it, e.g. `allow: { read: ['../tools/src/greet.sh'] }`.

[2m└─[0m [1m[38;2;147;197;253mpackages/app[0m[2m#[0m[1m[38;2;244;114;182mbuild[0m [2m──[0m [2m(59ms)[0m [1m[38;2;239;68;68mfailed (exit 1)[0m
```

<small>Demo workspace · Linux, bubblewrap · vx 18d0a91 · 2026-11-07</small>

The outputs are safe to read. The task's key already moves with every
file that made them, so a cache hit never hides a changed tool.

## hermetic: true closes off the machine too

A plain sandbox walls off the workspace. `hermetic: true` moves that
wall to `/`. The task reads only what you grant, plus the shell vx needs.

```ansi
[2m┌─[0m [1m[38;2;147;197;253mpackages/app[0m[2m#[0m[1m[38;2;244;114;182mbuild[0m [2m>[0m [1m[38;2;239;68;68mfailed (exit 127)[0m

[2m$ cat ../tools/src/greet.sh > greeting.txt[0m

[2m├─[0m [1mOUTPUT[0m [2m────────────────────────────────────────────────────[0m

[38;2;239;68;68m/usr/bin/sh: 1: cat: not found[0m
[38;2;239;68;68m[vx] exit 127 is the shell's "command not found": cat is /usr/bin/cat on the host, but no sandbox grant reads it, so inside the sandbox it is not there — add it (or its directory) to exec.sandbox.allow.read[0m

[2m└─[0m [1m[38;2;147;197;253mpackages/app[0m[2m#[0m[1m[38;2;244;114;182mbuild[0m [2m──[0m [2m(124ms)[0m [1m[38;2;239;68;68mfailed (exit 127)[0m
```

The task reached for the host's `cat` and found nothing. vx names the
host path and the grant that would fix it. A build cannot lean on a tool
that only your laptop has.

| Sandbox           | Workspace      | Rest of the machine |
| ----------------- | -------------- | ------------------- |
| none              | everything     | everything          |
| `sandbox: {...}`  | what you grant | readable            |
| `hermetic: true`  | what you grant | what you grant      |

How to grant reads: [Sandboxing](../../docs/sandboxing/).
More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
