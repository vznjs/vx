// A project name holding `#` was planned under `--all`, but every task
// spec splits at the first `#`, so `vx run a#b#build` and a dependsOn
// on it found nothing (D-130). Discovery refuses the name instead.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { listProjects, loadWorkspace } from '../src/workspace/workspace.js'

const load = async (name: string) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-name-hash-')))
  try {
    await mkdir(path.join(root, 'p'))
    await writeFile(path.join(root, 'package.json'), '{"name":"r","workspaces":["p"]}')
    await writeFile(path.join(root, 'p', 'package.json'), JSON.stringify({ name }))
    return await listProjects(await loadWorkspace(root)).then(
      (ps) => ps.map((p) => p.name),
      (err: Error) => err.message.slice(root.length + 1),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it('refuses a member named with "#"', async () => {
  expect(await load('a#b')).toBe(
    'p/package.json: "name" cannot hold "#" — vx addresses a task as <name>#<task>',
  )
})

it('CONTROL: a scoped name is a project', async () => {
  expect(await load('@s/a')).toEqual(['@s/a'])
})
