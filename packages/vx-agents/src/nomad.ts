// A Nomad-backed agent: one long-lived allocation per agent, driven by
// `nomad alloc exec`.
//
// Shaped as ONE job with `count` allocations rather than a job per task, and
// that is the whole point. Nomad's natural unit is a job you submit and it
// runs to completion — dispatching one per vx task would pay container start
// every time, measured at ~400 ms against ~30 ms for exec'ing into something
// already running. A long-lived allocation gives the resource spec you asked
// for AND the warm number.
//
// The CLI rather than the HTTP API, for the same reasons as the docker
// transport: no client to version, no auth plumbing to invent, and the
// failure modes are the ones an operator already reads in `nomad status`.
//
// WORKSPACE: agents run the command against a shared filesystem, so the job
// mounts `volumeSource` at `containerWorkspace`. On a single-node cluster
// that is a host path; across real nodes it has to be a network volume that
// every client can see. vx does not paper over this — a task whose files are
// not there fails on the first command, loudly.

import type { Agent, AgentCommand, AgentResult } from './pool.js'
import { joinPosix } from './docker.js'

export interface NomadAgentOptions {
  readonly image: string
  readonly containerWorkspace: string
  /** Host path (or registered volume) holding the workspace every agent sees. */
  readonly volumeSource: string
  /** MHz, as Nomad counts CPU. */
  readonly cpu: number
  /** MiB. */
  readonly memoryMb: number
  readonly count: number
  readonly jobId: string
  readonly env: Readonly<Record<string, string>>
  readonly namespace?: string
}

export class NomadError extends Error {}

/**
 * The job Nomad is asked to run: `count` allocations that stay alive, each
 * carrying the resource reservation. Built as a pure function so the spec can
 * be asserted without a cluster — the shape of this JSON is the contract with
 * Nomad, and a silent typo in it fails at submit time with a message about a
 * field rather than about the build.
 */
export function nomadJobSpec(opts: NomadAgentOptions): unknown {
  return {
    Job: {
      ID: opts.jobId,
      Name: opts.jobId,
      Type: 'service',
      ...(opts.namespace === undefined ? {} : { Namespace: opts.namespace }),
      Datacenters: ['*'],
      TaskGroups: [
        {
          Name: 'agents',
          Count: opts.count,
          // A vx task failing must not make Nomad reschedule the agent out
          // from under the next one; the agent is the container, not the work.
          RestartPolicy: { Attempts: 0, Mode: 'fail' },
          ReschedulePolicy: { Attempts: 0, Unlimited: false },
          Tasks: [
            {
              Name: 'agent',
              Driver: 'docker',
              Config: {
                image: opts.image,
                // Overridden, not appended to: a toolchain image usually has
                // its own entrypoint, and the keep-alive would become an
                // argument to it.
                entrypoint: ['sh'],
                args: ['-c', 'sleep infinity'],
                work_dir: opts.containerWorkspace,
                volumes: [`${opts.volumeSource}:${opts.containerWorkspace}`],
              },
              Env: { ...opts.env },
              Resources: { CPU: opts.cpu, MemoryMB: opts.memoryMb },
            },
          ],
        },
      ],
    },
  }
}

async function nomad(
  args: readonly string[],
  stdin?: string,
): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(['nomad', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    ...(stdin === undefined ? {} : { stdin: new TextEncoder().encode(stdin) }),
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { code, out, err }
}

/** Allocation ids for a job that are actually running, in a stable order. */
export function runningAllocIds(allocsJson: string): string[] {
  const parsed = JSON.parse(allocsJson) as Array<{ ID?: string; ClientStatus?: string }>
  return parsed
    .filter((a) => a.ClientStatus === 'running' && typeof a.ID === 'string')
    .map((a) => a.ID!)
    .sort()
}

/**
 * Submit the job once, then hand out one allocation per agent.
 *
 * The job is submitted by the FIRST agent and reused by the rest — Nomad owns
 * the count, so asking it for N allocations once is both cheaper and less
 * racy than N agents each trying to scale a job by one.
 */
export function nomadAgentFactory(
  opts: NomadAgentOptions,
  warn: (m: string) => void,
): (index: number) => Promise<Agent> {
  let submitted: Promise<string[]> | undefined
  const ns = opts.namespace === undefined ? [] : ['-namespace', opts.namespace]

  const submit = async (): Promise<string[]> => {
    const run = await nomad(
      ['job', 'run', '-detach', '-json', ...ns, '-'],
      JSON.stringify(nomadJobSpec(opts)),
    )
    if (run.code !== 0) {
      throw new NomadError(
        `@vzn/vx-agents: nomad job run failed: ${run.err.trim() || run.out.trim()}`,
      )
    }
    // Allocations are placed asynchronously; poll until the job has the count
    // it was asked for rather than racing the scheduler.
    const deadline = Date.now() + 120_000
    for (;;) {
      const allocs = await nomad(['job', 'allocs', '-json', ...ns, opts.jobId])
      if (allocs.code === 0) {
        const ids = runningAllocIds(allocs.out)
        if (ids.length >= opts.count) return ids
      }
      if (Date.now() > deadline) {
        throw new NomadError(
          `@vzn/vx-agents: nomad placed fewer than ${opts.count} agents within 120s — check \`nomad status ${opts.jobId}\``,
        )
      }
      await Bun.sleep(500)
    }
  }

  return async (index: number): Promise<Agent> => {
    submitted ??= submit()
    const ids = await submitted
    const alloc = ids[index]
    if (alloc === undefined) {
      throw new NomadError(`@vzn/vx-agents: no allocation for agent ${index} of ${opts.count}`)
    }
    return {
      id: `nomad:${alloc.slice(0, 8)}`,
      async exec(spec: AgentCommand): Promise<AgentResult> {
        // `-i=false -t=false`: no stdin, no TTY. A TTY would merge stdout and
        // stderr into one stream, and vx keeps them apart — only stdout is
        // ever cached.
        const p = Bun.spawn(
          [
            'nomad',
            'alloc',
            'exec',
            ...ns,
            '-i=false',
            '-t=false',
            '-task',
            'agent',
            alloc,
            'sh',
            '-c',
            `cd ${shellQuote(joinPosix(opts.containerWorkspace, spec.cwd))} && ${envPrefix(spec.env)}${spec.command}`,
          ],
          { stdout: 'pipe', stderr: 'pipe' },
        )
        const abort = (): void => {
          p.kill()
        }
        spec.signal?.addEventListener('abort', abort, { once: true })
        const [, , exitCode] = await Promise.all([
          pump(p.stdout, spec.onStdout),
          pump(p.stderr, spec.onStderr),
          p.exited,
        ])
        spec.signal?.removeEventListener('abort', abort)
        return { exitCode }
      },
      async dispose(): Promise<void> {
        // Only the last agent out stops the job: they share one.
        if (index !== 0) return
        const stop = await nomad(['job', 'stop', '-purge', '-detach', ...ns, opts.jobId])
        if (stop.code !== 0) warn(`@vzn/vx-agents: nomad job stop failed: ${stop.err.trim()}`)
      },
    }
  }
}

/** `VAR='v' ` pairs for a POSIX shell, since `alloc exec` takes no -e flags. */
export function envPrefix(env: Readonly<Record<string, string>>): string {
  const pairs = Object.entries(env)
  if (pairs.length === 0) return ''
  return `${pairs.map(([k, v]) => `${k}=${shellQuote(v)}`).join(' ')} `
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

async function pump(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: string) => void,
): Promise<void> {
  const decoder = new TextDecoder()
  for await (const chunk of stream) onChunk(decoder.decode(chunk, { stream: true }))
  const tail = decoder.decode()
  if (tail !== '') onChunk(tail)
}
