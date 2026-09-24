// A task with no `cache` block declares no outputs, yet it writes: `gen`
// copies a seed into `config.json`, and a same-project `build` that runs
// after it (`dependsOn`, with `tasks: []` so its key folds no upstream
// key) reads that file. Its run-start facts — the git snapshot, the index
// OIDs, the up-front key the local short-circuit took — describe the bytes
// BEFORE `gen` ran, and a key built from them replays the wrong artifact
// under a green run (turborepo#13788, item 741). Every row here failed on
// the tree before the fix.

import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache, GitFilesCache } from '../src/cache/index.js'
import { localExecutor } from '../src/exec/local-executor.js'
import type { TaskExecutor } from '../src/exec/index.js'
import type { TaskNode } from '../src/graph/index.js'
import type { Logger } from '../src/orchestrator/index.js'
import { prepareRun, run } from '../src/orchestrator/index.js'
import { executeTask } from '../src/orchestrator/execute-task.js'
import { startLocalShortCircuit } from '../src/orchestrator/local-shortcircuit.js'
import { undeclaredWriteReach } from '../src/orchestrator/sandbox-request.js'
import { createHashCache } from '../src/orchestrator/task-hash.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const TIMEOUT = 30_000

const logger = (lines: string[]): Logger => ({
  status: (line) => lines.push(line),
  taskStdout: () => {},
  taskStderr: () => {},
  taskComplete: () => {},
})

const config = (gen: string): string => `
  export default {
    tasks: {
      gen: ${gen},
      build: {
        dependsOn: ['gen'],
        exec: { command: 'mkdir -p dist && cat config.json > dist/out.txt' },
        cache: { inputs: { files: ['config.json'], tasks: [] }, outputs: { files: ['dist/**'] } },
      },
    },
  }
`
const UNSANDBOXED = `{ exec: { command: 'cp seed.txt config.json' } }`

let root: string
let app: string

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-undeclared-' })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function fixture(files: Record<string, string> = {}): Promise<void> {
  app = await addProject(root, 'app', { config: config(UNSANDBOXED), files })
  await writeFile(path.join(root, '.gitignore'), 'dist/\n.vx/\n')
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
}

/** Seed, run `build`, and return what it built and every status line. */
async function build(seed: string): Promise<{ out: string; status: string[] }> {
  await writeFile(path.join(app, 'seed.txt'), seed)
  const status: string[] = []
  const r = await run({ cwd: root, tasks: ['build'], log: logger(status) })
  expect(r.ok).toBe(true)
  return { out: await readFile(path.join(app, 'dist', 'out.txt'), 'utf8'), status }
}

describe('an uncached producer that writes a same-project input', () => {
  it(
    'seeds A, B, B, A build A, B, B, A: the up-front key is not taken before the producer ran',
    async () => {
      await fixture()
      const outs: string[] = []
      for (const seed of ['A', 'B', 'B', 'A']) outs.push((await build(seed)).out)
      // Before the fix the consumer was classed stable, its key taken from the
      // pre-`gen` bytes, and the fourth run replayed B.
      expect(outs).toEqual(['A', 'B', 'B', 'A'])
    },
    TIMEOUT,
  )

  it(
    'the first run keys the file the producer created, not the run-start listing without it',
    async () => {
      await fixture()
      const first = await build('A')
      expect(first.out).toBe('A')
      expect(first.status.filter((l) => l.includes('matched no files'))).toEqual([])
    },
    TIMEOUT,
  )

  it(
    'a TRACKED input the producer rewrites is keyed on its new bytes, not its index OID',
    async () => {
      // Clean at run start, so the snapshot trusts its committed OID (`X`);
      // `gen` rewrites it, and a key from that OID hit the first run's entry.
      await fixture({ 'config.json': 'X' })
      expect((await build('A')).out).toBe('A')
      gitIn(root)('checkout', '--', 'packages/app/config.json')
      expect((await build('B')).out).toBe('B')
    },
    TIMEOUT,
  )
})

describe('the run-start facts a producer can contradict, each one', () => {
  it(
    "the project's package.json digest: a producer that rewrites it re-keys the reader",
    async () => {
      // `build` reads only `src/**`; package.json reaches its key as the
      // project's implicit input, through the per-run memo the up-front
      // derivation filled before `gen` rewrote it.
      const manifest = (v: string) => JSON.stringify({ name: 'app', version: v })
      app = await addProject(root, 'app', {
        config: `
          export default {
            tasks: {
              gen: { exec: { command: 'cp seed.json package.json' } },
              build: {
                dependsOn: ['gen'],
                exec: { command: 'mkdir -p dist && cat package.json > dist/out.txt' },
                cache: { inputs: { files: ['src/**'], tasks: [] }, outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
        files: { 'src/a.txt': 'a' },
      })
      await writeFile(path.join(root, '.gitignore'), 'dist/\n.vx/\nseed.json\n')
      gitIn(root)('add', '-A')
      gitIn(root)('commit', '-q', '-m', 'init')
      const built = async (v: string): Promise<string> => {
        await writeFile(path.join(app, 'seed.json'), manifest(v))
        const r = await run({ cwd: root, tasks: ['build'], log: logger([]) })
        expect(r.ok).toBe(true)
        gitIn(root)('checkout', '--', 'packages/app/package.json')
        return readFile(path.join(app, 'dist', 'out.txt'), 'utf8')
      }
      expect(await built('1.0.0')).toBe(manifest('1.0.0'))
      expect(await built('2.0.0')).toBe(manifest('2.0.0'))
    },
    TIMEOUT,
  )

  it(
    "the workspace partition: a workspaceFiles reader in another project sees the producer's bytes",
    async () => {
      await addProject(root, 'lib', {
        config: `export default { tasks: { gen: { exec: { command: 'cp seed.txt config.json' } } } }`,
        files: { 'config.json': 'X' },
      })
      app = await addProject(root, 'app', {
        deps: { lib: 'workspace:*' },
        config: `
          export default {
            tasks: {
              build: {
                dependsOn: ['^gen'],
                exec: { command: 'mkdir -p dist && cat ../lib/config.json > dist/out.txt' },
                cache: {
                  inputs: { files: [], workspaceFiles: ['packages/lib/config.json'], tasks: [] },
                  outputs: { files: ['dist/**'] },
                },
              },
            },
          }
        `,
      })
      await writeFile(path.join(root, '.gitignore'), 'dist/\n.vx/\nseed.txt\n')
      gitIn(root)('add', '-A')
      gitIn(root)('commit', '-q', '-m', 'init')
      const built = async (seed: string): Promise<string> => {
        await writeFile(path.join(root, 'packages', 'lib', 'seed.txt'), seed)
        const r = await run({ cwd: root, tasks: ['build'], log: logger([]) })
        expect(r.ok).toBe(true)
        gitIn(root)('checkout', '--', 'packages/lib/config.json')
        return readFile(path.join(app, 'dist', 'out.txt'), 'utf8')
      }
      expect(await built('A')).toBe('A')
      expect(await built('B')).toBe('B')
    },
    TIMEOUT,
  )
})

describe('execute-task drops what the command may have written, and nothing else', () => {
  const OTHER = '/elsewhere/lib'

  /** Run one task through `executeTask` against pre-filled facts; return which survived. */
  async function survivors(
    config: TaskNode['config'],
    executor: TaskExecutor = localExecutor(),
  ): Promise<{ partitions: string[]; manifests: string[] }> {
    const dir = await addProject(root, 'app', { files: { 'config.json': 'X' } })
    const git = new GitFilesCache()
    git.setWorkspaceRoot(root)
    for (const p of [dir, OTHER, root]) {
      git.set(p, ['package.json'])
      git.setOids(p, new Map([[path.join(p, 'package.json'), 'oid']]))
    }
    const hashCache = createHashCache()
    for (const p of [dir, OTHER]) hashCache.packageJson.set(p, Promise.resolve('digest'))
    const cache = new Cache(path.join(root, '.vx', 'cache'))
    try {
      const n = {
        id: 'app#gen',
        projectName: 'app',
        projectDir: dir,
        taskName: 'gen',
        config,
        deps: [],
        requested: true,
      } as TaskNode
      const liveChildren = new Set<ReturnType<typeof Bun.spawn>>()
      const persistentRegistry = new Map<string, ReturnType<typeof Bun.spawn>>()
      await executeTask({
        node: n,
        upstream: [],
        workspaceRoot: root,
        workspaceFingerprint: 'fp',
        cache,
        log: logger([]),
        executor,
        nestedProjectDirs: [],
        runStartHrTimeNs: process.hrtime.bigint(),
        keyedProjects: () => new Set<string>(),
        gitFilesCache: git,
        hashCache,
        liveChildren,
        persistentRegistry,
      })
      for (const child of persistentRegistry.values()) child.kill()
      const name = (p: string) => (p === dir ? 'app' : p === OTHER ? 'other' : 'workspace')
      // A partition's index OIDs go with it, never outlive it.
      expect([dir, OTHER, root].filter((p) => git.oidsFor(p) !== undefined)).toEqual(
        [dir, OTHER, root].filter((p) => git.has(p)),
      )
      return {
        partitions: [...git.keys()].map(name).sort(),
        manifests: [...hashCache.packageJson.keys()].map(name).sort(),
      }
    } finally {
      cache.close()
    }
  }
  // Stands in for a sandboxed run: what is decided here is the grant, not the wall.
  const ranHere: TaskExecutor = {
    name: 'test/ran-here',
    execute: async () => ({ exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }),
  }

  it(
    'an unsandboxed uncached task: its project and the workspace partition go, another project stays',
    async () => {
      expect(await survivors({ exec: { command: 'true' } })).toEqual({
        partitions: ['other'],
        manifests: ['other'],
      })
    },
    TIMEOUT,
  )

  it(
    'a failed one too: a command that failed may still have written',
    async () => {
      expect(await survivors({ exec: { command: 'false' } })).toEqual({
        partitions: ['other'],
        manifests: ['other'],
      })
    },
    TIMEOUT,
  )

  it(
    'a sandbox grant that leaves the project: every fact goes',
    async () => {
      const cfg = {
        exec: { command: 'true', sandbox: { allow: { read: ['.'], write: ['../lib/x'] } } },
      }
      expect(await survivors(cfg, ranHere)).toEqual({ partitions: [], manifests: [] })
    },
    TIMEOUT,
  )

  it(
    'control: a sandbox with no write grant, a remote executor and a cached task drop nothing',
    async () => {
      const all = { partitions: ['app', 'other', 'workspace'], manifests: ['app', 'other'] }
      const sandboxed = { exec: { command: 'true', sandbox: { allow: { read: ['.'] } } } }
      expect(await survivors(sandboxed, ranHere)).toEqual(all)
      await rm(path.join(root, 'packages', 'app'), { recursive: true, force: true })
      expect(await survivors({ exec: { command: 'true' } }, { ...ranHere, remote: true })).toEqual(
        all,
      )
      await rm(path.join(root, 'packages', 'app'), { recursive: true, force: true })
      const cached = {
        exec: { command: 'true' },
        cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } },
      }
      expect(await survivors(cached, ranHere)).toEqual(all)
    },
    TIMEOUT,
  )

  it(
    'a persistent task, once ready',
    async () => {
      const cfg = { exec: { command: 'exec sleep 30', persistent: {} } }
      expect(await survivors(cfg)).toEqual({ partitions: ['other'], manifests: ['other'] })
    },
    TIMEOUT,
  )
})

describe('undeclaredWriteReach — where a task may have written that nothing declares', () => {
  const ws = '/ws'
  const node = (config: Record<string, unknown>): TaskNode =>
    ({
      id: 'app#t',
      projectName: 'app',
      projectDir: '/ws/packages/app',
      config,
    }) as unknown as TaskNode
  const sandboxed = (write?: string[]) =>
    node({
      exec: {
        command: 'x',
        sandbox: { allow: write === undefined ? { read: ['.'] } : { read: ['.'], write } },
      },
    })

  it('a cached task is held to its declared outputs; a group runs nothing', () => {
    expect(
      undeclaredWriteReach(
        node({ exec: { command: 'x' }, cache: { inputs: {}, outputs: { files: [] } } }),
        ws,
      ),
    ).toBe('none')
    expect(undeclaredWriteReach(node({}), ws)).toBe('none')
  })

  it('an unsandboxed uncached task may have written anywhere in its project', () => {
    expect(undeclaredWriteReach(node({ exec: { command: 'x' } }), ws)).toBe('project')
  })

  it('a sandbox bounds it by its write grants', () => {
    expect(undeclaredWriteReach(sandboxed(), ws)).toBe('none')
    expect(undeclaredWriteReach(sandboxed([]), ws)).toBe('none')
    expect(undeclaredWriteReach(sandboxed(['dist/**']), ws)).toBe('project')
    expect(undeclaredWriteReach(sandboxed(['out.txt']), ws)).toBe('project')
    expect(undeclaredWriteReach(sandboxed(['../lib/gen/**']), ws)).toBe('workspace')
    expect(undeclaredWriteReach(sandboxed(['/ws/shared/x']), ws)).toBe('workspace')
    expect(undeclaredWriteReach(sandboxed(['../../..']), ws)).toBe('workspace')
    expect(undeclaredWriteReach(sandboxed(['~/.cache/tool/**']), ws)).toBe('none')
    expect(undeclaredWriteReach(sandboxed(['/elsewhere/**']), ws)).toBe('none')
    expect(undeclaredWriteReach(sandboxed(['/elsewhere/**', 'dist/**']), ws)).toBe('project')
  })
})

describe('the stability gate reads the reach', () => {
  /** Commit the fixture, then classify it as run() does: is `app#build` probed up front? */
  async function upFront(): Promise<boolean> {
    gitIn(root)('add', '-A')
    gitIn(root)('commit', '-q', '-m', 'init')
    const lines: string[] = []
    const prepared = await prepareRun(
      { cwd: root, tasks: ['build'], log: logger(lines) },
      logger(lines),
    )
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
      return sc.preProbed.has('app#build')
    } finally {
      prepared.cache.close()
    }
  }

  async function sameProject(gen: string): Promise<boolean> {
    await addProject(root, 'app', { config: config(gen), files: { 'config.json': 'X' } })
    return upFront()
  }

  /** `lib#gen` (uncached, sandboxed, writing `write`) upstream of `app#build`, which reads its own `**`. */
  async function crossProject(write: string): Promise<boolean> {
    await addProject(root, 'lib', {
      config: `
        export default {
          tasks: {
            gen: { exec: { command: 'true', sandbox: { allow: { read: ['.'], write: ['${write}'] } } } },
          },
        }
      `,
    })
    await addProject(root, 'app', {
      deps: { lib: 'workspace:*' },
      config: `
        export default {
          tasks: {
            build: {
              dependsOn: ['^gen'],
              exec: { command: 'true' },
              cache: { inputs: { files: ['**'] }, outputs: { files: [] } },
            },
          },
        }
      `,
    })
    return upFront()
  }

  it(
    'an unsandboxed uncached producer makes its same-project reader unstable',
    async () => {
      expect(await sameProject(UNSANDBOXED)).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'control: a sandboxed one with no write grant leaves the reader stable',
    async () => {
      expect(
        await sameProject(`{ exec: { command: 'true', sandbox: { allow: { read: ['.'] } } } }`),
      ).toBe(true)
    },
    TIMEOUT,
  )

  it(
    "a grant that leaves the producer's project makes a reader in another project unstable",
    async () => {
      expect(await crossProject('../app/gen/**')).toBe(false)
    },
    TIMEOUT,
  )

  it(
    "control: a grant inside the producer's own project leaves another project's reader stable",
    async () => {
      expect(await crossProject('gen/**')).toBe(true)
    },
    TIMEOUT,
  )
})
