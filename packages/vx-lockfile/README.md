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

Every package the project can reach, by resolved identity (name, version, integrity), plus the install-wide material every project folds — and **the root package's own closure**. The root's `dependencies` and `devDependencies` reach every task: their bins run from the root `node_modules/.bin`, which vx puts on every task's PATH, and Node's resolution walks up to the root `node_modules` (`@types/*`, a plugin a root tool's config names). So a root devDependency bump (`pnpm add -Dw oxlint@next`) re-keys every project and `--affected` selects every project; a package only project A reaches still moves only A. A root `workspace:` dependency folds that package's closure into every project too. Per manager:

- **pnpm** (`pnpm-lock.yaml`, lockfile v5, v6, v9): importers → snapshots, transitively; each package by name, version **and resolved peers** (`foo@1(react@18)` is not `foo@1(react@19)`), resolution and any `patchedDependencies` entry; `link:` folds the linked importer's reach, and a `file:` directory dependency folds its own closure (v9 keys it `name@file:…`, v5/v6 by the bare `file:…`); `settings`, `overrides`, `packageExtensionsChecksum`, `pnpmfileChecksum`, `ignoredOptionalDependencies` and the lockfile version into every project.
- **bun** (`bun.lock`): Bun's hoisted layout — a dependency `d` of the package at path `p` is `p/d` when that key exists, else the nearest ancestor's, else the root's, so a nested version counts for the package it is nested under and no other; `workspace:` entries fold the linked package's reach; `overrides`, `patchedDependencies`, catalogs into every project.
- **npm** (`package-lock.json`, lockfileVersion 2 and 3): the `packages` map — `p/node_modules/d`, then the ancestors, then `node_modules/d`; a `link: true` entry folds its target workspace's reach; root `overrides` into every project. Version 1 (npm 6) has no `packages` map and is refused.
- **yarn** (`yarn.lock`): berry (yarn 2+) resolves `name@npm:range` descriptors to entries, workspaces included, `__metadata` into every project. A Yarn 4 catalog dependency (`catalog:`, `catalog:<name>`) is recorded as that literal and its range lives in `.yarnrc.yml`, so it reaches every entry of its package: a bump of any of them re-keys the workspace. `.yarnrc.yml` itself is in core's workspace fingerprint, so a catalog edit re-keys every project, as a `pnpm-workspace.yaml` edit does. Classic (yarn 1) records no workspaces, so it yields one digest for the root that every project folds — coarse, and honest about what the file records.

A project the lockfile has no entry for folds the root's digest alone — the only `node_modules` it can resolve from. A phantom dependency (imported, never declared by the project or the root — a sibling's package hoisted to the root) is not in any closure; declare it.

A lockfile the parser cannot read **refuses the run**, naming the file, the reason and the install that regenerates it. That is deliberate: the alternative to reading the lockfile is keying on nothing, and a key that is missing material is a stale hit waiting to happen. Under `--affected` the refusal also says which side could not be read — the working tree's copy, or the one at the base ref (a lockfile-migration commit hits the second).

## Cost

The claim, the per-project key, the memo and the `--affected` diff are core's `lockfileClaim`; this package is the parsers. A lockfile is parsed **once per content**: the digests are memoised under the cache dir (`lockfile-claims/<file>.json`) by the file's xxh3, so a warm run pays one read, one hash and one small JSON read — never a parse — and the read happens once per run, not per task. The digest is one hash per strongly connected component of the dependency graph (lockfiles carry cycles), children first, so a 1000-importer / 3000-package lockfile digests in ~20 ms when it does change.

## `--affected`

`vx run test --affected=origin/main` after a lockfile change used to select every project. With a plugin declared, core hands it the lockfile at the base ref and in the working tree; it digests both and names the projects whose digest moved. A lockfile that appeared or was deleted still selects everything — every project's `node_modules` is in question.

## Testing

`bun test` covers each parser's digests (transitive bumps, nested versions, workspace links, peer suffixes, patches, install-wide knobs, cycles, key order, aliases, refusals) and `vx run` / `vx why` / `--affected` end to end. vx's own repository declares `bun()`.
