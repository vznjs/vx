// Outcomes drawn from Turborepo's integration tests (vercel/turborepo
// crates/turborepo/tests) and Vite Task's e2e fixtures (voidzero-dev/vite-task
// crates/vt_bin/tests/e2e_snapshots/fixtures) that no earlier case carried.
// Each case's comment names the test it ports; `from` names the vx tests
// guarding the same outcome.
import { defineCase, type TaskSpec } from '../src/spec.ts'
import { one } from './shapes.ts'

const A = 'packages/a'

const task = (command: string, extra: Partial<TaskSpec> = {}): TaskSpec => ({
  command,
  inputs: ['src/**'],
  outputs: ['dist/**'],
  ...extra,
})

const MODE =
  'mkdir -p dist && { test -x src/tool.sh && echo executable || echo plain; } > dist/out.txt'
const OUT = `${A}/dist/out.txt`

export default [
  // executable_permissions.rs executable_permissions_control_cache_replay
  defineCase({
    id: 'inputs/executable-bit-cleared-reruns',
    category: 'inputs',
    kind: 'correctness',
    title: 'Clearing the executable bit of a committed input runs the task again',
    why: 'A task can read a file’s mode (a packager that keeps the bit, a check that a script is runnable). Taking the bit away is as much a change as adding it. A tool that keys only content, or only notices the bit being set, replays the result built from the executable file. The output says the file is plain.',
    from: ['hash-scenarios', 'stale-hit-git'],
    workspace: one(task(MODE), { 'src/tool.sh': '#!/bin/sh\necho hi\n' }),
    steps: [
      { chmod: { [`${A}/src/tool.sh`]: 0o755 } },
      { commit: 'executable' },
      { run: 'build', expect: { exit: 0, files: { [OUT]: 'executable\n' } } },
      { chmod: { [`${A}/src/tool.sh`]: 0o644 } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'plain\n' } } },
    ],
  }),

  // executable_permissions.rs executable_permissions_control_cache_replay (back to 0644)
  defineCase({
    id: 'inputs/executable-bit-round-trip-replays',
    category: 'inputs',
    kind: 'efficiency',
    title: 'An input made executable and plain again replays the plain build',
    why: 'Putting a file back as it was puts the task back on a result it already built. A tool that keys the mode must key the same value for the same mode, not the history of changes. Rebuilding here costs the full task for a state the cache already holds. The third run replays, and the output says plain.',
    from: ['hash-scenarios', 'stale-hit-git'],
    workspace: one(task(MODE), { 'src/tool.sh': '#!/bin/sh\necho hi\n' }),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [OUT]: 'plain\n' } } },
      { chmod: { [`${A}/src/tool.sh`]: 0o755 } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'executable\n' } } },
      { chmod: { [`${A}/src/tool.sh`]: 0o644 } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'], files: { [OUT]: 'plain\n' } } },
    ],
  }),

  // executable_permissions.rs fixture(use_git = false): the file is not committed
  defineCase({
    id: 'inputs/executable-bit-on-untracked-input',
    category: 'inputs',
    kind: 'correctness',
    title: 'Making an input git does not track yet executable runs the task again',
    why: 'A new script is untracked until the user commits it, and git holds no mode for it. A tool that reads modes only from git’s index sees no change and replays the build of the plain file. The bit must be read from the file itself. The second run runs and sees the file executable.',
    from: ['hash-scenarios', 'stale-hit-git'],
    workspace: one(task(MODE), { 'src/a.txt': 'a\n' }),
    steps: [
      { write: { [`${A}/src/tool.sh`]: '#!/bin/sh\necho hi\n' } },
      { run: 'build', expect: { exit: 0, files: { [OUT]: 'plain\n' } } },
      { chmod: { [`${A}/src/tool.sh`]: 0o755 } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'executable\n' } } },
    ],
  }),

  // executable_permissions.rs: commit after the chmod, then build again
  defineCase({
    id: 'inputs/executable-bit-committed-replays',
    category: 'inputs',
    kind: 'efficiency',
    title: 'Committing an input made executable replays the build of the executable file',
    why: 'A commit records what is already on disk; the file is the same before and after. A tool that keys the working tree for a dirty file and git’s record for a clean one must give both the same value. Otherwise every commit costs a rebuild of work already done. The run after the commit replays.',
    from: ['hash-scenarios', 'stale-hit-git'],
    workspace: one(task(MODE), { 'src/tool.sh': '#!/bin/sh\necho hi\n' }),
    steps: [
      { chmod: { [`${A}/src/tool.sh`]: 0o755 } },
      { run: 'build', expect: { exit: 0, files: { [OUT]: 'executable\n' } } },
      { commit: 'executable' },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'], files: { [OUT]: 'executable\n' } } },
    ],
  }),

  // executable_permissions.rs fixture(global = true): a root input
  defineCase({
    id: 'inputs/executable-bit-on-root-input',
    category: 'inputs',
    kind: 'correctness',
    title: 'Making a root input executable runs the task that names it again',
    why: 'A shared script at the root (`scripts/build.sh`) is often named by every project’s task. Its mode is part of what the task reads, as for a project file. A tool that keys root files by content alone replays a build made while the script could not run. The second run runs and sees the script executable.',
    from: ['hash-scenarios', 'workspace-files'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: task(
              'mkdir -p dist && { test -x ../../tool.sh && echo executable || echo plain; } > dist/out.txt',
              { rootInputs: ['tool.sh'] },
            ),
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
      files: { 'tool.sh': '#!/bin/sh\necho hi\n' },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [OUT]: 'plain\n' } } },
      { chmod: { 'tool.sh': 0o755 } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'executable\n' } } },
    ],
  }),

  // untracked_scoping_test.rs scoped_run_hashes_untracked_files_identically_to_whole_repo_scan
  defineCase({
    id: 'cache/selected-run-replays-untracked-input',
    category: 'cache',
    kind: 'efficiency',
    title:
      'A run of one project replays what a run of every project stored, with an untracked input',
    why: 'A tool may look for untracked files only under the projects a run selects. Whatever it scans, the same file must key the task the same way. A selected run that keys an untracked file differently misses an entry the full run just saved, and every CI job that selects a project rebuilds it. The selected run replays.',
    from: ['cache', 'select'],
    workspace: {
      projects: {
        a: {
          tasks: { build: task('mkdir -p dist && cat src/*.txt > dist/out.txt') },
          files: { 'src/a.txt': 'a\n' },
        },
        b: {
          tasks: { build: task('mkdir -p dist && cat src/*.txt > dist/out.txt') },
          files: { 'src/a.txt': 'b\n' },
        },
      },
    },
    steps: [
      { write: { [`${A}/src/new.txt`]: 'new\n' } },
      { run: 'build', expect: { exit: 0, files: { [OUT]: 'a\nnew\n' } } },
      {
        run: 'build',
        projects: ['a'],
        expect: { exit: 0, notRan: ['a#build'], files: { [OUT]: 'a\nnew\n' } },
      },
    ],
  }),

  // untracked_scoping_test.rs scoped_run_covers_untracked_files_in_nested_packages
  defineCase({
    id: 'inputs/selected-nested-project-untracked-edit-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'Selecting a project nested in another, an edit to its untracked file runs its task again',
    why: 'A project inside another project’s directory owns its own files, untracked ones too. A tool that scans untracked files only at the selected projects’ top level, or hands the nested project’s files to its parent, misses the edit and replays a stale build. The nested project’s task runs again with the new content.',
    from: ['nested-input', 'select'],
    workspace: {
      projects: {
        outer: {
          tasks: { build: task('mkdir -p dist && cat src/*.txt > dist/out.txt') },
          files: { 'src/a.txt': 'o\n' },
        },
        inner: {
          dir: 'packages/outer/inner',
          tasks: { build: task('mkdir -p dist && cat src/*.txt > dist/out.txt') },
          files: { 'src/a.txt': 'i\n' },
        },
      },
    },
    steps: [
      { write: { 'packages/outer/inner/src/u.txt': 'u1\n' } },
      { run: 'build', projects: ['inner'], expect: { exit: 0 } },
      { write: { 'packages/outer/inner/src/u.txt': 'u2\n' } },
      {
        run: 'build',
        projects: ['inner'],
        expect: {
          exit: 0,
          ran: ['inner#build'],
          files: { 'packages/outer/inner/dist/out.txt': 'i\nu2\n' },
        },
      },
    ],
  }),

  // untracked_scoping_test.rs scoped_scan_respects_ancestor_and_nested_gitignore_rules
  defineCase({
    id: 'inputs/selected-run-keeps-nested-gitignore',
    category: 'inputs',
    kind: 'efficiency',
    title: 'A run of one project ignores a file its own `.gitignore` ignores, as a full run does',
    why: 'Git’s ignore rules come from every `.gitignore` between the root and the file. A tool that scans only the selected project may read the project’s rules but miss the root’s, or the other way round, and key a scratch file the full run ignores. Rebuilding on a scratch file wastes the run. An edit to the ignored file replays; an edit to a kept one runs.',
    from: ['ignored-inputs', 'select'],
    workspace: {
      projects: {
        a: {
          tasks: { build: task('mkdir -p dist && cat src/a.txt > dist/out.txt') },
          files: { 'src/a.txt': 'a\n', '.gitignore': 'src/scratch.txt\n' },
        },
        b: {
          tasks: { build: task('mkdir -p dist && cat src/a.txt > dist/out.txt') },
          files: { 'src/a.txt': 'b\n' },
        },
      },
    },
    steps: [
      { run: 'build', projects: ['a'], expect: { exit: 0 } },
      { write: { [`${A}/src/scratch.txt`]: 'noise\n' } },
      { run: 'build', projects: ['a'], expect: { exit: 0, notRan: ['a#build'] } },
      { write: { [`${A}/src/kept.txt`]: 'kept\n' } },
      { run: 'build', projects: ['a'], expect: { exit: 0, ran: ['a#build'] } },
    ],
  }),

  // filter_run_test.rs test_exclude_root_filter_excludes_root_tasks
  defineCase({
    id: 'graph/select-exclude-root-project-by-name',
    category: 'graph',
    kind: 'correctness',
    title:
      'Excluding the workspace-root project by name leaves out its task and keeps the members’',
    why: 'The root project is a project like any other, and an exclude by its name takes it out. A tool that cannot name the root runs its task anyway, or treats the exclude as excluding every member under the root’s directory. The members’ tasks run and the root’s does not.',
    from: ['filter', 'select'],
    needs: ['filter'],
    workspace: {
      projects: {
        root: { dir: '.', tasks: { check: { command: 'true', inputs: ['tools/**'] } } },
        a: {
          tasks: { check: { command: 'true', inputs: ['src/**'] } },
          files: { 'src/a.txt': 'a\n' },
        },
        b: {
          tasks: { check: { command: 'true', inputs: ['src/**'] } },
          files: { 'src/a.txt': 'b\n' },
        },
      },
      files: { 'tools/t.txt': 't\n' },
    },
    steps: [
      {
        run: 'check',
        select: [{ name: 'root', exclude: true }],
        expect: { exit: 0, ran: ['a#check', 'b#check'], notRan: ['root#check'] },
      },
    ],
  }),

  // Vite Task clean_and_rebuild_output_folder
  defineCase({
    id: 'outputs/clean-and-rebuild-output-folder-replays',
    category: 'outputs',
    kind: 'efficiency',
    title: 'A task that lists, removes and remakes its output folder replays on the next run',
    why: 'Build tools clean their output folder before writing a new one: they look at it, delete it, make it again and check it. None of that reads an input. A tool that counts the task’s own folder as something it read sees it change every run and never replays. The second run replays and the folder comes back.',
    from: ['output-dirs', 'restore-in-place'],
    workspace: one(
      task(
        'ls dist > /dev/null 2>&1; rm -rf dist && mkdir dist && cat src/a.txt > dist/a.txt && test -d dist',
      ),
    ),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/dist/a.txt`]: 'a\n' } },
      },
      { write: { [`${A}/dist`]: null } },
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/a.txt`]: 'a\n' } } },
    ],
  }),

  // Vite Task clean_and_rebuild_output_folder output_changed_after_clean_and_rebuild
  defineCase({
    id: 'outputs/clean-rebuild-output-edited-put-back',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output edited by hand after a clean-and-rebuild task is put back on the next run',
    why: 'Deleting its output folder does not make that folder an input of the task. An edit to the output afterwards is a damaged result, not new input: the next run must leave the bytes the task produces. Keeping the hand edit leaves a tree no build made. The file holds the task’s content again.',
    from: ['output-dirs', 'restore-in-place'],
    workspace: one(task('rm -rf dist && mkdir dist && cat src/a.txt > dist/a.txt')),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist/a.txt`]: 'by hand\n' } },
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/a.txt`]: 'a\n' } } },
    ],
  }),

  // Vite Task folder_renamed_into_place
  defineCase({
    id: 'outputs/folder-renamed-into-place-restored',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A task that writes a temporary folder and renames it to its output caches and restores the output',
    why: 'Vite’s dependency optimizer writes `deps_temp_*` and renames it to `deps` so readers never see a half-written folder. The output is the renamed folder, written by a rename rather than by file writes. A tool that tracks what the task wrote file by file can miss it. The second run replays, and the folder comes back after it is deleted.',
    from: ['output-dirs', 'artifact-roundtrip'],
    workspace: one(
      task(
        'rm -rf tmp deps && mkdir tmp && cat src/a.txt > tmp/a.js && mv tmp deps && cat deps/a.js > /dev/null',
        {
          outputs: ['deps/**'],
        },
      ),
      { 'src/a.txt': 'x\n', '.gitignore': 'deps\ntmp\n' },
    ),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [`${A}/deps/a.js`]: 'x\n' } } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { write: { [`${A}/deps`]: null } },
      {
        run: 'build',
        expect: { exit: 0, files: { [`${A}/deps/a.js`]: 'x\n', [`${A}/tmp`]: null } },
      },
    ],
  }),

  // Vite Task list_folder_holding_output, negative_glob_hides_listing_entry
  defineCase({
    id: 'outputs/listing-the-folder-holding-output-replays',
    category: 'outputs',
    kind: 'efficiency',
    title: 'A task that lists the project folder holding its output replays on the next run',
    why: 'A code generator often lists the folder it writes into. Its own output appears in that listing after the first run. A tool that keys what the task listed sees a new entry and reruns every time, so the task never replays. The second run replays.',
    from: ['output-dirs', 'output-flow'],
    workspace: one(task('mkdir -p dist && cat src/a.txt > dist/a.txt && ls > /dev/null')),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/dist/a.txt`]: 'a\n' } },
      },
    ],
  }),

  // Vite Task stat_own_output_folder
  defineCase({
    id: 'outputs/stat-of-own-output-folder-replays',
    category: 'outputs',
    kind: 'efficiency',
    title: 'A task that checks its own output folder after writing replays on the next run',
    why: 'A build tool checks that its output folder exists once it has written it. The folder is the task’s own output, made by this run. A tool that counts every path the task looked at as an input sees the folder’s times change and reruns every time. The second run replays.',
    from: ['output-dirs', 'output-flow'],
    workspace: one(
      task(
        'mkdir -p dist && cat src/a.txt > dist/a.txt && test -d dist && ls -ld dist > /dev/null',
      ),
    ),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/dist/a.txt`]: 'a\n' } },
      },
    ],
  }),

  // Vite Task symlink_in_output
  defineCase({
    id: 'outputs/link-to-committed-file-in-output-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output link to a committed file outside the outputs comes back as the same link',
    why: 'A build can link a source file into its output rather than copy it, as pnpm does for packages. The link is the output; the file it points at belongs to the source tree. A cache that stores the target’s bytes in place of the link, or drops the link, restores a different tree. The link comes back pointing where it did.',
    from: ['output-links', 'restore-link-out'],
    workspace: one(
      task('mkdir -p dist && ln -sf ../src/target.txt dist/link && cat src/a.txt > dist/a.txt'),
      {
        'src/a.txt': 'a\n',
        'src/target.txt': 't\n',
      },
    ),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist`]: null } },
      {
        run: 'build',
        expect: { exit: 0, files: { [`${A}/dist/link`]: 't\n', [`${A}/dist/a.txt`]: 'a\n' } },
      },
      { check: { links: { [`${A}/dist/link`]: '../src/target.txt' } } },
    ],
  }),
]
