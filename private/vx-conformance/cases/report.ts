import { defineCase, type ReportCheck, type TaskSpec } from '../src/spec.ts'
import { one } from './shapes.ts'

// What a tool hands back about a run, read from its own output, files or
// API: the numbers a user tunes a build with. Each task writes a 5000-byte
// output, so what a hit restores is known too.
const WRITE = 'mkdir -p dist && head -c 5000 /dev/zero > dist/out.bin'
const task = (work: string): TaskSpec => ({
  command: `${work} && ${WRITE}`,
  inputs: ['src/**'],
  outputs: ['dist/**'],
})
const SLEEP = task('sleep 0.3')
// About a second of CPU in one process.
const BUSY = task("awk 'BEGIN { for (i = 0; i < 2e7; i++) s += i }'")
// A 64 MB buffer, filled.
const BIG = task('dd if=/dev/zero bs=64M count=1 of=/dev/null 2>/dev/null')
const OUTPUT: [number, number] = [5000, 5000]

const miss = (title: string, slug: string, t: TaskSpec, want: ReportCheck) =>
  defineCase({
    id: `report/${slug}`,
    category: 'report',
    kind: 'data',
    title,
    from: ['last', 'run-history-columns'],
    workspace: one(t),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'], report: { task: 'a#build', ...want } } },
    ],
  })

const hit = (title: string, slug: string, want: ReportCheck) =>
  defineCase({
    id: `report/${slug}`,
    category: 'report',
    kind: 'data',
    title,
    from: ['last', 'run-history-columns'],
    workspace: one(SLEEP),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { 'packages/a/dist/out.bin': null } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], report: { task: 'a#build', ...want } },
      },
    ],
  })

export default [
  miss('A run reports that a task missed the cache', 'cache-miss', SLEEP, { cache: 'miss' }),
  hit('A run reports that a task was replayed', 'cache-hit', { cache: 'hit' }),
  miss('A run reports how long each task took', 'duration', SLEEP, { durationMs: [280, 20_000] }),
  hit('A run reports how long a replay took, not the original run', 'restore-duration', {
    durationMs: [0, 280],
  }),
  miss('A run reports each task’s CPU time', 'cpu', BUSY, { cpuMs: [100, 120_000] }),
  miss('A run reports each task’s peak memory', 'memory', BIG, {
    peakMemoryBytes: [60_000_000, 4_000_000_000],
  }),
  miss('A run reports the size of what each task wrote', 'output-size', SLEEP, {
    outputBytes: OUTPUT,
  }),
  hit('A run reports the size of what a replay restored', 'restored-size', { outputBytes: OUTPUT }),
]
