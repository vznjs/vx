---
title: Run one project's tasks
description: Use --filter to pick projects by name, folder, or dependency.
---

Use `--filter` to run a task in one project. The tasks it depends on
still run first.

```sh
vx run build --filter @demo/web --dry
```

```ansi
[4m[58;2;110;118;129m  [1m[38;2;167;139;250mPlan[0m[4m[58;2;110;118;129m [2m2[0m[4m[58;2;110;118;129m    [2mstatus  cache      usual    time   cpu    mem outputs  blocks worker         task[0m[4m[58;2;110;118;129m[0m
            [38;2;6;182;212mrun[0m     [2mmiss[0m        [2m~6ms[0m       [2m—[0m     [2m—[0m      [2m—[0m       [2m—[0m       [2m0[0m [2mlocal[0m          [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;244;114;182mbuild[0m
            [38;2;6;182;212mrun[0m     [2mmiss[0m       [2m~12ms[0m       [2m—[0m     [2m—[0m      [2m—[0m       [2m—[0m       [38;2;203;213;225m1[0m [2mlocal[0m          [38;2;192;132;252m@demo/ui[0m[2m#[0m[38;2;244;114;182mbuild[0m

  [2mtasks    [0m  [38;2;203;213;225m2 planned · 2 would run[0m
  [2mpredicted[0m  [38;2;203;213;225m~18ms wall · ~18ms total execution[0m
```

From inside `packages/web`, `vx run build` does the same: with no filter, vx
runs the project you are in.

---

A filter can also take a folder or follow dependencies:

| Filter | Selects |
| --- | --- |
| `@demo/*` | every project whose name matches |
| `./packages/web` | the project in that folder |
| `web...` | `web` and everything it depends on |
| `...ui` | `ui` and everything that depends on it |
| `!docs` | everything else, without `docs` |

```sh
vx run test --filter '...@demo/ui'
vx run lint --all --filter '!@demo/docs'
```

See [`--filter`](../../../cli/run/#filter-dsl---filter).
