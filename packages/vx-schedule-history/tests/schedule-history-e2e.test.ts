// The plugin end to end through the real `run()`: with one worker and two
// chains of identical shape, the chain the workspace's own history says is
// slow starts first. The fixture is local to this package on purpose — a
// test may not read another project's files, and the sandbox enforces it.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run, type Logger } from '@vzn/vx'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const CORE_BIN = path.resolve(import.meta.dir, '../../vx/src/bin.ts')
const TIMEOUT = 20_000
let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-schedule-history-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function pkg(name: string, config: string): Promise<void> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  await writeFile(path.join(dir, 'vx.config.mjs'), config)
}

function timed(): Logger & { spans: Map<string, { start: number; end: number }> } {
  const spans = new Map<string, { start: number; end: number }>()
  return {
    spans,
    status() {},
    taskStart(node: { id: string }) {
      spans.set(node.id, { start: Bun.nanoseconds(), end: 0 })
    },
    taskStdout() {},
    taskStderr() {},
    taskComplete(node: { id: string }) {
      const s = spans.get(node.id)
      if (s) s.end = Bun.nanoseconds()
    },
  } as Logger & { spans: Map<string, { start: number; end: number }> }
}

function silent(): Logger & { started: string[] } {
  const started: string[] = []
  return {
    started,
    status() {},
    taskStart(node: { id: string }) {
      started.push(node.id)
    },
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
  } as Logger & { started: string[] }
}

describe('schedule-history plugin end to end', () => {
  it(
    'orders by the critical path learned from this workspace’s own run history',
    async () => {
      // Two independent chains of identical shape. Chain B is slow in
      // history, chain A trivial; with one worker the plugin must start B.
      // Insertion order (a first) would start A — so the plugin has to
      // reverse the insertion order, or the pin proves nothing.
      await pkg(
        'a',
        "export default { tasks: { build: { exec: { command: 'true' } }, test: { dependsOn: ['build'], exec: { command: 'true' } } } }\n",
      )
      await pkg(
        'b',
        "export default { tasks: { build: { exec: { command: 'sleep 0.15' } }, test: { dependsOn: ['build'], exec: { command: 'sleep 0.15' } } } }\n",
      )
      await Bun.write(
        path.join(root, 'vx.workspace.mjs'),
        `import { scheduleHistoryPlugin } from ${JSON.stringify(PLUGIN_INDEX)}\n` +
          localWorkspaceSource(['scheduleHistoryPlugin()']),
      )
      // Run 1 records the durations (no history yet → insertion order).
      const first = silent()
      await run({ cwd: root, tasks: ['test'], concurrency: 1, log: first, handleSignals: false })
      expect(first.started[0]).toBe('a#build')
      // Run 2: history says chain B is the critical path → B's head first.
      const second = silent()
      const summary = await run({
        cwd: root,
        tasks: ['test'],
        concurrency: 1,
        log: second,
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      expect(second.started[0]).toBe('b#build')
    },
    TIMEOUT,
  )

  it(
    'a reservation learned from history keeps two memory-hungry tasks from running together',
    async () => {
      // Two tasks that each hold ~200 MB for a moment, under the plugin's
      // 512 MB budget and two workers. Run 1 has no history: nothing is
      // reserved, both run at once (their spans overlap). Run 2 has each
      // task's peak RSS: ~250 MB × 1.25 → 320 MB each, 640 > 512, so the
      // second waits for the first (no overlap). The differential is the
      // overlap itself; a run that reserved nothing would overlap both times.
      const hog =
        'export default { tasks: { build: { exec: { command: \'bun -e "const b = Buffer.alloc(200 * 1024 * 1024, 1); await Bun.sleep(400); console.log(b.length)"\' } } } }\n'
      await pkg('a', hog)
      await pkg('b', hog)
      await Bun.write(
        path.join(root, 'vx.workspace.mjs'),
        `import { scheduleHistoryPlugin } from ${JSON.stringify(PLUGIN_INDEX)}\n` +
          localWorkspaceSource(['scheduleHistoryPlugin({ memory: 512 })']),
      )
      const spans = (log: ReturnType<typeof timed>): boolean => {
        const [x, y] = [log.spans.get('a#build')!, log.spans.get('b#build')!]
        return x.start < y.end && y.start < x.end
      }
      const first = timed()
      const r1 = await run({
        cwd: root,
        tasks: ['build'],
        concurrency: 2,
        cache: { localRead: false, localWrite: true, remoteRead: false, remoteWrite: false },
        log: first,
        handleSignals: false,
      })
      expect(r1.ok).toBe(true)
      expect(spans(first)).toBe(true)
      const second = timed()
      const r2 = await run({
        cwd: root,
        tasks: ['build'],
        concurrency: 2,
        cache: { localRead: false, localWrite: true, remoteRead: false, remoteWrite: false },
        log: second,
        handleSignals: false,
      })
      expect(r2.ok).toBe(true)
      expect(spans(second)).toBe(false)
    },
    TIMEOUT,
  )

  it(
    '`vx history` shows what the plugin learned per task and the reservation it packs',
    async () => {
      // One ~200 MB task and two trivial tasks, run once; then the verb,
      // through the real dispatcher. The hog's row carries its peak RSS
      // and a learned reservation (its peak × 1.25, up to 64 MB); a
      // declared reservation shows as declared.
      await pkg(
        'a',
        'export default { tasks: { build: { exec: { command: \'bun -e "const b = Buffer.alloc(200 * 1024 * 1024, 1); await Bun.sleep(50); console.log(b.length)"\' } } } }\n',
      )
      await pkg('b', "export default { tasks: { build: { exec: { command: 'true' } } } }\n")
      await pkg('c', "export default { tasks: { build: { exec: { command: 'true' } } } }\n")
      await Bun.write(
        path.join(root, 'vx.workspace.mjs'),
        `import { scheduleHistoryPlugin } from ${JSON.stringify(PLUGIN_INDEX)}\n` +
          localWorkspaceSource([
            "scheduleHistoryPlugin({ memory: 4096, reservations: { 'c#build': { memory: 1024, cpus: 2 } } })",
          ]),
      )
      const r1 = await run({
        cwd: root,
        tasks: ['build'],
        concurrency: 2,
        log: silent(),
        handleSignals: false,
      })
      expect(r1.ok).toBe(true)
      const json = Bun.spawnSync({
        cmd: [process.execPath, CORE_BIN, 'history', '--format', 'json'],
        cwd: root,
      })
      expect(json.exitCode).toBe(0)
      const out = JSON.parse(json.stdout.toString()) as {
        window: number
        budgets: { cpus: number; memory: number }
        tasks: {
          id: string
          runs: number
          maxPeakRssBytes: number | null
          reservation: { memory?: number; cpus?: number } | null
          declared: boolean
        }[]
      }
      expect(out.window).toBe(20)
      expect(out.budgets.memory).toBe(4096)
      expect(out.budgets.cpus).toBeGreaterThanOrEqual(1)
      const byId = new Map(out.tasks.map((t) => [t.id, t]))
      const a = byId.get('a#build')!
      expect(a.runs).toBe(1)
      expect(a.maxPeakRssBytes).toBeGreaterThan(200 * 1024 * 1024)
      expect(a.reservation?.memory).toBeGreaterThanOrEqual(256)
      expect(a.reservation?.memory).toBeLessThanOrEqual(640)
      expect(a.reservation!.memory! % 64).toBe(0)
      expect(a.declared).toBe(false)
      // Every learned reservation is the estimator's rule over the peak the
      // same row shows: × 1.25, up to the next 64 MB, absent under one step.
      // (`true` itself peaks near the step on this runner, so whether it
      // reserves is the rule's call, not the pin's.)
      for (const t of out.tasks.filter((t) => !t.declared && t.maxPeakRssBytes !== null)) {
        const mb = (t.maxPeakRssBytes! * 1.25) / (1024 * 1024)
        const expected = mb >= 64 ? Math.ceil(mb / 64) * 64 : undefined
        expect(t.reservation?.memory).toBe(expected)
      }
      const b = byId.get('b#build')!
      expect(b.runs).toBe(1)
      expect(b.reservation?.cpus).toBeUndefined()
      const c = byId.get('c#build')!
      expect(c.runs).toBe(1)
      expect(c.maxPeakRssBytes).toBeGreaterThan(0)
      expect(c.reservation).toEqual({ memory: 1024, cpus: 2 })
      expect(c.declared).toBe(true)
      const pretty = Bun.spawnSync({ cmd: [process.execPath, CORE_BIN, 'history'], cwd: root })
      expect(pretty.exitCode).toBe(0)
      const text = pretty.stdout.toString()
      expect(text).toContain('budgets')
      expect(text).toMatch(/a#build\s+1\s+\S+\s+\d+ MB\s+\S+\s+\d+ MB$/m)
      expect(text).toMatch(/b#build\s+1\s+\S+\s+\d+ (KB|MB)\s+\S+\s+(—|\d+ MB)$/m)
      expect(text).toMatch(/c#build\s+1\s+.*1024 MB · 2 cores \(declared\)$/m)
      const bad = Bun.spawnSync({
        cmd: [process.execPath, CORE_BIN, 'history', '--nope'],
        cwd: root,
      })
      expect(bad.exitCode).not.toBe(0)
      expect(bad.stderr.toString()).toContain('unknown flag: --nope')
    },
    TIMEOUT,
  )

  it(
    'an assumed duration orders the very first run, before any history exists',
    async () => {
      // The same two chains, no history: the case above pins that this run
      // starts A (insertion order). `assume` names B's head as long, so the
      // cold run starts B — what a fresh CI runner needs.
      await pkg(
        'a',
        "export default { tasks: { build: { exec: { command: 'true' } }, test: { dependsOn: ['build'], exec: { command: 'true' } } } }\n",
      )
      await pkg(
        'b',
        "export default { tasks: { build: { exec: { command: 'true' } }, test: { dependsOn: ['build'], exec: { command: 'true' } } } }\n",
      )
      await Bun.write(
        path.join(root, 'vx.workspace.mjs'),
        `import { scheduleHistoryPlugin } from ${JSON.stringify(PLUGIN_INDEX)}\n` +
          localWorkspaceSource(["scheduleHistoryPlugin({ assume: { 'b#build': 30000 } })"]),
      )
      const first = silent()
      const summary = await run({
        cwd: root,
        tasks: ['test'],
        concurrency: 1,
        log: first,
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      expect(first.started[0]).toBe('b#build')
    },
    TIMEOUT,
  )
})
