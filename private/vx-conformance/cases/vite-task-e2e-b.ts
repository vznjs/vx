// Outcomes drawn from Vite Task's own e2e fixtures (output_cache_test,
// pass_args_to_task) that no earlier case carried.
import { defineCase } from '../src/spec.ts'

const A = 'packages/a'

export default [
  defineCase({
    id: 'outputs/dir-link-replayed-over-itself',
    category: 'outputs',
    kind: 'correctness',
    title:
      'Replaying an older build over a tree holding the same directory link restores through it',
    why: 'A store layout such as `dist/pkg -> store/pkg` is common in package builds, and the link is already there when an older entry is replayed. The restore must put the old files back and leave the link as a link to the same directory. A restore that trips over the existing link fails a run that should replay, and one that follows or flattens it leaves the newer build’s bytes or a copy where a link belongs.',
    from: ['restore-link-swap', 'output-links'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command:
                'rm -rf dist && mkdir -p dist/store/pkg && cat src/in.txt > dist/store/pkg/index.js && ln -s store/pkg dist/pkg',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/in.txt': 'v1\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { [`${A}/src/in.txt`]: 'v2\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [`${A}/dist/pkg/index.js`]: 'v2\n' } },
      },
      { write: { [`${A}/src/in.txt`]: 'v1\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: {
            [`${A}/dist/pkg/index.js`]: 'v1\n',
            [`${A}/dist/store/pkg/index.js`]: 'v1\n',
          },
        },
      },
      { check: { links: { [`${A}/dist/pkg`]: 'store/pkg' }, dirs: [`${A}/dist/store/pkg`] } },
    ],
  }),

  defineCase({
    id: 'graph/args-named-like-runner-flags-reach-task',
    category: 'graph',
    kind: 'correctness',
    title: 'Forwarded args such as `--help`, `--version` and `-v` reach the task, not the runner',
    why: 'Args after the task belong to the task’s command, whatever they look like. `--help`, `--version` and `-v` are also flags of every runner, and a runner that reads them itself prints its own help or version and runs nothing, often with exit 0. The user asked the task for its help or a verbose run and got neither, with a green exit hiding it.',
    from: ['forward-args-verbatim', 'cli-arg-hygiene'],
    workspace: {
      projects: {
        a: {
          tasks: {
            show: {
              command: `mkdir -p dist && printf '<%s>' "$@" > dist/args.txt`,
              takesArgs: true,
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      {
        run: 'show',
        projects: ['a'],
        args: ['--help'],
        expect: { exit: 0, ran: ['a#show'], files: { [`${A}/dist/args.txt`]: '<--help>' } },
      },
      {
        run: 'show',
        projects: ['a'],
        args: ['--version', '-v', '-a'],
        expect: {
          exit: 0,
          ran: ['a#show'],
          files: { [`${A}/dist/args.txt`]: '<--version><-v><-a>' },
        },
      },
    ],
  }),
]
