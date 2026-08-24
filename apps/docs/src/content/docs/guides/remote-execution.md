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
`vx run --verify=inputs` proves a task's declared inputs are complete before
you mark it remote-eligible.

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
