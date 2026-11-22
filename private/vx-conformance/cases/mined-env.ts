// Env, output and cache outcomes mined from the rivals’ own tests and fixed
// bugs: Turborepo’s crates/turborepo/tests (strict_env_vars, global_env_test,
// final_hash_contract, run_caching) and turborepo-cache’s archive restore
// tests, Nx’s tasks-runner cache specs and runtime inputs, and moon’s output
// hydration. Each case’s comment names its source; `from` names the vx tests
// guarding the same outcome.
import { defineCase, type Case, type TaskSpec, type WorkspaceSpec } from '../src/spec.ts'
import { CONCAT, chainProject, one, out } from './shapes.ts'

const A = 'packages/a'
const PATH = process.env['PATH'] ?? '/usr/bin:/bin'

const task = (command: string, extra: Partial<TaskSpec> = {}): TaskSpec => ({
  command,
  inputs: ['src/**'],
  outputs: ['dist/**'],
  ...extra,
})

/** One project whose build writes `dist` with `command` and reads `src`. */
const build = (command: string, extra: Partial<TaskSpec> = {}) => one(task(command, extra))

/** A build that prints `${NAME-unset}` of each declared variable into dist/out.txt. */
const prints = (names: string[], extra: Partial<TaskSpec> = {}): TaskSpec =>
  task(
    `mkdir -p dist && printf '${names.map(() => '%s|').join('')}\\n' ${names.map((n) => `"\${${n}-unset}"`).join(' ')} > dist/out.txt`,
    { env: names, ...extra },
  )

/** Runs the build, deletes dist, runs again: the second run must replay and bring `files` back. */
const roundTrip = (files: Record<string, string | null>) => [
  { run: 'build', expect: { exit: 0 as const } },
  { write: { [`${A}/dist`]: null } },
  { run: 'build', expect: { exit: 0 as const, notRan: ['a#build'], files } },
]

/** `n` bytes of `x`, as the shell writes them. */
const xs = (n: number) => `head -c ${n} /dev/zero | tr '\\0' x`

/** A root `ver.txt` a key command prints, and a build that copies it beside its source. */
const probed = (extra: Partial<TaskSpec> = {}): WorkspaceSpec => ({
  ...one(
    task('mkdir -p dist && cat ../../ver.txt src/a.txt > dist/out.txt', {
      runtime: ['cat ver.txt'],
      ...extra,
    }),
  ),
  files: { 'ver.txt': 'v1\n' },
})

/** One project with a cached build and a test that does nothing but write a mark. */
const buildAndTest = (testCommand: string): WorkspaceSpec => ({
  projects: {
    a: {
      tasks: {
        build: task(CONCAT),
        test: { command: testCommand, inputs: ['src/**'], outputs: ['out/**'] },
      },
      files: { 'src/a.txt': 'a\n' },
    },
  },
})

const many = Array.from({ length: 120 }, (_, i) => `V${String(i).padStart(3, '0')}`)
const LONG_NAME = `V${'_X'.repeat(120)}`

export default [
  // Turborepo final_hash_contract.rs env_mode_hashes: every declared value is part of the hash
  defineCase({
    id: 'env/second-of-two-declared-changes-reruns',
    category: 'env',
    kind: 'correctness',
    title: 'Changing only the second of two declared variables runs the task again',
    why: 'Each declared variable is an input of its own, not just the first one listed. A key that folds the first value and stops, or folds only names, sees nothing new when the second value moves. The task then replays output made with the old value of a variable it reads.',
    from: ['env-properties', 'parity-turbo-hashing-env'],
    needs: ['env-inputs'],
    workspace: one(prints(['FIRST', 'SECOND'])),
    steps: [
      { run: 'build', env: { FIRST: 'a', SECOND: 'x' }, expect: { exit: 0 } },
      {
        run: 'build',
        env: { FIRST: 'a', SECOND: 'y' },
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'a|y|\n' } },
      },
    ],
  }),

  // Turborepo strict_env_vars.rs test_usage_strict: a variable reaches the task once it is declared
  defineCase({
    id: 'env/newly-declared-variable-reaches-task',
    category: 'env',
    kind: 'correctness',
    title: 'Declaring a variable the task already reads gives it the value on the next run',
    why: 'Before the variable is declared, a strict tool hides it and a loose one lets it through unkeyed, so the first build may hold either value. Once it is declared, the task reads it and its value keys the result. The next run must leave the value now set, not replay a build made while the variable was hidden.',
    from: ['env', 'self-config-keyed'],
    needs: ['env-inputs'],
    workspace: one(task(`mkdir -p dist && printf '%s\\n' "\${MODE-unset}" > dist/out.txt`)),
    steps: [
      { run: 'build', env: { MODE: 'prod' }, expect: { exit: 0 } },
      {
        configure: (ws) => ({
          ...ws,
          projects: { a: { ...ws.projects['a']!, tasks: { build: prints(['MODE']) } } },
        }),
      },
      {
        run: 'build',
        env: { MODE: 'prod' },
        expect: { exit: 0, files: { [out('a')]: 'prod|\n' } },
      },
    ],
  }),

  // turborepo-env: a name without `*` matches itself only, never as a prefix
  defineCase({
    id: 'env/declared-name-is-not-a-prefix',
    category: 'env',
    kind: 'efficiency',
    title: 'Declaring `API` does not key the task on `API_URL`',
    why: 'A declared name is the one variable it spells. A tool that matches it as a prefix keys the task on every variable that starts the same, which in CI includes values that change on each job. The task then never replays, though nothing it reads has changed.',
    from: ['env', 'parity-turbo-hashing-env'],
    needs: ['env-inputs'],
    workspace: one(prints(['API'])),
    steps: [
      { run: 'build', env: { API: '1', API_URL: 'a' }, expect: { exit: 0 } },
      { run: 'build', env: { API: '1', API_URL: 'b' }, expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  // Nx hash of process.env[name]: an unset variable must not become the text "undefined"
  defineCase({
    id: 'env/undefined-and-null-text-not-unset',
    category: 'env',
    kind: 'correctness',
    title: 'A declared value of `undefined` or `null` is not the same as the variable unset',
    why: 'A runner written in JavaScript reads a missing variable as `undefined`, and turning that into text keys it exactly like a variable set to the word `undefined`. A shell script sees the difference at once. Keying them alike replays the unset build when the value is the word, or the reverse.',
    from: ['env-properties'],
    needs: ['env-inputs'],
    workspace: one(prints(['MODE'])),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'unset|\n' } } },
      {
        run: 'build',
        env: { MODE: 'undefined' },
        expect: { exit: 0, files: { [out('a')]: 'undefined|\n' } },
      },
      {
        run: 'build',
        env: { MODE: 'null' },
        expect: { exit: 0, files: { [out('a')]: 'null|\n' } },
      },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'unset|\n' } } },
    ],
  }),

  // Nx interpolates `{...}` and some runners `$VAR` in values: a value is data, never expanded
  defineCase({
    id: 'env/dollar-text-in-value-reaches-unexpanded',
    category: 'env',
    kind: 'correctness',
    title: 'A declared value holding `$HOME`, `${PATH}` and `$(id)` reaches the task as written',
    why: 'A value is data: passwords, templates and URLs hold dollar signs and backticks. A runner that expands them, as a shell would on a command line, hands the task a different value from the one the user set and keyed. Changing only the text after a dollar must still run the task again.',
    from: ['env-properties'],
    needs: ['env-inputs'],
    workspace: one(prints(['MODE'])),
    steps: [
      {
        run: 'build',
        env: { MODE: '$HOME ${PATH} $(id) `id` \\$x' },
        expect: { exit: 0, files: { [out('a')]: '$HOME ${PATH} $(id) `id` \\$x|\n' } },
      },
      {
        run: 'build',
        env: { MODE: '$USER ${PATH} $(id) `id` \\$x' },
        expect: {
          exit: 0,
          ran: ['a#build'],
          files: { [out('a')]: '$USER ${PATH} $(id) `id` \\$x|\n' },
        },
      },
    ],
  }),

  // A key that escapes values as JSON-like text can fold `\n` text and a newline alike
  defineCase({
    id: 'env/backslash-escape-text-not-control-character',
    category: 'env',
    kind: 'correctness',
    title: 'A declared value holding a backslash and `n` is not the same as one holding a newline',
    why: 'Two characters, a backslash and an `n`, are not one newline, and a task reading the value sees the difference. A key built by escaping values into text and unescaping them somewhere along the way can fold the two together. The second run then replays output made from the other value.',
    from: ['env-properties'],
    needs: ['env-inputs'],
    workspace: one(task(`mkdir -p dist && printf '%s|' "$MODE" > dist/out.txt`, { env: ['MODE'] })),
    steps: [
      {
        run: 'build',
        env: { MODE: 'a\\nb\\tc' },
        expect: { exit: 0, files: { [out('a')]: 'a\\nb\\tc|' } },
      },
      {
        run: 'build',
        env: { MODE: 'a\nb\tc' },
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'a\nb\tc|' } },
      },
    ],
  }),

  // Turborepo hashes `NAME=value` pairs: a value holding `\nNAME=` must not forge a second pair
  defineCase({
    id: 'env/value-holding-another-pair-does-not-collide',
    category: 'env',
    kind: 'correctness',
    title: 'A value that spells out a second variable does not key like that variable set',
    why: 'A key that joins `NAME=value` lines can be fooled by a value holding a newline and `B_VAL=2`: the joined text matches the run where `B_VAL` really is 2. The task sees two different environments, so the results differ. A replay across them leaves a build for variables that were never set that way.',
    from: ['env-properties', 'key-fold'],
    needs: ['env-inputs'],
    workspace: one(prints(['A_VAL', 'B_VAL'])),
    steps: [
      { run: 'build', env: { A_VAL: '1\nB_VAL=2' }, expect: { exit: 0 } },
      {
        run: 'build',
        env: { A_VAL: '1', B_VAL: '2' },
        expect: { exit: 0, files: { [out('a')]: '1|2|\n' } },
      },
      {
        run: 'build',
        env: { A_VAL: '1,B_VAL=2' },
        expect: { exit: 0, files: { [out('a')]: '1,B_VAL=2|unset|\n' } },
      },
    ],
  }),

  // Turborepo final_hash_contract.rs: the hash folds the whole declared set, however long
  defineCase({
    id: 'env/last-of-many-declared-changes-reruns',
    category: 'env',
    kind: 'correctness',
    title: 'Changing the last of 120 declared variables runs the task again',
    why: 'Large builds declare dozens of variables: feature flags, endpoints, build ids. A key that caps how many it folds, or a buffer that cuts the list short, misses a change near the end. The task then replays output made with a value it no longer has.',
    from: ['env-properties'],
    needs: ['env-inputs'],
    workspace: one(task(`mkdir -p dist && printf '%s\\n' "$V119" > dist/out.txt`, { env: many })),
    steps: [
      { run: 'build', env: Object.fromEntries(many.map((n) => [n, '1'])), expect: { exit: 0 } },
      {
        run: 'build',
        env: { ...Object.fromEntries(many.map((n) => [n, '1'])), V119: '2' },
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: '2\n' } },
      },
    ],
  }),

  // turborepo-env name handling: a long name is a name like any other
  defineCase({
    id: 'env/long-variable-name-reaches-and-keys',
    category: 'env',
    kind: 'correctness',
    title: 'A declared variable with a 241-character name reaches the task and keys it',
    why: 'Generated names, such as a package scope turned into a variable, can be long. A runner that cuts names to a fixed length passes or keys a different variable, or none. The value must reach the task and a change to it must run the task again.',
    from: ['env-properties'],
    needs: ['env-inputs'],
    workspace: one(prints([LONG_NAME])),
    steps: [
      {
        run: 'build',
        env: { [LONG_NAME]: 'one' },
        expect: { exit: 0, files: { [out('a')]: 'one|\n' } },
      },
      {
        run: 'build',
        env: { [LONG_NAME]: 'two' },
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'two|\n' } },
      },
    ],
  }),

  // Turborepo strict_env_vars.rs: PATH declared as an input keys the task like any variable
  defineCase({
    id: 'env/declared-path-change-finds-new-program',
    category: 'env',
    kind: 'correctness',
    title:
      'With PATH declared, pointing it at another copy of a program runs the task with that copy',
    why: 'PATH is usually left out of keys because it differs between machines, but a user who declares it says the task depends on which programs it finds. A tool that drops PATH from the key, or rewrites it before the task starts, replays the build made with the old program. The new PATH must both reach the task and key it.',
    from: ['env', 'env-path-delimiter'],
    needs: ['env-inputs'],
    workspace: {
      ...one(task('mkdir -p dist && greet > dist/out.txt', { env: ['PATH'] })),
      files: {
        'tools1/greet': '#!/bin/sh\necho one\n',
        'tools2/greet': '#!/bin/sh\necho two\n',
      },
    },
    steps: [
      { chmod: { 'tools1/greet': 0o755, 'tools2/greet': 0o755 } },
      {
        run: 'build',
        env: { PATH: `$ROOT/tools1:${PATH}` },
        expect: { exit: 0, files: { [out('a')]: 'one\n' } },
      },
      {
        run: 'build',
        env: { PATH: `$ROOT/tools2:${PATH}` },
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'two\n' } },
      },
    ],
  }),

  // Turborepo passThroughEnv: unkeyed in one task, keyed in the task that declares it
  defineCase({
    id: 'env/dependant-keys-what-dependency-passes-through',
    category: 'env',
    kind: 'correctness',
    title:
      'A variable a dependency passes through but its dependant declares reruns only the dependant',
    why: 'Each task says for itself what keys it. The dependency only lets the variable through, so a change replays it; the dependant reads and declares it, so the same change runs it again. A tool that applies one task’s choice to the other either rebuilds the dependency for nothing or replays the dependant with a value it no longer has.',
    from: ['env', 'parity-turbo-hashing-env'],
    needs: ['env-inputs', 'pass-through-env'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: task('mkdir -p dist && cat src/a.txt > dist/out.txt', {
              passThrough: ['FLAVOR'],
            }),
          },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: {
          deps: ['lib'],
          tasks: {
            build: task(`mkdir -p dist && printf '%s\\n' "$FLAVOR" > dist/out.txt`, {
              env: ['FLAVOR'],
              dependsOn: ['^build'],
            }),
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      { run: 'build', env: { FLAVOR: 'x' }, expect: { exit: 0 } },
      {
        run: 'build',
        env: { FLAVOR: 'y' },
        expect: {
          exit: 0,
          notRan: ['lib#build'],
          ran: ['app#build'],
          files: { [out('app')]: 'y\n' },
        },
      },
    ],
  }),

  // Turborepo strict_env_vars.rs test_usage_strict: a pass-through name that is not set stays unset
  defineCase({
    id: 'env/pass-through-unset-stays-unset',
    category: 'env',
    kind: 'correctness',
    title: 'A variable passed through but not set reaches the task as unset, not empty',
    why: 'Passing a variable through means the task gets whatever the shell has, and here the shell has nothing. A runner that fills in an empty value for each listed name changes what `${VAR-default}` and `[ -n "${VAR+x}" ]` see. Scripts then take the empty branch, though the user set nothing.',
    from: ['env', 'env-properties'],
    needs: ['pass-through-env'],
    workspace: one(
      task(`mkdir -p dist && printf '%s\\n' "\${FLAVOR-unset}" > dist/out.txt`, {
        passThrough: ['FLAVOR'],
      }),
    ),
    steps: [{ run: 'build', expect: { exit: 0, files: { [out('a')]: 'unset\n' } } }],
  }),

  // Turborepo task with the same name in env and passThroughEnv: the key wins
  defineCase({
    id: 'env/declared-and-passed-through-is-keyed',
    category: 'env',
    kind: 'correctness',
    title: 'A variable both declared and passed through still runs the task again when it changes',
    why: 'Listing a variable as passed through says it may reach the task; declaring it says its value keys the result. Both together must still key, or the declaration is silently dropped. A tool that lets the pass-through entry win replays output made with the old value.',
    from: ['env', 'parity-turbo-hashing-env'],
    needs: ['env-inputs', 'pass-through-env'],
    workspace: one(prints(['MODE'], { passThrough: ['MODE'] })),
    steps: [
      { run: 'build', env: { MODE: 'a' }, expect: { exit: 0 } },
      {
        run: 'build',
        env: { MODE: 'b' },
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'b|\n' } },
      },
    ],
  }),

  // Turborepo global_env_test.rs test_baseline_cache_hit: a task’s env never keys what it depends on
  defineCase({
    id: 'env/dependant-variable-change-replays-dependency',
    category: 'env',
    kind: 'efficiency',
    title: 'A variable only the dependant declares replays its dependency when it changes',
    why: 'A key flows down from a dependency to what depends on it, never back up. The dependency does not read the variable, so its result cannot change with it. Rebuilding it on every new value makes the whole chain rebuild for a flag only the last step reads.',
    from: ['env', 'key-fold'],
    needs: ['env-inputs'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        app: {
          deps: ['lib'],
          tasks: { build: prints(['MODE'], { dependsOn: ['^build'] }) },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      { run: 'build', env: { MODE: '1' }, expect: { exit: 0 } },
      {
        run: 'build',
        env: { MODE: '2' },
        expect: {
          exit: 0,
          notRan: ['lib#build'],
          ran: ['app#build'],
          files: { [out('app')]: '2|\n' },
        },
      },
    ],
  }),

  // Nx runtime inputs: the command’s whole output keys, not a prefix of it
  defineCase({
    id: 'env/runtime-long-output-tail-change-reruns',
    category: 'env',
    kind: 'correctness',
    title: 'A change at the end of a key command’s two-megabyte output runs the task again',
    why: 'A key command can print a lot: a dependency list, a tool’s full version report. A tool that keeps only the first part of the output misses a change at the end. The task then replays a result made under the old answer.',
    from: ['runtime-inputs'],
    needs: ['runtime-inputs'],
    workspace: {
      ...one(
        task('mkdir -p dist && cat ../../tail.txt > dist/out.txt', {
          runtime: [`${xs(2_000_000)}; cat tail.txt`],
        }),
      ),
      files: { 'tail.txt': 'one\n' },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'tail.txt': 'two\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'two\n' } } },
    ],
  }),

  // Nx runtime inputs hashed per command: two answers must not run together
  defineCase({
    id: 'env/runtime-answers-do-not-run-together',
    category: 'env',
    kind: 'correctness',
    title: 'Two key commands printing `ab` and `c`, then `a` and `bc`, run the task again',
    why: 'Each key command is an input of its own. A key that glues the answers together sees `abc` both times, so a change that moves text from one answer to the other replays the old result. The task reads both values, so its output differs.',
    from: ['runtime-inputs', 'key-fold'],
    needs: ['runtime-inputs'],
    workspace: {
      ...one(
        task(
          `mkdir -p dist && printf '%s|%s\\n' "$(cat ../../r1.txt)" "$(cat ../../r2.txt)" > dist/out.txt`,
          {
            runtime: ['cat r1.txt', 'cat r2.txt'],
          },
        ),
      ),
      files: { 'r1.txt': 'ab', 'r2.txt': 'c' },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'r1.txt': 'a', 'r2.txt': 'bc' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'a|bc\n' } } },
    ],
  }),

  // Nx runtime inputs feed the task hash, and the task hash keys every dependant
  defineCase({
    id: 'env/runtime-change-cascades-to-dependant',
    category: 'env',
    kind: 'correctness',
    title:
      'A new answer from a dependency’s key command rebuilds the project that reads its output',
    why: 'The dependency’s output holds what its key command printed, so a new answer gives the dependant new input bytes. The dependant’s key folds its dependency’s key, so it must run again too. Replaying it leaves a build made from the old version beside a dependency rebuilt with the new one.',
    from: ['runtime-inputs', 'key-fold'],
    needs: ['runtime-inputs'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: task('mkdir -p dist && cat ../../ver.txt src/a.txt > dist/out.txt', {
              runtime: ['cat ver.txt'],
            }),
          },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: chainProject('app', ['lib']),
      },
      files: { 'ver.txt': 'v1\n' },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('app')]: 'v1\nlib\napp\n' } } },
      { write: { 'ver.txt': 'v2\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['lib#build', 'app#build'],
          files: { [out('app')]: 'v2\nlib\napp\n' },
        },
      },
    ],
  }),

  // Nx runtime inputs: an empty answer is an answer, and a first non-empty one is a change
  defineCase({
    id: 'env/runtime-empty-answer-then-text-reruns',
    category: 'env',
    kind: 'correctness',
    title: 'A key command that printed nothing, then prints something, runs the task again',
    why: 'An empty answer is a valid value: a missing flag file, a feature not set up yet. It must replay while it stays empty, and the first real answer is a change like any other. A tool that skips empty answers, or treats them as an error, either rebuilds every time or misses the switch.',
    from: ['runtime-inputs'],
    needs: ['runtime-inputs'],
    workspace: {
      ...one(
        task('mkdir -p dist && { cat ../../flag.txt 2>/dev/null; cat src/a.txt; } > dist/out.txt', {
          runtime: ['cat flag.txt 2>/dev/null; true'],
        }),
      ),
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { write: { 'flag.txt': 'on\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'on\na\n' } } },
    ],
  }),

  // Nx runtime inputs are per task: a sibling without the input keeps its entry
  defineCase({
    id: 'env/runtime-change-replays-sibling-task',
    category: 'env',
    kind: 'efficiency',
    title: 'A new answer from one task’s key command replays the project’s other task',
    why: 'A key command keys the task that declares it, not its whole project. The project’s test does not run the command and does not read what it prints. Rerunning it on every new answer wastes the cache for a value only the build depends on.',
    from: ['runtime-inputs'],
    needs: ['runtime-inputs'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: task('mkdir -p dist && cat ../../ver.txt src/a.txt > dist/out.txt', {
              runtime: ['cat ver.txt'],
            }),
            test: {
              command: 'mkdir -p out && cat src/a.txt > out/t.txt',
              inputs: ['src/**'],
              outputs: ['out/**'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
      files: { 'ver.txt': 'v1\n' },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'test', expect: { exit: 0 } },
      { write: { 'ver.txt': 'v2\n' } },
      { run: 'test', expect: { exit: 0, notRan: ['a#test'] } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
    ],
  }),

  // Nx runtime inputs: the key is the answer, so an earlier answer finds its earlier entry
  defineCase({
    id: 'env/runtime-earlier-answer-replays-its-result',
    category: 'env',
    kind: 'correctness',
    title: 'Putting a key command’s earlier answer back replays that answer’s result',
    why: 'Switching a tool version back and forth is common, and each version has its own build. When the old answer returns, the old entry is the right one, and the tree must hold its output. A tool that keeps only the newest entry rebuilds, and one that restores the newest leaves the other version’s build.',
    from: ['runtime-inputs'],
    needs: ['runtime-inputs'],
    workspace: probed(),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'ver.txt': 'v2\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { 'ver.txt': 'v1\n' } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'], files: { [out('a')]: 'v1\na\n' } } },
    ],
  }),

  // vx restore-umask.test.ts; Turborepo restore keeps the archived mode
  defineCase({
    id: 'outputs/private-modes-from-umask-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'Outputs a build makes under `umask 077` come back private, 0600 and 0700',
    why: 'A task that writes keys or tokens sets a tight umask so nobody else on the machine can read them. A hit that restores the default 0644 hands those files to every user. The replayed tree must keep the modes the build gave it.',
    from: ['restore-umask'],
    workspace: build(
      'umask 077 && mkdir -p dist/keys && cat src/a.txt > dist/keys/id && printf "#!/bin/sh\\n" > dist/run.sh && chmod u+x dist/run.sh',
    ),
    steps: [
      ...roundTrip({ [`${A}/dist/keys/id`]: 'a\n' }),
      {
        check: {
          modes: {
            [`${A}/dist/keys/id`]: 0o600,
            [`${A}/dist/keys`]: 0o700,
            [`${A}/dist/run.sh`]: 0o700,
          },
        },
      },
    ],
  }),

  // Turborepo cache_archive restore_regular: the header mode comes back, bit for bit
  defineCase({
    id: 'outputs/uncommon-file-modes-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'Output files with modes 0640, 0604, 0711 and 0444 come back with those modes',
    why: 'A mode is part of what the build left: group-only config, an executable nobody may read, a file meant to stay read-only. A restore that rounds modes to “executable or not” changes who may read or run the files. The replayed tree should match the built one exactly.',
    from: ['artifact-roundtrip', 'restore-umask'],
    workspace: build(
      'mkdir -p dist && for m in 640 604 711 444; do printf "$m\\n" > dist/f$m; chmod $m dist/f$m; done',
    ),
    steps: [
      ...roundTrip({ [`${A}/dist/f640`]: '640\n', [`${A}/dist/f444`]: '444\n' }),
      {
        check: {
          modes: {
            [`${A}/dist/f640`]: 0o640,
            [`${A}/dist/f604`]: 0o604,
            [`${A}/dist/f711`]: 0o711,
            [`${A}/dist/f444`]: 0o444,
          },
        },
      },
    ],
  }),

  // Turborepo cache_archive test_restore: names are bytes, a newline included
  defineCase({
    id: 'outputs/newline-in-output-name-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'Output files whose names hold a newline, inside or at the end, come back',
    why: 'Linux allows any byte but `/` and NUL in a name, and generated files sometimes carry a stray newline from a variable. A store that lists outputs one per line splits such a name in two and restores neither. The hit must bring the file back under the name the build gave it.',
    from: ['tar-roundtrip-fuzz', 'artifact-roundtrip'],
    workspace: build("mkdir -p dist && printf 1 > 'dist/a\nb' && printf 2 > 'dist/c\n'"),
    steps: roundTrip({ [`${A}/dist/a\nb`]: '1', [`${A}/dist/c\n`]: '2' }),
  }),

  // Turborepo cache_archive: entry names are literal, never globs
  defineCase({
    id: 'outputs/glob-characters-in-output-names-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'Output files named `a*b`, `q?`, `[x]`, `{a,b}` and `!neg` come back as written',
    why: 'Output patterns are globs, but the files they match are names, and route-based frameworks write names with brackets and braces. A restore that feeds stored names back through a glob matcher can skip them, expand them or write a different file. Each one must come back under its own name.',
    from: ['tar-roundtrip-fuzz', 'brace-outputs'],
    workspace: build(
      "mkdir -p dist && printf 1 > 'dist/a*b' && printf 2 > 'dist/q?' && printf 3 > 'dist/[x]' && printf 4 > 'dist/{a,b}' && printf 5 > 'dist/!neg'",
    ),
    steps: [
      ...roundTrip({
        [`${A}/dist/a*b`]: '1',
        [`${A}/dist/q?`]: '2',
        [`${A}/dist/[x]`]: '3',
        [`${A}/dist/{a,b}`]: '4',
        [`${A}/dist/!neg`]: '5',
      }),
      { check: { missing: [`${A}/dist/ab`, `${A}/dist/x`, `${A}/dist/a`, `${A}/dist/neg`] } },
    ],
  }),

  // Turborepo cache_archive test_name_traversal: odd but safe names are kept, not rejected
  defineCase({
    id: 'outputs/option-and-escape-looking-names-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'Output files named `-rf`, `--help`, `~`, `#x`, `%2F` and `a:b` come back as written',
    why: 'A name can look like a command-line option, a home directory, a comment or a URL escape. A restore that hands names to a program, expands a `~` or decodes `%2F` into a slash writes the wrong path or none. These are ordinary file names and must round-trip unchanged.',
    from: ['tar-roundtrip-fuzz', 'archive-restore-fuzz'],
    workspace: build(
      "mkdir -p dist && printf 1 > dist/-rf && printf 2 > dist/--help && printf 3 > 'dist/~' && printf 4 > 'dist/#x' && printf 5 > dist/%2F && printf 6 > dist/a:b",
    ),
    steps: roundTrip({
      [`${A}/dist/-rf`]: '1',
      [`${A}/dist/--help`]: '2',
      [`${A}/dist/~`]: '3',
      [`${A}/dist/#x`]: '4',
      [`${A}/dist/%2F`]: '5',
      [`${A}/dist/a:b`]: '6',
    }),
  }),

  // Turborepo cache_archive test_dot_dot_*: only `.` and `..` are special, not names made of dots
  defineCase({
    id: 'outputs/dot-heavy-and-space-edged-names-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'Output files named `...`, `..foo`, `b.` and ` lead `, spaces kept, come back',
    why: 'A restore must refuse `..` as a path step, but a name that only starts with dots, or is three dots, is an ordinary file. Windows habits strip a trailing dot or space, which changes the name on Linux. A sanitizer that is too eager drops these files from the hit, and the replayed tree is short.',
    from: ['archive-restore-fuzz', 'tar-roundtrip-fuzz'],
    workspace: build(
      "mkdir -p dist && printf 1 > dist/... && printf 2 > dist/..foo && printf 3 > dist/b. && printf 4 > 'dist/ lead '",
    ),
    steps: roundTrip({
      [`${A}/dist/...`]: '1',
      [`${A}/dist/..foo`]: '2',
      [`${A}/dist/b.`]: '3',
      [`${A}/dist/ lead `]: '4',
    }),
  }),

  // A store keyed case-insensitively folds names a Linux tree holds apart
  defineCase({
    id: 'outputs/names-differing-in-case-all-restored',
    category: 'outputs',
    kind: 'correctness',
    title:
      'Outputs `README.md`, `Readme.md` and `readme.md` all come back, each with its own bytes',
    why: 'On Linux these are three files. A store that keys entries by a lowercased path, or restores through a case-insensitive map, keeps one and writes it three times or drops two. The hit must leave the three files the build wrote.',
    from: ['artifact-roundtrip'],
    workspace: build(
      'mkdir -p dist && printf 1 > dist/README.md && printf 2 > dist/Readme.md && printf 3 > dist/readme.md',
    ),
    steps: roundTrip({
      [`${A}/dist/README.md`]: '1',
      [`${A}/dist/Readme.md`]: '2',
      [`${A}/dist/readme.md`]: '3',
    }),
  }),

  // vx tar-roundtrip-fuzz: a ustar name field of exactly 100 bytes has no terminating NUL
  defineCase({
    id: 'outputs/name-of-exactly-100-bytes-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output whose name is exactly 100 bytes long comes back whole',
    why: 'A tar header holds a name in 100 bytes, NUL-terminated only when shorter. A reader that always looks for the NUL runs into the next field and invents a longer name, and a writer can cut the last byte. Exactly 100 bytes is the edge either bug falls off.',
    from: ['tar-roundtrip-fuzz', 'tar-stream'],
    workspace: build(`mkdir -p dist && printf 1 > dist/${'n'.repeat(96)}.txt`),
    steps: roundTrip({ [`${A}/dist/${'n'.repeat(96)}.txt`]: '1' }),
  }),

  // Turborepo cache_archive test_path_exceeding_260_chars: a name at the file system’s limit
  defineCase({
    id: 'outputs/name-of-255-bytes-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output whose name is 255 bytes long, the file system’s limit, comes back',
    why: 'Generated names, such as hashed chunk files, can sit right at the 255-byte limit. A store that adds a suffix while writing, such as a temporary `.tmp`, cannot create the file there and the restore fails. The file must come back under its full name.',
    from: ['tar-roundtrip-fuzz', 'restore-in-place'],
    workspace: build(`mkdir -p dist && printf 1 > dist/${'n'.repeat(251)}.txt`),
    steps: roundTrip({ [`${A}/dist/${'n'.repeat(251)}.txt`]: '1' }),
  }),

  // vx tar-stream: ustar splits a path into a 155-byte prefix and a 100-byte name
  defineCase({
    id: 'outputs/paths-around-the-tar-prefix-split-restored',
    category: 'outputs',
    kind: 'correctness',
    title:
      'Output paths of 150 to 260 bytes, split at every place a tar header can split them, come back',
    why: 'A tar header can hold a path of up to 255 bytes by splitting it at a slash into a prefix and a name. Paths just under, at and over that limit take different branches, and each one has had off-by-one bugs. Every path must come back exactly where the build put it.',
    from: ['tar-roundtrip-fuzz', 'tar-stream'],
    workspace: build(
      `mkdir -p dist && for p in 140 150 154 155 156; do d=dist/$(printf %0\${p}d 0); mkdir -p $d; printf $p > $d/${'m'.repeat(99)}; done`,
    ),
    steps: roundTrip(
      Object.fromEntries(
        [140, 150, 154, 155, 156].map((p) => [
          `${A}/dist/${'0'.repeat(p)}/${'m'.repeat(99)}`,
          String(p),
        ]),
      ),
    ),
  }),

  // vx tar-roundtrip-fuzz: a name measured in bytes, not characters
  defineCase({
    id: 'outputs/multibyte-name-over-100-bytes-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output named with 40 three-byte characters, 120 bytes but 40 letters, comes back',
    why: 'Header limits count bytes, and a name of CJK letters is three times as long in bytes as it looks. A writer that checks the length in characters thinks it fits and cuts it in the middle of a character. The hit then writes a name that is not even valid UTF-8.',
    from: ['tar-roundtrip-fuzz'],
    workspace: build(`mkdir -p dist && printf 1 > dist/${'日'.repeat(40)}`),
    steps: roundTrip({ [`${A}/dist/${'日'.repeat(40)}`]: '1' }),
  }),

  // vx tar-stream: a link target of exactly 100 bytes fills the linkname field
  defineCase({
    id: 'outputs/link-target-of-exactly-100-bytes-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output link whose target is exactly 100 bytes comes back pointing at the same name',
    why: 'A tar header holds a link target in 100 bytes, with no NUL when it fills them. A reader that runs past the field points the link somewhere else; a writer that cuts a byte leaves it dangling. Exactly 100 bytes is where both happen.',
    from: ['tar-roundtrip-fuzz', 'output-links'],
    workspace: build(
      `mkdir -p dist && printf 1 > dist/${'t'.repeat(96)}.txt && ln -s ${'t'.repeat(96)}.txt dist/l`,
    ),
    steps: [
      ...roundTrip({ [`${A}/dist/l`]: '1' }),
      { check: { links: { [`${A}/dist/l`]: `${'t'.repeat(96)}.txt` } } },
    ],
  }),

  // vx tar-stream: a body is padded to 512-byte blocks and the archive to its record size
  defineCase({
    id: 'outputs/file-sizes-at-block-edges-restored',
    category: 'outputs',
    kind: 'correctness',
    title:
      'Output files of 0, 1, 511, 512, 513, 10,240 and 10,241 bytes come back at their exact sizes',
    why: 'Archives pad each file to 512-byte blocks and group blocks into 10 KiB records. A reader that gets the padding wrong at the edge adds stray bytes, drops the last block or reads the next header as data. Every size at an edge must come back byte for byte.',
    from: ['tar-roundtrip-fuzz', 'artifact-roundtrip'],
    workspace: build(
      `mkdir -p dist && for n in 0 1 511 512 513 10240 10241; do head -c $n /dev/zero | tr '\\0' x > dist/f$n; done`,
    ),
    steps: roundTrip(
      Object.fromEntries(
        [0, 1, 511, 512, 513, 10240, 10241].map((n) => [`${A}/dist/f${n}`, 'x'.repeat(n)]),
      ),
    ),
  }),

  // Turborepo cache_archive test_hardlink_entry_type_rejected: a hard-linked pair still restores
  defineCase({
    id: 'outputs/hard-linked-pair-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'Two output names hard-linked to one file both come back with its bytes',
    why: 'Bundlers and package tools hard-link identical files to save space. An archive may record the second name as a link to the first, and a restore that refuses or skips such entries leaves one name missing. Both names must come back holding the same bytes.',
    from: ['artifact-roundtrip', 'tar-stream'],
    workspace: build('mkdir -p dist && cat src/a.txt > dist/one && ln dist/one dist/two'),
    steps: roundTrip({ [`${A}/dist/one`]: 'a\n', [`${A}/dist/two`]: 'a\n' }),
  }),

  // Turborepo cache_archive restore_regular_file_replaces_final_symlink_instead_of_following_it
  defineCase({
    id: 'outputs/output-file-swapped-for-link-not-written-through',
    category: 'outputs',
    kind: 'correctness',
    title:
      'An output file a user replaced with a link elsewhere is put back as a file, the link’s target untouched',
    why: 'A restore that opens the output path and writes into it follows a link standing there, and overwrites whatever the link points at. That can be any file in the workspace or beyond. The restore must replace the link with the output file and leave the target as it was.',
    from: ['restore-link-swap', 'save-output-swapped-link'],
    workspace: { ...build(CONCAT), files: { 'victim.txt': 'keep\n' } },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { link: { [`${A}/dist/out.txt`]: '../../../victim.txt' } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\n', 'victim.txt': 'keep\n' } } },
    ],
  }),

  // Nx cache.spec.ts outputs already in place: one missing file is not “in place”
  defineCase({
    id: 'outputs/one-deleted-among-many-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'One output deleted from twenty comes back on the next run, the others untouched',
    why: 'A tool that decides outputs are in place by checking the directory, or a sample of files, misses one deleted file and replays nothing. Whatever needs that file then fails though the run said the task was current. The next run must put the missing file back.',
    from: ['restore-in-place', 'output-dirs'],
    workspace: build('mkdir -p dist && for i in $(seq 10 29); do echo $i > dist/f$i; done'),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist/f17`]: null } },
      {
        run: 'build',
        expect: { exit: 0, files: { [`${A}/dist/f17`]: '17\n', [`${A}/dist/f29`]: '29\n' } },
      },
    ],
  }),

  // Nx cache.spec.ts: a directory left empty by hand is not the outputs
  defineCase({
    id: 'outputs/output-dir-emptied-by-hand-refilled',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output directory the user emptied and left in place is filled again on the next run',
    why: 'An empty `dist` exists, so a check that only asks whether the output directory is there finds it and restores nothing. The files the task wrote are all gone, and the next step fails. The run must notice and bring them back.',
    from: ['restore-in-place', 'output-empty-dir'],
    workspace: build(CONCAT),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { sh: `rm -rf ${A}/dist && mkdir ${A}/dist` },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\n' } } },
    ],
  }),

  // vx restore-mode: a restored program still runs for the project that needs it
  defineCase({
    id: 'outputs/restored-program-runs-for-dependant',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A program a dependency built, deleted and replayed, still runs for the dependant that calls it',
    why: 'The point of restoring an executable is that it can be run. A hit that brings the file back without its executable bit, or with a broken first line, passes a file check and fails the dependant with “permission denied”. The dependant must run the replayed program as it ran the built one.',
    from: ['dependency-outputs-there', 'artifact-roundtrip'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: task(
              "mkdir -p dist && printf '#!/bin/sh\\necho tool-ran\\n' > dist/tool && chmod +x dist/tool",
            ),
          },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: {
          deps: ['lib'],
          tasks: {
            build: task(
              'mkdir -p dist && ../lib/dist/tool > dist/out.txt && cat src/a.txt >> dist/out.txt',
              {
                dependsOn: ['^build'],
              },
            ),
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/lib/dist': null, 'packages/app/src/a.txt': 'app2\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['lib#build'],
          ran: ['app#build'],
          files: { [out('app')]: 'tool-ran\napp2\n' },
        },
      },
    ],
  }),

  // Turborepo cache_archive test_nfc_vs_nfd_normalization: two spellings, two files
  defineCase({
    id: 'outputs/composed-and-decomposed-names-both-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'Outputs named `café` in composed and in decomposed Unicode both come back',
    why: 'Linux keeps names as bytes, so `é` as one code point and as `e` plus an accent are two files. A store that normalizes names folds them into one, restoring a single file or writing one over the other. The hit must leave both, each with its own bytes.',
    from: ['tar-roundtrip-fuzz'],
    workspace: build(
      'mkdir -p dist && printf 1 > "dist/$(printf \'caf\\303\\251\')" && printf 2 > "dist/$(printf \'cafe\\314\\201\')"',
    ),
    steps: roundTrip({ [`${A}/dist/caf\u00e9`]: '1', [`${A}/dist/cafe\u0301`]: '2' }),
  }),

  // Turborepo cache_archive test_unicode_bidi_override_in_path: unusual code points are names too
  defineCase({
    id: 'outputs/invisible-characters-in-names-restored',
    category: 'outputs',
    kind: 'correctness',
    title:
      'Output names holding a zero-width space, a right-to-left mark or a byte-order mark come back',
    why: 'These code points are valid in a name and turn up in files generated from user text. A store that strips invisible characters, or a byte-order mark at the start of a name, writes a different name or merges two. Each file must come back with its name byte for byte.',
    from: ['tar-roundtrip-fuzz'],
    workspace: build(
      'mkdir -p dist && printf 1 > "dist/a$(printf \'\\342\\200\\213\')b" && printf 2 > "dist/$(printf \'\\342\\200\\256\')x" && printf 3 > "dist/$(printf \'\\357\\273\\277\')y"',
    ),
    steps: roundTrip({
      [`${A}/dist/a\u200bb`]: '1',
      [`${A}/dist/\u202ex`]: '2',
      [`${A}/dist/\ufeffy`]: '3',
    }),
  }),

  // vx artifact-ceiling: a file that compresses a thousandfold is still restored whole
  defineCase({
    id: 'outputs/highly-compressible-large-output-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'A 64 MiB output of zero bytes comes back whole',
    why: 'Zero-filled images and sparse data compress to almost nothing. A restore that guards against compression bombs by capping the expansion ratio refuses a legitimate entry, and one that streams it wrong stops short. The file must come back at its full size and bytes.',
    from: ['artifact-ceiling', 'artifact-roundtrip'],
    workspace: build('mkdir -p dist && head -c 67108864 /dev/zero > dist/zeros.bin'),
    steps: [...roundTrip({}), { sh: `head -c 67108864 /dev/zero | cmp - ${A}/dist/zeros.bin` }],
  }),

  // vx tar-numeric-fields: a time before 1970 is a negative number in the header
  defineCase({
    id: 'outputs/file-dated-before-1970-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output whose modification time is in 1960 is cached and comes back',
    why: 'Reproducible builds pin file times, and some pin them to odd dates. A time before 1970 is negative, which plain octal tar fields cannot hold. A store that fails on it caches nothing for the build, and one that misreads it may refuse the restore.',
    from: ['tar-numeric-fields'],
    workspace: build(`${CONCAT} && touch -t 196001010000 dist/out.txt`),
    steps: roundTrip({ [out('a')]: 'a\n' }),
  }),

  // vx tar-numeric-fields: a time past 2242 overflows the octal field
  defineCase({
    id: 'outputs/file-dated-after-2242-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output whose modification time is in the year 2300 is cached and comes back',
    why: 'The octal time field of a tar header runs out in 2242, after which a writer must switch to a binary form. A clock set wrong or a pinned far-future time puts such a file in the outputs. A store that overflows the field writes a broken header, and the restore fails or brings back garbage.',
    from: ['tar-numeric-fields'],
    workspace: build(`${CONCAT} && touch -d '2300-01-01 00:00:00' dist/out.txt`),
    steps: roundTrip({ [out('a')]: 'a\n' }),
  }),

  // Nx outputs with spaces: `{projectRoot}/out dir` is one path
  defineCase({
    id: 'outputs/output-directory-with-space-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output directory named `out dir` is cached and comes back',
    why: 'A space in a declared output path is part of the name, not a separator. A tool that splits the pattern on spaces looks for `out` and `dir`, saves nothing, and fails or replays an empty tree. The directory must round-trip like any other.',
    from: ['output-dirs', 'run-output-paths'],
    workspace: one({
      command: "mkdir -p 'out dir' && cat src/a.txt > 'out dir/a.txt'",
      inputs: ['src/**'],
      outputs: ['out dir/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/out dir`]: null } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/out dir/a.txt`]: 'a\n' } },
      },
    ],
  }),

  // Turborepo globs over non-ASCII paths: a pattern’s literal part is matched as bytes
  defineCase({
    id: 'outputs/non-ascii-output-pattern-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output pattern `出力/**` stores and restores the directory it names',
    why: 'Teams name directories in their own language, and the output pattern names them the same way. A glob matcher that handles only ASCII matches nothing, so the task saves an empty entry or fails. The directory must come back with its files.',
    from: ['output-dirs', 'tar-roundtrip-fuzz'],
    workspace: one({
      command: 'mkdir -p 出力 && cat src/a.txt > 出力/a.txt',
      inputs: ['src/**'],
      outputs: ['出力/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/出力`]: null } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/出力/a.txt`]: 'a\n' } },
      },
    ],
  }),

  // Turborepo run_caching.rs test_dependency_outputs_hashes: a dependency’s outputs are right before its dependant reads them
  defineCase({
    id: 'outputs/edited-dependency-output-put-back-before-dependant',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A dependency’s output edited by hand is put back before the dependant that reads it rebuilds',
    why: 'A dependant builds from what its dependency left on disk. If the dependency replays without restoring its edited output, the dependant reads the edit and bakes it into a fresh build that is then cached. The dependency’s outputs must hold the stored bytes before the dependant starts.',
    from: ['dependency-outputs-there', 'restore-in-place'],
    workspace: { projects: { lib: chainProject('lib'), app: chainProject('app', ['lib']) } },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [out('lib')]: 'tampered\n', 'packages/app/src/a.txt': 'app2\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['app#build'], files: { [out('app')]: 'lib\napp2\n' } },
      },
    ],
  }),

  // Turborepo final_hash_contract.rs workspace_config_hashes: a task hashes its own definition
  defineCase({
    id: 'cache/new-sibling-task-keeps-entry',
    category: 'cache',
    kind: 'efficiency',
    title: 'Adding a second task to a project replays the first',
    why: 'A task’s key holds its own definition, not the whole project file. Adding a test beside the build changes nothing the build reads. A tool that hashes the project’s whole config rebuilds every task whenever any one of them is added or edited.',
    from: ['self-config-keyed', 'stable-keys'],
    workspace: one(task(CONCAT)),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      {
        configure: (ws) => ({
          ...ws,
          projects: {
            a: {
              ...ws.projects['a']!,
              tasks: {
                ...ws.projects['a']!.tasks,
                test: {
                  command: 'mkdir -p out && cat src/a.txt > out/t.txt',
                  inputs: ['src/**'],
                  outputs: ['out/**'],
                },
              },
            },
          },
        }),
      },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  // Turborepo final_hash_contract.rs: one task’s command is not another task’s input
  defineCase({
    id: 'cache/sibling-task-command-change-keeps-entry',
    category: 'cache',
    kind: 'efficiency',
    title: 'Changing the command of a project’s test replays its build',
    why: 'The build does not run the test’s command and does not depend on it. Its key should not move when the test changes. A tool that keys every task on the whole project config rebuilds the build each time a test script is touched.',
    from: ['self-config-keyed', 'stable-keys'],
    workspace: buildAndTest('mkdir -p out && cat src/a.txt > out/t.txt'),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      {
        configure: (ws) => ({
          ...ws,
          projects: {
            a: {
              ...ws.projects['a']!,
              tasks: {
                ...ws.projects['a']!.tasks,
                test: {
                  command: 'mkdir -p out && cat src/a.txt src/a.txt > out/t.txt',
                  inputs: ['src/**'],
                  outputs: ['out/**'],
                },
              },
            },
          },
        }),
      },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  // Turborepo dependency hashes fold the dependency’s task, not its project’s other tasks
  defineCase({
    id: 'cache/dependency-sibling-task-change-keeps-dependant',
    category: 'cache',
    kind: 'efficiency',
    title: 'Changing the test command of a dependency replays the build that depends on its build',
    why: 'The app’s build waits on the library’s build, not its test. A change to the library’s test touches nothing either build reads. Rebuilding the app for it spreads a test edit across every project downstream.',
    from: ['key-fold', 'self-config-keyed'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: chainProject('lib').tasks!['build']!,
            test: {
              command: 'mkdir -p out && cat src/a.txt > out/t.txt',
              inputs: ['src/**'],
              outputs: ['out/**'],
            },
          },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: chainProject('app', ['lib']),
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      {
        configure: (ws) => ({
          ...ws,
          projects: {
            ...ws.projects,
            lib: {
              ...ws.projects['lib']!,
              tasks: {
                ...ws.projects['lib']!.tasks,
                test: {
                  command: 'mkdir -p out && echo other > out/t.txt',
                  inputs: ['src/**'],
                  outputs: ['out/**'],
                },
              },
            },
          },
        }),
      },
      { run: 'build', expect: { exit: 0, notRan: ['lib#build', 'app#build'] } },
    ],
  }),

  // Nx runtime inputs shared by projects: one answer keys every task that declares it
  defineCase({
    id: 'env/runtime-shared-answer-change-reruns-both',
    category: 'env',
    kind: 'correctness',
    title: 'A new answer from a key command two projects share runs both projects’ tasks again',
    why: 'Running a shared key command once per run is fine, but its answer still keys each task that declares it. A tool that caches the answer per command and reuses an old one for the second project replays that project with the old version. Both builds read the value, so both must run again.',
    from: ['runtime-inputs'],
    needs: ['runtime-inputs'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: task('mkdir -p dist && cat ../../ver.txt src/a.txt > dist/out.txt', {
              runtime: ['cat ver.txt'],
            }),
          },
          files: { 'src/a.txt': 'a\n' },
        },
        b: {
          tasks: {
            build: task('mkdir -p dist && cat ../../ver.txt src/a.txt > dist/out.txt', {
              runtime: ['cat ver.txt'],
            }),
          },
          files: { 'src/a.txt': 'b\n' },
        },
      },
      files: { 'ver.txt': 'v1\n' },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'ver.txt': 'v2\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['a#build', 'b#build'],
          files: { [out('a')]: 'v2\na\n', [out('b')]: 'v2\nb\n' },
        },
      },
    ],
  }),

  // Nx runtime inputs: a probe that fails is never a hit, even after a run that hit
  defineCase({
    id: 'env/runtime-failing-after-a-hit-fails-run',
    category: 'env',
    kind: 'correctness',
    title:
      'A key command that starts failing after the task was cached fails the run instead of replaying',
    why: 'When the key command fails there is no answer, so there is no key to look up. Falling back to the last answer, or to no answer, replays a result for a version the machine may no longer have. The run must fail and say so, as it does when the command fails on the first run.',
    from: ['runtime-probe-exit', 'runtime-inputs'],
    needs: ['runtime-inputs'],
    workspace: {
      ...one(task(`${CONCAT}`, { runtime: ['cat ver.txt'] })),
      files: { 'ver.txt': 'v1\n' },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { write: { 'ver.txt': null } },
      { run: 'build', expect: { exit: 'fail', notRan: ['a#build'] } },
    ],
  }),

  // Turborepo cache_archive test_deeply_nested_path
  defineCase({
    id: 'outputs/hundred-levels-deep-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output file 100 directories deep comes back',
    why: 'Generated trees can nest deeply, such as a copied `node_modules` or a docs site mirroring routes. A restore that walks directories recursively, or makes parents one call per level with a fixed limit, can stop partway. The file must come back at its full depth.',
    from: ['tar-roundtrip-fuzz', 'archive-restore-fuzz'],
    workspace: build(
      `mkdir -p dist/${'d/'.repeat(100)} && printf deep > dist/${'d/'.repeat(100)}f`,
    ),
    steps: roundTrip({ [`${A}/dist/${'d/'.repeat(100)}f`]: 'deep' }),
  }),

  // Turborepo cache_archive: entries come back whatever order sorting puts them in
  defineCase({
    id: 'outputs/names-sharing-a-prefix-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'Outputs `ab.txt`, `ab-c`, `ab/x` and `ab0/y` all come back, each in its place',
    why: 'Sorting puts `ab-c`, `ab.txt`, `ab/` and `ab0/` in different orders depending on whether `/` sorts as a byte or as a separator. A restore that groups entries by prefix, or decides a directory is done when the next name starts differently, drops or misplaces one. Every name must land where the build put it.',
    from: ['artifact-roundtrip', 'tar-roundtrip-fuzz'],
    workspace: build(
      'mkdir -p dist/ab dist/ab0 && printf 1 > dist/ab.txt && printf 2 > dist/ab-c && printf 3 > dist/ab/x && printf 4 > dist/ab0/y',
    ),
    steps: roundTrip({
      [`${A}/dist/ab.txt`]: '1',
      [`${A}/dist/ab-c`]: '2',
      [`${A}/dist/ab/x`]: '3',
      [`${A}/dist/ab0/y`]: '4',
    }),
  }),

  // Turborepo cache_archive test_restore: control bytes are name bytes
  defineCase({
    id: 'outputs/control-characters-in-names-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'Output names holding a carriage return, a tab or an escape byte come back',
    why: 'Any byte but `/` and NUL may appear in a Linux name. A store that cleans names for display, or a format that ends a record on a carriage return, writes a different name or none. The files must come back with the names the build gave them.',
    from: ['tar-roundtrip-fuzz'],
    workspace: build(
      'mkdir -p dist && printf 1 > "dist/a$(printf \'\\r\')b" && printf 2 > "dist/c$(printf \'\\t\')d" && printf 3 > "dist/e$(printf \'\\033\')[1m"',
    ),
    steps: roundTrip({
      [`${A}/dist/a\rb`]: '1',
      [`${A}/dist/c\td`]: '2',
      [`${A}/dist/e\u001b[1m`]: '3',
    }),
  }),

  // Turborepo cache_archive: names a tar reader treats as its own extension headers
  defineCase({
    id: 'outputs/tar-header-like-names-restored',
    category: 'outputs',
    kind: 'correctness',
    title:
      'Outputs named `@LongLink`, `PaxHeaders.0/x` and `GlobalHead.0.0` come back as plain files',
    why: 'GNU and pax archives mark their long-name and attribute records with names like these. A reader that matches on the name instead of the record type takes a user’s file for a header and skips it, or applies it to the next entry. The build’s files must come back as files.',
    from: ['tar-stream', 'tar-roundtrip-fuzz'],
    workspace: build(
      'mkdir -p dist/PaxHeaders.0 && printf 1 > dist/@LongLink && printf 2 > dist/PaxHeaders.0/x && printf 3 > dist/GlobalHead.0.0',
    ),
    steps: roundTrip({
      [`${A}/dist/@LongLink`]: '1',
      [`${A}/dist/PaxHeaders.0/x`]: '2',
      [`${A}/dist/GlobalHead.0.0`]: '3',
    }),
  }),

  // pnpm-style trees: many links in one output
  defineCase({
    id: 'outputs/thousand-links-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output tree of a thousand symlinks comes back with every link and its target',
    why: 'Package managers lay out installs as thousands of links into a store. A restore that handles links one slow way, or caps how many it makes, leaves the tree half linked. Every link must come back with its target text.',
    from: ['output-links', 'artifact-roundtrip'],
    workspace: build(
      'mkdir -p dist/store dist/links && printf t > dist/store/t && for i in $(seq 1000 1999); do ln -s ../store/t dist/links/l$i; done',
    ),
    steps: [
      ...roundTrip({ [`${A}/dist/links/l1000`]: 't', [`${A}/dist/links/l1999`]: 't' }),
      { check: { links: { [`${A}/dist/links/l1500`]: '../store/t' } } },
    ],
  }),

  // Turborepo cache_archive restore_regular_file_replaces_final_symlink: a loop is no exception
  defineCase({
    id: 'outputs/output-swapped-for-self-loop-link-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output file a user replaced with a link to itself is put back as the file',
    why: 'A link pointing at its own name cannot be opened: every attempt fails with a loop error. A restore that opens the path to write it fails the run, or leaves the loop in place. It must replace the link with the stored file.',
    from: ['restore-link-swap', 'restore-in-place'],
    workspace: build(CONCAT),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { link: { [out('a')]: 'out.txt' } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\n' } } },
    ],
  }),
] as Case[]

// vx keys the lists as written: each of these reorders reruns the task.
export const pending: Case[] = [
  // Turborepo hashes the resolved file set, not the order globs are listed in
  defineCase({
    id: 'cache/input-globs-reordered-replays',
    category: 'cache',
    kind: 'efficiency',
    title: 'Listing the same input globs in another order replays the task',
    why: 'Inputs are a set of files; the order the globs are written in does not change which files they match. A tool that keys the list as written rebuilds after a harmless reformat of the config. The files and their bytes are the same, so the entry is too.',
    from: ['stable-keys', 'run-keys'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: task('mkdir -p dist && cat src/a.txt lib/b.txt > dist/out.txt', {
              inputs: ['src/**', 'lib/**'],
            }),
          },
          files: { 'src/a.txt': 'a\n', 'lib/b.txt': 'b\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      {
        configure: (ws) => ({
          ...ws,
          projects: {
            a: {
              ...ws.projects['a']!,
              tasks: {
                build: { ...ws.projects['a']!.tasks!['build']!, inputs: ['lib/**', 'src/**'] },
              },
            },
          },
        }),
      },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  // Nx outputs order: the same output set in another order is the same entry
  defineCase({
    id: 'cache/output-globs-reordered-replays',
    category: 'cache',
    kind: 'efficiency',
    title:
      'Listing the same output globs in another order replays the task and restores both trees',
    why: 'The outputs are a set of paths, and their order in the config says nothing about what the task writes. A tool that keys the list as written rebuilds after a reorder that changed nothing. The replay must still restore every declared tree.',
    from: ['stable-keys', 'output-dirs'],
    workspace: one(
      task('mkdir -p dist out && cat src/a.txt > dist/out.txt && cat src/a.txt > out/o.txt', {
        outputs: ['dist/**', 'out/**'],
      }),
    ),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      {
        configure: (ws) => ({
          ...ws,
          projects: {
            a: {
              ...ws.projects['a']!,
              tasks: {
                build: { ...ws.projects['a']!.tasks!['build']!, outputs: ['out/**', 'dist/**'] },
              },
            },
          },
        }),
      },
      { write: { [`${A}/dist`]: null, [`${A}/out`]: null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['a#build'],
          files: { [out('a')]: 'a\n', [`${A}/out/o.txt`]: 'a\n' },
        },
      },
    ],
  }),

  // Turborepo hashes dependsOn as a set: reordering it changes nothing a task reads
  defineCase({
    id: 'cache/depends-on-reordered-replays',
    category: 'cache',
    kind: 'efficiency',
    title: 'Listing the same dependencies in another order replays the task',
    why: 'The dependencies of a task are a set: each must run first, whatever order they are written in. The task reads the same inputs and the same upstream results either way. Rebuilding after a reorder throws away a valid entry for an edit that changed nothing.',
    from: ['stable-keys', 'key-fold'],
    workspace: {
      projects: {
        a: {
          tasks: {
            gen: {
              command: 'mkdir -p gen && cat src/a.txt > gen/g.txt',
              inputs: ['src/**'],
              outputs: ['gen/**'],
            },
            lint: {
              command: 'mkdir -p lint && cat src/a.txt > lint/l.txt',
              inputs: ['src/**'],
              outputs: ['lint/**'],
            },
            build: task(CONCAT, { dependsOn: ['gen', 'lint'] }),
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      {
        configure: (ws) => ({
          ...ws,
          projects: {
            a: {
              ...ws.projects['a']!,
              tasks: {
                ...ws.projects['a']!.tasks,
                build: { ...ws.projects['a']!.tasks!['build']!, dependsOn: ['lint', 'gen'] },
              },
            },
          },
        }),
      },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),
]
