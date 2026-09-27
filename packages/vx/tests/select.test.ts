// What a run is asked to run (`cli/select.ts`), driven at its exports. A
// sweep of the file (E-11, never swept before) found these unheld: each row
// names the mutant that passed the suite without it.

import { realpathSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import {
  findCwdProject,
  resolveFilters,
  taskEdgesFrom,
  workspaceGlobOwners,
} from '../src/cli/select.js'
import type { ProjectConfig } from '../src/config.js'
import type { ProjectEntry, ProjectMeta } from '../src/workspace/index.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

let root = ''
let metas: ProjectMeta[] = []

beforeAll(async () => {
  root = realpathSync(await makeWorkspace({ prefix: 'vx-select-' }))
  await addProject(root, 'lib', {
    config: `export default { tasks: { build: { exec: { command: 'true' } } } }\n`,
  })
  await addProject(root, 'app', {
    deps: { lib: 'workspace:*' },
    config: `export default { tasks: { build: { exec: { command: 'true' },
      cache: { inputs: { files: ['src/**'], workspaceFiles: ['tsconfig.base.json'] },
        outputs: { files: [] } } } } }\n`,
  })
  // A sibling that shares the member's name as a PREFIX and is no project.
  await mkdir(path.join(root, 'packages', 'app-e2e'), { recursive: true })
  await Bun.write(path.join(root, 'tsconfig.base.json'), '{}\n')
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  metas = [
    { name: 'app', dir: path.join(root, 'packages', 'app') },
    { name: 'lib', dir: path.join(root, 'packages', 'lib') },
  ].map((m) => ({ ...m, configPath: path.join(m.dir, 'vx.config.mjs') })) as ProjectMeta[]
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Run `fn` with stderr captured; returns its result and what it wrote. */
async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; stderr: string }> {
  let stderr = ''
  const spy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    stderr += String(chunk)
    return true
  }) as never)
  try {
    return { value: await fn(), stderr }
  } finally {
    spy.mockRestore()
  }
}

describe('findCwdProject', () => {
  it('places a directory in a member only on a path boundary', async () => {
    // `packages/app-e2e` starts with `packages/app` as a STRING: without the
    // separator in the prefix test a run from there ran app's task.
    expect(await findCwdProject(path.join(root, 'packages', 'app-e2e'))).toBeNull()
    // CONTROL: the member itself and a directory under it.
    expect(await findCwdProject(path.join(root, 'packages', 'app'))).toBe('app')
    await mkdir(path.join(root, 'packages', 'app', 'src'), { recursive: true })
    expect(await findCwdProject(path.join(root, 'packages', 'app', 'src'))).toBe('app')
  })
})

describe('resolveFilters', () => {
  it('a name that matches nothing beside a diff that matched nothing is a typo, not "nothing affected"', async () => {
    // With `some` for `every`, the git filter's empty answer spoke for both
    // and the typo exited 0 as "nothing affected since HEAD".
    const { value } = await quiet(() => resolveFilters(root, ['nosuch', '[HEAD]']))
    expect(value).toEqual({ error: 'no projects matched filter(s): nosuch, [HEAD]' })
  })

  it('a typo beside a walk that came back empty names the typo, with its hint', async () => {
    // `lib^...` matched lib, which depends on no project; `apq` matched
    // nothing. The empty walk's error hid the typo and its "did you mean".
    const { value } = await quiet(() => resolveFilters(root, ['apq', 'lib^...']))
    expect(value).toEqual({
      error: 'no projects matched filter(s): apq, lib^.... Did you mean app?',
    })
  })

  it("the hint reads a pattern's name through its graph operators", async () => {
    const { value } = await quiet(() => resolveFilters(root, ['apq...']))
    expect(value).toEqual({ error: 'no projects matched filter(s): apq.... Did you mean app?' })
  })

  it('a diff that matched nothing beside a name that matched is not called a typo', async () => {
    const { value, stderr } = await quiet(() => resolveFilters(root, ['app', '[HEAD]']))
    expect({ value: { ...value, staged: undefined, discovered: undefined }, stderr }).toEqual({
      value: { names: ['app'], byDiff: true, staged: undefined, discovered: undefined },
      stderr: '',
    })
    // CONTROL: a name that matched nothing beside one that did IS said.
    const typo = await quiet(() => resolveFilters(root, ['app', 'nosuch']))
    expect(typo.stderr).toBe('vx: filter "nosuch" matched no projects\n')
  })

  it('only an INCLUDED diff makes the selection diff-chosen', async () => {
    const { value } = await quiet(() => resolveFilters(root, ['app', '![HEAD]']))
    expect((value as { byDiff: boolean }).byDiff).toBe(false)
  })
})

describe('taskEdgesFrom', () => {
  it('a project is no dependency of itself, and a negated spec is no edge', () => {
    // A self edge put `app` among its own dependencies (`app^...` selected
    // app); a `!lib#build` exclusion drew the very edge it removes.
    const entry = (name: string, config: ProjectConfig): [string, ProjectEntry] => [
      name,
      { name, config } as unknown as ProjectEntry,
    ]
    const staged = new Map([
      entry('app', {
        tasks: {
          lint: { dependsOn: ['app#build', '!lib#build'], exec: { command: 'true' } },
          build: { exec: { command: 'true' } },
        },
      }),
    ])
    expect(taskEdgesFrom(staged)).toEqual(new Map())
    // CONTROL: a plain cross-project spec is an edge.
    staged.get('app')!.config.tasks!['lint']!.dependsOn = ['lib#build']
    expect(taskEdgesFrom(staged)).toEqual(new Map([['app', ['lib']]]))
  })
})

describe('workspaceGlobOwners', () => {
  it('when the staged load fails, each config that loads is still read', async () => {
    // One broken config anywhere failed the staged load, and the owners of
    // a changed root file came back empty: `--affected` then skipped a task
    // whose declared input had changed.
    const owners = await workspaceGlobOwners(root, metas, ['tsconfig.base.json'], {}, () =>
      Promise.reject(new Error('a config elsewhere does not load')),
    )
    expect(owners).toEqual(['app'])
  })
})
