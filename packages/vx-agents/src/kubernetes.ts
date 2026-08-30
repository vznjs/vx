// A Kubernetes-backed agent: one long-lived Pod per agent, driven by
// `kubectl exec`.
//
// Pods, not Jobs, and the distinction is the same one Nomad forced. A Job is
// "run this to completion", so one per vx task pays pod scheduling and image
// pull every time — ~400 ms of container start at best, far more on a real
// cluster. A Pod that stays up is scheduled once and exec'd into thereafter,
// which is where the ~30 ms number comes from. The resource request you asked
// for lives on the Pod either way.
//
// `kubectl` rather than a client library: no API machinery to vendor, no
// kubeconfig parsing, no auth plugin matrix — whatever `kubectl` can already
// reach, vx can.
//
// WORKSPACE: every agent runs against a shared filesystem. `volume` is passed
// through verbatim as the Pod's volume definition, so a single-node cluster
// can use a hostPath and a real one a ReadWriteMany claim. vx does not
// pretend a remote cluster can see your laptop.

import type { Agent, AgentCommand, AgentResult } from './pool.js'
import { joinPosix } from './docker.js'
import { envPrefix, shellQuote } from './nomad.js'

export interface KubernetesAgentOptions {
  readonly image: string
  readonly containerWorkspace: string
  /** The Pod `volumes[0]` entry, verbatim — hostPath, PVC, whatever fits. */
  readonly volume: Readonly<Record<string, unknown>>
  /** Kubernetes CPU quantity, e.g. '2' or '500m'. */
  readonly cpu: string
  /** Kubernetes memory quantity, e.g. '2Gi'. */
  readonly memory: string
  readonly namespace: string
  readonly namePrefix: string
  readonly env: Readonly<Record<string, string>>
}

export class KubernetesError extends Error {}

/**
 * The Pod manifest. Pure, so the shape can be asserted without a cluster —
 * this JSON is the contract with the API server, and a wrong field there
 * fails at apply time with a message about schema rather than about vx.
 */
export function podManifest(opts: KubernetesAgentOptions, name: string): unknown {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: opts.namespace,
      labels: { 'app.kubernetes.io/managed-by': 'vx-agents' },
    },
    spec: {
      // The agent is infrastructure: a task failing must not make Kubernetes
      // recreate the container underneath the next task.
      restartPolicy: 'Never',
      terminationGracePeriodSeconds: 0,
      containers: [
        {
          name: 'agent',
          image: opts.image,
          // Overridden, not appended to — a toolchain image usually has its
          // own entrypoint and the keep-alive would become an argument to it.
          command: ['sh', '-c', 'sleep infinity'],
          workingDir: opts.containerWorkspace,
          env: Object.entries(opts.env).map(([name_, value]) => ({ name: name_, value })),
          // Requests AND limits: the request is what the scheduler reserves,
          // the limit is what the task may actually take. Setting only the
          // request lets one heavy task starve its neighbours on the node.
          resources: {
            requests: { cpu: opts.cpu, memory: opts.memory },
            limits: { cpu: opts.cpu, memory: opts.memory },
          },
          volumeMounts: [{ name: 'workspace', mountPath: opts.containerWorkspace }],
        },
      ],
      volumes: [{ name: 'workspace', ...opts.volume }],
    },
  }
}

async function kubectl(
  args: readonly string[],
  stdin?: string,
): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(['kubectl', ...args], {
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

export function kubernetesAgentFactory(
  opts: KubernetesAgentOptions,
  warn: (m: string) => void,
): (index: number) => Promise<Agent> {
  const ns = ['-n', opts.namespace]
  return async (index: number): Promise<Agent> => {
    const name = `${opts.namePrefix}-${index}`
    // Debris from a killed run would otherwise collide on the name, which
    // reads as a vx bug rather than as leftovers.
    await kubectl(['delete', 'pod', name, ...ns, '--ignore-not-found', '--wait=false'])
    const applied = await kubectl(
      ['apply', ...ns, '-f', '-'],
      JSON.stringify(podManifest(opts, name)),
    )
    if (applied.code !== 0) {
      throw new KubernetesError(
        `@vzn/vx-agents: could not create pod ${name}: ${applied.err.trim() || applied.out.trim()}`,
      )
    }
    // Scheduling and the image pull are asynchronous; exec'ing before Ready
    // fails with a message about the container, not about the wait.
    const ready = await kubectl([
      'wait',
      ...ns,
      '--for=condition=Ready',
      `pod/${name}`,
      '--timeout=300s',
    ])
    if (ready.code !== 0) {
      throw new KubernetesError(
        `@vzn/vx-agents: pod ${name} never became ready: ${ready.err.trim() || ready.out.trim()}`,
      )
    }

    return {
      id: `k8s:${name}`,
      async exec(spec: AgentCommand): Promise<AgentResult> {
        const p = Bun.spawn(
          [
            'kubectl',
            'exec',
            ...ns,
            name,
            '--',
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
        const del = await kubectl(['delete', 'pod', name, ...ns, '--wait=false'])
        if (del.code !== 0) warn(`@vzn/vx-agents: could not delete pod ${name}: ${del.err.trim()}`)
      },
    }
  }
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
