// Two tasks of one project whose outputs meet. Unordered, a tool may refuse
// the pair or keep both tasks' files, never lose one. Ordered by an edge
// (the dependant adds to its upstream's tree), every run leaves the tree a
// cold run of both commands leaves.
import { defineCase, type ProjectSpec, type WorkspaceSpec } from '../src/spec.ts'

const A = 'packages/a'

interface Writer {
  /** The project-relative file the task writes its source into. */
  file: string
  outputs: string[]
}

/** Tasks `x` and `y` with no edge between them, and `all` to run both. */
function pair(x: Writer, y: Writer): WorkspaceSpec {
  const project: ProjectSpec = {
    tasks: {
      x: { command: writes('x', x.file), outputs: x.outputs, inputs: ['srcx/**'] },
      y: { command: writes('y', y.file), outputs: y.outputs, inputs: ['srcy/**'] },
      all: { command: 'true', dependsOn: ['x', 'y'] },
    },
    files: { 'srcx/a.txt': 'x1\n', 'srcy/a.txt': 'y1\n' },
  }
  return { projects: { a: project } }
}

/** `cat srcx/a.txt > <file>` for x, the same for y. */
const writes = (task: 'x' | 'y', file: string): string =>
  `mkdir -p "$(dirname ${file})" && cat src${task}/a.txt > ${file}`

/** Both files survive a cold run, x rerunning alone, and a restore of both. */
function bothKept(xFile: string, yFile: string, orRefused: boolean) {
  const files = (x: string) => ({ [`${A}/${xFile}`]: x, [`${A}/${yFile}`]: 'y1\n' })
  const extra = orRefused ? { orRefused: true } : {}
  return [
    { run: 'all', expect: { exit: 0 as const, files: files('x1\n'), ...extra } },
    { write: { [`${A}/srcx/a.txt`]: 'x2\n' } },
    { run: 'all', expect: { exit: 0 as const, files: files('x2\n'), ...extra } },
    { write: { [`${A}/dist`]: null } },
    { run: 'all', expect: { exit: 0 as const, files: files('x2\n'), ...extra } },
  ]
}

const COLLIDING: [string, string, Writer, Writer][] = [
  [
    'identical-glob',
    'Two unordered tasks declaring the same output pattern',
    { file: 'dist/x.txt', outputs: ['dist/**'] },
    { file: 'dist/y.txt', outputs: ['dist/**'] },
  ],
  [
    'glob-over-literal',
    'An output pattern that covers another task’s output file',
    { file: 'dist/x.txt', outputs: ['dist/**'] },
    { file: 'dist/app.js', outputs: ['dist/app.js'] },
  ],
  [
    'dir-over-file',
    'An output directory named outright that holds another task’s output file',
    { file: 'dist/x.txt', outputs: ['dist'] },
    { file: 'dist/sub/deep.txt', outputs: ['dist/sub/deep.txt'] },
  ],
  [
    'globs-meeting',
    'Two output patterns that both match a file one of the tasks writes',
    { file: 'dist/x.js', outputs: ['dist/*.js'] },
    { file: 'dist/sub/y.js', outputs: ['dist/**/*.js'] },
  ],
  [
    'brace-over-literal',
    'A brace output pattern that names another task’s output file',
    { file: 'dist/b.txt', outputs: ['dist/{a,b}.txt'] },
    { file: 'dist/a.txt', outputs: ['dist/a.txt'] },
  ],
]

const DISJOINT: [string, string, Writer, Writer][] = [
  [
    'distinct-literals',
    'Two tasks writing distinct files into one directory',
    { file: 'dist/vx-linux', outputs: ['dist/vx-linux'] },
    { file: 'dist/vx-darwin', outputs: ['dist/vx-darwin'] },
  ],
  [
    'disjoint-subdirs',
    'Two tasks writing sibling subdirectories of one directory',
    { file: 'dist/a/x.txt', outputs: ['dist/a/**'] },
    { file: 'dist/b/y.txt', outputs: ['dist/b/**'] },
  ],
  [
    'glob-beside-unmatched-literal',
    'A pattern and a file it does not match in one directory',
    { file: 'dist/vx-linux', outputs: ['dist/vx-*'] },
    { file: 'dist/other.txt', outputs: ['dist/other.txt'] },
  ],
  [
    'one-level-glob-beside-subtree',
    'A one-level pattern beside another task’s subdirectory',
    { file: 'dist/x.js', outputs: ['dist/*.js'] },
    { file: 'dist/sth/y.js', outputs: ['dist/sth/**'] },
  ],
  [
    'negation-takes-back',
    'A pattern whose `!` entry leaves out the other task’s file',
    { file: 'dist/x.txt', outputs: ['dist/**', '!dist/y.txt'] },
    { file: 'dist/y.txt', outputs: ['dist/y.txt'] },
  ],
  [
    'file-and-its-map',
    'A file output and another task’s file whose name extends it',
    { file: 'dist/app.js', outputs: ['dist/app.js'] },
    { file: 'dist/app.js.map', outputs: ['dist/app.js.map'] },
  ],
]

/** The edge-ordered pair: `build` fills dist, `individual` adds to it, `noop` follows. */
function addition(individualOutputs: string[]): WorkspaceSpec {
  return {
    sharedOutputs: true,
    projects: {
      a: {
        tasks: {
          build: {
            command: 'mkdir -p dist && cp src/a.txt dist/a.txt && cp src/a.txt dist/a2.txt',
            inputs: ['src/**'],
            outputs: ['dist'],
          },
          individual: {
            command: 'mkdir -p dist/individual && cp srcb/b.txt dist/individual/b.txt',
            dependsOn: ['build'],
            inputs: ['srcb/**'],
            outputs: individualOutputs,
          },
          noop: {
            command: 'true',
            dependsOn: ['individual'],
            inputs: ['srcb/**'],
            outputs: ['dist/noop'],
          },
        },
        files: { 'src/a.txt': 'A1\n', 'srcb/b.txt': 'B1\n' },
      },
    },
  }
}

const tree = (a: string, b: string) => ({
  [`${A}/dist/a.txt`]: a,
  [`${A}/dist/a2.txt`]: a,
  [`${A}/dist/individual/b.txt`]: b,
})

const SHAPES = [
  ['subdir', 'adds a subdirectory', ['dist/individual']],
  ['same-tree', 'declares the same tree', ['dist']],
] as const

export const outputsShared = [
  ...COLLIDING.map(([slug, what, x, y]) =>
    defineCase({
      id: `outputs/unordered-overlap-${slug}`,
      category: 'outputs',
      kind: 'correctness',
      title: `${what}: neither loses its file`,
      why: 'A tool that clears a task’s outputs before it runs or restores deletes the other task’s file under a green run. Refusing the pair up front is as good as keeping both.',
      from: ['output-collision'],
      workspace: pair(x, y),
      steps: bothKept(x.file, y.file, true),
    }),
  ),

  ...DISJOINT.map(([slug, what, x, y]) =>
    defineCase({
      id: `outputs/disjoint-${slug}`,
      category: 'outputs',
      kind: 'correctness',
      title: `${what} build, cache and restore side by side`,
      why: 'Their outputs share no path: refusing the pair breaks a build that works.',
      from: ['output-collision'],
      workspace: pair(x, y),
      steps: bothKept(x.file, y.file, false),
    }),
  ),

  defineCase({
    id: 'outputs/disjoint-edit-reruns-one',
    category: 'outputs',
    kind: 'efficiency',
    title: 'Editing one of two tasks that write distinct files into one directory reruns only it',
    from: ['output-collision'],
    workspace: pair(
      { file: 'dist/vx-linux', outputs: ['dist/vx-linux'] },
      { file: 'dist/vx-darwin', outputs: ['dist/vx-darwin'] },
    ),
    steps: [
      { run: 'all', expect: { exit: 0 } },
      { write: { [`${A}/srcx/a.txt`]: 'x2\n' } },
      { run: 'all', expect: { exit: 0, ran: ['a#x'], notRan: ['a#y'] } },
    ],
  }),

  ...SHAPES.flatMap(([shape, what, outputs]) => [
    defineCase({
      id: `outputs/addition-${shape}-warm`,
      category: 'outputs',
      kind: 'correctness',
      title: `A task that ${what} of the task before it: a warm run leaves the cold run’s tree`,
      from: ['overlapping-outputs', 'output-collision'],
      workspace: addition([...outputs]),
      steps: [
        { run: 'noop', expect: { exit: 0, files: tree('A1\n', 'B1\n') } },
        { run: 'noop', expect: { exit: 0, files: tree('A1\n', 'B1\n') } },
      ],
    }),
    defineCase({
      id: `outputs/addition-${shape}-warm-replays`,
      category: 'outputs',
      kind: 'efficiency',
      title: `A task that ${what} of the task before it: an unchanged tree replays all three`,
      from: ['overlapping-outputs'],
      workspace: addition([...outputs]),
      steps: [
        { run: 'noop', expect: { exit: 0 } },
        { run: 'noop', expect: { exit: 0, notRan: ['a#build', 'a#individual', 'a#noop'] } },
      ],
    }),
    defineCase({
      id: `outputs/addition-${shape}-upstream-edit`,
      category: 'outputs',
      kind: 'correctness',
      title: `A task that ${what} of the task before it: editing the first keeps the second’s file and none of the first’s old bytes`,
      why: 'The second task’s entry holds only what it added; one that held the first task’s files restores their old bytes over the fresh build.',
      from: ['overlapping-outputs'],
      workspace: addition([...outputs]),
      steps: [
        { run: 'noop', expect: { exit: 0 } },
        { write: { [`${A}/src/a.txt`]: 'A2\n' } },
        { run: 'noop', expect: { exit: 0, ran: ['a#build'], files: tree('A2\n', 'B1\n') } },
      ],
    }),
    defineCase({
      id: `outputs/addition-${shape}-dependant-edit`,
      category: 'outputs',
      kind: 'correctness',
      title: `A task that ${what} of the task before it: editing the second rebuilds its file beside the first’s`,
      from: ['overlapping-outputs'],
      workspace: addition([...outputs]),
      steps: [
        { run: 'noop', expect: { exit: 0 } },
        { write: { [`${A}/srcb/b.txt`]: 'B2\n' } },
        { run: 'noop', expect: { exit: 0, files: tree('A1\n', 'B2\n') } },
      ],
    }),
    defineCase({
      id: `outputs/addition-${shape}-dependant-revert`,
      category: 'outputs',
      kind: 'correctness',
      title: `A task that ${what} of the task before it: undoing an edit to the second restores its first file`,
      from: ['overlapping-outputs'],
      workspace: addition([...outputs]),
      steps: [
        { run: 'noop', expect: { exit: 0 } },
        { write: { [`${A}/srcb/b.txt`]: 'B2\n' } },
        { run: 'noop', expect: { exit: 0 } },
        { write: { [`${A}/srcb/b.txt`]: 'B1\n' } },
        { run: 'noop', expect: { exit: 0, files: tree('A1\n', 'B1\n') } },
      ],
    }),
  ]),

  defineCase({
    id: 'outputs/addition-removal-not-undone',
    category: 'outputs',
    kind: 'correctness',
    title: 'A file a later task deletes from an earlier task’s outputs stays deleted on warm runs',
    why: 'A replay of the earlier task brings the file back; the later task must then remove it again, or its run must not be replayed.',
    from: ['overlapping-outputs'],
    workspace: {
      sharedOutputs: true,
      projects: {
        a: {
          tasks: {
            build: {
              command: 'mkdir -p dist && cp src/a.txt dist/a.js && echo mid > dist/tmp.js',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
            post: {
              command: 'rm dist/tmp.js && echo bundle > dist/bundle.js',
              dependsOn: ['build'],
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'A1\n' },
        },
      },
    },
    steps: [0, 1, 2].map(() => ({
      run: 'post',
      expect: {
        exit: 0 as const,
        files: {
          [`${A}/dist/a.js`]: 'A1\n',
          [`${A}/dist/bundle.js`]: 'bundle\n',
          [`${A}/dist/tmp.js`]: null,
        },
      },
    })),
  }),

  defineCase({
    id: 'outputs/addition-same-size-rewrite',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A later task’s same-length rewrite of an earlier task’s output survives warm runs, mtime pinned',
    why: 'Judged by size and mtime alone, the rewrite looks like the earlier task’s file, and its old bytes win.',
    from: ['overlapping-outputs'],
    workspace: {
      sharedOutputs: true,
      projects: {
        a: {
          tasks: {
            build: {
              command:
                'mkdir -p dist && cat src/a.txt > dist/a.txt && touch -t 200101010000 dist/a.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
            types: {
              command:
                'tr a-z A-Z < dist/a.txt > dist/up && cat dist/up > dist/a.txt && rm dist/up && ' +
                'touch -t 200101010000 dist/a.txt && echo t > dist/types.d.ts',
              dependsOn: ['build'],
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'hello\n' },
        },
      },
    },
    steps: [0, 1, 2].map(() => ({
      run: 'types',
      expect: {
        exit: 0 as const,
        files: { [`${A}/dist/a.txt`]: 'HELLO\n', [`${A}/dist/types.d.ts`]: 't\n' },
      },
    })),
  }),
]
