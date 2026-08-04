// The end-of-run plugin lifecycle, and what a broken plugin is TOLD about.
//
// `teardownPlugins` is the one plugin-host export with no test of its own —
// and it is the function this repo already shipped once as documented API core
// never called (decision log, 2026-07-02). It owns the last chance a sink gets
// to ship buffered records, so what it does when that chance is missed is the
// whole contract.
//
// The rule these pin: a dropped result must be REPORTED. `settleWithin`'s own
// docstring says it returns false "when the deadline won — the caller decides
// whether a lost result is worth reporting", and the documented sibling in
// telemetry.ts (bounded, per its comment, "for the same reason the `eventSink`
// sibling is bounded in plugin-host.ts") warns "buffered records lost". A
// silent drop here would make two siblings disagree about the same failure.
//
// Several tests are deliberate CONTROLS that must pass both before and after
// any change to the reporting: the bound must stay real, the flush-then-
// teardown ordering must hold, and a healthy plugin must never be penalised
// for a broken neighbour.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { subscribeEventSinks, teardownPlugins } from '../src/orchestrator/plugin-host.js'
import { busLogger, createEventBus } from '../src/orchestrator/events.js'
import type { EventSink, VxPlugin } from '../src/orchestrator/plugin.js'
import { run } from '../src/index.js'

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

function sink(over: Partial<EventSink> = {}): EventSink {
  return { onEvent: () => undefined, ...over }
}

describe('teardownPlugins — a dropped result is reported', () => {
  it('a flush that never settles is named, not silently dropped', async () => {
    const warnings: string[] = []
    await teardownPlugins(
      [],
      [{ pluginName: 'org/hung-flush', sink: sink({ flush: never }) }],
      (m) => warnings.push(m),
    )
    // The plugin must be named — "something timed out" is not actionable when
    // several plugins are declared.
    expect(warnings.join('\n')).toContain('org/hung-flush')
    // And it must say what was LOST. A flush is a sink's last chance to ship
    // buffered records; a timeout means those records are gone.
    expect(warnings.join('\n')).toMatch(/timed out|lost/i)
  })

  it('a teardown that never settles is named, not silently dropped', async () => {
    const warnings: string[] = []
    await teardownPlugins([{ name: 'org/hung-teardown', teardown: never }], [], (m) =>
      warnings.push(m),
    )
    expect(warnings.join('\n')).toContain('org/hung-teardown')
    expect(warnings.join('\n')).toMatch(/timed out/i)
  })

  // CONTROL. This passed before the reporting existed and must keep passing:
  // a REJECTING flush was always reported. It is the contrast that makes the
  // two above defects rather than a missing feature — the same function spoke
  // for one failure mode and stayed silent for the other.
  it('a flush that rejects is reported (and always was)', async () => {
    const warnings: string[] = []
    await teardownPlugins(
      [],
      [
        {
          pluginName: 'org/bad-flush',
          sink: sink({
            flush: () => {
              throw new Error('flush boom')
            },
          }),
        },
      ],
      (m) => warnings.push(m),
    )
    expect(warnings.join('\n')).toContain('org/bad-flush')
    expect(warnings.join('\n')).toContain('flush boom')
  })

  it('a teardown that rejects is reported (and always was)', async () => {
    const warnings: string[] = []
    await teardownPlugins(
      [
        {
          name: 'org/bad-teardown',
          teardown: () => {
            throw new Error('teardown boom')
          },
        },
      ],
      [],
      (m) => warnings.push(m),
    )
    expect(warnings.join('\n')).toContain('org/bad-teardown')
    expect(warnings.join('\n')).toContain('teardown boom')
  })

  // CONTROL. The bound must stay REAL. Reporting a timeout is worthless if the
  // call that timed out still holds the run's exit: bin.ts is
  // `process.exit(await run(...))`, so an unbounded await drains the event loop
  // with no exit code pending and a failed run reports green.
  it('the bound is real — a hung flush returns, it does not hold the run', async () => {
    const started = Date.now()
    await teardownPlugins([], [{ pluginName: 'org/hung', sink: sink({ flush: never }) }], () => {})
    const elapsed = Date.now() - started
    // Generous upper bound: this asserts "bounded", not a precise deadline,
    // so it cannot flake on a loaded box.
    expect(elapsed).toBeLessThan(BOUND_MS * 12)
  })

  // CONTROL, and load-bearing: a plugin's teardown may close the very thing
  // its sink's flush writes through, so every flush must complete before any
  // teardown begins.
  it('every flush runs before any teardown', async () => {
    const order: string[] = []
    const plugins: VxPlugin[] = [
      { name: 'p1', teardown: () => void order.push('teardown:p1') },
      { name: 'p2', teardown: () => void order.push('teardown:p2') },
    ]
    const sinks = [
      { pluginName: 'p1', sink: sink({ flush: async () => void order.push('flush:p1') }) },
      { pluginName: 'p2', sink: sink({ flush: async () => void order.push('flush:p2') }) },
    ]
    await teardownPlugins(plugins, sinks, () => {})
    expect(order.indexOf('flush:p1')).toBeLessThan(order.indexOf('teardown:p1'))
    expect(order.indexOf('flush:p2')).toBeLessThan(order.indexOf('teardown:p1'))
    expect(order.indexOf('flush:p2')).toBeLessThan(order.indexOf('teardown:p2'))
  })

  // CONTROL: a broken neighbour must not cost a healthy plugin its teardown.
  it('a hung plugin does not stop the next plugin from tearing down', async () => {
    let healthyTornDown = false
    await teardownPlugins(
      [
        { name: 'org/hung', teardown: never },
        { name: 'org/healthy', teardown: () => void (healthyTornDown = true) },
      ],
      [],
      () => {},
    )
    expect(healthyTornDown).toBe(true)
  })

  // CONTROL: the common shape — plugins that declare neither hook.
  it('plugins with no flush or teardown are skipped silently', async () => {
    const warnings: string[] = []
    await teardownPlugins(
      [{ name: 'org/plain' }],
      [{ pluginName: 'org/plain', sink: sink() }],
      (m) => warnings.push(m),
    )
    expect(warnings).toEqual([])
  })
})

describe('subscribeEventSinks — a sink that keeps throwing', () => {
  it('is disabled after its first throw instead of being called forever', async () => {
    const bus = createEventBus()
    let calls = 0
    const plugins: VxPlugin[] = [
      {
        name: 'org/always-throws',
        eventSink: () => ({
          onEvent: () => {
            calls++
            throw new Error('boom')
          },
        }),
      },
    ]
    const warnings: string[] = []
    const sub = await subscribeEventSinks(plugins, bus, {
      workspaceRoot: '/ws',
      cacheDir: '/ws/.vx/cache',
      warn: (m) => warnings.push(m),
    })
    const log = busLogger(bus)
    log.runStart?.({ total: 1 })
    for (let i = 0; i < 50; i++) log.status?.(`line ${i}`)
    log.runEnd?.()
    sub.dispose()

    // The telemetry source disables a sink the first time it throws. This is
    // the same seam for the same reason: a sink that throws once is broken,
    // and re-entering it for every remaining event of the run burns work to
    // reach an identical throw.
    expect(calls).toBe(1)
    // And the operator is told once, by name. Silently swallowing every throw
    // satisfies "observability must never break a run" while leaving the user
    // with no way to learn their sink never ran.
    expect(warnings.filter((w) => w.includes('org/always-throws'))).toHaveLength(1)
  })

  // CONTROL: isolation still holds — a broken sink must not cost a healthy one
  // its events, and must never propagate into the run.
  it('a healthy sibling sink keeps receiving events', async () => {
    const bus = createEventBus()
    const good: string[] = []
    const plugins: VxPlugin[] = [
      {
        name: 'org/bad',
        eventSink: () => ({
          onEvent: () => {
            throw new Error('boom')
          },
        }),
      },
      { name: 'org/good', eventSink: () => ({ onEvent: (e) => good.push(e.kind) }) },
    ]
    const sub = await subscribeEventSinks(plugins, bus, {
      workspaceRoot: '/ws',
      cacheDir: '/ws/.vx/cache',
      warn: () => undefined,
    })
    const log = busLogger(bus)
    expect(() => log.runStart?.({ total: 1 })).not.toThrow()
    expect(() => log.runEnd?.()).not.toThrow()
    sub.dispose()
    expect(good).toContain('run:start')
    expect(good).toContain('run:end')
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
    for (const c of [
      ['init', '-q'],
      ['add', '-A'],
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'i'],
    ]) {
      await Bun.spawn(['git', ...c], { cwd: root }).exited
    }
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
      `globalThis.__vxLifecycle = []
       export default { plugins: [{
         name: 'org/probe',
         eventSink() { return { onEvent(){}, flush() { globalThis.__vxLifecycle.push('flush') } } },
         teardown() { globalThis.__vxLifecycle.push('teardown') },
       }] }`,
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
