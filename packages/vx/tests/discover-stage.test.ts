// The `discover` stage: a plugin names directories that become projects
// beyond the locked ones (turbo()'s root for `//#task`), names a project its
// path names, and gives any project edges as directories: `deps` (order and
// reach) and `reach` (reach only).
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { discoverProjects, type VxPlugin } from '../src/orchestrator/index.js'
import type { ProjectConfig } from '../src/config.js'
import {
  applyFilters,
  buildPackageGraph,
  type Lockfile,
  parseFilter,
  type ProjectMeta,
} from '../src/workspace/index.js'

let root: string
const warn = (): void => {}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-discover-')))
  await mkdir(path.join(root, 'packages', 'a'), { recursive: true })
  await mkdir(path.join(root, 'tools', 'gen'), { recursive: true })
})
afterEach(() => rm(root, { recursive: true, force: true }))

const plugin = (name: string, discover: VxPlugin['discover']): VxPlugin =>
  ({ name, discover }) as VxPlugin

/** A lock holding `packages/a` and the `extra` directories, each config `{}` unless given. */
const lockOf =
  (extra: Record<string, ProjectConfig> = {}) =>
  async (): Promise<Lockfile> => ({
    version: 4,
    projects: Object.fromEntries(
      Object.entries({ 'packages/a': {}, ...extra }).map(([d, config]) => [
        d,
        { file: 'vx.config.mjs', config },
      ]),
    ),
  })

const discover = (plugins: VxPlugin[], extra?: Record<string, ProjectConfig>) =>
  discoverProjects(root, lockOf(extra), plugins, root, warn)

const names = async (plugins: VxPlugin[], extra?: Record<string, ProjectConfig>) =>
  (await discover(plugins, extra)).map((p) => `${p.name}@${path.relative(root, p.dir) || '.'}`)

describe('discover stage', () => {
  it('CONTROL: without the stage, the locked directories, named by path', async () => {
    expect(await names([])).toEqual(['packages/a@packages/a'])
  })

  it('a named root and a new directory become projects, sorted by name', async () => {
    const seen: string[][] = []
    const p1 = plugin('p1', () => [{ dir: '.', name: 'ws' }])
    const p2 = plugin('p2', (ctx) => {
      seen.push(ctx.projects.map((m) => m.name))
      return [{ dir: path.join(root, 'tools', 'gen'), name: 'gen' }]
    })
    expect(await names([p1, p2])).toEqual(['gen@tools/gen', 'packages/a@packages/a', 'ws@.'])
    expect(seen).toEqual([['packages/a', 'ws']])
  })

  it('a new directory with no name is named by its path; the stage sees the cache dir', async () => {
    const dirs: string[] = []
    const p = plugin('p', (ctx) => {
      dirs.push(ctx.cacheDir)
      return [{ dir: 'tools/gen' }]
    })
    expect(await names([p])).toEqual(['packages/a@packages/a', 'tools/gen@tools/gen'])
    expect(dirs).toEqual([root])
  })

  it("a path-named project takes the plugin's name; a config's name wins", async () => {
    await mkdir(path.join(root, 'packages', 'c'), { recursive: true })
    const p = plugin('p', () => [
      { dir: 'packages/a', name: 'a' },
      { dir: 'packages/c', name: 'plugin-c' },
    ])
    expect(await names([p], { 'packages/c': { name: 'c' } })).toEqual([
      'a@packages/a',
      'c@packages/c',
    ])
  })

  it('two projects of one name once the stage ends are refused, naming both', async () => {
    const err = await discover([plugin('p', () => [{ dir: 'tools/gen', name: 'packages/a' }])])
      .then(() => null)
      .catch((e: Error) => e.message)
    expect(err).toBe(
      'two projects are named "packages/a": packages/a and tools/gen — give one another `name` in its vx.config',
    )
  })

  const edgesOf = (projects: readonly ProjectMeta[]): Record<string, unknown> =>
    Object.fromEntries(
      projects
        .filter((p) => p.deps !== undefined || p.reach !== undefined)
        .map((p) => [p.name, { deps: p.deps, reach: p.reach }]),
    )

  it('deps and reach name existing projects by directory; plugins union', async () => {
    await mkdir(path.join(root, 'packages', 'b'), { recursive: true })
    const p1 = plugin('p1', () => [
      { dir: 'packages/a', deps: ['packages/b'] },
      { dir: path.join(root, 'tools', 'gen'), name: 'gen', reach: ['packages/a'] },
    ])
    const p2 = plugin('p2', () => [
      { dir: 'packages/a', name: 'a', deps: ['tools/gen', 'packages/b'], reach: ['packages/b'] },
      { dir: 'packages/b', name: 'b' },
    ])
    const projects = await discover([p1, p2], { 'packages/b': {} })
    expect(edgesOf(projects)).toEqual({
      a: { deps: ['b', 'gen'], reach: ['b'] },
      gen: { deps: undefined, reach: ['a'] },
    })
  })

  it('CONTROL: no deps or reach leaves every project edgeless', async () => {
    const projects = await discover([plugin('p', () => [{ dir: 'packages/a', name: 'a' }])])
    expect(edgesOf(projects)).toEqual({})
  })

  it('deps order and reach; reach only reaches (--filter, --affected)', async () => {
    await mkdir(path.join(root, 'packages', 'lib'), { recursive: true })
    const projects = await discover(
      [
        plugin('p', () => [
          { dir: 'packages/a', name: 'a', reach: ['packages/lib'] },
          { dir: 'tools/gen', name: 'gen', deps: ['packages/lib'] },
          { dir: 'packages/lib', name: 'lib' },
        ]),
      ],
      { 'packages/lib': {} },
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

  // A workspace glob over linked packages (pnpm's `widgets/**` with
  // `widgets/a -> ../submodules/a`) names the link; the config lies at the
  // real directory. Joined by spelling, one directory made two projects:
  // the configured one nothing depended on, and a config-less twin at the
  // link that took every edge (vercel/turborepo#12489's case).
  describe('a directory reached through a symlink', () => {
    const at = (p: ProjectMeta): string => `${p.name}@${path.relative(root, p.dir)}`

    it('is the project at its real directory: name, edges and a ./link filter land there', async () => {
      await mkdir(path.join(root, 'submodules', 'w'), { recursive: true })
      await mkdir(path.join(root, 'widgets'))
      await symlink('../submodules/w', path.join(root, 'widgets', 'w'))
      const projects = await discover(
        [
          plugin('p', () => [
            { dir: path.join(root, 'widgets', 'w'), name: 'w' },
            { dir: 'packages/a', name: 'a', deps: [path.join(root, 'widgets', 'w')] },
          ]),
        ],
        { 'submodules/w': {} },
      )
      expect(projects.map(at)).toEqual(['a@packages/a', 'w@submodules/w'])
      expect(edgesOf(projects)).toEqual({ a: { deps: ['w'], reach: undefined } })
      const graph = buildPackageGraph(projects)
      expect([
        ...applyFilters({ filters: [parseFilter('./widgets/w', root)], projects, graph }),
      ]).toEqual(['w'])
    })

    it('two links to one directory are one project', async () => {
      await mkdir(path.join(root, 'shared', 'x'), { recursive: true })
      await symlink('../shared/x', path.join(root, 'tools', 'x'))
      await symlink('../shared/x', path.join(root, 'packages', 'x'))
      const projects = await discover([
        plugin('p', () => [
          { dir: 'tools/x', name: 'x' },
          { dir: 'packages/x', name: 'x' },
        ]),
      ])
      expect(projects.map(at)).toEqual(['packages/a@packages/a', 'x@shared/x'])
    })

    it('an edge to a link no entry named lands on the project at its real directory', async () => {
      await mkdir(path.join(root, 'widgets'))
      await symlink('../packages/a', path.join(root, 'widgets', 'a'))
      const projects = await discover([
        plugin('p', () => [{ dir: 'tools/gen', name: 'gen', deps: ['widgets/a'] }]),
      ])
      expect(edgesOf(projects)).toEqual({ gen: { deps: ['packages/a'], reach: undefined } })
    })

    it('CONTROL: a link leading out of the root stays at the link', async () => {
      const out = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-discover-out-')))
      try {
        await symlink(out, path.join(root, 'tools', 'ext'))
        const projects = await discover([plugin('p', () => [{ dir: 'tools/ext', name: 'ext' }])])
        expect(projects.map(at)).toEqual(['ext@tools/ext', 'packages/a@packages/a'])
      } finally {
        await rm(out, { recursive: true, force: true })
      }
    })

    // macOS's temp root is a link (`/var` -> `/private/var`): the real
    // directory is spelled under the root as given, so it still matches
    // the lock's projects.
    it('under a root reached through a link, keeps the root as given', async () => {
      const outer = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-discover-root-')))
      const linked = path.join(outer, 'root')
      await symlink(root, linked)
      try {
        await mkdir(path.join(root, 'widgets'))
        await symlink('../packages/a', path.join(root, 'widgets', 'a'))
        const projects = await discoverProjects(
          linked,
          lockOf(),
          [plugin('p', () => [{ dir: 'widgets/a', name: 'a' }])],
          linked,
          warn,
        )
        expect(projects.map((p) => `${p.name}@${p.dir}`)).toEqual([
          `a@${path.join(linked, 'packages', 'a')}`,
        ])
      } finally {
        await rm(outer, { recursive: true, force: true })
      }
    })
  })

  const refusals: Array<[string, VxPlugin['discover'], string]> = [
    ['outside the root', () => [{ dir: '..', name: 'x' }], 'outside the workspace root'],
    ['no such directory', () => [{ dir: 'nope', name: 'n' }], 'no such directory'],
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
      'the root\'s name "//" away from the root',
      () => [{ dir: 'tools/gen', name: '//' }],
      '"//" at tools/gen: "//" names the workspace root',
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
      'a dep on a directory that is no project',
      () => [{ dir: 'packages/a', deps: ['tools/gen'] }],
      'gave project "packages/a" an edge to tools/gen: not a project',
    ],
    [
      'a reach outside the root',
      () => [{ dir: 'packages/a', reach: ['..'] }],
      'gave project "packages/a" an edge to ..: outside the workspace root',
    ],
    [
      'a conflicting rename of a project an earlier entry named',
      () => [
        { dir: 'tools/gen', name: 'gen' },
        { dir: 'tools/gen', name: 'generator', deps: ['packages/a'] },
      ],
      `plugin 'p' already named it "gen"`,
    ],
    ['not an array', () => ({}) as never, 'failed in discover: expected an array, got an object'],
  ]
  for (const [what, discover, message] of refusals) {
    it(`refuses ${what}, naming the plugin`, async () => {
      const err = await discoverProjects(root, lockOf(), [plugin('p', discover)], root, warn).then(
        () => null,
        (e: unknown) => e as Error,
      )
      expect(err?.message).toContain("plugin 'p'")
      expect(err?.message).toContain(message)
    })
  }
})
