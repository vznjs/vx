# Config schema

Every field you can write in a project's `vx.config.ts` and in the
workspace's `.vx/workspace.ts`.

Both files may end in `.ts`, `.mts`, `.js`, `.mjs`, `.cts` or `.cjs`.
The workspace file is required: it marks the workspace root (cli.md § The
workspace root).

The TypeScript types live in `src/config.ts` and are re-exported from
`@vzn/vx`.

## File layout

```text
<workspaceRoot>/
├── vx.config.ts                 (optional: the root project, named `//`)
├── .vx/
│   ├── workspace.ts             (required: marks the root; workspace-wide settings)
│   ├── projects.lock      (`vx lock`: configs, each task once; committed)
│   ├── dependencies.lock        (`vx lock`: edges and digests per project; committed)
│   ├── .gitattributes           (both locks `linguist-generated eol=lf`; written when missing)
│   ├── .gitignore               (`/cache`; written by `vx init` and the cache when missing)
│   └── cache/                   (machine-local state; the only part git ignores)
└── <any>/<dir>/
    ├── vx.config.ts             (this directory is a project; its tasks)
    └── vx.lock.json             (`vx lock`: its resolved config, pretty, for review)
```

**A project is a directory holding a `vx.config.*`**, in any language.
`vx lock` finds them and records each one in the lock.

A run takes its projects from the lock. After you add a config, run
`vx lock` so the next run sees it.

A project's name is its config's `name`, else the name a `discover` plugin
gives, else its path from the root (`apps/web`). The root is `//`.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `package.json`: core reads none, and no package-manager member list. A
  `vx.config.*` is what makes a project.
- `vx lock` looks at git's tracked and unignored files, and records each
  project by directory.
- `packages/x/.vx/workspace.ts`: a config at or under a nested
  workspace, ignored or not, belongs to that workspace.
- `vx lock` records each nested workspace root too. An outer project's
  outputs stop there, as at a nested project; its inputs do not.
- `discover` plugin: it may add directories with no config.
  `@vzn/vx-lockfile` adds the package manager's members.
- A plugin-added directory whose config git ignores is refused, naming the
  plugin and the file.
- `discover` runs under `vx lock` only. The lock records the projects,
  names and edges it returned, and a run uses that record.
- `package.json#name`: the name `@vzn/vx-lockfile` gives a project.
- Two projects with one name are refused, naming both directories.

</div>
</details>

## Project config

A project's `vx.config.ts` names the project, labels it, and declares its
tasks.

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
  tags?: readonly string[] // labels for `--filter tag:<name>`, each once
  tasks?: Record<string, TaskConfig> // keyed by task name
}
```

`tasks` maps each task name to its `TaskConfig`. You run one with
`vx run build` or `vx run web#build`.

`defineProject` only helps TypeScript: autocomplete, and checks against
the schema. It does nothing at run time.

The same checks without a runtime import, the form `vx init` and
`@vzn/vx-migrate` write:

```ts
import type { ProjectConfig } from '@vzn/vx/config'

export default { name: 'web' } satisfies ProjectConfig
```

The config is JSON data: a function, a `Date` or a `Map` in it is
refused. `vx lock` evaluates it once, from the workspace root.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `satisfies ProjectConfig` does not check `dependsOn` names against the
  task keys. `defineProject` does.
- Only `vx lock` and `vx lock --check` evaluate a config. A file it
  writes is written then; a run or `vx show` reads the lock.
- A default export that is a Promise is awaited, as top-level await is.
  A function is refused: export what it returns.
- `import type`: Bun erases it, so the file loads in a workspace that runs
  the `vx` binary without the package installed.
- Either form is fine: vx reads the object.
- `@vzn/vx/config` is the schema alone (`src/config.ts`, which imports
  nothing). Your type checker checks that one file.
- `@vzn/vx` instead would walk core's Bun-only sources and fail without
  `@types/bun`.
- `moduleResolution: "node"` (node10): `@vzn/vx/config` resolves under
  it, as under every other mode.
- `tsconfig.json` with no `include` takes every `.ts` beside it,
  `vx.config.ts` too. An emitting build's output then moves: `dist/main.js`
  becomes `dist/src/main.js`.
- `"include": ["."]` reaches the config and compiles it into the output
  too.
- Fix for both: add the config's file name to that tsconfig's `exclude`.
  `vx init` and `@vzn/vx-migrate` say so where they write one.
- Why JSON: the cache key folds `JSON.stringify` of each task's config,
  `vx lock` stores the same JSON, and `vx watch` re-reads a config as
  JSON.
- A value JSON cannot carry is refused on every path, before the schema.
  Otherwise it would be dropped, rewritten or refused depending on the
  path.
- `() => {}`, a symbol, a bigint, `NaN`, `±Infinity`: refused.
- `[undefined]`: refused, JSON writes `null`.
- A cycle: refused.
- `get x() {}` or a setter: refused. Each read may answer differently;
  vx never calls it.
- A symbol key or a non-enumerable property: refused, JSON drops each.
- `new Date()`, a `Map`, `Set`, `RegExp` or class instance: refused. Only
  a plain object or an array is data.
- Nesting deeper than 256 levels: refused.
- `{ description: undefined }` is fine: JSON drops it and the schema reads
  it as absent. A preset's optional field (`description: opts.description`)
  relies on this.
- `.vx/workspace.ts` is not held to the JSON rule: its plugins are objects
  of functions.
- `process.env.CI` in a config is fixed by whoever ran `vx lock`.
  `vx lock --check` under the other value fails.
- `process.cwd()` and `PWD` are the workspace root while `vx lock`
  evaluates a config, from any directory. The lock does not depend on
  where you ran it.
- `import.meta.dir` is the config's own directory, an absolute path.
- `import.meta.dir` in a command locks this checkout's path: another
  checkout fails `vx lock --check` and keys apart. `vx lock` warns.
- `scripts/gen.ts`: a command runs in its project's directory, so name a
  script relative to it.
- `$VX_RUN_WORKSPACE/scripts/gen.ts` names a script from the workspace
  root.
- `console.log` in a config goes to stderr, a child it spawns included: a
  verb's stdout is its output.
- A task name is what `dependsOn`, `inputs.tasks` and the CLI spell. One
  they could not spell is refused at load:
- `''`: an empty name.
- `' build'`: surrounding whitespace.
- `a#b`: `#` separates project and task.
- `b*`: `*` is a pattern.
- `^build`: a leading `^` means dependencies' tasks.
- `!build`: a leading `!` is a negation.
- `-build`: a leading `-` is a CLI flag.
- `ESC` or `\r` in a task or project name: refused. vx prints names raw,
  and one could retitle the terminal.

</div>
</details>

### `name` (optional)

The project's name: what `web#build`, `--filter web` and `dependsOn` use
to reach it.

```ts
import { defineProject } from '@vzn/vx/config'

export default defineProject({ name: 'web' })
```

Default: the name a `discover` plugin gives, else the project's path
(`apps/web`).

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

A name `dependsOn`, `--filter` or the command line could not spell is
refused by `vx lock`:

- `' web'`: surrounding whitespace.
- `a#b`: `#` separates project and task.
- `web*`: `*` is a pattern.
- `^web`: a leading `^` means dependencies' tasks.
- `!web`: a leading `!` is an exclusion.
- `-web`: a leading `-` is a flag, so `vx run -web#build` could not name it.
- `tag:web`: a leading `tag:` is a tag filter.
- `web...` or `...web`: a dependency walk.
- `web[main]`: a trailing `[<ref>]` is a git range.
- `./web`, `{web}`, `web{dir}`: a directory form.
- A name a plugin gives, and a project's path name, follow the same rule.
- A plugin's name (a `package.json` `name`) is refused with its folder:
  rename it there.

</div>
</details>

### `tags` (optional)

Labels for picking projects: `vx run test --filter tag:app` runs `test`
in every project tagged `app`.

```ts
import { defineProject } from '@vzn/vx/config'

export default defineProject({ tags: ['type:app', 'scope:web'] })
```

| Write                      | Means                              |
| -------------------------- | ---------------------------------- |
| `--filter tag:type:app`    | the projects tagged `type:app`     |
| `--filter 'tag:scope:*'`   | the projects with any `scope:` tag |
| `--filter '!tag:type:app'` | every project but those            |

Default: no tags. The filter syntax is in `cli.md` § Filter DSL.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

Each tag is a non-empty string a tag filter can name, or it is refused at
load:

- `' app'`: surrounding whitespace.
- `app*`: `*` is a pattern.
- `ESC` or another control character: `vx show` prints tags raw.
- `app...`: ending in a dependency walk.
- `app[main]`: ending in a git range.
- A `project` plugin may set or edit tags. The adoption plugin `nx()`
  gives each project its existing tags unless the vx.config has its own.
- No cache key holds a tag: it changes no task's behaviour, so editing
  one re-runs nothing.

</div>
</details>

## `TaskConfig`

A task is one entry under `tasks`: what it runs, what runs first, what it
reads and writes, and whether it caches.

```ts
interface TaskConfig {
  description?: string // one-line blurb for the picker / --dry view
  exec?: ExecConfig // omit to declare a group task
  dependsOn?: readonly string[] // tasks that run first
  inputs?: InputsConfig // what the task reads: its key, cached or not
  outputs?: TaskOutputs // what it writes, cached or not
  cache?: boolean // caching is opt-in; needs `exec`, `inputs` and `outputs`
}
```

A task with `exec` does work. A task without `exec` is a **group task**:
it declares `dependsOn` or `inputs`, to gather tasks or to be a key.

```ts
check: {
  dependsOn: ['lint', 'test']
}
```

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `{}`: a task with none of `exec`, `dependsOn` and `inputs` is refused
  at load. A no-op task is almost always a config mistake.
- `dependsOn: []` is the deliberate empty group: a task by that name
  exists and does nothing.
- No `build` declared by the config or its plugins: the project gets one.
  It is a group with `dependsOn: ['^build']` and `inputs.files: ['**']`,
  no outputs.
- That `build` runs nothing, but a dependant behind `^build` folds its
  key. A package used as source moves its dependants' keys and reaches
  them under `--affected`.
- A config can declare a keyed group too (Group tasks, below).
- `vx run build` alone does not select the given `build`. Where no
  selected project declares `build`, it is refused as any undeclared name
  is.
- `lib#build` names it, and a dependant's `^build` reaches it.
- `vx show` and `vx info` count it. `vx show build` and the `vx build`
  hint name declared tasks, so they do not.
- Its `^build` needs an edge source, as any `^` does: with no plugin
  returning `deps`, running it is refused.

</div>
</details>

### `description` (optional)

```ts
description?: string
```

A one-line note on what the task does, shown in the task picker and in
`vx run --dry`.

```ts
test: {
  description: 'bun test against the tests/ tree',
  exec: { command: 'bun test' },
  inputs: { files: ['src/**', 'tests/**'] },
  outputs: { files: [] },
  cache: true,
}
```

Default: none.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- No effect on scheduling or execution.
- Editing it costs one re-run: it is in the cache key. The key hashes the
  whole resolved task config (`caching.md`, step 5).
- Carving exceptions out of that object is what invites stale hits, so
  `description` gets none.
- `vx run` with no task, in a terminal: the picker prints it right of
  each `pkg#task` id.
- `vx run --dry`: printed on a second, indented line under the
  cache-status row.
- `vx run --dry --format json`: `description` is on each task entry.

</div>
</details>

### `exec` (optional — required for non-group tasks)

`exec` is the one command a task runs, and how: its environment, time
limit, retries and where it may run.

```ts
build: {
  exec: { command: 'vite build', timeout: '5m', env: { define: { NODE_ENV: 'production' } } },
}
```

```ts
interface ExecConfig {
  command: string // shell command, run from the project's dir
  remote?: boolean | 'only' // placement: pin here, or remote-only (see below)
  platforms?: readonly Platform[] // the machines it can run on, any of them (see below)
  worker?: string // the worker type a distributed run runs it on (see below)
  env?: ExecEnv // optional per-task env layering
  timeout?: Duration // '30s', '2m': before vx SIGTERMs the child (see below)
  retries?: number // max additional attempts after a failure (see below)
  persistent?: PersistentConfig // long-running task (dev server, watcher)
  interactive?: boolean // reads the terminal: a prompt, a REPL (see below)
  sandbox?: SandboxConfig // opt-in OS sandbox for this command
}
```

Default: none. A task without `exec` is a group
([below](#group-tasks-no-exec)).

#### `command` (required)

The shell command the task runs, from the project's directory.

```ts
exec: {
  command: 'vite build'
}
```

| Write                            | Means                                  |
| -------------------------------- | -------------------------------------- |
| `vite build`                     | one command                            |
| `gen && vite build`              | `vite build` runs only if `gen` passes |
| `vite build > build.log 2>&1`    | redirects work                         |
| `vx run build -- --mode staging` | adds `--mode staging` to this run      |

Default: none, the field is required.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `sh -c` runs it (`dash` on macOS, as Linux's `sh` is), so POSIX shell
  works: pipes, redirects, `&&` chaining.
- `find src -name "*.snap" | xargs rm -f`: a pipe is fine.
- `gen && vite build && cp -r assets dist/`: chain as many steps as you
  need.
- `vx run test -- --bail 'a b'`: the child sees `bun test --bail 'a b'`.
  Args after `--` are appended to `command`.
- Each forwarded arg is POSIX single-quoted unless it holds only safe
  characters.
- Forwarded args are folded into the cache key: different args make
  distinct cache entries.
- No `commands: string[]`: caching is per task. To cache steps apart
  (`codegen`, then `build`), make two tasks linked by `dependsOn`.
- Otherwise `&&` in the shell is the right tool.
- `prebuild` and `postbuild` in package.json: vx runs `command` as
  written, so they run only when the command runs that script through npm.
- In that case the package.json is an input: list it in `inputs.files`,
  or an edited hook replays a stale hit.
- Better: put the steps in the command
  (`rimraf dist && vite build && node scripts/copy.js`), as
  `bunx @vzn/vx-migrate` does when it maps scripts.

</div>
</details>

#### `timeout` (optional)

How long one attempt may run before vx stops it with SIGTERM.

```ts
build: { exec: { command: 'vite build', timeout: '2m' } }
```

| Write     | Means         |
| --------- | ------------- |
| `'500ms'` | half a second |
| `'30s'`   | 30 seconds    |
| `'2m'`    | 2 minutes     |
| `'1h'`    | 1 hour        |
| `'1d'`    | 1 day         |

Default: no limit, unless the run sets one (`--timeout`, `run.timeout`).

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `timeout: 120`: refused by `vx lock`. Write a number and a unit: `ms`,
  `s`, `m`, `h` or `d`.
- Each attempt's time counts from its spawn. A
  [retry](#retries-optional) gets the whole limit again.
- A sandbox's setup, its wrap included, is vx's time, not the task's.
  Time stopped by Ctrl-Z is not run time either.
- A task that overruns is killed with its whole process group, so what it
  forked goes too. It is reported `failed` (timed out), never cached.
- Its `[vx] timed out after …` line names whose limit it was, the task's
  `exec.timeout` or the run's, and how to raise it.
- A timeout is a real failure. A Ctrl-C teardown is reported `aborted`
  instead.
- A persistent task: `timeout` bounds the readiness wait instead. If
  `readyWhen` has not matched in time, the child is SIGTERMed and the task
  fails (see `persistent` below).
- A persistent task with no `readyWhen` is ready on spawn, before the timer
  can fire, so its timeout does nothing.
- A plugin executor: the timeout aborts the request's `signal`. Core
  cannot kill a process the executor spawned.
- After that abort, any exit is reported timed out, a 0 from a child that
  trapped the stop included.
- An executor still running after the kill grace is abandoned.
- `'2147483647ms'` (about 24.8 days) is the most: the largest delay a
  timer can hold.
- A larger value does not mean no limit: the platform cuts it to 1 ms and
  the task would fail at spawn. vx refuses it at load.
- For no limit, omit `timeout`.
- The same bound holds for `--timeout`, the workspace's `run.timeout` and
  `VX_RUN_TIMEOUT`. Past it, each is refused under its own name.
- No `exec.timeout`: the run-level default applies, if one is set.
- Order, highest first: `exec.timeout`, `--timeout <duration>` /
  `RunOptions.timeout`, `VX_RUN_TIMEOUT`, the workspace's `run.timeout`
  (see workspace config below). Per-task always wins.
- The run-level defaults are run options, so, like `--retries`, they never
  touch a cache key: a `--timeout` run hits a plain run's entry.

</div>
</details>

#### `retries` (optional)

How many more times vx runs a task after a failed attempt.

```ts
test: { exec: { command: 'bun test', retries: 1 } }
```

| Write        | Means                                           |
| ------------ | ----------------------------------------------- |
| `retries: 0` | fail on the first non-zero exit, no flaky retry |
| `retries: 1` | up to 2 runs                                    |
| `retries: 2` | up to 3 runs                                    |

Default: `run.retries` if set, else none. A task the run history knows
as flaky still gets one more attempt.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- Any failure is retried, a `timeout` kill included.
- A Ctrl-C teardown (`aborted`) is never retried: the run is tearing
  down.
- `--fail-fast`: a task it kills when it stops the run is not retried. It
  ends `aborted`, even when its retry was already announced and
  preparing.
- Declared outputs are cleaned before each retry, as before the first
  attempt. A failed attempt's partial outputs cannot leak into the next.
- An [additive](caching.md#additive-outputs-two-tasks-one-tree-an-edge-between-them)
  task removes what the failed attempt added instead.
- An additive task whose failed attempt changed or removed a file it found
  saves nothing on its pass.
- No clean deletes a committed file. A pass after a failed attempt that
  changed, added or removed a committed output is not saved.
- A process a failed attempt left running may still write into the next
  attempt's outputs. That pass is not saved, with the same warning as a
  passing attempt's leftover.
- Every attempt streams its output live. Between attempts vx writes one
  stderr line into the task's stream, ending in the reason:
- `vx: retrying <id> (attempt <k>/<total>) after exit <code>`: the
  command failed.
- `… after a timeout`: `timeout` killed the attempt.
- `… after 1 sandbox violation`: the command exited 0 and a refused
  access failed it.
- That attempt's violation lines print above the retry line, under
  `SANDBOX VIOLATIONS (<n>)`, and stay in its log.
- The last attempt decides. The first pass wins and is what gets cached:
  its output only, not the failed attempts' output too.
- Every attempt fails: the task is `failed` with the last exit code, and
  nothing is cached.
- The reported duration sums every attempt. A saved entry keeps the
  producing attempt's time.
- `retries` is part of the resolved config, so declaring it makes a
  distinct cache key. Tasks without it keep their keys byte for byte.
- `retries` with `persistent` is a config error, like `cache` with
  `persistent`: a persistent task has no exit to retry.
- `run.retries` (`vx run --retries <n>`, `VX_RUN_RETRIES`) is the
  run-level default, for tasks that declare no `retries`.
- The run-level default never applies to a persistent task: a server that
  fails before it is ready fails at once.
- Config always wins, `retries: 0` included. The flag never affects cache
  keys.
- With neither set, a task the run history knows as **flaky** gets one
  more attempt when it fails.
- Flaky means: its key passed before, or one of its keys failed after it
  passed, or a pass took a retry.
- The run history keeps that until a bounded `vx cache clean` drops what
  is over 30 days old.
- Only a cached task has that record, and a timeout always fails.
- `@vzn/vx-dte` (distributed task execution): a retry runs on another
  worker than the attempt that failed.
- `@vzn/vx-history` with a history server shares the record across CI
  machines: a task it names flaky is retried the same way.
- The flaky retry is decided at run time, so it never touches the key.
  `retries: 0` turns it off.

</div>
</details>

#### `remote` (optional)

Whether a remote executor may run this task on another machine. `false`
keeps it on the machine that started the run.

```ts
exec: { command: 'docker build -t web .', remote: false }
```

| Write    | Means                                                                    |
| -------- | ------------------------------------------------------------------------ |
| `true`   | any executor may take it                                                 |
| `false`  | only this machine: a local daemon, a Docker socket, a device, a VPN host |
| `'only'` | only a remote worker; here it is a no-op                                 |

Default: `true`.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `remote: false` is never offered to an executor that declared itself
  `remote`.
- `remote: false` with no executor plugin changes nothing: the workspace
  already runs every task here.
- `exclusive` executors (`@vzn/vx-dte`) run every task elsewhere: they
  take a `remote: false` task too, and every pin below.
- `persistent: {}` pins a task here, and everything that depends on it,
  transitively, whatever they declare: a worker cannot reach a port served
  on this machine.
- `@vzn/vx-dte` lifts that pin: each worker starts the server once, beside
  its dependants, and this machine never does.
- A server with a `sandbox` or `exec.remote: false` still stays here.
- `sandbox: { … }` pins a task here, and its dependants: the sandbox runs
  on this machine, and a boundary a worker does not enforce would pass
  without checking anything.
- An executor that enforces the sandbox where it runs (`@vzn/vx-dte`) is
  offered sandboxed tasks.
- `inputs: { runtime: [ … ] }` or `workspaceRuntime` pins a task here: its
  key holds this machine's answer, which a worker cannot prove it shares.
  Its dependants are not pinned.
- Placement is decided once per task, before scheduling, so the scheduler
  knows which pool the task takes (see
  [execution.md](execution.md#executor-pools)).
- `remote: 'only'` is for a task that builds a remote input tree, like an
  install feeding remote workers. On this machine it never runs, and its
  outputs are never cleaned or restored here.
- With a remote executor, an `'only'` task runs on a worker. Its outputs
  stay in the remote store, and dependants' input trees point at them
  there: worker to store to worker, never via this machine.
- With no remote executor, an `'only'` task succeeds without running.
  Dependants use this machine's own state (your own `node_modules`).
- An `'only'` task keys as a real run of it does. A task that depends on
  it, directly or not, still reads the cache but saves nothing.
- Why: an entry built from your local state would sit where a run over
  the task's real outputs looks.
- `remote: 'only'` with no `cache` is refused at load: its inputs are what
  a worker reproduces, and its key addresses its remote record.

  ```ts
  install: {
    exec: { command: 'bun install --frozen-lockfile', remote: 'only' },
    inputs: { files: ['package.json', 'bun.lock'] },
    outputs: { files: ['node_modules/**'] },
    cache: true,
  },
  build: { dependsOn: ['install'], /* … */ },
  ```

- Not in the cache key: `remote` is stripped, `'only'` included, and so is
  [`worker`](#worker-optional), the other placement field.
- Why: a remote executor promises the same command over the same inputs
  gives the same outputs. A key that moved with placement would split a
  laptop from a worker pool over nothing.

</div>
</details>

#### `platforms` (optional)

The machines this task can run on, any of them.

```ts
exec: { command: 'xcodebuild -scheme App', platforms: ['darwin-arm64', 'darwin-x64'] }
```

| Write          | Means                  |
| -------------- | ---------------------- |
| `linux-x64`    | Linux on Intel or AMD  |
| `linux-arm64`  | Linux on ARM           |
| `darwin-x64`   | macOS on Intel         |
| `darwin-arm64` | macOS on Apple silicon |

Default: none, the task runs on any machine.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `platforms: ['linux']` is refused at lock: the names are fixed,
  `os-arch`, as Bun's compile targets.
- Locally, a task whose platforms leave this machine out is skipped, never
  failed, and so is everything that depends on it. The run stays green and
  says why, once, and on the task's row:

  ```ansi
  [4m[58;2;110;118;129m  [1m[38;2;167;139;250mWarnings[0m[4m[58;2;110;118;129m                                                                                                              [0m
  [1m[38;2;234;179;8m[vx][0m[2m skipped on linux-x64, with what depends on them: app#ios:build needs darwin-arm64 or darwin-x64[0m

  [4m[58;2;110;118;129m  [1m[38;2;167;139;250mTasks[0m[4m[58;2;110;118;129m     [2mstatus  cache     ±usual    time   cpu    mem outputs  blocks worker         task[0m[4m[58;2;110;118;129m                           [0m
              [38;2;234;179;8mskipped[0m [2m—[0m              [2m—[0m       [2m—[0m     [2m—[0m      [2m—[0m       [2m—[0m       [2m0[0m [2m—[0m              [38;2;147;197;253mapp[0m[2m#[0m[38;2;129;140;248mios:build[0m [2m• needs darwin-arm64 or darwin-x64, this is linux-x64[0m
  ```

- `otherPlatform: { needs, host }` is how a `run()` outcome and telemetry
  carry the skip. A dependant's `blockedBy` names the task (in
  `vx last --format json` too).
- On CI (`CI` or a provider's variable set), every task runs or the run
  fails: a task whose platforms leave the machine out refuses the run
  before any task starts.
- On CI, run a target that holds only this platform's tasks, or one DTE
  run with a worker of each platform.
- With an executor that routes by platform (`@vzn/vx-dte`, whose machines
  each name a `platform`), the task runs on a worker of one of its
  platforms.
- That worker is on this machine's platform if the executor has one, else
  on the first listed platform the executor has.
- A task none of whose platforms the executor runs refuses the run before
  anything starts. Other remote executors are never offered it.
- A task naming no platforms: `@vzn/vx-dte` runs it on this machine's
  platform when its worker type has machines of it.
- So a worker of another platform runs only the tasks that name it, and
  leaves once they are done.
- In the cache key: the list is config, and the platform the task runs on
  is folded too, so each platform keeps its own entry.
- A task naming no platforms folds no platform.

</div>
</details>

#### `worker` (optional)

Which worker type of a distributed run takes this task. `platforms` says
where it _can_ run; `worker` says where it _should_.

```ts
exec: { command: 'playwright test', worker: 'ubuntu' }
```

Default: none, the first worker type that can run it.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `worker: 'ubuntu'` names a worker type, as `@vzn/vx-dte`'s `workers`
  names it. Only machines of that type take the task.
- The run is refused before anything starts when no worker type has that
  name, or none of its machines runs one of the task's `platforms`.
- Omitted, the task goes to the first worker type, in declared order, with
  a machine on one of its platforms.
- So list a slow or costly worker type last: it gets only the tasks no
  other type can take.
- Locally, and with an executor that names no worker types, `worker` is
  ignored.
- Not in the cache key: it is placement, like `remote`.

</div>
</details>

#### `persistent` (optional)

Marks a long-running task: a dev server, a file watcher, a daemon. vx
does not wait for it to exit; tasks that depend on it start once it is
ready.

```ts
exec: { command: 'vite', persistent: { readyWhen: 'Local:' } }
```

| Field       | Type     | Default                    | What it does                                                                                |
| ----------- | -------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| `readyWhen` | `string` | none: ready once it starts | A regex, as a string. The first output line it matches marks the server ready (`'Local:'`). |

Default: none, the task runs until it exits.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

```ts
interface PersistentConfig {
  readyWhen?: string // regex (as string); first matching line marks ready
}
```

- `persistent: {}` is ready as soon as the spawn succeeds: for a daemon
  with no ready signal that its dependants need not wait on.
- `readyWhen` tests each stdout and stderr line on its own, without its
  line break (`\n`, `\r\n` or a bare `\r`).
- Terminal escapes (colour, OSC titles) are removed first, so `^` and `$`
  anchor to a line as you read it, and `Local:` matches Vite's bold
  `Local` under `FORCE_COLOR`.
- The trailing partial line is tested too, so a banner with no newline
  (`printf 'Listening on :3000'`) counts.
- A server not ready after 10 s is said once, naming the pattern it waits
  for, and whether `exec.timeout` bounds the wait.
- `timeout: '30s'` on a persistent task bounds its readiness wait.

```ts
dev: {
  exec: {
    command: 'vite',
    timeout: '30s', // bound the readiness wait
    persistent: { readyWhen: 'Local:' },
  },
},
watch: {
  exec: {
    command: 'vite build --watch',
    persistent: { readyWhen: 'built in' },
  },
},
// No readyWhen: ready as soon as the spawn succeeds.
agent: {
  exec: {
    command: 'my-agent --daemon',
    persistent: {},
  },
},
```

- Dependants start on ready, not on exit: an e2e suite that needs a dev
  server up first.
  ```ts
  'dev:run': {
    exec: {
      command: 'vite --port 5173 --strictPort',
      persistent: { readyWhen: 'Local:' },
      // Bounds the server's writes, so `e2e` is probed before it boots;
      // the port list lets `e2e` reach it from outside the sandbox.
      sandbox: { allow: { read: ['.'], write: ['node_modules/.vite/'], localBinding: [5173] } },
    },
    // `e2e`'s key folds this one: with no `inputs` it is new each run,
    // and `e2e` is never saved.
    inputs: { files: ['src/**', 'index.html', 'vite.config.ts'] },
  },
  e2e: {
    dependsOn: ['dev:run'],
    exec: {
      // Playwright removes its output directory first, and a write
      // grant cannot be removed on Linux: it writes one inside it.
      command: 'playwright test --output test-results/run',
      // The server's port, and no other host.
      sandbox: { allow: { read: ['.'], write: ['test-results/'], network: ['localhost:5173'] } },
    },
    inputs: { files: ['e2e/**'] },
    outputs: { files: ['test-results/**'] },
    cache: true,
  },
  ```
- Not started when nothing needs it: a persistent task you did not
  request, whose every dependant is a confirmed cache hit, local or
  remote, is never spawned.
- So a fully cached `vx run e2e` above does not boot `dev:run`, and the
  server is in no outcome or count.
- `env: { dependsOn: ['dev'] }`, a group nobody requested between them, is
  passed through for local hits.
- So is a server nobody requested: `api` that only an idle `web` needs is
  not started either.
- Behind a remote cache, through the same groups and servers, the server
  waits for the remote's answer on the dependants the local store missed,
  and starts at the first miss.
- It also starts if one of those hits turns out to need running (its
  artifact went), and that task runs once it is ready.
- A dependant whose key the server's writes could change is not probed
  ahead of it, so there the server still starts.
- That is a dependant in the server's own project whose inputs the
  server's write grants reach, or any there when the server is not
  sandboxed.
- `vx run --dry` says so: such a server is `not started` (`not-started` in
  `--dry --format json`), not `would exec`.
- Exit 0 before `readyWhen` matches: the task is ready. A setup step
  (migrate, seed) did its work, and its dependants run.
- A crash or non-zero exit before ready is `failed`, even when a process
  it left running prints the marker after the exit.
- Crash after ready fails the run: a persistent task that exits non-zero,
  or is killed, on its own after it became ready.
- vx names it at once, while the graph still runs:
  `vx: <id> exited with code <n>` (`… while the run went on`). A signal
  death shows as its `128 + n` code.
- What it left running in its process group, and what left the group
  carrying its `VX_RUN_TREE`, is SIGKILLed at once: no orphan holds its
  port.
- So a dependant failing against it reads why, with the line a crash
  before ready gets (an exit 127's PATH verdict, a sandboxed server's
  note), said once.
- Its own outcome is `failed` with that exit code, and the footer counts
  it so.
- A task that reaches it through a group or another server (`e2e` on
  `web` on `api`) depends on it too.
- A cached dependant that was running when it died still passes, but is
  not saved, nor is what is built on it: its key is a healthy run's, its
  bytes are not.
- An exit 0 on its own is fine (a daemon that forks and returns). One kept
  only as a dependency does not end the foreground hold.
- Stopped once nothing needs it: a persistent task vx does not keep gets
  `SIGTERM` (`SIGKILL` past the kill grace) once every task that uses it,
  directly or through groups, has finished.
- That happens while the rest of the graph still runs, so it no longer
  holds the machine's cores. The stop is no crash.
- A server that uses another counts as finished once it is stopped. The
  one it uses gets its `SIGTERM` only then, here and at the end of the
  graph: its shutdown may still talk to it.
- `vx watch` holds its servers for the next cycle and keeps each one it
  starts again unchanged: a requested one while its config is, a
  dependency-only one while its key is (`cli.md` § watch).
- Under `vx watch`, a dependency-only server with no `inputs.files`
  restarts each cycle. A Ctrl-C stops them all.
- In the foreground vx keeps the persistent tasks you requested, those a
  requested group stands for, and the persistent tasks they depend on.
- vx then stays up after the summary, streaming what they write, until
  one of them exits or you press Ctrl-C.
- A failure elsewhere skips only its dependants: the rest stay up, and
  the run exits 1 when the session ends.
- `--fail-fast` stops them at the first failure (`cli.md` § Output,
  "Pinned persistent tasks").
- `persistent` with `cache` is refused at load: a persistent task does not
  end, so there is no exit code to cache and no moment to capture outputs.

</div>
</details>

#### `interactive` (optional)

`true` hands the task your terminal: a prompt (`drizzle-kit push`), a
REPL, a watch mode that reads keys.

```ts
exec: { command: 'drizzle-kit push', interactive: true }
```

Default: `false`.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- On a TTY (vx's stdin is one), the task gets vx's own stdin, stdout and
  stderr.
- Its output is not framed, masked, kept or replayed: it goes to the
  terminal as the task writes it.
- A frame line opens before it and closes after (`--output-logs full`, and
  the default views).
- The live status region goes for the rest of the run, as it would
  repaint over a prompt.
- It runs alone: it starts once nothing else runs, and nothing starts
  until it exits.
- `interactive: true` with `persistent: {}` holds the terminal from its
  spawn to the run's end. Other tasks may run once it is spawned; their
  output goes to the same terminal.
- A run may hold one persistent interactive task, and every other
  interactive task must be its dependency.
- A run that breaks either rule is refused before any task runs, and so
  is its `--dry`.
- Off a TTY (CI, a pipe), it runs as any task, beside others. Its stdin is
  empty, or a pipe vx holds for a persistent one.
- A prompt off a TTY reads end of input; it never hangs.
- Always here, never cached: no executor plugin is offered it, and `cache`
  is refused.
- `sandbox` is refused: a sandboxed task's output passes through vx.
- `persistent.readyWhen` is refused: vx reads none of its output, so it is
  ready once spawned.
- It runs in its own session, as every task does. So a tool that opens
  `/dev/tty` itself, not its stdin, still cannot, and the terminal's resize
  signal does not reach it.
- Ctrl-C reaches vx, which stops the run. A task that puts the terminal in
  raw mode reads the key itself.
- Its terminal modes end with it: vx reads them (`stty -g`) before the
  task starts and puts them back when it exits.
- So a task killed in raw mode, or one that never undid its
  `stty raw -echo`, leaves no terminal without echo or Ctrl-C behind it.
- Without `stty` on PATH, the modes stay the task's.

</div>
</details>

#### `env` (optional)

The variables the command sees. Nothing from your shell reaches it
unless you name it here.

```ts
exec: {
  command: 'vitest run',
  env: {
    passThrough: ['CI', 'GH_TOKEN'], // copied from your shell; not in the cache key
    define: { NODE_ENV: 'test' }, // a fixed value; in the cache key
  },
}
```

| Field         | Type                     | Default | What it does                                                                                                                    |
| ------------- | ------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `passThrough` | `string[]`               | `[]`    | Names copied from your shell, exact: `['API_URL']`. Not in the cache key; add them to `inputs.env` when they change the output. |
| `define`      | `Record<string, string>` | `{}`    | Fixed values set for the task: `{ NODE_ENV: 'production' }`. In the cache key.                                                  |
| `secret`      | `string[]`               | `[]`    | Names whose values vx prints as `***`, whatever the name: `['DEPLOY_TOKEN']`.                                                   |

Default: none, the task sees only the essential list below.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

```ts
interface ExecEnv {
  passThrough?: readonly string[] // names taken from host process.env; exact names, each once, a wildcard is refused
  define?: Record<string, string> // explicit name=value pairs
  secret?: readonly string[] // names whose values are masked (`***`) whatever the name, each once; see Masking
}
```

- Three layers, lowest priority first: the essential allowlist, then
  `passThrough`, then `define`.
- **Essential allowlist**, the whole list of what reaches a task from
  your environment unasked (`src/exec/env.ts`, pinned to this list by a
  test). Without these, typical CLI tools break:
  - shell and user: `PATH`, `HOME`, `SHELL`, `USER`, `LOGNAME`
  - temp: `TMPDIR`, `TEMP`, `TMP`
  - locale: `LANG`, `LC_ALL`, `LC_CTYPE`
  - terminal: `TERM`, `COLORTERM`, `FORCE_COLOR`, `NO_COLOR`, `CI`
  - tools: `NODE_OPTIONS`, `COREPACK_HOME`, `PNPM_HOME`, `RUSTUP_HOME`,
    `CARGO_HOME`, `GOPATH`, `GOMODCACHE`, `GOCACHE`
  - XDG: `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`,
    `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`
- `FORCE_COLOR=1` is set by vx when neither `FORCE_COLOR` nor a non-empty
  `NO_COLOR` reaches the task by any layer. vx strips the colour where it
  prints plain (`docs/cli.md` § Colors).
- `VX_RUN_TREE` is a token per spawn that vx adds, by which a stop finds a
  daemon that left the task's process group (`docs/execution.md`).
- `VX_RUN_WORKSPACE` (the root of the workspace running the task) and
  `VX_RUN_TASK` (`project#task`) are added too.
- `vx run` in a task's command, in that same workspace, is refused: a
  loop back to itself forks a run per run without bound. Declare it with
  `dependsOn`.
- Why: even a nested run that ends is invisible to the outer graph. Its
  tasks escape the schedule, the concurrency budget and the cache key.
- Driving a _different_ workspace from a task (a fixture suite, a
  benchmark) is fine.
- The allowlist is _not_ in the cache key, for the same reason as
  `passThrough`. Three of its names can change what a task produces:
- `NODE_OPTIONS`: `--require`, `--import`, `--loader` and `--conditions`
  inject code or switch package-export resolution.
- `LC_ALL` and `LANG`: collation, so anything calling `sort` orders
  differently.
- `CI`, `FORCE_COLOR`, `NO_COLOR`, `COLORTERM` and `TERM`: output bytes,
  which vx caches and replays. A host `NO_COLOR` also stops vx setting
  `FORCE_COLOR=1`.
- Why not hashed: a laptop and a CI runner could never share a remote
  cache entry. `PATH`, `HOME` and `TERM` differ on every machine.
- `inputs: { env: ['NODE_OPTIONS'] }` folds its value into the key when it
  matters to your build. vx does not guess which ones do:

  ```ts
  inputs: { files: ['src/**'], env: ['NODE_OPTIONS'] }, outputs: { files: [] }, cache: true
  ```

- `inputs.env` decides what the key _sees_; `exec.env.passThrough` decides
  what the command _gets_. The two are separate on purpose.
- `passThrough: ['API_URL']` takes the value from your shell at spawn
  time. Not in the cache key: for secrets, regional values and CI flags
  that vary between machines.
- A project config cannot set a `passThrough` value itself: a first load
  that writes `process.env` is refused.
- `passThrough: ['VITE_API_URL']` on a cached task gets a `vx lock` note
  unless `inputs.env` names it: a bundler writes the value into its
  output, so another value replays the old bundle.
- That note covers `NODE_ENV` and the public bundler prefixes, once per
  task, never for a secret (by name or `secret`):
  - `VITE_`, `NEXT_PUBLIC_`, `REACT_APP_`, `PUBLIC_`, `EXPO_PUBLIC_`,
    `GATSBY_`, `STORYBOOK_`
  - `VUE_APP_`, `BUN_PUBLIC_`, `NX_PUBLIC_`, `NUXT_ENV_`, `NUXT_PUBLIC_`,
    `REDWOOD_ENV_`, `SANITY_STUDIO_`
- `inputs: { env: ['VITE_API_URL'] }` with neither `passThrough` nor
  `define` giving it gets a note too: the key moves with the value, but
  the bundle is built without it.
- Each is a note; the lock is still written.
- `define: { NODE_ENV: 'production' }` sets a fixed value. It is in the
  cache key, through the task config's hash: the value is in your config.
- `passThrough: ['A=B']` is refused at load. Every name here and in
  `inputs.env` must be one an environment can hold: non-empty, with no `=`
  and no NUL.
- A `define` value holding a NUL is refused at load.
- `'\ud800'`, a lone surrogate, is refused in a `define` value,
  `exec.command`, and an `inputs.runtime` or `workspaceRuntime` command.
- Why: UTF-8 has no form for one, so the task would run U+FFFD in its
  place, other bytes than its config and key say.
- `passThrough: ['my.var']` is refused: a `passThrough` or `define` name
  is a shell variable name, `[A-Za-z_][A-Za-z0-9_]*`.
- Why: the task runs under `sh -c`, and dash (Linux's `sh`) drops any
  other name, so `my.var` would reach a task on macOS and never on Linux.
- `inputs.env` takes any name an environment can hold: the key reads it
  from vx's own environment.
- `npm_execpath` is set to the workspace's package manager unless a layer
  gives one, so a tool that calls the manager back finds it.
- That manager is the root `package.json`'s `packageManager`, else the
  lockfile's, found on the root's `node_modules/.bin` or `PATH` for each
  task.
- So one an earlier task installed is the one a later task gets.
- It names a binary on this machine, so it is not in the key.
- Nothing else reaches the task. A host credential (`SSH_AUTH_SOCK`,
  `GITHUB_TOKEN`) arrives only when `passThrough` names it.
- A sandboxed task with a restricted network also gets the sandbox's own
  proxy, CA and temp-directory values over these names (`TMPDIR`, `TMP`,
  `TEMP`).
- See `modules/sandbox.md` § The environment SRT sets.
- Why, cache stability: if every host variable entered the key, every
  shell with a different `PS1` would miss.
- Why, determinism: if host variables leaked in, two machines with
  different `FOO=bar` would produce different outputs, and you would
  never know why.
- A failed task whose last output names, or whose command expands
  (`$API_TOKEN`), a variable your shell holds and the task was not given
  gets one line naming it and `passThrough`.
- That line names only upper-case names of four characters or more, and
  never a value.
- This is hygiene, not a boundary: an unsandboxed task runs as you, so it
  can read your files. vx hides its own environment from a task
  (`modules/util.md`), not your files.
- Only `exec.sandbox` keeps your files out (`security.md` § What the
  sandbox stops).
- **Masking.** vx prints a value as `***` when its variable's name holds
  `TOKEN`, `SECRET`, `KEY`, `PASSWORD`, `PASSWD`, `PASSPHRASE` or
  `CREDENTIAL`, or ends `_PASS`.
- Masking reads vx's own environment and a task's `define`, for values
  of six characters or more.
- `NPM_TOKEN_FILE` is not masked: a name ending `_FILE`, `_PATH` or
  `_DIR` is not, nor git's `GIT_CONFIG_KEY_<n>`.
- `secret: ['GH_PAT']` masks a name that holds none of those words
  (`GH_PAT`, `NPM_AUTH`), in all the same places.
- Masked in output: the task's output, the line vx adds under a shell's
  127 or 126 (the command's first word), and the stdout the cache keeps
  and a hit replays.
- Masked in commands: the command a cache entry stores (what `vx why`
  prints and a remote cache receives) and the `$ command` line.
- Masked in commands too: the run's own invocation line that `vx last`
  prints (a secret passed after `--`).
- Masked in reports: telemetry records, `vx show`, and the hashes
  `vx why` gives for such a variable in `inputs.env`.
- Those hashes are of the value, unsalted: the row names the variable and
  its change.
- Masked in errors: an executor's error, a plugin's warning or failure (a
  remote's reply, also as the run's history row keeps it for `vx last`;
  the failure in the error `run()` rejects with).
- Masked in errors too: a failed `inputs` runtime probe's error (its
  command and output).
- Every string of a task `vx show` prints is masked (a runtime probe,
  `readyWhen`, the description), and the description `--dry` and the task
  picker print.
- A runtime probe's command is masked as run history stores it and
  `vx why` names its row. Two probes that mask alike are numbered:
  `echo *** (2)`.
- Masked too: the readiness notice's pattern, a sandbox violation line,
  the error a verb ends on (a plugin's failure, a config's own throw) and
  `vx watch`'s `cycle failed` line.
- A multi-line value (a PEM key) is also masked line by line, each line
  of six characters or more.
- A value holding a `'` is also masked as a shell-quoted line spells it
  (`'\''`).
- It is also masked URL-encoded (`ab%2Fcd` for `ab/cd`, a token in a
  query string) and as a JSON string spells it (`pa\"ss`, `\n`).
- `${A}xyz789`, where `B` is `A`'s tail plus `xyz789`, prints as one
  `***`: values that overlap or touch are masked as one.
- A value split across two output chunks is still caught: the output
  holds back that many characters until the next chunk.
- Streamed live, the hold lasts 25 ms, so a value written in two pieces
  with a longer pause between them shows.
- A buffered frame (the CI default) and every stored copy are masked
  again whole and never show it.
- The stored copies: the entry a hit replays and a remote cache
  receives, and the failure record `vx last` reads.
- A telemetry `task.log` record holds the piece until more output or the
  task's end, never on a timer, so a sink never gets a paused value in
  pieces.
- A plugin that reads a task's config directly sees it as written.
- A token a plugin's OS keychain answered (`ctx.secret`) is masked in
  vx's own lines too (a plugin's warning, an error).
- The project's `node_modules/.bin`, then the workspace root's, are
  prepended to `PATH`, so `oxlint` and `vite` run by name. One whose path
  holds `:` (the delimiter) is left out.
- The workspace root's holds a monorepo's shared tools. A sibling
  project's bins are never on `PATH` (project isolation).
- When a bin directory is left out for its `:`, a task's 127 says so.

</div>
</details>

### `dependsOn` (optional)

The tasks that must finish successfully before this task starts.

```ts
dependsOn: ['^build']
```

| Write                 | Means                                                      |
| --------------------- | ---------------------------------------------------------- |
| `'build'`             | this project's `build`                                     |
| `'^build'`            | `build` in the projects this one depends on                |
| `'packages/ui#build'` | `build` in one named project                               |
| `'lint.*'`            | every other task here whose name starts with `lint.`       |
| `'^build.*'`          | every `build.<x>` task in the projects this one depends on |

Default: none, the task waits for nothing.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

**A task of this project**

- `'build'` must be a task in this project's `tasks`. A missing one fails when the graph is built, naming the project's nearest task.
- `dependsOn: ['buidl']` is a type error when the config uses `defineProject`: a bare name is checked against the config's task keys. `'^name'` and `'pkg#name'` stay free strings.

**A task of a named project**

- `'packages/ui#build'`: the project and its task must exist. A miss is an error that offers the nearest declared one the list does not name yet, or else to remove the entry.
- `'ui#build'` offers `packages/ui#build`: a project is named by its path unless its config sets `name`.
- `'//#build'` names the workspace's root project, here and in `inputs.tasks`. With no root project it is refused.

**`'^build'`: the projects this one depends on**

- `'^build'` follows the `deps` a plugin's `discover` returns. The lockfile plugins `bun()`, `pnpm()`, `npm()` and `yarn()` return what the package manager installed.
- `package.json` alone gives no edge: vx reads none from it.
- `'^build'` with no plugin returning `deps` is refused (`VX_E_DEPENDS_ON`).
- The refusal reads: "`^build` needs project edges; add pnpm()/bun()/npm()/yarn() from @vzn/vx-lockfile to plugins in .vx/workspace.ts and install so its lockfile exists, or a plugin that returns `deps`".
- It would otherwise resolve to nothing and add no dependency to the key.
- A project with no dependencies is a leaf: its `'^build'` adds no edge.
- `web → ui`, where `ui` declares `build`: the walk stops at `ui#build`. The first dependency on each path that declares the task gets the edge.
- `ui`'s own `dependsOn: ['^build']` carries the chain deeper. Chain `'^build'` in every holder to keep the cascade going.
- `web → ui → tokens`, where only `tokens` declares `build`: `web` waits for `tokens#build`. A dependency without the task is passed through.
- Sparse tasks are normal: not every package has a `lint`.
- No holder at all is fine while some project in the workspace declares the task: a preset spreads `'^build'` over packages whose dependencies have none.
- `'^biuld'` that no project declares is an error, since it can only be a typo: "app#test: dependsOn ^biuld but no project in the workspace declares biuld. Did you mean ^build?"
- `vx run app#test`, `--filter` or a project folder loads only those projects and their dependencies.
- In such a scoped run, a `'^name'` with no holder makes vx load the other configs to decide. If one of them fails to load, the name is let through.
- `'packages/ui#build'` is not a project edge: it widens `--filter '...packages/ui'` and `--affected`, never a `'^name'` walk.

**Patterns**

- `'lint.*'`: `*` matches any run of characters in a task name. The rest is literal, so the dot needs no escape.
- `'lint.*'` never matches the task that declares it.
- `'lint.*'` matching nothing is fine: a preset-spread pattern need not match in every project.
- `'^build.*'` walks like `'^build'`: a holder is a dependency with at least one match. It gets edges to all its matches and ends the walk.
- `'^build.*'` matching nothing anywhere is fine too.
- `'packages/*#build'` is refused: a pattern does not work in the `pkg#task` form here. It does in `inputs.tasks`.

**Refused**

- `'*'`, `'^*'`, `'**'` or `'!build'`: wildcards and negation belong in `inputs.tasks`, which picks the keys that count, not the edges.
- `a#build → b#build → a#build`: a cycle fails once the graph is built, printing its path.

</div>
</details>

### `inputs` (optional)

The files, environment variables and command outputs a task reads. vx builds the task's cache key from them.

```ts
build: {
  exec: { command: 'vite build' },
  inputs: { files: ['src/**', 'vite.config.ts'], env: ['NODE_ENV'] },
}
```

```ts
inputs?: InputsConfig
```

| Field              | Adds to the key                               |
| ------------------ | --------------------------------------------- |
| `files`            | files of this project                         |
| `workspaceFiles`   | files anywhere in the workspace               |
| `env`              | values of environment variables               |
| `runtime`          | a command's output, run in the project folder |
| `workspaceRuntime` | a command's output, run once at the root      |
| `tasks`            | which dependencies' keys count                |
| `stability`        | what an input edited during the run does      |

Default: none. A task without `inputs` has no key, and `cache` needs one.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `cache: true` with no `inputs` is refused: the key is the task's inputs.
- A task with `inputs` has a key whether it caches or not. A task that depends on it includes that key.
- `codegen` (uncached) → `build` (cached): an edit to `codegen`'s inputs re-runs `build`.
- A command task with no `inputs` has no key. A key that includes it is this run's alone.
- So every task behind it misses and saves nothing, never a stale hit, even with a keyed task, a server included, between them.
- Declare `inputs` on an uncached task a cached one depends on.
- `inputs: { files: [] }` is a declaration: it keys the task on its config and its dependencies' keys, so a task behind it can hit.
- An absent `inputs` and an empty one differ.
- A group (no `exec`) with `inputs` is a keyed group: see Group tasks, below.
- A project without a `build` task gets `{ dependsOn: ['^build'], inputs: { files: ['**'] } }`.

</div>
</details>

#### `InputsConfig`

The shape of `inputs`. Each field has its own entry below.

```ts
interface InputsConfig {
  files: readonly string[] // required
  workspaceFiles?: readonly string[] // optional; workspace-root-relative
  env?: readonly string[] // optional; each name once
  runtime?: readonly string[] // optional; project-dir shell commands
  workspaceRuntime?: readonly string[] // optional; workspace-root shell commands
  tasks?: readonly string[] // optional; same micro-syntax as dependsOn
  stability?: InputStability // optional
}
```

##### `inputs.files` (required)

The files whose content decides whether the task runs again.

```ts
inputs: { files: ['src/**', 'vite.config.ts'] },
```

| Write         | Means                                     |
| ------------- | ----------------------------------------- |
| `src/**`      | everything in `src`                       |
| `src`         | the same: a folder name is its whole tree |
| `!src/gen/**` | except generated files                    |
| `*.config.ts` | config files at the project root          |
| `**`          | every file in the project                 |

Default: none, the field is required.

Paths start at the project folder. vx always leaves out what git ignores, its own files, the task's outputs and nested projects.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

**Spelling**

- `./src/**` is `src/**`, `!./gen` is `!gen`. A leading `./`, an inner `/./` and a doubled `//` are dropped.
- `src/` is `src`, the whole tree. `src/*/` is `src/*/**`, the trees under `src`.
- `src/.` reads as `src/`: a trailing `/.` is a trailing `/`.
- `.` or `./` alone is refused: write `**`.
- `!src` takes the whole `src` tree back out.
- `['src/**', '!src/gen/**', 'src/gen/keep.ts']` is refused: a `!` entry subtracts wherever it sits, so `keep.ts` would never be an input.
- `default`, a bare name, may be a folder: it is taken as one and only warns when it matches nothing.
- `files: []` is valid: the key still holds the command, env, dependencies' keys and any plugin's key material.
- With `files: []` and a lockfile plugin (`@vzn/vx-lockfile`), a lockfile change still misses.
- `/etc/**` and `../shared/**` are refused, in every input and output glob: use `inputs.workspaceFiles` for paths outside the project.
- `{../shared,src}/**` and `{/etc,src}/*` are refused too: a brace alternative counts.
- `src\**`, `src\*.ts`, `C:\src\**` and `C:/src/**` are refused, naming the forward-slash glob to write.
- `' src/**'` (spaces around it) and `'src/\n'` (a control character) are refused: either is read as part of a name and matches nothing.

**What may be missing**

- Unlike an output, an input need not exist. `nope.txt` that is not there is keyed as absent, and the task runs again once the file appears.
- `gen/**` matching nothing keys nothing, and the next file in `gen/` moves the key.
- A list where nothing matched at all is said on every miss: `inputs matched no files (lib/**)`. So is one whose every wildcard matched nothing beside a literal file that did.

**Wildcards**

- `*`, `**`, `?`, `[ab]`, `[a-z]`, `[!a]` and `{a,b}` are the wildcards.
- `{src/**,lib/**}` is `src/**` plus `lib/**`. `{src,lib}` is the two trees, as `['src', 'lib']` is.
- `{./src,lib}/**` is `src/**` plus `lib/**`: each alternative is cleaned up on its own, in inputs and outputs alike.
- `lib/{a[,]b,x}.ts` is `lib/a[,]b.ts` plus `lib/x.ts`: a `,`, `{` or `}` inside a class is a character, not a cut. So is an escaped `\,`.
- `{src,app/\[id\]}` is the two trees: an alternative may hold an escape.
- `app/\[id\]/**` is the route folder `[id]`. Bare `app/[id]/**` is a class: it matches `app/i` and `app/d`.
- `app/[id]/**` is refused by `vx lock` when `app/[id]` exists, naming the escaped form: an edit under the route replayed a stale hit.
- `g/[x\-]` matches `g/-` and `g/x`. A backslash escapes a bracket, a brace, a `!`, a backslash, anything inside a class, or a comma inside a brace.
- `src/\*x` is refused: write `src/[*]x` for the character.
- `g/a\*b` is refused, naming both readings: `g/a/*b` or `g/a[*]b`.
- `{b}.ts` is refused by `vx lock`: it matches `b.ts`, never a file named `{b}.ts`. Write `b.ts`, or `\{b\}.ts` for the braces.
- `@(a|b)`, `!(x)`, `+(…)`, `*(…)` and `?(…)` are refused: an extglob is read as text or a plain wildcard. Write `{a,b}`.
- `src/*.(js|ts)` is refused: parens holding a `|` are read as text. Write `src/*.{js,ts}`.
- `app/(marketing)/**` is fine: parens with no `|` are part of the name.
- `src/**.ts` and `a**` are refused: `**` glued to other text is read as `*`, one level. Write `src/**/*.ts` for any depth or `src/*.ts` for one.
- `src/{a,**}.ts` is refused the same way: it expands to `src/**.ts`.
- `{1..3}`, `{3..1}`, `{01..03}`, `{a..c}` and `{1..10..3}` are ranges, expanded like a comma list.
- `{A..c}` (mixed case) is refused, and so is a range of more than 1024 names, wherever it sits in the glob.
- `src/{1..100}{1..100}` is refused: a glob's braces may expand to at most 1024 globs. Ten `{a,b}` in a row is 1024 and loads.
- `[z-a]` is refused, naming `[a-z]`: a backwards range matches no character.
- `!(group)/**` takes a route group back: a leading `!` is the negation.
- `out/*/!a` and `{x,!a}` name a file `!a`: any other `!` is the character.
- `gen[!.]*` does not match `gen/notes.txt`: a negated class never matches a `/`.
- `*` matches `.eslintrc`, `src/*` matches `src/.env`, and `**` enters `src/.cache/`: wildcards match dotfiles.
- `'!**/.*'` takes the dotfiles back, `'!**/.*/**'` the files in dot folders.
- These rules hold for every task glob: `inputs.files`, `inputs.workspaceFiles`, `outputs.files` and `outputs.workspaceFiles`.
- They hold for `--affected`, `vx watch` and the overlapping-output check too.
- `packages/*` in `workspaces`, `pnpm-workspace.yaml` or a `--filter` path keeps the package manager's grammar.
- `packages/!(x)` there is refused by name: write the exclusion as its own `!packages/x` entry.

**Pasted tokens**

- `$TURBO_DEFAULT$` is refused in every glob list: write `**` for every file in the project.
- `$TURBO_ROOT$/tsconfig.json` and `{workspaceRoot}/tsconfig.json` are refused: write `tsconfig.json` in `workspaceFiles`.
- `{projectRoot}/src/**` is refused: write `src/**`, globs here start at the project already.
- `{projectName}` and `{options.…}` are refused: write the name or the path itself.
- `^production`, a glob starting with `^`, is refused: depend on other projects with `dependsOn: ['^build']` and list this project's files here.

**What git ignores**

- Every git rule counts: each `.gitignore` at any depth, `.git/info/exclude` and your `core.excludesFile`.
- `core.excludesFile` differs per machine, so a file it ignores on one is an input on another. Ignore shared paths in a committed `.gitignore`.
- `.env.local` named outright is an input even though git ignores it.
- `.env*` matching an ignored `.env.local`: `vx lock` and a miss name the file, since a glob's last segment matches it.
- `dist/**`, `dist/*.js` and `.cache/gen/**` are inputs when git ignores `dist` or `.cache`: a glob whose fixed start git ignores is walked on disk, under that start only.
- `gen/**` over a `gen/*` ignore with `!gen/.gitkeep`, or a force-added file, counts as ignored: it reads the untracked files beside the kept one.
- `src/**` over a `src` holding only ignored `*.log` files counts as ignored: git reports the folder itself as ignored.
- `{gen/a.txt,gen/b.txt}` names both files and `{gen,out}/**` both trees: each brace alternative counts on its own, as in `gen/{a,b}.txt`.
- An ignored input is hashed from disk and never stored or restored. A missing one is no input until it exists.
- An ignored input's bytes differ per machine, so machines with different files miss each other's shared entries.
- `**` or `src/**` (over a `src` holding a file git lists) still skips ignored files, so it never walks `node_modules`.
- An ignored file never selects a task under `--affected` on its own: only what git sees does. `vx watch` re-runs on an edit there.

**Always left out**

- `.git/**`, `.vx/cache/**`, `.vx/projects.lock`, `vx.lock.json` and `.vx/tmp/**` (where restores stage) at the project root.
- `src/.vx/tmp/x` and `src/sub/vx.lock.json` are inputs: only the files where vx writes them are left out.
- The run's cache folder (`cache.dir`, `--cache-dir`), wherever it sits, even when `tmp/**` names an ignored `tmp/vx-cache`.
- Nothing else: a tool's temp files are the task's to exclude.
- `['**/*', '!**/*.bun-build', '!**/.????????????????-????????.tmp/**']`: on or beside a `bun build --compile` task, exclude Bun's intermediate and its cross-compile extraction folder.
- `node_modules/x.js`, untracked and not ignored, is left out.
- `node_modules/.prisma/client/**` (a generated client git ignores) named outright is an input. A broad glob skips it.
- `node_modules/fixture.json` that git tracks, such as a committed test fixture, is an input.

**Outputs**

- `outputs: { files: ['dist/**'] }` is never an input of the same task: a task never invalidates itself.
- `outputs: { files: ['dist/**', '!dist/keep.txt'] }`: `dist/keep.txt` is no output, so it stays an input.
- `['**/*']` that can match another task's outputs is refused. Write `['**/*', '!dist/**']`, or ignore `dist/` in git.
- That refusal holds unless git ignores the outputs whole, or the producer is a dependency whose key this task leaves out (see Inputs over outputs under Settings).
- `src/**` as both the input and the output of one task is refused: vx removes outputs before a run, so a formatter would delete its sources.
- A task that rewrites files in place declares no outputs.
- `inputs.files: ['src/**']` beside `outputs.workspaceFiles: ['app/src/**']` is the same refusal: the two are compared from the root.
- `dist -> src`, an output folder linked into a folder `src/**` or `**/*.ts` reaches, is refused when a run finds it, committed or not.

**Nested projects**

- Files of a project inside this one's folder are never inputs. Projects share only through `dependsOn` and its dependencies' keys.
- `dist/**`, when `dist/` holds its own config, is refused by `vx lock` (`VX_E_NESTED_INPUT`): it would key nothing.
- Depend on that project's task instead, or name its files in `inputs.workspaceFiles`.
- A pattern that reaches into it past its fixed folder is refused too: `*/d.txt`, or a root project's `packages/**/*.ts` over its members.
- A leading `**`, a sibling folder and a `!` entry over a nested project are fine.
- `src/a -> ../../a`, an input link into another project, is refused when a run finds it and no `dependsOn` path reaches that project. With one, the link keys its target string alone.

</div>
</details>

##### `inputs.workspaceFiles` (optional, default `[]`)

Input files outside the project folder, written from the workspace root.

```ts
inputs: { files: ['src/**'], workspaceFiles: ['tsconfig.base.json'] }
```

| Write                | Means                                          |
| -------------------- | ---------------------------------------------- |
| `tsconfig.base.json` | the shared tsconfig at the root                |
| `shared/**`          | everything in the root `shared` folder         |
| `!shared/README.md`  | except its README                              |
| `packages/ui/src/**` | another project's files: allowed, rarely right |

Default: `[]`, no files outside the project.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `['shared/**', '!shared/README.md']`: the same glob rules as `files`. A `!` entry subtracts in any order.
- Git decides the same way as in `files`: tracked plus untracked-not-ignored, and an ignored file only when named outright.
- The files join the same key file list as `files`.
- `packages/ui/src/**` may reach into another project: there is no project boundary here.
- Prefer `files` plus `dependsOn` for links between projects. `workspaceFiles` is for inputs that truly live at the root.
- `/etc/**`, `../x/**` and `C:/x/**` are refused, as in `files`.
- Still left out: `.git/**`, `.vx/cache/**`, `.vx/projects.lock`, `.vx/tmp/**`, and `vx.lock.json` in every project.
- Also left out: the `.tmp-*` files a killed lock write leaves, and untracked files under `node_modules/`.
- The task's own outputs are left out: its `outputs.workspaceFiles`, and the `outputs.files` its globs reach in its own project.
- `vx watch` watches the whole workspace root once any config declares `workspaceFiles`, so an edit in a root folder re-runs too.
- The always-left-out set still filters the noise there.

</div>
</details>

##### `inputs.env` (optional, default `[]`)

The environment variables whose values decide whether the task runs again.

```ts
inputs: { files: ['src/**'], env: ['NODE_ENV', 'TARGET_BROWSER'] }
```

| Write           | Means                    |
| --------------- | ------------------------ |
| `NODE_ENV`      | the value of `NODE_ENV`  |
| `NEXT_PUBLIC_*` | refused: list each name  |
| `!CI`           | refused: names are exact |

Default: `[]`, no variables.

A name here is not passed to the command. To pass and track it, list it in `exec.env.passThrough` too.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `exec.env.passThrough: ['API_URL']` alone does not change the key.
- `inputs.env: ['API_URL']` alone does not pass `API_URL` to the command.
- A variable the command reads goes in both, or in `exec.env.define`: the command's environment is isolated, so otherwise the key changes on a value the command never sees.
- A name only in `inputs.env`, for a variable that changes inputs some other way, is legal but rare. In doubt, list it in both.
- vx ships no helper for the two lists. A config is TypeScript, so a function of your own can return both.
- `NEXT_PUBLIC_*` is refused: names are exact, with no wildcard.
- `!NAME` is refused here, in `exec.env.passThrough` and in `exec.env.secret`: with no wildcard to take it out of, it named a variable `!NAME` and excluded nothing.
- A name holding `=` or a NUL is refused.
- `X` unset, `X=` empty, and `X` never listed are three different keys. The command tells unset from empty too: `process.env.X ?? 'dflt'`, `${X-dflt}`.
- A value that is not UTF-8 fails the run, naming the variable, never its value: Latin-1 `é` and `è` both decode to U+FFFD and would key alike.
- A value that truly holds U+FFFD is refused with them: vx cannot tell the two apart.
- A `passThrough` value reaches the command decoded the same way, with U+FFFD's UTF-8 bytes in place of each invalid byte.

</div>
</details>

##### `inputs.runtime` (optional, default `[]`)

Commands whose output decides whether the task runs again. Each runs in the project folder.

```ts
inputs: { files: ['src/**'], runtime: ['vite --version'] }
```

| Write                | Means                               |
| -------------------- | ----------------------------------- |
| `vite --version`     | the version of the project's `vite` |
| `./scripts/probe.sh` | a probe script of your own          |
| `uname -m`           | the machine's architecture          |

Default: `[]`, no commands.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `rustc --version` prints to stdout, some tools to stderr: both are trimmed, kept apart, and added to the key.
- `node -v | cut -d. -f1` works: each command runs through `sh -c` in the project folder.
- `build` and `test` of one project sharing `vite --version` spawn it once per run.
- The command runs every time the key is needed: every run, warm ones too, `vx run --dry` and `vx run --no-cache`. Keep it free of side effects.
- `vx lock` locks the command text, not its output: a changed output still changes the key.
- A non-zero exit fails the task before its command runs, and `--dry` exits 1. A flaky probe never turns into a stale hit.
- The failure reads `[vx] app#build: cache key not derived: inputs.runtime probe exited 7: <command> (cwd: …)`, then the probe's last 64 KiB of output.
- A longer output is cut with `… N earlier characters dropped` above it.
- Output that is not UTF-8 fails the run too. Pipe binary output through a hash or `od`.
- `sleep 30 & echo x` answers `x` at once: the pipes are read for `250ms` after the shell exits, then the probe's process group is killed.
- What a leftover child prints later is not part of the answer.
- The command sees only the essential environment every task sees (`PATH`, `HOME`, the locale; see `ExecEnv`), with vx's values.
- It does not see the task's `exec.env.define` or `passThrough`, nor vx's other variables. One environment for every probe lets tasks share one spawn.
- A value the probe would read from the environment belongs in `inputs.env`.
- Its `PATH` leads with the project's `node_modules/.bin`, then the root's, so `vite --version` keys the `vite` the task runs.
- The command runs before the task's `exec`, so the task's `sandbox` does not apply: it runs unsandboxed even on a sandboxed task.

</div>
</details>

##### `inputs.workspaceRuntime` (optional, default `[]`)

Commands whose output decides whether the task runs again. Each runs once per run, at the workspace root.

```ts
inputs: { files: ['src/**'], workspaceRuntime: ['node -v'] }
```

| Write      | Means                        |
| ---------- | ---------------------------- |
| `node -v`  | the Node version, asked once |
| `uname -s` | the operating system's name  |

Default: `[]`, no commands.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `node -v` declared in 500 projects spawns once: one run per command across the whole run.
- It runs at the workspace root, for a value that is the same for every project.
- Its `PATH` leads with the root's `node_modules/.bin` only, not a project's: every project shares the value.
- A version manager's shim (nvm, Volta, mise, asdf) picks its version by the directory it runs in.
- So a project with its own `.nvmrc`, `.tool-versions` or Volta pin needs `runtime: ['node -v']`. At the root, the probe answers the root's version, and a change to the project's pin replays the old output.
- The rest is as in `runtime`: `sh -c`, run every time the key is needed, `vx lock` keeps the text, a non-zero exit fails the task.
- `runtime: ['node -v']` and `workspaceRuntime: ['node -v']` never collide in the key: each field has its own space.

</div>
</details>

##### `inputs.tasks` (optional, default = all upstream)

Which dependencies' keys count toward this task's key.

```ts
e2e: {
  exec: { command: 'vitest run' },
  dependsOn: ['build'],
  inputs: { files: ['tests/**', 'vitest.config.*'], tasks: [] },
}
```

| Write                 | Means                                       |
| --------------------- | ------------------------------------------- |
| `'*'`                 | every dependency in this project            |
| `'^*'`                | every dependency in other projects          |
| `'^build'`            | `build` of the projects this one depends on |
| `'packages/ui#build'` | that one task                               |
| `'!^lint'`            | except their `lint`                         |
| `[]`                  | none: the order stays, the key link goes    |

Default: every dependency counts, as `['*', '^*']`.

Use `[]` when a task waits for another only for order: tests that run after `build` but read only test files.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

**Forms**

- `'build'`, `'^build'` and `'pkg#build'` work as in `dependsOn`. `'*'`, `'^*'` and `'!form'` are extra, for filtering.
- `'build.*'`, `'^build.*'`, `'pkg#build.*'`, `'@acme/*#build'` and `'!codegen.*'`: a pattern works in either half of every form.
- A filter picks only among dependencies that exist, so a project pattern is safe here. A pattern read as text would pick nothing and cut the task off from its dependencies.
- `['*', '^*', '!^noisy']` is every dependency but the dependencies' `noisy`: entries apply in order, last one wins.
- A `!` drops only what it names: when two dependencies have equal keys (two groups over the same members), excluding one keeps the other.
- `['!gen']` is refused: a list of only negations starts empty, so it would count nothing. Write `['*', '^*', '!gen']`, or `[]`.
- `[]` cuts every key link. `--affected` follows: a change upstream does not select the task.

**An exact entry must match `dependsOn`**

- `['buidl']` is refused when the config loads: an exact entry must be named by one of the task's `dependsOn` entries. It would count nothing and hide the next upstream change.
- `dependsOn: ['build.*']` names `tasks: ['build.bun']`: a `dependsOn` pattern counts.
- `tasks: ['build']` against `dependsOn: ['^build']` names nothing: `build` is this project's, `^build` only the dependencies'.
- `'pkg#build'` may be this project or a dependency, so it pairs with either form. Two `pkg#task` entries must agree on the project.
- Once the graph is built, `vx lock`, `vx lock --check` and the run's plan check exact entries again.
- Refused then: `['nope#build']`, or `['a#build']` for a project named `packages/a`, over `dependsOn: ['build']`.
- Refused too: `['build']` over another project's `['b#build']`, and `['^build']` over this project's own.
- Not refused when a `^` entry or a pattern in `dependsOn` names the task: a preset's project may lack it.
- `a → b → c` with `dependsOn: ['^build']` and `tasks: ['c#build']` is refused: `c` is not a direct dependency. Write `'^build'`, which reaches `c`'s key through `b`'s.
- Patterns, wildcards and negations that match nothing stay silent: a preset-spread pattern may match nothing in a project.

**Groups and cycles**

- `dependsOn: ['build']`, where `build` is a group of `build.a` and `build.b`: the filter sees `build`, not its members.
- `'build.*'` there is refused by `vx lock` and the run's plan: it matches a member but not the group, so the key would not move with `build.b`.
- The same holds when it also matches a direct dependency (`dependsOn: ['build', 'build.a']`). Name the group, or depend on the member directly.
- `a ↔ b` with the default `build`: `dependsOn: ['build']` in `a` reaches `a#build` and `b#build`. A default `build` on a cycle includes none of the cycle's builds.
- `'build'` or `'a#build'` then picks the edges past `a#build` too: picking it alone left the key unmoved by an edit in `b`.

</div>
</details>

##### `inputs.stability` (optional)

What happens when an input changes while the task's command runs.

```ts
build: {
  exec: { command: 'tsdown' },
  inputs: { files: ['src/**', 'package.json'], stability: { strategy: 'mutable' } },
}
```

```ts
interface InputStability {
  strategy?: 'immutable' | 'mutable' | 'unchecked' // default 'immutable'
  severity?: 'warn' | 'error' // default 'warn'
}
```

| Write                   | Means                                |
| ----------------------- | ------------------------------------ |
| `strategy: 'immutable'` | any write to an input skips the save |
| `strategy: 'mutable'`   | rewriting the same bytes is fine     |
| `strategy: 'unchecked'` | writes are not checked               |
| `severity: 'warn'`      | keep the result and say why          |
| `severity: 'error'`     | fail the task                        |

Default: `'immutable'` and `'warn'`, on CI too.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

**Strategy**

- An uncached task saves nothing, so there the field changes nothing.
- `inputs.stability` on a task with no `exec` is refused: no command runs that could write its inputs.
- `'immutable'`: any write counts. An edit undone mid-run, or another task changing the file and putting it back, cannot be told from no edit.
- `'mutable'`: a file rewritten to the bytes the key read counts as unchanged, for a task that rewrites its own input identically (tsdown's `package.json`).
- `'mutable'` still counts different bytes.
- `'mutable'` still counts any write while another task that may write the file was running: it may have changed the file and put it back.
- Such a task is one of the same project, one whose sandbox grants writes elsewhere in the workspace, or a server `vx watch` keeps from an earlier run.
- The status line names that task: order the two with `dependsOn` to save.
- `'unchecked'`: no write counts. The entry is saved under the key taken before the command, whatever the command did; `severity` is ignored.
- `'unchecked'` still withholds the save when the key no longer held before the command started.
- After an `'unchecked'` task, a later task that reads the rewritten file reads its new bytes.

**Severity**

- A write that counts withholds the entry. `'warn'` keeps the result, says why on the status line, and the run goes on.
- `'error'` fails the task, so the run fails. Its label names the file: `failed (src/a.ts changed during the run, exit 1)`.
- `inputMoved` in `vx last --format json` marks it.
- Either way, every task that ran over the task's outputs, down the graph, withholds its save too.
- A task of any project that declares the moved file as an input withholds its own.

**Where the value comes from**

- Each field is resolved on its own, highest first: the variable, the task's `inputs.stability`, the workspace's `inputs.stability` (`.vx/workspace.ts`), the default.
- `VX_INPUTS_STABILITY_STRATEGY=mutable` (`immutable`, `mutable`, `unchecked`) sets the whole run.
- `VX_INPUTS_STABILITY_SEVERITY=error` (`warn`, `error`) sets the whole run: a CI job fails on a moved input without editing configs.
- Any other value of either variable is refused before a task runs.
- The strategy is in the key, from whichever source: an entry saved under `'unchecked'` is no hit once the check is back.
- `'immutable'` or unset, from the variable or the workspace, adds nothing to the key.
- The severity is in the key only as the task's own field.

A whole config, for a build that rewrites its `package.json`:

```ts
import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    build: {
      // tsdown rewrites package.json with the same bytes on every build;
      // different bytes fail the run rather than rebuild next time.
      exec: { command: 'tsdown' },
      inputs: {
        files: ['src/**', 'package.json'],
        stability: { strategy: 'mutable', severity: 'error' },
      },
      outputs: { files: ['dist/**'] },
      cache: true,
    },
  },
})
```

</div>
</details>

### `outputs` (optional)

The files the task writes. A cached task saves them after a run and puts
them back on a hit.

```ts
outputs: {
  files: ['dist/**']
}
```

| Field            | Means                                              |
| ---------------- | -------------------------------------------------- |
| `files`          | what the task writes inside its project (required) |
| `workspaceFiles` | what it writes elsewhere, from the workspace root  |
| `clean`          | `false` keeps the last outputs on a miss           |

Default: none. A cached task needs it; see [`cache`](#cache-optional).

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

The full shape:

```ts
interface TaskOutputs {
  files: readonly string[] // required
  workspaceFiles?: readonly string[] // optional; workspace-root-relative
  clean?: boolean // optional; false keeps outputs on a miss
}
```

- `outputs` on a task with no `cache`: dependants' sandbox reads work the
  same. Nothing is saved, restored or cleaned: there is no snapshot to keep
  exact.
- `clean: false` keeps the outputs on a miss instead of deleting them first,
  for a tool that reads its own last output (an incremental build's state
  file).
- `clean: false` gives up the clean tree: the save stores every file the
  outputs match after the run, so a file an older build left behind is
  cached and restored on every machine.
- `clean: false` still starts a retry clean, and a hit still restores the
  cached files bit-identically.
- `clean` omitted: the workspace's `outputs.clean` decides, else `true`. A
  workspace `false` keys the task as its own `false` would.

</div>
</details>

#### `outputs.files` (required)

The files inside the project the task writes. vx deletes them before a
run, saves them after it, and restores them on a hit.

```ts
outputs: {
  files: ['dist/**']
}
```

| Write            | Means                                              |
| ---------------- | -------------------------------------------------- |
| `dist/**`        | everything under `dist`; may match nothing         |
| `dist`           | the same tree, but `dist` must exist after the run |
| `dist/index.js`  | this file, which must exist after the run          |
| `!dist/**/*.tmp` | except temp files: not cleaned, saved or restored  |
| `[]`             | the task writes no files (`oxlint`, `vitest run`)  |

Default: none, the field is required inside `outputs`.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

**What must exist.** Each rule applies once the command exits 0; a failed
check fails the task, cached or not, saves nothing, and the error names
each path.

- `dist/index.js`, `dist`: a literal path must exist. One that matches
  nothing fails the task.
- `['dist/**', '.next/**']`: a glob may match nothing beside one that
  matched, so one list fits a `vite build` app and a Next app alike.
- `['dist/**']` with nothing written: a task that declares outputs and
  writes none at all fails.
- `dist/**` over an empty `dist/`: an empty directory is no match. To
  require one, name it as itself: `public/uploads`.
- `['dist/**', '!dist/a.js']`: a path a `!` entry takes back is no match.
- `report.json` written only sometimes: match it with a glob
  (`reports/*.json`), not a literal path.

**How a path is read.**

- `dist` and `dist/` name the whole tree, as `dist/**` does.
- `dist/` names a folder: a file named `dist` matches nothing, and the task
  fails saying a folder was declared and a file was written.
- `./dist/**` is `dist/**`: a leading `./` is dropped.
- `.` alone is refused: write `**`.
- `dist/`, `coverage/`, `.next/`: outputs ignore `.gitignore`, so
  gitignored build folders are saved as usual.
- `**/*.js` never saves, restores or cleans the project's installed
  `node_modules`: write `node_modules/**` to make it an output.
- `.output/**` takes `.output/server/node_modules/**`: a `node_modules`
  under a glob's own literal folder is the build's.

**Project boundaries.**

- `sub/dist/**` where `sub/` has its own config: `vx lock` refuses it
  (`VX_E_NESTED_OUTPUT`), since it would save nothing.
- Fix it: let `sub`'s own task write those files, or name them in
  `outputs.workspaceFiles`.
- A pattern that reaches into `sub/` past its fixed folder is refused
  too: `*/dist/**`, or a root project's `packages/**/*.log` over its
  members.
- A leading `**`, a sibling folder and a `!` entry are fine beside a
  nested project.
- `sub/` holding its own `.vx/workspace.*`: no outer output glob matches
  under it, so the clean never deletes its files.
- An outer input glob still matches inside a nested workspace, so an edit
  there re-keys the outer task.

**Symlinks.**

- `dist/latest -> v2`: a matched link is saved and restored as the link,
  its target as written: a file, a folder, or nothing yet.
- The clean unlinks a link and never follows it. No byte of its target is
  read.
- `/abs/x`, `../../../etc/hosts`, `../../.git/config`: a link must be
  relative, stay inside the workspace and stay out of `.git`.
- Such a link fails the save by name and caches nothing, so the next run
  executes again.
- `libu.so -> libu.so.1`: a link may target another output link.
- `up/../x`: a link may not pass through another link on the way, loop, or
  chain past 8 links.
- `dist -> real-out`: an output folder that is a link is followed; its
  target is cleaned, saved and restored.
- An output folder link that resolves outside the project refuses the
  task, naming the link.

**The clean.**

- On a miss, before the command: matching files and folders are deleted,
  so a stale `dist/old.js` never survives into a fresh build.
- On a hit: the same delete, then the cached files are copied in, over any
  local edit. The tree ends as the cached snapshot, byte for byte.
- The clean prunes the folders it emptied, so an output that is a folder
  one run and a file the next restores either way.
- `dist/README.md` tracked by git: never deleted. It is still saved,
  restored and in the key, even when no `inputs.files` glob reaches it.
- A run that removes a tracked output saves nothing: no hit could replay
  the removal.
- `files: []`: no clean. Nor with no cache write (`--no-cache`,
  `--cache-policy=local:r`). `--force` keeps cache writes on, so it cleans.
- A same-project dependency that writes into `dist/` with no outputs of
  its own (an `ng-packagr` step before a `build` over `dist/**`): the
  clean deletes its files.
- vx warns then, naming the files and the task that wrote them: declare
  them in that task's outputs, or have it write elsewhere.

**`!` entries.**

- `['dist/**', '!**/*.tmp']`: a path taken back is not cleaned before a
  run or a restore, not saved, and not accepted from a remote artifact.
- `vx watch` still watches a path taken back, and it stays an input, so
  an edit to it moves the key.
- `['!dist/**']` alone selects nothing and is refused. `!!x` is refused,
  as for inputs.
- `['dist/**', '!dist/tmp/**']`: a warm hit still takes the folder
  shortcut, which reads only the positive globs.
- A tracked file needs no `!`: the clean already keeps it.
- `[]`: valid for a task that writes nothing. A cached `oxlint` still
  caches its success, so the next run is a no-op too.

</div>
</details>

#### `outputs.workspaceFiles` (optional, default `[]`)

What the task writes outside its own project, written from the workspace
root. vx deletes, saves and restores them as it does `files`.

```ts
outputs: {
  files: ['out.txt'],
  workspaceFiles: ['generated/**'],
}
```

| Write                         | Means                          |
| ----------------------------- | ------------------------------ |
| `generated/**`                | a folder at the workspace root |
| `packages/web/public/app.css` | one file in another project    |
| `!generated/tmp/**`           | except a scratch folder        |

Default: `[]`.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

**Where they go.**

- `generated/a.ts` is stored as `workspace-outputs/generated/a.ts` in the
  artifact, so project and workspace outputs never collide.
- `files: ['workspace-outputs/**']`: refused at load, since that top-level
  name is the namespace.
- `files: ['**/*.js']` matching a file under `workspace-outputs/`: refused
  at save, and the task is not cached.
- `!` entries work as in `files`.

**No project boundary.**

- `packages/web/**`: these globs may save, overwrite on restore and delete
  on clean anywhere, other projects included. Prefer `files` when the
  task can write in its own folder.
- `packages/b/**` covering a `vx.config.*`, the task's own or another's:
  `vx lock` refuses it, since the clean would delete that config and its
  untracked files.
- `!packages/b/vx.config.ts` takes the config back. Do it only if the rest
  of `packages/b` is truly the task's.
- A folder on a glob's literal head that is a link out of the workspace
  refuses the task, as it does for `files`.

**Two tasks, one path.** vx cleans outputs before a run and a restore, so
two tasks that provably overlap are refused at graph build: the second
would delete the first's files.

- `./dist/**` is `dist/**`, `dist//**` is `dist/**`, and `dist/./app.js` is
  `dist/app.js`: the check compares paths, not spellings.
- `dist` collides with `dist/app.js`: a literal is the file or its whole
  tree.
- `dist/**` collides with `dist/extra/**` and `dist/*.js`: a whole tree
  holds every glob whose literal head lies in it.
- `**/*` collides with `**/dist/**`: both match `x/dist/x`.
- `['**/dist', '!types/**']` beside `types/**`: no overlap, since the `!`
  takes the other glob back whole.
- `dist/*` beside `dist/sub/**` only might overlap: allowed, and the last
  restore wins.
- `packages/b/dist/a.txt` collides with project `b`'s `dist/**`: workspace
  outputs are checked against every project's `files` too.
- An overlap is refused even when one task depends on the other, unless
  the workspace sets `run.rules.exclusiveOutputs: false`.
- With that `false`, the dependant is additive: it owns only what its run
  adds, or finds as its own last run left it.
- How additive outputs work:
  [caching.md § Additive outputs](caching.md#additive-outputs-two-tasks-one-tree-an-edge-between-them).
- Across the two namespaces, an upstream `files` task sees the
  dependant's globs in its own project's terms.
- So `**/a.txt`, which does not start inside that project, is refused even
  with the edge.

</div>
</details>

### `cache` (optional)

`cache: true` lets vx skip a task whose inputs did not change and restore
its outputs instead. Without it, the task always runs.

```ts
build: {
  exec: { command: 'vite build' },
  inputs: { files: ['src/**', 'vite.config.ts'] },
  outputs: { files: ['dist/**'] },
  cache: true,
}
```

| Write          | Means                                        |
| -------------- | -------------------------------------------- |
| `cache: true`  | cached; needs `exec`, `inputs` and `outputs` |
| `cache: false` | runs every time, no cache read or write      |
| omitted        | the same as `false`                          |

Default: `false`. Caching is opt-in.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `cache: true` with no `inputs` or `outputs`: the loader refuses it. What
  a task reads and writes is a choice you make on purpose.
- `cache: true` with no `exec`: refused too, since a task with no command
  produces nothing to cache.
- Why opt-in: caching on by default, with guessed inputs and no outputs,
  gives stale builds the moment a config falls behind.
- A forgotten cache costs one rerun. A stale hit ships broken files.

</div>
</details>

### `exec.sandbox` (optional)

Runs the command in an OS sandbox: it may touch only what you grant, and
a touch you did not grant fails the task. Omit it and the command runs
unsandboxed.

```ts
exec: {
  command: 'vite build',
  sandbox: { allow: { read: ['.'], write: ['dist/'] } },
}
```

| Field                    | Type                  | Default | What it does                                                                                                                                                   |
| ------------------------ | --------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allow`                  | `SandboxGrants`       | `{}`    | What the command may do beyond reading its project: the grants below (`{ read: ['~/.npmrc'] }`).                                                               |
| `allow.read`             | `string[]`            | `[]`    | Paths or globs it may read: project-relative, `~/`-relative or absolute (`['~/.npmrc']`). Not a cache input.                                                   |
| `allow.write`            | `string[]`            | `[]`    | Paths or globs it may write (`['dist/']`). A write grant can be read too.                                                                                      |
| `allow.network`          | `true \| string[]`    | none    | Domains it may reach (`['registry.npmjs.org']`); `'localhost:4173'` reaches a server on this machine. `true` opens the network but adds no domain.             |
| `allow.systemInfo`       | `string[]`            | `[]`    | macOS: sysctl names it may read (`['vfs.disk-space']`).                                                                                                        |
| `allow.unixSockets`      | `true \| string[]`    | none    | Unix sockets it may open (Docker, ssh-agent, a database): `true` for all, or a list of paths (`['/var/run/docker.sock']`). Linux allows any path once granted. |
| `allow.localBinding`     | `boolean \| number[]` | `false` | Ports on localhost it may listen on: `true`, or a list (`[4173]`), which also exposes those ports to your machine.                                             |
| `allow.machLookup`       | `string[]`            | `[]`    | macOS: mach service names it may look up (`['com.apple.FSEvents']`).                                                                                           |
| `allow.pty`              | `boolean`             | `false` | `true` lets it open a terminal (a TTY).                                                                                                                        |
| `allow.gitConfig`        | `boolean`             | `false` | `true` lets it write the repository's `.git/config`.                                                                                                           |
| `deny`                   | `SandboxDenials`      | `{}`    | What it may not do even when a grant allows it (`{ network: ['*:22'] }`).                                                                                      |
| `deny.network`           | `string[]`            | `[]`    | Domains it may not reach, checked before `allow.network` (`['*:22']` blocks every host's port 22).                                                             |
| `ignore`                 | `SandboxIgnore`       | `{}`    | Refused touches to leave out of the report; the task still cannot make them (`{ read: ['~/.cache/probe'] }`).                                                  |
| `ignore.read`            | `string[]`            | `[]`    | Paths of refused reads to leave out (`['~/.cache/probe']`).                                                                                                    |
| `ignore.write`           | `string[]`            | `[]`    | Paths of refused writes to leave out (`['*.bun-build']`).                                                                                                      |
| `ignore.systemInfo`      | `string[]`            | `[]`    | macOS: sysctl names of refused reads to leave out (`['hw.memsize']`).                                                                                          |
| `ignore.network`         | `string[]`            | `[]`    | Refused connections to leave out, as `'<host>:<port>'` (`['telemetry.example.com:443']`).                                                                      |
| `hermetic`               | `boolean`             | `false` | `true`: outside the workspace it reads only what `allow.read` names, so a tool on the machine cannot be used unseen.                                           |
| `weakerWhenNested`       | `boolean`             | `false` | Linux: `true` lets the sandbox run where vx itself runs in a container or another sandbox; the task then sees the host's `/proc`.                              |
| `weakerNetworkIsolation` | `boolean`             | `false` | macOS: `true` sends the network through a proxy on your machine, with weaker isolation.                                                                        |

Default: none, the command runs unsandboxed. `sandbox: {}` grants
nothing at all. The [sandboxing guide](https://vznjs.github.io/vx/docs/sandboxing/)
walks through it.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

The full shape:

```ts
interface SandboxConfig {
  allow?: SandboxGrants // what the command may do
  deny?: { network?: string[] } // domains this task may not reach (below)
  ignore?: SandboxIgnore // violations to leave out of the report
  weakerWhenNested?: boolean // Linux: sandbox where vx itself runs inside a container or sandbox (default false)
  weakerNetworkIsolation?: boolean // macOS: host-proxy net, lower isolation (default false)
  hermetic?: boolean // refuse reads outside the workspace too (default false, below)
}

interface SandboxGrants {
  read?: readonly string[] // paths or globs, project-relative, `~/`-relative or absolute
  write?: readonly string[] // paths or globs; a write grant is readable too
  network?: true | readonly string[] // an allowlist of domains; `true` adds none; 'localhost:4173' reaches a server on this machine (below)
  systemInfo?: readonly string[] // sysctl names, e.g. 'vfs.disk-space'; each grants system-info and sysctl-read (macOS)
  unixSockets?: true | readonly string[] // AF_UNIX bind/connect, all or by path (Linux: any path)
  localBinding?: boolean | readonly number[] // bind localhost ports (macOS: and reach any; Linux binds in the task's own network, no grant needed); a list also exposes them to the host (a port the host or another running task already holds fails the task)
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

**How it runs**

- `sandbox: { … }` is one shape on both platforms: vx turns it into a
  seatbelt profile on macOS, and bwrap mounts plus seccomp on Linux.
- `persistent: true` with `sandbox`: a server runs sandboxed too, but
  gets no violation report. The report reads the trace after the
  process exits, and a server exits only at teardown.
- `sandbox` in one task only: the sandbox starts only when some task
  declares `exec.sandbox`.
- An unsupported platform: a sandboxed task fails fast, never runs
  unsandboxed.
- `bwrap: not found`: Linux needs `bubblewrap`, `socat` and `ripgrep`
  (`rg` expands the sandbox's built-in deny globs). vx names a missing
  one and how to install it.

**Baseline: `sandbox: {}`**

- `sandbox: {}` reads nothing in the workspace, writes only its own
  `TMPDIR`, and reaches no host.
- `allow: { read: ['.'] }` is the first line of almost every block: the
  baseline hides even the task's own project.
- `cat ./README.md` under `sandbox: {}`: the task still starts in its
  own (then empty) directory, so a relative read is refused and
  reported, never resolved elsewhere.
- `~/.cache`, `/etc`, the toolchain: the read wall is the workspace root,
  so paths outside it stay readable.
- `inputs: { runtime: ['node -v'] }`: a path outside the workspace is in
  no key. If the output depends on one, declare it in `inputs.runtime`
  or `inputs.env`; the sandbox does not catch it.

**Credential stores**

- `read: ['.', '~/.npmrc']` for a publish: a credential store stays
  denied unless a grant names it. A dependency the task ran could copy a
  key into an output the cache shares.
- `write: ['~/.config/gh/']`: a write grant at or inside a store frees
  that path alone.
- `$XDG_CONFIG_HOME/gh`: a store under home's `.config`, `.local/share`
  or `.cache` is denied again under `$XDG_CONFIG_HOME`, `$XDG_DATA_HOME`
  or `$XDG_CACHE_HOME`, which the task sees.
- `npm config set` saving a token in one task: stores are looked for as
  each task starts, so one an earlier task wrote is denied too.
- What frees a store is the union of the read grants and, on Linux, the
  directory holding each file-shaped write grant (see "A write grant
  reads wider").

The credential stores:

- Keys and cloud: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`,
  `~/.config/gcloud`, `~/.config/gh`, `~/.docker/config.json`, `~/.netrc`.
- git: `~/.git-credentials`, `~/.config/git/credentials`.
- Package registries: `~/.npmrc`, `~/.yarnrc.yml`, `~/.yarnrc`,
  `~/.config/pnpm/rc`, `~/Library/Preferences/pnpm/rc`, `~/.pypirc`,
  `~/.config/composer/auth.json`, `~/.composer/auth.json`.
- Service tokens: `~/.config/glab-cli`, `~/.config/github-copilot`,
  `~/.s3cfg`, `~/.oci`, `~/.cache/huggingface/token`,
  `~/.huggingface/token`, `~/.kaggle/kaggle.json`.
- Registry tokens: `~/.bunfig.toml`, `~/.config/.bunfig.toml`,
  `~/.cargo/credentials`, `~/.cargo/credentials.toml`,
  `~/.gem/credentials`, `~/.config/hub`, `~/.config/containers/auth.json`.
- Infra: `~/.terraform.d/credentials.tfrc.json`, `~/.vault-token`,
  `~/.pgpass`.
- Deploy CLIs: `~/.config/configstore/firebase-tools.json`,
  `~/.local/share/com.vercel.cli/auth.json`,
  `~/Library/Application Support/com.vercel.cli/auth.json`.
- Netlify, Wrangler: `~/.netlify/config.json`,
  `~/.config/netlify/config.json`, `~/Library/Preferences/netlify/config.json`,
  `~/.wrangler/config`, `~/.config/.wrangler/config`.
- More deploy CLIs: `~/Library/Preferences/.wrangler/config`,
  `~/.fly/config.yml`, `~/.supabase/access-token`, `~/.config/doctl`,
  `~/Library/Application Support/doctl`.
- Service and agent CLIs: `~/.config/stripe/config.toml`, `~/.config/op`,
  `~/.expo/state.json`, `~/.claude/.credentials.json`, `~/.codex/auth.json`.
- Firefox and Chrome profiles: `~/.mozilla/firefox`,
  `~/Library/Application Support/Firefox`, `~/.config/google-chrome`,
  `~/.config/chromium`.
- More browser profiles: `~/.config/BraveSoftware`,
  `~/.config/microsoft-edge`, `~/Library/Application Support/Google/Chrome`,
  `~/Library/Application Support/Chromium`.
- macOS browser data: `~/Library/Application Support/BraveSoftware`,
  `~/Library/Application Support/Microsoft Edge`, `~/Library/Cookies`.
- SOPS age keys: `~/.config/sops/age`,
  `~/Library/Application Support/sops/age`.
- Other: `~/.config/rclone`, `~/.my.cnf`, `~/.password-store`,
  `~/.sentryclirc`.

**vx's own stores and the repository**

- `~/.vx`, `VX_CACHE_DIR=~/.cache/vx`: vx's shared store, and a cache
  directory outside the workspace, are denied. Read, they would hand a
  task every project's cached outputs.
- A workspace below the git top-level, or a linked worktree
  (`@vzn/vx-dte`'s `local()` workers): its git dir lies outside the
  workspace, and `git --git-dir` there would read any project's bytes.
- `write: ['../../.git/x']` reaching that git dir or common dir is
  refused: both are denied and sealed like the workspace's own `.git`.
- `../sibling/` in the same git top-level: the top-level's other
  contents, and a worktree's main checkout, are denied around the
  workspace and the task's write grants.
- A dotfiles repository at `~`: the tree holding home stays readable;
  only its git dir is denied.

**The workspace's `.gitignore`**

- A task sees nothing above its project, so not the workspace's
  `.gitignore` or `.git`, and no violation says so.
- A tool that reads its ignore rules there then works on files they
  hide. oxlint 1.83 linted every file `node_modules` links to: 7739
  files in 299 s, not 488 in 7 s.
- oxlint's config `ignorePatterns` did not stop that walk. Give the
  ignores on the command (`oxlint --ignore-pattern node_modules`), or in
  a `.gitignore` in the project.

**`hermetic: true`**

- `hermetic: true` moves the read wall from the workspace root to `/`:
  outside the workspace the task reads only what `allow.read` names.
- `bash`, `setsid`, `strace`, `env`, `socat`, `grep`, `sleep`: vx still
  grants the programs it runs around the command (the task shell and
  vx's observer too), and the libraries they link.
- `ldd $(command -v node)`: any other tool is yours to grant, with its
  libraries, so the task cannot lean on the machine unseen.
- `/usr/bin/python3 -> python3.12`: a grant spelled through links is
  there as spelled, each link with its target.
- `exit 127`: a command the host has but no grant reads exits 127, and
  vx names its host path and the grant.
- `#!/usr/bin/env node`: so does a command whose runtime is hidden, or a
  library that runtime links.
- `ldd: not found`: on Linux `ldd` must be on vx's PATH.
- `runtime: ['/opt/node-22/bin/node -v']`: a grant says what a task may
  read, `inputs.runtime` what moves its key. Declare both for a tool:

```ts
import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    build: {
      exec: {
        command: '/opt/node-22/bin/node build.js',
        sandbox: { hermetic: true, allow: { read: ['.', '/opt/node-22/'], write: ['dist/'] } },
      },
      inputs: { files: ['build.js', 'src/**'], runtime: ['/opt/node-22/bin/node -v'] },
      outputs: { files: ['dist/**'] },
      cache: true,
    },
  },
})
```

**Grant paths**

- `read: ['~/.npmrc']`: in `allow` and `ignore`, `~` and `~/…` are the
  home directory.
- `read: ['~root/x/']` is refused when the config loads, naming the
  entry: vx does not look up another user's home.
- `write: ['g\tx']`: a write grant holding a control character (a tab, a
  newline) is refused at load. A reported write spells a tab as a space,
  so it could not be told apart.
- `write: ['../outside/']` through a symlink that leaves the project is
  refused: vx follows no link out of the project.
- `write: ['gen/']` over `gen -> real`: a link that stays inside binds at
  both spellings, so a write through `gen` lands in `real`.
- `read: ['src/']` over `src -> lib`: on Linux each link is laid as it
  is, so the task reads `src/` as granted.
- A link into a write grant, itself not granted: on Linux a read-only
  view (vx says so before the task runs). Grant the link too to write
  through it.

**Globs in grants**

- `read: ['src/**/*.ts']`: `read` and `write` take patterns.
- `write: ['dist/*.js']` on macOS: the pattern reaches the policy, so it
  matches files created during the run.
- `read: ['gen/*.json']` on Linux: a grant is a mount, so a read pattern
  is expanded when the task starts; a file created later is not covered.
- `read: ['**/*']`: on both platforms `<dir>/**` and `<dir>/**/*` collapse
  to `<dir>`, so this lets a task list its own directory.
- `write: ['.*.tmp/**']`: a `<dir>` that is itself a glob keeps its
  subtree (what is inside each match).
- `read: ['pages/\\[id\\].tsx']`: `[id]` is a class, as in a task glob,
  so a Next.js route is granted escaped.
- `read: ['c{a,b}']` grants `ca` and `cb`, on both platforms; a range,
  `{1..3}`, too.
- `write: ['g/{a,b}.txt']` is two file grants.
- `read: ['c\\{a,b\\}']` grants a name that holds a brace.
- `read: ['opt/*.json']` matching nothing is ordinary (an optional file, a
  cache not yet filled) and is not reported.
- `read: ['gen/x/*.json']` before `gen/x` exists matches nothing the same
  way.

**Linux glob limits**

- `write: ['a[1]/']`: a write path holding a bracket, `*` or `?` cannot
  be mounted. vx says so once and names the directory above to grant; a
  write under it is refused and reported.
- `read: ['a\\*b.txt']`: a read path whose name holds `*` or `?` cannot
  be granted alone (its siblings would be too). vx leaves it out, says so
  once, and a read of it is refused and reported.
- `read: ['a\\\\b']`: a grant of either kind holding a backslash is left
  out the same way: the runtime cannot resolve such a path.
- `write: ['dist/*.js']`, `['*.js']`, `['dist/**/*.js']`: a write glob's
  directory in the task's own directory is bound writable, made first
  when missing.
- `write: ['*.js']` at the project root: a read or write there that no
  grant covers is a violation, as beside a widened file grant (below).
- A write glob's directory elsewhere that no read grant shows is not
  bound.
- `write: ['*.log']` in a root project, or a glob outside the workspace:
  binding would expose `.git`, a nested project or the read-only host.
  Matching nothing at the start, it mounts nothing.
- There the task's first write fails with `Read-only file system`. vx
  reports that grant before the task runs, once, and names the directory
  to grant instead (`allow: { write: ['gen/'] }`).
- A write glob under no mount inside the workspace lands in the
  sandbox's own scratch: the task may create, write and remove matches
  there, and nothing outlives the task.
- So scratch suits a tool's temp directory, not an output: a file the
  task leaves there is reported and fails the task.

**A write grant's shape**

- `write: ['dist/vx']`: a missing write path is made before the task
  starts (a mount needs something to bind). A literal names a file: an
  empty `dist/vx` the build overwrites.
- `write: ['coverage/']` or `write: ['dist/**']`: a directory the task
  will create.
- `write: ['~/.bun/install/cache/']`: outside the project only those two
  shapes are made, never a file.
- `write: ['coverage']` then `mkdir coverage`: the task meets "File
  exists" ("Not a directory" for `mkdir -p coverage/lcov`). The failure
  names the `coverage/` spelling.
- vx then removes the empty file it made, as it removes any placeholder
  the task never wrote, so an unwritten one is never archived as an
  output.
- `write: ['out.txt']` at a single-package workspace's root: refused if
  its bind would make `.git`, `.vx/cache`, the cache directory or a
  nested project writable.
- `write: ['../.git/hooks/']`: a grant inside `.git`, `.vx/cache` or the
  cache directory is refused too; a hook planted there runs unsandboxed.
- `write: ['dist/']` at that root stands: a directory grant is judged as
  the directory, made first when missing.
- `ignore: { write: ['*.bun-build'] }`: a temp name Bun makes anew each
  run (`.<hex>-<n>.bun-build`, `.bun-pack.<hex>-<n>.tmp`) gets no `fix:`
  grant; the failure names its `ignore` glob instead.

**A write grant reads wider**

- `write: ['tsconfig.tsbuildinfo']`: a write path is readable too.
- `write: ['out.txt']` at the project root on Linux: the grant binds the
  whole root, readable and writable. Atomic writers rename onto the
  target, and bwrap cannot rename onto a file mount.
- Such a read or write succeeds, so vx reports it as a violation: an
  open, hard link or move of a file there at the start that no grant
  covers.
- The same for a `readlink` of a link there (git hashes a link by its
  target), the directory's listing, and a write, removal or move of
  what was there.
- A new file or directory the task leaves there is reported too. The
  declared file, and what the task made and then moved or removed, stay
  its own.
- `stat` of a sibling (its size, times or presence) is not seen.
- `write: ['out/result.txt']`: put declared outputs in a subdirectory,
  and the rest stays denied outright.
- On macOS paths are matched, not mounted, so a file grant stays exact.

**Network**

- `network: ['example.com', '*.example.com', 'example.com:443', 'localhost']`:
  a network entry is a host pattern, with or without a port.
- `network: ['https://example.com']` is refused by `vx lock`, naming the
  task and entry. So are a dotless host, a bad port, and `*` or `*.com`
  (too broad).
- `deny: { network: ['*'] }` denies every host; `['*:22']` denies port
  22 on every host. Only `deny.network` takes a bare `*`.
- `network: ['registry.npmjs.org']` in one task: each task reaches only
  the hosts its own list names. A task that lists none reaches none,
  even when another task lists some.
- `network: true` reaches the union of the run's lists: nothing in a run
  with no list.
- One proxy per run filters by the union of every task's list; vx puts
  a proxy of the task's own in front, so the task's list is checked
  first.
- `deny: { network: ['evil.test'] }` is the task's own, checked before
  its allowlist.
- A refused request is a violation on both platforms,
  `deny network-outbound <host>:<port> (<reason>)`, and fails the task
  even when the task survived it.
- A client that skips the proxy and dials an address itself (socat, a
  raw socket) gets `Network is unreachable`: no grant lifts it.
- A task resolves no names: Node's `fetch` and `https` look the host up
  themselves and fail `getaddrinfo EAI_AGAIN <host>`, granted or not.
- Node's own clients take the proxy with `NODE_USE_ENV_PROXY=1` (Node 22.21+, 24.5+):
  `exec: { env: { define: { NODE_USE_ENV_PROXY: '1' } } }`.
- Node 22 then prints an experimental warning at start; Node 24 does not.
  vx sets no such variable itself. On Linux the failure names it, and the
  grant when the host has none.
- A host `deny.network` holds gets no `allow.network` entry in the
  `fix:` line: no allow lifts it.
- `ignore: { network: ['example.com:443'] }` silences one refusal,
  matched as the proxy matches: case-blind, a trailing dot dropped
  (`EXAMPLE.Com.` matches).

**A server on this machine**

- `network: ['localhost:4173']` (or `127.0.0.1:4173`): a sandboxed
  client of a server another task runs (an e2e against `vite preview`)
  grants its port.
- On Linux the task has a network of its own, and vx relays that port
  alone into it. On macOS the profile allows that port alone.
- `network: ['localhost']` reaches no port: a client dials loopback
  directly, never through the proxy that serves the rest of the list.
  Nothing else on loopback is reachable.
- `localBinding: [4173]`: a sandboxed server lists its port, so it is
  reachable from outside its own sandbox.
- On Linux, a failed task refused on a loopback port that a process on
  this machine listens on gets the grant to add,
  `allow: { network: ['localhost:4173'] }`.

**Unix sockets**

- `unixSockets: true` (or a `localBinding` port list, bridged through a
  unix socket) lifts the `socket(AF_UNIX)` block for that task only,
  never for the run's other sandboxed tasks.
- `socket(1, 1, 0): Operation not permitted` from a Docker, ssh-agent
  or database client: on Linux no violation names the block.
- A failed task whose output says so gets the grant: the path the
  client names (`unixSockets: ['/var/run/docker.sock']`) or the command
  connects to (`UNIX-CONNECT:<path>`, `unix://<path>`).
- With neither, it says how to find the path, never `true`: that allows every socket,
  docker.sock included, which is root on the host.
- A socket outside the project is hidden as any path is: the next run
  names its read grant.

**Ignoring a report**

- `ignore: { read: ['~/.cache/probe'] }`: patterns per class a refusal
  is reported in, `read`, `write`, `systemInfo` or `network`, the class
  of the grant that would have allowed it.
- `ignore: { env: [] }` is refused: any other class name is.
- An ignored touch is still refused; only the report leaves it out.

**Dependencies**

- Nothing comes from `cache`: `inputs` says what invalidates a task,
  `sandbox.allow` what it may touch. A declaration for caching never
  widens the sandbox.
- `node_modules`: the one grant vx makes for you. It covers each
  workspace package linked there (at its real path), and in turn each
  such package's own `node_modules`.
- `node_modules -> /mnt/store/node_modules`: one linked out of the
  workspace is granted at its target and, on Linux, laid as that link,
  so its `.bin` stays on PATH.
- A project never names a sibling to import what its `package.json`
  already depends on.
- A link back to the task's own project, or a directory holding it, is
  not followed: it would grant the whole project past its `allow.read`.
- `cache: true` plus `dependsOn: ['ui#build']`: a cached task gets a
  linked workspace package only when some task of it is folded into its
  key (as `inputs.tasks` selects it; groups pass everything through).
- Every other link inside the workspace root is withheld. A read through
  one fails the task, with one line naming the package and the edge that
  would key it.
- `cache` only narrows this grant: a task without it keeps it whole, and
  your own `allow` grants never depend on it.
- An edge to `ui#build` (inputs `src/**`) covers a read of
  `ui/README.md` too: the key answers for the package, not the file.

**Reading a dependency's outputs**

- `dependsOn: ['tools#node']`: a sandboxed task may read the declared
  `outputs` of every task its key folds (as `inputs.tasks` selects
  them), in any project, `hermetic` or not.
- `../tools/out/bin/node`: so one project serves a tool to the rest. The
  key moves with every file that made it, so the read replays nothing
  stale.
- `gen/notes.txt` beside `gen/**/*.js`: the dependency's sources, and
  any file under its outputs that no glob takes (or a `!` entry takes
  back), stay hidden.
- `out/**`: a directory every file of which is an output is granted
  whole. Elsewhere each output file is granted alone, and a read of a
  file beside them is refused and reported.
- A link is granted only inside a directory granted whole: alone it
  would grant its target.
- About 300 files under a 100-character path: each file granted alone is
  a bind on a command line of about 64 KiB. Past it the task fails before
  it runs, naming the dependency.
- The fix: declare the files beside the outputs as outputs too, or move
  them out.

**A missing write grant fails the task**

- `echo x > notes.txt` with no write grant: macOS refuses and reports
  it. On Linux the write meets a read-only bind or mask; both read
  `Read-only file system`.
- The mask is the empty directory laid over what is hidden: the
  workspace root around a project, or a single-package workspace's root.
- `read: ['.']` with `write: ['dist/']`: the project root is masked too,
  and its children are bound one by one around the write grant.
- `cmd 2>/dev/null; exit 0`: a write no grant binds is reported and
  fails the task, even when the command swallowed the error.
- Where vx falls back to strace, an `openat2`'s flags are unseen. On a
  path the task may read it is taken as a read: a swallowed write passes,
  having written nothing.
- On a path it may not read, that `openat2` is reported as an open, and
  its fix is a read grant.
- `prettier --cache` with no write grant passes with its cache off: it
  checks that `node_modules` is writable, which writes nothing and is no
  violation, then keeps its cache in the sandbox's temp folder.
- To keep prettier's cache, name the file and grant its folder:
  `prettier --cache --cache-location node_modules/.cache/prettier/.prettier-cache`
  with `write: ['node_modules/.cache/prettier/']`.
- `mkdir ~/.cache` refused: a write outside the project is named on a
  failed task, never counted, with a grant per write (`'~/.cache/'`,
  never home itself).
- The remedy is to declare it: `allow: { write: ['dist/'] }`.

**Removing your own output directory**

- `rm -rf dist && vite build` with `write: ['dist/']` and
  `outputs: { files: ['dist/**'] }` works on Linux too.
- How: a directory grant the outputs claim whole (`dist/**`, no
  `!dist/…`) is copied into `.vx/tmp/` as hard links (no bytes copied)
  and mounted as the task's directory.
- After the task, that copy replaces the host's. The host's directory is
  untouched meanwhile, so a concurrent task still reads it and a killed
  run loses nothing.
- `write: ['.']`, a file grant in the task's directory, or no output
  claiming the whole directory: mounted in place. Remove the contents
  instead, `rm -rf dist/*`; a failed task names the grant.

**`bun pm pack` and archives**

- `write: ['.']` for `bun pm pack`: it reads the project whole and writes
  the tarball into it, so the grant is the project itself.

```ts
pack: {
  exec: { command: 'bun pm pack', sandbox: { allow: { read: ['.', '~/.bun'], write: ['.'] } } },
  cache: true,
  inputs: { files: ['src/**', 'package.json', 'CHANGELOG.md'] },
  outputs: { files: ['*.tgz'] },
}
```

- `write: ['x-1.0.0.tgz']`: not the tarball's name. vx makes an empty
  file for a literal grant, and the pack packs it (`package/x-1.0.0.tgz`,
  0 bytes) under a green run.
- The same for any tool that archives or copies its directory. So for a
  task that may list its project (`read: ['.']`, `./**` or above), the
  `fix:` names `'.'` for a top-level file, never the file.
- `bun pm pack --destination dist` with `write: ['dist/']` and
  `outputs: { files: ['dist/*.tgz'] }`: keeps the sources read-only,
  which `'.'` does not.
- `write: ['dist/vx', '~/.bun/install/cache/', '.*.tmp/**']` for
  `bun build --compile --target=bun-linux-arm64`: a target Bun lacks is
  fetched from npm into `<cwd>/.<hash>-00000000.tmp/`, then cached.

**The boundary is the workspace root**

- `../ui/src/index.ts`: a task may not leave its own project, so every
  sibling project and root file is denied.
- Being stopped at that wall is the sandbox working: only denials inside
  the project are reported, as those are the reads that make a key wrong.
- `~/.bun/install/cache` refused: a write past the wall is named beside a
  failed task, never counted, with the directory to grant (a tool rarely
  says where it tried).
- The grant is spelled from the project inside the workspace; under the
  host's temp directory, `$TMPDIR`, the task's own is named instead.
- `'~/.cache/go-build/'`: a refused write under `~/.cache` names the
  tool's own directory there, as does a home kept under the host's temp
  directory.
- A refused write to a dependency's declared outputs gets no grant: that
  task writes them. Run it, without `--exclude-dependencies`, or keep the
  task from rebuilding it (`tsc -p`, not `tsc -b`).
- `read: ['../../tsconfig.base.json']`: a read the wall hid of a path the
  host has is named with the grant, as the tool said only "not found".
- `inputs: { workspaceFiles: ['tsconfig.base.json'] }`: a cached task is
  also told the key entry, since a grant alone leaves an edit there a
  stale hit.
- `'\\!cfg'` for a file named `!cfg`, `'golib/**'` for a directory: how
  that key entry is spelled.
- "does not exist", "could not find", "No rule to make target": on Linux
  a path a failed task's output calls missing, hidden by the wall but on
  the host, is named the same way (a stat is not traced).
- A cached task is then told the key entry too: `inputs.files` in the
  project, `inputs.workspaceFiles` elsewhere in the workspace.
- `inputs: { workspaceFiles: ['.oxlintrc.json'] }` beside `read: ['.']`:
  a cached task whose key holds a file no grant reaches fails before it
  runs, naming the read to grant.
- Why: oxlint without its config passes on defaults, and a build missing
  a root `tsconfig.base.json` emits other code; either saved under a key
  that says it saw the file.
- A hidden file the key does not hold stays silent on a pass: tools
  probe many paths.
- To reach a workspace path outside the project (a shared fixture),
  declare it. A path outside the workspace is not walled (see Baseline).

**git in a sandboxed task**

- `read: ['.', '../../.git']` from a project two levels down: git reads
  the repository only when granted. `.git` is a wall, so `read: ['.']` in
  a root project leaves it out too.
- On Linux a task whose grants name a `.git` gets
  `GIT_DISCOVERY_ACROSS_FILESYSTEM=1` (a value the task sets wins), as
  each sandbox mount stops git's discovery.
- `git rev-parse`, `git log` then answer as outside. `git status` calls a
  file the task may not read deleted, so `git describe --dirty` says
  dirty on a clean tree.
- `read: ['../..', '../../.git']`: a version stamp needs the whole
  workspace readable.
- `inputs: { workspaceRuntime: ['git describe --always --dirty'] }`: git's
  `HEAD` is in no key, so such a task is uncached or keys it like this.
- `fatal: not a git repository`: the task fails with a hint naming the
  `.git` grant, or saying it lies outside the workspace, walled on
  purpose.

**A root found by a hidden file**

- `next build`: a tool that finds the workspace root by a lockfile above
  takes the project for the root when the lockfile is hidden, and writes
  above-root files under the project.
- `node_modules/.bun/next@…` written under the app: a refused write into
  installed package files, or their store (`node_modules/.bun`, `.pnpm`),
  that a directory above also holds gets no write grant.
- `read: ['../../bun.lock']`: the fix names the lockfiles above as reads,
  and as `inputs.workspaceFiles` for a cached task, with a note on why.
- Granting the write instead let the build pass and cache while its
  server could not start.

**Violations fail the task**

- An undeclared read, or a refused write, fails the task, and a failed
  task is never cached.
- On Linux a denied read is reported by vx's own observer (Linux 5.5),
  or by `strace` where it is on PATH and may attach.
- Elsewhere the read is still denied, the task fails only if the command
  does, and the run says once that reads go unreported.
- `.bashrc`, `.zshrc`, `.gitconfig`, `.mcp.json`, `.vscode/`, `.idea/`,
  `.git/hooks`, `.git/config`: inside a write grant these stay read-only,
  three levels below the workspace root, ignored by git or not.

**Paths vx cannot sandbox**

- `~/[old]/repo`, `~/w*s/repo`: a project under a path holding `[`, `]`,
  `*` or `?` is refused for a sandboxed task: the runtime reads it as a
  pattern. Rename the directory or drop `exec.sandbox`.
- On Linux, a project under a directory holding a backslash: refused,
  as the runtime cannot mount it.
- A project under a directory holding a line break: refused on every
  platform, since a refused touch is reported one line per record.
- `/dev/shm/ws`: on Linux a project under `/dev` is refused (the sandbox
  mounts a fresh `/dev`), and `vx info` calls the sandbox unavailable.

**Nesting**

- macOS cannot nest: `sandbox_apply` is refused in a sandboxed process,
  so a task that itself sandboxes something cannot be sandboxed there.
- `weakerWhenNested: true`: on Linux where a fresh `/proc` cannot be
  mounted (an unprivileged container, an agent's sandbox around vx), set
  it on every sandboxed task. The task sees the host's `/proc`.
- A task under vx's own sandbox cannot start a sandbox: it refuses
  nested user namespaces.

</div>
</details>

## Group tasks (no `exec`)

A task with no `exec` and a `dependsOn` is a group: running it runs its
dependencies, and nothing else.

```ts
// `vx run ci`  →  runs format-check + lint + test in the cwd project
ci: {
  description: 'format-check + lint + test (CI gate)',
  dependsOn: ['format-check', 'lint', 'test'],
}
```

| Write                                | Means                                      |
| ------------------------------------ | ------------------------------------------ |
| `dependsOn: ['lint', 'test']`        | runs `lint` and `test`                     |
| `dependsOn: ['^build']`              | runs `build` in every workspace dependency |
| `dependsOn: []`                      | runs nothing; exists to be named           |
| `inputs: { files: ['fixtures/**'] }` | a keyed group: a key for dependants        |

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

**Plain groups.**

- A group spawns nothing, reads and writes no files, and reads and writes
  no cache.
- `dependsOn: []`: an explicit no-op group. A dependant's `^build` or
  `vx run build --all` names it, and it runs nothing.
- `dependsOn: ['^build']` as `install`: `vx run install --all` fans out to
  `build` in every workspace dependency.

  ```ts
  install: {
    description: 'build everything in workspace dependency order',
    dependsOn: ['^build'],
  }
  ```

- A project with no `build` gets a keyed one (see
  [`TaskConfig`](#taskconfig)). A bare `vx run build` does not select it.

**Keyed groups.**

- `fixtures: { inputs: { files: ['fixtures/**'] } }`: a group with
  `inputs` is a key. Nothing runs for it.
- A task that depends on a keyed group folds its key, so an edit to those
  inputs re-runs the dependant, and `--affected` reaches it.
- A keyed group needs no `dependsOn`. It spawns nothing, writes no cache
  entry, and the run summary does not count it.
- `@vzn/vx-migrate` writes keyed groups for the shared input sets of a
  repo it converts.

  ```ts
  // `test` re-runs when a file under fixtures/ changes; nothing spawns for it
  fixtures: { inputs: { files: ['fixtures/**'] } },
  test: { exec: { command: 'bun test' }, dependsOn: ['fixtures'], cache: true /* … */ },
  ```

**In a run.**

- `vx run ci --exclude-dependencies` keeps the group's edges: it runs
  `ci`'s members without their own dependencies.
- `--exclude-dependencies=lint.oxfmt` drops a member it names, like any
  edge.
- "3 tasks, 2 cached": the run summary counts no group, so "3 of 4
  cached" never counts one that ran nothing.
- A group is not recorded in the `runs` table, so runtime queries do not
  see it.
- A group renders no framed block in the live output.
- A group still gives a stable hash to a dependant whose `inputs.tasks`
  includes it, so any change beneath the group cascades.
- That hash is rolled up from the group's upstream outcomes: sorted,
  joined, hashed.

**Refused by the loader.**

- `lint: {}`: no `exec`, no `dependsOn` and no `inputs` is a literal
  no-op.
- `ci: { dependsOn: ['lint'], cache: true }`: a group takes no `cache`,
  since it writes nothing.

</div>
</details>

## Workspace config (`.vx/workspace.ts`)

The one file that marks the workspace root. It holds the settings every run uses, the plugins and the pipelines.

```ts
import { defineWorkspace } from '@vzn/vx/config'

export default defineWorkspace({
  baseBranch: 'main',
  run: { concurrency: 8, timeout: '10m' },
  cache: { policy: 'local:rw,remote:r' },
  plugins: [],
})
```

| Write                                  | Means                               |
| -------------------------------------- | ----------------------------------- |
| `run: { timeout: '10m' }` in this file | a time limit for every task         |
| `VX_RUN_TIMEOUT=5m` in the shell       | the same, and it beats this file    |
| `vx run --timeout 2m`                  | the same, and it beats the variable |
| `exec: { timeout: '1m' }` on a task    | beats all three, for that task      |

Default: every setting has a built-in value, and no plugin runs.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `.vx/workspace.mts`: also `.js`, `.mjs`, `.cts` and `.cjs`. The directory that holds `.vx` is the workspace root.
- `.vx/projects.lock` is the lock. `.vx/cache` holds this machine's state: the cache and the workspace id.
- `.vx/tmp` is where a restore stages files.
- `.vx/.gitignore` says `/cache` and `/tmp`: git ignores only those two.
- `VX_RUN_TIMEOUT=5m vx run --timeout 2m` runs with `2m`. A variable its flag beats is not read, so a bad value there is not refused.
- `exec.timeout`, `exec.retries` and `inputs.stability` on a task beat the flag, the variable and this file.
- `VX_INPUTS_STABILITY_STRATEGY=mutable` is the one exception: the input-stability variables override every task for the run.
- `'500ms'`, `'30s'`, `'10m'`, `'2h'`, `'30d'`: a duration carries its unit. A bare `30000` is refused, naming the forms with units.
- `'10GB'`: a size carries its unit too.
- `VX_DEBUG_TIMING=1`: `debug.*`, `config.workerTimeout` and `run.outputLogs` are read before this file loads, so they have a variable (and a flag) only.
- `outputs: { clean: false }`: only `outputs.clean` and `inputs.stability.strategy` reach a cache key. They key a task as if it declared the value it runs under.
- `vx info` lists every setting not at its default, and where it came from.

</div>
</details>

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every setting in one file</span></summary>
<div class="vx-deeper-body">

```ts
import { defineWorkspace } from '@vzn/vx/config'
import { otel } from '@vzn/vx-otel'

export default defineWorkspace({
  baseBranch: 'main',
  run: {
    concurrency: 8,
    timeout: '10m',
    schedule: 'most-work',
    failFast: false,
    killGrace: '10s',
    pluginTimeout: '3s',
    logs: { captureHead: '8MiB', captureTail: '8MiB', failedHead: '8KiB', failedTail: '56KiB' },
    secrets: { minLength: 8 },
    rules: {
      exclusiveOutputs: true,
      dependencies: [{ from: 'tag:lib', deny: ['tag:app'] }],
    },
  },
  cache: {
    dir: 'build/.vx-cache',
    download: 'all',
    policy: 'local:rw,remote:r',
    upload: { failures: 'ci' },
    store: { embeddings: '32KiB', decompress: true },
    concurrency: { download: 64, upload: 64, restore: 16 },
  },
  inputs: { stability: { strategy: 'immutable', severity: 'warn' } },
  outputs: { clean: true },
  lock: { reviewFiles: true },
  watch: { poll: false, debounce: '150ms', pollInterval: '250ms' },
  history: { retention: '60d' },
  plugins: [otel()],
})
```

</div>
</details>

### Settings

Each setting has one path, and its variable and flag come from it: `run.timeout` is `VX_RUN_TIMEOUT` and `vx run --timeout`.

The settings come in groups:

| Group                    | Type                                                       | Default             | What it holds                                                                                                       |
| ------------------------ | ---------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `run`                    | `RunSettings`                                              | `{}`                | How tasks run: how many at once, time limits, retries, logs, secrets and graph rules (`{ concurrency: 4 }`).        |
| `run.logs`               | `RunLogs`                                                  | `{}`                | How much of each task's output vx keeps, for the cache and for failures (`{ failedTail: '1MiB' }`).                 |
| `run.secrets`            | `{ minLength?: number }`                                   | `{}`                | How vx hides secret values in output: `{ minLength: 8 }`.                                                           |
| `run.rules`              | `WorkspaceRules`                                           | `{}`: every rule on | Checks `vx lock` runs on the task graph; each is on unless set to `false` (`{ exclusiveOutputs: false }`).          |
| `run.rules.dependencies` | `DependencyRule[]`                                         | `[]`                | Which projects may depend on which: `[{ from: 'tag:lib', deny: ['tag:app'] }]` stops a library using an app. Below. |
| `cache.concurrency`      | `{ download?: number; upload?: number; restore?: number }` | `{}`                | How many cache transfers run at once: `{ upload: 4 }`.                                                              |
| `cache.store`            | `{ embeddings?: false \| string; decompress?: boolean }`   | `{}`                | How the local cache keeps entries on disk: `{ decompress: true }`.                                                  |
| `cache.upload`           | `{ failures?: 'ci' \| 'local' \| 'always' }`               | `{}`                | What the remote cache keeps beyond hits: `{ failures: 'always' }`.                                                  |
| `history`                | `HistorySettings`                                          | `{}`                | How long vx keeps run history: `{ retention: '30d' }`.                                                              |
| `lock`                   | `LockSettings`                                             | `{}`                | What `vx lock` writes beside the lock: `{ reviewFiles: false }`.                                                    |
| `plugins`                | `Plugin[]`                                                 | `[]`                | The plugins this workspace uses, in order: `[bun()]`. Below.                                                        |
| `pipelines`              | `Record<string, Pipeline>`                                 | `{}`                | Named runs for `vx pipeline <name>`: `{ pr: { tasks: ['test'] } }`. See Pipelines.                                  |

<!-- settings table: generated by tests/settings.test.ts -->

| Setting                                  | Variable                         | Flag                                  | Value                                                                   | Default                                                                       | What it does                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | -------------------------------- | ------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseBranch`                             | `VX_BASE_BRANCH`                 | —                                     | a non-blank string                                                      | `origin/HEAD`'s branch, else `'main'`, else `'master'`                        | The default branch: a run on it has no cache scope and a bare `--affected` no base; elsewhere both use the merge base with `origin/<baseBranch>`. Named alone: `main`, not `origin/main`.                                                                                           |
| `affectedBase` (variable only)           | `VX_AFFECTED_BASE`               | —                                     | a non-blank string                                                      | a plugin's base commit, else the merge base with `baseBranch`                 | The commit a bare `--affected` compares with, on the base branch too. `--affected=<base>` beats it; it beats a plugin's base commit. Env only: a committed base would be stale on the next push.                                                                                    |
| `run.concurrency`                        | `VX_RUN_CONCURRENCY`             | `vx run --concurrency`                | a positive integer, or a share of the cores like '50%'                  | the cores this process may use                                                | Tasks at once: a positive integer, or a share of the cores (`'50%'`).                                                                                                                                                                                                               |
| `run.schedule`                           | `VX_RUN_SCHEDULE`                | `vx run --schedule`                   | one of 'most-work', 'critical-path', 'direct-dependents', 'ready-order' | `'most-work'`                                                                 | Which ready task starts first when there are more than workers.                                                                                                                                                                                                                     |
| `run.branch` (variable or flag only)     | `VX_RUN_BRANCH`                  | `vx run --branch`                     | a non-blank string                                                      | git's branch, then the CI provider's                                          | The branch a run records in its history and forecasts from. Flag and env only: a committed branch would be wrong on every other branch.                                                                                                                                             |
| `run.timeout`                            | `VX_RUN_TIMEOUT`                 | `vx run --timeout`                    | a duration like '500ms', '30s' or '5m', at most 24 days                 | none                                                                          | A task's time limit, for tasks without their own `exec.timeout` (`'30m'`). A task's own `exec.timeout` beats it.                                                                                                                                                                    |
| `run.retries`                            | `VX_RUN_RETRIES`                 | `vx run --retries`                    | a non-negative integer                                                  | `0`                                                                           | Re-runs of a failed task, for tasks without their own `exec.retries`. A task's own `exec.retries` beats it.                                                                                                                                                                         |
| `run.failFast`                           | `VX_RUN_FAIL_FAST`               | `vx run --fail-fast`                  | true or false                                                           | `false`                                                                       | Stop the run at the first failure, killing the tasks still running; off, a failure skips only its dependents.                                                                                                                                                                       |
| `run.outputLogs` (variable or flag only) | `VX_RUN_OUTPUT_LOGS`             | `vx run --output-logs`                | one of 'full', 'errors-only', 'hash-only', 'none'                       | `'errors-only'` on CI, else what the run selects                              | Which task output the run prints. Chosen before the workspace loads, so flag and env only.                                                                                                                                                                                          |
| `run.killGrace`                          | `VX_RUN_KILL_GRACE`              | —                                     | a duration like '500ms', '30s' or '5m', at most 24 days                 | `'2s'`                                                                        | How long a task, server or plugin's process may take to exit after SIGTERM (a timeout, a stop, the run's end) before vx sends SIGKILL.                                                                                                                                              |
| `run.pluginTimeout`                      | `VX_RUN_PLUGIN_TIMEOUT`          | —                                     | a duration like '500ms', '30s' or '5m', at most 24 days                 | `'3s'`                                                                        | How long one plugin's end-of-run flush or teardown may take before the run ends without it, and how long a remote cache download may wait for its answer or between its bytes before it is a miss; `'0ms'` waits for no flush or teardown not already done, and bounds no download. |
| `run.logs.captureHead`                   | `VX_RUN_LOGS_CAPTURE_HEAD`       | —                                     | a size like '32KiB', '8MiB' or '1GiB'                                   | `'8MiB'`                                                                      | The start of a task's output vx keeps for its cache entry and replay; the live stream is never cut. Counted in characters.                                                                                                                                                          |
| `run.logs.captureTail`                   | `VX_RUN_LOGS_CAPTURE_TAIL`       | —                                     | a size like '32KiB', '8MiB' or '1GiB'                                   | `'8MiB'`                                                                      | The end of a task's output vx keeps for its cache entry and replay. Counted in characters.                                                                                                                                                                                          |
| `run.logs.failedHead`                    | `VX_RUN_LOGS_FAILED_HEAD`        | —                                     | a size like '32KiB', '8MiB' or '1GiB'                                   | `'8KiB'`                                                                      | The start of a failed attempt's output vx keeps when it stores that failure. Counted in characters.                                                                                                                                                                                 |
| `run.logs.failedTail`                    | `VX_RUN_LOGS_FAILED_TAIL`        | —                                     | a size like '32KiB', '8MiB' or '1GiB'                                   | `'56KiB'`                                                                     | The end of a failed attempt's output vx keeps when it stores that failure. Counted in characters.                                                                                                                                                                                   |
| `run.secrets.minLength`                  | `VX_RUN_SECRETS_MIN_LENGTH`      | —                                     | an integer ≥ 1                                                          | `6`                                                                           | The shortest secret value vx masks in output; a shorter one (`KEY=1`) would mask every match in every line.                                                                                                                                                                         |
| `run.rules.exclusiveOutputs`             | `VX_RUN_RULES_EXCLUSIVE_OUTPUTS` | —                                     | true or false                                                           | `true`                                                                        | Refuse two tasks whose outputs overlap even when an edge orders them.                                                                                                                                                                                                               |
| `cache.dir`                              | `VX_CACHE_DIR`                   | `vx run --cache-dir`                  | a non-blank string                                                      | `.vx/cache`, with entries in `~/.vx/<id>/cache`                               | Where the cache lives (`'build/.vx-cache'`), relative to the workspace root; named, it holds the whole cache.                                                                                                                                                                       |
| `cache.policy`                           | `VX_CACHE_POLICY`                | `vx run --cache-policy`               | a non-blank string                                                      | every layer reads and writes on CI; off CI the remote is read only            | Which layers a run reads and writes (`'local:rw,remote:r'`); `--no-cache` and `--force` apply on top.                                                                                                                                                                               |
| `cache.scope` (variable only)            | `VX_CACHE_SCOPE`                 | —                                     | a non-blank string                                                      | the branch's, `<owner>/<repo>:<branch>`, with a remote cache off `baseBranch` | The branch scope plugin entries are keyed under (`'vznjs/vx:feat-x'`); task keys never carry it. Empty: no scope.                                                                                                                                                                   |
| `cache.concurrency.download`             | `VX_CACHE_CONCURRENCY_DOWNLOAD`  | `vx run --cache-concurrency-download` | an integer ≥ 1                                                          | min(96, max(cores × 3, 64))                                                   | Remote downloads at once.                                                                                                                                                                                                                                                           |
| `cache.concurrency.upload`               | `VX_CACHE_CONCURRENCY_UPLOAD`    | `vx run --cache-concurrency-upload`   | an integer ≥ 1                                                          | min(96, max(cores × 3, 64))                                                   | Uploads at once, per remote.                                                                                                                                                                                                                                                        |
| `cache.concurrency.restore`              | `VX_CACHE_CONCURRENCY_RESTORE`   | `vx run --cache-concurrency-restore`  | an integer ≥ 1                                                          | twice `run.concurrency`                                                       | Local hits restoring outputs at once.                                                                                                                                                                                                                                               |
| `cache.download`                         | `VX_CACHE_DOWNLOAD`              | `vx run --cache-download`             | one of 'all', 'toplevel', 'none'                                        | `'all'`                                                                       | Which remote hits land on disk: every one, only the requested tasks, or none.                                                                                                                                                                                                       |
| `inputs.stability.strategy`              | `VX_INPUTS_STABILITY_STRATEGY`   | —                                     | one of 'immutable', 'mutable', 'unchecked'                              | `'immutable'`                                                                 | What a write to an input during the command means for the save, for tasks without their own. A task's own `inputs.stability.strategy` beats it.                                                                                                                                     |
| `inputs.stability.severity`              | `VX_INPUTS_STABILITY_SEVERITY`   | —                                     | one of 'warn', 'error'                                                  | `'warn'`                                                                      | Whether a skipped save warns or fails the task, for tasks without their own. A task's own `inputs.stability.severity` beats it.                                                                                                                                                     |
| `outputs.clean`                          | —                                | —                                     | true or false                                                           | `true`                                                                        | Remove a task's declared outputs before it runs on a miss, for tasks without their own. A task's own `outputs.clean` beats it.                                                                                                                                                      |
| `cache.store.embeddings`                 | `VX_CACHE_STORE_EMBEDDINGS`      | —                                     | false, or a size like '32KiB'                                           | `'32KiB'`                                                                     | Keep an entry up to this size inside the cache index, one zstd tar, rather than as files; `false` keeps none.                                                                                                                                                                       |
| `cache.store.decompress`                 | `VX_CACHE_STORE_DECOMPRESS`      | —                                     | true or false                                                           | `true`                                                                        | Keep a larger entry as its plain files, which a hit copies or clones out; off, as one `.tar.zst`.                                                                                                                                                                                   |
| `cache.artifactCeiling`                  | `VX_CACHE_ARTIFACT_CEILING`      | —                                     | a size like '32KiB', '8MiB' or '1GiB'                                   | `'1GiB'`                                                                      | The largest entry, unpacked, a remote stores or a hit unpacks; a larger one stays on this machine. A remote hit past it is a miss, so every machine sharing a remote needs the same value.                                                                                          |
| `cache.upload.failures`                  | —                                | —                                     | one of 'ci', 'local', 'always'                                          | `'ci'`                                                                        | Where a failed task's log and outputs are kept in the remote: CI runs, local runs, or both.                                                                                                                                                                                         |
| `history.retention`                      | `VX_HISTORY_RETENTION`           | —                                     | a duration like '45s', '12h' or '30d'                                   | `'30d'`                                                                       | `vx cache clean` drops run history and hash memos older than this.                                                                                                                                                                                                                  |
| `lock.reviewFiles`                       | `VX_LOCK_REVIEW_FILES`           | —                                     | true or false                                                           | `true`                                                                        | `vx lock` writes each project's resolved config, pretty, to `vx.lock.json` beside its `vx.config`, for review; vx never reads it.                                                                                                                                                   |
| `watch.poll`                             | `VX_WATCH_POLL`                  | `vx watch --poll`                     | true or false                                                           | `false`                                                                       | Poll for changes from the start instead of the OS watcher.                                                                                                                                                                                                                          |
| `watch.debounce`                         | `VX_WATCH_DEBOUNCE`              | —                                     | a duration like '500ms', '30s' or '5m', at most 24 days                 | `'150ms'`                                                                     | `vx watch` waits this long after the last change before it re-runs (at most 1 s after the first).                                                                                                                                                                                   |
| `watch.pollInterval`                     | `VX_WATCH_POLL_INTERVAL`         | —                                     | a duration like '500ms', '30s' or '5m', at most 24 days                 | `'250ms'`                                                                     | How often a polling `vx watch` re-walks a watched tree.                                                                                                                                                                                                                             |
| `config.workerTimeout` (variable only)   | `VX_CONFIG_WORKER_TIMEOUT`       | —                                     | a duration like '500ms', '30s' or '5m', at most 24 days                 | `'30s'`                                                                       | How long one config evaluation may await; at 5 s vx names the config still evaluating. A synchronous loop on the first load holds the thread the deadline needs, so it hangs until killed.                                                                                          |
| `debug.timing` (variable only)           | `VX_DEBUG_TIMING`                | —                                     | true or false                                                           | `false`                                                                       | Print the run's stage timings to stderr.                                                                                                                                                                                                                                            |
| `debug.watch` (variable only)            | `VX_DEBUG_WATCH`                 | —                                     | true or false                                                           | `false`                                                                       | `vx watch`: say on stderr each time the loop arms, with the projects it watches.                                                                                                                                                                                                    |
| `debug.dumpable` (variable only)         | `VX_DEBUG_DUMPABLE`              | —                                     | true or false                                                           | `false`                                                                       | Linux: keep vx dumpable, so strace or a debugger can read its memory and `/proc/<pid>/fd`, and an unsandboxed task its env.                                                                                                                                                         |
| `debug.strace` (variable only)           | `VX_DEBUG_STRACE`                | —                                     | true or false                                                           | `false`                                                                       | Linux: report a sandboxed task's refused reads with strace, not vx's own observer.                                                                                                                                                                                                  |

<!-- /settings table -->

```ts
interface WorkspaceConfig {
  baseBranch?: string
  run?: RunSettings
  inputs?: { stability?: InputStability }
  outputs?: { clean?: boolean }
  cache?: CacheSettings
  lock?: LockSettings
  watch?: { poll?: boolean; debounce?: Duration; pollInterval?: Duration }
  history?: { retention?: Duration } // run history `vx cache clean` keeps; '30d'
  /** Named runs for `vx pipeline <name>`; none runs by default. */
  pipelines?: Record<string, Pipeline>
  /** Run-level plugins (cache / executor / telemetry capabilities). */
  plugins?: readonly (Plugin | undefined | null | false)[]
}

interface RunSettings {
  concurrency?: number | `${number}%`
  schedule?: 'most-work' | 'critical-path' | 'direct-dependents' | 'ready-order'
  timeout?: Duration
  retries?: number
  failFast?: boolean
  /** SIGTERM to SIGKILL, for a task, server or plugin process. Omitted → '2s'. */
  killGrace?: Duration
  /** One plugin's end-of-run flush or teardown, and a remote download's wait for its answer or bytes; '0ms' waits for no flush and bounds no download. Omitted → '3s'. */
  pluginTimeout?: Duration
  /** Output vx keeps, in characters (a size: '8MiB'). */
  logs?: { captureHead?: string; captureTail?: string; failedHead?: string; failedTail?: string } // '8MiB' '8MiB' '8KiB' '56KiB'
  /** The shortest secret value vx masks in output. Omitted → 6. */
  secrets?: { minLength?: number }
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
  upload?: { failures?: 'ci' | 'local' | 'always' }
  store?: { embeddings?: false | string; decompress?: boolean }
  artifactCeiling?: string
  concurrency?: { download?: number; upload?: number; restore?: number }
}
```

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">How tasks run: `run`</span></summary>
<div class="vx-deeper-body">

- `run: { concurrency: '50%' }` on eight cores is 4, never below 1. Over `'100%'` is allowed for work that waits on I/O.
- `run: { timeout: '30m' }` applies to tasks with no `exec.timeout`; a task's own beats it, its flag and its variable.
- `run.timeout` reached: vx sends SIGTERM to the task's process group and reports it `failed`.
- `run.timeout` is a safety net, never in a cache key: a timed-out task fails and is never cached.
- `run: { retries: 2 }` applies to tasks with no `exec.retries`; a task's own beats it, `retries: 0` included.
- `run.retries` never re-runs a persistent task.
- `run: { failFast: true }`: the first failure kills the tasks still running and stops the run (`cli.md` § Failure propagation).
- `run.failFast` off (the default): a failure skips only its dependents.
- `run: { schedule: 'most-work' }` (the default): when more tasks are ready than workers, the one the most tasks wait on, at any depth, starts first.
- `'critical-path'`: the head of the longest chain of tasks below it starts first.
- `'direct-dependents'`: the one the most tasks wait on directly starts first.
- `'ready-order'`: the one that became ready first starts first.
- Each strategy loses some graph shape the others win. Only the strategy named is computed; any other value is refused.
- `plugins: [history()]`: a `schedule` plugin's weights (`@vzn/vx-history`) still sort first, and the strategy breaks their ties.
- `run.schedule` is never in a cache key.

</div>
</details>

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Where the cache lives: `cache.dir`</span></summary>
<div class="vx-deeper-body">

- `cache.dir` unset: the index and history stay in `.vx/cache`, and entries go to the repository's shared store, `~/.vx/<id>/cache`.
- That shared store is seen by every other checkout of the repository, so each one hits the others' entries (`caching.md`).
- `cache: { dir: 'build/.vx-cache' }`: the directory holds the whole cache, shared with no other workspace.
- `--cache-dir` beats `VX_CACHE_DIR`, which beats `cache.dir`.
- `'build/.vx-cache'` is from the workspace root, `'~/vx-cache'` from the home directory, and `'/var/vx'` is used as-is.
- `'~'` alone is refused: the home directory is not a cache.
- `vx run`, `vx cache clean` and every other reader resolve the path the same way.
- `''`, `'.'`, `'packages'`, `'..'` or `'/'` is refused before anything is written. A cache's `*` `.gitignore` would hide your sources from git and the keys.
- That is: a first index is refused in a directory holding a `package.json`, `pnpm-workspace.yaml`, `vx.config.*` or `.vx/workspace.*`.
- It is refused, too, where a subdirectory holds one, and in a directory that holds the workspace.
- `.vx/cache` linked to `~` or `..` is refused on every open, index or not: a cache that resolves to the home directory, `/`, or a directory holding the workspace or a `.git`.
- `--cache-dir pkg/dist/cache` with an output `dist/**` is refused before any task, naming the task: the clean would delete the cache.
- That rule covers `outputs.files` and `outputs.workspaceFiles`. With `clean: false`, each save would pack the cache into its own entry.
- `'!dist/cache/**'` in that task's outputs takes the directory back and keeps the run.
- A directory other than `.vx/cache` gets a `*` `.gitignore`. The default is ignored by `.vx/.gitignore` instead, written when missing and never edited.
- No run evicts anything. `vx cache clean --older-than <d> --max-size <s>` is the one cleaner ([cli.md](cli.md#vx-cache-clean)): run it on a schedule or on CI.

</div>
</details>

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">What the cache reads and writes: `cache.*`</span></summary>
<div class="vx-deeper-body">

- `cache: { policy: 'local:rw,remote:r' }`: which layers a run reads and writes. A layer the spec leaves out stays on, but off CI a remote it does not name is read only (`cli.md` § Cache control).
- `cache.policy` unset on CI: every layer reads and writes.
- `cache.policy` unset off CI: `vx run` reads the remote and does not write it. A key holds only declared inputs, so a laptop's write could replay on CI.
- Off CI means no CI variable is on: `CI`, or a provider's own such as `GITHUB_ACTIONS` or `JENKINS_URL` (`cli.md` § Output format › Colors lists them).
- `'remote:rw'` names the remote, so it writes it, off CI too.
- `--cache-policy` beats `VX_CACHE_POLICY`, which beats `cache.policy`: the one that wins is the whole spec, and the others add nothing. `--no-cache` and `--force` still apply on top.
- `'remote:x'` is refused before any task, naming `cache.policy`.
- The policy alone decides whether a layer is written; the cache scope never does.
- Whatever the policy, a lookup asks the local cache first, then each remote in the order the plugins declare them.
- `cache: { download: 'toplevel' }`: only the requested tasks' remote hits land on this machine. `'all'` (the default) lands every one, `'none'` none (`cli.md` § `--cache-download`).
- `cache: { concurrency: { download: 64, upload: 64 } }`: remote downloads at once, and uploads at once per remote.
- Their default is min(96, max(cores × 3, 64)): a transfer waits on the network, not a core.
- `cache: { concurrency: { restore: 16 } }`: local hits writing their outputs at once. The default is twice `run.concurrency`.
- `cache: { store: { embeddings: '32KiB' } }` (the default): an entry up to this size lives inside the cache index, one row and no file. `false` keeps every entry as files.
- `cache: { store: { decompress: true } }` (the default): a larger entry is its plain files under `<hash>.tree/`, which a hit copies or clones out with no decode.
- `decompress: false`: a larger entry is one `<hash>.tar.zst`. A remote always gets the `.tar.zst`.
- `cache: { artifactCeiling: '1GiB' }` (the default): the largest entry, unpacked, a remote stores or a hit unpacks.
- An entry past `artifactCeiling` stays cached on this machine and is not uploaded; the run stays green and says so once.
- A remote hit past `artifactCeiling` is a miss, so every machine sharing a remote sets the same value. It bounds what a bad remote entry can make a restore write.
- `cache: { upload: { failures: 'ci' } }` (the default): CI runs keep a failed task's log and the files its outputs left in the remote. `'local'` keeps them off CI, `'always'` both.
- Only a run whose policy writes a remote keeps any, and it always keeps the log of a task that saved no entry.
- Outputs past 8 MiB stream to the remote through a file under `.vx/tmp/`, never whole in memory. `ctx.cache.getRun` reads them (`modules/orchestrator.md` § Run report and run bytes).
- No `cache.*` setting is in a cache key.

</div>
</details>

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Branches: `baseBranch` and `cache.scope`</span></summary>
<div class="vx-deeper-body">

- `baseBranch: 'develop'`: the repository's default branch, by name. `VX_BASE_BRANCH` beats it.
- `baseBranch` unset: `origin/HEAD`'s branch, then `main`, then `master`.
- On `baseBranch`, a run has no cache scope and a bare `--affected` has no default: run `--all`, or pass the last good commit, `--affected=<sha>`.
- Off it, a bare `--affected` compares with the merge base of HEAD and `origin/<baseBranch>`, or that branch's tip when they share no history.
- In a clone with no remote, the local `<baseBranch>` stands in for `origin/<baseBranch>`.
- A plugin's `config` stage may set `baseBranch`: `nx()` sets it from nx.json's `defaultBase`.
- A base commit is a plugin's to name (`setBranch({ base })`), and it beats `baseBranch`. `github()` names a pull request's base.
- `nx()` names `NX_BASE`. `turbo()` names `TURBO_SCM_BASE`, else on GitHub Actions `GITHUB_BASE_REF` or the push event's `before`.
- `VX_AFFECTED_BASE` beats a plugin's base, and `--affected=<base>` beats them all. Core itself reads no CI variable for the base.
- `baseBranch` is in no cache key.
- `VX_CACHE_SCOPE=vznjs/vx:feat-x`: the branch scope plugins key their own entries under (`ctx.cache`, run records). It is `<owner>/<repo>:<branch>`: letters, digits, `. _ - / @ :`, at most 128.
- Task keys never carry the scope: every remote sees the plain key, and which branch a read may see is the remote's call (`turboCache()`'s `scope`, `modules/cache.md`).
- The local cache never knows a scope.
- `cache.scope` is a variable only, no config key or flag. A plugin names it in its `config` stage (`ctx.setBranch({ scope })`); `github()` does on Actions.
- With no plugin naming it, a checkout with a cache plugin derives the scope from `.git` with no network: the branch it tracks on that remote's repository, else its own on `origin`'s.
- No scope on `baseBranch` or a detached HEAD.
- `VX_CACHE_SCOPE` beats both; `VX_CACHE_SCOPE=` (empty) turns it off.
- The scope never decides whether a run writes (`cache.policy` does), is not a security boundary (`security.md` § Cache poisoning) and is in no cache key.

</div>
</details>

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Task defaults: `inputs.stability`</span></summary>
<div class="vx-deeper-body">

- `inputs: { stability: { strategy: 'mutable' } }`: the `inputs.stability` of every task that does not set its own, same shape (`{ strategy, severity }`).
- `VX_INPUTS_STABILITY_STRATEGY` and `VX_INPUTS_STABILITY_SEVERITY` still override every task for the run.
- A `strategy` other than `'immutable'` keys a task without its own as if it declared it.

</div>
</details>

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Graph checks: `run.rules`</span></summary>
<div class="vx-deeper-body">

- `rules: { exclusiveOutputs: false }`: each rule is on unless set to `false`. Off allows a shape vx runs correctly but more slowly.
- `vx lock` and `vx lock --check` check the rules; no run does. No rule is in a cache key.
- `rules: { exclusiveOutputs: 'no' }` or a rule vx does not know is refused.
- `exclusiveOutputs`: two tasks whose declared outputs overlap are refused, even when a `dependsOn` edge orders them. The refusal:

  ```text
  <a> and <b> both declare the output "<glob>" … Give each task its own output path, or set run.rules.exclusiveOutputs: false in .vx/workspace.ts to let a dependant add to its upstream's outputs.
  ```

- `exclusiveOutputs: false`: the dependant adds to its upstream's tree (`caching.md` § Additive outputs). Two overlapping tasks with no edge are refused either way.
- `dependencies: [{ from: 'tag:lib', deny: ['tag:app'] }]`: which workspace projects a project may depend on. Each rule is `{ from, allow?, deny? }`.
- `dependencies` reads each project's direct dependencies: its `package.json` buckets and its tasks' cross-project `dependsOn`.
- `'tag:lib'` selects projects carrying the tag; `'web'` is a project name.
- `'tag:scope:*'`, `'@acme/*'`: `*` matches any characters in either form.
- `'./apps/*'`, `'{apps/web}'`, `'!x'`, `'x...'`, `'...x'`, `'x[main]'` or `' web '` is refused, naming the field (`run.rules.dependencies[0].deny[1]`).
- Why: a selector like those matches no project, so a `deny` of it would pass every edge.
- Every rule whose `from` selects a project applies. Each dependency must match an `allow` selector when `allow` is given, and none of `deny`, so a deny beats any allow.
- A project no rule selects is free. An untagged dependency matches no `tag:` selector.
- `{ from: 'tag:lib' }` with neither `allow` nor `deny`, or with `deny: []` and no `allow`, is refused: it checks nothing.
- `allow: []` allows no dependency.
- A broken edge refuses the lock with `VX_E_DEPENDENCY_RULE`, every broken edge on its own line: `lib depends on app, which run.rules.dependencies[0] (from 'tag:lib') denies`.

</div>
</details>

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Inputs over outputs: always checked</span></summary>
<div class="vx-deeper-body">

- `inputs: { files: ['dist/**'] }` beside a same-project `outputs: { files: ['dist/**'] }` is refused by `vx lock`. No setting turns this off.
- The same holds for `inputs.workspaceFiles` matching any task's `outputs.workspaceFiles` or another project's `outputs.files` read from the root.
- It holds for `inputs.files` matching another task's `outputs.workspaceFiles` that land in the project.
- The refusal:

  ```text
  <reader> reads "<glob>" in inputs.<field>, which matches <writer>'s output "<glob>" … Exclude it: add "!<glob>" to <reader>'s inputs.<field>, or depend on <writer> and leave it out of <reader>'s inputs.tasks, so its key hashes those bytes instead.
  ```

- A reader that already depends on the writer is told so, and only to leave it out of `inputs.tasks`.
- Why: such a key reads what the producer writes this run, so vx cannot know it before the producer ran.
- So it is not probed, prefetched or restored ahead of the schedule (`caching.md` § Local restore tier).
- The upstream's key already reaches the reader through `dependsOn`.
- `'!dist/**'` in the reader's inputs, taking the whole output back, clears it. An output the reader's `!` entries take back no longer holds its key back either.
- `'**/*'` beside a gitignored `**/dist/**` passes and keys up front: a key reads only what git lists.
- `'dist/**'` starts in the ignored path: naming it reads it, so the check applies.
- `inputs: { tasks: ['gen'] }` leaving the producer `build` out: a reader may read the outputs of a task in its `dependsOn` closure that its key does not fold.
- A producer folded by a folded task counts as folded.
- Such a key waits for the producer and hashes the bytes it wrote, so a producer rerun with identical output still hits.
- `vx lock` checks all of it; a run reads only the lock.
- Git is asked, never a `.gitignore` read: `git check-ignore` on the output's directory (for `**/dist/**`, `dist/` and a fresh `__vx_probe__/dist/`).
- No tracked or listed file may match the output, so a tracked output is still refused.
- `'*.js'`, a glob no few paths stand for, is refused as before.
- `vx lock` asks git once for every overlapped output. A run asks once beside its git walk, so a rule changed after the lock keys the reader late until the next `vx lock` refuses it.
- Exempt: a task's own outputs, a task with no `cache`, and a group.

</div>
</details>

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Plugins: `plugins`</span></summary>
<div class="vx-deeper-body">

- **`plugins`** hooks, in order: `config`, `discover`, `project`, `graph`, `key`, `fingerprint`, `measures`, `schedule`, `admit`.
- Then `executor`, `cache`, `telemetry`, `output`, `setup`, `teardown`, `commands`.
- `config`: edit the workspace config before anything derives from it.
- `discover`: name directories to make projects beyond the members.
- `plugins: []` or no `plugins`: core applies no plugin. The local executor and the local cache are its floor, so a workspace with none runs and caches here.
- `plugins: [a(), b()]`: order is precedence. Each `executor` is asked in order per task; the first to accept runs it, and what all decline runs locally.
- Every `cache` layer is chained: a lookup walks the local store, then each remote in order. A save reaches them all, the local store last.
- `plugins: [github(), isCI && otel()]`: an `undefined`, `null` or `false` entry is skipped, so a factory that declines needs no filter.
- `project`: inject, remove or rewrite a loaded project's tasks. Core validates them again and hashes them into the key like a hand edit.
- `graph`: edit the task graph's edges.
- `key`: per-task `{ name: value }` material folded into the cache key.
- `fingerprint`: a lockfile keyed per project, or a root file the plugin's stages read (`turbo.json`). `--affected` asks the plugin about it, and `vx watch` re-runs on it.
- `measures`: what the plugin times that is no task, kept as a task's timing.
- `schedule`: task id → priority, merged over the scheduler's baseline.
- `admit`: may this ready task start now, beside what runs here.
- `executor`: return a `TaskExecutor`, where one task's command runs, or decline.
- `cache`: return a cache layer, or decline.
- `telemetry`: observe-only export, such as OTel, the GitHub job summary or a custom sink.
- `output`: return a `Logger` that draws the run in place of vx's own, or decline.
- `setup` and `teardown`: run around the run.
- `commands`: `{ verb: { description, run } }`, asked for a verb core does not know.
- First-party plugins: `@vzn/vx-otel`, `@vzn/vx-ci`, `@vzn/vx-reapi`, `@vzn/vx-lockfile`, `@vzn/vx-history`, `@vzn/vx-migrate`.
- `otel()` with no OTLP endpoint declines every capability and costs nothing: a run with no active plugin is byte-identical to one with none declared.
- Plugins observe, route and execute; they never change what a task is.
- `plugins: [{ name: 'p' }]` is refused: the loader checks each setting by its kind and each plugin for a name and at least one capability, and throws a `UserError` on malformed input.

</div>
</details>

### `pipelines`

A pipeline is a `vx run` saved under a name. `vx pipeline pr` runs it, so each CI job names one and its workflow file holds no flags.

```ts
import { defineWorkspace } from '@vzn/vx/config'

export default defineWorkspace({
  pipelines: {
    pr: { tasks: ['lint', 'test', 'build'], affected: true, failFast: true },
    main: { tasks: ['lint', 'test', 'build', 'release'] },
    fork: { tasks: ['lint', 'test'], affected: true, cachePolicy: 'remote:r' },
  },
})
```

| Write                     | Means                                                 |
| ------------------------- | ----------------------------------------------------- |
| `tasks: ['lint', 'test']` | `lint` and `test` in every project that declares them |
| `tasks: ['web#e2e']`      | `e2e` in the `web` project only                       |
| `affected: true`          | only where a change since the base reaches            |
| `failFast: true`          | the same as `vx run --fail-fast`                      |

Default: no pipelines. `tasks` is the one required key.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `tasks: ['lint']` runs `lint` in every project that declares it, under the flags the pipeline saves.
- `tasks: ['lnit']` is refused by `vx lock`: a task no project declares fails there, not in the CI job. A project's default `build` counts as declared.
- `nightly` below sets every key but `format`, each at a value its flag takes.
- `plan` below shows `format`, which needs `dry: true`: a dry pipeline can print its plan as JSON.

</div>
</details>

```ts
import { defineWorkspace } from '@vzn/vx/config'

export default defineWorkspace({
  pipelines: {
    nightly: {
      tasks: ['test', 'web#e2e'],
      filter: ['./apps/*'],
      affected: false,
      excludeDependencies: ['gen'],
      env: { VX_DTE_RELAY: 'https://relay.example.com' },
      concurrency: '50%',
      schedule: 'critical-path',
      failFast: true,
      retries: 1,
      timeout: '30m',
      branch: 'nightly',
      cachePolicy: 'local:rw,remote:r',
      noCache: false,
      force: true,
      cacheDir: '.vx/cache',
      cacheDownload: 'toplevel',
      cacheConcurrencyDownload: 32,
      cacheConcurrencyUpload: 32,
      cacheConcurrencyRestore: 16,
      outputLogs: 'errors-only',
      verbosity: 1,
      profile: 'nightly.json',
      dry: false,
    },
  },
})
```

```ts
import { defineWorkspace } from '@vzn/vx/config'

export default defineWorkspace({
  pipelines: {
    plan: { tasks: ['build', 'test'], dry: true, format: 'json' },
  },
})
```

```ts
interface Pipeline {
  /** The tasks, in every project that declares each (`'pkg#task'` names one); their order is `dependsOn`'s. */
  tasks: readonly string[]
  /** `--filter`: pnpm-style entry points; what they depend on still runs. */
  filter?: readonly string[]
  /** `--affected`: `true` for the projects a change reaches and their dependents, a ref for a fixed base. */
  affected?: boolean | string
  /** `--exclude-dependencies`: `true` skips every `dependsOn` edge, a list only those names. */
  excludeDependencies?: true | readonly string[]
  /** Set for vx and its plugins (a plugin's switch), never for a task; a variable already set wins. */
  env?: Readonly<Record<string, string>>
  concurrency?: number | `${number}%`
  schedule?: 'most-work' | 'critical-path' | 'direct-dependents' | 'ready-order'
  failFast?: boolean
  retries?: number
  timeout?: Duration
  branch?: string
  cachePolicy?: string
  noCache?: boolean
  force?: boolean
  cacheDir?: string
  cacheDownload?: 'all' | 'toplevel' | 'none'
  cacheConcurrencyDownload?: number
  cacheConcurrencyUpload?: number
  cacheConcurrencyRestore?: number
  outputLogs?: 'full' | 'errors-only' | 'hash-only' | 'none'
  verbosity?: number
  /** `--profile`: `true` writes profile.json, a string names the file. */
  profile?: boolean | string
  /** `--dry`: plan, run nothing. */
  dry?: boolean
  /** `--format`, with `dry`: the plan as `'pretty'` (default) or `'json'`. */
  format?: 'pretty' | 'json'
}
```

#### Every key of `pipelines.*`

Only `tasks` is required. A key left out leaves its flag off, so the
workspace's own setting (or vx's default) applies.

| Key                        | Flag                           | Takes                                                                    | Left out                                              | What it does                                                                                                                                                            |
| -------------------------- | ------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks`                    | (the task names)               | names, or `'pkg#task'`                                                   | required                                              | The tasks to run, in every project that declares each. `dependsOn` orders them.                                                                                         |
| `filter`                   | `--filter`                     | pnpm-style patterns (`['./apps/*']`)                                     | every project                                         | Run only in the projects these select; what they depend on still runs.                                                                                                  |
| `affected`                 | `--affected`                   | `true`, or a git ref                                                     | off                                                   | Run only where a change since the base reaches: changed projects and the tasks that depend on them. `true` takes the base from a CI plugin, else `origin/<baseBranch>`. |
| `excludeDependencies`      | `--exclude-dependencies`       | `true`, or task names                                                    | off                                                   | Skip `dependsOn` edges: `true` all of them, a list only those names.                                                                                                    |
| `env`                      | (none)                         | `{ NAME: 'value' }`                                                      | none                                                  | Variables set for vx and its plugins before they start (a plugin's switch). Tasks never see them. A variable already set wins.                                          |
| `concurrency`              | `--concurrency`                | a number, or `'50%'`                                                     | `run.concurrency`, else the cores                     | Most tasks running at once.                                                                                                                                             |
| `schedule`                 | `--schedule`                   | `'most-work'`, `'critical-path'`, `'direct-dependents'`, `'ready-order'` | `run.schedule`, else `'most-work'`                    | Which ready task starts first when workers are short.                                                                                                                   |
| `failFast`                 | `--fail-fast`                  | `true`                                                                   | `run.failFast`, else off                              | Stop the run at the first failure. Off, a failure skips only its dependents.                                                                                            |
| `retries`                  | `--retries`                    | a number                                                                 | `run.retries`, else `0`                               | Re-runs of a failed task. A task's own `exec.retries` wins.                                                                                                             |
| `timeout`                  | `--timeout`                    | a duration (`'10m'`)                                                     | `run.timeout`, else none                              | Time limit per task. A task's own `exec.timeout` wins.                                                                                                                  |
| `branch`                   | `--branch`                     | a branch name (`'main'`)                                                 | git's branch, then the CI's                           | The branch the run records in its history.                                                                                                                              |
| `cachePolicy`              | `--cache-policy`               | a policy (`'local:rw,remote:r'`)                                         | `cache.policy`, else as `vx run`                      | What each cache layer may read and write.                                                                                                                               |
| `noCache`                  | `--no-cache`                   | `true`                                                                   | off                                                   | No cache reads, no writes.                                                                                                                                              |
| `force`                    | `--force`                      | `true`                                                                   | off                                                   | Run every task again; writes stay on.                                                                                                                                   |
| `cacheDir`                 | `--cache-dir`                  | a path from the workspace root (`'.cache/vx'`)                           | `cache.dir`, else `~/.vx/<id>/cache`                  | Where the local cache lives.                                                                                                                                            |
| `cacheDownload`            | `--cache-download`             | `'all'`, `'toplevel'`, `'none'`                                          | `cache.download`, else `'all'`                        | Which outputs of a remotely run task land on this machine.                                                                                                              |
| `cacheConcurrencyDownload` | `--cache-concurrency-download` | a number (`8`)                                                           | `cache.concurrency.download`                          | Remote downloads at once.                                                                                                                                               |
| `cacheConcurrencyUpload`   | `--cache-concurrency-upload`   | a number (`4`)                                                           | `cache.concurrency.upload`                            | Uploads at once, per remote.                                                                                                                                            |
| `cacheConcurrencyRestore`  | `--cache-concurrency-restore`  | a number (`16`)                                                          | `cache.concurrency.restore`, else twice `concurrency` | Local hits restoring outputs at once.                                                                                                                                   |
| `outputLogs`               | `--output-logs`                | `'full'`, `'errors-only'`, `'hash-only'`, `'none'`                       | `run.outputLogs`, else vx picks                       | How much task output the log shows.                                                                                                                                     |
| `verbosity`                | `--verbosity`                  | `0` or more                                                              | `0`                                                   | `1` adds a table of every task to the log.                                                                                                                              |
| `profile`                  | `--profile`                    | `true`, or a file name                                                   | off                                                   | Write a Chrome trace of the run (`profile.json`). Not with `dry`.                                                                                                       |
| `dry`                      | `--dry`                        | `true`                                                                   | off                                                   | Print the plan; run nothing.                                                                                                                                            |
| `format`                   | `--format`                     | `'pretty'`, `'json'`                                                     | `'pretty'`                                            | With `dry: true`, print the plan as JSON.                                                                                                                               |

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `cachePolicy` is `--cache-policy`: each key but `tasks` and `env` is its `vx run` flag in camelCase, and takes what the flag takes ([cli.md](cli.md)).
- `--all` has no key: a pipeline runs every project, and `filter` or `affected` narrows it.
- `cacheDir: '.vx/cache'`, `profile: 'nightly.json'`: both stand from the workspace root, as `cache.dir` does, wherever `vx pipeline` runs.
- `vx pipeline pr --retries 3` beats `retries`, and so does `VX_RUN_RETRIES`. The key beats `.vx/workspace`'s own setting.
- A typed `--dry` drops a saved `profile` (a dry run writes none). A typed `--profile` drops a saved `dry` and `format`.
- One pipeline sets only one of `dry` and `profile`, and `format` only with `dry: true`.
- A typed `--cache-policy` or `VX_CACHE_POLICY` drops a saved `noCache` and `force`, and a typed `--force` a saved `noCache`.
- Why: a run applies `noCache` and `force` over the policy, so the saved key would beat the typed flag.
- A saved `true` has no typed flag that turns it off. `failFast` yields to `VX_RUN_FAIL_FAST=false`, and `dry` to a typed `--profile`.
- A saved `noCache` or `force` yields to a typed `--cache-policy` or `VX_CACHE_POLICY`.
- A saved `affected` yields only to another base, `--affected=<ref>`. Otherwise edit the pipeline.
- `env: { VX_DTE_RELAY: '…' }` is set before the run's plugins start, for vx and the plugins only: a plugin's on/off switch.
- Every task reads an `env` variable as unset: in its command, its key and its `inputs.runtime` probes.
- A variable already set in the shell beats `env`.
- A plugin reads `env` from its setup on. `.vx/workspace.ts`'s own top level ran before it was set, so a value read there misses it.
- `env` is saved as the keys are: its `VX_CACHE_POLICY` drops no saved `noCache`.
- `env: { VX_RUN_RETRIES: '2' }` beside `retries` is refused: an entry for a key's own setting; drop one.
- `tasks: ['build', 'web#e2e']` takes names as `vx run` does. `'--force'` or `'^build'` is refused when the file loads.
- A refusal names the key. One that names a flag the pipeline saved says which key holds it (`--affected is \`pipelines.pr.affected\``).
- `vx pipeline pr -- --watch` is refused: forwarded args reach one task in one project, and a pipeline is never one.

</div>
</details>

There is no workspace-wide `inputs` and no task defaults. A task reads root files through `inputs.workspaceFiles` and root probes through `inputs.workspaceRuntime`.

To share a task's shape, write it once in TypeScript and import it: see [Presets](#presets).

## Helpers

`defineProject` and `defineWorkspace` return the config you pass. They exist so your editor checks it as you type.

```ts
import { defineProject, defineWorkspace } from '@vzn/vx/config'

// Identity functions; their purpose is type inference.
defineProject<const T extends ProjectConfig>(config: T): T
defineWorkspace<T extends WorkspaceConfig>(config: T): T
```

| Write                                          | Means                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| `export default defineProject({ … })`          | every key checked, and `dependsOn` names checked against your tasks |
| `export default { … } satisfies ProjectConfig` | every key checked, no runtime import, `dependsOn` names not checked |
| `export default { … }`                         | nothing checked until `vx run`                                      |

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `defineProject({ tasks: { ci: { dependsOn: ['lnit'] } } })` is a type error at edit time: TypeScript narrows the literal task names.
- `import { defineProject } from '@vzn/vx/config'` is one runtime import per config file. `src/config.ts` imports nothing, so it is cheap, but it must resolve from the config's directory.
- `satisfies ProjectConfig` is what `vx init` and `@vzn/vx-migrate` write: a `dependsOn` typo there is a plain string.

</div>
</details>

```ts
import type { ProjectConfig, WorkspaceConfig } from '@vzn/vx/config'
export default { tasks: { … } } satisfies ProjectConfig
export default { plugins: [] } satisfies WorkspaceConfig
```

## Full example

One project with a build, tests, a package, a dev server, end-to-end tests, two checks and a group. The comments say why each task looks the way it does.

```ts
import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    // Real cached task with file inputs, env tracking, and outputs.
    build: {
      description: 'bundle the app into dist/',
      // NODE_ENV is a cache input below, so it must reach the child
      // too — the exec env is isolated, not inherited.
      exec: { command: 'vite build', env: { passThrough: ['NODE_ENV'] } },
      dependsOn: ['^build'],
      inputs: {
        files: ['src/**', '!**/*.test.ts', 'vite.config.ts'],
        env: ['NODE_ENV'],
      },
      outputs: { files: ['dist/**'] },
      cache: true,
    },

    // Cached, depends on upstream build; CI is in passThrough only
    // (CI=1 shouldn't bust the cache — it's true on every CI run).
    test: {
      description: 'run unit tests',
      exec: { command: 'bun test', env: { passThrough: ['CI'] } },
      dependsOn: ['build'],
      inputs: { files: ['src/**', 'tests/**'] },
      outputs: { files: [] },
      cache: true,
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
      outputs: { files: ['pkg/*.tgz'] },
      cache: true,
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
      outputs: { files: [] },
      cache: true,
    },
    'format-check': {
      description: 'oxfmt --check',
      exec: { command: 'oxfmt --check .' },
      inputs: { files: ['src/**', '.oxfmtrc.json'] },
      outputs: { files: [] },
      cache: true,
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
        // Playwright removes its output directory: one inside the grant.
        command: 'playwright test --output test-results/run',
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
        // The app playwright's webServer starts: a page edit makes e2e run again.
        files: ['e2e/**', 'src/**', 'playwright.config.ts'],
        runtime: ['playwright --version'],
        workspaceRuntime: ['node -v'],
      },
      outputs: { files: ['test-results/**'] },
      cache: true,
    },
  },
})
```

## Common patterns

### Sharing inputs across tasks

A config is TypeScript, so a list two tasks share is a plain array:

```ts
import { defineProject } from '@vzn/vx/config'

const srcInputs = ['src/**', 'vite.config.ts']

export default defineProject({
  tasks: {
    build: {
      exec: { command: 'vite build' },
      inputs: { files: srcInputs },
      outputs: { files: ['dist/**'] },
      cache: true,
    },
    test: {
      exec: { command: 'bun test' },
      inputs: { files: [...srcInputs, 'tests/**'] },
      outputs: { files: [] },
      cache: true,
    },
  },
})
```

### Presets

A preset is a TypeScript function that returns a `TaskConfig`. `defineProject` checks `dependsOn` names written inline; a preset's are plain strings, so they are not checked.

```ts
// presets/vite-build.ts
import type { TaskConfig } from '@vzn/vx/config'

export function viteBuild(opts?: { config?: string }): TaskConfig {
  return {
    description: 'bundle with Vite',
    exec: { command: opts?.config ? `vite build --config ${opts.config}` : 'vite build' },
    inputs: { files: ['src/**', opts?.config ?? 'vite.config.ts'] },
    outputs: { files: ['dist/**'] },
    cache: true,
  }
}
```

```ts
// packages/app/vx.config.ts
import { defineProject } from '@vzn/vx/config'
import { viteBuild } from '../../presets/vite-build.ts'

export default defineProject({
  tasks: {
    build: viteBuild(),
    test: {
      exec: { command: 'bun test' },
      dependsOn: ['build'],
      inputs: { files: ['src/**'] },
      outputs: { files: [] },
      cache: true,
    },
  },
})
```

Import a preset as `.ts` source, not a build output: see [`architecture.md` § Config-time imports](./architecture.md#config-time-imports--the-bootstrap-problem) for why.

### When to use `inputs.tasks: []`

When a `dependsOn` only orders the tasks, and the upstream's output does not change this task's output. For example, a test that needs a database up first, whose image its own inputs already pin:

```ts
'test:integration': {
  dependsOn: ['db:up'], // docker compose up -d postgres
  exec: { command: 'bun test integration/' },
  inputs: {
    files: ['src/**', 'integration/**', 'compose.yaml'],
    tasks: [],   // db:up only orders; compose.yaml pins what it starts
  },
  outputs: { files: [] },
  cache: true,
}
```

Not for a dev server: it serves the app's source, so `e2e` must fold its key (the `persistent` example above), or a broken page replays a green `e2e`.

### When to use `--no-cache` instead of removing `cache`

`--no-cache` is a flag for one run, not a config change. Use it when:

- You suspect a broken cache and want a clean run.
- You are measuring and need fresh timings.
- You forward one-off args and want no entry for them. Forwarded args are in the key, so they make their own entry anyway.

It applies to the whole run. To stop caching one task, leave `cache: true` out of its config.

## Schema validation errors

vx checks every config when it loads and stops with a plain message, no stack trace. When the field is in a file, it shows the file at that line with a caret under the field:

```ansi
[38;2;239;68;68m✗[0m [1mvx lock[0m  [38;2;203;213;225mlock not written[0m

  [1mpackages/app/vx.config.ts:6:15[0m
  [38;2;203;213;225mtasks.build.exec has unknown field "comand"[0m
  [2mallowed: command, env, interactive, persistent, platforms, remote, retries, sandbox, timeout, worker[0m

  [2m  4 |[0m   tasks: {
  [2m  5 |[0m     build: {
  [2m> 6 |[0m       exec: { comand: 'mkdir -p dist' },
  [2m    |[0m               [38;2;239;68;68m^[0m

  [2mfix[0m  [1muse command[0m
```

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- On a terminal narrower than a framed line, each line shows the columns around the caret, `…` where it was cut, so the caret stays under the field.
- `packages/app/vx.config.ts:6:15` is relative to the current directory, so a terminal opens it on click.
- `test: testTask`, `...lib()`: an imported value is followed to the file that declares it, a relative import or a workspace package's. That file is framed, with the configs it reaches as `used by …`.
- So a typo in a shared preset prints once, not once per config.
- `import { lib } from './presets.ts'` where `presets.ts` exports no `lib`: framed at that import.
- A field no file holds, a missing required one or one a plugin set, prints at its file with no frame.
- Every config that does not load is named in one run: the first in full, then up to four more as `✗ vx lock also refused`, then a count of the rest.
- Every field's accepted values and exact refusal text are recorded in `tests/contract/config-schema.json`, which a test regenerates from the validator, so a change to either is deliberate.

</div>
</details>

The messages you meet most:

| Symptom                                                                                                                               | Cause                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `did not export a default object`                                                                                                     | No `export default` (said so, framed at a named export), or a default that is no object. A function adds that it is one: export what it returns.                                                                                                                               |
| `tasks must be an object keyed by task name`                                                                                          | `tasks` is not an object, an array included.                                                                                                                                                                                                                                   |
| `<path> is <what> — a config must be JSON data, because the cache key is built from its JSON`                                         | A value JSON cannot carry, anywhere: a function, symbol, bigint, `NaN` / `±Infinity`, `undefined` in an array, a cycle, a getter, a symbol key, a non-enumerable property, a `Date`, `Map`, `RegExp` or class instance, nesting past 256 levels, or a proxy whose trap throws. |
| `<level> has unknown field "<key>"`                                                                                                   | A typo or a key vx does not take (see below).                                                                                                                                                                                                                                  |
| `<level> must be an object (fields: <fields>), not an array`                                                                          | An array where an object goes. `outputs: ['dist/**']` is `outputs: { files: ['dist/**'] }`, and the message says so.                                                                                                                                                           |
| `cannot find '<name>' — no node_modules above the config provides it; install the workspace's dependencies first`                     | A bare import nothing installed: a fresh clone before its install, or a typo. Refused before the config runs, so Bun never installs it from the registry.                                                                                                                      |
| `<file> imports '<name>', which no node_modules above it provides; install the workspace's dependencies first`                        | The same, in a file the config imports by relative path (a preset), looked up from that file.                                                                                                                                                                                  |
| `cannot find '<name>' — Yarn Plug'n'Play installed the workspace's dependencies into .pnp.cjs, which Bun does not read; set <remedy>` | The same, with a `.pnp.cjs` at or above the config, which Bun cannot read. Set `nodeLinker: node-modules` in `.yarnrc.yml` and run `yarn install`.                                                                                                                             |
| `tasks.<name> must be an object`                                                                                                      | The task is null, a string or another non-object. A string (`build: 'vite build'`) adds the `{ exec: { command } }` it goes in.                                                                                                                                                |
| `exec must be an object with a command string`                                                                                        | `exec` has the wrong shape.                                                                                                                                                                                                                                                    |
| `exec.command must be a non-empty string`                                                                                             | No `command`, or an empty or blank one.                                                                                                                                                                                                                                        |
| `exec.command holds a NUL, which no command line can carry`                                                                           | A `\0` in the command, often a template slip.                                                                                                                                                                                                                                  |
| `exec.persistent must be an object (or omitted)`                                                                                      | Wrong shape: write `persistent: {}`.                                                                                                                                                                                                                                           |
| `exec.persistent.readyWhen must be a string regex`                                                                                    | `readyWhen` is not a string.                                                                                                                                                                                                                                                   |
| `exec.persistent.readyWhen is blank, which matches any line: omit it to be ready on spawn`                                            | An empty or whitespace `readyWhen`.                                                                                                                                                                                                                                            |
| `exec.persistent.readyWhen is not a valid regex (<error>)`                                                                            | A `readyWhen` that does not compile, such as `(`.                                                                                                                                                                                                                              |
| `cache is not allowed on a persistent task`                                                                                           | `persistent` and `cache` together.                                                                                                                                                                                                                                             |
| `exec.interactive must be a boolean (or omitted)`                                                                                     | Wrong shape: write `interactive: true`.                                                                                                                                                                                                                                        |
| `cache is not allowed on an interactive task`                                                                                         | `interactive` and `cache` together: what it does depends on what is typed.                                                                                                                                                                                                     |
| `sandbox is not allowed on an interactive task`                                                                                       | `interactive` and `sandbox` together.                                                                                                                                                                                                                                          |
| `persistent.readyWhen is not allowed on an interactive task`                                                                          | vx reads none of an interactive task's output.                                                                                                                                                                                                                                 |
| `a task with no exec must declare dependsOn or inputs`                                                                                | Group task with no edges and no key.                                                                                                                                                                                                                                           |
| `cache needs exec — a task with no command produces nothing to cache`                                                                 | `cache` on a group: a task with no command writes nothing to cache.                                                                                                                                                                                                            |
| `dependsOn must be an array of strings`                                                                                               | Wrong shape.                                                                                                                                                                                                                                                                   |
| `cache needs inputs — the key is the task's inputs`                                                                                   | A cached task with no `inputs`.                                                                                                                                                                                                                                                |
| `inputs must be an object`                                                                                                            | Not an object: a string (`inputs: 'src'`). An array is the row above.                                                                                                                                                                                                          |
| `inputs.files must be an array`                                                                                                       | Wrong shape.                                                                                                                                                                                                                                                                   |
| `<list> lists "<name>" twice`                                                                                                         | A name twice in `inputs.env`, `exec.env.passThrough`, `exec.env.secret` or `tags`; each counts once.                                                                                                                                                                           |
| `inputs.runtime must be an array of non-empty shell command strings with no NUL`                                                      | An entry that is not a string, is blank (whitespace alone runs as a no-op) or holds a NUL.                                                                                                                                                                                     |
| `inputs.workspaceRuntime must be an array of non-empty shell command strings with no NUL`                                             | An entry that is not a string, is blank (whitespace alone runs as a no-op) or holds a NUL.                                                                                                                                                                                     |
| `inputs.tasks must be an array of non-empty strings`                                                                                  | An entry that is not a string or is empty, or a bare string for the list.                                                                                                                                                                                                      |
| `inputs.tasks: "<name>" names no task in <task>.dependsOn`                                                                            | An exact entry no `dependsOn` entry of its form names.                                                                                                                                                                                                                         |
| `inputs.tasks: every entry is a negation, which selects NOTHING`                                                                      | Only `!` entries: a `!` entry only takes back what a positive entry selected.                                                                                                                                                                                                  |
| `invalid inputs.tasks "<entry>": <reason>`                                                                                            | A malformed entry (`^`, `a#`, `#x`, `!`, `^a#b`), with the reason.                                                                                                                                                                                                             |
| `cache must be true or false`                                                                                                         | `cache: {...}` or `'yes'`: caching is a switch.                                                                                                                                                                                                                                |
| `cache needs outputs — what the task produces, outputs: { files: [...] } ([] for none)`                                               | A cached task with no `outputs`.                                                                                                                                                                                                                                               |
| `outputs needs exec — a task with no command writes nothing`                                                                          | `outputs` on a group task.                                                                                                                                                                                                                                                     |
| `inputs.stability needs exec — a task with no command runs nothing that could write its inputs`                                       | `inputs.stability` on a group task.                                                                                                                                                                                                                                            |
| `inputs.stability must be an object`                                                                                                  | A bare string (`stability: 'mutable'`).                                                                                                                                                                                                                                        |
| `inputs.stability.strategy must be 'immutable', 'mutable' or 'unchecked'`                                                             | Any other value (`'content'`, `false`).                                                                                                                                                                                                                                        |
| `inputs.stability.severity must be 'warn' or 'error'`                                                                                 | Any other value (`'fail'`, `true`).                                                                                                                                                                                                                                            |
| `outputs must be an object`                                                                                                           | Not an object: a string (`outputs: 'dist'`). An array is the row above.                                                                                                                                                                                                        |
| `outputs.files must be an array`                                                                                                      | Wrong shape.                                                                                                                                                                                                                                                                   |
| `inputs.files: every entry is a negation, which selects NOTHING`                                                                      | Only `!` globs: there is nothing to take back from.                                                                                                                                                                                                                            |
| `inputs.files: "<file>" is taken back by "!<glob>"`                                                                                   | A file named as an input that a `!` entry covers. The `!` wins wherever it sits, so the file never reached the key.                                                                                                                                                            |
| `outputs.files: every entry is a negation, which selects NOTHING`                                                                     | Only `!` globs: a `!` entry only takes back what a positive glob selected.                                                                                                                                                                                                     |
| `outputs.files: "<file>" is taken back by "!<glob>"`                                                                                  | A file named as an output that a `!` entry covers: it is never saved, so a hit would leave it missing.                                                                                                                                                                         |
| `outputs.files: "<glob>" covers the project's own <file>`                                                                             | An output glob that matches the project's own `vx.config.*` (`**`, `*.ts`): the clean before a run would delete it. `!vx.config.ts` takes it back.                                                                                                                             |
| `outputs.files: "<glob>" is under workspace-outputs/`                                                                                 | A project output inside the folder vx keeps for `outputs.workspaceFiles`: every hit would read it back as a workspace output.                                                                                                                                                  |
| `inputs.files: '!!' is not a double negation`                                                                                         | `!!x` keeps only `x` instead of cancelling out. Write `!x` to take it back, or `x` to add it.                                                                                                                                                                                  |
| `exec.timeout of <value> exceeds the maximum timer delay`                                                                             | Past 2^31-1 ms a timer fires at once, not never.                                                                                                                                                                                                                               |
| `description must be a string`                                                                                                        | `description` is not a string.                                                                                                                                                                                                                                                 |
| `tag "<tag>" <why> — --filter tag:<name> could not name it`                                                                           | A tag with surrounding whitespace or a `*`, or ending in `...` or `[<ref>]`: a filter reads those as a pattern, a dependency walk or a git range.                                                                                                                              |

**Unknown fields are refused**, not ignored, at every object level of a config and at the top of `.vx/workspace.ts`. The message names the key and what that level takes.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- The levels: the project's top level (`tasks`), the task, `exec`, `exec.env`, `exec.persistent`, `exec.sandbox` and its `allow` / `deny` / `ignore`, `inputs` and `outputs`.
- `plugin: [...]` (singular) in `.vx/workspace.ts` would declare no plugins and run the workspace bare, so it is refused.
- `workspaceFile` (singular) or `timeoutMs`, if dropped silently, would hash the task as if never written, so vx would replay an artifact built from different inputs.
- `env: { set: … }`, if dropped silently, would run the task without its variables.
- `passthrough` on `exec.env` prints `tasks.build.exec.env has unknown field "passthrough"`, then `allowed: define, passThrough, secret`.
- It ends `fix  use passThrough`: the nearest accepted spelling, when one is within two edits.
- `output: ['dist/**']` on a task ends `— vx spells it \`outputs.files\``: a key another tool uses names where vx keeps it.
- On a task: `files`, `output`, `dependencies`, `env`, `passThroughEnv`, `persistent`, `continuous`, `interactive` and `outputLogs`.
- Also on a task: `with`, `executor`, `options`, `cwd`, `parallelism`, `configurations`, and `command`, `cmd` or `script`.
- On `exec`: `cmd`, `script`, `cwd`, `args`, `commands`, `parallel` and `shell`.
- Under `inputs`: `globs`, `include`, `patterns`, `exclude` and `ignore`. Under `outputs`: `globs`, `include` and `exclude`.
- `retries`, `timeout` or `files` on the task itself names the level it belongs to (`exec.retries`).
- `persistent: true` names the shape to write: `persistent: {}`.

</div>
</details>

Project-discovery errors:

| Symptom                                                                                                              | Cause                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `two projects are named "<name>": <dir> and <dir> — give one another \`name\` in its vx.config`                      | Two directories got one name: a config's `name`, a plugin's, or the path.                                                               |
| `<dir>: a project is named by its path unless named, and this one holds "#" …`                                       | A path no task name can address: set `name` in its config.                                                                              |
| `<dir>: the directory's name is not valid UTF-8, which no project path may hold — rename it`                         | A project directory's name has bytes UTF-8 cannot read, shown as `\xNN`.                                                                |
| `<dir>: "//" names the workspace root — set another \`name\``                                                        | A config away from the root says `name: '//'`.                                                                                          |
| `.vx/projects.lock locks <dir>, but its <file> is gone — run \`vx lock\``                                            | A locked project's config was deleted or renamed.                                                                                       |
| `.vx/projects.lock locks <dir>, but its <file> is not readable by this user (<code>) — give this user read access…`  | This user may not open the project's directory.                                                                                         |
| `.vx/projects.lock has unsupported version <n> (this vx expects 10) — re-run \`vx lock\``                            | A lock an older vx wrote.                                                                                                               |
| `.vx/dependencies.lock has unsupported version <n> (this vx expects 7) — re-run \`vx lock\``                         | A dependencies lock an older vx wrote.                                                                                                  |
| `.vx/projects.lock was written by a newer vx (version <n>; this vx reads 10) — upgrade vx`                           | A lock a newer vx wrote: locking again would write the older version.                                                                   |
| `<dir> is outside this sparse checkout, so vx lock cannot read its <file> — run \`git sparse-checkout add <dir>\``   | `vx lock` or `--check` where a sparse checkout left a config out.                                                                       |
| `.vx/projects.lock: no task #<id> — re-run \`vx lock\``                                                              | A hand-edited lock names a task line it does not hold.                                                                                  |
| `.vx/projects.lock holds a line \`vx lock\` never writes — re-run \`vx lock\``                                       | A line with no tab, or a name twice.                                                                                                    |
| `<lock> holds a git merge conflict: run \`vx lock\`, which writes it anew from the configs`                          | A merge left conflict markers in `.vx/projects.lock` or `.vx/dependencies.lock`. Resolve the configs and manifests, then run `vx lock`. |
| `plugin '<name>' adds project <p>, but git ignores <file>, so \`vx lock\` cannot read it — unignore it or delete it` | A `discover` plugin's directory holds a config git ignores: `vx lock`, `--check` and a run naming its task.                             |
| `git ls-files failed (exit <n>) in <dir>: <why>. Run it there to see why.`                                           | `vx lock` could not list the configs, for example a broken git index.                                                                   |

Core reads no `package.json` or `pnpm-workspace.yaml`; the errors reading them are `@vzn/vx-migrate`'s (its README, "Errors reading the members").

Workspace-config errors:

| Symptom                                                                                                                                                                                        | Cause                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<setting> must be <what its kind takes> (got <value>)`                                                                                                                                        | A setting of the wrong type or out of range: `run.concurrency: 0`, `cache.dir: 42`, `run.schedule: 'fastest'`. A count is a number and a switch a boolean, never a string; the [settings table](#settings) says what each takes. |
| `<setting> takes a duration with its unit, like '<n>ms' or '<n>s' (got <n>)`                                                                                                                   | A bare number for a duration: `run.timeout: 30000`. Write `'30s'`: a unit means `30000` is never read as seconds by mistake.                                                                                                     |
| `<setting> takes a size with its unit, like '<n>KiB' or '<n>B' (got <n>)`                                                                                                                      | A bare number for a size: `cache.store.embeddings: '32'`. Write `'32KiB'`; `0` is refused naming `false`.                                                                                                                        |
| `<setting> of <value> exceeds the maximum timer delay`                                                                                                                                         | A timer past 2^31-1 ms fires at once, not never. Leave `run.timeout` out for no limit.                                                                                                                                           |
| `<group> must be an object (fields: <fields>)`                                                                                                                                                 | A settings group (`run`, `run.rules`, `cache.store`, `watch`, …) that is not an object.                                                                                                                                          |
| `cache must be an object like { dir, policy }; a task caches through its own cache in its project's vx.config`                                                                                 | `cache: true` in the workspace file. A task turns its cache on with its own `cache: true` in its project's vx.config.                                                                                                            |
| `cache.dir holds a NUL, which no path can carry`                                                                                                                                               | No path can hold a NUL.                                                                                                                                                                                                          |
| `baseBranch must be a branch name like 'main'`                                                                                                                                                 | Not a string, empty, or holding whitespace, a NUL, `..` or one of `~^:?*[\`; or starting with `-`, which git would read as an option.                                                                                            |
| `plugins must be an array of plugin objects`                                                                                                                                                   | Wrong shape.                                                                                                                                                                                                                     |
| `plugins[<i>] must be an object`                                                                                                                                                               | A non-object entry. A string (`'@acme/plugin'`) adds that a plugin is what its package's function returns, not a module name.                                                                                                    |
| `plugins[<i>] must come from definePlugin(import.meta, { … })`                                                                                                                                 | A plain object where a plugin goes: a plugin's name is its package name, and only `definePlugin` sets it.                                                                                                                        |
| `plugins[<i>] is a Promise — await the factory that returns the plugin`                                                                                                                        | An async plugin factory called without `await` (`plugins: [later()]`).                                                                                                                                                           |
| `plugins[<i>] is plugins[<j>] again (plugin '<name>') — declare a plugin once`                                                                                                                 | One plugin instance listed twice (two presets sharing it): its setup, handlers and telemetry would run twice. Two instances of one package stay two plugins.                                                                     |
| `plugins[<i>].name overrides the package name`                                                                                                                                                 | A `name` set over `definePlugin`'s result: drop the field.                                                                                                                                                                       |
| `plugins[<i>].<capability> of plugin '<name>' must be a function`                                                                                                                              | A capability key holding something that is not a function.                                                                                                                                                                       |
| `plugins[<i>] (plugin '<name>') must contribute at least one of config/discover/project/graph/key/fingerprint/measures/schedule/admit/executor/cache/telemetry/output/setup/commands/teardown` | A plugin object with no capability.                                                                                                                                                                                              |
| `plugin '<name>' declares '<key>', which is no plugin hook`                                                                                                                                    | A key on a plugin that names no hook (`excutor`, `setUp`): it would never be called. The nearest hook is hinted.                                                                                                                 |
| `<file> has unknown field "<key>"`                                                                                                                                                             | A typo or a key vx does not take at the top level (`plugin`). The hint names the nearest spelling, or where vx keeps a key from another tool's config (see below).                                                               |
| `plugin '<name>' declares command '<verb>', a core verb — core verbs cannot be shadowed`                                                                                                       | A plugin verb a core verb would always match first, so it could never run.                                                                                                                                                       |
| `plugin '<name>' declares command '<verb>', which is not a word — a verb is a letter or digit, then letters, digits, ':', '.', '_' or '-'`                                                     | A verb like `--version`, `''` or `a b`: vx reads a flag first, an empty word is no verb, and `vx completions` writes verbs unquoted into a shell script.                                                                         |
| `plugins '<a>' and '<b>' both declare command '<verb>' — a verb has one owner`                                                                                                                 | Two packages on one verb: the first would hide the second. Plugins of one package are one owner, and the first declared runs.                                                                                                    |
| `plugins[<i>].fingerprint of plugin '<name>' must be { files: [name, …], affected: function, extraFiles?: function, digests?: function }`                                                      | A fingerprint claim without its file list or its `affected` answer, or with an `extraFiles` or `digests` that is not a function.                                                                                                 |
| `plugin '<name>' claims fingerprint file "<file>", which is not a file name at the workspace root`                                                                                             | A claim that names a path, or nothing: a claim is a bare file at the root (`vx watch` does not watch the root recursively).                                                                                                      |
| `plugins '<a>' and '<b>' both claim fingerprint file '<file>' — a file has one claimant`                                                                                                       | Two plugins keying the same lockfile: the key would fold both, and `--affected` could ask only one.                                                                                                                              |
| `plugin '<name>' claims fingerprint file '<file>' twice (plugins[<i>] and plugins[<j>]) — a file has one claimant; declare the plugin once`                                                    | One plugin package declared twice (`plugins: [bun(), bun()]`).                                                                                                                                                                   |

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Keys from other tools' configs</span></summary>
<div class="vx-deeper-body">

- `defaultBase: 'main'` in `.vx/workspace.ts` is refused, naming `baseBranch`: a key another tool's config uses names where vx keeps it.
- In `.vx/workspace.ts`: `pipeline`, `tasks`, `targetDefaults`, `namedInputs`, `globalEnv` and `globalDependencies`.
- Also `remoteCache`, `parallel`, `cacheDirectory`, `defaultBase`, `tasksRunnerOptions` and `globalPassThroughEnv`.
- Also `packages`, `workspaces` and `projects` (a project is a directory holding a `vx.config`), and `ignore`, `catalog`, `npmClient`, `remote` and `env`.
- In a project's vx.config: `targets`, `extends`, `implicitDependencies`, `scripts`, `pipeline`, `namedInputs`, `root`, `sourceRoot` and `projectType`.
- `dependsOn`, `inputs`, `outputs`, `cache`, `exec`, `description` or `env` at a project's top level is one level too high: the message names `tasks.<name>.<key>`.

</div>
</details>
