// Cases drawn from bugs Nx fixed in its task runner, hasher and glob code
// (a pass over `fix(core)` commits not mined before). Each names the pull
// request above it and holds any task runner to the outcome the fix restored.
import { defineCase } from '../src/spec.ts'
import { out } from './shapes.ts'

const reads = (inputs: string[], read: string) => ({
  command: `mkdir -p dist && cat ${read} > dist/out.txt`,
  inputs,
  outputs: ['dist/**'],
})

const TEN = Array.from({ length: 10 }, (_, i) => `g${i + 1}`)

export default [
  // nx #20461 "fix handling of globs with {,.snap}".
  defineCase({
    id: 'inputs/brace-with-empty-alternative',
    category: 'inputs',
    kind: 'correctness',
    title: 'An input `src/data{,.snap}` keys both `src/data` and `src/data.snap`',
    why: 'An empty brace alternative means the name with nothing added, so `src/data{,.snap}` names a file and its snapshot. A tool that drops the empty alternative keys only the snapshot, and an edit to the data file replays stale output. A file the pattern does not name must still be left out.',
    from: ['brace-inputs'],
    workspace: {
      projects: {
        a: {
          tasks: { build: reads(['src/data{,.snap}'], 'src/data src/data.snap') },
          files: { 'src/data': 'd\n', 'src/data.snap': 's\n', 'src/other': 'o\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { 'packages/a/src/other': 'o2\n' } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { write: { 'packages/a/src/data': 'd2\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'd2\ns\n' } } },
      { write: { 'packages/a/src/data.snap': 's2\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'd2\ns2\n' } } },
    ],
  }),

  // nx native/glob.rs "should not strip literal chars from plain negated
  // globs": a leading `!` sent the pattern through the extglob reader, which
  // ate the `@` and `+`, so the exclusion matched nothing.
  defineCase({
    id: 'inputs/negation-through-scope-and-plus-directories',
    category: 'inputs',
    kind: 'efficiency',
    title: 'Negations through `@scope` and `a+b` directories leave their files out of the key',
    why: 'A leading `!` only says the pattern excludes; the `@` of a package scope and the `+` in a name after it are still plain characters. A tool that reads them as pattern syntax once a `!` is in front excludes nothing, so writes to a cache folder the user left out rerun the task every time. Files outside the excluded folders must still key it.',
    from: ['negated-outputs', 'inputs-glob-fuzz'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: reads(
              ['src/**', '!src/@scope/pkg/.cache/**', '!src/a+b/.cache/**'],
              'src/@scope/pkg/index.js',
            ),
          },
          files: {
            'src/@scope/pkg/index.js': 'i\n',
            'src/@scope/pkg/.cache/c.txt': 'c\n',
            'src/a+b/.cache/c.txt': 'c\n',
          },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { 'packages/a/src/@scope/pkg/.cache/c.txt': 'c2\n' } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { write: { 'packages/a/src/a+b/.cache/c.txt': 'c2\n' } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { write: { 'packages/a/src/@scope/pkg/index.js': 'i2\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'i2\n' } } },
    ],
  }),

  // nx #37215 "make glob escapes work the same on every platform":
  // `app/(marketing)/page.tsx` matched nothing, as `(` opened a group.
  defineCase({
    id: 'outputs/route-group-in-parentheses-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output `dist/(marketing)/**` stores and restores the `(marketing)` directory',
    why: 'A build of a Next.js app writes its route groups under their own names, parentheses kept. An output pattern that reads them as a group matches nothing, so the hit restores an empty tree. The restore must bring back the files under `dist/(marketing)`.',
    from: ['task-glob-brackets'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: "mkdir -p 'dist/(marketing)' && cat src/a.txt > 'dist/(marketing)/page.txt'",
              inputs: ['src/**'],
              outputs: ['dist/(marketing)/**'],
            },
          },
          files: { 'src/a.txt': 'p\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { 'packages/a/dist': null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['a#build'],
          files: { 'packages/a/dist/(marketing)/page.txt': 'p\n' },
        },
      },
    ],
  }),

  // nx #18207 "ensure output paths returned are unique": an output listed
  // twice was copied twice at once and failed with ENOTEMPTY.
  defineCase({
    id: 'outputs/same-pattern-listed-twice-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output pattern listed twice is stored and restored once, whole',
    why: 'Configs are merged from defaults and overrides, so the same output can end up listed twice. It still names one set of files. A tool that saves or restores it twice at once can race with itself, fail the run, or leave half a tree. The run and the hit after it should behave as if it were listed once.',
    from: ['output-dirs'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command:
                'mkdir -p dist/sub && cat src/a.txt > dist/out.txt && cp src/a.txt dist/sub/',
              inputs: ['src/**'],
              outputs: ['dist/**', 'dist/**'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { 'packages/a/dist': null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['a#build'],
          files: { [out('a')]: 'a\n', 'packages/a/dist/sub/a.txt': 'a\n' },
        },
      },
    ],
  }),

  // nx #37397 "prevent stale cache hits when task inputs share a hash
  // details key": past eight globs, inputs were keyed by a shortened name
  // and one could drop out of the key.
  defineCase({
    id: 'inputs/tenth-of-ten-globs-keys',
    category: 'inputs',
    kind: 'correctness',
    title: 'A task with ten input globs reruns when only the tenth matches the edit',
    why: 'Every input a task declares counts, however long the list is. A tool that shortens or merges a long list of patterns can drop one, and an edit only that one matches then replays a stale build. A file none of the ten names must still leave the task replayed.',
    from: ['inputs-glob-fuzz'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: reads(
              TEN.map((g) => `${g}/**`),
              'g10/a.txt',
            ),
          },
          files: {
            ...Object.fromEntries(TEN.map((g) => [`${g}/a.txt`, `${g}\n`])),
            'other/a.txt': 'o\n',
          },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { 'packages/a/other/a.txt': 'o2\n' } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { write: { 'packages/a/g10/a.txt': 'g10b\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'g10b\n' } } },
    ],
  }),

  // nx #28793 "task graph needs to handle multiple cycles": two cycles
  // through one task overflowed the stack.
  defineCase({
    id: 'graph/two-cycles-through-one-task-refused',
    category: 'graph',
    kind: 'correctness',
    title: 'Two task cycles through the same task fail the run at once, before any task runs',
    why: 'A task can sit on more than one cycle: `build` waits on `check` and on `lint`, and each of them waits on `build`. No order exists, so the run must be refused as a single cycle is. A tool whose cycle check handles only one can loop, crash or start a task without its prerequisite.',
    from: ['task-graph', 'default-build-cycle-key'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: { command: 'echo build > b.txt', dependsOn: ['check', 'lint'] },
            check: { command: 'echo check > c.txt', dependsOn: ['build'] },
            lint: { command: 'echo lint > l.txt', dependsOn: ['build'] },
          },
        },
        b: { tasks: { build: { command: 'echo b > b.txt' } } },
      },
    },
    steps: [
      {
        run: 'build',
        expect: {
          exit: 'fail',
          within: 30,
          notRan: ['a#build', 'a#check', 'a#lint', 'b#build'],
          files: { 'packages/a/b.txt': null, 'packages/b/b.txt': null },
        },
      },
    ],
  }),
]
