// A run id as a user types it: the whole id, or a prefix of one, as git
// takes a short sha, and as `vx last --list` prints it.

import type { Database } from 'bun:sqlite'
import { UserError } from '../util/index.js'

/**
 * The recorded run `raw` names: itself when recorded, else the one run
 * whose id starts with it. Null when none does; a prefix several runs share
 * is refused with those runs, since picking one would replay the wrong run.
 */
export function resolveRunId(db: Database, raw: string, verb: string): string | null {
  const exact = db.query('SELECT 1 FROM invocations WHERE run_id = ?').get(raw)
  if (exact !== null) return raw
  const rows = db
    .query(
      'SELECT run_id FROM invocations WHERE substr(run_id, 1, ?) = ? ORDER BY run_id DESC LIMIT 6',
    )
    .all(raw.length, raw) as Array<{ run_id: string }>
  if (rows.length === 0) return null
  if (rows.length === 1) return rows[0]!.run_id
  const shown = rows.slice(0, 5).map((r) => `  ${r.run_id}`)
  throw new UserError(
    `${verb}: run id ${raw} is the start of ${rows.length > 5 ? 'more than 5' : rows.length} runs — type more of it:\n${shown.join('\n')}`,
  )
}

/**
 * The shortest prefix of `id` no other recorded run shares, and never
 * shorter than 13 characters: a UUIDv7's first 13 are its millisecond
 * clock, so a shorter one is part of a timestamp. Two indexed lookups, the
 * ids sorted either side of it, since the longest prefix any id shares
 * with it is shared with one of those two.
 */
export function shortRunId(db: Database, id: string): string {
  const next = db.query('SELECT run_id FROM invocations WHERE run_id > ? ORDER BY run_id LIMIT 1')
  const prev = db.query(
    'SELECT run_id FROM invocations WHERE run_id < ? ORDER BY run_id DESC LIMIT 1',
  )
  let shared = 0
  for (const row of [next.get(id), prev.get(id)] as Array<{ run_id: string } | null>) {
    if (row === null) continue
    let n = 0
    while (n < id.length && id[n] === row.run_id[n]) n++
    shared = Math.max(shared, n)
  }
  return id.slice(0, Math.max(13, shared + 1))
}
