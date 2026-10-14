# `src/workspace/lockfile.ts` — .vx/projects.lock.json

## Purpose

`vx lock` freshly evaluates every project config and freezes it, by
project name, into `.vx/projects.lock.json`. Every run loads configs FROM the
lock (zero eval, no staleness check, no schema validation);
`vx lock --check` re-evaluates every config and reports one drift
message per project that differs.

## Public surface

```ts
export const LOCKFILE_NAME = '.vx/projects.lock.json'
export const LOCKFILE_VERSION = 2

export interface Lockfile {
  version: number
  projects: Record<string, ProjectConfig> // by project name, as `vx lock` evaluated it
  validated?: string // the self-digest writeLockfile appends
}

export function lockfilePath(root: string): string
export const NO_LOCK = 'no lock: run `vx lock`' // a run's refusal when no lock exists
export const LOCK_INVALID = '.vx/projects.lock.json is invalid, run `vx lock`'
// On a run's crash path only: does the lock hold an entry `vx lock` could
// not have written? A run validates no entry, so it pays nothing for this.
export function lockEntryBroken(root: string): boolean
export async function readLockfile(root: string): Promise<Lockfile | null>
export async function writeLockfile(root: string, lock: Lockfile): Promise<void>
export function frozenProjectConfigs(
  lock: Lockfile,
  metas: ReadonlyArray<{ name: string; configPath: string }>,
  root: string,
): ProjectConfig[]
```

`readLockfile` checks the JSON shape only: an object, this
`LOCKFILE_VERSION`, `projects` an object of objects. Anything else,
including a lock an earlier vx wrote, is a `UserError` asking for
`vx lock`. `frozenProjectConfigs` is what a run's load serves instead
of an evaluation: an entry missing for the project is a
`UserError` naming the project and the remedy. No entry is validated:
`vx lock` validated what it wrote, and `--check` re-evaluates
(owner, 2026-10-14). A hand-broken entry that then crashes a run is
named, not shown as a raw TypeError: on that crash's path only, a task
or the CLI asks `lockEntryBroken` and prints `LOCK_INVALID` (owner,
2026-10-14). `writeLockfile` ends the lock with a `validated`
field, a digest of the bytes above it under vx's version; no reader
consults it. The CLI's own selection load (`loadCliProjects`, what a
filter that walks the graph stages) reads the lock the same way, so
the selection and the run see one graph. A run with
nothing staged starts reading the lock when it finds the workspace root,
beside discovery; a missing lock still refuses at the config load, after
any refusal that comes first.

## Invariants

- Deliberate asymmetry: runs TRUST the lock outright — a
  config edited since `vx lock` runs as locked (owner, 2026-06-13: a
  byte-hash re-check cannot see import closures or env, so it would be
  a weaker guarantee pretending to add safety); only `--check` pays the
  full re-evaluation, and the CI recipe is `vx lock --check && vx run`.
- A missing entry (or a missing lock) in a run is a hard
  `UserError` — never a silent fallback to evaluation. The lock is
  keyed by name, so a config that moved and evaluates the same is still
  locked.
- `writeLockfile` writes a temp file beside the lock and renames it over
  the lock, so a reader sees the old lock or the new one, never a
  truncated one. A write in place truncated first, and a run or a
  `vx watch` cycle woken by the write could read the lock empty
  (item 972).
- `--check` refuses at least what a run refuses: a project with no
  entry, and it also names a locked project with no config in the
  workspace. It compares a fresh evaluation in the
  lock's JSON form, so a field a config leaves `undefined` is not drift.
  An unknown argument exits 1 before anything is read or written.
- `.vx/projects.lock.json` is globally excluded from cache inputs and
  `--affected` (it's vx's own metadata, never a task input).
