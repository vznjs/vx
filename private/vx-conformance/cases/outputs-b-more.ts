// More of what a task's outputs leave on disk: pairs of tasks whose output
// patterns meet or stay apart (in one project, across projects, at the
// workspace root), strays and damage a hit must undo, names and sizes a
// cache must carry intact, root outputs, retries, and an uncached
// dependency's key.
import {
  defineCase,
  type ProjectSpec,
  type Step,
  type TaskSpec,
  type WorkspaceSpec,
} from '../src/spec.ts'
import { one } from './shapes.ts'

const A = 'packages/a'

/** The harness's root .gitignore, plus `extra`. */
const ignoring = (...extra: string[]): string =>
  ['node_modules', '.home', '.ran', '.turbo', '.nx', '.vx/cache', 'dist', ...extra, ''].join('\n')

// ─── Two tasks whose outputs meet, or do not ─────────────────────────

interface Writer {
  /** The project the task belongs to. */
  project: 'a' | 'b'
  /** Workspace-relative file the task writes its source into. */
  at: string
  outputs?: string[]
  rootOutputs?: string[]
}

/** Tasks `x` and `y` with no edge between them, and `a#all` to run both. */
function pair(x: Writer, y: Writer): WorkspaceSpec {
  const task = (name: 'x' | 'y', w: Writer): TaskSpec => ({
    command: `mkdir -p "$(dirname ../../${w.at})" && cat src${name}/a.txt > ../../${w.at}`,
    inputs: [`src${name}/**`],
    ...(w.outputs ? { outputs: w.outputs } : {}),
    ...(w.rootOutputs ? { rootOutputs: w.rootOutputs } : {}),
  })
  const projects: Record<string, ProjectSpec> = { a: { tasks: {}, files: {} } }
  for (const [name, w] of [
    ['x', x],
    ['y', y],
  ] as const) {
    const p = (projects[w.project] ??= { tasks: {}, files: {} })
    p.tasks![name] = task(name, w)
    p.files![`src${name}/a.txt`] = `${name}1\n`
  }
  const ref = (name: string, w: Writer) => (w.project === 'a' ? name : `${w.project}#${name}`)
  projects['a']!.tasks!['all'] = { command: 'true', dependsOn: [ref('x', x), ref('y', y)] }
  return { projects }
}

/** Both files survive a cold run, x rerunning alone, and a restore of both after `wipe`. */
function bothKept(x: Writer, y: Writer, wipe: string[], orRefused: boolean): Step[] {
  const files = (v: string) => ({ [x.at]: v, [y.at]: 'y1\n' })
  const extra = orRefused ? { orRefused: true } : {}
  return [
    { run: 'all', expect: { exit: 0, files: files('x1\n'), ...extra } },
    { write: { [`packages/${x.project}/srcx/a.txt`]: 'x2\n' } },
    { run: 'all', expect: { exit: 0, files: files('x2\n'), ...extra } },
    { write: Object.fromEntries(wipe.map((p) => [p, null])) },
    { run: 'all', expect: { exit: 0, files: files('x2\n'), ...extra } },
  ]
}

type Pair = [slug: string, what: string, x: Writer, y: Writer, wipe: string[]]

const inA = (at: string, outputs: string[]): Writer => ({ project: 'a', at: `${A}/${at}`, outputs })

const COLLIDING: Pair[] = [
  [
    'dir-slash-over-file',
    'An output directory written with a trailing slash that holds another task’s file',
    inA('dist/x.txt', ['dist/']),
    inA('dist/app.js', ['dist/app.js']),
    [`${A}/dist`],
  ],
  [
    'dot-slash-spelling',
    'One output pattern spelled `./dist/**` and the same pattern spelled `dist/**`',
    inA('dist/x.txt', ['./dist/**']),
    inA('dist/y.txt', ['dist/**']),
    [`${A}/dist`],
  ],
  [
    'question-mark-over-literal',
    'A `?` output pattern that matches another task’s output file',
    inA('dist/ax.txt', ['dist/a?.txt']),
    inA('dist/ab.txt', ['dist/ab.txt']),
    [`${A}/dist`],
  ],
  [
    'prefix-wildcard-over-literal',
    'A `name-*` output pattern that matches another task’s output file',
    inA('dist/vx-all', ['dist/vx-*']),
    inA('dist/vx-linux-x64', ['dist/vx-linux-x64']),
    [`${A}/dist`],
  ],
  [
    'subtree-over-nested-subtree',
    'A whole output tree and another task’s pattern for a directory inside it',
    inA('dist/x.txt', ['dist/**']),
    inA('dist/extra/y.txt', ['dist/extra/**']),
    [`${A}/dist`],
  ],
  [
    'subtree-over-extension-glob',
    'A whole output tree and another task’s pattern for one extension inside it',
    inA('dist/x.txt', ['dist/**']),
    inA('dist/types/y.d.ts', ['dist/**/*.d.ts']),
    [`${A}/dist`],
  ],
  [
    'anywhere-glob-over-subtree',
    'A pattern for one extension anywhere and another task’s output tree holding such a file',
    inA('types/x.d.ts', ['**/*.d.ts']),
    inA('dist/y.d.ts', ['dist/**']),
    [`${A}/dist`, `${A}/types`],
  ],
  [
    'wildcard-directory-over-literal',
    'A pattern with a wildcard directory that matches another task’s output file',
    inA('lib/app.js', ['*/app.js']),
    inA('dist/app.js', ['dist/app.js']),
    [`${A}/dist`, `${A}/lib`],
  ],
  [
    'brace-directory-over-literal',
    'A pattern with a brace set of directories that names another task’s output file',
    inA('dist/app.js', ['{dist,lib}/app.js']),
    inA('lib/app.js', ['lib/app.js']),
    [`${A}/dist`, `${A}/lib`],
  ],
  [
    'patterns-meet-at-one-file',
    'A brace output pattern and a wildcard one that both match the file one task writes',
    inA('build/b.js', ['build/{a,b}.js']),
    inA('build/y.js', ['build/*.js']),
    [`${A}/build`],
  ],
  [
    'partial-negation',
    'A pattern whose `!` entry takes back only part of another task’s output tree',
    inA('lib/dist/x.txt', ['**/dist/**', '!types/x/**']),
    inA('types/dist/y.txt', ['types/**']),
    [`${A}/lib`, `${A}/types`],
  ],
  [
    'root-outputs-across-projects',
    'Two projects’ root output patterns where one covers the other’s file',
    { project: 'a', at: 'shared/a.txt', rootOutputs: ['shared/**'] },
    { project: 'b', at: 'shared/b.txt', rootOutputs: ['shared/b.txt'] },
    ['shared'],
  ],
  [
    'root-output-inside-project-tree',
    'A root output file inside another project’s output tree',
    { project: 'a', at: 'packages/b/dist/a.txt', rootOutputs: ['packages/b/dist/a.txt'] },
    { project: 'b', at: 'packages/b/dist/y.txt', outputs: ['dist/**'] },
    ['packages/b/dist'],
  ],
  [
    'root-output-tree-over-project-file',
    'A root output tree that holds another project’s output file',
    { project: 'a', at: 'packages/b/dist/a.txt', rootOutputs: ['packages/b/dist/**'] },
    { project: 'b', at: 'packages/b/dist/y.txt', outputs: ['dist/y.txt'] },
    ['packages/b/dist'],
  ],
]

const DISJOINT: Pair[] = [
  [
    'two-literal-dirs',
    'Two tasks naming two different output directories outright',
    inA('dist/x.txt', ['dist']),
    inA('build/y.txt', ['build']),
    [`${A}/dist`, `${A}/build`],
  ],
  [
    'dir-beside-longer-name',
    'An output directory and another task’s file in a directory whose name extends it',
    inA('dist/x.txt', ['dist']),
    inA('distant/app.js', ['distant/app.js']),
    [`${A}/dist`, `${A}/distant`],
  ],
  [
    'literal-subdirs',
    'Two tasks naming sibling subdirectories of one directory outright',
    inA('dist/a/x.txt', ['dist/a']),
    inA('dist/b/y.txt', ['dist/b']),
    [`${A}/dist`],
  ],
  [
    'subtree-beside-longer-name',
    'An output tree and another task’s tree in a directory whose name extends it',
    inA('dist/x.txt', ['dist/**']),
    inA('distant/y.txt', ['distant/**']),
    [`${A}/dist`, `${A}/distant`],
  ],
  [
    'subtree-beside-sibling-glob',
    'An output tree and another task’s pattern over a sibling directory',
    inA('dist/a/x.txt', ['dist/a/**']),
    inA('dist/b/y.js', ['dist/b/*.js']),
    [`${A}/dist`],
  ],
  [
    'extension-globs-apart',
    'Two patterns over one tree that take different extensions',
    inA('dist/sub/x.js', ['dist/**/*.js']),
    inA('dist/sub/x.js.map', ['dist/**/*.map']),
    [`${A}/dist`],
  ],
  [
    'tree-beside-deep-glob',
    'An output tree and another task’s deep pattern over another directory',
    inA('lib/x.txt', ['lib/**']),
    inA('dist/sub/y.js', ['dist/**/*.js']),
    [`${A}/dist`, `${A}/lib`],
  ],
  [
    'question-mark-unmatched',
    'A `?` output pattern beside a file it does not match',
    inA('dist/ax.txt', ['dist/a?.txt']),
    inA('dist/zz.txt', ['dist/zz.txt']),
    [`${A}/dist`],
  ],
  [
    'brace-unmatched',
    'A brace output pattern beside a file it does not name',
    inA('dist/a.txt', ['dist/{a,b}.txt']),
    inA('dist/c.txt', ['dist/c.txt']),
    [`${A}/dist`],
  ],
  [
    'odd-spellings-apart',
    'Two sibling output trees spelled `./dist/a/**` and `dist//b/**`',
    inA('dist/a/x.txt', ['./dist/a/**']),
    inA('dist/b/y.txt', ['dist//b/**']),
    [`${A}/dist`],
  ],
  [
    'negation-takes-back-tree',
    'A pattern whose `!` entry takes back another task’s whole output tree',
    inA('lib/dist/x.txt', ['**/dist/**', '!types/**']),
    inA('types/dist/y.txt', ['types/**']),
    [`${A}/lib`, `${A}/types`],
  ],
  [
    'brace-beside-literal',
    'A brace output pattern beside another task’s file in the same directory',
    inA('build/a.js', ['build/{a,b}.js']),
    inA('build/c.js', ['build/c.js']),
    [`${A}/build`],
  ],
  [
    'literal-beside-glob-head',
    'An output tree and another task’s files beside it, one in a directory whose name extends it',
    inA('dist/a/x.txt', ['dist/a/**']),
    inA('dist/ab/c.js', ['dist/ab/c.js', 'dist/b.js']),
    [`${A}/dist`],
  ],
  [
    'root-outputs-distinct',
    'Two projects writing distinct root output files into one directory',
    { project: 'a', at: 'generated/a.ts', rootOutputs: ['generated/a.ts'] },
    { project: 'b', at: 'generated/b.ts', rootOutputs: ['generated/b.ts'] },
    ['generated'],
  ],
  [
    'project-and-root-namespaces',
    'A project output and another project’s root output with the same relative name',
    inA('generated/x.ts', ['generated/x.ts']),
    { project: 'b', at: 'generated/x.ts', rootOutputs: ['generated/x.ts'] },
    [`${A}/generated`, 'generated'],
  ],
  [
    'root-output-beside-project-tree',
    'A root output file in another project, beside that project’s output tree',
    { project: 'a', at: 'packages/b/gen/a.txt', rootOutputs: ['packages/b/gen/a.txt'] },
    { project: 'b', at: 'packages/b/dist/y.txt', outputs: ['dist/**'] },
    ['packages/b/gen', 'packages/b/dist'],
  ],
  [
    'root-output-beside-project-glob',
    'A root output file in another project’s output directory that its pattern does not match',
    { project: 'a', at: 'packages/b/dist/a.txt', rootOutputs: ['packages/b/dist/a.txt'] },
    { project: 'b', at: 'packages/b/dist/y.js', outputs: ['dist/*.js'] },
    ['packages/b/dist'],
  ],
  [
    'root-output-taken-back',
    'A root output file in another project’s output tree that a `!` entry takes back',
    { project: 'a', at: 'packages/b/dist/a.txt', rootOutputs: ['packages/b/dist/a.txt'] },
    { project: 'b', at: 'packages/b/dist/y.txt', outputs: ['dist/**', '!dist/a.txt'] },
    ['packages/b/dist'],
  ],
  [
    'two-projects-one-pattern',
    'Two projects declaring the same project-relative output pattern',
    { project: 'a', at: `${A}/dist/x.txt`, outputs: ['dist/**'] },
    { project: 'b', at: 'packages/b/dist/y.txt', outputs: ['dist/**'] },
    [`${A}/dist`, 'packages/b/dist'],
  ],
]

/** a#up writes a root file under `shared/`; b#down adds its own beside it, after it. */
function rootAddition(): WorkspaceSpec {
  return {
    sharedOutputs: true,
    projects: {
      a: {
        tasks: {
          up: {
            command: 'mkdir -p ../../shared && cat src/a.txt > ../../shared/a.txt',
            inputs: ['src/**'],
            rootOutputs: ['shared/**'],
          },
        },
        files: { 'src/a.txt': 'A1\n' },
      },
      b: {
        tasks: {
          down: {
            command: 'mkdir -p ../../shared && cat src/b.txt > ../../shared/b.txt',
            dependsOn: ['a#up'],
            inputs: ['src/**'],
            rootOutputs: ['shared/b.txt'],
          },
        },
        files: { 'src/b.txt': 'B1\n' },
      },
    },
  }
}

/** b#up fills its dist; a#down adds a root output file into it, after it. */
function intoProjectAddition(): WorkspaceSpec {
  return {
    sharedOutputs: true,
    projects: {
      a: {
        tasks: {
          down: {
            command: 'cat src/a.txt > ../b/dist/a.txt',
            dependsOn: ['b#up'],
            inputs: ['src/**'],
            rootOutputs: ['packages/b/dist/a.txt'],
          },
        },
        files: { 'src/a.txt': 'A1\n' },
      },
      b: {
        tasks: {
          up: {
            command: 'mkdir -p dist && cat src/b.txt > dist/b.txt',
            inputs: ['src/**'],
            outputs: ['dist/**'],
          },
        },
        files: { 'src/b.txt': 'B1\n' },
      },
    },
  }
}

// ─── One task's tree after a hit ─────────────────────────────────────

/** dist/out.js and dist/sub/in.js from src/a.txt. */
const SUBTREE = 'mkdir -p dist/sub && cp src/a.txt dist/out.js && cp src/a.txt dist/sub/in.js'

/** `build` writes {@link SUBTREE}; uncached `post` runs `post` after it. */
const buildThenPost = (post: string): WorkspaceSpec => ({
  projects: {
    a: {
      tasks: {
        build: { command: SUBTREE, inputs: ['src/**'], outputs: ['dist/**'] },
        post: { command: post, dependsOn: ['build'], cache: false },
      },
      files: { 'src/a.txt': 'a\n' },
    },
  },
})

/** A root output tree `gen/` holding gen/real.txt and, when `empty`, gen/empty/. */
const rootGen = (empty: boolean): WorkspaceSpec => ({
  projects: {
    a: {
      tasks: {
        build: {
          command: empty
            ? 'cd ../.. && rm -rf gen && mkdir -p gen/empty && echo real > gen/real.txt'
            : 'cd ../.. && mkdir -p gen && echo real > gen/real.txt',
          inputs: ['src/**'],
          rootOutputs: ['gen/**'],
        },
      },
      files: { 'src/a.txt': 'a\n' },
    },
  },
  files: { '.gitignore': ignoring('gen') },
})

const DEEP = 'dist/packages/design-system-components/esm/react/primitives/button'
const LONG = `${'x'.repeat(120)}.js`
const LONGER = `${'y'.repeat(140)}.snap`

const ODD = ['with spaces.js', 'café.js', 'quo"te.js', 'back\\slash.js']
const oddWorkspace = one({
  command: [
    'mkdir -p dist',
    'cp src/a.txt "dist/with spaces.js"',
    'cp src/a.txt dist/café.js',
    `cp src/a.txt 'dist/quo"te.js'`,
    `cp src/a.txt 'dist/back\\slash.js'`,
  ].join(' && '),
  inputs: ['src/**'],
  outputs: ['dist/**'],
})
const oddFiles = Object.fromEntries(ODD.map((n) => [`${A}/dist/${n}`, 'a\n']))

const NEXT = one({
  command: [
    'mkdir -p .next/standalone/deep .next/server',
    'echo a > .next/a.json',
    'echo s > .next/standalone/server.js',
    'echo b > .next/standalone/deep/b.json',
    'echo p > .next/server/page.js',
  ].join(' && '),
  inputs: ['src/**'],
  outputs: [
    '.next/*.json',
    '.next/standalone',
    '.next/server',
    '.next/standalone/**',
    '.next/**/*.json',
  ],
})
const NEXT_TREE = {
  [`${A}/.next/a.json`]: 'a\n',
  [`${A}/.next/standalone/server.js`]: 's\n',
  [`${A}/.next/standalone/deep/b.json`]: 'b\n',
  [`${A}/.next/server/page.js`]: 'p\n',
}

/** 64 KiB of `built\n`, as `yes built | head -c 65536` writes it. */
const BUILT_64K = 'built\n'.repeat(10922) + 'buil'

/** lib's uncached build reads its whole project and writes dist.txt there; web's cached build reads it. */
const uncachedUpstream = (ignored: boolean): WorkspaceSpec => ({
  projects: {
    lib: {
      tasks: { build: { command: 'echo lib > dist.txt', inputs: ['**'], cache: false } },
      files: { 'src/a.txt': 'lib\n' },
    },
    web: {
      deps: ['lib'],
      tasks: {
        build: {
          command: 'cat ../lib/dist.txt > out.txt',
          dependsOn: ['^build'],
          inputs: ['src/**'],
          outputs: ['out.txt'],
        },
      },
      files: { 'src/a.txt': 'web\n' },
    },
  },
  ...(ignored ? { files: { '.gitignore': ignoring('packages/lib/dist.txt') } } : {}),
})

export default [
  ...COLLIDING.map(([slug, what, x, y, wipe]) =>
    defineCase({
      id: `outputs/unordered-overlap-${slug}`,
      category: 'outputs',
      kind: 'correctness',
      title: `${what}: neither loses its file`,
      why: 'A tool that clears a task’s outputs before it runs or restores deletes the other task’s file under a green run. Refusing the pair up front is as good as keeping both.',
      from: ['output-collision'],
      workspace: pair(x, y),
      steps: bothKept(x, y, wipe, true),
    }),
  ),

  ...DISJOINT.map(([slug, what, x, y, wipe]) =>
    defineCase({
      id: `outputs/disjoint-${slug}`,
      category: 'outputs',
      kind: 'correctness',
      title: `${what} build, cache and restore side by side`,
      why: 'Their outputs share no path: refusing the pair breaks a build that works.',
      from: ['output-collision'],
      workspace: pair(x, y),
      steps: bothKept(x, y, wipe, false),
    }),
  ),

  defineCase({
    id: 'outputs/addition-root-across-projects',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A project that adds a root file beside a dependency’s root output tree: warm runs and an upstream edit keep both',
    from: ['output-collision'],
    workspace: rootAddition(),
    steps: [
      {
        run: 'down',
        expect: { exit: 0, files: { 'shared/a.txt': 'A1\n', 'shared/b.txt': 'B1\n' } },
      },
      {
        run: 'down',
        expect: { exit: 0, files: { 'shared/a.txt': 'A1\n', 'shared/b.txt': 'B1\n' } },
      },
      { write: { 'packages/a/src/a.txt': 'A2\n' } },
      {
        run: 'down',
        expect: { exit: 0, files: { 'shared/a.txt': 'A2\n', 'shared/b.txt': 'B1\n' } },
      },
    ],
  }),

  defineCase({
    id: 'outputs/addition-root-into-project-tree',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A root output file added into a dependency project’s output tree survives warm runs and that project’s rebuild',
    from: ['output-collision'],
    workspace: intoProjectAddition(),
    steps: [
      {
        run: 'down',
        expect: {
          exit: 0,
          files: { 'packages/b/dist/a.txt': 'A1\n', 'packages/b/dist/b.txt': 'B1\n' },
        },
      },
      {
        run: 'down',
        expect: {
          exit: 0,
          files: { 'packages/b/dist/a.txt': 'A1\n', 'packages/b/dist/b.txt': 'B1\n' },
        },
      },
      { write: { 'packages/b/src/b.txt': 'B2\n' } },
      {
        run: 'down',
        expect: {
          exit: 0,
          files: { 'packages/b/dist/a.txt': 'A1\n', 'packages/b/dist/b.txt': 'B2\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/nested-stray-removed-after-warm-hits',
    category: 'outputs',
    kind: 'correctness',
    title: 'A stray file dropped deep in an output tree after warm runs is gone on the next run',
    why: 'Outputs are what the task wrote; a tool that trusts an unchanged tree from its last look ships the stray.',
    from: ['output-dirs'],
    workspace: one({ command: SUBTREE, inputs: ['src/**'], outputs: ['dist/**'] }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist/sub/stray.js`]: 'stale\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: { [`${A}/dist/sub/stray.js`]: null, [`${A}/dist/sub/in.js`]: 'a\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/stray-from-later-task-removed',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A file a later task writes into an earlier task’s outputs is gone when that task replays',
    why: 'The earlier task did not write it; a replay that keeps it, or caches it as the task’s, ships a file no build of that task made.',
    from: ['output-dirs'],
    workspace: buildThenPost('echo stray > dist/sub/stray.js'),
    steps: [
      { run: 'post', expect: { exit: 0, files: { [`${A}/dist/sub/stray.js`]: 'stray\n' } } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: { [`${A}/dist/sub/stray.js`]: null, [`${A}/dist/sub/in.js`]: 'a\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/removed-by-later-task-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output a later task deletes is back when the task that wrote it replays',
    from: ['output-dirs'],
    workspace: buildThenPost('rm dist/sub/in.js'),
    steps: [
      { run: 'post', expect: { exit: 0, files: { [`${A}/dist/sub/in.js`]: null } } },
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/sub/in.js`]: 'a\n' } } },
    ],
  }),

  defineCase({
    id: 'outputs/bare-dir-output-stray-removed',
    category: 'outputs',
    kind: 'correctness',
    title: 'A stray file in an output directory named outright is gone after the next run',
    from: ['output-dirs'],
    workspace: one({ command: SUBTREE, inputs: ['src/**'], outputs: ['dist'] }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist/sub/stray.js`]: 'stale\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: { [`${A}/dist/sub/stray.js`]: null, [`${A}/dist/sub/in.js`]: 'a\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/bare-file-output-edit-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output file named outright and edited by hand is put back on the next run',
    from: ['output-dirs'],
    workspace: one({
      command: 'mkdir -p dist && cp src/a.txt dist/tool',
      inputs: ['src/**'],
      outputs: ['dist/tool'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist/tool`]: 'tampered' } },
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/tool`]: 'a\n' } } },
    ],
  }),

  defineCase({
    id: 'outputs/bare-file-output-dir-replaced',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A directory standing where an output file named outright belongs is replaced by the file',
    from: ['output-dirs'],
    workspace: one({
      command: 'mkdir -p dist && cp src/a.txt dist/tool',
      inputs: ['src/**'],
      outputs: ['dist/tool'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist/tool`]: null } },
      { write: { [`${A}/dist/tool/stray.js`]: 'stale' } },
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/tool`]: 'a\n' } } },
    ],
  }),

  defineCase({
    id: 'outputs/anywhere-dir-pattern-stray-removed',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A stray in a new directory an anywhere-pattern (`**/dist/**`) reaches is gone after a hit',
    why: 'The pattern claims every `dist` in the project; a new one holding a stray is part of what the task owns.',
    from: ['output-dirs'],
    workspace: one({
      command: 'mkdir -p dist && cp src/a.txt dist/out.js',
      inputs: ['src/**'],
      outputs: ['**/dist/**', '!src/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/lib/dist/stray.js`]: 'stale' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: { [`${A}/lib/dist/stray.js`]: null, [`${A}/dist/out.js`]: 'a\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/root-output-stray-removed',
    category: 'outputs',
    kind: 'correctness',
    title: 'A stray file in a deleted root output directory is gone when the task replays',
    from: ['workspace-files'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command:
                'mkdir -p ../../generated && cat src/a.txt > ../../generated/api.txt && echo done > out.txt',
              inputs: ['src/**'],
              outputs: ['out.txt'],
              rootOutputs: ['generated/**'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
      files: { '.gitignore': ignoring('generated', 'packages/a/out.txt') },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { generated: null } },
      { write: { 'generated/stale.txt': 'stale' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: { 'generated/api.txt': 'a\n', 'generated/stale.txt': null },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/root-output-replayed-unchanged',
    category: 'outputs',
    kind: 'efficiency',
    title: 'A task with project and root outputs replays once both are restored',
    from: ['workspace-files'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command:
                'mkdir -p dist ../../generated && cat src/a.txt > ../../generated/api.txt && echo done > dist/out.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
              rootOutputs: ['generated/**'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
      files: { '.gitignore': ignoring('generated') },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist`]: null } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['a#build'],
          files: { 'generated/api.txt': 'a\n', [`${A}/dist/out.txt`]: 'done\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'inputs/root-inputs-per-task',
    category: 'inputs',
    kind: 'correctness',
    title: 'Two tasks of one project with different root inputs: editing one’s root file reruns it',
    from: ['workspace-files'],
    workspace: {
      projects: {
        a: {
          tasks: {
            x: {
              command: 'cat ../../shared/cfg.json > x.txt',
              inputs: ['src/**'],
              rootInputs: ['shared/**'],
              outputs: ['x.txt'],
            },
            y: {
              command: 'cat ../../other/thing.json > y.txt',
              inputs: ['src/**'],
              rootInputs: ['other/**'],
              outputs: ['y.txt'],
            },
            all: { command: 'true', dependsOn: ['x', 'y'] },
          },
          files: { 'src/a.txt': 'a\n', '.gitignore': 'x.txt\ny.txt\n' },
        },
      },
      files: { 'shared/cfg.json': '1\n', 'other/thing.json': '1\n' },
    },
    steps: [
      { run: 'all', expect: { exit: 0 } },
      { write: { 'other/thing.json': '2\n' } },
      { run: 'all', expect: { exit: 0, ran: ['a#y'], files: { [`${A}/y.txt`]: '2\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/root-inputs-per-task-other-replays',
    category: 'inputs',
    kind: 'efficiency',
    title:
      'Two tasks of one project with different root inputs: editing one’s root file replays the other',
    from: ['workspace-files'],
    workspace: {
      projects: {
        a: {
          tasks: {
            x: {
              command: 'cat ../../shared/cfg.json > x.txt',
              inputs: ['src/**'],
              rootInputs: ['shared/**'],
              outputs: ['x.txt'],
            },
            y: {
              command: 'cat ../../other/thing.json > y.txt',
              inputs: ['src/**'],
              rootInputs: ['other/**'],
              outputs: ['y.txt'],
            },
            all: { command: 'true', dependsOn: ['x', 'y'] },
          },
          files: { 'src/a.txt': 'a\n', '.gitignore': 'x.txt\ny.txt\n' },
        },
      },
      files: { 'shared/cfg.json': '1\n', 'other/thing.json': '1\n' },
    },
    steps: [
      { run: 'all', expect: { exit: 0 } },
      { write: { 'other/thing.json': '2\n' } },
      { run: 'all', expect: { exit: 0, notRan: ['a#x'] } },
    ],
  }),

  defineCase({
    id: 'inputs/root-output-read-by-dependent',
    category: 'inputs',
    kind: 'correctness',
    title: 'A task whose root input is a file its dependency generates sees each fresh version',
    from: ['workspace-files'],
    workspace: {
      projects: {
        a: {
          tasks: {
            gen: {
              command: 'mkdir -p ../../shared && cat src/a.txt > ../../shared/gen.txt',
              inputs: ['src/**'],
              rootOutputs: ['shared/gen.txt'],
            },
          },
          files: { 'src/a.txt': 'v1\n' },
        },
        b: {
          tasks: {
            build: {
              command: 'cat ../../shared/gen.txt > out.txt',
              dependsOn: ['a#gen'],
              inputs: ['src/**'],
              rootInputs: ['shared/**'],
              outputs: ['out.txt'],
            },
          },
          files: { 'src/.keep': '', '.gitignore': 'out.txt\n' },
        },
      },
      files: { '.gitignore': ignoring('shared/gen.txt') },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { 'packages/b/out.txt': 'v1\n' } } },
      { write: { 'packages/a/src/a.txt': 'v2\n' } },
      { run: 'build', expect: { exit: 0, files: { 'packages/b/out.txt': 'v2\n' } } },
      { write: { 'packages/a/src/a.txt': 'v1\n' } },
      { run: 'build', expect: { exit: 0, files: { 'packages/b/out.txt': 'v1\n' } } },
    ],
  }),

  defineCase({
    id: 'outputs/long-names-round-trip',
    category: 'outputs',
    kind: 'correctness',
    title: 'Outputs with paths and file names over 100 bytes restore intact, with their modes',
    why: 'A cache format that cannot hold a long name drops the file on every restore, or fails a build that passed.',
    from: ['artifact-roundtrip'],
    workspace: one({
      command: [
        `mkdir -p ${DEEP}`,
        'cp src/a.txt dist/plain.js',
        `cp src/a.txt ${DEEP}/index.esm.production.min.js`,
        `cp src/a.txt dist/${LONG}`,
        `cp src/a.txt dist/${LONGER}`,
        `printf '#!/bin/sh\\necho hi\\n' > dist/cli`,
        'chmod 755 dist/cli',
      ].join(' && '),
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist`]: null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: {
            [`${A}/dist/plain.js`]: 'a\n',
            [`${A}/${DEEP}/index.esm.production.min.js`]: 'a\n',
            [`${A}/dist/${LONG}`]: 'a\n',
            [`${A}/dist/${LONGER}`]: 'a\n',
            [`${A}/dist/cli`]: '#!/bin/sh\necho hi\n',
          },
        },
      },
      { check: { modes: { [`${A}/dist/cli`]: 0o755 } } },
    ],
  }),

  defineCase({
    id: 'outputs/long-names-replayed',
    category: 'outputs',
    kind: 'efficiency',
    title: 'Outputs with names over 100 bytes are cached: deleted, they are restored, not rebuilt',
    from: ['artifact-roundtrip'],
    workspace: one({
      command: `mkdir -p ${DEEP} && cp src/a.txt ${DEEP}/index.esm.production.min.js && cp src/a.txt dist/${LONGER}`,
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist`]: null } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'outputs/overlapping-own-patterns-restored',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A task whose own output patterns and directories overlap restores exactly the tree it wrote',
    why: 'A file two of the task’s patterns match is one output, not two to write over each other.',
    from: ['artifact-roundtrip'],
    workspace: NEXT,
    steps: [
      { run: 'build', expect: { exit: 0, files: NEXT_TREE } },
      { write: { [`${A}/.next`]: null } },
      { run: 'build', expect: { exit: 0, files: NEXT_TREE } },
    ],
  }),

  defineCase({
    id: 'outputs/overlapping-own-patterns-replayed',
    category: 'outputs',
    kind: 'efficiency',
    title: 'A task whose own output patterns overlap replays after a restore',
    from: ['artifact-roundtrip'],
    workspace: NEXT,
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/.next`]: null } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'outputs/brace-extension-set',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output pattern with a brace set of extensions restores those files and no other',
    from: ['artifact-roundtrip'],
    workspace: one({
      command: [
        'mkdir -p .build/sub',
        'echo js > .build/a.js',
        'echo ts > .build/b.ts',
        'echo map > .build/sub/a.map',
        'echo css > .build/c.css',
      ].join(' && '),
      inputs: ['src/**'],
      outputs: ['.build/**/*.{js,map,ts}'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/.build`]: null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['a#build'],
          files: {
            [`${A}/.build/a.js`]: 'js\n',
            [`${A}/.build/b.ts`]: 'ts\n',
            [`${A}/.build/sub/a.map`]: 'map\n',
            [`${A}/.build/c.css`]: null,
          },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/odd-names-round-trip',
    category: 'outputs',
    kind: 'correctness',
    title:
      'Output names with a space, a quote, a backslash or non-ASCII letters restore as written',
    from: ['artifact-roundtrip'],
    workspace: oddWorkspace,
    steps: [
      { run: 'build', expect: { exit: 0, files: oddFiles } },
      { write: { [`${A}/dist`]: null } },
      { run: 'build', expect: { exit: 0, files: oddFiles } },
    ],
  }),

  defineCase({
    id: 'outputs/odd-names-replayed',
    category: 'outputs',
    kind: 'efficiency',
    title: 'Outputs with odd names are cached: deleted, they are restored, not rebuilt',
    from: ['artifact-roundtrip'],
    workspace: oddWorkspace,
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist`]: null } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'outputs/large-output-restored',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A large incompressible output restores byte for byte, an executable beside it kept executable',
    from: ['artifact-roundtrip'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command:
                'mkdir -p dist && head -c 6291456 /dev/urandom > dist/big.bin && cksum < dist/big.bin > sum.txt && ' +
                "printf '#!/bin/sh\\n' > dist/run.sh && chmod 755 dist/run.sh",
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a\n', '.gitignore': 'sum.txt\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist`]: null } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { sh: `cd ${A} && cksum < dist/big.bin | cmp -s - sum.txt` },
      { check: { modes: { [`${A}/dist/run.sh`]: 0o755 } } },
    ],
  }),

  defineCase({
    id: 'report/retried-duration-all-attempts',
    category: 'report',
    kind: 'data',
    title: 'A retried task’s reported time covers every attempt, not only the last',
    from: ['retries'],
    needs: ['retries'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command:
                'sleep 0.3; if [ -f flag.txt ]; then mkdir -p dist && echo ok > dist/out.txt; else touch flag.txt; exit 1; fi',
              retries: 1,
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a\n', '.gitignore': 'flag.txt\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        expect: { exit: 0, report: { task: 'a#build', durationMs: [580, 20_000] } },
      },
    ],
  }),

  defineCase({
    id: 'outputs/retry-spares-a-sibling-root-output',
    category: 'outputs',
    kind: 'correctness',
    title: 'A retry does not remove the root output directory a task beside it is writing into',
    from: ['retries'],
    needs: ['retries'],
    workspace: {
      projects: {
        a: {
          tasks: {
            p: {
              command:
                'until [ -e ready ]; do sleep 0.01; done; if [ -e tried ]; then touch go; exit 1; fi; touch tried; echo a > ../../out/a.txt; exit 1',
              retries: 1,
              inputs: ['in.txt'],
              rootOutputs: ['out/a.txt'],
            },
            q: {
              command:
                'mkdir -p ../../out && touch ready && until [ -e go ]; do sleep 0.01; done; echo b > ../../out/b.txt',
              inputs: ['in.txt'],
              rootOutputs: ['out/b.txt'],
            },
            both: { command: 'true', dependsOn: ['p', 'q'] },
          },
          files: { 'in.txt': 'in\n' },
        },
      },
    },
    steps: [
      {
        run: 'both',
        concurrency: 2,
        expect: { exit: 'fail', ran: ['a#q'], files: { 'out/b.txt': 'b\n' }, within: 30 },
      },
    ],
  }),

  defineCase({
    id: 'outputs/hand-chmod-reset',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output whose mode was changed by hand gets back the mode the task gave it',
    from: ['restore-staging'],
    workspace: one({
      command: 'mkdir -p dist && cat src/a.txt > dist/out.txt && chmod 644 dist/out.txt',
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { chmod: { [`${A}/dist/out.txt`]: 0o755 } },
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: 'a\n' } } },
      { check: { modes: { [`${A}/dist/out.txt`]: 0o644 } } },
    ],
  }),

  defineCase({
    id: 'outputs/root-empty-dirs-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'Empty directories a task leaves under its root outputs come back with a hit',
    from: ['output-empty-dir'],
    workspace: rootGen(true),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { gen: null } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { 'gen/real.txt': 'real\n' } },
      },
      { check: { dirs: ['gen/empty'] } },
    ],
  }),

  defineCase({
    id: 'outputs/root-stale-file-in-empty-dir',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A file dropped into a root output directory the task left empty is gone after the next run',
    from: ['output-empty-dir'],
    workspace: rootGen(true),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'gen/empty/stale.txt': 'stale\n' } },
      {
        run: 'build',
        expect: { exit: 0, files: { 'gen/empty/stale.txt': null, 'gen/real.txt': 'real\n' } },
      },
      { check: { dirs: ['gen/empty'] } },
    ],
  }),

  defineCase({
    id: 'outputs/root-old-empty-dirs-not-cached',
    category: 'outputs',
    kind: 'correctness',
    title:
      'Empty directories an older build left in a root output tree do not come back with a hit',
    from: ['output-empty-dir'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'cd ../.. && mkdir -p gen && echo real > gen/real.txt',
              inputs: ['src/**'],
              rootOutputs: ['gen/**'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
      files: { '.gitignore': ignoring('gen') },
    },
    steps: [
      { write: { 'gen/old/inner/x': '' } },
      { write: { 'gen/old/inner/x': null } },
      { run: 'build', expect: { exit: 0 } },
      { write: { gen: null } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { 'gen/real.txt': 'real\n' } },
      },
      { check: { missing: ['gen/old'] } },
    ],
  }),

  defineCase({
    id: 'outputs/root-stray-empty-dir-removed',
    category: 'outputs',
    kind: 'correctness',
    title: 'A stray empty directory under a root output tree is gone after a hit',
    from: ['output-empty-dir'],
    workspace: rootGen(false),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'gen/stray/x': '' } },
      { write: { 'gen/stray/x': null } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { 'gen/real.txt': 'real\n' } },
      },
      { check: { missing: ['gen/stray'] } },
    ],
  }),

  defineCase({
    id: 'outputs/mixed-damage-restored',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A hit puts back an edited output, a file replaced by a directory, and removes a stray tree, in one restore',
    from: ['restore-in-place'],
    workspace: one({
      command: 'mkdir -p dist && echo a > dist/a.txt && echo out > dist/out',
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      {
        write: {
          [`${A}/dist/stale/deep/x.txt`]: 'x\n',
          [`${A}/dist/out`]: null,
          [`${A}/dist/a.txt`]: 'changed\n',
        },
      },
      { write: { [`${A}/dist/out/y.txt`]: 'y\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: { [`${A}/dist/a.txt`]: 'a\n', [`${A}/dist/out`]: 'out\n' },
        },
      },
      { check: { missing: [`${A}/dist/stale`] } },
    ],
  }),

  defineCase({
    id: 'outputs/edit-after-save-not-cached',
    category: 'outputs',
    kind: 'correctness',
    title:
      'Appending to an output after a build or a restore does not change what the next restore brings back',
    why: 'A cache that links its stored copy into the tree lets an edit of the tree rewrite the entry, and later hits replay the edit.',
    from: ['restore-in-place'],
    workspace: one({
      command: 'mkdir -p dist && yes built | head -c 65536 > dist/out.txt',
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: BUILT_64K } } },
      { sh: `echo 'after save' >> ${A}/dist/out.txt` },
      { write: { [`${A}/dist`]: null } },
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: BUILT_64K } } },
      { sh: `echo 'after restore' >> ${A}/dist/out.txt` },
      { write: { [`${A}/dist`]: null } },
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: BUILT_64K } } },
    ],
  }),

  defineCase({
    id: 'cache/uncached-upstream-own-write-settles',
    category: 'cache',
    kind: 'efficiency',
    title:
      'A cached task depending on an uncached one that writes into its own inputs replays by the third run',
    why: 'The uncached task’s first run adds a file its inputs cover, so its dependants may miss once more; after that nothing changes.',
    from: ['uncached-upstream-key'],
    needs: ['uncached-task'],
    workspace: uncachedUpstream(false),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0, notRan: ['web#build'] } },
    ],
  }),

  defineCase({
    id: 'cache/uncached-upstream-ignored-write-replays',
    category: 'cache',
    kind: 'efficiency',
    title:
      'A cached task depending on an uncached one whose written file git ignores replays on the second run',
    from: ['uncached-upstream-key'],
    needs: ['uncached-task'],
    workspace: uncachedUpstream(true),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['web#build'], files: { 'packages/web/out.txt': 'lib\n' } },
      },
    ],
  }),
]
