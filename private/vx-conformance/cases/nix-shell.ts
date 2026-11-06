// Outcomes drawn from Nix's shell.sh and nix-shell.sh: a build, and a
// shell, find each input's programs by name, because each input's bin/ is
// put on PATH. Nix reads bin/ from the layout; a neutral spec declares
// it (`bin`), and the outcome is the same.
import { defineCase, type ProjectSpec } from '../src/spec.ts'

const tool = (word: string): ProjectSpec => ({
  tasks: {
    build: {
      command: `mkdir -p out/bin && printf '#!/bin/sh\\necho ${word}\\n' > out/bin/hello && chmod +x out/bin/hello`,
      inputs: ['src/**'],
      outputs: ['out/**'],
      bin: 'out/bin',
    },
  },
  files: { 'src/a.txt': `${word}\n` },
})

const app = (dependsOn: string[]): ProjectSpec => ({
  tasks: {
    build: {
      command: 'mkdir -p dist && hello > dist/out.txt',
      dependsOn,
      inputs: ['src/**'],
      outputs: ['dist/**'],
    },
  },
  files: { 'src/a.txt': 'a\n' },
})

export default [
  defineCase({
    id: 'env/dependency-program-on-path',
    category: 'env',
    kind: 'correctness',
    title: 'A task runs by name a program the task it depends on built',
    why: 'One project builds a tool, and the projects that depend on it run that tool. Calling it by a path into another project ties every command to that layout. Putting the dependency’s programs on PATH lets the command say only what it runs, and the edge says where it comes from.',
    from: ['dependency-bin'],
    needs: ['dependency-bin'],
    workspace: { projects: { tools: tool('tool'), app: app(['tools#build']) } },
    steps: [
      {
        run: 'build',
        projects: ['app'],
        expect: { exit: 0, files: { 'packages/app/dist/out.txt': 'tool\n' } },
      },
    ],
  }),

  defineCase({
    id: 'env/two-dependencies-one-program-refused',
    category: 'env',
    kind: 'correctness',
    title: 'A task whose two dependencies ship a program of one name fails instead of picking one',
    why: 'When two dependencies both put a program of one name on PATH, the one that runs depends on the order they were listed in. Reordering the list then swaps the tool under the same key. Failing the task and naming both makes the choice explicit instead of an accident of order.',
    from: ['dependency-bin'],
    needs: ['dependency-bin'],
    workspace: {
      projects: { node: tool('node'), bun: tool('bun'), app: app(['node#build', 'bun#build']) },
    },
    steps: [{ run: 'build', projects: ['app'], expect: { exit: 'fail' } }],
  }),
]
