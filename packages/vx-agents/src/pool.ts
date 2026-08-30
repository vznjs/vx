// The agent pool: N long-lived workers, each prepared ONCE, then handed one
// task at a time.
//
// This is the Nx-DTE shape rather than the REAPI one. REAPI is per-ACTION and
// hermetic: every action declares a complete input tree, the server
// materialises it, runs, and returns outputs. That is the right model when an
// action's inputs are a handful of files, and the wrong one here — this
// workspace's `node_modules` is 26 084 files, so every action paid to
// materialise all of it before its command started. An agent is prepared once
// and reused, so that cost is amortised over every task it runs.
//
// What that buys, and what it costs, stated plainly: there is no input tree to
// build, no upload, and no output download, because the agent already has the
// workspace. In exchange a task can read files it never declared, so the
// declared-input set is no longer PROVEN by execution the way a remote action
// proves it. vx still hashes inputs locally, so caching is unaffected.
//
// Deliberately transport-agnostic: this module owns leasing and readiness and
// knows nothing about containers, so its behaviour is testable without one.

/** One agent, however it is actually realised. */
export interface Agent {
  readonly id: string
  /** Run a command on this agent. Resolves with the process result. */
  exec(spec: AgentCommand): Promise<AgentResult>
  /** Release whatever backs this agent. Called once, at teardown. */
  dispose(): Promise<void>
}

export interface AgentCommand {
  /** Shell command, exactly as vx would run it locally. */
  readonly command: string
  /** Workspace-relative directory to run in. */
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly onStdout: (chunk: string) => void
  readonly onStderr: (chunk: string) => void
  readonly signal?: AbortSignal
}

export interface AgentResult {
  readonly exitCode: number
}

/** Creates an agent. Called at most `size` times, lazily. */
export type AgentFactory = (index: number) => Promise<Agent>

export interface PoolOptions {
  readonly size: number
  readonly create: AgentFactory
  /**
   * Run once per agent before it takes any task — the install, the toolchain
   * check, whatever the workspace needs. A non-zero exit makes the agent
   * unusable, and that is FATAL rather than degraded: an agent that silently
   * skipped its install would run every task against a half-built tree and
   * report the failures as the tasks' own.
   */
  readonly prepare?: string
  /**
   * Whether `prepare` belongs to each AGENT or to the pool as a whole.
   *
   * `'agent'` suits agents with their own checkout — each prepares itself.
   * `'pool'` is right when they SHARE a workspace (the docker transport bind-
   * mounts one), because then the install is a property of the workspace and
   * running it N times is not merely wasteful: eight concurrent `bun ci`
   * processes writing one `node_modules` fight, and the loser reports
   * `EEXIST: failed to symlink dependencies`. Agents that did not run it still
   * WAIT for it, or they would take tasks against a half-built tree.
   */
  readonly prepareScope?: 'agent' | 'pool'
  readonly warn?: (message: string) => void
}

/**
 * A lease on one agent. `release()` returns it to the pool; failing to call it
 * strands the agent, so every path that acquires must release in a `finally`.
 */
interface Lease {
  readonly agent: Agent
  release(): void
}

export class AgentPool {
  private readonly agents: Agent[] = []
  private readonly idle: Agent[] = []
  private readonly waiting: Array<(lease: Lease) => void> = []
  /** Agents created so far; never exceeds `size`. */
  private created = 0
  private disposed = false
  /** Set once when `prepareScope` is 'pool'; every agent awaits this one. */
  private sharedPrepare: Promise<void> | undefined

  constructor(private readonly opts: PoolOptions) {
    if (!Number.isInteger(opts.size) || opts.size < 1) {
      throw new Error(`@vzn/vx-agents: size must be a positive integer (got ${opts.size})`)
    }
  }

  /**
   * Take an agent, creating one lazily if the pool has not reached `size`.
   * Waits when every agent is busy — the scheduler already limits how many
   * tasks it dispatches here (executor `capacity`), so this is a backstop
   * rather than the primary throttle.
   */
  async acquire(): Promise<Lease> {
    if (this.disposed) throw new Error('@vzn/vx-agents: the pool has been torn down')
    const ready = this.idle.pop()
    if (ready !== undefined) return this.lease(ready)
    if (this.created < this.opts.size) {
      // Reserve the slot BEFORE the await: two concurrent acquires would
      // otherwise both see room and create one agent too many.
      const index = this.created++
      try {
        const agent = await this.opts.create(index)
        this.agents.push(agent)
        await this.prepare(agent)
        return this.lease(agent)
      } catch (err) {
        // The slot is given back so a later task can retry; a permanently
        // broken environment fails every task with the same message rather
        // than silently shrinking the pool to zero.
        this.created--
        throw err
      }
    }
    return await new Promise<Lease>((resolve) => this.waiting.push(resolve))
  }

  private lease(agent: Agent): Lease {
    let released = false
    return {
      agent,
      release: () => {
        if (released) return
        released = true
        const next = this.waiting.shift()
        if (next !== undefined) next(this.lease(agent))
        else this.idle.push(agent)
      },
    }
  }

  private async prepare(agent: Agent): Promise<void> {
    const command = this.opts.prepare
    if (command === undefined || command === '') return
    if (this.opts.prepareScope === 'pool') {
      // First agent in runs it; the rest await the same promise. A rejection
      // is shared too, so a broken install fails every task with one message
      // instead of N different ones.
      this.sharedPrepare ??= this.runPrepare(agent, command)
      await this.sharedPrepare
      return
    }
    await this.runPrepare(agent, command)
  }

  private async runPrepare(agent: Agent, command: string): Promise<void> {
    let stderr = ''
    const res = await agent.exec({
      command,
      cwd: '.',
      env: {},
      onStdout: () => undefined,
      onStderr: (c) => {
        stderr += c
      },
    })
    if (res.exitCode !== 0) {
      throw new Error(
        `@vzn/vx-agents: agent ${agent.id} failed to prepare (exit ${res.exitCode})` +
          `${stderr === '' ? '' : `: ${stderr.trim().split('\n').slice(-3).join(' / ')}`}`,
      )
    }
  }

  /** Dispose every agent. Safe to call twice; errors are reported, not thrown —
   *  teardown must not turn a green run red. */
  async close(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const all = [...this.agents]
    this.agents.length = 0
    this.idle.length = 0
    await Promise.all(
      all.map((a) =>
        a.dispose().catch((err: unknown) => {
          this.opts.warn?.(
            `@vzn/vx-agents: agent ${a.id} did not shut down cleanly: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }),
      ),
    )
  }
}
