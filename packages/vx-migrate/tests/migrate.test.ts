// `vx-migrate` end to end through its own bin: Turbo and Nx workspaces → the
// files core's migration seam writes. The fixture links `@vzn/vx` into each
// tmp workspace, as the scaffolded files import it.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { loadProjectConfig, type TaskConfig } from '@vzn/vx'
import { parseMigrateArgs } from '../src/index.js'
import { migrateTurbo } from '../src/migrate-turbo.js'

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

const CORE_PKG = path.resolve(import.meta.dir, '..', '..', 'vx')

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }),
  )
  // The scaffolded `vx.workspace.ts` imports `@vzn/vx`, and a tmp dir has
  // no node_modules. This used to resolve through a machine-global
  // `bun link`, so the suite passed or failed on invisible state outside
  // the repo — a `bun install` that drops the link turns every fixture
  // here into `Unexpected while resolving package '@vzn/vx'`. Link it
  // per fixture instead: the test now carries what it needs.
  await mkdir(path.join(root, 'node_modules', '@vzn'), { recursive: true })
  await symlink(CORE_PKG, path.join(root, 'node_modules', '@vzn', 'vx'), 'dir')
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
    result = await vx(root, [])
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

  it('emits vx.workspace.ts declaring the local plugins when none exists', async () => {
    expect(result.out).toContain('vx.workspace.ts')
    const ws = await Bun.file(path.join(root, 'vx.workspace.ts')).text()
    // Type-only: the runtime `defineWorkspace` import loaded a second copy
    // of core into every run (~17 ms on a two-package workspace).
    expect(ws).toContain("import type { WorkspaceConfig } from '@vzn/vx'")
    expect(ws).not.toContain('defineWorkspace')
    expect(ws).toContain('export default { plugins: [] } satisfies WorkspaceConfig')
  })

  it('does not emit vx.workspace.ts when one already exists', async () => {
    const other = await makeTurboWorkspace()
    try {
      await writeFile(
        path.join(other, 'vx.workspace.mjs'),
        'export default { plugins: [] } // MARKER\n',
      )
      const r = await vx(other, [])
      expect(r.code).toBe(0)
      expect(r.out).not.toContain('vx.workspace.ts')
      expect(await Bun.file(path.join(other, 'vx.workspace.ts')).exists()).toBe(false)
      expect(await Bun.file(path.join(other, 'vx.workspace.mjs')).text()).toContain('MARKER')
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })

  it('writes a vx-preset.ts with the three global arrays', async () => {
    const preset = await Bun.file(path.join(root, 'vx-preset.ts')).text()
    expect(preset).toContain("export const globalInputs = ['tsconfig.base.json']")
    // The preset names the tool as the configs do; `vx migrate` is no verb.
    expect(preset).toContain('// Generated by `vx-migrate` from turbo.json')
    expect(preset).not.toContain('vx migrate')
    expect(preset).toContain("export const globalEnvInputs = ['GLOBAL_MODE']")
    expect(preset).toContain("export const globalPassThroughEnv = ['AWS_PROFILE']")
  })

  it(
    '--mjs writes vx.config.mjs files that import a vx-preset.mjs, and they load',
    async () => {
      const r = await vx(root, ['--mjs', '--force'])
      expect(r.code).toBe(0)
      expect(r.out).toContain('turbo.json → vx.config.mjs')
      expect(r.out).toContain('vx-preset.mjs')
      const preset = await Bun.file(path.join(root, 'vx-preset.mjs')).text()
      expect(preset).toContain('export const globalInputs')
      const generated = await Bun.file(path.join(root, 'packages', 'app', 'vx.config.mjs')).text()
      expect(generated).not.toContain('@vzn/vx')
      expect(generated).not.toContain('satisfies')
      expect(generated).toContain("from '../../vx-preset.mjs'")
      const config = await loadProjectConfig(path.join(root, 'packages', 'app', 'vx.config.mjs'))
      expect(config.tasks?.build).toBeDefined()
      // Back to the .ts form for the tests that follow.
      await rm(path.join(root, 'vx-preset.mjs'))
      await rm(path.join(root, 'packages', 'app', 'vx.config.mjs'))
      await rm(path.join(root, 'packages', 'lib', 'vx.config.mjs'), { force: true })
      const back = await vx(root, ['--force'])
      expect(back.code).toBe(0)
    },
    TIMEOUT,
  )

  it('reports clean/TODO counts and lists each TODO as project#task: reason', () => {
    // app: codegen + lint clean; build 3 TODOs ($TURBO_ROOT$ dep,
    // output negation, env wildcard — the $TURBO_ROOT$ input now maps
    // to inputs.workspaceFiles instead of a TODO), test 1 (interactive).
    // lib#build 2 (inherited $TURBO_ROOT$ dep, env wildcard). app#dev is
    // persistent and nothing depends on it, so its readiness note is no
    // TODO: it counts as clean (item 602).
    expect(result.out).toContain('3 tasks migrated clean')
    expect(result.out).toContain('6 TODO')
    expect(result.out).toMatch(/app#build: .*\$TURBO_ROOT\$/)
    expect(result.out).not.toMatch(/app#dev: .*readyWhen/)
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
      const again = await vx(root, [])
      expect(again.code).toBe(1)
      expect(again.err).toContain('--force')
      expect(again.err).toContain('packages/app/vx.config.ts')
    },
    TIMEOUT,
  )

  it(
    '--force overwrites',
    async () => {
      const forced = await vx(root, ['--force'])
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
        const r = await vx(root, ['--dry'])
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
                { runtime: 'node --version' },
                { externalDependencies: ['webpack'] },
              ],
              outputs: [
                '{projectRoot}/dist',
                '{options.outFile}',
                '{projectRoot}/coverage/lcov.info',
                '{projectRoot}/.output',
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
            empty: { executor: 'nx:run-script', options: {} },
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
            // Shares build's output path with no ^ edge (strapi's build:types).
            'build:types': {
              executor: 'nx:run-commands',
              options: { command: 'tsc --emitDeclarationOnly' },
              outputs: ['{projectRoot}/out'],
              cache: true,
            },
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

async function makeNxWorkspace(aDeps?: Record<string, string>): Promise<string> {
  const root = await makeRoot('vx-migrate-nx-')
  await writeFile(path.join(root, 'nx.json'), JSON.stringify(NX_JSON, null, 2))
  await mkdir(path.join(root, '.nx', 'workspace-data'), { recursive: true })
  await writeFile(
    path.join(root, '.nx', 'workspace-data', 'project-graph.json'),
    JSON.stringify(NX_GRAPH, null, 2),
  )
  await addPackage(root, 'pkg-a', { test: 'jest', empty: '' }, aDeps)
  await addPackage(root, 'pkg-b', {})
  return root
}

describe('vx migrate (nx)', () => {
  let root: string
  let result: VxResult
  beforeAll(async () => {
    root = await makeNxWorkspace()
    result = await vx(root, [])
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('exits 0, notes the frozen-snapshot semantics and NAMES the implicit dep', () => {
    expect(result.code).toBe(0)
    expect(result.out).toContain('plugin-inferred targets are frozen as static config')
    // The pair, not just the count: a reader given "1 implicit Nx dep" has
    // to search the graph for it, and the pair is what they write the
    // dependsOn from (2026-09-20).
    expect(result.out).toContain(
      '1 implicit Nx dep not representable (pkg-a → pkg-b); review dependsOn',
    )
  })

  it(
    'pkg-a covers run-commands, run-script, foreign executor, namedInputs, env, dependsOn objects',
    async () => {
      const config = await loadProjectConfig(path.join(root, 'packages', 'pkg-a', 'vx.config.ts'))
      const tasks = config.tasks!

      const build = tasks.build!
      // `commands` run in parallel (Nx's default), each with the option
      // run-commands does not consume appended, as Nx appends it. Nx runs
      // run-commands from the workspace root: the cd is part of the command.
      expect(build.exec?.command).toBe(
        `nx_run() { nx_c=$1; shift; if [ $# -eq 0 ]; then eval "$nx_c"; else eval "$nx_c \\"\\$@\\""; fi; }; ` +
          `nx_run_commands() { trap 'trap "" TERM USR1; kill -TERM 0; wait; exit 1' USR1; ` +
          `{ trap 'nx_term=1' TERM; (nx_run 'tsc -b --outFile=packages/pkg-a/build/main.js' "$@") || [ -n "$nx_term" ] || kill -USR1 $$; } & ` +
          `{ trap 'nx_term=1' TERM; (nx_run 'echo done --outFile=packages/pkg-a/build/main.js' "$@") || [ -n "$nx_term" ] || kill -USR1 $$; } & wait; }; ` +
          'cd ../.. && nx_run_commands',
      )
      // namedInputs expansion: production → default + spec exclusion.
      // {workspaceRoot}/<path> → inputs.workspaceFiles, not a TODO.
      expect(build.cache?.inputs.files).toEqual(['**/*', '!**/*.spec.ts'])
      expect(build.cache?.inputs.workspaceFiles).toEqual(['babel.config.json'])
      // {env: X} → cache input AND passThrough (isolated child env).
      expect(build.cache?.inputs.env).toEqual(['NODE_ENV'])
      expect(build.exec?.env?.passThrough).toEqual(['NODE_ENV'])
      // {runtime: "<cmd>"} → cache.inputs.runtime, which schema.md calls
      // the Nx runtime input's equivalent. It used to reach the
      // fall-through and be reported "not representable in vx"
      // (2026-09-20).
      expect(build.cache?.inputs.runtime).toEqual(['node --version'])
      // outputs: dir heuristic (a leading dot is a hidden directory, not
      // an extension — a bare `.output` would save nothing, the output
      // scan lists files), {options.*} resolution + project-prefix strip,
      // file with extension kept verbatim; {workspaceRoot}/<path> →
      // outputs.workspaceFiles.
      expect(build.cache?.outputs.files).toEqual([
        'dist/**',
        'build/main.js',
        'coverage/lcov.info',
        '.output/**',
      ])
      expect(build.cache?.outputs.workspaceFiles).toEqual(['reports/build.json'])
      // dependsOn object forms.
      expect(build.dependsOn).toEqual(['^build', 'codegen', '^prebuild', 'pkg-b#tool', 'fmt'])

      // cache absent + no inputs/outputs → no cache block.
      expect(tasks.codegen!.cache).toBeUndefined()
      expect(tasks.codegen!.exec?.command).toBe('cd ../.. && node gen.js')

      // run-script inlines the package.json script body; cache:true with
      // no inputs → files ['**/*'].
      const test = tasks.test!
      expect(test.exec?.command).toBe('jest')
      expect(test.cache?.inputs.files).toEqual(['**/*'])

      // A foreign executor runs as itself through nx-exec, its options on
      // the line; dependsOn/cache parts kept.
      const serve = tasks.serve!
      expect(serve.exec?.command).toBe(
        `nx-exec @nx/webpack:dev-server --project pkg-a --target serve --options '{"port":4200}'`,
      )

      // run-script on an empty script (novu's `test:watch: ""`) is the
      // placeholder with a todo, not `command: ''` — a config that refuses
      // to load.
      expect(tasks.empty!.exec?.command).toBe(PLACEHOLDER)
      const text = await Bun.file(path.join(root, 'packages', 'pkg-a', 'vx.config.ts')).text()
      expect(text).toContain('package.json script "empty" is empty')
    },
    TIMEOUT,
  )

  it('foreign-executor TODO carries the executor and its options JSON', async () => {
    const text = await Bun.file(path.join(root, 'packages', 'pkg-a', 'vx.config.ts')).text()
    expect(text).toContain('@nx/webpack:dev-server')
    expect(text).toContain('{"port":4200}')
  })

  it("the cascade TODO says what vx folds: each dependency's key, never its outputs", async () => {
    // pkg-a's build carries the `^production` input (the fixture above); the
    // todo it earns must not claim the reverse of principle 5.
    const text = await Bun.file(path.join(root, 'packages', 'pkg-a', 'vx.config.ts')).text()
    expect(text).toContain(
      `deps-input "^production": vx already folds each dependency's cache key (its inputs, never its outputs) through dependsOn`,
    )
    expect(text).not.toContain('upstream outputs')
  })

  it(
    'pkg-b covers cwd, projectRoot strip, dir heuristic, implied cache',
    async () => {
      const config = await loadProjectConfig(path.join(root, 'packages', 'pkg-b', 'vx.config.ts'))
      const tasks = config.tasks!
      const build = tasks.build!
      // A declared cwd under the project: a cd relative to the project dir, no todo.
      expect(build.exec?.command).toBe('cd sub && make')
      expect(build.cache?.inputs.files).toEqual(['src/**/*'])
      expect(build.cache?.outputs.files).toEqual(['out/**'])

      // Two targets on one output path: the one with the ^ edge keeps
      // its cache, the sibling runs uncached with a todo naming it —
      // instead of the loader's refusal after a clean migration report.
      const types = tasks['build:types']!
      expect(types.exec?.command).toBe('cd ../.. && tsc --emitDeclarationOnly')
      expect(types.cache).toBeUndefined()
      const text = await Bun.file(path.join(root, 'packages', 'pkg-b', 'vx.config.ts')).text()
      expect(text).toContain('"out/**" that "build" also declares')
      // cache absent but outputs present → cache block emitted.
      // Outputs without `cache: true` is an uncached target in Nx; the
      // mapper used to cache it anyway (item 591).
      const pack = tasks.pack!
      expect(pack.cache).toBeUndefined()
      expect(pack.exec?.command).toBe('cd ../.. && pack')
    },
    TIMEOUT,
  )

  it('reports nx TODO reasons per task', () => {
    expect(result.out).toMatch(/pkg-a#build: .*\^production/)
    // {workspaceRoot}/<path> entries map to workspaceFiles — no TODO.
    expect(result.out).not.toMatch(/pkg-a#build: .*workspaceRoot/)
    expect(result.out).toMatch(/pkg-a#build: .*externalDependencies/)
    expect(result.out).toMatch(/pkg-a#build: .*params/)
    // An executor is no gap any more: nx-exec runs it. Its lifetime still is.
    expect(result.out).not.toMatch(/no shell equivalent/)
    // Nothing depends on serve: no readiness note to report (item 602).
    expect(result.out).not.toMatch(/pkg-a#serve: persistent task/)
    // No `inputs` is Nx's own default set, not a gap (item 591).
    expect(result.out).not.toMatch(/cache enabled with no declared inputs/)
    expect(result.out).not.toMatch(/pkg-b#build: .*cwd/)
  })

  it(
    'tolerates the top-level {nodes, dependencies} graph variant',
    async () => {
      await writeFile(
        path.join(root, '.nx', 'workspace-data', 'project-graph.json'),
        JSON.stringify({ nodes: NX_GRAPH.graph.nodes, dependencies: NX_GRAPH.graph.dependencies }),
      )
      const r = await vx(root, ['--force'])
      expect(r.code).toBe(0)
    },
    TIMEOUT,
  )

  it(
    'unknown graph shape is a clear error naming the file',
    async () => {
      await writeFile(path.join(root, '.nx', 'workspace-data', 'project-graph.json'), '{"foo":1}')
      const r = await vx(root, ['--force'])
      expect(r.code).toBe(1)
      expect(r.err).toContain('project-graph.json')
    },
    TIMEOUT,
  )
})

describe('vx migrate (nx) — the implicit-dep note reads the package graph', () => {
  it(
    'an Nx edge the manifest names by a range pkg-b does not satisfy is still implicit',
    async () => {
      // `^9.0.0` on the version-less pkg-b is a registry dependency: vx's
      // graph has no pkg-a → pkg-b edge, so the Nx edge is one vx cannot
      // see. `workspace:*` is the edge, and nothing is reported.
      const notes = new Map<string, string>()
      for (const spec of ['^9.0.0', 'workspace:*']) {
        const root = await makeNxWorkspace({ 'pkg-b': spec })
        try {
          const r = await vx(root, [])
          expect(r.code).toBe(0)
          notes.set(spec, r.out.split('\n').find((l) => l.includes('implicit Nx dep')) ?? '')
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      }
      expect(Object.fromEntries(notes)).toEqual({
        '^9.0.0': '1 implicit Nx dep not representable (pkg-a → pkg-b); review dependsOn',
        'workspace:*': '',
      })
    },
    TIMEOUT,
  )
})

// ─── Detection ────────────────────────────────────────────────────────

describe('vx migrate (nx) — noop and root', () => {
  let root: string
  beforeAll(async () => {
    root = await makeNxWorkspace()
    await vx(root, [])
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

// Nx separates a specific project's target with a COLON; vx's separator is
// `#`. The object form (`{ target, projects: ['pkg-b'] }`) was mapped, the
// STRING form was passed through verbatim, and the migrated workspace then
// refused to run: "depends on pkg-a#pkg-b:tool but no such task is
// declared", out of a config vx-migrate wrote (walked the Nx path,
// 2026-09-20).
describe('vx migrate (nx) — a project:target string dependency', () => {
  let root: string
  let tasks: Record<string, TaskConfig>
  beforeAll(async () => {
    root = await makeRoot('vx-migrate-nx-colon-')
    await mkdir(path.join(root, '.nx', 'workspace-data'), { recursive: true })
    await writeFile(
      path.join(root, '.nx', 'workspace-data', 'project-graph.json'),
      JSON.stringify({
        nodes: {
          'pkg-a': {
            name: 'pkg-a',
            type: 'lib',
            data: {
              root: 'packages/pkg-a',
              targets: {
                build: {
                  executor: 'nx:run-commands',
                  options: { command: 'echo a' },
                  dependsOn: [
                    '^build',
                    'pkg-b:tool',
                    'pkg-b:tool:production',
                    'pkg-b:tool:ci',
                    'pkg-b:tool:dflt',
                    'ghost:build',
                  ],
                },
              },
            },
          },
          'pkg-b': {
            name: 'pkg-b',
            type: 'lib',
            data: {
              root: 'packages/pkg-b',
              targets: {
                tool: {
                  executor: 'nx:run-commands',
                  options: { command: 'echo b' },
                  // `ci` is a task of its own; `dflt` is the default, folded into `tool`.
                  configurations: { ci: { command: 'echo ci' }, dflt: {} },
                  defaultConfiguration: 'dflt',
                },
              },
            },
          },
        },
        dependencies: { 'pkg-a': [], 'pkg-b': [] },
      }),
    )
    await addPackage(root, 'pkg-a', {})
    await addPackage(root, 'pkg-b', {})
    await vx(root, [])
    const config = await loadProjectConfig(path.join(root, 'packages', 'pkg-a', 'vx.config.ts'))
    tasks = config.tasks as Record<string, TaskConfig>
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('becomes `project#target`; a configuration edge reaches its task, the default one the base', () => {
    expect(tasks.build!.dependsOn).toEqual([
      '^build',
      'pkg-b#tool',
      'pkg-b#tool',
      'pkg-b#tool:ci',
      'pkg-b#tool',
    ])
  })

  it('says when a configuration the target lacks was dropped, and names the edge it kept', async () => {
    const text = await Bun.file(path.join(root, 'packages', 'pkg-a', 'vx.config.ts')).text()
    expect(text).toContain(
      'pkg-b declares no "production" configuration on tool — depending on pkg-b#tool',
    )
    expect(text).not.toContain('declares no "ci"')
    expect(text).not.toContain('declares no "dflt"')
  })

  it('drops an edge to a project the graph does not have, and says so', async () => {
    const text = await Bun.file(path.join(root, 'packages', 'pkg-a', 'vx.config.ts')).text()
    expect(text).toContain('"ghost:build" names "ghost", which is not a workspace package')
  })
})

describe('vx migrate (nx) — root clobber guard', () => {
  let root: string
  beforeAll(async () => {
    root = await makeNxWorkspace()
    // A hand-written root config. The nx root node writes to this exact path,
    // but the root is not a DISCOVERED project (packages/*), so the old
    // meta-only conflict check missed it and clobbered it.
    await writeFile(
      path.join(root, 'vx.config.ts'),
      'export default { /* PRECIOUS HAND-WRITTEN */ }',
    )
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('refuses to overwrite an existing root vx.config.ts without --force', async () => {
    const r = await vx(root, [])
    expect(r.code).toBe(1)
    expect(r.err).toContain('refusing to overwrite')
    const text = await Bun.file(path.join(root, 'vx.config.ts')).text()
    expect(text).toContain('PRECIOUS HAND-WRITTEN') // untouched
  })
})

describe('vx migrate (turbo) — commands with newlines round-trip', () => {
  let root: string
  beforeAll(async () => {
    root = await makeRoot('vx-migrate-nl-')
    await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ tasks: { build: {} } }))
    await addPackage(root, 'app', { build: 'echo one\necho two' })
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('a script with an embedded newline generates a loadable config', async () => {
    const r = await vx(root, [])
    expect(r.code).toBe(0)
    // The generated single-quoted TS literal must escape the newline, else it
    // is an unterminated string that fails to load.
    const config = await loadProjectConfig(path.join(root, 'packages', 'app', 'vx.config.ts'))
    expect(config.tasks!.build!.exec?.command).toBe('echo one\necho two')
  })
})

describe('vx migrate (turbo) — preset globals with quotes/backslashes round-trip', () => {
  let root: string
  beforeAll(async () => {
    root = await makeRoot('vx-migrate-preset-')
    // A globalDependencies glob containing a single quote + backslash: legal on
    // Linux, verbatim in JSON. The preset renderer must escape it, else the
    // emitted `vx-preset.ts` is an unterminated / mis-quoted string literal.
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({
        globalDependencies: ["config's/**", 'a\\b/**'],
        tasks: { build: {} },
      }),
    )
    await addPackage(root, 'app', { build: 'tsc -b' })
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('generates a loadable vx-preset.ts preserving the exact glob strings', async () => {
    const r = await vx(root, [])
    expect(r.code).toBe(0)
    // Import the emitted preset through Bun's own TS loader — a malformed
    // literal throws here; the values must survive escaping byte-for-byte.
    const mod = (await import(path.join(root, 'vx-preset.ts'))) as { globalInputs: string[] }
    expect(mod.globalInputs).toEqual(["config's/**", 'a\\b/**'])
  })
})

// package.json is a system boundary: a script value is whatever the file
// holds. Anything that isn't a non-empty string was spliced into
// `exec.command` verbatim — `null` aborted the whole migration in the
// emitter, the rest wrote a config that fails to load. Both landed AFTER
// "migrated clean, 0 TODOs" and exit 0.
describe('vx migrate (turbo) — unusable package.json scripts', () => {
  const cases: Array<[label: string, value: unknown]> = [
    ['null', null],
    ['a number', 42],
    ['an object', {}],
    ['an empty string', ''],
    ['a boolean', true],
  ]

  for (const [label, value] of cases) {
    it(
      `reports ${label} as a TODO instead of emitting an unloadable command`,
      async () => {
        const root = await makeRoot('vx-migrate-badscript-')
        try {
          await writeFile(
            path.join(root, 'turbo.json'),
            JSON.stringify({ tasks: { build: {}, lint: {} } }),
          )
          const dir = path.join(root, 'packages', 'app')
          await mkdir(dir, { recursive: true })
          await writeFile(
            path.join(dir, 'package.json'),
            JSON.stringify({ name: 'app', scripts: { build: value, lint: 'oxlint' } }),
          )

          const r = await vx(root, [])
          expect(r.code).toBe(0)
          expect(r.out).toContain('app#build:')
          expect(r.out).toMatch(/not a\s+non-empty command string/)
          expect(r.out).not.toContain('0 TODOs')

          // The good sibling still migrates, and the file must LOAD.
          const config = await loadProjectConfig(path.join(dir, 'vx.config.ts'))
          expect(config.tasks!.lint!.exec?.command).toBe('oxlint')
          expect(config.tasks!.build).toBeUndefined()
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
      TIMEOUT,
    )
  }

  it(
    'drops a dependsOn edge onto an unusable script rather than pointing at a missing task',
    async () => {
      const root = await makeRoot('vx-migrate-badscript-dep-')
      try {
        await writeFile(
          path.join(root, 'turbo.json'),
          JSON.stringify({ tasks: { build: {}, test: { dependsOn: ['build'] } } }),
        )
        const dir = path.join(root, 'packages', 'app')
        await mkdir(dir, { recursive: true })
        await writeFile(
          path.join(dir, 'package.json'),
          JSON.stringify({ name: 'app', scripts: { build: 42, test: 'bun test' } }),
        )

        const r = await vx(root, [])
        expect(r.code).toBe(0)
        const config = await loadProjectConfig(path.join(dir, 'vx.config.ts'))
        expect(config.tasks!.test!.dependsOn ?? []).toEqual([])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

describe('vx migrate source detection', () => {
  it(
    'nx.json without the graph file tells the user how to generate it',
    async () => {
      const root = await makeRoot('vx-migrate-det1-')
      try {
        await writeFile(path.join(root, 'nx.json'), '{}')
        const r = await vx(root, [])
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
        const r = await vx(root, [])
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
    'neither source is an error that names `vx init` for package.json scripts',
    async () => {
      const root = await makeRoot('vx-migrate-det3-')
      try {
        await addPackage(root, 'a', { build: 'tsc' })
        const r = await vx(root, [])
        expect(r.code).toBe(1)
        expect(r.err).toContain('no turbo.json')
        expect(r.err).toContain('vx init')
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
    expect(parseMigrateArgs([])).toEqual({ dry: false, force: false, mjs: false })
  })
  it('--dry and --force', () => {
    expect(parseMigrateArgs(['--dry', '--force'])).toEqual({ dry: true, force: true, mjs: false })
  })
  it('unknown flag errors', () => {
    expect(parseMigrateArgs(['--nope']).error).toContain('--nope')
  })
  it('positionals error', () => {
    expect(parseMigrateArgs(['turbo']).error).toContain('turbo')
  })
  it('--from scripts is not a source here (it is `vx init`)', () => {
    expect(parseMigrateArgs(['--from', 'scripts']).error).toContain('vx init')
  })
})

describe('vx migrate (nx) — executors', () => {
  it('every executor becomes an nx-exec line carrying its options, with no TODO', async () => {
    const root = await makeRoot('vx-migrate-nx-exec-')
    try {
      await addPackage(root, 'app', {})
      await mkdir(path.join(root, '.nx', 'workspace-data'), { recursive: true })
      await Bun.write(
        path.join(root, '.nx', 'workspace-data', 'project-graph.json'),
        JSON.stringify({
          nodes: {
            app: {
              name: 'app',
              type: 'app',
              data: {
                root: 'packages/app',
                targets: {
                  test: { executor: '@nx/vitest:test', options: {} },
                  odd: {
                    executor: '@acme/thing:do',
                    options: { x: 1, s: "it's", list: [{ a: 'b' }] },
                  },
                  // Nx's default layout: a workspace-root `dist/<project>` is a
                  // workspaceFiles output, not a gap (item 593).
                  pack: {
                    executor: '@nx/js:tsc',
                    options: { outputPath: 'dist/packages/app' },
                    outputs: ['{options.outputPath}', 'dist/reports/app.json'],
                    cache: true,
                  },
                  // A serve-like NAME is no lifetime: cached by nx.json's list
                  // like any other target (nx#32610).
                  dev: {
                    executor: 'nx:run-commands',
                    options: { command: 'vite' },
                    outputs: ['{projectRoot}/dist'],
                  },
                  // A configuration is a task of its own; the default one folds in.
                  build: {
                    executor: '@nx/js:tsc',
                    options: { main: 'src/index.ts', mode: 'dev' },
                    configurations: {
                      production: { mode: 'prod' },
                      ci: { mode: 'ci', extra: true },
                    },
                    defaultConfiguration: 'production',
                    dependsOn: ['^build'],
                  },
                },
              },
            },
          },
          dependencies: { app: [] },
        }),
      )
      // Legacy nx.json: `odd` and `dev` are cacheable by name, `test` is not.
      await Bun.write(
        path.join(root, 'nx.json'),
        JSON.stringify({
          namedInputs: { default: ['{projectRoot}/src/**', '{workspaceRoot}/tsconfig.base.json'] },
          tasksRunnerOptions: { default: { options: { cacheableOperations: ['odd', 'dev'] } } },
        }),
      )
      const r = await vx(root, ['--from', 'nx'])
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
      const tasks = (await loadProjectConfig(path.join(root, 'packages', 'app', 'vx.config.ts')))
        .tasks!
      expect(Object.keys(tasks).sort()).toEqual(['build', 'build:ci', 'dev', 'odd', 'pack', 'test'])
      expect(tasks['pack']!.cache?.outputs).toEqual({
        files: [],
        workspaceFiles: ['dist/packages/app/**', 'dist/reports/app.json'],
      })
      expect(r.out).not.toContain('falls outside the project dir')
      // Cached by the legacy list, inputs from nx.json's `default` named input.
      expect(tasks['odd']!.cache).toEqual({
        inputs: { files: ['src/**'], workspaceFiles: ['tsconfig.base.json'] },
        outputs: { files: [] },
      })
      expect(tasks['test']!.cache).toBeUndefined()
      expect(tasks['dev']!.cache).toEqual({
        inputs: { files: ['src/**'], workspaceFiles: ['tsconfig.base.json'] },
        outputs: { files: ['dist/**'] },
      })
      expect(tasks['dev']!.exec?.persistent).toBeUndefined()
      expect(tasks['test']!.exec?.command).toBe(
        'nx-exec @nx/vitest:test --project app --target test',
      )
      expect(tasks['odd']!.exec?.command).toBe(
        `nx-exec @acme/thing:do --project app --target odd --options '{"x":1,"s":"it'\\''s","list":[{"a":"b"}]}'`,
      )
      expect(tasks['build']!.exec?.command).toBe(
        `nx-exec @nx/js:tsc --project app --target build --configuration production --options '{"main":"src/index.ts","mode":"prod"}'`,
      )
      expect(tasks['build:ci']!.exec?.command).toBe(
        `nx-exec @nx/js:tsc --project app --target build --configuration ci --options '{"main":"src/index.ts","mode":"ci","extra":true}'`,
      )
      expect(tasks['build:ci']!.dependsOn).toEqual(['^build'])
      expect(r.out).not.toContain('no shell equivalent')
      expect(r.out).not.toContain('mapped from executor')
      expect(r.out).toContain(
        'app#build:ci: configuration "ci": Nx runs dependencies with the same',
      )
      expect(r.out).toContain('executor targets run through `nx-exec`')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('vx migrate (nx) — a server target is persistent', () => {
  // A dev/preview server never exits. Until 2026-09-04 the Nx path mapped
  // `@nx/vite:dev-server` to `vite` as an ORDINARY task, so `vx run serve`
  // waited forever for an exit that never comes. Nx's own signal is the
  // target's `continuous`; a graph from an Nx older than that field still
  // names the executor. The target NAME never decides (nx#32610).
  it('`continuous` or a server executor is persistent; a target name never is', async () => {
    const root = await makeRoot('vx-migrate-nx-persistent-')
    try {
      await addPackage(root, 'app', {})
      await mkdir(path.join(root, '.nx', 'workspace-data'), { recursive: true })
      await Bun.write(
        path.join(root, '.nx', 'workspace-data', 'project-graph.json'),
        JSON.stringify({
          nodes: {
            app: {
              name: 'app',
              type: 'app',
              data: {
                root: 'packages/app',
                targets: {
                  // The executor says server, whatever the target is called.
                  ui: { executor: '@nx/vite:dev-server', options: {} },
                  // Depends on tail: the readiness note is tail's alone (602).
                  e2e: {
                    executor: 'nx:run-commands',
                    options: { command: 'cypress' },
                    dependsOn: ['tail'],
                  },
                  preview: { executor: '@nx/vite:preview-server', options: {} },
                  // Nx's own word on a shell wrapper.
                  tail: {
                    executor: 'nx:run-commands',
                    options: { command: 'tail -f log' },
                    continuous: true,
                  },
                  // A serve-like name on a shell wrapper says nothing.
                  serve: { executor: 'nx:run-commands', options: { commands: ['node server.js'] } },
                  // …nor on an executor that IS known and is not a server.
                  watch: { executor: '@nx/vite:build', options: {} },
                  build: { executor: '@nx/js:tsc', options: {} },
                },
              },
            },
          },
          dependencies: { app: [] },
        }),
      )
      const r = await vx(root, ['--from', 'nx'])
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
      const tasks = (await loadProjectConfig(path.join(root, 'packages', 'app', 'vx.config.ts')))
        .tasks!
      const persistent = Object.keys(tasks)
        .filter((t) => tasks[t]!.exec?.persistent !== undefined)
        .sort()
      expect(persistent).toEqual(['preview', 'tail', 'ui'])
      expect(tasks['ui']!.exec?.persistent).toEqual({})
      expect(r.out).toContain('app#tail: persistent task')
      expect(r.out).not.toContain('app#serve: persistent task')
      expect(r.out).not.toContain('app#ui: persistent task')
      expect(r.out).not.toContain('app#preview: persistent task')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ─── Item 817's sweep: each row fails with one line of the writer undone ──

describe('the writer: what the sweep found unheld', () => {
  const USAGE = 'usage: vx-migrate [--from turbo|nx] [--dry] [--force] [--mjs]'

  it('parseMigrateArgs: --from=<source>, --help, and an unknown flag by name', () => {
    expect(parseMigrateArgs(['--from=nx'])).toEqual({
      dry: false,
      force: false,
      mjs: false,
      from: 'nx',
    })
    expect(parseMigrateArgs(['--help']).error).toBe(USAGE)
    expect(parseMigrateArgs(['-h']).error).toBe(USAGE)
    expect(parseMigrateArgs(['--nope']).error).toBe(`unknown flag: --nope\n${USAGE}`)
  })

  const detect = async (files: Record<string, string>, args: string[]) => {
    const root = await makeRoot('vx-migrate-det-sweep-')
    try {
      for (const [rel, text] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
        await writeFile(path.join(root, rel), text)
      }
      return await vx(root, args)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  it(
    'turbo.json beside a bare nx.json, or beside a graph with no nx.json, asks for --from',
    async () => {
      const both =
        'vx-migrate: both turbo.json and an nx workspace are present — pass --from turbo or --from nx\n'
      const turbo = { 'turbo.json': '{"tasks":{}}' }
      const bare = await detect({ ...turbo, 'nx.json': '{}' }, [])
      expect([bare.code, bare.err]).toEqual([1, both])
      const graph = await detect({ ...turbo, '.nx/workspace-data/project-graph.json': '{}' }, [])
      expect([graph.code, graph.err]).toEqual([1, both])
    },
    TIMEOUT,
  )

  it(
    '--from turbo with no turbo.json, and --from nx with no Nx at all, say which is missing',
    async () => {
      const turbo = await detect({}, ['--from', 'turbo'])
      expect([turbo.code, turbo.err]).toEqual([
        1,
        'vx-migrate: --from turbo, but no turbo.json at the workspace root\n',
      ])
      const nx = await detect({}, ['--from', 'nx'])
      expect(nx.code).toBe(1)
      expect(nx.err).toStartWith('vx-migrate: no resolved Nx graph found — export one with')
    },
    TIMEOUT,
  )

  it(
    'an argument error is said on stderr',
    async () => {
      const r = await detect({}, ['--nope'])
      expect([r.code, r.err]).toEqual([1, `vx-migrate: unknown flag: --nope\n${USAGE}\n`])
    },
    TIMEOUT,
  )
})

describe('the preset, exactly', () => {
  async function preset(turboJson: Record<string, unknown>) {
    const root = await makeRoot('vx-migrate-preset-sweep-')
    try {
      await writeFile(path.join(root, 'turbo.json'), JSON.stringify(turboJson))
      const dir = await addPackage(root, 'a', { build: 'tsc' })
      const packageJson = { name: 'a', scripts: { build: 'tsc' } }
      const meta = { name: 'a', dir, packageJson: packageJson as never, configPath: null }
      return await migrateTurbo(root, [meta], 'ts')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  it('a preset of globalEnv alone is written with its one section, ending in a newline', async () => {
    const plan = await preset({ globalEnv: ['MODE'], tasks: { build: {} } })
    expect(plan.extraFiles).toEqual([
      {
        relPath: 'vx-preset.ts',
        contents: [
          '// Generated by `vx-migrate` from turbo.json. TypeScript composition',
          "// replaces turbo's global fields: each vx.config.ts imports these",
          '// arrays and spreads them into the matching task fields.',
          '',
          '// From globalEnv: cache inputs AND passed through to every task',
          '// (vx child environments are isolated; see docs/schema.md).',
          "export const globalEnvInputs = ['MODE']",
          '',
        ].join('\n'),
      },
    ])
  })

  it('a preset of globalPassThroughEnv alone is written with its one section', async () => {
    const plan = await preset({ globalPassThroughEnv: ['AWS'], tasks: { build: {} } })
    expect(plan.extraFiles.map((f) => f.contents.split('\n').slice(3))).toEqual([
      [
        '',
        '// From globalPassThroughEnv: forwarded to every task, never hashed.',
        "export const globalPassThroughEnv = ['AWS']",
        '',
      ],
    ])
  })

  it('a config imports the preset names it uses, sorted', async () => {
    const plan = await preset({
      globalDependencies: ['x.json'],
      globalEnv: ['MODE'],
      globalPassThroughEnv: ['AWS'],
      tasks: { build: {} },
    })
    expect(plan.projects.map((p) => p.importLines)).toEqual([
      ["import { globalEnvInputs, globalInputs, globalPassThroughEnv } from '../../vx-preset.ts'"],
    ])
  })
})
