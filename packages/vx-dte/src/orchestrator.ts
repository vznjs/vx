// The orchestrator's half of a distributed run: the `vx run` the user
// started. It keeps a share of the tasks for this machine and hands the
// rest to the agents online, critical path first (the order core asks in):
// in batches that fill each agent's measured cores and memory by the tasks'
// recorded peaks, plus a small prefetch, preferring the agent that already
// holds a task's dependencies. Each agent's result is written back here
// before the task ends, so the run saves and reports it as its own.

import { realpathSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import {
  executorFallback,
  localFloor,
  withForwardArgs,
  type ExecuteRequest,
  type ExecuteResult,
  type SandboxConfig,
  type TaskNode,
} from '@vzn/vx'
import { fromParts, outputFiles, pack, toParts, unpack } from './bundle.js'
import type { AgentInfo, RunOrder, ToAgent, ToOrchestrator } from './messages.js'
import { RelayError, type Participant } from './wire.js'

/** What a task is expected to hold while it runs, from its history. */
export interface Need {
  readonly cores: number
  readonly memory: number
}

interface Job {
  readonly req: ExecuteRequest
  readonly need: Need
  readonly resolve: (r: ExecuteResult) => void
  readonly reject: (err: unknown) => void
  agent?: string
}

interface Agent {
  readonly id: string
  readonly cores: number
  readonly memory: number
  readonly label: string
  /** From its start to its join, when this run started it. */
  readonly warmUpMs: number | undefined
  /** The size it was started as, when this run started it. */
  readonly declared: Declared | undefined
  /** Tasks it finished. */
  ran: number
  /** Sent to it and not finished: running there or in its queue. */
  readonly busy: Map<string, Job>
  usedCores: number
  usedMemory: number
  /** Tasks whose outputs it holds: it ran them, or was sent them. */
  readonly has: Set<string>
  /** Sends to it go out in order: a run's parts before the run. */
  chain: Promise<void>
  /** It was sent the run's sandbox configs. */
  sandboxes: boolean
}

/** What an agent was started as: its size's `cpu` and `memory` in bytes. */
export interface Declared {
  readonly size: string
  readonly cpu: number
  readonly memory: number
}

export interface OrchestratorOptions {
  readonly me: Participant
  readonly root: string
  readonly commit: string
  /** Tasks this machine runs at once besides the agents. */
  readonly localSlots: number
  readonly nodes: () => ReadonlyMap<string, TaskNode> | undefined
  readonly need: (taskId: string) => Need
}

/** Cores an agent is sent beyond its own, so a finished task's successor is already there. */
const prefetch = (cores: number): number => Math.max(1, Math.ceil(cores / 4))

export class Orchestrator {
  private readonly agents = new Map<string, Agent>()
  private readonly queue: Job[] = []
  private readonly results = new Map<string, string[]>()
  private localBusy = 0
  private ranHere = 0
  /** When each agent this run started was asked for, by `AgentSpawn.index`. */
  private readonly spawnedAt = new Map<string, { at: number; declared: Declared }>()
  private ended = false
  /** Agents that joined and left, for the footer. */
  private readonly gone: Agent[] = []
  private pumping = false
  private joined = 0
  private readonly stop = new AbortController()
  private readonly loop: Promise<void>
  private readonly floor = localFloor()
  private readonly realRoot: string

  constructor(private readonly o: OrchestratorOptions) {
    // A root that is gone fails the run's own reads first.
    this.realRoot = (() => {
      try {
        return realpathSync(o.root)
      } catch {
        return o.root
      }
    })()
    this.loop = this.listen()
  }

  execute(req: ExecuteRequest): Promise<ExecuteResult> {
    if (this.lost !== undefined) return Promise.reject(executorFallback(this.lost))
    return new Promise((resolve, reject) => {
      const job: Job = { req, need: this.o.need(req.taskId), resolve, reject }
      req.signal?.addEventListener('abort', () => this.abort(job), { once: true })
      this.queue.push(job)
      this.pumpSoon()
    })
  }

  async close(): Promise<void> {
    this.ended = true
    this.stop.abort()
    await this.loop
    await this.o.me.leave()
    await this.floor.close()
  }

  private abort(job: Job): void {
    const at = this.queue.indexOf(job)
    if (at >= 0) {
      this.queue.splice(at, 1)
      job.resolve(
        result({ exitCode: 130, signal: 'SIGTERM', durationMs: 0, stdout: '', stderr: '' }),
      )
    } else if (job.agent !== undefined) {
      const a = this.agents.get(job.agent)
      if (a !== undefined) this.post(a, { type: 'cancel', task: job.req.taskId })
    }
  }

  /** Tasks core starts in one tick go out as one batch. */
  private pumpSoon(): void {
    if (this.pumping) return
    this.pumping = true
    setImmediate(() => {
      this.pumping = false
      this.pump()
    })
  }

  private pump(): void {
    const batches = new Map<Agent, Job[]>()
    const left: Job[] = []
    for (const job of this.queue.splice(0)) {
      if (this.localBusy < this.o.localSlots) {
        this.runHere(job)
        continue
      }
      const a = this.place(job)
      if (a === undefined) {
        left.push(job)
        continue
      }
      job.agent = a.id
      a.busy.set(job.req.taskId, job)
      a.usedCores += job.need.cores
      a.usedMemory += job.need.memory
      const batch = batches.get(a)
      if (batch === undefined) batches.set(a, [job])
      else batch.push(job)
    }
    this.queue.push(...left)
    for (const [a, jobs] of batches) this.send(a, jobs)
  }

  /**
   * The agent for `job`: one it fits on, else one with prefetch room left;
   * among those, the one holding most of its dependencies' outputs, then
   * the one with most cores free. A task bigger than every agent goes to an
   * idle one, alone.
   */
  private place(job: Job): Agent | undefined {
    const up = upstream(this.o.nodes(), job.req.taskId)
    let best: Agent | undefined
    let bestScore: number[] = []
    for (const a of this.agents.values()) {
      const fits =
        a.busy.size === 0 ||
        (a.usedCores + job.need.cores <= a.cores && a.usedMemory + job.need.memory <= a.memory)
      if (!fits && a.usedCores + job.need.cores > a.cores + prefetch(a.cores)) continue
      let held = 0
      for (const id of up) if (a.has.has(id)) held++
      const score = [fits ? 1 : 0, held, a.cores - a.usedCores]
      if (best === undefined || greater(score, bestScore)) {
        best = a
        bestScore = score
      }
    }
    return best
  }

  private runHere(job: Job): void {
    this.localBusy++
    this.floor
      .execute(job.req)
      .then((r) => {
        this.ranHere++
        job.resolve(r)
      }, job.reject)
      .finally(() => {
        this.localBusy--
        this.pumpSoon()
      })
  }

  private send(a: Agent, jobs: readonly Job[]): void {
    const nodes = this.o.nodes()
    const orders = jobs.map((job) => {
      const { req } = job
      const ship = [...upstream(nodes, req.taskId)].filter((id) => !a.has.has(id))
      for (const id of ship) a.has.add(id)
      // A task sent here leaves its outputs here for its dependants.
      a.has.add(req.taskId)
      const node = nodes?.get(req.taskId)
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.env)) if (v !== undefined) env[k] = v
      return {
        job,
        ship,
        order: {
          task: req.taskId,
          command: withForwardArgs(req.command, req.forwardArgs),
          cwd: path.relative(this.o.root, req.cwd),
          project: node === undefined ? '' : path.relative(this.o.root, node.projectDir),
          env,
          ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
          outputs: {
            files: [...req.outputs.files],
            workspaceFiles: [...req.outputs.workspaceFiles],
          },
          cores: job.need.cores,
          memory: job.need.memory,
          ...(req.sandbox === undefined ? {} : { sandbox: req.sandbox }),
        } as RunOrder,
      }
    })
    const sandboxed = orders.some((o) => o.order.sandbox !== undefined)
    const sandboxes = sandboxed && !a.sandboxes ? sandboxConfigs(nodes) : undefined
    if (sandboxed) a.sandboxes = true
    a.chain = a.chain
      .then(async () => {
        for (const { order, ship } of orders) {
          if (order.sandbox !== undefined)
            order.binds = await this.binds(order.sandbox.config.allowWrite)
          const files: string[] = []
          for (const id of ship) {
            const n = nodes!.get(id)!
            const outs = n.config.cache?.outputs
            if (outs === undefined) continue
            files.push(
              ...(await outputFiles(this.o.root, path.relative(this.o.root, n.projectDir), {
                files: outs.files,
                workspaceFiles: outs.workspaceFiles ?? [],
              })),
            )
          }
          if (files.length === 0) continue
          for (const data of toParts(await pack(this.o.root, files, null))) {
            await this.o.me.send(a.id, { type: 'part', task: order.task, data })
          }
        }
        await this.o.me.send(a.id, {
          type: 'batch',
          root: this.o.root,
          realRoot: this.realRoot,
          tasks: orders.map((o) => o.order),
          ...(sandboxes === undefined ? {} : { sandboxes }),
        } satisfies ToAgent)
      })
      .catch((err: unknown) => {
        // The relay refused the send (the agent is gone): the loss notice
        // puts the tasks back.
        if (err instanceof RelayError && err.status === 404) return
        for (const { job } of orders) job.reject(err)
      })
  }

  /** The write grants in this checkout that exist, which a bind needs on the agent too. */
  private async binds(writes: readonly string[]): Promise<{ path: string; dir: boolean }[]> {
    const out: { path: string; dir: boolean }[] = []
    for (const w of writes) {
      if (!w.startsWith(this.realRoot + path.sep)) continue
      const st = await lstat(w).catch(() => undefined)
      if (st !== undefined)
        out.push({ path: path.relative(this.realRoot, w), dir: st.isDirectory() })
    }
    return out
  }

  private post(a: Agent, m: ToAgent): void {
    a.chain = a.chain.then(() => this.o.me.send(a.id, m)).catch(() => undefined)
  }

  private async finish(a: Agent, task: string, parts: string[]): Promise<void> {
    const job = a.busy.get(task)
    if (job === undefined) return
    const head = (await unpack(this.o.root, fromParts(parts))) as Wired
    a.busy.delete(task)
    a.usedCores -= job.need.cores
    a.usedMemory -= job.need.memory
    a.ran++
    if (head.stdout !== '') job.req.onStdout(head.stdout)
    if (head.stderr !== '') job.req.onStderr(head.stderr)
    job.resolve({ ...result(head), where: a.label })
    this.pumpSoon()
  }

  private onRelay(body: { type?: string; id?: string; info?: unknown }): void {
    if (body.type === 'joined') {
      const info = body.info as Partial<AgentInfo> | null
      const id = body.id!
      const refuse = (reason: string): void => {
        void this.o.me
          .send(id, { type: 'refused', reason } satisfies ToAgent)
          .catch(() => undefined)
      }
      if (
        info?.v !== 1 ||
        !(info.id === undefined || typeof info.id === 'string') ||
        !(Number(info.cores) >= 1) ||
        !(Number(info.memory) >= 0)
      ) {
        return refuse('speaks another vx-dte protocol')
      }
      if (info.commit !== this.o.commit) {
        return refuse(`checked out ${info.commit}, the run is on ${this.o.commit}`)
      }
      // An agent this run started keeps the name it was started under;
      // one that joined on its own is numbered in the order it joined.
      const spawn = info.id === undefined ? undefined : this.spawnedAt.get(info.id)
      const asked = spawn?.at
      const taken = new Set([...this.agents.values(), ...this.gone].map((a) => a.label))
      let label = asked === undefined ? undefined : info.id
      while (label === undefined || taken.has(label)) label = `agent·${++this.joined}`
      this.agents.set(id, {
        id,
        warmUpMs: asked === undefined ? undefined : performance.now() - asked,
        declared: spawn?.declared,
        ran: 0,
        cores: Number(info.cores),
        memory: Number(info.memory),
        usedCores: 0,
        usedMemory: 0,
        label,
        busy: new Map(),
        has: new Set(),
        // Its name first, before any batch.
        chain: this.o.me
          .send(id, { type: 'welcome', name: label } satisfies ToAgent)
          .catch(() => undefined),
        sandboxes: false,
      })
    } else if (body.type === 'lost') {
      const a = this.agents.get(body.id!)
      if (a === undefined) return
      this.agents.delete(a.id)
      this.gone.push(a)
      // Its tasks run again: first, as they were first to go.
      const back = [...a.busy.values()].filter((j) => j.req.signal?.aborted !== true)
      for (const j of back) delete j.agent
      this.queue.unshift(...back)
    } else {
      return
    }
    this.pumpSoon()
  }

  private async listen(): Promise<void> {
    let failures = 0
    while (!this.stop.signal.aborted) {
      let messages
      try {
        messages = await this.o.me.poll(this.stop.signal)
        failures = 0
      } catch (err) {
        if (this.stop.signal.aborted) return
        // A relay that stays unreachable for three heartbeats has lost this
        // run: what it held runs here instead.
        if (++failures < 3) {
          await Bun.sleep(this.o.me.heartbeatMs)
          continue
        }
        const reason = `the relay is unreachable (${(err as Error).message})`
        for (const a of this.agents.values())
          for (const j of a.busy.values()) j.reject(executorFallback(reason))
        for (const j of this.queue.splice(0)) j.reject(executorFallback(reason))
        this.agents.clear()
        this.lost = reason
        return
      }
      for (const { from, body } of messages) {
        if (from === 'relay') {
          this.onRelay(body as { type?: string })
          continue
        }
        const a = this.agents.get(from)
        if (a === undefined) continue
        const m = body as ToOrchestrator
        if (m.type === 'part') {
          const list = this.results.get(`${from}\0${m.task}`) ?? []
          list.push(m.data)
          this.results.set(`${from}\0${m.task}`, list)
        } else if (m.type === 'end') {
          const parts = this.results.get(`${from}\0${m.task}`) ?? []
          this.results.delete(`${from}\0${m.task}`)
          await this.finish(a, m.task, parts).catch((err: unknown) => {
            a.busy.get(m.task)?.reject(err)
            a.busy.delete(m.task)
          })
        }
      }
    }
  }

  /** `demand` asked the adapter for agent `id` (`AgentSpawn.id`). */
  spawned(id: string, declared: Declared): void {
    this.spawnedAt.set(id, { at: performance.now(), declared })
  }

  /**
   * The `agents` row: while the run goes, how many are starting, online
   * and gone; each agent by `size·index` with the tasks it ran and its
   * warm-up; the tasks this machine ran itself.
   */
  footer(): [string, string][] {
    if (this.spawnedAt.size === 0 && this.agents.size === 0) return []
    const all = [...this.agents.values(), ...this.gone]
    const joined = all.filter((a) => a.warmUpMs !== undefined).length
    const starting = Math.max(0, this.spawnedAt.size - joined)
    // Over, the run says how many took part; until then, who is up.
    const head = [
      this.ended ? `${all.length} joined` : `${this.agents.size} online`,
      ...(starting > 0 ? [`${starting} starting`] : []),
      ...(this.gone.length > 0 ? [`${this.gone.length} gone`] : []),
    ].join(' · ')
    const lines: [string, string][] = all
      .sort((x, y) => x.label.localeCompare(y.label, 'en', { numeric: true }))
      .map((a) => [
        a.label,
        `${a.ran} ran${a.warmUpMs === undefined ? '' : `, warm-up ${seconds(a.warmUpMs)}`}`,
      ])
    if (this.ranHere > 0) lines.push(['here', `${this.ranHere} ran`])
    const width = Math.max(0, ...lines.map(([l]) => l.length))
    // Once the run is over: each size whose machines are not what it says.
    const off = new Map<string, string>()
    for (const a of this.ended ? all : []) {
      const d = a.declared
      if (d === undefined || off.has(d.size)) continue
      if (a.cores === d.cpu && Math.abs(a.memory - d.memory) <= d.memory * 0.1) continue
      off.set(
        d.size,
        `${d.size}: config ${d.cpu} cores ${gb(d.memory)}, reported ${a.cores} cores ${gb(a.memory)}`,
      )
    }
    return [
      ['agents', head],
      ...lines.map(([l, t]): [string, string] => ['', `${l.padEnd(width)}  ${t}`]),
      ...[...off.values()].map((t): [string, string] => ['', `! ${t}`]),
    ]
  }

  /** Why the relay was given up on; then every task runs here. */
  lost: string | undefined
}

function greater(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! > b[i]!
  return false
}

/** A result as an agent sends it: JSON, so a violation's time is a string. */
type Wired = Omit<ExecuteResult, 'violations' | 'outputs'> & {
  violations?: (Omit<ExecuteResult['violations'][number], 'timestamp'> & { timestamp: string })[]
}

function result(r: Wired): ExecuteResult {
  const violations = (r.violations ?? []).map((v) => ({ ...v, timestamp: new Date(v.timestamp) }))
  return { ...r, violations, outputs: { kind: 'disk' } }
}

/** Each distinct `exec.sandbox` of the run, for an agent's sandbox runtime. */
function sandboxConfigs(nodes: ReadonlyMap<string, TaskNode> | undefined): SandboxConfig[] {
  const seen = new Map<string, SandboxConfig>()
  for (const n of nodes?.values() ?? []) {
    const s = n.config.exec?.sandbox
    if (s !== undefined) seen.set(JSON.stringify(s), s)
  }
  return [...seen.values()]
}

/** Every task `id` depends on, transitively. */
function upstream(nodes: ReadonlyMap<string, TaskNode> | undefined, id: string): Set<string> {
  const seen = new Set<string>()
  const walk = (t: string): void => {
    for (const d of nodes?.get(t)?.deps ?? []) {
      if (seen.has(d)) continue
      seen.add(d)
      walk(d)
    }
  }
  walk(id)
  return seen
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

const gb = (n: number): string => `${Math.round(n / 1e9)} GB`
