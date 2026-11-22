// Task graphs of many shapes, and what a run does around a failure in them.
// Drawn from the rivals' scheduler tests: moon's crates/action-graph/tests
// (action_graph_builder_test.rs), Nx's packages/nx/src/tasks-runner
// (create-task-graph.spec.ts "should create graphs with dependencies",
// task-orchestrator.spec.ts "should return a result for a held-back task
// skipped by its failed dependency"), Turborepo's crates/turborepo-engine
// tests and Vite Task's topological_execution_order fixture. Every edge of
// each shape is an `order` the run must keep; `races` replays each shape so
// a lucky order cannot pass.
import {
  defineCase,
  type Case,
  type ProjectSpec,
  type TaskSpec,
  type WorkspaceSpec,
} from '../src/spec.ts'
import { chainProject } from './shapes.ts'

/** Projects named by key, each building on the listed dependencies with `^build`. */
function dag(edges: Record<string, string[]>): WorkspaceSpec {
  return {
    projects: Object.fromEntries(
      Object.entries(edges).map(([n, deps]) => [n, chainProject(n, deps)]),
    ),
  }
}

/** Every `[dependency, dependant]` pair of the shape, as builds. */
function orderOf(edges: Record<string, string[]>): [string, string][] {
  return Object.entries(edges).flatMap(([n, deps]) =>
    deps.map((d): [string, string] => [`${d}#build`, `${n}#build`]),
  )
}

function shape(id: string, title: string, why: string, edges: Record<string, string[]>): Case {
  const all = Object.keys(edges).map((n) => `${n}#build`)
  return defineCase({
    id: `graph/${id}`,
    category: 'graph',
    kind: 'correctness',
    title,
    why,
    from: ['task-graph', 'scheduler'],
    races: 2,
    workspace: dag(edges),
    steps: [{ run: 'build', expect: { exit: 0, ran: all, order: orderOf(edges) } }],
  })
}

const range = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`)

const FAIL: TaskSpec = { command: 'exit 1', inputs: ['src/**'], outputs: ['dist/**'] }
/** A build that takes a second, so a failure elsewhere lands while it runs. */
const slow = (deps: string[] = []): ProjectSpec => {
  const p = chainProject('slow', deps)
  return {
    ...p,
    tasks: { build: { ...p.tasks!.build!, command: `sleep 1 && ${p.tasks!.build!.command}` } },
  }
}

export default [
  shape(
    'shape-wide-fan-in',
    'A project depending on eight others builds after all eight',
    'An app often depends on many libraries at once. The scheduler must hold the app until the last of them finishes, not until the first or until a count of slots frees. A tool that starts the app early reads a library’s output before it exists.',
    { ...Object.fromEntries(range(8, 'l').map((l) => [l, []])), app: range(8, 'l') },
  ),
  shape(
    'shape-wide-fan-out',
    'Eight projects depending on one library all build after it',
    'A shared library sits under many apps. Every app must wait for it, and each must see its finished output. A tool that releases dependants as a batch when the first one is scheduled can start some before the library ends.',
    { lib: [], ...Object.fromEntries(range(8, 'a').map((a) => [a, ['lib']])) },
  ),
  shape(
    'shape-chain-of-twelve',
    'A chain of twelve projects builds strictly bottom up',
    'Deep chains are common in layered monorepos (types, core, sdk, ui, app…). Each link must wait for the one below. A scheduler that walks a fixed number of levels, or orders by name, breaks a long chain in the middle.',
    Object.fromEntries(range(12, 'c').map((c, i) => [c, i === 0 ? [] : [`c${i - 1}`]])),
  ),
  shape(
    'shape-binary-tree',
    'A three-level tree of projects builds every leaf before its parent and the root last',
    'A tree joins pairs of builds at each level. Each parent needs both children, and the root needs everything. A tool that orders by depth alone can still run a parent before a child of the other branch at the same depth finishes.',
    { r: ['m0', 'm1'], m0: ['l0', 'l1'], m1: ['l2', 'l3'], l0: [], l1: [], l2: [], l3: [] },
  ),
  shape(
    'shape-two-independent-chains',
    'Two chains with nothing between them each keep their own order',
    'Unrelated parts of a workspace build side by side. Each chain must stay in order on its own, whatever the other is doing. A scheduler that serialises across chains is slow, and one that loses track of which chain released what breaks an order.',
    { a0: [], a1: ['a0'], a2: ['a1'], b0: [], b1: ['b0'], b2: ['b1'] },
  ),
  shape(
    'shape-crossed-pairs',
    'Two projects each depending on the same two libraries build after both',
    'A W shape (two apps over two shared libraries, each app using both) has every top waiting on every bottom. A tool that pairs dependants with one dependency each, or releases an app when its first library ends, starts it too soon.',
    { l0: [], l1: [], a0: ['l0', 'l1'], a1: ['l0', 'l1'] },
  ),
  shape(
    'shape-stacked-diamonds',
    'Three diamonds stacked on each other build in order, each shared node once',
    'Stacked diamonds put a shared node at every join, reached by two paths each time. The scheduler must run each join once, after both arms, and only then release the next diamond. Counting paths instead of nodes runs a join twice or early.',
    {
      d0: [],
      a1: ['d0'],
      b1: ['d0'],
      d1: ['a1', 'b1'],
      a2: ['d1'],
      b2: ['d1'],
      d2: ['a2', 'b2'],
      a3: ['d2'],
      b3: ['d2'],
      d3: ['a3', 'b3'],
    },
  ),
  shape(
    'shape-skip-level-edge',
    'A project depending on both a library and that library’s dependant builds after both',
    'A transitive edge written out (app on core and on ui, ui on core) is redundant but common. It must not change the order: core, then ui, then app. A tool that drops the redundant edge too eagerly, or that releases app when core ends, runs app before ui.',
    { core: [], ui: ['core'], app: ['core', 'ui'] },
  ),
  shape(
    'shape-uneven-depths',
    'A project over one shallow and one deep dependency waits for the deep one',
    'Dependencies at different depths finish at different times. The dependant must wait for its slowest path, not for the shortest. A scheduler that orders by depth from the top can start it when the shallow side is done.',
    { s: [], d0: [], d1: ['d0'], d2: ['d1'], d3: ['d2'], top: ['s', 'd3'] },
  ),
  shape(
    'shape-many-roots-one-leaf',
    'Six top projects over one shared leaf build the leaf once, first',
    'Many apps over one leaf ask for it many times in one run. It runs once, before any of them, and every app sees its one output. A tool that runs it per requester wastes work, and one that releases tops by count starts some early.',
    { leaf: [], ...Object.fromEntries(range(6, 't').map((t) => [t, ['leaf']])) },
  ),
  shape(
    'shape-ladder',
    'A ladder of projects, each over the two below it, builds rung by rung',
    'A ladder makes every node a join of two paths of different lengths. Each must wait for both. It is the shape where an off-by-one in counting finished dependencies shows: a node released after one of two.',
    { r0: [], r1: ['r0'], r2: ['r0', 'r1'], r3: ['r1', 'r2'], r4: ['r2', 'r3'], r5: ['r3', 'r4'] },
  ),

  defineCase({
    id: 'graph/same-project-four-task-chain',
    category: 'graph',
    kind: 'correctness',
    title: 'Four tasks of one project chained by name run in that order',
    why: 'A project’s own pipeline (generate, compile, bundle, pack) is a chain of bare-name edges. Each step must wait for the one before. A tool that treats bare names as hints, or runs a project’s tasks in declaration order, packs before the bundle exists.',
    from: ['task-graph', 'scheduler'],
    races: 2,
    workspace: {
      projects: {
        a: {
          tasks: {
            gen: {
              command: 'mkdir -p dist && cat src/a.txt > dist/gen.txt',
              inputs: ['src/**'],
              outputs: ['dist/gen.txt'],
            },
            compile: {
              command: 'cat dist/gen.txt > dist/compile.txt',
              dependsOn: ['gen'],
              inputs: ['src/**'],
              outputs: ['dist/compile.txt'],
            },
            bundle: {
              command: 'cat dist/compile.txt > dist/bundle.txt',
              dependsOn: ['compile'],
              inputs: ['src/**'],
              outputs: ['dist/bundle.txt'],
            },
            pack: {
              command: 'cat dist/bundle.txt > dist/pack.txt',
              dependsOn: ['bundle'],
              inputs: ['src/**'],
              outputs: ['dist/pack.txt'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      {
        run: 'pack',
        expect: {
          exit: 0,
          order: [
            ['a#gen', 'a#compile'],
            ['a#compile', 'a#bundle'],
            ['a#bundle', 'a#pack'],
          ],
          files: { 'packages/a/dist/pack.txt': 'a\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/two-explicit-edges-into-one-project',
    category: 'graph',
    kind: 'correctness',
    title: 'A task naming two tasks of another project waits for both',
    why: 'A task can need two things from one project (its codegen and its build). Both edges are separate: the task waits for each. A tool that keys edges by project, and keeps one task per project, drops the other and starts too soon.',
    from: ['task-graph', 'task-edge-selection'],
    races: 2,
    workspace: {
      projects: {
        lib: {
          tasks: {
            gen: {
              command: 'mkdir -p gen && sleep 0.3 && echo g > gen/g.txt',
              inputs: ['src/**'],
              outputs: ['gen/**'],
            },
            build: {
              command: 'mkdir -p dist && echo b > dist/b.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'l\n', '.gitignore': 'gen\n' },
        },
        app: {
          tasks: {
            build: {
              command: 'mkdir -p dist && cat ../lib/gen/g.txt ../lib/dist/b.txt > dist/out.txt',
              dependsOn: ['lib#gen', 'lib#build'],
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['app'],
        expect: {
          exit: 0,
          order: [
            ['lib#gen', 'app#build'],
            ['lib#build', 'app#build'],
          ],
          files: { 'packages/app/dist/out.txt': 'g\nb\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/uncached-dependency-runs-before-cached-dependant',
    category: 'graph',
    kind: 'correctness',
    title: 'A never-cached dependency runs before the cached task that needs it, on every run',
    why: 'A never-cached step (a fetch, a codegen from the network) still has dependants. They must wait for it each time it runs, cached or not. A tool that treats an uncached task as outside the graph starts the dependant beside it and reads a half-written file.',
    from: ['task-graph', 'uncached-outputs'],
    workspace: {
      projects: {
        a: {
          tasks: {
            fetch: {
              command: 'mkdir -p gen && sleep 0.3 && cat src/a.txt > gen/f.txt',
              cache: false,
              inputs: ['src/**'],
              outputs: ['gen/**'],
            },
            build: {
              command: 'mkdir -p dist && cat gen/f.txt > dist/out.txt',
              dependsOn: ['fetch'],
              inputs: ['src/**', 'gen/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a\n', '.gitignore': 'gen\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, order: [['a#fetch', 'a#build']] } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#fetch'], files: { 'packages/a/dist/out.txt': 'a\n' } },
      },
    ],
    needs: ['uncached-task'],
  }),

  // task-orchestrator.spec.ts should return a result for a held-back task skipped by its failed dependency
  defineCase({
    id: 'failure/independent-work-runs-past-a-failure',
    category: 'failure',
    kind: 'correctness',
    title:
      'A failure skips only what depends on it: an unrelated task that starts later still runs',
    why: 'A failed library says nothing about an unrelated project. Skipping that project’s work, even work that would only start after the failure, hides every other result of the run and makes the next run rebuild it. The run fails, the failure’s dependant does not run, and the unrelated project still builds.',
    from: ['run-failures-store', 'failure-mode'],
    workspace: {
      projects: {
        bad: { tasks: { build: FAIL }, files: { 'src/a.txt': 'x\n' } },
        app: chainProject('app', ['bad']),
        slow: slow(),
        later: chainProject('later', ['slow']),
      },
    },
    steps: [
      {
        run: 'build',
        expect: {
          exit: 'fail',
          ran: ['slow#build', 'later#build'],
          notRan: ['app#build'],
          files: { 'packages/later/dist/out.txt': 'slow\nlater\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'failure/work-past-a-failure-is-saved',
    category: 'failure',
    kind: 'efficiency',
    title: 'What built beside a failure replays once the failure is fixed',
    why: 'The tasks that passed in a failed run passed: their outputs are as good as any. A tool that saves nothing from a failed run makes the fix cost a rebuild of everything else. After the fix only the failed task and its dependants run.',
    from: ['run-failures-store', 'failure-mode'],
    workspace: {
      projects: {
        bad: { tasks: { build: FAIL }, files: { 'src/a.txt': 'x\n' } },
        app: chainProject('app', ['bad']),
        ok: chainProject('ok'),
      },
    },
    steps: [
      { run: 'build', expect: { exit: 'fail', ran: ['ok#build'], notRan: ['app#build'] } },
      {
        configure: (ws) => ({
          ...ws,
          projects: { ...ws.projects, bad: chainProject('bad') },
        }),
      },
      { run: 'build', expect: { exit: 0, ran: ['bad#build', 'app#build'], notRan: ['ok#build'] } },
    ],
  }),

  defineCase({
    id: 'failure/diamond-arm-failure-keeps-the-other-arm',
    category: 'failure',
    kind: 'correctness',
    title: 'A failure in one arm of a diamond still runs the other arm, and not the join',
    why: 'In a diamond the two arms are independent; only the join needs both. A failure in one arm skips the join and nothing else. A tool that cancels the whole subgraph under the shared root throws away the other arm’s result. The other arm runs; the join does not.',
    from: ['run-failures-store', 'failure-mode'],
    workspace: {
      projects: {
        root: chainProject('root'),
        left: {
          deps: ['root'],
          tasks: { build: { ...FAIL, dependsOn: ['^build'] } },
          files: { 'src/a.txt': 'l\n' },
        },
        right: chainProject('right', ['root']),
        join: chainProject('join', ['left', 'right']),
      },
    },
    steps: [
      {
        run: 'build',
        expect: { exit: 'fail', ran: ['root#build', 'right#build'], notRan: ['join#build'] },
      },
    ],
  }),

  defineCase({
    id: 'failure/mid-chain-failure-keeps-what-is-below',
    category: 'failure',
    kind: 'correctness',
    title: 'A failure in the middle of a chain keeps what built below it, and runs nothing above',
    why: 'The links below a failure built before it and passed. They stay built and replay next time; the links above never start. A tool that rolls back the whole chain, or starts the links above, leaves a misleading tree. The bottom ran, the top did not.',
    from: ['run-failures-store', 'failure-mode'],
    workspace: {
      projects: {
        c0: chainProject('c0'),
        c1: {
          deps: ['c0'],
          tasks: { build: { ...FAIL, dependsOn: ['^build'] } },
          files: { 'src/a.txt': 'x\n' },
        },
        c2: chainProject('c2', ['c1']),
        c3: chainProject('c3', ['c2']),
      },
    },
    steps: [
      {
        run: 'build',
        expect: {
          exit: 'fail',
          ran: ['c0#build'],
          notRan: ['c2#build', 'c3#build'],
          files: { 'packages/c0/dist/out.txt': 'c0\n' },
        },
      },
      { run: 'build', projects: ['c0'], expect: { exit: 0, notRan: ['c0#build'] } },
    ],
  }),

  defineCase({
    id: 'failure/two-failures-in-separate-branches',
    category: 'failure',
    kind: 'correctness',
    title: 'Two failing projects in separate branches each skip only their own dependants',
    why: 'A run can hold more than one failure. Each skips what depends on it, and a third branch still builds. A tool that stops at the first failure hides the second, and the user fixes one, reruns, and only then learns of the other. The healthy branch runs.',
    from: ['run-failures-store', 'failure-mode'],
    workspace: {
      projects: {
        b1: { tasks: { build: FAIL }, files: { 'src/a.txt': 'x\n' } },
        b2: { tasks: { build: FAIL }, files: { 'src/a.txt': 'x\n' } },
        u1: chainProject('u1', ['b1']),
        u2: chainProject('u2', ['b2']),
        slow: slow(),
        ok: chainProject('ok', ['slow']),
      },
    },
    steps: [
      {
        run: 'build',
        expect: { exit: 'fail', ran: ['slow#build', 'ok#build'], notRan: ['u1#build', 'u2#build'] },
      },
    ],
  }),

  // Nx e2e extras.test.ts should fail and skip dependents when a command cannot start
  defineCase({
    id: 'failure/missing-program-skips-dependents',
    category: 'failure',
    kind: 'correctness',
    title: 'A task whose program does not exist fails, and what depends on it does not run',
    why: 'A missing binary (a tool not installed, a typo) makes the shell exit 127. That is a failed task like any other: its dependants must not run on an output that was never written. A tool that treats a spawn error differently from a failing exit can let them start. The run fails and the dependant is skipped.',
    from: ['run-failures-store', 'no-shell-on-path'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: {
              command: 'no-such-program-anywhere --build',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'l\n' },
        },
        app: chainProject('app', ['lib']),
      },
    },
    steps: [{ run: 'build', expect: { exit: 'fail', notRan: ['app#build'] } }],
  }),

  defineCase({
    id: 'failure/non-executable-script-fails',
    category: 'failure',
    kind: 'correctness',
    title: 'A task running a script without its executable bit fails, and is not cached',
    why: 'A script checked in without `+x` cannot run; the shell exits 126. The task failed and nothing it should have written exists. A tool that misreads the spawn error as success, or caches the failure as a pass, replays a build that never happened. The run fails, and fails again next time.',
    from: ['run-failures-store', 'bins-executable.unsafe'],
    workspace: {
      projects: {
        a: {
          tasks: { build: { command: './src/build.sh', inputs: ['src/**'], outputs: ['dist/**'] } },
          files: { 'src/build.sh': '#!/bin/sh\nmkdir -p dist && echo ok > dist/out.txt\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 'fail', files: { 'packages/a/dist/out.txt': null } } },
      { run: 'build', expect: { exit: 'fail', files: { 'packages/a/dist/out.txt': null } } },
    ],
  }),

  defineCase({
    id: 'failure/failing-prerequisite-of-own-project',
    category: 'failure',
    kind: 'correctness',
    title: 'A task whose own project’s prerequisite fails does not run, while other projects’ do',
    why: 'A `test` that depends on its project’s `lint` must not run when the lint fails. Another project’s test, whose lint passed, has nothing to do with it. A tool that skips by task name across projects skips that one too. The other project’s test runs.',
    from: ['run-failures-store', 'task-graph'],
    workspace: {
      projects: {
        a: {
          tasks: {
            lint: { command: 'exit 1', inputs: ['src/**'], outputs: [] },
            test: { command: 'true', dependsOn: ['lint'], inputs: ['src/**'], outputs: [] },
          },
          files: { 'src/a.txt': 'a\n' },
        },
        b: {
          tasks: {
            lint: { command: 'sleep 1', inputs: ['src/**'], outputs: [] },
            test: { command: 'true', dependsOn: ['lint'], inputs: ['src/**'], outputs: [] },
          },
          files: { 'src/a.txt': 'b\n' },
        },
      },
    },
    steps: [
      { run: 'test', expect: { exit: 'fail', ran: ['b#lint', 'b#test'], notRan: ['a#test'] } },
    ],
  }),
]
