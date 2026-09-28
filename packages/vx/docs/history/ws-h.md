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

## H-15: release notes from Conventional Commits

`auto-release.yml` used GitHub's generated notes: every merged PR title,
docs and tests among them, and nothing marked a breaking change.
`scripts/release-notes.ts` now writes them from the commits since the
last tag: breaking changes (`type!:` or a `BREAKING CHANGE:` footer)
first, then Features, Fixes, Performance, and one count for the rest.
Rows: `release-notes.test.ts`; three mutants of the classifier each
turn a row red.

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

## Leads for other streams

- **D / B:** `sandbox.ignore` names that loaded and did nothing: done in D-4.
- **D:** `dependsOn` accepts `['']` and `['!x']` at load; whether the graph
  refuses each with the task named is unchecked.
- **F:** `@vzn/vx-reapi#test`'s "a call a proxy cuts in transit" rows
  (added by F-1) fail under a full local gate: RST_STREAM(INTERNAL_ERROR)
  "… is retried" twice (2164 and 2171 ms, "the collector hung up") and
  RST_STREAM(CANCEL) "… is not retried" once, in 3 of 5 gates on
  2026-09-27 (Bun 1.4.2, 4 workers), while the task passes run alone.
  Load-dependent; CI has been green.

- **A:** `cache.inputs.files: ['src/{b}.ts']` selects NOTHING when the
  file is literally named `{b}.ts` (`Bun.Glob` reads a one-alternative
  brace), and nothing refuses it: `assertNoInvisibleLiteralInputs`, which
  refuses a literal git does not list, treats `{` as a wildcard. A stale
  key for that file; refuse a brace with one alternative, or read it
  literally (recorded in `task-globs.json`).
- **A (low):** an output glob like `**/*.js` selects
  `node_modules/**/*.js` (`OUTPUT_NEVER` is only `.git` and `.vx`, by
  design: `node_modules/**` is an install task's output), so the clean
  before a run deletes installed files a broad glob did not mean to name.
  Consider refusing an output glob that reaches `node_modules` without
  naming it.

- **E:** `vx stats` is a deprecated alias of `vx info` (`cli/index.ts`,
  `cli.md`) and says nothing when used; `versioning-1.0.md` § Deprecation
  step 1 promises a deprecated surface "warns once per run, naming what
  replaces it", from the CLI's parser. A stderr line keeps `cli.md`'s
  "byte-identical output" true on stdout. Pre-1.0 it may also simply go.

## H-11: the 1.0 release checklist

`versioning-1.0.md` said when 1.0 takes effect but not how to cut it.
§ Releasing 1.0 lists the six steps in order, each with how it is checked:
milestone 3 and the soak, the contract records (the gate runs every
`contract-*.test.ts`), the notes (`git diff --stat <last-tag> --
packages/vx/tests/contract/` lists every surface that moved), the plugins
on npm, the README's status section, the tag. Pinned: every record the
contract table names must exist (`contract-versioning-doc.test.ts`; a
misspelt record path fails it).
