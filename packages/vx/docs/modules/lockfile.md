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
  version: number // 2
  projects: string[] // directories, sorted; every other list indexes this one
  deps: number[][] // per project, the projects it builds after, sorted
  reach: number[][] // per project, the projects it reaches for selection only, sorted
  files: Record<string, { hash: string; digests: string[] }> // claimed file → its hash and each project's digest ('' none)
}
export function dependenciesLock(
  root: string,
  metas: readonly ProjectMeta[],
  files: ReadonlyMap<string, { hash: string; projects: Readonly<Record<string, string>> }>, // by project name
): DependenciesLock
export function parseDependenciesLock(bytes: Uint8Array | null): DependenciesLock | null
export function dependantsOf(lock: DependenciesLock, dir: string): string[]
export function recordedDigests(
  lock: DependenciesLock,
  file: string,
): { hash: string; of: (dir: string) => string | undefined } | undefined
export async function writeDependenciesLock(root: string, lock: DependenciesLock): Promise<void>
```

`vx lock` writes it beside the lock, minified (only vx reads it) and committed:
each project's `discover` edges and each claimed file's
`FingerprintClaim.digests`. Flat: each directory once, in a sorted
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

## Invariants

- Deliberate asymmetry: runs TRUST the lock outright — a
  config edited since `vx lock` runs as locked (2026-06-13: a
  byte-hash re-check cannot see import closures or env, so it would be
  a weaker guarantee pretending to add safety); only `--check` pays the
  full re-evaluation, and the CI recipe is `vx lock --check && vx run`.
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
  (item 972).
- `--check` refuses at least what a run refuses: a config with no
  entry, and it also names a locked directory with no config in the
  workspace and an entry whose config file was renamed. It compares a fresh evaluation in the
  lock's JSON form, so a field a config leaves `undefined` is not drift.
  An unknown argument exits 1 before anything is read or written.
- `.vx/projects.lock.json` is globally excluded from cache inputs and
  `--affected` (it's vx's own metadata, never a task input).
