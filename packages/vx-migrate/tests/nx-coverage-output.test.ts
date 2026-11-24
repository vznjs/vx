// Nx caches whichever outputs exist; vx fails a task that wrote none of its
// outputs. @nx/vitest infers `{workspaceRoot}/coverage/{projectRoot}` on every
// test target, written only with coverage on, so `vtest` failed every vx run
// of a real Nx 24 workspace without it (2026-11-24).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-coverage-output-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function todos(outputs: string[], migration: boolean): Promise<string[]> {
  const dir = path.join(root, 'packages', 'ui')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'ui' }))
  const meta: PackageMeta = {
    name: 'ui',
    dir,
    packageJson: { name: 'ui' } as never,
    configPath: null,
  }
  const vtest = { command: 'vitest run', cache: true, inputs: ['{projectRoot}/**/*'], outputs }
  const nodes = { ui: { data: { root: 'packages/ui', targets: { vtest } } } }
  const graph = { nodes, dependencies: { ui: [] } } as NxGraph
  const m = await mapNxWorkspace(root, [meta], graph, { cacheable: new Set(), migration })
  return m.projects[0]!.tasks.find((t) => t.name === 'vtest')!.todos
}

const todo =
  "Nx treats outputs as optional; vx fails a task that writes none of its declared outputs: drop `coverage/packages/ui` from vtest's outputs or run it with coverage"

it('a migration names a coverage output as a todo', async () => {
  expect(await todos(['{workspaceRoot}/coverage/{projectRoot}'], true)).toContain(todo)
})

it('says nothing of an output that is not coverage', async () => {
  expect((await todos(['{projectRoot}/dist'], true)).join('\n')).not.toContain('optional')
})

it('control: nx() says nothing, as the run names the task', async () => {
  expect(await todos(['{workspaceRoot}/coverage/{projectRoot}'], false)).not.toContain(todo)
})
