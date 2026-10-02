// `vx init` declares turbo() beside turbo.json. After the migration it
// still read turbo.json every run, and nothing said the configs written
// made it redundant.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { migrateTurbo } from '../src/migrate-turbo.js'

let root: string
let metas: ProjectMeta[]
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-migrate-drop-'))
  await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ tasks: { build: {} } }))
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  metas = [
    {
      name: 'a',
      dir,
      packageJson: { name: 'a', scripts: { build: 'tsc' } } as never,
      configPath: null,
    },
  ]
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('migrateTurbo: a workspace that still declares turbo()', () => {
  it('is told to drop it; one without turbo(), or none, is told nothing', async () => {
    const notes = async (workspace: string | null, name = 'vx.workspace.ts') => {
      for (const n of ['vx.workspace.ts', 'vx.workspace.cjs'])
        await rm(path.join(root, n), { force: true })
      if (workspace !== null) await writeFile(path.join(root, name), workspace)
      return (await migrateTurbo(root, metas)).headerNotes
    }
    expect([
      await notes(
        "import { turbo } from '@vzn/vx-migrate'\nexport default { plugins: [turbo()] }\n",
      ),
      await notes(
        "const { turbo } = require('@vzn/vx-migrate')\nmodule.exports = { plugins: [turbo ()] }\n",
        'vx.workspace.cjs',
      ),
      await notes('export default { plugins: [] }\n'),
      await notes(null),
    ]).toEqual([
      [
        'vx.workspace.ts still declares turbo(), which reads turbo.json every run and fills any ' +
          'task a vx.config does not declare; the configs written here declare them all. Once ' +
          '`vx run` does what turbo did, remove turbo() (and its import), then turbo.json',
      ],
      [
        'vx.workspace.cjs still declares turbo(), which reads turbo.json every run and fills any ' +
          'task a vx.config does not declare; the configs written here declare them all. Once ' +
          '`vx run` does what turbo did, remove turbo() (and its import), then turbo.json',
      ],
      [],
      [],
    ])
  })
})
