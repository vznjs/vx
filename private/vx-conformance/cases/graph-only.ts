// A run that skips what the selected tasks depend on (Turborepo's `--only`,
// Nx's `--excludeTaskDependencies`, vx's `--exclude-dependencies`). Skipping
// a dependency drops it from the schedule, never from the key: the
// dependant still reads that dependency's output.
import { defineCase, type WorkspaceSpec } from '../src/spec.ts'
import { chainProject, out } from './shapes.ts'

const FROM = ['exclude-dependencies-key', 'exclude-dependencies-properties']

/** lib ← app: app's build copies lib's output after its own source. */
function libApp(): WorkspaceSpec {
  return { projects: { lib: chainProject('lib'), app: chainProject('app', ['lib']) } }
}

/** base ← lib ← app, each build reading its dependency's output. */
function baseLibApp(): WorkspaceSpec {
  return {
    projects: {
      base: chainProject('base'),
      lib: chainProject('lib', ['base']),
      app: chainProject('app', ['lib']),
    },
  }
}

export default [
  defineCase({
    id: 'graph/only-skips-dependencies',
    category: 'graph',
    kind: 'correctness',
    title: 'Skipping dependencies runs the selected task and not what it depends on',
    why: 'Skipping dependencies is an explicit request to run just the selected task against what is already on disk. It saves time when the user knows the dependencies are current, such as rerunning one app after a full build. Running lib anyway ignores the flag, and not running app at all drops the work that was asked for.',
    from: FROM,
    needs: ['filter'],
    workspace: libApp(),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['lib#build', 'app#build'] } },
      { write: { 'packages/app/src/a.txt': 'app2\n' } },
      {
        run: 'build',
        projects: ['app'],
        only: true,
        expect: {
          exit: 0,
          ran: ['app#build'],
          notRan: ['lib#build'],
          files: { [out('app')]: 'lib\napp2\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/only-replays-full-run',
    category: 'graph',
    kind: 'efficiency',
    title: 'A task the full run built replays when its dependencies are skipped',
    why: 'Skipping a dependency changes the schedule, not the task: app reads the same lib output and sources as in the full run. Its result is already cached, so it should replay. Rebuilding it just because the dependency was skipped wastes the cache exactly when the user is trying to save time.',
    from: FROM,
    needs: ['filter'],
    workspace: libApp(),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['lib#build', 'app#build'] } },
      {
        run: 'build',
        projects: ['app'],
        only: true,
        expect: {
          exit: 0,
          notRan: ['lib#build', 'app#build'],
          files: { [out('app')]: 'lib\napp\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/only-dependency-change-reruns',
    category: 'graph',
    kind: 'correctness',
    title: 'With dependencies skipped, a dependency rebuilt since still reruns its dependant',
    why: 'app reads lib’s output, so a new lib must give app a new cache key even when lib is not scheduled. Here lib was rebuilt on its own since app last ran. A key that leaves out the skipped lib replays app built on the old lib, and the stale bundle ships under a green run.',
    from: FROM,
    needs: ['filter'],
    workspace: libApp(),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', projects: ['app'], only: true, expect: { exit: 0 } },
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      { run: 'build', projects: ['lib'], expect: { exit: 0, ran: ['lib#build'] } },
      {
        run: 'build',
        projects: ['app'],
        only: true,
        expect: { exit: 0, ran: ['app#build'], files: { [out('app')]: 'lib2\napp\n' } },
      },
    ],
  }),

  defineCase({
    id: 'graph/only-two-hops-change-reruns',
    category: 'graph',
    kind: 'correctness',
    title: 'With dependencies skipped, a change two dependencies down still reruns the dependant',
    why: 'base reaches app through lib’s output, so a change to base must change app’s key even with both skipped. The key has to fold the skipped lib and everything lib itself folds. Stopping one level down replays app with the old base inside it, which no error will ever point out.',
    from: FROM,
    needs: ['filter'],
    workspace: baseLibApp(),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/base/src/a.txt': 'base2\n' } },
      { run: 'build', projects: ['lib'], expect: { exit: 0 } },
      {
        run: 'build',
        projects: ['app'],
        only: true,
        expect: {
          exit: 0,
          ran: ['app#build'],
          notRan: ['lib#build', 'base#build'],
          files: { [out('app')]: 'base2\nlib\napp\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/only-stale-dependency-not-saved',
    category: 'graph',
    kind: 'correctness',
    title: 'What a run builds on a skipped, out-of-date dependency never replays in a full run',
    why: 'When dependencies are skipped, app may build on a lib output older than lib’s sources. That result is valid for this run only and must not be stored under the key a full run will look up. Otherwise the next full build rebuilds lib but replays app with the old lib baked in.',
    from: FROM,
    needs: ['filter'],
    workspace: libApp(),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      { run: 'build', projects: ['app'], only: true, expect: { exit: 0, notRan: ['lib#build'] } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['lib#build'],
          files: { [out('app')]: 'lib2\napp\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/only-requested-dependency-replays',
    category: 'graph',
    kind: 'efficiency',
    title: 'Skipping dependencies with a dependency also selected replays both',
    why: 'Selecting app and lib with dependencies skipped asks for both, and nothing either reads has changed since the full run. Both should replay from cache. Rebuilding either one only because the skipped base was left out of the schedule wastes the time the flag exists to save.',
    from: FROM,
    needs: ['filter'],
    workspace: baseLibApp(),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      {
        run: 'build',
        projects: ['app', 'lib'],
        only: true,
        expect: { exit: 0, notRan: ['app#build', 'lib#build', 'base#build'] },
      },
    ],
  }),

  defineCase({
    id: 'graph/only-requested-dependency-ordered',
    category: 'graph',
    kind: 'correctness',
    title: 'Two selected tasks keep their order when the task between them is skipped',
    why: 'app builds on base through lib, so when both base and app are selected, base must finish first even though lib between them is skipped. Run side by side, app reads whatever base left on disk last time, or a half-written file. Skipping a task drops it from the run; it does not drop the order between the tasks that remain.',
    from: FROM,
    needs: ['filter'],
    workspace: baseLibApp(),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/base/src/a.txt': 'base2\n', 'packages/app/src/a.txt': 'app2\n' } },
      {
        run: 'build',
        projects: ['app', 'base'],
        only: true,
        expect: {
          exit: 0,
          ran: ['base#build', 'app#build'],
          notRan: ['lib#build'],
          order: [['base#build', 'app#build']],
        },
      },
    ],
  }),
]
