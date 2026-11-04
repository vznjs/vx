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
