// An Nx `implicitDependencies: ["!a"]` drops a manifest edge from the graph,
// often to break a cycle (P2-22). vx's `^build` follows the manifest, so
// the migrated configs brought the cycle back and core refused the run:
// such a `^name` is the explicit edges Nx draws instead.

import { describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, parseNxGraph } from '../src/nx/nx-map.js'

const build = {
  command: 'tsc',
  cache: true,
  dependsOn: ['^build'],
  outputs: ['{projectRoot}/dist'],
}
const meta = (name: string, packageJson: Record<string, unknown>): ProjectMeta => ({
  name,
  dir: `/w/libs/${name}`,
  packageJson: { name, ...packageJson } as ProjectMeta['packageJson'],
  configPath: null,
})

async function dependsOn(bImplicit: string[], bManifest: Record<string, unknown>) {
  const graph = {
    nodes: {
      a: { name: 'a', data: { root: 'libs/a', targets: { build } } },
      b: {
        name: 'b',
        data: { root: 'libs/b', implicitDependencies: bImplicit, targets: { build } },
      },
      c: { name: 'c', data: { root: 'libs/c', targets: { build } } },
    },
    dependencies: {
      a: [{ source: 'a', target: 'b', type: 'static' }],
      b: [{ source: 'b', target: 'c', type: 'static' }],
      c: [],
    },
  }
  const metas = [
    meta('a', { dependencies: { b: '*' } }),
    meta('b', { dependencies: { c: '*' }, ...bManifest }),
    meta('c', {}),
  ]
  const mapped = await mapNxWorkspace('/w', metas, parseNxGraph(JSON.stringify(graph), 'g'), {
    cacheable: new Set(),
    migration: true,
  })
  // The input twins (`nx-input:default`) are another rule's edges.
  const own = (d: unknown) => !String(d).includes('#nx-input:')
  return Object.fromEntries(
    mapped.projects.map((p) => [
      p.name,
      (p.tasks.find((t) => t.name === 'build')!.task!['dependsOn'] as unknown[]).filter(own),
    ]),
  )
}

describe('a manifest edge the Nx graph dropped', () => {
  it('is no `^` edge: the dependency Nx keeps is named, the one it dropped is not', async () => {
    expect(await dependsOn(['!a'], { devDependencies: { a: '*' } })).toEqual({
      a: ['^build'],
      b: ['c#build'],
      c: ['^build'],
    })
  })

  // Control: manifest and graph agree, so `^build` stays as written.
  it('a manifest the graph agrees with keeps `^build`', async () => {
    expect(await dependsOn([], {})).toEqual({ a: ['^build'], b: ['^build'], c: ['^build'] })
  })
})
