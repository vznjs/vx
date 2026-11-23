---
title: Run one task on a different machine
description: Give a worker type its own machines and name it on the task with exec.worker.
---

Declare a second worker type and name it on the task. Here end-to-end
tests get machines of their own, and every other task runs on `linux`.

```ts title=".vx/workspace.ts" ins={4}
dte({
  workers: {
    linux: { machines: { cpu4: { max: 8, cpu: 4, memory: '8GB' } } },
    e2e: { machines: { cpu4: { max: 2, cpu: 4, memory: '8GB' } } },
  },
  adapter: github(),
}),
```

```ts title="apps/web/vx.config.ts" mark={3}
e2e: {
  dependsOn: ['build'],
  exec: { command: 'playwright test', worker: 'e2e' },
  inputs: { files: ['src/**', 'tests/**'] },
},
```

Run `vx lock`, then `vx dte init` to add the new machines to
`vx-worker.yml`. The run puts `e2e` on its own worker:

```ansi
[4m[58;2;110;118;129m  [1m[38;2;167;139;250mTasks[0m[4m[58;2;110;118;129m     [2mstatus  cache     ±usual    time   cpu    mem outputs  blocks worker         task[0m[4m[58;2;110;118;129m                           [0m
            [38;2;34;197;94msuccess[0m [2mmiss[0m        [2m+1ms[0m    [38;2;203;213;225m16ms[0m   [2m24%[0m  [2m1.8MB[0m      [2m3B[0m       [38;2;203;213;225m2[0m [38;2;96;165;250mlinux.cpu4[0m[2m#[0m[38;2;167;139;250m1[0m   [38;2;192;132;252m@demo/ui[0m[2m#[0m[38;2;244;114;182mbuild[0m
            [38;2;34;197;94msuccess[0m [2mmiss[0m        [2m+0ms[0m     [38;2;203;213;225m3ms[0m  [2m141%[0m  [2m1.8MB[0m      [2m3B[0m       [38;2;203;213;225m1[0m [38;2;96;165;250mlinux.cpu4[0m[2m#[0m[38;2;167;139;250m1[0m   [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;244;114;182mbuild[0m
            [38;2;34;197;94msuccess[0m [2mmiss[0m        [2m+1ms[0m    [38;2;203;213;225m19ms[0m    [2m5%[0m  [2m1.7MB[0m      [2m0B[0m       [2m0[0m [38;2;244;114;182me2e.cpu4[0m[2m#[0m[38;2;167;139;250m1[0m     [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;147;197;253me2e[0m
  [2mworkers [0m  [38;2;244;114;182me2e.cpu4[0m[2m#[0m[38;2;167;139;250m1[0m    stopped  1 done · warm-up 0.2s · @demo/web#e2e
  [2m        [0m  [38;2;96;165;250mlinux.cpu4[0m[2m#[0m[38;2;167;139;250m1[0m  left     2 done · warm-up 0.1s · @demo/ui#build, @demo/web#build
```

`linux.cpu4#1` built both projects and left when nothing was left for it.
`e2e.cpu4#1` ran only the tests.

---

- A task with no `exec.worker` goes to the first type that fits, so a
  type listed last gets only the tasks named for it.
- On your machine, and in a run with no `dte()`, `exec.worker` is ignored.
  It never changes a cache key.

See [What runs where](../../../docs/distributed-task-execution/#what-runs-where).
