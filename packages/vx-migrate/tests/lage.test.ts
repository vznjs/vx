// A lage workspace runs under vx with no vx.config written. The fixture
// takes its shapes from real lage repos (2026-09-28): react-native-windows'
// array shorthand and `cacheOptions.outputGlob`, lage's own `^^transpile`,
// `pkg#task` override, noop and worker targets, a `/`-rooted
// `environmentGlob`, and fluentui-react-native's root-package target.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { loadProjectConfig, planRun, run, type Logger } from '@vzn/vx'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { loadLageConfig } from '../src/lage/lage-map.js'

const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const WORKER_BIN = path.resolve(import.meta.dir, '..', 'src', 'lage-worker.cjs')
const CORE_PKG = path.resolve(import.meta.dir, '..', '..', 'vx')
const TIMEOUT = 30_000

let root: string

function silent(): Logger & { lines: string[] } {
  const lines: string[] = []
  const log = {
    lines,
    status: (line: string) => lines.push(line),
    runStart() {},
    taskStart() {},
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
    runStatus() {},
    runEnd() {},
  }
  return log as unknown as Logger & { lines: string[] }
}

async function write(rel: string, text: string): Promise<void> {
  const file = path.join(root, rel)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text)
}

async function pkg(name: string, scripts: Record<string, string>, deps: string[] = []) {
  await write(
    `packages/${name}/package.json`,
    JSON.stringify({
      name,
      scripts,
      dependencies: Object.fromEntries(deps.map((d) => [d, '*'])),
    }),
  )
  await write(`packages/${name}/src/index.ts`, `// ${name}\n`)
}

// The pipeline lives in a file the config requires: an edit there must remap.
const CONFIG = `const path = require('path')
const shared = require('./scripts/pipeline.js')
module.exports = {
  pipeline: {
    ...shared,
    types: {
      type: 'worker',
      options: { worker: path.join(__dirname, 'scripts/types.js'), flavor: 'strict', taskArgs: ['--x'] },
      dependsOn: ['^types'],
      outputs: ['types/**'],
    },
    bundle: { dependsOn: ['^^transpile', 'types'], outputs: ['dist/**'] },
    'app#bundle': { dependsOn: ['^^transpile'], outputs: ['out/**'] },
    test: ['build'],
    lint: { cache: false },
    '#format': { cache: false },
    'ws-root#check': { cache: false },
    ci: { type: 'noop', dependsOn: ['test', 'lint', 'ws-root#check'] },
  },
  cacheOptions: {
    outputGlob: [],
    environmentGlob: ['!node_modules/**/*', '/package.json', 'tsconfig.base.json'],
  },
}
`
// A lage worker: a module whose exported function gets the target.
const WORKER = `const fs = require('fs')
const path = require('path')
module.exports = async function ({ target, taskArgs }) {
  if (target.packageName === 'mid') throw new Error('mid has no types')
  fs.mkdirSync(path.join(target.cwd, 'types'), { recursive: true })
  const line = [target.id, target.task, target.options.flavor, ...taskArgs].join(' ')
  fs.writeFileSync(path.join(target.cwd, 'types', 'index.d.ts'), line + '\\n')
}
`
const PIPELINE = `module.exports = {
  build: ['^build'],
  transpile: { outputs: ['lib/**'], weight: () => 1 },
}
`

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-lage-'))
  await write(
    'package.json',
    JSON.stringify({ name: 'ws-root', private: true, workspaces: ['packages/*'] }),
  )
  await write('.gitignore', 'lib\ndist\nout\ntypes\nnode_modules\n')
  await write('scripts/types.js', WORKER)
  // As an install links it: the bin at the root's node_modules/.bin.
  await mkdir(path.join(root, 'node_modules', '.bin'), { recursive: true })
  await symlink(WORKER_BIN, path.join(root, 'node_modules', '.bin', 'lage-worker'))
  await write('tsconfig.base.json', '{}\n')
  await write('lage.config.js', CONFIG)
  await write('scripts/pipeline.js', PIPELINE)
  await pkg('base', {
    transpile: 'mkdir -p lib && cp src/index.ts lib/index.js',
    build: 'echo build base',
  })
  // `mid` has no transpile script: a pass-through in lage's graph.
  await pkg('mid', { build: 'echo build mid' }, ['base'])
  await pkg(
    'app',
    {
      transpile: 'mkdir -p lib && cat src/index.ts > lib/app.js',
      build: 'echo build app',
      bundle: 'mkdir -p out && cat src/index.ts > out/app.js',
      test: 'echo test',
      lint: 'echo lint',
    },
    ['mid'],
  )
  await write(
    'vx.workspace.mjs',
    localWorkspaceSource(['lage()'], `import { lage } from ${JSON.stringify(PLUGIN_INDEX)}\n`),
  )
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('lage()', () => {
  it(
    'maps scripts, ^ and ^^ edges, a pkg#task override, noop and worker targets, and the cache options',
    async () => {
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['app#bundle', 'app#ci', 'build'], log })
      const tasks = new Map(plan.tasks.map((t) => [t.node.id, t.node]))
      expect([...tasks.keys()].sort()).toEqual([
        'app#build',
        'app#bundle',
        'app#ci',
        'app#lint',
        'app#test',
        'base#build',
        'base#transpile',
        'mid#build',
      ])
      // `app#bundle` replaces `bundle` (no `types` edge); `^^transpile`
      // reaches base through mid, which has no transpile script.
      const bundle = tasks.get('app#bundle')!
      expect(bundle.deps).toEqual(['base#transpile'])
      expect(bundle.config.cache?.outputs.files).toEqual(['out/**'])
      expect(bundle.config.cache?.inputs.files).toEqual(['**/*'])
      expect(bundle.config.cache?.inputs.workspaceFiles).toEqual([
        '!node_modules/**/*',
        'package.json',
        'tsconfig.base.json',
      ])
      // `^build` reaches mid, the nearest holder.
      expect(tasks.get('app#build')!.deps).toEqual(['mid#build'])
      expect(tasks.get('base#transpile')!.config.cache?.outputs.files).toEqual(['lib/**'])
      // No outputs of its own: `cacheOptions.outputGlob`, here none.
      expect(tasks.get('app#test')!.config.cache?.outputs.files).toEqual([])
      expect(tasks.get('app#lint')!.config.cache).toBeUndefined()
      // A noop is a group; its edge to the root target is dropped.
      expect(tasks.get('app#ci')!.config.exec).toBeUndefined()
      expect(tasks.get('app#ci')!.deps.sort()).toEqual(['app#lint', 'app#test'])
      expect(log.lines).toContain(
        '[@vzn/vx-migrate] note: workspace-root targets (#format, ws-root#check) are not mapped — vx has no workspace-root tasks',
      )
    },
    TIMEOUT,
  )

  it(
    'a target with no outputs anywhere runs uncached: lage would cache every package file',
    async () => {
      await write('lage.config.js', `module.exports = { pipeline: { build: ['^build'] } }\n`)
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['build'], log })
      for (const t of plan.tasks) expect(t.node.config.cache).toBeUndefined()
      expect(log.lines.some((l) => l.includes('no outputs and no cacheOptions.outputGlob'))).toBe(
        true,
      )
    },
    TIMEOUT,
  )

  it(
    'runs and caches; an edit to a file the config requires remaps the pipeline',
    async () => {
      const opts = { cwd: root, tasks: ['app#bundle'], log: silent(), handleSignals: false }
      const status = (r: Awaited<ReturnType<typeof run>>, id: string) =>
        r.outcomes.find((o) => o.node.id === id)?.status
      const first = await run(opts)
      expect(first.ok).toBe(true)
      expect(await Bun.file(path.join(root, 'packages/app/out/app.js')).text()).toBe('// app\n')
      const second = await run(opts)
      expect(status(second, 'base#transpile')).toBe('cache-hit')
      expect(status(second, 'app#bundle')).toBe('cache-hit')
      await write('packages/base/src/index.ts', '// v2\n')
      expect(status(await run(opts), 'base#transpile')).toBe('success')
      // `transpile` loses its outputs in the required file: it must now run uncached.
      await write(
        'scripts/pipeline.js',
        PIPELINE.replace("outputs: ['lib/**'], ", 'cache: false, '),
      )
      const plan = await planRun({ cwd: root, tasks: ['base#transpile'], log: silent() })
      expect(plan.tasks[0]!.node.config.cache).toBeUndefined()
    },
    TIMEOUT,
  )

  it(
    'a config that throws is refused with its message',
    async () => {
      await write('lage.config.js', `throw new Error('boom from config')\n`)
      const r = planRun({ cwd: root, tasks: ['build'], log: silent() })
      await r.then(
        () => expect.unreachable(),
        (err: Error) => expect(err.message).toContain('failed to load lage.config.js: '),
      )
    },
    TIMEOUT,
  )
})

describe('lage-worker', () => {
  it(
    'a worker target runs as one process with its target, options and taskArgs, and caches',
    async () => {
      const plan = await planRun({ cwd: root, tasks: ['base#types'], log: silent() })
      expect(plan.tasks[0]!.node.config.exec?.command).toBe(
        'lage-worker ../../scripts/types.js --package base --task types --options \'{"flavor":"strict"}\' --x',
      )
      const opts = { cwd: root, tasks: ['base#types'], log: silent(), handleSignals: false }
      const first = await run(opts)
      expect(first.ok).toBe(true)
      expect(await Bun.file(path.join(root, 'packages/base/types/index.d.ts')).text()).toBe(
        'base#types types strict --x\n',
      )
      expect((await run(opts)).outcomes[0]!.status).toBe('cache-hit')
    },
    TIMEOUT,
  )

  it(
    'a worker that throws fails its task with the error',
    async () => {
      const r = await run({ cwd: root, tasks: ['mid#types'], log: silent(), handleSignals: false })
      expect(r.ok).toBe(false)
      expect(r.outcomes.map((o) => [o.node.id, o.status])).toEqual([
        ['base#types', 'success'],
        ['mid#types', 'failed'],
      ])
    },
    TIMEOUT,
  )
})

describe('vx-migrate --from lage', () => {
  it(
    'detects lage.config.js and writes the configs lage() runs',
    async () => {
      const plan = await planRun({ cwd: root, tasks: ['app#bundle'], log: silent() })
      const live = plan.tasks.find((t) => t.node.id === 'app#bundle')!.node.config
      await mkdir(path.join(root, 'node_modules', '@vzn'), { recursive: true })
      await symlink(CORE_PKG, path.join(root, 'node_modules', '@vzn', 'vx'), 'dir')
      const proc = Bun.spawn([process.execPath, BIN], {
        cwd: root,
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(err).toBe('')
      expect(code).toBe(0)
      expect(out).toContain('lage.config.js → vx.config.ts')
      const config = await loadProjectConfig(path.join(root, 'packages/app/vx.config.ts'))
      expect(config.tasks!['bundle']).toEqual(live as never)
    },
    TIMEOUT,
  )
})

describe('loadLageConfig', () => {
  it(
    'a require no node_modules provides is refused without asking the registry (L-22)',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'vx-lage-noinstall-'))
      const asked: string[] = []
      using registry = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch(req) {
          asked.push(new URL(req.url).pathname)
          return new Response('{}', { status: 404 })
        },
      })
      const saved = { ...process.env }
      try {
        const file = path.join(dir, 'lage.config.js')
        await writeFile(file, `require('is-odd')\nmodule.exports = { pipeline: {} }\n`)
        const url = `http://127.0.0.1:${registry.port}/`
        process.env['BUN_CONFIG_REGISTRY'] = url
        process.env['NPM_CONFIG_REGISTRY'] = url
        process.env['BUN_INSTALL_CACHE_DIR'] = path.join(dir, '.bun-cache')
        await loadLageConfig(dir, file).then(
          () => expect.unreachable(),
          (err: Error) => expect(err.message).toContain('failed to load lage.config.js: '),
        )
        expect(asked).toEqual([])
      } finally {
        for (const k of ['BUN_CONFIG_REGISTRY', 'NPM_CONFIG_REGISTRY', 'BUN_INSTALL_CACHE_DIR']) {
          if (saved[k] === undefined) delete process.env[k]
          else process.env[k] = saved[k]
        }
        await rm(dir, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
