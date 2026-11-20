// A package with no script for a task becomes a group: no command, so no
// exec.env.passThrough. Its config still imported (or, sealed, declared)
// globalPassThroughEnv and never read it: astro's `scripts` package, whose
// tsc -b runs with noUnusedLocals, failed `astro#build` on it (TS6133).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { migrateTurbo } from '../src/migrate-turbo.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-migrate-group-preset-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('a group task imports no pass-through preset it never spreads', async () => {
  await writeFile(
    path.join(root, 'turbo.json'),
    JSON.stringify({
      globalEnv: ['G'],
      tasks: {
        transit: { dependsOn: ['^transit'] },
        build: { dependsOn: ['transit'], outputs: [] },
      },
    }),
  )
  const metas: PackageMeta[] = []
  for (const [name, scripts, dependencies] of [
    ['app', { build: 'tsc' }, { scripts: 'workspace:*' }],
    ['scripts', {}, {}],
    ['lib', { build: 'tsc' }, {}],
  ] as const) {
    const dir = path.join(root, 'packages', name)
    await mkdir(dir, { recursive: true })
    const packageJson = { name, scripts, dependencies } as never
    metas.push({ name, dir, packageJson, configPath: null })
  }
  const p = await migrateTurbo(root, metas)
  const imports = Object.fromEntries(p.projects.map((x) => [x.name, x.importLines.join('\n')]))
  expect(imports['app']).toContain('globalPassThroughEnv')
  expect(imports['scripts']).not.toContain('globalPassThroughEnv')
  expect(imports['scripts']).toContain('globalEnvInputs')
})
