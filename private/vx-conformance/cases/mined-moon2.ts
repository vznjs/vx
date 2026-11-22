// More outcomes drawn from moon (moonrepo/moon): its action-graph,
// action-pipeline, task-runner, output archiver and hydrater tests, its
// affected tracker, and the "Fixed ..." entries of its CHANGELOG. Each case
// names the moon test or fix it ports; `from` names the vx tests guarding the
// same outcome. Mutexes and optional outputs are moon features vx lacks, so
// those cases run against the tools that have them.
import { defineCase, MEET, type Case, type ProjectSpec, type TaskSpec } from '../src/spec.ts'
import { chainBuild as chainBuildOf, chainProject, out } from './shapes.ts'

const A = 'packages/a'

/** A cached `check` over the project's sources that waits for its dependencies’ `check`. */
function linked(deps: string[] = [], extra: Partial<ProjectSpec> = {}): ProjectSpec {
  return {
    deps,
    tasks: { check: { command: 'true', inputs: ['src/**'], dependsOn: ['^check'] } },
    files: { 'src/a.txt': 'x\n' },
    ...extra,
  }
}

const checks = (...names: string[]) => names.map((n) => `${n}#check`)

/** Waits up to 20 s for `../../.home/meet/<other>` after marking itself, then says whether it came. */
const meet = (me: string, other: string) =>
  `mkdir -p ../../${MEET} && touch ../../${MEET}/${me} && i=0; while [ ! -e ../../${MEET}/${other} ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done; if [ -e ../../${MEET}/${other} ]; then echo met > met.txt; else echo alone > met.txt; fi`

/** Waits up to 10 s for any `../../started-*` mark, then fails. */
const FAIL_ONCE_STARTED =
  'i=0; while ! ls ../../started-* >/dev/null 2>&1 && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done; exit 1'

/** Copies the project's own source; reads nothing of its dependencies. */
const OWN_BUILD: TaskSpec = {
  command: 'mkdir -p dist && cat src/a.txt > dist/out.txt',
  inputs: ['src/**'],
  outputs: ['dist/**'],
}

/** Writes `overlap.txt` at the root when another holder of the lock is inside. */
const HOLD =
  'if [ -e ../../held ]; then echo overlap >> ../../overlap.txt; fi; touch ../../held; sleep 1; rm -f ../../held; echo done > done.txt'

const uncached = (command: string, extra: Partial<TaskSpec> = {}): TaskSpec => ({
  command,
  cache: false,
  ...extra,
})

export default [
  // action-graph action_graph_builder_test.rs dependents::deep_doesnt_expand_dependents_of_dependencies;
  // CHANGELOG: "`--downstream deep` would also expand the dependents of upstream dependencies"
  defineCase({
    id: 'graph/dependents-walk-leaves-a-dependencys-other-users',
    category: 'graph',
    kind: 'efficiency',
    title:
      'Selecting a project with its dependents builds its dependency, but not that dependency’s other users',
    why: 'ui’s check needs utils’ check, so utils runs as a dependency. admin also uses utils, but admin neither builds on ui nor is built on by it. Walking dependents from utils as well, because it entered the run, pulls in admin and, in a deep enough graph, the whole workspace. Only what builds on ui, and what that needs, belongs in the run.',
    from: ['filter', 'select'],
    needs: ['filter', 'select-walk'],
    workspace: {
      projects: {
        utils: linked(),
        ui: linked(['utils']),
        app: linked(['ui']),
        admin: linked(['utils']),
      },
    },
    steps: [
      {
        run: 'check',
        select: [{ name: 'ui', with: 'dependents' }],
        expect: {
          exit: 0,
          ran: checks('utils', 'ui', 'app'),
          notRan: checks('admin'),
          order: [
            ['utils#check', 'ui#check'],
            ['ui#check', 'app#check'],
          ],
        },
      },
    ],
  }),

  // action-graph action_graph_builder_test.rs dependents::deep_expands_dependents_when_dependency_is_also_a_target;
  // CHANGELOG: "a task's dependents would not run ... if the task was first added to the action graph as a dependency"
  defineCase({
    id: 'graph/dependents-walk-of-a-project-another-selection-needs',
    category: 'graph',
    kind: 'correctness',
    title:
      'A library selected with its dependents gets them all, though another selected project already needs it',
    why: 'app is selected on its own and needs lib, so lib enters the run as app’s dependency. lib is also selected with its dependents, which takes tool as well. A tool that adds lib once as a dependency and then skips the walk from it drops tool, though the user asked for it by name.',
    from: ['filter', 'select'],
    needs: ['filter', 'select-walk'],
    workspace: {
      projects: {
        lib: linked(),
        app: linked(['lib']),
        tool: linked(['lib']),
        docs: linked(),
      },
    },
    steps: [
      {
        run: 'check',
        select: [{ name: 'app' }, { name: 'lib', with: 'dependents' }],
        expect: {
          exit: 0,
          ran: checks('lib', 'app', 'tool'),
          notRan: checks('docs'),
          order: [
            ['lib#check', 'app#check'],
            ['lib#check', 'tool#check'],
          ],
        },
      },
    ],
  }),

  // task-builder task_deps_builder_test.rs parent_deps_scope::returns_each_parent_task_only_if_id_matches, over a walk
  defineCase({
    id: 'graph/dependents-walk-crosses-a-project-without-the-task',
    category: 'graph',
    kind: 'correctness',
    title:
      'Selecting a library with its dependents reaches a project that uses it through one without the task',
    why: 'app uses lib only through mid, and mid declares no check. app is still a dependent of lib, and its check still builds on lib’s, through mid. A walk that stops at the first project lacking the task leaves app unchecked on a change that can break it.',
    from: ['filter', 'task-selection'],
    needs: ['filter', 'select-walk'],
    workspace: {
      projects: {
        lib: linked(),
        mid: { deps: ['lib'], files: { 'src/a.txt': 'm\n' } },
        app: linked(['mid']),
        docs: linked(),
      },
    },
    steps: [
      {
        run: 'check',
        select: [{ name: 'lib', with: 'dependents' }],
        expect: {
          exit: 0,
          ran: checks('lib', 'app'),
          notRan: checks('docs'),
          order: [['lib#check', 'app#check']],
        },
      },
    ],
  }),

  // task-runner command_executor_test.rs doesnt_retry_once_the_pipeline_is_aborted;
  // CHANGELOG: "a task with `options.retryCount` would attempt to run again after the pipeline was aborted"
  defineCase({
    id: 'failure/fail-fast-ends-a-running-tasks-retries',
    category: 'failure',
    kind: 'correctness',
    title: 'A fail-fast run stopped by one task’s failure does not retry another task it stopped',
    why: 'b is running its first attempt when a fails and the run stops it. That attempt ends because the run ended it, not because b failed on its own, and the run is over. Starting b again leaves a process running after the runner exits, doing work nobody will see.',
    from: ['fail-fast', 'retries'],
    needs: ['fail-fast', 'retries'],
    workspace: {
      projects: {
        a: { tasks: { build: uncached(FAIL_ONCE_STARTED) } },
        b: {
          tasks: {
            build: uncached('echo x >> attempts.txt; touch ../../started-b; sleep 5; exit 1', {
              retries: 2,
            }),
          },
        },
      },
    },
    steps: [
      {
        run: 'build',
        concurrency: 2,
        failFast: true,
        expect: {
          exit: 'fail',
          files: { 'packages/b/attempts.txt': 'x\n' },
          within: 20,
          alone: true,
        },
      },
      { sh: 'sleep 1' },
      { sh: '[ "$(cat packages/b/attempts.txt)" = x ]' },
    ],
  }),

  // action-pipeline action_pipeline_test.rs abort::doesnt_run_a_task_that_was_waiting_on_a_mutex;
  // CHANGELOG: "a task that had yet to run its command when the pipeline was aborted ... (waiting on a `mutex`) would run it afterwards"
  defineCase({
    id: 'failure/fail-fast-never-starts-a-task-waiting-on-a-mutex',
    category: 'failure',
    kind: 'correctness',
    title: 'A fail-fast run never starts a task that was still waiting for a shared lock',
    why: 'b and c share a lock, so one runs while the other waits. When a fails, the run stops the one running. The one waiting has not started, and failing fast means nothing else starts. Giving it the lock once the holder is stopped runs a process after the run has already failed.',
    from: ['fail-fast'],
    needs: ['fail-fast', 'mutex'],
    workspace: {
      projects: {
        a: { tasks: { build: uncached(FAIL_ONCE_STARTED) } },
        b: {
          tasks: {
            build: uncached('touch ../../started-b; sleep 5; echo done > out.txt', { mutex: 'db' }),
          },
        },
        c: {
          tasks: {
            build: uncached('touch ../../started-c; sleep 5; echo done > out.txt', { mutex: 'db' }),
          },
        },
      },
    },
    steps: [
      {
        run: 'build',
        concurrency: 3,
        failFast: true,
        expect: {
          exit: 'fail',
          files: { 'packages/b/out.txt': null, 'packages/c/out.txt': null },
          within: 20,
          alone: true,
        },
      },
      { sh: 'sleep 1; [ "$(ls started-b started-c 2>/dev/null | wc -l)" -eq 1 ]' },
    ],
  }),

  // action-pipeline action_pipeline_test.rs: a failed holder releases its mutex (cli exec_test.rs runs_task_with_a_mutex_in_sequence)
  defineCase({
    id: 'graph/mutex-freed-by-a-failed-holder',
    category: 'graph',
    kind: 'correctness',
    title: 'A task that fails while holding a shared lock lets the task waiting for it run',
    why: 'Two tasks that share a lock but not an edge are independent: one failing says nothing about the other. Whichever holds the lock first fails, and the lock must pass to the other, which then runs and fails on its own. A lock kept by a failed task leaves the run hanging, or drops a task the user asked for.',
    from: ['failure-mode'],
    needs: ['mutex'],
    workspace: {
      projects: {
        b: { tasks: { build: uncached('echo ran > ran.txt; sleep 0.5; exit 1', { mutex: 'db' }) } },
        c: { tasks: { build: uncached('echo ran > ran.txt; sleep 0.5; exit 1', { mutex: 'db' }) } },
      },
    },
    steps: [
      {
        run: 'build',
        expect: {
          exit: 'fail',
          files: { 'packages/b/ran.txt': 'ran\n', 'packages/c/ran.txt': 'ran\n' },
          within: 30,
        },
      },
    ],
  }),

  // cli exec_test.rs runs_task_with_a_mutex_in_sequence: only the tasks naming the lock queue for it
  defineCase({
    id: 'graph/mutex-spares-tasks-outside-it',
    category: 'graph',
    kind: 'efficiency',
    title: 'A task that names no lock runs at the same time as one holding a lock',
    why: 'A lock names one resource, a database or a port, and keeps apart only the tasks that use it. A task that does not name it has nothing to wait for. Running it alone as well turns one shared resource into a run-wide queue, and the run is as slow as one at a time.',
    from: ['run-concurrency'],
    needs: ['mutex'],
    workspace: {
      projects: {
        a: { tasks: { t: uncached(meet('a', 'b'), { mutex: 'db' }) } },
        b: { tasks: { t: uncached(meet('b', 'a')) } },
      },
    },
    steps: [
      {
        run: 't',
        expect: {
          exit: 0,
          files: { 'packages/a/met.txt': 'met\n', 'packages/b/met.txt': 'met\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/different-mutexes-run-together',
    category: 'graph',
    kind: 'efficiency',
    title: 'Two tasks naming two different locks run at the same time',
    why: 'One task holds the database lock and the other the emulator lock; they share no resource. The lock name is what keeps tasks apart, so two names keep nothing apart from each other. A tool that treats any lock as one global lock runs them one after the other for no reason.',
    from: ['run-concurrency'],
    needs: ['mutex'],
    workspace: {
      projects: {
        a: { tasks: { t: uncached(meet('a', 'b'), { mutex: 'db' }) } },
        b: { tasks: { t: uncached(meet('b', 'a'), { mutex: 'emulator' }) } },
      },
    },
    steps: [
      {
        run: 't',
        expect: {
          exit: 0,
          files: { 'packages/a/met.txt': 'met\n', 'packages/b/met.txt': 'met\n' },
        },
      },
    ],
  }),

  // action-pipeline action_pipeline_test.rs: a mutex never deadlocks a dependency edge
  defineCase({
    id: 'graph/mutex-pair-joined-by-an-edge-runs-in-order',
    category: 'graph',
    kind: 'correctness',
    title: 'Two tasks that share a lock, one depending on the other, run in order without hanging',
    why: 'app’s task needs lib’s, and both use the same database. lib runs first and holds the lock; app takes it once lib is done. A tool that hands the lock to app before its dependency has run leaves app holding it while waiting for lib, which waits for the lock: the run hangs.',
    from: ['graph-order'],
    needs: ['mutex'],
    workspace: {
      projects: {
        lib: { tasks: { t: uncached('sleep 0.3; echo lib > out.txt', { mutex: 'db' }) } },
        app: {
          deps: ['lib'],
          tasks: {
            t: uncached('cat ../lib/out.txt > out.txt', { mutex: 'db', dependsOn: ['^t'] }),
          },
        },
      },
    },
    steps: [
      {
        run: 't',
        expect: {
          exit: 0,
          order: [['lib#t', 'app#t']],
          files: { 'packages/app/out.txt': 'lib\n' },
          within: 30,
        },
      },
    ],
  }),

  // moon #2531: "Remote cache drops files under nested dot-directories" (Next.js standalone `.next/.../.next/`)
  defineCase({
    id: 'outputs/nested-dot-directories-restored',
    category: 'outputs',
    kind: 'correctness',
    title:
      'Files under dot-directories nested inside an output tree come back on a hit, as Next.js writes them',
    why: 'Next.js writes its standalone server to `.next/standalone/app/.next/`, a dot-directory inside a dot-directory. Glob code that skips dot entries by default stores the tree without them, and the hit restores a server that cannot find its build. Every file under the output pattern must come back, at any depth.',
    from: ['artifact-roundtrip', 'dot-slash-globs'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command:
                'mkdir -p .next/standalone/app/.next/server dist/sub/.hidden && cat src/a.txt > .next/standalone/app/.next/BUILD_ID && echo s > .next/standalone/app/.next/server/page.js && echo h > dist/sub/.hidden/file.txt',
              inputs: ['src/**'],
              outputs: ['.next/**', 'dist/**'],
            },
          },
          files: { 'src/a.txt': 'id1\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { [`${A}/.next`]: null, [`${A}/dist`]: null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['a#build'],
          files: {
            [`${A}/.next/standalone/app/.next/BUILD_ID`]: 'id1\n',
            [`${A}/.next/standalone/app/.next/server/page.js`]: 's\n',
            [`${A}/dist/sub/.hidden/file.txt`]: 'h\n',
          },
        },
      },
    ],
  }),

  // task-runner task_runner_test.rs is_cached::skips_if_optional_outputs_were_removed;
  // CHANGELOG: "deleted `optional: true` file outputs were not restored on a cache hit"
  defineCase({
    id: 'outputs/optional-output-deleted-comes-back',
    category: 'outputs',
    kind: 'correctness',
    title: 'An optional output the task did write, then deleted, comes back on the next hit',
    why: 'Optional only means the task may leave the output unwritten. When it did write it, the output is part of the result like any other. Treating the deleted file as never written replays a tree without the coverage report the build produced.',
    from: ['missing-outputs', 'restore-in-place'],
    needs: ['optional-outputs'],
    workspace: {
      projects: {
        a: {
          tasks: {
            test: {
              command:
                'mkdir -p dist coverage && echo built > dist/a.txt && cat src/a.txt > coverage/lcov.info',
              inputs: ['src/**'],
              outputs: ['dist/**'],
              optionalOutputs: ['coverage/**'],
            },
          },
          files: { 'src/a.txt': 'cov\n' },
        },
      },
    },
    steps: [
      { run: 'test', expect: { exit: 0, ran: ['a#test'] } },
      { write: { [`${A}/coverage`]: null } },
      {
        run: 'test',
        expect: {
          exit: 0,
          notRan: ['a#test'],
          files: { [`${A}/coverage/lcov.info`]: 'cov\n', [`${A}/dist/a.txt`]: 'built\n' },
        },
      },
    ],
  }),

  // task-runner output_archiver_test.rs errors_if_outputs_not_created beside an optional output
  defineCase({
    id: 'failure/optional-output-does-not-excuse-a-missing-one',
    category: 'failure',
    kind: 'correctness',
    title:
      'A task that writes only its optional output, and not its required one, fails and is not cached',
    why: 'Marking coverage optional relaxes the check for coverage alone. dist is still required, and the build did not write it. A tool that passes the task because some output exists caches a result with no build in it, and every later hit restores nothing.',
    from: ['missing-outputs'],
    needs: ['optional-outputs'],
    workspace: {
      projects: {
        a: {
          tasks: {
            test: {
              command: 'mkdir -p coverage && cat src/a.txt > coverage/lcov.info',
              inputs: ['src/**'],
              outputs: ['dist/**'],
              optionalOutputs: ['coverage/**'],
            },
          },
          files: { 'src/a.txt': 'cov\n' },
        },
      },
    },
    steps: [
      { run: 'test', expect: { exit: 'fail' } },
      { run: 'test', expect: { exit: 'fail', ran: ['a#test'] } },
    ],
  }),

  // CHANGELOG: "a task with glob `outputs` would delete and restore its output files on every cached run,
  // even when the hash matched the previous run and all files still existed"
  defineCase({
    id: 'outputs/intact-outputs-left-in-place-on-a-hit',
    category: 'outputs',
    kind: 'efficiency',
    title: 'A hit over outputs still on disk as the task left them does not rewrite them',
    why: 'When every output is already what the cache holds, there is nothing to restore. Deleting and writing them again gives each file a new inode and modification time, so a dev server or file watcher sees a change and rebuilds for nothing. Matched files and files named outright are both left as they are.',
    from: ['restore-in-place', 'warm-outputs'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command:
                'mkdir -p dist && cat src/a.txt > dist/a.js && cat src/a.txt > dist/b.js && cat src/a.txt > out.txt',
              inputs: ['src/**'],
              outputs: ['dist/**', 'out.txt'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      {
        sh: `stat -c '%i %y' ${A}/dist/a.js ${A}/dist/b.js ${A}/out.txt > .stamps`,
      },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      {
        sh: `[ "$(stat -c '%i %y' ${A}/dist/a.js ${A}/dist/b.js ${A}/out.txt)" = "$(cat .stamps)" ]`,
      },
    ],
  }),

  // CHANGELOG: "Fixed trailing `--` in task commands being stripped"; "a task `command` could not end with `--`" (moon #2461)
  defineCase({
    id: 'env/command-ending-in-double-dash',
    category: 'env',
    kind: 'correctness',
    title: 'A command that ends in `--` runs with that `--` as its last argument',
    why: 'Some programs need a bare `--` to end their own options, and it can be the last word of the command. It belongs to the command, not to the runner’s argument forwarding. Stripping it changes what the program is asked to do.',
    from: ['task-shell', 'forward-args-verbatim'],
    workspace: {
      projects: {
        a: {
          tasks: {
            t: { command: `sh -c 'printf "%s|" "$@" > out.txt' sh a --`, cache: false },
          },
        },
      },
    },
    needs: ['uncached-task'],
    steps: [{ run: 't', expect: { exit: 0, files: { [`${A}/out.txt`]: 'a|--|' } } }],
  }),

  // cli exec_test.rs dependencies::keeps_outputs_cache_strategy_hash_stable_after_cas_hydration;
  // CHANGELOG: "a dependency ... would produce a different hash for the dependent task when the dependency's outputs were hydrated"
  defineCase({
    id: 'cache/chain-with-every-output-deleted-replays-every-link',
    category: 'cache',
    kind: 'efficiency',
    title: 'A chain whose outputs were all deleted replays every project, the dependant too',
    why: 'Nothing the chain reads has changed, so every project has a stored result. The dependency comes back from the cache instead of running, and that must not change what keys its dependant. A dependant keyed on how its dependency got its files rebuilds on every fresh checkout.',
    from: ['hash-chain', 'restore-in-place'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        ui: chainProject('ui', ['lib']),
        app: chainProject('app', ['ui']),
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['lib#build', 'ui#build', 'app#build'] } },
      {
        write: { 'packages/lib/dist': null, 'packages/ui/dist': null, 'packages/app/dist': null },
      },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['lib#build', 'ui#build', 'app#build'],
          files: {
            [out('lib')]: 'lib\n',
            [out('ui')]: 'lib\nui\n',
            [out('app')]: 'lib\nui\napp\n',
          },
        },
      },
    ],
  }),

  // task-builder task_deps_builder_test.rs cache_strategy::resolves_to_ignored_*: an ignored dependency still orders
  defineCase({
    id: 'graph/dependency-inputs-off-still-waits',
    category: 'graph',
    kind: 'correctness',
    title:
      'A task not keyed on its dependency still waits for it to finish, on every run that runs both',
    why: 'Leaving a dependency out of the key says nothing about order: the task still needs it done first, for a server, a database or a generated file it does not track. When both run, the dependency finishes before the task starts. A tool that drops the edge with the key starts them together.',
    from: ['graph-order', 'task-hash-derive'],
    needs: ['dependency-inputs-off'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: {
              command: 'sleep 0.5 && mkdir -p dist && cat src/a.txt > dist/out.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: {
          deps: ['lib'],
          tasks: {
            build: {
              command: 'mkdir -p dist && cat ../lib/dist/out.txt src/a.txt > dist/out.txt',
              dependsOn: ['^build'],
              inputs: ['src/**'],
              outputs: ['dist/**'],
              dependencyInputs: false,
            },
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        expect: {
          exit: 0,
          order: [['lib#build', 'app#build']],
          files: { [out('app')]: 'lib\napp\n' },
        },
      },
      { write: { 'packages/lib/src/a.txt': 'lib2\n', 'packages/app/src/a.txt': 'app2\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['lib#build', 'app#build'],
          order: [['lib#build', 'app#build']],
          files: { [out('app')]: 'lib2\napp2\n' },
        },
      },
    ],
  }),

  // task-builder task_deps_builder_test.rs cache_strategy: an ignored edge keeps out the dependency's whole key
  defineCase({
    id: 'cache/dependency-inputs-off-shuts-out-changes-further-down',
    category: 'cache',
    kind: 'efficiency',
    title:
      'A task not keyed on its dependency replays when only that dependency’s own dependency changes',
    why: 'ui keys on lib, so a change in lib rebuilds ui. app waits for ui but was told not to key on it, and what ui is keyed on reaches app only through ui. The change two levels down must stop at that edge: app replays while ui rebuilds.',
    from: ['hash-chain', 'task-hash-derive'],
    needs: ['dependency-inputs-off'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        ui: chainProject('ui', ['lib']),
        app: {
          deps: ['ui'],
          tasks: { build: { ...OWN_BUILD, dependsOn: ['^build'], dependencyInputs: false } },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['lib#build', 'ui#build', 'app#build'] } },
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['lib#build', 'ui#build'],
          notRan: ['app#build'],
          files: { [out('ui')]: 'lib2\nui\n', [out('app')]: 'app\n' },
        },
      },
    ],
  }),

  // action-pipeline action_pipeline_test.rs abort::doesnt_run_dependents_when_dependency_aborts, over an ignored edge
  defineCase({
    id: 'failure/dependency-inputs-off-dependant-skipped-on-failure',
    category: 'failure',
    kind: 'correctness',
    title: 'A task not keyed on its dependency is still skipped when that dependency fails',
    why: 'Not keying on a dependency is about what the task reads, not about whether it may run without it. The task was ordered after lib because it needs lib done. When lib fails, the task runs against a dependency that never finished, so it is skipped like any other dependant, and the run fails.',
    from: ['failure-mode', 'task-hash-derive'],
    needs: ['dependency-inputs-off'],
    workspace: {
      projects: {
        lib: {
          tasks: { build: { command: 'exit 1', inputs: ['src/**'], outputs: [] } },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: {
          deps: ['lib'],
          tasks: { build: { ...OWN_BUILD, dependsOn: ['^build'], dependencyInputs: false } },
          files: { 'src/a.txt': 'app\n' },
        },
        docs: { tasks: { build: OWN_BUILD }, files: { 'src/a.txt': 'docs\n' } },
      },
    },
    steps: [
      {
        run: 'build',
        expect: {
          exit: 'fail',
          ran: ['docs#build'],
          notRan: ['app#build'],
          files: { [out('app')]: null },
        },
      },
    ],
  }),

  // task-builder task_deps_builder_test.rs cache_strategy, with a keyed variable on the dependency
  defineCase({
    id: 'env/dependency-variable-change-replays-unkeyed-dependant',
    category: 'env',
    kind: 'efficiency',
    title:
      'A variable only the dependency keys on reruns it, and replays a dependant not keyed on it',
    why: 'lib keys on MODE, so a new value rebuilds lib. app waits for lib but was told not to key on it, and app itself never declared MODE. Nothing app is keyed on changed, so it replays. A tool that leaks the dependency’s variables into the dependant’s key through an edge it was told to leave out rebuilds app for nothing.',
    from: ['env', 'task-hash-derive'],
    needs: ['env-inputs', 'dependency-inputs-off'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: {
              command: 'mkdir -p dist && printf "%s\\n" "$MODE" > dist/out.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
              env: ['MODE'],
            },
          },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: {
          deps: ['lib'],
          tasks: { build: { ...OWN_BUILD, dependsOn: ['^build'], dependencyInputs: false } },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      { run: 'build', env: { MODE: 'one' }, expect: { exit: 0, ran: ['lib#build', 'app#build'] } },
      {
        run: 'build',
        env: { MODE: 'two' },
        expect: {
          exit: 0,
          ran: ['lib#build'],
          notRan: ['app#build'],
          files: { [out('lib')]: 'two\n' },
        },
      },
    ],
  }),

  // CHANGELOG: "outputs partially restored by a failed cache hydration could be reused as a cache hit on the next run"
  defineCase({
    id: 'outputs/replay-blocked-midway-then-cleared-restores-everything',
    category: 'outputs',
    kind: 'correctness',
    title:
      'Once a file that blocked a replay is removed, the next run brings back every output, not only those the blocked one wrote',
    why: 'A plain file standing where an output directory goes stops a restore partway, whatever the tool then does about it. Once the user removes the file, the outputs on disk may be only part of the result. The next run must leave the whole tree, never take the part on disk for a finished replay.',
    from: ['restore-occupied-parent', 'restore-in-place'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command:
                'mkdir -p dist/x dist/y && cat src/a.txt > dist/a.txt && cat src/a.txt > dist/x/b.txt && cat src/a.txt > dist/y/c.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { [`${A}/dist`]: null } },
      { write: { [`${A}/dist/x`]: 'blocker\n' } },
      { run: 'build', expect: {} },
      { write: { [`${A}/dist/x`]: null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: {
            [`${A}/dist/a.txt`]: 'a\n',
            [`${A}/dist/x/b.txt`]: 'a\n',
            [`${A}/dist/y/c.txt`]: 'a\n',
          },
        },
      },
    ],
  }),

  // moon v1 CHANGELOG: "'have outputs been created' checks would fail if outputs only contained negated globs, coupled with literal paths"
  defineCase({
    id: 'outputs/negation-beside-a-literal-output-needs-no-match',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A `!` output entry beside a file named outright passes when nothing matches the `!` entry',
    why: 'A `!` entry only takes paths back from the outputs; it claims no file of its own. The one output the task must write is `report.json`, and it did. Failing the task because the `!` pattern matched nothing treats an exclusion as a promise, and a task that wrote everything it declared never caches.',
    from: ['negated-outputs', 'missing-outputs'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'cat src/a.txt > report.json',
              inputs: ['src/**'],
              outputs: ['report.json', '!tmp/**'],
            },
          },
          files: { 'src/a.txt': 'r\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { [`${A}/report.json`]: null } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/report.json`]: 'r\n' } },
      },
    ],
  }),

  // moon v1 CHANGELOG: "`NO_COLOR` or `FORCE_COLOR` would be overwritten for task child processes"
  defineCase({
    id: 'env/force-color-set-by-the-user-reaches-the-task-unchanged',
    category: 'env',
    kind: 'correctness',
    title: 'A `FORCE_COLOR` the user set and the task passes through reaches it as the user set it',
    why: 'Many tools color their output by `FORCE_COLOR`, and a user sets it to 0 to get plain logs in CI. A runner that sets its own value for the processes it starts overrides that choice behind the user’s back, and a task whose output is parsed breaks. A variable the task passes through reaches it as the user set it.',
    from: ['env', 'unpassed-env'],
    needs: ['pass-through-env', 'uncached-task'],
    workspace: {
      projects: {
        a: {
          tasks: {
            t: {
              command: 'printf "<%s>" "$FORCE_COLOR" > got.txt',
              passThrough: ['FORCE_COLOR'],
              cache: false,
            },
          },
        },
      },
    },
    steps: [
      {
        run: 't',
        env: { FORCE_COLOR: '0' },
        expect: { exit: 0, files: { [`${A}/got.txt`]: '<0>' } },
      },
    ],
  }),

  // moon v1 CHANGELOG: "task output hydration that would sometimes fail with a permission denied error when cleaning stale files"
  defineCase({
    id: 'outputs/stale-file-in-read-only-output-dir-cleared-on-replay',
    category: 'outputs',
    kind: 'correctness',
    title: 'Replaying an older build clears a newer build’s file from a read-only output directory',
    why: 'The newer build left an extra file in a directory it made read-only, as some code generators do. Going back to the older sources replays the older build, and the extra file is not part of it. A restore that cannot clear it fails with permission denied, or leaves a file the replayed build never wrote; the directory stays read-only as the build left it.',
    from: ['restore-dir-mode', 'restore-in-place'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command:
                'chmod -R u+w dist 2>/dev/null; rm -rf dist && mkdir -p dist/ro && cat src/a.txt > dist/ro/f.txt && if grep -q two src/a.txt; then echo extra > dist/ro/extra.txt; fi && chmod 444 dist/ro/* && chmod 555 dist/ro',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'one\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { [`${A}/src/a.txt`]: 'two\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [`${A}/dist/ro/extra.txt`]: 'extra\n' } },
      },
      { write: { [`${A}/src/a.txt`]: 'one\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: { [`${A}/dist/ro/f.txt`]: 'one\n', [`${A}/dist/ro/extra.txt`]: null },
        },
      },
      { check: { modes: { [`${A}/dist/ro`]: 0o555 } } },
    ],
  }),

  // task-runner task_runner_test.rs: a task's timeout starts when its command does, here behind a mutex
  // (CHANGELOG: "a task that had yet to run its command ... (it was still ... waiting on a `mutex`)")
  defineCase({
    id: 'failure/time-limit-does-not-count-the-wait-for-a-lock',
    category: 'failure',
    kind: 'correctness',
    title: 'A task’s time limit does not count the time it waits for a lock another task holds',
    why: 'Each task takes 2.5 s, within its 4 s limit, and they share a lock, so the second waits for the first. The limit is about the task’s own command hanging, not about how long the lock was held by someone else. Counting the wait kills a healthy task, and which one dies depends on who got the lock first.',
    from: ['run-outcome-retry-timeout-properties'],
    needs: ['mutex', 'timeout', 'uncached-task'],
    workspace: {
      projects: {
        b: {
          tasks: { t: uncached('sleep 2.5; echo done > out.txt', { mutex: 'db', timeout: 4 }) },
        },
        c: {
          tasks: { t: uncached('sleep 2.5; echo done > out.txt', { mutex: 'db', timeout: 4 }) },
        },
      },
    },
    steps: [
      {
        run: 't',
        expect: {
          exit: 0,
          files: { 'packages/b/out.txt': 'done\n', 'packages/c/out.txt': 'done\n' },
        },
      },
    ],
  }),

  // moon #1951: "Inconsistent Task Execution During CI Runs When Multiple Projects Share Common Dependencies"
  defineCase({
    id: 'affected/changed-dependent-does-not-hide-the-dependencys-other-users',
    category: 'affected',
    kind: 'correctness',
    title:
      'When a library and one of its users both changed, the library’s other user is still selected',
    why: 'zlib changed, so everything that builds on it is selected, app included. cli changed too and also builds on zlib. Taking cli first and marking zlib as already seen must not skip the walk from zlib to app. app builds on a changed library and has to be checked.',
    from: ['affected-dependents'],
    needs: ['affected'],
    workspace: {
      projects: {
        zlib: { tasks: { build: chainBuildOf([]) }, files: { 'src/a.txt': 'zlib\n' } },
        app: {
          deps: ['zlib'],
          tasks: { build: chainBuildOf(['zlib']) },
          files: { 'src/a.txt': 'app\n' },
        },
        cli: {
          deps: ['zlib'],
          tasks: { build: chainBuildOf(['zlib']) },
          files: { 'src/a.txt': 'cli\n' },
        },
        docs: { tasks: { build: chainBuildOf([]) }, files: { 'src/a.txt': 'docs\n' } },
      },
    },
    steps: [
      { write: { 'packages/zlib/src/a.txt': 'zlib2\n', 'packages/cli/src/a.txt': 'cli2\n' } },
      { commit: 'edit zlib and cli' },
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: {
          exit: 0,
          ran: ['zlib#build', 'app#build', 'cli#build'],
          notRan: ['docs#build'],
          files: { [out('app')]: 'zlib2\napp\n', [out('cli')]: 'zlib2\ncli2\n' },
        },
      },
    ],
  }),

  // moon #2295: "Unpredictable string mangling when passing args to a command" (`?foo=bar&var=baz`)
  defineCase({
    id: 'env/args-with-glob-characters-reach-verbatim',
    category: 'env',
    kind: 'correctness',
    title:
      'Forwarded args holding `*`, `?` and `&` reach the command as typed, though files match them',
    why: 'A query string like `?foo=bar&var=baz` or a pattern like `*.txt` is data for the program, which may expand it itself. The project holds `a.txt` and `b.txt`, so a shell that sees the args unquoted turns `*.txt` into two file names and `&` into a background job. Each arg reaches the command once, as the user typed it.',
    from: ['forward-args-verbatim', 'forward-args-one-task'],
    needs: ['uncached-task'],
    workspace: {
      projects: {
        a: {
          tasks: {
            t: {
              command: `printf '<%s>' "\${UNSET_X:-d}" "$@" > got.txt`,
              takesArgs: true,
              cache: false,
            },
          },
          files: { 'a.txt': 'a\n', 'b.txt': 'b\n' },
        },
      },
    },
    steps: [
      {
        run: 't',
        projects: ['a'],
        args: ['?foo=bar&var=baz', '*.txt', '?.txt'],
        expect: { exit: 0, files: { [`${A}/got.txt`]: '<d><?foo=bar&var=baz><*.txt><?.txt>' } },
      },
    ],
  }),

  // moon v1 CHANGELOG: "environment variables with default/fallback values (`${VAR:+default}`) were ..."
  // and "tasks would not substitute environment variables when executing"
  defineCase({
    id: 'env/command-parameter-default-reaches-the-shell',
    category: 'env',
    kind: 'correctness',
    title:
      'A command using `${MODE:-dev}` gets the default while MODE is unset, and the value once it is set',
    why: 'A default in a parameter expansion is shell syntax: the shell fills it in when the command runs. A runner that rewrites `${…}` itself, or drops the text after `:-`, hands the shell a different command. MODE is declared, so setting it runs the task again with the value in place of the default.',
    from: ['task-shell', 'env'],
    needs: ['env-inputs'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'mkdir -p dist && printf "%s\\n" "${MODE:-dev}" > dist/out.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
              env: ['MODE'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'dev\n' } } },
      {
        run: 'build',
        env: { MODE: 'prod' },
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'prod\n' } },
      },
    ],
  }),

  // moon #2394: "pytest output gets truncated during `moon run`"
  defineCase({
    id: 'failure/long-output-of-a-failing-task-keeps-its-end',
    category: 'failure',
    kind: 'correctness',
    title: 'A failing task that prints thirty thousand lines still shows its last line',
    why: 'A test runner prints its summary, the names of what failed, at the very end of a long log. A runner that cuts the output at a buffer size, or stops reading once the process exits, drops exactly the line the developer needs. The whole output reaches the user, its end included.',
    from: ['frame-big-output', 'failed-output-whole'],
    workspace: {
      projects: {
        a: {
          tasks: {
            test: {
              command:
                'i=0; while [ $i -lt 30000 ]; do echo "line $i of the test log"; i=$((i+1)); done; echo "FAILED summary-token-51e2"; exit 1',
              inputs: ['src/**'],
              outputs: [],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [{ run: 'test', expect: { exit: 'fail', output: ['FAILED summary-token-51e2'] } }],
  }),

  // moon #735: "Intermittently, cached moon outputs get partially restored"
  defineCase({
    id: 'outputs/concurrent-restores-of-many-projects-intact',
    category: 'outputs',
    kind: 'correctness',
    title:
      'Eight projects replaying a megabyte of random bytes each at the same time all come back byte for byte',
    why: 'A run with nothing changed restores many projects at once, and a restore that shares buffers or writes through an unflushed handle can leave a file cut short or holding another project’s bytes. The next task then reads a broken file under a green run. Every restored file must equal what its build wrote.',
    from: ['artifact-roundtrip', 'restore-in-place'],
    workspace: {
      projects: Object.fromEntries(
        ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'].map((n): [string, ProjectSpec] => [
          n,
          {
            tasks: {
              build: {
                command: 'mkdir -p dist && head -c 1048576 /dev/urandom > dist/blob.bin',
                inputs: ['src/**'],
                outputs: ['dist/**'],
              },
            },
            files: { 'src/a.txt': `${n}\n` },
          },
        ]),
      ),
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { sh: 'sha256sum packages/*/dist/blob.bin > .sums && rm -rf packages/*/dist' },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'].map((n) => `${n}#build`),
        },
      },
      { sh: 'sha256sum -c --quiet .sums' },
    ],
  }),

  // task-runner task_runner_test.rs optional_file_outputs::running_again_restores_missing_outputs_*, under a dependant
  defineCase({
    id: 'outputs/dependency-optional-output-back-before-the-dependant-reads-it',
    category: 'outputs',
    kind: 'correctness',
    title: 'A dependency’s deleted optional output is back before a rebuilding dependant reads it',
    why: 'lib wrote its optional type declarations, so they are part of its stored result. app changed and rebuilds, reading those declarations; lib did not change and replays. A replay that skips optional outputs, or a dependant that starts before the restore, reads a missing file and fails or builds wrong.',
    from: ['dependency-outputs-there', 'missing-outputs'],
    needs: ['optional-outputs'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: {
              command:
                'mkdir -p dist types && cat src/a.txt > dist/out.txt && cat src/a.txt > types/index.d.ts',
              inputs: ['src/**'],
              outputs: ['dist/**'],
              optionalOutputs: ['types/**'],
            },
          },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: {
          deps: ['lib'],
          tasks: {
            build: {
              command: 'mkdir -p dist && cat ../lib/types/index.d.ts src/a.txt > dist/out.txt',
              dependsOn: ['^build'],
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['lib#build', 'app#build'] } },
      { write: { 'packages/lib/types': null, 'packages/app/src/a.txt': 'app2\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['app#build'],
          notRan: ['lib#build'],
          files: { [out('app')]: 'lib\napp2\n', 'packages/lib/types/index.d.ts': 'lib\n' },
        },
      },
    ],
  }),

  // cli __fixtures__/cases/mutex (run1, run2, run3 share `test-lock`): the lock is a name, not a task
  defineCase({
    id: 'graph/mutex-keeps-apart-tasks-of-different-names',
    category: 'graph',
    kind: 'correctness',
    title: 'A lint and a test that name the same lock never run at the same time',
    why: 'The lock names the resource, a database both tasks reset, not the task. That one is called lint and the other test, in different projects, changes nothing about the clash. A tool that keeps apart only tasks of one name lets them overlap and corrupt each other’s data.',
    from: ['run-concurrency'],
    needs: ['mutex', 'multi-task', 'uncached-task'],
    workspace: {
      projects: {
        a: { tasks: { lint: uncached(HOLD, { mutex: 'db' }) } },
        b: { tasks: { test: uncached(HOLD, { mutex: 'db' }) } },
      },
    },
    steps: [
      {
        run: 'lint',
        also: ['test'],
        expect: {
          exit: 0,
          ran: ['a#lint', 'b#test'],
          files: {
            'overlap.txt': null,
            'packages/a/done.txt': 'done\n',
            'packages/b/done.txt': 'done\n',
          },
        },
      },
    ],
  }),

  // task-runner task_runner_test.rs glob_outputs::running_again_restores_missing_outputs_from_cas ("Then reused as-is on the next run")
  defineCase({
    id: 'outputs/restored-output-left-in-place-by-the-next-hit',
    category: 'outputs',
    kind: 'efficiency',
    title: 'An output one hit restored is left as it is by the next hit',
    why: 'Once a hit has put a deleted output back, the file on disk is exactly what the cache holds. The next hit has nothing to restore, and writing the file again gives it a new inode and time, so watchers rebuild for nothing. A tool that only trusts files its own task wrote rewrites every restored output on every run.',
    from: ['restore-in-place', 'output-stamps-scale'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'mkdir -p dist && cat src/a.txt > dist/a.js && cat src/a.txt > dist/b.js',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { [`${A}/dist/a.js`]: null } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/dist/a.js`]: 'a\n' } },
      },
      { sh: `stat -c '%i %y' ${A}/dist/a.js ${A}/dist/b.js > .stamps` },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { sh: `[ "$(stat -c '%i %y' ${A}/dist/a.js ${A}/dist/b.js)" = "$(cat .stamps)" ]` },
    ],
  }),

  // task-builder tasks_builder_test.rs command_syntax::preserves_quotes
  defineCase({
    id: 'env/command-double-quoted-spaces-kept',
    category: 'env',
    kind: 'correctness',
    title: 'Text in double quotes inside a command keeps its runs of spaces and its tab',
    why: 'A quoted string is one word to the shell, spaces and all: a commit message, a column format, a search phrase. A runner that splits the command into words and joins them back with single spaces changes what the program receives. The shell sees the command exactly as written.',
    from: ['task-shell', 'config-schema-task-string'],
    needs: ['uncached-task'],
    workspace: {
      projects: {
        a: {
          tasks: {
            t: { command: 'printf "<%s>" "a  b" "c\tz" > got.txt', cache: false },
          },
        },
      },
    },
    steps: [{ run: 't', expect: { exit: 0, files: { [`${A}/got.txt`]: '<a  b><c\tz>' } } }],
  }),

  // task-builder tasks_builder_test.rs command_syntax::preserves_quotes_in_exe
  defineCase({
    id: 'env/command-quoted-program-path-with-a-space',
    category: 'env',
    kind: 'correctness',
    title: 'A command whose program is a quoted path holding a space runs that program',
    why: 'Scripts kept in folders like `tools/dev scripts/` are called by a quoted path. The quotes make the path one word, so the shell runs the script. A runner that takes the first space-separated word as the program looks for `./tools/dev`, which does not exist, and the task fails.',
    from: ['task-shell', 'shell-verdict'],
    needs: ['uncached-task'],
    workspace: {
      projects: {
        a: {
          tasks: { t: { command: '"./tools/dev scripts/gen.sh" one', cache: false } },
          files: { 'tools/dev scripts/gen.sh': '#!/bin/sh\nprintf "%s\\n" "$1" > got.txt\n' },
        },
      },
    },
    steps: [
      { chmod: { [`${A}/tools/dev scripts/gen.sh`]: 0o755 } },
      { run: 't', expect: { exit: 0, files: { [`${A}/got.txt`]: 'one\n' } } },
    ],
  }),
] as Case[]
