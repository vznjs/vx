// Workspaces a tool must refuse, values that must key apart, and what a run
// reports, drawn from Turborepo's crates/turborepo/tests
// (invalid_package_json_test.rs test_malformed_package_json;
// final_hash_contract.rs env_mode_hashes; run_summary.rs) and moon's
// crates/cli/tests/exec_test.rs (creates_run_report).
import { defineCase, type Case, type TaskSpec } from '../src/spec.ts'
import { chainProject, one } from './shapes.ts'

const task = (command: string, extra: Partial<TaskSpec> = {}): TaskSpec => ({
  command,
  inputs: ['src/**'],
  outputs: ['dist/**'],
  ...extra,
})

/** Two declared values that must key two results. */
function envPair(id: string, title: string, why: string, first: string, second: string): Case {
  return defineCase({
    id: `env/${id}`,
    category: 'env',
    kind: 'correctness',
    title,
    why,
    from: ['env', 'hash-scenarios-names'],
    needs: ['env-inputs'],
    workspace: one(
      task('mkdir -p dist && printf "%s" "$MODE" | od -An -tx1 | tr -d " \\n" > dist/out.txt', {
        env: ['MODE'],
      }),
    ),
    steps: [
      { run: 'build', env: { MODE: first }, expect: { exit: 0 } },
      { run: 'build', env: { MODE: second }, expect: { exit: 0, ran: ['a#build'] } },
    ],
  })
}

export default [
  // final_hash_contract.rs env_mode_hashes
  envPair(
    'unicode-normalisation-keys',
    'A declared value in composed and decomposed Unicode forms keys two results',
    'An `é` can be one code point or `e` plus a combining accent: they look alike and are different bytes, and a program comparing them sees two values. A tool that normalises values before keying replays one form’s result for the other. The second run runs.',
    'é',
    'é',
  ),
  envPair(
    'leading-zero-value-keys',
    'Declared values `1` and `01` key two results',
    'Values are strings, not numbers: a version `01`, a port `0080`, a code. A tool that parses numeric-looking values before keying folds them together and replays a result built from the other. The second run runs.',
    '1',
    '01',
  ),
  envPair(
    'newline-and-space-values-key-apart',
    'A declared value holding a newline is not the same as one holding a space there',
    'A tool that writes values one per line into its key, or that normalises whitespace, folds `a b` and `a`+newline+`b` into one key. Programs reading the variable see different values. The second run runs.',
    'a b',
    'a\nb',
  ),

  defineCase({
    id: 'env/pass-through-change-replays-dependants',
    category: 'env',
    kind: 'efficiency',
    title:
      'A change to a variable a dependency passes through replays the dependency and its dependants',
    why: 'A passed-through variable (a token, a cache directory) reaches the command without keying it. A tool that still folds it into the dependency’s key cascades the change into every dependant, rebuilding a chain for a value no build depends on. Both replay.',
    from: ['env', 'affected-pass-through'],
    needs: ['pass-through-env'],
    workspace: {
      projects: {
        lib: {
          tasks: { build: { ...chainProject('lib').tasks!.build!, passThrough: ['TOKEN'] } },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: chainProject('app', ['lib']),
      },
    },
    steps: [
      { run: 'build', env: { TOKEN: 'one' }, expect: { exit: 0 } },
      {
        run: 'build',
        env: { TOKEN: 'two' },
        expect: { exit: 0, notRan: ['lib#build', 'app#build'] },
      },
    ],
  }),

  defineCase({
    id: 'env/declared-in-both-chain-links-reruns-both',
    category: 'env',
    kind: 'correctness',
    title: 'A variable both a dependency and its dependant declare reruns both when it changes',
    why: 'When a value shapes both builds, both results are stale after it moves. The dependant must not replay on the grounds that its own files did not change. Both run and the dependant holds the new value.',
    from: ['env', 'hash-scenarios-names'],
    needs: ['env-inputs'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: task('mkdir -p dist && printf "%s\\n" "$MODE" > dist/out.txt', {
              env: ['MODE'],
            }),
          },
          files: { 'src/a.txt': 'l\n' },
        },
        app: {
          deps: ['lib'],
          tasks: {
            build: task(
              'mkdir -p dist && { cat ../lib/dist/out.txt; printf "%s\\n" "$MODE"; } > dist/out.txt',
              {
                dependsOn: ['^build'],
                env: ['MODE'],
              },
            ),
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      { run: 'build', env: { MODE: 'x' }, expect: { exit: 0 } },
      {
        run: 'build',
        env: { MODE: 'y' },
        expect: {
          exit: 0,
          ran: ['lib#build', 'app#build'],
          files: { 'packages/app/dist/out.txt': 'y\ny\n' },
        },
      },
    ],
  }),
]
