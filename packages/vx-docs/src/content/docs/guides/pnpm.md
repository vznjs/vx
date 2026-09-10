---
title: pnpm lockfile-aware caching
description: Declare pnpm() from @vzn/vx-pnpm and a pnpm-lock.yaml change re-keys only the projects whose dependencies it reaches — --affected selects the same set.
---

Out of the box, vx folds every lockfile at the workspace root into the
**workspace fingerprint** that is part of every task's cache key. That
is coarse but correct: any `pnpm install` that changes the file
invalidates every task, and `--affected` selects every project.

`@vzn/vx-pnpm` makes that precise. It reads `pnpm-lock.yaml` and keys
each task on its **own project's resolved dependency closure**, so
`pnpm update foo` re-keys exactly the projects that reach `foo` and
nothing else.

## Turn it on

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { pnpm } from '@vzn/vx-pnpm'

export default defineWorkspace({
  plugins: [pnpm()],
})
```

Nothing else changes. `vx why <task>` names the material as
`plugin @vzn/vx-pnpm/deps`, and the `workspace fingerprint` line no
longer moves on a lockfile edit.

## What counts as a project's dependencies

A project's digest covers every package it can reach:

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

A project the lockfile has no importer for (outside
`pnpm-workspace.yaml`'s `packages`) folds the root importer's digest —
the only `node_modules` it can resolve from. A phantom dependency
(imported, never declared) is not in any closure; declare it.

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

The plugin uses two seams. `key` folds the per-project digest, like any
plugin adding key material. `fingerprint` **claims** `pnpm-lock.yaml`:
core takes the file out of the digest every task key folds (the
config-evaluation cache still keys on it — a config may import a
dependency), and asks the plugin the `--affected` question instead of
widening. The same shape fits any lockfile a plugin can read per project.
See [Writing a vx plugin](../plugins/) for the seam.

## Next steps

- **[Caching tasks](../caching/)** — what else is in the key.
- **[Running & filtering tasks](../running-tasks/)** — `--affected` and
  the other selectors.
