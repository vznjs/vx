// dependsOn entries that name nothing: a typo the run must refuse rather
// than run the task without what it waits on.
import { defineCase, type Case, type ProjectSpec } from '../src/spec.ts'

const FROM = ['task-graph-properties', 'graph-pipeline-properties']

const lib = (): ProjectSpec => ({
  tasks: { build: { command: 'echo lib', inputs: ['src/**'] } },
  files: { 'src/a.txt': 'x\n' },
})

function refused(slug: string, title: string, dep: string): Case {
  return defineCase({
    id: `config/${slug}`,
    category: 'config',
    kind: 'correctness',
    title,
    why: 'The task waits on what the user named; running it without that runs on a missing or stale input, and the typo never surfaces.',
    from: FROM,
    needs: ['filter'],
    workspace: {
      projects: {
        lib: lib(),
        app: {
          tasks: { build: { command: 'echo app', dependsOn: [dep], inputs: ['src/**'] } },
          files: { 'src/a.txt': 'x\n' },
        },
      },
    },
    steps: [{ run: 'build', projects: ['app'], expect: { exit: 'fail', notRan: ['app#build'] } }],
  })
}

export default [
  refused(
    'depends-on-missing-task',
    'dependsOn naming a task the project lacks fails the run',
    'gen',
  ),
  refused(
    'depends-on-missing-project',
    'dependsOn naming a project that does not exist fails the run',
    'ghost#build',
  ),
  refused(
    'depends-on-missing-task-of-project',
    'dependsOn naming a task another project lacks fails the run',
    'lib#gen',
  ),
]
