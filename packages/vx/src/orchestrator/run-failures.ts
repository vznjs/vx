// A failed run's task output and the files it names, so an agent reads why
// a task failed without the terminal (`vx last --format json`). Rows of
// cache.db's `failures` (cache/run-notes.ts), the newest 50 failed runs kept.

import type { Database } from 'bun:sqlite'
import { indexDb, type Cache, keepRunNotes, keptFailures, storedLog } from '../cache/index.js'
import { isGroupTask, type TaskOutcome } from '../graph/index.js'
import { decodeOutputLog } from './output-log.js'
import { PASS_STATUSES } from '../history/index.js'
import { maskedLine, splitTaskId } from '../util/index.js'
import { fileLocations, fileMemo, type OutputLocation } from '../ui/index.js'

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

/**
 * Keep the run's failures, when any outcome carries output. A refused write
 * (a full disk) costs only this output: `warn` says so and the run's
 * verdict stands.
 */
export function writeRunFailures(
  cache: Cache,
  runId: string,
  outcomes: readonly TaskOutcome[],
  warn: (message: string) => void,
): void {
  const isFile = fileMemo()
  const failures = []
  for (const o of outcomes) {
    // A task failed by a moved input may have printed nothing: the input
    // is still why, and an agent reads it here. A pass that took a retry
    // keeps its failed attempts.
    if (
      (o.failedOutput === undefined &&
        o.inputMoved === undefined &&
        o.attemptOutputs === undefined) ||
      isGroupTask(o.node)
    )
      continue
    const output = attemptsText(o)
    failures.push({
      taskId: o.node.id,
      ...(o.inputMoved !== undefined ? { inputMoved: o.inputMoved } : {}),
      output,
      locations: fileLocations(output, o.node.projectDir, isFile),
      ...(o.sandboxFix !== undefined ? { sandboxFix: o.sandboxFix } : {}),
    })
  }
  if (failures.length === 0) return
  try {
    keepRunNotes(indexDb(cache), runId, { failures })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    warn(`[vx] failed tasks' output not kept: ${message} — the verdict above stands`)
  }
}

const plain = (log: string): string =>
  Bun.stripANSI(
    decodeOutputLog(log)
      .map((c) => c.text)
      .join(''),
  )

/** How attempt `n` of `of` ended, the line above its output. */
const attemptHeading = (n: number, of: number, how: string): string =>
  `── attempt ${n} of ${of} · ${how} ──\n`

const ended = (a: { exitCode: number; timedOut?: true }): string =>
  a.timedOut === true ? 'timed out' : `exit ${a.exitCode}`

/**
 * What a failure row keeps of `o`: its output, after each failed attempt's
 * under a heading when it retried. A pass that retried keeps only the
 * failed attempts: its own output is its cache entry's.
 */
function attemptsText(o: TaskOutcome): string {
  const last = o.failedOutput === undefined ? '' : plain(o.failedOutput)
  const before = o.attemptOutputs ?? []
  if (before.length === 0) return last
  const of = before.length + 1
  let text = ''
  before.forEach((log, i) => {
    const out = plain(log)
    text += attemptHeading(i + 1, of, ended(o.failedAttempts![i]!)) + out
    if (out !== '' && !out.endsWith('\n')) text += '\n'
  })
  if (o.status === 'failed') text += attemptHeading(of, of, ended(o)) + last
  return text
}

/**
 * The failed tasks of `runId`, or of the latest failed run when omitted;
 * null when there is no such run. A failed task with no kept row (a run
 * past the newest 50, a write the disk refused) reads `output: ''`,
 * `locations: []`.
 */
export function runFailures(db: Database, runId?: string): RunFailures | null {
  const id =
    runId ??
    (
      db
        .query('SELECT run_id FROM invocations WHERE exit_ok = 0 ORDER BY rowid DESC LIMIT 1')
        .get() as { run_id: string } | null
    )?.run_id
  if (id === undefined) return null
  const kept = keptFailures(db, id)
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
        locations: (k?.locations ?? []) as OutputLocation[],
        ...(k?.sandboxFix !== undefined
          ? { sandboxFix: k.sandboxFix as NonNullable<TaskOutcome['sandboxFix']> }
          : {}),
        ...(r.fixedIn !== null ? { fixedIn: r.fixedIn } : {}),
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
export function taskLog(db: Database, taskId: string, runId?: string): TaskLog | null {
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
    // Only the kept row: runFailures reads `output: ''` for a task it lacks,
    // as if the task printed nothing, when the run is past the newest 50.
    const kept = keptFailures(db, row.runId).get(taskId)
    if (kept !== undefined) return { ...base, source: 'failure', output: kept.output }
  } else if (row.hash !== '') {
    // A pass that took a retry: its failed attempts, then its own output.
    const before = keptFailures(db, row.runId).get(taskId)?.output
    const tries = (
      db
        .query(
          'SELECT attempts FROM runs WHERE run_id = ? AND project = ? AND task = ? ORDER BY id DESC LIMIT 1',
        )
        .get(row.runId, project, task) as { attempts: number | null } | null
    )?.attempts
    const prefix =
      before === undefined || tries === null || tries === undefined
        ? ''
        : `${before}${attemptHeading(tries, tries, 'passed')}`
    const stored = db.query('SELECT stdout FROM entry_stdout WHERE hash = ?').get(row.hash) as {
      stdout: Uint8Array
    } | null
    if (stored !== null) {
      // An entry saved before masking, or by another machine, can hold a
      // secret-named variable's value: masked as a hit's replay masks it.
      // This process's env only: `vx last` loads no config, so a task's
      // `env.define` / `env.secret` values are not known here.
      const output = maskedLine(
        Bun.stripANSI(
          decodeOutputLog(storedLog(stored.stdout))
            .map((c) => c.text)
            .join(''),
        ),
      )
      return { ...base, source: 'cache', output: prefix + output }
    }
    // An entry that printed nothing stores no stdout row: kept, and empty.
    if (db.query('SELECT 1 FROM entries WHERE hash = ?').get(row.hash) !== null) {
      return { ...base, source: 'cache', output: prefix }
    }
  }
  // A pass with no entry that took a retry still kept its failed attempts.
  const kept = row.status === 'failed' ? undefined : keptFailures(db, row.runId).get(taskId)
  if (kept !== undefined) return { ...base, source: 'failure', output: kept.output }
  return { ...base, source: null, output: '' }
}
