// One package reached by two workspace paths, a member and a link to it
// (`apps/docs -> ../packages/docs`), was refused as two packages sharing a
// name, with "rename one" as the way on (D-135). It is one project, kept at
// the path that reaches it through no link.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, spyOn } from 'bun:test'
import { listProjects, loadWorkspace } from '../src/workspace/workspace.js'

let tmp: string | undefined

afterEach(async () => {
  if (tmp !== undefined) await rm(tmp, { recursive: true, force: true })
})

const member = async (dir: string, name: string, config = true) => {
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
  if (config) await writeFile(path.join(dir, 'vx.config.mjs'), 'export default { tasks: {} }\n')
}

/** The workspace reached through `link` (macOS's temp dir is one). */
const workspace = async (setup: (real: string) => Promise<void>) => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-alias-')))
  const real = path.join(tmp, 'real')
  await mkdir(path.join(real, 'apps'), { recursive: true })
  await writeFile(
    path.join(real, 'package.json'),
    '{"name":"r","workspaces":["packages/*","apps/*"]}',
  )
  await setup(real)
  await symlink(real, path.join(tmp, 'link'))
  const root = path.join(tmp, 'link')
  return listProjects(await loadWorkspace(root)).then(
    (ps) => ps.map((p) => `${p.name} ${path.relative(root, p.dir).split(path.sep).join('/')}`),
    (err: Error) => err.message,
  )
}

it('keeps a member and a link to it as one project, at the member', async () => {
  expect(
    await workspace(async (real) => {
      await member(path.join(real, 'packages', 'docs'), 'docs')
      await symlink('../packages/docs', path.join(real, 'apps', 'docs'))
    }),
  ).toEqual(['docs packages/docs'])
})

it('CONTROL: two packages that share a name are still refused', async () => {
  expect(
    await workspace(async (real) => {
      await member(path.join(real, 'packages', 'docs'), 'docs')
      await member(path.join(real, 'apps', 'docs'), 'docs')
    }),
  ).toStartWith('Duplicate package name "docs" in workspace: apps/docs and packages/docs')
})

// Bun's realpath answers ENOENT for any path holding a backslash (1.4.2),
// and the grouping's ENOENT ended discovery with a stack.
it('keeps a member and a link to it whose name holds a backslash as one project', async () => {
  expect(
    await workspace(async (real) => {
      await member(path.join(real, 'packages', 'docs'), 'docs')
      await symlink('../packages/docs', path.join(real, 'apps', 'do\\cs'))
    }),
  ).toEqual(['docs packages/docs'])
})

it('leaves out a pair without configs when one sits under a backslash', async () => {
  const spy = spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    expect(
      await workspace(async (real) => {
        await member(path.join(real, 'packages', 'docs'), 'docs')
        await member(path.join(real, 'packages', 'pair'), 'pair', false)
        await member(path.join(real, 'apps', 'pa\\ir'), 'pair', false)
      }),
    ).toEqual(['docs packages/docs'])
  } finally {
    spy.mockRestore()
  }
})
