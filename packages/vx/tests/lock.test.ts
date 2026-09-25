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

import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace as makeWorkspaceRoot } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 20_000

function makeWorkspace(): Promise<string> {
  return makeWorkspaceRoot({ prefix: 'vx-lock-' })
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
    'names the projects it cannot freeze: a package with no vx.config is counted, not audited',
    async () => {
      await addProject(root, 'app', ENV_CONFIG)
      // Control: every project configured — no note on either line.
      const lockAll = await vx(root, ['lock'], {})
      expect(lockAll.out).toBe('vx: locked 1 project config → vx-lock.json\n')
      expect((await vx(root, ['lock', '--check'], {})).out).toBe(
        'vx: lock is up to date (1 project)\n',
      )
      // A bare package (a plugin's tasks, or none): nothing to freeze there,
      // and `--frozen` still loads it live — say so instead of `0 configs`.
      await addProject(root, 'bare')
      const lock = await vx(root, ['lock'], {})
      expect(lock.code).toBe(0)
      expect(lock.out).toBe(
        'vx: locked 1 project config → vx-lock.json (1 project has no vx.config; their tasks are never frozen)\n',
      )
      const check = await vx(root, ['lock', '--check'], {})
      expect(check.code).toBe(0)
      expect(check.out).toBe(
        'vx: lock is up to date (1 project; 1 without a vx.config not audited)\n',
      )
    },
    TIMEOUT,
  )

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

  it(
    'an unknown argument is refused before anything is written: `--chek` is not a lock',
    async () => {
      await addProject(root, 'app', ENV_CONFIG)
      const typo = await vx(root, ['lock', '--chek'], {})
      expect(typo.code).toBe(1)
      expect(typo.err).toContain('vx lock: unknown argument: --chek')
      expect(typo.out).toBe('')
      // The audit a CI step asked for must not become a write that passes.
      expect(await Bun.file(path.join(root, 'vx-lock.json')).exists()).toBe(false)
      // Control: the spelled flag reaches the audit.
      expect((await vx(root, ['lock', '--check'], {})).err).toContain('run `vx lock` first')
    },
    TIMEOUT,
  )

  it(
    '--check refuses a config that moved, as `--frozen` does, even when its bytes did not change',
    async () => {
      const dir = await addProject(root, 'app', ENV_CONFIG)
      expect((await vx(root, ['lock'], { X: 'a' })).code).toBe(0)
      const bytes = await Bun.file(path.join(dir, 'vx.config.mjs')).bytes()
      await rm(path.join(dir, 'vx.config.mjs'))
      await writeFile(path.join(dir, 'vx.config.ts'), bytes)
      // Same bytes, same evaluation: only the path says the lock is stale,
      // and the frozen run refuses on it — so the audit must too.
      const frozen = await vx(root, ['run', 'build', '--all', '--no-cache', '--frozen'], {
        X: 'a',
      })
      expect(frozen.code).toBe(1)
      const check = await vx(root, ['lock', '--check'], { X: 'a' })
      expect(check.code).toBe(1)
      expect(check.err).toBe(
        `vx lock --check: "app" (packages/app/vx.config.ts) is not in the lock — run 'vx lock'\n`,
      )
    },
    TIMEOUT,
  )

  it(
    '--check names a locked project that no longer has a config in the workspace',
    async () => {
      await addProject(root, 'app', ENV_CONFIG)
      const gone = await addProject(root, 'gone', ENV_CONFIG)
      expect((await vx(root, ['lock'], { X: 'a' })).code).toBe(0)
      await rm(gone, { recursive: true, force: true })
      const check = await vx(root, ['lock', '--check'], { X: 'a' })
      expect(check.code).toBe(1)
      expect(check.err).toBe(
        `vx lock --check: locked project "gone" no longer has a config in the workspace — run 'vx lock'\n`,
      )
    },
    TIMEOUT,
  )

  it(
    'a field a config leaves undefined is not drift: the audit compares the JSON a lock can hold',
    async () => {
      // A first load in a process is the module's live default export, where
      // `description: undefined` is a key; the lock (JSON) has no such key.
      await addProject(
        root,
        'app',
        `export default { tasks: { build: { description: process.env.VX_LOCK_UNSET, exec: { command: 'echo hi' } } } }\n`,
      )
      expect((await vx(root, ['lock'], {})).code).toBe(0)
      const check = await vx(root, ['lock', '--check'], {})
      expect(check.err).toBe('')
      expect(check.code).toBe(0)
      // Control: the same field SET is drift once the lock was written without it.
      const drift = await vx(root, ['lock', '--check'], { VX_LOCK_UNSET: 'now set' })
      expect(drift.code).toBe(1)
      expect(drift.err).toContain('lock differs from fresh evaluation in this environment (app)')
    },
    TIMEOUT,
  )
})
