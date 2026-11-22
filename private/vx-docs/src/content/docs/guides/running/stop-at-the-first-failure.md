---
title: Stop at the first failure
description: Use --fail-fast to stop the whole run as soon as one task fails.
---

By default, a failed task stops only the tasks that wait for it. Every
other task still runs, so one run shows you every failure.

```sh
vx run test --all
```

```ansi
[4m[58;2;110;118;129m  [1m[38;2;167;139;250mTasks[0m[4m[58;2;110;118;129m     [2mstatus  cache     ±usual    time   cpu    mem outputs  blocks worker         task[0m[4m[58;2;110;118;129m                           [0m
            [38;2;239;68;68mfailed[0m  [2mno-cache[0m       [2m—[0m    [38;2;203;213;225m12ms[0m    [2m9%[0m  [2m1.7MB[0m       [2m—[0m       [2m0[0m [2mlocal[0m          [38;2;192;132;252m@demo/ui[0m[2m#[0m[38;2;96;165;250mtest[0m
            [38;2;34;197;94msuccess[0m [2mno-cache[0m       [2m—[0m   [38;2;203;213;225m1.01s[0m    [2m0%[0m  [2m3.6MB[0m       [2m—[0m       [2m0[0m [2mlocal[0m          [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;96;165;250mtest[0m

[2m┌─[0m [1m[38;2;192;132;252m@demo/ui[0m[2m#[0m[1m[38;2;96;165;250mtest[0m [2m>[0m [1m[38;2;239;68;68mfailed (exit 1)[0m

[2m$ echo 'expected 2, got 1' && exit 1[0m

[2m├─[0m [1mOUTPUT[0m [2m────────────────────────────────────────────────────[0m

expected 2, got 1

[2m└─[0m [1m[38;2;192;132;252m@demo/ui[0m[2m#[0m[1m[38;2;96;165;250mtest[0m [2m──[0m [2m(12ms)[0m [1m[38;2;239;68;68mfailed (exit 1)[0m
```

`@demo/ui#test` failed, and `@demo/web#test` still ran to the end. vx
exits `1`.

---

To stop at once instead, add `--fail-fast`. The first failure kills the
tasks still running and ends the run:

```sh
vx run test --all --fail-fast
```

```ansi
[4m[58;2;110;118;129m  [1m[38;2;167;139;250mTasks[0m[4m[58;2;110;118;129m     [2mstatus  cache     ±usual    time   cpu    mem outputs  blocks worker         task[0m[4m[58;2;110;118;129m                           [0m
            [38;2;239;68;68mfailed[0m  [2mno-cache[0m       [2m—[0m    [38;2;203;213;225m12ms[0m    [2m9%[0m  [2m1.7MB[0m       [2m—[0m       [2m0[0m [2mlocal[0m          [38;2;192;132;252m@demo/ui[0m[2m#[0m[38;2;96;165;250mtest[0m
            [38;2;249;115;22maborted[0m [2m—[0m              [2m—[0m    [38;2;203;213;225m19ms[0m     [2m—[0m      [2m—[0m       [2m—[0m       [2m0[0m [2mlocal[0m          [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;96;165;250mtest[0m
```

`@demo/web#test` shows `aborted`: vx stopped it when `@demo/ui#test`
failed. Use this when one failure makes the rest pointless.

---

To make it the default for a [pipeline](../../ci/run-a-pipeline/), set
`failFast: true` on it in `.vx/workspace.ts`:

```ts title=".vx/workspace.ts" mark={5}
import type { WorkspaceConfig } from '@vzn/vx/config'

export default {
  pipelines: {
    pr: { tasks: ['build', 'test'], affected: true, failFast: true },
  },
} satisfies WorkspaceConfig
```

See [When a task fails](../../../docs/tasks/#when-a-task-fails).
