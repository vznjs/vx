// A benchmark times the machine it runs on, so it runs alone on one of
// its own: CI's Bench job, one task at a time. A DTE worker is packed
// beside other tasks, so no site benchmark is ever offered to one.
import { expect, it } from 'bun:test'
import config from '../vx.config.ts'

type Task = { exec?: { remote?: boolean | 'only' } }

it('no site benchmark is offered to a remote executor', () => {
  const offered = Object.entries(config.tasks as Record<string, Task>)
    .filter(([name]) => name.startsWith('bench.'))
    .filter(([, t]) => t.exec?.remote !== false)
    .map(([name]) => name)
  expect(offered).toEqual([])
})
