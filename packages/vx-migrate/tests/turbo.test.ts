// A Turbo repo runs under vx with no vx.config written. Every pin is a real
// `planRun` / `run` over a workspace whose only vx file declares the plugin:
// the migrate suite's Turbo fixture, minus the migration.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { planRun, run, type Logger, type ProjectConfig, type ProjectMeta } from '@vzn/vx'
import { turbo } from '../src/index.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const TIMEOUT = 30_000

const TURBO_JSON = {
  globalDependencies: ['tsconfig.base.json'],
  globalEnv: ['GLOBAL_MODE'],
  globalPassThroughEnv: ['AWS_PROFILE'],
  tasks: {
    build: {
      dependsOn: ['^build', 'codegen'],
      inputs: ['$TURBO_DEFAULT$', '!**/*.md', '$TURBO_ROOT$/tsconfig.base.json'],
      outputs: ['dist/**'],
      env: ['NODE_ENV'],
    },
    codegen: { outputs: ['src/gen/**'] },
    lint: { cache: false },
    test: { passThroughEnv: ['CI'], outputs: [] },
  },
}

let root: string

/** A logger that keeps the run:status lines (plugin warnings) in `lines`. */
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

async function pkg(name: string, scripts: Record<string, string>, deps?: Record<string, string>) {
  const dir = path.join(root, 'packages', name)
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', scripts, ...(deps ? { dependencies: deps } : {}) }),
  )
  await writeFile(path.join(dir, 'src', 'index.js'), `// ${name}\n`)
  return dir
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-turbo-plugin-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'tsconfig.base.json'), '{}')
  // As in any real repo: build output is ignored, so it is nobody's input.
  // Without this, `dist/` written by `app#build` lands in `app#codegen`'s
  // default `**/*` input set and re-keys it on the second run.
  await writeFile(path.join(root, '.gitignore'), 'dist\n')
  await writeFile(path.join(root, 'turbo.json'), JSON.stringify(TURBO_JSON, null, 2))
  await pkg('lib', { build: 'mkdir -p dist && echo lib > dist/lib.js' })
  await pkg(
    'app',
    {
      build: 'mkdir -p dist && cat src/gen/api.js > dist/app.js',
      codegen: 'mkdir -p src/gen && echo "// api" > src/gen/api.js',
      lint: 'echo lint',
      test: 'echo test',
    },
    { lib: 'workspace:*' },
  )
  await Bun.write(
    path.join(root, 'vx.workspace.mjs'),
    localWorkspaceSource(['turbo()'], `import { turbo } from ${JSON.stringify(PLUGIN_INDEX)}\n`),
  )
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('turbo()', () => {
  it(
    'plans a turbo.json workspace with no vx.config: tasks, edges, cache blocks, inlined globals',
    async () => {
      const plan = await planRun({ cwd: root, tasks: ['build'], log: silent() })
      const ids = plan.tasks.map((t) => t.node.id).sort()
      expect(ids).toEqual(['app#build', 'app#codegen', 'lib#build'])
      const app = plan.tasks.find((t) => t.node.id === 'app#build')!.node
      // `^build` reached lib, `codegen` is a same-package edge.
      expect(app.deps.sort()).toEqual(['app#codegen', 'lib#build'])
      const cache = app.config.cache!
      expect(cache.inputs.files).toEqual(['**/*', '!**/*.md'])
      // globalDependencies and the $TURBO_ROOT$/ input both name the
      // file; the mapper sees both strings and lists it once.
      expect(cache.inputs.workspaceFiles).toEqual(['tsconfig.base.json'])
      expect(cache.inputs.env).toEqual(['GLOBAL_MODE', 'NODE_ENV'])
      expect(cache.outputs.files).toEqual(['dist/**'])
      expect(app.config.exec?.env?.passThrough).toEqual(['GLOBAL_MODE', 'AWS_PROFILE', 'NODE_ENV'])
      expect(app.config.exec?.command).toBe('mkdir -p dist && cat src/gen/api.js > dist/app.js')
    },
    TIMEOUT,
  )

  it(
    'a turbo.json spelled with ./ (inputs and outputs) keys the mapped task on its files',
    async () => {
      // The mapper hands globs through as written; core normalizes the
      // spellings a matcher would turn into nothing (`./src/**` folded
      // zero inputs until 2026-09-10). Pinned at this boundary too, since a
      // turbo.json is where the spelling comes from.
      const turbo = structuredClone(TURBO_JSON) as typeof TURBO_JSON & {
        tasks: { build: { inputs: string[]; outputs: string[] } }
      }
      turbo.tasks.build.inputs = ['./src/**']
      turbo.tasks.build.outputs = ['./dist/**']
      await writeFile(path.join(root, 'turbo.json'), JSON.stringify(turbo, null, 2))
      const opts = { cwd: root, tasks: ['build'], log: silent(), handleSignals: false }
      const status = (r: Awaited<ReturnType<typeof run>>, id: string) =>
        r.outcomes.find((o) => o.node.id === id)!.status
      const first = await run(opts)
      expect(first.ok).toBe(true)
      expect(status(first, 'lib#build')).toBe('success')
      expect(status(await run(opts), 'lib#build')).toBe('cache-hit')
      await writeFile(path.join(root, 'packages', 'lib', 'src', 'index.js'), '// lib v2\n')
      const third = await run(opts)
      expect(status(third, 'lib#build')).toBe('success')
      expect(await Bun.file(path.join(root, 'packages', 'lib', 'dist', 'lib.js')).text()).toBe(
        'lib\n',
      )
    },
    TIMEOUT,
  )

  it(
    'runs the graph, caches by the mapped blocks, and leaves `cache: false` tasks uncached',
    async () => {
      const first = await run({
        cwd: root,
        tasks: ['build', 'lint'],
        log: silent(),
        handleSignals: false,
      })
      expect(first.ok).toBe(true)
      expect(first.outcomes.map((o) => o.status)).toEqual([
        'success',
        'success',
        'success',
        'success',
      ])
      const second = await run({
        cwd: root,
        tasks: ['build', 'lint'],
        log: silent(),
        handleSignals: false,
      })
      expect(second.ok).toBe(true)
      const byId = new Map(second.outcomes.map((o) => [o.node.id, o]))
      expect(byId.get('lib#build')!.status).toBe('cache-hit')
      expect(byId.get('app#codegen')!.status).toBe('cache-hit')
      expect(byId.get('app#build')!.status).toBe('cache-hit')
      // turbo `cache: false` → no cache block → runs again.
      expect(byId.get('app#lint')!.status).toBe('success')
      expect(byId.get('app#lint')!.node.config.cache).toBeUndefined()
    },
    TIMEOUT,
  )

  it(
    'a package that wrote its own vx.config keeps its declaration; the plugin only fills',
    async () => {
      await writeFile(
        path.join(root, 'packages', 'app', 'vx.config.mjs'),
        `export default { tasks: { build: { exec: { command: 'echo by-hand' } } } }`,
      )
      const plan = await planRun({ cwd: root, tasks: ['build', 'test'], log: silent() })
      const app = plan.tasks.find((t) => t.node.id === 'app#build')!.node
      expect(app.config.exec?.command).toBe('echo by-hand')
      expect(app.config.cache).toBeUndefined()
      // The tasks the config did not declare are still filled from turbo.json.
      expect(plan.tasks.some((t) => t.node.id === 'app#test')).toBe(true)
    },
    TIMEOUT,
  )

  it(
    "outputLogs: new-only is vx's default and warns about nothing; other values name the run flag",
    async () => {
      // `new-only` — frames for what ran, a one-liner per hit — is what vx
      // does by default, and it is the value in every Vercel template; on
      // solidjs/solid every run warned "no vx equivalent" for it twice.
      // The other values have no per-task knob in vx: the todo says which
      // run flag carries them instead of asking for a manual mapping.
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({
          tasks: {
            build: { outputLogs: 'new-only' },
            test: { outputLogs: 'hash-only' },
            lint: { outputLogs: 'loud' },
          },
        }),
      )
      const log = silent()
      await planRun({ cwd: root, tasks: ['build', 'test', 'lint'], log })
      const text = log.lines.join('\n')
      expect(text).not.toContain('outputLogs" ("new-only")')
      expect(text).not.toContain('has no vx equivalent')
      expect(text).toContain(
        '[@vzn/vx-migrate] app#test: turbo key "outputLogs" ("hash-only") is a per-run setting in vx — run with --output-logs hash-only',
      )
      expect(text).toContain(
        '[@vzn/vx-migrate] app#lint: turbo key "outputLogs" ("loud") is not a value vx knows — run with --output-logs full|hash-only|errors-only|none',
      )
    },
    TIMEOUT,
  )

  it(
    'every persistent task is one warning per run, not one per task',
    async () => {
      // n8n marks `dev` and `watch` persistent in most of its 84 packages;
      // a line per task was a hundred identical lines before the first frame.
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({
          tasks: {
            build: { outputs: ['dist/**'] },
            dev: { persistent: true, cache: false },
            watch: { persistent: true, cache: false },
          },
        }),
      )
      for (const name of ['lib', 'app']) {
        const file = path.join(root, 'packages', name, 'package.json')
        const pj = JSON.parse(await Bun.file(file).text()) as { scripts: Record<string, string> }
        pj.scripts['dev'] = 'echo dev'
        pj.scripts['watch'] = 'echo watch'
        await writeFile(file, JSON.stringify(pj))
      }
      const log = silent()
      await planRun({ cwd: root, tasks: ['build'], log })
      const lines = log.lines.filter((l) => l.includes('persistent'))
      expect(lines).toEqual([
        '[@vzn/vx-migrate] 4 task(s) (dev, watch across 2 package(s)): persistent in turbo.json — vx runs them as persistent tasks that are ready on spawn; add `exec.persistent.readyWhen` in a vx.config to gate dependents on their output',
      ])
    },
    TIMEOUT,
  )

  it(
    'a gap shared by many tasks is one warning per run, not written',
    async () => {
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({
          tasks: { build: { outputs: ['dist/**', '!dist/**/*.map'] }, '//#root': {} },
        }),
      )
      const log = silent()
      await planRun({ cwd: root, tasks: ['build'], log })
      const text = log.lines.join('\n')
      // Once for the workspace note, once for the gap — astro's `build`
      // carries the same `!vendor/**` output in 57 tasks, and a line per
      // task was 57 identical lines before the first frame (2026-09-11).
      expect(text).toContain(
        '[@vzn/vx-migrate] 2 task(s) (build across 2 package(s)): output "!dist/**/*.map": vx outputs have no negation',
      )
      expect(text).not.toContain('app#build: output')
      expect(text).toContain('[@vzn/vx-migrate] note: root task //#root not migrated')
      expect(text.split('root task //#root').length - 1).toBe(1)
      expect(text.split('vx outputs have no negation').length - 1).toBe(1)
    },
    TIMEOUT,
  )
})

describe('output negation', () => {
  it(
    'a negation that carves the package root out of a wildcard output runs the task uncached',
    async () => {
      // medusa: `outputs: ["!node_modules/**", "!src/**", "*/**", ".medusa/**"]`.
      // vx has no output negation; mapped to the positive `*/**` alone, the
      // clean before exec would delete `src/`. Uncached, and the sources
      // survive a real run.
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({
          tasks: {
            build: {
              dependsOn: ['codegen'],
              outputs: ['!node_modules/**', '!src/**', '*/**', '.medusa/**'],
            },
            codegen: { outputs: ['src/gen/**'] },
          },
        }),
      )
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['build'], log })
      const app = plan.tasks.find((t) => t.node.id === 'app#build')!.node
      expect(app.config.cache).toBeUndefined()
      expect(log.lines.join('\n')).toContain(
        '[@vzn/vx-migrate] 2 task(s) (build across 2 package(s)): outputs "!node_modules/**", "!src/**" narrow "*/**": vx outputs have no negation and the positive glob reaches the sources — task runs uncached; declare the exact outputs in a vx.config to cache it',
      )
      const result = await run({ cwd: root, tasks: ['build'], log: silent(), handleSignals: false })
      expect(result.ok).toBe(true)
      expect(
        await Bun.file(path.join(root, 'packages', 'app', 'src', 'gen', 'api.js')).exists(),
      ).toBe(true)
    },
    TIMEOUT,
  )
})

describe('per-package turbo.json', () => {
  it(
    'extends: false alone opts the package out of the task; with keys it runs on those keys alone',
    async () => {
      // n8n's @n8n/storybook: root defines build/test, the package has the
      // scripts, its turbo.json says `{ "extends": false }` — Turbo 2.9
      // runs nothing for it (probed 2026-09-11). With another key the task
      // runs on that key alone: no `^build` edge from the root.
      await writeFile(
        path.join(root, 'packages', 'app', 'turbo.json'),
        JSON.stringify({
          extends: ['//'],
          tasks: { build: { extends: false, outputs: ['dist/**'] }, lint: { extends: false } },
        }),
      )
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['build'], log })
      const ids = plan.tasks.map((t) => t.node.id).sort()
      expect(ids, log.lines.join('\n')).toEqual(['app#build', 'lib#build'])
      const lint = await planRun({ cwd: root, tasks: ['lint'], log })
      expect(lint.tasks.map((t) => t.node.id)).toEqual([])
      const app = plan.tasks.find((t) => t.node.id === 'app#build')!.node
      expect(app.deps).toEqual([])
      expect(app.config.cache!.inputs.files).toEqual(['**/*'])
    },
    TIMEOUT,
  )

  it(
    'a glob that climbs out of the package is re-anchored on the workspace root',
    async () => {
      // cal.com's app-store-cli#build writes `../../packages/app-store/
      // *.generated.ts`; as a project-relative output core refuses the
      // config and the whole run aborts. It is a workspace glob.
      await writeFile(
        path.join(root, 'packages', 'app', 'turbo.json'),
        JSON.stringify({
          extends: ['//'],
          tasks: {
            build: {
              inputs: ['src/**', '../lib/src/**', '!../lib/src/**/*.test.ts'],
              outputs: ['dist/**', '../lib/generated/**', '../../../elsewhere/**'],
            },
          },
        }),
      )
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['build'], log })
      const app = plan.tasks.find((t) => t.node.id === 'app#build')!.node
      const cache = app.config.cache!
      expect(cache.inputs.files).toEqual(['src/**'])
      expect(cache.inputs.workspaceFiles).toEqual([
        'tsconfig.base.json',
        'packages/lib/src/**',
        '!packages/lib/src/**/*.test.ts',
      ])
      expect(cache.outputs.files).toEqual(['dist/**'])
      expect(cache.outputs.workspaceFiles).toEqual(['packages/lib/generated/**'])
      expect(log.lines.join('\n')).toContain(
        'output "../../../elsewhere/**": leaves the workspace — map manually',
      )
    },
    TIMEOUT,
  )
})

describe('the mapping reads the packages core discovered', () => {
  it('maps a package that is in ctx.projects and not on disk — the plugin never walks the workspace itself', async () => {
    const plugin = turbo()
    const ghost = {
      name: 'ghost',
      dir: path.join(root, 'packages', 'ghost'),
      packageJson: { name: 'ghost', version: '1.0.0', scripts: { build: 'echo ghost' } },
      configPath: null,
    } as unknown as ProjectMeta
    const config: ProjectConfig = { tasks: {} }
    await plugin.project!(config, {
      workspaceRoot: root,
      cacheDir: path.join(root, '.vx'),
      warn() {},
      name: ghost.name,
      dir: ghost.dir,
      packageJson: ghost.packageJson as unknown as Readonly<Record<string, unknown>>,
      projects: [ghost],
    })
    expect(config.tasks?.build?.exec?.command).toBe('echo ghost')
  })
})

describe('one mapping per run', () => {
  it(
    "a package.json script edited between two runs in one process is the second run's command (the vx watch shape)",
    async () => {
      // The workspace module is reused across runs in a process (its import
      // is keyed on the file's bytes), so the plugin instance is too; a
      // mapping memoized for the process ran the cycle after this edit on
      // the old command.
      const first = await planRun({ cwd: root, tasks: ['build'], projects: ['lib'], log: silent() })
      expect(first.tasks[0]!.node.config.exec?.command).toBe(
        'mkdir -p dist && echo lib > dist/lib.js',
      )
      await writeFile(
        path.join(root, 'packages', 'lib', 'package.json'),
        JSON.stringify({ name: 'lib', version: '1.0.0', scripts: { build: 'echo lib-v2' } }),
      )
      const second = await planRun({
        cwd: root,
        tasks: ['build'],
        projects: ['lib'],
        log: silent(),
      })
      expect(second.tasks[0]!.node.config.exec?.command).toBe('echo lib-v2')
    },
    TIMEOUT,
  )
})
