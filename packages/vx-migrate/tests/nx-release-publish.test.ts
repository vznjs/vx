// `nx-release-publish` (@nx/js:release-publish), which Nx adds to every
// package, is not written by a migration: one note names the package
// manager's own publish (P2-8). `nx()` still runs it through nx-exec.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, parseNxGraph } from '../src/nx/nx-map.js'

const publish = {
  executor: '@nx/js:release-publish',
  options: {},
  dependsOn: ['^nx-release-publish'],
}
const graph = {
  nodes: {
    a: {
      name: 'a',
      data: {
        root: 'libs/a',
        targets: {
          build: { executor: 'nx:run-commands', options: { command: 'tsc' } },
          'nx-release-publish': publish,
        },
      },
    },
    b: { name: 'b', data: { root: 'libs/b', targets: { 'nx-release-publish': publish } } },
  },
  dependencies: { a: [{ source: 'a', target: 'b', type: 'static' }] },
}

async function map(migration: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-nx-publish-'))
  try {
    await writeFile(path.join(root, 'package.json'), '{"name":"root","private":true}')
    const metas: ProjectMeta[] = ['a', 'b'].map((n) => ({
      name: n,
      dir: path.join(root, 'libs', n),
      packageJson: { name: n },
      configPath: null,
    }))
    return await mapNxWorkspace(root, metas, parseNxGraph(JSON.stringify(graph), 'g'), {
      cacheable: new Set(),
      migration,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('nx-release-publish', () => {
  it('a migration writes no task for it, and one note', async () => {
    const mapped = await map(true)
    expect(mapped.projects.map((p) => [p.name, p.tasks.map((t) => t.name)])).toEqual([
      ['a', ['build']],
      ['b', []],
    ])
    expect(mapped.notes).toEqual([
      '`@nx/js:release-publish` on 2 projects (`nx-release-publish`, Nx release’s publish step) is not written: publish with your package manager (`npm publish`, `pnpm publish -r`, `bun publish`)',
    ])
  })

  // Control: the plugin runs the repo as Nx does, the target included.
  it('nx() keeps it', async () => {
    const mapped = await map(false)
    expect(mapped.projects.map((p) => [p.name, p.tasks.map((t) => t.name)])).toEqual([
      ['a', ['build', 'nx-release-publish']],
      ['b', ['nx-release-publish']],
    ])
    expect(mapped.notes).toEqual([])
  })
})
