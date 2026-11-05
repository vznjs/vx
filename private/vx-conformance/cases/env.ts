import { defineCase } from '../src/spec.ts'
import { one, out } from './shapes.ts'

const keyed = {
  command: 'mkdir -p dist && printf "%s\\n" "${MODE-unset}" > dist/out.txt',
  inputs: ['src/**'],
  env: ['MODE'],
  outputs: ['dist/**'],
}

export default [
  defineCase({
    id: 'env/declared-reaches-task',
    category: 'env',
    kind: 'correctness',
    title: 'A declared variable reaches the command',
    why: 'Declaring a variable says the task reads it, so the command must see its value. A tool that filters the environment must still pass declared names through. Otherwise a build meant for production runs with its defaults, and the output is wrong though the run is green.',
    from: ['env', 'parity-turbo'],
    needs: ['env-inputs'],
    workspace: one(keyed),
    steps: [
      { run: 'build', env: { MODE: 'prod' }, expect: { exit: 0, files: { [out('a')]: 'prod\n' } } },
    ],
  }),

  defineCase({
    id: 'env/declared-change-reruns',
    category: 'env',
    kind: 'correctness',
    title: 'Changing a declared variable runs the task again',
    why: 'A declared variable is an input like a file, and a new value is a new input. Builds often switch API addresses, feature flags or modes on a variable. Replaying the dev output when `MODE=prod` ships a development build to production with nothing in the run to say so.',
    from: ['parity-turbo', 'parity-turbo-hashing-env', 'env-properties'],
    needs: ['env-inputs'],
    workspace: one(keyed),
    steps: [
      { run: 'build', env: { MODE: 'dev' }, expect: { exit: 0, files: { [out('a')]: 'dev\n' } } },
      {
        run: 'build',
        env: { MODE: 'prod' },
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'prod\n' } },
      },
    ],
  }),

  defineCase({
    id: 'env/back-to-old-value',
    category: 'env',
    kind: 'correctness',
    title: 'Going back to an earlier value restores that value’s outputs',
    why: 'A key that depends only on inputs gives back the same output for the same inputs. Switching between dev and prod is routine, and each switch must leave a tree that matches the current value. A tool that keeps the last output in place, or restores the newest entry, leaves a build for the wrong mode.',
    from: ['parity-turbo-hashing-env', 'env-properties'],
    needs: ['env-inputs'],
    workspace: one(keyed),
    steps: [
      { run: 'build', env: { MODE: 'dev' }, expect: { exit: 0 } },
      { run: 'build', env: { MODE: 'prod' }, expect: { exit: 0 } },
      { run: 'build', env: { MODE: 'dev' }, expect: { exit: 0, files: { [out('a')]: 'dev\n' } } },
    ],
  }),

  defineCase({
    id: 'env/unset-vs-empty',
    category: 'env',
    kind: 'correctness',
    title: 'An unset variable and an empty one are different values',
    why: 'A command can tell an unset variable from an empty one, and many scripts do, for example with `${VAR-default}`. If the key treats both the same, a run with an empty value replays output made with the default. The tree then holds a result the current environment would not produce.',
    from: ['parity-turbo-hashing-env', 'env'],
    needs: ['env-inputs'],
    workspace: one(keyed),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'unset\n' } } },
      { run: 'build', env: { MODE: '' }, expect: { exit: 0, files: { [out('a')]: '\n' } } },
    ],
  }),

  defineCase({
    id: 'env/name-case-sensitive',
    category: 'env',
    kind: 'correctness',
    title: '`MODE` and `mode` are different variables',
    why: 'Environment variable names are case-sensitive on Linux and macOS, so `MODE` and `mode` are separate values. A key that folds case can take the wrong one, or miss a change to one because the other stayed the same. Either way the output can come from a value the command never saw.',
    from: ['parity-turbo-hashing-env'],
    needs: ['env-inputs'],
    workspace: one(keyed),
    steps: [
      { run: 'build', env: { MODE: 'a', mode: 'x' }, expect: { exit: 0 } },
      {
        run: 'build',
        env: { MODE: 'b', mode: 'x' },
        expect: { exit: 0, files: { [out('a')]: 'b\n' } },
      },
    ],
  }),

  defineCase({
    id: 'env/undeclared-change-ignored',
    category: 'env',
    kind: 'efficiency',
    title: 'A variable the task does not declare changes nothing',
    why: 'Only declared variables key a task; the rest of the environment changes all the time. Shells and CI runners set values such as job ids, timestamps and temporary paths that differ on every run. Keying on all of them makes every run a miss, so the cache never helps. Declaring what a task reads is what keeps its key stable.',
    from: ['parity-turbo-hashing-env', 'env-reads-complete'],
    workspace: one({
      command: 'mkdir -p dist && cat src/a.txt > dist/out.txt',
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      { run: 'build', env: { OTHER: '1' }, expect: { exit: 0 } },
      { run: 'build', env: { OTHER: '2' }, expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),
]
