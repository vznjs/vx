// The `discover` stage: a plugin names directories that become projects
// beyond the package manager's members (turbo()'s root for `//#task`), and
// gives any project edges as directories: `deps` (order and reach) and
// `reach` (reach only).
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { discoverProjects, type VxPlugin } from '../src/orchestrator/index.js'
import {
  applyFilters,
  buildPackageGraph,
  parseFilter,
  type ProjectMeta,
  type Workspace,
} from '../src/workspace/index.js'

let root: string
let workspace: Workspace
const warn = (): void => {}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-discover-')))
  workspace = { root, packageGlobs: ['packages/*'] }
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws' }))
  await mkdir(path.join(root, 'packages', 'a'), { recursive: true })
  await writeFile(path.join(root, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a' }))
  await mkdir(path.join(root, 'tools', 'gen'), { recursive: true })
})
afterEach(() => rm(root, { recursive: true, force: true }))

const plugin = (name: string, discover: VxPlugin['discover']): VxPlugin =>
  ({ name, discover }) as VxPlugin

const names = async (plugins: VxPlugin[]): Promise<string[]> =>
  (await discoverProjects(workspace, plugins, root, warn)).map(
    (p) => `${p.name}@${path.relative(root, p.dir) || '.'}`,
  )

describe('discover stage', () => {
  it('CONTROL: without the stage, only the members', async () => {
    expect(await names([])).toEqual(['a@packages/a'])
  })

  it('a named root and a manifest-less directory become projects, sorted by name', async () => {
    const seen: string[][] = []
    const p1 = plugin('p1', () => [{ dir: '.', name: 'ws' }])
    const p2 = plugin('p2', (ctx) => {
      seen.push(ctx.projects.map((m) => m.name))
      return [{ dir: path.join(root, 'tools', 'gen'), name: 'gen' }]
    })
    expect(await names([p1, p2])).toEqual(['a@packages/a', 'gen@tools/gen', 'ws@.'])
    expect(seen).toEqual([['a', 'ws']])
  })

  it("a nameless package.json takes the plugin's name; the stage sees the cache dir", async () => {
    await writeFile(
      path.join(root, 'tools', 'gen', 'package.json'),
      JSON.stringify({ private: true }),
    )
    const dirs: string[] = []
    const p = plugin('p', (ctx) => {
      dirs.push(ctx.cacheDir)
      return [{ dir: 'tools/gen', name: 'gen' }]
    })
    expect(await names([p])).toEqual(['a@packages/a', 'gen@tools/gen'])
    expect(dirs).toEqual([root])
  })

  it('a directory already found under the same name is a no-op', async () => {
    expect(await names([plugin('p', () => [{ dir: 'packages/a', name: 'a' }])])).toEqual([
      'a@packages/a',
    ])
  })

  const edgesOf = (projects: readonly ProjectMeta[]): Record<string, unknown> =>
    Object.fromEntries(
      projects
        .filter((p) => p.deps !== undefined || p.reach !== undefined)
        .map((p) => [p.name, { deps: p.deps, reach: p.reach }]),
    )

  it('deps and reach name existing projects by directory; plugins union', async () => {
    await mkdir(path.join(root, 'packages', 'b'), { recursive: true })
    await writeFile(path.join(root, 'packages', 'b', 'package.json'), JSON.stringify({ name: 'b' }))
    const p1 = plugin('p1', () => [
      { dir: 'packages/a', deps: ['packages/b'] },
      { dir: path.join(root, 'tools', 'gen'), name: 'gen', reach: ['packages/a'] },
    ])
    const p2 = plugin('p2', () => [
      { dir: 'packages/a', name: 'a', deps: ['tools/gen', 'packages/b'], reach: ['packages/b'] },
    ])
    const projects = await discoverProjects(workspace, [p1, p2], root, warn)
    expect(edgesOf(projects)).toEqual({
      a: { deps: ['b', 'gen'], reach: ['b'] },
      gen: { deps: undefined, reach: ['a'] },
    })
  })

  it('CONTROL: no deps or reach leaves every project edgeless', async () => {
    const projects = await discoverProjects(
      workspace,
      [plugin('p', () => [{ dir: 'packages/a', name: 'a' }])],
      root,
      warn,
    )
    expect(edgesOf(projects)).toEqual({})
  })

  it('deps order and reach; reach only reaches (--filter, --affected)', async () => {
    await mkdir(path.join(root, 'packages', 'lib'), { recursive: true })
    await writeFile(
      path.join(root, 'packages', 'lib', 'package.json'),
      JSON.stringify({ name: 'lib' }),
    )
    const projects = await discoverProjects(
      workspace,
      [
        plugin('p', () => [
          { dir: 'packages/a', reach: ['packages/lib'] },
          { dir: 'tools/gen', name: 'gen', deps: ['packages/lib'] },
        ]),
      ],
      root,
      warn,
    )
    const graph = buildPackageGraph(projects)
    expect(graph.directDeps('gen')).toEqual(['lib'])
    expect(graph.directDeps('a')).toEqual([])
    expect(graph.transitiveDeps('a')).toEqual(['lib'])
    expect(graph.transitiveDependents('lib')).toEqual(['a', 'gen'])
    const selected = (filter: string): string[] =>
      [...applyFilters({ filters: [parseFilter(filter, root)], projects, graph })].sort()
    expect(selected('a...')).toEqual(['a', 'lib'])
    expect(selected('...lib')).toEqual(['a', 'gen', 'lib'])
  })

  const refusals: Array<[string, VxPlugin['discover'], string]> = [
    ['outside the root', () => [{ dir: '..', name: 'x' }], 'outside the workspace root'],
    ['a taken name', () => [{ dir: 'tools/gen', name: 'a' }], 'the name is taken by packages/a'],
    [
      'a project under another name',
      () => [{ dir: 'packages/a', name: 'b' }],
      'already the project "a"',
    ],
    [
      'a manifest of another name',
      () => [{ dir: '.', name: 'root' }],
      'its package.json names it "ws"',
    ],
    ['no such directory', () => [{ dir: 'nope', name: 'n' }], 'no such directory'],
    // No manifest in tools/gen: the plugin's name is the only one.
    [
      'a padded name',
      () => [{ dir: 'tools/gen', name: ' gen' }],
      '" gen": the name has surrounding whitespace',
    ],
    [
      'a name with "#"',
      () => [{ dir: 'tools/gen', name: 'g#en' }],
      '"g#en": the name holds "#" — vx addresses a task as <name>#<task>',
    ],
    [
      'a malformed entry',
      () => [{ dir: 1 } as never],
      'expected { dir: string, name?: string, deps?: string[], reach?: string[] }',
    ],
    [
      'malformed deps',
      () => [{ dir: 'packages/a', deps: 'packages/b' } as never],
      'expected { dir: string, name?: string, deps?: string[], reach?: string[] }',
    ],
    [
      'a nameless directory that is not a project',
      () => [{ dir: 'tools/gen' }],
      'project at tools/gen: not a project yet — give it a name',
    ],
    [
      'a dep on a directory that is no project',
      () => [{ dir: 'packages/a', deps: ['tools/gen'] }],
      'gave project "a" an edge to tools/gen: not a project',
    ],
    [
      'a reach outside the root',
      () => [{ dir: 'packages/a', reach: ['..'] }],
      'gave project "a" an edge to ..: outside the workspace root',
    ],
    [
      'a conflicting rename of a project an earlier entry named',
      () => [
        { dir: 'tools/gen', name: 'gen' },
        { dir: 'tools/gen', name: 'generator', deps: ['packages/a'] },
      ],
      'already the project "gen"',
    ],
    ['not an array', () => ({}) as never, 'failed in discover: expected an array, got an object'],
  ]
  for (const [what, discover, message] of refusals) {
    it(`refuses ${what}, naming the plugin`, async () => {
      const err = await discoverProjects(workspace, [plugin('p', discover)], root, warn).then(
        () => null,
        (e: unknown) => e as Error,
      )
      expect(err?.message).toContain("plugin 'p'")
      expect(err?.message).toContain(message)
    })
  }
})
