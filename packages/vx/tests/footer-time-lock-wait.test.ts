// The run's time counts its wait for another run's lock: a run that waited
// 3 s behind another said `time 33ms`, and history and telemetry kept the
// same short number (hardening, 2026-11-23).
import { Database } from 'bun:sqlite'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'bun:test'
import type { RunSummaryRecord } from '../src/orchestrator/index.js'
import { addProject, makeWorkspace, silentLogger, TIMEOUT } from './helpers/orchestrator-fixture.js'
import { run } from './helpers/orchestrator.js'

const CONFIG = `
  export default {
    tasks: { build: { exec: { command: 'true' } } },
  }
`

const HOLD_MS = 1_500
const RUN_LOCK = path.resolve(import.meta.dir, '../src/orchestrator/run-lock.ts')

/** `time      1.52s · …` → ms. */
function footerMs(lines: readonly string[]): number {
  const row = lines.map((l) => Bun.stripANSI(l)).find((l) => /^\s*time\s/.test(l))
  const m = /^\s*time\s+(\d+(?:\.\d+)?)(ms|s)\b/.exec(row ?? '')
  if (m === null) throw new Error(`no time row: ${row}`)
  return Number(m[1]) * (m[2] === 's' ? 1000 : 1)
}

it(
  'the footer, history and telemetry time a run through its wait for the lock',
  async () => {
    const fixture = await makeWorkspace('vx-footer-lock-wait-')
    try {
      await addProject(fixture.root, 'a', { config: CONFIG })
      // Another process holds the run lock (one process's runs share it).
      const holder = Bun.spawn(
        [
          process.execPath,
          '-e',
          `const { acquireRunLock } = await import(${JSON.stringify(RUN_LOCK)})
           const release = await acquireRunLock(${JSON.stringify(fixture.root)}, { log: () => {} })
           console.log('held')
           await Bun.sleep(${HOLD_MS})
           await release()`,
        ],
        { stdout: 'pipe', stderr: 'inherit' },
      )
      const reader = holder.stdout.getReader()
      const first = await reader.read()
      expect(new TextDecoder().decode(first.value)).toContain('held')
      let summary: RunSummaryRecord | undefined
      const started = performance.now()
      const result = await run({
        cwd: fixture.root,
        tasks: ['build'],
        log: silentLogger(fixture),
        handleSignals: false,
        telemetrySinks: [{ onRunSummary: (s) => (summary = s) }],
      })
      const waited = performance.now() - started
      await holder.exited
      expect(result.ok).toBe(true)
      const db = new Database(path.join(fixture.root, '.vx', 'cache', 'cache.db'), {
        readonly: true,
      })
      const row = db
        .query('SELECT started_at, ended_at, total_duration_ms FROM invocations')
        .get() as { started_at: number; ended_at: number; total_duration_ms: number }
      db.close()
      // The run did wait; each clock says so, within what run() took in all.
      const bound = (ms: number): boolean => ms >= HOLD_MS / 2 && ms <= waited + 1
      expect({
        waited: waited >= HOLD_MS / 2,
        footer: bound(footerMs(fixture.log)),
        history: bound(row.total_duration_ms),
        span: bound(row.ended_at - row.started_at),
        telemetry: bound(summary?.totalDurationMs ?? 0),
        telemetryEnd: bound((summary?.endedAt ?? 0) - (summary?.startedAt ?? 0)),
      }).toEqual({
        waited: true,
        footer: true,
        history: true,
        span: true,
        telemetry: true,
        telemetryEnd: true,
      })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)
