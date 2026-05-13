// TUI Observer — orchestrator-side event bus that the renderer
// consumes. The contract is one method (`emit`) over a tagged-union
// `ObserverEvent`. New event kinds are additive; consumers default to
// ignoring unfamiliar kinds.

import { describe, expect, it } from 'bun:test'
import {
  makeSafeObserver,
  type Observer,
  type ObserverEvent,
} from '../src/orchestrator/observer.ts'

describe('makeSafeObserver', () => {
  it('forwards events to the inner observer in order', () => {
    const seen: ObserverEvent[] = []
    const inner: Observer = { emit: (e) => seen.push(e) }
    const safe = makeSafeObserver(inner)

    safe.emit({
      kind: 'runStart',
      runId: '01HX',
      nodes: [],
      concurrency: 4,
      remoteCacheEnabled: false,
      startedAtMs: 1000,
      historyTable: new Map(),
    })
    safe.emit({ kind: 'taskStart', nodeId: 'a#build', startNs: 1n, slot: 0 })
    safe.emit({ kind: 'taskStdout', nodeId: 'a#build', chunk: 'hello\n' })

    expect(seen.length).toBe(3)
    expect(seen[0]?.kind).toBe('runStart')
    expect(seen[1]?.kind).toBe('taskStart')
    expect(seen[2]?.kind).toBe('taskStdout')
  })

  it('swallows throws from the inner observer and writes to stderr', () => {
    const inner: Observer = {
      emit: () => {
        throw new Error('inner kaboom')
      },
    }
    const safe = makeSafeObserver(inner)

    const orig = process.stderr.write
    const writes: string[] = []
    process.stderr.write = ((s: string | Uint8Array) => {
      writes.push(typeof s === 'string' ? s : new TextDecoder().decode(s))
      return true
    }) as typeof orig

    try {
      expect(() => safe.emit({ kind: 'taskStdout', nodeId: 'x', chunk: 'y' })).not.toThrow()
    } finally {
      process.stderr.write = orig
    }

    expect(writes.some((w) => w.includes('observer error'))).toBe(true)
    expect(writes.some((w) => w.includes('inner kaboom'))).toBe(true)
  })

  it('returns a no-op observer when inner is undefined', () => {
    const safe = makeSafeObserver(undefined)
    expect(() => safe.emit({ kind: 'taskStdout', nodeId: 'x', chunk: 'y' })).not.toThrow()
  })

  it('does not catch errors thrown synchronously by anything else in the call stack', () => {
    // Sanity: the safety wrapper covers the inner observer only.
    // Other throws around the emit call (e.g. a caller's own
    // try/finally) bubble normally.
    const inner: Observer = { emit: () => undefined }
    const safe = makeSafeObserver(inner)
    expect(() => {
      safe.emit({ kind: 'taskStdout', nodeId: 'x', chunk: 'y' })
      throw new Error('caller')
    }).toThrow('caller')
  })
})

describe('ObserverEvent shape', () => {
  // Exercise every union arm so the type definition surfaces breakage
  // on rename / removal in PR review.
  it('admits every documented kind', () => {
    const events: ObserverEvent[] = [
      {
        kind: 'runStart',
        runId: '01HX',
        nodes: [],
        concurrency: 1,
        remoteCacheEnabled: true,
        startedAtMs: 1,
        historyTable: new Map(),
      },
      { kind: 'taskStart', nodeId: 'a', startNs: 0n, slot: 2 },
      { kind: 'taskStdout', nodeId: 'a', chunk: 'x' },
      { kind: 'taskStderr', nodeId: 'a', chunk: 'y' },
      {
        kind: 'cacheProbe',
        nodeId: 'a',
        status: 'hit-local',
      },
      {
        kind: 'remoteCache',
        op: 'GET',
        hash: 'h',
        bytes: 100,
        latencyMs: 5,
        ok: true,
      },
      {
        kind: 'taskComplete',
        outcome: {
          node: {
            id: 'a',
            projectName: 'p',
            projectDir: '/tmp',
            taskName: 't',
            config: { exec: { command: 'noop' } },
            deps: [],
            requested: true,
          },
          status: 'success',
          exitCode: 0,
          durationMs: 0,
        },
      },
      {
        kind: 'runEnd',
        ok: true,
        outcomes: [],
        totalMs: 0,
        endedAtMs: 1,
      },
    ]
    expect(events.length).toBe(8)
  })
})
