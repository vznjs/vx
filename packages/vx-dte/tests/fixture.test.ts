// scripts/fixture.ts: a sim fixture keeps each task on the platform of the
// worker that ran it.
import { expect, it } from 'bun:test'
import { fixture } from '../scripts/fixture.js'

it("reads a task's platform from its worker's size, behind the adapter's group", () => {
  const task = (name: string, pid: number) => ({
    ph: 'X',
    name,
    pid,
    dur: 2_000_000,
    args: { cpuMs: 1000, peakRssBytes: 5e6 },
  })
  const worker = (pid: number, name: string) => ({
    ph: 'M',
    name: 'process_name',
    pid,
    args: { name },
  })
  const f = fixture(
    {
      tasks: ['mac', 'old', 'arm', 'linux'].map((id) => ({ id, cacheStatus: 'miss', deps: [] })),
    },
    [
      worker(1, 'hosted.mac#2'),
      worker(2, 'mac#1'),
      worker(3, 'hosted.arm#1'),
      worker(4, 'hosted.small#9'),
      task('mac', 1),
      task('old', 2),
      task('arm', 3),
      task('linux', 4),
    ],
    'a run',
  )
  expect(f.nodes.map((n) => [n.id, n.platform])).toEqual([
    ['mac', 'darwin-arm64'],
    ['old', 'darwin-arm64'],
    ['arm', 'linux-arm64'],
    // CONTROL: a task on the home platform names none.
    ['linux', undefined],
  ])
  expect(f.ran.mac).toEqual([2000, 0.5, 5])
})
