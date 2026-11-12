import { describe, expect, it } from 'bun:test'
import type { TaskConfig } from '../src/config.js'
import type { CacheLayer } from '../src/cache/index.js'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import type { ExecuteArgs } from '../src/orchestrator/execute-task.js'
import { inputStabilityOf, taskPolicy } from '../src/orchestrator/task-policy.js'

const cached: TaskConfig = {
  exec: { command: 'build' },
  cache: true,
  inputs: { files: ['src/**'] },
  outputs: { files: ['dist/**'] },
}

function node(config: TaskConfig = cached, id = 'p#build'): TaskNode {
  return {
    id,
    projectName: id.split('#')[0]!,
    projectDir: '/ws/p',
    taskName: id.split('#')[1]!,
    config,
    deps: [],
    requested: true,
  } as TaskNode
}

function args(over: Partial<ExecuteArgs> = {}, n = node()): ExecuteArgs {
  return {
    node: n,
    upstream: [],
    workspaceRoot: '/ws',
    cache: { hasRemote: false } as unknown as CacheLayer,
    log: {} as ExecuteArgs['log'],
    executor: {} as ExecuteArgs['executor'],
    nestedProjectDirs: [],
    runStartHrTimeNs: 0n,
    keyedProjects: () => new Set(),
    ...over,
  }
}

const ALL_ON = { localRead: true, localWrite: true, remoteRead: true, remoteWrite: true }

describe('taskPolicy: what a cached task may read, write and plan to save', () => {
  it('a cached task reads, writes and plans a save', () => {
    const p = taskPolicy(args())
    expect([p.read, p.write, p.save]).toEqual([true, true, true])
  })

  it('a task with no cache block neither reads, writes nor saves', () => {
    const p = taskPolicy(args({}, node({ exec: { command: 'x' } })))
    expect([p.cacheable, p.read, p.write, p.save]).toEqual([false, false, false, false])
  })

  it('--no-cache turns every axis off: no read, no write, no save', () => {
    const off = { localRead: false, localWrite: false, remoteRead: false, remoteWrite: false }
    const p = taskPolicy(args({ cachePolicy: off }))
    expect([p.read, p.write, p.save]).toEqual([false, false, false])
  })

  it('--force reads nothing but still writes and saves', () => {
    const force = { ...ALL_ON, localRead: false, remoteRead: false }
    const p = taskPolicy(args({ cachePolicy: force }))
    expect([p.read, p.write, p.save]).toEqual([false, true, true])
  })

  it('remote-only touches no local cache', () => {
    const p = taskPolicy(args({ remoteOnly: true }))
    expect([p.remoteOnly, p.read, p.write, p.save]).toEqual([true, false, false, false])
  })

  it('a tainted upstream, a no-op below it, or a keyless key withholds the save but not the clean', () => {
    for (const over of [{ taintedUpstream: true }, { belowNoop: true }]) {
      const p = taskPolicy(args(over))
      expect([p.write, p.save]).toEqual([true, false])
    }
    const keyless = taskPolicy(args({}, node({ ...cached, inputs: undefined })))
    expect([keyless.keylessBy, keyless.read, keyless.write, keyless.save]).toEqual([
      'p#build',
      false,
      true,
      false,
    ])
  })

  it('a folded upstream that is keyless or unkeyed withholds the save', () => {
    const up = (u: Partial<TaskOutcome>): TaskOutcome =>
      ({
        node: node(cached, 'q#build'),
        status: 'success',
        exitCode: 0,
        hash: 'h',
        ...u,
      }) as TaskOutcome
    const n = { ...node(), deps: ['q#build'] }
    const viaKeyless = taskPolicy(args({ upstream: [up({ keylessBy: 'r#gen' })] }, n))
    expect([viaKeyless.keylessBy, viaKeyless.save]).toEqual(['r#gen', false])
    const unkeyed = up({ unkeyed: true })
    const viaUnkeyed = taskPolicy(args({ upstream: [unkeyed] }, n))
    expect([viaUnkeyed.unkeyedUpstream, viaUnkeyed.read, viaUnkeyed.save]).toEqual([
      unkeyed,
      true,
      false,
    ])
  })

  it('an upstream read only by content (`tasks: []`) does not withhold the save', () => {
    const unkeyed = {
      node: node(cached, 'q#build'),
      status: 'success',
      exitCode: 0,
      hash: 'h',
      unkeyed: true,
    } as TaskOutcome
    const n = {
      ...node({ ...cached, inputs: { files: ['src/**'], tasks: [] } }),
      deps: ['q#build'],
    }
    const p = taskPolicy(args({ upstream: [unkeyed] }, n))
    expect([p.unkeyedUpstream, p.save]).toEqual([undefined, true])
  })

  it('deferral, additive outputs and clean: false', () => {
    expect(taskPolicy(args({ download: 'deferred' })).deferred).toBe(true)
    const additive = taskPolicy(args({}, { ...node(), addsToOutputsOf: ['q#build'] }))
    expect(additive.additive).toBe(true)
    const keep = taskPolicy(args({ cleanOutputs: false }))
    expect(keep.keepOutputs).toBe(true)
    // The task's own `outputs.clean` beats the workspace's.
    const own = node({ ...cached, outputs: { files: ['dist/**'], clean: true } })
    expect(taskPolicy(args({ cleanOutputs: false }, own)).keepOutputs).toBe(false)
    // An additive task never cleans by glob, so it keeps nothing either.
    const both = taskPolicy(
      args({ cleanOutputs: false }, { ...node(), addsToOutputsOf: ['q#build'] }),
    )
    expect(both.keepOutputs).toBe(false)
  })

  it('retries: the task beats the run, an explicit 0 included; a known flake may get one', () => {
    expect(taskPolicy(args({ retries: 2 })).maxAttempts).toBe(3)
    const zero = node({ ...cached, exec: { command: 'b', retries: 0 } })
    const p = taskPolicy(args({ retries: 2 }, zero))
    expect([p.maxAttempts, p.retriesSet, p.retryCanFollow]).toEqual([1, true, false])
    const flaky = taskPolicy(args({ knownFlaky: () => true }))
    expect([flaky.maxAttempts, flaky.retriesSet, flaky.retryCanFollow]).toEqual([1, false, true])
    expect(taskPolicy(args()).retryCanFollow).toBe(false)
  })

  it('timeout: exec.timeout beats the run', () => {
    expect(taskPolicy(args({ timeout: 5000 })).timeout).toBe(5000)
    const own = node({ ...cached, exec: { command: 'b', timeout: '1s' } })
    expect(taskPolicy(args({ timeout: 5000 }, own)).timeout).toBe(1000)
  })

  it("an executor's own record: unsaved when no save is planned or the remote write is off", () => {
    expect(taskPolicy(args()).unsaved).toBe(false)
    expect(taskPolicy(args({ taintedUpstream: true })).unsaved).toBe(true)
    const remote = { hasRemote: true } as unknown as CacheLayer
    const noRemoteWrite = { ...ALL_ON, remoteWrite: false }
    expect(taskPolicy(args({ cache: remote, cachePolicy: noRemoteWrite })).unsaved).toBe(true)
    // Without a remote layer the remote axes say nothing about the record.
    expect(taskPolicy(args({ cachePolicy: noRemoteWrite })).unsaved).toBe(false)
  })

  it('refresh: no read axis, or the remote read off with a remote', () => {
    expect(taskPolicy(args()).refresh).toBe(false)
    const force = { ...ALL_ON, localRead: false, remoteRead: false }
    expect(taskPolicy(args({ cachePolicy: force })).refresh).toBe(true)
    const remote = { hasRemote: true } as unknown as CacheLayer
    const noRemoteRead = { ...ALL_ON, remoteRead: false }
    expect(taskPolicy(args({ cache: remote, cachePolicy: noRemoteRead })).refresh).toBe(true)
    expect(taskPolicy(args({ cachePolicy: noRemoteRead })).refresh).toBe(false)
  })

  it('forward args reach only a requested task', () => {
    expect(taskPolicy(args({ forwardArgs: ['--x'] })).forwardArgs).toEqual(['--x'])
    const dep = { ...node(), requested: false }
    expect(taskPolicy(args({ forwardArgs: ['--x'] }, dep)).forwardArgs).toEqual([])
  })
})

describe('inputStabilityOf: the run, then the task, then the workspace', () => {
  it('defaults to immutable and warn', () => {
    expect(inputStabilityOf(undefined, undefined)).toEqual({
      strategy: 'immutable',
      severity: 'warn',
    })
  })

  it('each field from the highest layer that sets it', () => {
    const layers = {
      run: { severity: 'error' as const },
      workspace: { strategy: 'unchecked' as const, severity: 'warn' as const },
    }
    expect(inputStabilityOf({ stability: { strategy: 'mutable' } }, layers)).toEqual({
      strategy: 'mutable',
      severity: 'error',
    })
    expect(inputStabilityOf({}, layers)).toEqual({ strategy: 'unchecked', severity: 'error' })
  })
})
