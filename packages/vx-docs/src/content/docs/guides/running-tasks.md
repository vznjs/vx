---
title: Running & filtering tasks
description: Choose which packages a run covers with --all, --filter and --affected, pass arguments after --, and preview a run with --dry.
---

Run a task in the packages you mean, and see the plan first. Why only
what changed → [Chapter 7: Only what changed](../../guide/affected/)

## Steps

1. `vx run build` runs `build` in the package you are in, and what it depends on.
2. Add `--all` for every package, `--filter` for some, `--affected` for what changed.
3. Add `--dry` to see the plan and the predicted hits without running.
4. Put extra arguments after `--`. They reach the command and the cache key.
5. `vx watch test` re-runs a task whenever its files change.

## Commands

```bash
vx run build --all                     # every package that has build
vx run build --filter "@app/*"         # packages whose name matches
vx run build --filter "...@app/ui"     # a package and everything that depends on it
vx run test --affected                 # changed since the base branch, and dependents
vx run test --affected=origin/main     # changed since that ref
vx run app#build api#test              # exact tasks, from anywhere
vx run lint test build --all           # several tasks, one graph
vx run test -- --bail                  # the child runs: bun test "--bail"
vx run build --all --dry               # the plan, nothing runs
vx run build --graph=g.dot             # the task graph as Graphviz DOT
```

`--dry` prints what would run and where each result would come from:

```text
would run:
  ◉  @acme/api#build  cache hit (local)         8625b603
  ◉  @acme/ui#build   cache hit (local)         71e5d9a0
  ◉  @acme/web#build  cache hit (local)         42e9b39d

3 task(s) planned, 3 cache hits (3 local).
```

## Flags you will use

| Flag                | Does                                                        |
| ------------------- | ----------------------------------------------------------- |
| `--no-cache`        | ignore the cache: no reads, no writes                       |
| `--force`           | run everything, then refresh the cache                      |
| `--concurrency <n>` | at most n tasks at once (default: the cores you may use)    |
| `--continue`        | keep going after a failure ([modes](../tasks/#dependson))   |
| `--output-logs <m>` | `full`, `errors-only`, `hash-only` or `none`                |
| `--summarize`       | write a JSON summary of the run                             |
| `--frozen`          | run the graph in `vx-lock.json` ([CI](../ci/))             |

## Common problems

- **`--affected` needs history.** In a shallow clone it has no base: fetch with `fetch-depth: 0`.
- **Nothing ran.** `--affected` found no change since the base: vx says `nothing affected since <ref>`.
- **Only one package ran.** Without `--all`, `--filter` or `--affected`, vx runs the package you are in.

Every flag: [the CLI reference](../../cli/).
