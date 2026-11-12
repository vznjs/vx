// The request one attempt hands its executor.

import type { ExecuteRequest } from '../exec/index.js'
import { dependencyReads, sandboxRequestFor } from '../sandbox/index.js'
import type { MissRun } from './miss-run.js'
import { serverSpec } from './task-process.js'

export async function buildRequest(m: MissRun, local: boolean): Promise<ExecuteRequest> {
  const { args, policy, stream, secrets } = m
  const { node } = args
  const exec = policy.exec
  // A remote executor enforces it where it runs the task. Armed before the
  // streams' mask: its start holds the proxy's token, which the task's env
  // carries (`initSandbox`).
  if (policy.sandboxed && args.executor.remote !== true) {
    await args.armSandbox?.()
    secrets.refresh()
  }
  const { onStdout, onStderr } = stream.open(
    policy.save || args.keepRun !== undefined,
    secrets.mask,
  )
  // A plugin executor gets frozen copies of what core goes on reading: the
  // outputs it saves, the config two tasks declared alike share, the run's
  // args. One that emptied its outputs saved an empty artifact a later hit
  // restored; one that set its define ran the next task with it.
  const own = <T extends object>(v: T): T =>
    local ? v : Object.freeze(Array.isArray(v) ? ([...v] as T) : { ...v })
  const base: ExecuteRequest = {
    taskId: node.id,
    ...(m.attempt > 1 ? { attempt: m.attempt } : {}),
    workspaceRoot: args.workspaceRoot,
    command: exec.command,
    forwardArgs: own(policy.forwardArgs),
    cwd: node.projectDir,
    env: m.env,
    envDefine: own(exec.env?.define ?? {}),
    // The executor retains nothing: the entry's output is the attempt's
    // stream capture. Both streams are still drained and streamed.
    capture: { stdout: false, stderr: false },
    onStdout,
    onStderr,
    ...(args.liveChildren !== undefined ? { liveChildren: args.liveChildren } : {}),
    ...(args.track !== undefined
      ? {
          onSpawn: (pid: number) => {
            m.load.untrack?.()
            m.load.untrack = args.track!(node.id, pid)
          },
        }
      : {}),
    ...(policy.timeout !== undefined ? { timeoutMs: policy.timeout } : {}),
    ...(m.inputs.inputs !== undefined ? { inputs: m.inputs.inputs } : {}),
    ...(policy.cacheable ? { cacheKey: m.hash } : {}),
    ...(policy.unsaved ? { unsaved: true } : {}),
    ...(policy.remoteOnly ? { remoteOnly: true } : {}),
    ...(node.platform !== undefined ? { platform: node.platform } : {}),
    ...(node.worker !== undefined ? { worker: node.worker } : {}),
    ...(policy.deferred ? { download: 'deferred' as const } : {}),
    // `--force`/`--no-cache` reach a remote executor's private record
    // through this flag: the policy gates only cover vx's OWN cache.
    ...(policy.refresh ? { refresh: true } : {}),
    outputs: { files: own(policy.outputs), workspaceFiles: own(policy.wsOutputs) },
    ...(args.terminal === true ? { terminal: true as const } : {}),
    ...(args.servers === undefined
      ? {}
      : {
          servers: args.servers.map((s, i) =>
            serverSpec(s, args.workspaceRoot, args.serversNested?.[i] ?? []),
          ),
        }),
  }
  // The signal last: it arms a plugin's `exec.timeout`, and the sandbox's
  // arming above is vx's work, not the task's. Armed first, a 60 ms timeout
  // expired before the spawn and failed `echo` as timed out, unrun.
  if (!policy.sandboxed) return { ...base, signal: m.signal.request(local) }
  const deps = await dependencyReads(args.readableDeps?.(node) ?? [], args.workspaceRoot)
  const sb = await sandboxRequestFor(
    node,
    exec.sandbox!,
    args.workspaceRoot,
    policy.cacheable ? args.keyedProjects(node) : undefined,
    args.nestedProjectDirs,
    args.cacheDir,
    deps.reads,
    deps.reported,
    args.nestedDirsOf,
  )
  m.sandbox.placeholders = sb.placeholders
  m.sandbox.withheld = sb.withheld
  m.sandbox.upstreamOutputs = [...deps.reads, ...deps.reported]
  const c = sb.sandbox.config
  m.sandbox.writes = local
    ? [
        ...c.allowWrite,
        ...(c.pendingWrites ?? []),
        ...(c.linkedWrites ?? []).flatMap((l) => [l.link, l.target]),
      ]
    : undefined
  return { ...base, sandbox: sb.sandbox, signal: m.signal.request(local) }
}
