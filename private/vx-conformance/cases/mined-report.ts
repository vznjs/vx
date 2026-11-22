// What a run reports per task, mined from the rivals’ run data tests and
// vx’s own: Turborepo’s run summary (crates/turborepo/tests/run_summary.rs,
// run_caching.rs, dry_json.rs), Nx’s task timings and life cycles
// (packages/nx/src/tasks-runner), moon’s run report (action pipeline) and
// vx’s `vx last` / run history tests. Each case asks whose number the
// report holds: this run’s, this task’s, this process tree’s.
import {
  defineCase,
  type Case,
  type Expect,
  type Feature,
  type ReportCheck,
  type Step,
  type TaskSpec,
  type WorkspaceSpec,
} from '../src/spec.ts'
import { one } from './shapes.ts'

const A = 'packages/a'
const OUT = 'mkdir -p dist && : > dist/out.txt'
const BUSY = "awk 'BEGIN { for (i = 0; i < 2e7; i++) s += i }'"

const task = (command: string, extra: Partial<TaskSpec> = {}): TaskSpec => ({
  command,
  inputs: ['src/**'],
  outputs: ['dist/**'],
  ...extra,
})

const FROM = ['last', 'run-history-columns']

interface Opts {
  from?: string[]
  needs?: Feature[]
  workspace?: WorkspaceSpec
  /** The report is of this task. Default `a#build`. */
  of?: string
  exit?: 0 | 'fail'
}

/** One task, one run, one report check. */
function once(
  slug: string,
  title: string,
  why: string,
  t: TaskSpec,
  want: ReportCheck,
  o: Opts = {},
): Case {
  return defineCase({
    id: `report/${slug}`,
    category: 'report',
    kind: 'data',
    title,
    why,
    from: o.from ?? FROM,
    ...(o.needs ? { needs: o.needs } : {}),
    workspace: o.workspace ?? one(t),
    steps: [
      {
        run: 'build',
        expect: { exit: o.exit ?? 0, report: { task: o.of ?? 'a#build', ...want } },
      },
    ],
  })
}

type RunStep = Extract<Step, { run: string }>

/** A first run, the steps between, then the run whose report is judged. */
function then(
  slug: string,
  title: string,
  why: string,
  workspace: WorkspaceSpec,
  between: Step[],
  last: Omit<RunStep, 'expect'> & { expect?: Expect },
  want: ReportCheck,
  o: Opts & { first?: Partial<RunStep> } = {},
): Case {
  const { expect: more, ...run } = last
  return defineCase({
    id: `report/${slug}`,
    category: 'report',
    kind: 'data',
    title,
    why,
    from: o.from ?? FROM,
    ...(o.needs ? { needs: o.needs } : {}),
    workspace,
    steps: [
      { run: 'build', ...o.first, expect: { exit: 0 } },
      ...between,
      {
        ...run,
        expect: { exit: o.exit ?? 0, ...more, report: { task: o.of ?? 'a#build', ...want } },
      },
    ],
  })
}

/** `lib` then `app`, each building from its own src. */
const pair = (libCmd: string, appCmd: string, appExtra: Partial<TaskSpec> = {}) => ({
  projects: {
    lib: { tasks: { build: task(libCmd) }, files: { 'src/a.txt': 'lib\n' } },
    app: {
      deps: ['lib'],
      tasks: { build: task(appCmd, { dependsOn: ['^build'], ...appExtra }) },
      files: { 'src/a.txt': 'app\n' },
    },
  },
})

/** `a` and `b`, independent, each with its own build. */
const two = (aCmd: string, bCmd: string, extra: Partial<TaskSpec> = {}): WorkspaceSpec => ({
  projects: {
    a: { tasks: { build: task(aCmd, extra) }, files: { 'src/a.txt': 'a\n' } },
    b: { tasks: { build: task(bCmd, extra) }, files: { 'src/a.txt': 'b\n' } },
  },
})

const BUILT = one(task(OUT))
const replayed = { notRan: ['a#build'] }
const reran = { ran: ['a#build'] }

/** `a#build` reads src, `a#test` reads test. */
const BUILD_AND_TEST: WorkspaceSpec = {
  projects: {
    a: {
      tasks: {
        build: task(OUT),
        test: task('mkdir -p out && : > out/t.txt', {
          inputs: ['test/**'],
          outputs: ['out/**'],
        }),
      },
      files: { 'src/a.txt': 'a\n', 'test/a.txt': 't\n' },
    },
  },
}

const cacheCases: Case[] = [
  // Turborepo run_summary.rs test_run_summary_monorepo: each task carries its own cache status.
  defineCase({
    id: 'report/two-tasks-one-project-own-status',
    category: 'report',
    kind: 'data',
    title: 'Two tasks of one project report their own cache status',
    why: 'A project’s tasks read different files. An edit to a test file changes the test task’s key and not the build’s. In one run the build reports a hit and the test a miss; a tool that keys or reports by project gets one of them wrong.',
    from: FROM,
    needs: ['multi-task'],
    workspace: BUILD_AND_TEST,
    steps: [
      { run: 'build', also: ['test'], expect: { exit: 0 } },
      { write: { [`${A}/test/a.txt`]: 'changed\n' } },
      {
        run: 'build',
        also: ['test'],
        expect: { exit: 0, ran: ['a#test'], report: { task: 'a#build', cache: 'hit' } },
      },
    ],
  }),
  defineCase({
    id: 'report/edited-task-misses-beside-its-sibling',
    category: 'report',
    kind: 'data',
    title: 'The task whose input changed reports a miss beside a sibling task that hit',
    why: 'The other half of a per-task report: in the run where the build replays, the test whose file changed runs again. Its report says miss. A tool that reports the project’s status for both tasks hides the one that ran.',
    from: FROM,
    needs: ['multi-task'],
    workspace: BUILD_AND_TEST,
    steps: [
      { run: 'build', also: ['test'], expect: { exit: 0 } },
      { write: { [`${A}/test/a.txt`]: 'changed\n' } },
      {
        run: 'build',
        also: ['test'],
        expect: { exit: 0, notRan: ['a#build'], report: { task: 'a#test', cache: 'miss' } },
      },
    ],
  }),
  // Turborepo run_summary.rs test_run_summary_monorepo: the dependency is in the summary of the run.
  then(
    'dependency-of-selected-project-reports-hit',
    'Selecting only the app still reports its replayed dependency as a hit',
    'Asking for one project runs what it depends on too. A dependency that replays in that run is part of it and the report says hit. A tool that reports only the selected projects leaves the user unsure the library was rebuilt or replayed.',
    pair(OUT, OUT),
    [],
    { run: 'build', projects: ['app'], expect: { notRan: ['lib#build'] } },
    { cache: 'hit' },
    { of: 'lib#build', needs: ['filter'] },
  ),
  // Turborepo run_summary.rs: a replayed task’s summary says HIT and where it came from.
  then(
    'read-only-run-reports-hit',
    'A run that only reads the cache reports a stored task as a hit',
    'A read-only cache still replays what it holds; it only stops saving. The report of a stored task is a hit as in any run. A tool that reports every task of a read-only run as a miss makes CI pull requests look uncached when they are not.',
    BUILT,
    [{ write: { [`${A}/dist`]: null } }],
    { run: 'build', readOnlyCache: true, expect: replayed },
    { cache: 'hit' },
    { needs: ['read-only-cache'] },
  ),
  // Turborepo run_summary.rs test_run_summary_error: the failed task’s cache status is MISS.
  then(
    'failed-task-reports-miss',
    'A task that fails reports a miss, not a hit',
    'A failure is never saved to the cache, so a task that failed did not replay. Turborepo’s run summary records a failed task as a miss with its exit code. A report of hit on a failure points the user at the cache instead of at the code.',
    one(task('grep -q ok src/a.txt && mkdir -p dist && : > dist/out.txt'), { 'src/a.txt': 'ok\n' }),
    [{ write: { [`${A}/src/a.txt`]: 'bad\n' } }],
    { run: 'build', expect: reran },
    { cache: 'miss' },
    { exit: 'fail' },
  ),
  // vx last-attempts: a retried task’s row is one run of its command, never a replay.
  once(
    'retried-pass-reports-miss',
    'A task that passes on its second attempt reports a miss',
    'A retry runs the command again; nothing was replayed. A task that failed, retried and passed ran twice and its report says miss. A tool that reports the retried attempt as a hit, because the first attempt ran the same key, hides a flaky task.',
    task(
      'if [ -f flag.txt ]; then mkdir -p dist && : > dist/out.txt; else touch flag.txt; exit 1; fi',
      { retries: 1 },
    ),
    { cache: 'miss' },
    {
      from: ['last-attempts', 'retries'],
      needs: ['retries'],
      workspace: {
        projects: {
          a: {
            tasks: {
              build: task(
                'if [ -f flag.txt ]; then mkdir -p dist && : > dist/out.txt; else touch flag.txt; exit 1; fi',
                { retries: 1 },
              ),
            },
            files: { 'src/a.txt': 'a\n', '.gitignore': 'flag.txt\n' },
          },
        },
      },
    },
  ),
  // Turborepo run_summary.rs test_run_summary_error: a task that failed carries MISS.
  once(
    'timed-out-task-reports-miss',
    'A task stopped by its time limit reports a miss',
    'A task killed for running too long ran, and failed. Nothing was replayed and nothing saved. Its report says miss; a missing or hit status hides the hang from the person reading the report.',
    task('sleep 30', { timeout: 1 }),
    { cache: 'miss' },
    { needs: ['timeout'], exit: 'fail' },
  ),
  then(
    'uncached-dependency-reports-miss',
    'A dependency with caching off reports a miss while its dependant replays',
    'A task that is never cached runs every time, even when everything after it replays. Its report says miss beside the dependant’s hit. A tool that reports the whole chain from the dependant’s status shows a replay that did not happen.',
    pair(OUT, OUT),
    [
      {
        configure: (ws) => {
          ws.projects.lib!.tasks!.build!.cache = false
          return ws
        },
      },
      { run: 'build', expect: { exit: 0 } },
    ],
    { run: 'build', expect: { ran: ['lib#build'] } },
    { cache: 'miss' },
    { of: 'lib#build', needs: ['uncached-task'] },
  ),
]

const durationCases: Case[] = [
  // moon action pipeline: an action’s duration is measured around its own process only.
  once(
    'one-second-duration-bounds',
    'A task that sleeps for a second reports about a second, not much more',
    'A duration is useful only if it is the task’s own. A one second task reports at least a second and well under three. A tool that adds its own startup, hashing or the whole run’s time reports a number nobody can tune with.',
    task(`sleep 1 && ${OUT}`),
    { durationMs: [950, 3000] },
  ),
  // Nx performance-life-cycle.spec.ts 'attributes a wait with free slots to coordinator overhead'.
  once(
    'trivial-task-short-duration',
    'A task that does nothing reports a short time',
    'A task whose command returns at once costs almost nothing. Its report must say so, not include the runner’s own setup. Nx measures its per-task process start; a tool whose overhead lands in the task’s time makes every small task look slow.',
    task(OUT),
    { durationMs: [0, 1500] },
  ),
  // Nx performance-life-cycle.spec.ts 'reports zero overhead when everything runs in parallel'.
  defineCase({
    id: 'report/parallel-tasks-own-duration',
    category: 'report',
    kind: 'data',
    title: 'Two tasks running at once each report their own time',
    why: 'Tasks that run in parallel overlap in time but each has its own duration. The short one reports its short time even though the long one was still running. A tool that stamps every task with the end of the slowest one hides which task is slow.',
    from: FROM,
    workspace: two(`sleep 1.5 && ${OUT}`, `sleep 0.2 && ${OUT}`),
    steps: [
      { run: 'build', expect: { exit: 0, report: { task: 'b#build', durationMs: [180, 1200] } } },
    ],
  }),
  defineCase({
    id: 'report/parallel-long-task-duration',
    category: 'report',
    kind: 'data',
    title: 'The long task of two running at once reports its full time',
    why: 'The other half of overlap: the long task’s duration is its own span, not cut short when the short task ends. A tool that measures from the last task’s end, or splits the run’s time between tasks, reports the slow one as fast.',
    from: FROM,
    workspace: two(`sleep 1.5 && ${OUT}`, `sleep 0.2 && ${OUT}`),
    steps: [
      { run: 'build', expect: { exit: 0, report: { task: 'a#build', durationMs: [1450, 5000] } } },
    ],
  }),
  // Nx performance-life-cycle.spec.ts 'attributes slot queuing (spare cores) to recoverable-by-parallelism'.
  defineCase({
    id: 'report/queued-task-duration-excludes-wait',
    category: 'report',
    kind: 'data',
    title: 'A task that waited for a free slot reports only the time it ran',
    why: 'With one slot, the second of two independent tasks waits for the first. That wait is the queue’s, not the task’s. A tool that times from when the task was scheduled reports the queue as work and makes a concurrency limit look like a slow task.',
    from: FROM,
    workspace: two(`sleep 1 && ${OUT}`, `sleep 1 && ${OUT}`),
    steps: [
      {
        run: 'build',
        concurrency: 1,
        expect: { exit: 0, report: { task: 'a#build', durationMs: [950, 1900] } },
      },
    ],
  }),
  defineCase({
    id: 'report/queued-second-task-duration',
    category: 'report',
    kind: 'data',
    title: 'Both tasks that ran one after another under one slot report about their own time',
    why: 'Whichever of the two tasks ran second waited a second before it started. Its report still says about a second. Checking both makes sure the tool does not report the second one as two seconds, whatever order it picked.',
    from: FROM,
    workspace: two(`sleep 1 && ${OUT}`, `sleep 1 && ${OUT}`),
    steps: [
      {
        run: 'build',
        concurrency: 1,
        expect: { exit: 0, report: { task: 'b#build', durationMs: [950, 1900] } },
      },
    ],
  }),
  // Nx performance-life-cycle.spec.ts 'treats a parallelism:false task as occupying the whole pool'.
  defineCase({
    id: 'report/mutex-wait-not-in-duration',
    category: 'report',
    kind: 'data',
    title: 'A task held back by a mutex reports only the time it ran',
    why: 'Tasks sharing a mutex run one at a time, so one of them waits. The wait is not the task’s duration. A report that folds it in makes a task look slow because of a lock it had no part in holding.',
    from: FROM,
    needs: ['mutex'],
    workspace: two(`sleep 1 && ${OUT}`, `sleep 1 && ${OUT}`, { mutex: 'db' }),
    steps: [
      { run: 'build', expect: { exit: 0, report: { task: 'b#build', durationMs: [950, 1900] } } },
    ],
  }),
  once(
    'background-child-duration',
    'A task that waits for a background child reports the child’s time too',
    'A script that starts work in the background and waits for it is busy until the child ends. Its duration is the whole span. A tool that stops the clock when the first process forks reports a near-zero time for a task that took a second.',
    task(`(sleep 1) & wait; ${OUT}`),
    { durationMs: [950, 4000] },
  ),
  then(
    'rebuild-duration-follows-new-run',
    'A rebuild that is quicker reports the new short time, not the first one',
    'Each run’s report is of that run. When an edit makes a task fast, the rebuild reports the fast time. A tool that keeps the first duration it measured for the task shows a slowdown that was fixed.',
    one(task(`sleep "$(cat src/n.txt)" && ${OUT}`), { 'src/n.txt': '1.5\n' }),
    [{ write: { [`${A}/src/n.txt`]: '0.1\n' } }],
    { run: 'build', expect: reran },
    { durationMs: [80, 1200] },
  ),
  then(
    'uncached-duration-each-run',
    'A task with caching off reports each run’s own time',
    'A task that is never cached runs every time, and every run can take a different time. The report holds this run’s time. A tool that keeps the first run’s time for an uncached task hides how the task changed.',
    one(task(`sleep "$(cat src/n.txt)" && ${OUT}`, { cache: false }), { 'src/n.txt': '1.5\n' }),
    [{ write: { [`${A}/src/n.txt`]: '0.1\n' } }],
    { run: 'build', expect: reran },
    { durationMs: [80, 1200] },
    { needs: ['uncached-task'] },
  ),
  defineCase({
    id: 'report/dependency-duration-in-failed-run',
    category: 'report',
    kind: 'data',
    title: 'A dependency that ran before a failure reports its time',
    why: 'When a run fails, the tasks that passed still ran and cost time. The library’s duration is part of the report of the failed run. A tool that records times only for runs that pass loses the timings of exactly the runs a user reads.',
    from: FROM,
    workspace: pair(`sleep 0.5 && ${OUT}`, 'exit 1'),
    steps: [
      {
        run: 'build',
        expect: { exit: 'fail', report: { task: 'lib#build', durationMs: [480, 5000] } },
      },
    ],
  }),
  // Turborepo run_summary.rs: a HIT’s execution span is the replay, not the stored run.
  then(
    'restore-of-a-slow-task-is-quick',
    'Replaying a task that took two seconds reports a short time',
    'A hit restores outputs; it does not wait for the command. A two-second task replayed reports far less than two seconds. A tool that reports the stored run’s time for the hit makes the cache look useless.',
    one(task(`sleep 2 && ${OUT}`)),
    [{ write: { [`${A}/dist`]: null } }],
    { run: 'build', expect: replayed },
    { cache: 'hit', durationMs: [0, 1500] },
  ),
  once(
    'failed-task-duration-bounds',
    'A task that fails after a second reports about a second',
    'A failure’s duration is the time until the command exited. A task that fails after a second reports about a second, not zero and not the run’s whole length. That is how a user tells a quick crash from a slow one.',
    task('sleep 1 && exit 3'),
    { durationMs: [950, 3000] },
    { exit: 'fail' },
  ),
  once(
    'pipeline-duration',
    'A task made of a pipeline reports the time of the whole pipeline',
    'A shell pipeline ends when its last stage does. A task whose first stage sleeps for a second takes a second. A tool that times only the last stage’s process reports almost nothing.',
    task(`sleep 1 | cat && ${OUT}`),
    { durationMs: [950, 3000] },
  ),
]

const cpuCases: Case[] = [
  once(
    'busy-cpu-bounds',
    'A task that computes for half a second reports about that much CPU',
    'CPU time has a lower and an upper bound: a busy loop of known size uses a known amount. A tool reporting a hundred times more, from counting its own work or every process on the machine, is as wrong as one reporting none.',
    task(`${BUSY} && ${OUT}`),
    { cpuMs: [150, 10_000] },
  ),
  once(
    'cpu-sums-sequential-children',
    'A task that runs three busy steps one after another reports the CPU of all three',
    'A build script runs a compiler, a bundler and a minifier in turn. Each step is a child process and the task’s CPU is their sum. A tool that keeps only the last or the largest child reports a third of the cost.',
    task(`${BUSY} && ${BUSY} && ${BUSY} && ${OUT}`),
    { cpuMs: [600, 30_000] },
  ),
  // vx live-usage / runner: CPU is the whole tree’s, summed across processes.
  once(
    'cpu-sums-parallel-children',
    'A task that runs two busy children at once reports the CPU of both',
    'A task that fans out across cores uses CPU in each process at the same time. Its CPU is the sum, and can exceed the time it took. A tool that reports wall time as CPU, or one child’s CPU, undercounts the task that uses the machine hardest.',
    task(`(${BUSY}) & (${BUSY}) & wait; ${OUT}`),
    { cpuMs: [400, 30_000] },
  ),
  once(
    'cpu-counts-grandchildren',
    'A task reports the CPU of a process its child starts',
    'Package scripts nest: a shell runs a script that runs the compiler. The compiler is a grandchild of what the runner started and its CPU is the task’s. A tool that sums only direct children reports nearly nothing for that task.',
    task(`sh -c 'sh src/busy.sh' && ${OUT}`),
    { cpuMs: [150, 10_000] },
    { workspace: one(task(`sh -c 'sh src/busy.sh' && ${OUT}`), { 'src/busy.sh': `${BUSY}\n` }) },
  ),
  once(
    'cpu-counts-a-pipeline',
    'A task whose busy work is the first stage of a pipeline reports its CPU',
    'In a pipeline every stage is a process of the task. The busy stage is not the last one, so a tool that measures the last process misses it. The task reports the CPU of all its stages.',
    task(`${BUSY} | cat && ${OUT}`),
    { cpuMs: [150, 10_000] },
  ),
  once(
    'cpu-of-failed-task',
    'A task that fails after busy work reports its CPU',
    'A failed task cost CPU as surely as one that passed. A slow failing test is a reason to look at the report. A tool that records usage only for successes leaves the costliest failures without a number.',
    task(`${BUSY} && exit 1`),
    { cpuMs: [150, 10_000] },
    { exit: 'fail' },
  ),
  // vx runner: cpuTime.total is user plus system time.
  once(
    'cpu-counts-system-time',
    'A task that spends its time in system calls reports that CPU',
    'CPU time is user time plus system time. A task that copies data in small blocks spends most of its time in the kernel. A tool that reports only user time shows it as idle.',
    task(`dd if=/dev/zero of=/dev/null bs=512 count=2000000 2>/dev/null && ${OUT}`),
    { cpuMs: [100, 20_000] },
  ),
  once(
    'cpu-of-retried-task-all-attempts',
    'A retried task reports the CPU of every attempt',
    'A task that failed and passed on its retry ran its command twice. Both attempts used the machine. A tool that reports the last attempt only makes a flaky task look as cheap as a stable one.',
    task(`${BUSY}; if [ -f flag.txt ]; then ${OUT}; else touch flag.txt; exit 1; fi`, {
      retries: 1,
    }),
    { cpuMs: [400, 20_000] },
    {
      needs: ['retries'],
      workspace: {
        projects: {
          a: {
            tasks: {
              build: task(
                `${BUSY}; if [ -f flag.txt ]; then ${OUT}; else touch flag.txt; exit 1; fi`,
                { retries: 1 },
              ),
            },
            files: { 'src/a.txt': 'a\n', '.gitignore': 'flag.txt\n' },
          },
        },
      },
    },
  ),
  once(
    'idle-child-cpu-small',
    'A task that waits on a sleeping background child reports little CPU',
    'Waiting for a child is not work. A task whose only child sleeps uses almost no CPU, however long it takes. A tool that counts the wait as CPU, from wall time or a busy poll of its own, reports a cost that is not there.',
    task(`(sleep 1) & wait; ${OUT}`),
    { cpuMs: [0, 400] },
  ),
  then(
    'cpu-of-rebuild-is-this-run',
    'A rebuild that does less work reports less CPU',
    'Each run’s CPU is that run’s. An edit that makes a task cheap shows up in the next report. A tool that keeps the first CPU it saw for the task reports work that no longer happens.',
    one(task(`[ "$(cat src/n.txt)" = busy ] && ${BUSY}; ${OUT}`), { 'src/n.txt': 'busy\n' }),
    [{ write: { [`${A}/src/n.txt`]: 'idle\n' } }],
    { run: 'build', expect: reran },
    { cpuMs: [0, 200] },
  ),
  defineCase({
    id: 'report/parallel-tasks-own-cpu',
    category: 'report',
    kind: 'data',
    title: 'An idle task running beside a busy one reports its own small CPU',
    why: 'Tasks running at once share the machine but not their CPU. The idle task reports little even while a busy one runs next to it. A tool that reads the machine’s or the runner’s CPU for each task gives both the busy task’s cost.',
    from: FROM,
    workspace: two(`${BUSY} && ${BUSY} && ${OUT}`, `sleep 0.5 && ${OUT}`),
    steps: [{ run: 'build', expect: { exit: 0, report: { task: 'b#build', cpuMs: [0, 300] } } }],
  }),
  defineCase({
    id: 'report/dependant-cpu-is-its-own',
    category: 'report',
    kind: 'data',
    title: 'A cheap task after a busy dependency reports its own small CPU',
    why: 'CPU belongs to the process tree that used it. The app that runs after a busy library uses almost none. A tool that measures the runner’s CPU between a task’s start and end, or accumulates it across tasks, charges the app for the library.',
    from: FROM,
    workspace: pair(`${BUSY} && ${BUSY} && ${OUT}`, OUT),
    steps: [{ run: 'build', expect: { exit: 0, report: { task: 'app#build', cpuMs: [0, 300] } } }],
  }),
]

const MB = 1_000_000
const memoryCases: Case[] = [
  once(
    'memory-of-100mb',
    'A task that fills a 100 MB buffer reports at least 100 MB of peak memory',
    'Peak memory is what decides whether a task fits on a runner. A task holding a 100 MB buffer peaks above 100 MB. A tool that reports less, from sampling too rarely or reading the wrong process, lets a team pick a runner that runs out of memory.',
    task(`dd if=/dev/zero bs=100M count=1 of=/dev/null 2>/dev/null && ${OUT}`),
    { peakMemoryBytes: [100 * MB, 4000 * MB] },
  ),
  once(
    'memory-upper-bound',
    'A task that fills a 64 MB buffer reports well under a gigabyte',
    'An upper bound matters as much as a lower one. A task that holds 64 MB peaks near that. A tool that adds its own footprint, or counts the whole machine, reports a number that makes a small task look like the one to move to a bigger runner.',
    task(`dd if=/dev/zero bs=64M count=1 of=/dev/null 2>/dev/null && ${OUT}`),
    { peakMemoryBytes: [60 * MB, 300 * MB] },
  ),
  once(
    'tiny-task-memory-small',
    'A task that does almost nothing reports a small peak memory',
    'A shell that writes one empty file needs a few megabytes. Its peak memory says so. A tool that reports its own memory, or a parent’s inherited mark, makes every small task look as heavy as the runner itself.',
    task(OUT),
    { peakMemoryBytes: [100_000, 40 * MB] },
  ),
  once(
    'memory-of-a-grandchild',
    'A task reports the memory of a process its child starts',
    'The process that needs the memory is often deep in the tree: a script that starts a compiler. Its peak is the task’s peak. A tool that reads only the process it started reports the few megabytes of a shell.',
    task(`sh -c "dd if=/dev/zero bs=64M count=1 of=/dev/null 2>/dev/null" && ${OUT}`),
    { peakMemoryBytes: [60 * MB, 4000 * MB] },
  ),
  once(
    'memory-sequential-not-summed',
    'A task that runs two 64 MB steps one after another reports one step’s peak',
    'Peak memory is the most the task held at once. Two steps that run in turn never hold their buffers together, so the peak is about 64 MB, not 128. A tool that adds each process’s peak tells a team to buy memory the task never uses.',
    task(
      `dd if=/dev/zero bs=64M count=1 of=/dev/null 2>/dev/null && dd if=/dev/zero bs=64M count=1 of=/dev/null 2>/dev/null && ${OUT}`,
    ),
    { peakMemoryBytes: [60 * MB, 120 * MB] },
  ),
  // vx live-usage: a tree’s peak is what its processes held at once.
  once(
    'memory-parallel-children-summed',
    'A task that runs two 64 MB processes at once reports their combined peak',
    'Two processes holding 64 MB each at the same moment need 128 MB of the machine. That is the task’s peak. A tool that reports the largest single process says the task fits where it does not, and the runner is killed for running out of memory.',
    task(
      `(dd if=/dev/zero bs=64M count=400 of=/dev/null 2>/dev/null) & (dd if=/dev/zero bs=64M count=400 of=/dev/null 2>/dev/null) & wait; ${OUT}`,
    ),
    { peakMemoryBytes: [120 * MB, 4000 * MB] },
  ),
  once(
    'memory-of-failed-task',
    'A task that fails after using a lot of memory reports its peak',
    'A task that runs out of headroom often fails. Its peak memory is the clue to why. A tool that records memory only for tasks that pass hides the number when it matters most.',
    task('dd if=/dev/zero bs=64M count=1 of=/dev/null 2>/dev/null && exit 1'),
    { peakMemoryBytes: [60 * MB, 4000 * MB] },
    { exit: 'fail' },
  ),
  defineCase({
    id: 'report/parallel-tasks-own-memory',
    category: 'report',
    kind: 'data',
    title: 'A small task running beside a large one reports its own small peak',
    why: 'Memory, like CPU, belongs to the task that used it. A small task running next to one that holds 100 MB peaks at a few megabytes. A tool that reads the runner’s or the machine’s memory charges each task for its neighbours.',
    from: FROM,
    workspace: two(
      `dd if=/dev/zero bs=100M count=30 of=/dev/null 2>/dev/null && ${OUT}`,
      `sleep 0.5 && ${OUT}`,
    ),
    steps: [
      {
        run: 'build',
        expect: { exit: 0, report: { task: 'b#build', peakMemoryBytes: [100_000, 40 * MB] } },
      },
    ],
  }),
  // vx own-rss-high-water: a child’s maxrss inherits the parent’s mark at exec.
  defineCase({
    id: 'report/dependant-memory-is-its-own',
    category: 'report',
    kind: 'data',
    title: 'A small task after a large dependency reports its own small peak',
    why: 'A high-water mark is easy to carry over by mistake: the runner’s own peak rises with the first heavy task and every later task inherits it. The app after a 100 MB library still peaks at a few megabytes. Its report says so.',
    from: ['last', 'own-rss-high-water'],
    workspace: pair(`dd if=/dev/zero bs=100M count=1 of=/dev/null 2>/dev/null && ${OUT}`, OUT),
    steps: [
      {
        run: 'build',
        expect: { exit: 0, report: { task: 'app#build', peakMemoryBytes: [100_000, 40 * MB] } },
      },
    ],
  }),
]

const W = (n: number, f = 'out.bin') => `head -c ${n} /dev/zero > dist/${f}`

const sizeCases: Case[] = [
  once(
    'output-size-nested-dirs',
    'A run reports the total size of outputs in nested directories',
    'Build outputs are trees: a bundle, its chunks, their assets. The size is every file’s bytes, at any depth. A tool that counts only the top level, or the directories’ own entries, reports the wrong size. 100, 200 and 300 bytes in three levels are 600.',
    task(
      'mkdir -p dist/x/y && head -c 100 /dev/zero > dist/a.bin && head -c 200 /dev/zero > dist/x/b.bin && head -c 300 /dev/zero > dist/x/y/c.bin',
    ),
    { outputBytes: [600, 600] },
  ),
  once(
    'output-size-random-bytes',
    'A run reports the real size of outputs that do not compress',
    'The size of an output is its length, not what it takes once compressed. Random bytes do not compress and zeros compress to almost nothing; both report their length. A tool that reports the archive’s size gives two answers for the same number of bytes.',
    task('mkdir -p dist && head -c 4096 /dev/urandom > dist/out.bin'),
    { outputBytes: [4096, 4096] },
  ),
  once(
    'output-size-large-file',
    'A run reports the size of a five megabyte output',
    'A large output is the one that makes a cache slow. Its size is reported exactly, five million bytes, not rounded to blocks or capped by a buffer. A tool that reads only a file’s first chunk reports a small number for the file a user most needs to see.',
    task(`mkdir -p dist && ${W(5_000_000)}`),
    { outputBytes: [5_000_000, 5_000_000] },
  ),
  then(
    'restored-size-of-large-file',
    'A run reports the size of a five megabyte output it restored',
    'Restoring a large output is the cost of a hit. The report counts what came back, five million bytes. A tool that reports the compressed entry it fetched hides how much the restore wrote to disk.',
    one(task(`mkdir -p dist && ${W(5_000_000)}`)),
    [{ write: { [`${A}/dist`]: null } }],
    { run: 'build', expect: replayed },
    { outputBytes: [5_000_000, 5_000_000] },
  ),
  // vx run-history-bytes: output bytes are the files’ lengths.
  once(
    'output-size-sparse-file',
    'A run reports a sparse output by its length, not the disk it takes',
    'A sparse file of one megabyte may take no disk at all until written, yet a cache stores and restores a megabyte. Its size in the report is its length. A tool that counts disk blocks reports zero for a file the cache must move in full.',
    task('mkdir -p dist && : > dist/out.bin && truncate -s 1048576 dist/out.bin'),
    { outputBytes: [1_048_576, 1_048_576] },
  ),
  // vx run-history-bytes: a link is stored as a link.
  once(
    'output-size-symlink-not-doubled',
    'A run does not count a symlinked output’s target twice',
    'A link in the outputs points at another output. It is stored as a link, so its cost is a path, not a second copy of the target. A thousand-byte file and a link to it report about a thousand bytes; a tool reporting two thousand stores the file twice or counts it twice.',
    task('mkdir -p dist && head -c 1000 /dev/zero > dist/out.bin && ln -s out.bin dist/link.bin'),
    { outputBytes: [1000, 1100] },
  ),
  once(
    'output-size-overlapping-globs-once',
    'A run counts a file matched by two output patterns once',
    'Output patterns overlap: `dist/**` and `dist/*.js` both match a bundle. The file is stored once and its size is counted once. A tool that adds each pattern’s matches reports twice the bytes.',
    task(`mkdir -p dist && ${W(700, 'a.js')}`, { outputs: ['dist/**', 'dist/*.js'] }),
    { outputBytes: [700, 700] },
  ),
  once(
    'output-size-two-output-dirs',
    'A run reports outputs spread over two directories',
    'A task can write a bundle in one directory and type declarations in another. Both are its outputs and both count. 400 bytes in one and 600 in the other are 1000.',
    task(`mkdir -p dist types && ${W(400)} && head -c 600 /dev/zero > types/a.d.ts`, {
      outputs: ['dist/**', 'types/**'],
    }),
    { outputBytes: [1000, 1000] },
  ),
  once(
    'output-size-root-outputs',
    'A run counts outputs a task writes outside its project',
    'Some tasks write to a shared directory at the workspace root, such as a coverage report. Declared as outputs, those bytes are stored with the task. A tool that counts only files under the project reports zero for them.',
    task(
      `mkdir -p dist ../../coverage && ${W(300)} && head -c 500 /dev/zero > ../../coverage/a.json`,
      {
        rootOutputs: ['coverage/a.json'],
      },
    ),
    { outputBytes: [800, 800] },
  ),
  defineCase({
    id: 'report/output-size-per-task',
    category: 'report',
    kind: 'data',
    title: 'Two tasks of one project each report the size of their own outputs',
    why: 'A project’s build and pack write different files. Each task’s size is its own outputs’, not the project’s total. A tool that sums the project tells the user to trim the wrong task.',
    from: FROM,
    needs: ['multi-task'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: task(`mkdir -p dist && ${W(1000)}`),
            pack: task('mkdir -p pkg && head -c 3000 /dev/zero > pkg/a.tgz', {
              outputs: ['pkg/**'],
            }),
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        also: ['pack'],
        expect: { exit: 0, report: { task: 'a#pack', outputBytes: [3000, 3000] } },
      },
    ],
  }),
  defineCase({
    id: 'report/dependant-size-excludes-dependency',
    category: 'report',
    kind: 'data',
    title: 'A task that reads its dependency’s outputs reports only its own',
    why: 'The app reads the library’s build; it does not own it. Its output size is what it wrote. A tool that counts the files a task can see, rather than what it declares, charges the app for the library’s bytes.',
    from: FROM,
    workspace: pair(`mkdir -p dist && ${W(4000)}`, `mkdir -p dist && ${W(200)}`),
    steps: [
      { run: 'build', expect: { exit: 0, report: { task: 'app#build', outputBytes: [200, 200] } } },
    ],
  }),
  then(
    'dependency-restored-size-beside-a-miss',
    'A replayed dependency reports its restored size while its dependant runs',
    'In a run where the library replays and the app rebuilds, the library’s report counts what it restored. A tool that reports sizes only for tasks that ran leaves the hit’s cost out of the run.',
    pair(`mkdir -p dist && ${W(4000)}`, `mkdir -p dist && ${W(200)}`),
    [
      { write: { 'packages/lib/dist': null } },
      { write: { 'packages/app/src/a.txt': 'changed\n' } },
    ],
    { run: 'build', expect: { notRan: ['lib#build'], ran: ['app#build'] } },
    { cache: 'hit', outputBytes: [4000, 4000] },
    { of: 'lib#build' },
  ),
  then(
    'restored-size-nested-dirs',
    'A run reports the total size of a nested output tree it restored',
    'A restore puts back a whole tree. Its size is every file at every depth, as it was when stored. 100, 200 and 300 bytes in three levels restore as 600.',
    one(
      task(
        'mkdir -p dist/x/y && head -c 100 /dev/zero > dist/a.bin && head -c 200 /dev/zero > dist/x/b.bin && head -c 300 /dev/zero > dist/x/y/c.bin',
      ),
    ),
    [{ write: { [`${A}/dist`]: null } }],
    { run: 'build', expect: replayed },
    { outputBytes: [600, 600] },
  ),
  then(
    'restored-size-random-bytes',
    'A run reports the length of restored outputs that do not compress',
    'A restored output’s size is its length on disk once restored. Random bytes come back as 4096 bytes, whatever the entry took in the store. A tool reporting the stored entry’s size mixes the store’s format into a number about the task.',
    one(task('mkdir -p dist && head -c 4096 /dev/urandom > dist/out.bin')),
    [{ write: { [`${A}/dist`]: null } }],
    { run: 'build', expect: replayed },
    { outputBytes: [4096, 4096] },
  ),
  defineCase({
    id: 'report/output-size-read-only-run',
    category: 'report',
    kind: 'data',
    title: 'A task run under a read-only cache reports the size of what it wrote',
    why: 'A read-only run saves nothing, but the task still wrote its outputs. Their size is a fact about the task, and the number a user needs to decide whether a save would be worth it. 2000 bytes written report as 2000.',
    from: FROM,
    needs: ['read-only-cache'],
    workspace: one(task(`mkdir -p dist && ${W(2000)}`)),
    steps: [
      {
        run: 'build',
        readOnlyCache: true,
        expect: { exit: 0, report: { task: 'a#build', outputBytes: [2000, 2000] } },
      },
    ],
  }),

  once(
    'output-size-dotfile-in-output-dir',
    'A run counts a named hidden file in the outputs',
    'Outputs include hidden files such as `.d.ts` stamps or `.map` caches when the pattern names them. A file named outright is an output whatever its first character. 300 bytes and a 200-byte hidden file are 500.',
    task(`mkdir -p dist && ${W(300)} && head -c 200 /dev/zero > dist/.stamp`, {
      outputs: ['dist/out.bin', 'dist/.stamp'],
    }),
    { outputBytes: [500, 500] },
  ),
  once(
    'output-size-file-with-space',
    'A run counts an output whose name has a space in it',
    'File names with spaces are common in generated assets. A tool that splits paths on spaces loses those files from its count, and often from its cache. A 900-byte file named with a space reports 900.',
    task('mkdir -p dist && head -c 900 /dev/zero > "dist/my file.bin"'),
    { outputBytes: [900, 900] },
  ),
  once(
    'output-size-overwritten-file',
    'A run reports the size a file has at the end, not every write to it',
    'A task can write a file and then rewrite it shorter. What is stored is the final file. 5000 bytes rewritten as 100 report 100; a tool that adds up writes, or measures as the task goes, reports the wrong cost.',
    task(`mkdir -p dist && ${W(5000)} && ${W(100)}`),
    { outputBytes: [100, 100] },
  ),
  once(
    'output-size-deleted-file',
    'A run does not count an output file the task deleted before it ended',
    'Temporary files under an output directory that the task removes are gone when it ends, and nothing stores them. A 5000-byte file deleted and a 100-byte one kept report 100.',
    task(`mkdir -p dist && ${W(5000, 'tmp.bin')} && ${W(100)} && rm dist/tmp.bin`),
    { outputBytes: [100, 100] },
  ),
  then(
    'output-size-shrinks-on-rebuild',
    'A rebuild that writes less reports the smaller size',
    'An output can shrink when code is removed. The rebuild’s report counts what this run wrote, not the larger size of a file left over from before. A tool that adds to the old size, or keeps the old file in the count, hides the win.',
    one(task('mkdir -p dist && head -c "$(cat src/n.txt)" /dev/zero > dist/out.bin'), {
      'src/n.txt': '3000\n',
    }),
    [{ write: { [`${A}/src/n.txt`]: '200\n' } }],
    { run: 'build', expect: reran },
    { outputBytes: [200, 200] },
  ),
]

/** A section’s cases drawn from these vx tests too. */
const drawn = (cases: Case[], more: string[]): Case[] =>
  cases.map((c) => ({ ...c, from: Array.from(new Set(c.from.concat(more))) }))

export default [
  ...drawn(cacheCases, ['summary']),
  ...drawn(durationCases, ['history']),
  ...drawn(cpuCases, ['runner', 'live-usage']),
  ...drawn(memoryCases, ['runner', 'live-usage']),
  ...drawn(sizeCases, ['run-history-bytes', 'raw-output-bytes']),
]
