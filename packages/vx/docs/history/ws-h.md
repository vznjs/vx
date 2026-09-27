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
