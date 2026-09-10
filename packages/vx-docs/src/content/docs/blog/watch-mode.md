---
title: 'Watch: a content gate, not an event storm'
date: 2026-09-10T23:34:00Z
authors:
  - vzn
tags:
  - dx
  - execution
excerpt: "vx watch does not filter filesystem events against your input globs. It re-runs the graph and lets the cache key decide, which is tens of milliseconds for an irrelevant edit and exactly right for a relevant one."
---

`vx watch test --all` runs `test` in every project, then re-runs it on
every change. The interesting design decisions are in what it refuses
to do.

## No per-event glob matching

The tempting design is to compare each filesystem event against each
task's `cache.inputs.files` and re-run only the tasks whose inputs
matched. vx does not do this, because the cache key is already the
source of truth for "does this change matter to this task," and a
second copy of that rule, written in terms of events instead of hashes,
would drift from the first.

Instead, every change triggers a cycle, the cycle is the same code path
as `vx run`, and the key decides. A change to an irrelevant file
produces a fully cached cycle, typically tens of milliseconds. A change
to a relevant one produces exactly the re-runs the graph implies,
including downstream tasks, because the cascade is the key's, not the
watcher's. The engineering cost of a per-event matcher is much larger
than the cost of a cheap cycle, and the correctness cost of two rules
is larger still.

## The content gate

A task that writes into its own project is the classic watch-mode
trap: it writes, the watcher sees the write, the task re-runs, forever.
The usual fix is a list of ignored paths, which fails for any task
whose writes were not declared.

vx ignores the declared outputs of every task in scope (and their
containing directories, so a `dist/**` glob does not re-trigger on the
`dist` directory being created). For everything else it gates on
**content**: a file whose bytes did not change since the loop last saw
it is not an edit. A task that rewrites its own files costs one extra
cycle, which the cache serves, and then settles.

Always ignored regardless: `node_modules`, `.git`, `.vx`, the run's
resolved cache directory wherever `--cache-dir` put it, `.tsbuildinfo`
files and editor swap files.

## Watchers that are actually watching

On macOS a directory watcher can return before its event stream is
live, and an edit in that gap is silently lost. vx writes a probe file
under every watcher and does not print `vx watch: watching …` until
each probe's event has arrived, re-writing on a short backoff. The line
is a promise, not a hope. A watcher that stays silent for two seconds
is kept with a warning that early edits there may be missed.

The workspace root is watched non-recursively so a lockfile or
`pnpm-workspace.yaml` edit is heard; those move the workspace
fingerprint, or, with `@vzn/vx-lockfile`, the keys of the projects they
reach.

## The rest of the contract

- Events during a cycle queue and drain after it; re-runs are debounced
  about 150 ms after the last event.
- A failed cycle prints its failure and waits for the next change; it
  does not exit the loop. That matches `turbo watch` and `nx watch`.
- Ctrl-C prints `vx watch: stopped`, tears down the in-flight cycle's
  children and exits 0 only once they are gone.
- Flags that describe one run (`--dry`, `--summarize`, `--report`,
  `--profile`) are rejected up front, because a loop has no single run.
- Persistent tasks re-spawn each cycle. For a server that should stay
  up across edits, the tool's own watch (`vite`, `tsc -b -w`) is the
  right layer.

Reference: [`vx watch`](../../cli/#vx-watch).
