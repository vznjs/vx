// Cases drawn from fixes moon and Vite Task shipped in November 2026 (their
// changelogs and closed pull requests), after mined-moon2.ts and the
// vite-task-*.ts files. Each names its source above it.
import { defineCase } from '../src/spec.ts'
import { CONCAT, one, out } from './shapes.ts'

const cached = { command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] }
const WT = '.worktrees/wt'

export default [
  // moon 2.6.5: hasher.ignorePatterns matched absolute paths, so `**/.worktrees/**`
  // ignored every input of a worktree nested there and replayed stale outputs.
  defineCase({
    id: 'inputs/worktree-under-an-ignored-folder-edit-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'In a git worktree under a folder the main checkout ignores, an input edit runs the task again',
    why: 'Agents and scripts keep extra worktrees in a folder like `.worktrees/` that the main checkout ignores. Inside the worktree, that folder is outside the workspace, so it says nothing about which files are inputs. A tool that matches its ignores against the full path drops every input there and replays the old output after an edit. The edited input is built.',
    from: ['parity-turbo-hashing', 'cache-gitignore'],
    workspace: one(cached),
    steps: [
      { sh: 'echo .worktrees/ >> .gitignore' },
      { commit: 'ignore the worktrees folder' },
      { sh: `git worktree add -q ${WT} && cp -R node_modules ${WT}/node_modules` },
      { run: 'build', cwd: WT, expect: { exit: 0, files: { [`${WT}/${out('a')}`]: 'a\n' } } },
      { write: { [`${WT}/packages/a/src/a.txt`]: 'edited\n' } },
      {
        run: 'build',
        cwd: WT,
        expect: { exit: 0, files: { [`${WT}/${out('a')}`]: 'edited\n' } },
      },
    ],
  }),

  // vite-task #940: a task writing outside the workspace through `..`
  // (`cp -r dist ../site`) failed to save; now it is cached like any other.
  defineCase({
    id: 'cache/task-copying-beside-the-workspace-replays',
    category: 'cache',
    kind: 'efficiency',
    title: 'A task that also copies its build beside the repository is cached and replays',
    why: 'A build that publishes a copy to a folder beside the repository, `cp -r dist ../site`, still declares its outputs inside its project. What it writes outside is not among them, and is no reason to refuse the result. A tool that fails to save such a task builds it on every run. The run passes and the next one replays.',
    from: ['parity-turbo-hashing'],
    workspace: {
      ...one({
        ...cached,
        command: `${CONCAT} && mkdir -p ../../../outside/site && cp -r dist/. ../../../outside/site/`,
      }),
      outside: { 'README.txt': 'beside\n' },
    },
    steps: [
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['a#build'],
          files: { [out('a')]: 'a\n', '../outside/site/out.txt': 'a\n' },
        },
      },
      { write: { [out('a')]: null } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'], files: { [out('a')]: 'a\n' } } },
    ],
  }),

  // vite-task #939: under its bundled shell an `EXIT` trap did not see the
  // exit status in `$?`.
  defineCase({
    id: 'env/command-exit-trap-sees-the-status',
    category: 'env',
    kind: 'correctness',
    title: 'An `EXIT` trap reads the status the command is leaving with in `$?`',
    why: 'A cleanup trap often records or reports how the script ended, and `$?` on entry to an `EXIT` trap is that status. A shell that hands the trap 0 makes a failed build log success. The trap writes 4, and the task fails.',
    from: ['exit-trap-cleanup.unsafe', 'task-shell'],
    workspace: one({
      command: `trap 'echo $? > status.txt' EXIT; exit 4`,
      inputs: ['src/**'],
      outputs: [],
    }),
    steps: [
      {
        run: 'build',
        expect: { exit: 'fail', files: { 'packages/a/status.txt': '4\n' } },
      },
    ],
  }),
]
