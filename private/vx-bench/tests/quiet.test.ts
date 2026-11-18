import { expect, it } from 'bun:test'
import { busyMs, enoughQuiet, type Pair, procCpuMs, quietest } from '../quiet.js'
import config from '../vx.config.js'

it("reads busy time from /proc/stat's cpu line: all but idle and iowait, in ms", () => {
  //               user nice system idle  iowait irq softirq steal guest
  const stat = 'cpu  100 5 30 9000 70 2 3 4 50\ncpu0 1 2 3 4 5 6 7 8\n'
  expect(busyMs(stat)).toBe((100 + 5 + 30 + 2 + 3 + 4) * 10)
})

it("reads a process's CPU from its stat line, past a name holding spaces and parens", () => {
  // pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime
  const stat = '15 (a (b) c) S 6 15 8 0 -1 4194368 54 0 0 0 120 30 0 0 20 0 1 0'
  expect(procCpuMs(stat)).toBe((120 + 30) * 10)
})

const pair = (vx: number, others: number): Pair => ({ vx, turbo: 100, others })

// #4323's CI: a pair beside two test shards read vx's noop at 468 ms where
// a quiet one read 292. The ratio comes from the pairs others left alone.
it('keeps the quietest pairs, in the order they ran', () => {
  const pairs = [pair(468, 2.1), pair(292, 0.1), pair(300, 0.3), pair(450, 1.8), pair(295, 0.2)]
  expect(quietest(pairs, 3).map((p) => p.vx)).toEqual([292, 300, 295])
  expect(Math.min(...quietest(pairs, 3).map((p) => p.vx))).toBe(292)
})

it('waits for enough pairs with at most the quiet share busy beside them', () => {
  const pairs = [pair(1, 0.1), pair(1, 0.6), pair(1, 0.5)]
  expect(enoughQuiet(pairs, 2, 0.5)).toBe(true)
  expect(enoughQuiet(pairs, 3, 0.5)).toBe(false)
})

// The two benchmarks ran side by side on one worker as two tasks.
it('runs perf-guard and the Turbo bench as one task, one after the other', () => {
  expect(config.tasks?.['check.perf']?.exec?.command).toBe('bun perf-guard.ts && bun pr-bench.ts')
  expect(Object.keys(config.tasks)).not.toContain('check.vs-turbo')
})
