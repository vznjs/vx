// Eight hand-written Nx graphs in the shapes real repos have (plugin-
// inferred targets, explicit executors, continuous and atomized targets
// with a root project, per-project named inputs and filesets, run-commands
// variants, configurations with run-script, every input kind, token
// interpolation), migrated
// through the CLI. Every config it writes must load: a written config vx
// refuses (an output outside the workspace, P2-11) fails the whole repo.

import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { loadProjectConfig } from '@vzn/vx'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const CORE_PKG = path.resolve(import.meta.dir, '..', '..', 'vx')
const FIXTURES = path.join(import.meta.dir, 'fixtures', 'nx-shapes')

interface Node {
  name: string
  data: { root: string }
}

async function migrate(shape: string): Promise<{
  code: number
  out: string
  tasks: Record<string, string[]>
  configs: Record<string, Record<string, Record<string, unknown>>>
}> {
  const graph = (await Bun.file(path.join(FIXTURES, `${shape}.json`)).json()) as {
    graph: { nodes: Record<string, Node> }
    scripts?: Record<string, Record<string, string>>
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-nx-shape-'))
  try {
    const roots = Object.values(graph.graph.nodes).map((n) => [n.name, n.data.root] as const)
    const members = roots.filter(([, r]) => r !== '.')
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: roots.find(([, r]) => r === '.')?.[0] ?? 'root',
        private: true,
        workspaces: members.map(([, r]) => r),
      }),
    )
    for (const [name, rel] of members) {
      await mkdir(path.join(root, rel, 'src'), { recursive: true })
      await writeFile(
        path.join(root, rel, 'package.json'),
        JSON.stringify({ name, version: '1.0.0', scripts: graph.scripts?.[name] }),
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
    for (const [name, rel] of roots) {
      const file = path.join(root, rel, 'vx.config.ts')
      if (!(await Bun.file(file).exists())) continue
      const loaded = ((await loadProjectConfig(file)).tasks ?? {}) as Record<
        string,
        Record<string, unknown>
      >
      tasks[name] = Object.keys(loaded).sort()
      configs[name] = loaded
    }
    return { code, out, tasks, configs }
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
        'lint',
        'preview',
        'serve',
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
})
