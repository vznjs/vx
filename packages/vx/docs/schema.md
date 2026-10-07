# Config schema

Complete reference for every field accepted by `vx.config.{ts,mts,js,mjs,cts,cjs}`
and the optional workspace-level `vx.workspace.{ts,mts,js,mjs,cts,cjs}`. The
authoritative TypeScript definitions live in `src/config.ts` and are
re-exported from `@vzn/vx`.

## File layout

```
<workspaceRoot>/
├── pnpm-workspace.yaml          (or: package.json with "workspaces", or bare package.json)
├── vx.workspace.ts              (optional, workspace-wide settings)
└── packages/
    └── <pkg>/
        ├── package.json
        └── vx.config.ts         (per-package task definitions)
```

A project is discovered as a vx project by the **presence of a
`vx.config.*` file alongside the project's `package.json`.** Projects
without a config are visible in the workspace graph but contribute no
tasks.

## Project config

```ts
import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tags: ['scope:web', 'type:app'],
  tasks: {
    <taskName>: TaskConfig,
    ...
  },
})
```

```ts
interface ProjectConfig {
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
referenced by `dependsOn`, by `cache.inputs.tasks`, and by the CLI
(`vx run <taskName>` or `vx run <pkg>#<taskName>`), so a name those
could not spell is refused at load: an empty one, one with surrounding
whitespace, one holding `#` (the project separator) or `*` (a pattern),
and one starting with `^` (dependencies' tasks) or `!` (a negation).

`tags` label the project for selection: `--filter tag:<name>` selects
the projects carrying one (`cli.md` § Filter DSL), as Nx's `tag:` does.
Each is a non-empty string; anything else is refused at load. A
`project` plugin may set or edit them (`nx()` gives each project its Nx
`tags` unless the vx.config has its own). A tag is in no cache key: it
changes no task's behaviour, so editing one re-runs nothing.

## `TaskConfig`

```ts
interface TaskConfig {
  description?: string // one-line blurb for the picker / --dry view
  exec?: ExecConfig // omit to declare a group task
  dependsOn?: readonly string[] // Turbo/Nx micro-syntax
  cache?: CacheConfig // caching is opt-in; requires `exec`
}
```

A task either has an `exec` (it does work) or omits `exec` and declares
`dependsOn` (it's a **group task**, a pure aggregator). The loader
rejects a task that has neither — a no-op standalone task is almost
always a config mistake. `dependsOn: []` is the deliberate form: an
explicit empty group, for a package that wants a task by that name to
exist and do nothing.

A project whose config and plugins declare no `build` gets one (owner,
2026-10-04): a group with `dependsOn: ['^build']` keyed on every file of
the project (`cache.inputs.files: ['**']`, no outputs). It runs nothing,
but a dependant behind `^build` folds its key, so a package consumed as
source moves its dependants' keys and reaches them under `--affected`.
It is the one keyed group; a config cannot declare `cache` on one.

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
  cache: {
    inputs: { files: ['src/**', 'tests/**'] },
    outputs: { files: [] },
  },
}
```

### `exec` (optional — required for non-group tasks)

```ts
interface ExecConfig {
  command: string // shell command, run from the project's dir
  remote?: boolean | 'only' // placement: pin here, or remote-only (see below)
  env?: ExecEnv // optional per-task env layering
  timeout?: number // ms before vx SIGTERMs the child (see below)
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

Maximum time in milliseconds before vx SIGTERMs the child. Omitted →
no limit.

```ts
build: { exec: { command: 'tsc -b', timeout: 120_000 } }
```

- For a **normal task**, `timeout` bounds the total run time. A task
  that overruns is killed — its whole process group, so what it forked
  goes with it — and reported `failed` (timed out) — never cached. (A timeout SIGTERM is a real failure, distinct from a Ctrl-C
  teardown, which is reported `aborted`.)
- For a **persistent task**, `timeout` bounds the **readiness wait**
  instead: if `readyWhen` hasn't matched within the window the child is
  SIGTERMed and the task fails — see `persistent` below. A persistent
  task that's ready on spawn (no `readyWhen`) becomes ready before the
  timer can fire, so the timeout is a no-op for it.
- On a **plugin executor**, the timeout aborts the request's `signal`
  instead (core cannot kill a process the executor spawned); a non-zero
  exit after it is reported timed out, and an executor still running
  after the kill grace is abandoned (H-12, H-14).

**Upper bound.** `timeout` must be at most **2147483647 ms (~24.8 days)**,
the largest delay a timer can hold. A larger value does _not_ mean "no
limit" — the platform silently reduces it to **1 ms**, so the task would
be killed the moment it spawns and reported `failed`. vx refuses it at
load rather than let that happen. **Omit `timeout` entirely for no
limit.** The same bound applies to `--timeout` and to the workspace-level
`timeout`; the `VX_TASK_TIMEOUT` env rung is clamped to it instead of
refused, since that rung never fails a run.

A task with **no** `exec.timeout` falls back to a run-level default, if
one is set. Precedence, highest first: **per-task `exec.timeout` →
`--timeout <ms>` / `RunOptions.timeout` → `VX_TASK_TIMEOUT` env →
workspace `timeout`** (see workspace config below). Per-task always
wins. The run-level defaults are threaded as run options, so — like
`--retry` — they never touch a cache key: a `--timeout` run cache-hits a
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
  attempt finishes, and its failure is the last.
- Declared outputs are re-cleaned before each retry, exactly like the
  first attempt — a failed attempt's partial outputs can't leak into
  the next.
- Every attempt streams its output live. Between attempts vx emits one
  stderr line into the task's stream, ending in the reason:
  `vx: retrying <id> (attempt <k>/<total>) after exit <code>`, or
  `after a timeout` when the attempt was killed by `timeout`.
- The final outcome is the LAST attempt's: the first success wins (and
  is what gets cached — its stdout only, not a concatenation of failed
  attempts); if every attempt fails, the task is `failed` with the last
  exit code and nothing is cached, as today.
- The task's reported duration sums every attempt; a saved entry keeps
  the producing attempt's time.
- `retries` is part of the resolved config, so declaring it derives a
  distinct cache key (like every config field); tasks without it keep
  byte-identical keys.
- Not allowed with `persistent` — a persistent task has no exit to
  retry (config error, like `cache` + `persistent`).

The run-level default is `vx run --retry <n>` — it applies to tasks
that don't declare their own `retries`, never to a persistent one (a
server that exits before it is ready fails at once); explicit config
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
- **Pinned by inference too.** A `persistent` task, and anything that
  depends on one (transitively), is pinned regardless of what it
  declares — a worker cannot reach a port served on the submitter. So is
  a task with a `sandbox` block, and its dependants: the sandbox is this
  machine's machinery, and a boundary a worker does not enforce would
  pass vacuously. So is a task whose key folds `cache.inputs.runtime` or
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
    exec: { command: 'pnpm install --frozen-lockfile', remote: 'only' },
    cache: {
      inputs: { files: ['package.json', 'pnpm-lock.yaml'] },
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
  without a newline (`printf 'Listening on :3000'`) count. A server
  not ready after 10 s (`VX_READY_NOTICE_MS`) is said once, naming
  the pattern it waits for, and whether `exec.timeout` bounds the wait.

```ts
dev: {
  exec: {
    command: 'vite',
    timeout: 30_000, // bound the readiness wait
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
  request, whose every dependant is a confirmed local cache hit, is
  never spawned: a fully cached `vx run e2e` does not boot the server
  `e2e` depends on, and the server is in no outcome or count. It starts
  if one of those hits turns out to need running (its artifact went),
  and that task runs once it is ready. A dependant whose key the
  server's writes could change (one in its own project, unless a sandbox
  bounds the server's writes) is not probed ahead of it, so there the
  server still starts.
- **Exit before ready ⇒ failed.** If the persistent task crashes or
  exits before `readyWhen` matches, the task is reported as `failed`.
- **Crash after ready ⇒ failed run.** A persistent task that exits
  non-zero (or is killed) on its own after it became ready fails the
  run, and vx names it: `vx: <id> exited with code <n>` (a signal death
  as its `128 + n` code), at once while the graph still runs (`… while
the run went on`), so a dependant failing against it reads why. Its own outcome is `failed` with that exit
  code, and the footer counts it so (item 1071). An exit 0 on its own is
  fine (a daemon that forks and returns).
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

```ts
'db:push': {
  exec: { command: 'drizzle-kit push', interactive: true },
}
```

#### `ExecEnv` (optional)

```ts
interface ExecEnv {
  passThrough?: string[] // names taken from host process.env; exact names, a wildcard is refused
  define?: Record<string, string> // explicit name=value pairs
  secret?: string[] // names whose values are masked (`***`) whatever the name; see Masking
}
```

The child process sees a deliberately limited env. From lowest to
highest priority:

1. **Essential allowlist** (hard-coded in `src/exec/env.ts`, and pinned
   against this list by a test): `PATH`, `HOME`, `SHELL`, `USER`,
   `LOGNAME`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, `LC_ALL`, `LC_CTYPE`,
   `TERM`, `COLORTERM`, `FORCE_COLOR`, `NO_COLOR`, `CI`, `NODE_OPTIONS`.
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
   orders differently), and **`CI` / `FORCE_COLOR` / `TERM`** (stdout
   bytes, and vx caches and replays stdout).

   They are not hashed because hashing them would mean a laptop and a
   CI runner could **never share a remote cache entry** — `PATH`,
   `HOME` and `TERM` differ on every machine, which is the whole point
   of a remote cache. vx does not guess which ones matter to your
   build; if one does, say so explicitly:

   ```ts
   cache: { inputs: { files: ['src/**'], env: ['NODE_OPTIONS'] }, outputs: { files: [] } }
   ```

   That folds its value into the key. The two axes are orthogonal on
   purpose: `cache.inputs.env` decides what the key _sees_,
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

Every name in these lists (and in `cache.inputs.env`) must be one an
environment can hold: non-empty, with no `=` and no NUL, and a `define`
value holds no NUL. Such a name is refused at load; it used to reach the
child split at its `=` or not at all.

vx also sets `npm_execpath` to the workspace's package manager (the root
`package.json`'s `packageManager`, else its lockfile, found on the root's
`node_modules/.bin` or `PATH`) unless a layer gives one, as `pnpm run`
does: npm-run-all calls that manager back and falls back to a global `npm`
without it. It names a binary on this machine, so it is not in the key.

Anything outside these three layers, the two variables vx sets for
the run (`VX_RUN_WORKSPACE`, `VX_RUN_TASK`) and `npm_execpath`, is invisible to the child:
a host credential (`SSH_AUTH_SOCK`, `GITHUB_TOKEN`) reaches a task only
when `passThrough` names it, held end to end by `env.test.ts` (a
sandboxed task with a restricted network also gets the sandbox's own
proxy, CA and `TMPDIR` values over these names:
`modules/sandbox-runtime.md` § The environment SRT sets). This
matches Turbo's `passThroughEnv` semantics and exists for two reasons:

- **Cache stability.** If every host env var entered the key, every
  shell with a different `PS1` would cache-miss.
- **Determinism.** If host env leaked into the child, two machines
  with different `FOO=bar` set would produce different outputs and
  the user would never know why.

**Masking.** The value of a variable whose name holds `TOKEN`, `SECRET`,
`KEY`, `PASSWORD`, `PASSWD` or `CREDENTIAL` (vx's own environment or a
task's `define`, six characters or more; not a name ending `_FILE`,
`_PATH` or `_DIR`, nor git's `GIT_CONFIG_KEY_<n>`) is printed as `***` wherever vx
shows it: the task's output and the line vx adds under a shell's 127 or
126 (the command's first word), the stdout the cache keeps and a hit
replays, the command a cache entry stores (what `vx why` prints and a
remote cache receives), the `$ command` line, telemetry records,
`vx show`, the hashes `vx why` gives for such a variable in
`cache.inputs.env` (its value, unsalted: the row names it and its change), an executor's error or a plugin's warning (a remote's reply), and the run's own invocation line that `vx last` prints (a
secret passed after `--`) and its `--tag`s. A multi-line value (a PEM
key) is also masked line by line, each line of six characters or more,
and a value holding a `'` also as a shell-quoted line spells it (`'\''`).
A value
split across two output chunks is still caught; the output holds back
that many characters until the next chunk. A plugin that reads a task's
config directly sees it as written. A secret whose name holds none of
those words (`GH_PAT`, `NPM_AUTH`) is listed in `exec.env.secret`, and is
then masked in the same places.

Two `node_modules/.bin` directories are prepended to `PATH` so
installed tools (`oxlint`, `vite`, etc.) work without `npx`: the
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

| Form         | Meaning                                                            |
| ------------ | ------------------------------------------------------------------ |
| `'name'`     | Same-project task `name`.                                          |
| `'^name'`    | The `name` task in the nearest workspace deps that declare it.     |
| `'pkg#name'` | The `name` task in a specific other package (cross-project edge).  |
| `'name.*'`   | Every OTHER same-project task matching the pattern (`*` = any).    |
| `'^name.*'`  | All matching tasks of the nearest deps that declare any (pattern). |

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
- **`'^name'`** — nearest-holder frontier. Walk the package dep graph
  from this project's direct deps (`dependencies`, `devDependencies`,
  `optionalDependencies`, and a `peerDependencies` entry on a
  workspace sibling unless that edge would close a cycle — then the
  consumer provides it and it orders nothing; an entry is a dep when
  the package manager links it to the workspace package, so a range the
  local version does not satisfy is a registry dependency, see
  `modules/package-graph.md` § Which entries are edges); each path stops at the first dep
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
  hard error at graph-build time, since it can only be a typo: "Task
  app#test depends on ^biuld but no project in the workspace declares
  biuld". Until 2026-09-24 it resolved to no edges and the run went
  green (Nx#32779 is the same bug). A scoped run (an anchored
  `app#test`, `--filter`, a project directory) loads only its projects
  and their dependency closure; when a `'^name'` there finds no holder
  and nothing loaded declares it, vx evaluates the remaining configs to
  decide, and if one of them fails to load the name is let through
  rather than failing the scoped run. A `'^name.*'` pattern matching
  nothing anywhere stays legal, as `'name.*'` does.
- **`'pkg#name'`** — missing pkg or task is a hard error (you named
  them explicitly). `'//#name'`, Turbo's spelling of the root package,
  names the root project (D-39) here and in `cache.inputs.tasks`; with no
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
- **No bare wildcards or negation here.** `'*'` / `'^*'` / `'!form'`
  belong in `cache.inputs.tasks` (filtering which upstream hashes
  participate in this task's cache key), not in `dependsOn` (declaring
  graph edges). The micro-syntax parser rejects them in this position.
- **Cycle detection** runs across the resolved graph at the end of
  `buildTaskGraph`. Cycles throw with a path-formatted message.

### `cache` (optional)

```ts
interface CacheConfig {
  inputs: CacheInputs // required when `cache` is provided
  outputs: CacheOutputs // required when `cache` is provided
}
```

**Caching is opt-in.** Omit `cache` and the task always runs (no read,
no write). Provide it and caching is active for that task. The
project loader requires _both_ `inputs` and `outputs` when `cache` is
set — declaring "what does this read?" and "what does it produce?" is
a deliberate, conscious choice.

**Why opt-in?** Defaulting caching to ON with implicit "all files / no
outputs" silently produces stale builds the moment a user forgets
to revisit the config. The cost of a single forgotten cache miss
(re-run a task) is much less than the cost of a stale cache hit
(ship broken artifacts).

#### `CacheInputs`

```ts
interface CacheInputs {
  files: string[] // required
  workspaceFiles?: string[] // optional; workspace-root-relative
  env?: string[] // optional
  runtime?: string[] // optional; project-dir shell commands
  workspaceRuntime?: string[] // optional; workspace-root shell commands
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

The wildcards are `*`, `**`, `?` and a brace set `{a,b}`. A bracket is a
**literal character**, not a character class: `app/[id]/**` is the route
directory `app/[id]` (Next.js, SvelteKit, Astro), never `app/i` or
`app/d`. The escaped spelling `app/\[id\]/**` (Turbo's) means the same
path. An input brace of one alternative (`{b}.ts`) is refused: it
would match `b.ts` and never a file named `{b}.ts`; write the one you
mean, `\{b\}.ts` for the braces. An extglob (`@(a|b)`, `!(x)`,
`+(…)`, `*(…)`, `?(…)`) is refused too: `Bun.Glob` reads it as literal
text or a plain wildcard, so the key would miss the files it names;
write `{a,b}`. A leading `!` is still the negation, so `!(group)/**`
takes a route group back. This holds for every task glob — `inputs.files`,
`inputs.workspaceFiles`, `outputs.files`, `outputs.workspaceFiles` — and
for everything read from them (`--affected`, `vx watch`, the
overlapping-output refusal). Package-manager member globs (`workspaces`,
`pnpm-workspace.yaml`) and `--filter` path globs keep the package
manager's grammar, class included — all but extglob (`packages/!(x)`),
which a member glob refuses by name: `Bun.Glob` cannot read it, and
list the exclusion as its own `!packages/x` entry instead.

```ts
files: ['**/*'] // all project files
files: ['src/**', '!**/*.test.ts'] // narrow with exclusion
files: [] // no file inputs at all
files: ['src/**', 'tsconfig.json', 'package.json'] // specific paths
files: ['src', 'package.json'] // a directory literal is its tree
files: ['app/[id]/**'] // a bracket is literal: the route dir `[id]`
```

Empty array is valid — the cache key still incorporates command, env,
upstream hashes, workspace fingerprint, and the project's
package.json. A task with no _file_ inputs (e.g. a pure
"download-and-verify") still cache-misses on a lockfile change.

Always applied to every glob pass (regardless of what you wrote):

- **gitignore filter** — workspace-root + project `.gitignore`.
- **Always-ignored** — `.git/**`, `.vx/**`, `*.tsbuildinfo`,
  `vx-lock.json`, `*.bun-build`, and Bun's cross-compile extraction
  directory `.<16 hex>-<8 hex>.tmp/**`, at any depth.
- **Installs** — an untracked file under any `node_modules/` (ignored or
  not). A file git TRACKS there, such as a committed test fixture, is an
  input like any other.
- **Declared `outputs.files`** are excluded — a task never invalidates
  itself via its own output. A path an output `!` entry takes back is
  no output, so it stays an input (A-44). Another task's outputs are
  not excluded for you: an input glob that can match them is refused
  while `rules.upfrontKeys` is on (X-54). Write the exclusion,
  `['**/*', '!dist/**']`. An input entry the task's OWN outputs take
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
resolution (tracked + untracked-not-ignored; gitignored files are
invisible), and the resolved paths join the same cache-key file list.

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

Still applied: the always-ignored set (`.git/**`, `.vx/**`,
`*.tsbuildinfo`, `vx-lock.json`, `*.bun-build`, `.<16 hex>-<8 hex>.tmp/**`),
untracked files under `node_modules/`, and the task's own declared
`outputs.workspaceFiles` (a task never invalidates itself).

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

Shell commands whose **combined, trimmed stdout + stderr** is folded
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
  `vx run --frozen` — the changed output of a frozen command still
  busts the cache.
- A **non-zero exit fails the run** (a hard `UserError` naming the
  command and exit code) — fail-loud, like a missing git binary. A
  flaky probe should not silently degrade to a stale hit.
- The command **inherits vx's full environment**, _not_ the isolated
  env that task `exec` commands get — `exec.env.define` and
  `passThrough` describe the command's environment, not the probe's.
  This is deliberate — `node -v` / `rustc --version` need the real
  `PATH` and toolchain env, and it is what lets two tasks sharing a
  probe share one spawn (the per-run dedup above). The flip side (same
  as `inputs.env`): an env var that differs between machines silently
  changes the key; declare such inputs explicitly if you want them
  visible.
- Its `PATH` does lead with the **same `node_modules/.bin` directories
  the task's does** (the project's, then the workspace root's), so
  `tsc --version` keys the `tsc` the task runs. Before item 996 it keyed
  the global one, or failed with 127 where only the workspace had it, and
  a changed local tool replayed the old output.
- The command **runs whenever a task's key is derived** — that's every
  run (warm runs included, since the key decides hit vs miss), plus
  `vx run --dry` / `--graph` (which predict the key) and `vx run
--no-cache` (which still derives the key). Keep runtime commands pure
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
hit waiting for the next upstream change. Patterns, wildcards and
negations stay silent (a preset-spread pattern legitimately matches
nothing in some projects); `[]` is the explicit way to decouple.

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

#### `CacheOutputs`

```ts
interface CacheOutputs {
  files: string[] // required
  workspaceFiles?: string[] // optional; workspace-root-relative
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

A **symlink** the globs match is an output: it is captured as its
target's bytes and restored as a regular file, and the clean unlinks
it (never following it). A link to a directory, a dangling one, or
one whose target is outside the project cannot be stored — the save refuses it by name and caches nothing, so
the next run executes again. A link to another output of the same task
is stored wherever it is: `gen/latest -> v2.txt` under a
`workspaceFiles` output caches (A-53). The clean also prunes the directories it
emptied, so an output that is a directory one run and a file the next
restores either way.

Empty `[]` is valid for tasks that produce no files (e.g. `lint`,
`typecheck`, `test`); you still cache the no-op success so the next
run is a no-op too.

A **`!` entry takes a path back** from what the positive globs select
(A-44; a tracked fixture and a scratch dir under `dist` stay out of
the clean this way):

```ts
outputs: {
  files: ['dist/**', '!dist/fixture.html', '!**/*.tmp']
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

Skipped when `cache.outputs.files` is empty (nothing declared as
output) and when no cache-write axis is enabled (e.g. `--no-cache`,
or a read-only `--cache=local:r`) — the user is debugging and
managing the tree themselves. `--force` keeps writes on, so it does
clean.

##### `outputs.workspaceFiles` (optional, default `[]`)

Workspace-root-relative globs for outputs the task writes OUTSIDE its
project dir (e.g. a root-level generated file). Same capture / restore
/ wipe semantics as `files`, anchored at the workspace root; packed
into the artifact under a separate `workspace-outputs/<rel-to-root>`
namespace so project and workspace outputs never collide. A project
`outputs.files` glob under a top-level `workspace-outputs/` is refused
at load: that name is the namespace.

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
`dist/extra/**` or `dist/*.js` (item 941). Globs that only _might_
overlap (`dist/*` and `dist/sub/**`) are let through; there, last
restore wins. A workspace output is also compared with every other
project's `files` outputs, read from the root: `packages/b/dist/a.txt`
collides with `b`'s `dist/**` (item 1088). An overlap
between two tasks one of which depends on the other is refused too,
unless the workspace sets `rules: { exclusiveOutputs: false }` (X-53);
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
[sandboxing guide](https://vznjs.github.io/vx/guides/sandboxing/).

```ts
interface SandboxConfig {
  allow?: SandboxGrants // what the command may do
  deny?: { network?: string[] } // domains to refuse, run-wide (below)
  ignore?: SandboxIgnore // violations to leave out of the report
  weakerWhenNested?: boolean // Linux: let a sandboxed task sandbox (default false)
  weakerNetworkIsolation?: boolean // macOS: host-proxy net, lower isolation (default false)
}

interface SandboxGrants {
  read?: string[] // paths or globs, project-relative or absolute
  write?: string[] // paths or globs; a write grant is readable too
  network?: true | string[] // an allowlist of domains; `true` adds none (below)
  systemInfo?: string[] // sysctl names, e.g. 'vfs.disk-space' (macOS)
  unixSockets?: true | string[] // AF_UNIX bind/connect, all or by path (Linux: any path)
  localBinding?: boolean | number[] // bind and reach localhost ports (macOS; Linux needs no grant); a list also exposes them to the host (a port the host already holds fails the task)
  machLookup?: string[] // mach global-names (macOS)
  pty?: boolean // acquire a TTY
  gitConfig?: boolean // write the repository's .git/config (this task only)
}

interface SandboxIgnore {
  read?: string[] // denied reads to leave out of the report
  write?: string[]
  systemInfo?: string[]
  network?: string[] // '<host>:<port>'
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
Unlike a task glob, a grant keeps `Bun.Glob`'s brackets: `[id]` is a
class, so a Next.js route is granted escaped, `read: ['pages/\\[id\\].tsx']`.
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
is one whose bind would make `.git`, `.vx`, the cache directory or a
nested project writable:
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
`tests/sandbox-runtime.unsafe.test.ts` (2026-09-20) and
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
`ignore: { network: ['<host>:<port>'] }` silences one. Until 2026-10-02
Linux reported none, and the line could not be ignored on macOS.

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
grant names one (`read: ['.', '~/.npmrc']` for a publish), since a
dependency the task ran could copy a key into an output the cache
shares (L-41): `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`,
`~/.config/gcloud`, `~/.config/gh`, `~/.docker/config.json`, `~/.netrc`,
`~/.git-credentials`, `~/.npmrc`, `~/.yarnrc.yml`, `~/.pypirc`.
What it grants from there is the union of the read grants and, on Linux,
the DIRECTORY holding each file-shaped write grant (above).
Nothing is inherited from `cache` — `cache.inputs` says what INVALIDATES a task, `sandbox.allow`
says what it may TOUCH, and deriving one from the other made a
declaration added for caching silently widen the sandbox. The one grant
vx makes for you is dependencies: `node_modules` and, through it, the
real path of every workspace package linked there. A project never names
a sibling to import what its `package.json` already depends on. A link
back to the task's own project, or to a directory holding it, is not
followed: npm and Yarn link every workspace package at the root, the
task's own included, and following it would grant the whole project
past its `allow.read`.

A task that declares `cache` gets a linked workspace package only when
its key already answers for it: some task of that package is folded into
the key through `dependsOn` (as `cache.inputs.tasks` selects it, groups
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
task saw no project and ran in `$HOME`).

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
project with no `build` gets a keyed one (above).
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

- A task with no `exec` AND no `dependsOn` (literal no-op).
- A `cache` block on a group (nothing to cache).

## Workspace config (`vx.workspace.ts`)

Loaded from `vx.workspace.{ts,mts,js,mjs,cts,cjs}` at the workspace root.
**Optional** — when missing, every field falls back to its built-in
default.

```ts
import { defineWorkspace } from '@vzn/vx/config'
import { otel } from '@vzn/vx-otel'

export default defineWorkspace({
  concurrency: 8,
  cacheDir: 'build/.vx-cache',
  timeout: 600_000,
  cacheRetention: { olderThan: '30d', maxSize: '10G' },
  plugins: [otel()],
})
```

```ts
interface WorkspaceConfig {
  /** Maximum concurrent tasks. Defaults to the cores this process may use (the CPU count, capped by a cgroup quota). */
  concurrency?: number
  /** Cache directory, relative to workspace root. Named, it holds the whole cache; unset, entries live in the user's shared store. */
  cacheDir?: string
  /** Default per-task timeout (ms) for tasks without their own exec.timeout. */
  timeout?: number
  /** Evict from the local cache at the end of each run (the `vx cache prune` policy). */
  cacheRetention?: { olderThan?: string; maxSize?: string }
  /** The git ref a bare `--affected` compares with. */
  affectedBase?: string
  /** Where remote writes land: 'trusted' (default), 'read-only', or an untrusted scope name. */
  cacheScope?: string
  /** Graph rules checked before anything runs; each on unless set to false. */
  rules?: WorkspaceRules
  /** Run-level plugins (cache / executor / telemetry capabilities). */
  plugins?: readonly Plugin[]
}

interface WorkspaceRules {
  /** Refuse overlapping outputs even across a dependsOn edge. Default true. */
  exclusiveOutputs?: boolean
  /** Refuse a task whose inputs can match another task's outputs. Default true. */
  upfrontKeys?: boolean
}
```

- **`concurrency`** — used as the default cap on parallel tasks; the
  CLI `--concurrency <n>` still wins when passed.
- **`timeout`** — the lowest-precedence default per-task timeout (ms),
  applied to any task that declares no `exec.timeout`. Precedence,
  highest first: per-task `exec.timeout` → `--timeout` /
  `RunOptions.timeout` → `VX_TASK_TIMEOUT` env → this. A runaway task's
  process group is SIGTERMed and the task reported `failed`. Purely a safety net — never folded
  into a cache key (a timed-out task fails and is never cached).
- **`cacheDir`** — unset, the workspace keeps its index and history in
  `.vx/cache` and its entries and artifacts in its repository's shared
  store (`~/.vx/<id>/cache`), where every other checkout of the
  repository hits them (`docs/caching.md`). Named here, by
  `VX_CACHE_DIR`, or by `--cache-dir`, the directory holds the whole
  cache, shared with no other workspace.
  Relative paths are resolved against the workspace
  root; absolute paths are used as-is. `vx run`, `vx cache prune`,
  and any other reader use the same resolution
  (`src/workspace/workspace.ts:resolveCacheDir`). The cache is a
  directory of its own: a first index in one that holds a
  `package.json` or `pnpm-workspace.yaml` (`''` and `'.'` name the
  root) is refused before anything is written, since its `*`
  `.gitignore` would hide the sources from git and the cache keys.
- **`cacheRetention`** — the `vx cache prune` policy, applied at the
  end of every run: entries unused for
  `olderThan` (`30d`, `12h`, `90m`, `45s`) go first, then the
  least-recently-used until the cache is under `maxSize` (`10G`,
  `500MB`, `64KB`; a bare number is refused as a typo, `10B` is not).
  Either or both, and neither may be zero: each would evict what every
  run just saved (item 969). It runs after the run's saves
  and uploads have landed, never on a run a signal or an abort stopped
  (one stopped while it waited on the workspace lock never held it), only when something is due (a run with
  nothing to evict pays one scan of the index), and says nothing:
  housekeeping prints no line (owner, 2026-10-06). Under `olderThan` an entry the run just used is never due, but `maxSize` is least-recently-used first, so a bound below one run's outputs evicts that run's own. The prune's
  orphan sweep (artifacts no index row counts, older than an hour —
  see `vx cache prune`) also runs on its own clock, at most once an
  hour, so their bytes go even when nothing the index holds is due;
  listing the directory every run would cost 0.5 ms per 1,000
  entries. Housekeeping,
  not the run's work: a failure is silent, never a failed run. Not
  folded into any cache key. Omitted → the cache grows until
  `vx cache prune`.
- **`affectedBase`** — the git ref a bare `--affected` compares with
  (`origin/develop`); `--affected=<base>` still wins. Omitted →
  `origin/HEAD`, then the first of `origin/main`, `origin/master`, `main`, `master` that is not HEAD (D-93), else `HEAD~1`. A plugin's `config` stage may set it:
  `nx()` from `NX_BASE` or nx.json's `defaultBase`, `turbo()` from
  `TURBO_SCM_BASE`, else on GitHub Actions from `GITHUB_BASE_REF` or the
  push event's `before`, as Turbo does. Not folded into any cache key.
- **`cacheScope`** — where this run's remote cache writes land.
  `'trusted'` reads and writes the task keys: the default branch's CI.
  `'read-only'` reads them and writes nothing: a laptop. Omitted, `vx
run` takes `'read-only'` off CI (`CI` unset, `0` or `false`) and
  `'trusted'` on CI or when `--cache` names the remote; `run()` takes
  `RunOptions.defaultCacheScope`, else `'trusted'`.
  Any other name (`'pr-123'`; letters, digits, `. _ - / @`, at most 128) is an untrusted scope: a remote read tries the scope's key, then
  the trusted one, and a write goes to the scope's only, so a pull request
  never writes what the default branch reads, and two scopes never see
  each other. A scope's key is derived from the task key, so every
  remote wire stores it unchanged. A clamp on `--cache`, never a
  widening. `github()` sets it on Actions: `pr-<n>`, `ref-<name>` off
  the default branch. `VX_CACHE_SCOPE` beats both. A client-side convention, not a security
  boundary: a run holding a write credential can write any key, so only
  a cache server that scopes writes by token can refuse one
  (`docs/security.md` § Cache poisoning). Not folded into any cache key.
- **`rules`** — checks on the task graph, each on unless set to
  `false`. Turning one off allows a shape vx runs correctly but more
  slowly; never folded into a cache key. A value that is not a boolean,
  or a rule vx does not know, is refused.
  - **`exclusiveOutputs`** (X-53) — two tasks whose declared outputs
    overlap are refused even when a `dependsOn` edge orders them:
    `<a> and <b> both declare the output "<glob>" … Give each task its
own output path, or set rules: { exclusiveOutputs: false } in
vx.workspace.ts to let a dependant add to its upstream's outputs.`
    Off, the dependant adds to its upstream's tree (item 588;
    `caching.md` § Additive outputs). Two overlapping tasks with no
    edge are refused either way.
  - **`upfrontKeys`** (X-54) — a cached task whose `inputs.files` can
    match a same-project task's `outputs.files`, or whose
    `inputs.workspaceFiles` can match any task's `outputs.workspaceFiles`
    or another project's `outputs.files` read from the root, is refused,
    edge or no edge: `<reader> reads "<glob>" in cache.inputs.<field>,
which matches <writer>'s output "<glob>" … Exclude it: add "!<glob>"
to <reader>'s cache.inputs.<field>, or set rules: { upfrontKeys:
false } in vx.workspace.ts to let it wait for its producer.` Such a key
    reads what the producer writes this run, so vx cannot know it before
    the producer ran: it is not probed, prefetched or restored ahead of
    the schedule (`caching.md` § Local restore tier). The upstream's key
    already reaches the reader through `dependsOn`. A `!` entry that
    takes the whole output back clears it, and an output the reader's
    `!` entries take back no longer holds its key back either. A task's
    own outputs, a task with no `cache`, and a group are exempt. Off,
    the key waits for its producer, as before.
- **`plugins`** — the run-level extension points. Optional: core
  applies no plugin by default, and the local executor and the local
  cache are its floor — the tail of every executor list and cache chain
  — so a workspace that declares none runs and caches here.
  Declaration order is precedence: every `executor` is consulted in
  order per task (first to accept runs it; what all decline runs
  locally); every `cache` layer is chained (lookup walks, save reaches
  all, the local store last). Each entry is a `VxPlugin` contributing
  any subset of the fourteen hooks, in pipeline order: `config` (edit
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
  OTel, the GitHub job summary, a custom sink), `setup` and `teardown`
  around the run, and CLI `commands` (`{ verb: { description, run } }`,
  consulted for a verb core does not know). First-party plugins:
  `@vzn/vx-otel`, `@vzn/vx-ci`, `@vzn/vx-reapi`, `@vzn/vx-lockfile`,
  `@vzn/vx-schedule-history`, `@vzn/vx-mcp`, `@vzn/vx-migrate`. A
  plugin that declines every capability (`otel()` with no OTLP endpoint
  configured) costs nothing — a run with no active plugin is
  byte-identical to one with none declared. Plugins observe, route and
  execute; they never change what a task is.

The loader validates the shape (positive integer for `concurrency`,
string for `cacheDir`, plugin objects with a name and at least one
capability) and throws a `UserError` on
malformed input.

There are no workspace-level `globalInputs` / task-default fields:
root-anchored file inputs are declared per task via
`cache.inputs.workspaceFiles`, root-anchored probes via
`cache.inputs.workspaceRuntime`, and shared task shapes compose
through plain TypeScript (import a preset and spread it) — the
language replaces Nx-style `namedInputs` / `targetDefaults` schema
machinery by design.

## Helpers

```ts
import { defineProject, defineWorkspace } from '@vzn/vx/config'

// Identity functions; their purpose is type inference.
defineProject<T extends ProjectConfig>(config: T): T
defineWorkspace<T extends WorkspaceConfig>(config: T): T
```

Use them so TypeScript narrows literal types in your config —
autocomplete for task names in `dependsOn` against your declared
tasks, strict validation against the schema, errors at edit time
rather than at `vx run` time.

They cost one runtime import of `@vzn/vx` per config file — a second
copy of core loaded into every run (~17 ms on a two-package workspace,
measured 2026-09-09; the `vx` process already holds the first). The
type-only form gives the same editor checking for free, and is what
`vx init` / `@vzn/vx-migrate` write:

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
      cache: {
        inputs: {
          files: ['src/**', '!**/*.test.ts', 'tsconfig.json'],
          env: ['NODE_ENV'],
        },
        outputs: { files: ['dist/**'] },
      },
    },

    // Cached, depends on upstream build; CI is in passThrough only
    // (CI=1 shouldn't bust the cache — it's true on every CI run).
    test: {
      description: 'run unit tests',
      exec: { command: 'bun test', env: { passThrough: ['CI'] } },
      dependsOn: ['build'],
      cache: {
        inputs: { files: ['src/**', 'tests/**'] },
        outputs: { files: [] },
      },
    },

    // Cross-project edges. The pkg.tgz from one project's build is
    // cached, and depends on builds in every workspace dep.
    package: {
      description: 'pack the npm tarball',
      exec: { command: 'rm -rf pkg && npm pack --pack-destination ./pkg' },
      dependsOn: ['build', 'test', '^build'],
      cache: {
        inputs: {
          files: ['package.json'],
          tasks: ['build', '^build'], // hash these upstream too
        },
        outputs: { files: ['pkg/*.tgz'] },
      },
    },

    // Persistent dev server. Downstream tasks unblock on the
    // "Local:" line, not on exit (which never comes).
    dev: {
      description: 'vite dev server',
      exec: {
        command: 'vite',
        timeout: 30_000,
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
      cache: { inputs: { files: ['src/**', '.oxlintrc.json'] }, outputs: { files: [] } },
    },
    'format-check': {
      description: 'oxfmt --check',
      exec: { command: 'oxfmt --check .' },
      cache: { inputs: { files: ['src/**', '.oxfmtrc.json'] }, outputs: { files: [] } },
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
      cache: { inputs: { files: srcInputs }, outputs: { files: ['dist/**'] } },
    },
    test: {
      exec: { command: 'bun test' },
      cache: { inputs: { files: [...srcInputs, 'tests/**'] }, outputs: { files: [] } },
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
    cache: {
      inputs: { files: ['src/**', opts?.tsconfig ?? 'tsconfig.json'] },
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
      cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
    },
  },
})
```

When the preset is consumed at config-load time, it should resolve
to `.ts` source — see
[`architecture.md` § Config-time imports](./architecture.md#config-time-imports--the-bootstrap-problem)
for the bootstrap-cycle tradeoff.

### When to use `cache.inputs.tasks: []`

When a `dependsOn` exists for ordering only, and the upstream's
output doesn't influence this task's output. Common case: an
integration test that depends on a dev server starting up but whose
own inputs are just the test source.

```ts
e2e: {
  dependsOn: ['dev'],
  exec: { command: 'playwright test' },
  cache: {
    inputs: {
      files: ['e2e/**'],
      tasks: [],   // dev's hash does not affect e2e's cache identity
    },
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
(`design/versioning-1.0.md` § How the contract is held). The table below
lists the messages a user meets most:

| Symptom                                                                                                                               | Cause                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `did not export a default object`                                                                                                     | Forgot `export default`, or exported a non-object; a function (Vite's `defineConfig(() => …)` shape) adds that it is one and to export what it returns (D-110).                                                                |
| `tasks must be an object keyed by task name`                                                                                          | `tasks` is not an object — an ARRAY included.                                                                                                                                                                                  |
| `<path> is <what> — a config must be JSON data, because the cache key folds its JSON`                                                 | A value JSON cannot carry, anywhere in the config: a function, a symbol, a bigint, `NaN` / `±Infinity`, `undefined` in an array, a cycle, a getter or an object that is not plain (`Date`, `Map`, `RegExp`, a class instance). |
| `<level> has unknown field "<key>"`                                                                                                   | Typo'd / unsupported key (see below).                                                                                                                                                                                          |
| `<level> has field "<key>", which vx <version> removed — use <replacement>`                                                           | A field an earlier release accepted (`exec.resources`, removed in 0.0.19). The message names what replaced it (`design/versioning-1.0.md` § Deprecation).                                                                      |
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
| `cache requires exec`                                                                                                                 | Group task with `cache`.                                                                                                                                                                                                       |
| `dependsOn must be an array of strings`                                                                                               | Wrong shape.                                                                                                                                                                                                                   |
| `cache.inputs is required when cache is set`                                                                                          | Forgot `inputs`.                                                                                                                                                                                                               |
| `cache.inputs must be an object`                                                                                                      | Present but not an object: a string (`outputs: 'dist'`). An array is the row above.                                                                                                                                            |
| `cache.inputs.files must be an array`                                                                                                 | Wrong shape.                                                                                                                                                                                                                   |
| `cache.inputs.runtime must be an array of non-empty shell command strings with no NUL`                                                | Non-string / blank entry (whitespace alone runs as a no-op), or one holding a NUL.                                                                                                                                             |
| `cache.inputs.workspaceRuntime must be an array of non-empty shell command strings with no NUL`                                       | Non-string / blank entry (whitespace alone runs as a no-op), or one holding a NUL.                                                                                                                                             |
| `cache.inputs.tasks must be an array of non-empty strings`                                                                            | Non-string / empty entry, or a bare string.                                                                                                                                                                                    |
| `cache.inputs.tasks: "<name>" names no task in <task>.dependsOn`                                                                      | An exact entry no `dependsOn` entry of its form names.                                                                                                                                                                         |
| `cache.outputs is required when cache is set`                                                                                         | Forgot `outputs`.                                                                                                                                                                                                              |
| `cache.outputs must be an object`                                                                                                     | Present but not an object: a string (`outputs: 'dist'`). An array is the row above.                                                                                                                                            |
| `cache.outputs.files must be an array`                                                                                                | Wrong shape.                                                                                                                                                                                                                   |
| `cache.inputs.files: every entry is a negation, which selects NOTHING`                                                                | Only `!` globs — nothing to subtract from.                                                                                                                                                                                     |
| `cache.inputs.files: "<file>" is taken back by "!<glob>"`                                                                             | A literal input a `!` entry covers: the negation subtracts wherever it sits, so the file never entered the key.                                                                                                                |
| `cache.outputs.files: every entry is a negation, which selects NOTHING`                                                               | Only `!` globs: a `!` entry only takes back what a positive glob selected (A-44).                                                                                                                                              |
| `cache.outputs.files: "<glob>" covers the project's own <file>`                                                                       | An output glob that matches the project's `package.json` or its own `vx.config.*` (`**`, `*.json`): the clean before a run would delete them. A `!` entry that takes the file back (`!package.json`) lets it load.             |
| `cache.outputs.files: "<glob>" is under workspace-outputs/`                                                                           | A project output named into the artifact's namespace for `outputs.workspaceFiles`: every hit read it back as a workspace output.                                                                                               |
| `cache.inputs.files: '!!' is not a double negation`                                                                                   | `!!x` inverts the set — it folds only `x`.                                                                                                                                                                                     |
| `exec.timeout: <n> ms exceeds the maximum timer delay`                                                                                | Past 2^31-1 ms a timer fires at once, not never.                                                                                                                                                                               |
| `description must be a string`                                                                                                        | Non-string description.                                                                                                                                                                                                        |

**Unknown fields are rejected**, not ignored, at every object level —
the project's top level (`tasks`), the task itself, `exec`, `exec.env`,
`exec.persistent`, `exec.sandbox` and its `allow` /
`deny` / `ignore` blocks, `cache`, `cache.inputs`, and `cache.outputs`
(`tests/schema-unknown-keys.test.ts` walks every one) — and at the top
of `vx.workspace.ts`,
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
ends `— vx spells it cache.outputs.files` in code quotes. A `cache` that
is no object (Turbo's `cache: false`) and a `persistent` that is none
(`true`) name the shape to write.

Workspace-discovery errors (`src/workspace/workspace.ts`):

| Symptom                                                                              | Cause                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failed to parse <file>: <why>`                                                      | A `package.json` / `pnpm-workspace.yaml` is not valid.                                                                                                                                                                                                     |
| `<file>: packages must be an array of glob strings`                                  | `pnpm-workspace.yaml` `packages:` is a bare string, etc.                                                                                                                                                                                                   |
| `<file>: must be a JSON object`                                                      | A `package.json` (the root's or a member's) is `null`, a list or a scalar; it crashed with a TypeError until item 988.                                                                                                                                     |
| `<file>: "name" must be a string with no surrounding whitespace`                     | A `package.json` `name` is a number, an object, or has surrounding whitespace (npm refuses one too); `{"name":123}` planned `123#build` until item 988.                                                                                                    |
| `<file>: "name" cannot hold "#" — vx addresses a task as <name>#<task>`              | A `package.json` `name` holds `#` (npm refuses one too): `{"name":"a#b"}` planned `a#b#build` under `--all`, but `vx run a#b#build` and a `dependsOn` split at the first `#` and found nothing.                                                            |
| `<file>: must be a mapping (packages: and pnpm's settings)`                          | `pnpm-workspace.yaml` is a list or a scalar. A mapping with no `packages:` (pnpm 10 settings or catalogs in a single-package repo) is not an error: the root's `package.json` decides, as without the file (item 984).                                     |
| `<file>: workspaces must be an array of glob strings`                                | `package.json` `workspaces` holds a non-string entry.                                                                                                                                                                                                      |
| `<file>: workspaces.packages must be an array of glob strings`                       | The yarn-legacy `workspaces: { packages: [...] }` form holds a non-string entry.                                                                                                                                                                           |
| `<file>: <field> entry "<glob>" is an extglob, which vx's glob engine does not read` | A member glob holds `!(…)`, `@(…)`, `+(…)`, `*(…)` or `?(…)`. `Bun.Glob` has no extglob (its scan widened `packages/!(x)` to include x, turborepo#3766); a whole-segment `!(a\|b)` gets its exact rewrite, `["packages/*", "!packages/a", "!packages/b"]`. |

Workspace-config errors:

| Symptom                                                                                                                                                      | Cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `concurrency must be a positive integer`                                                                                                                     | `concurrency` is negative, zero, NaN, ...                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `timeout must be a positive integer (milliseconds)`                                                                                                          | Workspace `timeout` is ≤ 0, NaN, or not an int.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `cacheDir must be a string`                                                                                                                                  | Wrong shape.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `cacheDir is only whitespace — name a directory`                                                                                                             | A `cacheDir` of spaces: it made a directory named so at the root, hidden by the cache's own `.gitignore`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `cacheRetention must be { olderThan?: '30d', maxSize?: '10G' }`                                                                                              | Not an object.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `cacheRetention names neither olderThan nor maxSize`                                                                                                         | An empty policy would evict nothing and read as one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `cacheRetention.olderThan must be a duration like '30d', '12h', '90m' or '45s'`                                                                              | The `vx cache prune --older-than` spelling, or not a string.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `cacheRetention.maxSize must be a size like '10G', '500MB' or '64KB'`                                                                                        | The `vx cache prune --max-size` spelling (no fractions), or not a string.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `cacheRetention.olderThan of 0 evicts every entry after every run`                                                                                           | Every run would evict what it just saved; `vx cache prune --older-than 0` is refused too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `cacheRetention.maxSize of 0 evicts every entry after every run`                                                                                             | The same, for the size bound.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `cacheRetention.maxSize '<n>' reads as <n> bytes — give a unit (e.g. '<n>M', '<n>G')`                                                                        | A bare number is bytes; a cache capped at `10` bytes is a typo for `10G`. `10B` still loads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `affectedBase must be a git ref like 'origin/main'`                                                                                                          | Not a string, empty, or opens with `-` (git would read an option).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `plugins must be an array of plugin objects`                                                                                                                 | Wrong shape.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `plugins[<i>] must be an object`                                                                                                                             | A non-object entry in `plugins`; a string (Nx's `'@nx/vite/plugin'`) adds that a plugin is what its package's function returns, not a module name (D-49).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `plugins[<i>] must come from definePlugin(import.meta, { … })`                                                                                               | A plain object where a plugin was expected: a plugin's name is its package name, and only `definePlugin` sets it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `plugins[<i>].name overrides the package name`                                                                                                               | A `name` set over `definePlugin`'s result; drop the field.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `plugins[<i>].<capability> must be a function`                                                                                                               | A capability key holding something that is not callable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `plugins[<i>] must contribute at least one of config/discover/project/graph/key/fingerprint/schedule/admit/executor/cache/telemetry/setup/commands/teardown` | A plugin object with no capability.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `plugin '<name>' declares '<key>', which is no plugin hook`                                                                                                  | A key on a plugin that names no hook (`excutor`, `setUp`): it was never called. The nearest hook is hinted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `<file> has unknown field "<key>"`                                                                                                                           | Typo'd / unsupported top-level key (`plugin`); the hint names the nearest spelling, or where vx keeps a Turbo or Nx key (`pipeline`, `remoteCache`, `parallel`, `cacheDirectory`, `defaultBase`, `tasksRunnerOptions`, `globalPassThroughEnv`; D-38, D-49; pnpm-workspace.yaml's, Lerna's and package.json's `packages`, `workspaces`, `catalog`, `npmClient`, and `ignore`, `cache`, `remote`, `env`, D-98; in a project's vx.config, `targets`, `extends`, `implicitDependencies` and `name`, D-56; `scripts`, `pipeline`, `namedInputs`, `root`, `sourceRoot`, `projectType`, and a task's `dependsOn`, `cache`, `exec`, `inputs`, `outputs`, `env` one level too high, D-99). |
| `plugin '<name>' declares command '<verb>', a core verb — core verbs cannot be shadowed`                                                                     | A plugin verb the dispatcher matches first; it could never run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `plugin '<name>' declares command '<verb>', which no command line reaches — a verb is a word, not a flag or empty`                                           | A verb like `--version` or `''`: core reads a flag first, and an empty word is no verb.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `plugins '<a>' and '<b>' both declare command '<verb>' — a verb has one owner`                                                                               | Two packages on one verb; the first would win and hide the second. Plugins of one package are one owner, and the first declared runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `plugins[<i>].fingerprint must be { files: [name, …], affected: function }`                                                                                  | A fingerprint claim without its file list or its `affected` answer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `plugin '<name>' claims fingerprint file "<file>", which is not a file name at the workspace root`                                                           | A claim names a path, or no name: a claim is a bare file at the root (`vx watch`'s root arm is not recursive).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `plugins '<a>' and '<b>' both claim fingerprint file '<file>' — a file has one claimant`                                                                     | Two plugins keying the same lockfile; the key would fold both and `--affected` could ask only one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
