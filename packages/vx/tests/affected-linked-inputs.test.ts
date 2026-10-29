// A symlinked input keys the content behind it (linked-inputs.test.ts), so
// `--affected` must select its project when that content changes: the diff
// names the target, never the link. A target git cannot diff (outside the
// workspace, or git-ignored) is affected on every run.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { affectedChanges } from '../src/workspace/affected.js'
import type { ProjectMeta } from '../src/workspace/workspace.js'
import { gitIn, makeWorkspace } from './helpers/workspace.js'

let root: string
let outside: string
let projects: ProjectMeta[]

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-affected-linked-' })
  outside = await mkdtemp(path.join(os.tmpdir(), 'vx-affected-linked-outside-'))
  await mkdir(path.join(root, 'shared', 'd'), { recursive: true })
  await writeFile(path.join(root, 'shared', 'x.txt'), 'V1\n')
  await writeFile(path.join(root, 'shared', 'd', 'y.txt'), 'Y1\n')
  await writeFile(path.join(root, '.gitignore'), 'secret.txt\n')
  await writeFile(path.join(outside, 'o.txt'), 'O1\n')
  for (const name of ['a', 'b']) {
    await mkdir(path.join(root, 'packages', name, 'src'), { recursive: true })
    await writeFile(path.join(root, 'packages', name, 'src', 'own.txt'), name)
  }
  projects = ['a', 'b'].map((name) => ({
    name,
    dir: path.join(root, 'packages', name),
    configPath: null,
  }))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

function commit(): void {
  gitIn(root)('add', '-A')
  gitIn(root)('commit', '-q', '-m', 'c')
}

const changes = () => affectedChanges({ workspaceRoot: root, since: 'HEAD', projects })

describe('--affected and a symlinked input', () => {
  it('an edit behind a file link selects the link, as a path of its project', async () => {
    await symlink('../../../shared/x.txt', path.join(root, 'packages/a/src/x.txt'))
    commit()
    expect([...(await changes()).projects]).toEqual([])
    await writeFile(path.join(root, 'shared', 'x.txt'), 'V2\n')
    const c = await changes()
    expect([...c.projects]).toEqual(['a'])
    expect(c.paths.get('a')).toEqual(['src/x.txt'])
  })

  it('an edit, or a new file, behind a directory link selects the link', async () => {
    await symlink('../../../shared/d', path.join(root, 'packages/a/src/d'))
    commit()
    await writeFile(path.join(root, 'shared', 'd', 'y.txt'), 'Y2\n')
    expect((await changes()).paths.get('a')).toEqual(['src/d'])
    gitIn(root)('checkout', '-q', '--', '.')
    await writeFile(path.join(root, 'shared', 'd', 'new.txt'), 'N\n')
    expect((await changes()).paths.get('a')).toEqual(['src/d'])
  })

  it('a link to a target git cannot diff is affected every run', async () => {
    await writeFile(path.join(root, 'secret.txt'), 'S\n')
    await symlink(path.join(outside, 'o.txt'), path.join(root, 'packages/a/src/o.txt'))
    await symlink('../../../secret.txt', path.join(root, 'packages/b/src/s.txt'))
    commit()
    const c = await changes()
    expect([...c.projects].sort()).toEqual(['a', 'b'])
    expect(c.paths.get('a')).toEqual(['src/o.txt'])
    expect(c.paths.get('b')).toEqual(['src/s.txt'])
  })

  // The target reached `git ls-files` as a pathspec: `:x` is pathspec magic,
  // matched nothing, and the ignored target read as one git diffs.
  it('an ignored target whose name is pathspec magic is affected every run', async () => {
    await writeFile(path.join(root, '.gitignore'), 'secret.txt\n/:gen/\n')
    await mkdir(path.join(root, ':gen'))
    await writeFile(path.join(root, ':gen', 'x.txt'), 'G\n')
    await symlink('../../../:gen', path.join(root, 'packages/a/src/gen'))
    commit()
    expect([...(await changes()).projects]).toEqual(['a'])
  })

  // Control: a dangling link, and a link whose target did not change, select nothing.
  it('a dangling link, or an unchanged target, selects nothing', async () => {
    await symlink('../nowhere.txt', path.join(root, 'packages/a/src/gone.txt'))
    await symlink('../../../shared/x.txt', path.join(root, 'packages/b/src/x.txt'))
    commit()
    await writeFile(path.join(root, 'shared', 'd', 'y.txt'), 'Y2\n')
    expect([...(await changes()).projects]).toEqual([])
  })
})
