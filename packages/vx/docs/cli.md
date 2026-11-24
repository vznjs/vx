# CLI reference

Every `vx` command, flag and output. Each command has its own section below.

```sh
# The prebuilt standalone binary; inside a project
# that installs @vzn/vx, it runs that one (§ Which vx runs):
bun add -g @vzn/vx

# From source (Bun ≥ 1.4.4):
bun src/bin.ts --version
```

vx needs Bun 1.4.4 or newer. The released binary carries its own Bun, so
this only matters when you run vx from source or through your own Bun.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- Older Bun: vx still starts, and the `bun` row of `vx info` warns.
- What breaks on an older Bun is the output:
  - a large `--format json` write is cut off;
  - no task reports what it used;
  - a config syntax error shows as an internal error.
- The released binary never warns: its Bun is new enough.
- [`modules/util.md`](./modules/util.md#srcutilbun-versionts--the-runtime-floor-read-at-run-time)
  has the measurements.

</div>
</details>

## Top-level shape

```sh
# Core
vx run [OPTIONS] [TASK | PKG#TASK ...] [-- forwarded-args...]
vx watch [OPTIONS] [--poll] TASK [-- forwarded-args...]
vx pipeline NAME [OPTIONS]
vx cache clean [--older-than <duration>] [--max-size <size>] [--global] [--dry] [--format pretty|json] [--cache-dir <path>]
vx lock [--check] [--format pretty|json]
vx init [--dry [--format pretty|json]] [--force] [--mjs] [--native|--keep] [--plugin <hook>]
vx show [PROJECT[#TASK] | TASK] [--filter <pattern>] [--affected[=<base>]] [--format pretty|json]
vx info [--format pretty|json] [--cache-dir <path>]
vx why (TASK | PKG#TASK) [--run RUNID] [--format pretty|json] [--cache-dir <path>]
vx last [RUNID] [--list[=N]] [--failed] [--log <task>] [--stats [<task>] [--branch <name>]] [--sql <query>] [--live [--follow]] [--format pretty|json] [--cache-dir <path>]
vx upgrade [TAG] [-g|--global]
vx docs <query> [--limit N] [--format pretty|json]
vx completions bash|zsh|fish

# Meta
vx                    # in a workspace, vx --help; outside one, says so and exits 1
vx help [VERB]
vx --help, -h
vx version
vx --version
```

Each line above is the usage line `vx <verb> --help` prints, word for
word. A verb accepts the flags its line names.

### Several tasks at once

`vx run` takes several task names and runs them as one graph.

```sh
vx run build lint test        # three tasks in the cwd project
vx run @demo/web#build        # one project's task
```

| Write         | Means                                                   |
| ------------- | ------------------------------------------------------- |
| `build`       | `build` in the cwd project, or where a selection points |
| `pkg#build`   | `build` in the project `pkg` only                       |
| `build --all` | `build` in every project that declares it               |

A bare name goes where `--all`, `--filter` or `--affected` points.
Without them it runs in the cwd project.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- The cwd project is the deepest project that holds the directory.
- `packages/b -> ../ext/b`: a project reached through a link counts too.

</div>
</details>

### Every name must resolve

A name that matches no project in scope stops the run before it starts.
`vx run` and `--dry` both exit 1 and print to stderr:

```text
vx run: no projects declare task(s): <name>.
```

A name some projects lack is fine: the check fires only when it matches
nowhere. So `vx run lint test e2e` fails on CI the day `e2e` is renamed.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `Did you mean <task>?`: a declared task within two edits, in any
  project. For `pkg#task`, a runnable one.
- When only projects outside the run's selection declare it, the hint
  says so and names `--all` or `--filter`.
- `p/a#build` hints `alpha#build` when `alpha` lives at `p/a`: a
  directory from the root names its project.
- `Tasks: build, test.`: nothing is close, so the refusal lists what
  exists.
- `No project is named zzz; projects: a, b.`: an unknown `pkg`.
- `a's tasks: build, test.`: a known `pkg` without that task.
- ``No project declares a task yet: add one under `tasks` in a vx.config,
then run `vx lock`.``: no task anywhere, as right after `vx init`.
- `café` typed in NFC, the folder in NFD: the refusal says the two differ
  in Unicode form. Fix: set `name` in that vx.config.
- ``A run reads the lock: after editing a vx.config, run `vx lock`.``:
  otherwise, since a task added after the last lock is not in it.
- `Only projects outside the selection declare <name> — pass --all, or a
--filter that includes them.`: the run was scoped and only projects
  outside it declare the name.
- `— widen --filter to include them, or drop it.`: the same, when
  `--filter` scoped the run. A pipeline counts: it passes `--all`.
- `--all` beside `--filter` is the filter's selection, so the refusal
  does not suggest it there.
- After a scoped refusal comes the lock line too: a task newly added to a
  selected project is not in the lock yet.
- A selected project whose `build` is the default one (a root with an
  empty config) is named instead. `vx show` counts that build; no bare
  name runs it.
- `vx run ''`: an empty name is refused before the lookup.
- `vx run 'build '`: a name with surrounding whitespace is refused too.
  The refusal quotes it so the space shows.

</div>
</details>

### Names under `--affected`

With `--affected` or a `[ref]` filter, a bare name is checked against
the whole workspace: what changed decides the projects.

```sh
vx run test --affected
```

| Result                                | Exit | Says                                                 |
| ------------------------------------- | ---- | ---------------------------------------------------- |
| no changed project declares `test`    | 0    | `No affected project declares task(s): test.`        |
| the change reaches no `test` task     | 0    | `Nothing affected: the change reaches no test task.` |
| the diff touched no project           | 0    | `nothing affected since <ref>` (stderr)              |
| no project anywhere declares the name | 1    | the refusal above                                    |

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `nothing affected since <ref>` prints only once each bare name is found
  declared somewhere.
- `nothing @demo/web[main] selects changed since main; the change reached
@demo/ui`: the diff touched only projects the selector leaves out.

</div>
</details>

### Help and `--`

`vx <verb> --help` prints this reference for that verb: its usage lines
and its sections, then `Full reference: vx help`.

```sh
vx run --help
vx run build -- --watch     # --watch goes to the task
```

After `--`, every flag belongs to the task.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `-h`, `vx help <verb>` and `vx --help <verb>` print the same.
- A section several verbs share prints only that verb's own entries.
- Every argument error points at the help.
- `vx help <plugin verb>` is `vx <plugin verb> --help`: the plugin answers.
- `vx help <name>`, no verb by that name: refused like `vx <name>`, one
  line, a guess when one is close, exit 1.
- `vx help run lock`: a second word after the verb is refused.
- `vx run build -- --help` passes `--help` to the task.
- A plugin verb reads its own arguments, `--help` included.
- `-V`: there is none. Use `vx --version`.

</div>
</details>

## `vx run`

`vx run` runs the named tasks in dependency order and skips any whose
inputs did not change.

By default it runs the project holding the current directory, plus what
its `dependsOn` needs from other projects. `--all`, `--filter`,
`--affected` or a `pkg#task` choose other projects.

### Usage

```sh
vx run [OPTIONS] [TASK | PKG#TASK ...] [-- forwarded-args...]
```

### Examples

```sh
vx run build                  # the cwd project's build, and what it depends on
vx run build --all            # every project that declares build
vx run test --affected        # only what this branch changed, and its dependents
vx run @demo/web#build lint   # one project's build, and lint in scope
vx run test -- --watch=false  # forward arguments to the task
```

The first run executes and saves; the next finds nothing changed:

```sh
vx run build --all
```

```ansi

[4m[58;2;110;118;129m  [1m[38;2;167;139;250mTasks[0m[4m[58;2;110;118;129m     [2mstatus  cache     ±usual    time   cpu    mem outputs  blocks worker         task[0m[4m[58;2;110;118;129m                           [0m
            [38;2;34;197;94msuccess[0m [2mmiss[0m           [2m—[0m   [38;2;203;213;225m153ms[0m  [2m112%[0m  [2m110MB[0m     [2m89B[0m       [38;2;203;213;225m1[0m [2mlocal[0m          [38;2;192;132;252m@demo/ui[0m[2m#[0m[38;2;244;114;182mbuild[0m
            [38;2;34;197;94msuccess[0m [2mmiss[0m           [2m—[0m   [38;2;203;213;225m141ms[0m  [2m115%[0m  [2m108MB[0m    [2m115B[0m       [2m0[0m [2mlocal[0m          [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;244;114;182mbuild[0m


[4m[58;2;110;118;129m  [1m[38;2;167;139;250mSummary[0m[4m[58;2;110;118;129m                                                                                                       [2mvx 0.0.0[0m
  [2mprojects[0m  [38;2;234;179;8m▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰[0m
            [38;2;234;179;8m2 in run[0m [2m·[0m [2m2 total[0m
  [2mtasks   [0m  [38;2;34;197;94m▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰[0m
            [38;2;34;197;94m2 success[0m [2m·[0m [2m2 total[0m
  [2mcache   [0m  [38;2;56;189;248m▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰[0m
            [2mlocal[0m [38;2;56;189;248m2↑[0m

  [2minfo    [0m  4 workers [2m·[0m local cache [2m·[0m run 01a20a09-a545-7387-b09d-f1fd478d50f0
  [2mtime    [0m  333ms [2m·[0m [2mmax 153ms[0m [2m·[0m [2mavg 147ms[0m [2m·[0m [2mmin 141ms[0m
```

```sh
vx run build --all
```

```ansi


[4m[58;2;110;118;129m  [1m[38;2;167;139;250mSummary[0m[4m[58;2;110;118;129m                                                                                                       [2mvx 0.0.0[0m
  [2mprojects[0m  [38;2;234;179;8m▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰[0m
            [38;2;234;179;8m2 in run[0m [2m·[0m [2m2 total[0m
  [2mtasks   [0m  [38;2;34;197;94m▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰[0m
            [38;2;34;197;94m2 success[0m [2m·[0m [2m2 total[0m
  [2mcache   [0m  [38;2;34;197;94m▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰[0m
            [2mlocal[0m [38;2;34;197;94m2✓[0m

  [2minfo    [0m  4 workers [2m·[0m local cache [2m·[0m run 01a20a09-a737-7148-8c91-0e392691edef
  [2mtime    [0m  18ms
```

The [Flags](#flags) table lists every option.

### No task: the picker

With no task name, `vx run` shows a numbered list of every task and runs
the one you pick.

```sh
vx run                  # pick from every pkg#task, with its description
vx run --filter @demo/web   # pick from @demo/web's tasks only
```

Off a terminal (a pipe, CI) there is no list: name the task.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- **In a TTY**: a picker lists every `pkg#task` in the workspace, each
  with its `description`, and runs the number you type.
- `--filter` or `--affected`: the picker lists only the selected projects.
- `--affected` that selects nothing exits `0`.
- `vx run > out.txt` still asks: the menu goes to stderr.
- Ctrl-C exits `130`, as an interrupted run does.
- Ctrl-D exits `1` with `no task picked`.
- A workspace with no task exits `1` and says how to declare one
  (under `tasks` in a vx.config, or `vx init`).
- **Not a TTY**: exits `1` with
  `missing task name (stdin is not a TTY, so no picker; tasks here: build, test)`.
- Outside any project it names every project's tasks:
  `not inside a project, the workspace's tasks with --all: build, test`.
- The list stops at twelve names, then `and N more`.
- Under `--all` it names `every project's tasks: …`.
- Under `--filter` or `--affected` it names
  `the selected projects' tasks: …`, or why nothing was selected.
- Outside a workspace it reads `vx run <task>, e.g. vx run build`.
- **Under `--dry --format json`**, on a terminal too, the same refusal
  (`a JSON answer opens no picker; …`): a program cannot pick.
- That refusal puts the `VX_E_USAGE` error document on stdout.

</div>
</details>

### Selection

By default `vx run` runs the task in the project you are standing in.
These forms pick other projects.

```sh
cd packages/web && vx run build   # @demo/web's build, and what it needs
vx run @demo/ui#build              # one project's task, from anywhere
vx run build --all                 # every project that declares build
```

| Form                          | Runs                                                                   |
| ----------------------------- | ---------------------------------------------------------------------- |
| (default)                     | The project that holds the current directory.                          |
| `pkg#task`                    | That task in that project only.                                        |
| `//#task`                     | The root project's task (the root is a project).                       |
| `--all`                       | Every project that declares the task.                                  |
| `--filter <pat>` (repeatable) | The projects a pattern picks (see [Filter DSL](#filter-dsl---filter)). |
| `--affected[=<base>]`         | The tasks a git change reaches (see below).                            |

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- The default errors when the current directory is not inside a project.
- `--affected` picks the tasks the change touches, and those whose
  `dependsOn` closure holds one.
- It follows the edges their keys fold (`inputs.tasks`).
- Every include (`--filter <pat>`, `--affected`) is taken first, then
  every `!` exclude, so an exclude removes what any include added.
- Includes add up: `--affected --filter other` runs other's tasks
  whether or not the change reaches them.
- `--all` with a filter is the filter's selection: `--all --filter
'!docs'` is everything but docs.

</div>
</details>

### Filter DSL (`--filter`)

`--filter` picks projects by name, folder, tag, dependency or git change.

```sh
vx run build --filter @demo/web       # one project
vx run build --filter './packages/*'  # every project in packages/
vx run build --filter @demo/web...    # @demo/web and what it depends on
vx run build --filter '!docs'         # everything but docs
```

| Form               | Picks                                                        |
| ------------------ | ------------------------------------------------------------ |
| `<pattern>`        | Projects by package name; `*` matches any characters.        |
| `./<dir>`          | The package at `<dir>` (`.` is the root project).            |
| `{<dir>}`          | Same as `./<dir>`.                                           |
| `<pattern>{<dir>}` | The packages `<pattern>` picks inside `<dir>`.               |
| `./<glob>`         | A glob over project folders: `./packages/*`.                 |
| `.`                | The root project alone, when the root is a project.          |
| `//`               | The root project alone.                                      |
| `tag:<pattern>`    | The projects whose config `tags` hold a match.               |
| `<pattern>...`     | Match + all transitive dependencies.                         |
| `...<pattern>`     | Match + all transitive dependents.                           |
| `<pattern>^...`    | Only the transitive dependencies, not the match itself.      |
| `...^<pattern>`    | Only the transitive dependents, not the match itself.        |
| `...<pattern>...`  | Match + its dependents + the dependencies of all of them.    |
| `<sel>[<ref>]`     | The packages `<sel>` picks that changed since `<ref>`.       |
| `<sel>...[<ref>]`  | Those that changed since `<ref>`, or depend on one that did. |
| `!<pattern>`       | Exclude packages matching `<pattern>`.                       |
| `[<git-ref>]`      | Projects whose files changed since `<git-ref>`.              |

Default: none; with no filter, `vx run` uses the current project.

More examples:

```sh
vx run build --filter @scope/*                # all packages under @scope
vx run build --filter @demo/web...                  # @demo/web and its transitive deps
vx run build --filter ...util                 # util and everything depending on it
vx run build --filter @demo/web^...                 # only @demo/web's deps (not itself)
vx run build --filter '*' --filter '!docs'    # everything except docs
vx run build --filter '[origin/main]'         # projects with files changed since main
```

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

Names:

- `*` matches any characters, including `/`.
- `cart` is `@acme/cart` when one package carries that name: a pattern
  matching no package may leave out the scope.
- `apps/*` is `./apps/*`: a pattern holding a `/` outside a scope that
  matches no package is a directory.

Folders:

- `./packages/web` is that package alone; a `<dir>` that is no package
  matches the packages under it.
- A `<dir>` is relative to the workspace root.
- A link to a package's directory names that package.
- `@acme/*{apps}` and `*web*{./packages/*}` pick by name inside a
  folder. `<pattern>{<dir>}` takes every operator a name takes.
- `./packages/*` holds direct children; `{apps/**}` nested ones too.
- `./packages/kit/**` holds kit itself: a trailing `**` matches zero dirs.
- `./packages/[abc]` is that directory: a path that names a project dir
  literally is read literally first.
- A glob matches a package's real directory and follows no link.
- With `packages/l -> ../ext/l`, `./packages/l` names l, while
  `./packages/*` and `./packages/l/**` leave it out (`./ext/*` holds it).
- `.` with no root project means the packages under the root: every
  package, not the one you are standing in.
- `//` matches nothing when the root is no project.

Tags:

- `tag:*` matches as `*` does in a name.
- `tag:` takes every operator a name takes: `!tag:x`, `...tag:x`,
  `tag:x^...`, `tag:x[main]`.
- A pasted `--projects tag:x` is refused with a hint: write `--filter tag:x`.

Dependencies and changes:

- `...db...` takes the packages the apps that use db build on.
- `@scope/*[main]` is the packages under `@scope` that changed since main.
- `@demo/api...[HEAD]` is api when only its dependency changed: no
  dependency is added.
- `!<pattern>` excludes from everything the includes select, in any order.
- `[<git-ref>]` takes any ref: `main`, `HEAD~5`, ….

Where a dependency comes from:

- **A plugin.** A `discover` entry's `deps` (order and selection) or
  `reach` (selection only).
- The lockfile plugins (`bun()`, `pnpm()`, `npm()`, `yarn()` from
  `@vzn/vx-lockfile`) supply what the package manager installed.
- vx reads none from a `package.json` itself.
- **A cross-project `dependsOn`.** `e2e`'s `test: {
dependsOn: ['@demo/web#build'] }` makes `e2e` a dependent of `@demo/web`.
- Filters follow both: `vx run test --filter '...@demo/web'` runs
  `e2e#test` even though no plugin links `e2e` to `@demo/web`.
- There is no `implicitDependencies` field: declare the dependency on the task.

Refusals:

- A filter that matches nothing refuses the run with `no projects matched
filter(s): …`, plus a hint: running the rest would hide the typo.
- That holds beside filters that matched (`--filter ui --filter nope`
  refuses, naming `nope`) and for an exclusion (`!nope`).
- A filter that names no project (`...`, a bare `!`, an empty `{}`) is refused.
- A path that climbs out of the root (`../`, `{..}`) is refused.
- A filter holding a control character is refused.
- `@demo/web^...[main]` is refused: write `@demo/web[main]^...`, the
  dependencies of a changed app. `^...` never goes before a git ref.
- One whose pattern matched but selected nothing says what it matched:
  `no projects selected: filter "...^core" matched core, and no
project depends on it`.
- When an exclusion took back everything the filters matched, it names
  it: `no projects
selected: !@demo/web excluded every project the other filters matched`.

Hints:

- `Did you mean <name>?` when a project name is within two edits.
- The same hint when one scoped name matches after its `/`
  (`--filter vx-otel` hints `@vzn/vx-otel`).
- The hint is the pattern as typed with the name put right, operators
  kept (`--filter @demo/wbe...` hints `@demo/web...`).
- A task id (`--filter @demo/web#build`) hints its project: a filter names projects.
- A name only one project's name opens with hints that project
  (`--filter '!@m/slow'` hints `!@m/slow-tests`).
- `--filter a,b` hints `A filter is one pattern: --filter a --filter b`.
- `{a,b}` hints `--filter {a} --filter {b}`.
- A comma inside a glob's braces (`./packages/{a,b}`) is no list.
- From a subfolder, a path filter that names a project read from there
  hints the root-relative path.
- In `packages/`, `--filter ./lib` hints
  `A path filter is relative to the workspace root: did you mean ./packages/lib?`.
- Otherwise `Projects: a, b`: eight names, then a count.
- For a `tag:` filter, the nearest tag (`Did you mean tag:scope:web?`),
  else the list of tags.

</div>
</details>

### `--affected[=<base>]`

`--affected` runs only the tasks your git changes reach, and skips the rest.

```sh
vx run test --affected                # changes since the base branch
vx run test --affected=origin/main    # changes since origin/main
vx run lint test build --affected=origin/main
```

| Write                    | Compares against                             |
| ------------------------ | -------------------------------------------- |
| `--affected`             | a base picked for you (see below)            |
| `--affected=origin/main` | where your branch forked from `origin/main`  |
| `--affected=HEAD~1`      | the commit before this one                   |
| `--affected=<sha>`       | that commit, such as the last good one on CI |

Default: off. With no value, vx uses the first of these that applies:

1. `VX_AFFECTED_BASE`.
2. A plugin's base commit, such as a pull request's base.
3. The merge base of `HEAD` and `origin/<baseBranch>`.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

Picking the base:

- A `VX_AFFECTED_BASE` ref that does not resolve is named as its:
  `VX_AFFECTED_BASE=origin/develop: git ref "origin/develop" did not resolve`.
- A plugin's base is `setBranch({ base })`: `github()` gives a pull
  request's base, `nx()` `NX_BASE`, `turbo()` `TURBO_SCM_BASE`.
- On GitHub Actions, `turbo()` also gives the pull request's base branch
  or the push's `before`.
- `baseBranch` is `origin/HEAD`'s branch, then `main`, then `master`
  ([schema](schema.md)).
- In a clone with no remote, `baseBranch` is the local branch.
- The diff runs from the **merge base** of the ref and `HEAD`, so a
  branch sees only its own changes, never what others landed on `main`.
- Refs with no common ancestor diff from the ref.

On the base branch:

- On the base branch itself there is no default, so vx refuses.
- A detached HEAD the base branch holds (a CI checkout of a pushed
  commit) is on it too.
- The refusal: `--affected has no default
on the base branch (main): run --all (the cache skips what did not
change), or name the last good commit, --affected=<sha>`.
- `HEAD~1` would see only one commit of a multi-commit push.
- A rebase stopped on a conflict or an `edit` is on the branch it
  rebases, so the default base holds.
- CI on the base branch needs only the current commit: `--all` reads no
  history, and the cache runs only what changed.

Shallow and partial clones:

- A shallow clone needs no more history: vx fetches what the merge base
  needs, commits and trees only, no file contents.
- It deepens 1, 2, 4… commits until git finds the merge base.
- A pull request's merge checkout needs one fetch.
- A base it lacks is fetched as named: a commit id, `origin/<branch>`,
  or a tag (`v1`, `refs/tags/v1`).
- When origin cannot give that history, vx refuses (`has no merge
base with HEAD in this shallow clone`) rather than diff from the base's tip.
- A whole clone that fetched only its own branch (GitLab at any
  `GIT_DEPTH`, Jenkins "honor refspec") fetches the base branch, or the
  base you name, with the history the merge base needs.
- With no base branch and no origin to fetch from, vx says `--affected has
no base here`.
- When the fetch from origin failed, it says so with git's reason:
  `fetching it from origin failed (...)`.

Naming a base:

- `--affected=<ref>` uses the given git ref.
- `<base>...HEAD` reads as `<base>`.
- Two-dot `<base>..HEAD` diffs from `<base>` itself, not the merge base.
  A shallow clone fetches that commit as it fetches the merge base.
- A root tree (`main^{tree}`) is still a base.
- When the base you name is the commit you are on, the
  `nothing affected since <ref>` note says so and names the bases you
  probably meant (`--affected=origin/main`, `--affected=HEAD~1`).

Refused before git sees it:

- An empty value, or one starting with `-` (it would be a `git diff` option).
- A range not ending at HEAD (`HEAD~2..HEAD~1`, `main...feature`):
  `ranges are not supported — pass the base alone ("HEAD~2")`.
  The other end is always the working tree.
- An exclusion (`^main`), naming `main`.
- A path inside a commit (`main:packages`), naming the commit to pass.

Errors from git:

- A ref that does not exist is `git ref "<ref>" did not resolve`, with
  git's reason when it gives one. In a full clone it names up to six
  local branches to pass instead.
- `main@{9}` adds `log for 'main' only has 2
entries`.
- In a shallow clone it adds how to fetch it: `git fetch --depth=1 origin <base>`.
- With no origin remote: `git fetch --depth=1 <url> <base>` or
  `git remote add origin <url>`.
- Without git on `PATH`, it prints one line: `vx requires git:
failed to spawn 'git' … Install git and re-run`.
- Outside a git work tree it says `vx requires
git: <root> is not inside a git work tree`.
- A repository with no commit yet says so.
- In a linked worktree's git hook, which exports `GIT_DIR` and no
  `GIT_WORK_TREE`, vx's git finds the worktree's top as a plain `git` does.
  A workspace in a subfolder selects only what changed.
- A project whose directory is a symlink inside the workspace
  (`packages/b -> ../ext/b`) is selected by a change at the real place too.
- A link to outside the workspace is outside git's view.

</div>
</details>

**It selects the tasks the change reaches.** A change marks tasks in
the projects it touches. A requested task runs when its `dependsOn`
closure holds a marked task.

With `@demo/web#test` behind `^build`:

- an edit to `ui/src/button.ts`, which `ui#build` reads, runs `ui`'s
  tasks and `@demo/web#test`;
- an edit to `ui/src/button.test.ts`, which only `ui#test` reads, runs
  `ui#test` alone;
- `@demo/web#lint`, which depends on nothing, never runs for a change in `ui`.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

What a change marks:

- A cached task, when a changed path is one of its declared inputs
  (`files`, `workspaceFiles`).
- A cached task, when a changed path is a submodule or embedded
  repository its `workspaceFiles` may reach into.
- A task whose locked config moved when its project's `vx.config.*`
  changed, and every task without `inputs` there (below).
- Every task of a project that holds a changed path no task of its
  declares: vx cannot prove that path changes no key.
- An untracked file under a task's `outputs`, `files` or
  `workspaceFiles` is none of its inputs: the key folds only a tracked one.
- Every task of a project that holds a changed submodule or embedded repository.
- Every task of a project a lockfile plugin or a config import names.
  An install that added or removed a dependency shows as the lockfile's change.
- A task with no `inputs`, when a changed path lies in its project or
  the whole project is marked.
- A root file another task of its declares (`workspaceFiles`) is no
  change for a task with no `inputs`.
- A group marks nothing.

How it spreads:

- A change reaches another project only along a task's dependency.
- A `pkg#task` you name runs whatever the diff.
- This matches the cache key: a cached `@demo/web#test` with no
  dependency on `ui` never sees `ui`'s files either.
- A project with no `build` gets one keyed on all its files
  ([schema](schema.md)), so any change there reaches a dependent behind `^build`.
- A `graph` plugin's dependency or input works as a declared one.
- A task a `graph` plugin marks requested runs whatever the diff.
- With a `graph` plugin, every project is a candidate once the diff
  touched anything.

The filter forms select whole projects instead:

```bash
vx run test --affected                # the tasks the change reaches
vx run test --filter '...[main]'      # what changed + every dependent project
vx run test --filter '[main]'         # only the projects that changed
```

</div>
</details>

**What counts as a change:** what `git diff` against the base shows,
plus untracked files, so a new source file counts, as it does in the key.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- Untracked files come from `git ls-files
--others`.
- A submodule or embedded repository that git reports changed (a dirty
  or moved `vendor/sub`, an untracked `vendor/nested/`) selects every
  project under it, and the project holding it.
- A repository's `diff.ignoreSubmodules` or `submodule.<name>.ignore`
  does not apply: the key sees the change anyway.
- A file git was told not to look at (`git update-index
--assume-unchanged` or `--skip-worktree`) counts when its bytes on disk
  differ, as the key hashes them.
- A file a sparse checkout left out does not count.
- A run that needs a project the sparse checkout left out is refused
  (see [How runs read it](#how-runs-read-it)).
- A file a clean filter can rewrite (`core.autocrlf`, a `text`, `eol`,
  `ident`, `filter` or `working-tree-encoding` attribute) counts when
  git sees its stat move.
- That holds even if its filtered bytes match the base: the key hashes
  the raw bytes, so a CRLF edit to an LF file is a change.
- A symlinked input is its target: a link whose target changed is a change.
- A link to a target git cannot diff (outside the workspace, or
  ignored) is a change on every run.
- A link to a directory selects a task whose glob may reach below it
  (`src/**/*.ts` over `src/v`), as its key reads what is behind it.
- A gitignored file a task names (`.env.local`, `dist/**`) never
  selects it. The key still hashes it, so the task misses when it changed.

What `vx lock` writes:

- Left out, so `vx lock` never marks a project affected by itself:
  `.vx/projects.lock`, `.vx/dependencies.lock`, `.vx/.gitattributes`.
- Also left out: each project's `vx.lock.json` review copy, and the
  `<name>.tmp-<pid>-<x>` temp a killed write left beside one.
- So is the `.vx/.gitignore` `vx init` writes.
- `.vx/projects.lock` counts entry by entry when the base has one.
- A project whose name, edges, project-level fields or set of tasks
  changed is selected whole, with the lock as the reason shown.
- `vx lock` rewriting the same entries selects nothing.
- When only some tasks' locked configs moved, a config edit selects
  those tasks alone, with the config as the `input` shown.
- An edit to a file the config imports does the same, with
  `.vx/projects.lock` as the `input` shown.
- So changing `build`'s command does not re-run `test`.
- An edit that moves no locked task (a comment) selects none of its
  tasks with `inputs`.
- A task without `inputs` reads its whole project, the config too.

</div>
</details>

**A lockfile change selects what its plugin says.** Without a lockfile
plugin, a root `bun.lock` is a root file like any other.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- Core keys no lockfile and no install setting.
- Without a lockfile plugin, a change to the root `bun.lock` or
  `pnpm-lock.yaml` selects the root project (when the workspace has
  one), not every project.
- A lockfile inside a package selects only that package.
- A lockfile a plugin claims (`VxPlugin.fingerprint`, such as
  `pnpm-lock.yaml` under `@vzn/vx-lockfile`) is in the key.
- The key holds what the plugin says per project, so `--affected` gives
  the plugin the lockfile at the base and now, and selects the projects it names.
- The same goes for a file the lockfile names but does not pin: a patch
  `bun.lock` names, a `file:` directory dependency, or a linked directory.
- Only a plugin that cannot tell selects everything.
- `@vzn/vx-lockfile` selects everything for the install settings it
  claims: `.npmrc`, `bunfig.toml`, `pnpm-workspace.yaml`, `.yarnrc.yml`, `.yarnrc`.
- A changed lockfile is digested on both sides.
- Each side is memoized by its bytes' hash, so a side this machine has
  seen is not parsed again.

</div>
</details>

**A deleted project selects its dependants.** Their keys lost an upstream.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- The edge that named the dependants went with the project, so vx asks
  the base commit's `.vx/dependencies.lock` (written by `vx lock`) who linked to it.
- It selects those, naming the deleted `vx.config` as the reason.
- With no such file at the base, it selects every project.
- A project that moved is no deletion: its config, the same bytes in
  its new directory, selects only it, by its files.
- A dependency a plugin's `discover` drops without deleting a project
  is the plugin's to claim (`VxPlugin.fingerprint`, as the lockfile plugins do).

</div>
</details>

**A new nested project selects the project above it.** A project's
inputs stop at every project below it.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- A `vx.config.*`, or a `package.json` a `discover` plugin reads, that
  turns a directory into a project changes the key of the project that held it.
- So that project is selected too.
- "New" means none of the changed ones in that directory was there at the base.

</div>
</details>

**A workspace config change selects everything.** The plugins in
`.vx/workspace.*` shape every resolved config, so vx cannot tell which
key an edit there changes.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- So does an edit to a file it imports, directly or through another file.
- That includes a workspace package it imports by name (linked into
  `node_modules`, as `workspace:*` does).
- That includes a file above the workspace root in the same git repository.
- A root file a plugin reads without importing it counts when the
  plugin claims it (`VxPlugin.fingerprint`).
- `turbo()` claims `turbo.json` and `turbo.jsonc`, `nx()` claims
  `nx.json`, and either answers every project.

</div>
</details>

**A `.gitattributes` change selects every project under it.** Its
line-ending and filter rules change the bytes a checkout writes.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- git's blobs stay the same, so no input path moves, yet a fresh clone
  reads new bytes.
- The root one selects every project.
- One in `packages/` selects the projects in it.
- A project's own selects its every task.
- An edit that only touches attributes no checkout reads (`diff`,
  `merge`, `export-ignore`, `linguist-*`, a comment) selects nothing.

</div>
</details>

**A file your config imports selects that project.** Editing
`shared/preset.ts` selects every project whose config imports it.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- The key holds the resolved config, so a shared preset a `vx.config.*`
  imports is part of it.
- An import through another shared file counts too.
- The scan reads the source; it runs nothing.
- It follows relative imports (`'..'` included), and package.json
  `#imports` with a local target.
- It follows a bare import the nearest tsconfig maps through `paths` or `baseUrl`.
- Any other bare import is a package, which the lockfile covers.
- `vx watch` follows the same imports.
- It crosses projects as the config does: a config importing
  `../../packages/ui/preset.ts` is selected when that file, or one it
  imports, changes.
- To opt a project config's helper out, import it by a bare package
  name. See
  [`docs/modules/workspace.md`](./modules/workspace.md#srcworkspaceconfig-importsts--the-config-import-selection-channel).

</div>
</details>

**Nothing changed exits 0.** When only `--affected` or `[<ref>]`
selects and nothing matches, vx prints `nothing affected since <ref>`
and exits 0.

So a docs-only commit passes `vx run lint test build
--affected=origin/main`.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- When the diff matched but an exclusion or an empty walk took it all
  back, the note says so (`no projects selected: !@demo/web excluded every
project the other filters matched`).
- A name or path pattern that matches nothing is still an error, as a
  likely typo, with a ref too.
- `--filter 'nope[main]'` is refused when no project is named `nope`,
  whatever changed, and so is one beside a filter that matched.

</div>
</details>

**An empty selection never cancels an anchored task.** `vx run
@demo/web#deploy build --affected=origin/main` with nothing changed
still runs `@demo/web#deploy`.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- Project scope applies to bare names only.
- vx notes `nothing affected since <ref> — running @demo/web#deploy only` on stderr.
- Only a bare-name-only invocation short-circuits to exit 0.
- With only `pkg#task` names the scope goes unused, but `--filter` and
  `--affected` are still resolved.
- A pattern that matches nothing or a ref git does not know refuses the
  run as it does beside a bare name.

</div>
</details>

### Argument forwarding (`--`)

Anything after `--` goes to the task's command, added at its end.

```sh
vx run test -- --watch              # underlying test runner sees "--watch"
vx run build -- --sourcemap         # build command gets "--sourcemap"
```

With `test: 'vitest run'`, `vx run test -- -t button` runs
`vitest run -t button`. Only the task you name gets the args; the tasks
it depends on do not.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

Who gets them:

- The args are shell-quoted and appended to `exec.command`.
- Only `vx run` and `vx watch` forward, and only to one task in one project.
- With `--affected` or several tasks the run is refused
  (`forwarded args (after --) go to one task in one project`, `VX_E_USAGE`).
- A task named twice (`vx run test test -- -t adds`) is one task.
- A `--all` or `--filter` run that asks for the task in more than one
  project is refused once planned, naming them.
- That is because nothing says which command the args were meant for.
- Any other core verb refuses a `--` (`vx show forwards nothing after --`, `VX_E_USAGE`).
- A group (a task with no command) takes none, so a request that names
  only groups is refused (`args after \`--\` reach no task`).
- Forwarded args scope to user-requested tasks only; dependsOn-pulled
  deps don't see them, so upstream cache identity stays clean.
- A persistent task gets them too, with or without a `readyWhen`.

The cache key:

- Forwarded args are folded into the cache key: different args produce
  different cache entries.
- A frame's `$ <command>` line shows the command as it ran, so a
  requested task's carries the args and a dependency's does not.
- `--dry` shows that same command, quoted as the run quotes it: a
  `command` row under the task that gets the args, and `command` on
  every task with one in `--format json`.

A short flag before `--`:

- vx takes no short flag, so a `-x` before `--` that no vx flag hint
  claims is refused with the run that forwards it.
- `vx run test -t adds` prints `✗ vx run  unknown flag: -t`, `see vx run --help`
  and `fix  vx run test -- -t adds`.
- Only the flag and the words after it up to the next flag move; vx's
  own flags stay before `--`.
- `vx run test -t adds --concurrency 2` suggests
  `vx run test --concurrency 2 -- -t adds`.
- A run of many tasks, which forwards nothing, gets no suggestion.
- `-j`, `--jobs` and `--parallel` hint `--concurrency`.
- `-F`, `--scope` and `--projects` hint `--filter`.
- A long flag far from every vx flag gets no such guess: a typo of a vx
  flag forwarded would be ignored by the task unseen.

Where on the command line they go:

- They are appended to the command's last line.
- Trailing blank lines are dropped first, so a multi-line command's
  closing newline does not run them as a command of their own.
- They go before a trailing `;` or `&`, for the same reason.
- An escaped `\;`, as in `find … -exec … \;`, takes them after.
- Inside a compound command that ends the line, they go on its last
  command, where the shell still reads arguments.
- That covers `(cd web && vite)`, `{ …; }`, `if …; fi`, `for …; done`
  and `case … esac`.
- Redirections after its closer stay there: `(cmd) 2>&1`, `done < f`.
- They go before a `#` comment still open there: `echo args: # show` gets them.
- With comment-only lines below a commented line, they go before the earliest.
- A heredoc's body and terminator are not command lines: `cat <<X … X`
  gets them on the `cat <<X` line.
- A `<<X` in a comment or in quotes opens no heredoc, and a quote in a
  body opens no string.

Limits and refusals:

- The command, with its forwarded args, is one argument to `sh -c`, and
  Linux caps one argument at 128 KiB.
- Past that the task fails to spawn (`E2BIG`), and the frame says how
  long the command was.
- Pass a long file list through a file the tool reads instead.
- The same limit counts the task's environment; when that is the cause,
  the frame names its size and its largest variable.
- An argument that is not valid UTF-8 (`-- $'a\xff'`), here or before
  `--`, is refused, naming its position.
- That is because Bun reads argv as UTF-8 and offers no raw bytes: it
  would reach the task as U+FFFD, and two different args would share one key.
- An argument holding a real U+FFFD cannot be told apart and is refused too.
- An argument before `--` holding a control character (a newline, a
  tab) is refused too, naming its position.
- Only a `vx last --sql` query may span lines.

</div>
</details>

### Flags

Every `vx run` flag, its default and what it does.

```sh
vx run build --all --concurrency 4 --timeout 10m
vx run test --filter @demo/web --retries 2 --fail-fast
```

| Flag                               | Default                                                 | Does                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `--filter <pattern>`               | none                                                    | Picks projects by pattern; repeatable ([Filter DSL](#filter-dsl---filter)).                                                     |
| `--all`                            | off                                                     | Picks every project that declares the task.                                                                                     |
| `--affected[=<base>]`              | off                                                     | Picks the tasks a git change since `<base>` reaches (default a plugin's base, else `origin/<baseBranch>`; none on that branch). |
| `--exclude-dependencies[=<names>]` | off                                                     | Skips `dependsOn` edges: all, or only the names listed.                                                                         |
| `--concurrency <n>`                | `run.concurrency`, else the cores                       | How many tasks run at once: `4`, or `50%` of the CPUs.                                                                          |
| `--schedule <rule>`                | `run.schedule`, else `most-work`                        | Which ready task starts first when workers are short.                                                                           |
| `--branch <name>`                  | `VX_RUN_BRANCH`, else git's branch, then CI's           | The branch the run records in its history.                                                                                      |
| `--no-cache`                       | off                                                     | No cache reads, no cache writes.                                                                                                |
| `--force`                          | off                                                     | Runs every task again, and saves the results.                                                                                   |
| `--cache-policy <spec>`            | `VX_CACHE_POLICY` / `cache.policy`                      | Turns cache reads and writes on or off per layer.                                                                               |
| `--cache-dir <path>`               | `VX_CACHE_DIR` / `cache.dir` / `~/.vx/<id>/cache`       | Where the local cache lives, for this run.                                                                                      |
| `--retries <n>`                    | `run.retries`, else `0`                                 | Runs a failed task up to `n` more times.                                                                                        |
| `--fail-fast`                      | `run.failFast`, else off                                | Stops the whole run at the first failure.                                                                                       |
| `--timeout <duration>`             | `run.timeout`, else none                                | Kills a task that runs longer: `30s`, `10m`.                                                                                    |
| `--output-logs <mode>`             | `VX_RUN_OUTPUT_LOGS`, else by the run's flow            | How much task output prints: `full`, `errors-only`, `hash-only`, `none`.                                                        |
| `--cache-download <mode>`          | `cache.download`, else `all`                            | Which remote-run outputs come back here: `all`, `toplevel`, `none`.                                                             |
| `--cache-concurrency-download <n>` | `cache.concurrency.download`, else 64 to 96             | Remote downloads at once.                                                                                                       |
| `--cache-concurrency-upload <n>`   | `cache.concurrency.upload`, else 64 to 96               | Uploads at once, per remote.                                                                                                    |
| `--cache-concurrency-restore <n>`  | `cache.concurrency.restore`, else twice `--concurrency` | Local hits restoring their outputs at once.                                                                                     |
| `--verbosity <n>`                  | `0`                                                     | `1` or more prints a table of every task at the end.                                                                            |
| `--dry`                            | off                                                     | Shows the plan and predicted hits; runs nothing.                                                                                |
| `--format <fmt>`                   | `pretty`                                                | With `--dry`: `pretty`, or `json` for programs.                                                                                 |
| `--profile[=<path>]`               | off (`profile.json` when set)                           | Writes a Chrome trace of the run.                                                                                               |

Every value flag takes `--flag value` or `--flag=value`. A flag given
twice keeps the last value.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

`--affected[=<base>]`:

- Picks the ones the change touches and those whose `dependsOn` closure
  holds one, through the edges their keys fold (`inputs.tasks`).
- Default base: a plugin's base, else the merge base with
  `origin/<baseBranch>`; none on that branch.
- Its candidates are `--filter "...[<base>]"`'s.

`--exclude-dependencies[=<names>]`:

- No value drops every edge: only the requested task runs. A group's
  members run as the group.
- A comma list drops only those names, each of which some project must
  declare. A typo is refused with the nearest name.
- An edge to a task the run schedules anyway (`--all` requests it)
  stays, so the two still run in order.
- The order through a dropped task stays: with `gen` dropped from
  `test → gen → build` and `build` requested, `test` still waits for `build`.
- A dropped dependency does not run but is still keyed, so every key is
  the one a full run derives.
- A task keyed on a dropped dependency may hit but does not save
  (`caching.md` step 8).

`--concurrency <n>`:

- It caps the tasks that execute. Confirmed cache-hit restores are disk
  work and run on their own lane, up to twice this.
- `1` serializes both.
- `50%` is half the CPUs, rounded, never below 1. Over 100% is allowed
  for I/O-bound work.
- The default core count is cgroup-capped.

`--schedule <rule>`:

- The rules are `most-work`, `critical-path`, `direct-dependents` and
  `ready-order` (`docs/schema.md` § `run.schedule`).

`--branch <name>`:

- The run forecasts from that branch's history too.
- No config key: a committed branch would mislabel every other branch's runs.

`--no-cache`, `--force`, `--cache-policy`:

- `--no-cache` leaves output globs alone: they are NOT cleaned.
- `--force` skips cache reads; writes stay on.
- Under `--force`, this run's outputs replace a key the local cache
  holds, a remote that holds it is not sent it again, and one that
  holds none is sent this run's outputs.
- Under `--force`, output globs are cleaned, so the saved snapshot is clean.
- See [Cache control](#cache-control---cache-policy---no-cache---force).

`--cache-dir <path>`:

- Resolved relative to cwd; an absolute path is used as-is.
- Beats `VX_CACHE_DIR`, the workspace's `cache.dir` and the default.
- Like them, the directory then holds the whole cache for every cache
  the run opens, shared through no store.
- The workspace's default dir is then not created beside it.
- A per-run knob: never folded into a cache key.
- Both forms refuse a value of only whitespace.
- A directory this user cannot write into serves its hits and saves
  nothing, saying so once.
- An empty one it cannot write into fails the run before any task with
  `cache directory <path> is not writable (EACCES: …)`.
- One under a selected task's declared outputs fails the run before any
  task, naming the task: its output clean would delete the cache.

`--retries <n>`:

- Never retries a persistent task.
- A task's own `exec.retries` wins, even an explicit `0`.
- Never affects cache keys.

`--fail-fast`:

- Kills the tasks still running.
- Off, a failure skips only its dependents. See [Failure propagation](#failure-propagation----fail-fast).

`--timeout <duration>`:

- For tasks without their own `exec.timeout`, which always wins.
- A runaway task is killed and `failed`.
- A bare number is refused, naming the forms with units.
- Never affects cache keys.

`--output-logs <mode>`: an explicit output override. See [`--output-logs`](#--output-logs-mode).

`--cache-download <mode>`:

- Says where a REMOTELY-executed task's outputs land.
- `none` leaves them in the remote CAS and fetches lazily, only when a
  locally-placed task needs them.
- Never affects cache keys. See [`--cache-download`](#--cache-download-mode).

`--cache-concurrency-download` and `--cache-concurrency-upload`:

- Take an integer of 1 or more.
- Default: min(96, max(cores × 3, 64)).

`--cache-concurrency-restore`: takes an integer of 1 or more.

`--verbosity <n>`:

- Takes an integer of 0 or more.
- The table leaves groups out and is painted as the task list on a
  colour terminal.
- It prints after the framed blocks, above the footer.

`--dry`:

- `VX_DEBUG_TIMING=1` prints the stage table here as it does for a run.
- See [Planning mode](#planning-mode---dry).

`--format <fmt>`:

- `json` prints one JSON document on stdout.
- Without `--dry` it is refused: a run prints no JSON of its own
  (`vx last --format json` reads it after).

`--profile[=<path>]`:

- Writes Chrome-trace JSON of the run's wallclock spans.
- A write that fails is a warning (`vx: failed to write profile: <cause>
— the run's verdict stands; …`).
- It leaves the exit code as the run set it.
- A directory is refused before the run. See [Run artifacts](#run-artifacts---profile).

</div>
</details>

How flags read their values, and what vx says about a typo:

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

Values:

- A value flag given twice keeps the last value
  (`--concurrency=1 --concurrency=2` runs 2), so a flag appended after a
  script's own overrides it.
- Value flags (`--filter`, `--concurrency`, `--output-logs`,
  `--verbosity`, `--cache-dir`, …) accept both `--flag value` and `--flag=value`.
- In the space form, `--cache-dir` and `--branch` reject a value
  starting with `-`: that is always a swallowed flag (an unquoted empty
  shell variable).
- Use the `=` form for a literal leading dash.

Flags that cannot go together:

- `--dry` with `--profile`: the profile needs a real run to write about.
- `--format` without `--dry`: only the plan has a format.

**Optional-value flags take their value with `=` only.**

- `--affected`, `--exclude-dependencies`, `--dry` and `--profile` are
  all valid bare, so a following word is read as a task name.
- `vx run --affected build` means "run `build`, affected scope": there
  is no way to tell that apart from "`build` is the git base".
- Write `--affected=origin/main`.
- Getting it wrong is loud: the value becomes a positional that matches
  no project, so the run refuses to start.
- In `vx run --affected main build`, `main` is a task. When no project
  declares it, the refusal names `--affected=main`.
- `vx watch` and `vx show` say so too.
- A word from a closed set says so first: `--dry json` is refused with its `=` form.

Empty values:

- `--profile=` writes `profile.json`, as bare `--profile` does.
- `--affected=` uses the default base, as bare `--affected` does.
- Every other flag refuses an empty value: `--dry=` and
  `--exclude-dependencies=` as well as the ones with no bare form.
- Those are `--retries=`, `--timeout=`, `--cache-dir=`, `--filter=`,
  `--cache-policy=` and `--verbosity=`.
- `--exclude-dependencies=` with an EMPTY value, or a list of no names
  (`=,`), is rejected rather than guessed.
- "Drop every edge" and "drop none" are both plausible readings: pass
  bare `--exclude-dependencies` for the first, omit the flag for the second.
- Given twice, `--exclude-dependencies` name lists add up, and a bare one drops every edge.
- An EMPTY spec (`--cache-policy=`) is refused: pass `--no-cache` to
  disable every axis.

**Numeric flags take a plain decimal integer.**

- `--concurrency`, `--retries` and `--verbosity` reject hex (`0x10`),
  exponent (`1e3`), fractional (`2.7`), signed (`+4`) and space-padded forms.
- They reject anything past `2^53`: it would parse to a number you did not type.
- `--concurrency 0x10` is refused rather than run 16 workers.
- A duration flag (`--timeout`) takes its unit (`500ms`, `30s`, `10m`):
  a bare `500` is refused, naming both readings.

Unknown flags:

- Unknown flags are a parse error (`unknown flag: --foo`).
- The error names the nearest flag the verb accepts when one is within
  two edits, on a `fix` line: `unknown flag: --concurency`, then `fix  --concurrency`.
- A name of four letters or fewer gets one edit or a swap of two
  letters, so `--poll` is not hinted `--all` nor `vx test` `last`.
- The same name in another case is always hinted (`--ALL` hints
  `--all`), as is a task or project name (`BUILD` hints `build`).
- Every verb does this against its own usage line and `--help`.
- `vx info --formt` hints `--format`, `vx lock --chek` hints `--check`,
  `vx upgrade --hlp` hints `--help`.
- `--json` on a verb that takes `--format` hints `--format json`.
- A flag exactly one other verb takes names that verb instead
  (`vx run build --sql`: `` `vx last` takes it ``).
- `vx version` takes no word, so `vx version --hlp` is refused (exit 1).

A task typed where the verb goes:

- `vx build` is refused with the `vx run` that runs it.
- `vx build` names `vx run build --all` from the root and `vx run build`
  inside a project.
- `vx build @demo/web` names `vx run build --filter @demo/web`.
- `vx @demo/web#build` names `vx run @demo/web#build`.
- A typo of a task (`vx biuld`) names the task and the same `vx run`,
  unless a verb is as close (`vx rnu` hints `run`).
- The default `build` is no declared task, so it is no hint: where it is
  the only `build`, `vx build` is an unknown command.
- It stays a refusal: a plugin verb of the same name is the verb, and
  would change what `vx build` means the day one was declared.

</div>
</details>

#### Cache control: `--cache-policy`, `--no-cache`, `--force`

Three flags decide whether a run reads and writes the cache.

```sh
vx run build --no-cache                     # no cache at all
vx run build --force                        # run again, save the result
vx run build --cache-policy=remote:r        # read the remote, never upload
```

| Flag                    | Reads     | Writes    |
| ----------------------- | --------- | --------- |
| (none)                  | yes       | yes       |
| `--no-cache`            | no        | no        |
| `--force`               | no        | yes       |
| `--cache-policy=<spec>` | per layer | per layer |

Default: every read and write is on, except remote writes off CI.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

The cache has four independent axes: **localRead**, **localWrite**,
**remoteRead**, **remoteWrite**. They resolve in this order:

1. Start with every axis **on** (the default).
2. Apply each `--cache-policy=<spec>` segment (the base).
3. With no `--cache-policy`, apply the `VX_CACHE_POLICY` environment
   variable's spec, or, with neither, `.vx/workspace`'s `cache.policy` (`docs/schema.md`).
4. If `--no-cache` was passed, force **all four off**.
5. If `--force` was passed, force **both reads off**. Writes stay
   whatever the base / `--cache-policy` left them.
6. Off CI (no CI variable is on, § Output format › Colors), force **remoteWrite off**, unless
   the spec in effect names the remote: `--cache-policy`, else `VX_CACHE_POLICY`, else
   `cache.policy`.

   A `--cache-policy=local:r` over a `cache.policy` of `remote:rw`
   leaves the remote read only.

- Remote writes are off off CI because a key holds only declared
  inputs, so a laptop's write could replay on CI.
- `cache.scope` never changes an axis.
- So `--no-cache` always wins over `--force`.
- A spec that names a remote axis (`remote:r`, `remote:w`, `remote:rw`)
  in a workspace whose plugins supply no remote layer gets one status line saying so.
- That line shows on a run and a `--dry` plan alike, naming where the
  spec came from (`--cache-policy`, `VX_CACHE_POLICY` or `cache.policy`).
- The axes are inert without a layer to serve them, and a CI job that
  believes it is filling a shared cache should be told.
- Whatever the axes, a lookup asks the local cache first, then each
  remote in the order the plugins declare them.
- The axes govern task artifacts. A plugin's own entries (`ctx.cache`)
  are read from every remote the run may read or write.
- So a `remote:w` run still reads a plugin's own entries.

`--no-cache`:

- Nothing reads, nothing writes, and declared output globs are left
  untouched: you're debugging, and vx won't manage your tree.

`--force`:

- Re-executes every task (reads off) with writes on.
- This run's outputs replace the entry the local cache held for the
  key, so a doubted local entry is repaired.
- A remote entry is immutable, so a bad one there is removed at the server.
- Each remote that can batch (`hasMany`) is asked once, in the
  background, which keys it holds.
- One that cannot batch is asked `has` per key before its upload.
- Held keys are not uploaded again. A probe that fails uploads.
- A remote that holds none is sent this run's outputs.
- Output globs ARE cleaned before each task, so the disk holds this
  run's outputs.

`--cache-policy=<spec>`:

- A comma-separated list of `<layer>:<flags>` segments.
- `layer` is `local` or `remote`.
- `flags` is any subset of `r` (read) and `w` (write),
  order-independent and possibly empty.
- A **mentioned** layer is set EXACTLY to its flags; an
  **unmentioned** layer keeps its current value.
- Both `--cache-policy=<spec>` and the space form `--cache-policy <spec>` are accepted.

| Spec                               | Effect                                                           |
| ---------------------------------- | ---------------------------------------------------------------- |
| `--cache-policy=local:rw,remote:r` | remote read-only (won't upload); local full                      |
| `--cache-policy=local:r`           | local read-only; remote untouched (full on CI, read-only off CI) |
| `--cache-policy=remote:`           | remote fully off; local untouched                                |
| `--cache-policy=local:,remote:rw`  | don't touch the local cache, but still upload to remote          |

- `local:` means "don't serve hits out of the pre-existing local cache".
- Under `local:` a remote hit is still delivered: the artifact has to
  land on disk to be extracted.
- It never short-circuits the remote read.
- `--cache-policy=local: --force` re-executes and fills only the remote:
  local off, reads off, remote write-only.
- Under it, keys the remote already holds are not sent.
- Invalid layers or flags are a parse error (`--cache-policy: invalid
layer 'disk'`, `--cache-policy: invalid flag 'x'`, …).
- `VX_CACHE_POLICY` and `cache.policy` say their own name instead.
- An EMPTY spec (`--cache-policy=`) is a parse error: pass `--no-cache`
  to disable every axis.

</div>
</details>

### Output

What a run prints depends on how you asked. Run one task and you see its
output, as if you ran `vite build` yourself. Run many and you get one row per task.

| You typed                                          | Flow    | You see                           |
| -------------------------------------------------- | ------- | --------------------------------- |
| `vx run build`                                     | focused | the task's own output, in a frame |
| `vx run build --all` (or `--filter`, `--affected`) | broad   | one row per task that ran         |
| anything, on a CI job                              | CI      | only the tasks that failed        |

`--output-logs` overrides all three. The summary at the end always prints.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- **FOCUSED**: no selection flag was passed. You are running "your"
  task; cwd and task count do not change the flow.
- **BROAD**: the invocation used `--all`, `--filter`, or `--affected`.
  You asked about a swath of the workspace and want news, not output.
- **CI**: a CI variable is on (§ Output format › Colors lists them: `CI`, `GITHUB_ACTIONS`, `JENKINS_URL` and the rest). Empty, `0`, `false`, `no` and `off`, in any case, don't count.
- CI wins over the flow: only failed tasks print (`errors-only`), so the
  log holds what broke.

</div>
</details>

Each task row reads left to right: status, cache, time and more.

| Status     | Colour | Meaning                                                |
| ---------- | ------ | ------------------------------------------------------ |
| `success`  | green  | the task ran and passed, or a cache answered it        |
| `failed`   | red    | the task exited non-zero                               |
| `skipped`  | yellow | never started: blocked upstream, or another platform   |
| `running`  | yellow | live: still going, or a persistent server that is up   |
| `aborting` | yellow | live: a stop asked it to end, and it has not yet       |
| `blocked`  | dim    | live: picked next, waiting on the running row above it |
| `aborted`  | orange | a stop cut it short                                    |
| `not run`  | dim    | a stop came before it started                          |

| Cache      | Meaning                                                        |
| ---------- | -------------------------------------------------------------- |
| `miss`     | the task ran; a cache was asked and had nothing                |
| `no-cache` | the task ran with no cache (no `cache: true`, or `--no-cache`) |
| `fresh`    | up to date: its outputs already on disk                        |
| `local`    | restored from the local cache                                  |
| `remote`   | restored from a remote cache                                   |
| `internal` | one of vx's own steps, which caches nothing                    |
| `—`        | never reached the cache (skipped, aborted, not run)            |

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- The columns: `<status> <cache> <±usual> <time> <cpu> <mem> <outputs>
<blocks> <worker> <mark> <task>`.
- No glyph leads a row. The status word starts at column 12, where the
  Summary's values start, and its colour carries the outcome.
- An empty cell shows `—`.
- A terminal too narrow for the whole row drops `blocks`, `outputs`,
  `worker`, `cpu`, `mem` and `±usual`, in that order, until a task's name has 24 columns.
- Status, cache and time always stay.
- Narrower still (below about 60 columns), the task's name gives way in
  its middle (`pac…ld`).
- With under 8 columns left for it, the name goes on its own line under
  the row, at the gutter.
- Logs off a terminal keep every column.
- A terminal titles the rows with a `Tasks` line holding the column
  names; a pipe (an agent's shell) gets that line once, above its first row.
- The 2-column mark slot before the task id holds a yellow `◆` on the
  critical path, otherwise a space.
- A live row's motion is its ticking time; there is no spinner.

</div>
</details>

What each task prints, by outcome and flow. Each cell is the shape of
what prints: `silent`, `one-liner`, `frame`, or a conditional.

| Outcome                | focused (requested task) | focused (dependency)      | broad                     | `full`                       |
| ---------------------- | ------------------------ | ------------------------- | ------------------------- | ---------------------------- |
| executed               | frame                    | silent                    | one-liner                 | frame                        |
| restored-local/-remote | frame                    | silent                    | silent                    | frame, or one-liner if quiet |
| up-to-date             | frame                    | silent                    | silent                    | frame, or one-liner if quiet |
| failed                 | frame                    | one-liner + frame replays | one-liner + frame replays | frame                        |
| skipped                | one-liner                | one-liner                 | one-liner                 | one-liner                    |

A frame is the task's output between a `┌─` line and a `└─` line.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

Focused, requested task:

- The frame is LIVE when it is the only requested task: `┌─` prints at
  task start, the output streams raw, `└─` closes it.
- The streamed output is the command's, or a hit's replayed stdout.
- The status region stays below the streamed output, summary and run id
  included, redrawn after each write.
- With several requested tasks the same frame is buffered and emitted
  atomically (see below).
- Every outcome that ran or was cached gets a frame, an `up-to-date` hit included.
- That hit's frame carries the `$ cmd` line, so a requested task looks
  the same whether it ran or not.
- On a terminal too narrow for an edge, the edge cuts the project's name
  in the middle (`@acme/…-ui#build`), and the task's name after it.
- The frame then names the whole id under its opening edge.

Skipped:

- It never started, so no frame was opened, and it produced nothing a
  frame could hold.
- The one-liner says everything, the blocker included: `skipped …
@demo/web#deploy • blocked by
@demo/ui#build`.
- A fail-fast skip, which nothing blocked, carries no suffix.
- Every view that lists tasks prints it, a dependency's included:
  nothing prints below the footer.

The other shapes:

- **`frame, or one-liner if quiet`**: a cache hit with stored stdout is
  worth a frame, since the output is the point.
- A hit with nothing to replay compresses to one line, which keeps a
  2000-task warm run readable.
- **`one-liner + frame replays`**: the `failed miss …` row prints
  immediately; the full frame is held and replayed at run end.
- **A ready server in broad** gets its one-liner and then its frame,
  holding what it printed before ready.
- So `vx run dev --all` shows each server's address (`Local: http://…`).

Failures and the summary:

- When a dependency fails mid-run, the stream gets ONE permanent
  `failed miss … <id>` row and the run continues.
- **All full failure frames replay together at run end**, right above
  the summary, and are never capped.
- The end-of-run summary always prints; cache-hit counts that broad mode
  silences per-task surface there.
- A focused `vx run test` is meant to feel like running the test
  command directly: same output, faster.
- The table is pinned to the renderer by `tests/output-doc-drift.test.ts`,
  so the vocabulary is fixed.

</div>
</details>

**Groups are transparent folders.** `vx run build`, where `build` is a
group, shows the real tasks the group stands for, as if you had named them.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- A group task (no `exec`, only `dependsOn`) has no output of its own.
- Running one focused (`build` chains `build.bun`, which chains
  `build.bun.darwin-arm64` …) surfaces the **real tasks** it stands for.
- The walk descends through nested groups but never leaves the requested
  project: `^` and cross-project deps aren't surfaced.
- It never goes past a real task into its own deps.
- The requested count for the live-vs-buffered decision counts the
  surfaced tasks: one real task streams live, several buffer into atomic blocks.
- Surfacing is display-only: it does not make those tasks "requested",
  so `--` `forwardArgs` still go only to what you named.

</div>
</details>

**Live streaming applies only when there is exactly one requested task.**
`vx run build test` buffers each task's output into one block, shown
when the task ends.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- Live framing assumes a single task owns the terminal between its open
  (`┌─`) and close (`└─`) lines.
- With two requested tasks running at once, their frames would interleave into garbage.
- So when more than one task is requested, each requested task
  **buffers** its output and renders as a single atomic block at completion.
- The shapes are the ones in the table above: anything that ran or was
  cached gets a full frame, `up-to-date` included; only `skipped` is a one-liner.
- The blocks are blank-line separated and never interleave.
- A single `vx run test` keeps the live-stream experience unchanged.

</div>
</details>

**The live status region.** On an interactive terminal (TTY stdout, not CI) a status region at the
bottom tracks the run live. Top to bottom:

1. **A blank separator line** keeps the live region apart from the
   finished rows above it.
2. **Pinned persistent tasks**: a `running` row for each persistent task
   that became ready, such as a dev server.
3. **The running list**: one row per running task.
4. **vx's own steps**: what vx does around the tasks, such as `vx:load`.
5. **The live summary section**: the same meters the final footer
   prints, filling in as the run goes.

```ansi
[4m[58;2;110;118;129m  [1m[38;2;167;139;250mTasks[0m[4m[58;2;110;118;129m     [2mstatus  cache     ±usual    time   cpu    mem outputs  blocks worker         task[0m[4m[58;2;110;118;129m                           [0m
            [38;2;34;197;94msuccess[0m [2mmiss[0m        [2m+0ms[0m     [38;2;203;213;225m9ms[0m   [2m12%[0m  [2m1.8MB[0m      [2m0B[0m       [2m0[0m [2mlocal[0m          [38;2;147;197;253mapp[0m[2m#[0m[38;2;96;165;250mtest[0m
            [4m[58;2;110;118;129m                                                                                                            [0m

            [38;2;234;179;8mrunning[0m [2mmiss[0m       [2m~5.0s[0m   [38;2;203;213;225m2.10s[0m    [2m0%[0m  [2m1.9MB[0m       [2m—[0m       [38;2;203;213;225m1[0m [2mlocal[0m        [38;2;234;179;8m◆[0m [38;2;192;132;252m@demo/ui[0m[2m#[0m[38;2;244;114;182mbuild[0m
            [2mblocked[0m [2m—[0m          [2m~50ms[0m       [2m—[0m     [2m—[0m      [2m—[0m       [2m—[0m       [2m—[0m [2m—[0m              [2m└[0m [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;244;114;182mbuild[0m
```

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

Pinned persistent tasks:

- A pinned row has no time or cache.
- The pin lives until run end, or until the task's process exits on its
  own: a crash, or a setup step ready by its exit 0.
- A setup step's frame then closes `success`, not `running`.
- So the pin is the visible evidence the dev server is still alive.
- After the summary, a requested persistent task keeps vx in the
  foreground, with the persistent tasks it depends on.
- That lasts until it, or with several the first of them, exits.
- One kept only as a dependency that exits 0, a daemon that forked and
  returned, does not end it.
- The rest still up are then torn down: SIGTERM, a 2 s grace, SIGKILL.
- One status line names the task and its code (`vx: @demo/web#dev exited
with code 1; stopping 1
other persistent task`).
- A non-zero exit makes the run exit 1 and is what `vx last` records.
- A Ctrl-C prints no such line: the server ended because it was
  stopped, and vx exits 130.
- A failure elsewhere (a task failed or skipped, a server never ready or
  crashed) skips only its dependants.
- The healthy servers stay up, and the run exits 1 when the session ends.
- Under `--fail-fast` the first failure stops them all and vx exits 1 at once.
- `vx watch` keeps its server through a failed cycle.
- While vx holds them, what the servers write streams below the summary
  a line at a time under each one's id.
- Such a line reads `@demo/web#dev │ Local: http://localhost:5173`.
- Not under `--output-logs errors-only`, `hash-only` or `none`.
- A single requested server in the focused flow streams raw from its frame.

The running list:

- It sits under the Tasks list's finished rows: an underline from the
  grid's first column to the edge, a blank line, then the rows.
- It has no title or header of its own.
- A worker with nothing to run adds no blank row, so the footer sits
  right under the list.
- A task stays in its slot for its whole life.
- A task running beyond the slots gets a row after them until one
  frees, and none is ever folded away.
- The `Tasks` title sits in the 12-column gutter (bold violet) with the
  grid's header on the same line, underlined to the terminal's edge.
- Every grid starts where a field's value does.
- A running row's status is yellow.

The running list's columns:

- **time**: the live elapsed time; no spinner.
- **usual**: the task's executed p50 from local history, fixed while the
  time counts up toward it.
- A run with forwarded args (`-- <args>`) is left out of that history.
- `—` for a task history never timed.
- History is read once, on the first row that asks, so a run that
  executes nothing never reads it.
- The results list's `±usual` is how far a run landed from it.
- `+6.00s` red or `−1.40s` green past a fifth either way, dim within
  it, `—` with no history or on a hit.
- A grid cell is never blank: `—` is a value vx cannot know or one that
  does not apply.
- **status** and **cache**: `running` and `miss`, or `no-cache` for a
  task with no `cache: true` (or a `--no-cache` run).
- Finished rows say `local` or `remote` on a hit.
- A hit whose restore failed (a full disk, a path in the way, a link out
  of the project) is `failed` with cache `—`: neither a miss nor a hit.
- It ran no command, so its row has no `±usual`, cpu or mem, and its
  frame no command line.
- Its label is `failed (cache restore failed)` over the restore's error.
- A task whose key could not be derived (a runtime probe that exited
  non-zero, a refused `inputs.env` value) is the same, `failed (cache key not derived)`.
- That shows under the line
  `[vx] @demo/web#build: cache key not derived: inputs.runtime probe exited 7: …`.
- A miss whose output clean vx refused before its command (a name that
  is not UTF-8) is `failed (output clean failed)`.
- One whose command exited 0 and whose save vx refused is `failed (cache save
failed)`, a miss with the command's time.
- `vx last` says `cache
save failed` for it, not an exit.
- **cpu** and **mem**: the task's process tree's average cores since it
  started and its peak memory so far.
- They are looked at every 500 ms only while this list draws: a pipe or CI reads nothing.
- On a finished row: its average cores and peak memory over the whole
  run, `—` on a hit.
- On Linux the peak at exit is the task's own, read by the small helper
  that forks its shell, or its tree's sum looked at every 250 ms, whichever is larger.
- The helper is needed because the kernel hands a shell vx spawned vx's
  own memory at exec.
- **outputs**: on a finished row, the bytes of its outputs.
- On a hit, the files it restored; on a miss, the files it wrote, saved or not.
- `—` when vx has no size for it: a remote hit not yet downloaded, a
  task with no outputs saved.
- **blocks**: how many tasks and groups are downstream of it, all of
  them: the count the scheduler ranks by.
- **worker**: `local`, or the machine an executor (`@vzn/vx-dte`) names,
  cut to 12 columns with `…`.

The rows no task runs in:

- They hold the tasks the scheduler has picked for the next free
  workers, as many as there are free rows and nothing further ahead.
- Each is nested under the running task it waits on, with its usual time.
- When an executor places tasks, the rows are only what runs: no nested
  row; blocked tasks are the tasks line's dim `N blocked` alone.
- A yellow `◆` right before the name marks the running task the longest
  unfinished chain waits on (the critical path).
- Its finished row keeps the `◆`.

vx's own steps:

- They are what vx does around the tasks that the run waits on, before
  its first task starts or before it ends.
- They are rows of their own below the worker rows.
- Before the tasks: `vx:load` (configs and graph from the lock;
  `vx:run-lock` inside it, before the cache opens), `<plugin>:setup`.
- Then `vx:keys` (keys and local probes) and `<plugin>:schedule`.
- After the graph: `vx:profile` (with `--profile`), `vx:history`,
  `vx:uploads`, `<plugin>:telemetry`, `<plugin>:teardown`, `vx:snapshots`,
  `vx:close` and `vx:sandbox`.
- A step shows once it has run 150 ms, ticking like a task (`running`,
  `internal` in the cache column).
- No worker slot or `--concurrency` holds a step back.
- When it ends it leaves a list row like a task's (`success internal`,
  then its time, then `vx:uploads`); a quicker one shows nowhere.
- A step that runs beside the tasks, `vx:prefetch` (a remote's
  downloads), never shows: `vx last` lists it.
- `:` is no task id's separator, so a step never reads as a task: a
  project named `vx` keeps `vx#build`.
- No step is a task: no count, bar, history row, forecast, flaky verdict
  or telemetry record holds one.
- `--profile` and `VX_DEBUG_TIMING` time vx's stages their own way.
- Steps show only beside a live region; a log (CI, a pipe) prints none.
- Under `--output-logs hash-only` (one line per task) and `errors-only`
  only a step that failed leaves a row.

The live summary section:

- It holds the `tasks` and `cache` bars with legends, and `time`, under
  the same underlined `Summary` title line.
- A second in, the `time` row adds what is left (`time  1.41s · ~3s left`).
- What is left uses each unfinished task's executed p50 from local history.
- It is the longer of the longest unfinished chain and that work spread
  over the workers, a running task's spent time taken off its own.
- It says nothing when history knows none of what is left, or while no
  machine runs a task and some wait for one (`scheduled`).
- Past the estimate it counts up how long the run has waited
  (`time  9.02s · +3s over`) until new work makes a forecast again.
- A run that ends inside the second never reads history for it, and the
  final summary never shows it.
- A p50 here is the median of the task's last five timings on this
  branch, else on any branch.
- The timings are shared by every worktree of the workspace, so a new
  one has a forecast on its first run.

Drawing the region:

- The region is redrawn in place (cursor-up + clear; not a TUI, no
  alternate screen) and erased before the final summary prints.
- On a terminal shorter than the region, it shows only the rows that fit.
- In the focused flow it only lives while dependencies run.
- It disappears for good the moment the requested task starts streaming.
- Task events force a redraw, but forced redraws within 30 ms of the
  last draw coalesce into a single trailing draw when the floor expires.
- The final state always lands.
- On a 3,270-task warm run this cuts ~6.7 MB of redraw ANSI to ~20 KB.

</div>
</details>

**Terminal extras.** Some terminals get a progress bar in the tab, a desktop notification,
and clickable file paths in a failed task's output.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

Progress and notifications:

- In a terminal known to read them, the region also sends zero-width escapes.
- Tab or taskbar progress (OSC 9;4: Ghostty, iTerm2 3.6+, ConEmu, and
  the terminal `WT_SESSION` names) fills by the forecast, or else by tasks done.
- It turns red once a task fails, and is cleared when the region goes.
- A run of 10 s or more ends with a desktop notification (OSC 9:
  Ghostty, iTerm2, WezTerm).
- The notification reads `vx: 12 tasks done` or `vx: 1 of 12 tasks failed`.
- The terminal is named by `TERM_PROGRAM` (or `WT_SESSION`, `ConEmuPID`);
  any other gets neither.
- So do tmux and screen, even started from one of those, since there
  OSC 9 may itself be a notification.

Links:

- Terminals known to open OSC 8 links: Ghostty, iTerm2 3.1+, WezTerm,
  VS Code, kitty, Konsole, VTE terminals, and the one `WT_SESSION` names.
- Never inside tmux or screen.
- There, a failed task's frame links each path that names a file in the
  task's project, `src/a.ts:12:5` or `src/a.ts(12,5)`, coloured or not.
- The link opens that file, so a click from the workspace root opens the right one.
- The text is the task's output unchanged; a successful task's frame is never linked.

Colours:

- Each half of a `project#task` renders in a stable hue hashed from its
  own name: same project, same colour; same task name, same colour.
- That holds in every run and every surface: every `#build` matches.
- A dim `#` sits between, all outside the status palette, so an id can
  never read as an outcome.

</div>
</details>

**GitHub Actions.** Each task's output folds into a collapsible group,
and a failed task gets an error annotation.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- That is when `GITHUB_ACTIONS` is truthy, in full output mode.
- Each task's block is wrapped in `::group::<id> (<outcome> <duration>)`
  / `::endgroup::` so it collapses in the log viewer.
- Failed tasks stay pre-expanded and emit an `::error title=<id>::failed (exit N)`
  annotation instead.
- The views that hold a failure's frame to the run's end (`errors-only`,
  CI's default, `broad`, `focused`) write the same annotation above it.
- Above 128 the label names the signal: `failed (exit 137, 128 + SIGKILL)`.
- A timeout names its reason: `failed (timed out, exit 143)`.
- A persistent task that never became ready names its reason.
- A command that exited 0 but left an output glob matching nothing:
  `failed (exited 0, no file matched <glob>)`.
- A sandboxed task names its violation count, as every surface labels a failure.
- In every output mode there, a task's own text (a frame, a server's
  output since ready) is fenced in `::stop-commands::`.
- So a line it prints never becomes a workflow command.

</div>
</details>

### `--output-logs <mode>`

`--output-logs` sets how much task output a run prints, whatever the flow.

```sh
vx run build --all --output-logs=errors-only
```

| Mode          | Prints                                                    |
| ------------- | --------------------------------------------------------- |
| `full`        | frames for executed work, one-liners for quiet cache hits |
| `errors-only` | only failed tasks, with their output                      |
| `hash-only`   | one line per task: outcome word, task id, cache key       |
| `none`        | no per-task output                                        |

Default: `VX_RUN_OUTPUT_LOGS`, else set by the run's flow. On CI, `errors-only`.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- An explicit `--output-logs` always beats the flow and the CI default (`errors-only`).
- `errors-only` includes a server that died on its own after ready,
  with what it wrote since: the CI noise budget.
- `hash-only` prints no log output at all: the run's audit trail of
  which key each task resolved to.
- The end-of-run summary always prints.

</div>
</details>

### Failure propagation — `--fail-fast`

By default a failed task skips only the tasks that depend on it; the
rest keep running. `--fail-fast` stops the whole run at the first failure.

```sh
vx run build --all              # @demo/ui#build fails: only what needs it is skipped
vx run build --all --fail-fast  # the first failure stops everything
```

Default: `run.failFast`, else off.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

**Default**:

- The failure's transitive dependents are skipped; independent siblings keep running.
- A server that dies after it became ready is a failure to its
  dependents not yet started.
- That includes those that reach it through a group or another server.
- A dependent running when the server died finishes but is not saved,
  nor is what is built on it.
- Nothing ever runs on a failed dependency.
- A task `exec.platforms` skips is no failure, but its dependents are skipped too.

**`--fail-fast`** (`run.failFast`):

- The first failure stops the run at once.
- The tasks still running are killed: they end `aborted`, are never
  saved and start no retry.
- `vx last` keeps no row for them but counts them on its `tasks` line
  (`· 2 aborted`), and `--format json` as `invocation.abortedCount`.
- One whose command had already exited when the stop landed ends on its
  own exit, failed or passed.
- Everything not yet started (cache restores included) completes as skipped.
- A server that dies after it became ready stops the run the same way.

Executors:

- The mode is the local scheduler's: a task a plugin executor runs
  elsewhere is one dispatch, failed or not, like any other.
- Under `--fail-fast`, a task the executor still holds for a machine to
  begin it (its row says `waiting`) is not yet started.
- Its request is aborted and it completes as skipped.

</div>
</details>

### `--cache-download <mode>`

`--cache-download` sets which outputs of a task run on another machine
are copied back to yours.

```sh
vx run build --all --cache-download=none   # CI that only wants pass or fail
```

| Mode       | Copies back                                                     |
| ---------- | --------------------------------------------------------------- |
| `all`      | every task's outputs, as each completes                         |
| `toplevel` | only the tasks you asked for; intermediates stay remote         |
| `none`     | nothing, unless a task on this machine needs it in the same run |

Default: `cache.download`, else `all`. Tasks run on this machine always
write here; the flag does not change them.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- It applies to **remotely-executed** tasks only.
- `all` downloads byte for byte what it always did.
- `toplevel` counts the real tasks behind a requested group as asked for.
- `none` leaves outputs in the remote CAS and fetches them **lazily**:
  only when a locally-placed task in the same run actually needs them.
- So a CI job that only wants the verdict moves no output bytes at all.
- `exec.remote: 'only'` still means never: `--cache-download` cannot
  override it in either direction.
- **It never affects a cache key**: transfer tuning cannot change what a command produces.
- One safety gate: a task whose outputs another task's `inputs` globs
  could read on disk is silently kept eager.
- Deferring it would make that key depend on whether the bytes arrived.
- A task with no `cache` that a cached task depends on counts as reading
  its whole project.
- `--dry` reports how many tasks would keep their outputs remote and
  names each downgrade, so a run that defers nothing says why.
- A run in which any task declares an `inputs.runtime` /
  `workspaceRuntime` command defers **nothing**.
- A shell command's reads cannot be bounded, so vx cannot prove it will
  not read a deferred output.
- When bytes are fetched later, vx saves an ordinary cache entry for
  them, so the next run is a plain local hit.

</div>
</details>

### Exit codes

| Code                  | When                                                                                                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`                   | Every task finished `success` or `cache-hit` (local or remote), or was skipped as another platform's (`exec.platforms`) or behind one; or `--affected` left no project that declares the task. |
| `1`                   | At least one task ended `failed` or `skipped` (a platform skip aside); a persistent task exited non-zero after it was ready; a task name no project declares; or parse/setup error.            |
| `130` / `143` / `129` | Interrupted (SIGINT / SIGTERM / SIGHUP).                                                                                                                                                       |

A script can branch on the code:

```sh
vx run test --all; echo $?   # 0 or 1
```

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

On a stop signal:

- Each task's process group (the task and what it forked) gets vx's
  signal once (a SIGHUP as a SIGTERM), a 2 s grace to go, then SIGKILL.
- A second signal skips the grace.
- vx then dies of the signal, so a shell script running it stops too.
- A run that handed a task the terminal exits with the code instead, so
  the terminal is restored.
- A SIGINT or SIGHUP vx was started with ignored (a script's
  `vx run build &`, `nohup`) stays ignored.

Ctrl-C and Ctrl-Z:

- A task runs in its own session, so a terminal's Ctrl-C reaches vx
  alone, and each task hears it once: from vx, as SIGINT.
- Through `bun vx`, which passes the Ctrl-C on to vx as well, it is
  still one stop; a second press is the second signal.
- Ctrl-Z (SIGTSTP) stops each task's process group, then vx.
- `fg` or `bg` continues vx, and vx continues them.
- Neither a `timeout` nor a task's duration counts the time stopped,
  nor does its live row's clock.
- A Linux sandboxed task's command is not stopped, only held once its
  output pipe fills.
- A stop starts no more remote cache uploads and does not wait on one
  in flight, nor on a remote lookup or download.
- What was half-read is dropped and fetched again next run.

The npm launcher:

- Installed from npm, `vx` is a sh launcher that execs the platform
  binary, so every signal reaches vx directly and no Node starts first.
- A `vx --version` through npm takes 14 ms, against 56 ms with a Node launcher.
- Where it finds no binary beside it (musl, a platform with none) it
  hands off to a Node launcher.
- Both are one file, `launcher.cjs`: Yarn 2+ runs every package bin
  through `node` (`yarn vx`, a package.json script).
- Yarn reads it as the Node launcher, and the platform package asks Yarn
  Plug'n'Play to keep it unzipped, where its binary can run.
- On Node 22.15 or later that one replaces itself with the binary
  (`process.execve`) too.
- On older Node it runs the binary and waits for it: a signal sent to
  the launcher alone (`kill`, a process manager) is passed to the binary.
- A terminal's Ctrl-C already reaches both, so the launcher does not send it twice.
- A stop sent to the whole process group outside a terminal
  (`kill -TERM -<pgid>`, a hang-up to a background job) reaches vx twice.
- It comes from the kernel and from the launcher: vx takes the copy as
  the same stop, so its tasks keep their grace.
- Either way it dies of the signal vx died of, as vx does.
- So does a compiled vx that hands the call to the workspace's own.

A reader that leaves does not change the code:

- `vx run build | head -1` closes the pipe after one line.
- The run still finishes, saves what it built and releases its lock,
  and exits with its own verdict.
- The output after that point goes nowhere: `EPIPE`, on stdout or
  stderr, is not an error vx reports.

Any other refusal of stdout (`ENOSPC`, `EIO`) is one:

- vx prints `vx: write error on stdout: <error>` on stderr once.
- A verdict of `0` becomes `1`; any other code stands.

</div>
</details>

## Planning mode (`--dry`)

`--dry` shows what a run would do and runs nothing: each task, whether the cache holds it, and where it would run.

```sh
vx run build test --all --dry
```

```ansi
[4m[58;2;110;118;129m  [1m[38;2;167;139;250mPlan[0m[4m[58;2;110;118;129m [2m4[0m[4m[58;2;110;118;129m    [2mstatus  cache      usual    time   cpu    mem outputs  blocks worker         task[0m[4m[58;2;110;118;129m                           [0m
            [38;2;34;197;94mcached[0m  [38;2;56;189;248mlocal[0m          [2m—[0m       [2m—[0m     [2m—[0m      [2m—[0m       [2m—[0m       [38;2;203;213;225m2[0m [2mlocal[0m          [38;2;192;132;252m@demo/ui[0m[2m#[0m[38;2;244;114;182mbuild[0m
            [38;2;34;197;94mcached[0m  [38;2;56;189;248mlocal[0m          [2m—[0m       [2m—[0m     [2m—[0m      [2m—[0m       [2m—[0m       [2m0[0m [2mlocal[0m          [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;244;114;182mbuild[0m
            [38;2;6;182;212mrun[0m     [2mmiss[0m           [2m—[0m       [2m—[0m     [2m—[0m      [2m—[0m       [2m—[0m       [2m0[0m [2mlocal[0m          [38;2;192;132;252m@demo/ui[0m[2m#[0m[38;2;96;165;250mtest[0m
            [38;2;6;182;212mrun[0m     [2mmiss[0m           [2m—[0m       [2m—[0m     [2m—[0m      [2m—[0m       [2m—[0m       [2m0[0m [2mlocal[0m          [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;96;165;250mtest[0m

  [2mtasks   [0m  [38;2;203;213;225m4 planned · 2 cache hits (2 local) · 2 would run[0m
```

Each row is a task in the run's own words: `cached` `local` is a hit, `run` `miss` would execute. `worker` says where it would run.

| Status / cache    | Meaning                                                                       |
| ----------------- | ----------------------------------------------------------------------------- |
| `cached` `local`  | entry already in `<cacheDir>/`                                                |
| `cached` `remote` | entry would be fetched from the layer                                         |
| `run` `miss`      | task would execute (under `--force` too: nothing is read, what runs is saved) |
| `run` `no-cache`  | task opts out (no `cache: true`, or `--no-cache`)                             |
| `noop`            | task would not run anywhere                                                   |
| `not run`         | a server you did not request whose every dependant is a hit, local or remote  |
| `skipped`         | `exec.platforms` leave this machine out, or a task it depends on is skipped   |

Default: off. A run without `--dry` executes.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

**What a plan does**

- It builds the full task graph and computes each task's cache key as the run would, then asks the cache for each key.
- A server no task depends on has no key: its `hash` is `""`.
- Against a remote cache it only checks that the entry exists. A plan never downloads or unpacks an artifact.
- With no remote it writes nothing: no `.vx/cache`, no index, not even the folder a mistyped `--cache-dir` names.
- With a remote it keeps the remote hits it found in the local index, so the `vx run` after it fetches them at once.
- A remote that can batch is asked once for every key. One that cannot, or whose batch failed, is asked for each key at once.
- So an unreachable remote costs a plan its timeout about twice, not once per task.
- The colour of the status word carries the outcome. Group tasks are left out of the panel; the JSON lists them.
- The cache key is in `--dry --format json`.

**Time prediction**

- `usual` is a would-run task's typical time: `~p50` over its recent runs that were not hits, from the local `cache.db`.
- `predicted` forecasts the run. `wall` is the longest dependency chain of would-run time.
- A cache hit restores near-instantly and counts as 0 in `wall`.
- `total execution` is the sum over the tasks that would run.
- A task with no timing yet (no run that executed and passed) counts as 0, and the line says `N tasks never timed (+?)`. The totals are lower bounds.
- `predicted` is left out when nothing would run, or when no task that would run has history.

**Placement**

- `worker` is the executor's name (`spy-remote`) when the workspace's plugins supply more than one, and `local` for this machine.
- The JSON object carries it as `executor`.
- `noop` with no worker: an `exec.remote: 'only'` task no remote accepts. The run skips it, and it costs nothing in the prediction.
- An executor hook that throws, or returns something that is not an executor, does not fail `--dry`. The plan still prints.
- The status line then names the plugin: `[vx] placement not shown — plugin 'x' … (the run would refuse on it)`.

**Platforms**

- A task whose `exec.platforms` leave this machine out is `skipped`, and so is every task that depends on it, as in a run.
- The row says why: `needs darwin-arm64, this is linux-x64`, or `blocked by mac#build`.
- The JSON carries `otherPlatform` or `blockedBy`.
- On CI, or when no executor routes such a task, `--dry` refuses as the run does.

**A key that cannot be derived**

- A task whose `inputs.runtime` or `workspaceRuntime` probe exits non-zero, or whose `inputs.env` value is refused, has no key. The run fails it.
- `--dry` prints the run's own line to stderr: `[vx] @demo/web#build: cache key not derived: inputs.runtime probe exited 7: …`.
- It still prints the plan, then exits 1.
- That task's row and its dependants' read `run` `no-cache` with an empty `hash`: the status list has no word for a failure.

</div>
</details>

`--dry --format json` emits the same data as one JSON object on one line, alone on stdout. Indented here to read:

```sh
vx run build test --filter @demo/web... --dry --format json
```

```json
{
  "tasks": [
    {
      "id": "@demo/ui#build",
      "project": "@demo/ui",
      "task": "build",
      "hash": "048c3a3df13acfff",
      "cacheStatus": "hit-local",
      "deps": [],
      "command": "vite build",
      "p50Ms": 1055
    },
    {
      "id": "@demo/web#build",
      "project": "@demo/web",
      "task": "build",
      "hash": "36121304ff7e9b50",
      "cacheStatus": "hit-local",
      "deps": ["@demo/ui#build"],
      "command": "vite build",
      "p50Ms": 497
    },
    {
      "id": "@demo/ui#test",
      "project": "@demo/ui",
      "task": "test",
      "hash": "2482ed258adc10aa",
      "cacheStatus": "miss",
      "deps": [],
      "command": "vitest run src",
      "p50Ms": 3384
    },
    {
      "id": "@demo/web#test",
      "project": "@demo/web",
      "task": "test",
      "hash": "c5d95df67d047d6c",
      "cacheStatus": "miss",
      "deps": ["@demo/ui#build"],
      "command": "vitest run src",
      "p50Ms": 2610
    }
  ],
  "predicted": {
    "wallMs": 3384,
    "workMs": 5994,
    "unknownCount": 0,
    "criticalPath": ["@demo/ui#test"]
  }
}
```

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- A stage's warnings go to stderr, and so does what a plugin hook prints under any core verb's `--format json`.
- A plugin verb owns its own stdout.
- With nothing to run (nothing affected), `tasks` is an empty list and the note goes to stderr.
- `schemas/plan.json` is its JSON Schema, held like the read verbs' (see Machine-readable output).
- Every task with history carries `p50Ms`, hits included. Only the text view's `usual` is limited to tasks that would run.
- `predicted` counts would-run tasks only, and is present whenever local history was readable.
- `criticalPath` names the would-run tasks with history on the chain `wallMs` measures, dependencies first.
- Those are the tasks to speed up to shorten the run.

</div>
</details>

### Why a task is affected (`affected.kind`)

Under `--affected`, each task the diff kept says why after its id. Its JSON object carries the reason as `affected`.

```sh
vx run build lint --affected=main --dry
```

```ansi
[4m[58;2;110;118;129m  [1m[38;2;167;139;250mPlan[0m[4m[58;2;110;118;129m [2m3[0m[4m[58;2;110;118;129m    [2mstatus  cache      usual    time   cpu    mem outputs  blocks worker         task[0m[4m[58;2;110;118;129m                           [0m
            [38;2;6;182;212mrun[0m     [2mmiss[0m      [2m~153ms[0m       [2m—[0m     [2m—[0m      [2m—[0m       [2m—[0m       [38;2;203;213;225m1[0m [2mlocal[0m          [38;2;192;132;252m@demo/ui[0m[2m#[0m[38;2;244;114;182mbuild[0m  [2maffected: packages/ui/src/index.ts changed (an input)[0m
            [38;2;6;182;212mrun[0m     [2mmiss[0m      [2m~141ms[0m       [2m—[0m     [2m—[0m      [2m—[0m       [2m—[0m       [2m0[0m [2mlocal[0m          [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;244;114;182mbuild[0m  [2maffected: packages/ui/src/index.ts changed (an input), via @demo/ui#build[0m
            [38;2;6;182;212mrun[0m     [2mmiss[0m           [2m—[0m       [2m—[0m     [2m—[0m      [2m—[0m       [2m—[0m       [2m0[0m [2mlocal[0m          [38;2;192;132;252m@demo/ui[0m[2m#[0m[38;2;232;121;249mlint[0m  [2maffected: packages/ui/src/index.ts changed (an input)[0m

  [2mtasks    [0m  [38;2;203;213;225m3 planned · 3 would run[0m
  [2mpredicted[0m  [38;2;203;213;225m~294ms wall · ~294ms total execution · 1 task never timed (+?)[0m
```

| `kind`      | Why the task is kept                                                   |
| ----------- | ---------------------------------------------------------------------- |
| `input`     | a changed `file` is one of its declared inputs                         |
| `project`   | its project changed and the task reads the project whole               |
| `workspace` | a `file` no project owns changed and reached every task of the project |
| `package`   | a `^` edge passes a changed `project` that has no such task            |
| `named`     | you named it as `pkg#task` beside a bare task                          |
| `selected`  | another filter selected its project                                    |

`via` is the `dependsOn` chain, nearest first, to the task the change reached.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- On a terminal too narrow for the reason beside its row, the reason goes on its own line under the row.
- `project` covers a task with no `inputs`, and a changed `file` no task of the project declares, often an output git does not ignore.
- A `project` reason for a config import has no `file`.
- `workspace` from the workspace config reaches every project, shown as `changed (workspace-wide)`.
- `workspace` from a root file a plugin claims (a lockfile) or a folder it names reaches only the projects whose digest moved.
- That one is shown as `changed (every task in its project)`.
- A dependency the kept tasks pull in carries no reason.
- The reasons are gathered only for a plan. A run pays nothing for them.
- `--dry --format json` also states `affectedBase`, the ref the diff was taken against.
- A bare `--affected` picks that base: a plugin's base, else the base branch.
- So a reason that names no file may come from a commit the base reaches, a root `package.json` edit among them.

</div>
</details>

## Run artifacts (`--profile`)

`--profile` writes a file about the run after it ends. It never changes the run's exit code, since the run already happened.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- An error writing the file prints `vx: failed to write …`, and the exit code stays the run's.
- `--profile dist/` (a path that is a folder) is refused before the run, `VX_E_USAGE`.
- `--profile traces/run.json` makes a missing `traces/` folder.

</div>
</details>

### `--profile[=<path>]`

Writes a Chrome trace of every task's time span. Open it in `chrome://tracing` or https://ui.perfetto.dev.

```sh
vx run build --profile
```

```json
{
  "traceEvents": [
    {
      "name": "@vzn/vx#lint",
      "cat": "success",
      "ph": "X",
      "ts": 12345,
      "dur": 4321,
      "pid": 1,
      "tid": 1,
      "args": {
        "exitCode": 0,
        "hash": "...",
        "cpuMs": 123,
        "peakRssBytes": 45678
      }
    }
  ]
}
```

| Field | Means                                                                         |
| ----- | ----------------------------------------------------------------------------- |
| `cat` | the task's final status: `success`, `cache-hit`, `cache-hit-remote`, `failed` |
| `ts`  | start, in microseconds                                                        |
| `dur` | length, in microseconds                                                       |
| `tid` | the lane the task is drawn on                                                 |

Default path: `profile.json` (cwd-relative).

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- Each project gets its own `tid`, and one more for each task it runs beside another of its own. Tasks that overlap draw on separate lanes.
- `ts` and `dur` come from the per-task `hrtime.bigint()` spans the runner captures.
- A remote hit this run downloaded also carries `fetchMs`, its download and unpack. The rest of its `dur` is vx's.
- With a remote cache, lane 0 holds two `cache` spans: `stable keys` (the up-front keys, `args.keys`) and `remote probe`.
- `remote probe` is the batch check: `args.keys` asked, `args.held` found.
- An executor adds its own events after the run's process (`TaskExecutor.profile`).
- `@vzn/vx-dte` adds one process per worker, each task on a lane of its own, plus the orchestrator's waits ([its README](https://github.com/vznjs/vx/tree/main/packages/vx-dte#readme)).

</div>
</details>

## Sandbox

A sandbox lets a task read and write only the paths you grant it. You turn it on per task with an `exec.sandbox` block; there is no `--sandbox` flag.

```ts
// vx.config.ts
export default {
  tasks: {
    build: {
      exec: {
        command: 'vite build',
        sandbox: {
          allow: {
            read: ['.'],
            write: ['dist/**'],
          },
        },
      },
      inputs: { files: ['src/**'] },
      outputs: { files: ['dist/**'] },
      cache: true,
    },
  },
}
```

A task that touches a path it was not granted fails, and nothing is cached for it. Its `SANDBOX VIOLATIONS` section ends with a `fix:` line naming the grants it needed:

```
fix: exec.sandbox.allow: { read: ['tsconfig.json'], write: ['dist/'] }
```

Default: no sandbox. The full reference is [`modules/sandbox.md`](./modules/sandbox.md#srcsandboxruntimets--sandbox-wrapper-for-per-task-isolation).

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

**What a task is granted**

- The grants are the task's whole permission surface. Nothing is derived from `cache`.
- Core adds only `node_modules` and the workspace packages linked there.
- Never a link back to the task's own project: npm and Yarn make that link too, and it is not granted.
- For a task that declares `cache`, a linked package is granted only when its key includes a task of that package.
- So declaring `cache` narrows core's grant and widens nothing.
- Enforcement starts at the workspace root: a task never leaves its project.
- Only denials inside the project, or under a withheld linked package, are reported.

**On a violation**

- Linux: the task fails on its own, with `ENOENT`, since bwrap hides the path from its mount namespace.
- macOS: the violation store flags it and vx forces a non-zero exit.
- No cache entry is written for a failed task.

**The `fix:` line**

- Each path is relative to the project, anywhere in the workspace: `'../a/src/x.js'`. An absolute path holds on no other machine.
- Each path is a JS string literal spelled as the glob it must be. A bracket is escaped: `read: ['pages/\\[id\\].tsx']`.
- In `inputs.files` too, where `*` or `?` is a class, the line writes `'a[*]b.txt'`.
- A leading `!` is escaped, `'\\!notes'`: raw, it is a negation that keys nothing.
- A path no grant can name alone is granted as the folder above it: one with `*`, `?` or a backslash, and on Linux a write with a bracket (see `schema.md`).
- On Linux a refused open is a read or a write by the flags it asked with.
- A missing file opened to read is a read grant, never a file vx would create.
- A host that `deny.network` holds gets no network grant.

**Write grants**

- A write also grants the narrowest folder the next file there lands in.
- Under a declared output, that is the output's folder: `src/generated/`, never `src/`.
- In `node_modules`, it is the tool's own folder: `node_modules/.vite/`, `node_modules/.cache/storybook/`, `node_modules/.prisma/`. Never every installed package.
- Anywhere else, it is the top folder the file landed in.
- When `inputs.files` reads that folder, the line grants the file alone, so the task cannot write its own inputs.
- `vite.config.ts.timestamp-<ms>-<hex>.mjs`: a file named for the millisecond it was made (13 digits) is new each run.
- So its folder is granted instead (`node_modules/.vite-temp/`).
- Where that folder is the project itself, the grant is a glob from the clock on: `vite.config.ts.timestamp-*.mjs`.

**Reads the output depends on**

- A grant never adds a key input. So a read the output depends on is named as an input as well, and the line says so.
- A read in the project goes to `inputs.files`. One elsewhere in the workspace goes to `inputs.workspaceFiles` (workspace-relative).
- Applied as given, the two lines key every read they grant, so an edit there re-runs the task.

**Links**

- A read through a link grants the folder holding the link too.
- The sandbox mounts a grant at its real path and never the link, so the target alone stayed out of reach.
- A link into another project (`shared -> ../ui/shared`) works the same: the project's grant lays the link.
- Behind that link stands only what the grants bind.

**Credentials**

- `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.config/gh`, `~/.config/gcloud`: a credential path is never put in the `fix:` line.
- So are `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/.docker/config.json` and a `.env` file.
- An agent applies the line as given, so a credential is named apart, as one to grant only on purpose.

**Wider than they read**

- On Linux the grants are wider than they read: a write grant shaped like a file is bound as its whole folder.
- So every file beside it is readable without a violation.
- `schema.md` § `exec.sandbox` has the shape and the remedy: put outputs in a subfolder.

**The runtime**

- `vx run` arms the sandbox runtime when a task that declares `exec.sandbox` is about to execute. A cache hit needs none.
- Linux needs `bwrap`, `socat` and `rg` on PATH. macOS needs `sandbox-exec`.
- Where the platform cannot host it, that task fails with one line, `sandbox not available: <reason>`, and never runs unsandboxed.
- Tasks without a sandbox run as usual. The failed task's dependents are skipped.
- A task taken by an executor that enforces the sandbox where it runs (`@vzn/vx-dte`'s workers) arms nothing here.
- So a DTE run's orchestrator needs no sandbox runtime.

</div>
</details>

## `vx watch`

`vx watch` runs a task, then runs it again each time you save a file in the projects it covers. Press `Ctrl+C` to stop.

### Usage

```sh
vx watch [OPTIONS] [--poll] TASK [-- forwarded-args...]
```

`OPTIONS` are `vx run`'s, less the ones [Constraints](#constraints) names.

### Examples

```sh
vx watch test                       # cwd project; re-test on changes
vx watch test --all                 # every project that declares `test`
vx watch lint --filter '@scope/*'   # filtered scope
vx watch build -- --sourcemap       # forwarded args carry through every cycle
```

The first run, then one save to `src/index.ts`, then `Ctrl+C`:

```ansi
[2m┌─[0m [1m[38;2;192;132;252m@demo/ui[0m[2m#[0m[1m[38;2;244;114;182mbuild[0m [2m>[0m $ vite build
[36mvite v8.3.1 [32mbuilding client environment for production...[36m[39m
transforming...
[32m✓[0m 2 modules transformed.
rendering chunks...
computing gzip size...
[2mdist/[0m[36mindex.js  [0m[1;2m0.08 kB[0m[2m │ gzip: 0.10 kB[0m

[32m✓ built in 24ms[39m
[0m[2m└─[0m [1m[38;2;192;132;252m@demo/ui[0m[2m#[0m[1m[38;2;244;114;182mbuild[0m [2m──[0m [2m(9ms)[0m [2mrestored-local[0m

[38;2;6;182;212mwatching 1 project · 1 task[0m

[38;2;6;182;212mchanged @demo/ui src/index.ts[0m
[2m┌─[0m [1m[38;2;192;132;252m@demo/ui[0m[2m#[0m[1m[38;2;244;114;182mbuild[0m [2m>[0m $ vite build
[36mvite v8.3.1 [32mbuilding client environment for production...[36m[39m
transforming...
[32m✓[0m 2 modules transformed.
rendering chunks...
computing gzip size...
[2mdist/[0m[36mindex.js  [0m[1;2m0.08 kB[0m[2m │ gzip: 0.10 kB[0m

[32m✓ built in 21ms[39m
[0m[2m└─[0m [1m[38;2;192;132;252m@demo/ui[0m[2m#[0m[1m[38;2;244;114;182mbuild[0m [2m──[0m [2m(164ms)[0m [2msuccess[0m


[1m[38;2;6;182;212mvx watch:[0m[2m stopped[0m
```

### Options

| Option   | Meaning                                                                                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--poll` | Re-walk the watched files every 250 ms (`watch.pollInterval`) from the start instead of the OS watcher, as `VX_WATCH_POLL=1` does. For network mounts and containers. |

Every other flag is `vx run`'s ([Flags](#flags)).

### Lifecycle

1. **Initial run.** The same as `vx run`: same scope, same task graph, same cache. It prints its rows alone.
2. **Watch loop.** Then vx watches every project the task can reach, and prints `watching N projects · M tasks`.
3. **On change.** A save starts a cycle: `changed <project> <relpath>`, then the task rows. The cache keys decide what runs.
4. **Exit.** `Ctrl+C` stops the cycle in flight, prints `vx watch: stopped` last, and exits 0.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

**An edit during the initial run**

- No watcher is armed during the initial run, so an edit made then has no event. vx finds it another way.
- An edit to the inputs of a task the run was running leaves that task unsaved: its key no longer describes them.
- The loop then starts its first cycle on it, labelled `<task> inputs, edited during the first run`.
- Any other edit (an input of a task that already finished, a new lock) is found as the loop arms.
- There, a file git lists as untracked or modified, written since the run started by none of its commands, is a change. The first cycle runs on it.
- git is asked again once the watchers are up, so a save between the two is not lost.
- A file written while a command of its own project ran may be that command's: the keys are taken again, and it is a change when one moved.
- A loop that armed while the run waited on a server does both once the run returns. So an edit beside a dev server already up is a cycle too.
- A tracked file deleted during the run has no date to tell it from one deleted before: the keys are taken again for it too.
- An edit committed during the run is no longer modified, and a checkout or stash leaves clean files the run never read.
- So whenever git's index moved since the run started, the keys are taken again.
- One that moved starts a cycle labelled `files, committed or checked out during the first run`.
- An untracked file deleted during the run is still not heard: nothing lists it.

**What is watched**

- The loop starts when the initial run finishes, or once the run waits only on a server's readiness.
- Watched recursively: the folder of every project a cycle can run, less any project nested inside it, with a config or not.
- That set is the scope plus its transitive dependencies, the closure `--filter '@demo/web...'` walks, cross-project `dependsOn` edges included.
- The scope is the bare tasks' scope plus each `pkg#task`'s own project. When every task is anchored, only those projects.
- A root project's key leaves a nested project's files out, so an edit in a nested project is no cycle for the root.
- The workspace root is watched, not recursively, for a claimed file (a lockfile), for `.vx/projects.lock` and for `.vx/workspace.*`.
- `.vx/workspace.*` shapes a run (plugins, `config` stage, concurrency) without being any task's input. The cycle after its edit re-reads it.
- With `.vx/workspace.*` removed, a cycle fails, as `vx run` refuses, until the file is back.
- A `.gitignore` at the root or in a project's parent folder is a cycle too, and so is `.git/info/exclude`: inputs follow gitignore.
- The files a claimed file's digests read, as `.vx/dependencies.lock` records them, are watched too, and their edit is a cycle.
- Those are a `file:` or `link:` dependency's folder, inside the root or not, and a patch file. A re-lock that changes the set re-arms it.
- A file a config imports from disk, from outside the watched projects (a shared preset), is watched. Its edit re-reads the configs.
- That counts relative imports, `#imports` and tsconfig aliases, as `--affected` follows them.
- An import inside a project re-reads the set, as an edit to the config does.
- A file the workspace config imports is loaded once per process. Its edit names the restart it needs rather than run stale.
- An import whose file is gone stays on the list under the name it would have, so its return is a cycle.

**Which projects**

- The projects are the lock's. A new `.vx/projects.lock` is the event that adds or drops one.
- A new project's folder is watched from before that cycle runs, so an edit made during it queues.
- A config added and not locked is no project yet.
- With no lock at start, the first cycle fails saying so, and the watch waits for one.
- Under `--filter` or `--affected` the scope is the one resolved at start. A new project joins it only as a dependency of it.

**Folders removed and made again**

- A project folder, or one a config imports from, removed and made again (a checkout that restores `packages/`) is still heard.
- It is heard from its nearest folder that exists and each one above it.
- A watch whose folder was replaced is armed again: an OS watch holds the deleted one.
- There, a project folder that is still the same one starts no cycle.
- That is a task writing at its top level, which moved its mtime: macOS reports that to the parent.

**Outputs are not edits**

- A task's own declared outputs (`outputs.files`, `outputs.workspaceFiles`) never trigger a run. A plugin's `project` stage counts, as in a run.
- So a cycle that writes `dist/` is not an edit, nor is `dist` itself coming and going. A literal entry covers its whole tree.
- The exception: some task reads the path as an input. A formatter's `src/**` output still leaves a `build` reading `src/**` watching it.
- A task's own outputs are no input of it, so a task reading `**/*` does not re-run on its own `dist/`.
- Only the tasks the run reaches through `dependsOn` are asked. An unwatched `lint` reading `**/*` beside `vx watch build` asks nothing.
- `node_modules`, `.git` and the cache folder never trigger a run either (see Path filtering for the exceptions).

**What counts as an edit**

- A write the task did not declare is judged by state, once its bytes have settled. A task with no `cache: true` declares nothing.
- A file whose bytes and mode did not change since the loop last saw it is no edit. A `chmod` is one: the key reads the executable bit.
- A folder whose entries (names and sizes) did not change is no edit, nor is a path that stayed gone.
- A symlink is its target string and what it points to, as the key folds them. A retarget is an edit.
- So is an edit behind a link: watch arms each link's target, wherever it lies, and names the link.
- A path the loop has never judged is an edit only if it was modified after the watchers went live.
- macOS delivers the initial run's own writes after the arm. The later of the path's mtime and ctime says which side it is on.
- So a file moved in with an old mtime by `mv`, `cp -p` or `tar x` still counts. A symlink's own times are read, never its target's.
- A path git did not list at the arm that is gone again is no edit: vim's `4913` write probe, a lock file.
- A `.gitignore` edit lists again, so a file it stops ignoring is an edit.

**Nothing is judged during a cycle**

- A cycle's own writes are mid-flight, and a `dist` deleted and not yet rebuilt is a state the tree will not keep.
- So paths that land during a cycle are judged together, one debounce window after it ends, an edit made meanwhile included.
- A task's input edited while it ran is not saved, and its line says the next cycle runs on it.
- It does, once, even when the file was put back as the last judgement saw it, since the task read the other one.
- A task whose next run leaves the file as that cycle found it rewrote the file itself (`sort -o`, `sed -i` write even when nothing changed).
- That starts no cycle, where it would re-run forever, and watch says so once.
- The same goes for a file written during the cycle where no command of it may write.
- That includes an edit landing before the keys and put back while the cycle runs.

**A task that writes into its own project**

- `rm -rf dist && vite build` costs one extra cycle, not an endless loop, when the bytes it leaves are the same.
- A file it rewrites with different bytes every run (a pid file, a timestamped log) must be git-ignored or declared an output.
- Otherwise the loop re-runs on it. After three such cycles in a row, watch names the path and the remedy, once, and keeps going.
- A git-ignored path never starts a cycle, since no cache key can see it. The exceptions follow.
- Your edit to an ignored file still starts one in a project with a task that has a command and no cache: that task reads what it likes.
- That holds outside any project nested in it, and for an ignored file a task names outright.
- A write the last cycle made is not an edit, read off the later of its mtime and ctime. So an output a cache hit restores is the run's.
- Unless no command of the cycle may have made it: an edit to `node_modules/.gen/**` after its task ran, while another task held the run, is a cycle.

**Dev servers and their writes**

- A dev server the last cycle left running counts as that cycle for as long as it runs.
- So a log it rewrites in its project is named too, with `.gitignore` as the remedy: a persistent task declares no outputs.
- Only a file in a running server's own project, outside any project nested there, is blamed on it.
- A file git tracks is never blamed, as git answers when it would be. So a file committed or checked out since watch started counts.
- Three saves of a source file are yours.
- A new file not yet added to git in the server's own project looks like the server's write. `git add` it.

**One root watcher**

- When any project's config declares `inputs.workspaceFiles`, the per-project watchers become one recursive watcher on the root.
- Boundaries are off for those globs, so a root-relative glob can name a file anywhere.
- That watcher hears every write in the tree and keeps only the ones a key can see.
- Those are: a path inside a project's folder, a fingerprint file at the root, or a match of a declared `workspaceFiles` glob.
- A log written at the root, a `coverage/` tree, an editor's scratch file are dropped before the trigger.
- So `vx watch … > build.log` inside the repo settles, instead of starting a cycle per line of its own output.

**The `watching` line**

- `watching N projects · M tasks` prints after the initial run's rows, only once every watcher has heard a probe file written under it.
- The probe is `.vx-watch-probe`, written again on a short backoff until its event arrives, then removed.
- On macOS a folder watcher can return before its event stream is live, and an edit in that gap is lost. So the line is a promise.
- A probe is never an edit, at any depth. Another watcher's probe, seen under a nested project, once ran a cycle with no edit made.
- A watcher whose probe is not heard within 2 s is replaced by a poller that checks every 250 ms.
- The notice: `vx watch: <dir>: no OS watch events within 2000 ms; polling every 250 ms instead`.

**On change**

- A cycle opens with a blank line and `changed <project> <relpath>`, plus ` (+N more)` when more paths changed.
- Then come its task rows as `vx run` prints them, with no footer.
- Where a hit prints no row (`--all`, `--filter`, `--affected`, `--output-logs errors-only` or `none`), a cycle of hits alone says ` N tasks cached, nothing ran`.
- So a cycle back to cached bytes is not silent below the failure before it.
- The named path is the first changed file that still exists, a folder only when no file changed.
- An editor's temporary file renamed away names nothing. A deletion names the cycle when nothing else changed.
- The `watching` line is said once. A cycle that re-reads the watched set (a member came or went, the lock or a plugin changed) says nothing more.
- `VX_DEBUG_WATCH=1` says each arm on stderr as `vx watch: armed N projects (M watches)`, M the OS watches or pollers open.
- A plugin's warning is said once a cycle, by the cycle's run. The watch's own reads of the configs say none.
- Errors and refusals go to stderr.

**What a cycle runs**

- Each cycle runs with the same options, save one: the `--affected` diff is read once, for the initial run.
- A later cycle runs the requested task in every project of the scope fixed at start, and the cache keys decide what executes.
- Asking the startup diff again would keep an edit made since out of every cycle.
- A task no key can answer for (an uncached one, or a cached one that failed) keeps the last cycle's result. Its row says `kept`.
- That holds when its key is the one it ran under and no path that started the cycle lies in its project.
- So editing the app runs no uncached generator it builds on, and an edit elsewhere runs no failing lint again.
- A path outside every project, a timeout, a proven flake or a result its key does not vouch for keeps nothing.
- Events that arrive during a cycle queue and run after it.
- A cycle starts ~150 ms after the last event, and at most 1 s after the first, so a writer that never pauses holds no edit back.

**Exit**

- `SIGINT` (`Ctrl+C`), `SIGTERM` or `SIGHUP` exits 0. `vx watch: stopped` is the last line, once the cycle in flight is down.

</div>
</details>

### Path filtering

Some paths never start a cycle. Everything else does, and the cache keys decide what actually runs.

| Never a cycle             | Why                                                         |
| ------------------------- | ----------------------------------------------------------- |
| `.git/`, `.vx/cache/`     | vx's and git's own files, anywhere in the path              |
| `node_modules/`           | installed packages, anywhere in the path (exceptions below) |
| a path git ignores        | no cache key can see it                                     |
| `notes.md~`               | a file ending in `~`, an editor swap file                   |
| `.vx/tmp/`                | where restores stage                                        |
| the resolved cache folder | vx's own cache writes                                       |
| `mkdir src/new`           | a new empty folder holds nothing a key reads                |

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

**`node_modules`**

- `node_modules/.prisma/client/**`: what a task the watch reaches names there, through that segment, is an input. An edit there is a cycle.
- So is a file git tracks there, such as a committed fixture under `fixtures/node_modules/`.
- Both watchers enter only those folders.
- A broad glob (`**`, `fixtures/**`) names no `node_modules`.

**Ignored paths**

- git is asked (`git check-ignore`) once per debounce window, never per event.
- `.env.local` or `dist/**` named outright in a task's inputs is watched, by the rule the key reads them (schema.md § gitignore filter).
- `src/**` over a listed `src` names no ignored `src/dev.log`, so a dev server writing one starts no cycle.
- Any other ignored path is invisible to every cache key (inputs are tracked plus untracked-not-ignored), so it never names a cycle.
- A tracked file that matches an ignore pattern is not ignored, by git's own rule. Outside a repository nothing is ignored.

**The cache folder**

- `.vx/cache/` covers the default. `defineWorkspace({ cache: { dir } })` and `--cache-dir` can put the cache anywhere, and that is ignored too.
- Watching it would let vx's own cache writes start the next cycle, which writes again: a loop that never settles.
- A `cache.dir` edit during the watch moves the filter with it, from the cycle that re-reads the config.

**New folders**

- A file made in a new empty folder is the change.
- So is a folder moved in with files (`mv stage src/moved`), whatever their times.
- A project folder made again, which the watch waits on, still is one.

**Why not filter by inputs**

- vx deliberately does not filter events against per-task `inputs.files`: the cache key is the source of truth.
- A change to an unrelated file costs a cache-hit run, typically tens of ms. That is far cheaper than a glob match per event.

</div>
</details>

### How changes are seen

vx opens one recursive OS watcher (`fs.watch`) per project folder in scope. Each one must prove it works within 2 s, or vx polls that folder every 250 ms instead.

```sh
VX_WATCH_POLL=1 vx watch build   # poll from the start
```

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- Also watched: the workspace root for the fingerprint files, `.git/info/` for `exclude`, and each file or folder a claimed file's digests read.
- A folder whose watcher reports nothing within 2 s of the probe is polled every 250 ms.
- stderr says so in one line: `no OS watch events within 2000 ms; polling every 250 ms instead`.
- Where the watcher is known not to deliver (a macOS sandbox without FSEvents access, a network mount, a container bind), use `VX_WATCH_POLL=1`.
- It polls from the start and skips the 2 s probe. The loop says so once: `vx watch: polling every 250 ms (watch.poll)`.
- A watcher the OS refuses for its watch limit (`ENOSPC`, `EMFILE`) is polled too, with a notice naming the limit to raise.
- So is one that meets the limit later, at a folder made during the watch: its whole project folder is polled from then on.
- The poller walks the same tree the event filter keeps. It never samples the always-ignored segments or the run's output folders.
- Unless a task's inputs can lie in one (`src/**/*.ts` beside an output `src/**/*.js`), or git tracks a file there.
- It samples each file's later clock of mtime and ctime. A replacement that keeps the old mtime (`cp -p`, `rsync -a`, a `mv`) is an edit.
- It samples each folder by its identity, as the OS watcher reports it. So a folder moved in is a change, though its files keep older times.

</div>
</details>

### Claimed root file changes

A root file a plugin claims starts a cycle: a lockfile under `@vzn/vx-lockfile` (`pnpm-lock.yaml`, `bun.lock`, `.npmrc`, …), or `turbo.json` under `@vzn/vx-migrate`'s `turbo()`. So does `.vx/projects.lock`.

A config edit alone changes no command, since every cycle reads its configs from `.vx/projects.lock`. The watch says so, and each cycle refuses the edited config, as a run does, until `vx lock`:

```
vx watch: packages/web/vx.config.ts changed; runs read the lock, so run `vx lock` to apply it
vx watch: cycle failed: packages/web/vx.config.ts changed since the last `vx lock` — run `vx lock`
```

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- Watch hears these files because it watches the workspace root, not recursively.
- A plugin added to the workspace config during the watch counts from the cycle that loads it.
- The keys decide which projects re-run. Core keys no package file, so a lockfile edit re-keys only through its claimant ([cache key derivation](./caching.md#cache-key-derivation)).
- An edit to a file a config imports prints the same `run vx lock` line.
- A re-lock (`vx lock`) is a cycle that re-reads the watched set.

</div>
</details>

### Constraints

The following flags are rejected (parser exits 1 before the initial
run):

- `--dry` — it skips execution; nothing to watch.
- `--format` — only a plan has one; each cycle's run is
  `vx last --format json` after it.
- `--profile` — would overwrite its target per cycle.
- `--verbosity <n>` (n > 0) — formats ONE run's result; a watch loop has no single run to report.
- `--verbosity 0` is accepted: it asks for what watch already prints.

**Dev servers.** A persistent task (`exec.persistent`) starts once and stays up across cycles. Each cycle re-runs what it depends on, as the keys decide.

```sh
vx watch dev   # dev depends on ^build
```

Each edit rebuilds only the libraries it reaches on the way to the app. The server keeps running, and the dev tool's own reload picks up what was rebuilt.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

**What it prints**

- A persistent task counts whether you requested it or it is only a dependency.
- What the server writes keeps printing, under its id, above the rows while a cycle rebuilds.
- Its frame closes `still running` in a cycle that kept it.

**When it restarts**

- A requested server, and one it depends on, restarts only when its own task config or forwarded args changed, or when it died.
- A server only another task depends on restarts when its key changed: a file in its `inputs.files`, its config, or what it depends on.
- So `vx watch e2e` boots its api once, and again only after an edit the api's key sees. `e2e` never tests the old one.
- With no `inputs.files`, that server restarts every cycle: no key sees its edits.
- The old one is always stopped first (the kill grace, then SIGKILL), so the two never hold one port.

**When it stops**

- One that dies while watch idles is said: `vx: @demo/web#dev exited with code 3`. The next change starts it again.
- What it left running in its process group is SIGKILLed then, so no orphan holds its port until the next change.
- A cycle in which a task the server depends on fails stops it.
- So does a cycle that no longer starts it: its dependants all hit, or the selection changed.
- Stopping watch stops the server too.

**A server not ready yet**

- An edit while a cycle waits only on a server that has not printed its `readyWhen` line stops that cycle and starts the next.
- So a fix reaches a server stuck before ready, in the initial run too. The servers already up stay up through it.
- A file the server writes as it boots (a timestamped config bundle, a pid file) stops no further cycle, so the server is not restarted for good.
- That is a file git does not track in its project, no task's inputs name, that stopped the last such cycle and is written again as the next starts.
- A new source file saved again is an edit.

**One-shot tasks**

- `vx watch build` re-runs `build` and what it depends on.

</div>
</details>

### Exit codes

- `0` — clean Ctrl+C / SIGTERM exit; also once its reader is gone; also, with no watch, when `--affected` selects nothing (`vx watch: nothing affected since <ref>`, as `vx run` does).
- `1` — parser error, missing scope, or a task name no project in scope declares (the initial run refuses it as `vx run` does, with the same `Did you mean` hint).

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

**Stopping**

- A cycle in flight is torn down first: its children, and the dev server held between cycles, get the signal watch received.
- A Ctrl-C passes on as SIGINT. A SIGTERM or SIGHUP passes on as SIGTERM. Then a 2 s grace, then SIGKILL.
- The process leaves only once the cycle has returned, so a CI cancellation never orphans a task.
- A second signal during that teardown changes nothing: still `0`, once the cycle is down.
- `vx watch dev | head`, or a quit `| less`: Bun ignores SIGPIPE, so the next write's EPIPE stops the watch as a SIGTERM does.
- An idle watch with no reader ends at its next output.

**Refusals and failures**

- A task name no project declares exits rather than re-run the refusal on every change.
- So do `vx requires git`, when git is not on `PATH`, and a cache dir vx cannot make: no edit the watch hears fixes them.
- A cycle that throws (no `.vx/projects.lock`, or one that locks a config since removed) prints `vx watch: cycle failed: <reason>` once.
- Watch keeps watching, the initial run included, so the `vx lock` that fixes it re-runs.
- A cycle whose run fails (`{ ok: false }`) does not end the watch. It prints the framed FAILED block and waits for the next change.

</div>
</details>

## `vx pipeline`

`vx pipeline <name>` runs a pipeline from `.vx/workspace.ts`: its tasks, in every project that declares them, with the `vx run` flags it saves ([schema.md § Pipelines](schema.md#pipelines)). Each CI job names one.

### Usage

```sh
vx pipeline NAME [OPTIONS]
```

`OPTIONS` are `vx run`'s but `--all`: a pipeline runs every project.

### Examples

```ts
// .vx/workspace.ts
import { defineWorkspace } from '@vzn/vx/config'

export default defineWorkspace({
  pipelines: {
    pr: { tasks: ['lint', 'test'], affected: true },
    main: { tasks: ['lint', 'test', 'build'] },
  },
})
```

```sh
vx pipeline pr                     # lint and test what the change reaches
vx pipeline main                   # every project
vx pipeline main --dry             # the plan, nothing run
vx pipeline main --filter web      # main's tasks in web alone
```

A second `vx pipeline main` with nothing changed restores all six tasks from the cache:

```ansi
[4m[58;2;110;118;129m  [1m[38;2;167;139;250mSummary[0m[4m[58;2;110;118;129m                                                                                                       [2mvx 0.0.0[0m
  [2mprojects[0m  [38;2;234;179;8m▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰[0m
            [38;2;234;179;8m2 in run[0m [2m·[0m [2m2 total[0m
  [2mtasks   [0m  [38;2;34;197;94m▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰[0m
            [38;2;34;197;94m6 success[0m [2m·[0m [2m6 total[0m
  [2mcache   [0m  [38;2;34;197;94m▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰[0m
            [2mlocal[0m [38;2;34;197;94m6✓[0m

  [2minfo    [0m  4 workers [2m·[0m local cache [2m·[0m run 01a20a07-641f-7300-92ab-e3cb8be0761e
  [2mtime    [0m  21ms
```

### Options

Each key of a pipeline is a `vx run` flag in camelCase: `--fail-fast` is `failFast`. A flag you type beats the saved key, and so does its `VX_*` variable.

| Group           | Flags                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------- |
| scope           | `--filter`, `--affected`, `--exclude-dependencies`, `--branch`                              |
| running         | `--concurrency`, `--schedule`, `--timeout`, `--retries`, `--fail-fast`                      |
| cache           | `--no-cache`, `--force`, `--cache-policy`, `--cache-dir`, `--cache-download`                |
| cache transfers | `--cache-concurrency-download`, `--cache-concurrency-upload`, `--cache-concurrency-restore` |
| output          | `--output-logs`, `--verbosity`, `--dry`, `--format`, `--profile`                            |

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- A typed `--cache-policy` (or `VX_CACHE_POLICY`) also drops a saved `noCache` and `force`.
- A typed `--force` drops a saved `noCache`.
- A saved `cacheDir` or `profile` is read from the workspace root. A typed one is read from the current folder.
- A saved `true` has no typed flag that turns it off. Each yields only to its own escape:
- `failFast` yields to `VX_RUN_FAIL_FAST=false`.
- `noCache` and `force` yield to a typed `--cache-policy` or `VX_CACHE_POLICY`.
- `dry` yields to a typed `--profile`.
- `affected` yields only to another base, `--affected=<ref>`.
- Otherwise, edit the pipeline.
- A pipeline's `env` is set for vx and its plugins before they start. Every task reads it as unset.
- Nothing goes after `--`: forwarded args are for one task in one project.

</div>
</details>

### Exit codes

- `0` — every task passed, or `--dry` planned them.
- `1` — a task failed; or no name, a name no pipeline has (with the nearest one as a fix), a task name or `--all` typed, or a refused flag (`VX_E_USAGE`).
- `1` — a saved `cachePolicy`, or an `env` entry setting a `VX_*` variable, the run would refuse, naming that key (`VX_E_CONFIG`).

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- A refusal that names a saved flag, or a task no project declares, adds the key that holds it.
- For example: ``--affected is `pipelines.pr.affected` ``.

</div>
</details>

## `vx cache clean`

`vx cache clean` frees disk space: it drops old cache entries, trims the cache to a size, or with no bound clears it all.

It works on the store a run opens (`~/.vx/<id>/cache`, shared by every checkout of the workspace), or on `<cacheDir>` when the workspace names one (`cache.dir`, `VX_CACHE_DIR`, `--cache-dir`).

It never contacts a remote cache: a remote is pruned where it is hosted.

### Usage

```sh
vx cache clean --older-than <duration>     # Drop entries last used before now - duration (up to 1h slack).
vx cache clean --max-size <size>            # After age-based pruning, evict LRU until under <size>.
vx cache clean ... --dry                    # Say what either policy would reap; delete nothing.
vx cache clean ... --format json            # { dry, evicted, bytesFreed, orphans, orphanBytes, historyRows, historyBytes }
vx cache clean ... --cache-dir <path>       # The cache a run with the same flag uses.
vx cache clean                              # No bound: clear the whole cache (below).
vx cache clean --global                     # Also clear every other workspace's store.
```

### Examples

```sh
vx cache clean --older-than 30d
```

```ansi
[38;2;34;197;94m✓[0m [1mvx cache clean[0m  [38;2;203;213;225mfreed 95 MB[0m

  [38;2;203;213;225m15 entries[0m
```

With `--dry` it says what would go and deletes nothing:

```sh
vx cache clean --older-than 30d --dry
```

```ansi
[38;2;6;182;212m›[0m [1mvx cache clean[0m  [38;2;203;213;225mwould free 95 MB (dry run)[0m

  [38;2;203;213;225m15 entries[0m
```

### Options

| Option                    | Meaning                                                 |
| ------------------------- | ------------------------------------------------------- |
| `--older-than <duration>` | drop entries last used before now minus the duration    |
| `--max-size <size>`       | then evict the least recently used until under the size |
| `--dry`                   | say what would go; delete nothing                       |
| `--global`                | with no bound, also clear every other workspace's store |
| `--format json`           | the result as one object                                |
| `--cache-dir <path>`      | the cache a run with the same flag uses                 |

| Write  | Means      |
| ------ | ---------- |
| `30d`  | 30 days    |
| `24h`  | 24 hours   |
| `60m`  | 60 minutes |
| `500M` | 500 MiB    |
| `10G`  | 10 GiB     |

Default: no bound, which clears the whole cache. No run ever evicts anything: to bound the cache, run this from a schedule or CI.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

**Bounds**

- `--older-than 30d --max-size 10G`: both bounds may be combined. Age-based eviction runs first, then LRU while the total is over the size.
- `--older-than` allows up to an hour of slack.
- Sizes are on disk, as `du` counts them. A 5 KB file holds a whole block, so a store of small files is bigger than their lengths.
- The store keeps each output whole: a sparse file at its full length, and hard-linked files as separate copies. A restore writes them back the same way.
- Both flags take either form: `--older-than 30d` or `--older-than=30d`.

**History**

- A clean with a bound also drops run history and hash memos older than 30 days. A run never does.
- It gives the pages of the dropped rows and evicted entries back to the disk: a `VACUUM` of the index, once rows went.
- It reports the rows and the bytes the index shrank by (`historyRows`, `historyBytes`). A dry run, or one that dropped no row, reports neither.

**Duration units**

- `ms`, `s`, `m`, `h`, `d`, in any case: `30d`, `24h`, `60m`, `30s`, `30D`.
- Minutes are `m` only: `1M` is refused, since some tools read it as a month.

**Size units**

- `K`, `M`, `G`, `T`, powers of 1024, in any case, with an optional `B` or `iB`: `500M`, `1G`, `100K`, `2T`, `500MB`, `1gb`, `32KiB`.
- `--max-size 10` is refused: a bare number would read as ten bytes and evict nearly everything. Write `10G`, or `10B` if you mean bytes.

**A zero bound is rejected.**

- `--max-size 0` and `--older-than 0d` would evict every entry. That is far more often a retention computed to zero than an intent.
- `vx cache clean` with no bound clears the whole cache when that is what you want.

</div>
</details>

### Orphans

After eviction, the clean also removes **orphans**: cache files the index has no row for, and temp files a crashed save left behind.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

**What an orphan is**

- A `<hash>.tree` folder or `<hash>.tar.zst` the index has no row for.
- A `SCHEMA_VERSION` bump drops every table and leaves the artifacts behind, as a deleted `cache.db` does.
- A `<hash>.tree.tmp-*` or `<hash>.tar.zst.tmp-*` a save that crashed never renamed.

**When it goes**

- A run that asks for a row-less `<hash>.tar.zst`'s key indexes it again from its bytes and hits.
- A row-less tree (its stdout lived in its row), and an archive no task asks for again, are only reclaimed here.
- A row-less artifact is judged as an entry is, by its file time plus an hour. Another vx version sharing the store may still use it.
- A hit renews a file time over an hour old.
- A temp goes once it is an hour old. Nothing younger than an hour is taken.

**Only vx's names**

- `<hash>` is the key's 16 lowercase hex digits, and the temp suffix is the one a save makes.
- So a `release.tar.zst` beside the index in a `cache.dir` you share is never touched.

**Rows with no file**

- An index row whose artifact is gone (deleted by hand) is dropped by the same prune.
- Its bytes count toward neither `--max-size` nor the evicted total: they are on no disk.
- Counting them once evicted real entries to make room for them.
- A row used within the hour is kept until a later prune, but its bytes are left out all the same.
- The sweep runs on every prune, under either flag, and reports apart from the policy's evictions.

</div>
</details>

### `--dry`

`--dry` names what a clean with the same flags would take, and touches nothing.

```sh
vx cache clean --max-size 10G --dry
```

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- It picks the victims under the same policy and counts the orphans the sweep would take, then returns without touching the index or the folder.
- The real prune with the same flags reaps exactly what it named, an in-flight save aside, from the same store.
- One a run would not use is passed over by both.
- On an index an earlier vx wrote, which the real prune resets first, it reads the index as that reset leaves it.
- There the shared store's entries still face the policy, and every artifact in the workspace's own folder is row-less, judged on its file time.

</div>
</details>

### Concurrent runs

A clean that deletes waits for a `vx run` on the same workspace to finish first, so it never evicts what that run is restoring.

```
[vx] waiting for another vx run (pid N) on this workspace to finish…
```

A `vx watch` cycle holding the lock reads `a vx watch cycle (pid N)`, a clean `a vx cache clean (pid N)`.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- It waits on the run's lock, and says so after a second.
- A clean started by a task of that run is refused instead: the run holds the lock until the task ends.
- A run in another checkout takes no lock of this one's, but holds the shared store open until it ends.
- The clean waits for every process holding the store: `[vx] waiting for another vx process using the cache store <dir> to finish…`.
- A cache folder with no store (`--cache-dir`, `cache.dir`, `VX_CACHE_DIR`) may be another workspace's too.
- Each run on it holds it shared, from before its cache opens to its end, and the clean waits for those runs.
- That wait says `[vx] waiting for another vx process using the cache directory <dir> to finish…`.
- A run waits for the clean in turn: `[vx] waiting for a vx cache clean of <dir> to finish…` ([caching](./caching.md#concurrent-runs)).

</div>
</details>

### Which cache

`vx cache clean` cleans the folder a run would use: it finds the workspace root from the current folder and reads `defineWorkspace({ cache: { dir } })`.

```sh
vx cache clean --older-than 7d --cache-dir /tmp/vx-cache
```

`--cache-dir <path>` names another folder, relative to the current one as on `vx run`, so a run that wrote elsewhere can be cleaned there.

### Other subcommands

`clean` is the only `vx cache` subcommand. The cache's folder, entry count and size are in [`vx info`](#vx-info).

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `vx cache stats`, `list`, `ls`, `gc` and their neighbours point you to `vx info` rather than print a bare "unknown subcommand".
- `vx cache list` also names `vx last --list`.
- `clear`, `purge`, `reset` and `wipe` name a bare `vx cache clean`.
- `vx cache --older-than 30d`, a clean flag typed without the verb, names the whole command it makes: `vx cache clean --older-than 30d`.

</div>
</details>

### With no bound: clear the cache

`vx cache clean` with neither `--older-than` nor `--max-size` clears the whole cache, including run history, so `vx last` and `vx why` start over. The next run misses every task once and saves again.

```sh
vx cache clean
```

```ansi
[38;2;34;197;94m✓[0m [1mvx cache clean[0m  [38;2;203;213;225mfreed 472 KB[0m

  [38;2;203;213;225m.vx/cache[0m
  [38;2;203;213;225m/home/me/.vx/157e2c42758e0d27/cache[0m

  [38;2;203;213;225mrun history cleared too: vx last and vx why start over[0m
```

With `--format json` it prints `{ dry, cleared, bytesFreed }` (`schemas/cache.json`), `cleared` listing the directories.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

**What goes**

- The cache folder: `.vx/cache`, or `cache.dir` / `--cache-dir`. It holds the index and this workspace's run history.
- The store a run opens, where the entries live: `~/.vx/<id>/cache`, shared by this workspace's checkouts, so their entries go too.
- The store the index last named, if another one (after a changed HOME, or an origin added).
- `--global` also clears every other workspace's store: each `~/.vx/*/cache` holding a `store.db`. Any other folder there stays.
- `--global` takes no bound and no `--cache-dir`.

**What stays**

- `.vx/workspace.ts`, the lock and `.vx/.gitignore` sit outside those folders and stay.
- A `cache.dir` that holds them (`.vx`, the workspace root) is refused.
- A `cache.dir` you named may be shared (`build/`, `~/.cache`). There only what vx wrote goes: the index, its artifacts, run history, its `*` `.gitignore`.
- Your own files stay there, and the folder goes only if that empties it.
- A folder with no `cache.db` is not a vx cache and is left alone.

**Which store may go**

- The store an index names goes only if it is one (`.vx/<id>/cache` holding a `store.db`) and is this workspace's.
- This workspace's means its `<id>` is the workspace's, or the one it had before an origin was added.
- The index is a file in the checkout: a commit, a copy or a restored CI cache could point it at any folder or another workspace's store.

**Checks before deleting**

- Every target is checked before the first delete.
- A store this user cannot remove (another user's, after one `sudo vx run`) stays, as runs leave it for `.vx/cache`.
- stderr then says `cache store <dir> left as is: this user cannot remove it (EACCES)`.
- A cache folder it cannot remove refuses the clear, exit 1, with nothing deleted.
- A workspace that never ran says `› vx cache clean  nothing to free`.

**Links**

- A `.vx/cache` linked to another folder (a CI cache volume) is cleared through the link, of what vx wrote there (the files above and `compiled/`).
- The link itself stays.
- A cache folder that resolves through links to the home folder, `/`, or a folder holding the workspace or a `.git` is refused, naming the resolved path.
- Every run refuses it too.
- An index SQLite cannot read is cleared like any other.

**Waiting**

- It waits for a `vx run` on this workspace to finish first (the run's lock), as a trim does.
- It waits for every vx process holding open a store it deletes: a run in another checkout of the workspace.
- It waits for every run of another workspace on a cache folder with no store it deletes.
- A run in another checkout that starts meanwhile waits for it (`[vx] waiting for a vx cache clean of <dir> to finish…`), then makes a new store.

</div>
</details>

### Exit codes

| Code | When                                                                                                                                                                                                                        |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | pruning completed (zero or more entries evicted). A workspace that never ran has no cache, nor does a directory holding nothing vx wrote (`--cache-dir build`): `› vx cache clean  nothing to free`, and nothing is created |
| `1`  | parse error, a bound that evicts everything (`--max-size 0`, `--older-than 0d`), or workspace-discovery error                                                                                                               |

## Runs read the lock

Every run reads its projects and their configs only from the committed `.vx/projects.lock`. After you add or edit a config, run `vx lock`.

```sh
vx lock
```

That holds for `vx run`, every `vx watch` cycle, `--affected` selection and the picker. With no lock, a run fails with `` no lock: run `vx lock` ``.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

**What a run never does**

- It never walks for configs. An `--all` run asks git for the names alone, to refuse one the lock lacks.
- It never evaluates a config, never checks the graph rules (`run.rules`) and never writes the lock. Only `vx lock` does.

**The local reminder**

- A config file edited since this machine's last `vx lock` (or a passing `vx lock --check`) refuses the run, `VX_E_LOCK`.
- The message: `` <file> changed since the last `vx lock` — run `vx lock` ``.
- It compares the file's size, mtime and bytes with those `vx lock` read, kept in the cache folder's `config-stamps.json`.
- It checks only while the lock is the one written then. So a pull that brings a new lock, or a fresh clone, is never refused.
- A config edit committed without relocking is refused like an uncommitted one.
- A file a config imports is not checked.
- A file a `project` plugin made a config from is checked the same way: `turbo.json` or a `package.json` script under `turbo()`, `project.json` or an inferred target's `vite.config.ts` under `nx()`.
- A named file that appears or goes counts as an edit. The plugin names it (`ProjectHookContext.read`).
- In a pipeline, `vx lock --check` first re-evaluates every config and checks the rules.

</div>
</details>

## `vx lock`

`vx lock` runs every `vx.config.*` once and saves the result in
`.vx/projects.lock`. Runs read that lock, never your configs.

After you edit a config, run `vx lock` and commit the lock.

It also writes `.vx/dependencies.lock`: which project depends on which,
and a digest of each project's installed dependencies. Commit it too, and
never edit it.

After an install, run `vx lock` again. A run refuses a dependencies lock
that no longer matches the lockfile.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `.vx/dependencies.lock` holds each project's edges, which live nowhere
  else. Only `vx lock` writes it.
- It also holds each claimed lockfile's per-project digests
  (`FingerprintClaim.digests`), with the hash of each other file they read
  (a `bun.lock` patch).
- Layout: an empty line, a name line and a fields line per project, keyed
  by its name, so git merges edits to different projects and a project
  added or removed beside one.
- A run keys each task from those digests, after checking them against
  the plugin's digests of the lockfile as it is now.
- `cache.db` keeps the plugin's digests by the lockfile's hash: one parse
  per lockfile change on a machine, none after.
- Recorded digests that are not what the lockfile resolves to: the run
  refuses with `VX_E_LOCK`. `--affected` refuses too.
- No dependencies lock while a plugin claims a lockfile that is there:
  the run refuses.
- An install that moves no project's digest (a package that is no project
  yet) keys nothing, so it refuses nothing.
- An edit in a `link:` or `file:` directory the lockfile names needs no
  `vx lock`: the plugin digests it anew, and `vx lock --check` accepts it.
- A digest that moved while the lockfile and those files did not (a
  plugin upgrade) fails `vx lock --check` and refuses a run.
- `--affected` reads the base commit's copy to find a deleted project's
  dependants and the edges that moved.
- `vx lock --check` fails when the dependencies lock is missing or stale.
- A run started while `vx lock` replaces the two locks waits for both, so
  it never reads one new lock beside one old one.

</div>
</details>

### Usage

```sh
vx lock              # Evaluate all vx.config.* now; write .vx/projects.lock and .vx/dependencies.lock.
vx lock --check      # Audit: full re-evaluation vs the lock. Exit 1 on drift.
vx lock --check --format json   # The audit as {upToDate, audited, notAudited, problems}.
```

### Example

```sh
vx lock
```

```ansi
[38;2;34;197;94m✓[0m [1mvx lock[0m  [38;2;203;213;225m2 project configs → .vx/projects.lock, .vx/dependencies.lock[0m
```

```sh
vx lock --check
```

```ansi
[38;2;34;197;94m✓[0m [1mvx lock --check[0m  [38;2;203;213;225mup to date (2 projects)[0m
```

After an edit the lock has not seen:

```sh
vx lock --check
```

```ansi
[38;2;239;68;68m✗[0m [1mvx lock --check[0m  [38;2;203;213;225mpackages/ui/vx.config.ts evaluates differently from the lock here — its config, a file it imports, or the environment it reads changed; run 'vx lock'[0m

  [38;2;203;213;225mtasks.lint.exec.command: "oxlint src" → "oxlint --deny-warnings src"[0m
```

Under the line, `--check` shows up to three places where the evaluated
config differs. That helps when a config reads the environment and no
file diff shows the change.

### When to run it

Run `vx lock` and commit `.vx/projects.lock` after you:

- edit any `vx.config.*` or `.vx/workspace.*`
- update dependencies or plugins
- change a file a config imports

Until then, runs keep the old configs. A run refuses a config file edited
since this machine's last `vx lock`.

On CI, run `vx lock --check` first: it fails a stale lock. The full
workflow is in the site's CI guide and `examples/ci`.

### Options

| Option          | Meaning                                                            |
| --------------- | ------------------------------------------------------------------ |
| `--check`       | re-evaluate every config and compare with the lock; writes nothing |
| `--format json` | with `--check`, the audit as one document                          |

### What it writes

`vx lock` finds every project and saves each one's **resolved** config,
after plugins ran, in `.vx/projects.lock` at the workspace root.

A project is a directory holding a `vx.config.*`, such as
`packages/ui/vx.config.ts`.

For review, it also writes each project's resolved config, pretty, to
`vx.lock.json` beside its `vx.config`. vx never reads that copy.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

**Finding projects**

- A config in any language counts: `vx.config.ts`, `.mjs`, and the rest.
- Inside git, `vx lock` lists configs with `git ls-files`: tracked and
  untracked, git's ignore rules applied. A nested repository's configs too.
- Outside git, it walks the tree: every directory but `.git` and `.vx`.
- A config under a nested `.vx/workspace.*` is left out, even one the
  ignore rules hide.
- A config under `node_modules` is left out, ignored or not: an installed
  package is no project.
- A config under a `.vx` is left out: that is vx's own state, in git or not.
- Each nested workspace root is recorded too (`nestedWorkspaces`). An
  outer project's outputs stop there, as at a nested project.
- So a run's clean, save and restore never reach a nested workspace. Its
  inputs still key its files.
- `--check` fails a lock that misses a nested workspace.

**Evaluating and naming**

- Configs are programs. `vx lock` runs them in the current environment
  and stores the post-evaluation objects, each project keyed by its
  name (version 10; an older vx's lock is refused: re-run `vx lock`).
- A project's name: its config's `name`, else a plugin's `discover`
  stage, else its root-relative path (`//` for the root).
- `@vzn/vx-lockfile`'s `discover` stage gives `package.json`'s `name`.
- Two projects of one name are refused, naming both directories. Every
  such clash is named at once.
- The plugin `discover` stage runs here and nowhere else, and may add
  directories.
- A plugin-added directory whose config git ignores is refused, by
  `vx lock` and `--check`, naming the plugin and the file.
- The message:
  ``plugin 'vx-gen' adds project gen, but git ignores gen/vx.config.ts, so `vx lock` cannot read it — unignore it or delete it``
- A run naming that task says the same, never "run `vx lock`".

**Checks before writing**

- `vx lock` builds the graph of every task the workspace declares,
  `graph` stage included.
- It checks the graph rules (`run.rules`), which no run checks.
  `dependencies` (which projects a project may depend on) is one:
  `VX_E_DEPENDENCY_RULE`.
- `app/[id]/**` beside a real directory `app/[id]` is refused: brackets
  are a character class. Write `app/\[id\]/**`.
- A broken rule prints `✗ vx lock  lock not written` with the rule's
  refusal under it, and writes nothing.
- One run names every refusal: every config that does not load, and
  every task whose `dependsOn` is broken or loops (a cycle once).
- A lock or review copy that is a symlink is refused before anything is
  written.
- So is one whose directory resolves outside the workspace (a `.vx`
  linked out of it).

**Notes after writing**

- After writing, it notes what a task reads that its key never sees, and
  still exits 0.
- `.env*` over a gitignored `.env.production.local`: Vite loads that file
  for a production build, and the key never sees it.
- vx asks git about ignored files in one `check-ignore`. A run says it
  only on a miss, which a stale hit never brings.
- `VITE_API_URL` in a cached task's `exec.env.passThrough` but not in
  `inputs.env`: a bundler inlines it (schema.md § `ExecEnv`).
- A bundler finding is one line naming every task it holds for:
  `ui#build, web#build and 76 more tasks: …`.

**The file's layout**

- It is laid out for the parse first, then for size, then for merges.
- First, a header line: `{"version":10}`.
- Then each project, in name-hash order:
  `<name>⇥{"path","file"|"by","config"}`.
- `file` is left out for `vx.config.ts`, and the tasks are left out of
  `config`.
- Then, per task in name order, its pointer line (`#k2x0a1b`), its JSON
  line if no task above holds that pointer, and its `⇥<task>` line.
- A pointer is a hash of its task's JSON, so the same configs always lock
  to the same text.
- Each edit sits between two name lines, so two branches that edit
  different projects merge cleanly, as does an edit beside a project
  another branch added or removed.
- A merge that lost a pointer's entry is refused until `vx lock` rewrites
  the lock.
- `vx show` lists a project's tasks in name order.

**Review copies**

- `vx.lock.json` holds the project's resolved config, plugins applied. It
  is no task's input.
- `lock.reviewFiles: false` (or `VX_LOCK_REVIEW_FILES`) turns the copies
  off.
- A copy left with no config beside it is named by `vx lock` and fails
  `--check`.
- When the config was renamed to a name vx does not read
  (`vx.config.json`, `.tsx`), the notice names that file.
- The review copies are written before the lock. One that cannot be
  written (a directory in its place, a read-only file) is named, and the
  lock is left as it was.

**`.vx/.gitattributes`**

- `vx lock` writes `.vx/.gitattributes` when it is missing: both locks
  `linguist-generated eol=lf`.
- So GitHub collapses the locks in a diff, and a repository's `eol=crlf`
  or `core.autocrlf` leaves them LF.
- `vx init` writes it too. An existing one is never edited.

**Plugin stages**

- A plugin's `project` stage (`turbo()` and `nx()` from
  `@vzn/vx-migrate`, `@vzn/vx-lockfile`) runs here and nowhere else.
- The lock records each project's final config as the stage left it,
  never the steps. A project with no `vx.config.*` is included.
- A run reads that record and calls no hook, so a run never maps.
- So an edited `turbo.json` or `package.json` script runs only after the
  next `vx lock`. Until then a run on this machine refuses, naming the file.
- `--check` names a project the plugins now map otherwise, a plugin added
  or dropped since included:
  `packages/ui: the plugins map it differently from the lock here`.
- A run follows the record blindly, whatever plugins the workspace
  declares now.
- When a plugin fails before the stage ran (a `discover` refusal),
  `--check` names that failure alone: no config is compared with what
  the stage recorded.
- Both verbs name the projects with no config that the stage gives tasks,
  five names then `and N more`. Such a lock never reads like an audit of
  nothing:

```text
0 project configs → .vx/projects.lock, .vx/dependencies.lock (and the tasks a plugin maps for @demo/ui, @demo/web)
```

- A project with no task (core's default `build` aside) is not named.
- The `discover` stage is recorded too: each project's name and the
  plugin that added it in `.vx/projects.lock`.
- Every `deps` / `reach` edge goes in `.vx/dependencies.lock`, the only
  place edges live.
- A run, `vx show`, `vx why`, `--affected` and each `vx watch` cycle
  apply that record to the locked projects and call no `discover` hook.
- So an edge a plugin derives (a `package.json` dependency, an
  `implicitDependencies` or import under `nx()`) does nothing until the
  next `vx lock`.
- `--check` names a name or an added project that moved:
  `tools/gen: the lock names it "gen", the plugins here "generator"`.
- `--check` names edges that moved:
  `.vx/dependencies.lock is not what the dependencies resolve to here`.
- A record `vx lock` never writes (a dependencies lock of other projects,
  a recorded name another project has) is refused:
  ``.vx/projects.lock is invalid: … — run `vx lock` ``.

**Secrets**

- The lock is committed, so `vx lock` refuses to write a secret: a config
  that evaluated to the value of a secret-named variable.
- Say `` `--token ${process.env.API_TOKEN}` ``. A variable a task lists in
  `exec.env.secret` counts too.
- So does a secret-named `define` read from a variable of any name:
  `API_TOKEN: process.env.MY_CREDS` is named as `$MY_CREDS`.
- It names each place (`web: tasks.deploy.exec.command holds $API_TOKEN`)
  and writes nothing.
- Masking it instead would freeze a `***` that every run runs. Let the
  shell expand it: `$API_TOKEN` in the command, the name in
  `exec.env.passThrough`.
- A value the config's own text spells (the config or a local module it
  imports) is committed already, so it locks.
- Say `docker compose up -d postgres` beside
  `DATABASE_URL=postgres://postgres:postgres@…`.
- `vx lock --check` fails a lock that holds such a secret here, as
  `vx lock` refuses to write it.

**This checkout's path**

- `vx lock` warns of a config that evaluated to this checkout's absolute
  path: `` `bun ${import.meta.dir}/gen.ts` ``.
- Another checkout's `vx lock --check` fails on it, and its cache keys
  differ: `packages/ui: its config holds this checkout's path (…)`.
- Use a path relative to the project (the command's cwd), or
  `$VX_RUN_WORKSPACE` in the command.

**One at a time**

- One `vx lock` writes at a time on a workspace. A second waits:
  `[vx] waiting for another vx lock (pid N) on this workspace to finish…`.
- Then it evaluates and writes, so the review copies and the lock always
  come from one run.
- It does not wait for a `vx run`: a run keeps the lock it read at its
  start, so a task it starts later runs the config it was keyed on. The
  next run reads the new lock.

</div>
</details>

### Merging

The locks have no merge driver: git merges them as text, and most merges
of two branches go through.

When git leaves conflict markers, resolve the configs, then run
`vx lock`. It writes both locks anew.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- A name line seldom changes, so it sits between two branches' edits to
  neighbouring projects, and git merges both.
- Hashed project order keeps two new projects apart.
- After a merge, a run checks the merged digests against the merged
  lockfile. When they differ, it refuses with "run `vx lock`".
- When both sides changed one task, or lines right beside each other, git
  leaves conflict markers. Every run then refuses the lock with "run
  `vx lock`".
- A merge driver could not do this: git runs one before theirs' configs
  reach the disk, so `vx lock` there would lock our side.

</div>
</details>

### How runs read it

Every run reads its configs from the lock. It does not evaluate, audit
or validate them: `vx lock` validated them when it wrote them.

So a config that reads the environment keeps its lock-time values.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- A missing lock is a hard error.
- So is a locked directory whose config file is gone, or that this user
  may not search (named as `EACCES`).
- A config-less project (a `project` plugin's, such as `turbo()`'s)
  whose directory is gone fails its task with the same `vx lock` hint.
- vx asks that only once the task's spawn failed, so a run stats no
  project directory.
- A project a sparse checkout left out is refused only when the run
  selects it or depends on it.
- The refusal names every such project, and the one
  `git sparse-checkout add a b c` that brings them all back.
- The message lists the first five and counts the rest. The command
  lists all.
- `vx lock` and `vx lock --check` refuse there too, naming the same
  command: the lock they wrote would drop those projects.
- A config added since the lock is no project until `vx lock`. Naming
  its task says so:
  ``web#build: packages/web/vx.config.ts is not in the lock yet — run `vx lock` ``
- A run from its directory says `packages/web/vx.config.ts is not in the
lock yet`, where it ran the locked project around it.
- So do `--filter ./packages/web`, `--filter web`, `vx show web` and
  `vx show web#build`, `web` its directory or its `package.json` name.
- A project keeps its locked name until `vx lock`. Naming it by the name
  its `package.json` took since says so:
  ``web2#build: packages/web/package.json names it "web2", the lock "web" — run `vx lock` ``
- So do `--filter web2`, `vx show web2` and `vx show web2#build`. A
  project named by its path is never hinted this way.
- So does `--all`, for any config git lists (tracked or not) in a
  directory the lock holds no config for.
- `--all` leaves out ignored configs and ones under a nested workspace.
  It costs one `git ls-files`, which a filtered run does not pay.
- So does a bare `build` that the cwd's project or a `--filter` leaves
  unresolved, while a selected project holds such a config.
- An entry edited by hand into a shape `vx lock` could not write fails the
  run: ``.vx/projects.lock is invalid, run `vx lock` ``.
- That is checked only once something has crashed, so a normal run pays
  nothing for it.
- The shapes a run walks are checked as it reads the lock: a `name` that
  is no string, `tags` no list, `tasks` no object.
- So are a task that is no object, and its `dependsOn` no list:
  ``entry for "b" is malformed — re-run `vx lock` ``.
- Before that check, a string `dependsOn` was walked per character.

</div>
</details>

### `--check`

`vx lock --check` re-evaluates every config here and compares it with
the lock. It writes nothing, and exits 1 on any difference.

On CI: `vx lock --check && vx run …`.

With `--format json`, it prints the audit as one document. Here a
config edited after `vx lock` adds a `dependsOn` loop:

```json
{
  "upToDate": false,
  "audited": 4,
  "notAudited": 0,
  "problems": [
    {
      "code": "VX_E_LOCK",
      "message": "packages/api/vx.config.ts evaluates differently from the lock here — its config, a file it imports, or the environment it reads changed; run 'vx lock'\n  tasks.lint.dependsOn: (none) → [\"test\"]\n  tasks.test.dependsOn[1]: (none) → \"lint\""
    },
    {
      "code": "VX_E_CYCLE",
      "message": "dependsOn cycle: @demo/api#test -> @demo/api#lint -> @demo/api#test — remove one edge of the loop"
    }
  ]
}
```

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- It runs each config in the current environment and compares it with
  the frozen object (`Bun.deepEquals`).
- A project that differs gets one message, whether its config, a file it
  imports or the environment it reads changed.
- A lock an earlier vx wrote, or one that is not valid JSON, is a problem
  the audit names, asking for `vx lock`. It is not a refusal.
- Every config that does not load is named, as `vx lock` names them: each
  with its line and frame.
- It checks the graph rules over the configs as they evaluate now, naming
  each broken `dependsOn`.
- It checks that each `vx.lock.json` is what its project resolves to
  here, unless `lock.reviewFiles` is off.
- It fails a `vx.lock.json` left where a `vx.config` was deleted, whether
  the directory is still a project or not.
- Delete that copy yourself: vx never deletes a committed file. `vx lock`
  names it too, as a warning.
- A copy already gone from disk, that git still lists, is not named.
- `vx lock` and `--check` warn of a config file another one beside it
  hides: `vx.config.ts` and `vx.config.mjs` in one directory.
- Two `.vx/workspace.*` files count too. Precedence reads the first, so
  an edit to the other changes nothing.
- That warning does not fail `--check`.
- `--format json` answers `--check` only. Its schema is
  `schemas/lock.json`, and the exit code is unchanged.
- Under `--format json`, paths are root-relative.
- Each of its `problems` is `{code, message}`. Branch on the code; the
  message may change.
- `VX_E_LOCK`: drift `vx lock` fixes. A missing lock is one.
- `VX_E_CONFIG`: a config that does not load, or evaluates to a secret.
- `VX_E_REFUSED`: any other refusal that stops the audit: a plugin hook
  that failed, two projects of one name.
- `audited` counts every project with tasks, one a plugin maps
  included, so `notAudited` is always 0.
- A graph rule's own code (`VX_E_CYCLE`, …) for a broken graph rule.
- Full design: `docs/design/config-lock-2026-06.md`.
- A lock written by a 1.x vx stays valid for every later 1.x
  (`tests/contract-lockfile.test.ts`).

</div>
</details>

### Exit codes

| Code | When                                                                                               |
| ---- | -------------------------------------------------------------------------------------------------- |
| `0`  | lock written / lock is up to date                                                                  |
| `1`  | a config does not load, discovery fails, the lock is missing or drifted, or it would hold a secret |

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `--check` with no lock exits 1.
- On drift, every mismatched project is listed on stderr.
- A promise a config rejected that nothing awaited exits 1:
  `vx: unhandled rejection: …`. The lock is still written.
- A Ctrl-C (or SIGTERM, SIGHUP) ends it by that signal, also while a
  config is still loading. It leaves no temp file and writes no lock.

</div>
</details>

## Releasing (maintainers)

Releases are on demand. Dispatching `auto-release.yml` releases a commit
on `main` whose CI went green.

The workflow tags the commit with the next version, writes the release
notes from the Conventional Commits since the last tag, and dispatches
`npm.yml`, which publishes.

| Since the last tag (before 1.0) | Next version               |
| ------------------------------- | -------------------------- |
| a `feat` or a breaking change   | minor: `v0.4.2` → `v0.5.0` |
| anything else                   | patch: `v0.4.2` → `v0.4.3` |

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- The `sha` input picks the commit; by default, the newest green one. A
  commit CI did not pass on is refused.
- Claude dispatches it at least once a day when `main` has changes, after
  merging that release's blog post (`.claude/skills/release/SKILL.md`).
- Claude then shares the post on Bluesky.
- The tag and the GitHub release come from `scripts/release-notes.ts`,
  run by the `release.github.tag` task (`scripts/auto-release.ts`).
- The release is created as a draft: this repo's releases are immutable,
  and take assets only before they are published.
- `npm.yml` publishes the draft after its last upload.
- Below 0.1.0, every release is a patch. Cutting 0.1.0 is the owner's, by
  hand.
- A breaking change is `type!:` or a `BREAKING CHANGE:` footer. From 1.0
  a breaking change is a major.
- The notes: breaking changes first, then `feat`, `fix` and `perf`, the
  rest counted.
- A release made with the workflow token fires no `release` event in
  other workflows, so `npm.yml` is dispatched rather than triggered.
- A commit is released only when the last release is its ancestor, so an
  older tree never gets a higher version.
- A commit that already carries a `v*` tag is a no-op.
- To cut a version by hand: push its tag (say `v1.0.0`), create a draft
  release for it, and dispatch `npm.yml` on the tag.
- The next auto-release continues from a hand-cut version.

</div>
</details>

`npm.yml` is one job running `vx pipeline npm` over DTE workers
(`.vx/workspace.ts`). It publishes with **npm trusted publishing**: no
long-lived npm token exists anywhere.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- It compiles the four binaries once, the version defined into each
  (`src/version.ts`).
- It proves them: the darwin ones on a Mac worker, re-signed ad hoc only
  where macOS refuses one.
- It attests their build provenance and attaches them to the draft
  release. The darwin upload publishes it.
- It builds the fifteen npm packages: `@vzn/vx`, one per platform, and
  every other public package (the plugins, the servers,
  `@vzn/vx-devtools`).
- It publishes them with npm trusted publishing, then pushes the server
  images.
- A worker runs a task with its run's environment. So the OIDC token npm
  exchanges for a short-lived credential is `npm.yml`'s.
- The token the attestations are signed with is `npm.yml`'s too.
- Each step skips what is done (an attached asset, a package on the
  registry), so a re-run on the tag completes a release still in draft.

</div>
</details>

Every step of the two workflows past the setup (checkout, Bun,
`bun install`) is vx: CI runs no command of its own
(`tests/workflow-runner.unsafe.test.ts`).

The tasks are `@vzn/vx`'s `release.*`, all uncached; the `release`
pipeline runs the `release` group. A darwin task runs on a Mac, a linux
one on linux-x64:

| Task                         | Does                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `release.npm.<os>.check`     | checks npm can publish with provenance (>= 11.5.1, `sigstore` loads); else installs npm into `dist/npm-cli/`                                 |
| `release.npm.<os>.prove`     | launches the host's binary (re-signed only if macOS refuses it) and asserts `vx <version>`; on darwin, launches both (x64 under Rosetta)     |
| `release.npm.<os>.assemble`  | emits the platform packages under `dist/npm` (linux: also `@vzn/vx` and the plugins)                                                         |
| `release.npm.<os>.publish`   | `npm publish --provenance` each in order, skipping one the registry holds; `@vzn/vx` only once npm serves the darwin packages (up to 25 min) |
| `release.github.<os>.attest` | a Sigstore-signed build-provenance attestation of `dist/vx-<os>-*` (`scripts/release-attest.ts`), darwin's after its re-sign                 |
| `release.github.<os>.upload` | attaches `dist/vx-<os>-*` the draft release lacks; darwin's then publishes it                                                                |
| `release.npm.served`         | waits (up to 25 min) until npm's CDN answers 200 for every published tarball: it 404ed v0.0.646's for minutes, failing installs              |
| `release.docker`             | pushes the three server images to `ghcr.io/vznjs/<server>` at the version (amd64 + arm64); `latest` follows npm's                            |
| `release.github.tag`         | `auto-release.yml`'s: decides the version, creates the draft release with its notes, dispatches `npm.yml`                                    |

The version reaches them as `VX_RELEASE_VERSION` (the tag). Each task
refuses one that is not a version.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- Every task but `release.docker` (it drives Docker) is sandboxed.
- The publish is granted the registry, the OIDC token host and Sigstore,
  the GitHub Actions variables npm reads, and `~/.npm`.
- `release.github.tag` reads `.git` and reaches `api.github.com` with
  `GH_TOKEN`.
- `release.github.<os>.upload` reaches `api.github.com` and
  `uploads.github.com`.
- Every Linux job that runs a task itself runs `vx setup github`
  (`@vzn/vx-ci`) before its first `vx run`. A distributed run leaves that
  to its workers.
- A declared sandbox whose runtime is missing is a hard error, not a
  downgrade.
- So the compile tasks fail in 0 ms, saying which of bubblewrap, socat
  and ripgrep is absent.
- v0.0.20 shipped its darwin packages and then stopped exactly there.

</div>
</details>

One-time setup, per package, on npmjs.com → package → Settings →
Trusted Publisher → GitHub Actions: owner `vznjs`, repository `vx`,
workflow `npm.yml`, environment left blank. Do this for:

- `@vzn/vx`
- `@vzn/vx-darwin-x64`, `@vzn/vx-darwin-arm64`, `@vzn/vx-linux-x64`,
  `@vzn/vx-linux-arm64`
- the six plugins: `@vzn/vx-ci`, `@vzn/vx-lockfile`, `@vzn/vx-migrate`,
  `@vzn/vx-otel`, `@vzn/vx-reapi` and `@vzn/vx-history`

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- If npm will not add a trusted publisher to a name never published,
  publish that plugin once by hand from an owner's account, then add the
  publisher.
- Build it with `build-npm.ts <version> --only=plugins --out=dist/npm-plugins`,
  then run `npm publish dist/npm-plugins/plugins/<dir> --access public`.
- Then delete the `NPM_TOKEN` repository secret: the workflow no longer
  reads it.
- npm restricts classic tokens for direct publishing: the
  `E401 token is invalid` that stopped v0.0.17.
- Every `uses:` in both workflows is pinned to a commit SHA, with the
  version in a comment. Bump the SHA and the comment together.

</div>
</details>

Each platform package carries `LICENSE` and `THIRD_PARTY_NOTICES.txt`:
the binary embeds Bun and npm code whose licenses must travel with it.

The plugins ship as the TypeScript source Bun runs, at the release's
version, with `@vzn/vx` as a peer on the same minor (`^<version>`).

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- The GitHub release carries `THIRD_PARTY_NOTICES.txt` as an asset
  beside the binaries.
- `tests/dependency-licenses.unsafe.test.ts` holds every published
  package's production dependency closure to permissive licenses.
- Permissive means MIT, ISC, BSD, Apache-2.0, 0BSD, or a dual license
  offering one.
- After a dependency or Bun bump, run
  `bun packages/vx/scripts/third-party-notices.ts` to regenerate the
  notices.
- `tests/third-party-notices.unsafe.test.ts` fails until you do.
- `scripts/build-npm.ts --only=plugins` emits every public workspace
  package other than `@vzn/vx`.
- So a new plugin package is published without a workflow edit.
  `tests/build-npm.unsafe.test.ts` holds the set.

</div>
</details>

## The workspace root

Every verb works on one workspace. Its root is the directory holding the
nearest `.vx/workspace.ts`, from your working directory up.

```text
repo/.vx/workspace.ts    the root
repo/packages/ui/        you run vx here: the root is still repo/
```

With no `.vx/workspace.ts`, every verb but `vx init` stops with
`VX_E_NO_WORKSPACE`. `vx init` writes one.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `.mts`, `.js`, `.mjs`, `.cts` and `.cjs` count as well as `.ts`.
- vx never looks above the git top-level. Outside git, it looks up to
  `/`.
- A worktree is its own top-level, and so is a submodule's worktree.
- A submodule, its `.git` a file or a directory, looks on into its
  superproject.
- Nothing else marks the root: not a `package.json`, a
  `pnpm-workspace.yaml` or a lockfile.
- Any entry by one of the names marks the root. A broken link or a
  directory there, with no file beside it, is refused by name.
- The message: `<path>: is a broken link — fix or remove it`. It is not
  walked past, as `vx lock` counts it a nested workspace.
- A workspace file a sparse checkout left out (a cone checkout keeps the
  root's files, not its `.vx`) is refused as such.
- That refusal is `VX_E_NO_WORKSPACE` with the fix
  `git sparse-checkout add .vx`, from every verb.
- `vx init` refuses it too: a new file would replace the tracked one.
- Git is asked only once no file was found.
- Beside a `turbo.json`, an `nx.json`, an exported Nx graph or Lerna on
  Nx, `vx init` writes the workspace through `@vzn/vx-migrate`.
- A project inside the root is a directory holding a `vx.config.*`,
  which `vx lock` finds (see [`vx lock`](#vx-lock)).
- A `discover` plugin adds other projects.

</div>
</details>

## Which vx runs

A global vx hands every call to the project's own `@vzn/vx` when there
is one. So a project runs the version its lockfile pins. There is no
opt-out.

`vx --version` says when it was handed the call:

```text
vx 0.0.640 (/repo/node_modules/@vzn/vx-linux-x64/vx, handed off from /usr/local/bin/vx)
```

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- A global vx is one a package manager installed, or a compiled binary
  installed by hand.
- The project's vx is the workspace root's `node_modules/@vzn/vx`, run
  through its `node_modules/.bin/vx`.
- One hop: the receiving vx sees `VX_HANDED_OFF` and does not look again.
- A vx never hands off to itself (the same package, a pnpm symlink
  included).
- It never hands off to a `.bin/vx` another user owns: one planted above
  your checkout would run as you.
- An npm install's launcher does the walk in the shell, a test per level
  and no fork, and `exec`s the local vx.
- The compiled binary checks one path per level before it loads
  anything, then runs the local vx with its stdio.
- It passes on a signal sent to it alone, and exits with the local vx's
  code.
- From source (`bun src/bin.ts`), vx never hands off.
- `vx info` shows the file that ran and who handed off: `vxPath` and
  `handedOffFrom`.

</div>
</details>

## `vx upgrade`

`vx upgrade` moves vx to a newer release, the same way it was installed.

| Write               | Means                                   |
| ------------------- | --------------------------------------- |
| `vx upgrade`        | install the latest release              |
| `vx upgrade v0.4.0` | install that release; `0.4.0` works too |
| `vx upgrade -g`     | move only the global vx                 |

Default: the latest release.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- A second tag, or one that is no version, is refused first, not dropped.
- From source it refuses: use `git pull`.
- A global vx in a source checkout hands it to source, which refuses too.
  The refusal names `vx upgrade -g`, which moves that global.
- It is named `upgrade` per CLI convention, as `bun upgrade` and
  `deno upgrade` are.
- `latest` below the running vx is refused before anything runs, however
  vx was installed. The global a run moves counts too.
- That refusal says how to go back:
  `the registry's latest @vzn/vx is 0.3.0, below this vx's 0.4.0 — nothing replaced; to go back, ask for it: vx upgrade v0.3.0`
- A `TAG` that names an older release goes back.
- A `TAG` that names the running version says `already at` without
  asking the registry.

</div>
</details>

### Usage

```sh
vx upgrade [TAG] [-g|--global]
```

### Examples

In a project whose `package.json` lists `@vzn/vx`, beside a `bun.lock`:

```sh
vx upgrade
```

```ansi
[38;2;6;182;212m›[0m [1mvx upgrade[0m  [38;2;203;213;225m0.0.658 → 0.0.659[0m

  [1mbun add @vzn/vx@0.0.659[0m[2m in /work/repo[0m
```

From a global vx in that project, both move: the project's vx first, then the global binary.

### Options

| Option           | Meaning                                                     |
| ---------------- | ----------------------------------------------------------- |
| `TAG`            | the release to install, `v0.4.0` or `0.4.0`; default latest |
| `-g`, `--global` | move only the global vx, below                              |

### A binary installed by hand

A compiled binary you installed by hand replaces itself. It checks npm's
signature on the download before it writes anything.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- It reads its platform package (`@vzn/vx-<os>-<arch>`) from the npm
  registry.
- It checks npm's registry signature over
  `<name>@<version>:<integrity>` against npm's signing key, pinned in vx.
- The pinned key id: `SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U`.
- Then it checks the tarball's SHA-512 against that signed integrity.
- Only then does it extract `package/vx`, stage it in a fresh directory
  beside the binary, and rename it over.
- The host that serves the tarball cannot make that signature. So a
  swapped tarball, or a document with a swapped integrity, is refused.
- A bad signature:
  `the npm registry signature for … is not valid — refusing to install; nothing replaced`.
- A swapped tarball:
  `the download did not match the integrity npm signed … nothing replaced`.
- A key id vx does not pin:
  `… is signed with an npm key this vx does not know (…) — if npm rotated its signing key, this vx's installer needs updating`.
- A release with no signature or no integrity is refused before the
  download.
- So is a tarball URL that is not https:
  `the npm registry's tarball for … is not https (…)`.
- So is a signed release of another version than the `TAG` asked for:
  `the npm registry answered …@<TAG> with version …`.
- That check matters because npm signs its old releases too.
- `latest` below the running vx is refused here too (above).
- Every refusal comes before anything is written.
- There is no fallback to GitHub's release digest: when the registry is
  unreachable, the upgrade is refused.
- A binary whose directory this user cannot write (a root-owned
  `/usr/local/bin`) is refused before the download:

```text
cannot write to <dir> (EACCES), where this vx lives — nothing downloaded; re-run as a user who can (sudo vx upgrade), …
```

- The new binary keeps the old one's mode, and, as root, its owner.
- It must answer `--version` before the upgrade reports it installed.
- One that does not start on this machine, or does not answer within
  10 s, is swapped back for the previous vx. The command exits 1:

```text
the new binary did not start on this machine (… --version failed) — the previous vx is back in place
```

- Once it answers: `✓ vx upgrade  installed 0.0.2`.
- On the version it already is, it says
  `› vx upgrade  already at <version>` and downloads nothing.

</div>
</details>

### Which registry

`vx upgrade` and `vx init` read releases from the registry your package
manager uses. So a company that blocks registry.npmjs.org and serves a
mirror needs no extra setting.

The first that names one wins:

1. `@vzn:registry` in a `.npmrc`
2. `npm_config_registry` in the environment
3. `registry` in a `.npmrc`, the nearest from the working directory up,
   then the user's (`~/.npmrc`, or `npm_config_userconfig`)
4. bunfig.toml's `[install.scopes]` `vzn`, then `install.registry`, the
   nearest from the working directory up, then `~/.bunfig.toml`
5. registry.npmjs.org

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- The credential configured for that registry is sent to URLs under it
  only.
- In a `.npmrc`: `//<host>/<path>/:_authToken` or `:_auth`. In bunfig:
  `token`, or user and password. `${VAR}` is read from the environment.
- A mirror must pass on npm's signature: the check above does not change.
- A host it cannot reach (no route, a proxy that is down) is one line,
  never a stack:
  `could not reach registry.npmjs.org to read the release (…) — check the network or the proxy and re-run`
- So is a registry that takes the connection and sends nothing for 30 s
  (`no answer in 30 s`), before its headers or between two chunks.
- A slow download that keeps moving is never cut.
- So is a document cut after the headers, or not JSON (a captive
  portal's page served with a 200), and a tarball cut the same way.

</div>
</details>

### A package manager's install

A vx a package manager installed is upgraded by that package manager.
vx never renames over its file: the next install would undo it.

The path names the install:

| Install                | Detected by                                            | Runs                                           |
| ---------------------- | ------------------------------------------------------ | ---------------------------------------------- |
| npm global             | `<prefix>/lib/node_modules`                            | `npm install -g --prefix <prefix> @vzn/vx@<v>` |
| pnpm global            | `…/pnpm/global/…`, `$PNPM_HOME/global/<n>`             | `pnpm add -g @vzn/vx@<v>`                      |
| bun global             | `~/.bun/install/global`, `$BUN_INSTALL/install/global` | `bun add -g @vzn/vx@<v>`                       |
| yarn global            | `…/yarn/global/…`                                      | `yarn global add @vzn/vx@<v>`                  |
| a project's dependency | the package.json that lists `@vzn/vx`                  | its manager's add, same field                  |

vx prints what it runs, runs it there, and exits with an error if it
fails. Plugins move with core:

```sh
pnpm add @vzn/vx@0.0.2 @vzn/vx-otel@0.0.2 --save-dev
```

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- The npm package's launcher runs
  `…/node_modules/@vzn/vx-<os>-<arch>/vx`. That path names the install.
- A project's package.json is the tree's root. For a hoisted workspace,
  it is the nearest one above the current directory that lists `@vzn/vx`.
- Its manager is its lockfile (`pnpm-lock.yaml`, `bun.lock`,
  `yarn.lock`, `package-lock.json`), else `packageManager`.
- Else pnpm beside a `pnpm-workspace.yaml` (a workspace not installed
  yet), else npm.
- The field it is listed in is kept (`--save-dev`, `--dev`, …).
- pnpm at a workspace root adds `--workspace-root`. Yarn 1 there adds
  `-W`.
- The lockfile is updated by that manager.
- Every `@vzn/vx-*` plugin the same package.json lists from the registry
  moves in the same install, to the same release.
- That is because every @vzn package releases together.
- A plugin left behind is installed even when core is already at the
  release: `› vx upgrade  plugins → 0.0.2`.
- A plugin in another field than core is refused, so no install moves a
  dependency's field.
- The versions are pinned, so pnpm's `minimumReleaseAge` refuses a
  release too young rather than mixing releases.
- That error names `minimumReleaseAgeExclude`.
- Under pnpm, a plain `pnpm install` follows. pnpm's `add` can leave a
  peer set linked that the lockfile it wrote no longer names.
- The lockfile plugin refuses such a tree.

</div>
</details>

### A project's vx and the global one

Inside a project with its own vx, a global `vx upgrade` moves both to
the same version: the project's dependency first, then the global vx.

`vx upgrade -g` (`--global`) moves only the global vx.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- The global vx hands `vx upgrade` to the project's (§ Which vx runs).
  One run moves both to `TAG`, or latest.
- Each moves the way it was installed, and each line names its install.
- A refusal names the one that failed:
  `vx upgrade: global vx /usr/local/bin/vx: cannot write to …`.
- A project that fails leaves the global as it was.
- The project's vx run directly (a package script,
  `node_modules/.bin/vx`) has no global behind it, so only the project
  moves.
- `-g` works wherever it runs. It never hands the call to a project's vx,
  and never touches a `package.json` or a plugin.
- Run as the project's own vx, `-g` refuses:

```text
vx upgrade -g: no global vx ran — <path> is the project's own. Install one (bun add -g @vzn/vx), or run `vx upgrade` to move the project's
```

</div>
</details>

### After the upgrade

After an upgrade that installed something inside a workspace, the new vx
runs `vx lock` at the workspace root. A release may record the lock
differently.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- For an npm global install, the new vx is its own binary, which keeps
  its path.
- It locks also when the project's vx moved and the global's then failed.
- A lock that fails, or a new vx that does not start, leaves the upgrade
  done and prints `vx upgrade  vx lock failed: run vx lock`.
- `vx upgrade -g` never locks.
- vx never installs Node or a package manager. One not on `PATH` is
  refused with the command to run.
- A vx run from a `bunx` or `pnpm dlx` cache has nothing installed to
  upgrade. It says to ask for `@vzn/vx@latest` instead.

</div>
</details>

### Exit codes

| Code | When                                                                                                                                                                                                                                          |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | installed, or already at that version                                                                                                                                                                                                         |
| `1`  | anything refused or swapped back: from source, a cache install, a host it cannot reach, a directory it cannot write, a signature or integrity that does not verify, a binary that does not start, a package manager that failed or is missing |

## `vx init`

`vx init` sets up vx in a repository. It installs `@vzn/vx`, writes
`.vx/workspace.ts` and a root `vx.config.ts`, and writes the lock.

In a Turborepo or Nx repo, it maps their config instead.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- It never writes through a link: a file that is a symlink is refused
  before the first write, with nothing written.
- So is a file whose directory resolves outside the workspace (a cloned
  `.vx -> ../x`).
- The message:
  `refusing to write <file>: <dir> resolves to <real>, outside the workspace; remove the link and run again`.
- A root `package.json` that does not parse is refused, by file, line
  and column, before anything is written.
- A `note` row names each `tsconfig*.json` beside a written
  `vx.config.ts` that would compile it (no `include`, an `outDir`).
- The build's output would move. That covers an Nx library's
  `tsconfig.lib.json` beside a solution `tsconfig.json`.
- Options are read through `extends`.
- The fix: add the file to that tsconfig's `exclude`, or pass `--mjs`.

</div>
</details>

### Usage

```sh
vx init [--dry [--format pretty|json]] [--force] [--mjs] [--native|--keep] [--plugin <hook>]
```

### Example

```sh
vx init --dry
```

```ansi
  [2mfrom    [0m  [38;2;203;213;225mno turbo.json or nx.json[0m
  [2mdry run [0m  [38;2;203;213;225mnothing written[0m
  [2mfiles   [0m  [38;2;203;213;225m.vx/workspace.ts[0m
            [38;2;203;213;225mvx.config.ts[0m
            [38;2;203;213;225m.vx/.gitignore[0m
            [38;2;203;213;225m.vx/.gitattributes[0m
  [2mlock    [0m  [38;2;203;213;225m.vx/projects.lock[0m
            [38;2;203;213;225m.vx/dependencies.lock[0m
            [38;2;203;213;225mvx.lock.json beside each vx.config[0m

  [2mnext    [0m  [1mdeclare a task in vx.config.ts, then vx lock && vx run <task>[0m
```

### Options

| Option               | Meaning                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `--dry`              | print the files, and the lock's; write nothing                            |
| `--format json`      | with `--dry`, the plan as one document                                    |
| `--force`            | replace a file already there                                              |
| `--mjs`              | write `.mjs` files instead of `.ts`                                       |
| `--native`, `--keep` | in a Turbo or Nx repo: a `vx.config.ts` per package, or keep their config |
| `--plugin <hook>`    | write a plugin for that hook instead, below                               |

### Install

`vx init` first installs `@vzn/vx`: globally, and as a root
devDependency with your repo's own package manager.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- The global install uses the package manager that ran init, else Bun.
  Under Yarn 2+, which has no `yarn global`, it uses Bun too.
- The global install is skipped when the `vx` on `PATH` is already that
  version.
- The devDependency goes under the topmost `package.json`.
- Under pnpm, a plain `pnpm install` follows, as `vx upgrade` does.
- The latest version is read from the registry that manager is
  configured for ([Which registry](#which-registry)).
- A failed install stops init.
- Before the first install there is no lockfile, so init declares the
  `@vzn/vx-lockfile` plugin of the manager it installs with.

</div>
</details>

### In a Turborepo or Nx repo

Beside a `turbo.json` or `nx.json`, `vx init` runs `@vzn/vx-migrate`, so
one command is enough.

vx-migrate writes one `vx.config.ts` per package and the workspace file
with the plugins the repo needs. It installs them and ends with
`vx lock`.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- It looks in the directory it runs in and each one above, up to the git
  top-level. Outside git, up to the `package.json` root below.
- It looks for a `turbo.json`, `turbo.jsonc` or `nx.json`, or an
  exported Nx graph (`.nx/workspace-data/project-graph.json`).
- It also takes a `lerna.json` whose root script runs `lerna run`
  through Nx (`useNx`, else Lerna 6+), as vx-migrate detects them.
- It runs vx-migrate's latest release through `bun x`, never an
  installed one. `BUN_BE_BUN=1` makes the compiled binary that runtime.
- So init always installs the latest `@vzn/vx`, or the running vx when
  the registry's latest is older.
- It moves every `@vzn/vx-*` plugin the root lists to that release.
- A source checkout runs the nearest installed
  `node_modules/@vzn/vx-migrate` instead.
- `--dry`, `--format`, `--force`, `--mjs`, `--native` and `--keep` pass
  through, and the exit is vx-migrate's.
- The plugins it declares: the lockfile's, and a remote cache the repo
  shows.
- Its README holds the rules; [`bunx @vzn/vx-migrate`](#bunx-vznvx-migrate)
  below sums them up.

</div>
</details>

### In any other repo

With none of those files, it writes a workspace whose one project is the
root:

```ts
// .vx/workspace.ts
import type { WorkspaceConfig } from '@vzn/vx/config'

export default { plugins: [] } satisfies WorkspaceConfig
```

```ts
// vx.config.ts
import type { ProjectConfig } from '@vzn/vx/config'

export default { tasks: {} } satisfies ProjectConfig
```

It also writes `.vx/.gitignore` and `.vx/.gitattributes` and runs
`vx lock`'s step. Then `next:` says to declare a task and run
`vx lock && vx run <task>`.

Beside a lockfile (`pnpm-lock.yaml`, `bun.lock`, `yarn.lock`,
`package-lock.json`), the workspace declares its `@vzn/vx-lockfile`
plugin, say `plugins: [bun()]`. So a package's `^build` has project
edges.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

**Where it writes**

- At the nearest workspace root up from the working directory, else at
  the topmost `package.json` in the git work tree, else right there.
- Outside git: the nearest `package.json`, or an outer one that declares
  a workspace, never a stray one above.
- The report names the root under `root` when it is not the working
  directory.
- The lockfile plugin needs the lockfile at that `package.json`. It is
  installed beside `@vzn/vx`.

**Other tools' files**

- Where the root package.json declares prettier or oxfmt (not merely
  hoisted), or a `.prettierignore` exists, it adds the locks and
  `.vx/cache` to `.prettierignore`.
- Both tools read only the root's ignore files, and
  `prettier --check .` failed on the locks.
- Beside a `biome.json(c)`, it names the `files.includes` lines biome
  needs.
- Where a package's tsconfig would compile the config it wrote and lists
  an `exclude`, the config joins that list. With none, a note says to add
  one.
- Beside a `.moon/workspace.yml`, a note says moon's tasks are not
  migrated: vx reads no moon config.

**What it prints next**

- Outside a git work tree, `next:` starts with `git init`.
- Where a kept `vx.config` already declares tasks (a re-run), `next:` names one to run, such as `vx run hi`.
- Where that `package.json` has scripts, or declares a workspace
  (`workspaces`, `pnpm-workspace.yaml`), `next:` first names
  `bunx @vzn/vx-migrate`.
- That makes each package's scripts its tasks. It maps over the root
  `vx.config.ts` init wrote, while that file is unchanged.
- The `@vzn/vx` import needs no install: the running vx serves its own
  core to that specifier (bin.ts registers the alias).

**Files already there, and flags**

- A file already there is kept and named under `kept`.
- A kept workspace file that declares no `@vzn/vx-lockfile` plugin, where a fresh one would, gets a `note` naming the plugin to add.
- `--force` replaces it, and every file of another extension beside it,
  all named under `replaced`.
- The JSON's `replaced` lists only the files deleted.
- `--mjs` writes `.vx/workspace.mjs` and `vx.config.mjs`.
- `--dry` prints the files and writes nothing.
- `--dry --format json` prints the plan as one JSON document
  (`schemas/init.json`).
- Its keys: `files` (each path and its whole text), `kept`, `replaced`,
  `todos`, `notes`, `next` and `installs`.
- `installs` holds the install commands the real run runs.
- `--native` and `--keep` answer a Turbo or Nx repo's question, so they
  are refused here.
- `--format json` without `--dry`, or with `--plugin`, is refused
  (`VX_E_USAGE`).

</div>
</details>

### `--plugin`

`vx init --plugin <hook>` writes a small runnable plugin for that hook,
and a test that drives it.

```sh
vx init --plugin executor   # writes plugins/executor.ts and plugins/executor.test.ts
```

The hooks: `executor`, `cache`, `telemetry`, `schedule`, `admit`,
`commands`, `project`, `graph`, `key`. It prints the line that declares
the plugin in your workspace file.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- The test drives the plugin through `run()`: `bun test`, with `@vzn/vx`
  installed.
- A plugin is named by the nearest `package.json`.
- When that one has no name (a monorepo root often has none), it also
  writes `plugins/package.json`, naming the plugins `workspace-plugins`.
- Without that name, `definePlugin` would refuse them.
- The printed line goes in the workspace file a run reads:
  `.vx/workspace.ts` when there is none.
- The templates are TypeScript, so `--mjs` with `--plugin` is refused.
  So is a second hook.
- An existing file is refused without `--force`, a dangling symlink
  included.
- A symlink is refused with `--force` too, since vx never writes through
  one.
- So is a `plugins` directory that resolves outside the workspace.
- `--dry` names the files and writes nothing.
- The two files are `private/vx-plugin-examples/plugins`, which the gate
  runs, copied into core (`src/cli/plugin-templates.ts`).
- `tests/plugin-templates.unsafe.test.ts` holds the copies equal.

</div>
</details>

### Exit codes

| Code | When                                                                                                                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | the files written (or, with `--dry`, printed)                                                                                                                                                                                                     |
| `1`  | a refused flag, a parse error (`--mjs` with `--plugin` among them), a plugin file already there without `--force` (a symlink with it), or the lock not written (the files stay). Handed to `@vzn/vx-migrate`, the exit is its own, by these rules |

## `bunx @vzn/vx-migrate`

`@vzn/vx-migrate` turns a repo's own config into vx configs. It is its
own package, and it writes the workspace file, so you run it before one
exists.

`vx init` runs it for you in a repo with a `turbo.json`, `turbo.jsonc`,
`nx.json`, an exported Nx graph or Lerna on Nx.

```sh
bunx @vzn/vx-migrate           # turbo.json, an Nx graph, vite-plus run.tasks, else package.json scripts → vx.config.ts (vx init hands it only Turbo and Nx)
bunx @vzn/vx-migrate --dry     # print the generated files instead of writing
bunx @vzn/vx-migrate --force   # overwrite existing vx.config.*
bunx @vzn/vx-migrate --from nx # disambiguate when several sources are checked in (turbo, nx, vite-task, scripts)
```

In a Turborepo or Nx repo, it asks you to pick:

| Answer           | Writes                                                                            |
| ---------------- | --------------------------------------------------------------------------------- |
| native (default) | a `vx.config.ts` per package                                                      |
| keep             | a workspace file declaring `turbo()` or `nx()`, which read the repo's config live |

`--native` or `--keep` answers it. Without a terminal, it is native.

In any other repo, each package's `package.json` scripts become its
tasks.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- Both answers declare `turboCache()` / `nxCache()` when the repo shows
  a remote cache.
- The signs: turbo.json's `remoteCache`, a `turbo link`ed
  `.turbo/config.json`, or a CI file setting `TURBO_TOKEN` /
  `NX_SELF_HOSTED_REMOTE_CACHE_SERVER`.
- It names Nx Cloud, whose wire vx does not speak.
- From scripts, the workspace file declares the `@vzn/vx-lockfile`
  plugin for the root's lockfile; with none yet, the one its install
  writes.
- What it writes goes through core's migration seam (`applyMigration`,
  exported from `@vzn/vx`). The seam renders, guards against
  overwriting, writes and reports.
- The mapping rules live in the package's README.

</div>
</details>

## Machine-readable output

These take `--format json` and print one JSON document on one line:

| Command                             | Schema               |
| ----------------------------------- | -------------------- |
| `vx show`                           | `schemas/show.json`  |
| `vx info`                           | `schemas/info.json`  |
| `vx why`                            | `schemas/why.json`   |
| `vx last`                           | `schemas/last.json`  |
| `vx cache clean`                    | `schemas/cache.json` |
| `vx lock --check`                   | `schemas/lock.json`  |
| `vx run --dry`, `vx pipeline --dry` | `schemas/plan.json`  |
| `vx init --dry`                     | `schemas/init.json`  |
| `vx docs`                           | `schemas/docs.json`  |
| any of them, refused                | `schemas/error.json` |

Each schema ships with the package. Every field in it has a `type` and a
`description` that says what it holds.

A run's result as JSON is `vx last --format json`, read from the run
history after the run: one row per task, with its status, key and cache
result.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- The schemas are JSON Schema draft 2020-12, in
  `node_modules/@vzn/vx/schemas/` in an install.
- Every object closes its key set, so a field vx adds is a schema
  change, never a surprise.
- `tests/cli-json-schemas.test.ts` holds each verb's output to its
  schema, each declared field to some output and to a description, and
  each object's keys to the source type.
- A renamed field fails those tests. Until 1.0 a rename ships with no
  alias; the release notes name it.
- `tests/cli-json-doc.test.ts` holds this page to the schemas: each
  `{ … }` a verb's section shows is an object its schema closes with
  those keys.
- Each object the verb prints whole is shown, and `vx info`'s field list
  is its schema's top level.

</div>
</details>

### Error codes

A verb asked for JSON answers a refusal on stdout too, as one line:
`{"ok":false,"error":{"code","message","docs"}}` (`schemas/error.json`).

Branch on the code; the message may change. `docs` links the code's
section below, which says what to do. `vx docs <code>` prints that
section.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- Asked for JSON means `--format json`, `--format=json` or
  `--dry --format json`, before any `--`.
- The exit code (1) and the prose on stderr do not change.
- A graph rule's code is `vx lock`'s refusal: `VX_E_CYCLE`,
  `VX_E_DEPENDS_ON`, `VX_E_OUTPUT_OVERLAP`, `VX_E_INPUT_IS_OUTPUT`.
- So are `VX_E_NESTED_INPUT`, `VX_E_NESTED_OUTPUT` and
  `VX_E_DEPENDENCY_RULE`.
- An agent reads a graph rule's code as the `code` of a
  `vx lock --check --format json` problem.
- Every code is recorded in `tests/contract/error-codes.txt`. Dropping
  or renaming one is a breaking change.

</div>
</details>

#### `VX_E_USAGE`

A flag, argument, selection or `VX_*` environment value the verb does
not take. The message names it, and a close spelling the verb does take
when there is one.

`vx <verb> --help` lists every flag.

#### `VX_E_UNKNOWN_COMMAND`

No verb of that name here, core's or a declared plugin's. `vx --help`
lists core's verbs.

A plugin's verb exists once its plugin is in `.vx/workspace.ts`
`plugins`. A task runs as `vx run <task>`.

#### `VX_E_UNKNOWN_TASK`

No project in scope declares a requested task. The message lists the
tasks it found; `vx show --format json` lists each project's.

Check the spelling, and the scope: `--filter`, `--all`, or the project
the working directory is in.

A run reads its configs from the lock, so a task added to a `vx.config`
since the last `vx lock` is not there yet: run `vx lock`.

`vx show <name>` answers it too when the name is neither a project nor a
task any project declares.

#### `VX_E_UNKNOWN_PROJECT`

`vx show <project>#<task>` names a project the workspace does not have.

A project is named by its config's `name`, else by a plugin (a lockfile
plugin names it from its `package.json`), else by its directory.
`vx show --format json` lists them.

#### `VX_E_NO_HISTORY`

`vx why` / `vx last` find no recorded run for what they were asked, or
`vx last --live` no run in progress. Run the task once
(`vx run <task>`); history is this checkout's own.

Where nothing has run yet and no project declares the task, `vx why`
says so and points at `vx show` instead.

#### `VX_E_AMBIGUOUS`

`vx why <task>` matches the task in several projects. Name one:
`vx why <project>#<task>`.

A run id that is the start of several recorded runs (`vx last <id>`,
`--run <id>`) is refused the same way: type more of it.

#### `VX_E_CONFIG`

A `vx.config.*` or `.vx/workspace.*` that does not load, throws or is
refused. Fix that field; `vx docs <field>` prints its reference.

The message names the file and the field, or what the config threw and
the line it threw at. That includes a plugin it called, such as a
factory refusing an option.

Then the message names each `cause` it wraps (`; caused by: …`).

`vx lock` names every project config that does not load at once. A
project config's refusal is `vx lock`'s, not a run's: a run never
evaluates one.

#### `VX_E_CYCLE`

The task graph has a cycle. The message names the loop; drop one of its
`dependsOn` edges.

`vx lock` refuses it, not a run: a run trusts the graph the lock holds.

#### `VX_E_LOCK`

A run reads its configs only from `.vx/projects.lock`, and that lock is
not one it can use. Run `vx lock`, then the verb again.

The lock may be missing, or not one this vx reads: not JSON, another
version, or a hand-edited entry.

It may hold no entry for a project the workspace has, not have seen a
`vx.config` written since, or lock one that is gone.

Or a plugin claims a lockfile (`bun()`, `pnpm()`, …) and
`.vx/dependencies.lock` is missing or not one this vx reads.

Or that lock does not record the lockfile, or records digests it no
longer resolves to: the lockfile changed since `vx lock` (an install).

Commit the lock. `vx lock --check` on CI fails one that no longer
matches the configs.

#### `VX_E_NO_WORKSPACE`

No `.vx/workspace.*` in the working directory or a parent, up to the git
top-level. A file above the checkout never counts.

The file marks the workspace root, so run `vx init` to create one.

Outside git, one another user owns does not count (`security.md`); the
message names it.

One a sparse checkout left out names `git sparse-checkout add .vx`
instead, and `vx init` refuses rather than write a second one.

#### `VX_E_CACHE_VERSION`

A reading verb met a cache index from another vx version. It reads
nothing from it and leaves it be; the next `vx run` resets it. Or run
the vx version that wrote it.

#### `VX_E_REFUSED`

Any other refusal (a plugin's, a check's) with no code of its own. The
message is that plugin's or check's: do what it says.
`vx info --format json` lists the plugins.

#### `VX_E_FS`

The file system refused a read or a write, or the cache index could not
be opened. The message names the path.

Causes: permissions, a full disk, a path longer than it allows
(`ENAMETOOLONG`, an output past PATH_MAX). Or a file where the cache
directory goes, or a directory where `cache.db` goes.

Free space (`vx cache clean --max-size <size>` trims the cache), grant
the access, shorten the path, or move it away. Then re-run.

#### `VX_E_FDS`

Out of file descriptors. Raise the limit (`ulimit -n 4096`), or run fewer
tasks at once (`--concurrency`), then re-run.

#### `VX_E_AFFECTED_BASE`

`--affected` (or `--affected=<ref>`) has no base to diff against. Pass a
branch or commit you have locally, alone: `--affected=origin/main`.

The ref does not resolve, is a range (`A..B`) or an exclusion (`^A`),
names a path inside a commit, or the repository has no history to
compare with.

A shallow clone fetches its base from origin itself. When origin cannot
give it, fetch it: `git fetch --depth=1 origin <base>`.

With no origin remote, fetch from its URL
(`git fetch --depth=1 <url> <base>`) or add one
(`git remote add origin <url>`).

#### `VX_E_NO_GIT`

vx needs git and found none: `git` is not on PATH, or the workspace is
not inside a git work tree. The message says which. Install git, or run
`git init` in the workspace root, then re-run.

#### `VX_E_GIT`

A git command vx runs to read the diff or list a run's inputs failed.
The message carries git's exit and its own words.

Run that command in the workspace to see why (a broken index, a missing
object in a partial clone).

#### `VX_E_NETWORK`

`vx docs` could not read its pages from GitHub: no network, a proxy that
refuses, or GitHub's limit on anonymous listings. The message carries
what failed.

Retry with a network, set `GITHUB_TOKEN` or `GH_TOKEN` to lift the
limit, or read the same pages on the site,
`https://vznjs.github.io/vx/`.

#### `VX_E_DEPENDS_ON`

A task's `dependsOn` names a task or project that is not declared, or
uses a form vx does not take: a bare wildcard, a negation, a pattern in
`pkg#task`.

The message names the task and the entry: declare the target, fix its
spelling, or drop the entry.

`vx lock` refuses it, not a run: a run trusts the graph the lock holds.

A `^task` with no edge source is refused too:

```text
<id>: ^build needs project edges; add pnpm()/bun()/npm()/yarn() from @vzn/vx-lockfile to plugins in .vx/workspace.ts and install so its lockfile exists, or a plugin that returns `deps`
```

- A lockfile plugin whose lockfile is absent gives no edges.
- Core reads no edge from a manifest. With no plugin returning `deps`,
  every `^` would resolve to nothing and fold no upstream into the key.
- Declare the lockfile plugin in `.vx/workspace.ts`, or a plugin of your
  own that returns `deps`.
- A run refuses it as well when the plugin left the workspace after the
  lock.

#### `VX_E_OUTPUT_OVERLAP`

Two tasks declare overlapping outputs with no `dependsOn` edge between
them, so whichever runs second deletes the other's files. Give each task
its own output path, or make one depend on the other.

`vx lock` refuses it, not a run: a run trusts the graph the lock holds.

#### `VX_E_INPUT_IS_OUTPUT`

A task's `inputs` match outputs, its own or another task's. Exclude the
outputs from the inputs with a `!` glob, as the message shows.

Or declare no outputs for a task that rewrites files in place.

- Its own outputs: vx cleans outputs before a run, so it would delete
  its sources.
- `files` and `workspaceFiles` are compared across, read from the root.
- Another task's outputs: its key must not read them, and `dependsOn`
  already cascades.
- `vx lock` refuses it, not a run: a run trusts the graph the lock
  holds.
- A run refuses the one shape the lock cannot see: an output directory
  that is a symbolic link into a directory its inputs can match below.
- Say `dist -> src` under `src/**` or `**/*.ts`. Remove the link.

#### `VX_E_NESTED_INPUT`

A task's `inputs.files` entry is rooted inside a project nested in its
own, say `dist/**` where `dist/` holds a config. A project's globs never
reach another project's files, so it would key nothing.

Depend on a task of the nested project, or name the files in
`inputs.workspaceFiles`, as the message shows.

A glob whose pattern reaches into a nested project past its fixed
prefix is refused too, say `*/d.txt`, or a root project's
`packages/**/*.ts` over a member.

The nested project's task owns those files: depend on it, or take them
back with `!dist/**`. A leading `**` is the project's own files and is
not refused.

A glob rooted in a nested workspace (`dist/` holding its own
`.vx/workspace.*`) is not refused: it keys that workspace's files.

A run refuses an `inputs.files` link into another project too, say
`src/a -> ../../a`, when no `dependsOn` path reaches that project. The
task fails with its key not derived.

Depend on a task of that project, or take the link back (`!src/a`) and
name its files in `inputs.workspaceFiles`. With a `dependsOn` path, the
link keys its target string alone.

`vx lock` refuses it, not a run: a run trusts the graph the lock holds.

#### `VX_E_NESTED_OUTPUT`

A task's `outputs.files` entry is rooted inside a project nested in its
own, say `sub/dist/**` where `sub/` holds a config. A project's globs
never reach another project's files, so it would save nothing.

Let a task of the nested project write the files, or name them in
`outputs.workspaceFiles`, as the message shows.

A glob whose pattern reaches into a nested project past its fixed
prefix is refused too, say a root project's `packages/**/*.log` over a
member: those files would never be saved.

Let the member's task write them, or take them back with
`!packages/a/**`. A leading `**` is not refused.

A nested workspace (`sub/` holding its own `.vx/workspace.*`) is refused
the same way, though an input glob may reach into one.

`vx lock` refuses it, not a run: a run trusts the graph the lock holds.

#### `VX_E_DEPENDENCY_RULE`

`vx lock` found a project depending on one a `run.rules.dependencies`
rule denies or does not allow.

A header counts the broken edges, and each indented line under it names
both projects and the rule. Drop the dependency, or change the project's
tags or the rule.

#### `VX_E_INTERNAL`

A defect in vx. Report it with its stack at
https://github.com/vznjs/vx/issues.

stderr carries the stack, then each `cause` under it as a `Caused by:`
line with its stack, then a line asking for a report.

A config's own throw is `VX_E_CONFIG`. A plugin hook's is `VX_E_REFUSED`
or the plugin's code.

A plugin can give its refusal a code: `new UserError(message, 'MY_CODE')`.
The code holds whether a hook, `setup` or a verb of the plugin throws it.

**Streams.** A verb whose stdout is a product writes that product alone
there: a `--format json` document, `--dry` / `--dry --format json`, a
completion script.

A notice or warning it meets on the way goes to stderr, as every refusal
does: a cache index from another vx version, a plugin's warning.

`vx run`'s stdout is the run's frame, the tasks' output it carries.
`tests/cli-streams.test.ts` holds each product verb to it under a
notice.

## `vx show`

`vx show` prints each project's config as a run sees it right now.

It reads `.vx/projects.lock` and applies the plugins' `config` and
`project` stages, as a run does. It evaluates no config: after an edit,
run `vx lock` first.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `turbo()` or `nx()` from `@vzn/vx-migrate`: a package a plugin gives
  tasks to shows those tasks.
- ``no lock: run `vx lock` ``: with no lock, `vx show` refuses as a run
  does.

</div>
</details>

### Usage

```sh
vx show                          # list every project
vx show <project>                # one project's resolved config (`//`: the root project's)
vx show <pkg>#<task>             # a single task (`//#<task>`: the root project's)
vx show <task>                   # that task in every project declaring it
vx show [<task>] --filter <p>    # only the projects `vx run --filter <p>` selects
vx show <task> --affected        # only the projects whose <task> `vx run <task> --affected` runs
vx show --affected               # the run's candidates: the changed projects and their dependents
vx show ... --format json        # machine-readable (default: pretty)
```

### Examples

```sh
vx show
```

```ansi
[4m[58;2;110;118;129m  [1m[38;2;167;139;250mProjects[0m[4m[58;2;110;118;129m [2m2[0m[4m[58;2;110;118;129m                                                                                                            [0m
  [2mproject    dir           tasks[0m
  [38;2;192;132;252m@demo/ui[0m   [38;2;203;213;225mpackages/ui[0m   [38;2;203;213;225m3 tasks[0m
  [38;2;244;114;182m@demo/web[0m  [38;2;203;213;225mpackages/web[0m  [38;2;203;213;225m3 tasks[0m
```

```sh
vx show @demo/web#build
```

```ansi
[4m[58;2;110;118;129m  [1m[38;2;167;139;250m@demo/web#build[0m[4m[58;2;110;118;129m                                                                                                       [0m
  [2mdir          [0m  [38;2;203;213;225mpackages/web[0m
  [2mcommand      [0m  [38;2;203;213;225mvite build[0m
  [2mdependsOn    [0m  [38;2;203;213;225m^build[0m
  [2minputs.files [0m  [38;2;203;213;225msrc/**, vite.config.ts, package.json[0m
  [2moutputs.files[0m  [38;2;203;213;225mdist/**[0m
  [2mcache        [0m  [38;2;203;213;225myes[0m
```

### Options

| Option                  | Meaning                                           |
| ----------------------- | ------------------------------------------------- |
| `--filter <p>`          | only the projects `vx run --filter <p>` selects   |
| `--affected[=<base>]`   | only what `vx run --affected` would select, below |
| `--format pretty\|json` | `json` for scripts                                |

### Understanding the output

**The project list.** With no target, `vx show` prints one row per
project: its name, its folder from the root and its task count.

| The tasks cell says                                     | Means                                              |
| ------------------------------------------------------- | -------------------------------------------------- |
| `3 tasks`                                               | the project's config declares three tasks          |
| `3 tasks, default build`                                | it declares no `build`, so it gets the default one |
| `2 tasks from plugins (no vx config)`                   | a plugin gave the tasks; there is no config        |
| `3 tasks, 2 from plugins, default build (no vx config)` | a plugin gave two; `build` is the default          |
| `1 task, default build (no vx config)`                  | a configured project depends on it                 |
| `no vx config`                                          | a package with no config and no tasks              |

A `tags` column appears when any project has tags.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `1 task, default build (no vx config)`: a run loads that build for the
  dependant's `^build`.
- `<project>#build  default`: how `vx show <project>` marks a default
  build.
- `vx show bare`: a package nothing configured reaches lists no task, and
  `vx run bare#build` refuses it.
- `vx.config.ts not locked — run vx lock`: a config written after the
  lock. It shows in the list and in `vx show <project>`'s `config` row.
- On a terminal too narrow for the list, `tags` goes, then `dir`.
- `--format json`: an array of `{ name, dir, tags: string[], tasks: string[], defaultBuild: boolean }`. `defaultBuild` is true where the text says `default build`.

</div>
</details>

**A project or task.** `vx show <project>` prints a block per task,
headed by its `project#task`, after the project's `dir` and `tags`.
Each block lists the fields the run reads.

```sh
vx show @demo/web          # every task of the project
vx show @demo/web#build    # one task
vx show build              # build, in every project that declares it
```

Fields the task does not set are left out. An empty list prints `none`.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `config  none`: a package with no config file.
- `command  (group)`: a group task.
- Fields shown: description, command, `dependsOn`, `timeout`, `retries`,
  `env.passThrough` / `env.define` / `env.secret`, `remote`, `platforms`,
  `sandbox`.
- More fields: `persistent` and `interactive` (`yes` / `no`).
- With `cache: true`: `inputs.files` / `.workspaceFiles` / `.env` /
  `.tasks` / `.runtime` / `.workspaceRuntime`.
- Also with `cache: true`: `outputs.files` / `.workspaceFiles` / `.clean`
  (`yes` / `no`) and `inputs.stability.strategy` / `.severity`.
- `cache  yes`: the last row of a cached task.
- A multi-line value, such as a command, continues under its first line.
- `vx show <project> --format json`: `{ name, dir, defaultBuild, config }`, the config
  exactly as resolved.
- `vx show <pkg>#<task> --format json`: `{ name, dir, task, defaultBuild, config }`.
- `vx show <pkg>#build` marks a default build `default`, as the project
  view does.
- `vx show build`: a bare name that is no project is a task. JSON: an
  array of the one-task shape.
- The default `build` is declared by no project. It counts in the list,
  in `vx show <project>`, and on `vx info`'s `projects` row.
- `vx show build` does not name a default build, as `vx run build --all`
  does not run one.

</div>
</details>

### `--filter` and `--affected`

`--filter` and `--affected[=<base>]` narrow the list, or a task's
projects, the way `vx run` selects them.

```sh
vx show --affected               # changed projects and their dependents
vx show test --affected          # projects whose test the run would run
vx show --filter @demo/web
```

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `vx show test --affected` lists the projects whose `test` the run
  keeps. A change reaches another project only along a task edge.
- A dependent whose `test` has no `^test` is not listed.
- `no affected project's test runs` (stderr): the selection left the list
  empty. `--format json` prints `[]`.
- `vx show --affected`, no task: no edge to follow. The list is the run's
  candidates, as `--filter "...[<base>]"` selects.
- Those candidates are the changed projects and their package dependents.
- `vx show @demo/web --affected` and `vx show @demo/web#build --filter …`:
  refused beside one project or one task.
- `vx show projects`, when nothing has that name: an unknown name, whose
  refusal adds that `vx show` lists the projects.
- `vx show project web`: refused, pointing at `vx show web`.

</div>
</details>

### Unknown names

An unknown project or task exits `1` with a near-miss hint, as every
verb gives.

```text
vx show: unknown project or task: "buidl"
fix  build
```

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- A hint is a name within two edits, or one holding the partial name.
- `unknown task: "@demo/web#bui"` with `fix  @demo/web#build`: a
  `pkg#task` hints whole specs.
- `p/a` hints `alpha` when `alpha` lives at `p/a`; `p/a#build` hints
  `alpha#build`.
- `unknown project: "zzz"; projects: @demo/ui, @demo/web`: nothing is
  near, so it lists what exists.
- `; its tasks: @demo/web#build, @demo/web#test` or `; projects and
tasks: …`: the other two lists it may end with.
- `vx show ''`: an empty target is refused. Omit it to list every project.
- `no projects` (stderr): a workspace with no project. The list is empty
  and the line names `vx init`.

</div>
</details>

### Exit codes

| Code | When                          |
| ---- | ----------------------------- |
| `0`  | success                       |
| `1`  | parse error or unknown target |

## `vx info`

`vx info` prints one screen of facts about the workspace and this
machine. Paste it into a bug report, or read it to check your setup.

It counts tasks from the lock, as a run does, and evaluates no config.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- The task count and the sandbox row's count come from the load a run
  uses: the lock, plugin stages included.
- A default build is no declared task. It is named apart:
  `21 (332 tasks, 7 default builds)`, `vx show`'s 339. JSON:
  `defaultBuilds`.
- No lock: `projects` reads `—` and `projects lock` reads `no`.
- A lock a run would refuse: `projects` reads `—` and `projects lock`
  reads `refused:` and why. JSON: `lockError`, the counts zero.
- A broken config is `vx lock`'s to report, not `vx info`'s.
- A `.vx/workspace` that does not load (a syntax error, a plugin hook
  that threw): the report still prints, with a `workspace config` row
  reading `refused:` and why, and exits `1`.
- Then `projects` and `plugins` read `—`, the sandbox row names no
  count, and the cache dir is the one a workspace with no file uses.
  JSON: `workspaceError` (`{ code, message }`).

</div>
</details>

### Usage

```sh
vx info [--format pretty|json] [--cache-dir <path>]
```

### Example

```sh
vx info
```

```ansi

[4m[58;2;110;118;129m  [1m[38;2;167;139;250mvx info[0m[4m[58;2;110;118;129m                                                                                                               [0m
  [2mvx              [0m  [38;2;203;213;225m0.0.0 (/usr/local/bin/vx)[0m
  [2mbun             [0m  [38;2;203;213;225m1.4.4[0m
  [2mgit             [0m  [38;2;203;213;225m2.43.0[0m
  [2mgit status cache[0m  [38;2;203;213;225mcore.fsmonitor, core.untrackedCache off[0m
  [2mworkspace root  [0m  [38;2;203;213;225m/work/demo[0m
  [2mprojects        [0m  [38;2;203;213;225m2 (6 tasks)[0m
  [2mplugins         [0m  [38;2;203;213;225m1 — @vzn/vx-lockfile (discover, project, key, fingerprint)[0m
  [2mworkers         [0m  [38;2;203;213;225m4 — the CPU count[0m
  [2mmemory          [0m  [38;2;203;213;225m13 GB usable — cgroup limit; the machine has 16 GB[0m
  [2mcache dir       [0m  [38;2;203;213;225m/work/demo/.vx/cache (440 KB, this workspace's run history)[0m
  [2mcache store     [0m  [38;2;203;213;225m~/.vx/97cf846b43fdfb12/cache (156 KB, shared by this workspace's checkouts)[0m
  [2mcache versions  [0m  [38;2;203;213;225mkeys vx-cache-v56 · index schema v59[0m
  [2mcache entries   [0m  [38;2;203;213;225m4 (1.9 KB)[0m
  [2mtask runs (24h) [0m  [38;2;203;213;225m58 (19 cache hits: 18 up-to-date, 1 restored)[0m
  [2mflaky tasks     [0m  [38;2;203;213;225m1 — @demo/web#test (5 of 13 runs failed on unchanged inputs)[0m
  [2msandbox         [0m  [38;2;203;213;225mavailable (1 task declares exec.sandbox)[0m
  [2mprojects lock   [0m  [38;2;203;213;225myes[0m
```

### Options

| Option                  | Meaning                                                 |
| ----------------------- | ------------------------------------------------------- |
| `--format pretty\|json` | `json` prints the same facts as one typed object, below |
| `--cache-dir <path>`    | read the cache a run with the same flag uses            |

### Understanding the output

Each row is one fact. Paths under your home directory print as `~/…`;
the JSON keeps them absolute.

| Row                | Says                                                     |
| ------------------ | -------------------------------------------------------- |
| `git`              | git's version, or `(not found)`                          |
| `git status cache` | whether git's two speed-ups for `git status` are on      |
| `workspace config` | why `.vx/workspace` did not load; only then printed      |
| `plugins`          | each plugin `.vx/workspace.*` declares, and its seams    |
| `workers`          | how many tasks a run starts at once, and why             |
| `memory`           | the memory a memory-packing schedule budgets             |
| `cache dir`        | the index and this workspace's run history, size on disk |
| `cache store`      | where entries live, shared by this workspace's checkouts |
| `cache versions`   | the key prefix and index schema a bug report needs       |
| `cache entries`    | how many entries, and their size                         |
| `task runs (24h)`  | task runs in the last day, and how many were hits        |
| `flaky tasks`      | tasks that failed on inputs they had passed on           |
| `sandbox`          | whether the sandbox can start here                       |
| `settings`         | settings a variable, the workspace or a plugin changed   |
| `orphans`          | cache files the index has no row for                     |

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">git status cache</span></summary>
<div class="vx-deeper-body">

- vx runs one `git status` per run to find dirty and untracked files.
  On a large tree that walk is the warm run's critical path.
- Setting `core.fsmonitor`: a daemon that watches the worktree, or a hook it
  names.
- Setting `core.untrackedCache`: git keeps a cache of untracked files.
- Both make `git status` near-free after its first run. Both are off by
  default.
- The row reads each setting as git does: the last value set wins.
- vx trusts the files that walk calls clean. An fsmonitor that misses an
  event gives a stale hit: leave it off where events can be lost.

</div>
</details>

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">sandbox</span></summary>
<div class="vx-deeper-body">

- The row is this host's probe result (one sandboxed `true`, memoized)
  and how many loaded tasks declare `exec.sandbox`.
- A declared sandbox that cannot start fails the task at run time; it
  never downgrades. So the row warns first.
- The warning reads
  `unavailable — <why>; 3 tasks declare exec.sandbox and will fail`.
- Root inside a container: the seccomp helper cannot create its nested
  user namespace.
- Fix for root in a container: run as a non-root user, or set
  `sandbox.weakerWhenNested: true`.
- Other reasons: bubblewrap, socat or ripgrep missing; a nested seatbelt
  on macOS.
- On Linux the row may add `, untraced — <why>, so the reads it denies go
unreported`: the sandbox works but cannot report the reads it denies.
- Untraced means vx's observer cannot run, and `strace` is missing, its
  `--version` fails, or it may not attach.
- Untraced, the sandbox still enforces. A task that tolerates a denied
  read passes and caches, with no word of it.
- JSON: `sandbox.untraced`, the reason or `null`.

</div>
</details>

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">plugins, workers, memory</span></summary>
<div class="vx-deeper-body">

- `plugins`: the seams each fills, in pipeline order (`config`, `discover`,
  `project`, `graph`, `key`, `fingerprint`, `measures`, `schedule`, `admit`,
  `executor`, `cache`, `telemetry`, `output`, `setup`, `commands`).
- With no plugin, the row reads `none`.
- `plugins` reads the declarations. `otel()` with no endpoint declines
  each task at run time, yet still lists its seam.
- A factory that returned `undefined` (`github()` off
  Actions) declared no plugin, so it is not listed.
- `workers`: the source is the first that is set, `VX_RUN_CONCURRENCY`, then
  `run.concurrency` in `.vx/workspace.ts`, then the cores this process
  may use.
- The cores are the CPU count, capped by the cgroup CPU quota of a
  container: `8 — the CPU count`, `2 — cgroup CPU quota 2 of 8 cores`.
- A value a run refuses reads
  `— (VX_RUN_CONCURRENCY is refused: a run stops there)`. The `settings` row says why.
- `memory` is what a memory-packing policy (`@vzn/vx-history`) budgets:
  the machine's total, capped by the cgroup limit.
- Inside a container the raw numbers are the host's. This row shows
  which one a run reads.

</div>
</details>

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">flaky tasks and task runs</span></summary>
<div class="vx-deeper-body">

- `flaky tasks` is the standing list a run's flaky notes add to, most
  failures first, with the outcomes over those keys.
- A task is listed when its history holds a cache key that failed after
  it had passed.
- The history is all of it: a run never prunes it, and a bounded
  `vx cache clean` drops what is over 30 days old.
- A cache hit counts as a pass: it replayed one.
- A pass that took a retry counts too; its failed attempts count as
  failures.
- A task with no `cache: true` keys on its config alone, so its key says
  nothing about its inputs. It is never listed.
- A pass or failure behind a failed dependency, in a run that continues
  past failures, counts on no key.
- The row reads `none` when no key failed after passing.
- `task runs (24h)` counts task runs, executed and replayed alike, so the
  hits are a share of it.
- Three `vx run` of two tasks are six task runs. `vx last --list` counts
  the three invocations.

</div>
</details>

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">The cache rows</span></summary>
<div class="vx-deeper-body">

- `cache store` is the store this workspace's checkouts share
  (`docs/caching.md`), with its size on disk.
- The store reads `none: the cache dir holds the entries` when the
  workspace names its own cache dir, or when `HOME` is not a directory
  this user can write: set `HOME` to one to share the entries.
- `cache store` is the store the next run opens, before a first run too.
  It is not one the index recorded under a home since moved.
- After one `sudo vx run`, a store a run would not use (another user's)
  reads as the cache dir, where runs keep the entries then.
- A bare `vx cache clean` frees both sizes.
- `cache entries` reads `unreadable: <why and the fix>` when SQLite cannot
  read the index. The history rows read 0; the report still prints, exit 0.
- `cache versions`: the key prefix (`CACHE_VERSION`) and index schema
  (`SCHEMA_VERSION`) that a bug report and the reset notice name.
- A `CACHE_VERSION` bump orphans every entry.
- A `SCHEMA_VERSION` mismatch drops every table on the next open, and
  that run says so once.
- `orphans` appears only when the cache dir holds artifacts or save temps
  the index has no row for, older than an hour.
- Orphans are what a `SCHEMA_VERSION` reset leaves behind. A younger one
  is a save in flight.
- A task that asks for an orphan's key again indexes it and hits. Only
  `vx cache clean` reclaims the rest.

</div>
</details>

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">settings</span></summary>
<div class="vx-deeper-body">

- `settings` appears only when a variable, `.vx/workspace` or a plugin's
  `config` hook changed a setting.
- Each changed one shows by path, value and source:
  `cache.policy local:r (VX_CACHE_POLICY), run.timeout 30m (.vx/workspace)`.
- A plugin's: `cache.scope pr-2 (plugin @org/ci)`.
- A setting not named runs at its default. JSON `settings` holds every
  one.
- The `cache.policy` default: every layer on, remote writes off when not on
  CI.
- The `cache.scope` default: a plugin's, else the branch's from git.
- A refused variable, such as `VX_RUN_TIMEOUT=abc`, stops every other
  verb. `vx info` reports it and goes on.
- Its row adds `, refused:` and why:
  `run.timeout abc (VX_RUN_TIMEOUT, refused: …)`. JSON: `refused`.
- The other rows read as if the refused variable were unset.

</div>
</details>

### JSON

`--format json` prints the same facts as one typed object, for a script
or a bug-report template. The pretty rows render this object; there is
no second source.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every field</span></summary>
<div class="vx-deeper-body">

| `--format json` field                                                | Holds                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vx`                                                                 | the version                                                                                                                                                                                                                                                                     |
| `vxPath`                                                             | the file that ran                                                                                                                                                                                                                                                               |
| `handedOffFrom`                                                      | the vx that handed the call to the project's own, else null                                                                                                                                                                                                                     |
| `bun`                                                                | Bun's version                                                                                                                                                                                                                                                                   |
| `bunSupported`                                                       | false below Bun 1.4.4                                                                                                                                                                                                                                                           |
| `git`                                                                | git's version, null when not found                                                                                                                                                                                                                                              |
| `gitStatusCache` (`{ fsmonitor, untrackedCache }`)                   | null when git could not answer                                                                                                                                                                                                                                                  |
| `workspaceRoot`                                                      | the workspace root                                                                                                                                                                                                                                                              |
| `projects`, `tasks`, `defaultBuilds`                                 | the counts                                                                                                                                                                                                                                                                      |
| `plugins` (`[{ name, seams }]`)                                      | each plugin and the seams it fills                                                                                                                                                                                                                                              |
| `workers` (`{ count, source, cores, cpuQuota }`)                     | (the source one of `env` / `workspace` / `cgroup` / `cores`; `cpuQuota` in cores or null)                                                                                                                                                                                       |
| `memory` (`{ usableBytes, totalBytes, cgroupLimitBytes }`)           | the limit null when none binds                                                                                                                                                                                                                                                  |
| `cacheDir`, `cacheDirBytes`                                          | the cache dir, and its size on disk: the index and run history                                                                                                                                                                                                                  |
| `cacheStore`                                                         | null when the cache dir holds the entries                                                                                                                                                                                                                                       |
| `cacheStoreBytes`                                                    | on disk, null with no store                                                                                                                                                                                                                                                     |
| `cacheVersion`, `schemaVersion`                                      | the two versions a bug report needs                                                                                                                                                                                                                                             |
| `cacheEntries`, `cacheBytes`                                         | the entries and their size                                                                                                                                                                                                                                                      |
| `cacheIndexError`                                                    | why the index cannot be read, with the fix, else null; its counts read 0 then                                                                                                                                                                                                   |
| `settings`                                                           | every setting by path, `{ value, source, plugin, refused }` (`source` one of `env` / `workspace` / `plugin` / `default`; `plugin` the plugin whose config hook set it; `value` null for the default; `refused` why a run refuses the variable's value, absent when it takes it) |
| `orphans` (`{ artifacts, bytes }`)                                   | always present                                                                                                                                                                                                                                                                  |
| `runs24h`, `hits24h`                                                 | task runs and hits, as the row                                                                                                                                                                                                                                                  |
| `restored24h`                                                        | the hits that restored outputs; the rest found them up to date                                                                                                                                                                                                                  |
| `flakyTasks` (`[{ taskId, project, task, keys, passes, failures }]`) | empty when none                                                                                                                                                                                                                                                                 |
| `lockfile`                                                           | whether there is a lock                                                                                                                                                                                                                                                         |
| `lockError`                                                          | why a run refuses the lock there, null when it reads it or there is none                                                                                                                                                                                                        |
| `workspaceError` (`{ code, message }`)                               | why `.vx/workspace` did not load, null when it loads                                                                                                                                                                                                                            |
| `sandbox` (`{ available, reason, declared, untraced }`)              | (`declared` the count of tasks with `exec.sandbox`; `untraced` why denied reads go unreported, or null)                                                                                                                                                                         |

</div>
</details>

### Exit codes

| Code | When                                                |
| ---- | --------------------------------------------------- |
| `0`  | the facts printed, with no lock included            |
| `1`  | no workspace here or above, or a parse error        |
| `1`  | the facts printed, and `.vx/workspace` did not load |

## `vx why`

`vx why` tells you why a task re-ran: the file, variable or dependency
that changed its cache key since the run before.

It reads the local `cache.db` and hashes nothing again.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- Configs are evaluated only when a dependency that moved is a group,
  which records no run of its own.

</div>
</details>

### Usage

```sh
vx why (TASK | PKG#TASK) [--run RUNID] [--format pretty|json] [--cache-dir <path>]
```

### Example

```sh
vx why @demo/web#build
```

```ansi
[4m[58;2;110;118;129m  [1m[38;2;167;139;250mWhy[0m[4m[58;2;110;118;129m [2m@demo/web#build[0m[4m[58;2;110;118;129m                                                                                                   [0m
  [2mrun     [0m  [38;2;203;213;225m01a20a09-aa59-7506-89ab-db6e5860b83f[0m
  [2mthis run[0m  [38;2;203;213;225m2026-11-23T20:12:15.536Z · success · executed · key 74ea908d8b92000d[0m
  [2mprevious[0m  [38;2;203;213;225m2026-11-23T20:12:14.536Z · cache-hit · up-to-date · key 1b6ebb2fcb825864[0m
  [2mverdict [0m  [38;2;234;179;8mcache key changed: upstream @demo/ui#build[0m

[4m[58;2;110;118;129m  [1m[38;2;167;139;250mWhat changed[0m[4m[58;2;110;118;129m [2m1 of 9[0m[4m[58;2;110;118;129m                                                                                                   [0m
  [2mchange   kind      name            before → after[0m
  [38;2;234;179;8mchanged[0m  [38;2;203;213;225mupstream[0m  [1m@demo/ui#build[0m  [38;2;203;213;225m656b167cdd4cb280 → ed5b74f0328f56f9[0m

[4m[58;2;110;118;129m  [1m[38;2;167;139;250mRoot cause[0m[4m[58;2;110;118;129m                                                                                                            [0m
  [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;244;114;182mbuild[0m[2m ← [0m[38;2;192;132;252m@demo/ui[0m[2m#[0m[38;2;244;114;182mbuild[0m[2m ← [0m[1mfile packages/ui/src/index.ts[0m

[4m[58;2;110;118;129m  [1m[38;2;167;139;250mWhat to do[0m[4m[58;2;110;118;129m                                                                                                            [0m
  [2mfile    [0m  [38;2;203;213;225man edit re-runs by design; a file the task does not read belongs out of inputs.files[0m
```

On a narrow terminal each hash is cut to its first 12 characters. Piped
output and `--format json` keep them whole.

### Arguments

| Argument   | Meaning                                                          |
| ---------- | ---------------------------------------------------------------- |
| `PKG#TASK` | one project's task                                               |
| `TASK`     | a bare name: the cwd project's, else the one project that ran it |

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- A group (`{ dependsOn }`, no `exec`) records no run, so it is refused,
  with fix `vx show PKG#TASK`.
- `TASK` inside a project that declares it is that project's, as
  `vx run` picks.
- `no runs of <project>#<task> yet`: that task never ran, even when
  another project's did.
- `no runs of <project>#<task> recorded`: no run is recorded but its
  cache entry is stored. Its runs were pruned
  (`VX_HISTORY_RETENTION`), or another worktree ran it.
- `TASK` elsewhere resolves when exactly one project ran it. Several: an
  error listing the candidates.
- An unknown `TASK`: names that contain it. With none near, a pointer to
  `vx last --stats`, which lists the tasks that ran.
- Nothing ran yet: it says so. The fix is `vx run <task> --all` where the
  cwd's project does not declare the task.
- Only groups ran, which record no task row: it says no run executed a
  task. Ask about a task the group depends on.

</div>
</details>

### Options

| Option                  | Meaning                                      |
| ----------------------- | -------------------------------------------- |
| `--run RUNID`           | explain that run instead of the latest       |
| `--format pretty\|json` | `json` emits one object, below               |
| `--cache-dir <path>`    | read the cache a run with the same flag uses |

By default `vx why` compares the task's latest recorded run with the
run before it.

```sh
vx why @demo/web#build --run 01a20a09    # a unique prefix of the id is enough
```

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `--run` with a task that run did not run: refused, pointing at
  `vx last --list`.
- A task a Ctrl-C cut off in that run: the refusal says the stop ended
  it.
- `--run` with an id no run carries: refused.
- `--run -x`: the space form refuses a value that starts with `-`, a
  swallowed flag.
- History belongs to the cache dir, not the checkout. Worktrees sharing
  one `--cache-dir` share one history.
- So the previous run may be another worktree's (its branch is in
  `vx last`), and its edits read as changes.
- Latest and previous follow the order runs were recorded, not the
  clock. A clock that stepped back would swap them.

</div>
</details>

### Understanding the output

**The verdict.** A changed key's verdict names what moved: kind and
name, three at most, then a count.

```text
cache key changed: env MODE
```

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `(inputs differ)`: neither entry kept its components.
- A key that folds a task with no `inputs` is new every run, so the task
  never hits. The verdict names that task:

```ansi
  [2mverdict [0m  [38;2;203;213;225mnever cached: its key includes @demo/ui#gate, which declares no [0m[1m`inputs`[0m[38;2;203;213;225m, so each run derives a new key; declare inputs on @demo/ui#gate[0m
```

</div>
</details>

**An unchanged key** has three endings, and the verdict tells them
apart.

| Ending                      | Verdict says                      |
| --------------------------- | --------------------------------- |
| served from cache           | nothing re-ran                    |
| re-executed on the same key | why, when the index shows a cause |
| no cache outcome recorded   | so, instead of guessing           |

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Causes of a re-execution</span></summary>
<div class="vx-deeper-body">

- The previous run on the key failed and saved nothing.
- `--force`, or a `--cache-policy` without read: the run did not read the
  cache.
- `--no-cache`, or a `--cache-policy` without read or write: the run did
  not use the cache at all.
- No entry for the key was there when it ran: pruned or evicted.
- The previous run executed and no entry holds the key: its save failed,
  or a prune took it.
- A previous run whose policy wrote no cache says that instead, ahead of
  a prune.
- A previous run that built on a dependency `--exclude-dependencies` left
  out names that dependency.
- `did not save its result (… changed after its key was taken)`: the
  previous run withheld its save because an input changed while it ran.
- That reason comes ahead of a prune. A changed key's diff says the same
  where it has no fingerprints to compare.
- Otherwise, with this run's policy recorded as reading the cache, it
  says it cannot name the cause.
- Only a run with no recorded policy names `--no-cache` / `--force`.

</div>
</details>

**The run lines.** `this run` and `previous` each read when the run was,
its status, how it ended and its key.

| Line                         | Means                                      |
| ---------------------------- | ------------------------------------------ |
| `success · executed · key …` | it ran                                     |
| `cache-hit · key …`          | a local hit; `cache-hit-remote` for remote |
| `skipped · no key`           | it never ran and derived no key            |
| `failed · no key`            | its key was not derived; nothing ran       |

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- A hit's status names the hit and its tier, so only an executed run
  carries the word `executed`.
- `failed · no key`: for example a failed `inputs.runtime` probe.
- With no key, the verdict names the one cause the row records: what
  blocked a skip, or a key not derived.
- Or: a hit whose restore failed, or a persistent task.
- `vx last <run> --log <task>` prints the line vx said when a key was
  not derived.

</div>
</details>

**What to do and root cause.** `What to do` gives one line per kind that
changed: what moves it, and how to stop a move the task does not need.

An `env` line says whether a value moved or a name joined or left `inputs.env`.

An `upstream` row only carries a change. `vx why` follows it down to the
tasks whose own inputs moved, and prints each chain under `Root cause`:

```ansi
[4m[58;2;110;118;129m  [1m[38;2;167;139;250mRoot cause[0m[4m[58;2;110;118;129m                                                                                                            [0m
  [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;244;114;182mbuild[0m[2m ← [0m[38;2;192;132;252m@demo/ui[0m[2m#[0m[38;2;244;114;182mbuild[0m[2m ← [0m[1mfile packages/ui/src/index.ts[0m
```

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- The walk follows each dependency that moved in the same run.
- One chain per root, five at most, then a count.
- A chain of more than six tasks prints its first two and last three
  around `N more`.
- With roots, `What to do` speaks to the roots' kinds. A `config` line
  names the `vx show` of the root's task, not the asked one.
- Each upstream is compared between the two keys the dependant folded.
  A run of the upstream alone in between changes nothing it names.
- `upstream @demo/web#prep ← @demo/ui#build`: a group records no run, so
  the key names each task under a group it folds, through the group.
- `@demo/web#pack ← @demo/web#all ← @demo/ui#build ← file packages/ui/src.txt`:
  the walk goes on through the tasks a group gathers.
- A dependency the walk cannot find in the run keeps the `upstream`
  line, naming the `vx why` to run next.
- That line never names a group's `vx why`, which refuses. For a group it
  names the `vx show` that lists what it gathers.
- A dependency added or removed moved no key. Its line says the graph
  changed (`dependsOn` or a project edge).
- A `config` line names the `vx show` that prints the task's config now.

</div>
</details>

**Changed during a run.** An input file last changed while a recorded
task ran names that task. A build that rewrites a file another key reads
re-keys that key every run:

```ansi
[4m[58;2;110;118;129m  [1m[38;2;167;139;250mChanged during a run[0m[4m[58;2;110;118;129m                                                                                                  [0m
  [2mfile                     written while[0m
  [1mpackages/ui/src/gen.txt[0m  [38;2;203;213;225m@demo/web#build[0m
```

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- The miss is right. Only moving the write ends it, for example a build
  that rewrites a translation file in another package.
- An edit made outside a run, or after the asked run ended, names no
  task.
- The history holds when tasks ran, not what they wrote. A hand edit
  made while another task ran names that task.

</div>
</details>

**Kinds.** A row's kind is what the key folded:

| Kind                    | What the key folded                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `file`                  | an input file, by blob id                                                                               |
| `linked`                | the content behind a `file` that is a symlink                                                           |
| `env`                   | a declared variable, by digest                                                                          |
| `runtime`, `ws-runtime` | a declared command's output, `inputs.runtime` and `inputs.workspaceRuntime`                             |
| `forward`               | the argv forwarded after `--`                                                                           |
| `config`                | the evaluated task config                                                                               |
| `upstream`              | a dependency's input key — a lockfile change moves it too, so that row rides with the lockfile plugin's |
| `plugin`                | a `key` plugin's material, by name; a lockfile plugin's dependency closure                              |
| `platform`              | the platform a task naming `exec.platforms` ran on                                                      |
| `format`                | the key format vx itself folds: it moves only with an upgrade, and re-keys every task once              |

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `\xNN`: a control character in a name (an escape, a carriage return)
  prints this way, so no file name drives the terminal.
- `--format json` carries the name as it is.

</div>
</details>

**When there is no diff.** The rows come from the input fingerprints
saved with each cache entry (`entry_inputs`). When an entry is gone,
`vx why` still names the key change and says the rows are unavailable.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- An entry is gone when it was pruned, or the run failed and never saved
  one.
- An entry restored from a remote cache came with no fingerprints (the
  artifact carries none). The detail line says so, not "pruned".
- A hit that restores a file git tracks records the ones this machine
  derived the same key from, so its diff has rows.
- Only the previous run failed, or wrote no cache (`--no-cache`, or a
  `--cache-policy` without write): the diff is taken against the last
  run that saved an entry.
- Then the detail line names that run, even when the diff has rows.
- This run wrote no cache: the detail line says so, not "pruned".
- A task with `inputs` and no `cache: true` derives a key, which
  dependents fold, but saves no entry.
- For such a task `vx why` can only report the key change, and says so.

</div>
</details>

### JSON

`--format json` emits one object: `{ taskId, runId, why, diff, roots,
writers }`.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `--format json` prints `{ taskId, why, diff, explanation }` when the
  task's recorded runs predate run ids. `why` and `diff` are null.
- `explanation`: the latest cache entry's key.
- `roots`: the root-cause walk (`chain`, `entries`), every root with its
  whole chain, written as it goes.
- A 20,000-task chain where every task moved is 2 GB of JSON.
- `writers`: the changed-during-a-run files (`taskId`, `file`,
  `writers`).

</div>
</details>

### Exit codes

| Code | When                                                                        |
| ---- | --------------------------------------------------------------------------- |
| `0`  | the task's run explained                                                    |
| `1`  | no recorded run of the task, a `--run` with no row for it, or a parse error |

## `vx last`

`vx last` shows a past run again from the local history. It runs
nothing, asks no cache and evaluates no config.

```sh
vx last                  # the latest run
vx last --failed         # the latest run that failed
```

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Stopped runs</span></summary>
<div class="vx-deeper-body">

- A run a Ctrl-C (or SIGTERM, SIGHUP) stopped records the tasks that
  ended before the stop: rows, timings, failed output.
- It records no summary, so bare `vx last` still shows the run before
  it. A `vx watch` cycle a stop ended records none either.
- Its id is printed by its footer, `vx why` and `vx last --log`, and works
  wherever a run id does.
- `vx last RUNID --log <task>` prints a task's output; `vx why <task>
--run RUNID` explains it. With no id, `--log` reads it when it is the
  latest run that recorded the task.
- `vx last RUNID` says the run was stopped.
- A run stopped before any task ended keeps nothing. Its footer names no
  id.

</div>
</details>

### Usage

```sh
vx last [RUNID] [--list[=N]] [--failed] [--log <task>] [--stats [<task>] [--branch <name>]] [--sql <query>] [--live [--follow]] [--format pretty|json] [--cache-dir <path>]
```

### Examples

```sh
vx last
```

```ansi
[4m[58;2;110;118;129m  [1m[38;2;167;139;250mRun[0m[4m[58;2;110;118;129m [2m01a20a09-aa59-7506-89ab-db6e5860b83f[0m[4m[58;2;110;118;129m                                                                              [0m
  [2mstatus  [0m  [38;2;34;197;94mok[0m
  [2mcommand [0m  [1mvx run build --all[0m
  [2mwhen    [0m  [38;2;203;213;225m2026-11-23T20:12:15.325Z · 367ms · feature @ b2c16ff2+dirty[0m
  [2mtasks   [0m  [2m2 tasks · 0 hits[0m

[4m[58;2;110;118;129m  [1m[38;2;167;139;250mTasks[0m[4m[58;2;110;118;129m [2m2[0m[4m[58;2;110;118;129m   [2mstatus  cache     ±usual    time   cpu    mem outputs  blocks worker         task[0m[4m[58;2;110;118;129m                           [0m
            [38;2;34;197;94msuccess[0m [2mmiss[0m        [2m+0ms[0m   [38;2;203;213;225m161ms[0m  [2m111%[0m  [2m106MB[0m     [2m86B[0m       [38;2;203;213;225m1[0m [2mlocal[0m          [38;2;192;132;252m@demo/ui[0m[2m#[0m[38;2;244;114;182mbuild[0m
            [38;2;34;197;94msuccess[0m [2mmiss[0m        [2m+0ms[0m   [38;2;203;213;225m150ms[0m  [2m115%[0m  [2m108MB[0m    [2m112B[0m       [2m0[0m [2mlocal[0m          [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;244;114;182mbuild[0m
```

```sh
vx last --list
```

```ansi
[4m[58;2;110;118;129m  [1m[38;2;167;139;250mRuns[0m[4m[58;2;110;118;129m [2m3[0m[4m[58;2;110;118;129m                                                                                                                [0m
  [2m    when                      run            tasks                                         time  command[0m
  [38;2;34;197;94mok[0m  [38;2;203;213;225m2026-11-23T20:12:15.325Z[0m  [1m01a20a09-aa59[0m  [2m2 tasks · 0 hits[0m                             [38;2;203;213;225m367ms[0m  [1mvx run build --all[0m
  [38;2;34;197;94mok[0m  [38;2;203;213;225m2026-11-23T20:12:14.522Z[0m  [1m01a20a09-a737[0m  [2m2 tasks · 2 hits (2 up-to-date, 0 restored)[0m   [38;2;203;213;225m18ms[0m  [1mvx run build --all[0m
  [38;2;34;197;94mok[0m  [38;2;203;213;225m2026-11-23T20:12:14.024Z[0m  [1m01a20a09-a545[0m  [2m2 tasks · 0 hits[0m                             [38;2;203;213;225m333ms[0m  [1mvx run build --all[0m
```

```sh
vx last --failed          # the latest run that failed
vx last --log @demo/web#test    # one task's output
vx last --stats @demo/web#test  # p50, p99, pass and hit rate over the last 50 runs
vx last --sql "SELECT task, AVG(peak_rss_bytes) FROM runs GROUP BY task"
```

### Arguments

| Argument | Meaning                             |
| -------- | ----------------------------------- |
| `RUNID`  | show that run instead of the latest |

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `vx last 01a20a09-aa59`: a unique prefix of the id is enough.
- A prefix several runs share fails and lists them.
- An unknown run id fails and points at `--list`. A stopped run's id says
  the run was stopped.

</div>
</details>

### Options

| Option                  | Meaning                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `--list[=N]`            | the N most recent runs (default 10)                                                   |
| `--failed`              | the latest run that failed, past any green one since; with `--list`, only failed runs |
| `--log <task>`          | one task's output instead of the summary                                              |
| `--stats [<task>]`      | per-task numbers over the last 50 runs                                                |
| `--branch <name>`       | the branch `--stats` forecasts from                                                   |
| `--sql <query>`         | the rows one read-only `SELECT` over the history selects                              |
| `--live`                | the run in progress: what runs, what ended, what waits, its warnings                  |
| `--follow`              | with `--live`, the run's events from now to its end                                   |
| `--format pretty\|json` | `json` for scripts and agents, below                                                  |
| `--cache-dir <path>`    | read the cache a run with the same flag uses                                          |

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `--log` does not combine with `--list` or `--failed`.
- `--stats` does not combine with `--list`, `--failed` or `--log`.
- `--branch` combines only with `--stats`.

</div>
</details>

### Understanding the output

**The header and rows.** Bare `vx last` shows the latest run: a header,
then one row per task on the run's own grid. It reads as the run did.

| Column    | Shows                                                    |
| --------- | -------------------------------------------------------- |
| `status`  | how the task ended                                       |
| `cache`   | `miss`, `no-cache`, or the kind of hit                   |
| `±usual`  | this time against the task's usual time; `—` never timed |
| `time`    | how long it took                                         |
| `cpu`     | average cores used; a hit's is blank, it spent nothing   |
| `mem`     | peak memory; a hit's is blank                            |
| `outputs` | the bytes of its outputs, restored or written            |
| `blocks`  | how many tasks and groups are downstream of it           |
| `worker`  | `local`, or the machine an executor named                |
| `task`    | its id, then a note when there is one                    |

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">The header and columns</span></summary>
<div class="vx-deeper-body">

- The header: verdict, command, when, duration, branch @ sha, CI, and
  the task, hit and failure counts.
- The same component draws a run and its replay.
- `±usual` measures an executed task against its usual time now, as a
  run on this branch reads history.
- `±usual` uses the timings of the definition (command and `env.define`)
  the task ran under.
- `—` in `±usual`: never timed, or timed only by this run.
- `no-cache`: the task caches nothing, or its run read and wrote no
  cache (`--no-cache`).
- `—` in any other cell: a value the run could not read.
- The cache key is in `--format json` only.

</div>
</details>

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Row notes</span></summary>
<div class="vx-deeper-body">

- `exit 137`: a failure's exit code, after the id.
- `128 + SIGKILL`: the signal an exit above 128 stands for, by the
  shell's convention. A command that exits 137 itself reads the same.
- Where the footer gave a reason, the row ends with it instead.
- `timed out`, `never ready: exited`.
- `src/a.ts changed during the run`: an `inputs.stability.severity:
'error'` failure, read from its kept output.
- `2 sandbox violations`.
- `after @demo/ui#build failed`: a skipped task. Rows older than those
  columns read as before.
- `after @demo/ui#test did not pass`: skipped behind a task with no row,
  one `--fail-fast` stopped. History keeps no row for it.
- `needs another platform`, `after ios#build skipped: needs another
platform`: a platform skip.
- `2 attempts`: a task that retried, passed or failed. JSON: `attempts`,
  null for a task run once.
- `remote ✗ download: connection refused; upload: 503`: a remote read or
  write failed for its key. JSON: `remoteError`.
- `@demo/web#build@small#1`: an executor plugin ran it elsewhere. JSON:
  `placement`.
- On a narrow terminal a row's note goes on its own line under the row,
  as a `--dry` reason does.

</div>
</details>

**Order and folding.** Failures come first, then what executed or was
skipped, then hits. Past sixteen hits, the rest fold into one line:
`… +980 more cache hits`.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- Without folding, a thousand-task warm run is a thousand rows, with the
  one failure a screen above the prompt.
- The sixteen hits shown are the slowest restores: the one thing a hit's
  row tells.
- `--format json` lists every row.

</div>
</details>

**Steps.** Below the tasks come the steps the run did not wait on, which
its own output never shows: `success  vx:prefetch  1.20s  internal`.

**Warnings.** Below the steps come the run's warnings, as it said them,
colour stripped. A terminal scrolls them past; the footer keeps only
their count.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- A step: `vx:prefetch`, or a remote's downloads beside the tasks.
- Steps are kept per run, the newest 50, as `steps` rows of cache.db,
  written only by a run that had one. JSON: `steps`.
- A warning: a glob that matched no files, a remote's 403, a plugin's
  notice.
- Warnings are kept per run, the newest 50, as `warnings` rows, written
  only by a run that warned.

</div>
</details>

**Re-run what failed.** A replayed run with failures ends with a `next`
row, the command that re-runs them:

```text
  next      vx run @demo/web#test -- …
```

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- The row keeps the arguments the run forwarded to the tasks that got
  them.
- A failed dependency never got them, so it gets a line of its own
  without them.
- `-- 'a b'`: the `command` row (`vx run …` or `vx watch …`) and `next`
  shell-quote each argument, so both paste back as they ran.
- `'@demo/web#it'\''s boom'`: `next` quotes a task id the same way.

</div>
</details>

**No runs yet.** Before any run that was not stopped, every form says so
but `--log`, which reads a stopped run's tasks.

| Command                                    | Prints                                  | Exit |
| ------------------------------------------ | --------------------------------------- | ---- |
| `vx last`                                  | `› vx last  no runs yet`, `fix  vx run` | 1    |
| `vx last --list`                           | `› vx last  no runs yet`                | 0    |
| `vx last --list --failed`, green runs only | `› vx last  no failed runs`             | 0    |

### `--list`

`vx last --list` prints the most recent runs, 10 unless you give a
count, one per line: verdict, start, run id, counts, duration, command.

```sh
vx last --list 5
vx last --list=5
```

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- Each run id is cut to the shortest prefix no other run shares, 13
  characters at least.
- `--list 5`: the space form takes the next word as the count unless it
  is a flag or a run id (eight hex digits at least).
- `--list 1.5`: refused as a count.
- `vx last RUNID` shows one run; it does not combine with `--list`.
- A word beside `--list` that no run id could be is refused as an
  unexpected argument.
- On a narrow terminal the start goes first, then the counts.
- A command that does not fit beside its run goes on its own line under
  it.
- A control character in a command, such as a newline forwarded after
  `--`, shows as `\x0a`, so each run keeps one line.

</div>
</details>

### `--log`

`--log <task>` prints one task's output instead of the summary, from
the latest run that recorded the task, or from `RUNID`'s.

```sh
vx last --log @demo/web#test
vx last 01a20a09 --log build      # a bare name: the one project that ran it
```

A failed task shows its kept failure output. Any other task shows the
log in its cache entry, so a passing task's log reads too.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- The cache entry's log is the one a hit replays, masked as it was.
- It is masked again with this process's secret values, as a hit's
  replay is. A task's `env.define` / `env.secret` values only the run
  knows.
- It reads on a hit, or in the run that saved the entry.
- The entry is the key's, not the run's. It records the run that wrote
  it.
- So a run whose entry another run wrote since shows none rather than
  that run's output.
- That happens when a `--force` run saves over the entry it finds.
- Or when a key is pruned and saved again, or saved by two checkouts of
  one store at once: it holds the later run's output.
- No log kept: an uncached task that passed, a skip, or a failed task
  past the newest 50 failed runs.
- Then stdout is empty and stderr says so, exit 0.
- `c#after did not run: c#gate blocked it (vx last --log c#gate)`: a
  skip names what blocked it.
- A kept log that is empty says the task printed nothing.
- A task that failed before its command ran (its key not derived, a
  restore that threw) keeps the line vx said.
- `── attempt 1 of 2 · exit 1 ──`: a task that retried shows every
  attempt under a heading.
- The last heading reads `passed` when a retry passed, or `passed, output
not kept` when no cache entry holds what it printed.
- A retried attempt's sandbox violations end its output.
- `--format json`: `{ runId, taskId, status, source, output }`, `source` `'failure'`,
  `'cache'` or `null`.
- A task no run recorded is refused, exit 1, naming recorded tasks as
  `vx why` does.
- Those names are one or two edits away, or hold the typed id
  (`@w/envy#test` for `envy#test`).
- `--log build`: a bare name is the one project that ran it. With several,
  the cwd's project; else refused, listing them.
- `//#<task>` is the root project's, here and in `--stats`.
- `vx last @demo/web#build --log`: a `--log` with no value takes the
  positional as its task.

</div>
</details>

### `--stats`

`--stats [<task>]` prints one row of numbers per task over the last 50
runs, the window the scheduler and `--dry` learn from.

```sh
vx last --stats                    # every task
vx last --stats @demo/web#test     # one task
vx last --stats test               # test, in every project
```

| Column       | Means                                          |
| ------------ | ---------------------------------------------- |
| runs         | runs in the window                             |
| p50          | the forecast a run shows                       |
| p99          | of the same timings: of five, the slowest      |
| pass rate    | share of runs that passed                      |
| hit rate     | share of runs served from cache                |
| failure mode | `stable`, `flaky-recoverable` or `flaky-fatal` |
| peak RSS     | the largest peak memory                        |
| cpu          | the mean CPU parallelism                       |

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- p50 and p99 read one set of timings, the ones the forecast reads: the
  task's last five on the branch, else on any branch.
- A hit counts what its producing run used.
- Units match the run grid: `3.6MB`, cpu `127%`, `—` where unknown.
- On a narrow terminal, columns go in this order: cpu, peak RSS, p99, hit
  rate, failure mode, runs. Task, p50 and pass rate stay.
- A task the window has no run of is refused, exit 1.
- The refusal names runs the window holds only under an older command or
  `env.define`, or of a task gone from the lock.
- The branch: `--branch`, else `VX_RUN_BRANCH`, else git's, then the CI
  provider's, as a run's.
- `--format json`: `{ window, branch, stats }`.
- Each JSON row: `{ taskId, runs, p50DurationMs, p99DurationMs,
successRate, hitRate, failureMode, maxPeakRssBytes, maxCpuParallelism }`.
- `null` where nothing was measured.
- A task whose command or `env.define` changed counts only its runs
  since, as the scheduler and `--dry` do.
- Its definition is read from the lock.

</div>
</details>

### `--live`

`vx last --live` asks the run in progress on this workspace, from
another shell, what runs, what ended and what waits.

An agent that started `vx run` in the background reads it without
waiting for the end. The history holds a run only once it ended.

```sh
vx last --live
```

```ansi
[4m[58;2;110;118;129m  [1m[38;2;167;139;250mRun[0m[4m[58;2;110;118;129m [2m01a20763-8948-7770-8fbf-4249802eeb29[0m[4m[58;2;110;118;129m                                                                              [0m
  [2mstatus  [0m  [38;2;6;182;212mrunning 1.85s[0m
  [2mcommand [0m  [1mvx run build --all[0m
  [2mtasks   [0m  [38;2;203;213;225m1 running · 0 ended · 1 waiting[0m

[4m[58;2;110;118;129m  [1m[38;2;167;139;250mTasks[0m[4m[58;2;110;118;129m [2m2[0m[4m[58;2;110;118;129m                                                                                                               [0m
  [2mstatus   task              time[0m
  [38;2;6;182;212mrunning[0m  [38;2;192;132;252m@demo/ui[0m[2m#[0m[38;2;244;114;182mbuild[0m   [38;2;203;213;225m1.80s[0m
  [2mwaiting[0m  [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;244;114;182mbuild[0m
```

`--follow` prints the same snapshot, then each of the run's events
until it ends.

```text
@demo/web#test │ ✓ renders
success  @demo/web#test  1.20s
```

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `--format json`: `{ live, tasks, warnings }`.
- `live`: `{ runId, command, pid, startedAt, elapsedMs }`.
- Each task: `{ taskId, status, startedAt, durationMs }`.
- `status` is `running`, `waiting` or the status it ended with. Times are
  epoch ms, `null` where not yet known.
- Order: running first, then what ended, then what waits. Groups are not
  listed.
- `--follow` prints a task's output as `@demo/web#test │ <line>`, each end
  as `success  @demo/web#test  1.20s`, each warning as `warn  …`.
- `--follow --format json`: the snapshot line, then one event per line,
  each with a `kind` (`schemas/last.json`'s `event`).
- The kinds: `run:start`, `task:start`, `task:stdout`, `task:stderr`,
  `task:complete`, `task:measure`, `run:status`.
- Then `step:start`, `step:end`, `run:end`, `run:stop`, and last
  `run:done`.
- A task that started before the follower attached has no `task:start`:
  the snapshot holds it.
- `no run in progress` (exit 1, `VX_E_NO_HISTORY`): nothing runs. A run
  killed with its socket left counts.
- A run that does not answer within 5 s reads the same.
- `--live` combines only with `--follow`, `--format` and `--cache-dir`.

</div>
</details>

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">What it costs a run</span></summary>
<div class="vx-deeper-body">

- Nothing is written.
- The run listens on a unix socket beside its run lock while it holds
  the lock.
- A run that holds its server in the foreground (`vx run dev`) still answers
  after it frees the lock, until the server ends. The server reads `running`.
- The socket sits in this user's own temp directory, so no other user
  reaches it.
- The run keeps only when each task started. The snapshot is built when
  asked.
- Output is not kept: it reaches a follower only while one is attached.
- A follower that falls 1 MiB behind is let go, so a stuck reader never
  holds the run.
- A follower let go, or whose run is killed, exits 1 with no `run:done`.

</div>
</details>

### `--sql`

`--sql <query>` runs one `SELECT` over the run history and prints the
rows as a table. It answers what no flag does: filter by task or
project, group, trend.

```sh
# a task's memory and cpu, run by run
vx last --sql "SELECT started_at, duration_ms, cpu_ms, peak_rss_bytes FROM runs
  WHERE project = '@demo/web' AND task = 'build' ORDER BY started_at"
# failures per day
vx last --sql "SELECT date(started_at / 1000, 'unixepoch') AS day, SUM(exit_ok = 0) AS failed
  FROM invocations GROUP BY day"
# the input files a key folded
vx last --sql "SELECT components FROM entry_inputs WHERE entry_hash = 'd6e223ce81dfdb2c'"
# what the runs warned of, and the steps they did not wait on
vx last --sql "SELECT run_id, text FROM warnings ORDER BY run_id DESC"
vx last --sql "SELECT step, AVG(duration_ms) FROM steps GROUP BY step"
```

| Table                             | One row per                                     |
| --------------------------------- | ----------------------------------------------- |
| `invocations`                     | run                                             |
| `runs`                            | task per run, joined on `run_id`                |
| `steps`                           | step a run did not wait on                      |
| `warnings`                        | warning a run printed                           |
| `failures`                        | failed task's kept output                       |
| `entries`                         | cached key                                      |
| `entry_inputs`                    | key, with its input components                  |
| `task_durations`, `task_outcomes` | what forecasts and flakiness read               |
| `lockfile_memos`                  | a lockfile plugin's parse, by file and claimant |

`SELECT name, sql FROM sqlite_schema` lists them all. Times are epoch
milliseconds.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">The tables</span></summary>
<div class="vx-deeper-body">

- `runs` holds status, duration, cache hit, cpu, peak and mean memory,
  attempts, timeout, skip and remote reasons, and where it ran.
- `runs` is a view (in `sqlite_temp_schema`) over the stored rows, which
  name their run by its `run_ids` row.
- `steps`: `run_id`, `seq`, `step`, `duration_ms`, `ok`.
- `warnings`: `run_id`, `seq`, `text`.
- `failures`: `run_id`, `task_id`, `dir`, `input_moved`, `output`,
  `locations`, `sandbox_fix`; the last two are JSON.
- History keeps every run until a bounded `vx cache clean` drops what is
  over 30 days old.
- `steps`, `warnings` and `failures` keep the newest 50 runs that had
  any.
- The tables are vx's own and change with `SCHEMA_VERSION`. Read
  `sqlite_schema` rather than assume.

</div>
</details>

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `WITH … SELECT` works too.
- `--format json`: `{ rows }`, one object per row keyed by column.
- The table prints every column, a name repeated by a join's `SELECT *`
  (`run_id`) too.
- `--format json` refuses a repeated name, since an object holds one
  value per key: name each with `AS`.
- `--sql=<query>`: a query that starts with `-` (an SQL comment) needs
  the `=` form. The space form reads it as a missing query.
- `--sql reads only` (exit 1): a write is refused.
- The query runs with SQLite's `query_only` on, so a `WITH` that hides a
  write fails too.
- Nothing else may lead the statement: `ATTACH` would make a file.
- A query SQLite cannot run is refused with its reason.
- A second statement after the first is refused: SQLite would run the
  first alone.
- `--sql` combines only with `--format` and `--cache-dir`.

</div>
</details>

### JSON

`--format json` emits `{ invocation, tasks, steps, warnings }` for
scripts. `--list --format json` prints an array of the same
`invocation` objects, newest first.

A failed task's row adds its output and the files it names, so an agent
reads why without the terminal.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every field</span></summary>
<div class="vx-deeper-body">

- `steps` and `warnings`: only when the run kept some.
- `dir`: the failed task's project folder from the root, `.` for the root.
  Relative paths in its output start there.
- `output`: its output as plain text, the first 8 KiB and last 56 KiB,
  secrets masked.
- `locations`: the existing files it names, `{ file, line?, col? }`,
  `file` absolute.
- `app.test.js:`: a file also named with a line drops its bare mention,
  such as bun test's header.
- `fixedIn`: the first later run where that task passed, so a replayed
  failure that is already fixed says so.
- `sandboxFix`: the `exec.sandbox.allow` entries (`read`, `write`,
  `network`, `systemInfo`) that would have granted its denials.
- `sandboxFix` holds the grants the terminal prints as `fix:`.
- `*.bun-build`, `.bun-pack.*.tmp`: a per-run temp name gets no grant.
  A hint line names its `ignore` glob.
- `withheld`: the credential paths it denied and left out, a `.env` file
  or a store under home the sandbox denies (`security.md`).
- `inputs`, cached tasks: the reads of its project no `inputs.files` glob
  matches. A directory whose contents a glob keys, such as `public` under
  `public/**`, is not named.
- `workspaceFiles`: its reads elsewhere in the workspace no
  `inputs.workspaceFiles` glob matches.
- Those two are the terminal's `and, if the output depends on them, …`
  lines.
- `inputMoved`: the input that changed during the run, for a task failed
  by `inputs.stability.severity: 'error'`.
- These live in cache.db's `failures` rows, the newest 50 failed runs.
- Past those, or when the write was refused, a failed row reads
  `output: ''` and `locations: []`.

</div>
</details>

### `--cache-dir`

`vx why`, `vx last`, `vx info` and `vx cache clean` read the cache a run
wrote. Each takes `--cache-dir <path>`, with `vx run`'s rules.

```sh
vx run build --cache-dir /tmp/vx-cache
vx last --cache-dir /tmp/vx-cache
```

Without the flag they open the workspace's cache:
`defineWorkspace({ cache: { dir } })`, else `.vx/cache`.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- A relative path is from the cwd; an absolute one is used as-is.
- A run that wrote its history elsewhere is shown, explained, reported
  on and pruned there.
- `--cache-dir .vx/cahce: no such directory` (`VX_E_USAGE`): a path that
  is not there, or is a file, is refused by name.
- A workspace that never ran: `vx why`, `vx last`, `vx info`, `vx show`
  and `vx cache clean` (dry or not) read it as empty and create nothing.

</div>
</details>

### Exit codes

| Code | When                                                                |
| ---- | ------------------------------------------------------------------- |
| `0`  | the run (or the list) printed, `--list` with no runs included       |
| `1`  | no recorded run yet, a run id it has no record of, or a parse error |

## `vx docs`

`vx docs <query>` searches the vx reference for this version and prints
the best sections.

```sh
vx docs VX_E_CYCLE
```

```ansi
[1m[38;2;6;182;212m── cli.md § VX_E_CYCLE · https://vznjs.github.io/vx/cli/#vx_e_cycle ──[0m
[38;2;6;182;212m│[0m #### `VX_E_CYCLE`
[38;2;6;182;212m│[0m
[38;2;6;182;212m│[0m The task graph has a cycle. The message names the loop; drop one of its
[38;2;6;182;212m│[0m `dependsOn` edges.
[38;2;6;182;212m│[0m `vx lock` refuses it, not a run: a run trusts the graph the lock holds.
```

The guides live on the site: `https://vznjs.github.io/vx/llms.txt`
indexes them.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- It reads every page of `packages/vx/docs` at this vx's release tag on
  GitHub (`v<version>`), online, each time. Nothing ships inside vx.
- A source checkout reads `main`.
- Each page is cut at its headings. A section that holds every word of
  the query matches.
- A word in a section's heading ranks it above any count in its text.
- `vx docs VX_E_CYCLE`: a one-word query that titles a section, such as
  an error code, prints that section alone.
- The best sections print whole, each under its page, heading and URL on
  the site.

</div>
</details>

### Options

| Option                  | Meaning                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `--limit N`             | how many sections print, best first (default 3)                                    |
| `--format pretty\|json` | `json` prints `{query, hits: [{page, heading, url, text}]}` for scripts and agents |

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `--format json` follows `schemas/docs.json`.
- Exit `0`: the search ran, a search with no match included. That one
  names the tag searched.
- Exit `1`, `VX_E_USAGE`: a missing query or a bad flag.
- Exit `1`, `VX_E_NETWORK`: the pages could not be read. It names the
  site.

</div>
</details>

Exit codes: `0` the search ran; `1` a missing query, a bad flag, or the
pages could not be read.

## `vx help`

`vx help` prints every verb's usage line and the run flags.
`vx help <verb>` prints that verb's usage and sections.

```sh
vx help lock
```

```ansi
[1m[38;2;6;182;212mvx[0m — task orchestration you own

[1mUsage[0m[1m:[0m
  [1m[38;2;6;182;212mvx lock[0m[38;2;34;211;238m [--check] [--format pretty|json][0m

[1mConfig lock[0m[1m:[0m
  [1m[38;2;6;182;212mvx lock[0m              Evaluate every vx.config in the current environment,
                       check the graph rules (run.rules) and freeze the resolved
                       objects into .vx/projects.lock, the only place a run
                       reads configs from. A run never evaluates one, never
                       checks the rules and never writes the lock: with none it
                       fails.
  [1m[38;2;6;182;212mvx lock[0m[38;2;34;211;238m --check[0m      Audit the lock: re-evaluate every config here and compare
                       it with the frozen object, find a config added or gone,
                       and check the graph rules. Exits 1 on drift (e.g. configs
                       that read env vars). Run it before the run in CI. With
                       --format json it prints {upToDate, audited, notAudited,
                       problems}.


Full reference: vx help
```

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `vx <verb> --help` and `-h` print the same as `vx help <verb>`.
- It paints only on a terminal, so a script that greps it reads plain
  text.
- On a terminal, an entry wider than the terminal or 80 columns refills
  at spaces, its lines under its description; a usage line's go under
  its verb.
- With under 20 columns beside its term, a description goes under the
  term instead. A word wider than the room stays whole on its own line.
- Piped, it prints as written.
- A plugin verb answers its own `--help`.

</div>
</details>

Exit codes: `0` the help printed; `1` a name that is no verb, with the nearest one when close.

## `vx version`

Prints the vx that runs (`vx --version` too):

```sh
vx version
```

```ansi
[1mvx[0m [38;2;6;182;212m0.0.0[0m
```

A source checkout prints `0.0.0`. [Which vx runs](#which-vx-runs) says which binary that is.

Exit codes: `0`.

## `vx completions`

`vx completions` prints a Tab-completion script for `bash`, `zsh` or
`fish`.

```sh
eval "$(vx completions bash)"                          # this shell
vx completions zsh > ~/.zfunc/_vx                      # zsh, with ~/.zfunc on $fpath
vx completions fish > ~/.config/fish/completions/vx.fish
```

It completes the verbs and every flag of each verb. After a flag that
takes a fixed set of values, it offers that set.

| After              | Tab offers                                 |
| ------------------ | ------------------------------------------ |
| `--format`         | `pretty`, `json`                           |
| `--output-logs`    | `full`, `errors-only`, `hash-only`, `none` |
| `--cache-download` | `all`, `toplevel`, `none`                  |
| `--schedule`       | its four rules                             |

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- Verbs: core's, and the plugin verbs the workspace around the cwd
  declares when you generate the script.
- Flags are read from the help `vx <verb> --help` prints: the verb's own
  Usage line.
- For `run` and `watch`, the run option lines too, less the ones `watch`
  refuses.
- So a flag cannot be documented and not completed, nor completed and
  then refused.
- `--check` in a line about `vx lock`: a flag another verb's line names
  in passing is not one.
- Each value offered is one the flag's parser takes
  (`tests/completions.test.ts`).
- A plugin verb completes `--help` only. `vx help` completes the verbs.
- Task and project names are not completed: they are the workspace's,
  and evaluating configs on every Tab costs too much.
- zsh from `$fpath`: it completes on the first Tab. Sourced, it registers
  itself.
- `tests/completions-shells.test.ts` loads the script in zsh both ways,
  and in fish, where they are installed.
- `got bsh). Did you mean bash?`: an unknown shell is an error naming
  the three, and the nearest within two edits.

</div>
</details>

Exit codes: `0` the script printed; `1` an unknown shell or flag.

## Plugin commands

A plugin declared in `.vx/workspace.ts` can add verbs:

```ts
import { definePlugin, type VxPlugin } from '@vzn/vx'

export function mcp(): VxPlugin {
  return definePlugin(import.meta, {
    commands: {
      mcp: {
        description: 'serve the run history to an AI agent over stdio',
        async run(argv, ctx) {
          // ctx.workspaceRoot, ctx.cacheDir, ctx.concurrency, ctx.cache, ctx.warn(...)
          return 0 // the process exit code
        },
      },
    },
  })
}
```

Then `vx mcp` runs it. `vx help` lists every plugin verb under "Plugin
commands", with the plugin's name. `@vzn/vx-history` adds `vx history`
this way.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- The plugin's name is its package name; `definePlugin` reads it from
  `import.meta`. A plain object is refused when the workspace loads.
- `ctx.cache` reads the plugin's own entries as `setup` writes them,
  read-only, opened on first use.
- It reads the local store, then each remote the workspace's cache
  plugins supply, under the run's scope.
- `vx history` prints what `@vzn/vx-history` learned per task and the
  reservation its `admit` hook packs.
- Core's verbs come first. Plugins are asked only for a word core does
  not know.
- To find them, vx loads the workspace config from the cwd. Outside a
  workspace the verb is unknown.
- A plugin verb that names a core verb is refused when the workspace
  loads: it could never run.
- A verb plugins of two packages both declare is refused too: one would
  hide the other.
- Plugins of one package are one owner: two of them may carry the same
  verb, and the first declared runs.
- The return value is the exit code, an integer 0–255.
- Anything else fails, naming the plugin and the verb: nothing, a
  fraction, or 256 (which the OS would keep as 0).
- A thrown `UserError` prints as cleanly as core's own.
- Anything else thrown fails in one line, no stack:
  `plugin '<p>' failed in command '<verb>': <msg>`.
- When `.vx/workspace.ts` fails to load, `vx help` lists no plugin verb
  and says why on stderr.

</div>
</details>

An unknown verb is answered with what this workspace knows: a guess from
core's verbs and the plugins' verbs.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- The failed lookup already loaded the plugins, so the guess costs
  nothing.
- With nothing close, a second line says where a verb can come from.
- That line names the verbs declared here, or says `.vx/workspace.ts`
  would declare one, or that there is no workspace here.
- Core names no package: it lists what the workspace itself declares.

</div>
</details>

## Environment variables vx reads

Every setting has a variable named from its path: `run.timeout` is
`VX_RUN_TIMEOUT`. The variable beats `.vx/workspace`; a flag beats the
variable.

```sh
VX_RUN_CONCURRENCY=4 vx run build --all
```

`docs/schema.md` § Settings gives each value's form and default.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- Each is checked once before any verb runs.
- An empty variable is unset.
- A value its kind does not take is refused, naming the form.
- A variable vx does not read is ignored, as is one whose flag is given:
  the flag beats it.
- A plugin's own variables (the REAPI endpoints, the GitHub token) are
  in its README.
- What a task sees is `exec.env` in `docs/schema.md`.

</div>
</details>

<!-- variables table: generated by tests/settings.test.ts -->

| Variable                          | Setting                                            | What it does                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VX_BASE_BRANCH`                  | [`baseBranch`](schema.md#settings)                 | The default branch: a run on it has no cache scope and a bare `--affected` no base; elsewhere both use the merge base with `origin/<baseBranch>`. Named alone: `main`, not `origin/main`.                                                                                                                                                                      |
| `VX_AFFECTED_BASE`                | [`affectedBase`](schema.md#settings)               | The commit a bare `--affected` compares with, on the base branch too. `--affected=<base>` beats it; it beats a plugin's base commit. Env only: a committed base would be stale on the next push.                                                                                                                                                               |
| `VX_RUN_CONCURRENCY`              | [`run.concurrency`](schema.md#settings)            | Tasks at once: a positive integer, or a share of the cores (`'50%'`).                                                                                                                                                                                                                                                                                          |
| `VX_RUN_SCHEDULE`                 | [`run.schedule`](schema.md#settings)               | Which ready task starts first when there are more than workers.                                                                                                                                                                                                                                                                                                |
| `VX_RUN_BRANCH`                   | [`run.branch`](schema.md#settings)                 | The branch a run records in its history and forecasts from. Flag and env only: a committed branch would be wrong on every other branch.                                                                                                                                                                                                                        |
| `VX_RUN_TIMEOUT`                  | [`run.timeout`](schema.md#settings)                | A task's time limit, for tasks without their own `exec.timeout` (`'30m'`).                                                                                                                                                                                                                                                                                     |
| `VX_RUN_RETRIES`                  | [`run.retries`](schema.md#settings)                | Re-runs of a failed task, for tasks without their own `exec.retries`.                                                                                                                                                                                                                                                                                          |
| `VX_RUN_FAIL_FAST`                | [`run.failFast`](schema.md#settings)               | Stop the run at the first failure, killing the tasks still running; off, a failure skips only its dependents.                                                                                                                                                                                                                                                  |
| `VX_RUN_OUTPUT_LOGS`              | [`run.outputLogs`](schema.md#settings)             | Which task output the run prints. Chosen before the workspace loads, so flag and env only.                                                                                                                                                                                                                                                                     |
| `VX_RUN_KILL_GRACE`               | [`run.killGrace`](schema.md#settings)              | How long a task, server or plugin's process may take to exit after SIGTERM (a timeout, a stop, the run's end) before vx sends SIGKILL.                                                                                                                                                                                                                         |
| `VX_RUN_PLUGIN_TIMEOUT`           | [`run.pluginTimeout`](schema.md#settings)          | How long one plugin's end-of-run flush or teardown may take before the run ends without it, and how long a remote cache download may wait for its answer or between its bytes before it is a miss; `'0ms'` waits for no flush or teardown not already done, and bounds no download.                                                                            |
| `VX_RUN_LOGS_CAPTURE_HEAD`        | [`run.logs.captureHead`](schema.md#settings)       | The start of a task's output vx keeps for its cache entry and replay; the live stream is never cut. Counted in characters.                                                                                                                                                                                                                                     |
| `VX_RUN_LOGS_CAPTURE_TAIL`        | [`run.logs.captureTail`](schema.md#settings)       | The end of a task's output vx keeps for its cache entry and replay. Counted in characters.                                                                                                                                                                                                                                                                     |
| `VX_RUN_LOGS_FAILED_HEAD`         | [`run.logs.failedHead`](schema.md#settings)        | The start of a failed attempt's output vx keeps when it stores that failure. Counted in characters.                                                                                                                                                                                                                                                            |
| `VX_RUN_LOGS_FAILED_TAIL`         | [`run.logs.failedTail`](schema.md#settings)        | The end of a failed attempt's output vx keeps when it stores that failure. Counted in characters.                                                                                                                                                                                                                                                              |
| `VX_RUN_SECRETS_MIN_LENGTH`       | [`run.secrets.minLength`](schema.md#settings)      | The shortest secret value vx masks in output; a shorter one (`KEY=1`) would mask every match in every line.                                                                                                                                                                                                                                                    |
| `VX_RUN_RULES_EXCLUSIVE_OUTPUTS`  | [`run.rules.exclusiveOutputs`](schema.md#settings) | Refuse two tasks whose outputs overlap even when an edge orders them.                                                                                                                                                                                                                                                                                          |
| `VX_CACHE_DIR`                    | [`cache.dir`](schema.md#settings)                  | Where the cache lives, relative to the workspace root; named, it holds the whole cache.                                                                                                                                                                                                                                                                        |
| `VX_CACHE_POLICY`                 | [`cache.policy`](schema.md#settings)               | Which layers a run reads and writes (`'local:rw,remote:r'`); `--no-cache` and `--force` apply on top.                                                                                                                                                                                                                                                          |
| `VX_CACHE_SCOPE`                  | [`cache.scope`](schema.md#settings)                | The branch scope plugin entries are keyed under (`'vznjs/vx:feat-x'`); task keys never carry it. Empty: no scope.                                                                                                                                                                                                                                              |
| `VX_CACHE_CONCURRENCY_DOWNLOAD`   | [`cache.concurrency.download`](schema.md#settings) | Remote downloads at once.                                                                                                                                                                                                                                                                                                                                      |
| `VX_CACHE_CONCURRENCY_UPLOAD`     | [`cache.concurrency.upload`](schema.md#settings)   | Uploads at once, per remote.                                                                                                                                                                                                                                                                                                                                   |
| `VX_CACHE_CONCURRENCY_RESTORE`    | [`cache.concurrency.restore`](schema.md#settings)  | Local hits restoring outputs at once.                                                                                                                                                                                                                                                                                                                          |
| `VX_CACHE_DOWNLOAD`               | [`cache.download`](schema.md#settings)             | Which remote hits land on disk: every one, only the requested tasks, or none.                                                                                                                                                                                                                                                                                  |
| `VX_INPUTS_STABILITY_STRATEGY`    | [`inputs.stability.strategy`](schema.md#settings)  | What a write to an input during the command means for the save, for tasks without their own.                                                                                                                                                                                                                                                                   |
| `VX_INPUTS_STABILITY_SEVERITY`    | [`inputs.stability.severity`](schema.md#settings)  | Whether a skipped save warns or fails the task, for tasks without their own.                                                                                                                                                                                                                                                                                   |
| `VX_CACHE_STORE_EMBEDDINGS`       | [`cache.store.embeddings`](schema.md#settings)     | Keep an entry up to this size inside the cache index, one zstd tar, rather than as files; `false` keeps none.                                                                                                                                                                                                                                                  |
| `VX_CACHE_STORE_DECOMPRESS`       | [`cache.store.decompress`](schema.md#settings)     | Keep a larger entry as its plain files, which a hit copies or clones out; off, as one `.tar.zst`.                                                                                                                                                                                                                                                              |
| `VX_CACHE_ARTIFACT_CEILING`       | [`cache.artifactCeiling`](schema.md#settings)      | The largest entry, unpacked, a remote stores or a hit unpacks; a larger one stays on this machine. A remote hit past it is a miss, so every machine sharing a remote needs the same value.                                                                                                                                                                     |
| `VX_HISTORY_RETENTION`            | [`history.retention`](schema.md#settings)          | `vx cache clean` drops run history and hash memos older than this.                                                                                                                                                                                                                                                                                             |
| `VX_LOCK_REVIEW_FILES`            | [`lock.reviewFiles`](schema.md#settings)           | `vx lock` writes each project's resolved config, pretty, to `vx.lock.json` beside its `vx.config`, for review; vx never reads it.                                                                                                                                                                                                                              |
| `VX_WATCH_POLL`                   | [`watch.poll`](schema.md#settings)                 | Poll for changes from the start instead of the OS watcher.                                                                                                                                                                                                                                                                                                     |
| `VX_WATCH_DEBOUNCE`               | [`watch.debounce`](schema.md#settings)             | `vx watch` waits this long after the last change before it re-runs (at most 1 s after the first).                                                                                                                                                                                                                                                              |
| `VX_WATCH_POLL_INTERVAL`          | [`watch.pollInterval`](schema.md#settings)         | How often a polling `vx watch` re-walks a watched tree.                                                                                                                                                                                                                                                                                                        |
| `VX_CONFIG_WORKER_TIMEOUT`        | [`config.workerTimeout`](schema.md#settings)       | How long one config evaluation may await; at 5 s vx names the config still evaluating. A synchronous loop on the first load holds the thread the deadline needs, so it hangs until killed.                                                                                                                                                                     |
| `VX_DEBUG_TIMING`                 | [`debug.timing`](schema.md#settings)               | Print the run's stage timings to stderr.                                                                                                                                                                                                                                                                                                                       |
| `VX_DEBUG_WATCH`                  | [`debug.watch`](schema.md#settings)                | `vx watch`: say on stderr each time the loop arms, with the projects it watches.                                                                                                                                                                                                                                                                               |
| `VX_DEBUG_DUMPABLE`               | [`debug.dumpable`](schema.md#settings)             | Linux: keep vx dumpable, so strace or a debugger can read its memory and `/proc/<pid>/fd`, and an unsandboxed task its env.                                                                                                                                                                                                                                    |
| `VX_DEBUG_STRACE`                 | [`debug.strace`](schema.md#settings)               | Linux: report a sandboxed task's refused reads with strace, not vx's own observer.                                                                                                                                                                                                                                                                             |
| `VX_HANDED_OFF`                   | —                                                  | Set by a global vx that hands the call to the project's own (§ Which vx runs): the path of the vx that handed off, so the receiver does not hand off again.                                                                                                                                                                                                    |
| `VX_SIGNAL_RELAY`                 | —                                                  | Set to `1` by a parent that relays stop signals (the Node launcher, a handing-off vx): a group stop's copy is the same stop, not a second one. vx removes it at start.                                                                                                                                                                                         |
| `VX_JIT_TIERED`                   | —                                                  | Set to `1` with `BUN_JSC_useFTLJIT=false` by the npm launcher, or by a compiled vx restarting a run in a workspace whose `.vx/projects.lock` is 128 KiB or more (a smaller run ends before that tier pays back its restart), to turn JSC's top JIT tier off (its compiles never paid back within a run). vx removes both at start; one the user set is theirs. |
| `VX_IGNORED_SIGNALS`              | —                                                  | Set by a global vx that hands off when it was started with SIGINT or SIGHUP ignored (`vx run build &` in a script, nohup): those names, comma-separated, so the local vx keeps them ignored. vx removes it at start.                                                                                                                                           |
| `VX_RUN_WORKSPACE`, `VX_RUN_TASK` | —                                                  | Set by vx on every task (below); a `vx run` a task starts reads them back.                                                                                                                                                                                                                                                                                     |

<!-- /variables table -->

vx sets three variables on every task it starts:

| Variable           | Holds                  |
| ------------------ | ---------------------- |
| `VX_RUN_WORKSPACE` | the workspace root     |
| `VX_RUN_TASK`      | `project#task`         |
| `VX_RUN_TREE`      | a token for each spawn |

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- A `vx run`, `vx pipeline` or `vx watch` a task starts reads the first
  two back.
- One in the same workspace is refused, naming the verb
  (`docs/schema.md` § `env`).
- A nested run is invisible to the outer graph, and a loop back to its
  own task forks without bound.
- A stop (Ctrl-C, `--fail-fast`, a server's end) signals every process
  that holds the task's `VX_RUN_TREE`.
- So a daemon that left the task's process group with `setsid` stops too
  (`docs/execution.md`).

</div>
</details>

Colors follow `NO_COLOR` and `FORCE_COLOR` (§ Output format › Colors),
and a CI turns them on.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Other variables vx reads</span></summary>
<div class="vx-deeper-body">

- A CI (§ Output format › Colors): the CI output flow and remote cache
  writes. `GITHUB_ACTIONS`: its `::group::` framing (§ Output).
- The run's `invocations` row records the CI provider, the first that is
  on: `GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`, `CIRCLECI`, `TF_BUILD`,
  `JENKINS_URL`, `TEAMCITY_VERSION`, then `CI`.
- They record as `azure`, `jenkins`, `teamcity` and `generic` for the last four.
- `GITHUB_STEP_SUMMARY`: core never reads it. The job summary is
  `@vzn/vx-ci`'s.
- A sandboxed task's temp dir sits under `CLAUDE_CODE_TMPDIR`, else
  `CLAUDE_TMPDIR`, else `/tmp/claude`: the sandbox runtime's convention.
- See `docs/modules/exec.md` for that temp dir.
- That variable and `TMPDIR` hold sockets whose paths pass unquoted
  through a shell.
- So a sandboxed task is refused unless each is an absolute path of ASCII
  letters, digits and `. _ - / + @`.

</div>
</details>

## Output format

`vx run` prints each task's output in a framed block when the task ends.
Two tasks that run at once never mix their lines.

A lone requested task streams live instead (§ Output).

Frame anatomy:

```ansi
[2m┌─[0m [1m[38;2;244;114;182m@demo/web[0m[2m#[0m[1m[38;2;96;165;250mtest[0m [2m>[0m [1m[38;2;239;68;68mfailed (exit 1, 1 sandbox violation)[0m

[2mpackages/web $ vitest run[0m

[2m├─[0m [1mOUTPUT[0m [2m────────────────────────────────────────────────────[0m

 × renders 3ms
[38;2;239;68;68mError: EROFS: read-only file system, open 'notes.txt'[0m
 Tests  1 failed (1)

[2m├─[0m [1m[38;2;239;68;68mSANDBOX VIOLATIONS (1)[0m [2m────────────────────────────────────[0m

openat(/work/demo/packages/web/notes.txt) = a write no grant covers

[2m└─[0m [1m[38;2;244;114;182m@demo/web[0m[2m#[0m[1m[38;2;96;165;250mtest[0m [2m──[0m [2m(2.10s)[0m [1m[38;2;239;68;68mfailed (exit 1, 1 sandbox violation)[0m
```

| Part                     | Shows                                       |
| ------------------------ | ------------------------------------------- |
| header `┌─`              | the task id and its outcome                 |
| `packages/web $ …`       | the command, after the folder it ran in     |
| `OUTPUT`                 | what the task printed                       |
| `SANDBOX VIOLATIONS (N)` | what the sandbox refused, `N` of them       |
| footer `└─`              | the task id, its time and its outcome again |

Each part shows only when it has something to say. Content lines are
raw: no left border, no indent, so long lines wrap cleanly and
copy/paste yields the verbatim output.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">The frame</span></summary>
<div class="vx-deeper-body">

- The `$ <command>` line shows only for an executed task, success or
  failed.
- A hit replays its stored output and shows no command line. Except: a
  task you asked for in the focused flow shows it, run or not.
- The folder is from the workspace root; none for a project at the root.
- `src/index.ts` in a task's output is `packages/web/src/index.ts`: a
  task names paths from its own folder, as a shell prompt would show.
- `OUTPUT` shows only when the task wrote something.
- `SANDBOX` (no count) shows when vx has only a note on a failure.
- Outcomes in the header: `restored-local • abc12345`, `failed (exit N)`,
  …
- A test renders this block and checks it against this page, byte for
  byte.
- Corners and rules render dim. Section labels (`├─ …`) render bold in
  their state colour. The id keeps its own colours.
- Every block, and every live frame close in the focused flow, is
  followed by a blank line, so frames never touch the next line.
- A persistent task's frame has a cyan `▸` after `┌─`/`└─`.
- Its close reads `running` (the child is still alive), or `success` for
  a setup step ready by its exit 0.
- Or `stopped` for the block of what it wrote since ready, when vx had
  stopped it before that block printed.
- Or `failed (exit <n>)` for a server that died on its own before the run
  stopped it.

</div>
</details>

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">OUTPUT order and colour</span></summary>
<div class="vx-deeper-body">

- `OUTPUT` holds what the task wrote in the order vx read it, so an error
  stays beside the test that printed it.
- A stderr line renders red when colour is on.
- A line the task coloured itself keeps its own colours. A line takes the
  stream that began it.
- Without colour, the lines are the task's bytes.
- stdout and stderr are two pipes, so lines written in the same instant
  may read stdout first. A cache hit replays the same order.
- `STDOUT (since ready)`, `STDERR (since ready)`: a persistent task's
  tail after ready keeps the two apart. Its bounded tails hold no order.

</div>
</details>

### The footer

There is **no top-of-run banner**: the run's context lives in the
footer. A broad run looks like this; a hit gets no row, only its count in the
footer:

```ansi

[4m[58;2;110;118;129m  [1m[38;2;167;139;250mTasks[0m[4m[58;2;110;118;129m     [2mstatus  cache     ±usual    time   cpu    mem outputs  blocks worker         task[0m[4m[58;2;110;118;129m                           [0m
            [38;2;34;197;94msuccess[0m [2mmiss[0m           [2m—[0m   [38;2;203;213;225m5.20s[0m     [2m—[0m      [2m—[0m       [2m—[0m       [2m—[0m [2mlocal[0m          [38;2;192;132;252m@vzn/vx[0m[2m#[0m[38;2;96;165;250mtest[0m


[4m[58;2;110;118;129m  [1m[38;2;167;139;250mSummary[0m[4m[58;2;110;118;129m                                                                                                       [2mvx 0.0.0[0m
  [2mprojects[0m  [38;2;234;179;8m▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰[0m[2m▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱[0m
            [38;2;234;179;8m1 in run[0m [2m·[0m [2m3 total[0m
  [2mtasks   [0m  [38;2;34;197;94m▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰[0m
            [38;2;34;197;94m2 success[0m [2m·[0m [2m2 total[0m
  [2mcache   [0m  [38;2;56;189;248m▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰[0m[38;2;56;189;248m▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰[0m
            [2mlocal[0m [38;2;56;189;248m1↓[0m [38;2;56;189;248m1↑[0m

  [2minfo    [0m  8 workers [2m·[0m local cache [2m·[0m run 01a14941-c8cf-7a3e-9b51-2f06d4e8c713
  [2mtime    [0m  5.34s
```

The task log opens with one blank line before its first row. A note vx
prints before it is not part of it.

| Row        | Shows                                              |
| ---------- | -------------------------------------------------- |
| `projects` | what the run covered, against the whole workspace  |
| `tasks`    | failed, success and skipped                        |
| `cache`    | each task's cache state, per layer                 |
| `warn`     | how many warnings the run printed, when any        |
| `info`     | workers, cache layers and the run id               |
| `time`     | the wall time, then the spread over executed tasks |

The `cache` legend reads per layer: `local 1✓ 1∅ 2↓ 1↑ · remote 3↓ 4↑ 2✗ 1⇡`.

| Mark | Means                                            |
| ---- | ------------------------------------------------ |
| `✓`  | a fresh hit: outputs already on disk             |
| `∅`  | a task with no cache                             |
| `↓`  | restored from that layer                         |
| `↑`  | saved to that layer                              |
| `✗`  | a remote read or write failed for the task       |
| `⇡`  | an upload still running (live only, always last) |

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">The bars and legends</span></summary>
<div class="vx-deeper-body">

- The `cache` bar has a segment per legend state. A skipped task rides
  it too, yellow, and a hit whose restore failed red, so the two bars
  fill alike.
- Those two counts are on the tasks legend only: a failed restore is no
  miss and no `↓`.
- `✓` means the local cache answered. A remote hit is never fresh,
  outputs or none: it is `↓` from the remote.
- `✗` is not a remote the run turned off (a refused token, no answer).
  That is the run's, on the `warn` row, and its tasks count as the others.
- `tasks     1 failed · 3 success · 4 total`: a pipe with no colour (an
  agent's shell) gets no bars, only each row's legend.
- The region stays through vx's closing steps, worker rows gone. The
  final footer replaces it in place.
- Each task counts once, under its strongest state, in this order.
- A failed remote read or write, an upload running, saved to a remote,
  saved here, restored, fresh, no cache.
- So a task saved here and uploaded is a remote `↑`.
- A key the remote already held is not sent, so it is no remote `↑`.
- Unless the run writes no local cache: then the remote holding it is
  the save, a remote `↑`.
- Colours: `✓` green, `∅` dim, local blue, remote dark blue, `✗` and a
  miss red, `⇡` cyan. The `local` and `remote` words are dim.
- Each count is painted in its segment's colour, number and glyph alike.
- A layer shows only when the run's `--cache-policy` uses it.
- `N miss`, red: ran and saved nothing (it failed, or ran elsewhere).
- `N not saved`, yellow: ran, succeeded, saved nothing. Each is its own
  segment.
- `N not downloaded`: outputs left in the remote store.
- Every count shows only when non-zero.
- `1 no-cache` (as for `vx run dev`): a task with no `cache: true`, or
  any task of a run whose `--cache-policy` reads and writes nothing.
- Such a task could never hit, so it is counted apart, as `--dry` labels
  it.

</div>
</details>

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">The warn, info and time rows</span></summary>
<div class="vx-deeper-body">

- `vx last` names each remote failure on its task's row.
- `@demo/web#build · small#2`: a task an executor plugin ran elsewhere
  says where, last on its row and after the id on its frame.
- That plugin may add rows of its own above `info` (`workers`). Then
  `info` names no worker pool.
- `N warnings above`, yellow, above `info`: the run warned (a remote's
  403, a plugin's failed flush). Each distinct warning counts once.
- The warnings themselves are said once, where they happened.
- `info` ends with `run <id>`: the run's whole id, as `vx last <id>`
  takes it.
- A run a Ctrl-C (or SIGTERM, SIGHUP) stopped before any task ended
  keeps nothing, so its footer names no id.
- `time` is the wall time from when the run asks for the workspace's run
  lock (a wait for another run counts) through the uploads and the
  telemetry flush it waits on. `vx last` keeps the same.
- Telemetry's own summary, sent before its flush, counts the uploads but
  not that flush.
- The spread covers executed tasks only: a hit's restore time never
  enters it.
- The footer never says a fact twice. One executed task shows no spread:
  its value is already on the row.
- There is no closing `result` row repeating the tasks, cache and time
  rows.
- A test renders this run and checks it against this page, byte for
  byte.

</div>
</details>

Group tasks print no framed block: they are not real tasks. Running a
group focused shows its member tasks instead.

**Nothing below the footer.** The footer is the run's last word. Only a
kept server's own output follows it.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- What a run says about one task rides that task's row.
- What it says about the run prints above the footer: a server that
  died, outputs left remote, a file `--profile` wrote.
- Also above it: a history, upload, plugin or sandbox warning.
- It prints once the run's closing work is done, the `VX_DEBUG_TIMING=1`
  table included.

</div>
</details>

**Narrow terminals.** The footer is 62 columns: a 12-column gutter and
50-cell bars. On a narrower terminal the bars and a frame's section
rules shrink, so none wraps, down to 13 columns.

Off a terminal they keep their width.

**Warnings on stderr.** A run's warnings go to stderr, such as
`[vx] @demo/web#build: inputs matched no files …` or a plugin's.
Stdout carries only the rows, frames and footer.

```sh
vx run build > log.txt      # the log holds no warnings
```

**Skipped rows.** A red run lists every task that never started, with
the failure that blocked it. So the footer's `1 skipped` always has a
name above it:

```ansi
            [38;2;239;68;68mfailed[0m  [2mmiss[0m       [2m−33ms[0m   [38;2;203;213;225m157ms[0m  [2m109%[0m  [2m106MB[0m      [2m0B[0m       [38;2;203;213;225m1[0m [2mlocal[0m          [38;2;192;132;252m@demo/ui[0m[2m#[0m[38;2;244;114;182mbuild[0m
            [38;2;234;179;8mskipped[0m [2m—[0m              [2m—[0m       [2m—[0m     [2m—[0m      [2m—[0m       [2m—[0m       [2m0[0m [2m—[0m              [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;244;114;182mbuild[0m [2m• blocked by @demo/ui#build[0m
```

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- A skip's cause is followed through a chain of skips to the failure at
  its root.
- A dependency a stop or `--fail-fast` killed is a root too: the skip
  names it (`blocked by @demo/ui#build`), not the failure that stopped the run.
- A skip with no failed or aborted upstream is fail-fast's and carries no suffix.
- A blocked group (a task with no command) has no row. It never starts,
  and no counter counts it.

</div>
</details>

**Aborted and not-run rows.** A stop (Ctrl-C, a shutdown signal) keeps
the live view. Each running row reads `aborting` until its task exits.

Then the list names what the stop cut short and what never started:

```ansi
            [38;2;249;115;22maborted[0m [2m—[0m              [2m—[0m     [38;2;203;213;225m9ms[0m     [2m—[0m      [2m—[0m       [2m—[0m       [38;2;203;213;225m2[0m [2mlocal[0m          [38;2;192;132;252m@demo/ui[0m[2m#[0m[38;2;244;114;182mbuild[0m
            [2mnot run[0m [2m—[0m              [2m—[0m       [2m—[0m     [2m—[0m      [2m—[0m       [2m—[0m       [2m0[0m [2m—[0m              [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;244;114;182mbuild[0m
            [2mnot run[0m [2m—[0m              [2m—[0m       [2m—[0m     [2m—[0m      [2m—[0m       [2m—[0m       [2m0[0m [2m—[0m              [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;96;165;250mtest[0m
            [38;2;249;115;22maborted[0m [2m—[0m              [2m—[0m    [38;2;203;213;225m14ms[0m     [2m—[0m      [2m—[0m       [2m—[0m       [2m0[0m [2mlocal[0m          [38;2;192;132;252m@demo/ui[0m[2m#[0m[38;2;96;165;250mtest[0m
```

Neither `aborted` nor `not run` reached the cache.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `aborting` keeps its timer. `aborted` shows its time so far.
- In the task list view (`--all`, a filter), what an aborted task printed
  before the stop is framed above the summary, as a failure's is.
- `2 success · 1 aborted · 2 not run · 5 total`: the tasks legend counts
  them as they land, each state its own segment.
- While the run goes, it also counts the tasks running now, then those an
  executor holds for a machine.
- Then those an unfinished dependency holds back, each a dim segment, and
  how many are left, those included.
- `30 success · 4 running · 12 scheduled · 16 blocked · 32 left · 62 total`:
  the live legend.
- The summary then replaces the live view. The total is always last on
  its line.
- A framed task (focused or `full`) that printed while it stopped shows
  its frame instead of a row.
- One whose frame opened before the stop reached its command (a slow
  `inputs.runtime` probe) closes it `not run`.

</div>
</details>

**Flaky rows.** A task this run proved flaky says so in a dim note
on its row and its frame's footer. vx learns it from the local run
history alone:

```ansi
            [38;2;239;68;68mfailed[0m  [2mmiss[0m      [38;2;239;68;68m+181ms[0m   [38;2;203;213;225m971ms[0m   [2m55%[0m  [2m132MB[0m       [2m—[0m       [2m0[0m [2mlocal[0m          [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;96;165;250mtest[0m [2mflaky - passed 2× before · 2 attempts[0m
            [38;2;34;197;94msuccess[0m [2mmiss[0m      [2m+124ms[0m   [38;2;203;213;225m914ms[0m   [2m60%[0m  [2m132MB[0m      [2m0B[0m       [2m0[0m [2mlocal[0m          [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;96;165;250mtest[0m [2mflaky - failed 1× before · 2 attempts[0m
```

A task is flaky when the same cache key failed after it had passed, or
when it passed only on a retry in this run.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- This run counts. A cache hit is a pass: it replayed one.
- A retry: `exec.retries` or `--retries`.
- A failure on a key that never passed is a break, with no note. Every
  retry of it failed too.
- A changed input that fails is what a red run usually means.
- The first pass after only failures is a recovery (a missing tool
  installed), not a flake.
- "After" is when each task started, not when a worktree sharing the
  record wrote it.
- Only tasks with `cache: true` are judged: "same inputs, red after
  green" is a claim only declared inputs can back.
- A task without them keys on its config alone. If it needed a retry,
  its row says only `2 attempts`.
- It is judged as the task finishes, so the row carries it.
- Cost: zero for a hit or a skip; one probe of the failed-row index for a
  green miss.
- `vx info` keeps the standing list.

</div>
</details>

### Colors

ANSI truecolor (`ansi-16m`) sequences, gated by env:

| Var                          | Effect                                                    |
| ---------------------------- | --------------------------------------------------------- |
| `NO_COLOR=…` (non-empty)     | Force off. Overrides `FORCE_COLOR`.                       |
| `FORCE_COLOR=0` / `=false`   | Force off, on a TTY too.                                  |
| `FORCE_COLOR=…` (any other)  | Force on — `1`, `true`, `2`, `3`, the empty string, etc.  |
| `CLICOLOR_FORCE=…` (not `0`) | Force on, below the two above.                            |
| a CI (none of the above)     | On, though the output is a pipe; beats `TERM=dumb`.       |
| (none of these)              | On iff `stdout.isTTY` and not `TERM=dumb`.                |
| `TERM=dumb`                  | No live region; plain unless a row above turns colour on. |

Every task gets `FORCE_COLOR=1`, so tools colour their output into vx's
pipe. Where vx's own output is plain, it strips the colours again.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- stdout and stderr decide apart. Warnings go to stderr and follow its
  terminal.
- `vx run 2> warn.log` writes no escapes to the file
  (`tests/warnings-stderr.test.ts`).
- A CI is `CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`, `CIRCLECI`,
  `TF_BUILD`, `JENKINS_URL` or `TEAMCITY_VERSION`.
- Set to anything but empty, `0`, `false`, `no` or `off` (any case). A CI
  log gets the terminal's colours, the CI output flow and remote cache writes.
- A viewer that shows raw escapes turns them off with `NO_COLOR`.
- `FORCE_COLOR=0` and `=false` mean off, as supports-color, chalk and
  Node read them.
- `NO_COLOR=` (empty) has no effect (no-color.org).
- vx sets no `FORCE_COLOR` on a task that already sees one (any value,
  `0` included) or a non-empty `NO_COLOR`.
- The cache stores the coloured bytes.
- Plain vx output: a pipe off CI, `NO_COLOR`, `FORCE_COLOR=0`. Escapes
  are stripped from task output then, live and replayed alike.
- Coloured vx output (a terminal, CI, `FORCE_COLOR`): a task keeps only
  its colours, OSC 8 links and redraws of its own line.
- Its cursor moves, screen erases, modes, titles and clipboard writes are
  dropped: they never rewrite vx's lines or outlive the run.
- An escape cut across two chunks is stripped too.
- `\e]0;title` with no terminator: an unterminated string escape ends at
  its line, so it never swallows the lines after it.
- Pinned by `tests/plain-output.test.ts`, `tests/terminal-output.test.ts` and
  `tests/cli-colors-e2e.test.ts`.
- `env: { define: { FORCE_COLOR: '0' } }`: a task that writes its output
  to a file and wants it plain.
- A custom `log` passed to `run()` gets task output as written, and
  always sees plain text.
- Every verb's own output follows the table: a run, `vx watch`, `show`,
  `info`, `why`, `last`, a `--dry` plan and `cache clean`.
- Help colours: headings bold, `vx <verb>` and each flag or example in
  cyan. `NO_COLOR` or `FORCE_COLOR=0` turns it off.
- See `tests/help-colors.test.ts`.
- Help is the exception: off a terminal it is plain whatever forces
  colour, so a script that greps it still parses it
  (`tests/cli-colors-e2e.test.ts`).
- Colour off (`NO_COLOR`, `FORCE_COLOR=0`) is colour only: on a terminal
  the live region still redraws. `TERM=dumb` turns both off.
- `TERM` unset counts as a terminal that can paint and redraw.
- `FORCE_COLOR=1`, `2` and `3` all mean on: vx writes truecolor
  whatever the level, and does not read `COLORTERM`.
- vx writes UTF-8 whatever the locale says: `LANG=C` still gets its box
  lines and glyphs (`─`, `▰`, `…`).
- On CI the run prints no live region, on a terminal too.

</div>
</details>

### Shared by every verb

Two runs on one workspace take turns. The second waits for the first and,
after a second, says so:

```text
[vx] waiting for another vx run (pid N) on this workspace to finish…
```

A path vx cannot write, or a full disk, ends any verb with one line that
names the path, never a stack.

```text
vx: EACCES: permission denied, open '…/.vx/projects.lock' — a path vx must write is not writable by this user
```

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- The line names `a vx watch cycle` or `a vx cache clean` when one of
  those holds the lock.
- The waiting line is a status line. The footer does not count it as a
  warning (caching.md § Concurrent runs).
- The run lock lives in this user's own folder in the temp directory.
- So two runs take turns only when one user runs both with the same
  `TMPDIR`. A `nix develop` shell sets its own.
- `EACCES`, `EPERM`, `EROFS`: a read-only checkout, another user's files.
  Exit 1.
- `ENOSPC`, `EDQUOT`: `— the disk that path is on is full`. Exit 1.
- A cache index the full disk will not let SQLite make says the same:
  `the cache index <path> could not be opened (database or disk is full)`.
- A cache index another process holds locked past 5 s: `the cache index
<path> is locked: another process held it past 5s`. Exit 1.
- `scandir`, `stat`, `lstat` refused: a read, so `— a path vx must read
is not readable by this user`.
- Inside a run, the task's line says the same.
- `EMFILE`, `ENFILE`: out of file descriptors. macOS starts a shell at 256.
- That exits 1 with the error and `— the process is out of file
descriptors; raise the limit (ulimit -n 4096) and re-run`.

</div>
</details>

## Remote cache (plugin-driven)

Core ships no remote-cache client: a remote cache is a plugin. A
`cache` plugin returns a client (a `RemoteCacheLayer`) and core layers
it over the local cache.

For example, `vxCache()` from `@vzn/vx-cache` in `.vx/workspace.ts`'s
`plugins`; its README shows the options.

Reads try the local cache first, then the remote. Writes go to the local
cache at once and upload in the background. A remote failure warns and
never fails the build.

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- A remote hit fills the local cache too.
- A background prefetch overlaps remote GETs with running tasks.
- Uploads drain at the end of the run.
- `@vzn/vx-reapi` is a client for any remote-execution API (REAPI)
  server: ActionCache + CAS.
- Any other server (S3-direct, …): implement `RemoteCacheLayer` in a
  plugin's `cache` capability. The plugins guide has the recipe.
- `RunOptions.remoteCache`: an embedder holding a client can inject it
  per run. That beats the plugins.
- No CLI flag carries remote-cache credentials. The plugin that brings
  the remote owns its own configuration.
- Every flag the CLI documents has shipped, `--output-logs hash-only`,
  `--fail-fast` and `--cache-dir <path>` among them.

</div>
</details>

## Run analytics

`vx info` shows the cache totals: entry count, size, runs and hits in
the last 24 h. For more, query the history: `cache.db` is a SQLite file
and is the API.

```sh
sqlite3 .vx/cache/cache.db "
  SELECT project, task, status, duration_ms
  FROM runs
  WHERE run_id = (SELECT run_id FROM runs ORDER BY id DESC LIMIT 1)
  ORDER BY duration_ms DESC;
"
```

`vx last --sql` runs the same queries without `sqlite3`. The schema is in
[`caching.md` § SQLite tables](./caching.md#sqlite-tables).

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `runs`: one row per task, with a UUIDv7 `run_id`, hrtime wall-clock
  spans, `cpu_ms`, peak RSS, status and a cache-hit flag.
- `invocations`: one header row per run, with the command, git and CI
  context, and counts.

</div>
</details>

## Programmatic API

```ts
import { run, planRun, defineProject, defineWorkspace } from '@vzn/vx'

const summary = await run({
  cwd: process.cwd(),
  tasks: ['build', 'test'],
  concurrency: 4,
  // Optional 4-axis cache control; omit for everything-on.
  cache: { localRead: true, localWrite: true, remoteRead: true, remoteWrite: true },
})
// summary.ok: boolean; summary.outcomes: TaskOutcome[]

const plan = await planRun({
  cwd: process.cwd(),
  tasks: ['build'],
})
// plan.tasks: PlannedTask[]
```

| Function                           | Does                                                                |
| ---------------------------------- | ------------------------------------------------------------------- |
| `run(options)`                     | runs the tasks; returns `Promise<RunSummary>`                       |
| `planRun(options)`                 | predicts, runs nothing; returns `Promise<RunPlan>`; `--dry` uses it |
| `prepareRun(options, log)`         | the shared setup: discovery, configs, graph, cache                  |
| `defineProject`, `defineWorkspace` | identity helpers that type your configs                             |

<details class="vx-deeper" data-level="3">
<summary><span class="vx-deeper-badge vx-deeper-details">Details</span> <span class="vx-deeper-title">Every rule</span></summary>
<div class="vx-deeper-body">

- `prepareRun` is what an embedder builds on.
- Each of the three returns a type the package exports: `RunOptions` /
  `RunSummary` / `TaskOutcome`, `RunPlan` / `PlannedTask`, `PreparedRun`.
- The plugin types are exported too: `VxPlugin`, `TaskExecutor`,
  `CacheLayer`.
- So are the telemetry types: `TelemetrySink`, `RunSummaryRecord`. See
  `src/index.ts`.
- `log: Logger`: swap the default framed-block logger for your own, such
  as JSON lines.
- A custom logger always sees plain text: colours are off when you pass
  one.
- The CLI dispatcher (`run(argv)` in `src/cli/index.ts`) is not exported;
  `bin.ts` calls it directly.

</div>
</details>
