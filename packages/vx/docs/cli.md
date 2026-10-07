# CLI reference

The `vx` binary is the user-facing entry point. The implementation is
intentionally simple: a hand-rolled argv parser (no commander / yargs)
in `src/cli/index.ts` dispatches to per-subcommand handlers under
`src/cli/<name>.ts`. The flag surface is aligned with
[Turborepo's `turbo run`](https://turborepo.com/docs/reference/run)
so existing Turbo users can swap in with minimal muscle-memory churn.

```sh
# Standalone binary via npm (no Bun required on target):
npm install -g @vzn/vx

# From source (Bun ≥ 1.4):
bun src/bin.ts --version
```

Below that floor vx still runs, and `vx info`'s `bun` row says so, because
what an older Bun breaks is the ANSWER, not the start: a large `--format json`
write is truncated mid-stream, no task reports what it used, and a config
syntax error surfaces as an internal error rather than the usual message.
[`modules/util-bun-version.md`](./modules/util-bun-version.md) has the
measurements and why the verdict lives on that row rather than on stderr. The
released binary carries its own Bun and the row never says it.

## Top-level shape

```
# Core
vx run [OPTIONS] [TASK | PKG#TASK ...] [-- forwarded-args...]
vx watch [OPTIONS] TASK [-- forwarded-args...]
vx cache prune [--older-than <duration>] [--max-size <size>] [--dry-run] [--format pretty|json] [--cache-dir <path>]
vx lock [--check]
vx init [--dry] [--force] [--mjs] [--plugin <seam>]
vx show [PROJECT[#TASK] | TASK] [--format pretty|json]
vx info [--format pretty|json] [--cache-dir <path>]
vx why (TASK | PKG#TASK) [--run <runId>] [--format pretty|json] [--cache-dir <path>]
vx last [RUNID] [--list[=N]] [--failed] [--format pretty|json] [--cache-dir <path>]
vx upgrade [tag]      # self-update a compiled binary
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

Multiple positional tasks run in one orchestrator invocation with a
shared task graph: `vx run build lint test` fans out all three across
the resolved project scope. Anchored entries (`pkg#task`) target a
specific project; bare entries follow the usual scope rules
(default = the cwd project; broaden with `--all` / `--filter` /
`--affected`). The cwd project is the deepest member holding the
directory, a member reached through a link (`packages/b -> ../ext/b`)
included.

**Every requested name must resolve.** If any positional matches no
project in scope, the run refuses to start — `vx run: no projects
declare task(s): <name>.` on stderr, a run and `--dry` / `--graph` alike
(a run printed it to stdout until 2026-10-03), exit 1, with `Did you mean <task>?` when a
declared task (or, for `pkg#task`, a runnable spec) is within two edits,
and with no name that near, what exists: `Tasks: build, test.`, `No
project is named zzz; projects: a, b.`, or `a's tasks: build, test.`
(M-56),
and with `Only projects outside the selection declare <name> — pass
--all, or --filter to pick them.` when the run was scoped (the cwd's
project, a `--filter`) and a project outside the scope declares it
— even when the other names resolved fine. A bare name declared by only SOME projects is normal and stays
green; the guard fires only when a name matched nowhere. So a CI job
running `vx run lint test typecheck` goes red the day `typecheck` is
renamed, instead of silently running two of three. Under a scope a git
diff chose (`--affected`, a `[ref]` filter) a bare name is judged against
the whole workspace instead, since which projects hold it depends on what
changed: `vx run test --affected` after a commit that changed only a
project without `test` exits 0 with `No affected project declares
task(s): test.`, and a name no project declares is still refused (item
1024). A change that reaches no requested task exits 0 with `Nothing
affected: the change reaches no test task.` A diff that touched no project stops before that check:
`nothing affected since <ref>` on stderr, exit 0, a typo unseen.

(No `-V` for version; `vx --version` only — matches Turbo.)

`vx <verb> --help` (and `-h`, and `vx help <verb>`) prints this reference
cut to that core verb — its usage lines and sections, then
`Full reference: vx help` —
and every argument error points at it. `vx help <name>` for a name that
is no verb here (core, a plugin's, or a moved one) is refused as
`vx <name>` is: one line, a guess when one is close, exit 1.
Past a `--` the flag belongs to the command being run, so
`vx run build -- --help` forwards it to the task instead. A plugin verb
owns its own arguments, `--help` included.

## `vx run`

```
vx run [OPTIONS] [TASK | PKG#TASK ...] [-- forwarded-args...]
```

Run the named task(s). By default only the project containing the
current working directory is selected — `dependsOn` still expands so
the project's upstream workspace deps run too. Override with `--all`,
`--filter`, `--affected`, or an explicit `pkg#task`.

If no task name is given:

- **In a TTY** — an interactive picker lists every `pkg#task` entry
  across the workspace, prints `description` next to each, prompts
  for a number, runs the chosen one. Ctrl-C at the prompt exits `130`
  as an interrupted run does; Ctrl-D exits `1` with `no task picked`.
  A workspace with no task exits `1` naming how to declare one (under
  `tasks` in a vx.config, or `vx init`).
- **Not a TTY** — exits `1` with
  `missing task name (stdin is not a TTY, so no picker; tasks here: build, test)`,
  naming the cwd project's tasks, else every project's (twelve, then
  `and N more`); outside a workspace it reads `vx run <task>, e.g. vx run build`.

Exit codes:

| Code                  | When                                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`                   | Every task finished `success` or `cache-hit` (local or remote); or `--affected` left no project that declares the task.                                                                                                   |
| `1`                   | At least one task ended `failed` or `skipped`; a persistent task exited non-zero after it was ready; a task name no project declares; or parse/setup error.                                                               |
| `130` / `143` / `129` | Interrupted (SIGINT / SIGTERM / SIGHUP): each task's process group (the task and what it forked) gets vx's signal (a SIGHUP as a SIGTERM), `VX_KILL_GRACE_MS` (2 s) to go, then SIGKILL; a second signal skips the grace. |

A task runs in its own session, so a terminal's Ctrl-C reaches vx alone,
and each task hears it once: from vx, as SIGINT.

Installed from npm, `vx` is a Node launcher. On Node 22.15 or later it
replaces itself with the binary (`process.execve`), so every signal
reaches vx directly. On older Node it runs the binary and waits for it:
a signal sent to the launcher alone (`kill`, a process manager) is
passed to the binary, and a terminal's Ctrl-C already reaches both, so
the launcher does not send it twice.

A reader that leaves does not change the code. `vx run build | head -1`
closes the pipe after one line; the run still finishes, saves what it
built and releases its lock, and exits with its own verdict — the
output after that point goes nowhere (`EPIPE`, on stdout or stderr, is
not an error vx reports). Before 2026-09-16 the same pipeline died with
a stack and exit 1 after its task had succeeded.

### Selection

| Form                          | Effect                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| (default)                     | The project that contains cwd. Errors if cwd is not inside a project.                              |
| `pkg#task`                    | Just that project.                                                                                 |
| `//#task`                     | The root project's task (Turbo's spelling; the root is a project, D-39).                           |
| `--all`                       | Every project that declares the task.                                                              |
| `--filter <pat>` (repeatable) | pnpm-style filter DSL (see below).                                                                 |
| `--affected[=<base>]`         | The tasks a git change reaches: the ones it touches and those whose `dependsOn` closure holds one. |

Combining: every include (`--filter <pat>`, `--affected`) is taken
first and every `!` exclude after them all, as pnpm does, so an
exclude removes what any include added, whichever side of it it sits
(items 955, 979). The union holds for tasks too: `--affected --filter
other` runs other's tasks whether or not the change reaches them
(X-10). `--all` with a filter is the filter's selection:
the filters refine it rather than being overridden by it
(`--all --filter '!docs'` is everything but docs).

### Filter DSL (`--filter`)

The full DSL lives in `src/workspace/filter.ts`; this is the user-
facing summary.

A filter that matches nothing refuses the run (`no projects matched
filter(s): …`) with `Did you mean <name>?` when a project name is within
two edits, or when exactly one scoped project's name after its `/` is
(`--filter vx-mcp` hints `@vzn/vx-mcp`), and `Projects: a, b` otherwise
(M-56). A list names eight, then a count. An unmatched `tag:` filter
hints the nearest tag instead (`Did you mean tag:scope:web?`), else
lists the tags. When every pattern matched and an exclusion took back
all of it, the refusal names the exclusion instead (`no projects
selected: !app excluded every project the other filters matched`).

| Form              | Meaning                                                                                                                                                                                                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<pattern>`       | Match by package name. `*` matches any characters, including `/`. A pattern matching no package may leave out the scope, as pnpm reads it (`cart` is `@nx-example/cart` when one package carries it).                                                                                                                  |
| `./<dir>`         | The package at `<dir>` alone, as Turbo and pnpm read it (`.` is the root project); a `<dir>` that is no package matches the packages under it (relative to workspace root; D-43).                                                                                                                                      |
| `{<dir>}`         | Same as `./<dir>`.                                                                                                                                                                                                                                                                                                     |
| `./<glob>`        | A glob over root-relative project dirs: `./packages/*` (direct children), `{apps/**}` (nested too; a trailing `**` matches zero dirs, so `./packages/kit/**` holds kit itself, as pnpm and Turbo read it). A path that names a project dir literally is read literally first, so `./packages/[abc]` is that directory. |
| `.`               | The root project alone, when the root is a project (D-39); otherwise the packages under the root, i.e. every package, not the one you are standing in.                                                                                                                                                                 |
| `//`              | The root project alone, Turbo's name for it; matches nothing when the root is no project (D-46).                                                                                                                                                                                                                       |
| `tag:<pattern>`   | The projects whose config `tags` hold a match, as Nx's `tag:` reads them (`*` as in a name). Takes every operator a name takes: `!tag:x`, `...tag:x`, `tag:x^...`, `tag:x[main]`. Nx's `--projects tag:x` aliases it.                                                                                                  |
| `<pattern>...`    | Match + all transitive dependencies (see below what an edge is).                                                                                                                                                                                                                                                       |
| `...<pattern>`    | Match + all transitive dependents.                                                                                                                                                                                                                                                                                     |
| `<pattern>^...`   | Only the transitive dependencies, excluding the matched package itself.                                                                                                                                                                                                                                                |
| `...^<pattern>`   | Only the transitive dependents, excluding the matched package itself.                                                                                                                                                                                                                                                  |
| `...<pattern>...` | Match + its dependents + the dependencies of all of them, as Turbo selects (`...db...` takes the packages the apps that use db build on).                                                                                                                                                                              |
| `<sel>[<ref>]`    | The packages `<sel>` (a name pattern or `{<dir>}`) selects that changed since `<ref>`, as Turbo and pnpm read `@scope/*[main]` (D-44).                                                                                                                                                                                 |
| `<sel>...[<ref>]` | The packages `<sel>` selects that changed since `<ref>` or depend on one that did; no dependency is added (Turbo: `@acme/api...[HEAD]` is api when only its dependency changed).                                                                                                                                       |
| `!<pattern>`      | Exclude packages matching `<pattern>`, from everything the includes select, in any order.                                                                                                                                                                                                                              |
| `[<git-ref>]`     | Projects whose files changed since `<git-ref>` (`main`, `HEAD~5`, …).                                                                                                                                                                                                                                                  |

An edge is a `package.json` workspace dependency (`dependencies`,
`devDependencies`, `peerDependencies`, `optionalDependencies`; a peer
that would close a cycle counts for selection only, see
`modules/package-graph.md`) — an entry the package manager links to a
workspace package, not one whose key merely names it:
`"shared": "^1.0.0"` beside a local `shared@2.0.0` is a registry
dependency and no edge, and `"luigi": "workspace:../waluigi"` is an
edge to `waluigi` (the rule: `modules/package-graph.md` § Which entries
are edges) — OR a
cross-project `dependsOn` entry (`e2e`'s `test: { dependsOn:
['app#build'] }` makes `e2e` a dependent of `app`). The task graph knows
both, so selection follows both: `vx run test --filter '...app'` runs
`e2e#test` even though `e2e` has no manifest dependency on `app`. There
is no `implicitDependencies` field — declare the edge where the task
needs it.

A filter that names no project (`...`, a bare `!`) is refused, and one
whose pattern matched but whose walk selected nothing says what it
matched: `no projects selected: filter "...^core" matched core, and no
project depends on it` (item 1030).

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

- `--affected` (no value) uses the workspace's `affectedBase` when it
  names one (`nx()` and `turbo()` set it from `NX_BASE` / nx.json's
  `defaultBase` and `TURBO_SCM_BASE`, `turbo()` on GitHub Actions from
  the pull request's base or the push's `before`, as Turbo does;
  [schema](schema.md)), else
  `origin/HEAD`; without one (actions/checkout sets none, nor does a
  repo with no remote), the first of `origin/main`, `origin/master`,
  `main`, `master` that is not HEAD itself, as Turbo and Nx compare with
  `main` (D-93); else `HEAD~1`. A clone with neither — a
  CI checkout at `fetch-depth: 1` — has no base at all, and vx says so
  (`--affected has no base here … a shallow clone?`) instead of failing
  on a `HEAD~1` nobody typed. And when the base IS the commit you are
  on (a single-branch clone whose `origin/HEAD` is the branch under
  test), the `nothing affected since <ref>` note says the ref is HEAD
  itself and names the two bases you probably meant
  (`--affected=origin/main`, `--affected=HEAD~1`).
- Without git on PATH, every shape is one line — `vx requires git:
failed to spawn 'git' … Install git and re-run` — the same the input
  enumeration prints; a minimal image met a stack here before
  (2026-09-16). Outside a git work tree every shape says `vx requires
git: <root> is not inside a git work tree`, as a plain run does, and a
  repository with no commit yet says so, not "a shallow clone?" (X-52).
- `--affected=<ref>` uses the given git ref. A value that is empty or
  starts with `-` is refused before git sees it: the ref is an argument,
  never a shell command, and an option-like one (`--output=<path>`)
  would be a real `git diff` option. A range (`HEAD~1..HEAD`,
  `main...feature`) is refused there too, naming the base to pass
  alone — `ranges are not supported — pass the base alone ("HEAD~1")`
  — because the other end is always the working tree; `<base>...HEAD`,
  Turbo's CI spelling, is read as `<base>`, since vx diffs from the merge
  base to a working tree that holds HEAD (D-117). Its two-dot `<base>..HEAD` diffs from
  `<base>` itself, not the merge base. A ref that does
  not exist is `git ref "<ref>" did not resolve`; in a shallow clone (CI's
  one-commit checkout) it adds that the clone is shallow and how to fetch
  the history (`git fetch --unshallow`, `fetch-depth: 0`).
- A member whose directory is a symlink to a place elsewhere under the
  workspace root (`packages/b -> ../ext/b`) is selected by a change at
  that real place too: git names the files where they live, not by the
  link (item 1079). A link to a directory outside the root is outside
  git's view, and a change there selects nothing.
- The diff runs from the **merge base** of the ref and `HEAD`, not from
  the ref itself, so a branch whose base has moved on sees only its own
  changes — never the files other people landed on `main` since it
  forked (Turbo and Nx do the same). Refs with no common ancestor diff
  from the ref.

**It selects the tasks the change reaches (owner, 2026-10-04).** A
change seeds tasks in the projects it touches:

- a cached task when a changed path is one of its declared inputs
  (`files`, `workspaceFiles`);
- every task of a project whose `package.json` or `vx.config.*`
  changed, or that holds a changed path no cached task of its declares
  (vx cannot prove that path re-keys nothing), or that a lockfile
  claim, a manifest edge at the base or a config import names;
- an uncached task when a changed path lies in its project or the
  project is reached whole; a root file another task of its declares
  (`workspaceFiles`) is no change there. A group seeds nothing.

A requested task runs when its `dependsOn` closure holds a seeded task,
so a change reaches another project only along a task edge. With
`app#test` behind `^build`, an edit to `ui/src/button.ts` that
`ui#build`'s inputs read runs `ui`'s tasks and `app#test`; an edit to
`ui/src/button.test.ts` that only `ui#test` reads runs `ui#test` alone,
and `app#lint`, which depends on nothing, never runs for a change in
`ui`. A `pkg#task` you name runs whatever the diff. This is the edge
the cache key folds (a cached `app#test` with no edge to `ui` never
sees `ui`'s files either). A project that declares no `build` gets one
keyed on all its files (`schema.md`), so any change there reaches a
dependant behind `^build`; a package `^name` passes through for want of a
config reaches it the same way.
The graph is the one a `graph` plugin leaves: an edge or an input it
adds reaches a task as a declared one does, and a task it marks
requested runs whatever the diff. With such a plugin every project is a
candidate once the diff touched anything, and its hook sees every
candidate task before the selection prunes the graph.
Nx 23.3 (`NX_LEGACY_AFFECTED=false`) and Turbo
(`affectedUsingTaskInputs`) select tasks the same way, behind flags.

Until 2026-09-16 the sugar was the changed-only `[<base>]` form (item
287), and until 2026-10-04 it took every task of every manifest
dependent, which the filter forms still do:

```bash
vx run test --affected                # the tasks the change reaches
vx run test --filter '...[main]'      # what changed + every dependent project
vx run test --filter '[main]'         # only the projects that changed
```

Its candidate projects are `--filter '...[<base>]'`'s; both are resolved by
`src/workspace/affected.ts`, which unions `git diff` against `<base>`
with `git ls-files --others` so a brand-new untracked source file counts
as a change (input hashing sees it, so `--affected` must too). A
project inside a submodule or an embedded repository is selected when
git reports that repository changed — a dirty or moved submodule
(`vendor/sub`), an untracked embedded repository (`vendor/nested/`):
the workspace repository sees the nested one as a single path, so a
change inside is a change to it, and every project under it is
selected. A repository's own request to hide submodules from a diff
(`diff.ignoreSubmodules`, `submodule.<name>.ignore`) does not apply:
the key sees the change whatever git is told to show.
`vx-lock.json` is filtered out of the changed set — a `vx lock`
re-write never marks every project affected.

**A lockfile change selects everything.** The root lockfiles,
`pnpm-workspace.yaml`, `.yarnrc.yml`, `.npmrc`, `bunfig.toml` and the patches `bun.lock` names are folded into the [workspace
fingerprint](./caching.md), which is part of _every_ task's cache key —
so a `bun install` / `pnpm update` invalidates the whole cache. Those
files sit at the workspace root and belong to no project, so mapping
changed paths to project directories would select nothing; `--affected`
widens to every project instead, for the same reason it unions in
untracked files. Only the ROOT copies count: a lockfile vendored inside
a package is not hashed and selects just that package. A lockfile a
plugin CLAIMS (`VxPlugin.fingerprint`, e.g. `pnpm-lock.yaml` under
`@vzn/vx-lockfile`) is the exception on both sides: the key folds what the
plugin says per project, so `--affected` asks the plugin which projects
the change touches — given the bytes at the base ref and in the working
tree — and selects those; only a plugin that cannot tell widens.

**A dropped edge selects its dependent.** A package the change deleted
(its `package.json` was there at the base and is gone) is no project
now, so its paths map to nothing; and one whose `version` or `name`
moved may no longer satisfy what a dependent declares (`lib: ^1.0.0`
after a bump to 2.0.0). Either drops an edge the dependent's key folded,
while today's graph shows no dependent to walk to. So the package graph
is built again over the changed manifests as the base had them, and
every project whose workspace dependencies differ is selected, and so
is a project whose task names a removed or renamed package in
`dependsOn: ['lib#build']`, an edge the package graph cannot see
(item 1085). An edit to the root manifest's `workspaces` selects every project:
which packages left the workspace is a discovery at the base.

**A new nested project selects the project above it.** A project's
inputs stop at every project below it, so a `package.json` that makes
an existing directory a project re-keys the project that held it; the
change maps to the new project alone, so the one above it is selected
too. "New" is judged at the base: no manifest there, or one with no
`name`.

**A workspace config change selects everything.** An edit to
`vx.workspace.*`, or to a file it imports by relative specifier, selects
every project: the `config` and `project` stages its plugins install
shape every resolved config, so the edit can re-key any task, and
selection cannot tell which. It is not in the fingerprint (a key moves
only when a stage's output does). A root file a plugin's stages read
without importing it is seen when the plugin CLAIMS it
(`VxPlugin.fingerprint`): `turbo()` claims `turbo.json` and
`turbo.jsonc`, `nx()` claims `nx.json`, and an edit asks the claimant,
which answers every project (item 961).

**A file your config IMPORTS selects that project.** vx hashes the
resolved config, so a shared preset a `vx.config.*` imports is part of
the cache key — and selection follows the same rule. Editing
`shared/preset.ts` selects every project whose config imports it,
directly or through another shared file, even though the file belongs
to no project and no `workspaceFiles` glob names it. The scan is
STATIC (nothing is evaluated) and follows RELATIVE specifiers, and a
bare one the nearest tsconfig maps through `paths` or `baseUrl`; any
other bare specifier is a package, and a lockfile change already selects
everything. It stops at a project boundary (a root project's files excepted): a config importing
`../../packages/lib/preset.ts` gets the edge, but `preset.ts`'s own
imports inside `lib` do not reach further — `lib` is already selected
by containment. Import your helpers by bare specifier to opt out. See
[`docs/modules/config-imports.md`](./modules/config-imports.md).

**Nothing changed exits 0.** When the selection comes only from
`--affected` / `[<ref>]` and resolves to zero projects, vx prints
`nothing affected since <ref>` and exits 0 — a docs-only commit must not
fail `vx run lint test build --affected=origin/main`. A name or path
pattern that matches nothing is still an error (a probable typo), and a
pattern that matches nothing alongside one that matched is warned about
on stderr.

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
them as a command of their own), or before a `#` comment still
open there (`echo args: # show` gets them; with comment-only lines
below a commented line, before the earliest). A heredoc's body and
terminator are not command lines: `cat <<X … X` gets them on the
`cat <<X` line (X-12). A persistent task gets
them too, with or without a `readyWhen`.

Forwarded args are folded into the cache key — different args produce
different cache entries. They scope to user-requested tasks only;
dependsOn-pulled deps don't see them (so upstream cache identity
stays clean). A frame's `$ <command>` line shows the command as it
ran, so a requested task's carries the args and a dependency's does
not.
A group (a task with no command) takes none, so a request that names
only groups is refused (`args after \`--\` reach no task`) rather
than run with the args unheard.

### Flags

| Flag                               | Type           | Default                            | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | -------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--filter <pattern>`               | repeatable     | (none)                             | pnpm-style filter DSL (see above). `--filter=<pattern>` form too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `--all`                            | boolean        | off                                | Select every project that declares the task.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--affected[=<base>]`              | optional value | off                                | Select the tasks a change since `<base>` reaches: the ones it touches and those whose `dependsOn` closure holds one (default `affectedBase`, else `origin/HEAD`, else `main` or `master`, else `HEAD~1`); candidates are `--filter "...[<base>]"`'s.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `--exclude-dependencies[=<names>]` | optional value | off                                | Drop `dependsOn` edges. No value = all (just the requested task runs; a group's members run as the group); comma-list = drop only those names, each of which some project must declare (a typo is refused with the nearest name, item 1026). An edge to a task the run schedules anyway (`--all` requests it) stays, so the two still run in order, and so does the order through a dropped task: with `gen` dropped from `test → gen → build` and `build` requested, `test` still waits for `build`. An empty `=` value is a parse error (ambiguous — see below). A dropped dependency does not run but is still keyed, so every key is the one a full run derives; a task keyed on one may hit but does not save (`caching.md` step 10).          |
| `--concurrency <n>`                | int or `<n>%`  | cores, capped by the cgroup quota  | Maximum parallel tasks that EXECUTE; confirmed cache-hit restores are disk work and run on their own lane, up to twice this. `1` serializes both; `50%` is half the CPUs (rounded, never below 1; over 100% is allowed for I/O-bound work). `--concurrency=<n>` form too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--no-cache`                       | boolean        | off                                | Disable caching entirely (no reads, no writes); output globs are NOT cleaned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `--force`                          | boolean        | off                                | Re-execute everything (skip cache reads) but still REFRESH the cache (writes stay on). Output globs are cleaned (so the saved snapshot is clean).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `--cache <spec>`                   | value          | all axes on                        | Per-layer read/write control. See below. An EMPTY spec (`--cache=`) is a parse error — it applied nothing and left every axis on; pass `--no-cache` to disable them all.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--cache-dir <path>`               | value          | workspace `cacheDir` / `.vx/cache` | Cache directory override, resolved relative to cwd (absolute paths used as-is). Beats the `defineWorkspace({ cacheDir })` field, `VX_CACHE_DIR` and the default; like them, the directory then holds the whole cache, shared through no store, for every cache the run opens — the config-evaluation cache that `--affected` owners, the picker and the watch sweep read included, so the workspace's default dir is not created beside it. A per-run knob — never folded into a cache key. `--cache-dir=<path>` form too; the space form rejects a value starting with `-`. A directory this user cannot write into fails the run before any task with `cache directory <path> is not writable (EACCES: …)` — every run records its history there. |
| `--retry <n>`                      | value          | `0`                                | Re-run a failed task up to `n` more times; never a persistent one. Run-level default only: a task's own `exec.retries` wins (even an explicit `0`). Never affects cache keys. `--retry=<n>` form too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--continue[=<mode>]`              | value          | `deps-ok`                          | What a failed task takes down with it. `never` stops dispatch on the first failure; `deps-ok` (default) skips only its dependents; `always` (bare `--continue`) runs dependents anyway. See § Failure propagation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--timeout <ms>`                   | positive int   | none                               | Default per-task timeout for tasks without their own `exec.timeout`. Sits above `VX_TASK_TIMEOUT` + workspace `timeout`; per-task `exec.timeout` always wins. A runaway task is killed + `failed`. Never affects cache keys. `--timeout=<ms>` form too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `--frozen`                         | boolean        | off                                | Load configs from `vx-lock.json` instead of evaluating (CI) — the run's, and the ones `--affected` owners and the picker select from. See § `--frozen`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `--output-logs <mode>`             | value          | flow-derived                       | `full` \| `errors-only` \| `hash-only` \| `none` — explicit output override. See § `--output-logs`. `--output-logs=<mode>` form too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `--download <mode>`                | value          | `all`                              | `all` \| `toplevel` \| `none` — where a REMOTELY-executed task's outputs land. `none` leaves them in the remote CAS and fetches lazily, only when a locally-placed task needs them. Never affects cache keys. See § `--download`. `--download=<mode>` form too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--verbosity <n>`                  | int (0+)       | `0`                                | `1` or more prints a per-task table (groups left out) after the framed blocks, above the footer. `--verbosity=<n>` form too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--dry[=text\|json]`               | optional value | off                                | Print the task graph + predicted cache hit/miss; skip execution. `VX_TIMING=1` prints the stage table here as it does for a run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `--graph[=<path>]`                 | optional value | off                                | Emit Graphviz DOT (stdout if no path, its directory made if missing); skip execution. A path it cannot write is one line and exit 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `--summarize[=<path>]`             | optional value | off                                | Write per-run JSON to `<cacheDir>/runs/<run_id>.json` (or the explicit path).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `--profile[=<path>]`               | optional value | off (`profile.json` when set)      | Write Chrome-trace JSON of the run's wallclock spans.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--tag <k=v>`                      | repeatable     | (none)                             | Label this invocation. Recorded on the run's `invocations` row so dashboards can filter runs. `--tag=k=v` form too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `--report[=markdown]`              | optional value | off                                | After the run, print a markdown run report to stdout. Only `markdown` is supported (`json` is reserved).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--report-file <path>`             | value          | off                                | After the run, APPEND the same markdown report to `<path>`, making its directory as the other output paths do. Use this for `$GITHUB_STEP_SUMMARY` — redirecting stdout captures the whole run log too. `--report-file=<path>` form too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Mutual exclusion:

- `--dry` and `--graph` — both skip execution; pick one.
- `--dry` or `--graph` with `--summarize`, `--profile`, `--report` or
  `--report-file` — each needs a real run to write about. `--report` and
  `--report-file` were accepted and silently wrote nothing until item 992.

Unknown flags are a parse error (`unknown flag: --foo`), naming the
nearest flag the verb accepts when one is within two edits
(`unknown flag: --concurency (did you mean --concurrency?)`). Every verb
does this against its own usage line and `--help`: `vx info --formt`
hints `--format`, `vx lock --chek` hints `--check`, `vx upgrade --hlp`
hints `--help`, and `--json` on a verb that takes `--format` hints
`--format json`. `vx version` takes no word, so `vx version --hlp` is
refused (exit 1) where it once printed the version.

A task typed where the verb goes (`turbo build`, `nx build app`) is
refused with the `vx run` that runs it: `vx build` names
`vx run build --all` from the root and `vx run build` inside a project,
`vx build app` names `vx run build --filter app`, and `vx app#build`
names `vx run app#build`. A typo of a task (`vx biuld`) names the task
and the same `vx run`, unless a verb is as close (`vx rnu` hints `run`).
It stays a refusal: a plugin verb of the same
name is the verb, and would change what `vx build` means the day one
was declared.

**Optional-value flags take their value with `=` only.** `--affected`,
`--exclude-dependencies`, `--dry`, `--graph`, `--summarize`, `--profile`,
and `--report` are all valid bare, so a following word is
read as a task name (a `--graph` word ending `.svg`, `.png`, `.json`
and the like is refused, see § Turbo and Nx flags) — `vx run --affected build` means "run
`build`, affected scope", and there is no way to tell that apart from
"`build` is the git base". Write `--graph=out.dot` or
`--affected=origin/main`. Getting it wrong is loud, not silent: the value
becomes a positional that matches no project, so the run refuses to
start (see "Every requested name must resolve" above).

`--exclude-dependencies=` with an EMPTY value is rejected rather than
guessed — "drop every edge" and "drop none" are both plausible readings.
Pass bare `--exclude-dependencies` for the first, omit the flag for the
second.

Value flags (`--filter`, `--concurrency`, `--output-logs`,
`--verbosity`, `--cache-dir`, `--report-file`, …)
accept both `--flag value` and `--flag=value`. In the space form,
`--cache-dir` and `--report-file` reject a value
starting with `-`: that is always a swallowed flag (an unquoted empty
shell variable), never a path or task id. Use the `=` form for a literal
leading dash.

**Numeric flags take a plain decimal integer.** `--concurrency`,
`--timeout`, `--retry` and `--verbosity` reject hex (`0x10`), exponent
(`1e3`), fractional (`2.7`), signed (`+4`) and space-padded forms, plus
anything past `2^53` (it would parse to a number you did not type).
These all used to be silently reinterpreted — `--concurrency 0x10` ran
16 workers.

An empty `=` value means "no value" on four flags, which then act like
their bare forms: `--profile=` writes `profile.json`, `--summarize=`
writes `<cacheDir>/runs/<run_id>.json`, `--graph=` prints to stdout and
`--affected=` uses the default base. Every other flag refuses an empty
value: `--dry=`, `--report=`, `--continue=` and
`--exclude-dependencies=` as well as the ones with no bare form
(`--retry=`, `--timeout=`, `--cache-dir=`, `--filter=`, `--cache=`).

#### Cache control: `--cache`, `--no-cache`, `--force`

The cache has four independent axes — **localRead**, **localWrite**,
**remoteRead**, **remoteWrite** — and the three flags above resolve
them in this precedence order:

1. Start with every axis **on** (the default).
2. Apply each `--cache=<spec>` segment (the base).
3. If `--no-cache` was passed, force **all four off**.
4. If `--force` was passed, force **both reads off** (writes stay
   whatever the base / `--cache` left them).

A spec that names a remote axis (`remote:r`, `remote:w`, `remote:rw`)
in a workspace whose plugins supply no remote layer gets one status
line saying so — the axes are inert without a layer to serve them, and
a CI job that believes it is filling a shared cache should be told.

So `--no-cache` always wins over `--force`. The common cases:

- `--no-cache` → nothing reads, nothing writes, and declared output
  globs are left untouched (you're debugging; vx won't manage your
  tree).
- `--force` → re-execute every task (reads off) but still write fresh
  artifacts to both layers (writes on). Output globs ARE cleaned
  before each task so the saved snapshot is clean. This is the "rebuild
  and refresh the cache" flag.

`--cache=<spec>` is a comma-separated list of `<layer>:<flags>`
segments. `layer` is `local` or `remote`; `flags` is any subset of `r`
(read) and `w` (write), order-independent and possibly empty. A
**mentioned** layer is set EXACTLY to its flags; an **unmentioned**
layer keeps its current value. Both `--cache=<spec>` and the space form
`--cache <spec>` are accepted.

| Spec                        | Effect                                                  |
| --------------------------- | ------------------------------------------------------- |
| `--cache=local:rw,remote:r` | remote read-only (won't upload); local full             |
| `--cache=local:r`           | local read-only; remote untouched (still full)          |
| `--cache=remote:`           | remote fully off; local untouched                       |
| `--cache=local:,remote:rw`  | don't touch the local cache, but still upload to remote |

`local:` means "don't serve hits out of the pre-existing local cache" —
a remote hit is still delivered (the artifact has to land on disk to be
extracted), it just never short-circuits the remote read.

Combine with `--force` for "re-execute and refresh only the remote":
`--cache=local: --force` (local off, reads off, remote write-only).

Invalid layers/flags are a parse error
(`invalid --cache layer 'disk'`, `invalid --cache flag 'x'`, …).

### Output

What a run prints is derived from the run's intent (its "flow"),
unless explicitly overridden:

- **FOCUSED** — no selection flag was passed. The user is running
  "their" task; cwd and task count are irrelevant to the
  classification.
- **BROAD** — the invocation used `--all`, `--filter`, or
  `--affected`. The user asked about a swath of the workspace and
  wants news, not output.
- **CI** — the `CI` env var is truthy (`CI=0` / `CI=false` don't
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
  it. With several requested tasks the same frame is buffered and
  emitted atomically (see below). Every outcome that ran or was cached
  gets one — including an `up-to-date` hit, whose frame carries the
  `$ cmd` line so a requested task looks the same whether it ran or not.
- **skipped** is the exception: it never started, so no frame was opened,
  and it produced nothing a frame could hold. The one-liner says
  everything, the blocker included (`⊘ skipped app#deploy • blocked by
lib#build`; a fail-fast skip, which nothing blocked, carries no
  suffix). Every view that lists tasks prints it, a dependency's
  included: nothing prints below the footer. `--report` reads the same fact into the status cell,
  `skipped (blocked by lib#build)`.
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
   task that became ready. The pin lives until run end, so it is the
   visible evidence the dev server is still alive. After the summary,
   a requested persistent task keeps vx in the foreground, with the
   persistent tasks it depends on, until it — or, with several, the
   first of them — exits; the rest are then torn
   down (SIGTERM, `VX_KILL_GRACE_MS`, SIGKILL), one status line names
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
3. **Worker rows** — one per worker slot (sized
   `min(concurrency, 10)`), no glyph and no spinner: the live ticking
   elapsed time leads (`     568ms running  <id>`). A task stays in
   its row for its whole life; idle rows hold their place dimmed, so
   nothing ever jumps; overflow shows as `+k more`.
4. **The live summary section** — the SAME meters the final footer
   prints (`tasks` + `cache` bars with legends, `time`), filling in as
   the run progresses, under a bare `vx` wordmark rule.

The region is redrawn in place (cursor-up + clear; not a TUI — no
alternate screen) and erased before the final summary prints. In the
focused flow it only lives while dependencies run; it disappears for
good the moment the requested task starts streaming.

Redraw cost is bounded: task events force a redraw, but forced
redraws within 30 ms of the last draw coalesce into a single
trailing draw when the floor expires (the final state always lands).
On a 3,270-task warm run this cuts ~6.7 MB of redraw ANSI to ~20 KB.

Identity coloring: every `project#task` renders its project half in
a stable hue hashed from the project name (same project = same color
in every run and every surface) and its task half in a fixed pink —
both deliberately outside the status palette, so an id can never
read as an outcome.

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
`errors-only` (only failed tasks print; the CI noise budget),
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
  tasks finish naturally; everything not yet started (cache restores
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
  without the failure rebuilds the rest.

The mode is the local scheduler's: a task a plugin executor runs
elsewhere is one dispatch, failed or not, like any other.

### `--download <mode>`

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
`exec.remote: 'only'` still means never — `--download` cannot override
it in either direction. **It never affects a cache key**: transfer
tuning cannot change what a command produces.

One safety gate: a task whose outputs another task's `cache.inputs`
globs could read on disk is silently kept eager, because deferring it
would make that key depend on whether the bytes arrived. A task with no
`cache` that a cached task depends on counts as reading its whole
project (C-16). `--dry` reports
how many tasks would keep their outputs remote and names each downgrade,
so a run that defers nothing says why. A run in which any task declares a
`cache.inputs.runtime` / `workspaceRuntime` command defers **nothing**:
a shell command's reads cannot be bounded, so vx cannot prove it will
not read a deferred output (the same reason vx refuses to infer inputs
by tracing). When bytes are fetched later, vx saves an ordinary
cache entry for them, so the next run is a plain local hit.

## Planning mode (`--dry`, `--graph`)

Both flags short-circuit execution. They build the full task graph,
compute every task's cache key, and probe the cache to predict the
hit/miss outcome. Against a remote cache the probe is a lightweight
existence check — planning never downloads or ingests artifacts.

```
$ vx run ci --dry
would run:
  ◉  @vzn/vx#format-check  cache hit (local)         02bfe8a9
  ◉  @vzn/vx#lint          cache hit (local)         d66cfed2
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

Status legend:

| Symbol | Meaning                                                                                    |
| ------ | ------------------------------------------------------------------------------------------ |
| `◉`    | cache hit (local) — entry already in `<cacheDir>/`                                         |
| `↓`    | cache hit (remote) — entry would be fetched from the layer                                 |
| `▶`    | cache miss — task would execute (under `--force` too: nothing is read, what runs is saved) |
| `·`    | no-cache — task opts out (no `cache` block, or `--no-cache`)                               |
| `∅`    | `@noop` — task would not run anywhere                                                      |
| `○`    | group task (suppressed in human view; in DOT + JSON)                                       |

`--dry=json` emits the same data as a structured object, alone on stdout
(a stage's warnings go to stderr); `schemas/plan.json` is its JSON
Schema, held like the read verbs' (see Machine-readable output):

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
  "predicted": { "wallMs": 0, "workMs": 0, "unknownCount": 0 }
}
```

Every task with history carries `p50Ms`, hits included (only the text
view's `~p50` is limited to tasks that would run); `predicted` counts
would-run tasks only and is present whenever local history was
readable.

`--graph` prints Graphviz DOT (stdout by default; `--graph=path`
writes a file):

```
vx run ci --graph | dot -Tsvg > graph.svg
vx run ci --graph=graph.dot
```

Node `fillcolor` varies by predicted status (green = local hit,
sky-blue = remote hit, orange = miss, gray = no-cache, fuchsia =
group). Edges are unstyled.

## Run artifacts (`--summarize`, `--profile`)

Both flags add a side-effect after a real run completes. Errors
writing the artifact are surfaced via `vx: failed to write …` but
don't change the run's exit code — the run already happened.

### `--summarize[=<path>]`

Writes a per-run JSON file; `schemas/summary.json` is its JSON Schema:

```json
{
  "runId": "01a0e3ef-206c-708d-95bf-c2b07211adf6",
  "ok": true,
  "exitCode": 0,
  "startedAt": "2026-09-27T17:34:54.572Z",
  "endedAt": "2026-09-27T17:34:54.586Z",
  "totalMs": 14.123643,
  "tasks": [
    {
      "id": "a#build",
      "project": "a",
      "task": "build",
      "status": "cache-hit",
      "exitCode": 0,
      "durationMs": 3,
      "hash": "48007ccadd42ed7d",
      "storedCpuMs": 2.059,
      "wallclockStartNs": "9456491",
      "wallclockEndNs": "12902888"
    }
  ],
  "aborted": [],
  "summary": {
    "successful": 1,
    "failed": 0,
    "skipped": 0,
    "cachedLocal": 1,
    "restoredLocal": 0,
    "restoredRemote": 0,
    "upToDate": 1,
    "cachedRemote": 0,
    "aborted": 0,
    "total": 1
  }
}
```

`runId` is a UUIDv7. Default path: `<cacheDir>/runs/<run_id>.json`. hrtime fields are
strings (bigints serialized as strings) to preserve ns precision
through JSON. `cpuMs` / `peakRssBytes` are what the task's own
execution used and appear on executed rows only (`peakRssBytes` only
when the task's peak rose above vx's own footprint — a lighter task's
figure would be vx's, handed back by the kernel; a Linux sandboxed task
reports neither, since what bwrap's pid namespace used never reaches vx);
a hit's `durationMs`
is the restore it cost, and what the PRODUCING execution used rides the
artifact and appears under its own keys, `storedCpuMs` /
`storedPeakRssBytes` (the work the hit skipped, the split
`storedDurationMs` draws in the event stream) — a remote worker's peak
is never presented as this run's. `admissionHeldMs` appears on a row
only when an `admit` policy (a plugin's — `@vzn/vx-schedule-history`
packs learned reservations) refused the task while a worker was free:
the wait from that first refusal to its dispatch, the plugin's hand on
the run. The footer's `info` row sums the waits, task-seconds:
`admit held 3 tasks, 4.2s in all` (85 held tasks can read 4783s beside
a 160 s run).

**`ok` / `exitCode`** are the run's verdict — the same value the CLI
exits with: a stopping signal's code (130 for Ctrl-C), and with a kept
server, its exit (the file is written again when the server ends). Gate on these rather than re-deriving a pass from the
buckets: a run can be red without a single failed task (see `aborted`).

**`tasks[]` and `summary` describe the same population**, so
`tasks.length === summary.total` always holds. Group tasks (no `exec`)
are in neither — they do no work.

**`aborted[]`** lists tasks whose attempt ended while the run was
stopping (Ctrl-C, a signal to vx), with their exit code, and tasks the stop reached before they started, with
exit 1, `durationMs: 0` and no `wallclockStartNs`. Neither joins an
outcome bucket or `total`, but they make the run red, so they are
listed separately and counted as `summary.aborted`.

**`noCache: true`** marks a task that declares no `cache` block — it
executes every run by design, so a hit rate should leave it out of the
denominator. The key is present only when true; every other row is
unchanged. Its `hash` is still set: dependents fold it.

**`notReady`** is present only on a failed persistent task: why it never
became ready — `timeout` (the readiness deadline fired; `exitCode` is
the kill's, 143 or 137 after the grace, as an ordinary timeout's),
`exited` (the child exited first; `exitCode` is then its own) or `spawn`
(the spawn itself failed). Every label reads it, `failed (never ready:
timed out, exit 143)`. A server the run's stop (a Ctrl-C) killed while it started is
`aborted`, not failed, as any task the stop kills.

**`sandboxViolations`** is present only on a sandboxed task with a
SANDBOX VIOLATIONS section — the count of its denials (vx's own notes
there count none), and the reason the task failed (its exit is forced to 1
when it was 0); every label counts it, `failed (exit 1, 2 sandbox
violations)`.

**`timedOut: true`** is present only on a `failed` row vx's own
`timeout` killed: its exit is the shell's 143, and every label reads
`failed (timed out, exit 143)` rather than a signal.

**`blockedBy`** is present only on a `skipped` row: the id of the failed
(or aborted) task at the root of what blocked it, through any chain of
skips between — what the skipped row prints, for a script.
A fail-fast skip has none.

**`flaky: { passes, failures, attempts }`** is present only on a task
this run proved flaky (its row's `flaky` note, typed): `passes` and
`failures` count the outcomes on record for this exact `hash`, this run
included, and `attempts` is what this run took. A consumer gating on
`status: "failed"` can tell a break (no `flaky` key) from a flake
without reading the history. Every other row is byte-identical.

**`durationMs` is always what THIS run spent on the task.** For a cache
hit that is the probe + restore, not the exec time the entry was stored
with — so it is small even for an expensive task. The work a hit
_skipped_ is a different number; `--report`'s "N saved" is the surface
that reports it.

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

Each project gets a distinct `tid` so concurrent tasks across packages
render on separate lanes. `ts` and `dur` are microseconds derived
from the per-task `hrtime.bigint()` spans the runner captures.
`cat` carries the task's final status (`success`, `cache-hit`,
`cache-hit-remote`, `failed`).

Default path: `profile.json` (cwd-relative).

### `--report[=markdown]`

After a real run completes, prints a markdown run report to **stdout**
(not the status logger — it stays machine-clean). One header line of
totals plus a table, one row per task:

```markdown
## vx run — passed

**3 tasks** · 3 success · 0 failed · 2 cached (1 up-to-date, 1 restored) · 1.23s total · 2.65s saved

| Task      | Status  | Cache      | Duration |
| --------- | ------- | ---------- | -------- |
| web#build | success | miss       | 1.23s    |
| web#test  | success | local      | 5ms      |
| api#test  | success | up-to-date | 3ms      |
```

`Status` is the task outcome (`success` / `failed (exit N)`, with the
signal an exit above 128 stands for, `failed (exit 137, 128 + SIGKILL)`,
or a timeout's reason, `failed (timed out, exit 143)`, a persistent
task's `never ready: …`, or a sandboxed task's violation count, or
`skipped`, naming what blocked it: `skipped (blocked by lib#build)`);
`Cache` is its provenance (`miss` / `no-cache` for a task with no `cache`
block, which never consulted it / `local` / `remote` / `up-to-date` /
`—`). A stopped run (a Ctrl-C teardown) reads `## vx run — interrupted`,
and its tasks keep the terminal's words: one the signal killed is
`aborted` with its time so far, one the stop reached before it ran is
`not run` with no time. Neither joins the counts; the header names them
after the total, `not counted: 1 aborted, 1 not run`, so a red report
with no failing row still says why. Group tasks (no `exec`) get neither — they are not
work, and the header's counts match the terminal summary and
`--summarize` exactly.

The two durations in the header mean different things, and the
distinction is the point:

- **`N total`** sums `Duration` over the tasks that actually EXECUTED,
  an aborted task's time so far included — the time this run spent.
- **`N saved`** sums the exec times the cache hits SKIPPED, read from
  each entry as it was stored (above, 2.01s and 640ms). It is
  deliberately not the hits' `Duration` column, which is the restore
  they cost this run: summing that reported a task taking 2.01s cold
  as "6ms saved".

Only `markdown` is supported today (`json` is reserved; a bad value is a
parse error). Built purely from the run's outcomes after it returns — it
adds zero cost when both flags are absent.

### `--report-file <path>`

Writes the same markdown report to a file instead of (or as well as)
stdout, and is the form to use for a CI step summary:

```sh
vx run ci --report-file="$GITHUB_STEP_SUMMARY"
```

**Do not redirect stdout for this.** The report itself is machine-clean,
but stdout is not vx's alone — the status logger writes frames, meter
bars and `::group::` workflow commands to the same stream, so
`--report=markdown >> "$GITHUB_STEP_SUMMARY"` puts the entire run log
into the step summary above the table.

The report is **appended**, never truncated: `$GITHUB_STEP_SUMMARY` is a
shared, append-only file that other steps in the same job also write to,
so overwriting it would silently discard their content. Passing both
flags writes the report to stdout AND appends it to the file. A run
stopped by Ctrl-C or SIGTERM still writes both, its stopped tasks
`aborted`. A write
failure is reported (`vx: failed to write report to …`) but does not
change the exit code — the run already happened, the same contract
`--summarize` and `--profile` follow.

### `--tag <k=v>`

Labels the invocation. Repeatable; `--tag=k=v` form too. The pair is
split on the **first** `=`, so values may contain `=` (e.g. a URL). An
empty key is a parse error. Tags are recorded on the run's
`invocations` row so dashboards can filter runs by label, and reach
telemetry as `vx.tag.<key>`; a secret value in one is masked there as
in the task's output (see [Masking](./schema.md)).

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
      cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
    },
  },
}
```

The grants are the task's whole permission surface — nothing is derived
from `cache`, and the only thing core adds is `node_modules` plus the
workspace packages linked there, never a link back to the task's own
project (npm and Yarn link that too). For a task that declares `cache`
a linked package is granted only when its key folds a task of that
package; declaring `cache` narrows core's grant and widens nothing.
Enforcement anchors at the workspace root (a task never leaves its
project); only denials inside the project, or under a withheld linked
package, are reported.

Policy: **fail on violation.** Any task that touches a path it didn't
declare either fails naturally (Linux: `ENOENT` from bwrap's
mount-namespace hide) or is flagged via the macOS violation store
and forced to exit non-zero. No cache is written for a failed task.
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

## `vx watch`

```
vx watch [OPTIONS] TASK [-- forwarded-args...]
```

Run the named task, then re-run it on every filesystem change in the
projects in scope. Press `Ctrl+C` to stop.

```sh
vx watch test                       # cwd project; re-test on changes
vx watch test --all                 # every project that declares `test`
vx watch lint --filter '@scope/*'   # filtered scope
vx watch build -- --sourcemap       # forwarded args carry through every cycle
```

### Lifecycle

1. **Initial run.** Same code path as `vx run` — same scope resolution,
   same task graph, same cache behaviour. The line `vx watch: initial
run...` precedes it.
2. **Watch loop.** After the initial run finishes, the directory of
   every project a cycle can run — the scope (the bare tasks' scope
   plus each `pkg#task`'s own project; only those when every task is
   anchored) plus its transitive dependencies, the closure `--filter 'app...'` walks, cross-project
   `dependsOn` edges included — is watched recursively, less any project
   nested inside it, with a config or not (a root project's key leaves a nested
   project's files out, so an edit there is no cycle; X-42, X-57). The workspace root is
   watched (non-recursively) for lockfile / `pnpm-workspace.yaml`
   changes and for an edit to `vx.workspace.*` — the one root file that
   shapes a run (plugins, `config` stage, concurrency) without being any
   task's input; the cycle after it re-evaluates the file. A file a
   config imports by relative path from outside the watched projects (a
   shared preset) is watched too, and its edit is a cycle that re-reads
   the configs. A file the workspace config imports is loaded once per
   process, so its edit is named with the restart it needs rather than
   run stale (item 949). The directory
   each `<dir>/*` package glob names (`packages/` for `packages/*`) is
   watched for members coming and going: a package added while the watch
   runs is a cycle that runs it, and its directory is watched from then
   on; a removed one is dropped. An edit to the glob list itself (the
   root `package.json`'s `workspaces`, `pnpm-workspace.yaml`) re-reads
   the set, so a glob added there is watched from the cycle it triggers
   (item 1018). A base, or a directory a config imports from, removed and made
   again (a checkout that restores `packages/`) is heard from its nearest directory that exists, and a
   watch whose directory was replaced is armed again (an OS watch holds
   the deleted one; `watch-recreated-dirs.test.ts`). Under `--filter` or `--affected` the scope is the one
   resolved at start, and a new package joins it only as a dependency of
   it; a glob of another shape (`apps/**`) has no such directory, so a
   package added under it waits for a restart. A task's own declared outputs (`cache.outputs.files`,
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
   gone; a symlink is its target string, as the key folds it, so a
   retarget is an edit; a path the loop has never judged is an edit only if it was
   modified after the watchers went live (macOS delivers the initial
   run's own writes after the arm; the later of the path's mtime and
   ctime says which side of it a path belongs to, so a file moved in
   with an old mtime by `mv`, `cp -p` or `tar x` still counts), and a
   path git did not list at the arm that is gone again (vim's `4913`
   write probe, a lock file) is no edit; and
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
   in it) — or declared an
   output, or the loop re-runs on it; after three such cycles in a row
   watch names the path and the remedy, once, and keeps going. A dev
   server the last cycle left running counts as that cycle for as long
   as it runs, so a log it rewrites in its project is named too, with
   `.gitignore` as the remedy (a persistent task declares no outputs;
   item 948). When any project's config declares
   `cache.inputs.workspaceFiles`, the per-project watchers are swapped
   for ONE recursive root watcher (boundaries are off for those globs,
   so a root-relative glob can name a file anywhere). That watcher
   hears every write in the tree and keeps only the ones a key can
   see: a path inside a project's directory, a fingerprint file at the
   root, or a match of a declared `workspaceFiles` glob. A log written
   at the root, a `coverage/` or `.turbo/` tree, an editor's scratch
   file are dropped before the trigger — so `vx watch … > build.log`
   inside the repo settles instead of feeding itself a cycle per line
   of its own output. `vx watch: watching …` is
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
3. **On change.** The triggering path is logged
   (`vx watch: <project> <relpath>; re-running...`): the first changed
   path that still exists, so an editor's temporary file renamed away
   names nothing; a deletion names the cycle when nothing else changed. The
   orchestrator is invoked again with the same options, save one: the
   `--affected` diff is read once, for the initial run. A later cycle
   runs the requested task in every project of the scope fixed at start,
   and the cache keys decide what executes (the startup diff, asked
   again, kept an edit made since out of every cycle). Events arriving
   while a run is in flight queue and drain after the current cycle.
   Re-runs are debounced ~150ms after the last event.
4. **Exit.** `SIGINT` (Ctrl+C) prints `vx watch: stopped` and exits 0.

### Path filtering

Always ignored (no re-trigger):

- `node_modules/`, `.git/`, `.vx/` anywhere in the path.
- A path git ignores (`git check-ignore`, asked once per debounce
  window, never per event): invisible to every cache key — inputs are
  tracked + untracked-not-ignored — so a cycle it started could change
  nothing. A tracked file that matches a pattern is not ignored, by
  git's own rule; outside a repository nothing is.
- Files ending in `.tsbuildinfo` or `~` (editor swap files).
- The run's **resolved cache directory**, wherever it is. `.vx/` covers the
  default, but `defineWorkspace({ cacheDir })` and `--cache-dir` can put it
  anywhere; watching it would let vx's own cache writes trigger the next
  cycle, which writes again — a loop that never settles.

Everything else triggers a cycle. We deliberately don't filter events
against per-task `cache.inputs.files` — the cache hash is the source
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
says so once (`vx watch: polling every 250 ms (VX_WATCH_POLL)`). A
watcher the OS refuses for its watch limit (`ENOSPC`, `EMFILE`) is
polled too, with a notice naming the limit to raise. The
poller walks the same tree the event filter keeps: the always-ignored
segments and the run's declared output containers are never sampled.
It samples each file's later clock of mtime and ctime, so a replacement
that carries the old file's mtime (`cp -p`, `rsync -a`, a `mv`) is an
edit to it as it is to the OS watcher.

### Workspace fingerprint changes

Edits to a lockfile (`pnpm-lock.yaml`, `bun.lock`, …) or
`pnpm-workspace.yaml` at the root invalidate every task's cache key
via the [workspace fingerprint](./caching.md#cache-key-derivation).
Watch mode hears those because it watches the workspace root
(non-recursively). A lockfile a plugin claims still triggers a cycle,
and so does any other root file a plugin claims (`turbo.json` under
`turbo()`, item 961), a plugin added to the workspace config mid-watch
included from the cycle that loads it; the keys then decide which
projects actually re-run. Under `vx watch --frozen` every cycle's configs come from
`vx-lock.json`, so a config edit alone changes no command, and a re-lock
(`vx lock`) is a cycle that re-reads the watched set (item 971).

### Constraints

The following flags are rejected (parser exits 1 before the initial
run):

- `--dry` / `--graph` — those skip execution; nothing to watch.
- `--summarize` / `--profile` — would overwrite their target per cycle.
- `--report` / `--report-file` / `--verbosity <n>` (n > 0) — all
  format ONE run's result; a watch loop has no single run to report. (`--verbosity 0`
  is accepted: it asks for what watch already prints.)

Persistent tasks (`exec.persistent`) re-spawn each cycle. A requested
dev server stays up while watch idles, and what it writes keeps printing; when the next cycle starts, the
old server is stopped first (the kill grace, then SIGKILL) and the cycle
launches a fresh one, so the two never hold one port. One that dies
while watch idles is said (`vx: app#dev exited with code 3`); the next
change starts it again. Stopping watch stops the server too. For dev-server workflows where you want the server
to stay up across changes, use the dev tool's own watch (`vite`,
`tsc -b -w`, `bun --watch`) rather than `vx watch`.

### Exit codes

- `0` — clean Ctrl+C / SIGTERM exit. A cycle in flight is torn down
  first — its children, and the dev server held between cycles, get the
  signal watch received (a Ctrl-C as SIGINT; a SIGTERM or SIGHUP as SIGTERM),
  `VX_KILL_GRACE_MS` (2 s), then SIGKILL — and the process leaves only
  once it has returned, so a CI cancellation never orphans a task.
  Also `0`, with no watch, when `--affected` selects nothing: watch
  prints `vx watch: nothing affected since <ref>` and exits as `vx run`
  does.
- `1` — parser error, missing scope, or a task name no project in
  scope declares: the initial run refuses it as `vx run` does, with the
  same `Did you mean` hint, and watch exits rather than re-run the
  refusal on every change.

A cycle that throws — a `vx.config.*` that does not parse — prints
`vx watch: cycle failed: <reason>` and watch keeps watching, the initial
run included, so saving the fix re-runs (item 1017).

Re-run cycles whose orchestrator returns `{ ok: false }` do NOT exit
the watch loop — a failed cycle just prints the framed FAILED block
and waits for the next change. This matches `turbo watch` / `nx
watch`.

## `vx cache prune`

Evict old or oversized cache entries. Operates on
`<cacheDir>/cache.db` plus the on-disk `<hash>.tar.zst` artifacts.

`prune` is the only `vx cache` subcommand: the statistics other runners
put under a `cache` verb — the directory, the entry count, the size —
are part of [`vx info`](#vx-info), and `vx cache stats`, `list`, `ls`,
`clean`, `gc`, `purge` and their neighbours say so (`list` also names
`vx last --list`) rather than printing a bare "unknown subcommand".

```
vx cache prune --older-than <duration>     # Drop entries last accessed before now - duration.
vx cache prune --max-size <size>            # After age-based pruning, evict LRU until under <size>.
vx cache prune ... --dry-run                # Say what either policy would reap; delete nothing.
vx cache prune ... --format json            # { dryRun, evicted, bytesFreed, orphans, orphanBytes }
vx cache prune ... --cache-dir <path>       # The cache a run with the same flag uses.
```

At least one of `--older-than` / `--max-size` is required. Both may
be combined: age-based eviction runs first, then LRU eviction if the
total is still over the size cap. The same policy runs unattended at
the end of every run when `vx.workspace.ts` declares
`cacheRetention: { olderThan, maxSize }` (same spellings; see
[schema](./schema.md)).

After eviction, prune sweeps the cache directory for **orphans**: a
`<hash>.tar.zst` the index has no row for (a `SCHEMA_VERSION` bump
drops every table and leaves the artifacts behind, as a deleted
`cache.db` does) and a `<hash>.tar.zst.tmp-*` a save that crashed never
renamed. A run that asks for an orphan's key indexes it again from its
bytes and hits; one no task asks for again is only reclaimed here. Files younger than one hour are left alone: a save
renames its artifact into place before the row commits, so a fresh
row-less file is a save in flight. Only the names vx writes are taken:
`<hash>` is the key's 16 lowercase hex digits and the temp suffix is
the one a save makes, so a `release.tar.zst` beside the index in a
`cacheDir` you share is never touched (item 968). The converse, an
index row whose artifact is gone (deleted by hand), is dropped by the
same prune, and its bytes count toward neither `--max-size` nor the
evicted total: they are on no disk, and counting them evicted real
entries to make room for them (item 975). A row used within the hour
is kept until a later prune, but its bytes are left out all the same
(item 1081). The sweep runs on every prune, under
either flag, and reports separately from the policy's evictions. A
workspace's `cacheRetention` runs it too, at the end of a run, at most
once an hour even when nothing the index holds is due (the policy sums
index rows, so orphans alone never make it due).

Both flags take either form: `--older-than 30d` or `--older-than=30d`.

**Duration units**: `s`, `m`, `h`, `d`, case-insensitive. Examples:
`30d`, `24h`, `60m`, `30s`, `30D`.

**Size units**: `K`, `M`, `G`, `T` (powers of 1024), case-insensitive.
Optional `B` suffix is accepted. Examples: `500M`, `1G`, `100K`, `2T`,
`500MB`, `1gb`. A bare number is refused here: `--max-size 10` would
read as ten bytes and evict nearly everything, and nobody means that —
write `10G`, or `10B` when bytes really are the unit.

**A zero bound is rejected.** `--max-size 0` and `--older-than 0d` would
evict every entry in the cache, which is far more often a
computed-to-zero retention than an intent — and no flag combination
expresses "wipe the cache" (running with neither flag is an error, not a
full prune). Delete the cache store `vx info` names when that is really
what you want: the entries live there, not in the workspace's `.vx`.

```
$ vx cache prune --older-than 30d
Pruned 42 entries (1.3 GB freed)

$ vx cache prune --older-than 7d --max-size 500M
Pruned 18 entries (320 MB freed)

$ vx cache prune --older-than 30d      # after a SCHEMA_VERSION bump
Pruned 0 entries (0 B freed), reaped 42 orphaned artifacts (1.3 GB)

$ vx cache prune --older-than 30d --dry-run
Would prune 42 entries (1.3 GB), would reap 3 orphaned artifacts (12 MB)
```

`--dry-run` picks the victims under the same policy and counts the
orphans the sweep would take, then returns without touching the index
or the directory; the real prune with the same flags reaps exactly what
it named (an in-flight save aside). On an index an earlier vx wrote,
which the real prune resets first, it says so on stderr and names every
artifact past the hour's grace as an orphan, since that is what the
reset leaves (item 1083).

A prune that deletes waits for a `vx run` on the same workspace to
finish first (the run's lock; it says `[vx] waiting for another vx run
(pid N) on this workspace to finish…` after a second), so it never
evicts what that run is restoring. A run it cannot see — another
workspace sharing the `--cache-dir` — survives a prune anyway: an
artifact that vanishes before its restore is a miss, and the task runs
([caching](./caching.md#concurrent-runs)).

Exit codes:

- `0` — pruning completed (zero or more entries evicted). A workspace
  that never ran has no cache: `Pruned 0 entries (0 B freed)`, and
  nothing is created.
- `1` — parse error, missing policy, or workspace-discovery error.

`vx cache prune` resolves the workspace root from cwd and honors a
`defineWorkspace({ cacheDir })` override — it prunes the same
directory a run would use. `--cache-dir <path>` (cwd-relative, as on
`vx run`) names another one, so a run that wrote elsewhere can be
pruned there.

## `--frozen` (run flag)

`vx run ... --frozen` loads configs from the committed `vx-lock.json`
instead of evaluating them — CI reproducibility mode. Plain `vx run`
always evaluates live (a byte hash can't see a config's import
closure, so silently consuming the lock locally would risk stale
freezes). `--frozen` errors only when no lock exists or a project
is missing from it — it performs NO staleness checks of its own:
run `vx lock --check` first in the pipeline; that audit re-evaluates
everything, making any per-run re-check redundant.

## `vx lock`

Freeze every project's **resolved** config into `vx-lock.json` at the
workspace root. Configs are programs; `vx lock` evaluates them in the
current environment and stores the post-evaluation objects plus a
content hash of each config file.

```
vx lock              # Evaluate all vx.config.* now; write vx-lock.json.
vx lock --check      # Audit: hash checks + full re-evaluation vs the lock. Exit 1 on drift.
```

Plain runs ALWAYS evaluate live — the lock's existence changes
nothing. Only `vx run --frozen` consumes it: configs come from the
lock with no evaluation and no staleness checks of its own (frozen-env
semantics: env reads in a config keep their lock-time values; a
project absent from the lock or a missing lock is a hard error).

`--check` is the audit: it reports changed config files via the
stored hashes AND re-evaluates every config in the current
environment, `Bun.deepEquals`-comparing against the frozen objects —
catching eval-time env and import-closure drift that byte hashes
cannot see. The CI recipe is `vx lock --check && vx run … --frozen`.
Full design: `docs/design/config-lock-2026-06.md`. A lock written by a
1.x vx stays valid for every later 1.x (`tests/contract-lockfile.test.ts`).

A project with no `vx.config.*` — its tasks from a plugin's `project`
stage (`turbo()` from `@vzn/vx-migrate`), or none at all — has nothing
to freeze: the lock records nothing for it, `--check` does not audit
it, and `--frozen` still loads its tasks live. Both verbs say how many
such projects the workspace has (`locked 0 project configs →
vx-lock.json (2 projects have no vx.config; their tasks are never
frozen)`), so an empty lock on a plugin-only workspace never reads like
an audit.

The lock is committed, so `vx lock` refuses to write one that holds a
secret: a config that evaluated to the value of a secret-named variable
(or one a task lists in `exec.env.secret`), say
`` `--token ${process.env.API_TOKEN}` ``. It names each place
(`a: tasks.deploy.exec.command holds $API_TOKEN`) and writes nothing.
Masking it instead would freeze a `***` that `--frozen` runs. Let the
shell expand it: `$API_TOKEN` in the command, the name in
`exec.env.passThrough` (L-42).

Exit codes:

- `0` — lock written / lock is up to date.
- `1` — parse error, workspace-discovery error, missing lock
  (`--check` without one), any drift (every mismatched project is
  listed on stderr), or a secret value the lock would hold.

## Releasing (maintainers)

Every green merge releases itself. When CI finishes green on a push to
`main`, `auto-release.yml` tags that commit with the next version and
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
are dispatched rather than triggered. A green commit is released only
when the last release is its ancestor, so an older tree never gets a
higher version; `main`'s CI runs one at a time and drops the queued
runs between, so a burst of merges yields one release per finished
run. A commit that already carries a `v*` tag is skipped.

A version can still be cut by hand: push its tag (say `v1.0.0`),
create a draft release for it, and dispatch `release.yml` (`tag`) and
`npm.yml` (`version`, `ref`); the next auto-release continues from it.

A GitHub release publishes everything: `release.yml` builds the four
binaries, proves the darwin ones on macOS (re-signed ad hoc only where
macOS refuses one) and attaches them; `npm.yml`
builds the twelve npm packages (`@vzn/vx`, one per platform, and the
seven plugin packages) and publishes them with **npm trusted
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
its own (owner, 2026-10-03), and `tests/workflow-runner.unsafe.test.ts`
holds it. The tasks are `@vzn/vx`'s `release.*`, all uncached and in no
`ci` graph:

| Task                    | Does                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `release.stamp`         | writes `VX_RELEASE_VERSION` into `packages/vx/package.json`, the manifest the binary inlines                                             |
| `release.npm`           | checks npm can publish with provenance (>= 11.5.1, `sigstore` loads); else installs npm into `dist/npm-cli/`                             |
| `release.prove.<os>`    | launches the host's binary (re-signed only if macOS refuses it) and asserts `vx <version>`; on darwin, launches both (x64 under Rosetta) |
| `release.assemble.<os>` | emits the platform packages under `dist/npm` (linux: also `@vzn/vx` and the plugins)                                                     |
| `release.publish.<os>`  | `npm publish --provenance` each in order, skipping one the registry holds                                                                |
| `release.upload.<os>`   | attaches `dist/vx-<os>-*` the draft release lacks; darwin's then publishes it                                                            |
| `release.auto`          | decides the version, creates the draft release with its notes, dispatches the two workflows                                              |

The version reaches them as `VX_RELEASE_VERSION` (the tag or the
dispatch input) and each refuses one that is not a version. Every one
is sandboxed: the publish is granted the registry, the OIDC token host
and Sigstore, the GitHub-Actions variables npm reads, and `~/.npm`;
`release.auto` reads `.git` and reaches `api.github.com` with `GH_TOKEN`;
`release.upload.<os>` reaches it and `uploads.github.com`.
A dispatch with `ref` builds that ref's code, so it must hold these tasks.

All Linux jobs go through `.github/actions/vx-runner` before any
`vx run`: every task in this repo declares `exec.sandbox`, and a
declared sandbox whose runtime is missing is a hard error, not a
downgrade — the compile tasks fail in 0 ms saying which of bubblewrap,
socat and ripgrep is absent. v0.0.20 shipped its darwin packages and
then stopped exactly there.

One-time setup, per package, on npmjs.com → package → Settings →
Trusted Publisher → GitHub Actions: owner `vznjs`, repository `vx`,
workflow `npm.yml`, environment left blank. Do this for `@vzn/vx`,
`@vzn/vx-darwin-x64`, `@vzn/vx-darwin-arm64`, `@vzn/vx-linux-x64`,
`@vzn/vx-linux-arm64` and the seven plugins: `@vzn/vx-ci`,
`@vzn/vx-lockfile`, `@vzn/vx-mcp`, `@vzn/vx-migrate`, `@vzn/vx-otel`,
`@vzn/vx-reapi` and `@vzn/vx-schedule-history`.

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

## `vx upgrade`

Self-update the compiled binary in place: asks the GitHub release API
for this platform's asset and the SHA-256 digest it publishes,
downloads the asset, verifies the digest, and atomically replaces the
running executable (`vx upgrade <tag>` pins a specific release; default
latest; a second tag is refused, not dropped). A download that does not match the digest replaces nothing —
`the download did not match the release's SHA-256 … nothing replaced` —
and a release that publishes no digest for the asset is refused before
the download. The digest comes from the same API as the asset, so it
proves the transfer, not who built the bytes: every release binary also
carries a Sigstore-signed build-provenance attestation, checked with
`gh attestation verify vx-<target> --repo vznjs/vx`. Named
`upgrade` per CLI convention (`bun upgrade`, `deno upgrade`). Refuses
when running from source — use `git pull` — and when the binary is
npm's: an npm install runs the platform package's compiled binary
under `node_modules`, and a rename over that file lasts until the next
`npm install` puts the version npm knows back, so `vx upgrade` there
says `this vx was installed by npm … Update with: npm install -g
@vzn/vx@latest`. A host it cannot reach (no route, a proxy that is
down) is one line — `could not reach api.github.com to read the
release (…) — check the network or the proxy and re-run` — never a
stack; so is a release document cut after the headers arrived or not
JSON (a captive portal's page served with a 200): `could not read the
release from api.github.com (…) — nothing replaced; …`, and an asset
download cut the same way: `could not download the release asset from
github.com (…) — nothing replaced; …`. A binary whose directory this
user cannot write (a root-owned `/usr/local/bin`) is refused before the
download: `cannot write to <dir> (EACCES), where this vx lives — nothing
downloaded; re-run as a user who can (sudo vx upgrade), …`. The new binary
keeps the old one's mode (and, as root, its owner), and must answer
`--version` before the upgrade reports it installed: one that does not
start on this machine — or does not answer within 10 s — is swapped back
for the previous vx, and the command exits 1 saying so (item 1097). On the version it already is
it says `already at <version>` and downloads nothing; a second tag is
refused rather than ignored; and GitHub's hourly API limit for an
unauthenticated address is named, with its reset time, instead of a
bare `(403)` (item 1098).

Exit codes: `0` the new binary installed, or already at that version;
`1` anything refused or swapped back: from source, from npm, a host it
cannot reach, a directory it cannot write, a digest that does not match,
a binary that does not start.

## `vx init`

In a Turbo or Nx repo (a `turbo.json`, `turbo.jsonc` or `nx.json` at
the root) it writes `vx.workspace.ts` declaring `turbo()` or `nx()`
from `@vzn/vx-migrate` and nothing else: those read the repo's own
config live, so no task is copied — a temporary start until
`bunx @vzn/vx-migrate` writes native config. The `next:` line is one command:
install what the file imports and is missing, with the manager the
lockfile names (at the workspace root: pnpm's `-w`, Yarn 1's `-W`,
which Yarn Berry lacks), then run the config's `build` (else its first task).
An existing workspace file is kept and named unless it already
declares the plugin; `--force` replaces it. When the repo shows a remote
cache — turbo.json's `remoteCache`, a `.turbo/config.json` naming a
team or token (`turbo link` writes it), or a line setting `TURBO_TOKEN` /
`NX_SELF_HOSTED_REMOTE_CACHE_SERVER` (`NAME:` or `NAME=`, not a comment)
in `.github/workflows/*`, `.gitlab-ci.yml` or `.circleci/config.yml`,
and turbo.json does not say `remoteCache.enabled: false` — it
declares `turboCache()` / `nxCache()` beside the runner and names the
file that showed it (a kept file lacking it is told to add it); the
plugin is inert where its variable is unset. An nx.json that connects
Nx Cloud (`nxCloudId`, `nxCloudAccessToken`, the `nx-cloud` runner) is
named instead: vx does not speak its wire, so runs cache locally.

Anywhere else it scaffolds a workspace that comes from nowhere: one `vx.config.ts` per
package from its `package.json` scripts, plus a `vx.workspace.ts` of
`{ plugins: [] }` whose comment says running and caching here are the
floor, so it declares no executor or cache. `@vzn/vx-migrate` takes the
same `--dry` / `--force` flags but reads a runner's config (turbo, nx);
package.json scripts are `init`'s. A workspace with no scripts at
all still gets the workspace file, a printed example config, and the
next command to run. A root
`package.json` with no `workspaces` field is single-project mode, and
when `packages/*/package.json` files sit below it unreached, both
`init` and a run that finds no config say so instead ("package.json
declares no workspaces … Add "workspaces": ["packages/*"] to
package.json and re-run") rather than "no scripts" or "run vx init". A
workspace whose globs match no `package.json` gets a note naming them
(M-42); a nameless member, or two sharing a name, is matched and
named on its own line instead (M-46). When such skipped scripts are all there
is, the report opens `no package.json scripts became tasks.` rather than
saying there are none (M-59). When `pnpm-workspace.yaml` lists the
members and the root `package.json`'s `workspaces` lists other globs,
the note names the unread list (M-51): pnpm reads only the yaml, while
bun, npm and yarn read `package.json`. With
no `package.json` here or above, `init` says to create one (`bun init` or
`npm init -y`) first. Every
generated config is typed for the editor through
`import type { ProjectConfig } from '@vzn/vx/config'` and `satisfies
ProjectConfig` — a type-only import Bun erases, so the file loads in a
workspace that runs the `vx` binary without the package installed. The
workspace file takes the same form (`satisfies WorkspaceConfig`). A
runtime `import { defineWorkspace } from '@vzn/vx'` costs nothing extra
since 2026-09-10: the running `vx` serves its own core to that
specifier (bin.ts registers the alias), so a config or a plugin package
never loads a second copy, and a workspace that runs the binary needs
no `@vzn/vx` installed for it — the type-only form is still what the
scaffold writes, because it types the same with no import to resolve
in an editor without the package. A workspace that imports a PLUGIN
package at runtime without having installed it is told so, and to
install its dependencies. `--mjs` writes the same objects as `vx.config.mjs` and
`vx.workspace.mjs`, with no type import and no `satisfies`: a package whose
own `tsconfig` includes every `.ts` under it compiles a `vx.config.ts`
into its dist (TanStack/query's `tsc --build`, 2026-09-11), and an
`.mjs` is outside that include. `@vzn/vx-migrate` takes the same flag.

Each script becomes a task with its command verbatim. `build` gets
`dependsOn: ['^build']` (a `build` that only delegates, `pnpm run
compile`, is a group, and the edge goes on the script that does the
work) and **no cache block** — under a
`TODO(vx-migrate)` showing the block to add with the package's real
inputs and outputs. A task without a cache block always runs; a block
with EMPTY outputs is not "uncached" but a no-output task that hits on
unchanged inputs and skips the build with nothing to restore (a deleted
`dist` stays deleted under a green `up-to-date` run — what `init`
generated until 2026-09-04), and a guessed `dist/**` would restore the
wrong tree for every package that writes elsewhere. The block the TODO
shows names `dist/**`, or the default output of the framework the command
runs: `.next/**` minus `!.next/cache/**` for `next build`, `.output/**`
for Nuxt, `build/**` for Remix, React Router, Create React App and
Docusaurus, `public/**` for Gatsby, `storybook-static/**` for Storybook;
for any other command, the directory it names with `--outDir` / `--out-dir`
/ `-d`, else the ones it cleans first (`del-cli distribution`, `rimraf lib
types`), unless it makes one again with `mkdir` (D-90).
A package in a cycle of builds (nuxt's `@nuxt/nitro-server` devDepends
on `nuxt`, which depends on it; pnpm sorts it away) gets, instead of
`^build`, an edge to each build outside its cycle that `^build` would
reach, and a TODO to order the cycle: `^build` there refuses the run.
`test` / `typecheck` wait for
`build` when the package has one (`lint` reads sources and gets no
edge); `dev` / `start` / `serve` / `watch` /
`preview` become persistent tasks, with a TODO to add `readyWhen` when
another task depends on one, and so does a watcher: a `watch` segment in the script's name (`build:watch`),
a `--watch` flag, `tsc -w` / `rollup -w`, or nodemon (D-40), and a server:
`serve <dir>`, `http-server`, bare `vite`, a tool's `dev` / `serve` /
`start` / `preview` verb (`next start`, `netlify dev`), or a script that
runs such a script of its package by name (`cross-env X=1 pnpm start`) or
through a runner (`run-p web api`, `concurrently "npm:web" "npm:api"`, D-113),
outside quotes and not sent to the background with `&` (D-91), read past
a launcher's `--package <name>` / `-p <name>` (`pnpm dlx --package
netlify-cli netlify dev`, D-112). A
script whose name no task may carry (`lint#fix`, `^up`; the schema's
rule, item 1000) is left out with a TODO rather than written into a
config every later command refuses, and a `__proto__` script is written
as a computed key, since a literal `__proto__:` sets the prototype. An
existing `vx.workspace.*` in any extension the loader reads (`.mts`
included) is kept, and `--force` REPLACES a package's config of another
extension (`replaced:` in the report) rather than writing a second one
the loader would choose between by its order (item 1033). Without
`--force`, `init` never overwrites: a package that already has a vx
config keeps it, untouched, the rest get theirs, and the report lists
the kept ones under `kept`, so a half-adopted workspace adopts the rest
(M-52). `@vzn/vx-migrate` still refuses an existing config.

A missing `vx.workspace.*` is not an error. A run where no package has
a config fails before any task, exit 1:
``vx run: no projects declare task(s): build. No package declares a vx.config — run `vx init` to write one per package from its package.json scripts.``

Two npm conventions are mapped rather than copied, because copying them
loses behaviour. `pre<x>` / `post<x>` hooks, which npm runs around `x`
without being named, are folded into `x`'s command in that order, each
in its own subshell, so the chain stops at the first that fails whatever
a part holds (a `;`, an `exit`), and forwarded `--` args reach `x` alone,
as npm hands them to the script and not its hooks (item 905), appended
as text, so no part sees them as `$1` (X-60). The
command is a small shell function, `vx_script`, around the three parts;
it carries a TODO saying so; a `pre<x>` with no `x` stays a task of its own, and
npm's lifecycle hooks (`prepack`, `prepublishOnly`, …) are never tasks.
A member with no script to run (none, or only lifecycle hooks: a
types-only or config package) gets no `vx.config.ts` and is named in
the report; it is still a project, and a task declared in its own
`vx.config.ts` runs. A package with no `build` script whose `prepack`, `prepublishOnly`,
`prepublish` or `prepare` runs a builder (`bob build`, `tsc`, `tsup`, …)
is named in the report, which says to add a `build` script running it
(react-navigation's twelve packages, whose root `build` is `lerna run
prepack`, mapped with no build at all).
Where the package's manager runs no such hooks every `pre<x>` and
`post<x>` is a task of its own: Yarn 2+ (the nearest `packageManager:
yarn@2+`, or a Berry `yarn.lock`, D-31; a `packageManager` naming none of npm,
pnpm, yarn or bun defers to the lockfile, D-96), npm under `ignore-scripts=true`
in the `.npmrc` beside its lockfile, pnpm under
`enable-pre-post-scripts=false` there or `enablePrePostScripts: false` in
`pnpm-workspace.yaml` (D-33). Bun and Yarn 1 run them whatever those say.
Under Yarn 2+ a segment's `run <script>`, Yarn's shell builtin, is written
`yarn run <script>`: vx's shell has no `run` (D-92).
A Yarn 2+ repo on Plug'n'Play (no `nodeLinker: node-modules` or `pnpm` in
`.yarnrc.yml`) keeps its bins in `.pnp.cjs`, where vx's PATH finds none;
the report says so and names `nodeLinker: node-modules` or `yarn exec
'<command>'` (D-108).
A script reading `$npm_package_version`, `$npm_package_name` or
`$npm_lifecycle_event`, which every manager sets and vx does not, gets
them under `exec.env.define`, the first two read from an imported
`package.json` so a version bump reaches them; any other `$npm_*` it
reads gets a TODO (D-34). Among several packages, a workspace root
script that runs the members (`pnpm -r build`, `--filter`, `-C`, pnpm's `pn` alias
included (D-97), Yarn's
`--cwd` and `yarn workspace <name>`, npm's `--prefix`, npm's
and Yarn's workspace flags, a `cd` into or above a member, turbo, nx, lerna, `vp run`, vx itself) is not mapped
(a flag counts on the package manager, or after `node <bin> run`, and not on the program it
runs: berry's `yarn node -r ./setup.ts` is node's `--require`, D-81; bun's
`cd test && …` enters no member, D-83),
nor is one that runs such a script by name (vite's `ci-docs`: `pnpm build &&
pnpm docs-build`; through `run-s` / `run-p` / `npm-run-all` or `concurrently
"npm:x"` too, lexical's `ci-check`, D-95), and neither is one whose name a member's task carries, so `--all` never runs
a check twice (D-45). The rest check the whole repo (`lint: oxlint .`,
`test: vitest`) and become the root's own tasks in a root vx.config, when
the root has a `"name"` (vx skips a nameless root's config) and no config
of its own; one already there, hand-written or from an earlier
`vx init`, stays as written, `--force` included, and is listed under
`kept`. The report names each script left out and why
(a `pre` / `post` hook goes with its script, D-85), its examples of running
the members spelled by the repo's manager (`--workspaces` under npm, `yarn
workspaces foreach` under Yarn 2+), and says which;
with nothing mapped it names the root whenever it has a script, a member
or not (pnpm's root is not), and why: its scripts run the workspace, or
share a member's task name (listed), or both; it tells a root with no `"name"` to add one
first (vuejs/core), naming the scripts that would then map (react, D-87), and a root whose
`"name"` a member also carries to rename it, since a root config would make the
workspace refuse every run for the duplicate (insomnia, D-129). A single-package repo's root is its project and maps.
A lone root beside a `lerna.json` (Lerna-classic: packages listed there, not
in `workspaces`) gets a note naming the `workspaces` globs to add, Lerna's
`packages/*` default when it lists none (D-111).
A member whose package.json has no `name` is no project; one with a
script is named in the report, to be given a name (remix's
`packages/component/bench`, D-106).
A member's script that runs another member's work (`pnpm -C ../pinia
run build`, `yarn workspace <name>`, `-r` / `--filter`, a `cd` or `-C`
/ `--cwd` / `--prefix` into another member) keeps its command and gets a
TODO naming that part: the graph runs that member's task once, so name it
under `dependsOn` and drop it from the command (pinia). A directory inside
the member or the root is no other member.
A script that is nothing but `npm run <other>` (`pnpm <other>`, `yarn
<other>`, `bun run <other>`, `npm test`, `npm start`) becomes a **group**
over `<other>` — `dependsOn` and no command — so the graph runs and
caches the target instead of a package-manager subprocess it cannot
see. When `build` is such a group, the task it reaches that runs a
command takes `^build` and the cache TODO, since a group has nothing
to cache; it and the groups on the way drop the wait on `build` a
`typecheck` or `test` would carry, since they are the build (D-16). Bare, a package manager's own command is not a script: `bun test`
is Bun's test runner, `bun build` its bundler, `pnpm install` and `yarn
add` the managers' verbs, so each stays a command (item 908), and so do
the names each manager reserves or hands on: `pnpm docs` and `pnpm
version` (npm's), `bun deploy`, `yarn check` (D-32); `pnpm test`, `yarn
test` and `bun lint` do run the script. Arguments, flags or a `&&`
chain make it a real command again and
it is left verbatim, and so is one whose target becomes no task (a
lifecycle script, or a hook folded into another script): a group over
it would name a task nothing defines (D-12). A verbatim chain whose
parts run this package's own scripts (`check: pnpm run build && pnpm run
lint`) gets a TODO naming those parts: each ran again inside the command,
beside its own task, so `vx run check` built twice (M-41). So does a
part that runs them through `run-s`, `run-p` or `npm-run-all`
(`build: run-p build:*`), unless the task is persistent (M-48). Its
order may matter, so it is not made a group.

The report lists each TODO once per reason: tasks that share one are
named together (the first five, then a count; the files carry each),
and when no task caches it says a cache block from a TODO makes the
second run a hit. Its `next:` line is a command the user can type: the
runner that started vx (`npx`, `pnpm`, `yarn`, `bunx`, read from
`npm_config_user_agent`) with the installed `vx` bin, else the
`@vzn/vx` package (`npx` under Yarn 1, which has no `dlx`); with no
runner, a bare `vx`. Outside a git work tree it starts with
`git init`, and with no script mapped with declaring a task, since the
run would refuse without either. It runs `build`, else the first task that
neither serves (`persistent`) nor changes the repo (`clean`, `release`,
`publish`, `deploy`, `version`, `format`, `fix`, …), else the first task
(react-navigation was told `vx run clean --all`).

`vx init --plugin <seam>` writes a plugin instead: `plugins/<seam>.ts`,
a small runnable plugin for that seam (`executor`, `cache`,
`telemetry`, `schedule`, `admit`, `commands`, `project`, `graph`,
`key`), and `plugins/<seam>.test.ts`, which drives it through `run()`
(`bun test`, with `@vzn/vx` installed). It prints the line that
declares it in the workspace file a run reads (`vx.workspace.ts` when
there is none). The templates are TypeScript, so `--mjs` with
`--plugin` is refused. An existing file is refused without
`--force`; `--dry` names the files and writes nothing. The two files are
`packages/vx-plugin-examples/plugins`, which the gate runs, copied into
core (`src/cli/plugin-templates.ts`) and held equal by
`tests/plugin-templates.unsafe.test.ts` (H-21).

Exit codes: `0` the files written (or, with `--dry`, printed); `1` no
`package.json` here or in a parent, a file it would write already there
without `--force`, or a parse error (`--mjs` with `--plugin` among them).

## `vx migrate`

Moved out of core on 2026-09-10: the Turbo and Nx mappers are
`@vzn/vx-migrate`, their own package, run without a workspace file —

```
bunx @vzn/vx-migrate           # turbo.json, an Nx graph or vite-plus run.tasks → vx.config.ts
bunx @vzn/vx-migrate --dry     # print the generated files instead of writing
bunx @vzn/vx-migrate --force   # overwrite existing vx.config.* / vx-preset.ts
bunx @vzn/vx-migrate --from nx # disambiguate when both runners are checked in
```

— and `package.json` scripts are `vx init` (above). Typing `vx migrate`
prints that pointer and exits 1. What the package writes reads exactly
like what `vx init` writes: both hand a plan to core's migration seam
(`applyMigration`, exported from `@vzn/vx`), which renders, guards
against overwriting, writes and reports. The mapping rules live in the
package's README.

## Turbo and Nx flags

What a Turbo or Nx user types into `vx run` (and `vx watch`): each flag
vx takes as it is (`same`), rewrites to its own spelling before the
parse (`alias`), or refuses with the vx way to say it (`refuse`) —
none is dropped in silence. An Nx flag's camelCase spelling (`--nxBail`,
`--skipNxCache`), which Nx's parser takes and its docs print, is its
kebab-case row. `vx run-many` and `vx affected` name the
`vx run` that does the same, and the other verbs a hand types from
either tool name what does it here: `graph` (`--graph`), `ls`
(`vx show`), `query` (`--dry=json`), `reset` (`vx cache prune`), and
`daemon`, `login`, `logout`, `link` and `unlink`, which vx has no use
for. Nx's `project:target` (`vx run web:build`,
when `web` declares `build`) is answered with `vx run web#build`: from
outside a project in place of "not inside a project", in scope as the
unresolved name's `Did you mean`. A name that is no project but ends
the one scoped package (`cart` for `@nx-example/cart`, as Nx names it)
means that package there and in `vx build cart`. The table is `cli/foreign-flags.ts`,
rendered; `tests/foreign-flags.test.ts` drives every row and holds this
copy to the source.

| runner | flag                                              | outcome | in vx                                                                                                                         |
| ------ | ------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| turbo  | `--filter <v>`                                    | same    | `--filter`, the same grammar (`...[ref]`, `{dir}`, `^`, `!`)                                                                  |
| turbo  | `-F <v>`                                          | alias   | `--filter <v>`                                                                                                                |
| turbo  | `--concurrency <v>`                               | same    | `--concurrency <n\|n%>`                                                                                                       |
| turbo  | `--continue=dependencies-successful`              | alias   | `--continue=deps-ok`                                                                                                          |
| turbo  | `--continue`                                      | same    | `--continue[=never\|deps-ok\|always]`                                                                                         |
| turbo  | `--dry-run`                                       | alias   | `--dry[=text\|json]`                                                                                                          |
| turbo  | `--graph=<file>.svg\|png\|json\|html\|…`          | refuse  | vx writes Graphviz DOT only: `--graph=<file>.dot`, then `dot -Tsvg`                                                           |
| turbo  | `--graph`                                         | same    | `--graph[=<file>.dot]`                                                                                                        |
| turbo  | `--force`                                         | same    | `--force`: skip cache reads, keep writes                                                                                      |
| turbo  | `--affected`                                      | same    | `--affected[=<base>]`                                                                                                         |
| turbo  | `--summarize`                                     | same    | `--summarize[=<path>]`                                                                                                        |
| turbo  | `--output-logs=new-only`                          | refuse  | use `--output-logs=full` (a hit replays its log) or `errors-only`                                                             |
| turbo  | `--output-logs <v>`                               | same    | `--output-logs full\|errors-only\|hash-only\|none`                                                                            |
| turbo  | `--no-cache`                                      | same    | `--no-cache`                                                                                                                  |
| turbo  | `--cache <v>`                                     | same    | `--cache local:rw,remote:r`                                                                                                   |
| turbo  | `--cache-dir <v>`                                 | same    | `--cache-dir <path>`                                                                                                          |
| turbo  | `--profile`                                       | same    | `--profile[=<path>]` (Chrome trace)                                                                                           |
| turbo  | `--only`                                          | alias   | `--exclude-dependencies`                                                                                                      |
| turbo  | `--color`                                         | refuse  | set `FORCE_COLOR=1`                                                                                                           |
| turbo  | `--no-color`                                      | refuse  | set `NO_COLOR=1`                                                                                                              |
| turbo  | `--heap <v>`, `--trace <v>`                       | refuse  | use `--profile[=<path>]` for vx's own trace                                                                                   |
| turbo  | `--login <v>`                                     | refuse  | vx has no login: a remote cache is a plugin (`turboCache()` from @vzn/vx-migrate)                                             |
| turbo  | `--no-update-notifier`                            | refuse  | vx prints no update notice: drop it                                                                                           |
| turbo  | `--skip-infer`                                    | refuse  | vx runs the binary it is: drop it                                                                                             |
| turbo  | `--root-turbo-json <v>`                           | refuse  | `turbo()` reads the `turbo.json` at the workspace root: move it there                                                         |
| turbo  | `--experimental-otel-*`                           | refuse  | telemetry is a plugin: `otel()` from @vzn/vx-otel in vx.workspace.ts                                                          |
| nx     | `--parallel <n>`                                  | alias   | `--concurrency <n>` (`--parallel=false` is 1)                                                                                 |
| turbo  | `--parallel`                                      | refuse  | vx always honours `dependsOn`; `--concurrency <n>` sets how many run at once                                                  |
| turbo  | `--scope <v>`                                     | refuse  | use `--filter <pkg>`                                                                                                          |
| turbo  | `--since <v>`                                     | refuse  | use `--filter '[<ref>]'` or `--affected=<ref>`                                                                                |
| turbo  | `--remote-only`                                   | refuse  | use `--cache local:,remote:rw`                                                                                                |
| turbo  | `--remote-cache-read-only`                        | refuse  | use `--cache local:rw,remote:r`                                                                                               |
| turbo  | `--anon-profile`                                  | refuse  | use `--profile[=<path>]`; vx has no redacting variant, so read it before sharing it                                           |
| turbo  | `--cache-workers <v>`                             | refuse  | vx sizes its own cache I/O: drop it                                                                                           |
| turbo  | `--cwd <v>`                                       | refuse  | run vx from that directory: `cd <dir> && vx run …`                                                                            |
| turbo  | `--dangerously-disable-package-manager-check`     | refuse  | vx reads no `packageManager` field: drop it                                                                                   |
| turbo  | `--env-mode <v>`                                  | refuse  | vx passes only the variables a task declares (strict): list the rest in `exec.env.passThrough`                                |
| turbo  | `--framework-inference <v>`                       | refuse  | under `turbo()` inference is Turbo's; take a name back with a `!` entry in the task's `env`                                   |
| turbo  | `--global-deps <v>`                               | refuse  | declare them in `cache.inputs.workspaceFiles` (under `turbo()`, turbo.json's `globalDependencies`)                            |
| turbo  | `--json`                                          | refuse  | use `--dry=json` for the plan, `--summarize[=<path>]` for the run's JSON record                                               |
| turbo  | `--log-file`                                      | refuse  | use `--summarize[=<path>]` for the run's JSON record                                                                          |
| turbo  | `--preflight`                                     | refuse  | `turboCache()` sends no CORS preflight: drop it                                                                               |
| turbo  | `--remote-cache-timeout <v>`                      | refuse  | set `turboCache({ timeoutMs })` or `TURBO_REMOTE_CACHE_TIMEOUT`                                                               |
| turbo  | `--single-package`                                | refuse  | a repo with no workspaces is one project already: drop it                                                                     |
| turbo  | `--token <v>`, `--team <v>`, `--api <v>`          | refuse  | a remote cache is a plugin: `turboCache()` from @vzn/vx-migrate in vx.workspace.ts reads TURBO_TOKEN / TURBO_TEAM / TURBO_API |
| turbo  | `--no-daemon`, `--daemon`                         | refuse  | vx has no daemon: drop it                                                                                                     |
| turbo  | `--ui <v>`, `--log-order <v>`, `--log-prefix <v>` | refuse  | vx frames each task’s output: `--output-logs <mode>` sets how much                                                            |
| nx     | `-t <v>`, `--targets <v>`, `--target <v>`         | alias   | the task names, positional: `vx run build test`                                                                               |
| nx     | `-p <v>`, `--projects <v>`                        | alias   | `--filter <pattern>`, one per project                                                                                         |
| nx     | `--exclude <v>`                                   | alias   | `--filter '!<pattern>'`, one per project                                                                                      |
| nx     | `--base <v>`                                      | alias   | `--affected=<ref>`                                                                                                            |
| nx     | `--head HEAD`                                     | alias   | nothing: vx compares `--affected=<base>` with the working tree                                                                |
| nx     | `--head <v>`                                      | refuse  | vx compares `--affected=<base>` with the working tree: check out the head first                                               |
| nx     | `--skip-nx-cache`                                 | alias   | `--force`                                                                                                                     |
| nx     | `--all`                                           | same    | `--all`                                                                                                                       |
| nx     | `--nx-bail`                                       | alias   | `--continue=never`                                                                                                            |
| nx     | `-c <v>`, `--configuration <v>`                   | refuse  | a configuration is its own task: `vx run <target>:<configuration>`                                                            |
| nx     | `--output-style <v>`                              | refuse  | use `--output-logs <mode>`                                                                                                    |
| nx     | `--uncommitted`, `--untracked`                    | refuse  | use `--affected=HEAD` (the working tree against the last commit)                                                              |
| nx     | `--max-parallel <v>`                              | alias   | `--concurrency <n>`                                                                                                           |
| nx     | `--exclude-task-dependencies`                     | alias   | `--exclude-dependencies`                                                                                                      |
| nx     | `--skip-remote-cache`                             | alias   | `--cache local:rw,remote:`                                                                                                    |
| nx     | `--verbose`                                       | refuse  | use `--verbosity <n>` (1 adds the summary table)                                                                              |
| nx     | `--files <v>`                                     | refuse  | vx asks git what changed: `--affected=<base>`                                                                                 |
| nx     | `--batch`                                         | refuse  | vx runs one command per task: drop it                                                                                         |
| nx     | `--dte`, `--use-agents`                           | refuse  | vx distributes nothing: drop it                                                                                               |
| nx     | `--nx-ignore-cycles`                              | refuse  | vx refuses a task cycle by name: break it                                                                                     |
| nx     | `--runner <v>`                                    | refuse  | a remote cache is a plugin: `nxCache()` from @vzn/vx-migrate in vx.workspace.ts                                               |
| nx     | `--skip-sync`                                     | refuse  | vx never runs sync generators: drop it                                                                                        |
| nx     | `--tui`, `--no-tui`, `--tui-auto-exit`            | refuse  | vx frames each task’s output: `--output-logs <mode>` sets how much                                                            |
| nx     | `--no-cloud`                                      | refuse  | vx has no cloud: drop it                                                                                                      |

## Machine-readable output

`vx show`, `vx info`, `vx why`, `vx last` and `vx cache prune` take
`--format json`. Each prints one JSON document whose shape is a
checked-in JSON Schema (draft 2020-12) shipped with the package:
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

**Streams.** A verb whose stdout is a product (a `--format json`
document, `--dry` / `--dry=json`, `--graph`'s DOT, a completion
script) writes that product alone there; a notice or warning it meets
on the way (a cache index from another vx version, a plugin's warning) goes
to stderr, as every refusal does. `vx run`'s stdout is the run's frame,
the tasks' output it carries. `tests/cli-streams.test.ts` holds each
product verb to it under a notice.

## `vx show`

Introspect the workspace's **live resolved configs** — what a run
would see right now. Configs load through the same path a run uses,
plugin `config` and `project` stages included, so a package a plugin
gives tasks to (`turbo()` or `nx()` from `@vzn/vx-migrate`, a
temporary start toward native config) shows them; cached
evaluations are served from the local cache like a run's. `vx show`
never reads `vx-lock.json` (the lock is already the frozen JSON — open
it directly if you want the frozen view).

```
vx show                          # list every project
vx show <project>                # one project's resolved config (`//`: the root project's)
vx show <pkg>#<task>             # a single task (`//#<task>`: the root project's)
vx show <task>                   # that task in every project declaring it
vx show ... --format json        # machine-readable (default: pretty)
```

Nx's spellings name these: `vx show projects` (when no project or task
has that name) and `vx show project <name>` say `vx show` and
`vx show <name>`.

No target: one line per project — name, root-relative dir, task count,
and a `(no vx config)` marker for config-less packages; one whose
tasks all come from plugins reads `N tasks (no vx config; from
plugins)`, and one a configured project depends on reads `1 task (no
vx config; default build)`: a run loads it for that dependant's
`^build` (X-48). A project's `tags` follow in brackets. With `--format json`
it's an array of `{ name, dir, tags: string[], tasks: string[] }`.

```
$ vx show
app   packages/app   3 tasks  [scope:web]
bare  packages/bare  (no vx config)
```

Under its header `vx show <project>` prints its `tags`.
`vx show <project>` prints a block per task with every field the run
reads: description, command (`(group)` for group tasks), `dependsOn`,
`timeout`, `retries`, `env.passThrough` / `env.define` / `env.secret`,
`remote`, `sandbox`, `persistent`, `interactive` (`yes` / `no`), and the
cache block
(`inputs.files` / `.workspaceFiles` / `.env` / `.tasks` / `.runtime` /
`.workspaceRuntime`, `outputs.files` / `.workspaceFiles`). Fields the
task does not set are not printed; a value that spans lines (a
multi-line command) continues under its first line. `--format json` emits `{ name, dir,
config }` with the config exactly as resolved. `vx show <pkg>#<task>`
narrows to one task (`{ name, dir, task, config }` in JSON). A bare
name that is no project is a task: `vx show build` prints the block
from every project declaring `build` (an array of the one-task shape
in JSON).

```
$ vx show app#build
app — packages/app

build
  description:   compile the app
  command:       tsc -b
  dependsOn:     ^build
  inputs.files:  src/**
  inputs.env:    NODE_ENV
  outputs.files: dist/**
```

Unknown project / task names exit `1` with the same near-miss hint
every verb gives (two edits, or a partial name); a bare name that is
neither reads `unknown project or task: "buidl" — did you mean build?`,
and a `pkg#task` hints whole specs (`unknown task: "app#bui" — did you
mean app#build?`). With nothing near, it lists what exists instead: `unknown
project: "zzz"; projects: app, lib`, `; its tasks: app#build, app#test`,
or `; projects and tasks: …` (M-57).

An empty target (`vx show ''`) is refused: omit it to list every project.

Exit codes: `0` success; `1` parse error or unknown target.

Two runs on one workspace take turns: the second waits for the first's
run lock and, after a second, says `[vx] waiting for another vx run
(pid N) on this workspace to finish…` (see caching.md § Concurrent
runs). The lock lives in this user's own directory in the temp
directory, so two runs take turns only when they are one user's and
share `TMPDIR`: a `nix develop` shell sets its own.

Every verb: a path vx must write that this user cannot (`EACCES`,
`EPERM`, `EROFS` — a read-only checkout, another user's files) or that
the disk has no room for (`ENOSPC`, `EDQUOT`) exits 1 with one line
naming the path, `vx: EACCES: permission denied, open '…/vx-lock.json'
— a path vx must write is not writable by this user` (or `— the disk
that path is on is full`), never a stack. Inside a run the task's line
says the same. A process out of file descriptors (`EMFILE`, `ENFILE`;
macOS starts a shell at 256) exits 1 with the error and `— the process
is out of file descriptors; raise the limit (ulimit -n 4096) and re-run`.

## `vx info`

Workspace doctor — one screen of facts for bug reports and sanity
checks. The task count and the sandbox row's declared count come from
the same load a run uses, plugin stages included; a config that fails
to load counts as zero in both rather than failing the doctor, every
other project still counts as a run loads it, and the broken one is
named (`12 (34 tasks · 1 config did not load)`, then a `config errors`
row per config with the message `vx run` stops on):

```
$ vx info
vx:               0.0.0
bun:              1.4.2
git:              2.53.0
git status cache: core.fsmonitor, core.untrackedCache off
workspace root:   /work/repo
projects:         12 (34 tasks)
plugins:          2 — @vzn/vx-reapi (executor, cache); @vzn/vx-otel (telemetry)
workers:          2 — cgroup CPU quota 2 of 8 cores
memory:           13 GB usable — cgroup limit; the machine has 16 GB
cache dir:        /work/repo/.vx/cache
cache store:      /home/me/.vx/3f2a9c1e7b4d5a60/cache
cache versions:   keys vx-cache-v40 · index schema v32
cache entries:    42 (1.3 GB)
orphans:          3 artifacts (12 MB) the index does not know — `vx cache prune` reaps them
task runs (24h):  7 (5 cache hits)
flaky tasks:      1 — web#test (3 of 11 runs failed on unchanged inputs)
sandbox:          available (9 tasks declare exec.sandbox)
vx-lock.json:     yes
```

- `git` shows `(not found)` when the binary is missing; a broken
  project config contributes zero tasks instead of failing the
  printout, and the `config errors` row (present only then) names it
  with the loader's message — the same line `vx run` would stop on.
- `git status cache`: vx runs ONE `git status` per run to find dirty
  and untracked files, and on a large tree that walk is the warm run's
  critical path. git's `core.fsmonitor` (a daemon that watches the
  worktree) and `core.untrackedCache` make it near-free after the first
  run; both are off by default, so `vx info` says when they are.
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
- `plugins` names every plugin `vx.workspace.*` declares and the seams
  each fills, in pipeline order (`config`, `discover`, `project`, `graph`, `key`,
  `fingerprint`, `schedule`, `admit`, `executor`, `cache`, `telemetry`,
  `setup`, `commands`), or `none`. It reads the declarations: a plugin
  that declines a task at run time still lists its seam here.
- `workers` is the count a run defaults to and where it comes from:
  `vx.workspace.ts`'s `concurrency` when set, else the cores this
  process may use — the CPU count, capped by the cgroup CPU quota a
  container runs under (`8 — the CPU count`, `2 — cgroup CPU quota 2 of
8 cores`). `memory` is what a memory-packing policy budgets
  (`@vzn/vx-schedule-history`): the machine's total, capped by the
  cgroup limit — inside a container the raw numbers are the host's,
  and the doctor is where to see which one a run reads.
- `flaky tasks` is the standing list a run's flaky notes add to:
  every task whose history (30 days, what the cache keeps) holds a
  cache key that both passed and failed, most failures first, with
  the outcomes over those keys. A cache hit counts as a pass (it
  replayed one). `none` when the history never mixed.
- `task runs (24h)` counts task runs, executed and replayed alike, so
  the hits are a share of it: three `vx run` of two tasks are six. An
  invocation is what `vx last` calls a run; `vx last --list` counts
  those.
- `cache store` is where the entries and their artifacts live: the
  store every workspace of this user shares (`docs/caching.md`), or
  `none: the cache dir holds the entries` when the workspace names its
  cache dir. Before a first run it is the store a run would open.
- `cache versions` are the two constants a bug report needs and the
  reset notice names: the key prefix (`CACHE_VERSION`; a bump orphans
  every entry) and the index schema (`SCHEMA_VERSION`; a mismatch drops
  every table on the next open, which the run then says once).
- `orphans` appears only when the cache directory holds artifacts or
  save temps the index has no row for, older than an hour (what a
  `SCHEMA_VERSION` reset leaves behind; a fresh one is a save in
  flight). A task that asks for one's key again indexes it and hits;
  the rest only `vx cache prune` reclaims, so the doctor says so.
- `--format json` prints the same facts as one typed object, for a
  script or a bug-report template: `vx`, `bun`, `bunSupported` (false
  below Bun 1.4.0), `git` (null when not
  found), `gitStatusCache` (`{ fsmonitor, untrackedCache }`, null when
  git could not answer), `workspaceRoot`, `projects`, `tasks`,
  `configErrors` (`[{ path, message }]`, the configs that did not load,
  empty when all did), `plugins` (`[{ name, seams }]`), `workers` (`{ count, source, cores,
cpuQuota }`, the source one of `workspace` / `cgroup` / `cores`,
  `cpuQuota` in cores or null), `memory` (`{ usableBytes, totalBytes,
cgroupLimitBytes }`, the limit null when none binds), `cacheDir`, `cacheStore`
  (null when the cache dir holds the entries), `cacheVersion`,
  `schemaVersion`, `cacheEntries`, `cacheBytes`, `orphans`
  (`{ artifacts, bytes }`, always present), `runs24h`, `hits24h` (task
  runs, as the row), `restored24h` (of those hits, the ones that restored
  outputs; the rest found them up to date), `flakyTasks` (`[{ taskId, project, task, keys, passes, failures }]`,
  empty when none), `lockfile`, `sandbox` (`{ available, reason,
declared, untraced }`, `declared` the count of tasks with `exec.sandbox`,
  `untraced` the reason denied reads go unreported or null). The
  pretty rows render this object;
  there is no second source.
- `--cache-dir <path>` reads the cache a run with the same flag uses, as
  `vx why`, `vx last` and `vx cache prune` do.

Exit codes: `0` the facts printed, a config that did not load included;
`1` no workspace here or above, or a parse error.

## `vx why`

Answer "why did this task re-run?" from the terminal, from the
per-component input fingerprints core persists on every miss. Read-only over the local
`cache.db`: no config evaluation, no re-hash.

```
vx why (TASK | PKG#TASK) [--run <runId>] [--format pretty|json] [--cache-dir <path>]
```

By default it compares the task's **latest** recorded run against its
immediately-previous run; `--run <id>` pins a specific run (a unique
prefix of the id is enough; a task that run did not run is refused,
pointing at `vx last --list`, and so is an id no run carries). History is
the cache directory's, not the checkout's: worktrees that share one
`--cache-dir` share one history, so the previous run may be another
worktree's (its branch is in `vx last`), and its edits read as changes. Latest and
previous are the order runs were recorded, not their clock: a clock that
stepped back once swapped the two and diffed the edit backwards. A bare task
name resolves when exactly one project ran it (several → the project
the current directory is in, as `vx run` picks, else an error listing
the candidates; unknown → include-match suggestions, or, with
none near, a pointer to `vx last --list`, or word that nothing has run
yet; after runs of only groups, which record no task row, that no run
executed a task and to ask about one the group depends on, X-50).

A control character in a component's name (a file named with an
escape or a carriage return) prints as `\xNN`, so no file name drives
the terminal; `--format json` carries the name as it is.

An **unchanged** key has three endings, and the verdict distinguishes
them rather than calling all three a re-run: the run was served from
cache (nothing re-ran), it re-executed on the same key, or it recorded
no cache outcome at all, in which case vx says so instead of guessing.
A re-execution names its cause when the index shows one: the previous
run on the key failed and saved nothing, the run did not read the cache
(`--force`, or a `--cache` without read), no entry for the key was
there when it ran (pruned or evicted), neither run saved it while
each ran beside a failed task (a task run past a failed dependency under
`--continue` is never cached), or the previous run executed and no entry
holds the key (its save failed, or a prune took it; a previous run whose
policy wrote no cache says that instead). Otherwise, with this run's
policy recorded as reading the cache, it says it cannot name the cause;
only a run with no recorded policy names `--no-cache` / `--force`.

```
$ vx why app#build
app#build — run 019f5a02-…
  this run   2026-07-13T05:39:20.590Z · success · executed · key f7ee661520…
  previous   2026-07-13T05:37:29.550Z · success · key 8b2e9bb2e8…
  verdict    cache key changed: file packages/app/src/input.txt

  what changed (1 component, 41 unchanged):
    changed file  packages/app/src/input.txt  3fe2a1b0… → 91c47d22…

  what to do:
    file  an edit re-runs by design; a file the task does not read belongs out of cache.inputs.files
```

A changed key's verdict names what moved, kind and name, three at most
and then a count (`cache key changed: env MODE`), so a key that moved
only by an environment variable says so in one line; when neither
entry kept its components it reads `(inputs differ)`.

Under the rows, `what to do` gives one line per changed kind: what
moves it and how to stop a move the task does not need. An `upstream`
line names the `vx why` to run next for each dependency that moved; a
`config` line names the `vx show` that prints the task's config now.

A hit's line is `cache-hit · key …` (or `cache-hit-remote`): the status
names the hit and its tier, so only an executed run carries the word.
A skipped task never ran and derived no key: its line is `skipped · no key`.
A row's kind is what the key folded: `file` (an input file, by blob
id), `env` (a declared variable, by digest), `runtime` and
`ws-runtime` (a declared command's output, `inputs.runtime` and
`inputs.workspaceRuntime`), `forward` (the argv forwarded after `--`),
`package` (the project's own `package.json`), `workspace` (the
fingerprint: the lockfile and the other root manifests), `config` (the
evaluated task config), `upstream` (a dependency's input key — a
lockfile change moves it too, so that row rides with the
fingerprint's) and `plugin` (a `key` plugin's material, by name).
The component-level rows come from the `entry_inputs` input
fingerprints persisted with each cache entry; when either side's entry
is gone (pruned, or the run failed and never saved one) the verb still
names the hash change and says the component diff is unavailable. A
task with no `cache` block derives a key too — it is what dependents
fold — but saves no entry, so for it the verb can only report the key
change and says so.
`--format json` emits one machine-readable object (`{ taskId, runId,
why, diff }`); when the task's recorded runs predate run ids, `{ taskId,
why, diff, explanation }`, `why` and `diff` null and `explanation` the
latest cache entry's key.

Exit codes: `0` the task's run explained; `1` no recorded run of the
task, a `--run` with no row for it, or a parse error.

## `vx prune`

```
vx prune <project...> [--out-dir <dir>] [--docker]
```

A plugin verb of `@vzn/vx-lockfile`: declaring `pnpm()`, `bun()`,
`npm()` or `yarn()` adds it. It copies the named projects, their
transitive workspace dependencies, the root manifests (workspace lists
rewritten to the subset), the vx configs and each lockfile pruned to what
the subset installs into `--out-dir` (default `out/`), so a Docker build
installs it with a frozen lockfile; `--docker` splits `json/` (the
install layer) from `full/`. `turbo prune`. Reference:
`packages/vx-lockfile/README.md` § `vx prune`. Without the plugin, typing
`vx prune` says where it comes from and exits 1. History: core verb
2026-08-25, `@vzn/vx-prune` 2026-09-10, removed 2026-09-11 (it copied the
lockfile unpruned), back in `@vzn/vx-lockfile` 2026-10-03.

## `vx stats`

Removed (H-19). It was an alias of `vx info`, which absorbed it, and
warned on every use. Typing `vx stats` points at `vx info` and exits 1 —
unless a declared plugin claims the verb through the `commands` seam.

## `vx last`

Replay a recorded run's summary from the local history — no
re-execution, no cache probe, no config evaluation. With the
self-hosted dashboard gone (2026-08-23), this is THE run-replay
surface. A run a Ctrl-C (or SIGTERM, SIGHUP) stopped records nothing,
so `vx last` still shows the run before it.

```
vx last [RUNID] [--list[=N]] [--failed] [--format pretty|json] [--cache-dir <path>]
```

Bare `vx last` replays the most recent run: a header (verdict, command,
when, duration, branch @ sha, CI, task/hit/failure counts) and a
per-task table — status, id, duration, cache key, and for a task that
executed, what it used (peak RSS and CPU parallelism, `312 MB · 1.4×
cpu`: the runner's own record, and the number `@vzn/vx-schedule-history`
reserves from; a hit spent nothing and shows nothing, and a task lighter
than vx itself shows its CPU only) — failures first, each as the frame
read it, `failed (exit 137)`, with the signal an exit above 128 stands
for at the row's end (`128 + SIGKILL`; the shell's convention, so a
command that exits 137 on its own reads the same). Where the run's
footer gave a reason, the row ends with it instead: `timed out`,
`never ready: exited`, `2 sandbox violations`, and for a skipped task
`after lib#build failed` (the v27 columns; rows older than them read
as before). Rows run failures first, then what executed or was
skipped, then hits; past sixteen hits the rest fold into one line with
their count (`… +980 more cache hits`) — a thousand-task warm run is a
thousand rows otherwise, with the one failure a screen above the
prompt — and the sixteen shown are the slowest restores, the one thing
a hit's row tells. `--format json` lists every row.
`vx last --list` prints the N most recent runs (default 10) with their
run ids, each cut to the shortest prefix no other run shares, 13 characters at least (`--list 5`
and `--list=5` alike; the space form takes the next argument as the
count unless it is a flag or a run id, eight hex digits at least, so
`--list 1.5` is refused as a count); `vx last <runId>` replays a
specific one, and the two do not combine (a word beside `--list` no run
id could be is refused as an unexpected argument). `--failed` replays the latest
run that failed, past any green one since, and with `--list` lists only
failed runs. `--format json`
emits `{ invocation, tasks }` for scripting, and `--list --format json`
an array of the same `invocation` objects, newest first. An unknown run id fails
loud and points at `--list`. Before any run, every form says so
(`vx last: no recorded runs yet — run something first`, exit 1; `--list`
prints `no recorded runs`, exit 0), and past green runs only,
`--list --failed` prints `no recorded run failed`. A run id may be typed as a unique prefix; a
prefix several runs share fails and lists them. A replayed run with
failures ends with the command that re-runs them (`re-run what failed:
vx run app#test -- …`, with the arguments the run forwarded). The
replayed `$ vx run …` or `$ vx watch …` line and that one keep each
argument shell-quoted (`-- 'a b'`), so either pastes back as it ran (X-49).

`vx why`, `vx last`, `vx info` and `vx cache prune` all read the cache
a run wrote, so each takes `--cache-dir <path>` with `vx run`'s rules
(cwd-relative, absolute used as-is): a run that wrote its history
elsewhere is replayed, explained, reported on and pruned there. Without
the flag they open the workspace's cache (`defineWorkspace({ cacheDir })`
or `.vx/cache`). A `--cache-dir` that is not there is refused by name
(`--cache-dir .vx/cahce: no such directory`). In a workspace that never
ran, `vx why`, `vx last`, `vx info`, `vx show` and `vx cache prune`
(dry or not) read it as empty and create nothing (item 900, E-7, E-38).

Exit codes: `0` the run (or the list) printed, `--list` with no runs
included; `1` no recorded run yet, a run id it has no record of, or a
parse error.

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
verb's line names in passing (`vx lock --check` beside `--frozen`) is
not one. A plugin verb completes `--help` only. Task and project
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

A plugin declared in `vx.workspace.ts` can add verbs:

```ts
import { definePlugin, type VxPlugin } from '@vzn/vx'

export function mcp(): VxPlugin {
  return definePlugin(import.meta, {
    commands: {
      mcp: {
        description: 'serve the run history to an AI agent over stdio',
        async run(argv, ctx) {
          // ctx.workspaceRoot, ctx.cacheDir, ctx.warn(...)
          return 0 // the process exit code
        },
      },
    },
  })
}
```

The plugin's name is its package name, which `definePlugin` reads from
`import.meta`; a plain object is refused when the workspace loads.

(`@vzn/vx-mcp` ships exactly this: declare `mcp()` and `vx mcp` serves
six read-only tools to AI agents — four over the cache database, one
over the resolved task catalog, one the workspace doctor's facts.
`@vzn/vx-schedule-history` adds `vx history`: what it learned per task
and the reservation its `admit` hook packs.) The dispatcher tries core's verbs
first and consults plugins only for a word core does not know, loading
the workspace config from the cwd to find them (outside a workspace the
verb is simply unknown). A plugin verb that names a core verb, or one
plugins of two packages both declare, is refused when the workspace
loads — such a verb could never run, or would hide the other plugin's.
Plugins of one package are one owner (`bun()` and `pnpm()` both carry
`prune`): the first declared runs. A plugin verb's
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
come from — the verbs declared here, or that `vx.workspace.ts` is what
would declare one, or that there is no workspace here at all. Core still
names no package: it lists what the workspace itself declares.

## Environment variables vx reads

The variables core reads. Each is read where it applies, per call, so a
value set for one invocation is that invocation's. A plugin's own (the
REAPI endpoints, the GitHub token) are in its README; what a TASK sees
is `exec.env` in `docs/schema.md`, and the two markers vx sets on every
task are the last row.

| Var                               | Value                 | Default | Effect                                                                                                                                                                                                                                                                                         |
| --------------------------------- | --------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VX_TIMING`                       | any non-empty         | off     | Print the stage table to stderr after a run, a `--dry`, or each `vx watch` cycle (`docs/modules/timing.md`).                                                                                                                                                                                   |
| `VX_TASK_TIMEOUT`                 | positive integer (ms) | none    | The default timeout for tasks without their own `exec.timeout`, one rung below `--timeout` / `RunOptions.timeout` and one above the workspace `timeout`. Empty, non-integer or non-positive is ignored; a value past the largest timer (~24.8 days) is clamped to it, never refused.           |
| `VX_CACHE_DIR`                    | a path                | none    | The workspace's cache dir, relative to the workspace root, below `--cache-dir` and `vx.workspace`'s `cacheDir`. A named cache dir holds the whole cache and shares nothing; unset, entries live in the user's shared store (`docs/caching.md`). Empty is ignored.                              |
| `VX_CACHE_SCOPE`                  | a `cacheScope` value  | none    | The run's `cacheScope` (`trusted`, `read-only`, `pr-123`), above `vx.workspace`'s and `github()`'s. Empty is ignored; a value `cacheScope` would refuse is refused before any task.                                                                                                            |
| `VX_KILL_GRACE_MS`                | positive integer (ms) | 2000    | The SIGTERM → SIGKILL grace a child that ignores SIGTERM gets: on a timeout, on a signal, and at the end-of-run shutdown of persistent tasks. Out of range falls back to the default.                                                                                                          |
| `VX_READY_NOTICE_MS`              | positive integer (ms) | 10000   | How long a persistent task may take to match `readyWhen` before vx says once what it waits for. Out of range falls back to the default.                                                                                                                                                        |
| `VX_TEARDOWN_TIMEOUT_MS`          | integer (ms)          | 3000    | The bound on one plugin's end-of-run flush or teardown, and on its `telemetry()` setup, so a third party's I/O cannot hold the run. Out of range falls back to the default, never clamps: a bound of 24.8 days is no bound.                                                                    |
| `VX_CONFIG_WORKER_TIMEOUT_MS`     | integer (ms)          | 30000   | How long one `vx.config.ts` evaluation may take, in process or in its worker, before the load fails naming the config (a real evaluation is ~10 ms). A synchronous loop on a first load holds the thread the deadline needs, so it hangs until killed. Out of range falls back to the default. |
| `VX_WATCH_POLL`                   | any non-empty         | off     | `vx watch` polls every 250 ms from the start instead of probing the OS watcher (§ `vx watch` › How changes are seen).                                                                                                                                                                          |
| `VX_RUN_WORKSPACE`, `VX_RUN_TASK` | set by vx             | —       | Set on every task's environment (the workspace root; `project#task`). Read back by a `vx run` a task starts: one in the same workspace is refused, since a nested run is invisible to the outer graph and a loop back to its own task forks without bound (`docs/schema.md` § `env`).          |

Colors are the two conventions in § Output format › Colors (`NO_COLOR`,
`FORCE_COLOR`). A truthy `CI` picks the CI output flow and
`GITHUB_ACTIONS` its `::group::` framing (§ Output); the run's
`invocations` row records the provider, the first truthy of
`GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`, `CIRCLECI`, then `CI`. Core never reads `GITHUB_STEP_SUMMARY`: `--report`
prints to stdout, and `--report-file=<path>` appends to a file, so on
Actions pass `--report-file="$GITHUB_STEP_SUMMARY"`.

## Output format

`vx run` emits framed blocks. Stdout/stderr from each task is
buffered until completion, then dumped inside the block — so
concurrent tasks never interleave their lines. A lone requested task
streams live instead (§ Output).

Frame anatomy:

```
┌─ app#test > failed (exit 1, 1 sandbox violation)

$ bun test

├─ STDOUT ──────────────────────────────────────────────────

2 pass
1 fail

├─ STDERR ──────────────────────────────────────────────────

error: expected 3, got 2

├─ SANDBOX VIOLATIONS (1) ──────────────────────────────────

write ../shared/notes.txt

└─ app#test ── (2.10s) failed (exit 1, 1 sandbox violation)
```

Every section is conditional: the `$ <command>` line only for an
executed task (success or failed — a hit replays its stored output and
shows none), `STDOUT` / `STDERR` only when the stream is non-empty,
`SANDBOX VIOLATIONS (N)` only when the sandbox recorded some or vx
has a note on a failure. The
header carries the outcome (`restored-local • abc12345`, `failed (exit
N)`, …) and the footer repeats it after the duration. A test renders
this block and checks it against this page, byte for byte.

Frame corners and rules render dim, section labels (`├─ …`) bold in
their state colour; the id keeps its identity coloring. Content lines are **raw** — no left border, no
indent — so long lines wrap without colliding with frame glyphs and
copy/paste yields the verbatim output. Every block (and every live
frame close in focused flow) is followed by a blank line so frames
never collide with the next one-liner. A persistent task's frame is
marked with a cyan `▸` after `┌─`/`└─`, and its close reads `running`
(the child is still alive).

There is **no top-of-run banner** — the run context lives in the
footer. A broad run looks like:

```
 ⇢     4ms success local    @vzn/vx#format-check
 ⏺︎   5.20s success miss     @vzn/vx#test

─ vx 0.0.0 ───────────────────────────────────────────────────
  projects  ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱
            1 in run · 3 total
  tasks     ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
            2 success · 2 total
  cache     ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
            1 miss · 1 local

  info      8 workers · local cache
  time      5.34s · max 5.20s · avg 5.20s · min 5.20s
  result    2 tasks · 1 cached (50%) · 5.34s
```

The three bars are meters: `projects` is what the run covered against
the workspace, `tasks` is failed / success / skipped, `cache` is miss /
no-cache / up-to-date / local / remote (a skipped task rides it too, so
the two legends sum alike). The `time` spread counts executed tasks
only — a hit's restore time never enters it — which is why one executed
task reads as its own max, avg and min. The `result` row is the run in
one line, last: tasks, cached (every hit, local or remote, over every
task with a cache that ran or hit; a skipped task asked no cache) and the wall time — `3 tasks · all cached · 40ms`
when nothing that could hit ran, with `N failed` after the count on a
red run. A task with no `cache` block could never hit, so it is
counted apart (`1 task · 1 no-cache · 37ms` for `vx run dev`). A test renders this run and
checks it against this page, byte for byte.

Group tasks emit no framed block by design (they aren't real tasks);
running a group focused surfaces its real member tasks instead.

**Nothing below the footer.** The footer is the run's last word.
What a run has to say about one task rides that task's row; what it
says about the run (a server that died, outputs left remote, a file
`--summarize` / `--profile` wrote, a history, upload, plugin or sandbox
warning) prints above the footer: it prints once the run's closing work
is done, the `VX_TIMING=1` table included. Cache housekeeping
(`cacheRetention`) prints nothing. Only a kept server's own output
follows it.

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

**Aborted and not-run rows.** After a stop (a shutdown signal), the
task list names what it cut short (`aborted`, with its time so far) and
what it reached first (`not run`). Neither reached the cache:

```
 ✗   2.41s aborted          app#dev
 ◌         not run          web#build
 ◌         not run          web#test
```

The tasks legend names them outside the total, which history and
telemetry share: `2 success · 2 total · not counted: 1 aborted, 2 not
run`. A framed task (focused or `full`) that
printed while it stopped shows its frame instead of a row.

**Flaky rows.** A task the run just proved nondeterministic says so
in a dim note on its own row (and its frame's footer) — from the local
run history alone, no service:

```
 ◼︎   4.21s failed  miss     app#test flaky - passed 3× before
 ⏺︎  12.84s success miss     api#e2e flaky - failed 1× before · 2 attempts
```

A task is flaky when its exact cache key has BOTH passed and failed on
record (this run counted; a cache hit is a pass, it replayed one), or
when it needed a retry (`exec.retries` / `--retry`) this run. A failure
on a key that never passed is a break and carries no note — a changed
input that fails is what a red run usually means. Only tasks with a
`cache` block are judged: "same inputs, different outcome" is a claim
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
`last`, a `--dry` plan, `--graph`, `cache prune`), and the help off a
terminal, prints plain text whatever `FORCE_COLOR` says, so a script
that forces colour for a run's log still parses them
(`tests/cli-colors-e2e.test.ts`).

## Remote cache (plugin-driven)

Core ships **no remote-cache wire client** — the remote cache is a
plugin concern. A `cache` plugin composes core's `LayeredCache` over a
wire client; `@vzn/vx-reapi` provides one for any Bazel REAPI server
(ActionCache + CAS).

Reads try local first, then remote (hydrating local on remote hit),
with a background prefetch pass overlapping remote GETs with
execution. Writes go to local immediately; the remote upload is a
fire-and-forget background task drained at end of run — failures are
logged via `onRemoteError` but never fail the build.

For any OTHER cache server (a Turbo-wire deployment, S3-direct, …),
implement core's `RemoteCacheLayer` interface in a plugin's `cache`
capability — the recipe lives in the plugins guide. Embedders
holding a wire client can inject it per-run via
`RunOptions.remoteCache` (explicit injection wins over the plugin
consult). The retired `VX_REMOTE_CACHE_*` env vars are gone.

## Run analytics

`vx info` surfaces the aggregate cache stats (entry count, total
size, runs + hits in the last 24 h). For anything deeper, vx records
every task to a `runs` table in `cache.db` (UUIDv7 `run_id`, hrtime
wallclock spans, cpu_ms, peak RSS, status, cache_hit flag) plus one
`invocations` header row per run (command, git/CI context, tags,
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
  `Promise<RunPlan>`. Used by `--dry` / `--graph`.
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
