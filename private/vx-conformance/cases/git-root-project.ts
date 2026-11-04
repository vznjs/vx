// The workspace root as a project of its own: a task over the files no
// member owns, which a member's task can depend on.
import { defineCase, type WorkspaceSpec } from '../src/spec.ts'
import { CONCAT, out } from './shapes.ts'

/** `root` (the workspace root) generates out/gen.txt from tools/; `a` builds its own sources. */
function workspace(): WorkspaceSpec {
  return {
    projects: {
      root: {
        dir: '.',
        tasks: {
          build: {
            command: 'mkdir -p out && cat tools/gen.txt > out/gen.txt',
            inputs: ['**', '!out/**'],
            outputs: ['out/**'],
          },
        },
        files: { 'tools/gen.txt': 'one\n' },
      },
      a: {
        tasks: {
          build: { command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] },
          test: {
            command: 'mkdir -p got && cat ../../out/gen.txt > got/gen.txt',
            dependsOn: ['root#build'],
            inputs: ['src/**'],
            outputs: ['got/**'],
          },
        },
        files: { 'src/a.txt': 'a\n' },
      },
    },
  }
}

export default [
  defineCase({
    id: 'graph/root-task-before-member',
    category: 'graph',
    kind: 'correctness',
    title: 'A member’s task that depends on a workspace-root task runs after it',
    from: ['root-project'],
    workspace: workspace(),
    steps: [
      {
        run: 'test',
        projects: ['a'],
        expect: {
          exit: 0,
          ran: ['root#build', 'a#test'],
          order: [['root#build', 'a#test']],
          files: { 'packages/a/got/gen.txt': 'one\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'inputs/root-task-reads-root-files',
    category: 'inputs',
    kind: 'correctness',
    title: 'Editing a root file a workspace-root task reads runs it again',
    from: ['root-project'],
    workspace: workspace(),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['root#build'] } },
      { write: { 'tools/gen.txt': 'two\n' } },
      { run: 'build', expect: { exit: 0, ran: ['root#build'], files: { 'out/gen.txt': 'two\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/root-task-ignores-members',
    category: 'inputs',
    kind: 'efficiency',
    title: 'Editing a member’s file leaves a workspace-root task over `**` replayed',
    why: 'Each member’s files are that member’s: the root project owns only the files no member holds.',
    from: ['root-project'],
    workspace: workspace(),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['root#build', 'a#build'] } },
      { write: { 'packages/a/src/a.txt': 'edited\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['a#build'],
          notRan: ['root#build'],
          files: { [out('a')]: 'edited\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'inputs/root-glob-over-nested-repo',
    category: 'inputs',
    kind: 'correctness',
    title:
      'An edit inside a nested repository a workspace-level input glob covers runs the task again',
    why: 'The outer git holds the nested repository as one path, or none; its files are still what the task reads.',
    from: ['workspace-files-nested-repo'],
    workspace: {
      projects: {
        root: {
          dir: '.',
          tasks: {
            build: {
              command: 'mkdir -p out && cat vendor/lib.txt > out/o.txt',
              inputs: ['vendor/**'],
              outputs: ['out/**'],
            },
          },
          files: { 'vendor/lib.txt': 'v1\n' },
        },
        a: { tasks: {}, files: { 'src/a.txt': 'a\n' } },
      },
    },
    steps: [
      {
        sh: 'git rm -rq --cached vendor && git -C vendor init -q && git -C vendor add -A && git -C vendor commit -qm v && git commit -qm untrack',
      },
      { run: 'build', expect: { exit: 0, ran: ['root#build'] } },
      { run: 'build', expect: { exit: 0, notRan: ['root#build'] } },
      { write: { 'vendor/lib.txt': 'v2\n' } },
      { run: 'build', expect: { exit: 0, ran: ['root#build'], files: { 'out/o.txt': 'v2\n' } } },
    ],
  }),

  defineCase({
    id: 'affected/root-file-selects-root-project',
    category: 'affected',
    kind: 'correctness',
    title: 'A changed root file no member owns selects the workspace-root project',
    from: ['root-project'],
    needs: ['affected'],
    workspace: workspace(),
    steps: [
      { write: { 'tools/gen.txt': 'two\n' } },
      { affected: 'build', base: 'HEAD', expect: { exit: 0, ran: ['root#build'] } },
    ],
  }),

  defineCase({
    id: 'affected/member-file-not-root-project',
    category: 'affected',
    kind: 'efficiency',
    title: 'A changed member file selects the member, not the workspace-root project holding it',
    from: ['root-project'],
    needs: ['affected'],
    workspace: workspace(),
    steps: [
      { write: { 'packages/a/src/a.txt': 'edited\n' } },
      {
        affected: 'build',
        base: 'HEAD',
        expect: { exit: 0, ran: ['a#build'], notRan: ['root#build'] },
      },
    ],
  }),
]
