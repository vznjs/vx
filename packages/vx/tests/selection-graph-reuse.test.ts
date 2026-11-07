// A selection pass hands the run its package graph only when no task edge
// changed it: the run builds the edge-free one, and a graph with a new
// `pkg#task` edge folded in is not it.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolveFilters } from '../src/cli/select.js'
import { graphOfDiscovery } from '../src/orchestrator/projects.js'
import { lock } from './helpers/orchestrator.js'
import { gitInit } from './helpers/workspace.js'
import { writeEdges } from './helpers/plugin.js'
import { buildPackageGraph } from '../src/workspace/index.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const TIMEOUT = 30_000

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-selection-graph-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'root', private: true }))
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
  for (const name of ['app', 'lib']) {
    const dir = path.join(root, 'packages', name)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `export default { tasks: { build: { exec: { command: 'true' }${
        name === 'app' ? ", dependsOn: ['lib#build']" : ''
      } } } }\n`,
    )
  }
  await lock(root)
  gitInit(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const handed = async (filter: string): Promise<{ names: string[]; graph: boolean }> => {
  const r = await resolveFilters(root, [filter])
  if (!('names' in r)) throw new Error(JSON.stringify(r))
  const graph = graphOfDiscovery(r.discovered.projects)
  if (graph !== undefined) {
    // What the run would have built itself.
    const own = buildPackageGraph(r.discovered.projects)
    for (const { name } of r.discovered.projects) {
      expect(graph.directDeps(name)).toEqual(own.directDeps(name))
      expect(graph.transitiveDeps(name)).toEqual(own.transitiveDeps(name))
      expect(graph.transitiveDependents(name)).toEqual(own.transitiveDependents(name))
    }
    expect(graph.edgeSource).toBe(own.edgeSource)
  }
  return { names: r.names, graph: graph !== undefined }
}

describe("a selection's package graph", () => {
  it(
    'is handed to the run when no task edge went into it',
    async () => {
      expect(await handed('app')).toEqual({ names: ['app'], graph: true })
    },
    TIMEOUT,
  )

  it(
    'is not when the walk folded task edges in (`app...` reaches lib through app#build)',
    async () => {
      expect(await handed('app...')).toEqual({ names: ['app', 'lib'], graph: false })
    },
    TIMEOUT,
  )

  // `--affected` is a `...` walk, so it read task edges and handed nothing,
  // and the run built the same graph and its closures again.
  it(
    'is handed when the walk read task edges and none was new (no cross-project dependsOn)',
    async () => {
      await writeFile(
        path.join(root, 'packages/app/vx.config.mjs'),
        `export default { tasks: { build: { exec: { command: 'true' } } } }\n`,
      )
      await lock(root)
      expect(await handed('lib...')).toEqual({ names: ['lib'], graph: true })
    },
    TIMEOUT,
  )

  it(
    'is handed when each task edge is a discovered edge already',
    async () => {
      await writeEdges(root, { app: ['lib'] })
      await lock(root)
      expect(await handed('app...')).toEqual({ names: ['app', 'lib'], graph: true })
    },
    TIMEOUT,
  )
})
