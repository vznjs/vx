// End-of-run telemetry lifecycle — the surface where "observability must
// never break a run" is actually load-bearing. Each case here pins a defect
// that shipped: an unbounded flush, a task set that disagreed with the
// terminal, a malformed sink aborting the run, and the zero-cost gate.

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { localWorkspaceSource, writeLocalWorkspace } from './helpers/local-workspace.js'
import {
  createTelemetrySource,
  subscribeTelemetry,
  type RunContextRecord,
  type RunSummaryRecord,
  type TelemetryContext,
  type TelemetrySink,
  type VxPlugin,
} from '../src/orchestrator/index.js'
import { createEventBus } from '../src/orchestrator/events.js'
import { run } from '../src/index.js'

const RUN: RunContextRecord = {
  runId: 'run-1',
  vxVersion: '0.0.0',
  workspaceId: 'ws',
  workspaceName: 'ws',
  command: 'vx run build',
  requestedTasks: ['build'],
  cachePolicy: 'lR,lW,rR,rW',
  concurrency: 4,
  flow: 'focused',
  commitSha: null,
  branch: null,
  defaultBranch: null,
  dirty: null,
  ci: false,
  ciProvider: null,
  host: null,
  os: 'linux',
  arch: 'x64',
  tags: {},
}

function silentLogger() {
  return {
    runStart: () => undefined,
    taskStart: () => undefined,
    taskStdout: () => undefined,
    taskStderr: () => undefined,
    taskComplete: () => undefined,
    runEnd: () => undefined,
    status: () => undefined,
  }
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

const tmpDirs: string[] = []
function workspace(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env['VX_TEARDOWN_TIMEOUT_MS']
})

describe('telemetry flush is time-bounded', () => {
  it('a sink whose flush never settles does not hang the run', async () => {
    // Without the deadline this test hangs to its own timeout rather than
    // failing — which is exactly the production symptom: run() never returns,
    // Bun drains an empty loop, and `process.exit(await run(...))` exits 0 on
    // a run that failed.
    process.env['VX_TEARDOWN_TIMEOUT_MS'] = '250'
    const warnings: string[] = []
    const wedged: TelemetrySink = { flush: () => new Promise<void>(() => {}) }
    const source = createTelemetrySource({
      sinks: [wedged],
      run: RUN,
      warn: (m) => warnings.push(m),
    })
    const started = Date.now()
    await source.flush()
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(5000)
    expect(elapsed).toBeGreaterThanOrEqual(200)
    expect(warnings.join('\n')).toContain('telemetry flush timed out')
  }, 15_000)

  it('a healthy sink still completes its flush, and no timeout is reported', async () => {
    process.env['VX_TEARDOWN_TIMEOUT_MS'] = '2000'
    const warnings: string[] = []
    let flushed = false
    const source = createTelemetrySource({
      sinks: [
        {
          flush: async () => {
            await Bun.sleep(10)
            flushed = true
          },
        },
      ],
      run: RUN,
      warn: (m) => warnings.push(m),
    })
    await source.flush()
    expect(flushed).toBe(true)
    expect(warnings).toEqual([])
  })

  it('one wedged sink does not rob a healthy sibling of its budget', async () => {
    process.env['VX_TEARDOWN_TIMEOUT_MS'] = '500'
    let flushed = false
    const source = createTelemetrySource({
      sinks: [
        { flush: () => new Promise<void>(() => {}) },
        {
          flush: async () => {
            await Bun.sleep(50)
            flushed = true
          },
        },
      ],
      run: RUN,
    })
    await source.flush()
    expect(flushed).toBe(true)
  })

  it('a failing run with a wedged telemetry sink still exits non-zero', async () => {
    process.env['VX_TEARDOWN_TIMEOUT_MS'] = '250'
    const root = workspace('vx-tel-hang-')
    await Bun.write(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['pkg-a'] }),
    )
    await writeLocalWorkspace(root)
    await Bun.write(path.join(root, 'pkg-a/package.json'), JSON.stringify({ name: 'pkg-a' }))
    await Bun.write(
      path.join(root, 'pkg-a/vx.config.mjs'),
      `export default { tasks: { boom: { exec: { command: 'exit 3' } } } }`,
    )
    await Bun.write(
      path.join(root, 'vx.workspace.mjs'),
      localWorkspaceSource([
        `{ name: 'org/hang',
         telemetry() { return { flush() { return new Promise(() => {}) } } } }`,
      ]),
    )
    await gitInit(root)
    const summary = await run({
      cwd: root,
      projects: ['pkg-a'],
      tasks: ['boom'],
      log: silentLogger(),
      handleSignals: false,
    })
    expect(summary.ok).toBe(false)
  }, 30_000)
})

describe('the telemetry task set matches what the terminal reports', () => {
  async function summaryOf(root: string, task: string): Promise<RunSummaryRecord> {
    let captured: RunSummaryRecord | undefined
    await run({
      cwd: root,
      projects: ['pkg-a'],
      tasks: [task],
      log: silentLogger(),
      handleSignals: false,
      telemetrySinks: [{ onRunSummary: (s) => (captured = s) }],
    })
    expect(captured).toBeDefined()
    return captured!
  }

  async function fixture(): Promise<string> {
    const root = workspace('vx-tel-set-')
    await Bun.write(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['pkg-a'] }),
    )
    await writeLocalWorkspace(root)
    await Bun.write(path.join(root, 'pkg-a/package.json'), JSON.stringify({ name: 'pkg-a' }))
    await Bun.write(
      path.join(root, 'pkg-a/vx.config.mjs'),
      `export default { tasks: {
         base: { exec: { command: 'exit 5' } },
         dependent: { exec: { command: 'echo never' }, dependsOn: ['base'] },
         dev: { exec: { command: 'exit 7', persistent: { readyWhen: 'NEVER-MATCHES' } } },
       } }`,
    )
    await gitInit(root)
    return root
  }

  it('counts a skipped dependent — it has no cache hash but the terminal counts it', async () => {
    const s = await summaryOf(await fixture(), 'dependent')
    expect(s.taskCount).toBe(2)
    expect(s.failedCount).toBe(1)
    expect(s.tasks.map((t) => t.status).sort()).toEqual(['failed', 'skipped'])
    expect(s.exitOk).toBe(false)
  }, 30_000)

  it('counts a persistent task that failed to become ready', async () => {
    // The worst shape of the old filter: a red run ingested as `0 tasks,
    // 0 failures` is invisible to every failure/regression surface.
    const s = await summaryOf(await fixture(), 'dev')
    expect(s.taskCount).toBe(1)
    expect(s.failedCount).toBe(1)
    expect(s.exitOk).toBe(false)
  }, 30_000)

  it('still excludes group tasks — the filter the distributed controller also applies', async () => {
    const root = workspace('vx-tel-grp-')
    await Bun.write(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['pkg-a'] }),
    )
    await writeLocalWorkspace(root)
    await Bun.write(path.join(root, 'pkg-a/package.json'), JSON.stringify({ name: 'pkg-a' }))
    await Bun.write(
      path.join(root, 'pkg-a/vx.config.mjs'),
      `export default { tasks: {
         hi: { exec: { command: 'true' } },
         grp: { dependsOn: ['hi'] },
       } }`,
    )
    await gitInit(root)
    const s = await summaryOf(root, 'grp')
    expect(s.taskCount).toBe(1)
    expect(s.tasks[0]!.task).toBe('hi')
  }, 30_000)
})

describe('a malformed telemetry() return is rejected at the boundary', () => {
  const ctx: TelemetryContext = {
    workspaceRoot: '/tmp',
    cacheDir: '/tmp/cache',
    warn: () => undefined,
  }

  async function subscribeWith(result: unknown): Promise<{ handle: unknown; warnings: string[] }> {
    const warnings: string[] = []
    const plugin = { name: 'org/bad', telemetry: () => result } as unknown as VxPlugin
    const handle = await subscribeTelemetry(
      [plugin],
      createEventBus(),
      { ...ctx, warn: (m) => warnings.push(m) },
      RUN,
    )
    return { handle, warnings }
  }

  for (const [label, value] of [
    ['null', null],
    ['[null]', [null]],
    ['[undefined]', [undefined]],
    ['a non-array wants', { wants: 5 }],
  ] as const) {
    it(`skips the plugin and warns for ${label}`, async () => {
      const { handle, warnings } = await subscribeWith(value)
      expect(handle).toBeUndefined()
      expect(warnings.join('\n')).toContain("plugin 'org/bad'")
    })
  }

  it('catches a throwing `wants` getter', async () => {
    const { handle, warnings } = await subscribeWith({
      get wants() {
        throw new Error('boom')
      },
    })
    expect(handle).toBeUndefined()
    expect(warnings.join('\n')).toContain('boom')
  })

  it('is all-or-nothing: a good sink beside a bad one in one array is dropped too', async () => {
    const { handle } = await subscribeWith([{ onRunSummary: () => undefined }, null])
    expect(handle).toBeUndefined()
  })

  it('a well-formed sink is still accepted', async () => {
    const { handle, warnings } = await subscribeWith({ onRunSummary: () => undefined })
    expect(handle).toBeDefined()
    expect(warnings).toEqual([])
  })

  it('a malformed sink does not stop the run — the tasks still execute', async () => {
    const root = workspace('vx-tel-bad-')
    await Bun.write(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['pkg-a'] }),
    )
    await writeLocalWorkspace(root)
    await Bun.write(path.join(root, 'pkg-a/package.json'), JSON.stringify({ name: 'pkg-a' }))
    await Bun.write(
      path.join(root, 'pkg-a/vx.config.mjs'),
      `export default { tasks: { hi: { exec: { command: 'true' } } } }`,
    )
    await Bun.write(
      path.join(root, 'vx.workspace.mjs'),
      localWorkspaceSource([`{ name: 'org/bad', telemetry() { return null } }`]),
    )
    await gitInit(root)
    const summary = await run({
      cwd: root,
      projects: ['pkg-a'],
      tasks: ['hi'],
      log: silentLogger(),
      handleSignals: false,
    })
    expect(summary.ok).toBe(true)
  }, 30_000)
})

describe('the zero-cost gate keys on the telemetry capability', () => {
  async function runWith(pluginSource: string | null): Promise<string> {
    const root = workspace('vx-tel-cost-')
    await Bun.write(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['pkg-a'] }),
    )
    await writeLocalWorkspace(root)
    await Bun.write(path.join(root, 'pkg-a/package.json'), JSON.stringify({ name: 'pkg-a' }))
    await Bun.write(
      path.join(root, 'pkg-a/vx.config.mjs'),
      `export default { tasks: { hi: { exec: { command: 'true' } } } }`,
    )
    if (pluginSource !== null) {
      await Bun.write(path.join(root, 'vx.workspace.mjs'), pluginSource)
    }
    await gitInit(root)
    await run({
      cwd: root,
      projects: ['pkg-a'],
      tasks: ['hi'],
      log: silentLogger(),
      handleSignals: false,
    })
    return root
  }

  // `.vx/workspace-id` is written by captureWorkspaceIdentity, which only
  // runs when the run context is built — a cheap, exact proxy for "did this
  // run pay the telemetry-context cost?" on a remote-less fixture repo.
  const idFile = (root: string) => existsSync(path.join(root, '.vx', 'workspace-id'))

  it('a backend-only plugin pays nothing', async () => {
    const root = await runWith(
      localWorkspaceSource([`{ name: 'org/be', backend() { return undefined } }`]),
    )
    expect(idFile(root)).toBe(false)
  }, 30_000)

  it('no plugin beyond the local executor + cache pays nothing', async () => {
    expect(idFile(await runWith(null))).toBe(false)
  }, 30_000)

  it('a plugin declaring telemetry() pays, even when it declines', async () => {
    // Declining is only knowable by asking, so this cost is irreducible —
    // the gate is about plugins with no telemetry hook at all.
    const root = await runWith(
      localWorkspaceSource([`{ name: 'org/tel', telemetry() { return undefined } }`]),
    )
    expect(idFile(root)).toBe(true)
  }, 30_000)
})
