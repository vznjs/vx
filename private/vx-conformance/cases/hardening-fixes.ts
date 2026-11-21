// Cases drawn from the hardening finds of 13–21 November 2026: each guards
// a behaviour a bug once broke, written so any task runner can be held to it.
import { defineCase, MEET, type TaskSpec, type WorkspaceSpec } from '../src/spec.ts'
import { CONCAT } from './shapes.ts'

const LIB_A = 'packages/lib/src/a.txt'
const APP_OUT = 'packages/app/dist/o.txt'

/** Waits up to 20 s for a mark in the shared directory: a tool that runs one task at a time still ends. */
const waitFor = (mark: string) =>
  `i=0; while [ ! -e ../../${MEET}/${mark} ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done`

/**
 * lib builds its source into `dist`; app, after it, reads lib's source as a
 * bundler does, once `editor` has rewritten it mid-run, as a sibling task or
 * an editor does while a dependant builds.
 */
const editedUnderDependant = (): WorkspaceSpec => ({
  projects: {
    lib: {
      tasks: { build: { command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] } },
      files: { 'src/a.txt': 'A\n', '.gitignore': 'dist/\n' },
    },
    app: {
      deps: ['lib'],
      tasks: {
        build: {
          command: `mkdir -p ../../${MEET} dist && touch ../../${MEET}/started && ${waitFor('edited')} && cat ../lib/src/a.txt > dist/o.txt`,
          dependsOn: ['^build'],
          inputs: ['src/**'],
          outputs: ['dist/**'],
        },
      },
      files: { 'src/a.txt': 'x\n', '.gitignore': 'dist/\n' },
    },
    editor: {
      tasks: {
        build: {
          command: `mkdir -p ../../${MEET} && ${waitFor('started')} && printf 'B\\n' > ../lib/src/a.txt && touch ../../${MEET}/edited`,
          cache: false,
        },
      },
    },
  },
})

const lateWriter = (): TaskSpec => ({
  command:
    'mkdir -p dist && cat src/*.txt > dist/out.txt && (sleep 0.05; echo late > dist/late.txt) >/dev/null 2>&1 &',
  inputs: ['src/**'],
  outputs: ['dist/**'],
})

export default [
  defineCase({
    id: 'cache/dependency-input-edited-mid-run-not-replayed',
    category: 'cache',
    kind: 'correctness',
    title:
      'A dependency’s source edited while its dependant builds is not replayed once the edit is undone',
    why: 'A bundler reads a workspace package’s source while it builds, and an editor or a sibling task can change that source mid-build. The dependant then holds bytes from the edited source, yet the run worked out its key from the source as it was. Stored under that key, the build comes back once the edit is undone: a green run that ships code nobody has on disk.',
    from: ['upstream-input-moved'],
    workspace: editedUnderDependant(),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [APP_OUT]: 'B\n' } } },
      { write: { [LIB_A]: 'A\n', 'packages/app/dist': null } },
      {
        run: 'build',
        projects: ['app'],
        expect: { exit: 0, files: { [APP_OUT]: 'A\n' } },
      },
    ],
  }),

  defineCase({
    id: 'outputs/write-just-after-exit-cached-whole',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A build whose helper processes finish just after it exits is cached with what they wrote',
    why: 'Bundlers such as Turbopack run pools of worker processes that are still closing for a moment after the main command returns. What they write in that moment belongs to the build. A tool that stores the outputs at the instant the command exits, or refuses to store the build at all, gives a partial result or rebuilds on every run.',
    from: ['left-running-save'],
    workspace: {
      projects: {
        a: {
          tasks: { build: lateWriter() },
          files: { 'src/a.txt': 'a\n', '.gitignore': 'dist/\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/dist': null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['a#build'],
          files: { 'packages/a/dist/out.txt': 'a\n', 'packages/a/dist/late.txt': 'late\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/output-past-2-gib-cached',
    category: 'outputs',
    kind: 'efficiency',
    title: 'A build whose outputs pass 2 GiB is cached and comes back',
    why: 'A Next.js standalone build with its traced dependencies can pass 2 GB. Kept on this machine, such a build costs only disk to store and replay. A tool that refuses outputs past a size limit rebuilds it on every run, which for a build this size is minutes each time.',
    from: ['artifact-ceiling-tree'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command:
                'mkdir -p dist && cat src/*.txt > dist/out.txt && truncate -s 2200M dist/big.bin',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a\n', '.gitignore': 'dist/\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/dist': null } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { 'packages/a/dist/out.txt': 'a\n' } },
      },
    ],
  }),

  defineCase({
    id: 'sandbox/node-modules-linked-outside-on-path',
    category: 'sandbox',
    kind: 'correctness',
    title:
      'An isolated task still runs a tool from its node_modules when that folder is a link out of the workspace',
    why: 'A package store on another disk or a container volume often makes `node_modules` a link to a folder outside the workspace. The tools in its `.bin` are what the task runs, so isolation must keep the link itself reachable, not only the folder it points at. A sandbox that drops the link reports every installed tool as not found, and isolation gets turned off.',
    from: ['sandbox-node-modules-link.unsafe'],
    needs: ['sandbox'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'mkdir -p dist && hello > dist/out.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
              sandbox: {},
            },
          },
          files: { 'src/a.txt': 'a\n', '.gitignore': 'dist/\nnode_modules\n' },
        },
      },
      outside: { 'modules/.bin/hello': '#!/bin/sh\necho hello\n' },
    },
    steps: [
      {
        sh: 'chmod +x ../outside/modules/.bin/hello && rm -rf packages/a/node_modules && ln -s ../../../outside/modules packages/a/node_modules',
      },
      { run: 'build', expect: { exit: 0, files: { 'packages/a/dist/out.txt': 'hello\n' } } },
    ],
  }),
]
