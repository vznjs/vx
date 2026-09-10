---
title: Lockfile-aware caching
description: Declare pnpm(), bun(), npm() or yarn() from @vzn/vx-lockfile and a lockfile change re-keys only the projects whose dependencies it reaches — --affected selects the same set.
---

Out of the box, vx folds every lockfile at the workspace root into the
**workspace fingerprint** that is part of every task's cache key. That
is coarse but correct: any `pnpm install` that changes the file
invalidates every task, and `--affected` selects every project.

`@vzn/vx-lockfile` makes that precise with one plugin per package manager:
`pnpm()`, `bun()`, `npm()` and `yarn()`. Each reads its package manager's
lockfile and keys every task on its **own project's
resolved dependency closure**, so `pnpm update foo` (or `bun add foo`)
re-keys exactly the projects that reach `foo` and nothing else.

## Turn it on

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { pnpm } from '@vzn/vx-lockfile' // or bun, npm, yarn

export default defineWorkspace({
  plugins: [pnpm()], // or [bun()]
})
```

Nothing else changes. `vx why <task>` names the material as
`plugin @vzn/vx-lockfile/pnpm` (or `@vzn/vx-lockfile/bun`), and the
`workspace fingerprint` line no longer moves on a lockfile edit. vx's
own repository declares `bun()`: bumping one package's resolved
version in its `bun.lock` re-keys 2 of the gate's 61 tasks instead of
59.

## What counts as a project's dependencies

A project's digest covers every package it can reach. With `pnpm()`:

- its `dependencies`, `devDependencies` and `optionalDependencies`,
  transitively — through the lockfile's `snapshots` (pnpm 9) or
  `packages` (pnpm 7 and 8);
- each package by **name, version and resolved peers** —
  `foo@1(react@18)` and `foo@1(react@19)` are different `node_modules` —
  plus its resolution (integrity, tarball, commit) and any
  `patchedDependencies` entry for it;
- a `link:` dependency folds the linked workspace package's whole reach:
  what project A can import through workspace package B is B's closure;
- install-wide material every project folds: `lockfileVersion`,
  `settings`, `overrides`, `packageExtensionsChecksum`,
  `pnpmfileChecksum`.

With `bun()`, the same through Bun's hoisted layout: a dependency `d` of the
package at `node_modules` path `p` is `p/d` when the lockfile has that
key, else the nearest ancestor's, else the root's — so a nested version
counts for the package it is nested under and no other; each package by
its resolved id and integrity; a `workspace:` dependency folds the
linked package's reach; and `overrides`, `patchedDependencies` and
catalogs fold into every project.

With `npm()`, `package-lock.json` (lockfileVersion 2 and 3) the same
way through its `packages` map and `link: true` workspace entries. With
`yarn()`, berry lockfiles resolve per workspace through descriptors;
classic (yarn 1) lockfiles record no workspaces, so every project folds
one root digest — coarse, and honest about what the file records.

A project the lockfile has no entry for (outside the workspace's
`packages`) folds the root's digest — the only `node_modules` it can
resolve from. A phantom dependency (imported, never declared) is not in
any closure; declare it.

## `--affected` follows

`vx run test --affected=origin/main` after a lockfile change used to
select every project, because the file belongs to no project and
re-keyed all of them. With the plugin declared, vx hands it the lockfile
at the base ref and in the working tree; it digests both and names the
projects whose digest moved. A lockfile that appeared or was deleted
still selects everything — every project's `node_modules` is in
question.

## Cost

The lockfile is parsed **once per content**. The per-project digests
are memoised under the cache dir by the file's hash, so a warm run pays
one read and one hash of the file and one small JSON read — no YAML
parse. When the file does change, the digest is one hash per strongly
connected component of the dependency graph, children first: a
1000-project, 3000-package lockfile digests in about 20 ms.

## Options

| Option  | Values                               | Meaning                                                                                                                                     |
| ------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `scope` | `'project'` (default), `'workspace'` | `project`: each task folds its own closure. `workspace`: the whole file, as core folds it — the coarse key, through the plugin, if you want to adopt the claim before trusting the precision. |

## How it fits core

Each plugin uses two seams. `key` folds the per-project digest, like any
plugin adding key material. `fingerprint` **claims** the lockfile: core
takes the file out of the digest every task key folds (the
config-evaluation cache still keys on it — a config may import a
dependency), and asks the plugin the `--affected` question instead of
widening. Every plugin is a parser over core's `lockfileClaim`, which
owns the memo, the per-run read and the `--affected` diff — another
lockfile is a parser and nothing else. See
[Writing a vx plugin](../plugins/) for the seam.

## Next steps

- **[Caching tasks](../caching/)** — what else is in the key.
- **[Running & filtering tasks](../running-tasks/)** — `--affected` and
  the other selectors.
