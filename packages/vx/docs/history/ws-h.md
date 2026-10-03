# Stream H — the 1.0 contract (plan-2026-09-27): merged items, one entry per PR

## H-1: pin the config schema's full surface (roadmap 3.1)

`tests/contract-config-schema.test.ts` generates the schema's surface from
the validator itself: an unknown key injected at every object node of a
valid seed reads each level's `allowed:` list, and every field is probed
with 32 values (each JSON type, the numeric edges, the glob and env-name
shapes the refusals name); a record's entry names are probed with the seven
task-name shapes. Every outcome (acceptance or exact refusal text) is
compared with the committed `tests/contract/config-schema.json`. Each
level's field list is also held to its exported interface in
`src/config.ts` by the type checker (`Keys<T>`), so a field the interface
declares and the validator refuses, or the reverse, fails. Differential: a
new `exec` field, a reworded refusal and a dropped check each fail the
record row; removing a key from a `Keys<T>` literal fails the type check.
A field the validator names but refuses every value of (`sandbox.ignore.pty`
and `.gitConfig`) is probed unseeded and must accept nothing.

## H-2: pin the plugin API and the façade's shapes (roadmap 3.2)

`tests/contract-package-api.test.ts` and its reader
`tests/helpers/api-surface.ts` pin the SHAPE of everything `src/index.ts`
exports, where the boundary test pinned only the names. The reader
resolves each export through `export {…} from`, `import {…} from` and
`export *` (per file, so the two `RunResult`s and two `Plugin`s resolve
to their own declarations), and follows every capitalised identifier a
declaration names to its declaration: 177 declarations, the non-exported
`BaseContext` among them. Comments are stripped by a scanner that keeps
strings and template literals, a function is cut at its body, a class
keeps its public members (a field's initializer dropped). Constants add
their runtime values. The record is `tests/contract/package-api.txt`; a
second row holds `VxPlugin`'s members to `PLUGIN_HOOKS`. Differential: a
member added to `TaskExecutor`, a type changed in the non-exported
`BaseContext`, and a hook added to `VxPlugin` alone each fail; a reworded
comment passes (control).

## H-3: a removed config field is refused naming its replacement

`versioning-1.0.md` § Deprecation promised that a removed field's refusal
names the replacement and the version that removed it; nothing did.
`exec.resources` (removed in 0.0.19 with the reservations, item 157) was
refused as `unknown field "resources"`, a message that sends a reader to
the history. `REMOVED_FIELDS` in `config-schema.ts` maps a level's field
set to its removed fields; `assertKnownFields` consults it before calling a
key unknown. The version came from the release tags: v0.0.18's
`config.ts` declares `resources?: ResourcesConfig`, v0.0.19's does not.
`tests/contract-removed-fields.test.ts` holds the message word for word
(red with the lookup disabled), a control that a never-known field is
still unknown, and every entry's shape; `schema.md`'s error table gains
the row, provoked in `schema-doc-drift.test.ts`. The warning of step 1 is
not built: no field is deprecated, and the doc says so. Written in stream
D's file because the plan assigned the mechanism to H; the change is the
table and one lookup.

## H-4: state exactly what 1.0 freezes, held to the code (roadmap 3.1, 3.2)

`versioning-1.0.md` named the frozen surfaces but not what is in them. §
What 1.0 freezes, exactly lists every config level and its fields (two
tables), the levels keyed by an author's name, the thirteen hooks in
pipeline order, the telemetry record kinds and schema version, and the
plugin types by name. `tests/contract-versioning-doc.test.ts` holds each
list both ways to its source: the levels to `config-schema.json` (itself
held to the validator), the hooks to `PLUGIN_HOOKS`, the kinds to
`TelemetryRecord` as the source declares it, the version to
`TELEMETRY_SCHEMA_VERSION`, and each named type to the façade's surface.
Differential: a field dropped from a table, a renamed hook, a wrong
version, a dropped kind, a dropped keyed level and an unexported type name
each fail their row. The contract table's "Defined by" column named
`src/config.ts` for the plugin API, where `VxPlugin` is not; it now names
the files and each surface's record.

## H-5: pin the `--dry=json` and `--summarize` wire shapes

Both machine-readable run outputs are contract surfaces, and both are
wire objects built field by field (`formatPlanJson`, `writeRunSummary`),
so H-2's type pin does not hold them: a key renamed there passed every
test. `tests/contract-cli-wire.test.ts` renders each from a fixture typed
`Required<PlannedTask>`, `Required<RunPlan>`, `Required<TaskOutcome>` (a new
source field must be given a value before the file compiles; writing it
found `sandboxViolationLines`, which a grep of the interface had missed),
flattens the JSON to key paths with the types seen at each, and compares
with `tests/contract/cli-wire.json`. `cli.md`'s two samples may show only
key paths the wire has, with its types. Differential: `p50Ms` renamed in
`formatPlanJson` fails the record row; a key added to the doc's sample
fails the doc row.

## H-6: pin what each task glob selects, runtime included

Task-glob semantics are contract, and the answer is `Bun.Glob`'s as much
as vx's: a Bun upgrade that read `[`, a brace or a dotfile differently
would change what a key covers, with no vx line changed.
`tests/contract-task-globs.test.ts` builds one project tree (dotfiles, a
gitignored file, `node_modules`, `[id]`, `(group)`, `{b}`, a space) in a
git work tree under a canonical root, resolves 32 input lists and 8 output
lists through `resolveInputs` / `resolveOutputs`, and compares every
selection or refusal with `tests/contract/task-globs.json`. Differential:
`ALWAYS_IGNORE` losing `node_modules` and `OUTPUT_NEVER` gaining
`.github` each fail it.

## H-8: pin the config schema's rules between fields, found pairwise

H-1 recorded each field alone, so a rule between two fields could change
unseen: removing the refusal of `retries` on a persistent task passed H-1's
record and failed only the new row. The same test file now tries every task
field and `exec` field at each seed value alone and in every pair, on a
plain task (`exec.command` only) and, for the task's own fields, on a group
task (`dependsOn` only), and records the singles that are refused and each
pair that disagrees with its halves in
`tests/contract/config-schema-rules.json`. The table it found is the
schema's rule set: `persistent` excludes `cache` and `retries`,
`remote: 'only'` needs `cache`, a task without `exec` needs `dependsOn`,
and `cache` on a group task is refused. A rule that needs three fields
(`cache.inputs.tasks` naming no `dependsOn` entry) stays with
`schema-doc-drift`'s table. Units are whole blocks, not leaves: a leaf
alone (`cache.inputs.env`) is refused by its own block and flooded the
first cut with 80 rows of noise.

## H-9: drop four façade exports nothing outside core used

Before 1.0 freezes them: `nearMatches`, `PERSISTENT_TASK_NAMES`,
`TASK_STATUSES` and `deriveCacheSource` had no user in any plugin, the site
or a user doc (only core's own module pages). Breaking for a 0.x importer;
each stays exported inside core. `LOG_WIRE_VERSION` stays: the exported
`TaskLogBundle` type names it.

## H-10: a plugin executor hears the run stop (`ExecuteRequest.signal`)

The plugin-author walk wrote an executor from the guide and types alone
and found no way to stop it: on Ctrl-C vx exited 130 and the executor's
child ran on (reparented to init), and an embedder's abort waited for it.
`req.liveChildren` did not help: `killTree` signals a process group, and a
plugin's child leads none. Core already had the run's stop signal; it now
rides the request as `signal`. The guide gains "Where a task runs", a
runnable executor that stops its process group on the signal (type-checked
by `plugins-guide-snippets.test.ts`, and run under Ctrl-C in a scratch
workspace: no child left). Row: `plugin-executor-abort.test.ts`, green with
the forward, a 20 s timeout without it.

## H-11: the 1.0 release checklist

`versioning-1.0.md` said when 1.0 takes effect but not how to cut it.
§ Releasing 1.0 lists the six steps in order, each with how it is checked:
milestone 3 and the soak, the contract records (the gate runs every
`contract-*.test.ts`), the notes (`git diff --stat <last-tag> --
packages/vx/tests/contract/` lists every surface that moved), the plugins
on npm, the README's status section, the tag. Pinned: every record the
contract table names must exist (`contract-versioning-doc.test.ts`; a
misspelt record path fails it).

## H-12: `exec.timeout` reaches a plugin executor

Found writing H-10's guide example: core passes `timeoutMs` to an executor
and enforces nothing, so a task's declared `exec.timeout` meant nothing on
a plugin executor that kept no clock (the guide's own example ran forever).
The request's `signal` now also aborts when the timeout elapses, and a
non-zero exit after that abort is recorded `timedOut` (the frame, the retry
line and the outcome say "timed out"). Row in
`plugin-executor-abort.test.ts`: fails as timed out in 300 ms with the
change, hangs to the row's 20 s bound without it. The first cut declared
its timer after the retry loop that used it; the row caught the throw.
Leads: **A** — a plugin executor that ignores `req.signal` still holds its
task past `exec.timeout` (core awaits `execute` unbounded). **B** —
`resourceUsageToCpuRss` "the peak is the child's own" failed on macOS CI on
#1269, a docs-only diff (timing-sensitive).

## H-13: re-validate the workspace config after each `config` plugin

The walk's `config` hook set what a user may not: `concurrency: -3` hung
the run ("something it awaited can never settle"), `timeout: 'x'` timed
every task out at once, `cacheDir: 42` was a TypeError from
`path.resolve`. The `project` stage already re-validated after each
plugin; `config` now does the same, naming the plugin. Row:
`plugin-pipeline.test.ts` "a plugin that produces an invalid workspace
config…", red without the check (`undefined` for every refusal).

## H-14: an executor that ignores `req.signal` no longer holds the run

H-12's lead A: a plugin executor that never looks at `signal` held its
task, and the run, past `exec.timeout` and past an embedder's abort, since
core awaited `execute` unbounded. After the abort core now waits the kill
grace the local executor gives a process group (`VX_KILL_GRACE_MS`, 2 s),
then settles the attempt without it (timed out, or aborted), with one
stderr line naming the executor. The local executor is exempt by identity
(`isLocalExecutor`): it SIGKILLs its own group. Rows:
`plugin-executor-abort.test.ts` "an executor that ignores the signal",
both at the 20 s test timeout without the bound.

## H-15: release notes from Conventional Commits

`auto-release.yml` used GitHub's generated notes: every merged PR title,
docs and tests among them, and nothing marked a breaking change.
`scripts/release-notes.ts` now writes them from the commits since the
last tag: breaking changes (`type!:` or a `BREAKING CHANGE:` footer)
first, then Features, Fixes, Performance, and one count for the rest.
Rows: `release-notes.test.ts`; three mutants of the classifier each
turn a row red.

## H-16: hook contract sweep — `async admit`, `ctx.on` typos

Each hook's documented guarantee, driven from a scratch workspace. Two
broke: an `async admit` answered a Promise, so every task was admitted and
the policy never ran, and its rejection ended the run with a stack, exit 1
("a policy never breaks a run"); it is now reported once and admits, as a
throw is. And `ctx.on('taskComplete', …)` (the name is `onTaskComplete`)
subscribed a handler that never ran, silently; an unknown name now fails
the load, listing the known ones. `modules/plugin.md` claimed every hook
but `setup` was crash-isolated; stages and the executor/cache factories
fail the run by design, and it now says which is which. Held elsewhere
already: teardown after a sibling's setup throws, teardown's 3 s bound,
a core verb's name refused, schedule weights checked, telemetry factory
isolated. Rows: `plugin-pipeline.test.ts` "an async policy…",
`plugin.test.ts` "a hook name ctx.on does not know…", each red without
its fix.

## H-17: runnable example plugins, one per seam

`packages/vx-plugin-examples` (private): executor, cache, telemetry,
schedule, admit, commands, project, graph and key, each a complete
plugin in one file, each run by `tests/examples.test.ts` through `run()`
or the CLI with an observable result (a remote hit after the local cache
is wiped, a timeout stopping the executor's child, a key moving with an
env var). The guide's snippets were type-checked only; these run, so a
seam that moves under an example turns the gate red. Linked from the
plugins guide's first section.

## H-18: a package API break must be declared

`tests/api-break.unsafe.test.ts` diffs the package API record against the
last `v*` tag's copy. A removed declaration, or a line gone from one (a
removed member, a changed signature), is a break, and it fails the gate
unless a commit since the tag is `type!:` or has a `BREAKING CHANGE:`
footer, which H-15's notes then list first. Every green main commit is
released, so the last tag is main's last green commit. CI's Linux job
checks out full history and sets `VX_REQUIRE_TAGS=1` (no tag = a failure). Rows: `api-break.test.ts` (what is a
break); the law, red with one member deleted from the record and no
marker.

## H-19: remove the `vx stats` alias and the dead `InvocationRow` type

The deprecation sweep before 1.0 found two surfaces kept only for
compatibility: `vx stats`, an alias of `vx info` that warned on every
use, and `InvocationRow`, a deprecated type alias no file imports. Both
are removed; `vx stats` now prints a pointer to `vx info` and exits 1
(`MOVED_VERBS`, as `vx prune` does), and a plugin may declare `stats`.
Kept on purpose: the run lock's `pid` holder file, which a vx from
before item 759 still writes, so two versions running during an upgrade
still exclude each other. The commit is marked breaking, so H-15's notes
list it and H-18's law accepts it. Rows: `show-info.test.ts` (the
pointer), `dispatched-verbs.test.ts` (the verbs a plugin may not
declare).

## H-20: an API reference generated from the source

`docs/api.md` lists every export of `@vzn/vx` with its declaration (as
the package-API contract records it) and the doc comment above it.
`tests/api-reference.test.ts` generates it from `src/index.ts` and fails
when the committed page differs, so a changed signature or comment
cannot leave the page stale (`VX_UPDATE_CONTRACT=1` rewrites it). The
public-surface page links it. The page is generated, so oxfmt skips it.
Declined from the same backlog: a JSON Schema for the config files. They
are `.ts`/`.js` only, editors complete them from `src/config.ts`'s
types, and those types are already held to the validator both ways
(`contract-config-schema.test.ts`).

## H-21: `vx init --plugin <seam>` scaffolds a runnable plugin

`vx init --plugin <seam>` writes `plugins/<seam>.ts` and
`plugins/<seam>.test.ts` for any of the nine seams, and prints the
line that declares it. The files are H-17's examples, now one plugin
and one standalone test per seam side by side
(`packages/vx-plugin-examples/plugins`), so the gate runs exactly what a
user gets. Core cannot import a sibling package, so
`src/cli/plugin-templates.ts` is a generated copy, held to the examples
byte for byte by `plugin-templates.unsafe.test.ts`. A scaffolded test
was run in a fresh workspace with `@vzn/vx` linked: green. Rows:
`init.test.ts` "vx init --plugin <seam>" (written bytes, the overwrite
refusal, the unknown seam, `--dry`).

## H-22: the release version follows the commits

`auto-release.yml` bumped the patch on every release and left minors and
majors to a hand-cut release. `nextVersion` in `scripts/release-notes.ts`
now picks it from the Conventional Commits since the last tag: before
1.0 a `feat` or a breaking change is a minor, anything else a patch;
from 1.0 a breaking change is a major. Below 0.1.0 it stays a patch:
the roadmap reserves cutting 0.1.0 to the owner (item 1.4), and the
rule on today's tag (v0.0.100) would have cut it on the next merge. The workflow calls it
(`--next <last> <sha>`) where it computed the patch in shell. Rows:
`release-notes.test.ts` "nextVersion" on fixed commit lists.

## H-23: CI holds PR titles and commits to Conventional Commits

The convention (owner, 2026-09-27) held only while someone watched. The
repo rebase-merges, so each commit subject lands on main as written, and
the release notes and version (H-15, H-22) read them.
`scripts/conventional.ts` is the rule (`type(scope)!: summary`, a known
type); `tests/conventional-commits.unsafe.test.ts` applies it to the PR
title and to every non-merge commit in base..head, which `ci.yml` passes
from the pull_request event (`VX_PR_TITLE`, `VX_PR_BASE`, `VX_PR_HEAD`);
a push and a local gate pass none. Rows: `conventional.test.ts` (which
headers pass, and why others fail); the law, red on main's old
`… (#764)` subjects and on the title `Add a thing`.

## H-24: `--graph`'s DOT joins the CLI wire record

`versioning-1.0.md` names `--graph` among the frozen machine-readable
outputs, and nothing recorded it: an edge turned around (task → its
dependency) passed every test. `contract-cli-wire.test.ts` now records
the DOT for its fixture plan in `tests/contract/cli-wire.json`, line by
line; that mutant turns it red. The contract table names the record for
the three outputs. `vx mcp`'s tools, the fourth output that table names,
are still held only by name (lead for F).

## H-25: each plugin package's exports are a contract record

Core's exports were recorded (`package-api.txt`) and the plugin packages'
were not: renaming `reapi()`'s options or dropping `vx-lockfile`'s `bun()`
passed every test. `tests/contract-plugin-api.unsafe.test.ts` records each
package with an `exports` entry in `tests/contract/plugin-api/<package>.txt`,
and `api-surface.ts` now reads an entry's own declarations, `export *` and
re-exported namespaces (core's record is unchanged). The API-break law
diffs these records against the last tag too: a line dropped from
`vx-mcp.txt` under a probe tag turned it red.

## H-26: the documented configs load under the current schema

Nothing loaded the configs the docs, the site and `examples/` show, so a
schema change could refuse one and pass. `tests/config-corpus.unsafe.test.ts`
finds them (38 today), imports each and validates it; dropping
`description` from the task fields turns two red. It found one broken:
`schema.md`'s shared-inputs sample called `defineProject` without
importing it. Two fences are sketches by design and are named in the test.

## H-27: a PR that breaks the API says so in its title

The break law judged commits since the last tag, after the merge; a
reviewer saw nothing in the title. `api-break.unsafe.test.ts` now also
diffs the API records between a PR's base and head (CI passes both with
the title, H-23) and fails unless the title is `type!:`. A probe PR that
dropped `mcp` from `vx-mcp.txt`, or deleted the record, failed under
`fix:` and passed under `fix!:`. It fixed H-25's record listing:
`git ls-tree <ref>:./<dir>` lists nothing, so a record deleted since the
tag was never diffed.

H-25 itself merged while F-42 added a `vx-github` option and turned main
red; #1600 re-recorded it. Two PRs in flight, one changing a plugin's
exports and one its record, cannot see each other: the record lands
behind.

## H-28: a header 72 characters or longer fails the Conventional Commits check

CONTRIBUTING and CLAUDE.md set the first line under 72 characters, and
H-23's check read only the shape: 39 of main's last 300 subjects are
longer. `conventionalError` now refuses a header of 72 or more, so a PR
title or commit that long fails CI; a 71-character row passes, a
72-character one fails, and it passes without the rule.

## H-29: `vx mcp`'s tools join the contract records

`versioning-1.0.md` froze `vx mcp`'s tools and only their names were held
(H-24's lead). `vx-mcp/tests/contract-tools.test.ts` records each tool's
input schema and its answer's key paths from a workspace with two real
runs, in `vx-mcp/tests/contract/tools.json`; renaming `hitRate24h` turns
it red. Types stay out: `memory.cgroupLimitBytes` is a number in a
container and null on CI's runners. One seeded run with a peak makes the
optional `maxPeakRssBytes` reachable on every host.

## H-30: the CLI's exit codes are a contract record

`versioning-1.0.md` froze the CLI's exit codes, and they lived only in
`cli.md`'s prose and in scattered rows. `contract-exit-codes.test.ts`
drives fifteen documented outcomes through the binary against one
workspace and records each code in `tests/contract/exit-codes.json`; every
failing case was checked to fail for its documented reason, not another.

## H-31: every Turbo and Nx config key has a stated vx status

vx runs Turbo and Nx repos unchanged, and nothing said which keys that
covers. `tests/contract/turbo-nx/` vendors `@turbo/types` 2.11.5's and
`nx` 23.2.1's schemas; `turbo-nx-support.test.ts` reads every key from
them (136: roots, tasks and targets, `remoteCache`, `futureFlags`,
`boundaries`, `targetDefaults`, Nx input forms) and requires one row each
in `turbo-nx-support.json`. The first table missed
`futureFlags.experimentalPythonWorkspaces` and the test named it. The page
is `docs/turbo-nx-support.md`, served at `/compare/turbo-nx-support/` and
linked from the README. The site's import cleared stale generated pages at
the top level only, so it now clears them at any depth.

## H-32: a committed `vx-lock.json` stays valid across releases

The lock is checked in and read by `vx lock --check` and `--frozen` in CI,
and nothing held its format: a change to how `configHash` is taken would
have failed every user's `--check`. `contract-lockfile.test.ts` records the
lock for one fixture in `tests/contract/vx-lock.json`, byte for byte, and
requires the committed copy to pass `--check` and drive a `--frozen` run.
Tampering one `configHash` fails both rows; dropping `--frozen` fails the
run row. The versioning table now names the lock file and the `VX_*`
variables vx reads.

## H-33: the README's try-it steps run as written

The README and the landing lead with one `vx.workspace.ts` and three
commands, and nothing ran them. `try-it.unsafe.test.ts` extracts both from
the README, holds the landing's copy equal, and runs them on a Turbo repo
(`examples/turbo` without its workspace file) and an Nx repo (the file's
own `nx()` variant, a stand-in `nx` that only exports the graph): the
first `npx vx run build --all` builds, the second hits. The install line
links exactly the packages it names from the checkout (`@vzn/vx-migrate`
is not on npm, which the README already says). Rewriting a run line to
`npx vx build --all` fails three rows, each naming the line.

## H-34: a same-bytes self-rewrite stays unsaved, and why

unocss's `@unocss/vscode#build` rewrites `README.md` with the same bytes,
so vx never saves it and Turbo wins every warm run. The proposed fix,
re-hash the inputs whose stat moved and save when every digest matches
the key, is the check item 1015 replaced: applied to `movedInput`, it
fails `inputs-moved.test.ts`'s edited-and-reverted row (the edit's output
filed under the original key), the same-bytes row and the unit row. The
gap stays and `benchmarks.md` says why beside the unocss numbers. Lead
for A below.

## H-35: what each npm package ships is a contract record

Nothing held what `npm publish` uploads, and the plugins have never been
published. `npm-pack.unsafe.test.ts` emits every package with
`scripts/build-npm.ts`, packs each with `npm pack --dry-run --json`, and
compares its file list with `tests/contract/pack/<package>.txt`; a stray
test or fixture, a file over 512 KiB, or an `exports` / `bin` target the
tarball lacks fails, naming it. A `src/probe.test.ts` in vx-mcp failed the
list row; dropping `src` from its `files` failed both. The packed `@vzn/vx`
and `@vzn/vx-migrate` install with npm into a Turbo repo, where `turbo()`
builds (the launcher falls back to `bun src/bin.ts`) and then hits: G's
by-hand check, now a row.

## H-36: a break of any contract record must be declared

The break law (H-25, H-27) read only the API records: dropping a config
field, a `--dry=json` key, an exit code, an MCP answer key or a shipped
file needed no `!`. `contractBreaks` reads every record under
`tests/contract/` (the vendored upstream schemas aside) and vx-mcp's, each
its own way: API records by section, pack lists and leaf records by what
they lost, the config schema by fields and accepted values (a reworded
refusal is no break), its rules by combinations, the Turbo/Nx table by a
status that got worse. Against v0.0.185 main has no unmarked break; under
a probe tag, an exit code changed and a pack line dropped each failed,
named.

## H-37: the CLI's verbs, flags and variables are a record

The versioning table froze verbs, flags and `VX_*` variables, but only
drift tests held them, each against a doc a removal also edits: dropping
`--tag` from the parser, help and cli.md passed. `tests/contract/cli-surface.json`
records each verb's flags (`verbFlags`, parser-held) and the variables
the source reads (the walk env-doc-drift uses, now `tests/helpers/env-reads.ts`),
so a removal is a reviewed diff and, with H-36, a break. Differential:
a record without `--tag` fails; restored, passes.

## H-38: each flag's accepted values are a record

H-37 froze flag names; a parser that stopped taking `--output-logs
hash-only` or `--dry=text` still passed. `cli-surface.json` now records,
per verb and flag, the values its parser takes: `*` when it takes a
sentinel no parser could, else the source's words (literals and object
keys, where `init --plugin`'s seams live) and fixed grammar probes it
accepts. The parser map moved to `tests/helpers/cli-parsers.ts`, shared
with completions.test. Differential: a record without `hash-only` fails,
and `contractBreaks` names it lost; adding it back is no break.

## H-39: a `--format json` schema is a record the break law reads

`schemas/<verb>.json` is checked in, shipped, and held to the source
types by cli-json-schemas, but it sat outside `tests/contract/`, so
dropping a field from `vx info --format json` (type and schema edited
together) needed no `!`. The law now reads `schemas/` too: a lost
property, `required` entry, type or enum value breaks; reworded `title`
or `description` prose does not, except where the name is a property
(`show`'s `description` field). Differential: under a probe tag, dropping
`bun` from `info.json` failed naming both leaves; mutating the prose rule
either way failed the unit row.

## H-40: how vx finds a workspace is a record

The versioning table froze no discovery: dropping `workspaces.packages`,
reordering `vx.config.ts` before `.mts`, or changing which root a member
resolves to passed every contract test. `tests/contract/discovery.json`
records, from the real discovery on fixtures, each layout's projects,
the root found from inside a member, and every config file name
precedence (project and workspace). Differential: swapping the first two
`PROJECT_CONFIG_FILENAMES` failed it; restored, passes.

## H-41: what vx-otel sends is a record

Dashboards and alerts key on vx-otel's span names, attribute keys and
metric names, but only its exports were recorded: renaming `vx.cpu_ms`
passed every contract test. `packages/vx-otel/tests/contract/otlp.txt`
records the shape of the traces, metrics and logs the sink posts for one
run with every telemetry field set (`Required<…>`, so a new field must
be given a value): each path, attribute key and OTLP value type, and the
span kind, temporality, monotonicity and severity. The break law reads it
by lost lines. Differential: renaming `vx.cpu_ms` failed it; restored,
passes.

## H-42: vx-migrate's command lines are a record

Configs vx-migrate writes call `nx-exec`, `nx-env` and `lage-worker`, so
a 1.x that changed their argv would break a config 1.0 wrote; nothing
recorded them, nor `vx-migrate`'s own flags. `packages/vx-migrate/tests/contract/cli.txt`
records, from each bin spawned, its `--help` and usage-error exit codes,
its leading positionals and each flag its usage names (one line each, so
an added flag is no break), and the sources `--from` takes. The break
law reads it. Differential: dropping `--envFile` from `nx-env`'s usage
failed it; restored, passes.

## H-43: the check run vx-github posts is a record

Branch protection requires a check by name and automation reads its
conclusion, but nothing recorded vx-github's check run: renaming the
default `vx` or changing a conclusion passed every contract test.
`packages/vx-github/tests/contract/checks.txt` records, from the plugin
driven with its defaults through a passing, a failing and a cancelled
run, each POST's endpoint, method, header names, body keys, and its
`name`, `status` and `conclusion`. The break law reads it. Differential:
a default name of `vx run` failed it; restored, passes.

## H-44: the stale leads, checked

The 1.0 roadmap's agent items are all done; what stands is the owner's
(the 0.1.0 cut, the scope list, the soak). Every lead below but the
first (a design item: only the sandbox can tell a task was its input's
lone writer) was already closed, and each now names where. Two of them:
`dependsOn: ['']`, `['!x']`, `['^']`, `['#']` and `['a#']` are each
refused at graph build naming the task (`Task a#build: Invalid dependency
spec …`), held by `dependency-spec.test.ts`, `task-graph.test.ts` and
`config-schema-refusals.test.ts`; and `vx stats` was removed in H-19.

## H-45: the variables the plugins read are a record

CI, not a config, sets `VX_REAPI_ENDPOINT`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
`GITHUB_TOKEN` or `TURBO_TOKEN`, and only core's `VX_*` reads were
recorded. `tests/contract/plugin-env.txt` holds each plugin package's
reads, found in its source (a write or a comment is not one).
Differential: dropping `VX_REAPI_ENDPOINT` from the record failed it
(#2410).

## H-46: exit codes that need a state or a signal

`exit-codes.json` held only what one fixture reaches as is.
`exit-codes-states.json` adds a missing or drifted lock, `--frozen`
without one, `show` of an unknown target, `why`/`last` with and without
a run, `completions` of an unknown shell, and 130/143/129 on
SIGINT/SIGTERM/SIGHUP; cli.md states `why`'s, `last`'s and
`completions`' codes (#2432, from #2412).

## H-47: the `--profile` trace is a record

Perfetto and scripts read it, and renaming `args.exitCode` passed every
contract test. `profile-wire.json` holds its key paths and types, and
cli.md's sample is held to them (#2413).

## H-48: what is not the contract

`--report`'s markdown and the files `vx init` writes are for people;
versioning-1.0.md now says so (#2432, from #2415).

## H-49: `vx init`'s exit codes

Documented in cli.md and recorded in `exit-codes-init.json`: no
`package.json`, an unknown flag, `--dry`, a write, a refusal over
existing files, `--force` (#2420).

## H-50: plugin env reads through a helper

H-45's reader saw only reads that name the variable. A name handed to a
helper (`off('OTEL_TRACES_EXPORTER')`, `read('concurrency',
'TURBO_CONCURRENCY')`) or built from a template
(`OTEL_EXPORTER_OTLP_${SIGNAL}_PROTOCOL`) passed a rename. The reader
takes both; a template is recorded with `*` per placeholder, which pins
its shape. Differential: the old reader fails the new record (#2435).

## H-51: plugin entries export only their documented API

1.0 freezes every export (versioning-1.0.md), and the plugin entries
re-exported ~60 helpers only their own tests used: vx-github's Checks
API calls, vx-otel's OTLP builders, vx-lockfile's parser namespaces,
vx-migrate's mappers, cache clients and CLI, vx-reapi's wire and Merkle
encoders. Each entry now exports its plugins, their options types and
what a documented option or class needs (vx-github's `FetchFn`,
vx-reapi's `ReapiRemoteCache` with `ReapiOptions`); tests import the
module. vx-schedule-history kept its helpers: its README documents them
for policies. Breaking, declared per package (#2503, #2508, #2512,
#2520, #2521).

## H-52: every plugin export named in its README

`plugin-exports-documented.unsafe.test.ts` requires each name in a
plugin-api record in that package's README. It found vx-migrate's and
vx-schedule-history's options types unnamed, and vx-otel's `post` option
undocumented with its `PostFn` and `OtlpTls` types unexported, so a config
could not name them; both are exported now. Differential: dropping the
vx-migrate names lists exactly those four types (#2527).

## H-53: every plugin env read named in its README

`plugin-env.txt` records each variable a plugin reads; nothing held that
its README names it, and vx-migrate honoured eleven no doc mentioned
(`TURBO_CONCURRENCY`, `NX_PARALLEL`, `GITHUB_BASE_REF`, …), vx-otel the
per-signal protocol. Each is named now, and
`plugin-env-documented.unsafe.test.ts` requires every recorded read, a
`<SIGNAL>` family or a named member covering a template. Differential:
the old READMEs list exactly those twelve (#2531).

## H-54: reapi() refuses the wire-form options it ignored

`ReapiPluginOptions` extended all of `ReapiOptions`, so `reapi()`
accepted `onWarn`, replaced by the plugin's own warn without a word, and
the PEM-text TLS fields, which skipped the cert-and-key pair check the
file options get. They are refused as unknown now; `ReapiRemoteCache`
still takes them. `wire-only-options.test.ts`: four rows fail without
the fix (#2535). It merged at its first commit, whose named key alias
joined the API record and reddened H-52's law on main; #2537 named it
in the README, #2541 inlined it (a `!`: v0.0.421 had shipped the
record).

## H-55: every plugin option named in its README

`refuseUnknownOptions` accepts every field of a plugin's options type,
and 1.0 freezes them; H-54's two defects hid in unnamed ones.
`plugin-options-documented.unsafe.test.ts` reads each `…Options` type in
the plugin-api records and requires every field in a code span or sample
of the package's README. It found vx-github's three test seams unnamed;
the README names them as such. Differential: the old README lists exactly
those three (#2542).

## H-56: the umask read on one thread, never during a load

Bun's `process.umask()` reads the mask by setting 0 and putting it back:
four workers reading at once left the process at 0 in every run. Config
loading read it on the main thread around each first load while the
config worker read it around each repeat load, so a mixed round could
blame an innocent config (`show-info.test`, red under gate load) or leave
vx writing world-writable files. The worker reads it only when blaming,
the one evaluation in flight, and restores before it answers; the main
thread reads it around a lone load or before and after a round, and after
each blame. `config-umask-concurrent.test.ts` counts the reads (2 main, 0
worker; 5 and 6 before) and holds a blame that outlives its budget. The
first push restored after the blame's reply, which the loader cuts short;
CI caught it, 1 run in 30 (#2556).

## H-57: each verb's cli.md section held to its flags and exit codes

The verbs, flags and exit codes were recorded and held to the parsers,
but no verb past `run` was held to its own cli.md section: `vx info
--cache-dir` was in none, and info, completions and upgrade stated no
exit codes. `cli-verb-sections.test.ts`: every flag a verb accepts is
named in its section's code (watch names the run flags it refuses), its
synopsis names no flag it refuses, it states its exit codes, and every
code the exit-code records hold for it is one it names. Differential:
the old cli.md fails three rows on exactly those gaps (#2570).

## H-58: schema.md and every refusal held to the config schema

The record holds each level the validator accepts; schema.md reprinted
ten as interfaces, and the project root and `sandbox.ignore` were in no
reprint. `config-levels-doc.test.ts` requires every record level as an
interface block or inline object type with exactly its fields, and
every reprinted interface to be a level; the page reprints
`ProjectConfig` and `SandboxIgnore`. `config-refusals-pinned.test.ts`
requires each `throw new UserError` in config-schema.ts word for word in
a test, a contract record or the error table: 90 of 95 were, and the
five plugin-shape refusals are pinned whole (#2586).

## H-59: telemetry.md's records held to the source

The telemetry records are a 1.0 contract, and the page a sink author
reads named no field. telemetry.md § Records reprints
`RunContextRecord`, `TaskTelemetry` and `RunSummaryRecord` and tabulates
each streaming kind's fields; `telemetry-doc.test.ts` holds every field,
its optionality and each kind's row to telemetry.ts both ways (#2592).

## H-60: discovery's refusals held word for word

H-58's refusal law read config-schema.ts alone. It reads the loader and
discovery too now (project-loader.ts, workspace.ts), and counts a pin
written across concatenated literals or as a regex. Five refusals of a
plugin-named project (`namedProject`: a shape that is not
`{ dir, name }`, a directory outside the root, another project's
directory or name, a name its package.json does not give) were in no
test; `discovery-refusals.test.ts` pins each whole (#2599).

## H-61: a VX_* read the env reader cannot see

env-doc-drift held cli.md's variables to core's reads as exact sets,
but finds a read by its spelling; a read through a helper
(`envInt('VX_X')`) passed every law undocumented, the gap H-50 closed
for plugins. `env-reads-complete.test.ts` requires every quoted
`'VX_*'` name in core's source to be a read the reader finds; an
injected helper read fails it while env-doc-drift passes (#2606).

## H-62: cli.md's exit codes are every code the CLI returns

The exit-code records drive documented outcomes and H-57 ties each
section to them; a code the source returns that no record drives was
seen by neither. `exit-codes-complete.test.ts` collects each verb's
`return N`, bin.ts's own and 128 + n per stop signal, and requires
exactly that set in cli.md's exit-code statements, plugin verbs aside:
{0, 1, 129, 130, 143} both ways. A new `return 2` or a dropped `129`
fails it (#2610).

## H-63: the hook tables hold PLUGIN_HOOKS, stages in run order

The pages that list the plugin hooks were held to name each one, so a
row for a hook that does not exist passed, and so did any order:
architecture.md and modules/plugin.md listed `executor` first, ahead
of `config`. `plugin-hook-tables.test.ts` holds each hook table
(architecture, modules/plugin, design/pipeline) to `PLUGIN_HOOKS` as
an exact set, `setup`/`teardown` aside where the page covers them in
prose, and requires the stages `config` through `telemetry` in the
order a run calls them; both tables now place `executor` just before
`cache` (#2623).

## H-64: the drain row waits on its parent's exit, not a poll

The post-exit drain row failed on macOS CI at 317 ms against the
250 ms drain: its grandchild polled the parent with `kill -0`, forking
`sleep 0.01` a turn. It reads a FIFO only the parent holds open now,
so the exit is its EOF, and prints 50 ms later. A first cut that
printed at the EOF passed with a 0 ms drain, holding nothing; with
the 50 ms it fails at 0 ms and holds at 100 ms under 3x CPU load
(#2631).

## H-65: cli.md's JSON shapes are the schemas'

Each verb's `--format json` was held to its schema, but nothing held
the shapes cli.md prints: `vx why` showed one of its two objects, not
`{ taskId, why, diff, explanation }` for runs without a run id.
`cli-json-doc.test.ts` requires each `{ … }` a verb's JSON paragraphs
show to be an object its schema closes with those keys, every object
the verb prints whole to be shown, and `vx info`'s field list to be
its schema's top level (#2639).

## H-66: a stored layout moves only with its version

`SCHEMA_VERSION` gates the index and `CACHE_VERSION` the artifact, but
neither layout was tied to its version: a column or a container change
that forgot the bump passed every test, and the next vx read it as the
old layout. `contract-stored-format.test.ts` records the index DDL a
fresh open makes beside `SCHEMA_VERSION`, and a fixture artifact's tar
entries, sidecar and sha256 beside `CACHE_VERSION`
(`tests/contract/stored-format.json`). A layout that moves under its
recorded version fails, and the regeneration refuses it; an added
column, a sidecar field, the ustar magic and a renamed `.vx-sum` each
fail unbumped. The bump skill names the regeneration (#2645).

## H-67: each verb's help usage is its cli.md synopsis

The help usage line is what the parser accepts (`acceptedFlags`
reads it); cli.md's Top-level shape repeats it by hand and was held to
the dispatcher by verb name only, so a flag on one line and not the
other passed. `cli-help-synopsis.test.ts` requires each core verb's
usage lines to be its synopsis lines word for word, and its own help
cut to print them (#2654).

## H-68: every verb's refusal names the nearest word

`flagHint` read a verb's flags from its usage line, where no verb
spells `--help`, so `vx upgrade --hlp` and `vx help --hlp` said
"unknown" with no hint; `vx completions bsh` named no shell, and
`vx version --hlp` printed the version and exited 0. Every core verb
now hints `--help`, completions names the nearest shell and refuses a
flag as a flag, and `vx version` refuses a word (exit 1).
`cli-hint-every-verb.test.ts` holds a row per verb; 15 of 17 fail
without the fix (#2656).

## H-69: a bare vx with no workspace says so

A bare `vx` where no workspace is printed the 151-line reference and
exited 0, none of it saying nothing here can run. It prints the
refusal every verb gives there, plus where the verbs are listed, and
exits 1; inside a workspace, and `--help` / `-h` anywhere, it is the
reference as before (#2658).

## Leads for other streams

- **A:** a task that rewrites its own input with the same bytes is never
  saved (H-34, unocss `vscode#build`). Content alone cannot tell that
  from an edit reverted mid-run (item 1015); knowing the task was the only
  writer can: the sandbox recording the task's own writes, then saving
  when every moved input matches its digest and only this task wrote it.

- **D / B:** `sandbox.ignore` names that loaded and did nothing: done in D-4.
- **D:** `dependsOn: ['']`, `['!x']`: answered in H-44, refused with the
  task named.
- **F:** `@vzn/vx-reapi#test`'s proxy-cut rows under a loaded gate:
  F-9 (the peer counts each call's HEADERS on arrival; 24 of 24 loaded).
- **A:** a literal `{b}.ts` input: fixed in A
  (`one-alternative-brace.test.ts`).
- **A (low):** an output glob reaching `node_modules`: fixed in A
  (`outputExcludes`, `output-reach.test.ts`).

- **E:** `vx stats` silent as a deprecated alias: gone since H-19; typing
  it points at `vx info` and exits 1 (H-44).
