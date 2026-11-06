// Outcomes drawn from moon's own tests (moonrepo/moon crates/*/tests) that
// no earlier case carried. The rest of that suite tests moon's config
// parsing, toolchains, codegen, Docker, its daemon and CAS internals, its
// log text, or options no other runner has (task dependency types, mutexes,
// priorities, conditions, CI-only tasks, plans), and stays out. `from`
// names the vx tests guarding the same outcome; each case's comment names
// the moon test it ports.
import { defineCase } from '../src/spec.ts'

const A = 'packages/a'

const COPIES = {
  command: 'mkdir -p dist && cat src/a.txt > dist/out.txt',
  inputs: ['src/**'],
  outputs: ['dist/**'],
}

export default [
  // task-runner/tests/output_hydrater_test.rs hydrates_read_only_output_file_from_cas (moon #2608)
  defineCase({
    id: 'outputs/read-only-output-replaced-on-hit',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A read-only output file left by a newer build is replaced by the cached one, still read-only',
    why: 'Some tools write their outputs read-only, as generated sources or vendored files often are. When the inputs go back to an earlier state, the cache must put the earlier file back over the read-only one on disk. A restore that cannot overwrite it either fails the run or leaves the newer file under a green replay. The file comes back as the task wrote it, read-only.',
    from: ['restore-in-place', 'artifact-roundtrip'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command:
                'mkdir -p dist && rm -f dist/out.txt && cat src/a.txt > dist/out.txt && chmod 444 dist/out.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'one\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { [`${A}/src/a.txt`]: 'two\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [`${A}/dist/out.txt`]: 'two\n' } },
      },
      { write: { [`${A}/src/a.txt`]: 'one\n' } },
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: 'one\n' } } },
      { check: { modes: { [`${A}/dist/out.txt`]: 0o444 } } },
    ],
  }),

  // task-runner/tests/output_hydrater_test.rs hydrates_empty_files_even_when_empty_blob_missing_from_cas,
  // hydrates_multiple_files_sharing_the_same_blob; output_archiver_test.rs dedupes_blobs_for_files_with_same_content,
  // empty_files_share_the_empty_blob; daemon-server/tests/task_outputs_test.rs accepts_many_output_files_over_the_default_message_limit
  defineCase({
    id: 'outputs/many-empty-and-equal-files-restored',
    category: 'outputs',
    kind: 'correctness',
    title:
      'Six thousand output files, half empty and half with the same content, all come back on a hit',
    why: 'A bundler can write thousands of chunks, many empty or byte-identical. A cache that stores each content once must still put every path back, and an empty file is a file, not a missing one. A restore that drops the empty files, writes one copy of a shared content, or stops at a size limit leaves a partial tree under a green replay.',
    from: ['artifact-roundtrip', 'artifact-ceiling'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command:
                'mkdir -p dist/e dist/s && i=0; while [ $i -lt 3000 ]; do : > dist/e/$i.txt; echo same > dist/s/$i.txt; i=$((i+1)); done; cat src/a.txt > dist/out.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { [`${A}/dist`]: null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['a#build'],
          files: {
            [`${A}/dist/out.txt`]: 'a\n',
            [`${A}/dist/e/0.txt`]: '',
            [`${A}/dist/e/2999.txt`]: '',
            [`${A}/dist/s/0.txt`]: 'same\n',
            [`${A}/dist/s/2999.txt`]: 'same\n',
          },
        },
      },
      {
        sh: `[ "$(find ${A}/dist/e -type f -size 0 | wc -l)" -eq 3000 ] && [ "$(find ${A}/dist/s -type f | wc -l)" -eq 3000 ] && [ -z "$(find ${A}/dist/s -type f ! -size 5c)" ]`,
      },
    ],
  }),

  // task-runner/tests/task_runner_test.rs doesnt_reuse_forced_outputs_for_the_previous_hash
  defineCase({
    id: 'cache/forced-run-after-edit-saves-under-new-inputs',
    category: 'cache',
    kind: 'correctness',
    title:
      'A forced run after an input edit saves under the new inputs, and the old inputs never replay its result',
    why: 'Forcing a run after editing a source must file the fresh result under the edited inputs, so the next run with those inputs replays it. Filing it under the entry the last run used means that putting the source back replays the result of the edit: a stale hit under a green run. A force that saves nothing leaves the next run to build the same thing again.',
    from: ['restore-in-place', 'cli'],
    needs: ['force'],
    workspace: {
      projects: { a: { tasks: { build: COPIES }, files: { 'src/a.txt': 'before\n' } } },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { [`${A}/src/a.txt`]: 'after\n' } },
      {
        run: 'build',
        force: true,
        expect: { exit: 0, ran: ['a#build'], files: { [`${A}/dist/out.txt`]: 'after\n' } },
      },
      { write: { [`${A}/src/a.txt`]: 'before\n' } },
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: 'before\n' } } },
      { write: { [`${A}/src/a.txt`]: 'after\n' } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/dist/out.txt`]: 'after\n' } },
      },
    ],
  }),

  // affected/tests/affected_tracker_test.rs not_affected_if_no_inputs (and the async twin)
  defineCase({
    id: 'affected/task-reading-no-files-not-selected',
    category: 'affected',
    kind: 'efficiency',
    title:
      'A change to a file another task of the project reads does not select its task that reads no files',
    why: 'A task that declares empty inputs says no file in the project changes its result, as a task that only prints a version does. Here the changed file is one the project’s `test` declares, so the tool knows what reads it, and it cannot make `build` stale. Selecting `build` anyway reruns work on every commit that touches the project, while the task in another project that reads its own changed file is still selected.',
    from: ['affected-tasks', 'affected'],
    needs: ['affected'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: { command: 'echo ok', inputs: [], outputs: [] },
            test: { command: 'cat src/a.txt', inputs: ['src/**'], outputs: [] },
          },
          files: { 'src/a.txt': 'a\n' },
        },
        b: {
          tasks: { build: { command: 'cat src/b.txt', inputs: ['src/**'], outputs: [] } },
          files: { 'src/b.txt': 'b\n' },
        },
      },
    },
    steps: [
      { write: { [`${A}/src/a.txt`]: 'a2\n', 'packages/b/src/b.txt': 'b2\n' } },
      { commit: 'edit' },
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['b#build'], notRan: ['a#build'] },
      },
    ],
  }),
]
