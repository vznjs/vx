# @vzn/vx-bun

The Bun plugin for [`@vzn/vx`](https://github.com/vznjs/vx): every task is keyed on its **own project's resolved dependency closure** from `bun.lock`, not on the whole file. `bun add foo` in one package re-keys that package's tasks and its dependants — through Bun's hoisted `node_modules` layout, nested versions included — and `vx run … --affected` selects the same projects. Zero dependencies; `Bun.JSONC` parses Bun's own lockfile.

Without it, core folds the whole lockfile into the workspace fingerprint that every cache key sees, so one install invalidates every task in the workspace.

## Usage

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { bun } from '@vzn/vx-bun'

export default defineWorkspace({
  plugins: [bun()],
})
```

The plugin **claims** `bun.lock` (`VxPlugin.fingerprint`) through core's `lockfileClaim`, so core leaves it out of the workspace fingerprint and folds one digest per workspace package instead. `vx why <task>` names it as `plugin @vzn/vx-bun/deps`.

| Option  | Values                               | Meaning                                                                                                                                  |
| ------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `scope` | `'project'` (default), `'workspace'` | `project`: each task folds its own package's closure. `workspace`: the whole file, as core folds it — the coarse key through the plugin. |

## What a package's digest covers

- Every package it can reach: its `dependencies`, `devDependencies`, `optionalDependencies` and `peerDependencies`, transitively through the lockfile's `packages`, resolved the way Bun lays them out — a dependency `d` of the package at path `p` is `p/d` when that key exists, else the nearest ancestor's, else the root's.
- Each package by its resolved id (`name@version`, a git commit, a tarball) and its integrity.
- A `workspace:` dependency folds the linked workspace package's whole reach.
- Install-wide material every package folds: `lockfileVersion`, `configVersion`, `overrides`, `patchedDependencies`, `catalog(s)`.

A project the lockfile has no workspace entry for folds the root's digest. A phantom dependency (imported, never declared) is not in the closure; declare it.

## Cost and `--affected`

The shell is core's `lockfileClaim`: the file is parsed once per content, the digests are memoised under the cache dir by the file's hash, and a warm run pays one read + hash + a small JSON. `--affected` hands the plugin the lockfile at the base ref and in the working tree; it digests both and names the projects whose digest moved.

## Testing

`bun test` covers the digests (hoisted bump, nested version, workspace link, install-wide knob, scoped nesting, refusal) and `vx run` / `--affected` end to end. This repository declares `bun()` in its own `vx.workspace.ts`.
