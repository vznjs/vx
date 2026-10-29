// Core's local floor for a plugin that runs tasks itself: `@vzn/vx-dte`'s
// workers, which run tasks another machine placed. A run arms the sandbox
// runtime before it builds a sandboxed request; a worker is no run, so it
// arms here. It starts a request's servers (`ExecuteRequest.servers`) once
// each, before the task, each inside its own sandbox, and stops them when
// it closes.

import type { ExecConfig } from '../config.js'
import {
  localExecutor,
  PersistentReadyError,
  releaseBridges,
  resetSandbox,
  runPersistent,
  signalExitCode,
  type ExecuteRequest,
  type ExecuteResult,
  type ServerSpec,
  wrapSandboxedCommand,
} from '../exec/index.js'
import { placeholderSweeper, prepareSandbox, sandboxRequestFor } from './sandbox-request.js'
import { forwardedSignal, terminateChildren } from './signals.js'

/** How much of a server's output before ready a failure to start quotes. */
const HEARD_BYTES = 8192

export interface LocalFloor {
  execute(req: ExecuteRequest): Promise<ExecuteResult>
  /** Arms the sandbox runtime for `sandboxes` from the next sandboxed task on; its servers keep running. */
  rearm(sandboxes: readonly NonNullable<ExecConfig['sandbox']>[]): Promise<void>
  /** Stops the servers this started and the sandbox runtime this armed. */
  close(): Promise<void>
}

/**
 * `sandboxes`, in a process that is no run, are the `exec.sandbox` configs
 * of every sandboxed task the run holds: the runtime's proxy and its
 * unix-socket filter are one per process, set from their union before the
 * first sandboxed task (`prepareSandbox`). A request that carries a
 * `signal` but no `liveChildren` has its children stopped here when it
 * aborts, the way a run's stop ends its own.
 */
export function localFloor(
  sandboxes: readonly NonNullable<ExecConfig['sandbox']>[] = [],
): LocalFloor {
  const local = localExecutor()
  const prepare = (list: typeof sandboxes) =>
    prepareSandbox(list.map((sandbox) => ({ config: { exec: { sandbox } } })))
  let armer = prepare(sandboxes)
  // Each server, by task id: shared by every task here that depends on it.
  const servers = new Map<string, Promise<ReturnType<typeof Bun.spawn>>>()
  const children: ReturnType<typeof Bun.spawn>[] = []
  // A sandboxed one starts inside its sandbox, built here as a one-shot
  // task's; its port bridges and untouched placeholders go when it exits.
  const start = async (spec: ServerSpec, root: string): Promise<ReturnType<typeof Bun.spawn>> => {
    let command = spec.command
    let signalChannel = false
    let gone = async (): Promise<unknown> => undefined
    if (spec.sandbox !== undefined) {
      await armer?.arm()
      const sb = await sandboxRequestFor(
        { projectDir: spec.cwd },
        spec.sandbox.config,
        root,
        undefined,
        spec.sandbox.nested,
      )
      const swept = placeholderSweeper(sb.placeholders)
      const wrapped = await wrapSandboxedCommand({
        command,
        cwd: spec.cwd,
        env: spec.env,
        ...sb.sandbox,
        server: true,
      }).catch(async (err: unknown) => {
        await swept()
        throw err
      })
      command = wrapped.wrapped
      signalChannel = wrapped.forwardsSignals
      gone = async () => {
        if (wrapped.tag !== undefined) releaseBridges(wrapped.tag)
        return swept()
      }
    }
    // Its output until ready, the tail kept: a server that dies first says
    // why (`docker run` exiting 125 said nothing on CI, 2026-10-26).
    let heard: string | undefined = ''
    const hear = (t: string): void => {
      if (heard !== undefined) heard = (heard + t).slice(-HEARD_BYTES)
    }
    const spawn = runPersistent({
      command,
      cwd: spec.cwd,
      env: spec.env,
      onStdout: hear,
      onStderr: hear,
      ...(spec.readyWhen === undefined ? {} : { readyWhen: spec.readyWhen }),
      ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
      ...(signalChannel ? { signalChannel } : {}),
    })
    // A spawn that threw hands back no child, only a rejected `ready`.
    if (spawn.child === undefined) void gone()
    else {
      children.push(spawn.child)
      void spawn.child.exited.then(gone, gone)
    }
    try {
      await spawn.ready
    } catch (err) {
      // A shell that exited before ready can leave its group running
      // (`server & …; exit`), holding the port of the one the next task starts.
      if (err instanceof PersistentReadyError && err.reason === 'exited')
        await terminateChildren(() => [spawn.child])
      const why = err instanceof Error ? err.message : String(err)
      const said = (heard ?? '').trimEnd()
      throw new Error(said === '' ? why : `${why}; its output:\n${said}`)
    }
    heard = undefined
    return spawn.child
  }
  const serve = (spec: ServerSpec, root: string): Promise<ReturnType<typeof Bun.spawn>> => {
    let up = servers.get(spec.taskId)
    if (up === undefined) {
      up = start(spec, root)
      servers.set(spec.taskId, up)
      // One that never became ready is asked again by the next task.
      up.catch(() => servers.delete(spec.taskId))
    }
    return up
  }
  return {
    async execute(req) {
      // A stop while a server is not yet ready ends the wait: one that never
      // prints its `readyWhen` line held the task, and a worker's shutdown
      // waits on its tasks before `close()` stops the servers. The aborted
      // request then reads as one stopped before its spawn.
      const signal = req.signal
      const stopped =
        signal === undefined
          ? undefined
          : new Promise<void>((resolve) => {
              if (signal.aborted) resolve()
              else signal.addEventListener('abort', () => resolve(), { once: true })
            })
      for (const spec of req.servers ?? []) {
        if (signal?.aborted === true) break
        try {
          const up = serve(spec, req.workspaceRoot)
          const child = await (stopped === undefined ? up : Promise.race([up, stopped]))
          // One that crashed after it was ready serves nobody: the task ran
          // against nothing and failed on its own "connection refused". A
          // clean exit is a setup step that did its work (runPersistent).
          const died = child === undefined ? null : (child.exitCode ?? child.signalCode)
          if (died !== null && died !== 0) {
            const code = typeof died === 'number' ? died : signalExitCode(died)
            const text = `${spec.taskId}, which ${req.taskId} depends on, exited with code ${code} after it was ready\n`
            req.onStderr(text)
            return { exitCode: 1, durationMs: 0, stdout: '', stderr: text, violations: [] }
          }
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err)
          const text = `${spec.taskId}, which ${req.taskId} depends on, did not start: ${why}\n`
          // Through `onStderr` too, as a spawn failure's text goes: a worker
          // ships only what its callbacks heard, and a dependant failed
          // "exit 1, 0ms" with no word of why (CI, 2026-10-25).
          req.onStderr(text)
          return { exitCode: 1, durationMs: 0, stdout: '', stderr: text, violations: [] }
        }
      }
      if (req.sandbox !== undefined) await armer?.arm()
      const stop = req.signal
      if (stop === undefined || req.liveChildren !== undefined) return local.execute(req)
      // No run holds this task's children (a worker's): its stop is ours to carry out.
      const live = new Set<ReturnType<typeof Bun.spawn>>()
      const end = (): void => void terminateChildren(() => [...live], forwardedSignal(stop.reason))
      stop.addEventListener('abort', end, { once: true })
      try {
        return await local.execute({ ...req, liveChildren: live })
      } finally {
        stop.removeEventListener('abort', end)
      }
    },
    async rearm(list) {
      if (armer?.armed === true) await resetSandbox()
      armer = prepare(list)
    },
    async close() {
      if (children.length > 0) await terminateChildren(() => children)
      if (armer?.armed === true) await resetSandbox()
    },
  }
}
