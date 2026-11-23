---
title: Try distributed task execution on your machine
description: Start workers as local processes with local(), and watch tasks spread with no CI and no relay.
---

`local()` starts each worker as a process in its own git worktree, so you
can watch a run spread over workers before you touch CI.

```ts title=".vx/workspace.ts" ins={2,8-11}
import { defineWorkspace } from '@vzn/vx/config'
import { dte, local } from '@vzn/vx-dte'
import { bun } from '@vzn/vx-lockfile'

export default defineWorkspace({
  plugins: [
    bun(),
    dte({
      workers: { linux: { machines: { cpu4: { max: 2, cpu: 4, memory: '8GB' } } } },
      adapter: local({ prepare: 'bun install' }),
    }),
  ],
})
```

Workers see the files git tracks, your uncommitted edits included, so
`git add` new files first. `VX_DTE_RUN` names the run and turns
distribution on:

```sh
bun add -d @vzn/vx-dte
vx lock
git add -A
VX_DTE_RUN=$(uuidgen) vx run build --all
```

```ansi
[4m[58;2;110;118;129m  [1m[38;2;167;139;250mTasks[0m[4m[58;2;110;118;129m     [2mstatus  cache     ±usual    time   cpu    mem outputs  blocks worker         task[0m[4m[58;2;110;118;129m                           [0m
            [38;2;34;197;94msuccess[0m [2mmiss[0m        [2m+0ms[0m    [38;2;203;213;225m15ms[0m   [2m20%[0m  [2m1.8MB[0m      [2m3B[0m       [38;2;203;213;225m1[0m [38;2;96;165;250mlinux.cpu4[0m[2m#[0m[38;2;167;139;250m1[0m   [38;2;192;132;252m@demo/ui[0m[2m#[0m[38;2;244;114;182mbuild[0m
            [38;2;34;197;94msuccess[0m [2mmiss[0m        [2m+0ms[0m     [38;2;203;213;225m3ms[0m  [2m103%[0m  [2m1.8MB[0m      [2m2B[0m       [2m0[0m [38;2;96;165;250mlinux.cpu4[0m[2m#[0m[38;2;167;139;250m1[0m   [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;244;114;182mbuild[0m
  [2mworkers [0m  [38;2;96;165;250mlinux.cpu4[0m[2m#[0m[38;2;167;139;250m1[0m  stopped  2 done · warm-up 0.1s · @demo/ui#build, @demo/web#build
```

The `worker` column names who ran each task: worker 1 of the `linux.cpu4`
machines. The `workers` line says what each worker did, then that it stopped.

---

Run it again with nothing changed. Every task comes from the cache, so
no worker starts:

```ansi
  [2mcache   [0m  [38;2;34;197;94m▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰[0m
            [2mlocal[0m [38;2;34;197;94m2✓[0m

  [2mworkers [0m  [2mnone started: no task needed one[0m
```

Without `VX_DTE_RUN`, `vx run` runs on this machine as always. On
GitHub Actions the run names itself.

---

A task that reads a file git does not track fails, naming the file:

```ansi
[38;2;239;68;68m[vx] @demo/ui#build: plugin '@vzn/vx-dte' (executor 'dte') failed in execute: @demo/ui#build keys packages/ui/src/notes.ts, which git does not track, so no worker has it: git add it (and commit it for workers on CI), or leave it out of the task's inputs[0m
```

A worker builds on the bytes git stores, with its filters undone (line
endings, `ident`, LFS). A task whose input differs on disk, such as a
CRLF checkout, fails, naming it.

When it works here, [spread your CI run over several machines](../spread-ci-over-machines/).
