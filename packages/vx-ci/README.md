# @vzn/vx-ci

Website: <https://vznjs.github.io/vx/> · this plugin: <https://vznjs.github.io/vx/plugins/vx-ci/> · source: <https://github.com/vznjs/vx>

GitHub Actions and GitLab CI integration for [`@vzn/vx`](https://vznjs.github.io/vx/):
`github()` writes every `vx run` as a **job summary** on the workflow run
page and names the run's cache scope; `gitlab()` names the run's cache
scope on GitLab CI ([below](#gitlab-ci)).

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

That's the whole setup. On a GitHub Actions runner (`GITHUB_STEP_SUMMARY`
set) every `vx run` appends a summary block, on its own line after
anything already written in the step: verdict headline, stats
(tasks / executed / cache hits / duration, and the ideal time an executor says
the run could have taken, as `@vzn/vx-dte` replays it), failures called out above the
per-task table (rows by status, failures first, then the longest first) with their exit code, the signal an exit above 128
stands for (`exit 137 (128 + SIGKILL)`, as the run's own frame and
`vx last` say it), a timeout as `timed out, exit 143`, a persistent task
that never became ready as `never ready (timed out)`, a sandboxed task's
violation count, and the tasks each failure blocked. A server a
DTE run carried to its dependants' workers reads `served`,
with no duration of its own. When an executor
ran the run on other machines (`@vzn/vx-dte`'s workers), a Workers table
shows each one's status, when it was asked for, its total time (warm-up
plus online), its warm-up, its time online after the warm-up and the part
of that with no task on it (a task counts from its send to its result,
restore and save included), its tasks, the cores
its tasks were expected to use (their last run's) beside the cores it used, its peak RAM of its memory, and
its utilization, under a line
of the expected and used share of all their core-time (the expected share over the workers whose executor reports one). Tasks the executor left to the run's own machine get a `this machine` row, and a line splits the executed count between workers and this machine. A footer line
names the vx version, the command (what follows `--` counted, not
quoted), tasks passed and outputs restored.
Anywhere else (`GITHUB_ACTIONS` not `true`: laptops, other CI)
`github()` returns `undefined`, which `plugins` skips: no option is
checked and nothing loads, so declaring it unconditionally is safe.

## Options

The options type is `GithubPluginOptions`; `renderJobSummary` renders the
summary lines the plugin posts (the site's CI guide sample is rendered from it).
The package exports `github`, `gitlab`, `renderJobSummary` and the types
`GithubPluginOptions` and `GitlabPluginOptions`; nothing else.

```ts
github({
  summaryFile: '/path/override.md', // default: $GITHUB_STEP_SUMMARY
  title: 'build & test', // default: 'vx run'
  cacheScope: false, // default: on; scope plugin cache entries by ref
})
```

## Cache scope

On Actions (`GITHUB_ACTIONS=true`) the plugin's `config` stage names the
run's branch through `ctx.setBranch`, from the ref (`GITHUB_REF`,
`GITHUB_REF_NAME`, `GITHUB_HEAD_REF`, `GITHUB_REPOSITORY`) and the
`GITHUB_EVENT_PATH` payload. A push to the default branch (the
workspace's `baseBranch`, else the event's) names no scope.
A push to, or a pull request from, a branch names
`<owner>/<repo>:<branch>` of the repository the branch lives in, so a
fork's pull request names the fork; so does a `pull_request_target` or
`workflow_run` run on a PR's behalf (by `GITHUB_EVENT_NAME`, though its
ref is main's), and an `issue_comment` on a PR, which names no branch,
`pr-<n>`. A merge queue's run (`merge_group`) is trusted: no scope,
whatever its `gh-readonly-queue/...` branch, compared with
`merge_group.base_sha`. A pull request also names its base commit
(`pull_request.base.sha`), the base of a bare `--affected`. The scope
keys only what plugins store themselves (`ctx.cache`, run records):
task keys never carry it, and the cache server decides from the CI OIDC
token where a task's entry lands. `VX_CACHE_SCOPE` overrides it.

It also names the refs a remote cache reads, in order (`refs`): a pull
request's merge ref (`refs/pull/<n>/merge`, the one scope its token
writes), then the run's own branch (a pull request's head, else
`GITHUB_REF`), then the
branch it merges into (`GITHUB_BASE_REF`), then the default branch (the
workspace's `baseBranch`, else the event's). A merge queue's run reads
only its base branch (`merge_group.base_ref`, else the queue ref's
`<base>`): it is about to become that branch, and the server writes its
entries there.

## GitLab CI

```ts
// .vx/workspace.ts
import { defineWorkspace } from '@vzn/vx/config'
import { github, gitlab } from '@vzn/vx-ci'

export default defineWorkspace({ plugins: [github(), gitlab()] })
```

On GitLab CI (`GITLAB_CI=true`) `gitlab()`'s `config` stage names the
run's branch through `ctx.setBranch`, from GitLab's predefined
variables, as `github()` does on Actions. The default branch
(`CI_DEFAULT_BRANCH`) names no scope. Another branch or a tag (`CI_COMMIT_TAG`) names
`<project path>:<ref>` (`CI_PROJECT_PATH`, `CI_COMMIT_REF_NAME`), so a
subgroup's project is `group/sub/app:feat-x`, the scope a laptop on
`feat-x` derives. A merge request pipeline names its source branch
(`CI_MERGE_REQUEST_SOURCE_BRANCH_NAME`) in the project it lives in (a
fork's `CI_MERGE_REQUEST_SOURCE_PROJECT_PATH`) and its diff base
(`CI_MERGE_REQUEST_DIFF_BASE_SHA`), the base of a bare `--affected`.
A merge train's pipeline (`CI_MERGE_REQUEST_EVENT_TYPE=merge_train`)
builds what lands on the target, so it is trusted: no scope. As on
Actions, the scope keys only plugin entries. A remote reads the tag, else
the merge request's source branch, else `CI_COMMIT_REF_NAME`, then the
target (`CI_MERGE_REQUEST_TARGET_BRANCH_NAME`, an external pull
request's `CI_EXTERNAL_PULL_REQUEST_TARGET_BRANCH_NAME`), then the default branch
(`baseBranch`, else `CI_DEFAULT_BRANCH`); a merge train reads only its
target. `gitlab({ cacheScope: false })` (`GitlabPluginOptions`) turns it off;
`VX_CACHE_SCOPE` overrides it. Anywhere else `gitlab()` returns
`undefined`, so declaring both plugins is safe. Merge request comments
and reports are not part of it yet.

## The sandbox runtime: `vx setup`

A task that declares `exec.sandbox` needs the OS sandbox on the machine
that runs it. On Linux that is bubblewrap, socat, strace and ripgrep,
with bwrap allowed its user namespaces. One step before vx runs sets it
up:

```yaml
# GitHub Actions
- run: vx setup github
```

```yaml
# GitLab CI
script:
  - vx setup gitlab
```

It installs what is missing (apt-get by sudo, or apk), lets bwrap make
user namespaces where AppArmor restricts them (Ubuntu 24+; Ubuntu 26's
`bwrap-userns-restrict` profile is replaced, as it strips the namespace
the sandbox nests), and proves bwrap starts a sandbox, failing the step
if it cannot. On macOS the sandbox is built in and it does nothing.

The packages it fetched stay in a directory the job's cache can keep:
`~/.cache/vx/setup-debs` on Actions, `.vx-setup-debs` under
`CI_PROJECT_DIR` on GitLab, or `--debs <dir>`. When that directory holds them, they install
with no index fetch; when they do not install (an older image's) or
leave a tool missing (one that image had already), they are fetched
again. The directory holds a `*` `.gitignore`, so no task's inputs
read it (on GitLab it sits in the checkout). On Actions the step's outputs, written to
`GITHUB_OUTPUT`, are `fetched` and `key`
(`vx-setup-debs-<RUNNER_OS>-<RUNNER_ARCH>-<image>-<version>`, the
runner image's, which the restore prefix below finds), so a cache step
saves only what it fetched:

```yaml
- uses: actions/cache/restore@v5
  with:
    path: ~/.cache/vx/setup-debs
    key: vx-setup-debs-${{ runner.os }}-${{ runner.arch }}
    restore-keys: vx-setup-debs-${{ runner.os }}-${{ runner.arch }}-
- id: setup
  run: vx setup github
- if: steps.setup.outputs.fetched == 'true'
  uses: actions/cache/save@v5
  with:
    path: ~/.cache/vx/setup-debs
    key: ${{ steps.setup.outputs.key }}
```

The verb is the plugin's: `vx setup github` exists where `github()` is
declared and the job is on Actions, `vx setup gitlab` where `gitlab()` is
and the job is on GitLab CI. Core has no `setup` verb.

## How it works

`github()` contributes one observe-only telemetry sink through vx's
`telemetry` hook. It receives the versioned `RunSummaryRecord` at run end
and renders + appends the markdown in `flush()` — it holds no run handle,
streams no per-event records (`wants: []`), and a slow or failing write can
never fail or stall the run (core's crash-isolation + flush deadline).

The job summary is bounded by GitHub's own limit, because exceeding it
loses the whole page rather than its tail: 1 MiB counted in bytes (about 19 000 task rows; fewer when task names are not ASCII), cut on a character boundary. GitHub's cap is the step's whole summary file, so the page fits in what earlier writers in the step left; with no room it is skipped with a warning.
Past it, what is written ends with a line saying it was truncated.
