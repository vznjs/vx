// More watch mode, mined from Turborepo’s watch_test.rs and its closed watch
// issues, Nx’s `nx watch`, and vx’s own watch tests: projects that come and
// go, edges that change, links, git operations, failures and the cache a
// watch shares with plain runs.
import type { Case, ProjectSpec, Step, TaskSpec, WatchPhase, WorkspaceSpec } from '../src/spec.ts'
import { defineCase } from '../src/spec.ts'
import { CONCAT, chainBuild, chainProject, out } from './shapes.ts'

const OUT = out('app')
const A = 'packages/app/src/a.txt'

/** A cached build of `src/**` into `dist/`. */
const build = (command = CONCAT, extra: Partial<TaskSpec> = {}): TaskSpec => ({
  command,
  inputs: ['src/**'],
  outputs: ['dist/**'],
  ...extra,
})

/** One project, `app`, whose build concatenates its sources. */
const app = (files: Record<string, string> = {}, task: Partial<TaskSpec> = {}): WorkspaceSpec => ({
  projects: {
    app: {
      tasks: { build: build(task.command, task) },
      files: { 'src/a.txt': 'a1\n', ...files },
    },
  },
})

/** lib ← app, each building its dependencies’ output and its own sources. */
const chain = (): WorkspaceSpec => ({
  projects: { lib: chainProject('lib'), app: chainProject('app', ['lib']) },
})

/** Every file under `src`, in name order: sees new folders and moved ones. */
const FIND = 'mkdir -p dist && find src -type f | sort | xargs cat > dist/out.txt'

/** Copies the source it starts from to `dist/started`, then builds for two seconds. */
const SLOW =
  'mkdir -p dist && cp src/a.txt dist/started && sleep 2 && cat src/*.txt > dist/out.txt.tmp && mv dist/out.txt.tmp dist/out.txt'

/** Notes what it tried in `dist/tried`, then fails when the source says `bad`. */
const FAILING =
  'mkdir -p dist && cp src/a.txt dist/tried && ! grep -q bad src/a.txt && cat src/*.txt > dist/out.txt'

/** The root manifest as the harness writes it, over these member directories. */
const rootManifest = (dirs: string[]) =>
  JSON.stringify(
    {
      name: 'conformance',
      private: true,
      packageManager: `bun@${Bun.version}`,
      workspaces: dirs,
    },
    null,
    2,
  )

/** A member’s manifest as the harness writes it. */
const memberManifest = (name: string, deps: string[] = []) =>
  JSON.stringify(
    {
      name,
      version: '0.0.0',
      private: true,
      dependencies: Object.fromEntries(deps.map((d) => [d, 'workspace:*'])),
    },
    null,
    2,
  )

/** A dev server that counts its starts in `starts.txt` and notes a stop in `stopped.txt`. */
const SERVER = (name: string) =>
  `echo s >> starts.txt; trap "echo x > stopped.txt; exit 0" TERM INT; echo Listening on ${name}; sleep 600 & wait`

const initial = (tasks: string[], files: Record<string, string | null> = {}): WatchPhase => ({
  expect: { ran: tasks, files },
})

const firstBuild = initial(['app#build'], { [OUT]: 'a1\n' })

/** A watch case: the steps `before`, `task` watched through `phases`, then `after`. */
function watchCase(
  c: Omit<Case, 'category' | 'needs' | 'steps'> & {
    phases: WatchPhase[]
    projects?: string[]
    before?: Step[]
    after?: Step[]
    task?: string
    alsoNeeds?: Case['needs']
  },
): Case {
  const { phases, projects, before = [], after = [], task = 'build', alsoNeeds = [], ...rest } = c
  return defineCase({
    ...rest,
    category: 'watch',
    needs: ['watch', ...alsoNeeds],
    steps: [...before, { watch: task, ...(projects ? { projects } : {}), phases }, ...after],
  })
}

/** Replaces one project’s tasks. */
const withTasks =
  (name: string, tasks: Record<string, TaskSpec>) =>
  (ws: WorkspaceSpec): WorkspaceSpec => ({
    ...ws,
    projects: { ...ws.projects, [name]: { ...ws.projects[name]!, tasks } },
  })

/** Adds a project. */
const withProject =
  (name: string, p: ProjectSpec) =>
  (ws: WorkspaceSpec): WorkspaceSpec => ({ ...ws, projects: { ...ws.projects, [name]: p } })

/** lib at the bottom, ui and api on it, app on both. */
const diamond = (): WorkspaceSpec => ({
  projects: {
    lib: chainProject('lib'),
    ui: chainProject('ui', ['lib']),
    api: chainProject('api', ['lib']),
    app: chainProject('app', ['ui', 'api']),
  },
})

export default [
  // Turborepo watch_test.rs watch_new_package_builds_and_rebuilds_on_source_and_dependency_changes (#14842)
  watchCase({
    id: 'watch/new-project-joins-the-watch',
    kind: 'correctness',
    title: 'A project added while watching is built, and its next edit rebuilds it',
    why: 'Adding a package to a monorepo is ordinary work, and nobody expects to restart the watch for it. The new project declares the watched task, so the watch owes it a first build. Its own edits must rebuild it from then on, or the user works on a project the watch silently ignores.',
    from: ['watch-loop-members', 'watch-new-member-edit'],
    workspace: app(),
    phases: [
      firstBuild,
      {
        write: {
          'package.json': rootManifest(['packages/app', 'packages/web']),
          'packages/web/package.json': memberManifest('web'),
          'packages/web/src/a.txt': 'web\n',
        },
        sh: 'bun install --offline',
        configure: withProject('web', chainProject('web')),
        expect: { ran: ['web#build'], notRan: ['app#build'], files: { [out('web')]: 'web\n' } },
      },
      {
        write: { 'packages/web/src/a.txt': 'web2\n' },
        expect: { ran: ['web#build'], notRan: ['app#build'], files: { [out('web')]: 'web2\n' } },
      },
    ],
  }),

  // Turborepo watch_test.rs watch_new_package_builds_and_rebuilds_on_source_and_dependency_changes (#14842)
  watchCase({
    id: 'watch/new-project-follows-its-library',
    kind: 'correctness',
    title: 'A project added while watching rebuilds when the library it depends on changes',
    why: 'A new package that depends on a library reads that library’s build, just as the older packages do. Once it has joined the watch, an edit to the library makes its build stale too. The watch must rebuild it after the library, or the newest package is the one left holding old code.',
    from: ['watch-loop-members', 'watch-new-member-edit'],
    workspace: chain(),
    phases: [
      initial(['lib#build', 'app#build'], { [OUT]: 'lib\napp\n' }),
      {
        write: {
          'package.json': rootManifest(['packages/lib', 'packages/app', 'packages/web']),
          'packages/web/package.json': memberManifest('web', ['lib']),
          'packages/web/src/a.txt': 'web\n',
        },
        sh: 'bun install --offline',
        configure: withProject('web', chainProject('web', ['lib'])),
        expect: { ran: ['web#build'], files: { [out('web')]: 'lib\nweb\n' } },
      },
      {
        write: { 'packages/lib/src/a.txt': 'lib2\n' },
        expect: {
          ran: ['lib#build', 'app#build', 'web#build'],
          order: [['lib#build', 'web#build']],
          files: { [out('web')]: 'lib2\nweb\n', [OUT]: 'lib2\napp\n' },
        },
      },
    ],
  }),

  // vx watch-loop-members: a dependency added under the watch joins its closure
  watchCase({
    id: 'watch/task-edge-added-reruns-dependant',
    kind: 'correctness',
    title: 'Once the app is made to depend on a library while watching, a library edit rebuilds it',
    why: 'The watch decides what an edit reaches from the task graph, and that graph just gained an edge. A watch that keeps the graph it started with treats the library as unrelated to the app. The app now reads the library’s build, so it must be rebuilt after it.',
    from: ['watch-loop-members', 'watch-rules'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        app: { tasks: { build: build() }, files: { 'src/a.txt': 'app\n' } },
      },
    },
    phases: [
      initial(['lib#build', 'app#build'], { [OUT]: 'app\n' }),
      {
        configure: withTasks('app', {
          build: build('mkdir -p dist && cat ../lib/dist/out.txt src/*.txt > dist/out.txt', {
            dependsOn: ['lib#build'],
          }),
        }),
        expect: { ran: ['app#build'], files: { [OUT]: 'lib\napp\n' } },
      },
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

  // Turborepo watch engine tests: a change reaches each dependant once
  watchCase({
    id: 'watch/diamond-bottom-edit-builds-each-once',
    kind: 'correctness',
    title:
      'Editing a library two others build on, both used by the app, rebuilds every project once and in order',
    why: 'The app reaches the library by two paths, and a watch that walks each path on its own builds it twice. Each project read the library, so each must be rebuilt, but once is enough. Order matters too: the app needs both of its dependencies rebuilt before it reads them.',
    from: ['watch-loop-members', 'watch-rules'],
    workspace: diamond(),
    phases: [
      initial(['lib#build', 'ui#build', 'api#build', 'app#build'], {
        [OUT]: 'lib\nui\nlib\napi\napp\n',
      }),
      {
        write: { 'packages/lib/src/a.txt': 'lib2\n' },
        expect: {
          ran: ['lib#build', 'ui#build', 'api#build', 'app#build'],
          order: [
            ['lib#build', 'ui#build'],
            ['lib#build', 'api#build'],
            ['ui#build', 'app#build'],
            ['api#build', 'app#build'],
          ],
          files: { [OUT]: 'lib2\nui\nlib2\napi\napp\n' },
        },
      },
    ],
  }),

  // vx watch-rules: an edit reaches only what depends on the edited project
  watchCase({
    id: 'watch/diamond-side-edit-leaves-other-side',
    kind: 'efficiency',
    title:
      'Editing one of two libraries the app uses rebuilds it and the app, not the other library or the base',
    why: 'Only one side of the diamond changed. The base below it and the other side beside it read nothing that changed, so their builds still stand. Rebuilding them as well turns a small edit into a rebuild of the whole tree.',
    from: ['watch-rules', 'watch-loop-members'],
    workspace: diamond(),
    phases: [
      initial(['lib#build', 'ui#build', 'api#build', 'app#build']),
      {
        write: { 'packages/ui/src/a.txt': 'ui2\n' },
        expect: {
          ran: ['ui#build', 'app#build'],
          notRan: ['lib#build', 'api#build'],
          order: [['ui#build', 'app#build']],
          files: { [OUT]: 'lib\nui2\nlib\napi\napp\n' },
        },
      },
    ],
  }),

  // Turborepo #13347: watch reruns follow task inputs, not just the graph
  watchCase({
    id: 'watch/dependency-inputs-off-dependant-not-rerun',
    kind: 'efficiency',
    title:
      'Editing a library while watching leaves an app alone when the app’s key does not take in its dependencies',
    why: 'The app asks for the library to be built first, but says the library’s files do not key it. After a library edit the app’s inputs are exactly the ones it was built from. Running it again repeats work whose result is already on disk.',
    from: ['watch-rules', 'task-hash-derive'],
    alsoNeeds: ['dependency-inputs-off'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        app: {
          deps: ['lib'],
          tasks: { build: build(CONCAT, { dependsOn: ['^build'], dependencyInputs: false }) },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    phases: [
      initial(['lib#build', 'app#build'], { [OUT]: 'app\n' }),
      {
        write: { 'packages/lib/src/a.txt': 'lib2\n' },
        expect: {
          ran: ['lib#build'],
          notRan: ['app#build'],
          files: { [out('lib')]: 'lib2\n', [OUT]: 'app\n' },
        },
      },
    ],
  }),

  // vx watch-rules: an edit to the watched task’s own source leaves its prerequisite
  watchCase({
    id: 'watch/own-task-edit-leaves-prerequisite',
    kind: 'efficiency',
    title:
      'Editing the build’s own source while watching leaves the codegen step it depends on alone',
    why: 'The build waits for a codegen task in the same project, but the edit touched only what the build reads. The codegen’s inputs did not change, so its output still stands. Running it again delays every save by work that cannot produce anything new.',
    from: ['watch-rules', 'watch-initial-edit-done'],
    workspace: {
      projects: {
        app: {
          tasks: {
            gen: {
              command: 'mkdir -p gen && cat schema/*.txt > gen/out.txt',
              inputs: ['schema/**'],
              outputs: ['gen/**'],
            },
            build: build('mkdir -p dist && cat gen/out.txt src/*.txt > dist/out.txt', {
              dependsOn: ['gen'],
            }),
          },
          files: { 'src/a.txt': 'a1\n', 'schema/s.txt': 's1\n' },
        },
      },
    },
    phases: [
      initial(['app#gen', 'app#build'], { [OUT]: 's1\na1\n' }),
      {
        write: { [A]: 'a2\n' },
        expect: { ran: ['app#build'], notRan: ['app#gen'], files: { [OUT]: 's1\na2\n' } },
      },
    ],
  }),

  // vx watch-signals: a failed cycle does not stop the watch for the rest
  watchCase({
    id: 'watch/failing-project-does-not-block-others',
    kind: 'correctness',
    title: 'While one project’s build is broken, editing another project still rebuilds it',
    why: 'A broken build in one corner of a monorepo is normal while someone is mid-change. The other project does not depend on it, so nothing stops it from building. A watch that gives up or holds every edit behind the broken project leaves the rest of the workspace stale.',
    from: ['watch-signals', 'watch-loop-members'],
    workspace: {
      projects: {
        app: chainProject('app'),
        docs: { tasks: { build: build(FAILING) }, files: { 'src/a.txt': 'bad\n' } },
      },
    },
    phases: [
      {
        expect: {
          ran: ['app#build'],
          files: { [OUT]: 'app\n', 'packages/docs/dist/tried': 'bad\n' },
        },
      },
      { write: { [A]: 'app2\n' }, expect: { ran: ['app#build'], files: { [OUT]: 'app2\n' } } },
    ],
  }),

  // Turborepo watch_test.rs watch_rapid_edits_produce_single_rebuild
  watchCase({
    id: 'watch/same-file-saved-five-times-builds-latest-once',
    kind: 'efficiency',
    title: 'Five quick saves of one file while watching rebuild once, with the last content',
    why: 'Format-on-save and autosave can write one file several times within a few milliseconds. Only the last content matters, and one build of it is the right answer. Building once per save repeats the same work and may show results of content that was gone before the build began.',
    from: ['watch-loop-edits', 'watch-late-batch'],
    workspace: app(),
    phases: [
      firstBuild,
      {
        sh: 'for i in 2 3 4 5 6; do printf "a$i\\n" > packages/app/src/a.txt; done',
        expect: { ran: ['app#build'], files: { [OUT]: 'a6\n' } },
      },
    ],
  }),

  // vx watch-transient-file: a file born and gone between two looks starts nothing
  watchCase({
    id: 'watch/transient-file-reruns-nothing',
    kind: 'efficiency',
    title: 'A file created and deleted at once among the sources while watching reruns nothing',
    why: 'Tools drop short-lived files beside sources all the time, a lock or a temporary copy, and remove them a moment later. By the time anything could build, the sources are exactly what was built before. A rebuild here costs time and produces the same output.',
    from: ['watch-transient-file', 'watch-judge-properties'],
    workspace: app(),
    phases: [
      firstBuild,
      {
        sh: 'printf "t\\n" > packages/app/src/tmp.txt && rm packages/app/src/tmp.txt',
        expect: { notRan: ['app#build'], files: { [OUT]: 'a1\n' } },
      },
    ],
  }),

  // vx watch-tree-linux: a directory moved within the tree reports under its new name
  watchCase({
    id: 'watch/renamed-input-directory-reruns',
    kind: 'correctness',
    title:
      'Renaming a folder of sources while watching rebuilds, and an edit under its new name rebuilds again',
    why: 'Renaming a folder is a single rename: no file inside it is written. Its files now sit at new paths, which a build that lists paths sees. The watch must also follow the folder under its new name, or the next edit inside it is lost.',
    from: ['watch-tree-linux', 'watch-poll-moved-dir'],
    workspace: app(
      { 'src/one/b.txt': 'b1\n' },
      {
        command:
          'mkdir -p dist && cd src && for f in $(find . -type f | sort); do echo $f; cat $f; done > ../dist/out.txt',
      },
    ),
    phases: [
      initial(['app#build'], { [OUT]: './a.txt\na1\n./one/b.txt\nb1\n' }),
      {
        sh: 'mv packages/app/src/one packages/app/src/two',
        expect: { ran: ['app#build'], files: { [OUT]: './a.txt\na1\n./two/b.txt\nb1\n' } },
      },
      {
        write: { 'packages/app/src/two/b.txt': 'b2\n' },
        expect: { ran: ['app#build'], files: { [OUT]: './a.txt\na1\n./two/b.txt\nb2\n' } },
      },
    ],
  }),

  // vx watch-tree-linux: a directory moved out of the inputs
  watchCase({
    id: 'watch/directory-moved-out-reruns',
    kind: 'correctness',
    title:
      'Moving a folder out of the sources while watching rebuilds without it, and its later edits rerun nothing',
    why: 'Moving a folder away is one rename, with no file deleted, yet its files are no longer inputs. The build must drop them. A watch that still follows the moved folder would then rebuild on edits to files the task no longer reads.',
    from: ['watch-tree-linux', 'watch-poll-moved-dir'],
    workspace: app({ 'src/sub/c.txt': 'c1\n' }, { command: FIND }),
    phases: [
      initial(['app#build'], { [OUT]: 'a1\nc1\n' }),
      {
        sh: 'mv packages/app/src/sub packages/app/staging',
        expect: { ran: ['app#build'], files: { [OUT]: 'a1\n' } },
      },
      {
        write: { 'packages/app/staging/c.txt': 'c2\n' },
        expect: { notRan: ['app#build'], files: { [OUT]: 'a1\n' } },
      },
    ],
  }),

  // vx watch-loop-edits: an edit is any change of bytes, emptying included
  watchCase({
    id: 'watch/emptied-input-reruns',
    kind: 'correctness',
    title: 'Emptying a source file while watching rebuilds without its content',
    why: 'A file cut down to nothing is still a change, and the build made from its old content is wrong now. Some watchers compare sizes or skip empty writes, and miss it. The output must match the sources on disk.',
    from: ['watch-loop-edits'],
    workspace: app({ 'src/b.txt': 'b1\n' }),
    phases: [
      initial(['app#build'], { [OUT]: 'a1\nb1\n' }),
      {
        write: { 'packages/app/src/b.txt': '' },
        expect: { ran: ['app#build'], files: { [OUT]: 'a1\n' } },
      },
    ],
  }),

  // vx watch-poll-moved-dir: sees a replacement that carries the old mtime
  watchCase({
    id: 'watch/edit-with-old-mtime-reruns',
    kind: 'correctness',
    title:
      'An edit that keeps the file’s size and old modification time while watching still rebuilds',
    why: 'Tools that sync or restore files often keep the original timestamp, and a same-length edit leaves the size alone too. The content changed all the same. A watch that trusts size and time to spot changes keeps a build of bytes no longer on disk.',
    from: ['watch-poll-moved-dir', 'git-racy-index'],
    workspace: app(),
    phases: [
      firstBuild,
      {
        sh: 'mkdir -p .home && cp -p packages/app/src/a.txt .home/ref && printf "a2\\n" > packages/app/src/a.txt && touch -r .home/ref packages/app/src/a.txt',
        expect: { ran: ['app#build'], files: { [OUT]: 'a2\n' } },
      },
    ],
  }),

  // vx watch-judge-properties: a file moved in with an old mtime is not "before" the arm
  watchCase({
    id: 'watch/file-moved-in-with-old-mtime-reruns',
    kind: 'correctness',
    title: 'A file with an old timestamp moved into the sources while watching rebuilds with it',
    why: 'A file unpacked from an archive or copied with its times kept can carry a date years before the watch began. Moving it in still adds an input. A watch that ignores files older than its own start leaves the build without it.',
    from: ['watch-judge-properties', 'watch-tree-linux'],
    workspace: app(),
    phases: [
      firstBuild,
      {
        sh: 'printf "b1\\n" > packages/app/b.txt && touch -d "2001-01-01" packages/app/b.txt && mv packages/app/b.txt packages/app/src/b.txt',
        expect: { ran: ['app#build'], files: { [OUT]: 'a1\nb1\n' } },
      },
    ],
  }),

  // vx watch-linked-input: an edit behind a directory link elsewhere in the workspace
  watchCase({
    id: 'watch/edit-behind-directory-link-reruns',
    kind: 'correctness',
    title:
      'Editing a file inside a folder that a source folder link points to while watching rebuilds',
    why: 'Sharing a folder of sources through a link is a common way to reuse files without a package. The task reads through the link, so an edit at the target changes its input. A watch that only follows real folders under the project never hears the edit.',
    from: ['watch-linked-input', 'watch-symlink-retarget'],
    workspace: {
      ...app({}, { command: 'mkdir -p dist && cat src/*.txt src/shared/*.txt > dist/out.txt' }),
      files: { 'shared/lib/o.txt': 'o1\n' },
    },
    before: [{ link: { 'packages/app/src/shared': '../../../shared/lib' } }],
    phases: [
      initial(['app#build'], { [OUT]: 'a1\no1\n' }),
      {
        write: { 'shared/lib/o.txt': 'o2\n' },
        expect: { ran: ['app#build'], files: { [OUT]: 'a1\no2\n' } },
      },
    ],
  }),

  // vx watch-linked-input: an edit behind a file link outside the workspace
  watchCase({
    id: 'watch/edit-behind-link-outside-workspace-reruns',
    kind: 'correctness',
    title:
      'Editing a file outside the repository that a source link points to while watching rebuilds',
    why: 'A source may be a link to a checkout beside the repository, such as a shared config. The task reads its content through the link. A watch that only follows the repository never sees the edit, and the build keeps the old content.',
    from: ['watch-linked-input'],
    workspace: { ...app(), outside: { 'o.txt': 'o1\n' } },
    before: [{ link: { 'packages/app/src/o.txt': '../../../../outside/o.txt' } }],
    phases: [
      initial(['app#build'], { [OUT]: 'a1\no1\n' }),
      {
        write: { '../outside/o.txt': 'o2\n' },
        expect: { ran: ['app#build'], files: { [OUT]: 'a1\no2\n' } },
      },
    ],
  }),

  // vx watch-symlink-retarget: sees a link made
  watchCase({
    id: 'watch/new-link-into-sources-reruns',
    kind: 'correctness',
    title: 'A link added among the sources while watching rebuilds with the file it points to',
    why: 'Making a link is creating a file, and the build reads through it. Its target’s content is now part of the task’s input. A watch that only looks at regular files skips the link, and the build leaves its content out.',
    from: ['watch-symlink-retarget', 'watch-linked-input'],
    workspace: { ...app(), files: { 'shared/o.txt': 'o1\n' } },
    phases: [
      firstBuild,
      {
        sh: 'ln -s ../../../shared/o.txt packages/app/src/o.txt',
        expect: { ran: ['app#build'], files: { [OUT]: 'a1\no1\n' } },
      },
    ],
  }),

  // vx watch-linked-input: the target rewritten with the same bytes starts nothing
  watchCase({
    id: 'watch/link-target-same-bytes-reruns-nothing',
    kind: 'efficiency',
    title: 'Saving the target of a source link with the same bytes while watching reruns nothing',
    why: 'The link’s target was written, but its content is what the build already read. A watch that reacts to any write behind the link rebuilds for nothing. The same-bytes rule holds behind a link as it does for a plain file.',
    from: ['watch-linked-input'],
    workspace: { ...app(), files: { 'shared/o.txt': 'o1\n' } },
    before: [{ link: { 'packages/app/src/o.txt': '../../../shared/o.txt' } }],
    phases: [
      initial(['app#build'], { [OUT]: 'a1\no1\n' }),
      { write: { 'shared/o.txt': 'o1\n' }, expect: { notRan: ['app#build'] } },
    ],
  }),

  // vx watch-root-scope: un-ignoring an input re-runs, as a run would
  watchCase({
    id: 'watch/unignored-input-reruns',
    kind: 'correctness',
    title:
      'Once a source is taken out of .gitignore while watching, its next edit rebuilds the task',
    why: 'A file git ignored was no input, but after the .gitignore edit it is an ordinary source under the task’s pattern. Its edits must rebuild like any other. A watch that keeps the ignore rules it started with goes on skipping a file the user now counts as code.',
    from: ['watch-root-scope', 'watch-unignored-deletion'],
    workspace: app({ '.gitignore': 'src/gen.txt\n', 'src/gen.txt': 'g1\n' }),
    phases: [
      initial(['app#build'], { [OUT]: 'a1\ng1\n' }),
      // The task may run again here: its key just gained a file.
      { write: { 'packages/app/.gitignore': '' }, expect: { files: { [OUT]: 'a1\ng1\n' } } },
      {
        write: { 'packages/app/src/gen.txt': 'g2\n' },
        expect: { ran: ['app#build'], files: { [OUT]: 'a1\ng2\n' } },
      },
    ],
  }),

  // vx watch-root-scope: a git-ignored file under a glob starts no cycle
  watchCase({
    id: 'watch/newly-ignored-file-reruns-nothing',
    kind: 'efficiency',
    title:
      'Once a source is added to .gitignore and dropped from git while watching, its edits rerun nothing',
    why: 'Ignoring a file and removing it from the index takes it out of the task’s inputs from that moment, just as for a file ignored from the start. Its edits then change nothing the task is keyed on. A watch that keeps the ignore rules it started with keeps rebuilding for a file the user gave up on.',
    from: ['watch-root-scope', 'watch-rules'],
    workspace: app({ 'src/gen.txt': 'g1\n' }),
    phases: [
      initial(['app#build'], { [OUT]: 'a1\ng1\n' }),
      // The task may run again here: its key just lost a file.
      {
        sh: 'printf "src/gen.txt\\n" > packages/app/.gitignore && git rm -q --cached packages/app/src/gen.txt',
        expect: {},
      },
      { write: { 'packages/app/src/gen.txt': 'g2\n' }, expect: { notRan: ['app#build'] } },
    ],
  }),

  // vx watch-initial-edit-done: a commit that moves no key starts no cycle
  watchCase({
    id: 'watch/commit-of-built-edit-reruns-nothing',
    kind: 'efficiency',
    title: 'Committing an edit the watch already built reruns nothing',
    why: 'The commit records bytes that are already on disk and already built. Git’s index and history change, the files do not. A watch that keys on git state as well as content rebuilds on every commit for nothing.',
    from: ['watch-initial-edit-done', 'git-trust'],
    workspace: app(),
    phases: [
      firstBuild,
      { write: { [A]: 'a2\n' }, expect: { ran: ['app#build'], files: { [OUT]: 'a2\n' } } },
      {
        sh: 'git add -A && git commit -qm edit',
        expect: { notRan: ['app#build'], files: { [OUT]: 'a2\n' } },
      },
    ],
  }),

  // vx watch-initial-edit-done: a branch checked out starts a cycle
  watchCase({
    id: 'watch/branch-switch-rebuilds',
    kind: 'correctness',
    title:
      'Switching git branches while watching rebuilds with the branch’s files, and switching back restores them',
    why: 'A checkout rewrites sources to another commit’s content, which is the largest edit a user makes in a day. The build must follow it each way. Coming back to the first branch must leave the first build’s output, rebuilt or replayed.',
    from: ['watch-initial-edit-done', 'watch-loop-edits'],
    workspace: app(),
    before: [
      {
        sh: 'git checkout -qb other && printf "b\\n" > packages/app/src/a.txt && git commit -qam other && git checkout -q main',
      },
    ],
    phases: [
      firstBuild,
      { sh: 'git checkout -q other', expect: { files: { [OUT]: 'b\n' } } },
      { sh: 'git checkout -q main', expect: { files: { [OUT]: 'a1\n' } } },
    ],
  }),

  // vx watch-rules: an input newly named re-arms; one no longer named is no event
  watchCase({
    id: 'watch/narrowed-inputs-stop-reruns',
    kind: 'efficiency',
    title:
      'After the task’s inputs are narrowed to one file while watching, an edit to a file left out reruns nothing',
    why: 'The config now says the task reads one file only. The other source is no longer part of its key, so its edits change nothing the task depends on. A watch that keeps the patterns it started with goes on rebuilding for files the user took out.',
    from: ['watch-rules', 'watch-node-modules-input'],
    workspace: app({ 'src/b.txt': 'b1\n' }),
    phases: [
      initial(['app#build'], { [OUT]: 'a1\nb1\n' }),
      // The task may run again here: its key changed.
      {
        configure: withTasks('app', { build: { ...build(), inputs: ['src/a.txt'] } }),
        expect: { files: { [OUT]: 'a1\nb1\n' } },
      },
      { write: { 'packages/app/src/b.txt': 'b2\n' }, expect: { notRan: ['app#build'] } },
    ],
  }),

  // vx watch-loop-members: a task gone from the config is no longer watched
  watchCase({
    id: 'watch/removed-task-stops-reruns',
    kind: 'efficiency',
    title:
      'Once a project’s build is taken out of its config while watching, its edits run nothing',
    why: 'The project no longer declares the watched task, so nothing in it is part of the watch. Its edits must not run a task the config dropped. The other project’s key did not change either, so it stays as built.',
    from: ['watch-loop-members', 'watch-rules'],
    workspace: { projects: { app: chainProject('app'), docs: chainProject('docs') } },
    phases: [
      initial(['app#build', 'docs#build']),
      { configure: withTasks('docs', {}), expect: { notRan: ['app#build', 'docs#build'] } },
      {
        write: { 'packages/docs/src/a.txt': 'docs2\n' },
        expect: { notRan: ['app#build', 'docs#build'] },
      },
    ],
  }),

  // vx watch-loop-members: a project that starts declaring the task joins
  watchCase({
    id: 'watch/task-added-to-existing-project-runs',
    kind: 'correctness',
    title:
      'Giving a project the watched task while watching builds it, and leaves the other project alone',
    why: 'The project existed all along but had nothing to run. Once its config declares the watched task it is part of the watch, and owes a first build. The project already built has an unchanged key, so it needs nothing.',
    from: ['watch-loop-members', 'watch-loop'],
    workspace: {
      projects: { app: chainProject('app'), docs: { files: { 'src/a.txt': 'docs\n' } } },
    },
    phases: [
      initial(['app#build'], { [OUT]: 'app\n' }),
      {
        configure: withTasks('docs', { build: build() }),
        expect: { ran: ['docs#build'], notRan: ['app#build'], files: { [out('docs')]: 'docs\n' } },
      },
    ],
  }),

  // Turborepo #13347: the other direction still reruns
  watchCase({
    id: 'watch/uncached-dependency-edit-reruns-dependant',
    kind: 'correctness',
    title: 'Editing a never-cached library while watching reruns it and the app that uses it',
    why: 'A task that is never cached still has inputs, and an edit to them makes its output and everything built on it stale. The app reads the library’s build. Both must run again, the library first.',
    from: ['watch-loop-uncached', 'watch-loop-members'],
    alsoNeeds: ['uncached-task'],
    workspace: {
      projects: {
        lib: chainProject('lib', [], { tasks: { build: { ...chainBuild([]), cache: false } } }),
        app: chainProject('app', ['lib']),
      },
    },
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

  // Turborepo watch_test.rs watch_persistent_tasks_skipped_on_build_failure
  watchCase({
    id: 'watch/server-waits-for-build-fix',
    kind: 'correctness',
    title:
      'A dev server whose build fails does not start under watch, and starts once the build is fixed',
    why: 'The server depends on the build, and serving without it would show something that does not match the code. While the build fails the server must stay down. Once an edit fixes the build, the watch must start the server, not wait for a restart.',
    from: ['watch-initial-readiness', 'watch-signals'],
    alsoNeeds: ['persistent', 'ready'],
    task: 'dev',
    workspace: {
      projects: {
        app: {
          tasks: {
            build: build(FAILING),
            dev: {
              command: 'echo yes > server.txt; echo up; sleep 600',
              persistent: { ready: 'up' },
              dependsOn: ['build'],
              inputs: ['src/**'],
            },
          },
          files: { 'src/a.txt': 'bad\n' },
        },
      },
    },
    phases: [
      {
        expect: {
          notRan: ['app#dev'],
          files: { 'packages/app/dist/tried': 'bad\n', 'packages/app/server.txt': null },
        },
      },
      {
        write: { [A]: 'a1\n' },
        expect: {
          ran: ['app#build'],
          files: { [OUT]: 'a1\n', 'packages/app/server.txt': 'yes\n' },
        },
      },
    ],
  }),

  // vx watch-signals: a dependant waits on a broken dependency
  watchCase({
    id: 'watch/dependant-edit-under-broken-dependency-builds-nothing',
    kind: 'correctness',
    title: 'Editing the app while the library it needs is broken does not build the app',
    why: 'The app reads the library’s build, and there is no good build of the library to read. Building the app anyway would use a missing or old library output. The app must wait until the library builds again.',
    from: ['watch-signals', 'watch-dependency-gone'],
    workspace: {
      projects: {
        lib: { tasks: { build: build(FAILING) }, files: { 'src/a.txt': 'bad\n' } },
        app: chainProject('app', ['lib']),
      },
    },
    phases: [
      {
        expect: {
          notRan: ['app#build'],
          files: { 'packages/lib/dist/tried': 'bad\n', [OUT]: null },
        },
      },
      { write: { [A]: 'app2\n' }, expect: { notRan: ['app#build'], files: { [OUT]: null } } },
    ],
  }),

  // vx watch-root-scope: watches the root project
  watchCase({
    id: 'watch/root-package-task-reruns',
    kind: 'correctness',
    title:
      'Editing a source of the workspace’s root package, beside its members, while watching rebuilds its task',
    why: 'Small repositories often keep their one project at the root, beside the workspace’s own files. Its sources are inputs like any project’s. A watch that only follows member folders never rebuilds it.',
    from: ['watch-root-scope', 'watch-loop'],
    workspace: {
      projects: {
        root: { dir: '.', tasks: { build: build() }, files: { 'src/a.txt': 'r1\n' } },
        docs: chainProject('docs'),
      },
    },
    phases: [
      initial(['root#build', 'docs#build'], { 'dist/out.txt': 'r1\n' }),
      {
        write: { 'src/a.txt': 'r2\n' },
        expect: { ran: ['root#build'], files: { 'dist/out.txt': 'r2\n' } },
      },
    ],
  }),

  // vx watch-anchored-scope: only the selected projects and what they need
  watchCase({
    id: 'watch/selected-library-leaves-dependants',
    kind: 'efficiency',
    title: 'Watching only a library rebuilds it on an edit, but not the app that depends on it',
    why: 'The user asked to watch the library, and the app is not part of that. A selection takes what the selected project needs, never what needs it. Building the app too runs work the user left out on purpose.',
    from: ['watch-anchored-scope', 'watch-loop-members'],
    projects: ['lib'],
    workspace: chain(),
    phases: [
      { expect: { ran: ['lib#build'], notRan: ['app#build'], files: { [OUT]: null } } },
      {
        write: { 'packages/lib/src/a.txt': 'lib2\n' },
        expect: {
          ran: ['lib#build'],
          notRan: ['app#build'],
          files: { [out('lib')]: 'lib2\n', [OUT]: null },
        },
      },
    ],
  }),

  // Turborepo watch_test.rs watch_task_inputs_reruns_on_turbo_root_input_without_root_tasks
  watchCase({
    id: 'watch/new-root-input-file-reruns',
    kind: 'correctness',
    title: 'A new file at the root matching a task’s root inputs while watching rebuilds with it',
    why: 'A root input given as a pattern covers files that do not exist yet, as a project pattern does. A file added there changes what the task reads. A watch that follows only the root files present at its start leaves it out.',
    from: ['watch-label-workspace-wide', 'watch-claimed-files'],
    workspace: {
      projects: {
        app: {
          tasks: {
            build: build('mkdir -p dist && cat ../../config/*.txt src/*.txt > dist/out.txt', {
              rootInputs: ['config/*.txt'],
            }),
          },
          files: { 'src/a.txt': 'a1\n' },
        },
      },
      files: { 'config/a.txt': 's1\n' },
    },
    phases: [
      initial(['app#build'], { [OUT]: 's1\na1\n' }),
      {
        write: { 'config/b.txt': 's2\n' },
        expect: { ran: ['app#build'], files: { [OUT]: 's1\ns2\na1\n' } },
      },
    ],
  }),

  // Turborepo watch_test.rs watch_edit_during_build_triggers_rebuild, one level up
  watchCase({
    id: 'watch/dependency-edit-during-dependant-run-rebuilds',
    kind: 'correctness',
    title:
      'Editing a library while the app that uses it is building rebuilds both, ending with the latest library',
    why: 'The app copied the library’s output when it started, so its result is stale before it ends. The library edit must lead to a library build and one more app build after it. A watch that drops edits arriving while a dependant runs leaves the app built on the older library.',
    from: ['watch-loop-members', 'watch-initial-edit-done'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        app: {
          deps: ['lib'],
          tasks: {
            build: build(
              'mkdir -p dist && cp ../lib/dist/out.txt dist/started && sleep 2 && cat ../lib/dist/out.txt src/*.txt > dist/out.txt.tmp && mv dist/out.txt.tmp dist/out.txt',
              { dependsOn: ['^build'] },
            ),
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    phases: [
      initial(['lib#build', 'app#build'], { [OUT]: 'lib\napp\n' }),
      {
        write: { 'packages/lib/src/a.txt': 'lib2\n' },
        expect: { files: { 'packages/app/dist/started': 'lib2\n' }, inFlight: true },
      },
      {
        write: { 'packages/lib/src/a.txt': 'lib3\n' },
        expect: {
          ran: ['lib#build', 'app#build'],
          order: [['lib#build', 'app#build']],
          files: { [OUT]: 'lib3\napp\n' },
        },
      },
    ],
  }),

  // Turborepo watch_test.rs watch_edit_during_build_triggers_rebuild, another project
  watchCase({
    id: 'watch/edit-to-other-project-during-run',
    kind: 'correctness',
    title:
      'Editing another project while one is building rebuilds that project, and the running build is not repeated',
    why: 'The edit touched a project the running build does not read. It must still be built, during or right after the running one. The running build’s inputs did not change, so starting it again would be wasted work.',
    from: ['watch-loop-members', 'watch-initial-edit-done'],
    workspace: {
      projects: {
        app: { tasks: { build: build(SLOW) }, files: { 'src/a.txt': 'a1\n' } },
        docs: chainProject('docs'),
      },
    },
    phases: [
      initial(['app#build', 'docs#build'], { [OUT]: 'a1\n' }),
      {
        write: { [A]: 'a2\n' },
        expect: { files: { 'packages/app/dist/started': 'a2\n' }, inFlight: true },
      },
      {
        write: { 'packages/docs/src/a.txt': 'docs2\n' },
        expect: {
          ran: ['docs#build'],
          notRan: ['app#build'],
          files: { [out('docs')]: 'docs2\n', [OUT]: 'a2\n' },
        },
      },
    ],
  }),

  // vx watch-restored-output: a hit’s restore is part of the run, not an edit
  watchCase({
    id: 'watch/dependency-edit-undone-restores-both',
    kind: 'efficiency',
    title:
      'Undoing a library edit while watching brings back the library’s and the app’s earlier results without rebuilding',
    why: 'After the undo, every input in the chain is one an earlier run already built. Both results can be put back as they were. Rebuilding gives the same bytes and only costs time; restoring must not set off another round either.',
    from: ['watch-restored-output', 'watch-loop'],
    workspace: chain(),
    phases: [
      initial(['lib#build', 'app#build'], { [OUT]: 'lib\napp\n' }),
      {
        write: { 'packages/lib/src/a.txt': 'lib2\n' },
        expect: { ran: ['lib#build', 'app#build'], files: { [OUT]: 'lib2\napp\n' } },
      },
      {
        write: { 'packages/lib/src/a.txt': 'lib\n' },
        expect: {
          notRan: ['lib#build', 'app#build'],
          files: { [out('lib')]: 'lib\n', [OUT]: 'lib\napp\n' },
        },
      },
    ],
  }),

  // vx watch-lossy-name: names a watcher may mangle
  watchCase({
    id: 'watch/input-named-with-brackets-reruns',
    kind: 'correctness',
    title: 'Editing a source named with square brackets while watching rebuilds',
    why: 'Route folders such as `[id]` are everywhere in web frameworks, and brackets mean a character class in a glob. A watch that turns the path back into a pattern matches nothing and misses the edit. The file is an input like any other.',
    from: ['watch-lossy-name', 'watch-claimed-extras'],
    workspace: {
      projects: { app: { tasks: { build: build() }, files: { 'src/[id].txt': 'x1\n' } } },
    },
    phases: [
      initial(['app#build'], { [OUT]: 'x1\n' }),
      {
        write: { 'packages/app/src/[id].txt': 'x2\n' },
        expect: { ran: ['app#build'], files: { [OUT]: 'x2\n' } },
      },
    ],
  }),

  // vx watch-tree-linux: a directory made after the arm, a file already in it
  watchCase({
    id: 'watch/new-folder-with-many-files-builds-all',
    kind: 'correctness',
    title:
      'A new folder filled with fifty files at once while watching rebuilds once, with every file',
    why: 'A generator or an unpacked archive makes a folder and fills it faster than a watcher can start following it. Files written before the folder is followed are still new inputs. The build must include all of them, once, or it builds a tree missing pieces.',
    from: ['watch-tree-linux', 'watch-recreated-dirs'],
    workspace: app({}, { command: FIND }),
    phases: [
      firstBuild,
      {
        sh: 'mkdir -p packages/app/src/gen && for i in $(seq 10 59); do printf "$i\\n" > packages/app/src/gen/f$i.txt; done',
        expect: {
          ran: ['app#build'],
          files: {
            [OUT]: `a1\n${Array.from({ length: 50 }, (_, i) => `${i + 10}\n`).join('')}`,
          },
        },
      },
    ],
  }),

  // vx watch-signals: a timed-out cycle does not end the watch
  watchCase({
    id: 'watch/timed-out-task-retried-after-edit',
    kind: 'correctness',
    title:
      'A build killed for running past its time limit while watching runs again once the source is fixed',
    why: 'A time limit turns a hang into a failure, and a failure while watching waits for the next edit. The hung build must be killed, not left holding the task. The next edit then builds as usual.',
    from: ['watch-signals', 'stall-watch'],
    alsoNeeds: ['timeout'],
    workspace: app(
      {},
      {
        command:
          'mkdir -p dist && cp src/a.txt dist/tried && if grep -q hang src/a.txt; then sleep 60; fi && cat src/*.txt > dist/out.txt',
        timeout: 2,
      },
    ),
    phases: [
      firstBuild,
      { write: { [A]: 'hang\n' }, expect: { files: { 'packages/app/dist/tried': 'hang\n' } } },
      { write: { [A]: 'a3\n' }, expect: { ran: ['app#build'], files: { [OUT]: 'a3\n' } } },
    ],
  }),

  // Turborepo watch_test.rs watch_no_spurious_rebuild_after_settle: outputs already on disk
  watchCase({
    id: 'watch/revert-after-failed-build-restores-output',
    kind: 'correctness',
    title:
      'Undoing an edit whose build failed after writing its output brings back the good output',
    why: 'The failed build wrote its output before failing, so the file on disk belongs to the bad source. After the undo the sources match the earlier good build again. A watch that skips the restore because the key is one it already saw leaves the failed build’s output in place.',
    from: ['watch-restored-output', 'watch-loop-edit-undone'],
    workspace: app(
      {},
      { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && ! grep -q bad src/a.txt' },
    ),
    phases: [
      firstBuild,
      { write: { [A]: 'bad\n' }, expect: { files: { [OUT]: 'bad\n' } } },
      { write: { [A]: 'a1\n' }, expect: { files: { [OUT]: 'a1\n' } } },
    ],
  }),

  // vx watch-rules: an unreached task reads nothing
  watchCase({
    id: 'watch/dependency-without-the-task-reruns-nothing',
    kind: 'efficiency',
    title:
      'Editing a package the app depends on, which has no build of its own, reruns nothing while watching',
    why: 'The package is a dependency, but it declares no build, so the app’s build reads only the app’s own sources. The edit changes nothing in the app’s inputs. Rebuilding the app because a dependency’s files moved runs work whose result cannot differ.',
    from: ['watch-rules', 'watch-loop-members'],
    workspace: {
      projects: {
        lib: { files: { 'src/a.txt': 'lib\n' } },
        app: chainProject('app', ['lib'], { tasks: { build: build() } }),
      },
    },
    phases: [
      initial(['app#build'], { [OUT]: 'app\n' }),
      { write: { 'packages/lib/src/a.txt': 'lib2\n' }, expect: { notRan: ['app#build'] } },
    ],
  }),

  // vx watch-transient-file: a file that existed at the arm and is gone still starts one
  watchCase({
    id: 'watch/file-deleted-and-restored-at-once-reruns-nothing',
    kind: 'efficiency',
    title:
      'A source deleted and written back with the same bytes at once while watching reruns nothing',
    why: 'Some tools write a file by removing it and creating it again. When they are done the content is what the build already read. A watch that acts on the deletion alone builds without the file, then again with it, both for nothing.',
    from: ['watch-transient-file', 'watch-unignored-deletion'],
    workspace: app({ 'src/b.txt': 'b1\n' }),
    phases: [
      initial(['app#build'], { [OUT]: 'a1\nb1\n' }),
      {
        sh: 'rm packages/app/src/b.txt && printf "b1\\n" > packages/app/src/b.txt',
        expect: { notRan: ['app#build'], files: { [OUT]: 'a1\nb1\n' } },
      },
    ],
  }),

  // vx watch-unignored-deletion: a named input that appears later
  watchCase({
    id: 'watch/listed-input-created-later-reruns',
    kind: 'correctness',
    title:
      'Creating a file the task names outright in its inputs, missing at the start, rebuilds while watching',
    why: 'A task can name a file that does not exist yet, such as an optional local override. A watch that follows only the files it found at the start never sees it arrive. Once it exists it is an input, and the build must take it.',
    from: ['watch-unignored-deletion', 'watch-claimed-files'],
    workspace: app({}, { inputs: ['src/a.txt', 'src/b.txt'] }),
    phases: [
      firstBuild,
      {
        write: { 'packages/app/src/b.txt': 'b1\n' },
        expect: { ran: ['app#build'], files: { [OUT]: 'a1\nb1\n' } },
      },
    ],
  }),

  // Turborepo watch_test.rs watch_task_inputs_reruns_deferred_dependency_output_consumers
  watchCase({
    id: 'watch/dependency-task-of-another-name-reruns',
    kind: 'correctness',
    title:
      'Editing a library whose compile step the app’s build needs rebuilds both while watching',
    why: 'The watched task is the build, but the library’s part of it is a task with another name. The watch must follow the graph, not the task name, to see that the app reads the library’s compile output. A watch that only reruns tasks named like the watched one leaves the library stale and the app with it.',
    from: ['watch-loop-members', 'watch-rules'],
    workspace: {
      projects: {
        lib: { tasks: { compile: build() }, files: { 'src/a.txt': 'lib\n' } },
        app: {
          deps: ['lib'],
          tasks: {
            build: build('mkdir -p dist && cat ../lib/dist/out.txt src/*.txt > dist/out.txt', {
              dependsOn: ['lib#compile'],
            }),
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    phases: [
      initial(['lib#compile', 'app#build'], { [OUT]: 'lib\napp\n' }),
      {
        write: { 'packages/lib/src/a.txt': 'lib2\n' },
        expect: {
          ran: ['lib#compile', 'app#build'],
          order: [['lib#compile', 'app#build']],
          files: { [OUT]: 'lib2\napp\n' },
        },
      },
    ],
  }),

  // vx watch-project-dir-write: a task’s own short-lived file starts no second cycle
  watchCase({
    id: 'watch/task-temp-file-in-sources-does-not-loop',
    kind: 'efficiency',
    title:
      'A build that makes and removes a scratch file among its sources while watching runs once per edit',
    why: 'Plenty of tools drop a scratch file beside the sources while they work and clean it up before they finish. When the build ends, its sources are exactly what it read. A watch that takes the scratch file for an edit rebuilds once more, and loops if every build does it.',
    from: ['watch-project-dir-write', 'watch-own-rewrite-loop'],
    workspace: app(
      {},
      {
        command:
          'mkdir -p dist && printf "x\\n" > src/scratch.txt && rm src/scratch.txt && cat src/*.txt > dist/out.txt',
      },
    ),
    phases: [
      firstBuild,
      { write: { [A]: 'a2\n' }, expect: { ran: ['app#build'], files: { [OUT]: 'a2\n' } } },
    ],
  }),

  // vx watch-rules: a task’s own outputs are no input of it
  watchCase({
    id: 'watch/output-inside-sources-does-not-loop',
    kind: 'efficiency',
    title:
      'A build that writes a declared output inside its own source folder while watching runs once per edit',
    why: 'Generators often write next to the code, inside the folder the task reads. The written file is the task’s output, not something the user edited. Treating it as a new input makes every build start the next one.',
    from: ['watch-rules', 'watch-poll-output-beside-input'],
    workspace: app(
      {},
      {
        command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && cp dist/out.txt src/gen.out',
        outputs: ['dist/**', 'src/gen.out'],
      },
    ),
    phases: [
      initial(['app#build'], { [OUT]: 'a1\n', 'packages/app/src/gen.out': 'a1\n' }),
      {
        write: { [A]: 'a2\n' },
        expect: {
          ran: ['app#build'],
          files: { [OUT]: 'a2\n', 'packages/app/src/gen.out': 'a2\n' },
        },
      },
    ],
  }),

  // vx watch-restored-output: the watch’s first run replays what a plain run cached
  watchCase({
    id: 'watch/initial-run-replays-a-warm-cache',
    kind: 'efficiency',
    title: 'Starting a watch after a plain run replays the build instead of running it again',
    why: 'A watch shares its cache with plain runs. The sources have not changed since the plain run, so its result is the right one. Running the build again only delays the moment the watch is ready.',
    from: ['watch-restored-output', 'watch-loop'],
    workspace: app(),
    before: [{ run: 'build', expect: { ran: ['app#build'] } }],
    phases: [{ expect: { notRan: ['app#build'], files: { [OUT]: 'a1\n' } } }],
  }),

  // vx watch-restored-output: a restore well before the next command starts no cycle
  watchCase({
    id: 'watch/initial-run-restores-missing-output',
    kind: 'correctness',
    title:
      'Starting a watch after deleting a cached build’s output puts the output back, and does not loop',
    why: 'The output is gone but the sources match a cached result, so the watch’s first run must restore it. The restore writes files the watch can see. Taking those writes for an edit sets off a rebuild that should never happen.',
    from: ['watch-restored-output'],
    workspace: app(),
    before: [{ run: 'build', expect: { ran: ['app#build'] } }, { write: { [OUT]: null } }],
    phases: [{ expect: { notRan: ['app#build'], files: { [OUT]: 'a1\n' } } }],
  }),

  // vx watch-loop: a cycle’s results are cached like a run’s
  watchCase({
    id: 'watch/plain-run-after-watch-replays',
    kind: 'efficiency',
    title: 'A plain run after a watch replays what the watch last built',
    why: 'The watch built the edited sources and cached the result like any run. Nothing has changed since. A plain run, such as a pre-commit hook, should replay it rather than build again.',
    from: ['watch-loop', 'watch-restored-output'],
    workspace: app(),
    phases: [
      firstBuild,
      { write: { [A]: 'a2\n' }, expect: { ran: ['app#build'], files: { [OUT]: 'a2\n' } } },
    ],
    after: [{ run: 'build', expect: { notRan: ['app#build'], files: { [OUT]: 'a2\n' } } }],
  }),

  // vx watch-dependency-gone: a project removed under the watch
  watchCase({
    id: 'watch/removed-project-keeps-watching-the-rest',
    kind: 'correctness',
    title: 'Deleting a project while watching keeps the watch going for the projects left',
    why: 'Removing a package is a normal edit, and a watch must survive it. The remaining project did not change, so it needs nothing at the removal. Its next edit must still rebuild it.',
    from: ['watch-dependency-gone', 'watch-loop-members'],
    workspace: { projects: { app: chainProject('app'), docs: chainProject('docs') } },
    phases: [
      initial(['app#build', 'docs#build']),
      {
        write: { 'package.json': rootManifest(['packages/app']), 'packages/docs': null },
        sh: 'bun install --offline',
        configure: (ws) => ({ ...ws, projects: { app: ws.projects['app']! } }),
        expect: { notRan: ['app#build'] },
      },
      { write: { [A]: 'app2\n' }, expect: { ran: ['app#build'], files: { [OUT]: 'app2\n' } } },
    ],
  }),

  // Turborepo watch: a package-wide watch reruns every task on any file of the package
  watchCase({
    id: 'watch/other-task-input-reruns-nothing',
    kind: 'efficiency',
    title: 'Editing a file only the project’s lint reads, while watching its build, reruns nothing',
    why: 'The file belongs to the project, but only a task outside the watch reads it. The build’s inputs did not change. A watch that reruns on any file in the package rebuilds on every lint-config save.',
    from: ['watch-rules', 'watch-claimed-files'],
    workspace: {
      projects: {
        app: {
          tasks: {
            build: build(),
            lint: {
              command: 'mkdir -p lint-out && cat lint/*.txt > lint-out/r.txt',
              inputs: ['lint/**'],
              outputs: ['lint-out/**'],
            },
          },
          files: { 'src/a.txt': 'a1\n', 'lint/rules.txt': 'r1\n' },
        },
      },
    },
    phases: [
      firstBuild,
      {
        write: { 'packages/app/lint/rules.txt': 'r2\n' },
        expect: { notRan: ['app#build', 'app#lint'] },
      },
    ],
  }),

  // vx watch-anchored-scope: a selection takes dependencies, not their other dependants
  watchCase({
    id: 'watch/sibling-dependant-outside-selection-not-run',
    kind: 'efficiency',
    title:
      'Watching one app, a library edit rebuilds the library and that app, but not another app on the same library',
    why: 'The user picked one app, and the watch takes in what it needs, which includes the library. The second app also uses the library but was not picked. Rebuilding it runs work outside what was asked for.',
    from: ['watch-anchored-scope', 'watch-loop-members'],
    projects: ['app'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        app: chainProject('app', ['lib']),
        web: chainProject('web', ['lib']),
      },
    },
    phases: [
      { expect: { ran: ['lib#build', 'app#build'], notRan: ['web#build'] } },
      {
        write: { 'packages/lib/src/a.txt': 'lib2\n' },
        expect: {
          ran: ['lib#build', 'app#build'],
          notRan: ['web#build'],
          files: { [OUT]: 'lib2\napp\n', [out('web')]: null },
        },
      },
    ],
  }),

  // vx watch-loop-edits: a config edit to a dependency reaches its dependants
  watchCase({
    id: 'watch/dependency-config-change-rebuilds-dependant',
    kind: 'correctness',
    title:
      'Changing a library’s build command while watching rebuilds the library and then the app',
    why: 'The library’s output comes from its command, so a new command makes a new output. The app reads that output, so its build is stale too. A watch that reruns only the reconfigured task leaves the app built on the old library.',
    from: ['watch-loop-edits', 'watch-loop-members'],
    workspace: chain(),
    phases: [
      initial(['lib#build', 'app#build'], { [OUT]: 'lib\napp\n' }),
      {
        configure: withTasks('lib', {
          build: {
            ...chainBuild([]),
            command: 'mkdir -p dist && { echo v2; cat src/*.txt; } > dist/out.txt',
          },
        }),
        expect: {
          ran: ['lib#build', 'app#build'],
          order: [['lib#build', 'app#build']],
          files: { [OUT]: 'v2\nlib\napp\n' },
        },
      },
    ],
  }),

  // vx watch-loop: an edit back replays, the config included
  watchCase({
    id: 'watch/config-reverted-replays',
    kind: 'efficiency',
    title:
      'Undoing a change to a task’s command while watching brings back the earlier result without rebuilding',
    why: 'After the config goes back, the task is exactly the one an earlier run built. Its cached result is right and immediate. Rebuilding gives the same bytes and costs the user time.',
    from: ['watch-loop', 'watch-loop-edits'],
    workspace: app(),
    phases: [
      firstBuild,
      {
        configure: withTasks('app', {
          build: build('mkdir -p dist && { echo v2; cat src/*.txt; } > dist/out.txt'),
        }),
        expect: { ran: ['app#build'], files: { [OUT]: 'v2\na1\n' } },
      },
      {
        configure: withTasks('app', { build: build() }),
        expect: { notRan: ['app#build'], files: { [OUT]: 'a1\n' } },
      },
    ],
  }),

  // vx watch-transient-file: a rename that makes a file match the inputs
  watchCase({
    id: 'watch/file-renamed-to-match-inputs-reruns',
    kind: 'correctness',
    title: 'Renaming a file so its name matches the task’s inputs while watching rebuilds with it',
    why: 'The file was there all along, but under a name the inputs did not match. The rename makes it an input without writing a byte. A watch that waits for writes, or only re-reads files it already knew, misses it.',
    from: ['watch-transient-file', 'watch-label-live-path'],
    workspace: app({ 'src/b.bak': 'b1\n' }, { inputs: ['src/*.txt'] }),
    phases: [
      firstBuild,
      {
        sh: 'mv packages/app/src/b.bak packages/app/src/b.txt',
        expect: { ran: ['app#build'], files: { [OUT]: 'a1\nb1\n' } },
      },
    ],
  }),

  // vx watch-linked-input: links among the sources, a loop included
  watchCase({
    id: 'watch/symlink-loop-in-sources-still-watches',
    kind: 'correctness',
    title:
      'A link among the sources that points back at its own folder does not stop a watch from rebuilding',
    why: 'A link to `.` inside a folder makes an endless path, and a watcher that follows links walks it forever. Such links turn up in real trees, from test fixtures to package managers. The watch must start and keep rebuilding on edits.',
    from: ['watch-linked-input', 'watch-tree-linux'],
    workspace: app(),
    before: [{ link: { 'packages/app/src/loop': '.' } }],
    phases: [
      firstBuild,
      { write: { [A]: 'a2\n' }, expect: { ran: ['app#build'], files: { [OUT]: 'a2\n' } } },
    ],
  }),

  // vx watch-symlink-retarget: a dangling link among the sources
  watchCase({
    id: 'watch/dangling-link-in-sources-still-watches',
    kind: 'correctness',
    title: 'A broken link among the sources does not stop a watch from rebuilding',
    why: 'A link whose target is gone is common in a working tree, for instance after a branch switch. The build never reads it. The watch must still start and rebuild on edits to the real sources.',
    from: ['watch-symlink-retarget', 'watch-linked-input'],
    workspace: app(),
    before: [{ link: { 'packages/app/src/dead': '../missing' } }],
    phases: [
      firstBuild,
      { write: { [A]: 'a2\n' }, expect: { ran: ['app#build'], files: { [OUT]: 'a2\n' } } },
    ],
  }),
  // vx watch-loop-edits: one burst across projects is one round
  watchCase({
    id: 'watch/two-libraries-edited-at-once-build-the-app-once',
    kind: 'efficiency',
    title:
      'Editing both libraries an app uses at once while watching builds each library, then the app once',
    why: 'A refactor or a checkout often touches several packages in the same moment. The app needs both libraries rebuilt before it reads them, and one build of it after both is the right result. Building it once per library repeats work and shows an app built on half the change.',
    from: ['watch-loop-edits', 'watch-loop-members'],
    workspace: {
      projects: {
        one: chainProject('one'),
        two: chainProject('two'),
        app: chainProject('app', ['one', 'two']),
      },
    },
    phases: [
      initial(['one#build', 'two#build', 'app#build'], { [OUT]: 'one\ntwo\napp\n' }),
      {
        write: { 'packages/one/src/a.txt': 'one2\n', 'packages/two/src/a.txt': 'two2\n' },
        expect: {
          ran: ['one#build', 'two#build', 'app#build'],
          order: [
            ['one#build', 'app#build'],
            ['two#build', 'app#build'],
          ],
          files: { [OUT]: 'one2\ntwo2\napp\n' },
        },
      },
    ],
  }),

  // vx watch-loop: an edit re-runs once; an edit back and forth replays
  watchCase({
    id: 'watch/flip-between-two-versions-replays-both',
    kind: 'efficiency',
    title:
      'Switching a source back and forth between two versions while watching builds each version only once',
    why: 'Toggling a flag or comparing two approaches means saving the same two contents in turn. Each version was built once, and both results are cached. From the third save on, the watch should put back the stored result instead of building again.',
    from: ['watch-loop', 'watch-loop-edit-undone'],
    workspace: app(),
    phases: [
      firstBuild,
      { write: { [A]: 'a2\n' }, expect: { ran: ['app#build'], files: { [OUT]: 'a2\n' } } },
      { write: { [A]: 'a1\n' }, expect: { notRan: ['app#build'], files: { [OUT]: 'a1\n' } } },
      { write: { [A]: 'a2\n' }, expect: { notRan: ['app#build'], files: { [OUT]: 'a2\n' } } },
    ],
  }),

  // vx watch-tree-linux: never reports a write under .git
  watchCase({
    id: 'watch/git-housekeeping-reruns-nothing',
    kind: 'efficiency',
    title: 'Tagging and packing the git repository while watching reruns nothing',
    why: 'A tag, a fetch or a garbage collection rewrites files under `.git`, often many of them. No source changed. A watch that reacts to git’s own files rebuilds whenever an editor’s git panel refreshes.',
    from: ['watch-tree-linux', 'watch-initial-edit-done'],
    workspace: app(),
    phases: [
      firstBuild,
      {
        sh: 'git tag v1 && git gc -q',
        expect: { notRan: ['app#build'], files: { [OUT]: 'a1\n' } },
      },
    ],
  }),
  // vx watch-loop: the sandboxed task under watch
  watchCase({
    id: 'watch/sandboxed-task-reruns-on-edit',
    kind: 'correctness',
    title: 'Editing the source of a sandboxed build while watching rebuilds it, once',
    why: 'A sandbox changes where a task may read and write, not when it runs. The watch must rebuild it on an edit as it would any task. The sandbox’s own setup must not look like an edit either, or each build starts the next.',
    from: ['watch-loop', 'sandbox-grants.unsafe'],
    alsoNeeds: ['sandbox'],
    workspace: app({}, { sandbox: {} }),
    phases: [
      firstBuild,
      { write: { [A]: 'a2\n' }, expect: { ran: ['app#build'], files: { [OUT]: 'a2\n' } } },
    ],
  }),
  // Turborepo watch: a run covers the packages a change reaches, not every package
  watchCase({
    id: 'watch/failed-task-not-rerun-by-unrelated-edit',
    kind: 'efficiency',
    title: 'A broken build in one project is not run again when an unrelated project is edited',
    why: 'Nothing the broken build reads has changed, so running it again only fails the same way. The edit was in another project with no tie to it. Repeating the failure on every unrelated save wastes time and buries the useful output under the same error.',
    from: ['watch-rules', 'watch-signals'],
    workspace: {
      projects: {
        app: chainProject('app'),
        docs: { tasks: { build: build(FAILING) }, files: { 'src/a.txt': 'bad\n' } },
      },
    },
    phases: [
      { expect: { ran: ['app#build'], files: { 'packages/docs/dist/tried': 'bad\n' } } },
      {
        write: { [A]: 'app2\n' },
        expect: { ran: ['app#build'], notRan: ['docs#build'], files: { [OUT]: 'app2\n' } },
      },
    ],
  }),

  // Turborepo #13347 watch_task_inputs_do_not_rerun_non_cacheable_dependencies_or_persistent_dependents
  watchCase({
    id: 'watch/uncached-dependency-not-rerun-on-dependant-edit',
    kind: 'efficiency',
    title: 'Editing the app while watching does not rerun the never-cached library it depends on',
    why: 'Turning the cache off for a task means its result is never replayed, not that it reruns whenever anything nearby changes. The edit touched the app only, so the library’s inputs are as they were. Rerunning the library on every app save makes the slowest step of a watch run every time.',
    from: ['watch-loop-uncached', 'watch-rules'],
    alsoNeeds: ['uncached-task'],
    workspace: {
      projects: {
        lib: chainProject('lib', [], { tasks: { build: { ...chainBuild([]), cache: false } } }),
        app: chainProject('app', ['lib']),
      },
    },
    phases: [
      initial(['lib#build', 'app#build'], { [OUT]: 'lib\napp\n' }),
      {
        write: { [A]: 'app2\n' },
        expect: { ran: ['app#build'], notRan: ['lib#build'], files: { [OUT]: 'lib\napp2\n' } },
      },
    ],
  }),

  // Turborepo #12654: `turbo watch dev` restarted a library's dev server when
  // the app that depends on it changed
  watchCase({
    id: 'watch/app-edit-leaves-library-server-up',
    kind: 'correctness',
    title: 'Saving a file in an app leaves the dev server of the library it uses running',
    why: 'The app depends on the library, not the other way round, so an edit in the app changes nothing the library’s server reads. That server must keep running. A watch that restarts it on every app save drops its connections and state for no reason, and walks the graph the wrong way.',
    from: ['watch-initial-edit-server', 'watch-loop-members'],
    alsoNeeds: ['persistent'],
    task: 'dev',
    workspace: {
      projects: {
        lib: {
          tasks: { dev: { command: SERVER('lib'), persistent: true, inputs: ['src/**'] } },
          files: { 'src/a.txt': 'lib1\n' },
        },
        app: {
          deps: ['lib'],
          tasks: { dev: { command: SERVER('app'), persistent: true, inputs: ['src/**'] } },
          files: { 'src/a.txt': 'app1\n' },
        },
      },
    },
    phases: [
      {
        expect: {
          files: { 'packages/lib/starts.txt': 's\n', 'packages/app/starts.txt': 's\n' },
          inFlight: true,
        },
      },
      {
        write: { 'packages/app/src/a.txt': 'app2\n' },
        expect: { files: { 'packages/lib/starts.txt': 's\n', 'packages/lib/stopped.txt': null } },
      },
    ],
  }),

  // Turborepo #8673: under watch, persistent tasks did not wait for the first
  // run of their dependencies
  watchCase({
    id: 'watch/server-starts-after-dependency-first-build',
    kind: 'correctness',
    title: 'Under watch, a dev server starts only after the first build of the library it needs',
    why: 'The server depends on the library’s build, so the build must be on disk before the server starts, as in a plain run. A server started early reads a missing or old library and serves broken pages until someone restarts it. The watch’s first cycle must keep the same order a run keeps.',
    from: ['watch-initial-readiness', 'watch-initial-edit-server'],
    alsoNeeds: ['persistent'],
    task: 'dev',
    projects: ['app'],
    workspace: {
      projects: {
        lib: {
          tasks: { build: build('sleep 1; mkdir -p dist && cat src/*.txt > dist/out.txt') },
          files: { 'src/a.txt': 'lib1\n' },
        },
        app: {
          deps: ['lib'],
          tasks: {
            dev: {
              command:
                '{ cat ../lib/dist/out.txt 2>/dev/null || echo missing; } > seen.txt; echo up; sleep 600',
              persistent: true,
              dependsOn: ['^build'],
              inputs: ['src/**'],
            },
          },
          files: { 'src/a.txt': 'app1\n' },
        },
      },
    },
    phases: [
      {
        expect: {
          ran: ['lib#build'],
          files: { 'packages/app/seen.txt': 'lib1\n' },
          inFlight: true,
        },
      },
    ],
  }),

  // Turborepo #13115: `turbo watch` stopped a persistent task on a change
  // outside the task's inputs
  watchCase({
    id: 'watch/edit-outside-server-inputs-keeps-it-up',
    kind: 'correctness',
    title: 'Saving a file outside a dev server’s inputs leaves the server running',
    why: 'A file the server’s task does not list, a note or a test fixture, changes nothing it serves. The server must keep running, neither restarted nor stopped. A watch that stops it here leaves the user with a dead server after an unrelated save.',
    from: ['watch-initial-edit-server', 'watch-loop-members'],
    alsoNeeds: ['persistent'],
    task: 'dev',
    workspace: {
      projects: {
        app: {
          tasks: { dev: { command: SERVER('app'), persistent: true, inputs: ['src/**'] } },
          files: { 'src/a.txt': 'app1\n', 'notes.txt': 'n1\n' },
        },
      },
    },
    phases: [
      { expect: { files: { 'packages/app/starts.txt': 's\n' }, inFlight: true } },
      {
        write: { 'packages/app/notes.txt': 'n2\n' },
        expect: { files: { 'packages/app/starts.txt': 's\n', 'packages/app/stopped.txt': null } },
      },
    ],
  }),

  // Turborepo #12505 / #9421, the other side: a rebuilt dependency is the dev
  // tool's to reload, not the watch's to restart
  watchCase({
    id: 'watch/dependency-rebuild-keeps-server-up',
    kind: 'correctness',
    title: 'Under watch, rebuilding the library a dev server needs leaves the server running',
    why: 'A dev server reloads what its dependencies rebuild on its own; that is what it is for. The watch must rebuild the library and keep the server up, so the page reloads in place and its port stays held. Stopping or restarting the server on every library edit throws away its state and drops every open connection.',
    from: ['watch-initial-edit-server', 'watch-initial-readiness'],
    alsoNeeds: ['persistent'],
    task: 'dev',
    projects: ['app'],
    workspace: {
      projects: {
        lib: { tasks: { build: build() }, files: { 'src/a.txt': 'lib1\n' } },
        app: {
          deps: ['lib'],
          tasks: {
            dev: {
              command: SERVER('app'),
              persistent: true,
              dependsOn: ['^build'],
              inputs: ['src/**'],
            },
          },
          files: { 'src/a.txt': 'app1\n' },
        },
      },
    },
    phases: [
      {
        expect: {
          ran: ['lib#build'],
          files: { 'packages/app/starts.txt': 's\n', 'packages/lib/dist/out.txt': 'lib1\n' },
          inFlight: true,
        },
      },
      {
        write: { 'packages/lib/src/a.txt': 'lib2\n' },
        expect: {
          ran: ['lib#build'],
          files: {
            'packages/lib/dist/out.txt': 'lib2\n',
            'packages/app/starts.txt': 's\n',
            'packages/app/stopped.txt': null,
          },
        },
      },
    ],
  }),
] satisfies Case[]

export const pending: Case[] = []
