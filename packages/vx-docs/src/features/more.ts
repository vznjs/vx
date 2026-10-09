// The features the hub gained after the first 37 (owner, 2026-10-09: every
// feature in features.md a card and a page of its own, value first). Same
// shape as features.ts; images are 1600×900 cards in the campaign's style.

import type { Feature } from './features.js'

export const MORE: readonly Feature[] = [
  {
    slug: 'skip-dependencies',
    title: 'Run just the task',
    category: 'run',
    hook: 'Skip the dependency chain when you know it is already built.',
    body: [
      'Most runs should build what a task depends on first. Sometimes you know better: the upstream packages are built and you only want the test you are fixing.',
      '`--exclude-dependencies` drops every `dependsOn` edge, so just the task you asked for runs. Give it names to drop only those edges and keep the rest.',
    ],
    example: {
      lang: 'sh',
      code: 'vx run test --filter @demo/web --exclude-dependencies\nvx run test --all --exclude-dependencies=build',
    },
    image: 'skip-dependencies.png',
    imageAlt: 'A run of one test task with its build dependencies skipped.',
    docs: {
      label: 'Run flags',
      href: 'cli/#vx-run',
    },
    deepDive: {
      label: 'Say exactly which tasks to run',
      href: 'blog/pick-your-tasks/',
    },
  },
  {
    slug: 'timeouts',
    title: 'Timeouts',
    category: 'run',
    hook: 'A hung task is killed and reported as a timeout, not left to stall the run.',
    body: [
      'A test that waits on a socket forever holds the whole pipeline hostage. Give a task a limit and vx kills it when the limit passes, then marks it failed with the reason.',
      'Set it per task with `exec.timeout`, for the workspace with `timeout`, or for one run with `--timeout` or `VX_TASK_TIMEOUT`. The task’s own limit always wins.',
    ],
    example: {
      lang: 'ts',
      code: "// packages/api/vx.config.ts\nimport { defineProject } from '@vzn/vx/config'\n\nexport default defineProject({\n  tasks: {\n    test: { exec: { command: 'vitest run', timeout: 120_000 } },\n  },\n})",
    },
    image: 'timeouts.png',
    imageAlt: 'A task killed after its timeout and reported as timed out.',
    docs: {
      label: 'exec.timeout',
      href: 'schema/',
    },
    deepDive: {
      label: 'When a task misbehaves',
      href: 'blog/tasks-that-misbehave/',
    },
  },
  {
    slug: 'forward-args',
    title: 'Pass arguments through',
    category: 'run',
    hook: 'Arguments after `--` reach the task, and the cache keeps each set apart.',
    body: [
      'Sometimes a task needs one more flag for this run only, like a test filter. Everything after `--` is appended to the task’s command.',
      'The arguments are part of the cache key, so a run with `--watch=false` never replays the output of a run without it.',
    ],
    example: {
      lang: 'sh',
      code: 'vx run @demo/api#test -- --reporter=dot\nvx run test --all -- --bail',
    },
    image: 'forward-args.png',
    imageAlt: 'Arguments after -- reaching the task’s command.',
    docs: {
      label: 'Run flags',
      href: 'cli/#vx-run',
    },
    deepDive: {
      label: 'When a task misbehaves',
      href: 'blog/tasks-that-misbehave/',
    },
  },
  {
    slug: 'group-tasks',
    title: 'Group tasks',
    category: 'run',
    hook: 'Name a set of tasks once and run them with one word.',
    body: [
      'A `check` that means lint, typecheck and test is a task with `dependsOn` and no command. Running it runs its members, in parallel where the graph allows.',
      'Groups compose like any task: depend on one, filter it, run it with `--all`. An empty `dependsOn: []` is a named no-op, handy as a placeholder a project can fill in later.',
    ],
    example: {
      lang: 'ts',
      code: "// packages/web/vx.config.ts\nimport { defineProject } from '@vzn/vx/config'\n\nexport default defineProject({\n  tasks: {\n    lint: { exec: { command: 'oxlint' } },\n    test: { exec: { command: 'vitest run' } },\n    check: { dependsOn: ['lint', 'test'] },\n  },\n})",
    },
    image: 'group-tasks.png',
    imageAlt: 'A check task that runs lint and test.',
    docs: {
      label: 'Configure',
      href: 'guides/configure/',
    },
    deepDive: {
      label: 'Say exactly which tasks to run',
      href: 'blog/pick-your-tasks/',
    },
  },
  {
    slug: 'implicit-build',
    title: 'Source-only packages still count',
    category: 'run',
    hook: 'A package with no build step still moves its dependants’ cache keys when its files change.',
    body: [
      'Many packages ship their TypeScript as is and have no `build`. If they had no task at all, a change in them could not reach the cache keys of the apps that import them.',
      'So vx gives such a project a `build` group keyed on its own files. Your config stays short, and a change to a source-only package still invalidates exactly what depends on it.',
    ],
    example: {
      lang: 'text',
      code: 'packages/ui     no build task  →  build: a group keyed on its files\npackages/web    build: dependsOn ^build\n\nedit packages/ui/src/button.ts  →  @demo/web#build misses',
    },
    image: 'implicit-build.png',
    imageAlt: 'A source-only package moving its dependant’s key.',
    docs: {
      label: 'Caching in depth',
      href: 'caching/',
    },
    deepDive: {
      label: 'The basics, done carefully',
      href: 'blog/the-basics/',
    },
  },
  {
    slug: 'depends-on-syntax',
    title: 'Say what a task needs',
    category: 'run',
    hook: 'One short syntax for upstream, cross-project and pattern edges.',
    body: [
      '`^build` means every workspace dependency’s build first. `build` alone is this project’s. `@demo/api#build` names another project’s task, and `lint.*` matches every task whose name starts that way.',
      'The edges are checked as you type in a typed config, and an edge that matches nothing is an error, not a silent no-op.',
    ],
    example: {
      lang: 'ts',
      code: "// packages/web/vx.config.ts\nimport { defineProject } from '@vzn/vx/config'\n\nexport default defineProject({\n  tasks: {\n    build: { exec: { command: 'vite build' }, dependsOn: ['^build'] },\n    test: { exec: { command: 'vitest run' }, dependsOn: ['build'] },\n    e2e: { exec: { command: 'playwright test' }, dependsOn: ['@demo/api#build'] },\n  },\n})",
    },
    image: 'depends-on-syntax.png',
    imageAlt: 'dependsOn edges: upstream, local, cross-project.',
    docs: {
      label: 'dependsOn',
      href: 'schema/',
    },
    deepDive: {
      label: 'Say exactly which tasks to run',
      href: 'blog/pick-your-tasks/',
    },
  },
  {
    slug: 'names-must-resolve',
    title: 'A typo never runs half the graph',
    category: 'run',
    hook: 'Ask for a task no project has and vx stops before anything starts.',
    body: [
      '`vx run build lnit --all` in many runners builds everything and quietly skips the misspelled task. You find out later that lint never ran.',
      'vx refuses the run, names the task it could not find and lists the ones that exist.',
    ],
    example: {
      lang: 'text',
      code: '$ vx run build lnit --all\nvx run: no projects declare task(s): lnit. Tasks: build, test.',
    },
    image: 'names-must-resolve.png',
    imageAlt: 'A misspelled task refused before the run.',
    docs: {
      label: 'Run flags',
      href: 'cli/#vx-run',
    },
    deepDive: {
      label: 'Say exactly which tasks to run',
      href: 'blog/pick-your-tasks/',
    },
  },
  {
    slug: 'tag-filters',
    title: 'Filter by tag',
    category: 'run',
    hook: 'Tag projects once, then run a task across every project with that tag.',
    body: [
      'Folders and names do not always say what a project is. Add `tags` to its config, like `frontend` or `scope:web`, and select by them.',
      '`--filter tag:frontend` takes every operator a name filter takes, so `...tag:frontend` also brings the dependents along. A tag that matches nothing gets the nearest one as a hint.',
    ],
    example: {
      lang: 'sh',
      code: 'vx run build --filter tag:frontend\nvx run test --filter ...tag:scope:web',
    },
    image: 'tag-filters.png',
    imageAlt: 'Projects selected by their tags.',
    docs: {
      label: 'Filters',
      href: 'cli/#filter-dsl---filter',
    },
    deepDive: {
      label: 'Say exactly which tasks to run',
      href: 'blog/pick-your-tasks/',
    },
  },
  {
    slug: 'dir-filters',
    title: 'Filter by folder',
    category: 'run',
    hook: 'Pick projects by where they live, or the root project alone.',
    body: [
      '`--filter ./packages/web` selects the project in that folder, and a glob selects every project under it. `//` is the root project, the one at the top of the repo.',
      'These are the forms pnpm and Turbo users already type, so muscle memory carries over.',
    ],
    example: {
      lang: 'sh',
      code: "vx run build --filter ./packages/web\nvx run lint --filter '//'",
    },
    image: 'dir-filters.png',
    imageAlt: 'Projects selected by their folder.',
    docs: {
      label: 'Filters',
      href: 'cli/#filter-dsl---filter',
    },
    deepDive: {
      label: 'Say exactly which tasks to run',
      href: 'blog/pick-your-tasks/',
    },
  },
  {
    slug: 'executor-pools',
    title: 'Remote pools at their own width',
    category: 'run',
    hook: 'Send work to a remote pool and vx fills the pool, not your laptop’s core count.',
    body: [
      'A laptop has eight cores; a remote execution cluster may have sixty-four workers. Capping remote work at the local core count wastes most of the cluster.',
      'An executor plugin declares its `capacity`, and vx admits remote tasks against that number while local tasks keep their own limit.',
    ],
    example: {
      lang: 'ts',
      code: "// vx.workspace.ts\nimport { defineWorkspace } from '@vzn/vx/config'\nimport { reapi } from '@vzn/vx-reapi'\n\nexport default defineWorkspace({\n  plugins: [reapi({ endpoint: 'grpcs://remote.example.com', execute: true, capacity: 64 })],\n})",
    },
    image: 'executor-pools.png',
    imageAlt: 'Remote tasks admitted against the pool’s own capacity.',
    docs: {
      label: 'Remote execution',
      href: 'guides/ci/',
    },
    deepDive: {
      label: 'Remote execution without moving the scheduler',
      href: 'blog/remote-execution/',
    },
  },
  {
    slug: 'run-lock',
    title: 'Runs take turns',
    category: 'run',
    hook: 'Two runs in one checkout wait for each other instead of fighting over files.',
    body: [
      'An editor’s run and yours, or two terminals, can start at once. Two writers on one output folder make broken builds that are hard to trace.',
      'vx takes a lock per workspace. The second run waits, says which process it is waiting for, and starts the moment the first one ends.',
    ],
    example: {
      lang: 'text',
      code: '$ vx run build --all\n[vx] waiting for another vx run (pid 4821) on this workspace to finish…',
    },
    image: 'run-lock.png',
    imageAlt: 'A second run waiting on the first one’s lock.',
    docs: {
      label: 'What a run does',
      href: 'execution/',
    },
    deepDive: {
      label: 'When a task misbehaves',
      href: 'blog/tasks-that-misbehave/',
    },
  },
  {
    slug: 'output-modes',
    title: 'Choose how much you see',
    category: 'output',
    hook: 'Full logs, errors only, just the hashes, or nothing.',
    body: [
      'The right amount of output depends on who reads it. You at a terminal want failures; a script wants hashes; a quiet CI step wants nothing at all.',
      '`--output-logs` picks one of `full`, `errors-only`, `hash-only` or `none`. Leave it out and vx picks from what you asked for.',
    ],
    example: {
      lang: 'sh',
      code: 'vx run build --all --output-logs=errors-only\nvx run build --all --output-logs=hash-only',
    },
    image: 'output-modes.png',
    imageAlt: 'Output modes: full, errors only, hashes only, none.',
    docs: {
      label: '--output-logs',
      href: 'cli/#vx-run',
    },
    deepDive: {
      label: 'Output that fits the run',
      href: 'blog/output-that-fits-the-run/',
    },
  },
  {
    slug: 'per-task-table',
    title: 'A table of every task',
    category: 'output',
    hook: 'One line per task at the end: what happened and how long it took.',
    body: [
      'When a run is over, you want the shape of it at a glance: what ran, what was skipped and why, what took the time.',
      '`--verbosity 1` adds a per-task table after the output, above the summary line.',
    ],
    example: {
      lang: 'sh',
      code: 'vx run build --all --verbosity 1',
    },
    image: 'per-task-table.png',
    imageAlt: 'A per-task table after a run.',
    docs: {
      label: '--verbosity',
      href: 'cli/#vx-run',
    },
    deepDive: {
      label: 'One failure, and what it takes down',
      href: 'blog/when-a-build-fails/',
    },
  },
  {
    slug: 'failed-output-kept',
    title: 'Failures kept for later',
    category: 'output',
    hook: 'A failure’s output is saved, so you or an agent can read it after the terminal is gone.',
    body: [
      'The log that explains a red build is often scrolled away or lost with a closed terminal. vx keeps the output of the latest failed runs on disk.',
      '`vx last --failed` replays it, and `--format json` adds the output as text plus the files and lines it names, so an agent can open the right file directly.',
    ],
    example: {
      lang: 'sh',
      code: 'vx last --failed\nvx last --failed --format json',
    },
    image: 'failed-output-kept.png',
    imageAlt: 'A failed task’s saved output read back as JSON.',
    docs: {
      label: 'vx last',
      href: 'cli/#vx-last',
    },
    deepDive: {
      label: 'Built for the agent at the keyboard',
      href: 'blog/built-for-agents/',
    },
  },
  {
    slug: 'markdown-report',
    title: 'A run report for your PR',
    category: 'output',
    hook: 'A short markdown report of the run, ready for a pull request or a job summary.',
    body: [
      'A wall of CI log is the wrong thing to read on a pull request. vx writes a compact report: what ran, what failed, what the cache saved.',
      '`--report` prints it; `--report-file` appends it to a file, such as GitHub’s `$GITHUB_STEP_SUMMARY`, where it shows on the job page.',
    ],
    example: {
      lang: 'sh',
      code: 'vx run build test --all --report-file "$GITHUB_STEP_SUMMARY"',
    },
    image: 'markdown-report.png',
    imageAlt: 'A markdown run report on a GitHub job page.',
    docs: {
      label: '--report',
      href: 'cli/#vx-run',
    },
    deepDive: {
      label: 'Output that fits the run',
      href: 'blog/output-that-fits-the-run/',
    },
  },
  {
    slug: 'run-json',
    title: 'Every run as JSON',
    category: 'output',
    hook: 'A JSON file per run, with each task’s result and the time the cache saved.',
    body: [
      'Dashboards and scripts want data, not log lines. `--summarize` writes one JSON document per run: status, timing, hash and cache result for every task.',
      '`savedMs` is the time the cache saved, the number to show when someone asks what caching buys you.',
    ],
    example: {
      lang: 'sh',
      code: 'vx run build --all --summarize=run.json',
    },
    image: 'run-json.png',
    imageAlt: 'A run’s JSON summary with savedMs.',
    docs: {
      label: '--summarize',
      href: 'cli/#vx-run',
    },
    deepDive: {
      label: 'See inside a run',
      href: 'blog/see-inside-a-run/',
    },
  },
  {
    slug: 'run-tags',
    title: 'Label your runs',
    category: 'output',
    hook: 'Tag a run, like `env=nightly`, and find it again in history and dashboards.',
    body: [
      'A nightly build, a release run and a developer’s run look the same in a list. A tag tells them apart.',
      '`--tag key=value` is recorded with the run, so history queries and telemetry plugins can filter on it.',
    ],
    example: {
      lang: 'sh',
      code: 'vx run build --all --tag env=nightly --tag branch=main',
    },
    image: 'run-tags.png',
    imageAlt: 'A run labelled with tags.',
    docs: {
      label: '--tag',
      href: 'cli/#vx-run',
    },
    deepDive: {
      label: 'See inside a run',
      href: 'blog/see-inside-a-run/',
    },
  },
  {
    slug: 'stage-timing',
    title: 'See where vx spends its time',
    category: 'output',
    hook: 'A table of vx’s own stages, so a slow run points at its cause.',
    body: [
      'When a run feels slow, the question is whether it is your tasks or the runner. `VX_TIMING=1` prints how long each of vx’s stages took.',
      'The same table is how vx’s own speed work is measured, so a report from you is one we can act on.',
    ],
    example: {
      lang: 'sh',
      code: 'VX_TIMING=1 vx run build --all',
    },
    image: 'stage-timing.png',
    imageAlt: 'vx’s stage timing table.',
    docs: {
      label: 'Benchmarks',
      href: 'benchmarks/',
    },
    deepDive: {
      label: 'See inside a run',
      href: 'blog/see-inside-a-run/',
    },
  },
  {
    slug: 'output-flows',
    title: 'Output that follows the run',
    category: 'output',
    hook: 'One task streams live; a broad run shows one line per task; CI shows everything.',
    body: [
      'Running one task, you want its output as it happens. Running a hundred, you want a line each and the failures in full at the end. In CI, the log is the record, so every frame stays.',
      'vx picks the flow from what you asked for. A truthy `CI` always gets the CI flow, and `--output-logs` overrides any of it.',
    ],
    example: {
      lang: 'text',
      code: 'vx run @demo/web#build     focused: the task’s output, live\nvx run build --all         broad: a line per task, failures in full\nCI=1 vx run build --all    CI: every frame',
    },
    image: 'output-flows.png',
    imageAlt: 'Three output flows: focused, broad and CI.',
    docs: {
      label: 'Output',
      href: 'cli/#vx-run',
    },
    deepDive: {
      label: 'Output that fits the run',
      href: 'blog/output-that-fits-the-run/',
    },
  },
  {
    slug: 'cache-glyphs',
    title: 'Glyphs that show the cache',
    category: 'output',
    hook: 'Each task’s line shows at a glance whether it ran, was fresh, or came from a cache.',
    body: [
      '“Success” hides the most useful fact: did it run, or come back from the cache, and which one. vx’s glyph says it in one character.',
      'Ran, up to date, restored from the local or the remote cache, failed, skipped or persistent: a broad run reads at a glance.',
    ],
    example: {
      lang: 'text',
      code: '⏺  ran (cache miss)\n►  up to date, nothing to restore\n⇢  restored from the local cache\n⇣  restored from the remote cache\n◼  failed\n⊘  skipped, with the failure that blocked it\n▸  persistent, like a dev server',
    },
    image: 'cache-glyphs.png',
    imageAlt: 'The task glyphs: ran, fresh, restored, failed, skipped.',
    docs: {
      label: 'Output',
      href: 'cli/#vx-run',
    },
    deepDive: {
      label: 'Output that fits the run',
      href: 'blog/output-that-fits-the-run/',
    },
  },
  {
    slug: 'actions-log-groups',
    title: 'Folded logs on GitHub Actions',
    category: 'output',
    hook: 'On Actions, each task is a collapsible group with its result in the title.',
    body: [
      'A CI log of hundreds of tasks is a long scroll. On GitHub Actions vx wraps each task’s output in a `::group::`, titled with its outcome and time.',
      'The log reads as a list of tasks; open the one that failed. Nothing to configure: vx sees `GITHUB_ACTIONS`.',
    ],
    example: {
      lang: 'text',
      code: '::group::@demo/api#build (success 312ms)\n┌─ @demo/api#build > success\n$ mkdir -p dist && cp src/index.ts dist/index.js\n└─ @demo/api#build ── (312ms) success\n::endgroup::',
    },
    image: 'actions-log-groups.png',
    imageAlt: 'GitHub Actions log groups, one per task.',
    docs: {
      label: 'CI and remote',
      href: 'guides/ci/',
    },
    deepDive: {
      label: 'The basics, done carefully',
      href: 'blog/the-basics/',
    },
  },
  {
    slug: 'colors',
    title: 'Colors, on your terms',
    category: 'output',
    hook: 'Truecolor output, turned off with `NO_COLOR` or forced on with `FORCE_COLOR`.',
    body: [
      'Color helps at a terminal and hurts in a log file. vx colors its output when it writes to a terminal and stays plain otherwise.',
      'The common switches work: `NO_COLOR` turns color off, `FORCE_COLOR` keeps it on in a pipe or a CI log viewer that renders it.',
    ],
    example: {
      lang: 'sh',
      code: 'NO_COLOR=1 vx run build --all\nFORCE_COLOR=1 vx run build --all | less -R',
    },
    image: 'colors.png',
    imageAlt: 'The same run with and without color.',
    docs: {
      label: 'Output',
      href: 'cli/#vx-run',
    },
    deepDive: {
      label: 'The basics, done carefully',
      href: 'blog/the-basics/',
    },
  },
  {
    slug: 'signal-exits',
    title: 'Exit codes in plain words',
    category: 'output',
    hook: 'A task killed by a signal says which signal, not just a number.',
    body: [
      '`exit 137` means nothing to most people. vx adds the reading: `128 + SIGKILL`, and the usual reasons, such as the kernel’s out-of-memory killer.',
      'A timeout reports itself as a timeout, so the two are never confused.',
    ],
    example: {
      lang: 'text',
      code: '$ vx run @demo/api#killed\n└─ @demo/api#killed ── (2ms) failed (exit 137, 128 + SIGKILL)',
    },
    image: 'signal-exits.png',
    imageAlt: 'A failed task naming the signal that killed it.',
    docs: {
      label: 'Troubleshooting',
      href: 'guides/troubleshooting/',
    },
    deepDive: {
      label: 'When a task misbehaves',
      href: 'blog/tasks-that-misbehave/',
    },
  },
  {
    slug: 'plain-off-tty',
    title: 'Plain output in a pipe',
    category: 'output',
    hook: 'Off a terminal, vx prints plain lines and never waits on a prompt.',
    body: [
      'A live, redrawing view is right at a terminal and wrong in a pipe, a file or an agent’s shell. vx sees when its output is not a terminal and prints plain lines instead.',
      'A missing task name opens a picker at a terminal; in a pipe it lists the tasks and exits, so a script never hangs on a question.',
    ],
    example: {
      lang: 'text',
      code: '$ vx run | cat\nvx run: missing task name (stdin is not a TTY, so no picker; tasks here: build, test)',
    },
    image: 'plain-off-tty.png',
    imageAlt: 'A run in a pipe listing tasks instead of opening a picker.',
    docs: {
      label: 'Output',
      href: 'cli/#vx-run',
    },
    deepDive: {
      label: 'The basics, done carefully',
      href: 'blog/the-basics/',
    },
  },
  {
    slug: 'task-graph',
    title: 'Draw the task graph',
    category: 'insight',
    hook: 'Export the graph as Graphviz DOT and see what depends on what.',
    body: [
      'A graph you cannot see is a graph you guess about. `--graph` prints the tasks a run would execute and their edges as DOT, colored by cache state.',
      'Pipe it to Graphviz for a picture, or write it to a file. Nothing runs.',
    ],
    example: {
      lang: 'sh',
      code: 'vx run build --filter @demo/web --graph\nvx run build --all --graph=graph.dot',
    },
    image: 'task-graph.png',
    imageAlt: 'The task graph rendered from DOT.',
    docs: {
      label: '--graph',
      href: 'cli/#vx-run',
    },
    deepDive: {
      label: 'See inside a run',
      href: 'blog/see-inside-a-run/',
    },
  },
  {
    slug: 'vx-info',
    title: 'Know your workspace',
    category: 'insight',
    hook: 'One command shows versions, projects, cache size and recent runs.',
    body: [
      '“Works on my machine” starts with knowing what the machine has. `vx info` prints vx, Bun and git versions, the projects and plugins, CPU and memory, where the cache lives and how big it is.',
      'Paste it into an issue and the first round of questions is answered. `--format json` gives the same to a script.',
    ],
    example: {
      lang: 'sh',
      code: 'vx info\nvx info --format json',
    },
    image: 'vx-info.png',
    imageAlt: 'vx info listing the workspace’s facts.',
    docs: {
      label: 'vx info',
      href: 'cli/#vx-info',
    },
    deepDive: {
      label: 'One command to know your workspace',
      href: 'blog/know-your-workspace/',
    },
  },
  {
    slug: 'json-everywhere',
    title: 'JSON from every report',
    category: 'insight',
    hook: '`show`, `info`, `why`, `last` and `cache` all print JSON, so scripts and agents never parse text.',
    body: [
      'A report meant for people breaks the script that scrapes it the day its wording changes. Every vx report verb takes `--format json`.',
      'With JSON, stdout is only the document; every other line goes to stderr, so the output always parses.',
    ],
    example: {
      lang: 'sh',
      code: 'vx show --format json\nvx why @demo/web#build --format json\nvx last --format json',
    },
    image: 'json-everywhere.png',
    imageAlt: 'Report verbs printing JSON.',
    docs: {
      label: 'Machine-readable output',
      href: 'cli/#machine-readable-output',
    },
    deepDive: {
      label: 'Built for the agent at the keyboard',
      href: 'blog/built-for-agents/',
    },
  },
  {
    slug: 'run-analytics',
    title: 'Every run, queryable',
    category: 'insight',
    hook: 'Each task’s time, CPU, memory and cache result go into SQLite you can query.',
    body: [
      'Which test got slow this week? Which task misses the cache most? The answers are in your run history, recorded on every run.',
      'It is a plain SQLite file, so `sqlite3` or any SQL tool reads it. No service, no export step.',
    ],
    example: {
      lang: 'sh',
      code: 'sqlite3 .vx/cache/cache.db "SELECT project, task, status, duration_ms FROM runs ORDER BY id DESC LIMIT 5"',
    },
    image: 'run-analytics.png',
    imageAlt: 'Run history queried with sqlite3.',
    docs: {
      label: 'Caching in depth',
      href: 'caching/',
    },
    deepDive: {
      label: 'Built for the agent at the keyboard',
      href: 'blog/built-for-agents/',
    },
  },
  {
    slug: 'error-codes',
    title: 'Errors an agent can branch on',
    category: 'insight',
    hook: 'Under `--format json`, a refusal is a JSON line with a stable code.',
    body: [
      'An agent that has to match the wording of an error message breaks when the message improves. vx gives every refusal a code that stays the same.',
      'Unknown task, bad config, a graph cycle, no workspace: each has its own code, and the message still says what to do.',
    ],
    example: {
      lang: 'text',
      code: '$ vx run biuld --all --format json\n{"ok":false,"error":{"code":"VX_E_UNKNOWN_TASK","message":"vx run: no projects declare task(s): biuld. Did you mean build?"}}',
    },
    image: 'error-codes.png',
    imageAlt: 'A refusal as a JSON line with a stable code.',
    docs: {
      label: 'Machine-readable output',
      href: 'cli/#machine-readable-output',
    },
    deepDive: {
      label: 'A refusal an agent can read',
      href: 'blog/error-codes/',
    },
  },
  {
    slug: 'json-schemas',
    title: 'A schema for every JSON shape',
    category: 'insight',
    hook: 'Every JSON document vx prints has a published JSON Schema.',
    body: [
      'Parsing output is safer with a contract. vx ships a JSON Schema for each document: the run summary, `show`, `info`, `why`, `last`, `cache` and errors.',
      'Generate types from them, validate in a test, or hand them to an agent so it knows each field before it reads one.',
    ],
    example: {
      lang: 'text',
      code: 'node_modules/@vzn/vx/schemas/\n  summary.json  show.json  info.json  why.json\n  last.json     cache.json  plan.json  error.json',
    },
    image: 'json-schemas.png',
    imageAlt: 'The JSON Schemas shipped with vx.',
    docs: {
      label: 'Machine-readable output',
      href: 'cli/#machine-readable-output',
    },
    deepDive: {
      label: 'Built for the agent at the keyboard',
      href: 'blog/built-for-agents/',
    },
  },
  {
    slug: 'llms-txt',
    title: 'Docs your agent can read',
    category: 'insight',
    hook: 'The whole site as markdown in `llms.txt` and `llms-full.txt`.',
    body: [
      'A coding agent reads markdown far better than a rendered page with navigation around it. The docs are published as plain markdown, one index and one full file.',
      'Point your agent at them and it answers from the current docs, not from what it remembers.',
    ],
    example: {
      lang: 'sh',
      code: 'curl -s https://vznjs.github.io/vx/llms.txt\ncurl -s https://vznjs.github.io/vx/llms-full.txt',
    },
    image: 'llms-txt.png',
    imageAlt: 'llms.txt: the docs as markdown for agents.',
    docs: {
      label: 'AI agents',
      href: 'guides/agents/',
    },
    deepDive: {
      label: 'Built for the agent at the keyboard',
      href: 'blog/built-for-agents/',
    },
  },
  {
    slug: 'affected-reasons',
    title: 'Why a task is affected',
    category: 'insight',
    hook: 'Each task `--affected` keeps says which changed file or dependency brought it in.',
    body: [
      '“Affected” is only useful if you can check it. A dry run with `--affected` prints, under each task, the file that changed or the chain of tasks it came through.',
      'The same reasons are in the JSON, so a CI script or an agent can explain a run before it starts.',
    ],
    example: {
      lang: 'sh',
      code: 'vx run build --all --affected=HEAD --dry\nvx run test --all --affected=main --dry --format json',
    },
    image: 'affected-reasons.png',
    imageAlt: 'Affected tasks with the file that brought each in.',
    docs: {
      label: '--affected',
      href: 'cli/#vx-run',
    },
    deepDive: {
      label: 'See inside a run',
      href: 'blog/see-inside-a-run/',
    },
  },
  {
    slug: 'agent-skill',
    title: 'A skill for your coding agent',
    category: 'insight',
    hook: 'An installable skill teaches an agent to run, debug and query vx.',
    body: [
      'Agents do better with a short guide than by trial and error. vx ships one: how to run tasks, read a failure, ask `vx why` and use JSON output.',
      'Copy it into your agent’s skills folder and it uses vx the way the docs intend.',
    ],
    example: {
      lang: 'sh',
      code: 'mkdir -p .claude/skills/vx\ncp node_modules/@vzn/vx/skills/vx/SKILL.md .claude/skills/vx/',
    },
    image: 'agent-skill.png',
    imageAlt: 'The vx skill copied into an agent’s skills folder.',
    docs: {
      label: 'AI agents',
      href: 'guides/agents/',
    },
    deepDive: {
      label: 'Built for the agent at the keyboard',
      href: 'blog/built-for-agents/',
    },
  },
]
