# `src/workspace/lockfile.ts` — .vx/projects.lock.json

## Purpose

`vx lock` finds every project (`findProjectConfigs`, then the plugin
`discover` stage), freshly evaluates each config and freezes it, by
directory, into `.vx/projects.lock.json`. Every run takes its project
directories from the lock as well as their configs, so a config added
since does not run until locked. Every run loads configs FROM the
lock (zero eval, no staleness check, no schema validation);
`vx lock --check` re-evaluates every config and reports one drift
message per project that differs.

## Public surface

```ts
export const LOCKFILE_NAME = '.vx/projects.lock.json'
export const LOCKFILE_VERSION = 5

export interface LockedProject {
  file: string // the config file's name in the directory (`vx.config.ts`)
  config: ProjectConfig // as `vx lock` evaluated it, JSON-normalized
}
export interface Lockfile {
  version: number
  // root-relative POSIX directory (`.` for the root) → its project; by
  // directory, so a name a plugin gives never invalidates the lock
  projects: Record<string, LockedProject>
  validated?: string // the self-digest writeLockfile appends
}
// On disk only: `pool` holds each task, exec, env, sandbox, inputs or cache
// value two places hold alike, once; each place holds its index. A read
// puts the values back, shared, and drops `pool`.

export function lockfilePath(root: string): string
export const NO_LOCK = 'no lock: run `vx lock`' // a run's refusal when no lock exists
export const EMPTY_LOCK =
  'The lock holds no project — write a vx.config (`vx init`), then run `vx lock`' // run and vx show, when it holds none
export const LOCK_INVALID = '.vx/projects.lock.json is invalid, run `vx lock`'
// On a run's crash path only: does the lock hold an entry `vx lock` could
// not have written? A run validates no entry, so it pays nothing for this.
export function lockEntryBroken(root: string): boolean
export async function readLockfile(root: string): Promise<Lockfile | null>
// The digest of the bytes a read lock came from: what its configs are a function of.
export function lockDigest(lock: Lockfile): string | undefined
export async function writeLockfile(root: string, lock: Lockfile): Promise<void>
// The lock's file and bytes, for `writeAllOrNone` (util): `vx lock` writes it with the dependency lock.
export function lockfileWrite(root: string, lock: Lockfile): PendingWrite
// A lock's entries from its bytes, pool put back; null when they do not parse
export function lockEntries(bytes: Uint8Array | null): Record<string, unknown> | null
export function frozenProjectConfigs(
  lock: Lockfile,
  metas: ReadonlyArray<{ name: string; dir: string; configPath: string }>,
  root: string,
): ProjectConfig[]
// A project directory as the lock keys it: root-relative POSIX, `.` for the root
export function lockKey(root: string, dir: string): string
```

`readLockfile` checks the JSON shape only: an object, this
`LOCKFILE_VERSION`, `projects` an object of `{ file, config }` entries,
each keyed by a directory under the root as `lockKey` spells it (`.`, or
a relative POSIX path with no empty, `.` or `..` segment: a run joins it
onto the root, and `../x` ran a project outside the workspace).
Anything else, including a lock an earlier vx wrote (version 2 keyed
by name), is a `UserError` asking to re-run `vx lock`. `frozenProjectConfigs` is what a run's load serves instead
of an evaluation: an entry missing for the project is a
`UserError` naming the project and the remedy. No entry is validated:
`vx lock` validated what it wrote, and `--check` re-evaluates
(2026-10-14). A hand-broken entry that then crashes a run is
named, not shown as a raw TypeError: on that crash's path only, a task
or the CLI asks `lockEntryBroken` and prints `LOCK_INVALID`
(2026-10-14). `writeLockfile` writes a value two places hold alike once, in `pool`
(`task`, `exec`, `env`, `sandbox`, `inputs`, `cache`), and puts its index
in each place. Each slot is one the schema types as an object, so a number
there can only be an index. Big workspaces repeat their tasks: 2,000
projects of five tasks read in 0.71 ms against 2.62 ms, from a fifth of
the bytes; this repo's lock went from 126 KB to 55 KB. `readLockfile`
puts each value back once, so projects share it; the `project` and `graph`
stages, which edit a config in place, copy it first. An index with no
pool entry is a `UserError` (`no task 3 in its pool`). `writeLockfile` ends the lock with a `validated`
field, a digest of the bytes above it under vx's version; no reader
consults it. The CLI's own selection load (`loadCliProjects`, what a
filter that walks the graph stages) reads the lock the same way, so
the selection and the run see one graph. A run with
nothing staged starts reading the lock when it finds the workspace root,
beside discovery; a missing lock still refuses at the config load, after
any refusal that comes first.

### `.vx/dependencies.lock.json` (`dependencies-lock.ts`)

```ts
export const DEPENDENCIES_LOCK_NAME = '.vx/dependencies.lock.json'
export interface DependenciesLock {
  version: number // 3
  projects: string[] // directories, sorted; every other list indexes this one
  deps: number[][] // per project, the projects it builds after, sorted
  reach: number[][] // per project, the projects it reaches for selection only, sorted
  // claimed file → its bytes' xxh3, each project's digest ('' none), and each
  // other file the digests read → its hash (absent when none)
  files: Record<string, { hash: string; digests: string[]; extras?: Record<string, string> }>
}
export function dependenciesLock(
  root: string,
  metas: readonly ProjectMeta[],
  files: ReadonlyMap<
    string,
    {
      hash: string
      projects: Readonly<Record<string, string>>
      extras?: Readonly<Record<string, string>>
    }
  >, // by project name
): DependenciesLock
export function readDependenciesLock(root: string, reads?: LoadReads): Promise<Uint8Array | null>
export function parseDependenciesLock(bytes: Uint8Array | null): DependenciesLock | null
export function dependantsOf(lock: DependenciesLock, dir: string): string[]
export function recordedDigests(
  lock: DependenciesLock,
  file: string,
):
  | {
      hash: string
      extras: Readonly<Record<string, string>>
      has: (dir: string) => boolean
      of: (dir: string) => string | undefined
    }
  | undefined
export function dependenciesLockWrite(root: string, lock: DependenciesLock): PendingWrite
```

`vx lock` writes it beside the lock, minified (only vx reads it) and committed:
each project's `discover` edges and each claimed file's
`FingerprintClaim.digests`, with the xxh3 of the file's bytes and the
hash of each other file the digests read (`extras`: a `bun.lock`
patch, a `file:` directory). A run keys from those digests and never
parses the file (`orchestrator/locked-digests.ts`, below). Flat: each directory once, in a sorted
`projects` list, and every edge and digest an index into it (a third
the size of keying each by its directory, and a quarter of the parse
and lookup time at 2,000 projects). Every list is sorted, so the same
workspace writes the same bytes. `--affected` reads the base commit's
copy (`git show`): a deleted project's dependants are the projects
whose edges hold its index, and a changed claimed file
whose base bytes hash to the recorded `hash` takes its base digests
from the record, never a parse. `parseDependenciesLock` answers null
for a missing file, another version or another shape, and selection
then falls back (every project for a deletion, the claimant's
`affected` for a change). `vx lock --check` holds it to a fresh
derivation once the lock itself holds.

### A run's read (`orchestrator/locked-digests.ts`)

```ts
export function lockedFiles(
  workspaceRoot: string,
  claimed: readonly string[],
  bytes: ReadonlyMap<string, Uint8Array>, // the claimed files the run read
  lockBytes: Uint8Array | null,
): KeyHookContext['locked']
```

A run reads the lock once (through the load's `reads`, beside the
claimed files) when a plugin claims a file, and builds
`KeyHookContext.locked` from it before the `key` stage. Every claimed
file the lock records is checked first: its bytes (as the run read
them) must hash to the record; one that moved, or a recorded file now
gone, refuses the run (`VX_E_LOCK`: "bun.lock changed since `vx lock`:
run `vx lock`"). A claimant that asks for a present file the lock does
not record refuses too: with no lock ("no .vx/dependencies.lock.json:
run `vx lock`"), an invalid one or another version, or a lock written
before the file was there. A file absent and unrecorded answers
`undefined`. The answer's `digest(projectDir)` refuses a project the
lock does not list, and answers `undefined` for one it lists with no
digest. Never a guess: a stale lockfile refuses, so a key comes from
the bytes `vx lock` read.

The files the digests read besides the lockfile (`extras`) are handed
to the claimant with their recorded hashes, unchecked: a `link:` or
`file:` directory is source edited with no install, and refusing each
edit until `vx lock` failed eight conformance cases
(`inputs/link-dir-dependency-edit-reruns` and its kin). `lockfileClaim`
re-hashes them, as its memo did on every run before, and digests anew
(through the memo) when one moved.

## Invariants

- Deliberate asymmetry: runs TRUST the lock outright — a
  config edited since `vx lock` runs as locked (2026-06-13: a
  byte-hash re-check cannot see import closures or env, so it would be
  a weaker guarantee pretending to add safety); only `--check` pays the
  full re-evaluation, and the CI recipe is `vx lock --check && vx run`.
- The dependencies lock is the other way round: a run holds each
  recorded file to its hash. A claimed file is its bytes, so the hash is
  the whole guarantee, and it costs one xxh3 of bytes the run reads
  anyway (2026-11-05).
- A missing entry (or a missing lock) in a run is a hard
  `UserError` — never a silent fallback to evaluation. A locked
  directory whose config file is gone is refused before the lock is
  read further (`locks <dir>, but its <file> is gone`). The lock is
  keyed by directory, so a project renamed by its `name` or a plugin
  is still locked; a moved directory is a new project.
- `writeLockfile` writes a temp file beside the lock and renames it over
  the lock, so a reader sees the old lock or the new one, never a
  truncated one. A write in place truncated first, and a run or a
  `vx watch` cycle woken by the write could read the lock empty
  (item 972). `vx lock` writes the lock and the dependency lock that
  way together (`writeAllOrNone`): both temps first, then both renames,
  after checking no directory stands at either name, so a refusal
  leaves both as they were.
- `--check` refuses at least what a run refuses: a config with no
  entry, and it also names a locked directory with no config in the
  workspace and an entry whose config file was renamed. It compares a fresh evaluation in the
  lock's JSON form, so a field a config leaves `undefined` is not drift.
  An unknown argument exits 1 before anything is read or written.
- A read lock's configs share each pooled value, so a reader never edits
  one in place: the `project` and `graph` stages copy first
  (`tests/plugin-pipeline.test.ts`, "an alike task").
- `.vx/projects.lock.json` is globally excluded from cache inputs and
  `--affected` (it's vx's own metadata, never a task input).
