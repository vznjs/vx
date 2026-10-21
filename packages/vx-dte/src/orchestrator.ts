// The orchestrator's half of a distributed run: the `vx run` the user
// started. It keeps a share of the tasks for this machine, hands the rest
// to the agents online, critical path first (the order core asks in), and
// writes each agent's result back here before the task ends, so the run
// saves and reports it as its own.

import path from 'node:path'
import {
  executorFallback,
  withForwardArgs,
  type ExecuteRequest,
  type ExecuteResult,
  type TaskNode,
} from '@vzn/vx'
import { fromParts, outputFiles, pack, toParts, unpack } from './bundle.js'
import type { AgentInfo, ToAgent, ToOrchestrator } from './messages.js'
import { runCommand, type CommandResult } from './run-command.js'
import { RelayError, type Participant } from './wire.js'

interface Job {
  readonly req: ExecuteRequest
  readonly resolve: (r: ExecuteResult) => void
  readonly reject: (err: unknown) => void
  agent?: string
}

interface Agent {
  readonly id: string
  readonly size: string
  readonly slots: number
  readonly label: string
  readonly busy: Map<string, Job>
  /** Tasks whose outputs it holds: it ran them, or was sent them. */
  readonly has: Set<string>
  /** Sends to it go out in order: a run's parts before the run. */
  chain: Promise<void>
}

export interface OrchestratorOptions {
  readonly me: Participant
  readonly root: string
  readonly commit: string
  /** Tasks this machine runs at once besides the agents. */
  readonly localSlots: number
  readonly nodes: () => ReadonlyMap<string, TaskNode> | undefined
}

export class Orchestrator {
  private readonly agents = new Map<string, Agent>()
  private readonly queue: Job[] = []
  private readonly results = new Map<string, string[]>()
  private localBusy = 0
  private joined = 0
  private readonly stop = new AbortController()
  private readonly loop: Promise<void>

  constructor(private readonly o: OrchestratorOptions) {
    this.loop = this.listen()
  }

  execute(req: ExecuteRequest): Promise<ExecuteResult> {
    if (this.lost !== undefined) return Promise.reject(executorFallback(this.lost))
    return new Promise((resolve, reject) => {
      const job: Job = { req, resolve, reject }
      req.signal?.addEventListener('abort', () => this.abort(job), { once: true })
      this.queue.push(job)
      this.pump()
    })
  }

  async close(): Promise<void> {
    this.stop.abort()
    await this.loop
    await this.o.me.leave()
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

  private pump(): void {
    while (this.queue.length > 0) {
      if (this.localBusy < this.o.localSlots) {
        this.runHere(this.queue.shift()!)
        continue
      }
      let best: Agent | undefined
      for (const a of this.agents.values()) {
        if (
          a.busy.size < a.slots &&
          (best === undefined || a.slots - a.busy.size > best.slots - best.busy.size)
        )
          best = a
      }
      if (best === undefined) return
      this.send(best, this.queue.shift()!)
    }
  }

  private runHere(job: Job): void {
    this.localBusy++
    const { req } = job
    runCommand({
      command: withForwardArgs(req.command, req.forwardArgs),
      cwd: req.cwd,
      env: req.env,
      signal: req.signal,
      onStdout: req.onStdout,
      onStderr: req.onStderr,
      ...(req.onSpawn === undefined ? {} : { onSpawn: req.onSpawn }),
    })
      .then((r) => job.resolve(result(r)), job.reject)
      .finally(() => {
        this.localBusy--
        this.pump()
      })
  }

  private send(a: Agent, job: Job): void {
    const { req } = job
    job.agent = a.id
    a.busy.set(req.taskId, job)
    const nodes = this.o.nodes()
    const node = nodes?.get(req.taskId)
    const project = node === undefined ? '' : path.relative(this.o.root, node.projectDir)
    const ship = [...upstream(nodes, req.taskId)].filter((id) => !a.has.has(id))
    for (const id of ship) a.has.add(id)
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.env)) if (v !== undefined) env[k] = v
    a.chain = a.chain
      .then(async () => {
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
        const parts = files.length === 0 ? [] : toParts(await pack(this.o.root, files, null))
        for (const data of parts)
          await this.o.me.send(a.id, { type: 'part', task: req.taskId, data })
        await this.o.me.send(a.id, {
          type: 'run',
          task: req.taskId,
          root: this.o.root,
          command: withForwardArgs(req.command, req.forwardArgs),
          cwd: path.relative(this.o.root, req.cwd),
          project,
          env,
          ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
          outputs: {
            files: [...req.outputs.files],
            workspaceFiles: [...req.outputs.workspaceFiles],
          },
        } satisfies ToAgent)
      })
      .catch((err: unknown) => {
        // The relay refused the send (the agent is gone): the loss notice
        // puts the task back.
        if (!(err instanceof RelayError && err.status === 404)) job.reject(err)
      })
  }

  private post(a: Agent, m: ToAgent): void {
    a.chain = a.chain.then(() => this.o.me.send(a.id, m)).catch(() => undefined)
  }

  private async finish(a: Agent, task: string, parts: string[]): Promise<void> {
    const job = a.busy.get(task)
    if (job === undefined) return
    const head = (await unpack(this.o.root, fromParts(parts))) as CommandResult
    a.busy.delete(task)
    a.has.add(task)
    if (head.stdout !== '') job.req.onStdout(head.stdout)
    if (head.stderr !== '') job.req.onStderr(head.stderr)
    job.resolve({ ...result(head), where: a.label })
    this.pump()
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
      if (info?.v !== 1 || typeof info.size !== 'string' || !(Number(info.slots) >= 1)) {
        return refuse('speaks another vx-dte protocol')
      }
      if (info.commit !== this.o.commit) {
        return refuse(`checked out ${info.commit}, the run is on ${this.o.commit}`)
      }
      this.agents.set(id, {
        id,
        size: info.size,
        slots: Math.floor(Number(info.slots)),
        label: `${info.size} agent ${++this.joined}`,
        busy: new Map(),
        has: new Set(),
        chain: Promise.resolve(),
      })
    } else if (body.type === 'lost') {
      const a = this.agents.get(body.id!)
      if (a === undefined) return
      this.agents.delete(a.id)
      // Its tasks run again: first, as they were first to go.
      const back = [...a.busy.values()].filter((j) => j.req.signal?.aborted !== true)
      for (const j of back) delete j.agent
      this.queue.unshift(...back)
    } else {
      return
    }
    this.pump()
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

  /** Why the relay was given up on; then every task runs here. */
  lost: string | undefined
}

function result(r: CommandResult): ExecuteResult {
  return { ...r, violations: [], outputs: { kind: 'disk' } }
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
