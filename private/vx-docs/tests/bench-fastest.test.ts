// Main's Bench and the site's build fail when vx loses any race
// (2026-11-21): time on a cold build, a restore or nothing changed to any
// rival, CPU to any but Vite Task.
import { expect, it } from 'bun:test'
import { RUNNERS, assertFastest, losses, type BenchData, type Runner } from '../src/bench/format.ts'

const base = {
  fresh: 100,
  warmNoRestore: 0,
  warmRestore: 0,
  freshCpu: 10,
  criticalPathMs: 0,
  workBoundMs: 0,
}

/** Bench data where each runner adds `over` ms to every figure, `cpu` to CPU. */
function data(over: Record<Runner, [number, number]>): BenchData {
  const runners = Object.fromEntries(
    RUNNERS.map((r) => {
      const [t, cpu] = over[r]
      const row = {
        runner: r,
        version: '1',
        fresh: 100 + t,
        warmNoRestore: t,
        warmRestore: t,
        freshCpu: 10 + cpu,
        warmNoRestoreCpu: 0,
        warmRestoreCpu: 0,
      }
      const machine = { os: 'linux', cores: 4, cpu: 'x', memoryGb: 16 }
      return [r, { date: '2026-11-21', machine, reps: 1, coldReps: 1, row, baseline: base }]
    }),
  ) as BenchData['runners']
  return { shape: 's', packages: 1, tasks: 1, levels: 1, buildMs: 1, concurrency: 1, runners }
}

it('passes when vx wins every race, CPU lost only to Vite Task', () => {
  const d = data({ vx: [5, 30], turbo: [6, 40], nx: [50, 90], 'vite-task': [5, 10] })
  expect(losses(d)).toEqual([])
  expect(() => assertFastest(d, 't')).not.toThrow()
})

it('names each race vx loses, and to whom', () => {
  const d = data({ vx: [9, 50], turbo: [6, 40], nx: [50, 90], 'vite-task': [8, 10] })
  expect(losses(d)).toEqual([
    'cold build: vx 9 ms, Turbo 6 ms',
    'nothing changed, outputs restored: vx 9 ms, Turbo 6 ms',
    'nothing changed: vx 9 ms, Turbo 6 ms',
    'cold build CPU: vx 50 ms, Turbo 40 ms',
    'cold build: vx 9 ms, Vite Task 8 ms',
    'nothing changed, outputs restored: vx 9 ms, Vite Task 8 ms',
    'nothing changed: vx 9 ms, Vite Task 8 ms',
  ])
  expect(() => assertFastest(d, 'live-bench')).toThrow(/live-bench: vx is not the fastest/)
})
