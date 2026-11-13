// A run's workers and servers are timed as tasks (2026-11-11): each measure
// is defined by what it is of, so a size or server changed starts over, and
// a run's measures read back as what the plan learned.

import { expect, it } from 'bun:test'
import type { TaskNode } from '@vzn/vx'
import { baseId, learnedOf, measureDefs, runMeasures, spreadId, workerId } from '../src/measures.js'

const small = { name: 'linux.small', platform: 'linux', cpu: 2, memory: 2 ** 30, runsOn: undefined }
const node = (id: string, exec: Record<string, unknown>): TaskNode =>
  ({ id, deps: [], config: { exec } }) as unknown as TaskNode
const graph = new Map([
  ['a#dev', node('a#dev', { command: 'serve', persistent: {} })],
  ['a#test', node('a#test', { command: 'test' })],
])

// Main ef6a822's Macs queued 322 s, where history said 40 s: the next run
// planned to a 139 s Mac join, and the Mac joined at 25 s.
it('caps a warm-up past twice history’s, as the CI’s queue', () => {
  const defs = measureDefs([small], graph)
  const run = (ms: number, known?: Map<string, number>) =>
    runMeasures(
      defs,
      {
        warmUps: new Map([['linux.small', ms]]),
        others: new Map(),
        spreads: new Map(),
        bases: new Map(),
      },
      known,
    ).find((m) => m.id === workerId('linux.small'))!.durationMs
  const known = new Map([['linux.small', 40_000]])
  expect(run(322_000, known)).toBe(80_000)
  expect(run(60_000, known)).toBe(60_000)
  // None known: as it was.
  expect(run(322_000)).toBe(322_000)
})

it('defines each size by its name and what it is, and each server by its definition', () => {
  const defs = measureDefs([small], graph)
  expect([...defs.keys()]).toEqual([
    '@vzn/vx-dte#worker:linux.small',
    '@vzn/vx-dte#join-spread:linux.small',
    '@vzn/vx-dte#server-base:a#dev',
  ])
  // Its worker's warm-up and its spread are two measures, apart.
  expect(defs.get(workerId('linux.small'))).not.toBe(defs.get(spreadId('linux.small')))
  // A size given more cores, or another runner, starts over; one alike does not.
  const again = measureDefs([{ ...small }], graph)
  expect(again.get(workerId('linux.small'))).toBe(defs.get(workerId('linux.small')))
  for (const changed of [
    { ...small, cpu: 4 },
    { ...small, runsOn: 'ubuntu-latest' },
    { ...small, name: 'linux.big' },
  ])
    expect(measureDefs([changed], graph).get(workerId(changed.name))).not.toBe(
      defs.get(workerId('linux.small')),
    )
  // A server whose command changed starts over.
  const edited = new Map([['a#dev', node('a#dev', { command: 'serve --port 1', persistent: {} })]])
  expect(measureDefs([], edited).get(baseId('a#dev'))).not.toBe(defs.get(baseId('a#dev')))
})

it("reads back a run's measures as what it learned", () => {
  const defs = measureDefs([small], graph)
  const run = runMeasures(defs, {
    warmUps: new Map([
      ['linux.small', 14_000],
      ['linux.gone', 9_000],
    ]),
    others: new Map([['linux.small', 0.4]]),
    spreads: new Map([['linux.small', 1_500]]),
    bases: new Map([['a#dev', 0.75]]),
    starts: new Map([['a#dev', 9_000]]),
  })
  // A size the run declares no definition for is no measure.
  expect(run.map((m) => m.id)).toEqual([
    workerId('linux.small'),
    spreadId('linux.small'),
    baseId('a#dev'),
  ])
  for (const m of run) expect(m.def).toBe(defs.get(m.id)!)
  const learned = learnedOf(new Map(run.map((m) => [m.id, m])))
  expect(learned).toEqual({
    warmUps: new Map([['linux.small', 14_000]]),
    others: new Map([['linux.small', 0.4]]),
    spreads: new Map([['linux.small', 1_500]]),
    bases: new Map([['a#dev', 0.75]]),
    starts: new Map([['a#dev', 9_000]]),
  })
})
