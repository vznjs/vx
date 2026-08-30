// A Docker-backed agent: one long-lived container per agent, with the
// workspace bind-mounted, driven by `docker exec`.
//
// The bind mount is the whole point. A REAPI action ships its inputs and
// ships its outputs back; an agent that already sees the workspace ships
// NEITHER — the command reads the same bytes vx just hashed, and writes its
// outputs where vx expects to find them. There is no Merkle tree, no CAS, no
// graft, and nothing to go stale between the two.
//
// `docker exec` rather than a network protocol on purpose: there is no daemon
// to write, no port to allocate, no wire format to version, and the failure
// modes are the ones an operator already knows how to read.

import type { Agent, AgentCommand, AgentResult } from './pool.js'

export interface DockerAgentOptions {
  /** Image to run. Must contain the toolchain the workspace's tasks need. */
  readonly image: string
  /** Host path mounted into the container; tasks run inside it. */
  readonly workspaceRoot: string
  /** Where the workspace appears inside the container. */
  readonly containerWorkspace: string
  /** Extra `docker run` arguments — networks, ulimits, devices, whatever the
   *  workspace needs. Passed through verbatim; vx does not interpret them. */
  readonly runArgs: readonly string[]
  /** Environment applied to every command on this agent. */
  readonly env: Readonly<Record<string, string>>
  readonly namePrefix: string
}

/** Thrown when the docker CLI itself fails, as opposed to a task failing. */
export class DockerError extends Error {}

async function docker(
  args: readonly string[],
): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { code, out, err }
}

export async function createDockerAgent(opts: DockerAgentOptions, index: number): Promise<Agent> {
  const name = `${opts.namePrefix}-${index}`
  // A leftover container from a killed run would otherwise make `docker run`
  // fail on a name clash, which reads as a vx bug rather than as debris.
  await docker(['rm', '-f', name])
  const started = await docker([
    'run',
    '-d',
    '--name',
    name,
    '-v',
    `${opts.workspaceRoot}:${opts.containerWorkspace}`,
    '-w',
    opts.containerWorkspace,
    ...Object.entries(opts.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    // The image's own ENTRYPOINT is overridden, not appended to. A toolchain
    // image usually has one (a server, a shell wrapper), and without this the
    // keep-alive becomes an ARGUMENT to it — the container exits immediately
    // and every task fails with "container is not running".
    '--entrypoint',
    'sh',
    ...opts.runArgs,
    opts.image,
    // Keep it alive; every task arrives through `docker exec`.
    '-c',
    'sleep infinity',
  ])
  if (started.code !== 0) {
    throw new DockerError(
      `@vzn/vx-agents: could not start agent ${name} from ${opts.image}: ${started.err.trim()}`,
    )
  }

  return {
    id: name,
    async exec(spec: AgentCommand): Promise<AgentResult> {
      // `sh -c` matches vx's local contract exactly: shell IS the API, so the
      // agent must interpret the string the same way a local spawn does.
      const p = Bun.spawn(
        [
          'docker',
          'exec',
          '-w',
          joinPosix(opts.containerWorkspace, spec.cwd),
          ...Object.entries(spec.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
          name,
          'sh',
          '-c',
          spec.command,
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
      const res = await docker(['rm', '-f', name])
      if (res.code !== 0) throw new DockerError(res.err.trim())
    },
  }
}

/** Stream a pipe to a callback as it arrives, so a long task is not silent. */
async function pump(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: string) => void,
): Promise<void> {
  const decoder = new TextDecoder()
  for await (const chunk of stream) onChunk(decoder.decode(chunk, { stream: true }))
  const tail = decoder.decode()
  if (tail !== '') onChunk(tail)
}

/** Join inside the CONTAINER, which is always POSIX regardless of this host. */
export function joinPosix(base: string, rel: string): string {
  if (rel === '' || rel === '.') return base
  return `${base.replace(/\/+$/, '')}/${rel.replace(/^\.\//, '').replace(/^\/+/, '')}`
}
