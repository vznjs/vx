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
    why: 'Nothing it reads changed; skipping the dependency changes the schedule, not the task.',
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
    why: 'app reads lib’s output; a replay keyed without lib ships app built on the old lib.',
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
    why: 'base reaches app through lib’s output; the key must fold the skipped lib and what lib folds.',
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
    why: 'lib’s output predates its edited source; saved under the key a full run derives, app would replay the old lib.',
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
    why: 'app builds on base through lib; run beside base it reads whatever base left last time.',
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
