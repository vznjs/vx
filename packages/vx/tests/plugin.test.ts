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
    // The MESSAGE, not just /setup/: without the authoring check the call
    // goes ahead and the TypeError it raises comes back wrapped as
    // "failed to load: plugin.setup is not a function", which satisfies
    // /setup/ just as well. The two paths differ only in the sentence.
    await expect(
      installPlugins({
        plugins: [{ name: 'x', setup: 'not a function' } as unknown as Plugin],
        bus,
        workspaceRoot: '/ws',
        cacheDir: '/ws/.vx/cache',
      }),
    ).rejects.toThrow(new Error("plugin 'x' setup is not a function"))
  })

  it('awaits each setup in order, so a plugin subscribes before the next runs', async () => {
    // "setup() promises are awaited in order so a plugin's hooks are
    // subscribed before the next plugin's setup runs" — and an async setup
    // left unawaited also swallows its own rejection, since the abort below
    // is the only thing that stops a run with a broken plugin.
    const bus = createEventBus()
    const order: string[] = []
    const slow: Plugin = {
      name: 'org/slow',
      async setup() {
        await Promise.resolve()
        order.push('slow')
      },
    }
    const fast: Plugin = {
      name: 'org/fast',
      setup() {
        order.push('fast')
      },
    }
    await installPlugins({
      plugins: [slow, fast],
      bus,
      workspaceRoot: '/ws',
      cacheDir: '/ws/.vx/cache',
    })
    expect(order).toEqual(['slow', 'fast'])

    // CONTROL: an async setup that REJECTS still aborts the install.
    await expect(
      installPlugins({
        plugins: [{ name: 'org/late', setup: () => Promise.reject(new Error('boom')) }],
        bus,
        workspaceRoot: '/ws',
        cacheDir: '/ws/.vx/cache',
      }),
    ).rejects.toThrow(/org\/late/)
  })

  it('the returned disposer removes EVERY subscription it installed', async () => {
    // Nothing called it: all four rows above discard the return value. Under
    // `vx watch` a plugin instance outlives a run, so a subscription that
    // survives the dispose means the next run's events reach the last run's
    // closures — and keeps them alive for as long as the watcher runs.
    const bus = createEventBus()
    const seen: string[] = []
    const plugin: Plugin = {
      name: 'org/two-hooks',
      setup(ctx) {
        const c = ctx as { on: (h: string, fn: () => void) => void }
        // TWO `on` calls, so a disposer loop that stops after the first is
        // not enough.
        c.on('onTaskStart', () => seen.push('task'))
        c.on('onRunEnd', () => seen.push('end'))
      },
    }
    const dispose = await installPlugins({
      plugins: [plugin],
      bus,
      workspaceRoot: '/ws',
      cacheDir: '/ws/.vx/cache',
    })
    bus.emit({ kind: 'task:start', node: fakeNode() })
    bus.emit({ kind: 'run:end' })
    expect(seen).toEqual(['task', 'end'])

    dispose()
    bus.emit({ kind: 'task:start', node: fakeNode() })
    bus.emit({ kind: 'run:end' })
    expect(seen).toEqual(['task', 'end'])
  })

  it('a plugin disabled by a throwing hook is not called again, and warns once', async () => {
    // "disabled for the remainder of the run" — the row above emits exactly
    // ONE event, so it cannot tell a plugin that was disabled from one that
    // throws afresh every time. A plugin left enabled keeps running its
    // broken hook and reprints the warning on every event of the run.
    const bus = createEventBus()
    const warns: string[] = []
    let calls = 0
    const bad: Plugin = {
      name: 'org/flaky',
      setup(ctx) {
        const c = ctx as { on: (h: string, fn: () => void) => void }
        c.on('onTaskStart', () => {
          calls++
          throw new Error('hook explode')
        })
      },
    }
    await installPlugins({
      plugins: [bad],
      bus,
      workspaceRoot: '/ws',
      cacheDir: '/ws/.vx/cache',
      warn: (m) => warns.push(m),
    })
    bus.emit({ kind: 'task:start', node: fakeNode() })
    bus.emit({ kind: 'task:start', node: fakeNode() })
    bus.emit({ kind: 'task:start', node: fakeNode() })
    expect(calls).toBe(1)
    expect(warns).toHaveLength(1)
  })

  it('without a warn callback the disable still reaches the operator', async () => {
    // The default is console.error on purpose: `installPlugins` is called
    // outside a run too, and a plugin that silently stops observing is
    // indistinguishable from one nobody configured.
    const bus = createEventBus()
    const printed: string[] = []
    const real = console.error
    console.error = (...args: unknown[]) => printed.push(args.map(String).join(' '))
    try {
      await installPlugins({
        plugins: [
          {
            name: 'org/quiet',
            setup(ctx) {
              const c = ctx as { on: (h: string, fn: () => void) => void }
              c.on('onRunEnd', () => {
                throw new Error('boom')
              })
            },
          },
        ],
        bus,
        workspaceRoot: '/ws',
        cacheDir: '/ws/.vx/cache',
      })
      bus.emit({ kind: 'run:end' })
    } finally {
      console.error = real
    }
    expect(printed).toHaveLength(1)
    expect(printed[0]).toContain("plugin 'org/quiet' threw in onRunEnd")
  })

  it("each log hook gets its OWN stream and that stream's chunk", async () => {
    // The two differ only by the event kind they test and nothing pinned
    // either: cross-wired, a plugin tagging build output by stream labels
    // every line backwards, and the chunk itself had no witness at all.
    const bus = createEventBus()
    const out: Array<[string, string]> = []
    const plugin: Plugin = {
      name: 'org/logs',
      setup(ctx) {
        const c = ctx as {
          on: (h: string, fn: (n: TaskNode, chunk: string) => void) => void
        }
        c.on('onTaskStdout', (_n, chunk) => out.push(['stdout', chunk]))
        c.on('onTaskStderr', (_n, chunk) => out.push(['stderr', chunk]))
      },
    }
    await installPlugins({
      plugins: [plugin],
      bus,
      workspaceRoot: '/ws',
      cacheDir: '/ws/.vx/cache',
    })
    const node = fakeNode()
    bus.emit({ kind: 'task:stdout', node, chunk: 'to-out' })
    bus.emit({ kind: 'task:stderr', node, chunk: 'to-err' })
    expect(out).toEqual([
      ['stdout', 'to-out'],
      ['stderr', 'to-err'],
    ])
  })

  it('onRunStatus receives the status line', async () => {
    const bus = createEventBus()
    const lines: string[] = []
    const plugin: Plugin = {
      name: 'org/status',
      setup(ctx) {
        const c = ctx as { on: (h: string, fn: (line: string) => void) => void }
        c.on('onRunStatus', (line) => lines.push(line))
      },
    }
    await installPlugins({
      plugins: [plugin],
      bus,
      workspaceRoot: '/ws',
      cacheDir: '/ws/.vx/cache',
    })
    bus.emit({ kind: 'run:status', line: 'a footer line' })
    expect(lines).toEqual(['a footer line'])
  })
})
