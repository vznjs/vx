// A failed run's task output and the files it names, so an agent reads why
// a task failed without the terminal (`vx last --format json`). One file per failed run, `<cacheDir>/failures/<runId>.json`,
// the newest 50 kept: files, not cache.db, so the index layout (and every
// shared store under it) stays as it was.

import type { Database } from 'bun:sqlite'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isGroupTask, type TaskOutcome } from '../graph/index.js'
import { decodeOutputLog } from './output-log.js'
import { PASS_STATUSES } from '../history/index.js'
import { isFsRefusal, maskedLine, splitTaskId } from '../util/index.js'
import { fileLocations, fileMemo, type OutputLocation } from '../report/index.js'

/** Failed runs whose output is kept; run ids are UUIDv7, so names sort by age. */
const KEPT = 50

/** A failed task of a run and what it said. */
export interface TaskFailure {
  taskId: string
  exitCode: number
  timedOut?: true
  /** The input that changed while the command ran (see `TaskOutcome`). */
  inputMoved?: string
  /** Plain text, bounded, secrets masked; '' when the run kept none. */
  output: string
  locations: OutputLocation[]
  /** The `exec.sandbox.allow` entries that would have granted its denials. */
  sandboxFix?: NonNullable<TaskOutcome['sandboxFix']>
  /** The first later run where this task passed (ran or hit): the failure is history. */
  fixedIn?: string
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
    // A task failed by a moved input may have printed nothing: the input
    // is still why, and an agent reads it here.
    if ((o.failedOutput === undefined && o.inputMoved === undefined) || isGroupTask(o.node))
      continue
    const output =
      o.failedOutput === undefined
        ? ''
        : Bun.stripANSI(
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
      ...(o.inputMoved !== undefined ? { inputMoved: o.inputMoved } : {}),
      output,
      locations: fileLocations(output, o.node.projectDir, isFile),
      ...(o.sandboxFix !== undefined ? { sandboxFix: o.sandboxFix } : {}),
    })
  }
  return out
}

/**
 * Write the run's failures, when any outcome carries output, and drop all
 * but the newest `KEPT` files. Atomic: a reader sees the whole file or none.
 * A refused write (a full disk, a read-only cache dir) costs only this
 * output: `warn` says so and the run's verdict stands.
 */
export function writeRunFailures(
  cacheDir: string,
  runId: string,
  outcomes: readonly TaskOutcome[],
  warn: (message: string) => void,
): void {
  const tasks = failuresOf(outcomes)
  if (tasks.length === 0) return
  try {
    keep(cacheDir, runId, tasks)
  } catch (err) {
    if (!isFsRefusal(err)) throw err
    warn(`[vx] failed tasks' output not kept: ${err.message} — the verdict above stands`)
  }
}

function keep(cacheDir: string, runId: string, tasks: TaskFailure[]): void {
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
  const kept = storedFailures(cacheDir, id)
  const rows = db
    .query(
      `SELECT r.project, r.task, r.exit_code AS exitCode, r.timed_out AS timedOut,
         (SELECT s.run_id FROM runs s WHERE s.project = r.project AND s.task = r.task
            AND s.id > r.id AND s.status IN ${PASS_STATUSES}
          ORDER BY s.id LIMIT 1) AS fixedIn
       FROM runs r WHERE r.run_id = ? AND r.status = 'failed' ORDER BY r.id`,
    )
    .all(id) as {
    project: string
    task: string
    exitCode: number
    timedOut: number | null
    fixedIn: string | null
  }[]
  return {
    runId: id,
    tasks: rows.map((r) => {
      const taskId = `${r.project}#${r.task}`
      const k = kept.get(taskId)
      return {
        taskId,
        exitCode: r.exitCode,
        ...(r.timedOut === 1 ? { timedOut: true as const } : {}),
        ...(k?.inputMoved !== undefined ? { inputMoved: k.inputMoved } : {}),
        output: k?.output ?? '',
        locations: k?.locations ?? [],
        ...(k?.sandboxFix !== undefined ? { sandboxFix: k.sandboxFix } : {}),
        ...(r.fixedIn !== null ? { fixedIn: r.fixedIn } : {}),
      }
    }),
  }
}

/** What `runId`'s failures file holds, by task id; empty when the run kept none. */
function storedFailures(cacheDir: string, runId: string): Map<string, StoredFailure> {
  const kept = new Map<string, StoredFailure>()
  try {
    const stored = JSON.parse(
      readFileSync(path.join(dirOf(cacheDir), `${runId}.json`), 'utf8'),
    ) as RunFailures & { tasks: StoredFailure[] }
    for (const t of stored.tasks) kept.set(t.taskId, t)
  } catch (err) {
    // No file: the run kept no output.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  return kept
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
    // Only the file: runFailures reads `output: ''` for a task it lacks, as
    // if the task printed nothing, when the run is past the newest 50.
    const kept = storedFailures(cacheDir, row.runId).get(taskId)
    if (kept !== undefined) return { ...base, source: 'failure', output: kept.output }
  } else if (row.hash !== '') {
    const stored = db.query('SELECT stdout FROM entry_stdout WHERE hash = ?').get(row.hash) as {
      stdout: string
    } | null
    if (stored !== null) {
      // An entry saved before masking, or by another machine, can hold a
      // secret-named variable's value: masked as a hit's replay masks it.
      // This process's env only: `vx last` loads no config, so a task's
      // `env.define` / `env.secret` values are not known here.
      const output = maskedLine(
        Bun.stripANSI(
          decodeOutputLog(stored.stdout)
            .map((c) => c.text)
            .join(''),
        ),
      )
      return { ...base, source: 'cache', output }
    }
    // An entry that printed nothing stores no stdout row: kept, and empty.
    if (db.query('SELECT 1 FROM entries WHERE hash = ?').get(row.hash) !== null) {
      return { ...base, source: 'cache', output: '' }
    }
  }
  return { ...base, source: null, output: '' }
}
