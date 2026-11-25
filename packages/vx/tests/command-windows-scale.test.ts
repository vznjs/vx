// A save asks `reachedSince` of each task under it, and a project's every
// command opens a window there: one that scanned the project's every window
// made a 10,000-task chain in one project cubic (1,002 s cold, 2,000 tasks
// 10.6 s, 8 of them in this check).

import { expect, it } from 'bun:test'
import { commandWindows } from '../src/orchestrator/command-windows.js'
import { cpuClock } from './helpers/cpu-clock.js'

it('answers in constant time however many windows a directory held', () => {
  const w = commandWindows()
  const n = 40_000
  for (let i = 0; i < n; i++) w.open(`t${i}`, '/ws/p', 'project')()
  const after = Date.now() + 10
  const cpu = cpuClock()
  let reached = 0
  for (let i = 0; i < n; i++) if (w.reachedSince('/ws/p', after, after + 1)) reached++
  const ms = cpu()
  expect(reached).toBe(0)
  // Scanning each window: 1.6e9 steps, seconds. Constant: a few ms.
  expect(ms).toBeLessThan(500)
})

it('a window open, or closed after `from`, in the directory or above it, reached it', () => {
  const w = commandWindows()
  const close = w.open('a', '/ws/p', 'project')
  const from = Date.now() - 1
  expect(w.reachedSince('/ws/p/sub', from, Date.now())).toBe(true)
  expect(w.reachedSince('/ws/q', from, Date.now())).toBe(false)
  close()
  expect(w.reachedSince('/ws/p', from, Date.now())).toBe(true)
  const later = Date.now() + 10
  expect(w.reachedSince('/ws/p', later, later + 1)).toBe(false)
  w.open('b', '/ws/q', 'workspace')
  expect(w.reachedSince('/ws/p', later, later + 1)).toBe(true)
})
