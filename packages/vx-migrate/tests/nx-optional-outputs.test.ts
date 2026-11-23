// Nx caches whichever of a target's outputs exist; vx fails a task one of
// whose output patterns matched nothing. TanStack/store's shared `build`
// outputs (`build`, `dist`) failed every project that writes only `dist`,
// and the migration said nothing (2026-11-23).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-optional-outputs-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function meta(name: string): Promise<PackageMeta> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
  return { name, dir, packageJson: { name } as never, configPath: null }
}

async function notes(outputs: string[], migration: boolean): Promise<string[]> {
  const build = { command: 'tsdown', cache: true, inputs: ['{projectRoot}/**/*'], outputs }
  const nodes = { store: { data: { root: 'packages/store', targets: { build } } } }
  const graph = { nodes, dependencies: { store: [] } } as NxGraph
  const m = await mapNxWorkspace(root, [await meta('store')], graph, {
    cacheable: new Set(),
    migration,
  })
  return m.notes
}

it('a migration names the outputs Nx treats as optional and vx requires', async () => {
  expect(await notes(['{projectRoot}/build', '{projectRoot}/dist'], true)).toContain(
    `Nx caches whichever of a target's outputs exist; vx fails a task when one of its output patterns matches nothing ("outputs matched no files"): 1 task declares outputs, 1 more than one (store#build) — remove each pattern its command never writes`,
  )
})

it('control: nx() says nothing, as the run names the task', async () => {
  expect((await notes(['{projectRoot}/dist'], false)).join('\n')).not.toContain('outputs matched')
})
