// A migrated `vx.config.ts` reads a script's `$npm_package_*` from the
// manifest it imports, as `turbo()`'s migration does: written as the
// value, a version bump left the config printing the old one.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { migrateNx } from '../src/migrate-nx.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-migrate-nx-npm-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('npm_package_* is the imported manifest; npm_lifecycle_event stays the name', async () => {
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  const packageJson = {
    name: 'a',
    version: '1.2.3',
    scripts: { gen: 'echo $npm_package_name $npm_package_version $npm_lifecycle_event' },
  }
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(packageJson))
  await mkdir(path.join(root, '.nx', 'workspace-data'), { recursive: true })
  await writeFile(
    path.join(root, '.nx', 'workspace-data', 'project-graph.json'),
    JSON.stringify({
      nodes: {
        a: {
          name: 'a',
          data: {
            root: 'packages/a',
            targets: { gen: { executor: 'nx:run-script', options: { script: 'gen' } } },
          },
        },
      },
      dependencies: {},
    }),
  )
  const meta: ProjectMeta = { name: 'a', dir, packageJson: packageJson as never, configPath: null }
  const plan = await migrateNx(root, [meta])
  const p = plan.projects[0]!
  const define = (
    p.tasks.find((t) => t.name === 'gen')!.task!['exec'] as {
      env: { define: Record<string, unknown> }
    }
  ).env.define
  expect([
    p.importLines,
    define['npm_package_name'],
    define['npm_package_version'],
    define['npm_lifecycle_event'],
  ]).toEqual([
    ["import pkg from './package.json' with { type: 'json' }"],
    { raw: 'pkg.name' },
    { raw: 'pkg.version' },
    'gen',
  ])
})
