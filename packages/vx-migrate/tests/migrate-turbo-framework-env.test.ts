// Turbo infers a framework's variables (Next's NEXT_PUBLIC_*) and hashes
// and passes them. The written configs only named the prefix in a note,
// so a migrated Next build inlined every NEXT_PUBLIC_ value empty. They
// key the prefix as written: core matches it each run.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { migrateTurbo } from '../src/migrate-turbo.js'
import { BUILTIN_FAMILIES_NOTE } from './helpers/turbo-own.js'

let root: string
let metas: PackageMeta[]
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
    inputs: { env?: unknown }
    exec: { env?: { passThrough?: unknown } }
  }
  return { env: t.inputs.env, pass: t.exec.env?.passThrough, notes: p.notes }
}

describe('migrateTurbo: a framework Turbo infers', () => {
  it('keys and passes the framework names as written, the same with git or without', async () => {
    const expected = {
      env: ['NEXT_PUBLIC_*', 'NEXT_DEPLOYMENT_ID', 'VERCEL_DEPLOYMENT_ID'],
      pass: undefined,
      notes: [BUILTIN_FAMILIES_NOTE],
    }
    expect(await env()).toEqual(expected)
    const git = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: root })
    git('init', '-q')
    git('add', '-A')
    expect(await env()).toEqual(expected)
  })

  it('infers Next only for the package that depends on next (vercel/turborepo#14188)', async () => {
    // `other` spells a NEXT_PUBLIC_ name and builds, but has no next dependency.
    const other = metas.find((m) => m.name === 'other')!
    other.packageJson = { name: 'other', scripts: { build: 'tsc' } } as never
    const git = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: root })
    git('init', '-q')
    git('add', '-A')
    const p = await migrateTurbo(root, metas)
    const t = p.projects.find((x) => x.name === 'other')!.tasks[0]!.task as {
      inputs: { env?: unknown }
      exec: { env?: { passThrough?: unknown } }
    }
    expect(JSON.stringify([t.inputs.env, t.exec.env?.passThrough])).not.toContain('NEXT_')
    expect(p.notes.filter((n) => n.includes('in other'))).toEqual([])
  })
})
