# `src/orchestrator/fingerprint-watch.ts` — has a task rewritten the lockfile?

## Purpose

The files the plugins claim ([`fingerprint.md`](./fingerprint.md)) are
read once per run, before any task, and every key folds what their
claimant takes from them (a lockfile plugin's per-project parts). A task in the root
project may rewrite one of them: `pnpm install` without
`--frozen-lockfile` updates `pnpm-lock.yaml` and the installed tree. Every
key taken before that names a lockfile the tree no longer holds, and a
save under one filed bytes built against the new install under the old
lockfile's key, replayed whenever the tree went back to it (item 750).

The watch answers "has a claimed file moved since the run read it"
for the rest of the run, and re-learns the fact only after a task that
may have written one ran, so a run with no such task never touches the
files again.

## Public surface

```ts
export class FingerprintWatch {
  constructor(
    workspaceRoot: string,
    readonly names: readonly string[], // the claimed files
    read: ReadonlyMap<string, Uint8Array>, // the bytes of those present
    at: number,
  )
  wrote(): void
  moved(): readonly string[] | undefined
  say(log: Logger): void
}
```

- One per run, built by `prepareRun` from the claimed files it read
  (`readClaimedFiles`) and the moment it started reading them (`PreparedRun.fingerprintWatch`).
- `wrote()` — execute-task calls it after a command ran here for a task
  that `mayWriteFingerprint` (`sandbox-request.md`): an unsandboxed task
  in the root project, or a sandbox write grant covering a claimed
  file. With nothing claimed, no task does. A persistent one calls it once ready.
- `moved()` — the files that no longer hold what the run read, or
  undefined. Nothing is looked at until `wrote()` was called; then one
  `stat` per claimed file — following a link, as both reads do, so a
  symlinked lockfile rewritten through it is seen by its target's ctime
  (an `lstat` saw the link's, which never moved: a stale hit on every
  run after the link aged, item 760, `tests/in-run-writes.test.ts` › "a
  lockfile that is a symlink…") — and a file written since the read (by ctime,
  within `FILE_HASH_RACY_MS` as git judges its index, a second wider for
  a whole-second stamp, C-59) is read and
  compared with the bytes the run read.
  A file that appeared or went has moved. Once moved, the run stays
  moved: every key already taken folded the old bytes, even if a later
  task writes them back.
- `say(log)` — the run's one status line, however many tasks it
  withholds (below).

```text
[vx] a task rewrote `pnpm-lock.yaml` during the run, which a plugin puts into every key: nothing keyed before it is restored or saved from here on
```

## Where it is read

`execute-task.ts` asks before a lazy probe (a moved claimed file skips the
probe: the key would name the old lockfile) and before a save (a moved
claimed file withholds it). A task keyed up front never follows a writer:
the stability gate classes every reader after an uncached writer, and
every non-folding reader after a cached one, unstable (`stable-keys.md`).
The next run reads the new bytes and keys on them.

## Invariants

- Zero cost without a writer: `moved()` returns before any syscall.
- A task that writes a claimed file from outside the root project,
  unsandboxed, crosses a project boundary and is not watched.
