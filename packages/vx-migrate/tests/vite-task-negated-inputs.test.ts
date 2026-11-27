// A `!` input under one base with no positive glob under that base: core
// refuses a list of negations alone ("selects NOTHING"), so the written
// config failed `vx lock`. Measured on vite-plus 1.8.0: a negation only
// takes back what a positive glob matched.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { mapViteTaskWorkspace } from '../src/vite-task/vite-task-map.js'

let root: string
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('a negation with no positive glob under its base takes back from the other base', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-migrate-vtneg-'))
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws' }))
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'a' }))
  const ws = (pattern: string) => `{ pattern: '${pattern}', base: 'workspace' }`
  await writeFile(
    path.join(dir, 'vite.config.ts'),
    `export default { run: { tasks: {
      outside: { command: 'x', cache: { input: ['src/**', ${ws('!docs/**')}], output: [] } },
      inside: { command: 'x', cache: { input: ['src/**', ${ws('!packages/a/src/gen/**')}], output: [] } },
      shared: { command: 'x', cache: { input: [${ws('packages/**')}, '!**/*.md'], output: [] } },
    } } }`,
  )
  await writeFile(
    path.join(root, 'vite.config.ts'),
    `export default { run: { tasks: {
      top: { command: 'x', cache: { input: ['!**/*.md'], output: [] } },
    } } }`,
  )
  const metas = [
    { name: 'a', dir, packageJson: { name: 'a' } as never, configPath: null },
    { name: 'ws', dir: root, packageJson: { name: 'ws' } as never, configPath: null },
  ]
  const m = await mapViteTaskWorkspace(root, metas)
  const inputs: Record<string, unknown> = {}
  for (const p of m.projects) for (const t of p.tasks) inputs[t.name] = t.task!['inputs']
  expect(inputs).toEqual({
    outside: { files: ['src/**'] },
    inside: { files: ['src/**', '!src/gen/**'] },
    shared: { files: [], workspaceFiles: ['packages/**', '!packages/a/**/*.md'] },
    top: { files: ['**/*', '!**/*.md'] },
  })
})
