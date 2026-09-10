# `src/orchestrator/lockfile-claim.ts` — the claimant's shell

## Purpose

What every lockfile plugin needs around its parser. A plugin that keys
each project on its own dependency closure (`@vzn/vx-lockfile`,
`@vzn/vx-lockfile`) claims the file (`VxPlugin.fingerprint`), folds one digest
per project through `key`, and answers `--affected` by digesting both
sides of a change. Only the parser differs per package manager; the
memo, the per-run gate, the fallback for a project the file does not
list and the `--affected` diff are one implementation here, so a third
lockfile is a parser and nothing else.

## Public surface

```ts
export function lockfileClaim(options: {
  file: string // one of WORKSPACE_FINGERPRINT_FILES
  digest: (text: string) => ReadonlyMap<string, string> // importer dir → digest
  version: number // the memo's identity; bump when `digest` folds differently
  scope?: 'project' | 'workspace'
}): { fingerprint: FingerprintClaim; key: VxPlugin['key'] }

export function reachDigests(g: { material: string[]; edges: number[][] }): string[]
```

A plugin spreads the hooks into `definePlugin(import.meta, lockfileClaim({…}))`.
Both are on the `@vzn/vx` façade.

## Construction rules

- **Once per content.** The digests are memoised under the cache dir
  (`lockfile-claims/<file>.json`) by `version` + the file's xxh3, so a
  warm run pays one read, one hash and one small JSON read — never a
  parse. Written to a temp name and renamed, so a reader never sees a
  half memo and two concurrent runs each land a whole one; a memo that
  cannot be written is a speed-up lost, not an error.
- **Once per run.** Core hands every `key` call of one run the same
  context object; a `WeakMap` on it makes the stat + read happen once
  per run, not once per task (1000 tasks cost 1000 stats, 47 ms in
  the plugin-stages row, before this).
- **Once per process.** The file's size + mtime gate the read within a
  process (a `vx watch` cycle); the content hash decides whether the
  digests are current.
- **A project the file does not list** (outside the workspace's
  `packages`) folds the root importer's digest — the only installed
  tree it can resolve from; a file with neither folds a constant.
- **`affected`** digests both sides and names the projects whose digest
  moved; a side that is absent (the file appeared or went) answers
  `undefined`, and so does `scope: 'workspace'`.
- **`scope: 'workspace'`** folds the file's hash into every task and
  never parses: the coarse key core would fold, through the plugin.

`reachDigests` is the digest the parsers share: one hash per node over
everything the node reaches, Merkle-style, with the strongly connected
component as the unit (lockfiles carry cycles) — iterative Tarjan,
children first, each component folding its members' material and its
child components' digests, both sorted. O(nodes + edges): 1000 importers
over 3000 packages digest in ~20 ms where one traversal per importer
took 400.

## What it does NOT do

- Know any lockfile format. The parser is the plugin's; the shell hands
  it text and stores what it returns.
- Fold a project's own `package.json`: core hashes that per project
  already (`projectPackageJsonHash`).

## Tests

`tests/lockfile-claim.test.ts` — the memo (served across instances, a
planted memo keys the task, a changed file or version ignores it), the
per-run gate (one parse for two tasks), the root fallback, `scope:
'workspace'`, the `affected` diff, and `reachDigests` (reach moves a
digest, numbering does not, a cycle shares a component). The formats
are pinned in `packages/vx-lockfile/tests`, one file per manager.
