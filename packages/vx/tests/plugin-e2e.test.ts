// End-to-end plugin integration: a workspace declares plugins in
// vx.workspace.ts; run() loads them, installs lifecycle hooks, and
// fires them in order across a real run.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { gitInitCommit } from './helpers/workspace.js'
import { planRun, run } from '../src/index.js'
import { pluginSource } from './helpers/plugin.js'

async function writeFixture(): Promise<{ workspaceRoot: string; cleanup: () => void }> {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'vx-plugin-e2e-'))
  await Bun.write(
    path.join(workspaceRoot, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: ['pkg-a'] }),
  )
  await Bun.write(path.join(workspaceRoot, 'pkg-a/package.json'), JSON.stringify({ name: 'pkg-a' }))
  await Bun.write(
    path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
    `export default { tasks: { hello: { exec: { command: 'echo hi' } } } }`,
  )
  return { workspaceRoot, cleanup: () => rmSync(workspaceRoot, { recursive: true, force: true }) }
}

describe('Plugin API — end-to-end via run()', () => {
  it('plugins declared in vx.workspace.ts receive lifecycle events from a real run', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      // The captured-events array is a module-level box the plugin pushes to.
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource(
          [
            pluginSource(
              'org/test',
              `{ setup(ctx) {
               ctx.on('onRunStart', () => globalThis.__vxPluginEvents.push('run:start'))
               ctx.on('onTaskComplete', (n) => globalThis.__vxPluginEvents.push('done:' + n.id))
               ctx.on('onRunEnd', () => globalThis.__vxPluginEvents.push('run:end'))
             },
           }`,
            ),
          ],
          `globalThis.__vxPluginEvents = []
`,
        ),
      )
      gitInitCommit(workspaceRoot)
      const log = makeSilentLogger()
      const summary = await run({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['hello'],
        log,
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      const events = (globalThis as unknown as { __vxPluginEvents: string[] }).__vxPluginEvents
      expect(events[0]).toBe('run:start')
      expect(events).toContain('done:pkg-a#hello')
      expect(events.at(-1)).toBe('run:end')
    } finally {
      cleanup()
    }
  })

  it('invokes each plugin teardown() and each telemetry sink flush() exactly once at end-of-run', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource(
          [
            pluginSource(
              'org/lifecycle',
              `{ telemetry() {
               return {
                 onRecord() {},
                 async flush() { globalThis.__vxLifecycle.flush++ },
               }
             },
             async teardown() { globalThis.__vxLifecycle.teardown++ },
           }`,
            ),
          ],
          `globalThis.__vxLifecycle = { teardown: 0, flush: 0 }
`,
        ),
      )
      gitInitCommit(workspaceRoot)
      const summary = await run({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['hello'],
        log: makeSilentLogger(),
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      const counts = (
        globalThis as unknown as { __vxLifecycle: { teardown: number; flush: number } }
      ).__vxLifecycle
      expect(counts.teardown).toBe(1)
      expect(counts.flush).toBe(1)
    } finally {
      cleanup()
    }
  })

  it('a throwing teardown() is logged, never fails the run', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource(
          [
            pluginSource(
              'org/bad-teardown',
              `{ setup() {},
             teardown() {
               globalThis.__vxTeardownCalls++
               throw new Error('teardown boom')
             },
           }`,
            ),
          ],
          `globalThis.__vxTeardownCalls = 0
`,
        ),
      )
      gitInitCommit(workspaceRoot)
      const statusLines: string[] = []
      const log = { ...makeSilentLogger(), status: (m: string) => statusLines.push(m) }
      const summary = await run({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['hello'],
        log,
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      expect((globalThis as unknown as { __vxTeardownCalls: number }).__vxTeardownCalls).toBe(1)
      expect(
        statusLines.some((l) => l.includes('org/bad-teardown') && l.includes('teardown')),
      ).toBe(true)
    } finally {
      cleanup()
    }
  })

  // `setup` is not a guard over the whole pipeline: the config, project,
  // cache, graph, key and schedule stages have run by the time it is
  // called, and a plan never calls it. It does precede every executor,
  // every telemetry sink, admission and the first task.
  it('setup runs after the planning stages and before the executor, telemetry and the first task', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      const mark = (name: string) => `${name}() { globalThis.__vxOrder.push('${name}') },`
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource(
          [
            pluginSource(
              'org/order',
              `{ ${['config', 'project', 'cache', 'graph', 'key', 'schedule', 'executor', 'telemetry'].map(mark).join('\n')}
             admit() { globalThis.__vxOrder.push('admit'); return true },
             setup(ctx) {
               globalThis.__vxOrder.push('setup')
               ctx.on('onTaskStart', () => globalThis.__vxOrder.push('task:start'))
             },
           }`,
            ),
          ],
          `globalThis.__vxOrder = []
`,
        ),
      )
      gitInitCommit(workspaceRoot)
      const order = () => (globalThis as unknown as { __vxOrder: string[] }).__vxOrder
      const opts = {
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['hello'],
        log: makeSilentLogger(),
      }
      await planRun(opts)
      expect(order()).not.toContain('setup')
      expect(order()).toContain('schedule')
      order().length = 0
      const summary = await run({ ...opts, handleSignals: false })
      expect(summary.ok).toBe(true)
      expect(order()).toEqual([
        'config',
        'project',
        'cache',
        'graph',
        'key',
        'schedule',
        'setup',
        'executor',
        'telemetry',
        'admit',
        'task:start',
      ])
    } finally {
      cleanup()
    }
  })

  it('a plugin setup() throw aborts the run with a clean UserError', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource([
          pluginSource(
            'org/bad',
            `{ setup() { throw new Error('boom') },
           }`,
          ),
        ]),
      )
      gitInitCommit(workspaceRoot)
      const log = makeSilentLogger()
      await expect(
        run({
          cwd: workspaceRoot,
          projects: ['pkg-a'],
          tasks: ['hello'],
          log,
          handleSignals: false,
        }),
      ).rejects.toThrow(/org\/bad/)
    } finally {
      cleanup()
    }
  })
})

function makeSilentLogger() {
  return {
    runStart: () => undefined,
    taskStart: () => undefined,
    taskStdout: () => undefined,
    taskStderr: () => undefined,
    taskComplete: () => undefined,
    runStatus: () => undefined,
    runEnd: () => undefined,
    status: () => undefined,
  }
}
