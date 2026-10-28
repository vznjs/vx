// .vx/projects.lock.json e2e. Each step spawns the real CLI as a subprocess because
// the whole point is cross-invocation env drift: the lock is written
// under one environment and checked / run under another.
//
// The asymmetry under test (docs/design/config-lock-2026-06.md):
//   - `vx lock --check` re-evaluates configs in the current env and
//     deep-compares against the lock → catches env drift that file
//     hashes cannot see.
//   - `vx run` checks nothing and TRUSTS the lock → frozen-env
//     semantics; the run succeeds with the locked value. It never
//     evaluates a config.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace as makeWorkspaceRoot } from './helpers/workspace.js'
import { noticed } from './helpers/notice.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 20_000
const DRIFT = noticed(
  `vx lock --check: packages/app/vx.config.mjs evaluates differently from the lock here — its config, a file it imports, or the environment it reads changed; run 'vx lock'\n`,
)

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
    'a package with no vx.config and no task is not named',
    async () => {
      await addProject(root, 'app', ENV_CONFIG)
      // Control: every project configured — no note on either line.
      const lockAll = await vx(root, ['lock'], {})
      expect(lockAll.out).toBe('✓ vx lock  1 project config → .vx/projects.lock.json\n')
      expect((await vx(root, ['lock', '--check'], {})).out).toBe(
        '✓ vx lock --check  up to date (1 project)\n',
      )
      // A bare package with no task: nothing to freeze and nothing to name
      // (lock-discover-stage.test.ts names one a plugin gives tasks).
      await addProject(root, 'bare')
      const lock = await vx(root, ['lock'], {})
      expect(lock.code).toBe(0)
      expect(lock.out).toBe('✓ vx lock  1 project config → .vx/projects.lock.json\n')
      const check = await vx(root, ['lock', '--check'], {})
      expect(check.code).toBe(0)
      expect(check.out).toBe('✓ vx lock --check  up to date (1 project)\n')
    },
    TIMEOUT,
  )

  it(
    'locks a directory named __proto__ as its own entry (D-152)',
    async () => {
      // Assigned into a plain object, the entry set the map's prototype:
      // "locked 1 project", `"projects": {}` on disk, and --check said the
      // project was not in the lock.
      await mkdir(path.join(root, '__proto__'))
      await writeFile(path.join(root, '__proto__', 'vx.config.mjs'), ENV_CONFIG)
      expect((await vx(root, ['lock'], { X: 'a' })).code).toBe(0)
      const lockJson = JSON.parse(
        await Bun.file(path.join(root, '.vx/projects.lock.json')).text(),
      ) as {
        projects: object
      }
      expect(Object.keys(lockJson.projects)).toEqual(['__proto__'])
      expect((await vx(root, ['lock', '--check'], { X: 'a' })).out).toBe(
        '✓ vx lock --check  up to date (1 project)\n',
      )
      const frozen = await vx(
        root,
        ['run', 'build', '--all', '--no-cache', '--output-logs', 'full'],
        { X: 'b' },
      )
      expect(frozen.code).toBe(0)
      expect(frozen.out).toContain('flavor-a')
    },
    TIMEOUT,
  )

  it(
    'locks a task named __proto__ and runs it',
    async () => {
      // vx init writes `['__proto__']` for such a script; the lock's
      // sorted copy assigned it into a plain object and lost it.
      await addProject(
        root,
        'app',
        `export default { tasks: { ['__proto__']: { exec: { command: 'echo proto-ran' } } } }\n`,
      )
      expect((await vx(root, ['lock'], {})).code).toBe(0)
      const lockJson = JSON.parse(
        await Bun.file(path.join(root, '.vx/projects.lock.json')).text(),
      ) as { projects: Record<string, { config: { tasks: object } }> }
      expect(Object.keys(lockJson.projects['packages/app']!.config.tasks)).toEqual(['__proto__'])
      const run = await vx(root, ['run', 'app#__proto__', '--output-logs', 'full'], {})
      expect(run.code).toBe(0)
      expect(run.out).toContain('proto-ran')
    },
    TIMEOUT,
  )

  it(
    'freezes env-dependent configs: a run trusts the lock; --check audits',
    async () => {
      await addProject(root, 'app', ENV_CONFIG)

      // Lock under X=a — the resolved command is frozen with 'a'.
      const lock = await vx(root, ['lock'], { X: 'a' })
      expect(lock.code).toBe(0)
      const lockJson = (await Bun.file(path.join(root, '.vx/projects.lock.json')).json()) as {
        version: number
        projects: Record<
          string,
          { file: string; config: { tasks: { build: { exec: { command: string } } } } }
        >
      }
      expect(lockJson.version).toBe(4)
      const app = lockJson.projects['packages/app']!
      expect([app.file, app.config.tasks.build.exec.command]).toEqual([
        'vx.config.mjs',
        'echo flavor-a',
      ])

      // --check under the SAME env: fresh evaluation matches the lock.
      const checkSame = await vx(root, ['lock', '--check'], { X: 'a' })
      expect(checkSame.code).toBe(0)
      expect(checkSame.out).toContain('✓ vx lock --check  up to date')

      // --check under X=b: file bytes are unchanged but re-evaluation
      // resolves a different object — exit 1 naming the project.
      const checkDrift = await vx(root, ['lock', '--check'], { X: 'b' })
      expect(checkDrift.code).toBe(1)
      expect(checkDrift.err).toBe(DRIFT)

      // A run consumes the lock: the frozen value wins regardless of env.
      const frozen = await vx(
        root,
        ['run', 'build', '--all', '--no-cache', '--output-logs', 'full'],
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
    'a changed config file: a run keeps the freeze until re-lock',
    async () => {
      const dir = await addProject(root, 'app', ENV_CONFIG)
      expect((await vx(root, ['lock'], { X: 'a' })).code).toBe(0)

      await writeFile(
        path.join(dir, 'vx.config.mjs'),
        `export default { tasks: { build: { exec: { command: 'echo edited' } } } }\n`,
      )

      const check = await vx(root, ['lock', '--check'], { X: 'a' })
      expect(check.code).toBe(1)
      expect(check.err).toBe(DRIFT)

      // A run trusts the lock outright — no staleness checks; the
      // pipeline's `vx lock --check` (above, exit 1) is the guard.
      // It runs the FROZEN config, not the edited file.
      const frozen = await vx(
        root,
        ['run', 'build', '--all', '--no-cache', '--output-logs', 'full'],
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
        ['run', 'build', '--all', '--no-cache', '--output-logs', 'full'],
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
      expect(typo.err).toContain('✗ vx lock  unknown flag: --chek')
      expect(typo.out).toBe('')
      // The audit a CI step asked for must not become a write that passes.
      expect(await Bun.file(path.join(root, '.vx/projects.lock.json')).exists()).toBe(false)
      // Control: the spelled flag reaches the audit.
      expect((await vx(root, ['lock', '--check'], {})).err).toContain('run `vx lock` first')
    },
    TIMEOUT,
  )

  it(
    'a config renamed in its directory is a re-lock: the lock holds the file',
    async () => {
      const dir = await addProject(root, 'app', ENV_CONFIG)
      expect((await vx(root, ['lock'], { X: 'a' })).code).toBe(0)
      const bytes = await Bun.file(path.join(dir, 'vx.config.mjs')).bytes()
      await rm(path.join(dir, 'vx.config.mjs'))
      await writeFile(path.join(dir, 'vx.config.ts'), bytes)
      const frozen = await vx(root, ['run', 'build', '--all', '--no-cache'], { X: 'a' })
      expect([frozen.code, frozen.err]).toEqual([
        1,
        noticed(
          'vx run: .vx/projects.lock.json locks packages/app ("app"), but its vx.config.mjs is gone — run `vx lock`\n',
        ),
      ])
      const check = await vx(root, ['lock', '--check'], { X: 'a' })
      expect([check.code, check.err]).toEqual([
        1,
        noticed(
          "vx lock --check: packages/app/vx.config.ts is not the vx.config.mjs the lock holds for packages/app — run 'vx lock'\n",
        ),
      ])
      expect((await vx(root, ['lock'], { X: 'a' })).code).toBe(0)
      expect((await vx(root, ['run', 'build', '--all', '--no-cache'], { X: 'a' })).code).toBe(0)
    },
    TIMEOUT,
  )

  it(
    'a lock a merge left conflicted: a run and --check refuse it, `vx lock` rewrites it',
    async () => {
      await addProject(root, 'app', ENV_CONFIG)
      expect((await vx(root, ['lock'], { X: 'a' })).code).toBe(0)
      const file = path.join(root, '.vx/projects.lock.json')
      const ours = await Bun.file(file).text()
      await writeFile(file, `<<<<<<< HEAD\n${ours}=======\n${ours}>>>>>>> other\n`)
      const invalid = (verb: string): string =>
        noticed(
          `vx ${verb}: .vx/projects.lock.json is not valid JSON — re-run \`vx lock\` or delete it`,
        )
      const run = await vx(root, ['run', 'build', '--all', '--no-cache'], { X: 'a' })
      expect([run.code, run.err]).toEqual([1, invalid('run')])
      const check = await vx(root, ['lock', '--check'], { X: 'a' })
      expect([check.code, check.err]).toEqual([1, invalid('lock --check')])
      expect((await vx(root, ['lock'], { X: 'a' })).code).toBe(0)
      expect(await Bun.file(file).text()).toBe(ours)
      expect((await vx(root, ['run', 'build', '--all', '--no-cache'], { X: 'a' })).code).toBe(0)
    },
    TIMEOUT,
  )

  it(
    'a hand-broken lock entry says the lock is invalid, not a raw crash (2026-10-14)',
    async () => {
      // Runs validate no entry (no cost on a run); a crash it causes is
      // named on the failure path only.
      await addProject(root, 'app', ENV_CONFIG)
      expect((await vx(root, ['lock'], { X: 'a' })).code).toBe(0)
      const file = path.join(root, '.vx/projects.lock.json')
      const invalid = '.vx/projects.lock.json is invalid, run `vx lock`'
      for (const app of [
        { tasks: { build: { exec: 'x' } } },
        { tasks: { build: { exec: { command: 'x' }, inputs: { files: ['src'] }, cache: {} } } },
      ]) {
        await writeFile(
          file,
          JSON.stringify({
            version: 4,
            projects: { 'packages/app': { file: 'vx.config.mjs', config: app } },
          }),
        )
        const run = await vx(root, ['run', 'build', '--all', '--no-cache'], { X: 'a' })
        expect(run.code).toBe(1)
        expect(run.err + run.out).toContain(invalid)
        expect(run.err + run.out).not.toContain('TypeError')
      }
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
        noticed(
          `vx lock --check: the lock holds packages/gone, which has no vx.config now — run 'vx lock'\n`,
        ),
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
      expect(drift.err).toBe(DRIFT)
    },
    TIMEOUT,
  )
})
