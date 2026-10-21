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
  localFloor,
  machineMemoryBytes,
  machineParallelism,
  ui,
  withForwardArgs,
  type ExecuteRequest,
  type ExecuteResult,
  type MachineReport,
  type SandboxConfig,
  type TaskNode,
} from '@vzn/vx'
import { fromParts, outputFiles, pack, toParts, unpack } from './bundle.js'
import type { AgentInfo, RunOrder, ToAgent, ToOrchestrator } from './messages.js'
import { Usage, type UsageStats } from './usage.js'
import { RelayError, type Participant } from './wire.js'

/** What a task is expected to hold while it runs, from its history; `Infinity` (unmeasured): a whole agent. */
export interface Need {
  readonly cores: number
  readonly memory: number
  /** It filled a machine this big last time: only a bigger one takes it, if any agent is. */
  readonly above?: { readonly cores: number; readonly memory: number }
}

interface Job {
  readonly req: ExecuteRequest
  readonly need: Need
  /** The cores and memory it holds on its agent: its need, or the whole agent for an unmeasured one. */
  held?: Need
  readonly resolve: (r: ExecuteResult) => void
  readonly reject: (err: unknown) => void
  agent?: string
  /** The agents that failed it after beginning it, with why: two fail it. */
  faults?: string[]
  /** Its agent's lease on it ends then unless the agent says it still holds it. */
  leaseUntil?: number
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
  readonly usage: Usage
  /** Sent to it and not finished: running there or in its queue. */
  readonly busy: Map<string, Job>
  /** Of `busy`, the ones it began. */
  readonly started: Set<string>
  usedCores: number
  usedMemory: number
  /** Tasks whose outputs it holds: it ran them, or was sent them. */
  readonly has: Set<string>
  /** Sends to it go out in order: a run's parts before the run. */
  chain: Promise<void>
  /** It was sent the run's sandbox configs. */
  sandboxes: boolean
  /** It failed a task it began: it gets no more. */
  faulty: boolean
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
  /** The tree of the run's tracked files (`tree.ts`). */
  readonly tree: string
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
  private readonly runningHere = new Set<string>()
  /** When each agent this run started was asked for, by `AgentSpawn.index`. */
  private readonly spawnedAt = new Map<string, { at: number; declared: Declared }>()
  private ended = false
  private endedAt = 0
  /** This machine's share. */
  private readonly local = new Usage()
  /** Agents that joined and left, for the footer. */
  private readonly gone: Agent[] = []
  /** Agents asked for that never joined, with why. */
  private readonly unstarted = new Map<string, string>()
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
    if (this.lost !== undefined) return Promise.reject(new Error(this.lost))
    return new Promise((resolve, reject) => {
      const job: Job = { req, need: this.o.need(req.taskId), resolve, reject }
      req.signal?.addEventListener('abort', () => this.abort(job), { once: true })
      this.queue.push(job)
      this.pumpSoon()
    })
  }

  async close(): Promise<void> {
    this.ended = true
    this.endedAt = performance.now()
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
      job.held = {
        cores: Math.min(job.need.cores, a.cores),
        memory: Math.min(job.need.memory, a.memory),
      }
      a.usedCores += job.held.cores
      a.usedMemory += job.held.memory
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
    const bigger = (a: Agent): boolean =>
      job.need.above === undefined ||
      a.cores > job.need.above.cores ||
      a.memory > job.need.above.memory
    // A bigger agent online takes it; one starting is waited for; else
    // the biggest there is.
    const agents = [...this.agents.values()].filter((a) => !a.faulty)
    if (job.need.above !== undefined && !agents.some(bigger)) {
      const above = job.need.above
      const joined = new Set([...agents, ...this.gone].map((x) => x.label))
      for (const [id, { declared }] of this.spawnedAt)
        if (
          !joined.has(id) &&
          !this.unstarted.has(id) &&
          (declared.cpu > above.cores || declared.memory > above.memory)
        )
          return undefined
    }
    const pool = agents.some(bigger) ? agents.filter(bigger) : agents
    for (const a of pool) {
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
    this.runningHere.add(job.req.taskId)
    this.floor
      .execute(job.req)
      .then((r) => {
        this.ranHere++
        this.local.record(r)
        job.resolve(r)
      }, job.reject)
      .finally(() => {
        this.runningHere.delete(job.req.taskId)
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
          cores: job.held?.cores ?? 1,
          memory: job.held?.memory ?? 0,
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
            a.usage.messagesIn++
            a.usage.bytesIn += wireBytes(data)
          }
        }
        await this.o.me.send(a.id, {
          type: 'batch',
          root: this.o.root,
          realRoot: this.realRoot,
          tasks: orders.map((o) => o.order),
          ...(sandboxes === undefined ? {} : { sandboxes }),
        } satisfies ToAgent)
        a.usage.messagesIn++
        for (const { job } of orders) this.lease(job)
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

  /** Three heartbeats from now: the agent says what it holds each one. */
  private lease(job: Job): void {
    job.leaseUntil = performance.now() + 3 * this.o.me.heartbeatMs
  }

  /**
   * Agent `a` let `job` down: lost, its lease ended, or it could not run
   * it. One it had begun counts, and two agents fail it; one still in its
   * queue goes back free.
   */
  private retry(a: Agent, job: Job, why: string): Job | undefined {
    a.busy.delete(job.req.taskId)
    a.usedCores -= job.held?.cores ?? 0
    a.usedMemory -= job.held?.memory ?? 0
    delete job.agent
    delete job.held
    delete job.leaseUntil
    const begun = a.started.delete(job.req.taskId)
    if (job.req.signal?.aborted === true) return undefined
    if (begun) {
      a.faulty = true
      job.faults = [...(job.faults ?? []), `${a.label} ${why}`]
      if (job.faults.length >= 2) {
        job.reject(new Error(`${job.req.taskId}: failed on 2 agents: ${job.faults.join(', ')}`))
        return undefined
      }
    }
    return job
  }

  /** Each task whose agent's lease on it ended goes back. */
  private expire(): void {
    const now = performance.now()
    const back: Job[] = []
    for (const a of this.agents.values())
      for (const j of [...a.busy.values()])
        if (j.leaseUntil !== undefined && j.leaseUntil < now) {
          const again = this.retry(a, j, 'lease expired')
          if (again !== undefined) back.push(again)
        }
    if (back.length === 0) return
    this.queue.unshift(...back)
    this.pumpSoon()
  }

  private post(a: Agent, m: ToAgent): void {
    a.chain = a.chain.then(() => this.o.me.send(a.id, m)).catch(() => undefined)
  }

  private async finish(a: Agent, task: string, parts: string[]): Promise<void> {
    const job = a.busy.get(task)
    if (job === undefined) return
    const head = (await unpack(this.o.root, fromParts(parts))) as Wired
    a.busy.delete(task)
    a.started.delete(task)
    a.usedCores -= job.held?.cores ?? 0
    a.usedMemory -= job.held?.memory ?? 0
    a.ran++
    a.usage.record(head)
    if (head.stdout !== '') job.req.onStdout(head.stdout)
    if (head.stderr !== '') job.req.onStderr(head.stderr)
    job.resolve({
      ...result(head),
      where: a.label,
      machine: { cores: a.cores, memoryBytes: a.memory },
    })
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
      if (info.tree !== this.o.tree) {
        return refuse(`checked out tree ${info.tree}, the run is on ${this.o.tree}`)
      }
      // An agent this run started keeps the name it was started under;
      // one that joined on its own is numbered in the order it joined.
      const spawn = info.id === undefined ? undefined : this.spawnedAt.get(info.id)
      const asked = spawn?.at
      const taken = new Set([...this.agents.values(), ...this.gone].map((a) => a.label))
      let label = asked === undefined ? undefined : info.id
      while (label === undefined || taken.has(label)) label = `agent#${++this.joined}`
      this.agents.set(id, {
        id,
        warmUpMs: asked === undefined ? undefined : performance.now() - asked,
        declared: spawn?.declared,
        ran: 0,
        usage: new Usage(),
        cores: Number(info.cores),
        memory: Number(info.memory),
        usedCores: 0,
        usedMemory: 0,
        label,
        busy: new Map(),
        started: new Set(),
        has: new Set(),
        // Its name first, before any batch.
        chain: this.o.me
          .send(id, { type: 'welcome', name: label } satisfies ToAgent)
          .catch(() => undefined),
        sandboxes: false,
        faulty: false,
      })
    } else if (body.type === 'lost') {
      const a = this.agents.get(body.id!)
      if (a === undefined) return
      this.agents.delete(a.id)
      a.usage.to = performance.now()
      this.gone.push(a)
      // Its tasks run again: first, as they were first to go.
      const back: Job[] = []
      for (const j of [...a.busy.values()]) {
        const again = this.retry(a, j, 'lost')
        if (again !== undefined) back.push(again)
      }
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
        // Its tasks fail, not run here: this machine may be far smaller
        // than the agents. A rerun resumes from what finished and saved.
        this.fail(`the relay is unreachable (${(err as Error).message})`)
        return
      }
      this.expire()
      for (const { from, body } of messages) {
        if (from === 'relay') {
          this.onRelay(body as { type?: string })
          continue
        }
        const a = this.agents.get(from)
        if (a === undefined) continue
        const m = body as ToOrchestrator
        if (m.type === 'start') {
          if (a.busy.has(m.task)) a.started.add(m.task)
        } else if (m.type === 'held') {
          for (const t of [...m.running, ...m.queued]) {
            const j = a.busy.get(t)
            if (j?.leaseUntil !== undefined) this.lease(j)
          }
          for (const t of m.running) if (a.busy.has(t)) a.started.add(t)
        } else if (m.type === 'fault') {
          const j = a.busy.get(m.task)
          if (j === undefined) continue
          // It began it whether or not its `start` came first.
          a.started.add(m.task)
          if (this.retry(a, j, m.reason) !== undefined) this.queue.unshift(j)
          this.pumpSoon()
        } else if (m.type === 'part') {
          const list = this.results.get(`${from}\0${m.task}`) ?? []
          list.push(m.data)
          this.results.set(`${from}\0${m.task}`, list)
          a.usage.messagesOut++
          a.usage.bytesOut += wireBytes(m.data)
        } else if (m.type === 'end') {
          a.usage.messagesOut++
          const parts = this.results.get(`${from}\0${m.task}`) ?? []
          this.results.delete(`${from}\0${m.task}`)
          await this.finish(a, m.task, parts).catch((err: unknown) => {
            a.busy.get(m.task)?.reject(err)
            a.busy.delete(m.task)
            a.started.delete(m.task)
          })
        }
      }
    }
  }

  /**
   * The agent running a task, or `local`; `null` while it waits, here or
   * in an agent's queue, for a machine to begin it.
   */
  where(taskId: string): string | null | undefined {
    if (this.runningHere.has(taskId)) return 'local'
    for (const a of this.agents.values())
      if (a.busy.has(taskId)) return a.started.has(taskId) ? a.label : null
    return this.queue.some((j) => j.req.taskId === taskId) ? null : undefined
  }

  /** `demand` asked the adapter for agent `id` (`AgentSpawn.id`). */
  spawned(id: string, declared: Declared): void {
    this.spawnedAt.set(id, { at: performance.now(), declared })
  }

  /** Agent `id` will not join: its start failed or it exited first. */
  failed(id: string, reason: string): void {
    if (this.unstarted.has(id) || this.ended) return
    this.unstarted.set(id, reason)
    // Nothing online, none still starting, no share here: no task can run.
    const starting = [...this.spawnedAt.keys()].some(
      (s) => !this.unstarted.has(s) && ![...this.agents.values()].some((a) => a.label === s),
    )
    if (this.agents.size === 0 && !starting && this.o.localSlots === 0)
      this.fail(`no agent could start: ${id} ${reason}`)
  }

  /** Every task sent here and not done fails with `reason`; later ones too. */
  private fail(reason: string): void {
    for (const a of this.agents.values())
      for (const j of a.busy.values()) j.reject(new Error(reason))
    for (const j of this.queue.splice(0)) j.reject(new Error(reason))
    this.agents.clear()
    this.lost = reason
  }

  /** Each machine that joined, and this one when it ran tasks, with what it did: the run summary's `machines`. */
  machines(): MachineReport[] {
    const gone = new Set(this.gone)
    const report = (
      name: string,
      status: string,
      u: Usage,
      cores: number,
      memoryBytes: number,
    ): MachineReport => {
      const st = u.stats(cores, this.endedAt)
      return {
        name,
        status,
        cores,
        memoryBytes,
        done: u.done,
        failed: u.failed,
        onlineMs: st.onlineMs,
        busyMs: st.busyMs,
        cpuPeak: st.cpuPeak,
        cpuAvg: st.cpuAvg,
        memoryPeakBytes: st.memoryPeak,
        memoryAvgBytes: st.memoryAvg,
        utilization: st.utilization,
      }
    }
    const out = [...this.agents.values(), ...this.gone].map((a) =>
      report(a.label, gone.has(a) ? 'gone' : 'online', a.usage, a.cores, a.memory),
    )
    if (this.ranHere > 0)
      out.push(report('local', 'online', this.local, machineParallelism(), machineMemoryBytes()))
    return out
  }

  /**
   * The `agents` rows, live and at the end: one per agent by `size#index`
   * with its status, the tasks it has done and the ones it runs now, then
   * this machine's; once over, each one's cores and memory, each joined
   * agent's warm-up and each size whose machines are not what it says.
   */
  footer(): [string, ui.Inline][] {
    if (this.spawnedAt.size === 0 && this.agents.size === 0) return []
    const gone = new Set(this.gone)
    const all = [...this.agents.values(), ...this.gone]
    const joined = new Set(all.map((a) => a.label))
    const count = (u: Usage, running: number): string =>
      [
        `${u.done} done`,
        ...(u.failed > 0 ? [`${u.failed} failed`] : []),
        ...(running > 0 ? [`${running} running`] : []),
      ].join(' · ')
    // What its machine reports, once the run is over: green when its size
    // says the same, red when not.
    const res = (cores: number, memory: number, d?: Declared): ui.Inline => {
      if (!this.ended) return ''
      const text = `${cores}c/${compact(memory)}`
      if (d === undefined) return text
      return ui.tone(matches(cores, memory, d) ? 'ok' : 'error', text)
    }
    const lines: [string, string, string, ui.Inline][] = all.map((a) => [
      a.label,
      gone.has(a) ? 'gone' : 'online',
      count(a.usage, gone.has(a) ? 0 : a.started.size) +
        (this.ended && a.warmUpMs !== undefined ? ` · warm-up ${seconds(a.warmUpMs)}` : ''),
      res(a.cores, a.memory, a.declared),
    ])
    for (const id of this.spawnedAt.keys())
      if (!joined.has(id)) {
        const why = this.unstarted.get(id)
        lines.push(why === undefined ? [id, 'starting', '', ''] : [id, 'failed', why, ''])
      }
    lines.sort((x, y) => x[0].localeCompare(y[0], 'en', { numeric: true }))
    if (this.o.localSlots > 0 || this.ranHere > 0)
      lines.push([
        'local',
        'online',
        count(this.local, this.runningHere.size),
        res(machineParallelism(), machineMemoryBytes()),
      ])
    const width = Math.max(...lines.map(([l]) => l.length))
    const status = Math.max(...lines.map(([, st]) => st.length))
    // Once the run is over: each size whose machines are not what it says.
    const off = new Map<string, string>()
    for (const a of this.ended ? all : []) {
      const d = a.declared
      if (d === undefined || off.has(d.size)) continue
      if (matches(a.cores, a.memory, d)) continue
      off.set(
        d.size,
        `${d.size}: config ${d.cpu} cores ${gb(d.memory)}, reported ${a.cores} cores ${gb(a.memory)}`,
      )
    }
    // Once over, what each did, under its line.
    const usage = new Map<string, readonly string[]>()
    let cpuMs = 0
    let coreMs = 0
    const detail = (label: string, u: Usage, cores: number, relay: boolean): void => {
      const st = u.stats(cores, this.endedAt)
      cpuMs += st.cpuMs
      coreMs += cores * st.onlineMs
      usage.set(label, describe(st, u, relay))
    }
    if (this.ended) {
      for (const a of all) detail(a.label, a.usage, a.cores, true)
      if (lines.at(-1)?.[0] === 'local') detail('local', this.local, machineParallelism(), false)
    }
    const indent = ' '.repeat(width + 2)
    return [
      ...lines.flatMap(([l, st, t, r], i): [string, ui.Inline][] => [
        [
          i === 0 ? 'agents' : '',
          st === 'failed'
            ? [ui.place(l), `${' '.repeat(width - l.length)}  `, ui.tone('error', st), `  ${t}`]
            : t === ''
              ? [ui.place(l), `${' '.repeat(width - l.length)}  ${st}`]
              : [
                  ui.place(l),
                  `${' '.repeat(width - l.length)}  ${st.padEnd(status)}  ${t}`,
                  ...(r === '' ? [] : ['  ', r]),
                ],
        ],
        ...(usage.get(l) ?? []).map((d): [string, ui.Inline] => ['', ui.dim(`${indent}${d}`)]),
      ]),
      ...(coreMs > 0
        ? [
            ['', `${'total'.padEnd(width)}  cpu utilization ${percent(cpuMs / coreMs)}`] as [
              string,
              ui.Inline,
            ],
          ]
        : []),
      ...[...off.values()].map((t): [string, ui.Inline] => ['', `! ${t}`]),
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

/** A machine's run, spelled out: time, CPU, memory and, for an agent, the relay. */
function describe(st: UsageStats, u: Usage, relay: boolean): string[] {
  return [
    `online ${seconds(st.onlineMs)} · busy ${seconds(st.busyMs)} · idle ${seconds(Math.max(0, st.onlineMs - st.busyMs))}`,
    `cpu peak ${st.cpuPeak.toFixed(1)} · avg ${st.cpuAvg.toFixed(1)} cores · cpu utilization ${percent(st.utilization)}`,
    `memory peak ${bytes(st.memoryPeak)} · avg ${bytes(st.memoryAvg)}`,
    ...(relay
      ? [
          `sent ${plural(u.messagesIn, 'message')} · ${bytes(u.bytesIn)}, received ${plural(u.messagesOut, 'message')} · ${bytes(u.bytesOut)}`,
        ]
      : []),
  ]
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`
const percent = (n: number): string => `${Math.round(n * 100)}%`
const bytes = (n: number): string =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)} GB`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)} MB`
      : `${Math.round(n / 1e3)} KB`
/** A base64 part's bytes. */
const wireBytes = (data: string): number => Math.floor((data.length * 3) / 4)

/** A machine is what its size says: the same cores, memory within a tenth. */
const matches = (cores: number, memory: number, d: Declared): boolean =>
  cores === d.cpu && Math.abs(memory - d.memory) <= d.memory * 0.1

/** Bytes as whole gigabytes, one decimal under 10: `16G`, `0.5G`. */
const compact = (n: number): string => {
  const g = n / 1e9
  return `${g >= 10 ? Math.round(g) : Number(g.toFixed(1))}G`
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

const gb = (n: number): string => `${Math.round(n / 1e9)} GB`
