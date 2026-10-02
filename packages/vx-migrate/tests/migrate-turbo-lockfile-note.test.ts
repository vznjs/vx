// Turbo keys each package on its own lockfile entries; core keys every
// task on the whole lockfile unless a @vzn/vx-lockfile plugin claims it.
// hey-api's written configs re-keyed all 42 builds on a pnpm-lock.yaml
// edit, and nothing said how to stop it.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { migrateTurbo } from '../src/migrate-turbo.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-migrate-lock-'))
  await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ tasks: { build: {} } }))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const notes = async (files: Record<string, string>): Promise<string[]> => {
  for (const [f, text] of Object.entries(files)) await writeFile(path.join(root, f), text)
  return (await migrateTurbo(root, [])).headerNotes.map((n) => n.split(/[;,]/)[0]!)
}

it('names the plugin for the lockfile present, unless vx.workspace declares one', async () => {
  expect(await notes({})).toEqual([])
  expect(await notes({ 'yarn.lock': '' })).toEqual([
    'Turbo keys each package on its own yarn.lock entries',
  ])
  await rm(path.join(root, 'yarn.lock'))
  expect(await notes({ 'pnpm-lock.yaml': '' })).toEqual([
    'Turbo keys each package on its own pnpm-lock.yaml entries',
  ])
  expect(
    await notes({
      'vx.workspace.ts':
        "import { pnpm } from '@vzn/vx-lockfile'\nexport default { plugins: [pnpm()] }\n",
    }),
  ).toEqual([])
  expect(
    await notes({
      'vx.workspace.ts':
        "import { turbo } from '@vzn/vx-migrate'\nexport default { plugins: [turbo()] }\n",
    }),
  ).toEqual([
    'vx.workspace.ts still declares turbo()',
    'Turbo keys each package on its own pnpm-lock.yaml entries',
  ])
})

it('says which factory claims each lockfile', async () => {
  const factory = async (file: string) => {
    await writeFile(path.join(root, file), '')
    const [note] = (await migrateTurbo(root, [])).headerNotes
    await rm(path.join(root, file))
    return /Declare (\w+)\(\)/.exec(note ?? '')?.[1]
  }
  expect({
    pnpm: await factory('pnpm-lock.yaml'),
    bun: await factory('bun.lock'),
    bunb: await factory('bun.lockb'),
    npm: await factory('package-lock.json'),
    shrink: await factory('npm-shrinkwrap.json'),
    yarn: await factory('yarn.lock'),
  }).toEqual({ pnpm: 'pnpm', bun: 'bun', bunb: 'bun', npm: 'npm', shrink: 'npm', yarn: 'yarn' })
})
