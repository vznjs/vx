// The timings file `file` names: what schedule-history learned, as one JSON
// file a CI cache carries between runners. `{ version, tasks: { id: ms } }`,
// keys sorted so an unchanged history writes the same bytes.

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { TaskResources } from '@vzn/vx'

const VERSION = 1

/** The file's durations; none when it is absent, and none, with a warning, when it is not one. */
export function readTimings(file: string, warn: (m: string) => void): Record<string, number> {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    warn(`[vx] schedule-history: timings file ${file} not read: ${(err as Error).message}`)
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const tasks = (parsed as { version?: unknown; tasks?: unknown } | undefined)?.tasks
  if (
    (parsed as { version?: unknown } | undefined)?.version !== VERSION ||
    tasks === null ||
    typeof tasks !== 'object' ||
    Array.isArray(tasks)
  ) {
    warn(
      `[vx] schedule-history: timings file ${file} ignored: not { "version": ${VERSION}, "tasks": { id: ms } }`,
    )
    return {}
  }
  const out: Record<string, number> = {}
  for (const [id, ms] of Object.entries(tasks)) {
    if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) out[id] = ms
  }
  return out
}

/**
 * The carried durations with this machine's p50s over them, written whole:
 * a task this run did not see keeps its carried time. Through a temp and a
 * rename, so a reader never sees half a file.
 */
export function writeTimings(
  file: string,
  carried: Readonly<Record<string, number>>,
  table: ReadonlyMap<string, TaskResources>,
): void {
  const merged: Record<string, number> = { ...carried }
  for (const [id, h] of table) {
    if (h.p50DurationMs !== undefined) merged[id] = Math.round(h.p50DurationMs)
  }
  const tasks: Record<string, number> = {}
  for (const id of Object.keys(merged).sort()) tasks[id] = merged[id]!
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ version: VERSION, tasks }, null, 2)}\n`)
  renameSync(tmp, file)
}
