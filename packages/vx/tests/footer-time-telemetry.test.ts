// The run's time counts the telemetry flush it waits on: a slow collector's
// 3 s flush ran before the footer, yet the footer said 137ms and history kept
// the same (hardening, 2026-11-23). The summary telemetry is sent is taken
// before its own flush, so it cannot count it.
import { Database } from 'bun:sqlite'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'bun:test'
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

const FLUSH_MS = 1_500

/** `time      1.52s · …` → ms. */
function footerMs(lines: readonly string[]): number {
  const row = lines.map((l) => Bun.stripANSI(l)).find((l) => /^\s*time\s/.test(l))
  const m = /^\s*time\s+(\d+(?:\.\d+)?)(ms|s)\b/.exec(row ?? '')
  if (m === null) throw new Error(`no time row: ${row}`)
  return Number(m[1]) * (m[2] === 's' ? 1000 : 1)
}

it(
  'the footer and history time a run through its telemetry flush',
  async () => {
    const fixture = await makeWorkspace('vx-footer-telemetry-')
    try {
      await addProject(fixture.root, 'a', { files: { 'src/in.txt': 'a' }, config: CONFIG })
      const result = await run({
        cwd: fixture.root,
        tasks: ['build'],
        log: silentLogger(fixture),
        handleSignals: false,
        telemetrySinks: [{ onRunSummary: () => {}, flush: () => Bun.sleep(FLUSH_MS) }],
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
        footer: footerMs(fixture.log) >= FLUSH_MS,
        history: row.total_duration_ms >= FLUSH_MS,
        span: row.ended_at - row.started_at >= FLUSH_MS,
      }).toEqual({ footer: true, history: true, span: true })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)
