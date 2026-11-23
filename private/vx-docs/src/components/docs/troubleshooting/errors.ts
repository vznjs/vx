// Every code vx answers a refusal with (packages/vx/docs/cli.md "Error codes",
// tests/contract/error-codes.txt), sorted by the moment a reader meets it.
// `sees` quotes what vx prints; `fix` is what to do. Backticks become <code>.

export interface Stage {
  id: string
  title: string
  when: string
}

export interface ErrorEntry {
  code: string
  stage: string
  means: string
  sees: string
  fix: string
}

export const STAGES: Stage[] = [
  { id: 'setup', title: 'Start', when: 'vx looks for the workspace and git' },
  { id: 'lock', title: 'Lock', when: '`vx lock` checks your configs' },
  { id: 'run', title: 'Run', when: 'vx reads your command' },
  { id: 'task', title: 'Tasks', when: 'tasks run on this machine' },
  { id: 'ask', title: 'Ask', when: '`vx why`, `vx last`, `vx docs`' },
]

export const ERRORS: ErrorEntry[] = [
  {
    code: 'VX_E_NO_WORKSPACE',
    stage: 'setup',
    means: 'No workspace here.',
    sees: 'no .vx/workspace.ts in … or a parent',
    fix: 'Run `vx init` at the workspace root. A file above your git checkout does not count.',
  },
  {
    code: 'VX_E_NO_GIT',
    stage: 'setup',
    means: 'git is missing, or this folder is not a git repository.',
    sees: 'vx requires git: … is not inside a git work tree',
    fix: 'Install git, or run `git init` at the workspace root.',
  },
  {
    code: 'VX_E_GIT',
    stage: 'setup',
    means: 'A git command vx ran failed.',
    sees: 'git … failed (exit …) in …: … Run it there to see why.',
    fix: 'Run the git command it prints. Fix what git says (a broken index, a missing object).',
  },
  {
    code: 'VX_E_CONFIG',
    stage: 'lock',
    means: 'A config does not load, or has a field vx does not take.',
    sees: 'tasks.build.outputs must be an object (fields: clean, files, workspaceFiles), not an array',
    fix: 'Fix the field at the file and line it shows. `vx docs <field>` prints that field’s page.',
  },
  {
    code: 'VX_E_CYCLE',
    stage: 'lock',
    means: 'Two tasks wait for each other.',
    sees: 'dependsOn cycle: @demo/ui#build -> @demo/web#build -> @demo/ui#build',
    fix: 'Remove one `dependsOn` entry from the loop it prints.',
  },
  {
    code: 'VX_E_DEPENDS_ON',
    stage: 'lock',
    means: '`dependsOn` names a task or project that does not exist.',
    sees: 'tasks.build.dependsOn names @demo/ui#biuld, but @demo/ui declares no task biuld',
    fix: 'Use the name it suggests, or add that task. A `^build` needs a lockfile plugin such as `bun()`.',
  },
  {
    code: 'VX_E_OUTPUT_OVERLAP',
    stage: 'lock',
    means: 'Two tasks write the same files.',
    sees: '… whichever of these runs second DELETES the other’s output',
    fix: 'Give each task its own output folder, or make one depend on the other.',
  },
  {
    code: 'VX_E_INPUT_IS_OUTPUT',
    stage: 'lock',
    means: 'A task reads the files it writes.',
    sees: '… is also its own output — vx removes a task’s outputs before it runs',
    fix: 'Exclude the outputs from `inputs.files` with a `!` glob. A formatter declares no outputs.',
  },
  {
    code: 'VX_E_NESTED_INPUT',
    stage: 'lock',
    means: 'An input glob reaches into another project.',
    sees: '… lies inside the project …: a project’s globs never reach another project’s files',
    fix: 'Depend on that project’s task, or list the files in `inputs.workspaceFiles`.',
  },
  {
    code: 'VX_E_NESTED_OUTPUT',
    stage: 'lock',
    means: 'An output glob reaches into another project.',
    sees: '… writes … in outputs.files, which lies inside the project …',
    fix: 'Let that project’s task write the files, or list them in `outputs.workspaceFiles`.',
  },
  {
    code: 'VX_E_DEPENDENCY_RULE',
    stage: 'lock',
    means: 'A project depends on one your rules forbid.',
    sees: 'each broken edge, with both projects and the rule',
    fix: 'Drop the dependency, or change the project’s tags or the rule in `run.rules.dependencies`.',
  },
  {
    code: 'VX_E_USAGE',
    stage: 'run',
    means: 'A flag or argument vx does not take.',
    sees: 'unknown flag …',
    fix: 'Use the spelling it suggests. `vx <verb> --help` lists every flag.',
  },
  {
    code: 'VX_E_UNKNOWN_COMMAND',
    stage: 'run',
    means: 'No verb with that name.',
    sees: 'unknown command: biuld, a typo of the task `build`',
    fix: 'Run the command it prints. A task runs as `vx run <task>`.',
  },
  {
    code: 'VX_E_UNKNOWN_TASK',
    stage: 'run',
    means: 'No selected project has that task.',
    sees: 'no projects declare task(s): biuld',
    fix: 'Use the name it suggests. A new task? Run `vx lock` first.',
  },
  {
    code: 'VX_E_UNKNOWN_PROJECT',
    stage: 'run',
    means: '`vx show` names a project the workspace does not have.',
    sees: 'vx show: unknown project: "…"',
    fix: 'Use the name it suggests. `vx show` lists every project.',
  },
  {
    code: 'VX_E_LOCK',
    stage: 'run',
    means: 'The lock is missing, broken or out of date.',
    sees: 'no lock: run `vx lock`',
    fix: 'Run `vx lock`, then commit `.vx/projects.lock` and `.vx/dependencies.lock`.',
  },
  {
    code: 'VX_E_AFFECTED_BASE',
    stage: 'run',
    means: '`--affected` has nothing to compare with.',
    sees: 'git ref "origin/nope" did not resolve',
    fix: 'Name a branch you have: `--affected=origin/main`. In a shallow clone, `git fetch --depth=1 origin main`.',
  },
  {
    code: 'VX_E_FS',
    stage: 'task',
    means: 'The disk refused a read or a write.',
    sees: 'the path, and why: no access, a full disk, a path too long',
    fix: 'Grant the access or free space (`vx cache clean --max-size 2GB`), then run again.',
  },
  {
    code: 'VX_E_FDS',
    stage: 'task',
    means: 'Out of file descriptors.',
    sees: 'the process is out of file descriptors; raise the limit (ulimit -n 4096) and re-run',
    fix: 'Raise the limit with `ulimit -n 4096`, or run fewer tasks at once with `--concurrency`.',
  },
  {
    code: 'VX_E_REFUSED',
    stage: 'task',
    means: 'A plugin or a check refused, with no code of its own.',
    sees: 'plugin … failed in …',
    fix: 'Do what the message says. `vx info` lists your plugins.',
  },
  {
    code: 'VX_E_INTERNAL',
    stage: 'task',
    means: 'A bug in vx.',
    sees: 'a stack trace and a request to report it',
    fix: 'Open an issue at github.com/vznjs/vx/issues with the stack it printed.',
  },
  {
    code: 'VX_E_NO_HISTORY',
    stage: 'ask',
    means: 'That task has not run in this checkout yet.',
    sees: 'no recorded runs for "@demo/web#test"',
    fix: 'Run the task once, then ask again.',
  },
  {
    code: 'VX_E_AMBIGUOUS',
    stage: 'ask',
    means: 'The name fits more than one task or run.',
    sees: '"build" ran in 2 projects — pick one',
    fix: 'Name one: `vx why @demo/web#build`. For a run id, type more of it.',
  },
  {
    code: 'VX_E_CACHE_VERSION',
    stage: 'ask',
    means: 'The cache was written by another vx version.',
    sees: 'the cache at … holds index schema … from another vx version',
    fix: 'Nothing breaks: the next `vx run` resets it.',
  },
  {
    code: 'VX_E_NETWORK',
    stage: 'ask',
    means: '`vx docs` could not reach GitHub.',
    sees: 'cannot read the docs at … from GitHub',
    fix: 'Retry online, or set `GITHUB_TOKEN`. The same pages are on this site.',
  },
]
