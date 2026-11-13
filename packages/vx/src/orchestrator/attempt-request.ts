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
  if (policy.sandboxed && args.executor.capabilities?.remote !== true) {
    await args.run.armSandbox?.()
    secrets.refresh()
  }
  const { onStdout, onStderr } = stream.open(
    policy.save || args.run.keepRun !== undefined,
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
    workspaceRoot: args.run.workspaceRoot,
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
    ...(args.run.liveChildren !== undefined ? { liveChildren: args.run.liveChildren } : {}),
    ...(args.run.track !== undefined
      ? {
          onSpawn: (pid: number) => {
            m.load.untrack?.()
            m.load.untrack = args.run.track!(node.id, pid)
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
    ...(args.download === 'trailing' && !local ? { download: 'trailing' as const } : {}),
    // `--force`/`--no-cache` reach a remote executor's private record
    // through this flag: the policy gates only cover vx's OWN cache.
    ...(policy.refresh ? { refresh: true } : {}),
    outputs: { files: own(policy.outputs), workspaceFiles: own(policy.wsOutputs) },
    ...(args.terminal === true ? { terminal: true as const } : {}),
    ...(args.servers === undefined
      ? {}
      : {
          servers: args.servers.map((s, i) =>
            serverSpec(s, args.run.workspaceRoot, args.serversNested?.[i] ?? []),
          ),
        }),
  }
  // The signal last: it arms a plugin's `exec.timeout`, and the sandbox's
  // arming above is vx's work, not the task's. Armed first, a 60 ms timeout
  // expired before the spawn and failed `echo` as timed out, unrun.
  if (!policy.sandboxed) return { ...base, signal: m.signal.request(local) }
  // An executor that lists them where the task runs is handed the
  // dependencies, not their files: walked here, a dependant waited for each
  // upstream's files to come to this machine before it could be sent.
  const there = !local && args.executor.capabilities?.dependencyOutputs === true
  const readable = args.run.readableDeps?.(node) ?? []
  const deps = there
    ? { reads: [], reported: [] }
    : await dependencyReads(readable, args.run.workspaceRoot)
  const sb = await sandboxRequestFor(
    node,
    exec.sandbox!,
    args.run.workspaceRoot,
    policy.cacheable ? args.run.keyedProjects(node) : undefined,
    args.nestedProjectDirs,
    args.run.cacheDir,
    deps.reads,
    deps.reported,
    args.run.nestedDirsOf,
  )
  m.sandbox.placeholders = sb.placeholders
  m.sandbox.withheld = sb.withheld
  m.sandbox.upstreamOutputs = [...deps.reads, ...deps.reported]
  m.sandbox.listedThere = there
  const c = sb.sandbox.config
  m.sandbox.writes = local
    ? [
        ...c.allowWrite,
        ...(c.pendingWrites ?? []),
        ...(c.linkedWrites ?? []).flatMap((l) => [l.link, l.target]),
      ]
    : undefined
  const sandbox = there
    ? {
        ...sb.sandbox,
        readableDeps: readable.flatMap((d) =>
          d.config.outputs === undefined
            ? []
            : [
                {
                  taskId: d.id,
                  projectDir: d.projectDir,
                  outputs: {
                    files: [...d.config.outputs.files],
                    workspaceFiles: [...(d.config.outputs.workspaceFiles ?? [])],
                  },
                },
              ],
        ),
      }
    : sb.sandbox
  return { ...base, sandbox, signal: m.signal.request(local) }
}

/**
 * The dependencies' outputs as this machine lists them, for a task whose
 * executor listed them where it ran (`dependencyOutputs`): read only once
 * that run refused something, to say which refusals were upstream's.
 */
export async function upstreamOutputsHere(m: MissRun): Promise<string[]> {
  const { args } = m
  try {
    const deps = await dependencyReads(
      args.run.readableDeps?.(args.node) ?? [],
      args.run.workspaceRoot,
    )
    return [...deps.reads, ...deps.reported]
  } catch {
    // quiet: more binds than a command line holds, which the run already said where it ran
    return []
  }
}
