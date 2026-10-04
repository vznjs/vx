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
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import type {
  CacheConfig,
  CacheInputs,
  CacheOutputs,
  ExecConfig,
  ExecEnv,
  PersistentConfig,
  ProjectConfig,
  TaskConfig,
} from '../src/config.js'
import type {
  CacheKeyDiff,
  CacheKeyExplanation,
  FlakyTask,
  InfoFacts,
  InputDiffEntry,
  InvocationDetail,
  RunSummaryRow,
  WhyDidThisRerun,
  PlanPrediction,
  RunPlan,
} from '../src/orchestrator/index.js'
import type { PruneResult } from '../src/cache/layer.js'
import type { TaskNode } from '../src/graph/index.js'
import type { Tally } from '../src/orchestrator/tally.js'
import {
  writeRunSummary,
  type RunSummaryJson,
  type SummaryTaskJson,
} from '../src/orchestrator/run-artifacts.js'
import { formatPlanJson, type PlanTaskJson } from '../src/cli/plan-format.js'
import { declaredPaths, validate } from './helpers/json-schema.js'
import { PLUGIN_IMPORT, pluginSource } from './helpers/plugin.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
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
      cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
    },
    fail: { exec: { command: 'exit 3' } },
    flaky: { exec: { command: 'test -f ../../flag' } },
  },
}`

// Every field a task config may carry, so \`vx show\` prints each once.
const KITCHEN = `export default {
  tags: ['ui'],
  tasks: {
    all: {
      description: 'every field',
      dependsOn: ['build'],
      exec: {
        command: 'echo all',
        remote: 'only',
        timeout: 5000,
        retries: 1,
        env: { passThrough: ['HOME'], define: { MODE: 'x' }, secret: ['TOKEN'] },
        sandbox: {},
      },
      cache: {
        inputs: {
          files: ['src/**'],
          workspaceFiles: ['tsconfig.json'],
          env: ['NODE_ENV'],
          tasks: ['*'],
          runtime: ['echo r'],
          workspaceRuntime: ['echo w'],
        },
        outputs: { files: ['dist/**'], workspaceFiles: ['out.txt'] },
      },
    },
    dev: { exec: { command: 'echo dev', persistent: { readyWhen: 'ready' } } },
    build: { exec: { command: 'true' } },
    ask: { exec: { command: 'true', interactive: true } },
  },
}`

let root: string
const outputs: Record<string, unknown[]> = {
  show: [],
  info: [],
  why: [],
  last: [],
  cache: [],
  plan: [],
  summary: [],
}

function vx(args: string[]): { code: number; out: string; err: string } {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

function json(verb: string, args: string[]): void {
  const r = vx([verb, ...args, '--format', 'json'])
  if (r.code !== 0) throw new Error(`vx ${verb} ${args.join(' ')}: ${r.code}\n${r.err}`)
  outputs[verb]!.push(JSON.parse(r.out))
}

beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-json-schemas-' })
  await addProject(root, 'lib', { config: CONFIG(false), files: { 'src/a.txt': 'a' } })
  await addProject(root, 'app', {
    config: CONFIG(true),
    deps: { lib: 'workspace:*' },
    files: { 'src/a.txt': 'b' },
  })
  await addProject(root, 'kitchen', { config: KITCHEN })
  await addProject(root, 'bare')
  // A plugin, so \`vx info\` lists one.
  await writeFile(
    path.join(root, 'vx.workspace.mjs'),
    `${PLUGIN_IMPORT}export default { plugins: [${pluginSource('noop', '{ setup() {} }')}] }\n`,
  )
  expect(vx(['run', 'build', '--filter', 'app...']).code).toBe(0)
  await writeFile(path.join(root, 'packages/lib/src/a.txt'), 'changed')
  expect(vx(['run', 'build', '--filter', 'app...']).code).toBe(0)
  expect(vx(['run', 'fail', '--filter', 'app...']).code).toBe(1)
  // One key that failed, then passed: a flaky task for \`vx info\`.
  expect(vx(['run', 'lib#flaky']).code).toBe(1)
  await writeFile(path.join(root, 'flag'), '')
  expect(vx(['run', 'lib#flaky']).code).toBe(0)

  for (const a of [[], ['kitchen'], ['bare'], ['kitchen#all'], ['build']]) json('show', a)
  json('info', [])
  json('why', ['app#build'])
  json('why', ['app#fail'])
  json('last', [])
  json('last', ['--list'])
  json('last', ['--failed'])
  const dry = vx(['run', 'build', '--filter', 'app...', '--dry=json'])
  expect(dry.code).toBe(0)
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
      formatPlanJson({
        tasks: [
          {
            node: node('a#build', 'compile'),
            hash: 'k1',
            cacheStatus: 'hit-remote',
            deps: [],
            executor: 'remote',
            download: 'deferred',
          },
          { node: node('a#ci'), hash: 'k2', cacheStatus: 'group', deps: ['a#build'] },
        ],
        downloadDowngrades: [{ taskId: 'a#build', reason: 'a dependant reads its outputs' }],
      }),
    ),
  )
  const sum = path.join(root, 'summary.json')
  expect(vx(['run', 'build', '--filter', 'app...', `--summarize=${sum}`]).code).toBe(0)
  outputs['summary']!.push(JSON.parse(readFileSync(sum, 'utf8')))
  // The rows only a timeout, a sandbox, an admit policy, a remote hit, a
  // flake and a Ctrl-C provoke, built by hand through the same writer.
  const summaryNode = (id: string, cached: boolean) =>
    ({
      id,
      projectName: id.split('#')[0],
      taskName: id.split('#')[1],
      config: {
        exec: { command: 'true' },
        ...(cached ? { cache: { inputs: { files: [] }, outputs: { files: [] } } } : {}),
      },
    }) as unknown as TaskNode
  await writeRunSummary({
    target: sum,
    cacheDir: root,
    cwd: root,
    runId: 'r1',
    startedAtMs: 0,
    endedAtMs: 1,
    totalMs: 1,
    ok: false,
    exitCode: 130,
    outcomes: [
      {
        node: summaryNode('a#build', true),
        status: 'cache-hit-remote',
        exitCode: 0,
        durationMs: 1,
        hash: 'k1',
        storedCpuMs: 1,
        storedPeakRssBytes: 2,
        admissionHeldMs: 3,
        wallclockStartNs: 1n,
        wallclockEndNs: 2n,
      },
      {
        node: summaryNode('a#test', false),
        status: 'failed',
        exitCode: 1,
        durationMs: 1,
        hash: 'k2',
        cpuMs: 1,
        peakRssBytes: 2,
        timedOut: true,
        sandboxViolations: 1,
      },
      {
        node: summaryNode('a#dev', false),
        status: 'failed',
        exitCode: 1,
        durationMs: 0,
        notReady: 'timeout',
      },
      {
        node: summaryNode('a#e2e', false),
        status: 'skipped',
        exitCode: 0,
        durationMs: 0,
        blockedBy: 'a#test',
      },
      { node: summaryNode('a#lint', false), status: 'aborted', exitCode: 130, durationMs: 0 },
    ],
    flaky: [
      {
        taskId: 'a#test',
        project: 'a',
        task: 'test',
        hash: 'k2',
        status: 'failed',
        attempts: 2,
        passes: 1,
        failures: 1,
      },
    ],
  })
  outputs['summary']!.push(JSON.parse(readFileSync(sum, 'utf8')))
  // History older than run ids: `vx why` falls back to the cache entry.
  const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
  db.run("UPDATE runs SET run_id = NULL WHERE project = 'lib' AND task = 'build'")
  db.close()
  json('why', ['lib#build'])
  // A config that does not load: \`vx info\` names it.
  await addProject(root, 'broken', { config: 'export default { tasks: 1 }' })
  json('info', [])
  json('cache', ['prune', '--max-size', '1K', '--dry-run'])
  json('cache', ['prune', '--max-size', '1K'])
}, TIMEOUT)

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const VERBS = ['show', 'info', 'why', 'last', 'cache', 'plan', 'summary']

describe('read verbs hold their --format json to a checked-in schema', () => {
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
        bun: true,
        bunSupported: true,
        git: true,
        gitStatusCache: true,
        workspaceRoot: true,
        projects: true,
        tasks: true,
        configErrors: true,
        plugins: true,
        workers: true,
        memory: true,
        cacheDir: true,
        cacheVersion: true,
        schemaVersion: true,
        cacheEntries: true,
        cacheBytes: true,
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
        tags: true,
      }),
    )
    expect(def('last', 'task')).toEqual(
      keys<RunSummaryRow>({
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
        wallclockStartNs: true,
        wallclockEndNs: true,
        blockedBy: true,
        timedOut: true,
        sandboxViolations: true,
        notReady: true,
      }),
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
    expect(props('cache')).toEqual(
      keys<PruneResult & { dryRun: boolean }>({
        dryRun: true,
        evicted: true,
        bytesFreed: true,
        orphans: true,
        orphanBytes: true,
      }),
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
      }),
    )
    expect(props('plan', 'properties', 'predicted')).toEqual(
      keys<PlanPrediction>({ wallMs: true, workMs: true, unknownCount: true }),
    )
    expect(props('plan', 'properties', 'downloadDowngrades', 'items')).toEqual(
      keys<NonNullable<RunPlan['downloadDowngrades']>[number]>({ taskId: true, reason: true }),
    )
  })

  it('summary', () => {
    expect(props('summary')).toEqual(
      keys<RunSummaryJson>({
        runId: true,
        ok: true,
        exitCode: true,
        startedAt: true,
        endedAt: true,
        totalMs: true,
        tasks: true,
        aborted: true,
        summary: true,
      }),
    )
    expect(def('summary', 'task')).toEqual(
      keys<SummaryTaskJson>({
        id: true,
        project: true,
        task: true,
        status: true,
        exitCode: true,
        durationMs: true,
        hash: true,
        restored: true,
        noCache: true,
        flaky: true,
        cpuMs: true,
        peakRssBytes: true,
        storedCpuMs: true,
        storedPeakRssBytes: true,
        admissionHeldMs: true,
        blockedBy: true,
        timedOut: true,
        sandboxViolations: true,
        notReady: true,
        wallclockStartNs: true,
        wallclockEndNs: true,
      }),
    )
    expect(def('summary', 'task', 'properties', 'flaky')).toEqual(
      keys<NonNullable<SummaryTaskJson['flaky']>>({ passes: true, failures: true, attempts: true }),
    )
    expect(props('summary', 'properties', 'summary')).toEqual(
      keys<Tally>({
        successful: true,
        failed: true,
        skipped: true,
        cachedLocal: true,
        restoredLocal: true,
        restoredRemote: true,
        upToDate: true,
        cachedRemote: true,
        aborted: true,
        total: true,
      }),
    )
  })

  it('show', () => {
    expect(def('show', 'project', 'properties', 'config')).toEqual(
      keys<ProjectConfig>({ tags: true, tasks: true }),
    )
    expect(def('show', 'taskConfig')).toEqual(
      keys<TaskConfig>({ description: true, exec: true, dependsOn: true, cache: true }),
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
      }),
    )
    expect(def('show', ...exec, 'properties', 'env')).toEqual(
      keys<ExecEnv>({ passThrough: true, define: true, secret: true }),
    )
    expect(def('show', ...exec, 'properties', 'persistent')).toEqual(
      keys<PersistentConfig>({ readyWhen: true }),
    )
    const cache = ['taskConfig', 'properties', 'cache'] as const
    expect(def('show', ...cache)).toEqual(keys<CacheConfig>({ inputs: true, outputs: true }))
    expect(def('show', ...cache, 'properties', 'inputs')).toEqual(
      keys<CacheInputs>({
        files: true,
        workspaceFiles: true,
        env: true,
        tasks: true,
        runtime: true,
        workspaceRuntime: true,
      }),
    )
    expect(def('show', ...cache, 'properties', 'outputs')).toEqual(
      keys<CacheOutputs>({ files: true, workspaceFiles: true }),
    )
  })
})
