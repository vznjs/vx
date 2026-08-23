// `src/orchestrator/plan.ts` — the PREDICTION half of planning mode
// (`vx run --dry` / `--graph`). Its sibling `tests/plan-format.test.ts`
// covers the rendering of a `RunPlan`; nothing there constructs one.
//
// Three properties this file guards, all of which have shipped as real
// defects in this codebase's history:
//   - planning is READ-ONLY. `--dry` must not spawn a task, must not clean
//     a declared output tree, must not record run history, must not touch
//     an entry's `accessed_at`.
//   - the plan describes the run you are ABOUT to get. `plan()` and `run()`
//     must derive the same EFFECTIVE cache policy from the same request
//     (the 2026-07-27 `effectiveCachePolicy` clamp exists because they had
//     drifted: `--cache=local:,remote:rw` with no remote layer planned as
//     "cache miss — would exec" for a run in which caching was entirely off).
//   - the time prediction is a lower bound built from recorded p50s, never
//     an invention: hits/groups cost nothing and a would-run task with no
//     history is COUNTED rather than guessed at.
//
// The unit half drives `plan()` directly with a stub `CacheLayer` and a
// pre-seeded `GitFilesCache` (so no git spawn, no filesystem, no temp dirs)
// — that is what makes the p50 arithmetic exactly assertable. The e2e half
// drives the real `planRun()` over a real workspace, because "executed
// nothing" and "same policy as the run" can only be proven against the real
// executor.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { writeLocalWorkspace } from './helpers/local-workspace.js'
import { Database } from 'bun:sqlite'
import { type CacheLayer, type CachePolicy, GitFilesCache } from '../src/cache/index.js'
import type { TaskNode } from '../src/graph/index.js'
import type { HistoryProvider, HistoryTable, TaskHistory } from '../src/orchestrator/history.js'
import type { Logger } from '../src/orchestrator/index.js'
import { planRun, run } from '../src/orchestrator/index.js'
import { plan, type CacheStatus, type RunPlan } from '../src/orchestrator/plan.js'
import { UserError } from '../src/util/index.js'

const TIMEOUT = 30_000

// ---------------------------------------------------------------------------
// Unit harness: `plan()` with no I/O.
// ---------------------------------------------------------------------------

const WS_ROOT = '/vx-plan-unit'
const PROJECT_DIR = `${WS_ROOT}/packages/p`

interface NodeSpec {
  /** Task id; `<project>#<task>`. */
  id: string
  deps?: string[]
  /** A group task (no `exec`) — the umbrella `vx run ci` shape. */
  group?: boolean
  /** Declares a `cache` block. Default true; false = opts out of caching. */
  cacheable?: boolean
}

function makeNode(spec: NodeSpec): TaskNode {
  const [project = '', task = ''] = spec.id.split('#')
  const cacheable = spec.cacheable ?? true
  return {
    id: spec.id,
    projectName: project,
    projectDir: PROJECT_DIR,
    taskName: task,
    config: {
      ...(spec.group ? {} : { exec: { command: `echo ${task}` } }),
      ...(cacheable && !spec.group
        ? { cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } }
        : {}),
    },
    deps: spec.deps ?? [],
    requested: true,
  } as unknown as TaskNode
}

function makeNodes(specs: NodeSpec[]): Map<string, TaskNode> {
  const nodes = new Map<string, TaskNode>()
  for (const spec of specs) nodes.set(spec.id, makeNode(spec))
  return nodes
}

interface StubCache {
  layer: CacheLayer
  /** Every hash handed to `has()`, in call order. */
  probes: string[]
}

/**
 * A `CacheLayer` exposing only what `plan()` reaches: `key` (through
 * `computeTaskHash`), `has` (the existence probe) and `hashFile` (through
 * the project package.json fold). Anything else being called is itself a
 * regression — planning must move no bytes.
 */
function stubCache(where: (hash: string) => 'local' | 'remote' | null = () => null): StubCache {
  const probes: string[] = []
  const layer = {
    hasRemote: false,
    async key(input: { taskId: string }): Promise<string> {
      // Deterministic per-task key: `has()` can then be keyed on task id.
      return `h:${input.taskId}`
    },
    async has(hash: string): Promise<'local' | 'remote' | null> {
      probes.push(hash)
      return where(hash)
    },
    async hashFile(): Promise<string> {
      return 'pkgjson'
    },
  } as unknown as CacheLayer
  return { layer, probes }
}

/** A `GitFilesCache` pre-seeded empty, so input resolution never spawns git. */
function seededGitCache(): GitFilesCache {
  const git = new GitFilesCache()
  git.set(PROJECT_DIR, [])
  git.set(WS_ROOT, [])
  return git
}

function history(p50: number | undefined): TaskHistory {
  return {
    runs: 5,
    p50DurationMs: p50,
    p99DurationMs: p50,
    successRate: 1,
    hitRate: 0,
    failureMode: 'stable',
  }
}

interface StubHistory {
  provider: HistoryProvider
  /** The id list `plan()` asked for, or undefined if it never asked. */
  asked: string[] | undefined
}

function stubHistory(p50ById: Record<string, number>): StubHistory {
  const state: StubHistory = {
    asked: undefined,
    provider: {
      async loadFor(ids: readonly string[]): Promise<HistoryTable> {
        state.asked = [...ids]
        // Deliberately answer for EVERY id we know about, not just the ones
        // asked for: a provider is free to over-answer, and the prediction
        // must still refuse to cost a hit or a group.
        return new Map(Object.entries(p50ById).map(([id, ms]) => [id, history(ms)]))
      },
    },
  }
  return state
}

async function planUnit(args: {
  nodes: Map<string, TaskNode>
  cache: CacheLayer
  cachePolicy?: CachePolicy
  history?: HistoryProvider
}): Promise<RunPlan> {
  return plan({
    nodes: args.nodes,
    workspaceRoot: WS_ROOT,
    workspaceFingerprint: 'fingerprint',
    cache: args.cache,
    nestedDirsByProject: new Map(),
    gitFilesCache: seededGitCache(),
    ...(args.cachePolicy !== undefined ? { cachePolicy: args.cachePolicy } : {}),
    ...(args.history !== undefined ? { history: args.history } : {}),
  })
}

function statusById(p: RunPlan): Record<string, CacheStatus> {
  return Object.fromEntries(p.tasks.map((t) => [t.node.id, t.cacheStatus]))
}

// The four axes, spelled out so each case below reads as the `--cache` spec
// a user would actually type.
const FULL: CachePolicy = {
  localRead: true,
  localWrite: true,
  remoteRead: true,
  remoteWrite: true,
}
const NO_CACHE: CachePolicy = {
  localRead: false,
  localWrite: false,
  remoteRead: false,
  remoteWrite: false,
}
/** `--force`: skip reads, keep writes (re-execute AND refresh the cache). */
const FORCE: CachePolicy = {
  localRead: false,
  localWrite: true,
  remoteRead: false,
  remoteWrite: true,
}
/** `--cache=local:r`: serve hits, store nothing. */
const LOCAL_READ_ONLY: CachePolicy = {
  localRead: true,
  localWrite: false,
  remoteRead: false,
  remoteWrite: false,
}
/** `--cache=local:,remote:rw`: the axes that are inert without a remote layer. */
const REMOTE_ONLY: CachePolicy = {
  localRead: false,
  localWrite: false,
  remoteRead: true,
  remoteWrite: true,
}

describe('plan() — cache-status prediction', () => {
  it('names the layer holding each artifact, and marks a group as a group', async () => {
    const nodes = makeNodes([
      { id: 'a#warm' },
      { id: 'a#remote' },
      { id: 'a#cold' },
      { id: 'a#ci', group: true, deps: ['a#warm', 'a#remote', 'a#cold'] },
    ])
    const cache = stubCache((hash) =>
      hash === 'h:a#warm' ? 'local' : hash === 'h:a#remote' ? 'remote' : null,
    )
    // No cachePolicy passed — the default must be FULL, not "off".
    const p = await planUnit({ nodes, cache: cache.layer })

    expect(statusById(p)).toEqual({
      'a#warm': 'hit-local',
      'a#remote': 'hit-remote',
      'a#cold': 'miss',
      'a#ci': 'group',
    })
    // The group is never probed — it has no exec and no cache block, so a
    // probe would be a wasted round-trip on the remote layer.
    expect(cache.probes).not.toContain('h:a#ci')
    // `deps` is what the `--graph` DOT export draws edges from.
    expect(p.tasks.find((t) => t.node.id === 'a#ci')!.deps).toEqual([
      'a#warm',
      'a#remote',
      'a#cold',
    ])
    // Every real task carries the key the run would derive.
    expect(p.tasks.find((t) => t.node.id === 'a#cold')!.hash).toBe('h:a#cold')
  })

  it('reports a task that declares no cache block as no-cache without probing', async () => {
    const nodes = makeNodes([{ id: 'a#dev', cacheable: false }, { id: 'a#build' }])
    const cache = stubCache(() => 'local')
    const p = await planUnit({ nodes, cache: cache.layer })

    expect(statusById(p)).toEqual({ 'a#dev': 'no-cache', 'a#build': 'hit-local' })
    // Probing an uncacheable task would report a bogus hit for a task that
    // always executes — the probe must be gated on the cache block.
    expect(cache.probes).toEqual(['h:a#build'])
  })

  it('probes each cacheable task exactly once', async () => {
    const nodes = makeNodes([
      { id: 'a#one' },
      { id: 'a#two', deps: ['a#one'] },
      { id: 'a#three', deps: ['a#one'] },
    ])
    const cache = stubCache(() => null)
    await planUnit({ nodes, cache: cache.layer })

    // A duplicated probe is a doubled remote HEAD per task on `--dry`.
    expect(cache.probes.sort()).toEqual(['h:a#one', 'h:a#three', 'h:a#two'])
  })

  it('predicts no-cache and issues ZERO probes when neither read axis is on', async () => {
    // `--no-cache` and `--force` both re-execute everything, so a plan that
    // reported "cache hit" for them would describe a run that cannot happen.
    for (const policy of [NO_CACHE, FORCE]) {
      const nodes = makeNodes([{ id: 'a#build' }])
      const cache = stubCache(() => 'local')
      const p = await planUnit({ nodes, cache: cache.layer, cachePolicy: policy })
      expect(statusById(p)).toEqual({ 'a#build': 'no-cache' })
      expect(cache.probes).toEqual([])
    }
  })

  it('keeps predicting when only ONE read axis is on', async () => {
    // The gate is an OR over the two READ axes: a remote-read-only policy
    // still resolves hits, and a local-read-only one still probes.
    for (const policy of [LOCAL_READ_ONLY, REMOTE_ONLY]) {
      const nodes = makeNodes([{ id: 'a#build' }])
      const cache = stubCache(() => 'local')
      const p = await planUnit({ nodes, cache: cache.layer, cachePolicy: policy })
      expect(statusById(p)).toEqual({ 'a#build': 'hit-local' })
      expect(cache.probes).toEqual(['h:a#build'])
    }
  })

  it('reports miss (not hit) when the probe finds the artifact nowhere', async () => {
    const nodes = makeNodes([{ id: 'a#build' }])
    const cache = stubCache(() => null)
    const p = await planUnit({ nodes, cache: cache.layer, cachePolicy: FULL })
    expect(statusById(p)).toEqual({ 'a#build': 'miss' })
  })
})

describe('plan() — a key that cannot be derived', () => {
  it('degrades an underivable key AND its dependents to no-cache with an empty hash', async () => {
    // Reachable in production: `cache.inputs.runtime: ['<cmd>']` throws a
    // UserError when the probe command exits non-zero, so `computeTaskHash`
    // rejects. The scheduler then marks that task `failed` and SKIPS its
    // dependents without ever calling plan's execute closure — so neither
    // reaches `cacheStatusById`.
    //
    // KNOWN DEFECT, pinned as-is (plan.ts:147): the `?? 'no-cache'` fallback
    // conflates "this task opted out of caching" with "we never got to probe
    // it", and `hash: o.hash ?? ''` gives both an empty key. `--dry` reports
    // a cacheable task as uncacheable and still resolves, while the
    // equivalent `vx run` fails. See the e2e counterpart below.
    const nodes = makeNodes([{ id: 'a#codegen' }, { id: 'a#build', deps: ['a#codegen'] }])
    const cache = {
      hasRemote: false,
      async key(input: { taskId: string }): Promise<string> {
        if (input.taskId === 'a#codegen') throw new UserError('runtime command exited 3')
        return `h:${input.taskId}`
      },
      async has(): Promise<'local' | 'remote' | null> {
        return 'local'
      },
      async hashFile(): Promise<string> {
        return 'pkgjson'
      },
    } as unknown as CacheLayer

    const p = await planUnit({ nodes, cache })

    expect(statusById(p)).toEqual({ 'a#codegen': 'no-cache', 'a#build': 'no-cache' })
    expect(p.tasks.map((t) => t.hash)).toEqual(['', ''])
  })
})

describe('plan() — time prediction', () => {
  /** a → {b, c} → d. Longest chain is a → c → d. */
  const diamond: NodeSpec[] = [
    { id: 'a#root' },
    { id: 'a#left', deps: ['a#root'] },
    { id: 'a#right', deps: ['a#root'] },
    { id: 'a#join', deps: ['a#left', 'a#right'] },
  ]
  const diamondP50 = { 'a#root': 100, 'a#left': 50, 'a#right': 200, 'a#join': 30 }

  it('wallMs is the longest would-run chain; workMs the sum of all of them', async () => {
    const hist = stubHistory(diamondP50)
    const p = await planUnit({
      nodes: makeNodes(diamond),
      cache: stubCache(() => null).layer,
      history: hist.provider,
    })

    // Summing every task would give 380; taking the single slowest would give
    // 200. Only a real longest-path walk gives 100 + 200 + 30.
    expect(p.predicted).toEqual({ wallMs: 330, workMs: 380, unknownCount: 0 })
    // Each task also carries its own p50 for the per-line `~eta`.
    expect(p.tasks.find((t) => t.node.id === 'a#right')!.p50Ms).toBe(200)
  })

  it('computes the same prediction when nodes arrive in reverse topological order', async () => {
    // The Kahn pass must derive its own order — folding costs in map-insertion
    // order would understate the chain whenever dependents are inserted first.
    const reversed = [...diamond].reverse()
    const hist = stubHistory(diamondP50)
    const p = await planUnit({
      nodes: makeNodes(reversed),
      cache: stubCache(() => null).layer,
      history: hist.provider,
    })

    expect(p.predicted).toEqual({ wallMs: 330, workMs: 380, unknownCount: 0 })
  })

  it('costs a cache hit and a group at zero even when history has numbers for them', async () => {
    const nodes = makeNodes([{ id: 'a#warm' }, { id: 'a#ci', group: true, deps: ['a#warm'] }])
    const hist = stubHistory({ 'a#warm': 900, 'a#ci': 700 })
    const p = await planUnit({
      nodes,
      cache: stubCache(() => 'local').layer,
      history: hist.provider,
    })

    // A restore is a tar extract and a group runs nothing: a warm plan must
    // predict ~0, not the execution time the hit is SAVING.
    expect(statusById(p)['a#warm']).toBe('hit-local')
    expect(p.predicted).toEqual({ wallMs: 0, workMs: 0, unknownCount: 0 })
    // The p50 is still attached — plan-format shows it on would-run lines only.
    expect(p.tasks.find((t) => t.node.id === 'a#warm')!.p50Ms).toBe(900)
  })

  it('counts a would-run task with no history instead of guessing a cost', async () => {
    const nodes = makeNodes([{ id: 'a#known' }, { id: 'a#fresh' }])
    const hist = stubHistory({ 'a#known': 400 })
    const p = await planUnit({
      nodes,
      cache: stubCache(() => null).layer,
      history: hist.provider,
    })

    // wallMs/workMs are honest LOWER BOUNDS: the unknown task adds 0 and is
    // surfaced as a count so the footer can say "+?".
    expect(p.predicted).toEqual({ wallMs: 400, workMs: 400, unknownCount: 1 })
    expect(p.tasks.find((t) => t.node.id === 'a#fresh')!.p50Ms).toBeUndefined()
  })

  it('treats an uncacheable task as would-run — it executes on every run', async () => {
    const nodes = makeNodes([{ id: 'a#warm' }, { id: 'a#dev', cacheable: false, deps: ['a#warm'] }])
    const hist = stubHistory({ 'a#warm': 900, 'a#dev': 250 })
    const p = await planUnit({
      nodes,
      cache: stubCache(() => 'local').layer,
      history: hist.provider,
    })

    expect(statusById(p)).toEqual({ 'a#warm': 'hit-local', 'a#dev': 'no-cache' })
    // Only `a#dev` costs anything: its upstream is a hit worth 0.
    expect(p.predicted).toEqual({ wallMs: 250, workMs: 250, unknownCount: 0 })
  })

  it('asks history only about real tasks, never groups', async () => {
    const nodes = makeNodes([{ id: 'a#build' }, { id: 'a#ci', group: true, deps: ['a#build'] }])
    const hist = stubHistory({ 'a#build': 10 })
    await planUnit({ nodes, cache: stubCache(() => null).layer, history: hist.provider })

    // A group has no `runs` rows; including it is a pointless widening of
    // the history query's `(project, task)` IN-list.
    expect(hist.asked).toEqual(['a#build'])
  })

  it('omits `predicted` entirely when no history provider is supplied', async () => {
    const p = await planUnit({
      nodes: makeNodes([{ id: 'a#build' }]),
      cache: stubCache(() => null).layer,
    })
    expect(p.predicted).toBeUndefined()
    expect(p.tasks[0]!.p50Ms).toBeUndefined()
  })

  it('fails OPEN when the history read throws — `--dry` still returns a plan', async () => {
    const provider: HistoryProvider = {
      async loadFor(): Promise<HistoryTable> {
        throw new Error('cache.db is locked')
      },
    }
    const p = await planUnit({
      nodes: makeNodes([{ id: 'a#build' }]),
      cache: stubCache(() => 'local').layer,
      history: provider,
    })

    // Prediction is a nicety; the hit/miss plan is the product.
    expect(statusById(p)).toEqual({ 'a#build': 'hit-local' })
    expect(p.predicted).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// e2e harness: the real `planRun()` over a real workspace.
// ---------------------------------------------------------------------------

const quietLogger: Logger = {
  status() {},
  taskStdout() {},
  taskStderr() {},
  taskComplete() {},
}

function gitInit(cwd: string): void {
  const g = (...args: string[]): void => {
    const p = Bun.spawnSync({
      cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (p.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(p.stderr)}`)
    }
  }
  g('init', '-q')
  g('config', 'user.email', 'test@vx.local')
  g('config', 'user.name', 'vx test')
}

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-plan-e2e-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }, null, 2),
  )
  await writeLocalWorkspace(root)
  await mkdir(path.join(root, 'packages'), { recursive: true })
  // vx requires git — input enumeration asks `git ls-files`.
  gitInit(root)
  return root
}

async function addProject(
  root: string,
  name: string,
  args: { config: string; files?: Record<string, string> },
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

function openDb(cacheDir: string): Database {
  return new Database(path.join(cacheDir, 'cache.db'), { readonly: true })
}

function countRows(db: Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

describe('planRun() — planning executes nothing', () => {
  let root: string

  beforeEach(async () => {
    root = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'spawns no task, cleans no outputs, records no history, bumps no accessed_at',
    async () => {
      // `ran.log` is APPENDED to on every execution and sits outside the
      // declared inputs, so it is a pure execution counter that cannot
      // perturb the cache key.
      const dir = await addProject(root, 'p', {
        files: { 'src/a.txt': 'v1', 'dist/straggler.txt': 'left over from a previous build' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'mkdir -p dist && echo built > dist/out.txt && echo x >> ran.log' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
      })
      const ranLog = path.join(dir, 'ran.log')
      const straggler = path.join(dir, 'dist', 'straggler.txt')
      const cacheDir = path.join(root, '.vx', 'cache')

      const cold = await planRun({ cwd: root, tasks: ['build'], log: quietLogger })
      expect(cold.tasks.map((t) => t.cacheStatus)).toEqual(['miss'])

      // Nothing ran.
      expect(existsSync(ranLog)).toBe(false)
      // `cleanOutputs` is part of EXECUTION, not planning: a `--dry` that
      // wiped the output tree would destroy a build the user still wanted.
      expect(existsSync(straggler)).toBe(true)
      {
        const db = openDb(cacheDir)
        expect(countRows(db, 'runs')).toBe(0)
        expect(countRows(db, 'invocations')).toBe(0)
        expect(countRows(db, 'entries')).toBe(0)
        db.close()
      }

      // The control: a real run does all three things planning refused to do.
      const r = await run({ cwd: root, tasks: ['build'], log: quietLogger })
      expect(r.outcomes.map((o) => o.status)).toEqual(['success'])
      expect(await Bun.file(ranLog).text()).toBe('x\n')
      expect(existsSync(straggler)).toBe(false)

      const stored = (() => {
        const db = openDb(cacheDir)
        const row = db.prepare('SELECT hash, accessed_at FROM entries').get() as {
          hash: string
          accessed_at: number
        }
        expect(countRows(db, 'invocations')).toBe(1)
        db.close()
        return row
      })()

      // Warm planning is equally inert: the probe is an existence check, so
      // it must not re-execute and must not touch the entry's LRU timestamp
      // (an `accessed_at` bump here would let `--dry` rescue an entry a
      // `vx cache prune --max-size` was about to evict).
      const warm = await planRun({ cwd: root, tasks: ['build'], log: quietLogger })
      expect(warm.tasks.map((t) => t.cacheStatus)).toEqual(['hit-local'])
      expect(await Bun.file(ranLog).text()).toBe('x\n')
      {
        const db = openDb(cacheDir)
        const after = db
          .prepare('SELECT accessed_at FROM entries WHERE hash = ?')
          .get(stored.hash) as { accessed_at: number }
        expect(after.accessed_at).toBe(stored.accessed_at)
        // Planning records no invocation of its own.
        expect(countRows(db, 'invocations')).toBe(1)
        db.close()
      }
    },
    TIMEOUT,
  )
})

describe('planRun() — the plan describes the run you will get', () => {
  let root: string

  beforeEach(async () => {
    root = await makeWorkspace()
    await addProject(root, 'p', {
      files: { 'src/a.txt': 'v1' },
      config: `
        export default {
          tasks: {
            codegen: {
              exec: { command: 'echo gen' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
            },
            build: {
              dependsOn: ['codegen'],
              exec: { command: 'echo b' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
            },
          },
        }
      `,
    })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'derives the SAME effective cache policy the run records',
    async () => {
      // The clamp under test: without a remote layer the remote axes are
      // inert, and `run()` + `plan()` must agree on that before either one
      // decides anything. `invocations.cache_policy` is the run's own
      // statement of the policy it used, so deriving the expected plan
      // status FROM it couples the two derivations directly.
      const cases: Array<{
        name: string
        policy: CachePolicy
        plan: CacheStatus
        recorded: string
        entries: number
      }> = [
        // Remote axes clamped off (no remote layer), local axes survive.
        // `entries` counts BOTH cacheable tasks of the fixture graph.
        { name: 'full', policy: FULL, plan: 'miss', recorded: 'lR,lW', entries: 2 },
        { name: '--no-cache', policy: NO_CACHE, plan: 'no-cache', recorded: '', entries: 0 },
        // Writes still refresh the cache, but nothing is READ — so a plan
        // claiming a hit would be describing a run that cannot happen.
        { name: '--force', policy: FORCE, plan: 'no-cache', recorded: 'lW', entries: 2 },
        { name: 'local:r', policy: LOCAL_READ_ONLY, plan: 'miss', recorded: 'lR', entries: 0 },
        // THE regression: reading the raw request here labelled this run
        // "cache miss — would exec" (a result that will be stored) for a run
        // in which caching is entirely off.
        {
          name: 'local:,remote:rw',
          policy: REMOTE_ONLY,
          plan: 'no-cache',
          recorded: '',
          entries: 0,
        },
      ]

      for (const c of cases) {
        // A fresh cache dir per case keeps every case a COLD one.
        const cacheDir = path.join(root, 'caches', c.name.replace(/[^\w]/g, '_'))
        const planned = await planRun({
          cwd: root,
          tasks: ['build'],
          cache: c.policy,
          cacheDir,
          log: quietLogger,
        })
        const executed = await run({
          cwd: root,
          tasks: ['build'],
          cache: c.policy,
          cacheDir,
          log: quietLogger,
        })

        const db = openDb(cacheDir)
        const inv = db.prepare('SELECT cache_policy FROM invocations').get() as {
          cache_policy: string
        }
        const entries = countRows(db, 'entries')
        db.close()

        const label = `policy ${c.name}`
        expect(planned.tasks.map((t) => t.cacheStatus)).toEqual([c.plan, c.plan])
        expect(`${label}: ${inv.cache_policy}`).toBe(`${label}: ${c.recorded}`)
        expect(`${label}: ${entries} entries`).toBe(`${label}: ${c.entries} entries`)
        // Cold, so a real run always executes regardless of policy.
        expect(executed.outcomes.every((o) => o.status === 'success')).toBe(true)

        // The invariant behind the table: the plan says "no-cache" exactly
        // when the policy the RUN recorded has no read axis at all.
        const hasRead = inv.cache_policy.includes('lR') || inv.cache_policy.includes('rR')
        expect(`${label}: readable=${hasRead}`).toBe(`${label}: readable=${c.plan !== 'no-cache'}`)
      }
    },
    TIMEOUT,
  )

  it(
    'agrees with the run about ignoring a warm entry under --force',
    async () => {
      const cacheDir = path.join(root, 'caches', 'warm')
      await run({ cwd: root, tasks: ['build'], cacheDir, log: quietLogger })

      // Both sides must now see the same warm entry the same way.
      const warm = await planRun({ cwd: root, tasks: ['build'], cacheDir, log: quietLogger })
      expect(warm.tasks.map((t) => t.cacheStatus)).toEqual(['hit-local', 'hit-local'])
      const warmRun = await run({ cwd: root, tasks: ['build'], cacheDir, log: quietLogger })
      expect(warmRun.outcomes.map((o) => o.status)).toEqual(['cache-hit', 'cache-hit'])

      // `--force` must make BOTH sides ignore that same entry.
      const forced = await planRun({
        cwd: root,
        tasks: ['build'],
        cache: FORCE,
        cacheDir,
        log: quietLogger,
      })
      expect(forced.tasks.map((t) => t.cacheStatus)).toEqual(['no-cache', 'no-cache'])
      const forcedRun = await run({
        cwd: root,
        tasks: ['build'],
        cache: FORCE,
        cacheDir,
        log: quietLogger,
      })
      expect(forcedRun.outcomes.map((o) => o.status)).toEqual(['success', 'success'])
    },
    TIMEOUT,
  )

  it(
    'predicts the exact cache keys the run then derives, forwardArgs included',
    async () => {
      // A wrong key would silently invert every hit/miss prediction, so the
      // plan's `hash` must equal the key the executor records — including the
      // `--` forwardArgs fold, which is scoped to REQUESTED tasks only.
      const cacheDir = path.join(root, 'caches', 'keys')
      const forwardArgs = ['--only=x']

      const plain = await planRun({
        cwd: root,
        tasks: ['build'],
        cacheDir: path.join(root, 'caches', 'plain'),
        log: quietLogger,
      })
      const withArgs = await planRun({
        cwd: root,
        tasks: ['build'],
        forwardArgs,
        cacheDir,
        log: quietLogger,
      })
      await run({ cwd: root, tasks: ['build'], forwardArgs, cacheDir, log: quietLogger })

      const db = openDb(cacheDir)
      const rows = db.prepare('SELECT project, task, hash FROM runs').all() as Array<{
        project: string
        task: string
        hash: string
      }>
      db.close()
      const recorded = Object.fromEntries(rows.map((r) => [`${r.project}#${r.task}`, r.hash]))
      const predicted = Object.fromEntries(withArgs.tasks.map((t) => [t.node.id, t.hash]))

      expect(predicted).toEqual(recorded)
      expect(recorded['p#build']).toBeTruthy()

      // forwardArgs move the REQUESTED task's key and leave its dependsOn-
      // pulled upstream alone — planning must apply that same scoping, or a
      // `vx run --dry -- --only=x` would predict against the wrong key.
      const plainById = Object.fromEntries(plain.tasks.map((t) => [t.node.id, t.hash]))
      expect(plainById['p#build']).not.toBe(recorded['p#build'])
      expect(plainById['p#codegen']).toBe(recorded['p#codegen'])
    },
    TIMEOUT,
  )
})

describe('planRun() — unresolved requests', () => {
  let root: string

  beforeEach(async () => {
    root = await makeWorkspace()
    await addProject(root, 'p', {
      files: { 'src/a.txt': 'v1' },
      config: `
        export default {
          tasks: {
            build: {
              exec: { command: 'echo b' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
            },
          },
        }
      `,
    })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'abandons the whole plan when any requested task matched no project',
    async () => {
      // Deliberate: planning what WOULD run is meaningless when the
      // equivalent `vx run` refuses to start. A plan listing only the
      // resolvable half would let a CI typo look like a working `--dry`.
      const p = await planRun({ cwd: root, tasks: ['build', 'totallybogus'], log: quietLogger })

      expect(p.unresolvedTasks).toEqual(['totallybogus'])
      expect(p.tasks).toEqual([])
      expect(p.predicted).toBeUndefined()

      // Control: the same invocation without the typo plans normally.
      const ok = await planRun({ cwd: root, tasks: ['build'], log: quietLogger })
      expect(ok.unresolvedTasks).toBeUndefined()
      expect(ok.tasks.map((t) => t.node.id)).toEqual(['p#build'])
    },
    TIMEOUT,
  )

  it(
    'reports an underivable cache key as no-cache with an empty hash (known defect)',
    async () => {
      // The production reachability of the unit pin above: a
      // `cache.inputs.runtime` probe that exits non-zero is a documented
      // fail-loud UserError. `vx run` turns it into a FAILED run (exit 1);
      // `vx run --dry` resolves happily and prints "not cacheable" for two
      // tasks that both declare a cache block. The only signal is a raw
      // `[vx] p#codegen: …` line the scheduler writes straight to stderr.
      const broken = await makeWorkspace()
      try {
        await addProject(broken, 'p', {
          files: { 'src/a.txt': 'v1' },
          config: `
            export default {
              tasks: {
                codegen: {
                  exec: { command: 'echo gen' },
                  cache: {
                    inputs: { files: ['src/**'], runtime: ['exit 3'] },
                    outputs: { files: [] },
                  },
                },
                build: {
                  dependsOn: ['codegen'],
                  exec: { command: 'echo b' },
                  cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
                },
              },
            }
          `,
        })

        const p = await planRun({ cwd: broken, tasks: ['build'], log: quietLogger })
        expect(statusById(p)).toEqual({ 'p#codegen': 'no-cache', 'p#build': 'no-cache' })
        expect(p.tasks.map((t) => t.hash)).toEqual(['', ''])
        // Both are counted as would-run work of unknown cost, which is the
        // most visible symptom in `--dry`'s footer.
        expect(p.predicted?.unknownCount).toBe(2)

        // The control that makes it a defect rather than a convention: the
        // real run does NOT quietly proceed.
        const r = await run({ cwd: broken, tasks: ['build'], log: quietLogger })
        expect(r.ok).toBe(false)
      } finally {
        await rm(broken, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
