---
title: 'Explicit over magical: why vx never guesses your inputs'
date: 2026-09-10T23:49:00Z
authors:
  - vzn
tags:
  - design
  - values
excerpt: "Auto-inferred inputs are the most requested feature vx will not build. A traced read set describes what a task read once, on one machine, after it ran. A cache key has to be right before the task runs, everywhere."
---

The most common first reaction to a `vx.config.ts` is: why do I have to
write `inputs: { files: ['src/**'] }`? Nx has `namedInputs` with a
default of everything. Turborepo defaults to every file in the package.
vite-task traces the filesystem and infers the set. Surely the tool
could work it out.

It could work *something* out. It could not work out the right thing,
and the difference is the whole reliability of the cache.

## What inference actually produces

A traced input set is the list of files a task opened *that time*, on
*that machine*, with *that* environment. It is a description of one
execution, gathered after the fact. Three things are wrong with using
it as a key:

1. **It arrives too late.** The key is needed before the task runs, to
   decide whether to run it. An inferred set can only key the *next*
   run, which means the first run on every new key is untraceable, and
   a remote cache cannot be consulted with a key that does not exist
   yet. vite-task, which does this well, has no remote cache for exactly
   this reason.
2. **It describes a path, not a dependency.** A build that reads
   `config/prod.json` when `NODE_ENV=production` and `config/dev.json`
   otherwise has two traces and one dependency set. A key from either
   trace is wrong for the other environment.
3. **It over-approximates in the direction that hurts.** `**` as a
   default input turns a README edit into a rebuild of every task in the
   package. Both Turbo's default and Nx's default do this; on
   solidjs/solid, Turbo's per-package `**` hashing is a visible part of
   the per-task overhead in the cold benchmark.

The explicit declaration is a statement about what the task *depends
on*, which is the thing a key must capture. Only the author of the
task can make that statement.

## The cost, honestly

The cost of a wrong declaration is asymmetric, and the asymmetry is
the argument:

- An **over-declared** input (a file listed that the task never reads)
  costs a spurious miss. The task re-runs. Annoying, visible, cheap.
- An **under-declared** input (a file read but not listed) costs a
  stale hit. The task does not run, the old output is restored, the
  check is green, and nothing downstream can tell. This is the worst
  failure a build cache can have.

Inference systematically produces the second kind, because a trace is
always of one execution and dependency sets are larger than any one
execution. Declaration lets you err toward the first kind, and it gives
you two tools to find the second: [`vx why`](../why-did-this-rerun/)
tells you when a task re-executed on an unchanged key, and the
[sandbox](../the-sandbox/) makes an undeclared read a hard failure that
names the path.

## Explicit everywhere else too

The same principle sets most of the schema:

- `cache` is opt-in. No block, no cache, and no default globs.
- `dependsOn` is explicit. There is no `--parallel` escape hatch because
  nobody has to over-declare edges to be safe; and there is sparse
  `^task` bridging, so a package that lacks `build` does not need a
  filler task for its dependents' `^build` to walk through it.
- Env reaches a task only through `exec.env`. A variable that changes
  the output goes under `cache.inputs.env` and joins the key; one that
  merely has to be present goes under `passThrough` and does not.
- The sandbox derives nothing from `cache`. What a task may *touch* and
  what *invalidates* it are two declarations, because when one was
  derived from the other, a path added for caching silently widened the
  sandbox.

Magic is a debt whose interest is paid by the person debugging the
stale hit. vx would rather you write one glob.
