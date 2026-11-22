---
title: Build a project's dependencies first
description: Use dependsOn '^build' so a package builds after the packages it uses.
---

Add `'^build'` to a task's `dependsOn`. vx then runs `build` in every
package this one depends on, before this task starts.

```ts title="packages/web/vx.config.ts" mark={6}
import type { ProjectConfig } from '@vzn/vx/config'

export default {
  tasks: {
    build: {
      dependsOn: ['^build'],
      exec: { command: 'vite build' },
      inputs: { files: ['src/**'] },
      outputs: { files: ['dist/**'] },
      cache: true,
    },
  },
} satisfies ProjectConfig
```

The `^` means "in my dependencies". vx reads them from `package.json`, so
here `@demo/web` waits for `@demo/ui`:

```json title="packages/web/package.json"
{ "name": "@demo/web", "dependencies": { "@demo/ui": "workspace:*" } }
```

Run `vx lock` after the edit. Then add `--dry` to see the order without
running anything:

```sh
vx run build --dry
```

```ansi
[4m[58;2;110;118;129m  [1m[38;2;167;139;250mPlan[0m[4m[58;2;110;118;129m [2m2[0m[4m[58;2;110;118;129m    [2mstatus  cache      usual    time   cpu    mem outputs  blocks worker         task[0m[4m[58;2;110;118;129m                           [0m
            [38;2;6;182;212mrun[0m     [2mmiss[0m           [2m—[0m       [2m—[0m     [2m—[0m      [2m—[0m       [2m—[0m       [2m0[0m [2mlocal[0m          [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;244;114;182mbuild[0m
            [38;2;6;182;212mrun[0m     [2mmiss[0m           [2m—[0m       [2m—[0m     [2m—[0m      [2m—[0m       [2m—[0m       [38;2;203;213;225m1[0m [2mlocal[0m          [38;2;192;132;252m@demo/ui[0m[2m#[0m[38;2;244;114;182mbuild[0m

  [2mtasks   [0m  [38;2;203;213;225m2 planned · 2 would run[0m
```

`blocks 1` on `@demo/ui#build` means one task waits for it. Drop `--dry`
and vx builds `@demo/ui` first, then `@demo/web`.

---

`dependsOn` takes other forms too:

| `dependsOn` | Runs first |
| --- | --- |
| `'^build'` | `build` in each package this one depends on |
| `'codegen'` | `codegen` in this package |
| `'@demo/api#build'` | `build` in the `@demo/api` package |

:::note
`^` follows the lockfile plugin `vx init` declares in `.vx/workspace.ts`,
such as `bun()`. Without one, `vx lock` refuses `^build` and says so.
:::

See [`dependsOn`](../../../docs/tasks/#dependson).
