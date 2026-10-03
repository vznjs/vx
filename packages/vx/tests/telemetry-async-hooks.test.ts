// A sink's `onRecord` and `onRunSummary` are typed `void`, yet an `async`
// one that rejected did so where no one listened: an unhandled rejection,
// a stack, the run killed with exit 1 — observability breaking the run.
// A rejection disables the sink as a throw does, said once, however many
// records' rejections follow the first.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { run, type Logger } from '../src/index.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-async-sink-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  for (const name of ['a', 'b']) {
    const dir = path.join(root, 'packages', name)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      "export default { tasks: { build: { exec: { command: 'sleep 0.3' } } } }\n",
    )
  }
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function runWith(sink: string): Promise<{ ok: boolean; said: string[] }> {
  await Bun.write(
    path.join(root, 'vx.workspace.mjs'),
    localWorkspaceSource([pluginSource('org/sink', `{ telemetry() { return ${sink} } }`)]),
  )
  const status: string[] = []
  const log = {
    taskStart() {},
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
    runStatus() {},
    runEnd() {},
    status: (m: string) => status.push(m),
  } as unknown as Logger
  const summary = await run({ cwd: root, tasks: ['build'], log, handleSignals: false })
  await Bun.sleep(100)
  return { ok: summary.ok, said: status.filter((m) => m.includes('telemetry sink')) }
}

it('an async onRecord that rejects disables the sink, said once', async () => {
  expect(
    // Each rejection lands 50 ms on, while the tasks (0.3 s) still run:
    // both tasks' start records are in flight when the first disables it.
    await runWith(
      `{ name: 's', async onRecord() { await Bun.sleep(50); throw new Error('boom') }, async flush() {} }`,
    ),
  ).toEqual({
    ok: true,
    said: ["[vx] telemetry sink 's' threw in onRecord; disabled for this run: boom"],
  })
})

it('an async onRunSummary that rejects disables the sink, said once', async () => {
  expect(
    await runWith(
      `{ name: 's', async onRunSummary() { throw new Error('boom') }, async flush() {} }`,
    ),
  ).toEqual({
    ok: true,
    said: ["[vx] telemetry sink 's' threw in onRunSummary; disabled for this run: boom"],
  })
})

// Control: a sync throw was already isolated.
it('an onRecord that throws disables the sink, said once', async () => {
  expect(
    await runWith(`{ name: 's', onRecord() { throw new Error('boom') }, async flush() {} }`),
  ).toEqual({
    ok: true,
    said: ["[vx] telemetry sink 's' threw in onRecord; disabled for this run: boom"],
  })
})
