// Sandbox grants, the strace parse and the probe.
//
// These tests are gated on SRT's runtime deps (bwrap on Linux,
// sandbox-exec on macOS). CI installs bubblewrap + socat + strace,
// disables AppArmor's unprivileged-userns restriction, and sets
// VX_REQUIRE_SANDBOX — so an unavailable runtime FAILS there rather than
// skipping, because a skipped suite reports green and this one covers
// the isolation boundary. A local host without the deps still skips.

import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { chmod, chown, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { addProject, makeWorkspace as makeWorkspaceRoot } from './helpers/workspace.js'
import {
  initSandbox,
  pendingWriteGrants,
  probeSandbox,
  resetSandbox,
  type SandboxViolation,
  resolveSandboxConfig,
  runSandboxed,
} from '../src/exec/sandbox-runtime.js'
import { bindableWrites, buildCustomConfig, scratchWrites } from '../src/exec/sandbox-binds.js'
import {
  deniedCalls,
  parseStraceViolations,
  refusedWrites,
  refusedWritesOutside,
  reportableViolations,
} from '../src/exec/sandbox-violations.js'
import { type RunSummary } from '../src/orchestrator/index.js'
import { run } from './helpers/orchestrator.js'
// SRT's own strip and glob compiler: what a macOS grant covers is its answer.
import {
  globToRegex,
  removeTrailingGlobSuffix,
} from '@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js'
import { sandboxRequestFor } from '../src/orchestrator/sandbox-request.js'
import type { TaskNode } from '../src/graph/index.js'
import {
  TIMEOUT,
  type Fixture,
  expectOk,
  collectingLogger,
  makeWorkspace,
} from './helpers/sandbox-fixture.js'

const available = await sandboxAvailable('sandbox-runtime tests')

describe.skipIf(!available)('a cache declaration grants the sandbox nothing', () => {
  // "The sandbox derives NOTHING from `cache`" (2026-09-05) is stated
  // in `sandbox-request.ts` and in schema.md — `inputs` says what
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
              inputs: { files: ['src/**'] },
              cache: {
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

// B-4: item 1010 walled a root project off from its nested projects,
// `.git` and `.vx` on Linux only (the punch is a mount layout), so under
// seatbelt a root task's `read: ['.']` still read a nested project whose
// files its key excludes. Driven through the request core builds, on both
// platforms: a wall is unreadable, the root's own file is not.
describe.skipIf(!available)("a root project's read grant stops at the walls", () => {
  let root = ''
  beforeEach(async () => {
    root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-walls-')))
    await mkdir(path.join(root, 'packages', 'b'), { recursive: true })
    await mkdir(path.join(root, '.git'))
    await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, 'packages', 'b', 'x.txt'), 'nested')
    await writeFile(path.join(root, '.git', 'HEAD'), 'ref')
    await writeFile(path.join(root, 'src', 'y.txt'), 'own')
    await initSandbox()
  })
  afterEach(async () => {
    await resetSandbox()
    await rm(root, { recursive: true, force: true })
  })

  it(
    'a nested project and .git are unreadable, the root’s own file is not',
    async () => {
      const node = {
        id: 'root#build',
        projectName: 'root',
        projectDir: root,
        taskName: 'build',
        config: { exec: { command: 'true' } },
      } as unknown as TaskNode
      const { sandbox } = await sandboxRequestFor(
        node,
        { allow: { read: ['.'] } },
        root,
        undefined,
        [path.join(root, 'packages', 'b')],
      )
      const cat = async (file: string) => {
        const r = await runSandboxed({
          command: `cat ${file}`,
          cwd: root,
          env: process.env,
          ...sandbox,
        })
        return [file, r.exitCode === 0 ? r.stdout : 'refused']
      }
      expect(await Promise.all(['src/y.txt', 'packages/b/x.txt', '.git/HEAD'].map(cat))).toEqual([
        ['src/y.txt', 'own'],
        ['packages/b/x.txt', 'refused'],
        ['.git/HEAD', 'refused'],
      ])
    },
    TIMEOUT,
  )
  // B-12: a GLOB's hit on a wall. Linux drops it before the bind (B-1);
  // seatbelt matched the glob as a regex, and SRT re-emits a wall's deny
  // only under a literal allow, so on darwin both walls read.
  it(
    'a glob grant stops at the walls too',
    async () => {
      const node = {
        id: 'root#build',
        projectName: 'root',
        projectDir: root,
        taskName: 'build',
        config: { exec: { command: 'true' } },
      } as unknown as TaskNode
      const { sandbox } = await sandboxRequestFor(
        node,
        { allow: { read: ['**/*.txt', '.*/*'] } },
        root,
        undefined,
        [path.join(root, 'packages', 'b')],
      )
      const cat = async (file: string) => {
        const r = await runSandboxed({
          command: `cat ${file}`,
          cwd: root,
          env: process.env,
          ...sandbox,
        })
        return [file, r.exitCode === 0 ? r.stdout : 'refused']
      }
      expect(await Promise.all(['src/y.txt', 'packages/b/x.txt', '.git/HEAD'].map(cat))).toEqual([
        ['src/y.txt', 'own'],
        ['packages/b/x.txt', 'refused'],
        ['.git/HEAD', 'refused'],
      ])
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
              inputs: { files: ['src/**'] },
              cache: {
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
    // Linux-only: the lines are Linux's write observer's, and macOS
    // seatbelt refuses differently. What is NOT platform-specific is
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
              inputs: { files: ['src/**'] },
              cache: {
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
        // no allow block at all. Nothing binds the project, so it is a
        // read-only mask (`readOnlyMasks`): the `mkdir` is refused, reported
        // and fails the run — the honest outcome, not a silent empty
        // artifact. (The mask was writable before 2026-10-02, and the
        // `openat` under it was reported too.)
        const dir = realpathSync(await project(undefined))
        const r = await run({ cwd: fixture.root, tasks: ['build'], log: collectingLogger(fixture) })
        expect(r.ok).toBe(false)
        expect([r.outcomes[0]?.status, r.outcomes[0]?.sandboxViolationLines]).toEqual([
          'failed',
          [`mkdir(${dir}/dist) = a write no grant covers  [${dir}/dist]`],
        ])
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
  'a write grant widens what a task can READ, and the trace reports it',
  () => {
    // `bindableWrites` widens a FILE-shaped write grant to its DIRECTORY on
    // Linux, because bwrap cannot rename onto an active file mount. A
    // read-write bind is readable, so the whole directory became readable
    // unreported — and an undeclared read is exactly the thing the sandbox
    // exists to catch, because the key folds this project's inputs
    // (2026-09-20). The read still succeeds; the strace pass now reports
    // it (B-71, `tests/sandbox-widened-reads.unsafe.test.ts`).
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
                  command: 'cat 2>/dev/null > probe/root.txt < undeclared.txt; cat 2>/dev/null > probe/dist.txt < dist/sibling.txt; echo done',
                  sandbox: { allow: { read: ['src/**'], write: ['${write}', 'probe/'] } },
                },
                inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
              },
            },
          }
        `,
      })

    it(
      'a write grant at the project ROOT makes the whole root readable — and reported',
      async () => {
        const dir = await project('out.txt')
        const r = await run({ cwd: fixture.root, tasks: ['build'], log: collectingLogger(fixture) })
        // The read SUCCEEDED (no syscall failed), and the trace's successful
        // opens under the widened directory report it, and the read of
        // `dist/sibling.txt`, which lies under it too.
        expect(r.outcomes[0]?.status).toBe('failed')
        expect(r.outcomes[0]?.sandboxViolations).toBe(2)
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
        // The root read is denied; the read of `dist/`'s sibling succeeds
        // (the widening is real and scoped) and is reported.
        expect(r.outcomes[0]?.sandboxViolations).toBe(2)
        // The redirection still creates the file; what the denial costs is
        // its CONTENT, which is the difference that matters.
        expect(await readFile(path.join(dir, 'probe', 'root.txt'), 'utf8')).toBe('')
        expect(await readFile(path.join(dir, 'probe', 'dist.txt'), 'utf8')).toBe('IN DIST')
      },
      TIMEOUT,
    )
  },
)

describe.skipIf(!available || process.platform !== 'linux')(
  'an undeclared read, run for real',
  () => {
    // The landing's fifth callout (a workspace file you did not declare is
    // out of reach) on the task's own files, as a real trace: `app#build`
    // reads `banner.txt` without declaring it and fails with exactly one
    // violation line naming it, and declaring the file lets the task pass. (The Guide's stale-hit demo,
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
              command: 'mkdir -p dist && cat src/index.ts - < banner.txt > dist/out.txt',
              sandbox: { allow: { read: ${JSON.stringify(files)}, write: ['dist/'] } },
            },
            inputs: { files: ${JSON.stringify(files)} }, cache: { outputs: { files: ['dist/**'] } },
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
        // The shell opens banner.txt, so it reads on any cat: Ubuntu 26's
        // (uutils) stats first and so never opens a hidden path.
        expect(r.outcomes[0]?.exitCode).toBe(2)
        expect(r.outcomes[0]?.sandboxViolationLines).toEqual([
          `openat(banner.txt) = -1 ENOENT  [${realpathSync(dir)}/banner.txt]`,
        ])
        // The logger trims each stderr chunk, and the message arrives split
        // wherever its writes land, so the comparison drops whitespace,
        // which no split can move.
        expect(fixture.log.join('').replace(/\s/g, '')).toContain('cannotopenbanner.txt:Nosuchfile')

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

    // GNU cp opens its destination without O_CREAT first, and tsc probes
    // its buildinfo: a miss under a write grant is the task's own output
    // not made yet, as one under a read grant is a file it lacks. It was
    // counted, and `cp` into `dist/` failed the task (X-63).
    it(
      'a missing file under a write grant is no violation',
      async () => {
        const dir = await addProject(fixture.root, 'app', {
          config: `export default { tasks: { build: { exec: {
            command: 'mkdir -p dist; cp src/in.txt dist/out.txt',
            sandbox: { allow: { read: ['src/'], write: ['dist/'] } },
          } } } }\n`,
          files: { 'src/in.txt': 'in\n' },
        })
        const r = await run({ cwd: fixture.root, tasks: ['build'], log: collectingLogger(fixture) })
        expect(r.outcomes[0]?.sandboxViolationLines ?? []).toEqual([])
        expectOk(r, fixture)
        expect(await readFile(path.join(dir, 'dist', 'out.txt'), 'utf8')).toBe('in\n')
      },
      TIMEOUT,
    )
  },
)

// B-5: on Linux a write the sandbox refuses is `EROFS` (a read-only bind),
// and the trace pass read ENOENT, EACCES and EPERM only; it also skipped
// every path under a read grant. A task that swallowed its failed write
// exited 0 with no violation, where schema.md says a refused write fails
// the task and macOS's seatbelt reports it.
describe.skipIf(!available || process.platform !== 'linux')(
  'an undeclared write, run for real',
  () => {
    let fixture: Fixture
    beforeEach(async () => {
      fixture = await makeWorkspace()
    })
    afterEach(async () => {
      await rm(fixture.root, { recursive: true, force: true })
    })

    // `then` runs after the refused write; 150 declared writes there pushed
    // its record out of SRT's store, a 100-record ring the whole run shares.
    const project = (write: string[], then = 'echo ok > dist/out.txt') =>
      addProject(fixture.root, 'app', {
        config: `
        export default {
          tasks: {
            gen: {
              exec: {
                command: 'mkdir -p dist && { echo x > src/gen.txt; } 2>/dev/null; ${then}',
                sandbox: { allow: { read: ['.'], write: ${JSON.stringify(write)} } },
              },
            },
          },
        }
      `,
        files: { 'src/index.ts': 'export default 1\n' },
      })

    it(
      'a refused write the task ignores still fails it, naming the path',
      async () => {
        const dir = await project(['dist/'])
        const r = await run({ cwd: fixture.root, tasks: ['gen'], log: collectingLogger(fixture) })
        expect([r.outcomes[0]?.status, r.outcomes[0]?.exitCode]).toEqual(['failed', 1])
        expect(r.outcomes[0]?.sandboxViolationLines).toEqual([
          `openat(${realpathSync(dir)}/src/gen.txt) = a write no grant covers  [${realpathSync(dir)}/src/gen.txt]`,
        ])
      },
      TIMEOUT,
    )

    it(
      'is reported however many declared writes follow it',
      async () => {
        const dir = await project(['dist/'], 'for i in $(seq 150); do echo $i > dist/f$i.txt; done')
        const r = await run({ cwd: fixture.root, tasks: ['gen'], log: collectingLogger(fixture) })
        expect([r.outcomes[0]?.status, r.outcomes[0]?.sandboxViolationLines]).toEqual([
          'failed',
          [
            `openat(${realpathSync(dir)}/src/gen.txt) = a write no grant covers  [${realpathSync(dir)}/src/gen.txt]`,
          ],
        ])
      },
      TIMEOUT,
    )

    it(
      'CONTROL: granted, the same write lands and the task passes',
      async () => {
        const dir = await project(['dist/', 'src/'])
        const r = await run({ cwd: fixture.root, tasks: ['gen'], log: collectingLogger(fixture) })
        expectOk(r, fixture)
        expect(await readFile(path.join(dir, 'src', 'gen.txt'), 'utf8')).toBe('x\n')
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
            inputs: { files: ${JSON.stringify(files)} }, cache: { outputs: { files: ['dist/**'] } },
          },
        },
      }
    `
    const demo = 'mkdir -p dist && cat src/index.ts - < banner.txt > dist/out.txt'

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
      // The edge a lockfile plugin gives: core reads no manifest edge.
      fixture = await makeWorkspace({ '@x/app': ['@x/ui'], '@x/ui': ['@x/core'] })
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
              command: 'mkdir -p dist && cat < ${linkPath[layout]}/src/index.js > dist/out.txt',
              sandbox: { allow: { read: ['.'], write: ['dist/'] } },
            },
            dependsOn: ${JSON.stringify(opts.dependsOn)},
            ${opts.cache ? "inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } }," : ''}
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
                inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
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
        `vx: @x/app#test read \`packages/x-ui\` through \`${link}\`, and its key includes no task ` +
          'of @x/ui, so an edit there would not re-run it. Add a `dependsOn` edge that ' +
          'reaches one (`^build` where @x/ui#build keys its sources, or a `source` task: ' +
          '`@x/ui#source`), or grant and key the files yourself (`allow.read` plus ' +
          '`inputs.workspaceFiles`).',
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
          // One denial; the withheld-link line beside it is vx's note (B-20).
          expect(denied?.sandboxViolations).toBe(1)
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

    // pnpm and Bun link ui's own dependency under ui's `node_modules`, so
    // app -> ui -> core put core where the scan never looked: importing ui
    // failed with ENOENT on core, no violation, cached or not.
    /** app imports ui, ui re-exports core, each linked under its dependant. */
    const chain = async (opts: { cache: boolean; uiKeysCore: boolean }): Promise<string> => {
      const source = (dependsOn: string[]) => `
        export default {
          tasks: {
            source: {
              dependsOn: ${JSON.stringify(dependsOn)},
              exec: { command: 'true' },
              inputs: { files: ['*.js'] }, cache: { outputs: { files: [] } },
            },
          },
        }
      `
      const core = await addProject(fixture.root, '@x/core', {
        files: { 'index.js': 'export const core = "core 1"\n' },
        config: source([]),
      })
      const ui = await addProject(fixture.root, '@x/ui', {
        deps: { '@x/core': 'workspace:*' },
        files: { 'index.js': 'export { core } from "@x/core"\n' },
        config: source(opts.uiKeysCore ? ['^source'] : []),
      })
      const app = await addProject(fixture.root, '@x/app', {
        deps: { '@x/ui': 'workspace:*' },
        files: {
          'src/check.js': 'import { core } from "@x/ui"\nawait Bun.write("dist/out.txt", core)\n',
        },
        config: `
          export default {
            tasks: {
              test: {
                exec: {
                  command: 'mkdir -p dist && bun src/check.js',
                  sandbox: { allow: { read: ['.'], write: ['dist/'] } },
                },
                dependsOn: ['^source'],
                ${opts.cache ? "inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } }," : ''}
              },
            },
          }
        `,
      })
      for (const [from, to] of [
        [app, 'x-ui'],
        [ui, 'x-core'],
      ] as const) {
        await mkdir(path.join(from, 'node_modules', '@x'), { recursive: true })
        await symlink(`../../../${to}`, path.join(from, 'node_modules', '@x', to.slice(2)))
      }
      return core
    }
    const out = () =>
      readFile(path.join(fixture.root, 'packages', 'x-app', 'dist', 'out.txt'), 'utf8')

    it(
      "a dependency's own workspace dependency is granted to a task with no `cache`",
      async () => {
        await chain({ cache: false, uiKeysCore: false })
        const r = await runTest()
        expectOk(r, fixture)
        expect(testOutcome(r)?.sandboxViolations).toBeUndefined()
        expect(await out()).toBe('core 1')
      },
      TIMEOUT,
    )

    it(
      "a dependency's own workspace dependency the key answers for is granted, and an edit re-runs",
      async () => {
        const core = await chain({ cache: true, uiKeysCore: true })
        expectOk(await runTest(), fixture)
        expect(await out()).toBe('core 1')
        await writeFile(path.join(core, 'index.js'), 'export const core = "core 2"\n')
        const r = await runTest()
        expect(testOutcome(r)?.status).toBe('success')
        expect(await out()).toBe('core 2')
      },
      TIMEOUT,
    )

    it(
      "a dependency's own workspace dependency the key does not answer for is withheld, with the hint",
      async () => {
        await chain({ cache: true, uiKeysCore: false })
        const r = testOutcome(await runTest())
        expect(r?.status).toBe('failed')
        expect(r?.sandboxViolationLines?.at(-1)).toBe(
          'vx: @x/app#test read `packages/x-core` through `packages/x-ui/node_modules/@x/core`, ' +
            'and its key includes no task of @x/core, so an edit there would not re-run it. Add a ' +
            '`dependsOn` edge that reaches one (`^build` where @x/core#build keys its sources, or ' +
            'a `source` task: `@x/core#source`), or grant and key the files yourself ' +
            '(`allow.read` plus `inputs.workspaceFiles`).',
        )
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
                  command: 'sleep 0.4; mkdir -p probe; cat 2>/dev/null > probe/got.txt < secret.txt; echo done',
                  sandbox: { allow: { read: ['src/**'], write: ['probe/'] } },
                },
                inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
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

describe.skipIf(!available)("vx's task directories are this user's own (L-13)", () => {
  // `vx-tasks` sits in a shared temp dir. A user who made it first owned
  // the parent of every task's TMPDIR and bridge socket: probed, another
  // uid renamed a running task's directory and planted its own under the
  // name the host bridge dials. Each row points CLAUDE_CODE_TMPDIR at a
  // fresh directory and plants what that user could.
  let base: string
  const saved = process.env['CLAUDE_CODE_TMPDIR']
  beforeEach(async () => {
    base = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-l13-')))
    process.env['CLAUDE_CODE_TMPDIR'] = base
  })
  afterEach(async () => {
    if (saved === undefined) delete process.env['CLAUDE_CODE_TMPDIR']
    else process.env['CLAUDE_CODE_TMPDIR'] = saved
    await resetSandbox()
    await rm(base, { recursive: true, force: true })
  })
  const runOne = async (): Promise<string> => {
    await initSandbox()
    const node = {
      id: 'root#build',
      projectDir: base,
      taskName: 'build',
      config: { exec: { command: 'true' } },
    } as unknown as TaskNode
    const { sandbox } = await sandboxRequestFor(
      node,
      { allow: { read: ['.'] } },
      base,
      undefined,
      [],
    )
    const command = 'echo "$TMPDIR"; ls -ld "$TMPDIR" | cut -c1-10'
    return runSandboxed({ command, cwd: base, env: process.env, ...sandbox }).then(
      (r) => (r.exitCode === 0 ? r.stdout.trim() : `exit ${r.exitCode}`),
      (e: unknown) => `refused: ${(e as Error).message}`,
    )
  }
  const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8)
  const dirOf = (out: string): string => path.dirname(out.split('\n')[0]!)

  it(
    'the root and each task directory are 0700; a root of ours left open is closed',
    async () => {
      const root = path.join(base, 'vx-tasks')
      await mkdir(root, { mode: 0o777 })
      await chmod(root, 0o777)
      const out = await runOne()
      expect({ under: dirOf(out), root: mode(root), task: out.split('\n')[1] }).toEqual({
        under: root,
        root: '700',
        task: 'drwx------',
      })
    },
    TIMEOUT,
  )

  it(
    'a planted link, or a parent others may rewrite, is refused',
    async () => {
      const elsewhere = path.join(base, 'elsewhere')
      await mkdir(elsewhere)
      await symlink(elsewhere, path.join(base, 'vx-tasks'))
      const linked = await runOne()
      await rm(path.join(base, 'vx-tasks'))
      await chmod(base, 0o777)
      const open = await runOne()
      await chmod(base, 0o1777)
      // CONTROL: the sticky bit keeps others to their own entries (`/tmp`).
      const sticky = await runOne()
      expect({
        linked: linked.startsWith('refused: sandbox: ') && linked.includes('vx-tasks'),
        open: open.startsWith('refused: sandbox: '),
        sticky: dirOf(sticky),
        planted: readdirSync(elsewhere),
      }).toEqual({ linked: true, open: true, sticky: path.join(base, 'vx-tasks'), planted: [] })
    },
    TIMEOUT,
  )

  it.skipIf(process.getuid?.() !== 0)(
    "another user's root is refused",
    async () => {
      const root = path.join(base, 'vx-tasks')
      await mkdir(root, { mode: 0o700 })
      await chown(root, 65534, 65534)
      const out = await runOne()
      await chown(root, 0, 0)
      const ours = await runOne()
      expect({ other: out.startsWith('refused: sandbox: '), ours: dirOf(ours) }).toEqual({
        other: true,
        ours: root,
      })
    },
    TIMEOUT,
  )
})

describe.skipIf(!available)("a sandboxed task's JAVA_TOOL_OPTIONS is its own", () => {
  // SRT sets JAVA_TOOL_OPTIONS to its proxy agent's flag composed with the
  // value in VX's environment, over the task's: a host value no layer
  // passes reached the task out of its key (a changed one replayed the old
  // output), and a task's own define never arrived (item 995). The agent
  // flag in each value proves SRT's path ran, or both rows pass unasked.
  it(
    "the host's value is cut out and the task's own kept",
    async () => {
      const root = await makeWorkspaceRoot({ prefix: 'vx-jto-' })
      const previous = process.env['JAVA_TOOL_OPTIONS']
      process.env['JAVA_TOOL_OPTIONS'] = '-Dhost.leak=1'
      try {
        const dir = await addProject(root, 'app', {
          files: {},
          config: `export default { tasks: {
            bare: { exec: { command: 'printf "%s" "\${JAVA_TOOL_OPTIONS-unset}" > bare.txt', sandbox: { allow: { write: ['bare.txt'] } } } },
            own: { exec: { command: 'printf "%s" "\${JAVA_TOOL_OPTIONS-unset}" > own.txt', env: { define: { JAVA_TOOL_OPTIONS: '-Xmx1g' } }, sandbox: { allow: { write: ['own.txt'] } } } },
          } }`,
        })
        const fixture: Fixture = { root, log: [] }
        expectOk(
          await run({ cwd: root, tasks: ['bare', 'own'], log: collectingLogger(fixture) }),
          fixture,
        )
        const bare = await readFile(path.join(dir, 'bare.txt'), 'utf8')
        const own = await readFile(path.join(dir, 'own.txt'), 'utf8')
        expect(bare).toContain('-javaagent:')
        expect(own).toContain('-javaagent:')
        expect(bare).not.toContain('host.leak')
        expect(own).not.toContain('host.leak')
        expect(own.split(/\s+/)).toContain('-Xmx1g')
      } finally {
        if (previous === undefined) delete process.env['JAVA_TOOL_OPTIONS']
        else process.env['JAVA_TOOL_OPTIONS'] = previous
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

describe.skipIf(!available)("a task's temp directory is its own", () => {
  // SRT points every sandboxed task at one host directory, bound read-write
  // and kept across runs: a file one task wrote in $TMPDIR was the next
  // task's, and the next run's, undeclared input (item 965).
  it(
    'a temp file one task wrote is gone for the next, and so is its directory',
    async () => {
      const root = await makeWorkspaceRoot({ prefix: 'vx-tmp-own-' })
      try {
        const dir = await addProject(root, 'app', {
          files: {},
          config: `export default { tasks: {
            w: { exec: { command: 'echo written > "$TMPDIR/x"; echo "$TMPDIR" > tmpdir.txt', sandbox: { allow: { write: ['tmpdir.txt'] } } } },
            r: { exec: { command: 'cat "$TMPDIR/x" 2>/dev/null || echo ABSENT', sandbox: {} } },
          } }`,
        })
        const out: string[] = []
        const log = {
          status() {},
          taskStdout(_n: unknown, chunk: string) {
            out.push(chunk)
          },
          taskStderr() {},
          taskComplete() {},
        } as never
        expect((await run({ cwd: root, tasks: ['w'], log })).outcomes[0]?.status).toBe('success')
        const used = (await readFile(path.join(dir, 'tmpdir.txt'), 'utf8')).trim()
        expect(used).toContain('vx-task-')
        expect(existsSync(used)).toBe(false)
        out.length = 0
        expect((await run({ cwd: root, tasks: ['r'], log })).outcomes[0]?.status).toBe('success')
        expect(out.join('').trim()).toBe('ABSENT')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
  // The Linux trace log sat in the shared temp dir, readable by every
  // sandboxed task: a concurrent one read the paths this one opened (L-25).
  // `hold` waits for `peek` to have looked, so the log is live when it does.
  it.skipIf(process.platform !== 'linux')(
    'a concurrent task finds no trace log of another in the shared temp dir',
    async () => {
      const root = await makeWorkspaceRoot({ prefix: 'vx-trace-own-' })
      try {
        const wait = (file: string) =>
          `i=0; while [ ! -s ${file} ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done`
        await addProject(root, 'app', {
          files: { 'opened-l25.txt': 'x', 'm1/.keep': '', 'm2/.keep': '' },
          config: `export default { tasks: {
            hold: { exec: { command: 'cat opened-l25.txt > /dev/null; echo up > m1/up; ${wait('m2/looked')}', sandbox: { allow: { read: ['.'], write: ['m1/'] } } } },
            peek: { exec: { command: '${wait('m1/up')}; grep -l opened-l25 ${os.tmpdir()}/vx-strace-*.log 2>/dev/null; echo looked > m2/looked', sandbox: { allow: { read: ['.'], write: ['m2/'] } } } },
          } }`,
        })
        const out: string[] = []
        const log = {
          status() {},
          taskStdout(_n: unknown, chunk: string) {
            out.push(chunk)
          },
          taskStderr() {},
          taskComplete() {},
        } as never
        const r = await run({ cwd: root, tasks: ['hold', 'peek'], log })
        expect(r.outcomes.map((o) => o.status)).toEqual(['success', 'success'])
        expect(out.join('')).toBe('')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

describe('resolveSandboxConfig', () => {
  // A config resolved and its pending write globs judged against the binds
  // it makes, as `wrapSandboxedCommand` does: the workspace is `root`.
  const judged = (cfg: Parameters<typeof resolveSandboxConfig>[0], root: string) => {
    const r = resolveSandboxConfig(cfg, root)
    pendingWriteGrants(
      r,
      buildCustomConfig({ config: r }, { allowRead: [], denyRead: [root] })!.filesystem!,
      [root],
      root,
    )
    return r
  }

  // B-6: a glob's scan starts one directory above its first wildcard, and
  // `Bun.Glob` throws ENOENT when that directory is missing — a cache not
  // yet populated on a fresh runner (`~/.cache/x/y/*`). The task failed
  // with the raw errno and no word of the grant; a missing base matches
  // nothing, as an empty one does.
  it.skipIf(process.platform !== 'linux')(
    'a glob under a directory that does not exist matches nothing, and a write one says so',
    async () => {
      const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-sbx-no-base-')))
      const said: string[] = []
      const spy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
        said.push(String(chunk))
        return true
      })
      try {
        const read = resolveSandboxConfig({ allow: { read: [`${root}/none/deeper/*`] } }, root)
        const write = judged({ allow: { read: ['.'], write: ['gone/away/*.txt'] } }, root)
        expect([read.allowRead, write.allowWrite]).toEqual([[], []])
        expect(said.join('')).toContain(`the write grant 'gone/away/*.txt' matches nothing yet`)
      } finally {
        spy.mockRestore()
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  // SRT drops every Linux write path holding a bracket, so the grant
  // bound nothing and the task's write read only "a write no grant covers"
  // beside the grant that named it.
  it.skipIf(process.platform !== 'linux')(
    'says so when a write path holds a bracket, and names the directory above it',
    async () => {
      const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-sbx-bracket-')))
      await mkdir(path.join(root, 'out', '[id]'), { recursive: true })
      const said: string[] = []
      const spy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
        said.push(String(chunk))
        return true
      })
      try {
        await mkdir(path.join(root, 'dist'))
        judged({ allow: { read: ['.'], write: ['out/\\[id\\]/', 'dist/'] } }, root)
        // Out of the binds, so the read grants keep the directory and the
        // refused write is judged against no grant.
        expect(bindableWrites([`${root}/out/[id]`, `${root}/dist`])).toEqual([`${root}/dist`])
        expect(said.filter((l) => l.includes('holds a bracket'))).toEqual([
          `[vx] sandbox: the write grant ${root}/out/[id] holds a bracket, and the Linux ` +
            `sandbox mounts no write path that does, so a write under it is refused. Grant ` +
            `the directory above it instead: ${root}/out/\n`,
        ])
      } finally {
        spy.mockRestore()
        await rm(root, { recursive: true, force: true })
      }
    },
  )

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
          judged({ allow: { read: ['.'], write: ['g/*.txt'] } }, root)
          // CONTROL, in the same spy window: a grant that CAN be mounted
          // says nothing, so the row above cannot pass on a warning that
          // fires for every write grant.
          judged({ allow: { read: ['.'], write: ['g/**'] } }, root)
          // CONTROL: a READ grant matching nothing is ordinary — an
          // optional file, a cache not yet populated — and must stay quiet.
          // A DIFFERENT pattern on purpose: the report is once per grant
          // path, so reusing `g/*.txt` here would be silenced by the write
          // call above and the control would pass whatever reads do. It
          // did, first time — the mutation that reports reads as well
          // survived it (item 496).
          judged({ allow: { read: ['g/r*.txt'] } }, root)
        } finally {
          spy.mockRestore()
        }
        expect(said.length).toBe(1)
        expect(said[0]).toContain('matches nothing yet')
        // The remedy is the directory the pattern was IN, not its parent.
        expect(said[0]).toContain("`allow: { write: ['g/'] }`")
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
          judged({ allow: { read: ['.'], write: ['g/*.txt'] } }, root)
          judged({ allow: { read: ['.'], write: ['g/*.bin'] } }, root)
          judged({ allow: { read: ['.'], write: ['g/*.bin'] } }, root)
        } finally {
          spy.mockRestore()
        }
        expect(said.map((l) => l.includes(`'g/*.bin' matches nothing yet`))).toEqual([true])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  // Seatbelt reads a glob grant as an exact regex and a literal one as a
  // subpath (SRT `pathFilter`), so on macOS a collapsed `<glob>/**` that
  // kept only `<glob>` covered the directory and nothing in it: `bun build
  // --compile` created `.<hash>-00000000.tmp` and was refused the runtime
  // inside it (2026-09-29). Driven on any host with the platform stubbed:
  // the collapse is pure path work, and what a grant covers is asked of
  // SRT's own strip and compiler — the first fix emitted `<glob>/**`, which
  // SRT strips back to `<glob>`, and a row that restated it passed.
  it('on macOS a glob directory keeps its subtree when collapsed', () => {
    const root = realpathSync(os.tmpdir())
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    let r: ReturnType<typeof resolveSandboxConfig>
    try {
      r = resolveSandboxConfig({ allow: { write: ['.*.tmp/**', 'dist/**'] } }, root)
    } finally {
      Object.defineProperty(process, 'platform', real)
    }
    const covers = (file: string): boolean =>
      r.allowWrite.some((g) =>
        new RegExp(globToRegex(removeTrailingGlobSuffix(g))).test(path.join(root, file)),
      )
    expect(
      ['.a.tmp', '.a.tmp/bun', '.a.tmp/d/bun', 'b.tmp/bun'].map((f) => [f, covers(f)]),
    ).toEqual([
      ['.a.tmp', true],
      ['.a.tmp/bun', true],
      ['.a.tmp/d/bun', true],
      ['b.tmp/bun', false],
    ])
  })

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

  // strace writes a path as a C string: a quote, a backslash and a
  // control byte escaped, a non-ASCII byte as octal. Read raw, `q"t.txt`
  // stopped at `q\` and `é.txt` was named `\303\251.txt`, so neither the
  // report nor an `ignore` pattern saw the file.
  it('decodes the C-string escapes strace writes a path with', () => {
    const trace = [
      String.raw`1001 openat(AT_FDCWD, "/ws/\303\251.txt", O_RDONLY) = -1 ENOENT (No such file or directory)`,
      String.raw`1001 openat(AT_FDCWD, "/ws/q\"t.txt", O_RDONLY) = -1 ENOENT (No such file or directory)`,
      String.raw`1002 openat(AT_FDCWD, "/ws/b\\s\tt\n", O_RDONLY <unfinished ...>`,
      '1002 <... openat resumed>)              = -1 EACCES (Permission denied)',
      String.raw`1001 openat(AT_FDCWD, "/ws/\x41\0011", O_RDONLY) = -1 ENOENT (No such file or directory)`,
      '',
    ].join('\n')
    expect(deniedCalls(trace).map((c) => c.rawPath)).toEqual([
      '/ws/é.txt',
      '/ws/q"t.txt',
      '/ws/b\\s\tt\n',
      '/ws/A\u00011',
    ])
  })

  // Given the starting cwd, each process's `chdir` and forks are followed:
  // a denial after `cd src` was reported against the starting cwd, naming
  // a file that does not exist, and no `ignore` for the real one matched.
  // A vfork child's lines come before its parent's `resumed` line.
  it('resolves a relative path against the cwd its process had moved to', () => {
    const trace = [
      '10 chdir("src")                     = 0',
      '10 vfork( <unfinished ...>',
      '11 openat(AT_FDCWD, "secret.txt", O_RDONLY) = -1 ENOENT (No such file or directory)',
      '10 <... vfork resumed>)            = 11',
      '10 clone(child_stack=NULL, flags=SIGCHLD, child_tidptr=0x7f) = 12',
      '12 chdir("/abs")                    = 0',
      '12 chdir("deeper" <unfinished ...>',
      '12 <... chdir resumed>)            = 0',
      '12 openat(AT_FDCWD, "a", O_RDONLY) = -1 EACCES (Permission denied)',
      '10 chdir("nope")                   = -1 ENOENT (No such file or directory)',
      '10 openat(AT_FDCWD, "b", O_RDONLY) = -1 ENOENT (No such file or directory)',
      '10 fchdir(3)                       = 0',
      '10 openat(AT_FDCWD, "c", O_RDONLY) = -1 ENOENT (No such file or directory)',
      '13 openat(AT_FDCWD, "d", O_RDONLY) = -1 ENOENT (No such file or directory)',
      '',
    ].join('\n')
    expect(deniedCalls(trace, '/ws/p').map((c) => [c.rawPath, c.dir])).toEqual([
      ['secret.txt', '/ws/p/src'],
      ['a', '/abs/deeper'],
      // A chdir refused is a denial of its own (B-67), and moves nothing.
      ['nope', '/ws/p/src'],
      ['b', '/ws/p/src'],
      // fchdir names no path: lost, so the starting cwd stands, as before.
      ['c', undefined],
      // A process with no fork in the trace started where the task did.
      ['d', undefined],
    ])
    // Without the starting cwd nothing is followed.
    expect(deniedCalls(trace).map((c) => c.dir)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })

  // A thread shares its creator's cwd (CLONE_FS) rather than copying it:
  // a worker started before the main thread's `chdir` opens from the new
  // directory, as libuv's pool does after `process.chdir`.
  it('moves a thread with the process whose cwd it shares', () => {
    const trace = [
      '20 clone3({flags=CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD, exit_signal=0}, 88) = 21',
      '20 clone(child_stack=0x7f, flags=CLONE_VM|CLONE_FS|CLONE_THREAD <unfinished ...>',
      '20 <... clone resumed>, parent_tid=[22]) = 22',
      '20 clone(child_stack=NULL, flags=SIGCHLD) = 23',
      '20 chdir("src")                    = 0',
      '21 openat(AT_FDCWD, "a", O_RDONLY) = -1 ENOENT (No such file or directory)',
      '22 chdir("deep")                   = 0',
      '20 openat(AT_FDCWD, "b", O_RDONLY) = -1 ENOENT (No such file or directory)',
      '23 openat(AT_FDCWD, "c", O_RDONLY) = -1 ENOENT (No such file or directory)',
      '20 vfork()                          = 24',
      '24 openat(AT_FDCWD, "e", O_RDONLY) = -1 ENOENT (No such file or directory)',
      '',
    ].join('\n')
    expect(deniedCalls(trace, '/ws').map((c) => [c.rawPath, c.dir])).toEqual([
      ['a', '/ws/src'],
      ['b', '/ws/src/deep'],
      // A forked process copied the cwd at the fork, before the `chdir`.
      ['c', undefined],
      // One forked after it copied the moved one.
      ['e', '/ws/src/deep'],
    ])
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
    // A probe's ENOENT counts only where the host has the path.
    await mkdir(ws, { recursive: true })
    await writeFile(path.join(ws, 'x'), '')
    expect(
      await targets([at(`${ws}/x`), `1 access("${ws}/x", 4) = -1 ENOENT (x)`].join('\n')),
    ).toEqual([`${ws}/x`, `${ws}/x`])
  })

  it("drops a probe's ENOENT where the host has no file, never an openat's", async () => {
    const ws = path.join(dir, 'ws')
    await mkdir(ws, { recursive: true })
    await writeFile(path.join(ws, 'gen.sh'), '')
    const exec = (p: string): string =>
      `1 execve("${p}", ["${p}", "f()"], 0x7ffd /* 9 vars */) = -1 ENOENT (x)`
    expect(
      (
        await produce(
          [
            exec(`${ws}/gen.sh`),
            exec(`${ws}/gone.sh`),
            `1 faccessat2(AT_FDCWD, "${ws}/gone", X_OK, AT_EACCESS) = -1 ENOENT (x)`,
            `1 access("${ws}/gone", R_OK) = -1 EACCES (x)`,
            at(`${ws}/gone`),
          ].join('\n'),
        )
      ).map((v) => `${v.line.split('(')[0]} ${v.target}`),
    ).toEqual([`execve ${ws}/gen.sh`, `access ${ws}/gone`, `openat ${ws}/gone`])
  })

  // Item 652: the row above holds the KEY; nothing held the dedup itself —
  // a tool that probes one missing path ten times would report ten lines.
  it('reports one line for the same syscall on the same path, however often', async () => {
    const ws = path.join(dir, 'ws')
    expect(await targets([at(`${ws}/x`), at(`${ws}/x`), at(`${ws}/x`)].join('\n'))).toEqual([
      `${ws}/x`,
    ])
  })

  // A DTE worker quiet two heartbeats is lost: a test shard's trace of
  // 44,788 calls held the loop 2.9 s and lost two workers (main, 2026-10-25).
  it('lets the event loop turn while it judges a long trace', async () => {
    const ws = path.join(dir, 'ws')
    await mkdir(ws, { recursive: true })
    const log = path.join(dir, 'trace.log')
    await writeFile(log, Array.from({ length: 5000 }, (_, i) => at(`${ws}/m${i}.js`)).join('\n'))
    // Counted by its hand-backs: turns of the loop while it reads the file
    // say nothing about the judging after.
    const yields = spyOn(globalThis, 'setImmediate')
    try {
      const produced = await parseStraceViolations(
        log,
        { command: 'x', cwd: ws, env: {}, config: resolveSandboxConfig({}, ws) } as never,
        { allowRead: [], denyRead: [ws], cwd: ws },
      )
      expect(produced).toHaveLength(5000)
      expect(yields.mock.calls.length).toBeGreaterThanOrEqual(5)
    } finally {
      yields.mockRestore()
    }
  })

  // The report line is printed verbatim, and `cStringPath` decodes the
  // `\033` strace wrote: a file named `ESC ]0;…` retitled the terminal.
  it('writes a control byte of a denied path as \\xNN in the line, raw in the target', async () => {
    const ws = path.join(dir, 'ws')
    const produced = await produce(
      String.raw`1 openat(AT_FDCWD, "${ws}/x\033]0;t\007\ry", 0) = -1 ENOENT (x)`,
    )
    expect(produced.map((v) => [v.line, v.target])).toEqual([
      [
        `openat(${ws}/x\\x1b]0;t\\x07\\x0dy) = -1 ENOENT  [${ws}/x\\x1b]0;t\\x07\\x0dy]`,
        `${ws}/x\x1b]0;t\x07\ry`,
      ],
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

  // A write grant permits the same as a read grant here: a miss under it is
  // the task's output not made yet (X-63). A sibling sharing its name
  // prefix is still reported.
  it('skips a miss under a write grant, and reports a sibling sharing its name prefix', async () => {
    const ws = path.join(dir, 'ws')
    await mkdir(path.join(ws, 'dist'), { recursive: true })
    const log = path.join(dir, 'trace.log')
    await writeFile(log, [at(`${ws}/dist/out.txt`), at(`${ws}/distx/y.ts`)].join('\n'))
    const produced = await parseStraceViolations(
      log,
      {
        command: 'x',
        cwd: ws,
        env: {},
        config: resolveSandboxConfig({ allow: { write: ['dist/'] } }, ws),
      } as never,
      { allowRead: [], denyRead: [ws], cwd: ws },
    )
    expect(produced.map((v) => v.target)).toEqual([`${ws}/distx/y.ts`])
  })

  // …but one the Linux sandbox mounts no bind for permits nothing, as an
  // unmountable read grant does: a miss under it is the refused write.
  it.skipIf(process.platform !== 'linux')(
    'a miss under a write grant the sandbox could not mount is reported',
    async () => {
      const ws = path.join(dir, 'ws')
      await mkdir(ws, { recursive: true })
      const log = path.join(dir, 'trace.log')
      const grant = `${ws}/out*dir`
      await writeFile(log, at(`${grant}/x`))
      const produced = await parseStraceViolations(
        log,
        { command: 'x', cwd: ws, env: {}, config: { allowRead: [], allowWrite: [grant] } } as never,
        { allowRead: [], denyRead: [ws], cwd: ws },
      )
      expect(produced.map((v) => v.target)).toEqual([`${grant}/x`])
    },
  )

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

  it('names the writes refused past the wall, and neither the reads nor the pseudo-files', () => {
    const cache = path.join(ROOT, '..', 'home', '.bun', 'install', 'cache')
    const tmp = path.join(ROOT, '..', 'task-tmp')
    const cfg = resolveSandboxConfig({ ignore: { write: [`${ROOT}/ignored/*`] } }, PROJ)
    const outside = refusedWritesOutside(
      [
        mac('file-write-create', `${cache}/bun-darwin-x64-v1`),
        mac('file-write-create', `${cache}/bun-darwin-x64-v1`),
        mac('file-read-data', '/etc/passwd'),
        linux(path.join(ROOT, 'packages', 'secret', 'token.txt')),
        mac('file-write-data', '/dev/dtracehelper'),
        mac('file-write-create', `${PROJ}/.x.tmp`),
        mac('file-write-create', `${ROOT}/ignored/a`),
        ...refusedWrites(
          [`deny openat ${cache}/linux`, `deny openat ${tmp}/t`, 'deny write /proc/self/fd/0'],
          [],
        ),
      ],
      { within: PROJ, config: cfg, skip: [tmp] },
    )
    expect(outside).toEqual([`${cache}/bun-darwin-x64-v1`, `${cache}/linux`])
  })

  it('names the directory mkdir -p was refused, not the ones it walked through', () => {
    // `mkdir -p ~/.cache/tool` is refused at every directory on its way,
    // existing ones too, so the note listed `/root` first and its grant
    // spelled the parent of `/root`: `allow: { write: ['//'] }`.
    const home = path.join(ROOT, '..', 'home')
    const outside = refusedWritesOutside(
      refusedWrites(
        [`deny mkdir ${home}`, `deny mkdir ${home}/.cache`, `deny mkdir ${home}/.cache/tool`],
        [],
      ),
      { within: PROJ, config: resolveSandboxConfig({}, PROJ), skip: [] },
    )
    expect(outside).toEqual([`${home}/.cache/tool`])
  })

  it('a write under a scratch glob, or in a directory it matches, is granted', () => {
    const records = [
      `deny mkdirat ${PROJ}/.a.tmp`,
      `deny openat ${PROJ}/.a.tmp/bun`,
      `deny openat ${PROJ}/other.tmp.txt`,
    ]
    expect(lines(refusedWrites(records, [], [`${PROJ}/.*.tmp`]))).toEqual([
      `openat(${PROJ}/other.tmp.txt) = a write no grant covers  [${PROJ}/other.tmp.txt]`,
    ])
    // CONTROL: with no scratch glob all three are refused.
    expect(refusedWrites(records, []).length).toBe(3)
  })

  it('a pending write glob is scratch only where no bind holds its directory', () => {
    const glob = `${PROJ}/.*.tmp`
    const split = (fs: { allowRead?: string[]; allowWrite?: string[] }, anchors: string[]) =>
      scratchWrites([glob], fs, anchors)
    // `read: ['.']` punched around `dist/`: the project dir is scratch.
    expect(split({ allowRead: [`${PROJ}/src`], allowWrite: [`${PROJ}/dist`] }, [ROOT])).toEqual({
      scratch: [glob],
      mountless: [],
    })
    // `read: ['.']` whole: the directory is mounted read-only.
    expect(split({ allowRead: [PROJ] }, [ROOT])).toEqual({ scratch: [], mountless: [glob] })
    // Outside every deny anchor: the host's root, read-only.
    expect(split({}, [path.join(ROOT, 'elsewhere')])).toEqual({ scratch: [], mountless: [glob] })
  })

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

  // B-2: both producers record the path where it LANDS, and `ignore` was
  // anchored at the project directory as given. Under a workspace reached
  // through a link (macOS's `/var` is `/private/var`) no relative pattern
  // matched, and the denial it names failed the task.
  it('matches an `ignore` pattern where the project lands through a link', async () => {
    const d = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-ignore-link-')))
    try {
      await mkdir(path.join(d, 'proj', 'gen'), { recursive: true })
      await symlink(path.join(d, 'proj'), path.join(d, 'alias'))
      const alias = path.join(d, 'alias')
      const produced = ['s.txt', 'gen/a.ts', 'abs.txt', 'kept.txt'].map((f) =>
        linux(`${d}/proj/${f}`),
      )
      const cfg = resolveSandboxConfig(
        { ignore: { read: ['s.txt', 'gen/*.ts', `${alias}/abs.txt`] } },
        alias,
      )
      expect(lines(reportableViolations(produced, { within: alias, config: cfg }))).toEqual([
        `openat(x) = -1 ENOENT  [${d}/proj/kept.txt]`,
      ])
    } finally {
      await rm(d, { recursive: true, force: true })
    }
  })

  // The row above's seatbelt twin: the report judges a seatbelt record by
  // `path`, where it lands, and `ignore` judged it by `target`, the path as
  // logged. A record named through a link was reported inside the project
  // and no pattern for it matched, so the denial `ignore` names failed the
  // task.
  it('matches an `ignore` pattern against where a seatbelt record lands', async () => {
    const d = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-ignore-mac-')))
    try {
      await mkdir(path.join(d, 'proj'))
      await symlink(path.join(d, 'proj'), path.join(d, 'alias'))
      const alias = path.join(d, 'alias')
      const recorded = [
        mac('file-write-create', `${alias}/a.bun-build`),
        mac('file-read-data', `${alias}/gen/x.ts`),
        mac('file-read-data', `${alias}/kept.ts`),
        mac('network-outbound', 'example.com:443'),
      ]
      const cfg = resolveSandboxConfig(
        {
          ignore: {
            write: ['*.bun-build'],
            read: ['gen/**'],
            network: ['example.com:443'],
          },
        },
        alias,
      )
      expect(lines(reportableViolations(recorded, { within: alias, config: cfg }))).toEqual([
        `bun(1) deny(1) file-read-data ${alias}/kept.ts`,
      ])
      // CONTROL: each list still silences only its own operation.
      const swapped = resolveSandboxConfig(
        { ignore: { read: ['*.bun-build'], write: ['gen/**'] } },
        alias,
      )
      expect(lines(reportableViolations(recorded, { within: alias, config: swapped }))).toEqual(
        recorded.map((v) => v.line),
      )
    } finally {
      await rm(d, { recursive: true, force: true })
    }
  })

  // A `~` pattern was kept as written and matched no target: every producer
  // records an absolute path, so `ignore: { read: ['~/.cache/*'] }`
  // silenced nothing (sweep of B-11, `ign-tilde`).
  it('matches an `ignore` pattern under `~`', () => {
    // Nothing is created: `os.homedir()` is read once per process, so the
    // row names paths under the real home that no one has.
    const home = realpathSync(os.homedir())
    const cfg = resolveSandboxConfig({ ignore: { read: ['~/.vx-ignore-probe/*'] } }, home)
    const produced = [linux(`${home}/.vx-ignore-probe/x`), linux(`${home}/.vx-ignore-kept`)]
    expect(lines(reportableViolations(produced, { within: home, config: cfg }))).toEqual([
      `openat(x) = -1 ENOENT  [${home}/.vx-ignore-kept]`,
    ])
  })
})

// Seatbelt's SRT compiles a grant holding `[` as a regex in which a
// backslash is a literal one, so the escaped spelling of a Next.js route
// matched no file. vx hands it `[[]`, a class of one bracket (B-65).
describe.skipIf(process.platform !== 'darwin')('a bracketed route under seatbelt', () => {
  it(
    'is granted by its escaped name, and not by the class spelling',
    async () => {
      if (!(await sandboxAvailable('bracketed route under seatbelt'))) return
      await initSandbox()
      const dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-brk-')))
      try {
        const proj = path.join(dir, 'app')
        await mkdir(path.join(proj, 'pages'), { recursive: true })
        const route = path.join(proj, 'pages', '[id].tsx')
        await writeFile(route, 'route')
        const run = (read: string) =>
          runSandboxed({
            command: `/bin/cat '${route}'`,
            cwd: proj,
            env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
            baseAllowRead: [],
            baseDenyRead: [dir],
            reportWithin: proj,
            reportLinked: [],
            config: resolveSandboxConfig({ allow: { read: [read] } }, proj),
          })
        const escaped = await run('pages/\\[id\\].tsx')
        // CONTROL: `[id]` is a class (`i` or `d`), which names no such file.
        const classed = await run('pages/[id].tsx')
        expect([escaped.stdout, classed.stdout, classed.exitCode === 0]).toEqual([
          'route',
          '',
          false,
        ])
      } finally {
        await resetSandbox()
        await rm(dir, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  // An exact regex grants a directory's entry alone; Linux binds it whole.
  it(
    'grants an escaped directory with its files',
    async () => {
      if (!(await sandboxAvailable('bracketed directory under seatbelt'))) return
      await initSandbox()
      const dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-brk-')))
      try {
        const proj = path.join(dir, 'app')
        await mkdir(path.join(proj, 'out', '[id]'), { recursive: true })
        const page = path.join(proj, 'out', '[id]', 'page.html')
        await writeFile(page, 'page')
        const r = await runSandboxed({
          command: `/bin/cat '${page}'`,
          cwd: proj,
          env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
          baseAllowRead: [],
          baseDenyRead: [dir],
          reportWithin: proj,
          reportLinked: [],
          config: resolveSandboxConfig({ allow: { read: ['out/\\[id\\]'] } }, proj),
        })
        expect(r.stdout).toBe('page')
      } finally {
        await resetSandbox()
        await rm(dir, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

// Release-assets' darwin upload granted `systemInfo: ['hw.optional.neon']`
// and still died on `deny(1) sysctl-read hw.optional.neon`: the grant wrote
// only a `system-info` rule, and Bun reads it as a sysctl.
describe.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
  'a systemInfo grant under seatbelt',
  () => {
    it(
      'lets the task sysctl-read the name it grants',
      async () => {
        if (!(await sandboxAvailable('systemInfo grant under seatbelt'))) return
        await initSandbox()
        const dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-sysctl-')))
        try {
          const run = (systemInfo: string[]) =>
            runSandboxed({
              // sysctlbyname(3), the call Bun makes, as its raw syscall
              // (274). /usr/sbin/sysctl exited 1 under the grant on macOS
              // CI, with no stderr kept to say why.
              command: `/usr/bin/perl -e '$n="hw.optional.neon";$v=pack("L",0);$l=pack("Q",4);exit 1 if syscall(274,$n,length($n),$v,$l,0,0);print unpack("L",$v)'`,
              cwd: dir,
              env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
              baseAllowRead: [],
              baseDenyRead: [],
              reportWithin: dir,
              reportLinked: [],
              config: resolveSandboxConfig({ allow: { read: ['.'], systemInfo } }, dir),
            })
          const granted = await run(['hw.optional.neon'])
          // CONTROL: without the grant the read is refused.
          const bare = await run([])
          expect({
            out: granted.stdout.trim(),
            code: granted.exitCode,
            err: granted.exitCode === 0 ? '' : granted.stderr,
            bareOk: bare.exitCode === 0,
          }).toEqual({ out: '1', code: 0, err: '', bareOk: false })
        } finally {
          await resetSandbox()
          await rm(dir, { recursive: true, force: true })
        }
      },
      TIMEOUT,
    )
  },
)

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
                  inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
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
            path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts'),
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

  // cli.md said a missing runtime stops the run before any task; the runtime
  // arms when a sandboxed task executes, and that task fails alone (J2-60).
  it.skipIf(process.platform !== 'linux')(
    'no sandbox runtime: the sandboxed task fails alone, and cli.md says so',
    async () => {
      const root = await makeWorkspaceRoot({ prefix: 'vx-sandbox-alone-' })
      const bin = await mkdtemp(path.join(os.tmpdir(), 'vx-no-srt-bin-'))
      try {
        await addProject(root, 'app', {
          config: `
            export default {
              tasks: {
                plain: { exec: { command: 'echo PLAIN-RAN' } },
                boxed: { exec: { command: 'echo BOXED-RAN', sandbox: {} } },
              },
            }
          `,
        })
        await symlink(process.execPath, path.join(bin, 'bun'))
        for (const name of ['sh', 'git']) await symlink(Bun.which(name)!, path.join(bin, name))
        const p = Bun.spawnSync({
          cmd: [
            process.execPath,
            path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts'),
            'run',
            'plain',
            'boxed',
            '--all',
          ],
          cwd: root,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, NO_COLOR: '1', CI: '', PATH: bin },
        })
        const text = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr)
        expect(p.exitCode).toBe(1)
        expect(text).toMatch(/success no-cache .* app#plain/)
        expect(text).toMatch(/failed  no-cache .* app#boxed/)
        expect(text.split('\n')).not.toContain('BOXED-RAN')
        expect(text).toContain('[vx] app#boxed: sandbox not available: ')
        const doc = await readFile(path.resolve(import.meta.dir, '..', 'docs', 'cli.md'), 'utf8')
        const section = doc.slice(doc.indexOf('\n## Sandbox\n'), doc.indexOf('\n## `vx watch`\n'))
        expect(section).not.toContain('before\nany task runs')
        expect(section.replace(/\s+/g, ' ')).toContain(
          'that task fails with one line, `sandbox not available: <reason>`',
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
                  inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
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
              path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts'),
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
                  inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
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
            path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts'),
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
