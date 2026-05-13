// TUI smoke test — imports the renderer entry, mounts OpenTUI in
// headless `testing` mode, dispatches a fake runStart/runEnd, and
// confirms it disposes cleanly. We're not asserting on framebuffer
// output; the goal is to catch import-time and lifecycle regressions.

import { describe, expect, it } from 'bun:test'
import type { ObserverEvent } from '../src/orchestrator/observer.ts'

const sample = (kind: ObserverEvent['kind']): ObserverEvent => {
  if (kind === 'runStart') {
    return {
      kind: 'runStart',
      runId: '01HX',
      nodes: [],
      concurrency: 2,
      remoteCacheEnabled: false,
      startedAtMs: Date.now(),
      historyTable: new Map(),
    }
  }
  return { kind: 'runEnd', ok: true, outcomes: [], totalMs: 0, endedAtMs: Date.now() }
}

import { initialState, reduce } from '../src/tui/state/store.ts'

describe('reduce — view + overlay keys', () => {
  it('cycles activeView via viewChange', () => {
    let s = initialState()
    for (const v of [1, 2, 3, 4, 5] as const) {
      s = reduce(s, { type: 'key', key: { kind: 'viewChange', view: v } })
      expect(s.activeView).toBe(v)
    }
  })

  it('opens / closes the task detail overlay', () => {
    let s = reduce(initialState(), { type: 'key', key: { kind: 'openTaskDetail' } })
    expect(s.taskDetailOpen).toBe(true)
    s = reduce(s, { type: 'key', key: { kind: 'closeOverlay' } })
    expect(s.taskDetailOpen).toBe(false)
    expect(s.showHelp).toBe(false)
  })
})

describe('startTui', () => {
  it('mounts and disposes without throwing', async () => {
    // OpenTUI writes ANSI sequences directly during init / teardown.
    // Patch both the WriteStream write AND the raw fd-1 writer so the
    // bun test reporter stays clean.
    const stdoutWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (() => true) as typeof process.stdout.write
    try {
      const { startTui } = await import('../src/tui/tui.ts')
      const handle = await startTui({ version: '0.0.0-test', testing: true })
      handle.observer.emit(sample('runStart'))
      handle.observer.emit(sample('runEnd'))
      await handle.dispose()
      // Idempotent.
      await expect(handle.dispose()).resolves.toBeUndefined()
    } finally {
      process.stdout.write = stdoutWrite
    }
  }, 10_000)
})
