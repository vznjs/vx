// What a run said that its rows do not hold, for `vx last`: the steps it
// did not wait on (`vx:prefetch`, M 2026-10-16), which never show in a
// run's output, and its warnings, which scroll past on a terminal and are
// gone (an agent reading the run afterwards saw only the footer's count,
// 2026-10-28). One file per run that had any, `<cacheDir>/steps/<runId>.json`
// and `<cacheDir>/warnings/<runId>.json`, the newest 50 of each kept, as
// run-failures.ts keeps failed output: files, not cache.db, so the index
// layout stays as it was. A run with none writes nothing.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isFsRefusal } from '../util/index.js'

/** Runs whose steps (or warnings) are kept; run ids are UUIDv7, so names sort by age. */
const KEPT = 50

/** One of vx's own steps that ran beside the tasks. */
export interface RunStep {
  id: string
  durationMs: number
  ok: boolean
}

type Kept = 'steps' | 'warnings'

function keep(
  cacheDir: string,
  kind: Kept,
  runId: string,
  value: readonly unknown[],
  warn: (message: string) => void,
): void {
  if (value.length === 0) return
  try {
    const dir = path.join(cacheDir, kind)
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${runId}.json`)
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(value))
    renameSync(tmp, file)
    const names = readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .sort()
    for (const n of names.slice(0, -KEPT)) rmSync(path.join(dir, n), { force: true })
  } catch (err) {
    if (!isFsRefusal(err)) throw err
    warn(
      `[vx] ${kind === 'steps' ? 'background steps' : 'warnings'} not kept: ${err.message} — the verdict above stands`,
    )
  }
}

function kept<T>(cacheDir: string, kind: Kept, runId: string): T[] {
  try {
    return JSON.parse(readFileSync(path.join(cacheDir, kind, `${runId}.json`), 'utf8')) as T[]
  } catch {
    return []
  }
}

/** Keep `steps` for `runId`; a refused write costs only them. */
export function writeRunSteps(
  cacheDir: string,
  runId: string,
  steps: readonly RunStep[],
  warn: (message: string) => void,
): void {
  keep(cacheDir, 'steps', runId, steps, warn)
}

/** The background steps `runId` kept; none when it had none or they are gone. */
export function runSteps(cacheDir: string, runId: string): RunStep[] {
  return kept<RunStep>(cacheDir, 'steps', runId)
}

/** Keep the run's warnings as plain text, colour stripped; a refused write costs only them. */
export function writeRunWarnings(
  cacheDir: string,
  runId: string,
  warnings: readonly string[],
  warn: (message: string) => void,
): void {
  keep(
    cacheDir,
    'warnings',
    runId,
    warnings.map((w) => Bun.stripANSI(w)),
    warn,
  )
}

/** The warnings `runId` said; none when it said none or they are gone. */
export function runWarnings(cacheDir: string, runId: string): string[] {
  return kept<string>(cacheDir, 'warnings', runId)
}
