// The end-of-run plugin lifecycle, and what a broken plugin is TOLD about.
//
// `teardownPlugins` owns each plugin's last chance to release what it holds,
// so what it does when that chance is missed is the whole contract.
//
// The rule these pin: a dropped result must be REPORTED. `settleWithin`'s own
// docstring says it returns false "when the deadline won — the caller decides
// whether a lost result is worth reporting", and the telemetry host warns
// "buffered records lost" for a flush that never settles. A silent drop here
// would make two siblings disagree about the same failure.
//
// Several tests are deliberate CONTROLS that must pass both before and after
// any change to the reporting: the bound must stay real, telemetry must flush
// before any teardown, and a healthy plugin must never be penalised for a
// broken neighbour.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { gitInitCommit } from './helpers/workspace.js'
import { teardownPlugins } from '../src/orchestrator/plugin-host.js'
import { run, type Logger } from '../src/index.js'
import { createEventBus } from '../src/orchestrator/index.js'
import { pluginSource, testPlugin } from './helpers/plugin.js'

/** Short enough that a hung plugin does not hold the suite for 3s. */
const BOUND_MS = 120

let prevBound: string | undefined

beforeEach(() => {
  prevBound = process.env['VX_TEARDOWN_TIMEOUT_MS']
  process.env['VX_TEARDOWN_TIMEOUT_MS'] = String(BOUND_MS)
})

afterEach(() => {
  if (prevBound === undefined) delete process.env['VX_TEARDOWN_TIMEOUT_MS']
  else process.env['VX_TEARDOWN_TIMEOUT_MS'] = prevBound
})

const never = (): Promise<void> => new Promise<void>(() => {})

describe('teardownPlugins — a dropped result is reported', () => {
  it('a teardown that never settles is named, not silently dropped', async () => {
    const warnings: string[] = []
    await teardownPlugins([testPlugin('org/hung-teardown', { teardown: never })], (m) =>
      warnings.push(m),
    )
    expect(warnings.join('\n')).toContain('org/hung-teardown')
    expect(warnings.join('\n')).toMatch(/timed out/i)
  })

  it('a teardown that rejects is reported (and always was)', async () => {
    const warnings: string[] = []
    await teardownPlugins(
      [
        testPlugin('org/bad-teardown', {
          teardown: () => {
            throw new Error('teardown boom')
          },
        }),
      ],
      (m) => warnings.push(m),
    )
    expect(warnings.join('\n')).toContain('org/bad-teardown')
    expect(warnings.join('\n')).toContain('teardown boom')
  })

  // CONTROL. The bound must stay REAL. Reporting a timeout is worthless if the
  // call that timed out still holds the run's exit: bin.ts is
  // `process.exit(await run(...))`, so an unbounded await drains the event loop
  // with no exit code pending and a failed run reports green.
  it('the bound is real — a hung teardown returns, it does not hold the run', async () => {
    const started = Date.now()
    await teardownPlugins([testPlugin('org/hung', { teardown: never })], () => {})
    const elapsed = Date.now() - started
    // Generous upper bound: this asserts "bounded", not a precise deadline,
    // so it cannot flake on a loaded box.
    expect(elapsed).toBeLessThan(BOUND_MS * 12)
  })

  // CONTROL: a broken neighbour must not cost a healthy plugin its teardown.
  it('a hung plugin does not stop the next plugin from tearing down', async () => {
    let healthyTornDown = false
    await teardownPlugins(
      [
        testPlugin('org/hung', { teardown: never }),
        testPlugin('org/healthy', { teardown: () => void (healthyTornDown = true) }),
      ],
      () => {},
    )
    expect(healthyTornDown).toBe(true)
  })

  it("the bound is PER PLUGIN: a hung neighbour does not spend a slow one's budget", async () => {
    // The row above proves the next plugin is still ASKED. This one proves
    // it is still given the whole deadline: the bound is read inside the
    // loop, so the worst case is plugins × bound (the docstring's
    // 3.0/6.0/9.0s), deliberately, rather than one budget the first hung
    // plugin drains. Sharing it would report a plugin that tore down
    // perfectly well as having timed out — a warning about the wrong
    // plugin, which is worse than no warning.
    const warnings: string[] = []
    await teardownPlugins(
      [
        testPlugin('org/hung', { teardown: never }),
        // Comfortably inside its own bound (120 ms) and far outside what a
        // shared budget would leave after the hung plugin drained it.
        testPlugin('org/slow', { teardown: () => Bun.sleep(20) }),
      ],
      (m) => warnings.push(m),
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('org/hung')
  })

  // CONTROL: the common shape — plugins that declare no teardown.
  it('plugins with no teardown are skipped silently', async () => {
    const warnings: string[] = []
    await teardownPlugins([{ name: 'org/plain' }], (m) => warnings.push(m))
    expect(warnings).toEqual([])
  })
})

describe('the lifecycle is reached on a run that FAILED', () => {
  let root: string

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'vx-plugin-teardown-'))
    await Bun.write(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['a'] }),
    )
    await Bun.write(path.join(root, 'a/package.json'), JSON.stringify({ name: 'a' }))
    await Bun.write(
      path.join(root, 'a/vx.config.mjs'),
      `export default { tasks: { boom: { exec: { command: 'exit 7' } } } }`,
    )
    gitInitCommit(root, 'i')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  // A failed run is precisely the one whose records you most want shipped, so
  // "flush only happens when everything went well" would be the worst possible
  // shape. It does not — pinned here so it stays that way.
  it('a failing task still flushes sinks and tears plugins down', async () => {
    await Bun.write(
      path.join(root, 'vx.workspace.mjs'),
      localWorkspaceSource(
        [
          pluginSource(
            'org/probe',
            `{ telemetry() { return { onRecord(){}, async flush() { globalThis.__vxLifecycle.push('flush') } } },
         teardown() { globalThis.__vxLifecycle.push('teardown') },
       }`,
          ),
        ],
        `globalThis.__vxLifecycle = []
`,
      ),
    )
    const silent = {
      runStart: () => undefined,
      taskStart: () => undefined,
      taskStdout: () => undefined,
      taskStderr: () => undefined,
      taskComplete: () => undefined,
      runStatus: () => undefined,
      runEnd: () => undefined,
      status: () => undefined,
    }
    const summary = await run({
      cwd: root,
      projects: ['a'],
      tasks: ['boom'],
      log: silent,
      handleSignals: false,
    })
    expect(summary.ok).toBe(false)
    const seen = (globalThis as unknown as { __vxLifecycle: string[] }).__vxLifecycle
    expect(seen).toEqual(['flush', 'teardown'])
  })
})

// `RunOptions.bus` is the surface seam: an embedder's bus outlives the run
// it is handed to. Everything run() subscribes on it — the terminal
// renderer, a plugin's setup subscription, the telemetry source — must
// leave with the run, or the next run on the same bus reports every event
// once per run so far. The finally-path disposers are that contract's
// second half; item 635 swept them.
describe('an injected bus outlives the run: what a run subscribed leaves with it', () => {
  let root: string
  const silent: Logger = {
    runStart: () => undefined,
    taskStart: () => undefined,
    taskStdout: () => undefined,
    taskStderr: () => undefined,
    taskComplete: () => undefined,
    runEnd: () => undefined,
    status: () => undefined,
  }

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'vx-plugin-bus-'))
    await Bun.write(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['a'] }),
    )
    await Bun.write(path.join(root, 'a/package.json'), JSON.stringify({ name: 'a' }))
    await Bun.write(
      path.join(root, 'a/vx.config.mjs'),
      `export default { tasks: { hello: { exec: { command: 'echo hello' } } } }`,
    )
    await Bun.write(
      path.join(root, 'vx.workspace.mjs'),
      localWorkspaceSource(
        [
          pluginSource(
            'org/counting',
            `{ setup(ctx) { ctx.bus.subscribe(() => { globalThis.__vxBusSeen.plugin++ }) },
         telemetry() { return { onRecord() { globalThis.__vxBusSeen.telemetry++ }, async flush() {} } },
       }`,
          ),
        ],
        `globalThis.__vxBusSeen = { plugin: 0, telemetry: 0 }
`,
      ),
    )
    gitInitCommit(root, 'i')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const seen = (): { plugin: number; telemetry: number } =>
    (globalThis as unknown as { __vxBusSeen: { plugin: number; telemetry: number } }).__vxBusSeen

  it("a plugin's setup subscription and its telemetry sink hear one run each", async () => {
    const bus = createEventBus()
    const opts = {
      cwd: root,
      projects: ['a'],
      tasks: ['hello'],
      log: silent,
      handleSignals: false,
      bus,
    }
    expect((await run(opts)).ok).toBe(true)
    const first = { ...seen() }
    expect(first.plugin).toBeGreaterThan(0)
    expect(first.telemetry).toBeGreaterThan(0)

    seen().plugin = 0
    seen().telemetry = 0
    expect((await run(opts)).ok).toBe(true)
    // A subscription the first run left behind would hear this run too,
    // and the counts would read double.
    expect(seen()).toEqual(first)
  })

  it('the terminal renderer hears one run', async () => {
    const bus = createEventBus()
    let completes = 0
    const counting: Logger = {
      ...silent,
      taskComplete: () => {
        completes++
      },
    }
    const opts = {
      cwd: root,
      projects: ['a'],
      tasks: ['hello'],
      log: counting,
      handleSignals: false,
      bus,
    }
    expect((await run(opts)).ok).toBe(true)
    expect(completes).toBe(1)
    expect((await run(opts)).ok).toBe(true)
    expect(completes).toBe(2)
  })
})
