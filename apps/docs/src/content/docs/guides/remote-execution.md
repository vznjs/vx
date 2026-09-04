---
title: Remote execution
description: Run tasks on a Bazel REAPI worker pool with @vzn/vx-reapi — placement rules, the install-as-action recipe for node_modules, worker image requirements, and what stays local.
---

vx can execute tasks on any worker pool speaking Bazel's
[Remote Execution API](https://github.com/bazelbuild/remote-apis) — NativeLink,
BuildBuddy, Buildfarm. The scheduler **never leaves your machine**: vx owns the
task graph, decides placement per task, and ships each eligible task to the
pool as one self-contained action. Telemetry, retries, timeouts, the cache and
the logger all behave exactly as they do locally, because they never moved.

## Enabling it

Remote execution is **off by default**, even with the plugin configured for
caching — it changes where your build runs, which is not something a plugin
should switch on merely by being present:

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { localExecutorPlugin } from '@vzn/vx/plugins/local-executor'
import { localCachePlugin } from '@vzn/vx/plugins/local-cache'
import { reapi } from '@vzn/vx-reapi'

export default defineWorkspace({
  plugins: [
    reapi({
      endpoint: 'grpcs://cache.example.com:443',
      execute: true, // or VX_REAPI_EXECUTE=1
      platform: { OSFamily: 'Linux', 'container-image': 'docker://node:22' },
      capacity: 64, // concurrent remote tasks — the scheduler pools them
    }),
    localExecutorPlugin(),
    localCachePlugin(),
  ],
})
```

`capacity` gives the executor its own scheduler pool: a 64-wide worker fleet
is not throttled by your laptop's core count, and remote tasks reserve none of
your local CPU or memory. Against a **cache-only** server (bazel-remote
advertises no execution capability) the plugin declines the executor with a
warning and everything runs locally.

## Which tasks go remote

Placement is decided once per task, before scheduling, and `vx run --dry`
shows it per line (`@vx/reapi`, `@local`, or `@noop`):

- **Only cacheable tasks are eligible.** A task with no `cache` block has no
  declared inputs, so a worker would run it against an empty tree. It stays
  local.
- **`exec.remote: false`** pins a task to your machine (it talks to a local
  daemon, Docker, a device).
- **Persistent tasks and everything depending on them** are pinned
  automatically — a worker cannot reach a port served on your machine.
- **`exec.remote: 'only'`** is the inverse pin, covered below.

A task's inputs on the worker are exactly what its cache key declares:
`cache.inputs.files`, resolved env values, and upstream outputs. Ambient
state — `tsconfig.json` not covered by a glob, `.npmrc`, `node_modules` — is
deliberately not part of the key and therefore **not on the worker**.
A task's `sandbox` block confines it to the paths it declared, which is how
you find the gap before you mark it remote-eligible — and a sandboxed task
runs local, because the sandbox is local machinery a worker has none of: executed
remotely, the verify would pass vacuously.

## node_modules: install as an action

Workers are stateless and `node_modules` is ambient, so a remote build cannot
see your packages. The answer is an explicit install task with
`exec.remote: 'only'`:

```ts
install: {
  exec: { command: 'pnpm install --frozen-lockfile', remote: 'only' },
  cache: {
    inputs: { files: ['package.json', 'pnpm-lock.yaml'] },
    outputs: { files: ['node_modules/**'] },
  },
},
build: {
  dependsOn: ['install'],
  exec: { command: 'tsc -p .' },
  cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
},
```

What this does, verified end-to-end against a live NativeLink pool:

- `install` runs **on a worker** — platform binaries build for the worker's
  platform — and once per lockfile change, ever: repeats are satisfied from
  an execution record kept under the task's cache key (`--force` bypasses
  it).
- Its outputs **never touch your disk**: not materialised, not restored, and
  the `node_modules` you installed yourself is never cleaned.
- A dependent remote task's input tree references the install outputs **in
  the remote store** — the bytes flow worker→CAS→worker without transiting
  your machine.
- With **no remote executor declared**, `install` is a local no-op and
  dependents use whatever your machine has ambient. A laptop run behaves
  exactly as it did before the field existed.

One coherence rule to know: when an upstream's outputs ARE on your disk
(it ran or restored locally), the worker sees **those** bytes — local disk is
truth, and the remote record is only used for outputs that exist nowhere
locally.

## How output globs travel

REAPI has no glob wire — a `Command` lists literal paths, and the worker
captures what exists there after the run. vx maps each declared glob to its
literal prefix (`dist/**` → `dist`, captured as a directory tree), and
`outputs.workspaceFiles` travel as `../…` paths relative to the project's
working directory — both proven live against NativeLink. One edge to know: a
glob whose **first** segment is a wildcard (`*.tsbuildinfo`) maps to the
whole working directory — the only spelling that can't lose the match — so
everything the command wrote comes back, which is also what a local run
leaves on disk. The cache stays narrow either way: saving re-applies your
declared globs on the materialised files. The whole-directory spelling is a
spec gray area (sanctioned only for the deprecated field), so a stricter
third-party worker may reject it — prefer globs with a literal first segment
(`dist/**`) where you can.

## What environment the worker sees

Two of vx's three environment lists travel with the action:
`exec.env.define` (config literals) and `cache.inputs.env` (host values that
are already in the cache key), merged with a `define` winning on collision
and sorted by name — the proto requires the sort so equivalent commands hash
alike.

`exec.env.passThrough` and the essential allowlist do **not** cross. They are
the submitting machine's resolved values, and putting them in the action
would split every machine from every other; `passThrough` is also where
secrets go, and an action's command is stored in the shared CAS. A task whose
command reads a passed-through secret belongs on `exec: { remote: false }`.
[Environment variables](../environment-variables/) has the full picture.

## Keeping the bytes remote: `--download`

By default every remotely-executed task's outputs are downloaded to the
machine that started the run. For a chain of remote tasks that is often
pure waste: the next task's worker grafts its inputs straight from the
CAS, and nobody on your machine reads the intermediates.

```bash
vx run build --all --download=none      # nothing comes home unless something needs it
vx run build --all --download=toplevel  # only what you asked for comes home
```

Bazel calls this "build without the bytes". A deferred task's outputs
stay in the CAS; if a **locally**-placed task in the same run turns out
to need them, vx fetches them lazily, once, just before that task runs —
and then saves an ordinary cache entry for them, so the next run is a
plain local hit. Nothing you can observe changes except how many bytes
crossed the network. The end-of-run summary names every task whose
outputs stayed remote.

Two things it deliberately will not do:

- **It never moves a cache key.** Download policy is transfer tuning, so
  it is not folded into any key — a `--download=none` run hits the same
  entries an ordinary run does.
- **It refuses to defer anything a key could observe.** If some task's
  `cache.inputs` globs could match a producer's outputs, that producer
  stays eager; a run declaring any `cache.inputs.runtime` command defers
  nothing at all, because a shell command's reads cannot be bounded.
  `--dry` names each downgrade.

Repeat runs are cheap even with nothing cached locally: every successful
remote execution writes a record under the task's key, so a later run
whose local cache missed skips the input-tree build, the upload pass and
`Execute` entirely, and replays the recorded stdout. `--force` bypasses
it.

## It proves your declared inputs

A worker gets exactly what you declared and nothing else, so the first
remote run of a task is an input-completeness check you did not have to ask
for. Locally an undeclared file is invisible — it is on disk either way, so
the task passes and the cache quietly keys on an incomplete set.

The failure mode is worth knowing in advance, because it does not look like
a missing file. A type-checker with no `tsconfig.json` in its action does not
say "no tsconfig"; it reports several hundred errors about missing globals. A
test that reads a doc it never declared fails its assertion, not its `open`.
So when a task fails remotely and passes locally, suspect
`cache.inputs.files` / `workspaceFiles` before suspecting the worker.

The same gap is a stale hit locally, which is the more expensive half: if a
task reads a file it does not declare, editing that file does not change the
task's cache key, and the run you needed is served from cache instead. That
is the same question a task's [`sandbox`](../trusting-the-cache/) block
answers with an OS boundary — remote execution just answers it as a side
effect of shipping the inputs somewhere else.

## The worker image

Two requirements, both learned against real servers:

- **A shell.** vx's contract is that shell is the API, so every action runs
  `/bin/sh -c <command>`. Distroless worker images (NativeLink's official
  image among them) have no `/bin/sh` and fail every vx task with a
  misleading `No such file or directory`. Use an image with a shell.
- **Your toolchain.** The worker runs the same command string your laptop
  would; `node`, `pnpm`, compilers must be on the image (or installed by the
  `install` action). `cache.inputs.runtime` commands are folded into the key
  as toolchain expectations — a worker with a different `node --version`
  produces a different key, which is the correct outcome.

## Reliability behaviour

- A wedged or unreachable server **degrades**: cache calls carry deadlines
  (default 30 s) and a failed probe is a cache miss, never a hung run.
- Uploads chunk at 128 KB and automatically retry once at 64 KB if the
  transfer stalls (a Bun HTTP/2 flow-control defect; the retry is warned).
- A dropped `Execute` stream re-attaches to the same operation via
  `WaitExecution` — the action is not re-run.
- Execution stage transitions (`queued` → `executing` → `completed`) surface
  as status lines, so a task waiting behind a busy pool is distinguishable
  from a hung one.
