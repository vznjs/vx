// What keys a task, drawn from the rivals' hasher tests: moon's
// crates/task-hasher/tests/task_hasher_test.rs (input_file_output_dir,
// input_file_output_glob, input_glob_output_file, input_glob_output_dir,
// input_glob_output_glob), Turborepo's crates/turborepo/tests
// final_hash_contract.rs (env_mode_hashes, task_hash_contract) and Nx's
// packages/nx/src/hasher/task-hasher.spec.ts (should hash tasks where the
// project has dependencies). Each case holds a tool to keying exactly what
// the task reads: a value it misses replays a stale result, one it adds
// reruns for nothing.
import { defineCase, type Case, type TaskSpec } from '../src/spec.ts'
import { one } from './shapes.ts'

const A = 'packages/a'
const OUT = `${A}/dist/out.txt`

const task = (command: string, extra: Partial<TaskSpec> = {}): TaskSpec => ({
  command,
  inputs: ['src/**'],
  outputs: ['dist/**'],
  ...extra,
})

/** A task whose input pattern also covers the output it writes to `out/x.txt`, never gitignored. */
function ownOutput(id: string, title: string, inputs: string[], outputs: string[]): Case {
  return defineCase({
    id: `inputs/${id}`,
    category: 'inputs',
    kind: 'efficiency',
    title,
    why: 'Input and output patterns often overlap: `**/*.txt` in, `out/**` out, with `out` not ignored by git. The files the task wrote are its result, not something it read. A tool that keys its own output reruns the task every time, and caching it is pointless. The second run replays, and an edit to a real source still runs it; refusing such a pair before any task runs is fine too.',
    from: ['output-flow', 'ignored-outputs'],
    workspace: one(
      { command: 'mkdir -p out && cat src/a.txt > out/x.txt', inputs, outputs },
      { 'src/a.txt': 'a\n' },
    ),
    // A tool may refuse an input that names its own output outright, before any task runs.
    steps: [
      { run: 'build', expect: { exit: 0, files: { [`${A}/out/x.txt`]: 'a\n' }, orRefused: true } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'], orRefused: true } },
      { write: { [`${A}/src/a.txt`]: 'b\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['a#build'],
          files: { [`${A}/out/x.txt`]: 'b\n' },
          orRefused: true,
        },
      },
    ],
  })
}

/** A declared variable whose two values must key two results: `printf '[%s]'` shows the bytes. */
function envValues(id: string, title: string, why: string, first: string, second: string): Case {
  const show = (v: string) => `[${v}]`
  return defineCase({
    id: `env/${id}`,
    category: 'env',
    kind: 'correctness',
    title,
    why,
    from: ['env', 'hash-scenarios-names'],
    needs: ['env-inputs'],
    workspace: one(
      task('mkdir -p dist && printf "[%s]" "$MODE" > dist/out.txt', { env: ['MODE'] }),
    ),
    steps: [
      { run: 'build', env: { MODE: first }, expect: { exit: 0, files: { [OUT]: show(first) } } },
      {
        run: 'build',
        env: { MODE: second },
        expect: { exit: 0, ran: ['a#build'], files: { [OUT]: show(second) } },
      },
    ],
  })
}

export default [
  // task_hasher_test.rs input_file_output_dir
  ownOutput(
    'own-output-file-named-under-output-dir-replays',
    'An input naming the file a task writes into its output directory does not rerun the task',
    ['src/**', 'out/x.txt'],
    ['out'],
  ),
  // task_hasher_test.rs input_file_output_glob
  ownOutput(
    'own-output-file-named-under-output-glob-replays',
    'An input naming a file the task’s output glob matches does not rerun the task',
    ['src/**', 'out/x.txt'],
    ['out/**/*.txt'],
  ),
  // task_hasher_test.rs input_glob_output_file
  ownOutput(
    'input-glob-over-own-output-file-replays',
    'An input glob that matches the one file a task writes does not rerun the task',
    ['**/*.txt'],
    ['out/x.txt'],
  ),
  // task_hasher_test.rs input_glob_output_dir
  ownOutput(
    'input-glob-over-own-output-dir-replays',
    'An input glob that reaches into the task’s output directory does not rerun the task',
    ['**/*.txt'],
    ['out'],
  ),
  // task_hasher_test.rs input_glob_output_glob
  ownOutput(
    'input-glob-over-own-output-glob-replays',
    'An input glob that overlaps the task’s output glob does not rerun the task',
    ['**/*.txt'],
    ['out/**'],
  ),

  defineCase({
    id: 'cache/contents-swapped-between-inputs-reruns',
    category: 'cache',
    kind: 'correctness',
    title: 'Two inputs that swap their contents run the task again',
    why: 'Each file’s content belongs to its path. Swapping two files leaves the same set of contents under other names, and the task’s result can differ (`a` imports `b`, not the reverse). A key over the contents without their paths, or one that sorts them, sees nothing change and replays the old result. The task runs and writes the swapped pairing.',
    from: ['hash-scenarios', 'task-hash-derive'],
    workspace: one(
      task(
        'mkdir -p dist && for f in src/*.txt; do printf "%s=%s" "$f" "$(cat $f)"; done > dist/out.txt',
      ),
      {
        'src/a.txt': '1\n',
        'src/b.txt': '2\n',
      },
    ),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [OUT]: 'src/a.txt=1src/b.txt=2' } } },
      { write: { [`${A}/src/a.txt`]: '2\n', [`${A}/src/b.txt`]: '1\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'src/a.txt=2src/b.txt=1' } },
      },
    ],
  }),

  defineCase({
    id: 'cache/case-only-rename-reruns',
    category: 'cache',
    kind: 'correctness',
    title: 'Renaming an input to differ only in case runs the task again',
    why: 'On a case-sensitive filesystem `Readme.md` and `README.md` are different files, and a task that lists or imports by name sees a different tree. A tool that folds case in its key, as it might to match a Mac, replays the build of the old name. The task runs and lists the new name.',
    from: ['inputs-moved', 'hash-scenarios-names'],
    workspace: one(task('mkdir -p dist && ls src > dist/out.txt'), { 'src/Name.txt': 'a\n' }),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [OUT]: 'Name.txt\n' } } },
      { sh: 'git mv packages/a/src/Name.txt packages/a/src/NAME.txt' },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'NAME.txt\n' } } },
    ],
  }),

  defineCase({
    id: 'cache/input-directory-renamed-reruns',
    category: 'cache',
    kind: 'correctness',
    title: 'Renaming a directory under the inputs, its files unchanged, runs the task again',
    why: 'A directory’s name is part of every path under it: a route, a module path, a package entry. Moving `src/v1` to `src/v2` keeps every file’s bytes and changes what the task produces. A key over file contents without full paths replays the old build. The task runs and writes the new path.',
    from: ['inputs-moved', 'hash-scenarios'],
    workspace: one(task('mkdir -p dist && cd src && find . -type f | sort > ../dist/out.txt'), {
      'src/v1/a.txt': 'a\n',
    }),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [OUT]: './v1/a.txt\n' } } },
      { sh: 'mv packages/a/src/v1 packages/a/src/v2' },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [OUT]: './v2/a.txt\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/file-replaced-by-link-to-other-content-reruns',
    category: 'inputs',
    kind: 'correctness',
    title: 'An input file replaced by a link to a file with other content runs the task again',
    why: 'A task reading through a link reads the target’s bytes. Swapping a file for a link (a shared config linked in, a vendored file deduplicated) changes what the task reads even though the path stays. A tool that keys the link’s own entry, or skips links, replays the build of the old file. The task runs and writes the target’s content.',
    from: ['linked-inputs', 'hash-scenarios'],
    workspace: one(task('mkdir -p dist && cat src/a.txt > dist/out.txt'), {
      'src/a.txt': 'file\n',
      'src/other.txt': 'other\n',
    }),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [OUT]: 'file\n' } } },
      { write: { [`${A}/src/a.txt`]: null } },
      { link: { [`${A}/src/a.txt`]: 'other.txt' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'other\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/link-replaced-by-file-reruns',
    category: 'inputs',
    kind: 'correctness',
    title: 'An input link replaced by a plain file with other content runs the task again',
    why: 'Undoing a link (vendoring a file that was shared) puts new bytes at the same path. A tool that remembers the path as a link and keys its target string, or the target file, misses that the content now lives in the file itself. The task runs and writes the file’s content.',
    from: ['linked-inputs', 'hash-scenarios'],
    workspace: one(task('mkdir -p dist && cat src/a.txt > dist/out.txt'), {
      'src/target.txt': 'target\n',
      'src/b.txt': 'b\n',
    }),
    steps: [
      { link: { [`${A}/src/a.txt`]: 'target.txt' } },
      { run: 'build', expect: { exit: 0, files: { [OUT]: 'target\n' } } },
      { write: { [`${A}/src/a.txt`]: null } },
      { write: { [`${A}/src/a.txt`]: 'plain\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'plain\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/edit-through-a-hard-link-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'An edit made through a hard link outside the inputs reruns the task reading the other name',
    why: 'Two hard links are one file: writing through either changes both, and the input’s path never appears in the write. A tool that watches or stats only the paths written, or caches a file’s hash by the path that changed, keeps the input’s old hash and replays a stale build. The task runs and writes the new content.',
    from: ['hash-scenarios', 'linked-inputs'],
    workspace: one(task('mkdir -p dist && cat src/a.txt > dist/out.txt'), { 'src/a.txt': 'one\n' }),
    steps: [
      { sh: 'mkdir -p packages/a/notes && ln packages/a/src/a.txt packages/a/notes/a.txt' },
      { run: 'build', expect: { exit: 0, files: { [OUT]: 'one\n' } } },
      { sh: 'printf "two\\n" > packages/a/notes/a.txt' },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'two\n' } } },
    ],
  }),

  defineCase({
    id: 'cache/input-deleted-and-recreated-replays',
    category: 'cache',
    kind: 'efficiency',
    title: 'An input deleted and written again with the same bytes replays the task',
    why: 'A checkout or a formatter often deletes a file and writes it back unchanged. Its bytes and path are what they were, so the result is too. A tool that keys a file’s inode or times reruns for nothing on every such touch. The run replays.',
    from: ['hash-scenarios', 'cache'],
    workspace: one(task('mkdir -p dist && cat src/a.txt > dist/out.txt')),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/src/a.txt`]: null } },
      { write: { [`${A}/src/a.txt`]: 'a\n' } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'], files: { [OUT]: 'a\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/empty-directory-added-replays',
    category: 'inputs',
    kind: 'efficiency',
    title: 'An empty directory created under the inputs replays the task',
    why: 'Git does not track directories, and an input glob over files matches no empty one. Creating an empty folder (an editor’s scratch, a tool’s placeholder) changes no file the task reads. A tool that keys directories reruns for nothing. The run replays.',
    from: ['output-empty-dir', 'hash-scenarios'],
    workspace: one(task('mkdir -p dist && cat src/a.txt > dist/out.txt')),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { sh: 'mkdir -p packages/a/src/empty/deeper' },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'inputs/file-emptied-reruns',
    category: 'inputs',
    kind: 'correctness',
    title: 'An input emptied to zero bytes runs the task again',
    why: 'An empty file is a real state: a truncated config, an emptied fixture. A tool that treats an empty file as absent, or skips zero-length files when hashing, keys the same before and after deleting every byte of one, and replays the old result. The task runs and writes nothing from the file.',
    from: ['hash-scenarios', 'cache'],
    workspace: one(task('mkdir -p dist && cat src/a.txt src/b.txt > dist/out.txt'), {
      'src/a.txt': 'a\n',
      'src/b.txt': 'b\n',
    }),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [OUT]: 'a\nb\n' } } },
      { write: { [`${A}/src/a.txt`]: '' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'b\n' } } },
    ],
  }),

  defineCase({
    id: 'cache/one-of-two-thousand-inputs-edited-reruns',
    category: 'cache',
    kind: 'correctness',
    title: 'One edited file among two thousand inputs runs the task again',
    why: 'A large project’s key covers thousands of files, and tools take shortcuts there: hashing only a sample, trusting a directory’s time, stopping at a size limit. An edit to one file deep in the list must still change the key. The task runs and writes the new content.',
    from: ['hash-scenarios', 'inputs-resolution'],
    workspace: one(task('mkdir -p dist && cat src/d/1999.txt > dist/out.txt')),
    steps: [
      {
        sh: 'mkdir -p packages/a/src/d && i=0; while [ $i -lt 2000 ]; do echo $i > packages/a/src/d/$i.txt; i=$((i+1)); done',
      },
      { commit: 'many' },
      { run: 'build', expect: { exit: 0, files: { [OUT]: '1999\n' } } },
      { write: { [`${A}/src/d/1999.txt`]: 'edited\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'edited\n' } } },
    ],
  }),

  // task-hasher.spec.ts should hash tasks where the project has dependencies
  defineCase({
    id: 'env/dependency-variable-change-reaches-dependant',
    category: 'env',
    kind: 'correctness',
    title: 'A variable keying a dependency’s build reaches the dependant that reads its output',
    why: 'The dependency writes the variable’s value into its output, and the dependant copies that output. When the value changes, the dependency rebuilds, and so must everything built on what it wrote. A tool that keys the dependant on the dependency’s files but not its variables replays the dependant with the old value inside. The dependant holds the new value.',
    from: ['env', 'dependency-outputs-there'],
    needs: ['env-inputs'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: task('mkdir -p dist && printf "%s\\n" "$MODE" > dist/out.txt', {
              env: ['MODE'],
            }),
          },
          files: { 'src/a.txt': 'l\n' },
        },
        app: {
          deps: ['lib'],
          tasks: {
            build: task('mkdir -p dist && cat ../lib/dist/out.txt src/a.txt > dist/out.txt', {
              dependsOn: ['^build'],
            }),
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        env: { MODE: 'one' },
        expect: { exit: 0, files: { 'packages/app/dist/out.txt': 'one\napp\n' } },
      },
      {
        run: 'build',
        env: { MODE: 'two' },
        expect: {
          exit: 0,
          ran: ['lib#build'],
          files: { 'packages/app/dist/out.txt': 'two\napp\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'env/sibling-task-variable-change-replays',
    category: 'env',
    kind: 'efficiency',
    title: 'A variable one task declares does not rerun the project’s other task',
    why: 'Each task declares what keys it. A `build` keyed on `MODE` beside a `test` that never reads it are two keys. A tool that keys a variable for the whole project reruns every task of it whenever one task’s variable moves. `test` replays.',
    from: ['env', 'hash-scenarios-names'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: task('mkdir -p dist && printf "%s" "$MODE" > dist/out.txt', { env: ['MODE'] }),
            test: task('mkdir -p out && cat src/a.txt > out/t.txt', { outputs: ['out/**'] }),
          },
          files: { 'src/a.txt': 'a\n', '.gitignore': 'out\n' },
        },
      },
    },
    steps: [
      { run: 'build', also: ['test'], env: { MODE: 'one' }, expect: { exit: 0 } },
      { run: 'test', env: { MODE: 'two' }, expect: { exit: 0, notRan: ['a#test'] } },
    ],
    needs: ['env-inputs', 'multi-task'],
  }),

  defineCase({
    id: 'env/other-project-variable-change-replays',
    category: 'env',
    kind: 'efficiency',
    title: 'A variable one project’s task declares does not rerun another project’s task',
    why: 'A variable keys the tasks that declare it, wherever the run sets it. A tool that folds every declared variable of the workspace into every task makes an unrelated project rebuild whenever another project’s setting changes. The other project replays.',
    from: ['env', 'hash-scenarios-names'],
    needs: ['env-inputs'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: task('mkdir -p dist && printf "%s" "$MODE" > dist/out.txt', { env: ['MODE'] }),
          },
          files: { 'src/a.txt': 'a\n' },
        },
        b: {
          tasks: {
            build: task('mkdir -p dist && cat src/a.txt > dist/out.txt', { env: ['OTHER'] }),
          },
          files: { 'src/a.txt': 'b\n' },
        },
      },
    },
    steps: [
      { run: 'build', env: { MODE: 'one' }, expect: { exit: 0 } },
      {
        run: 'build',
        env: { MODE: 'two' },
        expect: { exit: 0, ran: ['a#build'], notRan: ['b#build'] },
      },
    ],
  }),

  // final_hash_contract.rs env_mode_hashes
  envValues(
    'value-trailing-newline-keys',
    'A declared value with a trailing newline is not the same as the value without it',
    'A value read from a file (`MODE=$(cat mode)`) keeps or loses its newline depending on how it was set, and a program reading it sees the difference. A tool that trims values before keying replays the result built from the other one. The second run runs and writes the newline.',
    'x',
    'x\n',
  ),
  envValues(
    'value-trailing-space-keys',
    'A declared value with a trailing space is not the same as the value without it',
    'Spaces are bytes of the value: a path, a flag list, a token. A tool that trims or normalises whitespace before keying replays the result built from the other spelling, though the program sees a different value. The second run runs and writes the space.',
    'x',
    'x ',
  ),
  envValues(
    'value-of-spaces-is-not-empty',
    'A declared value of spaces is not the same as an empty value',
    'An empty value and one of spaces are different strings, and programs treat them differently (`[ -n "$X" ]`). A tool that trims before keying folds them into one key and replays one’s result for the other. The second run runs.',
    '',
    '  ',
  ),
  envValues(
    'value-case-change-keys',
    'A declared value that changes only in letter case runs the task again',
    'Values are case-sensitive: `production` and `Production` are different to every program comparing them. A tool that lowercases values before keying, as it might for names on Windows, replays the other spelling’s result. The second run runs.',
    'production',
    'Production',
  ),
  envValues(
    'value-with-equals-and-quotes-keys',
    'Declared values that differ only after an `=` or inside quotes key different results',
    'Values carry `=` and quotes: a connection string, a JSON blob, `KEY=VAL` pairs. A tool that writes `NAME=VALUE` lines into its key and splits them again at the first `=`, or strips quotes, folds different values into one. The second run runs.',
    'a=b"c"',
    'a=b"d"',
  ),

  defineCase({
    id: 'env/long-value-reaches-and-keys',
    category: 'env',
    kind: 'correctness',
    title:
      'A 60 KB declared value reaches the task whole, and a change to its last byte runs it again',
    why: 'Variables carry large payloads: a JSON config, a certificate, a list of files. A tool that truncates values in its key, or hashes only a prefix, replays a result built from another value once two values share a long start. The task sees every byte, and the second run runs.',
    from: ['env', 'hash-scenarios-names'],
    needs: ['env-inputs'],
    workspace: one(
      task(
        'mkdir -p dist && printf "%s" "$MODE" | wc -c > dist/len.txt && printf "%s" "$MODE" | tail -c 1 > dist/out.txt',
        { env: ['MODE'] },
      ),
    ),
    steps: [
      {
        run: 'build',
        env: { MODE: `${'x'.repeat(60000)}a` },
        expect: { exit: 0, files: { [OUT]: 'a' } },
      },
      {
        run: 'build',
        env: { MODE: `${'x'.repeat(60000)}b` },
        expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'b' } },
      },
    ],
  }),
]
