// Cases drawn from vx fixes of November 2026: each guards a behaviour a
// bug once broke, written so any task runner can be held to it.
import { defineCase, type TaskSpec, type WorkspaceSpec } from '../src/spec.ts'
import { CONCAT, one, out } from './shapes.ts'

const build = (extra: Partial<TaskSpec> = {}): TaskSpec => ({
  command: CONCAT,
  inputs: ['src/**'],
  outputs: ['dist/**'],
  ...extra,
})

/** Projects at these directories, each with a cached build of its sources. */
const atDirs = (dirs: Record<string, string>): WorkspaceSpec => ({
  projects: Object.fromEntries(
    Object.entries(dirs).map(([name, dir]) => [
      name,
      { dir, tasks: { build: build() }, files: { 'src/a.txt': `${name}\n` } },
    ]),
  ),
})

/** lib writes `gen/a.js` (its declared output) and `gen/note.txt` (not one); app reads `read`, isolated. */
const besideOutputs = (read: string): WorkspaceSpec => ({
  projects: {
    lib: {
      tasks: {
        build: {
          command: 'mkdir -p gen && echo a > gen/a.js && echo n > gen/note.txt',
          inputs: ['src/**'],
          outputs: ['gen/**/*.js'],
        },
      },
      files: { 'src/a.txt': 'a\n' },
    },
    // A task edge, no package dependency: app installs nothing of lib.
    app: {
      tasks: {
        build: build({
          command: `mkdir -p dist && cat ../lib/gen/${read} > dist/out.txt`,
          dependsOn: ['lib#build'],
          sandbox: {},
        }),
      },
      files: { 'src/a.txt': 'a\n' },
    },
  },
})

const A = 'packages/a/src/a.txt'

export default [
  defineCase({
    id: 'outputs/retry-saves-only-the-passing-attempt',
    category: 'outputs',
    kind: 'correctness',
    title: 'A file only a failed attempt wrote is not saved with the retry that passed',
    why: 'The stored result should be what a passing run produces. Here the first attempt writes `dist/stale.txt` and fails; the retry writes only `dist/out.txt` and passes. A tool that saves everything under `dist` stores the failed attempt’s leftover as part of a good build and restores it on every hit.',
    from: ['retries', 'overlapping-outputs'],
    needs: ['retries'],
    workspace: one(
      build({
        command:
          'mkdir -p dist; if [ -e tried ]; then cat src/a.txt > dist/out.txt; else touch tried; echo stale > dist/stale.txt; exit 1; fi',
        retries: 1,
      }),
      { 'src/a.txt': 'a\n', '.gitignore': 'tried\n' },
    ),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [out('a')]: null, 'packages/a/dist/stale.txt': null } },
      {
        run: 'build',
        expect: { exit: 0, files: { [out('a')]: 'a\n', 'packages/a/dist/stale.txt': null } },
      },
    ],
  }),

  defineCase({
    id: 'inputs/runtime-command-child-does-not-hold-the-run',
    category: 'inputs',
    kind: 'correctness',
    title: 'A key command that leaves a background child running does not hold up the run',
    why: 'A key command is done once its shell exits and its answer is printed. A child it started in the background, such as a daemon a version check wakes, can keep the output pipe open for a long time. A tool that waits for the pipe to close waits on that child, and every run, even one with nothing to do, stalls with it.',
    from: ['runtime-inputs'],
    needs: ['runtime-inputs'],
    workspace: one(build({ runtime: ['sleep 60 & echo v1'] })),
    steps: [{ run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\n' }, within: 30 } }],
  }),

  defineCase({
    id: 'env/inherited-ifs-does-not-split-words',
    category: 'env',
    kind: 'correctness',
    title: 'An `IFS` in the runner’s environment does not change how a task’s shell splits words',
    why: 'A task command is a shell command, and a fresh `sh` sets `IFS` to space, tab and newline whatever its environment says. A tool that hands the command to a shell that kept an inherited `IFS` splits words differently. The same command under the same key then prints different output depending on who started the run.',
    from: ['warm-shell'],
    workspace: one(
      build({ command: 'mkdir -p dist && X=a:b; set -- $X; echo "$#" > dist/out.txt' }),
    ),
    steps: [{ run: 'build', env: { IFS: ':' }, expect: { exit: 0, files: { [out('a')]: '1\n' } } }],
  }),

  defineCase({
    id: 'inputs/project-directory-starting-with-colon',
    category: 'inputs',
    kind: 'correctness',
    title: 'An edit in a project whose directory name starts with `:` runs its task again',
    why: 'A directory name is just a name, and `:top` is a legal one. Git reads a leading `:` in a path argument as special syntax, so a tool that passes the name to git unquoted lists the wrong files or none. The edit then falls outside the key and the stale result is replayed.',
    from: ['git-spawns-once', 'stale-hit-git'],
    workspace: atDirs({ top: 'packages/:top', b: 'packages/b' }),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['top#build', 'b#build'] } },
      { write: { 'packages/:top/src/a.txt': 'top2\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['top#build'],
          notRan: ['b#build'],
          files: { 'packages/:top/dist/out.txt': 'top2\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'inputs/project-directory-with-glob-character',
    category: 'inputs',
    kind: 'efficiency',
    title: 'A project directory named `*g` keys only its own files, not those of `big` beside it',
    why: 'A `*` in a directory name is a literal character. A tool that passes the name to git as a pattern matches `big` too, so an edit in `big` changes the key of `*g` and runs it for nothing. The project’s files are the ones under its own directory, whatever its name looks like.',
    from: ['git-spawns-once', 'stale-hit-git'],
    workspace: atDirs({ star: 'packages/*g', big: 'packages/big' }),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['star#build', 'big#build'] } },
      { write: { 'packages/big/src/a.txt': 'big2\n' } },
      { run: 'build', expect: { exit: 0, ran: ['big#build'], notRan: ['star#build'] } },
      { write: { 'packages/*g/src/a.txt': 'star2\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['star#build'],
          notRan: ['big#build'],
          files: { 'packages/*g/dist/out.txt': 'star2\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'cache/conflicted-input-keys-as-resolved',
    category: 'cache',
    kind: 'efficiency',
    title:
      'An input built during a merge conflict replays once the conflict is resolved with the same bytes',
    why: 'A key is about the bytes a task reads. During a merge conflict git lists the file once per side, but the file on disk is one file. A tool that hashes each listing keys the same bytes differently before and after `git add`, so marking the conflict resolved rebuilds a task whose inputs did not change.',
    from: ['git-oid'],
    workspace: one(build()),
    steps: [
      {
        sh: [
          'git checkout -q -b side',
          `printf 'side\\n' > ${A}`,
          'git commit -qam side',
          'git checkout -q -',
          `printf 'main\\n' > ${A}`,
          'git commit -qam main',
          '! git merge -q side',
        ].join(' && '),
      },
      { write: { [A]: 'fixed\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'fixed\n' } } },
      { sh: `git add ${A}` },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'sandbox/dependency-output-read-passes',
    category: 'sandbox',
    kind: 'correctness',
    title: 'An isolated task may read the outputs of a task it depends on',
    why: 'Reading what a dependency built is the reason to depend on it, and those outputs fold into the task’s key through the dependency. Refusing the read makes isolation unusable for every build that consumes another project. The grant is the dependency’s declared outputs.',
    from: ['sandbox-request'],
    needs: ['sandbox'],
    workspace: besideOutputs('a.js'),
    steps: [{ run: 'build', expect: { exit: 0, files: { [out('app')]: 'a\n' } } }],
  }),

  defineCase({
    id: 'sandbox/read-beside-dependency-output-fails',
    category: 'sandbox',
    kind: 'correctness',
    title: 'An isolated task that reads a dependency file beside its declared outputs fails',
    why: 'The dependency declared `gen/**/*.js` as its outputs, so only those files are what it hands on. `gen/note.txt` sits in the same folder but nothing keys it: an edit to it would replay the dependant’s stale result. Granting the whole folder hides that gap, so the read must fail.',
    from: ['sandbox-request'],
    needs: ['sandbox'],
    workspace: besideOutputs('note.txt'),
    steps: [{ run: 'build', expect: { exit: 'fail' } }],
  }),

  defineCase({
    id: 'affected/own-untracked-output-selects-nothing',
    category: 'affected',
    kind: 'efficiency',
    title: 'Outputs a task wrote and git does not track do not make its project affected',
    why: 'Running a build leaves its outputs in the tree, often without a `.gitignore` line for them. Those files are what the task produced, not a change anyone made. A tool that reads them as new sources selects every project that was built once, and an affected run turns into a full one.',
    from: ['affected', 'affected-dry-reasons'],
    needs: ['affected'],
    workspace: one(build({ inputs: ['**'] })),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\n' } } },
      { affected: 'build', base: 'HEAD', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),
  defineCase({
    id: 'env/variable-named-proto-reaches-task',
    category: 'env',
    kind: 'correctness',
    title: 'A declared variable named `__proto__` reaches the task and keys it',
    why: '`__proto__` is a legal variable name. A tool that builds the task’s environment as a plain JavaScript object sets the object’s prototype instead of a variable, so the task never sees it while the key still counts it. The task then runs without a value the key says it had.',
    from: ['env'],
    needs: ['env-inputs'],
    workspace: one(
      build({
        command: "mkdir -p dist && env | sed -n 's/^__proto__=//p' > dist/out.txt",
        env: ['__proto__'],
      }),
    ),
    steps: [
      {
        run: 'build',
        env: { ['__proto__']: 'v1' },
        expect: { exit: 0, files: { [out('a')]: 'v1\n' } },
      },
      {
        run: 'build',
        env: { ['__proto__']: 'v2' },
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'v2\n' } },
      },
    ],
  }),
  defineCase({
    id: 'inputs/brace-holding-escaped-brackets',
    category: 'inputs',
    kind: 'correctness',
    title: 'A brace input naming `src` and the escaped `app/\\[id\\]` keys both directories',
    why: 'Next.js routes live in folders like `app/[id]`, so a glob must escape the brackets to name the folder. `{src,app/\\[id\\]}` names two directories, each a tree of inputs. A tool that stops expanding the brace once it sees an escape matches neither, so an edit to the route replays a stale build.',
    from: ['util-paths'],
    workspace: one(
      build({
        command: "mkdir -p dist && cat src/a.txt 'app/[id]/page.txt' > dist/out.txt",
        inputs: ['{src,app/\\[id\\]}'],
      }),
      { 'src/a.txt': 'a\n', 'app/[id]/page.txt': 'p1\n' },
    ),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\np1\n' } } },
      { write: { 'packages/a/app/[id]/page.txt': 'p2\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'a\np2\n' } } },
      { write: { [A]: 'a2\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'a2\np2\n' } } },
    ],
  }),

  defineCase({
    id: 'outputs/brace-holding-escaped-brackets',
    category: 'outputs',
    kind: 'correctness',
    title: 'A brace output whose alternative escapes `[` and `]` restores both trees',
    why: '`{dist,app/\\[id\\]}/**` names two output trees, one of them a folder with brackets in its name. A tool that stops expanding the brace once it sees an escape saves neither. A hit then restores nothing and the build looks done while its files are missing.',
    from: ['util-paths'],
    workspace: one(
      build({
        command:
          "mkdir -p dist 'app/[id]' && cat src/a.txt > dist/out.txt && cat src/a.txt > 'app/[id]/gen.txt'",
        outputs: ['{dist,app/\\[id\\]}/**'],
      }),
    ),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/dist': null, 'packages/a/app': null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: { [out('a')]: 'a\n', 'packages/a/app/[id]/gen.txt': 'a\n' },
        },
      },
    ],
  }),
  defineCase({
    id: 'sandbox/other-project-read-through-git-fails',
    category: 'sandbox',
    kind: 'correctness',
    title: 'An isolated task that reads another project’s file through git fails',
    why: 'Git’s object store holds every committed file of every project. A task that runs `git show` against it reads another project’s source without touching that project’s folder, and nothing keys the file. Walling off the folders but not the repository leaves the same stale-hit hole open through git.',
    from: ['sandbox-grants.unsafe'],
    needs: ['sandbox'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: build({
              command:
                'mkdir -p dist && git --git-dir=../../.git show HEAD:packages/b/src/b.txt > dist/out.txt',
              sandbox: {},
            }),
          },
          files: { 'src/a.txt': 'a\n' },
        },
        b: { files: { 'src/b.txt': 'b\n' } },
      },
    },
    steps: [{ run: 'build', expect: { exit: 'fail' } }],
  }),
]
