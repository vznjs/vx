// Task timings through the workspace's cache (design
// packages/vx/docs/design/shared-timings-2026-10.md): CI on the default
// branch writes them under its commit, a branch with none imports its
// merge-base's, and the blob can only order a run.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Cache, LocalHistoryProvider, type PluginCache, type TaskNode } from '@vzn/vx'
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
})
afterEach(() => {
  cache.close()
  rmSync(root, { recursive: true, force: true })
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
      'INSERT INTO task_durations(project, task, source, sha, duration_ms, recorded_at) VALUES (?, ?, ?, NULL, ?, ?)',
    )
    .run(project!, task!, `branch:${branch}`, ms, Date.now())
}

interface Spy extends PluginCache {
  store: Map<string, Uint8Array>
  calls: string[]
}

function spyCache(opts: { hang?: boolean } = {}): Spy {
  const store = new Map<string, Uint8Array>()
  const calls: string[] = []
  const never = new Promise<never>(() => {})
  return {
    store,
    calls,
    async get(k) {
      calls.push('get')
      if (opts.hang) return never
      return store.get(k) ?? null
    },
    async put(k, b) {
      calls.push('put')
      if (!store.has(k)) store.set(k, b)
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

const blob = (tasks: Record<string, unknown>, version: unknown = 1): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ version, tasks }))
const read = (b: Uint8Array | undefined): unknown =>
  b === undefined ? undefined : JSON.parse(new TextDecoder().decode(b))
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
  },
): Promise<ReadonlyMap<string, number> | undefined> {
  const plugin = scheduleHistoryPlugin({ resources: false })
  const base = { workspaceRoot: root, cacheDir: path.join(root, '.vx', 'cache'), warn: () => {} }
  await plugin.setup!({
    ...base,
    cache: shared,
    ci: opts.ci,
    branch: opts.branch,
    on: () => {},
    secret: () => Promise.reject(new Error('no secrets here')),
    forgetSecret: async () => {},
  })
  const nodes = new Map(opts.ids.map((id) => [id, node(id)]))
  for (const id of opts.groups ?? [])
    nodes.set(id, { ...node(id), config: {} as TaskNode['config'] })
  const weights = await plugin.schedule!(nodes, {
    ...base,
    localCache: cache,
    branch: opts.branch,
    cache: shared,
    refine: (w) => opts.refined?.push(w),
  })
  opts.during?.()
  await plugin.teardown!()
  return weights
}

describe('shared timings', () => {
  it('CI on main writes its commit blob: the parent blob merged with this run, minus removed tasks', async () => {
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
      version: 1,
      tasks: { 'p#x': 100, 'p#y': 300 },
    })
  })

  it('a local run never writes, nor CI on another branch', async () => {
    commit()
    const shared = spyCache()
    timed('main', 'p#x', 10)
    await runPlugin(shared, { ci: false, branch: 'main', ids: ['p#x'] })
    git('checkout', '-q', '-b', 'feature')
    timed('feature', 'p#x', 10)
    await runPlugin(shared, { ci: true, branch: 'feature', ids: ['p#x'] })
    expect(shared.calls.filter((c) => c === 'put')).toEqual([])
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
    shared.get = async (k) => (await answered, get(k))
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
        triedFile: triedFile(),
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
      triedFile: triedFile(),
    })
    expect((await provider.p50sFor(['p#x'])).get('p#x')).toBe(42)
    expect(shared.calls).toEqual(['hasMany', 'get'])
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
      triedFile: triedFile(),
    })
    expect(performance.now() - started).toBeLessThan(2_000)
    expect((await provider.p50sFor(['p#x'])).size).toBe(0)
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
        triedFile: triedFile(),
      })
    }
    expect(shared.calls.filter((c) => c === 'get')).toHaveLength(1)
    const rows = cache
      .dbHandle()
      .query("SELECT COUNT(*) AS n FROM task_durations WHERE source = 'remote'")
      .get() as { n: number }
    expect(rows.n).toBe(1)
  })

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
    expect(parseTimings(blob({ 'p#a': 1 }, 2), graph)).toBeNull()
    expect(parseTimings(new TextEncoder().encode('{'), graph)).toBeNull()
    expect(parseTimings(new TextEncoder().encode('[1]'), graph)).toBeNull()
    expect(parseTimings(new TextEncoder().encode('null'), graph)).toBeNull()
    expect(parseTimings(new Uint8Array(1024 * 1024 + 1), graph)).toBeNull()
    const many: Record<string, number> = {}
    for (let i = 0; i <= 50_000; i++) many[`p#${i}`] = 1
    expect(parseTimings(blob(many), graph)).toBeNull()
  })
})
