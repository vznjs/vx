// Sandbox-runtime integration tests.
//
// These tests are gated on SRT's runtime deps (bwrap on Linux,
// sandbox-exec on macOS). CI installs bubblewrap + socat + strace,
// disables AppArmor's unprivileged-userns restriction, and sets
// VX_REQUIRE_SANDBOX — so an unavailable runtime FAILS there rather than
// skipping, because a skipped suite reports green and this one covers
// the isolation boundary. A local host without the deps still skips.

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace as makeWorkspaceRoot } from './helpers/workspace.js'
import {
  initSandbox,
  probeSandbox,
  resetSandbox,
  type SandboxViolation,
  resolveSandboxConfig,
  runSandboxed,
} from '../src/exec/sandbox-runtime.js'
import { punchWritePaths } from '../src/exec/sandbox-binds.js'
import {
  bridgedPorts,
  portBridgeHostArgv,
  portBridgeInner,
  portBridgeSocket,
} from '../src/exec/sandbox-runtime.js'
import { localBindingOn } from '../src/exec/sandbox-paths.js'
import { deniedCalls, reportableViolations } from '../src/exec/sandbox-violations.js'
import { run, type Logger, type RunOptions, type RunSummary } from '../src/orchestrator/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { validateProjectConfig } from '../src/workspace/index.js'

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
  const root = await makeWorkspaceRoot({ prefix: 'vx-sandbox-' })
  return { root, log: [] }
}

const available = await sandboxAvailable('sandbox-runtime tests')

describe.skipIf(!available)(`sandbox-runtime`, () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await makeWorkspace()
  })

  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  // ─── Persistent tasks ──────────────────────────────────────────

  // A dev server declaring `exec.sandbox` gets the same walls as a one-shot
  // task. Until 2026-09-09 the block was accepted and ignored — the config
  // claimed a guarantee the code did not provide. The server here reports
  // what it could read of a WORKSPACE-ROOT file (outside the project, so
  // denied) before announcing readiness; the control is the same task with
  // no block, which reads it.
  const persistentProbe = (sandbox: boolean): string => `
    export default {
      tasks: {
        dev: {
          exec: {
            command: '(cat ../../secret.txt && echo LEAKED) 2>/dev/null || echo DENIED; echo Listening; sleep 30',
            persistent: { readyWhen: 'Listening' },
            timeout: 15000,
            ${sandbox ? "sandbox: { allow: { read: ['**/*'] } }," : ''}
          },
        },
      },
    }
  `

  it(
    'a persistent task runs inside its sandbox: a read outside the project is denied',
    async () => {
      await writeFile(path.join(fixture.root, 'secret.txt'), 'top secret\n')
      await addProject(fixture.root, 'srv', { files: {}, config: persistentProbe(true) })
      const r = await run({ cwd: fixture.root, tasks: ['dev'], log: collectingLogger(fixture) })
      expect(r.outcomes[0]?.status).toBe('success')
      const out = fixture.log.join('\n')
      expect(out).toContain('DENIED')
      expect(out).not.toContain('LEAKED')
    },
    TIMEOUT,
  )

  it(
    'CONTROL: the same server with no sandbox block reads the file',
    async () => {
      await writeFile(path.join(fixture.root, 'secret.txt'), 'top secret\n')
      await addProject(fixture.root, 'srv', { files: {}, config: persistentProbe(false) })
      const r = await run({ cwd: fixture.root, tasks: ['dev'], log: collectingLogger(fixture) })
      expect(r.outcomes[0]?.status).toBe('success')
      expect(fixture.log.join('\n')).toContain('LEAKED')
    },
    TIMEOUT,
  )

  // A dev server's literal write grant meets the trap of a one-shot task's
  // (2026-09-16): the grant is pre-created as a FILE, its own `mkdir` says
  // "File exists", and the file used to outlive the run. The persistent
  // path sweeps the placeholder when the server exits and names the `dir/`
  // spelling when readiness fails.
  const cacheDirServer = (grant: string): string => `
    export default {
      tasks: {
        dev: {
          exec: {
            command: 'mkdir -p .cache && echo x > .cache/x && echo Listening && sleep 30',
            persistent: { readyWhen: 'Listening' },
            timeout: 5000,
            sandbox: { allow: { read: ['.'], write: ['${grant}'] } },
          },
        },
      },
    }
  `

  it(
    'a persistent task whose literal write grant meant a directory: the failure says `.cache/`, nothing is left behind',
    async () => {
      const projDir = await addProject(fixture.root, 'srv', {
        files: {},
        config: cacheDirServer('.cache'),
      })
      const r = await run({ cwd: fixture.root, tasks: ['dev'], log: collectingLogger(fixture) })
      expect(r.outcomes[0]?.status).toBe('failed')
      const out = fixture.log.join('\n')
      expect(out).toContain('write grant `.cache` named nothing on disk')
      expect(out).toContain('spell the grant `.cache/`')
      expect(existsSync(path.join(projDir, '.cache'))).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'a persistent task with a `.cache/` write grant makes its directory and becomes ready',
    async () => {
      const projDir = await addProject(fixture.root, 'srv', {
        files: {},
        config: cacheDirServer('.cache/'),
      })
      const r = await run({ cwd: fixture.root, tasks: ['dev'], log: collectingLogger(fixture) })
      expect(r.outcomes[0]?.status).toBe('success')
      expect(existsSync(path.join(projDir, '.cache'))).toBe(true)
    },
    TIMEOUT,
  )

  // ─── Arming is lazy ─────────────────────────────────────────────

  // The runtime starts on the first task that executes inside a sandbox,
  // not up front: a run whose sandboxed tasks are all cache hits never
  // probes, never loads the runtime and never starts its proxy — measured
  // 339–486 ms → 33–38 ms for this repo's own warm gate (2026-09-10). The
  // second run below makes the sandbox UNAVAILABLE (a PATH with only git on
  // it: no bwrap, no socat, no sandbox-exec) and still succeeds because it
  // hits; the control re-runs with an edited input, and that miss fails
  // when the runtime cannot start — proving the same PATH does take the
  // sandbox away. Which dependency the runtime misses first (the probe's
  // bwrap or the bridge's socat) decides the message, so the control
  // asserts the failure, not its text.
  it(
    'a run whose sandboxed tasks are all hits never starts the sandbox',
    async () => {
      await addProject(fixture.root, 'a', {
        files: { 'src/x.txt': 'x\n' },
        config: `export default { tasks: { build: {
          exec: { command: 'cat src/x.txt > out.txt', sandbox: { allow: { read: ['**/*'], write: ['out.txt'] } } },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
        } } }\n`,
      })
      const first = await run({
        cwd: fixture.root,
        tasks: ['build'],
        log: collectingLogger(fixture),
      })
      expectOk(first, fixture)
      const onlyGit = await mkdtemp(path.join(os.tmpdir(), 'vx-path-'))
      await symlink(Bun.which('git')!, path.join(onlyGit, 'git'))
      const savedPath = process.env['PATH']
      process.env['PATH'] = onlyGit
      try {
        const second = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: collectingLogger(fixture),
        })
        expectOk(second, fixture)
        expect(second.outcomes[0]?.status).toBe('cache-hit')
        await writeFile(path.join(fixture.root, 'packages', 'a', 'src', 'x.txt'), 'y\n')
        const third = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: collectingLogger(fixture),
        })
        expect(third.ok).toBe(false)
        expect(third.outcomes[0]?.status).toBe('failed')
      } finally {
        process.env['PATH'] = savedPath
        await rm(onlyGit, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

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
    'a task that declares its reads and writes runs clean and caches',
    async () => {
      await addProject(fixture.root, 'clean', {
        files: { 'src/x.txt': 'hello' },
        config: `
          export default {
            tasks: {
              build: {
                exec: {
                  command: 'cat src/x.txt > out.txt',
                  sandbox: { allow: { read: ['.', 'src/**'], write: ['out.txt'] } },
                },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
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
                exec: { command: 'cat ../secret/token.txt', sandbox: {} },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
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
                exec: { command: 'cat ../../root-secret.txt', sandbox: {} },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
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
    'installed dependencies are readable without being declared inputs',
    async () => {
      // The one grant core still makes on its own. It is not derived from
      // `cache` — the sandbox derives nothing from cache — it is where the
      // task's PATH finds its `.bin` entries, and denying it left anything
      // that imports a dependency dead with only `error: An unknown error
      // occurred (Unexpected)` (owner call, 2026-09-04). Both the project's
      // own node_modules and the workspace root's, where a monorepo hoists.
      await mkdir(path.join(fixture.root, 'node_modules', 'hoisted'), { recursive: true })
      await writeFile(
        path.join(fixture.root, 'node_modules', 'hoisted', 'index.js'),
        'module.exports = 1\n',
      )
      const projDir = await addProject(fixture.root, 'importer', {
        files: { 'src/x.txt': 'hi', 'node_modules/local/index.js': 'module.exports = 2\n' },
        config: `
          export default {
            tasks: {
              build: {
                exec: {
                  command:
                    'cat ../../node_modules/hoisted/index.js node_modules/local/index.js > out.txt',
                  sandbox: { allow: { read: ['.'], write: ['out.txt'] } },
                },
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
      expectOk(r, fixture)
      expect(await readFile(path.join(projDir, 'out.txt'), 'utf8')).toBe(
        'module.exports = 1\nmodule.exports = 2\n',
      )
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
                exec: { command: 'cat ../../shared.txt > out.txt', sandbox: { allow: { read: ['.', '../../shared.txt'], write: ['out.txt'] } } },
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
                  exec: { command: 'cat ../../shared.txt > out.txt', sandbox: { allow: { read: ['.', '../../shared.txt'], write: ['out.txt'] } } },
                  cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
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
                  exec: {
                    command: 'cat ../secret/token.txt > out.txt',
                    sandbox: { allow: { read: ['.'], write: ['out.txt'] } },
                  },
                  cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
                },
              },
            }
          `,
        })
        const r = await run({ cwd: link, tasks: ['leak'], log: collectingLogger(fixture) })
        // ENFORCEMENT is the whole assertion here, and it is artifact-based
        // so no reporting loss can move it: the secret never landed.
        //
        // It is deliberately NOT asserted as a violation. `token.txt` lives
        // in a SIBLING project, and a denial outside the task's own project
        // is not reported — being stopped at the wall is the sandbox
        // working, not a finding. Canonicalizing the baselines through the
        // symlink must not degenerate into "allow everything", and the
        // absent file is what proves it did not.
        expect(existsSync(path.join(link, 'packages', 'app', 'out.txt'))).toBe(false)
        expect((r.outcomes[0]?.sandboxViolationLines ?? []).join('\n')).not.toContain('token.txt')
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
                exec: { command: 'echo bad > ../../escaped.txt', sandbox: {} },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
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
                exec: { command: 'echo ok > /tmp/vx-allowwrite-test.txt', sandbox: { allow: { write: ['/tmp'] } } },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['src/x.txt'] } },
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
    'a `~` or absolute write grant is never created inside the project',
    async () => {
      // Write grants are pre-created because bwrap cannot bind a path that
      // does not exist — but only the ones the project owns. Joining a `~`
      // grant onto the project dir made a literal `~` directory there
      // (2026-09-05), which then dirtied the tree the cache hashes.
      const projDir = await addProject(fixture.root, 'homewriter', {
        files: { 'src/x.txt': 'hi' },
        config: `
          export default {
            tasks: {
              build: {
                exec: {
                  command: 'echo ok > src/x.txt',
                  sandbox: { allow: { read: ['.'], write: ['src/**', '~/.vx-never', '/tmp'] } },
                },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['src/x.txt'] } },
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
      expect(existsSync(path.join(projDir, '~'))).toBe(false)
      expect(existsSync(path.join(projDir, 'tmp'))).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'a literal write grant that meant a directory: the failure says `dist/`, and nothing is left behind',
    async () => {
      // A literal grant on a path that does not exist yet is bound as an
      // empty FILE, so the task's own `mkdir -p dist` died with "File
      // exists" — and the empty file survived every later clean (`dist/**`
      // matches nothing under a file), so every run after met it again
      // (2026-09-16). vx takes the untouched placeholder back and names the
      // directory spelling beside the failure.
      const projDir = await addProject(fixture.root, 'dirgrant', {
        files: { 'src/x.txt': 'hi' },
        config: `
          export default {
            tasks: {
              build: {
                exec: {
                  command: 'mkdir -p dist && cp src/x.txt dist/out.txt',
                  sandbox: { allow: { read: ['.'], write: ['dist'] } },
                },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
      })
      const r = await run({ cwd: fixture.root, tasks: ['build'], log: collectingLogger(fixture) })
      expect(r.ok).toBe(false)
      const lines =
        r.outcomes.find((o) => o.node.id === 'dirgrant#build')?.sandboxViolationLines ?? []
      expect(lines.some((l) => l.includes('write grant `dist` named nothing on disk'))).toBe(true)
      expect(lines.some((l) => l.includes('spell the grant `dist/`'))).toBe(true)
      expect(existsSync(path.join(projDir, 'dist'))).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'a `dist/` write grant is a directory the task may fill',
    async () => {
      const projDir = await addProject(fixture.root, 'dirslash', {
        files: { 'src/x.txt': 'hi' },
        config: `
          export default {
            tasks: {
              build: {
                exec: {
                  command: 'mkdir -p dist && cp src/x.txt dist/out.txt',
                  sandbox: { allow: { read: ['.'], write: ['dist/'] } },
                },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
      })
      const r = await run({ cwd: fixture.root, tasks: ['build'], log: collectingLogger(fixture) })
      expectOk(r, fixture)
      expect(await readFile(path.join(projDir, 'dist/out.txt'), 'utf8')).toBe('hi')
    },
    TIMEOUT,
  )

  it(
    'a declared write path is readable too (touch stats before it creates)',
    async () => {
      // `touch` stats the file before creating it, so a write grant that
      // did not also permit reading would fail on macOS with
      // file-read-metadata. Writable implies readable.
      const projDir = await addProject(fixture.root, 'toucher', {
        files: { 'src/x.txt': 'hi' },
        config: `
          export default {
            tasks: {
              build: {
                exec: {
                  command: 'mkdir -p dist && touch dist/marker.txt',
                  sandbox: { allow: { read: ['.'], write: ['dist/**'] } },
                },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
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
                exec: { command: 'cat ../secret/token.txt', sandbox: {} },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
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

  it('rejects exec.sandbox: [] (must be an object)', async () => {
    await addProject(fixture.root, 'bad', {
      config: `export default { tasks: { x: { exec: { command: 'true', sandbox: [] } } } }`,
    })
    const r = await run({
      cwd: fixture.root,
      tasks: ['x'],
      log: collectingLogger(fixture),
    }).catch((e: Error) => e)
    expect(r).toBeInstanceOf(Error)
    expect((r as Error).message).toContain('exec.sandbox must be an object')
  })

  it('rejects unknown sandbox fields', async () => {
    await addProject(fixture.root, 'bad', {
      config: `export default { tasks: { x: { exec: { command: 'true', sandbox: { typo: true } } } } }`,
    })
    const r = await run({
      cwd: fixture.root,
      tasks: ['x'],
      log: collectingLogger(fixture),
    }).catch((e: Error) => e)
    expect(r).toBeInstanceOf(Error)
    expect((r as Error).message).toContain('exec.sandbox has unknown field "typo"')
  })

  it('rejects a capability the schema does not define', async () => {
    await addProject(fixture.root, 'bad', {
      config: `export default { tasks: { x: { exec: { command: 'true', sandbox: { allow: { execute: ['/bin'] } } } } } }`,
    })
    const r = await run({
      cwd: fixture.root,
      tasks: ['x'],
      log: collectingLogger(fixture),
    }).catch((e: Error) => e)
    expect(r).toBeInstanceOf(Error)
    expect((r as Error).message).toContain('exec.sandbox.allow has unknown field "execute"')
  })

  it('a whole-directory pattern grants the directory, so a task can list its cwd', async () => {
    // `<dir>/**` matches everything UNDER `<dir>` and never `<dir>` itself,
    // so before the collapse a task granted `read: ['**/*']` still could
    // not `ls` its own cwd — the shape `bun test` and `oxlint` need.
    await addProject(fixture.root, 'globbed', {
      files: { 'src/x.txt': 'hi' },
      config: `export default { tasks: { x: {
        exec: { command: 'ls > /dev/null && cat src/x.txt > /dev/null', sandbox: { allow: { read: ['**/*'] } } },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
      } } }`,
    })
    const r = await run({ cwd: fixture.root, tasks: ['x'], log: collectingLogger(fixture) })
    expectOk(r, fixture)
  })

  it('a task-level sandbox is refused — it belongs to exec, which a group has none of', async () => {
    // The old runtime check ("sandbox requires `exec`") is gone: the field
    // lives inside `exec`, so a group task has nowhere to write one and the
    // invalid state is unrepresentable rather than validated.
    await addProject(fixture.root, 'bad', {
      config: `export default { tasks: { x: { dependsOn: ['^build'], sandbox: {} } } }`,
    })
    const r = await run({
      cwd: fixture.root,
      tasks: ['x'],
      log: collectingLogger(fixture),
    }).catch((e: Error) => e)
    expect(r).toBeInstanceOf(Error)
    expect((r as Error).message).toContain('unknown field "sandbox"')
  })

  // "Every capability" is a claim about a LIST the schema owns, so the list
  // is read from `config-schema.ts` rather than restated here: a capability
  // added to `GRANT_FIELDS` without a value below fails this test instead of
  // quietly falling out of its name (the restated-list drift items 374-398
  // chased through the docs, in a test name).
  it('accepts every capability the schema defines (parses + runs)', async () => {
    const schema = readFileSync(
      path.resolve(import.meta.dir, '..', 'src', 'workspace', 'config-schema.ts'),
      'utf8',
    )
    // `GRANT_FIELDS` spreads three `as const` arrays and adds literals of its
    // own, so both shapes are resolved.
    const arrays = new Map<string, string[]>(
      [...schema.matchAll(/const (\w+) = \[([^\]]*)\] as const/g)].map((m) => [
        m[1]!,
        [...m[2]!.matchAll(/'([^']+)'/g)].map((f) => f[1]!),
      ]),
    )
    const fieldsOf = (name: string): string[] => {
      const m = new RegExp(`const ${name} = new Set(?:<string>)?\\(\\[([^\\]]*)\\]`).exec(schema)
      const body = m?.[1] ?? ''
      return [
        ...[...body.matchAll(/'([^']+)'/g)].map((f) => f[1]!),
        ...[...body.matchAll(/\.\.\.(\w+)/g)].flatMap((sp) => arrays.get(sp[1]!) ?? []),
      ].sort()
    }

    const allow: Record<string, string> = {
      read: `['.', 'src/**', '/etc/hosts']`,
      write: `['out.txt']`,
      network: `['*.example.com']`,
      systemInfo: `['vfs.disk-space']`,
      unixSockets: `['/var/run/nothing.sock']`,
      localBinding: 'false',
      machLookup: '[]',
      pty: 'false',
      gitConfig: 'false',
    }
    const deny: Record<string, string> = { network: `['blocked.example.com']` }
    const render = (o: Record<string, string>): string =>
      Object.entries(o)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ')
    const sandbox: Record<string, string> = {
      allow: `{ ${render(allow)} }`,
      deny: `{ ${render(deny)} }`,
      ignore: `{ read: ['/tmp/noisy'] }`,
      weakerWhenNested: 'false',
      weakerNetworkIsolation: 'false',
    }
    expect(Object.keys(sandbox).sort()).toEqual(fieldsOf('SANDBOX_FIELDS'))
    expect(Object.keys(allow).sort()).toEqual(fieldsOf('GRANT_FIELDS'))
    expect(Object.keys(deny).sort()).toEqual(fieldsOf('DENY_FIELDS'))

    await addProject(fixture.root, 'full', {
      files: { 'src/x.txt': 'hi' },
      config: `
        export default {
          tasks: {
            x: {
              exec: {
                command: 'cat src/x.txt > out.txt',
                sandbox: { ${render(sandbox)} },
              },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
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
              exec: { command: 'bash -c "exec 3<>/dev/tcp/1.1.1.1/80" 2>&1', sandbox: {} },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
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
                exec: {
                  command: 'cat ../secret/token.txt 2>&1 || true',
                  sandbox: { ignore: { read: ['../secret/token.txt'] } },
                },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
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

describe.skipIf(!available)('a cache declaration grants the sandbox nothing', () => {
  // "The sandbox derives NOTHING from `cache`" (owner, 2026-09-05) is stated
  // in `sandbox-request.ts` and in schema.md — `cache.inputs` says what
  // INVALIDATES a task, `sandbox.allow` says what it may TOUCH, and deriving
  // one from the other coupled them in both directions: a declaration added
  // for caching silently widened the sandbox.
  //
  // Nothing pinned it. Deriving write grants from `cache.outputs.files` ONLY
  // when the task declares none of its own survives the whole repo's tests
  // (2026-09-20) — and that is the dangerous direction, because it is the
  // task that asked for no write access at all.
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  const project = async (write: string | undefined): Promise<string> =>
    addProject(fixture.root, 'app', {
      files: { 'src/x.txt': 'hi' },
      config: `
        export default {
          tasks: {
            build: {
              exec: {
                command: 'mkdir -p dist && cat src/x.txt > dist/out.txt',
                sandbox: { allow: { read: ['src/**', '.'] ${write === undefined ? '' : `, write: ['${write}']`} } },
              },
              cache: {
                inputs: { files: ['src/**'] },
                outputs: { files: ['dist/out.txt'] },
              },
            },
          },
        }
      `,
    })

  it(
    'a declared OUTPUT is not a write grant: the task fails',
    async () => {
      const dir = await project(undefined)
      const r = await run({ cwd: fixture.root, tasks: ['build'], log: collectingLogger(fixture) })
      expect(r.ok).toBe(false)
      expect(r.outcomes[0]?.status).toBe('failed')
      expect(existsSync(path.join(dir, 'dist', 'out.txt'))).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'CONTROL: the same task with the write grant it never had succeeds',
    async () => {
      // One line of config apart — and the cache block is identical — so the
      // row above is about where the grant comes from, not about the sandbox
      // refusing everything.
      const dir = await project('dist/')
      const r = await run({ cwd: fixture.root, tasks: ['build'], log: collectingLogger(fixture) })
      expectOk(r, fixture)
      expect(await readFile(path.join(dir, 'dist', 'out.txt'), 'utf8')).toBe('hi')
    },
    TIMEOUT,
  )
})

describe.skipIf(!available || process.platform !== 'linux')(
  'the BARE baseline, which is what the type describes',
  () => {
    // Every row above declares an explicit `sandbox.allow`. The shape
    // `SandboxConfig`'s own doc comment describes — `sandbox: {}`, no allow
    // block at all — had nothing, and that is how the comment came to
    // promise a baseline derived from `cache` while the code granted none
    // (item 443). `sandboxRequestFor` builds the request with
    // `baseAllowWrite: []`, so a declared `cache.outputs` buys the task no
    // write at all.
    //
    // Linux-only for the same reason as the row further down: `Read-only
    // file system` is the bwrap denial, verified in a Linux container, and
    // macOS seatbelt refuses differently. What is NOT platform-specific is
    // the claim itself — that a declared `cache.outputs` contributes
    // nothing to the request — and `sandbox-request.test.ts` pins that
    // directly, on every platform.
    let fixture: Fixture

    beforeEach(async () => {
      fixture = await makeWorkspace()
    })
    afterEach(async () => {
      await rm(fixture.root, { recursive: true, force: true })
    })

    const project = async (write: string | undefined): Promise<string> =>
      addProject(fixture.root, 'app', {
        files: { 'src/x.txt': 'hi' },
        config: `
        export default {
          tasks: {
            build: {
              exec: {
                command: 'mkdir -p dist && printf OUT > dist/app.js',
                sandbox: ${write === undefined ? '{}' : `{ allow: { write: ['${write}'] } }`},
              },
              cache: {
                inputs: { files: ['src/**'] },
                outputs: { files: ['dist/**'] },
              },
            },
          },
        }
      `,
      })

    it(
      'declaring cache.outputs grants no write: the task is denied, loudly',
      async () => {
        // The neighbouring row proves this for a task that declares
        // `allow.read` and no write. This is the case the TYPE describes:
        // no allow block at all. The project tree is read-only, so the
        // task's own `mkdir` is refused by the OS and the run fails —
        // which is the honest outcome, not a silent empty artifact.
        const dir = await project(undefined)
        const r = await run({ cwd: fixture.root, tasks: ['build'], log: collectingLogger(fixture) })
        expect(r.ok).toBe(false)
        expect(r.outcomes[0]?.status).toBe('failed')
        expect(fixture.log.join('\n')).toContain('Read-only file system')
        expect(existsSync(path.join(dir, 'dist', 'app.js'))).toBe(false)
      },
      TIMEOUT,
    )

    it(
      'CONTROL: the same task with the write grant declared lands its output',
      async () => {
        // One line of config apart, and the cache block is identical — so
        // the row above is about where a write grant comes from, not about
        // the sandbox refusing everything. `dist/` with the slash, because a
        // bare literal would be bound as a FILE (schema.md, "A write
        // grant's shape").
        const dir = await project('dist/')
        const r = await run({ cwd: fixture.root, tasks: ['build'], log: collectingLogger(fixture) })
        expectOk(r, fixture)
        expect(await readFile(path.join(dir, 'dist', 'app.js'), 'utf8')).toBe('OUT')
        expect(fixture.log.join('\n')).not.toContain('Read-only file system')
      },
      TIMEOUT,
    )
  },
)

describe.skipIf(!available || process.platform !== 'linux')(
  'a write grant widens what a task can READ, and that is the cache-relevant half',
  () => {
    // `bindableWrites` widens a FILE-shaped write grant to its DIRECTORY on
    // Linux, because bwrap cannot rename onto an active file mount. The code
    // says so, and says what it costs on the WRITE side ("the task may write
    // its siblings"). The READ side was neither written down nor pinned: a
    // read-write bind is readable, so the whole directory becomes readable
    // too — and an undeclared read is exactly the thing the sandbox exists to
    // catch, because the key folds this project's inputs (2026-09-20).
    //
    // Linux-only by construction: macOS seatbelt matches paths rather than
    // mounting, so a file grant stays exact there.
    let fixture: Fixture

    beforeEach(async () => {
      fixture = await makeWorkspace()
    })
    afterEach(async () => {
      await rm(fixture.root, { recursive: true, force: true })
    })

    const project = async (write: string): Promise<string> =>
      addProject(fixture.root, 'app', {
        files: {
          'src/x.txt': 'declared',
          'undeclared.txt': 'AT THE ROOT',
          'dist/sibling.txt': 'IN DIST',
        },
        config: `
          export default {
            tasks: {
              build: {
                exec: {
                  command: 'cat undeclared.txt > probe/root.txt 2>/dev/null; cat dist/sibling.txt > probe/dist.txt 2>/dev/null; echo done',
                  sandbox: { allow: { read: ['src/**'], write: ['${write}', 'probe/'] } },
                },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
              },
            },
          }
        `,
      })

    it(
      'a write grant at the project ROOT makes the whole root readable — no violation',
      async () => {
        const dir = await project('out.txt')
        const r = await run({ cwd: fixture.root, tasks: ['build'], log: collectingLogger(fixture) })
        // The read SUCCEEDED and nothing reported it. This is the documented
        // boundary being wider than the docs said, not a denial being missed:
        // no syscall failed, so there is nothing for the strace pass to see.
        expect(r.outcomes[0]?.status).toBe('success')
        expect(r.outcomes[0]?.sandboxViolations).toBeUndefined()
        expect(await readFile(path.join(dir, 'probe', 'root.txt'), 'utf8')).toBe('AT THE ROOT')
      },
      TIMEOUT,
    )

    it(
      'the SAME task with its output in a subdirectory still fails on that read',
      async () => {
        // The control that makes the row above a statement about WHERE the
        // grant sits, not about sandboxing being off: one word of the config
        // changes, and the undeclared root read is denied and reported.
        const dir = await project('dist/out.txt')
        const r = await run({ cwd: fixture.root, tasks: ['build'], log: collectingLogger(fixture) })
        expect(r.outcomes[0]?.status).toBe('failed')
        expect(r.outcomes[0]?.sandboxViolations).toBe(1)
        // The redirection still creates the file; what the denial costs is
        // its CONTENT, which is the difference that matters.
        expect(await readFile(path.join(dir, 'probe', 'root.txt'), 'utf8')).toBe('')
        // …while the widening itself is real and scoped: `dist/` IS readable,
        // which is how `tsc --incremental` re-reads its own .tsbuildinfo.
        expect(await readFile(path.join(dir, 'probe', 'dist.txt'), 'utf8')).toBe('IN DIST')
      },
      TIMEOUT,
    )
  },
)

describe.skipIf(!available)('the sandbox temp directory', () => {
  // SRT overrides TMPDIR so temp writers land where its filesystem policy
  // allows, and does not create the directory ("/tmp/claude may not exist",
  // its own comment). Nobody else did either, so every sandboxed task that
  // wrote a temp file died. Reproduced 2026-09-04 with this repo's own
  // build: `bun build --compile` inside the verify sandbox reported
  // `failed to open temporary file to copy bun into / ENOENT:
  // /tmp/claude/.<hash>.bun-build`, which reaches the user as the opaque
  // `error: An unknown error occurred (Unexpected)`. Creating the directory
  // is the whole fix; resolution mirrors SRT's own order.
  it(
    'initSandbox creates the directory SRT points tasks at',
    async () => {
      const tmpdir = path.join(os.tmpdir(), `vx-sbx-tmp-${Date.now()}`)
      const previous = process.env['CLAUDE_CODE_TMPDIR']
      process.env['CLAUDE_CODE_TMPDIR'] = tmpdir
      try {
        expect(existsSync(tmpdir)).toBe(false)
        await initSandbox()
        expect(existsSync(tmpdir)).toBe(true)
        // Idempotent: a second run of the same process must not throw.
        await initSandbox()
      } finally {
        if (previous === undefined) delete process.env['CLAUDE_CODE_TMPDIR']
        else process.env['CLAUDE_CODE_TMPDIR'] = previous
        await rm(tmpdir, { recursive: true, force: true })
        await resetSandbox()
      }
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
        { allow: { read: [link], write: [path.join(link, 'not', 'yet')] } },
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

/**
 * Why `@vzn/vx#test.bun.shard-*` is the one task in this repo with no
 * `sandbox` block: this suite spawns sandboxes, and on macOS a seatbelt
 * policy cannot be applied from inside one. Measured 2026-09-05 — the
 * inner `sandbox-exec` dies with `sandbox_apply: Operation not permitted`
 * (exit 71) no matter how permissive either profile is. If a future macOS
 * or SRT lifts that, this test fails and the shards can be sandboxed.
 */
/**
 * The report filters, driven with both platforms' line shapes on
 * whichever platform is running. macOS violations arrive as seatbelt
 * records and Linux ones as strace lines; before 2026-09-05 the filters
 * parsed the seatbelt shape only, so on Linux every out-of-project
 * denial was reported and no `ignore` pattern ever matched.
 */
describe('reportableViolations', () => {
  // Real-path anchored: both producers canonicalize before they record,
  // and on macOS `/tmp` is a symlink — a literal `/tmp/...` fixture would
  // pass or fail for the wrong reason.
  const ROOT = path.join(realpathSync(os.tmpdir()), 'vx-report-proj')
  const PROJ = path.join(ROOT, 'packages', 'app')
  const mac = (op: string, target: string): SandboxViolation => ({
    line: `bun(1) deny(1) ${op} ${target}`,
    timestamp: new Date(),
  })
  const linux = (abs: string): SandboxViolation => ({
    line: `openat(x) = -1 ENOENT  [${abs}]`,
    timestamp: new Date(),
    target: abs,
    path: abs,
    ignorable: ['read', 'write'],
  })

  const lines = (vs: SandboxViolation[]): string[] => vs.map((v) => v.line)

  it('keeps denials inside the project and drops the ones at the wall', () => {
    const cfg = resolveSandboxConfig({}, PROJ)
    const kept = reportableViolations(
      [
        mac('file-read-data', `${PROJ}/src/a.ts`),
        mac('file-read-data', path.join(ROOT, 'packages', 'other', 'b.ts')),
        linux(`${PROJ}/src/c.ts`),
        linux(path.join(ROOT, 'package.json')),
      ],
      { within: PROJ, config: cfg },
    )
    expect(lines(kept)).toEqual([
      `bun(1) deny(1) file-read-data ${PROJ}/src/a.ts`,
      `openat(x) = -1 ENOENT  [${PROJ}/src/c.ts]`,
    ])
  })

  it('keeps a record with no path at all — the task can grant it', () => {
    const cfg = resolveSandboxConfig({}, PROJ)
    const kept = reportableViolations([mac('system-info', 'vfs.disk-space')], {
      within: PROJ,
      config: cfg,
    })
    expect(lines(kept)).toEqual(['bun(1) deny(1) system-info vfs.disk-space'])
  })

  it('applies `ignore` to both line shapes', () => {
    const cfg = resolveSandboxConfig({ ignore: { write: ['*.bun-build'] } }, PROJ)
    const kept = reportableViolations(
      [
        mac('file-write-create', `${PROJ}/.abc-0000.bun-build`),
        linux(`${PROJ}/.def-0000.bun-build`),
        linux(`${PROJ}/src/real.ts`),
      ],
      { within: PROJ, config: cfg },
    )
    expect(lines(kept)).toEqual([`openat(x) = -1 ENOENT  [${PROJ}/src/real.ts]`])
  })

  it('drops the addressless loopback denial only under localBinding', () => {
    const v: SandboxViolation = { line: 'bun(1) deny(1) network-outbound', timestamp: new Date() }
    expect(
      reportableViolations([v], { within: PROJ, config: resolveSandboxConfig({}, PROJ) }),
    ).toHaveLength(1)
    expect(
      reportableViolations([v], {
        within: PROJ,
        config: resolveSandboxConfig({ allow: { localBinding: true } }, PROJ),
      }),
    ).toHaveLength(0)
  })
})

describe.skipIf(process.platform !== 'darwin')('nested seatbelt', () => {
  it(
    'macOS refuses to apply a policy inside a sandboxed process',
    async () => {
      if (!(await sandboxAvailable('nested seatbelt'))) return
      await initSandbox()
      const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-nest-'))
      try {
        await writeFile(path.join(dir, 'hello.txt'), 'hi')
        const permissive = '(version 1)(allow default)'
        const r = await runSandboxed({
          command: `sandbox-exec -p '${permissive}' /bin/cat hello.txt`,
          cwd: dir,
          env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
          baseAllowRead: [dir],
          baseAllowWrite: [dir],
          baseDenyRead: [],
          reportWithin: dir,
          config: resolveSandboxConfig({ allow: { read: ['.'] } }, dir),
        })
        expect(r.stdout).toBe('')
        expect(r.stderr).toContain('sandbox_apply: Operation not permitted')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

describe('sandbox probe', () => {
  // The runtime's dependency check says "ripgrep (rg) not found" and stops;
  // the docs named bubblewrap and socat only (item 246). Linux: ripgrep
  // expands the runtime's mandatory deny globs; macOS takes patterns.
  it.skipIf(process.platform !== 'linux')(
    'ripgrep off PATH: the verdict names the three binaries and the install',
    async () => {
      if (!(await sandboxAvailable('ripgrep absent'))) return
      const root = await makeWorkspaceRoot({ prefix: 'vx-sandbox-norg-' })
      const bin = await mkdtemp(path.join(os.tmpdir(), 'vx-no-rg-bin-'))
      try {
        await addProject(root, 'app', {
          config: `
            export default {
              tasks: {
                build: {
                  exec: { command: 'echo built', sandbox: {} },
                  cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
                },
              },
            }
          `,
          files: { 'src/a.txt': 'a1\n' },
        })
        // Everything the run needs but rg: bun, sh, git and the runtime's own
        // binaries. The dependency check runs before any task's spawn.
        await symlink(process.execPath, path.join(bin, 'bun'))
        for (const name of ['sh', 'git', 'bwrap', 'socat', 'strace']) {
          const found = Bun.which(name)
          if (found !== null) await symlink(found, path.join(bin, name))
        }
        const p = Bun.spawnSync({
          cmd: [
            process.execPath,
            path.resolve(import.meta.dir, '..', 'src', 'bin.ts'),
            'run',
            'build',
            '--all',
          ],
          cwd: root,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, NO_COLOR: '1', CI: '', PATH: bin },
        })
        const text = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr)
        expect(p.exitCode).toBe(1)
        expect(text).toContain(
          'sandbox not available: the sandbox runtime needs bubblewrap (bwrap), socat and ripgrep (rg) on PATH: ripgrep (rg) not found — install it (Linux: apt install bubblewrap socat ripgrep',
        )
      } finally {
        await rm(root, { recursive: true, force: true })
        await rm(bin, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  // A temp directory that is not there fails the runtime's own mkdtemp;
  // the verdict named the path and no knob (item 243).
  it(
    "a temp directory too long for the runtime's socket: the verdict names TMPDIR",
    async () => {
      if (!(await sandboxAvailable('tmpdir too long'))) return
      const root = await makeWorkspaceRoot({ prefix: 'vx-sandbox-tmplong-' })
      try {
        await addProject(root, 'app', {
          config: `
            export default {
              tasks: {
                build: {
                  exec: { command: 'echo built', sandbox: {} },
                  cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
                },
              },
            }
          `,
          files: { 'src/a.txt': 'a1\n' },
        })
        // An EXISTING directory whose socket path is just past the limit.
        const limit = process.platform === 'darwin' ? 103 : 107
        const base = path.join(os.tmpdir(), 'vx-long-')
        const long =
          base + 'x'.repeat(Math.max(1, limit - base.length - 'srt-mux-1-zzz.sock'.length + 8))
        await mkdir(long, { recursive: true })
        try {
          const p = Bun.spawnSync({
            cmd: [
              process.execPath,
              path.resolve(import.meta.dir, '..', 'src', 'bin.ts'),
              'run',
              'build',
              '--all',
            ],
            cwd: root,
            stdout: 'pipe',
            stderr: 'pipe',
            env: { ...process.env, NO_COLOR: '1', CI: '', TMPDIR: long },
          })
          const text = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr)
          expect(p.exitCode).toBe(1)
          expect(text).toContain(
            'sandbox not available: the sandbox runtime listens on a unix socket under the temp directory, and ',
          )
          expect(text).toContain(
            `bytes where the OS allows ${limit} — point TMPDIR at a shorter path`,
          )
          expect(text).not.toContain('Failed to create bridge sockets')
          expect(text).not.toContain('ENAMETOOLONG')
        } finally {
          await rm(long, { recursive: true, force: true })
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'a temp directory that is not there: the verdict names TMPDIR',
    async () => {
      if (!(await sandboxAvailable('tmpdir refusal'))) return
      const root = await makeWorkspaceRoot({ prefix: 'vx-sandbox-tmpdir-' })
      try {
        await addProject(root, 'app', {
          config: `
            export default {
              tasks: {
                build: {
                  exec: { command: 'echo built', sandbox: {} },
                  cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
                },
              },
            }
          `,
          files: { 'src/a.txt': 'a1\n' },
        })
        // Directly under the temp directory, not under the workspace: the
        // runtime's first temp use on macOS is a unix socket, and a path
        // under a workspace under the runner's temp directory was past the
        // socket limit (ENAMETOOLONG on the darwin job, not ENOENT).
        const missing = path.join(os.tmpdir(), `no-such-tmp-${process.pid}`)
        const p = Bun.spawnSync({
          cmd: [
            process.execPath,
            path.resolve(import.meta.dir, '..', 'src', 'bin.ts'),
            'run',
            'build',
            '--all',
          ],
          cwd: root,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, NO_COLOR: '1', CI: '', TMPDIR: missing },
        })
        const text = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr)
        expect(p.exitCode).toBe(1)
        expect(text).toContain(
          'sandbox not available: the sandbox runtime needs a writable temp directory and ',
        )
        expect(text).toContain(`${missing} is not one (ENOENT:`)
        expect(text).toContain('point TMPDIR at a writable directory')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it('returns a stable shape', async () => {
    const a = await probeSandbox()
    expect(typeof a.available).toBe('boolean')
    expect(typeof a.reason).toBe('string')
    if (a.available) expect(a.reason).toBe('')
    else expect(a.reason.length).toBeGreaterThan(0)
  })

  // The verdict must be the wrapper's own: until 2026-09-04 the Linux
  // probe ran a bare `bwrap … /bin/true`, which passed on hosts where the
  // runtime's seccomp helper then failed every task (root in a container:
  // EPERM on its nested uid_map). Available ⇒ a sandboxed `true` exits 0.
  it.skipIf(process.platform !== 'linux')(
    'linux: an available verdict means a sandboxed `true` exits 0',
    async () => {
      const a = await probeSandbox()
      if (!a.available) {
        // With VX_REQUIRE_SANDBOX the gate helper has already failed the
        // file; without it an unavailable host proves nothing here.
        expect(a.reason.length).toBeGreaterThan(0)
        return
      }
      await initSandbox()
      const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-probe-'))
      try {
        const r = await runSandboxed({
          command: 'true',
          cwd: dir,
          env: process.env,
          baseAllowRead: [dir],
          baseAllowWrite: [dir],
          baseDenyRead: [],
          reportWithin: dir,
          config: resolveSandboxConfig({}, dir),
        })
        expect([r.exitCode, r.stderr]).toEqual([0, ''])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

describe.skipIf(process.platform !== 'linux')(
  'punchWritePaths — a read grant is never an ancestor of a write grant (linux)',
  () => {
    // bwrap emits `--bind <out>` then `--ro-bind <readPath>`; when the read
    // path is an ANCESTOR the read-only mount lands on top and every write
    // fails with `Read-only file system` (verified in a Linux container,
    // 2026-09-05: read=[proj] write=[proj/dist] → mkdir fails; read=[proj/src]
    // → ok). Expanding the ancestor into its children fixes it.
    let dir: string

    beforeEach(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'vx-punch-'))
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await mkdir(path.join(dir, 'dist'), { recursive: true })
      await mkdir(path.join(dir, 'nested', 'deep'), { recursive: true })
      await writeFile(path.join(dir, 'package.json'), '{}')
    })
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('returns the grant untouched when no write path is under it', () => {
      expect(punchWritePaths(dir, [])).toEqual([dir])
      expect(punchWritePaths(dir, ['/elsewhere/out'])).toEqual([dir])
      // a write path EQUAL to the grant is not an ancestor relationship
      expect(punchWritePaths(dir, [dir])).toEqual([dir])
    })

    it('replaces the ancestor with its children, dropping the write path', () => {
      const got = punchWritePaths(dir, [path.join(dir, 'dist')]).sort()
      expect(got).toEqual(
        [path.join(dir, 'src'), path.join(dir, 'nested'), path.join(dir, 'package.json')].sort(),
      )
    })

    it('recurses only along the branch that contains a write path', () => {
      const deepOut = path.join(dir, 'nested', 'deep')
      const got = punchWritePaths(dir, [deepOut])
      // `nested` is expanded because the write path is under it; `src` and
      // `package.json` are handed over whole.
      expect(got).toContain(path.join(dir, 'src'))
      expect(got).toContain(path.join(dir, 'package.json'))
      expect(got).not.toContain(path.join(dir, 'nested'))
      expect(got).not.toContain(deepOut)
    })

    it('hands over a path it cannot read rather than dropping the grant', () => {
      const missing = path.join(dir, 'does-not-exist')
      expect(punchWritePaths(missing, [path.join(missing, 'out')])).toEqual([missing])
    })
  },
)

describe('localBinding accepts a boolean or a port list', () => {
  const cfg = (localBinding: unknown) => ({
    tasks: { t: { exec: { command: 'true', sandbox: { allow: { localBinding } } } } },
  })
  const where = 'x'
  it('accepts true, false and a non-empty list of TCP ports', () => {
    for (const v of [true, false, [3000], [1, 65535, 8080]]) {
      expect(() => validateProjectConfig(cfg(v) as never, where)).not.toThrow()
    }
  })
  it('refuses an empty list, a non-integer, an out-of-range port and a string', () => {
    for (const v of [[], [0], [65536], [3000.5], ['3000'], 'true', 3000]) {
      expect(() => validateProjectConfig(cfg(v) as never, where)).toThrow(
        /localBinding must be a boolean or a non-empty list of ports/,
      )
    }
  })
})

describe('localBinding port list — the pure halves', () => {
  it('a list grants loopback like `true`; an empty list and `false` do not', () => {
    expect(localBindingOn({ localBinding: true })).toBe(true)
    expect(localBindingOn({ localBinding: [3000] })).toBe(true)
    expect(localBindingOn({ localBinding: [] })).toBe(false)
    expect(localBindingOn({ localBinding: false })).toBe(false)
    expect(localBindingOn({})).toBe(false)
  })

  it('bridges the listed ports once each; `true` bridges nothing', () => {
    expect(bridgedPorts({ localBinding: [3000, 3001, 3000] })).toEqual([3000, 3001])
    expect(bridgedPorts({ localBinding: true })).toEqual([])
    expect(bridgedPorts({})).toEqual([])
  })

  it("the task's side listens on the unix socket and relays into loopback; the host's side the reverse, with a retry", () => {
    const sock = portBridgeSocket('t1', 3000)
    expect(sock.endsWith('/vx-port-t1-3000.sock')).toBe(true)
    const inner = portBridgeInner([3000, 3001], 't1')
    expect(inner).toContain(
      `socat UNIX-LISTEN:${sock},fork,unlink-early TCP:127.0.0.1:3000 >/dev/null 2>&1 &`,
    )
    expect(inner).toContain('TCP:127.0.0.1:3001')
    // Backgrounded socats are reaped with the shell, as SRT reaps its own.
    expect(inner.endsWith("trap 'kill $(jobs -p) 2>/dev/null' EXIT;")).toBe(true)
    expect(portBridgeHostArgv('t1', 3000)).toEqual([
      'socat',
      'TCP-LISTEN:3000,bind=127.0.0.1,fork,reuseaddr',
      `UNIX-CONNECT:${sock},retry=40,interval=0.25`,
    ])
  })
})

describe.skipIf(!available || process.platform !== 'linux')(
  'a sandboxed task exposes a port on Linux (localBinding port list)',
  () => {
    let fixture: Fixture
    beforeEach(async () => {
      fixture = await makeWorkspace()
    })
    afterEach(async () => {
      await rm(fixture.root, { recursive: true, force: true })
    })

    /** A port nothing on this box listens on: bind it, read it, release it. */
    function freePort(): number {
      const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
      const port = l.port
      l.stop(true)
      return port
    }

    const files = (port: number) => ({
      'serve.ts':
        `Bun.serve({ port: ${port}, hostname: '127.0.0.1', fetch: () => new Response('hi') })\n` +
        `console.log('serving')\n`,
      'client.ts':
        `const r = await fetch('http://127.0.0.1:${port}/')\n` +
        `await Bun.write('out.txt', await r.text())\n`,
    })
    const serverConfig = (localBinding: string): string => `
      export default {
        tasks: {
          serve: {
            exec: {
              command: 'bun serve.ts',
              persistent: { readyWhen: 'serving' },
              sandbox: { allow: { read: ['.'], localBinding: ${localBinding} } },
            },
          },
          // NOT sandboxed: the host's loopback is what a developer's browser
          // or a sibling task sees, and that is the claim.
          client: {
            dependsOn: ['serve'],
            exec: { command: 'bun client.ts' },
          },
        },
      }
    `

    it(
      'a listed port is reachable from outside the sandbox while the server runs, and closed after the run',
      async () => {
        const port = freePort()
        await addProject(fixture.root, 'srv', {
          files: files(port),
          config: serverConfig(`[${port}]`),
        })
        const r = await run({
          cwd: fixture.root,
          tasks: ['client'],
          log: collectingLogger(fixture),
        })
        expectOk(r, fixture)
        expect(await readFile(path.join(fixture.root, 'packages', 'srv', 'out.txt'), 'utf8')).toBe(
          'hi',
        )
        // The bridge lives exactly as long as the server: the run tore the
        // server down, so the host's side is gone and the port is closed.
        await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
      },
      TIMEOUT,
    )

    it(
      'control: `localBinding: true` binds inside the namespace and the host sees nothing',
      async () => {
        const port = freePort()
        await addProject(fixture.root, 'srv', { files: files(port), config: serverConfig('true') })
        const r = await run({
          cwd: fixture.root,
          tasks: ['client'],
          log: collectingLogger(fixture),
        })
        expect(r.ok).toBe(false)
        const client = r.outcomes.find((o) => o.node.id === 'srv#client')
        expect(client?.status).toBe('failed')
        expect(fixture.log.join('\n')).toMatch(/ECONNREFUSED|Unable to connect|ConnectionRefused/)
      },
      TIMEOUT,
    )
  },
)

describe.skipIf(!available || process.platform !== 'linux')(
  'a stale mux socket under this pid does not stop the runtime',
  () => {
    it(
      "a dead process's socket file with a recycled pid is removed before SRT listens",
      async () => {
        // A regular file is enough: `listen` on any existing path is EADDRINUSE.
        const stale = path.join(os.tmpdir(), `srt-mux-${process.pid}-0.sock`)
        await resetSandbox()
        await writeFile(stale, '')
        try {
          const verdict = await probeSandbox()
          expect(verdict.available).toBe(true)
          expect(existsSync(stale)).toBe(false)
        } finally {
          await rm(stale, { force: true })
          await resetSandbox()
        }
      },
      TIMEOUT,
    )
  },
)
