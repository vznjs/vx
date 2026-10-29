// `sh` drops a variable whose name is no shell identifier before the task
// runs, and core refuses one in `exec.env.passThrough`: a turbo.json naming
// `p-q` mapped to a config that no longer loaded. The key still reads it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { mapTurboWorkspace } from '../src/turbo/turbo-map.js'
import { ownSplice } from './helpers/turbo-own.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-turbo-shell-names-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('turbo-map: an env name no shell can hold', () => {
  it('is left out of passThrough and kept in the key', async () => {
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({
        tasks: { build: { env: ['my.var', 'A'], passThroughEnv: ['p-q', 'P'], outputs: [] } },
      }),
    )
    const dir = path.join(root, 'packages', 'a')
    await mkdir(dir, { recursive: true })
    const metas: PackageMeta[] = [
      {
        name: 'a',
        dir,
        packageJson: { name: 'a', scripts: { build: 'tsc' } } as never,
        configPath: null,
      },
    ]
    const m = await mapTurboWorkspace(root, metas, {
      splice: ownSplice,
      persistentTodo: 'P',
    })
    const t = m.projects[0]!.tasks[0]!.task as {
      inputs: { env: unknown[] }
      exec: { env: { passThrough: unknown[] } }
    }
    expect([t.inputs.env, t.exec.env.passThrough]).toEqual([
      ['my.var', 'A'],
      ['A', 'P'],
    ])
  })
})
