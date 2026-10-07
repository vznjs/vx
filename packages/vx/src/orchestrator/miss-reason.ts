// Why a task missed the cache, for telemetry: its key's components against
// the last entry this cache saved for the same task. The `vx why` join
// (`diffKeyComponents`), asked at run time instead of after it.
//
// Paid only when a telemetry sink exists, and only on a miss: one scan of
// `entries` for the newest entry per task, the first time a miss asks, then
// one primary-key read of that entry's `entry_inputs` per miss.

import type { Database } from 'bun:sqlite'
import type { InputChanges } from '../graph/index.js'
import { diffKeyComponents } from './metrics.js'
import type { TaskInputComponent } from './task-hash.js'

/** How many changed components a miss names; `count` says how many there were. */
const NAMED = 10

export type MissExplainer = (
  taskId: string,
  components: readonly TaskInputComponent[],
) => InputChanges | undefined

export function createMissExplainer(db: Database): MissExplainer {
  let newest: Map<string, string> | undefined
  return (taskId, components) => {
    try {
      // Each task asks before its own command runs, so its own new entry is
      // never the one it is compared with.
      newest ??= new Map(
        (
          db
            // A bare column beside MAX() comes from the row that has it.
            .query(
              'SELECT project, task, hash, MAX(created_at) FROM entries GROUP BY project, task',
            )
            .all() as { project: string; task: string; hash: string }[]
        ).map((r) => [`${r.project}#${r.task}`, r.hash]),
      )
      const prev = newest.get(taskId)
      if (prev === undefined) return undefined
      const before = db
        .query('SELECT kind, name, hash FROM entry_inputs WHERE entry_hash = ?')
        .all(prev) as TaskInputComponent[]
      // Pruned, or saved before fingerprints were kept: nothing to compare.
      if (before.length === 0) return undefined
      const { entries } = diffKeyComponents(before, components)
      return {
        count: entries.length,
        first: entries.slice(0, NAMED).map(({ kind, name, change }) => ({ kind, name, change })),
      }
    } catch {
      // History is observability: an unreadable one explains nothing.
      return undefined
    }
  }
}
