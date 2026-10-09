// A failed run's task output and the files it names, so an agent reads why
// a task failed without the terminal (`vx last --format json`, vx-mcp's
// getFailures). One file per failed run, `<cacheDir>/failures/<runId>.json`,
// the newest 50 kept: files, not cache.db, so the index layout (and every
// shared store under it) stays as it was.

import type { Database } from 'bun:sqlite'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isGroupTask, type TaskOutcome } from '../graph/index.js'
import { decodeOutputLog } from './output-log.js'
import { splitTaskId } from '../util/index.js'
import { fileLocations, fileMemo, type OutputLocation } from './path-links.js'

/** Failed runs whose output is kept; run ids are UUIDv7, so names sort by age. */
const KEPT = 50

/** A failed task of a run and what it said. */
export interface TaskFailure {
  taskId: string
  exitCode: number
  timedOut?: true
  /** Plain text, bounded, secrets masked; '' when the run kept none. */
  output: string
  locations: OutputLocation[]
}

export interface RunFailures {
  runId: string
  tasks: TaskFailure[]
}

interface StoredFailure extends TaskFailure {
  project: string
  task: string
}

const dirOf = (cacheDir: string): string => path.join(cacheDir, 'failures')

/** Each failed outcome's output as plain text and the files it names. */
function failuresOf(outcomes: readonly TaskOutcome[]): StoredFailure[] {
  const isFile = fileMemo()
  const out: StoredFailure[] = []
  for (const o of outcomes) {
    if (o.failedOutput === undefined || isGroupTask(o.node)) continue
    const output = Bun.stripANSI(
      decodeOutputLog(o.failedOutput)
        .map((c) => c.text)
        .join(''),
    )
    out.push({
      taskId: o.node.id,
      project: o.node.projectName,
      task: o.node.taskName,
      exitCode: o.exitCode,
      ...(o.timedOut === true ? { timedOut: true as const } : {}),
      output,
      locations: fileLocations(output, o.node.projectDir, isFile),
    })
  }
  return out
}

/**
 * Write the run's failures, when any outcome carries output, and drop all
 * but the newest `KEPT` files. Atomic: a reader sees the whole file or none.
 */
export function writeRunFailures(
  cacheDir: string,
  runId: string,
  outcomes: readonly TaskOutcome[],
): void {
  const tasks = failuresOf(outcomes)
  if (tasks.length === 0) return
  const dir = dirOf(cacheDir)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${runId}.json`)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ runId, tasks }))
  renameSync(tmp, file)
  const names = readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()
  for (const n of names.slice(0, -KEPT)) rmSync(path.join(dir, n), { force: true })
}

/**
 * The failed tasks of `runId`, or of the latest failed run when omitted;
 * null when there is no such run. A failed task the file lacks (an older
 * run, a write the disk refused) reads `output: ''`, `locations: []`.
 */
export function runFailures(cacheDir: string, db: Database, runId?: string): RunFailures | null {
  const id =
    runId ??
    (
      db
        .query('SELECT run_id FROM invocations WHERE exit_ok = 0 ORDER BY rowid DESC LIMIT 1')
        .get() as { run_id: string } | null
    )?.run_id
  if (id === undefined) return null
  const kept = new Map<string, StoredFailure>()
  try {
    const stored = JSON.parse(
      readFileSync(path.join(dirOf(cacheDir), `${id}.json`), 'utf8'),
    ) as RunFailures & { tasks: StoredFailure[] }
    for (const t of stored.tasks) kept.set(t.taskId, t)
  } catch (err) {
    // No file: the run kept no output.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const rows = db
    .query(
      `SELECT project, task, exit_code AS exitCode, timed_out AS timedOut FROM runs
       WHERE run_id = ? AND status = 'failed' ORDER BY id`,
    )
    .all(id) as { project: string; task: string; exitCode: number; timedOut: number | null }[]
  return {
    runId: id,
    tasks: rows.map((r) => {
      const taskId = `${r.project}#${r.task}`
      const k = kept.get(taskId)
      return {
        taskId,
        exitCode: r.exitCode,
        ...(r.timedOut === 1 ? { timedOut: true as const } : {}),
        output: k?.output ?? '',
        locations: k?.locations ?? [],
      }
    }),
  }
}

/** One task's output in a recorded run, as `vx last --log` and getTaskLog read it. */
export interface TaskLog {
  runId: string
  taskId: string
  status: string
  /**
   * Where the output came from: the run's kept failure output, the cache
   * entry the task saved or hit (masked as it was replayed), or null when
   * vx kept none (an uncached task that passed, a skip).
   */
  source: 'failure' | 'cache' | null
  /** Plain text; '' when `source` is null. The files it names: `runFailures`. */
  output: string
}

/**
 * `taskId`'s output in `runId`, or in the latest run that recorded the
 * task when omitted; null when no such run recorded it.
 */
export function taskLog(
  cacheDir: string,
  db: Database,
  taskId: string,
  runId?: string,
): TaskLog | null {
  const [project, task] = splitTaskId(taskId)
  if (project === '' || task === '') return null
  const row = db
    .query(
      `SELECT run_id AS runId, hash, status FROM runs
       WHERE project = ? AND task = ? AND run_id IS NOT NULL ${runId === undefined ? '' : 'AND run_id = ?'}
       ORDER BY id DESC LIMIT 1`,
    )
    .get(...(runId === undefined ? [project, task] : [project, task, runId])) as {
    runId: string
    hash: string
    status: string
  } | null
  if (row === null) return null
  const base = { runId: row.runId, taskId, status: row.status }
  if (row.status === 'failed') {
    const kept = runFailures(cacheDir, db, row.runId)?.tasks.find((t) => t.taskId === taskId)
    if (kept !== undefined && kept.output !== '') {
      return { ...base, source: 'failure', output: kept.output }
    }
  } else if (row.hash !== '') {
    const stored = db.query('SELECT stdout FROM entry_stdout WHERE hash = ?').get(row.hash) as {
      stdout: string
    } | null
    if (stored !== null) {
      const output = Bun.stripANSI(
        decodeOutputLog(stored.stdout)
          .map((c) => c.text)
          .join(''),
      )
      return { ...base, source: 'cache', output }
    }
  }
  return { ...base, source: null, output: '' }
}
