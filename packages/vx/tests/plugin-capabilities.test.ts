// The run-level plugin capabilities (cache / executor / telemetry), the
// seams a plugin fills where core once hardcoded its own hooks
// (docs/design/pipeline-2026-09.md). Each test declares a VxPlugin
// in .vx/workspace.mjs and asserts the seam is consulted. Nothing is applied
// by default: every e2e fixture declares the local executor + cache plugins
// AFTER its own, and the NO DEFAULTS pin below is what a bare workspace sees.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { RunSummaryRecord } from '../src/orchestrator/index.js'
import { localWorkspaceSource, writeLocalWorkspace } from './helpers/local-workspace.js'
import { planRun, run } from './helpers/orchestrator.js'
import {
  REMOTE_CACHE_METHODS,
  resolveCache,
  resolveExecutors,
  type VxPlugin,
} from '../src/orchestrator/index.js'
import type { TaskExecutor, TaskInputs } from '../src/exec/index.js'
import {
  Cache,
  LayeredCache,
  type RemoteCacheLayer,
  type ResolvedRemote,
} from '../src/cache/index.js'
import { loadWorkspaceConfig } from '../src/workspace/index.js'
import { machineParallelism } from '../src/util/index.js'
import { PLUGIN_IMPORT, pluginSource, testPlugin } from './helpers/plugin.js'

async function writeFixture(): Promise<{ workspaceRoot: string; cleanup: () => void }> {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'vx-plugin-cap-'))
  await Bun.write(
    path.join(workspaceRoot, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: ['pkg-a'] }),
  )
  await Bun.write(path.join(workspaceRoot, 'pkg-a/package.json'), JSON.stringify({ name: 'pkg-a' }))
  await Bun.write(
    path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
    `export default { tasks: { hello: { exec: { command: 'echo hi' } } } }`,
  )
  return { workspaceRoot, cleanup: () => rmSync(workspaceRoot, { recursive: true, force: true }) }
}

async function gitInit(dir: string): Promise<void> {
  await Bun.spawn(['git', 'init', '-q'], { cwd: dir }).exited
  await Bun.spawn(['git', 'add', '-A'], { cwd: dir }).exited
  await Bun.spawn(
    [
      'git',
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      'init',
    ],
    { cwd: dir },
  ).exited
}

function makeSilentLogger(status?: (line: string) => void) {
  return {
    runStart: () => undefined,
    taskStart: () => undefined,
    taskStdout: () => undefined,
    taskStderr: () => undefined,
    taskComplete: () => undefined,
    runStatus: () => undefined,
    runEnd: () => undefined,
    status: (line: string) => status?.(line),
  }
}

/**
 * The methods `RemoteCacheLayer` REQUIRES, read from its own source rather
 * than from `REMOTE_CACHE_METHODS`: a table generated from the constant
 * shrinks with the list it is meant to hold, so the members come from the
 * interface and the constant is checked AGAINST them.
 */
function requiredRemoteMethods(): string[] {
  const src = readFileSync(
    path.join(import.meta.dir, '..', 'src', 'cache', 'layered-cache.ts'),
    'utf8',
  )
  const body = src.slice(src.indexOf('export interface RemoteCacheLayer {'))
  const members: string[] = []
  for (const line of body.slice(0, body.indexOf('\n}')).split('\n')) {
    const m = /^ {2}([a-zA-Z_][\w]*)(\??)\(/.exec(line)
    if (m !== null && m[2] === '') members.push(m[1]!)
  }
  return members
}

describe('the cache gate names EVERY remote method, not a count of them', () => {
  // A count is not the contract: duplicate an entry in place of `put` and a
  // remote with no `put()` is accepted, then dies at its first upload.
  const baseCtx = {
    workspaceRoot: '/ws',
    cacheDir: '/ws/.vx/cache',
    warn: () => undefined,
    scope: undefined,
    refs: [],
  }
  const POLICY = { localRead: true, localWrite: true, remoteRead: true, remoteWrite: true }
  const required = requiredRemoteMethods()

  it('the constant is exactly what the interface requires — no member dropped, none invented', () => {
    expect(required.length).toBeGreaterThan(0)
    expect([...REMOTE_CACHE_METHODS].sort()).toEqual([...required].sort())
    expect(new Set(REMOTE_CACHE_METHODS).size).toBe(REMOTE_CACHE_METHODS.length)
  })

  for (const withheld of requiredRemoteMethods()) {
    it(`refuses a remote whose only missing method is ${withheld}()`, async () => {
      const remote = Object.fromEntries(
        required.filter((m) => m !== withheld).map((m) => [m, () => undefined]),
      )
      const dir = mkdtempSync(path.join(tmpdir(), 'vx-cache-gate-'))
      const local = new Cache(dir, { read: true, write: true })
      try {
        // The whole message, not a prefix: `toThrow` matches a substring.
        const err = await resolveCache(
          [testPlugin('org/partial', { cache: () => remote as never })],
          { ...baseCtx, localCache: local, policy: POLICY },
        ).then(
          () => undefined,
          (e: unknown) => e as Error,
        )
        expect(err?.message).toBe(
          `plugin 'org/partial' returned from cache something that is not a remote cache layer: ` +
            `missing ${withheld}()`,
        )
      } finally {
        local.close()
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  it('null from cache() is refused by name, not by an internal TypeError', async () => {
    // `resolveCache` skips only `undefined`, so `null` reaches the gate:
    // the one input that looks most like "no remote" without being it.
    const dir = mkdtempSync(path.join(tmpdir(), 'vx-cache-gate-nil-'))
    const local = new Cache(dir, { read: true, write: true })
    try {
      await expect(
        resolveCache([testPlugin('org/nil', { cache: () => null as never })], {
          ...baseCtx,
          localCache: local,
          policy: POLICY,
        }),
      ).rejects.toThrow(
        "plugin 'org/nil' returned from cache something that is not a remote cache layer",
      )
    } finally {
      local.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an optional method that is not a function is refused by name', async () => {
    // `hasMany: true` failed every batch probe, and `missing: true` every
    // upload, each said as the remote's own fault per call.
    const dir = mkdtempSync(path.join(tmpdir(), 'vx-cache-gate-opt-'))
    const local = new Cache(dir, { read: true, write: true })
    const fns = Object.fromEntries(required.map((m) => [m, () => undefined]))
    const said = (extra: Record<string, unknown>): Promise<string> =>
      resolveCache([testPlugin('org/odd', { cache: () => ({ ...fns, ...extra }) as never })], {
        ...baseCtx,
        localCache: local,
        policy: POLICY,
      }).then(
        () => 'ok',
        (e: unknown) => (e as Error).message,
      )
    try {
      expect([
        await said({ hasMany: true, missing: 'x' }),
        await said({ open: null }),
        await said({ hasMany: () => null, lend: undefined }),
      ]).toEqual([
        "plugin 'org/odd' returned from cache something that is not a remote cache layer: hasMany, missing not functions",
        "plugin 'org/odd' returned from cache something that is not a remote cache layer: open not a function",
        'ok',
      ])
    } finally {
      local.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// --- plugin-host unit-level consultation -------------------------------

describe('plugin-host — capability consultation + fallbacks', () => {
  const baseCtx = {
    workspaceRoot: '/ws',
    cacheDir: '/ws/.vx/cache',
    warn: () => undefined,
    scope: undefined,
    refs: [],
    artifacts: {
      save: async () => {},
      restore: async () => null,
      output: async () => null,
      share: async () => false,
      resend: async () => false,
    },
    cacheFacts: async () => ({ refs: [], lent: {} }),
  }

  it('resolveCache: every contributing remote is kept in order, each behind the local store', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'vx-cache-host-'))
    const local = new Cache(cacheDir, { read: true, write: true })
    const remote = (): RemoteCacheLayer => ({
      has: async () => null,
      get: async () => null,
      put: async () => undefined,
    })
    const [first, second] = [remote(), remote()]
    const plugins: VxPlugin[] = [
      testPlugin('org/none', { cache: () => undefined }),
      testPlugin('org/first', { cache: () => first }),
      testPlugin('org/second', { cache: () => second }),
    ]
    try {
      const remotes: ResolvedRemote[] = []
      const resolved = await resolveCache(plugins, {
        ...baseCtx,
        localCache: local,
        policy: { localRead: true, localWrite: true, remoteRead: true, remoteWrite: true },
        remotes,
      })
      expect(resolved).toBeInstanceOf(LayeredCache)
      expect((resolved as LayeredCache).local).toBe(local)
      expect(remotes.map((r) => r.remote)).toEqual([first, second])
    } finally {
      local.close()
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it('resolveCache: a plugin that declines leaves the local handle unwrapped', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'vx-cache-host-'))
    const local = new Cache(cacheDir, { read: true, write: true })
    try {
      const resolved = await resolveCache([testPlugin('org/none', { cache: () => undefined })], {
        ...baseCtx,
        localCache: local,
        policy: { localRead: true, localWrite: true, remoteRead: false, remoteWrite: false },
      })
      expect(resolved).toBe(local)
    } finally {
      local.close()
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it('resolveExecutors: keeps every contributed executor in declaration order', async () => {
    const a: TaskExecutor = { name: 'a', execute: () => Promise.reject(new Error('unused')) }
    const b: TaskExecutor = { name: 'b', execute: () => Promise.reject(new Error('unused')) }
    const plugins: VxPlugin[] = [
      testPlugin('org/a', { executor: () => a }),
      testPlugin('org/none', { executor: () => undefined }),
      testPlugin('org/b', { executor: async () => b }),
    ]
    const resolved = await resolveExecutors(plugins, { ...baseCtx, concurrency: 4 })
    // core's local executor is the tail of every list, never the head
    expect(resolved.slice(0, 2)).toEqual([a, b])
    expect(resolved.map((e) => e.name)).toEqual(['a', 'b', 'local'])
  })

  it('resolveCache / resolveExecutors: a hook returning something that is not the contract is refused by name', async () => {
    // Before: every task failed with `this.layers[0].key is not a function`
    // — an internal TypeError naming neither the plugin nor the hook.
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'vx-cache-host-'))
    const local = new Cache(cacheDir, { read: true, write: true })
    try {
      await expect(
        resolveCache([testPlugin('org/junk', { cache: () => ({ nope: true }) as never })], {
          ...baseCtx,
          localCache: local,
          policy: { localRead: true, localWrite: true, remoteRead: false, remoteWrite: false },
        }),
      ).rejects.toThrow(
        `plugin 'org/junk' returned from cache something that is not a remote cache layer: missing ${REMOTE_CACHE_METHODS.map((m) => `${m}()`).join(', ')}`,
      )
    } finally {
      local.close()
      rmSync(cacheDir, { recursive: true, force: true })
    }
    await expect(
      resolveExecutors([testPlugin('org/junk', { executor: () => ({ name: 'x' }) as never })], {
        ...baseCtx,
        concurrency: 1,
      }),
    ).rejects.toThrow(
      "plugin 'org/junk' returned from executor something that is not an executor: missing execute()",
    )
    await expect(
      resolveExecutors(
        [testPlugin('org/anon', { executor: () => ({ execute: async () => ({}) }) as never })],
        {
          ...baseCtx,
          concurrency: 1,
        },
      ),
    ).rejects.toThrow("plugin 'org/anon' returned an executor with no name")
  })

  it('resolveExecutors: a capacity that is not a positive integer is refused by name', async () => {
    // 0, NaN or a negative number parked every task placed there and the
    // run hung with no output.
    const said = async (capacity: unknown): Promise<string> => {
      const plugins: VxPlugin[] = [
        testPlugin('org/pool', {
          executor: () => ({
            name: 'pool',
            capacity: capacity as number,
            execute: () => Promise.reject(new Error('unused')),
          }),
        }),
      ]
      try {
        await resolveExecutors(plugins, { ...baseCtx, concurrency: 1 })
        return 'ok'
      } catch (err) {
        return (err as Error).message
      }
    }
    for (const [bad, shown] of [
      [0, '0'],
      [-1, '-1'],
      [Number.NaN, 'NaN'],
      [1.5, '1.5'],
      [Infinity, 'Infinity'],
      ['2', '"2"'],
    ] as const) {
      expect(await said(bad)).toBe(
        `plugin 'org/pool' returned executor 'pool' with capacity ${shown}: it must be a positive integer`,
      )
    }
    expect(await said(1)).toBe('ok')
    expect(await said(undefined)).toBe('ok')
  })

  it('resolveExecutors: a flag that is not a boolean is refused by name', async () => {
    // Core reads each flag as `=== true`: `remote: 'yes'` ran a remote
    // executor as a local one, offered tasks pinned to this machine.
    const said = async (flags: Record<string, unknown>): Promise<string> => {
      try {
        await resolveExecutors(
          [
            testPlugin('org/pool', {
              executor: () => ({
                name: 'pool',
                ...flags,
                execute: () => Promise.reject(new Error('unused')),
              }),
            }),
          ],
          { ...baseCtx, concurrency: 1 },
        )
        return 'ok'
      } catch (err) {
        return (err as Error).message
      }
    }
    expect([
      await said({ remote: 'yes' }),
      await said({ remote: true, exclusive: 1 }),
      await said({ remote: true, sandbox: null }),
      await said({ remote: true, servers: true, runtime: false, timeouts: true }),
    ]).toEqual([
      `plugin 'org/pool' returned executor 'pool' with remote "yes": it must be true or false`,
      `plugin 'org/pool' returned executor 'pool' with exclusive 1: it must be true or false`,
      `plugin 'org/pool' returned executor 'pool' with sandbox null: it must be true or false`,
      'ok',
    ])
  })

  it('resolveExecutors: an empty executor name is refused like a missing one', async () => {
    const said = await resolveExecutors(
      [
        testPlugin('org/anon', {
          executor: () => ({ name: '', execute: () => Promise.reject(new Error('unused')) }),
        }),
      ],
      { ...baseCtx, concurrency: 1 },
    ).then(
      () => 'ok',
      (e: Error) => e.message,
    )
    expect(said).toBe("plugin 'org/anon' returned an executor with no name")
  })

  it('resolveExecutors: a throwing executor factory aborts with a named UserError', async () => {
    const plugins: VxPlugin[] = [
      testPlugin('org/broken-exec', {
        executor: () => {
          throw new Error('exec boom')
        },
      }),
    ]
    await expect(resolveExecutors(plugins, { ...baseCtx, concurrency: 1 })).rejects.toThrow(
      /org\/broken-exec.*exec boom/,
    )
  })
})

// --- end-to-end through run() / cli via .vx/workspace.mjs ---------------

describe('plugin capabilities — end-to-end', () => {
  it('a cache plugin is consulted during a real run()', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      // The plugin records that it was consulted, then declines.
      await Bun.write(
        path.join(workspaceRoot, '.vx/workspace.mjs'),
        localWorkspaceSource(
          [
            pluginSource(
              'org/cache',
              `{ cache() {
               globalThis.__vxCachePluginConsulted = true
               return undefined
             },
           }`,
            ),
          ],
          `globalThis.__vxCachePluginConsulted = false
`,
        ),
      )
      await gitInit(workspaceRoot)
      const summary = await run({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['hello'],
        log: makeSilentLogger(() => {}),
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      expect((globalThis as { __vxCachePluginConsulted?: boolean }).__vxCachePluginConsulted).toBe(
        true,
      )
    } finally {
      cleanup()
    }
  })

  it('a cache plugin that throws aborts the run with a named UserError', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, '.vx/workspace.mjs'),
        localWorkspaceSource([
          pluginSource(
            'org/bad-cache',
            `{ cache() { throw new Error('cache boom') },
           }`,
          ),
        ]),
      )
      await gitInit(workspaceRoot)
      await expect(
        run({
          cwd: workspaceRoot,
          projects: ['pkg-a'],
          tasks: ['hello'],
          log: makeSilentLogger(),
          handleSignals: false,
        }),
      ).rejects.toThrow(/org\/bad-cache/)
    } finally {
      cleanup()
    }
  })
})

// --- executor capability ----------------------------------------------

describe('executor capability — config validation', () => {
  it('accepts a plugin that contributes only `executor`', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, '.vx/workspace.mjs'),
        `${PLUGIN_IMPORT}export default { plugins: [${pluginSource('org/exec', `{ executor() { return undefined } }`)}] }`,
      )
      const cfg = await loadWorkspaceConfig(workspaceRoot)
      expect(cfg?.plugins?.length).toBe(1)
    } finally {
      cleanup()
    }
  })

  it('rejects a non-function `executor`', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, '.vx/workspace.mjs'),
        `${PLUGIN_IMPORT}export default { plugins: [${pluginSource('org/exec', `{ executor: 42 }`)}] }`,
      )
      await expect(loadWorkspaceConfig(workspaceRoot)).rejects.toThrow(
        /plugins\[0\]\.executor.*function/,
      )
    } finally {
      cleanup()
    }
  })
})

describe('executor capability — end-to-end via run()', () => {
  async function runHello(workspaceRoot: string) {
    return await run({
      cwd: workspaceRoot,
      projects: ['pkg-a'],
      tasks: ['hello'],
      log: makeSilentLogger(),
      handleSignals: false,
    })
  }

  it('a declared executor runs the task and the local executor is not used', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, '.vx/workspace.mjs'),
        localWorkspaceSource(
          [
            pluginSource(
              'org/exec',
              `{ executor() {
               return {
                 name: 'fake',
                 async execute(req) {
                   globalThis.__vxExec.push(req.taskId + ':' + req.command)
                   req.onStdout('from-fake\\n')
                   return { exitCode: 0, durationMs: 1, stdout: 'from-fake\\n', stderr: '', violations: [] }
                 },
               }
             },
           }`,
            ),
          ],
          `globalThis.__vxExec = []
`,
        ),
      )
      await gitInit(workspaceRoot)
      const summary = await runHello(workspaceRoot)
      expect(summary.ok).toBe(true)
      const seen = (globalThis as unknown as { __vxExec: string[] }).__vxExec
      expect(seen).toEqual(['pkg-a#hello:echo hi'])
    } finally {
      cleanup()
    }
  })

  it("an executor's machines and where a task ran reach the run summary and history", async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, '.vx/workspace.mjs'),
        localWorkspaceSource(
          [
            pluginSource(
              'org/fleet',
              `{ executor() {
               return {
                 name: 'fleet',
                 async execute() {
                   return { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [],
                     where: 'small#1', machine: { cores: 2, memoryBytes: 8e9 } }
                 },
                 machines: () => [{ name: 'small#1', status: 'online', cores: 2, memoryBytes: 8e9,
                   done: 1, failed: 0, onlineMs: 10, busyMs: 1, cpuPeak: 1, cpuAvg: 0.1,
                   memoryPeakBytes: 1, memoryAvgBytes: 1, utilization: 0.05 }],
                 idealMs: () => 1234.4,
               }
             },
             telemetry() { return { onRunSummary(s) { globalThis.__vxFleet = s } } },
           }`,
            ),
          ],
          '',
        ),
      )
      await gitInit(workspaceRoot)
      expect((await runHello(workspaceRoot)).ok).toBe(true)
      const s = (globalThis as unknown as { __vxFleet: RunSummaryRecord }).__vxFleet
      expect(s.tasks.map((t) => t.where)).toEqual(['small#1'])
      expect(s.machines?.map((m) => [m.name, m.cores, m.utilization])).toEqual([
        ['small#1', 2, 0.05],
      ])
      expect(s.idealMs).toBe(1234)
      const db = new Database(path.join(workspaceRoot, '.vx/cache/cache.db'), { readonly: true })
      try {
        expect(
          db.query('SELECT placement, placement_cores, placement_memory FROM runs').all(),
        ).toEqual([{ placement: 'small#1', placement_cores: 2, placement_memory: 8e9 }])
      } finally {
        db.close()
      }
    } finally {
      cleanup()
    }
  })

  // Isolated, a report a plugin threw on was dropped with nothing said: the
  // summary lacked its machines and no line told why. The line names the
  // plugin: `executor 'fleet'` alone named no package to look in.
  it("an executor's report that throws is left out, and said once", async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, '.vx/workspace.mjs'),
        localWorkspaceSource(
          [
            pluginSource(
              'org/fleet',
              `{ executor() {
               return {
                 name: 'fleet',
                 async execute() {
                   return { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }
                 },
                 machines() { throw new Error('machines broke') },
                 idealMs() { throw new Error('ideal broke') },
               }
             },
             telemetry() { return { onRunSummary(s) { globalThis.__vxFleet = s } } },
           }`,
            ),
          ],
          '',
        ),
      )
      await gitInit(workspaceRoot)
      const lines: string[] = []
      const summary = await run({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['hello'],
        log: makeSilentLogger((l) => lines.push(l)),
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      const s = (globalThis as unknown as { __vxFleet: RunSummaryRecord }).__vxFleet
      expect(s.machines ?? []).toEqual([])
      expect(lines.filter((l) => l.includes('fleet'))).toEqual([
        "[vx] plugin 'org/fleet' (executor 'fleet'): machines() threw: machines broke — left out",
        "[vx] plugin 'org/fleet' (executor 'fleet'): idealMs() threw: ideal broke — left out",
      ])
    } finally {
      cleanup()
    }
  })

  it('an executor that declines a task falls through to the local executor declared after it', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, '.vx/workspace.mjs'),
        localWorkspaceSource(
          [
            pluginSource(
              'org/picky',
              `{ executor() {
               return {
                 name: 'picky',
                 accepts(task) { globalThis.__vxDeclined.push(task.taskId); return false },
                 async execute() { throw new Error('must not run') },
               }
             },
           }`,
            ),
          ],
          `globalThis.__vxDeclined = []
`,
        ),
      )
      await gitInit(workspaceRoot)
      const summary = await runHello(workspaceRoot)
      expect(summary.ok).toBe(true)
      expect(summary.outcomes.map((o) => [o.node.id, o.exitCode])).toEqual([['pkg-a#hello', 0]])
      expect((globalThis as unknown as { __vxDeclined: string[] }).__vxDeclined).toEqual([
        'pkg-a#hello',
      ])
    } finally {
      cleanup()
    }
  })

  it("an executor's throw reaches the task's own stderr, where its frame reads it", async () => {
    // It went to process.stderr past the logger, and the task's frame
    // said nothing of a reason vx had printed above.
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, '.vx/workspace.mjs'),
        localWorkspaceSource([
          pluginSource(
            'org/down',
            `{ executor() {
               return { name: 'down', async execute() { throw new Error('pool down') } }
             },
           }`,
          ),
        ]),
      )
      await gitInit(workspaceRoot)
      // Before the completion: the frame closes on it.
      const seen: string[] = []
      const summary = await run({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['hello'],
        log: {
          ...makeSilentLogger(),
          // Every chunk: execute-task wrote the bare message and the
          // scheduler's line followed it, two copies in one frame.
          taskStderr: (n, c) => void seen.push(`${n.id}: ${c}`),
          taskComplete: (n) => void seen.push(`done ${n.id}`),
        },
        handleSignals: false,
      })
      expect(summary.ok).toBe(false)
      expect(seen).toEqual([
        // Named as every other hook's throw is (C-63), and plainly: the
        // plugin's, not an internal error of vx's (C-85).
        "pkg-a#hello: [vx] pkg-a#hello: plugin 'org/down' (executor 'down') failed in execute: pool down\n",
        'done pkg-a#hello',
      ])
    } finally {
      cleanup()
    }
  })

  // C-74: the name is added to the error itself, so one error an executor
  // rejects every task with (a failed connection it memoized) was named
  // once per task: the second read `failed in execute: plugin … failed in
  // execute: pool down`.
  it('one error an executor rejects two tasks with is named once in each', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: { a: { exec: { command: 'echo a' } }, b: { exec: { command: 'echo b' } } } }`,
      )
      await Bun.write(
        path.join(workspaceRoot, '.vx/workspace.mjs'),
        localWorkspaceSource([
          pluginSource(
            'org/down',
            `{ executor() {
               const down = new Error('pool down')
               return { name: 'down', async execute() { throw down } }
             },
           }`,
          ),
        ]),
      )
      await gitInit(workspaceRoot)
      const seen: string[] = []
      await run({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['a', 'b'],
        concurrency: 1,
        log: {
          ...makeSilentLogger(),
          // Each task's own frame line, where a name added twice showed:
          // the second task's text then differed from the first's.
          taskStderr: (n, c) => void seen.push(`${n.id}: ${c}`),
        },
        handleSignals: false,
      })
      expect(seen.sort()).toEqual([
        "pkg-a#a: [vx] pkg-a#a: plugin 'org/down' (executor 'down') failed in execute: pool down\n",
        // Each failed task's own block says why in full (2026-10-22).
        "pkg-a#b: [vx] pkg-a#b: plugin 'org/down' (executor 'down') failed in execute: pool down\n",
      ])
    } finally {
      cleanup()
    }
  })

  it('a cacheable task executed by a plugin executor is saved and replayed as a hit', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: { hello: {
           exec: { command: 'echo hi > out.txt' },
           inputs: { files: ['package.json'] }, cache: { outputs: { files: ['out.txt'] } },
         } } }`,
      )
      await Bun.write(
        path.join(workspaceRoot, '.vx/workspace.mjs'),
        localWorkspaceSource(
          [
            pluginSource(
              'org/exec',
              `{ executor() {
               return {
                 name: 'fake',
                 async execute(req) {
                   globalThis.__vxCalls++
                   writeFileSync(join(req.cwd, 'out.txt'), 'made-by-fake\\n')
                   return { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }
                 },
               }
             },
           }`,
            ),
          ],
          `globalThis.__vxCalls = 0
         import { writeFileSync } from 'node:fs'
         import { join } from 'node:path'
`,
        ),
      )
      await gitInit(workspaceRoot)
      const first = await runHello(workspaceRoot)
      expect(first.ok).toBe(true)
      expect(first.outcomes[0]?.status).toBe('success')
      const second = await runHello(workspaceRoot)
      expect(second.ok).toBe(true)
      // `restored` is "bytes materialized this run" — false on a hit whose
      // on-disk outputs already match the snapshot — so the hit is pinned
      // by status, and the executor call count below proves it replayed.
      expect(second.outcomes[0]?.status).toBe('cache-hit')
      expect((globalThis as unknown as { __vxCalls: number }).__vxCalls).toBe(1)
      expect(await Bun.file(path.join(workspaceRoot, 'pkg-a/out.txt')).text()).toBe(
        'made-by-fake\n',
      )
    } finally {
      cleanup()
    }
  })

  // `prepareRun` resolves the cache before `run()` resolves executors, so
  // the cache message is the one a bare workspace sees; both carry the hint.
  it('two declared remotes: a run saves into the local store and both remotes', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    const g = globalThis as { __vxPuts?: string[] }
    g.__vxPuts = []
    try {
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: { hello: {
           exec: { command: 'echo hi > out.txt' },
           inputs: { files: ['package.json'] }, cache: { outputs: { files: ['out.txt'] } },
         } } }`,
      )
      const remote = (name: string) =>
        pluginSource(
          `org/${name}`,
          `{ cache: () => ({
             has: async () => null,
             get: async () => null,
             put: async (hash) => { globalThis.__vxPuts.push('${name} ' + hash) },
           }) }`,
        )
      await Bun.write(
        path.join(workspaceRoot, '.vx/workspace.mjs'),
        localWorkspaceSource([remote('first'), remote('second')]),
      )
      await gitInit(workspaceRoot)
      const summary = await run({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['hello'],
        cache: { localRead: true, localWrite: true, remoteRead: true, remoteWrite: true },
        log: makeSilentLogger(),
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      const hash = summary.outcomes[0]?.hash
      expect(typeof hash).toBe('string')
      expect(g.__vxPuts.sort()).toEqual([`first ${hash}`, `second ${hash}`])
      const localCache = new Cache(path.join(workspaceRoot, '.vx/cache'), {
        read: true,
        write: true,
      })
      try {
        expect((await localCache.get(hash!))?.hash).toBe(hash)
      } finally {
        localCache.close()
      }
    } finally {
      delete g.__vxPuts
      cleanup()
    }
  })

  it('a plugin executor receives the structured input set the cache key folds', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(path.join(workspaceRoot, 'pkg-a/src.txt'), 'source\n')
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: {
           codegen: {
             exec: { command: 'echo gen > gen.txt' },
             inputs: { files: ['src.txt'] }, cache: { outputs: { files: ['gen.txt'] } },
           },
           hello: {
             exec: { command: 'echo hi > out.txt' },
             dependsOn: ['codegen'],
             inputs: { files: ['src.txt'], env: ['VX_TEST_INPUT'], runtime: ['echo tool-1.2'], tasks: ['codegen'] },
             cache: {
               outputs: { files: ['out.txt'] },
             },
           },
         } }`,
      )
      await Bun.write(
        path.join(workspaceRoot, '.vx/workspace.mjs'),
        localWorkspaceSource([
          pluginSource(
            'org/inputs-spy',
            `{ executor() {
               return {
                 name: 'spy',
                 accepts(task) { return task.taskId === 'pkg-a#hello' },
                 async execute(req) {
                   globalThis.__vxInputs = req.inputs
                   globalThis.__vxRoot = req.workspaceRoot
                   await Bun.write(req.cwd + '/out.txt', 'by-spy\\n')
                   return { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }
                 },
               }
             },
           }`,
          ),
        ]),
      )
      await gitInit(workspaceRoot)
      process.env['VX_TEST_INPUT'] = 'secret-value'
      let summary
      try {
        summary = await runHello(workspaceRoot)
      } finally {
        delete process.env['VX_TEST_INPUT']
      }
      expect(summary.ok).toBe(true)
      const g = globalThis as unknown as { __vxInputs: TaskInputs; __vxRoot: string }
      expect(g.__vxRoot).toBe(workspaceRoot)
      const inputs = g.__vxInputs
      expect(inputs.files.map((f) => f.path)).toEqual(['pkg-a/src.txt'])
      expect(inputs.files[0]!.digest).toMatch(/^[0-9a-f]{40}$/)
      expect(inputs.env).toEqual([{ name: 'VX_TEST_INPUT', value: 'secret-value' }])
      expect(inputs.runtime).toEqual([{ command: 'echo tool-1.2', output: 'tool-1.2' }])
      expect(inputs.workspaceRuntime).toEqual([])
      const codegen = summary.outcomes.find((o) => o.node.id === 'pkg-a#codegen')
      expect(inputs.upstream).toEqual([
        { taskId: 'pkg-a#codegen', hash: codegen!.hash!, outputs: ['pkg-a/gen.txt'] },
      ])
      expect(inputs.configDigest).toMatch(/^[0-9a-f]+$/)
      // Core keys no package file: nothing beside the listed inputs.
      expect(Object.keys(inputs).sort()).toEqual([
        'configDigest',
        'env',
        'files',
        'runtime',
        'upstream',
        'workspaceRuntime',
      ])
    } finally {
      cleanup()
    }
  })

  it('a task with no `cache` ships no inputs', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, '.vx/workspace.mjs'),
        localWorkspaceSource([
          pluginSource(
            'org/inputs-spy',
            `{ executor() {
               return {
                 name: 'spy',
                 async execute(req) {
                   globalThis.__vxNoInputs = req.inputs
                   return { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }
                 },
               }
             },
           }`,
          ),
        ]),
      )
      await gitInit(workspaceRoot)
      expect((await runHello(workspaceRoot)).ok).toBe(true)
      expect((globalThis as unknown as { __vxNoInputs: unknown }).__vxNoInputs).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  it('placement: exec.remote:false and depends-on-persistent tasks never reach a remote executor', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: {
           serve: { exec: { command: 'sleep 30', persistent: {} } },
           e2e: { exec: { command: 'echo e2e' }, dependsOn: ['serve'] },
           docker: { exec: { command: 'echo docker', remote: false } },
           hello: { exec: { command: 'echo hi' } },
         } }`,
      )
      await Bun.write(
        path.join(workspaceRoot, '.vx/workspace.mjs'),
        localWorkspaceSource([
          pluginSource(
            'org/remote',
            `{ executor() {
               return {
                 name: 'remote-spy',
                 remote: true,
                 accepts(task) { (globalThis.__vxOffered ??= []).push(task.taskId + ':' + task.pinnedLocal); return true },
                 async execute(req) {
                   (globalThis.__vxRemoteRan ??= []).push(req.taskId)
                   return { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }
                 },
               }
             },
           }`,
          ),
        ]),
      )
      await gitInit(workspaceRoot)
      const summary = await run({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['hello', 'e2e', 'docker'],
        log: makeSilentLogger(),
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      const g = globalThis as unknown as { __vxOffered: string[]; __vxRemoteRan: string[] }
      expect(g.__vxOffered.sort()).toEqual(['pkg-a#hello:false'])
      expect(g.__vxRemoteRan).toEqual(['pkg-a#hello'])
    } finally {
      cleanup()
    }
  })

  it('capacity: a pooled executor runs more tasks at once than the local worker count', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      const tasks = Array.from(
        { length: 6 },
        (_, i) => `t${i}: { exec: { command: 'echo ${i}' } }`,
      ).join(',')
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: { ${tasks} } }`,
      )
      await Bun.write(
        path.join(workspaceRoot, '.vx/workspace.mjs'),
        localWorkspaceSource([
          pluginSource(
            'org/pool',
            `{ executor() {
               return {
                 name: 'pool',
                 remote: true,
                 capacity: 6,
                 async execute(req) {
                   globalThis.__vxInflight = (globalThis.__vxInflight ?? 0) + 1
                   globalThis.__vxPeak = Math.max(globalThis.__vxPeak ?? 0, globalThis.__vxInflight)
                   await new Promise((r) => setTimeout(r, 150))
                   globalThis.__vxInflight--
                   return { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }
                 },
               }
             },
           }`,
          ),
        ]),
      )
      await gitInit(workspaceRoot)
      const summary = await run({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['t0', 't1', 't2', 't3', 't4', 't5'],
        concurrency: 1,
        log: makeSilentLogger(),
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      expect((globalThis as unknown as { __vxPeak: number }).__vxPeak).toBe(6)
    } finally {
      cleanup()
    }
  })

  it('capacity: two pooled executors that share a name each keep their own capacity', async () => {
    // The scheduler counted a pool by its executor's NAME, and a package
    // declared twice (`@vzn/vx-reapi` against two clusters) names both
    // executors alike: the two pools of 2 ran 2 tasks at once between them.
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      const tasks = Array.from(
        { length: 8 },
        (_, i) => `t${i}: { exec: { command: 'echo ${i}' } }`,
      ).join(',')
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: { ${tasks} } }`,
      )
      const pool = (low: boolean): string => `{ executor() {
               return {
                 name: 'pool',
                 remote: true,
                 capacity: 2,
                 accepts: (p) => (Number(p.taskId.slice(-1)) < 4) === ${low},
                 async execute(req) {
                   globalThis.__vxInflight = (globalThis.__vxInflight ?? 0) + 1
                   globalThis.__vxPeak = Math.max(globalThis.__vxPeak ?? 0, globalThis.__vxInflight)
                   await new Promise((r) => setTimeout(r, 150))
                   globalThis.__vxInflight--
                   return { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }
                 },
               }
             },
           }`
      await Bun.write(
        path.join(workspaceRoot, '.vx/workspace.mjs'),
        localWorkspaceSource([
          pluginSource('org/pool-low', pool(true)),
          pluginSource('org/pool-high', pool(false)),
        ]),
      )
      await gitInit(workspaceRoot)
      const g = globalThis as unknown as { __vxPeak: number; __vxInflight: number }
      g.__vxPeak = 0
      g.__vxInflight = 0
      const summary = await run({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: Array.from({ length: 8 }, (_, i) => `t${i}`),
        concurrency: 1,
        log: makeSilentLogger(),
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      expect(g.__vxPeak).toBe(4)
    } finally {
      cleanup()
    }
  })

  it('demand: core narrows what is still placed here, ending at empty', async () => {
    // An executor that provisions per task — a container, an allocation — has
    // no other way to know when to stop paying for capacity. `capacity` says
    // how much it MAY run at once; this says how much is actually left, so a
    // run whose tail is one slow task can give the rest back.
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: {
           a: { exec: { command: 'echo a' } },
           b: { exec: { command: 'echo b' } },
           c: { exec: { command: 'echo c' } },
         } }`,
      )
      await Bun.write(
        path.join(workspaceRoot, '.vx/workspace.mjs'),
        localWorkspaceSource([
          pluginSource(
            'org/demand',
            `{ executor() {
               globalThis.__vxDemand = []
               return {
                 name: 'demand-spy',
                 remote: true,
                 capacity: 1,
                 demand(remaining) { globalThis.__vxDemand.push(remaining.size) },
                 async execute() {
                   return { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }
                 },
               }
             },
           }`,
          ),
        ]),
      )
      await gitInit(workspaceRoot)
      const summary = await run({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['a', 'b', 'c'],
        log: makeSilentLogger(),
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      const seen = (globalThis as unknown as { __vxDemand: number[] }).__vxDemand
      // The whole set once at placement, then one report per completion.
      expect(seen).toEqual([3, 2, 1, 0])
    } finally {
      cleanup()
    }
  })

  it('demand: a task the cache answers is never counted', async () => {
    // DTE sized agents from the first report, and on a warm CI run 81 of
    // 100 tasks restored: it asked 8 agents and 4 ran nothing. Core tells
    // demand once the cache has said what it holds.
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      const task = (name: string) =>
        `${name}: { exec: { command: 'true' }, inputs: { files: ['${name}.txt'] }, cache: { outputs: { files: [] } } },`
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: { ${task('a')} ${task('b')} ${task('c')} } }`,
      )
      for (const name of ['a', 'b', 'c'])
        await Bun.write(path.join(workspaceRoot, `pkg-a/${name}.txt`), name)
      await Bun.write(
        path.join(workspaceRoot, '.vx/workspace.mjs'),
        localWorkspaceSource([
          pluginSource(
            'org/demand',
            `{ executor() {
               return {
                 name: 'demand-spy',
                 remote: true,
                 capacity: 1,
                 demand(remaining, missed) { globalThis.__vxDemand.push([remaining.size, missed.size]) },
                 async execute() {
                   return { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }
                 },
               }
             },
           }`,
          ),
        ]),
      )
      await gitInit(workspaceRoot)
      const g = globalThis as unknown as { __vxDemand: [number, number][] }
      const runAll = async (): Promise<[number, number][]> => {
        g.__vxDemand = []
        const summary = await run({
          cwd: workspaceRoot,
          projects: ['pkg-a'],
          tasks: ['a', 'b', 'c'],
          log: makeSilentLogger(),
          handleSignals: false,
        })
        expect(summary.ok).toBe(true)
        return g.__vxDemand
      }
      // Control: a cold cache answers nothing, so all three are demand,
      // and each is a sure miss: the probe asked for every key.
      expect(await runAll()).toEqual([
        [3, 3],
        [2, 2],
        [1, 1],
        [0, 0],
      ])
      await Bun.write(path.join(workspaceRoot, 'pkg-a/a.txt'), 'a2')
      expect(await runAll()).toEqual([
        [1, 1],
        [0, 0],
      ])
    } finally {
      cleanup()
    }
  })

  it('placement: --dry names the executor each task would land on', async () => {
    // `exec.remote` is otherwise invisible — nothing in a run's output says
    // where a task went, so a mis-declared pin reads exactly like a correct
    // one. This is the surface that makes it checkable BEFORE the run.
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: {
           hello: { exec: { command: 'echo hi' } },
           docker: { exec: { command: 'echo docker', remote: false } },
         } }`,
      )
      await Bun.write(
        path.join(workspaceRoot, '.vx/workspace.mjs'),
        localWorkspaceSource([
          pluginSource(
            'org/remote',
            `{ executor() {
               return {
                 name: 'spy-remote',
                 remote: true,
                 async execute() { throw new Error('plan mode must not execute') },
               }
             },
           }`,
          ),
        ]),
      )
      await gitInit(workspaceRoot)
      const plan = await planRun({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['hello', 'docker'],
        log: makeSilentLogger(),
      })
      const byId = new Map(plan.tasks.map((t) => [t.node.id, t.executor]))
      expect(byId.get('pkg-a#hello')).toBe('spy-remote')
      expect(byId.get('pkg-a#docker')).toBe('local')
    } finally {
      cleanup()
    }
  })

  it("placement: --dry says, in the plugin's name, when placement could not be resolved", async () => {
    // A plan must not fail over a label — but the run it previews WOULD
    // refuse on this plugin, and a plan that hid that read as "everything
    // lands locally". Control: the same plan succeeds and shows no
    // placement column (one executor, nothing to choose).
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: { hello: { exec: { command: 'echo hi' } } } }`,
      )
      await Bun.write(
        path.join(workspaceRoot, '.vx/workspace.mjs'),
        localWorkspaceSource([
          pluginSource('org/broken-exec', `{ executor() { throw new Error('exec boom') } }`),
        ]),
      )
      await gitInit(workspaceRoot)
      const status: string[] = []
      const plan = await planRun({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['hello'],
        log: makeSilentLogger((line) => status.push(line)),
      })
      expect(plan.tasks.map((t) => t.executor)).toEqual([undefined])
      const notices = status.filter((l) => l.includes('placement not shown'))
      expect(notices).toHaveLength(1)
      expect(notices[0]).toMatch(/^\[vx\] placement not shown — .*org\/broken-exec.*exec boom/)
      expect(notices[0]).toContain('the run would refuse on it')
    } finally {
      cleanup()
    }
  })

  it("placement: --dry labels a noop'd remote-only task as @noop, not as a lie", async () => {
    // `remote: 'only'` + a remote executor that DECLINES it = the task will
    // not run anywhere. A --dry that shows the local executor's name there
    // would promise an execution that never happens; `noop` is the honest
    // label, and it must only appear for exactly that configuration.
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: {
           install: {
             exec: { command: 'echo i', remote: 'only' },
             inputs: { files: ['package.json'] }, cache: { outputs: { files: ['deps/**'] } },
           },
           hello: {
             exec: { command: 'echo hi' },
             inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
           },
         } }`,
      )
      await Bun.write(
        path.join(workspaceRoot, '.vx/workspace.mjs'),
        localWorkspaceSource([
          pluginSource(
            'org/remote',
            `{ executor() {
               return {
                 name: 'picky-remote',
                 remote: true,
                 // declines install, takes hello — so one plan shows all
                 // three label states at once
                 accepts(task) { return task.taskId !== 'pkg-a#install' },
                 async execute() { throw new Error('plan mode must not execute') },
               }
             },
           }`,
          ),
        ]),
      )
      await gitInit(workspaceRoot)
      const plan = await planRun({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['install', 'hello'],
        log: makeSilentLogger(),
      })
      const byId = new Map(plan.tasks.map((t) => [t.node.id, t.executor]))
      expect(byId.get('pkg-a#install')).toBe('noop')
      expect(byId.get('pkg-a#hello')).toBe('picky-remote')
    } finally {
      cleanup()
    }
  })

  it("placement: --dry shows the REMOTE executor for an 'only' task it accepts", async () => {
    // The other half: when the remote pool takes it, the label is the
    // executor's name like any other placement — noop must not leak here.
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: {
           install: {
             exec: { command: 'echo i', remote: 'only' },
             inputs: { files: ['package.json'] }, cache: { outputs: { files: ['deps/**'] } },
           },
         } }`,
      )
      await Bun.write(
        path.join(workspaceRoot, '.vx/workspace.mjs'),
        localWorkspaceSource([
          pluginSource(
            'org/remote',
            `{ executor() {
               return {
                 name: 'pool',
                 remote: true,
                 async execute() { throw new Error('plan mode must not execute') },
               }
             },
           }`,
          ),
        ]),
      )
      await gitInit(workspaceRoot)
      const plan = await planRun({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['install'],
        log: makeSilentLogger(),
      })
      expect(plan.tasks.find((t) => t.node.id === 'pkg-a#install')?.executor).toBe('pool')
    } finally {
      cleanup()
    }
  })

  it('placement: --dry says nothing when the workspace declares one executor', async () => {
    // The control. With no choice to show, the label is noise, so every
    // plan line stays byte-identical to before placement existed.
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: { hello: { exec: { command: 'echo hi' } } } }`,
      )
      await writeLocalWorkspace(workspaceRoot)
      await gitInit(workspaceRoot)
      const plan = await planRun({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['hello'],
        log: makeSilentLogger(),
      })
      expect(plan.tasks.every((t) => t.executor === undefined)).toBe(true)
    } finally {
      cleanup()
    }
  })

  it("placement: --dry hands an executor factory the run's context, warn and concurrency", async () => {
    // With no `--concurrency` and no workspace `concurrency`, a run's worker
    // count is what the machine allows; the plan's factory sees the same.
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, '.vx/workspace.mjs'),
        localWorkspaceSource([
          pluginSource(
            'org/ctx',
            `{ executor(ctx) {
               ctx.warn('ctx concurrency ' + ctx.concurrency)
               return {
                 name: 'ctx-remote',
                 remote: true,
                 async execute() { throw new Error('plan mode must not execute') },
               }
             },
           }`,
          ),
        ]),
      )
      await gitInit(workspaceRoot)
      const status: string[] = []
      await planRun({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['hello'],
        log: makeSilentLogger((line) => status.push(line)),
      })
      expect(status.filter((l) => l.startsWith('ctx concurrency'))).toEqual([
        `ctx concurrency ${machineParallelism()}`,
      ])
    } finally {
      cleanup()
    }
  })

  it("placement: --dry labels a noop'd remote-only task @noop with ONE executor (C-48)", async () => {
    // The label is the plan's only word that the task will not run; with a
    // single executor it was dropped with the others, and the line read as
    // an execution.
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: {
           install: {
             exec: { command: 'echo i', remote: 'only' },
             inputs: { files: ['package.json'] }, cache: { outputs: { files: ['deps/**'] } },
           },
           hello: { exec: { command: 'echo hi' } },
         } }`,
      )
      await writeLocalWorkspace(workspaceRoot)
      await gitInit(workspaceRoot)
      const plan = await planRun({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['install', 'hello'],
        log: makeSilentLogger(),
      })
      expect(plan.tasks.map((t) => [t.node.id, t.executor])).toEqual([
        ['pkg-a#install', 'noop'],
        ['pkg-a#hello', undefined],
      ])
    } finally {
      cleanup()
    }
  })

  it("remote:'only' with NO remote executor is a local NO-OP: never runs, never cleans", async () => {
    // The install-as-action contract's local half. The command is a loud
    // failure (`exit 1` + a tombstone write) so this test cannot pass by the
    // task running and happening to succeed; and a pre-existing file inside
    // the DECLARED OUTPUT dir must survive, because cleaning node_modules on
    // a dev machine is exactly what the field forbids.
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: {
           install: {
             exec: { command: 'echo ran > tombstone.txt && exit 1', remote: 'only' },
             inputs: { files: ['package.json'] }, cache: { outputs: { files: ['deps/**'] } },
           },
           build: {
             exec: { command: 'cat deps/ambient.txt > out.txt' },
             dependsOn: ['install'],
             inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
           },
         } }`,
      )
      await Bun.write(path.join(workspaceRoot, 'pkg-a/src/x.txt'), 'x')
      // the machine's AMBIENT state — what a dev's own pnpm install left
      await Bun.write(path.join(workspaceRoot, 'pkg-a/deps/ambient.txt'), 'ambient-deps')
      await writeLocalWorkspace(workspaceRoot)
      await gitInit(workspaceRoot)
      const summary = await run({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['build'],
        log: makeSilentLogger(),
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      const install = summary.outcomes.find((o) => o.node.id === 'pkg-a#install')
      expect(install?.status).toBe('success')
      expect(install?.hash).toBeDefined() // dependents folded a real key
      // never executed…
      expect(await Bun.file(path.join(workspaceRoot, 'pkg-a/tombstone.txt')).exists()).toBe(false)
      // …never cleaned the declared outputs…
      expect(await Bun.file(path.join(workspaceRoot, 'pkg-a/deps/ambient.txt')).text()).toBe(
        'ambient-deps',
      )
      // …and the dependent consumed the ambient state, as before the field.
      expect(await Bun.file(path.join(workspaceRoot, 'pkg-a/out.txt')).text()).toBe('ambient-deps')
    } finally {
      cleanup()
    }
  })

  it("remote:'only' that nobody takes SAYS SO — a silent no-op reads as a task that worked", async () => {
    // The no-op above is deliberate, but it returns `success` having run
    // nothing. Without a line saying that, it is indistinguishable from a
    // task that did the work — and the most common cause (a task with no
    // `cache` block, which no remote executor can describe to a worker) is
    // invisible from the outcome. The CONTROL is in the same run: the
    // ordinary `build` task must not draw a line.
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: {
           install: {
             exec: { command: 'exit 1', remote: 'only' },
             inputs: { files: ['package.json'] }, cache: { outputs: { files: ['deps/**'] } },
           },
           build: {
             exec: { command: 'cat deps/ambient.txt > out.txt' },
             dependsOn: ['install'],
             inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
           },
         } }`,
      )
      await Bun.write(path.join(workspaceRoot, 'pkg-a/src/x.txt'), 'x')
      await Bun.write(path.join(workspaceRoot, 'pkg-a/deps/ambient.txt'), 'ambient-deps')
      await writeLocalWorkspace(workspaceRoot)
      await gitInit(workspaceRoot)
      const lines: string[] = []
      const summary = await run({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['build'],
        log: makeSilentLogger((l) => lines.push(l)),
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      const noopLines = lines.filter((l) => l.includes("exec.remote is 'only'"))
      expect(noopLines).toHaveLength(1)
      expect(noopLines[0]).toContain('pkg-a#install')
      expect(noopLines[0]).toContain('nothing ran')
      // no remote executor is declared in this workspace — say that, rather
      // than blaming the task's own declaration
      expect(noopLines[0]).toContain('no remote executor is declared')
      expect(noopLines.some((l) => l.includes('pkg-a#build'))).toBe(false)
    } finally {
      cleanup()
    }
  })

  it("remote:'only' that nobody takes: the plan's @noop and the run agree", async () => {
    // The same workspace planned, then run: what --dry calls a noop the run
    // must not execute, and its dependent must still run.
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: {
           install: {
             exec: { command: 'echo ran > tombstone.txt', remote: 'only' },
             inputs: { files: ['package.json'] }, cache: { outputs: { files: ['deps/**'] } },
           },
           build: {
             exec: { command: 'echo b > out.txt' },
             dependsOn: ['install'],
             inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
           },
         } }`,
      )
      await Bun.write(path.join(workspaceRoot, 'pkg-a/src/x.txt'), 'x')
      await writeLocalWorkspace(workspaceRoot)
      await gitInit(workspaceRoot)
      const opts = {
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['build'],
        log: makeSilentLogger(),
        handleSignals: false,
      }
      const plan = await planRun(opts)
      expect(Object.fromEntries(plan.tasks.map((t) => [t.node.id, t.executor ?? null]))).toEqual({
        'pkg-a#install': 'noop',
        'pkg-a#build': null,
      })
      const summary = await run(opts)
      expect(summary.ok).toBe(true)
      expect(await Bun.file(path.join(workspaceRoot, 'pkg-a/out.txt')).exists()).toBe(true)
      expect(await Bun.file(path.join(workspaceRoot, 'pkg-a/tombstone.txt')).exists()).toBe(false)
    } finally {
      cleanup()
    }
  })

  it("remote:'only' WITH a remote executor ships there, flagged, and stays off this disk", async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: {
           install: {
             exec: { command: 'echo remote-made > deps/lib.txt', remote: 'only' },
             inputs: { files: ['package.json'] }, cache: { outputs: { files: ['deps/**'] } },
           },
         } }`,
      )
      await Bun.write(
        path.join(workspaceRoot, '.vx/workspace.mjs'),
        localWorkspaceSource([
          pluginSource(
            'org/remote',
            `{ executor() {
               return {
                 name: 'remote-spy',
                 remote: true,
                 async execute(req) {
                   globalThis.__vxRemoteOnlyReq = {
                     remoteOnly: req.remoteOnly, cacheKey: req.cacheKey, taskId: req.taskId,
                   }
                   // deliberately does NOT write deps/lib.txt: a remote-only
                   // task's outputs stay remote, and core must not expect them
                   return { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }
                 },
               }
             },
           }`,
          ),
        ]),
      )
      await gitInit(workspaceRoot)
      const summary = await run({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['install'],
        log: makeSilentLogger(),
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      const seen = (globalThis as Record<string, unknown>)['__vxRemoteOnlyReq'] as {
        remoteOnly?: boolean
        cacheKey?: string
        taskId: string
      }
      expect(seen.taskId).toBe('pkg-a#install')
      expect(seen.remoteOnly).toBe(true)
      expect(seen.cacheKey).toMatch(/^[0-9a-f]+$/)
      // no local artifact was saved for it: a SECOND run must reach the
      // executor again (its own remote record is what dedupes, not vx's cache)
      const outcome = summary.outcomes.find((o) => o.node.id === 'pkg-a#install')
      expect(outcome?.status).toBe('success')
      expect(await Bun.file(path.join(workspaceRoot, 'pkg-a/deps/lib.txt')).exists()).toBe(false)
    } finally {
      cleanup()
    }
  })

  // .vx/workspace.* marks the root (2026-10-13): without one there is
  // no workspace to run.
  it('NO WORKSPACE FILE: the run is refused, naming `vx init`', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await gitInit(workspaceRoot)
      const err = await runHello(workspaceRoot).catch((e: unknown) => e)
      expect((err as { code?: string }).code).toBe('VX_E_NO_WORKSPACE')
    } finally {
      cleanup()
    }
  })

  it('NO PLUGINS: an empty declared plugin list runs on the fallbacks', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await writeLocalWorkspace(workspaceRoot)
      await gitInit(workspaceRoot)
      const summary = await runHello(workspaceRoot)
      expect(summary.ok).toBe(true)
    } finally {
      cleanup()
    }
  })
})

describe('TaskOutcome.where — executor placement attribution', () => {
  it('an executor-reported where rides the outcome into telemetry; local stays absent', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: {
           hello: { exec: { command: 'echo hi' } },
         } }`,
      )
      await Bun.write(
        path.join(workspaceRoot, '.vx/workspace.mjs'),
        localWorkspaceSource([
          pluginSource(
            'org/worker',
            `{ executor() {
               return {
                 name: 'spy-remote',
                 remote: true,
                 async execute() {
                   return {
                     exitCode: 0,
                     durationMs: 1,
                     stdout: '',
                     stderr: '',
                     violations: [],
                     where: 'worker-7',
                   }
                 },
               }
             },
           }`,
          ),
          pluginSource(
            'org/tap',
            `{ telemetry() {
               return {
                 name: 'tap',
                 onRecord(rec) {
                   if (rec.kind === 'task.end') {
                     ;(globalThis.__vxWhereTap ??= []).push([rec.taskId, rec.where])
                   }
                 },
                 onRunSummary(summary) {
                   ;(globalThis.__vxWhereSummary ??= []).push(
                     ...summary.tasks.map((t) => [t.taskId, t.where]),
                   )
                 },
               }
             },
           }`,
          ),
        ]),
      )
      await gitInit(workspaceRoot)
      const g = globalThis as unknown as {
        __vxWhereTap?: Array<[string, string | undefined]>
        __vxWhereSummary?: Array<[string, string | undefined]>
      }
      g.__vxWhereTap = []
      g.__vxWhereSummary = []
      const r = await run({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['hello'],
        log: makeSilentLogger(),
        handleSignals: false,
      })
      expect(r.ok).toBe(true)
      // Both telemetry surfaces carry the attribution.
      expect(g.__vxWhereTap).toEqual([['pkg-a#hello', 'worker-7']])
      expect(g.__vxWhereSummary).toEqual([['pkg-a#hello', 'worker-7']])
    } finally {
      cleanup()
    }
  })
})
