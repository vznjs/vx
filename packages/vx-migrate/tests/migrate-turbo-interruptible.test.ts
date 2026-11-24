// `interruptible` maps to nothing: `vx watch` keeps a persistent task up
// across cycles. The migration said nothing of it, where it names every
// field it leaves behind.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { migrateTurbo } from '../src/migrate-turbo.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-migrate-interruptible-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('names each interruptible task in a note', async () => {
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'root' }))
  await writeFile(
    path.join(root, 'turbo.json'),
    JSON.stringify({
      tasks: { dev: { persistent: true, cache: false, interruptible: true }, build: {} },
    }),
  )
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  const metas: PackageMeta[] = [
    {
      name: 'a',
      dir,
      packageJson: { name: 'a', scripts: { dev: 'vite', build: 'tsc' } } as never,
      configPath: null,
    },
  ]
  const p = await migrateTurbo(root, metas)
  const notes = p.notes.filter((n) => n.includes('interruptible'))
  expect(notes).toHaveLength(1)
  expect(notes[0]).toContain('a#dev')
  expect(notes[0]).toContain('vx watch')
})
