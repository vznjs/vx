import { describe, it, expect } from 'bun:test'
import { parseRunArgs } from '../src/cli/index.js'
import { startUiServer } from '../src/cli/ui-server.js'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'

describe('parseRunArgs --ui', () => {
  it('parses --ui and --ui-port (spaced and =)', () => {
    const a = parseRunArgs(['build', '--ui', '--ui-port', '9123'])
    expect(a.ui).toBe(true)
    expect(a.uiPort).toBe(9123)
    expect(a.error).toBeUndefined()
    expect(parseRunArgs(['build', '--ui-port=9124']).uiPort).toBe(9124)
  })

  it('rejects --ui combined with --dry / --graph', () => {
    expect(parseRunArgs(['build', '--ui', '--dry']).error).toContain('--ui')
    expect(parseRunArgs(['build', '--ui', '--graph']).error).toContain('--ui')
  })

  it('rejects a malformed --ui-port', () => {
    expect(parseRunArgs(['--ui-port', 'abc']).error).toContain('--ui-port')
    expect(parseRunArgs(['--ui-port', '99999']).error).toContain('--ui-port')
  })
})

describe('startUiServer', () => {
  it('boots a dev server, forwards run events, serves connection meta, and closes', async () => {
    const ui = await startUiServer()
    try {
      expect(ui.origin).toMatch(/^http:\/\//)

      // Emitting onto the returned bus must reach the mounted surface
      // without throwing (the live shared-state + stream path).
      const node = {
        id: 'a#build',
        projectName: 'a',
        taskName: 'build',
        config: { exec: { command: 'x' } },
        requested: false,
      } as unknown as TaskNode
      ui.bus.emit({ kind: 'run:start', info: { total: 1 } })
      ui.bus.emit({ kind: 'task:start', node })
      ui.bus.emit({
        kind: 'task:complete',
        node,
        outcome: { node, status: 'success', exitCode: 0, durationMs: 7 } as TaskOutcome,
      })
      ui.bus.emit({ kind: 'run:end' })

      // The dev server serves devframe's connection-meta endpoint.
      const res = await fetch(`${ui.origin}/__connection.json`)
      expect(res.status).toBe(200)
    } finally {
      await ui.close()
    }
  })
})
