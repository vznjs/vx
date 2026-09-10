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
