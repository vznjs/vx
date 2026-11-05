// A distributed run played through the real `Orchestrator`, as a run
// drives it: core hands each task over as its dependencies end, the
// orchestrator pumps on every message, and workers answer each batch on
// an in-memory relay. What it measures is the orchestrator's own work.

import type { ExecuteRequest, TaskNode } from '@vzn/vx'
import type { Participant } from '../src/wire.js'
import type { RelayMessage } from '../src/wire.js'
import type { ToOrchestrator, ToWorker } from '../src/messages.js'
import { Orchestrator } from '../src/orchestrator.js'
import { tailsMs } from '../src/planner.js'

export interface LiveTask {
  readonly id: string
  readonly deps: readonly string[]
}

export interface LiveOptions {
  /** Workers, each this many cores. */
  readonly workers: number
  readonly cores: number
  /** How long a task runs on its worker. */
  readonly taskMs: number
  /** Tasks handed over at once, as core's executor pool (`capacity`); default twice the cores, as `dte()`'s. */
  readonly capacity?: number
}

/** A relay in memory: the orchestrator's mailbox, and the workers' handlers. */
class Line implements Participant {
  readonly id = 'orchestrator'
  readonly heartbeatMs = 2000
  readonly online = true
  private readonly box: RelayMessage[] = []
  private wake: (() => void) | undefined
  constructor(private readonly to: (worker: string, body: ToWorker) => void) {}
  resumed(): void {}
  quiet(): void {}
  async send(to: string, body: unknown): Promise<void> {
    this.to(to, body as ToWorker)
  }
  async remove(): Promise<void> {}
  async leave(): Promise<void> {}
  deliver(m: RelayMessage): void {
    this.box.push(m)
    this.wake?.()
  }
  async poll(signal?: AbortSignal): Promise<RelayMessage[]> {
    if (this.box.length === 0 && signal?.aborted !== true) {
      const stop = (): void => this.wake?.()
      signal?.addEventListener('abort', stop, { once: true })
      await new Promise<void>((done) => (this.wake = done))
      this.wake = undefined
      signal?.removeEventListener('abort', stop)
    }
    return this.box.splice(0)
  }
}

export interface LiveResult {
  readonly ms: number
  /** Batches the orchestrator sent. */
  readonly batches: number
  /** Times the orchestrator looked a task up in the graph: how much of it it walked. */
  readonly lookups: number
}

/** The run's graph, counting each look-up of a task in it. */
class Graph extends Map<string, TaskNode> {
  lookups = 0
  override get(id: string): TaskNode | undefined {
    this.lookups++
    return super.get(id)
  }
}

export async function liveRun(
  graph: readonly LiveTask[],
  options: LiveOptions,
): Promise<LiveResult> {
  const nodes = new Graph(
    graph.map((t) => [
      t.id,
      {
        id: t.id,
        deps: [...t.deps],
        projectDir: `/ws/${t.id.split('#')[0]}`,
        config: { exec: { command: 'x' }, cache: { outputs: { files: ['dist/**'] } } },
      } as unknown as TaskNode,
    ]),
  )
  const byId = new Map(graph.map((t) => [t.id, t]))
  let batches = 0
  const line: Line = new Line((worker, body) => {
    if (body.type !== 'batch') return
    batches++
    for (const t of body.tasks)
      setTimeout(() => {
        const now = Date.now()
        line.deliver({
          from: worker,
          body: {
            type: 'end',
            task: t.task,
            key: t.key ?? t.runKey,
            result: { exitCode: 0, durationMs: options.taskMs },
            startedAt: now - options.taskMs,
            ranAt: now,
            endedAt: now,
            load: { cpu: 0, memory: 0, at: now },
          } satisfies ToOrchestrator,
        } as RelayMessage)
      }, options.taskMs)
  })
  const o = new Orchestrator({
    me: line,
    root: '/ws',
    tree: 'aaa',
    nodes: () => nodes,
    need: () => ({ cores: 1, memory: 0 }),
    artifacts: {
      save: async () => {},
      restore: async () => [],
      output: async () => [],
      share: async () => true,
      resend: async () => true,
    } as unknown as ConstructorParameters<typeof Orchestrator>[0]['artifacts'],
    cacheFacts: async () => ({ refs: [], lent: {} }),
    run: 'run',
    keyOf: (id) => `k-${id}`,
    // As `dte()`'s: the queue places the longest chain first.
    tail: tailsMs(nodes, () => options.taskMs),
  })
  for (let i = 0; i < options.workers; i++)
    line.deliver({
      from: 'relay',
      body: {
        type: 'joined',
        id: `w${i}`,
        info: { v: 1, cores: options.cores, memory: 1e12, tree: 'aaa' },
      },
    } as RelayMessage)
  const started = performance.now()
  // Core: each task once its dependencies ended.
  const left = new Map(graph.map((t) => [t.id, t.deps.length]))
  const dependants = new Map<string, string[]>()
  for (const t of graph)
    for (const d of t.deps) dependants.set(d, [...(dependants.get(d) ?? []), t.id])
  const capacity = options.capacity ?? 2 * options.workers * options.cores
  await new Promise<void>((done, fail) => {
    let ended = 0
    let active = 0
    const pool: string[] = []
    const run = (id: string): void => {
      if (active >= capacity) {
        pool.push(id)
        return
      }
      active++
      void o
        .execute({
          taskId: id,
          command: 'x',
          cwd: `/ws/${byId.get(id)!.id.split('#')[0]}`,
          env: {},
          envDefine: {},
          cacheKey: `k-${id}`,
          outputs: { files: ['dist/**'], workspaceFiles: [] },
          onStdout: () => {},
          onStderr: () => {},
        } as unknown as ExecuteRequest)
        .then(() => {
          active--
          if (++ended === graph.length) return done()
          const next = pool.shift()
          if (next !== undefined) run(next)
          for (const d of dependants.get(id) ?? []) {
            const n = left.get(d)! - 1
            left.set(d, n)
            if (n === 0) run(d)
          }
        }, fail)
    }
    for (const t of graph) if (t.deps.length === 0) run(t.id)
  })
  const ms = performance.now() - started
  const { lookups } = nodes
  await o.close()
  return { ms, batches, lookups }
}

/** How many tasks each task of `graph` depends on, transitively, all told. */
export function closures(graph: readonly LiveTask[]): number {
  const deps = new Map(graph.map((t) => [t.id, t.deps]))
  const of = new Map<string, Set<string>>()
  const up = (id: string): Set<string> => {
    let out = of.get(id)
    if (out !== undefined) return out
    out = new Set()
    for (const d of deps.get(id) ?? []) {
      out.add(d)
      for (const x of up(d)) out.add(x)
    }
    of.set(id, out)
    return out
  }
  let n = 0
  for (const t of graph) n += up(t.id).size
  return n
}

/** `projects` projects, each `build` on up to `fanIn` earlier ones' builds, and a `test` on its build. */
export function monorepo(projects: number, fanIn: number, seed = 1): LiveTask[] {
  let s = seed
  const rand = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
  const out: LiveTask[] = []
  for (let p = 0; p < projects; p++) {
    const deps = new Set<string>()
    for (let i = 0; i < fanIn && p > 0; i++) deps.add(`p${Math.floor(rand() * p)}#build`)
    out.push({ id: `p${p}#build`, deps: [...deps] })
    out.push({ id: `p${p}#test`, deps: [`p${p}#build`] })
  }
  return out
}
