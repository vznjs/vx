---
title: 'A task reads what it depends on, through node_modules'
date: 2026-11-07T22:20:00Z
authors:
  - vzn
tags:
  - sandbox
  - correctness
excerpt: 'A sandboxed task reads another project only as its package manager linked it, under node_modules, and only when its key answers for that project.'
---

One project builds a tool, another runs it. The app reads the tool the
way its code would: from `node_modules`, where the package manager linked it.

```mermaid
flowchart LR
  T[tools#build] -->|out/bin/greet| L[app/node_modules/tools]
  L -->|read| A[app#build, sandboxed]
```

## Depend on the project you read

`app` lists `tools` in its `package.json`. Its `build` depends on
`^build`, so its key holds the key of `tools#build`:

```ts
build: {
  dependsOn: ['^build'],
  exec: {
    command: 'sh node_modules/tools/out/bin/greet > greeting.txt',
    sandbox: { allow: { read: ['.'], write: ['greeting.txt'] } },
  },
  inputs: { files: ['src/**'] },
  outputs: { files: ['greeting.txt'] },
  cache: true,
}
```

Edit `tools/src/greet.sh` and build the app. Both tasks run again:

```ansi
[4m[58;2;110;118;129m  [1m[38;2;167;139;250mTasks[0m[4m[58;2;110;118;129m     [2mstatus  cache     ±usual    time   cpu    mem outputs  blocks worker         task[0m[4m[58;2;110;118;129m                           [0m
            [38;2;34;197;94msuccess[0m [2mmiss[0m       [38;2;34;197;94m−17ms[0m    [38;2;203;213;225m59ms[0m     [2m—[0m      [2m—[0m     [2m19B[0m       [38;2;203;213;225m1[0m [2mlocal[0m          [38;2;244;114;182mtools[0m[2m#[0m[38;2;244;114;182mbuild[0m
            [38;2;34;197;94msuccess[0m [2mmiss[0m       [38;2;34;197;94m−19ms[0m    [38;2;203;213;225m42ms[0m     [2m—[0m      [2m—[0m     [2m14B[0m       [2m0[0m [2mlocal[0m          [38;2;147;197;253mapp[0m[2m#[0m[38;2;244;114;182mbuild[0m
```

The path never names where `tools` lives. Move it, and only the link moves.

## Drop the edge, and the read is refused

Without `dependsOn`, an edit to `tools` would not move the app's key, and
a cache hit would replay a stale greeting. So the sandbox hides it:

```ansi
[2m┌─[0m [1m[38;2;147;197;253mapp[0m[2m#[0m[1m[38;2;244;114;182mbuild[0m [2m>[0m [1m[38;2;239;68;68mfailed (exit 2, 1 sandbox violation)[0m

[2mpackages/app $ sh node_modules/tools/out/bin/greet > greeting.txt[0m

[2m├─[0m [1mOUTPUT[0m [2m────────────────────────────────────────────────────[0m

[38;2;239;68;68msh: 0: cannot open node_modules/tools/out/bin/greet: No such file[0m

[2m├─[0m [1m[38;2;239;68;68mSANDBOX VIOLATIONS (1)[0m [2m────────────────────────────────────[0m

openat(node_modules/tools/out/bin/greet) = -1 ENOENT  [/tmp/claude-0/tmp/demo/packages/tools/out/bin/greet]
vx: app#build read `packages/tools` (linked at `packages/app/node_modules/tools`), and its key includes no task of tools, so an edit there would not re-run it. Add a `dependsOn` edge that reaches one (`^build`, or `tools#build` where it keys its sources), or grant and key the files yourself (`allow.read` plus `inputs.workspaceFiles`).
```

vx names the link the task read through and the edge that makes the read
safe. Add `^build` back and the run passes.

How to grant reads: [Sandboxing](../../docs/sandboxing/).
More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
