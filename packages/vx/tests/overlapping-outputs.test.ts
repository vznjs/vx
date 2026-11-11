// The addition shape of docs/design/overlapping-outputs-2026-09.md, end to
// end (item 588): `build` fills `dist`, `individual` depends on it and adds
// `dist/individual` (twenty's twenty-ui; storybook's sandbox/build is the
// same shape). Before 588 the pair was refused at graph build, and since
// X-53 `vx lock` refuses it again unless the workspace sets `rules: {
// exclusiveOutputs: false }`, which every fixture here does (`additive`). Every row
// compares the tree under `dist` byte for byte with a COLD run of the same
// sources in a fresh workspace, which is the design note's acceptance:
// whatever the cache did, the tree is what the two commands produce.
import { rm, writeFile } from 'node:fs/promises'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import type { Logger } from '../src/report/index.js'
import { planRun as planFromLock } from '../src/orchestrator/index.js'
import { lock, prepareRun, run } from './helpers/orchestrator.js'
import { workspaceWith, writeLocalWorkspace } from './helpers/local-workspace.js'
import { startLocalShortCircuit } from '../src/orchestrator/local-shortcircuit.js'
import { indexDb, Cache, OUTPUT_DIRS_RACY_MS } from '../src/cache/index.js'

const silent = new Proxy({}, { get: () => () => undefined }) as Logger

/** A fixture workspace whose `.vx/workspace.mjs` turns `exclusiveOutputs` off. */
async function additive(opts: { prefix: string }): Promise<string> {
  const root = await makeWorkspace(opts)
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    workspaceWith('run: { rules: { exclusiveOutputs: false } }'),
  )
  return root
}
const TIMEOUT = 30_000

// Two shapes of the same pair. SUBDIRECTORY (twenty): the dependant
// declares `dist/individual`, so its own glob never selects the upstream's
// files and only the upstream's current-check has to ignore the addition.
// SAME TREE (strapi's `build` / `build:types`, both on `dist/**`): the
// dependant's glob selects the upstream's files too, so its artifact must
// be narrowed to what its run added, and its hit must clean by rows.
const SHAPES = { subdirectory: "['dist/individual']", 'same tree': "['dist']" } as const
const configFor = (dependantOutputs: string): string => `
  export default {
    tasks: {
      build: {
        exec: { command: 'mkdir -p dist && cp src/a.txt dist/a.txt && cp src/a.txt dist/a2.txt' },
        inputs: { files: ['src/**'] }, outputs: { files: ['dist'] }, cache: true,
      },
      individual: {
        dependsOn: ['build'],
        exec: { command: 'mkdir -p dist/individual && cp srcb/b.txt dist/individual/b.txt' },
        // Detached from build's key (inputs.tasks: []) so it can HIT while
        // build misses — the arrangement the note names as the hazard.
        inputs: { files: ['srcb/**'], tasks: [] }, outputs: { files: ${dependantOutputs} }, cache: true,
      },
      noop: {
        // Third in the chain, as strapi's build → build:code → build:types:
        // an overlap with individual too, ordered by this edge.
        dependsOn: ['individual'],
        exec: { command: 'true' },
        inputs: { files: ['srcb/**'], tasks: [] }, outputs: { files: ['dist/noop'] }, cache: true,
      },
    },
  }
`
const TASKS = ['build', 'individual', 'noop']

interface Ws {
  root: string
  app: string
}

async function workspace(a: string, b: string, config: string): Promise<Ws> {
  const root = await additive({ prefix: 'vx-ovl-' })
  const app = await addProject(root, 'app', { files: { 'src/a.txt': a, 'srcb/b.txt': b }, config })
  return { root, app }
}

/** Every file under dist with its bytes, sorted — the whole observable tree. */
function tree(app: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir).sort()) {
      const p = path.join(dir, e)
      if (statSync(p).isDirectory()) walk(p)
      else
        out.push([
          path.relative(app, p).split(path.sep).join('/'),
          require('node:fs').readFileSync(p, 'utf8'),
        ])
    }
  }
  try {
    walk(path.join(app, 'dist'))
  } catch {
    // no dist
  }
  return out
}

/** The tree a cold run of both commands produces for these sources. */
async function coldTree(a: string, b: string, config: string): Promise<Array<[string, string]>> {
  const ws = await workspace(a, b, config)
  try {
    const r = await run({ cwd: ws.root, tasks: TASKS, log: silent })
    expect(r.ok).toBe(true)
    return tree(ws.app)
  } finally {
    await rm(ws.root, { recursive: true, force: true })
  }
}

const statusOf = (r: Awaited<ReturnType<typeof run>>): Record<string, string> =>
  Object.fromEntries(
    r.outcomes.map((o) => [o.node.taskName, o.status + (o.restored ? '+restored' : '')]),
  )

describe('overlapping outputs under the default rules', () => {
  it(
    '`vx lock` refuses the edge-ordered pair; a run never checks it (X-53)',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-ovl-rule-' })
      try {
        await addProject(root, 'app', {
          files: { 'src/a.txt': 'A1', 'srcb/b.txt': 'B1' },
          config: configFor(SHAPES.subdirectory),
        })
        const refused = Bun.spawnSync({
          cmd: [process.execPath, path.join(import.meta.dir, '..', 'src', 'bin.ts'), 'lock'],
          cwd: root,
          stderr: 'pipe',
        })
        expect(refused.exitCode).toBe(1)
        expect(refused.stderr.toString()).toMatch(
          /^✗ vx lock  lock not written\n\n  app#build and app#individual both write .*\n\n  fix .* run\.rules\.exclusiveOutputs: false/s,
        )
        // The rules are the lock's to check: a lock written while the rule
        // was off still plans the pair once the rule is back on.
        await Bun.write(
          path.join(root, '.vx/workspace.mjs'),
          workspaceWith('run: { rules: { exclusiveOutputs: false } }'),
        )
        await lock(root)
        await writeLocalWorkspace(root)
        const plan = await planFromLock({ cwd: root, tasks: TASKS, log: silent })
        expect(plan.tasks.map((t) => t.node.id).sort()).toEqual([
          'app#build',
          'app#individual',
          'app#noop',
        ])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

describe.each(Object.entries(SHAPES))('overlapping outputs, addition shape: %s', (_shape, outs) => {
  const config = configFor(outs)
  let ws: Ws
  beforeEach(async () => {
    ws = await workspace('A1', 'B1', config)
  })
  afterEach(async () => {
    await rm(ws.root, { recursive: true, force: true })
  })

  it(
    'both miss, then both hit up-to-date: the tree is the cold tree, twice',
    async () => {
      const cold = await run({ cwd: ws.root, tasks: TASKS, log: silent })
      expect(statusOf(cold)).toEqual({ build: 'success', individual: 'success', noop: 'success' })
      expect(tree(ws.app)).toEqual(await coldTree('A1', 'B1', config))
      const warm = await run({ cwd: ws.root, tasks: TASKS, log: silent })
      // Neither restores: build's current-check ignores what individual
      // declares it adds, and individual's checks only its own rows. noop's
      // artifact holds no rows, and a hit with no rows is up-to-date while
      // its globs still match nothing (item 589).
      expect(statusOf(warm)).toEqual({
        build: 'cache-hit',
        individual: 'cache-hit',
        noop: 'cache-hit',
      })
      expect(tree(ws.app)).toEqual(await coldTree('A1', 'B1', config))
    },
    TIMEOUT,
  )

  it(
    'upstream MISS + dependant HIT: build re-runs and wipes dist, individual restores its own rows after',
    async () => {
      await run({ cwd: ws.root, tasks: TASKS, log: silent })
      await writeFile(path.join(ws.app, 'src', 'a.txt'), 'A2')
      const r = await run({ cwd: ws.root, tasks: TASKS, log: silent })
      expect(statusOf(r)).toEqual({
        build: 'success',
        individual: 'cache-hit+restored',
        noop: 'cache-hit',
      })
      // The sharp claim: individual's artifact holds ONLY dist/individual.
      // Had it captured dist/a.txt at save time (the glob walk), this
      // restore would bring A1 back over build's fresh A2.
      expect(tree(ws.app)).toEqual(await coldTree('A2', 'B1', config))
    },
    TIMEOUT,
  )

  it(
    'upstream HIT + dependant MISS: build stays up-to-date, individual re-runs beside it',
    async () => {
      await run({ cwd: ws.root, tasks: TASKS, log: silent })
      await writeFile(path.join(ws.app, 'srcb', 'b.txt'), 'B2')
      const r = await run({ cwd: ws.root, tasks: TASKS, log: silent })
      expect(statusOf(r)).toEqual({ build: 'cache-hit', individual: 'success', noop: 'success' })
      expect(tree(ws.app)).toEqual(await coldTree('A1', 'B2', config))
    },
    TIMEOUT,
  )

  it(
    'a dependant that adds nothing saves an empty set and its hit leaves the upstream tree alone',
    async () => {
      await run({ cwd: ws.root, tasks: TASKS, log: silent })
      await writeFile(path.join(ws.app, 'srcb', 'b.txt'), 'B2')
      await run({ cwd: ws.root, tasks: TASKS, log: silent })
      await writeFile(path.join(ws.app, 'srcb', 'b.txt'), 'B1')
      // noop hits its first entry again; individual hits its first entry
      // and restores b.txt=B1 over B2; build untouched.
      const r = await run({ cwd: ws.root, tasks: TASKS, log: silent })
      expect(statusOf(r)).toEqual({
        build: 'cache-hit',
        individual: 'cache-hit+restored',
        noop: 'cache-hit',
      })
      expect(tree(ws.app)).toEqual(await coldTree('A1', 'B1', config))
    },
    TIMEOUT,
  )

  it(
    'the dependant is never restore-tier: it restores only after its upstream is on disk',
    async () => {
      await run({ cwd: ws.root, tasks: TASKS, log: silent })
      const prepared = await prepareRun({ cwd: ws.root, tasks: TASKS, log: silent }, silent)
      try {
        // `localOnly`: the classify a run with a remote declared makes.
        for (const localOnly of [false, true]) {
          const sc = await startLocalShortCircuit({
            nodes: prepared.nodes,
            cache: prepared.cache,
            localOnly,
            workspaceRoot: prepared.workspaceRoot,
            claimedFiles: prepared.fingerprintWatch.names,
            nestedDirsByProject: prepared.nestedDirsByProject,
            gitFilesCache: prepared.gitFilesCache,
            hashCache: prepared.hashCache,
            concurrency: 4,
          })
          expect(sc.restoreTier.has('app#individual')).toBe(false)
          expect(sc.restoreTier.has('app#noop')).toBe(false)
          // CONTROL: the upstream's own hit is restore-tier as any leaf hit is.
          expect(sc.restoreTier.has('app#build')).toBe(true)
        }
      } finally {
        prepared.cache.close()
      }
    },
    TIMEOUT,
  )
})

// The same shape anchored at the WORKSPACE ROOT: `outputs.workspaceFiles`
// overlap the same way (task-graph.ts `collide` runs per field), and the
// hit's current-check has a second filter for the root-anchored half
// (`expectedWsRels.has(rel) || !isAddition(rel)`) that nothing above
// reached (item 638).
describe('overlapping outputs, addition shape at the workspace root', () => {
  const config = `
    export default {
      tasks: {
        build: {
          exec: { command: 'mkdir -p ../../gen && cp src/a.txt ../../gen/a.txt' },
          inputs: { files: ['src/**'] }, outputs: { files: [], workspaceFiles: ['gen'] }, cache: true,
        },
        individual: {
          dependsOn: ['build'],
          exec: { command: 'mkdir -p ../../gen/individual && cp srcb/b.txt ../../gen/individual/b.txt' },
          inputs: { files: ['srcb/**'], tasks: [] },
          outputs: { files: [], workspaceFiles: ['gen/individual'] },
          cache: true,
        },
      },
    }
  `
  let ws: Ws
  beforeEach(async () => {
    ws = await workspace('A1', 'B1', config)
  })
  afterEach(async () => {
    await rm(ws.root, { recursive: true, force: true })
  })

  it(
    "both hit up-to-date: build's current-check ignores what individual adds under gen/",
    async () => {
      const cold = await run({ cwd: ws.root, tasks: ['build', 'individual'], log: silent })
      expect(statusOf(cold)).toEqual({ build: 'success', individual: 'success' })
      const warm = await run({ cwd: ws.root, tasks: ['build', 'individual'], log: silent })
      // Without the root-anchored addition filter, build's glob walk finds
      // gen/individual/b.txt, the sets mismatch and build restores — wiping
      // individual's file until individual restores it again.
      expect(statusOf(warm)).toEqual({ build: 'cache-hit', individual: 'cache-hit' })
      expect(readFileSync(path.join(ws.root, 'gen', 'a.txt'), 'utf8')).toBe('A1')
      expect(readFileSync(path.join(ws.root, 'gen', 'individual', 'b.txt'), 'utf8')).toBe('B1')
    },
    TIMEOUT,
  )
})

// SAME TREE at the root (A-43): the dependant declares `gen` too and reads
// what build wrote there. Its miss cleaned `gen` by glob before it ran,
// taking build's `gen/a.txt`, so its read failed; only the project-output
// half of an addition was stamped instead of cleaned.
describe('overlapping outputs, same tree at the workspace root', () => {
  const config = `
    export default {
      tasks: {
        build: {
          exec: { command: 'mkdir -p ../../gen && cp src/a.txt ../../gen/a.txt' },
          inputs: { files: ['src/**'] }, outputs: { files: [], workspaceFiles: ['gen'] }, cache: true,
        },
        individual: {
          dependsOn: ['build'],
          exec: { command: 'cp ../../gen/a.txt ../../gen/b.txt && cat srcb/b.txt >> ../../gen/b.txt' },
          inputs: { files: ['srcb/**'], tasks: [] },
          outputs: { files: [], workspaceFiles: ['gen'] },
          cache: true,
        },
      },
    }
  `
  let ws: Ws
  beforeEach(async () => {
    ws = await workspace('A1', 'B1', config)
  })
  afterEach(async () => {
    await rm(ws.root, { recursive: true, force: true })
  })

  it(
    "the dependant's miss keeps build's files, and its entry holds only its own",
    async () => {
      const cold = await run({ cwd: ws.root, tasks: ['build', 'individual'], log: silent })
      expect(statusOf(cold)).toEqual({ build: 'success', individual: 'success' })
      const gen = (f: string): string => readFileSync(path.join(ws.root, 'gen', f), 'utf8')
      expect([gen('a.txt'), gen('b.txt')]).toEqual(['A1', 'A1B1'])
      const hash = cold.outcomes.find((o) => o.node.id.endsWith('#individual'))!.hash!
      const cache = new Cache(path.join(ws.root, '.vx', 'cache'))
      try {
        const rows = cache.loadOutputFilesBatch([hash]).get(hash) ?? []
        expect(rows.map((r) => r.path)).toEqual(['workspace-outputs/gen/b.txt'])
      } finally {
        cache.close()
      }
    },
    TIMEOUT,
  )
})

// A root-anchored output inside another project's `files` tree, with the
// edge (item 1088's addition): the dependant's glob, rebased to the root,
// covers the upstream's own rows, and the upstream's current-check keeps a
// path it recorded (`expectedWsRels.has(rel)`). Without that arm the
// upstream restored on every hit and wiped what the dependant added, which
// then restored too (C-24: a mutant the suite passed).
describe("overlapping outputs: a root-anchored upstream under a project's dependant", () => {
  let root: string
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'both hit up-to-date: the upstream keeps its own rows under what the dependant adds',
    async () => {
      root = await additive({ prefix: 'vx-ovl-ws-' })
      await addProject(root, 'a', {
        files: { 'src/a.txt': 'A1' },
        config: `export default { tasks: { build: {
          exec: { command: 'mkdir -p ../b/dist && cp src/a.txt ../b/dist/a.txt' },
          inputs: { files: ['src/**'] }, outputs: { files: [], workspaceFiles: ['packages/b/dist'] }, cache: true,
        } } }`,
      })
      const b = await addProject(root, 'b', {
        files: { 'src/b.txt': 'B1' },
        config: `export default { tasks: { build: {
          dependsOn: ['a#build'],
          exec: { command: 'cp src/b.txt dist/b.txt' },
          inputs: { files: ['src/**'], tasks: [] }, outputs: { files: ['dist'] }, cache: true,
        } } }`,
      })
      const byId = (r: Awaited<ReturnType<typeof run>>): Record<string, string> =>
        Object.fromEntries(
          r.outcomes.map((o) => [o.node.id, o.status + (o.restored ? '+restored' : '')]),
        )
      const cold = await run({ cwd: root, tasks: ['build'], log: silent })
      expect(byId(cold)).toEqual({ 'a#build': 'success', 'b#build': 'success' })
      const warm = await run({ cwd: root, tasks: ['build'], log: silent })
      expect(byId(warm)).toEqual({ 'a#build': 'cache-hit', 'b#build': 'cache-hit' })
      expect(readFileSync(path.join(b, 'dist', 'a.txt'), 'utf8')).toBe('A1')
      expect(readFileSync(path.join(b, 'dist', 'b.txt'), 'utf8')).toBe('B1')
    },
    TIMEOUT,
  )
})

// The run-end directory snapshot of each side of the same-tree pair (A-25).
// An upstream's tree also holds what its dependant added, and the snapshot
// ignores those files; an additive task's rows need only be present among
// the upstream's. Held alone, each rule is a mutant the suite passed: the
// upstream refused its snapshot (every hit walked), the additive one
// vouched for a tree that lost its file.
describe('overlapping outputs: the run-end snapshot of each side', () => {
  const sameTree = (tail: string): string => `
    export default {
      tasks: {
        build: {
          exec: { command: 'mkdir -p dist && cp src/a.txt dist/a.txt' },
          inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
        },
        individual: {
          dependsOn: ['build'],
          exec: { command: 'cp srcb/b.txt dist/b.txt' },
          inputs: { files: ['srcb/**'], tasks: [] }, outputs: { files: ['dist/**'] }, cache: true,
        },
        tail: {
          dependsOn: ['individual'],
          exec: { command: '${tail}sleep ${(OUTPUT_DIRS_RACY_MS * 3) / 1000}' },
        },
      },
    }
  `
  const recordedFor = (root: string, task: string): string[] => {
    const c = new Cache(path.join(root, '.vx/cache'))
    try {
      const { hash } = indexDb(c).query('SELECT hash FROM entries WHERE task = ?').get(task) as {
        hash: string
      }
      return (c.loadOutputDirsBatch([hash]).get(hash) ?? []).map((r) => r.path)
    } finally {
      c.close()
    }
  }

  it(
    'both sides record the shared tree when it holds what each saved',
    async () => {
      const ws = await workspace('a', 'b', sameTree(''))
      try {
        expect((await run({ cwd: ws.root, tasks: ['tail'], log: silent })).ok).toBe(true)
        expect(recordedFor(ws.root, 'build')).toEqual(['dist'])
        expect(recordedFor(ws.root, 'individual')).toEqual(['dist'])
      } finally {
        await rm(ws.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'the additive side does not vouch for a tree that lost its file',
    async () => {
      const ws = await workspace('a', 'b', sameTree('rm dist/b.txt && '))
      try {
        expect((await run({ cwd: ws.root, tasks: ['tail'], log: silent })).ok).toBe(true)
        expect(recordedFor(ws.root, 'individual')).toEqual([])
      } finally {
        await rm(ws.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

// An additive task that REMOVES a file its upstream wrote (a bundler
// deleting its intermediate). An artifact holds what a run wrote, never
// what it took away, so a hit cannot replay the removal: the upstream's
// restore brought the file back and the dependant's own rows left it.
describe('overlapping outputs: a dependant that removes an upstream file', () => {
  const config = `
    export default {
      tasks: {
        build: {
          exec: { command: 'mkdir -p dist && cp src/a.txt dist/a.js && echo mid > dist/tmp.js' },
          inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
        },
        post: {
          dependsOn: ['build'],
          exec: { command: 'rm dist/tmp.js && echo bundle > dist/bundle.js' },
          inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
        },
      },
    }
  `
  let ws: Ws
  beforeEach(async () => {
    ws = await workspace('A1', 'B1', config)
  })
  afterEach(async () => {
    await rm(ws.root, { recursive: true, force: true })
  })

  it(
    'its removal is never undone by a hit: the dependant saves nothing and re-runs',
    async () => {
      const cold = await run({ cwd: ws.root, tasks: ['post'], log: silent })
      expect(statusOf(cold)).toEqual({ build: 'success', post: 'success' })
      const want: Array<[string, string]> = [
        ['dist/a.js', 'A1'],
        ['dist/bundle.js', 'bundle\n'],
      ]
      expect(tree(ws.app)).toEqual(want)
      for (let i = 0; i < 2; i++) {
        const warm = await run({ cwd: ws.root, tasks: ['post'], log: silent })
        expect(tree(ws.app)).toEqual(want)
        expect(statusOf(warm)).toEqual({ build: 'cache-hit+restored', post: 'success' })
      }
    },
    TIMEOUT,
  )

  it(
    'the same at the workspace root: a root-anchored removal is never undone by a hit',
    async () => {
      const rootWs = await workspace(
        'A1',
        'B1',
        `
        export default {
          tasks: {
            build: {
              exec: { command: 'mkdir -p ../../gen && cp src/a.txt ../../gen/a.js && echo mid > ../../gen/tmp.js' },
              inputs: { files: ['src/**'] }, outputs: { files: [], workspaceFiles: ['gen'] }, cache: true,
            },
            post: {
              dependsOn: ['build'],
              exec: { command: 'rm ../../gen/tmp.js && echo bundle > ../../gen/bundle.js' },
              inputs: { files: ['src/**'] }, outputs: { files: [], workspaceFiles: ['gen'] }, cache: true,
            },
          },
        }
      `,
      )
      try {
        const gen = (): string[] => readdirSync(path.join(rootWs.root, 'gen')).sort()
        expect((await run({ cwd: rootWs.root, tasks: ['post'], log: silent })).ok).toBe(true)
        expect(gen()).toEqual(['a.js', 'bundle.js'])
        const warm = await run({ cwd: rootWs.root, tasks: ['post'], log: silent })
        expect(gen()).toEqual(['a.js', 'bundle.js'])
        expect(statusOf(warm)).toEqual({ build: 'cache-hit+restored', post: 'success' })
      } finally {
        await rm(rootWs.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

// A retry of the dependant: what a failed attempt added is removed before
// the next, as an exclusive task's clean removes it, and a file it found
// and changed cannot be put back, so that retry saves nothing.
describe('overlapping outputs: a dependant that passes on a retry', () => {
  const configWith = (failing: string): string => `
    export default {
      tasks: {
        build: {
          exec: { command: 'mkdir -p dist && cp src/a.txt dist/a.js' },
          inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
        },
        post: {
          dependsOn: ['build'],
          exec: {
            command: 'n=$(cat n 2>/dev/null || echo 0); n=$((n+1)); echo $n > n; ' +
              'if [ $n -eq 1 ]; then ${failing}; exit 1; fi; echo b > dist/b.js',
            retries: 1,
          },
          inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
        },
      },
    }
  `
  const want: Array<[string, string]> = [
    ['dist/a.js', 'A1'],
    ['dist/b.js', 'b\n'],
  ]
  let ws: Ws | undefined
  afterEach(async () => {
    if (ws !== undefined) await rm(ws.root, { recursive: true, force: true })
  })

  it(
    "a failed attempt's addition is neither left nor saved",
    async () => {
      ws = await workspace('A1', 'B1', configWith('echo partial > dist/partial.js'))
      expect(statusOf(await run({ cwd: ws.root, tasks: ['post'], log: silent }))).toEqual({
        build: 'success',
        post: 'success',
      })
      expect(tree(ws.app)).toEqual(want)
      await rm(path.join(ws.app, 'dist'), { recursive: true })
      const warm = await run({ cwd: ws.root, tasks: ['post'], log: silent })
      expect(statusOf(warm)).toEqual({ build: 'cache-hit+restored', post: 'cache-hit+restored' })
      expect(tree(ws.app)).toEqual(want)
    },
    TIMEOUT,
  )

  it(
    'a failed attempt that changed a found file: the retry saves nothing',
    async () => {
      ws = await workspace('A1', 'B1', configWith('echo bad > dist/a.js'))
      expect((await run({ cwd: ws.root, tasks: ['post'], log: silent })).ok).toBe(true)
      const warm = await run({ cwd: ws.root, tasks: ['post'], log: silent })
      expect(statusOf(warm)).toEqual({ build: 'cache-hit+restored', post: 'success' })
      expect(tree(ws.app)).toEqual(want)
    },
    TIMEOUT,
  )
})

// The rewrite-in-place shape where size and mtime hold: a dependant that
// rewrites its upstream's file to bytes of the same length and stamps the
// mtime back (a tool honouring SOURCE_DATE_EPOCH). Judged by size + mtime,
// the rewrite was not its own, so its hit restored only what it added and
// left the upstream's restored bytes in place.
describe('overlapping outputs: a same-size rewrite that keeps the mtime', () => {
  const config = `
    export default {
      tasks: {
        build: {
          exec: { command: 'mkdir -p dist && cat src/a.txt > dist/a.txt && touch -t 200101010000 dist/a.txt' },
          inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
        },
        types: {
          dependsOn: ['build'],
          exec: {
            command:
              'tr a-z A-Z < dist/a.txt > dist/up && cat dist/up > dist/a.txt && rm dist/up && ' +
              'touch -t 200101010000 dist/a.txt && echo t > dist/types.d.ts',
          },
          inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
        },
      },
    }
  `
  let ws: Ws
  beforeEach(async () => {
    ws = await workspace('hello', 'B1', config)
  })
  afterEach(async () => {
    await rm(ws.root, { recursive: true, force: true })
  })

  it(
    "the rewrite is the dependant's own, so a warm run leaves its bytes",
    async () => {
      const want: Array<[string, string]> = [
        ['dist/a.txt', 'HELLO'],
        ['dist/types.d.ts', 't\n'],
      ]
      expect((await run({ cwd: ws.root, tasks: ['types'], log: silent })).ok).toBe(true)
      expect(tree(ws.app)).toEqual(want)
      for (let i = 0; i < 2; i++) {
        const warm = await run({ cwd: ws.root, tasks: ['types'], log: silent })
        expect(tree(ws.app)).toEqual(want)
        expect(statusOf(warm)).toEqual({
          build: 'cache-hit+restored',
          types: 'cache-hit+restored',
        })
      }
    },
    TIMEOUT,
  )
})

// An incremental emitter (tsc's, `cmp || cp`) rewrites only the files whose
// bytes changed. Its second miss found `ta.d` from its own first run and
// left it alone, so the entry held `tb.d` alone, and a hit over a wiped
// `dist` restored a tree without `ta.d`, under a green run. What the
// dependant found exactly as a save or restore of its own left it is its
// own too.
describe("overlapping outputs: an incremental dependant keeps what it didn't rewrite", () => {
  const config = `
    export default {
      tasks: {
        build: {
          exec: { command: 'mkdir -p dist && cp src/x dist/o' },
          inputs: { files: ['src/x'] }, outputs: { files: ['dist/**'] }, cache: true,
        },
        types: {
          dependsOn: ['build'],
          exec: { command: 'mkdir -p dist/types && for f in ta tb; do cmp -s src/$f dist/types/$f.d || cp src/$f dist/types/$f.d; done' },
          inputs: { files: ['src/t*'] }, outputs: { files: ['dist/types/**'] }, cache: true,
        },
      },
    }
  `
  let root: string
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'a hit over a wiped tree restores every file a forced run leaves',
    async () => {
      root = await additive({ prefix: 'vx-ovl-incr-' })
      const app = await addProject(root, 'app', {
        files: { 'src/x': 'X', 'src/ta': 'TA', 'src/tb': 'TB1' },
        config,
      })
      const want = (tb: string): Array<[string, string]> => [
        ['dist/o', 'X'],
        ['dist/types/ta.d', 'TA'],
        ['dist/types/tb.d', tb],
      ]
      expect((await run({ cwd: root, tasks: ['types'], log: silent })).ok).toBe(true)
      await writeFile(path.join(app, 'src', 'tb'), 'TB2')
      const second = await run({ cwd: root, tasks: ['types'], log: silent })
      expect(statusOf(second)).toEqual({ build: 'cache-hit', types: 'success' })
      expect(tree(app)).toEqual(want('TB2'))
      // The entry holds the file the run found as its first entry left it.
      const hash = second.outcomes.find((o) => o.node.taskName === 'types')!.hash!
      const cache = new Cache(path.join(root, '.vx', 'cache'))
      try {
        const rows = cache.loadOutputFilesBatch([hash]).get(hash) ?? []
        expect(rows.map((r) => r.path).sort()).toEqual(['dist/types/ta.d', 'dist/types/tb.d'])
      } finally {
        cache.close()
      }
      await rm(path.join(app, 'dist'), { recursive: true, force: true })
      const hit = await run({ cwd: root, tasks: ['types'], log: silent })
      expect(statusOf(hit)).toEqual({
        build: 'cache-hit+restored',
        types: 'cache-hit+restored',
      })
      expect(tree(app)).toEqual(want('TB2'))
      // CONTROL: what a forced run leaves.
      await run({ cwd: root, tasks: ['types'], log: silent, cacheFlags: { force: true } })
      expect(tree(app)).toEqual(want('TB2'))
    },
    TIMEOUT,
  )
})

// The upstream run alone: its dependant is not in the graph, so nothing
// told it which globs add to its tree, its current-check counted the
// dependant's files as strays, and every warm `build` restored, wiping
// them (and every warm `types` restored them back).
describe('overlapping outputs: the upstream run without its dependant', () => {
  let root: string
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'in one project: a warm upstream stays up-to-date and keeps the addition',
    async () => {
      root = await additive({ prefix: 'vx-ovl-alone-' })
      const app = await addProject(root, 'app', {
        files: { 'src/x': 'X' },
        config: `export default { tasks: {
          build: {
            exec: { command: 'mkdir -p dist && cp src/x dist/o' },
            inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
          },
          types: {
            dependsOn: ['build'],
            exec: { command: 'mkdir -p dist/types && cp dist/o dist/types/t' },
            inputs: { files: ['src/**'] }, outputs: { files: ['dist/types/**'] }, cache: true,
          },
        } }`,
      })
      expect((await run({ cwd: root, tasks: ['types'], log: silent })).ok).toBe(true)
      const want: Array<[string, string]> = [
        ['dist/o', 'X'],
        ['dist/types/t', 'X'],
      ]
      for (let i = 0; i < 2; i++) {
        const alone = await run({ cwd: root, tasks: ['build'], log: silent })
        expect(statusOf(alone)).toEqual({ build: 'cache-hit' })
        expect(tree(app)).toEqual(want)
        const both = await run({ cwd: root, tasks: ['types'], log: silent })
        expect(statusOf(both)).toEqual({ build: 'cache-hit', types: 'cache-hit' })
      }
    },
    TIMEOUT,
  )

  it(
    'across projects at the workspace root: a warm upstream stays up-to-date',
    async () => {
      root = await additive({ prefix: 'vx-ovl-alone-ws-' })
      await addProject(root, 'a', {
        files: { 'src/a.txt': 'A1' },
        config: `export default { tasks: { build: {
          exec: { command: 'mkdir -p ../../gen && cp src/a.txt ../../gen/a.txt' },
          inputs: { files: ['src/**'] }, outputs: { files: [], workspaceFiles: ['gen'] }, cache: true,
        } } }`,
      })
      await addProject(root, 'b', {
        files: { 'src/b.txt': 'B1' },
        config: `export default { tasks: { types: {
          dependsOn: ['a#build'],
          exec: { command: 'mkdir -p ../../gen/b && cp src/b.txt ../../gen/b/b.txt' },
          inputs: { files: ['src/**'], tasks: [] },
          outputs: { files: [], workspaceFiles: ['gen/b'] },
          cache: true,
        } } }`,
      })
      expect((await run({ cwd: root, tasks: ['b#types'], log: silent })).ok).toBe(true)
      for (let i = 0; i < 2; i++) {
        const alone = await run({ cwd: root, tasks: ['a#build'], log: silent })
        expect(statusOf(alone)).toEqual({ build: 'cache-hit' })
        expect(readFileSync(path.join(root, 'gen', 'b', 'b.txt'), 'utf8')).toBe('B1')
      }
    },
    TIMEOUT,
  )
})
