// Four hand-written Nx graphs in the shapes real repos have (plugin-
// inferred targets, explicit executors, continuous and atomized targets
// with a root project, per-project named inputs and filesets), migrated
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

async function migrate(
  shape: string,
): Promise<{ code: number; out: string; tasks: Record<string, string[]> }> {
  const graph = (await Bun.file(path.join(FIXTURES, `${shape}.json`)).json()) as {
    graph: { nodes: Record<string, Node> }
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
        JSON.stringify({ name, version: '1.0.0' }),
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
    for (const [name, rel] of roots) {
      const file = path.join(root, rel, 'vx.config.ts')
      if (!(await Bun.file(file).exists())) continue
      tasks[name] = Object.keys((await loadProjectConfig(file)).tasks ?? {}).sort()
    }
    return { code, out, tasks }
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
})
