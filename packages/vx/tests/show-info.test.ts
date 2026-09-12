// `vx show` / `vx info` e2e. Subprocess-driven like lock.test.ts so the
// dispatcher wiring, exit codes, and UserError presentation are all
// exercised exactly as a user sees them. Parser unit tests sit at the
// bottom against the cli contract re-export.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { parseShowArgs } from '../src/cli/index.js'
import { describeMemory, describeWorkers } from '../src/cli/info.js'
import { VERSION } from '../src/version.js'
import { CACHE_VERSION, SCHEMA_VERSION } from '../src/cache/index.js'
import { PLUGIN_IMPORT, pluginSource } from './helpers/plugin.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 20_000

const APP_CONFIG = `
  export default {
    tasks: {
      build: {
        description: 'compile the app',
        exec: { command: 'echo build' },
        dependsOn: ['^build'],
        cache: {
          inputs: { files: ['src/**'], env: ['NODE_ENV'] },
          outputs: { files: ['dist/**'] },
        },
      },
      dev: {
        exec: {
          command: 'echo dev',
          timeout: 5000,
          persistent: { readyWhen: 'ready' },
        },
      },
      ci: { dependsOn: ['build'] },
      lint: {
        exec: {
          command: 'echo lint',
          retries: 2,
          env: { passThrough: ['HOME'], define: { CI: '1' } },
          remote: 'only',
        },
        cache: {
          inputs: { files: ['**/*.ts'], workspaceFiles: ['tsconfig.base.json'], runtime: ['node -v'] },
          outputs: { files: [] },
        },
      },
    },
  }
`

// A workspace whose only tasks come from a plugin's `project` stage: no
// package writes a config file. What `vx run` would run, `vx show` must
// show — the two go through the same load.
const PLUGIN_WORKSPACE = `${PLUGIN_IMPORT}
  export default {
    plugins: [
      ${pluginSource(
        'gen',
        `{ project(config, ctx) {
          config.tasks.gen = { exec: { command: 'echo gen ' + ctx.name } }
        },
      }`,
      )},
    ],
  }
`

async function makePluginWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-show-plugin-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }),
  )
  await writeFile(path.join(root, 'vx.workspace.mjs'), PLUGIN_WORKSPACE)
  for (const name of ['one', 'two']) {
    const dir = path.join(root, 'packages', name)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
  }
  return root
}

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-show-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }),
  )
  const appDir = path.join(root, 'packages', 'app')
  await mkdir(appDir, { recursive: true })
  await writeFile(path.join(appDir, 'package.json'), JSON.stringify({ name: 'app' }))
  await writeFile(path.join(appDir, 'vx.config.mjs'), APP_CONFIG)
  const bareDir = path.join(root, 'packages', 'bare')
  await mkdir(bareDir, { recursive: true })
  await writeFile(path.join(bareDir, 'package.json'), JSON.stringify({ name: 'bare' }))
  return root
}

interface VxResult {
  code: number
  out: string
  err: string
}

async function vx(root: string, args: string[]): Promise<VxResult> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
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
  return { code, out, err }
}

describe('vx show (e2e)', () => {
  let root: string
  beforeAll(async () => {
    root = await makeWorkspace()
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'no target lists every project with dir, task count, and no-config marker',
    async () => {
      const r = await vx(root, ['show'])
      expect(r.code).toBe(0)
      expect(r.out).toContain('app')
      expect(r.out).toContain('packages/app')
      expect(r.out).toContain('4 tasks')
      expect(r.out).toContain('bare')
      expect(r.out).toContain('(no vx config)')
    },
    TIMEOUT,
  )

  it(
    'no target with --format=json emits {name, dir, tasks[]} per project',
    async () => {
      const r = await vx(root, ['show', '--format=json'])
      expect(r.code).toBe(0)
      const list = JSON.parse(r.out) as { name: string; dir: string; tasks: string[] }[]
      const app = list.find((p) => p.name === 'app')
      expect(app).toEqual({
        name: 'app',
        dir: 'packages/app',
        tasks: ['build', 'dev', 'ci', 'lint'],
      })
      const bare = list.find((p) => p.name === 'bare')
      expect(bare).toEqual({ name: 'bare', dir: 'packages/bare', tasks: [] })
    },
    TIMEOUT,
  )

  it(
    'show <project> pretty prints every task field block',
    async () => {
      const r = await vx(root, ['show', 'app'])
      expect(r.code).toBe(0)
      expect(r.out).toContain('compile the app')
      expect(r.out).toContain('echo build')
      expect(r.out).toContain('^build')
      expect(r.out).toContain('src/**')
      expect(r.out).toContain('NODE_ENV')
      expect(r.out).toContain('dist/**')
      // Group task renders a marker instead of a command.
      expect(r.out).toContain('(group)')
      // Persistent fields surface.
      expect(r.out).toContain('ready')
      expect(r.out).toContain('5000')
    },
    TIMEOUT,
  )

  it(
    'show <pkg>#<task> --format json round-trips the resolved task config',
    async () => {
      const r = await vx(root, ['show', 'app#build', '--format', 'json'])
      expect(r.code).toBe(0)
      const obj = JSON.parse(r.out) as {
        name: string
        dir: string
        task: string
        config: unknown
      }
      expect(obj.name).toBe('app')
      expect(obj.dir).toBe('packages/app')
      expect(obj.task).toBe('build')
      expect(obj.config).toEqual({
        description: 'compile the app',
        exec: { command: 'echo build' },
        dependsOn: ['^build'],
        cache: {
          inputs: { files: ['src/**'], env: ['NODE_ENV'] },
          outputs: { files: ['dist/**'] },
        },
      })
    },
    TIMEOUT,
  )

  it(
    'show <project> prints every field the run reads, not only the common ones',
    async () => {
      // `show` claims the live resolved config; a field it hid (retries,
      // env, remote, workspace inputs, runtime probes) was a claim the
      // output lacked.
      const r = await vx(root, ['show', 'app#lint'])
      expect(r.code).toBe(0)
      const rows = r.out
        .split('\n')
        .filter((l) => l.startsWith('  '))
        .map((l) => l.trim().replace(/:\s+/, ': '))
      expect(rows).toEqual([
        'command: echo lint',
        'retries: 2',
        'env.passThrough: HOME',
        'env.define: CI=1',
        'remote: only',
        'inputs.files: **/*.ts',
        'inputs.workspaceFiles: tsconfig.base.json',
        'inputs.runtime: node -v',
        'outputs.files:',
      ])
    },
    TIMEOUT,
  )

  it(
    'show <task> shows that task in every project declaring it',
    async () => {
      const r = await vx(root, ['show', 'build'])
      expect(r.code).toBe(0)
      expect(r.out).toContain('app — packages/app')
      expect(r.out).toContain('echo build')
      const j = await vx(root, ['show', 'build', '--format=json'])
      expect(j.code).toBe(0)
      const list = JSON.parse(j.out) as { name: string; task: string }[]
      expect(list.map((e) => `${e.name}#${e.task}`)).toEqual(['app#build'])
    },
    TIMEOUT,
  )

  it(
    'a bare name that is neither project nor task says so, with both kinds of near miss',
    async () => {
      const r = await vx(root, ['show', 'buidl'])
      expect(r.code).toBe(1)
      expect(r.err).toContain('unknown project or task: "buidl"')
      expect(r.err).toContain('build')
    },
    TIMEOUT,
  )

  it(
    'unknown project errors with near-match suggestions',
    async () => {
      const r = await vx(root, ['show', 'ap'])
      expect(r.code).toBe(1)
      expect(r.err).toContain('unknown project')
      expect(r.err).toContain('app')
      expect(r.err).not.toContain('at ') // clean UserError, no stack
    },
    TIMEOUT,
  )

  it(
    'unknown task errors with near-match suggestions',
    async () => {
      const r = await vx(root, ['show', 'app#bui'])
      expect(r.code).toBe(1)
      expect(r.err).toContain('unknown task')
      expect(r.err).toContain('build')
    },
    TIMEOUT,
  )

  it(
    'invalid --format is a parse error',
    async () => {
      const r = await vx(root, ['show', '--format', 'yaml'])
      expect(r.code).toBe(1)
      expect(r.err).toContain('--format must be pretty or json')
    },
    TIMEOUT,
  )
})

describe('vx show under a `project` plugin (e2e)', () => {
  let root: string
  beforeAll(async () => {
    root = await makePluginWorkspace()
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'shows the tasks a plugin gave a package that wrote no config file',
    async () => {
      // Before `show` went through the run path's load it printed
      // `(no vx config)` for a package `vx run` would happily run.
      const r = await vx(root, ['show'])
      expect(r.code).toBe(0)
      expect(r.out).toContain('1 task (no vx config; from plugins)')
      expect(r.out).not.toContain('(no vx config)\n')
      const one = await vx(root, ['show', 'one#gen'])
      expect(one.code).toBe(0)
      expect(one.out).toContain('echo gen one')
      const across = await vx(root, ['show', 'gen', '--format=json'])
      expect(across.code).toBe(0)
      const list = JSON.parse(across.out) as { name: string }[]
      expect(list.map((e) => e.name)).toEqual(['one', 'two'])
      // The doctor counts through the same load, so its number is the
      // one a run would see, not the number of config files.
      const info = await vx(root, ['info'])
      expect(info.code).toBe(0)
      expect(info.out).toMatch(/^projects: +2 \(2 tasks\)/m)
      // The doctor names each plugin and the seams it fills, in pipeline
      // order — the `project` stage here, nothing else.
      expect(info.out).toMatch(/^plugins: +1 — gen \(project\)$/m)
    },
    TIMEOUT,
  )
})

describe('vx info (e2e)', () => {
  let root: string
  beforeAll(async () => {
    root = await makeWorkspace()
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'prints versions, workspace shape, cache stats, lock status',
    async () => {
      const r = await vx(root, ['info'])
      expect(r.code).toBe(0)
      // Labels are padded to the widest one; pin the row, not the width.
      const row = (label: string, value: string): RegExp =>
        new RegExp(
          `^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: +${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
          'm',
        )
      expect(r.out).toMatch(row('vx', VERSION))
      expect(r.out).toContain(Bun.version)
      expect(r.out).toContain('git:')
      // The status-cache row names the git settings whichever way they are set.
      expect(r.out).toMatch(
        /^git status cache: +(fsmonitor \+ untrackedCache on|core\.(fsmonitor|untrackedCache).* off)$/m,
      )
      // macOS realpaths /var → /private/var inside the child; match on
      // the unique tmpdir basename rather than the absolute prefix.
      expect(r.out).toMatch(/^workspace root: +\S/m)
      expect(r.out).toContain(path.basename(root))
      expect(r.out).toMatch(row('projects', '2 (4 tasks)'))
      expect(r.out).toMatch(row('plugins', 'none'))
      // The worker count a run defaults to, with its source, and the memory
      // a packing policy budgets — the two numbers a container hides.
      expect(r.out).toMatch(/^workers: +[1-9]\d* — (the CPU count|cgroup CPU quota )/m)
      expect(r.out).toMatch(/^memory: +\d/m)
      const json = await vx(root, ['info', '--format=json'])
      expect(json.code).toBe(0)
      const facts = JSON.parse(json.out) as {
        workers: { count: number; source: string; cores: number; cpuQuota: number | null }
        memory: { usableBytes: number; totalBytes: number; cgroupLimitBytes: number | null }
      }
      expect(facts.workers.count).toBeGreaterThanOrEqual(1)
      expect(facts.workers.count).toBeLessThanOrEqual(facts.workers.cores)
      expect(['cores', 'cgroup']).toContain(facts.workers.source)
      expect(facts.memory.usableBytes).toBeLessThanOrEqual(facts.memory.totalBytes)
      expect(r.out).toContain('cache dir:')
      // The constants themselves, not a copy of them: a bump shows up here.
      expect(r.out).toMatch(
        row('cache versions', `keys ${CACHE_VERSION} · index schema ${SCHEMA_VERSION}`),
      )
      expect(r.out).toMatch(row('cache entries', '0 (0 B)'))
      expect(r.out).toMatch(row('runs (24h)', '0'))
      expect(r.out).toMatch(row('flaky tasks', 'none'))
      expect(r.out).toMatch(row('vx-lock.json', 'no'))
      // Control for the orphans row below: nothing on disk the index does
      // not know, so the doctor says nothing about it.
      expect(r.out).not.toContain('orphans:')
    },
    TIMEOUT,
  )

  it(
    'names the artifacts on disk the index does not know, and the verb that reaps them',
    async () => {
      // An aged row-less artifact: what a SCHEMA_VERSION reset leaves
      // behind. A fresh one is a save in flight and is not counted.
      const cacheDir = path.join(root, '.vx', 'cache')
      const { utimes, writeFile, rm } = await import('node:fs/promises')
      const aged = path.join(cacheDir, 'deadbeefdeadbeef.tar.zst')
      const fresh = path.join(cacheDir, 'feedfacefeedface.tar.zst')
      await writeFile(aged, 'x'.repeat(2048))
      const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000
      await utimes(aged, twoHoursAgo, twoHoursAgo)
      await writeFile(fresh, 'y')
      try {
        const r = await vx(root, ['info'])
        expect(r.code).toBe(0)
        expect(r.out).toMatch(
          /^orphans: +1 artifact \(2\.0 KB\) the index does not know — `vx cache prune` reaps them$/m,
        )
      } finally {
        await rm(aged, { force: true })
        await rm(fresh, { force: true })
      }
    },
    TIMEOUT,
  )

  it(
    '--format json prints the same facts typed, for a script or a bug report',
    async () => {
      const r = await vx(root, ['info', '--format', 'json'])
      expect(r.code).toBe(0)
      const facts = JSON.parse(r.out)
      expect(facts.vx).toBe(VERSION)
      expect(facts.bun).toBe(Bun.version)
      expect(typeof facts.git).toBe('string')
      expect(facts.gitStatusCache).toEqual({
        fsmonitor: expect.any(Boolean),
        untrackedCache: expect.any(Boolean),
      })
      expect(path.basename(facts.workspaceRoot)).toBe(path.basename(root))
      expect(facts.projects).toBe(2)
      expect(facts.tasks).toBe(4)
      expect(facts.plugins).toEqual([])
      expect(facts.cacheDir).toContain('.vx')
      expect(facts.cacheVersion).toBe(CACHE_VERSION)
      expect(facts.schemaVersion).toBe(SCHEMA_VERSION)
      expect(facts.cacheEntries).toBe(0)
      expect(facts.cacheBytes).toBe(0)
      expect(facts.orphans).toEqual({ artifacts: 0, bytes: 0 })
      expect(facts.runs24h).toBe(0)
      expect(facts.hits24h).toBe(0)
      expect(facts.flakyTasks).toEqual([])
      expect(facts.lockfile).toBe(false)
      // Same facts either way: the pretty rows render this object.
      const pretty = await vx(root, ['info'])
      expect(pretty.out).toContain(`cache entries:`)
      expect(pretty.out).toContain(facts.cacheDir.split(path.sep).slice(-2).join(path.sep))
      // The value forms are checked, not the spelling.
      expect((await vx(root, ['info', '--format=yaml'])).code).toBe(1)
    },
    TIMEOUT,
  )

  it(
    'vx stats is an alias: byte-identical output',
    async () => {
      const info = await vx(root, ['info'])
      const stats = await vx(root, ['stats'])
      expect(stats.code).toBe(0)
      expect(stats.out).toBe(info.out)
    },
    TIMEOUT,
  )
})

describe('parseShowArgs', () => {
  it('defaults to pretty with no target', () => {
    expect(parseShowArgs([])).toEqual({ format: 'pretty' })
  })

  it('captures a positional target', () => {
    expect(parseShowArgs(['app#build'])).toEqual({ format: 'pretty', target: 'app#build' })
  })

  it('accepts --format json in both spellings', () => {
    expect(parseShowArgs(['--format', 'json']).format).toBe('json')
    expect(parseShowArgs(['--format=json']).format).toBe('json')
  })

  it('rejects an invalid format value', () => {
    expect(parseShowArgs(['--format', 'yaml']).error).toBe('--format must be pretty or json')
    expect(parseShowArgs(['--format=']).error).toBe('--format must be pretty or json')
  })

  it('rejects unknown flags and extra positionals', () => {
    expect(parseShowArgs(['--bogus']).error).toBe('unknown flag: --bogus (see `vx show --help`)')
    expect(parseShowArgs(['a', 'b']).error).toBe('unexpected argument: b')
  })
})

describe('vx info — the workers and memory rows', () => {
  const GB = 1024 ** 3
  it('names where the worker count comes from', () => {
    expect(describeWorkers({ count: 4, source: 'cores', cores: 4, cpuQuota: null })).toBe(
      '4 — the CPU count',
    )
    expect(describeWorkers({ count: 2, source: 'cgroup', cores: 8, cpuQuota: 1.5 })).toBe(
      '2 — cgroup CPU quota 1.5 of 8 cores',
    )
    expect(describeWorkers({ count: 8, source: 'workspace', cores: 4, cpuQuota: null })).toBe(
      '8 — vx.workspace.ts (4 cores)',
    )
    // A quota that does not bind (wider than the cores) is still named.
    expect(describeWorkers({ count: 4, source: 'cores', cores: 4, cpuQuota: 6 })).toBe(
      '4 — the CPU count, cgroup CPU quota 6',
    )
  })

  it('says when the cgroup, not the machine, bounds memory', () => {
    expect(
      describeMemory({
        usableBytes: 13.3 * GB,
        totalBytes: 15.7 * GB,
        cgroupLimitBytes: 13.3 * GB,
      }),
    ).toBe('13 GB usable — cgroup limit; the machine has 16 GB')
    expect(
      describeMemory({ usableBytes: 16 * GB, totalBytes: 16 * GB, cgroupLimitBytes: null }),
    ).toBe('16 GB')
  })
})
