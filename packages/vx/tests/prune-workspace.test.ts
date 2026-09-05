// `vx prune <project>` — the workspace-subset emitter (Turbo parity).
// E2e via bin.ts subprocesses, in the last.test.ts / why.test.ts pattern.

import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { localWorkspaceSource, writeLocalWorkspace } from './helpers/local-workspace.js'
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

// A config's imports decide whether the SUBSET can run at all: the workspace
// config loads before any task, and a plugin it names from a workspace package
// has to travel with the subset. What prune cannot satisfy — a relative import
// reaching outside the copied dirs — is reported instead of silently emitting
// a build context that dies inside docker.
describe('vx prune: what the configs import', () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-prune-cfg-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    // EXPLICIT member paths (not a glob) — the shape where a member missing
    // from the subset makes `bun install` fail outright.
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'cfg-root',
        private: true,
        workspaces: ['packages/app', 'packages/lib', 'packages/plug', 'packages/unrelated'],
      }),
    )
    const mk = async (name: string, deps: Record<string, string> = {}) => {
      const dir = path.join(root, 'packages', name)
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name, version: '0.0.0', main: 'index.mjs', dependencies: deps }),
      )
      await writeFile(path.join(dir, 'index.mjs'), 'export const x = 1\n')
      return dir
    }
    const appDir = await mk('app', { lib: 'workspace:*' })
    await mk('lib')
    await mk('plug')
    await mk('unrelated')

    // A shared helper OUTSIDE any package — the shape prune can never carry.
    await mkdir(path.join(root, 'shared'), { recursive: true })
    await writeFile(path.join(root, 'shared', 'util.ts'), 'export const shared = 1\n')
    await writeFile(
      path.join(appDir, 'vx.config.ts'),
      `import { shared } from '../../shared/util.ts'\nexport default { tasks: { build: { exec: { command: 'true' } }, _s: shared } }\n`,
    )

    // Bare import of a workspace package, resolvable the way a real repo
    // resolves one — a node_modules link. Side-effect import, so no plugin
    // contract is involved and loadWorkspace stays happy.
    await mkdir(path.join(root, 'node_modules'), { recursive: true })
    await symlink(path.join(root, 'packages', 'plug'), path.join(root, 'node_modules', 'plug'))
    await writeFile(
      path.join(root, 'vx.workspace.mjs'),
      localWorkspaceSource([], `import 'plug'\n`),
    )
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'carries a workspace package the workspace config imports, and nothing else',
    async () => {
      const out = path.join(root, '..', `prune-cfg-${process.pid}`)
      const r = await vx(root, ['prune', 'app', '--out-dir', out])
      try {
        expect(r.code).toBe(0)
        // `plug` is in NO package.json dependency — only the workspace config
        // names it, and without it `vx run` cannot load that config at all.
        expect(await exists(path.join(out, 'packages', 'plug'))).toBe(true)
        expect(await exists(path.join(out, 'packages', 'lib'))).toBe(true)
        // CONTROL: pulling in config imports must not pull in the world.
        expect(await exists(path.join(out, 'packages', 'unrelated'))).toBe(false)
      } finally {
        await rm(out, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'rewrites package.json workspaces to the subset, dropping absent members',
    async () => {
      // bun/npm/yarn read membership from package.json, not pnpm-workspace.yaml.
      // A glob matching nothing is tolerated; an EXPLICIT path that the subset
      // does not contain is fatal — `bun install` exits 1 with
      // `Workspace not found "packages/unrelated"`, so the emitted build
      // context would not install at all.
      const out = path.join(root, '..', `prune-ws-${process.pid}`)
      const r = await vx(root, ['prune', 'app', '--out-dir', out])
      try {
        expect(r.code).toBe(0)
        const pkg = JSON.parse(await readFile(path.join(out, 'package.json'), 'utf8')) as {
          workspaces: string[]
          name: string
        }
        expect(pkg.workspaces).not.toContain('packages/unrelated')
        expect([...pkg.workspaces].sort()).toEqual([
          'packages/app',
          'packages/lib',
          'packages/plug',
        ])
        // Everything else about the manifest survives the rewrite.
        expect(pkg.name).toBe('cfg-root')
      } finally {
        await rm(out, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'the emitted subset actually INSTALLS, and an unrewritten one would not',
    async () => {
      // The claim prune exists to make, asserted end to end instead of
      // inferred from the manifest's contents. The second half pins BUN's
      // behaviour, which is the whole reason the rewrite is needed: a glob
      // matching nothing is tolerated, an explicit member the subset lacks is
      // fatal. If bun ever stops caring, this fails and the rewrite can be
      // reconsidered on evidence.
      const out = path.join(root, '..', `prune-inst-${process.pid}`)
      const r = await vx(root, ['prune', 'app', '--out-dir', out])
      try {
        expect(r.code).toBe(0)
        // Hermetic install: bun stages into TMPDIR and caches under HOME, and
        // neither belongs to this test. Both go inside the subset it just
        // emitted, so the run touches nothing it did not create.
        const scratch = path.join(out, '.install-scratch')
        await mkdir(scratch, { recursive: true })
        const install = async (cwd: string): Promise<{ code: number; err: string }> => {
          const proc = Bun.spawn([process.execPath, 'install', '--no-save'], {
            cwd,
            env: {
              ...process.env,
              TMPDIR: scratch,
              BUN_INSTALL_CACHE_DIR: path.join(scratch, 'cache'),
            },
            stdout: 'pipe',
            stderr: 'pipe',
          })
          const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
          return { code, err }
        }

        const ok = await install(out)
        expect(ok.code).toBe(0)

        // Same subset, manifest reverted to naming a package it does not
        // contain — the state prune would emit without the rewrite.
        const manifest = path.join(out, 'package.json')
        const pkg = JSON.parse(await readFile(manifest, 'utf8')) as Record<string, unknown>
        pkg['workspaces'] = ['packages/app', 'packages/lib', 'packages/plug', 'packages/unrelated']
        await writeFile(manifest, JSON.stringify(pkg))
        const broken = await install(out)
        expect(broken.code).toBe(1)
        expect(broken.err).toContain('packages/unrelated')
      } finally {
        await rm(out, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'reports a project config importing outside the subset',
    async () => {
      const out = path.join(root, '..', `prune-esc-${process.pid}`)
      const r = await vx(root, ['prune', 'app', '--out-dir', out])
      try {
        expect(r.err).toContain('../../shared/util.ts')
        expect(r.err).toContain('outside the pruned subset')
        // CONTROL: a package whose config stays inside itself is not named.
        expect(r.err).not.toContain('lib:')
      } finally {
        await rm(out, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
