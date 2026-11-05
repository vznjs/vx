// Outcomes drawn from Vite Task's task-plan snapshots (batch B): what a
// planned graph asserts, said as what runs, in what order, and what it
// leaves on disk.
import { defineCase } from '../src/spec.ts'
import { chainProject, out } from './shapes.ts'

export default [
  defineCase({
    id: 'graph/select-taskless-project-with-dependencies',
    category: 'graph',
    kind: 'correctness',
    title:
      'Selecting a project without the task, with its dependencies, runs the task in those dependencies',
    why: 'The selection is mid and everything below it, and the task exists in lib, so lib’s build is what was asked for. mid lacking the task removes only mid from the run, not the projects reached through it. Failing, or running nothing, leaves lib unbuilt for the user who wanted mid’s dependencies ready, and app above the selection must stay out.',
    from: ['filter', 'graph-pipeline-properties'],
    needs: ['filter', 'select-walk'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        mid: { deps: ['lib'], tasks: {}, files: { 'src/a.txt': 'mid\n' } },
        app: chainProject('app', ['mid']),
      },
    },
    steps: [
      {
        run: 'build',
        select: [{ name: 'mid', with: 'dependencies' }],
        expect: {
          exit: 0,
          ran: ['lib#build'],
          notRan: ['app#build'],
          files: { [out('lib')]: 'lib\n', [out('app')]: null },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/dependency-in-two-manifest-fields-builds-once',
    category: 'graph',
    kind: 'correctness',
    title:
      'A dependency named in both `dependencies` and `devDependencies` is built once, before its dependant',
    why: 'Listing a package in two dependency fields of one manifest still makes it one dependency. `^build` must build it first, and once: two edges to the same task are one edge. Missing the edge builds app against a missing lib; running lib twice wastes the work and can rewrite its output while app reads it.',
    from: ['package-graph'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        app: {
          tasks: { build: chainProject('app', ['lib']).tasks!['build']! },
          files: {
            'src/a.txt': 'app\n',
            'package.json': JSON.stringify({
              name: 'app',
              version: '0.0.0',
              private: true,
              dependencies: { lib: 'workspace:*' },
              devDependencies: { lib: 'workspace:*' },
            }),
          },
        },
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['app'],
        expect: {
          exit: 0,
          ran: ['lib#build', 'app#build'],
          order: [['lib#build', 'app#build']],
          files: { [out('app')]: 'lib\napp\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'env/command-prefix-path-finds-command',
    category: 'env',
    kind: 'correctness',
    title: 'A `PATH=…` prefix on a command decides where that command’s program is found',
    why: 'In sh, `PATH=dir tool` looks `tool` up in `dir`: the assignment holds for that one command, lookup included. A runner that resolves the program itself, with the PATH it was started with, finds no `tool` or a different one. The task then fails, or runs a program the command never named, though the same line works in a terminal.',
    from: ['task-shell'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'mkdir -p dist && PATH="$PWD/tools" mytool > dist/out.txt',
              inputs: ['src/**', 'tools/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a\n', 'tools/mytool': '#!/bin/sh\necho found in tools\n' },
        },
      },
    },
    steps: [
      { chmod: { 'packages/a/tools/mytool': 0o755 } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'found in tools\n' } } },
    ],
  }),
]
