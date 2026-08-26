import { describe, expect, it } from 'bun:test'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import { createEventBus, installPlugins, type Plugin } from '../src/orchestrator/index.js'

function fakeNode(id = 'a#b'): TaskNode {
  const [projectName, taskName] = id.split('#') as [string, string]
  return {
    id,
    projectName,
    projectDir: '/ws/' + projectName,
    taskName,
    config: { exec: { command: 'echo' } } as TaskNode['config'],
    deps: [],
    requested: false,
  }
}

function fakeOutcome(node: TaskNode): TaskOutcome {
  return { node, status: 'success', exitCode: 0, durationMs: 5 } as unknown as TaskOutcome
}

describe('Plugin API', () => {
  it('fires onRunStart / onTaskStart / onRunEnd in order', async () => {
    const bus = createEventBus()
    const seen: string[] = []
    const plugin: Plugin = {
      name: 'org/test',
      setup(ctx) {
        const c = ctx as {
          on: (h: string, fn: (...args: unknown[]) => void) => void
        }
        c.on('onRunStart', () => seen.push('start'))
        c.on('onTaskStart', () => seen.push('task'))
        c.on('onRunEnd', () => seen.push('end'))
      },
    }
    await installPlugins({
      plugins: [plugin],
      bus,
      workspaceRoot: '/ws',
      cacheDir: '/ws/.vx/cache',
    })
    bus.emit({ kind: 'run:start', info: { total: 1 } })
    bus.emit({ kind: 'task:start', node: fakeNode() })
    bus.emit({ kind: 'run:end' })
    expect(seen).toEqual(['start', 'task', 'end'])
  })

  it('threads task complete payload through onTaskComplete', async () => {
    const bus = createEventBus()
    const records: Array<{ id: string; status: string }> = []
    const plugin: Plugin = {
      name: 'org/recorder',
      setup(ctx) {
        const c = ctx as {
          on: (h: string, fn: (n: TaskNode, o: TaskOutcome) => void) => void
        }
        c.on('onTaskComplete', (n, o) => {
          records.push({ id: n.id, status: o.status })
        })
      },
    }
    await installPlugins({
      plugins: [plugin],
      bus,
      workspaceRoot: '/ws',
      cacheDir: '/ws/.vx/cache',
    })
    const node = fakeNode('pkg#build')
    bus.emit({ kind: 'task:complete', node, outcome: fakeOutcome(node) })
    expect(records).toEqual([{ id: 'pkg#build', status: 'success' }])
  })

  it('a plugin throwing in setup() aborts with a clear UserError naming it', async () => {
    const bus = createEventBus()
    const bad: Plugin = {
      name: 'org/bad',
      setup() {
        throw new Error('boom')
      },
    }
    await expect(
      installPlugins({
        plugins: [bad],
        bus,
        workspaceRoot: '/ws',
        cacheDir: '/ws/.vx/cache',
      }),
    ).rejects.toThrow(/org\/bad/)
  })

  it("a plugin throwing inside a hook is disabled, doesn't block the bus", async () => {
    const bus = createEventBus()
    const warns: string[] = []
    const reachedAfter: string[] = []
    const bad: Plugin = {
      name: 'org/flaky',
      setup(ctx) {
        const c = ctx as { on: (h: string, fn: () => void) => void }
        c.on('onTaskStart', () => {
          throw new Error('hook explode')
        })
      },
    }
    const good: Plugin = {
      name: 'org/good',
      setup(ctx) {
        const c = ctx as { on: (h: string, fn: () => void) => void }
        c.on('onTaskStart', () => {
          reachedAfter.push('hit')
        })
      },
    }
    await installPlugins({
      plugins: [bad, good],
      bus,
      workspaceRoot: '/ws',
      cacheDir: '/ws/.vx/cache',
      warn: (m) => warns.push(m),
    })
    bus.emit({ kind: 'task:start', node: fakeNode() })
    expect(warns.length).toBeGreaterThanOrEqual(1)
    expect(warns[0]).toContain('org/flaky')
    expect(reachedAfter).toEqual(['hit'])
  })

  it('rejects a plugin missing name or setup', async () => {
    const bus = createEventBus()
    await expect(
      installPlugins({
        plugins: [{ name: '', setup() {} } as Plugin],
        bus,
        workspaceRoot: '/ws',
        cacheDir: '/ws/.vx/cache',
      }),
    ).rejects.toThrow(/name/)
    await expect(
      installPlugins({
        plugins: [{ name: 'x', setup: 'not a function' } as unknown as Plugin],
        bus,
        workspaceRoot: '/ws',
        cacheDir: '/ws/.vx/cache',
      }),
    ).rejects.toThrow(/setup/)
  })
})
