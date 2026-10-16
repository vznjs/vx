// typescript-eslint's ast-spec: `test` outputs `{projectRoot}/**/*.shot`,
// the snapshots are committed, and a dependant reads `^default`. The twin
// `nx-input:default` reads `**/*`, got `!**/*.shot` from the sibling pass,
// and the tracked pass uncached it as a reader hiding a committed file: a
// twin with no `cache` and no `dependsOn` was written as `{}`, and core
// refused every verb (VX_E_USAGE). A keyed group runs nothing, so core lets
// it read what a task writes: it keeps its key, the committed files in it.

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import type { MigrationPlan } from '@vzn/vx'
import type { PackageMeta } from '../src/packages.js'
import { migrateNx } from '../src/migrate-nx.js'

const graph = {
  nodes: {
    spec: {
      name: 'spec',
      data: {
        root: 'packages/spec',
        targets: {
          test: {
            command: 'vitest',
            cache: true,
            inputs: ['default'],
            outputs: ['{projectRoot}/**/*.shot'],
          },
          write: {
            command: 'gen',
            cache: true,
            inputs: ['default'],
            outputs: ['{projectRoot}/package.json'],
          },
        },
      },
    },
    app: {
      name: 'app',
      data: {
        root: 'packages/app',
        targets: { build: { command: 'tsc', cache: true, inputs: ['^default'] } },
      },
    },
  },
  dependencies: { app: [{ source: 'app', target: 'spec', type: 'static' }], spec: [] },
}

describe('an nx-input twin over a sibling output', () => {
  let root: string
  let plan: MigrationPlan
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-nx-twin-')))
    for (const p of ['spec', 'app']) {
      await mkdir(path.join(root, 'packages', p, 'tests'), { recursive: true })
      await writeFile(path.join(root, 'packages', p, 'package.json'), `{"name":"${p}"}`)
    }
    await writeFile(path.join(root, 'packages/spec/tests/fixtures.shot'), 'snap')
    await writeFile(path.join(root, 'package.json'), '{"name":"root","private":true}')
    await writeFile(path.join(root, 'graph.json'), JSON.stringify(graph))
    for (const argv of [
      ['init', '-q'],
      ['add', '-A'],
    ]) {
      const r = Bun.spawnSync(['git', ...argv], { cwd: root })
      expect(r.exitCode).toBe(0)
    }
    const metas: PackageMeta[] = ['spec', 'app'].map((name) => ({
      name,
      dir: path.join(root, 'packages', name),
      packageJson: { name },
      configPath: null,
    }))
    plan = await migrateNx(root, metas, 'ts', path.join(root, 'graph.json'))
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('stays a keyed group with the committed snapshot and the literal in its key', () => {
    const spec = plan.projects.find((p) => p.name === 'spec')!
    const twin = spec.tasks.find((t) => t.name === 'nx-input:default')!
    expect(twin.task).toEqual({
      inputs: { files: ['package.json', 'project.json', '**/*'] },
    })
    expect(twin.todos).toEqual([])
  })

  // CONTROL: a task that runs keeps the rule; it reads what a sibling writes.
  it('still uncaches a running reader that hides a committed file', () => {
    const spec = plan.projects.find((p) => p.name === 'spec')!
    expect(spec.tasks.find((t) => t.name === 'write')!.task!['cache']).toBeUndefined()
  })
})
