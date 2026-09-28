// Each example plugin through the real `run()` (or the CLI, for a verb), so
// an example that stops working, or a seam that moves under one, turns red
// here before someone copies it. Fixtures are local to this package: a test
// may not read another project's files, and the sandbox enforces it.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { planRun, run, type Logger } from '@vzn/vx'

const EXAMPLES = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const CORE_BIN = path.resolve(import.meta.dir, '../../vx/src/bin.ts')
const TIMEOUT = 20_000
let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-plugin-examples-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

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
  await writeFile(path.join(dir, 'vx.config.mjs'), config)
  return dir
}

/** `plugins` is source text calling the examples' exports, e.g. `dirCache('/x')`. */
async function workspace(imports: string, plugins: string): Promise<void> {
  await writeFile(
    path.join(root, 'vx.workspace.mjs'),
    `import { ${imports} } from ${JSON.stringify(EXAMPLES)}\nexport default { plugins: [${plugins}] }\n`,
  )
}

function log(): Logger & { order: string[] } {
  const order: string[] = []
  return {
    order,
    status() {},
    taskStart(node: { id: string }) {
      order.push(`start ${node.id}`)
    },
    taskStdout() {},
    taskStderr() {},
    taskComplete(node: { id: string }) {
      order.push(`end ${node.id}`)
    },
  } as Logger & { order: string[] }
}

const byFirst = (x: readonly [string, unknown], y: readonly [string, unknown]): number =>
  x[0].localeCompare(y[0])

const opts = (tasks: string[], extra: Record<string, unknown> = {}) => ({
  cwd: root,
  tasks,
  log: log(),
  handleSignals: false,
  ...extra,
})

describe('shellExecutor', () => {
  it(
    'runs the command and says where; stops it on exec.timeout',
    async () => {
      const dir = await pkg(
        'a',
        `export default { tasks: {
          hello: { exec: { command: 'echo hi > out.txt' } },
          slow: { exec: { command: 'exec sleep 30', timeout: 300 } },
        } }`,
      )
      await workspace('shellExecutor', 'shellExecutor()')
      const ok = await run(opts(['hello']))
      expect(ok.outcomes.map((o) => [o.node.id, o.status, o.where])).toEqual([
        ['a#hello', 'success', 'shell'],
      ])
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).toBe('hi\n')
      const started = Date.now()
      const slow = await run(opts(['slow']))
      expect(slow.outcomes.map((o) => [o.node.id, o.status, o.timedOut === true])).toEqual([
        ['a#slow', 'failed', true],
      ])
      expect(Date.now() - started).toBeLessThan(10_000)
    },
    TIMEOUT,
  )
})

describe('dirCache', () => {
  it(
    'a run on an empty local cache restores from the directory',
    async () => {
      await pkg(
        'a',
        `export default { tasks: { build: {
          exec: { command: 'mkdir -p dist && echo built > dist/out.txt' },
          cache: { inputs: { files: ['package.json'] }, outputs: { files: ['dist/**'] } },
        } } }`,
      )
      const remote = path.join(root, 'remote')
      await workspace('dirCache', `dirCache(${JSON.stringify(remote)})`)
      const first = await run(opts(['build']))
      expect(first.outcomes.map((o) => o.status)).toEqual(['success'])
      await rm(path.join(root, '.vx'), { recursive: true, force: true })
      await rm(path.join(root, 'packages', 'a', 'dist'), { recursive: true, force: true })
      const second = await run(opts(['build']))
      expect(second.outcomes.map((o) => o.status)).toEqual(['cache-hit-remote'])
      expect(await readFile(path.join(root, 'packages', 'a', 'dist', 'out.txt'), 'utf8')).toBe(
        'built\n',
      )
    },
    TIMEOUT,
  )
})

describe('jsonlTelemetry', () => {
  it(
    'appends one line per run',
    async () => {
      await pkg('a', `export default { tasks: { hello: { exec: { command: 'true' } } } }`)
      const file = path.join(root, 'runs.jsonl')
      await workspace('jsonlTelemetry', `jsonlTelemetry(${JSON.stringify(file)})`)
      await run(opts(['hello']))
      await run(opts(['hello']))
      expect(await readFile(file, 'utf8')).toBe(
        '{"tasks":1,"failed":0,"cached":0}\n{"tasks":1,"failed":0,"cached":0}\n',
      )
    },
    TIMEOUT,
  )
})

describe('prioritize', () => {
  it(
    'the named task starts first on one worker, whichever it is',
    async () => {
      for (const name of ['a', 'b']) {
        await pkg(name, `export default { tasks: { build: { exec: { command: 'true' } } } }`)
      }
      const first = async (id: string): Promise<string | undefined> => {
        await workspace('prioritize', `prioritize([${JSON.stringify(id)}])`)
        const l = log()
        await run({ ...opts(['build']), log: l, concurrency: 1 })
        return l.order[0]
      }
      expect(await first('b#build')).toBe('start b#build')
      expect(await first('a#build')).toBe('start a#build')
    },
    TIMEOUT,
  )
})

describe('oneAtATime', () => {
  it(
    'two tasks of the named task never overlap, even with two workers',
    async () => {
      for (const name of ['a', 'b']) {
        await pkg(name, `export default { tasks: { serve: { exec: { command: 'sleep 0.2' } } } }`)
      }
      await workspace('oneAtATime', `oneAtATime('serve')`)
      const l = log()
      await run({ ...opts(['serve']), log: l, concurrency: 2 })
      // Each start is followed by its own end: no second start in between.
      expect(l.order).toHaveLength(4)
      expect(l.order[1]!.replace('end', 'start')).toBe(l.order[0]!)
      expect(l.order[3]!.replace('end', 'start')).toBe(l.order[2]!)
    },
    TIMEOUT,
  )
})

describe('cacheDirVerb', () => {
  it(
    'prints the cache directory; an argument is exit 2',
    async () => {
      await pkg('a', `export default { tasks: {} }`)
      await workspace('cacheDirVerb', 'cacheDirVerb()')
      const ok = Bun.spawnSync([process.execPath, CORE_BIN, 'cache-dir'], { cwd: root })
      expect([ok.exitCode, ok.stdout.toString()]).toEqual([
        0,
        `${path.join(root, '.vx', 'cache')}\n`,
      ])
      const bad = Bun.spawnSync([process.execPath, CORE_BIN, 'cache-dir', 'x'], { cwd: root })
      expect([bad.exitCode, bad.stderr.toString()]).toEqual([
        2,
        'vx cache-dir: takes no arguments, got x\n',
      ])
    },
    TIMEOUT,
  )
})

describe('scriptTasks', () => {
  it(
    'a package.json script runs as a task; a declared task wins',
    async () => {
      const dir = await pkg(
        'a',
        `export default { tasks: { build: { exec: { command: 'echo declared > build.txt' } } } }`,
        { hello: 'echo hi > hello.txt', build: 'echo script > build.txt' },
      )
      await workspace('scriptTasks', 'scriptTasks()')
      const r = await run(opts(['hello', 'build']))
      expect(r.outcomes.map((o) => [o.node.id, o.status] as const).sort(byFirst)).toEqual([
        ['a#build', 'success'],
        ['a#hello', 'success'],
      ])
      expect(await readFile(path.join(dir, 'hello.txt'), 'utf8')).toBe('hi\n')
      expect(await readFile(path.join(dir, 'build.txt'), 'utf8')).toBe('declared\n')
    },
    TIMEOUT,
  )
})

describe('chain', () => {
  it(
    'each named task waits on the one before it in id order',
    async () => {
      for (const name of ['a', 'b', 'c']) {
        await pkg(name, `export default { tasks: { build: { exec: { command: 'true' } } } }`)
      }
      await workspace('chain', `chain('build')`)
      const plan = await planRun({ cwd: root, tasks: ['build'], log: log() })
      expect(plan.tasks.map((t) => [t.node.id, t.deps] as const).sort(byFirst)).toEqual([
        ['a#build', []],
        ['b#build', ['a#build']],
        ['c#build', ['b#build']],
      ])
    },
    TIMEOUT,
  )
})

describe('envKey', () => {
  it(
    "the variable's value moves the key; the same value keeps it",
    async () => {
      await pkg(
        'a',
        `export default { tasks: { build: {
          exec: { command: 'true' },
          cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } },
        } } }`,
      )
      await workspace('envKey', `envKey(['VX_EXAMPLE_FLAG'])`)
      const hash = async (value: string): Promise<string | undefined> => {
        process.env['VX_EXAMPLE_FLAG'] = value
        try {
          const plan = await planRun({ cwd: root, tasks: ['build'], log: log() })
          return plan.tasks[0]!.hash
        } finally {
          delete process.env['VX_EXAMPLE_FLAG']
        }
      }
      const one = await hash('1')
      expect(one).toBeDefined()
      expect(await hash('1')).toBe(one)
      expect(await hash('2')).not.toBe(one)
    },
    TIMEOUT,
  )
})
