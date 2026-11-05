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

type Pair = [slug: string, what: string, why: string, x: Writer, y: Writer, wipe: string[]]

const inA = (at: string, outputs: string[]): Writer => ({ project: 'a', at: `${A}/${at}`, outputs })

const COLLIDING: Pair[] = [
  [
    'dir-slash-over-file',
    'An output directory written with a trailing slash that holds another task’s file',
    '`dist/` with a trailing slash names the same directory as `dist`, so it claims `dist/app.js`, the other task’s file. A tool that treats the slash as part of a name misses the overlap, then clears or restores `dist` and deletes that file under a green run. Spelling must not change what a pattern covers. Refusing the pair or keeping both files are both fine.',
    inA('dist/x.txt', ['dist/']),
    inA('dist/app.js', ['dist/app.js']),
    [`${A}/dist`],
  ],
  [
    'dot-slash-spelling',
    'One output pattern spelled `./dist/**` and the same pattern spelled `dist/**`',
    '`./dist/**` and `dist/**` are the same pattern, so both tasks claim the whole of `dist`. A tool that compares the spellings as text sees two different trees and lets each task clear or restore `dist` over the other. One task’s file then vanishes from a green build. Paths must be normalised before they are compared.',
    inA('dist/x.txt', ['./dist/**']),
    inA('dist/y.txt', ['dist/**']),
    [`${A}/dist`],
  ],
  [
    'question-mark-over-literal',
    'A `?` output pattern that matches another task’s output file',
    '`dist/a?.txt` matches `dist/ab.txt`, the other task’s file, because `?` stands for any one character. A tool that skips `?` when checking overlap lets one task’s restore delete or roll back the other’s output. The run stays green and the file is wrong. Every glob character counts when deciding who owns a path.',
    inA('dist/ax.txt', ['dist/a?.txt']),
    inA('dist/ab.txt', ['dist/ab.txt']),
    [`${A}/dist`],
  ],
  [
    'prefix-wildcard-over-literal',
    'A `name-*` output pattern that matches another task’s output file',
    '`dist/vx-*` matches `dist/vx-linux-x64`, which another task writes. Release layouts often look like this, with an all-platforms task beside per-platform ones. A tool that misses the match lets one task’s clean or restore delete the other’s binary, and a release ships without it. Refusing the pair or keeping both files are the safe outcomes.',
    inA('dist/vx-all', ['dist/vx-*']),
    inA('dist/vx-linux-x64', ['dist/vx-linux-x64']),
    [`${A}/dist`],
  ],
  [
    'subtree-over-nested-subtree',
    'A whole output tree and another task’s pattern for a directory inside it',
    '`dist/**` contains `dist/extra/**`, so the inner task’s files sit inside the outer task’s outputs. A tool that restores the outer task’s entry as the whole of `dist` deletes `dist/extra/y.txt` without an error. Nesting is a common way to add files to a build, which makes the silent loss easy to hit. The pair must be refused, or both files kept.',
    inA('dist/x.txt', ['dist/**']),
    inA('dist/extra/y.txt', ['dist/extra/**']),
    [`${A}/dist`],
  ],
  [
    'subtree-over-extension-glob',
    'A whole output tree and another task’s pattern for one extension inside it',
    '`dist/**` covers every `.d.ts` file that `dist/**/*.d.ts` claims, as when a type-declaration task writes into a bundler’s tree. If either task clears or restores by its own pattern without regard to the other, the types or the bundle go missing behind a green run. The overlap is real even though the patterns differ. Refusing the pair or keeping both files are both acceptable.',
    inA('dist/x.txt', ['dist/**']),
    inA('dist/types/y.d.ts', ['dist/**/*.d.ts']),
    [`${A}/dist`],
  ],
  [
    'anywhere-glob-over-subtree',
    'A pattern for one extension anywhere and another task’s output tree holding such a file',
    '`**/*.d.ts` matches every declaration file in the project, including `dist/y.d.ts`, which another task writes. A tool that checks the wide pattern only near where its own files sit misses the overlap. One task’s clean or restore then deletes the other’s file and the run stays green. A pattern claims everything it matches, wherever that is.',
    inA('types/x.d.ts', ['**/*.d.ts']),
    inA('dist/y.d.ts', ['dist/**']),
    [`${A}/dist`, `${A}/types`],
  ],
  [
    'wildcard-directory-over-literal',
    'A pattern with a wildcard directory that matches another task’s output file',
    '`*/app.js` matches `dist/app.js` as well as `lib/app.js`, so two tasks claim the same file. A tool that treats the wildcard directory as one fixed name misses this. A restore of the first task can then overwrite or delete the second task’s `dist/app.js` under a green run. Refusing the pair or keeping both files are the safe answers.',
    inA('lib/app.js', ['*/app.js']),
    inA('dist/app.js', ['dist/app.js']),
    [`${A}/dist`, `${A}/lib`],
  ],
  [
    'brace-directory-over-literal',
    'A pattern with a brace set of directories that names another task’s output file',
    '`{dist,lib}/app.js` names `lib/app.js`, which the other task writes. A tool that checks only the first brace alternative misses the overlap. The first task’s clean or restore then removes or rolls back the other task’s file with no error. A brace set must be expanded in full before ownership is decided.',
    inA('dist/app.js', ['{dist,lib}/app.js']),
    inA('lib/app.js', ['lib/app.js']),
    [`${A}/dist`, `${A}/lib`],
  ],
  [
    'patterns-meet-at-one-file',
    'A brace output pattern and a wildcard one that both match the file one task writes',
    '`build/{a,b}.js` and `build/*.js` both match `build/b.js`, the file one task writes. Neither pattern looks like the other, so the clash is easy to miss. A tool that clears or restores each task by its pattern can delete one task’s file when the other runs. It must refuse the pair or keep both files intact.',
    inA('build/b.js', ['build/{a,b}.js']),
    inA('build/y.js', ['build/*.js']),
    [`${A}/build`],
  ],
  [
    'partial-negation',
    'A pattern whose `!` entry takes back only part of another task’s output tree',
    'The `!types/x/**` entry takes back only `types/x`, so `**/dist/**` still claims `types/dist/y.txt`, the other task’s file. A tool that reads any negation under `types` as removing the whole tree misses the overlap. A restore can then delete that file under a green run. A negation removes exactly what it matches, no more.',
    inA('lib/dist/x.txt', ['**/dist/**', '!types/x/**']),
    inA('types/dist/y.txt', ['types/**']),
    [`${A}/lib`, `${A}/types`],
  ],
  [
    'root-outputs-across-projects',
    'Two projects’ root output patterns where one covers the other’s file',
    'Root outputs live outside a project, so two projects can claim the same workspace path. Here `shared/**` covers `shared/b.txt`, which the other project writes. A tool that clears or restores one project’s root tree deletes the other’s file, and the run stays green. Overlap across projects needs the same check as overlap inside one.',
    { project: 'a', at: 'shared/a.txt', rootOutputs: ['shared/**'] },
    { project: 'b', at: 'shared/b.txt', rootOutputs: ['shared/b.txt'] },
    ['shared'],
  ],
  [
    'root-output-inside-project-tree',
    'A root output file inside another project’s output tree',
    'A root output can point into another project’s folder. Here one task writes `packages/b/dist/a.txt`, which project b’s `dist/**` also claims. When b restores its `dist`, a tool that ignores the root claim deletes that file, and the run stays green. Root and project paths must be compared on one map of the workspace.',
    { project: 'a', at: 'packages/b/dist/a.txt', rootOutputs: ['packages/b/dist/a.txt'] },
    { project: 'b', at: 'packages/b/dist/y.txt', outputs: ['dist/**'] },
    ['packages/b/dist'],
  ],
  [
    'root-output-tree-over-project-file',
    'A root output tree that holds another project’s output file',
    'The root output tree `packages/b/dist/**` covers `packages/b/dist/y.txt`, a file project b declares as its own output. Two tasks in different projects then claim one path. A tool that never compares root outputs with project outputs lets one task’s restore delete the other’s file under a green run. The pair must be refused, or both files kept.',
    { project: 'a', at: 'packages/b/dist/a.txt', rootOutputs: ['packages/b/dist/**'] },
    { project: 'b', at: 'packages/b/dist/y.txt', outputs: ['dist/y.txt'] },
    ['packages/b/dist'],
  ],
]

const DISJOINT: Pair[] = [
  [
    'two-literal-dirs',
    'Two tasks naming two different output directories outright',
    '`dist` and `build` are different directories, so the two tasks share nothing. A tool that sees a conflict wherever two tasks name directories refuses a build that works. One that clears more than each task named breaks it. Each task should build, cache and restore its own tree without touching the other.',
    inA('dist/x.txt', ['dist']),
    inA('build/y.txt', ['build']),
    [`${A}/dist`, `${A}/build`],
  ],
  [
    'dir-beside-longer-name',
    'An output directory and another task’s file in a directory whose name extends it',
    '`dist` and `distant/app.js` share a run of letters but no directory. A tool that compares paths as plain strings thinks `dist` covers `distant`. It then refuses a working build, or clears the other task’s file when `dist` is restored. Paths must be compared segment by segment.',
    inA('dist/x.txt', ['dist']),
    inA('distant/app.js', ['distant/app.js']),
    [`${A}/dist`, `${A}/distant`],
  ],
  [
    'literal-subdirs',
    'Two tasks naming sibling subdirectories of one directory outright',
    'Naming `dist/a` and `dist/b` outright gives each task its own sibling folder; the shared parent belongs to neither. A tool that restores `dist` as one unit wipes the sibling. One that flags any two outputs under one parent refuses a working layout. Each named directory should be cached and restored on its own.',
    inA('dist/a/x.txt', ['dist/a']),
    inA('dist/b/y.txt', ['dist/b']),
    [`${A}/dist`],
  ],
  [
    'subtree-beside-longer-name',
    'An output tree and another task’s tree in a directory whose name extends it',
    '`dist/**` and `distant/**` look alike as text but sit in different directories. A string-prefix check reads one as inside the other, and either refuses the pair or lets one task’s restore delete the other’s tree. The two tasks own separate paths, so both must build, cache and restore side by side.',
    inA('dist/x.txt', ['dist/**']),
    inA('distant/y.txt', ['distant/**']),
    [`${A}/dist`, `${A}/distant`],
  ],
  [
    'subtree-beside-sibling-glob',
    'An output tree and another task’s pattern over a sibling directory',
    '`dist/a/**` and `dist/b/*.js` cover sibling folders, so no file can match both. A tool that stops comparing at the first wildcard, or at the shared `dist`, sees a clash that is not there. It refuses a working build, or clears one sibling when the other restores. Overlap is decided by what the patterns can match.',
    inA('dist/a/x.txt', ['dist/a/**']),
    inA('dist/b/y.js', ['dist/b/*.js']),
    [`${A}/dist`],
  ],
  [
    'extension-globs-apart',
    'Two patterns over one tree that take different extensions',
    '`dist/**/*.js` and `dist/**/*.map` cover one tree but take different extensions, so `x.js` and `x.js.map` belong to different tasks. Splitting a bundle and its source maps between tasks is a real layout. A tool that calls any two patterns over one tree a clash refuses it, and one that restores by directory deletes the other’s files.',
    inA('dist/sub/x.js', ['dist/**/*.js']),
    inA('dist/sub/x.js.map', ['dist/**/*.map']),
    [`${A}/dist`],
  ],
  [
    'tree-beside-deep-glob',
    'An output tree and another task’s deep pattern over another directory',
    '`lib/**` and `dist/**/*.js` start in different top-level directories. Two deep patterns are not in conflict just because both use `**`. A tool that treats `**` as reaching everywhere refuses a working build, or clears the other task’s files on restore. Each pattern reaches only below its fixed prefix.',
    inA('lib/x.txt', ['lib/**']),
    inA('dist/sub/y.js', ['dist/**/*.js']),
    [`${A}/dist`, `${A}/lib`],
  ],
  [
    'question-mark-unmatched',
    'A `?` output pattern beside a file it does not match',
    '`dist/a?.txt` cannot match `dist/zz.txt`, since the first letter differs. A tool that treats any wildcard in a shared directory as a clash refuses a working build. A restore of the pattern’s task must also leave `dist/zz.txt` alone. Ownership is decided by what the pattern really matches.',
    inA('dist/ax.txt', ['dist/a?.txt']),
    inA('dist/zz.txt', ['dist/zz.txt']),
    [`${A}/dist`],
  ],
  [
    'brace-unmatched',
    'A brace output pattern beside a file it does not name',
    '`dist/{a,b}.txt` names two files, and `dist/c.txt` is not one of them. A tool that treats a brace as matching anything in the directory refuses a working build, or deletes `c.txt` when it restores the first task. A brace set is a short list of names and nothing more.',
    inA('dist/a.txt', ['dist/{a,b}.txt']),
    inA('dist/c.txt', ['dist/c.txt']),
    [`${A}/dist`],
  ],
  [
    'odd-spellings-apart',
    'Two sibling output trees spelled `./dist/a/**` and `dist//b/**`',
    '`./dist/a/**` and `dist//b/**` are untidy spellings of two sibling trees; normalised, they share no path. A tool that does not normalise them can see a clash and refuse a working build. It can also fail to match a task’s own files on a restore and leave them out. Harmless spelling must not change what a task owns.',
    inA('dist/a/x.txt', ['./dist/a/**']),
    inA('dist/b/y.txt', ['dist//b/**']),
    [`${A}/dist`],
  ],
  [
    'negation-takes-back-tree',
    'A pattern whose `!` entry takes back another task’s whole output tree',
    '`!types/**` removes the whole `types` tree from `**/dist/**`, so the other task’s `types/dist/y.txt` is not claimed. A tool that ignores the negation refuses a working build, or clears the other task’s file on restore. Negation is how a config narrows a wide pattern, and explicit config beats the broad match.',
    inA('lib/dist/x.txt', ['**/dist/**', '!types/**']),
    inA('types/dist/y.txt', ['types/**']),
    [`${A}/lib`, `${A}/types`],
  ],
  [
    'brace-beside-literal',
    'A brace output pattern beside another task’s file in the same directory',
    '`build/{a,b}.js` names `a.js` and `b.js`, while the other task writes `build/c.js`. They share a directory and nothing else. A tool that treats the brace as a wildcard refuses the pair, or removes `c.js` on a restore. Both tasks must build, cache and restore side by side.',
    inA('build/a.js', ['build/{a,b}.js']),
    inA('build/c.js', ['build/c.js']),
    [`${A}/build`],
  ],
  [
    'literal-beside-glob-head',
    'An output tree and another task’s files beside it, one in a directory whose name extends it',
    '`dist/a/**` claims only the `dist/a` folder, while the other task writes `dist/ab/c.js` and `dist/b.js`. `dist/ab` starts with the same letters but is a different folder. A string-prefix check reads it as inside `dist/a`, then refuses the pair or deletes the file on a restore. Paths are compared by whole segments.',
    inA('dist/a/x.txt', ['dist/a/**']),
    inA('dist/ab/c.js', ['dist/ab/c.js', 'dist/b.js']),
    [`${A}/dist`],
  ],
  [
    'root-outputs-distinct',
    'Two projects writing distinct root output files into one directory',
    'Two projects writing `generated/a.ts` and `generated/b.ts` share a workspace folder but no file, a common layout for code generators. A tool that treats the shared root folder as owned by one project refuses the build. One that clears the folder on a restore deletes the other project’s file. Each root output should be cached and restored on its own.',
    { project: 'a', at: 'generated/a.ts', rootOutputs: ['generated/a.ts'] },
    { project: 'b', at: 'generated/b.ts', rootOutputs: ['generated/b.ts'] },
    ['generated'],
  ],
  [
    'project-and-root-namespaces',
    'A project output and another project’s root output with the same relative name',
    'A project output `generated/x.ts` means `packages/a/generated/x.ts`, while a root output of the same name means `generated/x.ts` at the workspace root. They are different files. A tool that compares the two lists without resolving them refuses a working build, or restores one file over the other. Relative names must be resolved before they are compared.',
    inA('generated/x.ts', ['generated/x.ts']),
    { project: 'b', at: 'generated/x.ts', rootOutputs: ['generated/x.ts'] },
    [`${A}/generated`, 'generated'],
  ],
  [
    'root-output-beside-project-tree',
    'A root output file in another project, beside that project’s output tree',
    'A root output in `packages/b/gen` sits inside project b’s folder but outside its `dist` tree, so no file is claimed twice. A tool that treats a whole project folder as that project’s own refuses the pair, or clears `gen` when b restores. Ownership follows the declared patterns, not the project folder.',
    { project: 'a', at: 'packages/b/gen/a.txt', rootOutputs: ['packages/b/gen/a.txt'] },
    { project: 'b', at: 'packages/b/dist/y.txt', outputs: ['dist/**'] },
    ['packages/b/gen', 'packages/b/dist'],
  ],
  [
    'root-output-beside-project-glob',
    'A root output file in another project’s output directory that its pattern does not match',
    'Project b claims `dist/*.js`, and a root output writes `packages/b/dist/a.txt` beside those files. The `.txt` file does not match b’s pattern. A tool that treats b’s whole `dist` folder as b’s refuses a working build, or deletes `a.txt` when b restores. Only what the pattern matches is b’s.',
    { project: 'a', at: 'packages/b/dist/a.txt', rootOutputs: ['packages/b/dist/a.txt'] },
    { project: 'b', at: 'packages/b/dist/y.js', outputs: ['dist/*.js'] },
    ['packages/b/dist'],
  ],
  [
    'root-output-taken-back',
    'A root output file in another project’s output tree that a `!` entry takes back',
    'Project b’s `!dist/a.txt` takes back the file another project writes into b’s `dist` as a root output, so no path is claimed twice. A tool that ignores negations when comparing root and project outputs refuses a working build, or deletes `a.txt` on b’s restore. Explicit config beats the broad match.',
    { project: 'a', at: 'packages/b/dist/a.txt', rootOutputs: ['packages/b/dist/a.txt'] },
    { project: 'b', at: 'packages/b/dist/y.txt', outputs: ['dist/**', '!dist/a.txt'] },
    ['packages/b/dist'],
  ],
  [
    'two-projects-one-pattern',
    'Two projects declaring the same project-relative output pattern',
    'Two projects declaring `dist/**` mean two different folders, `packages/a/dist` and `packages/b/dist`, since project outputs are relative to their project. A tool that compares the patterns as written sees a clash in almost every monorepo, or restores one project’s files into the other. Patterns must be resolved against their project first.',
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
  ...COLLIDING.map(([slug, what, why, x, y, wipe]) =>
    defineCase({
      id: `outputs/unordered-overlap-${slug}`,
      races: 5,
      category: 'outputs',
      kind: 'correctness',
      title: `${what}: neither loses its file`,
      why,
      from: ['output-collision'],
      workspace: pair(x, y),
      steps: bothKept(x, y, wipe, true),
    }),
  ),

  ...DISJOINT.map(([slug, what, why, x, y, wipe]) =>
    defineCase({
      id: `outputs/disjoint-${slug}`,
      category: 'outputs',
      kind: 'correctness',
      title: `${what} build, cache and restore side by side`,
      why,
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
    why: 'When a project adds a root file beside a dependency’s root output tree, every run must end with both files. The dependency’s `shared/**` covers `shared/b.txt`, so restoring its entry as the whole tree would delete the dependant’s file. After an upstream edit the dependency reruns, and the dependant’s file must still be there. The result should match a cold run of both.',
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
    why: 'A dependant may add a file into a dependency’s output tree through a root output. After the dependency rebuilds, that file must still be present. A tool that clears the whole `dist` for the dependency’s rerun, then replays the dependant without restoring its file, leaves the tree incomplete under a green run. Warm runs should match a cold run of both tasks.',
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
    why: 'Outputs are what the task wrote, so a file dropped deep in the tree after several warm runs is a stray. A tool that trusts an unchanged tree from its last look, and skips the check, ships the stray with the next build. The deeper the file, the less likely anyone notices. Each run must leave exactly the task’s tree.',
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
    why: 'A file a later task writes into an earlier task’s outputs is not part of the earlier task’s result. When the earlier task replays, its tree must match what it made. A replay that keeps the file, or an entry that stored it as the task’s, ships a file no build of that task produced. If the later task needs it, the later task makes it again.',
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
    why: 'A replayed task’s outputs are what the task made, even if a later task deleted one in between. Here an uncached step removed `dist/sub/in.js`. A tool that sees the rest of the tree as current and skips the restore leaves the file missing under a green run. Anything that reads it next fails.',
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
    why: 'Naming a directory outright, as `dist`, claims everything under it, the same as `dist/**`. A stray file in a subfolder is therefore inside the outputs and must go. A tool that only checks the directory entry itself keeps the stray and ships it. Both spellings should leave the same tree.',
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
    why: 'An output named outright, like `dist/tool`, is still an output, so a hand edit to it must be undone. A tool that only checks files found by a glob walk can miss a literal path and keep the edit. The build then ships bytes no run produced. Literal and wildcard patterns should be checked the same way.',
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
    why: 'When a directory stands where a literal output file belongs, the next run must replace it with the file. Failing to remove a non-empty directory turns a cached build red, and keeping it ships a stray tree. The run should end with `dist/tool` exactly as the task writes it. A literal output path is checked like any other.',
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
    why: '`**/dist/**` claims every `dist` folder in the project, including one that did not exist when the task ran. A stray in a new `lib/dist` is therefore part of what the task owns, and a hit must remove it. A tool that checks only the folders it saw last time ships the stray. The pattern, not the last listing, says what is owned.',
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
    why: 'A root output tree is the task’s output like any other, even though it sits outside the project. If it is deleted and a stray file appears there, a replay must restore the real files and remove the stray. A tool that cleans only project outputs keeps the stray at the workspace root. Root outputs need the same care as project outputs.',
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
    why: 'Once a task’s project and root outputs are both restored, nothing about it has changed, so later runs should replay. A tool that tracks root outputs poorly may see them as missing or new and rerun the task on every build. That repeats the work each time though no input changed. A restore should settle the task.',
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
    why: 'Root inputs belong to the task that declares them, not to its project. Editing `other/thing.json` changes an input of `y` only, so `y` must rerun and see the new value. A tool that misses the root file, or keys it on the wrong task, replays stale output for `y` under a green run. Each task’s key folds exactly its own declared inputs.',
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
    why: 'Editing a root file that only `y` reads should not rerun `x`. A tool that pools root inputs across a project’s tasks makes every edit to any shared file rerun them all. In a large workspace that costs minutes on each config change. Each task depends only on the inputs it declares.',
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
    why: 'A task that reads a file its dependency generates must see each new version of that file. Here `b` reads `shared/gen.txt`, which `a` writes from its sources. A tool that keys `b` only on its own files misses the change upstream and replays stale output after an edit, or after the edit is undone. The dependant’s key must change whenever its dependency’s inputs do.',
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
    why: 'A cache must store and restore every path a task writes, whatever its length. Old archive formats limit names to 100 bytes, and deep package layouts or snapshot files pass that easily. A cache that cannot hold a long name drops the file on every restore, or fails a build that passed. Modes, like the executable bit on `dist/cli`, must survive too.',
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
    why: 'Long output names should not stop a task from being cached. A tool that cannot store them may skip the entry and rebuild the task each time its outputs are missing. The build stays correct but pays the full cost on every clean checkout. Deleted outputs should mean a restore, not a rebuild.',
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
    why: 'A task’s own output patterns may overlap: `.next/standalone` and `.next/standalone/**` name the same files, as do `.next/*.json` and `.next/**/*.json`. A file two patterns match is one output, not two to write over each other. A tool that stores it twice can fail the restore or leave a half-written file. The hit should leave exactly the tree the task wrote.',
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
    why: 'Overlapping patterns within one task, common in framework configs, should not stop it from replaying. A tool that counts a file twice may see a mismatch after its own restore and rerun the task. Then every run after a clean checkout rebuilds work that was already cached. A restore should settle the task.',
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
    why: '`.build/**/*.{js,map,ts}` names three extensions, so a hit restores those files and not `.build/c.css`. A tool that mishandles the brace either drops every file or restores the whole tree. The first leaves a broken build behind a green run; the second brings back files the config never claimed. Explicit patterns decide what is cached.',
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
    why: 'File names with spaces, quotes, backslashes or non-ASCII letters are legal and turn up in assets and tests. A cache must store and restore them exactly. A tool that passes names through a shell or an escaping step can drop, rename or split them, so the restored tree differs from the built one. A file must come back under the name the task gave it.',
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
    why: 'Odd file names should not stop a task from being cached. A tool that fails to store or match them may treat the outputs as missing and rebuild every time. The build stays correct, but a task that never hits costs its full run on every machine. Deleted outputs should be restored, not rebuilt.',
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
    why: 'A large output must restore byte for byte. Incompressible data, like this 6 MB file, takes the paths that compression, chunking or streaming use for big files. A cache that truncates or corrupts it replays a broken artifact under a green run. The executable bit on the script beside it must survive the same trip.',
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
    why: 'A task’s reported time is how long it held up the run, and a retried task held it up for every attempt. Reporting only the last attempt hides the cost of flaky tasks. Time budgets, critical-path estimates and CI dashboards then look better than the build really is. Each attempt counts.',
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
    why: 'A retry may clean up the failed attempt’s outputs, but only the outputs that task declared. Here `p` owns `out/a.txt`, while `q` writes `out/b.txt` into the same folder at the same time. A tool that removes the whole `out` folder before the retry deletes `q`’s file mid-run. One task’s retry must never touch another task’s work.',
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
    why: 'A file’s mode is part of what a task produces, so a hand change to it must be undone. Here the task makes `dist/out.txt` 0644 and someone marks it 0755. A tool that compares only bytes keeps the wrong mode and ships it. Packaging and deploy steps can act on the executable bit, so the run must leave the task’s mode.',
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
    why: 'Empty directories under a root output tree are part of the task’s result, just as under a project’s outputs. A hit must bring back `gen/empty` along with `gen/real.txt`. A tool that stores only files, or handles root outputs on a separate path, drops it. A later step that writes into it then fails only on machines that replayed.',
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
    why: 'A root output folder the task left empty is part of its outputs, so a file dropped into it is a stray. The next run must remove it, as it would under a project’s outputs. A tool that cleans only project trees leaves the stray at the workspace root, where it ships or leaks into later steps. The empty folder itself stays.',
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
    why: 'A cache entry holds what the task made, not what older builds left behind. `gen/old` predates the run, so it must not be stored or restored. A tool that captures every folder under a root output tree recreates it on every hit, on every machine. Old layouts then outlive the code that made them.',
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
    why: 'A stray empty folder under a root output tree is not part of the task’s result, so a hit removes it. Left in place, it changes what a later step sees, such as a glob that now matches or a package that ships an extra folder. Root outputs should be cleaned the same way as project outputs.',
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
    why: 'A restore must repair every kind of damage at once: an edited file, a file replaced by a directory, and a stray tree. A tool may handle each alone yet fail on the mix, for example by writing a file into a path a directory still holds. The run then goes red, or leaves part of the damage. The end tree must match a fresh run.',
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
    why: 'What a cache stores for a task must not change after the task ends. A cache that hard-links or shares its stored copy with the working tree lets a later edit to the tree rewrite the entry. Every later hit then replays the edit instead of the build. Edits after a build or a restore must stay local.',
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
    why: 'An uncached task that writes a file inside its own inputs changes those inputs the first time it runs. Its dependants may then miss once more, since their keys follow the dependency’s inputs. After that the file is stable, so by the third run the cached task must replay. A tool that never settles reruns the dependant on every build.',
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
    why: 'A file git ignores is local state, not a declared input, so an uncached task writing one changes no key. The cached task that depends on it should replay on the second run, its output still holding what the dependency wrote. A tool that counts the ignored file, or treats every uncached dependency as changed, reruns the dependant on every build.',
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
