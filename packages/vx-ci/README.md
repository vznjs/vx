# @vzn/vx-ci

Website: <https://vznjs.github.io/vx/> · this plugin: <https://vznjs.github.io/vx/plugins/vx-ci/> · source: <https://github.com/vznjs/vx>

GitHub Actions and GitLab CI integration for [`@vzn/vx`](https://vznjs.github.io/vx/):

- `github()` writes each `vx run` that starts its tasks as a **job
  summary** on the workflow run page. It also names the run's cache
  scope.
- `gitlab()` names the run's cache scope on GitLab CI
  ([below](#gitlab-ci)).

```sh
bun add -d @vzn/vx @vzn/vx-ci
```

```ts
// .vx/workspace.ts
import { defineWorkspace } from '@vzn/vx/config'
import { github } from '@vzn/vx-ci'

export default defineWorkspace({
  plugins: [github()],
})
```

That's the whole setup.

On a GitHub Actions runner (`GITHUB_STEP_SUMMARY` set), every `vx run`
that starts its tasks appends a summary block. The block goes on its own line after anything
already written in the step.

The block holds:

- A verdict headline.
- Stats: tasks, executed, cache hits, duration, and aborted and not run
  when a stop cut the run short.
- The ideal time an executor says the run could have taken, as
  `@vzn/vx-dte` replays it.
- The workers that would have run it best (`@vzn/vx-dte`'s "Workers to
  declare").
- Failures, called out above the per-task table, and the tasks each
  failure blocked.
- The per-task table: rows by status, failures first, then the longest
  first.
- A footer line: the vx version, the command, tasks passed and outputs
  restored.
- The command in the footer counts what follows `--`, not quoted.

<details>
<summary>Details: how a task's row reads</summary>

- A failure shows its exit code, and the signal an exit above 128 stands
  for: `exit 137 (128 + SIGKILL)`, as the run's own frame and `vx last`
  say it.
- A timeout reads `timed out, exit 143`.
- A persistent task that never became ready reads
  `never ready (timed out)`.
- A hit whose restore failed reads `cache restore failed`: a failure,
  not executed and not a hit.
- A task whose command exited 0 but left a declared output matching no
  file reads `exited 0, no file matched dist/**`.
- A task whose command exited 0 but whose save vx refused reads
  `cache save failed`.
- A sandboxed task's row shows its violation count.
- A task that retried or proved flaky carries the run's own row mark
  after its status: `✅ ran · flaky - failed 1× before · 2 attempts`.
- A server a DTE run carried to its dependants' workers reads `served`.
  Like a skipped task, it has no duration of its own.

</details>

<details>
<summary>Details: the Workers table</summary>

When an executor ran the run on other machines (`@vzn/vx-dte`'s
workers), a Workers table shows, for each one:

- Its status, and when it was asked for.
- Its total time (warm-up plus online), and its warm-up.
- Its time online after the warm-up, and the part of that with no task
  on it.
- A task counts from its send to its result, restore and save included.
- Its tasks.
- The cores its tasks were expected to use (their last run's), beside
  the cores it used.
- Its peak RAM of its memory.
- Its machine's cpu utilization from its first task's send to its last
  one's end.

Under the table, a line gives the expected and used share of all their
core-time. The expected share is over the workers whose executor
reports one.

Tasks the executor left to the run's own machine get a `this machine`
row. A line splits the executed count between workers and this
machine.

</details>

A run that starts no task writes no block. It says its one line in the
step's log, which is where to look:

- `nothing affected since <ref>` (exit 0).
- A refusal before the run: a lockfile changed since `vx lock`, or an
  `--affected` base the clone lacks.

Anywhere else (`GITHUB_ACTIONS` not `true`: laptops, other CI),
`github()` returns `undefined`, which `plugins` skips.

- Nothing loads, so declaring it unconditionally is safe.
- Its options are still checked there, so a typo fails on a laptop, not
  first on CI.

## Options

You pass options to `github()`; each has a default.

- The options type is `GithubPluginOptions`.
- `renderJobSummary` renders the summary lines the plugin posts. The
  site's CI guide sample is rendered from it.
- The package exports `github`, `gitlab`, `renderJobSummary` and the
  types `GithubPluginOptions` and `GitlabPluginOptions`; nothing else.

```ts
github({
  summaryFile: '/path/override.md', // default: $GITHUB_STEP_SUMMARY
  title: 'build & test', // default: 'vx run'
  cacheScope: false, // default: on; scope plugin cache entries by ref
})
```

## Cache scope

On Actions (`GITHUB_ACTIONS=true`), the plugin names the run's branch.
For example, a push to `feat-x` in `acme/app` names `acme/app:feat-x`.

- The plugin's `config` stage names it through `ctx.setBranch`.
- It reads the ref (`GITHUB_REF`, `GITHUB_REF_NAME`, `GITHUB_HEAD_REF`,
  `GITHUB_REPOSITORY`) and the `GITHUB_EVENT_PATH` payload.
- A push to the default branch names no scope. The default branch is
  the workspace's `baseBranch`, else the event's.
- A push to, or a pull request from, a branch names
  `<owner>/<repo>:<branch>` of the repository the branch lives in.
- So a fork's pull request names the fork.
- The scope keys only what plugins store themselves (`ctx.cache`, run
  records).
- Task keys never carry it. The cache server decides from the CI OIDC
  token where a task's entry lands.
- `VX_CACHE_SCOPE` overrides it.

<details>
<summary>Details: other events</summary>

- A `pull_request_target` or `workflow_run` run on a PR's behalf names
  the PR's branch, in the repository it lives in, too.
- That is found by `GITHUB_EVENT_NAME`, though its ref is main's.
- An `issue_comment` on a PR, which names no branch, names `pr-<n>`.
- A pull request whose head repository is unknown (a deleted fork's is
  `null`) names `pr-<n>` too.
- It does not name the base repository's own branch of that name.
- A merge queue's run (`merge_group`) is trusted, whatever its
  `gh-readonly-queue/...` branch: no scope.
- It is compared with `merge_group.base_sha`.
- A pull request also names its base commit (`pull_request.base.sha`),
  the base of a bare `--affected`.

</details>

The plugin also names the refs a remote cache reads (`refs`), in this
order:

1. A pull request's merge ref, `refs/pull/<n>/merge`: the one scope its
   token writes.
2. The run's own branch: a pull request's head, including a
   `workflow_run` a pull request started, else `GITHUB_REF`.
3. The branch it merges into: `GITHUB_BASE_REF`, or that
   `workflow_run`'s pull request's base.
4. The default branch: the workspace's `baseBranch`, else the event's.

A merge queue's run reads only its base branch: `merge_group.base_ref`,
else the queue ref's `<base>`. It is about to become that branch, and
the server writes its entries there.

## GitLab CI

You add `gitlab()` beside `github()`; each acts only on its own CI.

```ts
// .vx/workspace.ts
import { defineWorkspace } from '@vzn/vx/config'
import { github, gitlab } from '@vzn/vx-ci'

export default defineWorkspace({ plugins: [github(), gitlab()] })
```

On GitLab CI (`GITLAB_CI=true`), `gitlab()`'s `config` stage names the
run's branch through `ctx.setBranch`, as `github()` does on Actions. It
reads GitLab's predefined variables.

- The default branch names no scope. It is the workspace's
  `baseBranch`, else `CI_DEFAULT_BRANCH`.
- Another branch or a tag (`CI_COMMIT_TAG`) names `<project path>:<ref>`
  (`CI_PROJECT_PATH`, `CI_COMMIT_REF_NAME`).
- So a subgroup's project is `group/sub/app:feat-x`, the scope a laptop
  on `feat-x` derives.
- A merge request pipeline names its source branch
  (`CI_MERGE_REQUEST_SOURCE_BRANCH_NAME`) in the project it lives in.
- For a fork, that project is `CI_MERGE_REQUEST_SOURCE_PROJECT_PATH`.
- A merge train's pipeline (`CI_MERGE_REQUEST_EVENT_TYPE=merge_train`)
  builds what lands on the target, so it is trusted: no scope.
- As on Actions, the scope keys only plugin entries.
- `gitlab({ cacheScope: false })` (`GitlabPluginOptions`) turns it off.
  `VX_CACHE_SCOPE` overrides it.
- Anywhere else `gitlab()` returns `undefined`, so declaring both
  plugins is safe.
- Merge request comments and reports are not part of it yet.

<details>
<summary>Details: the base of a bare <code>--affected</code></summary>

A merge request pipeline also names the base of a bare `--affected`:

- Its diff base, `CI_MERGE_REQUEST_DIFF_BASE_SHA`.
- In a merged results pipeline, the target head it merged onto
  (`CI_MERGE_REQUEST_TARGET_BRANCH_SHA`). So changes the target took
  since are not run again.
- In a merge train, the car ahead (`HEAD^1`), whose own pipeline runs
  its changes.

</details>

A remote reads these refs, in order:

1. The tag, else the merge request's source branch, else
   `CI_COMMIT_REF_NAME`.
2. The target: `CI_MERGE_REQUEST_TARGET_BRANCH_NAME`, or an external
   pull request's `CI_EXTERNAL_PULL_REQUEST_TARGET_BRANCH_NAME`.
3. The default branch: `baseBranch`, else `CI_DEFAULT_BRANCH`.

A merge train reads only its target.

## The sandbox runtime: `vx setup`

A task that declares `exec.sandbox` needs the OS sandbox on the machine
that runs it. One step before vx runs sets it up:

```yaml
# GitHub Actions
- run: bun vx setup github
```

```yaml
# GitLab CI
script:
  - bun vx setup gitlab
```

- On Linux the sandbox is bubblewrap, socat, strace and ripgrep, with
  bwrap allowed its user namespaces.
- On macOS the sandbox is built in and the step does nothing.
- The step installs what is missing, by apt-get with sudo, or apk.
- It lets bwrap make user namespaces where AppArmor restricts them
  (Ubuntu 24+).
- Ubuntu 26's `bwrap-userns-restrict` profile is replaced, as it strips
  the namespace the sandbox nests.
- It proves bwrap starts a sandbox, failing the step if it cannot.

The packages it fetched stay in a directory the job's cache can keep:

- `~/.cache/vx/setup-debs` on Actions.
- `.vx-setup-debs` under `CI_PROJECT_DIR` on GitLab.
- Or `--debs <dir>`.

<details>
<summary>Details: reusing the fetched packages</summary>

- When that directory holds the packages, they install with no index
  fetch.
- They are fetched again when they do not install (an older image's) or
  leave a tool missing (one that image had already).
- The directory holds a `*` `.gitignore`, so no task's inputs read it.
  On GitLab it sits in the checkout.
- On Actions, the step's outputs, written to `GITHUB_OUTPUT`, are
  `fetched` and `key`. So a cache step saves only what it fetched.
- `key` is `vx-setup-debs-<RUNNER_OS>-<RUNNER_ARCH>-<image>-<version>`,
  the runner image's, which the restore prefix below finds.

</details>

Save only from the default branch's own runs:

- The restored debs install as root with `dpkg -i`, which checks no
  signature.
- A restore takes the newest key of the prefix.
- So a pull request's code saving there would reach every later job.

```yaml
- uses: actions/cache/restore@v5
  with:
    path: ~/.cache/vx/setup-debs
    key: vx-setup-debs-${{ runner.os }}-${{ runner.arch }}
    restore-keys: vx-setup-debs-${{ runner.os }}-${{ runner.arch }}-
- id: setup
  run: bun vx setup github
- if: steps.setup.outputs.fetched == 'true' && github.ref == 'refs/heads/main'
  uses: actions/cache/save@v5
  with:
    path: ~/.cache/vx/setup-debs
    key: ${{ steps.setup.outputs.key }}
```

The verb is the plugin's. Core has no `setup` verb.

- `vx setup github` exists where `github()` is declared and the job is
  on Actions.
- `vx setup gitlab` exists where `gitlab()` is declared and the job is
  on GitLab CI.

## How it works

`github()` adds one telemetry sink through vx's `telemetry` hook. It
only observes the run.

- It receives the versioned `RunSummaryRecord` at run end, and renders
  and appends the markdown in `flush()`.
- It holds no run handle and streams no per-event records
  (`wants: []`).
- A slow or failing write can never fail or stall the run. Core isolates
  a sink's crash and bounds its flush with a deadline.

The job summary is bounded by GitHub's own limit, because exceeding it
loses the whole page rather than its tail.

- The limit is 1 MiB counted in bytes: about 19 000 task rows, fewer
  when task names are not ASCII.
- The summary is cut on a character boundary.
- GitHub's cap is the step's whole summary file. So the page fits in
  what earlier writers in the step left.
- With no room, the summary is skipped with a warning.
- Past the limit, what is written ends with a line saying it was
  truncated.
