// dependsOn entries that name nothing: a typo the run must refuse rather
// than run the task without what it waits on.
import { defineCase, type Case, type ProjectSpec } from '../src/spec.ts'

const FROM = ['task-graph-properties', 'graph-pipeline-properties']

const lib = (): ProjectSpec => ({
  tasks: { build: { command: 'echo lib', inputs: ['src/**'] } },
  files: { 'src/a.txt': 'x\n' },
})

function refused(slug: string, title: string, why: string, dep: string): Case {
  return defineCase({
    id: `config/${slug}`,
    category: 'config',
    kind: 'correctness',
    title,
    why,
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
    'A dependency the user wrote is a promise that something runs first. If the named task does not exist and the run goes on, the task runs without the input it waits on and may read a missing or stale file. The typo never surfaces, so a green run hides that the order was never kept.',
    'gen',
  ),
  refused(
    'depends-on-missing-project',
    'dependsOn naming a project that does not exist fails the run',
    'A dependency on another project names work that must finish first. If that project does not exist, perhaps renamed or misspelt, running anyway builds on whatever its old output left behind. Failing the run points at the bad name at once, instead of letting CI pass on an order nobody enforced.',
    'ghost#build',
  ),
  refused(
    'depends-on-missing-task-of-project',
    'dependsOn naming a task another project lacks fails the run',
    'Naming `lib#gen` says lib produces something this task reads. When lib declares no such task, nothing produces it, and a run that carries on reads a missing or stale file. Refusing the run turns a silent wrong build into an error that names the bad edge.',
    'lib#gen',
  ),
]
