// A test for the example `telemetry` plugin beside it: a throwaway workspace
// declares the plugin and vx's own run() drives it. `bun test` runs it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { run, type Logger, type TelemetrySink } from '@vzn/vx'
import { jsonlTelemetry } from './telemetry.ts'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-plugin-telemetry-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A package `name` whose `vx.config.mjs` is `config`. */
async function pkg(
  name: string,
  config: string,
  scripts?: Record<string, string>,
): Promise<string> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', ...(scripts ? { scripts } : {}) }),
  )
  // Core reads no package.json: the config names the project.
  await writeFile(
    path.join(dir, 'vx.config.mjs'),
    config.replace('export default {', `export default { name: ${JSON.stringify(name)},`),
  )
  return dir
}

/**
 * A `.vx/workspace.mjs` declaring `call`, e.g. `jsonlTelemetry()`, from the plugin file
 * beside this test, then `vx lock`: a run reads project configs only from the lock.
 */
async function workspace(call: string): Promise<void> {
  const from = JSON.stringify(path.join(import.meta.dir, 'telemetry.ts'))
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    `import { jsonlTelemetry } from ${from}\nexport default { plugins: [${call}] }\n`,
  )
  const vx = path.join(path.dirname(new URL(import.meta.resolve('@vzn/vx')).pathname), 'bin.ts')
  const lock = Bun.spawnSync({ cmd: [process.execPath, vx, 'lock'], cwd: root })
  expect([lock.exitCode, lock.stderr.toString()]).toEqual([0, ''])
}

function log(order: string[] = []): Logger {
  return {
    status() {},
    taskStart(node) {
      order.push(`start ${node.id}`)
    },
    taskStdout() {},
    taskStderr() {},
    taskComplete(node) {
      order.push(`end ${node.id}`)
    },
  }
}

it('appends one line per run', async () => {
  await pkg('a', `export default { tasks: { hello: { exec: { command: 'true' } } } }`)
  const file = path.join(root, 'runs.jsonl')
  await workspace(`jsonlTelemetry(${JSON.stringify(file)})`)
  await run({ cwd: root, tasks: ['hello'], log: log(), handleSignals: false })
  await run({ cwd: root, tasks: ['hello'], log: log(), handleSignals: false })
  expect(await Bun.file(file).text()).toBe(
    '{"tasks":1,"failed":0,"cached":0}\n{"tasks":1,"failed":0,"cached":0}\n',
  )
}, 20_000)

// Read against the process's cwd, a relative file was another file for a
// run started in a project's directory, written inside that project.
it('writes a relative file at the workspace root', async () => {
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'vx-plugin-telemetry-cwd-'))
  const cwd = process.cwd()
  process.chdir(elsewhere)
  try {
    const plugin = jsonlTelemetry('runs.jsonl')
    const sink = (await plugin.telemetry!({ workspaceRoot: root } as never)) as TelemetrySink
    sink.onRunSummary!({ taskCount: 2, failedCount: 0, hitCount: 1 } as never)
    await sink.flush!(new AbortController().signal)
  } finally {
    process.chdir(cwd)
    await rm(elsewhere, { recursive: true, force: true })
  }
  expect(await Bun.file(path.join(root, 'runs.jsonl')).text()).toBe(
    '{"tasks":2,"failed":0,"cached":1}\n',
  )
})
