// Turbo infers a framework's variables (Next's NEXT_PUBLIC_*) and hashes
// and passes them. The written configs only named the prefix in a note,
// so a migrated Next build inlined every NEXT_PUBLIC_ value empty. They
// list the names the package's own files spell.
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
    dependencies: { next: '15' },
  }
  metas = [{ name: 'web', dir, packageJson: packageJson as never, configPath: null }]
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const env = async () => {
  const p = await migrateTurbo(root, metas)
  const t = p.projects[0]!.tasks[0]!.task as {
    cache: { inputs: { env?: unknown } }
    exec: { env?: { passThrough?: unknown } }
  }
  return { env: t.cache.inputs.env, pass: t.exec.env?.passThrough, notes: p.notes }
}

describe('migrateTurbo: a framework Turbo infers', () => {
  it('lists the prefixed names the package source and env example spell', async () => {
    const git = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: root })
    git('init', '-q')
    git('add', '-A')
    const names = ['NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_SITE', 'NEXT_DEPLOYMENT_ID']
    expect(await env()).toEqual({
      env: names,
      pass: names,
      notes: [
        'Turbo infers nextjs in web and hashes and passes NEXT_PUBLIC_*, NEXT_DEPLOYMENT_ID to ' +
          'its tasks; the configs list the names their own files spell — add any only a ' +
          'dependency reads to cache.inputs.env and exec.env.passThrough',
      ],
    })
  })

  it('without git lists only the literal names', async () => {
    expect((await env()).env).toEqual(['NEXT_DEPLOYMENT_ID'])
  })
})
