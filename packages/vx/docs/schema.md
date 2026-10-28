# Config schema

Complete reference for every field accepted by `vx.config.{ts,mts,js,mjs,cts,cjs}`
and the workspace-level `.vx/workspace.{ts,mts,js,mjs,cts,cjs}`, which is
required: it marks the workspace root (cli.md § The workspace root). The
authoritative TypeScript definitions live in `src/config.ts` and are
re-exported from `@vzn/vx`.

## File layout

```
<workspaceRoot>/
├── vx.config.ts                 (optional: the root project, named `//`)
├── .vx/
│   ├── workspace.ts             (required: marks the root; workspace-wide settings)
│   ├── projects.lock.json                (`vx lock`, minified; committed)
│   ├── .gitattributes           (`projects.lock.json linguist-generated=true`; written when missing)
│   ├── .gitignore               (`/cache`; written by `vx init` and the cache when missing)
│   └── cache/                   (machine-local state; the only part git ignores)
└── <any>/<dir>/
    ├── vx.config.ts             (this directory is a project; its tasks)
    └── vx.lock.json             (`vx lock`: its resolved config, pretty, for review)
```

**A project is a directory holding a `vx.config.*`**, in any language;
core reads no `package.json` and no package-manager member list. `vx lock`
finds them (git's tracked and unignored files; a config at or under a
nested `.vx/workspace.*`, ignored or not, is that workspace's) and records each by
directory; a run takes its projects from the lock, so a config added since
runs once `vx lock` records it. A `discover` plugin may add directories
with no config (`@vzn/vx-lockfile` adds the package manager's members).

A project's name is its config's `name`, else the name a `discover` plugin
gives (`@vzn/vx-lockfile` gives `package.json#name`), else its
root-relative path (`apps/web`); the root is `//`. Two projects of one
name are refused, naming both directories.

## Project config

```ts
import { defineProject } from '@vzn/vx/config'

export default defineProject({
  name: 'web',
  tags: ['scope:web', 'type:app'],
  tasks: {
    <taskName>: TaskConfig,
    ...
  },
})
```

```ts
interface ProjectConfig {
  name?: string // what `<name>#<task>`, filters and `dependsOn` address; no "#"
  tags?: readonly string[] // labels for `--filter tag:<name>`
  tasks?: Record<string, TaskConfig> // keyed by task name
}
```

`defineProject` is an identity function — it exists purely so
TypeScript narrows literal types in your config (clean autocomplete,
strict validation against the schema). It has zero runtime effect.
The same typing without a runtime import is
`import type { ProjectConfig } from '@vzn/vx/config'` plus
`export default { … } satisfies ProjectConfig` — the form `vx init`
and `@vzn/vx-migrate` generate, because Bun erases the type import and the
file then loads in a workspace that runs the `vx` binary without the
package installed. Either form is fine; the object is what vx reads.
`@vzn/vx/config` is the schema alone (`src/config.ts`, which imports
nothing): your own `tsc` checks that one file, where `@vzn/vx` would
walk core's Bun-only sources and fail without `@types/bun`.

The object is JSON data. The cache key folds `JSON.stringify` of each
task's config, `vx lock` stores the same JSON, and `vx watch` re-reads a
config through a worker that hands it back as JSON, so a value JSON
cannot carry would be dropped, rewritten or refused depending on the
path. vx refuses it on every path, before the schema: a function, a
symbol, a bigint, `NaN` or `±Infinity`, `undefined` inside an array
(JSON writes `null`), a cycle, a getter or setter (code that each read
may answer differently; vx never calls it), and any object that is not a
plain object or an array (a `Date`, `Map`, `Set`, `RegExp` or class
instance). An
`undefined` property is fine: JSON drops it and the schema reads it as
absent, which is what a conditional spread
(`...(ci ? { retries: 2 } : {})`) relies on. The workspace config is not
held to this: its plugins are objects of functions.

`tasks` is a `Record<string, TaskConfig>`. Task names are strings
referenced by `dependsOn`, by `inputs.tasks`, and by the CLI
(`vx run <taskName>` or `vx run <pkg>#<taskName>`), so a name those
could not spell is refused at load: an empty one, one with surrounding
whitespace, one holding `#` (the project separator) or `*` (a pattern),
and one starting with `^` (dependencies' tasks) or `!` (a negation).

`name` is refused at load when `dependsOn` or `--filter` could not
spell it: surrounding whitespace, a `#`, a `*` (a pattern), a leading
`^` (dependencies' tasks) or `!` (an exclusion), a leading `tag:`, a
leading or trailing `...` (a dependency walk), a trailing `[<ref>]` (a
git range), or a directory form (`./x`, `{x}`). A name a plugin gives
and a project's path name are held to the same rule.

`tags` label the project for selection: `--filter tag:<name>` selects
the projects carrying one (`cli.md` § Filter DSL), as Nx's `tag:` does.
Each is a non-empty string a tag filter can name, or it is refused at
load: no surrounding whitespace, no `*` (a pattern), and no ending in
`...` (a dependency walk) or `[<ref>]` (a git range). A
`project` plugin may set or edit them (`nx()` gives each project its Nx
`tags` unless the vx.config has its own). A tag is in no cache key: it
changes no task's behaviour, so editing one re-runs nothing.

## `TaskConfig`

```ts
interface TaskConfig {
  description?: string // one-line blurb for the picker / --dry view
  exec?: ExecConfig // omit to declare a group task
  dependsOn?: readonly string[] // Turbo/Nx micro-syntax
  inputs?: InputsConfig // what the task reads: its key, cached or not
  cache?: CacheConfig // caching is opt-in; needs `exec` and `inputs`
}
```

A task either has an `exec` (it does work) or omits `exec` and declares
`dependsOn` or `inputs` (it's a **group task**: an aggregator, or a key).
The loader rejects a task that has none of them — a no-op standalone
task is almost always a config mistake. `dependsOn: []` is the deliberate form: an
explicit empty group, for a package that wants a task by that name to
exist and do nothing.

A project whose config and plugins declare no `build` gets one
(2026-10-04): a group with `dependsOn: ['^build']` keyed on every file of
the project (`inputs.files: ['**']`, no outputs). It runs nothing,
but a dependant behind `^build` folds its key, so a package consumed as
source moves its dependants' keys and reaches them under `--affected`.
A config can declare a keyed group too (Group tasks, below). A
bare `vx run build` does not select it: run where no selected project
declares `build`, it is refused as any undeclared name is, while
`lib#build` names it and a dependant's `^build` reaches it. `vx show`
and `vx info` count it; `vx show build` and the `vx build` hint, which
name declared tasks, do not. Its `^build` needs an edge source as any
`^` does: with no plugin returning `deps`, running it is refused.

### `description` (optional)

```ts
description?: string
```

A short one-line blurb describing what the task does. No effect on
scheduling or execution, but it **does** participate in the cache key —
the key hashes the whole resolved task config (see `caching.md`, step 5),
and carving exceptions out of that object is what invites stale hits.
Editing a description therefore costs one re-run. Surfaced in three
places:

- The interactive task picker (`vx run` with no positional in a TTY) —
  printed to the right of each `pkg#task` id.
- The `--dry` text preview — printed on a second indented line under
  the cache-status row.
- The `--dry=json` output — `description` lives on each task entry.

```ts
test: {
  description: 'bun test against the tests/ tree',
  exec: { command: 'bun test' },
  inputs: { files: ['src/**', 'tests/**'] },
  cache: {
    outputs: { files: [] },
  },
}
```

### `exec` (optional — required for non-group tasks)

`exec` is the one command a task runs, and how: its environment,
time limit, retries and where it may run. A task without `exec` is a
group ([below](#group-tasks-no-exec)).

```ts
build: {
  exec: { command: 'tsc -b', timeout: '5m', env: { define: { NODE_ENV: 'production' } } },
}
```

```ts
interface ExecConfig {
  command: string // shell command, run from the project's dir
  remote?: boolean | 'only' // placement: pin here, or remote-only (see below)
  platforms?: readonly Platform[] // the machines it can run on, any of them (see below)
  env?: ExecEnv // optional per-task env layering
  timeout?: Duration // '30s', '2m': before vx SIGTERMs the child (see below)
  retries?: number // max additional attempts after a failure (see below)
  persistent?: PersistentConfig // long-running task (dev server, watcher)
  interactive?: boolean // reads the terminal: a prompt, a REPL (see below)
  sandbox?: SandboxConfig // opt-in OS sandbox for this command
}
```

`command` is a string. Run via `sh -c` (`dash` on macOS, as Linux's
`sh` is), so POSIX
shell semantics work directly — pipes, redirects, `&&` chaining:

```ts
exec: {
  command: 'tsc -b'
}
exec: {
  command: 'gen && tsc && cp -r assets dist/'
}
exec: {
  command: 'find src -name "*.snap" | xargs rm -f'
}
```

CLI args after `--` are appended to `command`, each POSIX single-quoted
unless it holds only safe characters:

```sh
vx run test -- --bail 'a b'
# child sees:   bun test --bail 'a b'
```

Forwarded args are folded into the cache key — different args produce
distinct cache entries.

#### `timeout` (optional)

Maximum time before vx SIGTERMs the child, as a duration string: a
number and a unit, `ms`, `s`, `m`, `h` or `d` (`'500ms'`, `'2m'`). A bare
number is refused by `vx lock`. Omitted → no limit.

```ts
build: { exec: { command: 'tsc -b', timeout: '2m' } }
```

- For a **normal task**, `timeout` bounds the total run time, counted
  from the spawn (a sandbox's setup, its wrap included, is vx's, not the
  task's). A task
  that overruns is killed — its whole process group, so what it forked
  goes with it — and reported `failed` (timed out) — never cached. (A timeout SIGTERM is a real failure, distinct from a Ctrl-C
  teardown, which is reported `aborted`.)
- For a **persistent task**, `timeout` bounds the **readiness wait**
  instead: if `readyWhen` hasn't matched within the window the child is
  SIGTERMed and the task fails — see `persistent` below. A persistent
  task that's ready on spawn (no `readyWhen`) becomes ready before the
  timer can fire, so the timeout is a no-op for it.
- On a **plugin executor**, the timeout aborts the request's `signal`
  instead (core cannot kill a process the executor spawned); any exit
  after it is reported timed out, a 0 from a child that trapped the stop
  included (X-125), and an executor still running after the kill grace
  is abandoned (H-12, H-14).

**Upper bound.** `timeout` must be at most **2147483647 ms (~24.8 days)** (`'2147483647ms'`),
the largest delay a timer can hold. A larger value does _not_ mean "no
limit" — the platform silently reduces it to **1 ms**, so the task would
be killed the moment it spawns and reported `failed`. vx refuses it at
load rather than let that happen. **Omit `timeout` entirely for no
limit.** The same bound applies to `--timeout` and to the workspace-level
`run.timeout` and the `VX_RUN_TIMEOUT` env rung: past it, each is refused
under its own name.

A task with **no** `exec.timeout` falls back to a run-level default, if
one is set. Precedence, highest first: **per-task `exec.timeout` →
`--timeout <duration>` / `RunOptions.timeout` → `VX_RUN_TIMEOUT` →
workspace `run.timeout`** (see workspace config below). Per-task always
wins. The run-level defaults are threaded as run options, so — like
`--retries` — they never touch a cache key: a `--timeout` run cache-hits a
plain run's entry.

**Why no multi-step `commands: string[]`?** Per-task caching is the
right granularity for invalidation. If you'd benefit from caching each
step independently (e.g. `codegen` then `build`), split into two
tasks linked by `dependsOn`. If you don't need that, `&&` in shell is
the right tool.

#### `retries` (optional)

Maximum ADDITIONAL attempts after a failed attempt. `retries: 2` means
up to 3 executions total. `0` / omitted → no retries (fail on the first
non-zero exit).

```ts
test: { exec: { command: 'bun test', retries: 1 } }
```

- A retry fires after ANY failure, `timeout` kills included. A Ctrl-C
  teardown (`aborted`) is never retried — the run is tearing down.
  Nor is a task in flight when `--continue=never` stops the run: its
  attempt finishes, and its failure is the last, even when its retry
  was already announced and preparing.
- Declared outputs are re-cleaned before each retry, exactly like the
  first attempt — a failed attempt's partial outputs can't leak into
  the next.
- Every attempt streams its output live. Between attempts vx emits one
  stderr line into the task's stream, ending in the reason:
  `vx: retrying <id> (attempt <k>/<total>) after exit <code>`, or
  `after a timeout` when the attempt was killed by `timeout`.
- The final outcome is the LAST attempt's: the first success wins (and
  is what gets cached — its output only, not a concatenation of failed
  attempts); if every attempt fails, the task is `failed` with the last
  exit code and nothing is cached, as today.
- The task's reported duration sums every attempt; a saved entry keeps
  the producing attempt's time.
- `retries` is part of the resolved config, so declaring it derives a
  distinct cache key (like every config field); tasks without it keep
  byte-identical keys.
- Not allowed with `persistent` — a persistent task has no exit to
  retry (config error, like `cache` + `persistent`).

The run-level default is `run.retries` (`vx run --retries <n>`, `VX_RUN_RETRIES`) — it applies to tasks
that don't declare their own `retries`, never to a persistent one (a
server that fails before it is ready fails at once); explicit config
always wins, including an explicit `retries: 0`. The CLI flag never
affects cache keys.

#### `remote` (optional)

```ts
remote?: boolean | 'only' // default true
```

**Placement.** `false` pins the task to the machine that started the run:
it is never offered to an executor that declared itself `remote`. Use it
for a task that talks to something only this machine has — a local
daemon, a Docker socket, a device, a VPN-only host.

```ts
'docker:build': {
  exec: { command: 'docker build -t app .', remote: false },
}
```

- **Only meaningful with a remote executor declared.** A workspace with
  no executor plugin already runs everything here, so the field changes
  nothing.
- **Lifted by an `exclusive` executor.** One that runs every task
  elsewhere (`@vzn/vx-dte`) takes this task too, and every pin below.
- **Pinned by inference too.** A `persistent` task, and anything that
  depends on one (transitively), is pinned regardless of what it
  declares — a worker cannot reach a port served on the submitter —
  unless the executor starts the server where it runs the dependant
  (`@vzn/vx-dte`: each worker starts it once, beside its dependants, and
  the orchestrator never does; a server with a `sandbox` or
  `exec.remote: false` stays here). So is
  a task with a `sandbox` block, and its dependants: the sandbox is this
  machine's machinery, and a boundary a worker does not enforce would
  pass vacuously; an executor that enforces it where it runs
  (`@vzn/vx-dte`) is offered them. So is a task whose key folds `inputs.runtime` or
  `workspaceRuntime`: the key holds this machine's answer, which a worker
  cannot prove it shares. Its dependants are not pinned.
- **Placement is decided once per task**, before scheduling, so the
  scheduler knows which pool a task will occupy (see
  [execution.md](execution.md#executor-pools)).
- **`'only'` is the inverse pin — the install-as-action recipe.** The task
  exists to produce a REMOTE input tree (canonically `pnpm install` feeding
  remote workers) and is a NO-OP on this machine: never executed locally,
  its declared outputs never cleaned or restored on this disk. With a remote
  executor declared it runs on a worker, its outputs stay in the remote
  store, and dependents' input trees reference them there — the bytes flow
  worker→store→worker without ever transiting the submitter. With no remote
  executor it succeeds without running and dependents use the machine's
  ambient state (the dev's own `node_modules`), exactly as before the field
  existed. An `'only'` task must declare `cache` — its inputs are what a
  worker reproduces and its key is the address of its remote record. One
  without is refused at load.

  ```ts
  install: {
    exec: { command: 'bun install --frozen-lockfile', remote: 'only' },
    inputs: { files: ['package.json', 'bun.lock'] },
    cache: {
      outputs: { files: ['node_modules/**'] },
    },
  },
  build: { dependsOn: ['install'], /* … */ },
  ```

- **Never busts a cache:** `remote` is stripped from the cache key —
  `'only'` included, and it is the only `exec` field that is. The contract of a remote executor
  is that the same command over the same inputs produces the same outputs,
  so a key that moved with placement would split a laptop from a worker pool
  over nothing.

#### `platforms` (optional)

```ts
platforms?: readonly Platform[] // 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64'
```

The machines this task can run on, any of them. Omitted, it runs anywhere.

```ts
import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    'ios:build': {
      exec: { command: 'xcodebuild -scheme App', platforms: ['darwin-arm64', 'darwin-x64'] },
    },
  },
})
```

- **Locally**, a task whose platforms leave this machine out is skipped,
  never failed, and so is everything that depends on it. The run stays
  green and says why, once and on the task's row:

  ```
  [vx] skipped on linux-x64, with what depends on them: app#ios:build needs darwin-arm64 or darwin-x64
  ⊘ skipped  app#ios:build • needs darwin-arm64 or darwin-x64, this is linux-x64
  ```

  A `run()` outcome and telemetry carry it as `otherPlatform: { needs, host }`; a
  dependant's `blockedBy` names the task (in `vx last --format json` too).

- **On CI** (`CI` or a provider's variable set) every task runs or the run
  fails: one whose platforms leave the machine out refuses the run before
  any task starts. Run a target that holds only this platform's tasks, or
  one DTE run with a worker of each platform.
- **With an executor that routes by platform** (`@vzn/vx-dte`, whose
  worker sizes each name a `platform`), the task
  runs on a worker of one of its platforms: this machine's if the
  executor has one, else the first it lists that the executor has. A task
  none of whose platforms the executor runs refuses the run before
  anything starts. Other remote executors are never offered it.
  `@vzn/vx-dte` runs a task naming none on this machine's platform when
  it has workers of it, so a worker of another platform runs only the
  tasks that name it and leaves once they are done.
- **In the key:** the list is config, and the platform the task runs on is
  folded too, so each platform keeps its own entry. A task that names no
  platforms keys as before.
- Names are fixed (`os-arch`, as Bun's compile targets); any other
  refuses the config at lock.

#### `persistent` (optional)

```ts
interface PersistentConfig {
  readyWhen?: string // regex (as string); first matching line marks ready
}
```

Marks the task as a long-running process — a dev server, a file
watcher, a daemon. The runner spawns the command but does NOT wait
for it to exit. Instead it considers the task "ready":

- Immediately on successful spawn when no `readyWhen` is given.
- On the first stdout/stderr line that matches the `readyWhen`
  regex string. Each line is tested on its own, without its line
  break (`\n`, `\r\n` or a bare `\r`) and without terminal escapes
  (colour, OSC titles), so `^` and `$` anchor to a line as you read
  it and `Local:` matches Vite's bold `Local` under `FORCE_COLOR`.
  The trailing partial line is tested too, so prompt-style banners
  without a newline (`printf 'Listening on :3000'`) count, and so does
  output read up to 250 ms after the shell exits. A server
  not ready after 10 s is said once, naming
  the pattern it waits for, and whether `exec.timeout` bounds the wait.

```ts
dev: {
  exec: {
    command: 'vite',
    timeout: '30s', // bound the readiness wait
    persistent: { readyWhen: 'Local:' },
  },
}

watch: {
  exec: {
    command: 'tsc --watch --preserveWatchOutput',
    persistent: { readyWhen: 'Watching for file changes' },
  },
}

// No readyWhen — ready as soon as spawn succeeds. Useful for daemons
// that have no observable "ready" signal but downstream doesn't need
// to gate on one.
agent: {
  exec: {
    command: 'my-agent --daemon',
    persistent: {},
  },
}
```

Semantics:

- **Downstream unblocks on ready, not on exit.** Useful for e2e tests
  that need a dev server up first:
  ```ts
  'dev:run':  { exec: { command: 'vite', persistent: { readyWhen: 'Local:' } } },
  'e2e':      { dependsOn: ['dev:run'], exec: { command: 'playwright test' } },
  ```
- **Not started when nothing needs it.** A persistent task you did not
  request, whose every dependant is a confirmed cache hit, local or
  remote, is never spawned: a fully cached `vx run e2e` does not boot the server
  `e2e` depends on, and the server is in no outcome or count. Behind a
  remote cache, the server waits for the remote's answer on the
  dependants the local store missed, and starts at the first miss. It starts
  if one of those hits turns out to need running (its artifact went),
  and that task runs once it is ready. A dependant whose key the
  server's writes could change (one in its own project, unless a sandbox
  bounds the server's writes) is not probed ahead of it, so there the
  server still starts. `vx run --dry` says so: such a server is
  `not started` (`not-started` in `--dry=json`), not `would exec`.
- **Exit before ready.** A persistent task that exits 0 before
  `readyWhen` matches is ready: a setup step (migrate, seed) that did its
  work, and its dependants run. One that crashes or exits non-zero first
  is reported as `failed`.
- **Crash after ready ⇒ failed run.** A persistent task that exits
  non-zero (or is killed) on its own after it became ready fails the
  run, and vx names it: `vx: <id> exited with code <n>` (a signal death
  as its `128 + n` code), at once while the graph still runs (`… while
the run went on`), so a dependant failing against it reads why. Its own outcome is `failed` with that exit
  code, and the footer counts it so (item 1071). An exit 0 on its own is
  fine (a daemon that forks and returns), and one kept only as a
  dependency does not end the foreground hold (WD-3).
- **End-of-graph SIGTERM.** Once the rest of the graph finishes
  (success OR failure of downstream), the orchestrator sends `SIGTERM`
  to every persistent subprocess it does not keep, and waits for them to
  exit (`SIGKILL` past the kill grace). In the foreground it KEEPS the
  persistent tasks you requested, those a requested group stands for,
  and the persistent tasks they depend on: vx stays up after the summary
  until one of them exits or you press Ctrl-C, streaming what they write.
  A run where anything else failed keeps none and exits 1, unless
  `--continue=always` (`cli.md` § Output, "Pinned persistent tasks").
- **`cache` is rejected.** The config loader throws on
  `cache + persistent` — persistent tasks don't terminate, so there's
  no exit code to cache and no outputs to capture at a well-defined
  moment.

#### `interactive` (optional)

`true` hands the task the terminal: a prompt (`drizzle-kit push`), a
REPL, a watch mode that reads keys. Turbo's `interactive`.

- **On a TTY** (vx's stdin is one) the task gets vx's own stdin,
  stdout and stderr. Its output is not framed, masked, kept or
  replayed: it goes to the terminal as the task writes it. A frame
  line opens before it and closes after (`--output-logs full`, and
  the default views), and the live status region goes for the rest
  of the run, as it would repaint over a prompt.
- **Alone.** It starts once nothing else runs, and nothing starts
  until it exits. A persistent one holds the terminal from its spawn
  to the run's end, so other tasks may run once it is spawned (their
  output goes to the same terminal), a run may hold one, and every
  other interactive task must be its dependency. A run that breaks
  either is refused before any task runs.
- **Off a TTY** (CI, a pipe) it runs as any task: stdin is empty, or
  a pipe vx holds for a persistent one, and it runs beside others.
  A prompt there reads end of input; it never hangs.
- **Here, never cached.** No executor plugin is offered it, and
  `cache` is refused. `sandbox` is refused (a sandboxed task's
  output passes through vx), and so is `persistent.readyWhen` (vx
  reads none of its output; it is ready once spawned).
- It runs in its own session, as every task does, so a tool that
  opens `/dev/tty` itself rather than its stdin still cannot, and
  the terminal's resize signal does not reach it. Ctrl-C reaches vx,
  which stops the run; a task that puts the terminal in raw mode
  reads the key itself.
- **Its terminal modes end with it.** vx reads them (`stty -g`)
  before the task starts and puts them back when it exits, so a task
  killed in raw mode, or one that never undid its `stty raw -echo`,
  leaves no terminal without echo or Ctrl-C behind it
  (`tests/terminal.unsafe.test.ts` › "a task that leaves the terminal
  raw"). Without `stty` on PATH the modes stay the task's.

```ts
'db:push': {
  exec: { command: 'drizzle-kit push', interactive: true },
}
```

#### `ExecEnv` (optional)

```ts
interface ExecEnv {
  passThrough?: readonly string[] // names taken from host process.env; exact names, a wildcard is refused
  define?: Record<string, string> // explicit name=value pairs
  secret?: readonly string[] // names whose values are masked (`***`) whatever the name; see Masking
}
```

The child process sees a deliberately limited env. From lowest to
highest priority:

1. **Essential allowlist** (hard-coded in `src/exec/env.ts`, and pinned
   against this list by a test): `PATH`, `HOME`, `SHELL`, `USER`,
   `LOGNAME`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, `LC_ALL`, `LC_CTYPE`,
   `TERM`, `COLORTERM`, `FORCE_COLOR`, `NO_COLOR`, `CI`, `NODE_OPTIONS`,
   `COREPACK_HOME`, `PNPM_HOME`.
   Nothing else from the parent environment reaches a task —
   that is the whole list. When neither `FORCE_COLOR` nor a non-empty
   `NO_COLOR` reaches the task by any layer, vx sets `FORCE_COLOR=1`
   (its own output strips the colour where it prints plain; `docs/cli.md`
   § Colors). Without these, typical CLI tools break. vx
   adds two markers of its own on top, `VX_RUN_WORKSPACE` (the root of
   the workspace running the task) and `VX_RUN_TASK` (`project#task`):
   a task whose command shells out to `vx run` in that same workspace
   is refused — a loop back to itself forks a run per run without
   bound, and a nested run that terminates is still invisible to the
   outer graph (its tasks escape the schedule, the concurrency budget
   and the cache key); declare it with `dependsOn`. Driving a
   _different_ workspace from a task (a fixture suite, a benchmark) is
   fine. **_NOT_ folded into the cache key** — the
   same rule `passThrough` states below, and for the same reason.

   Read that carefully if your build's _output_ depends on one of
   them, because three can change what a task produces:
   **`NODE_OPTIONS`** (`--require` / `--import` / `--loader` /
   `--conditions` inject code or switch package-export resolution),
   **`LC_ALL` / `LANG`** (collation — anything shelling out to `sort`
   orders differently), and **`CI` / `FORCE_COLOR` / `TERM`** (output
   bytes, and vx caches and replays output).

   They are not hashed because hashing them would mean a laptop and a
   CI runner could **never share a remote cache entry** — `PATH`,
   `HOME` and `TERM` differ on every machine, which is the whole point
   of a remote cache. vx does not guess which ones matter to your
   build; if one does, say so explicitly:

   ```ts
   inputs: { files: ['src/**'], env: ['NODE_OPTIONS'] }, cache: { outputs: { files: [] } }
   ```

   That folds its value into the key. The two axes are orthogonal on
   purpose: `inputs.env` decides what the key _sees_,
   `exec.env.passThrough` decides what the child _gets_.

2. **`passThrough`** names → value taken from host `process.env` at
   spawn time. A project config cannot set one for it: a first load
   that writes `process.env` is refused (D-76). _NOT_ folded into the cache key — for secrets,
   regional values, CI flags that legitimately vary between machines.
3. **`define`** → explicit literal values. _ARE_ folded into the
   cache key via the task config hash (the values are in your config
   file, so they participate naturally).

```ts
exec: {
  command: 'bun test',
  env: {
    passThrough: ['CI', 'GH_TOKEN'],  // values forwarded; cache-invariant
    define: { NODE_ENV: 'test' },      // literal; in the cache key
  },
}
```

Every name in these lists (and in `inputs.env`) must be one an
environment can hold: non-empty, with no `=` and no NUL, and a `define`
value holds no NUL. Such a name is refused at load; it used to reach the
child split at its `=` or not at all. A `passThrough` or `define` name is
also a shell variable name, `[A-Za-z_][A-Za-z0-9_]*`: the task runs under
`sh -c`, and dash (Linux's `sh`) drops any other name from the environment
it hands the command, so `my.var` reached a task on macOS and never on
Linux. `inputs.env` takes any such name: the key reads it from vx's
own environment.

vx also sets `npm_execpath` to the workspace's package manager (the root
`package.json`'s `packageManager`, else its lockfile, found on the root's
`node_modules/.bin` or `PATH`) unless a layer gives one, so a tool that calls the manager back finds
it. It names a binary on this machine, so it is not in the key.

Anything outside these three layers, the two variables vx sets for
the run (`VX_RUN_WORKSPACE`, `VX_RUN_TASK`) and `npm_execpath`, is absent from the child's environment:
a host credential (`SSH_AUTH_SOCK`, `GITHUB_TOKEN`) reaches a task only
when `passThrough` names it, held end to end by `env.test.ts` (a
sandboxed task with a restricted network also gets the sandbox's own
proxy, CA and temp-directory (`TMPDIR`, `TMP`, `TEMP`) values over these names:
`modules/sandbox-runtime.md` § The environment SRT sets). This
matches Turbo's `passThroughEnv` semantics and exists for two reasons:

- **Cache stability.** If every host env var entered the key, every
  shell with a different `PS1` would cache-miss.
- **Determinism.** If host env leaked into the child, two machines
  with different `FOO=bar` set would produce different outputs and
  the user would never know why.

This is hygiene, not a boundary: an unsandboxed task runs as you, so it
can read your files. vx hides its own environment from a task
(`modules/util-hide-env.md`), not your files. Only `exec.sandbox` keeps them out (`security.md` § What the sandbox stops).

**Masking.** The value of a variable whose name holds `TOKEN`, `SECRET`,
`KEY`, `PASSWORD`, `PASSWD` or `CREDENTIAL` (vx's own environment or a
task's `define`, six characters or more; not a name ending `_FILE`,
`_PATH` or `_DIR`, nor git's `GIT_CONFIG_KEY_<n>`) is printed as `***` wherever vx
shows it: the task's output and the line vx adds under a shell's 127 or
126 (the command's first word), the stdout the cache keeps and a hit
replays, the command a cache entry stores (what `vx why` prints and a
remote cache receives), the `$ command` line, telemetry records,
`vx show`, the hashes `vx why` gives for such a variable in
`inputs.env` (its value, unsalted: the row names it and its change), an executor's error, a plugin's warning or failure (a remote's reply; the failure masked in the error `run()` rejects with), a failed `inputs` runtime probe's error (its command and output), and the run's own invocation line that `vx last` prints (a
secret passed after `--`). So are every string of a
task `vx show` prints (a runtime probe, `readyWhen`, the description),
the description `--dry` and the task picker print, a runtime probe's
command as the run history stores it and `vx why` names its row (two
probes that mask alike are numbered, `echo *** (2)`), the readiness
notice's pattern, a sandbox violation line,
the error a verb ends on (a plugin's failure, a config's own throw) and
`vx watch`'s `cycle failed` line. A multi-line value (a PEM
key) is also masked line by line, each line of six characters or more,
and a value holding a `'` also as a shell-quoted line spells it (`'\''`).
A value
split across two output chunks is still caught; the output holds back
that many characters until the next chunk. On screen the hold lasts
25 ms, so a value written in two pieces with a longer pause between
them shows; every stored copy (the entry a hit replays and a remote
cache receives, the failure record `vx last` reads) is masked again
whole and never holds it. A plugin that reads a task's
config directly sees it as written. A secret whose name holds none of
those words (`GH_PAT`, `NPM_AUTH`) is listed in `exec.env.secret`, and is
then masked in the same places.

Two `node_modules/.bin` directories are prepended to `PATH` so
installed tools (`oxlint`, `vite`, etc.) run by name: the
project's own, then the WORKSPACE ROOT's, where a monorepo's shared
tooling lives. Never a sibling project's, so sibling bins stay invisible
(project isolation). A directory whose path holds `:` (PATH's delimiter)
cannot be named in PATH and is left out; a task's 127 then says so.

### `dependsOn` (optional)

Tasks that must complete successfully before this task runs.
Turbo/Nx-style micro-syntax — a flat array of strings:

```ts
dependsOn?: readonly string[]
```

| Form         | Meaning                                                                         |
| ------------ | ------------------------------------------------------------------------------- |
| `'name'`     | Same-project task `name`.                                                       |
| `'^name'`    | The `name` task in the nearest project deps (a plugin's edges) that declare it. |
| `'pkg#name'` | The `name` task in a specific other package (cross-project edge).               |
| `'name.*'`   | Every OTHER same-project task matching the pattern (`*` = any).                 |
| `'^name.*'`  | All matching tasks of the nearest deps that declare any (pattern).              |

Examples:

```ts
dependsOn: ['build'] // same-project build first
dependsOn: ['^build'] // build in every workspace dep first
dependsOn: ['codegen', '^build'] // both
dependsOn: ['lib#build', 'shared#test'] // cross-project edges
dependsOn: ['lint.*'] // every lint.<x> task in this project
dependsOn: ['^build.*'] // all build.<x> tasks of the nearest deps
```

Semantics:

- **Same-project (`'name'`)** — name must exist in this project's
  `tasks` map; missing is a hard error at graph-build time. When the
  config is authored through `defineProject`, a bare entry is also
  **type-checked against this config's task keys** — a typo is a
  compile error (`'^name'` / `'pkg#name'` reference other projects
  and stay free strings).
- **`'^name'`** — nearest-holder frontier. Walk the project graph
  from this project's direct deps: the edges a plugin's `discover`
  returns as `deps` (the lockfile plugins `bun()` / `pnpm()` / `npm()` /
  `yarn()` return what the package manager installed; core reads no
  edge from a `package.json`). A cross-project `pkg#task` edge is not
  one: it widens `--filter '...pkg'` and `--affected`, never a `'^name'`
  walk. With no plugin returning `deps` the workspace has no edge source and
  a `'^name'` is refused (`VX_E_DEPENDS_ON`: "`^build` needs project
  edges; add pnpm()/bun()/npm()/yarn() and install so its lockfile
  exists, or a plugin that returns `deps`"): it would resolve to nothing and fold no upstream into the
  key. With one, a project with no deps is a leaf; each path stops at the first dep
  that declares the task and an edge is added to it (Turbo/Nx
  direct-deps parity). The holder's own `dependsOn` is responsible
  for anything deeper — chain `'^name'` in the holder to keep the
  cascade going (the universal pattern). Deps that don't declare the
  task are passed through, so a sparse dep doesn't break ordering to
  deeper packages that do (sparse tasks across a workspace are normal
  — not every package has a `lint`). Finding no holder at all is legal
  too, as long as SOME project in the workspace declares `name`: a
  preset spreads `'^build'` over packages whose deps have no `build`.
  A `'^name'` that **no project in the whole workspace declares** is a
  hard error at graph-build time, since it can only be a typo: "app#test:
  dependsOn ^biuld but no project in the workspace declares
  biuld. Did you mean ^build?" (a same-project name that is not
  declared names the project's nearest task the same way). Until 2026-09-24 it resolved to no edges and the run went
  green (Nx#32779 is the same bug). A scoped run (an anchored
  `app#test`, `--filter`, a project directory) loads only its projects
  and their dependency closure; when a `'^name'` there finds no holder
  and nothing loaded declares it, vx evaluates the remaining configs to
  decide, and if one of them fails to load the name is let through
  rather than failing the scoped run. A `'^name.*'` pattern matching
  nothing anywhere stays legal, as `'name.*'` does.
- **`'pkg#name'`** — missing pkg or task is a hard error (you named
  them explicitly). `'//#name'`, Turbo's spelling of the root package,
  names the root project (D-39) here and in `inputs.tasks`; with no
  root project it is refused as such.
- **Patterns (`'name.*'` / `'^name.*'`)** — `*` matches any run of
  characters in a task NAME; everything else is literal (the dotted
  namespace convention needs no escaping). A same-project pattern
  expands to every other matching task (the declaring task never
  matches itself); **zero matches is legal** — a preset-spread pattern
  needn't match in every project. A `'^pattern'` walks the same
  nearest-holder frontier as `'^name'`, where a holder is a dep
  declaring at least one matching task; the holder receives edges to
  ALL its matches and stops the walk. Patterns are not supported in
  the `'pkg#task'` form. (Nx 19.5 `build-*` parity.)
- **No bare wildcards or negation here.** `'*'` / `'^*'` (or `'**'`, any run of `*`) / `'!form'`
  belong in `inputs.tasks` (filtering which upstream hashes
  participate in this task's cache key), not in `dependsOn` (declaring
  graph edges). The micro-syntax parser rejects them in this position.
- **Cycle detection** runs across the resolved graph at the end of
  `buildTaskGraph`. Cycles throw with a path-formatted message.

### `inputs` (optional)

`inputs` lists what a task reads: files, environment variables and
command outputs. The cache key is built from them.

```ts
build: {
  exec: { command: 'tsc -b' },
  inputs: { files: ['src/**', 'tsconfig.json'], env: ['NODE_ENV'] },
}
```

```ts
inputs?: InputsConfig
```

What the task reads, and so what its key folds. A task is keyed on its
inputs whether it caches or not, as Turbo and Nx hash every task: a
dependant folds that key, so an edit to an uncached generator's inputs
re-runs the cached task behind it. A group with `inputs` is a keyed
group (Group tasks, below). The default `build` is
`{ dependsOn: ['^build'], inputs: { files: ['**'] } }`.

A task that runs a command and declares no `inputs` has no key: nothing
says what it read. A key that folds it is this run's alone, so every
task behind it misses and saves nothing, never a stale hit. Declare
`inputs` on an uncached task a cached one depends on;
`inputs: { files: [] }` is a declaration too: it keys the task on its
config and its dependencies' keys, and a task behind it can hit. An
absent `inputs` and an empty one differ.

#### `InputsConfig`

```ts
interface InputsConfig {
  files: readonly string[] // required
  workspaceFiles?: readonly string[] // optional; workspace-root-relative
  env?: readonly string[] // optional
  runtime?: readonly string[] // optional; project-dir shell commands
  workspaceRuntime?: readonly string[] // optional; workspace-root shell commands
  tasks?: readonly string[] // optional; same micro-syntax as dependsOn
}
```

##### `inputs.files` (required)

Project-relative globs. `!`-prefix negates. A **literal** entry (no
glob character) names a file or a whole directory tree — `src` and
`src/` both mean everything under `src`, as in Turbo and `.gitignore`;
`!src` subtracts the tree. A `!` entry subtracts wherever it sits in the
list, so a literal file it covers (`['src/**', '!src/gen/**',
'src/gen/keep.ts']`) would never be an input: that is refused at load.
Spellings a matcher would otherwise turn into
nothing are normalized: a leading `./` (`./src/**` is `src/**`, `!./gen`
is `!gen`), an inner `/./` segment, a doubled `//`, and a trailing `/` on
a pattern (`src/*/` is the trees under `src`, `src/*/**`). A bare `.` or
`./` names the project directory itself and is refused at load — write
`**`. Turbo's `$TURBO_DEFAULT$` and `$TURBO_ROOT$` and Nx's
`{projectRoot}`, `{workspaceRoot}`, `{projectName}` and `{options.…}`
(D-52), pasted from turbo.json or
project.json, are refused in every glob list with what to write instead
(D-50): vx expands none of them, so each matched no file and a task
keyed on `$TURBO_DEFAULT$` alone replayed a stale output. A glob that
starts with `^` (Nx's `^production`, the dependencies' named input) is
refused too (D-51): vx keys a task on its dependencies through
`dependsOn`. A bare named input (`default`) can be a directory, so it
is taken as one and only warns when it matches nothing.

The wildcards are `*`, `**`, `?`, a character class `[ab]` (`[a-z]`,
`[!a]`) and a brace set `{a,b}`, which matches what its alternatives
match on their own: `{src/**,lib/**}` is `src/**` plus `lib/**`. A
backslash escapes: a route directory (Next.js, SvelteKit, Astro) is
`app/\[id\]/**`; bare, `app/[id]/**` is the class that matches `app/i`
and `app/d`, never the route. An input brace of one alternative (`{b}.ts`) is refused at `vx
lock`: it would match `b.ts` and never a file named `{b}.ts`; write the
one you mean, `\{b\}.ts` for the braces. So is an input under `.git`
(`.git/config`): git never lists it, so it would key nothing. An extglob (`@(a|b)`, `!(x)`,
`+(…)`, `*(…)`, `?(…)`) is refused too: vx's own matchers read it as
literal text or a plain wildcard, so the key would miss the files it
names; write `{a,b}`. So is a bare group holding a `|` (`src/*.(js|ts)`):
`Bun.Glob` reads its parens and bar as literal text; write `src/*.{js,ts}`.
Parens with no `|` (`app/(marketing)/**`) are filename characters and
stay. A brace range is `Bun.Glob`'s (Bun 1.4.4):
`{1..3}`, `{3..1}`, `{01..03}`, `{a..c}`, `{1..10..3}`; vx expands it as
a comma brace. A mixed-case range (`{A..c}`) or one of more than 1024
names is refused wherever it sits in the glob. A leading `!` is still the negation, so `!(group)/**`
takes a route group back. This holds for every task glob — `inputs.files`,
`inputs.workspaceFiles`, `outputs.files`, `outputs.workspaceFiles` — and
for everything read from them (`--affected`, `vx watch`, the
overlapping-output refusal). Package-manager member globs (`workspaces`,
`pnpm-workspace.yaml`) and `--filter` path globs keep the package
manager's grammar — all but extglob (`packages/!(x)`),
which a member glob refuses by name: `Bun.Glob` cannot read it, and
list the exclusion as its own `!packages/x` entry instead.

```ts
files: ['**/*'] // all project files
files: ['src/**', '!**/*.test.ts'] // narrow with exclusion
files: [] // no file inputs at all
files: ['src/**', 'tsconfig.json', 'package.json'] // specific paths
files: ['src', 'package.json'] // a directory literal is its tree
files: ['app/\\[id\\]/**'] // the route dir `[id]`; bare `[id]` is a class
```

Empty array is valid — the cache key still incorporates command, env,
upstream hashes and any plugin's key material. A task with no _file_
inputs (e.g. a pure "download-and-verify") still cache-misses on a
lockfile change when a lockfile plugin (`@vzn/vx-lockfile`) is declared.

Always applied to every glob pass (regardless of what you wrote):

- **gitignore filter** — workspace-root + project `.gitignore`, unless
  an entry names the ignored path outright: a literal (`.env.local`), or
  a glob whose fixed prefix git ignores (`dist/**`, `dist/*.js`,
  `.cache/gen/**`), which is then walked on disk under that prefix only.
  A directory git ignores but for a file it lists (`gen/*` with
  `!gen/.gitkeep`, or `gen/` with a force-added file) counts as ignored:
  `gen/**` reads the untracked files beside the kept one.
  Each alternative of a brace counts on its own: `{gen/a.txt,gen/b.txt}`
  names both files and `{gen,out}/**` both trees, as `gen/{a,b}.txt` does.
  Such a file is hashed from disk and never stored or restored; a
  missing one is not an input until it exists. A broad glob (`**`,
  `src/**` over a listed `src`) still skips ignored files, so it never
  walks `node_modules`.
  Its bytes differ per machine, so machines with different files miss
  each other's shared entries. An ignored file never selects a task
  under `--affected` on its own, as in Nx (only what git sees does); `vx
watch` re-runs it on an edit there.
- **Always-ignored** — `.git/**`, `.vx/cache/**`,
  `.vx/projects.lock.json`, `vx.lock.json`, and `.vx/tmp/**`, where vx's
  restores stage, only where vx writes them: at the project's root (a
  project's own `src/.vx/tmp/x` or `src/sub/vx.lock.json` is an input),
  and for `workspaceFiles` every project's `vx.lock.json`. The run's
  cache directory (`cache.dir`, `--cache-dir`) wherever it sits in the
  workspace, even under an ignored prefix a glob names outright
  (`tmp/**` over `tmp/vx-cache`). Nothing else: a tool's temp files are the
  task's to exclude. A broad glob on a `bun build --compile` task, or on
  one that runs beside it, excludes Bun's intermediate and its
  cross-compile extraction directory itself:
  `['**/*', '!**/*.bun-build', '!**/.????????????????-????????.tmp/**']`.
- **Installs** — an untracked file under any `node_modules/` that git
  does not ignore. An ignored one follows the gitignore filter above
  like any other ignored path: named outright, it is an input
  (`node_modules/.prisma/client/**`, a generated client); a broad glob
  skips it because it is ignored. A file git TRACKS there, such as a committed test fixture, is an input
  like any other.
- **Declared `outputs.files`** are excluded — a task never invalidates
  itself via its own output. A path an output `!` entry takes back is
  no output, so it stays an input (A-44). Another task's outputs are
  not excluded for you: an input glob that can match them is refused
  (X-54), unless git ignores them whole, or the producer is a
  dependency the key does not fold (see Inputs over outputs in §
  Settings). Write the exclusion,
  `['**/*', '!dist/**']`, or ignore `dist/`. An input entry the task's OWN outputs take
  back whole is always refused (X-55): vx removes outputs before a run,
  so a formatter declaring `src/**` as both would delete its sources. A
  task that rewrites files in place declares no outputs.
- **Nested-project subtree** — files belonging to a project rooted
  inside this one's dir are excluded. No cross-project leakage via
  globs; the only cross-project relationship is `dependsOn` +
  upstream-hash propagation.

##### `inputs.workspaceFiles` (optional, default `[]`)

Workspace-root-relative globs — the Turbo `$TURBO_ROOT$` / Nx
`{workspaceRoot}` equivalent, for inputs that live outside the project
dir (a root `tsconfig.base.json`, shared codegen output, …). Same
syntax as `files` (`!` negation subtracts, in any order), same git-aware
resolution (tracked + untracked-not-ignored; a gitignored file only when
named outright, as in `files`), and the resolved paths join the same
cache-key file list.

```ts
inputs: {
  files: ['src/**'],
  workspaceFiles: ['tsconfig.base.json', 'shared/**', '!shared/README.md'],
}
```

**No boundary rule — deliberate escape hatch.** Unlike `files`,
`workspaceFiles` globs may match files anywhere in the workspace,
including inside other projects' directories. That's bad practice
(prefer project-relative declarations plus `dependsOn` + upstream-hash
propagation for cross-project relationships), but it is there for the
cases that genuinely need root-anchored inputs. The hard
project-boundary rule continues to apply to project-relative `files`
globs only.

No input or output glob, `files` or `workspaceFiles`, may be absolute
or hold a `..` segment, and a brace arm counts: `{../shared,src}/**` and
`{/etc,src}/*` are refused at load, where the glob engine would have
matched nothing under that arm and said so nowhere. A Windows spelling
is refused the same way, with the forward-slash glob to write: a
backslash separator (`src\**`, `src\*.ts`) or a drive (`C:\src\**`,
`C:/src/**`). A backslash before a bracket, a brace, a `!` or a
backslash stays an escape.

Still applied: the always-ignored set (`.git/**`, `.vx/cache/**`,
`.vx/projects.lock.json`, `vx.lock.json`, `.vx/tmp/**`),
untracked files under `node_modules/`, and the task's own declared
outputs, `outputs.workspaceFiles` and the `outputs.files` its globs reach
in its own project (a task never invalidates itself).

`vx watch`: when any config declares `inputs.workspaceFiles`, the loop
watches the workspace root recursively (any file can be an input once
boundaries are off), so root-subdir changes re-trigger cycles like any
other edit. The always-ignored set still filters the noise.

##### `inputs.env` (optional, default `[]`)

Env var names whose host values are folded into the cache key.
**Independent of `exec.env`:**

- Listing a name in `exec.env.passThrough` does NOT make its value
  affect the cache.
- Listing a name here does NOT forward it to the child process.

To both forward AND track, list it in both places. Yes, the
double-declaration is mild noise; a preset helper
(`envTracked('NODE_ENV')`) can sugar it.

Names are exact: a wildcard (`NEXT_PUBLIC_*`) is refused, and so is
Turbo's `!NAME` exclusion, here, in `exec.env.passThrough` and in
`exec.env.secret` (D-53). With no wildcard to take it out of, `!NAME`
was a variable of that name, and nothing was excluded.

```ts
inputs: {
  files: ['src/**'],
  env: ['NODE_ENV', 'TARGET_BROWSER'],  // changes here bust the cache
}
```

A cache-input env var the task actually reads must ALSO appear in
`exec.env.passThrough` (or `define`) — the child environment is
isolated, so without it the key varies on a value the command never
sees. Tracking-only declarations (an env var that influences inputs
some other way) are legal but rare; if in doubt, declare both.

An unset name, a name set to the empty string, and a name never
listed are three different keys: the key holds the count of names,
the names, and each value, with "unset" folded apart from every value
(the child tells unset from empty too — `process.env.X ?? 'dflt'`,
`${X-dflt}`). A name holding a NUL is refused.

##### `inputs.runtime` (optional, default `[]`)

Shell commands whose **trimmed stdout and stderr, kept apart,** are folded
into the cache key — the runtime-output analog of `inputs.env`. It runs
in the project dir; the Nx
[`runtime` input](https://nx.dev/recipes/running-tasks/configure-inputs),
which Nx runs at the workspace root, is `workspaceRuntime` below (Turbo
has no built-in for this — see
[vercel/turborepo#4124](https://github.com/vercel/turborepo/issues/4124)).
Use it for tool/runtime versions, OS info, or a project-local probe
script whose value should bust the cache when it changes.

```ts
inputs: {
  files: ['src/**'],
  runtime: ['./scripts/probe.sh', 'rustc --version'],
}
```

Semantics:

- Each command runs in the **project dir** (cwd = the project's
  directory), via `sh -c`, so pipelines and redirects work ("shell is
  the API"). Deduped per `(projectDir, command)` within a run — a
  command declared by both `build` and `test` in the same project runs
  once.
- The **output is resolved live at hash time on every run** (inside
  `resolveInputs`), exactly like `inputs.env` reads host env values
  live. `vx lock` freezes the command _strings_ (they're in the
  resolved config), not their output, so the field stays correct under
  the lock every run reads — the changed output of a locked command
  still busts the cache.
- A **non-zero exit fails the run** (a hard `UserError` naming the
  command and exit code) — fail-loud, like a missing git binary. A
  flaky probe should not silently degrade to a stale hit.
- **Output that is not UTF-8 fails the run** too: a lossy decode keyed
  every invalid byte alike. Pipe binary output through a hash or `od`.
- The command sees **only the essential environment** every task sees
  (the essential allowlist under `ExecEnv`: `PATH`, `HOME`, the locale), with
  vx's values. Not the task's `exec.env.define` or `passThrough`, which
  describe the command's environment, not the probe's; one environment
  for every probe is what lets two tasks sharing a probe share one spawn
  (the per-run dedup above). Not vx's other variables either: a task
  could read them from the probe's `/proc/<pid>/environ` while it runs.
  A value the probe would read from the environment is an `inputs.env`
  name instead.
- Its `PATH` does lead with the **same `node_modules/.bin` directories
  the task's does** (the project's, then the workspace root's), so
  `tsc --version` keys the `tsc` the task runs. Before item 996 it keyed
  the global one, or failed with 127 where only the workspace had it, and
  a changed local tool replayed the old output.
- The command **runs whenever a task's key is derived** — that's every
  run (warm runs included, since the key decides hit vs miss), plus
  `vx run --dry` (which predicts the key) and `vx run --no-cache`
  (which still derives the key). Keep runtime commands pure
  probes with no side effects.
- The command runs as part of **hash derivation, before** the task's
  `exec` — so it is **not** constrained by the task's own `sandbox`
  policy (the probe runs unsandboxed even on a sandboxed task).

##### `inputs.workspaceRuntime` (optional, default `[]`)

Like `runtime`, but commands run at the **workspace root** (cwd = the
workspace root) and are deduped **globally per command** across the
whole run — a `node -v` declared in 500 projects spawns exactly once.
The runtime-input analog of `workspaceFiles`: per-task, root-anchored.
Use it for global tool versions, OS info, or any probe whose value is
the same for every project. Its `PATH` leads with the workspace root's
`node_modules/.bin` only (no project's: the value is shared by all).

```ts
inputs: {
  files: ['src/**'],
  workspaceRuntime: ['node -v'], // runs once per run, root cwd
}
```

Same `sh -c` execution, live-at-hash-time resolution (frozen-safe), and
non-zero-exit-fails semantics as `runtime`. The two fields are folded
into the cache key in **distinct namespaces**, so an identical
`(command, output)` pair never aliases between them.

##### `inputs.tasks` (optional, default = all upstream)

Same micro-syntax as `dependsOn`, plus two filter-only extras:

| Form         | Meaning                                        |
| ------------ | ---------------------------------------------- |
| `'*'`        | Include every same-project upstream hash.      |
| `'^*'`       | Include every dep-workspace upstream hash.     |
| `'name'`     | Include same-project task `name`.              |
| `'^name'`    | Include `name` in every dep workspace.         |
| `'pkg#name'` | Include the specific package's `name` task.    |
| `'!<form>'`  | Exclude — any of the above with a leading `!`. |

**Patterns** work here too, in EITHER half of every form:
`'build.*'`, `'^build.*'`, `'pkg#build.*'`, `'@acme/*#build'`,
`'!codegen.*'` — the same `*`-glob `dependsOn` patterns use. A filter
only ever selects from upstreams that already exist, so a package
pattern is unambiguous here, unlike `dependsOn`, which must
materialize concrete edges and rejects it. (A filter that matched
patterns literally would silently select zero hashes and decouple the
task from its dependencies — a stale-hit trap.)

Patterns are applied in order; **last write wins**. So
`['*', '^*', '!^noisy']` reads as "all upstream except deps' noisy
task". Defaults:

- **Omitted** → all upstream contribute (`['*', '^*']`). Most common.
- **`[]`** → fully decoupled; no upstream contributes.

An **exact** entry (`'codegen'`, `'^build'`, `'lib#build'`) must be
named by some `dependsOn` entry of the same task — exactly, or by that
entry's own `*` pattern (`dependsOn: ['build.*']` names
`tasks: ['build.bun']`), and in a form that reaches the same task:
`build` is this project's, `^build` only the dependencies', so
`tasks: ['build']` against `dependsOn: ['^build']` names nothing. A
`pkg#task` entry may be this project or a dependency, so it pairs with
either form; two `pkg#task` entries must agree on the project. One that
is not named (`['buidl']`) is refused at load: it would match nothing at hash time and fold no upstream hash,
decoupling the task from its dependencies with no diagnostic — a stale
hit waiting for the next upstream change. An exact entry is held again once the
graph is built, when the run plans: one that names none of the task's
dependencies is refused (`['nope#build']`, or `['a#build']` for a
project named `packages/a`, over `dependsOn: ['build']`; `['build']`
over another project's `['b#build']`; `['^build']` over this project's
own), unless a `^` entry or a pattern in `dependsOn` names its task,
which a preset's project may legally lack. Patterns, wildcards and
negations stay silent (a preset-spread pattern legitimately matches
nothing in some projects); `[]` is the explicit way to decouple.

A filter selects among the task's own dependencies, never through a
group: over `dependsOn: ['build']`, where `build` is a group of
`build.a` and `build.b`, the filter sees `build`, not its members. A
pattern that matches no dependency but does match a group's member
(`'build.*'` there) is refused when the run plans: it would select
nothing and stop the key moving with that member. Name the group, or
depend on the member directly.

Examples:

```ts
tasks: ['^build'] // only ^build from deps; nothing from self
tasks: ['codegen', '^*'] // self.codegen + everything from deps
tasks: ['*', '^*', '!^noisy'] // all upstream except deps.noisy
tasks: ['lib#build'] // a single cross-project hash
tasks: [] // fully decoupled
```

**When to use this:** when a task `dependsOn`s another for ordering
(it has to run after) but the upstream's outputs do NOT affect this
task's outputs. Typical case: an integration-test task `dependsOn`s
`build` for ordering, but its inputs are only the test source — so
`inputs.tasks: []` to keep `build` from invalidating it.

### `cache` (optional)

`cache` makes a task cached: `outputs` lists what it writes, which a
hit restores. A task with no `cache` block always runs.

```ts
build: {
  exec: { command: 'tsc -b' },
  inputs: { files: ['src/**', 'tsconfig.json'] },
  cache: { outputs: { files: ['dist/**'] } },
}
```

```ts
interface CacheConfig {
  outputs: CacheOutputs // required when `cache` is provided
  inputStability?: InputStability // optional
}

interface InputStability {
  strategy?: 'immutable' | 'mutable' | 'unchecked' // default 'immutable'
  severity?: 'warn' | 'error' // default 'warn'
}
```

`inputStability` says what a write to an input while the command runs
means. `strategy` says which writes count:

- `'immutable'` (the default, on CI too): any write. An edit undone
  mid-run, or another task changing the file and putting it back, cannot
  be told from no edit.
- `'mutable'`: a file rewritten to the bytes the key folded counts as
  unchanged, for a task that rewrites its own input identically
  (tsdown's `package.json`); different bytes still count, and so does
  any write while another task that may write the file was running (one
  of the same project, or one whose sandbox grants writes elsewhere in
  the workspace; a server `vx watch` keeps from an earlier run counts),
  since it may have changed the file and put it back.
  The line names that task; order the two with `dependsOn` to save.
- `'unchecked'`: none. The entry is saved under the key taken before the
  command, whatever the command did to its inputs; `severity` is ignored.
  A key that no longer held before the command started still withholds
  it.

A write that counts withholds the entry, and `severity` says what else
happens: `'warn'` (the default) keeps the result, says why on the status
line, and the run goes on; `'error'` fails the task, so the run fails,
and its label names the file: `failed (src/a.ts changed during the run, exit 1)`
(`inputMoved` in `vx last --format json`).
Either way, every task that ran over the task's outputs, down the graph,
withholds its save too, and a task of any project that declares the
moved file as an input withholds its own.

Each field is resolved on its own, highest first:

1. `VX_CACHE_INPUT_STABILITY_STRATEGY` (`immutable`, `mutable`,
   `unchecked`) and `VX_CACHE_INPUT_STABILITY_SEVERITY` (`warn`, `error`), for the whole run
   (a CI job that wants `error` sets it without editing configs); any
   other value is refused before a task runs;
2. the task's own `cache.inputStability`;
3. the workspace's `inputStability` (`.vx/workspace.ts`);
4. the default, `'immutable'` and `'warn'`.

Never folded into a cache key.

```ts
import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    build: {
      // tsdown rewrites package.json with the same bytes on every build;
      // different bytes fail the run rather than rebuild next time.
      exec: { command: 'tsdown' },
      inputs: { files: ['src/**', 'package.json'] },
      cache: {
        outputs: { files: ['dist/**'] },
        inputStability: { strategy: 'mutable', severity: 'error' },
      },
    },
  },
})
```

**Caching is opt-in.** Omit `cache` and the task always runs (no read,
no write). Provide it and caching is active for that task. The
project loader requires `exec`, the task's `inputs` and `cache.outputs`
when `cache` is set: declaring "what does this read?" and "what does
it produce?" is a deliberate, conscious choice, and a task with no
command produces nothing to cache.

**Why opt-in?** Defaulting caching to ON with implicit "all files / no
outputs" silently produces stale builds the moment a user forgets
to revisit the config. The cost of a single forgotten cache miss
(re-run a task) is much less than the cost of a stale cache hit
(ship broken artifacts).

#### `CacheOutputs`

```ts
interface CacheOutputs {
  files: readonly string[] // required
  workspaceFiles?: readonly string[] // optional; workspace-root-relative
  clean?: boolean // optional; false keeps outputs on a miss
}
```

Project-relative globs of files the task produces. Captured on cache
write, restored on cache hit (overwriting any local modifications),
and **wiped before exec AND before restore** so the project dir ends
every run bit-identical to the cached snapshot. A literal entry names
a file or a whole directory tree: `dist` and `dist/` are `dist/**`
(the turbo.json shape `"outputs": ["dist"]` migrates as it is); a
leading `./` is accepted and dropped; `.` alone is refused.

```ts
outputs: {
  files: ['dist/**']
} // typical build output
outputs: {
  files: []
} // tasks with no file output (lint, test)
outputs: {
  files: ['dist/**', 'coverage/**']
}
```

Outputs are **NOT** filtered through gitignore — typical artifact
dirs like `dist/`, `coverage/`, `.next/`, `pkg/` are captured normally
even when gitignored (they usually are).

A **symlink** the globs match is an output: it is cached and restored
as the link, its target as written (a link to a file, to a directory,
or to nothing yet), and the clean unlinks it (never following it). No
byte of its target is read. A link must be relative and lead somewhere
inside the workspace: an absolute one, or `../../../etc/hosts`, fails
the save by name and caches nothing, so the next run executes again. An
output DIRECTORY that is a symlink (`dist -> real-out`) is followed: its
target is cleaned, saved and restored as the output; one that resolves
outside the project refuses the task, naming the link. The clean also prunes the directories it
emptied, so an output that is a directory one run and a file the next
restores either way.

Empty `[]` is valid for tasks that produce no files (e.g. `lint`,
`typecheck`, `test`); you still cache the no-op success so the next
run is a no-op too.

**`clean: false`** keeps the outputs on a miss instead of wiping them
first, for a tool that reads its own last output (tsc's
`.tsbuildinfo`). It opts out of the clean-tree guarantee: the save
stores every file the outputs match after the run, so a file an older
build left behind is cached and restored on every machine. A retry
still starts clean, and a hit still restores bit-identically. Omitted → the workspace's
`cache.outputs.clean`, else `true`.

A **`!` entry takes a path back** from what the positive globs select
(A-44; a scratch dir under `dist` stays out of the clean this way; a
tracked file needs no `!`, below):

```ts
outputs: {
  files: ['dist/**', '!**/*.tmp']
}
```

A path taken back is not cleaned before a run or a restore, not saved,
not accepted from a remote artifact, and not hidden from `vx watch`;
it stays an input, so an edit to it moves the key. A list of only `!`
entries selects nothing and is refused, and `!!x` is refused as it is
for inputs. The directory short-circuit on a warm hit reads the
positive globs, so a task with a `!` entry keeps it (A-46).
`workspaceFiles` takes `!` the same way.

**Cleaning semantics** (one of vx's strict-output-ownership rules):

- Before exec on a cache miss: the declared output globs are resolved
  and matching files / dirs are wiped. So a leftover `dist/old.js`
  from a prior build can't survive into a fresh build that doesn't
  rewrite it.
- Before restore on a cache hit: same wipe, then files are copied
  from the cache entry into the project dir. The post-restore tree
  is the cached snapshot, byte-for-byte.
- A file git tracks is never wiped (2026-10-14). It is still saved and
  restored, and is in the task's key even when no `inputs.files` glob
  reaches it, so an edit to it moves the key.

Skipped when `cache.outputs.files` is empty (nothing declared as
output) and when no cache-write axis is enabled (e.g. `--no-cache`,
or a read-only `--cache-policy=local:r`) — the user is debugging and
managing the tree themselves. `--force` keeps writes on, so it does
clean.

##### `outputs.workspaceFiles` (optional, default `[]`)

Workspace-root-relative globs for outputs the task writes OUTSIDE its
project dir (e.g. a root-level generated file). Same capture / restore
/ wipe semantics as `files`, anchored at the workspace root; packed
into the artifact under a separate `workspace-outputs/<rel-to-root>`
namespace so project and workspace outputs never collide. A project
`outputs.files` glob under a top-level `workspace-outputs/` is refused
at load: that name is the namespace. A file another glob matches there
(`**/*.js`) is refused at save, and the task is not cached.

```ts
outputs: {
  files: ['out.txt'],
  workspaceFiles: ['generated/**'],
}
```

**No boundary rule — deliberate escape hatch.** These globs may
capture (and on restore, overwrite; on clean, wipe) files anywhere in
the workspace, including inside other projects' dirs. Prefer
project-relative `files` whenever the task can write inside its own
dir. Two tasks whose workspace outputs provably overlap (equal
literals, or a literal a glob matches) are refused at graph build, like
overlapping `files`: vx cleans declared outputs before a run and before
a restore, so the second would delete the first's. The comparison is by
PATH, not by spelling — `./dist/**` and `dist/**` are one declaration,
and so are `dist//**` and `dist/./app.js` (item 441) — and a literal
entry is read as the file OR its whole tree, the same rule the resolver
uses, so `dist` collides with `dist/app.js` (item 442). A whole subtree
collides with any glob whose literal head lies inside it: `dist/**` with
`dist/extra/**` or `dist/*.js` (item 941). Two globs a path built from
either one matches are one too: `**/*` and `**/dist/**` both match
`x/dist/x`. A pair is no overlap where one task's `!` output entry
takes the other's glob back whole: `['**/dist', '!types/**']` beside
`types/**` (a `!` entry is never cleaned or captured). Globs that only _might_
overlap (`dist/*` and `dist/sub/**`) are let through; there, last
restore wins. A workspace output is also compared with every other
project's `files` outputs, read from the root: `packages/b/dist/a.txt`
collides with `b`'s `dist/**` (item 1088). An overlap
between two tasks one of which depends on the other is refused too,
unless the workspace sets `run.rules.exclusiveOutputs: false` (X-53);
then the dependant is additive and owns only what its run adds to the
tree (`caching.md` § Additive outputs, item 588). Across the two namespaces
an upstream `files` task is told the dependant's globs in its own
project's terms, so a workspace glob that does not start inside that
project (`**/a.txt`) is refused even with the edge.

### `exec.sandbox` (optional)

Opt this command into an OS-level sandbox. A persistent task runs
inside it too — enforced, but with no violation report, since the report
reads the trace after the child exits and a server exits only at
teardown. **Opt-in per task — omit it and the command runs
unsandboxed.** Full walkthrough in the
[sandboxing guide](https://vznjs.github.io/vx/docs/sandboxing/).

```ts
interface SandboxConfig {
  allow?: SandboxGrants // what the command may do
  deny?: { network?: string[] } // domains to refuse, run-wide (below)
  ignore?: SandboxIgnore // violations to leave out of the report
  weakerWhenNested?: boolean // Linux: let a sandboxed task sandbox (default false)
  weakerNetworkIsolation?: boolean // macOS: host-proxy net, lower isolation (default false)
}

interface SandboxGrants {
  read?: readonly string[] // paths or globs, project-relative or absolute
  write?: readonly string[] // paths or globs; a write grant is readable too
  network?: true | readonly string[] // an allowlist of domains; `true` adds none (below)
  systemInfo?: readonly string[] // sysctl names, e.g. 'vfs.disk-space'; each grants system-info and sysctl-read (macOS)
  unixSockets?: true | readonly string[] // AF_UNIX bind/connect, all or by path (Linux: any path)
  localBinding?: boolean | readonly number[] // bind and reach localhost ports (macOS; Linux needs no grant); a list also exposes them to the host (a port the host or another running task already holds fails the task)
  machLookup?: readonly string[] // mach global-names (macOS)
  pty?: boolean // acquire a TTY
  gitConfig?: boolean // write the repository's .git/config (this task only)
}

interface SandboxIgnore {
  read?: readonly string[] // denied reads to leave out of the report
  write?: readonly string[]
  systemInfo?: readonly string[]
  network?: readonly string[] // '<host>:<port>'
}
```

One shape describes what a task may do; vx translates it into a seatbelt
profile on macOS and bwrap mounts plus seccomp on Linux. `ignore` takes
patterns per class a denial is reported in — `read`, `write`,
`systemInfo`, `network` — so a noisy probe is silenced with the grant
that would have permitted it; any other name is refused. Every grant is
the task's own: `unixSockets` (or a `localBinding` port list, whose
bridge is a unix socket) lifts the `socket(AF_UNIX)` block for the task
that declares it, never for the run's other sandboxed tasks. On Linux
the block is the kernel's answer to the call itself, so it is reported
nowhere: the task reads only its tool's own `socket(1, 1, 0): Operation
not permitted` (a Docker, ssh-agent or database socket), and the grant
is `unixSockets`:

```ts
exec: {
  command: 'bun build --compile --target=bun-linux-arm64 src/bin.ts --outfile dist/vx',
  sandbox: {
    allow: {
      read: ['.'],
      // A cross-compile target the Bun cache lacks is fetched from npm,
      // extracted into `<cwd>/.<hash>-00000000.tmp/` and moved into the cache.
      write: ['dist/vx', '~/.bun/install/cache/', '.*.tmp/**'],
      network: ['registry.npmjs.org'],
      systemInfo: ['vfs.disk-space'],
    },
    ignore: { write: ['*.bun-build'] },
  },
}
```

**Globs.** `read` and `write` accept patterns. On macOS the pattern
reaches the policy and matches files created during the run; on Linux a
grant is a mount, so the pattern is expanded when the task starts and a
file created later is not covered — grant its directory instead. On both
platforms `<dir>/**` and `<dir>/**/*` collapse to `<dir>`, so
`read: ['**/*']` lets a task list its own cwd; a `<dir>` that is itself a
glob keeps its subtree (`.*.tmp/**` covers what is inside each match).
As in a task glob, `[id]` is a class, so a Next.js route is granted escaped, `read: ['pages/\\[id\\].tsx']`.
On Linux a WRITE path holding a bracket, `*` or `?` cannot be mounted
(the runtime drops it): vx says so once, names the directory above it to
grant instead, and a write under it is refused and reported. A READ path
whose name holds `*` or `?` (granted escaped, `a\\*b.txt`) cannot be
granted alone either — the runtime would grant its siblings too — so vx
leaves it out, says so once, and a read of it is refused and reported.
A Linux grant of either kind holding a backslash is left out the same
way: Bun's `realpath` refuses such a path, and the runtime mounts none
it cannot resolve.

A Linux WRITE grant that matches nothing when the task starts therefore
mounts nothing. Where a read grant mounts its directory, the task's first
write under it fails with `Read-only file system` — a message naming
neither vx nor the grant — so vx reports that grant itself before the
task runs, once, and names the directory to grant instead, spelled as
the config spells it (`allow: { write: ['gen/'] }`). Where no mount
holds the directory, it is the sandbox's own scratch, the one mask left
writable: the task may create, write and remove what the glob matches
(anything else it writes there too), and nothing it leaves there
outlives the task. That is right for a tool's temp directory and
wrong for an output. A read grant matching nothing is ordinary
(an optional file, a cache not yet populated) and is not reported. A
pattern under a directory that does not exist yet matches nothing the
same way, where the scan once failed the task with a bare `ENOENT` (B-6).

**A write grant's shape.** A write path that does not exist yet is
created before the task starts (a mount needs something to bind), and a
literal names a FILE: `write: ['dist/vx']` is an empty `dist/vx` the
build overwrites. A directory the task will create is spelled with a
trailing slash — `write: ['coverage/']` — or as a glob (`'dist/**'`);
outside the project (`'~/.bun/install/cache/'`) only these two shapes are
created, never a file.
Spell a directory as a bare literal and the task's own `mkdir` meets
"File exists" ("Not a directory" for a path inside it, `mkdir -p
coverage/lcov`); the failure then says so, names the `dir/` spelling, and
vx removes the empty file it made (it takes back any placeholder the
task never wrote, so an unwritten one is never archived as an output).
A grant that leaves the project through a symlink is refused: the grant
binds the path it names, and vx follows no link out of the project. So
is one whose bind would make `.git`, `.vx/cache`, the cache directory or a
nested project writable, and one inside `.git`, `.vx/cache` or the cache
directory (`../.git/hooks/` would plant a hook that runs unsandboxed):
a file grant at a single-package workspace's root binds the root. A
directory grant is judged as the directory, made before the judgement
when it does not exist yet, so `dist/` or `dist/**` at that root stands.

**A write grant is readable, and on Linux it reads WIDER than it looks.**
A write path is readable too (`tsc --incremental` re-reads its own
`.tsbuildinfo`). On Linux a grant is a mount and bwrap cannot rename onto
an active file mount — every atomic writer stages beside its target and
renames — so a FILE-shaped grant is bound as its DIRECTORY. That
directory is then readable AND writable in full: with
`write: ['out.txt']` in the project root, every file in the project root
can be read. Such a read succeeds, so there is no denial; vx reports it
from the trace instead, as a violation: a read of anything that was in
that directory when the task started and that no grant covers, the
directory's listing included. The declared file and what the task made
there itself stay readable. Put declared outputs in a subdirectory and
the rest stays denied outright. macOS matches paths rather than
mounting, so a file grant stays exact there. Pinned in
`tests/sandbox-grants.unsafe.test.ts` (2026-09-20) and
`tests/sandbox-widened-reads.unsafe.test.ts`.

**A `network` entry is a host pattern**: `example.com`, `*.example.com`,
either with a port (`example.com:443`), or `localhost`. A scheme or path
(`https://example.com`), a dotless host, a bad port, and `*` or `*.com`
(too broad) refuse the run with the entry named; `deny.network` also
takes a bare `*` (deny all, `*:22` for one port). Until 2026-10-02 such an
entry matched nothing with no word, and an allowed `*` opened every host
to every sandboxed task of the run.

**`network` is per-RUN, not per-task.** SRT runs one filtering proxy
per `vx run` and checks every request against the allowlist that proxy
was started with: the union of every domain list any sandboxed task in
the graph declared. Every sandboxed task is handed that proxy. So a task
that declares no network reaches the domains another task of the run
listed, and `network: true` reaches only those (nothing in a run with no
list). `deny.network` is the run's too: the proxy starts with the union
of every task's denies and refuses those domains to every task, checked
before the allowlist (B-21). A refused request is a violation on both
platforms, `deny network-outbound <host>:<port> (<reason>)` from the
proxy, and fails the task even when it survived the refusal;
`ignore: { network: ['<host>:<port>'] }` silences one, matched as the
proxy matches: case-blind, a trailing dot dropped (until 2026-10-08 the
client's spelling, `EXAMPLE.Com` or `example.com.`, escaped it). Until
2026-10-02 Linux reported none, and the line could not be ignored on macOS.

**Baseline** (`sandbox: {}`): the task reads nothing in the workspace,
writes nothing but its own `TMPDIR` and reaches no domain no task of the run lists — not even its own project
directory, which is why `allow: { read: ['.'] }` is the first line of
almost every real block. The task still starts in its own directory, an empty one
then: a relative read is refused and reported, never resolved elsewhere. The read wall is the WORKSPACE ROOT: a path
outside it (`~/.cache`, `/etc`, the toolchain) is readable and folds into
no key, so a task whose output depends on one declares it as a key input
(`inputs.runtime`, `inputs.env`) — the sandbox does not catch it (item
966).
The one exception is where tools keep credentials, denied unless a
grant names one (`read: ['.', '~/.npmrc']` for a publish; a write grant at
or inside a store frees that path alone), since a
dependency the task ran could copy a key into an output the cache
shares (L-41): `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`,
`~/.config/gcloud`, `~/.config/gh`, `~/.docker/config.json`, `~/.netrc`,
`~/.git-credentials`, `~/.npmrc`, `~/.yarnrc.yml`, `~/.pypirc`,
`~/.bunfig.toml`, `~/.config/.bunfig.toml`, `~/.cargo/credentials`,
`~/.cargo/credentials.toml`, `~/.gem/credentials`, `~/.config/hub`,
`~/.config/containers/auth.json`, `~/.terraform.d/credentials.tfrc.json`,
`~/.vault-token`, `~/.pgpass`, `~/.config/configstore/firebase-tools.json`,
`~/.local/share/com.vercel.cli/auth.json`,
`~/Library/Application Support/com.vercel.cli/auth.json`,
`~/.netlify/config.json`, `~/.config/netlify/config.json`,
`~/Library/Preferences/netlify/config.json`, `~/.wrangler/config`,
`~/.config/.wrangler/config`, `~/Library/Preferences/.wrangler/config`,
`~/.fly/config.yml`, `~/.supabase/access-token`, `~/.config/doctl`,
`~/Library/Application Support/doctl`, `~/.config/stripe/config.toml`,
`~/.config/op`, `~/.expo/state.json`, `~/.claude/.credentials.json`,
`~/.codex/auth.json`.
vx's own stores are denied the same way: `~/.vx`, where every
repository's shared store lives, and a cache directory outside the
workspace (`VX_CACHE_DIR=~/.cache/vx`). Read, they handed a task every
project's cached outputs, around the cross-project wall and its key.
What it grants from there is the union of the read grants and, on Linux,
the DIRECTORY holding each file-shaped write grant (above).
Nothing is inherited from `cache` — `inputs` says what INVALIDATES a task, `sandbox.allow`
says what it may TOUCH, and deriving one from the other made a
declaration added for caching silently widen the sandbox. The one grant
vx makes for you is dependencies: `node_modules` and, through it, the
real path of every workspace package linked there, and in turn in each
such package's own `node_modules`. A project never names
a sibling to import what its `package.json` already depends on. A link
back to the task's own project, or to a directory holding it, is not
followed: npm and Yarn link every workspace package at the root, the
task's own included, and following it would grant the whole project
past its `allow.read`.

A task that declares `cache` gets a linked workspace package only when
its key already answers for it: some task of that package is folded into
the key through `dependsOn` (as `inputs.tasks` selects it, groups
passing everything through). Every other link inside the workspace root
is withheld, and a read through one fails the task with the denial plus
one line naming the package and the edge that would key it. Declaring
`cache` can only narrow this grant, never widen one: a task with no
`cache` keeps it whole, having no key to be stale, and your own `allow`
grants never depend on it. The key answers for the package, not the
file: an edge to `ui#source` (inputs `src/**`) covers a read of
`ui/README.md` too.

**A missing write grant fails the task.** On macOS seatbelt refuses the
write and reports it. On Linux the write meets a read-only bind or a
read-only mask: the empty directory the sandbox lays over what it hides
(the workspace root around a project, a single-package workspace's root,
the project root around a write grant punched out of a read grant —
`read: ['.']` with `write: ['dist/']` binds the children one by one). It
is `Read-only file system` on both; until 2026-10-02 the Linux mask was
writable, and a write there succeeded and left nothing on disk. The
runtime's write observer saw the attempt, and a write no grant binds is
reported and fails the task, even when the command swallowed the error
and exited 0 (B-5; before it, both Linux shapes passed with nothing
reported, items 444 and 1011). A write outside the project is refused
the same way and named on a failed task, never counted. The remedy is to
declare it: `allow: { write: [...] }`.

**A write grant cannot be removed on Linux.** A directory grant is
mounted in place, so `rm -rf dist && tsc` under `write: ['dist/']`
empties `dist` and then fails with `Read-only file system`; a failed
task names the grant. Remove its contents instead: `rm -rf dist/*`.

**The boundary is the workspace root.** A task may not leave its own
project, so every sibling project and every root file is denied. Being
stopped at that wall is the sandbox working, not a finding: only
denials INSIDE the project are reported, because those are the reads
that make a cache key wrong. A write refused past the wall is named
beside a FAILED task, never counted, with the directory to grant, spelled
from the project when it is in the workspace (under the host's temp
directory, `$TMPDIR`, the task's own, instead): a
tool that cannot fill its cache (`~/.bun/install/cache`) rarely says
where it tried. So is a read the wall hid of a path that exists on the
host, with the grant spelled from the project (`'../../tsconfig.base.json'`):
the tool said only "not found". To reach a path outside the project but
inside the workspace — a workspace-level fixture — declare it; a path
outside the workspace is not walled (above).

**git in a sandboxed task** reads the repository only if it is granted:
`read: ['.', '../../.git']` from a project two levels down (`.git` is a
wall, so `read: ['.']` in a root project leaves it out too). On Linux
a task whose grants name a `.git` gets `GIT_DISCOVERY_ACROSS_FILESYSTEM=1`
(a value the task sets wins), since every sandbox mount is a filesystem
boundary git's discovery stops at. `git rev-parse` and `git log` then answer as outside;
`git status` reports a file the task may not read as deleted.

**Policy: fail on violation.** An undeclared read, or a write the
sandbox refuses, fails the task, and a failed task is never cached.
On Linux a denied read is reported only where `strace` is on PATH and
may attach; elsewhere the sandbox still denies it, the task fails
only if the command does, and the run says once that reads go unreported. Activation is lazy (only when
some task declares `exec.sandbox`); on an unsupported platform a
sandboxed task fails fast rather than running unsandboxed. Linux needs
`bubblewrap`, `socat` and `ripgrep` installed (the runtime expands its
mandatory deny globs with `rg`); a missing one is named with the install.
Inside a write grant, a file named like a shell or tool config
(`.bashrc`, `.zshrc`, `.gitconfig`, `.mcp.json`, …), anything under
`.vscode/` or `.idea/`, and `.git/hooks` or `.git/config` stay read-only
to the task, down to three levels below the workspace root, ignored by
git or not.

**No `[`, `]`, `*` or `?` in the project's path.** The runtime reads a
path holding one as a pattern: on Linux it mounts no write path that
does and a read grant matches its siblings, and macOS's rules compile it
as a pattern too. So a sandboxed task in a project under such a directory
(`~/[old]/repo`, `~/w*s/repo`) is refused, naming it: rename the
directory or drop `exec.sandbox`. On Linux so is a project under a
directory holding a backslash, which the runtime cannot mount at all (its
task saw no project and ran in `$HOME`). On every platform so is one
under a directory holding a line break: the runtime reports a refused
touch one line per record, so it arrived split and was misreported.

**macOS cannot nest.** `sandbox_apply` is refused inside a sandboxed
process, so a task that itself sandboxes something (vx's own test suite)
cannot be sandboxed on macOS. `weakerWhenNested` covers the Linux case;
there is no macOS equivalent to offer.

## Group tasks (no `exec`)

A task with no `exec` and a `dependsOn` is a **group task** — a pure
aggregator. Running a group is equivalent to running its dependencies;
nothing else happens (no spawn, no I/O, no cache read/write). An empty
`dependsOn: []` is an explicit no-op group: it exists to be named — by a
dependant's `^build`, by `vx run build --all` — and runs nothing. A
project with no `build` gets a keyed one (above), which a bare name
does not select.

A group with `inputs` is a **keyed group**: its `inputs` are a key
and nothing runs. A task that depends on it folds that key, so an edit
to those inputs re-runs the dependant, and `--affected` reaches it. It
takes no `cache` (a group writes nothing), and it needs no `dependsOn`. It spawns nothing, writes no cache entry, and the
run summary does not count it. `@vzn/vx-migrate` writes one for each
Nx `^production`-style input and each Turbo transit node.

```ts
// `test` re-runs when a file under fixtures/ changes; nothing spawns for it
fixtures: { inputs: { files: ['fixtures/**'] } },
test: { exec: { command: 'bun test' }, dependsOn: ['fixtures'], cache: { /* … */ } },
```

Bare `--exclude-dependencies` keeps a group's edges for the same reason:
`vx run ci --exclude-dependencies` runs `ci`'s members without their own
dependencies. A name list (`--exclude-dependencies=lint.oxfmt`) drops a
member it names, like any edge.

```ts
// `vx run install --all`  →  fans out to `build` in every workspace dep
install: {
  description: 'build everything in workspace dependency order',
  dependsOn: ['^build'],
}

// `vx run ci`  →  runs format-check + lint + test in the cwd project
ci: {
  description: 'format-check + lint + test (CI gate)',
  dependsOn: ['format-check', 'lint', 'test'],
}
```

Group tasks:

- **Are not counted in the run summary.** "3 tasks, 2 cached" reflects
  real executable tasks — including a group in the count is confusing
  ("3 of 4 cached" when one was a group that ran nothing).
- **Are not recorded in the `runs` table.** Analytics queries that
  aggregate runtime won't see them.
- **Render no framed block** in the live output.
- **DO contribute a stable hash to downstream tasks** that filter
  `inputs.tasks` to include the group. The hash is rolled up from
  the group's upstream outcomes (sorted, joined, hashed). So any
  change beneath the group cascades correctly.

The loader rejects:

- A task with no `exec`, no `dependsOn` and no `inputs` (literal no-op).
- A group with `cache` (a group writes nothing).

## Workspace config (`.vx/workspace.ts`)

Loaded from `.vx/workspace.{ts,mts,js,mjs,cts,cjs}`: the directory holding
`.vx` is the workspace root. `.vx` also holds the lock (`.vx/projects.lock.json`)
`.vx/cache`, the machine-local state (the cache, the workspace id), and
`.vx/tmp`, where a restore stages files; git ignores only those two:
`.vx/.gitignore` says `/cache` and `/tmp`. Every field falls back to its
built-in default.

```ts
import { defineWorkspace } from '@vzn/vx/config'
import { otel } from '@vzn/vx-otel'

export default defineWorkspace({
  baseBranch: 'main',
  run: {
    concurrency: 8,
    timeout: '10m',
    schedule: 'most-work',
    continue: 'deps-ok',
    rules: {
      exclusiveOutputs: true,
      dependencies: [{ from: 'tag:lib', deny: ['tag:app'] }],
    },
  },
  cache: {
    dir: 'build/.vx-cache',
    download: 'all',
    policy: 'local:rw,remote:r',
    inputStability: { strategy: 'immutable', severity: 'warn' },
    outputs: { clean: true },
    upload: { failures: 'ci' },
    store: { embeddings: '32KiB', decompress: true },
    concurrency: { download: 64, upload: 64, restore: 16 },
  },
  lock: { reviewFiles: true },
  watch: { poll: false },
  plugins: [otel()],
})
```

The workspace holds settings in groups (`run`, `cache`, `lock`, `watch`) and the
`plugins`. Every setting has one path, and its environment variable and
flag derive from it: `run.timeout` is `VX_RUN_TIMEOUT` and
`vx run --timeout`. A flag beats its variable, which beats this file,
which beats the built-in. A setting a task can set itself
(`exec.timeout`, `exec.retries`, `cache.inputStability`) takes the
task's value over all of them; the input-stability variables are the one
exception, overriding every task for the run. A duration carries its
unit (`'500ms'`, `'30s'`, `'10m'`, `'2h'`, `'30d'`), and a bare number is
refused naming the forms with units; a size carries one too (`'10GB'`).
`debug.timing`, `debug.watch`, `debug.dumpable`, `config.workerTimeout` and `run.outputLogs` are read
before the workspace loads, so they have a variable (and a flag) only.
None is folded into a cache key. `vx info` lists every setting not at its
default and where it came from.

### Settings

<!-- settings table: generated by tests/settings.test.ts -->

| Setting                                        | Variable                            | Flag                           | Value                                                                   | Default                                                                       | What it does                                                                                                                                                                                     |
| ---------------------------------------------- | ----------------------------------- | ------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `baseBranch`                                   | `VX_BASE_BRANCH`                    | —                              | a non-blank string                                                      | origin/HEAD's branch, then main, then master                                  | The default branch: a run on it has no cache scope and a bare `--affected` no base; elsewhere both use the merge base with `origin/<baseBranch>`. Named alone: `main`, not `origin/main`.        |
| `affectedBase` (variable or flag only)         | `VX_AFFECTED_BASE`                  | —                              | a non-blank string                                                      | a plugin's base commit, else the merge base with `baseBranch`                 | The commit a bare `--affected` compares with, on the base branch too. `--affected=<base>` beats it; it beats a plugin's base commit. Env only: a committed base would be stale on the next push. |
| `run.concurrency`                              | `VX_RUN_CONCURRENCY`                | `--concurrency`                | a positive integer, or a share of the cores like '50%'                  | the cores this process may use                                                | Tasks at once: a positive integer, or a share of the cores (`'50%'`).                                                                                                                            |
| `run.schedule`                                 | `VX_RUN_SCHEDULE`                   | `--schedule`                   | one of 'most-work', 'critical-path', 'direct-dependents', 'ready-order' | most-work                                                                     | Which ready task starts first when there are more than workers.                                                                                                                                  |
| `run.branch` (variable or flag only)           | `VX_RUN_BRANCH`                     | `--branch`                     | a non-blank string                                                      | git's branch, then the CI provider's                                          | The branch a run records in its history and forecasts from. Flag and env only: a committed branch would be wrong on every other branch.                                                          |
| `run.timeout`                                  | `VX_RUN_TIMEOUT`                    | `--timeout`                    | a duration like '500ms', '30s' or '5m', at most 24 days                 | none                                                                          | A task's time limit, for tasks without their own `exec.timeout` (`'30m'`). A task's own `exec.timeout` beats it.                                                                                 |
| `run.retries`                                  | `VX_RUN_RETRIES`                    | `--retries`                    | a non-negative integer                                                  | 0                                                                             | Re-runs of a failed task, for tasks without their own `exec.retries`. A task's own `exec.retries` beats it.                                                                                      |
| `run.continue`                                 | `VX_RUN_CONTINUE`                   | `--continue`                   | one of 'never', 'deps-ok', 'always'                                     | deps-ok                                                                       | What a failed task takes down: `never` stops the run, `deps-ok` skips its dependents, `always` runs them too.                                                                                    |
| `run.outputLogs` (variable or flag only)       | `VX_RUN_OUTPUT_LOGS`                | `--output-logs`                | one of 'full', 'errors-only', 'hash-only', 'none'                       | `full` on CI, else by what the run selects                                    | Which task output the run prints. Chosen before the workspace loads, so flag and env only.                                                                                                       |
| `run.rules.exclusiveOutputs`                   | `VX_RUN_RULES_EXCLUSIVE_OUTPUTS`    | —                              | true or false                                                           | true                                                                          | Refuse two tasks whose outputs overlap even when an edge orders them.                                                                                                                            |
| `cache.dir`                                    | `VX_CACHE_DIR`                      | `--cache-dir`                  | a non-blank string                                                      | .vx/cache, entries in ~/.vx/<repo>/cache                                      | Where the cache lives, relative to the workspace root; named, it holds the whole cache.                                                                                                          |
| `cache.policy`                                 | `VX_CACHE_POLICY`                   | `--cache-policy`               | a non-blank string                                                      | every layer reads and writes                                                  | Which layers a run reads and writes (`'local:rw,remote:r'`); `--no-cache` and `--force` apply on top.                                                                                            |
| `cache.scope` (variable or flag only)          | `VX_CACHE_SCOPE`                    | —                              | a non-blank string                                                      | the branch's, `<owner>/<repo>:<branch>`, with a remote cache off `baseBranch` | The branch scope plugin entries are keyed under (`'vznjs/vx:feat-x'`); task keys never carry it. Empty: no scope.                                                                                |
| `cache.concurrency.download`                   | `VX_CACHE_CONCURRENCY_DOWNLOAD`     | `--cache-concurrency-download` | an integer ≥ 1                                                          | min(96, max(cores × 3, 64))                                                   | Remote downloads at once.                                                                                                                                                                        |
| `cache.concurrency.upload`                     | `VX_CACHE_CONCURRENCY_UPLOAD`       | `--cache-concurrency-upload`   | an integer ≥ 1                                                          | min(96, max(cores × 3, 64))                                                   | Uploads at once, per remote.                                                                                                                                                                     |
| `cache.concurrency.restore`                    | `VX_CACHE_CONCURRENCY_RESTORE`      | `--cache-concurrency-restore`  | an integer ≥ 1                                                          | twice `run.concurrency`                                                       | Local hits restoring outputs at once.                                                                                                                                                            |
| `cache.download`                               | `VX_CACHE_DOWNLOAD`                 | `--cache-download`             | one of 'all', 'toplevel', 'none'                                        | all                                                                           | Which remote hits land on disk: every one, only the requested tasks, or none.                                                                                                                    |
| `cache.inputStability.strategy`                | `VX_CACHE_INPUT_STABILITY_STRATEGY` | —                              | one of 'immutable', 'mutable', 'unchecked'                              | immutable                                                                     | What a write to an input during the command means for the save, for tasks without their own. A task's own `cache.inputStability.strategy` beats it.                                              |
| `cache.inputStability.severity`                | `VX_CACHE_INPUT_STABILITY_SEVERITY` | —                              | one of 'warn', 'error'                                                  | warn                                                                          | Whether a skipped save warns or fails the task, for tasks without their own. A task's own `cache.inputStability.severity` beats it.                                                              |
| `cache.outputs.clean`                          | —                                   | —                              | true or false                                                           | true                                                                          | Remove a task's declared outputs before it runs on a miss, for tasks without their own. A task's own `cache.outputs.clean` beats it.                                                             |
| `cache.store.embeddings`                       | `VX_CACHE_STORE_EMBEDDINGS`         | —                              | false, or a size like '32KiB'                                           | '32KiB'                                                                       | Keep an entry up to this size inside the cache index, one zstd tar, rather than as files; `false` keeps none.                                                                                    |
| `cache.store.decompress`                       | `VX_CACHE_STORE_DECOMPRESS`         | —                              | true or false                                                           | true                                                                          | Keep a larger entry as its plain files, which a hit copies or clones out; off, as one `.tar.zst`.                                                                                                |
| `cache.upload.failures`                        | —                                   | —                              | one of 'ci', 'local', 'always'                                          | ci                                                                            | Where a failed task's log and outputs are kept in the remote: CI runs, local runs, or both.                                                                                                      |
| `lock.reviewFiles`                             | `VX_LOCK_REVIEW_FILES`              | —                              | true or false                                                           | true                                                                          | `vx lock` writes each project's resolved config, pretty, to `vx.lock.json` beside its `vx.config`, for review; vx never reads it.                                                                |
| `watch.poll`                                   | `VX_WATCH_POLL`                     | `vx watch --poll`              | true or false                                                           | false                                                                         | Poll for changes from the start instead of the OS watcher.                                                                                                                                       |
| `config.workerTimeout` (variable or flag only) | `VX_CONFIG_WORKER_TIMEOUT`          | —                              | a duration like '500ms', '30s' or '5m', at most 24 days                 | 30s                                                                           | How long one config evaluation may take.                                                                                                                                                         |
| `debug.timing` (variable or flag only)         | `VX_DEBUG_TIMING`                   | —                              | true or false                                                           | false                                                                         | Print the run's stage timings to stderr.                                                                                                                                                         |
| `debug.watch` (variable or flag only)          | `VX_DEBUG_WATCH`                    | —                              | true or false                                                           | false                                                                         | `vx watch`: say on stderr each time the loop arms, with the projects it watches.                                                                                                                 |
| `debug.dumpable` (variable or flag only)       | `VX_DEBUG_DUMPABLE`                 | —                              | true or false                                                           | false                                                                         | Linux: keep vx dumpable, so strace or a debugger can read its memory and `/proc/<pid>/fd`, and an unsandboxed task its env.                                                                      |

<!-- /settings table -->

```ts
interface WorkspaceConfig {
  baseBranch?: string
  run?: RunSettings
  cache?: CacheSettings
  lock?: LockSettings
  watch?: { poll?: boolean }
  /** Run-level plugins (cache / executor / telemetry capabilities). */
  plugins?: readonly (Plugin | undefined | null | false)[]
}

interface RunSettings {
  concurrency?: number | `${number}%`
  schedule?: 'most-work' | 'critical-path' | 'direct-dependents' | 'ready-order'
  timeout?: Duration
  retries?: number
  continue?: 'never' | 'deps-ok' | 'always'
  /** Graph rules `vx lock` checks, never a run; each on unless set to false. */
  rules?: { exclusiveOutputs?: boolean; dependencies?: DependencyRule[] }
}

/** `run.rules.dependencies`, checked by `vx lock` only. */
type DependencyRule = { from: string; allow?: string[]; deny?: string[] }

interface LockSettings {
  /** A pretty vx.lock.json beside each config, for review; on unless false. */
  reviewFiles?: boolean
}

interface CacheSettings {
  dir?: string
  policy?: string
  download?: 'all' | 'toplevel' | 'none'
  inputStability?: InputStability
  outputs?: { clean?: boolean }
  upload?: { failures?: 'ci' | 'local' | 'always' }
  store?: { embeddings?: false | string; decompress?: boolean }
  concurrency?: { download?: number; upload?: number; restore?: number }
}
```

- **`run.concurrency`** — the cap on parallel tasks: a positive integer,
  or a share of the cores this process may use (`'50%'` on eight cores is
  4, never below 1; over 100% is allowed for I/O-bound work).
- **`run.timeout`** — a task's time limit, for any task that declares no
  `exec.timeout` (which beats it, its flag and its variable). A runaway
  task's process group is SIGTERMed and the task reported `failed`.
  Purely a safety net — never folded into a cache key (a timed-out task
  fails and is never cached).
- **`run.retries`** — re-runs of a failed task, for tasks without their
  own `exec.retries` (which beats it, `retries: 0` included); never a
  persistent one.
- **`run.continue`** — what a failed task takes down: `never` stops
  dispatch, `deps-ok` (the default) skips its dependents, `always` runs
  them (`docs/cli.md` § Failure propagation).
- **`run.rules`** — checked by `vx lock` and `vx lock --check` only;
  no run checks them.
- **`cache.dir`** — unset, the workspace keeps its index and history in
  `.vx/cache` and its entries and artifacts in its repository's shared
  store (`~/.vx/<id>/cache`), where every other checkout of the
  repository hits them (`docs/caching.md`). Named here, by
  `VX_CACHE_DIR`, or by `--cache-dir`, the directory holds the whole
  cache, shared with no other workspace. `--cache-dir` beats
  `VX_CACHE_DIR`, which beats this.
  Relative paths are resolved against the workspace
  root, `~/` against the home directory; absolute paths are used
  as-is. The home directory itself (`~`) is refused. `vx run`, `vx cache clean`,
  and any other reader use the same resolution
  (`src/workspace/workspace.ts:resolveCacheDir`). The cache is a
  directory of its own: a first index in one that holds a
  `package.json`, `pnpm-workspace.yaml`, a `vx.config.*` or a
  `.vx/workspace.*` (`''` and `'.'` name the
  root), whose subdirectory does (`'packages'`), or that holds the
  workspace (`'..'`, `'/'`) is refused before anything is written, since its `*`
  `.gitignore` would hide the sources from git and the cache keys. A
  directory other than the default `.vx/cache` gets that `*` `.gitignore`;
  the default is ignored by `.vx/.gitignore` (`/cache`, `/tmp`) instead, written
  when missing and never edited.
- **Cleaning**: no run evicts anything. `vx cache clean --older-than <d>
--max-size <s>` is the one cleaner ([cli.md](cli.md#vx-cache-clean)); run it
  from a schedule or CI to bound the cache.
- **`baseBranch`** — the repository's default branch, by name
  (`'develop'`; `VX_BASE_BRANCH` beats it). Omitted → `origin/HEAD`'s
  branch, then `main`, then `master`. On it a run has no cache scope and
  a bare `--affected` has no default (run `--all`, or pass the last good
  commit, `--affected=<sha>`); elsewhere a bare `--affected` compares with the
  merge base of HEAD and `origin/<baseBranch>` (the local branch in a
  clone with no remote), or that branch's tip when they share no
  history. A plugin's `config` stage may set it: `nx()` from nx.json's
  `defaultBase`. A base commit is a plugin's to name instead
  (`setBranch({ base })`): `github()` a pull request's, `nx()`
  `NX_BASE`, `turbo()` `TURBO_SCM_BASE`, else (`turbo()` only, as Turbo
  does) on GitHub Actions `GITHUB_BASE_REF` or the push event's
  `before`; it beats `baseBranch`. `VX_AFFECTED_BASE` beats a plugin's
  base, and `--affected=<base>` beats them all. Core itself reads no CI
  variable for the base. Not folded into
  any cache key.
- **`cache.policy`** — which layers a run reads and writes, in
  `--cache-policy`'s spec (`'local:rw,remote:r'`; a layer the spec leaves out
  stays on; the grammar is in `docs/cli.md` § Cache policy). Omitted,
  every layer reads and writes on CI, and `vx run` off CI (`CI` unset,
  `0` or `false`) reads the remote and does not write it: a key holds
  only declared inputs, so a laptop's write could replay on CI. The
  policy alone decides whether a layer is written; the cache scope never
  does. `VX_CACHE_POLICY` beats it and
  `vx run --cache-policy` (or `--cache-policy`) beats both; `--no-cache` and `--force` still apply on top. A spec
  naming the remote (`remote:rw`) asks to write it, off CI too. Parsed
  before any task: a bad spec is refused naming `cache.policy`. Whatever
  the policy, a lookup asks the local cache first, then each remote in
  the order the plugins declare them. Not folded into any cache key.
- **`cache.download`** — which remote hits land on this machine:
  `all` (the default), only the requested tasks' (`toplevel`), or
  `none` (`docs/cli.md` § `--cache-download`).
- **`cache.concurrency.download`** / **`.upload`** (default
  min(96, max(cores × 3, 64))) — remote downloads at once, and uploads at
  once per remote. A transfer waits on the network, not a core.
- **`cache.concurrency.restore`** (default twice `run.concurrency`) —
  local hits writing their outputs at once.
- **`cache.store.embeddings`** (default `'32KiB'`) — an entry up to this
  size lives inside the cache index: one row, no file to make. `false`
  keeps every entry as files.
- **`cache.store.decompress`** (default `true`) — a larger entry is its
  plain files under `<hash>.tree/`, which a hit copies (or clones) out with
  no decode; off, it is one `<hash>.tar.zst`. A remote always gets the
  tar.zst.
- **`cache.upload.failures`** — which runs keep a failed task's log and
  the files its outputs left in the remote: CI runs (`'ci'`, the
  default), runs off CI (`'local'`), or both (`'always'`). Only a run
  whose policy writes a remote keeps any, and it always keeps the log of
  a task that saved no entry. `ctx.cache.getRun` reads them
  (`docs/modules/plugin.md` § Run report and run bytes).

- **`cache.scope`** (`VX_CACHE_SCOPE` only, 2026-10-17) — the branch
  scope plugins key their own entries under (`ctx.cache`, run records),
  named `<owner>/<repo>:<branch>` (letters, digits, `. _ - / @ :`, at
  most 128). Task keys never carry it (2026-10-20): every remote sees
  the plain key, and which branch a read may see is the remote's call
  (`turboCache()`'s `scope`, `docs/modules/layered-cache.md`). The local
  cache never knows a scope. Not a config key and not a flag: a plugin
  names it in its `config` stage (`ctx.setBranch({ scope })`; `github()`
  does on Actions), else a checkout with a cache plugin derives it from
  `.git` with no network (the branch it tracks on that remote's
  repository, else its own on `origin`'s; none on `baseBranch` or a
  detached HEAD). `VX_CACHE_SCOPE` beats both; empty turns it off. Never
  decides whether a run writes (`cache.policy` does) and is not a
  security boundary (`docs/security.md` § Cache poisoning). Not folded
  into any cache key.
- **`run.schedule`** — which ready task starts first when more are ready
  than workers, with no timings. `most-work` (the default): the one the
  most tasks wait on, at any depth. `critical-path`: the head of the
  longest chain of tasks below it. `direct-dependents`: the one the most
  tasks wait on directly (Nx's rule). `ready-order`: the one that became
  ready first (Turbo's rule). Each loses some graph shape the others win
  (`blog/scheduling-strategies`). A `schedule` plugin's weights
  (`@vzn/vx-history`) still sort first, and the strategy breaks
  their ties. The default costs what it did; another strategy is
  computed only when named. Any other value is refused. Never folded
  into a cache key.
- **`cache.inputStability`** — the `cache.inputStability` of every task that
  does not set its own field, same shape (`{ strategy, severity }`, §
  `cache`). `VX_CACHE_INPUT_STABILITY_STRATEGY` and `_SEVERITY` still
  override every task for the run. Never folded
  into a cache key.
- **`run.rules`** — checks on the task graph, each on unless set to
  `false`. Turning one off allows a shape vx runs correctly but more
  slowly; never folded into a cache key. A value that is not a boolean,
  or a rule vx does not know, is refused.
  - **`exclusiveOutputs`** (X-53) — two tasks whose declared outputs
    overlap are refused even when a `dependsOn` edge orders them:
    `<a> and <b> both declare the output "<glob>" … Give each task its
own output path, or set run.rules.exclusiveOutputs: false in
.vx/workspace.ts to let a dependant add to its upstream's outputs.`
    Off, the dependant adds to its upstream's tree (item 588;
    `caching.md` § Additive outputs). Two overlapping tasks with no
    edge are refused either way.
  - **`dependencies`** — which workspace projects a project may depend
    on, checked by `vx lock` and `vx lock --check` only, over each
    project's direct dependencies (its `package.json` buckets and its
    tasks' cross-project `dependsOn`). Each rule is
    `{ from, allow?, deny? }`; a selector is `tag:<tag>` (a project
    carrying the tag) or a project name, and `*` matches any characters
    in either (`tag:scope:*`, `@acme/*`). Every rule whose `from`
    selects a project applies: each dependency must match an `allow`
    selector when `allow` is given, and none of `deny`, so a deny beats
    any allow. A project no rule selects is free, and an untagged
    dependency matches no `tag:` selector. A broken edge refuses the lock
    with `VX_E_DEPENDENCY_RULE`:
    `lib depends on app, which run.rules.dependencies[0] (from 'tag:lib') denies`,
    every broken edge on its own line. A rule with neither `allow` nor
    `deny` is refused.
- **Inputs over outputs** (X-54, always checked, no setting) — a cached task whose `inputs.files` can
  match a same-project task's `outputs.files`, or whose
  `inputs.workspaceFiles` can match any task's `outputs.workspaceFiles`
  or another project's `outputs.files` read from the root, or whose
  `inputs.files` can match another task's `outputs.workspaceFiles`
  landing in its project (X-135), is refused by `vx lock` unless one of
  the exceptions below applies: `<reader> reads "<glob>" in inputs.<field>,
which matches <writer>'s output "<glob>" … Exclude it: add "!<glob>"
to <reader>'s inputs.<field>, or depend on <writer> and leave it out of
<reader>'s inputs.tasks, so its key hashes those bytes instead.` Such a key
  reads what the producer writes this run, so vx cannot know it before
  the producer ran: it is not probed, prefetched or restored ahead of
  the schedule (`caching.md` § Local restore tier). The upstream's key
  already reaches the reader through `dependsOn`. A `!` entry that
  takes the whole output back clears it, and an output the reader's
  `!` entries take back no longer holds its key back either. Nor does
  an output git ignores whole: a key reads only what git lists, so
  `**/*` beside a gitignored `**/dist/**` passes and keys up front,
  unless the reader's entry starts in the ignored path (`dist/**`):
  naming it reads it, so the check applies. A reader may read the
  outputs of a task in its `dependsOn` closure that its key does not
  fold: it sets `inputs.tasks` and leaves the producer out, also
  through the tasks it does fold (a producer folded by a folded task
  counts as folded). Its key then waits for the producer and hashes
  the bytes it wrote, so a producer rerun with identical output still
  hits. `vx lock` checks all of it; a run reads only the lock. Git
  is asked, never a `.gitignore` read: `git check-ignore` on the
  output's directory (for `**/dist/**`, `dist/` and a fresh
  `__vx_probe__/dist/`), and no tracked or listed file may match it,
  so a tracked output is still refused. A glob no few paths stand for
  (`*.js`) is refused as before. `vx lock` asks once for every
  overlapped output; a run asks once beside its git walk for the
  stability gate, so a rule changed after the lock keys the reader
  late until the next `vx lock` refuses it. A task's
  own outputs, a task with no `cache`, and a group are exempt.
- **`plugins`** — the run-level extension points. Optional: core
  applies no plugin by default, and the local executor and the local
  cache are its floor — the tail of every executor list, and the first
  layer of every cache chain — so a workspace that declares none runs
  and caches here.
  Declaration order is precedence: every `executor` is consulted in
  order per task (first to accept runs it; what all decline runs
  locally); every `cache` layer is chained (lookup walks, save reaches
  all, the local store last). An `undefined`, `null` or `false` entry
  is skipped, as Vite skips one: a factory that declines (`github()` off
  Actions) or `cond && plugin()` needs no filter. Each entry is a `VxPlugin` contributing
  any subset of the fifteen hooks, in pipeline order: `config` (edit
  the workspace config before anything derives from it), `discover`
  (name directories to make projects beyond the members), `project`
  (edit a loaded project's tasks — inject, remove, rewrite;
  re-validated by core and hashed into the key like a hand edit),
  `graph` (edit the task graph's edges), `key` (per-task
  `{ name: value }` material folded into the cache key), `fingerprint`
  (claim a lockfile and key it per project, or a root file the plugin's
  stages read, such as `turbo.json`, so `--affected` asks the plugin
  about it and `vx watch` re-runs on it), `schedule` (task id →
  priority, merged over the scheduler's baseline), `admit` (may this
  ready task start now beside what runs here), `executor` (return a
  `TaskExecutor` — where one task's command runs — or decline), `cache`
  (return a cache layer or decline), `telemetry` (observe-only export:
  OTel, the GitHub job summary, a custom sink), `output` (return a
  `Logger` that draws the run in place of vx's own, or decline), `setup`
  and `teardown`
  around the run, and CLI `commands` (`{ verb: { description, run } }`,
  consulted for a verb core does not know). First-party plugins:
  `@vzn/vx-otel`, `@vzn/vx-ci`, `@vzn/vx-reapi`, `@vzn/vx-lockfile`,
  `@vzn/vx-history`, `@vzn/vx-migrate`. A
  plugin that declines every capability (`otel()` with no OTLP endpoint
  configured) costs nothing — a run with no active plugin is
  byte-identical to one with none declared. Plugins observe, route and
  execute; they never change what a task is.

The loader validates the shape (each setting by its kind, plugin objects
with a name and at least one capability) and throws a `UserError` on
malformed input.

There are no workspace-level `globalInputs` / task-default fields:
root-anchored file inputs are declared per task via
`inputs.workspaceFiles`, root-anchored probes via
`inputs.workspaceRuntime`, and shared task shapes compose
through plain TypeScript (import a preset and spread it) — the
language replaces Nx-style `namedInputs` / `targetDefaults` schema
machinery by design.

## Helpers

```ts
import { defineProject, defineWorkspace } from '@vzn/vx/config'

// Identity functions; their purpose is type inference.
defineProject<const T extends ProjectConfig>(config: T): T
defineWorkspace<T extends WorkspaceConfig>(config: T): T
```

Use them so TypeScript narrows literal types in your config —
autocomplete for task names in `dependsOn` against your declared
tasks, strict validation against the schema, errors at edit time
rather than at `vx run` time.

They cost one runtime import of `@vzn/vx/config` per config file:
`src/config.ts`, which imports nothing, so it is cheap, but it must
resolve from the config's directory. The type-only form gives the same
editor checking with no runtime import, and is what `vx init` /
`@vzn/vx-migrate` write:

```ts
import type { ProjectConfig, WorkspaceConfig } from '@vzn/vx/config'
export default { tasks: { … } } satisfies ProjectConfig
export default { plugins: [] } satisfies WorkspaceConfig
```

You _can_ skip the helpers and write
`export default { tasks: { … } }`, but the IDE experience is
strictly worse.

## Full example

```ts
import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    // Real cached task with file inputs, env tracking, and outputs.
    build: {
      description: 'compile TypeScript to dist/',
      // NODE_ENV is a cache input below, so it must reach the child
      // too — the exec env is isolated, not inherited.
      exec: { command: 'tsc -b', env: { passThrough: ['NODE_ENV'] } },
      dependsOn: ['^build'],
      inputs: {
        files: ['src/**', '!**/*.test.ts', 'tsconfig.json'],
        env: ['NODE_ENV'],
      },
      cache: {
        outputs: { files: ['dist/**'] },
      },
    },

    // Cached, depends on upstream build; CI is in passThrough only
    // (CI=1 shouldn't bust the cache — it's true on every CI run).
    test: {
      description: 'run unit tests',
      exec: { command: 'bun test', env: { passThrough: ['CI'] } },
      dependsOn: ['build'],
      inputs: { files: ['src/**', 'tests/**'] },
      cache: {
        outputs: { files: [] },
      },
    },

    // Cross-project edges. The pkg.tgz from one project's build is
    // cached, and depends on builds in every workspace dep.
    package: {
      description: 'pack the npm tarball',
      exec: { command: 'rm -rf pkg && npm pack --pack-destination ./pkg' },
      dependsOn: ['build', 'test', '^build'],
      inputs: {
        files: ['package.json'],
        tasks: ['build', '^build'], // hash these upstream too
      },
      cache: {
        outputs: { files: ['pkg/*.tgz'] },
      },
    },

    // Persistent dev server. Downstream tasks unblock on the
    // "Local:" line, not on exit (which never comes).
    dev: {
      description: 'vite dev server',
      exec: {
        command: 'vite',
        timeout: '30s',
        persistent: { readyWhen: 'Local:' },
        env: { passThrough: ['VITE_API_URL'] },
      },
    },

    // E2E test gated on the dev server. Together: vx run e2e runs
    // dev → e2e; e2e exits → orchestrator SIGTERMs dev → run ends.
    e2e: {
      description: 'end-to-end tests against dev server',
      exec: { command: 'playwright test' },
      dependsOn: ['dev'],
    },

    // Two cached checks with no outputs: the verdict is the exit code.
    // A name with a hyphen is quoted, as any object key is.
    lint: {
      description: 'oxlint',
      exec: { command: 'oxlint .' },
      inputs: { files: ['src/**', '.oxlintrc.json'] },
      cache: { outputs: { files: [] } },
    },
    'format-check': {
      description: 'oxfmt --check',
      exec: { command: 'oxfmt --check .' },
      inputs: { files: ['src/**', '.oxfmtrc.json'] },
      cache: { outputs: { files: [] } },
    },

    // Pure group task — `vx run ci` fans out, the group itself is
    // silent in the run output. `dependsOn` is typed against the task
    // names above: a name declared nowhere is a type error, not a
    // silent no-op.
    ci: {
      description: 'format-check + lint + test',
      dependsOn: ['format-check', 'lint', 'test'],
    },
  },
})
```

The rest of the task fields, in one config:

```ts
import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    // Prompts on the terminal, so it runs alone and is never cached.
    'db:push': { exec: { command: 'drizzle-kit push', interactive: true } },
    // Talks to this machine's Docker daemon: never sent to a remote executor.
    'docker:build': { exec: { command: 'docker build -t app .', remote: false } },
    e2e: {
      exec: {
        command: 'playwright test',
        env: {
          define: { BASE_URL: 'http://localhost:3000' },
          passThrough: ['E2E_TOKEN'],
          secret: ['E2E_TOKEN'],
        },
        sandbox: {
          allow: {
            read: ['.'],
            write: ['test-results/'],
            localBinding: [3000],
            unixSockets: true,
            pty: true,
            gitConfig: false,
            systemInfo: ['hw.memsize'],
            machLookup: ['com.apple.SecurityServer'],
          },
          weakerNetworkIsolation: false,
          weakerWhenNested: false,
        },
      },
      inputs: {
        files: ['e2e/**'],
        runtime: ['playwright --version'],
        workspaceRuntime: ['node -v'],
      },
      cache: {
        outputs: { files: ['test-results/**'] },
      },
    },
  },
})
```

## Common patterns

### Sharing inputs across tasks

TypeScript composition is the mechanism (named-input schema machinery
was deliberately rejected — the language already does this). Plain TS
arrays:

```ts
import { defineProject } from '@vzn/vx/config'

const srcInputs = ['src/**', 'tsconfig.json']

export default defineProject({
  tasks: {
    build: {
      exec: { command: 'tsc' },
      inputs: { files: srcInputs },
      cache: { outputs: { files: ['dist/**'] } },
    },
    test: {
      exec: { command: 'bun test' },
      inputs: { files: [...srcInputs, 'tests/**'] },
      cache: { outputs: { files: [] } },
    },
  },
})
```

### Presets

A preset is a TypeScript function that returns a `TaskConfig`:

```ts
// presets/ts-build.ts
import type { TaskConfig } from '@vzn/vx/config'

export function tsBuild(opts?: { tsconfig?: string }): TaskConfig {
  return {
    description: 'compile TypeScript',
    exec: { command: `tsc -b ${opts?.tsconfig ?? ''}`.trim() },
    inputs: { files: ['src/**', opts?.tsconfig ?? 'tsconfig.json'] },
    cache: {
      outputs: { files: ['dist/**'] },
    },
  }
}
```

```ts
// packages/app/vx.config.ts
import { defineProject } from '@vzn/vx/config'
import { tsBuild } from '../../presets/ts-build.ts'

export default defineProject({
  tasks: {
    build: tsBuild(),
    test: {
      exec: { command: 'bun test' },
      dependsOn: ['build'],
      inputs: { files: ['src/**'] },
      cache: { outputs: { files: [] } },
    },
  },
})
```

When the preset is consumed at config-load time, it should resolve
to `.ts` source — see
[`architecture.md` § Config-time imports](./architecture.md#config-time-imports--the-bootstrap-problem)
for the bootstrap-cycle tradeoff.

### When to use `inputs.tasks: []`

When a `dependsOn` exists for ordering only, and the upstream's
output doesn't influence this task's output. Common case: an
integration test that depends on a dev server starting up but whose
own inputs are just the test source.

```ts
e2e: {
  dependsOn: ['dev'],
  exec: { command: 'playwright test' },
  inputs: {
    files: ['e2e/**'],
    tasks: [],   // dev's hash does not affect e2e's cache identity
  },
  cache: {
    outputs: { files: ['playwright-report/**'] },
  },
}
```

### When to use `--no-cache` instead of removing `cache`

`--no-cache` is a runtime flag, not a config change. Reach for it
when:

- You suspect cache corruption and want a clean run.
- You're benchmarking and need fresh timings.
- You're forwarding one-off args and don't want to pollute the cache
  with a one-shot key (though note: forwarded args are already in
  the key, so they form their own entry anyway).

It applies to the whole run; per-task opt-out belongs in config (omit
the `cache` block).

## Schema validation errors

The loader (`src/workspace/project-loader.ts`) validates at load time
and surfaces `UserError` (clean output, no stack). Every field's
accepted values and exact refusal text are recorded in
`tests/contract/config-schema.json`, which a test regenerates from the
validator and compares, so a change to either is deliberate
(`design/versioning-1.0.md` § How the contract is held).

When the field a refusal names is in the file, the CLI prints the file
at its line and column, relative to the current directory (a terminal
opens it on click), and the lines up to it with a caret under the field
(`util/config-frame.ts`):

```
✗ vx lock  lock not written

  packages/b/vx.config.ts:4:15
  tasks.build.exec has unknown field "comand"
  allowed: …

    2 |   tasks: {
    3 |     build: {
  > 4 |       exec: { comand: 'mkdir -p dist' },
      |               ^

  fix  use command
```

A field the file does not hold (a required one missing, or one a plugin
set) prints without the frame. Every config that does not load is
named in one run: the first in full, then up to four more as `✗ vx lock
also refused`, then a count of the rest. The table below lists the messages
a user meets most:

| Symptom                                                                                                                               | Cause                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `did not export a default object`                                                                                                     | Forgot `export default`, or exported a non-object; a function (Vite's `defineConfig(() => …)` shape) adds that it is one and to export what it returns (D-110).                                                                |
| `tasks must be an object keyed by task name`                                                                                          | `tasks` is not an object — an ARRAY included.                                                                                                                                                                                  |
| `<path> is <what> — a config must be JSON data, because the cache key folds its JSON`                                                 | A value JSON cannot carry, anywhere in the config: a function, a symbol, a bigint, `NaN` / `±Infinity`, `undefined` in an array, a cycle, a getter or an object that is not plain (`Date`, `Map`, `RegExp`, a class instance). |
| `<level> has unknown field "<key>"`                                                                                                   | Typo'd / unsupported key (see below).                                                                                                                                                                                          |
| `<level> must be an object (fields: <fields>), not an array`                                                                          | An array where an object goes — `outputs: ['dist/**']` (Turbo's spelling) is `outputs: { files: ['dist/**'] }`, and the message says so.                                                                                       |
| `cannot find '<name>' — no node_modules above the config provides it; install the workspace's dependencies first`                     | A bare import nothing installed serves — a fresh clone before its install, or a typo. Refused before the config is evaluated, so Bun never auto-installs it from the registry (it would, when no `node_modules` exists above). |
| `cannot find '<name>' — Yarn Plug'n'Play installed the workspace's dependencies into .pnp.cjs, which Bun does not read; set <remedy>` | The same, with a `.pnp.cjs` at or above the config: the install is there and Bun cannot read it, so the remedy is `nodeLinker: node-modules` in `.yarnrc.yml` and `yarn install` (D-109).                                      |
| `tasks.<name> must be an object`                                                                                                      | The task value is null / a string / etc.; a string (package.json's `name: 'command'`) adds the `{ exec: { command } }` it goes in.                                                                                             |
| `exec must be an object with a command string`                                                                                        | `exec` is malformed.                                                                                                                                                                                                           |
| `exec.command must be a non-empty string`                                                                                             | Forgot `command`, or an empty or whitespace-only string.                                                                                                                                                                       |
| `exec.command holds a NUL, which no command line can carry`                                                                           | A `\0` in the command (a template slip); the spawn refused it as exit 127, "not on this task's PATH", with the NUL printed as a space.                                                                                         |
| `exec.persistent must be an object (or omitted)`                                                                                      | Wrong shape.                                                                                                                                                                                                                   |
| `exec.persistent.readyWhen must be a string regex`                                                                                    | Non-string `readyWhen`.                                                                                                                                                                                                        |
| `exec.persistent.readyWhen is not a valid regex (<error>)`                                                                            | A `readyWhen` the runner could not compile (`(`); it failed the task as an internal error at run time.                                                                                                                         |
| `cache is not allowed on a persistent task`                                                                                           | persistent + cache combined.                                                                                                                                                                                                   |
| `exec.interactive must be a boolean (or omitted)`                                                                                     | Wrong shape.                                                                                                                                                                                                                   |
| `cache is not allowed on an interactive task`                                                                                         | interactive + cache combined: what it does depends on what is typed.                                                                                                                                                           |
| `sandbox is not allowed on an interactive task`                                                                                       | interactive + sandbox combined.                                                                                                                                                                                                |
| `persistent.readyWhen is not allowed on an interactive task`                                                                          | vx reads none of an interactive task's output.                                                                                                                                                                                 |
| `a task with no exec must declare dependsOn`                                                                                          | Group task with no edges.                                                                                                                                                                                                      |
| `cache needs exec — a task with no command produces nothing to cache`                                                                 | `cache` on a group: a task with no command writes nothing to cache.                                                                                                                                                            |
| `dependsOn must be an array of strings`                                                                                               | Wrong shape.                                                                                                                                                                                                                   |
| `cache needs inputs — the key is the task's inputs`                                                                                   | Forgot `inputs` on a cached task.                                                                                                                                                                                              |
| `inputs must be an object`                                                                                                            | Present but not an object: a string (`outputs: 'dist'`). An array is the row above.                                                                                                                                            |
| `inputs.files must be an array`                                                                                                       | Wrong shape.                                                                                                                                                                                                                   |
| `inputs.runtime must be an array of non-empty shell command strings with no NUL`                                                      | Non-string / blank entry (whitespace alone runs as a no-op), or one holding a NUL.                                                                                                                                             |
| `inputs.workspaceRuntime must be an array of non-empty shell command strings with no NUL`                                             | Non-string / blank entry (whitespace alone runs as a no-op), or one holding a NUL.                                                                                                                                             |
| `inputs.tasks must be an array of non-empty strings`                                                                                  | Non-string / empty entry, or a bare string.                                                                                                                                                                                    |
| `inputs.tasks: "<name>" names no task in <task>.dependsOn`                                                                            | An exact entry no `dependsOn` entry of its form names.                                                                                                                                                                         |
| `invalid inputs.tasks "<entry>": <reason>`                                                                                            | A malformed entry (`^`, `a#`, `#x`, `!`, `^a#b`), refused at load with the parser's reason.                                                                                                                                    |
| `cache.outputs is required when cache is set`                                                                                         | Forgot `outputs`.                                                                                                                                                                                                              |
| `cache.inputStability must be an object`                                                                                              | A bare string (`inputStability: 'mutable'`).                                                                                                                                                                                   |
| `cache.inputStability.strategy must be 'immutable', 'mutable' or 'unchecked'`                                                         | Any other value (`'content'`, `false`).                                                                                                                                                                                        |
| `cache.inputStability.severity must be 'warn' or 'error'`                                                                             | Any other value (`'fail'`, `true`).                                                                                                                                                                                            |
| `cache.outputs must be an object`                                                                                                     | Present but not an object: a string (`outputs: 'dist'`). An array is the row above.                                                                                                                                            |
| `cache.outputs.files must be an array`                                                                                                | Wrong shape.                                                                                                                                                                                                                   |
| `inputs.files: every entry is a negation, which selects NOTHING`                                                                      | Only `!` globs — nothing to subtract from.                                                                                                                                                                                     |
| `inputs.files: "<file>" is taken back by "!<glob>"`                                                                                   | A literal input a `!` entry covers: the negation subtracts wherever it sits, so the file never entered the key.                                                                                                                |
| `cache.outputs.files: every entry is a negation, which selects NOTHING`                                                               | Only `!` globs: a `!` entry only takes back what a positive glob selected (A-44).                                                                                                                                              |
| `cache.outputs.files: "<file>" is taken back by "!<glob>"`                                                                            | A literal output a `!` entry covers: it is never saved, so a hit left it missing and said up-to-date.                                                                                                                          |
| `cache.outputs.files: "<glob>" covers the project's own <file>`                                                                       | An output glob that matches the project's own `vx.config.*` (`**`, `*.ts`): the clean before a run would delete it. A `!` entry that takes the file back (`!vx.config.ts`) lets it load.                                       |
| `cache.outputs.files: "<glob>" is under workspace-outputs/`                                                                           | A project output named into the artifact's namespace for `outputs.workspaceFiles`: every hit read it back as a workspace output.                                                                                               |
| `inputs.files: '!!' is not a double negation`                                                                                         | `!!x` inverts the set — it folds only `x`.                                                                                                                                                                                     |
| `exec.timeout of <value> exceeds the maximum timer delay`                                                                             | Past 2^31-1 ms a timer fires at once, not never.                                                                                                                                                                               |
| `description must be a string`                                                                                                        | Non-string description.                                                                                                                                                                                                        |
| `tag "<tag>" <why> — --filter tag:<name> could not name it`                                                                           | A tag with surrounding whitespace or a `*`, or one ending in `...` or `[<ref>]`, which a filter reads as a pattern, a dependency walk or a git range.                                                                          |

**Unknown fields are rejected**, not ignored, at every object level —
the project's top level (`tasks`), the task itself, `exec`, `exec.env`,
`exec.persistent`, `exec.sandbox` and its `allow` /
`deny` / `ignore` blocks, `cache`, `inputs`, and `cache.outputs`
(`tests/schema-unknown-keys.test.ts` walks every one) — and at the top
of `.vx/workspace.ts`,
where `plugin:` (singular) would otherwise declare no plugins and run
the workspace bare. A silently-dropped
`workspaceFile` (singular) or `timeoutMs` would make the task hash as
though the field had never been written, so vx would replay an artifact
built from different inputs; a silently-dropped `env: { set: … }` would
run the task without the variables it was written to have. The error
names the offending key, lists what that level accepts, and adds the
nearest accepted spelling when one is within two edits:
`tasks.build.exec.env has unknown field "passthrough" (allowed: define,
passThrough, secret) — did you mean passThrough?`. A field another runner spells
on the task names vx's home for it instead (D-37): Turbo's `outputs`,
`inputs`, `env`, `passThroughEnv`, `persistent`, `outputLogs`, `interactive`
(`exec.interactive`) and `with`, Nx's target `executor`, `options`, `continuous` (D-49), `cwd`,
`parallelism` and `configurations` (D-89), and a `command`
(`cmd`, `script`) on the task or `cmd` on `exec`, and on `exec` Nx
run-commands' `cwd`, `args`, `commands`, `parallel` and `shell`
(D-100), and in a `cache` block wireit's `files` / `output`,
`env`, `dependencies`, `enabled`, and `globs` / `include` / `patterns` /
`exclude` / `ignore` under `inputs` or `outputs` (D-118). So `outputs` on a task
ends `— vx spells it cache.outputs.files` in code quotes. A field of
`exec`, `inputs` or `cache` written on the task itself (`retries`,
`timeout`, `files`) names the level it belongs to (`exec.retries`). A `cache` that
is no object (Turbo's `cache: false`) and a `persistent` that is none
(`true`) name the shape to write.

Project-discovery errors (`src/workspace/workspace.ts`, `src/orchestrator/projects.ts`):

| Symptom                                                                                         | Cause                                                                     |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `two projects are named "<name>": <dir> and <dir> — give one another \`name\` in its vx.config` | Two directories got one name: a config's `name`, a plugin's, or the path. |
| `<dir>: a project is named by its path unless named, and this one holds "#" …`                  | A path no task spec can address: set `name` in its config.                |
| `<dir>: "//" names the workspace root — set another \`name\``                                   | A config away from the root says `name: '//'`.                            |
| `.vx/projects.lock.json locks <dir>, but its <file> is gone — run \`vx lock\``                  | A locked project's config was deleted or renamed (X-144).                 |
| `.vx/projects.lock.json locks <dir>, but its <file> is not readable by this user (<code>)`      | This user may not search the project's directory (D-132).                 |
| `.vx/projects.lock.json has unsupported version <n> (this vx expects 3) — re-run \`vx lock\``   | A lock an earlier vx wrote (version 2 keyed by name).                     |
| `git ls-files failed (exit <n>): <why>`                                                         | `vx lock` could not list the configs (a torn index).                      |

Core reads no `package.json` or `pnpm-workspace.yaml`; the errors reading them are `@vzn/vx-migrate`'s (its README, "Errors reading the members").

Workspace-config errors:

| Symptom                                                                                                                                                                               | Cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<setting> must be <what its kind takes> (got <value>)`                                                                                                                               | A setting of the wrong type or out of range: `run.concurrency: 0`, `cache.dir: 42`, `run.schedule: 'fastest'`. The [settings table](#settings) says what each takes; a count is a number and a switch a boolean, never a string.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `<setting> takes a duration with its unit, like '<n>ms' or '<n>s' (got <n>)`                                                                                                          | A bare number for a duration: `run.timeout: 30000`. Durations carry a unit, so `30000` cannot be read as seconds by mistake.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `<setting> of <value> exceeds the maximum timer delay`                                                                                                                                | A timer past 2^31-1 ms fires at once, not never. Omit `run.timeout` for no limit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `<group> must be an object (fields: <fields>)`                                                                                                                                        | `run`, `watch`, `run.rules` or `cache.retention` that is not an object.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `cache must be an object like { dir, policy }; a task caches through its own cache in its project's vx.config`                                                                        | Not an object: Turbo's and Nx's workspace `cache: true` is a task's own `cache` in vx.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `cache.dir holds a NUL, which no path can carry`                                                                                                                                      | No path can hold a NUL; the cache directory's error blamed the workspace's permissions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `baseBranch must be a branch name like 'main'`                                                                                                                                        | Not a string, empty, holding whitespace, a NUL, `..` or one of `~^:?*[\`, or starting with `-`, which git would read as an option.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `plugins must be an array of plugin objects`                                                                                                                                          | Wrong shape.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `plugins[<i>] must be an object`                                                                                                                                                      | A non-object entry in `plugins`; a string (Nx's `'@nx/vite/plugin'`) adds that a plugin is what its package's function returns, not a module name (D-49).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `plugins[<i>] must come from definePlugin(import.meta, { … })`                                                                                                                        | A plain object where a plugin was expected: a plugin's name is its package name, and only `definePlugin` sets it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `plugins[<i>] is a Promise — await the factory that returns the plugin`                                                                                                               | An async plugin factory called without `await` (`plugins: [later()]`); the refusal said the plugin did not come from `definePlugin` (D-159).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `plugins[<i>].name overrides the package name`                                                                                                                                        | A `name` set over `definePlugin`'s result; drop the field.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `plugins[<i>].<capability> of plugin '<name>' must be a function`                                                                                                                     | A capability key holding something that is not callable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `plugins[<i>] (plugin '<name>') must contribute at least one of config/discover/project/graph/key/fingerprint/schedule/admit/executor/cache/telemetry/output/setup/commands/teardown` | A plugin object with no capability.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `plugin '<name>' declares '<key>', which is no plugin hook`                                                                                                                           | A key on a plugin that names no hook (`excutor`, `setUp`): it was never called. The nearest hook is hinted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `<file> has unknown field "<key>"`                                                                                                                                                    | Typo'd / unsupported top-level key (`plugin`); the hint names the nearest spelling, or where vx keeps a Turbo or Nx key (`pipeline`, `remoteCache`, `parallel`, `cacheDirectory`, `defaultBase`, `tasksRunnerOptions`, `globalPassThroughEnv`; D-38, D-49; pnpm-workspace.yaml's, Lerna's and package.json's `packages`, `workspaces`, `catalog`, `npmClient`, and `ignore`, `cache`, `remote`, `env`, D-98; in a project's vx.config, `targets`, `extends`, `implicitDependencies` and `name`, D-56; `scripts`, `pipeline`, `namedInputs`, `root`, `sourceRoot`, `projectType`, and a task's `dependsOn`, `cache`, `exec`, `inputs`, `outputs`, `env` one level too high, D-99). |
| `plugin '<name>' declares command '<verb>', a core verb — core verbs cannot be shadowed`                                                                                              | A plugin verb the dispatcher matches first; it could never run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `plugin '<name>' declares command '<verb>', which is not a word — a verb is a letter or digit, then letters, digits, ':', '.', '_' or '-'`                                            | A verb like `--version`, `''` or `a b`: core reads a flag first, an empty word is no verb, and `vx completions` writes verbs unquoted into a shell script.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `plugins '<a>' and '<b>' both declare command '<verb>' — a verb has one owner`                                                                                                        | Two packages on one verb; the first would win and hide the second. Plugins of one package are one owner, and the first declared runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `plugins[<i>].fingerprint of plugin '<name>' must be { files: [name, …], affected: function, extraFiles?: function }`                                                                 | A fingerprint claim without its file list or its `affected` answer, or with an `extraFiles` that is not a function.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `plugin '<name>' claims fingerprint file "<file>", which is not a file name at the workspace root`                                                                                    | A claim names a path, or no name: a claim is a bare file at the root (`vx watch`'s root arm is not recursive).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `plugins '<a>' and '<b>' both claim fingerprint file '<file>' — a file has one claimant`                                                                                              | Two plugins keying the same lockfile; the key would fold both and `--affected` could ask only one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `plugin '<name>' claims fingerprint file '<file>' twice (plugins[<i>] and plugins[<j>]) — a file has one claimant; declare the plugin once`                                           | One plugin package declared twice (`plugins: [bun(), bun()]`); the message named it as two plugins (D-158).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
