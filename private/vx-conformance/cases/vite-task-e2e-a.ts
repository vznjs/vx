// Outcomes drawn from Vite Task's end-to-end fixtures (batch A) that no
// earlier case carried. Each is said in the neutral language; the fixtures
// whose outcome is a log line, a terminal mode or Vite Task's own file
// tracking stay out.
import { defineCase, type TaskSpec } from '../src/spec.ts'
import { chainProject, one, out } from './shapes.ts'

/** Marks itself up, waits up to 10 s for `other` to be up, and writes whether it saw it. */
const meeting = (other: string): TaskSpec => ({
  command: `touch up; i=0; while [ ! -e ../${other}/up ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; mkdir -p dist; if [ -e ../${other}/up ]; then echo together; else echo alone; fi > dist/out.txt`,
  inputs: ['src/**'],
  outputs: ['dist/**'],
})

const keyed = {
  command: 'mkdir -p dist && printf "%s\\n" "${MODE-unset}" > dist/out.txt',
  inputs: ['src/**'],
  env: ['MODE'],
  outputs: ['dist/**'],
}

const twoOutputs = {
  command: 'mkdir -p dist lib && cat src/a.txt > dist/out.txt && cat src/a.txt > lib/out.txt',
  inputs: ['src/**'],
  outputs: ['dist/**'],
}

export default [
  defineCase({
    id: 'graph/independent-tasks-run-at-once',
    category: 'graph',
    kind: 'efficiency',
    title: 'Two tasks with no edge between them run at the same time',
    why: 'Tasks with no dependency between them can run side by side, and a run that has cores to spare should use them. Here each task waits a while for the other to start, so run one after the other they each wait out the full delay. Running independent work in turn makes a monorepo’s wall time the sum of its tasks instead of its longest path.',
    from: ['scheduler', 'run-concurrency'],
    workspace: {
      projects: {
        p: { tasks: { build: meeting('q') }, files: { 'src/a.txt': 'p\n' } },
        q: { tasks: { build: meeting('p') }, files: { 'src/a.txt': 'q\n' } },
      },
    },
    steps: [
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['p#build', 'q#build'],
          files: { [out('p')]: 'together\n', [out('q')]: 'together\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'failure/task-closing-its-output-still-awaited',
    category: 'failure',
    kind: 'correctness',
    title: 'A task that closes its output and keeps working is waited for until it exits',
    why: 'A process can close its output streams and go on working, as a daemonizing tool or a quiet build step does. The task ends when its process exits, not when its output ends. A runner that takes the closed stream as the end starts the dependant on a half-written output, or ends the run with the task still running behind it.',
    from: ['kill-tree', 'scheduler'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: {
              command:
                'exec >/dev/null 2>&1 </dev/null; sleep 2; mkdir -p dist; echo done > dist/out.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: chainProject('app', ['lib']),
      },
    },
    steps: [
      {
        run: 'build',
        expect: {
          exit: 0,
          order: [['lib#build', 'app#build']],
          files: { [out('lib')]: 'done\n', [out('app')]: 'done\napp\n' },
          alone: true,
        },
      },
    ],
  }),

  defineCase({
    id: 'cache/outputs-revert-replays',
    category: 'cache',
    kind: 'efficiency',
    title: 'Putting back the outputs a task first declared replays the entry saved for them',
    why: 'An entry is saved under the task’s config as it was, so going back to that config finds it again. A team that tries a wider output set and reverts it should get its old hits back, not rebuild. The entry still holds every output the restored config names, so replaying it leaves the right tree.',
    from: ['task-hash-derive', 'hash-scenarios'],
    workspace: one(twoOutputs),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      {
        configure: (ws) => ({
          ...ws,
          projects: {
            a: {
              ...ws.projects['a']!,
              tasks: { build: { ...twoOutputs, outputs: ['dist/**', 'lib/**'] } },
            },
          },
        }),
      },
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      {
        configure: (ws) => ({
          ...ws,
          projects: { a: { ...ws.projects['a']!, tasks: { build: twoOutputs } } },
        }),
      },
      { write: { 'packages/a/dist': null } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [out('a')]: 'a\n' } },
      },
    ],
  }),

  defineCase({
    id: 'env/each-value-keeps-its-entry',
    category: 'env',
    kind: 'efficiency',
    title: 'Switching a declared variable back and forth replays each value’s own result',
    why: 'Each value of a keyed variable has its own entry, and a new value must not push out the old one. Builds that switch between modes, such as dev and prod or two targets, go back and forth all day. A cache that keeps only the latest value rebuilds on every switch, though both results are already known.',
    from: ['env', 'hash-scenarios-names'],
    needs: ['env-inputs'],
    workspace: one(keyed),
    steps: [
      { run: 'build', env: { MODE: 'dev' }, expect: { exit: 0, ran: ['a#build'] } },
      { run: 'build', env: { MODE: 'prod' }, expect: { exit: 0, ran: ['a#build'] } },
      {
        run: 'build',
        env: { MODE: 'dev' },
        expect: { exit: 0, notRan: ['a#build'], files: { [out('a')]: 'dev\n' } },
      },
      {
        run: 'build',
        env: { MODE: 'prod' },
        expect: { exit: 0, notRan: ['a#build'], files: { [out('a')]: 'prod\n' } },
      },
    ],
  }),

  defineCase({
    id: 'cache/each-args-keep-their-entry',
    category: 'cache',
    kind: 'efficiency',
    title: 'Running a task with one set of args, then another, then each again replays both',
    why: 'Forwarded args are part of the key, so each set of args has its own entry. Running tests for one file, then another, then the first again is ordinary work. A cache that keeps only the last args reruns work whose result it already had, while keeping both costs nothing in correctness.',
    from: ['forward-args-verbatim', 'hash-scenarios'],
    workspace: one({
      command: `mkdir -p dist && printf '<%s>' "$@" > dist/out.txt`,
      takesArgs: true,
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      { run: 'build', args: ['a'], expect: { exit: 0, ran: ['a#build'] } },
      { run: 'build', args: ['b'], expect: { exit: 0, ran: ['a#build'] } },
      {
        run: 'build',
        args: ['a'],
        expect: { exit: 0, notRan: ['a#build'], files: { [out('a')]: '<a>' } },
      },
      {
        run: 'build',
        args: ['b'],
        expect: { exit: 0, notRan: ['a#build'], files: { [out('a')]: '<b>' } },
      },
    ],
  }),

  defineCase({
    id: 'config/malformed-manifest-refused',
    category: 'config',
    kind: 'correctness',
    title: 'A project whose package.json does not parse fails the run',
    why: 'A manifest that does not parse leaves the project’s name, dependencies and tasks unknown. Skipping the project lets the run go green with its tasks never run and its dependants built in the wrong order. Failing at once names the broken file while the mistake is fresh.',
    from: ['discovery-refusals', 'package-json-bom'],
    workspace: {
      projects: {
        a: {
          tasks: { build: { command: 'echo a > a.txt', inputs: ['src/**'] } },
          files: { 'src/a.txt': 'a\n' },
        },
        b: {
          tasks: { build: { command: 'echo b > b.txt', inputs: ['src/**'] } },
          files: { 'src/a.txt': 'b\n' },
        },
      },
    },
    steps: [
      { write: { 'packages/b/package.json': '{\n  "name":\n}\n' } },
      { run: 'build', expect: { exit: 'fail' } },
    ],
  }),
]
