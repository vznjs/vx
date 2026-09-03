// Sandbox-runtime integration tests.
//
// These tests are gated on SRT's runtime deps (bwrap on Linux,
// sandbox-exec on macOS). CI installs bubblewrap + socat + strace,
// disables AppArmor's unprivileged-userns restriction, and sets
// VX_REQUIRE_SANDBOX — so an unavailable runtime FAILS there rather than
// skipping, because a skipped suite reports green and this one covers
// the isolation boundary. A local host without the deps still skips.

import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { writeLocalWorkspace } from './helpers/local-workspace.js'
import {
  deniedCalls,
  initSandbox,
  probeSandbox,
  resolveSandboxConfig,
  runSandboxed,
} from '../src/exec/sandbox-runtime.js'
import { run, type Logger, type RunOptions, type RunSummary } from '../src/orchestrator/index.js'
import { sandboxAvailable, sandboxReportingReliable } from './helpers/sandbox-gate.js'

const TIMEOUT = 60_000

interface Fixture {
  root: string
  log: string[]
}

/**
 * `expectOk(r, fixture)` with the task's own output in the failure: a
 * sandboxed task that fails on CI only (a bubblewrap or seccomp error on
 * the runner) otherwise leaves nothing in the log but `Received: false`.
 */
function expectOk(r: RunSummary, fixture: Fixture): void {
  if (r.ok) return
  const exits = r.outcomes.map((o) => `${o.node.id} ${o.status} exit=${o.exitCode}`).join(', ')
  throw new Error(`run was not ok (${exits}); task output:\n${fixture.log.join('\n')}`)
}

const collectingLogger = (fixture: Fixture): Logger => ({
  status(line) {
    fixture.log.push(line)
  },
  taskStdout(_node, chunk) {
    fixture.log.push(chunk.trimEnd())
  },
  taskStderr(_node, chunk) {
    fixture.log.push(chunk.trimEnd())
  },
  taskComplete(node, outcome) {
    fixture.log.push(`task ${node.id} ${outcome.status}`)
  },
})

async function makeWorkspace(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-sandbox-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }, null, 2),
  )
  await writeLocalWorkspace(root)
  await mkdir(path.join(root, 'packages'), { recursive: true })
  // vx requires git for input enumeration.
  const run = (...args: string[]): void => {
    const p = Bun.spawnSync({
      cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (p.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed`)
    }
  }
  run('init', '-q')
  run('config', 'user.email', 'test@vx.local')
  run('config', 'user.name', 'vx test')
  return { root, log: [] }
}

async function addProject(
  root: string,
  name: string,
  args: { files?: Record<string, string>; config: string },
): Promise<string> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
  await writeFile(path.join(dir, 'vx.config.mjs'), args.config)
  for (const [rel, content] of Object.entries(args.files ?? {})) {
    const full = path.join(dir, rel)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, content)
  }
  return dir
}

const available = await sandboxAvailable('sandbox-runtime tests')
const reportingReliable = await sandboxReportingReliable('sandbox-runtime tests')

describe.skipIf(!available)(`sandbox-runtime`, () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await makeWorkspace()
  })

  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  // ─── Activation ─────────────────────────────────────────────────

  it(
    'tasks without sandbox: {} run unsandboxed (no probe, no init)',
    async () => {
      // The orchestrator's lazy init only fires when at least one
      // node in the graph has node.config.sandbox. Tasks without it
      // run via the normal runCommand path.
      await addProject(fixture.root, 'unsandboxed', {
        files: { 'src/x.txt': 'hello' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'cat src/x.txt > out.txt' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      const r = await run({
        cwd: fixture.root,
        tasks: ['build'],
        log: collectingLogger(fixture),
      })
      expect(r.outcomes[0]?.status).toBe('success')
      expect(r.outcomes[0]?.sandboxViolations).toBeUndefined()
    },
    TIMEOUT,
  )

  it(
    'sandbox: {} (baseline) caches a clean task whose reads stay inside inputs',
    async () => {
      await addProject(fixture.root, 'clean', {
        files: { 'src/x.txt': 'hello' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'cat src/x.txt > out.txt' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
                sandbox: {},
              },
            },
          }
        `,
      })
      const opts: RunOptions = {
        cwd: fixture.root,
        tasks: ['build'],
        log: collectingLogger(fixture),
      }
      const first = await run(opts)
      expect(first.ok).toBe(true)
      expect(first.outcomes[0]?.status).toBe('success')
      expect(first.outcomes[0]?.sandboxViolations).toBeUndefined()

      const second = await run({ ...opts, log: collectingLogger(fixture) })
      expect(second.outcomes[0]?.status).toBe('cache-hit')
    },
    TIMEOUT,
  )

  // ─── Read enforcement ───────────────────────────────────────────

  it(
    'denies reads of sibling projects → task fails',
    async () => {
      await addProject(fixture.root, 'secret', {
        files: { 'token.txt': 'shh' },
        config: `export default { tasks: {} }`,
      })
      await addProject(fixture.root, 'reader', {
        files: { 'src/x.txt': 'hi' },
        config: `
          export default {
            tasks: {
              leak: {
                exec: { command: 'cat ../secret/token.txt' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
                sandbox: {},
              },
            },
          }
        `,
      })
      const r = await run({
        cwd: fixture.root,
        tasks: ['leak'],
        log: collectingLogger(fixture),
      })
      expect(r.ok).toBe(false)
      expect(r.outcomes[0]?.status).toBe('failed')
    },
    TIMEOUT,
  )

  it(
    'denies reads of workspace-root files not in inputs → task fails',
    async () => {
      await writeFile(path.join(fixture.root, 'root-secret.txt'), 'top-level')
      await addProject(fixture.root, 'reader', {
        files: { 'src/x.txt': 'hi' },
        config: `
          export default {
            tasks: {
              leak: {
                exec: { command: 'cat ../../root-secret.txt' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
                sandbox: {},
              },
            },
          }
        `,
      })
      const r = await run({
        cwd: fixture.root,
        tasks: ['leak'],
        log: collectingLogger(fixture),
      })
      expect(r.ok).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'allowRead grants a specific extra path → task succeeds',
    async () => {
      await writeFile(path.join(fixture.root, 'shared.txt'), 'shared')
      const projDir = await addProject(fixture.root, 'reader', {
        files: { 'src/x.txt': 'hi' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'cat ../../shared.txt > out.txt' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
                sandbox: { allowRead: ['../../shared.txt'] },
              },
            },
          }
        `,
      })
      const r = await run({
        cwd: fixture.root,
        tasks: ['build'],
        log: collectingLogger(fixture),
      })
      expectOk(r, fixture)
      expect(await readFile(path.join(projDir, 'out.txt'), 'utf8')).toBe('shared')
    },
    TIMEOUT,
  )

  // ─── Symlinked workspace root ───────────────────────────────────
  //
  // `resolveSandboxConfig` canonicalizes the USER's paths, but the
  // orchestrator-supplied baselines (resolved inputs, output prefixes, the
  // workspace-root deny anchor) used to arrive raw — so a root reached
  // through a symlink expressed HALF its policy in real paths and half in
  // link paths, bwrap died mounting the link path inside its new root
  // (`Can't mount tmpfs on /newroot/<link>`) and EVERY sandboxed task
  // failed, whatever the config. Both directions are pinned: a permitted
  // read must still work, and the boundary must still bite.

  it(
    'an explicitly allowed read works through a symlinked workspace root',
    async () => {
      const link = path.join(path.dirname(fixture.root), `${path.basename(fixture.root)}-link`)
      await symlink(fixture.root, link, 'dir')
      try {
        await writeFile(path.join(fixture.root, 'shared.txt'), 'shared')
        const projDir = await addProject(fixture.root, 'reader', {
          files: { 'src/x.txt': 'hi' },
          config: `
            export default {
              tasks: {
                build: {
                  exec: { command: 'cat ../../shared.txt > out.txt' },
                  cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
                  sandbox: { allowRead: ['../../shared.txt'] },
                },
              },
            }
          `,
        })
        const r = await run({ cwd: link, tasks: ['build'], log: collectingLogger(fixture) })
        expect(r.outcomes[0]?.status).toBe('success')
        expect(await readFile(path.join(projDir, 'out.txt'), 'utf8')).toBe('shared')
      } finally {
        await rm(link, { force: true })
      }
    },
    TIMEOUT,
  )

  it(
    // NOTE: on darwin CI this whole suite is skipped by the class gate in
    // helpers/sandbox-gate.ts — this test was the first observed instance of
    // the sandbox-exec under-load flake (zero violations for a real denial).
    'still denies an undeclared read through a symlinked workspace root',
    async () => {
      // Control: canonicalizing the baselines must not degenerate into
      // "allow everything" — the boundary still bites, and the violation is
      // NAMED rather than surfacing as a raw bwrap mount error.
      const link = path.join(path.dirname(fixture.root), `${path.basename(fixture.root)}-link2`)
      await symlink(fixture.root, link, 'dir')
      try {
        await addProject(fixture.root, 'secret', {
          files: { 'token.txt': 'shh' },
          config: `export default { tasks: {} }`,
        })
        await addProject(fixture.root, 'reader', {
          files: { 'src/x.txt': 'hi' },
          config: `
            export default {
              tasks: {
                leak: {
                  exec: { command: 'cat ../secret/token.txt > out.txt' },
                  cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
                  sandbox: {},
                },
              },
            }
          `,
        })
        const r = await run({ cwd: link, tasks: ['leak'], log: collectingLogger(fixture) })
        // ENFORCEMENT — artifact-based, so reporting loss cannot move it:
        // the task failed and the secret never landed in its output.
        expect(r.ok).toBe(false)
        expect(existsSync(path.join(link, 'packages', 'app', 'out.txt'))).toBe(false)
        // REPORTING — the bwrap mount failure this pin was written for named
        // an internal `/newroot/…` path and left ZERO violations, so a real
        // denial naming the file is the discriminating signal. Withheld where
        // the unified log drops records under load; see the gate helper.
        if (reportingReliable) {
          const lines = (r.outcomes[0]?.sandboxViolationLines ?? []).join('\n')
          expect(lines).toContain('token.txt')
        }
      } finally {
        await rm(link, { force: true })
      }
    },
    TIMEOUT,
  )

  // ─── Write enforcement ──────────────────────────────────────────

  it(
    'denies writes outside declared outputs → no host leak',
    async () => {
      // bwrap creates a sandbox-local overlay for paths outside the
      // bind set, so the write inside the sandbox appears to succeed
      // (task exit code may be 0). What matters is the HOST view: the
      // file must not exist outside the sandbox.
      await addProject(fixture.root, 'writer', {
        files: { 'src/x.txt': 'hi' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'echo bad > ../../escaped.txt' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
                sandbox: {},
              },
            },
          }
        `,
      })
      await run({
        cwd: fixture.root,
        tasks: ['build'],
        log: collectingLogger(fixture),
      })
      expect(existsSync(path.join(fixture.root, 'escaped.txt'))).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'allowWrite grants a specific extra write path → task succeeds',
    async () => {
      const projDir = await addProject(fixture.root, 'writer', {
        files: { 'src/x.txt': 'hi' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'echo ok > /tmp/vx-allowwrite-test.txt' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['src/x.txt'] } },
                sandbox: { allowWrite: ['/tmp'] },
              },
            },
          }
        `,
      })
      const r = await run({
        cwd: fixture.root,
        tasks: ['build'],
        log: collectingLogger(fixture),
      })
      expectOk(r, fixture)
      expect(existsSync('/tmp/vx-allowwrite-test.txt')).toBe(true)
      await rm('/tmp/vx-allowwrite-test.txt', { force: true })
      void projDir
    },
    TIMEOUT,
  )

  it(
    'output paths are read+write (touch on a declared output works)',
    async () => {
      // `touch` stats the file before creating it. Without auto-read
      // of declared outputs, this fails on macOS with file-read-metadata.
      // (On Linux, bwrap binds outputs writable AND visible.)
      const projDir = await addProject(fixture.root, 'toucher', {
        files: { 'src/x.txt': 'hi' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'mkdir -p dist && touch dist/marker.txt' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
                sandbox: {},
              },
            },
          }
        `,
      })
      const r = await run({
        cwd: fixture.root,
        tasks: ['build'],
        log: collectingLogger(fixture),
      })
      expectOk(r, fixture)
      expect(existsSync(path.join(projDir, 'dist/marker.txt'))).toBe(true)
    },
    TIMEOUT,
  )

  // ─── Cache behaviour around failures ────────────────────────────

  it(
    'failed sandboxed task is NOT cached (re-runs next invocation)',
    async () => {
      // A task that fails on a leak attempt must not poison the cache.
      // Next run should miss and re-execute, surfacing the same failure.
      await addProject(fixture.root, 'secret', {
        files: { 'token.txt': 'shh' },
        config: `export default { tasks: {} }`,
      })
      await addProject(fixture.root, 'reader', {
        files: { 'src/x.txt': 'hi' },
        config: `
          export default {
            tasks: {
              leak: {
                exec: { command: 'cat ../secret/token.txt' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
                sandbox: {},
              },
            },
          }
        `,
      })
      const opts: RunOptions = {
        cwd: fixture.root,
        tasks: ['leak'],
        log: collectingLogger(fixture),
      }
      const r1 = await run(opts)
      expect(r1.outcomes[0]?.status).toBe('failed')
      const r2 = await run({ ...opts, log: collectingLogger(fixture) })
      // Cache-hit would mean the failure got persisted; we want a
      // fresh attempt (which will also fail), not a cache replay.
      expect(r2.outcomes[0]?.status).toBe('failed')
    },
    TIMEOUT,
  )

  // ─── Validation ─────────────────────────────────────────────────

  it('rejects sandbox: [] (must be an object)', async () => {
    await addProject(fixture.root, 'bad', {
      config: `export default { tasks: { x: { exec: { command: 'true' }, sandbox: [] } } }`,
    })
    const r = await run({
      cwd: fixture.root,
      tasks: ['x'],
      log: collectingLogger(fixture),
    }).catch((e: Error) => e)
    expect(r).toBeInstanceOf(Error)
    expect((r as Error).message).toContain('sandbox must be an object')
  })

  it('rejects unknown sandbox fields', async () => {
    await addProject(fixture.root, 'bad', {
      config: `export default { tasks: { x: { exec: { command: 'true' }, sandbox: { typo: true } } } }`,
    })
    const r = await run({
      cwd: fixture.root,
      tasks: ['x'],
      log: collectingLogger(fixture),
    }).catch((e: Error) => e)
    expect(r).toBeInstanceOf(Error)
    expect((r as Error).message).toContain('sandbox.typo is not a known field')
  })

  it('rejects denyRead / denyWrite (no longer supported in the public schema)', async () => {
    await addProject(fixture.root, 'bad', {
      config: `export default { tasks: { x: { exec: { command: 'true' }, sandbox: { denyRead: ['/etc'] } } } }`,
    })
    const r = await run({
      cwd: fixture.root,
      tasks: ['x'],
      log: collectingLogger(fixture),
    }).catch((e: Error) => e)
    expect(r).toBeInstanceOf(Error)
    expect((r as Error).message).toContain('sandbox.denyRead is not a known field')
  })

  it('rejects globs in allowRead', async () => {
    await addProject(fixture.root, 'bad', {
      config: `export default { tasks: { x: { exec: { command: 'true' }, sandbox: { allowRead: ['**/*'] } } } }`,
    })
    const r = await run({
      cwd: fixture.root,
      tasks: ['x'],
      log: collectingLogger(fixture),
    }).catch((e: Error) => e)
    expect(r).toBeInstanceOf(Error)
    expect((r as Error).message).toContain('must be path prefixes')
  })

  it('rejects sandbox on group tasks (no exec)', async () => {
    await addProject(fixture.root, 'bad', {
      config: `export default { tasks: { x: { dependsOn: ['^build'], sandbox: {} } } }`,
    })
    const r = await run({
      cwd: fixture.root,
      tasks: ['x'],
      log: collectingLogger(fixture),
    }).catch((e: Error) => e)
    expect(r).toBeInstanceOf(Error)
    expect((r as Error).message).toContain('sandbox requires `exec`')
  })

  it('accepts the full SRT-mirroring shape (parses + runs)', async () => {
    await addProject(fixture.root, 'full', {
      files: { 'src/x.txt': 'hi' },
      config: `
        export default {
          tasks: {
            x: {
              exec: { command: 'cat src/x.txt > out.txt' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
              sandbox: {
                allowRead: ['/etc/hosts'],
                allowWrite: [],
                allowGitConfig: false,
                network: { allowedDomains: ['*.example.com'], deniedDomains: [] },
                allowPty: false,
                enableWeakerNestedSandbox: false,
                enableWeakerNetworkIsolation: false,
                ignoreViolations: { 'cat ': ['/tmp/noisy'] },
              },
            },
          },
        }
      `,
    })
    const r = await run({
      cwd: fixture.root,
      tasks: ['x'],
      log: collectingLogger(fixture),
    })
    expectOk(r, fixture)
  })

  // ─── Boolean network shortcuts ──────────────────────────────────

  it('network: false (default) blocks egress — task that does DNS lookup fails', async () => {
    await addProject(fixture.root, 'netreader', {
      files: { 'src/x.txt': 'hi' },
      config: `
        export default {
          tasks: {
            fetch: {
              // Use a node-free network probe: bash + /dev/tcp is built
              // into bash and doesn't depend on external binaries. We
              // try to connect to a public IP that's allowed via DNS.
              // Network is blocked → connect fails → exit != 0.
              exec: { command: 'bash -c "exec 3<>/dev/tcp/1.1.1.1/80" 2>&1' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
              sandbox: {},
            },
          },
        }
      `,
    })
    const r = await run({
      cwd: fixture.root,
      tasks: ['fetch'],
      log: collectingLogger(fixture),
    })
    expect(r.ok).toBe(false)
  })

  // ─── Per-task ignoreViolations ──────────────────────────────────

  it(
    'per-task ignoreViolations silences matching violation lines',
    async () => {
      // The leak task tries a sibling-project read; without the
      // ignoreViolations filter we'd record violations on Linux
      // (openat … secret/token.txt = -1 ENOENT). With the filter,
      // those lines are suppressed and we see 0 violations even
      // though the task still fails naturally.
      await addProject(fixture.root, 'secret', {
        files: { 'token.txt': 'shh' },
        config: `export default { tasks: {} }`,
      })
      await addProject(fixture.root, 'reader', {
        files: { 'src/x.txt': 'hi' },
        config: `
          export default {
            tasks: {
              leak: {
                exec: { command: 'cat ../secret/token.txt 2>&1 || true' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
                sandbox: {
                  ignoreViolations: { '*': ['secret/token.txt'] },
                },
              },
            },
          }
        `,
      })
      const r = await run({
        cwd: fixture.root,
        tasks: ['leak'],
        log: collectingLogger(fixture),
      })
      // Task succeeds (|| true), no violations after filter → cache saves.
      expect(r.outcomes[0]?.sandboxViolations).toBeUndefined()
    },
    TIMEOUT,
  )
})

describe('resolveSandboxConfig', () => {
  it('canonicalizes symlinked paths, including non-existent suffixes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-sbx-realpath-'))
    try {
      const target = path.join(root, 'target')
      const link = path.join(root, 'link')
      await mkdir(target)
      await symlink(target, link)
      const realTarget = realpathSync(target)

      const r = resolveSandboxConfig(
        { allowRead: [link], allowWrite: [path.join(link, 'not', 'yet')] },
        root,
      )
      expect(r.allowRead).toEqual([realTarget])
      expect(r.allowWrite).toEqual([path.join(realTarget, 'not', 'yet')])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// Deterministic pin for the Linux detector's trace parsing. The end-to-end
// suite only produces split lines when strace HAPPENS to interleave, so the
// shapes are pinned here against a synthetic trace instead.
describe('deniedCalls (strace trace parsing)', () => {
  it('sees a denial strace SPLIT across unfinished/resumed lines', () => {
    // Captured shape from a real `strace -f -e trace=openat` run: a denial
    // whose result never appears next to its path. A single-line regex drops
    // it, so a task forking concurrent children reading undeclared files
    // reported an INCOMPLETE violation list — and `--verify=inputs` reads an
    // incomplete list as `proven-complete`.
    const trace = [
      '1001 openat(AT_FDCWD, "/ws/secret-a", O_RDONLY) = -1 ENOENT (No such file or directory)',
      '1002 openat(AT_FDCWD, "/ws/secret-b", O_RDONLY <unfinished ...>',
      '1003 openat(AT_FDCWD, "/ws/secret-c", O_RDONLY <unfinished ...>',
      '1002 <... openat resumed>)              = -1 ENOENT (No such file or directory)',
      '1003 <... openat resumed>)              = -1 EACCES (Permission denied)',
      '',
    ].join('\n')
    expect(deniedCalls(trace)).toEqual([
      { syscall: 'openat', rawPath: '/ws/secret-a', errno: 'ENOENT' },
      { syscall: 'openat', rawPath: '/ws/secret-b', errno: 'ENOENT' },
      { syscall: 'openat', rawPath: '/ws/secret-c', errno: 'EACCES' },
    ])
  })

  it('does NOT report a split call that resumed successfully', () => {
    // Control: pairing must not turn every interrupted syscall into a
    // violation — only the ones whose result is a denial.
    const trace = [
      '1001 openat(AT_FDCWD, "/ws/fine", O_RDONLY <unfinished ...>',
      '1001 <... openat resumed>)              = 3',
      '',
    ].join('\n')
    expect(deniedCalls(trace)).toEqual([])
  })

  it('never double-counts: a resume retires its pending entry', () => {
    // A second resume for the same pid has nothing pending, so a stray
    // resumed line cannot re-emit the previous path.
    const trace = [
      '1001 openat(AT_FDCWD, "/ws/x", O_RDONLY <unfinished ...>',
      '1001 <... openat resumed>)              = -1 ENOENT (No such file or directory)',
      '1001 <... openat resumed>)              = -1 ENOENT (No such file or directory)',
      '',
    ].join('\n')
    expect(deniedCalls(trace)).toEqual([{ syscall: 'openat', rawPath: '/ws/x', errno: 'ENOENT' }])
  })

  it('drops an unfinished call that never resumes (killed mid-syscall)', () => {
    const trace = [
      '1001 openat(AT_FDCWD, "/ws/y", O_RDONLY <unfinished ...>',
      '1001 +++ killed by SIGKILL +++',
      '',
    ].join('\n')
    expect(deniedCalls(trace)).toEqual([])
  })

  it('reads the other traced syscalls in both layouts', () => {
    const trace = [
      '1001 access("/ws/a", R_OK)              = -1 EACCES (Permission denied)',
      '1002 statx(AT_FDCWD, "/ws/b", AT_STATX_SYNC_AS_STAT, STATX_ALL <unfinished ...>',
      '1002 <... statx resumed>, 0x7ffd)       = -1 EPERM (Operation not permitted)',
      '',
    ].join('\n')
    expect(deniedCalls(trace)).toEqual([
      { syscall: 'access', rawPath: '/ws/a', errno: 'EACCES' },
      { syscall: 'statx', rawPath: '/ws/b', errno: 'EPERM' },
    ])
  })

  it('ignores successful and untraced lines', () => {
    const trace = [
      '1001 openat(AT_FDCWD, "/lib/libc.so.6", O_RDONLY|O_CLOEXEC) = 3',
      '1001 execve("/bin/sh", ["sh"], 0x7ffd)  = 0',
      '1001 +++ exited with 0 +++',
      '',
    ].join('\n')
    expect(deniedCalls(trace)).toEqual([])
  })
})

describe('sandbox probe', () => {
  it('returns a stable shape', async () => {
    const a = await probeSandbox()
    expect(typeof a.available).toBe('boolean')
    expect(typeof a.reason).toBe('string')
    if (a.available) expect(a.reason).toBe('')
    else expect(a.reason.length).toBeGreaterThan(0)
  })
})

describe.skipIf(!available || process.platform !== 'darwin')(
  'settleOnCleanExit (darwin) — the verify-shaped settle window',
  () => {
    // The settle-poll originally gated on a FAIL exit, so a leaky task that
    // swallows its own read error (exit 0) never got the window — exactly
    // the case where --verify=inputs reads an empty store as PROOF over the
    // lossy unified-log channel (measured 1/30 false passes at idle). A
    // clean task with the flag pays the FULL 10×100 ms window — no
    // violations ever arrive to end it early — so the lower bound is
    // deterministic; the control is a RELATIVE comparison so absolute load
    // cannot flake it.
    it(
      'pays the full settle window on a clean exit; without the flag it returns fast',
      async () => {
        await initSandbox()
        const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-settle-'))
        try {
          const base = {
            cwd: dir,
            env: process.env,
            baseAllowRead: [dir],
            baseAllowWrite: [dir],
            baseDenyRead: [],
            config: resolveSandboxConfig({}, dir),
          }
          const t0 = performance.now()
          const settled = await runSandboxed({
            ...base,
            command: 'echo ok > out.txt',
            settleOnCleanExit: true,
          })
          const settledMs = performance.now() - t0
          const t1 = performance.now()
          const plain = await runSandboxed({ ...base, command: 'echo ok > out.txt' })
          const plainMs = performance.now() - t1
          expect(settled.exitCode).toBe(0)
          expect(plain.exitCode).toBe(0)
          expect(settledMs).toBeGreaterThanOrEqual(1000)
          // The flagless run must NOT pay the window: the poll costs ~1000ms,
          // so a >700ms gap discriminates while surviving load noise.
          expect(settledMs - plainMs).toBeGreaterThanOrEqual(700)
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
      },
      TIMEOUT,
    )
  },
)
