# `src/orchestrator/lockfile-claim.ts` — the claimant's shell

## Purpose

What every lockfile plugin needs around its parser. A plugin that keys
each project on its own dependency closure (`@vzn/vx-lockfile`'s
`bun()`, `pnpm()`, `npm()`, `yarn()`) claims the file
(`VxPlugin.fingerprint`), records one digest per project through
`vx lock` (`digests`), folds the recorded one through `key`, and answers
`--affected` by digesting both sides of a change. Only the parser differs per package manager; the
memo, the per-run gate, the fallback for a project the file does not
list and the `--affected` diff are one implementation here, so a third
lockfile is a parser and nothing else.

## Public surface

```ts
export interface LockfileClaimOptions {
  readonly file: string // the lockfile's name at the workspace root
  // importer dir → digest; `files` is extraFiles' content hashes ('' when absent; one there but unreadable refuses the key)
  readonly digest: (text: string, files: ReadonlyMap<string, string>) => ReadonlyMap<string, string>
  // root-relative files the lockfile names but does not pin (bun.lock's patches)
  readonly extraFiles?: (text: string) => readonly string[]
  readonly version: number // the memo's identity; bump when `digest` folds differently
  readonly scope?: 'project' | 'workspace'
  readonly part?: string // the key part's name as `vx why` shows it under the plugin; default 'deps'
  // importer dir → its links to other importers, memoised beside the digests
  readonly importers?: (text: string) => ReadonlyMap<string, LockfileImporter>
  // importer dir → the dependency names it records, memoised beside the digests
  readonly recorded?: (text: string) => ReadonlyMap<string, readonly string[]>
}
export interface LockfileImporter {
  readonly deps: Readonly<Record<string, string>> // installed name → importer dir
  readonly peers: Readonly<Record<string, string>> // peer-only name → importer dir
  readonly transitive?: readonly string[] // importer dirs reached only through installed packages
}
export interface LockfileClaimHooks {
  readonly fingerprint: FingerprintClaim
  key(task: TaskNode, ctx: KeyHookContext): Promise<Readonly<Record<string, string>> | undefined>
  // the file's importers now, through the memo; undefined without the file
  importers(ctx: {
    workspaceRoot: string
    cacheDir: string
  }): Promise<ReadonlyMap<string, LockfileImporter> | undefined>
  // the file's recorded names now, through the memo; undefined without the file or `recorded`
  recorded(ctx: {
    workspaceRoot: string
    cacheDir: string
  }): Promise<ReadonlyMap<string, ReadonlySet<string>> | undefined>
}
export function lockfileClaim(options: LockfileClaimOptions): LockfileClaimHooks

export interface ReachGraph {
  readonly material: readonly string[] // one per node
  readonly edges: ReadonlyArray<readonly number[]> // node → the nodes it reaches directly
}
export function reachDigests(g: ReachGraph): string[]
```

A plugin spreads `fingerprint` and `key` into `definePlugin(import.meta, …)`;
`importers` and `recorded` are no hooks, but what its own `discover` and `project` read.
All are on the `@vzn/vx` façade.

## Construction rules

- **A run's key never parses the lockfile.** `key` (project scope)
  answers the digest `vx lock` recorded in `.vx/dependencies.lock.json`
  (`ctx.locked(file)`, asked once per run), which core holds to the
  file's bytes ([`lockfile.md`](./lockfile.md), "A run's read"). Only
  when an extra file the record names moved since (a `link:` directory
  edited, no install) does the run digest, through the memo; `digests`
  (`vx lock`, `--affected`'s head side) and `affected` always do.
- **A run's read digests nothing.** `importers` and `recorded` (a
  `discover` or `project` stage's reads) leave the digests out of a
  parse they pay, and out of the memo (`importers: null`); `digests`
  parses again and keeps them. The digest was most of a parse: on this
  repo's bun.lock about twice the text parse, and ten times the edges
  (2026-11-05).
- **Once per content.** The digests, and `importers`' and `recorded`'s
  answers beside them, are memoised in cache.db (`lockfile_memos`, one
  row per file and claimant, `cache/lockfile-memo.ts`) by `version`, the
  claimant (its `part`, its `scope` and its functions' source: another
  claimant of the file at the same `version` does not read it, nor a
  workspace-scope memo a project-scope one) and the file's xxh3, so a
  warm run pays one read, one hash and one row read — never a parse.
  Core owns the row; a plugin passes parsers. Its readers (a `discover`
  hook, `--affected`'s selection) run before a run opens the index, so
  each read or write opens the index on its own and closes it, and only
  an index that exists with this vx's schema is read or written: a
  `discover` before the first run keeps its parse in memory and the
  same process's next load writes it once the index exists. A memo that
  cannot be written is a speed-up lost, not an error.
- **Once per run.** Core hands every `key` call of one run the same
  context object; under `scope: 'workspace'` a `WeakMap` on it makes the
  stat + read happen once per run, not once per task (1000 tasks cost
  1000 stats, 47 ms in the plugin-stages row, before this).
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
  devDependencies' closures included. That digest is the lockfile's
  view of such a package, never its source: `@vzn/vx-lockfile`'s
  `discover` makes it an order edge of every other project (reach only
  where that would close a cycle), so an edit to it re-keys and selects
  the projects that load it through the root (Turbo #8364, #8465).
- **A project the file does not list** folds its nearest listed
  ancestor's digest, with the root's: inside a member with no manifest
  of its own (`packages/a/e2e`), Node resolves it from that member's
  `node_modules` first, and the root's alone moved no key of it on a
  bump only `a` reached. Outside every member it folds the root
  importer's digest alone — the only installed tree it can resolve
  from; a file with neither folds a constant.
- **`affected`** digests both sides and names the projects whose digest
  moved; a side that is absent (the file appeared or went) answers
  `undefined`, and so does `scope: 'workspace'`.
- **`digests`** answers each project's digest (its importer's, or its
  nearest listed ancestor's, with the root's), the xxh3 of the file's
  bytes and the extra files the digests read, for `vx lock` to record;
  `scope: 'workspace'` and a missing file answer `undefined`.
- **`scope: 'workspace'`** folds the file's hash (with its extra
  files') into every task and never digests: the whole file, the
  coarsest key there is, read by the run itself, since `vx lock`
  records nothing for it. With `importers` it still parses once per
  content, for the edges.

`reachDigests` is the digest the parsers share: one hash per node over
everything the node reaches, Merkle-style, with the strongly connected
component as the unit (lockfiles carry cycles) — iterative Tarjan,
children first, each component folding its members and its child
components' digests, both sorted. A member folds as its material AND the
materials its edges land on (a self-loop aside): every member shares the
component's digest, so a retarget between two members — an importer moved
from `y@1.0.0` to `y@1.1.0`, both in one cycle — moved no key before item 1013. `DIGEST_VERSION` 5 (`@vzn/vx-lockfile`) retired the memos that folded the old way. In a cycle, each member folds as a colour-refinement label: its material and the child digests its edges leave for, then its in-cycle targets' labels until no two labels part further. npm and bun key two copies of one version alike (`a/node_modules/foo` → bar@1, `node_modules/foo` → bar@2), and two members swapping copies, in the cycle or out of it, moved no key. A singleton folds as before, so an acyclic digest keeps its value.
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
lockfile's, taken before each file is hashed. The claim's `extraFiles`
names them to core, from the memo when it holds those bytes (a parse
otherwise): `--affected` asks on every diff, and a cold parse of this
repo's bun.lock was ~8 ms of its selection. `--affected` hands a changed
one in `change.extras`, so `affected` digests both sides with its bytes.

A named path may be a directory: a `file:` dependency a manager copies
into `node_modules` at install, or a directory it links, recording only
its path (Growth, file-dir-dep-stale.sh). Its hash covers every file
under it but `node_modules` and `.git`, following links, and the
in-process gate uses that hash as the
directory's identity, since a directory's stat does not move when a file
in it is edited. A path outside the root is never read.

## What it does NOT do

- Know any lockfile format. The parser is the plugin's; the shell hands
  it text and stores what it returns.
- Fold a project's own `package.json`: core keys no package file
  (2026-10-14), and `@vzn/vx-lockfile` adds it to each importer's
  cached tasks as an input.
- Decide edges. `importers` records what the lockfile links; turning that
  into `discover` entries (which peers order, which are reach) is the
  plugin's.

## Tests

`tests/lockfile-claim.test.ts` — the key (the recorded digest, no read
and no parse), `importers` (served from the memo in a
new process, kept under `scope: 'workspace'` and not read by a
project-scope claimant, a run's read digesting nothing and `vx lock`'s
adding the digests), the memo (served across instances, a
planted memo is what `vx lock` records, a changed file or version ignores it), the
in-process gate (one parse for two projects), the root folded into every
project and the root fallback, `scope: 'workspace'`, the `affected` diff
(a root move names every project), and `reachDigests` (reach moves a
digest, numbering does not, a cycle shares a component). The formats
are pinned in `packages/vx-lockfile/tests`, one file per manager, each
with a row that bumps a root devDependency and asserts every project
re-keyed and selected by `--affected`, beside a control that a package
one project reaches moves only that project.
