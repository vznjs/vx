// Each task's last key, by what its input files were: a `probe` that is the
// fold up to the files (`foldHead`) seeded into a token of the files' git
// records and the declaration that picks among them (`filesToken`). Equal
// probes are equal folds, so a warm task's key is read back instead of
// resolving and folding its files again: ~300 ms of a 5,000-project warm
// run (2026-10-17). One row per task, rewritten when its probe moves; a
// pure memo, so a lost or swept row is one fold more.

import type { Database } from 'bun:sqlite'

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
  private readonly dirty = new Map<string, FoldMemoRow>()

  constructor(
    private readonly db: Database,
    /** The local WRITE axis: off, and a fold is answered but not remembered. */
    private readonly write: boolean,
  ) {}

  /** The key remembered for `taskId` under `probe`, if that is the probe it was folded under. */
  get(taskId: string, probe: string): string | undefined {
    // One read of every row: a warm run asks for nearly all of them.
    this.rows ??= new Map(
      (
        this.db.query('SELECT task_id, probe, key FROM fold_memo').all() as Array<{
          task_id: string
          probe: string
          key: string
        }>
      ).map((r) => [r.task_id, { probe: r.probe, key: r.key }]),
    )
    const row = this.dirty.get(taskId) ?? this.rows.get(taskId)
    return row?.probe === probe ? row.key : undefined
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

  /** Rows no run has rewritten since `cutoff`. */
  prune(cutoff: number): void {
    this.db.prepare('DELETE FROM fold_memo WHERE seen_at < ?').run(cutoff)
  }
}
