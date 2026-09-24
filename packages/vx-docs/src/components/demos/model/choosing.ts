// The choosing page's model (Learn page W7, item 689): the design choices
// behind vx, Turborepo, Nx and Bazel, what each tool chose, what that buys
// and costs, and the needs a reader can tick to see which choices decide
// them. The static matrix, the diagram, the checkpoint and the element all
// read this file, so the page cannot say two things.
//
// Every claim about another tool was checked against that tool's own docs
// source on 2026-09-24 (vercel/turborepo, nrwl/nx and bazelbuild/bazel)
// and links to the published page. A vx source is a site page (relative to
// the base) or a GitHub link to the test that holds the claim, with the
// row's title; `tests/learn-choosing.test.ts` checks both resolve.

export type Tool = 'vx' | 'turbo' | 'nx' | 'bazel'

export const TOOLS: readonly Tool[] = ['vx', 'turbo', 'nx', 'bazel']

export const TOOL_NAME: Record<Tool, string> = {
  vx: 'vx',
  turbo: 'Turborepo',
  nx: 'Nx',
  bazel: 'Bazel',
}

export interface Source {
  label: string
  /** A full URL, or for vx a site path relative to the base (`guides/configure/`). */
  href: string
  /** For a link to a vx test: the title of the row that holds the claim. */
  row?: string
}

export interface Cell {
  chose: string
  buys: string
  costs: string
  sources: readonly Source[]
}

export interface Choice {
  id: string
  title: string
  /** The design question, in terms no tool owns. */
  question: string
  cells: Record<Tool, Cell>
  /** When another tool's choice is the better one. Never vx. */
  otherIf: readonly { tool: Exclude<Tool, 'vx'>; when: string }[]
}

export interface Need {
  id: string
  label: string
  /** The choices whose cells decide it. */
  decidedBy: readonly string[]
  fits: readonly Tool[]
  why: string
}

const GH = 'https://github.com/vznjs/vx/blob/main/'
const T = 'https://turborepo.com/docs/'
const N = 'https://nx.dev/docs/'
const B = 'https://bazel.build/'

export const CHOICES: readonly Choice[] = [
  {
    id: 'inputs',
    title: "How a task's inputs are found",
    question:
      'Does the runner hash every file it can see by default, work out the inputs from your tools, or make you declare them?',
    cells: {
      vx: {
        chose:
          'Declared. A cached task must list its input files, and caching is off until it does. Nothing is inferred.',
        buys: 'The key covers exactly what the config says, so a miss can be explained file by file (vx why).',
        costs:
          'Writing and maintaining the lists is your work. A file a task reads but the list leaves out is a stale hit waiting to happen, unless the sandbox catches it.',
        sources: [
          { label: 'Caching tasks', href: 'guides/configure/#caching' },
          {
            label: 'tests/config.test.ts',
            href: `${GH}packages/vx/tests/config.test.ts`,
            row: 'requires cache.inputs.files — the one declaration vx will not infer',
          },
        ],
      },
      turbo: {
        chose:
          "A default. With no inputs key, a task's inputs are all files in the package checked into source control, plus package.json, turbo.json and the lockfiles. An inputs list narrows it.",
        buys: 'Caching works before anyone writes an input list.',
        costs:
          'An edit to any tracked file in the package reruns every task there. A file outside the package needs globalDependencies or $TURBO_ROOT$.',
        sources: [
          { label: 'inputs', href: `${T}reference/configuration#inputs` },
          { label: 'Task inputs', href: `${T}crafting-your-repository/caching#task-inputs` },
        ],
      },
      nx: {
        chose:
          "A default and inference. By default a task's inputs are all files in the project and in the projects it depends on. Plugins infer inputs from tool config such as vite.config.ts.",
        buys: 'Little to write, and by default Nx reruns a task when it should.',
        costs:
          'Its docs say the default may rerun tasks when irrelevant files change. Settings come from plugins, targetDefaults and the project, merged, so nx show project is how you see the result.',
        sources: [
          { label: 'Inputs reference', href: `${N}reference/inputs` },
          { label: 'Inferred tasks', href: `${N}concepts/mental-model#inferred-tasks` },
        ],
      },
      bazel: {
        chose:
          'Declared, for every action. BUILD files list each target’s sources, dependencies, data and tools.',
        buys: 'A complete action graph: enough to sandbox every action and to run it on another machine.',
        costs:
          'Every dependency is written down, for every package, and kept current by hand or by tools such as Gazelle.',
        sources: [
          { label: 'BUILD files', href: `${B}concepts/build-files` },
          { label: 'Dependencies', href: `${B}concepts/dependencies` },
        ],
      },
    },
    otherIf: [
      {
        tool: 'turbo',
        when: 'caching must work before anyone writes an input list: Turborepo and Nx both start from every file in the project.',
      },
      {
        tool: 'bazel',
        when: 'you want every input declared for every action in every language, not only for cached JavaScript tasks.',
      },
    ],
  },
  {
    id: 'proof',
    title: 'What checks the key',
    question:
      'When a task reads a file its key does not cover, does anything notice, and where does that check run?',
    cells: {
      vx: {
        chose:
          'A local sandbox, opt-in per task (exec.sandbox), on Linux and macOS. A read or write outside the grants is denied, and the task fails.',
        buys: 'An undeclared read turns into a failed task on your own machine and in CI, before it becomes a stale hit.',
        costs:
          'It is off until a task opts in. Its grants are a second list next to the inputs, and it proves the key only as far as the two agree. No Windows.',
        sources: [
          { label: 'Sandboxing tasks', href: 'guides/sandboxing/' },
          {
            label: 'tests/sandbox-runtime.unsafe.test.ts',
            href: `${GH}packages/vx/tests/sandbox-runtime.unsafe.test.ts`,
            row: 'denies reads of workspace-root files not in inputs → task fails',
          },
        ],
      },
      turbo: {
        chose:
          'Its docs describe no file sandbox. Strict Mode, the default, passes a task only the environment variables turbo.json names.',
        buys: 'Nothing to set up, and a task that needs an undeclared variable is likely to fail.',
        costs:
          'Its docs warn that Strict Mode does not guarantee a failure, and describe nothing that checks the files a task reads.',
        sources: [
          {
            label: 'Strict Mode',
            href: `${T}crafting-your-repository/using-environment-variables#strict-mode`,
          },
        ],
      },
      nx: {
        chose:
          'Task sandboxing, an Nx Cloud add-on that runs on Nx Agents in a dedicated compute cluster. Warning mode reports violations; Strict mode fails the task.',
        buys: 'A record of every file each task touched, with a dashboard of violations across the organisation.',
        costs:
          'It needs the add-on, the cluster and Nx 22.6 or later, and it is not supported when you run the agents on your own compute.',
        sources: [
          { label: 'Task sandboxing', href: `${N}features/ci-features/sandboxing` },
          {
            label: 'Dedicated compute cluster',
            href: `${N}features/ci-features/dedicated-compute-cluster`,
          },
        ],
      },
      bazel: {
        chose:
          'A local sandbox, on by default where the system supports it: each action runs in a directory holding only its declared inputs.',
        buys: 'Every action is checked on every build, with no opt-in, and a build that works sandboxed is likely to work remotely.',
        costs:
          'Its docs say a tool that knows an absolute path can still read a file outside the sandbox. Every input must be declared first.',
        sources: [
          { label: 'Sandboxing', href: `${B}docs/sandboxing` },
          { label: '--spawn_strategy', href: `${B}docs/user-manual#spawn-strategy` },
        ],
      },
    },
    otherIf: [
      {
        tool: 'bazel',
        when: 'the check should be on by default for every action, not opt-in per task.',
      },
      {
        tool: 'nx',
        when: 'you already run CI on Nx Cloud and want the audit and its dashboard there.',
      },
    ],
  },
  {
    id: 'config',
    title: 'The configuration language',
    question: 'Is the configuration data that any tool can read, or a program that is run?',
    cells: {
      vx: {
        chose:
          'TypeScript: a vx.config.ts per package and a vx.workspace.ts. vx evaluates each file and hashes the object it returns.',
        buys: 'Types and autocomplete, shared presets as plain imports, and computed values that still reach the key.',
        costs:
          'A config is a program: it must be evaluated (vx caches configs it can prove pure), it runs on Bun, and other tools cannot read it as data.',
        sources: [
          { label: 'Configuration', href: 'schema/' },
          {
            label: 'tests/task-hash-derive.test.ts',
            href: `${GH}packages/vx/tests/task-hash-derive.test.ts`,
            row: 'every exec and task field but the stripped one moves the key',
          },
        ],
      },
      turbo: {
        chose:
          'JSON: one turbo.json at the root (turbo.jsonc for comments), and per-package turbo.json files that extend it.',
        buys: 'Static data with a schema, readable by any tool without running code.',
        costs:
          'No computation: reuse goes through extends and microsyntax such as $TURBO_DEFAULT$ and $TURBO_EXTENDS$.',
        sources: [
          { label: 'Configuring turbo.json', href: `${T}reference/configuration` },
          { label: 'Package Configurations', href: `${T}reference/package-configurations` },
        ],
      },
      nx: {
        chose:
          'JSON: nx.json for the workspace, and project settings in package.json or project.json, merged with what plugins infer.',
        buys: 'Little to write per project when plugins infer the tasks.',
        costs:
          'Three sources are merged in order (plugins, targetDefaults, the project), so the effective settings are not in any one file.',
        sources: [{ label: 'Types of configuration', href: `${N}concepts/types-of-configuration` }],
      },
      bazel: {
        chose:
          'Starlark, a language with Python-inspired syntax: a BUILD file in every package, and .bzl files for macros and rules.',
        buys: 'A real language for the build, one syntax for every language the repo holds.',
        costs:
          'A language and a set of files your team must learn and keep beside the ones each tool already has.',
        sources: [
          { label: 'Starlark language', href: `${B}rules/language` },
          { label: 'BUILD files', href: `${B}concepts/build-files` },
        ],
      },
    },
    otherIf: [
      {
        tool: 'turbo',
        when: 'your configuration must be plain data other tools can read without running code. Nx is JSON too.',
      },
    ],
  },
  {
    id: 'extension',
    title: 'How the runner is extended',
    question: 'Can outside code change how the runner works, and at which points?',
    cells: {
      vx: {
        chose:
          'Plugin stages, from config to telemetry. Core applies no plugin by default; running and caching on this machine are the floor under every plugin.',
        buys: 'Remote caches, remote execution, Turbo and Nx adoption and telemetry are all plugins, built without forking core.',
        costs:
          'A young API with few plugins besides the first-party ones. Plugins run on Bun, and none can turn a task into anything but a command.',
        sources: [
          { label: 'Writing a plugin', href: 'guides/plugins/' },
          {
            label: 'tests/plugin-pipeline.test.ts',
            href: `${GH}packages/vx/tests/plugin-pipeline.test.ts`,
            row: 'an injected task runs, and keys exactly like the same task written by hand',
          },
        ],
      },
      turbo: {
        chose:
          'A fixed core configured by turbo.json. Its docs describe no plugin API; they describe Turborepo as lightweight, with your repository as the source of truth.',
        buys: 'Nothing Turborepo-specific in your packages beyond the config.',
        costs: 'What the core does not do, you do in scripts, or wait for a release.',
        sources: [
          {
            label: 'Using ecosystem standards',
            href: `${T}guides/migrating-from-nx#using-ecosystem-standards`,
          },
        ],
      },
      nx: {
        chose:
          'Plugins written in TypeScript that add project graph data, inferred tasks, generators, migrations and executors, from Nx and the community.',
        buys: 'Knowledge of a tool (Vite, Jest, Gradle) packaged once instead of written in every project.',
        costs:
          'The settings a plugin infers have to be inspected and overridden when they are wrong.',
        sources: [{ label: 'How Nx plugins work', href: `${N}concepts/nx-plugins` }],
      },
      bazel: {
        chose:
          'Rules and macros written in Starlark. A rule defines the actions Bazel runs on its inputs to produce outputs.',
        buys: 'Full control over the actions for any language or tool.',
        costs:
          'Writing rules is its own skill. Bazel’s JavaScript rules, such as rules_js, are maintained outside the Bazel repository.',
        sources: [
          { label: 'Rules', href: `${B}extending/rules` },
          { label: 'JavaScript and Bazel', href: `${B}docs/bazel-and-javascript` },
        ],
      },
    },
    otherIf: [
      {
        tool: 'nx',
        when: 'you want plugins that already know your tools, today, and code generators.',
      },
      {
        tool: 'bazel',
        when: 'you need to define new kinds of build actions for languages other than JavaScript.',
      },
    ],
  },
  {
    id: 'runtime',
    title: 'What the runner runs on',
    question: 'Which runtime must every machine have to run the tool, its config and its plugins?',
    cells: {
      vx: {
        chose:
          'Bun. The npm package runs a binary with Bun inside, for Linux and macOS on x64 and arm64; from source it needs Bun 1.4 or later. Configs and plugins run on Bun.',
        buys: 'Bun’s SQLite, process spawning, globbing and compression are built in, and one binary carries all of it.',
        costs:
          'A config or plugin that needs an API only Node has does not run. No native Windows: Windows runs vx under WSL.',
        sources: [
          { label: 'Quickstart', href: 'quickstart/' },
          { label: 'Out of scope', href: 'comparison/#explicitly-out-of-scope-today' },
        ],
      },
      turbo: {
        chose:
          'A native binary, shipped through npm for macOS, Linux and Windows on x64 and arm64. Core turbo does not depend on your Node version.',
        buys: 'Native Windows, and no JavaScript runtime needed to run tasks.',
        costs:
          'Some packages around it, such as create-turbo and turbo-ignore, do need Node, on its LTS versions.',
        sources: [{ label: 'Support policy', href: `${T}support-policy` }],
      },
      nx: {
        chose:
          'Node.js: Nx is an npm package, loads TypeScript config through Node, and installs through npm, Homebrew, Chocolatey or apt.',
        buys: 'It runs wherever your JavaScript toolchain already runs, Windows included.',
        costs: 'Nx itself and its plugins start as Node processes on every command.',
        sources: [
          { label: 'Install the Nx CLI', href: `${N}getting-started/installation` },
          { label: 'Environment variables', href: `${N}reference/environment-variables` },
        ],
      },
      bazel: {
        chose:
          'A client and a long-lived server that runs in a JVM. The bazel executable bundles its JDK. Linux, macOS and Windows.',
        buys: 'Independent of any language’s toolchain: the server is the same for every repository.',
        costs:
          'A JVM server per workspace and user, and your team has one more runtime to reason about.',
        sources: [
          { label: 'Client/server implementation', href: `${B}run/client-server` },
          { label: '--server_javabase', href: `${B}docs/user-manual#server-javabase` },
          { label: 'Output directories', href: `${B}remote/output-directories` },
          { label: 'Installing on Windows', href: `${B}install/windows` },
        ],
      },
    },
    otherIf: [
      {
        tool: 'turbo',
        when: 'you need a native Windows binary, or no JavaScript runtime in the runner at all.',
      },
      { tool: 'nx', when: 'your build tooling must run on Node.' },
    ],
  },
  {
    id: 'languages',
    title: 'What it builds',
    question:
      'Does the runner understand projects in other languages, with their own dependency graphs?',
    cells: {
      vx: {
        chose:
          'JavaScript monorepos. A project is a package-manager workspace package. A task is any shell command, so it can call go or cargo, but vx reads no go.mod or Cargo.toml.',
        buys: 'One model, with no plugin needed to find projects.',
        costs:
          'Another language’s dependency graph is invisible unless you wrap each project in a package.json. Non-JavaScript project support is out of scope.',
        sources: [{ label: 'Out of scope', href: 'comparison/#explicitly-out-of-scope-today' }],
      },
      turbo: {
        chose:
          'JavaScript workspaces, plus experimental native Go, Cargo and uv workspaces. Other languages need a package.json beside each project.',
        buys: 'Go modules and Rust crates in the same graph as JavaScript packages, without package.json files.',
        costs: 'The native support is experimental and can change at any time.',
        sources: [
          { label: 'Multi-language support', href: `${T}guides/multi-language` },
          { label: 'Release phases', href: `${T}support-policy#experimental` },
        ],
      },
      nx: {
        chose:
          'Any language: a project.json target runs any command, and first-party plugins read Gradle, Maven and .NET builds into the graph. Python, Go and Rust plugins come from the community.',
        buys: 'JVM and .NET projects in the same graph as JavaScript, with their dependencies.',
        costs: 'Outside those, coverage depends on community plugins.',
        sources: [{ label: 'Multi-language support', href: `${N}features/multi-language-support` }],
      },
      bazel: {
        chose:
          'Any language, through rules. Bazel builds projects in multiple languages for multiple platforms.',
        buys: 'C++, Java, Go, Rust and more in one graph, with one set of guarantees.',
        costs: 'Each language comes with its own rules to learn and maintain.',
        sources: [
          { label: 'Intro to Bazel', href: `${B}about/intro` },
          { label: 'Rules', href: `${B}rules` },
        ],
      },
    },
    otherIf: [
      {
        tool: 'bazel',
        when: 'your repository is heavily polyglot, with languages such as C++, Java, Go or Rust first-class.',
      },
      { tool: 'nx', when: 'you build JVM or .NET projects beside JavaScript.' },
    ],
  },
  {
    id: 'remote-cache',
    title: 'The remote cache wire',
    question: 'How does a cache reach other machines, and who hosts it?',
    cells: {
      vx: {
        chose:
          'No wire in core: a plugin brings it. @vzn/vx-reapi speaks Bazel’s remote cache protocol; turboCache() speaks Turborepo’s, nxCache() speaks Nx’s. A remote error becomes a miss.',
        buys: 'A cache server you already run for Bazel, Turborepo or Nx serves vx too.',
        costs:
          'No first-party hosted cache: you run or rent someone else’s server. The plugins are not on npm until 0.1.0 is cut.',
        sources: [
          { label: 'Remote caching', href: 'guides/ci/#remote-cache' },
          {
            label: 'tests/layered-cache.test.ts',
            href: `${GH}packages/vx/tests/layered-cache.test.ts`,
            row: 'get() suppresses remote errors and returns null',
          },
        ],
      },
      turbo: {
        chose:
          'Its own HTTP API. Vercel Remote Cache is free on all plans, or you self-host a server that follows the published OpenAPI spec.',
        buys: 'A hosted cache with one login, or a small server of your own.',
        costs: 'turbo login and a Vercel account for the hosted cache.',
        sources: [
          { label: 'Remote Caching', href: `${T}core-concepts/remote-caching` },
          { label: 'Self-hosting', href: `${T}core-concepts/remote-caching#self-hosting` },
        ],
      },
      nx: {
        chose:
          'Nx Cloud as the managed remote cache, or a server you build from Nx’s OpenAPI spec.',
        buys: 'A managed cache next to Nx Cloud’s other CI features.',
        costs:
          'The managed cache means an Nx Cloud workspace; regional and self-hosted deployments are Enterprise options.',
        sources: [
          { label: 'Remote caching', href: `${N}features/ci-features/remote-cache` },
          { label: 'Self-hosted remote cache', href: `${N}kb/self-hosted-caching` },
        ],
      },
      bazel: {
        chose:
          'Open protocols: HTTP/1.1 (any server that supports PUT and GET) and gRPC, plus a local disk cache.',
        buys: 'Many servers speak it, open source and commercial.',
        costs: 'You choose, run or buy the server.',
        sources: [{ label: 'Remote caching', href: `${B}remote/caching` }],
      },
    },
    otherIf: [
      {
        tool: 'turbo',
        when: 'you want a hosted cache from the tool’s own vendor with one login. Nx Cloud is the same for Nx.',
      },
    ],
  },
  {
    id: 'remote-exec',
    title: 'Running tasks on other machines',
    question: 'Can one run send its tasks to other machines, and over what?',
    cells: {
      vx: {
        chose:
          'Remote execution through @vzn/vx-reapi, over Bazel’s open protocol (REAPI), to worker pools such as NativeLink, BuildBuddy or Buildfarm. The scheduler stays on your machine. Off by default.',
        buys: 'A laptop or a CI job can use a build farm, one task at a time, with the rest of the run unchanged.',
        costs:
          'Every input must be declared, since the worker sees nothing else. vx ships no workers, service or dashboard: you run a pool or rent one.',
        sources: [
          { label: 'Remote execution', href: 'guides/ci/#remote-execution' },
          {
            label: 'packages/vx-reapi/tests/exec-e2e.test.ts',
            href: `${GH}packages/vx-reapi/tests/exec-e2e.test.ts`,
            row: 'executes on the worker and materialises the declared output, byte-correct',
          },
        ],
      },
      turbo: {
        chose:
          'None in its docs. Its CI guide speeds a run up through parallelism and the remote cache, which shares results between machines.',
        buys: 'Nothing to operate beyond the cache.',
        costs: 'Its docs describe no way to spread one run’s tasks across machines.',
        sources: [
          { label: 'Constructing CI', href: `${T}crafting-your-repository/constructing-ci` },
          { label: 'Remote Caching', href: `${T}core-concepts/remote-caching` },
        ],
      },
      nx: {
        chose:
          'Nx Agents on Nx Cloud: CI tasks are distributed across machines by their past run times and dependencies.',
        buys: 'Distribution with one line of CI config and agents sized to each PR.',
        costs:
          'It is an Nx Cloud service, billed in credits beyond each plan’s allowance. Running the agents on your own CI machines is an Enterprise plan feature.',
        sources: [
          { label: 'Nx Agents', href: `${N}features/ci-features/distribute-task-execution` },
          { label: 'Bring your own compute', href: `${N}kb/bring-your-own-compute` },
          { label: 'Credit pricing', href: `${N}reference/nx-cloud/credits-pricing` },
        ],
      },
      bazel: {
        chose:
          'Remote execution over an open gRPC protocol (remote-apis), with self-hosted and commercial services.',
        buys: 'Actions spread across a datacenter, one execution environment for the team, and shared outputs.',
        costs:
          'Rules must be adapted for remote execution, and someone runs or pays for the service.',
        sources: [
          { label: 'Remote execution overview', href: `${B}remote/rbe` },
          { label: 'Remote execution services', href: `${B}community/remote-execution-services` },
        ],
      },
    },
    otherIf: [
      {
        tool: 'bazel',
        when: 'you need remote execution in production today, with services to buy.',
      },
      { tool: 'nx', when: 'you want CI distribution run for you as a service.' },
    ],
  },
  {
    id: 'scheduling',
    title: 'Which ready task starts first',
    question: 'When more tasks are ready than there are workers, how does the runner pick?',
    cells: {
      vx: {
        chose:
          'By default, the task with the most tasks waiting on it. @vzn/vx-schedule-history ranks by the remaining critical path learned from past runs. Cache restores get their own lane.',
        buys: 'A documented order that works on the first run, and a better one once there is history.',
        costs:
          'The default cannot see that a task is long. The plugin needs history and must be declared; it runs on one machine.',
        sources: [{ label: 'What a run does: concurrency', href: 'execution/#concurrency' }],
      },
      turbo: {
        chose: '--concurrency, 10 by default. Its docs do not say which ready task starts first.',
        buys: 'One number to tune.',
        costs: 'The order is not something you can read or change.',
        sources: [
          { label: 'turbo run', href: `${T}reference/run#--concurrency-number--percentage` },
        ],
      },
      nx: {
        chose:
          '--parallel, 3 by default. On Nx Cloud, Nx Agents place tasks by past run times and dependencies.',
        buys: 'History-aware placement across CI machines without configuring it.',
        costs: 'Its docs do not say how a local run orders ready tasks.',
        sources: [
          { label: 'Run tasks in parallel', href: `${N}kb/run-tasks-in-parallel` },
          { label: 'Nx Agents', href: `${N}features/ci-features/distribute-task-execution` },
        ],
      },
      bazel: {
        chose:
          '--jobs, and a scheduler that holds back actions whose estimated memory or CPU would not fit.',
        buys: 'A machine is not overloaded by heavy actions started together.',
        costs:
          'Its docs call the estimates very crude, and do not say how ready actions are ordered.',
        sources: [{ label: '--jobs', href: `${B}docs/user-manual#jobs` }],
      },
    },
    otherIf: [
      {
        tool: 'nx',
        when: 'CI must balance tasks across machines by past timings, managed for you.',
      },
      {
        tool: 'bazel',
        when: 'the scheduler must keep heavy actions from overloading a machine by their estimated memory and CPU.',
      },
    ],
  },
  {
    id: 'process',
    title: 'State between runs',
    question:
      'Does a background process keep the workspace in memory, or does every run start fresh?',
    cells: {
      vx: {
        chose: 'No daemon. Every run discovers the workspace and asks git what changed.',
        buys: 'Nothing to keep in sync or reset. On medusa, run through turbo() unchanged, a warm run with nothing to do took 947 ms against Turborepo’s 3.29 s.',
        costs:
          'Every run pays for discovery and the git walk: on payload, 256 ms against Turborepo’s 237 ms.',
        sources: [
          { label: 'Five real Turbo repos', href: 'benchmarks/#five-real-turbo-repos-2026-09-11' },
          { label: 'Out of scope', href: 'comparison/#explicitly-out-of-scope-today' },
        ],
      },
      turbo: {
        chose:
          'No daemon for turbo run: its docs say the daemon is no longer used there and still serves turbo watch and the LSP.',
        buys: 'The same as vx: a run reads the repository as it is.',
        costs: 'The same: every run does its own discovery.',
        sources: [{ label: 'daemon', href: `${T}reference/configuration#daemon` }],
      },
      nx: {
        chose:
          'The Nx Daemon, on by default on developer machines: it watches files and keeps the project graph in memory.',
        buys: 'Later commands get an up-to-date graph without starting the analysis from scratch.',
        costs:
          'A background process per workspace; nx reset stops it and clears the workspace state.',
        sources: [{ label: 'Nx Daemon', href: `${N}reference/nx-daemon` }],
      },
      bazel: {
        chose:
          'A long-lived server that caches BUILD files, dependency graphs and other metadata between builds.',
        buys: 'Fast incremental builds and queries that share one cache of loaded packages.',
        costs:
          'One invocation per server at a time: others block or fail. vx has not measured Bazel.',
        sources: [{ label: 'Client/server implementation', href: `${B}run/client-server` }],
      },
    },
    otherIf: [
      {
        tool: 'bazel',
        when: 'builds and queries on a very large graph should reuse a server’s loaded state.',
      },
    ],
  },
  {
    id: 'adoption',
    title: 'Coming from another tool',
    question: 'What does it take to try the tool on a repository that already uses another one?',
    cells: {
      vx: {
        chose:
          'turbo() runs a turbo.json repository unchanged, and nx() runs an Nx workspace from its resolved graph. bunx @vzn/vx-migrate writes vx.config.ts files when you want to move for good.',
        buys: 'A trial with one vx.workspace.ts and nothing rewritten.',
        costs:
          'The plugins are not on npm until 0.1.0 is cut. nx() runs Nx executors through a Node bin. Moving to native configs means writing input lists.',
        sources: [
          { label: 'From Turborepo', href: 'guides/migrate/#turborepo' },
          { label: 'From Nx', href: 'guides/migrate/#nx' },
          {
            label: 'packages/vx-migrate/tests/turbo.test.ts',
            href: `${GH}packages/vx-migrate/tests/turbo.test.ts`,
            row: 'plans a turbo.json workspace with no vx.config: tasks, edges, cache blocks, inlined globals',
          },
        ],
      },
      turbo: {
        chose:
          'Incremental adoption on package-manager workspaces: install turbo, add a turbo.json. A guide covers moving from Nx.',
        buys: 'Your scripts stay as they are, one task at a time.',
        costs: 'Coming from Nx, the Nx configuration and plugins are replaced by hand.',
        sources: [
          {
            label: 'Add to an existing repository',
            href: `${T}getting-started/add-to-existing-repository`,
          },
          { label: 'Migrating from Nx', href: `${T}guides/migrating-from-nx` },
        ],
      },
      nx: {
        chose:
          'nx init adds Nx to any repository. On a Turborepo repository it reads turbo.json and writes the equivalent nx.json.',
        buys: 'One command, and your package.json scripts keep running through your package manager.',
        costs:
          'Some settings do not carry over, such as per-package task entries, and are ported by hand.',
        sources: [
          {
            label: 'Add to an existing project',
            href: `${N}getting-started/start-with-existing-project`,
          },
          { label: 'Migrating from Turborepo', href: `${N}kb/from-turborepo` },
        ],
      },
      bazel: {
        chose:
          'A BUILD file for every package. Its docs have migration guides for Maven and Xcode; JavaScript goes through rulesets such as rules_js.',
        buys: 'Once done, everything Bazel guarantees applies.',
        costs: 'The migration is the work: every target and dependency written as Bazel rules.',
        sources: [
          { label: 'Migrating to Bazel', href: `${B}migrate` },
          { label: 'JavaScript and Bazel', href: `${B}docs/bazel-and-javascript` },
        ],
      },
    },
    otherIf: [
      {
        tool: 'nx',
        when: 'you want a supported, one-command move from Turborepo today.',
      },
      {
        tool: 'turbo',
        when: 'you want the least configuration on plain package-manager workspaces.',
      },
    ],
  },
  {
    id: 'maturity',
    title: 'Maturity and ecosystem',
    question: 'Is there a stable release, a support policy, and an ecosystem around it?',
    cells: {
      vx: {
        chose:
          'Pre-alpha. @vzn/vx is on npm as 0.0.x builds, 0.1.0 is not cut, and the plugins are not published yet.',
        buys: 'Nothing yet, beyond the design: the API can still change where it is wrong.',
        costs:
          'No stable release, no support policy, a small ecosystem (the first-party plugins), and nothing distributed ships in the repository: no cloud, no workers, no dashboard.',
        sources: [{ label: 'Roadmap to 1.0', href: 'design/roadmap-10/' }],
      },
      turbo: {
        chose:
          'Stable 2.x since June 2024. A major version is supported for two years after the next one ships; experimental features are marked.',
        buys: 'A support window you can plan around.',
        costs: 'Features marked experimental can change at any time.',
        sources: [{ label: 'Support policy', href: `${T}support-policy` }],
      },
      nx: {
        chose:
          'A major release every six months; the previous major gets 12 months of LTS, 18 months of support in all. Official and community plugins.',
        buys: 'Predictable releases, and nx migrate to move between them.',
        costs: 'A major every six months to keep up with.',
        sources: [
          { label: 'Releases', href: `${N}reference/releases` },
          { label: 'How Nx plugins work', href: `${N}concepts/nx-plugins` },
        ],
      },
      bazel: {
        chose:
          'LTS releases: each major is an LTS release, with rolling releases in between. Modules come from the Bazel Central Registry.',
        buys: 'Years of support per major, and a registry of modules.',
        costs:
          'Rolling releases between majors can change behaviour; LTS is the conservative track.',
        sources: [
          { label: 'Release model', href: `${B}release` },
          { label: 'Registries', href: `${B}external/registry` },
        ],
      },
    },
    otherIf: [
      {
        tool: 'turbo',
        when: 'you need a stable release, a support policy and an ecosystem now. Nx and Bazel have them too.',
      },
    ],
  },
]

export const NEEDS: readonly Need[] = [
  {
    id: 'no-bun',
    label: 'Bun is not allowed in our toolchain',
    decidedBy: ['runtime'],
    fits: ['turbo', 'nx', 'bazel'],
    why: 'vx runs its configs and plugins on Bun, installed or inside its binary. Turborepo is a native binary, Nx runs on Node and Bazel on its own JVM.',
  },
  {
    id: 'windows',
    label: 'We build on native Windows, not WSL',
    decidedBy: ['runtime'],
    fits: ['turbo', 'nx', 'bazel'],
    why: 'Turborepo ships Windows binaries, Nx installs on Windows through npm or Chocolatey, and Bazel documents a Windows install. vx runs on Windows only under WSL.',
  },
  {
    id: 'caught',
    label: 'Undeclared inputs must be caught on our own machines',
    decidedBy: ['inputs', 'proof'],
    fits: ['vx', 'bazel'],
    why: 'vx and Bazel sandbox tasks locally. Turborepo has no file sandbox, and Nx sandboxes only on Nx Cloud.',
  },
  {
    id: 'no-input-lists',
    label: 'Caching must work before anyone writes input lists',
    decidedBy: ['inputs'],
    fits: ['turbo', 'nx'],
    why: 'Turborepo and Nx default to every file in the project. vx and Bazel make you declare inputs.',
  },
  {
    id: 'remote-exec',
    label: 'Send tasks to a build farm over an open protocol',
    decidedBy: ['remote-exec'],
    fits: ['vx', 'bazel'],
    why: 'vx and Bazel speak the same open remote execution protocol. Nx Agents distribute CI tasks on Nx Cloud, and Turborepo documents no remote execution.',
  },
  {
    id: 'keep-config',
    label: 'Try it on our Turborepo or Nx repository with nothing rewritten',
    decidedBy: ['adoption'],
    fits: ['vx'],
    why: 'turbo() and nx() run the existing configuration as it is. nx init writes a new nx.json, and the others need new configuration.',
  },
  {
    id: 'polyglot',
    label: 'Other languages are first-class, with their own dependency graphs',
    decidedBy: ['languages'],
    fits: ['nx', 'bazel'],
    why: 'Bazel builds any language through rules, and Nx has stable Gradle, Maven and .NET plugins. Turborepo’s native Go, Cargo and uv support is experimental, and vx is for JavaScript.',
  },
  {
    id: 'mature',
    label: 'A stable release with a published support policy',
    decidedBy: ['maturity'],
    fits: ['turbo', 'nx', 'bazel'],
    why: 'Turborepo, Nx and Bazel publish support windows. vx is pre-alpha.',
  },
  {
    id: 'ts-plugins',
    label: 'Extend the runner with plugins written in TypeScript',
    decidedBy: ['extension'],
    fits: ['vx', 'nx'],
    why: 'vx and Nx plugins are TypeScript. Bazel is extended in Starlark, and Turborepo documents no plugin API.',
  },
]

export interface Verdict {
  needs: readonly Need[]
  /** The choices that decide the ticked needs, in page order; every choice when none is ticked. */
  choices: readonly string[]
  /** The tools that meet every ticked need. */
  fits: readonly Tool[]
  /** Per tool, the ticked needs it does not meet. */
  ruledOutBy: Record<Tool, readonly string[]>
  /** Per deciding choice, the tools that meet every ticked need it decides. */
  favours: Record<string, readonly Tool[]>
}

export function evaluate(needIds: readonly string[]): Verdict {
  const needs = NEEDS.filter((n) => needIds.includes(n.id))
  const deciding = new Set(needs.flatMap((n) => n.decidedBy))
  const choices = CHOICES.filter((c) => needs.length === 0 || deciding.has(c.id)).map((c) => c.id)
  const ruledOutBy = Object.fromEntries(
    TOOLS.map((t) => [t, needs.filter((n) => !n.fits.includes(t)).map((n) => n.id)]),
  ) as Record<Tool, string[]>
  const favours: Record<string, Tool[]> = {}
  for (const id of choices) {
    const on = needs.filter((n) => n.decidedBy.includes(id))
    favours[id] = TOOLS.filter((t) => on.every((n) => n.fits.includes(t)))
  }
  return {
    needs,
    choices,
    fits: TOOLS.filter((t) => ruledOutBy[t].length === 0),
    ruledOutBy,
    favours,
  }
}

export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

const needLabel = (id: string): string => `“${NEEDS.find((n) => n.id === id)!.label}”`

/** What the live region says, and the checkpoint's answer. */
export function verdictSentences(v: Verdict): string[] {
  if (v.needs.length === 0) {
    return ['Nothing ticked: every choice is shown, and every tool is in the running.']
  }
  const names = v.fits.map((t) => TOOL_NAME[t])
  const head =
    names.length === 0
      ? 'No tool meets every need you ticked.'
      : `${joinNames(names)} ${names.length === 1 ? 'meets' : 'meet'} every need you ticked.`
  const out = TOOLS.filter((t) => v.ruledOutBy[t].length > 0).map(
    (t) => `${TOOL_NAME[t]} is ruled out by ${joinNames(v.ruledOutBy[t].map(needLabel))}.`,
  )
  return [head, ...out]
}

/** The checkpoint on the page: these needs, and the answer `evaluate` gives. */
export const CHECKPOINT: readonly string[] = ['mature', 'caught']

// The diagram: where each tool sits on the two choices that decide what a
// cache hit is worth. Levels are ordinal; the cells above say why.
export const MAP_X = {
  choice: 'inputs',
  title: 'How inputs are found',
  levels: [
    'Every file in the project, by default',
    'Defaults, plus inference by plugins',
    'Declared for every task',
  ],
  at: { turbo: 0, nx: 1, vx: 2, bazel: 2 } as Record<Tool, number>,
}
export const MAP_Y = {
  choice: 'proof',
  title: 'What checks the key',
  levels: [
    'Nothing checks the files',
    'A sandbox on the vendor’s cloud',
    'A local sandbox, opt-in per task',
    'A local sandbox, on by default',
  ],
  at: { turbo: 0, nx: 1, vx: 2, bazel: 3 } as Record<Tool, number>,
}

export function mapSentence(): string {
  const at = (t: Tool) =>
    `${TOOL_NAME[t]}: ${MAP_X.levels[MAP_X.at[t]]!.toLowerCase()}; ${MAP_Y.levels[MAP_Y.at[t]]!.toLowerCase()}`
  return `Where each tool sits. ${TOOLS.map(at).join('. ')}.`
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The diagram as SVG: columns are MAP_X's levels, rows MAP_Y's, lowest at the bottom. */
export function mapSvg(): string {
  const W = 640
  const H = 400
  const left = 190
  const top = 20
  const bottom = 70
  const colW = (W - left - 10) / MAP_X.levels.length
  const rowH = (H - top - bottom) / MAP_Y.levels.length
  const cx = (x: number) => left + colW * (x + 0.5)
  const cy = (y: number) => top + rowH * (MAP_Y.levels.length - 1 - y + 0.5)
  const parts: string[] = []
  MAP_Y.levels.forEach((label, y) => {
    const yy = top + rowH * (MAP_Y.levels.length - 1 - y)
    parts.push(
      `<rect class="band" x="${left}" y="${yy}" width="${W - left - 10}" height="${rowH}"/>`,
    )
    parts.push(
      `<text class="level" text-anchor="end">${wrapLabel(label, left - 10, cy(y), 24)}</text>`,
    )
  })
  MAP_X.levels.forEach((label, x) => {
    parts.push(
      `<text class="level" text-anchor="middle">${wrapLabel(label, cx(x), H - bottom + 30, 22)}</text>`,
    )
  })
  parts.push(
    `<text class="axis" x="${left + (W - left - 10) / 2}" y="${H - 6}" text-anchor="middle">${esc(MAP_X.title)} →</text>`,
  )
  parts.push(
    `<text class="axis" x="14" y="${top + (H - top - bottom) / 2}" text-anchor="middle" transform="rotate(-90 14 ${top + (H - top - bottom) / 2})">${esc(MAP_Y.title)} →</text>`,
  )
  // Tools that share a cell sit side by side.
  const cells = new Map<string, Tool[]>()
  for (const t of TOOLS) {
    const key = `${MAP_X.at[t]},${MAP_Y.at[t]}`
    cells.set(key, [...(cells.get(key) ?? []), t])
  }
  for (const t of TOOLS) {
    const peers = cells.get(`${MAP_X.at[t]},${MAP_Y.at[t]}`)!
    const dx = (peers.indexOf(t) - (peers.length - 1) / 2) * 70
    const x = cx(MAP_X.at[t]) + dx
    const y = cy(MAP_Y.at[t])
    parts.push(
      `<g class="tool" data-tool="${t}" data-x="${MAP_X.at[t]}" data-y="${MAP_Y.at[t]}"><circle cx="${x}" cy="${y - 9}" r="6"/><text x="${x}" y="${y + 12}" text-anchor="middle">${esc(TOOL_NAME[t])}</text></g>`,
    )
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(mapSentence())}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`
}

/** A label broken into lines of at most `width` characters, as tspans. */
function wrapLabel(label: string, x: number, y: number, width = 24): string {
  const lines: string[] = []
  for (const word of label.split(' ')) {
    const last = lines.at(-1)
    if (last !== undefined && `${last} ${word}`.length <= width)
      lines[lines.length - 1] = `${last} ${word}`
    else lines.push(word)
  }
  const first = -((lines.length - 1) * 14) / 2
  return lines.map((l, i) => `<tspan x="${x}" y="${y + first + i * 14}">${esc(l)}</tspan>`).join('')
}
