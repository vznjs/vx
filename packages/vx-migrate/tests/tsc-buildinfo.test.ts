// `tsc -b` with rootDir `src` and outDir `dist` keeps its buildinfo beside
// the tsconfig, outside turbo.json's `dist/**`. vx cleaned `dist/` before a
// miss, tsc re-emitted only the edited file, and vx cached that partial
// `dist/` (Growth, migrate-tsc-build-partial-dist). Nx infers the buildinfo
// as an output; a mapped task declares it.
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { run } from '../../vx/tests/helpers/orchestrator.js'
import { migrateTurbo } from '../src/migrate-turbo.js'
import type { PackageMeta } from '../src/packages.js'
import { onceReader, tscBuildInfo } from '../src/tsc-buildinfo.js'
import { silent, useTurboWorkspace } from './helpers/turbo-workspace.js'

// tsc's incremental contract: emit only a source the buildinfo does not hold.
const FAKE_TSC = `#!/bin/sh
touch tsconfig.tsbuildinfo
mkdir -p dist
for f in src/*.ts; do
  n=$(basename "$f" .ts); s=$(cksum < "$f")
  grep -qxF "$n $s" tsconfig.tsbuildinfo || cp "$f" "dist/$n.js"
done
for f in src/*.ts; do echo "$(basename "$f" .ts) $(cksum < "$f")"; done > tsconfig.tsbuildinfo.new
mv tsconfig.tsbuildinfo.new tsconfig.tsbuildinfo
`

const ws = useTurboWorkspace({ tasks: { build: { outputs: ['dist/**'] } } })

describe('turbo(): a `tsc -b` build whose buildinfo sits outside its outputs', () => {
  it('builds a whole dist after an edit', async () => {
    const lib = path.join(ws.root, 'packages', 'lib')
    await writeFile(path.join(ws.root, '.gitignore'), 'dist\nnode_modules\n*.tsbuildinfo\n')
    await writeFile(
      path.join(lib, 'package.json'),
      JSON.stringify({ name: 'lib', version: '1.0.0', scripts: { build: 'tsc -b' } }),
    )
    await writeFile(
      path.join(lib, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { composite: true, rootDir: 'src', outDir: 'dist' } }),
    )
    await mkdir(path.join(lib, 'node_modules', '.bin'), { recursive: true })
    await writeFile(path.join(lib, 'node_modules', '.bin', 'tsc'), FAKE_TSC)
    await chmod(path.join(lib, 'node_modules', '.bin', 'tsc'), 0o755)
    await writeFile(path.join(lib, 'src', 'a.ts'), 'A1\n')
    await writeFile(path.join(lib, 'src', 'b.ts'), 'B1\n')
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: ws.root })
    const build = async () => {
      const r = await run({
        cwd: ws.root,
        tasks: ['lib#build'],
        log: silent(),
        handleSignals: false,
      })
      return r.outcomes.find((o) => o.node.id === 'lib#build')!.status
    }
    expect(await build()).toBe('success')
    await writeFile(path.join(lib, 'src', 'a.ts'), 'A2\n')
    expect(await build()).toBe('success')
    expect(await Bun.file(path.join(lib, 'dist', 'b.js')).exists()).toBe(true)
  }, 30_000)
})

describe('migrateTurbo: a `tsc -b` build', () => {
  it('writes the buildinfo into its outputs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-tsc-migrate-'))
    try {
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({ tasks: { build: { outputs: ['dist/**'] } } }),
      )
      const dir = path.join(root, 'packages', 'a')
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { composite: true, rootDir: 'src', outDir: 'dist' } }),
      )
      const scripts = { build: 'tsc -b' }
      const metas: PackageMeta[] = [
        { name: 'a', dir, packageJson: { name: 'a', scripts } as never, configPath: null },
      ]
      const t = (await migrateTurbo(root, metas)).projects[0]!.tasks[0]!.task as {
        cache: { outputs: { files: unknown } }
      }
      expect(t.cache.outputs.files).toEqual(['dist/**', 'tsconfig.tsbuildinfo'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('tscBuildInfo', () => {
  const at = async (files: Record<string, unknown>, command: string) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-tsc-buildinfo-'))
    try {
      for (const [f, v] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(dir, f)), { recursive: true })
        await writeFile(path.join(dir, f), JSON.stringify(v))
      }
      return tscBuildInfo(onceReader().read, path.join(dir, 'pkg'), command)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  const opts = (compilerOptions: object, more: object = {}) => ({ compilerOptions, ...more })

  it('follows tsc: rootDir and outDir, outDir alone, tsBuildInfoFile, outFile', async () => {
    expect({
      rootDir: await at(
        { 'pkg/tsconfig.json': opts({ rootDir: 'src', outDir: 'dist' }) },
        'tsc -b',
      ),
      outDir: await at({ 'pkg/tsconfig.json': opts({ outDir: 'dist' }) }, 'tsc -b'),
      named: await at(
        { 'pkg/tsconfig.json': opts({ incremental: true, tsBuildInfoFile: '.cache/x.json' }) },
        'tsc',
      ),
      outFile: await at(
        { 'pkg/tsconfig.json': opts({ composite: true, outFile: 'out/all.js' }) },
        'tsc',
      ),
      plain: await at({ 'pkg/tsconfig.json': opts({ outDir: 'dist' }) }, 'tsc'),
    }).toEqual({
      rootDir: ['tsconfig.tsbuildinfo'],
      outDir: ['dist/tsconfig.tsbuildinfo'],
      named: ['.cache/x.json'],
      outFile: ['out/all.tsbuildinfo'],
      plain: [],
    })
  })

  it('reads extends (a package too), -p, references, and skips other packages', async () => {
    expect({
      extended: await at(
        {
          'node_modules/@repo/ts/base.json': opts({ incremental: true }),
          'pkg/tsconfig.build.json': { extends: '@repo/ts/base.json', ...opts({ outDir: 'lib' }) },
        },
        'pnpm exec tsc -p tsconfig.build.json && echo done',
      ),
      references: await at(
        {
          'pkg/tsconfig.json': {
            files: [],
            references: [{ path: './tsconfig.lib.json' }, { path: '../other' }],
          },
          'pkg/tsconfig.lib.json': opts({ composite: true, rootDir: 'src', outDir: 'dist' }),
          'other/tsconfig.json': opts({ composite: true }),
        },
        'tsc --build',
      ),
      watch: await at({ 'pkg/tsconfig.json': opts({ composite: true }) }, 'tsc -b -w'),
    }).toEqual({
      extended: ['lib/tsconfig.build.tsbuildinfo'],
      references: ['tsconfig.tsbuildinfo', 'tsconfig.lib.tsbuildinfo'],
      watch: [],
    })
  })
})
