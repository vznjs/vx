// The release tree `npm publish` uploads is assembled by
// scripts/build-npm.ts, which nothing but the release workflow ran — so when
// `packages/vx/plugins/` left with the last plugin subpath, the script kept
// copying it and v0.0.19 died at the first assemble step (2026-09-12). These
// pins assemble the real @vzn/vx package on every gate: the copy list is
// derived from the exports map, and every path it names has to exist.
//
// `.unsafe`: the emitted package carries the repo-root README and LICENSE,
// which a sandboxed project task may not read.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { coreEntries, emitMainPackage, emitPluginPackages } from '../scripts/build-npm.ts'

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

// Item 656: until 0.1.0 only @vzn/vx reached npm, while the docs told users
// to `bunx @vzn/vx-migrate`. Every public workspace package is now emitted
// and published with the release; these rows hold the set and the shape.
describe('the published plugin packages', async () => {
  const REPO = path.resolve(CORE, '..', '..')
  const pluginOut = path.join(out, 'plugins-tree')
  const emitted = await emitPluginPackages({ version: '9.9.9', outDir: pluginOut })

  it('are every public workspace package but @vzn/vx, and no other', async () => {
    const publicNames: string[] = []
    for (const dir of readdirSync(path.join(REPO, 'packages'))) {
      const file = path.join(REPO, 'packages', dir, 'package.json')
      if (!existsSync(file)) continue
      const pkg = (await Bun.file(file).json()) as { name: string; private?: boolean }
      if (pkg.private !== true && pkg.name !== '@vzn/vx') publicNames.push(pkg.name)
    }
    expect(emitted.map((e) => e.name).sort()).toEqual(publicNames.sort())
    // A floor, so a walk that finds nothing cannot agree with an emitter
    // that emits nothing.
    expect(publicNames).toEqual(
      expect.arrayContaining([
        '@vzn/vx-github',
        '@vzn/vx-lockfile',
        '@vzn/vx-mcp',
        '@vzn/vx-migrate',
        '@vzn/vx-otel',
        '@vzn/vx-reapi',
        '@vzn/vx-schedule-history',
      ]),
    )
  })

  it('carry the release version, a peer on the same @vzn/vx and a provenance-ready repository', async () => {
    const shapes: unknown[] = []
    for (const { name, dir } of emitted) {
      const m = (await Bun.file(path.join(dir, 'package.json')).json()) as Record<string, unknown>
      shapes.push({
        name,
        version: m.version,
        peer: (m.peerDependencies as Record<string, string>)['@vzn/vx'],
        repository: m.repository,
        dev: m.devDependencies,
      })
    }
    expect(shapes).toEqual(
      emitted.map(({ name, dir }) => ({
        name,
        version: '9.9.9',
        peer: '^9.9.9',
        repository: {
          type: 'git',
          url: 'git+https://github.com/vznjs/vx.git',
          directory: `packages/${path.basename(dir)}`,
        },
        dev: undefined,
      })),
    )
  })

  it('ship every file they declare, with every bin still executable', async () => {
    const missing: string[] = []
    const notExecutable: string[] = []
    for (const { name, dir } of emitted) {
      const m = (await Bun.file(path.join(dir, 'package.json')).json()) as {
        files: string[]
        bin?: Record<string, string>
      }
      for (const f of m.files) if (!existsSync(path.join(dir, f))) missing.push(`${name}: ${f}`)
      for (const bin of Object.values(m.bin ?? {})) {
        if ((statSync(path.join(dir, bin)).mode & 0o111) === 0)
          notExecutable.push(`${name}: ${bin}`)
      }
    }
    expect(missing).toEqual([])
    expect(notExecutable).toEqual([])
    // CONTROL: the one package with bins has both of them in the tree.
    const migrate = emitted.find((e) => e.name === '@vzn/vx-migrate')!
    expect(existsSync(path.join(migrate.dir, 'src', 'nx-exec.cjs'))).toBe(true)
  })

  // Roadmap 1.2 (item 668): a page that tells a user to install, run or
  // import a package names one this release publishes. The set is the
  // emitter's own output plus @vzn/vx, not a list kept beside it. Design
  // notes and the shipped history quote packages that never shipped
  // (`@vzn/cache`) and are not instructions.
  it('are the only @vzn packages the docs tell a user to install, run or import', () => {
    const published = new Set([...emitted.map((e) => e.name), '@vzn/vx'])
    const walkMd = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name)
        if (name === 'node_modules' || name === 'history' || name === 'design') continue
        if (statSync(p).isDirectory()) walkMd(p, out)
        else if (/\.mdx?$/.test(name)) out.push(p)
      }
      return out
    }
    const pages = [
      path.join(REPO, 'README.md'),
      ...readdirSync(path.join(REPO, 'packages'))
        .map((d) => path.join(REPO, 'packages', d, 'README.md'))
        .filter((f) => existsSync(f)),
      ...walkMd(path.join(CORE, 'docs')),
      ...walkMd(path.join(REPO, 'packages', 'vx-docs', 'src', 'content', 'docs')),
    ]
    const COMMAND =
      /\b(?:bunx|npx|bun x|bun add|bun install|npm i|npm install|pnpm add|pnpm dlx|yarn add|yarn dlx)\b[^\n`]*/g
    const IMPORT = /\bfrom\s+['"](@vzn\/[a-z0-9-]+)/g
    const named = new Map<string, string>()
    for (const file of pages) {
      // The site tree is also @vzn/vx-docs#build's output: a page the import
      // script is rewriting may vanish between the walk and the read.
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const rel = path.relative(REPO, file)
      for (const m of text.matchAll(COMMAND))
        for (const n of m[0].matchAll(/@vzn\/[a-z0-9-]+/g)) named.set(n[0], rel)
      for (const m of text.matchAll(IMPORT)) named.set(m[1]!, rel)
    }
    const unpublished = [...named].filter(([name]) => !published.has(name))
    expect(unpublished).toEqual([])
    // Floor: the adoption entry point the README leads with is seen, so a
    // walk or a pattern that finds nothing cannot pass.
    expect(named.has('@vzn/vx-migrate')).toBe(true)
    expect(named.has('@vzn/vx-lockfile')).toBe(true)
  })

  it('are published by the release workflow, after @vzn/vx', async () => {
    const wf = await Bun.file(path.join(REPO, '.github', 'workflows', 'npm.yml')).text()
    expect(wf).toContain('--only=plugins --out=dist/npm-plugins')
    const core = wf.indexOf('dist/npm/vx \\')
    const plugins = wf.indexOf('dist/npm-plugins/plugins/*; do')
    expect(core).toBeGreaterThan(-1)
    expect(plugins).toBeGreaterThan(core)
  })
})
