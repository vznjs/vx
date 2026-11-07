import { expect, it } from 'bun:test'
import { closures, liveRun, monorepo } from './live-run.js'

// 2026-11-05: the orchestrator walked each task's upstream four times (on
// its way in, sharing, placing, sending): a giant repo's run spent 17 s of
// the orchestrator's CPU on 8000 tasks of 5 ms. Once a task, plus a few
// look-ups of its own.
it('walks each task’s dependencies once', async () => {
  const graph = monorepo(300, 3)
  const run = await liveRun(graph, { workers: 20, cores: 4, taskMs: 2 })
  expect(run.lookups).toBeLessThanOrEqual(closures(graph) + 8 * graph.length)
})

// 2026-11-05: each order named every upstream whole, whatever its worker
// was sent before: 8000 tasks of a deep graph sent 219 MB. A dependency a
// worker was sent whole goes by name after.
it('sends a worker each dependency whole once', async () => {
  const graph = monorepo(300, 3)
  const run = await liveRun(graph, { workers: 4, cores: 4, taskMs: 2 })
  expect([run.whole > 0, run.again]).toEqual([true, 0])
})

// 2026-11-07: a server's base is booked once on the worker that starts it,
// beside each dependant's own cores: on 4 cores, a base of 2 leaves room
// for two 1-core dependants at once, not four.
it('books a server’s base once on the worker beside its dependants', async () => {
  const graph = ['a', 'b', 'c', 'd'].map((t) => ({ id: `s#${t}`, deps: [] }))
  const need = (cores: number) => () => ({
    cores: 1,
    memory: 0,
    servers: [{ id: 's#db', cores }],
  })
  const based = await liveRun(graph, { workers: 1, cores: 4, taskMs: 20, need: need(2) })
  expect(based.peak).toBe(2)
  // CONTROL: a base of 0 books nothing.
  const free = await liveRun(graph, { workers: 1, cores: 4, taskMs: 20, need: need(0) })
  expect(free.peak).toBe(4)
})
