// A watch: one run that stays up and runs tasks again on each edit. An
// edit it misses leaves the tree stale while the terminal says it is
// current; an edit it answers too often (its own outputs, ignored files,
// unchanged bytes) runs work nothing asked for, or never settles.
import { defineCase, type WorkspaceSpec } from '../src/spec.ts'
import { CONCAT, chainProject, out } from './shapes.ts'

const cached = { command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] }

/** a and b, each building its own src into dist, unrelated. */
const two: WorkspaceSpec = {
  projects: {
    a: { tasks: { build: cached }, files: { 'src/a.txt': 'a\n', '.gitignore': '*.log\n' } },
    b: { tasks: { build: cached }, files: { 'src/a.txt': 'b\n' } },
  },
}

const started = { ran: ['a#build', 'b#build'] }
const FROM = ['watch-loop-edits', 'watch-loop-selfwrite']

export default [
  defineCase({
    id: 'watch/edit-reruns-its-project',
    category: 'watch',
    kind: 'correctness',
    title: 'An edit to a project’s input runs its task again, and the result is current',
    from: FROM,
    needs: ['watch'],
    workspace: two,
    steps: [
      {
        watch: 'build',
        start: started,
        phases: [{ write: { 'packages/a/src/a.txt': 'a2\n' }, expect: { ran: ['a#build'] } }],
        files: { [out('a')]: 'a2\n' },
      },
    ],
  }),

  defineCase({
    id: 'watch/edit-spares-other-projects',
    category: 'watch',
    kind: 'efficiency',
    title: 'An edit to one project runs nothing in a project that does not depend on it',
    from: FROM,
    needs: ['watch'],
    workspace: two,
    steps: [
      {
        watch: 'build',
        start: started,
        phases: [{ write: { 'packages/a/src/a.txt': 'a2\n' }, expect: { notRan: ['b#build'] } }],
      },
    ],
  }),

  defineCase({
    id: 'watch/edit-reruns-dependants',
    category: 'watch',
    kind: 'correctness',
    title: 'An edit to a dependency runs it and the project built on it, which ends current',
    from: FROM,
    needs: ['watch'],
    workspace: { projects: { lib: chainProject('lib'), app: chainProject('app', ['lib']) } },
    steps: [
      {
        watch: 'build',
        start: { ran: ['lib#build', 'app#build'] },
        phases: [
          {
            write: { 'packages/lib/src/a.txt': 'lib2\n' },
            expect: { ran: ['lib#build', 'app#build'] },
          },
        ],
        files: { [out('app')]: 'lib2\napp\n' },
      },
    ],
  }),

  defineCase({
    id: 'watch/own-outputs-start-nothing',
    category: 'watch',
    kind: 'efficiency',
    title: 'What a task writes to its outputs does not run it again',
    why: 'Answered as an edit, a build’s own dist would run it forever.',
    from: FROM,
    needs: ['watch'],
    workspace: two,
    steps: [
      {
        watch: 'build',
        start: started,
        phases: [{ expect: { notRan: ['a#build', 'b#build'] } }],
      },
    ],
  }),

  defineCase({
    id: 'watch/same-bytes-start-nothing',
    category: 'watch',
    kind: 'efficiency',
    title: 'Saving a file with the same bytes runs nothing',
    from: FROM,
    needs: ['watch'],
    workspace: two,
    steps: [
      {
        watch: 'build',
        start: started,
        phases: [{ write: { 'packages/a/src/a.txt': 'a\n' }, expect: { notRan: ['a#build'] } }],
      },
    ],
  }),

  defineCase({
    id: 'watch/burst-is-one-run',
    category: 'watch',
    kind: 'efficiency',
    title: 'Several files saved at once run the task once',
    from: FROM,
    needs: ['watch'],
    workspace: two,
    steps: [
      {
        watch: 'build',
        start: started,
        phases: [
          {
            write: Object.fromEntries(
              [1, 2, 3, 4, 5].map((n) => [`packages/a/src/f${n}.txt`, `${n}\n`]),
            ),
            expect: { times: { 'a#build': 1 } },
          },
        ],
        files: { [out('a')]: 'a\n1\n2\n3\n4\n5\n' },
      },
    ],
  }),

  defineCase({
    id: 'watch/deleted-input-reruns',
    category: 'watch',
    kind: 'correctness',
    title: 'Deleting an input runs the task again, without it',
    from: FROM,
    needs: ['watch'],
    workspace: {
      projects: {
        a: { tasks: { build: cached }, files: { 'src/a.txt': 'a\n', 'src/b.txt': 'b\n' } },
      },
    },
    steps: [
      {
        watch: 'build',
        start: { ran: ['a#build'] },
        phases: [{ write: { 'packages/a/src/b.txt': null }, expect: { ran: ['a#build'] } }],
        files: { [out('a')]: 'a\n' },
      },
    ],
  }),

  defineCase({
    id: 'watch/file-in-new-directory-reruns',
    category: 'watch',
    kind: 'correctness',
    title: 'A file in a directory made after the watch started runs the task again',
    why: 'A watch armed on the directories that existed at start never hears the new one.',
    from: ['watch-recreated-dirs'],
    needs: ['watch'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'mkdir -p dist && cat $(find src -name "*.txt" | sort) > dist/out.txt',
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
        watch: 'build',
        start: { ran: ['a#build'] },
        phases: [
          { write: { 'packages/a/src/new/deep/x.txt': 'x\n' }, expect: { ran: ['a#build'] } },
          { write: { 'packages/a/src/new/deep/x.txt': 'x2\n' }, expect: { ran: ['a#build'] } },
        ],
        files: { [out('a')]: 'a\nx2\n' },
      },
    ],
  }),

  defineCase({
    id: 'watch/rename-over-reruns',
    category: 'watch',
    kind: 'correctness',
    title: 'A save that writes a temporary file and renames it over the input runs the task again',
    why: 'Editors save this way: the input’s file is replaced, not written.',
    from: ['watch-label-live-path', 'watch-transient-file'],
    needs: ['watch'],
    workspace: two,
    steps: [
      {
        watch: 'build',
        start: started,
        phases: [
          {
            sh: 'printf "a2\\n" > packages/a/a.tmp && mv packages/a/a.tmp packages/a/src/a.txt',
            expect: { ran: ['a#build'] },
          },
        ],
        files: { [out('a')]: 'a2\n' },
      },
    ],
  }),

  defineCase({
    id: 'watch/ignored-writes-start-nothing',
    category: 'watch',
    kind: 'efficiency',
    title: 'Writes to files git ignores run nothing',
    from: FROM,
    needs: ['watch'],
    workspace: two,
    steps: [
      {
        watch: 'build',
        start: started,
        phases: [{ write: { 'packages/a/debug.log': 'x\n' }, expect: { notRan: ['a#build'] } }],
      },
    ],
  }),

  defineCase({
    id: 'watch/ignored-burst-keeps-the-edit',
    category: 'watch',
    kind: 'correctness',
    title: 'An edit saved among many writes to ignored files still runs the task, once',
    why: 'Dropped with the noise around it, the edit leaves the result stale.',
    from: FROM,
    needs: ['watch'],
    workspace: two,
    steps: [
      {
        watch: 'build',
        start: started,
        phases: [
          {
            write: {
              ...Object.fromEntries(
                Array.from({ length: 30 }, (_, n) => [`packages/a/run${n}.log`, `${n}\n`]),
              ),
              'packages/a/src/a.txt': 'a2\n',
            },
            expect: { times: { 'a#build': 1 } },
          },
        ],
        files: { [out('a')]: 'a2\n' },
      },
    ],
  }),

  defineCase({
    id: 'watch/non-input-edit-runs-nothing',
    category: 'watch',
    kind: 'efficiency',
    title: 'An edit to a project file no task reads runs nothing',
    from: FROM,
    needs: ['watch'],
    workspace: two,
    steps: [
      {
        watch: 'build',
        start: started,
        phases: [{ write: { 'packages/a/README.md': 'notes\n' }, expect: { notRan: ['a#build'] } }],
      },
    ],
  }),

  defineCase({
    id: 'watch/edits-in-turn-each-run',
    category: 'watch',
    kind: 'correctness',
    title: 'Edits made one after another each run the task, and the last one wins',
    from: FROM,
    needs: ['watch'],
    workspace: two,
    steps: [
      {
        watch: 'build',
        start: started,
        phases: [
          { write: { 'packages/a/src/a.txt': 'a2\n' }, expect: { times: { 'a#build': 1 } } },
          { write: { 'packages/b/src/a.txt': 'b2\n' }, expect: { times: { 'b#build': 1 } } },
          { write: { 'packages/a/src/a.txt': 'a3\n' }, expect: { times: { 'a#build': 1 } } },
        ],
        files: { [out('a')]: 'a3\n', [out('b')]: 'b2\n' },
      },
    ],
  }),
]
