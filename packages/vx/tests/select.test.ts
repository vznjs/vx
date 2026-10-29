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
import { lock } from './helpers/orchestrator.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { noticed } from './helpers/notice.js'

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
      inputs: { files: ['src/**'], workspaceFiles: ['tsconfig.base.json'] },
      cache: { 
        outputs: { files: [] } } } } }\n`,
  })
  // A sibling that shares the member's name as a PREFIX and is no project.
  await mkdir(path.join(root, 'packages', 'app-e2e'), { recursive: true })
  await Bun.write(path.join(root, 'tsconfig.base.json'), '{}\n')
  await lock(root)
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

  it('a config added since the lock is said, never read as the project around it', async () => {
    // The lock holds the projects, so a config written after it was no
    // project: from its directory a run took the locked project above it
    // (the root's `build` ran for a new member) or said "not inside a project".
    const config = `export default { tasks: { build: { exec: { command: 'true' } } } }\n`
    const nested = path.join(root, 'packages', 'app', 'tools')
    const fresh = path.join(root, 'packages', 'fresh')
    await Bun.write(path.join(nested, 'vx.config.mjs'), config)
    await Bun.write(path.join(fresh, 'vx.config.mjs'), config)
    await mkdir(path.join(fresh, 'src'), { recursive: true })
    try {
      await expect(findCwdProject(nested)).rejects.toThrow(
        'packages/app/tools/vx.config.mjs is not in the lock yet — run `vx lock`',
      )
      await expect(findCwdProject(path.join(fresh, 'src'))).rejects.toThrow(
        'packages/fresh/vx.config.mjs is not in the lock yet — run `vx lock`',
      )
      // CONTROL: a config git ignores is no project `vx lock` would add.
      await Bun.write(path.join(root, '.gitignore'), 'packages/app/tools/\n')
      expect(await findCwdProject(nested)).toBe('app')
    } finally {
      await rm(nested, { recursive: true, force: true })
      await rm(fresh, { recursive: true, force: true })
      await rm(path.join(root, '.gitignore'), { force: true })
    }
  })
})

describe('resolveFilters', () => {
  it('a ./dir filter naming a config the lock lacks says to lock it', async () => {
    // "Projects: app, lib" read as a typo of a path that holds a config
    // written after `vx lock`.
    const fresh = path.join(root, 'packages', 'fresh')
    await Bun.write(path.join(fresh, 'vx.config.mjs'), 'export default {}\n')
    try {
      const { value } = await quiet(() => resolveFilters(root, ['./packages/fresh']))
      expect(value).toEqual({
        error:
          'no projects matched filter(s): ./packages/fresh. packages/fresh/vx.config.mjs is not in the lock yet — run `vx lock`',
      })
      // CONTROL: beside a filter that matched, the line is a warning.
      const { stderr } = await quiet(() => resolveFilters(root, ['app', './packages/fresh']))
      expect(stderr).toContain('packages/fresh/vx.config.mjs is not in the lock yet')
    } finally {
      await rm(fresh, { recursive: true, force: true })
    }
  })

  it('a name that matches nothing beside a diff that matched nothing is a typo, not "nothing affected"', async () => {
    // With `some` for `every`, the git filter's empty answer spoke for both
    // and the typo exited 0 as "nothing affected since HEAD".
    const { value } = await quiet(() => resolveFilters(root, ['nosuch', '[HEAD]']))
    expect(value).toEqual({
      error: 'no projects matched filter(s): nosuch. Projects: app, lib',
    })
  })

  it('a typo beside a walk that came back empty names the typo, with its hint', async () => {
    // `lib^...` matched lib, which depends on no project; `apq` matched
    // nothing. The empty walk's error hid the typo and its "did you mean".
    const { value } = await quiet(() => resolveFilters(root, ['apq', 'lib^...']))
    expect(value).toEqual({
      error: 'no projects matched filter(s): apq. Did you mean app?',
    })
  })

  it('names a ref two empty diffs share once', async () => {
    // `--affected=HEAD --filter '[HEAD]'` said "nothing affected since HEAD, HEAD".
    const { value } = await quiet(() => resolveFilters(root, ['...[HEAD]', '[HEAD]']))
    expect((value as { empty: string }).empty).toStartWith('nothing affected since HEAD — ')
  })

  it('an empty walk from several matched projects speaks of them all', async () => {
    // "matched app, lib, which depends on no project" read as lib alone.
    const said = []
    for (const f of ['*^...', '...^*'])
      said.push((await quiet(() => resolveFilters(root, [f]))).value)
    expect(said).toEqual([
      {
        error: 'no projects selected: filter "*^..." matched app, lib, which depend on no project',
      },
      {
        error:
          'no projects selected: filter "...^*" matched app, lib, and no project depends on them',
      },
    ])
  })

  it('the refusal names only the filters that matched nothing', async () => {
    // It listed every filter: `app` and `!app` matched app, and an
    // `--affected` base appeared as a `...[<base>]` nobody typed.
    const { value } = await quiet(() => resolveFilters(root, ['app', '!app', 'apq']))
    expect(value).toEqual({ error: 'no projects matched filter(s): apq. Did you mean app?' })
  })

  it('a comma list is named as one pattern per --filter, not a typo of its first name', async () => {
    // Nx's `--projects=app,lib` habit: the hint said "Did you mean app?" and dropped lib.
    const { value } = await quiet(() => resolveFilters(root, ['app,lib']))
    expect(value).toEqual({
      error:
        'no projects matched filter(s): app,lib. A filter is one pattern: --filter app --filter lib',
    })
    // CONTROL: beside a filter that matched, the warning says the same.
    const beside = await quiet(() => resolveFilters(root, ['app', 'app,lib']))
    expect(beside.stderr).toBe(
      noticed(
        'vx run: filter "app,lib" matched no projects. A filter is one pattern: --filter app --filter lib\n',
        'warn',
      ),
    )
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
    expect(typo.stderr).toBe(
      noticed('vx run: filter "nosuch" matched no projects. Projects: app, lib\n', 'warn'),
    )
    // A typo beside a match names the nearest project, as the all-missed error does.
    const near = await quiet(() => resolveFilters(root, ['app', 'apq']))
    expect(near.stderr).toBe(
      noticed('vx run: filter "apq" matched no projects. Did you mean app?\n', 'warn'),
    )
  })

  it('a `tag:` filter in a workspace with no tags says so, not a project name', async () => {
    const { value } = await quiet(() => resolveFilters(root, ['tag:app']))
    expect(value).toEqual({
      error: 'no projects matched filter(s): tag:app. No project declares tags',
    })
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
  it('when the staged load fails, each locked config is still read', async () => {
    // One failing project anywhere failed the staged load, and the owners of
    // a changed root file came back empty: `--affected` then skipped a task
    // whose declared input had changed.
    const owners = await workspaceGlobOwners(root, metas, ['tsconfig.base.json'], {}, () =>
      Promise.reject(new Error('a config elsewhere does not load')),
    )
    expect(owners).toEqual(['app'])
  })
})

describe('resolveFilters — a scoped name typed without its scope (E-32)', () => {
  let scoped = ''
  beforeAll(async () => {
    scoped = realpathSync(await makeWorkspace({ prefix: 'vx-select-scoped-' }))
    for (const name of ['@acme/web', '@acme/dup', '@other/dup']) await addProject(scoped, name)
    await lock(scoped)
    const git = gitIn(scoped)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
  })
  afterAll(async () => {
    await rm(scoped, { recursive: true, force: true })
  })

  // The name after the scope selects its one project, as pnpm reads it
  // (G-129, which replaced E-32's hint for the exact name).
  it('selects the one project whose name after the scope it is, and hints a typo of one', async () => {
    const web = (await quiet(() => resolveFilters(scoped, ['web']))).value
    expect('names' in web ? web.names : web).toEqual(['@acme/web'])
    const errors = []
    for (const f of ['wbe', 'dup']) {
      errors.push((await quiet(() => resolveFilters(scoped, [f]))).value)
    }
    expect(errors).toEqual([
      { error: 'no projects matched filter(s): wbe. Did you mean @acme/web?' },
      // Two scopes share the name: no single answer, so the projects (M-56).
      { error: 'no projects matched filter(s): dup. Projects: @acme/dup, @acme/web, @other/dup' },
    ])
  })
})

describe('resolveFilters — `<name>...[ref]` over a task edge', () => {
  let ws = ''
  beforeAll(async () => {
    ws = realpathSync(await makeWorkspace({ prefix: 'vx-select-via-' }))
    await addProject(ws, 'lib', {
      config: `export default { tasks: { build: { exec: { command: 'true' } } } }\n`,
      files: { 'src/a.ts': '1\n' },
    })
    // e2e names lib only in a `dependsOn`, never in its package.json.
    await addProject(ws, 'e2e', {
      config: `export default { tasks: { test: { dependsOn: ['lib#build'], exec: { command: 'true' } } } }\n`,
    })
    await lock(ws)
    const git = gitIn(ws)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    await Bun.write(path.join(ws, 'packages', 'lib', 'src', 'a.ts'), '2\n')
    git('commit', '-qam', 'lib')
  })
  afterAll(async () => {
    await rm(ws, { recursive: true, force: true })
  })

  it('selects a project that depends on the changed one through a cross-project dependsOn', async () => {
    // `e2e...[HEAD~1]` walks dependents without a walk flag, so the task
    // edges were never loaded and e2e did not depend on lib.
    const { value } = await quiet(() => resolveFilters(ws, ['e2e...[HEAD~1]']))
    expect('names' in value ? value.names : value).toEqual(['e2e'])
    // CONTROL: the dependents walk loads the task edges and reaches e2e.
    const dents = (await quiet(() => resolveFilters(ws, ['...[HEAD~1]']))).value
    expect('names' in dents ? dents.names : dents).toEqual(['e2e', 'lib'])
  })
})
