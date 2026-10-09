// withastro/astro: `scripts/tsconfig.json` is a composite project that
// type-checks every file under scripts/, so the written config's import of
// the root vx-preset failed its build (TS6059, TS6307). A package whose
// tsconfig would refuse that import declares the values itself.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { migrateTurbo } from '../src/migrate-turbo.js'
import { sealsConfig } from '../src/sealed-tsconfig.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-migrate-sealed-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function plan(tsconfigs: Record<string, object>) {
  await writeFile(
    path.join(root, 'turbo.json'),
    JSON.stringify({ globalEnv: ['G'], tasks: { build: { env: ['A', 'B', 'C'], outputs: [] } } }),
  )
  await writeFile(
    path.join(root, 'tsconfig.base.json'),
    '{ // JSONC, as tsc reads it\n "compilerOptions": { "composite": true, }, }\n',
  )
  const metas: ProjectMeta[] = []
  for (const name of ['a', 'b', 'c']) {
    const dir = path.join(root, 'packages', name)
    await mkdir(dir, { recursive: true })
    if (tsconfigs[name] !== undefined)
      await writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify(tsconfigs[name]))
    const scripts = { build: 'tsc' }
    metas.push({ name, dir, packageJson: { name, scripts } as never, configPath: null })
  }
  return migrateTurbo(root, metas)
}

describe('migrateTurbo: a package whose tsconfig refuses files outside it', () => {
  it('declares the preset values its config uses; the others import them', async () => {
    const p = await plan({
      b: { extends: '../../tsconfig.base.json' },
      // Composite, but its project never reads the config: it imports.
      c: { compilerOptions: { composite: true }, include: ['src'] },
    })
    expect({
      imports: p.projects.map((x) => x.importLines),
      preset: p.extraFiles.map((f) => f.relPath),
    }).toEqual({
      imports: [
        ["import { buildEnv, globalEnvInputs } from '../../vx-preset.js'"],
        ["const globalEnvInputs = ['G']", "const buildEnv = ['A', 'B', 'C']"],
        ["import { buildEnv, globalEnvInputs } from '../../vx-preset.js'"],
      ],
      preset: ['vx-preset.ts'],
    })
  })

  it('writes no preset when no config imports it', async () => {
    const sealed = { compilerOptions: { rootDir: '.' } }
    const p = await plan({ a: sealed, b: sealed, c: sealed })
    expect(p.extraFiles).toEqual([])
    expect(p.projects.every((x) => !x.importLines.some((l) => l.startsWith('import')))).toBe(true)
  })

  it('sealsConfig: composite or rootDir, own or extended, whose project takes the file', async () => {
    const at = async (name: string, body: string) => {
      const dir = path.join(root, name)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'tsconfig.json'), body)
      return sealsConfig(dir, 'vx.config.mjs')
    }
    await writeFile(path.join(root, 'base.json'), '{"compilerOptions":{"composite":true}}')
    expect([
      await at('composite', '{"compilerOptions":{"composite":true}}'),
      await at('rootdir', '{"compilerOptions":{"rootDir":"src"}}'),
      await at('extended', '{"extends":"../base.json"}'),
      await at('extended-bare', '{"extends":"../base"}'),
      await at('included', '{"compilerOptions":{"composite":true},"include":["*.mjs"]}'),
      await at('plain', '{"compilerOptions":{"strict":true}}'),
      await at('package', '{"extends":"@tsconfig/node20/tsconfig.json"}'),
      await at('elsewhere', '{"compilerOptions":{"composite":true},"include":["src/**"]}'),
      await at('files', '{"compilerOptions":{"composite":true},"files":["index.ts"]}'),
      await at('broken', '{ not json'),
    ]).toEqual([true, true, true, true, true, false, false, false, false, false])
    expect(sealsConfig(path.join(root, 'none'), 'vx.config.mjs')).toBe(false)
  })
})
