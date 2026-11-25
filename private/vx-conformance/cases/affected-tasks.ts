// `affected` decided per task by its inputs (M, 2026-11-25): a change marks
// the tasks that read it and the tasks that depend on those, never a whole
// project.
import { defineCase, type TaskSpec, type WorkspaceSpec } from '../src/spec.ts'

const BUILD: TaskSpec = {
  command: 'mkdir -p dist && cat src/a.txt > dist/out.txt',
  dependsOn: ['^build'],
  inputs: ['src/**'],
  outputs: ['dist/out.txt'],
}
const TEST: TaskSpec = {
  command: 'cat src/a.txt',
  dependsOn: ['build'],
  inputs: ['src/**'],
  outputs: [],
}

/** lib ← app, and docs on its own; each builds and tests its own sources, and has a README no task reads. */
function libApp(extra: Record<string, TaskSpec> = {}): WorkspaceSpec {
  const project = (name: string, deps: string[] = []) => ({
    deps,
    tasks: { build: BUILD, test: TEST, ...extra },
    files: { 'src/a.txt': `${name}\n`, 'README.md': `${name}\n` },
  })
  return { projects: { lib: project('lib'), app: project('app', ['lib']), docs: project('docs') } }
}

/** {@link libApp} with lib's tasks replaced: what app's `build` reaches through `^build`. */
function libTasks(tasks: Record<string, TaskSpec>): WorkspaceSpec {
  const ws = libApp()
  ws.projects['lib']!.tasks = tasks
  return ws
}

/** No command and inputs: a package whose build is its sources, as is. */
const NO_OP: TaskSpec = { inputs: ['src/**'] }

const editLib = (file = 'src/a.txt') => [
  { write: { [`packages/lib/${file}`]: 'lib2\n' } },
  { commit: 'edit lib' },
]

export default [
  defineCase({
    id: 'affected/undeclared-file-marks-no-task',
    category: 'affected',
    kind: 'efficiency',
    title: 'An edit to a file no task declares selects no task, in its project or its dependents',
    why: 'Every task here declares the files it reads, and none reads the README. Editing it cannot change any result, so an affected run has nothing to do. Selecting the project’s tasks, and its dependents’ through them, because the file sits in the project reruns work whose answer is already known.',
    from: ['affected-by-inputs'],
    needs: ['affected'],
    workspace: libApp(),
    steps: [
      ...editLib('README.md'),
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, notRan: ['lib#test', 'app#test', 'docs#test'] },
      },
    ],
  }),

  defineCase({
    id: 'cache/definition-edit-misses-task-and-dependents',
    category: 'cache',
    kind: 'correctness',
    title: 'A new command for a task reruns it and every task that depends on it, and only those',
    why: 'A task’s definition is part of what it produces: a new command can write other bytes. The task and every task built on its result must miss the cache, while a project with no edge to it still replays. Replaying the old result under the new command is a stale hit that ships the wrong build.',
    from: ['affected-by-inputs', 'task-hash-derive'],
    workspace: libApp(),
    steps: [
      { run: 'test', expect: { exit: 0, ran: ['lib#test', 'app#test', 'docs#test'] } },
      {
        configure: (ws) => {
          const lib = ws.projects['lib']!
          const tasks = { ...lib.tasks, build: { ...BUILD, command: `${BUILD.command} && true` } }
          return { ...ws, projects: { ...ws.projects, lib: { ...lib, tasks } } }
        },
      },
      {
        run: 'test',
        expect: {
          exit: 0,
          ran: ['lib#build', 'lib#test', 'app#build', 'app#test'],
          notRan: ['docs#build', 'docs#test'],
        },
      },
    ],
  }),

  defineCase({
    id: 'affected/task-without-inputs-always-selected',
    category: 'affected',
    kind: 'correctness',
    title: 'A task that declares no inputs is selected when its project or a project it depends on changes',
    why: 'A task that names no inputs has not said which of its project’s files it reads, so any edit in its project, or in a project it depends on, may change its result. An affected run must select it there. Leaving it out because nothing declared the edited file skips a check the edit can make fail; selecting it in a project the edit cannot reach reruns work for nothing.',
    from: ['affected-by-inputs'],
    needs: ['affected'],
    workspace: libApp({ check: { command: 'cat README.md' } }),
    steps: [
      ...editLib('README.md'),
      {
        affected: 'check',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['lib#check', 'app#check'], notRan: ['docs#check'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/empty-inputs-task-reached-through-dependency',
    category: 'affected',
    kind: 'correctness',
    title: 'A task that reads no files is selected when a task it depends on is',
    why: 'Empty inputs say the task reads none of its own project’s files, not that nothing can change it. A deploy step that waits on a build depends on that build’s result. When the build is affected, the step is too; leaving it out ships the old build while the new one passes.',
    from: ['affected-by-inputs'],
    needs: ['affected'],
    workspace: (() => {
      const ws = libApp()
      ws.projects['app']!.tasks = {
        ...ws.projects['app']!.tasks,
        ship: { command: 'echo shipped', dependsOn: ['build'], inputs: [], outputs: [] },
      }
      ws.projects['docs']!.tasks = {
        ...ws.projects['docs']!.tasks,
        ship: { command: 'echo shipped', dependsOn: ['build'], inputs: [], outputs: [] },
      }
      return ws
    })(),
    steps: [
      ...editLib(),
      {
        affected: 'ship',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['app#ship'], notRan: ['docs#ship'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/unaffected-task-not-restored',
    category: 'affected',
    kind: 'efficiency',
    title:
      'A task the change does not reach is not restored from the cache, though its project changed',
    why: 'An affected run selects the tasks a change reaches, not every task of a changed project. The project’s `guide` reads only its own folder, so an edit to its sources leaves it out. Replaying it from the cache anyway downloads and writes outputs nobody asked for, and on a remote cache each one costs a round trip.',
    from: ['affected-by-inputs'],
    needs: ['affected'],
    workspace: libApp({
      guide: {
        command: 'mkdir -p dist && cat guide/a.txt > dist/guide.txt',
        inputs: ['guide/**'],
        outputs: ['dist/guide.txt'],
      },
    }),
    steps: [
      { write: { 'packages/lib/guide/a.txt': 'guide\n' } },
      { commit: 'guide' },
      { run: 'guide', projects: ['lib'], expect: { exit: 0, ran: ['lib#guide'] } },
      { write: { 'packages/lib/dist/guide.txt': null } },
      ...editLib(),
      {
        affected: 'guide',
        base: 'HEAD~1',
        expect: {
          exit: 0,
          notRan: ['lib#guide'],
          files: { 'packages/lib/dist/guide.txt': null },
        },
      },
    ],
  }),

  defineCase({
    id: 'affected/no-op-task-input-reaches-dependants',
    category: 'affected',
    kind: 'correctness',
    title:
      'A task with inputs and no command passes its files’ changes to the tasks that depend on it',
    why: 'A package whose build has nothing to do, its sources used as they are, still has a build its dependants wait on. Its inputs say which files are its result. An edit there changes what the dependants build from, so they are affected; leaving them out because the task runs nothing ships a build of the old sources.',
    from: ['affected-by-inputs'],
    needs: ['affected'],
    workspace: libTasks({ build: NO_OP }),
    steps: [
      ...editLib(),
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['app#build'], notRan: ['docs#build'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/no-op-task-unread-file-reaches-nobody',
    category: 'affected',
    kind: 'efficiency',
    title: 'A task with inputs and no command passes on no change to a file it does not declare',
    why: 'A task that runs nothing is still keyed by the inputs it declares, and no further. An edit to a file outside them changes nothing its dependants build from. Selecting them because the file sits in the same project reruns builds whose answer is already known.',
    from: ['affected-by-inputs'],
    needs: ['affected'],
    workspace: libTasks({ build: NO_OP }),
    steps: [
      ...editLib('README.md'),
      { affected: 'build', base: 'HEAD~1', expect: { exit: 0, notRan: ['app#build'] } },
    ],
  }),

  defineCase({
    id: 'affected/group-own-files-reach-nobody',
    category: 'affected',
    kind: 'efficiency',
    title:
      'A task with no command and no inputs is not affected by its own project’s files, only by the tasks it groups',
    why: 'A task with neither a command nor inputs only groups others. It reads no file, so an edit in its project reaches it only through a task it groups. Here the grouped task reads the README alone, so a source edit leaves the group and its dependants with nothing new to build from; selecting them reruns work the edit cannot change.',
    from: ['affected-by-inputs'],
    needs: ['affected'],
    workspace: libTasks({
      check: { command: 'cat README.md', inputs: ['README.md'], outputs: [] },
      build: { dependsOn: ['check'] },
    }),
    steps: [
      ...editLib(),
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: { exit: 0, notRan: ['lib#check', 'app#build'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/group-reached-through-its-dependency',
    category: 'affected',
    kind: 'correctness',
    title: 'A task with no command and no inputs is affected when a task it groups is',
    why: 'A group stands for the tasks it depends on. When one of them reads the edited file, the group is affected, and so is every task that waits on the group. Stopping at the group because it reads no files itself leaves the dependants building from the old result.',
    from: ['affected-by-inputs'],
    needs: ['affected'],
    workspace: libTasks({
      check: { command: 'cat src/a.txt', inputs: ['src/**'], outputs: [] },
      build: { dependsOn: ['check'] },
    }),
    steps: [
      ...editLib(),
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['lib#check', 'app#build'], notRan: ['docs#build'] },
      },
    ],
  }),
]
