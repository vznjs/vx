---
title: 'A lockfile bump should re-key two tasks, not sixty'
date: 2026-09-10
authors:
  - vzn
tags:
  - caching
  - plugins
excerpt: "Every monorepo tool folds the lockfile into every key, so `pnpm update` invalidates the world. @vzn/vx-lockfile parses the lockfile and keys each task on its own project's dependency closure. In vx's own repo that turned 59 re-keyed tasks into 2."
---

Out of the box, vx does what everyone does with the lockfile: it goes
into the workspace fingerprint, and the workspace fingerprint is in
every task's key. That is coarse but correct. Any `pnpm install` that
changes `pnpm-lock.yaml` invalidates every cached task, and `--affected`
selects every project.

It is also the single largest source of "why did everything rebuild"
in a large workspace. A patch bump to a test utility used by one
package re-runs the builds of all of them.

## Key each project on what it can reach

`@vzn/vx-lockfile` ships one plugin per package manager: `pnpm()`,
`bun()`, `npm()`, `yarn()`. Each claims its lockfile out of the
workspace fingerprint through the `fingerprint` seam and instead
contributes, per task, a digest of **its project's resolved dependency
closure**:

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { pnpm } from '@vzn/vx-lockfile'

export default defineWorkspace({ plugins: [pnpm()] })
```

Nothing else changes. `vx why` names the material as
`plugin @vzn/vx-lockfile/pnpm`, and the workspace fingerprint line
stops moving when the lockfile is edited.

The closure is exactly what the project's `node_modules` can resolve:

- its `dependencies`, `devDependencies` and `optionalDependencies`,
  transitively through the lockfile's own resolution graph;
- each package by name, version **and resolved peers**, because
  `foo@1(react@18)` and `foo@1(react@19)` are different directories on
  disk, plus its integrity and any patch applied to it;
- a `link:` or `workspace:` dependency folds the linked workspace
  package's whole reach, since what A can import through B is B's
  closure;
- install-wide material every project folds: `lockfileVersion`,
  `overrides`, `settings`, `patchedDependencies`, catalogs.

`bun()` does the same through Bun's hoisted layout (a nested version
counts for the package it is nested under and no other); `npm()`
through `package-lock.json`'s `packages` map; `yarn()` per workspace
through berry's descriptors. Yarn classic records no workspaces, so
every project folds one root digest, which is coarse and honest about
what that file contains.

A phantom dependency, imported but never declared, is in no closure.
Declare it.

## `--affected` follows the same claim

The plugin's `affected(change)` hook answers the selection question
too. `vx run test --affected` with a lockfile diff selects the projects
whose closure the diff reaches, not every project. The rule that keys a
task and the rule that selects it are one rule, so they cannot drift.

## Measured in the repository that ships it

vx's own repository declares `bun()`. Bumping one package's resolved
version in `bun.lock` re-keys 2 of the gate's 61 tasks instead of 59.
That is the whole pitch, in one number: a dependency change costs what
the dependency change touches.

The plugin is separate from core on purpose. Core owns the `fingerprint`
seam, the memo and the per-run gate; the lockfile *parsers* are
package-manager knowledge, and package-manager knowledge changes on the
package manager's schedule. The guide is [Lockfile-aware
caching](../../guides/lockfiles/).
