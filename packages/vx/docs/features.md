# Every feature

Every user-facing feature of vx, one line each, grouped by what it is
for. Each line names its surface (verb, flag, config key, plugin), links
its page on the site's [Features](https://vznjs.github.io/vx/features/) hub when it has one, and
its blog post, or says "no post" when the story is still owed.

**Rule:** a change that adds or changes a user-facing feature updates
this file, and its post, in the same commit (`CLAUDE.md`).
`tests/features-inventory.unsafe.test.ts` fails when a CLI verb, a flag, a
config key or an environment variable is missing here.

## Run

- **Run a task** (`vx run`) — run a task in the cwd's project, `pkg#task` directly, or several at once. [page](https://vznjs.github.io/vx/features/quickstart/) · no post
- **Every project** (`--all`) — run the task in every project that declares it. [page](https://vznjs.github.io/vx/features/quickstart/) · no post
- **pnpm-style filters** (`--filter`) — select projects by name, glob, path, dependents (`foo...`), dependencies (`...foo`), negation or a git range. [page](https://vznjs.github.io/vx/features/affected/) · no post
- **Affected only** (`--affected`, `affectedBase`) — run what a change reaches, following task edges from a git base. [page](https://vznjs.github.io/vx/features/affected/) · post: [Run only what a change reaches](https://vznjs.github.io/vx/blog/affected/)
- **Concurrency** (`--concurrency`, `concurrency`) — a count or a share of the CPUs this process may use (`50%`). [page](https://vznjs.github.io/vx/features/concurrency/) · no post
- **Skip dependencies** (`--exclude-dependencies`) — skip all `dependsOn` edges, or named ones. no post
- **Failure policy** (`--continue`) — never, deps-ok (default: dependents skip) or always. [page](https://vznjs.github.io/vx/features/skipped-blockers/) · no post
- **Every skip names its blocker** — a skipped task says which failure blocked it. [page](https://vznjs.github.io/vx/features/skipped-blockers/) · no post
- **Retries** (`--retry`, `exec.retries`) — re-run a failed task; a pass after a failure marks it flaky. [page](https://vznjs.github.io/vx/features/flaky-detection/) · post: [Flaky is a claim only declared inputs can back](https://vznjs.github.io/vx/blog/flaky-tasks/)
- **Timeouts** (`--timeout`, `exec.timeout`, `timeout`, `VX_TASK_TIMEOUT`) — kill and fail a runaway task. no post
- **Argument forwarding** (`--`) — args after `--` reach the task's command and fold into its key. no post
- **Task picker** — `vx run` with no task in a terminal lists tasks to pick. [page](https://vznjs.github.io/vx/features/task-picker/) · post: [The small things](https://vznjs.github.io/vx/blog/the-small-things/)
- **Typo hints** — an unknown task, project or filter suggests the nearest name. [page](https://vznjs.github.io/vx/features/filter-hints/) · post: [The small things](https://vznjs.github.io/vx/blog/the-small-things/)
- **Turbo and Nx spellings** (`-t`, `-p`, `--exclude`, `--parallel`, `--base`, `--dry-run`, `--skip-nx-cache`) — accepted, or refused naming the vx spelling. [page](https://vznjs.github.io/vx/features/turbo-nx-flags/) · post: [Flags you already know](https://vznjs.github.io/vx/blog/flags-you-already-know/)
- **Ctrl-C leaves nothing running** (`VX_KILL_GRACE_MS`, `VX_TEARDOWN_TIMEOUT_MS`) — the whole process tree stops, then teardown runs. [page](https://vznjs.github.io/vx/features/ctrl-c/) · post: [Ctrl-C leaves nothing running](https://vznjs.github.io/vx/blog/ctrl-c/)
- **Longest chain first** — the scheduler starts the critical path first; `@vzn/vx-schedule-history` learns it from past runs. [page](https://vznjs.github.io/vx/features/critical-path/) · post: [Bitsets, popcount, and a scheduler tick](https://vznjs.github.io/vx/blog/bitsets-and-the-scheduler/)
- **No daemon** — every run starts cold and still answers in milliseconds. [page](https://vznjs.github.io/vx/features/no-daemon/) · post: [No daemon, on purpose](https://vznjs.github.io/vx/blog/no-daemon/)
- **Group tasks** (`dependsOn` with no `exec`) — a task that only runs its dependencies; `dependsOn: []` is a named no-op. no post
- **Implicit keyed `build`** — a project with no `build` gets a `^build` group keyed on its files, so source-only packages still move their dependants' keys. no post
- **dependsOn syntax** (`^name`, `pkg#name`, `name.*`, `^name.*`) — upstream, cross-project and pattern edges. no post
- **Every name must resolve** — `vx run lint test typecheck` refuses to start if one name matches no project. no post
- **Tag filters** (`--filter tag:<pattern>`) — select projects by their config `tags`. no post
- **Directory and root filters** (`./<dir>`, `{<dir>}`, `.`, `//`) — select projects by path, or the root project. no post
- **Executor pools** (executor `capacity`) — a remote pool is admitted against its own width, not the laptop's cores. no post
- **Runs take turns** — two vx runs on one workspace wait on a lock and name who they wait for. no post

## Output

- **Framed output** — each task's log in its own frame, never interleaved. [page](https://vznjs.github.io/vx/features/framed-output/) · post: [A run you can read](https://vznjs.github.io/vx/blog/a-run-you-can-read/)
- **Output modes** (`--output-logs`) — full, errors-only, hash-only or none; the default follows the flow. post: [Output that fits the run](https://vznjs.github.io/vx/blog/output-that-fits-the-run/)
- **Run summary** — one block: projects, tasks, cache, time; nothing prints below it. [page](https://vznjs.github.io/vx/features/run-summary/) · post: [A run you can read](https://vznjs.github.io/vx/blog/a-run-you-can-read/)
- **Per-task table** (`--verbosity`) — a per-task summary after the run. no post
- **Failed output kept for agents** — a failure's full log is saved and pointed to. post: [Built for the agent at the keyboard](https://vznjs.github.io/vx/blog/built-for-agents/)
- **Markdown report** (`--report`, `--report-file`) — a run report for a PR or `$GITHUB_STEP_SUMMARY`. post: [Output that fits the run](https://vznjs.github.io/vx/blog/output-that-fits-the-run/)
- **Run JSON** (`--summarize`) — per-run JSON for scripts, with the time the cache saved (`savedMs`). no post
- **Trace profile** (`--profile`) — Chrome-trace JSON of the run. [page](https://vznjs.github.io/vx/features/profile/) · post: [Output that fits the run](https://vznjs.github.io/vx/blog/output-that-fits-the-run/)
- **Run tags** (`--tag`) — label a run; recorded in history. no post
- **Stage timing** (`VX_TIMING`) — vx's own stage table, for performance work. no post
- **Output flows** — what is printed follows the run's intent (focused, broad or CI); a truthy `CI` wins. post: [Output that fits the run](https://vznjs.github.io/vx/blog/output-that-fits-the-run/)
- **Cache-aware glyphs** — each task line's glyph shows ran, fresh, restored locally or remotely, failed, skipped or persistent. post: [Output that fits the run](https://vznjs.github.io/vx/blog/output-that-fits-the-run/)
- **GitHub Actions log groups** — on Actions, each task's block folds in a `::group::` with its outcome and time. no post
- **Colors** (`NO_COLOR`, `FORCE_COLOR`) — truecolor output, forced on or off by env. no post
- **Signal-named exits** — a failure reads `exit 137, 128 + SIGKILL`. no post
- **Plain output off a TTY** — no live region, and a missing task lists tasks instead of opening the picker. no post

## Plan and explain

- **Dry run** (`--dry`) — the task graph and the predicted hits and misses, text or JSON (with the predicted wall time and its critical path), nothing runs. [page](https://vznjs.github.io/vx/features/dry-run/) · post: [See the plan before you run it](https://vznjs.github.io/vx/blog/dry-run/)
- **Graph** (`--graph`) — the task graph as Graphviz DOT. no post
- **vx why** (`vx why`, `--run`) — why a task re-ran, down to the file, env var or config that changed. [page](https://vznjs.github.io/vx/features/vx-why/) · post: [Why did this re-run?](https://vznjs.github.io/vx/blog/why-did-this-rerun/)
- **vx show** (`vx show`) — every project, a project's or a task's live resolved config. [page](https://vznjs.github.io/vx/features/vx-show/) · post: [See what a task really is](https://vznjs.github.io/vx/blog/vx-show/)
- **vx last** (`vx last`, `--list`, `--failed`) — replay a recorded run's summary, or list recent runs. [page](https://vznjs.github.io/vx/features/vx-last/) · post: [The last run, on request](https://vznjs.github.io/vx/blog/vx-last/)
- **vx info** (`vx info`) — workspace doctor: versions, projects, cache size against `cacheRetention.maxSize`. post: [One command to know your workspace](https://vznjs.github.io/vx/blog/know-your-workspace/)
- **JSON everywhere** (`--format`) — `show`, `info`, `why`, `last` and `cache` print JSON for agents. post: [Built for the agent at the keyboard](https://vznjs.github.io/vx/blog/built-for-agents/)
- **Run analytics in SQLite** — every task's time, CPU, peak memory and cache result, queryable with `sqlite3`. post: [Built for the agent at the keyboard](https://vznjs.github.io/vx/blog/built-for-agents/)
- **Stable error codes** (`VX_E_…`) — under `--format json` a refusal is a JSON line on stdout with a code an agent branches on. post: [A refusal an agent can read](https://vznjs.github.io/vx/blog/error-codes/)
- **Shipped JSON Schemas** (`@vzn/vx/schemas/`) — every `--format json` shape has a schema, and stdout always parses. post: [Built for the agent at the keyboard](https://vznjs.github.io/vx/blog/built-for-agents/)
- **Docs for agents** (`llms.txt`, `llms-full.txt`) — the whole site as markdown for coding agents. post: [Built for the agent at the keyboard](https://vznjs.github.io/vx/blog/built-for-agents/)
- **Affected reasons** (`--affected --dry`) — each kept task says the changed file or the dependency chain that reached it, text or JSON. no post
- **Agent skill** (`skills/vx/SKILL.md`) — an installable skill that teaches a coding agent to run, debug and query vx. post: [Built for the agent at the keyboard](https://vznjs.github.io/vx/blog/built-for-agents/)

## Cache

- **Opt-in, explicit inputs** (`cache.inputs.files`) — a task caches only when it names its inputs. post: [Explicit over magical](https://vznjs.github.io/vx/blog/explicit-over-magical/)
- **Inputs** (`cache.inputs.env`, `cache.inputs.runtime`, `cache.inputs.tasks`, `cache.inputs.workspaceFiles`, `cache.inputs.workspaceRuntime`) — env vars, tool versions, upstream tasks and workspace files in the key. no post
- **Outputs** (`cache.outputs.files`, `cache.outputs.workspaceFiles`) — what a hit restores. no post
- **Outputs are exactly the snapshot** (`exclusiveOutputs`) — a hit leaves the tree as the run did; two tasks may not own one output without an edge. [page](https://vznjs.github.io/vx/features/strict-outputs/) · post: [The tree is exactly the snapshot](https://vznjs.github.io/vx/blog/strict-output-ownership/)
- **Keys from git's index** — tracked clean files hash by their blob id, no read. [page](https://vznjs.github.io/vx/features/keys-from-git/) · post: [Your cache key is already in git's index](https://vznjs.github.io/vx/blog/keys-from-git/)
- **Config keyed as evaluated** — the key sees the resolved config object. [page](https://vznjs.github.io/vx/features/typescript-config/) · post: [Configs are programs](https://vznjs.github.io/vx/blog/resolved-config-hashing/)
- **Cascade through inputs** — a task's key folds its upstream input keys, never outputs. post: [Cascade through dependencies](https://vznjs.github.io/vx/blog/cascade-through-inputs/)
- **Lockfile-aware keys** (`@vzn/vx-lockfile`: `pnpm()`, `bun()`, `npm()`, `yarn()`) — a bump re-keys only the projects whose closure changed. [page](https://vznjs.github.io/vx/features/lockfile-keys/) · post: [A lockfile bump should re-key two tasks](https://vznjs.github.io/vx/blog/lockfile-aware-keys/)
- **Upfront keys** (`upfrontKeys`) — refuses an input glob a same-project task's outputs could match, so every key is known before anything runs. no post
- **Cache controls** (`--no-cache`, `--force`, `--cache`) — off, refresh, or per-layer read/write. post: [The cache on your terms](https://vznjs.github.io/vx/blog/the-cache-on-your-terms/)
- **Cache location** (`--cache-dir`, `cacheDir`, `VX_CACHE_DIR`) — where the cache lives. post: [The cache on your terms](https://vznjs.github.io/vx/blog/the-cache-on-your-terms/)
- **Cache scope** (`cacheScope`, `VX_CACHE_SCOPE`) — trusted CI writes the remote cache; a laptop reads it. post: [The cache on your terms](https://vznjs.github.io/vx/blog/the-cache-on-your-terms/)
- **Cache pruning** (`vx cache prune`, `--older-than`, `--max-size`, `--dry-run`, `cacheRetention`, `maxSize`, `olderThan`) — evict by age or size, LRU. post: [One command to know your workspace](https://vznjs.github.io/vx/blog/know-your-workspace/)
- **Remote outputs** (`--download`) — all, top-level only, or none. no post
- **One store for every checkout** (`~/.vx/<id>/cache`) — clones and worktrees of a repo share cache entries. post: [The cache on your terms](https://vznjs.github.io/vx/blog/the-cache-on-your-terms/)
- **Warm hits restore nothing** — when outputs on disk already match, a hit costs a few stats. no post
- **Hits replay both streams** — stdout and stderr come back in the order the run printed them. no post
- **Restore lane** — cache restores run on their own lane, up to twice `--concurrency`. no post
- **Config evaluation cache** — provably pure `vx.config.ts` files are read back as data, not evaluated again. no post
- **Line-ending-correct keys** — files git filters (`eol`, `core.autocrlf`) key on the bytes the build sees. no post
- **Background remote uploads** — remote writes drain at the end of the run and never fail the build. no post
- **Bring your own remote cache** (plugin `cache`) — plug any cache server in through one interface. no post

## Correctness

- **Sandboxed tasks** (`exec.sandbox`: `allow`, `deny`, `ignore`, `weakerNetworkIsolation`, `weakerWhenNested`) — a task reads and writes only what it declares; `allow` names `read`, `write`, `network`, `unixSockets`, `localBinding`, `pty`, `systemInfo`, `gitConfig`, `machLookup`. [page](https://vznjs.github.io/vx/features/sandbox/) · post: [The sandbox](https://vznjs.github.io/vx/blog/the-sandbox/)
- **Env isolation** (`exec.env`: `define`, `passThrough`, `secret`) — a task sees only the env it names; secrets are masked. post: [A task sees only the env it names](https://vznjs.github.io/vx/blog/env-isolation/)
- **vx lock** (`vx lock`, `--check`, `--frozen`) — freeze what configs evaluate to; CI checks it. [page](https://vznjs.github.io/vx/features/vx-lock/) · post: [vx lock: freezing what the key sees](https://vznjs.github.io/vx/blog/lock-and-frozen/)
- **Flaky detection** — a task that fails then passes is reported flaky. [page](https://vznjs.github.io/vx/features/flaky-detection/) · post: [Flaky is a claim](https://vznjs.github.io/vx/blog/flaky-tasks/)
- **Project boundaries** — globs never cross into another project. no post
- **Artifact integrity checks** — a CRC-32, a key match and an outputs-only check on every artifact; damage is a miss. no post
- **Sandbox names what to grant** — a refused write is named beside the failed task with the path to allow. no post
- **Strict numeric flags** — `0x10`, `1e3` and `2.7` are refused, never reinterpreted. no post
- **Verified releases** — binaries carry provenance, `vx upgrade` checks SHA-256, npm publishes with provenance. no post

## Daily work

- **Watch mode** (`vx watch`, `VX_WATCH_POLL`) — re-run what a change affects, on content, not events. [page](https://vznjs.github.io/vx/features/watch/) · post: [Watch: a content gate](https://vznjs.github.io/vx/blog/watch-mode/)
- **Dev servers in the graph** (`exec.persistent`, `readyWhen`, `VX_READY_NOTICE_MS`) — a server is a node; dependents start when it is ready. [page](https://vznjs.github.io/vx/features/dev-servers/) · post: [Dev servers as graph nodes](https://vznjs.github.io/vx/blog/dev-servers-in-the-graph/)
- **Interactive tasks** (`exec.interactive`) — a task that owns the terminal. no post
- **Shell completions** (`vx completions`) — bash, zsh, fish. [page](https://vznjs.github.io/vx/features/completions/) · post: [The small things](https://vznjs.github.io/vx/blog/the-small-things/)
- **vx upgrade** (`vx upgrade`) — replace the binary with a release. [page](https://vznjs.github.io/vx/features/upgrade/) · no post
- **Help and version** (`vx help`, `vx version`) — every verb's reference. no post
- **Did-you-mean** — a mistyped flag or verb gets the nearest valid spelling. post: [The small things](https://vznjs.github.io/vx/blog/the-small-things/)
- **Task typed as a verb** — `vx build app` answers with the exact `vx run` command that does it. post: [The small things](https://vznjs.github.io/vx/blog/the-small-things/)

## Config

- **Config in TypeScript** (`vx.config.ts`, `defineProject`, `vx.workspace.ts`, `defineWorkspace`) — typed, composable; no named inputs. [page](https://vznjs.github.io/vx/features/typescript-config/) · post: [Config in TypeScript](https://vznjs.github.io/vx/blog/config-in-typescript/)
- **Tasks** (`tasks`, `exec.command`, `dependsOn`, `description`, `tags`) — one command per task; the shell is the API. post: [One command per task](https://vznjs.github.io/vx/blog/one-command-per-task/)
- **Workspace rules** (`rules`) — speed-only checks, on by default, configurable. no post
- **Config worker timeout** (`VX_CONFIG_WORKER_TIMEOUT_MS`) — bound a config's evaluation. no post
- **No nested runs** (`VX_RUN_TASK`, `VX_RUN_WORKSPACE`) — set on every task; a `vx run` inside a task of the same workspace is refused. no post
- **Typed config helpers** (`defineProject`) — autocomplete for task names in `dependsOn`, errors while you edit. no post
- **Presets** — a TypeScript function returning a task config, shared across projects. no post
- **Clean config errors** — a bad config fails at load naming the key, with no stack trace. no post

## CI

- **Results on GitHub** (`@vzn/vx-ci`: `github()`) — job summary and Checks API annotations. [page](https://vznjs.github.io/vx/features/github-ci/) · post: [Your run, on the pull request](https://vznjs.github.io/vx/blog/results-on-github/)
- **PR check run** (`github({ checks })`) — a check run on the commit with the run summary as its output. no post
- **Cache scope from the ref** (`github({ cacheScope })`) — main writes trusted keys; a PR writes only its own scope. post: [The cache on your terms](https://vznjs.github.io/vx/blog/the-cache-on-your-terms/)

## Adoption

- **Start in a minute** (`vx init`, `--dry`, `--force`, `--mjs`) — write `vx.workspace.ts` and one `vx.config.ts` per package. [page](https://vznjs.github.io/vx/features/quickstart/) · post: [Hello, vx](https://vznjs.github.io/vx/blog/hello-vx/)
- **Migrate from Turborepo or Nx** (`vx init`, `--native`, `--keep`, `@vzn/vx-migrate`) — native config, or keep `turbo()` / `nx()` as a start. [page](https://vznjs.github.io/vx/features/migrate/) · posts: [From Turborepo](https://vznjs.github.io/vx/blog/from-turborepo/), [From Nx](https://vznjs.github.io/vx/blog/from-nx/)
- **Keep a Turbo or Nx remote cache** (`turboCache()`, `nxCache()`) — reuse the cache server you have. no post
- **One binary** — one file, nothing to install underneath. [page](https://vznjs.github.io/vx/features/one-binary/) · post: [One binary](https://vznjs.github.io/vx/blog/one-binary/)
- **The playground** — vx's planner in the browser. [page](https://vznjs.github.io/vx/features/playground/) · post: [Try the planner in your browser](https://vznjs.github.io/vx/blog/the-playground/)
- **Benchmarks you can re-run** (`@vzn/vx-bench`) — vx against Turborepo and Nx. [page](https://vznjs.github.io/vx/features/fastest/) · posts: [Benchmarks you can re-run](https://vznjs.github.io/vx/blog/honest-benchmarks/), [Why vx is fast](https://vznjs.github.io/vx/blog/why-vx-is-fast/)
- **npm pre/post scripts** — `pre<x>` and `post<x>` hooks fold into `x`'s command when `vx init` maps scripts. no post
- **Vite Task adoption** (`bunx @vzn/vx-migrate`) — writes configs from vite-plus `run.tasks` as well as Turbo and Nx. no post
- **Nx executors as one process** (`nx-exec`) — any Nx executor runs as one vx task with its Nx env set. no post
- **Programmatic API** (`run`, `planRun`) — run or plan from your own scripts via `@vzn/vx`. no post

## Plugins

- **A pipeline with seams** (`plugins`, `definePlugin`; stages `config` `discover` `project` `graph` `key` `fingerprint` `schedule` `admit` `executor` `cache` `telemetry` `commands`) — every stage is a plugin seam. [page](https://vznjs.github.io/vx/features/plugins/) · post: [A pipeline with seams](https://vznjs.github.io/vx/blog/pipeline-with-seams/)
- **Write a plugin** (`vx init --plugin`) — scaffold a runnable plugin for a seam. [page](https://vznjs.github.io/vx/features/plugins/) · no post
- **The local floor** — running and caching here are core's, not plugins. post: [The local floor](https://vznjs.github.io/vx/blog/the-local-floor/)
- **Remote cache and execution** (`@vzn/vx-reapi`, `exec.remote`) — Bazel REAPI cache and workers; the scheduler stays here. [page](https://vznjs.github.io/vx/features/remote-execution/) · post: [Remote execution without moving the scheduler](https://vznjs.github.io/vx/blog/remote-execution/)
- **OpenTelemetry** (`@vzn/vx-otel`) — each run exported to your OpenTelemetry backend, never breaking it. [page](https://vznjs.github.io/vx/features/opentelemetry/) · post: [Observability that cannot break a run](https://vznjs.github.io/vx/blog/telemetry-never-breaks-a-run/)
- **vx mcp** (`@vzn/vx-mcp`, `vx mcp`) — cache stats, run history, `vx why`'s full answer, a run tool and a plan tool for coding agents. [page](https://vznjs.github.io/vx/features/mcp/) · post: [Give your coding agent the build's memory](https://vznjs.github.io/vx/blog/agents-and-mcp/)
- **vx prune** (`@vzn/vx-lockfile`, `vx prune`) — copy projects and their deps, lockfile pruned, for a Docker build. no post
- **vx history** (`@vzn/vx-schedule-history`, `vx history`) — what the scheduler learned per task. no post
- **Setup and teardown hooks** (`setup`, `teardown`) — plugin code around the run, bounded by a timeout. no post
- **REAPI TLS, mTLS and headers** — connect to hosted servers such as BuildBuddy the way Bazel does. no post
- **REAPI execution records** — a repeat remote execution skips the worker and replays outputs and stdout. no post
- **REAPI verified downloads and deadlines** — a corrupt blob or a wedged server degrades to a miss, never a hang. no post
- **Install as a remote action** (`exec.remote: 'only'`) — `node_modules` is built by an action, so stateless workers have it. no post
- **OTel live export** (`otel({ live })`) — spans and metrics stream as tasks end, so a dashboard follows a CI run live. no post
- **Memory-aware admission** (`@vzn/vx-schedule-history`) — tasks are packed by the peak memory learned from past runs. no post
