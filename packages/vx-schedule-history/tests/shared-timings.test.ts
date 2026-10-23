// Task timings through the workspace's cache (design
// packages/vx/docs/design/shared-timings-2026-10.md): CI on the default
// branch writes them under its commit, a branch with none imports its
// merge-base's, and the blob can only order a run.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import {
  Cache,
  LocalHistoryProvider,
  taskDefinitions,
  type PluginCache,
  type TaskNode,
} from '@vzn/vx'
import { scheduleHistoryPlugin } from '../src/index.js'
import { importTimings, parseTimings } from '../src/shared-timings.js'

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
}

let root: string
let cache: Cache
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'vx-shared-timings-'))
  git('init', '-q', '-b', 'main')
  cache = new Cache(path.join(root, '.vx', 'cache'), { read: true, write: true })
  said = []
})
afterEach(() => {
  cache.close()
  rmSync(root, { recursive: true, force: true })
  expect(said).toEqual([])
})

function git(...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd: root, env: GIT_ENV })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

function commit(): string {
  git('commit', '-q', '--allow-empty', '-m', 'c')
  return git('rev-parse', 'HEAD')
}

/** A timing this machine recorded on `branch`. */
function timed(branch: string, id: string, ms: number): void {
  const [project, task] = id.split('#')
  cache
    .dbHandle()
    .query(
      'INSERT INTO task_durations(project, task, source, sha, duration_ms, recorded_at, def) VALUES (?, ?, ?, NULL, ?, ?, ?)',
    )
    .run(project!, task!, `branch:${branch}`, ms, Date.now(), defOf(id))
}

interface Spy extends PluginCache {
  /** The default branch's entries. */
  store: Map<string, Uint8Array>
  /** The run's scope's entries: a scoped read's, and a put's when `scoped`. */
  scoped: Map<string, Uint8Array>
  /** A scoped read is `get!`. */
  calls: string[]
}

function spyCache(opts: { hang?: boolean; scoped?: boolean } = {}): Spy {
  const store = new Map<string, Uint8Array>()
  const scoped = new Map<string, Uint8Array>()
  const calls: string[] = []
  const never = new Promise<never>(() => {})
  return {
    store,
    scoped,
    calls,
    async get(k, fromScope = true) {
      calls.push(fromScope ? 'get!' : 'get')
      if (opts.hang) return never
      return (fromScope ? scoped : store).get(k) ?? null
    },
    async put(k, b) {
      calls.push('put')
      const into = opts.scoped ? scoped : store
      if (!into.has(k)) into.set(k, b)
    },
    async has(k) {
      calls.push('has')
      return store.has(k)
    },
    async hasMany(ks) {
      calls.push('hasMany')
      if (opts.hang) return never
      return new Set(ks.filter((k) => store.has(k)))
    },
    async getRun() {
      return null
    },
  }
}

// Every test task is `node(id)`: a blob's timing is of it.
const defOf = (id: string): string => taskDefinitions([node(id)]).get(id)!
const defsOf = (ids: Iterable<string>): Record<string, string> =>
  Object.fromEntries([...ids].map((id) => [id, defOf(id)]))
const blob = (tasks: Record<string, unknown>, version: unknown = 2): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ version, tasks, defs: defsOf(Object.keys(tasks)) }))
/** A written blob, its `defs` aside: each test task's is `defOf`. */
const read = (b: Uint8Array | undefined): unknown => {
  if (b === undefined) return undefined
  const { defs: _, ...rest } = JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>
  return rest
}
const defsIn = (b: Uint8Array | undefined): unknown =>
  (JSON.parse(new TextDecoder().decode(b)) as { defs?: unknown }).defs
const key = (sha: string): string => `timings\0${sha}`

function node(id: string): TaskNode {
  const [projectName, taskName] = id.split('#') as [string, string]
  return {
    id,
    projectName,
    projectDir: path.join(root, projectName),
    taskName,
    config: { exec: { command: 'echo' } } as TaskNode['config'],
    deps: [],
    requested: true,
  }
}

/** What an import said: a test that expects a warning reads it; the rest expect none. */
let said: string[] = []
const triedFile = (): string => path.join(root, '.vx', 'cache', 'schedule-history-base')

/** One run of the plugin's hooks, as core calls them: setup, schedule, teardown. */
async function runPlugin(
  shared: PluginCache,
  opts: {
    ci: boolean
    branch: string
    ids: string[]
    /** Tasks with no command: a group. */
    groups?: string[]
    during?: () => void
    refined?: ReadonlyMap<string, number>[]
    /** The run ends before a promised refine lands; by default it outlasts it. */
    short?: boolean
  },
): Promise<ReadonlyMap<string, number> | undefined> {
  const plugin = scheduleHistoryPlugin({ resources: false })
  const base = {
    workspaceRoot: root,
    cacheDir: path.join(root, '.vx', 'cache'),
    warn: (m: string) => void said.push(m),
  }
  await plugin.setup!({
    ...base,
    cache: shared,
    ci: opts.ci,
    branch: opts.branch,
    on: () => {},
    secret: () => Promise.reject(new Error('no secrets here')),
    forgetSecret: async () => {},
  })
  const refines: Promise<void>[] = []
  const nodes = new Map(opts.ids.map((id) => [id, node(id)]))
  for (const id of opts.groups ?? [])
    nodes.set(id, { ...node(id), config: {} as TaskNode['config'] })
  const weights = await plugin.schedule!(nodes, {
    ...base,
    localCache: cache,
    branch: opts.branch,
    cache: shared,
    // Promised: the weights it resolves to, as core takes them.
    refine: (w) =>
      void refines.push(
        Promise.resolve(w).then((x) => {
          if (x !== undefined) opts.refined?.push(x)
        }),
      ),
    onRefine: () => {},
    refining: async () => {},
  })
  opts.during?.()
  if (opts.short !== true) await Promise.all(refines)
  await plugin.teardown!()
  return weights
}

describe('shared timings', () => {
  // A job cannot tell a task the repo dropped from one only another job
  // runs, so every task is carried (owner, 2026-10-22).
  it('CI on main writes its commit blob: the parent blob, every task of it, merged with this run', async () => {
    const a = commit()
    const b = commit()
    const shared = spyCache()
    shared.store.set(key(a), blob({ 'p#x': 100, 'p#y': 50, 'p#gone': 5 }))
    await runPlugin(shared, {
      ci: true,
      branch: 'main',
      ids: ['p#x', 'p#y'],
      during: () => timed('main', 'p#y', 300),
    })
    expect(read(shared.store.get(key(b)))).toEqual({
      version: 3,
      tasks: { 'p#gone': 5, 'p#x': 100, 'p#y': 300 },
    })
    // Each timing says which task it is of, a carried one's carried.
    expect(defsIn(shared.store.get(key(b)))).toEqual(defsOf(['p#gone', 'p#x', 'p#y']))
  })

  it('a local run never writes', async () => {
    commit()
    const shared = spyCache()
    timed('main', 'p#x', 10)
    await runPlugin(shared, { ci: false, branch: 'main', ids: ['p#x'] })
    expect(shared.calls.filter((c) => c === 'put')).toEqual([])
  })

  it('CI on a branch writes its commit blob under its scope', async () => {
    commit()
    git('checkout', '-q', '-b', 'feature')
    const head = commit()
    const shared = spyCache({ scoped: true })
    timed('feature', 'p#x', 10)
    await runPlugin(shared, { ci: true, branch: 'feature', ids: ['p#x'] })
    expect(read(shared.scoped.get(key(head)))).toEqual({ version: 3, tasks: { 'p#x': 10 } })
    expect(shared.store.size).toBe(0)
  })

  it("a branch reads its last commit's blob over the merge-base's: its tasks win, the rest keep main's", async () => {
    const a = commit()
    git('checkout', '-q', '-b', 'feature')
    const parent = commit()
    commit()
    const shared = spyCache()
    shared.store.set(key(a), blob({ 'p#x': 100, 'p#y': 50 }))
    shared.scoped.set(key(parent), blob({ 'p#x': 7 }))
    const provider = new LocalHistoryProvider(cache.dbHandle(), undefined, 'feature')
    await importTimings({
      root,
      defaultBranch: 'main',
      cache: shared,
      provider,
      ids: ['p#x', 'p#y'],
      warn: (m: string) => said.push(m),
      triedFile: triedFile(),
      branch: true,
    })
    expect(Object.fromEntries(await provider.p50sFor(['p#x', 'p#y']))).toEqual({
      'p#x': 7,
      'p#y': 50,
    })
    // The parent's blob for this graph first, then its plain one.
    expect(shared.calls).toEqual(['hasMany', 'get', 'get!', 'get!'])
  })

  // Every CI job of a commit writes its own graph's tasks, and the first
  // job's plain blob wins: the dte job's shards read a blob without them,
  // and each took a whole agent (2026-10-22).
  it("each job's graph keeps its own blob, which a run of that graph reads first", async () => {
    const a = commit()
    const shared = spyCache()
    timed('main', 'p#bench', 5)
    timed('main', 'p#shard', 100)
    await runPlugin(shared, { ci: true, branch: 'main', ids: ['p#bench'] })
    await runPlugin(shared, { ci: true, branch: 'main', ids: ['p#shard'] })
    expect(read(shared.store.get(key(a)))).toEqual({ version: 3, tasks: { 'p#bench': 5 } })
    git('checkout', '-q', '-b', 'feature')
    commit()
    const provider = new LocalHistoryProvider(
      new Cache(path.join(root, 'fresh'), { read: true, write: true }).dbHandle(),
      undefined,
      'feature',
    )
    await importTimings({
      root,
      defaultBranch: 'main',
      cache: shared,
      provider,
      ids: ['p#shard'],
      warn: (m: string) => said.push(m),
      triedFile: triedFile(),
      branch: false,
    })
    expect(Object.fromEntries(await provider.p50sFor(['p#shard']))).toEqual({ 'p#shard': 100 })
  })

  /** One CI job on main: its own machine, which timed `times`. */
  async function job(shared: PluginCache, times: Record<string, number>): Promise<void> {
    const main = cache
    cache = new Cache(mkdtempSync(path.join(root, 'job-')), { read: true, write: true })
    try {
      for (const [id, ms] of Object.entries(times)) timed('main', id, ms)
      await runPlugin(shared, { ci: true, branch: 'main', ids: Object.keys(times) })
    } finally {
      cache.close()
      cache = main
    }
  }

  /** What a branch off HEAD whose graph is `ids` imports, on a fresh machine. */
  async function imported(shared: PluginCache, ids: string[]): Promise<Record<string, number>> {
    const fresh = new Cache(mkdtempSync(path.join(root, 'branch-')), { read: true, write: true })
    try {
      const provider = new LocalHistoryProvider(fresh.dbHandle(), undefined, 'feature')
      await importTimings({
        root,
        defaultBranch: 'main',
        cache: shared,
        provider,
        ids,
        warn: (m: string) => said.push(m),
        triedFile: path.join(root, `tried-${ids.join('-')}`),
        branch: false,
      })
      return Object.fromEntries(await provider.p50sFor(ids))
    } finally {
      fresh.close()
    }
  }

  // Keyed by its whole graph, a job's own blob was lost to any change of
  // its task set, and a task two jobs share kept whichever wrote first
  // (2026-10-22).
  it('two jobs whose task sets overlap each read their own tasks back', async () => {
    commit()
    const shared = spyCache()
    await job(shared, { 'p#x': 110, 'p#y': 60 })
    await job(shared, { 'p#y': 70, 'p#z': 80 })
    git('checkout', '-q', '-b', 'feature')
    commit()
    expect(await imported(shared, ['p#x', 'p#y'])).toEqual({ 'p#x': 110, 'p#y': 60 })
    expect(await imported(shared, ['p#y', 'p#z'])).toEqual({ 'p#y': 70, 'p#z': 80 })
  })

  it('a job whose task set changed still reads every task', async () => {
    commit()
    const shared = spyCache()
    await job(shared, { 'p#x': 100, 'p#y': 50, 'p#z': 30 })
    commit()
    await job(shared, { 'p#x': 110, 'p#y': 60 })
    await job(shared, { 'p#z': 40 })
    git('checkout', '-q', '-b', 'feature')
    commit()
    // No job ran {x, z}: the commit's plain blob, which carries z.
    expect(await imported(shared, ['p#x', 'p#z'])).toEqual({ 'p#x': 110, 'p#z': 30 })
  })

  it("a branch with no history orders from local history at once, then re-ranks by its merge-base's blob", async () => {
    const a = commit()
    git('checkout', '-q', '-b', 'feature')
    commit()
    let answer: () => void = () => {}
    const answered = new Promise<void>((r) => (answer = r))
    const shared = spyCache()
    const get = shared.get.bind(shared)
    // The blob arrives only after the schedule answer: the run never waits on it.
    shared.get = async (k, scoped) => (await answered, get(k, scoped))
    shared.store.set(key(a), blob({ 'p#slow': 9_000, 'p#fast': 10 }))
    const refined: ReadonlyMap<string, number>[] = []
    const weights = await runPlugin(shared, {
      ci: false,
      branch: 'feature',
      ids: ['p#slow', 'p#fast'],
      during: answer,
      refined,
    })
    expect(weights?.get('p#slow')).not.toBe(9_000)
    expect(refined.map((w) => [w.get('p#slow'), w.get('p#fast')])).toEqual([[9_000, 10]])
  })

  it('a merge-base with no blob is asked once', async () => {
    commit()
    const shared = spyCache()
    for (let i = 0; i < 2; i++) {
      const provider = new LocalHistoryProvider(cache.dbHandle(), undefined, 'feature')
      await importTimings({
        root,
        defaultBranch: 'main',
        cache: shared,
        provider,
        ids: ['p#x'],
        warn: (m: string) => said.push(m),
        triedFile: triedFile(),
        branch: false,
      })
    }
    expect(shared.calls).toEqual(['hasMany'])
  })

  it('walks back up to five commits from the merge-base for a blob', async () => {
    const a = commit()
    for (let i = 0; i < 4; i++) commit()
    const shared = spyCache()
    shared.store.set(key(a), blob({ 'p#x': 42 }))
    const provider = new LocalHistoryProvider(cache.dbHandle(), undefined, 'main')
    await importTimings({
      root,
      defaultBranch: 'main',
      cache: shared,
      provider,
      ids: ['p#x'],
      warn: (m: string) => said.push(m),
      triedFile: triedFile(),
      branch: false,
    })
    expect((await provider.p50sFor(['p#x'])).get('p#x')).toBe(42)
    expect(shared.calls).toEqual(['hasMany', 'get'])
  })

  // M, 2026-10-23: a remote's failure is at least a warning, never a silent miss.
  it('a remote that fails the read is said, and the run orders without it', async () => {
    commit()
    const shared = spyCache()
    shared.hasMany = () => Promise.reject(new Error('HTTP 403: forbidden'))
    const provider = new LocalHistoryProvider(cache.dbHandle(), undefined, 'main')
    const imported = await importTimings({
      root,
      defaultBranch: 'main',
      cache: shared,
      provider,
      ids: ['p#x'],
      warn: (m: string) => said.push(m),
      triedFile: triedFile(),
      branch: false,
    })
    expect(imported).toBe(false)
    expect(said.splice(0)).toEqual([
      '[vx] schedule-history: the shared timings could not be read: HTTP 403: forbidden',
    ])
  })

  it('a blob it cannot read is said by commit and size', async () => {
    const a = commit()
    const shared = spyCache()
    shared.store.set(key(a), new TextEncoder().encode('<html>proxy</html>'))
    const provider = new LocalHistoryProvider(cache.dbHandle(), undefined, 'main')
    await importTimings({
      root,
      defaultBranch: 'main',
      cache: shared,
      provider,
      ids: ['p#x'],
      warn: (m: string) => said.push(m),
      triedFile: triedFile(),
      branch: false,
    })
    expect(said.splice(0)).toEqual([
      `[vx] schedule-history: ${a.slice(0, 12)}'s shared timings are unreadable (18 B: past 1048576 B or not a timings blob)`,
    ])
  })

  it('a write the remote refuses is said', async () => {
    commit()
    const shared = spyCache()
    shared.put = () => Promise.reject(new Error('HTTP 507: quota exceeded'))
    timed('main', 'p#x', 10)
    await runPlugin(shared, { ci: true, branch: 'main', ids: ['p#x'] })
    expect(said.splice(0)).toEqual([
      '[vx] schedule-history: the shared timings were not written: HTTP 507: quota exceeded',
    ])
  })

  it('a remote that never answers costs at most the deadline, and the run orders without it', async () => {
    commit()
    const provider = new LocalHistoryProvider(cache.dbHandle(), undefined, 'main')
    const started = performance.now()
    await importTimings({
      root,
      defaultBranch: 'main',
      cache: spyCache({ hang: true }),
      provider,
      ids: ['p#x'],
      warn: (m: string) => said.push(m),
      triedFile: triedFile(),
      branch: false,
    })
    expect(performance.now() - started).toBeLessThan(7_000)
    expect((await provider.p50sFor(['p#x'])).size).toBe(0)
  }, 10_000)

  // Owner, 2026-10-23: "without dte we should not wait for hisotry".
  it("a run's end stops the import: its teardown waits on no remote", async () => {
    commit()
    git('checkout', '-q', '-b', 'feature')
    commit()
    const started = performance.now()
    await runPlugin(spyCache({ hang: true }), {
      ci: false,
      branch: 'feature',
      ids: ['p#x'],
      short: true,
    })
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it('every task has current-branch history: no git spawn, no fetch', async () => {
    commit()
    timed('main', 'p#x', 10)
    const shared = spyCache()
    const spawn = spyOn(Bun, 'spawn')
    try {
      await runPlugin(shared, { ci: false, branch: 'main', ids: ['p#x'] })
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      spawn.mockRestore()
    }
    expect(shared.calls).toEqual([])
  })

  // A group runs nothing, so no branch ever times it: asked for, it read as
  // a task lacking this branch's history, and every run tried an import.
  it('a group lacks no history: no git spawn, no fetch', async () => {
    commit()
    timed('main', 'p#x', 10)
    const shared = spyCache()
    const spawn = spyOn(Bun, 'spawn')
    try {
      await runPlugin(shared, { ci: false, branch: 'main', ids: ['p#x'], groups: ['p#all'] })
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      spawn.mockRestore()
    }
    expect(shared.calls).toEqual([])
  })

  it('two runs on one merge-base make one fetch and no duplicate rows', async () => {
    const a = commit()
    const shared = spyCache()
    shared.store.set(key(a), blob({ 'p#x': 42 }))
    for (let i = 0; i < 2; i++) {
      const provider = new LocalHistoryProvider(cache.dbHandle(), undefined, 'feature')
      await importTimings({
        root,
        defaultBranch: 'main',
        cache: shared,
        provider,
        ids: ['p#x'],
        warn: (m: string) => said.push(m),
        triedFile: triedFile(),
        branch: false,
      })
    }
    expect(shared.calls.filter((c) => c === 'get')).toHaveLength(1)
    const rows = cache
      .dbHandle()
      .query("SELECT COUNT(*) AS n FROM task_durations WHERE source = 'remote'")
      .get() as { n: number }
    expect(rows.n).toBe(1)
  })

  // A fresh CI machine has no run of a task: it packs by the need the
  // default branch measured, carried in the blob, and passes it on.
  it("carries each task's measured need: a fresh machine reads it, and CI on main writes it on", async () => {
    const a = commit()
    const b = commit()
    const shared = spyCache()
    shared.store.set(
      key(a),
      new TextEncoder().encode(
        JSON.stringify({
          version: 3,
          tasks: { 'p#x': 100, 'p#y': 50, 'p#z': 5 },
          defs: defsOf(['p#x', 'p#y', 'p#z']),
          needs: {
            'p#x': { cpu: 3.5, rss: 2e9, cores: 4 },
            'p#y': { cpu: -1 },
            'p#z': { cpu: 1, rss: 'big' },
            'q#gone': { cpu: 2 },
          },
        }),
      ),
    )
    await runPlugin(shared, { ci: true, branch: 'main', ids: ['p#x', 'p#y', 'p#z'] })
    const provider = new LocalHistoryProvider(cache.dbHandle(), undefined, 'main')
    const got = await provider.resourcesFor(['p#x', 'p#y', 'p#z'])
    expect(got.get('p#x')).toEqual({
      p50DurationMs: 100,
      maxCpuParallelism: 3.5,
      maxPeakRssBytes: 2e9,
      saturatedCores: 4,
    })
    expect(got.get('p#y')).toEqual({ p50DurationMs: 50 })
    expect(got.get('p#z')).toEqual({ p50DurationMs: 5, maxCpuParallelism: 1 })
    expect((read(shared.store.get(key(b))) as { needs: unknown }).needs).toEqual({
      'p#x': { cpu: 3.5, rss: 2e9, cores: 4 },
      'p#z': { cpu: 1 },
    })
  })

  // A task whose command changed under its name is a new task (M, 2026-10-23).
  it("an imported timing of the task's old definition is not read", async () => {
    const a = commit()
    git('checkout', '-q', '-b', 'feature')
    commit()
    const shared = spyCache()
    shared.store.set(
      key(a),
      new TextEncoder().encode(
        JSON.stringify({
          version: 3,
          tasks: { 'p#x': 100, 'p#y': 50 },
          defs: { 'p#x': 'old', ...defsOf(['p#y']) },
        }),
      ),
    )
    const provider = new LocalHistoryProvider(
      cache.dbHandle(),
      undefined,
      'feature',
      taskDefinitions([node('p#x'), node('p#y')]),
    )
    await importTimings({
      root,
      defaultBranch: 'main',
      cache: shared,
      provider,
      ids: ['p#x', 'p#y'],
      warn: (m: string) => said.push(m),
      triedFile: triedFile(),
      branch: false,
    })
    expect([...(await provider.p50sFor(['p#x', 'p#y']))]).toEqual([['p#y', 50]])
  })

  // PR #4150: main's blob, shared before definitions were kept, carried
  // every need; the branch's own blob had definitions and no needs, and
  // the run packed every task unmeasured.
  it('a need shared before definitions is read beside a branch blob that has them', async () => {
    const a = commit()
    git('checkout', '-q', '-b', 'feature')
    const b = commit()
    commit()
    const shared = spyCache()
    const put = (sha: string, body: object): void => {
      shared.store.set(key(sha), new TextEncoder().encode(JSON.stringify({ version: 3, ...body })))
    }
    put(a, { tasks: { 'p#x': 100 }, needs: { 'p#x': { cpu: 3 } } })
    put(b, { tasks: { 'p#x': 120 }, defs: defsOf(['p#x']) })
    const provider = new LocalHistoryProvider(
      cache.dbHandle(),
      undefined,
      'feature',
      taskDefinitions([node('p#x')]),
    )
    await importTimings({
      root,
      defaultBranch: 'main',
      cache: shared,
      provider,
      ids: ['p#x'],
      warn: (m: string) => said.push(m),
      triedFile: triedFile(),
      branch: true,
    })
    expect((await provider.resourcesFor(['p#x'])).get('p#x')?.maxCpuParallelism).toBe(3)
  })

  // PR #4150: a need of no definition (a blob shared before they were
  // kept) was dropped on the write, so main's next blob carried none.
  it('CI on main carries on a need shared before definitions were kept', async () => {
    const a = commit()
    const b = commit()
    const shared = spyCache()
    shared.store.set(
      key(a),
      new TextEncoder().encode(
        JSON.stringify({ version: 3, tasks: { 'p#x': 100 }, needs: { 'p#x': { cpu: 3 } } }),
      ),
    )
    await runPlugin(shared, { ci: true, branch: 'main', ids: ['p#x'] })
    expect((read(shared.store.get(key(b))) as { needs: unknown }).needs).toEqual({
      'p#x': { cpu: 3 },
    })
  })

  // Main c27c238: a version 1 blob's needs were each test shard's share of
  // a crowded worker (0.36 of a core for one that takes 1.1), and the next
  // run packed nine shards on 4 cores; main 357d3aa: a version 2 blob's
  // Mac needs carried no share and packed six shards on 3 cores. Their
  // timings stand; their needs go.
  it.each([1, 2])(
    "reads a version %d blob's timings, not its needs, and main writes none of them on",
    async (version) => {
      const a = commit()
      const b = commit()
      const shared = spyCache()
      shared.store.set(
        key(a),
        new TextEncoder().encode(
          JSON.stringify({
            version,
            tasks: { 'p#x': 100 },
            defs: defsOf(['p#x']),
            needs: { 'p#x': { cpu: 0.36 } },
          }),
        ),
      )
      const provider = new LocalHistoryProvider(
        cache.dbHandle(),
        undefined,
        'main',
        taskDefinitions([node('p#x')]),
      )
      await importTimings({
        root,
        defaultBranch: 'main',
        cache: shared,
        provider,
        ids: ['p#x'],
        warn: (m: string) => said.push(m),
        triedFile: triedFile(),
        branch: true,
      })
      expect([...(await provider.p50sFor(['p#x']))]).toEqual([['p#x', 100]])
      expect((await provider.resourcesFor(['p#x'])).get('p#x')?.maxCpuParallelism).toBeUndefined()
      await runPlugin(shared, { ci: true, branch: 'main', ids: ['p#x'] })
      expect(read(shared.store.get(key(b)))).toEqual({ version: 3, tasks: { 'p#x': 100 } })
    },
  )

  it('drops oversized, malformed, out-of-range and non-graph entries', () => {
    const graph = new Set(['p#a', 'p#b', 'p#c', 'p#d', 'p#e', 'p#f'])
    expect(
      parseTimings(
        blob({
          'p#a': 1,
          'p#b': -1,
          'p#c': 'x',
          'p#d': Number.MAX_VALUE,
          'p#e': 86_400_001,
          'p#f': 86_400_000,
          'q#z': 5,
        }),
        graph,
      ),
    ).toEqual(
      new Map([
        ['p#a', 1],
        ['p#f', 86_400_000],
      ]),
    )
    expect(parseTimings(blob({ 'p#a': 1 }, 4), graph)).toBeNull()
    expect(parseTimings(new TextEncoder().encode('{'), graph)).toBeNull()
    expect(parseTimings(new TextEncoder().encode('[1]'), graph)).toBeNull()
    expect(parseTimings(new TextEncoder().encode('null'), graph)).toBeNull()
    expect(parseTimings(new Uint8Array(1024 * 1024 + 1), graph)).toBeNull()
    const many: Record<string, number> = {}
    for (let i = 0; i <= 50_000; i++) many[`p#${i}`] = 1
    expect(parseTimings(blob(many), graph)).toBeNull()
  })
})
