// What a workspace may say and what a tool must do with it: manifests,
// task values, dependsOn entries, task names, glob and variable spellings.
// A value no reading can make right is refused before anything runs; a
// value with one sensible reading is honoured, or refused, but never
// silently dropped. Drawn from Turborepo's crates/turborepo/tests
// (invalid_package_json_test.rs, absolute_path_error_test.rs,
// unnamed_packages_test.rs, path_with_spaces_test.rs) and
// crates/turborepo-repository (package_json.rs, discovery), Nx's
// project-graph and target validation, moon's crates/config tests, and
// vx's own config-schema, discovery and timeout tests.
import {
  defineCase,
  type Case,
  type Expect,
  type Feature,
  type Step,
  type TaskSpec,
  type WorkspaceSpec,
} from '../src/spec.ts'

const A = 'packages/a'
const OUT = `${A}/dist/out.txt`
const BUILD: TaskSpec = {
  command: 'mkdir -p dist && cat src/*.txt > dist/out.txt',
  inputs: ['src/**'],
  outputs: ['dist/**'],
}
const SCHEMA = ['config-schema-refusals', 'config-refusals-pinned']
const DISCOVERY = ['discovery-refusals', 'package-json-bom']

interface Head {
  slug: string
  title: string
  why: string
  from?: string[]
  needs?: Feature[]
}

function make(
  h: Head,
  workspace: WorkspaceSpec,
  steps: Step[],
  kind: Case['kind'] = 'correctness',
) {
  return defineCase({
    id: `config/${h.slug}`,
    category: 'config',
    kind,
    title: h.title,
    why: h.why,
    from: h.from ?? SCHEMA,
    ...(h.needs ? { needs: h.needs } : {}),
    workspace,
    steps,
  })
}

/**
 * Project `a`'s build over `inputs`, its command reading `reads`: after
 * `edit` changes a file, the build runs again with the new bytes, or the
 * tool refused the inputs from the start. A replay of the old result fails.
 */
function keyedOrRefused(
  h: Head,
  inputs: string[],
  edit: string,
  opts: { reads?: string; sibling?: true } = {},
): Case {
  const reads = opts.reads ?? edit.replace(`${A}/`, '')
  return make(
    h,
    {
      projects: {
        a: {
          tasks: {
            build: {
              command: `mkdir -p dist && cat ${reads} > dist/out.txt`,
              inputs,
              outputs: ['dist/**'],
            },
          },
          files: { [opts.sibling ? 'src/a.txt' : reads]: 'one\n' },
        },
        ...(opts.sibling ? { b: { files: { 'src/a.txt': 'one\n' } } } : {}),
      },
    },
    [
      { run: 'build', expect: { exit: 0, orRefused: true } },
      { write: { [edit]: 'two\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'two\n' }, orRefused: true },
      },
    ],
  )
}

/** `lib` ← `app`, `app`'s package.json written as `manifest` (it names lib): both build, lib first. */
function goodManifest(h: Head, manifest: string, from = DISCOVERY): Case {
  return make(
    { ...h, from: h.from ?? from },
    {
      projects: {
        lib: { tasks: { build: BUILD }, files: { 'src/a.txt': 'lib\n' } },
        app: {
          deps: ['lib'],
          tasks: {
            build: {
              ...BUILD,
              command: 'mkdir -p dist && cat ../lib/dist/out.txt src/*.txt > dist/out.txt',
              dependsOn: ['^build'],
            },
          },
          files: { 'src/a.txt': 'app\n', 'package.json': manifest },
        },
      },
    },
    [
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['lib#build', 'app#build'],
          order: [['lib#build', 'app#build']],
          files: { 'packages/app/dist/out.txt': 'lib\napp\n' },
        },
      },
    ],
  )
}

const appManifest = (extra: Record<string, unknown> = {}) =>
  JSON.stringify(
    {
      name: 'app',
      version: '0.0.0',
      private: true,
      dependencies: { lib: 'workspace:*' },
      ...extra,
    },
    null,
    2,
  )

/** `gen` then `build` in project `a`, build's dependsOn holding `dep`. */
function dependsOnWs(dep: string[]): WorkspaceSpec {
  return {
    projects: {
      a: {
        tasks: {
          gen: {
            command: 'mkdir -p gen && echo gen > gen/g.txt',
            inputs: ['src/**'],
            outputs: ['gen/**'],
          },
          build: {
            command: 'mkdir -p dist && cat gen/g.txt src/*.txt > dist/out.txt',
            dependsOn: dep,
            inputs: ['src/**'],
            outputs: ['dist/**'],
          },
        },
        files: { 'src/a.txt': 'a\n' },
      },
    },
  }
}

const GEN_THEN_BUILD: Expect = {
  exit: 0,
  ran: ['a#gen', 'a#build'],
  order: [['a#gen', 'a#build']],
  files: { [OUT]: 'gen\na\n' },
}

export default [
  goodManifest(
    {
      slug: 'manifest-with-comments-read-or-refused',
      title: 'A package.json holding comments is read with its edges, or the run fails',
      why: 'Bun reads package.json as JSON with comments; npm and strict parsers refuse it. A task runner may take either side. What it must not do is skip the file and build the app before the library it names.',
    },
    `// app\n${appManifest()}`,
  ),

  make(
    {
      slug: 'names-differing-in-case-are-two-projects',
      title: 'Projects named `a` and `A` are two projects: selecting `a` runs only its task',
      why: 'npm names are case-sensitive in a workspace, and two directories can hold `a` and `A`. A tool that folds case merges them, refusing the workspace as a duplicate or running both when one is asked for. Selecting `a` runs `a` alone.',
      from: ['discovery-refusals', 'workspace-path-chars'],
      needs: ['filter'],
    },
    {
      projects: {
        a: { tasks: { build: BUILD }, files: { 'src/a.txt': 'a\n' } },
        A: { dir: 'packages/upper', tasks: { build: BUILD }, files: { 'src/a.txt': 'A\n' } },
      },
    },
    [
      {
        run: 'build',
        projects: ['a'],
        expect: {
          exit: 0,
          ran: ['a#build'],
          notRan: ['A#build'],
          files: { [OUT]: 'a\n', 'packages/upper/dist/out.txt': null },
        },
      },
    ],
  ),

  make(
    {
      slug: 'depends-on-repeated-entry-runs-once',
      title: 'A task listed twice in dependsOn runs once, before its dependant',
      why: 'A list built by spreading two shared presets often names a task twice. It is one edge, and the task runs once. A tool that schedules each entry runs it twice, racing two writers into one output, or refuses a harmless list.',
      from: ['task-graph-properties'],
    },
    dependsOnWs(['gen', 'gen']),
    [{ run: 'build', expect: GEN_THEN_BUILD }],
  ),

  make(
    {
      slug: 'depends-on-two-spellings-runs-once',
      title: '`gen` and `a#gen` in one dependsOn run the task once',
      why: 'Inside project `a`, `gen` and `a#gen` name the same task. A tool that dedups entries by their text, not by what they resolve to, runs it twice. It runs once, before the build.',
      from: ['task-graph-properties'],
    },
    dependsOnWs(['gen', 'a#gen']),
    [{ run: 'build', expect: GEN_THEN_BUILD }],
  ),

  make(
    {
      slug: 'depends-on-own-project-by-full-name',
      title: '`a#gen` in project a’s own dependsOn runs its gen first',
      why: 'A project may name its own task the long way, as a generated config does. It is the same edge as `gen`. A tool that reads `project#task` only as a cross-project edge may refuse it or skip it; gen runs first.',
      from: ['task-graph-properties'],
    },
    dependsOnWs(['a#gen']),
    [{ run: 'build', expect: GEN_THEN_BUILD }],
  ),

  make(
    {
      slug: 'depends-on-caret-and-explicit-runs-once',
      title: '`^build` and `lib#build` in one dependsOn build the library once',
      why: 'When `app` depends on `lib`, `^build` and `lib#build` both reach lib’s build. It is one task, run once, before the app. A tool that adds an edge per entry builds lib twice, the second time racing the app that reads it.',
      from: ['task-graph-properties'],
    },
    {
      projects: {
        lib: { tasks: { build: BUILD }, files: { 'src/a.txt': 'lib\n' } },
        app: {
          deps: ['lib'],
          tasks: {
            build: {
              ...BUILD,
              command: 'mkdir -p dist && cat ../lib/dist/out.txt src/*.txt > dist/out.txt',
              dependsOn: ['^build', 'lib#build'],
            },
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    [
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['lib#build', 'app#build'],
          order: [['lib#build', 'app#build']],
          files: { 'packages/app/dist/out.txt': 'lib\napp\n' },
        },
      },
    ],
  ),

  make(
    {
      slug: 'task-names-differing-in-case-are-two-tasks',
      title: 'Tasks named `build` and `Build` are two tasks: asking for one runs only it',
      why: 'Names are case-sensitive in package.json scripts and in every task runner’s config. A tool that folds case runs both, or refuses them as duplicates. Asking for `Build` runs `Build` alone.',
      from: ['cli-task-names', 'config-schema-refusals'],
    },
    {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'echo lower > lower.txt',
              outputs: ['lower.txt'],
              inputs: ['src/**'],
            },
            Build: {
              command: 'echo upper > upper.txt',
              outputs: ['upper.txt'],
              inputs: ['src/**'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    [
      {
        run: 'Build',
        expect: {
          exit: 0,
          ran: ['a#Build'],
          notRan: ['a#build'],
          files: { [`${A}/upper.txt`]: 'upper\n', [`${A}/lower.txt`]: null },
        },
      },
    ],
  ),

  keyedOrRefused(
    {
      slug: 'input-climbing-into-sibling-keyed-or-refused',
      title: 'An input `../b/src/**` keys an edit there, or is refused',
      why: 'A glob climbing out of the project reads another project’s files with no edge to order them. Some tools refuse it, holding that project boundaries are hard; some follow it. Both are defensible. Leaving it in the config and keying nothing through it replays a stale result after the sibling changes.',
      from: ['nested-boundary', 'lockfile-boundary', 'config-schema-refusals'],
    },
    ['src/**', '../b/src/**'],
    'packages/b/src/a.txt',
    { reads: '../b/src/a.txt', sibling: true },
  ),

  keyedOrRefused(
    {
      slug: 'input-surrounding-space-keyed-or-refused',
      title: 'An input ` src/**` with a stray space keys an edit under src, or is refused',
      why: 'A leading space in a glob is almost always a slip. Read literally it matches a directory named ` src` that does not exist, and the task keys on nothing: every edit replays the old result. Trimming it or refusing it is right; keying nothing is not.',
      from: ['config-schema-refusals', 'contract-task-globs'],
    },
    [' src/**'],
    `${A}/src/a.txt`,
  ),

  keyedOrRefused(
    {
      slug: 'input-glued-globstar-keyed-or-refused',
      title: 'An input `src/**.txt` keys an edit two folders deep, or is refused',
      why: 'Users write `**.txt` meaning any depth. Many glob engines read `**` glued to text as `*`, keying only files directly in src, so a deep edit replays a stale build (vercel/turborepo#5431). Keying the deep file, or refusing the spelling, is right.',
      from: ['config-schema-refusals', 'contract-task-globs'],
    },
    ['src/**.txt'],
    `${A}/src/x/y/a.txt`,
  ),

  keyedOrRefused(
    {
      slug: 'input-backwards-range-keyed-or-refused',
      title: 'An input `src/[z-a].txt` keys an edit to `src/m.txt`, or is refused',
      why: 'A range written backwards is a typo for the forward one. Most engines make it match nothing, so the task keys no file and every edit replays the old result. Reading it as `a-z` or refusing it is right; keying nothing is not.',
      from: ['config-schema-refusals', 'inputs-glob-fuzz'],
    },
    ['src/[z-a].txt'],
    `${A}/src/m.txt`,
  ),

  keyedOrRefused(
    {
      slug: 'input-brace-explosion-keyed-or-refused',
      title: 'An input whose braces expand to 2048 patterns keys a match, or is refused',
      why: 'Eleven `{a,b}` groups in a row expand to 2048 alternatives. A tool may expand them or refuse a pattern that large, but one that gives up silently keys nothing and replays a stale build. The edited match runs the task again, or the run is refused.',
      from: ['config-schema-refusals', 'inputs-glob-fuzz'],
    },
    [`src/${'{a,b}'.repeat(11)}.txt`],
    `${A}/src/abababababa.txt`,
  ),

  keyedOrRefused(
    {
      slug: 'input-negated-then-named-keyed-or-refused',
      title:
        'A file named outright after a `!` that takes its folder back keys its edits, or is refused',
      why: 'With `src/**`, `!src/gen/**` and `src/gen/keep.txt`, the user named the file on purpose. A tool where `!` subtracts wherever it sits drops it silently, and an edit to it replays a stale build. Keying it, as gitignore order does, or refusing the contradiction, is right.',
      from: ['config-schema-refusals', 'contract-task-globs'],
    },
    ['src/**', '!src/gen/**', 'src/gen/keep.txt'],
    `${A}/src/gen/keep.txt`,
  ),

  keyedOrRefused(
    {
      slug: 'input-climb-and-return-keyed-or-refused',
      title: 'An input `src/../src/a.txt` keys the file it names, or is refused',
      why: 'The path climbs out of src and back in, so it names `src/a.txt`. A tool matching it as text against walked paths finds nothing and keys no file. Normalising it, or refusing the `..`, is right; replaying after an edit is not.',
      from: ['config-schema-refusals', 'dot-slash-globs'],
    },
    ['src/../src/a.txt'],
    `${A}/src/a.txt`,
  ),

  keyedOrRefused(
    {
      slug: 'input-bare-directory-keyed-or-refused',
      title: 'An input naming a directory, `src`, keys an edit inside it, or is refused',
      why: 'Writing a folder’s name means its contents to most users. A tool that matches only the directory entry keys a timestamp or nothing, and an edit inside replays the old build. Reading it as the whole folder, or refusing it, is right.',
      from: ['config-schema-refusals', 'contract-task-globs'],
    },
    ['src'],
    `${A}/src/a.txt`,
  ),

  keyedOrRefused(
    {
      slug: 'input-trailing-slash-keyed-or-refused',
      title: 'An input `src/` with a trailing slash keys an edit inside it, or is refused',
      why: 'A trailing slash says “this is a directory”, as gitignore reads it. A tool that matches files against `src/` literally finds none and keys nothing. Reading it as the folder’s contents, or refusing it, is right; a stale replay is not.',
      from: ['config-schema-refusals', 'contract-task-globs'],
    },
    ['src/'],
    `${A}/src/a.txt`,
  ),

  make(
    {
      slug: 'input-dot-slash-accepted',
      title: 'An input spelled `./src/**` keys an edit under src',
      why: '`./src/**` and `src/**` name the same files; configs copied from a shell or a bundler carry the `./`. A tool that matches the text against paths without it keys nothing and replays every edit. The edit runs the task again.',
      from: ['dot-slash-globs'],
    },
    {
      projects: {
        a: {
          tasks: { build: { ...BUILD, inputs: ['./src/**'] } },
          files: { 'src/a.txt': 'one\n' },
        },
      },
    },
    [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/src/a.txt`]: 'two\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'two\n' } } },
    ],
  ),

  make(
    {
      slug: 'input-listed-twice-keys-and-replays',
      title: 'An input glob listed twice keys an edit, and replays when nothing changed',
      why: 'Inputs merged from two presets often repeat a glob. It is the same set of files. A tool that errors on the duplicate refuses a harmless list, and one that merges pattern results badly can key a file twice or not at all. An edit reruns; the next run replays.',
      from: ['config-schema-refusals', 'contract-task-globs'],
    },
    {
      projects: {
        a: {
          tasks: { build: { ...BUILD, inputs: ['src/**', 'src/**'] } },
          files: { 'src/a.txt': 'one\n' },
        },
      },
    },
    [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/src/a.txt`]: 'two\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'two\n' } } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'], files: { [OUT]: 'two\n' } } },
    ],
  ),

  make(
    {
      slug: 'output-empty-string-never-wipes-sources',
      title: 'An empty string in a task’s outputs fails the run and leaves the sources alone',
      why: 'An empty output pattern can resolve to the project directory itself. A tool that then cleans or restores “the outputs” deletes the sources. Refusing it is right, and so is failing the task for an output that matched nothing; the sources stay either way.',
      from: ['config-schema-refusals', 'contract-task-globs'],
    },
    {
      projects: {
        a: { tasks: { build: { ...BUILD, outputs: [''] } }, files: { 'src/a.txt': 'a\n' } },
      },
    },
    [
      {
        run: 'build',
        expect: { exit: 'fail', files: { [`${A}/src/a.txt`]: 'a\n' }, orRefused: true },
      },
      {
        run: 'build',
        expect: { exit: 'fail', files: { [`${A}/src/a.txt`]: 'a\n' }, orRefused: true },
      },
    ],
  ),

  ...(
    [
      [
        'output-bare-directory-restored-or-refused',
        'dist',
        'An output naming a directory, `dist`, is restored whole, or refused',
        'Writing a folder’s name means its contents. A tool that stores only the directory entry restores an empty folder on a hit and reports success. Restoring the file inside, or refusing the spelling, is right.',
      ],
      [
        'output-trailing-slash-restored-or-refused',
        'dist/',
        'An output `dist/` with a trailing slash is restored whole, or refused',
        'A trailing slash says “this directory”. A tool that matches written files against `dist/` literally stores none of them, and a hit restores nothing while reporting success. Restoring the file inside, or refusing the spelling, is right.',
      ],
    ] as const
  ).map(([slug, glob, title, why]) =>
    make(
      { slug, title, why, from: ['config-schema-refusals', 'contract-task-globs'] },
      {
        projects: {
          a: { tasks: { build: { ...BUILD, outputs: [glob] } }, files: { 'src/a.txt': 'a\n' } },
        },
      },
      [
        { run: 'build', expect: { exit: 0, orRefused: true } },
        { write: { [`${A}/dist`]: null } },
        {
          run: 'build',
          expect: { exit: 0, notRan: ['a#build'], files: { [OUT]: 'a\n' }, orRefused: true },
        },
      ],
    ),
  ),

  make(
    {
      slug: 'output-negated-then-named-restored-or-refused',
      title: 'An output file named outright beside a `!` over its folder is restored, or refused',
      why: 'With `dist/out.txt` and `!dist/**`, the user named the file and excluded its folder. A tool where `!` subtracts wherever it sits never stores the file, then reports a hit and leaves it missing. Storing it or refusing the contradiction is right.',
      from: ['config-schema-refusals', 'contract-task-globs'],
    },
    {
      projects: {
        a: {
          tasks: { build: { ...BUILD, outputs: ['dist/out.txt', '!dist/**'] } },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    [
      { run: 'build', expect: { exit: 0, orRefused: true } },
      { write: { [`${A}/dist`]: null } },
      { run: 'build', expect: { exit: 0, files: { [OUT]: 'a\n' }, orRefused: true } },
    ],
  ),

  make(
    {
      slug: 'env-name-sh-drops-reaches-or-refused',
      title: 'A keyed variable named `A-B` reaches the task, or is refused',
      why: '`A-B` is a legal environment name, but dash, the `sh` of Debian and Ubuntu, drops names that are not shell identifiers before running the command. A tool can pass it some other way or refuse it; what it must not do is key on a value the task never sees. The task prints it, or the run is refused.',
      needs: ['env-inputs'],
    },
    {
      projects: {
        a: {
          tasks: {
            build: {
              ...BUILD,
              command: "mkdir -p dist && env | grep '^A-B=' > dist/out.txt",
              env: ['A-B'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    [
      {
        run: 'build',
        env: { 'A-B': 'one' },
        expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'A-B=one\n' }, orRefused: true },
      },
    ],
  ),

  make(
    {
      slug: 'env-wildcard-keyed-or-refused',
      title:
        'A keyed variable `MODE_*` reruns the task when a matching variable changes, or is refused',
      why: 'Some tools read `*` in a variable name as a wildcard, others as a literal star no variable carries. A tool that takes the literal reading keys nothing and replays after `MODE_X` changes. Expanding it, or refusing the star, is right.',
      needs: ['env-inputs'],
    },
    {
      projects: {
        a: {
          tasks: {
            build: {
              ...BUILD,
              command: 'mkdir -p dist && printf "%s\\n" "$MODE_X" > dist/out.txt',
              env: ['MODE_*'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    [
      { run: 'build', env: { MODE_X: 'one' }, expect: { exit: 0, orRefused: true } },
      {
        run: 'build',
        env: { MODE_X: 'two' },
        expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'two\n' }, orRefused: true },
      },
    ],
  ),

  make(
    {
      slug: 'env-name-surrounding-space-keyed-or-refused',
      title:
        'A keyed variable ` MODE` with a stray space reruns the task when MODE changes, or is refused',
      why: 'No variable is named with a leading space; ` MODE` is a slip for `MODE`. Read literally it keys a value that is always unset, and the task replays after MODE changes. Trimming it or refusing it is right.',
      needs: ['env-inputs'],
    },
    {
      projects: {
        a: {
          tasks: {
            build: {
              ...BUILD,
              command: 'mkdir -p dist && printf "%s\\n" "$MODE" > dist/out.txt',
              env: [' MODE'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    [
      { run: 'build', env: { MODE: 'one' }, expect: { exit: 0, orRefused: true } },
      {
        run: 'build',
        env: { MODE: 'two' },
        expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'two\n' }, orRefused: true },
      },
    ],
  ),

  make(
    {
      slug: 'env-keyed-and-passed-through-keys',
      title:
        'A variable listed both as keyed and as passed through still reruns the task when it changes',
      why: 'A preset passing a variable through and a task keying it can meet in one list. Passing through only says the value reaches the command; keying is the stronger promise. A tool that lets the weaker list win replays a build made with the old value.',
      needs: ['env-inputs', 'pass-through-env'],
    },
    {
      projects: {
        a: {
          tasks: {
            build: {
              ...BUILD,
              command: 'mkdir -p dist && printf "%s\\n" "$MODE" > dist/out.txt',
              env: ['MODE'],
              passThrough: ['MODE'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    [
      { run: 'build', env: { MODE: 'one' }, expect: { exit: 0, orRefused: true } },
      {
        run: 'build',
        env: { MODE: 'two' },
        expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'two\n' }, orRefused: true },
      },
    ],
  ),
] satisfies Case[]

export const pending: Case[] = []
