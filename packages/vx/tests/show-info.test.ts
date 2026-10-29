// `vx show` / `vx info` e2e. Subprocess-driven like lock.test.ts so the
// dispatcher wiring, exit codes, and UserError presentation are all
// exercised exactly as a user sees them. Parser unit tests sit at the
// bottom against the cli contract re-export.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { parseShowArgs } from '../src/cli/show.js'
import { describeMemory, describeWorkers, renderInfo } from '../src/cli/info.js'
import { collectInfo, type InfoFacts } from '../src/orchestrator/index.js'
import { stableSandboxReason } from '../src/orchestrator/doctor.js'
import { VERSION } from '../src/version.js'
import { CACHE_VERSION, SCHEMA_VERSION } from '../src/cache/index.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { edgesSource, packagesSource, PLUGIN_IMPORT, pluginSource } from './helpers/plugin.js'
import { noticed } from './helpers/notice.js'

// `vx lock`, then the verb: show and info read the lock.
const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const TIMEOUT = 20_000

const APP_CONFIG = `
  export default {
    tasks: {
      build: {
        description: 'compile the app',
        exec: { command: 'echo build' },
        dependsOn: ['^build'],
        inputs: { files: ['src/**'], env: ['NODE_ENV'] },
        cache: {
          outputs: { files: ['dist/**'] },
        },
      },
      dev: {
        exec: {
          command: 'echo dev',
          timeout: '5s',
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
        inputs: { files: ['src/**/*.ts'], workspaceFiles: ['tsconfig.base.json'], runtime: ['node -v'] },
        cache: {
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
      ${packagesSource()},
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
  await Bun.write(path.join(root, '.vx/workspace.mjs'), PLUGIN_WORKSPACE)
  for (const name of ['one', 'two']) {
    const dir = path.join(root, 'packages', name)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
  }
  return root
}

// An edge source where every project is a leaf: `app#build` writes `^build`.
const WORKSPACE_FILE = localWorkspaceSource([edgesSource()])

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-show-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }),
  )
  await Bun.write(path.join(root, '.vx/workspace.mjs'), WORKSPACE_FILE)
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
      expect(r.out).toContain('no vx config')
    },
    TIMEOUT,
  )

  it(
    'no target with --format=json emits {name, dir, tags[], tasks[]} per project',
    async () => {
      const r = await vx(root, ['show', '--format=json'])
      expect(r.code).toBe(0)
      const list = JSON.parse(r.out) as {
        name: string
        dir: string
        tags: string[]
        tasks: string[]
      }[]
      const app = list.find((p) => p.name === 'app')
      expect(app).toEqual({
        name: 'app',
        dir: 'packages/app',
        tags: [],
        tasks: ['build', 'dev', 'ci', 'lint'],
      })
      const bare = list.find((p) => p.name === 'bare')
      expect(bare).toEqual({ name: 'bare', dir: 'packages/bare', tags: [], tasks: [] })
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
      expect(r.out).toContain('timeout     5s')
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
        inputs: { files: ['src/**'], env: ['NODE_ENV'] },
        cache: {
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
        .map((l) => l.trim().replace(/ {2,}/, ': '))
      expect(rows).toEqual([
        'dir: packages/app',
        'command: echo lint',
        'retries: 2',
        'env.passThrough: HOME',
        'env.define: CI=1',
        'remote: only',
        'inputs.files: src/**/*.ts',
        'inputs.workspaceFiles: tsconfig.base.json',
        'inputs.runtime: node -v',
        'outputs.files: none',
      ])
    },
    TIMEOUT,
  )

  it(
    'show <task> shows that task in every project declaring it',
    async () => {
      const r = await vx(root, ['show', 'build'])
      expect(r.code).toBe(0)
      expect(r.out).toContain('─ app#build ')
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
      // Nx's `nx show projects` is a bare `vx show`. CONTROL: `buidl` says nothing of it.
      expect(r.err).not.toContain('nx show')
      const nx = await vx(root, ['show', 'projects'])
      expect(nx.err).toContain(
        'unknown project or task: "projects" (`nx show projects` is `vx show` here)',
      )
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
      // The hint is a spec to paste, as `vx run`'s is (E-34).
      expect(r.err).toBe(
        noticed('vx show: unknown task: "app#bui" — did you mean app#build, app#ci?\n'),
      )
    },
    TIMEOUT,
  )

  it(
    'a name Object.prototype carries is an unknown task, not a group (item 897)',
    async () => {
      const bare = await vx(root, ['show', 'constructor'])
      const scoped = await vx(root, ['show', 'app#toString'])
      expect([bare.code, scoped.code]).toEqual([1, 1])
      expect(bare.err).toContain('unknown project or task: "constructor"')
      expect(scoped.err).toContain('unknown task: "app#toString"')
    },
    TIMEOUT,
  )

  it(
    'invalid --format is a parse error',
    async () => {
      const r = await vx(root, ['show', '--format', 'yaml'])
      expect(r.code).toBe(1)
      expect(r.err).toContain('--format must be pretty or json (got yaml)\n\n  see vx show --help')
    },
    TIMEOUT,
  )

  it(
    'a target ending in `#` names the missing TASK, not an unknown one',
    async () => {
      const r = await vx(root, ['show', 'app#'])
      expect(r.code).toBe(1)
      expect(r.err.trim()).toBe(
        noticed(
          `vx show: missing task name after '#' in "app#" (vx show app lists the tasks)`,
        ).trimEnd(),
      )
    },
    TIMEOUT,
  )

  it(
    'a target starting with `#` names the missing PROJECT, not an empty one',
    async () => {
      const r = await vx(root, ['show', '#build'])
      expect(r.code).toBe(1)
      expect(r.err.trim()).toBe(
        noticed(
          `vx show: missing project name before '#' in "#build" (vx show build shows it in every project)`,
        ).trimEnd(),
      )
    },
    TIMEOUT,
  )

  it(
    'an unknown project in the `pkg#task` form is named, not a crash',
    async () => {
      // The bare form has a row above; this is the other arm of the same
      // guard, and the one that would otherwise reach `byName.get(...)!`
      // and print a TypeError where a sentence belongs.
      const r = await vx(root, ['show', 'nosuch#build'])
      expect(r.code).toBe(1)
      expect(r.err).toContain('unknown project: "nosuch"')
      expect(r.err).not.toContain('at ') // a clean UserError, no stack
    },
    TIMEOUT,
  )

  it(
    'a name nothing resembles gets NO "did you mean" tail',
    async () => {
      // The suggestion is a suffix on the same sentence, so an empty set
      // must produce no suffix at all rather than "did you mean ?".
      const r = await vx(root, ['show', 'zzzzzzzz'])
      expect(r.code).toBe(1)
      expect(r.err).toContain('unknown project or task: "zzzzzzzz"')
      expect(r.err).not.toContain('did you mean')
    },
    TIMEOUT,
  )

  it(
    'a package with no config file says so, rather than "no tasks declared"',
    async () => {
      // Two different facts for the reader: a config that declares nothing,
      // and no config at all. The list view distinguishes them; so does this.
      const r = await vx(root, ['show', 'bare'])
      expect(r.code).toBe(0)
      expect(r.out).toMatch(/^ {2}config +none$/m)
      expect(r.out).not.toContain('none declared')
    },
    TIMEOUT,
  )

  it(
    'a timeout carries its UNIT — 5000 alone is ambiguous',
    async () => {
      // A bare `5000` reads as seconds as easily as milliseconds: the
      // value prints as written, unit and all.
      const r = await vx(root, ['show', 'app#dev'])
      expect(r.code).toBe(0)
      expect(r.out).toMatch(/timeout\s+5s/)
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
      expect(r.out).toContain('2 tasks from plugins (no vx config)')
      expect(r.out).not.toMatch(/ {2}no vx config$/m)
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
      expect(info.out).toMatch(/^  projects +2 \(4 tasks\)/m)
      // The doctor names each plugin and the seams it fills, in pipeline
      // order.
      expect(info.out).toMatch(/^  plugins +2 — vx-test-packages \(discover\); gen \(project\)$/m)
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
          `^  ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}  +${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
          'm',
        )
      expect(r.out).toMatch(row('vx', VERSION))
      expect(r.out).toContain(Bun.version)
      expect(r.out).toContain('  git ')
      // The status-cache row names the git settings whichever way they are set.
      expect(r.out).toMatch(
        /^  git status cache +(fsmonitor \+ untrackedCache on|core\.(fsmonitor|untrackedCache).* off)$/m,
      )
      // macOS realpaths /var → /private/var inside the child; match on
      // the unique tmpdir basename rather than the absolute prefix.
      expect(r.out).toMatch(/^  workspace root +\S/m)
      expect(r.out).toContain(path.basename(root))
      expect(r.out).toMatch(row('projects', '2 (4 tasks)'))
      expect(r.out).toMatch(row('plugins', '1 — vx-test-packages (discover)'))
      // The worker count a run defaults to, with its source, and the memory
      // a packing policy budgets — the two numbers a container hides.
      expect(r.out).toMatch(/^  workers +[1-9]\d* — (the CPU count|cgroup CPU quota )/m)
      expect(r.out).toMatch(/^  memory +\d/m)
      // The runtime probe's verdict for this host, with the declared count:
      // the fixture declares none, so an unavailable runtime fails nothing.
      expect(r.out).toMatch(
        /^  sandbox +(available \(0 tasks declare exec\.sandbox\)|unavailable — .+; 0 tasks declare exec\.sandbox)$/m,
      )
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
      expect(r.out).toContain('  cache dir ')
      // The constants themselves, not a copy of them: a bump shows up here.
      expect(r.out).toMatch(
        row('cache versions', `keys ${CACHE_VERSION} · index schema ${SCHEMA_VERSION}`),
      )
      expect(r.out).toMatch(row('cache entries', '0 (0 B)'))
      expect(r.out).toMatch(row('task runs (24h)', '0'))
      expect(r.out).toMatch(row('flaky tasks', 'none'))
      expect(r.out).toMatch(row('projects lock', 'yes'))
      // Control for the orphans row below: nothing on disk the index does
      // not know, so the doctor says nothing about it.
      expect(r.out).not.toContain('  orphans ')
    },
    TIMEOUT,
  )

  it(
    'reports the cache policy and scope a run takes, and where each comes from',
    async () => {
      const ws = path.join(root, '.vx/workspace.mjs')
      const saved = { policy: process.env['VX_CACHE_POLICY'], scope: process.env['VX_CACHE_SCOPE'] }
      const facts = async () => {
        const f = await collectInfo(root, { warn: () => {} })
        return { policy: f.settings['cache.policy'], scope: f.settings['cache.scope'] }
      }
      try {
        delete process.env['VX_CACHE_POLICY']
        delete process.env['VX_CACHE_SCOPE']
        await writeFile(ws, `export default { cache: { policy: 'remote:r' } }\n`)
        const none = (await facts()).scope
        expect(await facts()).toEqual({
          policy: { value: 'remote:r', source: 'workspace' },
          scope: none,
        })
        expect(none?.source).toBe('default')
        process.env['VX_CACHE_POLICY'] = 'remote:'
        process.env['VX_CACHE_SCOPE'] = 'pr-2'
        expect(await facts()).toEqual({
          policy: { value: 'remote:', source: 'env' },
          scope: { value: 'pr-2', source: 'env' },
        })
      } finally {
        for (const [k, v] of [
          ['VX_CACHE_POLICY', saved.policy],
          ['VX_CACHE_SCOPE', saved.scope],
        ] as const) {
          if (v === undefined) delete process.env[k]
          else process.env[k] = v
        }
        await writeFile(ws, WORKSPACE_FILE)
      }
    },
    TIMEOUT,
  )

  it(
    'names the artifacts on disk the index does not know, and the verb that reaps them',
    async () => {
      // An aged row-less artifact: what a SCHEMA_VERSION reset leaves
      // behind. A fresh one is a save in flight and is not counted.
      const cacheDir = path.join(root, '.vx', 'cache')
      const { mkdir, utimes, writeFile, rm } = await import('node:fs/promises')
      // Made here: an earlier row's `vx info` made it until item 900, when
      // a reading verb stopped creating the cache directory.
      await mkdir(cacheDir, { recursive: true })
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
          /^  orphans +1 artifact \(2\.0 KB\) the index does not know — `vx cache clean` reaps them$/m,
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
      expect(facts.plugins.map((p: { name: string }) => p.name)).toEqual(['vx-test-packages'])
      expect(facts.cacheDir).toContain('.vx')
      expect(facts.cacheVersion).toBe(CACHE_VERSION)
      expect(facts.schemaVersion).toBe(SCHEMA_VERSION)
      expect(facts.cacheEntries).toBe(0)
      expect(facts.cacheBytes).toBe(0)
      expect(facts.orphans).toEqual({ artifacts: 0, bytes: 0 })
      expect(facts.runs24h).toBe(0)
      expect(facts.hits24h).toBe(0)
      expect(facts.restored24h).toBe(0)
      expect(facts.flakyTasks).toEqual([])
      expect(facts.lockfile).toBe(true)
      expect(facts.sandbox).toEqual({
        available: expect.any(Boolean),
        reason: expect.any(String),
        declared: 0,
        untraced: facts.sandbox.available ? facts.sandbox.untraced : null,
      })
      expect([null, 'string']).toContain(
        facts.sandbox.untraced === null ? null : typeof facts.sandbox.untraced,
      )
      // Same facts either way: the pretty rows render this object.
      const pretty = await vx(root, ['info'])
      expect(pretty.out).toContain(`  cache entries `)
      expect(pretty.out).toContain(facts.cacheDir.split(path.sep).slice(-2).join(path.sep))
      // The value forms are checked, not the spelling.
      expect((await vx(root, ['info', '--format=yaml'])).code).toBe(1)
      // A `--cache-dir` with no path is refused, not read as "the default".
      const noDir = await vx(root, ['info', '--cache-dir'])
      expect(noDir.code).toBe(1)
      expect(noDir.err).toBe(
        noticed('vx info: --cache-dir requires a path (see `vx info --help`)\n'),
      )
      expect(noDir.out).toBe('')
    },
    TIMEOUT,
  )
})

describe('vx info — counts from the lock, for every number', () => {
  let root: string
  beforeAll(async () => {
    root = await makeWorkspace()
    const sandboxed = path.join(root, 'packages', 'sandboxed')
    await mkdir(sandboxed, { recursive: true })
    await writeFile(path.join(sandboxed, 'package.json'), JSON.stringify({ name: 'sandboxed' }))
    await writeFile(
      path.join(sandboxed, 'vx.config.mjs'),
      `export default { tasks: { build: { exec: { command: 'echo build', sandbox: {} } } } }`,
    )
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'counts tasks and sandboxes alike; a config vx lock refuses counts zero, unnamed',
    async () => {
      const whole = JSON.parse((await vx(root, ['info', '--format', 'json'])).out)
      expect([whole.tasks, whole.sandbox.declared, whole.lockfile]).toEqual([5, 1, true])

      // `vx lock` refuses the broken config and leaves no lock: a run
      // refuses too, and the projects are the lock's, so info counts
      // nothing and names nothing.
      const broken = path.join(root, 'packages', 'broken')
      await mkdir(broken, { recursive: true })
      await writeFile(path.join(broken, 'package.json'), JSON.stringify({ name: 'broken' }))
      await writeFile(
        path.join(broken, 'vx.config.mjs'),
        `export default { tasks: { build: { command: 'echo build' } } }`,
      )
      const r = await vx(root, ['info', '--format', 'json'])
      expect(r.code).toBe(0)
      const facts = JSON.parse(r.out)
      expect([facts.projects, facts.tasks, facts.sandbox.declared, facts.lockfile]).toEqual([
        0,
        0,
        0,
        false,
      ])
      expect(facts).not.toHaveProperty('configErrors')
      const pretty = await vx(root, ['info'])
      expect(pretty.out).toMatch(/^  projects +0 \(0 tasks\)$/m)
      expect(pretty.out).not.toContain('config errors')
    },
    TIMEOUT,
  )
})

describe('parseShowArgs', () => {
  it('defaults to pretty with no target', () => {
    expect(parseShowArgs([])).toEqual({ format: 'pretty', filters: [] })
  })

  it('captures a positional target', () => {
    expect(parseShowArgs(['app#build'])).toEqual({
      format: 'pretty',
      filters: [],
      target: 'app#build',
    })
  })

  it('accepts --format json in both spellings', () => {
    expect(parseShowArgs(['--format', 'json']).format).toBe('json')
    expect(parseShowArgs(['--format=json']).format).toBe('json')
  })

  it('a --format with NO value is an error, not a silent default', () => {
    // `--format` at the end of the line takes the next argv, which is not
    // there: the empty string must fail the same validation `--format=x`
    // does, rather than leaving `pretty` in place and saying nothing.
    expect(parseShowArgs(['--format']).error).toBe(
      '--format requires a value: pretty or json (see `vx show --help`)',
    )
  })

  it('rejects an invalid format value', () => {
    expect(parseShowArgs(['--format', 'yaml']).error).toBe(
      '--format must be pretty or json (got yaml) (see `vx show --help`)',
    )
    expect(parseShowArgs(['--format=']).error).toBe(
      '--format requires a value: pretty or json (see `vx show --help`)',
    )
  })

  // `--filter=` refused as `vx run --filter=` is, not as a filter naming no project.
  it('an empty --filter= is a missing value', () => {
    expect(parseShowArgs(['--filter=']).error).toBe(
      '--filter requires a value: a project name, glob or path (see `vx show --help`)',
    )
  })

  it('rejects unknown flags and extra positionals', () => {
    expect(parseShowArgs(['--bogus']).error).toBe('unknown flag: --bogus (see `vx show --help`)')
    expect(parseShowArgs(['a', 'b']).error).toBe('unexpected argument: b (see `vx show --help`)')
  })

  // Nx's `nx show project app` was "unexpected argument: app".
  it("names vx show <name> for Nx's show project <name>", () => {
    expect(parseShowArgs(['project', 'app']).error).toBe(
      '`nx show project app` is `vx show app` here',
    )
  })
})

describe('vx info — the sandbox row is stable across invocations', () => {
  it('EVERY socket path in a reason is masked, not just the first', () => {
    // The runtime names one socket per attempt, so a reason that mentions a
    // retry carries two — and a half-masked reason still differs between
    // invocations, which is the whole thing this function prevents.
    expect(
      stableSandboxReason('listen srt-mux-111-1.sock failed; retried srt-mux-111-2.sock'),
    ).toBe('listen srt-mux-<pid>.sock failed; retried srt-mux-<pid>.sock')
  })

  // CI's sandboxed shard: the runtime cannot listen on its mux socket, and
  // the raw error quotes a path named after the process id — two `vx info`
  // runs differed by one number and the `vx stats` alias pin failed
  // (2026-09-16). The doctor's text must not depend on its own pid.
  it('drops the process id from the runtime socket path', () => {
    expect(
      stableSandboxReason(
        "EPERM: operation not permitted, listen '/tmp/claude/srt-mux-1171-0.sock'",
      ),
    ).toBe("EPERM: operation not permitted, listen '/tmp/claude/srt-mux-<pid>.sock'")
    // CONTROL: a reason without one is untouched.
    const plain = 'a sandboxed `true` failed (exit 1): apply-seccomp: write /proc/self/uid_map'
    expect(stableSandboxReason(plain)).toBe(plain)
  })
})

// Every row of the printout from literal facts: a real box shows one side of
// each branch (a supported Bun, git present, a sandbox that starts), so the
// other side is driven here or nowhere.
describe('vx info — the rendered rows', () => {
  const GB = 1024 ** 3
  const healthy: InfoFacts = {
    vx: '0.1.0',
    vxPath: '/usr/local/bin/vx',
    handedOffFrom: null,
    bun: '1.4.4',
    bunSupported: true,
    git: '2.43.0',
    gitStatusCache: { fsmonitor: true, untrackedCache: true },
    workspaceRoot: '/w',
    projects: 3,
    tasks: 1,
    plugins: [],
    workers: { count: 4, source: 'cores', cores: 4, cpuQuota: null },
    memory: { usableBytes: 16 * GB, totalBytes: 16 * GB, cgroupLimitBytes: null },
    cacheDir: '/w/.vx',
    cacheDirBytes: 0,
    cacheStore: '/home/u/.vx/3f2a9c1e7b4d5a60/cache',
    cacheStoreBytes: 0,
    cacheVersion: 'vx-cache-v39',
    schemaVersion: 'v28',
    cacheEntries: 0,
    cacheBytes: 0,
    settings: {},
    orphans: { artifacts: 0, bytes: 0 },
    runs24h: 5,
    hits24h: 2,
    restored24h: 1,
    flakyTasks: [],
    lockfile: true,
    sandbox: { available: true, reason: '', declared: 1, untraced: null },
  }

  it('one cache hit is a hit, not hits', () => {
    const row = (f: Partial<InfoFacts>): string | undefined =>
      renderInfo({ ...healthy, ...f })
        .split('\n')
        .find((l) => l.startsWith('  task runs (24h)'))
    expect(row({ runs24h: 1, hits24h: 1, restored24h: 0 })).toBe(
      '  task runs (24h)   1 (1 cache hit: 1 up-to-date, 0 restored)',
    )
    expect(row({ runs24h: 1, hits24h: 0, restored24h: 0 })).toBe(
      '  task runs (24h)   1 (0 cache hits)',
    )
  })

  it('names each setting a variable or the workspace changed, and where', () => {
    const out = renderInfo({
      ...healthy,
      settings: {
        'run.timeout': { value: '30m', source: 'env' },
        'run.schedule': { value: null, source: 'default' },
        'cache.policy': { value: 'local:rw', source: 'workspace' },
      },
    })
    expect(out.split('\n').filter((l) => l.startsWith('  settings '))).toEqual([
      '  settings          run.timeout 30m (VX_RUN_TIMEOUT), cache.policy local:rw (.vx/workspace)',
    ])
  })

  it('a healthy workspace: one aligned column, no optional rows', () => {
    expect(renderInfo(healthy)).toBe(
      [
        '',
        '─ vx info ────────────────────────────────────────────────────',
        '  vx                0.1.0 (/usr/local/bin/vx)',
        '  bun               1.4.4',
        '  git               2.43.0',
        '  git status cache  fsmonitor + untrackedCache on',
        '  workspace root    /w',
        '  projects          3 (1 task)',
        '  plugins           none',
        '  workers           4 — the CPU count',
        '  memory            16 GB',
        "  cache dir         /w/.vx (0 B, this workspace's run history)",
        "  cache store       /home/u/.vx/3f2a9c1e7b4d5a60/cache (0 B, shared by this repo's checkouts)",
        '  cache versions    keys vx-cache-v39 · index schema v28',
        '  cache entries     0 (0 B)',
        '  task runs (24h)   5 (2 cache hits: 1 up-to-date, 1 restored)',
        '  flaky tasks       none',
        '  sandbox           available (1 task declares exec.sandbox)',
        '  projects lock     yes',
      ].join('\n'),
    )
  })

  it('a degraded one: every warning row says what is wrong', () => {
    const degraded: InfoFacts = {
      ...healthy,
      bun: '1.3.11',
      bunSupported: false,
      git: null,
      gitStatusCache: null,
      projects: 2,
      tasks: 0,
      plugins: [
        { name: 'p', seams: [] },
        { name: 'q', seams: ['executor', 'cache'] },
      ],
      workers: { count: 8, source: 'workspace', cores: 4, cpuQuota: 2 },
      memory: { usableBytes: 2 * GB, totalBytes: 8 * GB, cgroupLimitBytes: 2 * GB },
      cacheStore: null,
      cacheEntries: 3,
      cacheBytes: 3 * GB,
      orphans: { artifacts: 1, bytes: 512 },
      runs24h: 0,
      hits24h: 0,
      restored24h: 0,
      flakyTasks: [
        { taskId: 'a#test', project: 'a', task: 'test', keys: 2, passes: 4, failures: 3 },
        { taskId: 'b#e2e', project: 'b', task: 'e2e', keys: 1, passes: 3, failures: 1 },
      ],
      lockfile: false,
      sandbox: { available: false, reason: 'bwrap missing', declared: 2, untraced: null },
    }
    expect(renderInfo(degraded)).toBe(
      [
        '',
        '─ vx info ────────────────────────────────────────────────────',
        '  vx                0.1.0 (/usr/local/bin/vx)',
        '  bun               1.3.11 — unsupported, vx needs >= 1.4.4; answers may be wrong',
        '  git               (not found)',
        '  git status cache  (unknown)',
        '  workspace root    /w',
        '  projects          2 (0 tasks)',
        '  plugins           2 — p (no seams); q (executor, cache)',
        '  workers           8 — .vx/workspace.ts (4 cores, cgroup CPU quota 2)',
        '  memory            2.0 GB usable — cgroup limit; the machine has 8.0 GB',
        "  cache dir         /w/.vx (0 B, the entries and this workspace's run history)",
        '  cache store       none: the cache dir holds the entries',
        '  cache versions    keys vx-cache-v39 · index schema v28',
        '  cache entries     3 (3.0 GB)',
        '  orphans           1 artifact (512 B) the index does not know — `vx cache clean` reaps them',
        '  task runs (24h)   0 (0 cache hits)',
        '  flaky tasks       2 — a#test (3 of 7 runs failed on unchanged inputs); b#e2e (1 of 4 runs failed)',
        '  sandbox           unavailable — bwrap missing; 2 tasks declare exec.sandbox and will fail',
        '  projects lock     no',
      ].join('\n'),
    )
  })

  it('prints paths under the home directory as ~', () => {
    const home = os.homedir()
    const out = renderInfo({
      ...healthy,
      workspaceRoot: path.join(home, 'w'),
      cacheDir: path.join(home, 'w', '.vx'),
      cacheStore: path.join(home, '.vx', 'id', 'cache'),
    }).split('\n')
    expect(out.filter((l) => /^ {2}(workspace root|cache )/.test(l))).toEqual([
      '  workspace root    ~/w',
      "  cache dir         ~/w/.vx (0 B, this workspace's run history)",
      "  cache store       ~/.vx/id/cache (0 B, shared by this repo's checkouts)",
      '  cache versions    keys vx-cache-v39 · index schema v28',
      '  cache entries     0 (0 B)',
    ])
  })

  it('names the vx that ran, and the global one that handed it the call', () => {
    const vx = renderInfo({
      ...healthy,
      vxPath: '/repo/node_modules/@vzn/vx-linux-x64/vx',
      handedOffFrom: '/usr/local/bin/vx',
    })
      .split('\n')
      .find((l) => l.startsWith('  vx '))
    expect(vx).toBe(
      '  vx                0.1.0 (/repo/node_modules/@vzn/vx-linux-x64/vx, handed off from /usr/local/bin/vx)',
    )
  })

  it('names the one git status setting that is off, and warns only of a sandbox a task declares', () => {
    const row = (f: InfoFacts, label: string): string | undefined =>
      renderInfo(f)
        .split('\n')
        .find((l) => l.startsWith(`  ${label} `))
    expect(
      row(
        { ...healthy, gitStatusCache: { fsmonitor: false, untrackedCache: true } },
        'git status cache',
      ),
    ).toBe('  git status cache  core.fsmonitor off')
    expect(
      row(
        { ...healthy, gitStatusCache: { fsmonitor: true, untrackedCache: false } },
        'git status cache',
      ),
    ).toBe('  git status cache  core.untrackedCache off')
    expect(
      row(
        { ...healthy, gitStatusCache: { fsmonitor: false, untrackedCache: false } },
        'git status cache',
      ),
    ).toBe('  git status cache  core.fsmonitor, core.untrackedCache off')
    expect(
      row(
        { ...healthy, sandbox: { available: false, reason: 'root', declared: 0, untraced: null } },
        'sandbox',
      ),
    ).toBe('  sandbox           unavailable — root; 0 tasks declare exec.sandbox')
    // B-51's lead: an available sandbox that cannot report its denied reads
    // says why, beside the count.
    expect(
      row(
        {
          ...healthy,
          sandbox: { available: true, reason: '', declared: 1, untraced: 'strace is not on PATH' },
        },
        'sandbox',
      ),
    ).toBe(
      '  sandbox           available (1 task declares exec.sandbox), untraced — strace is not on PATH, so the reads it denies go unreported',
    )
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
      '8 — .vx/workspace.ts (4 cores)',
    )
    // The workspace's number wins, and a quota beside it is still named.
    expect(describeWorkers({ count: 8, source: 'workspace', cores: 4, cpuQuota: 2 })).toBe(
      '8 — .vx/workspace.ts (4 cores, cgroup CPU quota 2)',
    )
    // A one-core machine has a core, not cores.
    expect(describeWorkers({ count: 2, source: 'workspace', cores: 1, cpuQuota: null })).toBe(
      '2 — .vx/workspace.ts (1 core)',
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
    // A limit wider than the machine binds nothing: no "usable" clause.
    expect(
      describeMemory({ usableBytes: 16 * GB, totalBytes: 16 * GB, cgroupLimitBytes: 64 * GB }),
    ).toBe('16 GB')
  })
})

describe('vx show reads the lock and evaluates nothing (e2e)', () => {
  // Only `vx lock` and `vx lock --check` evaluate a config.
  const RAW_BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
  const raw = (root: string, args: string[]) =>
    Bun.spawnSync([process.execPath, RAW_BIN, ...args], {
      cwd: root,
      env: { ...process.env, VX_LOCK_REVIEW_FILES: 'false' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-show-lock-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
    const app = path.join(root, 'packages', 'app')
    await mkdir(app, { recursive: true })
    await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(
      path.join(app, 'vx.config.mjs'),
      "export default { tasks: { build: { exec: { command: 'echo b' } } } }\n",
    )
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'with no lock it refuses as a run does',
    async () => {
      const r = raw(root, ['show'])
      expect([r.exitCode, r.stderr.toString(), r.stdout.toString()]).toEqual([
        1,
        noticed('vx show: no lock: run `vx lock`\n'),
        '',
      ])
    },
    TIMEOUT,
  )

  it(
    'shows the locked config, not the file edited since',
    async () => {
      expect(raw(root, ['lock']).exitCode).toBe(0)
      await writeFile(
        path.join(root, 'packages', 'app', 'vx.config.mjs'),
        "throw new Error('never evaluated')\n",
      )
      const r = raw(root, ['show', 'app'])
      expect(r.exitCode).toBe(0)
      expect(r.stdout.toString()).toContain('echo b')
      expect(r.stderr.toString()).not.toContain('never evaluated')
    },
    TIMEOUT,
  )
})

// The rows above feed `describeWorkers` / `describeMemory` literal facts,
// so they pin the RENDERER. These pin the facts themselves — the numbers
// `vx info` reads out of `collectInfo`.
describe('collectInfo — the facts behind the rows', () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-doctor-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
    const a = path.join(root, 'packages', 'a')
    await mkdir(a, { recursive: true })
    await writeFile(path.join(a, 'package.json'), JSON.stringify({ name: 'a' }))
    await writeFile(
      path.join(a, 'vx.config.mjs'),
      "export default { tasks: { build: { exec: { command: 'echo b' } } } }\n",
    )
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('the worker count comes from the workspace when it declares one', async () => {
    // The ladder is workspace > cgroup > cores, and only its RENDERING was
    // pinned: a fact that reported the machine's cores under a declared
    // `concurrency` would render "N — .vx/workspace.ts" with the wrong N.
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      'export default { run: { concurrency: 3 } }\n',
    )
    const declared = await collectInfo(root, { warn() {} })
    expect(declared.workers.count).toBe(3)
    expect(declared.workers.source).toBe('workspace')
    // `cores` is the machine's either way, and never zero — it is the
    // denominator of the rendered row.
    expect(declared.workers.cores).toBeGreaterThanOrEqual(1)

    // CONTROL: with nothing declared the count is the machine's, and the
    // source names which machine limit decided it.
    await rm(path.join(root, '.vx/workspace.mjs'))
    const bare = await collectInfo(root, { warn() {} })
    expect(bare.workers.source).not.toBe('workspace')
    expect(bare.workers.count).toBeLessThanOrEqual(bare.workers.cores)
    expect(bare.workers.source).toBe(bare.workers.count < bare.workers.cores ? 'cgroup' : 'cores')
  })

  it('usable memory is the machine capped by the cgroup, never the machine alone', async () => {
    // Inside a container `os.totalmem()` is the HOST's; a run that budgeted
    // against it would be the OOM killer's. The three fields have to agree:
    // usable is the smaller of the machine and whatever limit binds.
    const facts = await collectInfo(root, { warn() {} })
    const { usableBytes, totalBytes, cgroupLimitBytes } = facts.memory
    expect(totalBytes).toBeGreaterThan(0)
    expect(usableBytes).toBeLessThanOrEqual(totalBytes)
    expect(usableBytes).toBe(Math.min(totalBytes, cgroupLimitBytes ?? totalBytes))
  })

  it('the git version is the version, not git’s sentence', async () => {
    const facts = await collectInfo(root, { warn() {} })
    // Skipping when git is absent would be a silent pass, and every
    // environment this suite runs in has git (the fixtures commit).
    expect(facts.git).not.toBeNull()
    expect(facts.git).toMatch(/^\d+\.\d+/)
    expect(facts.git).not.toContain('git version')
  })

  it('a plugin that fills only `teardown` fills no SEAM', async () => {
    // Seams are the pipeline stages a reader asks "why did this task run
    // there" about. `teardown` is lifecycle, not a seam, and listing it
    // would answer that question with something no task ever consults.
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      `${PLUGIN_IMPORT}
       export default { plugins: [
         ${pluginSource('org/late', `{ teardown() {} }`)},
         ${pluginSource('org/keyed', `{ key() { return undefined } }`)},
       ] }\n`,
    )
    const facts = await collectInfo(root, { warn() {} })
    const seams = Object.fromEntries(facts.plugins.map((p) => [p.name, p.seams]))
    expect(seams['org/late']).toEqual([])
    expect(seams['org/keyed']).toEqual(['key'])
    await rm(path.join(root, '.vx/workspace.mjs'))
  })
})
