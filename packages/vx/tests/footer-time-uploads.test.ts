// The run's time counts the uploads it waits on: the footer printed after a
// slow remote's uploads drained said 3.2 s for a 6.4 s run, and history and
// telemetry kept the same short number (hardening, 2026-11-23).
import { Database } from 'bun:sqlite'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'bun:test'
import type { RemoteCacheLayer } from '../src/cache/index.js'
import type { RunSummaryRecord } from '../src/orchestrator/index.js'
import { addProject, makeWorkspace, silentLogger, TIMEOUT } from './helpers/orchestrator-fixture.js'
import { run } from './helpers/orchestrator.js'

const CONFIG = `
  export default {
    tasks: {
      build: {
        exec: { command: 'echo built > out.txt' },
        inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] }, cache: true,
      },
    },
  }
`

const UPLOAD_MS = 1_500

/** `time      1.52s · …` → ms. */
function footerMs(lines: readonly string[]): number {
  const row = lines.map((l) => Bun.stripANSI(l)).find((l) => /^\s*time\s/.test(l))
  const m = /^\s*time\s+(\d+(?:\.\d+)?)(ms|s)\b/.exec(row ?? '')
  if (m === null) throw new Error(`no time row: ${row}`)
  return Number(m[1]) * (m[2] === 's' ? 1000 : 1)
}

it(
  'the footer, history and telemetry time a run through its uploads',
  async () => {
    const fixture = await makeWorkspace('vx-footer-uploads-')
    try {
      await addProject(fixture.root, 'a', { files: { 'src/in.txt': 'a' }, config: CONFIG })
      const layer: RemoteCacheLayer = {
        has: async () => null,
        get: async () => null,
        put: () => Bun.sleep(UPLOAD_MS),
      }
      let summary: RunSummaryRecord | undefined
      const result = await run({
        cwd: fixture.root,
        tasks: ['build'],
        log: silentLogger(fixture),
        remoteCache: layer,
        handleSignals: false,
        telemetrySinks: [{ onRunSummary: (s) => (summary = s) }],
      })
      expect(result.ok).toBe(true)
      const db = new Database(path.join(fixture.root, '.vx', 'cache', 'cache.db'), {
        readonly: true,
      })
      const row = db
        .query('SELECT started_at, ended_at, total_duration_ms FROM invocations')
        .get() as { started_at: number; ended_at: number; total_duration_ms: number }
      db.close()
      expect({
        footer: footerMs(fixture.log) >= UPLOAD_MS,
        history: row.total_duration_ms >= UPLOAD_MS,
        span: row.ended_at - row.started_at >= UPLOAD_MS,
        telemetry: (summary?.totalDurationMs ?? 0) >= UPLOAD_MS,
        telemetryEnd: (summary?.endedAt ?? 0) - (summary?.startedAt ?? 0) >= UPLOAD_MS,
      }).toEqual({ footer: true, history: true, span: true, telemetry: true, telemetryEnd: true })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)
