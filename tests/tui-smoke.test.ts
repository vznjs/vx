// TUI smoke test — mounts the Solid TUI in OpenTUI's `testing`
// mode (no alt-screen, no real stdin/stdout), dispatches a fake
// runStart → taskStart → taskStdout → taskComplete → runEnd
// sequence, and confirms it disposes cleanly.

import { describe, expect, it } from 'bun:test'
import type { ObserverEvent } from '../src/orchestrator/observer.ts'

function sampleRunStart(): ObserverEvent {
  return {
    kind: 'runStart',
    runId: '01HX-smoke',
    nodes: [
      {
        id: 'pkg#build',
        projectName: 'pkg',
        projectDir: '/tmp/pkg',
        taskName: 'build',
        config: { exec: { command: 'echo hi' } },
        deps: [],
        requested: true,
      },
    ],
    concurrency: 2,
    remoteCacheEnabled: false,
    startedAtMs: Date.now(),
    historyTable: new Map(),
  }
}

function sampleRunEnd(): ObserverEvent {
  return { kind: 'runEnd', ok: true, outcomes: [], totalMs: 0, endedAtMs: Date.now() }
}

describe('startTui (Solid)', () => {
  it('mounts and disposes without throwing', async () => {
    // OpenTUI's renderer init still writes to fd 1 even in testing
    // mode; quiet it so the bun test reporter stays clean.
    const orig = process.stdout.write
    process.stdout.write = (() => true) as typeof orig
    try {
      const { startTui } = await import('../src/tui/tui.tsx')
      const handle = await startTui({ testing: true })
      handle.observer.emit(sampleRunStart())
      handle.observer.emit({
        kind: 'taskStart',
        nodeId: 'pkg#build',
        startNs: 1n,
        slot: 0,
      })
      handle.observer.emit({
        kind: 'taskStdout',
        nodeId: 'pkg#build',
        chunk: 'hi\nthere\n',
      })
      handle.observer.emit({
        kind: 'taskComplete',
        outcome: {
          node: {
            id: 'pkg#build',
            projectName: 'pkg',
            projectDir: '/tmp/pkg',
            taskName: 'build',
            config: { exec: { command: 'echo hi' } },
            deps: [],
            requested: true,
          },
          status: 'success',
          exitCode: 0,
          durationMs: 0,
        },
      })
      handle.observer.emit(sampleRunEnd())
      await handle.dispose()
      // Idempotent.
      await expect(handle.dispose()).resolves.toBeUndefined()
    } finally {
      process.stdout.write = orig
    }
  }, 10_000)
})
