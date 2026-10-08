// The run's stop signal and the attempts it reaches: each attempt listens
// while its executor runs and takes the listener off once it settles. Left
// on, a run's listener list grew to its task count, and each add scanned
// the list for a duplicate (quadratic over a 1,000-task cold run).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { gitInit } from './helpers/workspace.js'
import { Cache } from '../src/cache/index.js'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import type { ExecuteRequest, TaskExecutor } from '../src/exec/index.js'
import type { Logger } from '../src/orchestrator/index.js'
import { executeTask } from '../src/orchestrator/execute-task.js'

const quiet: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

describe("an attempt's listener on the run's stop signal", () => {
  let root: string
  let dir: string
  let cache: Cache
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-stop-listener-'))
    dir = path.join(root, 'proj')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'proj' }))
    gitInit(root)
    cache = new Cache(path.join(root, '.vx', 'cache'))
  })
  afterEach(async () => {
    cache.close()
    await rm(root, { recursive: true, force: true })
  })

  const node = (id: string): TaskNode => ({
    id,
    projectName: 'proj',
    projectDir: dir,
    taskName: id.split('#')[1]!,
    config: { exec: { command: 'true' } },
    deps: [],
    requested: true,
  })

  /** The stop signal, counting the listeners on it. */
  const counted = (): { stop: AbortController; live: () => number } => {
    const stop = new AbortController()
    let live = 0
    const add = stop.signal.addEventListener.bind(stop.signal)
    const remove = stop.signal.removeEventListener.bind(stop.signal)
    stop.signal.addEventListener = ((...a: Parameters<typeof add>) => {
      live++
      add(...a)
    }) as typeof add
    stop.signal.removeEventListener = ((...a: Parameters<typeof remove>) => {
      live--
      remove(...a)
    }) as typeof remove
    return { stop, live: () => live }
  }

  const run = (n: TaskNode, executor: TaskExecutor, stopSignal: AbortSignal) =>
    executeTask({
      node: n,
      upstream: [] as TaskOutcome[],
      workspaceRoot: root,
      workspaceFingerprint: 'fixture-fingerprint',
      cache,
      log: quiet,
      executor,
      nestedProjectDirs: [] as string[],
      runStartHrTimeNs: process.hrtime.bigint(),
      keyedProjects: () => new Set<string>(),
      stopSignal,
    })

  const ok = { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }

  it('is taken off once each attempt settles', async () => {
    const { stop, live } = counted()
    const during: number[] = []
    const executor = {
      name: 'org/count',
      execute: async () => {
        during.push(live())
        return ok
      },
    } as never
    for (const id of ['proj#a', 'proj#b', 'proj#c']) {
      expect((await run(node(id), executor, stop.signal)).status).toBe('success')
    }
    // One listener while each attempt ran, none after: the list never grows.
    expect(during).toEqual([1, 1, 1])
    expect(live()).toBe(0)
  })

  it('CONTROL: a stop during the attempt still reaches its request', async () => {
    const { stop } = counted()
    let reached: boolean | undefined
    const executor = {
      name: 'org/stopped',
      execute: async (req: ExecuteRequest) => {
        stop.abort('SIGTERM')
        reached = req.signal?.aborted
        return { ...ok, exitCode: 143, signal: 'SIGTERM' as const }
      },
    } as never
    expect((await run(node('proj#a'), executor, stop.signal)).status).toBe('aborted')
    expect(reached).toBe(true)
  })

  it('a stop during the probe neither cleans the outputs nor asks the executor', async () => {
    // Dispatched before the stop, which landed during the cache probe: the
    // miss path wiped the last build and handed the executor a request to
    // start after the run had stopped.
    await mkdir(path.join(dir, 'dist'), { recursive: true })
    await writeFile(path.join(dir, 'dist', 'old.txt'), 'last build')
    const stop = new AbortController()
    const probe = cache.get.bind(cache)
    cache.get = async (...a) => {
      const hit = await probe(...a)
      stop.abort('SIGINT')
      return hit
    }
    let asked = 0
    const executor = {
      name: 'org/remote',
      execute: async () => {
        asked++
        return { ...ok, exitCode: 130, signal: 'SIGINT' as const }
      },
    } as never
    const n: TaskNode = {
      ...node('proj#build'),
      config: {
        exec: { command: 'true' },
        cache: { inputs: { files: ['package.json'] }, outputs: { files: ['dist/**'] } },
      },
    }
    const outcome = await run(n, executor, stop.signal)
    expect(outcome.status).toBe('aborted')
    expect(outcome.exitCode).toBe(130)
    expect(asked).toBe(0)
    expect(await Bun.file(path.join(dir, 'dist', 'old.txt')).text()).toBe('last build')
  })
})
