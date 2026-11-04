import { defineCase, type ProjectSpec, type WorkspaceSpec } from '../src/spec.ts'
import { chainBuild } from './shapes.ts'

/** lib ← app, and docs on its own. Each `test` reads its dependencies' builds. */
function workspace(): WorkspaceSpec {
  const project = (name: string, deps: string[] = []): ProjectSpec => ({
    deps,
    tasks: {
      build: chainBuild(deps),
      test: { command: 'cat dist/out.txt', dependsOn: ['build'], inputs: ['src/**'] },
    },
    files: { 'src/a.txt': `${name}\n` },
  })
  return { projects: { lib: project('lib'), app: project('app', ['lib']), docs: project('docs') } }
}

export default [
  defineCase({
    id: 'affected/change-reaches-dependents',
    category: 'affected',
    kind: 'correctness',
    title: 'A committed change selects its project and every project that depends on it',
    from: ['affected', 'affected-dependents', 'parity-nx'],
    needs: ['affected'],
    workspace: workspace(),
    steps: [
      { write: { 'packages/lib/src/a.txt': 'lib2' } },
      { commit: 'change lib' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['lib#test', 'app#test'], notRan: ['docs#test'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/leaf-change-stays-put',
    category: 'affected',
    kind: 'efficiency',
    title: 'A change in a project nothing depends on selects only that project',
    from: ['affected', 'affected-tasks'],
    needs: ['affected'],
    workspace: workspace(),
    steps: [
      { write: { 'packages/app/src/a.txt': 'app2' } },
      { commit: 'change app' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['app#test'], notRan: ['lib#test', 'docs#test'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/nothing-changed',
    category: 'affected',
    kind: 'correctness',
    title: 'With nothing changed, an affected run runs nothing and succeeds',
    from: ['parity-nx', 'affected-count-placeholder'],
    needs: ['affected'],
    workspace: workspace(),
    steps: [
      { commit: 'empty' },
      {
        affected: 'test',
        base: 'HEAD',
        expect: { exit: 0, notRan: ['lib#test', 'app#test', 'docs#test'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/uncommitted-change',
    category: 'affected',
    kind: 'correctness',
    title: 'An uncommitted edit counts as a change',
    from: ['affected', 'affected-head-range'],
    needs: ['affected'],
    workspace: workspace(),
    steps: [
      { write: { 'packages/docs/src/a.txt': 'docs2' } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ran: ['docs#test'] } },
    ],
  }),

  defineCase({
    id: 'affected/untracked-file',
    category: 'affected',
    kind: 'correctness',
    title: 'A new file git does not track yet counts as a change',
    from: ['affected', 'git-pending-reads'],
    needs: ['affected'],
    workspace: workspace(),
    steps: [
      { write: { 'packages/docs/src/new.txt': 'new' } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ran: ['docs#test'] } },
    ],
  }),

  defineCase({
    id: 'affected/deleted-file',
    category: 'affected',
    kind: 'correctness',
    title: 'A deleted file counts as a change to its project',
    from: ['affected-moves'],
    needs: ['affected'],
    workspace: workspace(),
    steps: [
      { write: { 'packages/lib/src/a.txt': null, 'packages/lib/src/b.txt': 'b' } },
      { commit: 'move' },
      { affected: 'test', base: 'HEAD~1', expect: { exit: 0, ran: ['lib#test', 'app#test'] } },
    ],
  }),

  defineCase({
    id: 'affected/root-file-reaches-nobody',
    category: 'affected',
    kind: 'efficiency',
    title: 'A change to a root file no task reads selects nothing',
    from: ['affected-workspace-files', 'affected-default-text'],
    needs: ['affected'],
    workspace: { ...workspace(), files: { 'NOTES.md': 'one' } },
    steps: [
      { write: { 'NOTES.md': 'two' } },
      { commit: 'notes' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, notRan: ['lib#test', 'app#test', 'docs#test'] },
      },
    ],
  }),
]
