// A task whose own `!` entry takes back its manifest (`!**/*.json`) got the
// manifest appended all the same, and core refuses a literal a negation
// takes back: `vx lock` refused the workspace over a file its author never
// wrote. The author excluded it, so the plugin leaves that task alone.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { type Logger } from '@vzn/vx'
import { planRun } from '@vzn/vx/testing'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const BUN = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "ws" },
    "packages/a": { "name": "a" },
  },
  "packages": {
    "a": ["a@workspace:packages/a"],
  }
}
`
const task = (files: string) =>
  `{ exec: { command: 'echo ok' }, inputs: { files: ${files} }, outputs: { files: [] }, cache: true }`

let root: string
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('a task that takes back its own manifest does not get it appended', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-lockfile-taken-back-'))
  const dir = path.join(root, 'packages', 'a')
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] }),
  )
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'a' }))
  await writeFile(path.join(dir, 'src', 'x.ts'), '1\n')
  await writeFile(
    path.join(dir, 'vx.config.mjs'),
    `export default { tasks: {
      json: ${task("['**/*', '!**/*.json']")},
      star: ${task("['src/**', '!*']")},
      named: ${task("['src/**', '!package.json']")},
      kept: ${task("['src/**', '!src/*.json']")},
    } }\n`,
  )
  await writeFile(path.join(root, 'bun.lock'), BUN)
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource(['bun()'], `import { bun } from ${JSON.stringify(PLUGIN_INDEX)}\n`),
  )
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  const log = new Proxy({}, { get: () => () => {} }) as Logger
  const plan = await planRun({ cwd: root, tasks: ['json', 'star', 'named', 'kept'], log })
  const files = Object.fromEntries(plan.tasks.map((t) => [t.node.id, t.node.config.inputs?.files]))
  expect(files).toEqual({
    'a#json': ['**/*', '!**/*.json'],
    'a#star': ['src/**', '!*'],
    'a#named': ['src/**', '!package.json'],
    'a#kept': ['src/**', '!src/*.json', 'package.json'],
  })
})
