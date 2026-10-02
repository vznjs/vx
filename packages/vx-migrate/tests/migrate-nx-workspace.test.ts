// `nx()` applies nx.json's `parallel`, `defaultBase` and `maxCacheSize`
// live; a migration writes a `vx.workspace.ts` that cannot hold them (core
// writes it), so it names each field to add. Silent, nx-examples'
// `parallel: 1` ran on every core once migrated.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { migrateNx } from '../src/migrate-nx.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-migrate-nx-ws-'))
  await mkdir(path.join(root, '.nx', 'workspace-data'), { recursive: true })
  await writeFile(
    path.join(root, '.nx', 'workspace-data', 'project-graph.json'),
    JSON.stringify({ nodes: {}, dependencies: {} }),
  )
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const notes = async (nxJson: unknown): Promise<string[]> => {
  await writeFile(path.join(root, 'nx.json'), JSON.stringify(nxJson))
  return (await migrateNx(root, [])).notes
}

it('names each nx.json run setting the written workspace file needs', async () => {
  expect(await notes({ parallel: 1, defaultBase: 'master', maxCacheSize: '10GB' })).toEqual([
    'nx.json `parallel: 1`: add `concurrency: 1` to vx.workspace.ts',
    'nx.json `defaultBase` "master": add `affectedBase: "master"` to vx.workspace.ts',
    'nx.json `maxCacheSize`: add `cacheRetention: { maxSize: "10GB" }` to vx.workspace.ts',
  ])
  // The legacy spellings Nx still reads.
  expect(
    await notes({
      tasksRunnerOptions: { default: { options: { parallel: 3 } } },
      affected: { defaultBase: 'develop' },
    }),
  ).toEqual([
    'nx.json `parallel: 3`: add `concurrency: 3` to vx.workspace.ts',
    'nx.json `defaultBase` "develop": add `affectedBase: "develop"` to vx.workspace.ts',
  ])
  // CONTROL: none set, `0` is no cap, and the environment is not read.
  process.env['NX_PARALLEL'] = '2'
  try {
    expect(await notes({ maxCacheSize: '0' })).toEqual([])
  } finally {
    delete process.env['NX_PARALLEL']
  }
})
