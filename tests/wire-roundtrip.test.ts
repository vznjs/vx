// Round-trip tests for `wireForwarder` → `createWireRenderer`.
//
// These two functions are documented as INVERSES, and the property they exist
// to guarantee is stated in wire-render.ts's own header: "a DELEGATED run
// renders identically to a local one". `tests/events.test.ts` covers the
// producer and `tests/wire-render.test.ts` covers the consumer, but nothing
// drives them TOGETHER — so a change to either side can break the pairing
// while both files stay green.
//
// That is not a hypothetical failure mode here. The 2026-07-27 telemetry audit
// found exactly this shape: the renderer resolves a completion's node from the
// `task:start` it recorded, but the scheduler finishes a SKIPPED task without
// ever calling `onStart`, so a skip arrived as a completion with no start and
// the renderer's `if (node)` guard swallowed it — while the forwarded footer
// still counted it. A delegated run silently rendered fewer tasks than it
// reported. The fix went in on the PRODUCER side (the forwarder synthesizes
// the missing start), which means neither side's own tests can see it and only
// a round-trip can.
//
// The comparison below is run through both paths from ONE event sequence:
//   local     — terminalSubscriber(sink), the in-process renderer
//   delegated — wireForwarder → createWireRenderer(sink), across the wire
// and asserts the sink saw the same thing, except for three asymmetries that
// are deliberate and are each pinned as such.

import { describe, expect, it } from 'bun:test'
import {
  createEventBus,
  terminalSubscriber,
  wireForwarder,
  type RunEvent,
  type WireEvent,
} from '../src/orchestrator/events.js'
import { createWireRenderer } from '../src/orchestrator/wire-render.js'
import type { Logger } from '../src/orchestrator/logger.js'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'

/**
 * What a renderer actually reads off a node/outcome. Recording only these
 * makes the comparison meaningful: the wire form is a PROJECTION, so the
 * reconstructed node is deliberately not deep-equal to the live one (it has no
 * dep graph and no full config). Comparing whole objects would fail for
 * reasons that do not matter; comparing read fields is the real contract.
 */
type Call =
  | { c: 'runStart'; total: number }
  | { c: 'taskStart'; id: string; isGroup: boolean; command: string; requested: boolean }
  | { c: 'stdout'; id: string; chunk: string }
  | { c: 'stderr'; id: string; chunk: string }
  | { c: 'complete'; id: string; status: string; exitCode: number; durationMs: number }
  | { c: 'status'; line: string }
  | { c: 'runEnd' }

function recorder(): { calls: Call[]; sink: Logger } {
  const calls: Call[] = []
  const sink: Logger = {
    status: (line) => void calls.push({ c: 'status', line }),
    taskStdout: (n, chunk) => void calls.push({ c: 'stdout', id: n.id, chunk }),
    taskStderr: (n, chunk) => void calls.push({ c: 'stderr', id: n.id, chunk }),
    taskComplete: (n, o) =>
      void calls.push({
        c: 'complete',
        id: n.id,
        status: o.status,
        exitCode: o.exitCode,
        durationMs: o.durationMs,
      }),
    runStart: (info) => void calls.push({ c: 'runStart', total: info.total }),
    taskStart: (n) =>
      void calls.push({
        c: 'taskStart',
        id: n.id,
        // The renderers key group-ness off `config.exec` being absent, so
        // that is what gets compared rather than a flag.
        isGroup: n.config.exec === undefined,
        command: n.config.exec?.command ?? '',
        requested: n.requested,
      }),
    runEnd: () => void calls.push({ c: 'runEnd' }),
  }
  return { calls, sink }
}

function node(id: string, over: Partial<TaskNode> = {}, isGroup = false): TaskNode {
  const [projectName, taskName] = id.split('#') as [string, string]
  return {
    id,
    projectName,
    projectDir: `/w/${projectName}`,
    taskName,
    config: isGroup ? {} : { exec: { command: `run ${taskName}` } },
    deps: [],
    requested: false,
    ...over,
  } as TaskNode
}

function outcome(n: TaskNode, over: Partial<TaskOutcome> = {}): TaskOutcome {
  return {
    node: n,
    status: 'success',
    exitCode: 0,
    durationMs: 10,
    // bigint wallclock — the reason a raw event cannot cross a wire at all.
    wallclockStartNs: 0n,
    wallclockEndNs: 10_000_000n,
    ...over,
  } as TaskOutcome
}

/** Drive one event sequence down both paths and return what each sink saw. */
function bothPaths(events: RunEvent[]): { local: Call[]; delegated: Call[]; wire: WireEvent[] } {
  const localRec = recorder()
  const delegatedRec = recorder()
  const wire: WireEvent[] = []

  const bus = createEventBus()
  bus.subscribe(terminalSubscriber(localRec.sink))
  const render = createWireRenderer(delegatedRec.sink)
  bus.subscribe(
    wireForwarder((e) => {
      wire.push(e)
      render(e)
    }),
  )

  for (const e of events) bus.emit(e)
  return { local: localRec.calls, delegated: delegatedRec.calls, wire }
}

describe('the wire round-trip preserves a normal run', () => {
  it('an executed task renders identically local and delegated', () => {
    // The core property. Everything else in this file is an exception to it.
    const build = node('pkg#build', { requested: true })
    const { local, delegated } = bothPaths([
      { kind: 'run:start', info: { total: 1 } },
      { kind: 'task:start', node: build },
      { kind: 'task:stdout', node: build, chunk: 'compiling\n' },
      { kind: 'task:stderr', node: build, chunk: 'warning: x\n' },
      { kind: 'task:complete', node: build, outcome: outcome(build) },
      { kind: 'run:status', line: 'done' },
      { kind: 'run:end' },
    ])
    expect(delegated).toEqual(local)
  })

  it('carries the fields the renderer actually reads', () => {
    // Guards the projection itself. If `command` or `requested` were dropped
    // from `TaskView`, the sequences above would still match in SHAPE while
    // every frame rendered with an empty command — so the values are asserted
    // rather than only the call order.
    const build = node('pkg#build', { requested: true })
    const { delegated } = bothPaths([
      { kind: 'task:start', node: build },
      { kind: 'task:complete', node: build, outcome: outcome(build, { durationMs: 42 }) },
    ])
    expect(delegated).toEqual([
      { c: 'taskStart', id: 'pkg#build', isGroup: false, command: 'run build', requested: true },
      { c: 'complete', id: 'pkg#build', status: 'success', exitCode: 0, durationMs: 42 },
    ])
  })

  it('preserves interleaved output ordering across many tasks', () => {
    // Ordering is part of the renderer's contract — a stdout chunk must reach
    // it before its task's completion block, because block-separator
    // bookkeeping depends on it. Concurrency means chunks from different tasks
    // interleave, so the wire must not reorder or batch them.
    const a = node('pkg#a')
    const b = node('pkg#b')
    const { local, delegated } = bothPaths([
      { kind: 'task:start', node: a },
      { kind: 'task:start', node: b },
      { kind: 'task:stdout', node: a, chunk: 'a1' },
      { kind: 'task:stdout', node: b, chunk: 'b1' },
      { kind: 'task:stdout', node: a, chunk: 'a2' },
      { kind: 'task:complete', node: b, outcome: outcome(b) },
      { kind: 'task:complete', node: a, outcome: outcome(a) },
    ])
    expect(delegated).toEqual(local)
    expect(delegated.filter((c) => c.c === 'stdout').map((c) => c.chunk)).toEqual([
      'a1',
      'b1',
      'a2',
    ])
  })

  it('a failing task carries its exit code and status across', () => {
    // The one outcome a user is guaranteed to be reading closely.
    const t = node('pkg#test')
    const { local, delegated } = bothPaths([
      { kind: 'task:start', node: t },
      { kind: 'task:complete', node: t, outcome: outcome(t, { status: 'failed', exitCode: 3 }) },
    ])
    expect(delegated).toEqual(local)
    expect(delegated.at(-1)).toMatchObject({ status: 'failed', exitCode: 3 })
  })
})

describe('the wire round-trip — the three deliberate asymmetries', () => {
  it('a SKIPPED task survives the wire, because the forwarder synthesizes its start', () => {
    // The regression this file exists for. A skip never reaches the
    // scheduler's `onStart`, so locally the renderer sees a completion with no
    // start. The renderer resolves nodes from starts, so without the
    // producer-side synthesis the task would vanish from a delegated run
    // entirely — while the footer still counted it.
    //
    // Note the delegated arm has MORE calls than the local one here. That is
    // the fix working, not a discrepancy.
    const skipped = node('pkg#lint')
    const { local, delegated } = bothPaths([
      { kind: 'task:complete', node: skipped, outcome: outcome(skipped, { status: 'skipped' }) },
    ])

    expect(local.map((c) => c.c)).toEqual(['complete'])
    expect(delegated.map((c) => c.c)).toEqual(['taskStart', 'complete'])
    // Full fidelity, not a stand-in: the synthesized start carries the real
    // node's command and requested flag because the live TaskNode is in hand
    // at the point the forwarder synthesizes it.
    expect(delegated[0]).toMatchObject({ id: 'pkg#lint', command: 'run lint', requested: false })
    expect(delegated.at(-1)).toMatchObject({ id: 'pkg#lint', status: 'skipped' })
  })

  it('a synthesized start fires ONCE even if more events follow', () => {
    // The forwarder records the id when it synthesizes, so a later real event
    // for the same task must not produce a second start — a duplicate would
    // open a second frame for one task.
    const t = node('pkg#lint')
    const { delegated } = bothPaths([
      { kind: 'task:complete', node: t, outcome: outcome(t, { status: 'skipped' }) },
      { kind: 'task:complete', node: t, outcome: outcome(t, { status: 'skipped' }) },
    ])
    expect(delegated.filter((c) => c.c === 'taskStart')).toHaveLength(1)
  })

  it('GROUP tasks are dropped at the wire and never reach a delegated renderer', () => {
    // Deliberate: a group has no command and no work — its start/complete are
    // pure scheduling noise. Locally the renderer receives and ignores them;
    // on the wire they are filtered at the source so they never cost a frame
    // or a byte. This is an asymmetry by design, so the two arms differ.
    const group = node('pkg#ci', {}, true)
    const real = node('pkg#build')
    const { local, delegated, wire } = bothPaths([
      { kind: 'task:start', node: group },
      { kind: 'task:start', node: real },
      { kind: 'task:complete', node: real, outcome: outcome(real) },
      { kind: 'task:complete', node: group, outcome: outcome(group) },
    ])

    expect(local.map((c) => c.c)).toEqual(['taskStart', 'taskStart', 'complete', 'complete'])
    expect(delegated.map((c) => c.c)).toEqual(['taskStart', 'complete'])
    expect(delegated.every((c) => !('id' in c) || c.id === 'pkg#build')).toBe(true)
    // And nothing about the group crossed at all — not merely ignored on
    // arrival, but never sent.
    expect(JSON.stringify(wire)).not.toContain('pkg#ci')
  })

  it('the duplicate run:end is deduped, and later status lines still cross', () => {
    // `run()` emits run:end TWICE (the normal path and the finally), with the
    // summary footer's status lines emitted BETWEEN them. The forwarder drops
    // the second end but must keep forwarding the footer — an earlier version
    // that went quiet after the first end lost the entire run summary from
    // every delegated run.
    const { local, delegated } = bothPaths([
      { kind: 'run:end' },
      { kind: 'run:status', line: 'Tasks: 1 success' },
      { kind: 'run:status', line: 'Cache: 1 miss' },
      { kind: 'run:end' },
    ])

    expect(local.map((c) => c.c)).toEqual(['runEnd', 'status', 'status', 'runEnd'])
    expect(delegated.map((c) => c.c)).toEqual(['runEnd', 'status', 'status'])
    expect(delegated.filter((c) => c.c === 'status').map((c) => c.line)).toEqual([
      'Tasks: 1 success',
      'Cache: 1 miss',
    ])
  })
})

describe('the wire form is actually sendable', () => {
  it('survives JSON round-tripping — the projection is the whole point', () => {
    // Two concrete blockers make a raw RunEvent un-sendable, and both are the
    // projection's job: a `TaskOutcome` carries bigint wallclock fields, and
    // `JSON.stringify` THROWS on a bigint; and its `node` back-references the
    // whole graph, so every event would drag the dep tree across the boundary.
    //
    // This asserts the real transport, not a stand-in: serialize the wire
    // events, parse them back, and render from the PARSED copies.
    const build = node('pkg#build', { requested: true })
    const events: RunEvent[] = [
      { kind: 'run:start', info: { total: 1 } },
      { kind: 'task:start', node: build },
      { kind: 'task:stdout', node: build, chunk: 'hi\n' },
      { kind: 'task:complete', node: build, outcome: outcome(build) },
      { kind: 'run:end' },
    ]

    // A raw outcome genuinely cannot be stringified — this is the constraint,
    // asserted rather than asserted-about.
    expect(() => JSON.stringify(outcome(build))).toThrow(/BigInt/i)

    const { local, wire } = bothPaths(events)
    const revived = JSON.parse(JSON.stringify(wire)) as WireEvent[]

    const afterTransport = recorder()
    const render = createWireRenderer(afterTransport.sink)
    for (const e of revived) render(e)

    expect(afterTransport.calls).toEqual(local)
  })

  it('no event drags the task graph across the boundary', () => {
    // The second blocker. A `TaskView` is ids and display fields; if a wire
    // event ever carried a live node, this would find its `deps` array and the
    // payload would grow with the graph rather than with the run.
    const a = node('pkg#a')
    const b = node('pkg#b', { deps: [a] } as unknown as Partial<TaskNode>)
    const { wire } = bothPaths([
      { kind: 'task:start', node: b },
      { kind: 'task:complete', node: b, outcome: outcome(b) },
    ])
    for (const e of wire) {
      expect(Object.hasOwn(e, 'node')).toBe(false)
      expect(JSON.stringify(e)).not.toContain('projectDir')
    }
  })
})

describe('createWireRenderer — defensive behaviour on a partial stream', () => {
  it('drops task events for an id it never saw start', () => {
    // A client can attach mid-run (reconnect, a late `vx serve` subscriber),
    // so a stream can genuinely begin in the middle. Dropping is the right
    // degradation — there is no node to render against — and it must not
    // throw, because that would kill the client's whole stream.
    const rec = recorder()
    const render = createWireRenderer(rec.sink)
    expect(() => {
      render({ kind: 'task:stdout', taskId: 'never#seen', chunk: 'x' })
      render({ kind: 'task:stderr', taskId: 'never#seen', chunk: 'y' })
      render({
        kind: 'task:complete',
        outcome: { taskId: 'never#seen', status: 'success', exitCode: 0, durationMs: 1 },
      } as WireEvent)
    }).not.toThrow()
    expect(rec.calls).toEqual([])
  })

  it('tolerates a sink that implements only the required Logger methods', () => {
    // `runStart` / `taskStart` / `runEnd` are OPTIONAL on Logger — embedders
    // supply a partial sink, and the renderer calls them with `?.`. A
    // regression to a bare call would crash every custom-logger consumer while
    // the default logger, which implements all of them, stayed green.
    const seen: string[] = []
    const partial: Logger = {
      status: (l) => void seen.push(`status:${l}`),
      taskStdout: () => {},
      taskStderr: () => {},
      taskComplete: (n) => void seen.push(`complete:${n.id}`),
    }
    const render = createWireRenderer(partial)
    expect(() => {
      render({ kind: 'run:start', info: { total: 1 } })
      render({
        kind: 'task:start',
        task: {
          id: 'pkg#build',
          project: 'pkg',
          task: 'build',
          isGroup: false,
          requested: true,
          surfaced: false,
          persistent: false,
          command: 'run build',
        },
      })
      render({
        kind: 'task:complete',
        outcome: { taskId: 'pkg#build', status: 'success', exitCode: 0, durationMs: 1 },
      } as WireEvent)
      render({ kind: 'run:status', line: 'ok' })
      render({ kind: 'run:end' })
    }).not.toThrow()
    expect(seen).toEqual(['complete:pkg#build', 'status:ok'])
  })
})
