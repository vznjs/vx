// Bun 1.4.0's compiled binaries resolve an on-disk package by directory
// convention — `<pkg>/index.ts`, `<pkg>/<subpath>/index.ts` — and ignore
// package.json `exports` / `main` (measured 2026-09-03). So every package a
// workspace config can import carries a root shim that re-exports the real
// entry. These pins keep the shims present, shipped, and identical to what
// the exports map names — a shim that drifted would give the binary a
// different `@vzn/vx` from everyone else's.
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const PACKAGES = path.resolve(import.meta.dir, '../..')

const SHIMS: ReadonlyArray<[pkg: string, shim: string, real: string]> = [
  ['vx', 'index.ts', 'src/index.ts'],
  ['vx', 'plugins/local-cache/index.ts', 'src/plugins/local-cache/index.ts'],
  ['vx', 'plugins/local-executor/index.ts', 'src/plugins/local-executor/index.ts'],
  ['vx', 'plugins/schedule-history/index.ts', 'src/plugins/schedule-history/index.ts'],
  ['vx-otel', 'index.ts', 'src/index.ts'],
  ['vx-github', 'index.ts', 'src/index.ts'],
  ['vx-reapi', 'index.ts', 'src/index.ts'],
  ['vx-mcp', 'index.ts', 'src/index.ts'],
]

describe('root entry shims for compiled binaries', () => {
  it.each(SHIMS)('%s/%s re-exports exactly %s', async (pkg, shim, real) => {
    const shimMod = (await import(path.join(PACKAGES, pkg, shim))) as Record<string, unknown>
    const realMod = (await import(path.join(PACKAGES, pkg, real))) as Record<string, unknown>
    expect(Object.keys(shimMod).sort()).toEqual(Object.keys(realMod).sort())
    for (const k of Object.keys(realMod)) expect(shimMod[k]).toBe(realMod[k])
  })

  it.each(['vx', 'vx-otel', 'vx-github', 'vx-reapi', 'vx-mcp'])(
    '%s ships its shim (package.json files)',
    async (pkg) => {
      const manifest = (await Bun.file(path.join(PACKAGES, pkg, 'package.json')).json()) as {
        files: string[]
        exports: Record<string, unknown>
      }
      expect(manifest.files).toContain('index.ts')
      // Every subpath the exports map offers has a directory-convention twin.
      for (const sub of Object.keys(manifest.exports)) {
        if (sub === '.') continue
        const twin = path.join(PACKAGES, pkg, sub, 'index.ts')
        expect({ sub, present: await Bun.file(twin).exists() }).toEqual({ sub, present: true })
      }
      if (Object.keys(manifest.exports).length > 1) expect(manifest.files).toContain('plugins')
    },
  )
})
