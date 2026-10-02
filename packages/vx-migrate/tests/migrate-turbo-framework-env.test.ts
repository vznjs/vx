// Turbo infers a framework's variables (Next's NEXT_PUBLIC_*) and hashes
// and passes them. The written configs only named the prefix in a note,
// so a migrated Next build inlined every NEXT_PUBLIC_ value empty. They
// list the names the package's files and its workspace dependencies' spell.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { migrateTurbo } from '../src/migrate-turbo.js'

let root: string
let metas: ProjectMeta[]
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-migrate-fwenv-'))
  await writeFile(
    path.join(root, 'turbo.json'),
    JSON.stringify({ tasks: { build: { outputs: [] } } }),
  )
  const dir = path.join(root, 'apps', 'web')
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(
    path.join(dir, 'src', 'page.tsx'),
    'export const url = process.env.NEXT_PUBLIC_API_URL ?? process.env.SECRET_KEY\n',
  )
  await writeFile(path.join(dir, '.env.example'), 'NEXT_PUBLIC_SITE=\nDATABASE_URL=\n')
  await writeFile(path.join(dir, 'README.md'), 'Set NEXT_PUBLIC_FROM_DOCS.\n')
  const packageJson = {
    name: 'web',
    scripts: { build: 'next build' },
    dependencies: { next: '15', ui: 'workspace:*' },
  }
  metas = [{ name: 'web', dir, packageJson: packageJson as never, configPath: null }]
  // A workspace dependency Next bundles, and a package web does not use.
  for (const [name, spelled] of [
    ['ui', 'NEXT_PUBLIC_FROM_UI'],
    ['other', 'NEXT_PUBLIC_FROM_OTHER'],
  ] as const) {
    const at = path.join(root, 'packages', name)
    await mkdir(at, { recursive: true })
    await writeFile(path.join(at, 'index.ts'), `export const v = process.env.${spelled}\n`)
    metas.push({ name, dir: at, packageJson: { name } as never, configPath: null })
  }
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const env = async () => {
  const p = await migrateTurbo(root, metas)
  const t = p.projects.find((x) => x.name === 'web')!.tasks[0]!.task as {
    cache: { inputs: { env?: unknown } }
    exec: { env?: { passThrough?: unknown } }
  }
  return { env: t.cache.inputs.env, pass: t.exec.env?.passThrough, notes: p.notes }
}

describe('migrateTurbo: a framework Turbo infers', () => {
  it('lists the prefixed names its source, env example and workspace dependencies spell', async () => {
    const git = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: root })
    git('init', '-q')
    git('add', '-A')
    const names = [
      'NEXT_PUBLIC_API_URL',
      'NEXT_PUBLIC_FROM_UI',
      'NEXT_PUBLIC_SITE',
      'NEXT_DEPLOYMENT_ID',
    ]
    expect(await env()).toEqual({
      env: names,
      pass: names,
      notes: [
        'Turbo infers nextjs in web and hashes and passes NEXT_PUBLIC_*, NEXT_DEPLOYMENT_ID to ' +
          'its tasks; the configs list the names their files and their workspace dependencies’ ' +
          'spell — add any only an installed dependency reads to cache.inputs.env and ' +
          'exec.env.passThrough',
      ],
    })
  })

  it('without git lists only the literal names', async () => {
    expect((await env()).env).toEqual(['NEXT_DEPLOYMENT_ID'])
  })
})
