// Hand-written Nx graphs in the shapes real repos have (plugin-
// inferred targets, explicit executors, continuous and atomized targets
// with a root project, per-project named inputs and filesets, run-commands
// variants, configurations with run-script, every input kind, token
// interpolation, an integrated repo of `project.json` projects, the
// TypeScript plugin, @nx/jest atomized per spec), migrated
// through the CLI. Every config it writes must load and plan: a written config vx
// refuses (an output outside the workspace, P2-11) fails the whole repo.

import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { type Logger, listProjectMetas, loadProjectConfig, loadWorkspace, planRun } from '@vzn/vx'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const CORE_PKG = path.resolve(import.meta.dir, '..', '..', 'vx')
const FIXTURES = path.join(import.meta.dir, 'fixtures', 'nx-shapes')
const silent: Logger = {
  status: () => undefined,
  taskStdout: () => undefined,
  taskStderr: () => undefined,
  taskComplete: () => undefined,
}

interface Node {
  name: string
  data: { root: string }
}

async function migrate(shape: string): Promise<{
  code: number
  out: string
  tasks: Record<string, string[]>
  configs: Record<string, Record<string, Record<string, unknown>>>
  /** Each written config's `tags`. */
  tags: Record<string, readonly string[] | undefined>
  /** Unlisted shapes: the projects core finds once the note's globs are added. */
  discovered?: string[]
}> {
  const graph = (await Bun.file(path.join(FIXTURES, `${shape}.json`)).json()) as {
    graph: { nodes: Record<string, Node> }
    scripts?: Record<string, Record<string, string>>
    /** Nodes with a `project.json` only: no package.json, in no workspace glob. */
    unlisted?: string[]
    /** Fields merged into a project's package.json (its workspace dependencies). */
    manifests?: Record<string, Record<string, unknown>>
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-nx-shape-'))
  try {
    const roots = Object.values(graph.graph.nodes).map((n) => [n.name, n.data.root] as const)
    const unlisted = new Set(graph.unlisted ?? [])
    const members = roots.filter(([, r]) => r !== '.')
    const manifest = (workspaces: readonly string[]) =>
      JSON.stringify({
        name: roots.find(([, r]) => r === '.')?.[0] ?? 'root',
        private: true,
        workspaces,
      })
    await writeFile(
      path.join(root, 'package.json'),
      manifest(members.filter(([n]) => !unlisted.has(n)).map(([, r]) => r)),
    )
    for (const [name, rel] of members) {
      await mkdir(path.join(root, rel, 'src'), { recursive: true })
      if (unlisted.has(name)) {
        await writeFile(path.join(root, rel, 'project.json'), JSON.stringify({ name }))
        continue
      }
      await writeFile(
        path.join(root, rel, 'package.json'),
        JSON.stringify({
          name,
          version: '1.0.0',
          scripts: graph.scripts?.[name],
          ...graph.manifests?.[name],
        }),
      )
      await writeFile(path.join(root, rel, 'src', 'index.ts'), 'export {}\n')
    }
    await cp(path.join(FIXTURES, `${shape}.nx.json`), path.join(root, 'nx.json'))
    await mkdir(path.join(root, '.nx', 'workspace-data'), { recursive: true })
    await cp(
      path.join(FIXTURES, `${shape}.json`),
      path.join(root, '.nx', 'workspace-data', 'project-graph.json'),
    )
    await mkdir(path.join(root, 'node_modules', '@vzn'), { recursive: true })
    await symlink(CORE_PKG, path.join(root, 'node_modules', '@vzn', 'vx'), 'dir')
    const proc = Bun.spawn([process.execPath, BIN, '--from', 'nx'], {
      cwd: root,
      env: { ...process.env, NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    const tasks: Record<string, string[]> = {}
    const configs: Record<string, Record<string, Record<string, unknown>>> = {}
    const tags: Record<string, readonly string[] | undefined> = {}
    for (const [name, rel] of roots) {
      const file = path.join(root, rel, 'vx.config.ts')
      if (!(await Bun.file(file).exists())) continue
      const config = await loadProjectConfig(file)
      const loaded = (config.tasks ?? {}) as Record<string, Record<string, unknown>>
      tags[name] = config.tags
      tasks[name] = Object.keys(loaded).sort()
      configs[name] = loaded
    }
    let discovered: string[] | undefined
    if (unlisted.size > 0) {
      // Follow the note: list every member, as it says to.
      await writeFile(path.join(root, 'package.json'), manifest(members.map(([, r]) => r)))
      discovered = (await listProjectMetas(await loadWorkspace(root))).map((m) => m.name).sort()
    }
    // Every written task plans: a config that loads can still be refused
    // when core builds the graph (a cycle, P2-22; a dropped key, P2-23).
    await writeFile(path.join(root, '.gitignore'), 'node_modules\n')
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
    const ids = Object.entries(tasks).flatMap(([p, ts]) => ts.map((t) => `${p}#${t}`))
    if (ids.length > 0) {
      const plan = await planRun({ cwd: root, tasks: ids, log: silent })
      if ((plan.unresolvedTasks ?? []).length > 0)
        throw new Error(`unresolved: ${plan.unresolvedTasks!.join(', ')}`)
    }
    return { code, out, tasks, configs, tags, ...(discovered === undefined ? {} : { discovered }) }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('vx-migrate on the Nx shapes real repos have: every written config loads', () => {
  it('plugin-inferred targets (vite, jest, eslint, typescript, watch-deps)', async () => {
    const r = await migrate('inferred-plugins')
    expect(r.code).toBe(0)
    expect(r.tasks).toEqual({
      '@fx/web': [
        'build',
        'build-deps',
        'dev',
        'lint',
        'preview',
        'serve',
        'serve-static',
        'test',
        'typecheck',
        'watch-deps',
      ],
      '@fx/ui': ['build', 'nx-input:default', 'nx-input:production', 'test', 'typecheck'],
    })
  }, 30_000)

  it('explicit executors (esbuild, js:node, jest, eslint, tsc, vite:test, swc, release-publish)', async () => {
    const r = await migrate('explicit-executors')
    expect(r.code).toBe(0)
    expect(r.tasks).toEqual({
      api: ['build', 'build:development', 'deploy', 'lint', 'serve', 'test', 'test:ci'],
      util: ['build', 'nx-input:default', 'nx-input:production', 'test'],
      data: ['build', 'nx-input:default', 'nx-input:production'],
    })
    expect(r.out).toContain('outside the workspace — vx caches only inside it; dropped')
    // Each Nx project's tags are written as its vx `tags`.
    expect(r.tags).toEqual({ api: ['type:app'], util: ['type:lib'], data: ['type:lib'] })
  }, 30_000)

  it('continuous serve, atomized e2e and a root project', async () => {
    const r = await migrate('continuous-atomized-root')
    expect(r.code).toBe(0)
    expect(r.tasks).toEqual({
      'fx3-root': ['codegen', 'format'],
      shop: ['build', 'db-migrate', 'nx-input:default', 'nx-input:production', 'serve'],
      'shop-e2e': ['e2e', 'e2e-ci', 'e2e-ci--src/a.cy.ts', 'e2e-ci--src/b.cy.ts'],
      db: ['build', 'nx-input:default', 'nx-input:production'],
    })
  }, 30_000)

  it('per-project named inputs, dependency filesets, negated outputs', async () => {
    const r = await migrate('named-inputs-filesets')
    expect(r.code).toBe(0)
    expect(r.tasks).toEqual({
      a: ['build', 'build:development', 'build:production', 'bundle-report', 'dts', 'typecheck'],
      b: ['build', 'dts', 'nx-input:fileset-ff180853eab36048', 'nx-input:production'],
      c: ['build', 'nx-input:production'],
    })
  }, 30_000)

  it('run-commands variants: forwardAllArgs, args, {args.x}, envFile, readyWhen list, target globs, tag projects', async () => {
    const r = await migrate('run-commands-variants')
    expect(r.code).toBe(0)
    expect(r.tasks).toEqual({
      core: ['build', 'build-cjs', 'build-esm', 'nx-input:default'],
      cli: ['build', 'dev', 'release'],
    })
  }, 30_000)

  it('configurations, options interpolation in outputs, run-script, implicit dependencies', async () => {
    const r = await migrate('configurations-scripts')
    expect(r.code).toBe(0)
    expect(r.tasks).toEqual({
      web: ['build', 'build:development', 'lint', 'test'],
      api: ['build', 'deploy', 'deploy:staging'],
      shared: ['build', 'nx-input:default', 'nx-input:production'],
    })
    const outputs = (t: Record<string, unknown>) => t['cache'] as { outputs: unknown }
    expect(outputs(r.configs['web']!['build']!).outputs).toEqual({
      files: [],
      workspaceFiles: ['dist/apps/web'],
    })
    expect(outputs(r.configs['web']!['build:development']!).outputs).toEqual({
      files: [],
      workspaceFiles: ['dist/apps/web-dev'],
    })
    // An implicit dependency is a dependency: `^build` reaches it.
    expect(r.configs['api']!['build']!['dependsOn']).toEqual([
      '^build',
      'shared#nx-input:default',
      'shared#build',
    ])
    expect(r.configs['web']!['test']!['dependsOn']).toEqual(['build', 'shared#nx-input:default'])
    // nx:run-script is the script's own line.
    expect((r.configs['web']!['test']!['exec'] as { command: string }).command).toBe('bun test')
    expect((r.configs['api']!['build']!['exec'] as { command: string }).command).toBe('tsc')
  }, 30_000)

  it('input kinds: runtime, workspace filesets, another project’s named input, projects "*"', async () => {
    const r = await migrate('input-kinds')
    expect(r.code).toBe(0)
    expect(r.tasks).toEqual({
      app: ['build', 'e2e', 'typecheck'],
      util: ['build', 'nx-input:default', 'nx-input:production'],
      docs: ['lint'],
    })
    const build = r.configs['app']!['build']!
    expect((build['cache'] as { inputs: unknown }).inputs).toEqual({
      files: ['**/*'],
      workspaceFiles: ['.github/workflows/ci.yml', 'tsconfig.base.json'],
      workspaceRuntime: ['node -v'],
    })
    expect(build['dependsOn']).toEqual(['^build', 'util#nx-input:production', 'util#build'])
    expect(r.configs['app']!['typecheck']!['dependsOn']).toEqual([
      '^build',
      'util#nx-input:default',
      'util#build',
    ])
    expect(r.configs['app']!['e2e']!['dependsOn']).toEqual(['app#build', 'util#build'])
    expect(r.out).toContain('input {externalDependencies: ["vite"]}')
  }, 30_000)

  it('{projectRoot} and {projectName} in commands and outputs, params ignore, a script calling nx', async () => {
    const r = await migrate('interpolation')
    expect(r.code).toBe(0)
    expect(r.tasks).toEqual({ lib: ['build', 'docs', 'size'] })
    const lib = r.configs['lib']!
    expect((lib['build']!['cache'] as { outputs: unknown }).outputs).toEqual({
      files: ['dist'],
      workspaceFiles: ['coverage/libs/lib'],
    })
    expect((lib['docs']!['exec'] as { command: string }).command).toBe(
      'cd ../.. && typedoc --out dist/docs/lib libs/lib/src/index.ts',
    )
    expect(lib['docs']!['dependsOn']).toEqual(['build'])
    expect((lib['size']!['exec'] as { command: string }).command).toBe('size-limit')
    expect(r.out).toContain('the command runs `nx run-many`, which needs Nx installed')
  }, 30_000)

  it('an integrated repo: project.json projects in no workspace glob, a root project', async () => {
    const r = await migrate('integrated')
    expect(r.code).toBe(0)
    expect(r.tasks).toEqual({
      acme: ['format'],
      shop: ['build', 'test'],
      feature: ['build', 'lint', 'nx-input:default'],
      '@acme/util': ['build', 'nx-input:default'],
    })
    expect(r.out).toContain(
      '2 Nx projects are in no workspace glob (a package.json is written where there was none) — vx finds a project by a package.json the workspace lists: add "apps/shop", "libs/feature" to package.json `workspaces`',
    )
    // The written package.json files make them projects once listed.
    expect(r.discovered).toEqual(['@acme/util', 'acme', 'feature', 'shop'])
  }, 30_000)

  it('a manifest cycle Nx breaks with `!a`, and a configuration named like another target', async () => {
    const r = await migrate('cycle-break-colon-targets')
    expect(r.code).toBe(0)
    expect(r.tasks).toEqual({
      a: ['e2e', 'e2e:build', 'vite', 'vite:build'],
      b: ['nx-input:default', 'vite:build'],
    })
    expect((r.configs['a']!['vite:build']!['exec'] as { command: string }).command).toBe(
      'vite build',
    )
    expect(r.configs['b']!['vite:build']!['dependsOn']).toBeUndefined()
  }, 30_000)

  it('the TypeScript plugin as Nx 23 infers it: include globs, a d.ts fileset, a {,.map} output', async () => {
    const r = await migrate('ts-solution')
    expect(r.code).toBe(0)
    expect(r.tasks).toEqual({
      '@ts/util': [
        'build',
        'build-deps',
        'nx-input:fileset-51a93ecf583099a0',
        'typecheck',
        'watch-deps',
      ],
      '@ts/core': ['build', 'build-deps', 'typecheck', 'watch-deps'],
    })
    const build = r.configs['@ts/core']!['build']!
    expect(build['cache']).toEqual({
      inputs: {
        files: [
          'package.json',
          'tsconfig.json',
          'tsconfig.lib.json',
          'src/**/*.ts',
          '!out-tsc/**/*',
          '!dist/**/*',
        ],
        workspaceFiles: ['tsconfig.base.json'],
      },
      outputs: {
        files: [
          'dist/**/*.{js,cjs,mjs,jsx,d.ts,d.cts,d.mts}{,.map}',
          'dist/tsconfig.lib.tsbuildinfo',
        ],
      },
    })
    // Nx's `build-deps` carries no executor: Nx normalizes it to a group (P2-31).
    expect(r.configs['@ts/core']!['build-deps']).toEqual({ dependsOn: ['^build'] })
  }, 30_000)
  it('@nx/jest atomized: a preset input, coverage outside the project, test-ci per spec', async () => {
    const r = await migrate('jest-atomized')
    expect(r.code).toBe(0)
    expect(r.tasks).toEqual({
      '@ja/auth': [
        'test',
        'test-ci',
        'test-ci--src/lib/login.spec.ts',
        'test-ci--src/lib/token.spec.ts',
      ],
      '@ja/ui': ['nx-input:production', 'test'],
    })
    const auth = r.configs['@ja/auth']!
    expect(auth['test']!['cache']).toEqual({
      inputs: { files: ['**/*'], workspaceFiles: ['jest.preset.js'] },
      outputs: { files: [], workspaceFiles: ['coverage/libs/auth'] },
    })
    expect(auth['test-ci']).toEqual({
      dependsOn: ['test-ci--src/lib/login.spec.ts', 'test-ci--src/lib/token.spec.ts'],
    })
    // Each spec shares `test`'s coverage dir: uncached, with the TODO that says why.
    const spec = auth['test-ci--src/lib/login.spec.ts']!
    expect((spec['exec'] as { command: string }).command).toBe('jest src/lib/login.spec.ts')
    expect(spec['cache']).toBeUndefined()
    expect(r.out).toContain(
      'declares the workspace output "coverage/libs/auth" that @ja/auth#test also declares',
    )
  }, 30_000)
})
