// `vx migrate` e2e. Subprocess-driven like show-info.test.ts so the
// dispatcher wiring, exit codes, and UserError presentation are all
// exercised exactly as a user sees them. Every generated config is
// round-tripped through loadProjectConfig — TODO comments must never
// break parsing, and placeholder commands must validate.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { parseMigrateArgs } from '../src/cli/index.js'
import { loadProjectConfig } from '../src/workspace/index.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 20_000
const PLACEHOLDER = "echo 'TODO(vx-migrate): fill in' && exit 1"

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

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }),
  )
  return root
}

async function addPackage(
  root: string,
  name: string,
  scripts: Record<string, string>,
  deps?: Record<string, string>,
): Promise<string> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, scripts, ...(deps ? { dependencies: deps } : {}) }),
  )
  return dir
}

// ─── Turbo ────────────────────────────────────────────────────────────

const TURBO_JSON = {
  globalDependencies: ['tsconfig.base.json'],
  globalEnv: ['GLOBAL_MODE'],
  globalPassThroughEnv: ['AWS_PROFILE'],
  tasks: {
    build: {
      dependsOn: ['^build', 'codegen', '$TURBO_ROOT$/setup'],
      inputs: ['$TURBO_DEFAULT$', '!**/*.md', '$TURBO_ROOT$/tsconfig.base.json'],
      outputs: ['dist/**', '!dist/**/*.map'],
      env: ['NODE_ENV', 'VERCEL_*'],
    },
    codegen: { outputs: ['src/gen/**', '$TURBO_ROOT$/generated/api.ts'] },
    lint: { cache: false },
    dev: { cache: false, persistent: true },
    test: { passThroughEnv: ['CI'], interactive: true, outputs: [] },
    'app#test': { passThroughEnv: ['CI'], interactive: true, outputs: ['coverage/**'] },
    deploy: { outputs: [] },
  },
}

async function makeTurboWorkspace(): Promise<string> {
  const root = await makeRoot('vx-migrate-turbo-')
  await writeFile(path.join(root, 'turbo.json'), JSON.stringify(TURBO_JSON, null, 2))
  await addPackage(root, 'app', {
    build: 'tsc -b',
    codegen: 'node gen.js',
    lint: 'eslint .',
    dev: 'vite',
    test: 'vitest run',
  })
  const libDir = await addPackage(root, 'lib', { build: 'tsc' })
  await writeFile(
    path.join(libDir, 'turbo.json'),
    JSON.stringify({ extends: ['//'], tasks: { build: { outputs: ['lib/**'] } } }),
  )
  return root
}

describe('vx migrate (turbo)', () => {
  let root: string
  let result: VxResult
  beforeAll(async () => {
    root = await makeTurboWorkspace()
    result = await vx(root, ['migrate'])
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('exits 0 and reports written files', () => {
    expect(result.code).toBe(0)
    expect(result.out).toContain('packages/app/vx.config.ts')
    expect(result.out).toContain('packages/lib/vx.config.ts')
    expect(result.out).toContain('vx-preset.ts')
  })

  it(
    'generated app config round-trips through loadProjectConfig with every mapping row',
    async () => {
      const config = await loadProjectConfig(path.join(root, 'packages', 'app', 'vx.config.ts'))
      const tasks = config.tasks!

      // dependsOn verbatim; $TURBO_ROOT$ entry dropped (TODO).
      const build = tasks.build!
      expect(build.exec?.command).toBe('tsc -b')
      expect(build.dependsOn).toEqual(['^build', 'codegen'])
      // $TURBO_DEFAULT$ → '**/*' position preserved; negation passes
      // through. $TURBO_ROOT$/<path> inputs and globalDependencies are
      // both root-relative → inputs.workspaceFiles (preset spread first,
      // then the explicit entry — duplicates are a faithful mapping).
      expect(build.cache?.inputs.files).toEqual(['**/*', '!**/*.md'])
      expect(build.cache?.inputs.workspaceFiles).toEqual([
        'tsconfig.base.json',
        'tsconfig.base.json',
      ])
      // env → BOTH cache.inputs.env and passThrough; globalEnv spread into
      // both; globalPassThroughEnv into passThrough only; wildcard dropped.
      expect(build.cache?.inputs.env).toEqual(['GLOBAL_MODE', 'NODE_ENV'])
      expect(build.exec?.env?.passThrough).toEqual(['GLOBAL_MODE', 'AWS_PROFILE', 'NODE_ENV'])
      // output negation dropped (TODO).
      expect(build.cache?.outputs.files).toEqual(['dist/**'])

      // No inputs declared → turbo default = all package files.
      // $TURBO_ROOT$/<path> output → outputs.workspaceFiles.
      const codegen = tasks.codegen!
      expect(codegen.exec?.command).toBe('node gen.js')
      expect(codegen.cache?.inputs.files).toEqual(['**/*'])
      expect(codegen.cache?.inputs.workspaceFiles).toEqual(['tsconfig.base.json'])
      expect(codegen.cache?.inputs.env).toEqual(['GLOBAL_MODE'])
      expect(codegen.cache?.outputs.files).toEqual(['src/gen/**'])
      expect(codegen.cache?.outputs.workspaceFiles).toEqual(['generated/api.ts'])

      // cache:false → no cache block at all.
      const lint = tasks.lint!
      expect(lint.exec?.command).toBe('eslint .')
      expect(lint.cache).toBeUndefined()
      expect(lint.exec?.env?.passThrough).toEqual(['GLOBAL_MODE', 'AWS_PROFILE'])

      // persistent:true → exec.persistent: {} and no cache.
      const dev = tasks.dev!
      expect(dev.exec?.persistent).toEqual({})
      expect(dev.cache).toBeUndefined()

      // app#test root key merges over the plain `test` entry for app only.
      const test = tasks.test!
      expect(test.cache?.outputs.files).toEqual(['coverage/**'])
      expect(test.exec?.env?.passThrough).toEqual(['GLOBAL_MODE', 'AWS_PROFILE', 'CI'])
      // passThroughEnv is passThrough-only — not a cache input.
      expect(test.cache?.inputs.env).toEqual(['GLOBAL_MODE'])

      // No package declares a `deploy` script → task not emitted.
      expect(tasks.deploy).toBeUndefined()
    },
    TIMEOUT,
  )

  it(
    'per-package turbo.json extends-merges over the root task',
    async () => {
      const config = await loadProjectConfig(path.join(root, 'packages', 'lib', 'vx.config.ts'))
      const build = config.tasks!.build!
      expect(build.exec?.command).toBe('tsc')
      expect(build.cache?.outputs.files).toEqual(['lib/**'])
      // Inherited inputs from root; same-project dep `codegen` dropped
      // silently because lib has no codegen script (turbo semantics).
      expect(build.cache?.inputs.files).toEqual(['**/*', '!**/*.md'])
      expect(build.cache?.inputs.workspaceFiles).toEqual([
        'tsconfig.base.json',
        'tsconfig.base.json',
      ])
      expect(build.dependsOn).toEqual(['^build'])
    },
    TIMEOUT,
  )

  it('writes a vx-preset.ts with the three global arrays', async () => {
    const preset = await Bun.file(path.join(root, 'vx-preset.ts')).text()
    expect(preset).toContain("export const globalInputs = ['tsconfig.base.json']")
    expect(preset).toContain("export const globalEnvInputs = ['GLOBAL_MODE']")
    expect(preset).toContain("export const globalPassThroughEnv = ['AWS_PROFILE']")
  })

  it('reports clean/TODO counts and lists each TODO as project#task: reason', () => {
    // app: codegen + lint clean; build 3 TODOs ($TURBO_ROOT$ dep,
    // output negation, env wildcard — the $TURBO_ROOT$ input now maps
    // to inputs.workspaceFiles instead of a TODO), dev 1 (readyWhen),
    // test 1 (interactive). lib#build 2 (inherited $TURBO_ROOT$ dep,
    // env wildcard).
    expect(result.out).toContain('2 tasks migrated clean')
    expect(result.out).toContain('7 TODO')
    expect(result.out).toMatch(/app#build: .*\$TURBO_ROOT\$/)
    expect(result.out).toMatch(/app#dev: .*readyWhen/)
    expect(result.out).toMatch(/app#test: .*interactive/)
    expect(result.out).toMatch(/lib#build: /)
  })

  it('TODO comments are comments in the generated file', async () => {
    const text = await Bun.file(path.join(root, 'packages', 'app', 'vx.config.ts')).text()
    expect(text).toContain('// TODO(vx-migrate):')
  })

  it(
    'refuses to overwrite existing vx.config.* without --force',
    async () => {
      const again = await vx(root, ['migrate'])
      expect(again.code).toBe(1)
      expect(again.err).toContain('--force')
      expect(again.err).toContain('packages/app/vx.config.ts')
    },
    TIMEOUT,
  )

  it(
    '--force overwrites',
    async () => {
      const forced = await vx(root, ['migrate', '--force'])
      expect(forced.code).toBe(0)
      expect(forced.out).toContain('packages/app/vx.config.ts')
    },
    TIMEOUT,
  )
})

describe('vx migrate --dry (turbo)', () => {
  it(
    'prints generated contents with file headers and writes nothing',
    async () => {
      const root = await makeTurboWorkspace()
      try {
        const r = await vx(root, ['migrate', '--dry'])
        expect(r.code).toBe(0)
        expect(r.out).toContain('packages/app/vx.config.ts')
        expect(r.out).toContain('export default')
        expect(r.out).toContain('vx-preset.ts')
        expect(await Bun.file(path.join(root, 'packages', 'app', 'vx.config.ts')).exists()).toBe(
          false,
        )
        expect(await Bun.file(path.join(root, 'vx-preset.ts')).exists()).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

// ─── Nx ───────────────────────────────────────────────────────────────

const NX_GRAPH = {
  graph: {
    nodes: {
      'bench-root': {
        name: 'bench-root',
        type: 'app',
        data: {
          root: '.',
          targets: {
            'ci-all': {
              executor: 'nx:run-commands',
              options: { command: 'echo root ci' },
              cache: false,
            },
          },
        },
      },
      'pkg-a': {
        name: 'pkg-a',
        type: 'lib',
        data: {
          root: 'packages/pkg-a',
          targets: {
            umbrella: {
              executor: 'nx:noop',
              dependsOn: ['build', 'test'],
            },
            'dead-noop': {
              executor: 'nx:noop',
            },
            build: {
              executor: 'nx:run-commands',
              options: {
                commands: ['tsc -b', 'echo done'],
                outFile: 'packages/pkg-a/build/main.js',
              },
              inputs: [
                'production',
                '^production',
                '{workspaceRoot}/babel.config.json',
                { env: 'NODE_ENV' },
                { externalDependencies: ['webpack'] },
              ],
              outputs: [
                '{projectRoot}/dist',
                '{options.outFile}',
                '{projectRoot}/coverage/lcov.info',
                '{workspaceRoot}/reports/build.json',
              ],
              dependsOn: [
                '^build',
                { target: 'codegen' },
                { target: 'prebuild', projects: 'dependencies' },
                { target: 'tool', projects: ['pkg-b'] },
                { target: 'fmt', params: 'forward' },
              ],
              cache: true,
            },
            codegen: { executor: 'nx:run-commands', options: { command: 'node gen.js' } },
            test: { executor: 'nx:run-script', options: {}, cache: true },
            serve: { executor: '@nx/webpack:dev-server', options: { port: 4200 } },
            fmt: { executor: 'nx:run-commands', options: { command: 'fmt' } },
          },
        },
      },
      'pkg-b': {
        name: 'pkg-b',
        type: 'lib',
        data: {
          root: 'packages/pkg-b',
          targets: {
            build: {
              executor: 'nx:run-commands',
              options: { command: 'make', cwd: 'packages/pkg-b/sub' },
              inputs: ['{projectRoot}/src/**/*'],
              outputs: ['{projectRoot}/out'],
              cache: true,
            },
            pack: {
              executor: 'nx:run-commands',
              options: { command: 'pack' },
              outputs: ['{projectRoot}/pkg'],
            },
            prebuild: { executor: 'nx:run-commands', options: { command: 'pre' } },
            tool: { executor: 'nx:run-commands', options: { command: 'tool' } },
          },
        },
      },
    },
    dependencies: {
      'pkg-a': [
        { source: 'pkg-a', target: 'pkg-b', type: 'static' },
        { source: 'pkg-a', target: 'npm:react', type: 'static' },
      ],
      'pkg-b': [],
    },
  },
}

const NX_JSON = {
  namedInputs: {
    default: ['{projectRoot}/**/*'],
    production: ['default', '!{projectRoot}/**/*.spec.ts'],
  },
}

async function makeNxWorkspace(): Promise<string> {
  const root = await makeRoot('vx-migrate-nx-')
  await writeFile(path.join(root, 'nx.json'), JSON.stringify(NX_JSON, null, 2))
  await mkdir(path.join(root, '.nx', 'workspace-data'), { recursive: true })
  await writeFile(
    path.join(root, '.nx', 'workspace-data', 'project-graph.json'),
    JSON.stringify(NX_GRAPH, null, 2),
  )
  await addPackage(root, 'pkg-a', { test: 'jest' })
  await addPackage(root, 'pkg-b', {})
  return root
}

describe('vx migrate (nx)', () => {
  let root: string
  let result: VxResult
  beforeAll(async () => {
    root = await makeNxWorkspace()
    result = await vx(root, ['migrate'])
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('exits 0, notes the frozen-snapshot semantics and implicit deps', () => {
    expect(result.code).toBe(0)
    expect(result.out).toContain('plugin-inferred targets are frozen as static config')
    expect(result.out).toContain('1 implicit Nx dep not representable; review dependsOn')
  })

  it(
    'pkg-a covers run-commands, run-script, foreign executor, namedInputs, env, dependsOn objects',
    async () => {
      const config = await loadProjectConfig(path.join(root, 'packages', 'pkg-a', 'vx.config.ts'))
      const tasks = config.tasks!

      const build = tasks.build!
      // commands array joined with ' && '.
      expect(build.exec?.command).toBe('tsc -b && echo done')
      // namedInputs expansion: production → default + spec exclusion.
      // {workspaceRoot}/<path> → inputs.workspaceFiles, not a TODO.
      expect(build.cache?.inputs.files).toEqual(['**/*', '!**/*.spec.ts'])
      expect(build.cache?.inputs.workspaceFiles).toEqual(['babel.config.json'])
      // {env: X} → cache input AND passThrough (isolated child env).
      expect(build.cache?.inputs.env).toEqual(['NODE_ENV'])
      expect(build.exec?.env?.passThrough).toEqual(['NODE_ENV'])
      // outputs: dir heuristic, {options.*} resolution + project-prefix
      // strip, file with extension kept verbatim; {workspaceRoot}/<path>
      // → outputs.workspaceFiles.
      expect(build.cache?.outputs.files).toEqual(['dist/**', 'build/main.js', 'coverage/lcov.info'])
      expect(build.cache?.outputs.workspaceFiles).toEqual(['reports/build.json'])
      // dependsOn object forms.
      expect(build.dependsOn).toEqual(['^build', 'codegen', '^prebuild', 'pkg-b#tool', 'fmt'])

      // cache absent + no inputs/outputs → no cache block.
      expect(tasks.codegen!.cache).toBeUndefined()
      expect(tasks.codegen!.exec?.command).toBe('node gen.js')

      // run-script inlines the package.json script body; cache:true with
      // no inputs → files ['**/*'].
      const test = tasks.test!
      expect(test.exec?.command).toBe('jest')
      expect(test.cache?.inputs.files).toEqual(['**/*'])

      // Foreign executor → placeholder command; dependsOn/cache parts kept.
      const serve = tasks.serve!
      expect(serve.exec?.command).toBe(PLACEHOLDER)
    },
    TIMEOUT,
  )

  it('foreign-executor TODO carries the executor and its options JSON', async () => {
    const text = await Bun.file(path.join(root, 'packages', 'pkg-a', 'vx.config.ts')).text()
    expect(text).toContain('@nx/webpack:dev-server')
    expect(text).toContain('{"port":4200}')
  })

  it(
    'pkg-b covers cwd TODO, projectRoot strip, dir heuristic, implied cache',
    async () => {
      const config = await loadProjectConfig(path.join(root, 'packages', 'pkg-b', 'vx.config.ts'))
      const tasks = config.tasks!
      const build = tasks.build!
      expect(build.exec?.command).toBe('make')
      expect(build.cache?.inputs.files).toEqual(['src/**/*'])
      expect(build.cache?.outputs.files).toEqual(['out/**'])
      // cache absent but outputs present → cache block emitted.
      const pack = tasks.pack!
      expect(pack.cache?.outputs.files).toEqual(['pkg/**'])
      expect(pack.cache?.inputs.files).toEqual(['**/*'])
    },
    TIMEOUT,
  )

  it('reports nx TODO reasons per task', () => {
    expect(result.out).toMatch(/pkg-a#build: .*\^production/)
    // {workspaceRoot}/<path> entries map to workspaceFiles — no TODO.
    expect(result.out).not.toMatch(/pkg-a#build: .*workspaceRoot/)
    expect(result.out).toMatch(/pkg-a#build: .*externalDependencies/)
    expect(result.out).toMatch(/pkg-a#build: .*params/)
    expect(result.out).toMatch(/pkg-a#serve: .*@nx\/webpack:dev-server/)
    expect(result.out).toMatch(/pkg-a#test: /)
    expect(result.out).toMatch(/pkg-b#build: .*cwd/)
  })

  it(
    'tolerates the top-level {nodes, dependencies} graph variant',
    async () => {
      await writeFile(
        path.join(root, '.nx', 'workspace-data', 'project-graph.json'),
        JSON.stringify({ nodes: NX_GRAPH.graph.nodes, dependencies: NX_GRAPH.graph.dependencies }),
      )
      const r = await vx(root, ['migrate', '--force'])
      expect(r.code).toBe(0)
    },
    TIMEOUT,
  )

  it(
    'unknown graph shape is a clear error naming the file',
    async () => {
      await writeFile(path.join(root, '.nx', 'workspace-data', 'project-graph.json'), '{"foo":1}')
      const r = await vx(root, ['migrate', '--force'])
      expect(r.code).toBe(1)
      expect(r.err).toContain('project-graph.json')
    },
    TIMEOUT,
  )
})

// ─── Detection ────────────────────────────────────────────────────────

describe('vx migrate (nx) — noop and root', () => {
  let root: string
  beforeAll(async () => {
    root = await makeNxWorkspace()
    await vx(root, ['migrate'])
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('nx:noop with dependsOn becomes a group task (no exec, no cache)', async () => {
    const config = await loadProjectConfig(path.join(root, 'packages', 'pkg-a', 'vx.config.ts'))
    const umbrella = config.tasks!.umbrella!
    expect(umbrella.exec).toBeUndefined()
    expect(umbrella.cache).toBeUndefined()
    expect(umbrella.dependsOn).toEqual(['build', 'test'])
  })

  it('nx:noop without dependsOn is skipped with a report line', async () => {
    const text = await Bun.file(path.join(root, 'packages', 'pkg-a', 'vx.config.ts')).text()
    expect(text).not.toContain('dead-noop:')
    expect(text).toContain('nx:noop target with no dependsOn')
  })

  it('the root project node migrates to a root vx.config.ts', async () => {
    const config = await loadProjectConfig(path.join(root, 'vx.config.ts'))
    expect(config.tasks!['ci-all']!.exec?.command).toBe('echo root ci')
  })
})

describe('vx migrate source detection', () => {
  it(
    'nx.json without the graph file tells the user how to generate it',
    async () => {
      const root = await makeRoot('vx-migrate-det1-')
      try {
        await writeFile(path.join(root, 'nx.json'), '{}')
        const r = await vx(root, ['migrate'])
        expect(r.code).toBe(1)
        expect(r.err).toContain('nx graph --file=.nx/workspace-data/project-graph.json')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'both turbo.json and nx present requires --from to disambiguate',
    async () => {
      const root = await makeRoot('vx-migrate-det2-')
      try {
        await writeFile(path.join(root, 'turbo.json'), '{"tasks":{}}')
        await writeFile(path.join(root, 'nx.json'), '{}')
        const r = await vx(root, ['migrate'])
        expect(r.code).toBe(1)
        expect(r.err).toContain('turbo.json')
        expect(r.err).toContain('nx')
        expect(r.err).toContain('--from')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'neither source is an error',
    async () => {
      const root = await makeRoot('vx-migrate-det3-')
      try {
        const r = await vx(root, ['migrate'])
        expect(r.code).toBe(1)
        expect(r.err).toContain('turbo.json')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

// ─── Parser ───────────────────────────────────────────────────────────

describe('parseMigrateArgs', () => {
  it('defaults', () => {
    expect(parseMigrateArgs([])).toEqual({ dry: false, force: false })
  })
  it('--dry and --force', () => {
    expect(parseMigrateArgs(['--dry', '--force'])).toEqual({ dry: true, force: true })
  })
  it('unknown flag errors', () => {
    expect(parseMigrateArgs(['--nope']).error).toContain('--nope')
  })
  it('positionals error', () => {
    expect(parseMigrateArgs(['turbo']).error).toContain('turbo')
  })
})
