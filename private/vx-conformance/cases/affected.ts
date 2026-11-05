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
    why: 'A change can break any project built on top of it, so an affected run must reach every dependent, not only the project that was edited. If dependents are left out, a pull request that breaks `app` through a change in `lib` passes CI. The break then shows up on main or in production, far from the commit that caused it.',
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
    why: 'Selecting by change exists to run only what the change can reach. A project nothing depends on cannot pass its edit to anyone else, so only its own tasks need to run. Running its siblings or its dependencies as well spends CI minutes on work whose result is already known.',
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
    why: 'When no file changed, no task’s result can differ from last time, so the right answer is an empty run that succeeds. Failing would turn a no-op pull request, such as a merge of an empty commit, into a red build. Running everything would waste the whole CI budget on work nothing asked for.',
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
    why: 'A developer runs the affected tasks before committing, to check the edit they are making. The working tree is what the tasks will read, so an edit on disk is a change whether or not it is committed yet. Comparing only commits would report nothing to run and let the developer commit untested work.',
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
    why: 'A new file is read by any task whose inputs match it, even before git tracks it. Ignoring untracked files would skip the project where a developer just added a source or a test. The run would look clean, and the new file would only be checked after it is committed and pushed.',
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
    why: 'Removing a file changes what a task reads as surely as editing it: an import can now fail, a test can vanish. The project that lost the file and every project built on it must be selected. Treating a delete as no change lets a pull request that breaks the build by removing a file pass CI.',
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
    why: 'A file at the root that no task names as an input cannot change any task’s result. Selecting every project on such an edit, for example a notes file or a README, makes a one-line docs change cost a full CI run. The tool has the inputs declared, so it can tell that nothing reads the file.',
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
