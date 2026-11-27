// A `!` input or output under one base with no positive glob under that
// base: an input was written as a list of negations alone, which core
// refuses ("selects NOTHING"), and an output's was dropped. Measured on
// vite-plus 1.8.0: a negation takes back what a positive glob under either
// base matched.

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
      deep: { command: 'x', cache: { input: ['src/**', ${ws('!**/*.md')}, ${ws('!packages/*/src/*.snap')}], output: [] } },
      shared: { command: 'x', cache: { input: [${ws('packages/**')}, '!**/*.md'], output: [] } },
      out: { command: 'x', cache: { input: [], output: ['dist/**', ${ws('!packages/a/dist/x/**')}] } },
      outWs: { command: 'x', cache: { input: [], output: [${ws('out/**')}, '!out/**/*.map'] } },
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
  const outputs: Record<string, unknown> = {}
  for (const p of m.projects)
    for (const t of p.tasks) {
      inputs[t.name] = t.task!['inputs']
      outputs[t.name] = t.task!['outputs']
    }
  expect(inputs).toEqual({
    outside: { files: ['src/**'] },
    inside: { files: ['src/**', '!src/gen/**'] },
    deep: { files: ['src/**', '!**/*.md', '!src/*.snap'] },
    shared: { files: [], workspaceFiles: ['packages/**', '!packages/a/**/*.md'] },
    top: { files: ['**/*', '!**/*.md'] },
    out: { files: [] },
    outWs: { files: [] },
  })
  // Dropped, `dist/x` was cleaned before each run and saved, which Vite
  // Task neither archives nor restores.
  expect(outputs['out']).toEqual({ files: ['dist/**', '!dist/x/**'] })
  expect(outputs['outWs']).toEqual({
    files: [],
    workspaceFiles: ['out/**', '!packages/a/out/**/*.map'],
  })
})
