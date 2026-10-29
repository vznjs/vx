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
[1mwould run:[0m
  [38;2;234;179;8m▶[0m  [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;244;114;182mbuild[0m  [38;2;234;179;8mcache miss — would exec [0m  [2m47fb6826[0m[2m  ~14ms[0m
  [38;2;234;179;8m▶[0m  [38;2;192;132;252m@demo/ui[0m[2m#[0m[38;2;244;114;182mbuild[0m   [38;2;234;179;8mcache miss — would exec [0m  [2mea61da13[0m[2m  ~14ms[0m

[2m2 task(s) planned, 2 would run.[0m
[2mpredicted: ~28ms wall · ~28ms total execution[0m
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
