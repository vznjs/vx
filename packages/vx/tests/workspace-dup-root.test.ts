// A root package.json named as a member was refused as
// "in workspace:  and packages/a", the root's place an empty string (D-127).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { listProjects, loadWorkspace } from '../src/workspace/workspace.js'

it('names the workspace root when it shares a member’s name', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-dup-root-'))
  try {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'a', private: true, workspaces: ['packages/*'] }),
    )
    await mkdir(path.join(dir, 'packages', 'a'), { recursive: true })
    await writeFile(path.join(dir, 'packages', 'a', 'package.json'), '{"name":"a"}')
    await writeFile(
      path.join(dir, 'packages', 'a', 'vx.config.mjs'),
      'export default { tasks: {} }\n',
    )
    await writeFile(path.join(dir, 'vx.config.mjs'), 'export default { tasks: {} }\n')
    const list = async () =>
      listProjects(await loadWorkspace(dir)).then(
        (ps) => ps.map((p) => p.name),
        (e: Error) => e.message,
      )
    expect(await list()).toBe(
      'Duplicate package name "a" in workspace: the workspace root and packages/a; vx names a project by its package name — rename one, or leave one out with a `!` pattern in the workspace globs',
    )
    // CONTROL: a root of another name.
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
    )
    expect(await list()).toEqual(['a', 'root'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
