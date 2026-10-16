// The steps a run did not wait on (`vx:prefetch`), for `vx last` (M,
// 2026-10-16): they never show in a run's output. One file per run that
// had one, `<cacheDir>/steps/<runId>.json`, the newest 50 kept, as
// run-failures.ts keeps failed output: files, not cache.db, so the index
// layout stays as it was. A run with none writes nothing.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isFsRefusal } from '../util/index.js'

/** Runs whose background steps are kept; run ids are UUIDv7, so names sort by age. */
const KEPT = 50

/** One of vx's own steps that ran beside the tasks. */
export interface RunStep {
  id: string
  durationMs: number
  ok: boolean
}

const dirOf = (cacheDir: string): string => path.join(cacheDir, 'steps')

/** Keep `steps` for `runId`; a refused write costs only them. */
export function writeRunSteps(
  cacheDir: string,
  runId: string,
  steps: readonly RunStep[],
  warn: (message: string) => void,
): void {
  if (steps.length === 0) return
  try {
    const dir = dirOf(cacheDir)
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${runId}.json`)
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(steps))
    renameSync(tmp, file)
    const names = readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .sort()
    for (const n of names.slice(0, -KEPT)) rmSync(path.join(dir, n), { force: true })
  } catch (err) {
    if (!isFsRefusal(err)) throw err
    warn(`[vx] background steps not kept: ${err.message} — the verdict above stands`)
  }
}

/** The background steps `runId` kept; none when it had none or they are gone. */
export function runSteps(cacheDir: string, runId: string): RunStep[] {
  try {
    return JSON.parse(
      readFileSync(path.join(dirOf(cacheDir), `${runId}.json`), 'utf8'),
    ) as RunStep[]
  } catch {
    return []
  }
}
