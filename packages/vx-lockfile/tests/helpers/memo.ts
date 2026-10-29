// The claimant's memo of a lockfile, as core keeps it: a row of cache.db's
// `lockfile_memos`, its JSON columns parsed. A row is planted to prove a
// run read it instead of parsing.
import { Database } from 'bun:sqlite'
import path from 'node:path'

export interface Memo {
  version: number
  lock: string
  extras: Record<string, string>
  importers: Record<string, string>
  edges: Record<string, unknown>
  recorded: Record<string, string[]> | null
}

const JSON_COLUMNS = ['extras', 'importers', 'edges', 'recorded'] as const

/** `file`'s memo the last write left in `cacheDir`'s index. */
export function readMemo(cacheDir: string, file: string): Memo {
  const db = new Database(path.join(cacheDir, 'cache.db'), { readonly: true })
  try {
    const row = db
      .query(
        'SELECT version, lock, extras, importers, edges, recorded FROM lockfile_memos WHERE file = ? ORDER BY rowid DESC LIMIT 1',
      )
      .get(file) as Record<string, unknown> | null
    if (row === null) throw new Error(`no memo of ${file} in ${cacheDir}`)
    for (const c of JSON_COLUMNS) row[c] = row[c] === null ? null : JSON.parse(row[c] as string)
    return row as unknown as Memo
  } finally {
    db.close()
  }
}

/** Rewrite that memo as `edit` leaves it. */
export function editMemo(cacheDir: string, file: string, edit: (memo: Memo) => void): void {
  const memo = readMemo(cacheDir, file)
  edit(memo)
  const db = new Database(path.join(cacheDir, 'cache.db'))
  try {
    db.run(
      `UPDATE lockfile_memos SET extras = ?, importers = ?, edges = ?, recorded = ?
       WHERE rowid = (SELECT MAX(rowid) FROM lockfile_memos WHERE file = ?)`,
      [...JSON_COLUMNS.map((c) => (memo[c] === null ? null : JSON.stringify(memo[c]))), file],
    )
  } finally {
    db.close()
  }
}
