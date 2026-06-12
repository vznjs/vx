// vx-lock.json e2e. Each step spawns the real CLI as a subprocess because
// the whole point is cross-invocation env drift: the lock is written
// under one environment and checked / run under another.
//
// The asymmetry under test (docs/design/config-lock-2026-06.md):
//   - `vx lock --check` re-evaluates configs in the current env and
//     deep-compares against the lock → catches env drift that file
//     hashes cannot see.
//   - `vx run` is hash-only and TRUSTS the lock → frozen-env
//     semantics; the run succeeds with the locked value.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 20_000

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-lock-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }),
  )
  await mkdir(path.join(root, 'packages'), { recursive: true })
  // vx requires git for input enumeration.
  const git = (...args: string[]): void => {
    const p = Bun.spawnSync({
      cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (p.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(p.stderr)}`)
    }
  }
  git('init', '-q')
  git('config', 'user.email', 'test@vx.local')
  git('config', 'user.name', 'vx test')
  return root
}

async function addProject(root: string, name: string, config: string): Promise<string> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
  await writeFile(path.join(dir, 'vx.config.mjs'), config)
  return dir
}

interface VxResult {
  code: number
  out: string
  err: string
}

async function vx(root: string, args: string[], env: Record<string, string>): Promise<VxResult> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
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

const ENV_CONFIG = `
  export default {
    tasks: {
      build: {
        exec: { command: 'echo flavor-' + (process.env.X ?? 'unset') },
      },
    },
  }
`

describe('vx lock (e2e)', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'freezes env-dependent configs: live runs see env; --frozen trusts the lock; --check audits',
    async () => {
      await addProject(root, 'app', ENV_CONFIG)

      // Lock under X=a — the resolved command is frozen with 'a'.
      const lock = await vx(root, ['lock'], { X: 'a' })
      expect(lock.code).toBe(0)
      const lockJson = (await Bun.file(path.join(root, 'vx-lock.json')).json()) as {
        version: number
        projects: Record<string, { config: { tasks: { build: { exec: { command: string } } } } }>
      }
      expect(lockJson.version).toBe(1)
      expect(lockJson.projects.app!.config.tasks.build.exec.command).toBe('echo flavor-a')

      // --check under the SAME env: fresh evaluation matches the lock.
      const checkSame = await vx(root, ['lock', '--check'], { X: 'a' })
      expect(checkSame.code).toBe(0)
      expect(checkSame.out).toContain('lock is up to date')

      // --check under X=b: file bytes are unchanged (hash check alone
      // would pass) but re-evaluation resolves a different object —
      // exit 1 naming the project.
      const checkDrift = await vx(root, ['lock', '--check'], { X: 'b' })
      expect(checkDrift.code).toBe(1)
      expect(checkDrift.err).toContain(
        'lock differs from fresh evaluation in this environment (app)',
      )
      expect(checkDrift.err).toContain('env-dependent config?')

      // Plain `vx run` evaluates LIVE — local truth, no lock consumed.
      const live = await vx(
        root,
        ['run', 'build', '--all', '--no-cache', '--output-logs', 'full'],
        { X: 'b' },
      )
      expect(live.code).toBe(0)
      expect(live.out).toContain('flavor-b')

      // `--frozen` consumes the lock: frozen value wins regardless of env.
      const frozen = await vx(
        root,
        ['run', 'build', '--all', '--no-cache', '--frozen', '--output-logs', 'full'],
        {
          X: 'b',
        },
      )
      expect(frozen.code).toBe(0)
      expect(frozen.out).toContain('flavor-a')
      expect(frozen.out).not.toContain('flavor-b')
    },
    TIMEOUT,
  )

  it(
    'a changed config file: live runs use the edit; --frozen keeps the freeze until re-lock',
    async () => {
      const dir = await addProject(root, 'app', ENV_CONFIG)
      expect((await vx(root, ['lock'], { X: 'a' })).code).toBe(0)

      await writeFile(
        path.join(dir, 'vx.config.mjs'),
        `export default { tasks: { build: { exec: { command: 'echo edited' } } } }\n`,
      )

      const check = await vx(root, ['lock', '--check'], { X: 'a' })
      expect(check.code).toBe(1)
      expect(check.err).toContain('config file changed since lock (app')

      // Plain runs evaluate live — the edit takes effect immediately,
      // stale lock or not.
      const live = await vx(
        root,
        ['run', 'build', '--all', '--no-cache', '--output-logs', 'full'],
        { X: 'a' },
      )
      expect(live.code).toBe(0)
      expect(live.out).toContain('edited')

      // --frozen trusts the lock outright — no staleness checks; the
      // pipeline's `vx lock --check` (above, exit 1) is the guard.
      // It runs the FROZEN config, not the edited file.
      const frozen = await vx(
        root,
        ['run', 'build', '--all', '--no-cache', '--frozen', '--output-logs', 'full'],
        {
          X: 'a',
        },
      )
      expect(frozen.code).toBe(0)
      expect(frozen.out).toContain('flavor-a')
      expect(frozen.out).not.toContain('edited')

      // Re-lock brings the edit into the frozen graph.
      expect((await vx(root, ['lock'], { X: 'a' })).code).toBe(0)
      const healed = await vx(
        root,
        ['run', 'build', '--all', '--no-cache', '--frozen', '--output-logs', 'full'],
        {
          X: 'a',
        },
      )
      expect(healed.code).toBe(0)
      expect(healed.out).toContain('edited')
    },
    TIMEOUT,
  )

  it(
    '--check without a lock exits 1 with a pointer to `vx lock`',
    async () => {
      await addProject(root, 'app', ENV_CONFIG)
      const check = await vx(root, ['lock', '--check'], {})
      expect(check.code).toBe(1)
      expect(check.err).toContain('run `vx lock` first')
    },
    TIMEOUT,
  )
})
