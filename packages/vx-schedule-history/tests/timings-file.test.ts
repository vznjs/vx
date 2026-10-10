// `file` carries learned durations between machines: run 1 writes each
// task's p50, a fresh cache orders run 2 by the file, a recorded p50 wins
// over it, and a `--dry` plan writes nothing.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { planRun, run, type HistoryTable, type Logger } from '@vzn/vx'
import { readTimings, writeTimings } from '../src/timings-file.js'

const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const TIMEOUT = 20_000
let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-timings-file-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function silent(warnings: string[] = []): Logger & { started: string[] } {
  const started: string[] = []
  return {
    started,
    status(m: string) {
      warnings.push(m)
    },
    taskStart(node: { id: string }) {
      started.push(node.id)
    },
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
  } as Logger & { started: string[] }
}

describe('readTimings / writeTimings', () => {
  it('reads what it wrote, this machine over the carried, keys sorted', async () => {
    const file = path.join(root, 't.json')
    const table: HistoryTable = new Map([
      ['b#x', { p50DurationMs: 120.4 } as never],
      ['c#x', { p50DurationMs: undefined } as never],
    ])
    writeTimings(file, { 'b#x': 5, 'a#x': 7 }, table)
    expect(await readFile(file, 'utf8')).toBe(
      '{\n  "version": 1,\n  "tasks": {\n    "a#x": 7,\n    "b#x": 120\n  }\n}\n',
    )
    expect(readTimings(file, () => {})).toEqual({ 'a#x': 7, 'b#x': 120 })
  })

  it('an absent file is empty; one that is not a timings file warns and is empty', async () => {
    const warnings: string[] = []
    expect(readTimings(path.join(root, 'none.json'), (m) => warnings.push(m))).toEqual({})
    expect(warnings).toEqual([])
    const file = path.join(root, 'bad.json')
    for (const body of ['{', '{"version":2,"tasks":{}}', '{"version":1,"tasks":[]}']) {
      await writeFile(file, body)
      expect(readTimings(file, (m) => warnings.push(m))).toEqual({})
    }
    expect(warnings).toHaveLength(3)
    await writeFile(file, '{"version":1,"tasks":{"a":1,"b":"2","c":-1,"d":null}}')
    expect(readTimings(file, (m) => warnings.push(m))).toEqual({ a: 1 })
  })
})

describe('the file between machines', () => {
  async function pkg(name: string, config: string): Promise<void> {
    const dir = path.join(root, 'packages', name)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
    await writeFile(path.join(dir, 'vx.config.mjs'), config)
  }

  it(
    'a fresh cache orders by the file; a dry plan leaves it alone',
    async () => {
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'ws', private: true }),
      )
      await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
      Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
      // Chain b is slow, a trivial; insertion order starts a.
      await pkg(
        'a',
        "export default { tasks: { build: { exec: { command: 'true' } }, test: { dependsOn: ['build'], exec: { command: 'true' } } } }\n",
      )
      await pkg(
        'b',
        "export default { tasks: { build: { exec: { command: 'sleep 0.15' } }, test: { dependsOn: ['build'], exec: { command: 'sleep 0.15' } } } }\n",
      )
      await writeFile(
        path.join(root, 'vx.workspace.mjs'),
        `import { scheduleHistoryPlugin } from ${JSON.stringify(PLUGIN_INDEX)}\n` +
          "export default { cacheDir: '.cache', plugins: [scheduleHistoryPlugin({ file: 'timings.json' })] }\n",
      )
      const opts = { cwd: root, tasks: ['test'], concurrency: 1, handleSignals: false }
      const file = path.join(root, 'timings.json')

      const first = silent()
      expect((await run({ ...opts, log: first })).ok).toBe(true)
      expect(first.started[0]).toBe('a#build')
      const written = readTimings(file, () => {})
      expect(Object.keys(written)).toEqual(['a#build', 'a#test', 'b#build', 'b#test'])
      expect(written['b#build']!).toBeGreaterThan(written['a#build']! + 100)

      // Another machine: no history, the file alone.
      await rm(path.join(root, '.cache'), { recursive: true, force: true })
      const second = silent()
      expect((await run({ ...opts, log: second })).ok).toBe(true)
      expect(second.started[0]).toBe('b#build')

      const bytes = '{"version":1,"tasks":{"a#build":999999}}'
      await writeFile(file, bytes)
      await planRun({ ...opts, log: silent() })
      expect(await readFile(file, 'utf8')).toBe(bytes)
      // A recorded p50 wins over the file's claim.
      const third = silent()
      expect((await run({ ...opts, log: third })).ok).toBe(true)
      expect(third.started[0]).toBe('b#build')
    },
    TIMEOUT,
  )

  it(
    'an all-cached run whose tasks the file times leaves it as it was',
    async () => {
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'ws', private: true }),
      )
      await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
      Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
      await pkg(
        'a',
        "export default { tasks: { build: { exec: { command: 'true' }, cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } } } } }\n",
      )
      await writeFile(
        path.join(root, 'vx.workspace.mjs'),
        `import { scheduleHistoryPlugin } from ${JSON.stringify(PLUGIN_INDEX)}\n` +
          "export default { cacheDir: '.cache', plugins: [scheduleHistoryPlugin({ file: 'timings.json' })] }\n",
      )
      const opts = { cwd: root, tasks: ['build'], handleSignals: false }
      const file = path.join(root, 'timings.json')
      expect((await run({ ...opts, log: silent() })).ok).toBe(true)
      expect(Object.keys(readTimings(file, () => {}))).toEqual(['a#build'])
      const complete = '{"version":1,"tasks":{"a#build":777}}'
      await writeFile(file, complete)
      const summary = await run({ ...opts, log: silent() })
      expect(summary.outcomes.map((o) => o.status)).toEqual(['cache-hit'])
      expect(await readFile(file, 'utf8')).toBe(complete)
    },
    TIMEOUT,
  )

  it(
    'an all-cached run through a group the file cannot time leaves it as it was',
    async () => {
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'ws', private: true }),
      )
      await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
      Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
      await pkg(
        'a',
        "export default { tasks: { build: { exec: { command: 'true' }, cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } } }, all: { dependsOn: ['build'] } } }\n",
      )
      await writeFile(
        path.join(root, 'vx.workspace.mjs'),
        `import { scheduleHistoryPlugin } from ${JSON.stringify(PLUGIN_INDEX)}\n` +
          "export default { cacheDir: '.cache', plugins: [scheduleHistoryPlugin({ file: 'timings.json' })] }\n",
      )
      const opts = { cwd: root, tasks: ['all'], handleSignals: false }
      const file = path.join(root, 'timings.json')
      expect((await run({ ...opts, log: silent() })).ok).toBe(true)
      expect(Object.keys(readTimings(file, () => {}))).toEqual(['a#build'])
      const complete = '{"version":1,"tasks":{"a#build":777}}'
      await writeFile(file, complete)
      const summary = await run({ ...opts, log: silent() })
      // A group runs nothing, so the file never times it (X-226).
      expect(summary.outcomes.map((o) => `${o.node.id} ${o.status}`).sort()).toEqual([
        'a#all success',
        'a#build cache-hit',
      ])
      expect(await readFile(file, 'utf8')).toBe(complete)
    },
    TIMEOUT,
  )
})
