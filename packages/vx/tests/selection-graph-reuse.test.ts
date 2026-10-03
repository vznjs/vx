// A selection pass hands the run its package graph only when it built that
// graph without task edges: the run builds the edge-free one, and a graph
// with a `pkg#task` edge folded in is not it.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolveFilters } from '../src/cli/select.js'
import { graphOfDiscovery } from '../src/orchestrator/projects.js'
import { gitInit } from './helpers/workspace.js'

const TIMEOUT = 30_000

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-selection-graph-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'root', private: true }))
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
  gitInit(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const handed = async (filter: string): Promise<{ names: string[]; graph: boolean }> => {
  const r = await resolveFilters(root, [filter])
  if (!('names' in r)) throw new Error(JSON.stringify(r))
  return { names: r.names, graph: graphOfDiscovery(r.discovered.projects) !== undefined }
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
})
