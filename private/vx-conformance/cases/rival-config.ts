// Workspaces a tool must refuse, values that must key apart, and what a run
// reports, drawn from Turborepo's crates/turborepo/tests
// (invalid_package_json_test.rs test_malformed_package_json;
// final_hash_contract.rs env_mode_hashes; run_summary.rs) and moon's
// crates/cli/tests/exec_test.rs (creates_run_report).
import { defineCase, type Case, type TaskSpec } from '../src/spec.ts'
import { chainProject, one } from './shapes.ts'

const A = 'packages/a'
const OUT = `${A}/dist/out.txt`

const task = (command: string, extra: Partial<TaskSpec> = {}): TaskSpec => ({
  command,
  inputs: ['src/**'],
  outputs: ['dist/**'],
  ...extra,
})

const BUILD = task('mkdir -p dist && cat src/a.txt > dist/out.txt')

/** Project `b`'s package.json replaced by `manifest`: the run must fail, building nothing. */
function badManifest(id: string, title: string, why: string, manifest: string): Case {
  return defineCase({
    id: `config/${id}`,
    category: 'config',
    kind: 'correctness',
    title,
    why,
    from: ['discovery-refusals', 'package-json-bom'],
    workspace: {
      projects: {
        a: { tasks: { build: BUILD }, files: { 'src/a.txt': 'a\n' } },
        b: { tasks: { build: BUILD }, files: { 'src/a.txt': 'b\n', 'package.json': manifest } },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 'fail', notRan: ['a#build', 'b#build'], orRefused: true } },
    ],
  })
}

/** Two declared values that must key two results. */
function envPair(id: string, title: string, why: string, first: string, second: string): Case {
  return defineCase({
    id: `env/${id}`,
    category: 'env',
    kind: 'correctness',
    title,
    why,
    from: ['env', 'hash-scenarios-names'],
    needs: ['env-inputs'],
    workspace: one(
      task('mkdir -p dist && printf "%s" "$MODE" | od -An -tx1 | tr -d " \\n" > dist/out.txt', {
        env: ['MODE'],
      }),
    ),
    steps: [
      { run: 'build', env: { MODE: first }, expect: { exit: 0 } },
      { run: 'build', env: { MODE: second }, expect: { exit: 0, ran: ['a#build'] } },
    ],
  })
}

const WRITE = (n: number) => `mkdir -p dist && head -c ${n} /dev/zero > dist/out.bin`

export default [
  badManifest(
    'package-json-not-an-object-refused',
    'A workspace package whose package.json is an array fails the run',
    'A manifest that parses but is not an object has no name, no dependencies and no scripts. A tool that skips it silently drops a project the workspace lists; one that reads it as empty builds without its edges. The run fails before anything builds.',
    '[]\n',
  ),

  // final_hash_contract.rs env_mode_hashes
  envPair(
    'unicode-normalisation-keys',
    'A declared value in composed and decomposed Unicode forms keys two results',
    'An `é` can be one code point or `e` plus a combining accent: they look alike and are different bytes, and a program comparing them sees two values. A tool that normalises values before keying replays one form’s result for the other. The second run runs.',
    'é',
    'é',
  ),
  envPair(
    'leading-zero-value-keys',
    'Declared values `1` and `01` key two results',
    'Values are strings, not numbers: a version `01`, a port `0080`, a code. A tool that parses numeric-looking values before keying folds them together and replays a result built from the other. The second run runs.',
    '1',
    '01',
  ),
  envPair(
    'newline-and-space-values-key-apart',
    'A declared value holding a newline is not the same as one holding a space there',
    'A tool that writes values one per line into its key, or that normalises whitespace, folds `a b` and `a`+newline+`b` into one key. Programs reading the variable see different values. The second run runs.',
    'a b',
    'a\nb',
  ),

  // run_summary.rs, exec_test.rs creates_run_report
  defineCase({
    id: 'report/dependency-hit-beside-a-miss',
    category: 'report',
    kind: 'data',
    title: 'A run reports a replayed dependency as a hit while its dependant runs',
    why: 'When only the app changed, its library replays and the app runs. The report must say so per task, or the user cannot tell whether the library’s cache works. A tool that reports a run as one status, or calls every task of a run with a miss a miss, hides where time went.',
    from: ['last', 'run-history-columns'],
    workspace: { projects: { lib: chainProject('lib'), app: chainProject('app', ['lib']) } },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/app/src/a.txt': 'app2\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['app#build'], report: { task: 'lib#build', cache: 'hit' } },
      },
    ],
  }),

  defineCase({
    id: 'report/dependant-miss-beside-a-hit',
    category: 'report',
    kind: 'data',
    title: 'A run reports the dependant that ran as a miss while its dependency replays',
    why: 'The task that actually ran is the one to look at when a run is slow. Its status must be its own, not the first task’s or the run’s. A report that marks every task by the run’s overall cache state points at the wrong task.',
    from: ['last', 'run-history-columns'],
    workspace: { projects: { lib: chainProject('lib'), app: chainProject('app', ['lib']) } },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/app/src/a.txt': 'app2\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['app#build'], report: { task: 'app#build', cache: 'miss' } },
      },
    ],
  }),

  defineCase({
    id: 'report/forced-run-reports-miss',
    category: 'report',
    kind: 'data',
    title: 'A forced run reports the task it ran as a miss',
    why: 'Forcing a run makes every task run whatever the cache holds. Reporting it as a hit because an entry existed tells the user the task was replayed when it ran. The report says the task missed.',
    from: ['last', 'run-history-columns'],
    needs: ['force'],
    workspace: one(task(WRITE(100))),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      {
        run: 'build',
        force: true,
        expect: { exit: 0, ran: ['a#build'], report: { task: 'a#build', cache: 'miss' } },
      },
    ],
  }),

  defineCase({
    id: 'report/failed-task-duration',
    category: 'report',
    kind: 'data',
    title: 'A run reports how long a failed task took',
    why: 'A task that fails after minutes is the one that wastes CI time. Its duration matters as much as a passing task’s, and more when it times out or flakes. A tool that records time only for successes leaves the slowest failure invisible.',
    from: ['last', 'run-history-columns'],
    workspace: one(task('sleep 0.3 && exit 1')),
    steps: [
      {
        run: 'build',
        expect: { exit: 'fail', report: { task: 'a#build', durationMs: [280, 20_000] } },
      },
    ],
  }),

  defineCase({
    id: 'report/no-outputs-size-zero',
    category: 'report',
    kind: 'data',
    title: 'A run reports zero bytes for a task that declares no outputs',
    why: 'A check (lint, typecheck, test) writes nothing to cache. Its output size is zero, a real value, not a missing one. A tool that reports nothing, or the log’s size, makes cache-size accounting wrong for every check.',
    from: ['last', 'run-history-columns'],
    workspace: one(task('true', { outputs: [] })),
    steps: [
      { run: 'build', expect: { exit: 0, report: { task: 'a#build', outputBytes: [0, 0] } } },
    ],
  }),

  defineCase({
    id: 'report/many-files-restored-size',
    category: 'report',
    kind: 'data',
    title: 'A run reports the total size of a hundred output files it restored',
    why: 'Restore cost grows with what is restored. The report must total every file, not the first or the archive’s compressed size. A hundred files of a hundred bytes restored is ten thousand bytes.',
    from: ['last', 'run-history-columns'],
    workspace: one(
      task(
        'mkdir -p dist && i=0; while [ $i -lt 100 ]; do head -c 100 /dev/zero > dist/$i.bin; i=$((i+1)); done',
      ),
    ),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist`]: null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['a#build'],
          report: { task: 'a#build', outputBytes: [10000, 10000] },
        },
      },
    ],
  }),

  defineCase({
    id: 'report/many-files-written-size',
    category: 'report',
    kind: 'data',
    title: 'A run reports the total size of a hundred output files a task wrote',
    why: 'Output size is how a team finds the task that bloats its cache. It is the sum of every file the task wrote, not the largest or the last. A hundred files of a hundred bytes is ten thousand bytes.',
    from: ['last', 'run-history-columns'],
    workspace: one(
      task(
        'mkdir -p dist && i=0; while [ $i -lt 100 ]; do head -c 100 /dev/zero > dist/$i.bin; i=$((i+1)); done',
      ),
    ),
    steps: [
      {
        run: 'build',
        expect: { exit: 0, report: { task: 'a#build', outputBytes: [10000, 10000] } },
      },
    ],
  }),

  defineCase({
    id: 'env/pass-through-change-replays-dependants',
    category: 'env',
    kind: 'efficiency',
    title:
      'A change to a variable a dependency passes through replays the dependency and its dependants',
    why: 'A passed-through variable (a token, a cache directory) reaches the command without keying it. A tool that still folds it into the dependency’s key cascades the change into every dependant, rebuilding a chain for a value no build depends on. Both replay.',
    from: ['env', 'affected-pass-through'],
    needs: ['pass-through-env'],
    workspace: {
      projects: {
        lib: {
          tasks: { build: { ...chainProject('lib').tasks!.build!, passThrough: ['TOKEN'] } },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: chainProject('app', ['lib']),
      },
    },
    steps: [
      { run: 'build', env: { TOKEN: 'one' }, expect: { exit: 0 } },
      {
        run: 'build',
        env: { TOKEN: 'two' },
        expect: { exit: 0, notRan: ['lib#build', 'app#build'] },
      },
    ],
  }),

  defineCase({
    id: 'env/declared-in-both-chain-links-reruns-both',
    category: 'env',
    kind: 'correctness',
    title: 'A variable both a dependency and its dependant declare reruns both when it changes',
    why: 'When a value shapes both builds, both results are stale after it moves. The dependant must not replay on the grounds that its own files did not change. Both run and the dependant holds the new value.',
    from: ['env', 'hash-scenarios-names'],
    needs: ['env-inputs'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: task('mkdir -p dist && printf "%s\\n" "$MODE" > dist/out.txt', {
              env: ['MODE'],
            }),
          },
          files: { 'src/a.txt': 'l\n' },
        },
        app: {
          deps: ['lib'],
          tasks: {
            build: task(
              'mkdir -p dist && { cat ../lib/dist/out.txt; printf "%s\\n" "$MODE"; } > dist/out.txt',
              {
                dependsOn: ['^build'],
                env: ['MODE'],
              },
            ),
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      { run: 'build', env: { MODE: 'x' }, expect: { exit: 0 } },
      {
        run: 'build',
        env: { MODE: 'y' },
        expect: {
          exit: 0,
          ran: ['lib#build', 'app#build'],
          files: { 'packages/app/dist/out.txt': 'y\ny\n' },
        },
      },
    ],
  }),
]
