# @vzn/vx-lockfile

Lockfile plugins for [`@vzn/vx`](https://github.com/vznjs/vx): `pnpm()`, `bun()`, `npm()` and `yarn()`. Each keys every task on its **own project's resolved dependency closure** from the package manager's lockfile, not on the whole file. `pnpm update foo` (or `bun add`, `npm install`, `yarn up`) re-keys exactly the projects that reach `foo` — through their dependencies, transitively, and through workspace links — and `vx run … --affected` selects the same projects. Zero dependencies: Bun's own YAML and JSONC parsers, and a classic-yarn reader.

Without a plugin, core folds the whole lockfile into the workspace fingerprint that every cache key sees, so one install invalidates every task in the workspace.

## Usage

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { pnpm } from '@vzn/vx-lockfile' // or bun, npm, yarn

export default defineWorkspace({
  plugins: [pnpm()],
})
```

That is the whole setup. The plugin **claims** its lockfile (`VxPlugin.fingerprint`), so core leaves it out of the workspace fingerprint, and its `key` hook folds one digest per project. `vx why <task>` names the material as `plugin @vzn/vx-lockfile/pnpm` (or `/bun`, `/npm`, `/yarn`).

| Option  | Values                               | Meaning                                                                                                                                                                                        |
| ------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scope` | `'project'` (default), `'workspace'` | `project`: each task folds its own project's closure. `workspace`: the whole file, as core folds it — the coarse key through the plugin, for a workspace not yet ready to trust the precision. |

## What a project's digest covers

Every package the project can reach, by resolved identity (name, version, integrity), plus the install-wide material every project folds. Per manager:

- **pnpm** (`pnpm-lock.yaml`, lockfile v5, v6, v9): importers → snapshots, transitively; each package by name, version **and resolved peers** (`foo@1(react@18)` is not `foo@1(react@19)`), resolution and any `patchedDependencies` entry; `link:` folds the linked importer's reach; `settings`, `overrides`, `packageExtensionsChecksum`, `pnpmfileChecksum` into every project.
- **bun** (`bun.lock`): Bun's hoisted layout — a dependency `d` of the package at path `p` is `p/d` when that key exists, else the nearest ancestor's, else the root's, so a nested version counts for the package it is nested under and no other; `workspace:` entries fold the linked package's reach; `overrides`, `patchedDependencies`, catalogs into every project.
- **npm** (`package-lock.json`, lockfileVersion 2 and 3): the `packages` map — `p/node_modules/d`, then the ancestors, then `node_modules/d`; a `link: true` entry folds its target workspace's reach; root `overrides` into every project. Version 1 (npm 6) has no `packages` map and is refused.
- **yarn** (`yarn.lock`): berry (yarn 2+) resolves `name@npm:range` descriptors to entries, workspaces included, `__metadata` into every project. Classic (yarn 1) records no workspaces, so it yields one digest for the root that every project folds — coarse, and honest about what the file records.

A project the lockfile has no entry for folds the root's digest — the only `node_modules` it can resolve from. A phantom dependency (imported, never declared) is not in any closure; declare it.

## Cost

The claim, the per-project key, the memo and the `--affected` diff are core's `lockfileClaim`; this package is the parsers. A lockfile is parsed **once per content**: the digests are memoised under the cache dir (`lockfile-claims/<file>.json`) by the file's xxh3, so a warm run pays one read, one hash and one small JSON read — never a parse — and the read happens once per run, not per task. The digest is one hash per strongly connected component of the dependency graph (lockfiles carry cycles), children first, so a 1000-importer / 3000-package lockfile digests in ~20 ms when it does change.

## `--affected`

`vx run test --affected=origin/main` after a lockfile change used to select every project. With a plugin declared, core hands it the lockfile at the base ref and in the working tree; it digests both and names the projects whose digest moved. A lockfile that appeared or was deleted still selects everything — every project's `node_modules` is in question.

## Testing

`bun test` covers each parser's digests (transitive bumps, nested versions, workspace links, peer suffixes, patches, install-wide knobs, cycles, key order, aliases, refusals) and `vx run` / `vx why` / `--affected` end to end. vx's own repository declares `bun()`.
