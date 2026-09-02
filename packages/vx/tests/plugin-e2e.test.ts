// End-to-end plugin integration: a workspace declares plugins in
// vx.workspace.ts; run() loads them, installs lifecycle hooks, and
// fires them in order across a real run.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { run } from '../src/index.js'

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

async function gitInit(dir: string): Promise<void> {
  await Bun.spawn(['git', 'init', '-q'], { cwd: dir }).exited
  await Bun.spawn(['git', 'add', '-A'], { cwd: dir }).exited
  await Bun.spawn(
    [
      'git',
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      'init',
    ],
    { cwd: dir },
  ).exited
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
            `{
             name: 'org/test',
             setup(ctx) {
               ctx.on('onRunStart', () => globalThis.__vxPluginEvents.push('run:start'))
               ctx.on('onTaskComplete', (n) => globalThis.__vxPluginEvents.push('done:' + n.id))
               ctx.on('onRunEnd', () => globalThis.__vxPluginEvents.push('run:end'))
             },
           }`,
          ],
          `globalThis.__vxPluginEvents = []
`,
        ),
      )
      await gitInit(workspaceRoot)
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
            `{
             name: 'org/lifecycle',
             telemetry() {
               return {
                 onRecord() {},
                 async flush() { globalThis.__vxLifecycle.flush++ },
               }
             },
             async teardown() { globalThis.__vxLifecycle.teardown++ },
           }`,
          ],
          `globalThis.__vxLifecycle = { teardown: 0, flush: 0 }
`,
        ),
      )
      await gitInit(workspaceRoot)
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
            `{
             name: 'org/bad-teardown',
             setup() {},
             teardown() {
               globalThis.__vxTeardownCalls++
               throw new Error('teardown boom')
             },
           }`,
          ],
          `globalThis.__vxTeardownCalls = 0
`,
        ),
      )
      await gitInit(workspaceRoot)
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

  it('a plugin setup() throw aborts the run with a clean UserError', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource([
          `{
             name: 'org/bad',
             setup() { throw new Error('boom') },
           }`,
        ]),
      )
      await gitInit(workspaceRoot)
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
