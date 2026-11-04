// Outputs a user can lose or be handed stale: `!` patterns, links a user
// leaves where outputs go, links a task makes, metadata a clean must never
// reach, trees two tasks share at the workspace root, and the inputs an
// uncached task rewrites ahead of its reader.
import { defineCase, type ProjectSpec, type Step, type TaskSpec } from '../src/spec.ts'

const A = 'packages/a'

/** For each seed: write it at `seedFile`, run `task`, and expect `outFile` to hold it. */
function seeded(seedFile: string, outFile: string, seeds: string[], between: Step[] = []): Step[] {
  return seeds.flatMap((seed): Step[] => [
    ...between,
    { write: { [seedFile]: seed } },
    { run: 'build', expect: { exit: 0, files: { [outFile]: seed } } },
  ])
}
const ABBA = ['A', 'B', 'B', 'A']

/** A build reading `config.json`, which `before` (the task it depends on) leaves. */
const reader = (before: string): TaskSpec => ({
  command: 'mkdir -p dist && cat config.json > dist/out.txt',
  dependsOn: [before],
  inputs: ['config.json'],
  outputs: ['dist/**'],
})
const COPY_SEED = 'cp seed.txt config.json'
/** Runs nothing, caches nothing: a hop between a writer and its reader. */
const QUIET: TaskSpec = { command: 'true', inputs: [], cache: false }

// ---------------------------------------------------------------- negated outputs

const KEEP = { 'out/keep.txt': 'K1', 'out/sub/fixture.txt': 'F1' }
const NEGATED: TaskSpec = {
  command:
    'mkdir -p out/sub && cp src/a.txt out/a.js && echo g > out/sub/gen.js && echo t > out/scratch.tmp',
  inputs: ['src/**', 'out/keep.txt'],
  outputs: ['out/**', '!out/keep.txt', '!out/sub/fixture.txt', '!**/*.tmp'],
}
const negated = (task: TaskSpec = NEGATED, extra: Partial<ProjectSpec> = {}) => ({
  projects: { a: { tasks: { build: task }, files: { 'src/a.txt': 'A1', ...KEEP }, ...extra } },
})

/** `build` fills `out`, `types` adds to it: the edge-ordered pair, each with `!` entries. */
function negatedPair(buildOutputs: string[], types: TaskSpec) {
  return {
    sharedOutputs: true,
    projects: {
      a: {
        tasks: {
          build: {
            command: 'mkdir -p out && cp src/a.txt out/a.js',
            inputs: ['src/**'],
            outputs: buildOutputs,
          },
          types: { ...types, dependsOn: ['build'], inputs: ['src/**'] },
        },
        files: { 'src/a.txt': 'A1', ...KEEP },
      },
    },
  }
}

// ---------------------------------------------------------------- links

/** One project whose build writes `x` into `entry`. */
function writing(entry: string, outputs = ['dist/**']) {
  const dir = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/')) : '.'
  return {
    projects: {
      a: {
        tasks: {
          build: {
            command: `mkdir -p ${dir} && cat src/x.txt > ${entry}`,
            inputs: ['src/**'],
            outputs,
          },
        },
        files: { 'src/x.txt': 'x' },
      },
    },
  }
}

const linkedBuild = (command: string): TaskSpec => ({
  command: `rm -rf dist && mkdir -p dist && ${command}`,
  inputs: ['src/**'],
  outputs: ['dist/**'],
})

const DEEP = ['a', 'b', 'c'].map((c) => c.repeat(100)).join('/')

interface InsideShape {
  slug: string
  where: string
  entry: string
  outputs?: string[]
  remove: string
  links: [string, string][]
  lands: string
}
const INSIDE: InsideShape[] = [
  {
    slug: 'root',
    where: 'at the output directory',
    entry: 'dist/o.txt',
    remove: 'dist',
    links: [['dist', 'real-out']],
    lands: 'real-out/o.txt',
  },
  {
    slug: 'below-root',
    where: 'below the output directory',
    entry: 'dist/sub/o.txt',
    outputs: ['dist/sub/o.txt'],
    remove: 'dist/sub',
    links: [['dist/sub', '../real-sub']],
    lands: 'real-sub/o.txt',
  },
  {
    slug: 'root-above-deeper-entry',
    where: 'at the output directory, above a deeper output',
    entry: 'dist/sub/o.txt',
    remove: 'dist',
    links: [['dist', 'real-out']],
    lands: 'real-out/sub/o.txt',
  },
  {
    slug: 'chain',
    where: 'through a chain of links',
    entry: 'dist/o.txt',
    remove: 'dist',
    links: [
      ['hop', 'real-out'],
      ['dist', 'hop'],
    ],
    lands: 'real-out/o.txt',
  },
]

interface OutsideShape {
  slug: string
  where: string
  entry: string
  outputs?: string[]
  remove: string
  links: [string, string][]
  gone: string
}
const OUTSIDE: OutsideShape[] = [
  {
    slug: 'root',
    where: 'at the output directory',
    entry: 'dist/o.txt',
    remove: 'dist',
    links: [['dist', '../../outside/gone']],
    gone: 'outside/gone',
  },
  {
    slug: 'below-root',
    where: 'below the output directory',
    entry: 'dist/sub/o.txt',
    outputs: ['dist/sub/o.txt'],
    remove: 'dist/sub',
    links: [['dist/sub', '../../../outside/gone']],
    gone: 'outside/gone',
  },
  {
    slug: 'root-above-deeper-entry',
    where: 'at the output directory, above a deeper output',
    entry: 'dist/sub/o.txt',
    remove: 'dist',
    links: [['dist', '../../outside/gone']],
    gone: 'outside/gone',
  },
  {
    slug: 'chain',
    where: 'as the last hop of a chain',
    entry: 'dist/o.txt',
    remove: 'dist',
    links: [
      ['hop', '../../outside/gone'],
      ['dist', 'hop'],
    ],
    gone: 'outside/gone',
  },
  {
    slug: 'relative',
    where: 'relatively, up out of the project',
    entry: 'dist/o.txt',
    remove: 'dist',
    links: [['dist', '../gone']],
    gone: 'packages/gone',
  },
]

const at = (links: [string, string][]) =>
  Object.fromEntries(links.map(([p, t]) => [`${A}/${p}`, t]))

// ---------------------------------------------------------------- git metadata

const HEAD = { '.git/HEAD': 'ref: refs/heads/main\n' }
const REPO = { dirs: ['.git/objects', '.git/refs/heads'] }
/** Each source state, run, and the repository is still whole. */
const repoKept = (src: string, link: Step): Step[] => [
  link,
  { run: 'build', expect: { files: HEAD } },
  { check: REPO },
  { write: { [`${src}/a.txt`]: 'b\n' } },
  { run: 'build', expect: { files: HEAD } },
  { check: REPO },
  { write: { [`${src}/a.txt`]: 'a\n' } },
  { run: 'build', expect: { files: HEAD } },
  { check: REPO },
]

// ---------------------------------------------------------------- shared trees at the root

/** `build` writes gen/a.txt at the workspace root; `individual` adds to gen after it. */
function rootPair(individual: TaskSpec, buildCommand?: string) {
  return {
    sharedOutputs: true,
    projects: {
      a: {
        tasks: {
          build: {
            command: buildCommand ?? 'mkdir -p ../../gen && cp src/a.txt ../../gen/a.txt',
            inputs: ['src/**'],
            outputs: [],
            rootOutputs: ['gen'],
          },
          individual: { ...individual, dependsOn: ['build'], outputs: [] },
        },
        files: { 'src/a.txt': 'A1', 'srcb/b.txt': 'B1' },
      },
    },
  }
}
const ADDS_SUBDIR: TaskSpec = {
  command: 'mkdir -p ../../gen/individual && cp srcb/b.txt ../../gen/individual/b.txt',
  inputs: ['srcb/**'],
  rootOutputs: ['gen/individual'],
}

/** a#build writes into b's dist from the root; b#build adds its own file after it. */
const crossProjectPair = {
  sharedOutputs: true,
  projects: {
    a: {
      tasks: {
        build: {
          command: 'mkdir -p ../b/dist && cp src/a.txt ../b/dist/a.txt',
          inputs: ['src/**'],
          outputs: [],
          rootOutputs: ['packages/b/dist'],
        },
      },
      files: { 'src/a.txt': 'A1' },
    },
    b: {
      deps: ['a'],
      tasks: {
        build: {
          command: 'cp src/b.txt dist/b.txt',
          dependsOn: ['^build'],
          inputs: ['src/**'],
          outputs: ['dist'],
        },
      },
      files: { 'src/b.txt': 'B1' },
    },
  },
}

// ---------------------------------------------------------------- other projects' keys

/** app's cached test depends on ui's tasks; other is a project nothing depends on. */
function keyedThrough(ui: Record<string, TaskSpec>, dependsOn: string) {
  return {
    projects: {
      ui: { tasks: ui, files: { 'src/index.js': 'ui 1\n' } },
      other: { files: { 'src/index.js': 'other 1\n' } },
      app: {
        deps: ['ui'],
        tasks: {
          test: { command: 'true', dependsOn: [dependsOn], inputs: ['src/**'], outputs: [] },
        },
        files: { 'src/index.js': 'app 1\n' },
      },
    },
  }
}
const UNCACHED_UI = { bare: { command: 'true', inputs: ['src/**'], cache: false } }

const FILE_MODE_OFF = ['false', 'no', 'off', '0', '', '00']

export default [
  // ------------------------------------------------ an uncached writer ahead of its reader
  defineCase({
    id: 'inputs/uncached-writer-ahead-of-reader',
    category: 'inputs',
    kind: 'correctness',
    needs: ['uncached-task'],
    title:
      'A task reading a file an uncached task before it writes builds from the bytes written this run',
    why: 'A task’s key reflects the bytes it reads when it runs, not the bytes on disk when the run started. Here an uncached task rewrites `config.json` just before the reader. Keyed from the file as the run found it, the reader replays the previous seed’s output, so the build ships old config under a green run.',
    from: ['undeclared-writes'],
    workspace: {
      projects: {
        a: { tasks: { gen: { command: COPY_SEED, cache: false }, build: reader('gen') } },
      },
    },
    steps: seeded(`${A}/seed.txt`, `${A}/dist/out.txt`, ABBA),
  }),

  defineCase({
    id: 'inputs/uncached-writer-rewrites-committed-input',
    category: 'inputs',
    kind: 'correctness',
    needs: ['uncached-task'],
    title:
      'A committed file an uncached task rewrites ahead of its reader keys the reader on the new bytes',
    why: 'A committed, clean file can still change during a run. Here `config.json` is clean in git at the start, but an uncached task overwrites it before the reader runs. Keying the reader from git’s committed content instead of the bytes it reads replays the output of a different config, and the run stays green.',
    from: ['undeclared-writes'],
    workspace: {
      projects: {
        a: {
          tasks: { gen: { command: COPY_SEED, cache: false }, build: reader('gen') },
          files: { 'config.json': 'X' },
        },
      },
    },
    steps: seeded(
      `${A}/seed.txt`,
      `${A}/dist/out.txt`,
      ['A', 'B', 'A'],
      [{ write: { [`${A}/config.json`]: 'X' } }],
    ),
  }),

  defineCase({
    id: 'inputs/uncached-writer-rewrites-manifest',
    category: 'inputs',
    kind: 'correctness',
    needs: ['uncached-task'],
    title:
      'A package.json listed as an input and rewritten by an uncached task before its reader keys the reader on the new bytes',
    why: 'A `package.json` named in the inputs is an input like any other, even though a tool also reads it as a manifest. Here an uncached task rewrites it before the reader. Keying from the copy read at startup replays output built from an older manifest, so a stale version field ships under a green run.',
    from: ['undeclared-writes'],
    workspace: {
      projects: {
        a: {
          tasks: {
            gen: {
              command: `sed 's/"name"/"v": "'"$(cat seed.txt)"'", "name"/' package.json > p.tmp && mv p.tmp package.json`,
              cache: false,
            },
            build: {
              command: `mkdir -p dist && grep -o '"v": "[^"]*"' package.json > dist/out.txt`,
              dependsOn: ['gen'],
              inputs: ['src/**', 'package.json'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a\n', '.gitignore': 'seed.txt\n' },
        },
      },
    },
    steps: ['1', '2', '1'].flatMap((v): Step[] => [
      { write: { [`${A}/seed.txt`]: v } },
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: `"v": "${v}"\n` } } },
      { sh: `git checkout -- ${A}/package.json` },
    ]),
  }),

  defineCase({
    id: 'inputs/uncached-writer-in-dependency-root-input',
    category: 'inputs',
    kind: 'correctness',
    needs: ['uncached-task'],
    title:
      'A root input in a dependency that an uncached task there rewrites keys the dependant on the new bytes',
    why: 'An input is keyed from what it holds when the task runs, even when it lives in another project and that project’s task writes it. Here `lib`’s uncached `gen` rewrites `lib/config.json` before `app` reads it. Keying `app` from the bytes at the start of the run replays output made from a different config.',
    from: ['undeclared-writes'],
    workspace: {
      projects: {
        lib: {
          tasks: { gen: { command: COPY_SEED, cache: false } },
          files: { 'config.json': 'X', '.gitignore': 'seed.txt\n' },
        },
        app: {
          deps: ['lib'],
          tasks: {
            build: {
              command: 'mkdir -p dist && cat ../lib/config.json > dist/out.txt',
              dependsOn: ['^gen'],
              inputs: [],
              rootInputs: ['packages/lib/config.json'],
              outputs: ['dist/**'],
            },
          },
        },
      },
    },
    steps: seeded(
      'packages/lib/seed.txt',
      'packages/app/dist/out.txt',
      ['A', 'B', 'A'],
      [{ write: { 'packages/lib/config.json': 'X' } }],
    ),
  }),

  defineCase({
    id: 'inputs/uncached-writer-through-quiet-task',
    category: 'inputs',
    kind: 'correctness',
    needs: ['uncached-task'],
    title:
      'An uncached writer reached through a task that does nothing still keys its reader on what it wrote',
    why: 'Ordering passes through every task in the graph, even one that runs nothing. Here a do-nothing task sits between the uncached writer and the reader. If the reader is keyed before the writer runs because the writer is not its direct dependency, it replays output from the previous seed under a green run.',
    from: ['undeclared-writes'],
    workspace: {
      projects: {
        a: {
          tasks: {
            gen: { command: COPY_SEED, cache: false },
            mid: { ...QUIET, dependsOn: ['gen'] },
            build: reader('mid'),
          },
        },
      },
    },
    steps: seeded(`${A}/seed.txt`, `${A}/dist/out.txt`, ABBA),
  }),

  defineCase({
    id: 'inputs/cached-rewriter-two-quiet-tasks-up',
    category: 'inputs',
    kind: 'correctness',
    needs: ['uncached-task'],
    title:
      'A cached task rewriting a file two do-nothing tasks ahead of its reader keys the reader on the new bytes',
    why: 'A cached task can write files too, and a reader further down is keyed on what it wrote. Here `fmt` rewrites `config.json`, and two tasks that do nothing sit between it and the reader. Keying the reader from the file as the run found it, before `fmt` ran, replays output built from the previous seed under a green run.',
    from: ['undeclared-writes'],
    workspace: {
      projects: {
        a: {
          tasks: {
            fmt: { command: COPY_SEED, inputs: ['**', '!dist/**'], outputs: [] },
            mid: { ...QUIET, dependsOn: ['fmt'] },
            mid2: { ...QUIET, dependsOn: ['mid'] },
            build: reader('mid2'),
          },
        },
      },
    },
    steps: seeded(`${A}/seed.txt`, `${A}/dist/out.txt`, ABBA),
  }),

  // ------------------------------------------------ what an uncached dependency keys
  defineCase({
    id: 'inputs/uncached-dependency-source-edit-reruns',
    category: 'inputs',
    kind: 'correctness',
    needs: ['uncached-task'],
    title: 'Editing the inputs of an uncached task in a dependency reruns its cached dependant',
    why: 'A task that is not cached still has inputs, and its dependants still see them change. Here `ui#bare` is uncached and `app#test` depends on it. Its key comes from its inputs whether it caches or not, and the dependant folds that key, so editing `ui` reruns `app#test`. Otherwise the tests replay green against code they never ran on.',
    from: ['keyed-projects'],
    workspace: keyedThrough(UNCACHED_UI, '^bare'),
    steps: [
      { run: 'test', expect: { exit: 0 } },
      { write: { 'packages/ui/src/index.js': 'ui 2\n' } },
      { run: 'test', expect: { exit: 0, ran: ['app#test'] } },
    ],
  }),

  defineCase({
    id: 'inputs/through-uncached-dependency-source-edit-reruns',
    category: 'inputs',
    kind: 'correctness',
    needs: ['uncached-task'],
    title:
      'Editing a dependency’s sources reruns a cached dependant reached through an uncached task',
    why: 'A chain of dependencies passes through an uncached task without breaking. Here `app#test` depends on `ui#build`, which is uncached and depends on `ui#source`. If the uncached task in the middle cuts the chain of keys, an edit to `ui`’s sources leaves `app#test` replaying a result from before the edit, and a failing test goes unseen.',
    from: ['keyed-projects'],
    workspace: keyedThrough(
      {
        source: { command: 'true', inputs: ['src/**'], outputs: [] },
        build: { command: 'true', dependsOn: ['source'], inputs: ['src/**'], cache: false },
      },
      '^build',
    ),
    steps: [
      { run: 'test', expect: { exit: 0 } },
      { write: { 'packages/ui/src/index.js': 'ui 2\n' } },
      { run: 'test', expect: { exit: 0, ran: ['app#test'] } },
    ],
  }),

  defineCase({
    id: 'inputs/uncached-dependency-unrelated-edit-replays',
    category: 'inputs',
    kind: 'efficiency',
    needs: ['uncached-task'],
    title: 'Editing a project nothing depends on lets a task with an uncached dependency replay',
    why: 'An uncached dependency does not make its dependants uncacheable. Its key comes from its inputs, so only an edit those inputs see reruns the dependant. Here the edit is in a project nothing depends on. Rerunning `app#test` for it spends CI time on every change anywhere, and makes the cache useless above any uncached task.',
    from: ['keyed-projects'],
    workspace: keyedThrough(UNCACHED_UI, '^bare'),
    steps: [
      { run: 'test', expect: { exit: 0 } },
      { write: { 'packages/other/src/index.js': 'other 2\n' } },
      { run: 'test', expect: { exit: 0, notRan: ['app#test'] } },
    ],
  }),

  // ------------------------------------------------ links a task makes
  defineCase({
    id: 'outputs/link-to-dir-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output symlink to a directory comes back as the same link',
    why: 'A link to a directory in the outputs is part of the tree and comes back as a link. Restored as a copy of the directory, the two paths split apart, so a later write to one no longer shows in the other. A replay must leave the tree the command made: the real directory, with its files, and the link to it.',
    from: ['output-links'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: linkedBuild(
              'mkdir -p dist/sub && echo real > dist/real.txt && echo s > dist/sub/s.txt && ln -s real.txt dist/link.txt && ln -s sub dist/linkdir',
            ),
          },
          files: { 'src/in.txt': 'v1\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist`]: null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['a#build'],
          files: { [`${A}/dist/real.txt`]: 'real\n', [`${A}/dist/linkdir/s.txt`]: 's\n' },
        },
      },
      {
        check: {
          links: { [`${A}/dist/link.txt`]: 'real.txt', [`${A}/dist/linkdir`]: 'sub' },
          dirs: [`${A}/dist/sub`],
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/long-link-target-and-deep-empty-dir',
    category: 'outputs',
    kind: 'correctness',
    title: 'A link with a 300-byte target and an empty directory 300 bytes deep come back',
    why: 'Outputs can have long paths, and empty directories are part of the tree. Classic tar headers hold 100 bytes for a name or a link target; past that an archive needs an extended header. One that truncates instead restores a link to the wrong place and drops the deep empty directory: a different tree under a green run.',
    from: ['output-links'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: linkedBuild(
              `mkdir -p dist/${DEEP}/empty && echo t > dist/${DEEP}/t.txt && ln -s ${DEEP}/t.txt dist/link`,
            ),
          },
          files: { 'src/in.txt': 'v1\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist`]: null } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/dist/link`]: 't\n' } },
      },
      {
        check: {
          links: { [`${A}/dist/link`]: `${DEEP}/t.txt` },
          dirs: [`${A}/dist/${DEEP}/empty`],
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/dangling-link-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output link whose target is not there comes back as the same link',
    why: 'A link whose target does not exist yet is still output: a build may leave it for a later step, or for the program at runtime, to fill. Saving only what resolves drops the link, and a replay then gives a tree without it. Restoring it with its exact target text keeps a replay equal to a real run.',
    from: ['output-links'],
    workspace: {
      projects: {
        a: {
          tasks: { build: linkedBuild('echo a > dist/a.txt && ln -s later.txt dist/link.txt') },
          files: { 'src/in.txt': 'v1\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist`]: null } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      {
        check: {
          links: { [`${A}/dist/link.txt`]: 'later.txt' },
          missing: [`${A}/dist/later.txt`],
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/retargeted-link-put-back',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output link pointed elsewhere by hand, at the same length, is put back',
    why: 'A link output edited by hand is like a file edited by hand: the next run puts back what the inputs produce. Here the link is pointed at `b.txt` instead of `a.txt`. The two targets have the same length, so a check of size alone sees no change; only comparing the target text catches it. Otherwise the wrong file ships through the link.',
    from: ['output-links'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: linkedBuild(
              'echo a > dist/a.txt && echo b > dist/b.txt && ln -s a.txt dist/link.txt',
            ),
          },
          files: { 'src/in.txt': 'v1\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0 } },
      { link: { [`${A}/dist/link.txt`]: 'b.txt' } },
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/link.txt`]: 'a\n' } } },
      { check: { links: { [`${A}/dist/link.txt`]: 'a.txt' } } },
    ],
  }),

  // ------------------------------------------------ negated outputs
  defineCase({
    id: 'outputs/negated-left-by-run-and-not-replayed',
    category: 'outputs',
    kind: 'correctness',
    title:
      'Paths a `!` output entry takes back are left in place by a run and never come back from a replay',
    why: 'A `!` entry says a path under the output directory is not the task’s. A run leaves such files in place, here `keep.txt` and `fixture.txt` that the user keeps there. A replay restores the real outputs but never brings back an excluded file, like the `.tmp` scratch file the command wrote. Excluded means neither cleaned nor stored.',
    from: ['negated-outputs'],
    workspace: negated(),
    steps: [
      {
        run: 'build',
        expect: {
          exit: 0,
          files: { [`${A}/out/keep.txt`]: 'K1', [`${A}/out/sub/fixture.txt`]: 'F1' },
        },
      },
      {
        write: {
          [`${A}/out/a.js`]: null,
          [`${A}/out/sub/gen.js`]: null,
          [`${A}/out/scratch.tmp`]: null,
        },
      },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: {
            [`${A}/out/a.js`]: 'A1',
            [`${A}/out/sub/gen.js`]: 'g\n',
            [`${A}/out/keep.txt`]: 'K1',
            [`${A}/out/sub/fixture.txt`]: 'F1',
          },
          ifReplayed: { task: 'a#build', files: { [`${A}/out/scratch.tmp`]: null } },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/negated-left-by-replay',
    category: 'outputs',
    kind: 'correctness',
    title: 'A replay restores the outputs and leaves an edited path a `!` entry takes back alone',
    why: 'The `!` entry says the file is not the task’s output, so it belongs to the user. Here the user edits `fixture.txt` and deletes the real outputs; the replay restores the outputs and leaves the edited file as it is. A replay that cleans the whole directory or writes over the file loses the user’s bytes with no warning.',
    from: ['negated-outputs'],
    workspace: negated(),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      {
        write: {
          [`${A}/out/a.js`]: null,
          [`${A}/out/sub/gen.js`]: null,
          [`${A}/out/sub/fixture.txt`]: 'F2',
        },
      },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: {
            [`${A}/out/a.js`]: 'A1',
            [`${A}/out/sub/gen.js`]: 'g\n',
            [`${A}/out/sub/fixture.txt`]: 'F2',
            [`${A}/out/keep.txt`]: 'K1',
          },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/negated-stray-still-removed',
    category: 'outputs',
    kind: 'correctness',
    title: 'A stray file in an output directory with `!` entries is gone after a replay',
    why: '`!` entries carve out named paths; they do not turn the rest of the directory into user space. A stray file that is neither an output nor excluded must still go on a replay, or it ships with the build. Only the paths the `!` entries name are kept.',
    from: ['negated-outputs'],
    workspace: negated(),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/out/stray.js`]: 'x' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: {
            [`${A}/out/stray.js`]: null,
            [`${A}/out/keep.txt`]: 'K1',
            [`${A}/out/a.js`]: 'A1',
          },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/negated-path-stays-input',
    category: 'outputs',
    kind: 'correctness',
    title: 'Editing a path a `!` output entry takes back, and the inputs name, reruns the task',
    why: 'A path can be excluded from outputs and still be an input. Here `out/keep.txt` is taken back by a `!` entry and named in the inputs, so editing it reruns the task. A tool that leaves a path out of the key because it sits under an output directory replays a result built from the old file.',
    from: ['negated-outputs'],
    workspace: negated(),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/out/keep.txt`]: 'K2' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [`${A}/out/keep.txt`]: 'K2' } },
      },
    ],
  }),

  defineCase({
    id: 'outputs/negated-in-dependant-adding-to-tree',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A task adding to the tree of the task before it keeps its `!` scratch file out of what a replay brings back',
    why: 'When a later task adds to the earlier task’s output tree, each task’s `!` entries still apply to its own outputs. Here `types` excludes `*.tmp`, so a replay restores `a.js` and `a.d.ts` and leaves the scratch file out. Bringing back an excluded file puts local state into a tree that ships.',
    from: ['negated-outputs'],
    workspace: negatedPair(['out/**', '!out/keep.txt', '!out/sub/**'], {
      command: 'echo d > out/a.d.ts && echo t > out/types.tmp',
      outputs: ['out/**', '!out/keep.txt', '!out/sub/**', '!**/*.tmp'],
    }),
    steps: [
      { run: 'types', expect: { exit: 0, files: { [`${A}/out/keep.txt`]: 'K1' } } },
      {
        write: {
          [`${A}/out/a.js`]: null,
          [`${A}/out/a.d.ts`]: null,
          [`${A}/out/types.tmp`]: null,
        },
      },
      {
        run: 'types',
        expect: {
          exit: 0,
          files: {
            [`${A}/out/a.js`]: 'A1',
            [`${A}/out/a.d.ts`]: 'd\n',
            [`${A}/out/keep.txt`]: 'K1',
          },
          ifReplayed: { task: 'a#types', files: { [`${A}/out/types.tmp`]: null } },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/negated-disjoint-pair-both-run',
    category: 'outputs',
    kind: 'correctness',
    title: 'Two tasks with disjoint outputs, each with a `!` entry, both run',
    why: 'Two tasks conflict only when they write the same path. Here `x` writes `dist` and `y` writes `out`, each with a `!` entry inside its own directory. A `!` entry narrows a task’s own outputs and is not an overlap, so refusing or dropping either task blocks a valid config for no reason.',
    from: ['negated-outputs'],
    workspace: {
      projects: {
        a: {
          tasks: {
            x: {
              command: 'mkdir -p dist && echo a > dist/a.js',
              inputs: ['src/**'],
              outputs: ['dist/**', '!dist/keep.txt'],
            },
            y: {
              command: 'mkdir -p out && echo b > out/b.js',
              inputs: ['src/**'],
              outputs: ['out/**', '!out/keep.txt'],
            },
            all: { command: 'true', dependsOn: ['x', 'y'] },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      {
        run: 'all',
        expect: {
          exit: 0,
          ran: ['a#x', 'a#y'],
          files: { [`${A}/dist/a.js`]: 'a\n', [`${A}/out/b.js`]: 'b\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/negated-narrow-dependant-stray-removed',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A stray in an earlier task’s outputs is gone after a replay, beside a later task’s narrower `!` entry',
    why: 'Each task’s `!` entries speak only for its own outputs. The later task’s `!out/types/*.tmp` is about its own tree; it does not make a stray in the earlier task’s `out` anyone’s output. A replay removes the stray, or a file no task wrote ships with the build.',
    from: ['negated-outputs'],
    workspace: negatedPair(['out/**', '!out/keep.txt', '!out/sub/**'], {
      command: 'mkdir -p out/types && echo d > out/types/a.d.ts',
      outputs: ['out/types/**', '!out/types/*.tmp'],
    }),
    steps: [
      { run: 'types', expect: { exit: 0 } },
      { write: { [`${A}/out/stray.js`]: 'x' } },
      {
        run: 'types',
        expect: {
          exit: 0,
          files: {
            [`${A}/out/stray.js`]: null,
            [`${A}/out/a.js`]: 'A1',
            [`${A}/out/types/a.d.ts`]: 'd\n',
            [`${A}/out/keep.txt`]: 'K1',
          },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/negated-root-output',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A root output’s `!` entry leaves that file in place, out of the replay, and still an input',
    why: 'A `!` entry on an output at the workspace root works like one inside the project. Here `gen/keep.txt` is excluded from the root output and named as an input: it stays in place on a run, never comes from a replay, and still reruns the task when it changes. Treating it as output loses the user’s file; leaving it out of the key replays stale results.',
    from: ['negated-outputs'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'mkdir -p ../../gen && cp src/a.txt ../../gen/x.txt',
              inputs: ['src/**'],
              rootInputs: ['gen/keep.txt'],
              outputs: [],
              rootOutputs: ['gen/**', '!gen/keep.txt'],
            },
          },
          files: { 'src/a.txt': 'A1' },
        },
      },
      files: { 'gen/keep.txt': 'W1' },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { 'gen/x.txt': 'A1', 'gen/keep.txt': 'W1' } } },
      { write: { 'gen/x.txt': null } },
      { run: 'build', expect: { exit: 0, files: { 'gen/x.txt': 'A1', 'gen/keep.txt': 'W1' } } },
      { write: { 'gen/keep.txt': 'W2' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { 'gen/keep.txt': 'W2' } } },
    ],
  }),

  // ------------------------------------------------ an output directory a user made a link
  defineCase({
    id: 'outputs/output-dir-link-out-of-project-kept',
    category: 'outputs',
    kind: 'correctness',
    title:
      'An output directory the user made a link out of the project stays a link, and a replay writes nothing through it',
    why: 'A link at the output directory that leads out of the project is the user’s setup, not the task’s output. A replay that writes through it puts files outside the project, where no run of the task asked. Replacing it with a real directory discards what the user set up. Keeping the link and writing nothing through it is the safe outcome.',
    from: ['restore-link-out'],
    workspace: { ...writing('dist/o.txt'), files: { 'elsewhere/.keep': '' } },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist`]: null } },
      { link: { [`${A}/dist`]: '../../elsewhere' } },
      {
        run: 'build',
        expect: { ifReplayed: { task: 'a#build', files: { 'elsewhere/o.txt': null } } },
      },
      { check: { links: { [`${A}/dist`]: '../../elsewhere' } } },
    ],
  }),

  defineCase({
    id: 'outputs/output-dir-linked-inside-project-written-through',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output directory the user made a link inside the project is restored through',
    why: 'A link at the output directory that stays inside the project changes where the files live, not what the task writes. Restoring through it gives the same tree as running the command, which also writes through the link. Replacing the link with a directory undoes the user’s layout and leaves the real directory empty.',
    from: ['restore-link-out'],
    workspace: writing('dist/o.txt'),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist`]: null, [`${A}/real-out/.keep`]: '' } },
      { link: { [`${A}/dist`]: 'real-out' } },
      { run: 'build', expect: { exit: 0, files: { [`${A}/real-out/o.txt`]: 'x' } } },
      { check: { links: { [`${A}/dist`]: 'real-out' } } },
    ],
  }),

  ...INSIDE.map((s) =>
    defineCase({
      id: `outputs/dangling-link-in-project-${s.slug}`,
      category: 'outputs',
      kind: 'correctness',
      title: `A dangling link inside the project ${s.where} is restored through: its target made, the link kept`,
      why: 'A link inside the project is written through, whether or not its target exists yet. The command would create the target and write there, so a replay does the same: it makes the target, restores the file and keeps the link. Replacing a dangling link discards the user’s layout just because its target was cleaned.',
      from: ['restore-link-out'],
      workspace: writing(s.entry, s.outputs),
      steps: [
        { run: 'build', expect: { exit: 0 } },
        { write: { [`${A}/${s.remove}`]: null } },
        { link: at(s.links) },
        { run: 'build', expect: { exit: 0, files: { [`${A}/${s.lands}`]: 'x' } } },
        { check: { links: at(s.links) } },
        { run: 'build', expect: { exit: 0, files: { [`${A}/${s.entry}`]: 'x' } } },
      ],
    }),
  ),

  defineCase({
    id: 'outputs/dangling-absolute-link-in-project',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A dangling absolute link inside the project at the output directory is restored through',
    why: 'A link written as an absolute path is judged by where it leads, not how it is spelled. This one leads inside the project, so it is treated like a relative link there: the replay makes the target and restores through it. Treating every absolute link as outside the project would replace the user’s link with a directory.',
    from: ['restore-link-out'],
    workspace: writing('dist/o.txt'),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist`]: null } },
      { sh: `ln -s "$(pwd)/${A}/real-out" ${A}/dist` },
      { run: 'build', expect: { exit: 0, files: { [`${A}/real-out/o.txt`]: 'x' } } },
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/o.txt`]: 'x' } } },
    ],
  }),

  defineCase({
    id: 'outputs/dangling-link-in-project-after-dependency',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A dangling output link is restored through by a task that waits on a same-project dependency',
    why: 'Writing through an output link works the same when the task waits on another task. Here `build` depends on `codegen` in the same project, and its output directory is a dangling link inside the project. The file must land in `real-out` and the link stay, exactly as for a task with no dependency.',
    from: ['restore-link-out'],
    workspace: {
      projects: {
        a: {
          tasks: {
            codegen: {
              command: 'cp src/seed.txt generated.txt',
              inputs: ['src/**'],
              outputs: ['generated.txt'],
            },
            build: {
              command: 'mkdir -p dist && cat generated.txt > dist/o.txt',
              dependsOn: ['codegen'],
              inputs: [],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/seed.txt': 'seed', '.gitignore': 'generated.txt\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist`]: null } },
      { link: { [`${A}/dist`]: 'real-out' } },
      { run: 'build', expect: { exit: 0, files: { [`${A}/real-out/o.txt`]: 'seed' } } },
      { check: { links: { [`${A}/dist`]: 'real-out' } } },
    ],
  }),

  ...OUTSIDE.map((s) =>
    defineCase({
      id: `outputs/dangling-link-out-of-project-${s.slug}`,
      category: 'outputs',
      kind: 'correctness',
      title: `A dangling output link out of the project ${s.where} gets nothing created through it`,
      why: 'A link out of the project, even one whose target is missing, is no place for a replay to write. Creating the target to restore into it writes files outside the project, where the task has no say. The link is the user’s and stays as it was. A failed run is acceptable here; creating the target is not.',
      from: ['restore-link-out'],
      workspace: { ...writing(s.entry, s.outputs), files: { 'outside/.keep': '' } },
      steps: [
        { run: 'build', expect: { exit: 0 } },
        { write: { [`${A}/${s.remove}`]: null } },
        { link: at(s.links) },
        { run: 'build', expect: {} },
        {
          check: {
            missing: [s.gone],
            dirs: [s.gone.slice(0, s.gone.lastIndexOf('/'))],
            links: at(s.links),
          },
        },
      ],
    }),
  ),

  defineCase({
    id: 'outputs/link-under-output-glob-replaced',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A dangling link out of the project where an output directory belongs is replaced by the directory',
    why: '`dist/**` matches `dist/sub` itself, so a link left there is an output path like any other. It is removed and replaced by the directory the task makes, never followed. Following it would create files outside the project, and keeping it would leave a tree different from the one the command made.',
    from: ['restore-link-out'],
    workspace: { ...writing('dist/sub/o.txt'), files: { 'outside/.keep': '' } },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist/sub`]: null } },
      { link: { [`${A}/dist/sub`]: '../../../outside/gone' } },
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/sub/o.txt`]: 'x' } } },
      { check: { dirs: [`${A}/dist/sub`], missing: ['outside/gone'] } },
    ],
  }),

  // ------------------------------------------------ outputs linked into git's metadata
  ...(['.git', '.git/refs'] as const).flatMap((to) => [
    defineCase({
      id: `outputs/root-project-output-dir-linked-to-${to.slice(1).replace('/', '-')}`,
      category: 'outputs',
      kind: 'correctness',
      title: `The root project’s output directory linked to ${to} never empties the repository`,
      why: 'When the repository root is itself a project, `.git` sits inside that project. A link from `dist` into `.git` therefore stays in the project, and a clean that follows it deletes git’s objects and refs: the repository, with any work not pushed, is gone. Removing or refusing the link is safe; clearing through it never is.',
      from: ['output-clean-link-git'],
      workspace: {
        projects: {
          other: { files: { 'src/x.txt': 'x\n' } },
          root: {
            dir: '.',
            tasks: {
              build: {
                command: 'mkdir -p dist && cat src/a.txt > dist/out.txt',
                inputs: ['src/**'],
                outputs: ['dist/**'],
              },
            },
            files: { 'src/a.txt': 'a\n' },
          },
        },
      },
      steps: repoKept('src', { link: { dist: to } }),
    }),
    defineCase({
      id: `outputs/root-output-dir-linked-to-${to.slice(1).replace('/', '-')}`,
      category: 'outputs',
      kind: 'correctness',
      title: `A root output directory linked to ${to} never empties the repository`,
      why: 'An output declared at the workspace root, outside any project, can be a link into `.git` too. Clearing `out/**` by following that link deletes git’s objects and refs, and with them any work not pushed. A tool may refuse the run or replace the link, but it never deletes through it.',
      from: ['output-clean-link-git'],
      workspace: {
        projects: {
          a: {
            tasks: {
              build: {
                command: 'mkdir -p ../../out && cat src/a.txt > ../../out/a.txt',
                inputs: ['src/**'],
                outputs: [],
                rootOutputs: ['out/**'],
              },
            },
            files: { 'src/a.txt': 'a\n' },
          },
        },
      },
      steps: repoKept(`${A}/src`, { link: { out: to } }),
    }),
  ]),

  // ------------------------------------------------ what a root output glob reaches
  defineCase({
    id: 'outputs/root-wide-glob-spares-node-modules-and-git',
    category: 'outputs',
    kind: 'correctness',
    title: 'A root `**/*.js` output leaves installed packages and .git alone',
    why: '`**/*.js` at the root means the files the build writes. Read literally, it also matches installed packages under `node_modules` and files under `.git`. A clean or restore that reaches them deletes or reverts what no task wrote, and breaks the install or the repository. Refusing so wide a pattern is as safe.',
    from: ['output-reach'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'mkdir -p ../../gen && cat src/a.txt > ../../gen/a.js',
              inputs: ['src/**'],
              outputs: [],
              rootOutputs: ['**/*.js'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
      files: { 'lib/node_modules/dep/index.js': 'dep\n' },
    },
    steps: [
      { run: 'build', expect: { exit: 0, orRefused: true } },
      { sh: 'mkdir -p .git/hooks && echo h > .git/hooks/h.js' },
      { write: { 'lib/node_modules/dep/index.js': 'mine\n' } },
      ...(['b\n', 'a\n'] as const).flatMap((v): Step[] => [
        { write: { [`${A}/src/a.txt`]: v } },
        {
          run: 'build',
          expect: {
            exit: 0,
            orRefused: true,
            files: {
              'gen/a.js': v,
              'lib/node_modules/dep/index.js': 'mine\n',
              '.git/hooks/h.js': 'h\n',
            },
          },
        },
      ]),
    ],
  }),

  defineCase({
    id: 'outputs/escaped-literal-dir-swapped-for-file',
    category: 'outputs',
    kind: 'correctness',
    title:
      'An escaped literal output `out/\\[x\\]` restores as a file where it was a directory, and back',
    why: '`out/\\[x\\]` names one path, an entry literally called `[x]`. Read as a pattern instead, it matches `out/x`, so when the output changes from a directory to a file, the emptied directory is not cleared and blocks the file’s restore. Escapes in output patterns hold for saving and for cleaning alike.',
    from: ['output-glob-links'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command:
                'rm -rf out && if [ "$(cat src/mode.txt)" = dir ]; then mkdir -p "out/[x]" out/x && echo 1 > "out/[x]/f" && echo 1 > out/x/f; else mkdir -p out && echo 2 > "out/[x]" && echo 2 > out/x; fi',
              inputs: ['src/**'],
              outputs: ['out/x', 'out/\\[x\\]'],
            },
          },
          files: { 'src/mode.txt': 'dir' },
        },
      },
    },
    steps: (['dir', 'file', 'dir', 'file'] as const).flatMap((mode): Step[] => [
      { write: { [`${A}/src/mode.txt`]: mode } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files:
            mode === 'dir'
              ? { [`${A}/out/[x]/f`]: '1\n', [`${A}/out/x/f`]: '1\n' }
              : { [`${A}/out/[x]`]: '2\n', [`${A}/out/x`]: '2\n' },
        },
      },
    ]),
  }),

  // ------------------------------------------------ stale hits
  defineCase({
    id: 'inputs/glob-syntax-project-dir',
    category: 'inputs',
    kind: 'correctness',
    title: 'A project whose directory is named with glob syntax (`[lib]`) still keys its files',
    why: 'A project directory can contain characters that are special in globs, such as `[` and `]`. Joined unescaped with the input patterns, `packages/[lib]` reads as a class matching one letter, the inputs match nothing, and every edit replays the first build. The project’s own path is taken literally.',
    from: ['stale-hit'],
    workspace: {
      projects: {
        lib: {
          dir: 'packages/[lib]',
          tasks: {
            build: {
              command: 'mkdir -p dist && cat src/* > dist/o',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/main.ts': 'initial' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { 'packages/[lib]/dist/o': 'initial' } } },
      { write: { 'packages/[lib]/src/main.ts': 'modified' } },
      { run: 'build', expect: { exit: 0, files: { 'packages/[lib]/dist/o': 'modified' } } },
      { commit: 'edit' },
      { run: 'build', expect: { exit: 0, files: { 'packages/[lib]/dist/o': 'modified' } } },
      { write: { 'packages/[lib]/src/b.ts': '+new' } },
      { run: 'build', expect: { exit: 0, files: { 'packages/[lib]/dist/o': '+newmodified' } } },
    ],
  }),

  defineCase({
    id: 'inputs/nested-git-worktree-edit',
    category: 'inputs',
    kind: 'correctness',
    title: 'An edit inside a git worktree checked out under a task’s inputs reruns the task',
    why: 'Files under a task’s inputs key the task, however git sees them. A git worktree checked out inside the inputs shows up in git as one untracked directory, and git never lists the files in it. A key built only from git’s listing misses an edit there and replays an old result. Refusing the workspace until the worktree is ignored is as safe.',
    from: ['stale-hit'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'mkdir -p dist && cat src/a src/wt/packages/a/src/a > dist/o',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a': '1' },
        },
      },
    },
    steps: [
      { sh: `git worktree add -q ${A}/src/wt` },
      { run: 'build', expect: { exit: 0, orRefused: true, files: { [`${A}/dist/o`]: '11' } } },
      { write: { [`${A}/src/wt/packages/a/src/a`]: '2' } },
      { run: 'build', expect: { exit: 0, orRefused: true, files: { [`${A}/dist/o`]: '12' } } },
    ],
  }),

  ...FILE_MODE_OFF.map((off) =>
    defineCase({
      id: `inputs/executable-bit-under-filemode-${off === '' ? 'empty' : off}`,
      category: 'inputs',
      kind: 'correctness',
      title: `An executable bit still reruns the task when git’s core.fileMode is ${off === '' ? 'empty' : `\`${off}\``}`,
      why: 'File mode is an input when the command reads it. With git’s `core.fileMode` off, git reports no mode change, but the command here checks whether the script is executable and writes a different result. A key from git’s view replays the wrong output after a `chmod`. Each spelling of off is tried because git accepts them all.',
      from: ['stale-hit'],
      workspace: {
        projects: {
          a: {
            tasks: {
              build: {
                command:
                  'mkdir -p dist && (test -x src/run.sh && echo exec || echo plain) > dist/o',
                inputs: ['src/**'],
                outputs: ['dist/**'],
              },
            },
            files: { 'src/run.sh': 'echo hi\n' },
          },
        },
      },
      steps: [
        { sh: `git config core.fileMode '${off}'` },
        { run: 'build', expect: { exit: 0, files: { [`${A}/dist/o`]: 'plain\n' } } },
        { chmod: { [`${A}/src/run.sh`]: 0o755 } },
        { run: 'build', expect: { exit: 0, files: { [`${A}/dist/o`]: 'exec\n' } } },
        { chmod: { [`${A}/src/run.sh`]: 0o644 } },
        { run: 'build', expect: { exit: 0, files: { [`${A}/dist/o`]: 'plain\n' } } },
      ],
    }),
  ),

  defineCase({
    id: 'outputs/root-output-edit-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'A root output edited by hand is put back on the next run',
    why: 'An output at the workspace root, outside the project, is still the task’s output and follows the same rule. A hand edit to it is not what the inputs produce, so the next run puts back the cached bytes or reruns. Leaving the edit ships a file no build made under a green run.',
    from: ['stale-hit'],
    workspace: {
      projects: {
        a: {
          tasks: {
            gen: {
              command: 'mkdir -p ../../shared && printf g > ../../shared/g.txt',
              inputs: ['src/**'],
              outputs: [],
              rootOutputs: ['shared/**'],
            },
          },
          files: { 'src/in.txt': 's' },
        },
      },
    },
    steps: [
      { run: 'gen', expect: { exit: 0, files: { 'shared/g.txt': 'g' } } },
      { write: { 'shared/g.txt': 'CORRUPT' } },
      { run: 'gen', expect: { exit: 0, files: { 'shared/g.txt': 'g' } } },
    ],
  }),

  defineCase({
    id: 'outputs/root-project-stray-removed',
    category: 'outputs',
    kind: 'correctness',
    title: 'A stray file in the root project’s output directory is gone after a replay',
    why: 'When the repository root is a project, its `dist` is an output directory like any other. A stray file dropped there must be gone after a replay, or it ships with the build. Being at the root is no reason to skip cleaning declared outputs, nor to reach past them into the rest of the repository.',
    from: ['stale-hit'],
    workspace: {
      projects: {
        other: { files: { 'src/x.txt': 'x\n' } },
        root: {
          dir: '.',
          tasks: {
            build: {
              command: 'mkdir -p dist && printf a > dist/a.txt && printf b > dist/b.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/in.txt': 's' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'dist/STRAY.txt': 'zzz' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: { 'dist/STRAY.txt': null, 'dist/a.txt': 'a', 'dist/b.txt': 'b' },
        },
      },
    ],
  }),

  // ------------------------------------------------ trees shared at the workspace root
  defineCase({
    id: 'outputs/root-addition-subdir-warm',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A task adding a subdirectory to an earlier task’s root output: a warm run leaves the cold run’s tree',
    why: 'Two tasks may share an output tree when one runs after the other: here `build` writes `gen` and `individual` adds `gen/individual`. A warm run must end with the same tree as the cold one. If restoring `build` clears all of `gen` and the later task is not restored after it, `gen/individual` is missing on every warm run.',
    from: ['overlapping-outputs'],
    workspace: rootPair(ADDS_SUBDIR),
    steps: [0, 1].map(() => ({
      run: 'individual',
      expect: {
        exit: 0 as const,
        files: { 'gen/a.txt': 'A1', 'gen/individual/b.txt': 'B1' },
      },
    })),
  }),

  defineCase({
    id: 'outputs/root-addition-subdir-warm-replays',
    category: 'outputs',
    kind: 'efficiency',
    title:
      'A task adding a subdirectory to an earlier task’s root output: an unchanged tree replays both',
    why: 'When nothing changed, both tasks writing into a shared tree replay. Rerunning one because its outputs overlap another’s costs its full time on every run. The graph orders the two, so restoring the earlier task and then the later one gives the cold run’s tree with no command run.',
    from: ['overlapping-outputs'],
    workspace: rootPair(ADDS_SUBDIR),
    steps: [
      { run: 'individual', expect: { exit: 0 } },
      { run: 'individual', expect: { exit: 0, notRan: ['a#build', 'a#individual'] } },
    ],
  }),

  defineCase({
    id: 'outputs/root-same-tree-reader-keeps-upstream',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A task writing into the root output it reads from the task before it keeps that task’s files',
    why: 'A later task may read from and write into the tree the task before it wrote. Here `individual` reads `gen/a.txt` and writes `gen/b.txt` beside it. Clearing the shared tree before the later task runs deletes the file it is about to read, so the run fails or writes the wrong bytes.',
    from: ['overlapping-outputs'],
    workspace: rootPair({
      command: 'cp ../../gen/a.txt ../../gen/b.txt && cat srcb/b.txt >> ../../gen/b.txt',
      inputs: ['srcb/**'],
      rootOutputs: ['gen'],
    }),
    steps: [
      ...[0, 1].map(() => ({
        run: 'individual',
        expect: { exit: 0 as const, files: { 'gen/a.txt': 'A1', 'gen/b.txt': 'A1B1' } },
      })),
      { write: { gen: null } },
      {
        run: 'individual',
        expect: { exit: 0, files: { 'gen/a.txt': 'A1', 'gen/b.txt': 'A1B1' } },
      },
    ],
  }),

  defineCase({
    id: 'outputs/root-anchored-upstream-under-dependant',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A task writing into another project’s output directory from the root, and that project’s task adding to it: a warm run keeps both files',
    why: 'A task in one project may write into another project’s output directory: here `a` writes `b/dist/a.txt`, and `b` adds its own file after it. A warm run keeps both files. If restoring `b` clears `dist` first, it deletes `a`’s file, and the package ships without it.',
    from: ['overlapping-outputs'],
    workspace: crossProjectPair,
    steps: [0, 1].map(() => ({
      run: 'build',
      expect: {
        exit: 0 as const,
        files: { 'packages/b/dist/a.txt': 'A1', 'packages/b/dist/b.txt': 'B1' },
      },
    })),
  }),

  defineCase({
    id: 'outputs/root-anchored-upstream-under-dependant-replays',
    category: 'outputs',
    kind: 'efficiency',
    title:
      'A task writing into another project’s output directory from the root, and that project’s task adding to it: both replay',
    why: 'When nothing changed, both tasks writing into `b/dist` replay. Rerunning them because their outputs share a directory costs their full time on every run. The graph orders them, so restoring `a`’s files and then `b`’s gives the tree the cold run left.',
    from: ['overlapping-outputs'],
    workspace: crossProjectPair,
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build', 'b#build'] } },
    ],
  }),

  defineCase({
    id: 'outputs/root-addition-removal-not-undone',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A file a later task deletes from an earlier task’s root output stays deleted on warm runs',
    why: 'A later task may delete a file the earlier task wrote, here `tmp.js`. On a warm run, the replay of the earlier task brings that file back. The later task must then remove it again, or not be replayed, or the file ships in every warm tree but not in a cold one.',
    from: ['overlapping-outputs'],
    workspace: rootPair(
      {
        command: 'rm ../../gen/tmp.js && echo bundle > ../../gen/bundle.js',
        inputs: ['src/**'],
        rootOutputs: ['gen'],
      },
      'mkdir -p ../../gen && cp src/a.txt ../../gen/a.js && echo mid > ../../gen/tmp.js',
    ),
    steps: [0, 1, 2].map(() => ({
      run: 'individual',
      expect: {
        exit: 0 as const,
        files: { 'gen/a.js': 'A1', 'gen/bundle.js': 'bundle\n', 'gen/tmp.js': null },
      },
    })),
  }),
]
