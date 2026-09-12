// The release tree `npm publish` uploads is assembled by
// scripts/build-npm.ts, which nothing but the release workflow ran — so when
// `packages/vx/plugins/` left with the last plugin subpath, the script kept
// copying it and v0.0.19 died at the first assemble step (2026-09-12). These
// pins assemble the real @vzn/vx package on every gate: the copy list is
// derived from the exports map, and every path it names has to exist.
//
// `.unsafe`: the emitted package carries the repo-root README and LICENSE,
// which a sandboxed project task may not read.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { coreEntries, emitMainPackage } from '../scripts/build-npm.ts'

const CORE = path.resolve(import.meta.dir, '..')
const out = mkdtempSync(path.join(tmpdir(), 'vx-build-npm-'))
afterAll(() => rmSync(out, { recursive: true, force: true }))

interface Manifest {
  name: string
  version: string
  files: string[]
  exports: Record<string, unknown>
  bin: Record<string, string>
}

const mainDir = await emitMainPackage({ version: '9.9.9', outDir: out })
const manifest = (await Bun.file(path.join(mainDir, 'package.json')).json()) as Manifest

describe('the published @vzn/vx tree', () => {
  it('is assembled from paths that exist', () => {
    expect(manifest.name).toBe('@vzn/vx')
    expect(manifest.version).toBe('9.9.9')
    const missing = manifest.files.filter((f) => !existsSync(path.join(mainDir, f)))
    expect(missing).toEqual([])
  })

  it('ships the entry the exports map and the launcher name', async () => {
    expect(await Bun.file(path.join(mainDir, 'src', 'index.ts')).exists()).toBe(true)
    expect(await Bun.file(path.join(mainDir, 'index.ts')).exists()).toBe(true)
    expect(manifest.bin).toEqual({ vx: './launcher.mjs' })
    expect(await Bun.file(path.join(mainDir, manifest.bin.vx!)).exists()).toBe(true)
  })

  it('ships a directory twin for every exports subpath', async () => {
    const twins: Array<{ sub: string; present: boolean }> = []
    for (const sub of Object.keys(manifest.exports)) {
      if (sub === '.') continue
      twins.push({
        sub,
        present: await Bun.file(path.join(mainDir, sub, 'index.ts')).exists(),
      })
    }
    expect(twins.filter((t) => !t.present)).toEqual([])
  })

  it('copies exactly what the workspace manifest declares', async () => {
    const core = (await Bun.file(path.join(CORE, 'package.json')).json()) as Manifest
    expect(manifest.exports).toEqual(core.exports)
    expect(manifest.files).toEqual([
      ...coreEntries(core.exports),
      'launcher.mjs',
      'README.md',
      'LICENSE',
    ])
  })
})

describe('coreEntries', () => {
  it('names only the source entries when the map has no subpath', () => {
    expect(coreEntries({ '.': {} })).toEqual(['index.ts', 'src'])
  })

  it('names the top directory of every subpath, once, sorted', () => {
    expect(
      coreEntries({
        '.': {},
        './plugins/schedule-history': {},
        './plugins/local-cache': {},
        './adapters/turbo': {},
      }),
    ).toEqual(['index.ts', 'src', 'adapters', 'plugins'])
  })
})
