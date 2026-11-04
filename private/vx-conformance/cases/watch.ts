// Watch mode: a task runs, then runs again as its files change, until the
// user stops it. Each phase makes one change under the running watch and
// judges what followed by the marks and files the tasks leave.
import type { Case, ProjectSpec, Step, TaskSpec, WatchPhase, WorkspaceSpec } from '../src/spec.ts'
import { defineCase } from '../src/spec.ts'
import { CONCAT, chainProject } from './shapes.ts'

const OUT = 'packages/app/dist/out.txt'
const A = 'packages/app/src/a.txt'

/** A cached build of `src/**` into `dist/`. */
const build = (command = CONCAT, extra: Partial<TaskSpec> = {}): TaskSpec => ({
  command,
  inputs: ['src/**'],
  outputs: ['dist/**'],
  ...extra,
})

/** One project, `app`, whose build concatenates its sources. */
const app = (extra: Partial<ProjectSpec> = {}, task: Partial<TaskSpec> = {}): WorkspaceSpec => ({
  projects: {
    app: {
      tasks: { build: build(task.command, task) },
      ...extra,
      files: { 'src/a.txt': 'a1\n', 'notes.md': 'notes\n', ...extra.files },
    },
  },
})

/** lib ← app, each building its dependencies' output and its own sources. */
const chain = (): WorkspaceSpec => ({
  projects: { lib: chainProject('lib'), app: chainProject('app', ['lib']) },
})

/** The initial run: `tasks` ran and left these files. */
const initial = (tasks: string[], files: Record<string, string | null>): WatchPhase => ({
  expect: { ran: tasks, files },
})

const firstBuild = initial(['app#build'], { [OUT]: 'a1\n' })

/** A watch case: the steps `before`, then `build` watched through `phases`. */
function watchCase(
  c: Omit<Case, 'category' | 'needs' | 'steps'> & {
    phases: WatchPhase[]
    projects?: string[]
    before?: Step[]
  },
): Case {
  const { phases, projects, before = [], ...rest } = c
  return defineCase({
    ...rest,
    category: 'watch',
    needs: ['watch'],
    steps: [...before, { watch: 'build', ...(projects ? { projects } : {}), phases }],
  })
}

export default [
  watchCase({
    id: 'watch/input-edit-reruns',
    kind: 'correctness',
    title: 'Editing a source file while watching rebuilds with the new content',
    why: 'Rerunning a task when what it reads changes is the whole point of watching. The output must hold the new source, not the one the watch started with. A watch that misses the edit leaves a stale build that looks fresh, so the user tests old code and trusts the result.',
    from: ['watch-loop'],
    workspace: app(),
    phases: [
      firstBuild,
      { write: { [A]: 'a2\n' }, expect: { ran: ['app#build'], files: { [OUT]: 'a2\n' } } },
    ],
  }),

  watchCase({
    id: 'watch/edit-outside-inputs-reruns-nothing',
    kind: 'efficiency',
    title: 'Editing a file the task does not read reruns nothing',
    why: 'The task said which files it reads, and the edited file is not one of them. Running it again would build the same output from the same inputs. Work done for a file nobody reads only delays the result the user is waiting for, and in a large project that wait comes with every save.',
    from: ['watch-loop', 'watch-rules'],
    workspace: app(),
    phases: [
      firstBuild,
      { write: { 'packages/app/notes.md': 'edited\n' }, expect: { notRan: ['app#build'] } },
    ],
  }),

  watchCase({
    id: 'watch/same-bytes-rerun-nothing',
    kind: 'efficiency',
    title: 'Saving a file without changing it reruns nothing',
    why: 'An editor that saves on focus loss, or a formatter with nothing to fix, writes the same bytes again. The task reads the content of its files, and the content did not change. A rerun here repeats work whose result is already on disk, and it happens on every idle save.',
    from: ['watch-loop', 'watch-mode-change'],
    workspace: app(),
    phases: [firstBuild, { write: { [A]: 'a1\n' }, expect: { notRan: ['app#build'] } }],
  }),

  watchCase({
    id: 'watch/edit-back-replays',
    kind: 'efficiency',
    title: 'Undoing an edit while watching brings back the earlier result without rebuilding',
    why: 'After the undo the inputs are exactly the ones an earlier run already built. That result can be put back as it was, which is both correct and immediate. Building it again gives the same bytes and only costs the user time, on the edit people make most while trying things out.',
    from: ['watch-loop'],
    workspace: app(),
    phases: [
      firstBuild,
      { write: { [A]: 'a2\n' }, expect: { ran: ['app#build'], files: { [OUT]: 'a2\n' } } },
      { write: { [A]: 'a1\n' }, expect: { notRan: ['app#build'], files: { [OUT]: 'a1\n' } } },
    ],
  }),

  watchCase({
    id: 'watch/new-input-file-reruns',
    kind: 'correctness',
    title: 'A new file matching the task’s inputs rebuilds with it included',
    why: 'Inputs given as a pattern also cover files that do not exist yet. Adding a source file changes what the task reads as surely as editing one does. A watch that only follows the files present at the start misses one of the most common edits of all, a new module, and the build quietly leaves it out.',
    from: ['watch-transient-file', 'watch-tree-linux'],
    workspace: app(),
    phases: [
      firstBuild,
      {
        write: { 'packages/app/src/b.txt': 'b1\n' },
        expect: { ran: ['app#build'], files: { [OUT]: 'a1\nb1\n' } },
      },
    ],
  }),

  watchCase({
    id: 'watch/deleted-input-reruns',
    kind: 'correctness',
    title: 'Deleting a source file rebuilds without it',
    why: 'A deleted file is no longer part of what the task reads, so the output built with it is now wrong. Keeping that output would ship code the user just removed. A deletion is a change to the inputs exactly as an edit is, and the next build must show the tree as it now stands.',
    from: ['watch-transient-file', 'watch-unignored-deletion', 'watch-label-live-path'],
    workspace: app({ files: { 'src/b.txt': 'b1\n' } }),
    phases: [
      initial(['app#build'], { [OUT]: 'a1\nb1\n' }),
      {
        write: { 'packages/app/src/b.txt': null },
        expect: { ran: ['app#build'], files: { [OUT]: 'a1\n' } },
      },
    ],
  }),

  watchCase({
    id: 'watch/file-in-new-directory-reruns',
    kind: 'correctness',
    title: 'A file added in a new folder under the inputs rebuilds with it',
    why: 'A pattern over a folder covers its subfolders, including ones made after the watch started. Creating a folder and a file in it is a normal edit while adding a feature. A watch that only follows the folders it saw at the start misses this file, and the build silently leaves it out.',
    from: ['watch-tree-linux', 'watch-recreated-dirs'],
    workspace: app(
      {},
      { command: 'mkdir -p dist && cat $(find src -type f | sort) > dist/out.txt' },
    ),
    phases: [
      firstBuild,
      {
        write: { 'packages/app/src/sub/c.txt': 'c1\n' },
        expect: { ran: ['app#build'], files: { [OUT]: 'a1\nc1\n' } },
      },
    ],
  }),

  watchCase({
    id: 'watch/empty-directory-reruns-nothing',
    kind: 'efficiency',
    title: 'Creating an empty folder under the inputs reruns nothing',
    why: 'An empty folder holds no file the task could read, so the task’s output cannot change. Version control does not even record an empty folder. A rerun for it is work that produces the same bytes again, and it happens every time a tool or an editor makes a scratch folder.',
    from: ['watch-empty-dir'],
    workspace: app(
      {},
      { command: 'mkdir -p dist && cat $(find src -type f | sort) > dist/out.txt' },
    ),
    phases: [firstBuild, { sh: 'mkdir packages/app/src/empty', expect: { notRan: ['app#build'] } }],
  }),

  watchCase({
    id: 'watch/ignored-file-reruns-nothing',
    kind: 'efficiency',
    title: 'A change to a git-ignored file among the sources reruns nothing',
    why: 'Ignored files are scratch: logs, editor swap files, local caches. They are not part of what the task builds from, and a cache key does not see them. A rerun on each of their writes is busy work, and when the task itself writes such a file it can keep the watch busy forever.',
    from: ['watch-loop-selfwrite', 'watch-root-scope', 'watch-judge-fence'],
    workspace: app({ files: { '.gitignore': '*.log\n' } }),
    phases: [
      firstBuild,
      { write: { 'packages/app/src/debug.log': 'trace\n' }, expect: { notRan: ['app#build'] } },
    ],
  }),

  watchCase({
    id: 'watch/output-does-not-retrigger',
    kind: 'efficiency',
    title: 'A build’s own output does not start it again',
    why: 'The task writes its output after reading its inputs, and the output is not one of them. Treating that write as a new change would build once more, or loop for good. After one edit the task should run exactly once, and then the watch should go quiet until the user changes something.',
    from: ['watch-loop-uncached', 'watch-rules', 'watch-project-dir-write'],
    workspace: app(),
    phases: [
      firstBuild,
      { write: { [A]: 'a2\n' }, expect: { ran: ['app#build'], files: { [OUT]: 'a2\n' } } },
      { expect: { notRan: ['app#build'] } },
    ],
  }),

  watchCase({
    id: 'watch/tracked-output-does-not-retrigger',
    kind: 'efficiency',
    title: 'A build writing a declared output folder that git does not ignore does not loop',
    why: 'Some projects keep their built files next to the sources, where version control does not ignore them. They are still declared as the task’s output, not its input, and only inputs decide whether to run again. Rerunning on its own output turns every edit into a loop that never settles.',
    from: ['watch-rules', 'watch-restored-output', 'watch-project-dir-write'],
    workspace: app(
      {},
      { command: 'mkdir -p lib && cat src/*.txt > lib/out.txt', outputs: ['lib/**'] },
    ),
    phases: [
      initial(['app#build'], { 'packages/app/lib/out.txt': 'a1\n' }),
      {
        write: { [A]: 'a2\n' },
        expect: { ran: ['app#build'], files: { 'packages/app/lib/out.txt': 'a2\n' } },
      },
      { expect: { notRan: ['app#build'] } },
    ],
  }),

  watchCase({
    id: 'watch/ignored-side-file-does-not-loop',
    kind: 'efficiency',
    title: 'A build that rewrites an ignored side file every run does not loop',
    why: 'A process id file or a timestamped log differs on every run, so its bytes never settle. It is ignored by version control, so no input can depend on it. A watch that follows it reruns the task on its own leftovers without end, and the machine never goes idle between edits.',
    from: ['watch-loop-selfwrite'],
    workspace: app(
      { files: { '.gitignore': 'run.pid\n' } },
      { command: `echo $$ > run.pid && ${CONCAT}` },
    ),
    phases: [
      firstBuild,
      { write: { [A]: 'a2\n' }, expect: { ran: ['app#build'], files: { [OUT]: 'a2\n' } } },
      { expect: { notRan: ['app#build'] } },
    ],
  }),

  watchCase({
    id: 'watch/many-edits-one-rerun',
    kind: 'efficiency',
    title: 'Many files changed at once, as a checkout does, rebuild once',
    why: 'Switching branches or pulling rewrites many files within a moment. Together they are one change, and one build over all of them gives the final result. Building once per file repeats the same work many times and shows results for trees that never existed in between.',
    from: ['watch-loop-edits', 'watch-loop'],
    workspace: app(),
    phases: [
      firstBuild,
      {
        write: Object.fromEntries(
          ['b', 'c', 'd', 'e', 'f', 'g', 'h'].map((n) => [`packages/app/src/${n}.txt`, `${n}\n`]),
        ),
        expect: { ran: ['app#build'], files: { [OUT]: 'a1\nb\nc\nd\ne\nf\ng\nh\n' } },
      },
    ],
  }),

  watchCase({
    id: 'watch/atomic-save-reruns',
    kind: 'correctness',
    title: 'An editor’s save by renaming a temporary file over the source rebuilds',
    why: 'Many editors write a temporary file and rename it over the original, so the file is replaced rather than edited in place. The source still changed, and the build must hold the new content. A watch that only follows edits in place misses every save from such an editor.',
    from: ['watch-loop-edits', 'watch-label-live-path'],
    workspace: app(),
    phases: [
      firstBuild,
      {
        sh: 'printf "a2\\n" > packages/app/src/.a.txt.swp && mv packages/app/src/.a.txt.swp packages/app/src/a.txt',
        expect: { ran: ['app#build'], files: { [OUT]: 'a2\n' } },
      },
    ],
  }),

  watchCase({
    id: 'watch/replaced-directory-reruns',
    kind: 'correctness',
    title:
      'A source folder deleted and made again, as a checkout does, rebuilds from the new files',
    why: 'Tools that restore a tree, such as a checkout or a stash, often remove a folder and write it again. The new folder holds new content, and the build must reflect it. A watch that kept following the deleted folder hears nothing from then on, and every later edit is lost too.',
    from: ['watch-recreated-dirs', 'watch-tree-linux'],
    workspace: app(),
    phases: [
      firstBuild,
      {
        sh: 'rm -rf packages/app/src && mkdir packages/app/src && printf "a9\\n" > packages/app/src/a.txt',
        expect: { ran: ['app#build'], files: { [OUT]: 'a9\n' } },
      },
      { write: { [A]: 'a10\n' }, expect: { ran: ['app#build'], files: { [OUT]: 'a10\n' } } },
    ],
  }),

  watchCase({
    id: 'watch/edit-during-run-not-lost',
    kind: 'correctness',
    title: 'An edit made while the build is running is built right after',
    why: 'The running build read the source before the edit, so its output is already stale when it finishes. The edit must lead to one more build, or the result shown is older than the code. Dropping changes that land mid-run is the usual way a watch drifts out of date without saying so.',
    from: ['watch-new-member-edit', 'watch-loop-members', 'watch-ready-interrupt'],
    workspace: app(
      {},
      {
        command:
          'mkdir -p dist && cp src/a.txt dist/started && sleep 2 && cat src/*.txt > dist/out.txt.tmp && mv dist/out.txt.tmp dist/out.txt',
      },
    ),
    phases: [
      initial(['app#build'], { [OUT]: 'a1\n' }),
      {
        write: { [A]: 'a2\n' },
        expect: { files: { 'packages/app/dist/started': 'a2\n' }, inFlight: true },
      },
      { write: { [A]: 'a3\n' }, expect: { ran: ['app#build'], files: { [OUT]: 'a3\n' } } },
    ],
  }),

  watchCase({
    id: 'watch/keeps-watching-after-failure',
    kind: 'correctness',
    title: 'A build that fails while watching is built again once the source is fixed',
    why: 'Breaking the code halfway through an edit is the normal state of work in progress. The watch should report the failure and keep going rather than exit. The fix is an edit like any other, and it must produce a fresh build without the user having to start the watch again.',
    from: ['watch-signals', 'watch-workspace-file-gone'],
    workspace: app(
      {},
      {
        command:
          'mkdir -p dist && cp src/a.txt dist/tried && ! grep -q bad src/a.txt && cat src/*.txt > dist/out.txt',
      },
    ),
    phases: [
      firstBuild,
      { write: { [A]: 'bad\n' }, expect: { files: { 'packages/app/dist/tried': 'bad\n' } } },
      { write: { [A]: 'a3\n' }, expect: { ran: ['app#build'], files: { [OUT]: 'a3\n' } } },
    ],
  }),

  watchCase({
    id: 'watch/dependency-edit-rebuilds-dependants-in-order',
    kind: 'correctness',
    title: 'Editing a library rebuilds it, then the app that depends on it',
    why: 'The app’s build reads what the library’s build produces, so it must run after it, on the new output. Building the app first, or not at all, leaves it built against the old library. Order matters under a watch exactly as much as it does in a plain run.',
    from: ['watch-loop-members', 'watch-rules'],
    workspace: chain(),
    phases: [
      initial(['lib#build', 'app#build'], { [OUT]: 'lib\napp\n' }),
      {
        write: { 'packages/lib/src/a.txt': 'lib2\n' },
        expect: {
          ran: ['lib#build', 'app#build'],
          order: [['lib#build', 'app#build']],
          files: { [OUT]: 'lib2\napp\n' },
        },
      },
    ],
  }),

  watchCase({
    id: 'watch/dependant-edit-leaves-dependency',
    kind: 'efficiency',
    title: 'Editing the app rebuilds only the app, not the library it uses',
    why: 'The library reads nothing from the app, so its output cannot change when the app does. Only the edited project and those that depend on it need to run. Rebuilding the library on every app edit adds its whole build time to each save, for a result that is already on disk.',
    from: ['watch-loop-members', 'watch-rules'],
    workspace: chain(),
    phases: [
      initial(['lib#build', 'app#build'], { [OUT]: 'lib\napp\n' }),
      {
        write: { 'packages/app/src/a.txt': 'app2\n' },
        expect: { ran: ['app#build'], notRan: ['lib#build'], files: { [OUT]: 'lib\napp2\n' } },
      },
    ],
  }),

  watchCase({
    id: 'watch/unrelated-project-not-rerun',
    kind: 'efficiency',
    title: 'Editing one project reruns nothing in an unrelated one',
    why: 'Two projects with no dependency between them share no inputs. An edit in one cannot change the other’s output. Rebuilding every project on any edit makes watching a large workspace as slow as building all of it, which is the cost watching was supposed to avoid.',
    from: ['watch-nested-boundary', 'watch-anchored-scope'],
    workspace: { projects: { app: chainProject('app'), docs: chainProject('docs') } },
    phases: [
      initial(['app#build', 'docs#build'], { [OUT]: 'app\n' }),
      {
        write: { 'packages/app/src/a.txt': 'app2\n' },
        expect: { ran: ['app#build'], notRan: ['docs#build'], files: { [OUT]: 'app2\n' } },
      },
    ],
  }),

  watchCase({
    id: 'watch/selected-project-watches-its-dependency',
    kind: 'correctness',
    title: 'Watching one app also rebuilds it when a library it depends on changes',
    why: 'Selecting the app means its build and everything that build needs. A library edit changes what the app is built from. A watch that only follows the selected project’s own folder leaves the app built against the old library, and the user sees a result that no longer matches the code.',
    from: ['watch-loop-members', 'watch-anchored-scope'],
    projects: ['app'],
    workspace: { projects: { ...chain().projects, docs: chainProject('docs') } },
    phases: [
      initial(['lib#build', 'app#build'], { [OUT]: 'lib\napp\n' }),
      {
        write: { 'packages/lib/src/a.txt': 'lib2\n' },
        expect: {
          ran: ['lib#build', 'app#build'],
          order: [['lib#build', 'app#build']],
          files: { [OUT]: 'lib2\napp\n' },
        },
      },
    ],
  }),

  watchCase({
    id: 'watch/unselected-project-not-rerun',
    kind: 'efficiency',
    title: 'Watching one app reruns nothing when a project outside it changes',
    why: 'The user asked to watch the app, and the edited project is neither the app nor something it needs. Its build was not requested at the start, so the edit does not request it either. Running it anyway spends time on work nobody asked for and fills the output with noise.',
    from: ['watch-loop-members', 'watch-anchored-scope'],
    projects: ['app'],
    workspace: { projects: { ...chain().projects, docs: chainProject('docs') } },
    phases: [
      initial(['lib#build', 'app#build'], { [OUT]: 'lib\napp\n' }),
      {
        write: { 'packages/docs/src/a.txt': 'docs2\n' },
        expect: { notRan: ['docs#build', 'lib#build', 'app#build'] },
      },
    ],
  }),

  watchCase({
    id: 'watch/root-input-edit-reruns',
    kind: 'correctness',
    title: 'Editing a shared file at the root that the task reads rebuilds it',
    why: 'A shared settings file outside the project is still one of the task’s declared inputs. Changing it changes the output as much as a source edit does. A watch that only follows project folders leaves the build on the old settings, though a plain run would have rebuilt it.',
    from: ['watch-loop-members', 'watch-label-workspace-wide'],
    workspace: {
      projects: {
        app: {
          tasks: {
            build: build('mkdir -p dist && cat ../../config/shared.txt src/*.txt > dist/out.txt', {
              rootInputs: ['config/shared.txt'],
            }),
          },
          files: { 'src/a.txt': 'a1\n' },
        },
      },
      files: { 'config/shared.txt': 's1\n' },
    },
    phases: [
      initial(['app#build'], { [OUT]: 's1\na1\n' }),
      {
        write: { 'config/shared.txt': 's2\n' },
        expect: { ran: ['app#build'], files: { [OUT]: 's2\na1\n' } },
      },
    ],
  }),

  watchCase({
    id: 'watch/root-file-not-input-reruns-nothing',
    kind: 'efficiency',
    title: 'Editing a root file no task reads reruns nothing',
    why: 'A file at the workspace root, such as a readme or a log, is no task’s input unless a task says so. The task’s output cannot depend on it. A rerun for each such write wastes a full build, and a log written at the root by the watch’s own output could feed it forever.',
    from: ['watch-loop-members', 'watch-rules'],
    workspace: { ...app(), files: { 'README.md': 'hello\n' } },
    phases: [firstBuild, { write: { 'README.md': 'edited\n' }, expect: { notRan: ['app#build'] } }],
  }),

  watchCase({
    id: 'watch/config-change-runs-new-command',
    kind: 'correctness',
    title: 'Changing a task’s command while watching runs the new command',
    why: 'The command is part of what produces the output, so a new command means the old output is stale. Each tool has its own step to apply a config edit, and the user takes it. After that the watch must run what the config now says, not the command it read at the start.',
    from: ['watch-loop', 'watch-loop-edits'],
    workspace: app(),
    phases: [
      firstBuild,
      {
        configure: (ws) => ({
          ...ws,
          projects: {
            app: {
              ...ws.projects['app']!,
              tasks: {
                build: build('mkdir -p dist && { echo v2; cat src/*.txt; } > dist/out.txt'),
              },
            },
          },
        }),
        expect: { ran: ['app#build'], files: { [OUT]: 'v2\na1\n' } },
      },
    ],
  }),

  watchCase({
    id: 'watch/unrelated-config-edit-reruns-nothing',
    kind: 'efficiency',
    title: 'Adding a new task to the config while watching does not rebuild the existing one',
    why: 'The build’s command, inputs and outputs are exactly what they were; only a task beside it was added. Nothing that produces the build’s output changed, so its result on disk is still right. Rebuilding everything on any config edit makes each tweak to an unrelated task cost a full build.',
    from: ['watch-loop', 'watch-loop-edits'],
    workspace: app(),
    phases: [
      firstBuild,
      {
        configure: (ws) => ({
          ...ws,
          projects: {
            app: {
              ...ws.projects['app']!,
              tasks: {
                ...ws.projects['app']!.tasks,
                lint: { command: 'true', inputs: ['src/**'], outputs: [] },
              },
            },
          },
        }),
        expect: { notRan: ['app#build'], files: { [OUT]: 'a1\n' } },
      },
    ],
  }),

  watchCase({
    id: 'watch/edit-behind-link-reruns',
    kind: 'correctness',
    title: 'Editing a file that a source symlink points to rebuilds with the new content',
    why: 'The task reads its source through the link, so what it reads is the file the link points to. Editing that file changes the build’s result as much as editing the source itself. A watch that only hears writes inside the project misses it, and the build keeps the old content.',
    from: ['watch-linked-input', 'watch-symlink-retarget'],
    workspace: { ...app(), files: { 'shared/o.txt': 'o1\n' } },
    before: [{ link: { 'packages/app/src/o.txt': '../../../shared/o.txt' } }],
    phases: [
      initial(['app#build'], { [OUT]: 'a1\no1\n' }),
      {
        write: { 'shared/o.txt': 'o2\n' },
        expect: { ran: ['app#build'], files: { [OUT]: 'a1\no2\n' } },
      },
    ],
  }),
]
