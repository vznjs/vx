// `file` carries learned durations between machines: run 1 writes each
// task's p50, a fresh cache orders run 2 by the file, a recorded p50 wins
// over it, and a `--dry` plan writes nothing.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { type HistoryTable, type Logger } from '@vzn/vx'
import { planRun, run } from '../../vx/tests/helpers/orchestrator.js'
import { readTimings, warnUnignored, writeTimings } from '../src/timings-file.js'

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

  // A CI cache that missed restores no directory: `file: '.cache/t.json'`
  // failed every write with ENOENT, so the file never existed to be cached.
  // A write that fails leaves no temp file behind.
  it('writes into a directory that does not exist yet; a failed write leaves no temp', async () => {
    const file = path.join(root, 'new', 'dir', 't.json')
    writeTimings(file, { 'a#x': 1 }, new Map())
    expect(readTimings(file, () => {})).toEqual({ 'a#x': 1 })
    const dir = path.join(root, 'is-a-dir')
    await mkdir(dir)
    expect(() => writeTimings(dir, {}, new Map())).toThrow()
    expect((await readdir(root)).sort()).toEqual(['is-a-dir', 'new'])
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
    // Core reads no package.json: the config names the project.
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      config.replace('export default {', `export default { name: ${JSON.stringify(name)},`),
    )
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
      // Chain b is slow, a trivial; insertion order starts a. b#build's
      // 0.4 s outlasts a loaded host's spawn of `true` (115 ms seen).
      await pkg(
        'a',
        "export default { tasks: { build: { exec: { command: 'true' } }, test: { dependsOn: ['build'], exec: { command: 'true' } } } }\n",
      )
      await pkg(
        'b',
        "export default { tasks: { build: { exec: { command: 'sleep 0.4' } }, test: { dependsOn: ['build'], exec: { command: 'sleep 0.15' } } } }\n",
      )
      await Bun.write(
        path.join(root, '.vx/workspace.mjs'),
        `import { vxHistory } from ${JSON.stringify(PLUGIN_INDEX)}\n` +
          "export default { cache: { dir: '.cache' }, plugins: [vxHistory({ file: 'timings.json' })] }\n",
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
        "export default { tasks: { build: { exec: { command: 'true' }, inputs: { files: ['package.json'] }, cache: { outputs: { files: [] } } } } }\n",
      )
      await Bun.write(
        path.join(root, '.vx/workspace.mjs'),
        `import { vxHistory } from ${JSON.stringify(PLUGIN_INDEX)}\n` +
          "export default { cache: { dir: '.cache' }, plugins: [vxHistory({ file: 'timings.json' })] }\n",
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
        "export default { tasks: { build: { exec: { command: 'true' }, inputs: { files: ['package.json'] }, cache: { outputs: { files: [] } } }, all: { dependsOn: ['build'] } } }\n",
      )
      await Bun.write(
        path.join(root, '.vx/workspace.mjs'),
        `import { vxHistory } from ${JSON.stringify(PLUGIN_INDEX)}\n` +
          "export default { cache: { dir: '.cache' }, plugins: [vxHistory({ file: 'timings.json' })] }\n",
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

// Two hand-edited 1e308s on one chain summed to Infinity, and core
// refuses a weight that is not finite: an ordering hint failed the run.
it(
  'durations whose chain sums past a number are dropped, not a failed run',
  async () => {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
    await mkdir(path.join(root, 'a'), { recursive: true })
    await writeFile(
      path.join(root, 'a', 'vx.config.mjs'),
      "export default { name: 'a', tasks: { build: { exec: { command: 'true' } }, test: { dependsOn: ['build'], exec: { command: 'true' } } } }\n",
    )
    await writeFile(
      path.join(root, 'timings.json'),
      '{"version":1,"tasks":{"a#build":1e308,"a#test":1e308}}',
    )
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      `import { vxHistory } from ${JSON.stringify(PLUGIN_INDEX)}\n` +
        "export default { cache: { dir: '.cache' }, plugins: [vxHistory({ file: 'timings.json', assume: { 'a#build': Number.MAX_VALUE } })] }\n",
    )
    const said: string[] = []
    const summary = await run({
      cwd: root,
      tasks: ['test'],
      handleSignals: false,
      log: silent(said),
    })
    expect([summary.ok, said.filter((m) => m.includes('schedule'))]).toEqual([true, []])
    expect(readTimings(path.join(root, 'timings.json'), () => {})).toEqual({
      'a#build': expect.any(Number),
      'a#test': expect.any(Number),
    })
  },
  TIMEOUT,
)

// A failed rewrite (a read-only cache mount, a path through a file)
// surfaced as core's bare `failed in teardown: EEXIST: mkdir …`, naming
// neither the timings file nor that only the file was lost.
it(
  'a timings file it cannot write is named, and the run is not failed',
  async () => {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
    await mkdir(path.join(root, 'a'), { recursive: true })
    await writeFile(
      path.join(root, 'a', 'vx.config.mjs'),
      "export default { name: 'a', tasks: { build: { exec: { command: 'true' } } } }\n",
    )
    await writeFile(path.join(root, 'blocker'), '')
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      `import { vxHistory } from ${JSON.stringify(PLUGIN_INDEX)}\n` +
        "export default { cache: { dir: '.cache' }, plugins: [vxHistory({ file: 'blocker/timings.json' })] }\n",
    )
    const said: string[] = []
    const summary = await run({
      cwd: root,
      tasks: ['build'],
      handleSignals: false,
      log: silent(said),
    })
    expect(summary.ok).toBe(true)
    const file = path.join(root, 'blocker', 'timings.json')
    expect(
      said.filter((m) => m.includes('vx-history')).map((m) => m.split(/: E[A-Z]+:/)[0]),
    ).toEqual([
      `[vx] vx-history: timings file ${file} not read`,
      `[vx] vx-history: timings file ${file} not written`,
    ])
  },
  TIMEOUT,
)

// The README's `.vx-timings.json` sat untracked at the root, where a root
// project's `**` keyed it: each rewrite missed the next run, unsaid.
it('says a timings file git does not ignore re-keys the tasks over it', async () => {
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  const said: string[] = []
  const file = path.join(root, '.vx-timings.json')
  await writeFile(file, '{}')
  warnUnignored(file, root, (m) => said.push(m))
  expect(said).toEqual([
    '[vx] vx-history: timings file .vx-timings.json is not git-ignored, so a task whose inputs cover it re-keys on every rewrite — add it to .gitignore',
  ])
  await writeFile(path.join(root, '.gitignore'), '.vx-timings.json\n')
  warnUnignored(file, root, (m) => said.push(m))
  warnUnignored(path.join(os.tmpdir(), 'elsewhere.json'), root, (m) => said.push(m))
  expect(said).toHaveLength(1)
  // A name that starts with `..` is in the workspace; it read as outside it.
  const dotted = path.join(root, '..vx-timings.json')
  await writeFile(dotted, '{}')
  warnUnignored(dotted, root, (m) => said.push(m))
  expect(said.slice(1)).toEqual([
    '[vx] vx-history: timings file ..vx-timings.json is not git-ignored, so a task whose inputs cover it re-keys on every rewrite — add it to .gitignore',
  ])
})

// A chain's weight is its durations summed: two `1e308`s from a CI cache's
// file (or `assume`) summed to Infinity, and core refused the weight —
// `failed in schedule` — so an ordering hint failed every run.
it(
  'a duration no run takes is dropped, from the file and from assume: the run stays green',
  async () => {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, '.gitignore'), 't.json\n')
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
    const dir = path.join(root, 'packages', 'a')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'a', version: '1.0.0' }))
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      "export default { name: 'a', tasks: { build: { exec: { command: 'true' } }, test: { dependsOn: ['build'], exec: { command: 'true' } }, lint: { dependsOn: ['test'], exec: { command: 'true' } } } }\n",
    )
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      `import { vxHistory } from ${JSON.stringify(PLUGIN_INDEX)}\n` +
        "export default { cache: { dir: '.cache' }, plugins: [vxHistory({ file: 't.json', assume: { 'a#lint': 1e308 } })] }\n",
    )
    await writeFile(
      path.join(root, 't.json'),
      '{"version":1,"tasks":{"a#build":1e308,"a#test":1e308,"a#x":5}}',
    )
    const warnings: string[] = []
    const summary = await run({
      cwd: root,
      tasks: ['lint'],
      concurrency: 1,
      handleSignals: false,
      log: silent(warnings),
    })
    expect([summary.ok, warnings.filter((w) => w.includes('vx-history'))]).toEqual([
      true,
      ['[vx] vx-history: assume ignores "a#lint" — each must be a number of ms from 0 to 2^53'],
    ])
    // The rewrite keeps no such duration either.
    const kept = readTimings(path.join(root, 't.json'), () => {})
    expect([kept['a#build'] !== undefined && kept['a#build'] < 1e6, kept['a#x']]).toEqual([true, 5])
  },
  TIMEOUT,
)

// The rewrite was of the file as the run read it before ordering: a time
// another writer (a run in another worktree sharing the file) put there
// while this run ran was lost, though a task this run did not see keeps
// its time.
it(
  'the rewrite keeps a time written to the file while the run ran',
  async () => {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, '.gitignore'), 't.json\n')
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
    const dir = path.join(root, 'packages', 'a')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'a', version: '1.0.0' }))
    // The task is the other writer.
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `export default { name: 'a', tasks: { build: { exec: { command: ${JSON.stringify(`printf '{"version":1,"tasks":{"b#build":42}}' > ../../t.json`)} } } } }\n`,
    )
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      `import { vxHistory } from ${JSON.stringify(PLUGIN_INDEX)}\n` +
        "export default { cache: { dir: '.cache' }, plugins: [vxHistory({ file: 't.json' })] }\n",
    )
    await writeFile(path.join(root, 't.json'), '{"version":1,"tasks":{"c#build":7}}')
    const summary = await run({ cwd: root, tasks: ['build'], handleSignals: false, log: silent() })
    expect(summary.ok).toBe(true)
    expect(Object.keys(readTimings(path.join(root, 't.json'), () => {}))).toEqual([
      'a#build',
      'b#build',
      'c#build',
    ])
  },
  TIMEOUT,
)
