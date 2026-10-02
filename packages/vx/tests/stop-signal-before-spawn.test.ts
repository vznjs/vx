// A task stopped before its spawn exits as the stop's signal would have
// killed it. A hang-up forwards SIGTERM to running tasks
// (`forwardedSignal`), so one never spawned read 129 (SIGHUP) where its
// spawned sibling read 143 under the same stop (2026-10-02).
import { describe, expect, it } from 'bun:test'
import { localExecutor } from '../src/exec/local-executor.js'
import { forwardedSignal } from '../src/orchestrator/signals.js'

const stopped = (reason: string) => {
  const stop = new AbortController()
  stop.abort(reason)
  return localExecutor().execute({
    taskId: 'a#t',
    workspaceRoot: '/',
    outputs: { files: [], workspaceFiles: [] },
    command: 'true',
    forwardArgs: [],
    cwd: '/',
    env: process.env,
    envDefine: {},
    capture: { stdout: true, stderr: true },
    onStdout: () => {},
    onStderr: () => {},
    signal: stop.signal,
  })
}

describe('a request stopped before its spawn', () => {
  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 143],
    ['an embedder reason', 143],
  ])('on %s exits %d, the signal a spawned task is sent', async (reason, code) => {
    const r = await stopped(reason)
    expect([r.exitCode, r.signal]).toEqual([code, forwardedSignal(reason)])
  })
})
