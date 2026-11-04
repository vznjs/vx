// What a task's key must see in its inputs (bytes, not stamps or sizes),
// and what it must not: a sibling task's gitignored output.
import { defineCase, type TaskSpec, type WorkspaceSpec } from '../src/spec.ts'
import { CONCAT, one, out } from './shapes.ts'

const cached: TaskSpec = { command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] }
const A = 'packages/a'
const MB2 = 2 * 1024 * 1024

/** `build` writes dist, gitignored; `test` reads every file of the project. */
function reader(files: Record<string, string> = {}, root?: Record<string, string>): WorkspaceSpec {
  return {
    projects: {
      a: {
        tasks: {
          build: {
            command: 'mkdir -p dist && cp src/a.txt dist/a.txt',
            inputs: ['src/**'],
            outputs: ['**/dist/**'],
          },
          test: {
            command: 'mkdir -p ../../report && cat dist/a.txt > ../../report/a.txt',
            dependsOn: ['build'],
            inputs: ['**/*'],
            outputs: [],
          },
        },
        files: { 'src/a.txt': 'A1\n', ...files },
      },
    },
    ...(root ? { files: root } : {}),
  }
}

/** The harness's ignore list without `dist`, so a case can say where dist is ignored. */
const IGNORE_NO_DIST = ['node_modules', '.home', '.ran', '.turbo', '.nx', '.vx/cache', 'report', '']
const ignoreWith = (extra: string[] = []) =>
  [...IGNORE_NO_DIST.slice(0, -1), ...extra, ''].join('\n')

const WHERE: [string, string, WorkspaceSpec][] = [
  ['root', 'the workspace’s .gitignore', reader({}, { '.gitignore': ignoreWith(['dist']) })],
  [
    'between',
    'a .gitignore between the root and the project',
    reader({}, { '.gitignore': ignoreWith(), 'packages/.gitignore': 'dist\n' }),
  ],
  [
    'project',
    'the project’s own .gitignore',
    reader({ '.gitignore': 'dist/\n' }, { '.gitignore': ignoreWith() }),
  ],
  [
    'info-exclude',
    '.git/info/exclude',
    reader({}, { '.gitignore': ignoreWith(), '.git/info/exclude': 'dist/\n' }),
  ],
]

export const cacheKeys = [
  defineCase({
    id: 'cache/same-size-edit-reruns',
    category: 'cache',
    kind: 'correctness',
    title: 'An edit that keeps a source’s length, right after a run, runs the task again',
    why: 'A cache key must come from a file’s bytes, not its size or timestamp. An edit that keeps the length, right after a run, can leave both the size and a coarse mtime unchanged. A runner that trusts them replays the old output, and the developer tests or ships a build that does not match the source.',
    from: ['cache'],
    workspace: one(cached, { 'src/a.txt': 'one\n' }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/src/a.txt`]: 'two\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'two\n' } } },
    ],
  }),

  defineCase({
    id: 'cache/identical-rewrite-replays',
    category: 'cache',
    kind: 'efficiency',
    title: 'Writing a source again with the same bytes replays the task',
    why: 'A key built from content does not change when a file is written again with the same bytes. Formatters, branch switches and code generators often touch files without changing them. If a moved mtime alone reran the task, the cache would miss after every checkout or save, and CI would redo work whose result is already stored.',
    from: ['cache'],
    workspace: one(cached),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/src/a.txt`]: 'a\n' } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'cache/empty-file-added-reruns',
    category: 'cache',
    kind: 'correctness',
    title: 'Adding an empty file under the inputs runs the task again',
    why: 'Which files exist under the inputs is input too, even when a file is empty. A command such as `ls`, a bundler’s glob or a test runner looking for test files reads the list of names. If an empty file changed no key, the runner would replay output that misses the new file, and nothing would warn.',
    from: ['cache'],
    workspace: one({
      command: 'mkdir -p dist && ls src > dist/out.txt',
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/src/b.txt`]: '' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'a.txt\nb.txt\n' } },
      },
    ],
  }),

  defineCase({
    id: 'cache/binary-byte-edit-reruns',
    category: 'cache',
    kind: 'correctness',
    title: 'Changing one byte in the middle of a binary input runs the task again',
    why: 'Inputs are bytes, and a binary file must be hashed as bytes. A runner that reads it as text, stops at a zero byte or normalises its encoding can see two different files as one. A changed image, font or compiled asset would then replay the old output, and the shipped build would carry the old file.',
    from: ['cache'],
    workspace: one(
      {
        command: 'mkdir -p dist && cp src/bin.dat dist/out.bin',
        inputs: ['src/**'],
        outputs: ['dist/**'],
      },
      { 'src/bin.dat': '\u0000\u0001\u0002\u0003ÿþ\u0000\u0000' },
    ),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/src/bin.dat`]: '\u0000\u0001\u0002\u0003ÿý\u0000\u0000' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['a#build'],
          files: { [`${A}/dist/out.bin`]: '\u0000\u0001\u0002\u0003ÿý\u0000\u0000' },
        },
      },
    ],
  }),

  defineCase({
    id: 'cache/large-file-tail-edit-reruns',
    category: 'cache',
    kind: 'correctness',
    title: 'Changing the last byte of a 2 MB input runs the task again',
    why: 'A key must cover the whole of every input, not a prefix or a sample. Hashing only the start of a large file is cheaper, but a change at its end, such as an appended record or a data table’s last row, goes unseen. The runner replays output built from the old file, and the change never reaches the build.',
    from: ['cache'],
    workspace: one(
      {
        command: 'mkdir -p dist && tail -c 1 src/big.txt > dist/out.txt',
        inputs: ['src/**'],
        outputs: ['dist/**'],
      },
      { 'src/big.txt': 'A'.repeat(MB2) },
    ),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'A' } } },
      { write: { [`${A}/src/big.txt`]: `${'A'.repeat(MB2 - 1)}B` } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'B' } } },
    ],
  }),

  defineCase({
    id: 'env/value-equal-to-name-vs-unset',
    category: 'env',
    kind: 'correctness',
    title: 'A declared variable set to its own name is not the same as the variable unset',
    why: 'A declared variable’s key must tell an unset variable apart from every value it can take. A key that writes the name in place of a missing value makes `MODE=MODE` and no `MODE` look the same. The second run then replays `unset` where the command should print `MODE`. Name and value must be encoded so that no value can stand in for absence.',
    from: ['cache'],
    needs: ['env-inputs'],
    workspace: one({
      command: 'mkdir -p dist && echo "${MODE-unset}" > dist/out.txt',
      inputs: ['src/**'],
      env: ['MODE'],
      outputs: ['dist/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'unset\n' } } },
      { run: 'build', env: { MODE: 'MODE' }, expect: { exit: 0, files: { [out('a')]: 'MODE\n' } } },
    ],
  }),

  ...WHERE.map(([slug, where, workspace]) =>
    defineCase({
      id: `cache/ignored-output-not-input-${slug}`,
      category: 'cache',
      kind: 'efficiency',
      title: `A task reading every project file replays though a sibling task wrote its gitignored output: ignored in ${where}`,
      why: `A gitignored file is local state, not source, so it is not an input even of a task that reads every project file. Here the build writes \`dist\`, ignored in ${where}. Git does not list it, and a runner that hashes it anyway reruns the reader after every build, so the test never replays. Ignores count wherever git reads them.`,
      from: ['ignored-outputs'],
      workspace,
      steps: [
        { run: 'test', expect: { exit: 0, files: { 'report/a.txt': 'A1\n' } } },
        { run: 'test', expect: { exit: 0, notRan: ['a#build', 'a#test'] } },
      ],
    }),
  ),

  defineCase({
    id: 'cache/ignored-output-reader-sees-new-build',
    category: 'cache',
    kind: 'correctness',
    title: 'A task reading every project file runs again when the build it depends on changes',
    why: 'Leaving an ignored output out of the key must not hide a change behind it. The reader depends on the build, so its key folds in the build’s own inputs. When `src/a.txt` changes, the build’s key changes and the reader must run again on the new output. Otherwise the test passes against the old build while the source has moved on.',
    from: ['ignored-outputs'],
    workspace: WHERE[0]![2],
    steps: [
      { run: 'test', expect: { exit: 0 } },
      { write: { [`${A}/src/a.txt`]: 'A2\n' } },
      { run: 'test', expect: { exit: 0, files: { 'report/a.txt': 'A2\n' } } },
    ],
  }),
]
