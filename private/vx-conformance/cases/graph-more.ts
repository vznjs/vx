// The rest of what the graph tests guard that any runner can show: the
// concurrency limit, what a failure or a replay holds back, which tasks a
// run asks for, projects in unusual directories, selection over task edges,
// and servers a run skips, replays past or hands arguments to.
import { defineCase, type ProjectSpec, type TaskSpec, type WorkspaceSpec } from '../src/spec.ts'
import { CONCAT, chainProject, out } from './shapes.ts'

/** Wait (bounded) for a file, then go on. */
const until = (file: string) =>
  `i=0; until [ -e ${file} ] || [ $i -ge 400 ]; do sleep 0.05; i=$((i+1)); done; [ -e ${file} ]`

/**
 * Takes one of `slots` lock directories at the workspace root for 0.3 s; a
 * task that finds every slot taken writes `overlap` and fails.
 */
function slotted(slots: number, after = ''): TaskSpec {
  const take = Array.from(
    { length: slots },
    (_, i) => `mkdir ../../slot${i} 2>/dev/null; then s=slot${i}`,
  )
  return {
    command: `if ${take.join('; elif ')}; else touch ../../overlap; exit 1; fi; sleep 0.3; rmdir ../../$s${after}`,
    cache: false,
  }
}

/** `n` independent projects p0…, each with this one `work` task. */
function many(n: number, task: TaskSpec): WorkspaceSpec {
  return {
    projects: Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`p${i}`, { tasks: { work: task } }]),
    ),
  }
}
const all = (n: number) => Array.from({ length: n }, (_, i) => `p${i}#work`)

/** A project whose `check` reads only its own source. */
const checked = (deps: string[] = [], tasks: Record<string, TaskSpec> = {}): ProjectSpec => ({
  deps,
  tasks: { check: { command: 'true', inputs: ['src/**'] }, ...tasks },
  files: { 'src/a.txt': 'x\n' },
})

/** A dev server that reads its own sources and says it is up. */
const server = (extra: Partial<TaskSpec> = {}): TaskSpec => ({
  command: 'touch up; sleep 60',
  persistent: true,
  inputs: ['src/**'],
  ...extra,
})

/** A cached test of `web` that waits for api's server, then copies its source. */
const e2e: TaskSpec = {
  command: `${until('../api/up')} && mkdir -p dist && cat src/a.txt > dist/out.txt`,
  dependsOn: ['api#dev'],
  inputs: ['src/**'],
  outputs: ['dist/**'],
}

/** api's server, and `web` (and `docs`) testing against it. */
function behindServer(withDocs = false): WorkspaceSpec {
  return {
    projects: {
      api: { tasks: { dev: server() }, files: { 'src/a.txt': 'api\n' } },
      web: { tasks: { e2e }, files: { 'src/a.txt': 'web\n' } },
      ...(withDocs ? { docs: { tasks: { e2e }, files: { 'src/a.txt': 'docs\n' } } } : {}),
    },
  }
}

/** `lib` writes dist/out.txt uncached (it fails while `broken` exists); app builds on it, cached; app's test reads lib's output. */
function behindReplay(): WorkspaceSpec {
  return {
    projects: {
      lib: {
        tasks: {
          gen: {
            command:
              'test ! -e ../../broken && sleep 0.5 && mkdir -p dist && cat ../../stamp.txt > dist/out.txt',
            cache: false,
          },
        },
      },
      app: {
        deps: ['lib'],
        tasks: {
          build: {
            command: 'mkdir -p dist && cat src/a.txt > dist/out.txt',
            dependsOn: ['^gen'],
            inputs: ['src/**'],
            outputs: ['dist/**'],
          },
          test: {
            command: 'cat ../lib/dist/out.txt dist/out.txt > seen.txt',
            dependsOn: ['build'],
            cache: false,
          },
        },
        files: { 'src/a.txt': 'app\n' },
      },
    },
    files: { 'stamp.txt': 'one\n' },
  }
}

/** A server that writes the args it was started with, and a smoke test that copies them once they are there. */
function argsServer(ready: boolean): WorkspaceSpec {
  const write = `printf '<%s>' "$@" > got.tmp && mv got.tmp got.txt`
  return {
    projects: {
      app: {
        tasks: {
          dev: {
            command: ready ? `${write} && echo READY && sleep 60` : `${write} && sleep 60`,
            persistent: ready ? { ready: 'READY' } : true,
            takesArgs: true,
          },
          smoke: {
            command: `${until('got.txt')} && cp got.txt seen.tmp && mv seen.tmp seen.txt`,
            dependsOn: ['dev'],
            takesArgs: true,
            cache: false,
          },
        },
      },
    },
  }
}

function argsCase(slug: string, title: string, ready: boolean, args: string[], why?: string) {
  return defineCase({
    id: `graph/${slug}`,
    category: 'graph',
    kind: 'correctness',
    title,
    ...(why ? { why } : {}),
    from: ['persistent'],
    needs: ready ? ['persistent', 'ready', 'multi-task'] : ['persistent', 'multi-task'],
    workspace: argsServer(ready),
    steps: [
      {
        run: 'smoke',
        also: ['dev'],
        projects: ['app'],
        args,
        // A server the run was asked for runs until stopped.
        stop: { signal: 'SIGINT', when: 'packages/app/seen.txt' },
        expect: {
          ran: ['app#dev', 'app#smoke'],
          files: { 'packages/app/seen.txt': args.map((a) => `<${a}>`).join('') },
          within: 30,
          alone: true,
        },
      },
    ],
  })
}

/** lib, app (depends on lib) and e2e, whose test names app#build alone: no package dependency. */
function taskEdge(): WorkspaceSpec {
  const both = (deps: string[] = []): ProjectSpec => ({
    deps,
    tasks: {
      build: { command: 'true', cache: false },
      test: { command: 'true', cache: false },
    },
  })
  return {
    projects: {
      lib: both(),
      app: both(['lib']),
      e2e: { tasks: { test: { command: 'true', dependsOn: ['app#build'], cache: false } } },
    },
  }
}

export default [
  defineCase({
    id: 'graph/concurrency-one-runs-one-at-a-time',
    category: 'graph',
    kind: 'correctness',
    title: 'At a concurrency of 1, independent tasks run one at a time',
    from: ['scheduler', 'run-concurrency'],
    needs: ['uncached-task'],
    workspace: many(3, slotted(1)),
    steps: [
      {
        run: 'work',
        concurrency: 1,
        expect: { exit: 0, ran: all(3), files: { overlap: null }, within: 30 },
      },
    ],
  }),

  defineCase({
    id: 'graph/concurrency-limit-holds',
    category: 'graph',
    kind: 'correctness',
    title: 'At a concurrency of 2, no more than two tasks run at once',
    from: ['scheduler'],
    needs: ['uncached-task'],
    workspace: many(5, slotted(2)),
    steps: [
      {
        run: 'work',
        concurrency: 2,
        expect: { exit: 0, ran: all(5), files: { overlap: null }, within: 30 },
      },
    ],
  }),

  defineCase({
    id: 'graph/concurrency-limit-holds-through-failures',
    category: 'graph',
    kind: 'correctness',
    title: 'Tasks that fail still count against the concurrency limit while they run',
    why: 'A failing task is still a process using its slot until it exits.',
    from: ['scheduler'],
    needs: ['uncached-task'],
    workspace: many(4, slotted(1, '; exit 1')),
    steps: [
      {
        run: 'work',
        concurrency: 1,
        expect: { exit: 'fail', files: { overlap: null }, within: 30 },
      },
    ],
  }),

  defineCase({
    id: 'graph/concurrency-above-task-count',
    category: 'graph',
    kind: 'correctness',
    title: 'A concurrency far above the number of tasks runs them all and ends',
    from: ['scheduler'],
    needs: ['uncached-task'],
    workspace: many(3, { command: 'true', cache: false }),
    steps: [{ run: 'work', concurrency: 1000, expect: { exit: 0, ran: all(3), within: 30 } }],
  }),

  defineCase({
    id: 'failure/skip-cascades-down-a-chain',
    category: 'failure',
    kind: 'correctness',
    title: 'A failure at the bottom of a chain runs nothing above it',
    from: ['scheduler'],
    workspace: {
      projects: {
        base: {
          tasks: { build: { command: 'exit 3', inputs: ['src/**'], outputs: ['dist/**'] } },
          files: { 'src/a.txt': 'base\n' },
        },
        lib: chainProject('lib', ['base']),
        app: chainProject('app', ['lib']),
      },
    },
    steps: [{ run: 'build', expect: { exit: 'fail', notRan: ['lib#build', 'app#build'] } }],
  }),

  defineCase({
    id: 'graph/behind-a-replay-waits-for-its-deps',
    category: 'graph',
    kind: 'correctness',
    title: 'A task behind a replayed task still waits for what the replayed one depends on',
    why: 'app’s test reads lib’s output as well as app’s; a replay restored early is no sign lib is done.',
    from: ['scheduler'],
    needs: ['uncached-task'],
    workspace: behindReplay(),
    steps: [
      { run: 'test', projects: ['app'], expect: { exit: 0 } },
      { write: { 'stamp.txt': 'two\n' } },
      {
        run: 'test',
        projects: ['app'],
        expect: {
          exit: 0,
          ran: ['lib#gen', 'app#test'],
          order: [['lib#gen', 'app#test']],
          files: { 'packages/app/seen.txt': 'two\napp\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'failure/failed-dependency-stops-what-is-behind-a-replay',
    category: 'failure',
    kind: 'correctness',
    title: 'A failed dependency stops the task behind a replayed one from running',
    why: 'app’s test reads lib’s output; lib failed, so what it would read is stale.',
    from: ['scheduler'],
    needs: ['uncached-task'],
    workspace: behindReplay(),
    steps: [
      { run: 'test', projects: ['app'], expect: { exit: 0 } },
      { write: { broken: '' } },
      { run: 'test', projects: ['app'], expect: { exit: 'fail', notRan: ['app#test'] } },
    ],
  }),

  defineCase({
    id: 'graph/server-starts-when-one-dependant-misses',
    category: 'graph',
    kind: 'correctness',
    title: 'A server starts when one of the tasks that need it must run, though another replays',
    from: ['scheduler', 'persistent'],
    needs: ['persistent'],
    workspace: behindServer(true),
    steps: [
      { run: 'e2e', expect: { exit: 0, within: 30 } },
      { write: { 'packages/docs/src/a.txt': 'docs2\n' } },
      {
        run: 'e2e',
        expect: {
          exit: 0,
          ran: ['api#dev', 'docs#e2e'],
          files: { 'packages/docs/dist/out.txt': 'docs2\n' },
          within: 30,
          alone: true,
        },
      },
    ],
  }),

  defineCase({
    id: 'failure/server-behind-a-failed-build-never-starts',
    category: 'failure',
    kind: 'correctness',
    title: 'A server whose own build fails never starts, nor does what needs it',
    from: ['scheduler'],
    needs: ['persistent'],
    workspace: {
      projects: {
        api: {
          tasks: {
            gen: { command: 'exit 3', cache: false },
            dev: { ...server(), dependsOn: ['gen'] },
          },
          files: { 'src/a.txt': 'api\n' },
        },
        web: { tasks: { e2e }, files: { 'src/a.txt': 'web\n' } },
      },
    },
    steps: [
      {
        run: 'e2e',
        expect: { exit: 'fail', notRan: ['api#dev', 'web#e2e'], within: 30, alone: true },
      },
    ],
  }),

  defineCase({
    id: 'graph/task-absent-pulls-no-dependencies',
    category: 'graph',
    kind: 'efficiency',
    title: 'A project without the requested task runs none of the tasks it would need',
    why: 'docs declares no verify; its build is no one’s dependency in this run (turborepo#9589).',
    from: ['task-selection'],
    workspace: {
      projects: {
        web: {
          tasks: {
            build: { command: 'true', inputs: ['src/**'] },
            verify: { command: 'true', dependsOn: ['build'], inputs: ['src/**'] },
          },
          files: { 'src/a.txt': 'web\n' },
        },
        docs: {
          tasks: { build: { command: 'true', inputs: ['src/**'] } },
          files: { 'src/a.txt': 'docs\n' },
        },
      },
    },
    steps: [
      {
        run: 'verify',
        expect: { exit: 0, ran: ['web#build', 'web#verify'], notRan: ['docs#build'] },
      },
    ],
  }),

  defineCase({
    id: 'failure/unknown-task-beside-a-known-one-fails',
    category: 'failure',
    kind: 'correctness',
    title: 'Asking for two tasks, one of which no project declares, fails the run',
    why: 'A typo dropped because the other name resolved exits 0 having skipped what was asked.',
    from: ['task-selection'],
    needs: ['multi-task'],
    workspace: { projects: { a: checked([], { build: { command: 'true', inputs: ['src/**'] } }) } },
    steps: [{ run: 'build', also: ['totallybogus'], expect: { exit: 'fail' } }],
  }),

  defineCase({
    id: 'graph/two-tasks-some-projects-declare',
    category: 'graph',
    kind: 'correctness',
    title: 'Two tasks in one run each run where declared, though one project lacks one',
    from: ['task-selection'],
    needs: ['multi-task'],
    workspace: {
      projects: {
        a: checked([], {
          build: { command: 'true', inputs: ['src/**'] },
          lint: { command: 'true', inputs: ['src/**'] },
        }),
        b: checked([], { build: { command: 'true', inputs: ['src/**'] } }),
      },
    },
    steps: [
      {
        run: 'build',
        also: ['lint'],
        expect: { exit: 0, ran: ['a#build', 'a#lint', 'b#build'], notRan: ['a#check'] },
      },
    ],
  }),

  defineCase({
    id: 'graph/two-tasks-both-run',
    category: 'graph',
    kind: 'correctness',
    title: 'Two tasks one project declares both run in one run',
    from: ['task-selection'],
    needs: ['multi-task'],
    workspace: {
      projects: {
        a: checked([], {
          build: { command: 'true', inputs: ['src/**'] },
          test: { command: 'true', inputs: ['src/**'] },
        }),
      },
    },
    steps: [{ run: 'build', also: ['test'], expect: { exit: 0, ran: ['a#build', 'a#test'] } }],
  }),

  defineCase({
    id: 'failure/task-only-outside-selection-fails',
    category: 'failure',
    kind: 'correctness',
    title: 'Asking for a task in a project that does not declare it fails the run',
    why: 'Only b declares typecheck; a run of a’s typecheck that exits 0 checked nothing.',
    from: ['task-selection'],
    workspace: {
      projects: {
        a: checked(),
        b: checked([], { typecheck: { command: 'true', inputs: ['src/**'] } }),
      },
    },
    steps: [
      {
        run: 'typecheck',
        projects: ['a'],
        expect: { exit: 'fail', notRan: ['b#typecheck'] },
      },
    ],
  }),

  defineCase({
    id: 'graph/select-exclude-keeps-root-project',
    category: 'graph',
    kind: 'correctness',
    title: 'Excluding one member keeps the workspace-root project’s task',
    why: 'The exclude names b alone; the root is a project like any other (turborepo#9619).',
    from: ['task-selection', 'filter'],
    needs: ['filter'],
    workspace: {
      projects: {
        root: { dir: '.', tasks: { check: { command: 'true', inputs: ['tools/**'] } } },
        a: checked(),
        b: checked(),
      },
      files: { 'tools/t.txt': 't\n' },
    },
    steps: [
      {
        run: 'check',
        select: [{ name: 'b', exclude: true }],
        expect: { exit: 0, ran: ['root#check', 'a#check'], notRan: ['b#check'] },
      },
    ],
  }),

  defineCase({
    id: 'graph/select-root-project-by-name',
    category: 'graph',
    kind: 'correctness',
    title: 'Selecting the workspace-root project by name runs its task and not its members’',
    why: 'The members sit in the root’s directory, but each is a project of its own.',
    from: ['filter'],
    needs: ['filter'],
    workspace: {
      projects: {
        root: { dir: '.', tasks: { check: { command: 'true', inputs: ['tools/**'] } } },
        a: checked(),
      },
      files: { 'tools/t.txt': 't\n' },
    },
    steps: [
      {
        run: 'check',
        select: [{ name: 'root' }],
        expect: { exit: 0, ran: ['root#check'], notRan: ['a#check'] },
      },
    ],
  }),

  defineCase({
    id: 'graph/select-emptied-beside-no-match-refused',
    category: 'graph',
    kind: 'correctness',
    title:
      'A selection its excludes leave empty, beside a selector matching nothing, fails the run',
    why: 'Nothing runs and one selector names no project: a typo that exits 0 lets CI pass having checked nothing.',
    from: ['select'],
    needs: ['filter'],
    workspace: { projects: { ui: checked(), lib: checked() } },
    steps: [
      {
        run: 'check',
        select: [{ name: 'ui' }, { name: 'ui', exclude: true }, { name: 'nope' }],
        expect: { exit: 'fail', notRan: ['lib#check'] },
      },
    ],
  }),

  defineCase({
    id: 'graph/unusual-project-dirs',
    category: 'graph',
    kind: 'correctness',
    title:
      'Projects under a dot directory, under underscored names, and two of one base name each run',
    why: 'Each is listed as a project; a runner that skips dot or `__x__` directories, or merges two `same`s, drops one.',
    from: ['project-dirs'],
    workspace: {
      projects: Object.fromEntries(
        [
          ['dotted', '.config/c'],
          ['generated', 'libs/__generated__'],
          ['under', 'libs/_x_'],
          ['same-x', 'x/same'],
          ['same-y', 'y/same'],
        ].map(([name, dir]) => [
          name!,
          {
            dir: dir!,
            tasks: { hello: { command: 'pwd > /dev/null', cache: false } },
          },
        ]),
      ),
    },
    steps: [
      {
        run: 'hello',
        expect: {
          exit: 0,
          ran: ['dotted#hello', 'generated#hello', 'under#hello', 'same-x#hello', 'same-y#hello'],
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/project-dir-with-parentheses',
    category: 'graph',
    kind: 'correctness',
    title: 'A project whose directory holds spaces and parentheses runs there, caches and restores',
    from: ['project-dirs'],
    workspace: {
      projects: {
        app: {
          dir: 'apps/my app (1)',
          tasks: {
            build: {
              command:
                'mkdir -p dist && cp "src/in put.txt" dist/out.txt && basename "$PWD" > dist/cwd.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/in put.txt': 'v1\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['app#build'],
          files: { 'apps/my app (1)/dist/cwd.txt': 'my app (1)\n' },
        },
      },
      { write: { 'apps/my app (1)/dist': null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['app#build'],
          files: {
            'apps/my app (1)/dist/out.txt': 'v1\n',
            'apps/my app (1)/dist/cwd.txt': 'my app (1)\n',
          },
        },
      },
    ],
  }),

  defineCase({
    id: 'affected/change-reaches-task-edge-dependent',
    category: 'affected',
    kind: 'correctness',
    title: 'A change selects a project whose task names the changed project’s task',
    why: 'app declares it needs lib#build; leaving app out of the affected run leaves it untested on the new lib.',
    from: ['project-dirs', 'select'],
    needs: ['affected'],
    workspace: {
      projects: {
        lib: {
          tasks: { build: { command: 'true', inputs: ['src/**'] } },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: {
          tasks: { build: { command: 'true', dependsOn: ['lib#build'], inputs: ['src/**'] } },
          files: { 'src/a.txt': 'app\n' },
        },
        other: {
          tasks: { build: { command: 'true', inputs: ['src/**'] } },
          files: { 'src/a.txt': 'other\n' },
        },
      },
    },
    steps: [
      { commit: 'init' },
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      { commit: 'lib' },
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['lib#build', 'app#build'], notRan: ['other#build'] },
      },
    ],
  }),

  defineCase({
    id: 'graph/select-dependencies-through-task-edge',
    category: 'graph',
    kind: 'correctness',
    title: 'Selecting a project’s dependencies follows a task it names in another project',
    why: 'e2e’s test needs app#build; app is its dependency though no manifest says so, and lib is app’s.',
    from: ['task-edge-selection', 'filter'],
    needs: ['filter', 'select-walk', 'uncached-task'],
    workspace: taskEdge(),
    steps: [
      {
        run: 'test',
        select: [{ name: 'e2e', with: 'dependencies', self: false }],
        expect: { exit: 0, ran: ['app#test', 'lib#test'], notRan: ['e2e#test'] },
      },
    ],
  }),

  defineCase({
    id: 'graph/select-dependents-through-package-then-task-edge',
    category: 'graph',
    kind: 'correctness',
    title:
      'A project’s dependents reach through a package dependency and then a task another project names',
    why: 'app depends on lib, and e2e’s test needs app#build: a change to lib reaches e2e.',
    from: ['task-edge-selection'],
    needs: ['filter', 'select-walk', 'uncached-task'],
    workspace: taskEdge(),
    steps: [
      {
        run: 'test',
        select: [{ name: 'lib', with: 'dependents' }],
        expect: { exit: 0, ran: ['lib#test', 'app#test', 'e2e#test', 'app#build'] },
      },
    ],
  }),

  defineCase({
    id: 'cache/server-source-change-reruns-dependant',
    category: 'cache',
    kind: 'correctness',
    title: 'A cached test behind a dev server runs again when the server’s sources change',
    why: 'The test passed against the old server; replaying it vouches for a server it never saw.',
    from: ['exclude-dependencies-key'],
    needs: ['persistent'],
    workspace: behindServer(),
    steps: [
      { run: 'e2e', projects: ['web'], expect: { exit: 0, within: 30 } },
      { run: 'e2e', projects: ['web'], expect: { exit: 0, within: 30 } },
      { write: { 'packages/api/src/a.txt': 'api2\n' } },
      {
        run: 'e2e',
        projects: ['web'],
        expect: { exit: 0, ran: ['api#dev', 'web#e2e'], within: 30, alone: true },
      },
    ],
  }),

  defineCase({
    id: 'graph/only-skipped-server-replays-dependant',
    category: 'graph',
    kind: 'efficiency',
    title:
      'With dependencies skipped, a test behind an unchanged server replays and no server starts',
    why: 'Nothing the test or its server reads changed since the full run built it.',
    from: ['exclude-dependencies-key'],
    needs: ['persistent', 'filter'],
    workspace: behindServer(),
    steps: [
      { run: 'e2e', projects: ['web'], expect: { exit: 0, ran: ['web#e2e'], within: 30 } },
      {
        run: 'e2e',
        projects: ['web'],
        only: true,
        expect: { exit: 0, notRan: ['api#dev', 'web#e2e'], within: 30, alone: true },
      },
    ],
  }),

  defineCase({
    id: 'graph/only-every-skipped-dependency-keyed',
    category: 'graph',
    kind: 'correctness',
    title:
      'With dependencies skipped, each selected task reruns on any of its rebuilt dependencies',
    why: 'app reads lib and base, top reads tool; keying on the first dependency only replays app or top built on the old one.',
    from: ['exclude-dependencies-key'],
    needs: ['filter'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        base: chainProject('base'),
        tool: chainProject('tool'),
        app: chainProject('app', ['lib', 'base']),
        top: chainProject('top', ['tool']),
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/base/src/a.txt': 'base2\n', 'packages/tool/src/a.txt': 'tool2\n' } },
      { run: 'build', projects: ['base', 'tool'], expect: { exit: 0 } },
      {
        run: 'build',
        projects: ['app', 'top'],
        only: true,
        expect: {
          exit: 0,
          ran: ['app#build', 'top#build'],
          notRan: ['lib#build', 'base#build', 'tool#build'],
          files: { [out('app')]: 'lib\nbase2\napp\n', [out('top')]: 'tool2\ntop\n' },
        },
      },
    ],
  }),

  argsCase(
    'server-gets-forwarded-args',
    'Args forwarded to a run reach a requested server’s command',
    false,
    ['--port', '3000'],
  ),

  argsCase(
    'ready-server-gets-forwarded-args',
    'Args forwarded to a run reach a requested server that prints a ready line',
    true,
    ['--port', '3000'],
    'A server held until ready is started like any other: `dev -- --port 4000` must not lose the port.',
  ),

  argsCase(
    'server-args-reach-it-literally',
    'Args forwarded to a server reach it as typed, never expanded by a shell',
    false,
    ['$(id -u)', '`id -u`', '$HOME', 'a b'],
    'The user quoted them; a shell expanding them runs what the user never asked to run.',
  ),

  defineCase({
    id: 'failure/sighup-grandchild-cleanup',
    category: 'failure',
    kind: 'correctness',
    title: 'A closed terminal lets a process a task backgrounded run its cleanup',
    why: 'Killing it outright, as a run that dies of the hang-up does, skips the cleanup it traps for.',
    from: ['task-tree-kill'],
    workspace: {
      projects: {
        a: {
          tasks: {
            t: {
              command: `sh -c 'trap "sleep 0.3; echo done > cleanup.txt; exit 0" TERM HUP; touch started; while :; do sleep 0.05; done' & sleep 60`,
            },
          },
        },
      },
    },
    steps: [
      {
        run: 't',
        stop: { signal: 'SIGHUP', when: 'packages/a/started' },
        expect: {
          exit: 'fail',
          files: { 'packages/a/cleanup.txt': 'done\n' },
          within: 20,
          alone: true,
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/new-depends-on-edge-keys-consumer',
    category: 'graph',
    kind: 'correctness',
    title:
      'A `dependsOn` edge added to a task orders and keys it: an edit to the dependency then runs it again',
    from: ['parity-turbo', 'task-hash-derive'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        // A package dependency from the start; only the task edge is new.
        app: {
          deps: ['lib'],
          tasks: { build: { command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] } },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('app')]: 'app\n' } } },
      {
        configure: (ws) => ({
          ...ws,
          projects: { ...ws.projects, app: chainProject('app', ['lib']) },
        }),
      },
      { run: 'build', expect: { exit: 0, files: { [out('app')]: 'lib\napp\n' } } },
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['app#build'], files: { [out('app')]: 'lib2\napp\n' } },
      },
    ],
  }),
]
