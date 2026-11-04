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

const COLLIDING: [string, string, string, Writer, Writer][] = [
  [
    'identical-glob',
    'Two unordered tasks declaring the same output pattern',
    'Two tasks that declare the same output pattern both claim every file under `dist`, with no order between them. A tool that clears a task’s outputs before running it, or restores its entry as the whole of `dist`, deletes the other task’s file. The run still reports green, and the missing file shows up only later. Refusing the pair up front is as good as keeping both.',
    { file: 'dist/x.txt', outputs: ['dist/**'] },
    { file: 'dist/y.txt', outputs: ['dist/**'] },
  ],
  [
    'glob-over-literal',
    'An output pattern that covers another task’s output file',
    '`dist/**` covers `dist/app.js`, so the second task’s file sits inside the first task’s outputs. When the first task reruns or restores, a tool that resets all of `dist` to its own entry wipes `dist/app.js` without any error. The bundle then goes missing from a green build. Refusing the pair is as good as keeping both; dropping one silently is not.',
    { file: 'dist/x.txt', outputs: ['dist/**'] },
    { file: 'dist/app.js', outputs: ['dist/app.js'] },
  ],
  [
    'dir-over-file',
    'An output directory named outright that holds another task’s output file',
    'Naming `dist` outright claims everything below it, including `dist/sub/deep.txt`, which another task writes. A tool that replaces the whole directory on a rerun or restore deletes that file, and nothing reports it. A later step that reads it fails, far from the cause. The overlap must be refused, or both files kept.',
    { file: 'dist/x.txt', outputs: ['dist'] },
    { file: 'dist/sub/deep.txt', outputs: ['dist/sub/deep.txt'] },
  ],
  [
    'globs-meeting',
    'Two output patterns that both match a file one of the tasks writes',
    '`dist/**/*.js` also matches `dist/x.js`, the other task’s file, while `dist/*.js` covers only its own level. Overlap is easy to miss when two patterns look different. A tool that clears or restores by pattern can delete the other task’s file under a green run. Refusing the pair, or keeping both files, are the two safe answers.',
    { file: 'dist/x.js', outputs: ['dist/*.js'] },
    { file: 'dist/sub/y.js', outputs: ['dist/**/*.js'] },
  ],
  [
    'brace-over-literal',
    'A brace output pattern that names another task’s output file',
    '`dist/{a,b}.txt` names `dist/a.txt`, which the other task writes, as well as its own task’s file. A tool that clears or restores everything a pattern names can delete or roll back the other task’s output while the run stays green. A brace set hides overlap from a quick read, so the tool has to expand it. It may refuse the pair or keep both files, never lose one.',
    { file: 'dist/b.txt', outputs: ['dist/{a,b}.txt'] },
    { file: 'dist/a.txt', outputs: ['dist/a.txt'] },
  ],
]

const DISJOINT: [string, string, string, Writer, Writer][] = [
  [
    'distinct-literals',
    'Two tasks writing distinct files into one directory',
    'Two tasks writing `dist/vx-linux` and `dist/vx-darwin` share a directory but no file, a common layout for per-platform builds. A tool that treats a shared parent directory as a clash refuses a build that works. One that clears the directory before a task runs loses the other binary. Each task should keep and restore exactly its own file.',
    { file: 'dist/vx-linux', outputs: ['dist/vx-linux'] },
    { file: 'dist/vx-darwin', outputs: ['dist/vx-darwin'] },
  ],
  [
    'disjoint-subdirs',
    'Two tasks writing sibling subdirectories of one directory',
    '`dist/a/**` and `dist/b/**` are sibling trees with nothing in common, a normal layout with one subdirectory per task. A tool that judges overlap by the shared `dist` parent refuses a build that works. One that restores `dist` as a whole erases the sibling. Both tasks must build, cache and restore side by side.',
    { file: 'dist/a/x.txt', outputs: ['dist/a/**'] },
    { file: 'dist/b/y.txt', outputs: ['dist/b/**'] },
  ],
  [
    'glob-beside-unmatched-literal',
    'A pattern and a file it does not match in one directory',
    '`dist/vx-*` does not match `dist/other.txt`, so the two tasks own different files in one directory. A tool that compares directory prefixes instead of matching the pattern sees a clash that is not there and refuses a working build. A restore of either task must leave the other file in place. Overlap is judged by what the patterns match.',
    { file: 'dist/vx-linux', outputs: ['dist/vx-*'] },
    { file: 'dist/other.txt', outputs: ['dist/other.txt'] },
  ],
  [
    'one-level-glob-beside-subtree',
    'A one-level pattern beside another task’s subdirectory',
    '`dist/*.js` matches files directly in `dist`, not in `dist/sth`, so the other task’s `dist/sth/y.js` is outside it. A tool that reads `*` as crossing directories sees overlap and refuses a working build, or deletes the other task’s file when it restores. `*` stops at a slash, as in a shell.',
    { file: 'dist/x.js', outputs: ['dist/*.js'] },
    { file: 'dist/sth/y.js', outputs: ['dist/sth/**'] },
  ],
  [
    'negation-takes-back',
    'A pattern whose `!` entry leaves out the other task’s file',
    'The `!dist/y.txt` entry takes the other task’s file out of `dist/**`, so the two tasks no longer share a path. Negations are how a config narrows a wide pattern on purpose. A tool that ignores them refuses a build that works, or clears `dist/y.txt` when the first task restores. Explicit config beats the broad match.',
    { file: 'dist/x.txt', outputs: ['dist/**', '!dist/y.txt'] },
    { file: 'dist/y.txt', outputs: ['dist/y.txt'] },
  ],
  [
    'file-and-its-map',
    'A file output and another task’s file whose name extends it',
    '`dist/app.js` and `dist/app.js.map` are two files, even though one name starts with the other. A tool that checks overlap by string prefix takes them for one path and refuses a common layout: a bundle and its source map built by separate tasks. Paths should be compared by whole segments, not by characters.',
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
  [
    'subdir',
    'adds a subdirectory',
    ['dist/individual'],
    'Here the second task declares only `dist/individual`, inside the first task’s `dist`.',
  ],
  [
    'same-tree',
    'declares the same tree',
    ['dist'],
    'Here both tasks declare all of `dist`, so only what each one wrote tells their files apart.',
  ],
] as const

export const outputsShared = [
  ...COLLIDING.map(([slug, what, why, x, y]) =>
    defineCase({
      id: `outputs/unordered-overlap-${slug}`,
      category: 'outputs',
      kind: 'correctness',
      title: `${what}: neither loses its file`,
      why,
      from: ['output-collision'],
      workspace: pair(x, y),
      steps: bothKept(x.file, y.file, true),
    }),
  ),

  ...DISJOINT.map(([slug, what, why, x, y]) =>
    defineCase({
      id: `outputs/disjoint-${slug}`,
      category: 'outputs',
      kind: 'correctness',
      title: `${what} build, cache and restore side by side`,
      why,
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
    why: 'Tasks that write different files are independent, so editing one task’s sources reruns only that task. Here both write into `dist`, but only `x` changed. A tool that ties the two together through the shared directory rebuilds `y` for nothing on every edit. Each task’s key should depend on its own inputs only.',
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

  ...SHAPES.flatMap(([shape, what, outputs, note]) => [
    defineCase({
      id: `outputs/addition-${shape}-warm`,
      category: 'outputs',
      kind: 'correctness',
      title: `A task that ${what} of the task before it: a warm run leaves the cold run’s tree`,
      why: `When one task adds files to another’s output tree after it, a warm run must leave the tree a cold run of both leaves. A tool that restores the first task’s entry as the whole of \`dist\` wipes the second task’s files, then replays the second without putting them back. The build is green and incomplete. ${note}`,
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
      why: `With nothing changed, all three tasks should replay. A shared output tree can make a tool see the second task’s files as damage to the first task’s outputs, so it reruns the first, then the second, on every build. That repeats work no edit asked for. ${note}`,
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
      why: `The second task’s cache entry should hold only what it added, not the first task’s files. After an edit to the first task, a fresh build writes new bytes, and an entry that also held the first task’s files would restore the old ones over them. The tree then mixes old and new output under a green run. ${note}`,
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
      why: `Editing the second task’s sources reruns it, and its new file must land beside the first task’s files. A tool that clears the shared tree before the rerun, or restores the first task over it afterwards, loses one side. The result should match a cold run of both commands. ${note}`,
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
      why: `Undoing an edit brings back sources built before, so their cached result must restore. The second task’s earlier file has to come back next to the first task’s files, which stay untouched. A tool that restores the second entry as the whole tree, or skips it because the tree looks current, leaves the wrong bytes. ${note}`,
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
    why: 'When a later task deletes a file from an earlier task’s outputs, a warm run must end without it, as a cold run does. Replaying the earlier task brings the file back. The later task must then remove it again, or its run must not be replayed while the file is there. Otherwise a temporary file ships with every warm build.',
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
    why: 'When a later task rewrites an earlier task’s output, every run must end with the later bytes. Here the rewrite keeps the length and pins the mtime, as reproducible builds do. A tool that judges files by size and mtime alone takes the rewritten file for the earlier task’s own, and the old bytes win. Only the content tells them apart.',
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
