# @vzn/vx-history

Website: <https://vznjs.github.io/vx/> · this plugin: <https://vznjs.github.io/vx/plugins/vx-history/> · source: <https://github.com/vznjs/vx>

History-based scheduling for [`@vzn/vx`](https://vznjs.github.io/vx/). It starts the tasks that hold up the most work first, learned from how long your tasks took before.

It is a `schedule` plugin. It orders ready tasks by their expected REMAINING critical-path duration: a task's own p50 plus the longest chain of dependents behind it.

It learns from the workspace's local run history. It has no dependencies.

A task's p50 is the median of its last five timings on the current branch, else on any branch, else unknown.

An unknown one (a new or renamed task, or one whose command changed) weighs the median p50 of the run's tasks that have one, unless `assume` or `file` names it.

The timings are shared by every worktree of the repo, so a new worktree orders by them on its first run.

## Usage

```sh
bun add -d @vzn/vx @vzn/vx-history
```

```ts
// .vx/workspace.ts
import { vxHistory } from '@vzn/vx-history'

export default { plugins: [vxHistory()] }
```

The options are `vxHistory({ window?, assume?, file?, url?, issuer?, repository?, headers?, timeoutMs?, retries?, resources?, memory?, reservations? })`.

It learns from the last `window` invocations (default 20) through core's `localHistory(cache)`. That reads the cache's index and returns rows; the plugin never touches cache.db.

With one worker and two chains of identical shape, the chain history says is slow starts first. With no history yet, the scheduler's structural order stands.

`assume` is for the run that has no history, such as a fresh CI runner. It names durations (task id → ms) for tasks the history has not seen.

So a long leaf task, such as a docs build or a cross-compile, starts first instead of last:

```ts
export default {
  plugins: [vxHistory({ assume: { '@vzn/vx-docs#build': 30_000 } })],
}
```

A recorded p50 always wins over an assumption. Assumptions never feed the workspace median: they are a hint for the cold run, not evidence.

A duration that is not a number of ms from 0 to 2^53 is dropped, with one warning naming its task ids. The rest still order the run.

That catches `Number()` of an unset variable (NaN), and a number so large it sums along a chain past any number.

The example is vx's own docs build, which is ready from the second second of a cold run.

## Timings from a history server

A server can share timings between CI runners. Set `url`, `issuer` and `repository`:

```ts
export default {
  plugins: [
    vxHistory({
      url: 'https://history.example.com',
      issuer: 'https://token.actions.githubusercontent.com',
      repository: 'acme/app',
    }),
  ],
}
```

`url` (or `VX_HISTORY_URL`) names a [`@vzn/vx-history-server`](https://github.com/vznjs/vx/tree/main/packages/vx-history-server) by its base URL, without `/v1`.

- It must be `https://`. `http://` is taken only to `127.0.0.1`, `::1` or `localhost`, since every request carries the CI token.
- It takes no `?query` or `#fragment` (each route is appended to it), and no blanks around it.

`issuer` (the CI issuer's URL, as its tokens name it) and `repository` (`org/name` there) are required with a server. Nothing guesses them.

The run's one query names them, with its refs and every task hash. `VX_HISTORY_URL` alone, with neither declared, is said and not asked.

### Tokens

A CI job sends its own token:

- GitHub's OIDC token needs `permissions: id-token: write`, which sets `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`.
- On GitLab, name an `id_tokens` entry `VX_HISTORY_TOKEN` with the server's origin as `aud`.

A 5xx or 429 from GitHub's endpoint is asked again up to three times. So is a 429, 502, 503 or 504 from the server.

A CI job with no token says so once. On GitHub Actions (`GITHUB_ACTIONS`) it names the permission.

A run with no token (off CI) only reads, from a server whose `READ_ACCESS` is `public`, and sends nothing.

A server refusing a run with no token names the fix for the CI it is on (`GITHUB_ACTIONS`, `GITLAB_CI`).

### What a run reads

Each run asks the server for its tasks' numbers, by task definition, in the refs it reads, as a remote cache does.

The refs are its branch's, the branch it merges into, then the default branch's (`baseBranch`, else git's or the CI's).

A run that reads no ref (a detached HEAD with no default branch) asks nothing.

A ref over the 512 characters a server takes is said and not read. The run reads the others.

The run starts on its local history and re-ranks the tasks not yet started when the answer lands. It never waits for it.

### What a run sends

The run sends the timings of the tasks it ran while it goes, each task once (the server counts every report).

It uploads once 50 tasks have finished, or 10 s after the first of them, one upload at a time.

Under DTE the orchestrator sends them. Each worker's measurements go with the last upload, as the last task ends, beside core's own end of run.

An upload that fails mid-run holds the tasks the server did not take, and the run's later ones, for that last upload. So a server that is down is said once.

The plugin's teardown waits at most 2 s for the rest; core bounds a teardown at 3 s.

What is not sent by then is dropped and said, with how many timings it held and the status the server last answered, if one came.

A task that shared a crowded worker's cores is sent as long as it would have taken alone. Its cores are sent as at most its machine's, as local history keeps them.

<details><summary>Details</summary>

A token the server refuses (401) is said at once. The warning also names the repository and issuer the workspace declares, and the audience the token must carry.

After a 401 the server is off for the rest of the run.

A refusal is said with the server's words, each token the request sent written `***`.

Every warning shows the server's url with a `user:pass@` as `***@`.

An answer is read no further than the protocol's largest: 64 KiB, and 2 KiB more per hash a query asks.

A longer one, such as a server's endless stream, is refused as `answered over N bytes`.

`timeoutMs` (default 10 000, whole ms from 1 to 2³¹−1) bounds each request to the server.

`retries` (default 2, 0 to 10) is how many times a request is asked again, 1 s, 2 s, … apart. That covers one answered 5xx or 429, and GitHub's OIDC endpoint.

`headers` are sent on every request to the server, for a proxy in front of it. For example, a Cloudflare Access service token:

```ts
{ 'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID, … }
```

- An unset value is left out.
- A name the request sets itself (`authorization`, `content-type`, `content-length`) is refused.
- A redirect is not followed, since it would carry the headers on. It fails the request, naming where it pointed.

</details>

The same upload carries the flaky record. That is each cached task the run ran, by definition and cache key, with how it ended: `pass`, `fail`, or `flaky` when it passed on a retry.

A task built on a dependency `--exclude-dependencies` left out is left out: its result is not its key's.

The server names a task flaky when one key failed and later passed, or a run saw it flake, on any branch of the repository.

The run's query answers which of its tasks are flaky. Core gives such a task one retry when it fails, as it does a task its local history knows as flaky.

So a CI machine that starts empty still retries a known flake.

Each timing is of the task as it was: its command and `env.define` (`taskDefinitions`).

A task whose command changed reads none of its old timings. Editing its inputs, outputs or deps keeps them.

A forecast reads this branch's last five timings first, then the newest the server answered, then any branch's, then `assume`.

Of a timing the server answers, vx keeps only what a server would store:

- a duration that is not a whole count of ms skips the timing;
- cores not finite from 0, or RSS not a whole byte count, are dropped. `1e400` parses as Infinity, and kept, it failed every later run's schedule.

Core's history store keeps no such number either.

## Timings between CI runners, without a server

A fresh CI runner has no history. `file` names a JSON file, from the workspace root, that carries it between runs:

```ts
export default {
  plugins: [vxHistory({ file: '.vx-timings.json' })],
}
```

```yaml
# GitHub Actions
- uses: actions/cache@v4
  with:
    path: .vx-timings.json
    key: vx-timings-${{ github.run_id }}
    restore-keys: vx-timings-
```

The file is read before ordering and rewritten after each run with every task's p50. Its directory is made if absent, so a CI cache keeps one file.

Git-ignore it. Otherwise a task whose inputs cover it (a root project's `**`) re-keys on every rewrite.

`vx watch` would also re-run on each rewrite in a project it watches. A rewrite of a file git does not ignore warns.

A committed file stays tracked whatever `.gitignore` says: `git rm --cached` it.

<details><summary>Details</summary>

The file is `{ "version": 1, "tasks": { "<task id>": <ms> } }`, keys sorted. An entry that is not a number of ms from 0 to 2^53 is dropped.

A p50 recorded on this machine wins over the file, and the file wins over `assume`. Like `assume`, it never feeds the workspace median.

A task the run did not see keeps its time, including one another writer put there while the run ran.

A run that executed nothing and restored only tasks the file already times leaves it as it was. An all-cached run writes a missing one.

- A file that is not one warns, is read as empty and is never written over.
- A file it cannot write warns, and the run goes on.
- `--dry` writes nothing.

</details>

## Reservations learned from history

The plugin keeps tasks that need a lot of memory from running side by side. It learns each task's memory from history:

```ts
plugins: [
  vxHistory({
    // MB. The default is the machine's total capped by the cgroup limit; set it to budget below either.
    memory: 8192,
    resources: { headroom: 1.5 },
    // Declared by hand for what history cannot size (a first run); a declared axis wins, one left out keeps what history learned.
    reservations: { 'app#e2e': { cpus: 2, memory: 4096 } },
  }),
]
```

The runner records every execution's CPU time and peak RSS. Core's only gate is the worker count.

This plugin's `admit` hook packs the finer numbers, and core never learns them.

Each task's reservation is the largest peak RSS in the window, times a headroom (1.25), rounded up to 64 MB.

Cores are never learned, only declared. The parallelism a build shows is what the machine let it have.

Reserving the solo reading packed 92 real builds two wide on four cores, for a 21% longer run.

A task is admitted while its reservation and those of everything running beside it fit the budgets:

- cores are the run's worker count;
- memory is what this process may use: the machine's total, capped by the cgroup limit a container runs under.

A task over a whole budget runs alone.

A task with no execution in the window reserves nothing and runs freely, as it would with no plugin. A spike or a refactor ages out with the window.

A cache hit counts too: the producing execution's usage rides the artifact.

So a fresh CI runner that restored a task from a remote cache has its reservation on the next run without ever having executed it.

<details><summary>Details</summary>

`window`, `memory` and `headroom` must each be a finite number above 0 (`window` a whole one).

One that is not runs on its default, named in one warning per run and in `vx history`.

That catches `Number(process.env.X)` with `X` unset, which is NaN. No reservation fits a NaN budget, so every task that reserved memory would wait for an idle machine.

A declared `reservations` axis (`cpus`, `memory`) that is not a number above 0 is not declared. The axis keeps what history learned, and the warning names it.

A NaN there held its task alone, and every reserving task beside it waited. `0` declares nothing on that axis, silently.

An entry that is not an object (`{ "app#build": 2048 }`) declares nothing and is named the same way.

A key other than `cpus` and `memory` there, or other than `headroom` in `resources`, is refused when the config loads, as a misspelt option is.

</details>

`vx history [--format pretty|json]` shows what the plugin learned per task and the reservation it will pack, with the budgets it packs into.

It is a verb this plugin adds; `--help` prints its usage. Like a run, it reads each task as it is now: runs of an earlier command are not counted.

```
$ vx history
history: last 20 runs · budgets 4 cores (the default worker count; --concurrency changes it per run) · 13567 MB (what this process may use)
  task       runs      p50  peak rss    cpu  reserves
  app#build    12    8.41s    612 MB   1.9×  768 MB
  app#e2e       3   41.20s    1.4 GB   1.1×  4096 MB · 2 cores (declared)
  lib#test     12    1.02s         —   1.0×  —
  3 tasks with no execution in the window reserve nothing
```

`--format json` emits `{ window, budgets, tasks }`. Each task has `runs`, `p50DurationMs`, `maxPeakRssBytes`, `maxCpuParallelism`, `reservation` and `declared`.

`schemas/history.json` (shipped) is its JSON Schema, held to the output by core's `tests/plugin-json-schemas.unsafe.test.ts`.

A cache hit's row carries the producing execution's usage. So a task restored from a remote cache shows a reservation on a machine that never executed it.

A task lighter than vx itself has no peak on record, and reserves nothing: what a task under vx's own footprint needs.

The runner reports a peak only above its own footprint, since Linux hands a lighter child the parent's figure.

`resources: false` turns the learning off. Declared `reservations` are still packed.

This is admission control, not enforcement. Nothing is cgroup-limited or reniced, and a task that exceeds its reservation is the job of `exec.timeout` and the OS.

Design: `docs/design/resource-estimates-2026-09.md` in `@vzn/vx`.

## What it does and does not do

- It is an ORDERING hint over the scheduler's structural baseline: how many tasks wait on each one, directly or through others.
- It is merged as `VxPlugin.schedule` returns it: task id → weight. It never changes what runs, only which ready task runs first.
- Cache hits are not modelled as zero-cost. Predicting cache state needs the key and a probe, which the scheduler handles at run time.
- A confirmed hit is backfill, never a critical-path task. The estimate is "what if everything ran", which is the case where order matters.
- It fails open: a broken history read warns (`[vx] vx-history: ordering falls back to the baseline`). It leaves the baseline order and only the declared reservations.
- Observability never breaks a run.
- Cost: one history read per run, serving both hooks, paid only by workspaces that declare the plugin. Core applies no plugin by default.

The score is core's `criticalPath(nodes, history, assume?)` (`@vzn/vx`), which any `schedule` plugin may call.

These are exported for tests, and for policies that want the same scoring over another history source:

- `resourceEstimates(nodes, history, headroom)`;
- `withDeclared(learned, declared)`;
- `admits(id, running, reservations, budgets)`;
- the types `VxHistoryOptions`, `ResourceEstimate` and `Budgets`.

## History

This plugin was once part of core. It lives here so core ships no plugin at all.
