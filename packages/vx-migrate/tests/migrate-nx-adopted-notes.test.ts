// After `bunx @vzn/vx-migrate` writes native configs in an Nx repo, the
// report says what vx.workspace.ts still holds (P2-10): the `nx()` that
// `vx init` declared, which keeps reading nx.json, and a lockfile with no
// `@vzn/vx-lockfile` plugin, which re-runs every task on a bump where Nx
// re-ran only the projects that use the package.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { migrateNx } from '../src/migrate-nx.js'

const graph = {
  nodes: {
    a: { name: 'a', data: { root: 'libs/a', targets: { build: { command: 'tsc' } } } },
  },
  dependencies: {},
}
const NX =
  'vx.workspace.ts still declares nx(), which reads nx.json every run and fills any task a ' +
  'vx.config does not declare; the configs written here declare them all. Once `vx run` does ' +
  'what nx did, remove nx() (and its import), then nx.json'
const LOCK =
  'Nx keys each project on the npm packages it depends on in pnpm-lock.yaml; vx keys every ' +
  'task on the whole file, so a dependency bump re-runs them all. Declare pnpm() from ' +
  "@vzn/vx/plugins in vx.workspace.ts to key each task on its package's dependency closure"

async function headerNotes(files: Record<string, string>): Promise<string[]> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-nx-adopted-'))
  try {
    await writeFile(path.join(root, 'package.json'), '{"name":"root","private":true}')
    await writeFile(path.join(root, 'graph.json'), JSON.stringify(graph))
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, name), text)
    const metas: ProjectMeta[] = [
      {
        name: 'a',
        dir: path.join(root, 'libs', 'a'),
        packageJson: { name: 'a' },
        configPath: null,
      },
    ]
    const plan = await migrateNx(root, metas, 'ts', path.join(root, 'graph.json'))
    return plan.headerNotes.slice(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const NX_WORKSPACE = "import { nx } from '@vzn/vx-migrate'\nexport default { plugins: [nx()] }\n"

describe('migrateNx: what vx.workspace.ts still holds', () => {
  it('nx() declared and a lockfile with no plugin: both notes', async () => {
    expect(
      await headerNotes({
        'vx.workspace.ts': NX_WORKSPACE,
        'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      }),
    ).toEqual([NX, LOCK])
  })

  it('a lockfile plugin declared: no lockfile note', async () => {
    expect(
      await headerNotes({
        'vx.workspace.ts':
          "import { nx } from '@vzn/vx-migrate'\nimport { pnpm } from '@vzn/vx/plugins'\n" +
          'export default { plugins: [nx(), pnpm()] }\n',
        'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      }),
    ).toEqual([NX])
  })

  // Control: a workspace already native says nothing.
  it('no nx() and no lockfile: none', async () => {
    expect(await headerNotes({ 'vx.workspace.ts': 'export default {}\n' })).toEqual([])
  })
})
