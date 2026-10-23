// Sandbox-runtime integration tests: tasks run through the orchestrator.
//
// These tests are gated on SRT's runtime deps (bwrap on Linux,
// sandbox-exec on macOS). CI installs bubblewrap + socat + strace,
// disables AppArmor's unprivileged-userns restriction, and sets
// VX_REQUIRE_SANDBOX — so an unavailable runtime FAILS there rather than
// skipping, because a skipped suite reports green and this one covers
// the isolation boundary. A local host without the deps still skips.

import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace as makeWorkspaceRoot } from './helpers/workspace.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { type RunOptions } from '../src/orchestrator/index.js'
import { run } from './helpers/orchestrator.js'
import {
  TIMEOUT,
  type Fixture,
  expectOk,
  collectingLogger,
  makeWorkspace,
} from './helpers/sandbox-fixture.js'

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
            timeout: '15s',
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

  // A sandboxed command ran under bash and an unsandboxed one under sh, so
  // brace expansion, `[[ … ]]` and `echo 'a\tb'` read differently with the
  // block and without it (dash is /bin/sh on Linux runners; item 964). The
  // claim is the same answer both ways, which holds where sh is bash too.
  it(
    'a sandboxed task runs under the shell an unsandboxed one does',
    async () => {
      const probe = `echo x{1,2}; [ -n "$BASH_VERSION" ] && echo is-bash || echo not-bash`
      const outOf = async (sandbox: boolean): Promise<string> => {
        const dir = await makeWorkspaceRoot({ prefix: 'vx-shell-' })
        try {
          await addProject(dir, 'app', {
            files: {},
            config: `export default { tasks: { t: { exec: {
              command: ${JSON.stringify(probe)},
              ${sandbox ? "sandbox: { allow: { read: ['**/*'] } }," : ''}
            } } } }`,
          })
          const lines: string[] = []
          const r = await run({
            cwd: dir,
            tasks: ['t'],
            log: {
              status() {},
              taskStdout(_n: unknown, chunk: string) {
                lines.push(chunk)
              },
              taskStderr() {},
              taskComplete() {},
            } as never,
          })
          expect(r.outcomes[0]?.status).toBe('success')
          return lines.join('').trim()
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
      }
      const plain = await outOf(false)
      expect(await outOf(true)).toBe(plain)
    },
    TIMEOUT,
  )

  // Bun's `'pipe'` is a socketpair, which Linux will not open through
  // `/proc/self/fd/1`: a task's `echo x > /dev/stdout` failed "No such
  // device or address", sandboxed or not (X-113). The plain run is the
  // same claim through the orchestrator.
  for (const sandbox of [true, false]) {
    it(
      `a ${sandbox ? 'sandboxed' : 'plain'} task and server open /dev/stdout and /dev/stderr by path`,
      async () => {
        const sb = sandbox ? "sandbox: { allow: { read: ['**/*'] } }," : ''
        await addProject(fixture.root, 'app', {
          files: {},
          config: `export default { tasks: {
            t: { exec: { command: 'echo x > /dev/stdout && echo y | tee /dev/stderr', ${sb} } },
            dev: { exec: {
              command: 'echo Listening > /dev/stdout && exec sleep 30',
              persistent: { readyWhen: 'Listening' },
              timeout: '15s',
              ${sb}
            } },
          } }`,
        })
        const out: Record<string, string> = {}
        const err: Record<string, string> = {}
        const r = await run({
          cwd: fixture.root,
          tasks: ['t', 'dev'],
          log: {
            status() {},
            taskStdout(n: { taskName: string }, chunk: string) {
              out[n.taskName] = (out[n.taskName] ?? '') + chunk
            },
            taskStderr(n: { taskName: string }, chunk: string) {
              err[n.taskName] = (err[n.taskName] ?? '') + chunk
            },
            taskComplete() {},
          } as never,
        })
        expect(r.outcomes.map((o) => `${o.node.taskName} ${o.status}`).sort()).toEqual([
          'dev success',
          't success',
        ])
        expect(out).toEqual({ dev: 'Listening\n', t: 'x\ny\n' })
        expect(err).toEqual({ t: 'y\n' })
      },
      TIMEOUT,
    )
  }

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
            timeout: '5s',
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

  // `.vx` is walled wherever it sits, but a `cacheDir` inside a project
  // was not: a task granted `.vxcache/` wrote into the store it could then
  // poison (L-24). The run's own cache dir reaches the request.
  it(
    "a cache directory inside the task's project is not writable to it",
    async () => {
      const projDir = await addProject(fixture.root, 'app', {
        files: {},
        config: `export default { tasks: { build: { exec: {
          command: 'mkdir -p .vxcache && echo x > .vxcache/planted',
          sandbox: { allow: { read: ['.'], write: ['.vxcache/'] } },
        } } } }\n`,
      })
      const r = await run({
        cwd: fixture.root,
        tasks: ['build'],
        cacheDir: path.join(projDir, '.vxcache'),
        log: collectingLogger(fixture),
      })
      expect(r.outcomes[0]?.status).toBe('failed')
      // The message names the real path: macOS's temp dir is `/var`, a link.
      expect(fixture.log.join('\n')).toContain(
        `the grant binding ${realpathSync(path.join(projDir, '.vxcache'))} would make`,
      )
      expect(existsSync(path.join(projDir, '.vxcache', 'cache.db'))).toBe(true)
      expect(existsSync(path.join(projDir, '.vxcache', 'planted'))).toBe(false)
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
      await Bun.write(
        path.join(fixture.root, '.vx/workspace.mjs'),
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
          inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
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
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
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
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
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
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
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

  // The landing and README said a sandboxed task "fails on any read it did
  // not declare" (J-102): a sibling's file is out of reach but the wall is
  // silent, and a read outside the workspace is open.
  it(
    'a tolerated sibling read passes having read nothing, and a read outside the workspace passes',
    async () => {
      await addProject(fixture.root, 'secret', {
        files: { 'token.txt': 'shh' },
        config: `export default { tasks: {} }`,
      })
      const dir = await addProject(fixture.root, 'reader', {
        files: { 'src/x.txt': 'hi' },
        config: `
          export default {
            tasks: {
              peek: {
                exec: {
                  command: '{ cat ../secret/token.txt || echo none; head -c 1 /etc/passwd >/dev/null && echo host; } > out.txt',
                  sandbox: { allow: { write: ['out.txt'] } },
                },
              },
            },
          }
        `,
      })
      const r = await run({ cwd: fixture.root, tasks: ['peek'], log: collectingLogger(fixture) })
      expect([r.outcomes[0]?.status, r.outcomes[0]?.sandboxViolationLines ?? []]).toEqual([
        'success',
        [],
      ])
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).toBe('none\nhost\n')
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
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
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
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
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
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
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
                  inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
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
                    command: 'cat < ../secret/token.txt > out.txt',
                    sandbox: { allow: { read: ['.'], write: ['out.txt'] } },
                  },
                  inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
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
        // absent file is what proves it did not. On Linux the failed
        // task's hint names it (`hiddenReadsOutside`), never counted;
        // macOS logs a seatbelt record late or not at all, so there only
        // the count is held.
        expect(existsSync(path.join(link, 'packages', 'app', 'out.txt'))).toBe(false)
        expect(r.outcomes[0]?.sandboxViolations ?? 0).toBe(0)
        if (process.platform !== 'linux') return
        const root = realpathSync(fixture.root)
        expect([r.outcomes[0]?.sandboxViolations, r.outcomes[0]?.sandboxViolationLines]).toEqual([
          0,
          [
            `vx: the sandbox hid paths outside the project that exist on this machine, which are ` +
              `not reported as violations: ${root}/packages/secret/token.txt. If the task reads ` +
              "one, grant it, e.g. `allow: { read: ['../secret/token.txt'] }`.",
          ],
        ])
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
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
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
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['src/x.txt'] } },
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
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['src/x.txt'] } },
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
    'a `dir/` write grant outside the project is created before the task starts',
    async () => {
      // bwrap cannot bind a directory that does not exist, and a `dir/`
      // grant outside the project was skipped by the pre-create (only a glob
      // was made): `~/.bun/install/cache/` on a fresh machine granted
      // nothing, and `bun build --compile` failed to put its cross-compile
      // runtime there (2026-09-29).
      const outside = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-cold-')))
      try {
        const dir = path.join(outside, 'cold', 'cache')
        await addProject(fixture.root, 'coldgrant', {
          files: { 'src/x.txt': 'hi' },
          config: `
            export default {
              tasks: {
                build: {
                  exec: {
                    command: 'echo ok > ${dir}/x',
                    sandbox: { allow: { read: ['.'], write: ['${dir}/'] } },
                  },
                },
              },
            }
          `,
        })
        const r = await run({ cwd: fixture.root, tasks: ['build'], log: collectingLogger(fixture) })
        expectOk(r, fixture)
        expect(readFileSync(path.join(dir, 'x'), 'utf8')).toBe('ok\n')
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'a write glob for a temp directory the task creates, fills and removes covers it',
    async () => {
      // `bun build --compile` extracts a cross-compile runtime into
      // `<cwd>/.<hash>-00000000.tmp/`, moves it out and removes the
      // directory (strace, Bun 1.4.2). No bind can name a directory before
      // it exists: on Linux the write lands in the sandbox's scratch and the
      // grant must still count it, and on macOS the glob must cover what is
      // inside the directory, not only the directory (2026-09-29).
      // `vfs.disk-space`: macOS 27's `cp` and bash ask it, and an ungranted
      // ask is a violation that fails the task.
      const projDir = await addProject(fixture.root, 'tempdir', {
        files: { 'src/x.txt': 'hi' },
        config: `
          export default {
            tasks: {
              build: {
                exec: {
                  command: 'mkdir .a1.tmp && cp src/x.txt .a1.tmp/f && mv .a1.tmp/f dist/f && rmdir .a1.tmp',
                  sandbox: { allow: { read: ['.'], write: ['dist/', '.*.tmp/**'], systemInfo: ['vfs.disk-space'] } },
                },
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
      })
      const r = await run({ cwd: fixture.root, tasks: ['build'], log: collectingLogger(fixture) })
      expectOk(r, fixture)
      expect(readFileSync(path.join(projDir, 'dist', 'f'), 'utf8')).toBe('hi')
      expect(readdirSync(projDir).filter((e) => e.endsWith('.tmp'))).toEqual([])
    },
    TIMEOUT,
  )

  // Linux: macOS logs a denial asynchronously and vx reads the store once,
  // with no settle window, so the record may not have arrived (the macOS
  // job ran this red once, the write refused and no record). The seatbelt
  // line shape is held by the pure row in `reportableViolations`.
  it.skipIf(process.platform !== 'linux')(
    'a failed task is told which writes outside the project were refused',
    async () => {
      // A write past the wall is not a violation, and the report showed
      // nothing: `bun build --compile` said "Failed to extract executable"
      // with no word of the cache it could not write (2026-09-29).
      const outside = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-refused-')))
      try {
        const target = path.join(outside, 'f')
        await addProject(fixture.root, 'outsidewriter', {
          files: { 'src/x.txt': 'hi' },
          config: `
            export default {
              tasks: {
                build: {
                  exec: {
                    command: 'echo x > ${target}',
                    sandbox: { allow: { read: ['.'] } },
                  },
                },
              },
            }
          `,
        })
        const r = await run({ cwd: fixture.root, tasks: ['build'], log: collectingLogger(fixture) })
        expect(r.ok).toBe(false)
        const outcome = r.outcomes.find((o) => o.node.id === 'outsidewriter#build')
        const hints = (outcome?.sandboxViolationLines ?? []).filter((l) =>
          l.includes('refused writes outside the project'),
        )
        expect(hints.map((l) => l.includes(target))).toEqual([true])
        // A note beside the failure, never a counted denial.
        expect(outcome?.sandboxViolations).toBe(0)
        expect(existsSync(target)).toBe(false)
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it.skipIf(process.platform !== 'linux')(
    'the refused-write note spells a grant for a directory at the filesystem root',
    async () => {
      // The parent of `/x` is `/`, and the grant was spelled `'//'`.
      const target = `/vx-refused-${process.pid}-${Date.now()}`
      await addProject(fixture.root, 'rootwriter', {
        files: { 'src/x.txt': 'hi' },
        config: `
          export default {
            tasks: {
              build: {
                exec: {
                  command: 'mkdir -p ${target}/a',
                  sandbox: { allow: { read: ['.'] } },
                },
              },
            },
          }
        `,
      })
      const r = await run({ cwd: fixture.root, tasks: ['build'], log: collectingLogger(fixture) })
      expect(r.ok).toBe(false)
      const outcome = r.outcomes.find((o) => o.node.id === 'rootwriter#build')
      const hints = (outcome?.sandboxViolationLines ?? []).filter((l) =>
        l.includes('refused writes outside the project'),
      )
      expect(hints).toHaveLength(1)
      expect(hints[0]).toContain(`violations: ${target}.`)
      expect(hints[0]).toContain("allow: { write: ['/'] }")
      expect(existsSync(target)).toBe(false)
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
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
      })
      const r = await run({ cwd: fixture.root, tasks: ['build'], log: collectingLogger(fixture) })
      expect(r.ok).toBe(false)
      const outcome = r.outcomes.find((o) => o.node.id === 'dirgrant#build')
      const lines = outcome?.sandboxViolationLines ?? []
      expect(lines.some((l) => l.includes('write grant `dist` named nothing on disk'))).toBe(true)
      // The note is vx's, beside a failure of the task's own: no denial is
      // counted (B-20; the label read "1 sandbox violation").
      expect(outcome?.sandboxViolations).toBe(0)
      expect(lines.some((l) => l.includes('spell the grant `dist/`'))).toBe(true)
      expect(existsSync(path.join(projDir, 'dist'))).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'a `dist/` write grant is a directory the task may fill',
    async () => {
      // `vfs.disk-space`: macOS 27's `cp` and bash ask it, and an ungranted
      // ask is a violation that fails the task.
      const projDir = await addProject(fixture.root, 'dirslash', {
        files: { 'src/x.txt': 'hi' },
        config: `
          export default {
            tasks: {
              build: {
                exec: {
                  command: 'mkdir -p dist && cp src/x.txt dist/out.txt',
                  sandbox: { allow: { read: ['.'], write: ['dist/'], systemInfo: ['vfs.disk-space'] } },
                },
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
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
    'a write glob covers what is inside the directories it matches',
    async () => {
      // pnpm 12 opens `/tmp/pnpm-store-operation-locks-<uid>/all-stores.lock`,
      // granted as `/tmp/pnpm-store-operation-locks-*/`. On macOS the glob
      // covered the directory alone, and pnpm's install failed on EPERM.
      // `/tmp` is a link to `/private/tmp` there, the shape the grant meets.
      const stem = `/tmp/vxwg-${process.pid}-${Date.now()}`
      mkdirSync(`${stem}-1`)
      try {
        await addProject(fixture.root, 'wglob', {
          config: `
            export default {
              tasks: {
                build: {
                  exec: {
                    command: 'echo locked > ${stem}-1/all.lock',
                    sandbox: { allow: { read: ['.'], write: ['${stem}-*/'] } },
                  },
                },
              },
            }
          `,
        })
        const r = await run({ cwd: fixture.root, tasks: ['build'], log: collectingLogger(fixture) })
        expectOk(r, fixture)
        expect(readFileSync(`${stem}-1/all.lock`, 'utf8')).toBe('locked\n')
      } finally {
        await rm(`${stem}-1`, { recursive: true, force: true })
      }
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
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
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
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
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
        inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
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
              inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
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
              inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
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

  // ─── A task's temp directory is its own ─────────────────────────

  it(
    "a task cannot read a concurrent task's TMPDIR (L-10)",
    async () => {
      // SRT binds its whole temp dir writable into every task, where each
      // task's TMPDIR lived: b listed a's and read what a kept there. The
      // probe reads both layouts, the old (`vx-task-*` at the top) and the
      // walled one, for as long as a holds its file.
      // `vfs.disk-space`: macOS 27's `cp` and bash ask it, and an ungranted
      // ask is a violation that fails the task.
      const shared =
        process.env['CLAUDE_CODE_TMPDIR'] || process.env['CLAUDE_TMPDIR'] || '/tmp/claude'
      const task = (command: string): string => `
        export default {
          tasks: {
            probe: {
              exec: {
                command: ${JSON.stringify(command)},
                sandbox: { allow: { read: ['.'], write: ['out.txt'], systemInfo: ['vfs.disk-space'] } },
              },
            },
          },
        }
      `
      await addProject(fixture.root, 'holder', {
        config: task(
          'echo L10-SECRET > "$TMPDIR/secret" && cat "$TMPDIR/secret" > out.txt; sleep 3',
        ),
      })
      await addProject(fixture.root, 'prober', {
        config: task(
          `for i in $(seq 40); do cat ${shared}/vx-task-*/secret ${shared}/vx-tasks/*/secret 2>/dev/null | grep -q L10 && break; sleep 0.05; done; cat ${shared}/vx-task-*/secret ${shared}/vx-tasks/*/secret > out.txt 2>/dev/null; true`,
        ),
      })
      const r = await run({ cwd: fixture.root, tasks: ['probe'], log: collectingLogger(fixture) })
      expectOk(r, fixture)
      const out = (p: string): string =>
        readFileSync(path.join(fixture.root, 'packages', p, 'out.txt'), 'utf8').trim()
      expect({ holder: out('holder'), prober: out('prober') }).toEqual({
        holder: 'L10-SECRET',
        prober: '',
      })
    },
    TIMEOUT,
  )

  // ─── Unix sockets are a per-task grant ──────────────────────────

  it(
    "one task's unixSockets grant does not lift the socket block for the run's others (L-6)",
    async () => {
      // SRT reads the lift from its run-wide config, so a task that asked
      // for no socket reached the host's (docker's, ssh-agent's) once any
      // task in the run did. A host socket outside the workspace stands in.
      const sockDir = await mkdtemp(path.join(os.tmpdir(), 'vx-l6-'))
      const sock = path.join(sockDir, 'host.sock')
      const server = Bun.listen({
        unix: sock,
        socket: {
          open() {},
          data() {},
        },
      })
      try {
        // bun, not socat: the macOS runner has no socat, and the refusal is
        // what is asserted there too (seatbelt's, not seccomp's).
        const connect = `const s = require('net').connect('${sock}'); s.on('connect', () => { process.stdout.write('REACHED'); s.destroy() }); s.on('error', (e) => process.stdout.write('ERR ' + e.code))`
        const probe = (sockets: string): string => `
          export default {
            tasks: {
              probe: {
                exec: {
                  command: ${JSON.stringify(`bun -e "${connect}" > out.txt 2>&1; true`)},
                  sandbox: { allow: { read: ['.'], write: ['out.txt']${sockets} } },
                },
              },
            },
          }
        `
        await addProject(fixture.root, 'granted', { config: probe(', unixSockets: true') })
        await addProject(fixture.root, 'plain', { config: probe('') })
        const r = await run({ cwd: fixture.root, tasks: ['probe'], log: collectingLogger(fixture) })
        expectOk(r, fixture)
        const out = (p: string): string =>
          readFileSync(path.join(fixture.root, 'packages', p, 'out.txt'), 'utf8')
        expect({
          granted: out('granted'),
          plain: out('plain').startsWith('ERR '),
        }).toEqual({ granted: 'REACHED', plain: true })
      } finally {
        server.stop(true)
        await rm(sockDir, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

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
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
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
