import { expect, it } from 'bun:test'
import {
  childrenCpuMs,
  describeCpu,
  parsePs,
  psTime,
  readPs,
  topBetween,
} from '../src/cpu-account.js'

it('reads ps times from Linux and macOS', () => {
  expect(psTime('00:01:05')).toBe(65_000)
  expect(psTime('1-02:00:00')).toBe(93_600_000)
  expect(psTime('0:01.50')).toBe(1_500)
  expect(psTime('0:01,50')).toBe(1_500)
  expect(psTime('x')).toBeUndefined()
})

it('names the processes that used the most since the first look, its own tree aside', () => {
  const before = parsePs(
    [
      '  10     1 00:00:30 /usr/bin/Runner.Worker',
      '  20     1 00:00:01 mds_stores',
      ' 100     1 00:00:00 bun',
    ].join('\n'),
  ).table
  const after = parsePs(
    [
      '  10     1 00:00:42 /usr/bin/Runner.Worker',
      '  20     1 00:00:04 mds_stores',
      '  30     1 00:00:02 mds_stores',
      ' 100     1 00:00:09 bun',
      ' 101   100 00:00:20 bun test',
      ' 102   101 00:00:05 git',
    ].join('\n'),
  )
  expect(topBetween(before, after, 100)).toEqual([
    { name: 'Runner.Worker', ms: 12_000 },
    { name: 'mds_stores', ms: 5_000 },
  ])
})

it('reads its reaped children from /proc/self/stat, none off Linux', () => {
  const stat = `42 (bun (x)) S 1 42 42 0 -1 0 0 0 0 0 7 3 150 50 20 0 1 0`
  expect(childrenCpuMs(() => stat)).toBe(2_000)
  expect(
    childrenCpuMs(() => {
      throw new Error('ENOENT')
    }),
  ).toBeUndefined()
})

it('reads this machine', () => {
  const ps = readPs()
  expect(ps?.parents.get(process.pid)).toBe(process.ppid)
})

it('says each share as cores over the time online', () => {
  expect(
    describeCpu({
      onlineMs: 10_000,
      machineMs: 28_000,
      tasksMs: 20_000,
      selfMs: 1_500,
      childrenMs: 500,
      top: [{ name: 'Runner.Worker', ms: 3_000 }],
    }),
  ).toBe(
    'cpu over 10.0s: machine 2.80 cores · tasks 2.00 cores · this worker 0.15 cores · its other children 0.05 cores · most besides: Runner.Worker 0.30 cores',
  )
})
