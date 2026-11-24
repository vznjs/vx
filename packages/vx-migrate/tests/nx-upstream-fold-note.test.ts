// Nx keys a task on its own inputs; vx also folds the key of each task it
// depends on. Against Nx 24.0.6, a spec-file edit re-ran `a#build`
// (`dependsOn: ["gen"]`, `gen` reading `default`) under vx and replayed it
// under Nx, and the migration said nothing (2026-11-24).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-upstream-fold-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function notes(dependsOn: string[], migration: boolean): Promise<string[]> {
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'a' }))
  const meta: PackageMeta = {
    name: 'a',
    dir,
    packageJson: { name: 'a' } as never,
    configPath: null,
  }
  const gen = { command: 'gen', cache: true, inputs: ['{projectRoot}/**/*'], outputs: [] }
  const build = {
    command: 'tsc',
    cache: true,
    dependsOn,
    inputs: ['{projectRoot}/**/*', '!{projectRoot}/**/*.spec.ts'],
    outputs: [],
  }
  const nodes = { a: { data: { root: 'packages/a', targets: { gen, build } } } }
  const graph = { nodes, dependencies: { a: [] } } as NxGraph
  return (await mapNxWorkspace(root, [meta], graph, { cacheable: new Set(), migration })).notes
}

it('a migration says vx keys a task on the tasks it depends on, as Nx does not', async () => {
  expect(await notes(['gen'], true)).toContain(
    'Nx keys a task on its own inputs only; vx also keys it on each task it depends on, ' +
      'so an input only that task reads (a spec file under `default`) re-runs it here, where Nx replays it: ' +
      '1 task (a#build) — `inputs.tasks: []` in its vx.config decouples it as Nx does, ' +
      'and a hit may then replay output built from an older upstream',
  )
})

it('says nothing of a task that depends on nothing', async () => {
  expect((await notes([], true)).join('\n')).not.toContain('Nx keys a task on its own inputs')
})

it('control: nx() says nothing on every `vx lock`', async () => {
  expect((await notes(['gen'], false)).join('\n')).not.toContain('Nx keys a task on its own inputs')
})
