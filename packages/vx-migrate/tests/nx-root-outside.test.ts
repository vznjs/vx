// An Nx graph node whose `root` leaves the workspace (`../x`) is no
// project to migrate: its vx.config and package.json were written outside
// the repository vx-migrate ran in.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { migrateNx } from '../src/migrate-nx.js'

it('a node rooted outside the workspace plans no file', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'vx-nx-outside-'))
  const root = path.join(base, 'repo')
  try {
    await mkdir(path.join(root, 'libs/in'), { recursive: true })
    await mkdir(path.join(base, 'out'), { recursive: true })
    await writeFile(path.join(root, 'package.json'), '{"name":"r","private":true}')
    const node = (name: string, r: string) => ({
      name,
      data: { root: r, targets: { build: { command: 'tsc' } } },
    })
    const graph = {
      graph: {
        nodes: { in: node('in', 'libs/in'), up: node('up', '../out') },
        dependencies: {},
      },
    }
    await writeFile(path.join(root, 'graph.json'), JSON.stringify(graph))
    const p = await migrateNx(root, [], 'ts', path.join(root, 'graph.json'))
    expect(p.projects.map((x) => path.relative(root, x.dir))).toEqual(['libs/in'])
    expect(p.extraFiles.map((f) => f.relPath)).toEqual(['libs/in/package.json'])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
