// Symlinks in and around outputs: links a task makes, links a user leaves
// where outputs go, and links that lead into git's metadata.
import { defineCase, type TaskSpec } from '../src/spec.ts'
import { CONCAT, one } from './shapes.ts'

const A = 'packages/a'

/** 320,000 bytes of hex no compressor shrinks much: kept apart from a small entry. */
const BIG = (() => {
  let x = 7
  let s = ''
  for (let i = 0; i < 40_000; i++) {
    x = (Math.imul(x, 1_103_515_245) + 12_345) >>> 0
    s += x.toString(16).padStart(8, '0')
  }
  return s
})()

/** What git itself needs to stay a repository. */
const REPO = { dirs: ['.git/objects', '.git/refs'] }
const HEAD = { '.git/HEAD': 'ref: refs/heads/main\n' }

const linkedHead = (outputs: string[]): TaskSpec => ({
  command: 'mkdir -p build && cat src/a.txt > build/a.js',
  inputs: ['src/**'],
  outputs,
})

export const outputsLinks = [
  defineCase({
    id: 'outputs/link-into-workspace-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output symlink to a file elsewhere in the workspace comes back as the same link',
    from: ['deferred-output-link'],
    workspace: {
      ...one({
        command: `${CONCAT} && ln -s ../../../shared/x.txt dist/x`,
        inputs: ['src/**'],
        outputs: ['dist/**'],
      }),
      files: { 'shared/x.txt': 'x\n' },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist`]: null } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/dist/x`]: 'x\n' } } },
      { check: { links: { [`${A}/dist/x`]: '../../../shared/x.txt' } } },
    ],
  }),

  defineCase({
    id: 'outputs/link-beside-large-file-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'A symlink output beside a large file restores both',
    from: ['ingest-output-link'],
    workspace: one(
      {
        command: 'mkdir -p dist && cp src/big.txt dist/big.bin && ln -s big.bin dist/link',
        inputs: ['src/**'],
        outputs: ['dist/**'],
      },
      { 'src/big.txt': BIG },
    ),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist`]: null } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/dist/big.bin`]: BIG } },
      },
      { check: { links: { [`${A}/dist/link`]: 'big.bin' } } },
    ],
  }),

  ...(
    [
      [
        'linked-output-dir',
        ['dist/**'],
        'An output directory that is a symlink is cached through it',
      ],
      [
        'linked-output-dir-beside-wide-glob',
        ['dist/**', '**/*.tsbuildinfo'],
        'An output directory that is a symlink is cached through it beside a `**` pattern',
      ],
      [
        'linked-output-dir-file-glob',
        ['dist/**/*.js'],
        'A file pattern under an output directory that is a symlink is cached through it',
      ],
    ] as const
  ).map(([slug, outputs, title]) =>
    defineCase({
      id: `outputs/${slug}`,
      category: 'outputs',
      kind: 'correctness',
      title,
      why: 'The user declared `dist`; that it is a link to `build` inside the project changes nothing a build writes.',
      from: ['output-glob-links', 'output-scan-root'],
      workspace: one(linkedHead([...outputs])),
      steps: [
        { link: { [`${A}/dist`]: 'build' } },
        { run: 'build', expect: { exit: 0, files: { [`${A}/dist/a.js`]: 'a\n' } } },
        { write: { [`${A}/build/a.js`]: null } },
        {
          run: 'build',
          expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/build/a.js`]: 'a\n' } },
        },
        { check: { links: { [`${A}/dist`]: 'build' } } },
      ],
    }),
  ),

  defineCase({
    id: 'outputs/link-into-nested-project-untouched',
    category: 'outputs',
    kind: 'correctness',
    title:
      'An output path that is a link into a nested project never deletes or overwrites that project’s files',
    why: 'Project boundaries hold through a link: the nested project’s build is its own.',
    from: ['output-glob-links'],
    needs: ['filter'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'mkdir -p out && cat src/a.txt > out/a.txt',
              inputs: ['src/**'],
              outputs: ['out/**', 'docs/**'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
        site: {
          dir: 'packages/a/site',
          tasks: {
            build: {
              command: 'mkdir -p dist && echo site > dist/index.html',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/s.txt': 's\n' },
        },
      },
    },
    steps: [
      { link: { [`${A}/docs`]: 'site/dist' } },
      { run: 'build', projects: ['site'], expect: { exit: 0 } },
      { run: 'build', projects: ['a'], expect: { exit: 0 } },
      { write: { [`${A}/site/dist/index.html`]: 'kept\n', [`${A}/src/a.txt`]: 'b\n' } },
      {
        run: 'build',
        projects: ['a'],
        expect: { exit: 0, files: { [`${A}/site/dist/index.html`]: 'kept\n' } },
      },
      { write: { [`${A}/src/a.txt`]: 'a\n', [`${A}/out`]: null } },
      {
        run: 'build',
        projects: ['a'],
        expect: {
          exit: 0,
          files: { [`${A}/out/a.txt`]: 'a\n', [`${A}/site/dist/index.html`]: 'kept\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/link-inside-outputs-to-git-not-followed',
    category: 'outputs',
    kind: 'correctness',
    title: 'A link into .git left inside an output directory never empties the repository',
    why: 'Clearing an output directory removes a link in it; following it deletes git’s metadata.',
    from: ['output-clean-link-git'],
    workspace: one({ command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { link: { [`${A}/dist/g`]: '../../../.git' } },
      { write: { [`${A}/src/a.txt`]: 'b\n' } },
      { run: 'build', expect: { exit: 0, files: HEAD } },
      { check: REPO },
      { write: { [`${A}/src/a.txt`]: 'a\n' } },
      { run: 'build', expect: { exit: 0, files: HEAD } },
      { check: REPO },
    ],
  }),

  defineCase({
    id: 'outputs/output-dir-linked-to-git',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output directory that is a link into .git never empties the repository',
    why: 'A tool may refuse the run or write through the link, but clearing `dist/**` through it deletes the repository.',
    from: ['output-clean-link-git'],
    workspace: one({ command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] }),
    steps: [
      { link: { [`${A}/dist`]: '../../.git' } },
      { run: 'build', expect: { files: HEAD } },
      { check: REPO },
      { write: { [`${A}/src/a.txt`]: 'b\n' } },
      { run: 'build', expect: { files: HEAD } },
      { check: REPO },
      { write: { [`${A}/src/a.txt`]: 'a\n' } },
      { run: 'build', expect: { files: HEAD } },
      { check: REPO },
    ],
  }),

  ...(
    [
      ['restore-not-through-link-to-git', '../../../.git', '.git/hooks/pre-commit', 'into .git'],
      [
        'restore-not-through-link-to-new-git-dir',
        '../../../.git/new',
        '.git/new/hooks/pre-commit',
        'to a directory .git does not hold yet',
      ],
    ] as const
  ).map(([slug, target, planted, where]) =>
    defineCase({
      id: `outputs/${slug}`,
      category: 'outputs',
      kind: 'correctness',
      title: `A replay never writes an output through a link ${where}`,
      why: 'An output restored through such a link plants a git hook that runs on the next commit.',
      from: ['restore-link-git'],
      workspace: one({
        command:
          'mkdir -p dist/g/hooks && cat src/a.txt > dist/a.txt && echo planted > dist/g/hooks/pre-commit',
        inputs: ['src/**'],
        outputs: ['dist/**'],
      }),
      steps: [
        { run: 'build', expect: { exit: 0 } },
        { write: { [`${A}/dist/g`]: null } },
        { link: { [`${A}/dist/g`]: target } },
        // Running the command writes through the link itself; only a replay is held to it.
        {
          run: 'build',
          expect: { ifReplayed: { task: 'a#build', files: { [planted]: null } } },
        },
      ],
    }),
  ),
]
