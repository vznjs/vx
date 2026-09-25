// The workspace fingerprint is read once per run, before any task, and
// every key folds it (and a lockfile plugin's per-project parts, taken from
// the same files). A task in the root project may rewrite one of those
// files — `pnpm install` without `--frozen-lockfile` — and every key taken
// before it then names a lockfile the tree no longer holds: a save under
// one filed bytes built against the new install under the old lockfile's
// key, replayed whenever the tree went back (item 750). The watch answers
// "has a fingerprinted file moved since the run read it", re-learning the
// fact only after a task that may have written one ran (`wrote`), so a run
// with no such task never touches the files again.

import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { FILE_HASH_RACY_MS } from '../cache/index.js'
import { WORKSPACE_FINGERPRINT_FILES, type WorkspaceFingerprints } from '../workspace/index.js'
import type { Logger } from './logger.js'

export class FingerprintWatch {
  private pending = false
  private movedFiles: string[] | undefined
  private said = false

  /** `at`: when the run started reading the files (ms since the epoch). */
  constructor(
    private readonly workspaceRoot: string,
    private readonly read: WorkspaceFingerprints,
    private readonly at: number,
  ) {}

  /** A task that may rewrite a fingerprinted file (`mayWriteFingerprint`) ran a command. */
  wrote(): void {
    this.pending = true
  }

  /**
   * The fingerprinted files that no longer hold what the run read, or
   * undefined. Once one has, the run stays moved: every key already taken
   * folded the old bytes. One `stat` per table entry after each writer; a
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
    for (const f of WORKSPACE_FINGERPRINT_FILES) {
      const abs = path.join(this.workspaceRoot, f)
      const before = this.read.files.get(f)
      let ctimeMs: number
      try {
        ctimeMs = statSync(abs).ctimeMs
      } catch {
        if (before !== undefined) moved.push(f)
        continue
      }
      if (before !== undefined && ctimeMs < this.at - FILE_HASH_RACY_MS) continue
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
    log.status(
      `[vx] a task rewrote \`${this.movedFiles.join('`, `')}\` during the run, which every key ` +
        `folds (the workspace fingerprint): nothing keyed before it is restored or saved from here on`,
    )
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.compare(a, b) === 0
}
