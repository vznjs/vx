// The timings file `file` names: what vx-history learned, as one JSON
// file a CI cache carries between runners. `{ version, tasks: { id: ms } }`,
// keys sorted so an unchanged history writes the same bytes.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { TaskResources } from '@vzn/vx'

const VERSION = 1

/** The file's durations; none when it is absent, and none, with a warning, when it is not one. */
export function readTimings(file: string, warn: (m: string) => void): Record<string, number> {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    warn(`[vx] vx-history: timings file ${file} not read: ${(err as Error).message}`)
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // quiet: not JSON is not a timings file, which the warning below says
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
      `[vx] vx-history: timings file ${file} ignored: not { "version": ${VERSION}, "tasks": { id: ms } }`,
    )
    return {}
  }
  const out: Record<string, number> = {}
  for (const [id, ms] of Object.entries(tasks)) {
    // Bounded so no chain of them sums past a number: core refuses a
    // weight that is not finite, and the run failed on a hint.
    if (typeof ms === 'number' && ms >= 0 && ms <= Number.MAX_SAFE_INTEGER) out[id] = ms
  }
  return out
}

/**
 * The carried durations with this machine's p50s over them, written whole:
 * a task this run did not see keeps its carried time. Through a temp and a
 * rename, so a reader never sees half a file. Its directory is made: a CI
 * cache that missed restores none.
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
  mkdirSync(path.dirname(file), { recursive: true })
  try {
    writeFileSync(tmp, `${JSON.stringify({ version: VERSION, tasks }, null, 2)}\n`)
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/**
 * Says so when git does not ignore the file it rewrote: a task whose
 * inputs cover it (a root project's `**`) keyed each run's new timings,
 * and missed the run after every write. Asked after the write, off the run.
 */
export function warnUnignored(file: string, root: string, warn: (m: string) => void): void {
  const rel = path.relative(root, file)
  // `..x.json` is a name inside the root, not a step out of it.
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return
  const p = Bun.spawnSync({
    cmd: ['git', 'check-ignore', '-q', '--', rel],
    cwd: root,
    stdout: 'ignore',
    stderr: 'ignore',
  })
  // 0: ignored; 128: no repository or git refused, which says nothing of it.
  if (p.exitCode !== 1) return
  warn(
    `[vx] vx-history: timings file ${rel} is not git-ignored, so a task whose inputs cover it re-keys on every rewrite — add it to .gitignore`,
  )
}
