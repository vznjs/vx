---
title: 'Performance, modularity, extensibility. In that order.'
date: 2026-09-10T23:56:00Z
authors:
  - vzn
tags:
  - values
  - design
excerpt: 'Three drivers in a fixed order settle every design choice in vx, and nine principles follow from them. The list, with what each one has cost and bought.'
---

When two designs are both reasonable, the one that wins on the earlier
driver wins, and the choice is not reopened.

1. **Performance.** Measured, not asserted.
2. **Modularity.** Each module's `index.ts` is its contract. A test
   fails any import that goes around it.
3. **Extensibility.** A seam for every stage, a plugin for everything
   remote.

The order says what loses. A seam that costs a millisecond on the warm
path when no plugin fills it is not added until it costs nothing.

## The nine principles

**Perf first.** Measure before and after: two arms interleaved, min of
N, the "before" arm in its own git worktree. A warm-path change without
a number is not done. Lookahead scheduling felt obviously good, was
measured against plain critical-path priority, lost, and is rejected.

**Explicit over magical.** Caching is opt-in, `inputs.files` is
required, nothing is inferred. The sandbox is how a task proves what it
touches ([why](../explicit-over-magical/)).

**One command per task; the shell is the API.** A plugin changes where a
command runs, never what it is. No JavaScript-function tasks, no
executors wrapping tools in options objects.

**Resolved-config hashing.** The key sees the evaluated config object.
Imports, presets and computed values all count.

**Cascade through deps by folding upstream input keys, never outputs.**
Every key is known before anything runs. `--dry`, remote prefetch and
remote execution all stand on that
([early cutoff was tried and reverted](../cascade-through-inputs/)).

**Project boundaries are hard.** A glob never crosses into another
project. What a project needs from another comes through the graph.

**No defaults.** Core names no plugin. Only the local floor is implicit.
A remote is declared in `.vx/workspace.ts` or it does not exist.

**Seam over special case.** When core grows a branch for one consumer,
the seam is too narrow. The Turbo and Nx mappers and the history-based
scheduler left core for their own packages once their seam existed.

**Once per run.** Within a run, each fact is learned once: a file read
once, a path looked up once, a process asked once. A test traces a run
and fails on any repeat with no written reason.

## Rejected, and written down

Named inputs and global env. Input inference by tracing. Folding
`NODE_OPTIONS` into the key. Lookahead scheduling. A first-party
dashboard or cloud. Turbo's remote-cache wire in core. HTTP/3.

Each one was measured and lost, or breaks a principle above. The list
sits in the repository's memory file, read before any code is written.

## The rules hold in CI

vx builds and tests itself with vx. From this repository's
`.vx/projects.lock.json` on 2026-10-23:

| This repository                       | Count |
| ------------------------------------- | ----- |
| Tasks with a command                  | 148   |
| Run under vx's sandbox                | 132   |
| Not sandboxed, each with a reason     | 16    |
| Core test files                       | 714   |

The 16: nine shards of the suite a sandbox cannot host (the sandbox's
own tests among them, since a sandbox cannot nest), the REAPI suites and
their Docker services, one `npm` install for the Nx fixture, and two
checks that drive the sandbox themselves.

The rules learned the hard way are kept like lint rules: every fix must
fail without itself, a skip is a silent pass, and a feature is not done
until its docs land in the same commit.

More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
