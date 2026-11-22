// What a run reports per task, beyond the basics in report.ts: whose time,
// whose CPU and whose bytes each number counts. Drawn from Turborepo's
// run summary tests (crates/turborepo/tests/run_summary.rs), moon's
// run report (crates/cli/tests/exec_test.rs creates_run_report) and Nx's
// task timings (e2e/nx/src/cache.test.ts).
import { defineCase, type Case, type ReportCheck, type TaskSpec } from '../src/spec.ts'
import { one } from './shapes.ts'

const A = 'packages/a'

const task = (command: string, extra: Partial<TaskSpec> = {}): TaskSpec => ({
  command,
  inputs: ['src/**'],
  outputs: ['dist/**'],
  ...extra,
})

const BUSY = "awk 'BEGIN { for (i = 0; i < 2e7; i++) s += i }'"

/** One task, one run, one report check. */
function once(
  slug: string,
  title: string,
  why: string,
  t: TaskSpec,
  want: ReportCheck,
  extra: Partial<Case> = {},
): Case {
  return defineCase({
    id: `report/${slug}`,
    category: 'report',
    kind: 'data',
    title,
    why,
    from: ['last', 'run-history-columns'],
    workspace: one(t),
    steps: [{ run: 'build', expect: { exit: 0, report: { task: 'a#build', ...want } } }],
    ...extra,
  })
}

/** `lib` (built by `libCmd`) then `app` (built by `appCmd`), each reading its own src. */
const pair = (libCmd: string, appCmd: string) => ({
  projects: {
    lib: { tasks: { build: task(libCmd) }, files: { 'src/a.txt': 'ok\n' } },
    app: {
      deps: ['lib'],
      tasks: { build: task(appCmd, { dependsOn: ['^build'] }) },
      files: { 'src/a.txt': 'ok\n' },
    },
  },
})

export default [
  once(
    'idle-task-cpu-small',
    'A task that sleeps for a second reports little CPU',
    'CPU time is what a task costs a machine; wall time is how long it waited. A task blocked on a timer or the network uses almost none. A tool that reports wall time as CPU makes every waiting task look like the one to optimise.',
    task('sleep 1 && mkdir -p dist && : > dist/out.txt'),
    { cpuMs: [0, 300] },
  ),

  once(
    'cpu-counts-a-waited-child',
    'A task reports the CPU of a child process it starts in the background and waits for',
    'Build scripts fan out: a shell starts a compiler in the background, then waits. That child’s CPU is the task’s cost. A tool that counts only the first process it started reports nearly nothing for the heaviest task of the run.',
    task(`(${BUSY}) & wait; mkdir -p dist && : > dist/out.txt`),
    { cpuMs: [100, 120_000] },
  ),

  defineCase({
    id: 'report/uncached-task-reports-miss',
    category: 'report',
    kind: 'data',
    title: 'A task with caching turned off reports a miss each time it runs',
    why: 'A task that is never cached runs every time, so it never hits. A report that marks its second run a hit, because an earlier run of the same key passed, tells the user something was replayed that ran. The report says miss.',
    from: ['last', 'run-history-columns'],
    needs: ['uncached-task'],
    workspace: one(task('mkdir -p dist && : > dist/out.txt', { cache: false })),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], report: { task: 'a#build', cache: 'miss' } },
      },
    ],
  }),

  once(
    'output-size-counts-only-declared',
    'A run reports the size of the declared outputs only, not of every file the task wrote',
    'A task writes scratch files beside its outputs: a temp directory, a log. Only the declared outputs are cached and moved. A tool that counts the scratch files overstates what the cache holds and points at the wrong task. A thousand declared bytes beside five thousand scratch bytes is a thousand.',
    task(
      'mkdir -p dist tmp && head -c 1000 /dev/zero > dist/out.bin && head -c 5000 /dev/zero > tmp/s.bin',
    ),
    { outputBytes: [1000, 1000] },
  ),

  once(
    'output-size-leaves-out-negated',
    'A run reports the size of outputs without the files a negation takes out',
    'A negated output pattern keeps files out of the cache, often the large ones such as source maps. Counting them anyway reports a size the cache never stores. A hundred kept bytes beside nine hundred negated bytes is a hundred.',
    task(
      'mkdir -p dist && head -c 100 /dev/zero > dist/a.js && head -c 900 /dev/zero > dist/a.js.map',
      { outputs: ['dist/**', '!dist/*.map'] },
    ),
    { outputBytes: [100, 100] },
  ),

  once(
    'empty-output-files-size-zero',
    'A run reports zero bytes for outputs that are all empty files',
    'Marker files and empty stamps are outputs with no content. Their size is zero; a tool that counts entries, blocks or archive headers reports bytes that are not there.',
    task('mkdir -p dist && : > dist/a && : > dist/b && : > dist/c'),
    { outputBytes: [0, 0] },
  ),

  defineCase({
    id: 'report/output-size-follows-the-rebuild',
    category: 'report',
    kind: 'data',
    title: 'A rebuild that writes more reports the new size, not the size first stored',
    why: 'An output grows as the code does. The report of a rebuild must count what this run wrote. A tool that keeps the first size it saw for the task hides the growth that makes the cache slow.',
    from: ['last', 'run-history-columns'],
    workspace: one(task('mkdir -p dist && head -c "$(cat src/n.txt)" /dev/zero > dist/out.bin'), {
      'src/n.txt': '100\n',
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/src/n.txt`]: '300\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], report: { task: 'a#build', outputBytes: [300, 300] } },
      },
    ],
  }),

  defineCase({
    id: 'report/restored-size-is-the-replayed-entry',
    category: 'report',
    kind: 'data',
    title: 'Replaying an older result reports that result’s size, not the latest one’s',
    why: 'A cache holds a result per key. Going back to an earlier input replays the earlier, smaller result, and the report must count what was restored. A tool that reports the task’s last known size reports bytes it never moved.',
    from: ['last', 'run-history-columns'],
    workspace: one(task('mkdir -p dist && head -c "$(cat src/n.txt)" /dev/zero > dist/out.bin'), {
      'src/n.txt': '100\n',
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/src/n.txt`]: '300\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { [`${A}/src/n.txt`]: '100\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['a#build'],
          report: { task: 'a#build', outputBytes: [100, 100] },
        },
      },
    ],
  }),

  defineCase({
    id: 'report/dependant-duration-is-its-own',
    category: 'report',
    kind: 'data',
    title: 'A quick task after a slow dependency reports its own short time',
    why: 'A task’s duration is how long it ran, not how long it waited for what it depends on. A tool that measures from the run’s start, or from when the task was queued, makes every task late in a chain look slow and hides the one that is.',
    from: ['last', 'run-history-columns'],
    workspace: pair(
      'sleep 1 && mkdir -p dist && : > dist/out.txt',
      'mkdir -p dist && : > dist/out.txt',
    ),
    steps: [
      {
        run: 'build',
        expect: {
          exit: 0,
          order: [['lib#build', 'app#build']],
          report: { task: 'app#build', durationMs: [0, 600] },
        },
      },
    ],
  }),

  defineCase({
    id: 'report/dependency-hit-beside-a-failure',
    category: 'report',
    kind: 'data',
    title: 'A run whose dependant fails still reports the replayed dependency as a hit',
    why: 'When a run fails, the report is read most closely. The dependency that replayed did replay; a tool that marks every task of a failed run failed or missed sends the user to debug a cache that worked.',
    from: ['last', 'run-history-columns'],
    workspace: pair(
      'mkdir -p dist && : > dist/out.txt',
      'grep -q ok src/a.txt && mkdir -p dist && : > dist/out.txt',
    ),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/app/src/a.txt': 'bad\n' } },
      {
        run: 'build',
        expect: { exit: 'fail', ran: ['app#build'], report: { task: 'lib#build', cache: 'hit' } },
      },
    ],
  }),

  once(
    'timed-out-task-duration',
    'A run reports how long a task ran before its time limit stopped it',
    'A task stopped by its time limit used all of it. Its duration is the limit, not zero and not missing: that is the number that shows the limit is too tight or the task hangs.',
    task('sleep 30', { timeout: 1 }),
    { durationMs: [900, 15_000] },
    {
      needs: ['timeout'],
      steps: [
        {
          run: 'build',
          expect: { exit: 'fail', report: { task: 'a#build', durationMs: [900, 15_000] } },
        },
      ],
    },
  ),
]
