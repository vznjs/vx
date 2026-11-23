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

Workers check out what git tracks, so commit first. `VX_DTE_RUN` names
the run and turns distribution on:

```sh
bun add -d @vzn/vx-dte
vx lock
git add -A && git commit -m "try distributed task execution"
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

Without `VX_DTE_RUN`, `vx run` runs on this machine as always.

When it works here, [spread your CI run over several machines](../spread-ci-over-machines/).
