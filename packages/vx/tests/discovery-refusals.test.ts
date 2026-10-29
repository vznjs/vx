// A plugin's `discover` hook names projects by `{ dir, name?, deps?, reach? }`,
// and `discoveredProject` / `linkDiscoveredEdges` / `checkProjectNames`
// refuse what discovery cannot hold. Each is compared whole.
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  checkProjectNames,
  discoveredProject,
  findProjectConfigs,
  linkDiscoveredEdges,
  lockedProjects,
  type ProjectMeta,
} from '../src/workspace/workspace.js'

let root: string
let known: ProjectMeta[]

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-named-'))
  for (const d of ['a', 'b', 'c']) await mkdir(path.join(root, 'packages', d), { recursive: true })
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const byDir = (metas: readonly ProjectMeta[]) => new Map(metas.map((m) => [m.dir, m]))

/** `packages/a` named by its path, `packages/c` by its config. */
function fresh(): ProjectMeta[] {
  known = lockedProjects(root, {
    'packages/a': { file: 'vx.config.mjs', config: {} },
    'packages/c': { file: 'vx.config.mjs', config: { name: 'cee' } },
  })
  return known
}

const refusal = (named: unknown): Promise<string> =>
  discoveredProject(root, byDir(fresh()), named as { dir: string }, 'p').then(
    () => 'accepted',
    (err: Error) => err.message.replaceAll(root, '<root>'),
  )

describe('a plugin-named project discovery cannot hold is refused, whole', () => {
  it('a shape that is not { dir, name?, deps?, reach? }', async () => {
    const expected = ': expected { dir: string, name?: string, deps?: string[], reach?: string[] }'
    expect(await refusal({ dir: 1 })).toBe(`plugin 'p' named project {"dir":1}${expected}`)
    expect(await refusal({ dir: 'x', name: '' })).toBe(
      `plugin 'p' named project {"dir":"x","name":""}${expected}`,
    )
    expect(await refusal({ dir: 'packages/a', reach: [1] })).toBe(
      `plugin 'p' named project {"dir":"packages/a","reach":[1]}${expected}`,
    )
  })

  it('a name no task spec can address', async () => {
    expect(await refusal({ dir: 'packages/b', name: ' b' })).toBe(
      `plugin 'p' named project " b": the name has surrounding whitespace`,
    )
    expect(await refusal({ dir: 'packages/b', name: 'b#1' })).toBe(
      `plugin 'p' named project "b#1": the name holds "#" — vx addresses a task as <name>#<task>`,
    )
    expect(await refusal({ dir: 'packages/b', name: '!b' })).toBe(
      `plugin 'p' named project "!b": the name starts with '!', which a filter reads as an exclusion`,
    )
  })

  it('an edge to a directory that is no project, or outside the root', () => {
    const link = (target: string): string => {
      try {
        linkDiscoveredEdges(root, fresh(), [
          { by: 'p', meta: known[0]!, deps: [target], reach: [] },
        ])
        return 'accepted'
      } catch (err) {
        return (err as Error).message
      }
    }
    expect(link('packages/b')).toBe(
      `plugin 'p' gave project "packages/a" an edge to packages/b: not a project`,
    )
    expect(link('../out')).toBe(
      `plugin 'p' gave project "packages/a" an edge to ../out: outside the workspace root`,
    )
  })

  it('a directory outside the workspace', async () => {
    expect(await refusal({ dir: '../out', name: 'out' })).toBe(
      `plugin 'p' named project "out" at ${path.dirname(root)}/out: outside the workspace root`,
    )
  })

  it('a directory that does not exist', async () => {
    expect(await refusal({ dir: 'packages/none', name: 'none' })).toBe(
      `plugin 'p' named project "none" at packages/none: no such directory`,
    )
  })

  it('a different name for a project an earlier plugin named', async () => {
    const index = byDir(fresh())
    await discoveredProject(root, index, { dir: 'packages/a', name: 'a' }, 'first')
    expect(
      await discoveredProject(root, index, { dir: 'packages/a', name: 'other' }, 'p').then(
        () => 'accepted',
        (err: Error) => err.message,
      ),
    ).toBe(`plugin 'p' named project "other" at packages/a: plugin 'first' already named it "a"`)
  })

  it('two projects of one name, naming both directories', () => {
    const metas = fresh()
    metas[0]!.name = 'cee'
    expect(() => checkProjectNames(root, metas)).toThrow(
      'two projects are named "cee": packages/a and packages/c — give one another `name` in its vx.config',
    )
  })

  it('a path name holding "#", and `//` away from the root', () => {
    const named = (rel: string, name?: string): ProjectMeta[] =>
      lockedProjects(root, {
        [rel]: { file: 'vx.config.mjs', config: name === undefined ? {} : { name } },
      })
    expect(() => checkProjectNames(root, named('pkg#1'))).toThrow(
      'pkg#1: a project is named by its path unless named, and this one holds "#" — vx addresses a task as <name>#<task> — set `name` in its vx.config',
    )
    expect(() => checkProjectNames(root, named('!old'))).toThrow(
      "!old: a project is named by its path unless named, and this one starts with '!', which a filter reads as an exclusion — set `name` in its vx.config",
    )
    expect(() => checkProjectNames(root, named('packages/a', '//'))).toThrow(
      'packages/a: "//" names the workspace root — set another `name`',
    )
    // CONTROL: the root named by its path, and a `#` path a config names.
    expect(checkProjectNames(root, named('.')).map((m) => m.name)).toEqual(['//'])
    expect(checkProjectNames(root, named('pkg#1', 'pkg')).map((m) => m.name)).toEqual(['pkg'])
  })

  it("CONTROL: a path name takes the plugin's, a config's name stays, and a new directory is named by its path", async () => {
    const index = byDir(fresh())
    const a = await discoveredProject(root, index, { dir: 'packages/a', name: 'a' }, 'p')
    const c = await discoveredProject(root, index, { dir: 'packages/c', name: 'see' }, 'p')
    const b = await discoveredProject(root, index, { dir: 'packages/b' }, 'p')
    expect([a.meta.name, a.added, c.meta.name, c.added, b.meta.name, b.added]).toEqual([
      'a',
      false,
      'cee',
      false,
      'packages/b',
      true,
    ])
  })
})

describe('`vx lock` finding the configs', () => {
  it('a git that cannot list them is refused with what it said', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'vx-ls-files-'))
    try {
      Bun.spawnSync(['git', 'init', '-q'], { cwd: repo })
      await Bun.write(path.join(repo, 'vx.config.mjs'), 'export default {}\n')
      Bun.spawnSync(['git', 'add', '-A'], { cwd: repo })
      // A torn index: git still finds the repository, and refuses to read it.
      await Bun.write(path.join(repo, '.git', 'index'), 'DIRC')
      const err = await findProjectConfigs(repo).then(
        () => 'listed',
        (e: Error) => e.message,
      )
      // git's own words vary by version.
      expect(err).toStartWith('git ls-files failed (exit 128): ')
      expect(err).toContain('index file smaller than expected')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
