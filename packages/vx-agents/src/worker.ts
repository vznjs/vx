// A worker: a long-lived process that keeps a checkout, an install and a
// local vx cache, and runs one assigned task at a time.
//
// The value of a worker is its WARM STATE, which is why it outlives a run.
// Per lease it fetches the run's commit and reinstalls only when the lockfile
// moved; a task it ran last week may still be a LOCAL cache hit, a tier below
// the remote cache that an ephemeral container can never have.
//
// It runs a SCOPED `run()` of the assigned task, not a bare shell command.
// That is what makes the dependency story work without any transfer protocol
// of its own: vx's scheduler dispatches in topological order, so by the time
// an assignment arrives every dependency has already run somewhere and is in
// the remote cache — the scoped run restores them as cache hits and executes
// only the task it was given.

import { createEventBus, run, type RunEvent as VxRunEvent } from '@vzn/vx'
import { SyncClient } from './client.js'
import type { Assignment, WorkerCapabilities } from './protocol.js'

export interface WorkerOptions {
  readonly endpoint: string
  readonly authToken?: string
  /** Where the checkout lives. Created by cloning on the first assignment. */
  readonly workspace: string
  readonly name: string
  readonly capabilities: WorkerCapabilities
  /** Run after a checkout whose lockfile differs from the last one installed. */
  readonly install: string
  /** Drain and exit after this many assignments. */
  readonly maxAssignments?: number
  readonly log?: (message: string) => void
}

const HEARTBEAT_MS = 15_000

export class Worker {
  private readonly client: SyncClient
  private workerId = ''
  private commit: string | undefined
  private installedLock: string | undefined
  private served = 0
  private stopped = false

  constructor(private readonly opts: WorkerOptions) {
    this.client = new SyncClient({
      endpoint: opts.endpoint,
      ...(opts.authToken === undefined ? {} : { authToken: opts.authToken }),
    })
  }

  private say(message: string): void {
    ;(this.opts.log ?? ((m: string) => process.stderr.write(`${m}\n`)))(message)
  }

  /** Register, then serve assignments until told to stop or the count is up. */
  async start(): Promise<void> {
    const reg = await this.client.register({
      name: this.opts.name,
      capabilities: this.opts.capabilities,
      ...(this.commit === undefined ? {} : { commit: this.commit }),
    })
    this.workerId = reg.workerId
    this.say(`[vx-agent] ${this.opts.name} registered as ${reg.workerId}`)

    const beat = setInterval(() => {
      void this.client.heartbeat(this.workerId, this.commit).catch(() => undefined)
    }, HEARTBEAT_MS)

    try {
      while (!this.stopped) {
        if (this.opts.maxAssignments !== undefined && this.served >= this.opts.maxAssignments) {
          this.say(`[vx-agent] served ${this.served} assignments — draining`)
          return
        }
        const assignment = await this.client.claim(this.workerId).catch((err: unknown) => {
          this.say(`[vx-agent] claim failed: ${message(err)}`)
          return null
        })
        if (assignment === null) continue
        await this.serve(assignment)
      }
    } finally {
      clearInterval(beat)
    }
  }

  stop(): void {
    this.stopped = true
  }

  private async serve(assignment: Assignment): Promise<void> {
    this.served++
    const started = Date.now()
    try {
      await this.sync(assignment)
    } catch (err) {
      // A checkout that failed is not the task's failure, and reporting it as
      // one would send someone reading a red build into their own code. Say
      // what actually broke.
      await this.client.result(assignment.assignmentId, {
        exitCode: 1,
        durationMs: Date.now() - started,
        workerId: this.workerId,
        error: `worker could not prepare ${assignment.commit.slice(0, 8)}: ${message(err)}`,
      })
      return
    }

    const bus = createEventBus()
    bus.subscribe((event: VxRunEvent) => {
      if (event.kind === 'task:stdout') {
        void this.client.output(assignment.assignmentId, 'out', event.chunk).catch(() => undefined)
      } else if (event.kind === 'task:stderr') {
        void this.client.output(assignment.assignmentId, 'err', event.chunk).catch(() => undefined)
      }
    })

    let exitCode = 0
    let error: string | undefined
    try {
      const summary = await run({
        cwd: this.opts.workspace,
        projects: [assignment.project],
        tasks: [assignment.task],
        bus,
        handleSignals: false,
      })
      exitCode = summary.ok ? 0 : 1
    } catch (err) {
      exitCode = 1
      error = message(err)
    }

    await this.client.result(assignment.assignmentId, {
      exitCode,
      durationMs: Date.now() - started,
      workerId: this.workerId,
      ...(error === undefined ? {} : { error }),
    })
  }

  /**
   * Bring the checkout to the run's commit.
   *
   * `git fetch <remote> <sha>` rather than clone-then-checkout: on a pull
   * request the SHA is a merge commit that lives on no branch (GitHub exposes
   * it as `refs/pull/N/merge`), so a naive clone succeeds on every push and
   * fails on every PR — the worst way to discover this.
   */
  private async sync(assignment: Assignment): Promise<void> {
    if (this.commit === assignment.commit) return
    const dir = this.opts.workspace
    if (!(await Bun.file(`${dir}/.git/HEAD`).exists())) {
      await this.git(['init', '-q', dir], process.cwd())
    }
    await this.git(['fetch', '--depth', '1', assignment.remote, assignment.commit], dir)
    await this.git(['checkout', '-q', '--detach', 'FETCH_HEAD'], dir)
    // Untracked debris from a previous run would otherwise accumulate for the
    // life of the worker. node_modules is excluded because it IS the warm
    // state this design exists to keep.
    await this.git(['clean', '-qxdf', '-e', 'node_modules'], dir)
    this.commit = assignment.commit

    const lock = await lockDigest(dir)
    if (lock !== this.installedLock) {
      const res = Bun.spawn(['sh', '-c', this.opts.install], {
        cwd: dir,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const code = await res.exited
      if (code !== 0) {
        throw new Error(
          `install failed (exit ${code}): ${(await new Response(res.stderr).text()).trim()}`,
        )
      }
      this.installedLock = lock
    }
  }

  private async git(args: readonly string[], cwd: string): Promise<void> {
    const p = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited])
    if (code !== 0) throw new Error(`git ${args[0]} failed (exit ${code}): ${err.trim()}`)
  }
}

/**
 * What decides whether to reinstall. The lockfile is the honest signal — it is
 * what an install is a function of — and hashing it costs nothing next to the
 * install it may skip.
 */
export async function lockDigest(dir: string): Promise<string> {
  const file = Bun.file(`${dir}/bun.lock`)
  if (!(await file.exists())) return ''
  return Bun.hash(await file.arrayBuffer()).toString(16)
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
