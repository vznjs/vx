// The sweep of nx/nx-upstream.ts (G-9): each row fails with one line of
// the `^` input folding undone. What a twin keys on is a key fact: a
// dependency's env, runtime or nested input left out of it is a hit
// after that input changed.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { GeneratedTask, ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-upstream-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/**
 * `app` (a cached `test` reading `inputs`) → `lib` → `base`; `lib`'s
 * named inputs as given. `discovered` are the projects vx knows; any other
 * node is walked through.
 */
async function graph(opts: {
  inputs: unknown[]
  libNamed?: Record<string, unknown[]>
  edges?: Record<string, string[]>
  discovered?: string[]
}): Promise<Map<string, GeneratedTask>> {
  await writeFile(
    path.join(root, 'nx.json'),
    JSON.stringify({ namedInputs: { production: ['default'] } }),
  )
  const metas: ProjectMeta[] = []
  for (const n of opts.discovered ?? ['app', 'lib', 'base']) {
    const dir = path.join(root, 'packages', n)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: n }))
    metas.push({ name: n, dir, packageJson: { name: n } as never, configPath: null })
  }
  const edges = opts.edges ?? { app: ['lib'], lib: ['base'] }
  const m = await mapNxWorkspace(
    root,
    metas,
    {
      nodes: {
        app: {
          data: {
            root: 'packages/app',
            targets: { test: { command: 'true', cache: true, inputs: opts.inputs } },
          },
        },
        lib: {
          data: {
            root: 'packages/lib',
            ...(opts.libNamed === undefined ? {} : { namedInputs: opts.libNamed }),
          },
        },
        base: { data: { root: 'packages/base' } },
      },
      dependencies: Object.fromEntries(
        Object.entries(edges).map(([s, ts]) => [s, ts.map((t) => ({ source: s, target: t }))]),
      ),
    } as NxGraph,
    { persistentTodo: 'PERSIST', cacheable: new Set() },
  )
  return new Map(m.projects.flatMap((p) => p.tasks.map((t) => [`${p.name}#${t.name}`, t])))
}

const inputsOf = (t: GeneratedTask | undefined) =>
  (t?.task?.['cache'] as { inputs: unknown } | undefined)?.inputs
const depsOf = (t: GeneratedTask | undefined) => t?.task?.['dependsOn']

describe('nx-upstream: what the sweep found unheld', () => {
  const libNamed = {
    production: ['{projectRoot}/src/**', { env: 'LIB_MODE' }, { runtime: 'node -v' }],
  }

  it('a dependency’s env and runtime inputs key its twin', async () => {
    const t = await graph({ inputs: ['^production'], libNamed })
    expect(inputsOf(t.get('lib#nx-input:production'))).toEqual({
      files: ['src/**'],
      env: ['LIB_MODE'],
      workspaceRuntime: ['node -v'],
    })
  })

  it('a walked-through node’s env and runtime join the reader', async () => {
    const t = await graph({ inputs: ['^production'], libNamed, discovered: ['app', 'base'] })
    expect(inputsOf(t.get('app#test'))).toEqual({
      files: [],
      workspaceFiles: ['packages/lib/src/**'],
      env: ['LIB_MODE'],
      workspaceRuntime: ['node -v'],
    })
    expect(depsOf(t.get('app#test'))).toEqual(['base#nx-input:production'])
  })

  // `lib`'s production reads its own dependencies' `shared`: the twin
  // folds that closure too, and a node walked through carries it on.
  it('a nested `^other` in a dependency’s named input folds on from it', async () => {
    const nested = { production: ['{projectRoot}/src/**', '^shared'], shared: ['{projectRoot}/x'] }
    const t = await graph({ inputs: ['^production'], libNamed: nested })
    expect(depsOf(t.get('lib#nx-input:production'))).toEqual([
      'base#nx-input:production',
      'base#nx-input:shared',
    ])
    const through = await graph({
      inputs: ['^production'],
      libNamed: nested,
      discovered: ['app', 'base'],
    })
    expect(depsOf(through.get('app#test'))).toEqual([
      'base#nx-input:production',
      'base#nx-input:shared',
    ])
  })

  it('a self edge in the Nx graph is no dependency', async () => {
    const t = await graph({ inputs: ['^production'], edges: { app: ['app', 'lib'], lib: [] } })
    expect(depsOf(t.get('app#test'))).toEqual(['lib#nx-input:production'])
    expect(depsOf(t.get('app#nx-input:production'))).toEqual(['lib#nx-input:production'])
  })

  it('`{input, projects}` naming a node with no vx project folds its files in', async () => {
    const t = await graph({
      inputs: [{ input: 'production', projects: ['lib'] }],
      discovered: ['app', 'base'],
    })
    expect(inputsOf(t.get('app#test'))).toEqual({
      files: [],
      workspaceFiles: ['packages/lib/**/*'],
    })
  })

  it('`^{workspaceRoot}/…` is a dependency fileset too', async () => {
    const fileset = '{workspaceRoot}/tools/gen.ts'
    const t = await graph({ inputs: [`^${fileset}`] })
    const id = `nx-input:fileset-${Bun.hash.xxHash3(fileset).toString(16).padStart(16, '0')}`
    expect(depsOf(t.get('app#test'))).toEqual([`lib#${id}`])
    expect(t.get('app#test')?.todos).toEqual([])
  })
})
