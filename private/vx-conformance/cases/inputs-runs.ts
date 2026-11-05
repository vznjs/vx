// Inputs that move while a run is under way (a formatter rewriting its own
// sources, a task editing a file another reads), inputs that are a
// command's answer, and inputs a run cannot enter.
import { defineCase, type Case, type Step } from '../src/spec.ts'
import { out } from './shapes.ts'

/** For each seed: write it at `seedFile`, run `task`, and expect `outFile` to hold it. */
function seeded(seedFile: string, outFile: string, task: string, seeds: string[]): Step[] {
  return seeds.flatMap((seed): Step[] => [
    { write: { [seedFile]: seed } },
    { run: task, expect: { exit: 0, files: { [outFile]: seed } } },
  ])
}

const ABBA = ['A', 'B', 'B', 'A']

/** A wait of at most ~3 s for `file`: a tool that runs one task at a time still finishes. */
const waitFor = (file: string): string =>
  `i=0; while [ ! -f ${file} ] && [ $i -lt 300 ]; do sleep 0.01; i=$((i+1)); done`

/** A build whose key is a command's output, run at the workspace root. */
function probed(runtime: string[], command = 'cat ../../marker > out.txt'): Case['workspace'] {
  return {
    projects: {
      a: {
        tasks: { build: { command, inputs: [], runtime, outputs: ['out.txt'] } },
        files: { '.gitignore': 'out.txt\n' },
      },
    },
    files: { marker: 'A\n' },
  }
}

export default [
  defineCase({
    id: 'inputs/formatter-rewrites-own-input',
    category: 'inputs',
    kind: 'correctness',
    title: 'A task rewriting its own input ahead of a reader leaves the reader’s output current',
    why: 'The reader’s key must see the bytes the formatter wrote in this run, not the ones it found before. A runner that hashes every input up front keys the reader on the old `a.txt` and stores the new output under that key. A later run with the old source then replays output built from the new one, so the build ships text the source no longer holds.',
    from: ['in-run-writes'],
    workspace: {
      projects: {
        a: {
          tasks: {
            fmt: { command: 'cp seed.txt a.txt', inputs: ['seed.txt', 'a.txt'], outputs: [] },
            build: {
              command: 'mkdir -p dist && cat a.txt > dist/out.txt',
              dependsOn: ['fmt'],
              inputs: ['a.txt'],
              outputs: ['dist/**'],
            },
          },
          files: { 'a.txt': 'X' },
        },
      },
    },
    steps: seeded('packages/a/seed.txt', out('a'), 'build', ABBA),
  }),

  defineCase({
    id: 'inputs/named-dependency-output-cascades',
    category: 'inputs',
    kind: 'correctness',
    title:
      'A task depending on another project’s named task rebuilds when that task’s output changes',
    why: 'A task that depends on another task builds on what that task produced. When the upstream output changes, the dependant must run again, even though none of its own files changed. A runner that only looks at the dependant’s own inputs replays its old output, and the app ships with a generated file from an earlier seed.',
    from: ['in-run-writes'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            gen: { command: 'cp seed.txt out.txt', inputs: ['seed.txt'], outputs: ['out.txt'] },
          },
          files: { 'seed.txt': 'X', '.gitignore': 'out.txt\n' },
        },
        app: {
          tasks: {
            build: {
              command: 'mkdir -p dist && cat ../lib/out.txt > dist/out.txt',
              dependsOn: ['lib#gen'],
              inputs: [],
              outputs: ['dist/**'],
            },
          },
        },
      },
    },
    steps: seeded('packages/lib/seed.txt', out('app'), 'build', ABBA),
  }),

  defineCase({
    id: 'inputs/edited-mid-run-not-replayed',
    category: 'inputs',
    kind: 'correctness',
    title:
      'A result built from an input another task edited mid-run is not replayed once the input is put back',
    why: 'A key taken over the old bytes must not be stored with an output built from the new ones. Here another task edits `src/a.txt` while the reader runs, so the reader’s output reflects the edit but its key does not. Once the file is put back, that key matches again and replays the edit that is gone. A runner must re-check its inputs before storing.',
    from: ['unkeyed-upstream'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: {
              command: `${waitFor('../app/started')}; echo more >> src/a.txt; touch ../app/go`,
              inputs: [],
              cache: false,
            },
          },
          files: { 'src/a.txt': 'one\n' },
        },
        app: {
          tasks: {
            build: {
              command: `touch started; ${waitFor('go')}; cat ../lib/src/a.txt > out.txt`,
              inputs: ['src/**'],
              rootInputs: ['packages/lib/src/a.txt'],
              outputs: ['out.txt'],
            },
          },
          files: { 'src/x.txt': 'x', '.gitignore': 'out.txt\ngo\nstarted\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['lib#build', 'app#build'] } },
      { write: { 'packages/lib/src/a.txt': 'one\n', 'packages/app/go': '' } },
      {
        run: 'build',
        projects: ['app'],
        expect: { exit: 0, files: { 'packages/app/out.txt': 'one\n' } },
      },
    ],
  }),

  defineCase({
    id: 'inputs/upstream-edited-mid-run-chain',
    category: 'inputs',
    kind: 'correctness',
    title:
      'Tasks built over a dependency whose input was edited mid-run are not replayed once it is put back',
    why: 'A stale key does not stay in one task: it flows down the chain. Each dependant folds the dependency’s key from before the edit, while its output carries the edit itself. If the dependency’s entry is not dropped, every task built on it is stored wrong too, and putting the file back replays the whole chain from a state that no longer exists.',
    from: ['unkeyed-upstream'],
    workspace: {
      projects: {
        edit: {
          tasks: {
            build: {
              command: `${waitFor('../app/started')}; echo two > ../app/src/a.txt; touch ../app/go`,
              inputs: [],
              cache: false,
            },
          },
        },
        app: {
          tasks: {
            gen: {
              command: `touch started; ${waitFor('go')}; mkdir -p gen && cp src/a.txt gen/gen.txt`,
              inputs: ['src/**'],
              outputs: ['gen/**'],
            },
            use: {
              command: 'mkdir -p out && cat gen/gen.txt > out/use.txt',
              dependsOn: ['gen'],
              inputs: ['lib/**'],
              outputs: ['out/**'],
            },
            build: {
              command: 'mkdir -p pkg && cat out/use.txt > pkg/p.txt',
              dependsOn: ['use'],
              inputs: ['lib/**'],
              outputs: ['pkg/**'],
            },
          },
          files: {
            'src/a.txt': 'one\n',
            'lib/x.txt': 'x',
            '.gitignore': 'gen/\nout/\npkg/\ngo\nstarted\n',
          },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['edit#build', 'app#gen'] } },
      { write: { 'packages/app/src/a.txt': 'one\n', 'packages/app/go': '' } },
      {
        run: 'build',
        projects: ['app'],
        expect: { exit: 0, files: { 'packages/app/pkg/p.txt': 'one\n' } },
      },
    ],
  }),

  defineCase({
    id: 'inputs/runtime-output-change',
    category: 'inputs',
    kind: 'correctness',
    needs: ['runtime-inputs'],
    title: 'A change in what a key command prints runs the task again',
    why: 'A key command is how a task declares an input that is not a file, such as a tool’s version or a generated value. Its printed answer is part of the key, so a new answer must run the task again. Otherwise the runner replays output built for the old answer, for example a build made with a compiler version that is no longer installed.',
    from: ['runtime-inputs'],
    workspace: probed(['cat marker']),
    steps: [
      { run: 'build', expect: { exit: 0, files: { 'packages/a/out.txt': 'A\n' } } },
      { write: { marker: 'B\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { 'packages/a/out.txt': 'B\n' } },
      },
    ],
  }),

  defineCase({
    id: 'inputs/runtime-output-same',
    category: 'inputs',
    kind: 'efficiency',
    needs: ['runtime-inputs'],
    title: 'A key command printing the same as before lets the task replay',
    why: 'A key command makes its answer part of the key, not a reason to always run. If it prints the same as before, nothing the task depends on has changed, and the stored result is still right. A runner that treats any key command as uncacheable rebuilds on every run, and the declared input buys only wasted time.',
    from: ['runtime-inputs'],
    workspace: probed(['cat marker']),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'inputs/runtime-command-fails',
    category: 'inputs',
    kind: 'correctness',
    needs: ['runtime-inputs'],
    title: 'A key command that exits non-zero fails the run without running the task',
    why: 'Without its answer the key is unknown, so the task can neither replay nor run safely. Running it and storing the result under a guessed key, or replaying an old entry, is how stale bytes reach a green build. A command that fails also often means a tool is missing or broken. The run must stop and say so.',
    from: ['runtime-inputs', 'inputs-resolution'],
    workspace: probed(['sh -c "exit 7"']),
    steps: [{ run: 'build', expect: { exit: 'fail', notRan: ['a#build'] } }],
  }),

  defineCase({
    id: 'inputs/runtime-shared-once',
    category: 'inputs',
    kind: 'efficiency',
    needs: ['runtime-inputs'],
    title: 'A key command two projects share is run once per run',
    why: 'A key command reads the state of the machine, which does not change during a run. When two projects declare the same command, its answer is the same for both, so running it twice only costs time. A slow command, such as asking a toolchain for its version, would otherwise be paid once per project on every run.',
    from: ['runtime-inputs', 'inputs-resolution'],
    workspace: {
      projects: Object.fromEntries(
        ['a', 'b'].map((p) => [
          p,
          {
            tasks: {
              build: {
                command: `echo ${p} > out.txt`,
                inputs: [],
                runtime: ['mkdir -p dist && printf x >> dist/count && echo v1'],
                outputs: ['out.txt'],
              },
            },
            files: { '.gitignore': 'out.txt\n' },
          },
        ]),
      ),
    },
    steps: [{ run: 'build', expect: { exit: 0, files: { 'dist/count': 'x' } } }],
  }),

  defineCase({
    id: 'inputs/runtime-ignored-env-file',
    category: 'inputs',
    kind: 'correctness',
    needs: ['runtime-inputs'],
    title:
      'A gitignored `.env.local` keyed through a command’s output reruns the task when edited or removed',
    why: 'A gitignored file is local state and is no input by default, which is right. A user who wants such a file to count can say so through a key command, and that explicit choice must hold. Editing or removing `.env.local` must then run the task again; otherwise the build keeps an old API address or a value from a file that no longer exists.',
    from: ['runtime-inputs'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'mkdir -p dist && (cat .env.local 2>/dev/null || echo none) > dist/out.txt',
              inputs: ['src/**'],
              runtime: ['cat packages/a/.env.local 2>/dev/null | cksum'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a\n', '.env.local': 'API=a\n', '.gitignore': '.env*.local\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'API=a\n' } } },
      { write: { 'packages/a/.env.local': 'API=b\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'API=b\n' } } },
      { write: { 'packages/a/.env.local': null } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'none\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/runtime-reads-upstream-output',
    category: 'inputs',
    kind: 'correctness',
    needs: ['runtime-inputs'],
    title: 'A key command reading a dependency’s output answers after that dependency ran',
    why: 'A key command must answer for the state the task will run in. If it reads a dependency’s output before that dependency has run, it answers for the previous run. The task then builds from the new output but is stored under the old answer, and a later run replays the wrong result. The command must wait for the dependencies.',
    from: ['in-run-writes'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            gen: { command: 'cp seed.txt out.txt', inputs: ['seed.txt'], outputs: ['out.txt'] },
          },
          files: { 'seed.txt': 'X', '.gitignore': 'out.txt\n' },
        },
        app: {
          tasks: {
            build: {
              command: 'mkdir -p dist && cat ../lib/out.txt > dist/out.txt',
              dependsOn: ['lib#gen'],
              inputs: [],
              runtime: ['cat packages/lib/out.txt 2>/dev/null || true'],
              outputs: ['dist/**'],
            },
          },
        },
      },
    },
    steps: seeded('packages/lib/seed.txt', out('app'), 'build', ABBA),
  }),

  defineCase({
    id: 'inputs/reader-of-dependency-output',
    category: 'inputs',
    kind: 'correctness',
    title:
      'A task reading a same-project dependency’s output, its inputs excluding it, rebuilds when the source changes',
    why: 'A task may leave its dependency’s output out of its own inputs, since that output follows from the dependency’s inputs. Its key must then fold in the dependency’s key. When `src/a.txt` changes, the build runs and the test must run too. Otherwise the test result replayed is for the old source, and a broken change passes.',
    from: ['input-overlap'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'mkdir -p dist && cp src/a.txt dist/a.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
            test: {
              command: 'cat dist/a.txt > out.txt',
              dependsOn: ['build'],
              inputs: ['**', '!dist/**'],
              outputs: ['out.txt'],
            },
          },
          files: { 'src/a.txt': 'A1\n', '.gitignore': 'out.txt\n' },
        },
      },
    },
    steps: [
      { run: 'test', expect: { exit: 0, files: { 'packages/a/out.txt': 'A1\n' } } },
      { write: { 'packages/a/src/a.txt': 'A2\n' } },
      {
        run: 'test',
        expect: { exit: 0, ran: ['a#build', 'a#test'], files: { 'packages/a/out.txt': 'A2\n' } },
      },
    ],
  }),

  defineCase({
    id: 'inputs/reader-of-dependency-output-replays',
    category: 'inputs',
    kind: 'efficiency',
    title: 'A task reading a same-project dependency’s output replays when nothing changed',
    why: 'When nothing changed, both the build and the task that reads its output have results already stored. Folding the dependency’s key, rather than hashing its output after each run, lets the reader replay. A runner that cannot replay here reruns a test suite on every run though no source moved.',
    from: ['input-overlap'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'mkdir -p dist && cp src/a.txt dist/a.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
            test: {
              command: 'cat dist/a.txt > out.txt',
              dependsOn: ['build'],
              inputs: ['**', '!dist/**'],
              outputs: ['out.txt'],
            },
          },
          files: { 'src/a.txt': 'A1\n', '.gitignore': 'out.txt\n' },
        },
      },
    },
    steps: [
      { run: 'test', expect: { exit: 0 } },
      { run: 'test', expect: { exit: 0, notRan: ['a#build', 'a#test'] } },
    ],
  }),

  defineCase({
    id: 'inputs/unsearchable-untracked-directory',
    category: 'inputs',
    kind: 'correctness',
    title: 'An untracked directory under an input glob that the user may not enter is no error',
    why: 'A directory the user may not enter holds nothing git or the task can read, so it is no input. It is often left by another tool, a container or a mounted volume. Failing the run there blocks every build over a folder unrelated to the source. The case runs as a normal user, since root can enter every directory.',
    from: ['unreadable-input'],
    workspace: {
      projects: {
        a: {
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
    steps: [
      { write: { 'packages/a/src/locked/y.txt': 'y\n' } },
      { chmod: { 'packages/a/src/locked': 0o000 } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\n' } } },
      { chmod: { 'packages/a/src/locked': 0o755 } },
    ],
  }),

  defineCase({
    id: 'failure/undeclared-task',
    category: 'failure',
    kind: 'correctness',
    title: 'Running a task no project declares fails instead of passing with nothing run',
    why: 'Running a task that no project declares is almost always a typo or a missing config. A runner that exits 0 with nothing run reports a green build or test suite that never happened. In CI that hides a broken pipeline for as long as nobody reads the log. A clear failure points at the mistake at once.',
    from: ['default-build-not-declared'],
    workspace: {
      projects: {
        x: { tasks: { test: { command: 'echo t', inputs: [], outputs: [] } } },
        y: { deps: ['x'], tasks: { test: { command: 'echo t', inputs: [], outputs: [] } } },
      },
    },
    steps: [{ run: 'build', expect: { exit: 'fail', notRan: ['x#test', 'y#test'] } }],
  }),
]
