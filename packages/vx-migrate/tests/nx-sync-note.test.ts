// A migration leaves Nx behind, so its sync-generator note cannot say
// "run `nx sync`" (P2-12): it names what the generator kept. `nx()`, run
// with Nx installed, keeps the `nx sync` advice.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, parseNxGraph } from '../src/nx/nx-map.js'

const graph = {
  nodes: {
    a: {
      name: 'a',
      data: {
        root: 'libs/a',
        targets: {
          typecheck: { command: 'tsc --build', syncGenerators: ['@nx/js:typescript-sync'] },
        },
      },
    },
  },
  dependencies: {},
}

async function notes(migration: boolean): Promise<string[]> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-nx-sync-'))
  try {
    await writeFile(path.join(root, 'package.json'), '{"name":"root","private":true}')
    await writeFile(
      path.join(root, 'nx.json'),
      '{"sync":{"globalGenerators":["@acme/tools:sync-env"]}}',
    )
    const metas: ProjectMeta[] = [
      {
        name: 'a',
        dir: path.join(root, 'libs', 'a'),
        packageJson: { name: 'a' },
        configPath: null,
      },
    ]
    const mapped = await mapNxWorkspace(root, metas, parseNxGraph(JSON.stringify(graph), 'g'), {
      cacheable: new Set(),
      migration,
    })
    return mapped.notes
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const KEEP =
  'keep what they write (`@nx/js:typescript-sync`: the tsconfig `references`) up to date by hand'

describe('sync generators', () => {
  it('a migration names what they kept, not `nx sync`', async () => {
    expect(await notes(true)).toEqual([
      `nx.json \`sync.globalGenerators\` ("@acme/tools:sync-env"): Nx runs them before a run, and vx does not — ${KEEP}`,
      `\`syncGenerators\` ("@nx/js:typescript-sync") on 1 task: Nx runs them before those targets, and vx does not — ${KEEP}`,
    ])
  })

  // Control: nx() runs with Nx installed.
  it('nx() keeps `nx sync`', async () => {
    expect(await notes(false)).toEqual([
      'nx.json `sync.globalGenerators` ("@acme/tools:sync-env"): Nx runs them before a run, and vx does not — run `nx sync` when they are out of date',
      '`syncGenerators` ("@nx/js:typescript-sync") on 1 task: Nx runs them before those targets, and vx does not — run `nx sync` when they are out of date',
    ])
  })
})
