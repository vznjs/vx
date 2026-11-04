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

const miss = (title: string, why: string, slug: string, t: TaskSpec, want: ReportCheck) =>
  defineCase({
    id: `report/${slug}`,
    category: 'report',
    kind: 'data',
    title,
    why,
    from: ['last', 'run-history-columns'],
    workspace: one(t),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'], report: { task: 'a#build', ...want } } },
    ],
  })

const hit = (title: string, why: string, slug: string, want: ReportCheck) =>
  defineCase({
    id: `report/${slug}`,
    category: 'report',
    kind: 'data',
    title,
    why,
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
  miss(
    'A run reports that a task missed the cache',
    'Knowing which tasks missed the cache is how a user finds what broke caching. A key that changes on every run looks like a slow build until the report shows the miss. Without it, a team cannot tell a cold cache from one that never hits, and cannot find the input that keeps changing.',
    'cache-miss',
    SLEEP,
    { cache: 'miss' },
  ),
  hit(
    'A run reports that a task was replayed',
    'A report of each hit tells the user what was replayed rather than run. When a result looks wrong, the first question is whether the task ran at all. It is also how a team checks that CI gets the reuse it expects, and notices when a change quietly turns hits into misses.',
    'cache-hit',
    { cache: 'hit' },
  ),
  miss(
    'A run reports how long each task took',
    'Per-task time is the number a build is tuned with. Without it, a user cannot find the slow task on the critical path or tell whether a change made a task slower. The total time of a run alone hides which task to fix, since many tasks run at once and overlap.',
    'duration',
    SLEEP,
    { durationMs: [280, 20_000] },
  ),
  hit(
    'A run reports how long a replay took, not the original run',
    'A replay’s time is the time to restore it, not the original command’s time. Reporting the original time makes a hit look as slow as a miss and hides whether the cache helps at all. It also hides a slow restore, such as a large artifact from a slow store. The original time belongs to the run that paid it.',
    'restore-duration',
    {
      durationMs: [0, 280],
    },
  ),
  miss(
    'A run reports each task’s CPU time',
    'CPU time shows how much work a task does, apart from how long it waited. A task that waits on the network and one that compiles for the same span look alike by wall time. CPU time tells a user which tasks gain from more cores and which from less waiting, and whether parallel runs are starved.',
    'cpu',
    BUSY,
    { cpuMs: [100, 120_000] },
  ),
  miss(
    'A run reports each task’s peak memory',
    'Peak memory decides how many tasks fit on a machine at once. Without it, a user sizing CI runners or a concurrency limit guesses, and a run can be killed for running out of memory with no hint of which task caused it. Per-task numbers show which task needs the larger machine.',
    'memory',
    BIG,
    {
      peakMemoryBytes: [60_000_000, 4_000_000_000],
    },
  ),
  miss(
    'A run reports the size of what each task wrote',
    'The size of what a task writes is what the cache must store and move. Large outputs make saves and restores slow and fill a remote cache. Reporting it per task shows which outputs to trim, split or leave uncached, instead of guessing from the size of the whole cache.',
    'output-size',
    SLEEP,
    {
      outputBytes: OUTPUT,
    },
  ),
  hit(
    'A run reports the size of what a replay restored',
    'On a replay, the bytes restored are the cost of the hit. A hit that pulls a large artifact over the network can take longer than running the task. Reporting the restored size lets a user see when that happens and narrow what the task declares as output.',
    'restored-size',
    { outputBytes: OUTPUT },
  ),
]
