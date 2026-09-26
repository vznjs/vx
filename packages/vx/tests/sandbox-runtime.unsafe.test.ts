// Sandbox-runtime integration tests.
//
// These tests are gated on SRT's runtime deps (bwrap on Linux,
// sandbox-exec on macOS). CI installs bubblewrap + socat + strace,
// disables AppArmor's unprivileged-userns restriction, and sets
// VX_REQUIRE_SANDBOX — so an unavailable runtime FAILS there rather than
// skipping, because a skipped suite reports green and this one covers
// the isolation boundary. A local host without the deps still skips.

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { addProject, makeWorkspace as makeWorkspaceRoot } from './helpers/workspace.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import {
  initSandbox,
  probeSandbox,
  resetSandbox,
  type SandboxViolation,
  resolveSandboxConfig,
  runSandboxed,
  wrapSandboxedCommand,
} from '../src/exec/sandbox-runtime.js'
import { buildCustomConfig, punchWritePaths } from '../src/exec/sandbox-binds.js'
import {
  bridgedPorts,
  portBridgeHostArgv,
  portBridgeInner,
  portBridgeSocket,
} from '../src/exec/sandbox-runtime.js'
import { localBindingOn } from '../src/exec/sandbox-paths.js'
import {
  deniedCalls,
  parseStraceViolations,
  reportableViolations,
} from '../src/exec/sandbox-violations.js'
import { run, type Logger, type RunOptions, type RunSummary } from '../src/orchestrator/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { isAlive, waitForDead } from './helpers/alive.js'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import * as violations from '../src/exec/sandbox-violations.js'
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

  // The task's PATH leads with the project's node_modules/.bin, and the
  // sandboxed spawn (`strace … -- sh -c` on Linux, `sh -c` elsewhere) let
  // strace or Bun resolve `sh` through it: a dependency's `sh` bin ran in
  // place of the shell. util/which.ts resolves it on vx's own PATH.
  it(
    "a sandboxed task's shell is the machine's, not a node_modules/.bin/sh",
    async () => {
      const projDir = await addProject(fixture.root, 'app', {
        files: { 'node_modules/.bin/sh': '#!/bin/sh\necho hijacked\n' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'echo parsed-by-the-real-shell', sandbox: { allow: { read: ['.'] } } },
              },
            },
          }
        `,
      })
      const { chmod } = await import('node:fs/promises')
      await chmod(path.join(projDir, 'node_modules', '.bin', 'sh'), 0o755)
      const r = await run({ cwd: fixture.root, tasks: ['build'], log: collectingLogger(fixture) })
      expectOk(r, fixture)
      expect(fixture.log).toContain('parsed-by-the-real-shell')
      expect(fixture.log).not.toContain('hijacked')
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
    'an executor that THROWS still takes back the placeholder it never wrote',
    async () => {
      // The one-shot path's other exit. `sandboxRequestFor` creates the
      // empty file for a literal write grant BEFORE the executor runs, and
      // it does so whichever executor that is — the request builder is
      // shared, so a plugin executor gets one too. If that executor
      // rejects (a wire down, a malformed result caught by
      // `assertExecuteResult`), the sweep in the catch is the only thing
      // that takes the file back, and nothing in the repo drove it: the
      // combination needs a plugin executor AND a sandboxed task with a
      // literal grant. Left behind, the file is exactly the trap the whole
      // placeholder machinery exists to prevent — the task's own `mkdir`
      // says "File exists" on every later run, and a `dist/**` clean
      // matches nothing under a file, so it never goes away by itself.
      const projDir = await addProject(fixture.root, 'app', {
        files: {},
        config: `export default { tasks: { build: { exec: {
          command: 'mkdir -p out.txt',
          sandbox: { allow: { read: ['.'], write: ['out.txt'] } },
        } } } }\n`,
      })
      await writeFile(
        path.join(fixture.root, 'vx.workspace.mjs'),
        localWorkspaceSource([
          pluginSource(
            'org/thrower',
            `{ executor() {
               return {
                 name: 'thrower',
                 async execute() { throw new Error('WIRE-DOWN') },
               }
             } }`,
          ),
        ]),
      )
      const r = await run({
        cwd: fixture.root,
        tasks: ['build'],
        log: collectingLogger(fixture),
        handleSignals: false,
      })
      expect(r.ok).toBe(false)
      expect(fixture.log.join('\n')).toContain('WIRE-DOWN')
      // The claim: nothing of vx's own is left in the project.
      expect(existsSync(path.join(projDir, 'out.txt'))).toBe(false)
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

describe.skipIf(!available)('a sandboxed task that produced nothing says why', () => {
  // A sandboxed task with no write grant writes into the sandbox's own
  // scratch, and whether the shell even notices depends on the LAYOUT:
  // measured (item 444), a nested project's write is refused outright,
  // while in a single-package workspace — project dir === workspace root,
  // which is where vx's deny anchor and the cwd become the same path —
  // the write SUCCEEDS into that scratch and the task exits 0. There the
  // miss-save warning is the only thing that says the build produced
  // nothing, so it names the likely cause.
  //
  // Config-only on purpose: the rows below run `true` and declare an
  // output glob that matches nothing, so they assert the MESSAGE's rule
  // rather than any platform's denial behaviour.
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  // `undefined` declares no `allow` at all; an ARRAY declares one, and an
  // empty array is the edge that matters — a write list that grants
  // nothing is not a grant, and the clause must still fire.
  const project = async (write: string | readonly string[] | undefined): Promise<void> => {
    const allow =
      write === undefined
        ? '{}'
        : `{ allow: { write: [${(typeof write === 'string' ? [write] : write)
            .map((w) => `'${w}'`)
            .join(', ')}] } }`
    await addProject(fixture.root, 'app', {
      files: { 'src/x.txt': 'hi' },
      config: `
        export default {
          tasks: {
            build: {
              exec: {
                command: 'true',
                sandbox: ${allow},
              },
              cache: {
                inputs: { files: ['src/**'] },
                outputs: { files: ['nope/**'] },
              },
            },
          },
        }
      `,
    })
  }

  const warning = (): string | undefined =>
    fixture.log.find((l) => l.includes('cache.outputs matched no files'))

  it(
    'names the missing write grant, because nothing else would',
    async () => {
      await project(undefined)
      const r = await run({ cwd: fixture.root, tasks: ['build'], log: collectingLogger(fixture) })
      expectOk(r, fixture)
      expect(warning()).toContain('declares no exec.sandbox.allow.write')
    },
    TIMEOUT,
  )

  it(
    'an EMPTY write list is not a grant',
    async () => {
      // The clause asks whether the task granted any write, and the two rows
      // around this one only ever compare "no `allow` at all" against "one
      // path". An explicit `write: []` sits between them: read the question
      // as "is there an `allow.write` key" instead of "does it grant
      // anything" and the clause goes quiet for a task whose writes reach
      // disk exactly as rarely as the one it was written for.
      await project([])
      const r = await run({ cwd: fixture.root, tasks: ['build'], log: collectingLogger(fixture) })
      expectOk(r, fixture)
      expect(warning()).toContain('declares no exec.sandbox.allow.write')
    },
    TIMEOUT,
  )

  it(
    'CONTROL: a task that DID declare a write grant is not blamed for the sandbox',
    async () => {
      // Same missing output glob, so the warning still fires — only the
      // cause clause differs. Without this the row above would pass for a
      // message that always blames the sandbox.
      await project('dist/')
      const r = await run({ cwd: fixture.root, tasks: ['build'], log: collectingLogger(fixture) })
      expectOk(r, fixture)
      expect(warning()).toContain('matched no files')
      expect(warning()).not.toContain('exec.sandbox.allow.write')
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
    // (item 443). `sandboxRequestFor` builds a request that carries no
    // write of its own, so a declared `cache.outputs` buys the task no
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

describe.skipIf(!available || process.platform !== 'linux')(
  'an undeclared read, run for real',
  () => {
    // The landing's fifth callout, "a read you did not declare fails the
    // task", as a real trace: `app#build` reads `banner.txt` without
    // declaring it and fails with exactly one violation line naming it, and
    // declaring the file lets the task pass. (The Guide's stale-hit demo,
    // which held its text to a synthetic trace, went with the Guide.)
    let fixture: Fixture

    beforeEach(async () => {
      fixture = await makeWorkspace()
    })
    afterEach(async () => {
      await rm(fixture.root, { recursive: true, force: true })
    })

    const config = (files: string[]): string => `
      export default {
        tasks: {
          build: {
            exec: {
              command: 'mkdir -p dist && cat src/index.ts banner.txt > dist/out.txt',
              sandbox: { allow: { read: ${JSON.stringify(files)}, write: ['dist/'] } },
            },
            cache: { inputs: { files: ${JSON.stringify(files)} }, outputs: { files: ['dist/**'] } },
          },
        },
      }
    `

    it(
      'the undeclared read fails with one line naming banner.txt; declaring it passes',
      async () => {
        const dir = await addProject(fixture.root, 'app', {
          config: config(['src/**']),
          files: {
            'src/index.ts': 'export default 2\n',
            'banner.txt': '/*! v2 */\n',
          },
        })
        const r = await run({ cwd: fixture.root, tasks: ['build'], log: collectingLogger(fixture) })
        expect(r.outcomes[0]?.status).toBe('failed')
        expect(r.outcomes[0]?.exitCode).toBe(1)
        expect(r.outcomes[0]?.sandboxViolationLines).toEqual([
          `openat(banner.txt) = -1 ENOENT  [${realpathSync(dir)}/banner.txt]`,
        ])
        // The logger trims each stderr chunk, and cat's message arrives split
        // wherever its writes land (after `cat:` in one gate, and as
        // `cat:` / `banner.txt` / `: No such…` on CI), so the comparison drops
        // whitespace, which no split can move.
        expect(fixture.log.join('').replace(/\s/g, '')).toContain(
          'cat:banner.txt:Nosuchfileordirectory',
        )

        await writeFile(path.join(dir, 'vx.config.mjs'), config(['src/**', 'banner.txt']))
        const declared = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: collectingLogger(fixture),
        })
        expectOk(declared, fixture)
        expect(await readFile(path.join(dir, 'dist', 'out.txt'), 'utf8')).toBe(
          'export default 2\n/*! v2 */\n',
        )
      },
      TIMEOUT,
    )
  },
)

describe.skipIf(!available || process.platform !== 'linux')(
  'the demo in an npm or Yarn workspace, which links the task its own project',
  () => {
    // npm and Yarn classic link EVERY workspace package at the root, the
    // task's own included, and the link grant used to hand that target
    // back whole: `web#build`, granted `src/**`, read `banner.txt` with no
    // violation, and an edit to it was a stale hit — the demo above,
    // false in any npm or Yarn workspace
    // (docs/design/linked-sibling-reads-2026-09.md, P3). Linux-only like
    // the demo, for its strace line.
    let fixture: Fixture

    beforeEach(async () => {
      fixture = await makeWorkspace()
    })
    afterEach(async () => {
      await rm(fixture.root, { recursive: true, force: true })
    })

    const config = (files: string[], command: string): string => `
      export default {
        tasks: {
          build: {
            exec: {
              command: ${JSON.stringify(command)},
              sandbox: { allow: { read: ${JSON.stringify(files)}, write: ['dist/'] } },
            },
            cache: { inputs: { files: ${JSON.stringify(files)} }, outputs: { files: ['dist/**'] } },
          },
        },
      }
    `
    const demo = 'mkdir -p dist && cat src/index.ts banner.txt > dist/out.txt'

    /** `web` and `ui`, both linked at the root as npm lays them out; returns web's dir. */
    const npmWorkspace = async (command: string): Promise<string> => {
      const dir = await addProject(fixture.root, '@x/web', {
        config: config(['src/**'], command),
        files: { 'src/index.ts': 'export default 2\n', 'banner.txt': '/*! v2 */\n' },
      })
      await addProject(fixture.root, '@x/ui', { files: { 'index.js': 'export const ui = 1\n' } })
      await mkdir(path.join(fixture.root, 'node_modules', '@x'), { recursive: true })
      await symlink('../../packages/x-web', path.join(fixture.root, 'node_modules', '@x', 'web'))
      await symlink('../../packages/x-ui', path.join(fixture.root, 'node_modules', '@x', 'ui'))
      return dir
    }

    const deniesBanner = async (cwd: string, dir: string): Promise<void> => {
      const r = await run({ cwd, tasks: ['build'], log: collectingLogger(fixture) })
      expect(r.outcomes[0]?.status).toBe('failed')
      expect(r.outcomes[0]?.sandboxViolationLines).toEqual([
        `openat(banner.txt) = -1 ENOENT  [${realpathSync(dir)}/banner.txt]`,
      ])
    }

    it(
      'the self-link grants nothing: the undeclared read fails with one line naming banner.txt',
      async () => {
        const dir = await npmWorkspace(demo)
        await deniesBanner(fixture.root, dir)
        // The edit that was a stale hit is a run that fails the same way.
        await writeFile(path.join(dir, 'banner.txt'), '/*! v3 */\n')
        await deniesBanner(fixture.root, dir)

        await writeFile(path.join(dir, 'vx.config.mjs'), config(['src/**', 'banner.txt'], demo))
        const declared = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: collectingLogger(fixture),
        })
        expectOk(declared, fixture)
        expect(await readFile(path.join(dir, 'dist', 'out.txt'), 'utf8')).toBe(
          'export default 2\n/*! v3 */\n',
        )
      },
      TIMEOUT,
    )

    it(
      'the same through a symlinked workspace root (the macOS `/var` shape)',
      async () => {
        // The project directory vx holds is the link path; the self-link's
        // target is canonical. Compared as given, they differ and the
        // project is granted back.
        const link = path.join(path.dirname(fixture.root), `${path.basename(fixture.root)}-link`)
        await symlink(fixture.root, link, 'dir')
        try {
          const dir = await npmWorkspace(demo)
          await deniesBanner(link, dir)
        } finally {
          await rm(link, { force: true })
        }
      },
      TIMEOUT,
    )
  },
)

describe.skipIf(!available || process.platform !== 'linux')(
  'a cached task reads a linked sibling only when its key answers for it',
  () => {
    // `app#test` reads `@x/ui`'s source through its `node_modules` link.
    // With no edge to a task of ui, its key never moved with ui: the read
    // ran unreported and an edit to ui was a stale hit, replaying the old
    // file (docs/design/linked-sibling-reads-2026-09.md, P1). The link is
    // now withheld from a cached task whose key does not answer for ui, so
    // the read fails, is reported, and names the edge that would key it.
    // Both layouts: npm and Yarn link at the root, pnpm and Bun under the
    // project. Linux-only for the strace line.
    let fixture: Fixture

    beforeEach(async () => {
      fixture = await makeWorkspace()
    })
    afterEach(async () => {
      await rm(fixture.root, { recursive: true, force: true })
    })

    type Layout = 'root' | 'project'
    const linkPath: Record<Layout, string> = {
      root: '../../node_modules/@x/ui',
      project: 'node_modules/@x/ui',
    }

    const appConfig = (layout: Layout, opts: { cache: boolean; dependsOn: string[] }): string => `
      export default {
        tasks: {
          test: {
            exec: {
              command: 'mkdir -p dist && cat ${linkPath[layout]}/src/index.js > dist/out.txt',
              sandbox: { allow: { read: ['.'], write: ['dist/'] } },
            },
            dependsOn: ${JSON.stringify(opts.dependsOn)},
            ${opts.cache ? "cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } }," : ''}
          },
        },
      }
    `

    /** `@x/app` depending on `@x/ui`, linked as `layout` lays it out; returns both dirs. */
    const workspace = async (
      layout: Layout,
      opts: { cache: boolean; dependsOn: string[] },
    ): Promise<{ app: string; ui: string }> => {
      const ui = await addProject(fixture.root, '@x/ui', {
        files: { 'src/index.js': 'export const ui = 1\n' },
        config: `
          export default {
            tasks: {
              source: {
                exec: { command: 'true' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
              },
            },
          }
        `,
      })
      const app = await addProject(fixture.root, '@x/app', {
        deps: { '@x/ui': 'workspace:*' },
        files: { 'src/index.js': 'export const app = 1\n' },
        config: appConfig(layout, opts),
      })
      if (layout === 'root') {
        await mkdir(path.join(fixture.root, 'node_modules', '@x'), { recursive: true })
        await symlink('../../packages/x-app', path.join(fixture.root, 'node_modules', '@x', 'app'))
        await symlink('../../packages/x-ui', path.join(fixture.root, 'node_modules', '@x', 'ui'))
      } else {
        await mkdir(path.join(app, 'node_modules', '@x'), { recursive: true })
        await symlink('../../../x-ui', path.join(app, 'node_modules', '@x', 'ui'))
      }
      return { app, ui }
    }

    const runTest = (cwd = fixture.root) =>
      run({ cwd, tasks: ['@x/app#test'], log: collectingLogger(fixture) })
    const testOutcome = (r: RunSummary) => r.outcomes.find((o) => o.node.id === '@x/app#test')

    const withheldAndReported = async (layout: Layout): Promise<void> => {
      const { ui } = await workspace(layout, { cache: true, dependsOn: [] })
      const link = layout === 'root' ? 'node_modules/@x/ui' : 'packages/x-app/node_modules/@x/ui'
      const expected = [
        `openat(${linkPath[layout]}/src/index.js) = -1 ENOENT  [${realpathSync(ui)}/src/index.js]`,
        `vx: @x/app#test read \`packages/x-ui\` through \`${link}\`, and its key folds no task ` +
          'of @x/ui, so an edit there would not re-run it. Add a `dependsOn` edge that ' +
          'reaches one (`^build` where @x/ui#build keys its sources, or a `source` task: ' +
          '`@x/ui#source`), or grant and key the files yourself (`allow.read` plus ' +
          '`cache.inputs.workspaceFiles`).',
      ]
      const first = testOutcome(await runTest())
      expect(first?.status).toBe('failed')
      expect(first?.sandboxViolationLines).toEqual(expected)
      // The edit that was a stale hit is a run that fails the same way.
      await writeFile(path.join(ui, 'src', 'index.js'), 'export const ui = 2\n')
      const second = testOutcome(await runTest())
      expect(second?.status).toBe('failed')
      expect(second?.sandboxViolationLines).toEqual(expected)
    }

    // Titles spelled out: the site's proof list links the first by name.
    it(
      'an unkeyed sibling is withheld and the read reported, with the hint (root link)',
      () => withheldAndReported('root'),
      TIMEOUT,
    )
    it(
      'an unkeyed sibling is withheld and the read reported, with the hint (project link)',
      () => withheldAndReported('project'),
      TIMEOUT,
    )

    it(
      'CONTROL: with an edge to a keyed task of the sibling, the read passes and an edit re-runs it',
      async () => {
        const { app, ui } = await workspace('project', { cache: true, dependsOn: ['^source'] })
        const out = path.join(app, 'dist', 'out.txt')
        const r1 = await runTest()
        expectOk(r1, fixture)
        expect(testOutcome(r1)?.sandboxViolations).toBeUndefined()
        expect(await readFile(out, 'utf8')).toBe('export const ui = 1\n')

        await writeFile(path.join(ui, 'src', 'index.js'), 'export const ui = 2\n')
        const r2 = await runTest()
        expectOk(r2, fixture)
        expect(testOutcome(r2)?.status).toBe('success')
        expect(await readFile(out, 'utf8')).toBe('export const ui = 2\n')

        await writeFile(path.join(ui, 'src', 'index.js'), 'export const ui = 1\n')
        const r3 = await runTest()
        expect(testOutcome(r3)?.status).toBe('cache-hit')
        expect(await readFile(out, 'utf8')).toBe('export const ui = 1\n')
      },
      TIMEOUT,
    )

    it(
      'CONTROL: a task with no `cache` keeps the grant, having no key to be stale',
      async () => {
        const { app } = await workspace('root', { cache: false, dependsOn: [] })
        const r = await runTest()
        expectOk(r, fixture)
        expect(testOutcome(r)?.sandboxViolations).toBeUndefined()
        expect(await readFile(path.join(app, 'dist', 'out.txt'), 'utf8')).toBe(
          'export const ui = 1\n',
        )
      },
      TIMEOUT,
    )

    it(
      'the same split through a symlinked workspace root (the macOS `/var` shape)',
      async () => {
        const link = path.join(path.dirname(fixture.root), `${path.basename(fixture.root)}-link`)
        await symlink(fixture.root, link, 'dir')
        try {
          await workspace('root', { cache: true, dependsOn: [] })
          const denied = testOutcome(await runTest(link))
          expect(denied?.status).toBe('failed')
          expect(denied?.sandboxViolations).toBe(2)
          await writeFile(
            path.join(fixture.root, 'packages', 'x-app', 'vx.config.mjs'),
            appConfig('root', { cache: true, dependsOn: ['^source'] }),
          )
          const keyed = await runTest(link)
          expectOk(keyed, fixture)
        } finally {
          await rm(link, { force: true })
        }
      },
      TIMEOUT,
    )
  },
)

describe.skipIf(!available || process.platform !== 'linux')(
  'two sandboxed tasks at once each get their OWN violations',
  () => {
    // Linux detects violations by tracing the spawn with strace and parsing
    // the trace, and the log path is keyed by the task's command tag "so
    // parallel tasks don't share a stream". Nothing pinned that: pointing
    // every task at one path survives the whole repo (item 448) — and
    // `strace -o` TRUNCATES, so a second task starting mid-run destroys the
    // first one's trace. Enforcement is unaffected (bwrap denies either
    // way); what is lost is the explanation, which is the thing this file
    // works hardest to guarantee — "a sandboxed task that fails must say
    // what it was denied".
    //
    // Both tasks sleep briefly so their traces overlap. That is a harness
    // device to make the concurrency real, not a claim about timing: the
    // assertion is each task's own violation COUNT, which does not depend
    // on how long either ran.
    let fixture: Fixture

    beforeEach(async () => {
      fixture = await makeWorkspace()
    })
    afterEach(async () => {
      await rm(fixture.root, { recursive: true, force: true })
    })

    const denier = (name: string) =>
      addProject(fixture.root, name, {
        files: { 'src/in.txt': 'hi', 'secret.txt': `${name} secret` },
        config: `
          export default {
            tasks: {
              build: {
                exec: {
                  command: 'sleep 0.4; mkdir -p probe; cat secret.txt > probe/got.txt 2>/dev/null; echo done',
                  sandbox: { allow: { read: ['src/**'], write: ['probe/'] } },
                },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
              },
            },
          }
        `,
      })

    it(
      'neither task loses its trace to the other',
      async () => {
        await denier('alpha')
        await denier('beta')
        const r = await run({
          cwd: fixture.root,
          tasks: ['build'],
          concurrency: 2,
          log: collectingLogger(fixture),
        })
        // Each read of its own `secret.txt` is undeclared, so each task is
        // denied once and fails. With one shared trace the loser reports
        // nothing at all.
        expect(r.outcomes).toHaveLength(2)
        for (const o of r.outcomes) {
          expect([o.node.id, o.status]).toEqual([o.node.id, 'failed'])
          expect([o.node.id, o.sandboxViolations]).toEqual([o.node.id, 1])
        }
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
  it.skipIf(process.platform !== 'linux')(
    'says so when a WRITE grant mounts nothing, and names the directory to grant instead',
    async () => {
      // Item 496, measured before it existed: one task per grant spelling,
      // each writing the files it declares. `g/**` and `g/a.txt` succeed —
      // the first collapses to the directory, the second is a file-shaped
      // grant widened to its directory. `g/*`, `g/*.txt`, `g/?.txt` and
      // `g/[ab].txt` all FAILED with `bash: g/a.txt: Read-only file
      // system`, because a bwrap bind covers what exists when the task
      // STARTS and those matched nothing yet.
      //
      // That is the documented contract ("declare its directory instead"),
      // not a defect — but the user learned it from their own tool, in a
      // message naming neither vx nor the grant. So the grant reports
      // itself, and the remedy it names is `staticPrefix`, the directory
      // the user meant, NOT the scan's anchor one component above it.
      //
      // Linux only: `expandGrants` returns before the scan on every other
      // platform, so there is nothing to report there.
      const root = await mkdtemp(path.join(os.tmpdir(), 'vx-sbx-empty-write-'))
      try {
        await mkdir(path.join(root, 'g'))
        const said: string[] = []
        const spy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
          said.push(String(chunk))
          return true
        })
        try {
          resolveSandboxConfig({ allow: { write: ['g/*.txt'] } }, root)
          // CONTROL, in the same spy window: a grant that CAN be mounted
          // says nothing, so the row above cannot pass on a warning that
          // fires for every write grant.
          resolveSandboxConfig({ allow: { write: ['g/**'] } }, root)
          // CONTROL: a READ grant matching nothing is ordinary — an
          // optional file, a cache not yet populated — and must stay quiet.
          // A DIFFERENT pattern on purpose: the report is once per grant
          // path, so reusing `g/*.txt` here would be silenced by the write
          // call above and the control would pass whatever reads do. It
          // did, first time — the mutation that reports reads as well
          // survived it (item 496).
          resolveSandboxConfig({ allow: { read: ['g/r*.txt'] } }, root)
        } finally {
          spy.mockRestore()
        }
        expect(said.length).toBe(1)
        expect(said[0]).toContain('matches nothing yet')
        // The remedy is the directory the pattern was IN, not its parent.
        expect(said[0]).toContain(`${path.join(realpathSync(root), 'g')}/**`)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  // Item 652: the scan behind a glob grant. Every fixture above matches
  // plain files only and names patterns that either match or warn, so the
  // scan's `dot` and `onlyFiles` options and the warning's own conditions
  // (a hit, once per grant) could each go with the suite green.
  it.skipIf(process.platform !== 'linux')(
    'a glob grant covers the dotfiles and directories it matches',
    async () => {
      const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-sbx-scan-')))
      try {
        await mkdir(path.join(root, 'g', 'sub'), { recursive: true })
        await writeFile(path.join(root, 'g', '.env'), '')
        await writeFile(path.join(root, 'g', 'a.txt'), '')
        const r = resolveSandboxConfig({ allow: { read: ['g/*'] } }, root)
        expect([...r.allowRead].sort()).toEqual(
          ['g/.env', 'g/a.txt', 'g/sub'].map((f) => path.join(root, f)),
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform !== 'linux')(
    'a write grant that matched something says nothing; one that matched nothing says so once',
    async () => {
      const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-sbx-warn-')))
      try {
        await mkdir(path.join(root, 'g'))
        await writeFile(path.join(root, 'g', 'a.txt'), '')
        const said: string[] = []
        const spy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
          said.push(String(chunk))
          return true
        })
        try {
          resolveSandboxConfig({ allow: { write: ['g/*.txt'] } }, root)
          resolveSandboxConfig({ allow: { write: ['g/*.bin'] } }, root)
          resolveSandboxConfig({ allow: { write: ['g/*.bin'] } }, root)
        } finally {
          spy.mockRestore()
        }
        expect(said.map((l) => l.includes(`${root}/g/*.bin matches nothing yet`))).toEqual([true])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('collapses a whole-subtree pattern to its directory, and a single-level one NEVER', async () => {
    // The collapse is documented as "not a widening": `<d>/**` already
    // covered every file under `<d>`, so folding it to `<d>` only adds the
    // directory entry. That reasoning is exactly what fails for `<d>/*`,
    // which covers the immediate children and nothing deeper — folding THAT
    // to `<d>` would hand the task the directory itself and everything
    // created in it later.
    //
    // The `**` half is pinned e2e above ("a whole-directory pattern grants
    // the directory"). The single-star half was not pinned at all: widening
    // the collapse regex to accept one star left the whole repo green, and
    // this is a GRANT, so the two halves are one boundary.
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-sbx-collapse-'))
    try {
      const sub = path.join(root, 'sub')
      await mkdir(sub)
      await Bun.write(path.join(sub, 'a.txt'), 'a')
      const real = realpathSync(root)
      const realSub = path.join(real, 'sub')

      const deep = resolveSandboxConfig({ allow: { read: ['sub/**'] } }, root)
      expect(deep.allowRead).toContain(realSub)

      const shallow = resolveSandboxConfig({ allow: { read: ['sub/*'] } }, root)
      expect(shallow.allowRead).not.toContain(realSub)
      // CONTROL: it still granted something UNDER sub, so the row above is
      // the collapse and not an empty resolution. Deliberately not the
      // expanded child path: `expandGrants` glob-expands on Linux only
      // (`platform !== 'linux'` returns early), so macOS keeps the literal
      // `sub/*` while Linux yields `sub/a.txt`. What both must show is a
      // grant BELOW sub and never sub itself, which is the claim anyway.
      expect(shallow.allowRead.some((p) => p.startsWith(realSub + path.sep))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

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

  // Item 652: each capability the user wrote is carried to the resolved
  // config under its own name. Rows that declare these run where the
  // capability is not observable, so eight of the copies below could be
  // deleted with the suite green. Written out, not derived.
  const CARRIED: Array<[string, Record<string, unknown>, string, unknown]> = [
    ['deny.network', { deny: { network: ['x.test'] } }, 'denyNetwork', ['x.test']],
    ['allow.systemInfo', { allow: { systemInfo: ['hw.ncpu'] } }, 'systemInfo', ['hw.ncpu']],
    ['allow.unixSockets', { allow: { unixSockets: true } }, 'unixSockets', true],
    ['allow.machLookup', { allow: { machLookup: ['com.x'] } }, 'machLookup', ['com.x']],
    ['allow.pty', { allow: { pty: true } }, 'pty', true],
    ['allow.gitConfig', { allow: { gitConfig: true } }, 'gitConfig', true],
    ['weakerWhenNested', { weakerWhenNested: true }, 'weakerWhenNested', true],
    ['weakerNetworkIsolation', { weakerNetworkIsolation: true }, 'weakerNetworkIsolation', true],
  ]
  for (const [what, cfg, key, want] of CARRIED) {
    it(`carries ${what} to ${key}`, () => {
      const r = resolveSandboxConfig(cfg as never, '/nowhere/proj') as unknown as Record<
        string,
        unknown
      >
      expect(r[key]).toEqual(want)
      // CONTROL: undeclared, it is not invented.
      expect(key in resolveSandboxConfig({}, '/nowhere/proj')).toBe(false)
    })
  }

  // Item 652: no row granted a `~` path, so its expansion could go and
  // `~/.npmrc` would resolve against the project, a path that is not there.
  it('expands a leading `~` against the home directory, not the project', () => {
    const r = resolveSandboxConfig({ allow: { read: ['~/.vx-652-probe'] } }, '/nowhere/proj')
    expect(r.allowRead).toEqual([path.join(realpathSync(os.homedir()), '.vx-652-probe')])
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

  it('reads every traced syscall and every denial errno, in both line shapes', () => {
    // Both alphabets, member by member. A syscall or an errno that falls
    // out of either pattern is a denial the report never mentions — the
    // exact failure this detector exists to prevent.
    const done = (sc: string, pth: string, e: string): string =>
      `1 ${sc}(AT_FDCWD, "${pth}", 0) = -1 ${e} (x)`
    expect(
      deniedCalls(
        [
          done('openat', '/ws/o', 'ENOENT'),
          done('access', '/ws/a', 'EACCES'),
          done('statx', '/ws/s', 'EPERM'),
          done('newfstatat', '/ws/n', 'ENOENT'),
        ].join('\n'),
      ),
    ).toEqual([
      { syscall: 'openat', rawPath: '/ws/o', errno: 'ENOENT' },
      { syscall: 'access', rawPath: '/ws/a', errno: 'EACCES' },
      { syscall: 'statx', rawPath: '/ws/s', errno: 'EPERM' },
      { syscall: 'newfstatat', rawPath: '/ws/n', errno: 'ENOENT' },
    ])
    // The split shape carries the errno on a second line, matched by its
    // own pattern, so each spelling is asserted there too.
    for (const errno of ['ENOENT', 'EACCES', 'EPERM']) {
      const trace = `1 openat(AT_FDCWD, "/ws/x", 0 <unfinished ...>\n1 <... openat resumed>) = -1 ${errno} (x)`
      expect([errno, deniedCalls(trace)]).toEqual([
        errno,
        [{ syscall: 'openat', rawPath: '/ws/x', errno }],
      ])
    }
  })
})

describe('parseStraceViolations (the deny anchor and the dedup key)', () => {
  let dir = ''
  beforeEach(async () => {
    dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-strace-')))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const produce = async (trace: string) => {
    const ws = path.join(dir, 'ws')
    await mkdir(ws, { recursive: true })
    const log = path.join(dir, 'trace.log')
    await writeFile(log, trace)
    return await parseStraceViolations(
      log,
      { command: 'x', cwd: ws, env: {}, config: resolveSandboxConfig({}, ws) } as never,
      { allowRead: [], denyRead: [ws], cwd: ws },
    )
  }
  const targets = async (trace: string): Promise<string[]> =>
    (await produce(trace)).map((v) => v.target ?? '')
  const at = (pth: string): string => `1 openat(AT_FDCWD, "${pth}", 0) = -1 ENOENT (x)`

  it('anchors on the deny root itself and on a separator, not a bare prefix', async () => {
    const ws = path.join(dir, 'ws')
    // The root itself is inside the anchor; a SIBLING whose name merely
    // begins with it is not, and reporting it would cross the project
    // boundary this filter exists to hold.
    expect(await targets([at(ws), at(`${ws}other/x.ts`), at(`${ws}/a.ts`)].join('\n'))).toEqual([
      ws,
      `${ws}/a.ts`,
    ])
  })

  it('dedups per syscall AND path, so two calls on one path stay two lines', async () => {
    const ws = path.join(dir, 'ws')
    expect(
      await targets([at(`${ws}/x`), `1 access("${ws}/x", 4) = -1 ENOENT (x)`].join('\n')),
    ).toEqual([`${ws}/x`, `${ws}/x`])
  })

  // Item 652: the row above holds the KEY; nothing held the dedup itself —
  // a tool that probes one missing path ten times would report ten lines.
  it('reports one line for the same syscall on the same path, however often', async () => {
    const ws = path.join(dir, 'ws')
    expect(await targets([at(`${ws}/x`), at(`${ws}/x`), at(`${ws}/x`)].join('\n'))).toEqual([
      `${ws}/x`,
    ])
  })

  it('marks an openat ignorable by either list, since the trace lacks its flags', async () => {
    const ws = path.join(dir, 'ws')
    const produced = await produce(at(`${ws}/s.txt`))
    expect(produced.map((v) => v.ignorable)).toEqual([['read', 'write']])
    // The pair above is the claim; these two are what the claim is FOR.
    for (const which of ['read', 'write'] as const) {
      const cfg = resolveSandboxConfig({ ignore: { [which]: [`${ws}/s.txt`] } }, ws)
      expect([which, reportableViolations(produced, { within: ws, config: cfg })]).toEqual([
        which,
        [],
      ])
    }
  })

  // Item 652: every row above passes an EMPTY allowRead, so the skip for
  // an explicitly granted path (`isUnderAny`) could lose its exact-match
  // arm or its separator with the suite green. A grant covers itself and
  // its subtree, and not a sibling whose name merely begins with it.
  it('skips a granted path and its subtree, and reports a sibling sharing its name prefix', async () => {
    const ws = path.join(dir, 'ws')
    await mkdir(ws, { recursive: true })
    const log = path.join(dir, 'trace.log')
    await writeFile(log, [at(`${ws}/lib`), at(`${ws}/lib/x.ts`), at(`${ws}/libx/y.ts`)].join('\n'))
    const produced = await parseStraceViolations(
      log,
      { command: 'x', cwd: ws, env: {}, config: resolveSandboxConfig({}, ws) } as never,
      { allowRead: [`${ws}/lib`], denyRead: [ws], cwd: ws },
    )
    expect(produced.map((v) => v.target)).toEqual([`${ws}/libx/y.ts`])
  })

  // Item 652: the fixture root above is canonical, so the three `toRealPath`
  // calls in the strace pass could each go with the suite green. A traced
  // path is the one the process ASKED for, through whatever link it held;
  // the grants and the anchor may arrive through a link too. The comparison
  // is only right when every side is canonical.
  it('canonicalizes the traced path: one reached through a link is judged where it lands', async () => {
    const ws = path.join(dir, 'ws')
    await mkdir(path.join(ws, 'real'), { recursive: true })
    await symlink(path.join(ws, 'real'), path.join(ws, 'link'))
    await symlink(ws, path.join(dir, 'alias'))
    const log = path.join(dir, 'trace.log')
    await writeFile(log, [at(`${ws}/link/x`), at(`${dir}/alias/y`)].join('\n'))
    const produced = await parseStraceViolations(
      log,
      { command: 'x', cwd: ws, env: {}, config: resolveSandboxConfig({}, ws) } as never,
      { allowRead: [`${ws}/real`], denyRead: [ws], cwd: ws },
    )
    // `link/x` lands in the granted `real/`; `alias/y` lands in the project.
    expect(produced.map((v) => v.target)).toEqual([`${ws}/y`])
  })

  it('canonicalizes the grant and the anchor it is handed through a link', async () => {
    const ws = path.join(dir, 'ws')
    await mkdir(path.join(ws, 'real'), { recursive: true })
    await symlink(ws, path.join(dir, 'alias'))
    const log = path.join(dir, 'trace.log')
    await writeFile(log, [at(`${ws}/real/x`), at(`${ws}/z`)].join('\n'))
    const produced = await parseStraceViolations(
      log,
      { command: 'x', cwd: ws, env: {}, config: resolveSandboxConfig({}, ws) } as never,
      { allowRead: [`${dir}/alias/real`], denyRead: [`${dir}/alias`], cwd: ws },
    )
    expect(produced.map((v) => v.target)).toEqual([`${ws}/z`])
  })

  // The kernel never expands `~`: a traced `~cache/x` is `<cwd>/~cache/x`,
  // and reading it as `<home>/cache/x` dropped an undeclared read of a
  // project file under a directory named `~cache` (item 652).
  it('a traced relative path beginning with `~` resolves against the cwd', async () => {
    const ws = path.join(dir, 'ws')
    expect(await targets(at('~cache/x'))).toEqual([`${ws}/~cache/x`])
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

  it('keeps a denial under a withheld dependency (`linked`), in both line shapes', () => {
    // A cached task denied a sibling its key does not answer for reaches
    // it through its own `node_modules`: that denial is the finding, not
    // the wall. An unrelated sibling, and one merely sharing the withheld
    // directory's name as a prefix, are still the wall.
    const UI = path.join(ROOT, 'packages', 'ui')
    const cfg = resolveSandboxConfig({}, PROJ)
    const kept = reportableViolations(
      [
        mac('file-read-data', `${UI}/src/index.js`),
        linux(`${UI}/src/index.js`),
        mac('file-read-data', path.join(ROOT, 'packages', 'other', 'b.ts')),
        linux(path.join(ROOT, 'packages', 'ui-extra', 'c.ts')),
      ],
      { within: PROJ, linked: [UI], config: cfg },
    )
    expect(lines(kept)).toEqual([
      `bun(1) deny(1) file-read-data ${UI}/src/index.js`,
      `openat(x) = -1 ENOENT  [${UI}/src/index.js]`,
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

  it('keeps an outbound denial that names a host and port, under either grant', () => {
    // The addressless record is noise no config can silence. A connection
    // that tried to LEAVE the machine is reported by SRT's proxy WITH its
    // host and port, and that line must never be dropped — the end anchor
    // is the only thing separating the two.
    const noise = { line: 'bun(1) deny(1) network-outbound', timestamp: new Date() }
    const real = { line: 'bun(1) deny(1) network-outbound example.com:443', timestamp: new Date() }
    for (const cfg of [
      resolveSandboxConfig({ allow: { localBinding: true } }, PROJ),
      resolveSandboxConfig({ allow: { network: ['example.com'] } }, PROJ),
    ]) {
      expect(lines(reportableViolations([noise, real], { within: PROJ, config: cfg }))).toEqual([
        'bun(1) deny(1) network-outbound example.com:443',
      ])
    }
  })

  it('keeps a denial on the project root itself, and reports everything under `/`', () => {
    const cfg = resolveSandboxConfig({}, PROJ)
    expect(
      lines(reportableViolations([mac('file-read-data', PROJ)], { within: PROJ, config: cfg })),
    ).toEqual([`bun(1) deny(1) file-read-data ${PROJ}`])
    // `/` is the one prefix needing no separator appended; comparing
    // against `//` would drop every record there is.
    expect(
      lines(
        reportableViolations([mac('file-read-data', '/etc/passwd')], { within: '/', config: cfg }),
      ),
    ).toEqual(['bun(1) deny(1) file-read-data /etc/passwd'])
  })

  it('silences an `ignore` entry that is a literal path holding glob syntax', () => {
    // `a[1].txt` is a real filename; read as a GLOB its `[1]` is a
    // character class that does not match it. The exact compare is what
    // lets an `ignore` entry copied from a real tree work at all.
    const lit = `${PROJ}/a[1].txt`
    const v: SandboxViolation = {
      line: `openat(${lit}) = -1 ENOENT`,
      timestamp: new Date(),
      target: lit,
      path: lit,
      ignorable: ['read'],
    }
    expect(
      reportableViolations([v], {
        within: PROJ,
        config: resolveSandboxConfig({ ignore: { read: [lit] } }, PROJ),
      }),
    ).toEqual([])
    // CONTROL, on its own pattern: the glob branch still does the
    // globbing, so the exact compare above is an addition, not a swap.
    expect(
      reportableViolations([v], {
        within: PROJ,
        config: resolveSandboxConfig({ ignore: { read: [`${PROJ}/a*.txt`] } }, PROJ),
      }),
    ).toEqual([])
  })

  it("trims a seatbelt record's trailing whitespace out of the target it matches on", () => {
    // SRT's lines can carry trailing spaces; a greedy capture keeps them
    // in `target`, and then no `ignore` entry for the clean path matches.
    const kept = reportableViolations(
      [{ line: `bun(1) deny(1) file-read-data ${PROJ}/a.ts   `, timestamp: new Date() }],
      { within: PROJ, config: resolveSandboxConfig({}, PROJ) },
    )
    expect(kept.map((v) => v.target)).toEqual([`${PROJ}/a.ts`])
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

  // Item 652: `ignore` was driven for writes only, so the classifier could
  // lose its read, system-info, sysctl-read and network arms with the suite
  // green. Each operation is silenced by its own list — and by no other.
  const LISTS = ['read', 'write', 'systemInfo', 'network'] as const
  const OPS: Array<[string, string, (typeof LISTS)[number]]> = [
    ['file-read-data', `${PROJ}/r.ts`, 'read'],
    ['file-write-create', `${PROJ}/w.ts`, 'write'],
    ['system-info', 'vfs.a', 'systemInfo'],
    ['sysctl-read', 'kern.b', 'systemInfo'],
    ['network-outbound', 'example.com:443', 'network'],
  ]
  for (const [op, target, list] of OPS) {
    it(`a seatbelt ${op} record is silenced by ignore.${list} and by no other list`, () => {
      const kept = (lists: readonly string[]): number =>
        reportableViolations([mac(op, target)], {
          within: PROJ,
          config: resolveSandboxConfig(
            { ignore: Object.fromEntries(lists.map((l) => [l, [target]])) },
            PROJ,
          ),
        }).length
      expect(kept([list])).toBe(0)
      // CONTROL: every OTHER list naming the same target leaves it reported.
      expect(kept(LISTS.filter((l) => l !== list))).toBe(1)
    })
  }

  // Item 652: a record the classifier names no list for (a `mach-lookup`)
  // has a target and no `ignorable`; nothing drove one past an `ignore`
  // block, so the guard that stops the list walk could go — and the walk
  // then throws on `undefined`, failing the task's whole report.
  it('keeps a record no ignore list can name, with an ignore block present', () => {
    const v = mac('mach-lookup', 'com.apple.x')
    expect(
      lines(
        reportableViolations([v], {
          within: PROJ,
          config: resolveSandboxConfig({ ignore: { read: ['*'] } }, PROJ),
        }),
      ),
    ).toEqual(['bun(1) deny(1) mach-lookup com.apple.x'])
  })

  it('drops a sibling whose name merely begins with the project', () => {
    const cfg = resolveSandboxConfig({}, PROJ)
    expect(
      lines(
        reportableViolations(
          [mac('file-read-data', `${PROJ}other/x.ts`), mac('file-read-data', `${PROJ}/y.ts`)],
          { within: PROJ, config: cfg },
        ),
      ),
    ).toEqual([`bun(1) deny(1) file-read-data ${PROJ}/y.ts`])
  })

  // Item 652: ROOT above is canonical and never exists, so neither
  // `toRealPath` on the report's side had a witness: the `within` it is
  // handed, and the path a seatbelt record names (macOS records the path
  // the process used, which on macOS is `/tmp`, a link to `/private/tmp`).
  it('judges `within` and a seatbelt path each where it lands through a link', async () => {
    const d = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-report-link-')))
    try {
      await mkdir(path.join(d, 'proj'))
      await symlink(path.join(d, 'proj'), path.join(d, 'alias'))
      const cfg = resolveSandboxConfig({}, path.join(d, 'proj'))
      const via = (within: string, target: string): string[] =>
        lines(reportableViolations([mac('file-read-data', target)], { within, config: cfg }))
      expect(via(path.join(d, 'alias'), `${d}/proj/a.ts`)).toEqual([
        `bun(1) deny(1) file-read-data ${d}/proj/a.ts`,
      ])
      expect(via(path.join(d, 'proj'), `${d}/alias/b.ts`)).toEqual([
        `bun(1) deny(1) file-read-data ${d}/alias/b.ts`,
      ])
    } finally {
      await rm(d, { recursive: true, force: true })
    }
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
          baseDenyRead: [],
          reportWithin: dir,
          reportLinked: [],
          config: resolveSandboxConfig({ allow: { read: ['.'], write: ['.'] } }, dir),
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
          baseDenyRead: [],
          reportWithin: dir,
          reportLinked: [],
          config: resolveSandboxConfig({ allow: { write: ['.'] } }, dir),
        })
        expect([r.exitCode, r.stderr]).toEqual([0, ''])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

/**
 * Item 652: the probe's own gates, driven through the runtime's wrapper.
 * On a host where the secure sandbox works, a probe that ignored the
 * wrapper's exit, swallowed nothing, forgot the weaker mode or never
 * memoized answers exactly what the real one does — so the rows below
 * hand it a wrapper that fails, and count what it asked for.
 */
describe.skipIf(!available || process.platform !== 'linux')(
  'the probe, through its wrapper',
  () => {
    afterEach(async () => {
      await resetSandbox()
    })

    it('is memoized per mode, and the weaker mode asks for the weaker wrapper', async () => {
      await resetSandbox()
      const spy = spyOn(SandboxManager, 'wrapWithSandbox')
      try {
        const secure = await probeSandbox()
        const again = await probeSandbox()
        const weaker = await probeSandbox({ weakerNested: true })
        expect(again).toBe(secure)
        expect(weaker).not.toBe(secure)
        expect(spy.mock.calls.map((c) => c[2])).toEqual([
          undefined,
          { enableWeakerNestedSandbox: true },
        ])
      } finally {
        spy.mockRestore()
      }
    })

    it('a wrapper that exits non-zero, or throws, is an unavailable verdict', async () => {
      await resetSandbox()
      const spy = spyOn(SandboxManager, 'wrapWithSandbox').mockImplementation(
        async () => 'echo nope >&2; exit 3',
      )
      try {
        expect(await probeSandbox()).toEqual({
          available: false,
          reason: 'a sandboxed `true` failed (exit 3): nope',
        })
        await resetSandbox()
        spy.mockImplementation(async () => {
          throw new Error('boom')
        })
        expect(await probeSandbox()).toEqual({
          available: false,
          reason: 'sandbox probe threw: boom',
        })
      } finally {
        spy.mockRestore()
      }
    })
  },
)

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

    it("a SIBLING sharing the grant's name prefix is not under it", () => {
      // `under` tests `startsWith(readPath + path.sep)`. Without the
      // separator, a write grant on `<dir>-out` counts as being inside
      // `<dir>` and punches it apart — the read grant loses the directory
      // ENTRY, which is what makes a command that stats its own cwd die
      // (`bun build`, per the note above). The existing row above uses an
      // unrelated absolute path, which fails `startsWith` outright and so
      // never reaches this cut.
      const sibling = `${dir}-out`
      expect(punchWritePaths(dir, [sibling])).toEqual([dir])
      // CONTROL, on its own path: a write grant genuinely under the grant
      // still punches, so the row above is the SEPARATOR's doing and not a
      // punch that stopped working.
      expect(punchWritePaths(dir, [path.join(dir, 'dist')])).not.toEqual([dir])
    })

    it('passes a glob-shaped write grant to SRT as written', () => {
      // A file-shaped grant is widened to its directory because bwrap
      // cannot rename onto an active mount point. A GLOB is neither a file
      // nor a directory: `statSync` throws on it, so without the glob
      // check it falls through to `path.dirname` and the pattern the user
      // wrote is replaced by a plain directory.
      const write = (grants: string[]): string[] => {
        const c = buildCustomConfig(
          { config: { allowRead: [], allowWrite: grants, ignore: undefined } as never },
          { allowRead: [], denyRead: [] },
        ) as { filesystem?: { allowWrite?: string[] } }
        return c.filesystem?.allowWrite ?? []
      }
      expect(write([path.join(dir, 'dist', '**')])).toEqual([path.join(dir, 'dist', '**')])
      // CONTROLS on their own grants: a directory stays exact, and a FILE
      // is still widened to its directory — so the row above is the glob
      // branch and not a widening that stopped happening.
      expect(write([path.join(dir, 'dist')])).toEqual([path.join(dir, 'dist')])
      expect(write([path.join(dir, 'dist', 'out.bin')])).toEqual([path.join(dir, 'dist')])
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

    it('names the symlinked entries a punch would flatten, once per grant', async () => {
      // The one diagnostic for a failure with no other symptom. bwrap
      // resolves a bind SOURCE, so punching a directory mounts each
      // symlinked child as the directory it points AT — inside the
      // sandbox the link is gone, and a package resolved through it
      // loses the siblings its own dependencies need. That cost four
      // days of red CI (astro / `yargs-parser`, 2026-09-09) and SRT's
      // config carries no `--symlink`, so the warning IS the fix: it
      // says which grant to move. Silencing it breaks nothing else in
      // the repo, which is why this row exists.
      await symlink(path.join(dir, 'src'), path.join(dir, 'linked'))
      const written: string[] = []
      const real = process.stderr.write.bind(process.stderr)
      process.stderr.write = ((chunk: unknown): boolean => {
        written.push(String(chunk))
        return true
      }) as typeof process.stderr.write
      try {
        punchWritePaths(dir, [path.join(dir, 'dist')])
        // Once per grant: a second punch of the same read path is silent,
        // so a thousand-task run says it once.
        punchWritePaths(dir, [path.join(dir, 'dist')])
      } finally {
        process.stderr.write = real
      }
      const notices = written.filter((w) => w.includes('symlinked'))
      expect(notices).toHaveLength(1)
      // It has to name BOTH halves to be actionable: what got flattened
      // and which grant to move.
      expect(notices[0]).toContain('linked')
      expect(notices[0]).toContain('dist')
    })

    // Item 652: the row above has a symlink in every punch it makes, so the
    // notice could lose its `linked.length > 0` gate — and tell every
    // punched grant it flattened "0 symlinked entries" — with the suite
    // green.
    it('says nothing when the punched directory holds no symlink', async () => {
      const written: string[] = []
      const real = process.stderr.write.bind(process.stderr)
      process.stderr.write = ((chunk: unknown): boolean => {
        written.push(String(chunk))
        return true
      }) as typeof process.stderr.write
      try {
        punchWritePaths(dir, [path.join(dir, 'dist')])
        // CONTROL, on a directory of its own: one symlink there is named.
        await symlink(path.join(dir, 'src'), path.join(dir, 'nested', 'linked'))
        punchWritePaths(path.join(dir, 'nested'), [path.join(dir, 'nested', 'deep')])
      } finally {
        process.stderr.write = real
      }
      const notices = written.filter((w) => w.includes('symlinked'))
      expect(notices.map((n) => n.includes(`under ${path.join(dir, 'nested')} `))).toEqual([true])
    })

    // Item 652: two file-shaped grants in one directory both widen to it.
    // The rows above widen one file at a time, so the dedup after the
    // widening could go and SRT would be handed the directory twice.
    it('two file grants in one directory widen to that directory once', () => {
      const c = buildCustomConfig(
        {
          config: {
            allowRead: [],
            allowWrite: [path.join(dir, 'dist', 'a.bin'), path.join(dir, 'dist', 'b.bin')],
          } as never,
        },
        { allowRead: [], denyRead: [] },
      ) as { filesystem?: { allowWrite?: string[] } }
      expect(c.filesystem?.allowWrite).toEqual([path.join(dir, 'dist')])
    })

    it('hands over a path it cannot read rather than dropping the grant', () => {
      const missing = path.join(dir, 'does-not-exist')
      expect(punchWritePaths(missing, [path.join(missing, 'out')])).toEqual([missing])
    })
  },
)

/**
 * Item 652: every capability the resolved config carries reaches SRT's
 * per-task config as SRT's own field. No row read this object, so each of
 * the eleven hand-offs below could be deleted with the whole suite green:
 * the sandboxed rows that declare a capability either run where it cannot
 * be observed (no network in CI's sandbox, no macOS rules on Linux) or
 * declare one SRT reads off `initialize()` instead. Each row names the
 * field, the value vx was handed and the value SRT must receive — written
 * out, not derived from `buildCustomConfig`.
 */
describe('buildCustomConfig hands each capability to SRT', () => {
  const custom = (extra: Record<string, unknown>): Record<string, unknown> =>
    buildCustomConfig(
      { config: { allowRead: [], allowWrite: [], ...extra } as never },
      { allowRead: [], denyRead: [] },
    ) as Record<string, unknown>
  const at = (o: Record<string, unknown>, keys: string[]): unknown =>
    keys.reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], o)

  const ROWS: Array<[string, Record<string, unknown>, string[], unknown]> = [
    ['network: true is every domain', { network: true }, ['network', 'allowedDomains'], ['*']],
    [
      'a domain list is that list',
      { network: ['a.test', 'b.test'] },
      ['network', 'allowedDomains'],
      ['a.test', 'b.test'],
    ],
    ['no network is none', {}, ['network', 'allowedDomains'], []],
    ['deny.network', { denyNetwork: ['c.test'] }, ['network', 'deniedDomains'], ['c.test']],
    ['unixSockets: true', { unixSockets: true }, ['network', 'allowAllUnixSockets'], true],
    [
      'a unixSockets list',
      { unixSockets: ['/s.sock'] },
      ['network', 'allowUnixSockets'],
      ['/s.sock'],
    ],
    ['localBinding', { localBinding: true }, ['network', 'allowLocalBinding'], true],
    ['machLookup', { machLookup: ['com.x'] }, ['network', 'allowMachLookup'], ['com.x']],
    ['gitConfig', { gitConfig: true }, ['filesystem', 'allowGitConfig'], true],
    ['pty', { pty: true }, ['allowPty'], true],
    ['weakerWhenNested', { weakerWhenNested: true }, ['enableWeakerNestedSandbox'], true],
    [
      'weakerNetworkIsolation',
      { weakerNetworkIsolation: true },
      ['enableWeakerNetworkIsolation'],
      true,
    ],
  ]
  for (const [what, extra, keys, want] of ROWS) {
    it(`${what} → ${keys.join('.')}`, () => {
      expect(at(custom(extra), keys)).toEqual(want)
      // CONTROL: undeclared, the field is not invented (the domain lists
      // are always present, empty, because SRT insists on both).
      if (keys[0] !== 'network' || !keys[1]!.endsWith('Domains')) {
        expect(at(custom({}), keys)).toBeUndefined()
      }
    })
  }
})

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
  // Item 652: the bridge's socket lives in SRT's temp directory, resolved
  // exactly as SRT resolves it. No row set the variables, so an EMPTY
  // `CLAUDE_CODE_TMPDIR` (a socket at `/vx-port-…`, the filesystem root)
  // and the older `CLAUDE_TMPDIR` spelling were both unheld.
  it('the socket directory follows SRT: an empty variable is unset, and the older name counts', () => {
    const saved = [process.env['CLAUDE_CODE_TMPDIR'], process.env['CLAUDE_TMPDIR']]
    const set = (k: string, v: string | undefined): void => {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    try {
      set('CLAUDE_CODE_TMPDIR', '')
      set('CLAUDE_TMPDIR', undefined)
      expect(portBridgeSocket('t', 1)).toBe('/tmp/claude/vx-port-t-1.sock')
      set('CLAUDE_CODE_TMPDIR', undefined)
      set('CLAUDE_TMPDIR', '/legacy')
      expect(portBridgeSocket('t', 1)).toBe('/legacy/vx-port-t-1.sock')
      // CONTROL: the current name wins over the older one.
      set('CLAUDE_CODE_TMPDIR', '/current')
      expect(portBridgeSocket('t', 1)).toBe('/current/vx-port-t-1.sock')
    } finally {
      set('CLAUDE_CODE_TMPDIR', saved[0])
      set('CLAUDE_TMPDIR', saved[1])
    }
  })

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

/**
 * Item 652: SRT's lifecycle as vx drives it. Every row that starts the
 * sandbox runs one init against a clean directory and asserts only that
 * tasks work, so what `initSandbox` hands SRT, what a SECOND init leaves
 * alone, and what `resetSandbox` stops had no witness of their own.
 */
/**
 * Item 652: `runSandboxed`'s own plumbing, driven directly. Every other
 * row reaches it through `run()`, which forwards no arguments, captures
 * everything, never times a task out and tears the whole runtime down at
 * the end — so what THIS function owes its caller (the arguments, the tag,
 * the bridge release, the spawn failure, the process group, the live-child
 * set, the timeout, the capture flags) could each go with the suite green.
 */
describe.skipIf(!available || process.platform !== 'linux')('runSandboxed, driven directly', () => {
  let dir = ''
  beforeEach(async () => {
    dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-runsbx-')))
    await initSandbox()
  })
  afterEach(async () => {
    await resetSandbox()
    await rm(dir, { recursive: true, force: true })
  })
  const args = (command: string, extra: Record<string, unknown> = {}) => ({
    command,
    cwd: dir,
    env: process.env,
    baseAllowRead: [dir],
    baseDenyRead: [],
    reportWithin: dir,
    reportLinked: [],
    config: resolveSandboxConfig({}, dir),
    ...extra,
  })

  it('appends forwarded arguments, each shell-quoted', async () => {
    const r = await runSandboxed(args("printf '%s|'", { forwardArgs: ['a b', "c'd"] }))
    expect([r.exitCode, r.stdout]).toEqual([0, "a b|c'd|"])
  })

  it('tags each wrap uniquely and puts the tag first in the command', async () => {
    // SRT's macOS store keys a record by the command's first 100 bytes, so
    // two tasks running one command in one directory must still differ.
    const a = await wrapSandboxedCommand(args('echo hi'))
    const b = await wrapSandboxedCommand(args('echo hi'))
    expect(a.tag).not.toBe(b.tag)
    expect(a.taggedCommand).toBe(`: 'vx-${a.tag}'; echo hi`)
  })

  it('a spawn that throws is exit 127 with the reason, not a rejection', async () => {
    const r = await runSandboxed(args('true', { cwd: path.join(dir, 'gone') }))
    expect([r.exitCode, r.violations]).toEqual([127, []])
    expect(r.stderr).toContain('[vx] failed to spawn sandboxed task')
  })

  it('the child leads its own process group, and is a live child only while it runs', async () => {
    const live = new Set<ReturnType<typeof Bun.spawn>>()
    const seen: boolean[] = []
    const r = await runSandboxed(
      args('echo up; sleep 0.2', {
        liveChildren: live,
        onStdout: () => {
          for (const p of live) {
            try {
              process.kill(-p.pid, 0)
              seen.push(true)
            } catch {
              seen.push(false)
            }
          }
        },
      }),
    )
    expect([r.exitCode, seen, live.size]).toEqual([0, [true], 0])
  })

  it('a timeout ends the task and says so', async () => {
    const t0 = Date.now()
    const r = await runSandboxed(args('sleep 10', { timeoutMs: 300 }))
    expect(r.timedOut).toBe(true)
    expect(Date.now() - t0).toBeLessThan(5000)
    // The SIGTERM goes down the signal channel to the command's group
    // (item 752); the command dies of it and the runtime exits with its
    // status. Before, the tracer died of the SIGTERM itself.
    expect([r.exitCode, r.signal]).toEqual([143, undefined])
  })

  it("a timeout reaches the command's TERM trap, and a command that ignores it is killed at the grace (item 752)", async () => {
    // The timeout counts from the spawn, so it is also the window in which
    // bwrap, the tracer and `sh` start and the trap is set: at 300 ms a
    // loaded gate delivered TERM first (exit 143, no got.txt, 2026-09-25).
    const trapped = await runSandboxed(
      args(`trap 'echo trapped > got.txt; exit 0' TERM; echo up; while :; do sleep 0.05; done`, {
        config: resolveSandboxConfig({ allow: { write: ['.'] } }, dir),
        timeoutMs: 1000,
      }),
    )
    const got = existsSync(path.join(dir, 'got.txt'))
      ? readFileSync(path.join(dir, 'got.txt'), 'utf8').trim()
      : null
    expect([trapped.timedOut, trapped.exitCode, got]).toEqual([true, 0, 'trapped'])
    const deaf = await runSandboxed(
      args(`trap '' TERM; echo up; while :; do sleep 0.05; done`, { timeoutMs: 1000 }),
    )
    expect([deaf.timedOut, deaf.exitCode, deaf.signal]).toEqual([true, 137, 'SIGKILL'])
  })

  it("a command that signals its own group ends its own tree, not the runtime's shell (item 751)", async () => {
    // The line exits 0 unsandboxed; sharing bwrap's session group with
    // the runtime's shells, it ended them and the run read 143.
    const r = await runSandboxed(args(`sleep 10 & trap 'trap "" TERM; kill 0' EXIT; echo done`))
    expect([r.exitCode, r.stdout]).toEqual([0, 'done\n'])
  })

  it("CONTROL: in its own group the command's exit, a signal death included, is still its own", async () => {
    const exited = await runSandboxed(args('exit 3'))
    const killed = await runSandboxed(args('kill -9 $$'))
    expect([exited.exitCode, killed.exitCode]).toEqual([3, 137])
  })

  it('traces openat only, through the seccomp filter', async () => {
    // The flag is the difference between tracing one syscall and stopping
    // on every one: without it the cache perf baselines ran 2.5-7x over.
    const spy = spyOn(Bun, 'spawn')
    try {
      await runSandboxed(args('true'))
      // `strace --version` is the availability probe; the trace carries `-o`.
      // The tracer is spawned by its absolute path (util/which.ts).
      const argv = spy.mock.calls
        .map((c) => c[0] as unknown as string[])
        .find((c) => Array.isArray(c) && (c[0] ?? '').endsWith('/strace') && c.includes('-o'))
      expect(argv?.[0]).toBe(Bun.which('strace')!)
      expect(argv?.slice(1, 5)).toEqual(['-f', '--seccomp-bpf', '-e', 'trace=openat'])
    } finally {
      spy.mockRestore()
    }
  })

  it('removes its trace log, and reports the resources the task used', async () => {
    // The tmpdir is shared with every process on the box, so the row
    // follows this task's own log (the path its tracer was handed), not a
    // listing another suite's sandbox can change mid-run.
    const spy = spyOn(Bun, 'spawn')
    const during: boolean[] = []
    const logOf = (): string | undefined => {
      const argv = spy.mock.calls
        .map((c) => c[0] as unknown as string[])
        .find((c) => Array.isArray(c) && (c[0] ?? '').endsWith('/strace') && c.includes('-o'))
      return argv?.[argv.indexOf('-o') + 1]
    }
    try {
      const r = await runSandboxed(
        args('echo up; sleep 0.1', { onStdout: () => during.push(existsSync(logOf() ?? '')) }),
      )
      const log = logOf() ?? ''
      // Positive first: the log was there while the task ran.
      expect([path.basename(log).startsWith('vx-strace-'), during, existsSync(log)]).toEqual([
        true,
        [true],
        false,
      ])
      expect([typeof r.cpuMs, typeof r.peakRssBytes]).toEqual(['number', 'number'])
    } finally {
      spy.mockRestore()
    }
  })

  it('hands the runtime back its per-command cleanup', async () => {
    const spy = spyOn(SandboxManager, 'cleanupAfterCommand')
    try {
      await runSandboxed(args('true'))
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  // The note macOS needs (it logs nothing when the cwd is not granted) is
  // added on any platform when a task FAILED, reported nothing, and its
  // cwd lies outside every read grant. Each of the three is a row here.
  describe('the ungranted-cwd note', () => {
    const NOTE = "vx: this sandbox grants no read access to the task's own working directory"
    const notes = (r: { violations: SandboxViolation[] }): boolean[] =>
      r.violations.map((v) => v.line.startsWith(NOTE))

    it('is added to a failure with nothing to show, when no grant covers the cwd', async () => {
      await mkdir(path.join(dir, 'sub'))
      const r = await runSandboxed(args('exit 3', { baseAllowRead: [path.join(dir, 'sub')] }))
      expect([r.exitCode, notes(r)]).toEqual([3, [true]])
    })

    it('is added when the only grant is a sibling whose name prefixes the cwd', async () => {
      // `<dir>/proj` is a string prefix of `<dir>/proj-x` and covers none
      // of it; the separator is what keeps it from reading as the grant.
      await mkdir(path.join(dir, 'proj'))
      await mkdir(path.join(dir, 'proj-x'))
      const r = await runSandboxed(
        args('exit 3', { cwd: path.join(dir, 'proj-x'), baseAllowRead: [path.join(dir, 'proj')] }),
      )
      expect([r.exitCode === 0, notes(r)]).toEqual([false, [true]])
      // CONTROL: a grant that does cover the cwd adds no note.
      const granted = await runSandboxed(args('exit 3'))
      expect([granted.exitCode, notes(granted)]).toEqual([3, []])
    })

    it('is not added when the task already reported a denial', async () => {
      await mkdir(path.join(dir, 'sub'))
      const r = await runSandboxed(
        args(`cat ${dir}/secret.txt; exit 3`, {
          baseAllowRead: [path.join(dir, 'sub')],
          baseDenyRead: [dir],
        }),
      )
      expect([r.exitCode, notes(r)]).toEqual([3, [false]])
    })
  })

  // Whether to trace is decided once per runtime, from `strace --version`.
  // CI's strace answers 0 and a modern version, so a detector that ignored
  // the exit, never memoized, or let a missing binary through unrecorded
  // answered the same there. These rows put a different strace on PATH —
  // in a process of its own, since the verdict is memoized per process.
  // `which strace` is the PATH lookup (util/which.ts), `strace --version`
  // the probe.
  describe('strace detection', () => {
    const detecting = (pathDirs: string): unknown => {
      const src = path.resolve(import.meta.dir, '..', 'src', 'exec', 'sandbox-runtime.ts')
      const script = [
        `import { initSandbox, resetSandbox, runSandboxed, resolveSandboxConfig } from ${JSON.stringify(src)}`,
        `const calls = []`,
        `const spawn = Bun.spawn`,
        `const which = Bun.which`,
        `Bun.which = (name, ...rest) => { if (name === 'strace') calls.push('which strace'); return which(name, ...rest) }`,
        `Bun.spawn = (cmd, ...rest) => { if (Array.isArray(cmd) && cmd[0].endsWith('/strace')) calls.push(cmd.includes('-o') ? 'trace' : ['strace', ...cmd.slice(1)].join(' ')); return spawn(cmd, ...rest) }`,
        `await initSandbox()`,
        `const dir = ${JSON.stringify(dir)}`,
        `const outs = []`,
        `for (let i = 0; i < 2; i++) outs.push((await runSandboxed({ command: 'echo ok', cwd: dir, env: process.env, baseAllowRead: [dir], baseDenyRead: [], reportWithin: dir, reportLinked: [], config: resolveSandboxConfig({}, dir) })).stdout)`,
        `console.log(JSON.stringify({ outs, calls }))`,
        `await resetSandbox()`,
      ].join('\n')
      const p = Bun.spawnSync({
        cmd: [process.execPath, '-e', script],
        env: { ...process.env, PATH: pathDirs },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const out = p.stdout.toString().trim()
      return out === ''
        ? { exit: p.exitCode, stderr: p.stderr.toString().slice(0, 400) }
        : JSON.parse(out)
    }

    it('a strace whose --version fails is not used, and is asked once', async () => {
      const bin = path.join(dir, 'bin')
      await mkdir(bin)
      // Fails `--version`; as a tracer it would just run the command.
      await writeFile(
        path.join(bin, 'strace'),
        '#!/bin/sh\n[ "$1" = --version ] && exit 1\nwhile [ "$1" != -- ]; do shift; done; shift; exec "$@"\n',
        { mode: 0o755 },
      )
      expect(detecting(`${bin}:${process.env['PATH']}`)).toEqual({
        outs: ['ok\n', 'ok\n'],
        calls: ['which strace', 'strace --version'],
      })
    })

    it('no strace on PATH is no tracing, and is found out once', async () => {
      // Every binary the runtime needs, and no strace.
      const bin = path.join(dir, 'bin')
      await mkdir(bin)
      for (const name of ['sh', 'bash', 'bwrap', 'socat', 'rg']) {
        const found = Bun.which(name)
        if (found !== null) await symlink(found, path.join(bin, name))
      }
      // The lookup's miss is the verdict: nothing is spawned to learn it.
      expect(detecting(bin)).toEqual({ outs: ['ok\n', 'ok\n'], calls: ['which strace'] })
    })
  })

  it('a trace that cannot be parsed costs the report, never the task', async () => {
    const spy = spyOn(violations, 'parseStraceViolations').mockRejectedValue(new Error('garbled'))
    try {
      const r = await runSandboxed(args('echo ok'))
      expect([r.exitCode, r.stdout, r.violations]).toEqual([0, 'ok\n', []])
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('a stream the caller did not ask to capture is streamed but not retained', async () => {
    const out: string[] = []
    const err: string[] = []
    const r = await runSandboxed(
      args('echo o; echo e >&2', {
        capture: { stdout: false, stderr: false },
        onStdout: (c: string) => out.push(c),
        onStderr: (c: string) => err.push(c),
      }),
    )
    expect([r.stdout, r.stderr, out.join(''), err.join('')]).toEqual(['', '', 'o\n', 'e\n'])
  })

  it("releases the task's host-side port bridge when the task ends", async () => {
    const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    const port = l.port
    l.stop(true)
    const listening = async (): Promise<boolean> =>
      Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {} } }).then(
        (s) => (s.end(), true),
        () => false,
      )
    const running = runSandboxed(
      args('sleep 1', {
        config: resolveSandboxConfig({ allow: { localBinding: [port] } }, dir),
      }),
    )
    // Positive first: the host side comes up while the task runs.
    let up = false
    for (let i = 0; i < 40 && !up; i++) {
      up = await listening()
      if (!up) await Bun.sleep(20)
    }
    expect(up).toBe(true)
    await running
    let down = false
    for (let i = 0; i < 100 && !down; i++) {
      down = !(await listening())
      if (!down) await Bun.sleep(20)
    }
    expect(down).toBe(true)
  })

  // Measured for item 652, and it holds the NAMESPACE, not the drain: with
  // `drainOrAbort` (or the timeout's abort) deleted this row stays green,
  // because bwrap's PID namespace kills a backgrounded grandchild the
  // moment the task's shell exits, and the pipe closes with it. On Linux
  // the post-exit drain bound is therefore unreachable in a sandbox; it is
  // the guard on a platform without a PID namespace.
  it('returns promptly when a backgrounded grandchild holds the pipe open', async () => {
    const t0 = Date.now()
    const r = await runSandboxed(args('sleep 10 & echo up'))
    expect([r.exitCode, r.stdout]).toEqual([0, 'up\n'])
    expect(Date.now() - t0).toBeLessThan(3000)
  }, 15_000)
})

describe.skipIf(!available || process.platform !== 'linux')('the runtime lifecycle', () => {
  afterEach(async () => {
    await resetSandbox()
  })

  it("hands SRT the run's domain union and vx's default ignore list", async () => {
    await resetSandbox()
    const spy = spyOn(SandboxManager, 'updateConfig')
    try {
      await initSandbox({ allowedDomains: ['a.test'] })
      const cfg = spy.mock.calls.at(-1)?.[0] as {
        network?: { allowedDomains?: string[] }
        ignoreViolations?: unknown
      }
      expect(cfg.network?.allowedDomains).toEqual(['a.test'])
      expect(cfg.ignoreViolations).toEqual({ '*': ['kern.iossupportversion'] })
    } finally {
      spy.mockRestore()
    }
  })

  it('a second init leaves the running sockets alone', async () => {
    // The stale-socket sweep is for a DEAD process's files. Once SRT is up
    // under this pid, the files are its own live listeners. A process of
    // its own: SRT's socket sequence keeps counting across resets, so only
    // a fresh process's first listener sits at the seq the sweep starts on.
    const script = [
      `import { initSandbox, resetSandbox } from ${JSON.stringify(path.resolve(import.meta.dir, '..', 'src', 'exec', 'sandbox-runtime.ts'))}`,
      `import { existsSync } from 'node:fs'`,
      `import path from 'node:path'`,
      `import os from 'node:os'`,
      `const live = path.join(os.tmpdir(), 'srt-mux-' + process.pid + '-0.sock')`,
      `await initSandbox()`,
      `const first = existsSync(live)`,
      `await initSandbox()`,
      `console.log(JSON.stringify([first, existsSync(live)]))`,
      `await resetSandbox()`,
    ].join('\n')
    const p = Bun.spawnSync({
      cmd: [process.execPath, '-e', script],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect([p.exitCode, p.stdout.toString().trim()]).toEqual([0, '[true,true]'])
  })

  it('a stale path it cannot unlink is an error, not a silent pass', async () => {
    // A DIRECTORY at the socket path: `unlink` answers EISDIR, which is
    // not "nothing there", and SRT's listen would fail on it anyway.
    const stale = path.join(os.tmpdir(), `srt-mux-${process.pid}-0.sock`)
    await resetSandbox()
    await mkdir(stale)
    try {
      const err = await initSandbox().then(
        () => undefined,
        (e: unknown) => e,
      )
      expect((err as NodeJS.ErrnoException | undefined)?.code).toBe('EISDIR')
    } finally {
      await rm(stale, { recursive: true, force: true })
    }
  })

  it("reset stops a task's host-side port bridge", async () => {
    const dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-bridge-reset-')))
    const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    const port = l.port
    l.stop(true)
    const listening = async (): Promise<boolean> =>
      Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {} } }).then(
        (s) => (s.end(), true),
        () => false,
      )
    try {
      await initSandbox()
      await wrapSandboxedCommand({
        command: 'true',
        cwd: dir,
        config: resolveSandboxConfig({ allow: { localBinding: [port] } }, dir),
        baseAllowRead: [],
        baseDenyRead: [],
      })
      // The host's socat binds asynchronously: wait for it, bounded.
      let up = false
      for (let i = 0; i < 100 && !up; i++) {
        up = await listening()
        if (!up) await Bun.sleep(20)
      }
      expect(up).toBe(true)
      await resetSandbox()
      let down = false
      for (let i = 0; i < 100 && !down; i++) {
        down = !(await listening())
        if (!down) await Bun.sleep(20)
      }
      expect(down).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

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

describe.skipIf(!available || process.platform !== 'linux')(
  'a brace in a write grant is a LITERAL to the sandbox, and the grant works',
  () => {
    // `MOUNT_WILDCARDS` (sandbox-paths.ts) leaves `{}` out on purpose, and
    // this row is the measurement its docblock cites: `write: ['g/{a,b}.txt']`
    // gets a placeholder file and is widened to `g/` like any file-shaped
    // grant, so the task writes `g/a.txt`. Counted as a wildcard instead,
    // the grant goes to the scan, matches nothing before the task has
    // written, and the write fails with `Read-only file system` (flip the
    // constant to `[*?[\]{}]` and this row reddens; item 577).
    let fixture: Fixture

    beforeEach(async () => {
      fixture = await makeWorkspace()
    })
    afterEach(async () => {
      await rm(fixture.root, { recursive: true, force: true })
    })

    it(
      'write: [g/{a,b}.txt] lets the task write g/a.txt',
      async () => {
        const dir = await addProject(fixture.root, 'app', {
          files: { 'src/x.txt': 'declared' },
          config: `
            export default {
              tasks: {
                build: {
                  exec: {
                    command: 'echo OUT > g/a.txt',
                    sandbox: { allow: { read: ['src/**'], write: ['g/{a,b}.txt'] } },
                  },
                  cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
                },
              },
            }
          `,
        })
        const r = await run({ cwd: fixture.root, tasks: ['build'], log: collectingLogger(fixture) })
        expectOk(r, fixture)
        expect(await readFile(path.join(dir, 'g', 'a.txt'), 'utf8')).toBe('OUT\n')
        expect(fixture.log.join('\n')).not.toContain('Read-only file system')
      },
      TIMEOUT,
    )
  },
)

// A cancellation reaches a sandboxed command as the signal vx got, and its
// trap runs (item 752). vx's group signal used to land on bwrap's monitor,
// which died of it; `--die-with-parent` then SIGKILLed the namespace, so no
// trap ran and `got.txt` stayed empty. The polite signal now goes down the
// task's fd 3 to a watcher in the sandbox. Each title a literal, as in
// signal-handling.test.ts, whose unsandboxed rows these mirror.
describe.skipIf(!available || process.platform !== 'linux')(
  'a signal to vx reaches a sandboxed task',
  () => {
    const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
    const TRAPS =
      "trap 'echo SIGINT > got.txt; exit 0' INT; trap 'echo SIGTERM > got.txt; exit 0' TERM"
    let root = ''
    beforeEach(async () => {
      root = await makeWorkspaceRoot({ prefix: 'vx-sbx-sig-' })
    })
    afterEach(async () => {
      await rm(root, { recursive: true, force: true })
    })

    const reaches =
      (signal: 'SIGINT' | 'SIGTERM', code: number, persistent: boolean) => async () => {
        const dir = await addProject(
          root,
          'app',
          `
            export default {
              tasks: {
                t: {
                  exec: {
                    command: "${TRAPS}; echo up > ready.txt; echo READY; while :; do sleep 0.05; done",
                    sandbox: { allow: { read: ['.'], write: ['got.txt', 'ready.txt'] } },
                    ${persistent ? "persistent: { readyWhen: 'READY' }," : ''}
                  },
                },
              },
            }
          `,
        )
        const proc = Bun.spawn([process.execPath, BIN, 'run', 't', '--all'], {
          cwd: root,
          stdout: 'pipe',
          stderr: 'pipe',
        })
        // The write grant pre-creates the file empty: "started" is its text.
        const ready = path.join(dir, 'ready.txt')
        const deadline = Date.now() + 20_000
        while (Date.now() < deadline) {
          if (existsSync(ready) && readFileSync(ready, 'utf8').trim() === 'up') break
          await Bun.sleep(20)
        }
        proc.kill(signal)
        expect(await proc.exited).toBe(code)
        expect(readFileSync(path.join(dir, 'got.txt'), 'utf8').trim()).toBe(signal)
      }

    it(
      'SIGINT to vx reaches a sandboxed one-shot task as SIGINT',
      reaches('SIGINT', 130, false),
      TIMEOUT,
    )
    it(
      'SIGINT to vx reaches a ready sandboxed persistent task as SIGINT',
      reaches('SIGINT', 130, true),
      TIMEOUT,
    )
    it(
      'SIGTERM to vx reaches a sandboxed one-shot task as SIGTERM',
      reaches('SIGTERM', 143, false),
      TIMEOUT,
    )
    it(
      'SIGTERM to vx reaches a ready sandboxed persistent task as SIGTERM',
      reaches('SIGTERM', 143, true),
      TIMEOUT,
    )

    // A signal exit is `process.exit`, which never reaches the task's own
    // unlink: one strace log per sandboxed task stayed in the temp dir
    // (item 848). Since item 849 a first signal lets the run end and read
    // the log, so only the second signal's immediate exit leaves it to the
    // exit hook. The second goes once the task has heard the first; a task
    // that died on the first ended the run the normal way, and the row
    // held nothing (item 863). A short TMPDIR, directly under the temp
    // dir: the runtime's socket lives there too, and `sun_path` is 108
    // bytes.
    it(
      'a second signal exit leaves no strace log behind',
      async () => {
        const dir = await addProject(
          root,
          'app',
          `export default { tasks: { t: { exec: {
            command: "trap 'echo int > int.txt' INT; echo up > ready.txt; while :; do sleep 0.05; done",
            sandbox: { allow: { read: ['.'], write: ['ready.txt', 'int.txt'] } },
          } } } }`,
        )
        const tmp = await mkdtemp(path.join(os.tmpdir(), 'vx-st-'))
        try {
          const proc = Bun.spawn([process.execPath, BIN, 'run', 't', '--all'], {
            cwd: root,
            stdout: 'pipe',
            stderr: 'pipe',
            env: { ...process.env, TMPDIR: tmp },
          })
          const ready = path.join(dir, 'ready.txt')
          const deadline = Date.now() + 20_000
          while (Date.now() < deadline) {
            if (existsSync(ready) && readFileSync(ready, 'utf8').trim() === 'up') break
            await Bun.sleep(20)
          }
          const logs = (): string[] => readdirSync(tmp).filter((n) => n.startsWith('vx-strace-'))
          // The positive first: the running task has its log here.
          expect(logs().length).toBe(1)
          proc.kill('SIGINT')
          const heard = path.join(dir, 'int.txt')
          const until = Date.now() + 10_000
          while (!existsSync(heard) && Date.now() < until) await Bun.sleep(20)
          expect(existsSync(heard)).toBe(true)
          proc.kill('SIGINT')
          expect(await proc.exited).toBe(130)
          expect(logs()).toEqual([])
        } finally {
          await rm(tmp, { recursive: true, force: true })
        }
      },
      TIMEOUT,
    )
  },
)

// A `kill -9` of vx runs no teardown (kill-tree.md). A sandboxed task's
// bwrap is vx's own child — the shell `exec`s it — so its
// `--die-with-parent` fires with vx, and the pid namespace takes every
// descendant down, one that left the task's group with `setsid` included
// (turborepo#9666). Behind a waiting shell, bwrap's parent was the shell,
// which outlived vx, and the server's tree ran on under init. The
// unsandboxed control is the limit that remains: the group guard
// (kill-tree.ts) takes the task's group, so the backgrounded child dies
// and the one that left the group with `setsid` survives.
describe.skipIf(!available || process.platform !== 'linux')(
  'a SIGKILLed vx takes a sandboxed task’s whole tree with it',
  () => {
    const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
    let root = ''
    beforeEach(async () => {
      root = await makeWorkspaceRoot({ prefix: 'vx-sbx-kill9-' })
    })
    afterEach(async () => {
      await rm(root, { recursive: true, force: true })
    })

    /** Host pids whose command line is exactly `sleep <arg>`: a pid namespace hides the task's own `$!`. */
    const sleepers = (arg: string): number[] =>
      readdirSync('/proc')
        .filter((d) => /^\d+$/.test(d))
        .filter((d) => {
          try {
            return readFileSync(`/proc/${d}/cmdline`, 'utf8') === `sleep\0${arg}\0`
          } catch {
            return false
          }
        })
        .map(Number)

    const survivors = async (
      sandboxed: boolean,
      persistent = true,
    ): Promise<{ started: number; alive: number[]; leaders: number[] }> => {
      const nonce = `${1000 + Math.floor(Math.random() * 1000)}.${process.pid}`
      await addProject(
        root,
        'app',
        `
          export default {
            tasks: {
              dev: {
                exec: {
                  command: 'sleep ${nonce} & setsid sleep ${nonce} & echo READY; wait',
                  ${persistent ? "persistent: { readyWhen: 'READY' }," : ''}
                  ${sandboxed ? 'sandbox: {},' : ''}
                },
              },
            },
          }
        `,
      )
      const proc = Bun.spawn([process.execPath, BIN, 'run', 'dev', '--all'], {
        cwd: root,
        stdout: 'ignore',
        stderr: 'ignore',
      })
      let pids: number[] = []
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        pids = sleepers(nonce)
        if (pids.length === 2) break
        await Bun.sleep(20)
      }
      process.kill(proc.pid, 'SIGKILL')
      expect(await proc.exited).toBe(137)
      await Promise.all(pids.map((p) => waitForDead(p, 2_000)))
      const alive = pids.filter(isAlive)
      // A session leader's session id is its own pid: the `setsid` child.
      const leaders = alive.filter(
        (p) => Number(readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1]!.split(' ')[3]) === p,
      )
      for (const p of alive) process.kill(p, 'SIGKILL')
      return { started: pids.length, alive, leaders }
    }

    it(
      'a sandboxed server’s backgrounded and setsid children die with vx',
      async () => {
        expect(await survivors(true)).toEqual({ started: 2, alive: [], leaders: [] })
      },
      TIMEOUT,
    )

    // A one-shot sandboxed task is traced: strace, not bwrap, is the
    // spawn and bwrap's parent, and strace outlived vx with the whole
    // tree under it. The group guard's SIGKILL takes strace, and bwrap's
    // `--die-with-parent` the rest (item 860).
    it(
      'a traced sandboxed one-shot task’s children die with vx',
      async () => {
        expect(await survivors(true, false)).toEqual({ started: 2, alive: [], leaders: [] })
      },
      TIMEOUT,
    )

    it(
      'CONTROL: unsandboxed, the backgrounded child dies with vx and the setsid one lives',
      async () => {
        const { started, alive, leaders } = await survivors(false)
        expect(started).toBe(2)
        expect(alive).toHaveLength(1)
        expect(leaders).toEqual(alive)
      },
      TIMEOUT,
    )
  },
)
