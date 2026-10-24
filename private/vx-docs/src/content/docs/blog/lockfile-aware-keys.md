---
title: 'A lockfile bump should re-key two tasks, not sixty'
date: 2026-09-10T23:46:00Z
authors:
  - vzn
tags:
  - caching
  - plugins
excerpt: "Core keys no lockfile, and folding the whole file into every key would make `pnpm update` invalidate the world. @vzn/vx-lockfile parses the lockfile and keys each task on its own project's dependency closure. In vx's own repo an astro bump re-keys 6 of 57 tasks, not all 57."
---

Bump one package in this repository's `bun.lock` and ask which keys
move:

```sh frame="terminal"
$ sed -i 's/"astro@7.3.3"/"astro@7.3.4"/' bun.lock
$ vx run ci --all --dry=json | jq … | diff before -
8 of 151 tasks re-key:
  @vzn/vx-docs#build  #build.images  #ci  #import
  @vzn/vx-docs#lint   #lint.oxfmt    #lint.oxlint  #test
```

Only the docs site reaches `astro`, so only its tasks re-key. Linux
x64, vx at `69617eb`, 2026-10-23, `bun()` from `@vzn/vx-lockfile`.

Core keys no lockfile, no install setting and no `package.json`.
Without a lockfile plugin an install re-keys nothing, and a build made
against the old `node_modules` replays. Folding the whole lockfile into
every key is correct but coarse: a patch bump to one test utility
re-runs everything. (Turborepo keys each package on the lockfile
changes that reach it.)

## Key each project on what it can reach

`@vzn/vx-lockfile` ships one plugin per package manager: `pnpm()`,
`bun()`, `npm()`, `yarn()`. Each claims its lockfile through the
`fingerprint` seam and contributes, per task, a digest of **its project's resolved dependency
closure**:

```ts
// .vx/workspace.ts
import { defineWorkspace } from '@vzn/vx/config'
import { pnpm } from '@vzn/vx-lockfile'

export default defineWorkspace({ plugins: [pnpm()] })
```

Nothing else changes. `vx why` names the material as
`plugin @vzn/vx-lockfile/pnpm`, for exactly the projects a lockfile
edit reaches.

The closure is exactly what the project's `node_modules` can resolve:

- its `dependencies`, `devDependencies` and `optionalDependencies`,
  transitively through the lockfile's own resolution graph;
- each package by name, version **and resolved peers**, because
  `foo@1(react@18)` and `foo@1(react@19)` are different directories on
  disk, plus its integrity and any patch applied to it;
- a `link:` or `workspace:` dependency folds the linked workspace
  package's whole reach, since what A can import through B is B's
  closure;
- install-wide material every project folds: the lockfile version and
  fields such as pnpm's `settings`. Under `pnpm()` and `bun()`,
  overrides, catalogs and patches count only where they reach.
- the root package's own closure, folded into every project: the
  root's tools run from the root `node_modules/.bin` on every task's
  PATH.

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

As above, bumping `astro`, which only the docs site reaches, re-keys 8
of the 151 tasks in `vx run ci --all`.

The root's closure is in every key: root tools run from the root
`node_modules/.bin` on every task's PATH. This repository's root links
seven of its packages as devDependencies, so bumping `protobufjs`
(reached through `@vzn/vx-reapi`) re-keys every task, all 151. A
dependency change costs what it touches, and the root touches every
task.

The plugin is separate from core on purpose. Core owns the `fingerprint`
seam, the memo and the per-run gate; the lockfile *parsers* are
package-manager knowledge, and package-manager knowledge changes on the
package manager's schedule. The guide is
[Lockfiles](../../docs/lockfiles/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
