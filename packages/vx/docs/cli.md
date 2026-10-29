# CLI reference

Every `vx` command, flag and output. Each verb has a section below.

```sh
# The prebuilt standalone binary; inside a project
# that installs @vzn/vx, it runs that one (§ Which vx runs):
bun add -g @vzn/vx

# From source (Bun ≥ 1.4.4):
bun src/bin.ts --version
```

On a Bun older than 1.4.4, vx still runs, and `vx info`'s `bun` row
warns. What breaks is the output, not the start:

- a large `--format json` write is cut off;
- no task reports what it used;
- a config syntax error shows as an internal error.

The released binary carries its own Bun, so the row never warns there.
[`modules/util-bun-version.md`](./modules/util-bun-version.md) has the
measurements.

## Top-level shape

```sh
# Core
vx run [OPTIONS] [TASK | PKG#TASK ...] [-- forwarded-args...]
vx watch [OPTIONS] [--poll] TASK [-- forwarded-args...]
vx cache clean [--older-than <duration>] [--max-size <size>] [--global] [--dry] [--format pretty|json] [--cache-dir <path>]
vx lock [--check] [--format pretty|json]
vx init [--dry [--format pretty|json]] [--force] [--mjs] [--native|--keep] [--plugin <hook>]
vx show [PROJECT[#TASK] | TASK] [--filter <pattern>] [--affected[=<ref>]] [--format pretty|json]
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

Each verb's lines are the usage lines `vx <verb> --help` prints, word
for word (`tests/cli-help-synopsis.test.ts`); the flags a verb accepts
are read from that line.

Several tasks run as one graph: `vx run build lint test` runs all
three across the selected projects.

- `pkg#task` names one project's task.
- A bare name runs in the cwd project, or wherever `--all`, `--filter`
  or `--affected` points.

The cwd project is the deepest project holding the directory, one
reached through a link (`packages/b -> ../ext/b`) included.

**Every requested name must resolve.** When a name matches no project
in scope, the run and `--dry` both refuse, exit 1, and print to stderr:
`vx run: no projects declare task(s): <name>.`

The refusal adds what helps:

- `Did you mean <task>?` when a declared task (or, for `pkg#task`, a
  runnable one) is within two edits.
- Otherwise what exists: `Tasks: build, test.`, `No
project is named zzz; projects: a, b.`, or `a's tasks: build, test.`
- Then ``A run reads the lock: after editing a
vx.config, run `vx lock`.``, since a task added since the last lock is not in it.
- `Only projects outside the selection declare <name> — pass
--all, or --filter to pick them.` when the run was scoped and a project
  outside the scope declares it.

A name declared by only some projects is fine; the check fires only when
a name matches nowhere. So `vx run lint test typecheck` fails on CI the
day `typecheck` is renamed, instead of running two of three.

A name no config can declare is refused before the lookup: an empty one
(`vx run ''`) and one with surrounding whitespace (`vx run 'build '`),
which the refusal quotes so the space shows.

Under `--affected` or a `[ref]` filter, a bare name is checked against
the whole workspace, since what changed decides the projects:

- A change that reached no project declaring `test` exits 0 with `No affected project declares
task(s): test.` A name no project declares is still refused.
- A change that reaches no requested task exits 0 with `Nothing
affected: the change reaches no test task.`
- A diff that touched no project exits 0 with
  `nothing affected since <ref>` on stderr, before any name is checked.

There is no `-V`; use `vx --version`, as in Turbo.

`vx <verb> --help` (also `-h`, `vx help <verb>` and `vx --help <verb>`) prints this
reference for that verb: its usage lines and sections, then
`Full reference: vx help`. Every argument error points at it.
`vx help <plugin verb>` is `vx <plugin verb> --help`: the plugin answers.

`vx help <name>` for a name that is no verb is refused like
`vx <name>`: one line, a guess when one is close, exit 1. A second
word after the verb is refused too.

After `--`, a flag belongs to the task: `vx run build -- --help` passes
`--help` to it. A plugin verb handles its own arguments, `--help` included.

## `vx run`

`vx run` runs the named tasks in dependency order and skips any whose
inputs did not change.

By default it runs the project holding the current directory, plus what
its `dependsOn` needs from other projects. `--all`, `--filter`,
`--affected` or a `pkg#task` choose other projects.

### Usage

```
vx run [OPTIONS] [TASK | PKG#TASK ...] [-- forwarded-args...]
```

### Examples

```sh
vx run build                  # the cwd project's build, and what it depends on
vx run build --all            # every project that declares build
vx run test --affected        # only what this branch changed, and its dependents
vx run app#build lint         # one project's build, and lint in scope
vx run test -- --watch=false  # forward arguments to the task
```

The first run executes and saves; the next finds nothing changed:

```
$ vx run build --all
 ⏺︎    17ms success miss     lib#build
 ⏺︎     6ms success miss     app#build

─ vx 0.0.0 ───────────────────────────────────────────────────
  projects  ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
            2 affected · 2 total
  tasks     ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
            2 success · 2 total
  cache     ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
            local 2↑

  info      4 workers · local cache · run 01a16e03-afb0-76ee-9cea-18a61c9d1e91
  time      101ms · max 17ms · avg 12ms · min 6ms
```

```
$ vx run build --all

─ vx 0.0.0 ───────────────────────────────────────────────────
  projects  ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
            2 affected · 2 total
  tasks     ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
            2 success · 2 total
  cache     ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
            local 2✓

  info      4 workers · local cache · run 01a16e03-b0b1-77f6-a758-f7aa680822ab
  time      16ms
```

The [Flags](#flags) table lists every option.

### No task: the picker

If no task name is given:

- **In a TTY** — a picker lists every `pkg#task` in the workspace, each
  with its `description`, and runs the number you type.
  - Under `--filter` or `--affected` it lists only the selected
    projects; `--affected` selecting nothing exits `0`.
  - The menu goes to stderr, so `vx run > out.txt` still asks.
  - Ctrl-C exits `130`, as an interrupted run does; Ctrl-D exits `1`
    with `no task picked`.
  - A workspace with no task exits `1` and says how to declare one
    (under `tasks` in a vx.config, or `vx init`).
- **Not a TTY** — exits `1` with
  `missing task name (stdin is not a TTY, so no picker; tasks here: build, test)`.
  It names the cwd project's tasks, else every project's (twelve, then
  `and N more`). Outside a workspace it reads `vx run <task>, e.g. vx run build`.
- **Under `--dry=json`**, on a terminal too — the
  same refusal (`a JSON answer opens no picker; …`), with the
  `VX_E_USAGE` error document on stdout: a program cannot pick.

### Selection

| Form                          | Effect                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| (default)                     | The project that contains cwd. Errors if cwd is not inside a project.                              |
| `pkg#task`                    | Just that project.                                                                                 |
| `//#task`                     | The root project's task (Turbo's spelling; the root is a project, D-39).                           |
| `--all`                       | Every project that declares the task.                                                              |
| `--filter <pat>` (repeatable) | pnpm-style filter DSL (see below).                                                                 |
| `--affected[=<base>]`         | The tasks a git change reaches: the ones it touches and those whose `dependsOn` closure holds one. |

Combining them, as pnpm does:

- Every include (`--filter <pat>`, `--affected`) is taken first, then
  every `!` exclude, so an exclude removes what any include added.
- Includes add up: `--affected --filter other` runs other's tasks
  whether or not the change reaches them.
- `--all` with a filter is the filter's selection: `--all --filter
'!docs'` is everything but docs.

### Filter DSL (`--filter`)

A filter that matches nothing refuses the run with `no projects matched
filter(s): …`, plus a hint:

- `Did you mean <name>?` when a project name is within two edits, or
  when one scoped name matches after its `/` (`--filter vx-otel` hints
  `@vzn/vx-otel`).
- `A filter is one pattern: --filter a --filter b` for a comma list
  (`--filter a,b`, Nx's `--projects` habit).
- `Projects: a, b` otherwise: eight names, then a count.
- For a `tag:` filter, the nearest tag (`Did you mean tag:scope:web?`),
  else the list of tags.
- When an exclusion took back everything the filters matched, it names
  it: `no projects
selected: !app excluded every project the other filters matched`.

| Form              | Meaning                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<pattern>`       | Match by package name. `*` matches any characters, including `/`. A pattern matching no package may leave out the scope, as pnpm reads it (`cart` is `@nx-example/cart` when one package carries it). One holding a `/` outside a scope that matches no package is a directory, as Nx's `--projects` reads it (`apps/*` is `./apps/*`). |
| `./<dir>`         | The package at `<dir>` alone, as Turbo and pnpm read it (`.` is the root project); a `<dir>` that is no package matches the packages under it (relative to workspace root; D-43). A link to a package's directory names that package.                                                                                                   |
| `{<dir>}`         | Same as `./<dir>`.                                                                                                                                                                                                                                                                                                                      |
| `./<glob>`        | A glob over root-relative project dirs: `./packages/*` (direct children), `{apps/**}` (nested too; a trailing `**` matches zero dirs, so `./packages/kit/**` holds kit itself, as pnpm and Turbo read it). A path that names a project dir literally is read literally first, so `./packages/[abc]` is that directory.                  |
| `.`               | The root project alone, when the root is a project (D-39); otherwise the packages under the root, i.e. every package, not the one you are standing in.                                                                                                                                                                                  |
| `//`              | The root project alone, Turbo's name for it; matches nothing when the root is no project (D-46).                                                                                                                                                                                                                                        |
| `tag:<pattern>`   | The projects whose config `tags` hold a match, as Nx's `tag:` reads them (`*` as in a name). Takes every operator a name takes: `!tag:x`, `...tag:x`, `tag:x^...`, `tag:x[main]`. Nx's `--projects tag:x` aliases it.                                                                                                                   |
| `<pattern>...`    | Match + all transitive dependencies (see below what an edge is).                                                                                                                                                                                                                                                                        |
| `...<pattern>`    | Match + all transitive dependents.                                                                                                                                                                                                                                                                                                      |
| `<pattern>^...`   | Only the transitive dependencies, excluding the matched package itself.                                                                                                                                                                                                                                                                 |
| `...^<pattern>`   | Only the transitive dependents, excluding the matched package itself.                                                                                                                                                                                                                                                                   |
| `...<pattern>...` | Match + its dependents + the dependencies of all of them, as Turbo selects (`...db...` takes the packages the apps that use db build on).                                                                                                                                                                                               |
| `<sel>[<ref>]`    | The packages `<sel>` (a name pattern or `{<dir>}`) selects that changed since `<ref>`, as Turbo and pnpm read `@scope/*[main]` (D-44).                                                                                                                                                                                                  |
| `<sel>...[<ref>]` | The packages `<sel>` selects that changed since `<ref>` or depend on one that did; no dependency is added (Turbo: `@acme/api...[HEAD]` is api when only its dependency changed).                                                                                                                                                        |
| `!<pattern>`      | Exclude packages matching `<pattern>`, from everything the includes select, in any order.                                                                                                                                                                                                                                               |
| `[<git-ref>]`     | Projects whose files changed since `<git-ref>` (`main`, `HEAD~5`, …).                                                                                                                                                                                                                                                                   |

A dependency between projects comes from one of two places:

- **A plugin.** A `discover` entry's `deps` (order and selection) or
  `reach` (selection only). The lockfile plugins (`bun()`, `pnpm()`,
  `npm()`, `yarn()` from `@vzn/vx-lockfile`) supply what the package
  manager installed. vx reads none from a `package.json` itself.
- **A cross-project `dependsOn`.** `e2e`'s `test: {
dependsOn: ['app#build'] }` makes `e2e` a dependent of `app`.

Filters follow both: `vx run test --filter '...app'` runs `e2e#test`
even though no plugin links `e2e` to `app`. There is no
`implicitDependencies` field: declare the dependency on the task.

A filter that names no project (`...`, a bare `!`, an empty `{}`) is
refused, and so is a path that climbs out of the root (`../`, `{..}`).
One whose pattern matched but selected nothing says what it matched:
`no projects selected: filter "...^core" matched core, and no
project depends on it`.

Examples:

```sh
vx run build --filter @scope/*                # all packages under @scope
vx run build --filter app...                  # app and its transitive deps
vx run build --filter ...util                 # util and everything depending on it
vx run build --filter app^...                 # only app's deps (not app)
vx run build --filter '*' --filter '!docs'    # everything except docs
vx run build --filter '[origin/main]'         # projects with files changed since main
```

### `--affected[=<base>]`

Run the task only in projects whose files changed since `<base>`.

- `--affected` with no value picks its base, the first that applies:
  1. `VX_AFFECTED_BASE`;
  2. a plugin's base commit (`setBranch({ base })`): `github()` a pull
     request's base, `nx()` `NX_BASE`, `turbo()` `TURBO_SCM_BASE`, or,
     for `turbo()` on GitHub Actions as Turbo does, the pull request's
     base branch or the push's `before`;
  3. the merge base of HEAD and `origin/<baseBranch>`. `baseBranch` is
     `origin/HEAD`'s branch, then `main`, then `master`
     ([schema](schema.md)); in a clone with no remote, the local branch.
- On the base branch itself there is no default, so vx refuses. A
  detached HEAD the base branch holds (a CI checkout of a pushed
  commit) is on it too: `--affected has no default
on the base branch (main): run --all (the cache skips what did not
change), or name the last good commit, --affected=<sha>`. `HEAD~1`
  would see only one commit of a multi-commit push.
- CI on the base branch needs only the current commit: `--all` reads no
  history, and the cache runs only what changed.
- A shallow clone needs no more history. vx fetches what the merge base
  needs: commits and trees only, no file contents, deepening 1, 2, 4…
  commits until git finds it. A pull request's merge checkout needs one
  fetch. A base it lacks is fetched as named: a commit id, `origin/<branch>`,
  or a tag (`v1`, `refs/tags/v1`). When origin cannot give that history, vx refuses (`has no merge
base with HEAD in this shallow clone`) rather than diff from the base's tip.
- With no base branch and no origin to fetch from, vx says `--affected has
no base here`.
- When the base you name is the commit you are on, the
  `nothing affected since <ref>` note says so and names the bases you
  probably meant (`--affected=origin/main`, `--affected=HEAD~1`).
- Without git on `PATH`, it prints one line: `vx requires git:
failed to spawn 'git' … Install git and re-run`. Outside a git work tree it says `vx requires
git: <root> is not inside a git work tree`. A repository with no commit
  yet says so.
- In a linked worktree's git hook, which exports `GIT_DIR` and no
  `GIT_WORK_TREE`, vx's git finds the worktree's top as a plain `git`
  there does: a workspace in a subfolder selects only what changed.
- `--affected=<ref>` uses the given git ref. vx refuses before git sees it:
  - an empty value, or one starting with `-` (it would be a `git diff`
    option);
  - a range not ending at HEAD (`HEAD~2..HEAD~1`, `main...feature`):
    `ranges are not supported — pass the base alone ("HEAD~2")`. The
    other end is always the working tree;
  - an exclusion (`^main`), naming `main`;
  - a path inside a commit (`main:packages`), naming the commit to pass.
    A root tree (`main^{tree}`) is still a base.
- `<base>...HEAD`, Turbo's CI spelling, reads as `<base>`. Two-dot
  `<base>..HEAD` diffs from `<base>` itself, not the merge base; a shallow
  clone fetches that commit as it fetches the merge base.
- A ref that does not exist is `git ref "<ref>" did not resolve`, with
  git's reason when it gives one (`main@{9}`: `log for 'main' only has 2
entries`). In a
  shallow clone it adds how to fetch it (`git fetch --depth=1 origin <base>`).
- A project whose directory is a symlink inside the workspace
  (`packages/b -> ../ext/b`) is selected by a change at the real place
  too. A link to outside the workspace is outside git's view.
- The diff runs from the **merge base** of the ref and `HEAD`, so a
  branch sees only its own changes, never what others landed on `main`
  since it forked (as in Turbo and Nx). Refs with no common ancestor
  diff from the ref.

**It selects the tasks the change reaches.** A change marks tasks in
the projects it touches:

- a cached task, when a changed path is one of its declared inputs
  (`files`, `workspaceFiles`), or is a submodule or embedded repository
  its `workspaceFiles` may reach into;
- every task of a project when:
  - its `vx.config.*` changed;
  - it holds a changed path no task of its declares, since vx cannot
    prove that path changes no key;
  - it holds a changed submodule or embedded repository;
  - a lockfile plugin or a config import names it (an install that
    added or removed a dependency shows as the lockfile's change);
- a task with no `inputs`, when a changed path lies in its project or
  the whole project is marked. A root file another task of its declares
  (`workspaceFiles`) is no change there. A group marks nothing.

A requested task runs when its `dependsOn` closure holds a marked task,
so a change reaches another project only along a task's dependency.
With `app#test` behind `^build`:

- an edit to `ui/src/button.ts`, which `ui#build` reads, runs `ui`'s
  tasks and `app#test`;
- an edit to `ui/src/button.test.ts`, which only `ui#test` reads, runs
  `ui#test` alone;
- `app#lint`, which depends on nothing, never runs for a change in `ui`.

A `pkg#task` you name runs whatever the diff. This matches the cache
key: a cached `app#test` with no dependency on `ui` never sees `ui`'s
files either.

A project with no `build` gets one keyed on all its files
([schema](schema.md)), so any change there reaches a dependent behind
`^build`.

A `graph` plugin's changes count too: a dependency or input it adds
works as a declared one, and a task it marks requested runs whatever
the diff. With such a plugin, every project is a candidate once the diff
touched anything.

Nx 23.3 (`NX_LEGACY_AFFECTED=false`) and Turbo
(`affectedUsingTaskInputs`) select tasks the same way, behind flags.
The filter forms select whole projects instead:

```bash
vx run test --affected                # the tasks the change reaches
vx run test --filter '...[main]'      # what changed + every dependent project
vx run test --filter '[main]'         # only the projects that changed
```

What counts as a change:

- `git diff` against the base, plus untracked files (`git ls-files
--others`), so a new source file counts, as it does in the key.
- A submodule or embedded repository that git reports changed (a dirty
  or moved `vendor/sub`, an untracked `vendor/nested/`) selects every
  project under it, and the project holding it. A repository's
  `diff.ignoreSubmodules` or `submodule.<name>.ignore` does not apply:
  the key sees the change anyway.
- A file git was told not to look at (`git update-index
--assume-unchanged` or `--skip-worktree`) counts when its bytes on disk
  differ, as the key hashes them. One a sparse checkout left out does not.
- A symlinked input is its target: a link whose target changed is a
  change, and a link to a target git cannot diff (outside the
  workspace, or ignored) is one on every run. A link to a directory
  selects a task whose glob may reach below it (`src/**/*.ts` over
  `src/v`), as its key reads what is behind it.
- A gitignored file a task names (`.env.local`, `dist/**`) never
  selects it, as in Nx. The key still hashes it, so the task misses when
  it changed.
- What `vx lock` writes is left out (`.vx/projects.lock.json`,
  `.vx/.gitattributes`, `.vx/.gitignore`, each project's `vx.lock.json`
  review copy), so `vx lock` never marks a project affected by itself.
  `.vx/projects.lock.json` counts entry by entry when the base has
  one: a project whose locked config changed is selected whole (a run
  reads its config from there), and `vx lock` rewriting the same
  entries selects nothing.

**A lockfile change selects what its plugin says.** Core keys no
lockfile and no install setting: without a lockfile plugin, the root
`bun.lock` or `pnpm-lock.yaml` is a root file like any other, and a
change to it selects the root project (when the workspace has one), not
every project. One inside a package selects only that package.

A lockfile a plugin claims (`VxPlugin.fingerprint`, such as
`pnpm-lock.yaml` under `@vzn/vx-lockfile`) is in the key: the key holds
what the plugin says per project, so `--affected` gives the plugin the
lockfile at the base and now, and selects the projects it names.

The same goes for a file the lockfile names but does not pin: a patch
`bun.lock` names, a `file:` directory dependency, or a linked
directory. Only a plugin that cannot tell selects everything, as
`@vzn/vx-lockfile` does for the install settings it claims (`.npmrc`,
`bunfig.toml`, `pnpm-workspace.yaml`, `.yarnrc.yml`, `.yarnrc`).

**A deleted project selects everything.** Its dependents' keys lost an
upstream, and the edge that named them went with it, so today's graph
cannot say who they are. A `vx.config` the base had in a directory that
is no project now selects every project, naming that file as the
reason. A dependency a plugin's `discover` drops without deleting a
project is the plugin's to claim (`VxPlugin.fingerprint`, as the
lockfile plugins do).

**A new nested project selects the project above it.** A project's
inputs stop at every project below it. A `vx.config.*`, or a
`package.json` a `discover` plugin reads, that turns a directory into a
project changes the key of the project that held it, so that one is
selected too. "New" means none of the changed ones in that directory
was there at the base.

**A workspace config change selects everything.** The plugins in
`.vx/workspace.*` shape every resolved config, so an edit there can
change any key, and vx cannot tell which. So does an edit to a file it
imports, directly or through another file. A root file a plugin reads
without importing it counts when the plugin claims it
(`VxPlugin.fingerprint`): `turbo()` claims `turbo.json` and
`turbo.jsonc`, `nx()` claims `nx.json`, and either answers every project.

**A file your config imports selects that project.** The key holds the
resolved config, so a shared preset a `vx.config.*` imports is part of
it. Editing `shared/preset.ts` selects every project whose config
imports it, directly or through another shared file.

- The scan reads the source; it runs nothing.
- It follows relative imports (`'..'` included), package.json
  `#imports` with a local target, and a bare one the nearest tsconfig
  maps through `paths` or `baseUrl`. Any other bare import is a
  package, which the lockfile covers. `vx watch` follows the same
  imports.
- It crosses projects as the config does: a config importing
  `../../packages/lib/preset.ts` is selected when that file, or one it
  imports, changes.

To opt a helper out, import it by a bare package name. See
[`docs/modules/config-imports.md`](./modules/config-imports.md).

**Nothing changed exits 0.** When only `--affected` or `[<ref>]`
selects and nothing matches, vx prints `nothing affected since <ref>`
and exits 0, so a docs-only commit passes `vx run lint test build
--affected=origin/main`.

- When the diff matched but an exclusion or an empty walk took it all
  back, the note says so (`no projects selected: !app excluded every
project the other filters matched`).
- A name or path pattern that matches nothing is still an error, as a
  likely typo, with a ref too: `--filter 'nope[main]'` is refused when no
  project is named `nope`, whatever changed. One that matches nothing
  beside one that matched prints a warning.

**An empty selection never cancels an anchored task.** Project scope
applies to bare names only, so `vx run app#deploy build
--affected=origin/main` with nothing changed still runs `app#deploy`
(vx notes `nothing affected since <ref> — running app#deploy only` on
stderr). Only a bare-name-only invocation short-circuits to exit 0.
With only `pkg#task` names the scope goes unused, but `--filter` and
`--affected` are still resolved: a pattern that matches nothing or a ref
git does not know refuses the run as it does beside a bare name.

### Argument forwarding (`--`)

Anything after `--` is forwarded (shell-quoted) to the task's
`exec.command`:

```sh
vx run test -- --watch              # underlying test runner sees "--watch"
vx run build -- --sourcemap         # build command gets "--sourcemap"
```

They are appended to the command's last line (trailing blank lines are
dropped first, so a multi-line command's closing newline does not run
them as a command of their own), before a trailing `;` or `&` for the
same reason (an escaped `\;`, as in `find … -exec … \;`, takes them
after), inside a compound command that ends the line, on its last
command (`(cd web && vite)`, `{ …; }`, `if …; fi`, `for …; done`,
`case … esac` get them where the shell still reads arguments), or
before a `#` comment still
open there (`echo args: # show` gets them; with comment-only lines
below a commented line, before the earliest). A heredoc's body and
terminator are not command lines: `cat <<X … X` gets them on the
`cat <<X` line (X-12). A `<<X` in a comment or in quotes opens no
heredoc, and a quote in a body opens no string (X-110). A persistent task gets
them too, with or without a `readyWhen`.

The command, with its forwarded args, is one argument to `sh -c`, and
Linux caps one argument at 128 KiB. Past that the task fails to spawn
(`E2BIG`), and the frame says how long the command was: pass a long
file list through a file the tool reads instead.

Forwarded args are folded into the cache key — different args produce
different cache entries. They scope to user-requested tasks only;
dependsOn-pulled deps don't see them (so upstream cache identity
stays clean). A frame's `$ <command>` line shows the command as it
ran, so a requested task's carries the args and a dependency's does
not.
A group (a task with no command) takes none, so a request that names
only groups is refused (`args after \`--\` reach no task`) rather
than run with the args unheard.
An argument that is not valid UTF-8 (`-- $'a\xff'`), here or before
`--`, is refused, naming its position: Bun reads argv as UTF-8 and
offers no raw bytes, so it would reach the task as U+FFFD, and two
different args would share one key. An argument holding a real
U+FFFD cannot be told apart and is refused too.

### Flags

| Flag                                       | Type           | Default                                                        | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------ | -------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--filter <pattern>`                       | repeatable     | (none)                                                         | pnpm-style filter DSL (see above). `--filter=<pattern>` form too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--all`                                    | boolean        | off                                                            | Select every project that declares the task.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--affected[=<base>]`                      | optional value | off                                                            | Select the tasks a change since `<base>` reaches: the ones it touches and those whose `dependsOn` closure holds one (default a plugin's base, else the merge base with `origin/<baseBranch>`; none on that branch); candidates are `--filter "...[<base>]"`'s.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--exclude-dependencies[=<names>]`         | optional value | off                                                            | Drop `dependsOn` edges. No value = all (just the requested task runs; a group's members run as the group); comma-list = drop only those names, each of which some project must declare (a typo is refused with the nearest name, item 1026). An edge to a task the run schedules anyway (`--all` requests it) stays, so the two still run in order, and so does the order through a dropped task: with `gen` dropped from `test → gen → build` and `build` requested, `test` still waits for `build`. An empty `=` value is a parse error (ambiguous — see below). A dropped dependency does not run but is still keyed, so every key is the one a full run derives; a task keyed on one may hit but does not save (`caching.md` step 8). |
| `--concurrency <n>`                        | int or `<n>%`  | `run.concurrency`, else the cores (cgroup-capped)              | Maximum parallel tasks that EXECUTE; confirmed cache-hit restores are disk work and run on their own lane, up to twice this. `1` serializes both; `50%` is half the CPUs (rounded, never below 1; over 100% is allowed for I/O-bound work). `--concurrency=<n>` form too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `--schedule <rule>`                        | value          | `run.schedule`, else `most-work`                               | Which ready task starts first when more are ready than workers: `most-work`, `critical-path`, `direct-dependents`, `ready-order` (`docs/schema.md` § `run.schedule`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--branch <name>`                          | value          | `VX_RUN_BRANCH`, else git's branch, then the CI provider's     | The branch the run records in its history and forecasts from. No config key: a committed branch would mislabel every other branch's runs. The space form rejects a value starting with `-`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--no-cache`                               | boolean        | off                                                            | Disable caching entirely (no reads, no writes); output globs are NOT cleaned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `--force`                                  | boolean        | off                                                            | Re-execute everything (skip cache reads); writes stay on. A key already stored is kept, and a remote that holds it is not sent it again. Output globs are cleaned (so the saved snapshot is clean).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `--cache-policy <spec>` (`--cache-policy`) | value          | `VX_CACHE_POLICY` / `cache.policy`                             | Per-layer read/write control. See below. An EMPTY spec (`--cache-policy=`) is a parse error — it applied nothing and left every axis on; pass `--no-cache` to disable them all.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--cache-dir <path>`                       | value          | `VX_CACHE_DIR` / `cache.dir` / `~/.vx/<id>/cache`              | Cache directory override, resolved relative to cwd (absolute paths used as-is). Beats `VX_CACHE_DIR`, the workspace's `cache.dir` and the default; like them, the directory then holds the whole cache, shared through no store, for every cache the run opens, so the workspace's default dir is not created beside it. A per-run knob — never folded into a cache key. `--cache-dir=<path>` form too; the space form rejects a value starting with `-`, and both refuse one of only whitespace. A directory this user cannot write into serves its hits and saves nothing, saying so once; an empty one fails the run before any task with `cache directory <path> is not writable (EACCES: …)`.                                        |
| `--retries <n>`                            | value          | `run.retries`, else `0`                                        | Re-run a failed task up to `n` more times; never a persistent one. A task's own `exec.retries` wins (even an explicit `0`). Never affects cache keys. `--retries=<n>` form too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--continue[=<mode>]`                      | value          | `deps-ok`                                                      | What a failed task takes down with it. `never` stops dispatch on the first failure; `deps-ok` (default) skips only its dependents; `always` (bare `--continue`) runs dependents anyway. See § Failure propagation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--timeout <duration>`                     | duration       | `run.timeout`, else none                                       | A task's time limit (`30s`, `10m`), for tasks without their own `exec.timeout`, which always wins. A runaway task is killed + `failed`. A bare number is refused naming the forms with units. Never affects cache keys. `--timeout=<duration>` form too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--output-logs <mode>`                     | value          | `VX_RUN_OUTPUT_LOGS`, else flow-derived                        | `full` \| `errors-only` \| `hash-only` \| `none` — explicit output override. See § `--output-logs`. `--output-logs=<mode>` form too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `--cache-download <mode>`                  | value          | `cache.download`, else `all`                                   | `all` \| `toplevel` \| `none` — where a REMOTELY-executed task's outputs land. `none` leaves them in the remote CAS and fetches lazily, only when a locally-placed task needs them. Never affects cache keys. See § `--cache-download`. `--cache-download=<mode>` form too.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--cache-concurrency-download <n>`         | int (1+)       | `cache.concurrency.download`, else min(96, max(cores × 3, 64)) | Remote downloads at once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `--cache-concurrency-upload <n>`           | int (1+)       | `cache.concurrency.upload`, else min(96, max(cores × 3, 64))   | Uploads at once, per remote.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--cache-concurrency-restore <n>`          | int (1+)       | `cache.concurrency.restore`, else twice `--concurrency`        | Local hits restoring their outputs at once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--verbosity <n>`                          | int (0+)       | `0`                                                            | `1` or more prints a per-task table (groups left out, painted as the task list on a colour terminal) after the framed blocks, above the footer. `--verbosity=<n>` form too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--dry[=pretty\|json]`                     | optional value | off                                                            | Print the task graph + predicted cache hit/miss; skip execution. `VX_DEBUG_TIMING=1` prints the stage table here as it does for a run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `--profile[=<path>]`                       | optional value | off (`profile.json` when set)                                  | Write Chrome-trace JSON of the run's wallclock spans.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Mutual exclusion:

- `--dry` with `--profile` — the profile needs a real run to write
  about.

Unknown flags are a parse error (`unknown flag: --foo`), naming the
nearest flag the verb accepts when one is within two edits
(`unknown flag: --concurency (did you mean --concurrency?)`); a name of
four letters or fewer gets one edit or a swap of two letters, so
`--poll` is not hinted `--all` nor `vx test` `last`. Every verb
does this against its own usage line and `--help`: `vx info --formt`
hints `--format`, `vx lock --chek` hints `--check`, `vx upgrade --hlp`
hints `--help`, and `--json` on a verb that takes `--format` hints
`--format json`. A flag exactly one other verb takes names that verb
instead (`vx run build --poll`: `` `vx watch` takes it ``). `vx version`
takes no word, so `vx version --hlp` is refused (exit 1) where it once
printed the version.

A task typed where the verb goes (`turbo build`, `nx build app`) is
refused with the `vx run` that runs it: `vx build` names
`vx run build --all` from the root and `vx run build` inside a project,
`vx build app` names `vx run build --filter app`, and `vx app#build`
names `vx run app#build`. A typo of a task (`vx biuld`) names the task
and the same `vx run`, unless a verb is as close (`vx rnu` hints `run`).
The default `build` is no declared task, so it is no hint: where it is
the only `build`, `vx build` is an unknown command.
It stays a refusal: a plugin verb of the same
name is the verb, and would change what `vx build` means the day one
was declared.

**Optional-value flags take their value with `=` only.** `--affected`,
`--exclude-dependencies`, `--dry` and `--profile` are all valid bare,
so a following word is read as a task name — `vx run --affected build`
means "run `build`, affected scope", and there is no way to tell that
apart from "`build` is the git base". Write `--affected=origin/main`. Getting it wrong is loud, not silent: the value
becomes a positional that matches no project, so the run refuses to
start (see "Every requested name must resolve" above). A word from a
closed set says so first: `--dry json` and `--continue never` are refused
with their `=` form.

`--exclude-dependencies=` with an EMPTY value, or a list of no names
(`=,`), is rejected rather than guessed — "drop every edge" and "drop none" are both plausible readings.
Pass bare `--exclude-dependencies` for the first, omit the flag for the
second. Given twice, the name lists add up, and a bare one drops every
edge.

Value flags (`--filter`, `--concurrency`, `--output-logs`,
`--verbosity`, `--cache-dir`, …)
accept both `--flag value` and `--flag=value`. In the space form,
`--cache-dir` and `--branch` reject a value
starting with `-`: that is always a swallowed flag (an unquoted empty
shell variable), never a path or branch. Use the `=` form for a literal
leading dash.

**Numeric flags take a plain decimal integer.** `--concurrency`,
`--retries` and `--verbosity` reject hex (`0x10`), exponent (`1e3`),
fractional (`2.7`), signed (`+4`) and space-padded forms, plus anything
past `2^53` (it would parse to a number you did not type). These all
used to be silently reinterpreted — `--concurrency 0x10` ran 16
workers. A duration flag (`--timeout`) takes its unit (`500ms`, `30s`,
`10m`): a bare `500` is refused, naming both readings.

An empty `=` value means "no value" on two flags, which then act like
their bare forms: `--profile=` writes `profile.json` and
`--affected=` uses the default base. Every other flag refuses an empty
value: `--dry=`, `--continue=` and
`--exclude-dependencies=` as well as the ones with no bare form
(`--retries=`, `--timeout=`, `--cache-dir=`, `--filter=`, `--cache-policy=`,
`--verbosity=`).

#### Cache control: `--cache-policy`, `--no-cache`, `--force`

The cache has four independent axes — **localRead**, **localWrite**,
**remoteRead**, **remoteWrite** — and the three flags above resolve
them in this precedence order:

1. Start with every axis **on** (the default).
2. Apply each `--cache-policy=<spec>` segment (the base), or, with no
   `--cache-policy`, the `VX_CACHE_POLICY` environment variable's spec, or, with
   neither, `.vx/workspace`'s `cache.policy` (`docs/schema.md`).
3. If `--no-cache` was passed, force **all four off**.
4. If `--force` was passed, force **both reads off** (writes stay
   whatever the base / `--cache-policy` left them).
5. Off CI (`CI` unset, `0` or `false`), unless `--cache-policy`,
   `VX_CACHE_POLICY` or `cache.policy` names the remote, force
   **remoteWrite off**: a key holds only declared inputs, so a laptop's
   write could replay on CI. `cache.scope` never changes an axis.

A spec that names a remote axis (`remote:r`, `remote:w`, `remote:rw`)
in a workspace whose plugins supply no remote layer gets one status
line saying so, naming where the spec came from (`--cache-policy`,
`VX_CACHE_POLICY` or `cache.policy`) — the axes are inert without a layer to serve them, and
a CI job that believes it is filling a shared cache should be told.

Whatever the axes, a lookup asks the local cache first, then each
remote in the order the plugins declare them.

The axes govern task artifacts. A plugin's own entries (`ctx.cache`) are
read from every remote the run may read or write, so a `remote:w` run
still reads them.

So `--no-cache` always wins over `--force`. The common cases:

- `--no-cache` → nothing reads, nothing writes, and declared output
  globs are left untouched (you're debugging; vx won't manage your
  tree).
- `--force` → re-execute every task (reads off) with writes on. An
  entry is immutable: a key the local cache already holds is kept, and
  each remote that can batch (`hasMany`) is asked once, in the
  background, which keys it holds; one that cannot is asked `has` per
  key before its upload. Held keys are not uploaded again (a probe that
  fails uploads, as before). Output globs ARE cleaned before each task,
  so the disk holds this run's outputs.

`--cache-policy=<spec>` is a comma-separated list of `<layer>:<flags>`
segments. `layer` is `local` or `remote`; `flags` is any subset of `r`
(read) and `w` (write), order-independent and possibly empty. A
**mentioned** layer is set EXACTLY to its flags; an **unmentioned**
layer keeps its current value. Both `--cache-policy=<spec>` and the space form
`--cache-policy <spec>` are accepted.

| Spec                               | Effect                                                  |
| ---------------------------------- | ------------------------------------------------------- |
| `--cache-policy=local:rw,remote:r` | remote read-only (won't upload); local full             |
| `--cache-policy=local:r`           | local read-only; remote untouched (still full)          |
| `--cache-policy=remote:`           | remote fully off; local untouched                       |
| `--cache-policy=local:,remote:rw`  | don't touch the local cache, but still upload to remote |

`local:` means "don't serve hits out of the pre-existing local cache" —
a remote hit is still delivered (the artifact has to land on disk to be
extracted), it just never short-circuits the remote read.

Combine with `--force` for "re-execute and fill only the remote":
`--cache-policy=local: --force` (local off, reads off, remote write-only;
keys the remote already holds are not sent).

Invalid layers/flags are a parse error
(`--cache-policy: invalid layer 'disk'`, `--cache-policy: invalid flag 'x'`, …);
`VX_CACHE_POLICY` and `cache.policy` say their own name instead.

### Output

What a run prints is derived from the run's intent (its "flow"),
unless explicitly overridden:

- **FOCUSED** — no selection flag was passed. The user is running
  "their" task; cwd and task count are irrelevant to the
  classification.
- **BROAD** — the invocation used `--all`, `--filter`, or
  `--affected`. The user asked about a swath of the workspace and
  wants news, not output.
- **CI** — the `CI` env var is truthy (`CI=0` and `CI=false`, in any case, don't
  count). Wins over the flow.

Reported task lines share one column grid —
`<glyph> <time> <status> <cache> <name>` — with two orthogonal axes:
the glyph SHAPE encodes the cache axis, the glyph COLOR (and the
status word) the task axis.

| Glyph | Cache axis                 | Status word |
| ----- | -------------------------- | ----------- |
| `⏺`   | miss — the task ran        | success     |
| `►`   | fresh (up-to-date)         | success     |
| `⇢`   | restored from local cache  | success     |
| `⇣`   | restored from remote       | success     |
| `◼`   | failed                     | failed      |
| `⊘`   | skipped (blocked upstream) | skipped     |
| `▸`   | persistent (dev server)    | running     |

A live WORKER row carries no glyph: the ticking elapsed time leads it,
which is the motion the run has instead of a spinner.

Per-task visibility by outcome. Each cell is the SHAPE of what prints —
`silent`, `one-liner`, `frame`, or a conditional; the table is pinned to
the renderer by `tests/output-doc-drift.test.ts`, so the vocabulary is
fixed:

| Outcome                | focused (requested task) | focused (dependency)      | broad                     | CI / `full`                  |
| ---------------------- | ------------------------ | ------------------------- | ------------------------- | ---------------------------- |
| executed               | frame                    | silent                    | one-liner                 | frame                        |
| restored-local/-remote | frame                    | silent                    | silent                    | frame, or one-liner if quiet |
| up-to-date             | frame                    | silent                    | silent                    | frame, or one-liner if quiet |
| failed                 | frame                    | one-liner + frame replays | one-liner + frame replays | frame                        |
| skipped                | one-liner                | one-liner                 | one-liner                 | one-liner                    |

What the shapes mean in each column:

- **focused, requested task.** The frame is LIVE when it is the only
  requested task: `┌─` prints at task start, the command's output (or a
  hit's replayed stdout) streams raw between the brackets, `└─` closes
  it. The status region stays below the streamed output, summary and
  run id included, redrawn after each write. With several requested tasks the same frame is buffered and
  emitted atomically (see below). Every outcome that ran or was cached
  gets one — including an `up-to-date` hit, whose frame carries the
  `$ cmd` line so a requested task looks the same whether it ran or not.
- **skipped** is the exception: it never started, so no frame was opened,
  and it produced nothing a frame could hold. The one-liner says
  everything, the blocker included (`⊘ skipped app#deploy • blocked by
lib#build`; a fail-fast skip, which nothing blocked, carries no
  suffix). Every view that lists tasks prints it, a dependency's
  included: nothing prints below the footer.
- **`frame, or one-liner if quiet`** — a cache hit with stored stdout is
  worth a frame (the output is the point); a hit with nothing to replay
  compresses to one line, which is what keeps a 2000-task warm run
  readable.
- **`one-liner + frame replays`** — the `◼ … failed` line prints
  immediately; the full frame is held and replayed at run end.

When a dependency fails mid-run, the stream gets ONE permanent
`◼ … failed miss <id>` line and the run continues; **all full failure
frames replay together at run end**, right above the summary, and are
never capped.

The end-of-run summary always prints; cache-hit counts that broad
mode silences per-task surface there. A focused `vx run test` is meant
to feel like running the test command directly — same output, just
faster.

**Groups are transparent folders.** A group task (no `exec`, just
`dependsOn`) has no output of its own, so running one focused —
`vx run build` where `build` chains `build.bun` which chains
`build.bun.darwin-arm64` … — surfaces the **real tasks** it stands for
and shows them like requested tasks. The walk descends through nested
groups but never leaves the requested project (`^`/cross-project deps
aren't surfaced) and never goes past a real task into its own deps.
The requested count for the live-vs-buffered decision counts the
surfaced tasks: one real task streams live, several buffer into atomic
blocks. (Surfacing is display-only — it does not make those tasks
"requested", so `--` `forwardArgs` still go only to what you named.)

Live streaming applies only when there is exactly **one** requested
task. Live open/close framing assumes a single task owns the terminal
between its open (`┌─`) and close (`└─`) lines — with two requested
tasks running concurrently their frames would interleave into garbage.
So when more than one task is requested (`vx run build test`), each
requested task instead **buffers** its output and renders as a single
atomic block at completion. The shapes are the ones in the table above —
anything that ran or was cached gets a full frame, `up-to-date`
included; only `skipped` is a one-liner. The blocks are blank-line
separated and never interleave. A single `vx run test` keeps the
live-stream experience unchanged.

On an interactive terminal (TTY stdout, not CI) a status region
tracks the run live. Top to bottom:

1. **A blank separator line** — keeps the live region visually apart
   from the completed-task scrollback above it.
2. **Pinned persistent tasks** — `▸ <id> running` for every persistent
   task that became ready. The pin lives until run end, or until the
   task's process exits on its own (a crash, or a setup step ready by
   its exit 0, whose frame then closes `success`, not `running`), so it
   is the visible evidence the dev server is still alive. After the summary,
   a requested persistent task keeps vx in the foreground, with the
   persistent tasks it depends on, until it — or, with several, the
   first of them — exits (one kept only as a dependency that exits 0,
   a daemon that forked and returned, does not end it); the rest still up are then torn
   down (SIGTERM, a 2 s grace, SIGKILL), one status line names
   the task and its code (`vx: app#dev exited with code 1; stopping 1
other persistent task`), and a non-zero exit makes the run exit 1
   and is what `vx last` records.
   A Ctrl-C prints no such line: the server ended because it was
   stopped, and vx exits 130. A run with a failure elsewhere (a task
   failed or skipped, a server never ready or crashed) holds nothing: it
   stops its servers and exits 1, unless `--continue=always`; `vx watch`
   keeps its server through a failed cycle. While vx holds them, what
   the servers write streams below the summary a line at a time under
   each one's id (`app#dev │ Local: http://localhost:5173`), except
   under `--output-logs errors-only`, `hash-only` or `none`; a single
   requested server in the focused flow streams raw from its frame.
3. **The running list** — one row per worker (`--concurrency`), always,
   so its height never changes. A task stays in its slot for its whole
   life; a task running beyond the slots gets a row after them until
   one frees, and none is ever folded away. Both lists share one grid,
   each under its own header, dim and underlined across the whole line,
   straight over its rows:

   ```
         time   usual  waited status  cache      cpu    mem outputs  blocks worker       task
        3.19s    ~18s   400ms running miss      180%  412MB              12 local        solid-js#types  critical path
                ~6.0s         blocked                                                    └ solid-element#build
   ```

   - **time**: the live elapsed time; no glyph and no spinner.
   - **usual**: the task's executed p50 from local history, fixed while
     the time counts up toward it. The results list's `±usual` is how
     far a run landed from it, `+6.00s` red or `−1.40s` green, only
     past a fifth either way and never on a hit.
   - **waited**: how long the task sat ready for a free slot; blank
     under 50 ms.
   - **status** and **cache**: `running` and `miss`, or `no-cache` for a
     task with no `cache` block (or a `--no-cache` run); finished rows
     say `local` or `remote` on a hit.
   - **cpu** and **mem**: the task's process tree now, looked at every
     500 ms only while this list draws (a pipe or CI reads nothing); on a
     finished row its average cores and peak memory, blank on a hit.
   - **outputs**: on a finished row, the bytes of its outputs: on a hit
     the files it restored, on a miss the files it saved; blank for a
     remote hit not yet downloaded.
   - **blocks**: how many tasks are downstream of it, all of them.
   - **worker**: `local`, or the machine an executor (`@vzn/vx-dte`)
     names, cut to 12 columns with `…`.

   The rows no task runs in hold the tasks the scheduler has picked for
   the next free workers, as many as there are free rows and nothing
   further ahead, each nested under the running task it waits on with
   its usual time; the rest stay blank. When an executor places tasks,
   the rows are only what runs: no blank or nested row, blocked tasks
   are the tasks line's dim `N blocked` alone. `critical path` (red)
   follows the running task the longest unfinished chain waits on; its
   row in the list says it too once it ends.

4. **vx's own steps** — what vx does around the tasks that the run
   waits on, before its first task starts or before it ends, as rows of
   their own below the worker rows: `vx:load` (configs and graph from
   the lock), `vx:run-lock`, `<plugin>:setup`, `vx:keys` (keys and local
   probes), `<plugin>:schedule`, then after the graph `vx:uploads`,
   `vx:history`, `<plugin>:telemetry`, `<plugin>:teardown`,
   `vx:snapshots`, `vx:retention`, `vx:close` and `vx:sandbox`. A step
   shows once it has run 150 ms, ticking like a task
   (`     1.2s running internal vx:uploads`); no worker slot or
   `--concurrency` holds it back. When it ends it leaves a list row
   like a task's, `internal` in the cache column
   (`⏺︎ 4.60s success internal vx:uploads`); a quicker one shows
   nowhere. A step that runs beside the tasks, `vx:prefetch` (a
   remote's downloads), never shows: `vx last` lists it. `:` is no task
   id's separator, so a step never reads as a task: a project named
   `vx` keeps `vx#build`. No step is a task: no count, bar, history
   row, forecast, flaky verdict or telemetry record holds one;
   `--profile` and `VX_DEBUG_TIMING` time vx's stages their own way.
   Steps show only beside a live region; a log (CI, a pipe) prints
   none. Under `--output-logs hash-only` (one line per task) and
   `errors-only` only a step that failed leaves a row.
5. **The live summary section** — the SAME meters the final footer
   prints (`tasks` + `cache` bars with legends, `time`), filling in as
   the run progresses, under a bare `vx` wordmark rule. A second in,
   the `time` row adds what is left (`time  1.41s · ~3s left`): each
   unfinished task's executed p50 from local history, the longer of
   the longest unfinished chain and that work spread over the
   workers, a running task's spent time taken off its own. It says
   nothing when history knows none of what is left. Past the estimate
   it counts up how long the run has waited (`time  9.02s · +3s over`)
   until new work makes a forecast again. A run that ends inside the second never
   reads history for it, and the final summary never shows it. A p50
   here is the median of the task's last five timings on this branch,
   else on any branch; the timings are shared by every worktree of the
   repo, so a new one has a forecast on its first run.

In a terminal known to read them, the region also sends zero-width
escapes: tab or taskbar progress (OSC 9;4: Ghostty, iTerm2 3.6+,
Windows Terminal, ConEmu), filling by the forecast or else by tasks
done, red once a task fails, and cleared when the region goes; and a
run of 10 s or more ends with a desktop notification (OSC 9: Ghostty,
iTerm2, WezTerm), `vx: 12 tasks done` or `vx: 1 of 12 tasks failed`.
The terminal is named by `TERM_PROGRAM` (or `WT_SESSION`,
`ConEmuPID`); any other gets neither, and so do tmux and screen, even
started from one of those, since there OSC 9 may itself be a
notification.

In a terminal known to open OSC 8 links (Ghostty, iTerm2 3.1+, WezTerm,
VS Code, Windows Terminal, kitty, Konsole, VTE terminals; never inside
tmux or screen), a failed task's frame links each path that names a
file in the task's project, `src/a.ts:12:5` or `src/a.ts(12,5)`, coloured
or not, to that file, so a click from the workspace root opens the right one. The
text is the task's output unchanged; a successful task's frame is never
linked.

The region is redrawn in place (cursor-up + clear; not a TUI — no
alternate screen) and erased before the final summary prints. On a
terminal shorter than the region, it shows only the rows that fit. In the
focused flow it only lives while dependencies run; it disappears for
good the moment the requested task starts streaming.

Redraw cost is bounded: task events force a redraw, but forced
redraws within 30 ms of the last draw coalesce into a single
trailing draw when the floor expires (the final state always lands).
On a 3,270-task warm run this cuts ~6.7 MB of redraw ANSI to ~20 KB.

Identity coloring: each half of a `project#task` renders in a stable
hue hashed from its own name (same project = same color, same target
name = same color, in every run and every surface: every `#build`
matches), with a dim `#` between, all outside the status palette, so
an id can never read as an outcome.

On GitHub Actions (`GITHUB_ACTIONS` truthy, full output mode), each
task's block is wrapped in `::group::<id> (<outcome> <duration>)` /
`::endgroup::` so it collapses in the log viewer. Failed tasks stay
pre-expanded and emit an `::error title=<id>::failed (exit N)`
annotation instead (above 128 the label names the signal:
`failed (exit 137, 128 + SIGKILL)`, a timeout its reason,
`failed (timed out, exit 143)`, a persistent task that never became
ready its reason, and a sandboxed task its violation count, as every
surface labels a failure). In every output mode there, a task's own
text (a frame, a server's output since ready) is fenced in
`::stop-commands::`, so a line it prints never becomes a workflow
command.

### `--output-logs <mode>`

Explicit override; always beats the flow and CI defaults. `full`
(frames for executed work, one-liners for quiet cache hits),
`errors-only` (only failed tasks print, a server that died on its
own after ready included, with what it wrote since; the CI noise
budget),
`hash-only` (one line per task — outcome word, task id, cache key — and
no log output at all; the run's audit trail of which key each task
resolved to, Turbo parity), `none` (no per-task output). The
end-of-run summary always prints.

### Failure propagation — `--continue`

`--continue[=never|deps-ok|always]` controls what a failed task takes
down with it:

- **`deps-ok`** (default): the failure's transitive dependents are
  skipped; independent siblings keep running. A server that dies after
  it became ready is a failure to its dependents not yet started,
  including those that reach it through a group.
- **`never`**: fail fast — the first failure stops dispatch. In-flight
  tasks finish their attempt and start no retry; everything not yet started (cache restores
  included) completes as skipped. A server that dies after it became
  ready stops dispatch the same way.
- **`always`** (bare `--continue`): dependents run even when an
  upstream failed — to surface every failure in one pass. A task
  downstream of a failure (directly, or through successes built on it)
  runs and cleans its outputs as usual but is **never saved**: under
  pure-input hashing its key is the one a healthy run derives, while its
  bytes were built on a partial tree, so caching it would hand the next
  clean run a stale hit. A server that died after it became ready is
  such a failure to what starts after its death. A cache hit still
  restores (that artifact came from a healthy run), and the next run
  without the failure rebuilds the rest. A task `exec.platforms` skips
  here is no failure: its dependents are skipped in every mode.

The mode is the local scheduler's: a task a plugin executor runs
elsewhere is one dispatch, failed or not, like any other.

### `--cache-download <mode>`

Where a **remotely-executed** task's outputs land. `all` (default)
downloads every task's outputs to this machine as it completes —
today's behaviour, byte for byte. `toplevel` brings home only the tasks
you actually asked for — including the real tasks behind a requested
group — and leaves intermediates remote. `none` leaves
them in the remote CAS
and fetches them **lazily**: only when a locally-placed task in the
same run actually needs them (Bazel calls this "build without the
bytes"). A CI job that only wants the verdict moves no output bytes at
all.

Locally-executed tasks always write in place and ignore the flag, and
`exec.remote: 'only'` still means never — `--cache-download` cannot override
it in either direction. **It never affects a cache key**: transfer
tuning cannot change what a command produces.

One safety gate: a task whose outputs another task's `inputs`
globs could read on disk is silently kept eager, because deferring it
would make that key depend on whether the bytes arrived. A task with no
`cache` that a cached task depends on counts as reading its whole
project (C-16). `--dry` reports
how many tasks would keep their outputs remote and names each downgrade,
so a run that defers nothing says why. A run in which any task declares a
`inputs.runtime` / `workspaceRuntime` command defers **nothing**:
a shell command's reads cannot be bounded, so vx cannot prove it will
not read a deferred output (the same reason vx refuses to infer inputs
by tracing). When bytes are fetched later, vx saves an ordinary
cache entry for them, so the next run is a plain local hit.

### Exit codes

| Code                  | When                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`                   | Every task finished `success` or `cache-hit` (local or remote), or was skipped as another platform's (`exec.platforms`) or behind one; or `--affected` left no project that declares the task.                                                                                                                                                                                 |
| `1`                   | At least one task ended `failed` or `skipped` (a platform skip aside); a persistent task exited non-zero after it was ready; a task name no project declares; or parse/setup error.                                                                                                                                                                                            |
| `130` / `143` / `129` | Interrupted (SIGINT / SIGTERM / SIGHUP): each task's process group (the task and what it forked) gets vx's signal once (a SIGHUP as a SIGTERM), a 2 s grace to go, then SIGKILL; a second signal skips the grace. vx then dies of the signal, so a shell script running it stops too (a run that handed a task the terminal exits with the code, so the terminal is restored). |

A task runs in its own session, so a terminal's Ctrl-C reaches vx alone,
and each task hears it once: from vx, as SIGINT. Ctrl-Z (SIGTSTP) stops
each task's process group, then vx; `fg` or `bg` continues vx, and vx
continues them. A Linux sandboxed task's command is not stopped, only
held once its output pipe fills. A stop starts no more remote
cache uploads and does not wait on one in flight, nor on a remote lookup or
download: what was half-read is dropped and fetched again next run.

Installed from npm, `vx` is a sh launcher that execs the platform
binary, so every signal reaches vx directly and no Node starts first
(a `vx --version` through npm: 14 ms, was 56 ms with the Node launcher, 2026-10-12). Where it
finds no binary beside it (musl, Yarn PnP, a platform with none) it
hands off to a Node launcher. On Node 22.15 or later that one
replaces itself with the binary (`process.execve`) too. On older Node it runs the binary and waits for it:
a signal sent to the launcher alone (`kill`, a process manager) is
passed to the binary, and a terminal's Ctrl-C already reaches both, so
the launcher does not send it twice. Either way it dies of the signal vx
died of, as vx does. So does a compiled vx that hands the call to the
workspace's own.

A reader that leaves does not change the code. `vx run build | head -1`
closes the pipe after one line; the run still finishes, saves what it
built and releases its lock, and exits with its own verdict — the
output after that point goes nowhere (`EPIPE`, on stdout or stderr, is
not an error vx reports). Before 2026-09-16 the same pipeline died with
a stack and exit 1 after its task had succeeded.

## Planning mode (`--dry`)

`--dry` short-circuits execution. It builds the full task graph,
computes each task's cache key as the run would (none, `hash: ""`, for
a server no task depends on), and probes the cache to predict the
hit/miss outcome. Against a remote cache the probe is a lightweight
existence check — planning never downloads or ingests artifacts.

```
$ vx run ci --dry
would run:
  ✓  @vzn/vx#format-check  cache hit (local)         02bfe8a9
  ✓  @vzn/vx#lint          cache hit (local)         d66cfed2
  ▶  @vzn/vx#test          cache miss — would exec   68595e49  ~72.64s

3 task(s) planned, 2 cache hits (2 local), 1 would run.
predicted: ~72.64s wall · ~72.64s total execution
```

**Time prediction.** A would-run task with recorded history shows its
typical executed duration (`~p50` over its recent non-hit runs in the
local `cache.db`). The footer predicts the run: `wall` is the longest dependency
chain of would-run cost (cache hits restore near-instantly and count
as 0), `total execution` is the sum across would-run tasks. Tasks with
no history count as 0 and are called out (`N tasks without history
(+?)`) — the totals are honest lower bounds. The footer is omitted
when nothing would run or when no would-run task has history.

**Placement.** When the workspace's plugins supply more than one
executor, each row carries the one the task would land on (`@spy-remote`;
`@local` for the floor; `@noop` for an `exec.remote: 'only'` task no
remote accepts, which the run would skip rather than run here) and the
JSON object carries it as `executor`. With one executor there is
nothing to choose and the column is absent, except `@noop`, which a
remote-only task carries whatever the count; it costs nothing in the
prediction. If an executor hook throws
or returns something that is not an executor, the plan still prints —
`--dry` never fails over a label — but says so on the status line, in
the plugin's name: `[vx] placement not shown — plugin 'x' … (the run
would refuse on it)`.

**Platforms.** A task whose `exec.platforms` leave this machine out is
`skipped`, and so is every task that depends on it, as the run skips
them: the row says why (`needs darwin-arm64, this is linux-x64`,
`blocked by mac#build`) and the JSON carries `otherPlatform` or
`blockedBy`. On CI, or when no executor routes such a task, `--dry`
refuses as the run does.

Status legend:

| Symbol | Meaning                                                                                    |
| ------ | ------------------------------------------------------------------------------------------ |
| `✓`    | cache hit (local) — entry already in `<cacheDir>/`                                         |
| `↓`    | cache hit (remote) — entry would be fetched from the layer                                 |
| `▶`    | cache miss — task would execute (under `--force` too: nothing is read, what runs is saved) |
| `∅`    | no-cache — task opts out (no `cache` block, or `--no-cache`)                               |
| `·`    | `@noop` — task would not run anywhere                                                      |
| `−`    | not started — a server you did not request whose every dependant is a hit, local or remote |
| `·`    | skipped — `exec.platforms` leave this machine out, or a task it depends on is skipped      |
| `○`    | group task (suppressed in human view; in JSON)                                             |

`--dry=json` emits the same data as one JSON object on one line, alone on stdout
(a stage's warnings go to stderr), and with nothing to run (nothing
affected) an empty `tasks` list, the note on stderr; `schemas/plan.json`
is its JSON Schema, held like the read verbs' (see Machine-readable output).
Indented here to read:

```json
{
  "tasks": [
    {
      "id": "@vzn/vx#lint",
      "project": "@vzn/vx",
      "task": "lint",
      "description": "oxlint with tsgolint-backed type-aware checks",
      "hash": "d66cfed2...",
      "cacheStatus": "hit-local",
      "deps": [],
      "p50Ms": 72640
    }
  ],
  "predicted": { "wallMs": 0, "workMs": 0, "unknownCount": 0, "criticalPath": [] }
}
```

Every task with history carries `p50Ms`, hits included (only the text
view's `~p50` is limited to tasks that would run); `predicted` counts
would-run tasks only and is present whenever local history was
readable. Its `criticalPath` names the would-run tasks with history on
the chain `wallMs` measures, dependencies first: the tasks to speed up
to shorten the run.

### Why a task is affected (`affected.kind`)

Under `--affected`, each requested task the diff kept gets a line, and
its JSON object an `affected` reason:

```
$ vx run build lint --affected=main --dry
  ▶  app#build  cache miss — would exec  …
                affected: packages/lib/src/a.ts changed (an input), via lib#build
  ·  lib#lint   no-cache                 …
                affected: packages/lib/src/a.ts changed (in its project)
```

`kind` is `input` (a changed `file` is a declared input), `project` (its
project changed and the task reads it whole: a task with no `inputs`, or a
changed `file` no task of the project declares, often an output git does not
ignore; no `file` for a config import), `workspace` (a workspace-wide
`file` changed: the workspace config, or a root file a plugin claims such
as a lockfile, reached every task of the project),
`package` (a `^` edge passes a changed `project` with no such task),
`named` (`pkg#task` beside a bare task) or `selected` (another filter
selected its project). `via` is the `dependsOn` chain, nearest first, to
the task the change reached. A dependency the kept tasks pull in carries
none. The reasons are gathered only for a plan; a run pays nothing.
`--dry=json` also states `affectedBase`, the ref the diff was taken
against: a bare `--affected` picks it (a plugin's base, else the base
branch), so a reason that names no file may come from a commit
the base reaches, a root `package.json` edit among them.

## Run artifacts (`--profile`)

`--profile` adds a side-effect after a real run completes. Errors
writing the artifact are surfaced via `vx: failed to write …` but
don't change the run's exit code — the run already happened. A path
that is a directory is refused before the run (`VX_E_USAGE`); a missing
parent directory is made.

### `--profile[=<path>]`

Writes a Chrome-trace JSON of every task's wallclock span. Open in
`chrome://tracing` or https://ui.perfetto.dev.

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

Each project gets a distinct `tid`, and one more for each task it runs
beside another of its own, so concurrent tasks render on separate lanes. `ts` and `dur` are microseconds derived
from the per-task `hrtime.bigint()` spans the runner captures.
`cat` carries the task's final status (`success`, `cache-hit`,
`cache-hit-remote`, `failed`). A remote hit this run downloaded also
carries `fetchMs`, its download and ingest; the rest of its `dur` is vx's.

With a remote cache, the run's lane 0 holds two `cache` spans: `stable
keys` (the up-front keys, `args.keys`) and `remote probe` (the batch
check, `args.keys` asked, `args.held` found). An executor adds its own events after the run's process
(`TaskExecutor.profile`): `@vzn/vx-dte` adds one process per worker,
each task on a lane of its own, and the orchestrator's waits
([its README](https://github.com/vznjs/vx/tree/main/packages/vx-dte#readme)).

Default path: `profile.json` (cwd-relative).

## Sandbox

Sandbox isolation is opt-in **per task** via an `exec.sandbox` block in
the task's config — there is no `--sandbox` CLI flag. See
[`modules/sandbox-runtime.md`](./modules/sandbox-runtime.md) for the
full reference.

```ts
// vx.config.ts
export default {
  tasks: {
    build: {
      exec: {
        command: 'tsc',
        sandbox: {
          allow: {
            read: ['.'],
            write: ['dist/**'],
          },
        },
      },
      inputs: { files: ['src/**'] },
      cache: { outputs: { files: ['dist/**'] } },
    },
  },
}
```

The grants are the task's whole permission surface — nothing is derived
from `cache`, and the only thing core adds is `node_modules` plus the
workspace packages linked there, never a link back to the task's own
project (npm and Yarn link that too). For a task that declares `cache`
a linked package is granted only when its key includes a task of that
package; declaring `cache` narrows core's grant and widens nothing.
Enforcement anchors at the workspace root (a task never leaves its
project); only denials inside the project, or under a withheld linked
package, are reported.

Policy: **fail on violation.** Any task that touches a path it didn't
declare either fails naturally (Linux: `ENOENT` from bwrap's
mount-namespace hide) or is flagged via the macOS violation store
and forced to exit non-zero. No cache is written for a failed task. The
task's `SANDBOX VIOLATIONS` section ends with a dimmed `fix:` line,
the grants that would have allowed each denial, project-relative:
`fix: exec.sandbox.allow: { read: ['tsconfig.json'], write: ['dist/'] }`.
A write grants the top directory it landed in, so the next file there
passes too, unless `inputs.files` reads that directory: then it
grants the file alone, so the task cannot write its own inputs; a read the output depends on is a key input as well, and
the line says so, since a grant never adds one. A read through a link
grants the directory holding the link too: the sandbox mounts a grant at
its real path and never the link, so the target alone stayed out of
reach. A credential path
(`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.config/gh`,
`~/.config/gcloud`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`,
`~/.git-credentials`, `~/.docker/config.json`, a `.env` file) is never put in the
line: an agent applies it as given, so it is named apart as one to
grant only on purpose.
"Didn't declare" means the grants, which on Linux are wider than they
read: a file-shaped write grant is bound as its whole directory, so
every file beside it is readable without a violation — `schema.md`
§ `exec.sandbox` has the shape and the remedy (outputs in a
subdirectory).

`vx run` arms the sandbox runtime when a task that declares
`exec.sandbox` is about to execute; a cache hit needs none. If the
platform cannot host it (Linux needs `bwrap`, `socat` and `rg` on PATH;
macOS, `sandbox-exec`), that task fails with one line, `sandbox not
available: <reason>`, and never runs unsandboxed. Tasks without a
sandbox run as usual, and the failure's dependents follow `--continue`.
A task an executor that enforces the sandbox where it runs takes
(`@vzn/vx-dte`'s workers) arms nothing here, so a DTE run's
orchestrator needs no sandbox runtime.

## `vx watch`

`vx watch` runs the named task, then re-runs it on every filesystem
change in the projects in scope. Press `Ctrl+C` to stop.

### Usage

```
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

### Lifecycle

1. **Initial run.** Same code path as `vx run` — same scope resolution,
   same task graph, same cache behaviour, printed as its rows alone.
2. **Watch loop.** After the initial run finishes (or once it waits only
   on a server's readiness, X-139), the directory of
   every project a cycle can run — the scope (the bare tasks' scope
   plus each `pkg#task`'s own project; only those when every task is
   anchored) plus its transitive dependencies, the closure `--filter 'app...'` walks, cross-project
   `dependsOn` edges included — is watched recursively, less any project
   nested inside it, with a config or not (a root project's key leaves a nested
   project's files out, so an edit there is no cycle; X-42, X-57). The workspace root is
   watched (non-recursively) for a claimed file (a lockfile), for
   `.vx/projects.lock.json` and for an edit to `.vx/workspace.*` — the one root file that
   shapes a run (plugins, `config` stage, concurrency) without being any
   task's input; the cycle after it re-evaluates the file. With the file
   removed a cycle fails, as `vx run` refuses, until it is back. A `.gitignore`
   there or in a project's parent directory is a cycle too: inputs are
   gitignore-aware, so it changes what keys read (X-136). A file a
   config imports from disk (relative, `#imports` or a tsconfig alias,
   as `--affected` follows) from outside the watched projects (a
   shared preset) is watched too, and its edit is a cycle that re-reads
   the configs; so is one inside a project, which re-reads the set as the
   config's own edit does (WD-14). A file the workspace config imports is loaded once per
   process, so its edit is named with the restart it needs rather than
   run stale (item 949). An import whose file is gone stays on the list
   by the name it would have, so its return is a cycle (X-133). The
   projects are the lock's: a new `.vx/projects.lock.json` is the
   event that adds or drops one, and its directory is watched
   from before that cycle runs, so an edit made during it queues
   (X-138). A config added and not locked is no project yet. With no
   lock at start the first cycle fails saying so, and the watch waits
   for one. A project directory, or one a config imports from,
   removed and made again (a checkout that restores `packages/`) is
   heard from its nearest directory that exists and each one above it,
   and a watch whose
   directory was replaced is armed again (an OS watch holds the deleted
   one; `watch-recreated-dirs.test.ts`). There, a project directory
   that is still the same one starts no cycle: a task writing at its
   top level moved its mtime, which macOS reports to the parent
   (`watch-project-dir-write.test.ts`). Under `--filter` or
   `--affected` the scope is the one resolved at start, and a new
   project joins it only as a dependency of it. A task's own declared outputs (`cache.outputs.files`,
   `outputs.workspaceFiles`; a plugin's `project` stage counts, as in
   a run) never trigger a re-run — a cycle that writes `dist/` is not
   an edit, nor is the `dist` directory itself coming and going (a
   literal entry covers its whole tree, as in the schema), unless some
   task reads the path as an input (an in-place formatter's `src/**`
   output still leaves a `build` reading `src/**` watching it, item 946;
   a task's own outputs are no input of it, so a `turbo()` task reading
   `**/*` does not re-run on its own `dist/`; only the tasks the run
   reaches through `dependsOn` are asked, so an unwatched `lint` reading
   `**/*` beside `vx watch build` asks nothing) — and neither do `node_modules`,
   `.git` or the cache directory. A write the task did NOT declare (a
   task with no `cache` block declares nothing) is caught by state,
   judged once the bytes have settled: a file whose bytes and mode did
   not change since the loop last saw it is not an edit (a `chmod` is one,
   as the key reads the executable bit), nor is a directory
   whose entries (names and sizes) did not, nor a path that stayed
   gone; a symlink is its target string and what it points to, as the
   key folds them, so a retarget is an edit, and so is an edit behind
   it: watch arms each link's target, wherever it lies, and names the
   link; a path the loop has never judged is an edit only if it was
   modified after the watchers went live (macOS delivers the initial
   run's own writes after the arm; the later of the path's mtime and
   ctime says which side of it a path belongs to, so a file moved in
   with an old mtime by `mv`, `cp -p` or `tar x` still counts, and a
   symlink's own times are read, never its target's), and a
   path git did not list at the arm that is gone again (vim's `4913`
   write probe, a lock file) is no edit (a `.gitignore` edit lists
   again, so a file it stops ignoring is one); and
   nothing is judged while a cycle runs — its
   own writes are mid-flight, a `dist` deleted and not yet rebuilt is
   a state the tree will not keep — so paths that land mid-run are
   judged together one debounce window after it ends, an edit made
   meanwhile included. A task that writes into its own project,
   `rm -rf dist && tsc` included, costs one extra cycle instead of
   re-running forever — when the bytes it leaves are the same. A file
   it rewrites with DIFFERENT bytes every run (a pid file, a
   timestamped log) is either git-ignored — a git-ignored path never
   starts a cycle, since no cache key can see it (a user's edit to one
   still does in a project with a task that has a command and no cache,
   which reads what it likes, item 947, outside any project nested
   in it; a write the last cycle made is not, read off the later of
   its mtime and ctime, so an output a cache hit restores with its
   saved mtime is the run's, `watch-restored-output.test.ts`) — or declared an
   output, or the loop re-runs on it; after three such cycles in a row
   watch names the path and the remedy, once, and keeps going. A dev
   server the last cycle left running counts as that cycle for as long
   as it runs, so a log it rewrites in its project is named too, with
   `.gitignore` as the remedy (a persistent task declares no outputs;
   item 948). A file git tracks is never blamed on the server: three
   saves of a source file are the user's (WD-7). When any project's config declares
   `inputs.workspaceFiles`, the per-project watchers are swapped
   for ONE recursive root watcher (boundaries are off for those globs,
   so a root-relative glob can name a file anywhere). That watcher
   hears every write in the tree and keeps only the ones a key can
   see: a path inside a project's directory, a fingerprint file at the
   root, or a match of a declared `workspaceFiles` glob. A log written
   at the root, a `coverage/` or `.turbo/` tree, an editor's scratch
   file are dropped before the trigger — so `vx watch … > build.log`
   inside the repo settles instead of feeding itself a cycle per line
   of its own output. The opening line, `watching N projects · M tasks`
   (after the initial run's rows), is
   printed only after every watcher has reported a probe file written
   under it (`.vx-watch-probe`, re-written on a short backoff until its
   event arrives, then removed): on macOS a directory watcher can return
   before its event stream is live, and an edit in that gap is silently
   lost — so the line is a promise, not a hope. A probe is never an
   edit, at any depth: another watcher's, seen under a nested project,
   ran a cycle (and restarted a dev server) with no edit made (item
   1016). A
   watcher whose probe is not heard within 2 s is replaced by a poller
   that checks every 250 ms, with the notice `vx watch: <dir>: no OS
watch events within 2000 ms; polling every 250 ms instead`.
3. **On change.** A cycle opens with a blank line and
   `changed <project> <relpath>`, plus ` (+N more)` when more paths
   changed, then its task rows as `vx run` prints them, with no footer.
   Where a hit prints no row (`--all`, `--filter`, `--affected`, or
   `--output-logs errors-only` / `none`), a cycle of hits alone says
   ` N tasks cached, nothing ran`, so a cycle back to cached bytes is
   not silent below the failure before it.
   The named path is the first changed file that still exists (a
   directory only when no file changed), so an
   editor's temporary file renamed away names nothing; a deletion names
   the cycle when nothing else changed. The `watching` line is said
   once: a cycle that re-reads the watched set (a member came or went,
   the lock or a plugin changed) says nothing more; `VX_DEBUG_WATCH=1`
   says each arm on stderr as `vx watch: armed N projects`. A plugin's
   warning is said once a cycle, by the cycle's run: the watch's own
   reads of the configs say none. Errors and refusals go to stderr. The
   orchestrator is invoked again with the same options, save one: the
   `--affected` diff is read once, for the initial run. A later cycle
   runs the requested task in every project of the scope fixed at start,
   and the cache keys decide what executes (the startup diff, asked
   again, kept an edit made since out of every cycle). Events arriving
   while a run is in flight queue and drain after the current cycle.
   Re-runs are debounced ~150ms after the last event, and wait at most
   1 s after the first, so a writer that never pauses holds no edit back.
4. **Exit.** `SIGINT` (Ctrl+C) exits 0; once the cycle in flight is down, `vx watch: stopped` is the last line.

### Path filtering

Always ignored (no re-trigger):

- `node_modules/`, `.git/`, `.vx/cache/` anywhere in the path.
- A path git ignores (`git check-ignore`, asked once per debounce
  window, never per event), unless a task's inputs name it outright
  (`.env.local`, `dist/**`): invisible to every other cache key — inputs are
  tracked + untracked-not-ignored — so a cycle it started could change
  nothing. A tracked file that matches a pattern is not ignored, by
  git's own rule; outside a repository nothing is.
- Files ending in `~` (editor swap files), and `.vx/tmp/`, where
  restores stage.
- The run's **resolved cache directory**, wherever it is. `.vx/cache/` covers the
  default, but `defineWorkspace({ cache: { dir } })` and `--cache-dir` can put it
  anywhere; watching it would let vx's own cache writes trigger the next
  cycle, which writes again — a loop that never settles.
- A new empty directory (`mkdir src/new`): it holds nothing a key reads,
  and the poller, which samples files, never saw one. A file made in it
  is the change. A project directory made again, which the watch waits
  on, still is one.

Everything else triggers a cycle. We deliberately don't filter events
against per-task `inputs.files` — the cache hash is the source
of truth. A change to an irrelevant file produces a cache-hit run
(typically tens of ms); the cost is much smaller than the engineering
cost of a per-event glob match.

### How changes are seen

One recursive OS watcher (`fs.watch`) per project directory in scope,
plus the workspace root for the fingerprint files. Each watcher must
prove it delivers: a directory whose watcher reports nothing within
2 s of the probe is polled every 250 ms instead, with a one-line
notice on stderr (`no OS watch events within 2000 ms; polling every
250 ms instead`). Where the watcher is known not to deliver — a sandbox
without FSEvents access on macOS, a network mount, a container bind —
`VX_WATCH_POLL=1` polls from the start and skips the 2 s probe; the loop
says so once (`vx watch: polling every 250 ms (watch.poll)`). A
watcher the OS refuses for its watch limit (`ENOSPC`, `EMFILE`) is
polled too, with a notice naming the limit to raise. The
poller walks the same tree the event filter keeps: the always-ignored
segments and the run's declared output containers are never sampled,
unless a task's inputs can lie in one (`src/**/*.ts` beside an output
`src/**/*.js`) or git tracks a file there.
It samples each file's later clock of mtime and ctime, so a replacement
that carries the old file's mtime (`cp -p`, `rsync -a`, a `mv`) is an
edit to it as it is to the OS watcher.

### Claimed root file changes

A root file a plugin claims — a lockfile or install setting under
`@vzn/vx-lockfile` (`pnpm-lock.yaml`, `bun.lock`, `.npmrc`, …),
`turbo.json` under `turbo()` (item 961) — triggers a cycle, and so does
`.vx/projects.lock.json`. Watch mode hears them because it watches the
workspace root (non-recursively); a plugin added to the workspace
config mid-watch counts from the cycle that loads it. The keys then
decide which projects actually re-run: core keys no package file, so a
lockfile edit re-keys only through its claimant
([cache key derivation](./caching.md#cache-key-derivation)). Every
cycle's configs come from `.vx/projects.lock.json`, so a config edit
alone changes no command: the cycle it starts says so on stderr,
`vx watch: packages/app/vx.config.ts changed; runs read the lock, so run
\`vx lock\` to apply it` (a config import's edit too). A re-lock
(`vx lock`) is a cycle that re-reads the watched set (item 971).

### Constraints

The following flags are rejected (parser exits 1 before the initial
run):

- `--dry` — it skips execution; nothing to watch.
- `--profile` — would overwrite its target per cycle.
- `--verbosity <n>` (n > 0) — formats
  ONE run's result; a watch loop has no single run to report. (`--verbosity 0`
  is accepted: it asks for what watch already prints.)

A requested persistent task (`exec.persistent`, a dev server) starts
once and stays up across cycles; each cycle re-runs what it depends on,
as the cache keys decide. So `vx watch dev`, with `dev` depending on
`^build`, rebuilds only the libraries an edit reaches on the way to the
app and leaves the server running; the dev tool's own reload picks up
what was rebuilt. What the server writes keeps printing, under its id
above the rows while a cycle rebuilds. It restarts
only when its own task config (or the args forwarded to it) changed, or
when it died: the old one is stopped first (the kill grace, then
SIGKILL), so the two never hold one port. One that dies while watch
idles is said (`vx: app#dev exited with code 3`); the next change
starts it again. A cycle in which a task the server depends on fails
stops it. An edit while a cycle waits only on a server that has not
printed its `readyWhen` line stops that cycle and starts the next, so a
fix reaches a server stuck before ready, in the initial run too; the
servers already up stay up through it. A file
git does not track in the server's project that stopped the last such
cycle and is written again while the next server starts is that
server's own boot write (a timestamped config bundle, a route tree): it
stops no further cycle, so the server is not restarted for good.
Stopping watch stops the server too. A one-shot task (`vx watch build`)
re-runs itself and what it depends on.

### Exit codes

- `0` — clean Ctrl+C / SIGTERM exit. A cycle in flight is torn down
  first — its children, and the dev server held between cycles, get the
  signal watch received (a Ctrl-C as SIGINT; a SIGTERM or SIGHUP as SIGTERM),
  a 2 s grace, then SIGKILL — and the process leaves only
  once it has returned, so a CI cancellation never orphans a task.
  Also `0`, with no watch, when `--affected` selects nothing: watch
  prints `vx watch: nothing affected since <ref>` and exits as `vx run`
  does.
- `1` — parser error, missing scope, or a task name no project in
  scope declares: the initial run refuses it as `vx run` does, with the
  same `Did you mean` hint, and watch exits rather than re-run the
  refusal on every change.

A cycle that throws — no `.vx/projects.lock.json`, or one that locks a
config since removed — prints `vx watch: cycle failed: <reason>` once
and watch keeps watching, the initial run included, so the `vx lock`
that fixes it re-runs (item 1017).

Re-run cycles whose orchestrator returns `{ ok: false }` do NOT exit
the watch loop — a failed cycle just prints the framed FAILED block
and waits for the next change. This matches `turbo watch` / `nx
watch`.

## `vx cache clean`

`vx cache clean` evicts old or oversized cache entries, or with no
bound clears the cache. It operates on the entries and
`<hash>.tar.zst` artifacts of the store a run opens
(`~/.vx/<id>/cache`, shared by every checkout of the repository), or of
`<cacheDir>` itself when the workspace names one (`cache.dir`,
`VX_CACHE_DIR`, `--cache-dir`).

### Usage

```
vx cache clean --older-than <duration>     # Drop entries last used before now - duration (up to 1h slack).
vx cache clean --max-size <size>            # After age-based pruning, evict LRU until under <size>.
vx cache clean ... --dry                    # Say what either policy would reap; delete nothing.
vx cache clean ... --format json            # { dry, evicted, bytesFreed, orphans, orphanBytes }
vx cache clean ... --cache-dir <path>       # The cache a run with the same flag uses.
vx cache clean                              # No bound: clear the whole cache (below).
vx cache clean --global                     # Also clear every other repository's store.
```

### Examples

```
$ vx cache clean --older-than 30d
✓ vx cache clean  freed 1.3 GB

  42 entries

$ vx cache clean --older-than 30d      # after a SCHEMA_VERSION bump
✓ vx cache clean  freed 1.3 GB

  42 orphaned artifacts

$ vx cache clean --older-than 30d --dry
› vx cache clean  would free 1.3 GB (dry run)

  42 entries · 3 orphaned artifacts
```

### Options

| Option                    | Meaning                                                  |
| ------------------------- | -------------------------------------------------------- |
| `--older-than <duration>` | drop entries last used before now minus the duration     |
| `--max-size <size>`       | then evict the least recently used until under the size  |
| `--dry`                   | say what would go; delete nothing                        |
| `--global`                | with no bound, also clear every other repository's store |
| `--format json`           | the result as one object                                 |
| `--cache-dir <path>`      | the cache a run with the same flag uses                  |

Both bounds may be combined: age-based eviction runs first, then LRU eviction if the
total is still over the size cap. No run evicts anything: to bound the
cache, run this from a schedule or CI.

A clean with a bound also drops run
history and hash memos older than 30 days; a run never does.

Both flags take either form: `--older-than 30d` or `--older-than=30d`.

**Duration units**: `ms`, `s`, `m`, `h`, `d`, case-insensitive, except
minutes, which are `m` only: `1M` is refused, since some tools read it
as a month. Examples: `30d`, `24h`, `60m`, `30s`, `30D`.

**Size units**: `K`, `M`, `G`, `T` (powers of 1024), case-insensitive, with an optional `B` or `iB` (`512MB`, `32KiB`).
Optional `B` suffix is accepted. Examples: `500M`, `1G`, `100K`, `2T`,
`500MB`, `1gb`. A bare number is refused here: `--max-size 10` would
read as ten bytes and evict nearly everything, and nobody means that —
write `10G`, or `10B` when bytes really are the unit.

**A zero bound is rejected.** `--max-size 0` and `--older-than 0d` would
evict every entry in the cache, which is far more often a
computed-to-zero retention than an intent. `vx cache clean` with no
bound clears the whole cache when that is really what you want.

### Orphans

After eviction, prune sweeps the cache directory for **orphans**: an
artifact (a `<hash>.tree` directory, or a `<hash>.tar.zst`) the index
has no row for (a `SCHEMA_VERSION` bump drops every table and leaves
the artifacts behind, as a deleted `cache.db` does) and a
`<hash>.tree.tmp-*` or `<hash>.tar.zst.tmp-*` a save that crashed never
renamed. A run that asks for an orphan's key indexes it again from its
bytes and hits; one no task asks for again is only reclaimed here. The
policy judges a row-less artifact as it judges an entry, by its file
time plus an hour (a hit renews a file time over an hour old): another
vx version sharing the store may still use it. A temp goes once it is an
hour old; nothing younger than an hour is taken. Only the names vx writes are taken:
`<hash>` is the key's 16 lowercase hex digits and the temp suffix is
the one a save makes, so a `release.tar.zst` beside the index in a
`cache.dir` you share is never touched (item 968). The converse, an
index row whose artifact is gone (deleted by hand), is dropped by the
same prune, and its bytes count toward neither `--max-size` nor the
evicted total: they are on no disk, and counting them evicted real
entries to make room for them (item 975). A row used within the hour
is kept until a later prune, but its bytes are left out all the same
(item 1081). The sweep runs on every prune, under
either flag, and reports separately from the policy's evictions.

### `--dry`

`--dry` picks the victims under the same policy and counts the
orphans the sweep would take, then returns without touching the index
or the directory; the real prune with the same flags reaps exactly what
it named (an in-flight save aside). On an index an earlier vx wrote,
which the real prune resets first, it reads the index as that reset
leaves it: the shared store's entries still face the policy, and every
artifact in the workspace's own directory is row-less, judged by the
policy on its file time (item 1083).

### Concurrent runs

A prune that deletes waits for a `vx run` on the same workspace to
finish first (the run's lock; it says `[vx] waiting for another vx run
(pid N) on this workspace to finish…` after a second), so it never
evicts what that run is restoring. One started by a task of that run
is refused instead: the run holds the lock until the task ends. A run it cannot see — another
workspace sharing the `--cache-dir` — survives a prune anyway: an
artifact that vanishes before its restore is a miss, and the task runs
([caching](./caching.md#concurrent-runs)).

### Which cache

`vx cache clean` resolves the workspace root from cwd and honors a
`defineWorkspace({ cache: { dir } })` override — it prunes the same
directory a run would use. `--cache-dir <path>` (cwd-relative, as on
`vx run`) names another one, so a run that wrote elsewhere can be
pruned there.

### Other subcommands

`clean` is the only `vx cache` subcommand: the statistics other runners
put under a `cache` verb — the directory, the entry count, the size —
are part of [`vx info`](#vx-info), and `vx cache stats`, `list`, `ls`,
`gc` and their neighbours say so (`list` also names `vx last --list`;
`clear`, `purge`, `reset` and `wipe` name a bare `vx cache clean`) rather than printing a bare "unknown subcommand".
Clean's flags typed without the verb (`vx cache --older-than 30d`)
name the whole command they make: `vx cache clean --older-than 30d`.

### With no bound: clear the cache

`vx cache clean` with neither `--older-than` nor `--max-size` clears
the whole cache: the cache directory (`.vx/cache`, or `cache.dir` /
`--cache-dir`: the index and this workspace's run history, so `vx last`
and `vx why` start over), the store a run opens and the one its index
last named, if another (a changed HOME, an origin added), where the
entries live (`~/.vx/<id>/cache`, shared by this repository's
checkouts, so their entries go too). `--global` also clears every other
repository's store under `~/.vx` (`~/.vx/*/cache`); it takes no bound
and no `--cache-dir`. `.vx/workspace.ts`, the lock and `.vx/.gitignore`
sit outside them and stay; a `cache.dir` that holds them (`.vx`, the
workspace root) is refused. A `cache.dir` you named may be shared
(`build/`, `~/.cache`), so there only what vx wrote goes (the index,
its artifacts, run history, its `*` `.gitignore`); your own files stay,
and the directory goes only if that empties it. A directory with no
`cache.db` is not a vx cache and is left alone, and the store an index
names goes only if it is one (`.vx/<id>/cache` holding a `store.db`): the
index is a file in the checkout, which a commit or a restored CI cache
could point at any directory. A workspace that never ran says
`› vx cache clean  nothing to free`. The next run misses every task once
and saves again.

A `.vx/cache` linked to another directory (a CI cache volume) is
emptied through the link, and the link stays. An index SQLite cannot
read is cleared like any other.

```
$ vx cache clean
✓ vx cache clean  freed 1.4 GB

  .vx/cache
  /home/me/.vx/3f2a9c01b4d5e6f7/cache

$ vx cache clean --global --dry
› vx cache clean  would free 3.1 GB (dry run)

  .vx/cache
  /home/me/.vx/3f2a9c01b4d5e6f7/cache
  /home/me/.vx/9b8e7d6c5a4f3e2d/cache
```

It waits for a `vx run` on this workspace to finish first (the run's
lock), as a trim does. With `--format json` it prints
`{ dry, cleared, bytesFreed }` (`schemas/cache.json`), `cleared`
listing the directories.

### Exit codes

| Code | When                                                                                                                                                                                                                        |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | pruning completed (zero or more entries evicted). A workspace that never ran has no cache, nor does a directory holding nothing vx wrote (`--cache-dir build`): `› vx cache clean  nothing to free`, and nothing is created |
| `1`  | parse error, missing policy, or workspace-discovery error                                                                                                                                                                   |

## Runs read the lock

Every run, `vx watch` cycle, `--affected` selection and the picker takes
its projects and their configs only from the committed
`.vx/projects.lock.json` (2026-10-14). A run never walks for
configs, never evaluates one, never checks the graph rules
(`run.rules`) and never writes the lock: only `vx lock` does. With no
lock, a run fails with `no lock: run \`vx lock\``. A run trusts the
lock: it performs NO staleness check, so after adding or editing a
config, run `vx lock`. In a pipeline, `vx lock --check` first re-evaluates every
config and checks the rules.

## `vx lock`

`vx lock` evaluates every `vx.config.*` and writes the resolved configs
to `.vx/projects.lock.json`. Runs read the lock, never the configs:
after you edit one, run `vx lock` and commit the lock.

### Usage

```
vx lock              # Evaluate all vx.config.* now; write .vx/projects.lock.json.
vx lock --check      # Audit: full re-evaluation vs the lock. Exit 1 on drift.
vx lock --check --format json   # The audit as {upToDate, audited, notAudited, problems}.
```

### Example

```
$ vx lock
✓ vx lock  2 project configs → .vx/projects.lock.json
$ vx lock --check
✓ vx lock --check  up to date (2 projects)
```

After an edit the lock has not seen:

```
$ vx lock --check
✗ vx lock --check  packages/lib/vx.config.ts evaluates differently from the lock here — its config, a file it imports, or the environment it reads changed; run 'vx lock'
```

### When to run it

Run `vx lock` and commit `.vx/projects.lock.json` after
editing any `vx.config.*` or `.vx/workspace.*`, after updating
dependencies or plugins, and after changing a file a config imports.
Runs read their configs from the lock, so until then they keep the old
ones. `vx lock --check` as CI's first step fails a stale lock.
The full workflow: the site's CI guide and `examples/ci`.

### Options

| Option          | Meaning                                                            |
| --------------- | ------------------------------------------------------------------ |
| `--check`       | re-evaluate every config and compare with the lock; writes nothing |
| `--format json` | with `--check`, the audit as one document                          |

### What it writes

`vx lock` finds every project and freezes each one's **resolved** config into
`.vx/projects.lock.json` at the workspace root. A project is a directory
holding a `vx.config.*`, in any language: `vx lock` lists them with git
(`git ls-files`, tracked and untracked, git's ignore rules applied; a
nested repository's own configs too), or walks the tree outside git
(every directory but `.git` and `.vx`), and leaves out any under a
nested `.vx/workspace.*`, even one the ignore rules hide, or under a
`node_modules` (an installed package is no project, ignored or not). Configs are
programs; `vx lock` evaluates them in the current environment and
stores the post-evaluation objects, by directory (version 4; a lock an
earlier vx wrote is refused, "re-run `vx lock`"). A project is named by
its config's `name`, else by a plugin's `discover` stage (vx-lockfile
gives `package.json`'s `name`), else by its root-relative path (`//` for
the root); two projects of one name are refused naming both
directories. The plugin `discover` stage runs here as in a run, and may
add directories (X-143). Before writing, it
builds the graph of every task the workspace declares, `graph` stage
included, and checks the graph rules (`run.rules`), which no run
checks, `dependencies` (which projects a project may depend on,
`VX_E_DEPENDENCY_RULE`) among them, and refuses a task glob whose
bracket class spells a path that exists (`app/[id]/**` beside the
directory `app/[id]`; write `app/\[id\]/**`): a broken one prints `✗ vx lock  lock not written`
with the rule's refusal under it and writes nothing.

`.vx/projects.lock.json` is minified: it is the one file vx reads, and it loads
faster that way (10,000 projects: 15.6 ms against 22.5 ms pretty). For
review, `vx lock` also writes each project's resolved config (plugins
applied), pretty, to `vx.lock.json` beside its `vx.config`; vx never reads
it, it is no task's input, and `lock.reviewFiles: false`
(`VX_LOCK_REVIEW_FILES`) turns it off. `vx lock` also writes
`.vx/.gitattributes` (`projects.lock.json linguist-generated=true`) when it is
missing, so GitHub collapses the machine lock in a diff; `vx init` does
too, and an existing one is never edited.

A project with no `vx.config.*` — its tasks from a plugin's `project`
stage (`turbo()` from `@vzn/vx-migrate`), or none at all — has nothing
to freeze: the lock records nothing for it, `--check` does not audit
it, and a run still loads its tasks live. Both verbs name such
projects that have tasks (`0 project configs → .vx/projects.lock.json (no
vx.config, so not locked: app, lib)`, five names then `and N more`),
so an empty lock on a plugin-only workspace never reads like an audit.
One with no task (core's default `build` aside) is not named.

The lock is committed, so `vx lock` refuses to write one that holds a
secret: a config that evaluated to the value of a secret-named variable
(or one a task lists in `exec.env.secret`), say
`` `--token ${process.env.API_TOKEN}` ``. It names each place
(`a: tasks.deploy.exec.command holds $API_TOKEN`) and writes nothing.
Masking it instead would freeze a `***` that every run runs. Let the
shell expand it: `$API_TOKEN` in the command, the name in
`exec.env.passThrough` (L-42).

The review copies are written before the lock: one that cannot be
written (a directory in its place, a read-only file) is named and the
lock is left as it was.

### How runs read it

Every run consumes it: configs come from the
lock with no evaluation, no staleness check and no schema validation
of its entries, which `vx lock` validated when it wrote them (frozen-env
semantics: env reads in a config keep their lock-time values; a
locked directory whose config file is gone (X-144) or that this user
may not search (EACCES, named as such), or a missing lock, is a hard error; a config added since the lock is no project until
`vx lock`, and naming its task, `c#build`, says so: "c#build: c/vx.config.ts
is not in the lock yet — run `vx lock`", as a run from its directory says
`c/vx.config.ts is not in the lock yet`, where it ran the locked project
around it, and so does `--filter ./c`; so does a bare `build` that the
cwd's project or a `--filter` leaves unresolved while one of the
selected projects holds such a config). An entry edited by
hand into a shape `vx lock` could not write fails the run with
`.vx/projects.lock.json is invalid, run \`vx lock\``, checked only once
something has crashed, so a normal run pays nothing for it.

### `--check`

`--check` is the audit: it re-evaluates every config in the current
environment and `Bun.deepEquals`-compares it with the frozen object. A
project that differs gets one message, whether its config, a file it
imports or the environment it reads changed. A lock an earlier vx wrote,
or one that is not valid JSON, is a problem the audit names (a
`problems` entry under `--format json`, not a refusal) and asks for `vx lock`. Every config that does
not load is named, as `vx lock` names them: each with its line and frame,
and root-relative under `--format json`. It also checks the graph rules over the configs as they
evaluate now, and that each `vx.lock.json` is what its project resolves to
here, and that none is left where a `vx.config` was deleted, the
directory still a project or not (delete that one yourself: vx never
deletes a committed file; `vx lock` names it too, as a warning; one
already gone from disk, that git still lists, is not named), unless `lock.reviewFiles` is off. The CI recipe is `vx lock --check && vx run …`.
`vx lock` and `--check` also warn of a config file another one beside
it hides (`vx.config.ts` and `vx.config.mjs` in one directory, or two
`.vx/workspace.*`): precedence reads the first, and an edit to the
other changes nothing. The warning does not fail `--check`.
`--format json` prints the audit as one document
(`schemas/lock.json`, exit code unchanged; a missing lock is one of
its `problems`); it answers `--check` only.
Full design: `docs/design/config-lock-2026-06.md`. A lock written by a
1.x vx stays valid for every later 1.x (`tests/contract-lockfile.test.ts`).

### Exit codes

| Code | When                                                                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | lock written / lock is up to date                                                                                                                                             |
| `1`  | parse error, workspace-discovery error, missing lock (`--check` without one), any drift (every mismatched project is listed on stderr), or a secret value the lock would hold |

## Releasing (maintainers)

Releases are on demand. Dispatching `auto-release.yml` releases a
commit on `main` whose CI went green: the `sha` input, or by default the
newest such commit; one CI did not pass on is refused. Claude dispatches
it at least once a day when `main` has changes, after merging that
release's blog post (`.claude/skills/release/SKILL.md`), and shares the
post on Bluesky. The workflow tags the commit with the next version and
creates the GitHub release, both from the Conventional Commits since the
last tag (`scripts/release-notes.ts`, run by the `release.auto` task,
`scripts/auto-release.ts`). The release is created as a draft: this
repo's releases are immutable and take assets only before they are
published, so `release.yml` publishes it after its last upload. The version: below 0.1.0 always a
patch (cutting 0.1.0 is the owner's, by hand); then before 1.0 a `feat`
or a breaking change (`type!:`, a `BREAKING CHANGE:` footer) is a minor
(`v0.4.2` → `v0.5.0`) and anything else a patch (`v0.4.3`); from 1.0 a
breaking change is a major. The notes: breaking changes first, then
`feat`, `fix` and `perf`, the rest counted. It then
dispatches `release.yml` (with `tag`) and
`npm.yml` (with `version` and `ref`). A release made with the workflow
token fires no `release` event in other workflows, which is why the two
are dispatched rather than triggered. A commit is released only when the
last release is its ancestor, so an older tree never gets a higher
version, and one that already carries a `v*` tag is a no-op.

A version can still be cut by hand: push its tag (say `v1.0.0`),
create a draft release for it, and dispatch `release.yml` (`tag`) and
`npm.yml` (`version`, `ref`); the next auto-release continues from it.

A GitHub release publishes everything: `release.yml` builds the four
binaries, proves the darwin ones on macOS (re-signed ad hoc only where
macOS refuses one) and attaches them; `npm.yml`
builds the fifteen npm packages (`@vzn/vx`, one per platform, and every
other public package: the plugins, the servers, `@vzn/vx-devtools`) and publishes them with **npm trusted
publishing** — the job's OIDC token
is exchanged for a short-lived credential and provenance is attached,
so no long-lived npm token exists anywhere. Both publish loops skip a
package already on the registry, so a re-run (`npm publish` →
_Run workflow_ with the version) resumes where it stopped. That dispatch
also takes a `ref`: it runs the workflow from the default branch against
the code that ref names, so a release whose publish died on a workflow
bug is completed by the FIXED workflow building the tag's own source
(`version: 0.0.20`, `ref: v0.0.20`) — re-running the failed run itself
would replay the broken file, which is pinned to the tag.

Every step of the three workflows past the setup (checkout, Bun, Node,
`bun install`, the runner action) is one vx task: CI runs no command of
its own (2026-10-03), and `tests/workflow-runner.unsafe.test.ts`
holds it. The tasks are `@vzn/vx`'s `release.*`, all uncached and in no
`ci` graph:

| Task                    | Does                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `release.stamp`         | writes `VX_RELEASE_VERSION` into `packages/vx/package.json`, the manifest the binary inlines                                             |
| `release.npm`           | checks npm can publish with provenance (>= 11.5.1, `sigstore` loads); else installs npm into `dist/npm-cli/`                             |
| `release.prove.<os>`    | launches the host's binary (re-signed only if macOS refuses it) and asserts `vx <version>`; on darwin, launches both (x64 under Rosetta) |
| `release.assemble.<os>` | emits the platform packages under `dist/npm` (linux: also `@vzn/vx` and the plugins)                                                     |
| `release.publish.<os>`  | `npm publish --provenance` each in order, skipping one the registry holds                                                                |
| `release.served`        | waits (up to 10 min) until npm's CDN answers 200 for every published tarball: it 404ed v0.0.646's for minutes, failing installs          |
| `release.upload.<os>`   | attaches `dist/vx-<os>-*` the draft release lacks; darwin's then publishes it                                                            |
| `release.auto`          | decides the version, creates the draft release with its notes, dispatches the two workflows                                              |

The version reaches them as `VX_RELEASE_VERSION` (the tag or the
dispatch input) and each refuses one that is not a version. Every one
is sandboxed: the publish is granted the registry, the OIDC token host
and Sigstore, the GitHub-Actions variables npm reads, and `~/.npm`;
`release.auto` reads `.git` and reaches `api.github.com` with `GH_TOKEN`;
`release.upload.<os>` reaches it and `uploads.github.com`.
A dispatch with `ref` builds that ref's code, so it must hold these tasks.

Every Linux job that runs a task runs `vx setup github` (`@vzn/vx-ci`)
before its first `vx run`: every task in this repo declares `exec.sandbox`, and a
declared sandbox whose runtime is missing is a hard error, not a
downgrade — the compile tasks fail in 0 ms saying which of bubblewrap,
socat and ripgrep is absent. v0.0.20 shipped its darwin packages and
then stopped exactly there.

One-time setup, per package, on npmjs.com → package → Settings →
Trusted Publisher → GitHub Actions: owner `vznjs`, repository `vx`,
workflow `npm.yml`, environment left blank. Do this for `@vzn/vx`,
`@vzn/vx-darwin-x64`, `@vzn/vx-darwin-arm64`, `@vzn/vx-linux-x64`,
`@vzn/vx-linux-arm64` and the six plugins: `@vzn/vx-ci`,
`@vzn/vx-lockfile`, `@vzn/vx-migrate`, `@vzn/vx-otel`,
`@vzn/vx-reapi` and `@vzn/vx-history`.

Each platform package carries `LICENSE` and `THIRD_PARTY_NOTICES.txt`:
the binary embeds Bun and npm code whose licenses must travel with it.
The GitHub release carries the same file as an asset beside the binaries.
`tests/dependency-licenses.unsafe.test.ts` holds every published package's
production dependency closure to permissive licenses (MIT, ISC, BSD,
Apache-2.0, 0BSD, or a dual license offering one).
After a dependency or Bun bump, `bun packages/vx/scripts/third-party-notices.ts`
regenerates the notices; `tests/third-party-notices.unsafe.test.ts`
fails until it does.

The plugins ship as the TypeScript source Bun runs, at the release's
version, with `@vzn/vx` as a peer on the same minor (`^<version>`).
`scripts/build-npm.ts --only=plugins` emits every public workspace
package other than `@vzn/vx`, so a new plugin package is published
without a workflow edit, and `tests/build-npm.unsafe.test.ts` holds the
set. If npm will not add a trusted publisher to a name that has never
been published, publish that plugin once by hand from an owner's
account (`npm publish dist/npm-plugins/plugins/<dir> --access public`
after a `build-npm.ts <version> --only=plugins --out=dist/npm-plugins`
build), then add the publisher. Then
delete the `NPM_TOKEN` repository secret:
the workflow no longer reads it, and npm restricts classic tokens for
direct publishing (the `E401 token is invalid` that stopped v0.0.17).
Every `uses:` in both workflows is pinned to a commit SHA with the
version in a comment; bump the SHA and the comment together.

## The workspace root

Every verb works on one workspace: the directory whose `.vx` holds the
nearest `.vx/workspace.ts` (or `.mts`, `.js`, `.mjs`, `.cts`, `.cjs`) from
the working directory up. vx never looks above the git top-level (a
worktree is its own, a submodule's too; a submodule, its `.git` a file
or a directory, looks on into its superproject), and
outside git it looks up to `/`. Nothing else marks the root: not a
`package.json`, `pnpm-workspace.yaml` or a lockfile (2026-10-13).
Without one, every verb but `vx init` stops with `VX_E_NO_WORKSPACE`;
`vx init` writes one (`@vzn/vx-migrate` beside a `turbo.json` or
`nx.json`). A project inside the
root is a directory holding a `vx.config.*`, which `vx lock` finds
(see [`vx lock`](#vx-lock)); a `discover` plugin adds others.

## Which vx runs

A global vx (installed with a package manager, or a compiled binary
installed by hand) hands every call to the project's own `@vzn/vx` when
there is one, so a project runs the version its lockfile pins
(2026-10-13). There is no opt-out. The workspace root's
`node_modules/@vzn/vx` runs, through its
`node_modules/.bin/vx`. One hop: the receiving vx sees `VX_HANDED_OFF`
and does not look again. A vx never hands off to itself (the same
package, a pnpm symlink included), nor to a `.bin/vx` another user owns
(one planted above your checkout would run as you). An npm install's launcher does the
walk in the shell, a test per level and no fork, and `exec`s the local
vx; the compiled binary checks one path per level before it loads
anything, then runs the local vx with its stdio, passes on a signal sent
to it alone, and exits with its code. From source (`bun src/bin.ts`) vx
never hands off.

`vx --version` says when it was handed the call (`vx 0.0.640
(/repo/node_modules/@vzn/vx-linux-x64/vx, handed off from
/usr/local/bin/vx)`), and `vx info` shows the file that ran and who handed off
(`vxPath`, `handedOffFrom`).

## `vx upgrade`

`vx upgrade` brings vx to a newer release (`vx upgrade TAG` pins one, `v0.4.0` or
`0.4.0`; default latest; a second tag, or one that is no version, is
refused first, not dropped), the way
it was installed. Named `upgrade` per CLI convention (`bun upgrade`,
`deno upgrade`). Refuses when running from source: use `git pull`.

### Usage

```
vx upgrade [TAG] [-g|--global]
```

### Examples

In a project whose `package.json` lists `@vzn/vx`, beside a `bun.lock`:

```
› vx upgrade  0.0.1 → 0.0.2

  bun add @vzn/vx@0.0.2 in /repo
```

From a global vx in that project, both move:

```
› vx upgrade  project 0.0.1 → 0.0.2

  bun add @vzn/vx@0.0.2 in /repo

› vx upgrade  global 0.0.1 → 0.0.2

  /usr/local/bin/vx

✓ vx upgrade  global installed 0.0.2
```

### Options

| Option           | Meaning                                                     |
| ---------------- | ----------------------------------------------------------- |
| `TAG`            | the release to install, `v0.4.0` or `0.4.0`; default latest |
| `-g`, `--global` | move only the global vx, below                              |

### A binary installed by hand

A compiled binary installed by hand replaces itself. It reads its
platform package (`@vzn/vx-<os>-<arch>`) from the npm registry and
checks npm's registry signature over `<name>@<version>:<integrity>`
against npm's signing key, pinned in vx (key id
`SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U`), then the
tarball's SHA-512 against that signed integrity, and only then extracts
`package/vx`, stages it in a fresh directory beside the binary and
renames it over. The host that serves the tarball cannot make that
signature, so a swapped tarball, or a document with a swapped integrity,
is refused: `the npm registry signature for … is not valid — refusing
to install; nothing replaced`, or `the download did not match the
integrity npm signed … nothing replaced`. A release signed with a key
id vx does not pin says so: `… is signed with an npm key this vx does
not know (…) — if npm rotated its signing key, this vx's installer
needs updating`. A release with no signature or no integrity is refused
before the download, and so is a signed release of another version than
the `TAG` asked for (`the npm registry answered …@<TAG> with version …`):
npm signs its old releases too. `latest` below the running vx is refused
(`… is 0.3.0, below this vx's 0.4.0`); go back by naming the version.
Every refusal comes before anything is written.
There is no fallback to GitHub's release digest: when the registry is
unreachable, the upgrade is refused.

### Which registry

`vx upgrade` and `vx init` read releases from the registry your package
manager uses, so a company that blocks registry.npmjs.org and serves a
mirror needs no extra setting. The first that names one wins:

1. `@vzn:registry` in a `.npmrc`
2. `npm_config_registry` in the environment
3. `registry` in a `.npmrc`, the nearest from the working directory up,
   then the user's (`~/.npmrc`, or `npm_config_userconfig`)
4. bunfig.toml's `[install.scopes]` `vzn`, then `install.registry`, the
   nearest from the working directory up, then `~/.bunfig.toml`
5. registry.npmjs.org

The credential configured for that registry (`//<host>/<path>/:_authToken`
or `:_auth` in a `.npmrc`, `token` or user and password in bunfig, with
`${VAR}` read from the environment) is sent to URLs under it only. A
mirror must pass on npm's signature: the check above does not change.

A host it cannot reach (no route, a proxy that is down) is one line,
`could not reach registry.npmjs.org to read the release (…) — check the
network or the proxy and re-run`, never a stack; so is a document cut
after the headers or not JSON (a captive portal's page served with a
200), and a tarball cut the same way. A binary whose directory this user
cannot write (a root-owned `/usr/local/bin`) is refused before the
download: `cannot write to <dir> (EACCES), where this vx lives — nothing
downloaded; re-run as a user who can (sudo vx upgrade), …`. The new
binary keeps the old one's mode (and, as root, its owner), and must
answer `--version` before the upgrade reports it installed: one that
does not start on this machine, or does not answer within 10 s, is
swapped back for the previous vx, and the command exits 1 saying so
(item 1097): `✓ vx upgrade  installed 0.0.2`. On the version it
already is it says `› vx upgrade  already at <version>` and downloads
nothing.

### A package manager's install

A vx a package manager installed (the npm package's launcher runs
`…/node_modules/@vzn/vx-<os>-<arch>/vx`) is upgraded by that package
manager, never by a rename over its file, which the next install would
undo. The path names the install:

| Install                | Detected by                           | Runs                          |
| ---------------------- | ------------------------------------- | ----------------------------- |
| npm global             | `<prefix>/lib/node_modules`           | `npm install -g @vzn/vx@<v>`  |
| pnpm global            | `…/pnpm/global/…`                     | `pnpm add -g @vzn/vx@<v>`     |
| bun global             | `~/.bun/install/global`               | `bun add -g @vzn/vx@<v>`      |
| yarn global            | `…/yarn/global/…`                     | `yarn global add @vzn/vx@<v>` |
| a project's dependency | the package.json that lists `@vzn/vx` | its manager's add, same field |

A project's package.json is the tree's root, or for a hoisted workspace
the nearest one above the current directory that lists `@vzn/vx`. Its
manager is its lockfile (`pnpm-lock.yaml`, `bun.lock`, `yarn.lock`,
`package-lock.json`), else `packageManager`, else npm; the field it is
listed in is kept (`--save-dev`, `--dev`, …), pnpm at a workspace
root adds `--workspace-root`, and Yarn 1 there adds `-W`. The lockfile
is updated by that manager.
Every `@vzn/vx-*` plugin the same package.json lists from the registry
moves in the same install, to the same release, since every @vzn
package releases together: `pnpm add @vzn/vx@0.0.2 @vzn/vx-otel@0.0.2
--save-dev`. A plugin left behind is installed even when core is
already at the release (`› vx upgrade  plugins → 0.0.2`); a plugin in
another field than core is refused, so no install moves a dependency's
field. The versions are pinned, so pnpm's `minimumReleaseAge` refuses a
release too young rather than mixing releases, and the error names
`minimumReleaseAgeExclude`. vx prints what it runs, runs it there, and
exits with an error if it fails:

### A project's vx and the global one

Inside a project with its own vx, a global vx hands `vx upgrade` to
the project's (§ Which vx runs), and one run moves both to the same
version (`TAG`, or latest): first the project's dependency, then the
global vx that started the run, each the way it was installed. Each
line names its install, and a refusal names the one that failed
(`vx upgrade: global vx /usr/local/bin/vx: cannot write to …`); a
project that fails leaves the global as it was. The project's vx run
directly (a package script, `node_modules/.bin/vx`) has no global behind it, so only
the project moves.

`vx upgrade -g` (`--global`) moves only the global vx, wherever it
runs: it never hands the call to a project's vx, and it never touches a
`package.json` or a plugin. Run as the project's own vx, it refuses:
`vx upgrade -g: no global vx ran — <path> is the project's own. Install
one (bun add -g @vzn/vx), or run \`vx upgrade\` to move the project's`.

### After the upgrade

After an upgrade that installed something, inside a workspace, the new
vx runs `vx lock` at the workspace root, since a release may record the
lock differently (an npm global install's own binary, which keeps its
path). A lock that fails, or a new vx that does not start, leaves the
upgrade done and prints
`vx upgrade  vx lock failed: run vx lock`. `vx upgrade -g` never locks.

vx never installs Node or a package manager: one not on `PATH` is refused with the command to run. A vx run from a
`bunx` cache has nothing installed to upgrade, and says to ask for
`@vzn/vx@latest` instead.

### Exit codes

| Code | When                                                                                                                                                                                                                                          |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | installed, or already at that version                                                                                                                                                                                                         |
| `1`  | anything refused or swapped back: from source, a cache install, a host it cannot reach, a directory it cannot write, a signature or integrity that does not verify, a binary that does not start, a package manager that failed or is missing |

## `vx init`

`vx init` sets up vx in a repository: it installs `@vzn/vx`, writes
`.vx/workspace.ts` and a root `vx.config.ts`, and writes the lock. In a
Turborepo or Nx repo it maps their config instead.

### Usage

```
vx init [--dry [--format pretty|json]] [--force] [--mjs] [--native|--keep] [--plugin <hook>]
```

### Example

```
$ vx init --dry

─ vx init 0.0.0 ──────────────────────────────────────────────
  from      no turbo.json or nx.json: one project, the root
  dry run   nothing written
  files     .vx/workspace.ts
            vx.config.ts
            .vx/.gitignore
            .vx/.gitattributes

  next      declare a task in vx.config.ts, then vx lock && vx run <task>
```

### Options

| Option               | Meaning                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `--dry`              | print the files; write nothing                                            |
| `--format json`      | with `--dry`, the plan as one document                                    |
| `--force`            | replace a file already there                                              |
| `--mjs`              | write `.mjs` files instead of `.ts`                                       |
| `--native`, `--keep` | in a Turbo or Nx repo: a `vx.config.ts` per package, or keep their config |
| `--plugin <hook>`    | write a plugin for that hook instead, below                               |

### Install

`vx init` first installs `@vzn/vx` globally (the package manager that
ran it, else Bun, also under Yarn 2+, which has no `yarn global`;
skipped when the `vx` on `PATH` is already that
version) and, under the topmost `package.json`, as a root
devDependency with that repo's own manager (2026-10-20). The latest
version is read from the registry that manager is configured for
([Which registry](#which-registry)). A failed install stops init.

### In a Turborepo or Nx repo

When the directory it runs in, or one above it up
to the git top-level, holds a `turbo.json`, `turbo.jsonc` or `nx.json`,
it runs `@vzn/vx-migrate` there, so `vx init` is the one command
(2026-10-08): the latest release through `bun x`,
never an installed one, so init always installs the latest `@vzn/vx`
and moves every `@vzn/vx-*` plugin the root lists to it
(2026-10-16; a source checkout runs the nearest installed
`node_modules/@vzn/vx-migrate` instead) (`BUN_BE_BUN=1` makes the compiled
binary that runtime). `--dry`, `--format`, `--force`, `--mjs`,
`--native` and `--keep` pass through, and the exit is vx-migrate's.
vx-migrate maps the Turbo or Nx repo, one `vx.config.ts` per package; writes the workspace file with
the plugins the repo calls for (the lockfile's, a remote cache the repo
shows); installs them; and ends with `vx lock`. Its README holds the
rules; [`bunx @vzn/vx-migrate`](#bunx-vznvx-migrate) below sums them up.

### In any other repo

With none of those files, it writes a workspace whose one project is
the root, at the nearest workspace root up from the working directory,
else at the topmost `package.json` in the git work tree, else there.
Outside git it is the nearest `package.json`, or an outer one that
declares a workspace, never a stray one above (the report names it
under `root` when it is not the working directory):

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

Beside a lockfile at that `package.json` (`pnpm-lock.yaml`, `bun.lock`,
`yarn.lock`, `package-lock.json`), the workspace declares its
`@vzn/vx-lockfile` plugin (`plugins: [bun()]`), installed beside
`@vzn/vx`, so a package's `^build` has project edges.

plus `.vx/.gitignore` and `.vx/.gitattributes`. It then runs `vx lock`'s
step, and `next:` says to declare a task and run `vx lock && vx run
<task>`, preceded by `git init` outside a git work tree. Where that
`package.json` has scripts, or declares a workspace (`workspaces`,
`pnpm-workspace.yaml`), `next:` first names `bunx @vzn/vx-migrate`,
which makes each package's scripts its tasks; it maps over the root
`vx.config.ts` init wrote while that file is unchanged. The `@vzn/vx`
import needs no install: the running vx serves its own core to that
specifier (bin.ts registers the alias). A file already there is kept
and named under `kept`; `--force` replaces it, a file of another
extension included (`replaced`). `--mjs` writes `.vx/workspace.mjs` and
`vx.config.mjs`. `--dry` prints the files and writes nothing;
`--dry --format json` prints the plan as one JSON document
(`schemas/init.json`): `files` (each path and its whole text), `kept`,
`replaced`, `todos`, `notes`, `next` and `installs` (the install
commands the real run runs). `--native` and `--keep` answer
a Turbo or Nx repo's question, so they are refused here. `--format json`
without `--dry`, or with `--plugin`, is refused (`VX_E_USAGE`).

### `--plugin`

`vx init --plugin <hook>` writes a plugin instead: `plugins/<hook>.ts`,
a small runnable plugin for that hook (`executor`, `cache`,
`telemetry`, `schedule`, `admit`, `commands`, `project`, `graph`,
`key`), and `plugins/<seam>.test.ts`, which drives it through `run()`
(`bun test`, with `@vzn/vx` installed). A plugin is named by the
nearest `package.json`; when that one has no name (a monorepo root
often has none), it also writes `plugins/package.json` naming the
plugins `workspace-plugins`, or `definePlugin` would refuse them. It prints the line that
declares it in the workspace file a run reads (`.vx/workspace.ts` when
there is none). The templates are TypeScript, so `--mjs` with
`--plugin` is refused, and so is a second seam. An existing file is refused without
`--force`; `--dry` names the files and writes nothing. The two files are
`private/vx-plugin-examples/plugins`, which the gate runs, copied into
core (`src/cli/plugin-templates.ts`) and held equal by
`tests/plugin-templates.unsafe.test.ts` (H-21).

### Exit codes

| Code | When                                                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | the files written (or, with `--dry`, printed)                                                                                                                                                                 |
| `1`  | a refused flag, a parse error (`--mjs` with `--plugin` among them), a plugin file already there without `--force`, or the lock not written (the files stay). Handed to `@vzn/vx-migrate`, the exit is its own |

## `bunx @vzn/vx-migrate`

Mapping a repo's own config to vx is `@vzn/vx-migrate`, its own
package, run before a workspace file exists (it writes one); `vx init`
runs it in any repo with a `package.json` —

```
bunx @vzn/vx-migrate           # turbo.json, an Nx graph, vite-plus run.tasks, else package.json scripts → vx.config.ts (vx init hands it only Turbo and Nx)
bunx @vzn/vx-migrate --dry     # print the generated files instead of writing
bunx @vzn/vx-migrate --force   # overwrite existing vx.config.* / vx-preset.ts
bunx @vzn/vx-migrate --from nx # disambiguate when several sources are checked in (turbo, nx, vite-task, scripts)
```

— In a Turbo or Nx repo it asks a terminal native (a `vx.config.ts`
per package, the default) or keep (a workspace file declaring `turbo()`
or `nx()`, which read the repo's config live); `--native` or `--keep`
answer it, and without a terminal it is native. Both declare
`turboCache()` / `nxCache()` when the repo shows a remote cache
(turbo.json's `remoteCache`, a `turbo link`ed `.turbo/config.json`, or
a CI file setting `TURBO_TOKEN` / `NX_SELF_HOSTED_REMOTE_CACHE_SERVER`),
and name Nx Cloud, whose wire vx does not speak. Elsewhere each
package's `package.json` scripts become its tasks, and the workspace
file declares the `@vzn/vx-lockfile` plugin for the root's lockfile.
What the package writes goes through core's migration seam
(`applyMigration`, exported from `@vzn/vx`), which renders, guards
against overwriting, writes and reports. The mapping rules live in the
package's README.

## Machine-readable output

`vx show`, `vx info`, `vx why`, `vx last` and `vx cache clean` take
`--format json`. Each prints one JSON document on one line, whose shape
is a checked-in JSON Schema (draft 2020-12) shipped with the package:
`schemas/show.json`, `schemas/info.json`, `schemas/why.json`,
`schemas/last.json`, `schemas/cache.json`
(`node_modules/@vzn/vx/schemas/` in an install). Every object closes its
key set, so a field vx adds is a schema change, never a surprise.
`tests/cli-json-schemas.test.ts` holds each verb's output to its schema,
each declared field to some output, and each object's keys to the
source type. `tests/cli-json-doc.test.ts` holds this page to the
schemas: each `{ … }` a verb's section shows is an object its schema
closes with those keys, each object the verb prints whole is shown, and
`vx info`'s field list is its schema's top level.

A run's result as JSON is `vx last --format json`, read after the run
from the run history: one row per task with its status, key and cache
result. `vx run --dry=json` prints the plan.

### Error codes

A verb asked for JSON (`--format json`, `--format=json`, `--dry=json`,
before any `--`) answers a refusal on stdout too, as one line that
`schemas/error.json` describes: `{"ok":false,"error":{"code","message","docs"}}`.
`docs` links the code's section below, which says what to do;
`vx docs <code>` prints that section. The exit code (1) and the
prose on stderr do not change. Branch on the code; the message may change.

#### `VX_E_USAGE`

A flag, argument, selection or `VX_*` environment value the verb does
not take. The message names it, and a close spelling the verb does take when there is one;
`vx <verb> --help` lists every flag.

#### `VX_E_UNKNOWN_COMMAND`

No verb of that name here, core's or a declared plugin's. `vx --help`
lists core's verbs. A plugin's verb exists once its plugin is in
`.vx/workspace.ts` `plugins`; a task runs as `vx run <task>`.

#### `VX_E_UNKNOWN_TASK`

No project in scope declares a requested task. The message lists the
tasks it found; `vx show --format json` lists each project's. Check the
spelling, and the scope: `--filter`, `--all`, or the project the working
directory is in. A run reads its configs from the lock, so a task
added to a `vx.config` since the last `vx lock` is not there yet: run
`vx lock`.

#### `VX_E_UNKNOWN_PROJECT`

`vx show` names a project the workspace does not have. A project is named
by its config's `name`, else by a plugin (a lockfile plugin names it from
its `package.json`), else by its directory; `vx show --format json` lists them.

#### `VX_E_NO_HISTORY`

`vx why` / `vx last` find no recorded run for what they were asked, or
`vx last --live` no run in progress. Run the task once (`vx run <task>`);
history is this checkout's own.

#### `VX_E_AMBIGUOUS`

`vx why <task>` matches the task in several projects. Name one:
`vx why <project>#<task>`. A run id that is the start of several
recorded runs (`vx last <id>`, `--run <id>`) is refused the same way:
type more of it.

#### `VX_E_CONFIG`

A `vx.config.*` or `.vx/workspace.*` that does not load, throws or is
refused. The message names the file and the field, or what the config
(or a plugin it called, such as a factory refusing an option) threw and
the line it threw at, then each `cause` it wraps (`; caused by: …`);
fix that field (`vx docs <field>` prints its reference). `vx lock`
names every project config that does not load at once. A project
config's refusal is `vx lock`'s, not a run's: a run never evaluates one.

#### `VX_E_CYCLE`

The task graph has a cycle. The message names the loop; drop one of its
`dependsOn` edges.
`vx lock` refuses it, not a run: a run trusts the graph the lock holds.

#### `VX_E_LOCK`

A run reads its configs only from `.vx/projects.lock.json`, and that
lock is missing, not one this vx reads (not JSON, another version, a
hand-edited entry), holds no entry for a project the workspace has, has
not seen a `vx.config` written since, or locks one that is gone.
Run `vx lock`, then the verb again. Commit the lock; `vx lock --check`
on CI fails one that no longer matches the configs.

#### `VX_E_NO_WORKSPACE`

No `.vx/workspace.*` in the working directory or a parent, up to the git
top-level (a file above the checkout never counts). The file marks the
workspace root, so run `vx init` to create one. Outside git, one another
user owns does not count (`security.md`); the message names it.

#### `VX_E_CACHE_VERSION`

A reading verb met a cache index from another vx version. It reads
nothing from it and leaves it be; the next `vx run` resets it. Or run the
vx version that wrote it.

#### `VX_E_REFUSED`

Any other refusal (a plugin's, a check's) with no code of its own. The
message is that plugin's or check's: do what it says.
`vx info --format json` lists the plugins.

#### `VX_E_FS`

The file system refused a read or a write, or the cache index could not
be opened: permissions, a full disk, a file where the cache directory
goes, a directory where `cache.db` goes. The message names the path. Free
space (`vx cache clean --max-size <size>` trims the cache), grant the
access, or move the path away, then re-run.

#### `VX_E_FDS`

Out of file descriptors. Raise the limit (`ulimit -n 4096`), or run fewer
tasks at once (`--concurrency`), then re-run.

#### `VX_E_AFFECTED_BASE`

`--affected` (or `--affected=<ref>`) has no base to diff against: the
ref does not resolve, is a range (`A..B`) or an exclusion (`^A`), names
a path inside a commit, or the repository has no history to compare
with. Pass a branch or commit you have locally, alone:
`--affected=origin/main`. A shallow clone fetches its base from origin
itself; with no origin, fetch it (`git fetch --depth=1 origin <base>`).

#### `VX_E_NO_GIT`

vx needs git and found none: `git` is not on PATH, or the workspace is
not inside a git work tree. The message says which. Install git, or run
`git init` in the workspace root, then re-run.

#### `VX_E_GIT`

A git command vx runs to read the diff or list a run's inputs failed;
the message carries git's exit and its own words. Run that command in the workspace to see
why (a broken index, a missing object in a partial clone).

#### `VX_E_NETWORK`

`vx docs` could not read its pages from GitHub: no network, a proxy that
refuses, or GitHub's limit on anonymous listings. The message carries
what failed. Retry with a network, set `GITHUB_TOKEN` or `GH_TOKEN` to
lift the limit, or read the same pages on the site,
`https://vznjs.github.io/vx/`.

#### `VX_E_DEPENDS_ON`

A task's `dependsOn` names a task or project that is not declared, or uses
a form vx does not take (a bare wildcard, a negation, a pattern in
`pkg#task`). The message names the task and the entry: declare the
target, fix its spelling, or drop the entry.
`vx lock` refuses it, not a run: a run trusts the graph the lock holds.

A `^task` with no edge source is refused too: ``<id>: ^build needs
project edges; add pnpm()/bun()/npm()/yarn() and install so its
lockfile exists, or a plugin that returns `deps` ``. A lockfile plugin
whose lockfile is absent gives no edges. Core reads no edge from a manifest, so with no plugin
returning `deps` every `^` would resolve to nothing and fold no
upstream into the key. Declare the lockfile plugin in
`.vx/workspace.ts` (or a plugin of your own that returns `deps`); a run
refuses it as well when the plugin left the workspace after the lock.

#### `VX_E_OUTPUT_OVERLAP`

Two tasks declare overlapping outputs with no `dependsOn` edge between
them, so whichever runs second deletes the other's files. Give each task
its own output path, or make one depend on the other.
`vx lock` refuses it, not a run: a run trusts the graph the lock holds.

#### `VX_E_INPUT_IS_OUTPUT`

A task's `inputs` match outputs: its own (vx cleans outputs before
a run, so it would delete its sources) or another task's (its key must
not read them; `dependsOn` already cascades). Exclude the outputs from
the inputs with a `!` glob, as the message shows, or declare no outputs
for a task that rewrites files in place.
`vx lock` refuses it, not a run: a run trusts the graph the lock holds.

#### `VX_E_NESTED_INPUT`

A task's `inputs.files` entry is rooted inside a project nested in its
own (`dist/**` where `dist/` holds a config): a project's globs never
reach another project's files, so it would key nothing. Depend on a
task of the nested project, or name the files in
`inputs.workspaceFiles`, as the message shows.
`vx lock` refuses it, not a run: a run trusts the graph the lock holds.

#### `VX_E_DEPENDENCY_RULE`

`vx lock` found a project depending on one a `run.rules.dependencies`
rule denies or does not allow. A header counts the broken edges and
each indented line under it names both projects and the rule. Drop the dependency, or change the project's tags or the rule.

#### `VX_E_INTERNAL`

A defect in vx: stderr carries the stack, then each `cause` under it as
a `Caused by:` line with its stack. (A config's own throw is
`VX_E_CONFIG`; a plugin hook's is `VX_E_REFUSED` or the plugin's code.)
Report it with that stack at
https://github.com/vznjs/vx/issues.

A plugin can give its refusal a code: `new UserError(message, 'MY_CODE')`.
The code holds whether a hook, `setup` or a verb of the plugin throws it.

**Streams.** A verb whose stdout is a product (a `--format json`
document, `--dry` / `--dry=json`, a completion
script) writes that product alone there; a notice or warning it meets
on the way (a cache index from another vx version, a plugin's warning) goes
to stderr, as every refusal does. `vx run`'s stdout is the run's frame,
the tasks' output it carries. `tests/cli-streams.test.ts` holds each
product verb to it under a notice.

## `vx show`

`vx show` prints the workspace's **resolved configs**: what a run would
see right now. Configs load through the same path a run uses: from
`.vx/projects.lock.json`, plugin `config` and `project` stages applied,
so a package a plugin gives tasks to (`turbo()` or `nx()` from
`@vzn/vx-migrate`, a temporary start toward native config) shows them.
`vx show` evaluates no config: an edit shows after `vx lock`, and with
no lock it refuses as a run does (`no lock: run \`vx lock\``).

### Usage

```
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

```
$ vx show
  project  dir            tasks         tags
  app      packages/app   3 tasks       scope:web
  bare     packages/bare  no vx config
```

```
$ vx show app#build

─ app#build ──────────────────────────────────────────────────
  dir            packages/app
  description    compile the app
  command        tsc -b
  dependsOn      ^build
  inputs.files   src/**
  inputs.env     NODE_ENV
  outputs.files  dist/**
```

### Options

| Option                  | Meaning                                           |
| ----------------------- | ------------------------------------------------- |
| `--filter <p>`          | only the projects `vx run --filter <p>` selects   |
| `--affected[=<ref>]`    | only what `vx run --affected` would select, below |
| `--format pretty\|json` | `json` for scripts                                |

### Understanding the output

**The project list.** No target: a table, one row per project — name, root-relative dir,
task count, and `no vx config` for config-less packages; one whose
tasks all come from plugins reads `N tasks from plugins (no vx
config)`, and one a configured project depends on reads `1 task,
default build (no vx config)`: a run loads it for that dependant's
`^build` (X-48). One nothing configured reaches has no task in any
view: `vx show bare` lists none, and `vx run bare#build` refuses it. A `tags` column appears when any project has tags. With `--format json`
it's an array of `{ name, dir, tags: string[], tasks: string[] }`.

**A project or task.** A report naming the project opens it: its `dir`, its `tags`, and
`config  none` for a package with no config file. Then
`vx show <project>` prints a block per task, headed by its
`project#task`, with every field the run reads: description, command (`(group)` for group tasks), `dependsOn`,
`timeout`, `retries`, `env.passThrough` / `env.define` / `env.secret`,
`remote`, `platforms`, `sandbox`, `persistent`, `interactive` (`yes` /
`no`), and the cache block
(`inputs.files` / `.workspaceFiles` / `.env` / `.tasks` / `.runtime` /
`.workspaceRuntime`, `outputs.files` / `.workspaceFiles` / `.clean`
(`yes` / `no`), `inputStability.strategy` / `.severity`). Fields the
task does not set are not printed, an empty list prints `none`; a value that spans lines (a
multi-line command) continues under its first line. `--format json` emits `{ name, dir,
config }` with the config exactly as resolved. `vx show <pkg>#<task>`
narrows to one task (`{ name, dir, task, config }` in JSON). A bare
name that is no project is a task: `vx show build` prints the block
from every project declaring `build` (an array of the one-task shape
in JSON). The default `build` is declared by none: it counts in the
list and `vx show <project>`, but `vx show build`, like
`vx run build --all`, does not name it (X-145).

### `--filter` and `--affected`

`--filter` and `--affected[=<ref>]` narrow the list, or a task's
projects, as `vx run` selects: `turbo ls --affected` is
`vx show --affected`, and `nx show projects --affected --with-target t`
is `vx show t --affected`. Beside a task, `--affected` lists the
projects whose task the run keeps: a change reaches another project
only along a task edge, so a dependent whose `test` has no `^test` is
not listed (X-147). A task's list the selection leaves empty says so on
stderr (`no affected project's test runs`); `--format json` prints `[]`.
With no task there is no edge to follow, and the
list is the run's candidates, `--filter "...[<base>]"`'s: the changed
projects and their package dependents. Beside one project or
`<pkg>#<task>` they are refused.

Nx's spellings name these: `vx show projects` (when no project or task
has that name) and `vx show project <name>` say `vx show` and
`vx show <name>`.

### Unknown names

Unknown project / task names exit `1` with the same near-miss hint
every verb gives (two edits, or a partial name); a bare name that is
neither reads `unknown project or task: "buidl" — did you mean build?`,
and a `pkg#task` hints whole specs (`unknown task: "app#bui" — did you
mean app#build?`). With nothing near, it lists what exists instead: `unknown
project: "zzz"; projects: app, lib`, `; its tasks: app#build, app#test`,
or `; projects and tasks: …` (M-57).

An empty target (`vx show ''`) is refused: omit it to list every project.

In a workspace with no project, the list is empty and `vx show` says so
on stderr (`no projects`) and names `vx init`.

### Exit codes

| Code | When                          |
| ---- | ----------------------------- |
| `0`  | success                       |
| `1`  | parse error or unknown target |

## `vx info`

`vx info` prints one screen of facts about the workspace and this
machine, for bug reports and sanity checks. The task count and the
sandbox row's declared count come from the same load a run uses: the
lock, plugin stages included. `vx info` evaluates no config; with no
lock both counts are zero and `projects lock` says `no`; with one a
run would refuse, they are zero and `projects lock` says `refused:` and
why (`lockError` in JSON). A broken config is `vx lock`'s to report.

### Usage

```
vx info [--format pretty|json] [--cache-dir <path>]
```

### Example

```
$ vx info

─ vx info ────────────────────────────────────────────────────
  vx                0.0.0
  bun               1.4.2
  git               2.53.0
  git status cache  core.fsmonitor, core.untrackedCache off
  workspace root    /work/repo
  projects          12 (34 tasks)
  plugins           2 — @vzn/vx-reapi (executor, cache); @vzn/vx-otel (telemetry)
  workers           2 — cgroup CPU quota 2 of 8 cores
  memory            13 GB usable — cgroup limit; the machine has 16 GB
  cache dir         /work/repo/.vx/cache (8.2 MB, this workspace's run history)
  cache store       /home/me/.vx/3f2a9c1e7b4d5a60/cache (1.3 GB, shared by this repo's checkouts)
  cache versions    keys vx-cache-v51 · index schema v51
  cache entries     42 (1.3 GB)
  orphans           3 artifacts (12 MB) the index does not know — `vx cache clean` reaps them
  task runs (24h)   7 (5 cache hits)
  flaky tasks       1 — web#test (3 of 11 runs failed on unchanged inputs)
  sandbox           available (9 tasks declare exec.sandbox)
  projects lock     yes
```

### Options

| Option                  | Meaning                                                 |
| ----------------------- | ------------------------------------------------------- |
| `--format pretty\|json` | `json` prints the same facts as one typed object, below |
| `--cache-dir <path>`    | read the cache a run with the same flag uses            |

### Understanding the output

- `git` shows `(not found)` when the binary is missing.
- `git status cache`: vx runs ONE `git status` per run to find dirty
  and untracked files, and on a large tree that walk is the warm run's
  critical path. git's `core.fsmonitor` (a daemon that watches the
  worktree, or a hook it names) and `core.untrackedCache` make it
  near-free after the first run; both are off by default, so `vx info`
  says when they are, reading each as git does (the last value set wins).
- `sandbox` is the runtime probe's verdict for THIS host — one sandboxed
  `true`, memoized — and how many loaded tasks declare `exec.sandbox`. A
  declared sandbox whose runtime cannot start fails the task at run
  time rather than downgrading, so `unavailable — <why>; 3 tasks declare
exec.sandbox and will fail` says it first: root inside a container
  (the runtime's seccomp helper cannot create its nested user namespace;
  run as a non-root user or set `sandbox.weakerWhenNested: true`), a
  missing bubblewrap, socat or ripgrep, a nested seatbelt on macOS.
  On Linux an available sandbox that cannot report the reads it denies
  (no `strace` on PATH, one whose `--version` fails, or one that may not
  attach) adds `, untraced — <why>, so the reads it denies go
unreported`: the sandbox still enforces, but a task that tolerates a
  denied read passes and caches with no word of it. The `--format json` fact is
  `sandbox.untraced`, the reason or `null`.
- `plugins` names every plugin `.vx/workspace.*` declares and the seams
  each fills, in pipeline order (`config`, `discover`, `project`, `graph`, `key`,
  `fingerprint`, `schedule`, `admit`, `executor`, `cache`, `telemetry`,
  `output`, `setup`, `commands`), or `none`. It reads the declarations: a plugin
  that declines a task at run time still lists its seam here.
- `workers` is the count a run defaults to and where it comes from:
  `VX_RUN_CONCURRENCY` when set, else `.vx/workspace.ts`'s `run.concurrency`, else the cores this
  process may use — the CPU count, capped by the cgroup CPU quota a
  container runs under (`8 — the CPU count`, `2 — cgroup CPU quota 2 of
8 cores`). `memory` is what a memory-packing policy budgets
  (`@vzn/vx-history`): the machine's total, capped by the
  cgroup limit — inside a container the raw numbers are the host's,
  and the doctor is where to see which one a run reads.
- `flaky tasks` is the standing list a run's flaky notes add to:
  every task whose history (30 days, what the cache keeps) holds a
  cache key that failed after it had passed, most failures first, with
  the outcomes over those keys. A cache hit counts as a pass (it
  replayed one), and a pass that took a retry counts too, its failed
  attempts counted as failures. A task with no cache block keys on its
  config alone, so its key says nothing about its inputs: it is never
  listed. A pass or a failure behind a failed dependency, in a run that
  continues past failures, is not its key's and counts on no key. `none` when
  no key did.
- `task runs (24h)` counts task runs, executed and replayed alike, so
  the hits are a share of it: three `vx run` of two tasks are six. An
  invocation is what `vx last` calls a run; `vx last --list` counts
  those.
- `cache dir` holds the index and this workspace's run history; its size
  is on disk. `cache store` is where the entries and their artifacts
  live: the store shared by this repo's checkouts (`docs/caching.md`),
  with its size on disk, or `none: the cache dir holds the entries` when
  the workspace names its cache dir. Before a first run it is the store a
  run would open. A bare `vx cache clean` frees both sizes.
- `cache entries` counts the entries and their size. An index SQLite
  cannot read reads `unreadable: <why and the fix>` there, and the
  history rows read 0: the report still prints, exit 0.
  Paths under the home directory print as `~/…`; the JSON keeps them
  absolute.
- `settings` appears only when a variable or `.vx/workspace` changed a
  setting: each such one by path, its value and where it came from
  (`cache.policy local:r (VX_CACHE_POLICY), run.timeout 30m (.vx/workspace)`).
  A setting not named runs at its default (`cache.policy`: every layer
  on, remote writes off off CI; `cache.scope`: a plugin's, else the
  branch's from git). The JSON `settings` holds every one. A variable
  a run refuses (`VX_RUN_TIMEOUT=abc`) does not stop the report, as it
  stops every other verb: its row adds `, refused:` and why
  (`run.timeout abc (VX_RUN_TIMEOUT, refused: …)`; `refused` in JSON),
  and the other rows read as if it were unset.
- `cache versions` are the two constants a bug report needs and the
  reset notice names: the key prefix (`CACHE_VERSION`; a bump orphans
  every entry) and the index schema (`SCHEMA_VERSION`; a mismatch drops
  every table on the next open, which the run then says once).
- `orphans` appears only when the cache directory holds artifacts or
  save temps the index has no row for, older than an hour (what a
  `SCHEMA_VERSION` reset leaves behind; a fresh one is a save in
  flight). A task that asks for one's key again indexes it and hits;
  the rest only `vx cache clean` reclaims, so the doctor says so.

### JSON

`--format json` prints the same facts as one typed object, for a
script or a bug-report template: `vx`, `vxPath` (the file that ran),
`handedOffFrom` (the vx that handed the call to the project's own, else
null), `bun`, `bunSupported` (false
below Bun 1.4.4), `git` (null when not
found), `gitStatusCache` (`{ fsmonitor, untrackedCache }`, null when
git could not answer), `workspaceRoot`, `projects`, `tasks`,
`plugins` (`[{ name, seams }]`), `workers` (`{ count, source, cores,
cpuQuota }`, the source one of `env` / `workspace` / `cgroup` / `cores`,
`cpuQuota` in cores or null), `memory` (`{ usableBytes, totalBytes,
cgroupLimitBytes }`, the limit null when none binds), `cacheDir`, `cacheDirBytes`
(on disk: the index and run history), `cacheStore` (null when the cache
dir holds the entries), `cacheStoreBytes` (on disk, null with no store), `cacheVersion`,
`schemaVersion`, `cacheEntries`, `cacheBytes`, `cacheIndexError` (why
the index cannot be read, with the fix, else null; the counts it holds
read 0 then), `settings` (every
setting by path, `{ value, source, refused }`, `source` one of `env` /
`workspace` / `default`, `value` null for the default, `refused` why a
run refuses the variable's value, absent when it takes it),
`orphans` (`{ artifacts, bytes }`, always present), `runs24h`, `hits24h` (task
runs, as the row), `restored24h` (of those hits, the ones that restored
outputs; the rest found them up to date), `flakyTasks` (`[{ taskId, project, task, keys, passes, failures }]`,
empty when none), `lockfile`, `lockError` (why a run refuses the
lock there, null when it reads it or there is none), `sandbox` (`{ available, reason,
declared, untraced }`, `declared` the count of tasks with `exec.sandbox`,
`untraced` the reason denied reads go unreported or null). The
pretty rows render this object;
there is no second source.

### Exit codes

| Code | When                                         |
| ---- | -------------------------------------------- |
| `0`  | the facts printed, with no lock included     |
| `1`  | no workspace here or above, or a parse error |

## `vx why`

`vx why` tells you why a task re-ran: the file, variable or dependency
that moved its cache key since the run before. It reads the local
`cache.db`, no re-hash; configs are evaluated only when a moved
dependency is a group, which records no run of its own.

### Usage

```
vx why (TASK | PKG#TASK) [--run RUNID] [--format pretty|json] [--cache-dir <path>]
```

### Example

```
$ vx why app#build
app#build — run 01a1193a-7b39-75a9-870b-5c03e26d7104
  this run   2026-10-08T01:57:05.486Z · success · executed · key 9ef9806a9c69209e
  previous   2026-10-08T01:57:05.325Z · success · executed · key e240348b20e79fd6
  verdict    cache key changed: file packages/app/src/input.txt

  what changed (1 component, 6 unchanged):
    changed file  packages/app/src/input.txt  78981922613b2afb6025042ff6bd878ac1994e85 → 61780798228d17af2d34fce4cfbdf35556832472

  what to do:
    file  an edit re-runs by design; a file the task does not read belongs out of inputs.files
```

### Arguments

| Argument   | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PKG#TASK` | one project's task                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `TASK`     | a bare task name: resolves when exactly one project ran it (several → the project the current directory is in, as `vx run` picks, else an error listing the candidates; unknown → include-match suggestions, or, with none near, a pointer to `vx last --list`, or word that nothing has run yet; after runs of only groups, which record no task row, that no run executed a task and to ask about one the group depends on, X-50) |

### Options

| Option                  | Meaning                                                                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--run RUNID`           | explain that run instead of the latest; a unique prefix of the id is enough. A task that run did not run is refused, pointing at `vx last --list`, and so is an id no run carries. The space form refuses a value starting with `-` (a swallowed flag) |
| `--format pretty\|json` | `json` emits one object, below                                                                                                                                                                                                                         |
| `--cache-dir <path>`    | read the cache a run with the same flag uses                                                                                                                                                                                                           |

By default it compares the task's **latest** recorded run against its
immediately-previous run. History is
the cache directory's, not the checkout's: worktrees that share one
`--cache-dir` share one history, so the previous run may be another
worktree's (its branch is in `vx last`), and its edits read as changes. Latest and
previous are the order runs were recorded, not their clock: a clock that
stepped back once swapped the two and diffed the edit backwards.

### Understanding the output

**The verdict.** A changed key's verdict names what moved, kind and name, three at most
and then a count (`cache key changed: env MODE`), so a key that moved
only by an environment variable says so in one line; when neither
entry kept its components it reads `(inputs differ)`. A key that folds a
task with no `inputs` is new every run, so the task never hits; the
verdict names that task:

```
  verdict    never cached: its key includes app#gate, which declares no `inputs`, so each run derives a new key; declare inputs on app#gate
```

An **unchanged** key has three endings, and the verdict distinguishes
them rather than calling all three a re-run: the run was served from
cache (nothing re-ran), it re-executed on the same key, or it recorded
no cache outcome at all, in which case vx says so instead of guessing.
A re-execution names its cause when the index shows one: the previous
run on the key failed and saved nothing, the run did not read the cache
(`--force`, or a `--cache-policy` without read) or did not use it at all
(`--no-cache`, or a `--cache-policy` without read or write), no entry for the key was
there when it ran (pruned or evicted), the previous run was not saved
because it ran beside a failed task (a task run past a failed dependency
under `--continue` is never cached; said ahead of a prune, and as
"neither run saved it" when this run ran beside one too), or the previous run executed and no entry
holds the key (its save failed, or a prune took it; a previous run whose
policy wrote no cache says that instead, and one that built on a
dependency `--exclude-dependencies` left out names that dependency). Otherwise, with this run's
policy recorded as reading the cache, it says it cannot name the cause;
only a run with no recorded policy names `--no-cache` / `--force`.

**The run lines.** A hit's line is `cache-hit · key …` (or `cache-hit-remote`): the status
names the hit and its tier, so only an executed run carries the word.
A skipped task never ran and derived no key: its line is `skipped · no key`.

**What to do and root cause.** Under the rows, `what to do` gives one line per changed kind: what
moves it and how to stop a move the task does not need. An upstream
row is only the carrier, so `vx why` follows each dependency that moved
in the same run down to the tasks whose OWN inputs moved and prints
them under `root cause`, one chain per root (five at most, then a
count), and `what to do` speaks to those kinds instead:

```
  root cause:
    app#build ← lib#build ← file packages/lib/src/index.ts
```

A group records no run, so the key also names each task under a group
it folds, through the group (`upstream app#prep ← lib#build`), and the
walk goes on from that task, through the tasks a group gathers
(`app#pack ← app#all ← lib#build ← file packages/lib/src.txt`). A
dependency the walk cannot find in the run keeps the `upstream` line,
which names the `vx why` to run next (never a group's, which refuses),
or, for a group, the `vx show` that names what it gathers. A dependency
added or removed moved no key: its line says the graph changed
(`dependsOn` or a project edge). A `config` line names the `vx show`
that prints the task's config now.

**Changed during a run.** A moved input file whose last change fell inside a recorded task's run
window names that task: a task that writes a file another key reads (a
build rewriting a translation file in another package) re-keys that key
on every run, so the miss is right and only moving the write ends it.
An edit made outside a run names none.

```
  changed during a run:
    packages/lib/src/gen.txt  while app#build ran
```

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
| `format`                | the key format vx itself folds: it moves only with an upgrade, and re-keys every task once, X-142       |

A control character in a component's name (a file named with an
escape or a carriage return) prints as `\xNN`, so no file name drives
the terminal; `--format json` carries the name as it is.

**When there is no diff.** The component-level rows come from the `entry_inputs` input
fingerprints persisted with each cache entry; when either side's entry
is gone (pruned, or the run failed and never saved one) the verb still
names the hash change and says the component diff is unavailable. When
only the previous run failed, or passed beside a failed task
(`--continue`, never saved), the diff is taken against the last run
that saved an entry instead, and the detail line names that run. A
task with `inputs` and no `cache` block derives a key too — it is what
dependents fold — but saves no entry, so for it the verb can only report
the key change and says so.

### JSON

`--format json` emits one machine-readable object (`{ taskId, runId,
why, diff, roots, writers }`); when the task's recorded runs predate run ids, `{ taskId,
why, diff, explanation }`, `why` and `diff` null and `explanation` the
latest cache entry's key. `roots` is the root-cause walk (`chain`,
`entries`); `writers` the changed-during-a-run files (`taskId`, `file`,
`writers`).

### Exit codes

| Code | When                                                                        |
| ---- | --------------------------------------------------------------------------- |
| `0`  | the task's run explained                                                    |
| `1`  | no recorded run of the task, a `--run` with no row for it, or a parse error |

## `vx last`

`vx last` replays a recorded run's summary from the local history: no
re-execution, no cache probe, no config evaluation. A run a Ctrl-C (or
SIGTERM, SIGHUP) stopped records nothing, so `vx last` still shows the
run before it; nor does a `vx watch` cycle one stopped.

### Usage

```
vx last [RUNID] [--list[=N]] [--failed] [--log <task>] [--stats [<task>] [--branch <name>]] [--sql <query>] [--live [--follow]] [--format pretty|json] [--cache-dir <path>]
```

### Examples

```
$ vx last
run 01a16de7-6cd7-7563-984c-5ffba8fb6629 — ok
  $ vx run ci --all
  2026-10-24T12:34:05.662Z · 61ms · master @ 1587dec6
  3 tasks · 0 hits

  success           app#test        3ms  d6e223ce81dfdb2c  1.1× cpu
  success           app#build       7ms  b63bf0705528ba99  0.5× cpu
  success           lib#build       7ms  e5123c0191687798  0.7× cpu
```

```
$ vx last --list
ok     2026-10-24T12:34:05.662Z  01a16de7-6cd7  3 tasks · 0 hits  61ms  $ vx run ci --all
ok     2026-10-24T12:34:05.367Z  01a16de7-6bb3  3 tasks · 0 hits  52ms  $ vx run ci --all
```

```sh
vx last --failed          # the latest run that failed
vx last --log app#test    # one task's output
vx last --stats app#test  # p50, p99, pass and hit rate over the last 50 runs
vx last --sql "SELECT task, AVG(peak_rss_bytes) FROM runs GROUP BY task"
```

### Arguments

| Argument | Meaning                                                                                                                                                                                |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RUNID`  | replay that run instead of the latest. A run id may be typed as a unique prefix; a prefix several runs share fails and lists them. An unknown run id fails loud and points at `--list` |

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

`--log` does not combine with `--list` or `--failed`. `--stats` does not
combine with `--list`, `--failed` or `--log`; `--branch` combines only
with `--stats`.

### Understanding the output

**The header and rows.** Bare `vx last` replays the most recent run: a header (verdict, command,
when, duration, branch @ sha, CI, task/hit/failure counts) and a
per-task table — status, id, duration, cache key, and for a task that
executed, what it used (peak RSS and CPU parallelism, `312 MB · 1.4×
cpu`: the runner's own record, and the number `@vzn/vx-history`
reserves from; a hit spent nothing and shows nothing, and a task lighter
than vx itself shows its CPU only) — failures first, each as the frame
read it, `failed (exit 137)`, with the signal an exit above 128 stands
for at the row's end (`128 + SIGKILL`; the shell's convention, so a
command that exits 137 on its own reads the same). Where the run's
footer gave a reason, the row ends with it instead: `timed out`,
`never ready: exited`, `src/a.ts changed during the run` (an
`inputStability.severity: 'error'` failure, read from its kept output),
`2 sandbox violations`, and for a skipped task
`after lib#build failed` (the v27 columns; rows older than them read
as before), or, for a platform skip, `needs another platform` and
`after ios#build skipped: needs another platform`. A task that retried
ends with its attempts, `2 attempts`, passed or failed (`attempts` in
`--format json`, null for a task run once). A task whose key met a remote failure ends with it, read or
write alike: `remote ✗ download: connection refused; upload: 503` (the
v40 column, `remoteError` in `--format json`). A task an executor
plugin ran elsewhere carries where after its id: `app#build@small#1` (v44, `placement`).

**Order and folding.** Rows run failures first, then what executed or was
skipped, then hits; past sixteen hits the rest fold into one line with
their count (`… +980 more cache hits`) — a thousand-task warm run is a
thousand rows otherwise, with the one failure a screen above the
prompt — and the sixteen shown are the slowest restores, the one thing
a hit's row tells. `--format json` lists every row.

**Steps.** Below the tasks, the steps the run did not wait on (`vx:prefetch`, a
remote's downloads beside the tasks), which its own output never shows:
`success  vx:prefetch  1.20s  internal`. They are kept per run, the
newest 50, as `steps` rows of cache.db, written only by a run that had
one; `--format json` adds them as `steps`.

**Warnings.** Below the steps, what the run warned of (a glob that
matched no files, a remote's 403, a plugin's notice), each as it said
it, colour stripped, under `warnings`: on a terminal they scroll past,
and the footer keeps only their count. Kept per run like the steps, the
newest 50, as `warnings` rows, written only by a run that warned.

**Re-run what failed.** A replayed run with
failures ends with the command that re-runs them (`re-run what failed:
vx run app#test -- …`, with the arguments the run forwarded to the
tasks that got them; a failed dependency, which never got them, gets a
line of its own without them, X-140). The
replayed `$ vx run …` or `$ vx watch …` line and that one keep each
argument shell-quoted (`-- 'a b'`), so either pastes back as it ran (X-49);
the re-run line quotes a task id the same way (`'app#it'\''s boom'`).

**No runs yet.** Before any run, every form says so
(`› vx last  no runs yet` with `fix  vx run`, exit 1; `--list` prints
`› vx last  no runs yet`, exit 0), and past green runs only,
`--list --failed` prints `› vx last  no failed runs`.

### `--list`

`vx last --list` prints the N most recent runs (default 10), one per
line in aligned columns (verdict, start, run id, counts, duration,
command), each run id cut to the shortest prefix no other run shares, 13 characters at least (`--list 5`
and `--list=5` alike; the space form takes the next argument as the
count unless it is a flag or a run id, eight hex digits at least, so
`--list 1.5` is refused as a count); `vx last RUNID` replays a
specific one, and the two do not combine (a word beside `--list` no run
id could be is refused as an unexpected argument).

### `--log`

`--log <task>`
prints one task's output instead of the summary: in the latest run that
recorded the task, or in RUNID's. A failed task's is the kept failure
output; any other task's is its cache entry's log (the one a hit
replays, masked as it was, and again with this process's secret values,
as a hit's replay is; a task's `env.define` / `env.secret` values only
the run knows), so a passing task's log reads too, on a hit
or in the run that saved it. An uncached task that passed, or a skip,
kept none, nor does a failed task past the newest 50 failed runs:
stdout is empty and stderr says so, exit 0. A kept log that is empty
says the task printed nothing. With
`--format json` it is `{ runId, taskId, status, source, output }`,
`source` `'failure'`, `'cache'` or `null`. A task no run recorded is
refused, exit 1. A bare name (`--log build`) is the one project that ran
it; with several, the one the cwd is in, else it is refused listing them.
`//#<task>` is the root project's, here and in `--stats`.
`vx last app#build --log` reads the same as `--log app#build`: a `--log`
with no value takes the positional as its task.

### `--stats`

`--stats [<task>]` prints per-task numbers over the last 50 runs, the
window the scheduler and `--dry` learn from: runs, p50 (the forecast a
run shows: the median of the task's last five timings on the branch,
else on any branch), p99 of the executed successes, pass and hit rate, failure mode (`stable`,
`flaky-recoverable`, `flaky-fatal`), the largest peak RSS and the mean CPU
parallelism (a hit counts what its producing run used), one table row
per task. A task id narrows to that task, a task name to it in every
project; one the window has no run of is refused, exit 1. The branch is
`--branch`, else `VX_RUN_BRANCH`, else git's, then the CI provider's, as
a run's. With `--format json` it is `{ window, branch, stats }`, each row `{ taskId, runs,
p50DurationMs, p99DurationMs, successRate, hitRate, failureMode,
maxPeakRssBytes, maxCpuParallelism }`, `null` where nothing was
measured.

### `--live`

`vx last --live` asks the run in progress on this workspace, from another
shell, while it runs: an agent that started `vx run` in the background
reads what runs, what already ended and what waits, without waiting for
the end (the history holds a run only once it ended).

```
$ vx last --live
run 019a2f3c-5b1e-7c2d-9a40-1f3e5d7c8b21 — running 4.21s
  $ vx run a#all
  1 running · 2 ended · 1 waiting

  running  a#slow   4.12s
  success  a#lost   9ms
  success  a#quick  8ms
  waiting  a#after

  warnings
    [vx] a#lost: inputs.files matched no files …
```

With `--format json` it prints `{ live, tasks, warnings }`: `live` is
`{ runId, command, pid, startedAt, elapsedMs }`, each task
`{ taskId, status, startedAt, durationMs }` (`status` is `running`,
`waiting` or the status it ended with; times epoch ms, `null` where not
yet known), running first, then what ended, then what waits. Groups are
not listed.

`--follow` prints the same snapshot, then each of the run's events until
it ends: a task's output as `app#test │ <line>`, each end as
`success  app#test  1.20s`, each warning as `warn  …`. With
`--format json` the snapshot line is followed by one event per line,
each with a `kind`: `task:start`, `task:stdout`, `task:stderr`,
`task:complete`, `run:status`, `step:start`, `step:end`, `run:end`,
and last `run:done` (the run's wire events).

No run in progress is `no run in progress` (exit 1, `VX_E_NO_HISTORY`),
a run killed with its socket left included. A run that does not answer
within 5 s reads the same.

**What it costs a run.** Nothing is written. The run listens on a unix
socket beside its run lock (in this user's own temp directory, so no
other user reaches it) while it holds the lock, and keeps only when each
task started; the snapshot is built when asked. Output is not kept: it
reaches a follower only while one is attached, and a follower that falls
1 MiB behind is let go, so a stuck reader never holds the run. `--live`
combines only with `--follow`, `--format` and `--cache-dir`.

### `--sql`

`--sql <query>` runs one `SELECT` (or `WITH … SELECT`) over the run
history and prints its rows: a table with a header, or with
`--format json` `{ rows }`, one object per row keyed by column. It answers what no
flag does: filter by task or project, group, trend. The table prints
every column, a name repeated by a join's `SELECT *` (`run_id`) too;
`--format json` refuses a repeated name, since an object holds one
value per key: name each with `AS`.

```sh
# a task's memory and cpu, run by run
vx last --sql "SELECT started_at, duration_ms, cpu_ms, peak_rss_bytes FROM runs
  WHERE project = 'app' AND task = 'build' ORDER BY started_at"
# failures per day
vx last --sql "SELECT date(started_at / 1000, 'unixepoch') AS day, SUM(exit_ok = 0) AS failed
  FROM invocations GROUP BY day"
# the input files a key folded
vx last --sql "SELECT components FROM entry_inputs WHERE entry_hash = 'd6e223ce81dfdb2c'"
# what the runs warned of, and the steps they did not wait on
vx last --sql "SELECT run_id, text FROM warnings ORDER BY run_id DESC"
vx last --sql "SELECT step, AVG(duration_ms) FROM steps GROUP BY step"
```

The tables: `invocations` (one row per run), `runs` (one row per task
per run, joined on `run_id`: status, duration, cache hit, cpu, peak and
mean memory, attempts, timeout, skip and remote reasons, where it ran),
`steps` (`run_id`, `seq`, `step`, `duration_ms`, `ok`: the steps a run
did not wait on), `warnings` (`run_id`, `seq`, `text`), `failures`
(`run_id`, `task_id`, `input_moved`, `output`, `locations`,
`sandbox_fix`: a failed task's output; the last two JSON), `entries`
(the cached keys), `entry_inputs` (each key's input components),
`task_durations` and `task_outcomes` (what forecasts and flakiness
read), `lockfile_memos` (a lockfile plugin's parse, by file and
claimant). `SELECT name, sql FROM sqlite_schema` lists them all. Times
are epoch milliseconds. The history keeps 30 days; `steps`, `warnings`
and `failures` the newest 50 runs that had any.

A write is refused (`--sql reads only`, exit 1), and the query runs
with SQLite's `query_only` on, so a `WITH` that hides one fails too;
nothing else may lead the statement, since `ATTACH` would make a file.
A query SQLite cannot run is refused with its reason, and so is a
second statement after the first (SQLite would run the first alone).
`--sql` combines
only with `--format` and `--cache-dir`. The tables are vx's own and
change with `SCHEMA_VERSION`; read `sqlite_schema` rather than assume.

### JSON

`--format json`
emits `{ invocation, tasks, steps, warnings }` for scripting (`steps`
and `warnings` only when the run kept some, above); `--list --format json`
an array of the same `invocation` objects, newest first. A failed task's row adds
`output` (its output as plain text, the first 8 KiB and last 56 KiB,
secrets masked) and `locations` (the existing files it names,
`{ file, line?, col? }`, file absolute; a file also named with a line
drops its bare mention, such as bun test's `app.test.js:` header), so an
agent reads why without the terminal. `fixedIn` names the first later run where that task
passed, so a replayed failure that is already fixed says so. A
sandboxed task's row adds `sandboxFix`, the `exec.sandbox.allow`
entries (`read`, `write`, `network`, `systemInfo`) that would have
granted its denials, the same grants the terminal prints as `fix:`;
`withheld` lists the credential paths it denied and left out (a `.env` file, or a store under home the sandbox denies, `security.md`), and, for
a cached task, `inputs` the reads of its project no `inputs.files`
glob matches (the terminal's `and, if the output depends on them, …`
line). A task
failed by `inputStability.severity: 'error'` adds `inputMoved`, the
input that changed during the run. They live in cache.db's `failures`
rows, the newest 50 failed runs; past those, or when the write was
refused, a failed row reads `output: ''` and `locations: []`.

### `--cache-dir`

`vx why`, `vx last`, `vx info` and `vx cache clean` all read the cache
a run wrote, so each takes `--cache-dir <path>` with `vx run`'s rules
(cwd-relative, absolute used as-is): a run that wrote its history
elsewhere is replayed, explained, reported on and pruned there. Without
the flag they open the workspace's cache (`defineWorkspace({ cache: { dir } })`
or `.vx/cache`). A `--cache-dir` that is not there is refused by name
(`--cache-dir .vx/cahce: no such directory`, `VX_E_USAGE`). In a workspace that never
ran, `vx why`, `vx last`, `vx info`, `vx show` and `vx cache clean`
(dry or not) read it as empty and create nothing (item 900, E-7, E-38).

### Exit codes

| Code | When                                                                |
| ---- | ------------------------------------------------------------------- |
| `0`  | the run (or the list) printed, `--list` with no runs included       |
| `1`  | no recorded run yet, a run id it has no record of, or a parse error |

## `vx docs`

`vx docs <query>` searches vx's reference as this version wrote it:
every page of `packages/vx/docs` at this vx's release tag on GitHub
(`v<version>`; a source checkout reads `main`), read online each time,
so nothing ships inside vx. Each page is cut
at its headings; a section that holds every word of the query matches,
and a word in its heading ranks it above any count in its text; a
one-word query that titles a section, an error code
(`vx docs VX_E_CYCLE`), prints that section alone. The best
`--limit` sections (default 3) print whole, each under its page,
heading and URL on the site. `--format json` prints
`{query, hits: [{page, heading, url, text}]}` (`schemas/docs.json`).
The guides live on the site: `https://vznjs.github.io/vx/llms.txt`
indexes them.

Exit codes: `0` the search ran, a search with no match included (it
names the tag searched); `1` a missing query or a bad flag
(`VX_E_USAGE`), or the pages could not be read (`VX_E_NETWORK`, which
names the site).

## `vx completions`

Print a completion script for `bash`, `zsh` or `fish`:

```
eval "$(vx completions bash)"                          # this shell
vx completions zsh > ~/.zfunc/_vx                      # zsh, with ~/.zfunc on $fpath
vx completions fish > ~/.config/fish/completions/vx.fish
```

The script completes the verbs — core's, and the plugin verbs the
workspace around the cwd declares at generation time — and every flag
of each verb, read from the same help text `vx <verb> --help` prints:
the verb's own Usage line, and for `run` and `watch` the run option
lines, less the ones `watch` refuses. So a flag cannot be documented
and not completed, nor completed and then refused: a flag another
verb's line names in passing (`--check` in a line about `vx lock`) is
not one. After a flag with a fixed value set the script offers that
set: `--format` pretty or json, `--output-logs` full, errors-only,
hash-only or none, `--cache-download` all, toplevel or none, `--schedule`
its four rules — each value one
the flag's parser takes (`tests/completions.test.ts` holds it). A plugin verb completes `--help` only. Task and project
names are not completed (they are the workspace's, and a completion
that evaluates configs on every Tab is the wrong price). The zsh script
works both ways zsh loads one: from `$fpath` it completes on the first
Tab (it rang the bell there until 2026-10-03 and completed on the
second), and sourced it registers itself; `tests/completions-shells.test.ts`
loads the script in zsh both ways and in fish where they are installed. An unknown
shell is an error naming the three, and the nearest of them when one is
within two edits (`got bsh). Did you mean bash?`).

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

The plugin's name is its package name, which `definePlugin` reads from
`import.meta`; a plain object is refused when the workspace loads.
`ctx.cache` reads the plugin's own entries as `setup` writes them (the
local store, then each remote the workspace's cache plugins supply,
under the run's scope), read-only, opened on first use.

(`@vzn/vx-history` ships exactly this: `vx history`, what it
learned per task and the reservation its `admit` hook packs.) The dispatcher tries core's verbs
first and consults plugins only for a word core does not know, loading
the workspace config from the cwd to find them (outside a workspace the
verb is simply unknown). A plugin verb that names a core verb, or one
plugins of two packages both declare, is refused when the workspace
loads — such a verb could never run, or would hide the other plugin's.
Plugins of one package are one owner (two of its plugins may carry the
same verb): the first declared runs. A plugin verb's
return value is the exit code, an integer 0–255 (anything else — nothing,
a fraction, 256, which the OS would keep as 0 — fails naming the plugin
and the verb), and a thrown `UserError` prints as
cleanly as core's own. Anything else thrown fails in one line, no stack:
`plugin '<p>' failed in command '<verb>': <msg>`. `vx help` lists every plugin verb under "Plugin
commands", with the plugin's name.

An unknown verb is answered with what this workspace knows: the "did you
mean" set is core's verbs AND the ones its plugins declare (the lookup
that just failed already loaded them, so it costs nothing), and when
nothing is close enough to guess, a second line says where a verb can
come from — the verbs declared here, or that `.vx/workspace.ts` is what
would declare one, or that there is no workspace here at all. Core still
names no package: it lists what the workspace itself declares.

## Environment variables vx reads

Every setting has a variable derived from its path (`run.timeout` →
`VX_RUN_TIMEOUT`), beating `.vx/workspace` and beaten by the flag; the
table in `docs/schema.md` § Settings gives each value's form and
default. Each is checked once before any verb runs: an empty one is
unset, a value its kind does not take is refused naming the form, and a
variable vx does not read is ignored. A
plugin's own (the REAPI endpoints, the GitHub token) are in its README;
what a TASK sees is `exec.env` in `docs/schema.md`.

<!-- variables table: generated by tests/settings.test.ts -->

| Variable                            | Setting                                               | What it does                                                                                                                                                                                     |
| ----------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VX_BASE_BRANCH`                    | [`baseBranch`](schema.md#settings)                    | The default branch: a run on it has no cache scope and a bare `--affected` no base; elsewhere both use the merge base with `origin/<baseBranch>`. Named alone: `main`, not `origin/main`.        |
| `VX_AFFECTED_BASE`                  | [`affectedBase`](schema.md#settings)                  | The commit a bare `--affected` compares with, on the base branch too. `--affected=<base>` beats it; it beats a plugin's base commit. Env only: a committed base would be stale on the next push. |
| `VX_RUN_CONCURRENCY`                | [`run.concurrency`](schema.md#settings)               | Tasks at once: a positive integer, or a share of the cores (`'50%'`).                                                                                                                            |
| `VX_RUN_SCHEDULE`                   | [`run.schedule`](schema.md#settings)                  | Which ready task starts first when there are more than workers.                                                                                                                                  |
| `VX_RUN_BRANCH`                     | [`run.branch`](schema.md#settings)                    | The branch a run records in its history and forecasts from. Flag and env only: a committed branch would be wrong on every other branch.                                                          |
| `VX_RUN_TIMEOUT`                    | [`run.timeout`](schema.md#settings)                   | A task's time limit, for tasks without their own `exec.timeout` (`'30m'`).                                                                                                                       |
| `VX_RUN_RETRIES`                    | [`run.retries`](schema.md#settings)                   | Re-runs of a failed task, for tasks without their own `exec.retries`.                                                                                                                            |
| `VX_RUN_CONTINUE`                   | [`run.continue`](schema.md#settings)                  | What a failed task takes down: `never` stops the run, `deps-ok` skips its dependents, `always` runs them too.                                                                                    |
| `VX_RUN_OUTPUT_LOGS`                | [`run.outputLogs`](schema.md#settings)                | Which task output the run prints. Chosen before the workspace loads, so flag and env only.                                                                                                       |
| `VX_RUN_RULES_EXCLUSIVE_OUTPUTS`    | [`run.rules.exclusiveOutputs`](schema.md#settings)    | Refuse two tasks whose outputs overlap even when an edge orders them.                                                                                                                            |
| `VX_CACHE_DIR`                      | [`cache.dir`](schema.md#settings)                     | Where the cache lives, relative to the workspace root; named, it holds the whole cache.                                                                                                          |
| `VX_CACHE_POLICY`                   | [`cache.policy`](schema.md#settings)                  | Which layers a run reads and writes (`'local:rw,remote:r'`); `--no-cache` and `--force` apply on top.                                                                                            |
| `VX_CACHE_SCOPE`                    | [`cache.scope`](schema.md#settings)                   | The branch scope plugin entries are keyed under (`'vznjs/vx:feat-x'`); task keys never carry it. Empty: no scope.                                                                                |
| `VX_CACHE_CONCURRENCY_DOWNLOAD`     | [`cache.concurrency.download`](schema.md#settings)    | Remote downloads at once.                                                                                                                                                                        |
| `VX_CACHE_CONCURRENCY_UPLOAD`       | [`cache.concurrency.upload`](schema.md#settings)      | Uploads at once, per remote.                                                                                                                                                                     |
| `VX_CACHE_CONCURRENCY_RESTORE`      | [`cache.concurrency.restore`](schema.md#settings)     | Local hits restoring outputs at once.                                                                                                                                                            |
| `VX_CACHE_DOWNLOAD`                 | [`cache.download`](schema.md#settings)                | Which remote hits land on disk: every one, only the requested tasks, or none.                                                                                                                    |
| `VX_CACHE_INPUT_STABILITY_STRATEGY` | [`cache.inputStability.strategy`](schema.md#settings) | What a write to an input during the command means for the save, for tasks without their own.                                                                                                     |
| `VX_CACHE_INPUT_STABILITY_SEVERITY` | [`cache.inputStability.severity`](schema.md#settings) | Whether a skipped save warns or fails the task, for tasks without their own.                                                                                                                     |
| `VX_CACHE_STORE_EMBEDDINGS`         | [`cache.store.embeddings`](schema.md#settings)        | Keep an entry up to this size inside the cache index, one zstd tar, rather than as files; `false` keeps none.                                                                                    |
| `VX_CACHE_STORE_DECOMPRESS`         | [`cache.store.decompress`](schema.md#settings)        | Keep a larger entry as its plain files, which a hit copies or clones out; off, as one `.tar.zst`.                                                                                                |
| `VX_LOCK_REVIEW_FILES`              | [`lock.reviewFiles`](schema.md#settings)              | `vx lock` writes each project's resolved config, pretty, to `vx.lock.json` beside its `vx.config`, for review; vx never reads it.                                                                |
| `VX_WATCH_POLL`                     | [`watch.poll`](schema.md#settings)                    | Poll for changes from the start instead of the OS watcher.                                                                                                                                       |
| `VX_CONFIG_WORKER_TIMEOUT`          | [`config.workerTimeout`](schema.md#settings)          | How long one config evaluation may take.                                                                                                                                                         |
| `VX_DEBUG_TIMING`                   | [`debug.timing`](schema.md#settings)                  | Print the run's stage timings to stderr.                                                                                                                                                         |
| `VX_DEBUG_WATCH`                    | [`debug.watch`](schema.md#settings)                   | `vx watch`: say on stderr each time the loop arms, with the projects it watches.                                                                                                                 |
| `VX_DEBUG_DUMPABLE`                 | [`debug.dumpable`](schema.md#settings)                | Linux: keep vx dumpable, so strace or a debugger can read its memory and `/proc/<pid>/fd`, and an unsandboxed task its env.                                                                      |
| `VX_HANDED_OFF`                     | —                                                     | Set by a global vx that hands the call to the project's own (§ Which vx runs): the path of the vx that handed off, so the receiver does not hand off again.                                      |
| `VX_RUN_WORKSPACE`, `VX_RUN_TASK`   | —                                                     | Set by vx on every task (below); a `vx run` a task starts reads them back.                                                                                                                       |

<!-- /variables table -->

vx sets two variables on every task's environment: `VX_RUN_WORKSPACE`
(the workspace root) and `VX_RUN_TASK` (`project#task`). A `vx run` a
task starts reads them back: one in the same workspace is refused, since
a nested run is invisible to the outer graph and a loop back to its own
task forks without bound (`docs/schema.md` § `env`).

Colors are the two conventions in § Output format › Colors (`NO_COLOR`,
`FORCE_COLOR`). A truthy `CI` picks the CI output flow and
`GITHUB_ACTIONS` its `::group::` framing (§ Output); the run's
`invocations` row records the provider, the first truthy of
`GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`, `CIRCLECI`, then `CI`. Core never reads `GITHUB_STEP_SUMMARY`; the job summary is
`@vzn/vx-ci`'s. A sandboxed
task's temp dir sits under `CLAUDE_CODE_TMPDIR` (else `CLAUDE_TMPDIR`,
else `/tmp/claude`), the sandbox runtime's own convention
(`docs/modules/sandbox-runtime.md`).

## Output format

`vx run` emits framed blocks. Stdout/stderr from each task is
buffered until completion, then dumped inside the block — so
concurrent tasks never interleave their lines. A lone requested task
streams live instead (§ Output).

Frame anatomy:

```
┌─ app#test > failed (exit 1, 1 sandbox violation)

$ bun test

├─ OUTPUT ────────────────────────────────────────────────────

2 pass
error: expected 3, got 2
1 fail

├─ SANDBOX VIOLATIONS (1) ────────────────────────────────────

write ../shared/notes.txt

└─ app#test ── (2.10s) failed (exit 1, 1 sandbox violation)
```

Every section is conditional: the `$ <command>` line only for an
executed task (success or failed — a hit replays its stored output and
shows none), `OUTPUT` only when the task wrote something,
`SANDBOX VIOLATIONS (N)` only when the sandbox recorded some (`N`
counts them) or `SANDBOX` when vx has only a note on a failure. The
header carries the outcome (`restored-local • abc12345`, `failed (exit
N)`, …) and the footer repeats it after the duration. A test renders
this block and checks it against this page, byte for byte.

`OUTPUT` holds what the task wrote in the order vx read it, so an
error stays beside the test that printed it: a stderr line renders
red when colour is on (a line the task coloured itself keeps its own
colours, and a line takes the stream that began it); without colour
the lines are the task's bytes.
The two streams are two pipes, so lines written within the same
instant may read stdout first; a cache hit replays the same order. A
persistent task's tail after ready keeps `STDOUT (since ready)` and
`STDERR (since ready)` apart: its bounded tails hold no order.

Frame corners and rules render dim, section labels (`├─ …`) bold in
their state colour; the id keeps its identity coloring. Content lines are **raw** — no left border, no
indent — so long lines wrap without colliding with frame glyphs and
copy/paste yields the verbatim output. Every block (and every live
frame close in focused flow) is followed by a blank line so frames
never collide with the next one-liner. A persistent task's frame is
marked with a cyan `▸` after `┌─`/`└─`, and its close reads `running`
(the child is still alive), `success` for a setup step ready by its
exit 0, or `failed (exit <n>)` for a server that died on its own before
the run stopped it.

There is **no top-of-run banner** — the run context lives in the
footer. The task log opens with one blank line before its first row,
on a terminal or not; a note vx prints before it is not part of it.
A broad run looks like:

```
 ⇢     4ms                 success local                                 local        @vzn/vx#format-check
 ⏺︎   5.20s                 success miss                                  local        @vzn/vx#test

─ vx 0.0.0 ───────────────────────────────────────────────────
  projects  ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱
            1 affected · 3 total
  tasks     ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
            2 success · 2 total
  cache     ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
            local 1↓ 1↑

  info      8 workers · local cache · run 01a14941-c8cf-7a3e-9b51-2f06d4e8c713
  time      5.34s
```

The three bars are meters: `projects` is what the run covered against
the workspace, `tasks` is failed / success / skipped, `cache` has a
segment per legend state (a skipped task rides it too, so the two bars
fill alike; its count is on the tasks legend only). Its legend reads
per layer: `local 1✓ 1∅ 2↓ 1↑ · remote 3↓ 4↑ 2✗ 1⇡`. `✓` is a fresh
hit (the local cache answered and its outputs were already on disk; a
remote hit is never fresh, outputs or none: it is `↓` from the remote), `∅` a task with no cache, `↓` is restored from that
layer and `↑` saved to it, `✗` a task a remote read or write failed
for, and `⇡` an upload still running (live only, always last). The
region stays through vx's closing steps, worker rows gone, and the
final footer replaces it in place. Each task counts once, under its strongest state: a
failed remote read or write, then an upload running, then saved to a
remote, then saved here, then restored, then fresh, then no cache; so
a task saved here and uploaded is a remote `↑`. A key the remote already
held is not sent, so it is no remote `↑`. Each count is painted
in its segment's colour, number and glyph alike: `✓` green, `∅` dim,
local blue, remote dark blue, `✗` and a miss red, `⇡` cyan; the
`local` and `remote` words are dim. A layer shows only when the run's
`--cache-policy` uses it. `N miss` (ran and saved nothing: it failed,
or ran elsewhere) is red, `N not saved` (ran, succeeded, saved
nothing) yellow, each its own segment; `N not downloaded` (outputs left in the remote store) and
every count show only when non-zero. `vx last` names each remote
failure on its task's row. A task an executor plugin ran elsewhere
says where last on its row and after the id on its frame (`app#build · small#2`), and the plugin may
add rows of its own above `info` (`workers`), in which case `info`
names no worker pool. A run that warned (a remote cache's 403, a
plugin's failed flush) gets a yellow `warn` row above `info`,
`N warnings above`, counting each distinct warning once; the
warnings themselves are said once, where they happened. The
`info` row ends with `run <id>`: the
run's whole id, as `vx last <id>` takes it; a run a Ctrl-C (or
SIGTERM, SIGHUP) stopped records nothing, so its footer names no id. The
`time` row is the wall time, then the spread over executed tasks
only — a hit's restore time never enters it. The footer never says a
fact twice: a spread value already on the row is left out, so one
executed task shows no spread, and there is no closing `result` row
repeating the tasks, cache and time rows. A task with no `cache` block,
or any task of a run whose `--cache-policy` reads and writes nothing
(`--no-cache`), could never hit, so it is counted apart (`1 no-cache`
for `vx run dev`), as `--dry` labels it. A test renders this run and
checks it against this page, byte for byte.

Group tasks emit no framed block by design (they aren't real tasks);
running a group focused surfaces its real member tasks instead.

**Nothing below the footer.** The footer is the run's last word.
What a run has to say about one task rides that task's row; what it
says about the run (a server that died, outputs left remote, a file
`--profile` wrote, a history, upload, plugin or sandbox
warning) prints above the footer: it prints once the run's closing work
is done, the `VX_DEBUG_TIMING=1` table included. Only a kept server's own output
follows it.

**Narrow terminals.** The footer is 62 columns: its rule and 50-cell
bars. On a terminal narrower than that the bars shrink and the rule
with them, as do a frame's section rules, so none wraps onto a second
row. Off a terminal they keep their width.

**Warnings on stderr.** A run's warnings, such as `[vx] app#build:
cache.outputs matched no files …` or a plugin's, go to stderr. Stdout
carries only the rows, the frames and the footer, so `vx run build >
log.txt` keeps them out of the log.

**Skipped rows.** A red run lists every task that never started as a
row naming the failure that blocked it, so the footer's `1 skipped`
always has a name above it:

```
 ⊘         skipped          app#build • blocked by lib#build
 ⊘         skipped          web#build • blocked by lib#build
```

A skip's cause is followed through a chain of skips to the failure at
its root; a skip with no failed upstream is fail-fast's and carries no
suffix. A blocked group (a task with no command) has no row: it never
starts by definition and no counter counts it.

**Aborted and not-run rows.** A stop (Ctrl-C, a shutdown signal)
keeps the live view: each running row reads `aborting` with its timer
until its task exits, and the task list names what the stop cut short
(`aborted`, with its time so far) and what it reached first (`not
run`). Neither reached the cache:

```
 ✗   2.41s aborted          app#dev
 ◌         not run          web#build
 ◌         not run          web#test
     3.37s aborting         api#dev
```

The tasks legend counts them in the total as they land, each state its
own segment of the bar: `2 success · 1 aborted · 2 not run · 5 total`.
While the run goes it also counts the tasks running now and those an
executor holds for a machine, then those an unfinished dependency holds
back, each a dim segment, and how many are left, those included:
`30 success · 4 running · 12 scheduled · 16 blocked · 32 left · 62 total`.
The summary then replaces the live view. The total is
always last on its line. A framed task (focused or `full`) that
printed while it stopped shows its frame instead of a row.

**Flaky rows.** A task the run just proved nondeterministic says so
in a dim note on its own row (and its frame's footer) — from the local
run history alone, no service:

```
 ◼︎   4.21s failed  miss     app#test flaky - passed 3× before
 ⏺︎  12.84s success miss     api#e2e flaky - failed 1× before · 2 attempts
```

A task is flaky when its exact cache key FAILED AFTER IT HAD PASSED
(this run counted; a cache hit is a pass, it replayed one), or when it
passed only on a retry (`exec.retries` / `--retries`) this run. A failure on a
key that never passed is a break and carries no note, every retry of it
failed too — a changed input
that fails is what a red run usually means — and the first pass after
only failures is a recovery (a missing tool installed), not a flake.
Only tasks with a `cache` block are judged: "same inputs, red after
green" is a claim
only declared inputs can back, and a task without them keys on its
config alone. It is judged as the task finishes, so the row carries
it: zero cost for a hit or a skip, one probe of the failed-row index
for a green miss; `vx info` keeps the standing list.

### Colors

ANSI truecolor (`ansi-16m`) sequences, gated by env:

| Var                         | Effect                                                   |
| --------------------------- | -------------------------------------------------------- |
| `NO_COLOR=…` (non-empty)    | Force off. Overrides `FORCE_COLOR`.                      |
| `FORCE_COLOR=0` / `=false`  | Force off, on a TTY too.                                 |
| `FORCE_COLOR=…` (any other) | Force on — `1`, `true`, `2`, `3`, the empty string, etc. |
| (neither)                   | On iff `stdout.isTTY`.                                   |
| `TERM=dumb`                 | Off unless `FORCE_COLOR` forces it, and no live region.  |

`0` and `false` are `FORCE_COLOR`'s "off" by the convention
supports-color, chalk and Node follow; until 2026-09-24 vx read every
non-empty value as "on", so a CI setting `FORCE_COLOR=0` got escape
sequences in its log (the bug Nx has as nx#35292). An empty `NO_COLOR`
has no effect (no-color.org).

A task's output is a pipe, so a tool would print plain; vx sets
`FORCE_COLOR=1` on every task, as Nx and Turbo do, unless the task
already sees a `FORCE_COLOR` (any value, `0` included) or a non-empty
`NO_COLOR`. The cache stores the coloured bytes, and wherever vx's own
output is plain (a pipe, CI without `FORCE_COLOR`, `NO_COLOR`) it
strips the escapes from task output, live and replayed alike, an
escape cut across two chunks included (`tests/plain-output.test.ts`,
`tests/cli-colors-e2e.test.ts`). A custom `log` passed to `run()` gets
task output as written. A task that writes its own output to a file
and wants it plain sets `env: { define: { FORCE_COLOR: '0' } }`.

Programmatic callers passing a custom `log` to the run options always
see plain text.

Only a run's own output (`vx run`, `vx watch`) is painted, and the
help on a terminal: headings bold, `vx <verb>` and each flag or example
in cyan; `NO_COLOR` or `FORCE_COLOR=0` turns it off
(`tests/help-colors.test.ts`). Every other verb (`show`, `info`, `why`,
`last`, a `--dry` plan, `cache clean`), and the help off a
terminal, prints plain text whatever `FORCE_COLOR` says, so a script
that forces colour for a run's log still parses them
(`tests/cli-colors-e2e.test.ts`).

### Shared by every verb

Two runs on one workspace take turns: the second waits for the first's
run lock and, after a second, says `[vx] waiting for another vx run
(pid N) on this workspace to finish…` (see caching.md § Concurrent
runs). The lock lives in this user's own directory in the temp
directory, so two runs take turns only when they are one user's and
share `TMPDIR`: a `nix develop` shell sets its own.

Every verb: a path vx must write that this user cannot (`EACCES`,
`EPERM`, `EROFS` — a read-only checkout, another user's files) or that
the disk has no room for (`ENOSPC`, `EDQUOT`) exits 1 with one line
naming the path, `vx: EACCES: permission denied, open '…/.vx/projects.lock.json'
— a path vx must write is not writable by this user` (or `— the disk
that path is on is full`), never a stack. A refused listing or stat
(`scandir`, `stat`, `lstat`) is a read and says so: `— a path vx must
read is not readable by this user`. Inside a run the task's line
says the same. A process out of file descriptors (`EMFILE`, `ENFILE`;
macOS starts a shell at 256) exits 1 with the error and `— the process
is out of file descriptors; raise the limit (ulimit -n 4096) and re-run`.

## Remote cache (plugin-driven)

Core ships **no remote-cache wire client** — the remote cache is a
plugin concern. A `cache` plugin returns a wire client (a
`RemoteCacheLayer`) and core layers it over the local cache;
`@vzn/vx-reapi` provides one for any Bazel REAPI server
(ActionCache + CAS).

Reads try local first, then remote (hydrating local on remote hit),
with a background prefetch pass overlapping remote GETs with
execution. Writes go to local immediately; the remote upload is a
fire-and-forget background task drained at end of run — failures are
warned but never fail the build.

For any OTHER cache server (a Turbo-wire deployment, S3-direct, …),
implement core's `RemoteCacheLayer` interface in a plugin's `cache`
capability — the recipe lives in the plugins guide. Embedders
holding a wire client can inject it per-run via
`RunOptions.remoteCache` (explicit injection wins over the plugin
consult).

## Run analytics

`vx info` surfaces the aggregate cache stats (entry count, total
size, runs + hits in the last 24 h). For anything deeper, vx records
every task to a `runs` table in `cache.db` (UUIDv7 `run_id`, hrtime
wallclock spans, cpu_ms, peak RSS, status, cache_hit flag) plus one
`invocations` header row per run (command, git/CI context,
counts). The SQLite file IS the API:

```sh
sqlite3 .vx/cache/cache.db "
  SELECT project, task, status, duration_ms
  FROM runs
  WHERE run_id = (SELECT run_id FROM runs ORDER BY id DESC LIMIT 1)
  ORDER BY duration_ms DESC;
"
```

The schema is documented in
[`caching.md` § SQLite tables](./caching.md#sqlite-tables).

## What's still missing vs Turbo

Tracked in [`comparison.md`](./comparison.md). Nothing visible from the
CLI is open: `--output-logs hash-only`, `--continue=<mode>`
and `--cache-dir <path>` all shipped and are documented above.
Remote-cache credentials are not core CLI flags at all: core carries no
HTTP cache client — a remote cache arrives through a plugin's `cache`
capability, which owns its own configuration.

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

Surface:

- `run(options)` — execute. Returns `Promise<RunSummary>`.
- `planRun(options)` — predict, no execute. Returns
  `Promise<RunPlan>`. Used by `--dry`.
- `prepareRun(options, log)` — the shared setup (discovery → configs →
  graph → cache). What an embedder builds on.
- `defineProject` / `defineWorkspace` — identity helpers for type
  inference in user configs.
- Every one of the three returns a type the façade exports, so an
  embedder can hold it: `RunOptions` / `RunSummary` / `TaskOutcome`,
  `RunPlan` / `PlannedTask`, `PreparedRun` — alongside the plugin
  (`VxPlugin`, `TaskExecutor`, `CacheLayer`) and telemetry
  (`TelemetrySink`, `RunSummaryRecord`) surfaces. See `src/index.ts`.

A `log: Logger` option lets embedders swap the default framed-block
logger for a custom one (e.g. JSON-line emission). Custom loggers
always see plain text (colors are off when a non-default logger is
provided).

The CLI dispatcher (`run(argv)` in `src/cli/index.ts`) is not part of
the public package exports; `bin.ts` calls it directly.
