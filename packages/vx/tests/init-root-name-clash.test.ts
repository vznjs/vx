// A root named as a member is left out of `vx init`'s plan: a root config
// made it a project, and every later run was refused for the duplicate
// "name" (insomnia's root and `packages/insomnia`, D-129).
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { migrateScripts } from '../src/workspace/migrate-scripts.js'

// The root is no member: discovery passes it as `outside`.
const meta = (name: string, dir: string, scripts: Record<string, string>) => ({
  name,
  dir,
  packageJson: { name, scripts } as never,
  configPath: null,
})

const plan = async (rootName: string) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-root-clash-'))
  try {
    const p = migrateScripts(
      [meta('app', path.join(dir, 'packages', 'app'), { build: 'tsc' })],
      { name: rootName, scripts: { lint: 'eslint .', typecheck: 'tsc -b' } },
      dir,
    )
    return {
      dirs: p.projects.map((x) => (x.dir === dir ? 'root' : x.dir.slice(dir.length + 1))).sort(),
      note: p.notes.find((n) => n.startsWith(`${rootName} (the workspace root)`)),
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

it('leaves out a root named as a member and says why', async () => {
  const { dirs, note } = await plan('app')
  expect(dirs).toEqual([path.join('packages', 'app')])
  expect(note).toStartWith(
    'app (the workspace root) not mapped: packages/app has the same "name", and vx names a project by it; rename the root\'s and run `vx init` again to map 2 of its scripts',
  )
})

it('CONTROL: a root with its own name is mapped', async () => {
  const { dirs, note } = await plan('repo')
  expect(dirs).toEqual([path.join('packages', 'app'), 'root'])
  expect(note === undefined || !note.includes('has the same "name"')).toBe(true)
})
