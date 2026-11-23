---
title: Run the same checks locally and on CI
description: Save a run under a name in .vx/workspace.ts, then call it with vx pipeline on your machine and on CI.
---

A pipeline is a run saved under a name. Write it once in
`.vx/workspace.ts`, and you and CI run exactly the same thing.

```ts title=".vx/workspace.ts" mark={6-7}
import type { WorkspaceConfig } from '@vzn/vx/config'
import { bun } from '@vzn/vx-lockfile'

export default {
  plugins: [bun()],
  pipelines: {
    pr: { tasks: ['build', 'test'], affected: true },
    main: { tasks: ['build', 'test'] },
  },
} satisfies WorkspaceConfig
```

`pr` runs `build` and `test` only where your branch changed something.
`main` runs them in every project. A pipeline needs no `vx lock`:
`vx pipeline` reads it from the file.

---

On a branch, check what `pr` would run with `--dry`:

```sh
vx pipeline pr --dry
```

```ansi
[4m[58;2;110;118;129m  [1m[38;2;167;139;250mPlan[0m[4m[58;2;110;118;129m [2m3[0m[4m[58;2;110;118;129m    [2mstatus  cache      usual    time   cpu    mem outputs  blocks worker         task[0m[4m[58;2;110;118;129m                           [0m
            [38;2;6;182;212mrun[0m     [2mmiss[0m        [2m~3ms[0m       [2m—[0m     [2m—[0m      [2m—[0m       [2m—[0m       [2m0[0m [2mlocal[0m          [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;244;114;182mbuild[0m  [2maffected: packages/web/src/index.ts changed (an input)[0m
            [38;2;34;197;94mcached[0m  [38;2;56;189;248mlocal[0m          [2m—[0m       [2m—[0m     [2m—[0m      [2m—[0m       [2m—[0m       [38;2;203;213;225m1[0m [2mlocal[0m          [38;2;192;132;252m@demo/ui[0m[2m#[0m[38;2;244;114;182mbuild[0m
            [38;2;6;182;212mrun[0m     [2mno-cache[0m   [2m~1.0s[0m       [2m—[0m     [2m—[0m      [2m—[0m       [2m—[0m       [2m0[0m [2mlocal[0m          [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;96;165;250mtest[0m  [2maffected: packages/web/src/index.ts changed (in its project)[0m

  [2mtasks    [0m  [38;2;203;213;225m3 planned · 1 cache hit (1 local) · 1 would run · 1 no-cache[0m
  [2mpredicted[0m  [38;2;203;213;225m~1.01s wall · ~1.01s total execution[0m
```

Only `packages/web` changed. `@demo/ui#build` is listed because
`@demo/web#build` needs it, and it comes from the cache.

---

On CI, call the same names:

```yaml title=".github/workflows/ci.yml"
- run: bun vx lock --check
- if: github.event_name == 'pull_request'
  run: bun vx pipeline pr
- if: github.event_name == 'push'
  run: bun vx pipeline main
```

`vx lock --check` fails the job when a config changed without `vx lock`
([guide](../check-the-lock/)).

:::note
On `main` itself, `pr` has nothing to compare with, so vx refuses it.
Run `main` there: the cache still skips what did not change.
:::

:::tip[Next]
One CI job too slow? [Spread the run over several machines](../../../docs/distributed-task-execution/spread-ci-over-machines/).
:::

See [`vx pipeline`](../../../cli/pipeline/) and [CI](../../../docs/ci/).
