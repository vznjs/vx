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
    why: 'A member’s task may depend on a task of the workspace-root project, such as code generation over shared tools. That dependency must be honoured like any other edge, with the root task finishing first. Running the member first reads a missing or stale generated file, or races the generator.',
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
    why: 'The workspace root can be a project with its own tasks, reading files no member owns. When such a file changes, the root task’s key changes and the task must run again. Replaying the cached result would ship output generated from the old file.',
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
    why: 'A project owns the files under it except those inside a nested project. For the workspace-root project, every member is nested, so a root task over `**` does not read the members’ files. Rerunning it on every member edit would rebuild the root on nearly every change in the workspace.',
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
    why: 'The outer git records a nested repository as one path, or not at all, so it never lists the files inside. A task whose input glob covers them still reads those files. A key built only from the outer repository misses the edit and replays output built from the old content.',
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
    why: 'A file at the workspace root that no member owns belongs to the workspace-root project. A change to it must select that project’s tasks, like a change in any member. Treating root files as nobody’s skips root tasks such as code generation that read them.',
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
    why: 'A member file lies under the workspace root, but the member owns it, not the root project. An edit there selects the member alone. Also selecting the root project would rerun root tasks on nearly every change, since every member file is under the root.',
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
