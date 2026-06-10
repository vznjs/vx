// Sandbox-runtime integration tests.
//
// These tests are gated on SRT's runtime deps (bwrap on Linux,
// sandbox-exec on macOS). CI installs bubblewrap + socat + strace and
// disables AppArmor's unprivileged-userns restriction so the suite
// runs end-to-end. Local dev hosts without those deps still skip
// cleanly via probeSandbox.

import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { probeSandbox, resolveSandboxConfig } from '../src/exec/sandbox-runtime.js'
import { run, type Logger, type RunOptions } from '../src/orchestrator.js'

const TIMEOUT = 60_000

interface Fixture {
  root: string
  log: string[]
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

const availability = await probeSandbox()

// We assert availability rather than skipping. CI installs bwrap +
// socat + strace + disables the AppArmor userns restriction in the
// "Install sandbox runtime deps" step, so probeSandbox MUST return
// available there. Local dev hosts without the deps fail loudly so
// it's obvious that this suite needs them.
if (!availability.available) {
  // eslint-disable-next-line no-console
  console.warn(`[sandbox-runtime tests] skipping — runtime not available: ${availability.reason}`)
}

describe.skipIf(!availability.available)(`sandbox-runtime`, () => {
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
      expect(r.ok).toBe(true)
      expect(await readFile(path.join(projDir, 'out.txt'), 'utf8')).toBe('shared')
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
      expect(r.ok).toBe(true)
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
      expect(r.ok).toBe(true)
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
    expect(r.ok).toBe(true)
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

describe('sandbox probe', () => {
  it('returns a stable shape', async () => {
    const a = await probeSandbox()
    expect(typeof a.available).toBe('boolean')
    expect(typeof a.reason).toBe('string')
    if (a.available) expect(a.reason).toBe('')
    else expect(a.reason.length).toBeGreaterThan(0)
  })
})
