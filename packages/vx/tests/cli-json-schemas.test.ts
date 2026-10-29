// Each read verb's `--format json` is a contract: `packages/vx/schemas/
// <verb>.json`, checked in and shipped, what CI and agents parse instead
// of scraping the pretty view. Held three ways: every output this suite
// provokes conforms (no undeclared key, none missing, each type); every
// field a schema declares is carried by some output here, so a schema
// cannot promise a field nothing prints; and each object's key list is
// the source type's, checked by the compiler (`keys<T>` below takes
// exactly the keys of T), so a field added to `InfoFacts` or
// `RunSummaryRow` fails here until its schema says it.

import { Database } from 'bun:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'bun:test'
import { applyMigration } from '../src/workspace/index.js'
import type {
  CacheConfig,
  InputsConfig,
  CacheOutputs,
  InputStability,
  ExecConfig,
  ExecEnv,
  PersistentConfig,
  ProjectConfig,
  TaskConfig,
} from '../src/config.js'
import type {
  InfoFacts,
  TaskFailure,
  TaskLog,
  PlanPrediction,
  RunPlan,
  RunStep,
} from '../src/orchestrator/index.js'
import type {
  CacheKeyDiff,
  CacheKeyExplanation,
  FlakyTask,
  InputDiffEntry,
  InvocationDetail,
  RunSummaryRow,
  WhyDidThisRerun,
} from '../src/history/index.js'
import type { PruneResult } from '../src/cache/layer.js'
import type { ClearResult } from '../src/cli/cache.js'
import type { TaskNode } from '../src/graph/index.js'
import { formatPlanJson, type PlanTaskJson } from '../src/cli/plan-format.js'
import type { TaskStats } from '../src/cli/last.js'
import { docsIn } from './helpers/docs-pages.js'
import { declaredPaths, validate } from './helpers/json-schema.js'
import { edgesSource, PLUGIN_IMPORT, pluginSource } from './helpers/plugin.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const SCHEMAS = path.resolve(import.meta.dir, '..', 'schemas')
const TIMEOUT = 60_000

type Schema = Record<string, unknown>
const schema = (verb: string): Schema =>
  JSON.parse(readFileSync(path.join(SCHEMAS, `${verb}.json`), 'utf8')) as Schema

/** The keys of T, all of them and no others: the compiler holds the literal. */
function keys<T>(k: Record<keyof T, true>): string[] {
  return Object.keys(k).sort()
}

const CONFIG = (dep: boolean) => `export default {
  tasks: {
    build: {
      exec: { command: 'mkdir -p dist && cat src/a.txt > dist/o.txt' },
      ${dep ? "dependsOn: ['^build']," : ''}
      inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
    },
    fail: { exec: { command: 'exit 3' } },
    // Rewrites an input build reads, so \`vx why\` names a writer.
    stamp: { exec: { command: 'printf changed > src/a.txt' } },
    flaky: {
      // A failure names a file, so vx last prints its locations.
      exec: { command: 'test -f ../../flag || { echo src/a.txt:1:2; exit 1; }' },
      inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
    },
    // Waits for a file: a run in progress, for vx last --live.
    hold: { exec: { command: 'while [ ! -f ../../go ]; do sleep 0.05; done' } },
    // Inputs that match nothing: a warning, which vx last keeps.
    lost: { exec: { command: 'true' }, inputs: { files: ['nowhere/**'] }, cache: { outputs: { files: [] } } },
  },
}`

// Every field a task config may carry, so \`vx show\` prints each once.
const KITCHEN = `export default {
  name: 'kitchen',
  tags: ['ui'],
  tasks: {
    all: {
      description: 'every field',
      dependsOn: ['build'],
      exec: {
        command: 'echo all',
        remote: 'only',
        timeout: '5s',
        retries: 1,
        env: { passThrough: ['HOME'], define: { MODE: 'x' }, secret: ['TOKEN'] },
        sandbox: {},
      },
      inputs: {
        files: ['src/**'],
        workspaceFiles: ['tsconfig.json'],
        env: ['NODE_ENV'],
        tasks: ['*'],
        runtime: ['echo r'],
        workspaceRuntime: ['echo w'],
      },
      cache: {
        outputs: { files: ['dist/**'], workspaceFiles: ['out.txt'], clean: false },
        inputStability: { strategy: 'mutable', severity: 'error' },
      },
    },
    dev: { exec: { command: 'echo dev', persistent: { readyWhen: 'ready' } } },
    build: {
      exec: { command: 'true', platforms: ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'] },
    },
    ask: { exec: { command: 'true', interactive: true } },
  },
}`

let root: string
const outputs: Record<string, unknown[]> = {
  init: [],
  docs: [],
  lock: [],
  show: [],
  info: [],
  why: [],
  last: [],
  cache: [],
  plan: [],
  error: [],
}

function vx(args: string[]): { code: number; out: string; err: string } {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

// Every document as printed: a script reads one line per document.
const printed: { what: string; out: string }[] = []

function json(verb: string, args: string[]): void {
  const r = vx([verb, ...args, '--format', 'json'])
  if (r.code !== 0) throw new Error(`vx ${verb} ${args.join(' ')}: ${r.code}\n${r.err}`)
  printed.push({ what: `vx ${verb} ${args.join(' ')}`, out: r.out })
  outputs[verb]!.push(JSON.parse(r.out))
}

beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-json-schemas-' })
  await addProject(root, 'lib', { config: CONFIG(false), files: { 'src/a.txt': 'a' } })
  await addProject(root, 'app', {
    config: CONFIG(true),
    files: { 'src/a.txt': 'b' },
  })
  await addProject(root, 'kitchen', { config: KITCHEN })
  await addProject(root, 'bare')
  // A plugin, so \`vx info\` lists one.
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    `${PLUGIN_IMPORT}export default { plugins: [${pluginSource('noop', '{ setup() {} }')}, ${edgesSource({ app: ['lib'] })}] }\n`,
  )
  expect(vx(['run', 'build', '--filter', 'app...']).code).toBe(0)
  expect(vx(['run', 'lib#stamp']).code).toBe(0)
  expect(vx(['run', 'build', '--filter', 'app...']).code).toBe(0)
  expect(vx(['run', 'fail', '--filter', 'app...']).code).toBe(1)
  // One key that passed, then failed: a flaky task for \`vx info\`.
  await writeFile(path.join(root, 'flag'), '')
  expect(vx(['run', 'lib#flaky']).code).toBe(0)
  await unlink(path.join(root, 'flag'))
  expect(vx(['run', 'lib#flaky', '--force']).code).toBe(1)

  for (const a of [[], ['kitchen'], ['bare'], ['kitchen#all'], ['build']]) json('show', a)
  json('info', [])
  json('why', ['app#build'])
  json('why', ['app#fail'])
  json('last', [])
  json('last', ['--list'])
  json('last', ['--failed'])
  json('last', ['--log', 'app#fail'])
  json('last', ['--stats'])
  expect(vx(['run', 'lib#lost']).code).toBe(0)
  json('last', [])
  const held = Bun.spawn({
    cmd: [process.execPath, BIN, 'run', 'lib#hold'],
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
  })
  for (let i = 0; i < 400 && vx(['last', '--live']).code !== 0; i++) await Bun.sleep(50)
  json('last', ['--live'])
  await writeFile(path.join(root, 'go'), '')
  expect(await held.exited).toBe(0)
  json('last', ['--sql', 'SELECT project, task, cpu_ms, remote_error FROM runs'])
  // The flaky task passes again: the replayed failure names that run (`fixedIn`).
  await writeFile(path.join(root, 'flag'), '')
  expect(vx(['run', 'lib#flaky', '--force']).code).toBe(0)
  json('last', ['--failed'])
  // What only a sandbox, a moved input or a remote prefetch writes, kept
  // beside the failed run as a run that had them keeps it.
  const failedRun = (outputs['last']!.at(-1) as { invocation: { runId: string } }).invocation.runId
  const cacheDir = path.join(root, '.vx', 'cache')
  const kept = path.join(cacheDir, 'failures', `${failedRun}.json`)
  const stored = JSON.parse(readFileSync(kept, 'utf8')) as { tasks: Record<string, unknown>[] }
  for (const t of stored.tasks) {
    t['inputMoved'] = 'src/a.txt'
    t['sandboxFix'] = {
      read: ['/r'],
      write: ['/w'],
      network: ['h'],
      systemInfo: ['s'],
      withheld: ['/c'],
      inputs: ['src/b.txt'],
    }
  }
  await writeFile(kept, JSON.stringify(stored))
  await mkdir(path.join(cacheDir, 'steps'), { recursive: true })
  await writeFile(
    path.join(cacheDir, 'steps', `${failedRun}.json`),
    JSON.stringify([{ id: 'vx:prefetch', durationMs: 3, ok: true }]),
  )
  json('last', ['--failed'])
  const dry = vx(['run', 'build', '--filter', 'app...', '--dry=json'])
  expect(dry.code).toBe(0)
  printed.push({ what: 'vx run --dry=json', out: dry.out })
  outputs['plan']!.push(JSON.parse(dry.out))
  // What a workspace with two executors and a remote shows, built by hand:
  // the fields only those plugins provoke.
  const node = (id: string, description?: string) =>
    ({
      id,
      projectName: id.split('#')[0],
      taskName: id.split('#')[1],
      config: description === undefined ? {} : { description },
    }) as unknown as TaskNode
  outputs['plan']!.push(
    JSON.parse(
      formatPlanJson(
        {
          tasks: [
            {
              node: node('a#build', 'compile'),
              hash: 'k1',
              cacheStatus: 'hit-remote',
              deps: [],
              executor: 'remote',
              download: 'deferred',
              affected: {
                kind: 'input',
                file: 'packages/b/src/a.ts',
                project: 'b',
                via: ['b#build'],
              },
            },
            { node: node('a#ci'), hash: 'k2', cacheStatus: 'group', deps: ['a#build'] },
            {
              node: node('a#mac'),
              hash: 'k3',
              cacheStatus: 'skipped',
              deps: [],
              otherPlatform: { needs: ['darwin-arm64'], host: 'linux-x64' },
            },
            {
              node: node('a#app'),
              hash: 'k4',
              cacheStatus: 'skipped',
              deps: ['a#mac'],
              blockedBy: 'a#mac',
            },
          ],
          downloadDowngrades: [{ taskId: 'a#build', reason: 'a dependant reads its outputs' }],
        },
        'origin/main',
      ),
    ),
  )
  expect(vx(['run', 'build', '--filter', 'app...']).code).toBe(0)
  // History older than run ids: `vx why` falls back to the cache entry.
  const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
  db.run("UPDATE runs SET run_id = NULL WHERE project = 'lib' AND task = 'build'")
  db.close()
  json('why', ['lib#build'])
  // A config that does not load: \`vx info\` names it.
  await addProject(root, 'broken', { config: 'export default { tasks: 1 }' })
  json('info', [])
  json('cache', ['clean', '--max-size', '1K', '--dry'])
  json('cache', ['clean', '--max-size', '1K'])
  json('cache', ['clean', '--dry'])
  // A refusal: exit 1, and the error document on stdout.
  const refused = vx(['show', 'nope', '--format', 'json'])
  if (refused.code !== 1) throw new Error(`vx show nope: ${refused.code}\n${refused.err}`)
  outputs['error']!.push(JSON.parse(refused.out))
  // The lock audit: no lock is a problem; a fresh one is up to date.
  await rm(path.join(root, 'packages', 'broken'), { recursive: true })
  const noLock = vx(['lock', '--check', '--format', 'json'])
  if (noLock.code !== 1) throw new Error(`vx lock --check: ${noLock.code}\n${noLock.err}`)
  outputs['lock']!.push(JSON.parse(noLock.out))
  expect(vx(['lock']).code).toBe(0)
  json('lock', ['--check'])
  // The init plan core writes itself: a directory with no Turbo or Nx
  // config (a repo with one is @vzn/vx-migrate's plan).
  const fresh = await mkdtemp(path.join(tmpdir(), 'vx-init-json-'))
  try {
    const p = Bun.spawnSync({
      cmd: [process.execPath, BIN, 'init', '--dry', '--format', 'json'],
      cwd: fresh,
      env: { ...process.env, NO_COLOR: '1' },
    })
    if (p.exitCode !== 0) throw new Error(`vx init: ${p.exitCode}\n${p.stderr.toString()}`)
    outputs['init']!.push(JSON.parse(p.stdout.toString()))
    // A mapper's plan, as @vzn/vx-migrate hands it to the seam: a task with a TODO.
    await mkdir(path.join(fresh, 'a'))
    let printed = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      printed += String(chunk)
      return true
    })
    try {
      await applyMigration({
        root: fresh,
        metas: [],
        plan: {
          headerNotes: [],
          projects: [
            {
              name: 'a',
              dir: path.join(fresh, 'a'),
              importLines: [],
              tasks: [
                { name: 'build', todos: ['add a cache block'], task: { exec: { command: 'tsc' } } },
              ],
            },
          ],
          extraFiles: [],
          notes: [],
        },
        source: 'package.json scripts',
        verb: 'vx-migrate',
        dry: true,
        force: false,
        init: true,
        json: true,
      })
    } finally {
      vi.restoreAllMocks()
    }
    outputs['init']!.push(JSON.parse(printed))
  } finally {
    await rm(fresh, { recursive: true, force: true })
  }
  const d = await docsIn(['cache', 'inputs', '--limit', '2', '--format', 'json'])
  if (d.code !== 0) throw new Error(`vx docs: ${d.code}\n${d.err}`)
  outputs['docs']!.push(JSON.parse(d.out))
}, TIMEOUT)

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const VERBS = ['show', 'info', 'why', 'last', 'cache', 'lock', 'init', 'docs', 'plan', 'error']

describe('read verbs hold their --format json to a checked-in schema', () => {
  it('print each document on one line', () => {
    expect(printed.length).toBeGreaterThan(0)
    const multi = printed.filter(({ out }) => out.trimEnd().includes('\n')).map((p) => p.what)
    expect(multi).toEqual([])
  })

  it('ships one schema per read verb, and nothing else', () => {
    expect(readdirSync(SCHEMAS).sort()).toEqual(VERBS.map((v) => `${v}.json`).sort())
  })

  for (const verb of VERBS) {
    it(`vx ${verb}: every output conforms and every declared field is printed`, () => {
      const s = schema(verb)
      const seen = new Set<string>()
      for (const out of outputs[verb]!) expect(validate(s, out, seen)).toEqual([])
      expect([...declaredPaths(s)].filter((p) => !seen.has(p))).toEqual([])
    })
  }

  it('a schema refuses what it does not declare, and what it requires missing', () => {
    const s = schema('info')
    const facts = outputs['info']![0] as Record<string, unknown>
    expect(validate(s, { ...facts, extra: 1 })).toEqual(['$: undeclared extra'])
    const { vx: _, ...missing } = facts
    expect(validate(s, missing)).toEqual(['$: missing vx'])
    expect(validate(s, { ...facts, projects: 1.5 })).toEqual(['$.projects: number is not integer'])
  })

  it('every object a schema declares closes its key set', () => {
    const open: string[] = []
    const walk = (node: unknown, at: string): void => {
      if (node === null || typeof node !== 'object') return
      const o = node as Schema
      if (o['properties'] !== undefined && o['additionalProperties'] !== false) open.push(at)
      for (const [k, v] of Object.entries(o)) walk(v, `${at}/${k}`)
    }
    for (const verb of VERBS) walk(schema(verb), verb)
    expect(open).toEqual([])
  })
})

describe('each schema object is its source type', () => {
  const props = (verb: string, ...route: string[]): string[] => {
    let node = schema(verb) as Schema
    for (const step of route) node = node[step] as Schema
    return Object.keys(node['properties'] as Schema).sort()
  }
  const def = (verb: string, name: string, ...route: string[]) =>
    props(verb, '$defs', name, ...route)

  it('info', () => {
    expect(props('info')).toEqual(
      keys<InfoFacts>({
        vx: true,
        vxPath: true,
        handedOffFrom: true,
        bun: true,
        bunSupported: true,
        git: true,
        gitStatusCache: true,
        workspaceRoot: true,
        projects: true,
        tasks: true,
        plugins: true,
        workers: true,
        memory: true,
        cacheDir: true,
        cacheDirBytes: true,
        cacheStore: true,
        cacheStoreBytes: true,
        cacheVersion: true,
        schemaVersion: true,
        cacheEntries: true,
        cacheBytes: true,
        cacheIndexError: true,
        settings: true,
        orphans: true,
        runs24h: true,
        hits24h: true,
        restored24h: true,
        flakyTasks: true,
        lockfile: true,
        sandbox: true,
      }),
    )
    expect(props('info', 'properties', 'flakyTasks', 'items')).toEqual(
      keys<FlakyTask>({
        taskId: true,
        project: true,
        task: true,
        keys: true,
        passes: true,
        failures: true,
      }),
    )
  })

  it('last', () => {
    expect(def('last', 'invocation')).toEqual(
      keys<InvocationDetail>({
        runId: true,
        command: true,
        requestedTasks: true,
        cachePolicy: true,
        concurrency: true,
        flow: true,
        startedAt: true,
        endedAt: true,
        totalDurationMs: true,
        taskCount: true,
        failedCount: true,
        hitCount: true,
        hitLocalCount: true,
        hitRemoteCount: true,
        upToDateCount: true,
        restoredLocalCount: true,
        restoredRemoteCount: true,
        exitOk: true,
        commitSha: true,
        branch: true,
        dirty: true,
        ci: true,
        ciProvider: true,
        host: true,
        os: true,
        arch: true,
        vxVersion: true,
      }),
    )
    expect(def('last', 'stats')).toEqual(['branch', 'stats', 'window'])
    expect(def('last', 'taskStats')).toEqual(
      keys<TaskStats>({
        taskId: true,
        runs: true,
        p50DurationMs: true,
        p99DurationMs: true,
        successRate: true,
        hitRate: true,
        failureMode: true,
        maxPeakRssBytes: true,
        maxCpuParallelism: true,
      }),
    )
    expect(def('last', 'log')).toEqual(
      keys<TaskLog>({ runId: true, taskId: true, status: true, source: true, output: true }),
    )
    expect(def('last', 'task')).toEqual(
      keys<
        RunSummaryRow &
          Pick<TaskFailure, 'inputMoved' | 'output' | 'locations' | 'sandboxFix' | 'fixedIn'>
      >({
        runId: true,
        project: true,
        task: true,
        status: true,
        exitCode: true,
        durationMs: true,
        startedAt: true,
        endedAt: true,
        cacheHit: true,
        restored: true,
        cached: true,
        hash: true,
        cpuMs: true,
        peakRssBytes: true,
        peakCores: true,
        avgRssBytes: true,
        placement: true,
        wallclockStartNs: true,
        wallclockEndNs: true,
        blockedBy: true,
        timedOut: true,
        sandboxViolations: true,
        notReady: true,
        remoteError: true,
        forwarded: true,
        inputMoved: true,
        output: true,
        locations: true,
        sandboxFix: true,
        fixedIn: true,
      }),
    )
    expect(def('last', 'task', 'properties', 'sandboxFix')).toEqual(
      keys<NonNullable<TaskFailure['sandboxFix']>>({
        read: true,
        write: true,
        network: true,
        systemInfo: true,
        withheld: true,
        inputs: true,
      }),
    )
    expect(props('last', 'oneOf', '0', 'properties', 'steps', 'items')).toEqual(
      keys<RunStep>({ id: true, durationMs: true, ok: true }),
    )
  })

  it('why', () => {
    expect(def('why', 'why')).toEqual(
      keys<WhyDidThisRerun>({
        runId: true,
        taskId: true,
        found: true,
        thisRun: true,
        previousRun: true,
        hashChanged: true,
        note: true,
      }),
    )
    expect(def('why', 'why', 'properties', 'thisRun')).toEqual(
      keys<NonNullable<WhyDidThisRerun['thisRun']>>({
        hash: true,
        status: true,
        cacheHit: true,
        restored: true,
        cached: true,
        startedAt: true,
      }),
    )
    expect(def('why', 'why', 'properties', 'previousRun')).toEqual(
      keys<NonNullable<WhyDidThisRerun['previousRun']>>({
        hash: true,
        status: true,
        cacheHit: true,
        restored: true,
        startedAt: true,
      }),
    )
    expect(def('why', 'diff')).toEqual(
      keys<CacheKeyDiff>({
        runId: true,
        taskId: true,
        found: true,
        previousRunId: true,
        entries: true,
        unchangedCount: true,
        note: true,
      }),
    )
    expect(def('why', 'diff', 'properties', 'entries', 'items')).toEqual(
      keys<InputDiffEntry>({ kind: true, name: true, change: true, before: true, after: true }),
    )
    expect(def('why', 'explanation')).toEqual(
      keys<CacheKeyExplanation>({
        taskId: true,
        project: true,
        task: true,
        latestEntry: true,
        note: true,
      }),
    )
    expect(def('why', 'explanation', 'properties', 'latestEntry')).toEqual(
      keys<NonNullable<CacheKeyExplanation['latestEntry']>>({
        hash: true,
        command: true,
        exitCode: true,
        durationMs: true,
        sizeBytes: true,
        createdAt: true,
      }),
    )
  })

  it('cache', () => {
    expect(def('cache', 'prune')).toEqual(
      keys<PruneResult & { dryRun: boolean }>({
        dryRun: true,
        evicted: true,
        bytesFreed: true,
        orphans: true,
        orphanBytes: true,
      }),
    )
    expect(def('cache', 'clear')).toEqual(
      keys<ClearResult>({ dryRun: true, cleared: true, bytesFreed: true }),
    )
  })

  it('plan', () => {
    expect(props('plan', 'properties', 'tasks', 'items')).toEqual(
      keys<PlanTaskJson>({
        id: true,
        project: true,
        task: true,
        hash: true,
        cacheStatus: true,
        deps: true,
        p50Ms: true,
        executor: true,
        download: true,
        description: true,
        affected: true,
        otherPlatform: true,
        blockedBy: true,
      }),
    )
    expect(props('plan', 'properties', 'predicted')).toEqual(
      keys<PlanPrediction>({ wallMs: true, workMs: true, unknownCount: true, criticalPath: true }),
    )
    expect(props('plan', 'properties', 'downloadDowngrades', 'items')).toEqual(
      keys<NonNullable<RunPlan['downloadDowngrades']>[number]>({ taskId: true, reason: true }),
    )
  })

  it('show', () => {
    expect(def('show', 'project', 'properties', 'config')).toEqual(
      keys<ProjectConfig>({ name: true, tags: true, tasks: true }),
    )
    expect(def('show', 'taskConfig')).toEqual(
      keys<TaskConfig>({
        description: true,
        exec: true,
        dependsOn: true,
        inputs: true,
        cache: true,
      }),
    )
    const exec = ['taskConfig', 'properties', 'exec'] as const
    expect(def('show', ...exec)).toEqual(
      keys<ExecConfig>({
        command: true,
        remote: true,
        env: true,
        timeout: true,
        retries: true,
        persistent: true,
        interactive: true,
        sandbox: true,
        platforms: true,
      }),
    )
    expect(def('show', ...exec, 'properties', 'env')).toEqual(
      keys<ExecEnv>({ passThrough: true, define: true, secret: true }),
    )
    expect(def('show', ...exec, 'properties', 'persistent')).toEqual(
      keys<PersistentConfig>({ readyWhen: true }),
    )
    const cache = ['taskConfig', 'properties', 'cache'] as const
    expect(def('show', ...cache)).toEqual(
      keys<CacheConfig>({ outputs: true, inputStability: true }),
    )
    expect(def('show', 'taskConfig', 'properties', 'inputs')).toEqual(
      keys<InputsConfig>({
        files: true,
        workspaceFiles: true,
        env: true,
        tasks: true,
        runtime: true,
        workspaceRuntime: true,
      }),
    )
    expect(def('show', ...cache, 'properties', 'outputs')).toEqual(
      keys<CacheOutputs>({ files: true, workspaceFiles: true, clean: true }),
    )
    expect(def('show', ...cache, 'properties', 'inputStability')).toEqual(
      keys<InputStability>({ strategy: true, severity: true }),
    )
  })
})
