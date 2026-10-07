// npm and pnpm take `../ext/*` as a member glob, and vx listed `../ext/e`
// as a project; `--affected` diffs with `--relative` from the root, so an
// edit there selected nothing while the task's key moved (green, nothing
// run). A member outside the root is refused at discovery.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { listProjects, loadWorkspace } from '../src/workspace/workspace.js'
import { UserError } from '../src/util/index.js'

let top: string
let root: string

const manifest = async (dir: string, body: object) => {
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(body))
}

beforeEach(async () => {
  top = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-outside-member-')))
  root = path.join(top, 'w')
  await manifest(path.join(root, 'packages/a'), { name: 'a' })
  await manifest(path.join(top, 'ext/e'), { name: 'e' })
  await mkdir(path.join(top, 'ext/empty'), { recursive: true })
})

afterEach(async () => {
  await rm(top, { recursive: true, force: true })
})

const list = async (globs: string[]) => {
  await manifest(root, { name: 'r', workspaces: globs })
  return listProjects(await loadWorkspace(root)).then(
    (ps) => ps.map((p) => path.relative(root, p.dir)),
    (e: unknown) => e as Error,
  )
}

for (const glob of ['../ext/*', '../ext/e', 'packages/../../ext/*', 'ABS/ext/*']) {
  it(`refuses a member outside the workspace root (${glob})`, async () => {
    const err = await list(['packages/*', glob.replace('ABS', top)])
    expect(err).toBeInstanceOf(UserError)
    expect((err as Error).message).toBe(
      `workspace member ../ext/e (${path.join(top, 'ext/e')}) is outside the workspace root ${root}: ` +
        'vx keeps every project under the root. Move the workspace root up to a directory that holds every member.',
    )
  })
}

it('CONTROL: a glob outside the root that reaches no manifest refuses nothing', async () => {
  expect(await list(['packages/*', '../ext/empty'])).toEqual(['packages/a'])
})
