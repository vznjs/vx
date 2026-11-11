// Each task's last key, by what its input files were: a `probe` that is the
// fold up to the files (`foldHead`) seeded into a token of the files' git
// records and the declaration that picks among them (`filesToken`). Equal
// probes are equal folds, so a warm task's key is read back instead of
// resolving and folding its files again: ~300 ms of a 5,000-project warm
// run (2026-10-17). One row per task, rewritten when its probe moves; a
// pure memo, so a lost or swept row is one fold more.

import type { Database } from 'bun:sqlite'
import { unreadableIndex } from './schema.js'

export interface FoldMemoRow {
  probe: string
  key: string
}

/** What a key fold asks of the memo; the rows stay core's (`IndexFoldMemo`). */
export interface FoldMemo {
  /** The key remembered for `taskId` under `probe`, if that is the probe it was folded under. */
  get(taskId: string, probe: string): string | undefined
  set(taskId: string, probe: string, key: string): void
}

export class IndexFoldMemo implements FoldMemo {
  private rows: Map<string, FoldMemoRow> | undefined
  private readonly runRows = new Map<string, FoldMemoRow | null>()
  private readonly dirty = new Map<string, FoldMemoRow>()

  constructor(
    private readonly db: Database,
    /** The local WRITE axis: off, and a fold is answered but not remembered. */
    private readonly write: boolean,
  ) {}

  /** The key remembered for `taskId` under `probe`, if that is the probe it was folded under. */
  get(taskId: string, probe: string): string | undefined {
    const row = this.dirty.get(taskId) ?? this.readable(taskId)
    return row?.probe === probe ? row.key : undefined
  }

  // A page SQLite cannot read reached `vx run` as a raw `SQLiteError` and a
  // stack (2026-11-11). A memo it cannot read is no memo: every fold is
  // made afresh, and the entries' own reads refuse the file by name.
  private readable(taskId: string): FoldMemoRow | null | undefined {
    try {
      return this.read(taskId)
    } catch (err) {
      if (!unreadableIndex(err)) throw err
      this.rows ??= new Map()
      this.runRows.set(taskId, null)
      return undefined
    }
  }

  private read(taskId: string): FoldMemoRow | null | undefined {
    // A run's own rows (`\0run\0…`, the graph's) are read one each: a warm
    // run whose keys are remembered whole asks for no task's row, and
    // reading all of them held every task's row to the end of the run.
    if (taskId.startsWith('\0')) {
      let row = this.runRows.get(taskId)
      if (row === undefined) {
        row = this.db
          .query('SELECT probe, key FROM fold_memo WHERE task_id = ?')
          .get(taskId) as FoldMemoRow | null
        this.runRows.set(taskId, row)
      }
      return row
    }
    // One read of every task's row: a run that folds asks for nearly all of them.
    this.rows ??= new Map(
      (
        this.db
          .query('SELECT task_id, probe, key FROM fold_memo WHERE task_id >= ?')
          .all('\u0001') as Array<{
          task_id: string
          probe: string
          key: string
        }>
      ).map((r) => [r.task_id, { probe: r.probe, key: r.key }]),
    )
    return this.rows.get(taskId)
  }

  set(taskId: string, probe: string, key: string): void {
    if (this.write) this.dirty.set(taskId, { probe, key })
  }

  /** Write the folds this run made. */
  flush(now: number = Date.now()): void {
    if (this.dirty.size === 0) return
    const upsert = this.db.prepare(
      'INSERT OR REPLACE INTO fold_memo(task_id, probe, key, seen_at) VALUES (?, ?, ?, ?)',
    )
    this.db.transaction(() => {
      for (const [taskId, r] of this.dirty) upsert.run(taskId, r.probe, r.key, now)
    })()
    this.dirty.clear()
  }

  /** Drop the rows no run has rewritten since `cutoff`; returns how many. */
  prune(cutoff: number): number {
    return this.db.prepare('DELETE FROM fold_memo WHERE seen_at < ?').run(cutoff).changes
  }
}
