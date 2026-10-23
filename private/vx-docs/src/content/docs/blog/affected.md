---
title: 'Run only what a change reaches'
date: 2026-10-08T23:40:00Z
authors:
  - vzn
tags:
  - ci
  - dx
excerpt: 'vx run test --affected runs the projects your branch changed and every project downstream of them. Nothing else starts, and what it skips it can explain.'
---

The branch edits one file in `packages/a`. `packages/c#build` depends
on `packages/a#build`:

```sh frame="terminal"
$ vx run build test --affected=master --dry
would run:
  ▶  packages/a#build  cache miss — would exec   6802a43d  ~10ms
                       affected: packages/a/src/index.ts changed (an input)
  ▶  packages/c#build  cache miss — would exec   24d525d5  ~8ms
                       affected: packages/a/src/index.ts changed (an input), via packages/a#build
  ▶  packages/a#test   cache miss — would exec   d0093233  ~11ms
                       affected: packages/a/src/index.ts changed (an input)

3 task(s) planned, 3 would run.

$ vx run build test --affected=master
 ⏺︎     8ms success miss     packages/a#test
 ⏺︎    17ms success miss     packages/a#build
 ⏺︎     8ms success miss     packages/c#build
  projects  2 affected · 5 total
  tasks     3 success · 3 total
```

Three of eight tasks, each with the reason it was picked. `c#test`
doesn't read `a`, so it isn't in the set. Demo workspace, vx at
`69617eb`, 2026-10-23.

## Which base

`--affected` compares against a git base. Name one (`--affected=main`),
or let vx pick: on a pull request, `github()` names the PR's base commit;
elsewhere vx takes the merge base with the base branch (`origin/HEAD`'s
branch, else `main` or `master`, or `baseBranch` in `.vx/workspace.ts`).
On the base branch itself there is no default: pass the last commit that
passed, `--affected=<sha>`.

It is sugar for a filter, `--filter "...[<base>]"`: the projects changed
since the base, and their dependents. So it combines with any other
filter, and `vx show --affected` lists the projects without running.

## Why the cache still matters

`--affected` decides which projects are in the run. The cache key still
decides which tasks execute. A file outside every task's inputs, a
README say, puts its project in the set, and every task there is a hit.

## The edges are task edges

vx follows the task graph, not only `package.json`. Above, `c` has no
package dependency on `a`; its `build` is downstream through
`dependsOn`. The set is what your tasks really depend on.

Reference: [the CLI](../../cli/#--affectedbase). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
