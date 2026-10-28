// The features the hub gained after the first 37 (2026-10-09: every
// feature in features.md a card and a page of its own, value first). Same
// shape as features.ts; images are 1600×900 cards in the campaign's style.

import type { Feature } from './features.js'

export const MORE: readonly Feature[] = [
  {
    slug: 'skip-dependencies',
    title: 'Run only the task',
    category: 'run',
    hook: 'Skip the dependency chain when you know it is already built.',
    body: [
      'Most runs should build what a task depends on first. Sometimes you know better: the upstream packages are built and you only want the test you are fixing.',
      '`--exclude-dependencies` drops every `dependsOn` edge, so only the task you asked for runs. Give it names to drop only those edges and keep the rest.',
    ],
    example: {
      lang: 'sh',
      code: 'vx run test --filter @demo/web --exclude-dependencies\nvx run test --all --exclude-dependencies=build',
    },
    image: 'skip-dependencies.png',
    imageAlt: 'A run of one test task with its build dependencies skipped.',
    docs: {
      label: 'Run flags',
      href: 'cli/run/',
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
      'Set it per task with `exec.timeout`, for the workspace with `run.timeout`, or for one run with `--timeout` or `VX_RUN_TIMEOUT`. The task’s own limit always wins.',
    ],
    example: {
      lang: 'ts',
      code: "// packages/api/vx.config.ts\nimport { defineProject } from '@vzn/vx/config'\n\nexport default defineProject({\n  tasks: {\n    test: { exec: { command: 'vitest run', timeout: '2m' } },\n  },\n})",
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
      href: 'cli/run/',
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
      href: 'docs/workspace/',
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
      '`^build` means every workspace dependency’s build first, by the edges your lockfile plugin reads from what the package manager installed. `build` alone is this project’s. `@demo/api#build` names another project’s task, and `lint.*` matches every task whose name starts that way.',
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
      code: '$ vx run build lnit --all\n✗ vx run  no projects declare task(s): lnit\n\n  Tasks: build, test\n  A run reads the lock: after editing a vx.config, run `vx lock`',
    },
    image: 'names-must-resolve.png',
    imageAlt: 'A misspelled task refused before the run.',
    docs: {
      label: 'Run flags',
      href: 'cli/run/',
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
      href: 'cli/run/#filter-dsl---filter',
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
      href: 'cli/run/#filter-dsl---filter',
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
      code: "// .vx/workspace.ts\nimport { defineWorkspace } from '@vzn/vx/config'\nimport { reapi } from '@vzn/vx-reapi'\n\nexport default defineWorkspace({\n  plugins: [reapi({ endpoint: 'grpcs://remote.example.com', execute: true, capacity: 64 })],\n})",
    },
    image: 'executor-pools.png',
    imageAlt: 'Remote tasks admitted against the pool’s own capacity.',
    docs: {
      label: 'Remote execution',
      href: 'docs/ci/',
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
    hook: 'Full logs, errors only, the hashes alone, or nothing.',
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
      href: 'cli/run/',
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
      href: 'cli/run/',
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
      href: 'cli/last/',
    },
    deepDive: {
      label: 'Built for the agent at the keyboard',
      href: 'blog/built-for-agents/',
    },
  },
  {
    slug: 'stage-timing',
    title: 'See where vx spends its time',
    category: 'output',
    hook: 'A table of vx’s own stages, so a slow run points at its cause.',
    body: [
      'When a run feels slow, the question is whether it is your tasks or the runner. `VX_DEBUG_TIMING=1` prints how long each of vx’s stages took.',
      'The same table is how vx’s own speed work is measured, so a report from you is one we can act on.',
    ],
    example: {
      lang: 'sh',
      code: 'VX_DEBUG_TIMING=1 vx run build --all',
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
      href: 'cli/run/',
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
      href: 'cli/run/',
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
      href: 'docs/ci/',
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
      href: 'cli/run/',
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
    hook: 'A task killed by a signal says which signal, not only a number.',
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
      code: '$ vx run | cat\n✗ vx run  missing task name (stdin is not a TTY, so no picker; tasks here: build, test)\n\n  see vx run --help',
    },
    image: 'plain-off-tty.png',
    imageAlt: 'A run in a pipe listing tasks instead of opening a picker.',
    docs: {
      label: 'Output',
      href: 'cli/run/',
    },
    deepDive: {
      label: 'The basics, done carefully',
      href: 'blog/the-basics/',
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
      href: 'cli/info/',
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
    hook: 'Asked for JSON, a refusal is a JSON line with a stable code.',
    body: [
      'An agent that has to match the wording of an error message breaks when the message improves. vx gives every refusal a code that stays the same.',
      'Unknown task, bad config, a graph cycle, no workspace: each has its own code, and a `docs` link to the fix. `vx docs <code>` prints the same fix in the terminal.',
    ],
    example: {
      lang: 'text',
      code: '$ vx run biuld --all --dry=json\n{"ok":false,"error":{"code":"VX_E_UNKNOWN_TASK","message":"vx run: no projects declare task(s): biuld. Did you mean build?","docs":"https://vznjs.github.io/vx/cli/#vx_e_unknown_task"}}',
    },
    image: 'error-codes.png',
    imageAlt: 'A refusal as a JSON line with a stable code.',
    docs: {
      label: 'Error codes',
      href: 'cli/#error-codes',
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
      'Parsing output is safer with a contract. vx ships a JSON Schema for each document: the plan, `show`, `info`, `why`, `last`, `cache` and errors.',
      'Generate types from them, validate in a test, or hand them to an agent so it knows each field before it reads one.',
    ],
    example: {
      lang: 'text',
      code: 'node_modules/@vzn/vx/schemas/\n  plan.json  show.json   info.json  why.json\n  last.json  cache.json  error.json',
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
      href: 'docs/agents/',
    },
    deepDive: {
      label: 'Built for the agent at the keyboard',
      href: 'blog/built-for-agents/',
    },
  },
  {
    slug: 'vx-docs',
    title: 'The reference at your version',
    category: 'insight',
    hook: '`vx docs <query>` searches the reference your vx version wrote.',
    body: [
      'It reads the docs at your release tag on GitHub, so the answer matches the version you run, not the newest site.',
      'A query prints the best sections whole, with a link to each on the site. An error code prints its fix, and `--format json` hands the hits to an agent.',
    ],
    example: {
      lang: 'sh',
      code: 'vx docs affected\nvx docs VX_E_CYCLE\nvx docs "remote cache" --format json',
    },
    image: 'vx-docs.png',
    imageAlt: 'vx docs printing a reference section.',
    docs: {
      label: 'vx docs',
      href: 'cli/docs/',
    },
    deepDive: {
      label: 'The reference at your version',
      href: 'blog/vx-docs-offline/',
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
      code: 'vx run build --all --affected=HEAD --dry\nvx run test --all --affected=main --dry=json',
    },
    image: 'affected-reasons.png',
    imageAlt: 'Affected tasks with the file that brought each in.',
    docs: {
      label: '--affected',
      href: 'cli/run/',
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
      'Agents do better with a short guide than by trial and error. vx ships one: how to run tasks, read a failure, ask `vx why`, read run history with `vx last --stats` and use JSON output.',
      'Install it with `bunx skills add vznjs/vx`, or copy it from `node_modules` to match the vx you installed, and your agent uses vx the way the docs intend.',
    ],
    example: {
      lang: 'sh',
      code: 'bunx skills add vznjs/vx\n# or the copy matching the installed vx:\nmkdir -p .claude/skills/vx\ncp node_modules/@vzn/vx/skills/vx/SKILL.md .claude/skills/vx/',
    },
    image: 'agent-skill.png',
    imageAlt: 'The vx skill copied into an agent’s skills folder.',
    docs: {
      label: 'AI agents',
      href: 'docs/agents/',
    },
    deepDive: {
      label: 'Built for the agent at the keyboard',
      href: 'blog/built-for-agents/',
    },
  },
  {
    slug: 'explicit-inputs',
    title: 'Caching you opt into',
    category: 'cache',
    hook: 'A task is keyed on the inputs it names, so a hit is never a guess.',
    body: [
      'A cache that guesses what a task reads will one day replay a stale result and call the run green. vx never guesses: a task is keyed on the files its config lists under `inputs`, cached or not, and every task behind it folds that key.',
      'No `cache` block, no caching. Add one beside the inputs and every hit is backed by what you declared. A task that names no inputs has no key, so nothing behind it hits. The sandbox can prove the list is complete.',
    ],
    example: {
      lang: 'ts',
      code: "// packages/api/vx.config.ts\nimport { defineProject } from '@vzn/vx/config'\n\nexport default defineProject({\n  tasks: {\n    build: {\n      exec: { command: 'tsc -b' },\n      inputs: { files: ['src/**', 'tsconfig.json'] }, cache: { outputs: { files: ['dist/**'] } },\n    },\n  },\n})",
    },
    image: 'explicit-inputs.png',
    imageAlt: 'A task’s cache block naming its inputs and outputs.',
    docs: {
      label: 'Caching in depth',
      href: 'caching/',
    },
    deepDive: {
      label: 'Explicit over magical',
      href: 'blog/explicit-over-magical/',
    },
  },
  {
    slug: 'key-inputs',
    title: 'Everything a build depends on',
    category: 'cache',
    hook: 'Env vars, tool versions, upstream tasks and root files all go into the key.',
    body: [
      'A build depends on more than its source: `NODE_ENV`, the Bun version, a shared `tsconfig.base.json`. Leave one out and a hit can replay the wrong bytes.',
      'Name each one under `inputs`: `env` for variables, `runtime` for a command whose output is a version, `workspaceFiles` for files at the root. Change any of them and the key changes.',
    ],
    example: {
      lang: 'ts',
      code: "// packages/api/vx.config.ts\nimport { defineProject } from '@vzn/vx/config'\n\nexport default defineProject({\n  tasks: {\n    bundle: {\n      exec: { command: 'vite build', env: { passThrough: ['NODE_ENV'] } },\n      inputs: {\n        files: ['src/**'],\n        env: ['NODE_ENV'],\n        runtime: ['bun --version'],\n        workspaceFiles: ['tsconfig.base.json'],\n      },\n      cache: { outputs: { files: ['dist/**'] } },\n    },\n  },\n})",
    },
    image: 'key-inputs.png',
    imageAlt: 'Env, runtime and workspace files declared as key inputs.',
    docs: {
      label: 'Caching in depth',
      href: 'caching/',
    },
    deepDive: {
      label: 'What goes into a key, and what comes back',
      href: 'blog/inside-a-cache-hit/',
    },
  },
  {
    slug: 'cache-outputs',
    title: 'Outputs that come back',
    category: 'cache',
    hook: 'Name what a task produces, and a hit puts exactly those files back.',
    body: [
      'A hit is only useful if the files your next step needs are there. `cache.outputs.files` names them: `dist/**`, a coverage report, a generated schema.',
      'On a hit, vx restores those files and nothing else. Outputs at the workspace root go under `outputs.workspaceFiles`.',
    ],
    example: {
      lang: 'ts',
      code: "// packages/api/vx.config.ts\nimport { defineProject } from '@vzn/vx/config'\n\nexport default defineProject({\n  tasks: {\n    build: {\n      exec: { command: 'vite build' },\n      inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**', 'stats.json'] } },\n    },\n  },\n})",
    },
    image: 'cache-outputs.png',
    imageAlt: 'Declared outputs restored on a cache hit.',
    docs: {
      label: 'Caching in depth',
      href: 'caching/',
    },
    deepDive: {
      label: 'What goes into a key, and what comes back',
      href: 'blog/inside-a-cache-hit/',
    },
  },
  {
    slug: 'cascade',
    title: 'Changes travel down, and stop',
    category: 'cache',
    hook: 'A task’s key folds in its dependencies’ input keys, so a change reaches exactly what depends on it.',
    body: [
      'When a library changes, the apps that use it must rebuild, and the ones that do not, must not. vx folds each upstream task’s input key into its dependants’ keys.',
      'Folding inputs, not outputs, means every key is known before anything runs. That is what makes `--dry` able to predict hits for the whole graph.',
    ],
    example: {
      lang: 'text',
      code: 'ui#build key  = hash(ui sources)\nweb#build key = hash(web sources + ui#build key)\n\nedit ui  →  ui#build and web#build miss\nedit web →  only web#build misses',
    },
    image: 'cascade.png',
    imageAlt: 'Upstream input keys folded into a dependant’s key.',
    docs: {
      label: 'Caching in depth',
      href: 'caching/',
    },
    deepDive: {
      label: 'Cascade through dependencies',
      href: 'blog/cascade-through-inputs/',
    },
  },
  {
    slug: 'upfront-keys',
    title: 'Every key known before the run',
    category: 'cache',
    hook: '`vx lock` refuses an input glob another task’s outputs could match, so keys never wait on a build.',
    body: [
      'If `test` reads `dist/**` that `build` writes, its key depends on what `build` produces, and no one can know it until `build` runs. Plans and remote caches stop working.',
      '`vx lock` always refuses that overlap and names the fix: exclude the output from the glob, or depend on `build` and leave it out of `inputs.tasks`, so the key waits for `build` and hashes the bytes it wrote.',
      'An output git ignores is no overlap: a key reads only what git lists, so `**/*` beside a gitignored `**/dist/**` keys before the build. A tracked output is still refused.',
    ],
    example: {
      lang: 'text',
      code: '@demo/web#test reads "src/**" in inputs.files, which matches\n@demo/web#build\'s output "src/gen/**". Exclude it: add "!src/gen/**".',
    },
    image: 'upfront-keys.png',
    imageAlt: 'An input glob that overlaps an output, refused at load.',
    docs: {
      label: 'Workspace rules',
      href: 'schema/',
    },
    deepDive: {
      label: 'Cascade through dependencies',
      href: 'blog/cascade-through-inputs/',
    },
  },
  {
    slug: 'cache-controls',
    title: 'The cache, your way',
    category: 'cache',
    hook: 'Turn it off, re-run past it, or choose per layer what is read and written.',
    body: [
      'Sometimes you need a clean build, sometimes you want to read a shared cache without writing to it. `--no-cache` turns caching off, and `--force` re-runs everything and saves only what the cache lacks.',
      '`--cache-policy` controls each layer: read the remote but never upload, or skip the local cache and upload only. `VX_CACHE_POLICY` sets the same spec for every run in a shell or CI job, and `cache.policy` in `.vx/workspace.ts` sets the default. The local cache is always asked first, then each remote.',
    ],
    example: {
      lang: 'sh',
      code: 'vx run build --all --force\nvx run build --all --no-cache\nvx run build --all --cache-policy=local:rw,remote:r\nVX_CACHE_POLICY=local:rw,remote:r vx run build --all',
    },
    image: 'cache-controls.png',
    imageAlt: 'Cache flags: force, no-cache, per-layer.',
    docs: {
      label: 'Cache flags',
      href: 'cli/run/',
    },
    deepDive: {
      label: 'The cache on your terms',
      href: 'blog/the-cache-on-your-terms/',
    },
  },
  {
    slug: 'cache-location',
    title: 'Put the cache where you want',
    category: 'cache',
    hook: 'Move the cache to a fast disk or a CI cache folder with one setting.',
    body: [
      'By default the cache lives under `~/.vx`, shared by every checkout of the repo. CI often wants it in a folder its own cache step saves and restores.',
      'Set `cache.dir` in the workspace config, `VX_CACHE_DIR` in the environment, or `--cache-dir` for one run.',
    ],
    example: {
      lang: 'sh',
      code: 'vx run build --all --cache-dir .vx-cache\nVX_CACHE_DIR=/mnt/fast/vx vx run build --all',
    },
    image: 'cache-location.png',
    imageAlt: 'The cache directory set by flag or env.',
    docs: {
      label: '--cache-dir',
      href: 'cli/run/',
    },
    deepDive: {
      label: 'The cache on your terms',
      href: 'blog/the-cache-on-your-terms/',
    },
  },
  {
    slug: 'cache-scope',
    title: 'Branch caches the server enforces',
    category: 'cache',
    hook: 'Main writes the shared cache; a branch reads it and writes only its own, as the server decides.',
    body: [
      'A shared cache is only as trustworthy as the runs that write to it. A pull request should never be able to plant an artifact that main will replay.',
      "So the client never picks where a write lands. The CI OIDC token, checked against the workflows the cache server’s `ALLOW` names, does: main writes main’s scope, a branch writes its own, a fork writes nothing. `turboCache()` only steers reads: every request names the run’s refs in `x-artifact-read-scopes` (`refs/heads/feat-x, refs/heads/main`), and the server answers from the first that holds the key. For a server that ignores the header, `scope: 'key'` folds the ref into each key and asks every ref’s key in one batch. The local cache never knows a branch.",
    ],
    example: {
      lang: 'ts',
      code: "// .vx/workspace.ts\nimport { defineWorkspace } from '@vzn/vx/config'\nimport { turboCache } from '@vzn/vx-migrate'\n\nexport default defineWorkspace({\n  plugins: [turboCache({ scope: 'header' })], // the default; 'key' for Vercel\n})",
    },
    image: 'cache-scope.png',
    imageAlt: 'CI writing the remote cache, a laptop only reading.',
    docs: {
      label: 'Cache scopes',
      href: 'docs/remote-cache/#cache-scopes-and-tokens',
    },
    deepDive: {
      label: 'Branch caches a server enforces',
      href: 'blog/branch-caches-a-server-enforces/',
    },
  },
  {
    slug: 'cache-prune',
    title: 'Keep the cache small',
    category: 'cache',
    hook: 'Evict by age or size, oldest use first, by hand or on a schedule.',
    body: [
      'Caches grow. `vx cache clean` removes entries older than a cutoff or trims the cache to a size, least recently used first.',
      'No run evicts: run it from a schedule or CI; `--dry-run` shows what would go first.',
    ],
    example: {
      lang: 'sh',
      code: 'vx cache clean --older-than 30d\nvx cache clean --max-size 10G --dry-run',
    },
    image: 'cache-prune.png',
    imageAlt: 'Cache pruning by age and size.',
    docs: {
      label: 'vx cache clean',
      href: 'cli/cache/',
    },
    deepDive: {
      label: 'One command to know your workspace',
      href: 'blog/know-your-workspace/',
    },
  },
  {
    slug: 'remote-downloads',
    title: 'Download only what you need',
    category: 'cache',
    hook: 'With remote execution, choose to fetch all outputs, the top-level ones, or none.',
    body: [
      'When tasks run on remote workers, their outputs stay remote until something needs them. Pulling every intermediate file to a laptop wastes the network.',
      '`--cache-download all` fetches everything, `toplevel` only the outputs of the tasks you asked for, and `none` fetches lazily, only when a local task needs a file.',
    ],
    example: {
      lang: 'sh',
      code: 'vx run build --all --cache-download toplevel\nvx run test --all --cache-download none',
    },
    image: 'remote-downloads.png',
    imageAlt: 'Remote outputs downloaded selectively.',
    docs: {
      label: '--cache-download',
      href: 'cli/run/',
    },
    deepDive: {
      label: 'A remote server you can trust in production',
      href: 'blog/reapi-in-production/',
    },
  },
  {
    slug: 'shared-store',
    title: 'One cache for every checkout',
    category: 'cache',
    hook: 'Clones and worktrees of the same repo share their cache entries.',
    body: [
      'A new worktree for a review should not rebuild what the main checkout already built. vx keeps one store per repo under `~/.vx`, shared by every clone and worktree.',
      'Open a worktree, run the build, and it comes back from the cache in milliseconds.',
    ],
    example: {
      lang: 'sh',
      code: 'git worktree add ../demo-wt && cd ../demo-wt\nvx run build --all',
    },
    image: 'shared-store.png',
    imageAlt: 'A new worktree hitting the cache of the main checkout.',
    docs: {
      label: 'Caching in depth',
      href: 'caching/',
    },
    deepDive: {
      label: 'The cache on your terms',
      href: 'blog/the-cache-on-your-terms/',
    },
  },
  {
    slug: 'warm-hits',
    title: 'Hits that touch nothing',
    category: 'cache',
    hook: 'When the outputs on disk already match, a hit costs a few file stats.',
    body: [
      'Most hits happen when nothing changed since the last run. Restoring files that are already there is wasted work.',
      'vx checks the outputs on disk first; when they match, the task is up to date and nothing is copied. That is why a fully cached run is milliseconds.',
    ],
    example: {
      lang: 'text',
      code: '⇢  restored from the local cache   files copied back\n►  up to date                        outputs already match: nothing to do',
    },
    image: 'warm-hits.png',
    imageAlt: 'An up-to-date task: outputs already match, nothing restored.',
    docs: {
      label: 'Caching in depth',
      href: 'caching/',
    },
    deepDive: {
      label: 'What goes into a key, and what comes back',
      href: 'blog/inside-a-cache-hit/',
    },
  },
  {
    slug: 'both-streams',
    title: 'Hits replay what you saw',
    category: 'cache',
    hook: 'A cache hit prints stdout and stderr in the order the task printed them.',
    body: [
      'A warning on stderr between two lines of stdout means something. A cache that replays stdout then stderr scrambles the story.',
      'vx stores one ordered log per task, so a hit reads exactly like the run it replays.',
    ],
    example: {
      lang: 'text',
      code: '$ vx run @demo/api#bundle\nbundling for production\nwarn: large chunk\n└─ @demo/api#bundle ── (4ms) up-to-date',
    },
    image: 'both-streams.png',
    imageAlt: 'A cache hit replaying stdout and stderr in order.',
    docs: {
      label: 'Caching in depth',
      href: 'caching/',
    },
    deepDive: {
      label: 'What goes into a key, and what comes back',
      href: 'blog/inside-a-cache-hit/',
    },
  },
  {
    slug: 'restore-lane',
    title: 'Restores never wait for builds',
    category: 'cache',
    hook: 'Cache restores run in their own lane, so hits finish while misses build.',
    body: [
      'A restore is mostly disk I/O; a build is mostly CPU. Making them share one queue leaves cores idle and hits waiting.',
      'vx runs restores on a lane of their own, up to twice `--concurrency`, so the cached part of a run is done early.',
    ],
    example: {
      lang: 'text',
      code: 'build lane    ████████  (--concurrency)\nrestore lane  ████████████████  (up to 2× --concurrency)',
    },
    image: 'restore-lane.png',
    imageAlt: 'Cache restores on a lane apart from builds.',
    docs: {
      label: 'What a run does',
      href: 'execution/',
    },
    deepDive: {
      label: 'What goes into a key, and what comes back',
      href: 'blog/inside-a-cache-hit/',
    },
  },
  {
    slug: 'line-endings',
    title: 'Keys that see what the build sees',
    category: 'cache',
    hook: 'Files git rewrites on checkout are keyed on the bytes on disk.',
    body: [
      'With `core.autocrlf` or an `eol` attribute, the file on disk differs from the one in git. A key from git’s copy would match while the build reads different bytes.',
      'vx notices files git filters and hashes them from disk, so Windows and Linux checkouts never share a wrong hit.',
    ],
    example: {
      lang: 'text',
      code: '.gitattributes:  *.sh text eol=crlf\n\ngit blob   → LF bytes\non disk    → CRLF bytes   ← what the key uses',
    },
    image: 'line-endings.png',
    imageAlt: 'A file with CRLF on disk keyed on its disk bytes.',
    docs: {
      label: 'Caching in depth',
      href: 'caching/',
    },
    deepDive: {
      label: 'Your cache key is already in git’s index',
      href: 'blog/keys-from-git/',
    },
  },
  {
    slug: 'background-uploads',
    title: 'Uploads never fail the build',
    category: 'cache',
    hook: 'Remote cache writes drain at the end of the run and never turn a green build red.',
    body: [
      'A slow or broken cache server should not slow down or break your build. vx uploads in the background while tasks keep running.',
      'Whatever is left drains at the end, within a deadline. The footer counts uploads still running as `⇡` and a task whose remote read or write failed as `✗`; `vx last` names the error. A failure is never a failed run.',
    ],
    example: {
      lang: 'text',
      code: "$ vx run build --all\n[vx] plugin '@vzn/vx-migrate': probe of 1 artifact at http://127.0.0.1:9/v8/artifacts failed: ECONNREFUSED: Unable to connect. Is the computer able to access the url?\n ⏺︎     9ms success miss     packages/api#build\n[vx] plugin '@vzn/vx-migrate': 1 more request failed the same way: ECONNREFUSED: Unable to connect. Is the computer able to access the url?\n  cache     ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰\n            remote 1✗\n(exit 0)",
    },
    image: 'background-uploads.png',
    imageAlt: 'Remote uploads finishing after the run, errors as warnings.',
    docs: {
      label: 'CI and remote',
      href: 'docs/ci/',
    },
    deepDive: {
      label: 'What goes into a key, and what comes back',
      href: 'blog/inside-a-cache-hit/',
    },
  },
  {
    slug: 'custom-remote-cache',
    title: 'Bring your own cache server',
    category: 'cache',
    hook: 'Plug any storage in as a remote cache through one small interface.',
    body: [
      'S3, a team server, a Redis you already run: a cache plugin connects it. The interface is `has`, `get` and `put`, with an optional `hasMany` for batches.',
      'vx handles keys, integrity and errors; a plugin only moves bytes. A server that fails degrades to a miss.',
    ],
    example: {
      lang: 'text',
      code: 'cache plugin\n  has(key)      → boolean\n  get(key)      → body | null\n  put(key, body) → void\n  hasMany(keys) → optional batch',
    },
    image: 'custom-remote-cache.png',
    imageAlt: 'A cache plugin: has, get and put.',
    docs: {
      label: 'Plugins',
      href: 'docs/plugins/',
    },
    deepDive: {
      label: 'Extend vx in an afternoon',
      href: 'blog/extend-vx/',
    },
  },
  {
    slug: 'env-isolation',
    title: 'A task sees only the env it names',
    category: 'safety',
    hook: 'Undeclared variables never reach a task, and secrets are masked in its output.',
    body: [
      'A build that reads a stray variable from your shell works on your machine and nowhere else. vx starts each task with a clean environment plus what you name.',
      '`passThrough` lets a variable in, `define` sets one, and `secret` masks a value wherever it would be printed.',
      'This keeps builds alike, not a wall: vx hides its own environment from a task (non-dumpable on Linux, zeroed for `ps eww` on macOS), but an unsandboxed task still reads any file you can. `exec.sandbox` keeps it out.',
    ],
    example: {
      lang: 'ts',
      code: "// packages/api/vx.config.ts\nimport { defineProject } from '@vzn/vx/config'\n\nexport default defineProject({\n  tasks: {\n    deploy: {\n      exec: {\n        command: './deploy.sh',\n        env: {\n          passThrough: ['DEPLOY_TOKEN'],\n          define: { NODE_ENV: 'production' },\n          secret: ['DEPLOY_TOKEN'],\n        },\n      },\n    },\n  },\n})",
    },
    image: 'env-isolation.png',
    imageAlt: 'A task with an isolated env and a masked secret.',
    docs: {
      label: 'exec.env',
      href: 'schema/',
    },
    deepDive: {
      label: 'A task sees only the env it names',
      href: 'blog/env-isolation/',
    },
  },
  {
    slug: 'project-boundaries',
    title: 'Projects stay in their lane',
    category: 'safety',
    hook: 'A project’s globs never reach into another project’s files.',
    body: [
      'A root task with `**/*.ts` as its input would sweep in every package’s sources, so any change anywhere would move its key. Bugs like that take days to find.',
      'In vx a glob stops at its project: a nested project’s files are never part of another project’s inputs. Reading another project goes through `dependsOn`, or by name with `workspaceFiles`.',
    ],
    example: {
      lang: 'text',
      code: "root project   inputs: ['**/*.ts']\n  scripts/release.ts       included\n  packages/ui/src/a.ts     not included: another project",
    },
    image: 'project-boundaries.png',
    imageAlt: 'A glob into another project refused.',
    docs: {
      label: 'Caching in depth',
      href: 'caching/',
    },
    deepDive: {
      label: 'What goes into a key, and what comes back',
      href: 'blog/inside-a-cache-hit/',
    },
  },
  {
    slug: 'artifact-integrity',
    title: 'Damaged artifacts are misses',
    category: 'safety',
    hook: 'Every artifact is checked before it is restored; damage means a rebuild, not a wrong file.',
    body: [
      'Disks flip bits, uploads get cut off. A cache that restores a damaged artifact puts broken files in your build.',
      'vx checks a CRC-32, that the artifact matches its key, and that it holds only declared outputs. Any failure is a cache miss, and the task runs.',
    ],
    example: {
      lang: 'text',
      code: 'restore @demo/web#build\n  crc32    ok\n  key      ok\n  outputs  ok   → restored\n\n(any check fails → miss, the task runs)',
    },
    image: 'artifact-integrity.png',
    imageAlt: 'Artifact checks before a restore.',
    docs: {
      label: 'Caching in depth',
      href: 'caching/',
    },
    deepDive: {
      label: 'What goes into a key, and what comes back',
      href: 'blog/inside-a-cache-hit/',
    },
  },
  {
    slug: 'sandbox-grants',
    title: 'The sandbox says what to allow',
    category: 'safety',
    hook: 'A refused write is named beside the failed task, with the line that allows it.',
    body: [
      'A sandbox that only says “permission denied” sends you hunting. vx names the path the task tried to write and the exact `allow` entry that would permit it.',
      'Copy the fix, or move the write inside the project where it belongs.',
    ],
    example: {
      lang: 'text',
      code: "vx: the sandbox refused writes outside the project, which are not reported as violations: …/packages/shared.txt. If the task needs one, grant its directory, e.g. `allow: { write: ['../'] }`.",
    },
    image: 'sandbox-grants.png',
    imageAlt: 'A sandbox refusal naming the path and the fix.',
    docs: {
      label: 'Sandboxing',
      href: 'docs/sandboxing/',
    },
    deepDive: {
      label: 'Guard rails that tell you the fix',
      href: 'blog/guard-rails/',
    },
  },
  {
    slug: 'strict-numbers',
    title: 'Numbers mean what you typed',
    category: 'safety',
    hook: 'Hex, exponents and fractions are refused, never quietly reinterpreted.',
    body: [
      '`--concurrency 0x10` or `--timeout 1e3` might parse as something you did not mean. vx refuses them and says what a valid value looks like.',
      'A mistyped flag gets the nearest real one, so `--retr` points you to `--retries`.',
    ],
    example: {
      lang: 'text',
      code: "$ vx run build --timeout 1e3\n✗ vx run  --timeout must be a duration like '500ms', '30s' or '5m', at most 24 days (got 1e3)\n\n  see vx run --help",
    },
    image: 'strict-numbers.png',
    imageAlt: 'A numeric flag in exponent form refused.',
    docs: {
      label: 'Run flags',
      href: 'cli/run/',
    },
    deepDive: {
      label: 'An upgrade you can trust',
      href: 'blog/upgrade-you-can-trust/',
    },
  },
  {
    slug: 'verified-releases',
    title: 'Releases you can verify',
    category: 'safety',
    hook: 'Binaries carry provenance, and `vx upgrade` checks npm’s registry signature on every download.',
    body: [
      'A task runner runs every command in your repo, so where its binary came from matters. vx release binaries carry build provenance, and the npm package is published with provenance.',
      '`vx upgrade` checks npm’s registry signature against a pinned key, then the SHA-512 it signed, before replacing anything.',
    ],
    example: {
      lang: 'sh',
      code: 'vx upgrade\ngh attestation verify vx-linux-x64 --repo vznjs/vx',
    },
    image: 'verified-releases.png',
    imageAlt: 'A release binary verified by its attestation.',
    docs: {
      label: 'Upgrading',
      href: 'guides/upgrading/',
    },
    deepDive: {
      label: 'An upgrade you can trust',
      href: 'blog/upgrade-you-can-trust/',
    },
  },
  {
    slug: 'interactive-tasks',
    title: 'Tasks that take the keyboard',
    category: 'daily',
    hook: 'A prompt, a REPL or a login flow gets the terminal to itself.',
    body: [
      'Some tasks ask questions: a database console, a release script that confirms, a CLI login. Framed, parallel output would break them.',
      'Mark the task `interactive` and vx hands it the terminal directly, alone, for as long as it runs.',
    ],
    example: {
      lang: 'ts',
      code: "// packages/api/vx.config.ts\nimport { defineProject } from '@vzn/vx/config'\n\nexport default defineProject({\n  tasks: {\n    console: { exec: { command: 'bun repl', interactive: true } },\n  },\n})",
    },
    image: 'interactive-tasks.png',
    imageAlt: 'An interactive task owning the terminal.',
    docs: {
      label: 'exec.interactive',
      href: 'schema/',
    },
    deepDive: {
      label: 'When a task misbehaves',
      href: 'blog/tasks-that-misbehave/',
    },
  },
  {
    slug: 'help-and-version',
    title: 'Help where you type',
    category: 'daily',
    hook: 'Every verb explains itself with `vx help`, and `vx version` says what you run.',
    body: [
      'You should not need a browser to remember a flag. `vx help run` lists every flag with a line on what it does; every verb has its own page.',
      '`vx version` prints the version, the first line of any bug report.',
    ],
    example: {
      lang: 'sh',
      code: 'vx help\nvx help run\nvx version',
    },
    image: 'help-and-version.png',
    imageAlt: 'vx help listing verbs.',
    docs: {
      label: 'Commands',
      href: 'cli/',
    },
    deepDive: {
      label: 'An upgrade you can trust',
      href: 'blog/upgrade-you-can-trust/',
    },
  },
  {
    slug: 'did-you-mean',
    title: 'Typos get an answer',
    category: 'daily',
    hook: 'A mistyped flag, verb or task gets the nearest real spelling.',
    body: [
      '`--concurency` or `tset` should not cost you a trip to the docs. vx answers with the closest flag, verb or task name.',
      'The suggestion is the fix, so you press up, correct one word, and run.',
    ],
    example: {
      lang: 'text',
      code: '$ vx run build --concurency 4\n✗ vx run  unknown flag: --concurency\n\n  see vx run --help\n\n  fix  --concurrency\n\n$ vx run tset --all\n✗ vx run  no projects declare task(s): tset\n\n  fix  test',
    },
    image: 'did-you-mean.png',
    imageAlt: 'Mistyped flags and tasks answered with the nearest spelling.',
    docs: {
      label: 'Commands',
      href: 'cli/',
    },
    deepDive: {
      label: 'The small things',
      href: 'blog/the-small-things/',
    },
  },
  {
    slug: 'task-as-verb',
    title: 'Type the task, get the command',
    category: 'daily',
    hook: '`vx build` answers with the `vx run` command that does what you meant.',
    body: [
      'Coming from npm scripts, `vx build` is a natural thing to type. vx knows `build` is a task here and prints the exact command that runs it.',
      'No guessing which flag you need: copy the line and go.',
    ],
    example: {
      lang: 'text',
      code: '$ vx build --all\n✗ vx  `build` is a task here, not a command\n\n  fix  vx run build --all',
    },
    image: 'task-as-verb.png',
    imageAlt: 'A task typed as a verb answered with the right command.',
    docs: {
      label: 'Commands',
      href: 'cli/',
    },
    deepDive: {
      label: 'The small things',
      href: 'blog/the-small-things/',
    },
  },
  {
    slug: 'one-command-tasks',
    title: 'One command per task',
    category: 'config',
    hook: 'A task is a shell command with edges and a cache block; nothing boots in between.',
    body: [
      'There is no executor layer to learn and no process per task to pay for. A task is the command you would type, plus what it depends on and what it reads and writes.',
      'Whatever your tools are, they run exactly as they do in your terminal.',
    ],
    example: {
      lang: 'ts',
      code: "// packages/api/vx.config.ts\nimport { defineProject } from '@vzn/vx/config'\n\nexport default defineProject({\n  tasks: {\n    build: {\n      exec: { command: 'tsc -b' },\n      dependsOn: ['^build'],\n      description: 'Type-check and emit',\n      inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },\n    },\n  },\n})",
    },
    image: 'one-command-tasks.png',
    imageAlt: 'A task: a command, its edges and its cache block.',
    docs: {
      label: 'Configure',
      href: 'docs/workspace/',
    },
    deepDive: {
      label: 'One command per task',
      href: 'blog/one-command-per-task/',
    },
  },
  {
    slug: 'workspace-rules',
    title: 'Rules that catch slow configs',
    category: 'config',
    hook: 'Checks for configs that would make runs slow or wrong, on by default.',
    body: [
      'Two tasks writing the same `dist/**` delete each other’s output. An input glob that reads another task’s output makes keys wait on builds. `vx lock` refuses both, with the fix; runs never check.',
      '`exclusiveOutputs` can be turned off in `.vx/workspace.ts` so a dependant adds to its upstream’s outputs. The input check has no switch.',
    ],
    example: {
      lang: 'ts',
      code: "// .vx/workspace.ts\nimport { defineWorkspace } from '@vzn/vx/config'\n\nexport default defineWorkspace({\n  run: { rules: { exclusiveOutputs: false } },\n})",
    },
    image: 'workspace-rules.png',
    imageAlt: 'Workspace rules turned on and off.',
    docs: {
      label: 'Workspace rules',
      href: 'schema/',
    },
    deepDive: {
      label: 'Guard rails that tell you the fix',
      href: 'blog/guard-rails/',
    },
  },
  {
    slug: 'config-timeout',
    title: 'A config that hangs, named',
    category: 'config',
    hook: 'A config whose evaluation runs away fails after a deadline, naming the file.',
    body: [
      'A config is code, and code can loop or wait on the network. A run that hangs at “loading” with no hint is the worst kind of bug.',
      'vx bounds each config evaluation, 30 seconds by default, and fails naming the config. `VX_CONFIG_WORKER_TIMEOUT` changes the limit.',
    ],
    example: {
      lang: 'sh',
      code: 'VX_CONFIG_WORKER_TIMEOUT=5000ms vx run build --all',
    },
    image: 'config-timeout.png',
    imageAlt: 'A stuck config failing with its name.',
    docs: {
      label: 'Environment variables',
      href: 'cli/',
    },
    deepDive: {
      label: 'Guard rails that tell you the fix',
      href: 'blog/guard-rails/',
    },
  },
  {
    slug: 'no-nested-runs',
    title: 'No runs inside runs',
    category: 'config',
    hook: 'A `vx run` inside a task of the same workspace is refused, with the reason.',
    body: [
      'A task that calls `vx run` hides its work from the graph: it escapes the schedule, the concurrency limit and the cache key, and a loop back to itself forks without end.',
      'vx marks every task it starts and refuses the nested run, pointing you at `dependsOn`.',
    ],
    example: {
      lang: 'text',
      code: '$ vx run @demo/api#nested\nvx: task @demo/api#nested runs `vx run` inside its own workspace … Declare what it needs with dependsOn instead.',
    },
    image: 'no-nested-runs.png',
    imageAlt: 'A nested vx run refused.',
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
    slug: 'typed-helpers',
    title: 'Config with autocomplete',
    category: 'config',
    hook: '`defineProject` gives you completion and errors while you type.',
    body: [
      'A YAML or JSON config tells you about a typo when the run fails. A typed config tells you in the editor.',
      '`defineProject` and `defineWorkspace` type every key, so wrong keys and wrong value types are underlined before you save.',
    ],
    example: {
      lang: 'ts',
      code: "// packages/app/vx.config.ts\nimport { defineProject } from '@vzn/vx/config'\n\nexport default defineProject({\n  tasks: {\n    build: { exec: { command: 'tsc -b' } },\n    test: { exec: { command: 'vitest run' }, dependsOn: ['build'] },\n  },\n})",
    },
    image: 'typed-helpers.png',
    imageAlt: 'A typed vx.config.ts with completion.',
    docs: {
      label: 'Configure',
      href: 'docs/workspace/',
    },
    deepDive: {
      label: 'Config in TypeScript',
      href: 'blog/config-in-typescript/',
    },
  },
  {
    slug: 'presets',
    title: 'Presets are plain functions',
    category: 'config',
    hook: 'Share task setups across projects with a TypeScript function, no new concept.',
    body: [
      'Twenty libraries with the same build should not mean twenty copies of it. Write a function that returns the tasks and call it in each config.',
      'It is plain TypeScript: parameters, imports and types all work, and the key sees the evaluated result.',
    ],
    example: {
      lang: 'ts',
      code: "// packages/ui/vx.config.ts\nimport { defineProject } from '@vzn/vx/config'\n\nconst lib = (entry: string) => ({\n  build: {\n    exec: { command: `tsup ${entry}` },\n    inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },\n  },\n})\n\nexport default defineProject({ tasks: { ...lib('src/index.ts') } })",
    },
    image: 'presets.png',
    imageAlt: 'A preset function shared across configs.',
    docs: {
      label: 'Configure',
      href: 'docs/workspace/',
    },
    deepDive: {
      label: 'Config in TypeScript',
      href: 'blog/config-in-typescript/',
    },
  },
  {
    slug: 'config-errors',
    title: 'Config errors that point',
    category: 'config',
    hook: 'A bad config fails at load with the file, the line and the key, no stack trace.',
    body: [
      'A stack trace from inside a tool tells you nothing about your config. vx shows the line in your file, a caret under the value and what it should be.',
      'Fix it and run again; nothing ran with the broken config.',
    ],
    example: {
      lang: 'text',
      code: "$ vx lock\n✗ vx lock  lock not written\n\n  packages/api/vx.config.ts:4:42\n  tasks.hang.exec.timeout must be a duration like '500ms', '30s' or '5m', at most 24 days (got \"soon\")\n\n  > 4 |     hang: { exec: { command: 'sleep 30', timeout: 'soon' } },\n      |                                          ^",
    },
    image: 'config-errors.png',
    imageAlt: 'A config error pointing at the line and key.',
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
    slug: 'ref-cache-scope',
    title: 'Cache scope from the branch',
    category: 'ci',
    hook: 'On Actions, plugin entries follow the branch, and a bare `--affected` compares with the PR’s base.',
    body: [
      'Plugins keep their own entries in the cache (run timings, for one). On GitHub Actions, `@vzn/vx-ci` scopes them by branch: none on the default branch or a merge queue, `acme/app:feat-x` on a push or pull request from `feat-x`. A bare `--affected` compares with the pull request’s base commit. `gitlab()` does the same on GitLab CI, merge trains included. Task entries never carry a scope: the cache server decides where they land.',
      'No config needed; `VX_CACHE_SCOPE` overrides it.',
    ],
    example: {
      lang: 'ts',
      code: "// .vx/workspace.ts\nimport { defineWorkspace } from '@vzn/vx/config'\nimport { github } from '@vzn/vx-ci'\n\nexport default defineWorkspace({\n  plugins: [github({ cacheScope: true })],\n})",
    },
    image: 'ref-cache-scope.png',
    imageAlt: 'Cache scope taken from the branch on Actions.',
    docs: {
      label: 'CI and remote',
      href: 'docs/ci/',
    },
    deepDive: {
      label: 'The cache on your terms',
      href: 'blog/the-cache-on-your-terms/',
    },
  },
  {
    slug: 'keep-remote-cache',
    title: 'Keep your Turbo or Nx remote cache',
    category: 'adoption',
    hook: 'Point vx at the remote cache server you already run.',
    body: [
      'Switching runners should not mean switching cache servers. `turboCache()` talks to any server with Turbo’s artifacts API, Vercel’s included, and `nxCache()` to Nx’s self-hosted cache spec.',
      'Your server stays; vx stores its own entries in it. `turboCache()` names the run’s refs on every read (`x-artifact-read-scopes`), so a server that keeps one cache per branch knows which to read; where a write lands stays the server’s call. `nxCache()` sends plain requests.',
    ],
    example: {
      lang: 'ts',
      code: "// .vx/workspace.ts\nimport { defineWorkspace } from '@vzn/vx/config'\nimport { turboCache } from '@vzn/vx-migrate'\n\nexport default defineWorkspace({ plugins: [turboCache()] })",
    },
    image: 'keep-remote-cache.png',
    imageAlt: 'vx using an existing Turbo remote cache.',
    docs: {
      label: 'Migrate',
      href: 'guides/migrate/',
    },
    deepDive: {
      label: 'Moving to vx from Nx: keep the graph, drop the platform',
      href: 'blog/from-nx/',
    },
  },
  {
    slug: 'npm-hooks',
    title: 'pre and post scripts kept',
    category: 'adoption',
    hook: '`prebuild` and `postbuild` fold into `build` when `@vzn/vx-migrate` maps your scripts.',
    body: [
      'npm calls `prebuild` and `postbuild` around `build` without being asked. A migration that drops them changes what your build does.',
      '`@vzn/vx-migrate` folds them into the task’s command in that order, and says so in its report.',
    ],
    example: {
      lang: 'text',
      code: 'package.json   prebuild: rimraf dist · build: tsc · postbuild: node scripts/copy.js\nvx.config.ts   build: one command that runs prebuild, build, then postbuild',
    },
    image: 'npm-hooks.png',
    imageAlt: 'npm pre and post scripts folded into one task.',
    docs: {
      label: 'Migrate',
      href: 'guides/migrate/',
    },
    deepDive: {
      label: 'From npm scripts or Vite Task',
      href: 'blog/from-scripts-and-vite-task/',
    },
  },
  {
    slug: 'vite-task-adoption',
    title: 'Coming from Vite Task',
    category: 'adoption',
    hook: 'vx-migrate writes configs from vite-plus `run.tasks`, as it does from Turbo and Nx.',
    body: [
      'If your tasks live in vite-plus’s `run.tasks`, you do not have to retype them. `@vzn/vx-migrate --from vite-task` writes a `vx.config.ts` per package from them.',
      'Preview first with `--dry`; it never overwrites without `--force`.',
    ],
    example: {
      lang: 'sh',
      code: 'bunx @vzn/vx-migrate --from vite-task --dry\nbunx @vzn/vx-migrate --from vite-task',
    },
    image: 'vite-task-adoption.png',
    imageAlt: 'vx configs written from Vite Task’s run.tasks.',
    docs: {
      label: 'Migrate',
      href: 'guides/migrate/',
    },
    deepDive: {
      label: 'From npm scripts or Vite Task',
      href: 'blog/from-scripts-and-vite-task/',
    },
  },
  {
    slug: 'nx-exec',
    title: 'Nx executors, one process each',
    category: 'adoption',
    hook: 'Any Nx executor runs as one vx task with its Nx environment set.',
    body: [
      'Some Nx targets use executors with no plain command behind them. You can keep them while you migrate.',
      'The generated task calls `nx-exec`, which runs the executor through Nx’s public API in one process, so it works as it did under Nx.',
    ],
    example: {
      lang: 'text',
      code: 'project.json   build: { executor: "@nx/js:tsc", options: { … } }\nvx.config.ts   build: { exec: { command: "nx-exec @nx/js:tsc --project ui --target build …" } }',
    },
    image: 'nx-exec.png',
    imageAlt: 'An Nx executor target run as one vx task.',
    docs: {
      label: 'Migrate',
      href: 'guides/migrate/',
    },
    deepDive: {
      label: 'Moving to vx from Nx: keep the graph, drop the platform',
      href: 'blog/from-nx/',
    },
  },
  {
    slug: 'programmatic-api',
    title: 'vx from your own scripts',
    category: 'adoption',
    hook: 'Plan or run tasks from TypeScript with `run` and `planRun`.',
    body: [
      'A release script or a bot may want to know what would run before it runs anything. `@vzn/vx` exports the same planner and runner the CLI uses.',
      'Same inputs, same keys, same result as the command line.',
    ],
    example: {
      lang: 'ts',
      code: "// scripts/plan.ts\nimport { planRun } from '@vzn/vx'\n\nconst plan = await planRun({ cwd: process.cwd(), tasks: ['build'], projects: ['@demo/web'] })\nconsole.log(plan)",
    },
    image: 'programmatic-api.png',
    imageAlt: 'planRun called from a script.',
    docs: {
      label: '@vzn/vx API',
      href: 'api/',
    },
    deepDive: {
      label: 'Extend vx in an afternoon',
      href: 'blog/extend-vx/',
    },
  },
  {
    slug: 'local-floor',
    title: 'This machine is always the last stop',
    category: 'extend',
    hook: 'Running and caching locally are built in, so a declined plugin hands work back, never drops it.',
    body: [
      'Plugins decide where a task runs and where its artifacts live. If a remote executor declines a task, or a remote cache is down, the work must still happen.',
      'vx puts the local executor and the local cache at the end of every list, so there is always somewhere to run and cache.',
    ],
    example: {
      lang: 'text',
      code: 'executors: [ reapi, …, local ]\ncache:     [ turboCache, …, local cache ]',
    },
    image: 'local-floor.png',
    imageAlt: 'The local executor and cache at the end of every list.',
    docs: {
      label: 'Plugins',
      href: 'docs/plugins/',
    },
    deepDive: {
      label: 'Running here is not a plugin',
      href: 'blog/the-local-floor/',
    },
  },
  {
    slug: 'vx-history',
    title: 'What the scheduler learned',
    category: 'extend',
    hook: '`vx history` shows each task’s typical time, peak memory and CPU from past runs.',
    body: [
      'The history plugin learns from every run. `vx history` shows what it knows: median time, peak memory, CPU use and how much memory it reserves for each task.',
      'Use it to find the slow tasks and the heavy ones.',
    ],
    example: {
      lang: 'text',
      code: '$ vx history\n  task              runs      p50  peak rss\n  @demo/web#test       5    203ms    587 MB',
    },
    image: 'vx-history.png',
    imageAlt: 'vx history listing what each task costs.',
    docs: {
      label: 'Plugins',
      href: 'docs/plugins/',
    },
    deepDive: {
      label: 'A scheduler that learns from your runs',
      href: 'blog/a-scheduler-that-learns/',
    },
  },
  {
    slug: 'setup-teardown',
    title: 'Code around the run',
    category: 'extend',
    hook: 'A plugin can start something before the run and clean up after, within a deadline.',
    body: [
      'Some runs need a service up first: a database, a local registry, a proxy. A plugin’s `setup` runs before the first task and `teardown` after the last.',
      'Both are bounded by a timeout, so a stuck teardown never holds the run open.',
    ],
    example: {
      lang: 'text',
      code: 'setup()     → before the first task\n  … the run …\nteardown()  → after the last task, bounded by a timeout',
    },
    image: 'setup-teardown.png',
    imageAlt: 'Plugin setup and teardown around a run.',
    docs: {
      label: 'Plugins',
      href: 'docs/plugins/',
    },
    deepDive: {
      label: 'Extend vx in an afternoon',
      href: 'blog/extend-vx/',
    },
  },
  {
    slug: 'reapi-tls',
    title: 'Hosted remote servers, Bazel-style',
    category: 'extend',
    hook: 'TLS, mutual TLS and auth headers connect vx to servers such as BuildBuddy.',
    body: [
      'Hosted build servers want TLS and an API key. `@vzn/vx-reapi` speaks to them the way Bazel does: system roots or your CA, a client certificate for mutual TLS, and headers.',
      'An endpoint with no scheme uses TLS; plaintext needs `grpc://` on purpose.',
    ],
    example: {
      lang: 'ts',
      code: "// .vx/workspace.ts\nimport { defineWorkspace } from '@vzn/vx/config'\nimport { reapi } from '@vzn/vx-reapi'\n\nexport default defineWorkspace({\n  plugins: [reapi({\n      endpoint: 'remote.buildbuddy.io',\n      headers: { 'x-buildbuddy-api-key': process.env['BB_KEY'] ?? '' },\n      execute: true,\n    })],\n})",
    },
    image: 'reapi-tls.png',
    imageAlt: 'A REAPI plugin connected to a hosted server.',
    docs: {
      label: 'Remote execution',
      href: 'docs/ci/',
    },
    deepDive: {
      label: 'A remote server you can trust in production',
      href: 'blog/reapi-in-production/',
    },
  },
  {
    slug: 'reapi-action-cache',
    title: 'Remote runs that never repeat',
    category: 'extend',
    hook: 'A remote action that already ran replays its outputs and log, without a worker.',
    body: [
      'Remote execution costs worker time. When the same action already ran, the server has its result.',
      'vx asks the action cache first; a hit replays the outputs and stdout, and no worker is booked.',
    ],
    example: {
      lang: 'text',
      code: 'execute @demo/web#build\n  action cache  hit → outputs and stdout replayed\n  worker        not used',
    },
    image: 'reapi-action-cache.png',
    imageAlt: 'A repeat remote action served from the action cache.',
    docs: {
      label: 'Remote execution',
      href: 'docs/ci/',
    },
    deepDive: {
      label: 'A remote server you can trust in production',
      href: 'blog/reapi-in-production/',
    },
  },
  {
    slug: 'reapi-safety',
    title: 'A wedged server is only a miss',
    category: 'extend',
    hook: 'Downloads are verified and calls have deadlines, so a bad server never hangs a run.',
    body: [
      'A remote server can return a corrupt blob or stop answering. vx checks every download against its digest and gives every call a deadline.',
      'A failure becomes a cache miss and the task runs, here if need be.',
    ],
    example: {
      lang: 'text',
      code: 'download sha256:4f2a…  digest mismatch  → miss, the task runs\nGetActionResult       deadline passed  → miss, the task runs',
    },
    image: 'reapi-safety.png',
    imageAlt: 'Corrupt blobs and slow calls degrading to a miss.',
    docs: {
      label: 'Remote execution',
      href: 'docs/ci/',
    },
    deepDive: {
      label: 'A remote server you can trust in production',
      href: 'blog/reapi-in-production/',
    },
  },
  {
    slug: 'remote-install',
    title: 'node_modules for stateless workers',
    category: 'extend',
    hook: 'Run the install as a remote action, so every worker has `node_modules` without a shared disk.',
    body: [
      "Remote workers start empty. Mark the install task `remote: 'only'` and it runs as a remote action whose output is `node_modules`.",
      'Every task that depends on it gets that tree as an input, cached by the lockfile.',
    ],
    example: {
      lang: 'ts',
      code: "// packages/api/vx.config.ts\nimport { defineProject } from '@vzn/vx/config'\n\nexport default defineProject({\n  tasks: {\n    install: {\n      exec: { command: 'bun install --frozen-lockfile', remote: 'only' },\n      inputs: { files: ['package.json', 'bun.lock'] },\n      cache: { outputs: { files: ['node_modules/**'] } },\n    },\n  },\n})",
    },
    image: 'remote-install.png',
    imageAlt: 'An install task run as a remote action.',
    docs: {
      label: 'Remote execution',
      href: 'docs/ci/',
    },
    deepDive: {
      label: 'Remote execution without moving the scheduler',
      href: 'blog/remote-execution/',
    },
  },
  {
    slug: 'otel-live',
    title: 'Watch CI while it runs',
    category: 'extend',
    hook: 'Spans and metrics stream as tasks end, so a dashboard follows the run live.',
    body: [
      'A trace that arrives when the run is over cannot tell you what is slow right now. `@vzn/vx-otel` exports each task as it ends.',
      'It is on by default; `otel({ live: false })` sends everything at the end instead.',
    ],
    example: {
      lang: 'ts',
      code: "// .vx/workspace.ts\nimport { defineWorkspace } from '@vzn/vx/config'\nimport { otel } from '@vzn/vx-otel'\n\nexport default defineWorkspace({\n  plugins: [otel({ live: true })],\n})",
    },
    image: 'otel-live.png',
    imageAlt: 'Spans streaming to a dashboard during a run.',
    docs: {
      label: 'OpenTelemetry',
      href: 'docs/ci/',
    },
    deepDive: {
      label: 'Watch a CI run while it runs',
      href: 'blog/otel-live/',
    },
  },
  {
    slug: 'memory-admission',
    title: 'Tasks packed by memory',
    category: 'extend',
    hook: 'The history plugin admits tasks by the peak memory they used before, so a run never runs out.',
    body: [
      'Eight test runners at 2 GB each will not fit on a 13 GB runner. Counting cores is not enough.',
      '`@vzn/vx-history` remembers each task’s peak memory and starts a task only when its share fits.',
    ],
    example: {
      lang: 'ts',
      code: "// .vx/workspace.ts\nimport { defineWorkspace } from '@vzn/vx/config'\nimport { vxHistory } from '@vzn/vx-history'\n\nexport default defineWorkspace({\n  plugins: [vxHistory()],\n})",
    },
    image: 'memory-admission.png',
    imageAlt: 'Tasks admitted against learned peak memory.',
    docs: {
      label: 'Plugins',
      href: 'docs/plugins/',
    },
    deepDive: {
      label: 'A scheduler that learns from your runs',
      href: 'blog/a-scheduler-that-learns/',
    },
  },
]
