---
title: 'Watch: a content gate, not an event storm'
date: 2026-09-10T23:34:00Z
authors:
  - vzn
tags:
  - dx
  - execution
excerpt: "vx watch doesn't match file events against your input globs. It re-runs the graph and lets the cache key decide: an irrelevant edit runs nothing, a relevant one runs exactly what it reaches."
---

`vx watch` runs your tasks, then runs them again on every change. Here
is one README edit and one source edit in the same project:

```sh frame="terminal"
$ vx watch build test --all
watching 4 projects · 8 tasks

changed packages/c README.md

changed packages/c src/index.ts
 ⏺︎     7ms success miss     packages/c#build
 ⏺︎    20ms success miss     packages/c#test
```

The README is in no task's inputs, so its cycle runs nothing. The source
edit runs `build` and `test` in `c`, and would run anything downstream.

```
README edit → "changed" line shown    154–161 ms   (5 runs)
src edit    → test finished           180–195 ms   (5 runs)
```

Linux x64, 4 cores, vx at `0be0367`, 2026-10-23. About 150 ms of each
is the debounce.

## The key decides, not the event

The tempting design matches each file event against each task's
`inputs.files`. vx doesn't. The cache key already answers "does this
change matter to this task", and a second rule written in events would
drift from it. So every change runs a cycle on the same code path as
`vx run`, and the key decides. Downstream re-runs come from the key's
cascade, not from the watcher.

## The content gate

A task that writes into its own project is the classic trap: it writes,
the watcher sees it, the task runs again, forever.

vx ignores the declared outputs of every task in scope, and their
directories. For everything else it gates on **content**: a file whose
bytes didn't change since the loop last saw it is not an edit. A task
that rewrites its own files costs one extra cycle, which the cache
serves, and then it settles.

Always ignored: `node_modules`, `.git`, `.vx/cache`, the run's cache
directory wherever `--cache-dir` put it, editor backups (a trailing
`~`), and any untracked path git ignores (one `git check-ignore` per
debounce window).

## Watchers that are really watching

On macOS a watcher can return before its event stream is live, and an
edit in that gap is lost. vx writes a probe file under every watcher and
prints `watching` only after each probe's event arrives. A directory
whose watcher stays silent for
two seconds is polled instead, with a warning.

The workspace root is watched too (not recursively), so a lockfile edit
is heard.

## The rest

- Events during a cycle queue; re-runs fire about 150 ms after the last
  event.
- A failed cycle prints its failure and waits for the next change.
- Ctrl-C prints `vx watch: stopped`, tears down the cycle's children,
  and exits 0 once they are gone.
- Flags that describe one run (`--dry`, `--profile`, `--verbosity`
  above 0) are refused up front: a loop has no single run.
- A persistent task starts once and stays up. It restarts only when its
  own config or forwarded args change, or when it dies.

Reference: [`vx watch`](../../cli/#vx-watch). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
