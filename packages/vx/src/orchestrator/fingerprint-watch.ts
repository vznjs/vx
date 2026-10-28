// The files the plugins claim (`VxPlugin.fingerprint`) are read once per
// run, before any task, and every key folds what their claimant takes
// from them (a lockfile plugin's per-project parts). A task in the root
// project may rewrite one of those files — `pnpm install` without `--frozen-lockfile` — and every key taken
// before it then names a lockfile the tree no longer holds: a save under
// one filed bytes built against the new install under the old lockfile's
// key, replayed whenever the tree went back (item 750). The watch answers
// "has a claimed file moved since the run read it", re-learning the
// fact only after a task that may have written one ran (`wrote`), so a run
// with no such task never touches the files again.

import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { FILE_HASH_RACY_MS, racyWindowMs } from '../cache/index.js'
import { type Logger, warnOf } from '../report/index.js'

export class FingerprintWatch {
  private pending = false
  private movedFiles: string[] | undefined
  private said = false

  /**
   * `names`: the claimed files; `read`: the bytes of those that existed;
   * `at`: when the run started reading them (ms since the epoch).
   */
  constructor(
    private readonly workspaceRoot: string,
    readonly names: readonly string[],
    private readonly read: ReadonlyMap<string, Uint8Array>,
    private readonly at: number,
  ) {}

  /** A task that may rewrite a claimed file (`mayWriteFingerprint`) ran a command. */
  wrote(): void {
    this.pending = true
  }

  /**
   * The claimed files that no longer hold what the run read, or
   * undefined. Once one has, the run stays moved: every key already taken
   * folded the old bytes. One `stat` per claimed file after each writer; a
   * file written since the read (by ctime, with git's racy window) is read
   * and compared. The stat follows a link as both reads do: a lockfile
   * that is a symlink, rewritten through it, moves its target's ctime and
   * never the link's, and an `lstat` here skipped it once the link had
   * aged past the window — a stale hit on every later run (item 760).
   */
  moved(): readonly string[] | undefined {
    if (this.movedFiles !== undefined || !this.pending) return this.movedFiles
    this.pending = false
    const moved: string[] = []
    for (const f of this.names) {
      const abs = path.join(this.workspaceRoot, f)
      const before = this.read.get(f)
      let ctimeMs: number
      try {
        ctimeMs = statSync(abs).ctimeMs
      } catch {
        if (before !== undefined) moved.push(f)
        continue
      }
      // A whole-second stamp widens the window by that second (A-2): a
      // rewrite 400 ms after the read was stamped before it (C-59).
      if (before !== undefined && ctimeMs < this.at - racyWindowMs(ctimeMs, FILE_HASH_RACY_MS))
        continue
      let now: Uint8Array | undefined
      try {
        now = readFileSync(abs)
      } catch {
        // Not a file (the run-start read skipped it the same way).
      }
      if (
        now === undefined ? before !== undefined : before === undefined || !sameBytes(now, before)
      ) {
        moved.push(f)
      }
    }
    if (moved.length > 0) this.movedFiles = moved
    return this.movedFiles
  }

  /** The run's one line about it, however many tasks it withholds. */
  say(log: Logger): void {
    if (this.said || this.movedFiles === undefined) return
    this.said = true
    warnOf(log)(
      `[vx] a task rewrote \`${this.movedFiles.join('`, `')}\` during the run, which a plugin ` +
        `puts into every key: nothing keyed before it is restored or saved from here on`,
    )
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.compare(a, b) === 0
}
