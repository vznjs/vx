// The job spec and the pod manifest ARE the contract with each scheduler, so
// they are pinned here — a wrong field fails at submit time with a message
// about schema, which reads as a vx bug and is expensive to trace back.
//
// None of this needs a cluster: the specs are pure functions on purpose.

import { describe, expect, it } from 'bun:test'
import { nomadJobSpec, runningAllocIds, envPrefix, shellQuote } from '../src/nomad.js'
import { podManifest } from '../src/kubernetes.js'
import { dockerResourceArgs } from '../src/index.js'

const nomadOpts = {
  image: 'toolchain:latest',
  containerWorkspace: '/workspace',
  volumeSource: '/host/repo',
  cpu: 2000,
  memoryMb: 4096,
  count: 3,
  jobId: 'vx-agent',
  env: { CI: '1' },
}

interface NomadJob {
  Job: {
    ID: string
    TaskGroups: Array<{
      Count: number
      RestartPolicy: { Attempts: number }
      ReschedulePolicy: { Attempts: number }
      Tasks: Array<{
        Driver: string
        Config: { image: string; entrypoint: string[]; args: string[]; volumes: string[] }
        Env: Record<string, string>
        Resources: { CPU: number; MemoryMB: number }
      }>
    }>
  }
}

describe('the Nomad job spec', () => {
  const job = nomadJobSpec(nomadOpts) as NomadJob
  const group = job.Job.TaskGroups[0]!
  const task = group.Tasks[0]!

  it('asks for ONE job with `count` allocations, not a job per task', () => {
    // A job per vx task pays container start every time — measured ~400 ms,
    // against ~30 ms for exec'ing into an allocation that is already running.
    expect(job.Job.TaskGroups.length).toBe(1)
    expect(group.Count).toBe(3)
  })

  it('carries the resource reservation the caller asked for', () => {
    expect(task.Resources).toEqual({ CPU: 2000, MemoryMB: 4096 })
  })

  it('overrides the image entrypoint so the keep-alive is not an argument to it', () => {
    // A toolchain image usually has its own entrypoint; without this the
    // container exits immediately and every task reports "not running".
    expect(task.Config.entrypoint).toEqual(['sh'])
    expect(task.Config.args).toEqual(['-c', 'sleep infinity'])
  })

  it('mounts the shared workspace where the commands will run', () => {
    expect(task.Config.volumes).toEqual(['/host/repo:/workspace'])
  })

  // The agent is infrastructure. If a vx task failing made Nomad restart or
  // reschedule the allocation, the NEXT task would find its container
  // replaced mid-run.
  it('never restarts or reschedules an agent on task failure', () => {
    expect(group.RestartPolicy.Attempts).toBe(0)
    expect(group.ReschedulePolicy.Attempts).toBe(0)
  })
})

describe('reading Nomad allocations', () => {
  it('takes only running ones, in a stable order', () => {
    // Order has to be deterministic: agent N must mean the same allocation on
    // every call, or two agents could be handed the same one.
    const json = JSON.stringify([
      { ID: 'ccc', ClientStatus: 'running' },
      { ID: 'aaa', ClientStatus: 'running' },
      { ID: 'bbb', ClientStatus: 'pending' },
      { ID: 'ddd', ClientStatus: 'failed' },
    ])
    expect(runningAllocIds(json)).toEqual(['aaa', 'ccc'])
  })

  it('is empty when nothing has been placed yet', () => {
    expect(runningAllocIds('[]')).toEqual([])
  })
})

interface Pod {
  kind: string
  metadata: { name: string; namespace: string }
  spec: {
    restartPolicy: string
    containers: Array<{
      command: string[]
      workingDir: string
      env: Array<{ name: string; value: string }>
      resources: { requests: Record<string, string>; limits: Record<string, string> }
      volumeMounts: Array<{ name: string; mountPath: string }>
    }>
    volumes: Array<Record<string, unknown>>
  }
}

describe('the Kubernetes pod manifest', () => {
  const pod = podManifest(
    {
      image: 'toolchain:latest',
      containerWorkspace: '/workspace',
      volume: { persistentVolumeClaim: { claimName: 'repo' } },
      cpu: '2',
      memory: '4Gi',
      namespace: 'builds',
      namePrefix: 'vx-agent',
      env: { CI: '1' },
    },
    'vx-agent-0',
  ) as Pod

  it('is a long-lived Pod, not a Job', () => {
    // A Job runs to completion, so one per vx task pays pod scheduling and an
    // image pull every time. A Pod is scheduled once and exec'd into after.
    expect(pod.kind).toBe('Pod')
    expect(pod.spec.containers[0]!.command).toEqual(['sh', '-c', 'sleep infinity'])
  })

  it('sets requests AND limits, not just the reservation', () => {
    // The request is what the scheduler reserves; the limit is what the task
    // may actually take. With only a request one heavy task starves the node.
    expect(pod.spec.containers[0]!.resources.requests).toEqual({ cpu: '2', memory: '4Gi' })
    expect(pod.spec.containers[0]!.resources.limits).toEqual({ cpu: '2', memory: '4Gi' })
  })

  it('never restarts the container under a running task', () => {
    expect(pod.spec.restartPolicy).toBe('Never')
  })

  it('passes the volume source through verbatim, whatever it is', () => {
    // A single-node cluster wants a hostPath and a real one a claim; vx has
    // no business rewriting either.
    expect(pod.spec.volumes[0]).toEqual({
      name: 'workspace',
      persistentVolumeClaim: { claimName: 'repo' },
    })
    expect(pod.spec.containers[0]!.volumeMounts[0]).toEqual({
      name: 'workspace',
      mountPath: '/workspace',
    })
  })

  it('honours the namespace it was given', () => {
    expect(pod.metadata.namespace).toBe('builds')
    expect(pod.metadata.name).toBe('vx-agent-0')
  })
})

describe('one config, the same reservation on every backend', () => {
  it('maps cpu/memory onto docker flags', () => {
    expect(dockerResourceArgs({ cpu: 2, memory: '2g' })).toEqual(['--cpus', '2', '--memory', '2g'])
  })

  it('adds nothing when the caller asked for nothing', () => {
    expect(dockerResourceArgs({})).toEqual([])
  })

  it('keeps explicit runArgs, and puts them first', () => {
    expect(dockerResourceArgs({ runArgs: ['--network', 'host'], cpu: 1 })).toEqual([
      '--network',
      'host',
      '--cpus',
      '1',
    ])
  })
})

describe('shell handoff', () => {
  // `nomad alloc exec` and `kubectl exec` take no -e flags, so env crosses as
  // a prefix — which means it MUST be quoted or a value with a space silently
  // becomes another command.
  it('quotes env values rather than splicing them raw', () => {
    expect(envPrefix({ MSG: "it's here", N: '1' })).toBe(`MSG='it'\\''s here' N='1' `)
  })

  it('is empty when there is nothing to pass', () => {
    expect(envPrefix({})).toBe('')
  })

  it('quotes a path containing a quote', () => {
    expect(shellQuote("/a/b'c")).toBe(`'/a/b'\\''c'`)
  })
})
