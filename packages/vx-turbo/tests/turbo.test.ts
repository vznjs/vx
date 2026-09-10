// A Turbo repo runs under vx with no vx.config written. Every pin is a real
// `planRun` / `run` over a workspace whose only vx file declares the plugin:
// the migrate suite's Turbo fixture, minus the migration.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { planRun, run, type Logger } from '@vzn/vx'
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

describe('@vzn/vx-turbo', () => {
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
    'a task that does not map is reported once, as a warning, not written',
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
      expect(text).toContain(
        '[@vzn/vx-turbo] app#build: output "!dist/**/*.map": vx outputs have no negation',
      )
      expect(text).toContain('[@vzn/vx-turbo] note: root task //#root not migrated')
      // Once for the workspace note, once per (package, task) for the gap.
      expect(text.split('root task //#root').length - 1).toBe(1)
    },
    TIMEOUT,
  )
})
