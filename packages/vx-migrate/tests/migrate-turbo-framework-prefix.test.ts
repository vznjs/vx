// formbricks' web spells the bare `NEXT_PUBLIC_` in a `startsWith` test;
// the name scan took it for a variable, and the written config passed and
// keyed one named `NEXT_PUBLIC_`.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { migrateTurbo } from '../src/migrate-turbo.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-migrate-fwprefix-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('a framework prefix spelled alone is no name', async () => {
  await writeFile(
    path.join(root, 'turbo.json'),
    JSON.stringify({ tasks: { build: { outputs: [] } } }),
  )
  const dir = path.join(root, 'apps', 'web')
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'env.ts'),
    'export const pub = Object.keys(process.env).filter((k) => k.startsWith("NEXT_PUBLIC_"))\n' +
      'export const api = process.env.NEXT_PUBLIC_API\n',
  )
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
  Bun.spawnSync(['git', 'add', '-A'], { cwd: root })
  const packageJson = {
    name: 'web',
    scripts: { build: 'next build' },
    dependencies: { next: '15' },
  }
  const p = await migrateTurbo(root, [
    { name: 'web', dir, packageJson: packageJson as never, configPath: null },
  ])
  const t = p.projects[0]!.tasks[0]!.task as { cache: { inputs: { env?: unknown } } }
  expect(t.cache.inputs.env).toEqual(['NEXT_PUBLIC_API', 'NEXT_DEPLOYMENT_ID'])
})
