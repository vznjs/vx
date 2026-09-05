// The run-level plugin capabilities (cache / executor / telemetry),
// inverted from core's hardcoded hooks in Phase 1 of
// docs/design/core-cloud-split-2026-06.md. Each test declares a VxPlugin
// in vx.workspace.mjs and asserts the seam is consulted. Nothing is applied
// by default: every e2e fixture declares the local executor + cache plugins
// AFTER its own, and the NO DEFAULTS pin below is what a bare workspace sees.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { CORE_INDEX, localWorkspaceSource, writeLocalWorkspace } from './helpers/local-workspace.js'
import { planRun, run } from '../src/index.js'
import { resolveCache, resolveExecutors, type VxPlugin } from '../src/orchestrator/index.js'
import type { TaskExecutor, TaskInputs } from '../src/exec/index.js'
import { Cache, ChainedCache } from '../src/cache/index.js'
import { loadWorkspaceConfig } from '../src/workspace/index.js'

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

// --- plugin-host unit-level consultation -------------------------------

describe('plugin-host — capability consultation + fallbacks', () => {
  const baseCtx = { workspaceRoot: '/ws', cacheDir: '/ws/.vx/cache', warn: () => undefined }

  it('resolveCache: every contributing plugin is kept, chained in declaration order', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'vx-cache-host-'))
    const local = new Cache(cacheDir, { read: true, write: true })
    const other = new Cache(mkdtempSync(path.join(tmpdir(), 'vx-cache-host2-')), {
      read: true,
      write: true,
    })
    const plugins: VxPlugin[] = [
      { name: 'org/none', cache: () => undefined },
      { name: 'org/cache', cache: () => other },
      { name: 'org/late', cache: () => local },
    ]
    try {
      const resolved = await resolveCache(plugins, {
        ...baseCtx,
        localCache: local,
        policy: { localRead: true, localWrite: true, remoteRead: false, remoteWrite: false },
      })
      expect(resolved).toBeInstanceOf(ChainedCache)
      expect((resolved as ChainedCache).layers).toEqual([other, local])
    } finally {
      local.close()
      other.close()
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it('resolveCache: a plugin that declines leaves the local handle unwrapped', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'vx-cache-host-'))
    const local = new Cache(cacheDir, { read: true, write: true })
    try {
      const resolved = await resolveCache([{ name: 'org/none', cache: () => undefined }], {
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
      { name: 'org/a', executor: () => a },
      { name: 'org/none', executor: () => undefined },
      { name: 'org/b', executor: async () => b },
    ]
    const resolved = await resolveExecutors(plugins, { ...baseCtx, concurrency: 4 })
    // core's local executor is the tail of every list, never the head
    expect(resolved.slice(0, 2)).toEqual([a, b])
    expect(resolved.map((e) => e.name)).toEqual(['a', 'b', 'local'])
  })

  it('resolveExecutors: a throwing executor factory aborts with a named UserError', async () => {
    const plugins: VxPlugin[] = [
      {
        name: 'org/broken-exec',
        executor: () => {
          throw new Error('exec boom')
        },
      },
    ]
    await expect(resolveExecutors(plugins, { ...baseCtx, concurrency: 1 })).rejects.toThrow(
      /org\/broken-exec.*exec boom/,
    )
  })
})

// --- end-to-end through run() / cli via vx.workspace.mjs ---------------

describe('plugin capabilities — end-to-end', () => {
  it('a cache plugin is consulted during a real run()', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      // The plugin returns ctx.localCache as its CacheLayer (a no-op
      // wrapper conceptually) and records that it was consulted.
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource(
          [
            `{
             name: 'org/cache',
             cache(ctx) {
               globalThis.__vxCachePluginConsulted = true
               return ctx.localCache
             },
           }`,
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
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource([
          `{
             name: 'org/bad-cache',
             cache() { throw new Error('cache boom') },
           }`,
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
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        `export default { plugins: [{ name: 'org/exec', executor() { return undefined } }] }`,
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
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        `export default { plugins: [{ name: 'org/exec', executor: 42 }] }`,
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
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource(
          [
            `{
             name: 'org/exec',
             executor() {
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

  it('an executor that declines a task falls through to the local executor declared after it', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource(
          [
            `{
             name: 'org/picky',
             executor() {
               return {
                 name: 'picky',
                 accepts(task) { globalThis.__vxDeclined.push(task.taskId); return false },
                 async execute() { throw new Error('must not run') },
               }
             },
           }`,
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

  it('a cacheable task executed by a plugin executor is saved and replayed as a hit', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: { hello: {
           exec: { command: 'echo hi > out.txt' },
           cache: { inputs: { files: ['package.json'] }, outputs: { files: ['out.txt'] } },
         } } }`,
      )
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource(
          [
            `{
             name: 'org/exec',
             executor() {
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
  it('two declared cache plugins: a run saves into BOTH stores', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    const second = mkdtempSync(path.join(tmpdir(), 'vx-second-cache-'))
    try {
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: { hello: {
           exec: { command: 'echo hi > out.txt' },
           cache: { inputs: { files: ['package.json'] }, outputs: { files: ['out.txt'] } },
         } } }`,
      )
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource(
          [
            `{ name: 'org/second', cache: () => new Cache(${JSON.stringify(second)}, { read: true, write: true }) }`,
          ],
          `import { Cache } from ${JSON.stringify(CORE_INDEX)}`,
        ),
      )
      await gitInit(workspaceRoot)
      const summary = await runHello(workspaceRoot)
      expect(summary.ok).toBe(true)
      const hash = summary.outcomes[0]?.hash
      expect(typeof hash).toBe('string')
      const secondCache = new Cache(second, { read: true, write: true })
      const localCache = new Cache(path.join(workspaceRoot, '.vx/cache'), {
        read: true,
        write: true,
      })
      try {
        expect((await secondCache.get(hash!))?.hash).toBe(hash)
        expect((await localCache.get(hash!))?.hash).toBe(hash)
      } finally {
        secondCache.close()
        localCache.close()
      }
    } finally {
      cleanup()
      rmSync(second, { recursive: true, force: true })
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
             cache: { inputs: { files: ['src.txt'] }, outputs: { files: ['gen.txt'] } },
           },
           hello: {
             exec: { command: 'echo hi > out.txt' },
             dependsOn: ['codegen'],
             cache: {
               inputs: { files: ['src.txt'], env: ['VX_TEST_INPUT'], runtime: ['echo tool-1.2'], tasks: ['codegen'] },
               outputs: { files: ['out.txt'] },
             },
           },
         } }`,
      )
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource([
          `{
             name: 'org/inputs-spy',
             executor() {
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
      expect(inputs.packageJsonDigest).toMatch(/^[0-9a-f]+$/)
      expect(inputs.configDigest).toMatch(/^[0-9a-f]+$/)
      expect(inputs.workspaceFingerprint.length).toBeGreaterThan(0)
    } finally {
      cleanup()
    }
  })

  it('a task with no `cache` ships no inputs', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource([
          `{
             name: 'org/inputs-spy',
             executor() {
               return {
                 name: 'spy',
                 async execute(req) {
                   globalThis.__vxNoInputs = req.inputs
                   return { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }
                 },
               }
             },
           }`,
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
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource([
          `{
             name: 'org/remote',
             executor() {
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
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource([
          `{
             name: 'org/pool',
             executor() {
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
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource([
          `{
             name: 'org/demand',
             executor() {
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

  it("placement: a task's exec.resources reach the executor VERBATIM", async () => {
    // Declared, not resolved: an executor placing the task on another machine
    // matches these numbers against what its workers actually have, and
    // `image` is a routing constraint core knows nothing about. Resolving or
    // dropping any of it here would strand the executor.
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: {
           big: { exec: { command: 'echo big', resources: { cpus: 2, memory: 512, image: 'vx-pw' } } },
           plain: { exec: { command: 'echo plain' } },
         } }`,
      )
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource([
          `{
             name: 'org/sizing',
             executor() {
               globalThis.__vxPlaced = {}
               return {
                 name: 'sizing-spy',
                 remote: true,
                 accepts(task) {
                   globalThis.__vxPlaced[task.taskId] = task.resources ?? null
                   return true
                 },
                 async execute() {
                   return { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }
                 },
               }
             },
           }`,
        ]),
      )
      await gitInit(workspaceRoot)
      const summary = await run({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['big', 'plain'],
        log: makeSilentLogger(),
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      const placed = (globalThis as unknown as { __vxPlaced: Record<string, unknown> }).__vxPlaced
      expect(placed['pkg-a#big']).toEqual({ cpus: 2, memory: 512, image: 'vx-pw' })
      // The control: a task that declares nothing carries nothing, so an
      // executor can tell "no reservation" from "zero".
      expect(placed['pkg-a#plain']).toBeNull()
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
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource([
          `{
             name: 'org/remote',
             executor() {
               return {
                 name: 'spy-remote',
                 remote: true,
                 async execute() { throw new Error('plan mode must not execute') },
               }
             },
           }`,
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
             cache: { inputs: { files: ['package.json'] }, outputs: { files: ['deps/**'] } },
           },
           hello: {
             exec: { command: 'echo hi' },
             cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
           },
         } }`,
      )
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource([
          `{
             name: 'org/remote',
             executor() {
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
             cache: { inputs: { files: ['package.json'] }, outputs: { files: ['deps/**'] } },
           },
         } }`,
      )
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource([
          `{
             name: 'org/remote',
             executor() {
               return {
                 name: 'pool',
                 remote: true,
                 async execute() { throw new Error('plan mode must not execute') },
               }
             },
           }`,
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
             cache: { inputs: { files: ['package.json'] }, outputs: { files: ['deps/**'] } },
           },
           build: {
             exec: { command: 'cat deps/ambient.txt > out.txt' },
             dependsOn: ['install'],
             cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
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
             cache: { inputs: { files: ['package.json'] }, outputs: { files: ['deps/**'] } },
           },
           build: {
             exec: { command: 'cat deps/ambient.txt > out.txt' },
             dependsOn: ['install'],
             cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
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

  it("remote:'only' WITH a remote executor ships there, flagged, and stays off this disk", async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: {
           install: {
             exec: { command: 'echo remote-made > deps/lib.txt', remote: 'only' },
             cache: { inputs: { files: ['package.json'] }, outputs: { files: ['deps/**'] } },
           },
         } }`,
      )
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource([
          `{
             name: 'org/remote',
             executor() {
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

  it('NO PLUGINS: a workspace with no workspace file at all runs on the fallbacks', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await gitInit(workspaceRoot)
      const summary = await runHello(workspaceRoot)
      expect(summary.ok).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('CONTROL: the same workspace with an empty declared plugin list runs too', async () => {
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
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource([
          `{
             name: 'org/worker',
             executor() {
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
          `{
             name: 'org/tap',
             telemetry() {
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
