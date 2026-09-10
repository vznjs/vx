# @vzn/vx-pnpm

The pnpm plugin for [`@vzn/vx`](https://github.com/vznjs/vx): every task is keyed on its **own project's resolved dependency closure** from `pnpm-lock.yaml`, not on the whole file. `pnpm update foo` re-keys exactly the projects that reach `foo` — through their dependencies, their dependencies' dependencies, and any `link:` into a workspace package — and `vx run … --affected` selects the same projects. Zero dependencies; Bun's own YAML parser.

Without it, core folds the whole lockfile into the workspace fingerprint that every cache key sees, so one install invalidates every task in the workspace.

## Usage

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { pnpm } from '@vzn/vx-pnpm'

export default defineWorkspace({
  plugins: [pnpm()],
})
```

That is the whole setup. The plugin **claims** `pnpm-lock.yaml` (`VxPlugin.fingerprint`), so core leaves it out of the workspace fingerprint, and its `key` hook folds one digest per project. `vx why <task>` names it as `plugin @vzn/vx-pnpm/deps`.

| Option  | Values                               | Meaning                                                                                                                                                                                        |
| ------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scope` | `'project'` (default), `'workspace'` | `project`: each task folds its own project's closure. `workspace`: the whole file, as core folds it — the coarse key through the plugin, for a workspace not yet ready to trust the precision. |

## What a project's digest covers

- Every package the project reaches: its `dependencies`, `devDependencies` and `optionalDependencies`, transitively through the lockfile's `snapshots` (v9) or `packages` (v5, v6).
- Each package by **name, version and resolved peers** — `foo@1(react@18)` and `foo@1(react@19)` are different `node_modules` — plus its resolution (integrity, tarball, commit) and any `patchedDependencies` entry for it.
- A `link:` dependency folds the linked workspace package's whole reach: what project A can import through workspace package B is B's closure.
- Install-wide material every project folds: `lockfileVersion`, `settings`, `overrides`, `packageExtensionsChecksum`, `pnpmfileChecksum`.

A project the lockfile has no importer for (outside `pnpm-workspace.yaml`'s `packages`) folds the root importer's digest — the only `node_modules` it can resolve from. A phantom dependency (imported, never declared) is not in the closure; declare it.

## Cost

The lockfile is parsed once per content. The digests are memoised under the cache dir (`vx-pnpm/digests.json`) by the file's xxh3, so a warm run pays one read and one hash of the file and one small JSON read — not a YAML parse. Within one process (a run, a `vx watch` cycle) the file's size and mtime gate even that read. The digest itself is one hash per strongly connected component of the dependency graph (pnpm writes cycles), children first, so a 1000-importer / 3000-package lockfile digests in ~20 ms when it does change.

## `--affected`

`vx run test --affected=origin/main` after a lockfile change used to select every project. With the claim, core hands the plugin the lockfile at the base ref and in the working tree; it digests both and names the projects whose digest moved. A lockfile that appeared or was deleted still selects everything — every project's `node_modules` is in question.

## Testing

`bun test` covers the digests (transitive bumps, links, peer suffixes, patches, install-wide knobs, cycles, YAML key order, v6, aliases), the plugin's `affected` answer, and `vx run` / `vx why` / `--affected` end to end.
