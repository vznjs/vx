# `src/orchestrator/lockfile-claim.ts` — the claimant's shell

## Purpose

What every lockfile plugin needs around its parser. A plugin that keys
each project on its own dependency closure (`@vzn/vx-lockfile`'s
`pnpm()`, `bun()`, `npm()`, `yarn()`) claims the file
(`VxPlugin.fingerprint`), folds one digest
per project through `key`, and answers `--affected` by digesting both
sides of a change. Only the parser differs per package manager; the
memo, the per-run gate, the fallback for a project the file does not
list and the `--affected` diff are one implementation here, so a third
lockfile is a parser and nothing else.

## Public surface

```ts
export interface LockfileClaimOptions {
  readonly file: string // one of WORKSPACE_FINGERPRINT_FILES
  // importer dir → digest; `files` is extraFiles' content hashes ('' when absent)
  readonly digest: (text: string, files: ReadonlyMap<string, string>) => ReadonlyMap<string, string>
  // root-relative files the lockfile names but does not pin (bun.lock's patches)
  readonly extraFiles?: (text: string) => readonly string[]
  readonly version: number // the memo's identity; bump when `digest` folds differently
  readonly scope?: 'project' | 'workspace'
  readonly part?: string // the key part's name as `vx why` shows it under the plugin; default 'deps'
}
export interface LockfileClaimHooks {
  readonly fingerprint: FingerprintClaim
  key(task: TaskNode, ctx: KeyHookContext): Promise<Readonly<Record<string, string>> | undefined>
}
export function lockfileClaim(options: LockfileClaimOptions): LockfileClaimHooks

export interface ReachGraph {
  readonly material: readonly string[] // one per node
  readonly edges: ReadonlyArray<readonly number[]> // node → the nodes it reaches directly
}
export function reachDigests(g: ReachGraph): string[]
```

A plugin spreads the hooks into `definePlugin(import.meta, lockfileClaim({…}))`.
Both are on the `@vzn/vx` façade.

## Construction rules

- **Once per content.** The digests are memoised under the cache dir
  (`lockfile-claims/<file>.json`) by `version`, the claimant (its
  `part` and its functions' source: another claimant of the file at the
  same `version` does not read it) and the file's xxh3, so a
  warm run pays one read, one hash and one small JSON read — never a
  parse. Written to a temp name and renamed, so a reader never sees a
  half memo and two concurrent runs each land a whole one; a memo that
  cannot be written is a speed-up lost, not an error.
- **Once per run.** Core hands every `key` call of one run the same
  context object; a `WeakMap` on it makes the stat + read happen once
  per run, not once per task (1000 tasks cost 1000 stats, 47 ms in
  the plugin-stages row, before this).
- **Once per process.** The file's size, mtime, ctime and inode gate the
  read within a process (a `vx watch` cycle), as `Cache.hashFile`'s memo
  keys a file: size and mtime alone kept the digests of a same-size
  lockfile copied in with its mtime (`cp -p`). The content hash decides
  whether the digests are current.
- **Every project folds the root importer's digest** beside its own
  (one xxh3 over both; the root project folds the root's alone). The
  root package's dependencies reach every task: their bins through the
  root `node_modules/.bin` that core puts on every task's PATH, their
  modules through Node's resolution walking up to the root
  `node_modules` (`@types/*` under tsc's default `typeRoots`, a plugin
  a root tool's config names). Without it a root devDependency bump
  moved no project's key, `--affected` selected nothing, and the task
  replayed the old tool's output (nx#36415 class, 2026-09-24). A bin
  alone is not narrower-and-sound: `@types/node` has no bin. The cost is
  every project on a root-dependency bump, the root's `workspace:`
  devDependencies' closures included.
- **A project the file does not list** (outside the workspace's
  `packages`) folds the root importer's digest alone — the only
  installed tree it can resolve from; a file with neither folds a
  constant.
- **`affected`** digests both sides and names the projects whose digest
  moved; a side that is absent (the file appeared or went) answers
  `undefined`, and so does `scope: 'workspace'`.
- **`scope: 'workspace'`** folds the file's hash into every task and
  never parses: the coarse key core would fold, through the plugin.

`reachDigests` is the digest the parsers share: one hash per node over
everything the node reaches, Merkle-style, with the strongly connected
component as the unit (lockfiles carry cycles) — iterative Tarjan,
children first, each component folding its members and its child
components' digests, both sorted. A member folds as its material AND the
materials its edges land on (a self-loop aside): every member shares the
component's digest, so a retarget between two members — an importer moved
from `y@1.0.0` to `y@1.1.0`, both in one cycle — moved no key before item 1013. `DIGEST_VERSION` 5 (`@vzn/vx-lockfile`) retired the memos that folded the old way.
O(nodes + edges): 1000 importers
over 3000 packages digest in ~20 ms where one traversal per importer
took 400.

**A file the lockfile names but does not pin.** bun.lock records a
patch by path (`patchedDependencies`), never a hash of its content, so an
edited patch left the lockfile byte-identical and every key unmoved while
the install applied the new one (item 1014). `extraFiles` names such
files; their content hashes reach `digest` and join the memo's identity
and the workspace-scope key. The memo records the files and their hashes,
so a warm run re-hashes the files it names and parses only when one
moved; within a process the same identity gates the read beside the
lockfile's, taken before each file is hashed. `--affected` does not yet see a change to one (a path no
project owns): the key does.

## What it does NOT do

- Know any lockfile format. The parser is the plugin's; the shell hands
  it text and stores what it returns.
- Fold a project's own `package.json`: core hashes that per project
  already (`projectPackageJsonHash`).

## Tests

`tests/lockfile-claim.test.ts` — the memo (served across instances, a
planted memo keys the task, a changed file or version ignores it), the
per-run gate (one parse for two tasks), the root folded into every
project and the root fallback, `scope: 'workspace'`, the `affected` diff
(a root move names every project), and `reachDigests` (reach moves a
digest, numbering does not, a cycle shares a component). The formats
are pinned in `packages/vx-lockfile/tests`, one file per manager, each
with a row that bumps a root devDependency and asserts every project
re-keyed and selected by `--affected`, beside a control that a package
one project reaches moves only that project.
