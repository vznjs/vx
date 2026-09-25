// Three places a run's own writes outran what the run knew (the edges item
// 743 left). A key is built from facts learned once per run, and each of
// these writes contradicted one of them without dropping it:
//   - a CACHED task rewriting its own input in place (a formatter with no
//     outputs) ahead of a same-project reader whose key does not fold it;
//   - a cached task that ran but did not save (a read-only cache policy)
//     writing its declared outputs, which only a save marked in the git
//     snapshot;
//   - a task in the root project rewriting the lockfile the workspace
//     fingerprint folded (`pnpm install` without `--frozen-lockfile`).
// Every row but the controls failed on the tree before the fix.

import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { CachePolicy } from '../src/cache/index.js'
import type { TaskNode } from '../src/graph/index.js'
import type { Logger, RunSummary } from '../src/orchestrator/index.js'
import { prepareRun, run } from '../src/orchestrator/index.js'
import { FingerprintWatch } from '../src/orchestrator/fingerprint-watch.js'
import { startLocalShortCircuit } from '../src/orchestrator/local-shortcircuit.js'
import { computeWorkspaceFingerprints } from '../src/workspace/index.js'
import {
  commandWriteReach,
  mayWriteFingerprint,
  undeclaredWriteReach,
} from '../src/orchestrator/sandbox-request.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const TIMEOUT = 30_000
const READ_ONLY: CachePolicy = {
  localRead: true,
  localWrite: false,
  remoteRead: true,
  remoteWrite: false,
}

let root: string
let status: string[]

const logger: Logger = {
  status: (line) => status.push(line),
  taskStdout: () => {},
  taskStderr: () => {},
  taskComplete: () => {},
}

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-inrun-' })
  status = []
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function commit(): void {
  gitIn(root)('add', '-A')
  gitIn(root)('commit', '-q', '-m', 'fixture')
}

async function runTask(task: string | string[], cache?: CachePolicy): Promise<RunSummary> {
  status = []
  const tasks = typeof task === 'string' ? [task] : task
  const r = await run({ cwd: root, tasks, log: logger, ...(cache ? { cache } : {}) })
  expect(r.ok).toBe(true)
  return r
}

const statusOf = (r: RunSummary, id: string): string | undefined =>
  r.outcomes.find((o) => o.node.id === id)?.status

// `fmt` rewrites `a.ts` (its own input) from `seed.txt`; `build` reads
// `a.ts` after it, folding no upstream key.
const FORMATTER = `
  export default {
    tasks: {
      fmt: {
        exec: { command: 'cp seed.txt a.ts' },
        cache: { inputs: { files: ['seed.txt', 'a.ts'] }, outputs: { files: [] } },
      },
      build: {
        dependsOn: ['fmt'],
        exec: { command: 'mkdir -p dist && cat a.ts > dist/out.txt' },
        cache: { inputs: { files: ['a.ts'], tasks: [] }, outputs: { files: ['dist/**'] } },
      },
    },
  }
`

describe('a cached task that rewrites its own input', () => {
  async function fixture(config = FORMATTER): Promise<string> {
    const app = await addProject(root, 'app', { config, files: { 'a.ts': 'X' } })
    await writeFile(path.join(root, '.gitignore'), '.vx/\ndist/\n')
    commit()
    return app
  }

  it(
    'seeds A, B, B, A build A, B, B, A: its reader is not restored ahead of it',
    async () => {
      const app = await fixture()
      const outs: string[] = []
      for (const seed of ['A', 'B', 'B', 'A']) {
        await writeFile(path.join(app, 'seed.txt'), seed)
        await runTask('build')
        outs.push(await readFile(path.join(app, 'dist', 'out.txt'), 'utf8'))
      }
      // Before the fix `build` was classed stable, keyed on `a.ts` = B before
      // `fmt` wrote A, and the fourth run restored the third run's B.
      expect(outs).toEqual(['A', 'B', 'B', 'A'])
    },
    TIMEOUT,
  )

  it(
    'under a read-only cache policy the rewrite still drops what the run knew of the project',
    async () => {
      // The first run formats nothing (seed = the committed `X`) and saves
      // both. The second, read-only, rewrites `a.ts`: no save, so no re-check
      // ran and the snapshot kept `a.ts`'s committed OID — `build`'s key was
      // the first run's, and it restored X.
      const app = await fixture()
      await writeFile(path.join(app, 'seed.txt'), 'X')
      await runTask('build')
      await writeFile(path.join(app, 'seed.txt'), 'A')
      const r = await runTask('build', READ_ONLY)
      expect(statusOf(r, 'app#build')).toBe('success')
      expect(await readFile(path.join(app, 'dist', 'out.txt'), 'utf8')).toBe('A')
    },
    TIMEOUT,
  )
})

describe('a cached task that runs but does not save', () => {
  it(
    'under a read-only cache policy, marks the outputs it wrote for a same-run reader',
    async () => {
      const app = await addProject(root, 'app', {
        config: `
          export default {
            tasks: {
              gen: {
                exec: { command: 'cp seed.txt gen.txt' },
                cache: { inputs: { files: ['seed.txt'] }, outputs: { files: ['gen.txt'] } },
              },
              build: {
                dependsOn: ['gen'],
                exec: { command: 'mkdir -p dist && cat gen.txt > dist/out.txt' },
                cache: { inputs: { files: ['gen.txt'], tasks: [] }, outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
        files: { 'gen.txt': 'X', 'seed.txt': 'X' },
      })
      await writeFile(path.join(root, '.gitignore'), '.vx/\ndist/\n')
      commit()
      await runTask('build')
      await writeFile(path.join(app, 'seed.txt'), 'B')
      // Before the fix: `gen.txt` kept its committed OID in the snapshot and
      // `build` restored the first run's X.
      const r = await runTask('build', READ_ONLY)
      expect(statusOf(r, 'app#build')).toBe('success')
      expect(await readFile(path.join(app, 'dist', 'out.txt'), 'utf8')).toBe('B')
    },
    TIMEOUT,
  )

  it(
    'control: a read-only run that moves nothing restores from the cache',
    async () => {
      await addProject(root, 'app', {
        config: `
          export default {
            tasks: {
              gen: {
                exec: { command: 'printf G > gen.txt' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['gen.txt'] } },
              },
              build: {
                dependsOn: ['gen'],
                exec: { command: 'mkdir -p dist && cat gen.txt > dist/out.txt' },
                cache: { inputs: { files: ['gen.txt'], tasks: [] }, outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
        files: { 'src/a.txt': 'a' },
      })
      await writeFile(path.join(root, '.gitignore'), '.vx/\ndist/\n')
      commit()
      await runTask('build')
      const r = await runTask('build', READ_ONLY)
      expect(statusOf(r, 'app#gen')).toBe('cache-hit')
      expect(statusOf(r, 'app#build')).toBe('cache-hit')
    },
    TIMEOUT,
  )
})

describe('a task that rewrites the lockfile the workspace fingerprint folded', () => {
  // The root is a project (`.` in the workspace globs) whose `install`
  // stands in for `pnpm install` without `--frozen-lockfile`: it rewrites
  // `pnpm-lock.yaml` and the installed tree. `app#build` reads the installed
  // tree, which no key names but the lockfile's digest stands for.
  const INSTALL =
    'cp seed.txt pnpm-lock.yaml && mkdir -p node_modules && cp seed.txt node_modules/.dep'

  async function fixture(install = `{ exec: { command: '${INSTALL}' } }`): Promise<string> {
    await writeFile(
      path.join(root, 'pnpm-workspace.yaml'),
      'packages:\n  - "."\n  - "packages/*"\n',
    )
    await writeFile(
      path.join(root, 'vx.config.mjs'),
      `export default { tasks: { install: ${install} } }`,
    )
    await writeFile(path.join(root, 'pnpm-lock.yaml'), 'X')
    const app = await addProject(root, 'app', {
      config: `
        export default {
          tasks: {
            build: {
              dependsOn: ['fixture-root#install'],
              exec: { command: 'mkdir -p dist && cat ../../node_modules/.dep > dist/out.txt' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
            },
            pack: {
              dependsOn: ['fixture-root#install'],
              exec: { command: 'mkdir -p pkg && cat ../../node_modules/.dep > pkg/out.txt' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: ['pkg/**'] } },
            },
          },
        }
      `,
      files: { 'src/a.ts': 'a' },
    })
    await writeFile(path.join(root, '.gitignore'), '.vx/\ndist/\npkg/\nnode_modules/\nseed.txt\n')
    commit()
    return app
  }

  /** Seed after seed, what `app#build` built against the install each run did. */
  async function builds(app: string, seeds: string[]): Promise<string[]> {
    const outs: string[] = []
    for (const seed of seeds) {
      await writeFile(path.join(root, 'seed.txt'), seed)
      await runTask('app#build')
      outs.push(await readFile(path.join(app, 'dist', 'out.txt'), 'utf8'))
    }
    return outs
  }

  it(
    'seeds A, B, B, A, A build A, B, B, A, A: no entry is saved or restored under the old lockfile',
    async () => {
      const app = await fixture()
      // Before the fix: B, B for the last two. The fourth run restored the
      // third's entry up front (keyed on lockfile B, installed A), and the
      // fifth hit what the second run saved under lockfile A: bytes built
      // against B, a stale hit on every later run in that state.
      expect(await builds(app, ['A', 'B', 'B', 'A', 'A'])).toEqual(['A', 'B', 'B', 'A', 'A'])
    },
    TIMEOUT,
  )

  it(
    'a persistent root task that rewrites it before it is ready, the same',
    async () => {
      const app = await fixture(
        `{ exec: { command: '${INSTALL} && echo ready && exec sleep 30', persistent: { readyWhen: 'ready' } } }`,
      )
      expect(await builds(app, ['A', 'B', 'B', 'A', 'A'])).toEqual(['A', 'B', 'B', 'A', 'A'])
    },
    TIMEOUT,
  )

  it(
    'says once which file moved, and a run that rewrites it to the same bytes saves',
    async () => {
      const app = await fixture()
      await writeFile(path.join(root, 'seed.txt'), 'A')
      await runTask(['app#build', 'app#pack'])
      expect(status.filter((l) => l.includes('pnpm-lock.yaml'))).toEqual([
        '[vx] a task rewrote `pnpm-lock.yaml` during the run, which every key folds (the workspace fingerprint): nothing keyed before it is restored or saved from here on',
      ])
      await runTask('app#build')
      expect(status.filter((l) => l.includes('pnpm-lock.yaml'))).toEqual([])
      const r = await runTask('app#build')
      expect(statusOf(r, 'app#build')).toBe('cache-hit')
      expect(await readFile(path.join(app, 'dist', 'out.txt'), 'utf8')).toBe('A')
    },
    TIMEOUT,
  )
})

describe('the contract for `inputs.runtime`: an answer about the environment, taken once', () => {
  it(
    'is asked once per run, before any task, and a task that changes it is not seen by that run',
    async () => {
      // `bump` (uncached) changes what `build`'s runtime command answers,
      // and `build` folds no key of it. The answer is not asked again before
      // the save, as input files are re-checked: the entry built against 2
      // is filed under 1, and a run that starts from 1 hits it. Declaring
      // `ver.txt` as an input is how a task says it reads another's output.
      const app = await addProject(root, 'app', {
        config: `
          export default {
            tasks: {
              bump: { exec: { command: 'cp next.txt ver.txt' } },
              build: {
                dependsOn: ['bump'],
                exec: { command: 'mkdir -p dist && cat ver.txt > dist/out.txt' },
                cache: {
                  inputs: {
                    files: ['src/**'],
                    runtime: ['echo x >> ../../spawns.log; cat ver.txt'],
                    tasks: [],
                  },
                  outputs: { files: ['dist/**'] },
                },
              },
            },
          }
        `,
        files: { 'src/a.ts': 'a', 'ver.txt': '1', 'next.txt': '2' },
      })
      await writeFile(path.join(root, '.gitignore'), '.vx/\ndist/\nspawns.log\n')
      commit()
      await runTask('build')
      expect(await readFile(path.join(root, 'spawns.log'), 'utf8')).toBe('x\n')
      expect(await readFile(path.join(app, 'dist', 'out.txt'), 'utf8')).toBe('2')
      await writeFile(path.join(app, 'ver.txt'), '1')
      await writeFile(path.join(app, 'next.txt'), '1')
      const r = await runTask('build')
      expect(statusOf(r, 'app#build')).toBe('cache-hit')
      expect(await readFile(path.join(app, 'dist', 'out.txt'), 'utf8')).toBe('2')
    },
    TIMEOUT,
  )
})

describe('the stability gate: which readers are keyed before a rewriter ran', () => {
  /** Commit the fixture and classify it as run() does: is `id` probed up front? */
  async function upFront(task: string, id: string): Promise<boolean> {
    commit()
    const prepared = await prepareRun({ cwd: root, tasks: [task], log: logger }, logger)
    try {
      const sc = await startLocalShortCircuit({
        nodes: prepared.nodes,
        cache: prepared.cache,
        workspaceRoot: prepared.workspaceRoot,
        workspaceFingerprint: prepared.workspaceFingerprint,
        nestedDirsByProject: prepared.nestedDirsByProject,
        gitFilesCache: prepared.gitFilesCache,
        hashCache: prepared.hashCache,
        concurrency: 4,
      })
      return sc.preProbed.has(id)
    } finally {
      prepared.cache.close()
    }
  }

  const FMT = `{
    exec: { command: 'true' },
    cache: { inputs: { files: ['a.ts'] }, outputs: { files: [] } },
  }`
  const reader = (dependsOn: string, tasks?: string) => `{
    dependsOn: ['${dependsOn}'],
    exec: { command: 'true' },
    cache: {
      inputs: { files: ['a.ts']${tasks === undefined ? '' : `, tasks: ${tasks}`} },
      outputs: { files: [] },
    },
  }`

  /** `app#fmt` (cached, may rewrite `a.ts`) → `between`, if any → `app#build`, folding `tasks`. */
  async function sameProject(between: string | null, tasks?: string): Promise<boolean> {
    await addProject(root, 'app', {
      config: `
        export default {
          tasks: {
            fmt: ${FMT},
            ${between === null ? '' : `pre: ${between},`}
            build: ${reader(between === null ? 'fmt' : 'pre', tasks)},
          },
        }
      `,
      files: { 'a.ts': 'x' },
    })
    return upFront('build', 'app#build')
  }

  const fresh = () => rm(path.join(root, 'packages'), { recursive: true, force: true })

  it(
    'a reader folding no key of the rewriter is not; one folding its key is',
    async () => {
      expect(await sameProject(null, '[]')).toBe(false)
      await fresh()
      expect(await sameProject(null)).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'through a group: folding the group folds the rewriter, and folding nothing does not',
    async () => {
      const group = `{ dependsOn: ['fmt'] }`
      expect(await sameProject(group, '[]')).toBe(false)
      await fresh()
      expect(await sameProject(group, "['pre']")).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'through a task that folds the rewriter and writes nothing: only a reader folding it is covered',
    async () => {
      // `pre` is sandboxed with no write grant, so it rewrites nothing itself.
      const pre = `{
        dependsOn: ['fmt'],
        exec: { command: 'true', sandbox: { allow: { read: ['.'] } } },
        cache: { inputs: { files: ['a.ts'] }, outputs: { files: [] } },
      }`
      expect(await sameProject(pre, '[]')).toBe(false)
      await fresh()
      expect(await sameProject(pre, "['pre']")).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'through a task that folds no key of the rewriter: folding that task covers nothing',
    async () => {
      const pre = `{
        dependsOn: ['fmt'],
        exec: { command: 'true', sandbox: { allow: { read: ['.'] } } },
        cache: { inputs: { files: ['a.ts'], tasks: [] }, outputs: { files: [] } },
      }`
      expect(await sameProject(pre, "['pre']")).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'through a persistent task, which has no key to fold, with no `tasks` filter anywhere',
    async () => {
      // Sandboxed with no write grant, so it is no producer itself.
      const srv = `{
        dependsOn: ['fmt'],
        exec: { command: 'true', persistent: {}, sandbox: { allow: { read: ['.'] } } },
      }`
      expect(await sameProject(srv)).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'the same across projects, where that task is itself stable: its fold carries the rewriter',
    async () => {
      // `lib#pre` reads nothing of `app`, so no rewriter there makes it
      // unstable, and `app#build` inherits nothing from it.
      await addProject(root, 'lib', {
        config: `
          export default {
            tasks: {
              pre: {
                dependsOn: ['app#fmt'],
                exec: { command: 'true', sandbox: { allow: { read: ['.'] } } },
                cache: { inputs: { files: ['package.json'], tasks: [] }, outputs: { files: [] } },
              },
            },
          }
        `,
      })
      await addProject(root, 'app', {
        config: `
          export default {
            tasks: {
              fmt: ${FMT},
              build: ${reader('lib#pre', "['lib#pre']")},
            },
          }
        `,
        files: { 'a.ts': 'x' },
      })
      commit()
      const prepared = await prepareRun({ cwd: root, tasks: ['app#build'], log: logger }, logger)
      try {
        const sc = await startLocalShortCircuit({
          nodes: prepared.nodes,
          cache: prepared.cache,
          workspaceRoot: prepared.workspaceRoot,
          workspaceFingerprint: prepared.workspaceFingerprint,
          nestedDirsByProject: prepared.nestedDirsByProject,
          gitFilesCache: prepared.gitFilesCache,
          hashCache: prepared.hashCache,
          concurrency: 4,
        })
        expect([...sc.preProbed.keys()].sort()).toEqual(['app#fmt', 'lib#pre'])
      } finally {
        prepared.cache.close()
      }
    },
    TIMEOUT,
  )

  it(
    'control: a sandboxed rewriter with no write grant leaves even a `tasks: []` reader stable',
    async () => {
      await addProject(root, 'app', {
        config: `
          export default {
            tasks: {
              fmt: {
                exec: { command: 'true', sandbox: { allow: { read: ['.'] } } },
                cache: { inputs: { files: ['a.ts'] }, outputs: { files: [] } },
              },
              build: ${reader('fmt', '[]')},
            },
          }
        `,
        files: { 'a.ts': 'x' },
      })
      expect(await upFront('build', 'app#build')).toBe(true)
    },
    TIMEOUT,
  )

  it(
    "a cached rewriter granted a write in another project: that project's non-folding reader is not",
    async () => {
      const crossProject = async (tasks?: string): Promise<boolean> => {
        await addProject(root, 'lib', {
          config: `
            export default {
              tasks: {
                gen: {
                  exec: { command: 'true', sandbox: { allow: { read: ['.'], write: ['../app/gen/**'] } } },
                  cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } },
                },
              },
            }
          `,
        })
        await addProject(root, 'app', {
          deps: { lib: 'workspace:*' },
          config: `export default { tasks: { build: ${reader('^gen', tasks)} } }`,
          files: { 'a.ts': 'x' },
        })
        return upFront('build', 'app#build')
      }
      expect(await crossProject('[]')).toBe(false)
      await fresh()
      expect(await crossProject()).toBe(true)
    },
    TIMEOUT,
  )

  /** A root-project `install` upstream of `app#build`, folding `tasks`. */
  async function underRoot(install: string, tasks?: string): Promise<boolean> {
    await writeFile(
      path.join(root, 'pnpm-workspace.yaml'),
      'packages:\n  - "."\n  - "packages/*"\n',
    )
    await writeFile(
      path.join(root, 'vx.config.mjs'),
      `export default { tasks: { install: ${install} } }`,
    )
    await addProject(root, 'app', {
      config: `export default { tasks: { build: ${reader('fixture-root#install', tasks)} } }`,
      files: { 'a.ts': 'x' },
    })
    return upFront('app#build', 'app#build')
  }

  it(
    'an uncached root task may rewrite the lockfile: a reader after it is not, folding or not',
    async () => {
      expect(await underRoot(`{ exec: { command: 'true' } }`)).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'a cached root task: a reader folding its key is, one folding none is not',
    async () => {
      const install = `{
        exec: { command: 'true' },
        cache: { inputs: { files: ['pnpm-lock.yaml'] }, outputs: { files: [] } },
      }`
      await writeFile(path.join(root, 'pnpm-lock.yaml'), 'X')
      expect(await underRoot(install, '[]')).toBe(false)
      await fresh()
      expect(await underRoot(install)).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'a cached root task behind a task that folds no key of it: folding that task covers nothing',
    async () => {
      await writeFile(
        path.join(root, 'pnpm-workspace.yaml'),
        'packages:\n  - "."\n  - "packages/*"\n',
      )
      await writeFile(path.join(root, 'pnpm-lock.yaml'), 'X')
      await writeFile(
        path.join(root, 'vx.config.mjs'),
        `
          export default {
            tasks: {
              install: {
                exec: { command: 'true' },
                cache: { inputs: { files: ['pnpm-lock.yaml'] }, outputs: { files: [] } },
              },
            },
          }
        `,
      )
      await addProject(root, 'app', {
        config: `
          export default {
            tasks: {
              pre: {
                dependsOn: ['fixture-root#install'],
                exec: { command: 'true', sandbox: { allow: { read: ['.'] } } },
                cache: { inputs: { files: ['a.ts'], tasks: [] }, outputs: { files: [] } },
              },
              build: ${reader('pre', "['pre']")},
            },
          }
        `,
        files: { 'a.ts': 'x' },
      })
      expect(await upFront('app#build', 'app#build')).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'control: a root task sandboxed with no write grant leaves its readers stable',
    async () => {
      const install = `{ exec: { command: 'true', sandbox: { allow: { read: ['.'] } } } }`
      expect(await underRoot(install)).toBe(true)
    },
    TIMEOUT,
  )
})

describe('commandWriteReach and mayWriteFingerprint — where a command may write', () => {
  const ws = '/ws'
  const node = (config: Record<string, unknown>, projectDir = '/ws/packages/app'): TaskNode =>
    ({ id: 'app#t', projectName: 'app', projectDir, config }) as unknown as TaskNode
  const cached = { inputs: {}, outputs: { files: [] } }
  const sandboxed = (write?: string[], projectDir?: string) =>
    node(
      {
        exec: {
          command: 'x',
          sandbox: { allow: write === undefined ? { read: ['.'] } : { read: ['.'], write } },
        },
        cache: cached,
      },
      projectDir,
    )

  it('a cached task reaches what an uncached one does; a group nothing', () => {
    expect(commandWriteReach(node({ exec: { command: 'x' }, cache: cached }), ws)).toBe('project')
    expect(commandWriteReach(sandboxed(), ws)).toBe('none')
    expect(commandWriteReach(sandboxed(['dist/**']), ws)).toBe('project')
    expect(commandWriteReach(sandboxed(['../lib/gen/**']), ws)).toBe('workspace')
    expect(commandWriteReach(node({}), ws)).toBe('none')
    // What item 743's forget reads is unchanged: a cached task is held to its outputs.
    expect(undeclaredWriteReach(node({ exec: { command: 'x' }, cache: cached }), ws)).toBe('none')
  })

  it('the fingerprinted files sit at the root: only the root project, or a grant over one', () => {
    expect(mayWriteFingerprint(node({ exec: { command: 'x' } }, ws), ws)).toBe(true)
    expect(mayWriteFingerprint(node({ exec: { command: 'x' } }), ws)).toBe(false)
    expect(mayWriteFingerprint(node({}, ws), ws)).toBe(false)
    expect(mayWriteFingerprint(sandboxed(undefined, ws), ws)).toBe(false)
    expect(mayWriteFingerprint(sandboxed(['dist/**'], ws), ws)).toBe(false)
    expect(mayWriteFingerprint(sandboxed(['pnpm-lock.yaml'], ws), ws)).toBe(true)
    expect(mayWriteFingerprint(sandboxed(['../../bun.lock']), ws)).toBe(true)
    expect(mayWriteFingerprint(sandboxed(['../../**']), ws)).toBe(true)
    expect(mayWriteFingerprint(sandboxed(['../../packages/**']), ws)).toBe(false)
  })
})

describe('FingerprintWatch — which fingerprinted files moved since the run read them', () => {
  async function watching(): Promise<FingerprintWatch> {
    await writeFile(path.join(root, 'pnpm-lock.yaml'), 'X')
    const at = Date.now()
    return new FingerprintWatch(root, await computeWorkspaceFingerprints(root, new Set()), at)
  }

  it('nothing is looked at again until a task that may write one ran', async () => {
    const watch = await watching()
    await writeFile(path.join(root, 'pnpm-lock.yaml'), 'Y')
    expect(watch.moved()).toBeUndefined()
    watch.wrote()
    expect(watch.moved()).toEqual(['pnpm-lock.yaml'])
  })

  it('once moved, moved for the run, even when the bytes come back', async () => {
    const watch = await watching()
    await writeFile(path.join(root, 'pnpm-lock.yaml'), 'Y')
    watch.wrote()
    expect(watch.moved()).toEqual(['pnpm-lock.yaml'])
    await writeFile(path.join(root, 'pnpm-lock.yaml'), 'X')
    watch.wrote()
    expect(watch.moved()).toEqual(['pnpm-lock.yaml'])
  })

  it('a lockfile that appeared, and one that went, each moved', async () => {
    const appeared = await watching()
    await writeFile(path.join(root, 'bun.lock'), '{}')
    appeared.wrote()
    expect(appeared.moved()).toEqual(['bun.lock'])
    await rm(path.join(root, 'bun.lock'))
    const went = await watching()
    await rm(path.join(root, 'pnpm-lock.yaml'))
    went.wrote()
    expect(went.moved()).toEqual(['pnpm-lock.yaml'])
  })

  it('control: rewritten to the same bytes, nothing moved', async () => {
    const watch = await watching()
    await writeFile(path.join(root, 'pnpm-lock.yaml'), 'X')
    watch.wrote()
    expect(watch.moved()).toBeUndefined()
  })
})
