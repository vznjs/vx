---
title: Run one project's tasks
description: Use --filter to pick projects by name, folder, or dependency.
---

Use `--filter` to run a task in one project. The tasks it depends on
still run first.

```sh
vx run build --filter @demo/web --dry
```

```text
would run:
  ▶  @demo/web#build  cache miss — would exec   3bc7cf82  ~5ms
  ▶  @demo/ui#build   cache miss — would exec   ea371b1a  ~9ms

2 task(s) planned, 2 would run.
predicted: ~14ms wall · ~14ms total execution
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
