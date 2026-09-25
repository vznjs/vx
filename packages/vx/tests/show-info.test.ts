// `vx show` / `vx info` e2e. Subprocess-driven like lock.test.ts so the
// dispatcher wiring, exit codes, and UserError presentation are all
// exercised exactly as a user sees them. Parser unit tests sit at the
// bottom against the cli contract re-export.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { parseShowArgs } from '../src/cli/index.js'
import { describeMemory, describeWorkers, renderInfo } from '../src/cli/info.js'
import { collectInfo, type InfoFacts } from '../src/orchestrator/index.js'
import { stableSandboxReason } from '../src/orchestrator/doctor.js'
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

  it(
    'a target ending in `#` names the missing TASK, not an unknown one',
    async () => {
      const r = await vx(root, ['show', 'app#'])
      expect(r.code).toBe(1)
      expect(r.err).toContain(`missing task name after '#' in "app#"`)
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
      expect(r.out).toContain('(no vx config)')
      expect(r.out).not.toContain('(no tasks declared)')
    },
    TIMEOUT,
  )

  it(
    'a timeout carries its UNIT — 5000 alone is ambiguous',
    async () => {
      // The block row above asserts the number appears; a bare `5000` reads
      // as seconds just as easily as milliseconds, and the schema means ms.
      const r = await vx(root, ['show', 'app#dev'])
      expect(r.code).toBe(0)
      expect(r.out).toMatch(/timeout:\s+5000ms/)
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
      // The runtime probe's verdict for this host, with the declared count:
      // the fixture declares none, so an unavailable runtime fails nothing.
      expect(r.out).toMatch(
        /^sandbox: +(available \(0 tasks declare exec\.sandbox\)|unavailable — .+; 0 tasks declare exec\.sandbox)$/m,
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
      expect(r.out).toContain('cache dir:')
      // The constants themselves, not a copy of them: a bump shows up here.
      expect(r.out).toMatch(
        row('cache versions', `keys ${CACHE_VERSION} · index schema ${SCHEMA_VERSION}`),
      )
      expect(r.out).toMatch(row('cache entries', '0 (0 B)'))
      expect(r.out).toMatch(row('task runs (24h)', '0'))
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
      expect(facts.sandbox).toEqual({
        available: expect.any(Boolean),
        reason: expect.any(String),
        declared: 0,
      })
      // Same facts either way: the pretty rows render this object.
      const pretty = await vx(root, ['info'])
      expect(pretty.out).toContain(`cache entries:`)
      expect(pretty.out).toContain(facts.cacheDir.split(path.sep).slice(-2).join(path.sep))
      // The value forms are checked, not the spelling.
      expect((await vx(root, ['info', '--format=yaml'])).code).toBe(1)
      // A `--cache-dir` with no path is refused, not read as "the default".
      const noDir = await vx(root, ['info', '--cache-dir'])
      expect(noDir.code).toBe(1)
      expect(noDir.err).toBe('vx info: --cache-dir requires a path\n')
      expect(noDir.out).toBe('')
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

describe('vx info — a config that will not load counts as zero, for every number', () => {
  // The doctor falls back to a per-config count when the shared load throws.
  // That fallback counted tasks but not sandboxes, so one broken config next
  // to a project declaring `exec.sandbox` read "0 tasks declare".
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
    "counts the loadable configs' tasks and sandboxes alike",
    async () => {
      // Control: every config loads, so the shared load counts.
      const whole = JSON.parse((await vx(root, ['info', '--format', 'json'])).out)
      expect(whole.tasks).toBe(5)
      expect(whole.sandbox.declared).toBe(1)
      expect(whole.configErrors).toEqual([])

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
      expect(facts.projects).toBe(4)
      expect(facts.tasks).toBe(5)
      expect(facts.sandbox.declared).toBe(1)
      // Zero is not silent: the broken config is named, with the loader's
      // message and no absolute path in front of it.
      expect(facts.configErrors).toEqual([
        {
          path: 'packages/broken/vx.config.mjs',
          message: expect.stringMatching(/^tasks\.build has unknown field "command"/),
        },
      ])
      const pretty = await vx(root, ['info'])
      expect(pretty.code).toBe(0)
      expect(pretty.out).toMatch(/^projects: +4 \(5 tasks · 1 config did not load\)$/m)
      expect(pretty.out).toMatch(
        /^config errors: +packages\/broken\/vx\.config\.mjs: tasks\.build has unknown field "command"/m,
      )

      // An import that fails is the loader's other message shape, which
      // opens with `Project config <abs>:` — the row named the file twice.
      const badimport = path.join(root, 'packages', 'badimport')
      await mkdir(badimport, { recursive: true })
      // A real workspace has a node_modules. Without one anywhere above the
      // config, Bun auto-installs a bare import it cannot resolve — sixteen
      // connections to the registry before "cannot find" — which the macOS
      // sandbox reports as a violation and fails the shard (Next 21).
      await mkdir(path.join(root, 'node_modules'), { recursive: true })
      await writeFile(path.join(badimport, 'package.json'), JSON.stringify({ name: 'badimport' }))
      await writeFile(
        path.join(badimport, 'vx.config.mjs'),
        `import { preset } from 'nope-pkg'\nexport default { tasks: { build: { exec: { command: 'true' }, ...preset } } }\n`,
      )
      const two = JSON.parse((await vx(root, ['info', '--format', 'json'])).out)
      expect(two.configErrors).toEqual([
        {
          path: 'packages/badimport/vx.config.mjs',
          message: expect.stringMatching(/^cannot find 'nope-pkg' — no node_modules above/),
        },
        {
          path: 'packages/broken/vx.config.mjs',
          message: expect.stringMatching(/^tasks\.build has unknown field "command"/),
        },
      ])
      // One row, the errors joined by `; ` in path order.
      expect((await vx(root, ['info'])).out).toMatch(
        /^config errors: +packages\/badimport\/vx\.config\.mjs: cannot find 'nope-pkg' — no node_modules above .*; packages\/broken\//m,
      )
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

  it('a --format with NO value is an error, not a silent default', () => {
    // `--format` at the end of the line takes the next argv, which is not
    // there: the empty string must fail the same validation `--format=x`
    // does, rather than leaving `pretty` in place and saying nothing.
    expect(parseShowArgs(['--format']).error).toBe('--format must be pretty or json')
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
    bun: '1.4.2',
    bunSupported: true,
    git: '2.43.0',
    gitStatusCache: { fsmonitor: true, untrackedCache: true },
    workspaceRoot: '/w',
    projects: 3,
    tasks: 1,
    configErrors: [],
    plugins: [],
    workers: { count: 4, source: 'cores', cores: 4, cpuQuota: null },
    memory: { usableBytes: 16 * GB, totalBytes: 16 * GB, cgroupLimitBytes: null },
    cacheDir: '/w/.vx',
    cacheVersion: 'vx-cache-v34',
    schemaVersion: 'v27',
    cacheEntries: 0,
    cacheBytes: 0,
    orphans: { artifacts: 0, bytes: 0 },
    runs24h: 5,
    hits24h: 2,
    flakyTasks: [],
    lockfile: true,
    sandbox: { available: true, reason: '', declared: 1 },
  }

  it('a healthy workspace: one aligned column, no optional rows', () => {
    expect(renderInfo(healthy)).toBe(
      [
        'vx:               0.1.0',
        'bun:              1.4.2',
        'git:              2.43.0',
        'git status cache: fsmonitor + untrackedCache on',
        'workspace root:   /w',
        'projects:         3 (1 task)',
        'plugins:          none',
        'workers:          4 — the CPU count',
        'memory:           16 GB',
        'cache dir:        /w/.vx',
        'cache versions:   keys vx-cache-v34 · index schema v27',
        'cache entries:    0 (0 B)',
        'task runs (24h):  5 (2 cache hits)',
        'flaky tasks:      none',
        'sandbox:          available (1 task declares exec.sandbox)',
        'vx-lock.json:     yes',
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
      configErrors: [{ path: 'packages/a/vx.config.ts', message: 'boom' }],
      plugins: [
        { name: 'p', seams: [] },
        { name: 'q', seams: ['executor', 'cache'] },
      ],
      workers: { count: 8, source: 'workspace', cores: 4, cpuQuota: 2 },
      memory: { usableBytes: 2 * GB, totalBytes: 8 * GB, cgroupLimitBytes: 2 * GB },
      cacheEntries: 3,
      cacheBytes: 2048,
      orphans: { artifacts: 1, bytes: 512 },
      runs24h: 0,
      hits24h: 0,
      flakyTasks: [
        { taskId: 'a#test', project: 'a', task: 'test', keys: 2, passes: 4, failures: 3 },
        { taskId: 'b#e2e', project: 'b', task: 'e2e', keys: 1, passes: 3, failures: 1 },
      ],
      lockfile: false,
      sandbox: { available: false, reason: 'bwrap missing', declared: 2 },
    }
    expect(renderInfo(degraded)).toBe(
      [
        'vx:               0.1.0',
        'bun:              1.3.11 — unsupported, vx needs >= 1.4.0; answers may be wrong',
        'git:              (not found)',
        'git status cache: (unknown)',
        'workspace root:   /w',
        'projects:         2 (0 tasks · 1 config did not load)',
        'config errors:    packages/a/vx.config.ts: boom',
        'plugins:          2 — p (no seams); q (executor, cache)',
        'workers:          8 — vx.workspace.ts (4 cores, cgroup CPU quota 2)',
        'memory:           2.0 GB usable — cgroup limit; the machine has 8.0 GB',
        'cache dir:        /w/.vx',
        'cache versions:   keys vx-cache-v34 · index schema v27',
        'cache entries:    3 (2.0 KB)',
        'orphans:          1 artifact (512 B) the index does not know — `vx cache prune` reaps them',
        'task runs (24h):  0 (0 cache hits)',
        'flaky tasks:      2 — a#test (3 of 7 runs failed on unchanged inputs); b#e2e (1 of 4 runs failed)',
        'sandbox:          unavailable — bwrap missing; 2 tasks declare exec.sandbox and will fail',
        'vx-lock.json:     no',
      ].join('\n'),
    )
  })

  it('names the one git status setting that is off, and warns only of a sandbox a task declares', () => {
    const row = (f: InfoFacts, label: string): string | undefined =>
      renderInfo(f)
        .split('\n')
        .find((l) => l.startsWith(`${label}:`))
    expect(
      row(
        { ...healthy, gitStatusCache: { fsmonitor: false, untrackedCache: true } },
        'git status cache',
      ),
    ).toBe('git status cache: core.fsmonitor off')
    expect(
      row(
        { ...healthy, gitStatusCache: { fsmonitor: true, untrackedCache: false } },
        'git status cache',
      ),
    ).toBe('git status cache: core.untrackedCache off')
    expect(
      row(
        { ...healthy, gitStatusCache: { fsmonitor: false, untrackedCache: false } },
        'git status cache',
      ),
    ).toBe('git status cache: core.fsmonitor, core.untrackedCache off')
    expect(
      row({ ...healthy, sandbox: { available: false, reason: 'root', declared: 0 } }, 'sandbox'),
    ).toBe('sandbox:          unavailable — root; 0 tasks declare exec.sandbox')
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
    // The workspace's number wins, and a quota beside it is still named.
    expect(describeWorkers({ count: 8, source: 'workspace', cores: 4, cpuQuota: 2 })).toBe(
      '8 — vx.workspace.ts (4 cores, cgroup CPU quota 2)',
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

describe('vx show <project> loads that project only (e2e)', () => {
  // The scoped load is not only a saving: a config is a program, so a
  // broken one in an unrelated package must not stop `vx show app` from
  // answering about app. The run path makes the same promise
  // (tests/scoped-config-loading.test.ts) and this is the reader's half.
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-show-scope-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
    const app = path.join(root, 'packages', 'app')
    await mkdir(app, { recursive: true })
    await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(
      path.join(app, 'vx.config.mjs'),
      "export default { tasks: { build: { exec: { command: 'echo b' } } } }\n",
    )
    const broken = path.join(root, 'packages', 'broken')
    await mkdir(broken, { recursive: true })
    await writeFile(path.join(broken, 'package.json'), JSON.stringify({ name: 'broken' }))
    await writeFile(path.join(broken, 'vx.config.mjs'), "throw new Error('never evaluated')\n")
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'a broken config in another package does not break the scoped view',
    async () => {
      const r = await vx(root, ['show', 'app'])
      expect(r.code).toBe(0)
      expect(r.out).toContain('echo b')
      expect(r.out).not.toContain('never evaluated')
    },
    TIMEOUT,
  )

  it(
    'CONTROL: the unscoped listing DOES evaluate it, so the fixture is really broken',
    async () => {
      const r = await vx(root, ['show'])
      expect(r.code).toBe(1)
      expect(r.err).toContain('never evaluated')
    },
    TIMEOUT,
  )
})

// The rows above feed `describeWorkers` / `describeMemory` literal facts,
// so they pin the RENDERER. These pin the facts themselves — the numbers
// `vx info` and `vx mcp`'s getWorkspaceInfo both read out of `collectInfo`.
describe('collectInfo — the facts behind the rows', () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-doctor-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
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
    // `concurrency` would render "N — vx.workspace.ts" with the wrong N.
    await writeFile(path.join(root, 'vx.workspace.mjs'), 'export default { concurrency: 3 }\n')
    const declared = await collectInfo(root, { warn() {} })
    expect(declared.workers.count).toBe(3)
    expect(declared.workers.source).toBe('workspace')
    // `cores` is the machine's either way, and never zero — it is the
    // denominator of the rendered row.
    expect(declared.workers.cores).toBeGreaterThanOrEqual(1)

    // CONTROL: with nothing declared the count is the machine's, and the
    // source names which machine limit decided it.
    await rm(path.join(root, 'vx.workspace.mjs'))
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

  it('config errors come out sorted by path, so two runs compare', async () => {
    // The facts are pasted into bug reports and diffed between
    // invocations; Promise.all settles in whatever order the reads finish,
    // which is not an order at all.
    for (const name of ['zeta', 'alpha']) {
      const dir = path.join(root, 'packages', name)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
      await writeFile(path.join(dir, 'vx.config.mjs'), `throw new Error('broken ${name}')\n`)
    }
    const facts = await collectInfo(root, { warn() {} })
    const paths = facts.configErrors.map((e) => e.path)
    expect(paths).toEqual([...paths].sort())
    expect(paths).toContain('packages/alpha/vx.config.mjs')
    expect(paths).toContain('packages/zeta/vx.config.mjs')
    for (const name of ['zeta', 'alpha']) {
      await rm(path.join(root, 'packages', name), { recursive: true, force: true })
    }
  })

  it('a plugin that fills only `teardown` fills no SEAM', async () => {
    // Seams are the pipeline stages a reader asks "why did this task run
    // there" about. `teardown` is lifecycle, not a seam, and listing it
    // would answer that question with something no task ever consults.
    await writeFile(
      path.join(root, 'vx.workspace.mjs'),
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
    await rm(path.join(root, 'vx.workspace.mjs'))
  })
})
