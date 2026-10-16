---
title: 'A glob that stops at the fence'
date: 2026-10-12T17:00:00Z
authors:
  - vzn
tags:
  - caching
  - correctness
excerpt: 'In a monorepo, projects nest. A root package that globs **/* would otherwise hash, and clean, every member under it. vx draws a fence at every nested project, so a key sees only its own project, and a change elsewhere reaches it only through a declared edge.'
---

Monorepos nest. The workspace root is often a package itself, and
`apps/web` can sit inside a folder that is also a project. So the
question every cache has to answer is: when a task in the outer project
says `src/**` or `**/*`, which files does it mean?

vx's answer: **only its own.** A project's globs never reach into
another project's directory, even when the pattern would match.

## Why the fence matters

Without a fence, a root task that declares `**/*.ts` as its inputs
hashes every TypeScript file in every member. Each edit anywhere then
re-runs the root task, so the key is too wide to be useful. And it is
wrong in a quieter way: the root now depends on its members through a
side door that no `dependsOn` edge describes, so `--affected` and the
task graph disagree with the cache about what depends on what.

Outputs have the same problem in reverse. A root task that declares
`outputs.files: ['**/*.js']` owns those files, and vx wipes a task's
declared outputs before every run and restore. Without a fence, that
wipe would reach into members and delete their sources.

## How it works

Once per run, vx computes, for each project, the directories of the
projects nested under it (`workspace/nested-dirs.ts`). Every glob pass
drops a path under one of them, for inputs and for the output clean
alike. A workspace package counts as a project whether or not it has a
`vx.config.ts`, because `--affected` hands it its own files and its
default `build` keys them.

The nesting check is a sort and one scan, with a trap worth naming.
Sorted as strings, `foo`, `foo-utils` and `foo/nested` come out in that
order, because `-` sorts below `/`. A scan that stopped at the first
non-descendant would stop at `foo-utils` and never see `foo/nested`, so
the fence would silently have a hole. vx skips names that merely share
the prefix and stops only when it leaves the `foo` block.

## The one way across

If project A needs B's state, it says so with an edge: `dependsOn` B's
task. B's input key is then folded into A's, so an edit in B re-runs A,
and the graph, `--affected` and the cache all agree. That is the only
way one project's key moves when another project's files change.

With the sandbox on, the fence is enforced at run time too. A workspace
package reached through a `node_modules` link is visible to the task
only when its key folds a task of that package. Import a sibling the
key never sees and the read fails and is reported, instead of caching a
result an edit there would not re-run.

## The escape hatch

`inputs.workspaceFiles` and `cache.outputs.workspaceFiles` are
anchored at the workspace root and apply no fence. They exist for files
that genuinely belong to the root, like a shared `tsconfig.base.json`.
Reaching into another project's directory through them works, but it is
the side door again, so prefer an edge.

## What you get

A key that means one project. An output clean that cannot delete a
neighbour's source. And a graph you can read, because every
cross-project dependency is an edge you wrote. Details:
[Caching, cross-project boundaries](../../caching/#cross-project-boundaries).
