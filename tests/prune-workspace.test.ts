// `vx prune <project>` — the workspace-subset emitter (Turbo parity).
// E2e via bin.ts subprocesses, in the last.test.ts / why.test.ts pattern.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { writeLocalWorkspace } from './helpers/local-workspace.js'
import { parsePruneWorkspaceArgs } from '../src/cli/index.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-prune-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }),
  )
  await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await writeFile(path.join(root, '.npmrc'), 'strict-peer-dependencies=false\n')
  await writeLocalWorkspace(root)
  const mk = async (name: string, deps: Record<string, string> = {}) => {
    const dir = path.join(root, 'packages', name)
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name, version: '0.0.0', dependencies: deps }),
    )
    await writeFile(path.join(dir, 'src', 'index.ts'), `// ${name}\n`)
    // Things prune must EXCLUDE:
    await mkdir(path.join(dir, 'node_modules', 'junk'), { recursive: true })
    await writeFile(path.join(dir, 'node_modules', 'junk', 'x.js'), 'x')
  }
  await mk('lib')
  await mk('app', { lib: 'workspace:*' })
  await mk('other')
  return root
}

interface VxResult {
  code: number
  out: string
  err: string
}

async function vx(root: string, args: string[]): Promise<VxResult> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  )

describe('vx prune (e2e)', () => {
  let root: string
  beforeAll(async () => {
    root = await makeWorkspace()
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'emits the target + its transitive workspace deps, and nothing else',
    async () => {
      const r = await vx(root, ['prune', 'app'])
      expect(r.code).toBe(0)
      expect(r.out).toContain('pruned 2 packages for app')
      const out = path.join(root, 'out')
      expect(await exists(path.join(out, 'packages', 'app', 'src', 'index.ts'))).toBe(true)
      expect(await exists(path.join(out, 'packages', 'lib', 'src', 'index.ts'))).toBe(true)
      expect(await exists(path.join(out, 'packages', 'other'))).toBe(false)
      // Exclusions hold.
      expect(await exists(path.join(out, 'packages', 'app', 'node_modules'))).toBe(false)
      // Root manifests + the UNPRUNED lockfile + the workspace file ride along.
      expect(await exists(path.join(out, 'package.json'))).toBe(true)
      expect(await exists(path.join(out, 'pnpm-lock.yaml'))).toBe(true)
      expect(await exists(path.join(out, '.npmrc'))).toBe(true)
      expect(await exists(path.join(out, 'vx.workspace.mjs'))).toBe(true)
      // The workspace yaml is REWRITTEN to the exact subset.
      const yaml = await readFile(path.join(out, 'pnpm-workspace.yaml'), 'utf8')
      expect(yaml).toContain('packages/app')
      expect(yaml).toContain('packages/lib')
      expect(yaml).not.toContain('packages/*')
      expect(yaml).not.toContain('other')
    },
    TIMEOUT,
  )

  it(
    '--docker splits json/ (manifests only) from full/ (sources)',
    async () => {
      const r = await vx(root, ['prune', 'app', '--docker', '--out-dir', 'out-docker'])
      expect(r.code).toBe(0)
      const out = path.join(root, 'out-docker')
      expect(await exists(path.join(out, 'json', 'packages', 'app', 'package.json'))).toBe(true)
      expect(await exists(path.join(out, 'json', 'packages', 'app', 'src'))).toBe(false)
      expect(await exists(path.join(out, 'json', 'pnpm-lock.yaml'))).toBe(true)
      expect(await exists(path.join(out, 'full', 'packages', 'app', 'src', 'index.ts'))).toBe(true)
      expect(await exists(path.join(out, 'full', 'packages', 'lib', 'src', 'index.ts'))).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'a leaf project prunes to just itself',
    async () => {
      const r = await vx(root, ['prune', 'lib', '--out-dir', 'out-lib'])
      expect(r.code).toBe(0)
      expect(r.out).toContain('pruned 1 package for lib')
      expect(await exists(path.join(root, 'out-lib', 'packages', 'app'))).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'an unknown project fails loud with a suggestion',
    async () => {
      const r = await vx(root, ['prune', 'ap'])
      expect(r.code).not.toBe(0)
      expect(r.err).toContain('no project named "ap"')
      expect(r.err).toContain('did you mean app')
    },
    TIMEOUT,
  )

  it(
    'an out dir inside a pruned package is refused',
    async () => {
      const r = await vx(root, ['prune', 'app', '--out-dir', 'packages/app/out'])
      expect(r.code).not.toBe(0)
      expect(r.err).toContain('inside app')
    },
    TIMEOUT,
  )
})

describe('parsePruneWorkspaceArgs', () => {
  it('parses project, --out-dir in both forms, --docker; rejects garbage', () => {
    expect(parsePruneWorkspaceArgs(['app']).project).toBe('app')
    expect(parsePruneWorkspaceArgs(['app']).outDir).toBe('out')
    expect(parsePruneWorkspaceArgs(['app', '--out-dir', 'x']).outDir).toBe('x')
    expect(parsePruneWorkspaceArgs(['app', '--out-dir=y']).outDir).toBe('y')
    expect(parsePruneWorkspaceArgs(['app', '--docker']).docker).toBe(true)
    expect(parsePruneWorkspaceArgs(['--out-dir=']).error).toMatch(/empty/)
    expect(parsePruneWorkspaceArgs(['--wat']).error).toMatch(/unknown flag/)
    expect(parsePruneWorkspaceArgs(['a', 'b']).error).toMatch(/unexpected argument/)
  })
})
