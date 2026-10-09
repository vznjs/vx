// Every feature the site gives a page of its own (`/features/<slug>/`), in
// the order the hub lists them. The copy is the 38-day campaign's, rewritten
// as page copy and checked against core's source and docs (cli.md,
// schema.md), then the rest of features.md (more.ts). Links are under the site's base (`guides/ci/`) or absolute
// (`https://…`). `image` names a file in src/assets/features/; the four
// small things one post showed share its image.
//
// Benchmark figures here are hand-copied from README.md's generated table:
// update-site.ts does not rewrite this file, so a new results.json run
// must be carried here too.

import { MORE } from './more.js'

export type CategoryId =
  | 'speed'
  | 'cache'
  | 'safety'
  | 'run'
  | 'output'
  | 'insight'
  | 'config'
  | 'daily'
  | 'ci'
  | 'adoption'
  | 'extend'

export interface Category {
  id: CategoryId
  title: string
  line: string
  /** Two or three sentences: the category page's opening. */
  intro: string
}

// A category's page (features/<id>/) leads with its first two features in
// FEATURES order as large tiles, so that order is also the emphasis.
export const CATEGORIES: readonly Category[] = [
  {
    id: 'speed',
    title: 'Speed',
    line: 'Faster on every run, cold or cached.',
    intro:
      'vx adds as little as it can around your commands. Keys come from git’s own index, and nothing stays running between runs.',
  },
  {
    id: 'cache',
    title: 'Cache you can trust',
    line: 'A hit replays exactly what a run would have made.',
    intro:
      'A cache is only worth having if a hit is the same as a run. vx keys every task on what it reads, restores exactly what it wrote, and treats anything it cannot vouch for as a miss.',
  },
  {
    id: 'safety',
    title: 'Correct by default',
    line: 'Nothing leaks in, nothing wrong comes back.',
    intro:
      'The worst build is a green one with the wrong bytes. vx keeps each task to the environment and the files it names, and checks what it stores and what it ships.',
  },
  {
    id: 'run',
    title: 'Run what you mean',
    line: 'Pick tasks precisely, and stop the ones that hang.',
    intro:
      'Say which tasks to run, by name, tag or folder, and vx runs exactly those and what they need. A typo is caught before anything starts, and a task that hangs is stopped.',
  },
  {
    id: 'output',
    title: 'Output that fits',
    line: 'As much as you want to read, where you read it.',
    intro:
      'A run prints what you need and keeps the rest. Pick how much you see, get a table, a report for your pull request or plain JSON, and find a failure again later.',
  },
  {
    id: 'insight',
    title: 'See inside a run',
    line: 'Every key, plan and past run, on request.',
    intro:
      'Ask vx why a task ran, what a run would do, or where the time went, and get an answer you can read or a JSON value an agent can use.',
  },
  {
    id: 'config',
    title: 'Config',
    line: 'TypeScript you can read, with errors that point.',
    intro:
      'Config is TypeScript: one command per task, helpers you can import, and rules that catch a slow setup. When it is wrong, the error points at the line.',
  },
  {
    id: 'daily',
    title: 'Everyday use',
    line: 'The small things you meet every day.',
    intro:
      'The parts you touch every day: a picker when you forget a name, a summary you read at a glance, watch mode, dev servers, and Ctrl-C that leaves nothing behind.',
  },
  {
    id: 'ci',
    title: 'CI',
    line: 'Run less, and read the result where you work.',
    intro:
      'In CI, vx runs only what a change reaches, pins the plan with a lock, flags flaky tasks, and puts the result on the pull request.',
  },
  {
    id: 'adoption',
    title: 'Adoption',
    line: 'From install to cached in minutes.',
    intro:
      'Start from one binary or one npm package. `vx init` reads a Turborepo or Nx repo and writes the config, and your remote cache keeps working.',
  },
  {
    id: 'extend',
    title: 'Plugins',
    line: 'Seams for where tasks run, cache and report.',
    intro:
      'vx is a pipeline with seams. A plugin decides where a task runs, where its outputs live and who hears about it, from remote execution to OpenTelemetry and MCP.',
  },
]

export interface Link {
  label: string
  href: string
}

export interface Feature {
  slug: string
  title: string
  category: CategoryId
  /** One sentence: the card's line and the page's lede. */
  hook: string
  /** Two to four short paragraphs; `code` spans in backticks. */
  body: readonly string[]
  example: { lang: 'sh' | 'ts' | 'text'; code: string }
  image: string
  imageAlt: string
  docs: Link
  deepDive?: Link
}

const workspace = (pkg: string, call: string): string => `// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx/config'
import { ${call.slice(0, call.indexOf('('))} } from '${pkg}'

export default defineWorkspace({
  plugins: [${call}],
})`

const FIRST: readonly Feature[] = [
  // ---- Speed ----
  {
    slug: 'fastest',
    title: 'The fastest task runner',
    category: 'speed',
    hook: 'The least overhead on a cached run: 10% less than Turborepo, 27× less than Nx.',
    body: [
      'vx is measured on a synthetic workspace of 1,601 projects and 9,603 tasks in 30 dependency levels, against Turborepo, Nx and Vite Task. Each tool runs in its own native config, with the same graph, the same commands and the same concurrency. Every number is the time a tool adds over the ideal run.',
      'With nothing changed, vx adds 958 ms, Turborepo 1.05 s, Vite Task 12.24 s and Nx 25.96 s. On a cold build vx adds 8.99 s, 12% less than Turborepo and 8.1× less than Nx.',
      'Benchmark workload: a synthetic monorepo of 1,601 projects and 9,603 tasks in 30 dependency levels, five core libraries a quarter of the projects use; build 1 s, test and typecheck 0.5 s, lint 0.25 s, publish 0.1 s; real repos with uneven task times will differ.',
      'The benchmarks page shows every row, including the ones vx loses: Vite Task adds less on a cold build and a core edit, and Turborepo less on a leaf edit. The harness lives in the repo, so you can run it yourself.',
    ],
    example: { lang: 'sh', code: 'npm install -D @vzn/vx\nnpx vx run build --all' },
    image: 'fastest.png',
    imageAlt:
      'Time added over the ideal run with nothing changed, 9,603 tasks: vx 958 ms, Turborepo 1.05 s, Vite Task 12.24 s, Nx 25.96 s.',
    docs: { label: 'The numbers', href: 'benchmarks/' },
    deepDive: { label: 'Honest benchmarks', href: 'blog/honest-benchmarks/' },
  },
  {
    slug: 'keys-from-git',
    title: 'Cache keys from git’s index',
    category: 'speed',
    hook: 'On a clean tree, vx keys your tasks without reading your sources.',
    body: [
      'A cache key needs a hash of every input file. Git already keeps one for every tracked file in its index, so vx walks the index once per run and builds keys from those hashes.',
      'Only files that are modified or untracked are read and hashed. On a clean checkout that is none of them, which is why keying thousands of tasks takes milliseconds.',
      'No daemon keeps this warm between runs. The work is small enough to do from scratch every time.',
    ],
    example: {
      lang: 'sh',
      code: 'VX_TIMING=1 vx run build --all   # the stage table shows where the time went',
    },
    image: 'keys-from-git.png',
    imageAlt: 'Cache keys built from the blob hashes in git’s index.',
    docs: { label: 'Why vx is fast', href: 'concepts/why-vx-is-fast/' },
    deepDive: { label: 'Keys from git', href: 'blog/keys-from-git/' },
  },
  {
    slug: 'no-daemon',
    title: 'No daemon',
    category: 'speed',
    hook: 'Nothing runs in the background, so nothing goes stale or needs a reset.',
    body: [
      'A daemon is a second copy of the truth: a graph that is stale after a branch switch, a socket that died, a cache you reset by hand. vx has none and will not grow one.',
      'Every run starts cold and reads the workspace as it is. With nothing changed across 9,603 tasks it adds 958 ms over the ideal run, where Nx, whose daemon is on by default, adds 25.96 s.',
    ],
    example: { lang: 'sh', code: 'git switch feature\nvx run test --all   # no daemon to restart' },
    image: 'no-daemon.png',
    imageAlt: 'vx starts cold on every run, with no background process.',
    docs: { label: 'Why vx is fast', href: 'concepts/why-vx-is-fast/' },
    deepDive: { label: 'Why no daemon', href: 'blog/no-daemon/' },
  },
  {
    slug: 'concurrency',
    title: 'Concurrency as a share of your CPUs',
    category: 'speed',
    hook: '`--concurrency 50%` means half your cores, on any machine.',
    body: [
      'By default vx runs as many tasks at once as you have cores, capped by a container’s CPU quota. `--concurrency` takes a count or a percentage, so one CI config fits runners of any size.',
      'Cache restores are disk work, not CPU work. They run on their own lane, up to twice the limit, so a warm run is not held back by the cap you set for builds.',
    ],
    example: { lang: 'sh', code: 'vx run build --all --concurrency 50%' },
    image: 'small-things.png',
    imageAlt: 'Four small vx conveniences, among them --concurrency 50%.',
    docs: { label: 'vx run flags', href: 'cli/#flags' },
  },

  // ---- Cache you can trust ----
  {
    slug: 'strict-outputs',
    title: 'Outputs are exactly the snapshot',
    category: 'cache',
    hook: 'A module you deleted never comes back from the cache.',
    body: [
      'Many monorepo caches restore files on top of what is already there. Delete a module, get a hit, and the old file is still in `dist/`.',
      'vx owns a task’s declared outputs. It wipes them before the task runs and before it restores a hit, so after either one the output directory holds the cached snapshot and nothing else.',
    ],
    example: {
      lang: 'ts',
      code: `// packages/web/vx.config.ts
import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    build: {
      exec: { command: 'vite build' },
      cache: {
        inputs: { files: ['src/**', 'index.html'] },
        outputs: { files: ['dist/**'] }, // wiped before run and restore
      },
    },
  },
})`,
    },
    image: 'strict-outputs.png',
    imageAlt: 'After a cache hit, dist/ holds exactly the cached files.',
    docs: { label: 'Caching in depth', href: 'caching/' },
    deepDive: { label: 'Strict output ownership', href: 'blog/strict-output-ownership/' },
  },
  {
    slug: 'sandbox',
    title: 'Sandboxed tasks',
    category: 'cache',
    hook: 'An undeclared read or write fails the task and names the path.',
    body: [
      'Declared inputs can be wrong. A task reads a file it never named, the key never sees it, and a later hit replays output built from something else.',
      'Add `sandbox` to a task and vx enforces the declaration. The task sees only the workspace files it was granted; a read or write of its own files that it did not declare fails the task and names the path, and a failed task is never cached.',
      'It is opt-in per task, local and free: bubblewrap on Linux, the system sandbox on macOS.',
    ],
    example: {
      lang: 'ts',
      code: `// packages/app/vx.config.ts
import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    build: {
      exec: {
        command: 'vite build',
        sandbox: { allow: { read: ['.'], write: ['dist/**'] } },
      },
      cache: {
        inputs: { files: ['src/**', 'index.html'] },
        outputs: { files: ['dist/**'] },
      },
    },
  },
})`,
    },
    image: 'sandbox.png',
    imageAlt: 'A sandboxed task fails on a write it did not declare, naming the path.',
    docs: { label: 'Sandboxing', href: 'guides/sandboxing/' },
    deepDive: { label: 'The sandbox', href: 'blog/the-sandbox/' },
  },
  {
    slug: 'typescript-config',
    title: 'Config in TypeScript, keyed as evaluated',
    category: 'cache',
    hook: 'Change a shared preset and exactly the tasks that use it re-run.',
    body: [
      'A JSON config is data, so a tool can only hash the file. `vx.config.ts` is a program: it imports presets, reads env vars and computes values.',
      'vx evaluates it and keys each task on the resolved object. Edit a preset that ten packages import and those ten packages’ tasks re-key; a config that evaluates to the same task keeps its key.',
    ],
    example: {
      lang: 'ts',
      code: `// packages/web/vx.config.ts
import { defineProject } from '@vzn/vx/config'
import { viteBuild } from '@acme/vx-presets' // your own shared preset

export default defineProject({
  tasks: { build: viteBuild({ outDir: 'dist' }) },
})`,
    },
    image: 'typescript-config.png',
    imageAlt: 'A preset imported by several configs; the key sees the evaluated task.',
    docs: { label: 'Configure', href: 'guides/configure/' },
    deepDive: { label: 'Resolved-config hashing', href: 'blog/resolved-config-hashing/' },
  },
  {
    slug: 'lockfile-keys',
    title: 'Lockfile-aware keys',
    category: 'cache',
    hook: 'A dependency bump re-runs the projects that use it, not the whole repo.',
    body: [
      'Hash the whole lockfile into every key and any `install` that touches it busts every cached task.',
      '`@vzn/vx-lockfile` keys each project on its own resolved dependency closure. Bump a test utility one package uses, and only that package’s tasks re-run. `--affected` follows the same closure.',
      'It reads pnpm, Bun, npm and Yarn lockfiles.',
    ],
    example: {
      lang: 'ts',
      code: workspace('@vzn/vx-lockfile', 'pnpm()').replace(
        "from '@vzn/vx-lockfile'",
        "from '@vzn/vx-lockfile' // or bun, npm, yarn",
      ),
    },
    image: 'lockfile-keys.png',
    imageAlt: 'A lockfile change re-keys only the projects whose dependencies moved.',
    docs: { label: 'Lockfiles', href: 'guides/configure/#lockfiles' },
    deepDive: { label: 'Lockfile-aware keys', href: 'blog/lockfile-aware-keys/' },
  },

  // ---- See inside a run ----
  {
    slug: 'vx-why',
    title: 'vx why',
    category: 'insight',
    hook: 'Ask why a task re-ran, and get the input that changed.',
    body: [
      '“Why did this re-run?” is the most expensive question in a monorepo. vx records every part of every cache key on a miss, so it can answer it.',
      '`vx why` compares a task’s latest run with the one before and names what moved: a file, an env var, a config value or an upstream task’s key, and points you up the chain.',
    ],
    example: { lang: 'sh', code: 'vx why app#build' },
    image: 'vx-why.png',
    imageAlt: 'vx why app#build naming the one input that changed.',
    docs: { label: 'vx why', href: 'cli/#vx-why' },
    deepDive: { label: 'Why did this re-run?', href: 'blog/why-did-this-rerun/' },
  },
  {
    slug: 'dry-run',
    title: 'Plan before you run',
    category: 'insight',
    hook: 'Hit or miss for every task, before anything executes.',
    body: [
      'A task’s key folds in its dependencies’ input keys, never their outputs. So every key in the graph is known before the first task starts.',
      '`--dry` builds the graph, computes the keys and asks the cache. It lists what would hit and what would run, with a predicted wall time from past runs. Nothing executes.',
    ],
    example: {
      lang: 'text',
      code: `$ vx run ci --dry
would run:
  ◉  web#lint   cache hit (local)         d66cfed2
  ▶  web#test   cache miss — would exec   68595e49  ~72.64s

2 task(s) planned, 1 cache hit (1 local), 1 would run.`,
    },
    image: 'dry-run.png',
    imageAlt: 'vx run --dry listing predicted hits and misses.',
    docs: { label: 'Planning mode', href: 'cli/#planning-mode---dry---graph' },
    deepDive: { label: 'Cascade through inputs', href: 'blog/cascade-through-inputs/' },
  },
  {
    slug: 'vx-show',
    title: 'vx show',
    category: 'insight',
    hook: 'The task exactly as a run sees it, after every preset and plugin.',
    body: [
      '`vx show web#build` prints the resolved task: command, dependencies, inputs, outputs and env. Configs load through the same path a run uses, plugins included.',
      '`vx show --affected` lists what your branch reaches, and `--format json` gives scripts the same answer.',
    ],
    example: { lang: 'sh', code: 'vx show web#build\nvx show --affected --format json' },
    image: 'vx-show.png',
    imageAlt: 'vx show printing a resolved task.',
    docs: { label: 'vx show', href: 'cli/#vx-show' },
  },
  {
    slug: 'vx-last',
    title: 'vx last',
    category: 'insight',
    hook: 'Replay the last run’s summary, failures first, without running anything.',
    body: [
      'Scrolled past the failure? `vx last` replays the latest run from local history: failures first, then what ran, with each task’s peak memory and CPU.',
      'Nothing re-runs. `vx last --list` shows recent runs, `--failed` replays the latest red one, `--log <task>` prints one task’s output, and a replayed failure ends with the command that re-runs it.',
    ],
    example: {
      lang: 'sh',
      code: 'vx last\nvx last --list\nvx last --failed\nvx last --log app#test',
    },
    image: 'vx-last.png',
    imageAlt: 'vx last replaying a run with peak memory and CPU per task.',
    docs: { label: 'vx last', href: 'cli/#vx-last' },
  },
  {
    slug: 'profile',
    title: 'Your build as a trace',
    category: 'insight',
    hook: '`--profile` writes a Chrome trace of the run.',
    body: [
      'Add `--profile` to any run and vx writes a Chrome-trace JSON of every task’s span.',
      'Open it in Perfetto or `chrome://tracing` to see each task on its worker lane, and where the run waited.',
    ],
    example: { lang: 'sh', code: 'vx run build --all --profile=build.json' },
    image: 'profile.png',
    imageAlt: 'A vx run as a timeline of tasks on worker lanes.',
    docs: { label: '--profile', href: 'cli/#run-artifacts---summarize---profile' },
  },

  // ---- Everyday use ----
  {
    slug: 'task-picker',
    title: 'The task picker',
    category: 'daily',
    hook: 'Type `vx run` with no task and pick one from a menu.',
    body: [
      'In a terminal, `vx run` with no task name lists every task in the workspace with its description. Type a number and it runs.',
      'Without a terminal, as in CI, it does not wait on a prompt: it exits at once and lists the task names.',
    ],
    example: { lang: 'sh', code: 'vx run' },
    image: 'task-picker.png',
    imageAlt: 'A numbered menu of the workspace’s tasks with descriptions.',
    docs: { label: 'vx run', href: 'cli/#vx-run' },
  },
  {
    slug: 'framed-output',
    title: 'Framed output',
    category: 'daily',
    hook: 'Sixteen tasks in parallel, and no interleaved lines.',
    body: [
      'Each task’s output is held until the task ends, then printed in its own frame: the command, its output and the verdict.',
      'No prefix on every line, so what you copy is what the tool printed. A single task you asked for streams live instead.',
    ],
    example: { lang: 'sh', code: 'vx run test --all' },
    image: 'framed-output.png',
    imageAlt: 'Parallel task output printed in separate frames.',
    docs: { label: 'Output format', href: 'cli/#output-format' },
  },
  {
    slug: 'run-summary',
    title: 'A summary you read at a glance',
    category: 'daily',
    hook: 'Every run ends with one block, and nothing prints below it.',
    body: [
      'The end of a run is a footer: projects, tasks and cache as meters, the spread of task times, and the run in one line.',
      'It is always the last word. Warnings and notes about the run print above it, so you never scroll for the verdict.',
    ],
    example: { lang: 'text', code: 'result    3 tasks · all cached · 40ms' },
    image: 'run-summary.png',
    imageAlt: 'The run footer with meters for projects, tasks and cache.',
    docs: { label: 'Output format', href: 'cli/#output-format' },
  },
  {
    slug: 'skipped-blockers',
    title: 'Every skip names its blocker',
    category: 'daily',
    hook: 'No mystery “skipped” count on a red run.',
    body: [
      'When a run goes red, every task that never started gets its own row naming the failure that blocked it.',
      'The cause is followed through a chain of skips to the failure at its root, so the footer’s skipped count always has names above it.',
    ],
    example: {
      lang: 'text',
      code: ` ⊘         skipped          app#build • blocked by lib#build
 ⊘         skipped          web#build • blocked by lib#build`,
    },
    image: 'skipped-blockers.png',
    imageAlt: 'Skipped tasks, each naming the failed task that blocked it.',
    docs: { label: 'Output format', href: 'cli/#output-format' },
  },
  {
    slug: 'dev-servers',
    title: 'Dev servers in the graph',
    category: 'daily',
    hook: 'A server is ready when it prints a line, not after `sleep 5`.',
    body: [
      'End-to-end tests need the dev server up first, and most setups sleep and hope.',
      'In vx a dev server is a persistent task. `readyWhen` is a pattern matched against each line it prints; when it matches, the tasks that depend on the server start. When the run ends, the server stops.',
    ],
    example: {
      lang: 'ts',
      code: `// packages/web/vx.config.ts
import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    dev: {
      exec: { command: 'vite', persistent: { readyWhen: 'Local:' } },
    },
    e2e: {
      dependsOn: ['dev'],
      exec: { command: 'playwright test' },
    },
  },
})`,
    },
    image: 'dev-servers.png',
    imageAlt: 'e2e tests start when the dev server prints its ready line.',
    docs: { label: 'Dev tasks', href: 'guides/configure/#dev-tasks' },
    deepDive: { label: 'Dev servers in the graph', href: 'blog/dev-servers-in-the-graph/' },
  },
  {
    slug: 'ctrl-c',
    title: 'Ctrl-C leaves nothing running',
    category: 'daily',
    hook: 'No dev server still holding its port the next morning.',
    body: [
      'Ctrl-C signals every task’s whole process group, not only the shell vx started. vx waits a grace period, sends SIGKILL to whatever is left and reaps it.',
      'Nothing outlives the run, so the next one finds its ports free.',
    ],
    example: {
      lang: 'sh',
      code: 'VX_KILL_GRACE_MS=5000 vx run dev   # a longer grace before SIGKILL',
    },
    image: 'ctrl-c.png',
    imageAlt: 'Ctrl-C stopping every task’s process group.',
    docs: { label: 'What a run does', href: 'execution/' },
    deepDive: { label: 'Ctrl-C', href: 'blog/ctrl-c/' },
  },
  {
    slug: 'watch',
    title: 'Watch mode',
    category: 'daily',
    hook: 'Every change takes the same path as `vx run`, and the key decides what re-runs.',
    body: [
      '`vx watch` runs a task, then runs it again when files in the projects in scope change. There is no per-event glob matching: each change goes through the same path as `vx run`, and the cache key decides what re-runs, downstream included.',
      'It reacts to content, not to events. A file whose bytes did not change starts nothing, so a task writing into its own folder cannot loop.',
    ],
    example: { lang: 'sh', code: 'vx watch test --all' },
    image: 'watch.png',
    imageAlt: 'vx watch re-running only the tasks whose keys changed.',
    docs: { label: 'vx watch', href: 'cli/#vx-watch' },
    deepDive: { label: 'Watch mode', href: 'blog/watch-mode/' },
  },
  {
    slug: 'completions',
    title: 'Shell completions',
    category: 'daily',
    hook: 'Tab-complete every verb and flag in bash, zsh and fish.',
    body: [
      '`vx completions` prints a completion script for bash, zsh or fish. It completes the verbs, the plugin verbs your workspace declares, and every flag of each.',
      'The flags come from the same help text `vx <verb> --help` prints, so a flag cannot be documented and not completed.',
    ],
    example: {
      lang: 'sh',
      code: 'eval "$(vx completions bash)"\nvx completions zsh > ~/.zfunc/_vx\nvx completions fish > ~/.config/fish/completions/vx.fish',
    },
    image: 'small-things.png',
    imageAlt: 'Four small vx conveniences, among them vx completions.',
    docs: { label: 'vx completions', href: 'cli/#vx-completions' },
  },
  {
    slug: 'filter-hints',
    title: 'Typo hints',
    category: 'daily',
    hook: 'A filter that matches nothing asks “Did you mean @acme/app?”.',
    body: [
      'A `--filter` that matches no project refuses the run and names the nearest project. A task name, a flag or a verb within two edits of a real one is hinted the same way.',
      'A typo never turns into a run that quietly did less than you asked.',
    ],
    example: {
      lang: 'sh',
      code: 'vx run build --filter @acme/ap   # no projects matched … Did you mean @acme/app?',
    },
    image: 'small-things.png',
    imageAlt: 'Four small vx conveniences, among them typo hints.',
    docs: { label: 'Filters', href: 'cli/#filter-dsl---filter' },
  },
  {
    slug: 'upgrade',
    title: 'vx upgrade',
    category: 'daily',
    hook: 'The release binary updates itself, digest checked.',
    body: [
      '`vx upgrade` asks the GitHub release for your platform’s binary and its SHA-256 digest, downloads it, checks the digest and replaces the running binary in place. `vx upgrade <tag>` pins a release.',
      'A download that does not match replaces nothing. An install from npm is updated through npm instead.',
    ],
    example: { lang: 'sh', code: 'vx upgrade' },
    image: 'small-things.png',
    imageAlt: 'Four small vx conveniences, among them vx upgrade.',
    docs: { label: 'vx upgrade', href: 'cli/#vx-upgrade' },
  },

  // ---- CI ----
  {
    slug: 'affected',
    title: 'Run only what a change reaches',
    category: 'ci',
    hook: '`--affected` follows task edges from the change, and nothing else runs.',
    body: [
      '`vx run test --affected` runs the tasks a change since the base branch touches, and the tasks whose `dependsOn` reaches one of them. With no edge from the changed task to yours, yours does not run.',
      'Pair it with the cache and most pull requests run a handful of tasks.',
    ],
    example: { lang: 'sh', code: 'vx run test --affected\nvx run test --affected=origin/main' },
    image: 'affected.png',
    imageAlt: 'Only the tasks a change reaches through dependsOn run.',
    docs: { label: 'CI and remote', href: 'guides/ci/' },
  },
  {
    slug: 'vx-lock',
    title: 'vx lock',
    category: 'ci',
    hook: 'CI runs exactly the config you reviewed.',
    body: [
      'A TypeScript config can evaluate differently on another machine. `vx lock` evaluates every config now and writes the resolved objects to `vx-lock.json`.',
      '`vx run --frozen` loads configs from the lock and evaluates nothing. `vx lock --check` re-evaluates every config and fails on drift, so a pipeline can check the lock first.',
    ],
    example: { lang: 'sh', code: 'vx lock\nvx lock --check\nvx run ci --all --frozen' },
    image: 'vx-lock.png',
    imageAlt: 'vx lock writing vx-lock.json; CI runs with --frozen.',
    docs: { label: 'vx lock', href: 'cli/#vx-lock' },
    deepDive: { label: 'Lock and frozen', href: 'blog/lock-and-frozen/' },
  },
  {
    slug: 'flaky-detection',
    title: 'Flaky task detection',
    category: 'ci',
    hook: 'Local and free: the same key failing after it passed is called flaky.',
    body: [
      'A task is flaky when its exact cache key failed after it had passed, or when it needed a retry. Its row says so, from the local run history alone, and `vx info` keeps the standing list.',
      'Failing on new inputs is a break, not a flake, and carries no note.',
    ],
    example: {
      lang: 'text',
      code: ' ◼︎   4.21s failed  miss     app#test flaky - passed 3× before',
    },
    image: 'flaky-detection.png',
    imageAlt: 'A failed task row marked flaky, with its history.',
    docs: { label: 'vx info', href: 'cli/#vx-info' },
    deepDive: { label: 'Flaky tasks', href: 'blog/flaky-tasks/' },
  },
  {
    slug: 'github-ci',
    title: 'Results on GitHub',
    category: 'ci',
    hook: 'Every run on GitHub Actions writes a job summary and a check.',
    body: [
      '`@vzn/vx-ci` adds one block to the workflow page for every `vx run`: the verdict, tasks, cache hits and duration, with failures first and their exit codes.',
      'With a `checks: write` permission it also posts Checks API results, so the outcome is on the pull request, not buried in logs.',
    ],
    example: { lang: 'ts', code: workspace('@vzn/vx-ci', 'github()') },
    image: 'github-ci.png',
    imageAlt: 'A GitHub Actions job summary written by vx.',
    docs: { label: 'GitHub Actions', href: 'guides/ci/#github-actions' },
    deepDive: {
      label: '@vzn/vx-ci',
      href: 'https://github.com/vznjs/vx/tree/main/packages/vx-ci',
    },
  },

  // ---- Adoption ----
  {
    slug: 'quickstart',
    title: 'Start in a minute',
    category: 'adoption',
    hook: 'Install, init, run.',
    body: [
      '`vx init` writes a `vx.config.ts` per package from its `package.json` scripts. Add the cache block each TODO shows, and the second run of a task is up-to-date in milliseconds.',
      'No account, no service to sign up for: the cache is a directory on your machine.',
    ],
    example: {
      lang: 'sh',
      code: 'npm install -D @vzn/vx\nnpx vx init\nnpx vx run build --all\nnpx vx run build --all   # again: the cached tasks are up-to-date',
    },
    image: 'quickstart.png',
    imageAlt: 'Install, vx init, and two runs of vx run build --all.',
    docs: { label: 'Quickstart', href: 'quickstart/' },
  },
  {
    slug: 'one-binary',
    title: 'One binary',
    category: 'adoption',
    hook: 'Built on Bun, and you never install Bun.',
    body: [
      '`npm install -D @vzn/vx` brings a prebuilt binary for Linux and macOS, x64 and arm64. There is no postinstall step and no runtime to match.',
      'CI can download the release binary directly, and it needs no Node either. Your tasks still run on your own toolchain.',
    ],
    example: { lang: 'sh', code: 'npm install -D @vzn/vx\nnpx vx version' },
    image: 'one-binary.png',
    imageAlt: 'One vx binary per platform, with nothing installed underneath.',
    docs: { label: 'Install', href: 'quickstart/#install' },
    deepDive: { label: 'One binary', href: 'blog/one-binary/' },
  },
  {
    slug: 'migrate',
    title: 'Migrate from Turborepo or Nx',
    category: 'adoption',
    hook: 'One command writes native vx config from turbo.json or the Nx graph.',
    body: [
      '`@vzn/vx-migrate` writes a `vx.config.ts` per package from `turbo.json` or your Nx project graph, and installs vx with your own package manager. Your `package.json` scripts stay as they are.',
      'It declares the plugins the repo calls for, such as the lockfile plugin and the GitHub plugin, and it can keep your existing Turborepo or Nx remote cache.',
    ],
    example: { lang: 'sh', code: 'bunx @vzn/vx-migrate' },
    image: 'migrate.png',
    imageAlt: 'vx-migrate writing a vx.config.ts per package.',
    docs: { label: 'Migrate', href: 'guides/migrate/' },
    deepDive: { label: 'Moving to vx from Turborepo', href: 'blog/from-turborepo/' },
  },
  {
    slug: 'turbo-nx-flags',
    title: 'Flags you already know',
    category: 'adoption',
    hook: 'Type what Turborepo, Nx or Vite Task taught you.',
    body: [
      'vx takes their flags as they are (`--filter=web...`), rewrites the aliases (`--skip-nx-cache` becomes `--force`), or refuses with the vx way to say it (`web:build` is `web#build`).',
      'No flag is dropped in silence.',
    ],
    example: { lang: 'sh', code: 'vx run build --filter=web...\nvx run test --skip-nx-cache' },
    image: 'turbo-nx-flags.png',
    imageAlt: 'Turborepo and Nx flags accepted, rewritten or answered by vx.',
    docs: { label: 'Turbo and Nx flags', href: 'cli/#turbo-and-nx-flags' },
  },
  {
    slug: 'playground',
    title: 'The playground',
    category: 'adoption',
    hook: 'Try vx’s planner in your browser, with nothing to install.',
    body: [
      'The playground runs vx’s own planner, bundled for the web, on four small packages.',
      'Edit a file, an env var or a config, press Run, and read which tasks would run and why.',
    ],
    example: { lang: 'sh', code: 'vx run build test --all --dry=json   # what the page computes' },
    image: 'playground.png',
    imageAlt: 'The playground: four packages, a Run button and the plan.',
    docs: { label: 'Try it', href: 'playground/' },
  },

  // ---- Plugins ----
  {
    slug: 'plugins',
    title: 'A pipeline with seams',
    category: 'extend',
    hook: 'Fourteen seams, and core applies no plugin by default.',
    body: [
      'vx is a pipeline: config, discover, project, graph, key, fingerprint, schedule, admit, executor, cache, telemetry, setup, teardown and commands. Each is a seam a plugin can fill.',
      'Plugins decide where a task runs, where artifacts live, who observes and which CLI verbs exist. Running and caching on this machine are core’s floor, so a workspace with no plugin still runs and caches.',
    ],
    example: {
      lang: 'ts',
      code: `// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx/config'
import { otel } from '@vzn/vx-otel'
import { pnpm } from '@vzn/vx-lockfile'

export default defineWorkspace({
  plugins: [pnpm(), otel()],
})`,
    },
    image: 'plugins.png',
    imageAlt: 'The vx pipeline and the seams plugins fill.',
    docs: { label: 'Plugins', href: 'guides/plugins/' },
    deepDive: { label: 'A pipeline with seams', href: 'blog/pipeline-with-seams/' },
  },
  {
    slug: 'remote-execution',
    title: 'Remote cache and execution',
    category: 'extend',
    hook: 'Distributed builds over Bazel’s open Remote Execution API.',
    body: [
      'Distributed builds usually arrive as a platform: a service, agents, a dashboard, a bill. In vx they are a plugin.',
      '`@vzn/vx-reapi` speaks Bazel’s Remote Execution API, so it works with servers you host: NativeLink, BuildBuddy, Buildbarn, bazel-remote. It caches by default; set `execute: true` and tasks run there too.',
    ],
    example: {
      lang: 'ts',
      code: workspace('@vzn/vx-reapi', "reapi({ endpoint: 'grpcs://cache.example.com:443' })"),
    },
    image: 'remote-execution.png',
    imageAlt: 'vx sending tasks to a REAPI server.',
    docs: { label: 'Remote execution', href: 'guides/ci/#remote-execution' },
    deepDive: { label: 'Remote execution', href: 'blog/remote-execution/' },
  },
  {
    slug: 'opentelemetry',
    title: 'OpenTelemetry',
    category: 'extend',
    hook: 'Every run as OTLP traces, metrics and logs, with no SDK.',
    body: [
      '`@vzn/vx-otel` exports each `vx run` to any OpenTelemetry backend over OTLP. It speaks the wire protocol directly and has no dependencies.',
      'It cannot break a build: telemetry sinks are crash-isolated and time-bounded. With no endpoint set it declines and costs nothing.',
    ],
    example: { lang: 'ts', code: workspace('@vzn/vx-otel', 'otel()') },
    image: 'opentelemetry.png',
    imageAlt: 'A vx run as a trace in an OpenTelemetry backend.',
    docs: { label: 'OpenTelemetry', href: 'guides/plugins/#opentelemetry' },
    deepDive: { label: 'Telemetry never breaks a run', href: 'blog/telemetry-never-breaks-a-run/' },
  },
  {
    slug: 'mcp',
    title: 'vx mcp for coding agents',
    category: 'extend',
    hook: 'Give your agent the build’s memory over MCP.',
    body: [
      'Coding agents spend tokens working out your build: reading configs, guessing tasks, re-running to check the cache. vx already knows.',
      '`@vzn/vx-mcp` adds `vx mcp`, an MCP server any MCP client can call: the tasks, run history, cache stats, why a task re-ran, and a tool that runs tasks and returns the run summary.',
    ],
    example: { lang: 'ts', code: workspace('@vzn/vx-mcp', 'mcp()') },
    image: 'mcp.png',
    imageAlt: 'A coding agent asking vx mcp about tasks and history.',
    docs: { label: 'vx mcp', href: 'guides/plugins/#vx-mcp' },
    deepDive: { label: 'Agents and MCP', href: 'blog/agents-and-mcp/' },
  },
  {
    slug: 'critical-path',
    title: 'Longest chain first',
    category: 'extend',
    hook: 'The slow task stops starting last.',
    body: [
      '`@vzn/vx-schedule-history` learns task durations from your local run history and starts the longest remaining chain first. Short tasks fill the gaps.',
      'A fresh CI runner has no history, so `assume` names durations up front for the tasks it has not seen.',
    ],
    example: {
      lang: 'ts',
      code: workspace(
        '@vzn/vx-schedule-history',
        "scheduleHistoryPlugin({ assume: { 'docs#build': 30_000 } })",
      ),
    },
    image: 'critical-path.png',
    imageAlt: 'The longest chain of tasks scheduled first.',
    docs: { label: 'Keys and order', href: 'guides/plugins/#keys-and-order' },
    deepDive: {
      label: '@vzn/vx-schedule-history',
      href: 'https://github.com/vznjs/vx/tree/main/packages/vx-schedule-history',
    },
  },
]

const rank = (f: Feature): number => CATEGORIES.findIndex((c) => c.id === f.category)

/** Every feature, grouped by category in the hub's order. */
export const FEATURES: readonly Feature[] = [...FIRST, ...MORE].sort((a, b) => rank(a) - rank(b))

/** A feature's category. */
export const categoryOf = (f: Feature): Category => CATEGORIES.find((c) => c.id === f.category)!

/** Plain text as HTML, each backticked span as `<code>`. */
export const inlineHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
